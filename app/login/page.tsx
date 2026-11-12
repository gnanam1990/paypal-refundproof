'use client';

import { useState } from 'react';
import { api, setCsrf } from '../ui/api';
import { ErrorSummary } from '../ui/components';

export default function LoginPage() {
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <main className="login" id="main">
      <div className="panel">
        <h1>RefundProof</h1>
        <p className="muted">
          Sign in to review evidence, approve exact refunds and follow every PayPal outcome.
        </p>
        <ErrorSummary error={error} />
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            setBusy(true);
            setError(null);
            try {
              const r = await api<{ csrfToken: string }>('POST', '/api/auth/login', {
                email: String(f.get('email') ?? ''),
                password: String(f.get('password') ?? ''),
              });
              setCsrf(r.csrfToken);
              const next = new URLSearchParams(window.location.search).get('next');
              window.location.assign(
                next && next.startsWith('/') && !next.startsWith('//') ? next : '/cases',
              );
            } catch (err) {
              setError(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            Email
            <input name="email" type="email" autoComplete="username" required />
          </label>
          <label>
            Password
            <input name="password" type="password" autoComplete="current-password" required />
          </label>
          <button type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <p className="small muted" style={{ marginTop: '1rem' }}>
          Seeded demo accounts are labelled “(seeded)” and exist only in development databases.
        </p>
      </div>
    </main>
  );
}
