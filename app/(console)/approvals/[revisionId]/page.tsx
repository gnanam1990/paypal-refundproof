'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { api } from '../../../ui/api';
import {
  ConfirmButton,
  Digest,
  ErrorSummary,
  REASONS,
  Skeleton,
  Status,
  useAnnouncer,
  when,
} from '../../../ui/components';
import { useActor, useLoad } from '../../../ui/session';

interface Facts {
  revisionId: string;
  revisionNo: number;
  caseId: string;
  state: string;
  effectiveState: string;
  revisionDigest: string;
  capture: {
    captureId: string;
    status: string;
    amount: { currency: string; value: string };
    payeeMerchantId: string | null;
    orderId: string | null;
    source: string;
    fetchedAt: string;
  } | null;
  amount:
    | { kind: 'EXACT'; currency: string; value: string; display: string }
    | { kind: 'FULL'; currency: string; captureAmount: string; display: string };
  reason: { code: string; noteToPayer: string | null };
  evidenceDigests: string[];
  policyVersion: string;
  policy: { approvalTtlMinutes: number };
  requiredApproverRole: 'APPROVER' | 'ADMIN';
  origin: string;
  authoredBy: string;
  request: { requestedBy: string; requestedAt: string; note: string | null } | null;
  approval: {
    id: string;
    decision: string;
    approverId: string;
    decidedAt: string;
    expiresAt: string;
    revokedAt: string | null;
    fullRefundAcknowledged: boolean;
    approvalDigest: string;
    live: boolean;
  } | null;
}

export default function ApprovalDetail() {
  const { revisionId } = useParams<{ revisionId: string }>();
  const actor = useActor()!;
  const { data, error, reload } = useLoad(
    () => api<{ facts: Facts }>('GET', `/api/revisions/${revisionId}/approval`),
    [revisionId],
  );
  const [actionError, setActionError] = useState<unknown>(null);
  const [consent, setConsent] = useState('');
  const { announce, node } = useAnnouncer();
  if (error) return <ErrorSummary error={error} />;
  if (!data) return <Skeleton block />;
  const f = data.facts;
  const isApprover = actor.role === 'APPROVER' || actor.role === 'ADMIN';
  const selfInvolved = actor.id === f.authoredBy || actor.id === f.request?.requestedBy;
  const roleShort = f.requiredApproverRole === 'ADMIN' && actor.role !== 'ADMIN';
  const canDecide = isApprover && f.state === 'REVIEWABLE' && !selfInvolved;

  const decide = async (decision: 'APPROVED' | 'REJECTED') => {
    setActionError(null);
    try {
      await api('POST', `/api/revisions/${revisionId}/decision`, {
        decision,
        revisionDigest: f.revisionDigest,
        ...(f.amount.kind === 'FULL' && decision === 'APPROVED'
          ? { fullRefundConsent: { captureAmount: consent } }
          : {}),
      });
      announce(decision === 'APPROVED' ? 'Approved.' : 'Rejected.');
    } catch (e) {
      setActionError(e);
    }
    reload();
  };

  return (
    <>
      {node}
      <div className="page-head">
        <div>
          <p className="small">
            <Link href="/approvals">Approvals</Link> / <Link href={`/cases/${f.caseId}`}>Case</Link> /
            revision {f.revisionNo}
          </p>
          <h1>Approval record</h1>
          <p>Every fact below is read from the stored revision. Approving binds exactly this digest.</p>
        </div>
        <Status state={f.effectiveState} />
      </div>
      <ErrorSummary error={actionError} />
      <article className="facts" aria-label="Bound approval facts">
        <div className="facts-head">
          <div>
            <div className="small muted">
              {f.amount.kind === 'FULL' ? 'Full refund of the remaining capture' : 'Exact refund amount'}
            </div>
            <div className="facts-amount">
              {f.amount.kind === 'EXACT'
                ? `${f.amount.value} ${f.amount.currency}`
                : `FULL · captured ${f.amount.captureAmount} ${f.amount.currency}`}
            </div>
          </div>
          <div className="small">
            Revision digest
            <br />
            <Digest value={f.revisionDigest} label="Revision digest" />
          </div>
        </div>
        <dl>
          <dt>Capture</dt>
          <dd>
            {f.capture ? (
              <>
                <code>{f.capture.captureId}</code>, {f.capture.amount.value} {f.capture.amount.currency},{' '}
                {f.capture.status.toLowerCase().replace(/_/g, ' ')}
                <div className="small muted">
                  {f.capture.source === 'CONTRACT_STUB'
                    ? 'Labelled contract stub, not PayPal'
                    : 'PayPal sandbox'}
                  ; read {when(f.capture.fetchedAt)}
                </div>
              </>
            ) : (
              '—'
            )}
          </dd>
          <dt>Merchant</dt>
          <dd>{f.capture?.payeeMerchantId ? <code>{f.capture.payeeMerchantId}</code> : '—'}</dd>
          <dt>Sent to PayPal</dt>
          <dd>
            {f.amount.kind === 'EXACT' ? (
              <>
                <code>
                  amount = {`{ currency_code: "${f.amount.currency}", value: "${f.amount.value}" }`}
                </code>
              </>
            ) : (
              <>
                No <code>amount</code> field: PayPal refunds the captured amount minus earlier refunds. This
                is intentional and needs your explicit consent.
              </>
            )}
          </dd>
          <dt>Reason</dt>
          <dd>
            {REASONS[f.reason.code] ?? f.reason.code}
            {f.reason.noteToPayer ? (
              <div className="small">Note to customer: “{f.reason.noteToPayer}”</div>
            ) : null}
          </dd>
          <dt>Evidence</dt>
          <dd>
            {f.evidenceDigests.length} item{f.evidenceDigests.length === 1 ? '' : 's'}
            <ul className="small" style={{ margin: '0.3rem 0 0', paddingLeft: '1.1rem' }}>
              {f.evidenceDigests.map((d) => (
                <li key={d}>
                  <Digest value={d} label="Evidence digest" />
                </li>
              ))}
            </ul>
          </dd>
          <dt>Policy</dt>
          <dd>
            <code>{f.policyVersion}</code>: approval lasts {f.policy.approvalTtlMinutes} minutes; this amount
            needs an {f.requiredApproverRole.toLowerCase()}.
          </dd>
          <dt>Requested</dt>
          <dd>
            {f.request
              ? `${when(f.request.requestedAt)}${f.request.note ? `: ${f.request.note}` : ''}`
              : 'Not requested yet'}
          </dd>
          <dt>Decision</dt>
          <dd>
            {f.approval ? (
              <>
                {f.approval.decision.toLowerCase()} {when(f.approval.decidedAt)}
                {f.approval.decision === 'APPROVED' && (
                  <>
                    , expires {when(f.approval.expiresAt)}
                    {f.approval.revokedAt ? `, revoked ${when(f.approval.revokedAt)}` : ''}
                    {f.approval.fullRefundAcknowledged ? ', full refund consented' : ''}
                    <div className="small muted">
                      Approval digest <Digest value={f.approval.approvalDigest} label="Approval digest" />
                    </div>
                  </>
                )}
              </>
            ) : (
              'No decision yet'
            )}
          </dd>
        </dl>
      </article>

      <section className="panel" style={{ marginTop: '1rem' }} aria-labelledby="decide-title">
        <h2 id="decide-title">Decision</h2>
        {f.state !== 'REVIEWABLE' && (
          <p className="muted">
            This revision is {f.effectiveState.toLowerCase()}; there is nothing to decide here.
          </p>
        )}
        {f.state === 'REVIEWABLE' && !isApprover && (
          <p className="muted">Only approvers and admins decide refunds.</p>
        )}
        {f.state === 'REVIEWABLE' && isApprover && selfInvolved && (
          <p>
            <Status state="BLOCKED" label="Separation of duties" /> You wrote or requested this revision, so
            another approver must decide it.
          </p>
        )}
        {canDecide && (
          <div className="stack">
            {roleShort && (
              <p>
                <Status state="BLOCKED" label="Admin needed" /> This amount is above the policy limit for
                approvers. You can reject it; an admin must approve it.
              </p>
            )}
            {f.amount.kind === 'FULL' && !roleShort && (
              <label>
                Type the captured amount to consent to a full refund
                <span className="hint">
                  Enter <code>{f.amount.captureAmount}</code> exactly.
                </span>
                <input
                  value={consent}
                  onChange={(e) => setConsent(e.target.value)}
                  inputMode="decimal"
                  autoComplete="off"
                />
              </label>
            )}
            <div className="row">
              {!roleShort && (
                <ConfirmButton
                  disabled={f.amount.kind === 'FULL' && consent.trim() !== f.amount.captureAmount}
                  title={`Approve ${f.amount.display}`}
                  confirmLabel="Approve refund"
                  body={
                    <>
                      <p>
                        You approve revision {f.revisionNo} with digest <Digest value={f.revisionDigest} />.
                      </p>
                      <p className="small muted">
                        If anything changed since you opened this page, the approval is refused and you will
                        see the current facts.
                      </p>
                    </>
                  }
                  onConfirm={() => decide('APPROVED')}
                >
                  Approve
                </ConfirmButton>
              )}
              <ConfirmButton
                tone="danger"
                title="Reject this proposal"
                confirmLabel="Reject proposal"
                body={<p>Revision {f.revisionNo} will be rejected. The operator can write a new revision.</p>}
                onConfirm={() => decide('REJECTED')}
              >
                Reject
              </ConfirmButton>
            </div>
          </div>
        )}
        {f.approval?.live && isApprover && (
          <form
            className="stack"
            style={{ marginTop: '1rem' }}
            onSubmit={async (e) => {
              e.preventDefault();
              const reason = String(new FormData(e.currentTarget).get('reason') ?? '');
              setActionError(null);
              try {
                await api('POST', `/api/approvals/${f.approval!.id}/revoke`, { reason });
                announce('Approval revoked.');
              } catch (err) {
                setActionError(err);
              }
              reload();
            }}
          >
            <label>
              Revoke this approval
              <span className="hint">Possible only before a refund operation exists.</span>
              <input name="reason" required maxLength={1000} placeholder="Why it should not be sent" />
            </label>
            <div>
              <button type="submit" className="danger">
                Revoke approval
              </button>
            </div>
          </form>
        )}
      </section>
    </>
  );
}
