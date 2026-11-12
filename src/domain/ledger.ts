import type { ApprovedRevisionRef, OperationIdentity, ProviderAttemptPlan } from './identity';

/**
 * Contract every durable operation store implements. ensureOperation is idempotent per approved revision;
 * appendAttempt allocates the next attempt number under the operation's immutable request id.
 */
export interface OperationLedger {
  ensureOperation(ref: ApprovedRevisionRef): Promise<{ identity: OperationIdentity; created: boolean }>;
  appendAttempt(operationId: string): Promise<ProviderAttemptPlan>;
  listOperations(): Promise<OperationIdentity[]>;
  listAttempts(): Promise<ProviderAttemptPlan[]>;
}
