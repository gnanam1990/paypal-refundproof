# RefundProof submission pack

This file contains public copy and an evidence checklist for the PayPal AI Hackathon 2026 submission. It is a draft
until the repository, video, and Devpost entry are visibly public and the final URLs are recorded.

## Project name

RefundProof

## Tagline

Evidence-bound PayPal refunds that survive lost responses.

## Short description

RefundProof turns a customer refund into a durable, content-addressed operation. It redacts customer evidence, reads
the real PayPal sandbox capture, creates a bounded proposal, binds an independent human approval to one exact revision
digest, sends one idempotent PayPal request, and reconciles unknown outcomes without blindly sending money again.

## Inspiration

The most dangerous payment failure is ambiguous success: the client times out, but the provider may already have
accepted the financial effect. Support tools often respond by retrying, while approval tools often authorize a mutable
ticket rather than the exact payload that will be sent. We wanted a refund system that can prove what evidence was
used, what a person approved, what reached PayPal, and why a retry did or did not happen.

## What it does

- Encrypts original customer evidence and gives only a redacted copy to the proposal boundary.
- Reads the authoritative capture from PayPal sandbox.
- Produces a schema-constrained AI or human refund proposal with verified evidence citations.
- Seals amount, currency, capture, policy, and evidence into an immutable revision digest.
- Requires a different human approver; full refunds require typed amount consent.
- Derives one operation, PayPal request ID, invoice ID, and custom ID from the approved facts.
- Dispatches through a durable worker and records every network attempt.
- Reconciles an unknown outcome with PayPal instead of automatically sending again.
- Shows the complete proof trail in a production-style operator console.

## How we built it

RefundProof uses Next.js 16 and React 19 for the console, PostgreSQL 17 for tenant-scoped durable state, and a separate
TypeScript worker for outbox dispatch and reconciliation. The domain kernel uses integer minor units, canonical JSON,
content digests, derived bound IDs, and explicit state machines. The PayPal adapter is locked to
`api-m.sandbox.paypal.com` and uses PayPal's request-idempotency header. Customer evidence is encrypted at rest and
redacted before model input.

The AI proposal boundary has Anthropic and labelled local-fixture adapters. Model output is never trusted directly:
money precision, reason codes, citations, source digests, capture identity, and policy bounds are verified before a
person can approve it. The recorded journey used the labelled local fixture; it does not claim an external model call.

## Challenges

The real sandbox rehearsal exposed a subtle production-shaped defect: PostgreSQL `jsonb` reordered object keys while
the pre-dispatch guard compared snapshots with `JSON.stringify`. The values were identical, but the order differed, so
the worker safely cancelled before calling PayPal. We reproduced the bug with a red test, changed the guard to
canonical JSON comparison, restarted the worker, and then completed the real PayPal sandbox refund through the normal
UI with one provider attempt.

## Accomplishments

- Real PayPal sandbox capture read and completed refund, not a mocked central payment path.
- Exact approval-to-operation binding with role separation.
- Durable unknown-outcome state and reconciliation rather than blind retries.
- Encrypted original evidence, redacted model input, and provider-safe public artifacts.
- A professional operator UI that makes the failure model understandable to judges.
- Adversarial regression coverage for canonical outbound comparison, retries, restart recovery, and tenant isolation.

## What we learned

Idempotency is not a header added at the final API call. It is a system property that starts with immutable approval
facts, continues through operation identity and durable attempts, and ends only after provider reconciliation. We also
learned that a real sandbox rehearsal catches storage and process-lifecycle problems that happy-path mocks cannot.

## What's next

- Exercise the Anthropic adapter with a dedicated provider credential and add proposal-quality evals.
- Add deployment profiles for a managed PostgreSQL database and a continuously running worker.
- Extend the same evidence-bound operation model to payouts, disputes, and multi-provider payment operations.
- Run external security review before considering any production payment environment.

## PayPal integration proof

| Field | Value |
| --- | --- |
| Capture | `82E93566SH823383U` |
| Amount | `84.00 USD` |
| PayPal refund | `2MU02051VC628743S` |
| Result | HTTP `201`, `COMPLETED` |
| Attempts | `1` |

## Public links

- Repository: `PENDING_PUBLICATION`
- Demo video: `PENDING_PUBLICATION`
- Hosted app: not claimed; complete local setup is in the README and `docs/SETUP.md`.

## Final submission checklist

- [x] Working non-trivial product
- [x] Meaningful PayPal sandbox integration
- [x] AI proposal boundary with explicit provider status
- [x] Modern UI and real product screenshots
- [x] Demo video under three minutes, 1080p, no audio, subtitles included
- [x] Complete source and setup instructions
- [x] Open-source license prepared
- [ ] Repository visibly public
- [ ] Public YouTube video visibly playable
- [ ] Devpost fields populated and final rules agreement submitted
