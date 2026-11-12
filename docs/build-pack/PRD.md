# Product requirements

## Problem and buyer

Support teams face a dangerous ambiguity when a refund request times out: retrying may issue a second refund, while treating it as failed may leave a customer unresolved. PayPal Agent Toolkit reports also show risks around omitted refund amounts, request identity, and missing timeouts. The primary user is a support operator; the economic buyer is a merchant operations or payments team.

## Product objective

Deliver a real refund-control workflow whose normal path uses PayPal sandbox, durable state, exact approval, and independent reconciliation. AI is central for evidence extraction, capture matching, reason classification, and proposal explanation; deterministic code owns authorization, amounts, identity, execution, and finality.

## User journey

The operator imports a support case, selects or confirms the matching capture, reviews the AI proposal and source citations, edits if necessary, and requests approval. An approver sees the exact amount, currency, capture, reason, evidence digest, and full-refund warning. After approval, the worker executes once. A lost response is shown as unknown, not failed. The reconciler queries PayPal and either confirms the refund, proves no effect before a controlled new attempt, or escalates an unresolved case.

## Scope

Requirements FR-01 through FR-06 and NFR-01 through NFR-03 are release scope. Include authentication, roles, immutable proposal revisions, explicit full-refund consent, per-operation request IDs, restart recovery, redacted audit evidence, sandbox fixture setup, and a deliberate response-loss end-to-end test.

## Exclusions

No production money movement, chargeback adjudication, autonomous approval, universal commerce ledger, or claim that PayPal reports are maintainer-confirmed. The product does not infer that an HTTP timeout means failure.

## Acceptance gates

All T-001 through T-012 must run from a clean checkout. At least one real PayPal sandbox refund must be observed through the normal product path. A response-loss test must prove that retry is blocked until reconciliation. Product status remains NOT_RUN in this pack.
