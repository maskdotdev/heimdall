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
