import { PayPalClient } from './client';

/**
 * Builds the PayPal client from server-only environment variables, or returns null (BLOCKED_CREDENTIAL). Only the
 * sandbox is supported: PAYPAL_ENV must be 'sandbox'; anything else (including live) is refused.
 */
export function paypalFromEnv(env: NodeJS.ProcessEnv = process.env): PayPalClient | null {
  const id = env.PAYPAL_CLIENT_ID;
  const secret = env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) return null;
  if ((env.PAYPAL_ENV ?? 'sandbox') !== 'sandbox') {
    throw new Error('refundproof: PAYPAL_ENV must be sandbox; live PayPal is not supported');
  }
  return new PayPalClient({ clientId: id, clientSecret: secret });
}
