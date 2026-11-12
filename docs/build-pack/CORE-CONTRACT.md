# RefundProof core contract

### FR-01 — Evidence-bound proposal

An authenticated operator can convert a support case and PayPal capture into a structured refund proposal without executing a refund.

### FR-02 — Exact approval

An approval binds the proposal revision, capture, amount, currency, reason, approver, and expiry and becomes invalid when any bound field changes.

### FR-03 — Idempotent execution

One approved proposal revision maps to one immutable operation identity and one PayPal request identifier, while a changed intent receives a new identity.

### FR-04 — Unknown outcome handling

A timeout or lost response produces an outcome-unknown state that blocks blind retry and never becomes a definite failure automatically.

### FR-05 — Independent reconciliation

The service reconciles an uncertain refund using recorded identifiers and permits a new provider operation only after durable proof that no dispatch occurred or a documented terminal PayPal non-application observation.

### FR-06 — Evidence and recovery

Authorized users can inspect a durable redacted evidence trail and recover a case through documented retry, escalation, or terminal resolution paths.

### NFR-01 — Durable recovery

Accepted intents, approvals, operations, provider observations, and state transitions survive process restart without manual database repair.

### NFR-02 — Secret and data protection

PayPal credentials and customer evidence are least-privileged, encrypted or redacted as appropriate, and never included in model prompts or logs beyond declared fields.

### NFR-03 — Observable bounded work

External calls use deadlines, bounded retries, correlation identifiers, structured metrics, and an explicit exhausted state.

### INV-01 — Approval identity

Execution is permitted only for the exact unexpired revision that an authorized approver approved.

### INV-02 — Single effect identity

One approved proposal revision has exactly one immutable effectful operation and provider request identity, while all retries are attempts within that operation.

### INV-03 — No false finality

Local success or failure is never asserted until supported by an authoritative PayPal observation or an explicit unresolved outcome.
