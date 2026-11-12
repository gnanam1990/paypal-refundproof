import { parseMoney } from '../domain/money';
import type { OutboundRefundRequest } from '../domain/outbound';
import type { CaptureFacts, CaptureSource, CaptureSourceLabel } from '../services/captures';

/**
 * PayPal REST client, sandbox only. Endpoints and semantics are the ones verified from PayPal's OpenAPI documents
 * (docs/decisions/0001-stack-and-provider-contract.md); no other provider capability is assumed. Credentials
 * live only in this process and are never logged or returned. Every call has a deadline.
 */
export const PAYPAL_SANDBOX_BASE = 'https://api-m.sandbox.paypal.com';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface PayPalClientOptions {
  clientId: string;
  clientSecret: string;
  /** Overrides only for tests (a labelled contract stub). Production and live hosts are refused. */
  baseUrl?: string;
  fetch?: FetchLike;
  source?: CaptureSourceLabel;
  deadlineMs?: number;
}

/** The outcome of one refund request as seen by the client: either PayPal answered, or we cannot know. */
export type RefundExchange =
  | { kind: 'ANSWERED'; httpStatus: number; debugId: string | null; body: unknown }
  | { kind: 'UNKNOWN'; errorClass: string };

export interface OrderRefund {
  id: string;
  status: string;
  invoiceId: string | null;
  customId: string | null;
  amount: { currency: string; value: string } | null;
}

export class PayPalUnavailableError extends Error {
  override readonly name = 'PayPalUnavailableError';
}

export function assertSandboxBase(url: string) {
  const u = new URL(url);
  if (/(^|\.)paypal\.com$/.test(u.hostname) && u.hostname !== 'api-m.sandbox.paypal.com') {
    throw new Error('refundproof: only the PayPal sandbox API is supported');
  }
}

export class PayPalClient implements CaptureSource {
  readonly label: CaptureSourceLabel;
  private readonly base: string;
  private readonly fetchImpl: FetchLike;
  private readonly deadlineMs: number;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly o: PayPalClientOptions) {
    this.base = o.baseUrl ?? PAYPAL_SANDBOX_BASE;
    assertSandboxBase(this.base);
    this.fetchImpl = o.fetch ?? ((u, i) => fetch(u, i));
    this.label = o.source ?? 'PAYPAL_SANDBOX';
    this.deadlineMs = o.deadlineMs ?? 20_000;
  }

  private async accessToken(force = false): Promise<string> {
    if (!force && this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const res = await this.fetchImpl(`${this.base}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${this.o.clientId}:${this.o.clientSecret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(this.deadlineMs),
    });
    if (!res.ok) throw new PayPalUnavailableError(`PayPal token request failed (${res.status})`);
    const j = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!j.access_token) throw new PayPalUnavailableError('PayPal token response had no access token');
    this.token = { value: j.access_token, expiresAt: Date.now() + (j.expires_in ?? 300) * 1000 };
    return this.token.value;
  }

  /** Obtains a token before any attempt is recorded, so an authentication failure never leaves an attempt behind. */
  async prepare(): Promise<void> {
    try {
      await this.accessToken();
    } catch (e) {
      throw new PayPalUnavailableError(e instanceof Error ? e.message : 'PayPal token unavailable');
    }
  }

  private async get(path: string): Promise<{ status: number; body: unknown; debugId: string | null }> {
    let token = await this.accessToken();
    for (let i = 0; i < 2; i++) {
      const res = await this.fetchImpl(`${this.base}${path}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(this.deadlineMs),
      });
      if (res.status === 401 && i === 0) {
        token = await this.accessToken(true);
        continue;
      }
      const text = await res.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      return { status: res.status, body, debugId: res.headers.get('paypal-debug-id') };
    }
    throw new PayPalUnavailableError('PayPal rejected the refreshed token');
  }

  /** GET /v2/payments/captures/{id}: the capture source for proposals and approvals. */
  async getCapture(captureId: string): Promise<CaptureFacts | null> {
    const r = await this.get(`/v2/payments/captures/${encodeURIComponent(captureId)}`);
    if (r.status === 404) return null;
    if (r.status !== 200) throw new PayPalUnavailableError(`PayPal capture lookup failed (${r.status})`);
    const b = r.body as {
      id: string;
      status: string;
      amount: { currency_code: string; value: string };
      invoice_id?: string;
      supplementary_data?: { related_ids?: { order_id?: string } };
      payee?: { merchant_id?: string };
    };
    return {
      captureId: b.id,
      status: b.status,
      amount: parseMoney(b.amount.value, b.amount.currency_code),
      orderId: b.supplementary_data?.related_ids?.order_id ?? null,
      payeeMerchantId: b.payee?.merchant_id ?? null,
      invoiceId: b.invoice_id ?? null,
    };
  }

  /**
   * POST /v2/payments/captures/{id}/refund with the frozen outbound request and its PayPal-Request-Id. Any
   * failure to obtain a parseable answer is UNKNOWN: the request may have reached PayPal.
   */
  async refund(req: OutboundRefundRequest): Promise<RefundExchange> {
    let token: string;
    try {
      token = await this.accessToken();
    } catch (e) {
      throw new PayPalUnavailableError(e instanceof Error ? e.message : 'PayPal token unavailable');
    }
    try {
      const res = await this.fetchImpl(
        `${this.base}/v2/payments/captures/${encodeURIComponent(req.captureId)}/refund`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            'PayPal-Request-Id': req.headers['PayPal-Request-Id'],
            Prefer: req.headers.Prefer,
          },
          body: JSON.stringify(req.body),
          signal: AbortSignal.timeout(this.deadlineMs),
        },
      );
      if (res.status === 401) this.token = null; // rejected before processing; the next attempt re-authenticates
      const text = await res.text();
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        return { kind: 'UNKNOWN', errorClass: `UNPARSEABLE_${res.status}` };
      }
      return { kind: 'ANSWERED', httpStatus: res.status, debugId: res.headers.get('paypal-debug-id'), body };
    } catch (e) {
      return { kind: 'UNKNOWN', errorClass: e instanceof Error ? e.name : 'Error' };
    }
  }

  /** GET /v2/checkout/orders/{id}: refunds carry invoice_id/custom_id, the reconciliation match keys. */
  async orderRefunds(
    orderId: string,
  ): Promise<{ status: number; debugId: string | null; refunds: OrderRefund[] }> {
    const r = await this.get(`/v2/checkout/orders/${encodeURIComponent(orderId)}`);
    if (r.status !== 200) return { status: r.status, debugId: r.debugId, refunds: [] };
    const units = ((r.body as { purchase_units?: unknown[] })?.purchase_units ?? []) as Array<{
      payments?: { refunds?: Array<Record<string, unknown>> };
    }>;
    const refunds = units
      .flatMap((u) => u.payments?.refunds ?? [])
      .map((x) => ({
        id: String(x.id),
        status: String(x.status),
        invoiceId: (x.invoice_id as string | undefined) ?? null,
        customId: (x.custom_id as string | undefined) ?? null,
        amount: x.amount
          ? {
              currency: (x.amount as { currency_code: string }).currency_code,
              value: (x.amount as { value: string }).value,
            }
          : null,
      }));
    return { status: r.status, debugId: r.debugId, refunds };
  }

  /** GET /v2/payments/refunds/{id}. */
  async getRefund(refundId: string) {
    const r = await this.get(`/v2/payments/refunds/${encodeURIComponent(refundId)}`);
    return { status: r.status, debugId: r.debugId, body: r.body as Record<string, unknown> | null };
  }
}
