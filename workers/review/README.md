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
- `codex-app-server-agentic`: experimental Codex app-server backend with a read-only repository checkout.

When `HEIMDALL_REVIEW_REPOSITORY_ROOT` points to a checkout, the context builder adds bounded repository exploration
evidence that every backend can use. It scans a capped set of source files for changed identifiers, adds related symbol
snippets, records dependency frontier entries, and links directly related tests. Findings still need to point at changed
code after validation.

The `codex-app-server` backend starts `codex app-server`, initializes JSON-RPC, starts a thread, and asks Codex to
return a Heimdall `ReviewerOutput` JSON object. Configure it with:

- `HEIMDALL_CODEX_APP_SERVER_COMMAND`, default `codex app-server`.
- `HEIMDALL_CODEX_APP_SERVER_MODEL`, default `gpt-5.5`.
- `HEIMDALL_CODEX_APP_SERVER_REASONING_EFFORT`, default `low`.
- `HEIMDALL_CODEX_APP_SERVER_CWD`, optional process working directory.
- `HEIMDALL_CODEX_APP_SERVER_TIMEOUT_SECONDS`, default `300`.
- `HEIMDALL_CODEX_APP_SERVER_MAX_REVIEWS_PER_PROCESS`, default `1`.
- `HEIMDALL_CODEX_APP_SERVER_PROMPT_MAX_FILES`, default `8`.
- `HEIMDALL_CODEX_APP_SERVER_PROMPT_MAX_SNIPPETS`, default `12`.
- `HEIMDALL_CODEX_APP_SERVER_LARGE_PROMPT_CHAR_THRESHOLD`, default `0` (disabled).
- `HEIMDALL_CODEX_APP_SERVER_LARGE_PROMPT_MAX_FILES`, default `4`.

Use `pnpm review:live --backend codex-app-server --case docs-only` for opt-in live backend checks. Live runs write
artifacts under `tests/evals/live-runs` by default and are intentionally not part of `pnpm check`.
