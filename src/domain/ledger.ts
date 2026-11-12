import type { ApprovedRevisionRef, OperationIdentity, ProviderAttemptPlan } from './identity';

/**
 * Contract every durable operation store implements. ensureOperation is idempotent per approved revision;
 * the same revision id presented with a different tenant or digest is a conflict, never a silent reuse.
 * appendAttempt allocates the next attempt number under the operation's immutable request id.
 */
export interface OperationLedger {
  ensureOperation(ref: ApprovedRevisionRef): Promise<{ identity: OperationIdentity; created: boolean }>;
  appendAttempt(operationId: string): Promise<ProviderAttemptPlan>;
  listOperations(): Promise<OperationIdentity[]>;
  listAttempts(): Promise<ProviderAttemptPlan[]>;
}

export class OperationConflictError extends Error {
  override readonly name = 'OperationConflictError';
}
