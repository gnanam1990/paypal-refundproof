# Running RefundProof locally

Requirements: Node 22, pnpm 11, and PostgreSQL 17 on your machine.

1. Install dependencies and create the environment file. `setup:env` writes a gitignored `.env.local` with a
   fresh data key:

   ```bash
   pnpm install --frozen-lockfile
   ```

   ```bash
   pnpm setup:env
   ```

2. Create the database and apply all migrations (0001–0006):

   ```bash
   createdb refundproof
   ```

   ```bash
   pnpm db:migrate
   ```

3. Seed one labelled demo tenant. The seeded accounts and their generated passwords are written to the
   gitignored `.local/seed-accounts.json`:

   ```bash
   pnpm seed
   ```

4. Start the console, then the worker in a second terminal. Open http://localhost:3000.

   ```bash
   pnpm dev
   ```

   ```bash
   pnpm worker
   ```

## What this environment can reach

Each capability is set in `.env.local`. The System health screen shows which ones are available.

| Capability | Setting | Without it |
| --- | --- | --- |
| Proposal model | `REFUNDPROOF_MODEL_PROVIDER=anthropic`, with the SDK's credential in the server environment. For development only, `local-fixture` uses a labelled deterministic model that is not a real call. | Operators write proposals by hand (BLOCKED_CREDENTIAL). |
| Capture lookup | `REFUNDPROOF_CAPTURE_SOURCE=paypal-sandbox`. For development only, `contract-stub` serves the labelled `fixtures/contract-stub-captures.json`. | Captures cannot be fetched. |
| PayPal refunds | `PAYPAL_ENV=sandbox`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`. Live PayPal is refused. | Nothing is sent (BLOCKED_CREDENTIAL). |

A capture read from the contract stub can never be refunded on PayPal: execution requires the capture's source to
match the PayPal client.

## Normal path

1. **Operator.** Open a case, add the customer's message as evidence, and fetch the capture.
2. **Operator.** Draft the proposal with the model or write it by hand, correct it if needed, and request approval.
3. **Approver.** A different person opens Approvals, checks the bound facts and the digest, and approves. A FULL
   refund also needs the captured amount typed out as consent.
4. **Operator.** Send the refund. The worker sends it once under a fixed PayPal request id and records PayPal's
   answer.
5. **Lost answer.** If the answer is lost, the operation shows "Outcome unknown" while RefundProof asks PayPal on
   a schedule. It never resends on its own.
