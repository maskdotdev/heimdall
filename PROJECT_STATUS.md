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
| #2 Database layer | Partial | `packages/db`, `drizzle.config.ts`, `packages/db/migrations/0000_foundation.sql`, `b9b4635` | Drizzle schema, generated migration, bootstrap extensions, client, and repository helpers exist. More repository methods and live DB verification remain. |
| #3 GitHub App integration | Partial | `packages/github`, `408f7bd` | Provider surface, installation token caching, repo discovery, PR snapshot fetching, clone auth, publishing primitives, inline review dedupe, summary-comment dedupe, check-run create/update, fake provider coverage, and typed error mapping exist. Remaining phase criteria: rate-limit observation and manual dev-app runbook. |
| #4 Webhook ingestion | Done | `packages/webhook-ingestion`, `apps/api/src/app.ts`, `b9b4635` | Handles GitHub installation, repository, and pull request webhooks with signature verification, persistence, idempotency, and job planning. |
| #5 API server | Partial | `apps/api`, `b9b4635` | Health check, GitHub webhook route, and bearer-guarded internal admin-debug routes for webhook/review/publisher inspection, replay planning, and confirmed durable replay dispatch exist. Control-plane auth, settings, history, rules, and usage APIs remain. |
| #6 Web dashboard | Partial | `apps/web/src/main.ts`, `apps/web/src/styles.css` | Operator dashboard views exist for admin-debug webhook, review, and publisher inspection plus guarded replay controls. Broader product dashboard flows remain. |
| #7 Job queue and orchestration | Partial | `packages/queue`, `apps/worker`, `packages/db/src/schema/tables.ts` | Current async backbone scope exists: pending durable rows, outbox dispatch to BullMQ, worker lifecycle updates, retry/idempotency coverage, and worker handler registration, including indexing, embedding, review, and publishing jobs. Broader reconciliation and operational controls remain. |
| #8 Repo sync and workspace manager | Partial | `packages/repo-sync`, `apps/worker/src/index.ts` | Repo sync can obtain GitHub clone auth, create an exact-commit workspace, verify `HEAD`, hand the workspace to the TypeScript indexer, and clean up temporary workspaces. Broader workspace caching remains. |
| #9 Indexer boundary | Partial | `packages/indexer-driver`, `apps/worker/src/index.ts` | Typed indexer driver boundary exists and the worker consumes artifacts through the boundary. Alternate CLI/remote driver adapters and artifact URI handoff hardening remain. |
| #10 Index artifact schema | Partial | `packages/index-schema`, `packages/indexer-driver`, `packages/index-importer` | Artifact records are validated and consumed by the driver/importer path. Confirm full schema coverage and compatibility fixtures before marking done. |
| #11 TypeScript indexer | Partial | `packages/indexer-ts`, `packages/indexer-ts/test` | TypeScript indexer emits files, symbols, edges, chunks, manifest hashes, and deterministic fixtures. Broader language coverage, incremental behavior, and generated/vendor heuristics remain. |
| #12 Index importer | Partial | `packages/index-importer` | Importer persists index versions, files, symbols, edges, chunks, and durable embedding jobs idempotently. Bulk/COPY paths, richer import batch state, and artifact storage abstraction remain. |
| #13 Embedding pipeline | Partial | `packages/embedding`, `apps/worker/src/index.ts`, `packages/embedding/test` | Durable embedding jobs are handled by the worker, deterministic 1536-d embeddings are stored in pgvector, vector dimensions are validated, and progress is cumulative. Real provider adapter, usage/cost records, cache reuse, and telemetry remain. |
| #14 Retrieval engine | Partial | `packages/retrieval`, `packages/review-orchestrator/src/index.ts`, `packages/retrieval/test/retrieval.test.ts` | Retrieval now uses imported index rows for same-file, symbol, graph, related-test, lexical, and vector-backed context with diff fallback. Runtime bundle validation, full-text search, repo rules, traces, and dashboard inspection remain. |
| #15 PR snapshot and diff model | Partial | `packages/webhook-ingestion/src/github/payload.ts`, `packages/github`, `packages/db/src/repositories/pull-request-repository.ts`, `408f7bd` | Webhook payload normalization creates shallow snapshots, the GitHub provider can fetch full changed-file snapshots plus raw diff hashes, and review orchestration refreshes persisted snapshots for a fetched head SHA. Provider-neutral diff parsing, anchors, and golden tests remain. |
| #16 Review orchestrator | Partial | `packages/review-orchestrator`, `apps/worker/src/index.ts` | Worker handles `pr.review.v1`, fetches a full PR snapshot, syncs the head workspace, waits briefly for a fresh ready index, builds an indexed retrieval context bundle when available, calls the LLM-backed `@repo/review-engine` pass, persists candidate and validated findings, records artifacts and stage events, completes the review run, and enqueues `review.publish.v1`. Replay APIs and broader supersession policy remain. |
| #17 LLM gateway | Partial | `packages/llm-gateway` | Schema-validating structured-output gateway and deterministic static adapter exist for review findings. Real provider adapters, call persistence, cost tracking, retries, and prompt/version management remain. |
| #18 Review passes | Partial | `packages/review-engine`, `packages/review-orchestrator/src/index.ts` | `@repo/review-engine` exports a typed `ReviewPass` boundary, deterministic boundary pass, and LLM-backed review pass that consumes retrieval context. More specialized retrieval/tool/static-analysis passes remain. |
| #19 Finding validation, dedupe, and ranking | Partial | `packages/review-engine`, `packages/review-orchestrator/src/index.ts`, `packages/db` | Candidate findings now flow through deterministic anchor validation, severity/category gates, basic repo-rule suppression, duplicate suppression, budget limiting, and ranking before persistence. Semantic dedupe, memory suppression, repo settings integration, and validation event traces remain. |
| #20 Publisher | Partial | `packages/publisher`, `apps/worker/src/index.ts`, `packages/db/src/schema/tables.ts`, `packages/admin-tools/src/live-github-publisher-smoke.ts`, `packages/admin-tools/src/live-github-pr-review-smoke.ts` | Completed review output enqueues `review.publish.v1`; the worker handles publish jobs; `@repo/publisher` protects against stale heads, creates or updates check runs, publishes inline comments, falls back to deduped summary comments, and records durable publish state. Guarded live GitHub App smoke runners exist and have published to a development PR. Publisher failures now persist structured error details. Remaining phase criteria include dashboard visibility and broader failure-mode coverage. |
| #21 Feedback and memory system | Not started | `packages/memory` | Package exists, but memory implementation has not started. |
| #22 Repo rules and configuration | Partial | `packages/db/src/schema/tables.ts` | DB tables exist. Rule evaluation and API/dashboard flows remain. |
| #23 Static analysis integration | Deferred | `phases/23-static-analysis-integration-implementation-spec.md` | Deferred until core review flow exists. |
| #24 Sandbox execution | Deferred | `phases/24-sandbox-execution-implementation-spec.md` | Deferred until review/tool execution needs it. |
| #25 Observability | Partial | `packages/observability`, `apps/api/src/app.ts` | Structured admin control-plane telemetry exists for auth denial, login, logout, replay dispatch, and settings mutations. Broader metrics, tracing, and dashboards remain. |
| #26 Evaluation harness | Not started | `packages/evaluation` | Package exists, but harness implementation has not started. |
| #27 Security and compliance layer | Partial | `packages/security`, `packages/db/src/schema/tables.ts` | Package and audit schema support exist. Full security/compliance workflows remain. |
| #28 Usage and billing | Partial | `packages/db/src/schema/tables.ts` | Usage event schema exists. Billing and usage ledger implementation remain. |
| #29 Admin and internal tooling | Partial | `packages/admin-tools`, `apps/api/src/app.ts`, `apps/web/src/main.ts`, `scripts/control-plane-production-readiness.ts`, `docs/runbooks/admin-control-plane.md`, `docs/evidence/admin-control-plane-staging-proof.json` | Publisher dry-run, reconciliation reports, admin-debug inspectors for webhook/review/publisher state, structured failure normalization, replay plans, confirmed durable replay dispatch, named support/admin access, replay audit logging, operator dashboard views, Railway staging proof, production readiness runbook, and production-readiness gate exist. Broader production admin workflows remain. |
| #30 Deployment and infrastructure | Partial | `compose.yaml`, `infra/`, `scripts/validate-production-deployment.ts`, `.github/workflows/ci.yml` | Local infra exists, and the initial Railway production deployment manifest, Railway config-as-code files, and deployment audit gate are codified and wired into CI. Provider-managed rollout execution remains. |
| #31 Testing and evaluation strategy | Partial | `pnpm check`, `pnpm ci:control-plane:release`, package tests | Unit tests, optional integration tests, and CI release gates exist for new work. Evaluation harness coverage remains. |

## Current Completion Notes

- Latest completed milestone: guarded live PR review smoke verified webhook-to-publish completion
  against development PR `maskdotdev/heimdall#2`.
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
- Latest deployment and observability milestone: `infra/production/railway-admin-control-plane.json`
  now codifies the Railway production services, required environment variable names, release gates,
  rollback checks, and alert coverage. `pnpm audit:control-plane:deployment` validates that
  manifest against the root scripts, and the API emits structured admin control-plane telemetry to
  the configured observability sink.
- Latest CI milestone: `.github/workflows/ci.yml` runs `pnpm ci:control-plane:release` on pull
  requests and pushes to `main`, covering the production deployment audit, production-readiness
  gate, typecheck, lint, tests, workspace boundary checks, and build.
- Latest release-control milestone: `.github/ISSUE_TEMPLATE/admin-control-plane-production-release.md`
  and `docs/releases/admin-control-plane-production-release.md` define the controlled production
  release ticket, and `infra/railway/*.railway.json` codifies Railway build/deploy settings for
  the API, dashboard, admin gateway, and worker services.
- Latest deployment-streamlining milestone: `pnpm release:control-plane:railway` wraps the local
  release gates and deployed Railway proof gates in one operator command, with `--local-only`
  available before fresh deployed OAuth/CDP inputs are ready.
- Latest verification: `pnpm smoke:review:github` completed with webhook event
  `webhook_zcXI0Oj5qVyrmzFMO2ufYUqHVh`, review run
  `rrn_YjVZfH70cGNJCMEQgKalTf7WIb`, index job `job_ae39170509eb4097ba1aed094fabc031`,
  review job `job_377e5f0745174069a6321293f9a9a15b`, publish job
  `job_YJTOV7tFDcWYwVONgniCMsiz_H`, publish run `pub_YfHdVTUtRQd5vBILPuOvebn0_A`,
  check run `74535779228`, review `4232636849`, and comment `4384492583`.
- The latest live PR review smoke completed with indexed retrieval through index version
  `idx_4yuBX7BUkvP2mSkbb0OsjWisDz`.
- Optional live integration tests require `HEIMDALL_DB_TEST_URL` and `HEIMDALL_REDIS_TEST_URL`.
  The live publisher smoke command also requires development GitHub App credentials and
  `HEIMDALL_GITHUB_SMOKE_ALLOW_WRITE=true`.
- Drizzle schema files are the source of truth for DB structure. Do not manually edit generated migration SQL.

## Recommended Next Goal

Execute the controlled Railway production release, then add post-release production monitoring
dashboards and issue-level follow-up tracking for remaining product phases.
