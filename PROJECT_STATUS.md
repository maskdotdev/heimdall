# Project Status

This file tracks implementation progress against the phase specs in `phases/`.
Update it when a phase meaningfully changes status or when a commit completes a
tracked milestone.

## Status Legend

| Status | Meaning |
| --- | --- |
| Not started | No meaningful implementation exists yet. |
| Partial | Some production code exists, but the phase definition of done is not met. |
| Done | The phase definition of done is met for the current scope. |
| Deferred | Intentionally postponed until another phase requires it. |

## Phase Tracker

| Phase | Status | Evidence | Notes |
| --- | --- | --- | --- |
| #0 Core contracts and shared types | Done | `packages/contracts`, `packages/contracts/test/contracts.test.ts`, `packages/contracts/README.md`, `pnpm --filter @repo/contracts test`, `b9b4635` | `@repo/contracts` builds and exports TypeBox runtime schemas plus inferred TypeScript types for primitives, enums, identity, repository settings, PR snapshots, change sets, index artifacts, review context, review runs, findings, memory/rules/feedback, LLM calls, usage/quota/entitlement objects, webhook events, job envelopes/payloads, API DTOs, and error responses. Fixtures cover pull-request snapshots, index artifacts, candidate/validated/published findings, review runs, context bundles, memory/rules, operations, and job payloads with runtime validation plus invalid-fixture coverage. The package re-exports public index artifact schemas and validators from `@repo/index-schema` without copies, reports supported schema versions, documents example imports and versioning, and includes a dependency-boundary guard that keeps contracts independent from DB, GitHub, queue, LLM gateway, and worker packages. |
| #1 Monorepo and build system | Done | `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.json`, `.github/workflows/ci.yml`, `README.md`, `compose.yaml`, `test/workspace-tsconfig.test.ts`, `test/workspace-structure.test.ts`, `pnpm ci:control-plane:release` | Workspace, TypeScript, Biome, Vitest, Turbo, local Compose dependencies, documented setup commands, boundary checks, and a GitHub Actions CI gate are active. Root TypeScript project references cover every workspace project with a guard test to prevent drift, and root/app/package structure guards verify required setup files, scripts, TypeScript configs, package entrypoints, and workspace naming. The local control-plane release gate passed on May 8, 2026, covering deployment audit, readiness, `pnpm check`, and `pnpm build`. |
| #2 Database layer | Partial | `packages/db`, `drizzle.config.ts`, `packages/db/migrations/0000_foundation.sql`, `packages/db/migrations/0009_high_sphinx.sql`, `packages/db/src/repositories/background-job-repository.ts`, `packages/db/test/background-job-repository.integration.test.ts`, `packages/db/src/repositories/billing-repository.ts`, `packages/db/test/billing-repository.integration.test.ts`, `packages/db/src/repositories/repository-repository.ts`, `packages/db/src/repositories/provider-installation-repository.ts`, `packages/db/src/repositories/product-auth-repository.ts`, `packages/db/test/product-auth-repository.integration.test.ts`, `packages/db/test/repository-repository.integration.test.ts`, `packages/db/src/repositories/webhook-repository.ts`, `packages/db/test/webhook-repository.integration.test.ts`, `packages/db/src/repositories/pull-request-repository.ts`, `packages/db/test/pull-request-repository.integration.test.ts`, `packages/db/src/repositories/index-version-repository.ts`, `packages/db/test/index-version-repository.integration.test.ts`, `packages/db/src/repositories/code-intelligence-repository.ts`, `packages/db/test/code-intelligence-repository.integration.test.ts`, `packages/db/src/repositories/embedding-repository.ts`, `packages/db/test/embedding-repository.integration.test.ts`, `packages/db/src/repositories/review-repository.ts`, `packages/db/test/review-repository.integration.test.ts`, `packages/db/src/repositories/sandbox-repository.ts`, `packages/db/test/sandbox-repository.integration.test.ts`, `packages/db/src/repositories/security-audit-repository.ts`, `packages/db/test/security-audit-repository.integration.test.ts`, `packages/admin-tools/src/local-db-vector-smoke.ts`, `b9b4635` | Drizzle schema, generated migrations, bootstrap extensions, client, and repository helpers exist. Product auth/session queries now include OAuth state create/consume, provider-account lookup, OAuth user/account upsert, active session read, membership listing, session revoke, and existing-user lookup with Postgres-backed integration coverage; the API uses this boundary for product OAuth login/session flows and FK-backed decision user lookup. Security/audit queries now include artifact access event insertion, idempotent security event insertion, audit log insertion, filtered audit log listing, and filtered security event listing with Postgres-backed integration coverage; the API uses this boundary for sensitive review-artifact access logging, normalized security event sink writes, admin audit writes, and admin audit/security inspection reads. Billing queries now include provider request logging, failed-provider-request listing, billing meter event listing, failed-or-stale meter sync reads, and failed billing webhook reads with Postgres-backed integration coverage; the API and worker use this boundary for provider request audit logging, and the API uses it for billing meter debug reads plus billing reconciliation issue reads. Background-job queries now include idempotent insert, pending dispatch reads, lifecycle transitions, stale-running recovery, job ID lookup, queue/job-key lookup, job-key batch listing, review-run job listing, and embedding-job cleanup with Postgres-backed integration coverage; `@repo/queue` now uses this repository boundary for durable job lifecycle operations, GitHub webhook ingestion now uses it for planned-job persistence, review orchestration now uses it for index-dependency and publish handoff jobs, the worker now uses it for index-completion review resume and embedding repair batch jobs, index imports now use it for embedding batch jobs, delayed repair jobs, and failed-import job cleanup, the API now uses it for admin/product job enqueues plus review-run related-job summaries, and admin tooling now uses it for job debug reads, replay job insertion, replay related-job lookup, and publisher related-job summaries. Repository queries now include provider-ID lookup, owning-org lookup, provider-ref lookup with installation metadata, bounded scoped repository discovery, deterministic enabled-repository cursor pagination, batch repository/settings/org-default reads, provider metadata upsert that preserves product enablement, and insert-if-absent default settings with Postgres-backed integration coverage; GitHub webhook ingestion uses this repository boundary for repository planning state and repository/settings persistence, `@repo/embedding`, index imports, and admin tooling use it for org scope lookup, publisher, review orchestration, the worker, and admin tooling use it for GitHub repository references or provider-feedback org scoping, and the API uses it for admin repository discovery. Provider installation queries now include durable installation lookup, active visible-org reads, recent installation reads, and scoped admin discovery with Postgres-backed integration coverage; the API uses this provider-installation boundary for product session installation visibility, onboarding installation summaries, and admin installation list/detail reads. Webhook queries now include provider-delivery idempotent insert, delivery lookup, product activity summary, and processing/processed/ignored/failed state transitions mapped to the webhook contract with Postgres-backed integration coverage; GitHub webhook ingestion now uses this repository boundary for delivery idempotency, and the API uses it for product onboarding webhook summaries. Pull request queries now upsert immutable snapshots plus mutable PR state through a repository boundary with Postgres-backed idempotency coverage; GitHub webhook ingestion now uses this boundary for PR persistence. Index-version queries now include ready lookups, latest-ready lookup, idempotent create/update, and importing/ready/failed state transitions with structured errors and Postgres-backed integration coverage. Code-intelligence queries now expose symbol-at-line, file symbols, file chunks, symbol edge, graph-related chunk, dependency, route, related-test, and full-text chunk lookups mapped back to index-record contracts with Postgres-backed integration coverage; retrieval now uses this repository boundary for indexed context queries. Embedding queries now expose embeddable chunk reads, reusable vector cache reads, idempotent vector storage with chunk/index progress updates, and pgvector similarity search with Postgres-backed integration coverage; retrieval semantic search and `@repo/embedding` batch reads now use the DB repository boundary. Review queries now have Postgres-backed integration coverage for review-run upsert, recent completed review-run listing, waiting-for-index review-run listing, expired review artifact cleanup target listing and tombstone updates, provider-feedback target lookup, candidate/validated finding idempotency, and returning the stored candidate row on review/fingerprint conflicts; the worker uses this review boundary for provider-feedback, thread-reconciliation, index-dependency resume, and review-artifact cleanup lookups and updates. Sandbox persistence and cleanup queries now have Postgres-backed integration coverage for run upsert with child-row replacement, ordered cleanup target selection, artifact URI reads, limit validation, and cascaded run deletion; the worker uses this sandbox boundary for sandbox run persistence and stale run cleanup. The local DB vector smoke applies all generated migrations to an isolated schema on the local `pgvector/pgvector:pg17` Postgres service, verifies `vector` and `pgcrypto`, inserts indexed chunks and embeddings, and proves pgvector nearest-neighbor ordering. More repository methods remain. |
| #3 GitHub App integration | Done | `packages/github`, `docs/runbooks/github-dev-app.md`, `408f7bd` | Provider surface, installation token caching, repo discovery, PR snapshot fetching, clone auth, publishing primitives, inline review dedupe, summary-comment dedupe, check-run create/update, fake provider coverage, typed error mapping, basic rate-limit header observation, and a manual dev-app runbook exist. The latest live PR review smoke provides the current MVP test-repository proof. |
| #4 Webhook ingestion | Done | `packages/webhook-ingestion`, `apps/api/src/app.ts`, `b9b4635` | Handles GitHub installation, repository, and pull request webhooks with signature verification, persistence, idempotency, and job planning. |
| #5 API server | Done | `apps/api`, `apps/api/src/app.ts`, `apps/api/src/app.test.ts`, `scripts/check-boundaries.ts`, `pnpm --filter @app/api test`, `pnpm boundaries:check`, `b9b4635` | The API boots with health/readiness/version/OpenAPI routes, request IDs, security headers, structured error envelopes, GitHub webhooks, Stripe webhooks, signed admin control-plane auth, product GitHub OAuth sessions, DB-backed session revoke/read support, CSRF and rate limits for cookie-authenticated mutations, product RBAC helpers, admin support-session fallback, and scoped admin/product route guards. Product APIs cover `/api/v1/me`, logout, orgs, installations, GitHub install helpers, repository list/detail/settings, repo enable/disable/sync/reindex, repository rules and policy previews, review-run/finding reads, finding outcomes, suppress-similar rules, review reruns, review artifact metadata plus audited redacted payload reads/downloads, repository memory facts/candidates, and usage summaries/events. Admin APIs cover repository settings/rules, audit/security history, usage/entitlement/billing inspection, debug inspectors, replay/cancel controls, redacted review debug bundles, eval import drafts, and durable job enqueueing. Route tests cover auth, RBAC/cross-scope denial, validation, CSRF, rate limiting, job enqueueing, redaction, support-session raw access, and audited state changes, while the boundary gate keeps the API app from importing worker-side expensive execution packages. Broader streaming optimizations remain post-MVP hardening, not a phase-5 blocker. |
| #6 Web dashboard | Done | `apps/web/src/main.ts`, `apps/web/src/styles.css`, `apps/web/src/api-client.ts`, `apps/web/src/api-client.test.ts`, `apps/web/src/dashboard-boundaries.test.ts`, `pnpm --filter @app/web test` | The dashboard MVP includes the authenticated product console for org selection, synced repositories, repo enable/disable, org and repository review settings, repository rules, policy previews, review history, review detail, failed review/job summaries, findings, finding outcomes, suppress-similar controls, artifact metadata plus audited redacted artifact payload previews/downloads, repository memory facts/candidates, and basic usage cards. The operator console includes admin-debug webhook/job/review/publisher/memory inspectors, guarded replay/cancel controls, redacted review debug bundle export, eval import draft creation, repository settings and rules, usage rollups, plan/entitlement inspection, billing state for internal support, audit history, security event history, and evaluation history. URL-backed reload/share state covers major product and admin selections, API calls go through a typed client helper, source-boundary tests prevent direct fetch calls and server-only package imports, and dashboard MVP contract tests cover primary views/renderers/actions, loading/empty/error states, and dangerous-action confirmation requirements. Broader typed router/query-client migration remains post-MVP work. |
| #7 Job queue and orchestration | Done | `packages/queue`, `packages/queue/test/queue.test.ts`, `apps/worker`, `apps/worker/src/index.test.ts`, `packages/observability/src/index.ts`, `packages/db/src/schema/tables.ts`, `packages/db/src/repositories/background-job-repository.ts`, `packages/db/src/repositories/queue-health-repository.ts`, `packages/db/test/background-job-repository.integration.test.ts`, `packages/db/test/queue-health-repository.integration.test.ts`, `packages/admin-tools/src/index.ts`, `apps/api/src/app.ts`, `apps/web/src/main.ts` | Current async backbone scope exists: pending durable rows, outbox dispatch to BullMQ, worker lifecycle updates, retry/idempotency coverage, heartbeat-backed stale running job recovery using durable `updated_at`, final heartbeat-state checks that avoid overwriting canceled/completed rows after handler return, environment-selected worker role queues for independent scaling, queue depth and oldest-job-age gauges plus persisted Postgres queue health snapshots, worker handler registration for indexing, embedding, review, publishing, and billing reconciliation jobs, audited admin retry/replay/cancel controls, and cooperative cancellation checkpoints before expensive sync, indexing, import, embedding, review, publish, feedback, billing reconciliation, and cleanup work. |
| #8 Repo sync and workspace manager | Done | `packages/repo-sync`, `apps/worker/src/index.ts`, `packages/review-orchestrator/src/index.ts` | Repo sync can obtain GitHub clone auth, validate lowercase full-length commit SHAs, sanitize and allowlist clone URLs, run Git through a timeout-aware runner with redacted failures, define cache configuration/layout path builders, serialize mirror/fetch/worktree cache mutations with bounded filesystem locks, create/reuse atomic bare mirrors, verify exact commits in mirrors through ref-hint/direct fetches, create detached worktree leases, persist local sidecar lease metadata, validate leased worktree `HEAD`, repository root, and clean status before returning cached workspaces, enforce max workspace bytes before returning leases, report local cache stats for mirrors/worktrees/metadata, acquire cached exact-commit workspaces, create an exact-commit workspace, verify `HEAD`, hand the workspace to the TypeScript indexer, expose repository path safety helpers, clean up temporary workspaces through a guarded cleanup helper that refuses relative, unmanaged, or outside-root paths before deleting retained workspaces, remove expired cached worktrees after process crashes, and exercise exact-commit lease/release behavior against a real local Git bare mirror. Worker index jobs and review orchestration now use cached acquisition paths, worker/review logs and stage metadata include repo-sync lease IDs, and worker startup runs expired-worktree cleanup. |
| #9 Indexer boundary | Done | `packages/indexer-driver`, `apps/indexer-cli`, `apps/worker/src/index.ts`, `packages/config`, `packages/index-importer` | Typed indexer driver boundary exists with fake-driver and registry coverage, the worker consumes artifacts through the boundary, `@repo/config` defines and validates central indexer runtime configuration for driver selection, artifact roots, validation modes, CLI process settings, and remote indexer settings, `@repo/indexer-driver` includes a CLI driver wrapper with safe env allowlisting, request-file writing, per-run output/log directories, bounded stdout/stderr capture, artifact validation with full, sample, or manifest-only modes, and timeout/process failure normalization, `@repo/indexer-driver` includes a remote HTTP driver that submits and polls remote runs, downloads or accepts inline artifact JSON, preserves durable remote artifact URIs, validates artifacts before import with the same validation modes, and normalizes remote failures, drivers expose capabilities, `@app/indexer-cli` can print TypeScript indexer capabilities or run the TypeScript indexer against a local workspace from flags or request JSON and write artifact JSON, the worker can select the default in-process driver, fake driver, CLI driver, or remote driver through the central config while failing startup if the selected driver does not support the current artifact schema and propagating central validation mode/sample-size config into CLI and remote drivers, object-storage upload mode now stores locally produced index artifacts through S3/R2-compatible durable URI handoffs before importer reads, and driver telemetry now includes run/output/timeout, validation duration/failure, nonzero CLI exit, artifact resource-count, indexed-byte metrics, and indexed-byte span attributes. |
| #10 Index artifact schema | Done | `packages/index-schema`, `packages/index-schema/fixtures`, `packages/indexer-driver`, `packages/index-importer` | Artifact records are schema- and semantic-validated through `@repo/index-schema`, and the package now exports a full artifact schema with inline and checked-in compatibility coverage, manifest feature flags with unsupported-required-feature rejection, manifest `recordFiles` metadata, normalized repo path helpers, deterministic stable ID helpers, JSONL parse/stringify helpers, whole-artifact JSON helpers, Node split-artifact reader/writer helpers, `openIndexArtifact` streaming split-artifact reads, streaming JSONL record writes with count/byte/SHA-256 metadata, a high-level split-artifact writer that derives manifest record counts and writes the manifest last, partitioned record-file reads with count/byte/SHA-256 verification, record-file path safety checks, artifact diff utilities, package-owned CLI commands for validate, print-manifest, count-records, diff, and fixture generation, and a checked-in split fixture catalog covering valid minimal, TypeScript, Python, bad-path, bad-checksum, missing-reference, out-of-order, and unknown-record-type artifacts. |
| #11 TypeScript indexer | Done | `packages/indexer-ts`, `packages/indexer-ts/test`, `apps/indexer-cli` | TypeScript indexer emits files, symbols, edges, chunks, manifest hashes, deterministic fixtures, prefers Git-tracked file discovery with filesystem fallback, generated/vendor skip heuristics for path and header patterns, symlink skipping so workspace walks do not follow linked source files outside the checkout, workspace root validation before discovery, oversized file skipping before reads, binary source skipping before decode, LF-normalized source text for parsing/chunking, Node `.mjs`/`.cjs` coverage with declaration-file exclusion, package.json dependency records for prod/dev/peer/optional sections, conservative Python file/symbol/chunk records for class/function/method declarations, Python import edges to external modules, Python direct same-file call edges, route records for clear TS/JS router calls, Next.js app route modules, and Python route decorators, simple path-based test mapping records, resolved file-to-file import edges for relative TS/JS imports and simple `tsconfig`/`jsconfig` path aliases, direct calls through named relative and aliased TS/JS imports, conservative same-named default-import call edges, same-file TS/JS member calls through `this` and known local class instances, cross-file TS/JS member calls through imported class instances, CLI `run`/`index` artifact creation commands from flags or request JSON with JSON or split-artifact output, and conservative capability metadata that does not advertise incremental support before previous-artifact reuse exists. Previous-artifact reuse remains a future/high-scale enhancement outside the #11 MVP definition of done. |
| #12 Index importer | Done | `packages/index-importer`, `packages/index-importer/test/index-importer.integration.test.ts`, `packages/db`, `apps/worker/src/index.ts`, `HEIMDALL_DB_TEST_URL=postgres://postgres:postgres@localhost:5432/review_agent pnpm --filter @repo/index-importer test -- test/index-importer.integration.test.ts` | Importer persists index versions, files, symbols, edges, chunks, diagnostics, dependencies, routes, test mappings, and durable embedding jobs idempotently; includes filesystem/file-URI and S3/R2-compatible whole-artifact resolvers, an S3/R2-compatible whole-artifact store for URI handoffs, plus filesystem split-layout resolution for `index-manifest.json` and streamed `records.jsonl`; exposes `importIndexArtifactFromUri` for URI-first handoff paths; and the worker uses that URI-first path for locally persisted and object-storage-uploaded index artifacts. S3/R2-compatible object-storage mode can server-side copy remote indexer artifact objects into the configured Heimdall bucket before import; normalized record plus embedding planner item writes are bounded into configurable insert batches; normalized record writes flow through an internal Drizzle batch writer abstraction; worker imports can tune those insert batches with `HEIMDALL_INDEX_IMPORT_RECORD_BATCH_SIZE` or `INDEX_IMPORT_RECORD_BATCH_SIZE`; import attempts write durable `index_import_batches` phase/outcome rows; configurable import limits reject oversized artifacts before DB record writes while split JSONL readers enforce line/count limits during streaming reads; and a Postgres-backed integration test verifies a valid artifact imports normalized rows, resolves as the latest ready index, creates durable embedding jobs/items/background jobs, records completed import-batch state, and re-imports idempotently. Deferred COPY paths, generic staging tables, and broader bulk object paths remain outside the MVP cut. |
| #13 Embedding pipeline | Done | `packages/embedding`, `packages/embedding/test/embedding.test.ts`, `apps/worker/src/index.ts`, `packages/db/src/schema/tables.ts`, `pnpm --filter @repo/embedding test`, `HEIMDALL_EMBEDDING_SMOKE_ALLOW_LIVE=true OPENAI_EMBEDDING_DIMENSIONS=1536 pnpm smoke:embedding:openai` | Durable embedding jobs are handled by the worker, deterministic 1536-d embeddings are stored in pgvector, vector dimensions are validated, progress is cumulative, code chunk embedding inputs include stable metadata headers, SHA-256 input hashes, conservative token estimates, truncation, provider request batching, an OpenAI-compatible Embeddings adapter with bounded retry/backoff for transient HTTP and fetch failures, worker environment selection with SecretRef-backed API-key resolution, cache-key metadata columns, durable vector reuse by provider/model/dimension/input hash/profile, idempotent `embedding.token` usage events with provider-returned token counts when adapters expose them plus estimated fallback cost metadata, `embedding_jobs`/`embedding_job_items` planner rows with worker progress updates, product-safe metrics/traces, an exported embedding job reconciliation primitive plus durable `embedding.repair.v1` worker handling, scheduled delayed repair backstops from index imports, repair-triggered requeue for item rows that claim embedded without matching vectors, product-safe repair detection counts for incompatible and orphaned vector rows, targeted cleanup for wrong-dimension, stale-profile, stale-provider, and unambiguous orphaned vector rows, a guarded OpenAI-compatible live embedding smoke runner/runbook, and admin/debug embedding job visibility from background job inspection. The live embedding smoke passed on May 8, 2026 with `text-embedding-3-small`, 1536 dimensions, and provider token usage. |
| #14 Retrieval engine | Done | `packages/retrieval`, `packages/review-orchestrator/src/index.ts`, `packages/retrieval/test/retrieval.test.ts`, `packages/admin-tools/src/index.ts`, `apps/web/src/main.ts`, `923f4bf` | Retrieval uses imported index rows for same-file, diff-line changed-symbol detection, graph, exact test mappings with filename fallback, changed-manifest dependency context, changed-file route/config context, repository-rule context, PostgreSQL full-text, and vector-backed context with diff fallback, validates returned context bundles against the shared TypeBox contract, records non-fatal warnings when optional indexed retrievers fail, merges duplicate snippet candidates with deterministic weighted rank fusion, records product-safe selected/dropped ranking and token-budget packing summaries, persists product-safe retrieval trace artifacts from review orchestration, exposes dashboard retrieval replay inspection for selected context items and warnings, and has fallback fixture coverage for added, modified, deleted, and renamed file status handling. |
| #15 PR snapshot and diff model | Done | `packages/pr-snapshot`, `packages/pr-snapshot/test`, `packages/github`, `packages/review-orchestrator/src/index.ts`, `packages/review-engine/src/index.ts`, `packages/db/src/repositories/pull-request-repository.ts` | Webhook payload normalization creates shallow snapshots, the GitHub provider can fetch full changed-file snapshots and returns the exact raw diff alongside snapshots while delegating raw diff hashing plus hunk modeling to `@repo/pr-snapshot`, review orchestration refreshes persisted snapshots for a fetched head SHA and persists raw-diff, line-anchor-index, and change-set review artifacts through `@repo/pr-snapshot` helpers, and `@repo/pr-snapshot` parses unified diffs into provider-neutral changed-file contracts with raw diff hashing, canonical snapshot hashing, quoted Git path handling, copied-file and mode-only metadata handling, golden fixture coverage for added/deleted, multiple-hunk, no-newline, and zero-line range diffs, commentable line and file-level fallback indexes, GitHub review-comment anchor conversion for verified single-line, same-side same-hunk multiline, and file targets, and deterministic change-set extraction for ranges, modified blocks, path sets, and renames. Mixed-side multiline expansion remains a post-MVP future upgrade per the phase spec. |
| #16 Review orchestrator | Done | `packages/review-orchestrator`, `packages/artifacts`, `apps/worker/src/index.ts`, `packages/observability` | Worker handles `pr.review.v1`, fetches and persists full PR snapshots with provider raw diff when available, compiles immutable review policy and plan snapshots, gates ineligible PRs with durable skip reasons before quota/index/LLM work, derives and stores raw-diff, line-anchor-index, and change-set artifacts, reserves monthly review credit quota before expensive review work, syncs the head workspace, optionally retains the checkout for static-analysis execution, persists static-analysis reports as review artifacts, includes static-analysis synthesis findings in candidate generation when a report exists, transitions `review_runs.status` through index wait, retrieval, review, validation, and publish handoff states, waits briefly for a fresh ready index, idempotently enqueues the same review-owned index job key as webhook planning when no fresh index is ready, supports opt-in `HEIMDALL_REVIEW_INDEX_DEPENDENCY_MODE=pause` so missing indexes keep the review run in `waiting_for_index`, releases reserved quota, and lets durable job retry or dependency-ready requeue resume later, requeues waiting review runs after a completed index import with an idempotent dependency-ready review job, builds and persists indexed retrieval context bundles when available, persists product-safe retrieval trace artifacts without duplicating snippet text, calls the LLM-backed `@repo/review-engine` pass through a usage-recording gateway wrapper, persists candidate and policy-aware validated/rejected findings, stores review artifacts through the `@repo/artifacts` payload store boundary with DB-inline fallback descriptors plus optional filesystem or S3/R2-compatible payload storage, checks current PR state after snapshot, after index wait, before review, and before publish handoff, marks moved/closed runs as superseded/skipped without enqueueing publisher work, supports review-job dry runs that persist the full review pipeline output and publish plan but skip `review.publish.v1`, records per-stage timeline events and failure-stage metadata, emits product-safe structured stage logs and low-cardinality stage metrics with review run, repo, PR, head SHA, and job context when worker observability is configured, emits idempotent `review.run`, `review.credit`, and `llm.token` usage events, consumes quota after successful reviews, completes the review run, and enqueues `review.publish.v1` for non-dry-run publishable reviews. Complex replay modes and advanced cancellation propagation remain outside the #16 MVP cut. |
| #17 LLM gateway | Done | `packages/llm-gateway`, `packages/llm-gateway/test/llm-gateway.test.ts`, `packages/review-orchestrator/src/index.ts`, `packages/db/src/schema/tables.ts`, `apps/worker/src/index.ts`, `packages/admin-tools/src/live-openai-llm-smoke.ts`, `docs/runbooks/llm-provider-smoke.md`, `pnpm --filter @repo/llm-gateway test`, `HEIMDALL_LLM_SMOKE_ALLOW_LIVE=true HEIMDALL_LLM_SMOKE_MODEL=gpt-4.1-mini pnpm smoke:llm:openai` | Schema-validating structured-output gateway, deterministic static adapter, fixture-backed fake provider, normalized gateway error model, bounded retry policy, and an OpenAI-compatible Chat Completions provider for JSON-mode structured review findings exist. The gateway redacts secret-like prompt content before provider calls by default, stamps review-finding calls through a versioned prompt registry, supports task/profile model routing, and enforces optional product-safe prompt/input character budgets before provider execution. Review orchestration records successful model-call rows from the same redacted prompt text with provider/model, prompt/response hashes, prompt version, token estimates, latency, rate-card metadata, and cost, and stores linked redacted LLM prompt/response review artifacts for replay/debug inspection. The worker can select the real provider with `LLM_PROVIDER=openai` plus `OPENAI_MODEL`/`LLM_MODEL` and SecretRef-backed API-key configuration while keeping the smoke gateway as explicit `HEIMDALL_REVIEW_SMOKE_FINDING=true` mode, can route `review.findings` to `HEIMDALL_LLM_REVIEW_FINDINGS_MODEL`, and can configure LLM input budgets through environment variables. Admin tooling includes a guarded OpenAI-compatible live LLM smoke runner and runbook that exercise schema-valid review findings without printing API keys, prompts, raw responses, or customer data; the live smoke passed on May 8, 2026 with `gpt-4.1-mini` and zero findings for a no-op diff. No package outside gateway/embedding provider construction imports a model provider SDK directly. |
| #18 Review passes | Done | `packages/review-engine`, `packages/review-orchestrator/src/index.ts` | `@repo/review-engine` exports a typed `ReviewPass` boundary, a high-level `ReviewEngine` facade, an MVP `ReviewPassRegistry`, registered summary, behavior, correctness, security, test-coverage, static-tool synthesis, and judge pass entries, deterministic boundary pass, structured pass execution results with opt-in failure isolation, structured MVP PR-summary, behavior-change, and deterministic pre-validation judge outputs, LLM-backed review passes that consume retrieval context and filter findings by pass focus, static-analysis synthesis that converts changed-line tool diagnostics into candidate findings when a static-analysis report exists, review pass modes, conservative review budgets, deterministic pass selection for documentation-only, source, security-sensitive, strict, security-only, tests-only, dry-run, and off modes, trusted/untrusted prompt-block labels that instruct model passes not to follow customer-provided PR, diff, or retrieved-context instructions, deterministic MVP golden coverage for no-finding, correctness bug, security, missing-test, and prompt-injection fixtures, and review orchestration now invokes `ReviewEngine` while persisting a linked pass-result `review_output` artifact. Richer model-authored summaries and advanced revise-style judging remain post-MVP enhancements. |
| #19 Finding validation, dedupe, and ranking | Complete | `packages/review-engine`, `packages/review-orchestrator/src/index.ts`, `packages/db`, `packages/review-engine/test/fixtures/validation` | Candidate findings now flow through runtime schema normalization, deterministic path/file/anchor validation, evidence/context-reference checks, policy-derived severity/category/confidence gates, secret-like and unsafe-fix rejection, basic repo-rule suppression, durable memory suppression, exact, location, conservative semantic, root-cause, and previous-comment duplicate suppression, budget limiting, and ranking before persistence. `@repo/review-engine` also exposes an inspectable validation result with accepted/rejected findings, duplicate groups, rejection stats, and product-safe validation trace events while preserving the existing `ValidatedFinding[]` path. Review orchestration now supplies retrieved context, active repository and organization memory facts, and prior published findings to validation; persists durable validation-event, duplicate-group, and publish-plan rows; persists rejected-findings plus validation ranking-report artifacts that include validation stats, duplicate groups, and trace events; and writes a publish-plan artifact whose IDs are handed to the publish job only when the plan contains external publish operations. JSON fixture goldens cover valid, invalid, duplicate, suppressed, budgeted, previous-comment, secret, unsafe-fix, weak-evidence, invalid-context, invalid-path, and summary-only validation cases. |
| #20 Publisher | Done | `packages/publisher`, `packages/github`, `apps/worker/src/index.ts`, `apps/web/src/main.ts`, `packages/db/src/schema/tables.ts`, `packages/admin-tools/src/index.ts`, `packages/admin-tools/src/live-github-publisher-smoke.ts`, `packages/admin-tools/src/live-github-pr-review-smoke.ts`, `packages/admin-tools/src/live-github-provider-error-smoke.ts`, `HEIMDALL_DB_TEST_URL=postgres://postgres:postgres@localhost:5432/review_agent pnpm --filter @repo/publisher test`, `pnpm --filter @repo/github test`, `pnpm smoke:github-provider-errors` | Completed review output enqueues `review.publish.v1`; the worker handles publish jobs; `@repo/publisher` protects against stale heads, respects immutable publishing-policy metadata for check-run, inline, summary, and budget decisions, creates or updates check runs, publishes inline comments, creates or updates deduped summary comments through stable PR-level markers, parses Heimdall hidden markers for provider-side dedupe, applies conservative inline, repository, installation, and PR-summary publish throttles, falls back to summary comments when inline publish fails, records durable publish state with dashboard-visible publish run, operation, and output rows, and includes dry-run-friendly planned publish operations and throttle metadata on `PublishPlan` and completed publish-run metadata. The worker backs publish throttles with Redis sorted-set reservations, so repository, installation, and PR-summary write windows coordinate across worker processes that share Redis. Admin reconciliation can optionally read GitHub inline review comments and summary comments, parse Heimdall markers, and compare provider-visible artifacts with durable published rows. Guarded live GitHub App smoke runners cover happy-path publishing, webhook-to-publish, stale-head skip mode, and provider-error probes for read-only not-found plus opt-in invalid check-run validation; the publish and webhook smokes have published to a development PR, and `pnpm smoke:github-provider-errors` passed on May 8, 2026 with a real `github_not_found` response plus publisher error serialization. Publisher failures persist structured GitHub/provider reasons with focused coverage for permission, not-found, validation, rate-limit, and generic failures. |
| #21 Feedback and memory system | Done | `packages/memory`, `packages/memory/test/memory.test.ts`, `packages/retrieval`, `packages/db/src/schema/tables.ts`, `packages/db/migrations/0025_eminent_scrambler.sql`, `packages/admin-tools/src/index.ts`, `apps/api/src/app.ts`, `apps/worker/src/index.ts`, `apps/web/src/main.ts`, `packages/webhook-ingestion`, `packages/github` | Package now exposes typed feedback events, signals, outcome states, memory candidates/facts, hidden marker parsing, deterministic command parsing, outcome scoring, memory candidate activation, relevant memory lookup with trace/budgets, retrieval context integration, and an explainable in-memory suppression matcher. Durable `feedback_events`, `feedback_signals`, `memory_facts`, `memory_candidates`, and `suppression_matches` tables now provide the persistence foundation for provider feedback, configured memory, candidate moderation, and suppression-hit audit history; worker feedback jobs persist correlated comment/reaction/thread events and deterministic signal rows before recording provider-webhook outcomes or command-sourced candidates. The memory/rules inspector surfaces applicable candidate rows next to stored memory facts with approve/reject actions for pending candidates, scoped API moderation endpoints can approve candidates into audited durable memory facts or reject them after `memory:write` authorization, recorded finding outcomes enqueue memory update jobs that let workers propose suppression candidates from rejected findings, the product repository view now lists applicable memory candidates/facts plus recent suppression hits with approve/reject controls for users with `memory:write`, GitHub PR comment/reaction/review-thread webhooks normalize redacted feedback metadata and trusted commands into memory update jobs, worker feedback correlation now handles trusted PR-summary comment commands by linking provider comment IDs through `published_summary_comments`, scheduled memory jobs can reconcile recent GitHub review-thread state through provider GraphQL reads, the scoped finding API exposes a basic feedback timeline, the product finding detail panel displays recorded feedback events and classified signals, and validation persists auditable suppression decisions whenever approved memory prevents repeat comments. |
| #22 Repo rules and configuration | Done | `packages/rules`, `packages/rules/test/rules.test.ts`, `packages/contracts/src/api/rules.ts`, `packages/github`, `apps/api/src/app.ts`, `apps/web/src/main.ts`, `packages/webhook-ingestion/src/github/plan-jobs.ts`, `packages/review-orchestrator/src/index.ts`, `packages/review-engine/src/index.ts`, `packages/publisher/src/index.ts`, `packages/db/src/schema/tables.ts`, `pnpm --filter @repo/rules test` | `@repo/rules` compiles repository settings into immutable policy snapshots, validates policy schemas, classifies paths, evaluates PR trigger decisions, gates webhook-planned PR review work, applies finding policy decisions, evaluates memory policy permissions, maps review policies to publishing modes, stores policy snapshots as review artifacts, drives publisher mode enforcement, powers admin and product policy preview API/UI for draft settings, supports repository-scoped rules CRUD, exposes scoped organization settings API CRUD and product UI controls, exposes scoped policy-test APIs for sample path/finding decisions, exposes scoped repo-local config validation APIs for draft YAML/JSON files, applies persisted organization settings as typed defaults and guardrails during policy compilation, evaluates language, author, label, and confidence matchers for finding suppression rules, parses strict YAML/JSON repo-local config files with source path/hash metadata plus safety validation, merges allowed repo-local review/path/category/publishing/trigger/memory settings into policy snapshots while preserving org guardrails, loads allowed repo-local config from the trusted PR base SHA before review policy compilation, records warnings/traces/audit rows when PRs change enabled repo-local config files, compiles repo-local base-branch and any-label trigger filters into webhook and review-run gates, compiles safe repo-local category, severity, confidence, and scoped direct-suppression rule actions into source-attributed suppression rules, and supports repo-local rule matchers for language, author, labels, title regex, and confidence thresholds. Deferred advanced rule action coverage remains outside the MVP cut. |
| #23 Static analysis integration | Done | `packages/static-analysis`, `packages/tool-runner`, `packages/review-engine`, `packages/review-orchestrator`, `packages/admin-tools`, `apps/worker`, `pnpm --filter @repo/static-analysis test`, `pnpm --filter @repo/tool-runner test`, `pnpm --filter @repo/admin-tools smoke:static-analysis:local` | `@repo/static-analysis` exposes typed tool descriptors, changed-file-fast planning, runnable ESLint/Biome/TypeScript/Ruff/Pyright/Mypy/Semgrep/Go vet/Staticcheck/Cargo check/Cargo Clippy command specs, tool budgets, deterministic diagnostic normalization, diff-line mapping, static-analysis config-change sensitivity warnings, base/head diagnostic fingerprint comparison for new/existing/fixed baseline status, optional baseline diagnostic input during report building, ESLint JSON output parsing, Biome JSON output parsing, TypeScript `tsc --pretty false` text output parsing, Ruff JSON output parsing, Pyright JSON output parsing, Mypy text output parsing, Semgrep JSON output parsing, Go vet JSON output parsing including stderr/package-banner output, Staticcheck JSONL output parsing, and Cargo JSONL compiler-message parsing, explicit raw-output retention policy metadata, report building through a runner boundary, and sandbox context propagation for review-owned tool runs. `@repo/tool-runner` provides the typed command-runner contract, deterministic fake runner, local shell-free process runner with timeout/output budgets, and a sandbox-backed adapter that translates commands into hardened sandbox run requests with static-analysis category mapping for Python, Go, and Rust tools. `@repo/review-engine` can synthesize candidate findings from new or unbaselined changed-line static diagnostics, review orchestration can opt into static-analysis execution, artifact persistence, base/head delta runs with baseline artifact capture, and static-tool candidate generation when a runner is configured, and the worker can select fake, local-process, Docker, or gVisor sandbox-backed static analysis with `STATIC_ANALYSIS_RUNNER`/`SANDBOX_RUNNER` while persisting sandbox run summaries, artifacts, and policy decisions. Static-analysis report artifacts carry payload-free status, duration, tool-run, diagnostic, and warning counters that scoped API and dashboard artifact lists expose without reading raw payloads. Local admin smoke passed on May 8, 2026 for Go vet, Cargo check, and Cargo Clippy. Fixture-backed multi-diagnostic parser coverage covers ESLint, Biome, TypeScript, Mypy, Pyright, Ruff, Semgrep, Go vet, Staticcheck, and Cargo JSONL/text outputs. |
| #24 Sandbox execution | Partial | `packages/sandbox`, `packages/tool-runner`, `packages/db`, `apps/worker`, `packages/contracts`, `packages/rules`, `packages/admin-tools`, `apps/web`, `docs/evidence/sandbox-docker-smoke-proof.json`, `pnpm smoke:sandbox:docker` | `@repo/sandbox` now defines the v1 run request/result contracts, trust levels, execution categories, workspace/command/image/environment/mount/network/limits/security/output/artifact policies, default hardened policy values, bounded output normalization/redaction helpers, baseline safety decisions, tool-specific policy evaluation for image allowlists, argv prefixes, network denial, resource maximums, writable paths, secret-looking env vars, unsafe path arguments, and dependency-install commands, Docker command-builder data for hardened no-network container execution, a deterministic fake runner for tests, an explicitly unsafe local-process runner for local development that rejects production construction while still enforcing schema/policy checks, and Docker/gVisor runners that materialize isolated output mounts, execute shell-free Docker argv through an injectable executor or the Docker CLI, enforce timeout/output mapping, collect declared artifacts into durable local file-URI roots, and clean transient run directories. `@repo/tool-runner` now includes `createSandboxToolRunner`, which builds shell-free sandbox requests with explicit env, hardened network/security/output defaults, read-only workspace mounts, writable tmp/output mounts, review/static-analysis metadata, and bounded result mapping back to the generic tool-runner contract. Repository settings now support optional persisted sandbox policy overrides, and `@repo/rules` compiles safe sandbox defaults plus repo-level overrides and MVP clamps into the immutable review policy snapshot. `@repo/db` now has generated migration coverage for `sandbox_runs`, `sandbox_artifacts`, `sandbox_policy_decisions`, and repository sandbox settings, and the worker persists sandbox request/result summaries into those tables when a DB-backed worker runtime creates the runner. Admin review inspection and the operator sandbox history view now surface persisted sandbox run summaries, artifact metadata, policy decision counts, output hashes, and sandbox failures without loading raw outputs. Admin and product dashboard settings now expose editable sandbox policy controls backed by the settings patch APIs. The admin API and operator dashboard can enqueue scoped sandbox cleanup jobs with dry-run defaults and audit records. The worker also handles bounded `sandbox.cleanup.v1` jobs for stale run and local artifact cleanup, and maintenance-capable workers enqueue idempotent recurring sandbox retention cleanup jobs. A root local Docker sandbox smoke now exercises a no-network, read-only-root, non-root container and verifies artifact collection from the writable output bind mount with committed product-safe proof. Deployed staging smoke evidence remains. |
| #25 Observability | Partial | `packages/observability`, `apps/api/src/app.ts`, `apps/api/src/index.ts`, `apps/admin-gateway/src/index.ts`, `apps/worker/src/index.ts`, `packages/llm-gateway`, `packages/retrieval`, `infra/observability` | Structured admin control-plane telemetry exists for auth denial, login, logout, replay dispatch, settings mutations, memory/rules inspection, and billing checkout/portal session creation. `@repo/observability` now also exposes typed observability runtime configuration, redaction flags, OTLP/console/none exporter selection, trace sample rates, metrics interval parsing, service resource attributes, no-op/console runtime bootstrap handles, service-name defaults, product-safe structured JSON log entries, structured metric points, structured span records, metric label sanitization, startup lifecycle metric names, API request metric/span names, webhook delivery metric/span names, queue job metric names, LLM gateway metric/span names, retrieval metric/span names, durable job, worker maintenance scheduler, and review pipeline span/metric names, trace-context normalization/header helpers, attribute sanitization, redaction helpers, safe error classification/serialization, and validation errors. API, admin-gateway, and worker startup paths initialize the runtime with stable service identities and shutdown flushing hooks; API and webhook enqueue paths attach normalized trace context to durable job envelopes; API request-boundary counters, duration histograms, and server spans run through the shared facade; admin-gateway request handling now propagates request IDs and emits low-cardinality request counters, duration histograms, and spans; and GitHub webhook delivery counters, duration histograms, duplicate/rejection counters, and provider delivery spans stay product-safe. Worker job processors emit product-safe durable job spans plus low-cardinality job start/completion/failure/retry counters and duration histograms, review orchestration emits product-safe stage spans while propagating trace context into publisher handoff jobs, maintenance schedulers emit low-cardinality scheduled-job and scheduler-failure counters, default worker review LLM calls now emit product-safe call, duration, retry, rate-limit, structured-output-failure metrics plus gateway client spans, and retrieval now emits product-safe request, duration, source-candidate, context-item, and context-token metrics plus build-context spans. API liveness/readiness probes now expose product-safe health responses with config, Postgres, and Redis readiness checks, and the operator overview surfaces the same readiness checks for runtime health visibility. OTLP mode now bootstraps OpenTelemetry log, metric, and trace providers with bounded batch processors, per-signal OTLP HTTP endpoints, resource attributes, sampling, global provider registration, and shutdown flushing behind the existing product-safe facades. Local Grafana provisioning now includes Prometheus/Tempo datasource UIDs plus starter dashboards for API, queue, review pipeline, LLM/retrieval, indexing/embedding, publishing, and webhook delivery, and local Prometheus now loads starter rules for API error rate, webhook failures, review queue retries, review failures, publishing failures, LLM provider outages, indexing failures, and sandbox violations. API, admin-gateway, and worker process startup/shutdown/maintenance/indexer-capability logs now use structured telemetry instead of direct console writes. Additional pipeline/service instrumentation remains. |
| #26 Evaluation harness | Done | `packages/evaluation`, `packages/evaluation/src/cli.ts`, `packages/evaluation/test/evaluation.test.ts`, `packages/evaluation/fixtures/smoke-full-pipeline-v1.json`, `packages/evaluation/fixtures/smoke-full-pipeline-v1-baseline-report.json`, `pnpm eval:ci`, `packages/db/src/schema/tables.ts`, `packages/contracts/src/api/evaluation.ts`, `apps/api/src/app.ts`, `apps/web/src/main.ts`, `.github/workflows/evaluation-history.yml` | MVP deterministic suite runner, 12 curated cases, exact finding matching, anchor grading, retrieval recall, latency/cost metrics, Markdown/JSON/JUnit/HTML reports, CI threshold gate, checked-in smoke baseline report, baseline metric deltas, case-level comparison rows, lost/new true positive detection, new/resolved false positive detection, CI-safe comparison Markdown, CLI baseline comparison with default nonzero regression exits, eval history DB schema, eval history repository writes/queries, optional CLI history persistence, reviewed production-case import helpers, human-label schema/file helpers, CLI label import/export, scheduled eval history workflow wiring, read-only admin eval history API routes, and an operator dashboard view for suites, runs, and case results exist. Broader live-model suites, adjudication, and labeling UI workflows remain outside the 26A MVP cut. |
| #27 Security and compliance layer | Partial | `packages/security`, `packages/artifacts`, `packages/contracts/src/jobs/payloads.ts`, `packages/contracts/src/security/data-deletion.ts`, `packages/queue/src/index.ts`, `packages/review-orchestrator/src/index.ts`, `apps/api/src/app.ts`, `apps/worker/src/index.ts`, `packages/github/src/webhook-signature.ts`, `packages/webhook-ingestion/src/github/handler.ts`, `packages/webhook-ingestion/src/github/plan-jobs.ts`, `packages/repo-sync/src/index.ts`, `packages/admin-tools/src/compliance-evidence.ts`, `packages/admin-tools/src/cli.ts`, `packages/db/src/schema/tables.ts`, `packages/db/src/repositories/data-deletion-repository.ts`, `packages/db/src/repositories/compliance-evidence-repository.ts`, `packages/db/test/data-deletion-repository.integration.test.ts`, `packages/db/test/compliance-evidence-repository.integration.test.ts`, `packages/db/migrations/0018_parallel_peter_parker.sql`, `packages/db/migrations/0028_chubby_rockslide.sql`, `packages/db/migrations/0029_breezy_sugar_man.sql` | `@repo/security` provides admin identity assertion verification, signed admin session cookies, CSRF helpers, product RBAC helpers, data classification helpers, artifact security metadata contracts, retention classes, default retention policy, artifact retention-class mapping, retention decision calculation, normalized security event contracts, safe metadata sanitization, default severity/alert helpers, memory/no-op sink boundaries, stable compliance control IDs, evidence types, product-safe compliance evidence descriptor helpers, and a SecretRef/SecretsManager abstraction with local env resolution, AWS Secrets Manager resolution through SigV4-signed `GetSecretValue` requests, environment-built provider routing, unsupported-provider placeholders for unwired providers, redacted resolved-secret helpers, and rotation record contracts. The worker resolves its GitHub App private key through that secret boundary using `GITHUB_APP_PRIVATE_KEY_SECRET_REF` with local env fallback and resolves LLM and embedding provider API keys through SecretRef configuration or local environment fallbacks. The API resolves GitHub webhook secrets through the same boundary using `GITHUB_WEBHOOK_SECRET_REF`, supports previous-secret fallback for rotation, and records the matched webhook secret version in durable webhook metadata. The default API and worker runtimes now build provider-routing managers from environment variables, enabling AWS secret refs when `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and an AWS region are configured. Repo sync keeps Git remotes credential-free and supplies short-lived clone credentials through a temporary askpass helper that is removed after fetch. Review orchestration now stamps persisted review artifacts with retention metadata and `retention_until`, artifact payload stores support inline, filesystem, and S3/R2-compatible payload deletion, and the worker handles `review_artifact.cleanup.v1` jobs that delete expired payload bytes or inline payload metadata while leaving product-safe tombstone rows. The API emits product-safe admin auth/access denial events, invalid GitHub webhook signature security events, and critical cross-tenant admin scope-denial events into an injected security-event sink, the production API entrypoint persists those events to the durable `security_events` table through a Postgres-backed sink, and scoped audit viewers can search persisted security events through the admin API and operator dashboard. Data-deletion request contracts now define request reasons, scopes, states, product-safe manifests, and `data_deletion.plan.v1` jobs. `DataDeletionRepository` persists, lists, and transitions scoped deletion requests through the generated `data_deletion_requests` table; it also resolves deletion repository scopes, selects review artifact payloads, deletes repo embeddings, cancels pending/queued durable jobs, and disables scoped repositories with Postgres-backed integration coverage. GitHub installation removal webhooks now mark the local installation deleted and enqueue a security-queue deletion-planning job, while security-role workers can plan the request and, unless dry-run, execute it by tombstoning review artifact payloads through the artifact store, cleaning sandbox runs, deleting code-chunk embeddings, canceling pending durable jobs, disabling scoped repositories, and completing the request with verification metadata. Worker data-deletion completion/failure events, compliance-evidence collection completion/failure events, and sandbox-backed static-analysis policy denials now persist through worker security-event sinks. `ComplianceEvidenceRepository` now persists and lists scoped compliance evidence records through the generated `compliance_evidence` table with control/type/status/source/search filters, and `@repo/admin-tools` now collects product-safe access-review, audit-log, security-event, and config-snapshot evidence artifacts through memory or filesystem artifact stores before recording durable evidence rows; the admin CLI exposes those collectors through `admin compliance collect` for filesystem-backed evidence export workflows, security-role workers can execute durable `compliance_evidence.collect.v1` jobs for scheduled or operator-triggered collection, and maintenance-capable workers enqueue one idempotent recurring compliance evidence collection job per configured schedule bucket. Additional managed secret providers, provider-side remote deletion, and broader non-API security event producers remain. |
| #28 Usage and billing | Partial | `packages/usage`, `packages/billing`, `packages/review-orchestrator/src/index.ts`, `packages/db/src/schema/tables.ts`, `packages/contracts/src/usage/usage-event.ts`, `packages/contracts/src/usage/entitlements.ts`, `packages/contracts/src/usage/quota.ts`, `apps/api/src/app.ts`, `apps/web/src/main.ts` | Usage event schema exists, and `@repo/usage` now provides a typed append-only ledger boundary with deterministic idempotency keys, an in-memory store, a Postgres store, rollup summarization, correction-event support, customer-safe billing-period summaries for usage, review-credit allowances, meter rows, invoices, and opt-in internal cost fields, quota decision helpers, monthly quota counters/reservations, versioned LLM token rate-card cost estimation, seeded plan catalog compilation, provider-free plan snapshots, entitlement decisions, local billing account summaries with subscription, subscription item, credit grant, and invoice mirrors, usage-based billing meter planning/sending with retry state, and billing reconciliation repair for provider subscription mirrors, monthly review-credit quota counters, and pending meter sends. `@repo/billing` defines the provider-neutral billing adapter, a fake provider for local checkout/portal/webhook/meter tests, and a Stripe adapter for customer, Checkout Session, Customer Portal Session, subscription-read, meter-event, webhook-parse, and provider request logging boundaries. The API records inbound Stripe webhook events and idempotently syncs subscription, invoice, and payment-status mirrors. Review orchestration records completed PR reviews as idempotent `review.run` and `review.credit` usage events, consumes reserved monthly review credits after successful reviews, and records successful review-model calls as idempotent `llm.token` usage events; embedding workers record cache-miss provider batches as idempotent `embedding.token` usage events with estimated internal cost metadata. The admin API/dashboard expose scoped usage rollups, plan/entitlement inspection, billing account inspection, quota warnings, invoice and portal support links, billing meter event debug rows, billing reconciliation issues for meter lag/failures, failed webhooks, failed provider requests, quota counter drift, and usage-cost anomalies, and an operator action that enqueues a durable billing reconciliation job. Remaining customer self-serve billing views, automated metered sync scheduling, and invoice reconciliation jobs are intentionally tabled until the final project pass unless a thin usage/quota stub blocks non-billing work. |
| #29 Admin and internal tooling | Done | `packages/admin-tools`, `apps/api/src/app.ts`, `apps/web/src/main.ts`, `packages/db/src/schema/tables.ts`, `packages/admin-tools/test`, `scripts/control-plane-production-readiness.ts`, `docs/runbooks/admin-control-plane.md`, `docs/evidence/admin-control-plane-staging-proof.json`, `HEIMDALL_DB_TEST_URL=postgres://postgres:postgres@localhost:5432/review_agent pnpm --filter @repo/admin-tools test` | Publisher dry-run, reconciliation reports, admin-debug inspectors for webhook/job/review/publisher state, repository-scoped memory/rules inspection, review-run usage/cost inspection for usage ledger rows, billable units, quota reservations, and fixed USD cost summaries, structured failure normalization, replay plans, confirmed durable replay dispatch with completed admin action, audit log, and replay run rows, audited failed-job and webhook requeue through the inspectors, non-mutating retrieval and validation replay dry-runs through the admin-tools package, CLI, admin API, and dashboard, audited redacted review debug bundle export with durable admin action/debug export rows, audited eval import draft creation with completed admin action rows, local admin CLI inspect/replay/export/dry-run/usage commands, named support/admin access, replay audit logging, operator dashboard views, Railway staging proof, production readiness runbook, and production-readiness gate exist. Deferred advanced support workflows remain outside the MVP cut. |
| #30 Deployment and infrastructure | Partial | `compose.yaml`, `infra/`, `scripts/validate-production-deployment.ts`, `.github/workflows/ci.yml` | Local Postgres, Redis, and MinIO object storage exist, and the initial Railway production deployment manifest, Railway config-as-code files, role-specific Railway worker service configs for general, index, review, embedding, publisher, and maintenance workers, SecretRef/AWS secret-resolution environment requirements for production API/worker services, object-storage review artifact environment requirements for API/worker services, production review artifact privacy/encryption policy, worker runtime environment audit coverage, worker-scheduled retention cleanup jobs, production dashboard coverage, post-release follow-up tracking, and deployment audit gate are codified and wired into CI. Provider-managed rollout execution remains. |
| #31 Testing and evaluation strategy | Done | `pnpm check`, `pnpm eval:ci`, `pnpm ci:control-plane:release`, `.github/workflows/ci.yml`, `.github/workflows/evaluation-history.yml`, `test/ci-workflow.test.ts`, `test/package-test-coverage.test.ts`, `test/app-test-coverage.test.ts`, `test/workspace-tsconfig.test.ts`, `test/workspace-structure.test.ts`, `apps/marketing/src/marketing-page.test.tsx`, `apps/web/src/api-client.test.ts`, `apps/web/src/dashboard-boundaries.test.ts`, `packages/evaluation/test/evaluation.test.ts`, `packages/evaluation/fixtures/smoke-full-pipeline-v1-baseline-report.json`, package tests | Unit tests, package and app test coverage guards, root TypeScript project-reference coverage guards, workspace structure guards, marketing page content-contract coverage, dashboard API client and source-boundary guards, Postgres-backed migration/review integration tests in CI, release gates, fake PR review integration coverage, the deterministic evaluation threshold gate, checked-in baseline comparison gate, scheduled eval-history workflow wiring, and CI upload of deterministic eval Markdown/JSON/comparison reports now run for new work. Root workflow tests guard the release gate script path, report artifacts, pgvector test database wiring, scheduled eval-history persistence flags, fake GitHub/static-LLM PR review coverage, eval baseline comparison wiring, and representative redaction/cross-tenant tests. Evaluation package tests run the real Bun CLI against a regressed candidate report and verify both default failure and report-only output. The local control-plane release gate passed on May 8, 2026. |

## Current Completion Notes

- Latest database milestone: `pnpm --filter @repo/admin-tools smoke:db:vector` now starts from an
  isolated schema on local Postgres, applies all 27 generated migrations, verifies `pgcrypto` and
  `vector` extensions, inserts two code chunk embeddings, and confirms the expected chunk ranks
  first with a pgvector nearest-neighbor query.
- Latest DB background-job milestone: `BackgroundJobRepository` now supports idempotent durable
  job insert, pending dispatch reads, job ID lookup, queue/job-key lookup, job-key batch listing,
  worker lifecycle transitions, durable cancellation, and stale-running recovery, plus review-run
  related-job listing and embedding-job cleanup for failed index imports. `@repo/queue` now
  delegates its Drizzle-backed durable job store to this repository boundary, GitHub webhook
  ingestion now uses it for planned-job persistence, review orchestration now uses it for
  index-dependency and publish handoff jobs, the worker uses it for index-completion review resume
  and embedding repair batch jobs, index imports use it for embedding batch jobs, delayed repair
  jobs, and failed-import job cleanup, the API uses it for admin/product job enqueues and
  review-run related-job summaries, admin tooling uses it for job debug reads, replay job
  insertion, replay related-job lookup, job cancellation, and publisher related-job summaries, and
  the Postgres-backed integration test verifies insert idempotency, scheduled pending filtering,
  running/completed/canceled/missing lifecycle states, retry error storage, cancellation protection,
  and stale retry/dead-letter repair. The admin API and dashboard now expose scoped, audited
  background-job cancellation for pending, queued, or running durable jobs.
- Latest worker queue-role milestone: `apps/worker` now honors `HEIMDALL_WORKER_ROLE` or
  `WORKER_ROLE` values such as `review`, `index`, `embedding`, `publisher`, comma-separated role
  sets, `all`, and `maintenance`, so separate worker processes can register only the queues they
  should consume while sharing the same outbox dispatcher and stale-job recovery loops. Unit tests
  cover default all-queue mode, role combinations, the Heimdall-specific override, maintenance-only
  mode, and unsupported-role rejection.
- Latest worker queue-health milestone: `apps/worker` now samples BullMQ queue health from all-role
  or maintenance-role runtimes, emitting low-cardinality gauges for per-status queue depth and
  oldest pending job age through `@repo/observability`, and persists normalized
  `queue_health_snapshots` rows through `QueueHealthRepository` so dashboards and admin tools can
  inspect recent queue state without reading Redis. Unit and Postgres-backed integration tests cover
  depth normalization, deterministic oldest-job-age emission, snapshot persistence, and recent
  snapshot listing.
- Latest durable queue cancellation milestone: `@repo/queue` now passes durable heartbeat and
  cancellation helpers into worker handlers, treats canceled or superseded running rows as
  cooperative exits, and avoids overwriting canceled/completed durable rows after checkpoints.
  Worker handlers now call those checkpoints before high-cost sync, index, import, embedding,
  review, publish, feedback, billing reconciliation, sandbox cleanup, and artifact cleanup work.
  Focused queue and worker tests cover cooperative checkpoint exit behavior and cancellation before
  embedding provider calls.
- Latest index-importer milestone: `packages/index-importer` now has a Postgres-backed integration
  test that imports a valid artifact through the public importer, verifies ready index lookup,
  normalized file/symbol/edge/chunk rows, durable embedding job/item/background-job planning,
  completed import-batch state, and safe idempotent re-import. This closes the #12 MVP gap while
  keeping COPY/staging and broader bulk-object paths deferred.
- Latest evaluation milestone: `#26` is now tracked as done for the 26A MVP cut because the
  deterministic fixture runner, 12-case smoke suite, matching/grading, cost/latency metrics,
  CI-safe reports, threshold gate, baseline comparison, local artifact output, history persistence,
  admin/dashboard history reads, and raw-content redaction coverage are already implemented. Live
  model suites, adjudication, and labeling UI workflows remain advanced 26B work.
- Latest contract milestone: `#0` is now tracked as done because the contracts package has the
  complete MVP boundary surface, validates representative fixtures and invalid inputs at runtime,
  re-exports index artifact schemas and validators from `@repo/index-schema` without phase-local
  copies, documents imports and schema versioning, and has a package-boundary guard that prevents
  implementation-package dependencies.
- Latest API milestone: `#5` is now tracked as done for the MVP control-plane scope because the
  API route suite covers health/readiness/OpenAPI, webhooks, product OAuth sessions, scoped
  product/admin auth, RBAC, validation, CSRF, rate limits, repository settings and job enqueueing,
  review/finding/rules/memory/usage/debug routes, redacted artifact access, support-session raw
  access, and audited state changes. The workspace boundary gate now also prevents `@app/api` from
  depending on worker-side execution packages such as repo sync, indexing, embedding, retrieval,
  review orchestration, publishing, sandboxing, static analysis, tool runners, and LLM gateway.
- Latest dashboard milestone: `#6` is now tracked as done for the MVP dashboard scope because the
  product console covers org selection, repository enablement/settings, rules, policy preview,
  review history/detail, findings, artifact access, memory, and usage cards, while the operator
  console covers inspectors, replay/cancel controls, debug bundle export, eval import drafts,
  settings/rules, audit/security/evaluation history, and internal support views. Web tests now
  cover the typed API client, source boundaries, primary MVP renderers/actions, loading/empty/error
  states, and dangerous-action confirmation paths.
- Latest DB billing milestone: `BillingRepository` now owns outbound provider request audit
  logging, failed provider-request listing, billing meter event listing, failed-or-stale meter sync
  reads, and failed billing webhook reads. The API and worker use this boundary for Stripe provider
  request audit logging, the API uses it for billing meter debug reads plus billing reconciliation
  issue reads, and the Postgres-backed integration test verifies idempotent request-key updates,
  org-scoped failed request ordering, meter-event filters, sync issue selection, failed webhook
  ordering, and bounded list validation.
- Latest DB product-auth milestone: `ProductAuthRepository` now owns OAuth state create/consume,
  provider-account lookup, OAuth user/account upsert, active session read, membership listing,
  session revoke, and existing-user lookup. The API now uses this repository boundary for product
  OAuth login/session flows and FK-backed decision user lookup, with Postgres-backed integration
  coverage for one-time state consumption, identity-link preservation, and session revocation.
- Latest DB security-audit milestone: `SecurityAuditRepository` now owns artifact access event
  writes, idempotent normalized security event writes, audit log insertion, filtered audit log
  listing, and filtered security event listing. The API uses this repository boundary for sensitive
  review-artifact access logging, security event sink writes, admin audit writes, and admin
  audit/security inspection reads, with Postgres-backed integration coverage for duplicate
  security-event handling, inserted artifact/audit rows, filtered searches, ordering, and bounded
  list validation.
- Latest DB repository milestone: `RepositoryRepository` now supports provider-native repository
  lookup, owning-org lookup, provider-ref lookup with installation metadata, deterministic
  enabled-repository cursor pagination, batch repository/settings/org-default reads, provider
  metadata upserts that preserve product enablement, and insert-if-absent default repository
  settings, and bounded scoped repository discovery. `ProviderInstallationRepository` now supports
  durable installation lookup, active visible-organization reads, recent installation reads, and
  scoped admin discovery. GitHub webhook ingestion uses the repository boundary for repository
  planning state and repository/settings persistence, `@repo/embedding`, index imports, and admin
  tooling use it for org scope lookup, publisher, review orchestration, the worker, and admin
  tooling use it for GitHub repository references or provider-feedback org scoping, the API uses it
  for admin repository discovery, admin tooling uses it for memory/rules repository summaries, and
  the API and worker use the provider-installation boundary for product session installation
  visibility, onboarding installation summaries, admin installation list/detail reads, and GitHub
  installation runtime refs. The Postgres-backed integration test
  applies the current migration chain in
  an isolated schema and verifies provider lookup, owning-org lookup, provider-ref lookup with
  installation scoping, enabled-only filtering, org scoping, cursor advancement,
  cursor/limit validation, enablement preservation, insert-if-absent settings behavior, batch
  settings lookups, bounded scoped repository discovery, active visible installation reads, recent
  installation reads, and scoped provider-installation discovery.
- Latest DB webhook milestone: `WebhookRepository` now maps durable deliveries back to the webhook
  contract and supports provider-delivery idempotent insert, delivery lookup, product activity
  summary reads, and processing/processed/ignored/failed state transitions. GitHub webhook
  ingestion now uses this repository boundary for delivery idempotency, the API uses it for product
  onboarding webhook summaries, and the Postgres-backed integration test verifies conflict-safe
  inserts, status/error updates, and activity summary counts.
- Latest DB pull request milestone: `PullRequestRepository` now upserts immutable pull request
  snapshots and mutable PR state together. GitHub webhook ingestion now uses this repository
  boundary for PR persistence, and the Postgres-backed integration test verifies snapshot refresh,
  mutable state updates, provider lookup, and repo/number idempotency.
- Latest DB index-version milestone: `IndexVersionRepository` now supports ready index lookup by
  repo/commit/index key, latest-ready lookup by repo/commit, idempotent create/update, and
  importing, ready, and failed state transitions, plus DB-only inspection records with extended
  imported-entity counts and artifact-import idempotency lookups. The Postgres-backed integration
  test verifies the current migration chain plus terminal counts, inspection-count mapping,
  importer-specific lifecycle transitions, and structured failure mapping. Review orchestration,
  index imports, and admin tooling now use this repository boundary for ready-index polling,
  index-import lifecycle reads/writes, and index-version inspection reads.
- Latest DB memory milestone: `MemoryFactRepository` now owns active repository and organization
  memory fact reads for review validation, repository-scoped inspection reads, single-row lookups,
  conflict-safe fact creation, fact updates, and fact disabling, including status, expiration,
  scope, order, and limit handling. `MemoryCandidateRepository` now owns repository and
  organization memory candidate inspection reads, single-row candidate lookups, and candidate
  approval/rejection writes plus idempotent candidate creation for worker-proposed memory updates.
  Review orchestration now uses the memory fact repository boundary instead of importing the raw
  `memory_facts` table for validation suppression inputs, while the API, worker, and admin tooling
  use repository boundaries for repository-scoped memory fact and candidate inspection reads, API
  single-row memory lookups, API memory fact mutation paths, worker memory candidate creation, and
  API memory candidate moderation writes.
- Latest DB feedback milestone: `FeedbackRepository` now owns idempotent feedback event and signal
  creation plus published-finding feedback timeline reads. The worker uses this boundary for
  provider feedback persistence, and the API uses it for finding feedback timeline inspection.
- Latest DB review milestone: `ReviewRepository` now owns provider-feedback target lookups for
  published findings and PR summary comments plus recent completed review-run listing for provider
  thread reconciliation and waiting-for-index review-run listing for index-dependency resume. The
  repository also owns expired review artifact cleanup target selection and payload tombstone
  updates. The worker uses this boundary for provider-feedback, thread-reconciliation,
  index-dependency review-run lookup, and review-artifact cleanup paths, and the Postgres-backed
  integration test verifies ordered provider-comment target lookup, pull-request-filtered recent
  run listing, waiting-for-index listing, and artifact cleanup tombstoning.
- Latest DB sandbox milestone: `SandboxRepository` now owns sandbox run upsert with artifact and
  policy-decision child-row replacement, stale sandbox run cleanup target selection, sandbox
  artifact URI lookup for backing-file cleanup, and sandbox run deletion with database cascades for
  child rows. The worker uses this boundary for sandbox run persistence and `sandbox.cleanup.v1`
  jobs, and the Postgres-backed integration test verifies idempotent upsert replacement, ordered
  repo-scoped cleanup selection, limit validation, URI reads, and cascaded child deletion.
- Latest DB code-intelligence milestone: `CodeIntelligenceRepository` now maps imported symbol,
  chunk, edge, dependency, and route rows back to index-record contracts and supports
  symbol-at-line, file symbol, file chunk, outgoing edge, incoming edge, graph-related chunk,
  dependency, route, related-test, and full-text chunk lookups. Retrieval now uses this repository
  boundary for indexed context queries. The Postgres-backed integration test verifies latest-ready
  symbol selection, innermost line matching, source ordering, chunk metadata mapping, edge kind
  filtering, graph chunk direction, dependency and route mapping, related-test mappings, and
  full-text search.
- Latest DB embedding milestone: `EmbeddingRepository` now exposes embeddable chunk reads, reusable
  vector cache reads, idempotent embedding storage with chunk and index progress updates, and
  pgvector similarity search. Retrieval semantic search and `@repo/embedding` batch input/cache
  reads plus batch embedding writes now call this repository boundary, including embedding writes
  that run inside the worker's existing job-progress transaction. The Postgres-backed integration
  test verifies metadata mapping, conflict-safe vector writes, progress updates,
  cache/content-hash reuse, and nearest-neighbor ordering.
- Latest DB review milestone: `ReviewRepository` now returns the stored candidate row when an
  idempotent insert conflicts on review/fingerprint uniqueness, instead of echoing the rejected
  input, owns validated finding inspection reads joined with repository and publication display
  fields for API review finding list/detail routes, owns finding outcome creation/idempotent lookup
  and latest-outcome reads for API and worker finding outcome routes, owns provider-feedback target
  lookups for published findings and summary comments, and owns repository suppression-match audit
  reads joined with memory fact and finding display fields for API memory inspection. The
  Postgres-backed integration test verifies review-run upsert behavior, candidate/validated finding
  idempotency, review finding inspection rows, provider-feedback target lookups, finding outcome
  idempotency/lookups, and suppression-match inspection rows against the current migration chain.
- Latest index artifact schema milestone: `@repo/index-schema` now owns a checked-in split
  fixture catalog for the Phase #10 valid and invalid artifact cases. The CLI can generate the
  same fixture shapes, preserves read-time integrity failures as JSON validation output, and the
  package test suite validates each checked-in split fixture against its expected success or
  failure reason.
- Latest queue operations milestone: `@repo/queue` now exposes stale running job recovery for
  durable jobs left in `running` after worker crashes or lost BullMQ attempts. Retryable stale rows
  move back to `queued`, exhausted rows move to `dead_lettered`, and the worker runs a periodic
  recovery sweep with environment-configurable timeout, interval, and batch size.
- Latest TypeScript indexer milestone: `@repo/indexer-ts` now prefers `git ls-files` discovery for
  tracked repository files and falls back to the bounded filesystem walk outside Git workspaces.
  It has focused coverage for deterministic repo-relative output across repeated runs and oversized
  file skipping before content reads. `@app/indexer-cli` accepts both `run` and `index` as artifact
  creation commands, including request-JSON split artifact output. The indexer now resolves relative
  TS/JS imports and
  simple `tsconfig`/`jsconfig` path aliases to indexed source files, then emits direct imported-call
  edges for named imports when the imported name maps to a concrete symbol and for default imports
  when the target file exposes a same-named symbol. It resolves same-file TS/JS member calls through
  `this` receivers and local variables initialized with known same-file classes, resolves cross-file
  member calls through imported class instances, and avoids ambiguous same-file property-name
  fallback edges when duplicate member names exist. It also emits route records for clear TS/JS
  router calls, Next.js app route modules, and Python route decorators, plus simple path-based test
  mapping records when an indexed test file has a deterministic source target. It emits Python
  import edges to external modules and direct same-file Python call edges between extracted symbols.
  It emits conservative Python file/symbol/chunk records for `class`, `def`, and `async def`
  declarations, including Python parser-version metadata and capability reporting. It emits
  deterministic dependency records from `package.json` manifests for prod, dev, peer, and optional
  dependency sections while advertising the `dependency`, `route`, and `test_mapping` record
  capabilities. It skips generated and vendored source files before parsing,
  symbol extraction, or chunking by applying common path, directory, minified bundle,
  protobuf/GraphQL, Python generated-file, and generated-header heuristics. It skips symlinked
  source entries before resolving file metadata so repository workspaces cannot cause the indexer to
  read files outside the checkout through linked source paths. Workspace validation rejects empty paths,
  non-directories, symlinked workspace roots, filesystem roots, and the user home directory before
  recursive discovery starts. Source text is normalized to LF before parsing, range calculation,
  chunk emission, and hashing so CRLF files do not leak carriage returns into index artifacts.
  Binary-looking source paths are skipped from raw bytes before UTF-8 decoding or parser work. The
  driver capability response stays conservative by reporting incremental indexing as unsupported
  until previous-artifact reuse is implemented. Source discovery includes Node `.mjs` and `.cjs`
  JavaScript modules while excluding `.d.ts`, `.d.mts`, and `.d.cts` declaration files.
- Latest product auth persistence milestone: `packages/db` now has generated schema and migration
  coverage for product `users`, `user_provider_accounts`, `org_memberships`, `user_sessions`, and
  `oauth_states`. This creates the DB prerequisite for Phase #5 GitHub OAuth, opaque session
  cookies, selected organization state, and product RBAC.
- Latest product RBAC milestone: `@repo/security` now defines customer-facing roles,
  permissions, membership-aware organization/repository authorization helpers, and dashboard
  capability flags for owner, admin, member, and viewer roles.
- Latest product session milestone: the API now resolves product session cookie configuration,
  hashes opaque session tokens with a deployment pepper, loads users, memberships, and visible
  provider installations from the database, exposes `/api/v1/me`, and revokes sessions through
  `/api/v1/auth/logout`. GitHub OAuth start/callback routes now create one-time DB-backed state,
  exchange callback codes, upsert product users and provider accounts, issue product session
  cookies, and redirect back to the dashboard.
- Latest product API guard milestone: customer-facing `/api/v1` org, installation, repository,
  review, finding, memory, and usage routes now accept DB-backed product sessions, scope reads to
  the caller's product memberships, enforce product role permissions on scoped resources and
  mutations, and retain the signed admin session path for support tooling.
- Latest product dashboard auth milestone: the product console now loads `/api/v1/me` with product
  session credentials, starts GitHub OAuth through `/api/v1/auth/github/start`, surfaces callback
  errors, displays signed-in product user and organization membership state, refreshes the session,
  and signs out through `/api/v1/auth/logout`.
- Latest product dashboard workspace milestone: signed-in users can load accessible organizations,
  switch organization context, see synced repositories from `/api/v1/orgs/:orgId/repositories`,
  enable or pause repositories through `/api/v1/repositories/:repoId/enable` and `disable`, inspect
  recent review runs, and see basic organization usage from the product API.
- Latest dashboard route-state milestone: the dashboard now parses and writes URL query state for
  the active console mode, admin view, inspector resource, settings repository, overview filters,
  audit filters, security filters, usage filters, plan filters, billing filters, evaluation
  selection, product organization, product repository, review run, and selected finding. The same
  state is applied after product session and admin session reloads, and browser back/forward
  navigation reapplies the parsed state before reloading the selected dashboard data.
- Latest usage/billing period summary milestone: `@repo/usage` now builds customer-safe billing
  period summaries that tie review credits, plan allowance, active credit grants, provider meter
  rows, overlapping invoice mirrors, and opt-in internal cost fields into one support/debug
  contract.
- Latest product rules/settings milestone: product sessions can now read and edit repository
  settings, compile policy previews, and list/create/update/delete repository-scoped rules through
  `/api/v1/repositories/:repoId` routes with product RBAC. The authenticated product workspace
  exposes the same review settings, policy preview, and rule editor controls without requiring an
  admin session.
- Latest product review inspection milestone: the authenticated product workspace can open a recent
  review run, load its validated findings, inspect finding validation/evidence/publication/outcome
  state, record finding outcomes through `/api/v1/findings/:findingId/outcome`, and enqueue review
  reruns through `/api/v1/review-runs/:reviewRunId/rerun` when the caller's product role permits
  those actions.
- Latest product artifact milestone: `/api/v1/review-runs/:reviewRunId/artifacts` now returns
  payload-free artifact metadata after `review:debug:read` authorization, and
  `/api/v1/review-runs/:reviewRunId/artifacts/:artifactId/payload` returns redacted stored payloads
  only after scoped authorization and a caller reason. Successful payload reads and downloads write
  `artifact_access_events`, raw reads/downloads require an audited signed admin support-session
  token or elevated admin permission,
  `/api/v1/review-runs/:reviewRunId/artifacts/:artifactId/download-url` creates short-lived raw
  object-storage URLs only after the same raw access gates, and the product review
  detail panel can load or download redacted payloads without exposing raw prompt/code artifacts.
- Latest review artifact storage milestone: `@repo/artifacts` now defines the review artifact
  payload store boundary, stable payload descriptors, DB-inline fallback storage, legacy inline
  metadata reads, filesystem-backed JSON payload storage for local/shared-volume deployments,
  S3/R2-compatible JSON payload storage over SigV4 `fetch` requests, and stored-payload
  detection. Review orchestration writes artifact payloads through that boundary, the API reads
  audited payloads through the same boundary, and both processes can opt into filesystem storage
  with `HEIMDALL_REVIEW_ARTIFACT_ROOT` or object storage with
  `HEIMDALL_REVIEW_ARTIFACT_BUCKET`/`OBJECT_STORAGE_BUCKET`,
  `HEIMDALL_REVIEW_ARTIFACT_ENDPOINT`, `HEIMDALL_REVIEW_ARTIFACT_REGION`,
  `HEIMDALL_REVIEW_ARTIFACT_ACCESS_KEY_ID`, and
  `HEIMDALL_REVIEW_ARTIFACT_SECRET_ACCESS_KEY`. Optional object storage controls include
  `HEIMDALL_REVIEW_ARTIFACT_SESSION_TOKEN`, `HEIMDALL_REVIEW_ARTIFACT_KEY_PREFIX`, and
  `HEIMDALL_REVIEW_ARTIFACT_FORCE_PATH_STYLE`. S3/R2-compatible stores can also create short-lived
  SigV4 signed GET URLs for raw support downloads; redacted downloads remain API-mediated so
  redaction is enforced before response delivery.
- Latest review orchestrator state-machine milestone: review orchestration now persists
  `review_runs.status` transitions for index wait, retrieval, review, validation, and publish
  handoff, records matching stage timeline events with product-safe metadata, and stores the
  current failed stage when a run fails mid-flow. When no fresh index is ready after the bounded
  wait, it idempotently enqueues the same `repo.index_commit.v1` key that webhook planning uses for
  the reviewed head SHA before continuing with diff fallback. Workers can opt into
  `HEIMDALL_REVIEW_INDEX_DEPENDENCY_MODE=pause`, which leaves the review run in
  `waiting_for_index`, releases reserved quota, and raises a retryable dependency-pending error so
  durable job retry can resume after the index job completes. It now performs provider current-head
  checks after snapshot, after index wait, before review/model execution, and before publish
  handoff, records each staleness checkpoint result, releases reserved quota for stale terminal
  outcomes, and marks moved or closed PRs as superseded or skipped before later expensive work or
  publisher jobs are enqueued.
- Latest LLM gateway provider milestone: `@repo/llm-gateway` now normalizes provider and schema
  failures into `LLMGatewayError`, retries configured transient provider failures with a bounded
  retry policy, exposes a fixture-backed `FakeLLMProvider`, and includes an OpenAI-compatible Chat
  Completions adapter that requests JSON-mode output and parses the assistant message content
  before the existing TypeBox validation layer. Review-finding calls now resolve their system
  prompt and prompt version through a gateway prompt registry, the gateway can route calls by task
  and model profile, and the review pass marks finding generation with the `review_findings`
  profile. The worker can route that task to `HEIMDALL_LLM_REVIEW_FINDINGS_MODEL`, reject
  over-budget prompt/input payloads before provider execution, and construct the gateway with
  SecretRef-backed API-key resolution. Review orchestration persists linked redacted LLM
  prompt/response artifacts for replay/debug inspection. Admin tooling now includes a guarded
  OpenAI-compatible live LLM smoke runner plus a runbook that prints product-safe proof without
  exposing API keys, prompts, raw responses, or customer data.
- Latest review pass selection milestone: `@repo/review-engine` now exposes review pass modes,
  conservative review budgets, and deterministic pass selection so documentation-only changes stay
  summary-only, source changes select correctness and test coverage, and security-sensitive changes
  select the security pass.
- Latest finding validation milestone: `@repo/review-engine` now exposes `validateCandidateFindings`
  for accepted/rejected findings, duplicate groups, rejection reason counts, and product-safe
  validation trace events, while `validateAndRankCandidateFindings` remains the compatibility path
  for orchestration. Review orchestration now consumes the inspectable validation result and
  persists rejected-findings plus ranking-report artifacts with validation stats, duplicate groups,
  and product-safe trace events. Validation now also rejects conservative semantic duplicates on the
  same file and category when user-facing finding text has high normalized token overlap, rejects
  compatible-category root-cause duplicates after ranking, rejects candidates that duplicate prior
  published findings on the same pull request, and can reject findings suppressed by configured
  memory facts with product-safe memory suppression metadata. It now also rejects high-confidence
  secret-like values in user-visible finding text and has focused coverage for core validator
  failures, generated/deleted/binary files, root-cause/previous-comment dedupe, deterministic
  ranking, and budget rejection. JSON fixture goldens under
  `packages/review-engine/test/fixtures/validation` now assert accepted IDs, rejected IDs and
  reasons, duplicate groups, rank order, and policy-derived publish-plan shape for valid, invalid,
  duplicate, suppressed, budgeted, previous-comment, secret, weak-evidence, invalid-context,
  invalid-path, unsafe-fix, and summary-only cases. Runtime validation now normalizes
  schema-invalid candidates into explicit rejected findings instead of throwing, rejects unsafe repo
  paths, validates evidence context references against the retrieved context bundle, rejects weak
  evidence, and blocks unsafe suggested fixes. Review orchestration now loads active, non-expired
  repository and organization memory rows, maps metadata suppression dimensions into validation
  memory facts, loads prior published findings for previous-comment dedupe, and supplies retrieved
  context to validation. Validation trace events are now persisted to `finding_validation_events`
  with candidate, validated finding, stage, status, reason, and validator metadata for replay/debug
  inspection. Duplicate groups are now persisted to
  `finding_duplicate_groups` with canonical and duplicate candidate/finding IDs for replay/debug
  inspection. Review orchestration now also persists a `publish_plan` artifact with planned inline,
  check annotation, summary, and operation counts, mirrors the same shape into `publish_plans`, and
  includes the publish plan and artifact IDs on the queued publish job when the plan contains
  external publish operations. Empty/all-rejected plans are persisted for debugging but complete
  without enqueueing publisher work.
- Latest publisher planning milestone: `@repo/publisher` now attaches dry-run-friendly planned
  operations to each `PublishPlan`, including check-run, inline-review, configured-summary, and
  fallback-summary operations when accepted findings cannot be anchored inline. Publisher failures
  now serialize stable GitHub/provider reasons, retryability, status, request IDs, retry-after
  values, and rate-limit snapshots for dashboard and replay diagnostics, and the publisher
  inspector now renders publish run, operation, and durable output rows directly. GitHub summary
  comments now carry stable PR-level markers and update an existing bot summary with the latest
  body while preserving legacy per-body marker dedupe. `@repo/github` now also exports a typed
  Heimdall hidden marker parser and uses parsed markers for provider-side comment dedupe.
  `@repo/publisher` now exposes conservative `PUBLISH_LIMITS`, caps grouped inline comments per
  plan, records throttle decisions in publish-plan artifacts, and the worker shares a Redis-backed
  throttle across worker processes for repository, installation, and PR-summary write windows.
  `@repo/admin-tools` reconciliation can now optionally read provider-side inline review and
  summary comments, parse Heimdall markers, and report mismatches between GitHub-visible comments
  and durable published rows. The guarded live publisher smoke now supports
  `HEIMDALL_GITHUB_SMOKE_MODE=stale_head` for a real GitHub-read stale-head skip check that should
  avoid external publishing. `pnpm smoke:github-provider-errors` now runs guarded live GitHub
  provider-error probes and prints the observed typed provider error plus publisher serialization.
- Latest indexer CLI milestone: `@app/indexer-cli` now replaces the placeholder entrypoint with a
  working `indexer index` command that accepts required repo, commit, and workspace inputs by flags
  or request JSON, invokes the existing TypeScript indexer driver, writes artifact JSON to a file or
  stdout, and returns non-zero diagnostics for invalid input or indexer failures.
- Latest indexer timeout milestone: `@repo/indexer-driver` now exposes a timeout wrapper that
  returns normalized `timeout` failures and aborts the wrapped driver signal. The worker uses that
  wrapper around the in-process TypeScript indexer, with `INDEXER_TIMEOUT_MS` overriding the
  default per-run timeout.
- Latest indexer registry milestone: `@repo/indexer-driver` now includes a deterministic fake
  driver and simple driver registry with duplicate-name validation, giving boundary tests and
  future runtime driver selection a parser-free harness.
- Latest indexer CLI-driver milestone: `@repo/indexer-driver` now includes a CLI-backed driver
  wrapper that writes `request.json`, creates per-run output/log directories, launches the indexer
  with spawn argument arrays, passes only allowlisted environment variables plus `NO_COLOR`,
  captures bounded stdout/stderr logs with truncation diagnostics, validates the emitted artifact
  JSON, and normalizes non-zero exit, signal, cancellation, timeout, filesystem, and invalid
  artifact failures.
- Latest worker indexer selection milestone: the worker now keeps the in-process TypeScript
  indexer as the default, but can select the CLI driver with `INDEXER_DRIVER=cli`,
  `INDEXER_CLI_COMMAND`, and optional `INDEXER_CLI_ARGS_JSON`, or a remote driver with
  `INDEXER_DRIVER=remote`, `INDEXER_REMOTE_BASE_URL`, optional `INDEXER_REMOTE_BEARER_TOKEN`, and
  remote poll timing overrides; unsupported driver names fail at startup instead of falling through
  to accidental parser coupling.
- Latest remote indexer milestone: `@repo/indexer-driver` now includes a remote HTTP driver that
  posts index requests to `/v1/index-runs`, polls pending remote runs, loads inline artifacts or
  artifact JSON from an `artifactUrl`, preserves returned durable `artifactUri` values for importer
  metadata, validates artifacts before returning success, and maps remote service, timeout, and job
  failure states to normalized indexer failures.
- Latest indexer capabilities milestone: `@repo/indexer-driver` now has a typed capabilities
  contract and current-artifact-schema assertion, fake/CLI/remote drivers expose capabilities,
  `@repo/indexer-ts` reports TypeScript indexer capabilities, `@app/indexer-cli` supports
  `indexer capabilities --json`, and worker startup checks the selected driver before accepting
  jobs.
- Latest indexer config milestone: `@repo/config` now exports TypeBox-backed indexer runtime
  configuration for driver selection, artifact root/upload mode, validation mode/sample size, CLI
  executable/args/env/log/kill settings, and remote indexer URL/auth/poll settings. The worker uses
  the central loader for `INDEXER_DRIVER`, legacy aliases such as `INDEXER_CLI_COMMAND`,
  `INDEXER_TIMEOUT_MS`, and `INDEX_ARTIFACT_ROOT`, and can select in-process, fake, CLI, or remote
  drivers through the validated config.
- Latest indexer validation-mode milestone: `@repo/indexer-driver` now exposes full, sample, and
  manifest-only artifact validation modes. CLI and remote drivers apply the selected mode before
  returning successful artifacts, include validation-mode attributes in validation spans, and the
  worker passes central `INDEXER_VALIDATE_RECORD_MODE` plus `INDEXER_VALIDATION_SAMPLE_SIZE`
  configuration into those drivers.
- Latest index artifact handoff milestone: `@repo/index-importer` now exposes an S3/R2-compatible
  whole-artifact store that writes complete index artifact JSON payloads to durable object-storage
  URIs. When `INDEXER_ARTIFACT_UPLOAD_MODE=object_storage`, the worker creates the object store and
  URI resolver from the index artifact environment, uploads locally produced artifacts before
  import, and imports through the durable URI handoff.
- Latest indexer observability milestone: `@repo/indexer-driver` now records product-safe artifact
  validation duration histograms, validation failure counters with bounded reason labels, and
  dedicated nonzero CLI exit counters, plus successful-artifact resource-count and indexed-byte
  histograms in addition to existing run, duration, timeout, output-byte, run span, CLI spawn span,
  validation span, and artifact footprint span telemetry.
- Latest index artifact schema milestone: `@repo/index-schema` now owns artifact validation
  helpers, manifest feature-flag fields with unsupported required-feature rejection, manifest
  `recordFiles` metadata, normalized repo path helpers, deterministic stable ID helpers,
  canonical split-artifact filenames, compact JSONL parse/stringify helpers, whole-artifact JSON
  helpers, Node split-artifact reader/writer helpers, `openIndexArtifact` streaming split-artifact
  reads, streaming JSONL record writes with
  count/byte/SHA-256 metadata, partitioned record-file reads with count/byte/SHA-256 verification,
  a high-level split-artifact writer that derives manifest record counts and writes the manifest
  last, record-file path safety checks, artifact diff utilities, and package-owned CLI commands for
  validate, print-manifest, count-records, diff, and valid fixture generation. The indexer driver
  re-exports the schema-owned validator for compatibility, while the indexer CLI and importer use
  the shared helpers instead of duplicating split-layout and JSONL handling.
- Latest index importer URI milestone: `@repo/index-importer` now exposes filesystem/file-URI and
  S3/R2-compatible whole-artifact resolvers, a `createIndexArtifactResolverFromEnvironment`
  runtime factory, a `readIndexArtifactFromUri` helper, and `importIndexArtifactFromUri` for
  loading whole-artifact JSON by URI before normal validation and import. The filesystem resolver
  also accepts split artifact directories containing `index-manifest.json` plus newline-delimited
  `records.jsonl`. The worker now exercises this URI-first path for locally persisted index
  artifacts. Split filesystem artifact records are parsed through a line-streamed JSONL reader with
  line-numbered parse errors, and normalized file, symbol, edge, and chunk rows are now written in
  bounded configurable insert batches. Embedding planner item rows now use the same bounded insert
  batching so large artifacts avoid unbounded write payloads for imported records or planned chunk
  embedding items. Imports now also create durable `index_import_batches` rows with phase,
  manifest counts, artifact metadata, completion state, and product-safe failure details, and index
  versions stay in `importing` until final activation marks the import batch complete. Importers
  now route normalized row persistence through an internal Drizzle batch writer boundary so a future
  COPY writer can replace the storage strategy without changing record classification or import
  orchestration. Importers now enforce configurable artifact safety limits for record, file, symbol,
  edge, chunk, record JSON-byte, and chunk-text-byte counts, and the worker applies
  `INDEX_IMPORT_MAX_*` environment overrides through the importer boundary. The worker also applies
  bounded import record batch sizes from `HEIMDALL_INDEX_IMPORT_RECORD_BATCH_SIZE` or
  `INDEX_IMPORT_RECORD_BATCH_SIZE`, so large deployments can tune normalized row and embedding
  planner writes without code changes. Split artifact JSONL readers also enforce configured
  record-count and per-line byte limits while streaming records from disk, before the full artifact
  record array is assembled. Object-storage upload mode now server-side copies remote indexer
  artifact objects into the configured Heimdall bucket when a source URI is available and the store
  supports copy operations, with a canonical upload fallback for stores that only support writes.
- Latest index importer optional-record milestone: `@repo/db` now includes normalized
  `code_index_diagnostics`, `code_dependencies`, `code_routes`, and `code_test_mappings` tables
  plus import-batch and index-version counts for those record families. `@repo/index-importer`
  now classifies and persists the corresponding artifact records, reports their imported counts,
  and cleans those rows during failed-import retry, stale reconciliation, and explicit cleanup.
- Latest embedding input milestone: `@repo/embedding` now builds `code_chunk` provider inputs with
  path/language/symbol/range metadata, computes SHA-256 input hashes, estimates tokens
  conservatively, truncates oversized chunk bodies while preserving the header and tail, and splits
  provider calls by input count, token budget, and character budget. It now also includes an
  OpenAI-compatible Embeddings adapter that requests float vectors from `/v1/embeddings`, validates
  the provider envelope, orders returned vectors by provider index, and normalizes provider errors.
  The worker keeps local hash/fake vectors as the default while supporting
  `EMBEDDING_PROVIDER=openai` with configured model, dimensions, base URL, timeout, and
  SecretRef-backed API-key resolution. Durable embedding rows now store provider, input kind,
  input hash, embedding profile version, and cache key metadata; embedding jobs reuse matching
  stored vectors before calling the provider. Cache-miss provider batches now emit idempotent
  `embedding.token` usage events through the worker usage ledger with provider/model/dimension,
  input-count, rate-card cost metadata, and provider-returned token counts when adapters expose
  them, falling back to local estimates otherwise. Index import now also creates
  idempotent `embedding_jobs` and `embedding_job_items` planner rows for imported chunks, carries
  the embedding job/profile IDs into queued batch payloads, and the embedding worker updates item
  and parent progress counters as batches run, skip, succeed, or fail. Background-job debug
  inspection now surfaces the referenced embedding job progress and a bounded item sample without
  exposing raw artifact metadata values. OpenAI-compatible embedding calls now retry retryable
  rate-limit, timeout, fetch, and 5xx failures with bounded exponential backoff plus jitter and
  product-safe `Retry-After` handling. The embedding package also exposes a reconciliation helper
  and scoped repair helper that repairs stale item rows from stored vectors and recomputes parent
  job counters. It also resets stale embedded item rows when the matching vector is missing so the
  worker can enqueue bounded replacement `embedding.batch.v1` jobs from a repair pass. Index import
  schedules a delayed `embedding.repair.v1` backstop for each planned embedding job, and the worker
  handles both single-job and scoped repair payloads. Reconciliation now also reports product-safe
  incompatible-vector and orphaned-vector counts so repair runs can distinguish absent vectors from
  stale scope drift, and targeted worker repair deletes wrong-dimension, stale-profile,
  stale-provider, and unambiguous orphaned vector rows before requeueing missing chunks. Admin
  tooling now includes a guarded live OpenAI-compatible embedding smoke runner plus a runbook that
  prints product-safe proof without exposing API keys or vector contents.
- Latest retrieval hardening milestone: `@repo/retrieval` now validates every returned
  `ContextBundle` through the shared TypeBox schema and keeps required diff/same-file context when
  optional graph, test, full-text, or semantic retrievers fail, recording product-safe warnings in
  bundle metadata instead of failing the full retrieval. The database retrieval index now exposes a
  PostgreSQL full-text chunk retriever over imported chunk text metadata so indexed context can add
  non-embedding search matches alongside vector-backed similar patterns.
- Latest retrieval optional-record milestone: `@repo/retrieval` now consumes persisted
  `code_dependencies`, `code_routes`, and `code_test_mappings` rows. Changed package manifests add
  dependency context, changed route files add route/config context, and related-test retrieval uses
  explicit test mappings before falling back to filename stems.
- Latest retrieval repo-rule milestone: `@repo/retrieval` now accepts configured repository rules as
  retrieval input, selects rules that match changed paths, languages, pull request labels, authors,
  or title patterns, emits selected rules as explicit `repo_rule` context items, and records a
  product-safe rule selection trace in context bundle metadata. The review orchestrator and admin
  retrieval replay pass effective repository rules into retrieval.
- Latest retrieval dashboard inspection milestone: admin retrieval replay now returns bounded
  inspectable context item details for original and replayed bundles, including source, priority,
  token estimate, retriever reason, path/range, metadata keys, and a short preview. The dashboard
  renders those details alongside retrieval warnings and comparison status.
- Latest retrieval changed-symbol milestone: `@repo/retrieval` now populates
  `ContextBundle.changedSymbols` from indexed symbols that overlap changed diff lines, limits
  changed-symbol context and graph expansion to those overlapping symbols, and emits line-range
  fallback changed symbols for changed files without matching indexed symbols. Public retrieval
  tests now cover modified indexed-symbol detection plus added, deleted, and renamed fallback
  changed-file cases. Public fallback context tests also cover added, modified, deleted, and
  renamed file status handling, including the deleted-file diff context skip.
- Latest retrieval packing milestone: `@repo/retrieval` now records a product-safe
  `token_budget_exceeded` warning plus selected/dropped item counts by safe kind/source labels when
  `maxTokens` causes lower-priority context to be excluded. Public retrieval tests cover priority
  packing that keeps changed-symbol, same-file, and diff context while dropping lower-priority
  vector context.
- Latest retrieval ranking milestone: `@repo/retrieval` now merges duplicate context candidates by
  chunk, symbol, rule, memory fact, or snippet key, applies deterministic weighted reciprocal-rank
  fusion with small domain boosts and penalties before token-budget packing, and records
  product-safe ranking metadata for selected and dropped context items. Public retrieval tests cover
  a duplicate full-text/vector chunk that outranks a semantic-only chunk because multiple sources
  support it.
- Latest retrieval trace artifact milestone: review orchestration now persists a
  `retrieval_trace` artifact next to each context bundle. The trace payload summarizes input SHAs,
  changed-file counts, changed-symbol counts, selected item IDs/kinds/sources, ranking metadata,
  packing metadata, and warnings without copying snippet text. Unit coverage verifies the payload
  shape and guards against leaking source text into the trace.
- Latest PR snapshot milestone: `@repo/pr-snapshot` now provides the first provider-neutral unified
  diff parser, raw diff hashing, canonical JSON snapshot hashing, minimal patch reconstruction,
  quoted Git path handling for paths with spaces, left/right commentable line indexing, file-level
  fallback indexing for binary/rename-only/metadata changes, and GitHub review-comment anchor
  conversion for verified single-line, same-side same-hunk multiline, and file-level anchors. It also extracts
  a contract-validated change set with added/deleted ranges, conservative modified blocks, changed
  path sets, and rename pairs for retrieval handoff. The GitHub provider now uses the shared parser
  and hash helper for snapshot changed-file hunks and raw diff hashes instead of maintaining a
  provider-local hunk parser. Tests cover modified, renamed, quoted path, binary, hashing,
  commentability, unsafe-anchor, file-anchor, copied-file, mode-only metadata, golden parser
  fixtures, provider reconciliation, raw-diff artifact, and change-set cases. `@repo/pr-snapshot`
  now exposes raw-diff and snapshot-derived artifact helpers, verifies multiline anchors stay within
  one diff hunk, and review orchestration persists raw-diff, line-anchor-index, and change-set
  artifacts alongside the pinned PR snapshot.
- Latest product suppression milestone: `/api/v1/findings/:findingId/suppress-similar` now creates
  an audited suppress rule from a selected finding after `rule:write` authorization, and the product
  finding detail panel exposes repository or organization scoped suppress-similar controls for roles
  that can manage rules.
- Latest product review failure milestone: scoped review-run list/detail responses now include a
  structured failure summary when `review_runs.error` is present or the status is failed, and review
  detail responses include product-safe durable job summaries tied to the run. The product review
  table/detail panel surfaces the failure code, message, retryability, timestamp, and job timeline
  with attempt counts and job failure messages.
- Latest completed milestone: guarded live PR review smoke verified webhook-to-publish completion
  against development PR `maskdotdev/heimdall#2`.
- Latest product flow milestone: the dashboard now opens on the normal GitHub App onboarding path,
  backed by `/app/onboarding` for GitHub App install readiness, installation status, repository
  discovery, webhook activity, and recent review visibility. The admin console remains available as
  a separate operator mode.
- Latest feedback/memory milestone: `packages/memory` now implements the first deterministic memory
  boundary with hidden marker parsing, maintainer command parsing, feedback signals, outcome
  scoring, memory candidate activation, and explainable suppression decisions.
- Latest GitHub App milestone: `packages/github` now parses `x-ratelimit-*` and `retry-after`
  response headers at the provider boundary, exposes recent request observations for diagnostics,
  supports an optional request-observer callback for metrics wiring, and attaches the parsed
  rate-limit snapshot to typed provider errors. `docs/runbooks/github-dev-app.md` now defines the
  development GitHub App permission checklist and guarded manual smoke flow, closing Phase #3 for
  the current MVP scope.
- Latest API server milestone: `/api/v1/orgs` and `/api/v1/installations` now support
  signed-session scoped list/detail reads. `/api/v1/installations/:installationId/sync` authorizes
  organization scope before writing an audit row and enqueueing an idempotent durable
  `github.sync_installation.v1` job. `/api/v1/github/install-url` exposes the configured GitHub App
  installation URL to authenticated callers, and `/api/v1/github/install-callback` safely redirects
  GitHub's installation callback back to onboarding with sanitized query state. Product session
  routes now apply a configurable fixed-window rate limit keyed by opaque session cookie hash or
  client IP before session reads or OAuth provider calls, returning `product_auth.rate_limited`
  with `Retry-After` when exceeded. Product and admin surfaces now share hardened response headers
  for no-store caching, content-type sniffing prevention, frame denial, and no-referrer behavior.
  The API now sends HSTS only for production HTTPS requests and protects the generated OpenAPI HTML
  page with no-store caching plus a restrictive Content Security Policy.
  The root env examples and README now document the product session, OAuth, and product rate-limit
  configuration knobs.
- Latest repository API milestone: `/api/v1/orgs/:orgId/repositories` and
  `/api/v1/repositories/:repoId` now reuse scoped repository discovery/settings reads.
  `/api/v1/repositories/:repoId/settings`, `enable`, `disable`, `sync`, and `reindex` authorize
  repository scope before mutating state or enqueueing jobs. Repository sync creates an audited
  durable GitHub installation-sync outbox job scoped to the target repository, and repository
  reindex creates an audited `repo.index_commit.v1` outbox job for an explicit commit SHA.
- Latest review API milestone: signed-session `/api/v1/orgs/:orgId/review-runs`,
  `/api/v1/repositories/:repoId/review-runs`, `/api/v1/review-runs/:reviewRunId`,
  `/api/v1/review-runs/:reviewRunId/findings`, and `/api/v1/findings/:findingId` now expose
  scoped review history and finding detail with publication and latest-outcome state.
  `/api/v1/findings/:findingId/outcome` records audited, idempotent outcome rows after repository
  scope authorization, and `/api/v1/review-runs/:reviewRunId/rerun` enqueues an audited durable
  `pr.review.v1` rerun job.
- Latest artifact API milestone: `/api/v1/review-runs/:reviewRunId/artifacts` now lists artifact
  references for a scoped review run, requires `review:debug:read`, and returns metadata keys plus
  stored-payload presence only. The paired artifact payload route requires a non-empty reason,
  returns `Cache-Control: no-store`, redacts prompt/code/provider-sensitive fields by default, logs
  successful reads to `artifact_access_events`, and blocks raw payload reads unless the caller is an
  admin support session or elevated admin actor. The paired download route streams the same audited,
  redacted JSON payload as an attachment, and the raw `download-url` route returns short-lived
  object-storage URLs only after raw artifact access is explicitly authorized and audited.
- Latest suppression API milestone: `/api/v1/findings/:findingId/suppress-similar` now validates
  scope, reason, and expiration input, creates or reuses an idempotent suppress rule seeded from the
  finding title/path, writes a `finding.suppression.created` audit event, and stores rule expiration
  metadata that the policy compiler ignores after expiry.
- Latest memory API milestone: signed-session `/api/v1/repositories/:repoId/memory` now lists and
  creates repository-scoped memory facts after repository authorization, and `/api/v1/memory/:id`
  now supports scoped detail, update, and soft-delete flows. Memory writes record audit rows and use
  idempotent create IDs while preserving source, subject, confidence, status, and caller metadata.
- Latest usage API milestone: signed-session `/api/v1/orgs/:orgId/usage/summary`,
  `/api/v1/orgs/:orgId/usage/events`, and
  `/api/v1/repositories/:repoId/usage/summary` now expose scoped product usage reads. The routes
  validate usage filters, enforce organization/repository scope before loading usage, return
  product-oriented cost/token/review metrics, and support repository breakdowns and event lists.
- Latest OpenAPI milestone: the API now uses `@elysia/openapi` to expose `/openapi` and
  `/openapi/json` outside production by default, with an explicit environment override and a
  production-default-off test. The generated spec includes the scoped `/api/v1` product routes.
- Latest repo rules/configuration milestone: `@repo/rules` now provides the first policy compiler
  and evaluator boundary. Webhook ingestion applies trigger decisions before durable PR review jobs
  are planned, review orchestration records immutable `policy_snapshot` artifacts before passing
  compiled finding policy into validation, publisher handoff enforces check-run, inline, summary,
  fallback, and comment-budget routing from that snapshot, and the admin settings screen can preview
  the effective policy for unsaved draft settings. Operators can also create, edit, disable, and
  delete repository-scoped rules, and stored active rules are included in both previews and
  review-run policy snapshots.
- Latest implementation milestone: Railway staging admin control-plane proof completed with signed
  IdP-backed sessions, scoped permissions, CSRF/CORS protections, settings APIs/UI, audit history
  search, replay execution, rollback notes, and committed evidence.
- Latest staging verification: `pnpm proof:control-plane:staging` passed against Railway API,
  dashboard, and gateway services on 2026-05-06. Evidence is recorded in
  `docs/evidence/admin-control-plane-staging-proof.json`.
- Latest admin production-readiness milestone: `docs/runbooks/admin-control-plane.md` now defines
  the Railway-first production deployment decision, rollout owners, enablement order, acceptance
  gates, go/no-go criteria, gateway hardening checklist, secret rotation procedure, monitoring
  checks, and emergency disable path. `pnpm readiness:control-plane:production` validates the
  committed staging proof and runbook coverage before production handoff.
- Latest admin usage/cost inspector milestone: `@repo/admin-tools` now exposes review-run usage
  inspections that summarize usage ledger rows, cost rollups, customer-understandable billable
  units, and quota reservation state through the package service and `admin usage inspect` CLI
  command.
- Latest admin tooling milestone: review inspectors can now export redacted debug bundles through
  the admin API and operator dashboard. Exports hash and redact raw payload, prompt, response,
  source body, diff, patch, evidence, credential, and cookie fields, and each export writes an
  `audit_logs` row before returning the bundle metadata. The same inspector can now create an
  audited eval import draft that converts review metadata into a schema-validated `EvalCase` plus
  proposed fixture files for later human review, without mutating the committed eval suite. The
  admin API and dashboard also expose a repository-scoped Memory & Rules inspector for effective
  repository/org rules, stored memory facts, policy-tool availability, and pending memory candidate
  moderation; the scoped API can approve persisted memory candidates into durable memory facts or
  reject them with audit logs. PR12 hardening now includes cross-tenant API tests that verify debug
  bundle export, eval import draft creation, and Memory & Rules inspection are denied before
  sensitive actions run, plus configurable API-side
  admin route rate limits that return `429` with `Retry-After` and telemetry. Support sessions can
  now be minted through `/admin/support-sessions` as audited, signed, time-limited tokens scoped to
  an organization, repository, or review run. The `x-heimdall-support-session-id` header still
  propagates support-session IDs into debug/eval audit actor metadata, but privileged raw artifact
  and raw eval access require a valid signed token or elevated admin permissions before the
  sensitive action runs. Eval import draft mutations also require a non-empty operator reason, with
  denied attempts recorded through admin access-denied telemetry before draft
  creation. Successful privileged admin actions now also emit generic `admin.action.completed`
  telemetry with an `actionKind` attribute so production monitoring can count action volume across
  replay, debug export, eval import, settings, rules, billing, and support inspection workflows.
  The database schema now includes `admin_actions`, `replay_runs`, `replay_stage_runs`,
  `admin_notes`, `debug_exports`, and `artifact_access_events`, and redacted review debug bundle
  export writes completed admin action and debug export rows with an expiration timestamp linked
  from audit metadata. Replay dispatch now returns completed admin action and replay run row IDs,
  records per-job replay stage rows, and links those IDs from audit metadata. The admin API and
  dashboard now include a standalone durable Job inspector that shows failed job state and supports
  scoped, confirmation-gated `job.requeue` dispatch for failed or dead-lettered jobs with the same
  admin action, replay run, stage, and audit rows as other replay paths. Eval import draft
  creation also returns completed admin action row IDs and links those IDs from audit metadata. The
  admin API and dashboard now expose scoped non-mutating retrieval and validation replay
  comparisons for review runs. The local admin CLI exposes review inspect, redacted debug export,
  confirmed review replay dispatch, non-mutating retrieval and validation replay comparisons, and
  publisher dry-run commands backed by the same admin-tools service functions, with direct
  production database access disabled by default.
- Latest deployment and observability milestone: `infra/production/railway-admin-control-plane.json`
  now codifies the Railway production services, required environment variable names, release gates,
  rollback checks, alert coverage, and the required production dashboard set for post-release
  monitoring. The manifest and deployment audit now require role-specific Railway worker services
  for general, index, review, embedding, publisher, and maintenance pools, with committed
  config-as-code start commands that set the matching worker role. Release docs and the GitHub issue
  template now require dashboard links, alert check results, and follow-up issue ownership before
  production closeout. `pnpm audit:control-plane:deployment` validates that manifest against the
  root scripts, and the API emits structured admin control-plane telemetry to the configured
  observability sink.
- Latest production artifact deployment milestone: the Railway production manifest and deployment
  audit now require S3/R2-compatible review artifact object-storage variables on both the API and
  worker services, SecretRef names for GitHub webhook/private-key and provider API keys, and AWS
  secret-resolution credentials/region for production secret lookup. The manifest also declares,
  and the audit validates, that production review artifact storage uses a private S3-compatible
  bucket with public access blocked, provider-managed encryption, and support-session-gated raw
  downloads.
- Latest local infrastructure milestone: `compose.yaml` now runs MinIO object storage beside
  Postgres and Redis, bootstraps a `heimdall-review-artifacts` bucket for local review artifact
  payloads, and `infra/README.md` documents the API/worker environment variables for that local
  object-storage endpoint. The optional local observability profile now provisions stable Grafana
  datasource UIDs and starter dashboards for API, queue, review pipeline, LLM/retrieval,
  indexing/embedding, publishing, and webhook delivery telemetry, plus Prometheus alert rules for
  the same MVP operational risks covered by the observability alert runbook.
- Latest CI milestone: `.github/workflows/ci.yml` runs `pnpm ci:control-plane:release` on pull
  requests and pushes to `main`, covering the production deployment audit, production-readiness
  gate, typecheck, lint, tests, workspace boundary checks, and build.
- Latest testing/evaluation strategy milestone: the CI workflow now uploads
  `.tmp/eval-runs/smoke-full-pipeline-v1/report.md` and `report.json` as the
  `smoke-full-pipeline-v1-eval-report` artifact after release gates, including failed-gate runs
  where the eval reports exist, and a root workflow test guards the report paths. CI now also starts
  a `pgvector/pgvector:pg17` Postgres service and sets `HEIMDALL_DB_TEST_URL` for release gates, so
  Postgres-backed package integration tests run in CI. The DB integration test applies every
  generated migration from an empty schema before inserting core rows and checking latest tables,
  and review, admin-tools, webhook-ingestion, and publisher integration coverage now boot against
  the same current migration chain. Product review artifact metadata, payload, download, and signed
  URL routes now have cross-tenant denial coverage that proves artifact data is not read after a
  foreign review-run scope check fails. Root workflow tests now also pin the release command's
  dependency on `pnpm check`, representative cross-tenant API tests, package-level redaction tests,
  and the scheduled/manual eval-history workflow that can persist no-live-model eval history when
  `EVAL_HISTORY_DATABASE_URL` is configured. It now also pins the fake PR end-to-end review
  integration path: CI provides `HEIMDALL_DB_TEST_URL`, the release command runs `pnpm test`, and
  `packages/review-orchestrator/test/review-orchestrator.integration.test.ts` uses a fake Git
  provider, static LLM gateway, and fake workspace sync to cover publish and no-publish outcomes.
- Latest package-test coverage milestone: `test/package-test-coverage.test.ts` walks every
  workspace package under `packages/`, verifies the package has a Vitest-backed `test` script, and
  requires at least one package-local `.test.*` file. This keeps Phase #31 package-level public test
  coverage from silently regressing as packages are added or renamed.
- Latest app-test coverage milestone: `test/app-test-coverage.test.ts` walks every workspace app
  under `apps/`, verifies the app has a Vitest-backed `test` script, and requires at least one
  app-local `.test.*` file. This keeps API, worker, dashboard, marketing, admin-gateway, and CLI app
  coverage from silently regressing as app workspaces change.
- Latest workspace TypeScript graph milestone: root `tsconfig.json` now references every app and
  package workspace with a local `tsconfig.json`, including newer billing, rules, usage,
  webhook-ingestion, and marketing projects. `test/workspace-tsconfig.test.ts` keeps the root
  project-reference graph aligned with the workspace layout so `pnpm typecheck` cannot silently
  skip newly added projects.
- Latest workspace structure milestone: `test/workspace-structure.test.ts` verifies the Phase #1
  root setup files and root scripts remain present, every app keeps the shared app script contract,
  TypeScript config, source entrypoint, private `@app/*` manifest naming, and every package keeps
  the shared package script contract, TypeScript/build configs, `src/index.ts`, and private
  `@repo/*` manifest naming.
- Latest dashboard client milestone: `apps/web/src/api-client.ts` centralizes product, admin, and
  admin-gateway JSON/blob requests with typed response envelopes, credentials, admin CSRF handling,
  and 401 session cleanup callbacks. `apps/web/src/api-client.test.ts` covers the helper behavior,
  and `apps/web/src/dashboard-boundaries.test.ts` prevents dashboard feature code from adding direct
  `fetch` calls or server-only workspace imports.
- Latest marketing test milestone: `apps/marketing/src/marketing-page.test.tsx` server-renders the
  React marketing page and verifies the primary positioning, demo/contact calls to action,
  review-signal copy, workflow steps, and proof points remain present.
- Latest release-control milestone: `.github/ISSUE_TEMPLATE/admin-control-plane-production-release.md`
  and `docs/releases/admin-control-plane-production-release.md` define the controlled production
  release ticket, and `infra/railway/*.railway.json` codifies Railway build/deploy settings for
  the API, dashboard, admin gateway, and role-specific worker services.
- Latest deployment-streamlining milestone: `pnpm release:control-plane:railway` wraps the local
  release gates and deployed Railway proof gates in one operator command, with `--local-only`
  available before fresh deployed OAuth/CDP inputs are ready.
- Latest evaluation milestone: `packages/evaluation` now implements the first deterministic
  `26A` gate with `smoke-full-pipeline-v1`, 12 curated no-live-model cases, exact finding matching,
  line-anchor grading, retrieval recall, latency/cost metrics, Markdown/JSON/HTML/JUnit reports,
  and `pnpm eval:ci` wired into `pnpm check`.
- Latest usage/billing milestone: `packages/usage` now implements the first internal ledger
  boundary with validated append-only usage events, deterministic idempotency keys, correction-event
  support, in-memory and Postgres stores, rollup summarization, quota decision helpers, monthly
  quota counters/reservations, local billing account summaries, and versioned LLM token rate-card
  cost estimation. It also compiles seeded free, team, business, and internal plans with active
  entitlement overrides into stable provider-free plan snapshots, and plans, persists, retries, and
  sends usage-based billing meter events for billable review credits. `packages/billing` now
  provides the provider-neutral billing adapter interface, a fake provider for local tests, and a
  Stripe adapter for customer creation, subscription Checkout Sessions, Customer Portal Sessions,
  subscription reads, webhook parsing, meter-event calls, and provider request logging. The API now
  accepts Stripe webhooks through raw-body provider verification, stores inbound billing webhook
  events idempotently, and syncs subscription, invoice, and payment-status mirrors. Review
  orchestration now reserves monthly review credits before expensive PR review work, records
  completed PR reviews as idempotent `review.run` and `review.credit` usage events, consumes
  reserved credits after successful reviews, and records successful review-model calls as durable
  `llm_calls` rows plus idempotent `llm.token` usage events. The admin API and operator dashboard
  now expose scoped usage rollups for reviews, model tokens, ledger event counts, internal cost,
  plan snapshots, entitlement decisions, billing account/subscription/credit/invoice mirrors,
  quota warnings, portal support links, invoice links, billing meter event debug rows, and billing
  reconciliation issues for meter sync lag/failures, failed billing webhooks, failed provider
  requests, quota counter drift, and usage-cost anomalies. Billing managers can now enqueue a
  durable `billing.reconcile.v1` worker job that refreshes provider subscription mirrors, repairs
  monthly review-credit quota counters from the usage ledger, and retries pending or failed meter
  events; the admin API also creates scoped provider checkout and portal sessions with durable
  provider request audit rows.
- Latest feedback/memory milestone: Phase #21 now has an explainable relevant-memory retrieval
  slice. `@repo/memory` ranks active facts by scope specificity, trust, path/category/language
  match, confidence, and recency; returns product-safe trace rows; enforces fact/token budgets; and
  formats selected facts as compact prompt context. `@repo/retrieval` can now accept an optional
  relevant-memory retriever and emits selected facts as explicit `memory_fact` context items with
  trace metadata in the `ContextBundle`.
- Latest memory persistence milestone: `packages/db` now defines generated migration coverage for
  `memory_candidates`, including proposed scope/applies-to payloads, trust/status fields, source
  finding linkage, approval linkage to `memory_facts`, and moderation decision metadata.
- Latest memory inspector milestone: admin and web memory/rules inspection now list applicable
  memory candidates with status, trust, source, confidence, scope/applicability keys, and
  moderation availability.
- Latest memory moderation milestone: `/api/v1/memory-candidates/:memoryCandidateId/approve` and
  `/api/v1/memory-candidates/:memoryCandidateId/reject` now authorize candidate scope, preserve
  idempotency keys, write audit logs, and create or reuse durable memory facts on approval. The
  admin dashboard memory/rules inspector now exposes approve/reject controls for pending rows and
  refreshes the inspector after a moderation decision.
- Latest feedback automation milestone: finding outcome recording now enqueues `memory.update.v1`
  jobs on the memory queue, and the worker handles rejected outcomes by creating idempotent pending
  suppression candidates linked to the finding fingerprint and published finding when available.
- Latest product memory moderation milestone: `/api/v1/repositories/:repoId/memory` now returns
  applicable memory candidates alongside facts for scoped product sessions, and the authenticated
  product repository view exposes pending candidate approve/reject controls while preserving the
  same audited moderation API path and `memory:write` authorization.
- Latest provider feedback milestone: GitHub `issue_comment`, `pull_request_review_comment`, and
  reaction webhooks now normalize PR feedback into redacted metadata with comment body hashes,
  actor login, provider IDs, pull request numbers, and positive/negative reaction signals, then
  plan idempotent `memory.update.v1` jobs on the memory queue. The worker now correlates those jobs
  to `published_findings.provider_comment_id`, writes idempotent `feedback_events` and
  `feedback_signals` rows, and then records `provider_webhook` outcome rows for comments and
  positive/negative reactions without storing raw comment text. Trusted comment commands are now
  parsed through the memory command parser, carried as command hashes plus structured command
  fields, and converted into pending command-sourced memory candidates after provider-comment
  correlation. `/api/v1/findings/:findingId/feedback-events` returns the finding feedback timeline,
  and the product finding detail panel displays the recorded events and classified signals.
- Latest PR-summary memory milestone: worker memory feedback correlation now falls back from inline
  `published_findings` to `published_summary_comments` for trusted summary-comment commands.
  Summary commands persist redacted feedback events/signals and can create pending
  repository-scoped memory candidates without requiring a specific published finding target.
- Latest review-thread feedback milestone: GitHub `pull_request_review_thread` resolved and
  unresolved webhooks now normalize to `comment_thread` memory update jobs with redacted thread and
  comment IDs. The worker persists feedback events/signals for correlated thread updates and maps
  resolved/unresolved state to provider-webhook finding outcomes.
- Latest thread reconciliation milestone: `@repo/github` now reads pull request review-thread
  resolution state through GitHub GraphQL, and scheduled `memory.update.v1` jobs can reconcile
  recent completed review runs into reconciliation-sourced feedback events/signals plus finding
  outcomes when webhooks were missed.
- Latest suppression audit milestone: Phase #21 now persists validation-time memory suppression
  hits in `suppression_matches`, includes those matches in rejected-finding artifacts, exposes
  recent repository suppression hits through the scoped memory API, and shows the history in the
  product repository memory panel.
- Latest repo-sync cleanup milestone: `cleanupRepositoryWorkspace` now validates cleanup targets
  before deletion, refusing relative paths, unmanaged directory names, and retained workspaces
  outside the configured workspace root. Worker index-job cleanup now uses the same guarded helper.
- Latest repo-sync URL/path safety milestone: `@repo/repo-sync` now exports clone URL
  sanitization, SHA-256 URL hashing, host/scheme allowlist validation, secret redaction,
  repository-relative path normalization, root containment checks, and safe path joining. Current
  workspace sync strips credentials/query fragments from clone remotes and rejects unsupported
  clone URL schemes or hosts before running Git commands.
- Latest repo-sync Git runner milestone: `@repo/repo-sync` now exports a timeout-aware Git runner
  factory plus a product-safe `RepoSyncGitCommandError` that carries stable failure codes,
  redacted command text, bounded captured stdout/stderr, exit code, signal, and timeout metadata.
  Authenticated fetches pass the clone token as a redaction secret for runner failure handling, and
  Git subprocesses now run with a narrow environment that sets non-interactive prompt behavior,
  disables system Git config, skips LFS smudge by default, pins `LC_ALL=C`, preserves required
  platform basics, and only includes explicit command-specific overrides.
- Latest repo-sync deterministic checkout milestone: workspace sync now rejects branch names,
  abbreviated SHAs, and uppercase SHA input before invoking Git, and authenticated fetches include
  `--no-tags` alongside the shallow exact-SHA fetch.
- Latest repo-sync cache configuration milestone: `@repo/repo-sync` now exports typed repo-sync
  cache/runtime config defaults, REPO_SYNC_* environment parsing, normalized allowed-host lists,
  cache-root validation, and safe path builders for mirror, temp mirror, worktree, and lock paths
  under the standard mirrors/worktrees/tmp/locks layout.
- Latest repo-sync command-construction milestone: `@repo/repo-sync` now exports tested Git argv
  builders for bare partial clones, ref fetches, commit-existence checks, detached worktree add,
  forced worktree removal, and worktree metadata pruning, with argument validation for empty,
  null-byte, and dash-prefixed unsafe values.
- Latest repo-sync mirror-cache milestone: `@repo/repo-sync` now exports `ensureRepositoryMirror`,
  which validates and sanitizes clone URLs, creates bare partial-clone mirrors through an atomic
  temporary path, injects HTTPS basic credentials through a temporary askpass helper, removes clone
  temp paths and askpass files on success or failure, and reuses existing mirror paths without
  cloning again.
- Latest repo-sync mirror-commit milestone: `@repo/repo-sync` now exports `ensureRepositoryCommit`,
  which reuses or creates the cached mirror, checks exact commit availability with `cat-file`,
  fetches caller-provided ref hints before falling back to a direct commit fetch, rechecks the
  requested commit after each fetch, and keeps fetch credentials in temporary askpass helpers.
- Latest repo-sync cache-lock milestone: `@repo/repo-sync` now exposes a bounded filesystem lock
  helper under the configured cache `locks/` directory and uses it to serialize mirror creation,
  missing-commit fetches, and worktree add/remove/prune mutations. Concurrent same-repo fetch
  callers recheck commit availability after waiting so one successful fetch can satisfy the rest.
- Latest repo-sync worktree-lease milestone: `@repo/repo-sync` now exports
  `createRepositoryWorktreeLease`, which creates detached worktrees from cached mirrors under
  generated lease paths, returns lease metadata with TTL timestamps and purpose, removes residual
  paths when worktree creation fails, and releases leases idempotently with forced worktree removal
  plus stale metadata pruning.
- Latest repo-sync worktree-validation milestone: cached worktree leases now validate
  `git rev-parse HEAD`, `git rev-parse --show-toplevel`, and `git status --porcelain=v1` after
  worktree creation and before returning the lease. If Git resolves a different commit, a different
  repository root, or a dirty status, repo-sync removes the failed lease path and prunes worktree
  metadata instead of handing an unverified workspace to index or review jobs.
- Latest repo-sync workspace-quota milestone: cached worktree leases now measure workspace disk
  usage through an injectable disk-usage boundary backed by default filesystem traversal that does
  not follow symlink targets. Repo-sync rejects worktrees over `maxWorkspaceBytes`, removes the
  failed lease path, prunes worktree metadata, and returns measured `workspaceSizeBytes` for
  accepted leases.
- Latest repo-sync cache-stats milestone: cached worktree leases now persist local sidecar metadata
  outside the worktree with repo, commit, purpose, TTL, path, and measured size. `@repo/repo-sync`
  now reports local cache stats for total cache bytes, mirror bytes, worktree bytes, metadata bytes,
  per-mirror active worktree counts, and active workspace metadata, and expired-worktree cleanup
  removes matching metadata while stats coverage verifies reclaimed worktree bytes.
- Latest repo-sync local-Git milestone: `@repo/repo-sync` now has a real Git integration test that
  creates a temporary repository, commits a file, clones it as a bare mirror, leases an exact-commit
  worktree through the production lease path, validates the checked-out file and measured size, and
  releases the worktree plus local lease metadata. Worktree root validation canonicalizes paths with
  `realpath()` so macOS `/var` and `/private/var` temp-path aliases compare correctly.
- Latest repo-sync acquire-workspace milestone: `@repo/repo-sync` now exports
  `acquireRepositoryWorkspace`, which composes mirror creation/reuse, exact commit verification and
  fetch, and detached worktree leasing into one cached exact-commit workspace acquisition API with
  mirror-created and fetched metadata.
- Latest worker repo-sync integration milestone: worker index jobs now acquire repository
  workspaces through a cached repo-sync adapter that resolves GitHub clone credentials, passes them
  to `acquireRepositoryWorkspace`, gives the resulting worktree path to the configured indexer
  driver, emits product-safe acquire/release logs with the repo-sync lease ID, and releases the
  worktree lease after index artifact import.
- Latest review repo-sync integration milestone: review orchestration now uses a cached repo-sync
  workspace adapter by default, passes pull-request/base ref hints into exact-commit mirror fetches,
  includes the repo-sync lease ID in workspace stage logs and durable stage metadata, retains leases
  only for static-analysis execution, and releases cached worktree leases through the lease API
  instead of deleting worktree paths directly.
- Latest repo-sync expired-worktree cleanup milestone: `@repo/repo-sync` now exposes
  `cleanupExpiredRepositoryWorktrees`, which scans cached `worktrees/lease_*` paths, removes bounded
  expired directories, supports dry-run planning, skips active or unmanaged entries, and prunes stale
  worktree metadata from cached mirrors after deletion.
- Latest worker repo-sync cleanup milestone: worker startup now builds one shared repo-sync
  configuration, passes it to index and review workspace acquisition, runs expired cached worktree
  cleanup before starting queue workers, supports an environment-configured cleanup limit, and logs
  cleanup summaries when worktrees are removed or failures occur.
- Latest repo rules/configuration milestone: Phase #22 now compiles an explicit memory policy into
  immutable review policy snapshots. `@repo/rules` exposes default memory context/suppression
  limits, trusted feedback roles, approval requirements, and `evaluateMemoryPolicy` decisions for
  memory context, durable fact creation, exact suppression, path/category suppression, and natural
  language memory instructions. The API now also exposes scoped admin and product policy-test
  endpoints that compile the current draft policy, classify a sample path, and return the sample
  finding decision trace for local rule debugging.
- Latest org policy milestone: Phase #22 now defines `OrgSettings` contracts, persists
  `org_settings` rows through a generated Drizzle migration and DB helpers, and passes persisted
  organization defaults into webhook trigger planning, review orchestration, and API policy
  previews. The policy compiler records org settings inputs in immutable snapshots, can disable
  user-defined rules, applies org finding/trigger/publishing guardrails, and can turn off
  memory-based suppression at the organization layer.
- Latest org settings API milestone: `/api/v1/orgs/:orgId/settings` now returns effective
  organization policy defaults and accepts audited partial updates for nested trigger, finding,
  publishing, and memory policy defaults. Product-session writes require `org:manage`, while signed
  support/admin sessions keep the existing scoped access and CSRF checks.
- Latest org settings UI milestone: the authenticated product workspace now loads organization
  policy defaults with the selected organization and renders editable trigger, finding, publishing,
  memory, repo-local-config, rule, and model-profile controls for users with organization
  management permission.
- Latest repo-local config parser milestone: `@repo/rules` now defines strict repo-local
  config-file schemas and parses trusted YAML/JSON from allowed `.ai-reviewer` paths with a size
  limit, source commit/path/hash metadata, YAML alias/merge safeguards, unknown-key rejection,
  dangerous path-pattern rejection, and guardrails that block config files from disabling reviews
  or lowering severity/confidence below the default safety floor unless policy explicitly allows it.
- Latest repo-local config merge milestone: the policy compiler now accepts parsed repo-local
  config only when organization settings allow it, merges review mode, comment budget, confidence,
  severity, category, path, publishing, trigger, and memory overrides with deterministic clamps, and
  records repo-local config source path, commit SHA, hash, and version in review policy snapshots.
- Latest repo-local config loading milestone: review orchestration now asks the Git provider for
  allowed repo-local config files at the pull request base SHA, parses the first trusted config
  file that passes validation, and passes it into policy compilation only when organization
  settings enable repo-local config. `@repo/github` now exposes repository file-content reads for
  real and fake providers with focused coverage for decoded contents and missing files.
- Latest repo-local config validation API milestone: `@repo/contracts` now defines strict
  repo-local config validation request/response DTOs, and the API exposes scoped admin and product
  routes that validate draft YAML/JSON config content with the same parser used by review
  orchestration. Responses include parsed config, validation errors, parser warnings, and an
  organization-settings warning when repo-local config is currently disabled.
- Latest repo-local config change milestone: review orchestration now detects PR changes to
  allowed repo-local config files when organization settings enable repo-local config, keeps the
  review on the trusted base-branch policy, stores a product-safe policy warning in review metadata
  and trace artifacts, and inserts an idempotent system audit row for the detected config change.
- Latest repo-local trigger milestone: Phase #22 now compiles repo-local `include_base_branches`
  and multi-label `require_any_label` filters into the effective trigger policy and applies them
  during webhook job planning and review-run gating using pull request metadata.
- Latest repo-local rule action milestone: `@repo/rules` now compiles repo-local
  `enabled_categories`, `disabled_categories`, `severity_threshold`, `minimum_confidence`, and
  scoped `suppress_findings` rule actions into source-attributed synthetic suppression rules.
  Repo-local rules can now match on language, pull request author, labels, title regex, and
  confidence thresholds; unscoped direct suppression and invalid title regex rules are rejected.
  The shared repository-rule matcher supports confidence-below thresholds, and the product rule
  form can display and edit that matcher field.
- Latest repo-rule matcher milestone: Phase #22 now evaluates repository suppression rules against
  source-file language, pull request author, labels, and confidence thresholds, not only
  path/category/severity/title. Review validation derives those matcher inputs from the immutable PR
  snapshot and changed-file metadata before invoking policy-aware finding validation.
- Latest static-analysis milestone: Phase #23 now has an MVP deterministic signal boundary.
  `@repo/static-analysis` plans bounded changed-file tool runs, filters tools by language,
  category, request, and budgets, emits runnable local/sandbox command specs for ESLint, Biome, and
  TypeScript, Ruff, Pyright, Mypy, and Semgrep, normalizes diagnostics with stable fingerprints and
  changed-line metadata, parses ESLint JSON formatter output, Biome JSON reporter output,
  TypeScript `tsc --pretty false` text output, Ruff JSON output, Pyright JSON output, Mypy text
  output, and Semgrep JSON output into product-safe diagnostics/warnings, and builds summary
  reports from a runner. Fixture-backed parser corpus coverage now exercises ESLint, Biome,
  TypeScript, Mypy, Pyright, Ruff, Semgrep, Go vet, Staticcheck, and Cargo outputs with
  multi-diagnostic changed-line coverage.
  Reports now carry an explicit raw-output retention policy that states full stdout/stderr payloads
  are not stored, while normalized diagnostics and execution metadata are retained.
  `@repo/tool-runner` defines the command runner contract, a
  fixture-backed fake runner, a local shell-free process runner with explicit environment assembly,
  timeout termination, bounded stdout/stderr capture, spawn-failure normalization,
  secret-aware display-command redaction, and a sandbox-backed adapter that translates tool runs
  into hardened sandbox requests. Static-analysis requests now pass review, repository, workspace,
  commit, and PR SHA metadata into the runner so sandbox requests remain traceable.
  `@repo/review-engine` now exposes a static-analysis synthesis pass that maps changed-line
  diagnostics into candidate findings with static-analysis evidence, severity/category mapping, and
  report/tool metadata for the existing validation path. Review orchestration can now opt into
  static-analysis execution with a configured runner, persist the report artifact, include
  static-tool findings in the review pass set, and clean up default retained workspaces after
  execution. Static-analysis report artifacts now persist payload-free counters for status,
  duration, tool runs, diagnostics, changed-line diagnostics, high-severity diagnostics, and
  warnings; the scoped API and dashboard artifact lists expose those counters without reading raw
  report payloads. The worker can now select `STATIC_ANALYSIS_RUNNER=fake` or
  `STATIC_ANALYSIS_RUNNER=local_process`/`SANDBOX_RUNNER=local_process`, `docker`, or `gvisor` to
  pass a sandbox-backed runner into review orchestration.
- Latest sandbox milestone: Phase #24 now has a reusable sandbox execution contract package.
  `@repo/sandbox` validates v1 run requests and results, publishes hardened default environment,
  network, limits, security, output, and artifact policies, normalizes and redacts bounded output,
  emits baseline safety decisions for blocked images, host environment inheritance, weak network
  guards, Linux capabilities, runtime hardening, and Docker socket mounts, and includes a
  deterministic `FakeSandboxRunner` for static-analysis and future worker tests.
  `@repo/tool-runner` now provides `createSandboxToolRunner` to turn generic static-tool commands
  into sandbox run requests with explicit command argv, no shell, bounded outputs, redacted env
  keys, read-only workspace mounting, writable tmp/output mounts, and sandbox status/output mapping
  back to `ToolRunnerResult`. `@repo/sandbox` also now exposes `LocalProcessSandboxRunner` for
  local development and trusted fixtures only; it is blocked in production, emits an unsafe-runner
  warning, validates request safety, denies non-`none` network policies, maps sandbox working
  directories through bind mounts, and enforces timeout plus bounded/redacted stdout/stderr capture.
  The sandbox package now also evaluates tool-specific policy decisions for image allowlists, argv
  prefix allowlists, network denial, resource maximums, writable paths, secret-looking env vars,
  unsafe path arguments, and dependency-install commands. Docker runner support now includes a
  shell-free command builder that emits hardened `docker run` argv data, explicit Docker-process
  environment, read-only root/no-network/no-new-privileges/drop-capability flags, resource limits,
  bind/tmpfs/volume mounts, and policy rejection for unsupported network modes without requiring
  Docker in CI. `DockerContainerSandboxRunner` and `GVisorSandboxRunner` now materialize host
  output binds, execute through an injectable Docker process executor or the Docker CLI, map
  timeout/output/status results back to `SandboxRunResult`, collect declared artifacts into durable
  local file-URI roots, deny symlink escape artifacts before copying, and clean transient output
  directories. Worker runtime selection now accepts `SANDBOX_RUNNER=docker` and
  `SANDBOX_RUNNER=gvisor` with optional Docker executable, runtime, temp-root, and artifact-root
  environment overrides, and production workers now reject `fake` and `local_process` sandbox
  runners before static-analysis tool execution can start. `sandbox.cleanup.v1` jobs now provide a
  bounded scheduled/operator cleanup path for stale sandbox runs and local file artifacts, including
  scoped sandbox run history plus an audited admin API/dashboard enqueue control with dry-run
  defaults and repository scoping.
  Maintenance-capable worker runtimes now enqueue
  idempotent recurring retention cleanup jobs for sandbox runs and expired review artifact payloads
  with configurable interval, limits, dry-run mode, and sandbox age. `pnpm smoke:sandbox:docker`
  now reruns the local Docker sandbox smoke from the repo root, and
  `docs/evidence/sandbox-docker-smoke-proof.json` records the latest product-safe proof.
- Latest sandbox DB milestone: `@repo/db` now defines `sandbox_runs`, `sandbox_artifacts`, and
  `sandbox_policy_decisions`, with generated Drizzle migration and schema tests. The tables capture
  run identity, review/static-analysis ownership, runner kind, trust/category, image, command,
  policy, limits, status, exit/signal, output hashes/truncation, resource usage, errors, warnings,
  collected artifacts, and product-safe policy decisions. Worker-created static-analysis sandbox
  runners now wrap the selected sandbox runner with DB persistence so completed sandbox requests and
  results are recorded transactionally with idempotent child artifact and policy-decision rows. The
  admin review inspector and dashboard now include persisted sandbox run summaries with runner,
  policy-decision, output-hash, artifact metadata, and failure details. `@repo/rules` now includes
  the resolved sandbox policy in the immutable review policy snapshot, including safe MVP defaults,
  runner posture, network/dependency/custom-command clamps, and bounded resource limits that are
  visible in the dashboard policy preview. Repository settings now also persist optional sandbox
  policy overrides in `repository_settings.sandbox_policy`, accept them through settings patch APIs,
  and feed them into the compiler before safety clamps are applied. The shared admin/product
  repository settings form now exposes those sandbox policy overrides for runner selection, fork
  posture, network/dependency/custom-command requests, and resource/output/artifact limits.
- Latest observability milestone: Phase #25 now includes typed runtime configuration and resource
  attributes in `@repo/observability`. Services can parse `OBSERVABILITY_*` environment variables
  for enablement, service identity, deployment environment, exporter mode, OTLP endpoint, log
  level, trace sample rates, metrics interval, and redaction flags, then produce stable
  OpenTelemetry-style resource attributes without customer identifiers. The observability package
  now also provides a structured JSON logger facade, safe attribute sanitization, secret/email
  redaction, and error classification/serialization that avoids raw error leakage by default. A
  no-op/console runtime bootstrap now packages config, resource attributes, admin telemetry sinks,
  structured logging, service-name defaults, a safe metric recorder, and shutdown hooks wired into
  API and worker startup. API and worker startup now emit low-cardinality lifecycle counters
  through the runtime-selected metric sink. API `/livez` and `/readyz` now expose product-safe
  health responses, with readiness covering runtime configuration plus Postgres and Redis
  availability by default while allowing deterministic injected checks in tests and custom
  composition. The
  observability package now also normalizes W3C `traceparent`/`tracestate`, request IDs, and
  durable parent event IDs, and API/webhook enqueue paths now persist that trace context on
  durable job envelopes for request-to-worker propagation. The observability runtime now exposes a
  product-safe span recorder, and durable worker processors emit one structured span per job run.
  Review orchestration now emits product-safe spans for quota, snapshot, workspace, static-analysis,
  index, retrieval, review, validation, staleness, and publish stages, and it carries trace context
  into publisher handoff jobs. The admin overview now includes the product-safe API readiness
  response, and the operator dashboard renders each readiness check as runtime health. OTLP exporter
  mode now initializes OpenTelemetry log, metric, and trace providers with product-safe facades,
  bounded batch export, per-signal OTLP HTTP endpoints, sampling, resource attributes, optional
  global provider registration, and shutdown flushing. API request-boundary telemetry now emits
  low-cardinality request counters, duration histograms, and server spans through the runtime
  facade while propagating incoming W3C trace context. Durable queue processing now emits
  low-cardinality job start, completion, final failure, retry, and duration metrics from the same
  worker boundary that owns durable job spans. Worker maintenance schedulers now emit
  low-cardinality scheduled-job and scheduler-failure counters for compliance evidence and
  retention cleanup enqueue paths. GitHub webhook deliveries now emit delivery,
  duration, duplicate, and rejection metrics plus provider delivery spans using only safe provider,
  event, action, status, and reason labels. LLM gateway calls now emit product-safe call, duration,
  retry, rate-limit, and structured-output-failure metrics plus `llm.generate_object` client spans
  with bounded task, provider, model-profile, status, and error-class attributes. Retrieval now
  emits product-safe request, duration, source-candidate, packed-context-item, and context-token
  metrics plus `retrieval.build_context` spans with only aggregate counts, mode labels, status, and
  safe correlation IDs. The local Grafana provisioning bundle now includes starter dashboards that
  graph the corresponding Prometheus metrics for API, queue, review pipeline, LLM/retrieval,
  indexing/embedding, publishing, and webhook delivery checks. The local Prometheus configuration
  now also loads starter alert rules linked to the Phase #25 alert runbook for API, webhook, queue,
  review, publishing, LLM, indexing, and sandbox risks.
- Latest observability service-coverage milestone: the admin gateway now depends on
  `@repo/observability`, initializes the shared runtime with a stable `heimdall-admin-gateway`
  service identity, adapts gateway operator events into structured telemetry attributes, logs
  startup/shutdown through the shared logger, and flushes telemetry providers during shutdown. API
  and worker process-level startup, shutdown, dispatcher, maintenance, and indexer-capability logs
  now use structured telemetry instead of direct console writes. `pnpm check` passed after this
  service-coverage checkpoint.
- Latest evaluation milestone: Phase #26 baseline comparison now includes case-level comparison
  rows and CI-safe Markdown. `@repo/evaluation` reports baseline and candidate metrics, metric
  deltas, improved and regressed case IDs, lost and newly found expected findings, new false
  positives, and resolved false positives so eval reports can explain regressions instead of only
  failing a threshold gate. The eval CLI exposes this comparison path through `eval compare`, writes
  optional Markdown output, and exits nonzero by default when the comparison detects a regression.
  `pnpm eval:ci` now compares the generated smoke report against a checked-in baseline report and
  writes `comparison.md`, so `pnpm check` fails on quality regressions as well as threshold misses.
  Evaluation artifact writing now also emits a static CI-safe HTML report plus JUnit XML with eval
  case and gate-check testcases for CI systems that collect test reports. The DB schema now includes
  eval suites, cases, variants, runs, case results, human labels, and active baseline pointers for
  historical eval storage, plus a repository boundary for transactional history writes and
  run/result queries. The eval CLI can now optionally persist a product-safe history record with
  suite/case/variant/run/case-result rows and artifact file URIs when invoked with history
  persistence options. Admin evaluation history routes and the operator dashboard now expose
  persisted suites, latest run state, active baselines, recent runs, and case-level result rows
  without loading raw fixture code. The eval harness can also import a
  reviewed `EvalCase` or admin eval import draft into a suite fixture with duplicate-case
  protection and an explicit replacement flag. A scheduled/manual GitHub Actions workflow now runs
  the smoke eval and persists eval history when `EVAL_HISTORY_DATABASE_URL` is configured, while
  still producing local artifacts without persistence when the secret is absent. `@repo/evaluation`
  now also defines the portable human-finding-label schema and `eval_human_labels.v1` file format,
  and the eval CLI can import/export those labels through the persisted eval history store.
- Latest security/compliance milestone: Phase #27 now has data classification, retention, and
  normalized security-event helpers in `@repo/security`. Artifact producers can classify public,
  internal, customer confidential, customer code, secret, and regulated personal data; attach
  artifact security metadata; map artifact types to retention classes; and compute
  storage/expiration decisions from the default or organization-specific retention policy,
  including disabled prompt artifact storage and while-enabled index retention. `@repo/security`
  also defines SecretRef parsing/formatting, a SecretsManager boundary, local environment secret
  resolution, production-provider placeholders, redacted resolved-secret helpers, and rotation
  record contracts. The worker resolves its GitHub App private key through that boundary using
  `GITHUB_APP_PRIVATE_KEY_SECRET_REF` with local env fallback. It now also resolves LLM and
  embedding provider API keys through SecretRef variables such as
  `LLM_PROVIDER_API_KEY_SECRET_REF`, `EMBEDDING_PROVIDER_API_KEY_SECRET_REF`,
  `OPENAI_EMBEDDING_API_KEY_SECRET_REF`, and `OPENAI_API_KEY_SECRET_REF`, with local environment
  fallbacks before constructing the real OpenAI-compatible review or embedding provider. The API
  resolves its GitHub webhook secret through the same boundary using `GITHUB_WEBHOOK_SECRET_REF`,
  keeps local `GITHUB_WEBHOOK_SECRET` fallback for development, supports previous-secret fallback
  during rotation, and records the matched webhook secret version in durable webhook metadata.
  Repo sync now keeps Git remotes credential-free, supplies installation tokens through a temporary
  environment-backed askpass helper for `git fetch`, removes that helper after use, and exposes a
  product-safe Git remote URL redactor. The API now mints audited signed support-session tokens for
  privileged raw-data support workflows and validates actor, scope, resource, and expiration before
  raw artifact or raw eval access. `@repo/security` now also exposes text and prompt secret
  redaction helpers for GitHub tokens, LLM API keys, AWS key IDs, private-key blocks, JWTs,
  credential URLs, secret assignments, and explicit literal secret values. The LLM gateway applies
  that prompt redactor before provider calls by default, review orchestration records LLM call
  hashes and token estimates from the same redacted prompt text, and review prompts label PR text,
  diff content, and retrieved context as untrusted customer input. Review orchestration now persists
  review artifact retention metadata and `retention_until`, `@repo/artifacts` can delete inline,
  filesystem, and
  S3/R2-backed payloads, and the worker handles `review_artifact.cleanup.v1` jobs that remove
  expired payload bytes or inline payload metadata while leaving product-safe tombstone rows. The
  API now emits product-safe security events for invalid GitHub webhook signatures, high-risk admin
  denials, support-session violations, and cross-tenant admin `/api/v1` scope denials through an
  injectable sink, and the production API entrypoint persists those events to the durable
  `security_events` table. Scoped audit viewers can now search persisted security events by
  organization, repository, severity, source, status, type, actor, resource, or text through the
  admin API and operator dashboard.
- Latest security data-deletion milestone: `@repo/contracts` now defines durable data-deletion
  request IDs, reasons, scopes, statuses, request rows, and product-safe manifests. `@repo/db` now
  includes the generated `data_deletion_requests` table plus `DataDeletionRepository` helpers for
  idempotent request creation, scoped listing, lookup, lifecycle transitions, scoped repository
  resolution, review artifact payload target selection, repo embedding deletion, pending/queued
  durable job cancellation, and scoped repository disablement. The guarded Postgres integration
  test verifies request idempotency, org/repo/status filtering, newest-first ordering, completion
  evidence updates, cleanup target selection, embedding deletion, job cancellation, repository
  disablement, and limit validation.
- Latest uninstall deletion execution milestone: GitHub installation removal webhooks now persist
  the local installation as deleted and enqueue a `data_deletion.plan.v1` job on the security
  queue. Security-role workers can consume that queue, create the scoped deletion request when
  needed, transition it to `planned` with an initial product-safe manifest, and unless dry-run
  execute the request by deleting/tombstoning review artifact payloads through the configured
  artifact store, cleaning scoped sandbox rows, deleting code-chunk embeddings, canceling pending
  durable jobs, disabling scoped repositories, and completing the request with verification
  metadata.
- Latest worker security-event milestone: the worker runtime now creates a Postgres-backed
  security-event sink and records product-safe `data_deletion_completed` and
  `data_deletion_failed` events for security-role deletion workflows, including scoped request ID,
  reason, scope, and deletion counters without raw payload data. Worker tests cover failed
  deletion planning event emission through the sink boundary.
- Latest compliance evidence milestone: `@repo/security` now defines stable MVP compliance control
  IDs, evidence types, sources, statuses, product-safe descriptor creation, and metadata
  sanitization for access review, audit export, config snapshot, data deletion, and security-event
  evidence. `@repo/db` now includes the generated `compliance_evidence` table plus a
  `ComplianceEvidenceRepository` with scoped filters for control, type, status, source, and search.
  `@repo/admin-tools` now collects access-review membership exports, audit-log exports,
  security-event exports, and configuration snapshots into product-safe JSON artifacts backed by
  memory or filesystem stores, then records durable evidence rows with artifact URIs and SHA-256
  digests. The admin CLI now exposes the collectors as
  `admin compliance collect <all|access-review|audit-log|security-events|config-snapshot>` with
  explicit filesystem artifact output, optional org scoping, row limits, and JSON summaries.
  `@repo/contracts` now defines `compliance_evidence.collect.v1` payloads, and security-role
  workers can execute those jobs for scheduled or operator-triggered evidence collection.
  Maintenance-capable worker runtimes now enqueue one idempotent recurring collection job per
  configured schedule bucket, and completion and failure outcomes for those jobs now emit
  product-safe worker security events.
  Collector tests verify that raw audit metadata and custom repository instructions are excluded
  from exported evidence, and worker tests verify scheduler job creation, dispatch, completion
  event emission, and failure event emission through the configured collector hook.
- Latest verification: `pnpm smoke:review:github` completed with webhook event
  `webhook_zcXI0Oj5qVyrmzFMO2ufYUqHVh`, review run
  `rrn_YjVZfH70cGNJCMEQgKalTf7WIb`, index job `job_ae39170509eb4097ba1aed094fabc031`,
  review job `job_377e5f0745174069a6321293f9a9a15b`, publish job
  `job_YJTOV7tFDcWYwVONgniCMsiz_H`, publish run `pub_YfHdVTUtRQd5vBILPuOvebn0_A`,
  check run `74535779228`, review `4232636849`, and comment `4384492583`.
- The latest live PR review smoke completed with indexed retrieval through index version
  `idx_4yuBX7BUkvP2mSkbb0OsjWisDz`.
- Optional live integration tests require `HEIMDALL_DB_TEST_URL` and `HEIMDALL_REDIS_TEST_URL`.
  The live publisher and provider-error smoke commands also require development GitHub App
  credentials. Publisher writes require `HEIMDALL_GITHUB_SMOKE_ALLOW_WRITE=true`; provider-error
  validation probes require `HEIMDALL_GITHUB_ERROR_SMOKE_ALLOW_INVALID_WRITE=true`.
- Drizzle schema files are the source of truth for DB structure. Do not manually edit generated migration SQL.

## Recommended Next Goal

Execute the controlled Railway production release, then add post-release production monitoring
dashboards and issue-level follow-up tracking for remaining product phases.
