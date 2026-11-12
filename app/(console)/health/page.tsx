'use client';

import { api } from '../../ui/api';
import { ErrorSummary, Skeleton, Status, when } from '../../ui/components';
import { useLoad } from '../../ui/session';

interface Health {
  database: string;
  migrations: { applied: string[]; pending: string[] };
  workers: Array<{ workerId: string; lastSeenAt: string; ageSeconds: number; alive: boolean }>;
  jobs: Array<{ kind: string; state: string; n: number }>;
  operations: Array<{ state: string; n: number }>;
  capabilities: {
    model: { provider: string; model: string } | null;
    captureSource: string | null;
    paypal: string | null;
  };
  checkedAt: string;
}

function Capability({ name, value, blocked }: { name: string; value: string | null; blocked: string }) {
  return (
    <tr>
      <th scope="row">{name}</th>
      <td>
        {value ? <Status state="APPROVED" label={value} /> : <Status state="BLOCKED" label="Blocked" />}
      </td>
      <td className="muted">{value ? '' : blocked}</td>
    </tr>
  );
}

export default function HealthPage() {
  const { data, error, reload } = useLoad(() => api<{ health: Health }>('GET', '/api/health/detail'));
  const h = data?.health;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>System health</h1>
          <p>
            Read from the database: migrations, worker heartbeats, scheduled work and what this environment
            can reach.
          </p>
        </div>
        <button type="button" className="secondary" onClick={reload}>
          Check again
        </button>
      </div>
      <ErrorSummary error={error} />
      {!h && !error && <Skeleton block />}
      {h && (
        <div className="workspace" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(18rem, 1fr))' }}>
          <section className="panel">
            <h2>Environment</h2>
            <table>
              <tbody>
                <Capability
                  name="Proposal model"
                  value={
                    h.capabilities.model
                      ? `${h.capabilities.model.provider}: ${h.capabilities.model.model}`
                      : null
                  }
                  blocked="No approved model credential (BLOCKED_CREDENTIAL)"
                />
                <Capability
                  name="Capture lookup"
                  value={h.capabilities.captureSource}
                  blocked="No capture source configured"
                />
                <Capability
                  name="PayPal refunds"
                  value={h.capabilities.paypal}
                  blocked="No PayPal sandbox credential (BLOCKED_CREDENTIAL)"
                />
              </tbody>
            </table>
            <p className="small muted" style={{ marginTop: '0.5rem' }}>
              Checked {when(h.checkedAt)}. Live PayPal is not supported.
            </p>
          </section>
          <section className="panel">
            <h2>Database</h2>
            <p>
              <Status
                state={h.migrations.pending.length ? 'BLOCKED' : 'APPROVED'}
                label={h.migrations.pending.length ? 'Migrations pending' : 'Schema current'}
              />
            </p>
            <p className="small muted">
              Applied {h.migrations.applied.join(', ')}
              {h.migrations.pending.length ? `; pending ${h.migrations.pending.join(', ')}` : ''}.
            </p>
          </section>
          <section className="panel">
            <h2>Workers</h2>
            {h.workers.length === 0 ? (
              <p>
                <Status state="BLOCKED" label="No worker seen" /> Start one with <code>pnpm worker</code>.
              </p>
            ) : (
              <ul className="list small">
                {h.workers.map((w) => (
                  <li key={w.workerId}>
                    <Status state={w.alive ? 'APPROVED' : 'EXHAUSTED'} label={w.alive ? 'Alive' : 'Silent'} />{' '}
                    <code>{w.workerId}</code>, last seen {when(w.lastSeenAt)}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="panel">
            <h2>Scheduled work</h2>
            {h.jobs.length === 0 ? (
              <p className="muted">No jobs.</p>
            ) : (
              <table>
                <tbody>
                  {h.jobs.map((j) => (
                    <tr key={`${j.kind}-${j.state}`}>
                      <td>{j.kind.toLowerCase().replace(/_/g, ' ')}</td>
                      <td>{j.state.toLowerCase()}</td>
                      <td>{j.n}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
          <section className="panel">
            <h2>Refund operations</h2>
            {h.operations.length === 0 ? (
              <p className="muted">None yet.</p>
            ) : (
              <ul className="list">
                {h.operations.map((o) => (
                  <li key={o.state} className="row">
                    <Status state={o.state} /> <span>{o.n}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </>
  );
}
