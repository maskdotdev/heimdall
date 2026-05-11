# AGENTS.md

## Project Shape

Heimdall is a monorepo for an automated code review system with strong service boundaries.

- `apps/web`: user-facing review dashboard.
- `services/api`: API service and control-plane boundary.
- `services/workflows`: Temporal workflow definitions and workflow worker boundary.
- `workers/review`: LLM review intelligence, context packing, structured output validation, ranking, and deduplication.
- `workers/code-intel`: repository cloning, diff parsing, language detection, symbol extraction, dependency graph construction, and related test detection.
- `workers/scanner`: deterministic static-analysis tools such as Semgrep, CodeQL, secret scanning, and scanner output normalization.
- `workers/publisher`: provider comment publishing, provider-specific formatting, and rate-limit handling.
- `workers/indexer`: optional later high-performance indexing, symbol extraction, dependency graph construction, and source scanning.
- `contracts`: shared Protobuf, OpenAPI, JSON Schema, and generated Go/TypeScript/Python contract artifacts.
- `packages/ts-api-client`: typed frontend API client.
- `packages/ui`: shared frontend UI primitives.
- `infra`: deployment, environment, Temporal, migration, Kubernetes, Docker, and Terraform setup.
- `tools`: repository automation, local development helpers, and CI helpers.
- `docs`: architecture docs, decision records, and runbooks.
- `tests`: integration fixtures and review-quality evals.

Keep dependency direction explicit:

- `apps/web` depends on `packages/ts-api-client`, `packages/ui`, and generated contract artifacts.
- `services/*` and `workers/*` depend on `contracts` and their own internal code.
- `contracts` must not depend on apps, services, or workers.
- `infra`, `tools`, `docs`, and `tests` must not become runtime application libraries.

Do not introduce a package or service dependency that bypasses the contract boundary for shared review runs, diffs, context bundles, findings, provider references, or review events.

## Tooling

Use the repo scripts when they exist in the checked-out tree.

- Runtime targets: Node.js 22+, pnpm 10+, Bun 1.2+, Python 3.12+, Go 1.22+, and Rust stable when those service or worker folders are active.
- Preferred package manager for JavaScript and TypeScript work: `pnpm`.
- Expected checks in the full project: `pnpm check`, with narrower fallbacks such as `pnpm typecheck`, `pnpm lint`, and `pnpm test`.
- Formatting and linting are expected to be Biome-based for TypeScript when config is present.
- Python workers should use their local `pyproject.toml` once present.
- Go services should use their local `go.mod` once present.
- Rust workers should use their local `Cargo.toml` once present.

If the current checkout is a reduced scaffold and a command or config file is missing, say that plainly instead of inventing a replacement workflow.

## Code Guidelines

- Write strict TypeScript when editing TypeScript. Avoid `any`; prefer `unknown` plus parsing or narrowing at boundaries.
- Use schema-backed parsing for external or persisted data. Prefer TypeBox or JSON Schema patterns when they already exist in the relevant boundary.
- Keep module boundaries clear. Prefer generated contracts and public package exports over deep imports into another boundary's internals.
- Use `import type` for type-only TypeScript imports.
- Name files and directories in kebab case; use PascalCase for classes and camelCase for functions, variables, and methods.
- Add comments only when they explain non-obvious intent or invariants.

## Review-System Safety

This project handles repository data, PR context, secrets, and generated findings.

- Never log secrets, tokens, raw private keys, or unredacted provider payloads.
- Keep redaction and permission checks close to ingress, persistence, and publishing boundaries.
- Treat LLM output as untrusted. Validate findings before persistence or publication.
- Preserve deterministic behavior in tests and evaluation paths; do not add live network or model calls to default checks.

## Testing

- Add or update tests for behavior changes, especially around review validation, ranking, publishing, security, persistence, and provider normalization.
- Prefer tests through public interfaces over tests that lock in internal call structure.
- Keep review-quality evals under `tests/evals`.
- Keep integration fixtures under `tests/fixtures`.
- For narrow scaffold edits, run the smallest available relevant check and report if no runnable checks exist.

## Documentation

- Follow Google's Technical Writing Style Guide for README files, technical documentation, JSDoc, and comments.
- Define terminology when needed.
- Use active voice and present tense.
- Keep documentation aligned with the top-level structure in this file.

## Git Hygiene

- Do not revert unrelated user changes.
- Keep edits scoped to the requested work.
- Before handoff, report the exact validation command run, or explain why validation could not run.
