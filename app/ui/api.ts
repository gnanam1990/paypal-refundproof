'use client';

/** Thin client for the RefundProof control API. Every state the UI shows comes from these durable records. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export class OfflineError extends Error {
  constructor() {
    super('The console cannot reach the server. Check your connection; nothing was changed.');
  }
}

let csrf = '';
export const setCsrf = (t: string) => {
  csrf = t;
};

export async function api<T = Record<string, unknown>>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(method !== 'GET' && csrf ? { 'x-csrf-token': csrf } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    throw new OfflineError();
  }
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(res.status, 'BAD_RESPONSE', 'The server returned an unreadable response.');
  }
  if (!res.ok) {
    const e = (json.error ?? {}) as { code?: string; message?: string; details?: unknown };
    if (res.status === 401 && typeof window !== 'undefined' && !path.startsWith('/api/auth/')) {
      window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}`);
    }
    throw new ApiError(
      res.status,
      e.code ?? 'ERROR',
      e.message ?? `Request failed (${res.status})`,
      e.details,
    );
  }
  return json as T;
}

export const errorText = (e: unknown) =>
  e instanceof ApiError || e instanceof OfflineError || e instanceof Error
    ? e.message
    : 'Something went wrong.';
