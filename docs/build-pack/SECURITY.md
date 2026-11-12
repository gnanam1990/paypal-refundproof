# Security model

Assets include PayPal sandbox credentials, customer evidence, approvals, operation identities, and audit history. Threats include prompt injection in support text, credential exposure, approval replay, amount substitution, cross-tenant access, duplicate execution, forged provider callbacks, log leakage, and resource exhaustion.

Treat imported text and model output as data. Enforce tenant and role checks server-side. Bind approvals to a canonical digest and expiry. Keep PayPal credentials only in the adapter process or managed secret store. Use encrypted transport and storage where required, redact bodies and authorization headers, verify webhook authenticity when webhooks are used, and use database uniqueness plus transactional outbox semantics for execution scheduling.

Rate-limit proposal generation and execution. Bound evidence size, model tokens, network attempts, and reconciliation duration. Record security-relevant denials without storing sensitive content. Production PayPal credentials, production refunds, and external publication remain prohibited by this specification.
