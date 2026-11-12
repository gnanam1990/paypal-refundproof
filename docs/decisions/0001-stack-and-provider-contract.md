# DR-0001 — Stack and verified provider contract

Date: 2026-11-12. Owner: gnanam1990. Status: ACCEPTED.

## Pre-build state

Target `/Users/kratos/Documents/Codex/2026-11-12/paypal-refundproof` did not exist; remote
`gnanam1990/paypal-refundproof` did not exist (`gh repo view` → not found). Authenticated GitHub
login verified read-only as `gnanam1990`. Build pack copied verbatim to `docs/build-pack/`;
`node docs/build-pack/scripts/check-build-pack.mjs --root docs/build-pack` → `PASS` (31 files,
inventory digests verified). Document QA is not product proof.

## Decision

TypeScript on Node 22, pnpm, PostgreSQL (17 locally; any ≥14), Next.js App Router for the operations
console and control API, a separate worker process that drains a PostgreSQL transactional outbox with
`FOR UPDATE SKIP LOCKED` leases, Vitest + fast-check for unit/property/integration, Playwright +
axe-core for browser/accessibility. Hand-written SQL migrations with up/down files.

Considered alternatives: pg-boss/graphile-worker (rejected — the outbox claim, lease and recovery
rules are the product's safety core and are kept explicit and testable in-repo); an ORM (rejected —
uniqueness and partial-index constraints are the enforcement mechanism and are clearer in SQL);
Fastify + server templates (viable; Next.js retained because the pack proposes it and React keeps the
many honest UI states manageable).

## Verified PayPal contract (UNVERIFIED in sandbox until T-009 runs)

Source: PayPal published OpenAPI documents fetched 2026-11-12 and preserved in
`docs/evidence/provider-schemas/` (`payments.json` sha256 `c2c95b3b…2803a`, `orders.json` sha256
`5bcb2242…ee96b7`).

- `POST /v2/payments/captures/{capture_id}/refund`: "For a full refund, include an empty payload".
  The `amount` description: if not specified, "captured amount - previous refunds" is refunded. This is
  the omitted-amount hazard (Agent Toolkit issue 121, still OPEN on 2026-11-12). RefundProof never
  sends a body without `amount` unless the approved revision carries the explicit `FULL` semantic.
- `PayPal-Request-Id` is the documented idempotency header (1..10000 chars). Retention window is not
  stated in the schema → treated as UNVERIFIED; RefundProof never relies on replay for reconciliation.
- Request fields used: `amount`, `invoice_id` (≤127), `custom_id` (≤127; response pattern
  `^[A-Za-z0-9-_.,]*$`), `note_to_payer` (≤255).
- Responses: 200/201 success; 400/401/403/404/422 error; 409 `RESOURCE_CONFLICT` /
  `PREVIOUS_REQUEST_IN_PROGRESS`; 500. Refund `status` enum: `CANCELLED`, `FAILED`, `PENDING`,
  `COMPLETED`. Capture `status` enum: `COMPLETED`, `DECLINED`, `PARTIALLY_REFUNDED`, `PENDING`,
  `REFUNDED`, `FAILED`.
- Read-only observation paths: `GET /v2/payments/captures/{id}` (links `self`, `refund`, `up`),
  `GET /v2/payments/refunds/{id}`, and `GET /v2/checkout/orders/{id}` whose
  `purchase_units[].payments.refunds[]` carries `invoice_id` and `custom_id`. Reconciliation after a
  lost response matches the operation's own `invoice_id`/`custom_id` there. No other lookup API is
  assumed.

## Classification rules (derived, see TDD)

- 201/200 refund body → observation; `COMPLETED` → CONFIRMED; `PENDING` → RECONCILING;
  `FAILED`/`CANCELLED` → PROVIDER_TERMINAL_NOT_APPLIED.
- 400/403/404/422 PayPal error body → PROVIDER_TERMINAL_NOT_APPLIED (request rejected; documented).
- 401 → token refresh and one bounded retry under the same request ID (rejected before processing).
- 429 → bounded backoff retry under the same request ID.
- 409, 5xx, timeout after send, reset, unparseable body → OUTCOME_UNKNOWN → reconcile.
- Connect failure before any byte is written (DNS, refused, connect timeout, TLS handshake) →
  attempt NOT_SENT; bounded retry under the same identity.

## Practitioner evidence status (2026-11-12, `gh issue view -R paypal/agent-toolkit`)

98 OPEN (no per-call request ID), 121 OPEN (no-amount refund refunds whole capture), 122 OPEN (no
request timeout). Not maintainer-confirmed behavior.

## Revisit trigger

First real sandbox run (T-009/T-010) or any observed divergence from the schema above.
