# Heimdall

Greptile-like code review system built as a strict TypeScript monorepo.

## Requirements

- Node.js 22+
- pnpm 10+
- Bun 1.2+
- Docker

## Setup

```bash
corepack enable
corepack use pnpm@10.33.3
pnpm install
cp .env.example .env
pnpm infra:up
pnpm check
pnpm dev
```

If your Node distribution does not include Corepack, use
`npm exec --yes -- pnpm@10.33.3 install` for the first install.

## Review LLM Provider

Real review-model calls are disabled unless the worker is configured with an explicit provider.
For an OpenAI-compatible Chat Completions provider, set `LLM_PROVIDER=openai`, `OPENAI_MODEL` or
`LLM_MODEL`, and either `LLM_PROVIDER_API_KEY_SECRET_REF`, `OPENAI_API_KEY_SECRET_REF`, or a local
`OPENAI_API_KEY` development fallback. Set `HEIMDALL_REVIEW_SMOKE_FINDING=true` only for the
guarded live PR review smoke, which uses the deterministic smoke gateway instead of a real model.

## Repository Structure

```text
apps/api
apps/web
apps/worker
apps/indexer-cli
packages/contracts
packages/config
packages/db
packages/github
packages/queue
packages/repo-sync
packages/index-schema
packages/indexer-driver
packages/indexer-ts
packages/index-importer
packages/embedding
packages/retrieval
packages/review-orchestrator
packages/review-engine
packages/llm-gateway
packages/publisher
packages/artifacts
packages/billing
packages/evaluation
packages/memory
packages/rules
packages/usage
packages/observability
packages/security
packages/admin-tools
```

## Common Commands

```bash
pnpm dev
pnpm check
pnpm ci:control-plane:release
pnpm release:control-plane:railway -- --local-only
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm eval run --suite smoke-full-pipeline-v1 --variant local --no-live-models
pnpm infra:up
pnpm infra:down
```

## Evaluation Gate

Run the deterministic MVP evaluation suite before changing indexing, retrieval, review prompts,
validation, or ranking:

```bash
pnpm eval run --suite smoke-full-pipeline-v1 --variant local --no-live-models
```

The command writes CI-safe Markdown and JSON reports under `.heimdall/eval-runs/`. The report omits
raw code and retrieved context text. `pnpm check` runs the same suite in CI mode and fails if recall,
precision, false-positive, anchor, retrieval, latency, or cost thresholds regress.

## Rules and Policy Snapshots

Repository review settings compile through `@repo/rules` into immutable policy snapshots. The
rules package validates policy objects with TypeBox, classifies repository paths, evaluates PR
trigger decisions, applies finding thresholds and suppressions, and maps review policy modes to
publishing decisions. Webhook ingestion uses the trigger decision before it persists PR index and
review jobs. Review orchestration stores a `policy_snapshot` artifact for each run and passes the
compiled policy to finding validation. The publisher reads the stored publishing policy for new
review runs and routes check runs, inline comments, configured summaries, fallback summaries, and
comment budgets from that immutable snapshot. The admin settings API and dashboard can compile an
effective policy preview for the current draft settings before saving. Operators can also create,
edit, disable, and delete repository-scoped rules from the same settings screen. Stored active
rules feed both preview compilation and review-run policy snapshots.

## Usage Ledger

`@repo/usage` owns the append-only internal usage ledger boundary. It creates validated usage
events with deterministic idempotency keys, supports correction events, provides in-memory and
Postgres-backed stores, summarizes rollups, evaluates basic quota decisions, and estimates LLM
token cost from versioned rate cards. It also compiles seeded free, team, business, and internal
plans plus active entitlement overrides into stable provider-free plan snapshots, and it reserves,
consumes, or releases monthly review credit quota for expensive review starts. It keeps local
billing account, subscription, credit grant, and invoice mirrors as product truth before Stripe is
required. It plans, persists, retries, and sends usage-based meter events for billable review
credits from ledger rollups. `@repo/billing` defines the provider-neutral billing adapter, a fake
provider for local tests, and a Stripe adapter for customer creation, subscription Checkout
Sessions, Customer Portal Sessions, subscription reads, meter events, Stripe webhook parsing, and
outbound provider request logging. The API records Stripe webhook deliveries and idempotently syncs
subscription, invoice, and payment-status mirrors. Completed PR reviews now emit idempotent
`review.run` and `review.credit` usage events from review orchestration, and each review-model call
persists an `llm_calls` row plus an idempotent `llm.token` usage event with input tokens, output
tokens, model, provider, rate-card, and cost metadata. The admin API exposes scoped usage rollups,
plan snapshots, entitlement decisions, billing account summaries, billing meter event debug rows,
billing reconciliation issues, and billing checkout/portal session creation. The operator dashboard
includes usage, plan, and billing views for review counts, LLM tokens, internal cost, current
limits, quota warnings, subscription mirrors, portal links, credit grants, invoices, provider
meter-event sync state, and billing drift alerts for failed webhooks, failed provider requests,
meter lag, quota counter drift, and usage-cost anomalies. Billing managers can enqueue a durable
reconciliation repair job that refreshes provider subscription mirrors, repairs review-credit quota
counters from the immutable usage ledger, and retries pending or failed meter events.

## Product GitHub App Flow

The normal product path is separate from the admin control plane. A user installs the Heimdall
GitHub App, GitHub sends installation and pull request webhooks to the API, the worker reviews the
pull request, and the product dashboard shows setup, installations, repositories, and recent review
activity.

Configure the same GitHub App values locally and in production:

```bash
GITHUB_APP_ID="<app id>"
GITHUB_PRIVATE_KEY="<pem private key>"
GITHUB_WEBHOOK_SECRET="<webhook secret>"
HEIMDALL_GITHUB_APP_SLUG="heimdall-dev"
HEIMDALL_API_PUBLIC_URL="https://api.example.com"
HEIMDALL_APP_ALLOWED_ORIGINS="https://app.example.com"
VITE_HEIMDALL_API_BASE_URL="https://api.example.com"
```

`HEIMDALL_GITHUB_APP_INSTALL_URL` can replace `HEIMDALL_GITHUB_APP_SLUG` when you need a custom
installation URL. The dashboard reads `/app/onboarding` without an admin session and uses the
configured install URL as the primary call to action.

Use `docs/runbooks/github-dev-app.md` to create a development GitHub App and run the guarded live
publisher and webhook-to-publish smoke checks against a disposable test repository.

## Admin Control Plane

Admin routes are disabled by default and fail closed unless identity, session, CORS, and exposure
settings are configured. The API accepts signed identity assertions from an upstream OIDC, SAML, or
GitHub organization gateway, then mints secure cookie sessions with CSRF tokens.

```bash
HEIMDALL_ADMIN_ENABLED=true
HEIMDALL_ADMIN_ROUTE_EXPOSURE=internal
HEIMDALL_ADMIN_IDENTITY_PROVIDER=oidc
HEIMDALL_ADMIN_IDENTITY_ASSERTION_SECRET="<32+ character assertion secret>"
HEIMDALL_ADMIN_SESSION_SECRET="<32+ character session secret>"
HEIMDALL_ADMIN_ALLOWED_ORIGINS="https://admin.example.com"
```

The first trusted gateway implementation lives in `@app/admin-gateway`. It uses GitHub OAuth,
requires active membership in `HEIMDALL_ADMIN_GITHUB_ORG`, restricts admitted logins unless
`HEIMDALL_ADMIN_GATEWAY_ALLOW_ALL_ORG_MEMBERS=true`, maps configured `admin.*` permissions and
org/repo scopes, and returns signed Heimdall assertion headers from `/heimdall/assertion`.

Control-plane permissions are granular: `admin.inspect`, `admin.replay.plan`,
`admin.replay.execute`, `admin.settings.manage`, and `admin.audit.view`. Actors are scoped by
organization and repository IDs from the identity assertion.

The dashboard supports replay inspection, redacted review debug bundle export, eval import draft
creation, memory and rules inspection, repository review settings, repository enablement, and
searchable audit history. Replay execution, debug bundle exports, eval import drafts, and settings
changes write `audit_logs` rows with actor identity, request IDs, session IDs, and before/after
mutation data where applicable.

Run the web dashboard with `pnpm dev:web`. In development, configure `VITE_HEIMDALL_API_BASE_URL`
and `VITE_HEIMDALL_ADMIN_GATEWAY_BASE_URL`, or proxy `/admin` routes to `http://localhost:3000`
and gateway routes to the admin gateway. The dashboard login flow starts GitHub OAuth through the
gateway, requests a signed assertion from `/heimdall/assertion`, posts it to `/admin/auth/login`,
then refreshes `/admin/session` and loads the overview. See
`docs/runbooks/admin-control-plane.md` for release gates and emergency operations.

Live control-plane smoke gates require a deployed identity gateway that returns signed admin
assertions. Use `HEIMDALL_ADMIN_SMOKE_ASSERTION_URL` for staging proof; the smoke gates do not mint
assertions from `HEIMDALL_ADMIN_IDENTITY_ASSERTION_SECRET`. For the GitHub gateway, authenticate in
the browser first, then pass the gateway session cookie through `HEIMDALL_ADMIN_SMOKE_GATEWAY_COOKIE`.
Run `pnpm preflight:control-plane:staging` before the smoke and dashboard proof commands to validate
deployed URLs, CORS, the dashboard API bundle configuration, write acknowledgements, and gateway/API
auth configuration.
Run `pnpm proof:control-plane:staging` with `HEIMDALL_CONTROL_PLANE_MANUAL_DRILL_EVIDENCE` and
`HEIMDALL_CONTROL_PLANE_ROLLBACK_NOTES` set to execute the full proof sequence and write a JSON
evidence record with top-level actor, scope, gateway, and audit summaries.

For the Railway rollout path, use one wrapper command after `.env.smoke.local` contains the deployed
API, dashboard, gateway, OAuth, CDP, replay, and proof values:

```bash
pnpm release:control-plane:railway
```

Before deployed OAuth/CDP inputs are ready, run the same sequence in local-only mode:

```bash
pnpm release:control-plane:railway -- --local-only
```

For local development, run the localhost-only dev gateway when you do not need real GitHub auth:

```bash
pnpm smoke:control-plane:api
pnpm dev:web
pnpm dev:admin-idp
pnpm smoke:control-plane:local
```

The dev gateway signs assertions with the local
`HEIMDALL_ADMIN_IDENTITY_ASSERTION_SECRET`. It binds to `127.0.0.1` by default and refuses to run
with `NODE_ENV=production`.

## Live Publisher Smoke

Run the GitHub publisher smoke test only against a development GitHub App installation and a
throwaway PR. The command seeds a completed smoke review run, calls the real publisher path, and
publishes a GitHub check run plus a fallback summary comment.

```bash
pnpm --filter @repo/admin-tools smoke:publisher:github
```

The command loads `.env.smoke.local` from the repository root when the file exists. Copy
`.env.smoke.example` to `.env.smoke.local`, fill in the development GitHub App installation and PR,
and set `HEIMDALL_GITHUB_SMOKE_ALLOW_WRITE=true` only when you intend to publish to that PR.

`GITHUB_APP_PRIVATE_KEY` can replace `GITHUB_PRIVATE_KEY`. Set
`HEIMDALL_GITHUB_SMOKE_INSTALLATION_ID` only when the local installation ID differs from the
GitHub provider installation ID.

Set `HEIMDALL_GITHUB_SMOKE_MODE=stale_head` to run the guarded stale-head path. That mode still
seeds smoke rows in the configured database and reads the PR from GitHub, but it expects the
publisher to skip external writes because the stored review head intentionally differs from the
current PR head.

See `docs/runbooks/github-dev-app.md` for the full app setup, permission checklist, and expected
smoke evidence.

## Live GitHub Provider-Error Smoke

Run the read-only provider-error smoke against a development GitHub App installation:

```bash
pnpm smoke:github-provider-errors
```

The default `not_found` case reads a deliberately missing repository and expects a typed
`github_not_found` provider error plus the matching publisher error serialization. Set
`HEIMDALL_GITHUB_ERROR_SMOKE_CASES=not_found,validation` and
`HEIMDALL_GITHUB_ERROR_SMOKE_ALLOW_INVALID_WRITE=true` only when you also want GitHub to reject an
invalid check-run head SHA.

## Live PR Review Smoke

Run the full webhook-to-publish smoke only against a development GitHub App installation and a
throwaway branch or PR. The smoke updates the throwaway branch, opens or updates the PR, posts a
signed `pull_request` webhook to the local API, waits for the worker to complete review and publish
jobs, and prints proof IDs for the review run, jobs, check run, and comment.

Prepare local dependencies and migrations:

```bash
pnpm infra:prepare
```

Start the API and worker in separate terminals:

```bash
pnpm smoke:api
pnpm smoke:worker
```

Run the guarded live smoke:

```bash
pnpm smoke:review:github
```

The command loads `.env.smoke.local` from the repository root. It requires
`HEIMDALL_GITHUB_SMOKE_ALLOW_WRITE=true`, development GitHub App credentials, and the smoke
owner/repo/installation variables from `.env.smoke.example`. The local smoke scripts default to
the Compose Postgres, Redis, and `local-smoke-secret` webhook settings when those variables are not
set.

Set `HEIMDALL_GITHUB_REVIEW_SMOKE_GH_TOKEN_FALLBACK=true` only when you explicitly want the smoke
to use the active `gh auth token` for throwaway branch writes after GitHub App writes are denied.

See `docs/runbooks/github-dev-app.md` for the full manual verification flow and troubleshooting
table.

## Database Migrations

Drizzle schema files are the source of truth for database structure. Generate migration SQL with:

```bash
pnpm --filter @repo/db db:generate
```

Do not manually edit generated files in `packages/db/migrations`. The bootstrap file
`packages/db/bootstrap/0000_extensions.sql` is the only hand-written database setup file; run it
before Drizzle migrations so PostgreSQL has `vector` and `pgcrypto` available.

Optional integration tests require live services:

- Set `HEIMDALL_DB_TEST_URL` to run PostgreSQL migration and webhook persistence tests.
- Set `HEIMDALL_REDIS_TEST_URL` to run Redis queue tests.

## Architecture Rule

Apps depend on packages. Packages do not depend on apps.

Use `@repo/*` imports for package boundaries. Do not deep-import across package `src`
folders.

`pnpm check` runs typecheck, lint, tests, and the workspace boundary checker.
`pnpm ci:control-plane:release` runs the production deployment audit, production-readiness gate,
`pnpm check`, and `pnpm build`; GitHub Actions runs that command on pull requests and pushes to
`main`.
