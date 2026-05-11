# 0001: Use A Service-Boundary Monorepo

## Status

Accepted

## Decision

Use a monorepo with explicit top-level boundaries for apps, services, workers, contracts, packages, infrastructure, tools, documentation, tests, and evals.

## Rationale

The product has several different execution modes: user-facing web UI, API control plane, durable orchestration, repository analysis, deterministic scanning, LLM review, and provider publishing. Top-level folders make those boundaries visible early.

## Consequences

- `apps/` contains user-facing applications.
- `services/` contains durable backend services.
- `workers/` contains asynchronous execution pools.
- `contracts/` defines cross-boundary language.
- Cross-language implementations can evolve without forcing the whole repository into one runtime.
