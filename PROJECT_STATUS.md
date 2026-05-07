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
| #0 Core contracts and shared types | Partial | `packages/contracts`, `b9b4635` | Enough contracts exist for current DB, webhook, and queue work. Continue expanding as later phases need new boundary types. |
| #1 Monorepo and build system | Partial | `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `.github/workflows/ci.yml` | Workspace, TypeScript, Biome, Vitest, Turbo, boundary checks, and a GitHub Actions CI gate are active. Broader release automation remains. |
| #2 Database layer | Partial | `packages/db`, `drizzle.config.ts`, `packages/db/migrations/0000_foundation.sql`, `packages/db/migrations/0009_high_sphinx.sql`, `b9b4635` | Drizzle schema, generated migrations, bootstrap extensions, client, and repository helpers exist. Product auth persistence now includes users, provider accounts, organization memberships, opaque user sessions, and one-time OAuth state rows. More repository methods and live DB verification remain. |
| #3 GitHub App integration | Done | `packages/github`, `docs/runbooks/github-dev-app.md`, `408f7bd` | Provider surface, installation token caching, repo discovery, PR snapshot fetching, clone auth, publishing primitives, inline review dedupe, summary-comment dedupe, check-run create/update, fake provider coverage, typed error mapping, basic rate-limit header observation, and a manual dev-app runbook exist. The latest live PR review smoke provides the current MVP test-repository proof. |
| #4 Webhook ingestion | Done | `packages/webhook-ingestion`, `apps/api/src/app.ts`, `b9b4635` | Handles GitHub installation, repository, and pull request webhooks with signature verification, persistence, idempotency, and job planning. |
| #5 API server | Partial | `apps/api`, `apps/api/package.json`, `packages/security`, `packages/artifacts`, `b9b4635` | Health check, GitHub webhook route, bearer-guarded internal admin-debug routes, signed admin control-plane auth, settings/history/rule reads, settings updates, repository-scoped rules CRUD, repository policy preview, repository-scoped memory/rules inspection, scoped usage rollup APIs, provider-free entitlement inspection APIs, billing reconciliation inspection and repair enqueue APIs, billing checkout/portal session APIs, audited redacted review debug bundle export, audited eval import draft creation, OpenAPI documentation in non-production environments, product role/permission helpers, GitHub OAuth start/callback routes, DB-backed product session read/revoke support, `/api/v1/me`, `/api/v1/auth/logout`, and product-session `/api/v1` org list/detail, installation list/detail/sync enqueue, GitHub install URL/callback helper, repository list/detail/settings, repository enable/disable, repository sync/reindex, repository rules CRUD, repository policy preview, scoped review-run list/detail with failure summaries and related durable job summaries, review finding list/detail, finding outcome update, suppress-similar rule creation, review rerun enqueue, review artifact metadata listing plus audited redacted payload reads/downloads through DB-inline, filesystem, or S3/R2-compatible review artifact payload stores, raw object-storage artifact signed download URL creation behind support-session access, repository memory fact CRUD, and product usage summary/event routes exist with product RBAC and admin support-session fallback. Large-payload streaming and final hardening remain. |
| #6 Web dashboard | Partial | `apps/web/src/main.ts`, `apps/web/src/styles.css` | Operator dashboard views exist for admin-debug webhook, review, publisher, and memory/rules inspection, guarded replay controls, redacted review debug bundle export, eval import draft creation, repository settings editing, repository-scoped rule CRUD, effective policy preview, usage rollups, plan/entitlement inspection, billing state, reconciliation alerts and repair enqueue controls, audit history, product session status, GitHub sign-in, refresh, and sign-out controls, and an authenticated product workspace for org selection, synced repositories, repo enable/disable actions, repository settings editing, repository-scoped rule CRUD, policy preview, review detail, failed review summaries, related durable job timeline, finding list/detail inspection, finding outcome controls, suppress-similar controls, review rerun action, artifact metadata views, audited redacted artifact payload previews/downloads, recent reviews, and basic usage cards. Broader route/query hardening remains. |
| #7 Job queue and orchestration | Partial | `packages/queue`, `apps/worker`, `packages/db/src/schema/tables.ts` | Current async backbone scope exists: pending durable rows, outbox dispatch to BullMQ, worker lifecycle updates, retry/idempotency coverage, and worker handler registration, including indexing, embedding, review, publishing, and billing reconciliation jobs. Broader operational controls remain. |
| #8 Repo sync and workspace manager | Partial | `packages/repo-sync`, `apps/worker/src/index.ts` | Repo sync can obtain GitHub clone auth, create an exact-commit workspace, verify `HEAD`, hand the workspace to the TypeScript indexer, and clean up temporary workspaces. Broader workspace caching remains. |
| #9 Indexer boundary | Partial | `packages/indexer-driver`, `apps/indexer-cli`, `apps/worker/src/index.ts` | Typed indexer driver boundary exists with fake-driver and registry coverage, the worker consumes artifacts through the boundary, `@repo/indexer-driver` includes a CLI driver wrapper with safe env allowlisting, request-file writing, per-run output/log directories, bounded stdout/stderr capture, artifact validation, and timeout/process failure normalization, `@repo/indexer-driver` includes a remote HTTP driver that submits and polls remote runs, downloads or accepts inline artifact JSON, preserves durable remote artifact URIs, validates artifacts before import, and normalizes remote failures, drivers expose capabilities, `@app/indexer-cli` can print TypeScript indexer capabilities or run the TypeScript indexer against a local workspace from flags or request JSON and write artifact JSON, and the worker can select the default in-process driver, CLI driver, or remote driver at runtime with `INDEXER_DRIVER` and related environment while failing startup if the selected driver does not support the current artifact schema. Object-storage index artifact upload/import separation, richer validation modes, and broader observability remain. |
| #10 Index artifact schema | Partial | `packages/index-schema`, `packages/indexer-driver`, `packages/index-importer` | Artifact records are validated and consumed by the driver/importer path. Confirm full schema coverage and compatibility fixtures before marking done. |
| #11 TypeScript indexer | Partial | `packages/indexer-ts`, `packages/indexer-ts/test` | TypeScript indexer emits files, symbols, edges, chunks, manifest hashes, and deterministic fixtures. Broader language coverage, incremental behavior, and generated/vendor heuristics remain. |
| #12 Index importer | Partial | `packages/index-importer`, `apps/worker/src/index.ts` | Importer persists index versions, files, symbols, edges, chunks, and durable embedding jobs idempotently, now includes filesystem/file-URI and S3/R2-compatible whole-artifact resolvers plus `importIndexArtifactFromUri` for URI-first handoff paths, and the worker uses that URI-first path for locally persisted index artifacts. Bulk/COPY paths, richer import batch state, streaming record import, manifest-plus-records layouts, and object-copy/bulk object paths remain. |
| #13 Embedding pipeline | Partial | `packages/embedding`, `apps/worker/src/index.ts`, `packages/embedding/test` | Durable embedding jobs are handled by the worker, deterministic 1536-d embeddings are stored in pgvector, vector dimensions are validated, progress is cumulative, code chunk embedding inputs now include stable metadata headers, SHA-256 input hashes, conservative token estimates, truncation, and provider request batching, and the worker selects the local hash/fake embedding provider from environment configuration. Real provider adapter, usage/cost records, durable cache reuse, embedding job tables, and telemetry remain. |
| #14 Retrieval engine | Partial | `packages/retrieval`, `packages/review-orchestrator/src/index.ts`, `packages/retrieval/test/retrieval.test.ts` | Retrieval now uses imported index rows for same-file, symbol, graph, related-test, lexical, and vector-backed context with diff fallback, validates returned context bundles against the shared TypeBox contract, and records non-fatal warnings when optional indexed retrievers fail. Full-text search, repo rules, traces, and dashboard inspection remain. |
| #15 PR snapshot and diff model | Partial | `packages/pr-snapshot`, `packages/webhook-ingestion/src/github/payload.ts`, `packages/github`, `packages/db/src/repositories/pull-request-repository.ts`, `408f7bd` | Webhook payload normalization creates shallow snapshots, the GitHub provider can fetch full changed-file snapshots and now returns the exact raw diff alongside snapshots while delegating raw diff hashing plus hunk modeling to `@repo/pr-snapshot`, review orchestration refreshes persisted snapshots for a fetched head SHA and persists raw-diff, line-anchor-index, and change-set review artifacts through `@repo/pr-snapshot` helpers, and `@repo/pr-snapshot` now parses basic unified diffs into provider-neutral changed-file contracts with raw diff hashing, canonical snapshot hashing, quoted Git path handling, copied-file and mode-only metadata handling, golden fixture coverage for added/deleted, multiple-hunk, no-newline, and zero-line range diffs, commentable line and file-level fallback indexes, GitHub review-comment anchor conversion for verified single-line, same-side same-hunk multiline, and file targets, and deterministic change-set extraction for ranges, modified blocks, path sets, and renames. Mixed-side multiline expansion remains deferred. |
| #16 Review orchestrator | Partial | `packages/review-orchestrator`, `packages/artifacts`, `apps/worker/src/index.ts` | Worker handles `pr.review.v1`, fetches a full PR snapshot with provider raw diff when available, compiles immutable review policy and plan snapshots, derives and stores raw-diff, line-anchor-index, and change-set artifacts, reserves monthly review credit quota before expensive review work, syncs the head workspace, optionally retains the checkout for static-analysis execution, persists static-analysis reports as review artifacts, includes static-analysis synthesis findings in candidate generation when a report exists, transitions `review_runs.status` through index wait, retrieval, review, validation, and publish handoff states, waits briefly for a fresh ready index, builds an indexed retrieval context bundle when available, calls the LLM-backed `@repo/review-engine` pass through a usage-recording gateway wrapper, persists candidate and policy-aware validated findings, stores review artifacts through the `@repo/artifacts` payload store boundary with DB-inline fallback descriptors plus optional filesystem or S3/R2-compatible payload storage, checks current PR state before publish handoff and marks moved/closed runs as superseded/skipped without enqueueing publisher work, records per-stage timeline events and failure-stage metadata, emits idempotent `review.run`, `review.credit`, and `llm.token` usage events, consumes quota after successful reviews, completes the review run, and enqueues `review.publish.v1`. Replay APIs and broader supersession policy remain. |
| #17 LLM gateway | Partial | `packages/llm-gateway`, `packages/review-orchestrator/src/index.ts`, `packages/db/src/schema/tables.ts` | Schema-validating structured-output gateway, deterministic static adapter, fixture-backed fake provider, normalized gateway error model, and bounded retry policy exist for review findings. Review orchestration now records successful model-call rows with provider/model, prompt/response hashes, token estimates, latency, rate-card metadata, and cost. Real provider adapters, prompt/version management, budget enforcement, and redacted LLM artifacts remain. |
| #18 Review passes | Partial | `packages/review-engine`, `packages/review-orchestrator/src/index.ts` | `@repo/review-engine` exports a typed `ReviewPass` boundary, deterministic boundary pass, LLM-backed review pass that consumes retrieval context, static-analysis synthesis pass that converts changed-line tool diagnostics into candidate findings, review pass modes, conservative review budgets, and deterministic pass selection for documentation-only, source, security-sensitive, strict, security-only, tests-only, dry-run, and off modes. Specialized summary, behavior, correctness, security, test coverage, and judging pass implementations remain. |
| #19 Finding validation, dedupe, and ranking | Complete | `packages/review-engine`, `packages/review-orchestrator/src/index.ts`, `packages/db`, `packages/review-engine/test/fixtures/validation` | Candidate findings now flow through runtime schema normalization, deterministic path/file/anchor validation, evidence/context-reference checks, policy-derived severity/category/confidence gates, secret-like and unsafe-fix rejection, basic repo-rule suppression, durable memory suppression, exact, location, conservative semantic, root-cause, and previous-comment duplicate suppression, budget limiting, and ranking before persistence. `@repo/review-engine` also exposes an inspectable validation result with accepted/rejected findings, duplicate groups, rejection stats, and product-safe validation trace events while preserving the existing `ValidatedFinding[]` path. Review orchestration now supplies retrieved context, active repository and organization memory facts, and prior published findings to validation; persists durable validation-event, duplicate-group, and publish-plan rows; persists rejected-findings plus validation ranking-report artifacts that include validation stats, duplicate groups, and trace events; and writes a publish-plan artifact whose IDs are handed to the publish job only when the plan contains external publish operations. JSON fixture goldens cover valid, invalid, duplicate, suppressed, budgeted, previous-comment, secret, unsafe-fix, weak-evidence, invalid-context, invalid-path, and summary-only validation cases. |
| #20 Publisher | Partial | `packages/publisher`, `packages/github`, `apps/worker/src/index.ts`, `apps/web/src/main.ts`, `packages/db/src/schema/tables.ts`, `packages/admin-tools/src/index.ts`, `packages/admin-tools/src/live-github-publisher-smoke.ts`, `packages/admin-tools/src/live-github-pr-review-smoke.ts`, `packages/admin-tools/src/live-github-provider-error-smoke.ts` | Completed review output enqueues `review.publish.v1`; the worker handles publish jobs; `@repo/publisher` protects against stale heads, respects immutable publishing-policy metadata for check-run, inline, summary, and budget decisions, creates or updates check runs, publishes inline comments, creates or updates deduped summary comments through stable PR-level markers, parses Heimdall hidden markers for provider-side dedupe, applies conservative inline, repository, installation, and PR-summary publish throttles, falls back to summary comments when inline publish fails, records durable publish state with dashboard-visible publish run, operation, and output rows, and includes dry-run-friendly planned publish operations and throttle metadata on `PublishPlan` and completed publish-run metadata. The worker now backs publish throttles with Redis sorted-set reservations, so repository, installation, and PR-summary write windows coordinate across worker processes that share Redis. Admin reconciliation can optionally read GitHub inline review comments and summary comments, parse Heimdall markers, and compare provider-visible artifacts with durable published rows. Guarded live GitHub App smoke runners cover happy-path publishing, webhook-to-publish, stale-head skip mode, and provider-error probes for read-only not-found plus opt-in invalid check-run validation; the publish and webhook smokes have published to a development PR. Publisher failures now persist structured GitHub/provider reasons with focused coverage for permission, not-found, validation, rate-limit, and generic failures. Remaining phase criteria include recorded live provider-error smoke evidence from a development GitHub App. |
| #21 Feedback and memory system | Partial | `packages/memory`, `packages/memory/test/memory.test.ts`, `packages/retrieval`, `packages/db/src/schema/tables.ts`, `packages/admin-tools/src/index.ts`, `apps/api/src/app.ts`, `apps/worker/src/index.ts`, `apps/web/src/main.ts`, `packages/webhook-ingestion` | Package now exposes typed feedback events, signals, outcome states, memory candidates/facts, hidden marker parsing, deterministic command parsing, outcome scoring, memory candidate activation, relevant memory lookup with trace/budgets, retrieval context integration, and an explainable in-memory suppression matcher. Durable `memory_facts` and `memory_candidates` tables now provide the persistence foundation for configured memory and candidate moderation, the memory/rules inspector surfaces applicable candidate rows next to stored memory facts with approve/reject actions for pending candidates, scoped API moderation endpoints can approve candidates into audited durable memory facts or reject them after `memory:write` authorization, recorded finding outcomes enqueue memory update jobs that let workers propose suppression candidates from rejected findings, the product repository view now lists applicable memory candidates/facts with approve/reject controls for users with `memory:write`, GitHub PR comment/reaction webhooks normalize redacted feedback metadata and trusted commands into memory update jobs, and memory workers correlate provider comment IDs back to published findings to record provider-webhook outcome signals and command-sourced memory candidates. Broader feedback-to-memory automation remains. |
| #22 Repo rules and configuration | Partial | `packages/rules`, `apps/api/src/app.ts`, `apps/web/src/main.ts`, `packages/webhook-ingestion/src/github/plan-jobs.ts`, `packages/review-orchestrator/src/index.ts`, `packages/review-engine/src/index.ts`, `packages/publisher/src/index.ts`, `packages/db/src/schema/tables.ts` | `@repo/rules` now compiles repository settings into immutable policy snapshots, validates policy schemas, classifies paths, evaluates PR trigger decisions, gates webhook-planned PR review work, applies finding policy decisions, evaluates memory policy permissions, maps review policies to publishing modes, stores policy snapshots as review artifacts, drives publisher mode enforcement, powers admin and product policy preview API/UI for draft settings, supports repository-scoped rules CRUD, and exposes scoped policy-test APIs for sample path/finding decisions. Repo-local config, org settings/rules management, and broader rule-condition coverage remain. |
| #23 Static analysis integration | Partial | `packages/static-analysis`, `packages/tool-runner`, `packages/review-engine`, `packages/review-orchestrator`, `apps/worker` | `@repo/static-analysis` now exposes typed tool descriptors, changed-file-fast planning, tool budgets, deterministic diagnostic normalization, diff-line mapping, ESLint JSON output parsing, report building through a runner boundary, and sandbox context propagation for review-owned tool runs. `@repo/tool-runner` provides the typed command-runner contract, deterministic fake runner, local shell-free process runner with timeout/output budgets, and a sandbox-backed adapter that translates commands into hardened sandbox run requests. `@repo/review-engine` can now synthesize candidate findings from changed-line static diagnostics, review orchestration can opt into static-analysis execution, artifact persistence, and static-tool candidate generation when a runner is configured, and the worker can select fake, local-process, Docker, or gVisor sandbox-backed static analysis with `STATIC_ANALYSIS_RUNNER`/`SANDBOX_RUNNER` while persisting sandbox run summaries, artifacts, and policy decisions. Broader live tool output parsers, raw output storage policy, and dashboard/debug API surfaces remain. |
| #24 Sandbox execution | Partial | `packages/sandbox`, `packages/tool-runner`, `packages/db`, `apps/worker`, `packages/contracts`, `packages/rules`, `packages/admin-tools`, `apps/web` | `@repo/sandbox` now defines the v1 run request/result contracts, trust levels, execution categories, workspace/command/image/environment/mount/network/limits/security/output/artifact policies, default hardened policy values, bounded output normalization/redaction helpers, baseline safety decisions, tool-specific policy evaluation for image allowlists, argv prefixes, network denial, resource maximums, writable paths, secret-looking env vars, unsafe path arguments, and dependency-install commands, Docker command-builder data for hardened no-network container execution, a deterministic fake runner for tests, an explicitly unsafe local-process runner for local development that rejects production construction while still enforcing schema/policy checks, and Docker/gVisor runners that materialize isolated output mounts, execute shell-free Docker argv through an injectable executor or the Docker CLI, enforce timeout/output mapping, collect declared artifacts into durable local file-URI roots, and clean transient run directories. `@repo/tool-runner` now includes `createSandboxToolRunner`, which builds shell-free sandbox requests with explicit env, hardened network/security/output defaults, read-only workspace mounts, writable tmp/output mounts, review/static-analysis metadata, and bounded result mapping back to the generic tool-runner contract. Repository settings now support optional persisted sandbox policy overrides, and `@repo/rules` compiles safe sandbox defaults plus repo-level overrides and MVP clamps into the immutable review policy snapshot. `@repo/db` now has generated migration coverage for `sandbox_runs`, `sandbox_artifacts`, `sandbox_policy_decisions`, and repository sandbox settings, and the worker persists sandbox request/result summaries into those tables when a DB-backed worker runtime creates the runner. Admin review inspection now surfaces persisted sandbox run summaries, artifact metadata, policy decision counts, output hashes, and sandbox failures without loading raw outputs. Admin and product dashboard settings now expose editable sandbox policy controls backed by the settings patch APIs. Staging smoke evidence and broader sandbox management controls remain. |
| #25 Observability | Partial | `packages/observability`, `apps/api/src/app.ts` | Structured admin control-plane telemetry exists for auth denial, login, logout, replay dispatch, settings mutations, memory/rules inspection, and billing checkout/portal session creation. `@repo/observability` now also exposes typed observability runtime configuration, redaction flags, OTLP/console/none exporter selection, trace sample rates, metrics interval parsing, service resource attributes, and validation errors. Broader OpenTelemetry bootstrap, metrics, tracing, pipeline instrumentation, and dashboards remain. |
| #26 Evaluation harness | Partial | `packages/evaluation`, `packages/evaluation/fixtures/smoke-full-pipeline-v1.json`, `pnpm eval:ci` | MVP deterministic suite runner, 12 curated cases, exact finding matching, anchor grading, retrieval recall, latency/cost metrics, Markdown/JSON reports, CI threshold gate, baseline metric deltas, case-level comparison rows, lost/new true positive detection, new/resolved false positive detection, and CI-safe comparison Markdown exist. Broader production import, live-model suites, human labeling, JUnit/HTML reports, historical storage, and dashboard views remain. |
| #27 Security and compliance layer | Partial | `packages/security`, `packages/db/src/schema/tables.ts` | `@repo/security` provides admin identity assertion verification, signed admin session cookies, CSRF helpers, product RBAC helpers, data classification helpers, artifact security metadata contracts, retention classes, default retention policy, artifact retention-class mapping, and retention decision calculation. Full redaction, support access workflows, deletion/export workflows, secrets abstraction, compliance evidence automation, and broader security event pipelines remain. |
| #28 Usage and billing | Partial | `packages/usage`, `packages/billing`, `packages/review-orchestrator/src/index.ts`, `packages/db/src/schema/tables.ts`, `packages/contracts/src/usage/usage-event.ts`, `packages/contracts/src/usage/entitlements.ts`, `packages/contracts/src/usage/quota.ts`, `apps/api/src/app.ts`, `apps/web/src/main.ts` | Usage event schema exists, and `@repo/usage` now provides a typed append-only ledger boundary with deterministic idempotency keys, an in-memory store, a Postgres store, rollup summarization, correction-event support, customer-safe billing-period summaries for usage, review-credit allowances, meter rows, invoices, and opt-in internal cost fields, quota decision helpers, monthly quota counters/reservations, versioned LLM token rate-card cost estimation, seeded plan catalog compilation, provider-free plan snapshots, entitlement decisions, local billing account summaries with subscription, subscription item, credit grant, and invoice mirrors, usage-based billing meter planning/sending with retry state, and billing reconciliation repair for provider subscription mirrors, monthly review-credit quota counters, and pending meter sends. `@repo/billing` defines the provider-neutral billing adapter, a fake provider for local checkout/portal/webhook/meter tests, and a Stripe adapter for customer, Checkout Session, Customer Portal Session, subscription-read, meter-event, webhook-parse, and provider request logging boundaries. The API records inbound Stripe webhook events and idempotently syncs subscription, invoice, and payment-status mirrors. Review orchestration records completed PR reviews as idempotent `review.run` and `review.credit` usage events, consumes reserved monthly review credits after successful reviews, and records successful review-model calls as idempotent `llm.token` usage events. The admin API/dashboard expose scoped usage rollups, plan/entitlement inspection, billing account inspection, quota warnings, invoice and portal support links, billing meter event debug rows, billing reconciliation issues for meter lag/failures, failed webhooks, failed provider requests, quota counter drift, and usage-cost anomalies, and an operator action that enqueues a durable billing reconciliation job. Customer self-serve billing views, automated metered sync scheduling, and invoice reconciliation jobs remain. |
| #29 Admin and internal tooling | Partial | `packages/admin-tools`, `apps/api/src/app.ts`, `apps/web/src/main.ts`, `packages/db/src/schema/tables.ts`, `scripts/control-plane-production-readiness.ts`, `docs/runbooks/admin-control-plane.md`, `docs/evidence/admin-control-plane-staging-proof.json` | Publisher dry-run, reconciliation reports, admin-debug inspectors for webhook/job/review/publisher state, repository-scoped memory/rules inspection, review-run usage/cost inspection for usage ledger rows, billable units, quota reservations, and fixed USD cost summaries, structured failure normalization, replay plans, confirmed durable replay dispatch with completed admin action and replay run rows, audited failed-job requeue through the job inspector, non-mutating retrieval and validation replay dry-runs through the admin-tools package, CLI, admin API, and dashboard, audited redacted review debug bundle export with durable admin action/debug export rows, audited eval import draft creation with completed admin action rows, local admin CLI inspect/replay/export/dry-run/usage commands, named support/admin access, replay audit logging, operator dashboard views, Railway staging proof, production readiness runbook, and production-readiness gate exist. Broader production admin workflows remain. |
| #30 Deployment and infrastructure | Partial | `compose.yaml`, `infra/`, `scripts/validate-production-deployment.ts`, `.github/workflows/ci.yml` | Local Postgres, Redis, and MinIO object storage exist, and the initial Railway production deployment manifest, Railway config-as-code files, object-storage review artifact environment requirements for API/worker services, production review artifact privacy/encryption policy, worker runtime environment audit coverage, and deployment audit gate are codified and wired into CI. Provider-managed rollout execution remains. |
| #31 Testing and evaluation strategy | Partial | `pnpm check`, `pnpm eval:ci`, `pnpm ci:control-plane:release`, `.github/workflows/ci.yml`, package tests | Unit tests, Postgres-backed migration/review integration tests in CI, release gates, the deterministic evaluation gate, and CI upload of the deterministic eval Markdown/JSON report now run for new work. Broader cross-tenant/redaction integration coverage and production eval history remain. |

## Current Completion Notes

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
  `artifact_access_events`, raw reads/downloads require an admin support session or elevated admin
  permission, `/api/v1/review-runs/:reviewRunId/artifacts/:artifactId/download-url` creates
  short-lived raw object-storage URLs only after the same raw access gates, and the product review
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
  current failed stage when a run fails mid-flow. It now also performs a provider current-head
  check before publish handoff, records the staleness result, releases reserved quota for stale
  terminal outcomes, and marks moved or closed PRs as superseded or skipped before publisher jobs
  are enqueued.
- Latest LLM gateway resilience milestone: `@repo/llm-gateway` now normalizes provider and schema
  failures into `LLMGatewayError`, retries configured transient provider failures with a bounded
  retry policy, and exposes a fixture-backed `FakeLLMProvider` that can simulate failures for
  deterministic tests.
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
- Latest index importer URI milestone: `@repo/index-importer` now exposes filesystem/file-URI and
  S3/R2-compatible whole-artifact resolvers, a `createIndexArtifactResolverFromEnvironment`
  runtime factory, a `readIndexArtifactFromUri` helper, and `importIndexArtifactFromUri` for
  loading whole-artifact JSON by URI before normal validation and import. The worker now exercises
  this URI-first path for locally persisted index artifacts.
- Latest embedding input milestone: `@repo/embedding` now builds `code_chunk` provider inputs with
  path/language/symbol/range metadata, computes SHA-256 input hashes, estimates tokens
  conservatively, truncates oversized chunk bodies while preserving the header and tail, and splits
  provider calls by input count, token budget, and character budget. The worker now creates its
  embedding provider through `createEmbeddingProviderFromEnvironment`, keeping the local hash/fake
  provider as the default while honoring configured model and dimensions.
- Latest retrieval hardening milestone: `@repo/retrieval` now validates every returned
  `ContextBundle` through the shared TypeBox schema and keeps required diff/same-file context when
  optional graph, test, or semantic retrievers fail, recording product-safe warnings in bundle
  metadata instead of failing the full retrieval.
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
  GitHub's installation callback back to onboarding with sanitized query state.
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
  admin route rate limits that return `429` with `Retry-After` and telemetry. Support-session
  references can now be propagated with `x-heimdall-support-session-id` into debug/eval audit actor
  metadata, and raw eval import drafts require either that support-session reference or elevated
  admin permissions before draft creation. Eval import draft mutations also require a non-empty
  operator reason, with denied attempts recorded through admin access-denied telemetry before draft
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
  rollback checks, and alert coverage. `pnpm audit:control-plane:deployment` validates that
  manifest against the root scripts, and the API emits structured admin control-plane telemetry to
  the configured observability sink.
- Latest production artifact deployment milestone: the Railway production manifest and deployment
  audit now require S3/R2-compatible review artifact object-storage variables on both the API and
  worker services, and the audit separately validates the worker GitHub/runtime secrets needed to
  write immutable review artifacts during orchestration. The manifest also declares, and the audit
  validates, that production review artifact storage uses a private S3-compatible bucket with
  public access blocked, provider-managed encryption, and support-session-gated raw downloads.
- Latest local infrastructure milestone: `compose.yaml` now runs MinIO object storage beside
  Postgres and Redis, bootstraps a `heimdall-review-artifacts` bucket for local review artifact
  payloads, and `infra/README.md` documents the API/worker environment variables for that local
  object-storage endpoint.
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
  foreign review-run scope check fails.
- Latest release-control milestone: `.github/ISSUE_TEMPLATE/admin-control-plane-production-release.md`
  and `docs/releases/admin-control-plane-production-release.md` define the controlled production
  release ticket, and `infra/railway/*.railway.json` codifies Railway build/deploy settings for
  the API, dashboard, admin gateway, and worker services.
- Latest deployment-streamlining milestone: `pnpm release:control-plane:railway` wraps the local
  release gates and deployed Railway proof gates in one operator command, with `--local-only`
  available before fresh deployed OAuth/CDP inputs are ready.
- Latest evaluation milestone: `packages/evaluation` now implements the first deterministic
  `26A` gate with `smoke-full-pipeline-v1`, 12 curated no-live-model cases, exact finding matching,
  line-anchor grading, retrieval recall, latency/cost metrics, Markdown/JSON reports, and
  `pnpm eval:ci` wired into `pnpm check`.
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
  to `published_findings.provider_comment_id` and writes idempotent `provider_webhook` outcome rows
  for comments and positive/negative reactions without storing raw comment text. Trusted comment
  commands are now parsed through the memory command parser, carried as command hashes plus
  structured command fields, and converted into pending command-sourced memory candidates after
  provider-comment correlation.
- Latest repo rules/configuration milestone: Phase #22 now compiles an explicit memory policy into
  immutable review policy snapshots. `@repo/rules` exposes default memory context/suppression
  limits, trusted feedback roles, approval requirements, and `evaluateMemoryPolicy` decisions for
  memory context, durable fact creation, exact suppression, path/category suppression, and natural
  language memory instructions. The API now also exposes scoped admin and product policy-test
  endpoints that compile the current draft policy, classify a sample path, and return the sample
  finding decision trace for local rule debugging.
- Latest static-analysis milestone: Phase #23 now has an MVP deterministic signal boundary.
  `@repo/static-analysis` plans bounded changed-file tool runs, filters tools by language,
  category, request, and budgets, normalizes diagnostics with stable fingerprints and changed-line
  metadata, parses ESLint JSON formatter output into product-safe diagnostics/warnings, and builds
  summary reports from a runner. `@repo/tool-runner` defines the command runner contract, a
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
  execution. The worker can now select `STATIC_ANALYSIS_RUNNER=fake` or
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
  local file-URI roots, and clean transient output directories. Worker runtime selection now accepts
  `SANDBOX_RUNNER=docker` and `SANDBOX_RUNNER=gvisor` with optional Docker executable, runtime,
  temp-root, and artifact-root environment overrides.
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
  OpenTelemetry-style resource attributes without customer identifiers.
- Latest evaluation milestone: Phase #26 baseline comparison now includes case-level comparison
  rows and CI-safe Markdown. `@repo/evaluation` reports baseline and candidate metrics, metric
  deltas, improved and regressed case IDs, lost and newly found expected findings, new false
  positives, and resolved false positives so eval reports can explain regressions instead of only
  failing a threshold gate.
- Latest security/compliance milestone: Phase #27 now has data classification and retention
  helpers in `@repo/security`. Artifact producers can classify public, internal, customer
  confidential, customer code, secret, and regulated personal data; attach artifact security
  metadata; map artifact types to retention classes; and compute storage/expiration decisions from
  the default or organization-specific retention policy, including disabled prompt artifact
  storage and while-enabled index retention.
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
