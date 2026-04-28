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
corepack use pnpm@10.33.2
pnpm install
cp .env.example .env
pnpm infra:up
pnpm check
pnpm dev
```

If your Node distribution does not include Corepack, use
`npm exec --yes -- pnpm@10.33.2 install` for the first install.

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
packages/review-engine
packages/llm-gateway
packages/publisher
packages/memory
packages/observability
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

## Architecture Rule

Apps depend on packages. Packages do not depend on apps.

Use `@repo/*` imports for package boundaries. Do not deep-import across package `src`
folders.
