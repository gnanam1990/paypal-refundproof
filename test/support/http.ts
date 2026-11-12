import type { ApiContext } from '../../src/http/context';
import { createApi } from '../../src/http/router';

export const ORIGIN = 'http://refundproof.test';

/** Drives the real API router with web-standard Requests, carrying the session cookie like a browser. */
export class TestClient {
  /** Cookie jar keyed by name; a Set-Cookie with an empty value (or Max-Age=0) removes the entry. */
  readonly jar = new Map<string, string>();
  csrf = '';
  get cookie(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  set cookie(header: string) {
    this.jar.clear();
    for (const part of header.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k) this.jar.set(k, v.join('='));
    }
  }
  readonly handle: (r: Request) => Promise<Response>;
  constructor(ctx: ApiContext) {
    this.handle = createApi(ctx);
  }

  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { origin: ORIGIN, ...headers };
    if (this.cookie) h.cookie = this.cookie;
    if (this.csrf && method !== 'GET') h['x-csrf-token'] = this.csrf;
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await this.handle(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers: h,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    for (const set of res.headers.getSetCookie()) {
      const [pair, ...attrs] = set.split(';');
      const [k, ...v] = pair!.trim().split('=');
      const value = v.join('=');
      const expired = attrs.some((a) => a.trim().toLowerCase() === 'max-age=0');
      if (!value || expired) this.jar.delete(k!);
      else this.jar.set(k!, value);
    }
    const text = await res.text();
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    return {
      status: res.status,
      json: json as Record<string, unknown> & { [k: string]: any },
      headers: res.headers,
    };
  }

  async login(email: string, password: string) {
    const r = await this.req('POST', '/api/auth/login', { email, password });
    if (r.status === 200) this.csrf = String(r.json.csrfToken);
    return r;
  }
}
