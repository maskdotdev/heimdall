# Worker Backlog

Use this when queued review work is delayed.

## Checks

1. Compare queued jobs, active jobs, retries, and failed jobs.
2. Identify whether backlog is clone, code intelligence, review, validation, or publishing work.
3. Check provider rate limits and model-provider latency.
4. Confirm workers are not repeatedly retrying deterministic failures.
5. Review recent deploys or configuration changes.

## Mitigations

- Pause low-priority review runs.
- Increase worker concurrency within resource limits.
- Split heavy work into dedicated queues when necessary.
- Disable nonessential scanner or eval work in production paths.

