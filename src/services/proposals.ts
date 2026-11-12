import type pg from 'pg';
import { z } from 'zod';
import { AppError, conflict, requireRole, type Actor } from '../auth/actor';
import { ModelProviderError, ModelTimeoutError, type ProposalModel } from '../ai/model';
import {
  buildProposalPrompt,
  MAX_PROMPT_EVIDENCE_CHARS,
  MAX_PROMPT_EVIDENCE_ITEMS,
  PROMPT_VERSION,
  type AdmittedEvidence,
} from '../ai/prompt';
import { verifyProposal } from '../ai/verify';
import { withTx, type Queryable } from '../db/pool';
import { canonicalJson, sha256Hex } from '../domain/canonical';
import { compareMoney, parseMoney } from '../domain/money';
import {
  codePointLength,
  REFUND_REASON_CODES,
  type AmountSemantic,
  type RevisionContent,
} from '../domain/proposal';
import { newId } from '../ids';
import { appendAudit } from './audit';
import { getSnapshotForActor, snapshotMoney, type PublicSnapshot } from './captures';
import { getCaseForActor } from './cases';
import { enforceRateLimit } from './rate-limit';
import { getRevisionForActor, insertRevisionTx, type StoredRevision } from './revisions';

export interface ProposalDeps {
  pool: pg.Pool;
  model: ProposalModel | null;
  policyVersion: string;
  modelDeadlineMs: number;
}

const REFUNDABLE = new Set(['COMPLETED', 'PARTIALLY_REFUNDED']);
const GENERATE_LIMIT = 30;
const GENERATE_WINDOW_MS = 15 * 60_000;

const GenerateInput = z.strictObject({ captureSnapshotId: z.string().min(1).max(80) });

/** Evidence of the case, in admission order, labelled E1..En: the exact set admitted into the model input. */
async function admittedEvidence(db: Queryable, actor: Actor, caseId: string): Promise<AdmittedEvidence[]> {
  const r = await db.query(
    `select id, kind, digest, redacted_digest, redacted_text from evidence_artifacts
      where case_id = $1 and tenant_id = $2 order by admitted_at, id`,
    [caseId, actor.tenantId],
  );
  return r.rows.map((e, i) => ({
    label: `E${i + 1}`,
    evidenceId: e.id,
    kind: e.kind,
    digest: e.digest,
    redactedDigest: e.redacted_digest,
    redactedText: e.redacted_text,
  }));
}

/** Supersedes the case's live draft; refuses while an approved revision is live. Caller holds the case lock. */
async function retireLiveRevision(c: Queryable, caseId: string) {
  const live = await c.query(
    `select id, state from proposal_revisions where case_id = $1 and state in ('DRAFT', 'REVIEWABLE', 'APPROVED')`,
    [caseId],
  );
  const row = live.rows[0];
  if (!row) return null;
  if (row.state === 'APPROVED') {
    throw conflict('REVISION_APPROVED', 'An approved revision is live for this case; it cannot be replaced');
  }
  await c.query(`update proposal_revisions set state = 'SUPERSEDED' where id = $1`, [row.id]);
  return row.id as string;
}

async function assertNoApprovedRevision(db: Queryable, caseId: string) {
  const r = await db.query(`select 1 from proposal_revisions where case_id = $1 and state = 'APPROVED'`, [
    caseId,
  ]);
  if (r.rowCount) throw conflict('REVISION_APPROVED', 'An approved revision is live for this case');
}

export interface GenerationResult {
  invocation: PublicInvocation;
  revision: StoredRevision | null;
}

/**
 * Drafts a proposal with the configured model. The model sees only the declared capture fields and the redacted
 * evidence of this case, delimited as data. Its answer is re-validated; a valid answer becomes an AI DRAFT
 * revision (with correction reasons whenever anything is uncited, uncertain, mismatched or instruction-like),
 * an invalid answer is recorded and produces no revision. Nothing here approves, schedules or executes.
 */
export async function generateProposal(
  deps: ProposalDeps,
  actor: Actor,
  caseId: string,
  input: unknown,
): Promise<GenerationResult> {
  requireRole(actor, 'OPERATOR', 'ADMIN');
  const { captureSnapshotId } = GenerateInput.parse(input);
  await getCaseForActor(deps.pool, actor, caseId);
  if (!deps.model) {
    throw new AppError(
      503,
      'MODEL_BLOCKED',
      'No approved model credential is configured (BLOCKED_CREDENTIAL)',
    );
  }
  const model = deps.model;
  await enforceRateLimit(
    deps.pool,
    `proposal:${actor.tenantId}`,
    GENERATE_LIMIT,
    GENERATE_WINDOW_MS,
    'proposal requests',
  );
  const snapshot = await getSnapshotForActor(deps.pool, actor, caseId, captureSnapshotId);
  const evidence = await admittedEvidence(deps.pool, actor, caseId);
  if (evidence.length === 0) throw conflict('NO_EVIDENCE', 'Admit evidence before drafting a proposal');
  const chars = evidence.reduce((n, e) => n + codePointLength(e.redactedText), 0);
  if (evidence.length > MAX_PROMPT_EVIDENCE_ITEMS || chars > MAX_PROMPT_EVIDENCE_CHARS) {
    throw new AppError(413, 'PROPOSAL_INPUT_TOO_LARGE', 'Admitted evidence exceeds the model input bound', {
      items: evidence.length,
      maxItems: MAX_PROMPT_EVIDENCE_ITEMS,
      chars,
      maxChars: MAX_PROMPT_EVIDENCE_CHARS,
    });
  }
  const prompt = buildProposalPrompt(
    {
      captureId: snapshot.captureId,
      status: snapshot.status,
      amount: snapshot.amount,
      source: snapshot.source,
    },
    evidence,
  );
  const admitted = evidence.map((e) => ({
    label: e.label,
    evidenceId: e.evidenceId,
    digest: e.digest,
    redactedDigest: e.redactedDigest,
  }));

  // Phase 1: durable intent. One running invocation per case; a stale one (process died) is marked ABANDONED.
  const invocationId = newId('inv');
  await withTx(deps.pool, async (c) => {
    await getCaseForActor(c, actor, caseId, true);
    await assertNoApprovedRevision(c, caseId);
    await c.query(
      `update model_invocations set status = 'ABANDONED', finished_at = now(), error_class = 'STALE_STARTED'
        where case_id = $1 and status = 'STARTED' and started_at < now() - make_interval(secs => $2::double precision / 1000)`,
      [caseId, deps.modelDeadlineMs * 2],
    );
    const running = await c.query(
      `select 1 from model_invocations where case_id = $1 and status = 'STARTED'`,
      [caseId],
    );
    if (running.rowCount)
      throw conflict('PROPOSAL_IN_PROGRESS', 'A proposal is already being drafted for this case');
    await c.query(
      `insert into model_invocations (id, tenant_id, case_id, capture_snapshot_id, requested_by, provider,
         model_requested, prompt_version, prompt_digest, admitted_evidence, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'STARTED')`,
      [
        invocationId,
        actor.tenantId,
        caseId,
        snapshot.id,
        actor.id,
        model.provider,
        model.model,
        PROMPT_VERSION,
        prompt.digest,
        JSON.stringify(admitted),
      ],
    );
  });

  // Phase 2: the model call, outside any transaction, under a hard deadline.
  let status: 'SUCCEEDED' | 'OUTPUT_REJECTED' | 'PROVIDER_ERROR' | 'TIMEOUT';
  let result: Awaited<ReturnType<ProposalModel['propose']>> | null = null;
  let errorClass: string | null = null;
  try {
    result = await model.propose(prompt, deps.modelDeadlineMs);
    status = 'SUCCEEDED';
  } catch (e) {
    status = e instanceof ModelTimeoutError ? 'TIMEOUT' : 'PROVIDER_ERROR';
    errorClass = e instanceof ModelProviderError ? e.errorClass : e instanceof Error ? e.name : 'Error';
  }
  const verification = result
    ? verifyProposal(
        result.text,
        { captureId: snapshot.captureId, status: snapshot.status, amount: snapshotMoney(snapshot) },
        evidence,
      )
    : null;
  if (verification && !verification.ok) status = 'OUTPUT_REJECTED';

  // Phase 3: finalize exactly once; on a valid answer, record citations and the AI draft in the same transaction.
  return withTx(deps.pool, async (c) => {
    await getCaseForActor(c, actor, caseId, true);
    const output = verification?.ok ? verification.output : (verification?.output ?? null);
    const fin = await c.query(
      `update model_invocations
          set status = $2, finished_at = now(), model_served = $3, provider_request_id = $4, stop_reason = $5,
              usage = $6, error_class = $7, output = $8, output_digest = $9, validation_errors = $10,
              correction_reasons = $11
        where id = $1 and status = 'STARTED' returning *`,
      [
        invocationId,
        status,
        result?.modelServed ?? null,
        result?.providerRequestId ?? null,
        result?.stopReason ?? null,
        result?.usage ? JSON.stringify(result.usage) : null,
        errorClass,
        output === null ? null : JSON.stringify(output),
        output === null ? null : sha256Hex(canonicalJson(output)),
        JSON.stringify(verification && !verification.ok ? verification.errors : []),
        JSON.stringify(verification?.ok ? verification.correctionReasons : []),
      ],
    );
    if (!fin.rows[0]) throw conflict('INVOCATION_FINALIZED', 'This invocation was already finalized');
    let revision: StoredRevision | null = null;
    if (verification?.ok) {
      for (const ct of verification.citations) {
        await c.query(
          `insert into proposal_citations (id, tenant_id, case_id, invocation_id, claim, evidence_label, evidence_id,
             quote, start_offset, end_offset, verified, failure)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            newId('cit'),
            actor.tenantId,
            caseId,
            invocationId,
            ct.claim,
            ct.label,
            ct.evidenceId,
            ct.quote.slice(0, 500),
            ct.start,
            ct.end,
            ct.verified,
            ct.failure,
          ],
        );
      }
      await retireLiveRevision(c, caseId);
      const content: RevisionContent = {
        tenantId: actor.tenantId,
        caseId,
        captureId: snapshot.captureId,
        amount: verification.amount,
        reason: { code: verification.reasonCode, noteToPayer: verification.noteToPayer },
        evidenceDigests: evidence.map((e) => e.digest),
        policyVersion: deps.policyVersion,
      };
      revision = await insertRevisionTx(c, actor, {
        caseId,
        content,
        origin: 'AI',
        correctionReasons: verification.correctionReasons,
        explanation: verification.output.rationale,
        captureSnapshotId: snapshot.id,
        modelInvocationId: invocationId,
      });
    }
    await appendAudit(c, {
      tenantId: actor.tenantId,
      actorId: actor.id,
      eventType: 'PROPOSAL_DRAFTED',
      subjectType: 'model_invocation',
      subjectId: invocationId,
      outcome: status === 'SUCCEEDED' ? 'OK' : 'ERROR',
      details: {
        caseId,
        status,
        provider: model.provider,
        model: model.model,
        promptVersion: PROMPT_VERSION,
        promptDigest: prompt.digest,
        revisionId: revision?.id ?? null,
      },
    });
    return { invocation: toInvocation(fin.rows[0]), revision };
  });
}

const AuthorInput = z.strictObject({
  captureSnapshotId: z.string().min(1).max(80).optional(),
  parentRevisionId: z.string().min(1).max(80).optional(),
  amount: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('EXACT'), value: z.string().min(1).max(32) }),
    z.strictObject({ kind: z.literal('FULL') }),
  ]),
  reasonCode: z.enum(REFUND_REASON_CODES),
  noteToPayer: z.string().trim().min(1).max(255).nullable(),
  explanation: z.string().trim().min(1).max(2000).optional(),
});

/**
 * A human-authored revision: either a correction of a live draft (parentRevisionId, explanation required) or a
 * proposal written from scratch against a capture snapshot (the path that works while the model is BLOCKED).
 * The capture, currency and evidence binding come from the server, never from the request.
 */
export async function authorRevision(
  deps: Pick<ProposalDeps, 'pool' | 'policyVersion'>,
  actor: Actor,
  caseId: string,
  input: unknown,
): Promise<StoredRevision> {
  requireRole(actor, 'OPERATOR', 'ADMIN');
  const v = AuthorInput.parse(input);
  return withTx(deps.pool, async (c) => {
    await getCaseForActor(c, actor, caseId, true);
    let snapshotId = v.captureSnapshotId ?? null;
    let parent: StoredRevision | null = null;
    if (v.parentRevisionId) {
      parent = await getRevisionForActor(c, actor, v.parentRevisionId, true);
      if (!parent || parent.caseId !== caseId) throw new AppError(404, 'NOT_FOUND', 'Revision not found');
      if (parent.state !== 'DRAFT' && parent.state !== 'REVIEWABLE') {
        throw conflict('REVISION_NOT_LIVE', `A ${parent.state} revision cannot be corrected`);
      }
      if (!v.explanation) throw new AppError(422, 'EXPLANATION_REQUIRED', 'Explain the correction');
      snapshotId = snapshotId ?? parent.captureSnapshotId;
    }
    if (!snapshotId) throw new AppError(422, 'CAPTURE_REQUIRED', 'Select a capture snapshot');
    const snapshot: PublicSnapshot = await getSnapshotForActor(c, actor, caseId, snapshotId);
    if (!REFUNDABLE.has(snapshot.status)) {
      throw conflict('CAPTURE_NOT_REFUNDABLE', `Capture status ${snapshot.status} cannot be refunded`);
    }
    const captureAmount = snapshotMoney(snapshot);
    let amount: AmountSemantic;
    if (v.amount.kind === 'EXACT') {
      let m;
      try {
        m = parseMoney(v.amount.value, captureAmount.currency);
      } catch (e) {
        throw new AppError(422, 'INVALID_AMOUNT', e instanceof Error ? e.message : 'Invalid amount');
      }
      if (m.minor === 0n) throw new AppError(422, 'INVALID_AMOUNT', 'Amount must be positive');
      if (compareMoney(m, captureAmount) > 0) {
        throw new AppError(422, 'AMOUNT_EXCEEDS_CAPTURE', 'Amount exceeds the captured amount');
      }
      amount = { kind: 'EXACT', amount: m };
    } else {
      amount = { kind: 'FULL', captureAmount };
    }
    const evidence = await admittedEvidence(c, actor, caseId);
    if (evidence.length === 0) throw conflict('NO_EVIDENCE', 'Admit evidence before writing a proposal');
    await retireLiveRevision(c, caseId);
    return insertRevisionTx(c, actor, {
      caseId,
      content: {
        tenantId: actor.tenantId,
        caseId,
        captureId: snapshot.captureId,
        amount,
        reason: { code: v.reasonCode, noteToPayer: v.noteToPayer },
        evidenceDigests: evidence.map((e) => e.digest),
        policyVersion: deps.policyVersion,
      },
      origin: 'HUMAN',
      correctionReasons: [],
      explanation: v.explanation ?? null,
      parentRevisionId: parent?.id ?? null,
      captureSnapshotId: snapshot.id,
    });
  });
}

export interface PublicInvocation {
  id: string;
  caseId: string;
  captureSnapshotId: string;
  provider: string;
  modelRequested: string;
  modelServed: string | null;
  promptVersion: string;
  promptDigest: string;
  admittedEvidence: unknown;
  status: string;
  output: unknown;
  outputDigest: string | null;
  validationErrors: string[];
  correctionReasons: string[];
  stopReason: string | null;
  errorClass: string | null;
  startedAt: string;
  finishedAt: string | null;
}

const toInvocation = (r: Record<string, unknown>): PublicInvocation => ({
  id: r.id as string,
  caseId: r.case_id as string,
  captureSnapshotId: r.capture_snapshot_id as string,
  provider: r.provider as string,
  modelRequested: r.model_requested as string,
  modelServed: (r.model_served as string | null) ?? null,
  promptVersion: r.prompt_version as string,
  promptDigest: r.prompt_digest as string,
  admittedEvidence: r.admitted_evidence,
  status: r.status as string,
  output: r.output ?? null,
  outputDigest: (r.output_digest as string | null) ?? null,
  validationErrors: (r.validation_errors as string[]) ?? [],
  correctionReasons: (r.correction_reasons as string[]) ?? [],
  stopReason: (r.stop_reason as string | null) ?? null,
  errorClass: (r.error_class as string | null) ?? null,
  startedAt: new Date(r.started_at as string).toISOString(),
  finishedAt: r.finished_at ? new Date(r.finished_at as string).toISOString() : null,
});

export async function listInvocations(db: Queryable, actor: Actor, caseId: string) {
  const r = await db.query(
    'select * from model_invocations where case_id = $1 and tenant_id = $2 order by started_at desc, id',
    [caseId, actor.tenantId],
  );
  return r.rows.map(toInvocation);
}

export async function listCitations(db: Queryable, actor: Actor, caseId: string) {
  const r = await db.query(
    `select id, invocation_id, claim, evidence_label, evidence_id, quote, start_offset, end_offset, verified, failure
       from proposal_citations where case_id = $1 and tenant_id = $2 order by created_at, id`,
    [caseId, actor.tenantId],
  );
  return r.rows.map((x) => ({
    id: x.id,
    invocationId: x.invocation_id,
    claim: x.claim,
    evidenceLabel: x.evidence_label,
    evidenceId: x.evidence_id,
    quote: x.quote,
    start: x.start_offset,
    end: x.end_offset,
    verified: x.verified,
    failure: x.failure,
  }));
}
