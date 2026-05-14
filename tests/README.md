# Tests And Evals

Heimdall needs normal tests and review-quality evals.

```txt
fixtures/     Repositories, diffs, provider payloads, and expected review comments.
integration/  Cross-boundary tests for API, worker, VCS, and packages.
evals/        Golden review cases, expected findings, and scoring runners.
```

Review-quality evals should track true positives, false positives, missed issues, severity calibration, duplicate findings, unsupported findings, cost, and latency.

The baseline review eval runner is deterministic. It replays saved reviewer-output JSON from `evals/saved-outputs`
against context bundles in `evals/golden-prs`, then compares the validated findings with `evals/expected-findings`.
Run it with `pnpm review:eval`; it also runs as part of `pnpm python:test`.
