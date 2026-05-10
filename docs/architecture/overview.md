# Architecture Overview

Heimdall is organized as a TypeScript monorepo with clear app and package boundaries.

The MVP keeps the API, worker, review logic, contracts, repository intelligence, persistence, and provider integrations in TypeScript packages. Future cross-language boundaries can be added under `contracts/` and `infra/` without moving core product concepts out of the monorepo.

## Main Components

```txt
apps/web
  Review dashboard for repositories, change requests, review runs, findings, and settings.

apps/api
  API/control-plane boundary. Owns routes, application use cases, provider ingress, authorization checks, and job dispatch.

apps/worker
  Background pipeline boundary. Owns clone, diff, code graph, context, review, validation, and publishing jobs.

packages/contracts
  Shared TypeScript contracts for repository, VCS, diff, code graph, review run, event, and finding shapes.

packages/review-engine
  Review orchestration, validation, ranking, and report construction.

packages/context-builder
  Context bundle assembly from diffs, code graph data, related tests, standards, and prior comments.

packages/repo-intel
  Language detection, dependency graph, symbol graph, ownership, and test impact helpers.

packages/security
  Redaction, permissions, and token handling.
```

## Dependency Direction

```txt
apps -> packages
packages -> packages/contracts
packages must not depend on apps
```

Use public package exports and `@repo/*` imports when package manifests are present. Avoid deep imports into another package's internals.

