export const PROPOSAL_STATES = [
  'DRAFT',
  'REVIEWABLE',
  'APPROVED',
  'REJECTED',
  'EXPIRED',
  'SUPERSEDED',
] as const;
export type ProposalState = (typeof PROPOSAL_STATES)[number];

/**
 * Proposal: DRAFT -> REVIEWABLE -> APPROVED | REJECTED | EXPIRED. Any edit creates a new DRAFT revision and
 * supersedes the old one. An APPROVED revision can be revoked (REJECTED) or lapse (EXPIRED) only while its
 * operation has not been dispatched; that rule is enforced where the operation is known.
 */
export const PROPOSAL_TRANSITIONS: Readonly<Record<ProposalState, readonly ProposalState[]>> = Object.freeze({
  DRAFT: ['REVIEWABLE', 'SUPERSEDED'],
  REVIEWABLE: ['APPROVED', 'REJECTED', 'EXPIRED', 'SUPERSEDED'],
  APPROVED: ['REJECTED', 'EXPIRED'],
  REJECTED: [],
  EXPIRED: [],
  SUPERSEDED: [],
});

export const OPERATION_STATES = [
  'READY',
  'SUBMITTING',
  'CONFIRMED',
  'OUTCOME_UNKNOWN',
  'RECONCILING',
  'PROVIDER_TERMINAL_NOT_APPLIED',
  'EXHAUSTED',
  'CANCELLED_BEFORE_DISPATCH',
] as const;
export type OperationState = (typeof OPERATION_STATES)[number];

/**
 * Operation: READY -> SUBMITTING -> CONFIRMED | OUTCOME_UNKNOWN -> RECONCILING -> CONFIRMED |
 * PROVIDER_TERMINAL_NOT_APPLIED | EXHAUSTED.
 * - SUBMITTING -> READY only when the attempt is durably recorded NOT_SENT (no byte left the process).
 * - SUBMITTING -> RECONCILING when PayPal answered with a PENDING refund (applied, not yet final).
 * - CANCELLED_BEFORE_DISPATCH carries NEVER_DISPATCHED evidence; it is not a provider state.
 * - OUTCOME_UNKNOWN has exactly one exit (RECONCILING): no blind retry, no automatic failure.
 * - EXHAUSTED may only resume read-only reconciliation.
 */
export const OPERATION_TRANSITIONS: Readonly<Record<OperationState, readonly OperationState[]>> =
  Object.freeze({
    READY: ['SUBMITTING', 'CANCELLED_BEFORE_DISPATCH'],
    SUBMITTING: [
      'CONFIRMED',
      'OUTCOME_UNKNOWN',
      'RECONCILING',
      'PROVIDER_TERMINAL_NOT_APPLIED',
      'READY',
      'CANCELLED_BEFORE_DISPATCH',
    ],
    OUTCOME_UNKNOWN: ['RECONCILING'],
    RECONCILING: ['CONFIRMED', 'PROVIDER_TERMINAL_NOT_APPLIED', 'EXHAUSTED'],
    EXHAUSTED: ['RECONCILING'],
    CONFIRMED: [],
    PROVIDER_TERMINAL_NOT_APPLIED: [],
    CANCELLED_BEFORE_DISPATCH: [],
  });

/**
 * Edges that assert something about the outside world must name the durable evidence that justifies them
 * (INV-03). The caller is responsible for having persisted that evidence in the same transaction.
 */
export type TransitionEvidence =
  | 'NOT_SENT'
  | 'NEVER_DISPATCHED'
  | 'PROVIDER_TERMINAL_OBSERVATION'
  | 'PROVIDER_CONFIRMED_OBSERVATION'
  | 'PROVIDER_PENDING_OBSERVATION';

export const OPERATION_EDGE_EVIDENCE: Readonly<
  Partial<Record<`${OperationState}->${OperationState}`, TransitionEvidence>>
> = Object.freeze({
  'SUBMITTING->READY': 'NOT_SENT',
  'READY->CANCELLED_BEFORE_DISPATCH': 'NEVER_DISPATCHED',
  'SUBMITTING->CANCELLED_BEFORE_DISPATCH': 'NEVER_DISPATCHED',
  'SUBMITTING->PROVIDER_TERMINAL_NOT_APPLIED': 'PROVIDER_TERMINAL_OBSERVATION',
  'RECONCILING->PROVIDER_TERMINAL_NOT_APPLIED': 'PROVIDER_TERMINAL_OBSERVATION',
  'SUBMITTING->CONFIRMED': 'PROVIDER_CONFIRMED_OBSERVATION',
  'RECONCILING->CONFIRMED': 'PROVIDER_CONFIRMED_OBSERVATION',
  'SUBMITTING->RECONCILING': 'PROVIDER_PENDING_OBSERVATION',
});

export class InvalidTransitionError extends Error {
  override readonly name = 'InvalidTransitionError';
  constructor(
    readonly machine: 'proposal' | 'operation',
    readonly from: string,
    readonly to: string,
  ) {
    super(`invalid ${machine} transition ${from} -> ${to}`);
  }
}

function check<S extends string>(
  machine: 'proposal' | 'operation',
  table: Record<S, readonly S[]>,
  from: S,
  to: S,
) {
  const allowed = Object.prototype.hasOwnProperty.call(table, from) ? table[from] : undefined;
  if (!allowed || !allowed.includes(to)) throw new InvalidTransitionError(machine, from, to);
}

export const assertProposalTransition = (from: ProposalState, to: ProposalState) =>
  check('proposal', PROPOSAL_TRANSITIONS, from, to);
export function assertOperationTransition(
  from: OperationState,
  to: OperationState,
  evidence?: TransitionEvidence,
) {
  check('operation', OPERATION_TRANSITIONS, from, to);
  const required = OPERATION_EDGE_EVIDENCE[`${from}->${to}`];
  if (required !== evidence)
    throw new InvalidTransitionError('operation', from, `${to} (evidence ${evidence ?? 'none'})`);
}

export const isTerminalOperationState = (s: OperationState) => OPERATION_TRANSITIONS[s].length === 0;

/** States in which PayPal may hold (or be about to hold) an effect for this operation. */
export const EFFECT_POSSIBLE_STATES: readonly OperationState[] = [
  'READY',
  'SUBMITTING',
  'OUTCOME_UNKNOWN',
  'RECONCILING',
  'EXHAUSTED',
  'CONFIRMED',
];

/**
 * FR-05 gate: a later provider operation for the same case is allowed only when every prior operation either
 * has durable NEVER_DISPATCHED evidence or a documented terminal PayPal non-application observation.
 */
export function allowsNewProviderOperation(
  prior: ReadonlyArray<{ state: OperationState; neverDispatched: boolean }>,
): boolean {
  return prior.every(
    (p) =>
      p.state === 'PROVIDER_TERMINAL_NOT_APPLIED' ||
      (p.state === 'CANCELLED_BEFORE_DISPATCH' && p.neverDispatched),
  );
}
