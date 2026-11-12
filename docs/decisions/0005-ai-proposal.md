# DR-0005: AI proposal (M02)

Date: 2026-11-12. Status: ACCEPTED (build-first round; the full T-002 adversarial matrix is deferred to FINAL
TEST).

## Flow

1. **Case and evidence.** An operator creates a case and admits evidence. Originals are encrypted. A
   deterministic redacted copy and its `redact-v1` report are stored (M01).
2. **Capture.** The operator selects a capture. `POST /api/cases/:id/captures` asks the configured
   `CaptureSource` and stores an immutable `capture_snapshots` row labelled with the source that answered:
   - `PAYPAL_SANDBOX` is the real adapter, added in M04.
   - `CONTRACT_STUB` serves the labelled `fixtures/contract-stub-captures.json`. It is refused when
     `NODE_ENV=production`.
3. **Draft.** `POST /api/cases/:id/proposals` builds the prompt from two inputs only: the declared capture
   fields, and the redacted evidence labelled `E1..En`. Evidence is escaped inside `<evidence>` elements, and the
   system prompt treats it as data. Inputs above 16 items or 24,000 code points are refused (413), never
   truncated.
4. **Model call.** The invocation is recorded `STARTED` with prompt version and digest, the model requested,
   and the admitted evidence digests. Then the model is called once (no retries, hard deadline), and the
   invocation is finalized exactly once with:
   - the model served and the provider request id;
   - the output and its digest;
   - validation errors and correction reasons.
5. **Verification** (`src/ai/verify.ts`).
   - **Rejected outright (no revision):** non-JSON, schema violations (closed objects, so no extra fields),
     invalid money, zero amounts and currency mismatches.
   - **Accepted as a draft with correction reasons:**
     - an amount above the capture;
     - a FULL refund;
     - a capture mismatch;
     - a non-refundable capture;
     - a citation that is not an exact substring of the cited evidence;
     - an uncited AMOUNT, REASON or CAPTURE_MATCH;
     - any model uncertainty;
     - instruction-like evidence.

   The database refuses to move a revision with correction reasons out of DRAFT.
6. **Correction.** `POST /api/cases/:id/revisions` writes a HUMAN revision, either a correction of the live draft
   (explanation required) or a revision from scratch against a snapshot. The server sets the capture, currency
   and evidence binding. The previous live draft becomes SUPERSEDED.

## Boundaries

- **The model cannot reach execution.** `src/ai/**` may not import persistence, services, the outbox, the worker
  or the PayPal adapter (ESLint `no-restricted-imports`). The output schema has no field for approval, execution
  or tools, and no tools are offered.
- **Database protections (migration 0005).**
  - Capture snapshots are immutable.
  - Invocations are created `STARTED`, finalized once and then frozen. Their inputs never change.
  - Citations are append-only. They are bound to their invocation's case and tenant and to evidence of the same
    case.
  - An AI revision must reference a `SUCCEEDED` invocation of the same case and tenant.
  - Lineage and snapshot references are case/tenant-bound.
  - A HUMAN correction needs an explanation.
- **Provider.**
  - `REFUNDPROOF_MODEL_PROVIDER=anthropic` uses `@anthropic-ai/sdk` (pinned 1.3.0) with model
    `claude-opus-5-5` and explicit effort (default `high`).
  - Output is constrained by `output_config.format` to the same closed schema and re-validated locally.
  - Server-side refusal fallback is enabled (`server-side-fallback-2026-07-01`, `fallbacks: "default"`), and the
    served model is recorded.
  - Credentials are resolved by the SDK from the server environment and never read or stored by RefundProof.
- **Local fixture.** `local-fixture` is a deterministic, labelled development model that always reports an
  uncertainty, so its drafts need a human correction. It is refused in production.
- **No model configured.** With `none` (the default), proposal generation returns 503 `MODEL_BLOCKED` and
  operators write proposals by hand.

## Status

The real-provider acceptance call is **BLOCKED_CREDENTIAL**: no approved model credential exists in this
environment, and no real call was made. The capture lookup from PayPal is BLOCKED_CREDENTIAL until M04 and
sandbox credentials. Known limitation (DR-0003): redaction does not detect personal names.
