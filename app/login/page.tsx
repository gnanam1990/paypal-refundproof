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
      <div className="login-shell">
        <section className="login-intro" aria-labelledby="login-product-title">
          <div className="login-brand">
            <span className="login-mark" aria-hidden="true">
              RP
            </span>
            <span>RefundProof</span>
          </div>
          <div>
            <p className="login-context">Refund operations console</p>
            <h1 id="login-product-title">PayPal refunds with evidence and approval.</h1>
            <p>
              Bind an exact refund to redacted evidence, an independent decision and PayPal’s final provider
              status.
            </p>
          </div>
          <ul className="login-assurances" aria-label="RefundProof safeguards">
            <li>Evidence is redacted and digest-bound</li>
            <li>Approval binds one immutable revision</li>
            <li>Provider outcomes reconcile safely</li>
          </ul>
        </section>
        <section className="login-card" aria-labelledby="login-title">
          <div className="login-card-head">
            <span className="environment-pill">
              <span className="environment-dot" />
              Sandbox environment
            </span>
            <h2 id="login-title">Welcome back</h2>
            <p>Sign in to continue to the operations console.</p>
          </div>
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
              Work email
              <input name="email" type="email" autoComplete="username" required />
            </label>
            <label>
              Password
              <input name="password" type="password" autoComplete="current-password" required />
            </label>
            <button type="submit" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in to RefundProof'}
            </button>
          </form>
          <p className="small muted login-footnote">
            Development-only seeded identities are isolated from production accounts.
          </p>
        </section>
      </div>
    </main>
  );
}
