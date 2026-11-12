# RefundProof build pack

Status: **SPECIFICATION_ONLY**. Implementation, PayPal sandbox execution, model evaluation, tests, deployment, publication, and hackathon submission are **NOT_RUN**.

RefundProof turns customer-support evidence into an exact refund proposal, obtains revision-bound human approval, executes one PayPal sandbox refund, and reconciles timeouts without double-refunding. The central claim is not demonstrated until a real sandbox run deliberately loses a response and the system independently recovers the authoritative outcome.

Read in this order: `PRD.md`, `CORE-CONTRACT.md`, `TDD.md`, `UI-SPEC.md`, `SECURITY.md`, `TEST-PLAN.md`, `IMPLEMENTATION-PLAN.md`, `MASTER-PROMPT.md`, then the prompts in module order M00 through M05.

For a one-shot coding-agent handoff, give the agent this directory and instruct it to obey `MASTER-PROMPT.md`. For controlled delivery, run one module prompt at a time and review the recorded evidence before continuing.

Local implementation and focused commits are allowed only when the user invokes this pack inside the intended repository. Creating a remote repository, pushing, opening or merging a pull request, deploying, spending money, publishing a video, accepting terms, or submitting to the event requires separate authorization.

The proposed stack is TypeScript, PostgreSQL, a durable job runner, Next.js, and PayPal REST sandbox. It is a decision to confirm after repository and toolchain inspection, not an installed dependency claim.

## Mandatory pre-module gate

Before M00, read `project-metadata.json`, `requirements.json`, `EVENT-NOTES.md`, `SOURCES.md`, `DELIVERY.md`, `SEMANTIC-REVIEW.md`, and `PACK-QA.md`. Stop if the pack is unsealed or current PayPal/event evidence contradicts it. Document QA is not sandbox product proof.
