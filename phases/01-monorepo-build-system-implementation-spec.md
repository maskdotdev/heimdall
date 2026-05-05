# #1 Monorepo and Build System — Implementation Specification

## Purpose

This document defines the implementation plan for the monorepo, build system, local development setup, CI foundation, and developer workflow for a Greptile-like code review system.

The goal of #1 is not to implement review logic yet. The goal is to create a repo that can cleanly support the rest of the product:

```text
/apps
  /web
  /api
  /worker
  /indexer-cli

/packages
  /contracts
  /db
  /github
  /queue
  /repo-sync
  /index-schema
  /indexer-driver
  /indexer-ts
  /index-importer
  /embedding
  /retrieval
  /review-orchestrator
  /review-engine
  /llm-gateway
  /publisher
  /artifacts
  /evaluation
  /memory
  /observability
  /security
  /admin-tools
  /config
```

The outcome should be a high-performance TypeScript monorepo that is easy to reason about, easy to extend, and strict about package boundaries.

---

## Executive summary

Recommended setup:

```text
Package manager:      pnpm workspaces
Task runner:          Turborepo
Runtime:              Bun where appropriate
API framework:        Elysia, later in /apps/api
Dashboard:            TanStack Start, later in /apps/web
Type system:          TypeScript project references
Lint/format:          Biome
Tests:                Vitest
Local infra:          Docker Compose
CI:                   GitHub Actions
Source of truth:      packages/* and apps/* package boundaries
```

Important distinction:

> Use Bun as a runtime. Do not require Bun to own every monorepo concern.

The system can run Bun/Elysia services while using pnpm and Turborepo for the repo-level package graph, dependency management, caching, and CI ergonomics.

Why this split:

- pnpm workspaces are mature and explicit.
- Turborepo gives fast cached task execution across packages.
- Bun gives excellent runtime speed for the API, workers, CLIs, and local scripts.
- TypeScript project references make package boundaries visible to the compiler.
- Biome keeps formatting and linting fast and low-friction.
- Vitest gives one test runner that can work across packages and apps.

The monorepo should optimize for four things:

```text
1. Fast local development.
2. Strict package boundaries.
3. Deterministic builds.
4. Easy future extraction of services/packages.
```

---

## Design principles

### 1. Runtime and package management are separate decisions

Bun is a good runtime for the API, workers, and CLI tools. pnpm is a good workspace/package manager for a larger TypeScript monorepo.

Use this mental model:

```text
pnpm       installs and links the workspace
Turborepo  orchestrates tasks and caching
TypeScript typechecks package boundaries
Bun        runs runtime services and CLIs
Docker     runs local infrastructure dependencies
CI         proves the repo works from a clean clone
```

### 2. Every app and package must have an explicit boundary

Avoid importing random files across the repo.

Good:

```ts
import { PullRequestSnapshotSchema } from "@repo/contracts";
import { createLogger } from "@repo/observability";
```

Bad:

```ts
import { PullRequestSnapshotSchema } from "../../packages/contracts/src/pull-request";
```

Package boundaries are how we keep this system maintainable as it grows.

### 3. Source-first in development, buildable in production

During local development, apps should be able to consume TypeScript source quickly.

For production and CI, packages should be buildable into `dist` artifacts with generated type declarations.

This gives us both speed and portability.

### 4. Use strict TypeScript from the beginning

This product will move complex structured data through many boundaries: webhook payloads, job payloads, index artifacts, context bundles, LLM outputs, findings, and usage events.

The compiler should help aggressively.

Use:

```text
strict
noUncheckedIndexedAccess
exactOptionalPropertyTypes
noImplicitOverride
useUnknownInCatchVariables
noFallthroughCasesInSwitch
```

### 5. Do not let app frameworks leak into core packages

Core packages should not depend on Elysia, TanStack Start, or GitHub-specific runtime behavior unless the package is explicitly framework/provider-specific.

Examples:

```text
/packages/contracts       no Elysia dependency
/packages/retrieval       no GitHub dependency
/packages/review-engine   no GitHub dependency
/packages/github          GitHub dependency allowed
/apps/api                 Elysia dependency allowed
/apps/web                 TanStack dependency allowed
```

### 6. Prefer boring config over clever config

The monorepo should be understandable after one pass.

Avoid too many custom build plugins early. Avoid a custom Nx/Moon/Bazel setup until pain clearly justifies it.

---

## Primary decisions

### Decision 1: Use pnpm workspaces

Use `pnpm` as the package manager and workspace linker.

Root files:

```text
package.json
pnpm-workspace.yaml
pnpm-lock.yaml
.npmrc
```

Why:

- Explicit workspace definition.
- Efficient dependency store.
- Good monorepo ergonomics.
- Works well with Turborepo.
- Avoids forcing every package/tool to be Bun-package-manager compatible.

Bun workspaces are a viable alternative, especially for a smaller all-Bun repo. I would still choose pnpm for this system because the repo is expected to have many packages, mixed app types, CI caching needs, and potentially Node-compatible fallback workers.

### Decision 2: Use Turborepo for task orchestration

Use Turborepo to coordinate:

```text
build
typecheck
lint
format
test
dev
clean
```

It gives us:

- dependency-aware task ordering,
- local caching,
- optional remote caching later,
- simple monorepo commands,
- clear app/package scripts.

### Decision 3: Use Bun for API, workers, scripts, and CLIs

Use Bun to run:

```text
/apps/api
/apps/worker
/apps/indexer-cli
scripts/*.ts
```

Example:

```bash
bun --hot src/index.ts
bun run scripts/validate-env.ts
bun run scripts/seed.ts
```

Do not require Bun for every test/build tool if another tool is more mature for that layer.

### Decision 4: Use TypeScript project references

Use project references to make the repo graph explicit and speed up typechecking as the repo grows.

Root `tsconfig.json` should reference every app/package.

Each package should have its own `tsconfig.json` and optional `tsconfig.build.json`.

### Decision 5: Use Biome for formatting and linting

Use Biome first.

It handles:

```text
formatting
linting
import organization
```

If later we need highly specialized TypeScript lint rules, add ESLint only for targeted packages. Do not start with both Biome and a large ESLint configuration unless needed.

### Decision 6: Use Vitest for tests

Use Vitest for package and app-level unit tests.

Keep test commands package-local, and let Turborepo orchestrate them.

### Decision 7: Use Docker Compose for local dependencies

Use Docker Compose for:

```text
Postgres
Redis
Qdrant later
MinIO later
Mail/debug services later
```

The repo should support:

```bash
pnpm infra:up
pnpm infra:down
pnpm dev
```

---

## Acceptance criteria for #1

After #1 is done, a developer should be able to clone the repo and run:

```bash
pnpm install
pnpm check
pnpm dev
```

The repo should provide:

```text
- A working workspace graph.
- Root commands for build, typecheck, test, lint, format, and dev.
- Empty but runnable app/package shells.
- Strict TypeScript configuration.
- Biome formatting/linting.
- Vitest test setup.
- Docker Compose local infra.
- GitHub Actions CI.
- Environment variable templates.
- A place for generated artifacts and caches.
- Clear package boundary conventions.
- A workspace boundary check included in `pnpm check`.
```

The repo does not need to implement GitHub App logic, indexing, review, publishing, or persistence yet.

---

## Target repository layout

Create this structure:

```text
.
├── apps
│   ├── api
│   │   ├── src
│   │   │   └── index.ts
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── tsconfig.build.json
│   ├── web
│   │   ├── src
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── vite.config.ts
│   ├── worker
│   │   ├── src
│   │   │   └── index.ts
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── tsconfig.build.json
│   └── indexer-cli
│       ├── src
│       │   └── index.ts
│       ├── package.json
│       ├── tsconfig.json
│       └── tsconfig.build.json
│
├── packages
│   ├── contracts
│   │   ├── src
│   │   │   └── index.ts
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── tsconfig.build.json
│   ├── config
│   ├── db
│   ├── github
│   ├── queue
│   ├── repo-sync
│   ├── index-schema
│   ├── indexer-driver
│   ├── indexer-ts
│   ├── index-importer
│   ├── embedding
│   ├── retrieval
│   ├── review-orchestrator
│   ├── review-engine
│   ├── llm-gateway
│   ├── publisher
│   ├── artifacts
│   ├── evaluation
│   ├── memory
│   ├── observability
│   ├── security
│   └── admin-tools
│
├── scripts
│   ├── create-package.ts
│   ├── validate-env.ts
│   └── print-workspace.ts
│
├── infra
│   ├── docker
│   │   ├── postgres
│   │   └── redis
│   └── README.md
│
├── .github
│   └── workflows
│       ├── ci.yml
│       └── dependency-check.yml
│
├── .vscode
│   ├── extensions.json
│   └── settings.json
│
├── .env.example
├── .env.test.example
├── .gitignore
├── .npmrc
├── biome.json
├── compose.yaml
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── tsconfig.json
├── turbo.json
├── vitest.config.ts
├── vitest.workspace.ts
└── README.md
```

The empty packages can initially export placeholders, but they should exist so imports, project references, and package boundaries are established early.

Deferred phase packages such as `/packages/rules`, `/packages/static-analysis`,
`/packages/tool-runner`, `/packages/sandbox`, `/packages/usage`,
`/packages/billing`, and `/packages/entitlements` should not be scaffolded in
#1 unless an MVP package needs a stable public boundary immediately.

---

## Workspace naming conventions

Use a single internal package namespace:

```text
@repo/contracts
@repo/config
@repo/db
@repo/github
@repo/queue
@repo/repo-sync
@repo/index-schema
@repo/indexer-driver
@repo/indexer-ts
@repo/index-importer
@repo/embedding
@repo/retrieval
@repo/review-orchestrator
@repo/review-engine
@repo/llm-gateway
@repo/publisher
@repo/artifacts
@repo/evaluation
@repo/memory
@repo/observability
@repo/security
@repo/admin-tools
```

Use app package names:

```text
@app/api
@app/web
@app/worker
@app/indexer-cli
```

This makes logs and dependency graphs easier to read.

## Boundary checker

Add `scripts/check-boundaries.ts` and run it from `pnpm check`.

The checker should fail the build when:

```text
- a package depends on an app package
- an internal dependency points at an unknown workspace package
- @repo/contracts depends on implementation packages
- @repo/index-schema depends on another @repo package
- @repo/review-engine depends directly on retrieval, GitHub, DB, queue, or publisher packages
- source files deep-import another workspace package's src directory
```

This does not replace TypeScript project references. It enforces architectural
rules that the compiler cannot infer from types alone.

---

## Root package setup

### `package.json`

Use this as the starting point.

```json
{
  "name": "code-review-agent",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.0.0",
  "engines": {
    "node": ">=22.0.0",
    "pnpm": ">=10.0.0",
    "bun": ">=1.2.0"
  },
  "scripts": {
    "dev": "turbo dev",
    "dev:api": "turbo dev --filter=@app/api",
    "dev:web": "turbo dev --filter=@app/web",
    "dev:worker": "turbo dev --filter=@app/worker",
    "build": "turbo build",
    "typecheck": "turbo typecheck",
    "lint": "biome check .",
    "lint:fix": "biome check --write .",
    "format": "biome format --write .",
    "format:check": "biome format .",
    "test": "turbo test",
    "test:watch": "vitest --watch",
    "boundaries:check": "bun run scripts/check-boundaries.ts",
    "check": "pnpm typecheck && pnpm lint && pnpm test && pnpm boundaries:check",
    "clean": "turbo clean && pnpm clean:local",
    "clean:local": "rm -rf .turbo node_modules apps/*/node_modules packages/*/node_modules apps/*/dist packages/*/dist coverage",
    "infra:up": "docker compose up -d",
    "infra:down": "docker compose down",
    "infra:reset": "docker compose down -v && docker compose up -d",
    "workspace:print": "bun run scripts/print-workspace.ts",
    "env:check": "bun run scripts/validate-env.ts"
  },
  "devDependencies": {
    "@biomejs/biome": "catalog:",
    "@types/bun": "catalog:",
    "@types/node": "catalog:",
    "turbo": "catalog:",
    "typescript": "catalog:",
    "vitest": "catalog:"
  }
}
```

Notes:

- Replace `pnpm@10.0.0` with the exact pnpm version chosen at setup time.
- Keep `private: true` at the root.
- Keep root dependencies minimal.
- Use package-level dependencies for app/package-specific libraries.
- `clean:local` uses POSIX shell commands. If Windows support matters, replace it with a Bun script.

Recommended command to set the actual package manager version:

```bash
corepack enable
corepack use pnpm@latest
```

That should update the `packageManager` field to the current pinned version.

---

## pnpm workspace configuration

### `pnpm-workspace.yaml`

Use this:

```yaml
packages:
  - "apps/*"
  - "packages/*"

catalog:
  typescript: latest
  turbo: latest
  vitest: latest
  '@types/node': latest
  '@types/bun': latest
  '@biomejs/biome': latest
  elysia: latest
  '@tanstack/react-start': latest
  '@tanstack/react-router': latest
  '@tanstack/react-query': latest
  vite: latest
  zod: latest
```

For production, do not leave catalog versions as `latest` forever. After the first install, pin versions deliberately.

Recommended production style:

```yaml
catalog:
  typescript: 5.x.x
  turbo: 2.x.x
  vitest: 4.x.x
  '@biomejs/biome': 2.x.x
```

Use `latest` only during initial bootstrap or spike work.

### `.npmrc`

Use this:

```ini
auto-install-peers=true
prefer-workspace-packages=true
shared-workspace-lockfile=true
engine-strict=true
strict-peer-dependencies=false
resolution-mode=highest
```

Recommended behavior:

- Commit `pnpm-lock.yaml`.
- Do not commit `node_modules`.
- Use `pnpm install --frozen-lockfile` in CI.
- Keep dependency updates intentional.

---

## Turborepo configuration

### `turbo.json`

Use this:

```json
{
  "$schema": "https://turborepo.com/schema.json",
  "ui": "tui",
  "globalDependencies": [
    "pnpm-lock.yaml",
    "package.json",
    "pnpm-workspace.yaml",
    "tsconfig.base.json",
    "biome.json",
    ".env.example"
  ],
  "globalEnv": [
    "NODE_ENV",
    "LOG_LEVEL",
    "DATABASE_URL",
    "REDIS_URL",
    "GITHUB_APP_ID",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_WEBHOOK_SECRET",
    "OPENAI_API_KEY"
  ],
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": [
        "dist/**",
        ".output/**",
        "build/**",
        ".tanstack/**"
      ]
    },
    "typecheck": {
      "dependsOn": ["^build"],
      "outputs": ["*.tsbuildinfo", ".tsbuildinfo/**"]
    },
    "test": {
      "dependsOn": ["^build"],
      "outputs": ["coverage/**"]
    },
    "lint": {
      "outputs": []
    },
    "format": {
      "outputs": []
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "clean": {
      "cache": false
    }
  }
}
```

Rules:

- `dev` must not be cached.
- `dev` should be persistent.
- `build` should depend on dependency package builds.
- `typecheck` can depend on builds in early setup; later you may optimize this.
- Add more granular outputs as each app gets real build artifacts.

---

## TypeScript configuration

### Goals

The TypeScript setup should support:

```text
- strict checking
- package boundaries
- project references
- fast incremental builds
- declaration emit for packages
- Bun runtime compatibility
- Vite/TanStack compatibility
```

### Root `tsconfig.base.json`

Use this as the shared base:

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "moduleDetection": "force",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "useUnknownInCatchVariables": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "baseUrl": ".",
    "paths": {
      "@repo/contracts": ["packages/contracts/src/index.ts"],
      "@repo/config": ["packages/config/src/index.ts"],
      "@repo/db": ["packages/db/src/index.ts"],
      "@repo/github": ["packages/github/src/index.ts"],
      "@repo/queue": ["packages/queue/src/index.ts"],
      "@repo/repo-sync": ["packages/repo-sync/src/index.ts"],
      "@repo/index-schema": ["packages/index-schema/src/index.ts"],
      "@repo/indexer-driver": ["packages/indexer-driver/src/index.ts"],
      "@repo/indexer-ts": ["packages/indexer-ts/src/index.ts"],
      "@repo/index-importer": ["packages/index-importer/src/index.ts"],
      "@repo/embedding": ["packages/embedding/src/index.ts"],
      "@repo/retrieval": ["packages/retrieval/src/index.ts"],
      "@repo/review-orchestrator": ["packages/review-orchestrator/src/index.ts"],
      "@repo/review-engine": ["packages/review-engine/src/index.ts"],
      "@repo/llm-gateway": ["packages/llm-gateway/src/index.ts"],
      "@repo/publisher": ["packages/publisher/src/index.ts"],
      "@repo/artifacts": ["packages/artifacts/src/index.ts"],
      "@repo/evaluation": ["packages/evaluation/src/index.ts"],
      "@repo/memory": ["packages/memory/src/index.ts"],
      "@repo/observability": ["packages/observability/src/index.ts"],
      "@repo/security": ["packages/security/src/index.ts"],
      "@repo/admin-tools": ["packages/admin-tools/src/index.ts"]
    }
  }
}
```

Notes:

- The `paths` map supports fast local source imports.
- Production builds still emit package artifacts.
- Bun can read TypeScript path mapping, which makes these aliases useful during Bun-run development.
- Keep app-specific options in app `tsconfig.json` files.

### Root `tsconfig.json`

Use root project references:

```json
{
  "files": [],
  "references": [
    { "path": "./apps/api" },
    { "path": "./apps/web" },
    { "path": "./apps/worker" },
    { "path": "./apps/indexer-cli" },
    { "path": "./packages/contracts" },
    { "path": "./packages/config" },
    { "path": "./packages/db" },
    { "path": "./packages/github" },
    { "path": "./packages/queue" },
    { "path": "./packages/repo-sync" },
    { "path": "./packages/index-schema" },
    { "path": "./packages/indexer-driver" },
    { "path": "./packages/indexer-ts" },
    { "path": "./packages/index-importer" },
    { "path": "./packages/embedding" },
    { "path": "./packages/retrieval" },
    { "path": "./packages/review-orchestrator" },
    { "path": "./packages/review-engine" },
    { "path": "./packages/llm-gateway" },
    { "path": "./packages/publisher" },
    { "path": "./packages/artifacts" },
    { "path": "./packages/evaluation" },
    { "path": "./packages/memory" },
    { "path": "./packages/observability" },
    { "path": "./packages/security" },
    { "path": "./packages/admin-tools" }
  ]
}
```

### Package `tsconfig.json`

Each package should have:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "noEmit": true,
    "tsBuildInfoFile": "./.tsbuildinfo/typecheck.tsbuildinfo"
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "test/**/*.ts"],
  "exclude": ["dist", "node_modules"]
}
```

### Package `tsconfig.build.json`

Each buildable package should have:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "declaration": true,
    "declarationMap": true,
    "emitDeclarationOnly": false,
    "outDir": "dist",
    "rootDir": "src",
    "tsBuildInfoFile": "./.tsbuildinfo/build.tsbuildinfo"
  },
  "include": ["src/**/*.ts"],
  "exclude": ["dist", "node_modules", "test", "**/*.test.ts", "**/*.spec.ts"]
}
```

### App `tsconfig.json`

For Bun backend apps:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "types": ["bun"],
    "noEmit": true,
    "tsBuildInfoFile": "./.tsbuildinfo/typecheck.tsbuildinfo"
  },
  "include": ["src/**/*.ts"],
  "exclude": ["dist", "node_modules"]
}
```

For the web app, let TanStack/Vite add its generated types as needed.

---

## Package template

Every internal package should follow this shape.

### `packages/example/package.json`

```json
{
  "name": "@repo/example",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "lint": "biome check .",
    "format": "biome format --write .",
    "clean": "rm -rf dist .tsbuildinfo coverage"
  },
  "dependencies": {},
  "devDependencies": {
    "typescript": "catalog:",
    "vitest": "catalog:"
  }
}
```

### `packages/example/src/index.ts`

```ts
export const packageName = "@repo/example" as const;
```

### Notes

- Internal packages should be `private: true` until you intentionally publish anything.
- Keep public package exports narrow.
- Avoid exporting deep internals.
- Use `src/index.ts` as the package surface.
- Prefer named exports.

---

## App templates

### API app shell

Path:

```text
/apps/api
```

`apps/api/package.json`:

```json
{
  "name": "@app/api",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun --hot src/index.ts",
    "build": "bun build src/index.ts --target=bun --outdir=dist",
    "start": "bun dist/index.js",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "lint": "biome check .",
    "format": "biome format --write .",
    "clean": "rm -rf dist .tsbuildinfo coverage"
  },
  "dependencies": {
    "@repo/config": "workspace:*",
    "@repo/contracts": "workspace:*",
    "@repo/observability": "workspace:*",
    "elysia": "catalog:"
  },
  "devDependencies": {
    "@types/bun": "catalog:",
    "typescript": "catalog:",
    "vitest": "catalog:"
  }
}
```

`apps/api/src/index.ts`:

```ts
import { Elysia } from "elysia";

const app = new Elysia()
  .get("/healthz", () => ({ ok: true, service: "api" }))
  .listen({ port: Number(process.env.PORT ?? 3000) });

console.log(`api listening on ${app.server?.hostname}:${app.server?.port}`);
```

### Worker app shell

Path:

```text
/apps/worker
```

`apps/worker/package.json`:

```json
{
  "name": "@app/worker",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun --watch src/index.ts",
    "build": "bun build src/index.ts --target=bun --outdir=dist",
    "start": "bun dist/index.js",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "lint": "biome check .",
    "format": "biome format --write .",
    "clean": "rm -rf dist .tsbuildinfo coverage"
  },
  "dependencies": {
    "@repo/config": "workspace:*",
    "@repo/contracts": "workspace:*",
    "@repo/observability": "workspace:*",
    "@repo/queue": "workspace:*"
  },
  "devDependencies": {
    "@types/bun": "catalog:",
    "typescript": "catalog:",
    "vitest": "catalog:"
  }
}
```

`apps/worker/src/index.ts`:

```ts
console.log("worker booted");

process.on("SIGTERM", () => {
  console.log("worker received SIGTERM");
  process.exit(0);
});
```

### Indexer CLI shell

Path:

```text
/apps/indexer-cli
```

`apps/indexer-cli/package.json`:

```json
{
  "name": "@app/indexer-cli",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "bin": {
    "indexer": "./dist/index.js"
  },
  "scripts": {
    "dev": "bun src/index.ts",
    "build": "bun build src/index.ts --target=bun --outdir=dist",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "lint": "biome check .",
    "format": "biome format --write .",
    "clean": "rm -rf dist .tsbuildinfo coverage"
  },
  "dependencies": {
    "@repo/contracts": "workspace:*",
    "@repo/index-schema": "workspace:*",
    "@repo/indexer-ts": "workspace:*"
  },
  "devDependencies": {
    "@types/bun": "catalog:",
    "typescript": "catalog:",
    "vitest": "catalog:"
  }
}
```

`apps/indexer-cli/src/index.ts`:

```ts
console.log("indexer cli placeholder");
console.log(process.argv.slice(2));
```

### Web app shell

Path:

```text
/apps/web
```

For #1, the web app can be a minimal TanStack Start project. Do not build the dashboard yet. The target is only a runnable shell.

`apps/web/package.json` should eventually include:

```json
{
  "name": "@app/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite --host 0.0.0.0 --port 3001",
    "build": "vite build",
    "start": "vite preview --host 0.0.0.0 --port 3001",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "lint": "biome check .",
    "format": "biome format --write .",
    "clean": "rm -rf dist .output .tanstack .tsbuildinfo coverage"
  },
  "dependencies": {
    "@repo/contracts": "workspace:*",
    "@tanstack/react-query": "catalog:",
    "@tanstack/react-router": "catalog:",
    "@tanstack/react-start": "catalog:"
  },
  "devDependencies": {
    "typescript": "catalog:",
    "vite": "catalog:",
    "vitest": "catalog:"
  }
}
```

Depending on the current TanStack Start scaffold, the exact app files may differ. Keep the app isolated under `/apps/web` and do not let its generated conventions leak into shared packages.

---

## Biome configuration

### `biome.json`

Use this:

```json
{
  "$schema": "https://biomejs.dev/schemas/2.0.0/schema.json",
  "vcs": {
    "enabled": true,
    "clientKind": "git",
    "useIgnoreFile": true
  },
  "files": {
    "ignoreUnknown": false,
    "includes": [
      "apps/**",
      "packages/**",
      "scripts/**",
      "*.json",
      "*.jsonc",
      "*.ts",
      "*.tsx"
    ]
  },
  "formatter": {
    "enabled": true,
    "formatWithErrors": false,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "double",
      "semicolons": "always",
      "trailingCommas": "all"
    }
  },
  "json": {
    "formatter": {
      "trailingCommas": "none"
    }
  },
  "organizeImports": {
    "enabled": true
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "correctness": {
        "noUnusedImports": "error",
        "noUnusedVariables": "error"
      },
      "style": {
        "useImportType": "error"
      },
      "suspicious": {
        "noExplicitAny": "warn"
      }
    }
  }
}
```

Notes:

- Treat `any` as a warning at first, not an error. Some integration boundaries may need `unknown` parsing and narrowing.
- Keep formatting automatic and non-negotiable.
- If Biome schema version changes, regenerate this file from the current Biome docs.

---

## Vitest configuration

### `vitest.config.ts`

Use this at root:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: [
      "apps/**/src/**/*.test.ts",
      "apps/**/src/**/*.spec.ts",
      "packages/**/src/**/*.test.ts",
      "packages/**/src/**/*.spec.ts",
      "packages/**/test/**/*.test.ts",
    ],
    exclude: ["node_modules", "dist", ".turbo", ".output"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "coverage",
    },
  },
});
```

### `vitest.workspace.ts`

Use this if you want each package/app to have its own project config later:

```ts
import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "apps/*/vitest.config.ts",
  "packages/*/vitest.config.ts",
  "vitest.config.ts",
]);
```

At first, a single root `vitest.config.ts` is enough. Add package-level configs only when necessary.

---

## Environment configuration

### `.env.example`

Use this:

```bash
# Runtime
NODE_ENV=development
LOG_LEVEL=debug

# API
PORT=3000
WEB_URL=http://localhost:3001
API_URL=http://localhost:3000

# Database
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/review_agent

# Redis / queues
REDIS_URL=redis://localhost:6379

# GitHub App placeholders
GITHUB_APP_ID=
GITHUB_APP_PRIVATE_KEY=
GITHUB_WEBHOOK_SECRET=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=

# LLM providers
OPENAI_API_KEY=
ANTHROPIC_API_KEY=

# Object storage, optional in MVP
S3_ENDPOINT=
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
S3_BUCKET=
```

### `.env.test.example`

Use this:

```bash
NODE_ENV=test
LOG_LEVEL=error
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/review_agent_test
REDIS_URL=redis://localhost:6379/1
```

### Rules

- Commit `.env.example` and `.env.test.example`.
- Do not commit `.env`, `.env.local`, or private key files.
- Add a `@repo/config` package later to validate environment variables at boot.
- Avoid reading env vars directly throughout the codebase. Use the config package.

---

## Docker Compose local infrastructure

### `compose.yaml`

Use this as the local baseline:

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg17
    container_name: review-agent-postgres
    ports:
      - "5432:5432"
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: review_agent
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d review_agent"]
      interval: 5s
      timeout: 5s
      retries: 20

  redis:
    image: redis:7-alpine
    container_name: review-agent-redis
    ports:
      - "6379:6379"
    command: ["redis-server", "--appendonly", "yes"]
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 20

volumes:
  postgres_data:
  redis_data:
```

Later add:

```text
qdrant
minio
mailpit
otel-collector
grafana
prometheus
```

For #1, Postgres and Redis are enough.

---

## Git ignore rules

### `.gitignore`

Use this:

```gitignore
# dependencies
node_modules/
.pnpm-store/

# build outputs
dist/
build/
.output/
.tanstack/
.vinxi/
coverage/

# turbo/cache
.turbo/
*.tsbuildinfo
.tsbuildinfo/

# env/secrets
.env
.env.*
!.env.example
!.env.test.example
*.pem
*.key

# logs
*.log
logs/

# local artifacts
.tmp/
tmp/
artifacts/
repo-cache/
worktrees/

# OS/editor
.DS_Store
.idea/
.vscode/*
!.vscode/extensions.json
!.vscode/settings.json
```

---

## VS Code workspace recommendations

### `.vscode/extensions.json`

Use this:

```json
{
  "recommendations": [
    "biomejs.biome",
    "vitest.explorer",
    "ms-azuretools.vscode-docker",
    "tamasfe.even-better-toml",
    "redhat.vscode-yaml"
  ]
}
```

### `.vscode/settings.json`

Use this:

```json
{
  "editor.defaultFormatter": "biomejs.biome",
  "editor.formatOnSave": true,
  "editor.codeActionsOnSave": {
    "quickfix.biome": "explicit",
    "source.organizeImports.biome": "explicit"
  },
  "typescript.tsdk": "node_modules/typescript/lib",
  "typescript.preferences.importModuleSpecifier": "non-relative",
  "vitest.rootConfig": "vitest.config.ts"
}
```

---

## Dependency direction rules

The package dependency graph should flow downward like this:

```text
apps
  -> provider packages
  -> product packages
  -> infra packages
  -> contracts/config/observability
```

Recommended dependencies:

```text
/apps/api
  -> @repo/contracts
  -> @repo/config
  -> @repo/github
  -> @repo/queue
  -> @repo/security
  -> @repo/admin-tools
  -> @repo/observability

/apps/worker
  -> @repo/contracts
  -> @repo/config
  -> @repo/queue
  -> @repo/repo-sync
  -> @repo/indexer-driver
  -> @repo/index-importer
  -> @repo/embedding
  -> @repo/retrieval
  -> @repo/review-orchestrator
  -> @repo/review-engine
  -> @repo/publisher
  -> @repo/artifacts
  -> @repo/memory
  -> @repo/security
  -> @repo/observability

/apps/indexer-cli
  -> @repo/contracts
  -> @repo/index-schema
  -> @repo/indexer-ts

/packages/review-engine
  -> @repo/contracts
  -> @repo/llm-gateway

/packages/admin-tools
  -> @repo/contracts
  -> @repo/db
  -> @repo/security
  -> @repo/artifacts

/packages/retrieval
  -> @repo/contracts
  -> @repo/db
  -> @repo/embedding

Retrieval may depend on `@repo/embedding` only for the `SemanticSearchService` port/facade. It must not import provider internals, vector-store implementation details, or code that depends back on retrieval.

/packages/github
  -> @repo/contracts
  -> @repo/config
  -> @repo/observability
```

Forbidden dependencies:

```text
/packages/contracts -> anything product-specific
/packages/contracts -> @repo/db
/packages/contracts -> @repo/github
/packages/index-schema -> any @repo/* package
/packages/review-engine -> @repo/github
/packages/review-engine -> @repo/retrieval
/packages/retrieval -> @repo/publisher
/packages/embedding -> @repo/retrieval
/packages/indexer-ts -> @repo/db
/packages/indexer-ts -> @repo/embedding
```

The indexer should emit artifacts. The importer should write to storage.

---

## Suggested package creation script

Create `scripts/create-package.ts` to keep package shape consistent.

Pseudo-implementation:

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const name = process.argv[2];
if (!name) {
  console.error("usage: bun run scripts/create-package.ts <name>");
  process.exit(1);
}

const dir = join(process.cwd(), "packages", name);
const packageName = `@repo/${name}`;

await mkdir(join(dir, "src"), { recursive: true });

await writeFile(
  join(dir, "src", "index.ts"),
  `export const packageName = ${JSON.stringify(packageName)} as const;\n`,
);

await writeFile(
  join(dir, "package.json"),
  JSON.stringify(
    {
      name: packageName,
      version: "0.0.0",
      private: true,
      type: "module",
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      exports: {
        ".": {
          types: "./dist/index.d.ts",
          import: "./dist/index.js",
        },
      },
      scripts: {
        build: "tsc -p tsconfig.build.json",
        typecheck: "tsc -p tsconfig.json --noEmit",
        test: "vitest run",
        lint: "biome check .",
        format: "biome format --write .",
        clean: "rm -rf dist .tsbuildinfo coverage",
      },
      dependencies: {},
      devDependencies: {
        typescript: "catalog:",
        vitest: "catalog:",
      },
    },
    null,
    2,
  ),
);
```

This script does not need to be perfect in #1, but having it early reduces drift.

---

## CI setup

### Goals

CI should verify a clean clone can:

```text
install dependencies
format/lint
run typechecks
run tests
build packages/apps
```

### `.github/workflows/ci.yml`

Use this:

```yaml
name: ci

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 20

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Enable Corepack
        run: corepack enable

      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          run_install: false

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Format check
        run: pnpm format:check

      - name: Lint
        run: pnpm lint

      - name: Typecheck
        run: pnpm typecheck

      - name: Test
        run: pnpm test

      - name: Build
        run: pnpm build
```

Notes:

- Add database/Redis service containers only once integration tests need them.
- Keep the first CI pipeline simple.
- Add Turborepo remote cache later, not on day one.

### Optional dependency check workflow

`.github/workflows/dependency-check.yml`:

```yaml
name: dependency-check

on:
  pull_request:
    branches: [main]
  schedule:
    - cron: "0 12 * * 1"

permissions:
  contents: read

jobs:
  audit:
    runs-on: ubuntu-latest
    timeout-minutes: 15

    steps:
      - uses: actions/checkout@v4
      - run: corepack enable
      - uses: pnpm/action-setup@v4
        with:
          run_install: false
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm audit --audit-level moderate
```

Do not let dependency audit become noisy too early. Tune this later.

---

## Local development workflow

### First-time setup

```bash
git clone <repo>
cd code-review-agent
corepack enable
corepack use pnpm@latest
pnpm install
cp .env.example .env
pnpm infra:up
pnpm check
pnpm dev
```

### Common commands

```bash
pnpm dev             # run all dev tasks
pnpm dev:api         # API only
pnpm dev:web         # web only
pnpm dev:worker      # worker only
pnpm check           # typecheck + lint + test
pnpm typecheck       # TypeScript only
pnpm lint            # Biome check
pnpm lint:fix        # Biome autofix
pnpm format          # Biome format
pnpm test            # run tests
pnpm build           # build all apps/packages
pnpm infra:up        # start local Postgres/Redis
pnpm infra:down      # stop local infra
pnpm infra:reset     # reset local infra volumes
```

### Recommended everyday loop

```bash
pnpm infra:up
pnpm dev
```

In a second terminal:

```bash
pnpm test:watch
```

Before committing:

```bash
pnpm check
```

---

## Local infra conventions

Use these default ports:

```text
API:       3000
Web:       3001
Postgres:  5432
Redis:     6379
```

Use these local databases:

```text
review_agent
review_agent_test
```

Use these local artifact directories:

```text
.tmp/
artifacts/
repo-cache/
worktrees/
```

Do not commit those directories.

---

## Build output conventions

Packages:

```text
packages/*/dist
```

Apps:

```text
apps/api/dist
apps/worker/dist
apps/indexer-cli/dist
apps/web/dist or framework-specific output
```

TypeScript build info:

```text
packages/*/.tsbuildinfo
apps/*/.tsbuildinfo
```

Turborepo cache:

```text
.turbo
```

All of these are ignored by git.

---

## Testing conventions

Use colocated unit tests for pure modules:

```text
packages/contracts/src/primitives.test.ts
packages/retrieval/src/context-budget.test.ts
```

Use `test/` folders for fixture-heavy tests:

```text
packages/index-schema/test/fixtures/valid-artifact.test.ts
packages/review-engine/test/finding-validation.test.ts
```

Naming:

```text
*.test.ts
*.spec.ts
```

Rules:

- Unit tests should not hit network.
- Unit tests should not require Postgres/Redis.
- Integration tests should be explicitly marked or placed separately later.
- Every package should have at least one smoke test once real code exists.

---

## Source conventions

### Files

Use kebab-case for filenames:

```text
pull-request-snapshot.ts
index-manifest.ts
review-run.ts
```

Use `index.ts` as the public export surface.

### Exports

Prefer named exports:

```ts
export { PullRequestSnapshotSchema } from "./pull-request-snapshot";
export type { PullRequestSnapshot } from "./pull-request-snapshot";
```

Avoid default exports in shared packages.

### Imports

Prefer package imports:

```ts
import { Result } from "@repo/contracts";
```

Avoid deep cross-package imports:

```ts
// Avoid
import { Result } from "@repo/contracts/src/primitives/result";
```

### Error handling

Use explicit error/result contracts in core packages. Avoid throwing arbitrary strings.

Good:

```ts
throw new Error("Missing repository id");
```

Better later:

```ts
return err({ code: "missing_repository_id", message: "Missing repository id" });
```

---

## App/package dependency examples

### `@repo/contracts`

Should be dependency-light.

Allowed:

```text
@sinclair/typebox or zod, depending on #0 decision
ajv if validators live here
```

Forbidden:

```text
Elysia
GitHub clients
DB drivers
LLM SDKs
Queue libraries
```

### `@repo/config`

Allowed:

```text
@repo/contracts
schema validation library
```

Forbidden:

```text
GitHub clients
DB drivers, unless config explicitly tests connections later
```

### `@repo/db`

Allowed later:

```text
drizzle-orm
postgres driver
@repo/contracts
@repo/config
```

### `@repo/github`

Allowed later:

```text
Octokit
@repo/contracts
@repo/config
@repo/observability
```

### `@repo/review-engine`

Allowed later:

```text
@repo/contracts
@repo/llm-gateway
```

Forbidden:

```text
@repo/github
@repo/publisher
```

---

## Bootstrapping order

Implement #1 in this order.

### Step 1: Create root files

Create:

```text
package.json
pnpm-workspace.yaml
.npmrc
tsconfig.base.json
tsconfig.json
turbo.json
biome.json
vitest.config.ts
vitest.workspace.ts
compose.yaml
.env.example
.env.test.example
.gitignore
README.md
```

Run:

```bash
corepack enable
corepack use pnpm@latest
pnpm install
```

### Step 2: Create app shells

Create:

```text
apps/api
apps/web
apps/worker
apps/indexer-cli
```

Each should have:

```text
package.json
src/index.ts or framework shell
tsconfig.json
tsconfig.build.json where applicable
```

### Step 3: Create package shells

Create all core package directories.

Each should have:

```text
package.json
src/index.ts
tsconfig.json
tsconfig.build.json
```

### Step 4: Add root project references

Update root `tsconfig.json` with every app/package.

### Step 5: Add package dependencies

Add only necessary workspace dependencies.

For empty shell packages, keep dependencies minimal.

### Step 6: Run all checks

```bash
pnpm format
pnpm typecheck
pnpm test
pnpm build
pnpm check
```

### Step 7: Add CI

Create `.github/workflows/ci.yml`.

Confirm CI passes on a branch.

---

## Initial package dependency map

At the end of #1, most packages are shells. Still, establish the intended dependency map.

```text
@repo/contracts
  no internal deps

@repo/config
  -> @repo/contracts

@repo/observability
  -> @repo/config

@repo/db
  -> @repo/contracts
  -> @repo/config
  -> @repo/observability

@repo/github
  -> @repo/contracts
  -> @repo/config
  -> @repo/observability

@repo/queue
  -> @repo/contracts
  -> @repo/config
  -> @repo/observability

@repo/index-schema
  -> @repo/contracts

@repo/indexer-ts
  -> @repo/contracts
  -> @repo/index-schema

@repo/indexer-driver
  -> @repo/contracts
  -> @repo/index-schema
  -> @repo/config
  -> @repo/observability

@repo/index-importer
  -> @repo/contracts
  -> @repo/index-schema
  -> @repo/db
  -> @repo/queue

@repo/embedding
  -> @repo/contracts
  -> @repo/db
  -> @repo/llm-gateway

@repo/retrieval
  -> @repo/contracts
  -> @repo/db

@repo/llm-gateway
  -> @repo/contracts
  -> @repo/config
  -> @repo/observability

@repo/review-engine
  -> @repo/contracts
  -> @repo/retrieval
  -> @repo/llm-gateway

@repo/publisher
  -> @repo/contracts
  -> @repo/github
  -> @repo/db

@repo/memory
  -> @repo/contracts
  -> @repo/db
```

Do not fully wire all of this in #1. Use it as the dependency direction map for future sections.

---

## README outline

Create a root `README.md` with this structure:

````md
# Code Review Agent

## Requirements

- Node.js 22+
- pnpm 10+
- Bun 1.2+
- Docker

## Setup

```bash
corepack enable
corepack use pnpm@latest
pnpm install
cp .env.example .env
pnpm infra:up
pnpm check
pnpm dev
```

## Repository structure

```text
apps/api
apps/web
apps/worker
apps/indexer-cli
packages/contracts
...
```

## Common commands

```bash
pnpm dev
pnpm check
pnpm build
pnpm infra:up
pnpm infra:down
```

## Architecture rule

Apps depend on packages. Packages should not depend on apps.

## Package boundaries

Use `@repo/*` imports. Do not deep-import across package `src` folders.
````

## Enforced dependency boundaries

Documentation is not enough for this repo. Add a CI-enforced package dependency check before feature packages become real.

Recommended rule set:

```text
- apps may depend on packages
- packages may not depend on apps
- no package may deep-import another package's src internals
- @repo/contracts may not depend on implementation packages
- @repo/index-schema may depend only on contracts primitives and lightweight validation deps
- @repo/review-engine may not depend on @repo/github, @repo/db, @repo/retrieval, @repo/publisher, or apps
- @repo/review-orchestrator is allowed to compose retrieval, review-engine, validation, artifacts, queue, and db
- @repo/artifacts may not depend on review, retrieval, GitHub, or LLM packages
```

Use `dependency-cruiser`, `madge`, or targeted lint rules. The exact tool is less important than making `pnpm check` fail on boundary violations.

---

## Root health checks

Add a simple workspace script.

### `scripts/print-workspace.ts`

```ts
const workspace = {
  apps: ["api", "web", "worker", "indexer-cli"],
  packages: [
    "contracts",
    "config",
    "db",
    "github",
    "queue",
    "repo-sync",
    "index-schema",
    "indexer-driver",
    "indexer-ts",
    "index-importer",
    "embedding",
    "retrieval",
    "review-orchestrator",
    "review-engine",
    "llm-gateway",
    "publisher",
    "artifacts",
    "evaluation",
    "memory",
    "observability",
  ],
};

console.log(JSON.stringify(workspace, null, 2));
```

### `scripts/validate-env.ts`

In #1, keep this simple:

```ts
const required = ["DATABASE_URL", "REDIS_URL"] as const;

const missing = required.filter((key) => !process.env[key]);

if (missing.length > 0) {
  console.error(`Missing env vars: ${missing.join(", ")}`);
  process.exit(1);
}

console.log("environment looks valid");
```

In #5 or #22, replace this with `@repo/config` schema validation.

---

## Performance considerations

### 1. Keep dependency installation fast

Use:

```text
pnpm-lock.yaml
pnpm install --frozen-lockfile in CI
workspace protocol for internal packages
minimal root dependencies
```

### 2. Keep TypeScript fast

Use:

```text
project references
incremental build info
package-level typecheck scripts
no unnecessary giant root include
```

Avoid a root `tsconfig` that includes every `src` file directly. Use references instead.

### 3. Keep dev startup fast

Use Bun for API/worker/indexer CLI dev commands:

```bash
bun --hot src/index.ts
bun --watch src/index.ts
```

### 4. Keep CI predictable

Use:

```text
frozen lockfile
one CI entry command per concern
cache pnpm store
build after typecheck/test
```

### 5. Avoid massive framework coupling

Do not make TanStack Start own backend logic. Keep API and workers separate.

---

## Migration and future-proofing

### If we want to move from pnpm to Bun workspaces later

Keep:

```text
apps/*
packages/*
package boundaries
package.json scripts
Turborepo task definitions
```

Change:

```text
pnpm-workspace.yaml -> package.json workspaces
pnpm-lock.yaml -> bun.lock
pnpm commands -> bun commands
pnpm catalog versions -> package-level versions or Bun-supported equivalent
```

This is possible if the repo stays disciplined about package scripts and boundaries.

### If we want to add Nx/Moon/Bazel later

Keep:

```text
apps/packages layout
package.json scripts
TypeScript references
explicit dependency graph
```

Change:

```text
Turborepo config
CI task commands
cache configuration
project metadata
```

Do not add heavier orchestration until Turborepo becomes insufficient.

### If we want to extract a service later

The repo layout should make this easy.

Example extraction:

```text
/apps/indexer-cli
/packages/index-schema
/packages/indexer-ts
/packages/indexer-driver
```

can become:

```text
external indexer service repo
```

as long as index artifacts remain stable.

---

## Common failure modes to avoid

### Failure mode 1: Root package becomes a dumping ground

Avoid putting app-specific dependencies in the root package.

Bad:

```text
root package.json includes Elysia, Drizzle, Octokit, TanStack, BullMQ, OpenAI SDK, etc.
```

Good:

```text
apps/api owns Elysia
packages/db owns Drizzle
packages/github owns Octokit
packages/llm-gateway owns model SDKs
```

### Failure mode 2: Deep imports across package source

Bad:

```ts
import { x } from "../../contracts/src/internal/foo";
```

Good:

```ts
import { x } from "@repo/contracts";
```

### Failure mode 3: One giant `utils` package

Avoid `@repo/utils` unless absolutely necessary.

Prefer domain-specific packages:

```text
@repo/config
@repo/observability
@repo/index-schema
```

### Failure mode 4: Framework-specific contracts

Bad:

```ts
// @repo/contracts imports Elysia types
```

Good:

```ts
// @repo/contracts exports neutral schemas
// apps/api adapts them to Elysia
```

### Failure mode 5: CI runs different commands than developers

Keep local and CI commands aligned:

```text
pnpm check
pnpm build
```

CI should not have a totally separate validation path.

---

## Implementation checklist

### Root setup

- [ ] Create `package.json`.
- [ ] Create `pnpm-workspace.yaml`.
- [ ] Create `.npmrc`.
- [ ] Create `turbo.json`.
- [ ] Create `tsconfig.base.json`.
- [ ] Create root `tsconfig.json`.
- [ ] Create `biome.json`.
- [ ] Create `vitest.config.ts`.
- [ ] Create `vitest.workspace.ts`.
- [ ] Create `.env.example`.
- [ ] Create `.env.test.example`.
- [ ] Create `.gitignore`.
- [ ] Create `compose.yaml`.
- [ ] Create root `README.md`.

### Apps

- [ ] Create `/apps/api` shell.
- [ ] Create `/apps/web` shell.
- [ ] Create `/apps/worker` shell.
- [ ] Create `/apps/indexer-cli` shell.
- [ ] Add package scripts for each app.
- [ ] Add TypeScript configs for each app.

### Packages

- [ ] Create `/packages/contracts` shell.
- [ ] Create `/packages/config` shell.
- [ ] Create `/packages/db` shell.
- [ ] Create `/packages/github` shell.
- [ ] Create `/packages/queue` shell.
- [ ] Create `/packages/repo-sync` shell.
- [ ] Create `/packages/index-schema` shell.
- [ ] Create `/packages/indexer-driver` shell.
- [ ] Create `/packages/indexer-ts` shell.
- [ ] Create `/packages/index-importer` shell.
- [ ] Create `/packages/embedding` shell.
- [ ] Create `/packages/retrieval` shell.
- [ ] Create `/packages/review-orchestrator` shell.
- [ ] Create `/packages/review-engine` shell.
- [ ] Create `/packages/llm-gateway` shell.
- [ ] Create `/packages/publisher` shell.
- [ ] Create `/packages/artifacts` shell.
- [ ] Create `/packages/evaluation` shell.
- [ ] Create `/packages/memory` shell.
- [ ] Create `/packages/observability` shell.
- [ ] Create `/packages/security` shell.
- [ ] Create `/packages/admin-tools` shell.

### Tooling

- [ ] Add `scripts/print-workspace.ts`.
- [ ] Add `scripts/validate-env.ts`.
- [ ] Add `scripts/check-boundaries.ts`.
- [ ] Add `.vscode/extensions.json`.
- [ ] Add `.vscode/settings.json`.
- [ ] Add GitHub Actions CI workflow.
- [ ] Confirm `pnpm install` works.
- [ ] Confirm `pnpm format` works.
- [ ] Confirm `pnpm typecheck` works.
- [ ] Confirm `pnpm test` works.
- [ ] Confirm `pnpm build` works.
- [ ] Confirm `pnpm check` works.
- [ ] Confirm `pnpm infra:up` works.

---

## Definition of done

#1 is done when:

```text
1. The repo has the target apps/packages structure.
2. The root workspace installs successfully with pnpm.
3. All packages have consistent package.json, tsconfig.json, and src/index.ts files.
4. Root TypeScript project references are complete.
5. Turborepo can run build/typecheck/test/dev tasks.
6. Biome can format/lint the repo.
7. Vitest can run successfully.
8. Docker Compose starts Postgres and Redis.
9. CI passes on a clean branch.
10. The README explains setup and commands.
```

At this point, the repo is ready for #2 Database Layer and #3 GitHub App Integration.

---

## Standalone bootstrap script outline

If you want to automate most of #1, create a one-time script like `scripts/bootstrap-monorepo.ts`.

It should:

```text
- create directories
- write root config files
- write app package files
- write package shells
- write tsconfig references
- write README
```

Do not make it too clever. It is just a bootstrap helper.

A simple shell alternative:

```bash
mkdir -p apps/{api,web,worker,indexer-cli}/src
mkdir -p packages/{contracts,config,db,github,queue,repo-sync,index-schema,indexer-driver,indexer-ts,index-importer,embedding,retrieval,review-orchestrator,review-engine,llm-gateway,publisher,artifacts,evaluation,memory,observability}/src
mkdir -p scripts infra/docker .github/workflows .vscode
```

Then fill files from templates.

---

## Official references checked

These are the external docs used to verify current recommendations and terminology:

- Bun workspaces: https://bun.com/docs/pm/workspaces
- Bun TypeScript support: https://bun.com/docs/typescript
- Bun tsconfig paths: https://bun.com/docs/guides/runtime/tsconfig-paths
- Bun environment variables: https://bun.com/docs/runtime/environment-variables
- pnpm workspaces: https://pnpm.io/workspaces
- pnpm workspace file: https://pnpm.io/pnpm-workspace_yaml
- pnpm catalogs: https://pnpm.io/catalogs
- Turborepo docs: https://turborepo.dev/docs
- TypeScript project references: https://www.typescriptlang.org/docs/handbook/project-references.html
- TypeScript incremental builds: https://www.typescriptlang.org/tsconfig/incremental.html
- Biome formatter/linter: https://biomejs.dev/
- Vitest projects/workspace: https://vitest.dev/guide/projects
- Docker Compose file reference: https://docs.docker.com/reference/compose-file/
- GitHub Actions workflow syntax: https://docs.github.com/actions/using-workflows/workflow-syntax-for-github-actions
- TanStack Start overview: https://tanstack.com/start/latest
