# Review Pipeline

The review pipeline turns a repository change request into validated findings and optional provider comments.

## Pipeline

```txt
apps/web
  User selects a repository and change request.

services/api
  Creates a review run.
  Stores state in Postgres.
  Starts a Temporal workflow.

services/workflows
  Orchestrates durable review steps.

workers/code-intel
  Clones the repository.
  Parses the diff.
  Builds code graph context.
  Finds changed symbols and related files.

workers/scanner
  Runs Semgrep, CodeQL, and secret checks when enabled.
  Normalizes scanner output into review signals.

workers/review
  Builds the context bundle.
  Runs reviewer agents.
  Validates, deduplicates, and ranks findings.

services/api
  Serves findings and review-run state back to the web app.

workers/publisher
  Publishes approved comments back to GitHub or GitLab.
```

## Ownership

- `apps/web` owns user-facing workflows.
- `services/api` owns control-plane requests, authorization, persistence ingress, and workflow starts.
- `services/workflows` owns durable orchestration.
- `workers/code-intel` owns repository analysis.
- `workers/scanner` owns deterministic scanner execution.
- `workers/review` owns LLM review intelligence and finding quality.
- `workers/publisher` owns provider publishing behavior.
- `contracts` owns shared data shapes across the system.
