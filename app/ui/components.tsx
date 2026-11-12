'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError, errorText } from './api';

/* One SVG icon family (24px grid, 2px stroke) so status is never conveyed by colour alone. */
const PATHS: Record<string, ReactNode> = {
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  alert: (
    <>
      <path d="M12 3.5l9 16H3z" />
      <path d="M12 10v4.5M12 17.5v.01" />
    </>
  ),
  stop: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.5 8.5l7 7M15.5 8.5l-7 7" />
    </>
  ),
  dot: <circle cx="12" cy="12" r="4" />,
  doc: (
    <>
      <path d="M7 3.5h7l4 4v13H7z" />
      <path d="M14 3.5v4h4M9.5 12h6M9.5 15.5h6" />
    </>
  ),
  shield: <path d="M12 3.5l7.5 3v5.5c0 4.5-3.2 7.8-7.5 9-4.3-1.2-7.5-4.5-7.5-9V6.5z" />,
  pulse: <path d="M3 12h4l2.5-6 5 12 2.5-6h4" />,
  inbox: (
    <>
      <path d="M3.5 13.5l2.5-8h12l2.5 8v5h-17z" />
      <path d="M3.5 13.5h5l1 2.5h5l1-2.5h5" />
    </>
  ),
};

export function Icon({ name, label }: { name: keyof typeof PATHS; label?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      width="18"
      height="18"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {PATHS[name]}
    </svg>
  );
}

type Tone = 'ok' | 'warn' | 'bad' | 'neutral';
const STATE_TONE: Record<string, [Tone, keyof typeof PATHS, string]> = {
  CONFIRMED: ['ok', 'check', 'Refund confirmed by PayPal'],
  OUTCOME_UNKNOWN: ['warn', 'clock', 'Outcome unknown'],
  RECONCILING: ['warn', 'clock', 'Reconciling with PayPal'],
  EXHAUSTED: ['bad', 'alert', 'Reconciliation exhausted'],
  PROVIDER_TERMINAL_NOT_APPLIED: ['neutral', 'stop', 'PayPal did not apply the refund'],
  CANCELLED_BEFORE_DISPATCH: ['neutral', 'stop', 'Cancelled before sending'],
  READY: ['neutral', 'dot', 'Ready to send'],
  SUBMITTING: ['warn', 'clock', 'Sending to PayPal'],
  DRAFT: ['neutral', 'doc', 'Draft'],
  REVIEWABLE: ['warn', 'clock', 'Waiting for approval'],
  APPROVED: ['ok', 'shield', 'Approved'],
  REJECTED: ['bad', 'stop', 'Rejected'],
  EXPIRED: ['bad', 'clock', 'Approval expired'],
  SUPERSEDED: ['neutral', 'dot', 'Superseded'],
  BLOCKED: ['bad', 'stop', 'Blocked'],
};

/** Status badge: icon + words + colour. Green is reserved for provider-confirmed completion and approvals. */
export function Status({ state, label }: { state: string; label?: string }) {
  const [tone, icon, words] = STATE_TONE[state] ?? (['neutral', 'dot', state] as const);
  return (
    <span className={`status ${tone}`}>
      <Icon name={icon} />
      {label ?? words}
    </span>
  );
}

/** A sha256 digest in 8-character groups so people can compare it at a glance. */
export function Digest({ value, label = 'Digest' }: { value: string; label?: string }) {
  const groups = value.match(/.{1,8}/g) ?? [value];
  return (
    <span className="digest" aria-label={`${label} ${value}`} title={value}>
      {groups.map((g, i) => (
        <span key={i} aria-hidden="true">
          {g}
        </span>
      ))}
    </span>
  );
}

export const Mono = ({ children }: { children: ReactNode }) => <code>{children}</code>;

export function ErrorSummary({ error }: { error: unknown }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) ref.current?.focus();
  }, [error]);
  if (!error) return null;
  const details = error instanceof ApiError ? error.details : undefined;
  return (
    <div className="error-summary" role="alert" tabIndex={-1} ref={ref}>
      <h3>
        {error instanceof ApiError && error.status === 403
          ? 'You do not have permission for this'
          : error instanceof ApiError && error.status === 503
            ? 'Not available in this environment'
            : 'This did not go through'}
      </h3>
      <p>{errorText(error)}</p>
      {details && typeof details === 'object' && 'correctionReasons' in (details as object) ? (
        <ul>
          {((details as { correctionReasons: string[] }).correctionReasons ?? []).map((r) => (
            <li key={r}>
              <code>{r}</code>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function Skeleton({ lines = 3, block = false }: { lines?: number; block?: boolean }) {
  if (block) return <div className="skeleton block" aria-hidden="true" />;
  return (
    <div className="stack" aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skeleton" style={{ width: `${90 - i * 12}%` }} />
      ))}
    </div>
  );
}

/** Polite live region: announces state changes that arrive from the server. */
export function useAnnouncer() {
  const [msg, setMsg] = useState('');
  const node = (
    <p className="sr-only" role="status" aria-live="polite">
      {msg}
    </p>
  );
  return { announce: setMsg, node };
}

/** Confirmation for destructive or irreversible actions, naming the exact bound revision. */
export function ConfirmButton({
  children,
  title,
  body,
  confirmLabel,
  onConfirm,
  tone = 'primary',
  disabled,
}: {
  children: ReactNode;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  onConfirm: () => Promise<void> | void;
  tone?: 'primary' | 'danger';
  disabled?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <button
        type="button"
        className={tone === 'danger' ? 'danger' : undefined}
        disabled={disabled}
        onClick={() => ref.current?.showModal()}
      >
        {children}
      </button>
      <dialog ref={ref} aria-labelledby={`${confirmLabel}-title`}>
        <h2 id={`${confirmLabel}-title`}>{title}</h2>
        <div className="stack">{body}</div>
        <div className="row" style={{ marginTop: '1rem', justifyContent: 'flex-end' }}>
          <button type="button" className="secondary" onClick={() => ref.current?.close()}>
            Keep it as is
          </button>
          <button
            type="button"
            className={tone === 'danger' ? 'danger' : undefined}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
              } finally {
                setBusy(false);
                ref.current?.close();
              }
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </dialog>
    </>
  );
}

export const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';

export function amountText(a: {
  kind: string;
  amount?: { currency: string; value: string };
  captureAmount?: { currency: string; value: string };
}) {
  if (a.kind === 'EXACT' && a.amount) return `${a.amount.value} ${a.amount.currency}`;
  if (a.kind === 'FULL' && a.captureAmount)
    return `Full remaining capture (${a.captureAmount.value} ${a.captureAmount.currency})`;
  return '—';
}

export const REASONS: Record<string, string> = {
  DUPLICATE_CHARGE: 'Duplicate charge',
  ITEM_NOT_RECEIVED: 'Item not received',
  ITEM_DEFECTIVE: 'Item defective',
  NOT_AS_DESCRIBED: 'Not as described',
  SERVICE_NOT_RENDERED: 'Service not rendered',
  GOODWILL: 'Goodwill',
  OTHER: 'Other',
};
