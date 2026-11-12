'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, setCsrf } from './api';

export interface SessionActor {
  id: string;
  tenantId: string;
  role: 'OPERATOR' | 'APPROVER' | 'ADMIN';
  email: string;
  displayName: string;
  seeded?: boolean;
}

const Ctx = createContext<SessionActor | null>(null);
export const useActor = () => useContext(Ctx);

/** Resolves the server session (cookie) and CSRF token; unauthenticated visitors are sent to /login by api(). */
export function SessionProvider({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
  const [actor, setActor] = useState<SessionActor | null>(null);
  useEffect(() => {
    api<{ actor: SessionActor; csrfToken: string }>('GET', '/api/session')
      .then((s) => {
        setCsrf(s.csrfToken);
        setActor(s.actor);
      })
      .catch(() => undefined);
  }, []);
  if (!actor) return <>{fallback}</>;
  return <Ctx.Provider value={actor}>{children}</Ctx.Provider>;
}

/** Re-runs a loader on demand and when the browser comes back online or the tab regains focus. */
export function useLoad<T>(loader: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let live = true;
    loader()
      .then((d) => {
        if (live) {
          setData(d);
          setError(null);
        }
      })
      .catch((e) => live && setError(e));
    return () => {
      live = false;
    };
  }, [...deps, version]);
  useEffect(() => {
    const again = () => setVersion((v) => v + 1);
    window.addEventListener('online', again);
    window.addEventListener('focus', again);
    return () => {
      window.removeEventListener('online', again);
      window.removeEventListener('focus', again);
    };
  }, []);
  return { data, error, reload: () => setVersion((v) => v + 1) };
}
