# M05 product UI and delivery

Status: SPECIFICATION_ONLY. Execution: NOT_RUN. Dependencies: M04. Owns FR-06, NFR-01, NFR-02, NFR-03, INV-01, INV-02, INV-03, T-011, T-012.

Build the accessible operations console described in UI-SPEC.md, observability, health checks, deployment configuration, setup documentation, and clean-checkout automation. Exercise loading, partial, stale, unknown, retry-scheduled, exhausted, permission-denied, offline, and restored states. Run the complete real sandbox response-loss journey. Capture actual commands and evidence; do not substitute screenshots or mocks for end-to-end behavior. Do not publish or deploy without authorization.

## Dependency gate

Require M04 real sandbox evidence, green duplicate/reconciliation tests, matching HEAD, and no unresolved high-severity security finding. Re-read the repository's frontend, deployment, and documentation rules.

## Product completion

Implement case queue, evidence/proposal review, exact approval, operation timeline, reconciliation workspace, health, structured logs/metrics, setup, migrations, and sandbox environment guards. UI state must come from durable backend records; no client-simulated success.

## Test and proof protocol

Make T-011 and T-012 fail. Test keyboard, screen reader, contrast, 375/768/1024/1440 layouts, offline/stale/unknown/exhausted/permission states, browser refresh, worker restart, production build, secret scan, and clean-clone installation. Re-run the real response-loss sandbox journey through UI and worker.

## Stop and handoff

Stop for missing normal-path sandbox proof, accessibility blocker, secret exposure, irreproducible setup, or drift between tested and current HEAD. Report exact commands, exits, test counts, red/green evidence, screenshots from real states, build output, HEAD, changed files, every remaining NOT_RUN gate, and rollback. Local commit only; no push, PR, merge, deployment, publication, terms acceptance, or submission.
