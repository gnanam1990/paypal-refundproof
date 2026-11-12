import type fc from 'fast-check';
import {
  deriveOperationIdentity,
  planAttempt,
  type OperationIdentity,
  type ProviderAttemptPlan,
} from '../../src/domain/identity';
import { OperationConflictError, type OperationLedger } from '../../src/domain/ledger';

/**
 * Test-only reference model of the durable ledger. The scheduler interleaves the read/insert steps so the
 * property test explores races; atomicity comes only from the keyed insert (the model of a unique index).
 */
export class MemoryOperationLedger implements OperationLedger {
  private readonly ops = new Map<string, OperationIdentity>();
  private readonly refs = new Map<string, string>();
  private readonly attempts: ProviderAttemptPlan[] = [];
  constructor(private readonly s?: fc.Scheduler) {}

  private async yieldPoint(label: string) {
    if (this.s) await this.s.schedule(Promise.resolve(label));
  }

  async ensureOperation(ref: Parameters<OperationLedger['ensureOperation']>[0]) {
    const identity = deriveOperationIdentity(ref);
    await this.yieldPoint('read');
    const existing = this.ops.get(ref.revisionId);
    await this.yieldPoint('insert');
    const key = `${ref.tenantId}\n${ref.revisionDigest}`;
    if (existing || this.ops.has(ref.revisionId)) {
      if (this.refs.get(ref.revisionId) !== key)
        throw new OperationConflictError('revision id reused for another intent');
      return { identity: this.ops.get(ref.revisionId)!, created: false };
    }
    // Atomic keyed insert: the model of the database unique index on approved_revision_id.
    this.ops.set(ref.revisionId, identity);
    this.refs.set(ref.revisionId, key);
    return { identity, created: true };
  }

  async appendAttempt(operationId: string) {
    await this.yieldPoint('attempt');
    const identity = [...this.ops.values()].find((o) => o.operationId === operationId);
    if (!identity) throw new Error('unknown operation');
    const prior = this.attempts.filter((a) => a.operationId === operationId).length;
    const plan = planAttempt(identity, prior);
    this.attempts.push(plan);
    return plan;
  }

  async listOperations() {
    return [...this.ops.values()];
  }

  async listAttempts() {
    return [...this.attempts];
  }
}
