# Heimdall

Heimdall is an automated code review system. The repository is structured as a monorepo with strong service boundaries.

## Repository Layout

```txt
apps/
  web/                    User-facing review dashboard.

services/
  api/                    API and control-plane service.
  workflows/              Temporal workflow definitions and worker service.

workers/
  code-intel/       Clone, diff, parsing, graph, and related-file worker.
  review/           LLM agents, context packing, validation, and ranking worker.
  scanner/          Semgrep, CodeQL, secrets, and deterministic scanner worker.
  publisher/        GitHub and GitLab publishing worker.
  indexer/              Optional high-performance indexer for later.

contracts/
  proto/                   Internal cross-language Protobuf contracts.
  openapi/                 Public and internal HTTP API contracts.
  schemas/                 LLM and event JSON schemas.
  generated/               Generated Go, TypeScript, and Python contract outputs.

packages/
  ts-api-client/            Typed frontend API client.
  ui/                       Shared frontend UI components.

infra/
  docker/                  Container definitions.
  k8s/                     Kubernetes base manifests and overlays.
  terraform/               Cloud infrastructure modules and environments.
  temporal/                Task queue and worker configuration.
  migrations/              Database migrations.

tools/
  scripts/                 Reusable repository automation scripts.
  dev/                     Local development helpers.
  ci/                      CI-only helpers.

docs/
  architecture/            System design and pipeline documentation.
  decisions/               Architecture decision records.
  runbooks/                Operational response guides.

tests/
  fixtures/                Repository, diff, and provider fixtures.
  integration/             Cross-service integration tests.
  evals/                   Review-quality evaluation datasets and runners.
```

## Boundary Rules

- `apps/` contains user-facing applications only.
- `services/` contains durable backend and control-plane services.
- `workers/` contains asynchronous execution pools.
- `contracts/` defines shared API, event, model, and generated contract artifacts.
- `packages/` contains frontend-only shared packages unless a future package has a documented owner.
- `infra/` contains deployment and environment setup.
- `tests/` contains integration fixtures and review-quality evals.

Keep service and worker boundaries explicit. Do not let the web app invent its own versions of review runs, diffs, context bundles, findings, or provider references.

## Review Pipeline

```txt
apps/web
  User selects a repository and change request.

services/api
  Creates a review run, stores state, and starts a workflow.

services/workflows
  Orchestrates durable review steps.

workers/code-intel
  Clones the repository, parses the diff, builds code graph context, and finds related files.

workers/scanner
  Runs deterministic static-analysis and secret-scanning tools.

workers/review
  Builds context bundles, runs reviewer agents, validates findings, deduplicates findings, and ranks output.

services/api
  Serves review state and findings back to the web app.

workers/publisher
  Publishes approved comments back to GitHub or GitLab.
```

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
