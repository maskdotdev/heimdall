# 0. Core contracts and shared types

This is the foundation. Everything else depends on it.

Implement shared schemas/types for:

```text
Org
User
Repository
Installation
PullRequestSnapshot
ChangedFile
ChangedSymbol
CodeIndexVersion
IndexManifest
IndexRecord
FileRecord
SymbolRecord
EdgeRecord
ChunkRecord
ContextBundle
ReviewRun
CandidateFinding
ValidatedFinding
PublishedFinding
FindingOutcome
RepoRule
MemoryFact
LLMCall
UsageEvent
```

Core package:

```text
/packages/contracts
```

Responsibilities:

```text
- Zod/TypeBox schemas
- TypeScript types
- validation helpers
- stable enum definitions
- API request/response contracts
- job payload contracts
- re-export public index artifact contracts from @repo/index-schema
```

This is the thing that keeps the system clean.

Important boundary:

```text
@repo/contracts owns app-wide domain contracts.
@repo/index-schema owns artifact-specific manifest/record schemas and validation.
```

Do not define independent index artifact schemas in both packages.

---

# 1. Monorepo and build system

Implement the workspace structure.

```text
/apps
  /web
  /api
  /worker
  /indexer-cli

/packages
  /contracts
  /db
  /github
  /queue
  /repo-sync
  /index-schema
  /indexer-driver
  /indexer-ts
  /index-importer
  /embedding
  /retrieval
  /review-orchestrator
  /review-engine
  /llm-gateway
  /publisher
  /artifacts
  /memory
  /observability
  /config
```

Required pieces:

```text
- package manager setup
- TypeScript config
- linting
- testing
- formatting
- shared env config
- local Docker Compose
- CI checks
- migration commands
```

---

# 2. Database layer

Implement the persistence layer.

Core tables:

```text
orgs
users
github_installations
repositories
repository_settings
repo_index_versions
indexed_files
symbols
code_edges
code_chunks
code_chunk_embeddings
pull_requests
review_jobs
review_runs
review_artifacts
candidate_findings
published_findings
finding_outcomes
repo_rules
memory_facts
llm_calls
usage_events
webhook_events
audit_logs
```

Responsibilities:

```text
- Drizzle schema
- migrations
- indexes
- transaction helpers
- repository access layer
- idempotency helpers
- pgvector setup
- query helpers for retrieval
```

MVP storage:

```text
Postgres + pgvector
```

---

# 3. GitHub App integration

Implement the GitHub-facing product integration.

Required pieces:

```text
- GitHub App creation/config
- installation callback handling
- installation token generation
- repo discovery
- permission validation
- PR diff fetching
- branch/commit metadata fetching
- changed file fetching
- inline comment publishing
- PR summary publishing
- check run publishing
- reaction/reply webhook handling
```

Package:

```text
/packages/github
```

Core interface:

```ts
interface GitProvider {
  fetchPullRequestSnapshot(input: PRRef): Promise<PullRequestSnapshot>;
  postInlineComment(input: InlineComment): Promise<void>;
  postReviewSummary(input: ReviewSummary): Promise<void>;
  createOrUpdateCheckRun(input: CheckRunInput): Promise<void>;
}
```

Start GitHub-only. Keep the interface generic enough for GitLab later.

---

# 4. Webhook ingestion

Implement the webhook entrypoint.

Required pieces:

```text
- Elysia webhook route
- signature verification
- event normalization
- event persistence
- idempotency by delivery ID
- routing by event type
- enqueueing follow-up jobs
- error handling
- dead-letter behavior
```

Events to support first:

```text
installation.created
installation.deleted
installation_repositories.added
installation_repositories.removed
pull_request.opened
pull_request.synchronize
pull_request.reopened
pull_request.closed
pull_request_review_comment.created
pull_request_review_comment.edited
pull_request_review_comment.deleted
issue_comment.created
```

Output of this layer should be jobs, not business logic.

---

# 5. API server

Implement the control-plane API.

Required pieces:

```text
- auth/session handling
- org selection
- repo listing
- repo enable/disable
- repo settings
- rule management
- review run listing
- review run detail
- finding history
- memory/rule visibility
- debug artifact access
- billing/usage endpoints if needed
```

App:

```text
/apps/api
```

Stack:

```text
Elysia + Bun
```

Important: the API should not run long indexing or review jobs. It should enqueue work and expose status.

---

# 6. Web dashboard

Implement the user-facing dashboard.

App:

```text
/apps/web
```

Stack:

```text
TanStack Start
TanStack Router
TanStack Query
Tailwind
```

Pages/components:

```text
- login/install page
- org switcher
- repositories list
- repository settings
- review history
- review run detail
- finding detail
- ignored paths
- custom rules
- memory facts
- usage/cost view
- debug view for retrieved context
- admin page
```

MVP dashboard can be simple, but you need enough UI to configure repos and inspect reviews.

---

# 7. Job queue and orchestration

Implement async job handling.

MVP stack:

```text
BullMQ + Redis
```

Core queues:

```text
github.sync
repo.index
repo.index.incremental
embedding.batch
pr.review
review.publish
memory.update
usage.record
```

Required pieces:

```text
- typed job payloads
- job deduplication
- retry policies
- concurrency limits
- rate-limit handling
- dead-letter handling
- job status tracking
- worker health checks
- graceful shutdown
```

Important jobs:

```ts
syncInstallation
indexRepoCommit
embedCodeChunks
reviewPullRequest
publishReview
updateMemoryFromFeedback
```

---

# 8. Repo sync and workspace manager

Implement secure repo checkout.

Package:

```text
/packages/repo-sync
```

Required pieces:

```text
- bare repo mirror cache
- authenticated fetch using GitHub App tokens
- checkout exact commit SHA
- temporary worktree creation
- worktree cleanup
- disk quota enforcement
- timeout enforcement
- path normalization
- ignored path filtering
- generated file detection
- large file skipping
```

Core flow:

```text
fetch repo mirror
  -> checkout commit SHA into isolated worktree
  -> pass workspace path to indexer/reviewer
  -> cleanup after job
```

Performance-critical piece.

---

# 9. Indexer boundary

Implement the replaceable indexer abstraction.

Package:

```text
/packages/indexer-driver
```

Required pieces:

```text
- Indexer interface
- TypeScriptIndexerDriver
- CliIndexerDriver
- RemoteIndexerDriver placeholder
- timeout handling
- artifact path handling
- manifest validation
- stderr/stdout capture
- indexing metrics
```

Core contract:

```ts
interface Indexer {
  index(request: IndexRequest): Promise<IndexResult>;
}
```

The rest of the system should call the driver, not parser internals.

---

# 10. Index artifact schema

Implement the versioned artifact format.

Package:

```text
/packages/index-schema
```

Artifacts:

```text
index-manifest.json
records.jsonl
```

Record types:

```text
file
symbol
edge
chunk
diagnostic
dependency
route
test_mapping
```

Required pieces:

```text
- schema versioning
- manifest validation
- JSONL parser
- JSONL writer
- artifact diffing
- compatibility checks
- fixture generation
```

This is what lets you replace the indexer later.

---

# 11. TypeScript indexer implementation

Implement the first real indexer.

Package:

```text
/packages/indexer-ts
```

App wrapper:

```text
/apps/indexer-cli
```

Required pieces:

```text
- file walker
- language detection
- ignored/generated file skipping
- tree-sitter parsing
- symbol extraction
- import/export extraction
- basic call/reference extraction
- chunk generation
- content hashing
- stable ID generation
- diagnostic emission
- JSONL artifact writing
```

Initial languages:

```text
TypeScript
JavaScript
Python
```

Later:

```text
Go
Rust
Java
```

---

# 12. Index importer

Implement the layer that imports artifacts into storage.

Package:

```text
/packages/index-importer
```

Responsibilities:

```text
- read manifest
- validate records
- create repo_index_version
- upsert files
- upsert symbols
- upsert edges
- upsert chunks
- detect unchanged content hashes
- queue embedding jobs for new chunks
- mark index version complete
- store artifact URI
```

Important: the indexer should not write directly to the DB. The importer owns storage.

---

# 13. Embedding pipeline

Implement embedding generation separately from indexing.

Package:

```text
/packages/embedding
```

Required pieces:

```text
- select chunks needing embeddings
- batch chunks
- call embedding model
- retry failed requests
- cache by content hash
- write to pgvector
- track cost/usage
- handle provider limits
```

Later upgrades:

```text
- Qdrant adapter
- hybrid sparse/dense search
- local embedding model support
- per-language embedding strategies
```

---

# 14. Retrieval engine

Implement context assembly.

Package:

```text
/packages/retrieval
```

Required pieces:

```text
- changed file lookup
- changed symbol detection
- same-file context retrieval
- import/dependency retrieval
- caller/callee retrieval
- related test retrieval
- semantic vector search
- similar pattern search
- repo rule retrieval
- memory fact retrieval
- context ranking
- context budget management
```

Output:

```ts
ContextBundle
```

This is one of the most important pieces of the whole system.

---

# 15. PR snapshot and diff model

Implement PR normalization.

Could live in:

```text
/packages/github
/packages/review-engine
/packages/contracts
```

Required pieces:

```text
- normalized PullRequestSnapshot
- unified diff parser
- changed file model
- changed line model
- diff hunk model
- line anchoring model
- base/head SHA tracking
- merge-base tracking
- patch size limits
- binary file handling
- renamed file handling
- deleted file handling
```

This enables correct line comments.

---

# 16. Review orchestrator

Implement the high-level review pipeline.

Package/app:

```text
/apps/worker
/packages/review-engine
```

Responsibilities:

```text
- receive review job
- fetch PR snapshot
- ensure base/head indexed
- extract change set
- retrieve context
- run review passes
- collect candidate findings
- validate/rank/dedupe
- store artifacts
- enqueue publish job
```

Core function:

```ts
async function reviewPullRequest(job: ReviewPRJob): Promise<ReviewRun>
```

This should be deterministic and artifact-driven.

---

# 17. LLM gateway

Implement model access behind one package.

Package:

```text
/packages/llm-gateway
```

Required pieces:

```text
- provider abstraction
- model routing
- structured output helper
- prompt versioning
- request caching
- retries
- rate-limit handling
- token counting
- cost tracking
- redaction
- prompt/response logging
- timeout handling
```

Capabilities:

```text
- summarize code
- summarize PR
- generate candidate findings
- judge findings
- rerank context
- classify feedback
```

Do not scatter direct model calls across the codebase.

---

# 18. Review passes

Implement specialized review logic.

Package:

```text
/packages/review-engine
```

Passes:

```text
- PR summary pass
- correctness pass
- security pass
- test coverage pass
- performance pass
- architecture/pattern consistency pass
- regression risk pass
- finding judge pass
```

Each pass should return structured candidate findings.

```ts
type ReviewPass = {
  name: string;
  run(input: ReviewInput): Promise<CandidateFinding[]>;
};
```

Avoid one giant “review this PR” prompt.

---

# 19. Finding validation, dedupe, and ranking

Implement the quality gate before publishing.

Package:

```text
/packages/review-engine
```

Required checks:

```text
- line is in diff
- file exists
- finding references real code
- evidence exists
- not duplicate
- not contradicted by context
- not style-only
- not suppressed by repo rule
- not previously rejected by memory
- confidence above threshold
- severity worth publishing
- max comments per PR
```

Outputs:

```text
validated_findings
rejected_findings with rejection reasons
```

This is what prevents the bot from becoming noisy.

---

# 20. Publisher

Implement GitHub publishing.

Package:

```text
/packages/publisher
```

Required pieces:

```text
- convert finding to GitHub inline comment
- map line to diff position
- create grouped PR review
- create/update check run
- post PR summary
- avoid reposting duplicate comments
- update previous bot comments if needed
- handle outdated comments
- handle GitHub rate limits
- store published comment IDs
```

Publishing modes:

```text
- summary only
- inline comments only
- check run only
- inline + summary
```

---

# 21. Feedback and memory system

Implement learning from user behavior.

Package:

```text
/packages/memory
```

Inputs:

```text
- comment replies
- comment reactions
- resolved comments
- dismissed comments
- commits after comments
- explicit user rules
- ignored findings
```

Required pieces:

```text
- finding outcome classification
- memory fact creation
- suppression rules
- repo-specific preferences
- team-level preferences
- memory retrieval
- memory expiration
- memory auditability
```

Examples of memory facts:

```text
- Ignore generated files under src/generated.
- Do not comment on import ordering.
- This repo uses custom auth middleware.
- Prefer comments only for correctness/security issues.
```

Keep this explicit and inspectable.

---

# 22. Repo rules and configuration

Implement rule management.

Required settings:

```text
- enabled/disabled repo
- review mode
- max comments per PR
- severity threshold
- ignored paths
- ignored authors
- ignored labels
- review only when label exists
- skip generated files
- custom repo rules
- language-specific settings
- model/provider settings
```

Rules should feed retrieval and validation.

---

# 23. Static analysis integration

Implement optional deterministic checks.

Initial tools:

```text
eslint
tsc
ruff
mypy/pyright
semgrep
go vet
cargo check
```

Required pieces:

```text
- tool runner
- workspace command detection
- timeout handling
- dependency install policy
- safe execution sandbox
- parse tool output
- map diagnostics to findings
- merge tool findings with LLM findings
```

MVP can skip most of this, but long-term it matters.

---

# 24. Sandbox execution

Implement safe command execution if you run tools.

Required pieces:

```text
- isolated filesystem
- no broad network access
- CPU/memory limits
- timeout limits
- environment scrubbing
- secret redaction
- dependency install restrictions
- cleanup
```

This becomes important if you run project commands like tests, linters, or type checks.

---

# 25. Observability

Implement logs, metrics, and traces.

Package:

```text
/packages/observability
```

Required pieces:

```text
- structured logs
- request IDs
- review run IDs
- job IDs
- OpenTelemetry traces
- queue metrics
- LLM latency/cost metrics
- indexing latency metrics
- retrieval latency metrics
- publishing metrics
- failure dashboards
```

Useful metrics:

```text
- time to first review
- index time by repo size
- embedding cost by repo
- review cost by PR
- comments per PR
- acceptance rate
- rejection rate
- false-positive reports
```

---

# 26. Evaluation harness

Implement a way to test review quality.

Split:

```text
26A. MVP evaluation gate
26B. Advanced evaluation system
```

`26A` ships with the first production MVP and is summarized in #31. `26B` adds production import, human labeling UI, live-model scheduled runs, and external eval integrations.

Required pieces:

```text
- fixture repositories
- fixture PRs
- expected findings
- golden context bundles
- prompt regression tests
- indexer output snapshots
- retrieval quality tests
- finding validation tests
- human feedback labels
```

This is essential if you want to improve without guessing.

Outputs:

```text
- precision
- recall
- comment usefulness
- false-positive rate
- cost per review
- latency per review
```

---

# 27. Security and compliance layer

Implement security basics from the beginning.

Split:

```text
27A. MVP security baseline
27B. Compliance hardening
```

`27A` ships with the first production MVP. `27B` covers later compliance and enterprise posture.

Required pieces:

```text
- GitHub webhook signature verification
- least-privilege GitHub permissions
- token encryption
- secret redaction
- tenant isolation
- audit logs
- data retention policy
- prompt/code logging controls
- access control
- admin roles
- SSO-ready user model
```

Later:

```text
- SAML/SSO
- SOC2 controls
- self-hosted deployment
- bring-your-own-model
- VPC deployment
```

---

# 28. Usage and billing

Implement usage tracking even before charging.

Required pieces:

```text
- org usage events
- repo usage events
- PR review count
- indexed LOC/chunks
- embedding tokens
- review tokens
- model cost
- storage cost estimates
- monthly usage rollups
```

Billing later:

```text
- Stripe integration
- plans
- usage limits
- overage handling
- invoices
```

Even if billing is not MVP, usage tracking should be.

---

# 29. Admin/internal tooling

Implement internal debugging tools.

Required pieces:

```text
- inspect review run
- inspect PR snapshot
- inspect context bundle
- inspect prompts/responses
- inspect rejected findings
- replay review
- rerun retrieval
- rerun indexer
- compare index artifacts
- manually suppress finding class
```

This will save you enormous time.

---

# 30. Deployment and infrastructure

Implement production infrastructure.

MVP infra:

```text
- API service
- worker service
- web service
- Postgres
- Redis
- object storage
- secrets manager
- logs/metrics
```

Required pieces:

```text
- Dockerfiles
- Docker Compose for local dev
- environment management
- migrations on deploy
- health checks
- autoscaling workers
- queue depth scaling
- backup policy
- rollback strategy
```

Scale-up infra:

```text
- specialized worker pools
- Qdrant
- Temporal
- Kubernetes or ECS
- separate indexing service
- separate embedding worker pool
```

---

# 31. Testing and evaluation strategy

Implement tests and the first evaluation harness together. This is an MVP quality gate, not a later analytics project.

Required tests:

```text
- contract/schema tests
- DB migration tests
- GitHub webhook tests
- GitHub publishing tests with mocks
- indexer fixture tests
- artifact importer tests
- retrieval tests
- review-engine tests
- finding validator tests
- queue/job tests
- end-to-end fake PR tests
- evaluation fixture tests
- baseline comparison tests
```

Especially important:

```text
- line anchoring tests
- duplicate comment prevention tests
- idempotent job tests
- index artifact compatibility tests
- no-finding regression tests
- prompt-injection fixture tests
```

Required MVP evaluation pieces:

```text
- /packages/evaluation package
- 10-20 curated fixture PR cases
- fake LLM replay for deterministic CI
- retrieval grader
- line-anchor grader
- validation/ranking grader
- cost/latency summary
- markdown/json reports
- CI gates against a checked-in baseline
```

The detailed evaluation system lives in #26, but this MVP subset ships before production.

---

# 31A. Artifact store foundation

Create a shared artifact storage package before review orchestration starts storing large intermediate data.

Package:

```text
/packages/artifacts
```

Responsibilities:

```text
- ArtifactStore interface
- local filesystem implementation for dev/test
- S3/object-storage implementation for staging/prod
- ArtifactRef helpers and metadata validation
- content hashing and byte-size checks
- redaction/classification metadata
- tenant-scoped object key builder
- signed URL authorization hooks
- retention/deletion manifest helpers
```

This package is used by:

```text
review-orchestrator
indexer-driver/index-importer
llm-gateway
static-analysis/sandbox later
evaluation
admin tooling
```

Do not let each phase invent its own artifact storage abstraction.

---

# 32. CLI/dev tools

Implement developer utilities.

Useful commands:

```text
dev index <repo-path>
dev import-artifact <artifact-path>
dev review-pr <fixture>
dev retrieve-context <repo> <file> <line>
dev replay-review <review-run-id>
dev compare-indexes <artifact-a> <artifact-b>
dev validate-artifact <artifact-path>
```

These make the system much easier to debug.

---

# 33. Optional GitLab/Bitbucket provider layer

Not MVP, but architect for it.

Required later:

```text
- provider-neutral GitProvider interface
- GitLab webhook adapter
- GitLab PR/MR snapshot fetching
- GitLab inline comments
- Bitbucket adapter if needed
```

Do not implement this early, but avoid GitHub-specific concepts leaking everywhere.

---

# 34. Optional high-performance indexer replacement

This is not MVP, but design for it.

Potential implementations:

```text
- Rust CLI indexer
- Go CLI indexer
- remote indexing service
- language-specific analyzers
- incremental indexer
```

Required boundary:

```text
repo workspace path
  -> indexer
  -> index artifact
  -> importer
```

As long as this boundary exists, replacing the indexer stays manageable.

---

# Suggested MVP cut

For the first real version, I’d implement these first:

```text
0. Core contracts
1. Monorepo/build system
2. Database layer
3. GitHub App integration
4. Webhook ingestion
5. API server
6. Basic dashboard
7. Job queue
8. Repo sync
9. Indexer boundary
10. Index artifact schema
11. TypeScript indexer
12. Index importer
13. Embedding pipeline
14. Retrieval engine
15. PR snapshot/diff model
16. Review orchestrator
16A. Artifact store foundation
17. LLM gateway
18. Review passes
19. Finding validation
20. Publisher
25. Observability
26A. Evaluation harness MVP
27A. Security baseline
29. Internal tooling
30. Deployment
31. Testing
```

The later sections can wait:

```text
21. Feedback/memory
22. Advanced repo rules
23. Static analysis
24. Sandbox execution
26B. Advanced evaluation harness
27B. Compliance hardening
28. Billing
33. GitLab/Bitbucket
34. High-performance indexer replacement
```

The clean way to think about the whole product:

```text
GitHub integration
  -> repo snapshot
  -> index artifact
  -> imported code intelligence
  -> retrieved context
  -> structured review findings
  -> validation/ranking
  -> published comments
  -> feedback/memory
```
