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

2. Create the database and apply all migrations (0001–0007):

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
| Proposal model | `anthropic` uses the SDK credential from the server environment. `ollama` calls a real local model through an unauthenticated loopback-only origin. For development only, `local-fixture` is deterministic and is not a real model call. | Operators write proposals by hand (BLOCKED_CREDENTIAL). |
| Capture lookup | `REFUNDPROOF_CAPTURE_SOURCE=paypal-sandbox`. For development only, `contract-stub` serves the labelled `fixtures/contract-stub-captures.json`. | Captures cannot be fetched. |
| PayPal refunds | `PAYPAL_ENV=sandbox`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`. Live PayPal is refused. | Nothing is sent (BLOCKED_CREDENTIAL). |

A capture read from the contract stub can never be refunded on PayPal: execution requires the capture's source to
match the PayPal client.

### Real local model

With Ollama installed and running, pull a model and select it in `.env.local`:

```bash
ollama pull qwen3:4b
```

```dotenv
REFUNDPROOF_MODEL_PROVIDER=ollama
REFUNDPROOF_MODEL=qwen3:4b
REFUNDPROOF_OLLAMA_ORIGIN=http://127.0.0.1:11434
```

Only `localhost`, `127.0.0.1`, or `::1` are accepted. The adapter sends redacted evidence, uses native JSON Schema
constraints, records each invocation durably, and passes the result through the independent proposal verifier.

## Normal path

1. **Operator.** Open a case, add the customer's message as evidence, and fetch the capture.
2. **Operator.** Draft the proposal with the model or write it by hand, correct it if needed, and request approval.
3. **Approver.** A different person opens Approvals, checks the bound facts and the digest, and approves. A FULL
   refund also needs the captured amount typed out as consent.
4. **Operator.** Send the refund. The worker sends it once under a fixed PayPal request id and records PayPal's
   answer.
5. **Lost answer.** If the answer is lost, the operation shows "Outcome unknown" while RefundProof asks PayPal on
   a schedule. It never resends on its own.
