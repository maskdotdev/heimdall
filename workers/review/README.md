# Review Worker

The review worker owns LLM and review-quality logic.

Expected ownership:

- Prompting.
- Model calls.
- Context packing.
- Structured output validation.
- Finding ranking.
- Finding deduplication.
- Review-standard extraction.
- Review-quality telemetry.

Do not publish provider comments from this worker. Publishing belongs in `workers/publisher`.

## Reviewer Backends

Select a backend with `HEIMDALL_REVIEW_PROVIDER`.

- `fake`: deterministic local backend for tests.
- `openai-chat`: OpenAI-compatible Chat Completions backend with structured output schema enforcement.
- `openai-compatible`: alias for `openai-chat`.
- `codex-app-server`: experimental Codex app-server backend over stdio.

The `codex-app-server` backend starts `codex app-server`, initializes JSON-RPC, starts a thread, and asks Codex to
return a Heimdall `ReviewerOutput` JSON object. Configure it with:

- `HEIMDALL_CODEX_APP_SERVER_COMMAND`, default `codex app-server`.
- `HEIMDALL_CODEX_APP_SERVER_MODEL`, default `gpt-5.5`.
- `HEIMDALL_CODEX_APP_SERVER_REASONING_EFFORT`, default `low`.
- `HEIMDALL_CODEX_APP_SERVER_CWD`, optional process working directory.
- `HEIMDALL_CODEX_APP_SERVER_TIMEOUT_SECONDS`, default `300`.

Use `pnpm review:live --backend codex-app-server --case docs-only` for opt-in live backend checks. Live runs write
artifacts under `tests/evals/live-runs` by default and are intentionally not part of `pnpm check`.
