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

Live reviewer runs are opt-in because they may call external model or agent backends. Run them with
`pnpm review:live --backend fake` or `pnpm review:live --backend codex-app-server`. Live runs write raw
reviewer output, validated findings, and comparison summaries under `evals/live-runs` unless you pass `--out`.

Martian Code Review Bench runs are also opt-in. The runner ingests Martian offline `golden_comments/`
or `results/benchmark_data.json`, builds Heimdall context bundles from local `<case-id>.diff` files, and
can explicitly fetch PR diffs from GitHub with `--fetch-diffs`. Default tests cover the adapter with local
fixtures only.

Cache selected PR diffs before a larger run so reruns are repeatable and do not depend on GitHub availability:

```bash
pnpm review:martian --backend fake \
  --golden-dir ../code-review-benchmark/offline/golden_comments \
  --cache-diff-dir tests/evals/martian-diffs \
  --cache-diffs-only \
  --limit 5
```

```bash
pnpm review:martian --backend fake \
  --golden-dir ../code-review-benchmark/offline/golden_comments \
  --cache-diff-dir tests/evals/martian-diffs \
  --match-mode unjudged
```

Use `--match-mode judgments --judgments path/to/judgments.json` to compute Martian-style precision and
recall from semantic candidate/golden judgments. The runner always writes candidate/golden pairs so a
separate LLM judge can score semantic matches without making judge calls part of default checks.
`--match-mode lexical` is available for local smoke tests, but it is not Martian-comparable.
For a small opt-in judged smoke, pass `--judge codex-app-server`; this generates semantic judgments with
the Codex app-server backend, writes `judgments.json`, and reports precision and recall. Override the judge
model or timeout with `HEIMDALL_MARTIAN_JUDGE_MODEL`, `HEIMDALL_MARTIAN_JUDGE_REASONING_EFFORT`, and
`HEIMDALL_MARTIAN_JUDGE_TIMEOUT_SECONDS`.

Runs resume by default when `--out` points at existing successful `comparison.json` artifacts. Failed cases
are retried. Use `--force` to rerun successful cases, `--no-resume` to disable artifact skipping, and
`--max-judge-pairs` to cap candidate/golden judge calls per case. Use `--max-run-seconds` to stop scheduling
new cases after a wall-clock budget. Each run writes `run-metadata.json`, per-case `comparison.json`,
`summary.json`, and `aggregate.json`.
