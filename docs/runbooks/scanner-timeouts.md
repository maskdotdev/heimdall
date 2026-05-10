# Scanner Timeouts

Use this when deterministic static-analysis jobs time out.

## Checks

1. Identify scanner type and ruleset.
2. Confirm repository size and changed-file count.
3. Check whether generated, vendored, or dependency directories were scanned.
4. Compare timeout settings with worker resource limits.
5. Confirm timeout output is normalized into a safe review signal.

## Mitigations

- Narrow scanner input to changed or related files.
- Split scanners into dedicated queues.
- Disable expensive rules for MVP paths.
- Record timeout metadata without publishing unsupported findings.

