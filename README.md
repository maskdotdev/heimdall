# Heimdall

Heimdall is a TypeScript monorepo for automated code review. The repository is organized around service boundaries, shared contracts, review orchestration, repository intelligence, and deterministic validation.

## Repository Layout

```txt
apps/
  web/        User-facing review dashboard.
  api/        API and control-plane boundary.
  worker/     Background review pipeline boundary.

packages/
  contracts/        Shared TypeScript request, event, review, diff, VCS, and code graph types.
  agents/           Reviewer implementations and prompt assembly.
  review-engine/    Orchestration, validation, ranking, and reporting.
  context-builder/  Review context construction.
  repo-intel/       Repository analysis and code graph helpers.
  git/              Git operations and diff helpers.
  vcs/              Provider abstractions and normalization.
  persistence/      Storage repositories.
  security/         Permission, redaction, and token boundaries.
  standards/        Review standard extraction and storage.
  observability/    Logging, metrics, tracing, and eval telemetry.
  ts-api-client/    Future generated or handwritten frontend API client.
  ui/               Future shared UI primitives.

contracts/
  proto/       Future cross-language Protobuf contracts.
  openapi/     Future public and internal HTTP API contracts.
  schemas/     JSON schemas for LLM and event payload validation.
  generated/   Generated contract outputs.

infra/
  docker/      Local and deployable container definitions.
  k8s/         Production Kubernetes manifests.
  terraform/   Cloud infrastructure modules and environments.
  temporal/    Workflow/task-queue configuration.
  migrations/  Database migrations.

tests/
  fixtures/     Repository, diff, and provider payload fixtures.
  integration/  Cross-boundary integration tests.
  evals/        Review-quality evaluation datasets and runners.

docs/
  architecture/  System design and pipeline documentation.
  decisions/     Architecture decision records.
  runbooks/      Operational response guides.

tools/
  scripts/  Repository automation scripts.
  dev/      Local development helpers.
  ci/       CI-only helpers.
```

## Boundary Rules

- App code may depend on package code.
- Package code must not depend on app code.
- Shared data shapes belong in `packages/contracts` today and in `contracts/` when generated cross-language contracts are introduced.
- LLM output is untrusted and must be validated before persistence or publishing.
- Secrets, tokens, private keys, and unredacted provider payloads must not be logged.

## Documentation Entry Points

- [Architecture overview](docs/architecture/overview.md)
- [Review pipeline](docs/architecture/review-pipeline.md)
- [Context bundle](docs/architecture/context-bundle.md)
- [Finding validation](docs/architecture/finding-validation.md)
- [Code intelligence](docs/architecture/code-intelligence.md)
- [VCS integration](docs/architecture/vcs-integration.md)
- [Sandboxing](docs/architecture/sandboxing.md)
- [Scaling](docs/architecture/scaling.md)
- [Tech stack](docs/tech-stack.md)

