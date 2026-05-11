# Sandboxing

Repository checkout and analysis happen on untrusted input.

Sandboxing expectations:

- Do not execute repository scripts by default.
- Keep workspace cleanup deterministic.
- Redact secrets before logs or artifacts are persisted.
- Keep network and model calls out of default tests and evals.
- Bound file sizes, artifact sizes, and prompt sizes.

Primary ownership:

- `workers/code-intel` owns repository checkout and source analysis workspace behavior.
- `workers/scanner` owns deterministic scanner execution boundaries.
- `workers/review` owns prompt and context size limits.
- `services/api` owns ingress permission checks and persistence authorization.
