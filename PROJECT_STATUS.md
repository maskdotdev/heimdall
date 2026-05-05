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
| #1 Monorepo and build system | Partial | `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `b9b4635` | Workspace, TypeScript, Biome, Vitest, Turbo, and boundary checks are active. CI status still needs confirmation. |
| #2 Database layer | Partial | `packages/db`, `drizzle.config.ts`, `packages/db/migrations/0000_foundation.sql`, `b9b4635` | Drizzle schema, generated migration, bootstrap extensions, client, and repository helpers exist. More repository methods and live DB verification remain. |
| #3 GitHub App integration | Partial | `packages/github`, `b9b4635` | Webhook header parsing and signature verification exist. Installation tokens, repo discovery, PR snapshot fetching, and publishing primitives remain. |
| #4 Webhook ingestion | Done | `packages/webhook-ingestion`, `apps/api/src/app.ts`, `b9b4635` | Handles GitHub installation, repository, and pull request webhooks with signature verification, persistence, idempotency, and job planning. |
| #5 API server | Partial | `apps/api`, `b9b4635` | Health check and GitHub webhook route exist. Control-plane auth, settings, history, rules, usage, and debug APIs remain. |
| #6 Web dashboard | Not started | `apps/web` | Dashboard implementation has not started. |
| #7 Job queue and orchestration | Partial | `packages/queue`, `packages/db/src/schema/tables.ts`, `b9b4635` | Queue producers and durable job rows exist. Worker registration, outbox dispatcher, lifecycle transitions, retries, and reconciliation remain. |
| #8 Repo sync and workspace manager | Not started | `packages/repo-sync` | Package exists, but repo sync implementation has not started. |
| #9 Indexer boundary | Not started | `packages/indexer-driver` | Package exists, but boundary implementation has not started. |
| #10 Index artifact schema | Partial | `packages/index-schema` | Package exists and is referenced by contracts. Confirm against phase definition of done before marking done. |
| #11 TypeScript indexer | Not started | `packages/indexer-ts` | Package exists, but indexer implementation has not started. |
| #12 Index importer | Not started | `packages/index-importer` | Package exists, but importer implementation has not started. |
| #13 Embedding pipeline | Not started | `packages/embedding` | Package exists, but embedding implementation has not started. |
| #14 Retrieval engine | Not started | `packages/retrieval` | Package exists, but retrieval implementation has not started. |
| #15 PR snapshot and diff model | Partial | `packages/webhook-ingestion/src/github/payload.ts`, `b9b4635` | Webhook payload normalization creates shallow snapshots. Full GitHub diff fetching remains. |
| #16 Review orchestrator | Not started | `packages/review-orchestrator` | Package exists, but orchestrator implementation has not started. |
| #17 LLM gateway | Not started | `packages/llm-gateway` | Package exists, but gateway implementation has not started. |
| #18 Review passes | Not started | `packages/review-engine` | Package exists, but review pass implementation has not started. |
| #19 Finding validation, dedupe, and ranking | Not started | `packages/review-engine`, `packages/db` | Schema support exists, but validation and ranking implementation has not started. |
| #20 Publisher | Not started | `packages/publisher` | Package exists, but publisher implementation has not started. |
| #21 Feedback and memory system | Not started | `packages/memory` | Package exists, but memory implementation has not started. |
| #22 Repo rules and configuration | Partial | `packages/db/src/schema/tables.ts` | DB tables exist. Rule evaluation and API/dashboard flows remain. |
| #23 Static analysis integration | Deferred | `phases/23-static-analysis-integration-implementation-spec.md` | Deferred until core review flow exists. |
| #24 Sandbox execution | Deferred | `phases/24-sandbox-execution-implementation-spec.md` | Deferred until review/tool execution needs it. |
| #25 Observability | Partial | `packages/observability` | Package exists. Structured telemetry, metrics, tracing, and dashboards remain. |
| #26 Evaluation harness | Not started | `packages/evaluation` | Package exists, but harness implementation has not started. |
| #27 Security and compliance layer | Partial | `packages/security`, `packages/db/src/schema/tables.ts` | Package and audit schema support exist. Full security/compliance workflows remain. |
| #28 Usage and billing | Partial | `packages/db/src/schema/tables.ts` | Usage event schema exists. Billing and usage ledger implementation remain. |
| #29 Admin and internal tooling | Not started | `packages/admin-tools` | Package exists, but admin tooling implementation has not started. |
| #30 Deployment and infrastructure | Partial | `compose.yaml`, `infra/` | Local infra exists. Production deployment is not implemented. |
| #31 Testing and evaluation strategy | Partial | `pnpm check`, package tests | Unit tests and optional integration tests exist for new work. Cross-system release gates remain. |

## Current Completion Notes

- Latest completed milestone: `#4 Webhook ingestion`, commit `b9b4635`.
- Latest verification: `pnpm check` passed after `b9b4635`.
- Optional live integration tests require `HEIMDALL_DB_TEST_URL` and `HEIMDALL_REDIS_TEST_URL`.
- Drizzle schema files are the source of truth for DB structure. Do not manually edit generated migration SQL.

## Recommended Next Goal

Build the async execution backbone: GitHub App integration, durable job orchestration,
outbox dispatching, worker registration, and the first runnable repo sync worker.
