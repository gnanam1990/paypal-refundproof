# DR-0004: M01 corrective, database and lease integrity

Date: 2026-11-12. Status: ACCEPTED.

An independent review of PR #4 at `c808bb9` reproduced three blockers. Each one is fixed by its own forward
migration. `0001_core` is unchanged, because it is already applied to existing databases and its checksum is
enforced. Red runs, mutation results and upgrade evidence are in `docs/evidence/M01-corrective/`.

## 0002 attempt finality (Blocker 1)

**Defect.** The 0001 guard froze an attempt's phase only after it had left `DISPATCHING`. So a `DISPATCHING`
attempt could be rewritten as `NOT_SENT`, after which `SUBMITTING -> READY` succeeded and a second dispatch could
begin.

**Rules.**

- Attempts are created `DISPATCHING`. They may be created `NOT_SENT` only while no attempt of the operation has
  begun dispatch. A `NOT_SENT` attempt is final from birth: its finish time is set and it carries no response.
- `DISPATCHING` changes only by reaching `RESPONDED` or `LOST`. It can never become `NOT_SENT`, and it cannot be
  edited in place.
- `RESPONDED`, `LOST` and `NOT_SENT` rows are frozen. Identity and `request_meta` (what was sent) never change.
- The `provider_attempts_coherent_outcome` check pins the evidence tuple for each phase:

  | Phase | Required evidence |
  | --- | --- |
  | `DISPATCHING` | No finish time, no status, no error, empty response |
  | `RESPONDED` | Finished, HTTP status 100–599 |
  | `LOST` | Finished, no status, error class present |
  | `NOT_SENT` | Finished, no status, empty response |

  In every phase, `finished_at >= started_at`.
- Inserting an attempt locks the operation row. This serialises a `NOT_SENT` insert against an in-flight
  `DISPATCHING` insert, and both against `SUBMITTING -> READY`.

**Upgrade.** 0001 wrote `NOT_SENT` rows without a finish time. They are backfilled with
`finished_at = started_at`, the only honest value. No other row is rewritten: an incoherent legacy row makes the
migration fail and roll back.

**Not changed.** Attempts may still be recorded while the operation is `READY`. The T-005 ledger contract does
this, and both exits that need "never dispatched" (`SUBMITTING -> READY` and cancellation) still refuse any
non-`NOT_SENT` attempt. Gating dispatch on `SUBMITTING` belongs to the M04 dispatcher.

## 0003 lease fencing (Blocker 2)

**Defect.** Lease predicates matched only job id, owner and `RUNNING`. Suppose a worker reclaimed an expired job
under the same configured owner string. Its stale claim was then indistinguishable from the live one, and an
expired but unreclaimed lease could still be renewed or completed.

**Rules.**

- Every claim increments `outbox_jobs.lease_token` (the fence) and returns it as `Job.fence`. A trigger refuses
  any decrease.
- `renewLease`, `completeJob`, `failJob` and `rescheduleJob` all match `id + owner + fence`, `RUNNING`, and
  `lease_expires_at > clock_timestamp()` (the database clock, read at statement time).
- A handler writes its effect in the same transaction as a fenced close, which locks the job row first.
  `selftestHandler` completes first and then appends its audit row. A stale or duplicate run therefore writes no
  effect.
- **Retries after a lost response.**
  - `closed_token` and `closed_action` record which claim closed the job, and how.
  - A retried close from that same claim and action is acknowledged once: `completeJob` returns
    `ALREADY_COMPLETED`, and the handler must not repeat its effect.
  - Every other late call throws `LeaseLostError`, including a different action from the same claim and any
    action from an older claim.

**Upgrade.** Existing jobs get fence `0`. A lease that was in flight at upgrade time expires, and its next claim
receives fence `1`. A holder of the old fence-0 claim is then stale.

## 0004 tenant-bound evidence (Blocker 3)

**Defect.** `provider_observations` had separate foreign keys on `tenant_id` and `operation_id`, so an observation
labelled tenant B could point at tenant A's operation and confirm it. Two related problems:

- `outbox_jobs` had the same split.
- The guard compared values with `<>`, so an observation with `operation_id NULL` passed the confirm check (NULL
  is not true). The review did not list this; the new tests found it.

**Rules.**

- `(tenant_id, operation_id)` on observations and on outbox jobs references `refund_operations (tenant_id, id)`.
  An operation job must carry a tenant, because a NULL tenant would skip the composite key.
- `(id, tenant_id, confirmed_observation_id)` and `(id, tenant_id, terminal_observation_id)` reference
  `provider_observations (operation_id, tenant_id, id)`. An operation's evidence is therefore its own observation,
  in its own tenant.
- The guard checks operation, tenant and classification with NULL-safe comparisons for confirmed, terminal and
  pending evidence.
- Evidence references are set only by the transition they justify, and never change afterwards.
- The keys and the trigger are each tested with the other layer removed.

**Upgrade.** Each constraint validates existing rows. An upgrade over cross-tenant or unbound rows fails and rolls
back. It does not rewrite them.

## Rehearsal

- **Populated database.** A 0001 database with representative rows (attempts in every phase, a confirmed
  operation, an in-flight lease, a SELFTEST job) upgrades with every row count unchanged. The old rows then obey
  the new rules.
- **Bad legacy data.** Databases holding violating rows stop at the right migration, and that migration commits
  nothing.
- **Rollback.** `0004..0002` roll back and re-apply with data present.
- **Fresh database.** The template database and the migration round-trip test run from empty.
- **Local dev database.** It upgraded `0001 -> 0004` with unchanged counts, but it holds only a seeded tenant and
  its accounts.
