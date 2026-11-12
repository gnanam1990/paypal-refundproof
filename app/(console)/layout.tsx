'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../ui/api';
import { Icon, Skeleton } from '../ui/components';
import { SessionProvider, useActor } from '../ui/session';

const NAV = [
  { href: '/cases', label: 'Cases', icon: 'doc' as const },
  { href: '/approvals', label: 'Approvals', icon: 'shield' as const },
  { href: '/health', label: 'System health', icon: 'pulse' as const },
];

function Shell({ children }: { children: ReactNode }) {
  const actor = useActor()!;
  const path = usePathname();
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    setOnline(navigator.onLine);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  return (
    <div className="shell">
      <aside className="rail">
        <Link className="brand" href="/cases" aria-label="RefundProof cases">
          <span className="brand-mark" aria-hidden="true">
            <Icon name="shield" />
          </span>
          <span>
            RefundProof
            <small>Evidence-bound refunds</small>
          </span>
        </Link>
        <p className="nav-label">Workspace</p>
        <nav aria-label="Console">
          <ul>
            {NAV.map((n) => (
              <li key={n.href}>
                <Link
                  href={n.href}
                  aria-current={path === n.href || path.startsWith(`${n.href}/`) ? 'page' : undefined}
                >
                  <Icon name={n.icon} />
                  {n.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="who">
          <div className="identity">
            <span className="avatar" aria-hidden="true">
              {actor.displayName.slice(0, 1).toUpperCase()}
            </span>
            <span className="identity-copy">
              <strong>{actor.displayName}</strong>
              <small>{actor.role.toLowerCase()}</small>
            </span>
          </div>
          <button
            type="button"
            className="secondary"
            onClick={async () => {
              await api('POST', '/api/auth/logout').catch(() => undefined);
              window.location.assign('/login');
            }}
          >
            Sign out
          </button>
        </div>
      </aside>
      <div className="content-shell">
        <header className="topbar">
          <div className="environment-pill" aria-label="PayPal sandbox environment">
            <span className="environment-dot" aria-hidden="true" />
            PayPal sandbox
          </div>
          <div className="topbar-note">
            <Icon name="shield" />
            Human-approved · evidence-bound
          </div>
        </header>
        <main className="main" id="main" tabIndex={-1}>
          {!online && (
            <div className="banner" role="alert">
              <Icon name="alert" />
              <span>
                You are offline. What you see may be out of date, and actions are paused until the connection
                returns.
              </span>
            </div>
          )}
          {children}
        </main>
      </div>
    </div>
  );
}

export default function ConsoleLayout({ children }: { children: ReactNode }) {
  return (
    <SessionProvider
      fallback={
        <main className="main" id="main" aria-busy="true">
          <Skeleton lines={4} />
        </main>
      }
    >
      <Shell>{children}</Shell>
    </SessionProvider>
  );
}
