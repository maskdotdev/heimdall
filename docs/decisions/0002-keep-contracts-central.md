# 0002: Keep Contracts Central

## Status

Accepted

## Decision

Shared data shapes belong in `contracts/`. Generated outputs belong under `contracts/generated`.

## Rationale

Review findings, diffs, review runs, provider references, context bundles, and code graph data need one source of truth. Multiple local versions of these shapes would make validation and publishing unsafe.

## Consequences

- The web app, API service, workflow service, and workers should share generated contract types.
- Contract generation must be checked for drift in CI once generation is added.
- Services and workers must not bypass contracts for cross-boundary payloads.
