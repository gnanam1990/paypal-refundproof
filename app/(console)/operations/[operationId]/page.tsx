'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '../../../ui/api';
import { ErrorSummary, Skeleton, Status, useAnnouncer, when } from '../../../ui/components';
import { useActor, useLoad } from '../../../ui/session';

interface Operation {
  id: string;
  caseId: string;
  revisionId: string;
  state: string;
  captureId: string;
  paypalRequestId: string;
  invoiceId: string;
  customId: string;
  refundId: string | null;
  outbound: {
    semantic: string;
    expected: { currency: string; value: string };
    body: { amount?: { currency_code: string; value: string } };
  };
  neverDispatchedEvidence: { reason: string; at: string } | null;
  nextReconcileAt: string | null;
  escalation: { at: string; note: string } | null;
  createdAt: string;
  attempts: Array<{
    attempt_no: number;
    phase: string;
    started_at: string;
    finished_at: string | null;
    http_status: number | null;
    error_class: string | null;
  }>;
  observations: Array<{
    id: string;
    kind: string;
    classification: string;
    source: string;
    http_status: number | null;
    paypal_debug_id: string | null;
    refund_id: string | null;
    refund_status: string | null;
    observed_at: string;
  }>;
  transitions: Array<{ from_state: string | null; to_state: string; created_at: string }>;
  jobs: Array<{
    id: number;
    kind: string;
    state: string;
    attempts: number;
    run_at: string;
    last_error: string | null;
  }>;
}

const CLASS_TEXT: Record<string, string> = {
  REFUND_COMPLETED: 'PayPal reports the refund completed',
  REFUND_PENDING: 'PayPal reports the refund pending',
  REFUND_TERMINAL_NOT_APPLIED: 'PayPal reports the refund failed or was cancelled',
  REQUEST_REJECTED_TERMINAL: 'PayPal rejected the request',
  NOT_PROCESSED_RETRYABLE: 'PayPal did not process the request (it will be retried under the same id)',
  MATCH_ABSENT: 'No matching refund found yet (not proof that none happened)',
  AMBIGUOUS: 'No usable answer (the outcome stays unknown)',
};

export default function OperationPage() {
  const { operationId } = useParams<{ operationId: string }>();
  const actor = useActor()!;
  const { data, error, reload } = useLoad(
    () => api<{ operation: Operation }>('GET', `/api/operations/${operationId}`),
    [operationId],
  );
  const [actionError, setActionError] = useState<unknown>(null);
  const { announce, node } = useAnnouncer();
  const op = data?.operation;
  const unresolved = op && ['READY', 'SUBMITTING', 'OUTCOME_UNKNOWN', 'RECONCILING'].includes(op.state);
  useEffect(() => {
    if (!unresolved) return;
    const t = setInterval(reload, 10_000);
    return () => clearInterval(t);
  }, [unresolved]);
  useEffect(() => {
    if (op) announce(`Operation is ${op.state.toLowerCase().replace(/_/g, ' ')}.`);
  }, [op?.state]);

  if (error) return <ErrorSummary error={error} />;
  if (!op) return <Skeleton block />;
  const isOperator = actor.role === 'OPERATOR' || actor.role === 'ADMIN';
  const last = op.observations.at(-1);

  return (
    <>
      {node}
      <div className="page-head">
        <div>
          <p className="small">
            <Link href={`/cases/${op.caseId}`}>Case</Link> / operation <code>{op.id}</code>
          </p>
          <h1>Refund operation</h1>
          <p>One operation, one PayPal request id. Every network try is an attempt under it.</p>
        </div>
        <Status state={op.state} />
      </div>
      <ErrorSummary error={actionError} />
      <div className="workspace" style={{ gridTemplateColumns: 'minmax(0,1.4fr) minmax(16rem,1fr)' }}>
        <section className="stack">
          <div className="panel">
            <h2>What was sent</h2>
            <table>
              <tbody>
                <tr>
                  <th scope="row">Capture</th>
                  <td>
                    <code>{op.captureId}</code>
                  </td>
                </tr>
                <tr>
                  <th scope="row">Amount</th>
                  <td>
                    {op.outbound.semantic === 'EXACT'
                      ? `${op.outbound.expected.value} ${op.outbound.expected.currency} (amount field sent)`
                      : `Full remaining capture, ${op.outbound.expected.value} ${op.outbound.expected.currency} captured (no amount field, by approval)`}
                  </td>
                </tr>
                <tr>
                  <th scope="row">PayPal request id</th>
                  <td>
                    <code>{op.paypalRequestId}</code>
                  </td>
                </tr>
                <tr>
                  <th scope="row">Invoice / custom id</th>
                  <td>
                    <code>{op.invoiceId}</code> / <code>{op.customId}</code>
                  </td>
                </tr>
                <tr>
                  <th scope="row">PayPal refund id</th>
                  <td>
                    {op.refundId ? <code>{op.refundId}</code> : <span className="muted">Not known</span>}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="panel">
            <h2>Timeline</h2>
            <ol className="timeline">
              {op.transitions.map((t, i) => (
                <li key={`t${i}`}>
                  <div className="row">
                    <Status state={t.to_state} />
                    <span className="small muted">{when(t.created_at)}</span>
                  </div>
                </li>
              ))}
            </ol>
          </div>
          <div className="panel">
            <h2>Attempts</h2>
            {op.attempts.length === 0 ? (
              <p className="muted">Nothing has been sent.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">#</th>
                      <th scope="col">Phase</th>
                      <th scope="col">Started</th>
                      <th scope="col">Answer</th>
                    </tr>
                  </thead>
                  <tbody>
                    {op.attempts.map((a) => (
                      <tr key={a.attempt_no}>
                        <td>{a.attempt_no}</td>
                        <td>{a.phase.toLowerCase().replace(/_/g, ' ')}</td>
                        <td>{when(a.started_at)}</td>
                        <td>{a.http_status ? `HTTP ${a.http_status}` : (a.error_class ?? '—')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <div className="panel">
            <h2>Provider evidence</h2>
            {op.observations.length === 0 ? (
              <p className="muted">No PayPal observation yet.</p>
            ) : (
              <ul className="list">
                {op.observations.map((o) => (
                  <li key={o.id} className="small">
                    <strong>{CLASS_TEXT[o.classification] ?? o.classification}</strong>
                    <div className="muted">
                      {o.kind.toLowerCase().replace(/_/g, ' ')} from{' '}
                      {o.source === 'CONTRACT_STUB' ? 'the contract stub (not PayPal)' : 'PayPal sandbox'},{' '}
                      {when(o.observed_at)}
                      {o.http_status ? `, HTTP ${o.http_status}` : ''}
                      {o.paypal_debug_id ? (
                        <>
                          , debug id <code>{o.paypal_debug_id}</code>
                        </>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <section className="panel stack" aria-labelledby="recon-title">
          <h2 id="recon-title">Reconciliation</h2>
          {op.state === 'CONFIRMED' && <p>PayPal confirmed this refund. Nothing else will be sent.</p>}
          {op.state === 'PROVIDER_TERMINAL_NOT_APPLIED' && (
            <p>
              PayPal did not apply this refund. A different refund needs a new revision and a new approval.
            </p>
          )}
          {op.state === 'CANCELLED_BEFORE_DISPATCH' && (
            <p>
              Cancelled before anything was sent
              {op.neverDispatchedEvidence
                ? `: ${op.neverDispatchedEvidence.reason.toLowerCase().replace(/_/g, ' ')}`
                : ''}
              .
            </p>
          )}
          {(op.state === 'READY' || op.state === 'SUBMITTING') && (
            <p>Queued for the worker. This page refreshes on its own.</p>
          )}
          {(op.state === 'OUTCOME_UNKNOWN' || op.state === 'RECONCILING' || op.state === 'EXHAUSTED') && (
            <>
              <p>
                {op.state === 'EXHAUSTED'
                  ? 'RefundProof stopped asking PayPal without a definite answer. It will not send the refund again.'
                  : 'The outcome is unknown. RefundProof asks PayPal on a schedule and never sends again on its own.'}
              </p>
              <p className="small">
                Last evidence: {last ? (CLASS_TEXT[last.classification] ?? last.classification) : 'none yet'}
                {last ? ` (${when(last.observed_at)})` : ''}.
                {op.nextReconcileAt ? ` Next check ${when(op.nextReconcileAt)}.` : ''}
              </p>
              {op.state === 'EXHAUSTED' && isOperator && (
                <button
                  type="button"
                  className="secondary"
                  onClick={async () => {
                    setActionError(null);
                    try {
                      await api('POST', `/api/operations/${op.id}/reconcile`);
                      announce('Lookups resumed.');
                    } catch (e) {
                      setActionError(e);
                    }
                    reload();
                  }}
                >
                  Ask PayPal again
                </button>
              )}
              {op.escalation ? (
                <p className="small">
                  Escalated {when(op.escalation.at)}: {op.escalation.note}
                </p>
              ) : (
                <form
                  className="stack"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const note = String(new FormData(e.currentTarget).get('note') ?? '');
                    setActionError(null);
                    try {
                      await api('POST', `/api/operations/${op.id}/escalate`, { note });
                      announce('Escalated.');
                    } catch (err) {
                      setActionError(err);
                    }
                    reload();
                  }}
                >
                  <label>
                    Escalate
                    <span className="hint">
                      Record who is following up and how. This changes nothing at PayPal.
                    </span>
                    <textarea name="note" required maxLength={2000} />
                  </label>
                  <div>
                    <button type="submit">Record escalation</button>
                  </div>
                </form>
              )}
            </>
          )}
          <h3>Scheduled work</h3>
          <ul className="list small">
            {op.jobs.map((j) => (
              <li key={j.id}>
                {j.kind.toLowerCase().replace(/_/g, ' ')}: {j.state.toLowerCase()}, {j.attempts} run
                {j.attempts === 1 ? '' : 's'}, next {when(j.run_at)}
                {j.last_error ? <div className="muted">Last error: {j.last_error}</div> : null}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}
