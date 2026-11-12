# Test plan

All tests are **NOT_RUN**. Unit, property, integration, restart, accessibility, browser, sandbox, and clean-checkout suites must distinguish prerequisites from the promised behavior.

### T-001 — Persist proposal and evidence digest

Status: NOT_RUN. Verify accepted evidence and proposal identity survive restart unchanged.

### T-002 — Reject unsupported AI fields

Status: NOT_RUN. Inject uncited and schema-invalid model output and require a non-executable review state.

### T-003 — Invalidate changed approval

Status: NOT_RUN. Change one bound field and prove the previous approval cannot execute.

### T-004 — Require explicit full refund consent

Status: NOT_RUN. Inspect the real adapter payload and prove it carries the approved exact amount/currency or an intentionally approved `FULL` semantic; omission by accident must fail.

### T-005 — Reuse request identity on same retry

Status: NOT_RUN. Race two workers and retry the same approved operation; assert one operation, one provider request ID, and attempts under that identity.

### T-006 — Separate changed refund intent

Status: NOT_RUN. Change amount or capture and assert a new revision, approval, and operation identity.

### T-007 — Convert lost response to unknown

Status: NOT_RUN. Drop the response after submission and assert OUTCOME_UNKNOWN rather than failed.

### T-008 — Recover after process restart

Status: NOT_RUN. Restart web and worker processes during reconciliation and resume without manual mutation.

### T-009 — Observe completed sandbox refund

Status: NOT_RUN. Execute and independently observe a real PayPal sandbox refund.

### T-010 — Block duplicate refund after timeout

Status: NOT_RUN. Race user and worker retries while unknown and after lookup absence; prove no second refund or operation is submitted.

### T-011 — Render honest partial and error states

Status: NOT_RUN. Exercise responsive, keyboard, screen-reader, stale, partial, offline, and exhausted UI states.

### T-012 — Complete clean-checkout end-to-end run

Status: NOT_RUN. From a clean clone, configure sandbox secrets, migrate, run tests, build, launch, and record the normal recovery journey.
