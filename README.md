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
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm infra:up
pnpm infra:down
```

## Admin Debug API

Admin-debug routes are disabled by default. Enable them only on trusted internal deployments.

```bash
HEIMDALL_ADMIN_DEBUG_ENABLED=true
HEIMDALL_ADMIN_DEBUG_TOKEN=<strong internal token>
```

Send the token with `Authorization: Bearer <token>`. The routes expose webhook, review, publisher,
failure, and replay details.

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
