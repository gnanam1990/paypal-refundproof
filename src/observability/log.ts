/**
 * Structured JSON-line logging with key-based redaction. Only declared fields are emitted; anything whose key
 * looks sensitive is replaced, and string values are scrubbed of bearer/basic credentials.
 */
const SENSITIVE_KEY =
  /pass|secret|token|authorization|cookie|api[-_]?key|credential|card|email|original|text$/i;
const CREDENTIAL_VALUE = /(Bearer|Basic)\s+[A-Za-z0-9+/=._-]+/g;

export function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (typeof value === 'string') return value.replace(CREDENTIAL_VALUE, '$1 [REDACTED]').slice(0, 2_000);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrub(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value))
      out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : scrub(v, depth + 1);
    return out;
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  log(level: LogLevel, event: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export function createLogger(
  base: Record<string, unknown> = {},
  sink: (line: string) => void = (l) => process.stdout.write(`${l}\n`),
): Logger {
  return {
    log(level, event, fields = {}) {
      if (level === 'debug' && !process.env.REFUNDPROOF_DEBUG) return;
      sink(
        JSON.stringify({
          ts: new Date().toISOString(),
          level,
          event,
          ...(scrub({ ...base, ...fields }) as object),
        }),
      );
    },
    child(fields) {
      return createLogger({ ...base, ...fields }, sink);
    },
  };
}

export const rootLogger = createLogger({ service: 'refundproof' });
