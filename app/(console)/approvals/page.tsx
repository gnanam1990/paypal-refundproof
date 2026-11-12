'use client';

import Link from 'next/link';
import { api } from '../../ui/api';
import { amountText, ErrorSummary, Icon, REASONS, Skeleton, when } from '../../ui/components';
import { useLoad } from '../../ui/session';

interface Pending {
  revisionId: string;
  caseId: string;
  caseTitle: string;
  revisionNo: number;
  amount: {
    kind: string;
    amount?: { currency: string; value: string };
    captureAmount?: { currency: string; value: string };
  };
  captureId: string;
  reasonCode: string;
  requestedAt: string;
}

export default function ApprovalsPage() {
  const { data, error } = useLoad(() => api<{ pending: Pending[] }>('GET', '/api/approvals'));
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Approvals</h1>
          <p>
            Proposals waiting for a decision, oldest request first. You decide the exact revision you open.
          </p>
        </div>
      </div>
      <section className="panel">
        <ErrorSummary error={error} />
        {!data && !error && <Skeleton lines={4} />}
        {data && data.pending.length === 0 && (
          <p className="muted">
            <Icon name="inbox" /> Nothing is waiting for approval.
          </p>
        )}
        {data && data.pending.length > 0 && (
          <div className="table-wrap">
            <table>
              <caption className="sr-only">Pending approvals</caption>
              <thead>
                <tr>
                  <th scope="col">Case</th>
                  <th scope="col">Refund</th>
                  <th scope="col">Reason</th>
                  <th scope="col">Capture</th>
                  <th scope="col">Requested</th>
                </tr>
              </thead>
              <tbody>
                {data.pending.map((p) => (
                  <tr key={p.revisionId}>
                    <td>
                      <Link href={`/approvals/${p.revisionId}`}>{p.caseTitle}</Link>
                      <div className="small muted">Revision {p.revisionNo}</div>
                    </td>
                    <td className="mono">{amountText(p.amount)}</td>
                    <td>{REASONS[p.reasonCode] ?? p.reasonCode}</td>
                    <td>
                      <code>{p.captureId}</code>
                    </td>
                    <td>{when(p.requestedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
