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
        <div className="brand">
          RefundProof
          <small>PayPal sandbox refunds</small>
        </div>
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
          <span>
            {actor.displayName}
            <br />
            <span className="small">{actor.role.toLowerCase()}</span>
          </span>
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
