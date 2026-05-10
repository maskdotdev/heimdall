# Review Pipeline

The review pipeline turns a repository change request into validated findings and optional provider comments.

## Pipeline

```txt
apps/web
  User selects a repository and change request.

apps/api
  Creates a review run, stores state, checks permissions, and queues work.

apps/worker
  Runs the background pipeline.

packages/git and packages/vcs
  Fetch repository data and normalize provider-specific change request data.

packages/repo-intel
  Detects languages, parses changed files, builds code graph context, and identifies related tests.

packages/context-builder
  Builds the review context bundle.

packages/agents
  Runs specialized reviewers.

packages/review-engine
  Validates, deduplicates, ranks, and reports findings.

packages/persistence
  Persists review state, artifacts, and findings.

apps/api
  Serves findings and review-run state back to the web app.
```

## Ownership

- `apps/api` owns request authorization and review-run lifecycle commands.
- `apps/worker` owns asynchronous execution.
- `packages/review-engine` owns validation and ranking behavior.
- `packages/security` owns redaction and permission primitives.
- `packages/contracts` owns shared data shapes.

