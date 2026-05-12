# Architecture Deepening Plan

## Summary

This plan turns the first architecture review into scoped deepening work. The goal is to make key Heimdall modules deeper: smaller interfaces, more behavior behind each interface, and better locality for tests and maintenance.

The current checkout does not include `CONTEXT.md`, so this plan uses the domain vocabulary in `README.md`, `docs/architecture/*`, `docs/plans/mvp-public-pr-review.md`, and `docs/decisions/*`.

## Order

1. Deepen finding validation and normalization.
2. Deepen context bundle assembly.
3. Deepen generated Python contract serde.
4. Deepen code intelligence snapshot internals.
5. Deepen the worker process adapter.
6. Deepen review run persistence lifecycle.

This order starts with the modules that carry the most review-system safety risk, then moves outward to cross-runtime and persistence seams.

## Candidates

### Finding Validation And Normalization Module

Files:

- `workers/review/src/review_worker/engine.py`
- `workers/review/src/review_worker/validation.py`
- `workers/review/src/review_worker/normalizer.py`
- `workers/review/tests/unit/test_review_engine.py`
- `docs/decisions/0003-validate-before-publish.md`

Problem:

The current implementation validates raw reviewer output shape, then normalizes every candidate into a persisted finding with `locationValid`, `evidenceValid`, and `redactionValid` set to true. Dedupe and ranking fields exist, but the implementation does not yet provide the behavior those fields imply.

Acceptance criteria:

- The module has one clear interface for converting raw reviewer output and context into validated findings.
- Validation claims are only set when the module actually checked the corresponding rule.
- Dedupe and ranking behavior lives behind the same module interface or is explicitly deferred in documentation and tests.
- Tests cover invalid locations, weak or missing evidence, duplicates, and deterministic ranking at the module interface.
- The implementation remains deterministic and does not call live model or network services in default tests.

### Context Bundle Assembly Module

Files:

- `services/api/internal/workflow/local/workflow.go`
- `workers/review/src/review_worker/context_builder.py`
- `workers/review/tests/unit/test_context_builder.py`
- `services/api/internal/workflow/local/workflow_test.go`
- `docs/architecture/context-bundle.md`

Problem:

Context bundle assembly rules are duplicated across the Go local workflow and the Python review worker. Both implementations know diff-to-snippet extraction, truncation reasons, context limits, and redaction defaults.

Acceptance criteria:

- One module owns diff-only context bundle assembly rules.
- The local workflow no longer duplicates review-intelligence context packing logic.
- Truncation behavior and redaction defaults are tested through the owning module interface.
- The design leaves room for code graphs, related tests, scanner signals, prior comments, and review standards without widening workflow orchestration.

### Generated Python Contract Serde Module

Files:

- `contracts/generated/python/contract_types/types.py`
- `tools/scripts/generate-contracts.py`
- `workers/review/src/review_worker/serde.py`
- `workers/code-intel/src/code_intel/serde.py`
- `tools/scripts/check-contracts.py`

Problem:

Generated Python contracts provide dataclasses but not shared serde. Each worker owns local conversion code, and partial decoders can silently drop future contract fields at process seams.

Acceptance criteria:

- Generated or shared Python contract serde handles nested dataclasses and JSON field names consistently.
- Worker CLIs use the shared serde instead of local partial conversion where practical.
- Contract generation drift checks include the serde output.
- Tests cover round-trip behavior for context bundles, diffs, reviewer output, and findings.

### Code Intelligence Snapshot Module

Files:

- `workers/code-intel/src/code_intel/git_fetcher.py`
- `workers/code-intel/src/code_intel/ports.py`
- `workers/code-intel/tests/unit/test_git_fetcher.py`
- `docs/architecture/code-intelligence.md`

Problem:

`GitPullRequestFetcher` currently mixes provider assumptions, git command execution, temporary workspace lifecycle, default branch discovery, patch parsing, numstat parsing, language detection, resource IDs, and contract assembly.

Acceptance criteria:

- The external pull request snapshot interface stays small.
- Patch parsing, git command execution, and contract assembly have local test surfaces.
- Provider-specific assumptions stay inside code intelligence adapters.
- Tests can cover patch semantics without cloning a repository.

### Worker Process Adapter Module

Files:

- `services/api/internal/adapters/process/python.go`
- `services/api/internal/adapters/process/code_intel.go`
- `services/api/internal/adapters/process/review.go`
- `services/api/internal/adapters/process/process_test.go`

Problem:

The process adapter hides subprocess mechanics, but it also knows repo layout, Python paths, module names, JSON envelopes, and worker protocol details.

Acceptance criteria:

- Generic Python process execution is separated from Heimdall worker protocol details.
- Code intelligence and review adapters keep small interfaces for callers.
- Environment construction and module invocation are tested in one place.
- Adapter errors preserve enough context without logging secrets or raw provider payloads.

### Review Run Persistence Module

Files:

- `services/api/internal/ports/storage.go`
- `services/api/internal/storage/sqlite/store.go`
- `services/api/internal/storage/postgres/store.go`
- `services/api/internal/workflow/local/workflow.go`
- `services/api/internal/storage/sqlite/store_test.go`

Problem:

`ReviewRunStore` exposes low-level save calls, so workflow orchestration owns persistence ordering for repositories, change requests, diffs, running review runs, findings, and completed review runs.

Acceptance criteria:

- Review run lifecycle persistence is expressed as deeper operations instead of scattered blob saves where practical.
- Transaction and replacement behavior for findings is local to the persistence module.
- Workflow tests focus on review flow, not persistence choreography.
- SQLite remains the local adapter, and Postgres remains behind the same seam until implemented.

## Validation Strategy

Run the smallest relevant checks for each slice:

- Review worker changes: `pnpm python:test`
- API workflow and storage changes: `pnpm api:test`
- Contract generation or schema changes: `pnpm contracts:check`
- Frontend or TypeScript contract surface changes: `pnpm runtime:typecheck`
- Full integration before closing the goal: `pnpm check`

If a command is missing or fails because the checkout is a reduced scaffold, record that directly with the slice result.
