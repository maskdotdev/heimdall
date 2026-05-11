# Scaling

Heimdall should scale by separating control-plane work from heavy background work.

## MVP

- `apps/web` handles the dashboard.
- `services/api` handles control-plane requests.
- `services/workflows` handles durable orchestration.
- `workers/code-intel` handles repository analysis.
- `workers/review` handles LLM review work.
- `contracts` defines shared system language.
- `tests/evals` tracks review quality.

## Later

- Add `workers/scanner` for Semgrep, CodeQL, and secret scanning.
- Add `workers/publisher` when publishing needs separate rate-limit handling.
- Add `workers/indexer` only when indexing throughput requires it.
- Add Kubernetes, Terraform, and production Temporal configuration under `infra/`.
