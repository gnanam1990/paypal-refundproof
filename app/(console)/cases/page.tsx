'use client';

import Link from 'next/link';
import { useState } from 'react';
import { api } from '../../ui/api';
import { ErrorSummary, Icon, Skeleton, Status, when } from '../../ui/components';
import { useActor, useLoad } from '../../ui/session';

interface CaseRow {
  id: string;
  title: string;
  customerRef: string | null;
  status: string;
  createdAt: string;
}

export default function CasesPage() {
  const actor = useActor()!;
  const { data, error, reload } = useLoad(() => api<{ cases: CaseRow[] }>('GET', '/api/cases'));
  const [formError, setFormError] = useState<unknown>(null);
  const canCreate = actor.role !== 'APPROVER';
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Cases</h1>
          <p>
            Support cases that may need a refund. Open one to review its evidence and draft the exact
            proposal.
          </p>
        </div>
      </div>
      <div
        className="workspace"
        style={{ gridTemplateColumns: canCreate ? 'minmax(0,2fr) minmax(16rem,1fr)' : '1fr' }}
      >
        <section className="panel" aria-labelledby="queue-title">
          <h2 id="queue-title">Queue</h2>
          <ErrorSummary error={error} />
          {!data && !error && <Skeleton lines={5} />}
          {data && data.cases.length === 0 && (
            <p className="muted">
              <Icon name="inbox" /> No cases yet.{' '}
              {canCreate
                ? 'Start one from the support conversation with the form alongside.'
                : 'Operators create cases.'}
            </p>
          )}
          {data && data.cases.length > 0 && (
            <div className="table-wrap">
              <table>
                <caption className="sr-only">Cases, newest first</caption>
                <thead>
                  <tr>
                    <th scope="col">Case</th>
                    <th scope="col">Customer reference</th>
                    <th scope="col">Status</th>
                    <th scope="col">Opened</th>
                  </tr>
                </thead>
                <tbody>
                  {data.cases.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <Link href={`/cases/${c.id}`}>{c.title}</Link>
                        <div className="small muted">
                          <code>{c.id}</code>
                        </div>
                      </td>
                      <td>{c.customerRef ?? <span className="muted">—</span>}</td>
                      <td>
                        <Status state={c.status} label={c.status.toLowerCase().replace(/_/g, ' ')} />
                      </td>
                      <td>{when(c.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        {canCreate && (
          <section className="panel" aria-labelledby="new-title">
            <h2 id="new-title">Open a case</h2>
            <ErrorSummary error={formError} />
            <form
              className="stack"
              onSubmit={async (e) => {
                e.preventDefault();
                const form = e.currentTarget;
                const f = new FormData(form);
                setFormError(null);
                try {
                  const ref = String(f.get('customerRef') ?? '').trim();
                  const r = await api<{ case: CaseRow }>('POST', '/api/cases', {
                    title: String(f.get('title') ?? ''),
                    ...(ref ? { customerRef: ref } : {}),
                  });
                  form.reset();
                  reload();
                  window.location.assign(`/cases/${r.case.id}`);
                } catch (err) {
                  setFormError(err);
                }
              }}
            >
              <label>
                Title
                <span className="hint">What the customer reports, in a few words.</span>
                <input name="title" required maxLength={200} />
              </label>
              <label>
                Customer reference
                <span className="hint">Optional. Your ticket or order number.</span>
                <input name="customerRef" maxLength={200} />
              </label>
              <button type="submit">Open case</button>
            </form>
          </section>
        )}
      </div>
    </>
  );
}
