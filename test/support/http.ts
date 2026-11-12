import type { ApiContext } from '../../src/http/context';
import { createApi } from '../../src/http/router';

export const ORIGIN = 'http://refundproof.test';

/** Drives the real API router with web-standard Requests, carrying the session cookie like a browser. */
export class TestClient {
  cookie = '';
  csrf = '';
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
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0]!.endsWith('=') ? '' : set.split(';')[0]!;
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
