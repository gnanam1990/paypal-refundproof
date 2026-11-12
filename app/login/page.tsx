'use client';

import { useState } from 'react';
import { api, setCsrf } from '../ui/api';
import { ErrorSummary } from '../ui/components';

/**
 * Where to go after signing in: only a path on this origin. The value is resolved by the URL parser (so
 * backslashes, protocol-relative and absolute URLs are normalised first) and rejected unless it stays here.
 */
function safeNext(next: string | null): string {
  if (!next || next.includes('\\') || [...next].some((ch) => ch.charCodeAt(0) < 0x20)) return '/cases';
  try {
    const u = new URL(next, window.location.origin);
    if (u.origin !== window.location.origin || u.pathname.startsWith('//') || u.pathname.startsWith('/login'))
      return '/cases';
    return u.href; // absolute and same-origin: never reinterpreted as protocol-relative
  } catch {
    return '/cases';
  }
}

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
              window.location.assign(safeNext(new URLSearchParams(window.location.search).get('next')));
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
