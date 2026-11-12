'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../../../ui/api';
import {
  amountText,
  ConfirmButton,
  Digest,
  ErrorSummary,
  Icon,
  REASONS,
  Skeleton,
  Status,
  useAnnouncer,
  when,
} from '../../../ui/components';
import { useActor, useLoad } from '../../../ui/session';

interface Evidence {
  id: string;
  kind: string;
  digest: string;
  redactedText: string;
  redactionReport: { rules: Record<string, number> };
  originalBytes: number;
  admittedAt: string;
}
interface Snapshot {
  id: string;
  captureId: string;
  status: string;
  amount: { currency: string; value: string };
  orderId: string | null;
  payeeMerchantId: string | null;
  source: string;
  fetchedAt: string;
}
interface Revision {
  id: string;
  revisionNo: number;
  state: string;
  digest: string;
  origin: 'AI' | 'HUMAN';
  parentRevisionId: string | null;
  captureSnapshotId: string | null;
  modelInvocationId: string | null;
  correctionReasons: string[];
  explanation: string | null;
  createdAt: string;
  wire: {
    captureId: string;
    amount: {
      kind: string;
      amount?: { currency: string; value: string };
      captureAmount?: { currency: string; value: string };
    };
    reason: { code: string; noteToPayer: string | null };
    evidenceDigests: string[];
  };
}
interface Invocation {
  id: string;
  provider: string;
  modelRequested: string;
  modelServed: string | null;
  status: string;
  validationErrors: string[];
  correctionReasons: string[];
  promptDigest: string;
  startedAt: string;
}
interface Citation {
  id: string;
  invocationId: string;
  claim: string;
  evidenceId: string | null;
  evidenceLabel: string;
  quote: string;
  start: number | null;
  end: number | null;
  verified: boolean;
  failure: string | null;
}
interface Operation {
  id: string;
  revisionId: string;
  state: string;
  paypalRequestId: string;
  nextReconcileAt: string | null;
}
interface Detail {
  case: { id: string; title: string; customerRef: string | null; status: string; createdAt: string };
  evidence: Evidence[];
  revisions: Revision[];
  snapshots: Snapshot[];
  invocations: Invocation[];
  citations: Citation[];
  operations: Operation[];
  capabilities: {
    model: { provider: string; model: string } | null;
    captureSource: string | null;
    paypal: string | null;
  };
}

const LIVE = ['DRAFT', 'REVIEWABLE', 'APPROVED'];
const STALE_MS = 60 * 60_000;

const CORRECTION_TEXT: Record<string, string> = {
  AMOUNT_EXCEEDS_CAPTURE: 'The proposed amount is larger than the capture.',
  FULL_REFUND_REQUESTED: 'A full refund was proposed; confirm that this is intended.',
  CAPTURE_MISMATCH: 'The model named a different capture.',
  CAPTURE_NOT_REFUNDABLE: 'The capture cannot be refunded in its current state.',
  INVALID_CITATION: 'At least one citation does not match the evidence.',
  UNCITED_AMOUNT: 'The amount is not supported by a citation.',
  UNCITED_REASON: 'The reason is not supported by a citation.',
  UNCITED_CAPTURE_MATCH: 'Nothing in the evidence ties it to this capture.',
  UNCITED_NOTE_TO_PAYER: 'The note to the customer is not supported by a citation.',
  INSTRUCTION_IN_EVIDENCE:
    'The evidence contains instruction-like text. It was treated as data, not followed.',
};
const correctionText = (r: string) =>
  CORRECTION_TEXT[r] ??
  (r.startsWith('MODEL_UNCERTAIN_')
    ? `The model was unsure about ${r.slice(16).toLowerCase().replace(/_/g, ' ')}.`
    : r);

function highlight(text: string, spans: Array<{ start: number; end: number; claim: string }>): ReactNode {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const out: ReactNode[] = [];
  let at = 0;
  for (const s of sorted) {
    if (s.start < at) continue;
    out.push(text.slice(at, s.start));
    out.push(
      <mark
        key={`${s.start}-${s.claim}`}
        className="cite"
        title={`Supports ${s.claim.toLowerCase().replace(/_/g, ' ')}`}
      >
        {text.slice(s.start, s.end)}
      </mark>,
    );
    at = s.end;
  }
  out.push(text.slice(at));
  return out;
}

export default function CaseWorkspace() {
  const { caseId } = useParams<{ caseId: string }>();
  const actor = useActor()!;
  const { data, error, reload } = useLoad(() => api<Detail>('GET', `/api/cases/${caseId}`), [caseId]);
  const { announce, node } = useAnnouncer();
  const [actionError, setActionError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const isOperator = actor.role === 'OPERATOR' || actor.role === 'ADMIN';

  const run = async (label: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(label);
    setActionError(null);
    try {
      await fn();
      announce(done);
      reload();
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(null);
    }
  };

  const live = data?.revisions.find((r) => LIVE.includes(r.state)) ?? null;
  useEffect(() => {
    if (live) announce(`Current revision ${live.revisionNo} is ${live.state.toLowerCase()}.`);
  }, [live?.id, live?.state]);

  if (error) return <ErrorSummary error={error} />;
  if (!data) return <Skeleton block />;

  const snapshot = live?.captureSnapshotId
    ? data.snapshots.find((s) => s.id === live.captureSnapshotId)
    : data.snapshots[0];
  const liveCitations = live?.modelInvocationId
    ? data.citations.filter((c) => c.invocationId === live.modelInvocationId)
    : [];
  const op = live ? data.operations.find((o) => o.revisionId === live.id) : data.operations.at(-1);
  const workflow = [
    {
      label: 'Evidence',
      detail: data.evidence.length
        ? `${data.evidence.length} source${data.evidence.length === 1 ? '' : 's'} admitted`
        : 'No evidence admitted',
      state: data.evidence.length ? 'complete' : 'current',
    },
    {
      label: 'Capture',
      detail: snapshot
        ? `${snapshot.amount.value} ${snapshot.amount.currency} · ${snapshot.status.toLowerCase()}`
        : 'No PayPal capture',
      state: snapshot ? 'complete' : data.evidence.length ? 'current' : 'upcoming',
    },
    {
      label: 'Approval',
      detail: live
        ? live.state === 'APPROVED'
          ? `Revision ${live.revisionNo} approved`
          : `Revision ${live.revisionNo} · ${live.state.toLowerCase()}`
        : 'No proposal recorded',
      state:
        live?.state === 'APPROVED' || op
          ? 'complete'
          : live?.state === 'DRAFT' || live?.state === 'REVIEWABLE'
            ? 'current'
            : 'upcoming',
    },
    {
      label: 'Provider outcome',
      detail: op ? op.state.toLowerCase().replace(/_/g, ' ') : 'Not sent to PayPal',
      state:
        op?.state === 'CONFIRMED'
          ? 'complete'
          : op
            ? 'current'
            : live?.state === 'APPROVED'
              ? 'current'
              : 'upcoming',
    },
  ] as const;

  return (
    <>
      {node}
      <div className="page-head">
        <div>
          <p className="small">
            <Link href="/cases">Cases</Link> / <code>{data.case.id}</code>
          </p>
          <h1>{data.case.title}</h1>
          <p>
            Opened {when(data.case.createdAt)}
            {data.case.customerRef ? `, customer reference ${data.case.customerRef}` : ''}.
          </p>
        </div>
        <div className="case-state" aria-label="Current case state">
          <span>Current state</span>
          {live ? <Status state={live.state} /> : <Status state="DRAFT" label="No proposal yet" />}
          {op && <Status state={op.state} />}
        </div>
      </div>
      <section className="refund-workflow" aria-labelledby="workflow-title">
        <div className="workflow-copy">
          <h2 id="workflow-title">Refund workflow</h2>
          <p>
            {op?.state === 'CONFIRMED'
              ? 'PayPal confirmed the refund.'
              : live?.state === 'APPROVED' && !op
                ? 'The approved revision is ready to send.'
                : 'Complete the current step to move this refund forward.'}
          </p>
        </div>
        <ol>
          {workflow.map((stage, index) => (
            <li
              key={stage.label}
              className={stage.state}
              aria-current={stage.state === 'current' ? 'step' : undefined}
            >
              <span className="workflow-marker" aria-hidden="true">
                {stage.state === 'complete' ? <Icon name="check" /> : index + 1}
              </span>
              <span>
                <strong>{stage.label}</strong>
                <small>{stage.detail}</small>
              </span>
            </li>
          ))}
        </ol>
      </section>
      <ErrorSummary error={actionError} />
      <div className="workspace">
        {/* ---------------- evidence */}
        <section className="pane" aria-labelledby="ev-title">
          <div className="panel">
            <h2 id="ev-title" className="pane-title">
              Evidence
            </h2>
            {data.evidence.length === 0 && (
              <p className="muted">No evidence yet. Paste the customer’s message or an order note below.</p>
            )}
            <ul className="list">
              {data.evidence.map((e, i) => {
                const spans = liveCitations
                  .filter((c) => c.verified && c.evidenceId === e.id && c.start !== null && c.end !== null)
                  .map((c) => ({ start: c.start!, end: c.end!, claim: c.claim }));
                const redactions = Object.entries(e.redactionReport?.rules ?? {});
                return (
                  <li key={e.id}>
                    <div className="row small muted">
                      <strong className="mono">E{i + 1}</strong>
                      <span>{e.kind.toLowerCase().replace(/_/g, ' ')}</span>
                      <span>{when(e.admittedAt)}</span>
                    </div>
                    <div className="evidence-text">{highlight(e.redactedText, spans)}</div>
                    <p className="small muted" style={{ marginTop: '0.3rem' }}>
                      {redactions.length
                        ? `Redacted: ${redactions.map(([k, n]) => `${n} ${k.toLowerCase()}`).join(', ')}. `
                        : 'Nothing needed redaction. '}
                      Original encrypted; digest <Digest value={e.digest} label="Evidence digest" />
                    </p>
                  </li>
                );
              })}
            </ul>
          </div>
          {isOperator && (
            <form
              className="panel stack"
              onSubmit={async (ev) => {
                ev.preventDefault();
                const form = ev.currentTarget;
                const f = new FormData(form);
                await run(
                  'evidence',
                  () =>
                    api('POST', `/api/cases/${caseId}/evidence`, {
                      kind: f.get('kind'),
                      text: f.get('text'),
                    }),
                  'Evidence admitted and redacted.',
                );
                form.reset();
              }}
            >
              <h3>Add evidence</h3>
              <label>
                Kind
                <select name="kind" defaultValue="SUPPORT_MESSAGE">
                  <option value="SUPPORT_MESSAGE">Support message</option>
                  <option value="ORDER_NOTE">Order note</option>
                  <option value="OPERATOR_NOTE">Operator note</option>
                </select>
              </label>
              <label>
                Text
                <span className="hint">
                  Stored encrypted. Only the redacted copy is shown or given to the model.
                </span>
                <textarea name="text" required maxLength={65536} />
              </label>
              <button type="submit" disabled={busy === 'evidence'}>
                Admit evidence
              </button>
            </form>
          )}
        </section>

        {/* ---------------- proposal */}
        <section className="pane" aria-labelledby="prop-title">
          <div className="panel">
            <h2 id="prop-title" className="pane-title">
              Capture
            </h2>
            {snapshot ? (
              <div className="stack">
                <div className="row">
                  <code>{snapshot.captureId}</code>
                  <span>
                    {snapshot.amount.value} {snapshot.amount.currency}
                  </span>
                  <span className="muted">{snapshot.status.toLowerCase().replace(/_/g, ' ')}</span>
                </div>
                <p className="small muted">
                  Read from{' '}
                  {snapshot.source === 'CONTRACT_STUB'
                    ? 'the labelled contract stub (not PayPal)'
                    : 'PayPal sandbox'}{' '}
                  at {when(snapshot.fetchedAt)}.
                  {Date.now() - new Date(snapshot.fetchedAt).getTime() > STALE_MS && (
                    <strong> This snapshot is more than an hour old; fetch it again before approving.</strong>
                  )}
                </p>
              </div>
            ) : (
              <p className="muted">No capture selected yet.</p>
            )}
            {isOperator &&
              (data.capabilities.captureSource ? (
                <form
                  className="row"
                  style={{ marginTop: '0.75rem' }}
                  onSubmit={async (ev) => {
                    ev.preventDefault();
                    const f = new FormData(ev.currentTarget);
                    await run(
                      'capture',
                      () => api('POST', `/api/cases/${caseId}/captures`, { captureId: f.get('captureId') }),
                      'Capture snapshot stored.',
                    );
                  }}
                >
                  <label style={{ flex: '1 1 12rem' }}>
                    <span className="sr-only">PayPal capture id</span>
                    <input
                      name="captureId"
                      placeholder="Capture id"
                      required
                      pattern="[A-Za-z0-9-]{1,64}"
                      defaultValue={snapshot?.captureId}
                    />
                  </label>
                  <button type="submit" className="secondary" disabled={busy === 'capture'}>
                    {snapshot ? 'Fetch again' : 'Fetch capture'}
                  </button>
                </form>
              ) : (
                <p className="small">
                  <Status state="BLOCKED" label="Capture lookup blocked" /> No capture source is configured in
                  this environment.
                </p>
              ))}
          </div>

          <div className="panel">
            <h2 className="pane-title">Proposal</h2>
            {live ? (
              <div className="stack">
                <div className="row">
                  <Status state={live.state} />
                  <span className="muted small">
                    Revision {live.revisionNo},{' '}
                    {live.origin === 'AI' ? 'drafted by the model' : 'written by a person'},{' '}
                    {when(live.createdAt)}
                  </span>
                </div>
                <div className="facts-amount">{amountText(live.wire.amount)}</div>
                <p>
                  {REASONS[live.wire.reason.code] ?? live.wire.reason.code}
                  {live.wire.reason.noteToPayer
                    ? ` · Note to customer: “${live.wire.reason.noteToPayer}”`
                    : ''}
                </p>
                {live.explanation && <p className="small muted">{live.explanation}</p>}
                {live.correctionReasons.length > 0 && (
                  <div className="banner" role="note">
                    <Icon name="alert" />
                    <div>
                      <strong>Needs a human correction before it can be submitted.</strong>
                      <ul>
                        {live.correctionReasons.map((r) => (
                          <li key={r}>{correctionText(r)}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                )}
                {liveCitations.length > 0 && (
                  <details>
                    <summary>
                      Citations ({liveCitations.filter((c) => c.verified).length} verified of{' '}
                      {liveCitations.length})
                    </summary>
                    <ul>
                      {liveCitations.map((c) => (
                        <li key={c.id} className="small">
                          <Status
                            state={c.verified ? 'APPROVED' : 'REJECTED'}
                            label={c.verified ? 'Verified' : 'Not found'}
                          />{' '}
                          {c.claim.toLowerCase().replace(/_/g, ' ')} from {c.evidenceLabel}: “{c.quote}”
                          {c.failure ? ` (${c.failure})` : ''}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                <p className="small muted">
                  Digest <Digest value={live.digest} label="Revision digest" />
                </p>
              </div>
            ) : (
              <p className="muted">No live proposal. Draft one with the model or write it yourself.</p>
            )}

            {isOperator && snapshot && (!live || live.state === 'DRAFT' || live.state === 'REVIEWABLE') && (
              <div className="row" style={{ marginTop: '0.75rem' }}>
                {data.capabilities.model ? (
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy === 'draft' || data.evidence.length === 0}
                    onClick={() =>
                      run(
                        'draft',
                        () =>
                          api('POST', `/api/cases/${caseId}/proposals`, { captureSnapshotId: snapshot.id }),
                        'A new draft was recorded.',
                      )
                    }
                  >
                    {busy === 'draft'
                      ? 'Drafting…'
                      : `Draft with ${
                          data.capabilities.model.provider === 'local-fixture'
                            ? 'the local fixture model'
                            : data.capabilities.model.provider === 'ollama'
                              ? `local ${data.capabilities.model.model}`
                              : 'Claude'
                        }`}
                  </button>
                ) : (
                  <span className="small">
                    <Status state="BLOCKED" label="Model blocked" /> No approved model credential; write the
                    proposal yourself.
                  </span>
                )}
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setEditing((v) => !v)}
                  aria-expanded={editing}
                >
                  {live ? 'Correct this proposal' : 'Write a proposal'}
                </button>
              </div>
            )}
            {editing && snapshot && (
              <form
                className="stack"
                style={{ marginTop: '1rem' }}
                onSubmit={async (ev) => {
                  ev.preventDefault();
                  const f = new FormData(ev.currentTarget);
                  const kind = String(f.get('kind'));
                  const note = String(f.get('note') ?? '').trim();
                  const explanation = String(f.get('explanation') ?? '').trim();
                  await run(
                    'author',
                    () =>
                      api('POST', `/api/cases/${caseId}/revisions`, {
                        ...(live ? { parentRevisionId: live.id } : { captureSnapshotId: snapshot.id }),
                        amount:
                          kind === 'FULL'
                            ? { kind: 'FULL' }
                            : { kind: 'EXACT', value: String(f.get('value')) },
                        reasonCode: f.get('reason'),
                        noteToPayer: note || null,
                        ...(explanation ? { explanation } : {}),
                      }),
                    'A new revision was recorded.',
                  );
                  setEditing(false);
                }}
              >
                <fieldset>
                  <legend>Amount</legend>
                  <label className="choice">
                    <input
                      type="radio"
                      name="kind"
                      value="EXACT"
                      defaultChecked={live?.wire.amount.kind !== 'FULL'}
                    />{' '}
                    Exact amount in {snapshot.amount.currency}
                  </label>
                  <label>
                    <span className="sr-only">Amount in {snapshot.amount.currency}</span>
                    <input
                      name="value"
                      inputMode="decimal"
                      defaultValue={live?.wire.amount.amount?.value}
                      placeholder={`Up to ${snapshot.amount.value}`}
                    />
                  </label>
                  <label className="choice">
                    <input
                      type="radio"
                      name="kind"
                      value="FULL"
                      defaultChecked={live?.wire.amount.kind === 'FULL'}
                    />{' '}
                    Full remaining capture ({snapshot.amount.value} {snapshot.amount.currency})
                  </label>
                </fieldset>
                <label>
                  Reason
                  <select name="reason" defaultValue={live?.wire.reason.code ?? 'DUPLICATE_CHARGE'}>
                    {Object.entries(REASONS).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Note to customer
                  <span className="hint">Optional, up to 255 characters. PayPal shows it to the payer.</span>
                  <input name="note" maxLength={255} defaultValue={live?.wire.reason.noteToPayer ?? ''} />
                </label>
                {live && (
                  <label>
                    What you changed and why
                    <span className="hint">Required for a correction; kept in the revision history.</span>
                    <textarea name="explanation" required maxLength={2000} />
                  </label>
                )}
                <div className="row">
                  <button type="submit" disabled={busy === 'author'}>
                    {live ? 'Save correction' : 'Save proposal'}
                  </button>
                  <button type="button" className="secondary" onClick={() => setEditing(false)}>
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </div>

          {data.revisions.length > 0 && (
            <details className="panel">
              <summary>Revision history ({data.revisions.length})</summary>
              <ol className="timeline" style={{ marginTop: '0.75rem' }}>
                {[...data.revisions].reverse().map((r) => (
                  <li key={r.id}>
                    <div className="row">
                      <strong>Revision {r.revisionNo}</strong>
                      <Status state={r.state} />
                      <span className="small muted">{r.origin === 'AI' ? 'model draft' : 'human'}</span>
                    </div>
                    <div className="small">
                      {amountText(r.wire.amount)}, {REASONS[r.wire.reason.code] ?? r.wire.reason.code},{' '}
                      {when(r.createdAt)}
                    </div>
                    {r.explanation && r.origin === 'HUMAN' && (
                      <div className="small muted">{r.explanation}</div>
                    )}
                  </li>
                ))}
              </ol>
              {data.invocations.length > 0 && (
                <>
                  <h3 style={{ marginTop: '1rem' }}>Model calls</h3>
                  <ul className="list small">
                    {data.invocations.map((i) => (
                      <li key={i.id}>
                        <code>{i.modelServed ?? i.modelRequested}</code> ({i.provider}){' '}
                        {i.status.toLowerCase().replace(/_/g, ' ')}, {when(i.startedAt)}
                        {i.validationErrors.length > 0 && (
                          <div className="muted">Rejected output: {i.validationErrors.join('; ')}</div>
                        )}
                        <div className="muted">
                          Prompt <Digest value={i.promptDigest} label="Prompt digest" />
                        </div>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </details>
          )}
        </section>

        {/* ---------------- state and actions */}
        <section className="pane pane-state" aria-labelledby="state-title">
          <div className="panel stack">
            <h2 id="state-title" className="pane-title">
              State and next step
            </h2>
            {!live && !op && (
              <p className="muted">Admit evidence, fetch the capture, then draft or write a proposal.</p>
            )}
            {live?.state === 'DRAFT' && (
              <>
                <p>
                  {live.correctionReasons.length
                    ? 'Correct the proposal first. A draft with open correction reasons cannot be submitted.'
                    : 'Ready to ask an approver. They will see exactly these facts and this digest.'}
                </p>
                {isOperator && (
                  <ConfirmButton
                    disabled={live.correctionReasons.length > 0}
                    title="Request approval"
                    confirmLabel="Request approval"
                    body={
                      <>
                        <p>
                          Revision {live.revisionNo}: <strong>{amountText(live.wire.amount)}</strong> on
                          capture <code>{live.wire.captureId}</code>.
                        </p>
                        <p className="small">
                          Digest <Digest value={live.digest} />
                        </p>
                        <p className="small muted">
                          Any later change creates a new revision, and this request no longer applies.
                        </p>
                      </>
                    }
                    onConfirm={() =>
                      run(
                        'submit',
                        () => api('POST', `/api/revisions/${live.id}/submit`, {}),
                        'Approval requested.',
                      )
                    }
                  >
                    Request approval
                  </ConfirmButton>
                )}
              </>
            )}
            {live?.state === 'REVIEWABLE' && (
              <p>
                Waiting for an approver. <Link href={`/approvals/${live.id}`}>Open the approval record</Link>.
              </p>
            )}
            {live?.state === 'APPROVED' && !op && (
              <>
                <p>
                  Approved. <Link href={`/approvals/${live.id}`}>See the approval</Link>. Sending creates
                  exactly one PayPal refund operation for this revision.
                </p>
                {isOperator &&
                  (data.capabilities.paypal ? (
                    <ConfirmButton
                      title="Send this refund to PayPal"
                      confirmLabel="Send refund"
                      body={
                        <>
                          <p>
                            Revision {live.revisionNo}: <strong>{amountText(live.wire.amount)}</strong> on
                            capture <code>{live.wire.captureId}</code>.
                          </p>
                          <p className="small muted">
                            The worker sends it once under a fixed PayPal request id. If the answer is lost,
                            the outcome stays unknown until PayPal confirms it.
                          </p>
                        </>
                      }
                      onConfirm={() =>
                        run(
                          'execute',
                          () => api('POST', `/api/revisions/${live.id}/execute`),
                          'Refund operation created.',
                        )
                      }
                    >
                      Send refund
                    </ConfirmButton>
                  ) : (
                    <p className="small">
                      <Status state="BLOCKED" label="PayPal blocked" /> No PayPal sandbox credential is
                      configured, so nothing can be sent.
                    </p>
                  ))}
              </>
            )}
            {op && (
              <div className="stack">
                <div className="row">
                  <Status state={op.state} />
                </div>
                {op.state === 'CONFIRMED' && <p>PayPal confirmed the refund.</p>}
                {(op.state === 'OUTCOME_UNKNOWN' || op.state === 'RECONCILING') && (
                  <p>
                    The outcome is not known yet. RefundProof is asking PayPal; it will not send again.
                    {op.nextReconcileAt ? ` Next check ${when(op.nextReconcileAt)}.` : ''}
                  </p>
                )}
                {op.state === 'EXHAUSTED' && (
                  <p>Lookups stopped without an answer from PayPal. Escalate, or ask for more lookups.</p>
                )}
                <p>
                  <Link href={`/operations/${op.id}`}>Open the operation timeline</Link>
                </p>
                <p className="small muted">
                  PayPal request id <code>{op.paypalRequestId}</code>
                </p>
              </div>
            )}
          </div>
        </section>
      </div>
    </>
  );
}
