# #16 Review Orchestrator Implementation Spec

Version: `review-orchestrator-spec.v1`  
Target package/app: `/packages/review-orchestrator`, `/apps/worker`  
Primary runtime: Bun worker process, with Node-compatible fallback where needed  
Depends on: `#0 contracts`, `#2 database`, `#3 github`, `#7 queue`, `#8 repo-sync`, `#9 indexer-boundary`, `#12 index-importer`, `#13 embedding`, `#14 retrieval`, `#15 pr-snapshot`  
Feeds into: `#17 LLM gateway`, `#18 review passes`, `#19 finding validation`, `#20 publisher`, `#21 memory`

---

## 1. Purpose

The review orchestrator is the component that turns a queued pull-request review request into a fully persisted review run.

It does not deeply understand GitHub, parsing, embeddings, retrieval, LLM providers, or publishing. Instead, it coordinates those components through narrow interfaces.

The orchestrator answers one question:

```text
Given repo + pull request + base/head commit,
what deterministic sequence of work must happen to produce publishable review findings?
```

The clean flow is:

```text
ReviewPRJob
  -> create or reuse ReviewRun
  -> fetch immutable PR snapshot
  -> classify/gate review scope
  -> ensure required index versions exist
  -> build ChangeSet
  -> retrieve ContextBundle
  -> run review passes
  -> validate/rank/dedupe findings
  -> persist artifacts
  -> enqueue publish job
```

The orchestrator should make review runs:

```text
- deterministic
- replayable
- cancellable
- idempotent
- observable
- explainable
- safe to retry
- easy to debug
```

---

## 2. Non-goals

The orchestrator should not:

```text
- parse GitHub webhook payloads
- verify webhook signatures
- clone repositories directly
- run Git commands directly
- parse source files directly
- write index records directly
- create embeddings directly
- query vector stores directly
- call model providers directly except through the LLM gateway / review engine
- post comments directly to GitHub except through the publisher package
- make final quality decisions without the finding validator
```

It is a workflow coordinator, not a catch-all service.

---

## 3. Core design principle

Use a durable state machine rather than one giant function that assumes everything succeeds.

Bad shape:

```ts
async function reviewPR(job) {
  const snapshot = await github.getPR(job);
  await indexEverything(snapshot);
  const context = await retrieveContext(snapshot);
  const findings = await llm.review(context);
  await github.postComments(findings);
}
```

Good shape:

```text
ReviewRun state machine
  created
  snapshotting
  waiting_for_index
  retrieving_context
  reviewing
  validating
  publish_queued
  completed
```

Each stage should:

```text
- be persisted
- be retryable
- have explicit inputs
- have explicit outputs
- save artifacts
- check whether the run is still current
- fail with structured error metadata
```

---

## 4. System boundary

Recommended package layout:

```text
/packages/review-orchestrator
  src/index.ts
  src/types.ts
  src/config.ts
  src/errors.ts
  src/orchestrator.ts
  src/state-machine.ts
  src/review-run-repository.ts
  src/dependency-planner.ts
  src/stage-runner.ts
  src/artifact-writer.ts
  src/gating.ts
  src/staleness.ts
  src/idempotency.ts
  src/replay.ts
  src/metrics.ts
  src/test/fakes.ts

/apps/worker
  src/handlers/review-pr.ts
  src/handlers/review-resume.ts
  src/handlers/review-cancel.ts
```

Required supporting package:

```text
/packages/artifacts
  ArtifactStore
  ArtifactRef helpers
  local filesystem store
  object storage store
  retention/deletion manifest helpers
```

The orchestrator should consume artifact storage through `@repo/artifacts`. It should not define a separate production artifact store abstraction beyond narrow adapters/fakes for tests.

The orchestrator should be consumed by the worker like this:

```ts
import { createReviewOrchestrator } from "@repo/review-orchestrator";

export async function handleReviewPRJob(job: ReviewPRJobPayload) {
  const orchestrator = createReviewOrchestrator(deps);
  return orchestrator.run(job);
}
```

---

## 5. Dependency graph

The orchestrator depends on narrow interfaces.

```text
Review Orchestrator
  |
  |-- ReviewRunRepository       -> Postgres state and artifacts
  |-- GitProvider               -> fetch provider-neutral PR metadata
  |-- PullRequestSnapshotBuilder -> build stable snapshot and diff model
  |-- RepoSyncer                -> workspace checkout when needed
  |-- IndexerDriver             -> produce index artifact
  |-- IndexImporter             -> import artifact into normalized storage
  |-- EmbeddingPlanner          -> ensure embeddings exist / schedule jobs
  |-- RetrievalEngine           -> produce ContextBundle
  |-- ReviewEngine              -> produce CandidateFinding[]
  |-- FindingValidator          -> produce ValidatedFinding[]
  |-- QueueClient               -> enqueue dependent jobs
  |-- ArtifactStore             -> persist large artifacts through @repo/artifacts
  |-- Observability             -> traces, logs, metrics
```

Important: these dependencies should be passed in, not imported globally. That keeps the orchestrator testable.

```ts
export type ReviewOrchestratorDeps = {
  db: Db;
  reviewRuns: ReviewRunRepository;
  gitProvider: GitProvider;
  snapshotBuilder: PullRequestSnapshotBuilder;
  repoSyncer: RepoSyncer;
  indexer: IndexerDriver;
  indexImporter: IndexImporter;
  embeddingPlanner: EmbeddingPlanner;
  retrieval: RetrievalEngine;
  reviewEngine: ReviewEngine;
  findingValidator: FindingValidator;
  queue: QueueClient;
  artifacts: ArtifactStore; // from @repo/artifacts
  telemetry: Telemetry;
  clock: Clock;
};
```

---

## 6. Main inputs

The review orchestrator starts from a durable job payload created by webhook ingestion or the API.

```ts
export type ReviewPRJobPayload = {
  schemaVersion: "review_pr_job.v1";

  jobId: string;
  orgId: string;
  repoId: string;
  provider: "github";
  providerInstallationId: string;

  pullRequestNumber: number;

  /** Optional hints from webhook event. Orchestrator must verify by fetching current PR. */
  baseSha?: string;
  headSha?: string;
  mergeBaseSha?: string;

  /** Why this review was requested. */
  trigger:
    | "pull_request_opened"
    | "pull_request_synchronize"
    | "pull_request_reopened"
    | "manual_rerun"
    | "settings_changed"
    | "dependency_ready"
    | "scheduled_recheck";

  /** GitHub delivery ID or API request ID for tracing/idempotency. */
  sourceEventId?: string;

  /** Optional requested mode override. */
  requestedMode?: "summary_only" | "full_review" | "dry_run" | "debug";

  /** Optional human-visible reason for manual reruns. */
  reason?: string;

  enqueuedAt: string;
};
```

The payload should not contain raw diffs, repo contents, GitHub tokens, or model prompts.

---

## 7. Main outputs

A successful orchestrator run should produce:

```text
review_runs row
pull_request_snapshot artifact
raw_diff artifact
diff_model / line_anchor_index artifact
change_set artifact
context_bundle artifact
candidate_findings rows/artifact
validated_findings artifact
rejected_findings report artifact
publish_review job
usage events / metrics
```

The orchestrator does not need to publish directly. The preferred handoff is:

```text
review_orchestrator
  -> persists validated findings
  -> enqueues review.publish
  -> publisher posts to GitHub
```

---

## 8. ReviewRun identity and idempotency

A review run should be uniquely identified by the meaningful review input, not by queue delivery.

Recommended idempotency key:

```text
review:{repoId}:{pullRequestNumber}:{headSha}:{reviewProfileHash}:{settingsHash}:{manualRerunNonce?}
```

Where:

```text
headSha             = PR head commit being reviewed
reviewProfileHash  = model/profile/review-pass configuration
settingsHash       = repo settings + rules that affect output
manualRerunNonce   = optional when user explicitly wants a fresh run for same SHA/settings
```

This prevents duplicate reviews when:

```text
- GitHub sends duplicate webhook deliveries
- webhook ingestion retries
- queue job retries
- worker crashes after partially completing work
```

Recommended helper:

```ts
export function buildReviewRunKey(input: {
  repoId: string;
  pullRequestNumber: number;
  headSha: string;
  reviewProfileHash: string;
  settingsHash: string;
  manualRerunNonce?: string;
}): string {
  return [
    "review",
    input.repoId,
    String(input.pullRequestNumber),
    input.headSha,
    input.reviewProfileHash,
    input.settingsHash,
    input.manualRerunNonce ?? "default",
  ].join(":");
}
```

---

## 9. ReviewRun state machine

Use explicit states from the canonical `ReviewRunStatus` contract in #0.

Recommended transitions:

```text
created
  -> snapshotting
  -> waiting_for_index
  -> waiting_for_embeddings
  -> retrieving_context
  -> reviewing
  -> validating_findings
  -> publish_queued
  -> completed
```

Terminal states:

```text
completed
skipped
superseded
canceled
failed
```

Non-terminal wait states:

```text
waiting_for_index
waiting_for_embeddings
publish_queued
```

Reasons for `skipped`:

```text
- repo disabled
- PR closed
- PR draft and settings skip draft PRs
- ignored author
- ignored label
- required label missing
- diff too large
- no reviewable changed files
- unsupported provider state
- installation unavailable
- permissions missing
```

Reasons for `superseded`:

```text
- newer PR head SHA exists
- newer review run for same PR/head/settings exists
- old run tried to publish after PR moved
```

---

## 10. Database ownership

The #2 database spec is the canonical schema owner. It includes `review_runs`, `review_run_stage_events`, `review_run_dependencies`, `review_artifacts`, and `background_jobs`.

This phase may describe how orchestration uses those tables, but it must not redefine their columns or indexes.

Example dependencies:

```text
index:base:{repoId}:{baseSha}
index:head:{repoId}:{headSha}
embeddings:{repoId}:{baseIndexVersionId}
```

---

## 11. Orchestration modes

Support multiple `ReviewExecutionMode` values from #0 so the MVP can ship without building every dependency to perfection.

Recommended behavior:

| Mode | Behavior |
|---|---|
| `summary_only` | Generate PR summary, no inline comments. |
| `diff_only` | Review raw diff + PR metadata only. Useful fallback when index is missing. |
| `repo_context` | Use base index + retrieval. No static tool execution. |
| `full` | Use retrieval, review passes, validation, optional static analysis. |

MVP default:

```text
repo_context
```

Fallbacks:

```text
If index unavailable and repo settings allow fallback:
  repo_context -> diff_only

If PR too large:
  repo_context -> summary_only or skipped
```

---

## 12. Stage 1: Start or resume review run

The orchestrator should first acquire a run-level lock and create or resume a review run.

Pseudo-code:

```ts
export async function run(job: ReviewPRJobPayload): Promise<ReviewOrchestratorResult> {
  return withReviewLock(job.repoId, job.pullRequestNumber, async () => {
    const plan = await createOrResumeReviewRun(job);

    if (plan.action === "noop") return plan.result;
    if (plan.action === "resume") return resumeReviewRun(plan.reviewRunId);
    return executeReviewRun(plan.reviewRunId);
  });
}
```

Locking strategy:

```text
- transaction-level advisory lock for short DB mutation sections
- durable review_run status for long-lived state
- no advisory lock held during LLM calls, indexing, embedding, or GitHub API calls
```

Never hold a DB transaction open while doing network or model work.

---

## 13. Stage 2: Fetch PR snapshot

The snapshot stage should build an immutable `PullRequestSnapshot` and artifacts from provider data.

Inputs:

```text
repoId
providerInstallationId
pullRequestNumber
```

Outputs:

```text
PullRequestSnapshot
raw diff artifact
parsed DiffModel artifact
LineAnchorIndex artifact
snapshot hash
```

Flow:

```text
load repository + settings
fetch current PR metadata
fetch changed files metadata
fetch raw diff
parse diff
build line anchor index
persist snapshot artifact
update review run with baseSha/headSha/mergeBaseSha/snapshotHash
```

Important rules:

```text
- The orchestrator should trust the fetched provider state, not webhook hints.
- Webhook base/head SHAs are hints only.
- If the PR is closed, merged, inaccessible, or draft-skipped, mark skipped.
- If the installation token fails due to permissions, mark failed or skipped depending on cause.
```

Staleness check after snapshot:

```ts
if (job.headSha && snapshot.headSha !== job.headSha) {
  // The webhook job is stale. A newer webhook probably exists.
  // Either mark superseded or continue with fetched head depending on policy.
}
```

Recommended policy:

```text
If the job was triggered by webhook and payload headSha differs from fetched headSha:
  mark run superseded and enqueue a fresh review job for fetched headSha.

If the job was manual_rerun:
  continue with fetched current PR head.
```

---

## 14. Stage 3: Review gating

Before indexing or LLM work, decide whether the PR should be reviewed.

Inputs:

```text
PullRequestSnapshot
RepositorySettings
RepoRules
provider labels/authors/metadata
```

Checks:

```text
- repository enabled
- installation active
- PR open
- PR not draft, unless settings allow draft review
- author not ignored
- labels do not include skip label
- required review label exists if configured
- changed files exist
- file count under max
- total diff lines under max
- patch bytes under max
- at least one changed file is reviewable
- no global org usage limit exceeded
```

Example:

```ts
export type ReviewGateDecision =
  | { action: "continue"; mode: ReviewExecutionMode }
  | { action: "skip"; reason: ReviewSkippedReason; details?: unknown }
  | { action: "fallback"; mode: ReviewExecutionMode; reason: string };
```

Suggested default thresholds:

```text
Use ReviewSizeClass from #0:

small:  changedLines <= 100,  changedFiles <= 10,  rawDiffBytes <= 256 KiB
medium: changedLines <= 500,  changedFiles <= 50,  rawDiffBytes <= 1 MiB
large:  changedLines <= 3,000, changedFiles <= 100, rawDiffBytes <= 2 MiB
huge:   anything above large, or any hard parser/gating cap exceeded

Inline review is allowed by default for small, medium, and large.
Huge reviews fall back to summary_only or skip according to ReviewPolicy.

Hard parser/gating caps:
maxRawDiffBytes: 25 * 1024 * 1024
maxDiffFiles: 3_000
maxParsedDiffLines: 250_000
maxFileBytesToInspect: 1_000_000
maxBinaryFiles: 0
```

Size-class thresholds are product defaults. Hard parser/gating caps protect infrastructure and should require an explicit product decision to raise.

---

## 15. Stage 4: Ensure index dependencies

The orchestrator should determine which index versions are required.

Minimum requirement for repo-context review:

```text
base index version
```

Useful additional requirement:

```text
head index version
```

Recommended policy:

| Index | Required? | Why |
|---|---:|---|
| base SHA | Yes for repo-context mode | Retrieve existing patterns, callers, tests, context. |
| head SHA | Optional but useful | Resolve changed symbols and inspect new code state. |
| merge-base SHA | Optional | Useful for exact local diff reproduction. |

MVP:

```text
Require base index.
Use PR diff + changed files for new code.
Do not block on full head index unless needed.
```

Scale-up:

```text
Index base and head incrementally.
Use both for precise changed-symbol extraction and context comparison.
```

### Non-blocking dependency strategy

The orchestrator should not keep a worker process idle while waiting for index jobs.

Preferred strategy:

```text
review_pr job starts
  -> snapshot + gating
  -> index missing
  -> create review_run_dependencies
  -> enqueue index.repo jobs
  -> mark review run waiting_for_index
  -> exit worker

index job completes
  -> emits dependency_ready or review.resume job
  -> review resumes
```

This follows the #7 queue principle:

```text
Postgres is source of truth.
BullMQ is execution broker.
Workers are idempotent.
```

### Dependency planner

```ts
export type IndexDependencyPlan = {
  allSatisfied: boolean;
  required: Array<{
    dependencyKey: string;
    repoId: string;
    commitSha: string;
    existingIndexVersionId?: string;
    status: "satisfied" | "missing" | "in_progress" | "failed";
  }>;
};
```

Pseudo-code:

```ts
async function ensureIndexDependencies(run: ReviewRun, snapshot: PullRequestSnapshot) {
  const plan = await dependencyPlanner.planIndexes({
    repoId: run.repoId,
    baseSha: snapshot.baseSha,
    headSha: snapshot.headSha,
    mode: run.mode,
  });

  if (plan.allSatisfied) {
    return { action: "continue", indexVersions: plan.indexVersions };
  }

  await reviewRuns.recordDependencies(run.id, plan.required);

  for (const dep of plan.required.filter(d => d.status === "missing")) {
    await queue.enqueue("repo.index", {
      repoId: dep.repoId,
      commitSha: dep.commitSha,
      reason: "review_dependency",
      reviewRunId: run.id,
    });
  }

  await reviewRuns.transition(run.id, "waiting_for_index");

  return { action: "pause" };
}
```

---

## 16. Stage 5: Ensure embeddings

Indexing produces chunks. Retrieval needs embeddings for semantic search.

MVP policy:

```text
If embeddings are partially missing:
  - use whatever vectors exist
  - also use lexical/graph/same-file retrieval
  - queue embedding jobs in background
```

Strict policy:

```text
If semantic search is required and embedding coverage is below threshold:
  - enqueue embedding jobs
  - mark waiting_for_embeddings
  - resume when coverage is sufficient
```

Recommended default:

```text
Do not block reviews on perfect embedding coverage.
Require a minimum coverage threshold only for repos with no useful lexical/graph context.
```

Suggested thresholds:

```text
minimumEmbeddingCoverageForSemanticSearch: 0.60
idealEmbeddingCoverage: 0.95
```

The orchestrator should ask the embedding planner:

```ts
export interface EmbeddingPlanner {
  assessCoverage(input: {
    repoId: string;
    indexVersionId: string;
    embeddingProfile: string;
  }): Promise<EmbeddingCoverageAssessment>;

  enqueueMissingEmbeddings(input: {
    repoId: string;
    indexVersionId: string;
    reason: "review_dependency" | "background";
    reviewRunId?: string;
  }): Promise<void>;
}
```

---

## 17. Stage 6: Build ChangeSet

The `ChangeSet` is the normalized representation of what changed in the PR.

Inputs:

```text
PullRequestSnapshot
DiffModel
base/head index versions if available
```

Outputs:

```text
ChangedFile[]
ChangedSymbol[]
ChangedRange[]
ChangeClassification
```

Example shape:

```ts
export type ChangeSet = {
  schemaVersion: "change_set.v1";
  reviewRunId: string;
  repoId: string;
  pullRequestNumber: number;
  baseSha: string;
  headSha: string;

  files: ChangedFile[];
  changedSymbols: ChangedSymbol[];

  stats: {
    fileCount: number;
    addedLines: number;
    deletedLines: number;
    modifiedLines: number;
    reviewableFileCount: number;
    ignoredFileCount: number;
  };

  classifications: Array<{
    kind:
      | "dependency_change"
      | "schema_change"
      | "auth_change"
      | "test_change"
      | "config_change"
      | "generated_change"
      | "large_refactor"
      | "migration_change";
    confidence: number;
    filePaths: string[];
    reason: string;
  }>;
};
```

The orchestrator can delegate changed-symbol extraction to retrieval or the PR snapshot package, but it should persist the final `ChangeSet` artifact.

---

## 18. Stage 7: Retrieve context

The orchestrator calls retrieval with the immutable snapshot and change set.

```ts
const contextBundle = await retrieval.retrieveContext({
  reviewRunId: run.id,
  repoId: run.repoId,
  pullRequestNumber: snapshot.pullRequestNumber,
  baseSha: snapshot.baseSha,
  headSha: snapshot.headSha,
  baseIndexVersionId,
  headIndexVersionId,
  snapshot,
  changeSet,
  retrievalProfile: run.retrievalProfile,
  tokenBudget: settings.contextTokenBudget,
});
```

The orchestrator should not inspect DB/vector/graph tables directly.

It should persist:

```text
context_bundle artifact
retrieval_trace artifact
retrieval summary in review_artifacts
```

Context retrieval should be deterministic given:

```text
snapshot hash
index versions
embedding profile
retrieval profile
repo rules hash
memory facts hash
```

---

## 19. Stage 8: Run review engine

The orchestrator calls the review engine, which runs specialized passes.

Inputs:

```text
PullRequestSnapshot
ChangeSet
ContextBundle
RepositorySettings
RepoRules
MemoryFacts
ReviewProfile
```

Outputs:

```text
PR summary
CandidateFinding[]
review pass traces
LLM call refs
```

Orchestrator call:

```ts
const reviewOutput = await reviewEngine.review({
  reviewRunId: run.id,
  snapshot,
  changeSet,
  contextBundle,
  settings,
  reviewProfile,
});
```

The orchestrator should persist:

```text
review_output artifact
candidate_findings rows
prompt/LLM call refs from LLM gateway
pass summary artifact
```

The review engine should not publish findings. It only returns structured candidates.

---

## 20. Stage 9: Validate, rank, and select findings

The orchestrator calls the finding validator / quality gate.

Inputs:

```text
CandidateFinding[]
PullRequestSnapshot
DiffModel / LineAnchorIndex
ContextBundle
RepositorySettings
RepoRules
MemoryFacts
```

Outputs:

```text
ValidatedFinding[]
RejectedFinding[]
ReviewSummary
```

Pseudo-code:

```ts
const validationOutput = await findingValidator.validate({
  reviewRunId: run.id,
  snapshot,
  lineAnchorIndex,
  contextBundle,
  candidates: reviewOutput.candidateFindings,
  settings,
  rules,
  memoryFacts,
});
```

The orchestrator should persist:

```text
validated findings
rejected findings with reasons
ranking report
comment budget decision
```

Recommended selection limits:

```text
small ReviewSizeClass: 3 inline comments max
medium ReviewSizeClass: 5 inline comments max
large ReviewSizeClass: 8 inline comments max
huge ReviewSizeClass: summary-first; inline only when exact anchors are available
critical findings can exceed cap only if explicit setting allows it
```

---

## 21. Stage 10: Enqueue publishing

Publishing should be a separate job.

Reasons:

```text
- GitHub rate limits are separate from review logic
- stale-run checks should happen immediately before posting
- publishing may need retries independent of review
- dry-run/debug modes should skip publishing cleanly
```

Flow:

```text
validated findings persisted
  -> review.publish job enqueued
  -> review run status publish_queued
```

Publish job payload:

```ts
export type PublishReviewJobPayload = {
  schemaVersion: "publish_review_job.v1";
  reviewRunId: string;
  repoId: string;
  provider: "github";
  providerInstallationId: string;
  pullRequestNumber: number;
  headSha: string;
  mode: PublishMode;
  enqueuedAt: string;
};
```

`PublishMode` is the canonical publisher mode contract from #0.

Before enqueueing publish, the orchestrator should check:

```text
- run is not dry_run
- findings or summary exist
- PR is still eligible enough to publish
```

The publisher still performs its own final staleness check.

---

## 22. Staleness and supersession

PRs move quickly. The orchestrator must assume the PR head can change between any two stages.

Staleness checks should happen:

```text
- after snapshot fetch
- after waiting for index dependencies
- before retrieval
- before review engine
- before enqueueing publish
- inside publisher before posting
```

Recommended helper:

```ts
export async function assertReviewRunCurrent(input: {
  reviewRunId: string;
  repoId: string;
  pullRequestNumber: number;
  expectedHeadSha: string;
}): Promise<"current" | "superseded" | "closed" | "unknown">;
```

When superseded:

```text
- mark old run superseded
- stop processing
- do not publish
- optionally enqueue new review for current head if one does not exist
```

Do not publish comments for old head SHAs unless explicitly configured for historical/manual debug runs.

---

## 23. Error model

Use structured errors so retry behavior is predictable.

```ts
export type ReviewOrchestratorErrorKind =
  | "configuration_error"
  | "permissions_error"
  | "provider_unavailable"
  | "provider_rate_limited"
  | "snapshot_fetch_failed"
  | "diff_parse_failed"
  | "index_dependency_failed"
  | "embedding_dependency_failed"
  | "retrieval_failed"
  | "review_engine_failed"
  | "validation_failed"
  | "artifact_write_failed"
  | "stale_review_run"
  | "budget_exceeded"
  | "unknown";
```

Classify every error as:

```ts
export type RetryDisposition =
  | "retry_immediately"
  | "retry_with_backoff"
  | "wait_for_dependency"
  | "do_not_retry"
  | "supersede"
  | "skip";
```

Examples:

| Error | Disposition |
|---|---|
| GitHub 500 | retry with backoff |
| GitHub rate limit | retry with backoff / scheduled resume |
| Repo disabled | skip |
| PR closed | skip |
| Head SHA changed | supersede |
| Missing index | wait for dependency |
| LLM timeout | retry with backoff, up to cap |
| Diff too large | skip or summary-only fallback |
| Invalid candidate finding schema | validation failed, maybe continue with other candidates |

BullMQ supports retry attempts and backoff for failed jobs, but durable review state should live in Postgres rather than only in Redis job state.

---

## 23.1 Failure transition table

Every stage failure must record a stage event and then perform exactly one durable review-run transition before the worker retries, waits, or exits.

| Error kind | Retry disposition | Durable review status |
|---|---|---|
| `configuration_error` | `do_not_retry` | `failed` |
| `permissions_error` | `do_not_retry` or `skip` | `skipped` when user/actionable policy blocks review, otherwise `failed` |
| `provider_unavailable` | `retry_with_backoff` | stay in current non-terminal status |
| `provider_rate_limited` | `retry_with_backoff` | stay in current non-terminal status |
| `snapshot_fetch_failed` | `retry_with_backoff` | `snapshotting` until retry cap, then `failed` |
| `diff_parse_failed` | `skip` or summary fallback | `skipped` when no safe summary fallback exists, otherwise continue in `reviewing` with `summary_only` |
| `index_dependency_failed` | `wait_for_dependency` | `waiting_for_index` until dependency fails terminally, then `failed` |
| `embedding_dependency_failed` | `wait_for_dependency` or degraded review | `waiting_for_embeddings` or continue as `diff_only`/`repo_context` without embeddings |
| `retrieval_failed` | `retry_with_backoff` or degraded review | `retrieving_context` until retry cap, then continue as `diff_only` or `failed` |
| `review_engine_failed` | `retry_with_backoff` | `reviewing` until retry cap, then `failed` |
| `validation_failed` | `do_not_retry` for schema/system bugs, otherwise continue with rejected candidates | `validating_findings` or `failed` |
| `artifact_write_failed` | `retry_with_backoff` | stay in current non-terminal status until retry cap, then `failed` |
| `stale_review_run` | `supersede` | `superseded` |
| `budget_exceeded` | `skip` or summary fallback | `skipped` when no safe fallback exists, otherwise continue as `summary_only` |
| `unknown` | `retry_with_backoff` | stay in current non-terminal status until retry cap, then `failed` |

The stage wrapper records timing and normalized error metadata. The orchestration entrypoint owns classification and status transition so failure behavior remains explicit and testable.

---

## 24. Retry strategy

Use retries at two levels:

```text
Queue-level retries:
  for transient worker/job failures

Stage-level retries:
  for orchestration stages with persisted progress
```

Recommended job options:

```ts
const reviewJobOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 10_000 },
  removeOnComplete: { age: 60 * 60 * 24, count: 1_000 },
  removeOnFail: { age: 60 * 60 * 24 * 7, count: 5_000 },
};
```

Do not rely only on BullMQ job retention for audit/debugging. Persist durable review state in Postgres.

---

## 25. Artifact strategy

The orchestrator should persist all major intermediate artifacts.

Use the canonical `ReviewArtifactKind` contract from #0 and the `review_artifacts` table from #2. This phase should attach orchestration artifacts; it should not define a phase-local artifact kind enum.

Store large artifacts in object storage:

```text
s3://bucket/orgs/{orgId}/repos/{repoId}/reviews/{reviewRunId}/context-bundle.json
```

DB row:

```ts
export type ReviewArtifactRef = {
  id: string;
  reviewRunId: string;
  kind: ReviewArtifactKind;
  uri: string;
  contentHash: string;
  byteSize: number;
  compression?: "gzip" | "zstd" | "none";
  redactionStatus: "not_required" | "redacted" | "contains_code";
  createdAt: string;
};
```

Artifact rules:

```text
- include schemaVersion in every artifact
- hash artifact contents
- record byte size
- compress large JSON artifacts
- never store provider tokens
- keep raw code artifacts according to retention policy
- make artifacts inspectable in the dashboard
```

---

## 26. Budget controls

The orchestrator should enforce budgets before expensive work.

Budgets:

```text
max changed files
max raw diff bytes
max changed lines
max context token budget
max LLM calls per review
max model tokens per review
max estimated cost per review
max wall-clock review duration
```

Budget behavior:

```text
If diff too large:
  summary_only or skip

If context too large:
  retrieval packs highest-value items only

If LLM cost budget exceeded:
  stop lower-priority passes

If time budget exceeded:
  publish summary + findings produced so far only if valid
```

Recommended orchestrator config:

```ts
export type ReviewOrchestratorConfig = {
  defaultMode: ReviewExecutionMode;
  allowDiffOnlyFallback: boolean;
  maxChangedFiles: number;
  maxRawDiffBytes: number;
  maxPatchLines: number;
  maxContextTokens: number;
  maxCandidateFindings: number;
  maxPublishedFindings: number;
  maxReviewDurationMs: number;
  staleCheckEnabled: boolean;
  requireBaseIndexForRepoContext: boolean;
  requireHeadIndexForRepoContext: boolean;
  minimumEmbeddingCoverage: number;
};
```

---

## 27. Concurrency model

Multiple events can arrive for the same PR.

Rules:

```text
- allow only one active review run per repo + PR + headSha + settingsHash
- newer head SHA supersedes older active runs
- manual reruns may coexist only if they have explicit nonce and dry-run/debug policy
- never publish from superseded runs
```

Use database-level idempotency for creating runs:

```sql
create unique index review_runs_idempotency_key_idx
on review_runs (idempotency_key);
```

Use short advisory locks for critical sections:

```text
review-run creation
state transition
dependency satisfaction update
publication enqueue
```

Do not hold locks while:

```text
fetching GitHub API
waiting for index jobs
running retrieval
calling LLMs
validating large finding sets
```

---

## 28. Resume behavior

The orchestrator should support explicit resume jobs.

```ts
export type ResumeReviewJobPayload = {
  schemaVersion: "resume_review_job.v1";
  reviewRunId: string;
  reason:
    | "index_dependency_ready"
    | "embedding_dependency_ready"
    | "manual_resume"
    | "worker_reconciliation"
    | "retry_after_failure";
  enqueuedAt: string;
};
```

Resume should inspect the current run state and continue from the next incomplete stage.

```ts
async function resumeReviewRun(reviewRunId: string) {
  const run = await reviewRuns.get(reviewRunId);

  switch (run.status) {
    case "waiting_for_index":
      return continueAfterIndex(run);
    case "waiting_for_embeddings":
      return continueAfterEmbeddings(run);
    case "retrieving_context":
      return runRetrievalStage(run);
    case "reviewing":
      return runReviewStage(run);
    case "validating_findings":
      return runValidationStage(run);
    case "publish_queued":
    case "completed":
    case "skipped":
    case "superseded":
    case "canceled":
    case "failed":
      return { action: "noop", reason: `terminal_or_already_handed_off:${run.status}` };
    default:
      return executeReviewRun(reviewRunId);
  }
}
```

---

## 29. Cancellation

Support cancellation for:

```text
- PR closed
- PR merged
- repo disabled
- installation removed
- newer head SHA arrived
- manual admin cancellation
```

Cancellation should:

```text
- mark active review run canceled or superseded
- prevent publish jobs from posting
- signal child jobs where possible
- leave artifacts intact for debug
```

Index jobs may continue if they are useful for future PRs, unless the repo was disabled or installation removed.

---

## 30. Dry-run and debug modes

Dry-run mode should run the full pipeline without publishing.

Use cases:

```text
- internal testing
- customer preview
- evaluation harness
- prompt experiments
- replaying old review runs
```

Dry-run should still persist:

```text
snapshot
context bundle
candidate findings
validated findings
rejection report
cost metrics
```

But it should not enqueue `review.publish`.

Debug mode may additionally persist:

```text
expanded retrieval traces
full prompt payloads if allowed
model raw responses
stage timings
intermediate ranking scores
```

Debug artifacts must respect redaction and retention settings.

---

## 31. Replay support

Replay is essential for improving quality.

Supported replay types:

```text
- replay from snapshot + old context
- replay from snapshot + fresh retrieval
- replay from old candidates through new validator
- replay with new prompt version
- replay with new model profile
```

Recommended replay input:

```ts
export type ReplayReviewInput = {
  sourceReviewRunId: string;
  replayMode:
    | "reuse_context"
    | "reretrieve_context"
    | "rejudge_candidates"
    | "full_replay";
  reviewProfileOverride?: string;
  dryRun: true;
  reason: string;
};
```

Replay runs should have a parent/child relationship:

```text
review_runs.parent_review_run_id
review_runs.trigger = replay
```

Never publish replay output unless a user explicitly promotes it and it is still current.

---

## 32. Orchestrator repository interface

Create a repository abstraction for DB operations.

```ts
export interface ReviewRunRepository {
  createOrGetRun(input: CreateReviewRunInput): Promise<CreateOrGetReviewRunResult>;

  getRun(reviewRunId: string): Promise<ReviewRun>;

  transition(input: {
    reviewRunId: string;
    from?: ReviewRunStatus[];
    to: ReviewRunStatus;
    reason?: string;
    metadata?: Record<string, unknown>;
  }): Promise<ReviewRun>;

  recordStageEvent(input: RecordStageEventInput): Promise<void>;

  attachArtifact(input: AttachReviewArtifactInput): Promise<void>;

  recordDependencies(input: RecordReviewDependenciesInput): Promise<void>;

  getPendingDependencies(reviewRunId: string): Promise<ReviewRunDependency[]>;

  markDependencySatisfied(input: MarkDependencySatisfiedInput): Promise<void>;

  markSkipped(input: MarkReviewSkippedInput): Promise<void>;

  markFailed(input: MarkReviewFailedInput): Promise<void>;

  markSuperseded(input: MarkReviewSupersededInput): Promise<void>;
}
```

Keep SQL in repository methods, not inside orchestration logic.

---

## 33. Stage runner helper

Use a generic stage wrapper to standardize logging, tracing, timings, and error recording.

```ts
export async function runStage<T>(input: {
  reviewRunId: string;
  stage: ReviewStageName;
  telemetry: Telemetry;
  reviewRuns: ReviewRunRepository;
  fn: () => Promise<T>;
}): Promise<T> {
  const startedAt = new Date();

  await input.reviewRuns.recordStageEvent({
    reviewRunId: input.reviewRunId,
    stage: input.stage,
    status: "started",
    startedAt: startedAt.toISOString(),
  });

  try {
    const result = await input.telemetry.trace(`review.${input.stage}`, input.fn);

    await input.reviewRuns.recordStageEvent({
      reviewRunId: input.reviewRunId,
      stage: input.stage,
      status: "completed",
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
    });

    return result;
  } catch (error) {
    await input.reviewRuns.recordStageEvent({
      reviewRunId: input.reviewRunId,
      stage: input.stage,
      status: "failed",
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      metadata: normalizeError(error),
    });

    throw error;
  }
}
```

---

## 34. Main orchestration pseudo-code

```ts
export async function executeReviewRun(reviewRunId: string): Promise<ReviewOrchestratorResult> {
  let run = await reviewRuns.getRun(reviewRunId);

  run = await reviewRuns.transition({
    reviewRunId,
    from: ["created", "snapshotting"],
    to: "snapshotting",
  });

  const snapshotArtifacts = await runStage({
    reviewRunId,
    stage: "snapshot",
    fn: () => snapshotBuilder.build({
      repoId: run.repoId,
      pullRequestNumber: run.pullRequestNumber,
      providerInstallationId: run.providerInstallationId,
    }),
  });

  await artifactWriter.attachSnapshotArtifacts(run.id, snapshotArtifacts);

  const gate = await runStage({
    reviewRunId,
    stage: "gating",
    fn: () => reviewGating.evaluate({
      run,
      snapshot: snapshotArtifacts.snapshot,
      settings: run.settings,
    }),
  });

  if (gate.action === "skip") {
    await reviewRuns.markSkipped({
      reviewRunId,
      reason: gate.reason,
      metadata: gate.details,
    });
    return { status: "skipped", reviewRunId };
  }

  const indexDecision = await runStage({
    reviewRunId,
    stage: "ensure_indexes",
    fn: () => ensureIndexDependencies(run, snapshotArtifacts.snapshot, gate.mode),
  });

  if (indexDecision.action === "pause") {
    await reviewRuns.transition({ reviewRunId, to: "waiting_for_index" });
    return { status: "waiting_for_index", reviewRunId };
  }

  const embeddingDecision = await runStage({
    reviewRunId,
    stage: "ensure_embeddings",
    fn: () => ensureEmbeddingCoverage(run, indexDecision.indexVersions),
  });

  if (embeddingDecision.action === "pause") {
    await reviewRuns.transition({ reviewRunId, to: "waiting_for_embeddings" });
    return { status: "waiting_for_embeddings", reviewRunId };
  }

  await assertCurrentOrSupersede(run, snapshotArtifacts.snapshot.headSha);

  await reviewRuns.transition({ reviewRunId, to: "retrieving_context" });

  const changeSet = await runStage({
    reviewRunId,
    stage: "build_change_set",
    fn: () => changeSetBuilder.build({
      run,
      snapshot: snapshotArtifacts.snapshot,
      diffModel: snapshotArtifacts.diffModel,
      indexVersions: indexDecision.indexVersions,
    }),
  });

  await artifactWriter.attachJson(run.id, "change_set", changeSet);

  const contextBundle = await runStage({
    reviewRunId,
    stage: "retrieve_context",
    fn: () => retrieval.retrieveContext({
      reviewRunId,
      snapshot: snapshotArtifacts.snapshot,
      changeSet,
      indexVersions: indexDecision.indexVersions,
      settings: run.settings,
    }),
  });

  await artifactWriter.attachJson(run.id, "context_bundle", contextBundle);

  await assertCurrentOrSupersede(run, snapshotArtifacts.snapshot.headSha);

  await reviewRuns.transition({ reviewRunId, to: "reviewing" });

  const reviewOutput = await runStage({
    reviewRunId,
    stage: "review",
    fn: () => reviewEngine.review({
      reviewRunId,
      snapshot: snapshotArtifacts.snapshot,
      changeSet,
      contextBundle,
      settings: run.settings,
    }),
  });

  await artifactWriter.attachJson(run.id, "review_output", reviewOutput);

  await reviewRuns.transition({ reviewRunId, to: "validating_findings" });

  const validationOutput = await runStage({
    reviewRunId,
    stage: "validate_findings",
    fn: () => findingValidator.validate({
      reviewRunId,
      snapshot: snapshotArtifacts.snapshot,
      lineAnchorIndex: snapshotArtifacts.lineAnchorIndex,
      contextBundle,
      candidates: reviewOutput.candidateFindings,
      settings: run.settings,
    }),
  });

  await reviewRuns.persistFindings(reviewRunId, validationOutput);
  await artifactWriter.attachJson(run.id, "validated_findings", validationOutput);

  await assertCurrentOrSupersede(run, snapshotArtifacts.snapshot.headSha);

  if (run.mode === "dry_run") {
    await reviewRuns.transition({ reviewRunId, to: "completed", reason: "dry_run_complete" });
    return { status: "completed", reviewRunId };
  }

  await queue.enqueue("review.publish", {
    schemaVersion: "publish_review_job.v1",
    reviewRunId,
    repoId: run.repoId,
    provider: run.provider,
    providerInstallationId: run.providerInstallationId,
    pullRequestNumber: run.pullRequestNumber,
    headSha: snapshotArtifacts.snapshot.headSha,
    mode: determinePublishMode(run, validationOutput),
    enqueuedAt: new Date().toISOString(),
  });

  await reviewRuns.transition({ reviewRunId, to: "publish_queued" });

  return { status: "publish_queued", reviewRunId };
}
```

---

## 35. Worker integration

`/apps/worker/src/handlers/review-pr.ts`

```ts
import { createReviewOrchestrator } from "@repo/review-orchestrator";
import { createDeps } from "../deps";

export async function handleReviewPRJob(payload: ReviewPRJobPayload) {
  const deps = await createDeps();
  const orchestrator = createReviewOrchestrator(deps);
  return orchestrator.run(payload);
}
```

`/apps/worker/src/handlers/review-resume.ts`

```ts
export async function handleResumeReviewJob(payload: ResumeReviewJobPayload) {
  const deps = await createDeps();
  const orchestrator = createReviewOrchestrator(deps);
  return orchestrator.resume(payload.reviewRunId, payload.reason);
}
```

Worker concurrency recommendations:

```text
review-pr workers: low/medium concurrency, LLM-bound
review-resume workers: same pool as review-pr or separate small pool
index workers: separate CPU-heavy pool
embedding workers: separate rate-limited network pool
publish workers: separate GitHub-rate-limited pool
```

---

## 36. Config

```ts
export const ReviewOrchestratorConfigSchema = Type.Object({
  REVIEW_DEFAULT_MODE: Type.Union([
    Type.Literal("summary_only"),
    Type.Literal("diff_only"),
    Type.Literal("repo_context"),
    Type.Literal("full"),
  ]),

  REVIEW_ALLOW_DIFF_ONLY_FALLBACK: Type.Boolean(),
  REVIEW_REQUIRE_BASE_INDEX: Type.Boolean(),
  REVIEW_REQUIRE_HEAD_INDEX: Type.Boolean(),

  REVIEW_MAX_CHANGED_FILES: Type.Integer({ minimum: 1 }),
  REVIEW_MAX_RAW_DIFF_BYTES: Type.Integer({ minimum: 1 }),
  REVIEW_MAX_PATCH_LINES: Type.Integer({ minimum: 1 }),
  REVIEW_MAX_CONTEXT_TOKENS: Type.Integer({ minimum: 1 }),
  REVIEW_MAX_CANDIDATE_FINDINGS: Type.Integer({ minimum: 1 }),
  REVIEW_MAX_PUBLISHED_FINDINGS: Type.Integer({ minimum: 0 }),
  REVIEW_MAX_DURATION_MS: Type.Integer({ minimum: 1 }),

  REVIEW_MIN_EMBEDDING_COVERAGE: Type.Number({ minimum: 0, maximum: 1 }),

  REVIEW_ENABLE_REPLAY: Type.Boolean(),
  REVIEW_ENABLE_DEBUG_ARTIFACTS: Type.Boolean(),
  REVIEW_ARTIFACT_RETENTION_DAYS: Type.Integer({ minimum: 1 }),
});
```

Recommended defaults:

```text
REVIEW_DEFAULT_MODE=repo_context
REVIEW_ALLOW_DIFF_ONLY_FALLBACK=true
REVIEW_REQUIRE_BASE_INDEX=true
REVIEW_REQUIRE_HEAD_INDEX=false
REVIEW_MAX_CHANGED_FILES=200
REVIEW_MAX_RAW_DIFF_BYTES=2000000
REVIEW_MAX_PATCH_LINES=15000
REVIEW_MAX_CONTEXT_TOKENS=60000
REVIEW_MAX_CANDIDATE_FINDINGS=50
REVIEW_MAX_PUBLISHED_FINDINGS=8
REVIEW_MAX_DURATION_MS=900000
REVIEW_MIN_EMBEDDING_COVERAGE=0.60
REVIEW_ENABLE_REPLAY=true
REVIEW_ENABLE_DEBUG_ARTIFACTS=false
REVIEW_ARTIFACT_RETENTION_DAYS=30
```

---

## 37. Observability

Every review run should have a trace with stage spans.

Recommended span names:

```text
review.orchestrator.run
review.snapshot.build
review.gating.evaluate
review.index.ensure
review.embedding.ensure
review.changeset.build
review.context.retrieve
review.engine.run
review.findings.validate
review.publish.enqueue
```

Span attributes:

```text
org.id
repo.id
provider
pull_request.number
review_run.id
base_sha
head_sha
trigger
mode
stage
status
changed_file_count
patch_line_count
candidate_finding_count
validated_finding_count
published_finding_count
```

Metrics:

```text
review_runs_started_total
review_runs_completed_total
review_runs_skipped_total
review_runs_failed_total
review_runs_superseded_total
review_stage_duration_ms
review_total_duration_ms
review_context_token_count
review_candidate_finding_count
review_validated_finding_count
review_publish_queued_total
review_cost_estimated_usd
```

OpenTelemetry is appropriate for traces and metrics across the worker/API boundary.

---

## 38. Logs

Every log line should include:

```text
reviewRunId
repoId
pullRequestNumber
headSha
stage
jobId
```

Example structured log:

```json
{
  "level": "info",
  "message": "review context retrieved",
  "reviewRunId": "rr_abc",
  "repoId": "repo_123",
  "pullRequestNumber": 42,
  "headSha": "abc123",
  "stage": "retrieve_context",
  "contextItemCount": 37,
  "contextTokenCount": 48213,
  "durationMs": 1287
}
```

Never log:

```text
- GitHub tokens
- raw authorization headers
- private keys
- full model prompts unless debug logging is explicitly enabled
- secrets detected in code
```

---

## 39. Security and privacy

The orchestrator must treat code and prompt artifacts as sensitive.

Rules:

```text
- Do not include installation tokens in artifacts.
- Do not put tokens in job payloads.
- Do not put raw prompts in standard logs.
- Redact secrets before storing prompt artifacts if prompt logging is enabled.
- Respect repo/org data retention settings.
- Enforce org membership when exposing review artifacts in dashboard.
- Do not allow replay across org boundaries.
```

Artifact access should require:

```text
org membership
repo visibility permission
appropriate role for debug/prompt artifacts
```

---

## 40. Testing strategy

### Unit tests

```text
- idempotency key generation
- state machine transitions
- gating decisions
- dependency planning
- staleness behavior
- error classification
- budget checks
- publish mode selection
```

### Integration tests with fakes

Use fake implementations:

```text
FakeGitProvider
FakeSnapshotBuilder
FakeIndexRepository
FakeRetrievalEngine
FakeReviewEngine
FakeFindingValidator
FakeQueueClient
FakeArtifactStore
```

Scenarios:

```text
- happy path full review
- index missing -> waits -> resume -> completes
- embedding partial -> continues with fallback
- PR closed -> skipped
- repo disabled -> skipped
- duplicate job -> same review run reused
- newer head arrives -> old run superseded
- LLM failure -> retry/failed based on attempts
- dry run -> no publish job
- no findings -> summary only
- invalid candidate finding -> rejected but run completes
```

### DB tests

```text
- createOrGetRun idempotency
- state transition guards
- dependency uniqueness
- artifact refs
- advisory lock helper
```

### End-to-end fixture tests

Use local fixture PR data:

```text
fixtures/reviews/simple-ts-change
fixtures/reviews/security-regression
fixtures/reviews/large-pr-fallback
fixtures/reviews/stale-head
fixtures/reviews/missing-index
```

Each fixture should include:

```text
snapshot.json
raw.diff
index artifacts
expected context summary
fake review candidates
expected validated findings
expected review run final state
```

---

## 41. Local development commands

Useful commands:

```bash
# Run a review job from a fixture
pnpm dev:review-fixture fixtures/reviews/simple-ts-change

# Resume an existing review run
pnpm dev:review-resume rr_123

# Replay review using old context
pnpm dev:review-replay rr_123 --reuse-context

# Run just gating
pnpm dev:review-gate fixtures/reviews/large-pr-fallback/snapshot.json

# Dump review artifacts
pnpm dev:review-artifacts rr_123
```

Optional CLI package:

```text
/packages/review-orchestrator-cli
```

But for MVP, scripts inside `/apps/worker` are enough.

---

## 42. Implementation sequence

### PR 1: Package skeleton and interfaces

Build:

```text
/packages/review-orchestrator
  config
  types
  errors
  orchestrator interface
  dependency injection container shape
  fake dependencies
```

Deliverables:

```text
- package compiles
- unit tests run
- no real integrations yet
```

---

### PR 2: ReviewRun repository and state machine

Build:

```text
ReviewRunRepository
state transition helper
stage event recorder
idempotency key helper
advisory lock helper
```

Deliverables:

```text
- createOrGetRun works
- duplicate job returns same run
- invalid transitions rejected
- terminal states protected
```

---

### PR 3: Snapshot and gating integration

Build:

```text
snapshot stage
artifact attachment
review gating
skip handling
```

Deliverables:

```text
- PR can be skipped deterministically
- snapshot artifact is attached
- diff-too-large fallback works
```

---

### PR 4: Index dependency planning

Build:

```text
index dependency planner
review_run_dependencies support
repo.index enqueueing
waiting_for_index transition
resume from dependency ready
```

Deliverables:

```text
- missing index pauses review
- completed index resumes review
- no worker blocks waiting for another job
```

---

### PR 5: Embedding coverage handling

Build:

```text
embedding coverage assessment
optional wait_for_embeddings
background embedding enqueue
fallback behavior
```

Deliverables:

```text
- retrieval can proceed with partial coverage when configured
- strict mode waits when coverage too low
```

---

### PR 6: ChangeSet and retrieval integration

Build:

```text
ChangeSet builder wiring
retrieval engine call
context bundle artifact
retrieval trace artifact
```

Deliverables:

```text
- review run can produce ContextBundle
- artifacts visible in DB/dashboard
```

---

### PR 7: Review engine integration

Build:

```text
review engine call
candidate finding persistence
review output artifact
LLM usage handoff
```

Deliverables:

```text
- candidate findings produced from fake or real review engine
- structured output persisted
```

---

### PR 8: Validation and publish enqueue

Build:

```text
finding validator call
validated/rejected finding persistence
publish job enqueue
publish_queued status
```

Deliverables:

```text
- valid findings enqueue publisher
- dry-run does not enqueue publisher
- no findings can still summary-only publish if configured
```

---

### PR 9: Staleness, cancellation, and supersession

Build:

```text
current-head checks
supersede old runs
cancel active runs
prevent stale publish enqueue
```

Deliverables:

```text
- old run cannot publish after new commit
- PR closed cancels/skips active run
```

---

### PR 10: Observability and hardening

Build:

```text
OpenTelemetry spans
metrics
structured logs
budget metrics
stage timing
error dashboards
```

Deliverables:

```text
- review trace shows every stage
- stage durations and failure reasons visible
```

---

## 43. MVP cut

For MVP, implement:

```text
- ReviewOrchestrator package
- ReviewRunRepository
- idempotent review run creation
- state machine
- snapshot stage
- gating stage
- base-index dependency check
- pause/resume around missing index
- ChangeSet artifact
- retrieval call
- review engine call
- finding validator call
- publish job enqueue
- dry-run support
- basic stage events
- basic metrics/logs
- fake dependency tests
```

Skip initially:

```text
- strict embedding wait state
- complex replay modes
- Temporal migration layer
- advanced cancellation propagation
- full cost budgeting
- multi-provider Git provider behavior
- manual admin controls beyond basic resume/replay
```

---

## 44. Definition of done

#16 is done when:

```text
- A pull_request webhook can enqueue review.pr.
- review.pr creates an idempotent review run.
- The orchestrator fetches and persists a PR snapshot artifact.
- The orchestrator skips ineligible PRs with clear reasons.
- Missing index versions pause the run and enqueue index jobs.
- Completed dependencies can resume the run.
- The orchestrator produces a ChangeSet.
- The orchestrator calls retrieval and persists a ContextBundle artifact.
- The orchestrator calls review engine and persists candidate findings.
- The orchestrator calls finding validator and persists validated/rejected findings.
- The orchestrator enqueues review.publish for publishable runs.
- Old runs are superseded when PR head changes.
- Dry-run mode performs all stages except publishing.
- Every stage emits structured logs, metrics, and stage events.
- Duplicate jobs are safe.
- Worker crashes can retry or resume without duplicating comments.
```

---

## 45. References

- BullMQ retrying failing jobs: https://docs.bullmq.io/guide/retrying-failing-jobs
- BullMQ auto-removal of jobs: https://docs.bullmq.io/guide/queues/auto-removal-of-jobs
- Temporal durable execution overview: https://temporal.io/
- Temporal TypeScript SDK docs: https://docs.temporal.io/develop/typescript
- OpenTelemetry JavaScript docs: https://opentelemetry.io/docs/languages/js/
- OpenTelemetry Node.js getting started: https://opentelemetry.io/docs/languages/js/getting-started/nodejs/
