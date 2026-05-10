# Sandboxing

Repository checkout and analysis happen on untrusted input.

Sandboxing expectations:

- Do not execute repository scripts by default.
- Keep workspace cleanup deterministic.
- Redact secrets before logs or artifacts are persisted.
- Keep network/model calls out of default tests and evals.
- Bound file sizes, artifact sizes, and prompt sizes.

Current workspace-related code belongs under `apps/worker/src/workspace` and shared safety primitives belong under `packages/security`.

