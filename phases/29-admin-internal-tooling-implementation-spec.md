# #29 Admin/Internal Tooling Implementation Spec

## 1. Purpose

This document defines the **Admin/Internal Tooling** layer for the code review agent system.

The goal is to make the product **operable, debuggable, replayable, and safe to support** without requiring engineers to manually inspect databases, tail logs, decode GitHub payloads, or reconstruct review runs from scattered artifacts.

This section builds on the previous implementation areas:

```text
#0  Core contracts and shared types
#1  Monorepo and build system
#2  Database layer
#3  GitHub App integration
#4  Webhook ingestion
#5  API server
#6  Web dashboard
#7  Job queue and orchestration
#8  Repo sync and workspace manager
#9  Indexer boundary
#10 Index artifact schema
#11 TypeScript indexer implementation
#12 Index importer
#13 Embedding pipeline
#14 Retrieval engine
#15 PR snapshot and diff model
#16 Review orchestrator
#17 LLM gateway
#18 Review passes
#19 Finding validation, dedupe, and ranking
#20 Publisher
#21 Feedback and memory system
#22 Repo rules and configuration
#23 Static analysis integration
#24 Sandbox execution
#25 Observability
#26 Evaluation harness
#27 Security and compliance layer
#28 Usage and billing
```

The internal tooling layer should answer:

```text
What happened?
Why did it happen?
What data did the system use?
What did it reject?
What did it publish?
What did it cost?
Can we replay it safely?
Can we compare old and new behavior?
Can we support a customer without leaking data or bypassing policy?
```

The tooling should not become a backdoor that bypasses product policy, tenant isolation, data retention, or audit logging.

---

## 2. Core design recommendation

Build internal tooling around **artifact inspection and deterministic replay**, not ad-hoc scripts.

```text
Immutable artifacts
  -> indexed by review_run_id / repo_id / commit_sha / job_id
  -> inspectable through admin UI and CLI
  -> replayable through controlled workflows
  -> auditable through admin actions
```

The mental model:

```text
Production system produces artifacts.
Internal tools inspect artifacts.
Replay tools re-run stages against artifacts.
Admin actions mutate only explicit operational state.
Every privileged action is audited.
```

Avoid this:

```text
Engineer connects to DB
  -> manually edits rows
  -> requeues Redis jobs manually
  -> pulls prompts from logs
  -> posts test comments from local machine
  -> no durable audit trail
```

Prefer this:

```text
Admin UI / CLI
  -> authorized admin API
  -> validated internal command
  -> durable admin_action row
  -> controlled worker job
  -> result artifact
  -> audit log
```

---

## 3. Scope

### In scope

The admin/internal tooling system includes:

```text
- review run inspector
- job and queue inspector
- webhook event inspector
- PR snapshot inspector
- diff/anchor inspector
- policy snapshot inspector
- retrieval/context inspector
- LLM call inspector
- candidate finding inspector
- validation/rejection inspector
- publish plan inspector
- GitHub publish/reconciliation inspector
- index artifact inspector
- index comparison tools
- embedding coverage tools
- replay workbench
- production-to-eval import tools
- usage/cost inspector
- memory/rule debug tools
- support access workflow
- internal CLI utilities
- admin API endpoints
- internal dashboard pages
- audit logs for all privileged actions
```

### Out of scope

This section does **not** define:

```text
- the public customer dashboard itself, except admin/debug panels inside it
- the evaluation methodology in detail; see #26
- billing provider implementation; see #28
- GitHub integration internals; see #3 and #20
- observability backend configuration; see #25
- security controls in full; see #27
```

---

## 4. Non-goals

Internal tooling should not:

```text
- bypass tenant isolation
- expose raw customer code by default
- expose secrets, tokens, prompt payloads, or model outputs by default
- publish GitHub comments without going through #20 Publisher
- mutate review findings without audit logs
- create hidden memory facts without review or traceability
- run arbitrary shell commands in customer repos
- let support users impersonate customers silently
- make manual DB edits the normal workflow
- depend on vendor-specific observability systems
```

---

## 5. High-level architecture

```text
/apps/web
  internal/admin dashboard routes
        |
        v
/apps/api
  admin/internal API routes
        |
        v
/packages/admin-tools
  command validation
  admin action records
  safe replay dispatch
  artifact access control
        |
        +----------------------+
        |                      |
        v                      v
/packages/db             /packages/security
  durable state              authz, audit, redaction
        |
        v
/apps/worker
  replay jobs
  reconciliation jobs
  export jobs
        |
        v
system packages
  retrieval
  review-engine
  publisher
  index-importer
  embedding
  github
```

Package boundaries:

```text
/packages/admin-tools
  owns admin commands, replay specs, inspector DTOs, and action safety policy

/packages/admin-api or /apps/api/src/routes/admin
  exposes authenticated admin/support endpoints

/apps/web/src/routes/_admin
  internal admin UI surfaces

/apps/worker/src/jobs/admin
  runs async admin/replay/reconciliation/export jobs
```

The internal tools should be built as a layer **above** existing packages. They should not duplicate business logic.

For example:

```text
Replay review validation
  -> calls #19 validation engine
  -> does not implement a second validator

Replay publishing dry-run
  -> calls #20 renderer/publisher in dry-run mode
  -> does not manually assemble GitHub comments

Replay retrieval
  -> calls #14 retrieval engine
  -> does not manually query vector tables except through explicit inspector helpers
```

---

## 6. User roles

Define explicit internal/support roles.

```ts
export type InternalRole =
  | "internal_viewer"
  | "support_viewer"
  | "support_operator"
  | "engineer"
  | "admin"
  | "security_admin";
```

Suggested permission model:

| Capability | support_viewer | support_operator | engineer | admin | security_admin |
|---|---:|---:|---:|---:|---:|
| View org/repo metadata | yes | yes | yes | yes | yes |
| View review run metadata | yes | yes | yes | yes | yes |
| View redacted artifacts | yes | yes | yes | yes | yes |
| View raw code artifacts | no by default | gated | gated | gated | gated |
| Replay retrieval dry-run | no | yes | yes | yes | yes |
| Replay review dry-run | no | yes | yes | yes | yes |
| Publish/reconcile comments | no | gated | gated | gated | gated |
| Approve memory candidate | no | optional | yes | yes | yes |
| Delete org data | no | no | no | admin only | yes |
| View security events | no | no | limited | yes | yes |
| Manage support sessions | no | no | no | yes | yes |

Default posture:

```text
Internal tooling is read-only unless the user has an explicit operational role.
Raw code/prompt access is denied unless a support session or elevated access grant exists.
All privileged actions require an audit trail.
```

---

## 7. Support access model

Internal tools should integrate with #27 support access controls.

### Support session

```ts
export type SupportAccessSession = {
  id: string;
  orgId: string;
  actorUserId: string;
  actorRole: InternalRole;
  reason: string;
  ticketId?: string;
  scope: SupportAccessScope;
  accessLevel: "metadata_only" | "redacted_artifacts" | "raw_artifacts" | "operational_actions";
  startsAt: string;
  expiresAt: string;
  approvedByUserId?: string;
  createdAt: string;
  revokedAt?: string;
};
```

### Support access scope

```ts
export type SupportAccessScope = {
  repoIds?: string[];
  reviewRunIds?: string[];
  artifactTypes?: ArtifactType[];
  allowRawCode?: boolean;
  allowRawPrompts?: boolean;
  allowReplay?: boolean;
  allowPublishActions?: boolean;
};
```

Support sessions should be visible to admins and included in audit logs.

---

## 8. Admin action model

Every privileged tool action should create an `admin_actions` record.

Examples:

```text
- replay review run
- rerun retrieval
- rerun validation
- rerun publisher dry-run
- reconcile published comments
- import production case to eval fixture
- approve memory candidate
- reject memory candidate
- retry webhook event
- retry background job
- export debug bundle
- access raw artifact
- delete debug artifact
```

### AdminAction

```ts
export type AdminActionStatus =
  | "requested"
  | "authorized"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type AdminActionKind =
  | "review.inspect"
  | "review.replay"
  | "retrieval.replay"
  | "validation.replay"
  | "publisher.dry_run"
  | "publisher.reconcile"
  | "webhook.retry"
  | "job.retry"
  | "index.replay"
  | "index.compare"
  | "embedding.recompute"
  | "memory.approve_candidate"
  | "memory.reject_candidate"
  | "eval.import_case"
  | "artifact.export_debug_bundle"
  | "artifact.access_raw"
  | "data.retention_delete";

export type AdminAction = {
  id: string;
  kind: AdminActionKind;
  status: AdminActionStatus;
  actorUserId: string;
  orgId?: string;
  repoId?: string;
  reviewRunId?: string;
  supportSessionId?: string;
  reason: string;
  request: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
};
```

Rules:

```text
- Every admin action has an actor.
- Every admin action has a reason.
- Every customer-scoped action has orgId.
- Raw artifact access must link to supportSessionId or elevated grant.
- Mutating actions must be replayable/auditable through a worker job, not hidden API-side side effects.
```

---

## 9. Database additions

The DB layer in #2 already includes many core tables. #29 should add or formalize the following tables.

### `admin_actions`

Durable record of privileged internal actions.

```sql
create table admin_actions (
  id text primary key,
  kind text not null,
  status text not null,
  actor_user_id text not null references users(id),
  org_id text references orgs(id),
  repo_id text references repositories(id),
  review_run_id text references review_runs(id),
  support_session_id text,
  reason text not null,
  request jsonb not null,
  result jsonb,
  error jsonb,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);

create index admin_actions_org_idx on admin_actions(org_id, created_at desc);
create index admin_actions_actor_idx on admin_actions(actor_user_id, created_at desc);
create index admin_actions_review_run_idx on admin_actions(review_run_id, created_at desc);
```

### `replay_runs`

A replay run represents a controlled re-execution of one or more stages.

```sql
create table replay_runs (
  id text primary key,
  admin_action_id text not null references admin_actions(id),
  source_review_run_id text references review_runs(id),
  org_id text not null references orgs(id),
  repo_id text references repositories(id),
  mode text not null,
  stages jsonb not null,
  config_overrides jsonb not null default '{}',
  status text not null,
  created_by_user_id text not null references users(id),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  result jsonb,
  error jsonb
);

create index replay_runs_source_idx on replay_runs(source_review_run_id, created_at desc);
create index replay_runs_org_idx on replay_runs(org_id, created_at desc);
```

### `replay_stage_runs`

Tracks individual replay stages.

```sql
create table replay_stage_runs (
  id text primary key,
  replay_run_id text not null references replay_runs(id),
  stage text not null,
  status text not null,
  input_artifact_ref jsonb,
  output_artifact_ref jsonb,
  metrics jsonb not null default '{}',
  error jsonb,
  started_at timestamptz,
  completed_at timestamptz
);

create index replay_stage_runs_replay_idx on replay_stage_runs(replay_run_id, stage);
```

### `artifact_access_events`

Records when sensitive artifacts are accessed.

```sql
create table artifact_access_events (
  id text primary key,
  actor_user_id text not null references users(id),
  org_id text references orgs(id),
  repo_id text references repositories(id),
  review_run_id text references review_runs(id),
  artifact_ref jsonb not null,
  access_level text not null,
  support_session_id text,
  reason text not null,
  ip_address text,
  user_agent text,
  created_at timestamptz not null default now()
);

create index artifact_access_events_org_idx on artifact_access_events(org_id, created_at desc);
create index artifact_access_events_review_idx on artifact_access_events(review_run_id, created_at desc);
```

### `admin_notes`

Internal notes attached to entities.

```sql
create table admin_notes (
  id text primary key,
  actor_user_id text not null references users(id),
  org_id text references orgs(id),
  repo_id text references repositories(id),
  review_run_id text references review_runs(id),
  finding_id text,
  visibility text not null,
  body text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index admin_notes_review_run_idx on admin_notes(review_run_id, created_at desc);
```

### `debug_exports`

Tracks debug bundle exports.

```sql
create table debug_exports (
  id text primary key,
  admin_action_id text not null references admin_actions(id),
  org_id text not null references orgs(id),
  repo_id text references repositories(id),
  review_run_id text references review_runs(id),
  export_kind text not null,
  artifact_uri text,
  artifact_hash text,
  redaction_level text not null,
  status text not null,
  expires_at timestamptz not null,
  created_by_user_id text not null references users(id),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  error jsonb
);

create index debug_exports_org_idx on debug_exports(org_id, created_at desc);
```

---

## 10. Package structure

```text
/packages/admin-tools
  src/
    index.ts
    actions/
      admin-action-types.ts
      admin-action-service.ts
      authorization.ts
      audit.ts
    inspectors/
      review-run-inspector.ts
      job-inspector.ts
      webhook-inspector.ts
      index-inspector.ts
      retrieval-inspector.ts
      llm-inspector.ts
      finding-inspector.ts
      publisher-inspector.ts
      usage-inspector.ts
      memory-inspector.ts
    replay/
      replay-types.ts
      replay-planner.ts
      replay-runner.ts
      replay-artifacts.ts
      replay-diff.ts
    exports/
      debug-bundle-types.ts
      debug-bundle-builder.ts
      redacted-export-builder.ts
    cli/
      commands.ts
    dto/
      admin-dtos.ts
    tests/
      fixtures/
      *.test.ts
```

API routes:

```text
/apps/api/src/routes/admin
  review-runs.ts
  jobs.ts
  webhooks.ts
  indexes.ts
  retrieval.ts
  llm.ts
  findings.ts
  publisher.ts
  memory.ts
  usage.ts
  replay.ts
  debug-exports.ts
  support-access.ts
```

Web dashboard routes:

```text
/apps/web/src/routes/_admin
  index.tsx
  orgs.$orgId.tsx
  repos.$repoId.tsx
  review-runs.$reviewRunId.tsx
  review-runs.$reviewRunId.snapshot.tsx
  review-runs.$reviewRunId.context.tsx
  review-runs.$reviewRunId.llm.tsx
  review-runs.$reviewRunId.findings.tsx
  review-runs.$reviewRunId.publisher.tsx
  review-runs.$reviewRunId.jobs.tsx
  review-runs.$reviewRunId.replay.tsx
  indexes.$indexVersionId.tsx
  indexes.compare.tsx
  webhooks.$eventId.tsx
  jobs.$jobId.tsx
  usage.tsx
  support-sessions.tsx
```

Worker jobs:

```text
/apps/worker/src/jobs/admin
  replay-review-run.ts
  replay-retrieval.ts
  replay-validation.ts
  publisher-reconcile.ts
  retry-webhook.ts
  retry-job.ts
  export-debug-bundle.ts
  compare-index-artifacts.ts
  import-eval-case.ts
```

CLI:

```text
/apps/cli or /packages/admin-tools/src/cli
  admin review inspect <reviewRunId>
  admin review replay <reviewRunId> --stage retrieval
  admin retrieval replay <reviewRunId>
  admin validation replay <reviewRunId>
  admin publisher dry-run <reviewRunId>
  admin index inspect <indexVersionId>
  admin index compare <indexA> <indexB>
  admin artifact export <reviewRunId> --redacted
  admin eval import <reviewRunId>
  admin job retry <jobId>
  admin webhook retry <webhookEventId>
```

---

## 11. Inspector principles

All inspectors should follow the same pattern.

```ts
export interface Inspector<TInput, TOutput> {
  inspect(input: TInput, context: AdminToolContext): Promise<TOutput>;
}
```

### AdminToolContext

```ts
export type AdminToolContext = {
  actorUserId: string;
  orgId?: string;
  supportSessionId?: string;
  permissions: string[];
  redactionLevel: RedactionLevel;
  requestId: string;
  reason?: string;
};
```

### Redaction levels

```ts
export type RedactionLevel =
  | "metadata_only"
  | "redacted"
  | "raw_allowed";
```

Inspectors should:

```text
- enforce tenant scoping
- apply redaction by default
- avoid returning raw code unless explicitly authorized
- avoid returning raw secrets ever
- include artifact references, hashes, and timestamps
- include enough context to reproduce the underlying state
- avoid hidden mutations
```

---

## 12. Review run inspector

The review run inspector is the main debugging surface.

### Questions it answers

```text
- What PR was reviewed?
- What base/head SHA was used?
- Was the review skipped, partial, or completed?
- Which stages ran?
- Which artifacts were produced?
- Which jobs were involved?
- Which policy snapshot was used?
- Which index versions were used?
- Which retrieval context was used?
- Which findings were generated, rejected, validated, and published?
- What did the review cost?
- What errors occurred?
```

### Output shape

```ts
export type ReviewRunInspection = {
  reviewRun: {
    id: string;
    orgId: string;
    repoId: string;
    pullRequestNumber: number;
    status: string;
    mode: string;
    baseSha: string;
    headSha: string;
    createdAt: string;
    startedAt?: string;
    completedAt?: string;
    supersededByReviewRunId?: string;
  };
  repository: {
    id: string;
    provider: string;
    owner: string;
    name: string;
    defaultBranch?: string;
  };
  pullRequest: {
    title?: string;
    authorLogin?: string;
    url?: string;
    draft?: boolean;
    labels?: string[];
  };
  stages: ReviewStageInspection[];
  artifacts: ArtifactSummary[];
  dependencies: ReviewDependencyInspection[];
  jobs: JobInspectionSummary[];
  policy: PolicyInspectionSummary;
  indexes: IndexInspectionSummary[];
  findings: FindingPipelineSummary;
  publishing: PublishInspectionSummary;
  costs: UsageCostSummary;
  errors: ErrorSummary[];
};
```

### Stage timeline

```ts
export type ReviewStageInspection = {
  stage:
    | "snapshot"
    | "policy"
    | "index_dependencies"
    | "embedding_coverage"
    | "change_set"
    | "retrieval"
    | "review_passes"
    | "validation"
    | "publish_planning"
    | "publishing";
  status: "pending" | "running" | "succeeded" | "failed" | "skipped";
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  inputArtifacts: ArtifactSummary[];
  outputArtifacts: ArtifactSummary[];
  metrics: Record<string, unknown>;
  error?: ErrorSummary;
};
```

### UI layout

```text
Review Run Detail
  Overview
    PR identity
    status
    base/head SHA
    timestamps
    replay/debug actions

  Timeline
    stage graph
    duration per stage
    error markers

  Artifacts
    snapshot
    diff
    policy
    change set
    context bundle
    review outputs
    validation outputs
    publish plan

  Findings
    candidate findings
    rejected findings
    validated findings
    published findings

  Costs
    LLM calls
    embedding calls
    token counts
    estimated cost

  Jobs
    originating webhook
    background jobs
    retries
    dead letters

  Replay
    dry-run stage replay
    variant comparison
```

---

## 13. Webhook inspector

### Questions it answers

```text
- Which GitHub delivery produced this work?
- Was the signature valid?
- Was the event deduped?
- Which jobs were planned?
- Which jobs were enqueued?
- Was the webhook replayed?
- Did any normalization errors occur?
```

### Output shape

```ts
export type WebhookEventInspection = {
  eventId: string;
  provider: "github";
  providerEventName: string;
  deliveryId: string;
  receivedAt: string;
  signatureVerified: boolean;
  orgId?: string;
  repoId?: string;
  installationId?: string;
  normalizedEventType?: string;
  idempotencyStatus: "first_seen" | "duplicate" | "ignored";
  plannedJobs: PlannedJobSummary[];
  backgroundJobs: JobInspectionSummary[];
  payloadSummary: Record<string, unknown>;
  rawPayloadArtifact?: ArtifactSummary;
  errors: ErrorSummary[];
};
```

### Admin actions

```text
- replay normalization
- retry job planning
- re-enqueue planned jobs
- export redacted payload
```

Raw webhook payload access should be gated because GitHub payloads may contain repository names, branch names, usernames, comments, and other sensitive data.

---

## 14. Job and queue inspector

### Questions it answers

```text
- Which jobs are stuck?
- Which jobs failed?
- Which jobs were retried?
- Which jobs are waiting on dependencies?
- Which queue is backlogged?
- Which review run depends on this job?
- Can the job be safely retried?
```

### Job inspection output

```ts
export type JobInspection = {
  backgroundJob: {
    id: string;
    queueName: string;
    jobName: string;
    status: string;
    idempotencyKey?: string;
    priority?: number;
    attempts: number;
    maxAttempts: number;
    createdAt: string;
    scheduledAt?: string;
    startedAt?: string;
    completedAt?: string;
  };
  bullmq?: {
    jobId?: string;
    state?: string;
    attemptsMade?: number;
    delay?: number;
    failedReason?: string;
  };
  relationships: {
    orgId?: string;
    repoId?: string;
    reviewRunId?: string;
    indexVersionId?: string;
    webhookEventId?: string;
  };
  payloadSummary: Record<string, unknown>;
  error?: ErrorSummary;
  retryEligibility: {
    canRetry: boolean;
    reason?: string;
    requiresOverride?: boolean;
  };
};
```

### Queue dashboard

```text
Queues
  github.sync
  repo.index
  repo.index.incremental
  embedding.batch
  pr.review
  review.resume
  review.publish
  memory.update
  static-analysis.run
  sandbox.run
  admin.replay
  admin.export

Per queue:
  waiting
  active
  delayed
  failed
  completed
  retry count
  oldest waiting job
  throughput
  average duration
  p95 duration
  error rate
```

### Admin actions

```text
- retry single job
- retry all failed jobs matching filter
- cancel job
- mark stale job abandoned
- re-enqueue lost job from durable state
- inspect payload redacted/raw gated
```

Retry rules:

```text
- Retrying must use the durable DB payload, not a mutated Redis payload.
- Retrying a publish job must re-run the stale-head guard.
- Retrying a review job must respect supersession rules.
- Retrying an index job must respect repo/index locks.
```

---

## 15. PR snapshot and diff inspector

### Questions it answers

```text
- What exactly did we think the PR looked like?
- What raw diff did GitHub provide?
- What files/hunks/lines were parsed?
- Which lines were commentable?
- Why did a finding fail anchor validation?
- Did a head SHA change make the review stale?
```

### UI panels

```text
Snapshot Overview
  provider
  repo
  PR number
  base/head/merge-base SHA
  fetched timestamp
  diff hash
  file counts
  patch size
  warnings

Changed Files
  path
  status
  additions/deletions
  binary/renamed/deleted
  parse warnings

Diff Hunks
  old/new ranges
  hunk header
  parsed lines
  commentable lines

Anchor Debugger
  file path
  line
  side
  anchor validity
  GitHub payload preview
```

### Anchor debugger API

```ts
export type AnchorDebugRequest = {
  reviewRunId: string;
  filePath: string;
  line: number;
  side: "LEFT" | "RIGHT";
  startLine?: number;
  startSide?: "LEFT" | "RIGHT";
};

export type AnchorDebugResult = {
  isValid: boolean;
  reason?: string;
  diffFile?: string;
  hunk?: {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
  };
  githubReviewCommentPayload?: Record<string, unknown>;
  warnings: string[];
};
```

---

## 16. Policy and rules inspector

### Questions it answers

```text
- Why did the system review or skip this PR?
- Which settings were active?
- Which repo-local config was used?
- Which rules matched?
- Which memory facts were considered?
- Why was a path ignored?
- Why was a finding suppressed?
```

### Output shape

```ts
export type PolicyInspection = {
  policySnapshotId: string;
  source: {
    orgSettingsVersion?: string;
    repoSettingsVersion?: string;
    repoLocalConfigCommitSha?: string;
    memoryPolicyVersion?: string;
  };
  effectivePolicy: Record<string, unknown>;
  decisions: PolicyDecisionTrace[];
  matchedRules: MatchedRuleSummary[];
  ignoredPaths: PathDecisionSummary[];
  findingPolicies: FindingPolicySummary[];
};
```

### Debug actions

```text
- evaluate path against policy
- evaluate finding against policy
- evaluate PR trigger decision
- compare two policy snapshots
```

All evaluations should be read-only and deterministic.

---

## 17. Index inspector

### Questions it answers

```text
- Was the repo indexed at the correct commit?
- Which indexer version produced the artifact?
- How many files/symbols/chunks/edges were imported?
- Which records failed validation?
- What changed between two index versions?
- Are embeddings complete for this index?
- Which symbols/chunks exist for a file?
```

### IndexVersionInspection

```ts
export type IndexVersionInspection = {
  indexVersion: {
    id: string;
    repoId: string;
    commitSha: string;
    status: string;
    indexerName: string;
    indexerVersion: string;
    schemaVersion: string;
    createdAt: string;
    completedAt?: string;
  };
  manifest: {
    artifactUri?: string;
    artifactHash?: string;
    languages: string[];
    featureFlags: string[];
    parserVersions: Record<string, string>;
    chunkerVersion: string;
  };
  counts: {
    files: number;
    symbols: number;
    chunks: number;
    edges: number;
    diagnostics: number;
    dependencies: number;
    routes: number;
    testMappings: number;
  };
  embeddingCoverage: {
    totalChunks: number;
    embeddedChunks: number;
    missingChunks: number;
    staleEmbeddings: number;
    coveragePercent: number;
  };
  importBatches: ImportBatchSummary[];
  errors: ErrorSummary[];
};
```

### File index explorer

For a selected file:

```text
File
  path
  language
  content hash
  size
  generated/vendored/test flags

Symbols
  name
  kind
  line range
  signature
  stable ID
  content hash

Chunks
  line range
  token estimate
  symbol ID
  content hash
  embedding status

Edges
  imports
  calls
  references
  tests
  routes
```

### Index comparison

Compare two index versions:

```text
Index A: repo@sha1 produced by indexer-v1
Index B: repo@sha1 produced by indexer-v2

Diff:
  files added/removed/changed
  symbols added/removed/changed
  chunks added/removed/changed
  edge counts by kind
  chunk boundary changes
  embedding invalidations
  diagnostics changes
```

This is critical for safely replacing the TypeScript indexer with a Rust or remote indexer.

### IndexCompareResult

```ts
export type IndexCompareResult = {
  indexA: string;
  indexB: string;
  sameRepo: boolean;
  sameCommit: boolean;
  fileDiff: RecordDiffSummary;
  symbolDiff: RecordDiffSummary;
  chunkDiff: RecordDiffSummary;
  edgeDiff: RecordDiffSummary;
  changedChunkBoundaries: ChunkBoundaryDiff[];
  warnings: string[];
  compatibility: {
    safeForRetrievalComparison: boolean;
    safeForProductionSwap: boolean;
    reasons: string[];
  };
};
```

---

## 18. Embedding inspector

### Questions it answers

```text
- Which chunks need embeddings?
- Which embedding profile was used?
- Which provider/model/dimensions were used?
- Which chunks reused cached embeddings?
- Which embedding jobs failed?
- Is retrieval degraded due to missing embeddings?
```

### Output shape

```ts
export type EmbeddingInspection = {
  repoId: string;
  indexVersionId: string;
  embeddingProfiles: EmbeddingProfileSummary[];
  coverage: {
    totalChunks: number;
    embeddedChunks: number;
    missingChunks: number;
    staleChunks: number;
  };
  jobs: EmbeddingJobSummary[];
  cache: {
    reusedCount: number;
    newCount: number;
    failedCount: number;
  };
  vectorStore: {
    provider: "pgvector" | "qdrant";
    dimensions: number;
    indexStatus?: string;
  };
};
```

### Admin actions

```text
- enqueue missing embeddings
- recompute embeddings for profile
- inspect chunk embedding status
- run semantic search test query
```

Embedding recomputation must create a durable admin action and usage/cost estimate before execution.

---

## 19. Retrieval inspector

### Questions it answers

```text
- What context did we retrieve?
- Why was each context item included?
- Which retrieval sources contributed?
- What were the scores and rank fusion inputs?
- What got dropped due to token budget?
- Was important context missing?
```

### Output shape

```ts
export type RetrievalInspection = {
  contextBundleId: string;
  reviewRunId: string;
  retrieveInputSummary: {
    repoId: string;
    baseSha: string;
    headSha: string;
    changedFiles: number;
    changedSymbols: number;
    budgetTokens: number;
  };
  items: RetrievalItemInspection[];
  droppedItems: RetrievalItemInspection[];
  sourceBreakdown: Record<string, number>;
  scoreBreakdown: RetrievalScoreBreakdown;
  tokenBudget: {
    maxTokens: number;
    usedTokens: number;
    droppedTokens: number;
  };
  warnings: string[];
};
```

### RetrievalItemInspection

```ts
export type RetrievalItemInspection = {
  contextItemId: string;
  kind: string;
  source:
    | "same_file"
    | "changed_symbol"
    | "graph_edge"
    | "related_test"
    | "semantic_search"
    | "lexical_search"
    | "repo_rule"
    | "memory"
    | "config"
    | "static_analysis";
  filePath?: string;
  lineRange?: { startLine: number; endLine: number };
  symbolId?: string;
  contentPreview?: string;
  contentHash?: string;
  score: number;
  rank: number;
  included: boolean;
  droppedReason?: string;
  reasons: string[];
  triggeredBy: {
    changedFile?: string;
    changedSymbolId?: string;
    query?: string;
  };
  tokenEstimate: number;
};
```

### Retrieval workbench

The admin UI should provide a retrieval workbench:

```text
Inputs:
  review run
  base/head index versions
  changed file/symbol filters
  retrieval profile
  token budget
  semantic query override
  include/exclude sources

Outputs:
  ranked context items
  dropped items
  score components
  context bundle preview
  diff from original context bundle
```

This is one of the most valuable internal tools because retrieval quality is a core product differentiator.

---

## 20. LLM call inspector

### Questions it answers

```text
- Which model was called?
- Which prompt version was used?
- Which structured output schema was used?
- How many tokens were used?
- How much did it cost?
- Did schema validation pass?
- Did redaction run?
- Did the provider return errors or retries?
```

### Output shape

```ts
export type LLMCallInspection = {
  llmCallId: string;
  reviewRunId?: string;
  task: string;
  provider: string;
  model: string;
  promptVersion: string;
  outputSchemaName?: string;
  status: string;
  startedAt: string;
  completedAt?: string;
  latencyMs?: number;
  tokenUsage: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
  };
  estimatedCostUsd?: string;
  cache: {
    requestCacheHit?: boolean;
    providerPromptCacheHit?: boolean;
  };
  redaction: {
    redactionApplied: boolean;
    redactionWarnings: string[];
  };
  validation: {
    schemaValidationPassed?: boolean;
    validationErrors?: string[];
  };
  promptArtifact?: ArtifactSummary;
  responseArtifact?: ArtifactSummary;
  error?: ErrorSummary;
};
```

### Prompt/response access

Default:

```text
metadata only
```

Optional gated views:

```text
redacted prompt
redacted response
raw prompt - privileged support session only
raw response - privileged support session only
```

Raw prompt access is sensitive because prompts may contain:

```text
- customer source code
- commit messages
- PR comments
- context snippets
- generated review candidates
- repo rules
- memory facts
```

### Prompt diff tool

Support comparing two prompt versions:

```text
review.correctness.v1
vs
review.correctness.v2

Diff:
  system instructions
  schema changes
  context packing changes
  policy changes
  output differences from replay
```

---

## 21. Finding pipeline inspector

### Questions it answers

```text
- Which candidate findings were generated?
- Which pass generated each finding?
- Which findings were rejected and why?
- Which findings were deduped/grouped?
- Which findings were validated?
- Which findings were published?
- Which memory/policy suppressed a finding?
- Did the final publish budget drop anything?
```

### Pipeline view

```text
Candidate Findings
  -> Normalized Findings
  -> Rejected Findings
  -> Dedupe Groups
  -> Ranked Findings
  -> Budgeted Findings
  -> Publish Plan
  -> Published Findings
```

### Output shape

```ts
export type FindingPipelineInspection = {
  reviewRunId: string;
  counts: {
    candidate: number;
    normalized: number;
    rejected: number;
    deduped: number;
    validated: number;
    budgetDropped: number;
    published: number;
  };
  candidates: CandidateFindingInspection[];
  rejected: RejectedFindingInspection[];
  dedupeGroups: DedupeGroupInspection[];
  validated: ValidatedFindingInspection[];
  published: PublishedFindingInspection[];
};
```

### Rejection reasons

The UI should show explicit reasons from #19:

```text
line_not_in_diff
file_not_changed
missing_evidence
low_confidence
style_nit
duplicate
suppressed_by_rule
suppressed_by_memory
generated_file
not_actionable
severity_below_threshold
comment_budget_exceeded
contradicted_by_context
unsafe_suggested_fix
```

### Finding fingerprint viewer

Show:

```text
root cause fingerprint
location fingerprint
body hash
evidence hash
previous matching comments
suppression matches
```

This helps debug duplicate comments and memory suppression.

---

## 22. Publisher inspector

### Questions it answers

```text
- What did we intend to publish?
- Was the PR head SHA still current?
- Which inline comments were posted?
- Which summary comment was created or updated?
- Which check run was created or updated?
- Were any comments skipped due to GitHub errors?
- Were duplicate comments detected?
- Did hidden markers parse correctly?
```

### Output shape

```ts
export type PublisherInspection = {
  reviewRunId: string;
  publishRunId?: string;
  status: string;
  publishMode: string;
  headShaGuard: {
    expectedHeadSha: string;
    actualHeadSha?: string;
    passed: boolean;
  };
  inlineComments: PublishedCommentInspection[];
  summaryComment?: PublishedSummaryInspection;
  checkRun?: PublishedCheckRunInspection;
  errors: ErrorSummary[];
  reconciliation?: ReconciliationSummary;
};
```

### Publisher dry-run

A dry-run should render everything without posting:

```text
- inline comment body markdown
- summary body markdown
- check run payload
- hidden markers
- external provider payload preview
- idempotency keys
```

### Reconciliation

Reconciliation checks GitHub state against DB state:

```text
DB says comment X was published
GitHub says comment X exists / missing / outdated / edited / deleted
```

Actions:

```text
- reconcile metadata only
- mark external comment missing
- refresh external URL/body hash
- do not auto-repost unless explicitly requested and allowed
```

---

## 23. Memory and rules inspector

### Questions it answers

```text
- Which memory facts were active for this review?
- Which memory facts were retrieved as context?
- Which memory facts suppressed findings?
- Which memory candidates are awaiting approval?
- Which explicit rules matched?
- Which reviewer feedback changed outcomes?
```

### Memory debugging view

```text
Memory Facts
  active
  source event
  scope
  confidence
  expiration
  last used
  suppression count

Memory Candidates
  pending
  accepted
  rejected
  source feedback
  suggested action

Suppression Matches
  finding
  memory/rule
  match score
  decision
```

### Admin actions

```text
- approve memory candidate
- reject memory candidate
- expire memory fact
- add explicit repo rule
- test finding against memory/rules
```

Any mutation should create:

```text
- admin_action
- audit_log
- memory/rule version bump
```

---

## 24. Usage and cost inspector

### Questions it answers

```text
- How much did a review cost?
- Which LLM calls contributed?
- Which embeddings contributed?
- Which static-analysis/sandbox runs contributed?
- Which org/repo is expensive?
- What is the cost per useful comment?
- Was a review blocked by quotas or entitlements?
```

### Cost tree

```text
Review Run Cost
  Indexing
    parser time
    storage writes
  Embeddings
    chunks embedded
    tokens
    provider cost
  Retrieval
    vector queries
    lexical queries
  LLM
    summary pass
    correctness pass
    security pass
    test pass
    judge pass
  Publishing
    GitHub API calls
  Static analysis
    sandbox runtime
    tool runtime
```

### UsageInspection

```ts
export type UsageInspection = {
  orgId: string;
  repoId?: string;
  reviewRunId?: string;
  usageEvents: UsageEventSummary[];
  rollups: UsageRollupSummary[];
  estimatedCostUsd: string;
  billableUnits: Record<string, number>;
  quotaDecisions: QuotaDecisionSummary[];
};
```

---

## 25. Replay workbench

The replay workbench is the most important internal engineering tool.

### Replay modes

```ts
export type ReplayMode =
  | "read_only_inspection"
  | "dry_run"
  | "compare_only"
  | "shadow_run"
  | "publish_disabled";
```

### Replayable stages

```ts
export type ReplayStage =
  | "snapshot_parse"
  | "policy_compile"
  | "index_dependency_plan"
  | "change_set_build"
  | "retrieval"
  | "review_passes"
  | "finding_validation"
  | "publish_plan"
  | "publisher_render"
  | "static_analysis_plan"
  | "memory_update";
```

Not all stages should be replayed the same way.

| Stage | Safe to replay? | Notes |
|---|---:|---|
| Snapshot parse | yes | Use stored raw diff artifact by default. |
| Policy compile | yes | Use original settings snapshot or current settings override. |
| Index dependency plan | yes | Should not trigger indexing unless requested. |
| Retrieval | yes | Use original indexes or current indexes. |
| Review passes | yes | Can call LLMs; cost warning required. |
| Validation | yes | Deterministic if same inputs. |
| Publish plan | yes | Deterministic if same inputs. |
| Publisher render | yes | Dry-run only by default. |
| Actual publish | gated | Requires explicit operational permission and stale-head guard. |
| Memory update | gated | Can mutate memory; approval recommended. |

### Replay request

```ts
export type ReplayReviewRunRequest = {
  sourceReviewRunId: string;
  stages: ReplayStage[];
  mode: ReplayMode;
  reason: string;
  configOverrides?: {
    retrievalProfile?: string;
    promptVersions?: Record<string, string>;
    modelProfiles?: Record<string, string>;
    validationProfile?: string;
    policySnapshotMode?: "original" | "current" | "override";
    indexMode?: "original" | "latest_same_commit" | "latest_default_branch";
    tokenBudgetOverride?: number;
  };
  compareAgainstOriginal?: boolean;
};
```

### Replay result

```ts
export type ReplayReviewRunResult = {
  replayRunId: string;
  sourceReviewRunId: string;
  status: "succeeded" | "failed" | "partial";
  stageResults: ReplayStageResult[];
  comparisons?: ReplayComparison[];
  artifacts: ArtifactSummary[];
  costEstimate?: UsageCostSummary;
};
```

### Replay comparison

Compare original vs replay:

```text
Original retrieval vs replay retrieval
  added context items
  removed context items
  rank changes
  token budget changes

Original candidate findings vs replay candidates
  added findings
  removed findings
  changed severities
  changed confidence

Original validated findings vs replay validated findings
  new published candidates
  suppressed candidates
  anchor changes

Original publish plan vs replay publish plan
  comment body diff
  summary diff
  check run diff
```

### Replay safety rules

```text
- Replay never publishes by default.
- Replay never updates memory by default.
- Replay never modifies original review artifacts.
- Replay output gets its own replay_run_id and artifacts.
- Replay must record prompt/model versions and overrides.
- Replay LLM calls must be marked as replay usage events.
- Replay raw artifact access follows the same redaction/support rules.
```

---

## 26. Debug bundle export

Support creating a redacted debug bundle for a review run.

### Bundle contents

```text
debug-bundle.json
review-run.json
stage-timeline.json
policy-snapshot.json
pull-request-snapshot.json
change-set.json
context-bundle.redacted.json
candidate-findings.json
validation-result.json
publish-plan.redacted.json
published-findings.json
llm-calls.metadata.json
usage-events.json
jobs.json
errors.json
```

Optional gated raw files:

```text
raw-diff.patch
context-bundle.raw.json
llm-prompts.raw.json
llm-responses.raw.json
index-records.sample.jsonl
```

### DebugBundleRequest

```ts
export type DebugBundleRequest = {
  reviewRunId: string;
  redactionLevel: "metadata_only" | "redacted" | "raw_allowed";
  includeRawDiff?: boolean;
  includeRawContext?: boolean;
  includeRawPrompts?: boolean;
  includeLLMResponses?: boolean;
  includeIndexSamples?: boolean;
  reason: string;
};
```

### Rules

```text
- Debug bundles expire automatically.
- Debug bundles are stored in object storage, not local disk.
- Export creation and download are both audited.
- Redacted is the default.
- Raw exports require support session or security/admin override.
```

---

## 27. Production-to-eval import

Internal tooling should make it easy to turn production failures into evaluation cases.

### Flow

```text
Bad/interesting review run
  -> admin selects "Import to Eval"
  -> choose redaction level
  -> choose expected finding labels
  -> create eval fixture draft
  -> review/approve fixture
  -> add to eval suite
```

### Eval import request

```ts
export type ImportReviewRunToEvalRequest = {
  reviewRunId: string;
  suiteId: string;
  caseName: string;
  reason: string;
  includeArtifacts: {
    pullRequestSnapshot: boolean;
    rawDiff: boolean;
    contextBundle: boolean;
    reviewOutputs: boolean;
    validationOutputs: boolean;
  };
  redactionLevel: "redacted" | "synthetic" | "raw_allowed";
  labels?: string[];
};
```

### Outputs

```text
/packages/evaluation/fixtures/<suite>/<case>/
  eval-case.json
  pr-snapshot.json
  diff.patch
  context-bundle.json
  expected-findings.json
  notes.md
```

This tool connects #26 evaluation harness back to production learning.

---

## 28. Admin API endpoints

Suggested route inventory.

### Review runs

```text
GET    /admin/review-runs
GET    /admin/review-runs/:reviewRunId
GET    /admin/review-runs/:reviewRunId/artifacts
GET    /admin/review-runs/:reviewRunId/stages
GET    /admin/review-runs/:reviewRunId/findings
GET    /admin/review-runs/:reviewRunId/costs
POST   /admin/review-runs/:reviewRunId/export-debug-bundle
POST   /admin/review-runs/:reviewRunId/replay
```

### Webhooks

```text
GET    /admin/webhooks
GET    /admin/webhooks/:webhookEventId
POST   /admin/webhooks/:webhookEventId/retry
```

### Jobs

```text
GET    /admin/jobs
GET    /admin/jobs/:jobId
POST   /admin/jobs/:jobId/retry
POST   /admin/jobs/:jobId/cancel
```

### Indexes

```text
GET    /admin/indexes/:indexVersionId
GET    /admin/indexes/:indexVersionId/files
GET    /admin/indexes/:indexVersionId/files/*path
POST   /admin/indexes/compare
POST   /admin/indexes/:indexVersionId/embedding/recompute
```

### Retrieval

```text
GET    /admin/review-runs/:reviewRunId/retrieval
POST   /admin/review-runs/:reviewRunId/retrieval/replay
POST   /admin/retrieval/search
```

### LLM

```text
GET    /admin/llm-calls
GET    /admin/llm-calls/:llmCallId
GET    /admin/llm-calls/:llmCallId/prompt
GET    /admin/llm-calls/:llmCallId/response
```

Prompt/response endpoints must enforce artifact access policy.

### Publisher

```text
GET    /admin/review-runs/:reviewRunId/publisher
POST   /admin/review-runs/:reviewRunId/publisher/dry-run
POST   /admin/review-runs/:reviewRunId/publisher/reconcile
```

### Memory/rules

```text
GET    /admin/review-runs/:reviewRunId/policy
POST   /admin/policy/evaluate-path
POST   /admin/policy/evaluate-finding
GET    /admin/memory/candidates
POST   /admin/memory/candidates/:candidateId/approve
POST   /admin/memory/candidates/:candidateId/reject
```

### Support access

```text
GET    /admin/support-sessions
POST   /admin/support-sessions
POST   /admin/support-sessions/:sessionId/revoke
```

---

## 29. Admin dashboard design

The admin UI should be organized around **entities**, not logs.

### Top-level navigation

```text
Admin
  Overview
  Orgs
  Repositories
  Review Runs
  Webhooks
  Jobs
  Indexes
  LLM Calls
  Usage
  Memory
  Support Sessions
  Debug Exports
```

### Review run page tabs

```text
Overview
Timeline
Snapshot
Policy
Indexes
Retrieval
LLM Calls
Findings
Publisher
Jobs
Costs
Replay
Artifacts
Notes
```

### Key UX rules

```text
- Show IDs with copy buttons.
- Show external links to GitHub when allowed.
- Show redaction state clearly.
- Show base/head SHA everywhere.
- Show artifact hashes and schema versions.
- Show warnings and partial failures prominently.
- Show exact rejection/suppression reasons.
- Provide dry-run previews before any action.
- Gate dangerous actions behind permission + reason + audit.
- Never show raw code by accident in list views.
```

### Useful components

```text
EntityHeader
StageTimeline
ArtifactLinkList
RedactionBadge
PermissionGate
CostBreakdown
FindingPipelineGraph
ContextBundleViewer
DiffAnchorDebugger
PromptViewer
JSONInspector
MarkdownRenderer
ReplayComparisonView
AdminActionHistory
SupportSessionBanner
```

---

## 30. Internal CLI

The CLI is for engineers and CI-like operational tasks.

### CLI principles

```text
- Uses the same admin API or same package functions as UI.
- Does not bypass authorization in production.
- Supports local/dev mode for fixture data.
- Prints machine-readable JSON with --json.
- Never prints raw secrets.
- Redacted output by default.
```

### Commands

```bash
# Inspect review run summary
admin review inspect rev_123

# Inspect review run as JSON
admin review inspect rev_123 --json

# Export redacted debug bundle
admin review export rev_123 --redacted

# Replay retrieval only
admin review replay rev_123 --stage retrieval --compare

# Replay validation only
admin review replay rev_123 --stage finding_validation --compare

# Render publish plan without posting
admin publisher dry-run rev_123

# Reconcile GitHub published comment metadata
admin publisher reconcile rev_123

# Inspect index version
admin index inspect idx_123

# Compare two index versions
admin index compare idx_ts idx_rs

# Inspect retrieval context
admin retrieval inspect rev_123

# Run semantic search test
admin retrieval search --repo repo_123 --sha abc123 --query "auth session validation"

# Retry failed job
admin job retry job_123 --reason "manual retry after provider outage"

# Retry webhook planning
admin webhook retry wh_123 --reason "queue enqueue failure"

# Import production run into eval fixture
admin eval import rev_123 --suite correctness --case auth-session-expiry
```

---

## 31. Artifact access and redaction

Admin tooling will often need to expose artifacts. This must be controlled.

### Artifact categories

```ts
export type ArtifactType =
  | "webhook_payload"
  | "raw_diff"
  | "pull_request_snapshot"
  | "policy_snapshot"
  | "index_manifest"
  | "index_records"
  | "change_set"
  | "context_bundle"
  | "llm_prompt"
  | "llm_response"
  | "candidate_findings"
  | "validation_result"
  | "publish_plan"
  | "debug_bundle";
```

### Sensitivity classification

| Artifact | Default access | Notes |
|---|---|---|
| policy_snapshot | redacted | May include rules and path patterns. |
| pull_request_snapshot | redacted | PR metadata may be sensitive. |
| raw_diff | gated | Contains source code. |
| context_bundle | gated | Contains source code and memory. |
| llm_prompt | gated | Contains code/context. |
| llm_response | gated | May quote code. |
| validation_result | redacted | Usually safe if snippets are redacted. |
| publish_plan | redacted | Contains comment body; may quote code. |
| index_records | gated | Contains code chunks/symbols. |
| webhook_payload | gated | Contains provider metadata and comments. |

### Redaction service

```ts
export interface ArtifactRedactor {
  redactArtifact(input: {
    artifactType: ArtifactType;
    content: unknown;
    level: "metadata_only" | "redacted" | "raw_allowed";
    orgId: string;
  }): Promise<unknown>;
}
```

Redaction examples:

```text
- replace code snippets with [redacted code: hash]
- preserve file path optionally depending on org policy
- preserve line ranges
- preserve token counts
- preserve model/prompt versions
- preserve finding categories/severities
- remove secrets if detected
```

---

## 32. Safety gates for mutating tools

Any mutating internal action should pass through a safety gate.

### Mutating actions

```text
- retry job
- retry webhook
- replay review with LLM calls
- recompute embeddings
- approve/reject memory candidate
- expire memory fact
- reconcile publisher state
- export raw debug bundle
- delete customer data
- force refresh installation/repo sync
```

### SafetyGateResult

```ts
export type SafetyGateResult = {
  allowed: boolean;
  requiredPermissions: string[];
  missingPermissions: string[];
  requiresSupportSession: boolean;
  requiresReason: boolean;
  requiresCostEstimateAcceptance: boolean;
  requiresDryRunFirst: boolean;
  warnings: string[];
};
```

### Safety policy examples

```text
Replay review passes with live LLM:
  allowed if engineer/support_operator
  requires reason
  records usage as replay
  no publish allowed

Publisher reconcile:
  allowed if support_operator/engineer
  requires reason
  must not post new comments by default

Actual republish:
  allowed only admin/engineer with explicit publish permission
  requires dry-run first
  requires stale-head guard
  requires reason

Raw artifact export:
  requires support session with raw_artifacts scope
  expires quickly
  audited on create and download
```

---

## 33. Replay implementation details

Replay should use existing package boundaries.

### Replay runner dependencies

```ts
export type ReplayRunnerDeps = {
  db: Db;
  artifactStore: ArtifactStore;
  retrievalEngine: RetrievalEngine;
  reviewEngine: ReviewEngine;
  findingValidationEngine: FindingValidationEngine;
  publisher: ReviewPublisher;
  policyCompiler: PolicyCompiler;
  llmGateway: LLMGateway;
  usageRecorder: UsageRecorder;
};
```

### Retrieval replay

```text
Load original:
  PullRequestSnapshot
  ChangeSet
  ReviewPolicySnapshot
  index versions

Run:
  retrievalEngine.retrieve(input)

Persist:
  replay context bundle artifact
  retrieval trace
  comparison to original context bundle
```

### Review pass replay

```text
Load:
  PullRequestSnapshot
  ChangeSet
  ContextBundle
  ReviewPolicySnapshot

Run:
  reviewEngine.review(input, overrides)

Persist:
  candidate findings
  LLM calls marked replay
  comparison to original candidate findings
```

### Validation replay

```text
Load:
  CandidateFinding[]
  PullRequestSnapshot
  DiffModel
  ReviewPolicySnapshot
  MemoryFacts

Run:
  findingValidationEngine.validate(input)

Persist:
  validated findings
  rejected findings
  publish plan
  comparison to original validation output
```

### Publisher dry-run replay

```text
Load:
  PublishPlan
  PullRequestSnapshot

Run:
  publisher.renderDryRun(input)

Persist:
  rendered markdown
  provider payload preview
  hidden markers
```

---

## 34. Comparison algorithms

Internal tooling needs deterministic comparison of artifacts.

### Finding matching

Use layered matching:

```text
1. exact finding ID if replay preserved it
2. root cause fingerprint
3. file path + line + category + title similarity
4. evidence fingerprint
5. semantic similarity fallback if available
```

### Context item matching

```text
1. context item ID
2. chunk ID
3. content hash
4. file path + line range
5. source + triggeredBy + content hash
```

### Diff result examples

```ts
export type ComparisonResult<T> = {
  added: T[];
  removed: T[];
  unchanged: T[];
  changed: Array<{
    before: T;
    after: T;
    changes: FieldChange[];
  }>;
  summary: Record<string, number>;
};
```

This will power:

```text
- replay comparisons
- index comparisons
- context bundle comparisons
- prompt output comparisons
- validation result comparisons
```

---

## 35. Dashboard/API security

Security rules for admin tooling:

```text
- Admin routes require authenticated user.
- Admin routes require internal role or org-level support grant.
- Every endpoint enforces tenant scope.
- Raw artifact endpoints require explicit artifact access check.
- Mutating endpoints require reason string.
- Privileged actions write admin_actions and audit_logs.
- Debug exports expire.
- All downloadable URLs are signed and short-lived.
- Redacted data is the default.
- Support-session banner is visible when elevated access is active.
```

### API middleware stack

```text
request
  -> authenticate
  -> load actor
  -> load internal role
  -> load support session if provided
  -> authorize admin route
  -> tenant guard
  -> redaction policy
  -> audit wrapper
  -> handler
```

---

## 36. Observability for internal tools

Admin tooling should emit spans and metrics, but should not leak raw data.

### Metrics

```text
admin_actions_total{kind,status}
admin_action_duration_ms{kind}
replay_runs_total{mode,status}
replay_stage_duration_ms{stage,status}
debug_exports_total{redaction_level,status}
artifact_access_total{artifact_type,access_level}
job_retries_manual_total{queue,job_name}
webhook_retries_manual_total{event_type}
```

### Span attributes

```text
admin.action_id
admin.action_kind
admin.actor_user_id_hash
admin.org_id
admin.repo_id
review.run_id
replay.run_id
artifact.type
artifact.redaction_level
```

Do not include:

```text
- raw prompt text
- raw source code
- raw diffs
- tokens
- secrets
- customer comments
```

---

## 37. Testing strategy

### Unit tests

```text
- admin action authorization
- safety gate decisions
- redaction policy
- artifact access control
- replay request validation
- comparison algorithms
- debug bundle builder
- route DTO validation
```

### Integration tests

```text
- inspect a fixture review run
- replay retrieval from stored artifacts
- replay validation from stored candidates
- dry-run publisher rendering
- retry failed background job through admin action
- export redacted debug bundle
- import eval fixture from review run
```

### Security tests

```text
- support_viewer cannot access raw artifacts
- support_operator cannot publish without explicit permission
- cross-tenant reviewRunId is denied
- raw prompt access creates artifact_access_event
- debug export download is denied after expiration
- support session expiration is enforced
- reason is required for mutating action
```

### Snapshot/golden tests

```text
- redacted debug bundle shape
- review inspection DTO
- retrieval comparison output
- publisher dry-run markdown
- index comparison output
```

### E2E tests

```text
Fixture review run
  -> admin UI review detail loads
  -> retrieval tab displays context items
  -> finding tab displays rejected reasons
  -> replay retrieval works
  -> debug bundle exports redacted artifacts
```

---

## 38. Local development flow

Internal tooling should be useful in local dev.

### Local fixtures

```text
/dev/fixtures/review-runs/simple-ts-bug
/dev/fixtures/review-runs/security-auth-bug
/dev/fixtures/review-runs/large-pr
/dev/fixtures/index-artifacts/basic-ts
```

### Dev commands

```bash
pnpm admin:seed-fixtures
pnpm admin:inspect-review rev_fixture_1
pnpm admin:replay-retrieval rev_fixture_1
pnpm admin:export-debug-bundle rev_fixture_1
pnpm admin:index-compare idx_a idx_b
```

### Local debug bundle

Generate a bundle from fixture data without requiring customer data.

```bash
admin review export rev_fixture_1 --redacted --out /tmp/debug-bundle
```

---

## 39. Implementation sequence

### PR 1: Package skeleton and contracts

Implement:

```text
/packages/admin-tools
  AdminToolContext
  AdminActionKind
  AdminAction
  ReplayRun
  ReplayStage
  RedactionLevel
  ArtifactType
  DTO schemas
```

Add DB migrations:

```text
admin_actions
replay_runs
replay_stage_runs
artifact_access_events
admin_notes
debug_exports
```

### PR 2: Admin action service and authorization

Implement:

```text
AdminActionService
SafetyGate
admin permission helpers
support session integration placeholder
audit log integration
redaction-level resolver
```

### PR 3: Review run inspector

Implement:

```text
ReviewRunInspector
stage timeline builder
artifact summary builder
job relationship lookup
finding summary lookup
cost summary lookup
```

API:

```text
GET /admin/review-runs/:reviewRunId
```

Dashboard:

```text
Review Run Overview
Timeline
Artifacts
```

### PR 4: Jobs and webhook inspectors

Implement:

```text
JobInspector
WebhookInspector
queue summary endpoint
retry job admin action
retry webhook admin action
```

Dashboard:

```text
Jobs list/detail
Webhooks list/detail
```

### PR 5: Snapshot, policy, and finding inspectors

Implement:

```text
PR snapshot inspector
Diff/anchor debugger
Policy inspector
Finding pipeline inspector
```

Dashboard tabs:

```text
Snapshot
Policy
Findings
Anchor Debugger
```

### PR 6: Index and embedding inspectors

Implement:

```text
IndexInspector
FileIndexExplorer
EmbeddingInspector
IndexCompareEngine MVP
```

Dashboard:

```text
Index detail
Index compare
Embedding coverage
```

### PR 7: Retrieval inspector and workbench MVP

Implement:

```text
RetrievalInspection
ContextBundle viewer
Retrieval replay dry-run
Context comparison
```

Dashboard:

```text
Retrieval tab
Replay retrieval action
```

### PR 8: LLM and publisher inspectors

Implement:

```text
LLMCallInspector
redacted prompt/response access
PublisherInspector
publisher dry-run renderer
publisher reconciliation metadata view
```

Dashboard:

```text
LLM Calls tab
Publisher tab
```

### PR 9: Replay workbench MVP

Implement:

```text
ReplayRunService
ReplayRunner
retrieval replay
validation replay
publisher render replay
replay comparison artifacts
```

Dashboard:

```text
Replay tab
Replay comparison view
```

### PR 10: Debug bundles and eval import

Implement:

```text
DebugBundleBuilder
redacted export
signed URL download
artifact access events
ImportReviewRunToEval MVP
```

Dashboard:

```text
Export debug bundle
Import to eval
Debug exports list
```

### PR 11: Memory/rules inspector

Implement:

```text
MemoryInspector
RuleInspector
memory candidate approval/rejection actions
policy/finding evaluation tools
```

Dashboard:

```text
Memory tab
Rules debug view
```

### PR 12: Hardening

Implement:

```text
permission audit
cross-tenant tests
raw artifact access gating
support session integration
rate limits
admin action metrics
runbooks
```

---

## 40. MVP cut

For the MVP, implement the minimum internal tooling that allows the team to debug real reviews without manual DB spelunking.

### MVP required

```text
- /packages/admin-tools package
- admin_actions table
- artifact_access_events table
- ReviewRunInspector
- JobInspector
- WebhookInspector
- FindingPipelineInspector
- RetrievalInspector basic view
- LLMCallInspector metadata-only view
- PublisherInspector basic view
- DebugBundle export redacted
- Replay retrieval dry-run
- Replay validation dry-run
- Publisher dry-run rendering
- Admin API routes for these views
- Admin dashboard review-run detail page
- CLI inspect/replay/export commands
- permission checks
- audit logs
```

### MVP not required

```text
- raw prompt/code artifact access
- full support session approval flow
- index comparison UI beyond basic summary
- embedding recomputation action
- memory approval UI
- production-to-eval import automation
- actual republish from admin UI
- live queue bulk controls
- advanced replay variants
```

---

## 41. Definition of done

#29 is complete when:

```text
- Engineers can inspect any review run from a single admin page.
- Engineers can see snapshot, policy, retrieval, LLM call metadata, findings, validation reasons, publishing state, jobs, and costs.
- Engineers can export a redacted debug bundle.
- Engineers can replay retrieval and validation without mutating production state.
- Engineers can render a publisher dry-run without posting to GitHub.
- Failed jobs and webhooks can be inspected and retried through audited actions.
- Raw artifacts are not exposed by default.
- Every privileged action creates admin_actions and audit_logs records.
- Cross-tenant access tests pass.
- Redaction tests pass.
- Local fixture review runs can be inspected and replayed.
```

---

## 42. Key failure modes to prevent

```text
Failure mode: Internal user accidentally sees raw customer code.
Prevention: redacted by default, artifact access policy, support session gating.

Failure mode: Engineer manually edits DB to fix state.
Prevention: admin action commands and reconciliation tools.

Failure mode: Replay accidentally posts comments.
Prevention: replay mode is dry-run by default; actual publish requires separate gated action.

Failure mode: Debug bundle leaks prompts/source code.
Prevention: redacted bundle default, raw export gated and expiring.

Failure mode: Support retries a stale publish job.
Prevention: publisher stale-head guard always runs.

Failure mode: Cross-tenant ID access leaks metadata.
Prevention: tenant guard on every admin route and inspector.

Failure mode: Replays mutate original artifacts.
Prevention: replay runs have independent IDs and artifact namespaces.

Failure mode: Tooling reimplements business logic incorrectly.
Prevention: inspectors and replay call existing packages.
```

---

## 43. Clean mental model

Internal tooling should make the system explainable:

```text
Webhook event
  -> job
  -> review run
  -> immutable snapshot
  -> policy snapshot
  -> index dependencies
  -> context bundle
  -> LLM calls
  -> candidate findings
  -> validation decisions
  -> publish plan
  -> published comments
  -> feedback and memory
```

For every arrow, the admin tooling should let you inspect:

```text
input
output
artifact hash
timestamp
actor/job
status
cost
errors
replayability
```

The strongest design rule:

```text
If a production review cannot be explained from artifacts and admin tooling,
the system is not debuggable enough yet.
```

