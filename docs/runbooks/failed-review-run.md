# Failed Review Run

Use this when a review run ends in a failed state.

## Checks

1. Confirm the review run ID and repository/change request identifiers.
2. Check API logs for authorization, webhook, or queue dispatch failures.
3. Check worker logs for clone, diff, context, reviewer, validation, or persistence failures.
4. Confirm no secrets or raw provider payloads were logged.
5. Inspect persisted artifacts only after confirming permission scope.

## Common Causes

- Provider token expired or missing required permission.
- Repository clone failed.
- Diff payload could not be normalized.
- Context bundle exceeded configured limits.
- Finding validation rejected all reviewer output.

