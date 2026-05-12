# MVP Plan: Review a Public GitHub PR URL

## Summary

Build the first real Heimdall vertical slice: a user pastes a public GitHub PR URL, Heimdall fetches the PR through the code-intel boundary, runs an LLM review through the review-worker boundary, persists the review run, and shows findings in the web UI.

This MVP is intentionally a stepping stone, not the end state. It must preserve the future architecture by keeping web, API, workflow, code-intel, review, storage, and LLM provider responsibilities behind replaceable boundaries.

## Key Changes

### Monorepo Runtime Scaffold

- Add `pnpm-workspace.yaml` and package scripts for `apps/web`, `packages/ts-api-client`, and root checks.
- Add minimal Go module for `services/api`.
- Add minimal Python packages for `workers/code-intel` and `workers/review`.
- Use `contracts/generated` for all cross-boundary payload types.

### API Control Plane

- Add `POST /api/review-runs/from-url` with body `{ "url": string }`.
- Accept only public GitHub PR URLs for MVP: `https://github.com/{owner}/{repo}/pull/{number}`.
- Add `GET /api/review-runs/{id}` and `GET /api/review-runs/{id}/findings`.
- Persist `Repository`, `ChangeRequest`, `ReviewRun`, `Diff`, and `Finding` payloads.
- Use a storage interface with SQLite first and a Postgres adapter stub sharing the same interface.

### Workflow Boundary

- Add a workflow port in `services/api` with an in-process local implementation for MVP.
- The local workflow runs: parse PR URL, fetch repository/diff, build context, call reviewer, validate findings, persist final state.
- Keep Temporal out of the first runnable slice, but model the workflow/activity boundary so Temporal can replace the local adapter later.

### Code-Intel Worker Boundary

- Implement public GitHub PR acquisition with `git clone/fetch`.
- Resolve PR metadata, base/head refs, changed files, hunks, additions, deletions, and commit SHAs.
- Normalize output into existing repository, change-request, and diff contracts.
- Do not build full symbol graphs yet.

### Review Worker Boundary

- Add a pluggable LLM provider interface.
- Implement an OpenAI-compatible adapter configured by environment variables.
- Add a fake reviewer provider for tests.
- Validate raw reviewer output against `llm/reviewer-output.schema.json`.
- Normalize valid output to persisted `finding.schema.json`.
- Do not publish provider comments in this MVP.

### Web App

- Add a minimal React/Vite page with a PR URL input and submit button.
- Show review-run status, current phase, and resulting findings.
- Use `packages/ts-api-client` and generated TypeScript contracts.
- Keep onboarding, provider auth, settings, and publishing out of scope.

## Future Architecture Guardrails

- The local workflow adapter is temporary. It must expose a clean workflow port so `services/workflows` and Temporal can replace it without changing API, web, code-intel, or review logic.
- SQLite is a local-dev backend, not the production persistence target. Storage code must use repository interfaces that can be backed by Postgres migrations later.
- Public GitHub PR URLs are the first provider path only. VCS logic must stay behind provider/code-intel adapters so GitHub App auth, private repos, GitLab, and webhooks can be added without leaking provider details into review logic.
- `git clone/fetch` in the MVP should live in code-intel ownership, not API handlers. The API may orchestrate locally, but it must not absorb code-intel responsibilities.
- OpenAI-compatible LLM support is the first provider implementation, not the review architecture. Review code must depend on an LLM provider interface and keep fake providers for deterministic tests.
- MVP context building can be diff-only, but the data flow should leave room for future code graph, related tests, scanner signals, and context-packing limits.
- Findings shown in the UI are not publishable comments yet. Publishing remains owned by `workers/publisher` and must be added later through `publish.schema.json`.
- No service should define duplicate local models for review runs, diffs, context bundles, findings, or provider refs. Use generated contracts or explicit boundary conversion.

## Public Interfaces

### `POST /api/review-runs/from-url`

Request:

```json
{
  "url": "https://github.com/owner/repo/pull/123"
}
```

Response: `ReviewRun`

### `GET /api/review-runs/{id}`

Response: `ReviewRun`

### `GET /api/review-runs/{id}/findings`

Response:

```json
{
  "findings": []
}
```

where `findings` is an array of `Finding` contract payloads.

### Environment Variables

- `HEIMDALL_DB_DRIVER=sqlite`
- `HEIMDALL_SQLITE_PATH=.heimdall/dev.db`
- `HEIMDALL_REVIEW_PROVIDER=openai-compatible`
- `HEIMDALL_LLM_BASE_URL`
- `HEIMDALL_LLM_API_KEY`
- `HEIMDALL_LLM_MODEL`

## Test Plan

- Contract gate remains: `pnpm contracts:check`.
- API tests cover PR URL parsing, unsupported URLs, review-run creation, and persisted state transitions.
- Code-intel tests use fixture-backed git repositories and validate normalized contract payloads.
- Review tests use fake LLM output, validate raw reviewer output, reject invalid output, and normalize valid findings.
- Integration test submits a fixture-backed PR URL through the API using fake code-intel/reviewer adapters and asserts a completed review run with findings.
- Web smoke test submits a URL and shows run state plus findings.

## Assumptions

- MVP supports public GitHub PR URLs only.
- MVP uses `git clone/fetch` for PR acquisition.
- MVP uses thin real services with local in-process workflow orchestration, not Temporal yet.
- SQLite is the first runnable backend; Postgres remains the production-direction backend behind the same storage interface.
- LLM review is real for local/manual runs through an OpenAI-compatible adapter, while automated tests use a fake provider.
- Publishing comments, private repo auth, GitHub App setup, scanners, full code graph construction, and multi-provider VCS support are intentionally deferred.
