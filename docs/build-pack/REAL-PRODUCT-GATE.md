# Real product gate

Release is blocked until the normal UI path creates a proposal from real input, obtains an exact approval, executes a real PayPal sandbox refund, survives an injected lost response and process restart, reconciles the authoritative outcome, and proves no duplicate refund occurred.

Mocks may test adapters locally but cannot satisfy this gate. Seeded accounts must be labeled. Manual database edits, prerecorded state transitions, screenshots, successful compilation, or a hosted shell do not establish the product claim. Missing sandbox access is `BLOCKED`, not a reason to replace the provider with a fake success path.
