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
packages/evaluation
packages/memory
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
pnpm infra:up
pnpm infra:down
```

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

The dashboard supports replay inspection, repository review settings, repository enablement, and
searchable audit history. Replay execution and settings changes write `audit_logs` rows with actor
identity, request IDs, session IDs, and before/after mutation data where applicable.

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
