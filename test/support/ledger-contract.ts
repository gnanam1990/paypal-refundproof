import type fc from 'fast-check';
import type { ApprovedRevisionRef, OperationIdentity } from '../../src/domain/identity';
import type { OperationLedger } from '../../src/domain/ledger';

export interface RaceResult {
  operations: OperationIdentity[];
  createdCount: number;
  attemptRequestIds: string[];
  attemptNumbers: number[];
}

/** N workers concurrently ensure the operation for one approved revision and each records one attempt. */
export async function runLedgerRace(
  ledger: OperationLedger,
  ref: ApprovedRevisionRef,
  workers: number,
  scheduler?: fc.Scheduler,
): Promise<RaceResult> {
  const work = Array.from({ length: workers }, async () => {
    const { identity, created } = await ledger.ensureOperation(ref);
    const attempt = await ledger.appendAttempt(identity.operationId);
    return { created, attempt };
  });
  const settled = scheduler ? await scheduler.waitFor(Promise.all(work)) : await Promise.all(work);
  const attempts = await ledger.listAttempts();
  return {
    operations: await ledger.listOperations(),
    createdCount: settled.filter((x) => x.created).length,
    attemptRequestIds: attempts.map((a) => a.paypalRequestId),
    attemptNumbers: attempts.map((a) => a.attemptNo).sort((a, b) => a - b),
  };
}
