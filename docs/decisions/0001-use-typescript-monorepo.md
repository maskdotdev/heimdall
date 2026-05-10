# 0001: Use A TypeScript Monorepo

## Status

Accepted

## Decision

Use a TypeScript monorepo with apps at the boundary and packages for shared behavior.

## Rationale

The current product needs fast iteration across API, worker, contracts, review logic, repository analysis, persistence, and frontend surfaces. A monorepo keeps shared types and tests close while preserving service boundaries through folder and package ownership.

## Consequences

- App code may depend on package code.
- Package code must not depend on app code.
- Cross-language workers can be added later behind contracts and queues.

