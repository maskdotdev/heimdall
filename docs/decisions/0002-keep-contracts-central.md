# 0002: Keep Contracts Central

## Status

Accepted

## Decision

Shared data shapes belong in `packages/contracts` for the TypeScript MVP. Cross-language contract sources and generated outputs belong under top-level `contracts/` when introduced.

## Rationale

Review findings, diffs, review runs, provider references, and code graph data need one source of truth. Multiple local versions of these shapes would make validation and publishing unsafe.

## Consequences

- API, worker, and review packages should share contract types.
- Generated contracts must be checked for drift in CI once generation is added.

