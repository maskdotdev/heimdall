# 0003: Validate Findings Before Publishing

## Status

Accepted

## Decision

Findings must pass deterministic validation before persistence or provider publication.

## Rationale

Reviewer output may be incomplete, duplicated, unsupported by evidence, or unsafe. Validation protects users from noisy or incorrect automated comments.

## Consequences

- Validation belongs in `packages/review-engine`.
- Tests and evals must cover invalid locations, weak evidence, duplicates, secret exposure, and unsafe suggested fixes.

