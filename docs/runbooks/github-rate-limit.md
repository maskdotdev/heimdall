# GitHub Rate Limit

Use this when GitHub API calls or publishing operations are throttled.

## Checks

1. Identify the installation, repository, and operation type.
2. Separate read operations from comment publishing operations.
3. Check whether retries are respecting provider reset windows.
4. Confirm duplicate comment updates are not being retried unnecessarily.
5. Avoid logging raw provider payloads while debugging.

## Mitigations

- Back off publishing jobs.
- Batch comment updates where provider APIs allow it.
- Prefer updating existing comments over creating duplicates.
- Defer noncritical repository sync work.

