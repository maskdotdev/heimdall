# Architecture Overview

Heimdall uses a monorepo with service, worker, contract, infrastructure, and test boundaries.

## Main Components

```txt
apps/web
  Review dashboard for repositories, change requests, review runs, findings, diff views, and settings.

services/api
  API and control-plane service. Owns authentication, provider ingress, repository and change request APIs, review-run lifecycle commands, findings APIs, and publishing commands.

services/workflows
  Durable workflow service. Owns Temporal workflow definitions, activities, task queues, payload conversion, and workflow tests.

workers/code-intel
  Repository intelligence worker. Owns clone, fetch, diff parsing, language detection, code graph construction, changed symbol detection, dependency frontier detection, and related test detection.

workers/scanner
  Deterministic scanner worker. Owns Semgrep, CodeQL, secret scanning, rulesets, parser adapters, and scanner finding normalization.

workers/review
  Review intelligence worker. Owns context bundle assembly, reviewer agents, model provider gateways, structured output validation, finding ranking, finding deduplication, and review-quality logic.

workers/publisher
  Publishing worker. Owns provider-specific comment formatting, inline comments, summary comments, existing comment updates, rate limits, and backoff.

workers/indexer
  Optional later high-performance indexer. Owns large-repository indexing, fast symbol extraction, dependency graph construction, and high-throughput source scanning when Python is not enough.

contracts
  Shared language for repository references, change requests, diffs, code graphs, context bundles, findings, review runs, events, and publishable reviews.

packages
  Frontend support packages such as `ts-api-client` and `ui`.
```

## Dependency Direction

```txt
apps/web -> packages/ts-api-client -> contracts/generated
services/* -> contracts
workers/* -> contracts
contracts -> no runtime app, service, or worker dependency
infra/tools/docs/tests -> no runtime application ownership
```

Use contracts for data that crosses service or worker boundaries. Do not let services and workers each invent local versions of a finding, diff, context bundle, or review event.
