# High LLM Cost

Use this when model spend or token volume is unexpectedly high.

## Checks

1. Compare review-run count, model calls, prompt tokens, and completion tokens.
2. Inspect context bundle sizes and changed-file counts.
3. Check whether generated, vendored, or lock files are being included.
4. Verify reviewer agents are not retrying validation failures without changes.
5. Review eval jobs separately from production review jobs.

## Mitigations

- Tighten context limits.
- Suppress generated and vendored files.
- Reduce redundant reviewer passes.
- Add deterministic scanner signals before model calls where appropriate.

