import { describe, expect, it } from 'vitest';
import {
  InvalidTransitionError,
  OPERATION_STATES,
  OPERATION_TRANSITIONS,
  PROPOSAL_STATES,
  allowsNewProviderOperation,
  assertOperationTransition,
  assertProposalTransition,
  isTerminalOperationState,
  type OperationState,
} from '../../src/domain/states';

describe('proposal state machine', () => {
  it('accepts the documented path and supersession', () => {
    expect(() => assertProposalTransition('DRAFT', 'REVIEWABLE')).not.toThrow();
    expect(() => assertProposalTransition('REVIEWABLE', 'APPROVED')).not.toThrow();
    expect(() => assertProposalTransition('REVIEWABLE', 'SUPERSEDED')).not.toThrow();
  });

  it.each([
    ['DRAFT', 'APPROVED'],
    ['REJECTED', 'APPROVED'],
    ['EXPIRED', 'APPROVED'],
    ['SUPERSEDED', 'REVIEWABLE'],
    ['APPROVED', 'DRAFT'],
    ['APPROVED', 'REVIEWABLE'],
  ] as const)('rejects %s -> %s', (from, to) => {
    expect(() => assertProposalTransition(from, to)).toThrow(InvalidTransitionError);
  });

  it('lists every state', () => {
    expect([...PROPOSAL_STATES].sort()).toEqual(
      ['APPROVED', 'DRAFT', 'EXPIRED', 'REJECTED', 'REVIEWABLE', 'SUPERSEDED'].sort(),
    );
  });
});

describe('operation state machine', () => {
  it('never lets an unknown outcome become a failure, a retry, or a cancellation directly', () => {
    for (const to of [
      'READY',
      'SUBMITTING',
      'PROVIDER_TERMINAL_NOT_APPLIED',
      'CANCELLED_BEFORE_DISPATCH',
      'CONFIRMED',
      'EXHAUSTED',
    ] as const) {
      expect(() => assertOperationTransition('OUTCOME_UNKNOWN', to)).toThrow(InvalidTransitionError);
    }
    expect(() => assertOperationTransition('OUTCOME_UNKNOWN', 'RECONCILING')).not.toThrow();
  });

  it('exhausted reconciliation can only resume read-only reconciliation', () => {
    expect(OPERATION_TRANSITIONS.EXHAUSTED).toEqual(['RECONCILING']);
  });

  it('cancellation-before-dispatch is reachable only before any send', () => {
    expect(() => assertOperationTransition('READY', 'CANCELLED_BEFORE_DISPATCH')).not.toThrow();
    for (const from of ['OUTCOME_UNKNOWN', 'RECONCILING', 'EXHAUSTED', 'CONFIRMED'] as const) {
      expect(() => assertOperationTransition(from, 'CANCELLED_BEFORE_DISPATCH')).toThrow(
        InvalidTransitionError,
      );
    }
  });

  it('terminal states have no outgoing transitions', () => {
    for (const s of OPERATION_STATES) {
      if (isTerminalOperationState(s)) expect(OPERATION_TRANSITIONS[s]).toEqual([]);
    }
    expect(OPERATION_STATES.filter(isTerminalOperationState).sort()).toEqual(
      ['CANCELLED_BEFORE_DISPATCH', 'CONFIRMED', 'PROVIDER_TERMINAL_NOT_APPLIED'].sort(),
    );
  });

  it('rejects unknown state names', () => {
    expect(() => assertOperationTransition('READY' as OperationState, 'DONE' as OperationState)).toThrow(
      InvalidTransitionError,
    );
  });
});

describe('new provider operation gate (FR-05)', () => {
  it('allows only after durable never-dispatched evidence or terminal non-application', () => {
    expect(allowsNewProviderOperation([])).toBe(true);
    expect(
      allowsNewProviderOperation([{ state: 'PROVIDER_TERMINAL_NOT_APPLIED', neverDispatched: false }]),
    ).toBe(true);
    expect(allowsNewProviderOperation([{ state: 'CANCELLED_BEFORE_DISPATCH', neverDispatched: true }])).toBe(
      true,
    );
  });

  it.each(['READY', 'SUBMITTING', 'OUTCOME_UNKNOWN', 'RECONCILING', 'EXHAUSTED', 'CONFIRMED'] as const)(
    'blocks while a prior operation is %s',
    (state) => {
      expect(allowsNewProviderOperation([{ state, neverDispatched: false }])).toBe(false);
    },
  );

  it('blocks a cancellation that lacks never-dispatched evidence', () => {
    expect(allowsNewProviderOperation([{ state: 'CANCELLED_BEFORE_DISPATCH', neverDispatched: false }])).toBe(
      false,
    );
  });
});
