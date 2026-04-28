# #7 Job Queue and Orchestration Implementation Spec

Version: `job_queue_orchestration.v1`  
Date: 2026-04-28  
Owner: Platform/Infrastructure  
Primary app: `/apps/worker`  
Primary packages: `/packages/queue`, `/packages/contracts`, `/packages/db`, `/packages/observability`  
Primary stack: BullMQ, Redis, Postgres, Drizzle, Bun/Node worker runtime, OpenTelemetry

---

## 1. Purpose

The job queue and orchestration layer is the asynchronous execution backbone of the system.

It should handle work that is too slow, expensive, retryable, or failure-prone to run inside the API server or webhook request lifecycle.

Examples:

```text
- syncing GitHub App installations
- syncing repositories
- indexing repo commits
- importing index artifacts
- embedding code chunks
- reviewing pull requests
- publishing review comments/check runs
- processing feedback into memory
- recording usage events
- running cleanup/reconciliation jobs
```

The queue system should make the product:

```text
- reliable
- observable
- horizontally scalable
- retry-safe
- idempotent
- debuggable
- backpressure-aware
- easy to migrate to Temporal later
```

The queue system should **not** hide business logic in Redis, BullMQ callbacks, or ad hoc worker functions. Business logic should live in named services and domain packages. The queue layer should coordinate durable commands.

---

## 2. Non-goals

This section does **not** implement:

```text
- GitHub-specific API calls
- repo cloning internals
- indexer internals
- embedding model internals
- LLM review internals
- publishing format internals
- memory classification internals
- dashboard UI
- billing logic
```

Those belong to other sections.

This section owns:

```text
- job contracts
- durable job creation
- Redis/BullMQ enqueueing
- worker registration
- retry policy
- cancellation semantics
- worker pools
- orchestration state transitions
- queue observability
- dead-letter/reconciliation behavior
```

---

## 3. External facts and stack assumptions

### 3.1 BullMQ

BullMQ is the MVP queue library.

The useful facts for this architecture:

```text
- BullMQ is a Node.js queue library built on Redis.
- It is designed for horizontal worker scaling.
- It provides job processing, retries, delays, priorities, rate limiting, and queue events.
- Its delivery goal is effectively exactly-once in the common case, with at-least-once behavior in worst-case scenarios.
```

Because at-least-once behavior can happen, every job handler in this system must be idempotent.

### 3.2 Redis

Redis is the broker/cache for BullMQ. It is **not** the durable source of truth for application state.

Do not use Redis Pub/Sub for durable work. Redis Pub/Sub has at-most-once delivery semantics, which means messages can be lost if the subscriber cannot handle them. Durable jobs should be represented in Postgres and then enqueued into BullMQ.

### 3.3 Temporal migration path

Temporal is not required for the MVP, but the design should preserve a clean migration path.

Temporal Workflows can store state and orchestrate Activity functions. Temporal also provides resilient workflow execution that can continue across process crashes. The architecture below intentionally uses serializable single-object job payloads and explicit activity-like domain functions so the BullMQ job graph can later map to Temporal Workflows/Activities.

References are listed at the end of this document.

---

## 4. Core design principles

### 4.1 Postgres is the source of truth

BullMQ is the execution broker.

Postgres records:

```text
- what work exists
- why it exists
- who/what created it
- current durable status
- retry count
- error history
- parent/child relationships
- idempotency/dedupe keys
- review/index/artifact relationships
```

Redis/BullMQ records:

```text
- what should be picked up by workers now
- delayed jobs
- attempts/backoff state
- active job claims
- queue-level events
```

This distinction matters because Redis can be flushed, restarted, fail over, or temporarily unavailable. The system should be able to reconstruct enqueue state from Postgres.

### 4.2 Creating a job and enqueueing a job are different operations

Always distinguish:

```text
Create durable job row in Postgres
        !=
Add job to BullMQ
```

The safe flow is:

```text
transaction:
  insert background_jobs row with status = pending_enqueue
commit

outbox dispatcher:
  enqueue background job into BullMQ using deterministic jobId
  update background_jobs status = queued
```

Do not rely on "insert DB row + enqueue Redis job" being atomic. They are two different systems.

### 4.3 BullMQ job data should be small

A BullMQ job should usually contain only:

```ts
{
  backgroundJobId: BackgroundJobId;
  jobKind: JobKind;
}
```

The worker should load the full payload from Postgres.

This keeps Redis lean and avoids putting secrets, raw diffs, code snippets, prompts, or large payloads into BullMQ.

### 4.4 Job handlers must be idempotent

Every job can run more than once.

Reasons:

```text
- worker crash after side effect but before completion update
- Redis failover
- BullMQ retry
- manual replay
- stalled job recovery
- duplicate webhook delivery
- dispatcher re-enqueue
```

Therefore, every handler must be safe to run repeatedly.

Examples:

```text
- indexing repo@commit upserts the same CodeIndexVersion
- embedding a chunk uses contentHash dedupe
- publishing comments checks published_findings before creating GitHub comments
- reviewing a PR uses reviewRunId/promptVersion/headSha to avoid duplicate runs
- usage events use idempotency keys
```

### 4.5 Workers should not block while waiting for other jobs

Avoid this:

```text
review worker starts
  -> sees repo not indexed
  -> waits 20 minutes for index worker
```

Prefer this:

```text
review worker starts
  -> sees index missing
  -> creates index jobs
  -> marks review_run waiting_for_index
  -> exits

index worker completes
  -> enqueues review resume job
```

Worker slots are expensive. They should execute work, not wait for unrelated work.

### 4.6 Job orchestration should be state-driven

Use durable state transitions, not invisible control flow.

For example:

```text
review_run.status = waiting_for_index
review_run.status = retrieving_context
review_run.status = reviewing
review_run.status = validating
review_run.status = ready_to_publish
review_run.status = publishing
review_run.status = completed
```

The dashboard and internal tools should be able to explain where a review is stuck.

### 4.7 Queue package should not know business internals

`/packages/queue` should know how to:

```text
- create jobs
- enqueue jobs
- register workers
- wrap handlers
- apply retry/rate-limit/concurrency defaults
- update background_jobs status
- emit metrics
```

It should not know how to:

```text
- parse PR diffs
- index code
- call LLMs
- post GitHub comments
```

Business handlers live in domain packages or `/apps/worker/src/handlers`.

### 4.8 Prefer simple orchestration before workflow engines

MVP:

```text
BullMQ + Postgres state machine + reconciliation
```

Upgrade path:

```text
Temporal workflows for long-running, multi-step orchestration
```

Do not introduce Temporal on day one unless the team is already comfortable operating it.

---

## 5. System architecture

### 5.1 High-level architecture

```text
GitHub / Dashboard / API command
        |
        v
API server or webhook handler
        |
        | create durable job row
        v
Postgres background_jobs
        |
        | outbox dispatcher enqueues
        v
BullMQ / Redis
        |
        | workers consume jobs
        v
Worker app
        |
        | load payload from DB
        | run domain handler
        | update durable status
        v
Postgres + artifacts + external systems
```

### 5.2 Package/app boundary

```text
/apps/api
  - creates durable jobs
  - does not run jobs

/apps/worker
  - runs workers
  - registers handlers
  - owns process lifecycle

/packages/queue
  - queue names
  - job kind metadata
  - enqueue helpers
  - worker wrappers
  - dispatcher/reconciler utilities

/packages/contracts
  - job payload schemas
  - status enums
  - common ids

/packages/db
  - background_jobs table
  - helper queries
  - transactions/advisory locks

/packages/observability
  - logs, metrics, traces
```

### 5.3 Queue layer dependency direction

Allowed:

```text
/apps/worker -> /packages/queue
/apps/api -> /packages/queue
/packages/queue -> /packages/contracts
/packages/queue -> /packages/db
/packages/queue -> /packages/observability
```

Avoid:

```text
/packages/queue -> /packages/github
/packages/queue -> /packages/indexer-ts
/packages/queue -> /packages/review-engine
/packages/queue -> /packages/llm-gateway
```

The queue package should be infrastructure, not domain logic.

---

## 6. Queue names

Queue names should be stable, explicit, and namespaced by environment.

Recommended logical queues:

```text
github.sync
repo.index
embedding.batch
pr.review
review.publish
memory.update
usage.record
maintenance
```

Actual BullMQ names should include deployment prefix:

```text
${QUEUE_PREFIX}:github.sync
${QUEUE_PREFIX}:repo.index
${QUEUE_PREFIX}:embedding.batch
${QUEUE_PREFIX}:pr.review
${QUEUE_PREFIX}:review.publish
${QUEUE_PREFIX}:memory.update
${QUEUE_PREFIX}:usage.record
${QUEUE_PREFIX}:maintenance
```

Example:

```text
prod:github.sync
staging:github.sync
local:github.sync
```

### 6.1 Queue responsibilities

| Queue | Responsibility | Worker profile |
|---|---|---|
| `github.sync` | Installation/repo sync, metadata refresh | GitHub API-bound |
| `repo.index` | repo@commit indexing/import orchestration | CPU/disk-bound |
| `embedding.batch` | embedding generation for code chunks | provider/network-bound |
| `pr.review` | PR review orchestration and LLM review execution | LLM/network-bound |
| `review.publish` | GitHub comments/check runs/summaries | GitHub API-bound |
| `memory.update` | feedback classification and memory updates | low-priority mixed |
| `usage.record` | usage/cost aggregation | low-priority DB-bound |
| `maintenance` | reconciliation, cleanup, rollups, scheduled jobs | low-priority ops |

### 6.2 Why multiple queues

Multiple queues allow independent:

```text
- concurrency limits
- retry policy
- priority behavior
- rate limiting
- worker autoscaling
- metrics
- dead-letter handling
- operational ownership
```

Do not put everything into one queue.

---

## 7. Job kinds

Job kinds are more specific than queues.

A queue groups similar execution profiles. A job kind identifies the command.

Recommended job kinds:

```text
github.sync_installation
github.sync_repository
github.sync_repository_selection

github.refresh_installation_token_optional

repo.index_commit
repo.index_incremental
repo.import_index_artifact
repo.reconcile_waiting_reviews

embedding.embed_chunks
embedding.requeue_missing_embeddings

pr.review_request
pr.review_execute
pr.review_resume_after_index
pr.review_rereview
pr.review_cancel_outdated

review.publish
review.publish_summary
review.publish_inline_comments
review.update_check_run

memory.process_feedback_event
memory.classify_finding_outcome
memory.refresh_repo_memory

usage.record_event
usage.rollup_daily
usage.rollup_monthly

maintenance.enqueue_pending_jobs
maintenance.reconcile_running_jobs
maintenance.cleanup_old_jobs
maintenance.cleanup_artifacts
maintenance.refresh_queue_metrics
```

### 7.1 Job kind metadata

Each job kind should have a single metadata definition:

```ts
export type JobDefinition<TPayload> = {
  kind: JobKind;
  queueName: QueueName;
  payloadSchema: TSchema<TPayload>;
  defaultPriority: number;
  defaultMaxAttempts: number;
  defaultTimeoutMs: number;
  defaultBackoff: BackoffPolicy;
  dedupeKey: (payload: TPayload) => string;
  description: string;
};
```

The queue package should use these definitions to create durable jobs and register workers.

---

## 8. Durable job status model

The `background_jobs` table exists in #2 Database Layer. This section defines its intended lifecycle.

### 8.1 Recommended statuses

```ts
export const BackgroundJobStatus = {
  PendingEnqueue: "pending_enqueue",
  Queued: "queued",
  Running: "running",
  Waiting: "waiting",
  Succeeded: "succeeded",
  FailedRetryable: "failed_retryable",
  FailedTerminal: "failed_terminal",
  Canceled: "canceled",
  Dead: "dead",
} as const;
```

Meaning:

| Status | Meaning |
|---|---|
| `pending_enqueue` | Job exists in Postgres but has not been successfully added to BullMQ. |
| `queued` | Job has been added to BullMQ and is waiting/delayed/eligible to run. |
| `running` | A worker has started processing the job. |
| `waiting` | Job intentionally paused while waiting for another durable condition. |
| `succeeded` | Job completed successfully. |
| `failed_retryable` | Handler failed but policy allows retry/re-enqueue. |
| `failed_terminal` | Handler failed and should not retry automatically. |
| `canceled` | Job was canceled before completion. |
| `dead` | Job exceeded retry policy or is unrecoverable. |

### 8.2 Status transitions

```text
pending_enqueue
  -> queued
  -> running
  -> succeeded

pending_enqueue
  -> queued
  -> running
  -> waiting
  -> queued
  -> running
  -> succeeded

pending_enqueue
  -> queued
  -> running
  -> failed_retryable
  -> pending_enqueue

pending_enqueue
  -> queued
  -> running
  -> failed_terminal

pending_enqueue
  -> queued
  -> running
  -> dead

pending_enqueue | queued | running | waiting
  -> canceled
```

### 8.3 Fields every background job should have

```ts
export type BackgroundJobRecord = {
  id: BackgroundJobId;
  queueName: QueueName;
  jobKind: JobKind;
  status: BackgroundJobStatus;

  orgId?: OrgId;
  repoId?: RepositoryId;
  reviewRunId?: ReviewRunId;
  indexVersionId?: CodeIndexVersionId;

  payload: JsonObject;
  payloadSchemaVersion: string;
  payloadHash: Sha256;
  dedupeKey: string;

  bullmqJobId?: string;
  parentJobId?: BackgroundJobId;
  rootJobId?: BackgroundJobId;

  priority: number;
  runAfter?: IsoDateTime;
  maxAttempts: number;
  attemptsMade: number;

  lockedBy?: string;
  lockedAt?: IsoDateTime;
  heartbeatAt?: IsoDateTime;

  createdByKind: "webhook" | "api" | "worker" | "scheduler" | "admin";
  createdById?: string;

  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  enqueuedAt?: IsoDateTime;
  startedAt?: IsoDateTime;
  completedAt?: IsoDateTime;
  failedAt?: IsoDateTime;
  canceledAt?: IsoDateTime;

  lastError?: JobErrorSummary;
  result?: JsonObject;
};
```

### 8.4 Payload size limit

Recommended limits:

```text
background_jobs.payload: <= 64 KB normally
BullMQ job data: <= 1 KB normally
large artifacts: object storage URI only
```

Do not store raw code, raw diffs, prompts, or model responses in `background_jobs.payload`. Store artifact URIs.

---

## 9. Job payload contracts

All job payloads should be defined in `/packages/contracts` and referenced by `/packages/queue`.

### 9.1 Payload rules

Every payload must:

```text
- be serializable JSON
- include schemaVersion
- include the minimum identifiers needed to load context from DB
- avoid secrets
- avoid raw source code
- avoid raw installation tokens
- include immutable SHAs where relevant
- include provider-specific refs only at the adapter boundary
```

### 9.2 Example payloads

#### `github.sync_installation`

```ts
export type SyncInstallationJobPayload = {
  schemaVersion: "github.sync_installation.v1";
  installationId: ProviderInstallationId;
  provider: "github";
  reason:
    | "installation_created"
    | "installation_repositories_added"
    | "manual"
    | "scheduled";
};
```

Dedupe key:

```text
github.sync_installation:{installationId}:{reason}
```

#### `repo.index_commit`

```ts
export type IndexCommitJobPayload = {
  schemaVersion: "repo.index_commit.v1";
  orgId: OrgId;
  repoId: RepositoryId;
  installationId: ProviderInstallationId;
  commitSha: GitSha;
  reason:
    | "initial_index"
    | "pr_base"
    | "pr_head"
    | "manual"
    | "scheduled_reindex";
  priorityHint?: "blocking_review" | "background";
  requestedByReviewRunId?: ReviewRunId;
};
```

Dedupe key:

```text
repo.index_commit:{repoId}:{commitSha}
```

#### `embedding.embed_chunks`

```ts
export type EmbedChunksJobPayload = {
  schemaVersion: "embedding.embed_chunks.v1";
  orgId: OrgId;
  repoId: RepositoryId;
  indexVersionId: CodeIndexVersionId;
  chunkContentHashes: Sha256[];
  embeddingModel: string;
  priorityHint?: "blocking_review" | "background";
};
```

Dedupe key:

```text
embedding.embed_chunks:{repoId}:{indexVersionId}:{hash(chunkContentHashes)}:{embeddingModel}
```

#### `pr.review_request`

```ts
export type ReviewRequestJobPayload = {
  schemaVersion: "pr.review_request.v1";
  orgId: OrgId;
  repoId: RepositoryId;
  installationId: ProviderInstallationId;
  pullRequestNumber: number;
  provider: "github";
  baseSha: GitSha;
  headSha: GitSha;
  webhookEventId?: WebhookEventId;
  reason: "opened" | "synchronize" | "reopened" | "manual" | "rereview";
};
```

Dedupe key:

```text
pr.review_request:{repoId}:{pullRequestNumber}:{headSha}
```

#### `pr.review_execute`

```ts
export type ReviewExecuteJobPayload = {
  schemaVersion: "pr.review_execute.v1";
  orgId: OrgId;
  repoId: RepositoryId;
  reviewRunId: ReviewRunId;
  pullRequestNumber: number;
  baseSha: GitSha;
  headSha: GitSha;
};
```

Dedupe key:

```text
pr.review_execute:{reviewRunId}
```

#### `review.publish`

```ts
export type PublishReviewJobPayload = {
  schemaVersion: "review.publish.v1";
  orgId: OrgId;
  repoId: RepositoryId;
  installationId: ProviderInstallationId;
  reviewRunId: ReviewRunId;
  mode: PublishMode;
};
```

`PublishMode` is the canonical publisher mode contract from #0.

Dedupe key:

```text
review.publish:{reviewRunId}:{mode}
```

#### `memory.process_feedback_event`

```ts
export type ProcessFeedbackEventJobPayload = {
  schemaVersion: "memory.process_feedback_event.v1";
  orgId: OrgId;
  repoId?: RepositoryId;
  webhookEventId: WebhookEventId;
  provider: "github";
  providerCommentId?: string;
  publishedFindingId?: PublishedFindingId;
};
```

Dedupe key:

```text
memory.process_feedback_event:{webhookEventId}
```

---

## 10. Enqueueing pattern

### 10.1 Create durable job

Use a single helper for all job creation.

```ts
export async function createBackgroundJob<TPayload>(
  tx: DbTransaction,
  input: {
    kind: JobKind;
    payload: TPayload;
    orgId?: OrgId;
    repoId?: RepositoryId;
    reviewRunId?: ReviewRunId;
    parentJobId?: BackgroundJobId;
    createdBy: JobCreator;
    runAfter?: Date;
    priority?: number;
    dedupeKey?: string;
    maxAttempts?: number;
  }
): Promise<BackgroundJobRecord>;
```

Behavior:

```text
1. Look up JobDefinition by kind.
2. Runtime-validate payload against schema.
3. Compute payloadHash.
4. Compute dedupeKey if not provided.
5. Insert background_jobs row with status = pending_enqueue.
6. On dedupe conflict, return existing active job unless forced.
```

### 10.2 Enqueue pending jobs

After commit, the caller may best-effort enqueue the job. A dispatcher also periodically scans for pending jobs.

```ts
export async function enqueuePendingJob(jobId: BackgroundJobId): Promise<void> {
  const job = await db.backgroundJobs.get(jobId);

  if (job.status !== "pending_enqueue") return;

  const def = getJobDefinition(job.jobKind);

  await bullmqQueue(def.queueName).add(
    job.jobKind,
    { backgroundJobId: job.id, jobKind: job.jobKind },
    {
      jobId: job.id,
      priority: job.priority,
      delay: computeDelay(job.runAfter),
      attempts: job.maxAttempts,
      backoff: toBullMqBackoff(def.defaultBackoff),
      removeOnComplete: { count: 1000, age: 24 * 60 * 60 },
      removeOnFail: { count: 5000, age: 7 * 24 * 60 * 60 },
    }
  );

  await db.backgroundJobs.markQueued(job.id, { bullmqJobId: job.id });
}
```

### 10.3 Outbox dispatcher

The dispatcher should run as part of `/apps/worker` or a dedicated process.

```text
Every N seconds:
  select pending_enqueue jobs where run_after <= now()
  order by priority desc, created_at asc
  limit BATCH_SIZE
  enqueue each job into BullMQ
  mark queued
```

If Redis is down, jobs remain in Postgres as `pending_enqueue`.

### 10.4 Deterministic BullMQ job IDs

Use the `backgroundJobId` as the BullMQ `jobId`.

Benefits:

```text
- duplicate enqueue attempts are safe
- DB and Redis are easy to correlate
- logs/traces are easier to join
- manual debugging is simpler
```

---

## 11. Job deduplication and coalescing

### 11.1 Dedupe keys

Dedupe keys prevent duplicate durable jobs from duplicate webhooks, retries, and manual actions.

Examples:

```text
repo.index_commit:{repoId}:{commitSha}
pr.review_request:{repoId}:{pullRequestNumber}:{headSha}
review.publish:{reviewRunId}:{mode}
embedding.embed_chunks:{repoId}:{indexVersionId}:{chunkHashBatchHash}:{model}
```

Add a partial unique index in Postgres:

```sql
create unique index background_jobs_active_dedupe_idx
on background_jobs (dedupe_key)
where status in (
  'pending_enqueue',
  'queued',
  'running',
  'waiting',
  'failed_retryable'
);
```

### 11.2 Latest-head-wins review behavior

PR review jobs should be head-SHA specific.

If PR #42 gets three synchronize events:

```text
head A
head B
head C
```

The system may create durable jobs for all three, but only the latest head should publish.

At review start:

```text
1. Fetch current PR metadata.
2. If current headSha != job.headSha:
   - mark job canceled/outdated
   - mark review_run canceled/superseded
   - do not call LLM
   - do not publish
```

At publish start:

```text
1. Fetch current PR metadata.
2. If current headSha != reviewRun.headSha:
   - mark publish job canceled/outdated
   - do not publish comments
```

This prevents comments on stale PR states.

### 11.3 Index jobs should be shared

Many PRs may require the same base commit index.

Dedupe by:

```text
repo.index_commit:{repoId}:{commitSha}
```

If a review needs an index job that already exists, link the review run to the existing job instead of creating another indexing job.

---

## 12. Worker app architecture

### 12.1 Worker process roles

`/apps/worker` should support running one or more worker roles.

Examples:

```bash
WORKER_ROLE=all bun run src/index.ts
WORKER_ROLE=review bun run src/index.ts
WORKER_ROLE=index bun run src/index.ts
WORKER_ROLE=embedding bun run src/index.ts
WORKER_ROLE=publisher bun run src/index.ts
WORKER_ROLE=maintenance bun run src/index.ts
```

The same app can register different queues based on role.

### 12.2 Worker process startup

Startup flow:

```text
1. Load config.
2. Initialize logger/tracer.
3. Initialize DB pool.
4. Initialize Redis connections.
5. Register worker handlers for selected role.
6. Start queue event listeners.
7. Start optional dispatcher/reconciler loops.
8. Install graceful shutdown hooks.
9. Mark worker process healthy.
```

### 12.3 Worker process shutdown

On SIGTERM/SIGINT:

```text
1. Stop accepting new jobs.
2. Stop dispatcher/reconciler loops.
3. Allow active jobs to finish up to shutdown grace period.
4. Cancel/abort active jobs if grace period expires.
5. Close BullMQ workers.
6. Close Redis connections.
7. Close DB pool.
8. Exit.
```

Recommended shutdown grace period:

```text
API service: 15s
publisher worker: 30s
review worker: 120s
index worker: 300s
embedding worker: 120s
```

### 12.4 Worker registration

Example:

```ts
import { Worker } from "bullmq";
import { getRedisConnection } from "@repo/queue/redis";
import { runBackgroundJob } from "@repo/queue/run-background-job";
import { handlers } from "./handlers";

export function registerWorker(def: QueueWorkerDefinition) {
  return new Worker(
    physicalQueueName(def.queueName),
    async (bullJob) => {
      return runBackgroundJob({
        bullJob,
        handlers,
      });
    },
    {
      connection: getRedisConnection(),
      concurrency: def.concurrency,
      limiter: def.limiter,
      lockDuration: def.lockDurationMs,
      maxStalledCount: def.maxStalledCount,
    }
  );
}
```

---

## 13. Job handler wrapper

Every job should run through a standard wrapper.

### 13.1 Responsibilities

The wrapper should:

```text
- load background job from DB
- validate job payload
- acquire DB lock/advisory lock
- check cancellation/outdated state
- mark job running
- start heartbeat
- create trace span
- run domain handler
- persist result
- mark succeeded/failed/waiting/canceled
- emit metrics
- release lock
```

### 13.2 Handler interface

```ts
export type JobHandler<TPayload, TResult = unknown> = {
  kind: JobKind;
  handle(ctx: JobExecutionContext, payload: TPayload): Promise<JobHandlerResult<TResult>>;
};

export type JobHandlerResult<TResult = unknown> =
  | { status: "succeeded"; result?: TResult }
  | { status: "waiting"; reason: string; resumeAfter?: Date }
  | { status: "canceled"; reason: string }
  | { status: "failed_terminal"; error: JobErrorSummary };
```

### 13.3 Execution context

```ts
export type JobExecutionContext = {
  jobId: BackgroundJobId;
  bullmqJobId: string;
  jobKind: JobKind;
  queueName: QueueName;

  orgId?: OrgId;
  repoId?: RepositoryId;
  reviewRunId?: ReviewRunId;

  attempt: number;
  maxAttempts: number;

  signal: AbortSignal;
  logger: Logger;
  tracer: Tracer;
  db: Db;

  enqueue: JobEnqueuer;
  requestCancelCheck: () => Promise<boolean>;
  heartbeat: () => Promise<void>;
};
```

### 13.4 Wrapper pseudocode

```ts
export async function runBackgroundJob(input: {
  bullJob: BullMqJob;
  handlers: JobHandlerRegistry;
}) {
  const { backgroundJobId, jobKind } = parseBullMqData(input.bullJob.data);

  return withTraceSpan("background_job.run", async (span) => {
    const durableJob = await db.backgroundJobs.get(backgroundJobId);
    const def = getJobDefinition(durableJob.jobKind);
    const payload = parseWithSchema(def.payloadSchema, durableJob.payload);

    await db.backgroundJobs.acquireRunLock(durableJob.id, workerId);

    const heartbeat = startHeartbeat(durableJob.id);
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), def.defaultTimeoutMs);

    try {
      await db.backgroundJobs.markRunning(durableJob.id, {
        workerId,
        attempt: input.bullJob.attemptsMade + 1,
      });

      const handler = input.handlers.get(jobKind);
      const result = await handler.handle(makeContext(), payload);

      if (result.status === "succeeded") {
        await db.backgroundJobs.markSucceeded(durableJob.id, result.result);
        return result.result;
      }

      if (result.status === "waiting") {
        await db.backgroundJobs.markWaiting(durableJob.id, result.reason);
        return result;
      }

      if (result.status === "canceled") {
        await db.backgroundJobs.markCanceled(durableJob.id, result.reason);
        return result;
      }

      if (result.status === "failed_terminal") {
        await db.backgroundJobs.markFailedTerminal(durableJob.id, result.error);
        throw new TerminalJobError(result.error.message);
      }
    } catch (error) {
      const summary = summarizeError(error);
      await db.backgroundJobs.recordFailure(durableJob.id, summary);
      throw error;
    } finally {
      clearTimeout(timeout);
      await heartbeat.stop();
      await db.backgroundJobs.releaseRunLock(durableJob.id, workerId);
    }
  });
}
```

---

## 14. Worker pool design

Do not use one generic worker pool for everything in production.

Use separate worker roles so each pool can scale independently.

### 14.1 Recommended worker roles

```text
github-worker
index-worker
embedding-worker
review-worker
publisher-worker
memory-worker
maintenance-worker
```

### 14.2 Worker role details

#### `github-worker`

Runs:

```text
github.sync_installation
github.sync_repository
github.sync_repository_selection
```

Profile:

```text
- GitHub API-bound
- medium concurrency
- rate-limit aware
- low CPU
```

#### `index-worker`

Runs:

```text
repo.index_commit
repo.index_incremental
repo.import_index_artifact
repo.reconcile_waiting_reviews
```

Profile:

```text
- CPU-heavy
- disk-heavy
- memory-sensitive
- needs repo workspace access
- low concurrency per host
```

#### `embedding-worker`

Runs:

```text
embedding.embed_chunks
embedding.requeue_missing_embeddings
```

Profile:

```text
- network-bound
- provider-rate-limited
- batch-oriented
- medium/high concurrency
```

#### `review-worker`

Runs:

```text
pr.review_request
pr.review_execute
pr.review_resume_after_index
pr.review_rereview
pr.review_cancel_outdated
```

Profile:

```text
- LLM-bound
- retrieval + DB-bound
- medium CPU
- high cost sensitivity
```

#### `publisher-worker`

Runs:

```text
review.publish
review.publish_summary
review.publish_inline_comments
review.update_check_run
```

Profile:

```text
- GitHub API-bound
- idempotency-critical
- low CPU
```

#### `memory-worker`

Runs:

```text
memory.process_feedback_event
memory.classify_finding_outcome
memory.refresh_repo_memory
```

Profile:

```text
- low priority
- mixed DB/LLM
- should not block review/publish queues
```

#### `maintenance-worker`

Runs:

```text
maintenance.enqueue_pending_jobs
maintenance.reconcile_running_jobs
maintenance.cleanup_old_jobs
maintenance.cleanup_artifacts
maintenance.refresh_queue_metrics
usage.rollup_daily
usage.rollup_monthly
```

Profile:

```text
- low priority
- operational safety
- usually one or few replicas
```

---

## 15. Default concurrency, priority, timeout, retry policy

Initial defaults:

| Queue | Default concurrency per process | Priority range | Timeout | Max attempts | Backoff |
|---|---:|---:|---:|---:|---|
| `github.sync` | 5 | 40-70 | 5m | 5 | exponential, 10s base |
| `repo.index` | 1-2 | 50-90 | 45m | 3 | exponential, 30s base |
| `embedding.batch` | 8-32 | 40-90 | 10m | 5 | exponential, 10s base |
| `pr.review` | 2-8 | 60-100 | 30m | 3 | exponential, 30s base |
| `review.publish` | 5-20 | 80-100 | 10m | 5 | exponential, 10s base |
| `memory.update` | 2-8 | 10-40 | 15m | 3 | exponential, 60s base |
| `usage.record` | 5-20 | 10-30 | 5m | 5 | exponential, 10s base |
| `maintenance` | 1-4 | 0-20 | 30m | 3 | exponential, 60s base |

Priority convention:

```text
0-19: background maintenance
20-39: memory/analytics
40-59: sync/index background work
60-79: user-visible review work
80-100: blocking publish or urgent manual work
```

### 15.1 Job-specific overrides

Some examples:

```text
review.publish:
  high priority because user-visible and low cost

repo.index_commit with reason=pr_base/pr_head:
  higher priority than scheduled reindex

embedding.embed_chunks with priorityHint=blocking_review:
  higher priority than background embedding

memory.update:
  low priority by default
```

---

## 16. Retry policy

### 16.1 Retry classes

Classify failures into:

```text
- transient_retryable
- rate_limited_retryable
- dependency_unavailable_retryable
- data_missing_retryable
- terminal_invalid_payload
- terminal_permission_denied
- terminal_repo_disabled
- terminal_outdated
- terminal_invariant_violation
```

### 16.2 Error classifier

```ts
export type JobFailureClass =
  | "transient_retryable"
  | "rate_limited_retryable"
  | "dependency_unavailable_retryable"
  | "data_missing_retryable"
  | "terminal_invalid_payload"
  | "terminal_permission_denied"
  | "terminal_repo_disabled"
  | "terminal_outdated"
  | "terminal_invariant_violation";

export function classifyJobError(error: unknown): JobFailureClass;
```

### 16.3 Retry behavior

| Failure class | Retry? | Notes |
|---|---|---|
| `transient_retryable` | Yes | network hiccups, temporary process failures |
| `rate_limited_retryable` | Yes | use provider reset time when available |
| `dependency_unavailable_retryable` | Yes | Redis/GitHub/LLM outage |
| `data_missing_retryable` | Sometimes | e.g. index missing while another job builds it |
| `terminal_invalid_payload` | No | schema mismatch/corrupt payload |
| `terminal_permission_denied` | No | app lost repo access |
| `terminal_repo_disabled` | No | user disabled repo |
| `terminal_outdated` | No | stale PR head |
| `terminal_invariant_violation` | No by default | requires investigation |

### 16.4 Backoff policy

Recommended default:

```ts
export type BackoffPolicy =
  | { type: "fixed"; delayMs: number }
  | { type: "exponential"; initialDelayMs: number; maxDelayMs: number; jitter: boolean }
  | { type: "provider_reset_time"; fallbackDelayMs: number };
```

For exponential backoff with jitter:

```text
delay = min(maxDelayMs, initialDelayMs * 2 ** (attempt - 1))
actualDelay = delay * random(0.5, 1.5)
```

### 16.5 Provider reset-time retry

For GitHub/LLM rate limits, if the provider gives a reset time:

```text
runAfter = providerResetAt + smallJitter
```

Then mark job:

```text
failed_retryable -> pending_enqueue with run_after
```

Do not busy-loop rate-limited jobs.

---

## 17. Rate limiting and backpressure

### 17.1 Queue-level rate limiting

BullMQ supports worker rate limiting. Use it for global queue-level constraints such as:

```text
- max publish jobs per second
- max embedding batches per minute
- max GitHub sync operations per second
```

Note: BullMQ worker rate limit is global for a queue, not per tenant. If per-tenant limits are needed, implement tenant-level semaphores or token buckets separately.

### 17.2 Provider-aware rate limiting

You need provider-specific limits for:

```text
- GitHub API
- LLM chat/completion calls
- embedding calls
- vector database writes
```

Implement a `/packages/queue/rate-limits` helper:

```ts
export interface RateLimiter {
  acquire(input: {
    key: string;
    cost: number;
    limit: number;
    windowMs: number;
    timeoutMs: number;
  }): Promise<RateLimitLease>;
}
```

Example keys:

```text
github:installation:{installationId}
llm:provider:{provider}:model:{model}
embedding:provider:{provider}:model:{model}
publish:repo:{repoId}
```

### 17.3 Tenant fairness

Avoid one large customer starving all queues.

Initial approach:

```text
- global queue concurrency
- per-org concurrency semaphore for expensive queues
- per-repo single-flight locks for indexing/publishing
```

Recommended semaphores:

```text
org:{orgId}:repo.index max 1-2
org:{orgId}:pr.review max 2-5
org:{orgId}:embedding.batch max 5-20
repo:{repoId}:review.publish max 1
repo:{repoId}:repo.index max 1
```

### 17.4 Backpressure behavior

When queue depth is high:

```text
- lower priority scheduled/background jobs
- delay scheduled reindex jobs
- coalesce PR synchronize review jobs
- skip outdated review jobs
- reduce max comments/LLM passes for huge PRs if configured
- expose queue delay in dashboard/internal admin
```

### 17.5 Queue health thresholds

Example alert thresholds:

| Metric | Warning | Critical |
|---|---:|---:|
| `pr.review` oldest queued age | 5m | 20m |
| `review.publish` oldest queued age | 2m | 10m |
| `repo.index` oldest blocking queued age | 10m | 60m |
| pending enqueue jobs | 100 | 1000 |
| failed terminal jobs/hour | 10 | 100 |
| dead jobs/hour | 1 | 10 |
| Redis enqueue failure rate | 1% | 5% |

---

## 18. Locks and single-flight behavior

### 18.1 Why locks are needed

Even with dedupe keys, multiple workers can race around shared resources.

Use locks for:

```text
- repo@commit indexing
- index artifact import
- review execution for a reviewRunId
- publish execution for a reviewRunId
- usage rollup for a date/org
- memory update for a finding
```

### 18.2 Recommended locking strategy

Use Postgres advisory locks or row-level leases.

For most domain single-flight locks:

```ts
await db.locks.withAdvisoryLock(
  `repo.index:${repoId}:${commitSha}`,
  async () => {
    await indexRepoCommit(...);
  }
);
```

For job execution lock:

```text
select background_jobs row for update
verify status is queued/failed_retryable/running stale
set locked_by and heartbeat_at
commit
```

### 18.3 Lock naming

Recommended lock keys:

```text
job.run:{backgroundJobId}
repo.index:{repoId}:{commitSha}
index.import:{indexVersionId}
review.execute:{reviewRunId}
review.publish:{reviewRunId}
embedding.chunk:{contentHash}:{model}
usage.rollup:{orgId}:{periodStart}:{periodEnd}
```

---

## 19. Cancellation

### 19.1 Cancellable jobs

Jobs should be cancellable when:

```text
- repo is disabled
- installation is deleted
- PR is closed
- PR head moves and job is outdated
- user/admin requests cancellation
- organization exceeds limit and policy says stop
```

### 19.2 Cancellation data model

Add fields to `background_jobs`:

```text
cancel_requested_at
cancel_requested_by_kind
cancel_reason
```

Status becomes `canceled` only after either:

```text
- waiting/queued job is removed or skipped
- active job reaches a checkpoint and exits
```

### 19.3 Cancellation checkpoints

Long jobs should call:

```ts
await ctx.throwIfCanceled();
```

At least before:

```text
- cloning/fetching large repo
- invoking indexer
- importing artifact
- starting embedding batch
- calling expensive LLM pass
- publishing external side effect
```

### 19.4 Canceling BullMQ jobs

For waiting/delayed jobs:

```text
- mark durable job cancel_requested
- attempt to remove BullMQ job
- mark durable job canceled
```

For active jobs:

```text
- mark cancel_requested
- worker sees cancel at checkpoint
- worker returns canceled
```

Do not rely on hard-killing active jobs as the normal cancellation mechanism.

---

## 20. Heartbeats and stalled jobs

### 20.1 Heartbeat interval

Active jobs should update `heartbeat_at` periodically.

Recommended intervals:

```text
short jobs: every 15s
review/index jobs: every 30s
long static analysis jobs: every 30s
```

### 20.2 Stale running jobs

The maintenance reconciler should scan:

```sql
select * from background_jobs
where status = 'running'
  and heartbeat_at < now() - interval '5 minutes';
```

Then:

```text
1. Check whether BullMQ still has an active job.
2. If no active job and attempts remain, mark failed_retryable and re-enqueue.
3. If attempts exhausted, mark dead.
4. If active job exists, optionally extend grace or alert.
```

### 20.3 Stalled worker handling

BullMQ has its own stalled job behavior. Treat BullMQ stalled retries as one signal, not the entire source of truth.

Because every job is idempotent and locked, duplicate retries should not cause duplicate external side effects.

---

## 21. Review orchestration

PR review is the most important orchestration flow.

### 21.1 High-level flow

```text
pull_request webhook
  -> pr.review_request job
  -> create/fetch review_run
  -> fetch PR snapshot
  -> check stale head
  -> ensure required indexes
  -> if missing indexes:
       enqueue repo.index_commit jobs
       mark review_run waiting_for_index
       exit
  -> if indexes ready:
       enqueue pr.review_execute

repo.index_commit completes
  -> repo.reconcile_waiting_reviews
  -> enqueue pr.review_execute for reviews now unblocked

pr.review_execute
  -> retrieve context
  -> run review passes
  -> validate findings
  -> store artifacts/findings
  -> enqueue review.publish

review.publish
  -> check stale head
  -> publish summary/comments/check run
  -> mark review_run completed
```

### 21.2 `pr.review_request` responsibilities

```text
- load repo/settings
- skip if repo disabled
- fetch PR snapshot from GitHub adapter
- skip if PR closed unless manual rereview allows it
- create or find review_run for repo/pr/headSha
- store PR snapshot artifact
- determine required base/head index versions
- enqueue missing index jobs
- if blocked, mark review_run waiting_for_index
- if not blocked, enqueue pr.review_execute
```

### 21.3 `pr.review_execute` responsibilities

```text
- acquire review.execute lock
- reload review_run
- skip if review is canceled/superseded/completed
- verify current PR headSha still matches
- verify indexes and embeddings are sufficiently ready
- retrieve context bundle
- store context artifact
- run review passes
- store LLM call records
- store candidate findings
- validate/dedupe/rank findings
- store validated findings
- enqueue review.publish
```

### 21.4 Avoid worker blocking on indexes

If index missing:

```ts
return {
  status: "waiting",
  reason: "waiting_for_index",
};
```

Then schedule/resume via:

```text
repo.reconcile_waiting_reviews
```

### 21.5 Review resumption

When an index completes:

```text
1. Find review_runs where status = waiting_for_index.
2. Check if their required indexes are complete.
3. If ready, enqueue pr.review_execute.
4. If not ready, leave them waiting.
```

### 21.6 Huge PR behavior

Before expensive work:

```text
- count changed files
- count changed lines
- detect binary/generated files
- compare to repo settings limits
```

If too large:

```text
- summary-only mode
- limited context mode
- skip inline comments
- require manual trigger
- mark review_run completed_limited
```

Do not allow one enormous PR to dominate all review workers.

---

## 22. Index orchestration

### 22.1 `repo.index_commit` flow

```text
repo.index_commit
  -> acquire repo.index:{repoId}:{commitSha} lock
  -> check if CodeIndexVersion already complete
  -> create/update CodeIndexVersion status = indexing
  -> repo sync checkout commit
  -> invoke indexer driver
  -> validate index manifest
  -> enqueue/import artifact or run importer inline
  -> mark index version imported/complete
  -> enqueue embedding jobs for new chunks
  -> enqueue repo.reconcile_waiting_reviews
```

### 22.2 Inline import vs separate import job

MVP can import index artifact inline in `repo.index_commit`.

Cleaner target:

```text
repo.index_commit
  -> produces artifact
  -> creates repo.import_index_artifact job
```

Target design is better if artifact import becomes large or independently retryable.

### 22.3 Index job dedupe

Before invoking indexer:

```text
if repo_index_versions(repoId, commitSha).status = complete:
  return succeeded
```

If another index job is already running:

```text
- do not start another indexer
- link current requester to existing job
- return waiting or succeeded depending on caller context
```

### 22.4 Disk cleanup

Index jobs must always clean worktrees.

Use `try/finally`:

```ts
const workspace = await workspaceManager.checkout(...);
try {
  await indexer.index({ workspacePath: workspace.path, ... });
} finally {
  await workspace.cleanup();
}
```

If cleanup fails, enqueue `maintenance.cleanup_artifacts` or `maintenance.cleanup_workspaces`.

---

## 23. Embedding orchestration

### 23.1 Separate embeddings from indexing

The indexer emits chunks. The embedding pipeline embeds chunks.

```text
indexer
  -> chunk records
  -> importer writes chunks
  -> importer creates embedding jobs for new content hashes
  -> embedding worker batches provider calls
  -> writes vectors
```

### 23.2 Batch selection

Embedding jobs may receive specific `chunkContentHashes`, but worker should still query DB to verify:

```text
- chunk exists
- embedding missing for selected model
- repo/index version still relevant
- content hash not already embedded
```

### 23.3 Batch sizing

Configure by provider/model:

```text
max chunks per request
max tokens per request
max bytes per request
max concurrent requests
```

### 23.4 Blocking vs background embeddings

For review-blocking indexes, embeddings may be required before review execution.

Options:

```text
A. Require embeddings complete before pr.review_execute.
B. Allow review to proceed with graph/same-file context and partial vector retrieval.
```

Recommended MVP:

```text
Proceed if core changed files/symbols are indexed.
Use vector search only for chunks with ready embeddings.
Continue embedding in background.
```

Recommended target:

```text
For review-blocking chunks, enqueue priority embedding jobs and wait/resume if semantic retrieval is required.
```

---

## 24. Publishing orchestration

### 24.1 Publish flow

```text
review.publish
  -> acquire review.publish:{reviewRunId} lock
  -> load review_run, findings, settings
  -> fetch current PR metadata
  -> skip if headSha stale or PR closed
  -> check already published findings
  -> create/update check run
  -> create grouped PR review comments
  -> post/update summary
  -> store provider comment/check IDs
  -> mark review_run completed/published
```

### 24.2 Idempotency

Publishing must be extremely idempotent.

Use these DB constraints:

```text
unique(review_run_id, finding_id, provider)
unique(review_run_id, provider, provider_comment_id)
unique(review_run_id, provider_check_run_id)
```

Before posting each comment:

```text
if published_findings row exists:
  skip external post
```

If GitHub request succeeds but DB write fails:

```text
- later retry should look up existing bot comments/checks if possible
- match by hidden marker in comment body
```

### 24.3 Hidden comment marker

Include a hidden marker in bot comments:

```html
<!-- ai-reviewer:finding_id=find_123;review_run_id=rr_456 -->
```

This enables duplicate detection and repair.

### 24.4 Publish should be separate from review

Do not publish inline from `pr.review_execute`.

Keep publish separate because:

```text
- review generation and publishing have different retries
- GitHub API failures should not rerun LLM review
- publishing is idempotency-sensitive
- users may configure summary-only/publish-later modes
```

---

## 25. Memory and feedback orchestration

### 25.1 Feedback flow

```text
GitHub feedback webhook
  -> webhook_events row
  -> memory.process_feedback_event job
  -> map provider comment to publishedFinding
  -> classify feedback/outcome
  -> update finding_outcomes
  -> maybe create/update memory_facts
```

### 25.2 Feedback jobs are low priority

Memory jobs should not block:

```text
- publishing
- review execution
- indexing
```

Queue:

```text
memory.update
```

Priority:

```text
10-40
```

### 25.3 Feedback idempotency

Dedupe by webhook delivery/event ID:

```text
memory.process_feedback_event:{webhookEventId}
```

If classification is re-run, update existing outcome row rather than creating duplicates.

---

## 26. Scheduler and maintenance jobs

### 26.1 Do not rely only on Redis for scheduled durability

For scheduled jobs, prefer:

```text
scheduler process creates durable jobs in Postgres
outbox dispatcher enqueues them
```

rather than relying only on Redis scheduled/repeatable jobs.

### 26.2 Scheduled tasks

Recommended scheduled maintenance:

| Job | Frequency | Purpose |
|---|---:|---|
| `maintenance.enqueue_pending_jobs` | every 5-15s | Push `pending_enqueue` jobs to BullMQ. |
| `maintenance.reconcile_running_jobs` | every 1-5m | Recover stale running jobs. |
| `maintenance.cleanup_old_jobs` | daily | Trim completed job records/artifacts according to retention. |
| `maintenance.cleanup_artifacts` | daily | Delete expired object-storage artifacts. |
| `maintenance.refresh_queue_metrics` | every 30-60s | Store queue depth/latency snapshots. |
| `usage.rollup_daily` | daily | Aggregate usage/cost by org/repo/day. |
| `usage.rollup_monthly` | hourly/daily | Refresh monthly usage summaries. |
| `github.sync_installation` | daily/weekly | Refresh repo permissions/settings. |
| `embedding.requeue_missing_embeddings` | hourly | Recover missed embedding batches. |

### 26.3 Scheduler lock

Only one scheduler should create scheduled jobs at a time.

Use a DB advisory lock:

```text
scheduler.tick:{taskName}:{periodBucket}
```

Example:

```ts
await db.locks.withAdvisoryLock("scheduler:usage.rollup_daily:2026-04-28", async () => {
  await createBackgroundJob(...);
});
```

---

## 27. Queue package implementation

### 27.1 Package structure

```text
/packages/queue
  package.json
  tsconfig.json
  src/
    index.ts
    config.ts
    names.ts
    definitions.ts
    payloads.ts
    redis.ts
    bullmq.ts
    create-background-job.ts
    enqueue.ts
    dispatcher.ts
    reconciler.ts
    worker.ts
    handler-registry.ts
    run-background-job.ts
    errors.ts
    retry-policy.ts
    rate-limits.ts
    locks.ts
    metrics.ts
    testing/
      fake-queue.ts
      fixtures.ts
```

### 27.2 `names.ts`

```ts
export const QueueNames = {
  GithubSync: "github.sync",
  RepoIndex: "repo.index",
  EmbeddingBatch: "embedding.batch",
  PrReview: "pr.review",
  ReviewPublish: "review.publish",
  MemoryUpdate: "memory.update",
  UsageRecord: "usage.record",
  Maintenance: "maintenance",
} as const;

export type QueueName = (typeof QueueNames)[keyof typeof QueueNames];

export function physicalQueueName(queueName: QueueName, prefix = process.env.QUEUE_PREFIX ?? "local") {
  return `${prefix}:${queueName}`;
}
```

### 27.3 `definitions.ts`

```ts
export const JobDefinitions = {
  "pr.review_request": defineJob({
    kind: "pr.review_request",
    queueName: QueueNames.PrReview,
    payloadSchema: ReviewRequestJobPayloadSchema,
    defaultPriority: 80,
    defaultMaxAttempts: 3,
    defaultTimeoutMs: minutes(10),
    defaultBackoff: { type: "exponential", initialDelayMs: seconds(30), maxDelayMs: minutes(10), jitter: true },
    dedupeKey: (p) => `pr.review_request:${p.repoId}:${p.pullRequestNumber}:${p.headSha}`,
    description: "Create or resume a review run for a PR head SHA.",
  }),

  "repo.index_commit": defineJob({
    kind: "repo.index_commit",
    queueName: QueueNames.RepoIndex,
    payloadSchema: IndexCommitJobPayloadSchema,
    defaultPriority: 60,
    defaultMaxAttempts: 3,
    defaultTimeoutMs: minutes(45),
    defaultBackoff: { type: "exponential", initialDelayMs: seconds(30), maxDelayMs: minutes(20), jitter: true },
    dedupeKey: (p) => `repo.index_commit:${p.repoId}:${p.commitSha}`,
    description: "Index a repository at a specific commit SHA.",
  }),
} satisfies Record<JobKind, JobDefinition<any>>;
```

### 27.4 `redis.ts`

```ts
import IORedis from "ioredis";

let sharedConnection: IORedis | undefined;

export function getRedisConnection() {
  if (!sharedConnection) {
    sharedConnection = new IORedis(process.env.REDIS_URL!, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: true,
    });
  }

  return sharedConnection;
}
```

### 27.5 `bullmq.ts`

```ts
import { Queue } from "bullmq";
import { getRedisConnection } from "./redis";
import { physicalQueueName } from "./names";

const queues = new Map<string, Queue>();

export function getBullMqQueue(queueName: QueueName): Queue {
  const physicalName = physicalQueueName(queueName);

  let queue = queues.get(physicalName);
  if (!queue) {
    queue = new Queue(physicalName, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        removeOnComplete: { age: 24 * 60 * 60, count: 1000 },
        removeOnFail: { age: 7 * 24 * 60 * 60, count: 5000 },
      },
    });
    queues.set(physicalName, queue);
  }

  return queue;
}
```

### 27.6 `create-background-job.ts`

```ts
export async function createBackgroundJob<TPayload>(
  tx: DbTransaction,
  input: CreateBackgroundJobInput<TPayload>
): Promise<BackgroundJobRecord> {
  const def = getJobDefinition(input.kind);
  const payload = parseWithSchema(def.payloadSchema, input.payload);
  const payloadHash = sha256Json(payload);
  const dedupeKey = input.dedupeKey ?? def.dedupeKey(payload);

  const existing = await tx.backgroundJobs.findActiveByDedupeKey(dedupeKey);
  if (existing && !input.force) {
    return existing;
  }

  return tx.backgroundJobs.insert({
    id: createId("job"),
    queueName: def.queueName,
    jobKind: def.kind,
    status: "pending_enqueue",
    orgId: input.orgId,
    repoId: input.repoId,
    reviewRunId: input.reviewRunId,
    payload,
    payloadSchemaVersion: payload.schemaVersion,
    payloadHash,
    dedupeKey,
    priority: input.priority ?? def.defaultPriority,
    runAfter: input.runAfter,
    maxAttempts: input.maxAttempts ?? def.defaultMaxAttempts,
    attemptsMade: 0,
    parentJobId: input.parentJobId,
    rootJobId: input.rootJobId ?? input.parentJobId,
    createdByKind: input.createdBy.kind,
    createdById: input.createdBy.id,
  });
}
```

### 27.7 `enqueue.ts`

```ts
export async function enqueueBackgroundJob(jobId: BackgroundJobId): Promise<void> {
  const job = await db.backgroundJobs.get(jobId);
  if (!job) throw new Error(`Background job not found: ${jobId}`);

  if (job.status !== "pending_enqueue" && job.status !== "failed_retryable") {
    return;
  }

  const def = getJobDefinition(job.jobKind);
  const queue = getBullMqQueue(def.queueName);

  await queue.add(
    job.jobKind,
    { backgroundJobId: job.id, jobKind: job.jobKind },
    {
      jobId: job.id,
      priority: job.priority,
      delay: computeDelayMs(job.runAfter),
      attempts: job.maxAttempts,
      backoff: toBullMqBackoff(def.defaultBackoff),
    }
  );

  await db.backgroundJobs.markQueued(job.id, {
    bullmqJobId: job.id,
    enqueuedAt: new Date(),
  });
}
```

---

## 28. Worker app implementation

### 28.1 App structure

```text
/apps/worker
  package.json
  tsconfig.json
  src/
    index.ts
    config.ts
    roles.ts
    lifecycle.ts
    handlers/
      github-sync.handlers.ts
      repo-index.handlers.ts
      embedding.handlers.ts
      pr-review.handlers.ts
      publish.handlers.ts
      memory.handlers.ts
      usage.handlers.ts
      maintenance.handlers.ts
    workers/
      github-worker.ts
      index-worker.ts
      embedding-worker.ts
      review-worker.ts
      publisher-worker.ts
      memory-worker.ts
      maintenance-worker.ts
```

### 28.2 `index.ts`

```ts
async function main() {
  const config = loadWorkerConfig();

  setupObservability(config);

  const registry = buildHandlerRegistry({
    githubHandlers,
    repoIndexHandlers,
    embeddingHandlers,
    prReviewHandlers,
    publishHandlers,
    memoryHandlers,
    usageHandlers,
    maintenanceHandlers,
  });

  const workers = registerWorkersForRole(config.workerRole, registry);

  const loops = [];
  if (config.enableDispatcher) loops.push(startOutboxDispatcher());
  if (config.enableReconciler) loops.push(startReconciler());
  if (config.enableScheduler) loops.push(startScheduler());

  await installGracefulShutdown({ workers, loops });

  logger.info("worker.started", {
    role: config.workerRole,
    queues: workers.map((w) => w.name),
  });
}

main().catch((error) => {
  logger.error("worker.start_failed", { error });
  process.exit(1);
});
```

### 28.3 Role mapping

```ts
export const WorkerRoles = {
  All: "all",
  Github: "github",
  Index: "index",
  Embedding: "embedding",
  Review: "review",
  Publisher: "publisher",
  Memory: "memory",
  Maintenance: "maintenance",
} as const;

export const RoleQueues = {
  all: [
    QueueNames.GithubSync,
    QueueNames.RepoIndex,
    QueueNames.EmbeddingBatch,
    QueueNames.PrReview,
    QueueNames.ReviewPublish,
    QueueNames.MemoryUpdate,
    QueueNames.UsageRecord,
    QueueNames.Maintenance,
  ],
  github: [QueueNames.GithubSync],
  index: [QueueNames.RepoIndex],
  embedding: [QueueNames.EmbeddingBatch],
  review: [QueueNames.PrReview],
  publisher: [QueueNames.ReviewPublish],
  memory: [QueueNames.MemoryUpdate],
  maintenance: [QueueNames.Maintenance, QueueNames.UsageRecord],
} satisfies Record<WorkerRole, QueueName[]>;
```

---

## 29. Domain handler examples

### 29.1 `pr.review_request`

```ts
export const reviewRequestHandler: JobHandler<ReviewRequestJobPayload> = {
  kind: "pr.review_request",

  async handle(ctx, payload) {
    const repo = await ctx.db.repositories.get(payload.repoId);
    if (!repo || !repo.enabled) {
      return { status: "canceled", reason: "repo_disabled" };
    }

    const snapshot = await github.fetchPullRequestSnapshot({
      repoId: payload.repoId,
      installationId: payload.installationId,
      pullRequestNumber: payload.pullRequestNumber,
      expectedHeadSha: payload.headSha,
    });

    if (snapshot.headSha !== payload.headSha) {
      return { status: "canceled", reason: "outdated_head_sha" };
    }

    const reviewRun = await reviewRuns.createOrGetForSnapshot(snapshot, {
      reason: payload.reason,
      webhookEventId: payload.webhookEventId,
    });

    const missingIndexes = await indexRequirements.findMissingIndexes({
      repoId: payload.repoId,
      baseSha: snapshot.baseSha,
      headSha: snapshot.headSha,
    });

    if (missingIndexes.length > 0) {
      await reviewRuns.markWaitingForIndex(reviewRun.id, missingIndexes);

      for (const indexRequest of missingIndexes) {
        await ctx.enqueue("repo.index_commit", {
          schemaVersion: "repo.index_commit.v1",
          orgId: payload.orgId,
          repoId: payload.repoId,
          installationId: payload.installationId,
          commitSha: indexRequest.commitSha,
          reason: indexRequest.reason,
          priorityHint: "blocking_review",
          requestedByReviewRunId: reviewRun.id,
        });
      }

      return { status: "waiting", reason: "waiting_for_index" };
    }

    await ctx.enqueue("pr.review_execute", {
      schemaVersion: "pr.review_execute.v1",
      orgId: payload.orgId,
      repoId: payload.repoId,
      reviewRunId: reviewRun.id,
      pullRequestNumber: payload.pullRequestNumber,
      baseSha: snapshot.baseSha,
      headSha: snapshot.headSha,
    });

    return { status: "succeeded", result: { reviewRunId: reviewRun.id } };
  },
};
```

### 29.2 `repo.index_commit`

```ts
export const indexCommitHandler: JobHandler<IndexCommitJobPayload> = {
  kind: "repo.index_commit",

  async handle(ctx, payload) {
    return ctx.db.locks.withAdvisoryLock(
      `repo.index:${payload.repoId}:${payload.commitSha}`,
      async () => {
        const existing = await codeIndexes.findComplete(payload.repoId, payload.commitSha);
        if (existing) {
          await ctx.enqueue("repo.reconcile_waiting_reviews", {
            schemaVersion: "repo.reconcile_waiting_reviews.v1",
            orgId: payload.orgId,
            repoId: payload.repoId,
            commitSha: payload.commitSha,
          });
          return { status: "succeeded", result: { indexVersionId: existing.id } };
        }

        await ctx.throwIfCanceled();

        const indexVersion = await codeIndexes.createOrMarkIndexing({
          repoId: payload.repoId,
          commitSha: payload.commitSha,
        });

        const workspace = await repoSync.checkoutCommit({
          repoId: payload.repoId,
          installationId: payload.installationId,
          commitSha: payload.commitSha,
        });

        try {
          await ctx.throwIfCanceled();

          const artifact = await indexer.index({
            repoId: payload.repoId,
            commitSha: payload.commitSha,
            workspacePath: workspace.path,
          });

          const imported = await indexImporter.importArtifact({
            repoId: payload.repoId,
            commitSha: payload.commitSha,
            indexVersionId: indexVersion.id,
            artifactUri: artifact.artifactUri,
          });

          await enqueueEmbeddingJobsForNewChunks(ctx, imported);

          await ctx.enqueue("repo.reconcile_waiting_reviews", {
            schemaVersion: "repo.reconcile_waiting_reviews.v1",
            orgId: payload.orgId,
            repoId: payload.repoId,
            commitSha: payload.commitSha,
          });

          return { status: "succeeded", result: { indexVersionId: indexVersion.id } };
        } finally {
          await workspace.cleanup();
        }
      }
    );
  },
};
```

---

## 30. Environment configuration

### 30.1 Required env vars

```text
QUEUE_PREFIX=local
REDIS_URL=redis://localhost:6379
WORKER_ROLE=all
WORKER_ID=optional-generated-if-empty
WORKER_CONCURRENCY_GITHUB=5
WORKER_CONCURRENCY_INDEX=2
WORKER_CONCURRENCY_EMBEDDING=16
WORKER_CONCURRENCY_REVIEW=4
WORKER_CONCURRENCY_PUBLISH=10
WORKER_CONCURRENCY_MEMORY=4
WORKER_CONCURRENCY_MAINTENANCE=2
ENABLE_QUEUE_DISPATCHER=true
ENABLE_QUEUE_RECONCILER=true
ENABLE_QUEUE_SCHEDULER=true
JOB_HEARTBEAT_INTERVAL_MS=30000
JOB_STALE_AFTER_MS=300000
JOB_SHUTDOWN_GRACE_MS=120000
```

### 30.2 Optional env vars

```text
QUEUE_DEFAULT_REMOVE_ON_COMPLETE_COUNT=1000
QUEUE_DEFAULT_REMOVE_ON_FAIL_COUNT=5000
QUEUE_DISPATCHER_INTERVAL_MS=5000
QUEUE_DISPATCHER_BATCH_SIZE=100
QUEUE_RECONCILER_INTERVAL_MS=60000
QUEUE_SCHEDULER_INTERVAL_MS=60000
QUEUE_METRICS_INTERVAL_MS=30000
MAX_ACTIVE_REVIEWS_PER_ORG=3
MAX_ACTIVE_INDEXES_PER_ORG=1
MAX_ACTIVE_INDEXES_PER_REPO=1
MAX_ACTIVE_PUBLISHES_PER_REPO=1
```

### 30.3 Local Docker Compose

#1 and #2 already define local Postgres/Redis. The worker should connect to the same services.

Example local commands:

```bash
pnpm dev:api
pnpm dev:worker
pnpm dev:web
```

Or specific worker roles:

```bash
WORKER_ROLE=review pnpm --filter @repo/worker dev
WORKER_ROLE=index pnpm --filter @repo/worker dev
```

---

## 31. Observability

### 31.1 Required structured log fields

Every job log should include:

```text
backgroundJobId
bullmqJobId
jobKind
queueName
orgId
repoId
reviewRunId
attempt
workerId
traceId
spanId
```

Example:

```ts
ctx.logger.info("job.started", {
  backgroundJobId: ctx.jobId,
  jobKind: ctx.jobKind,
  queueName: ctx.queueName,
  attempt: ctx.attempt,
});
```

### 31.2 Metrics

Required metrics:

```text
queue_jobs_created_total{jobKind,queueName}
queue_jobs_enqueued_total{jobKind,queueName}
queue_jobs_started_total{jobKind,queueName}
queue_jobs_succeeded_total{jobKind,queueName}
queue_jobs_failed_total{jobKind,queueName,failureClass}
queue_jobs_canceled_total{jobKind,queueName,reason}
queue_job_duration_ms{jobKind,queueName}
queue_job_wait_time_ms{jobKind,queueName}
queue_depth{queueName,status}
queue_oldest_job_age_ms{queueName}
queue_dispatcher_failures_total
queue_reconciler_requeued_total
queue_dead_jobs_total{jobKind,queueName}
worker_active_jobs{workerRole,queueName}
worker_heartbeat_lag_ms{workerId}
```

### 31.3 Tracing

Each job execution should create a root span:

```text
background_job.run
```

Span attributes:

```text
job.id
job.kind
job.queue
job.attempt
org.id
repo.id
review_run.id
worker.id
```

Child spans should be created by domain packages:

```text
github.fetch_pr_snapshot
repo_sync.checkout
indexer.run
index_importer.import
embedding.batch
retrieval.retrieve_context
llm.generate
review.validate_findings
publisher.publish_review
```

### 31.4 Queue metrics snapshots

Store periodic queue metrics in Postgres or metrics backend:

```text
queue_name
waiting_count
delayed_count
active_count
completed_count
failed_count
oldest_waiting_age_ms
sampled_at
```

This helps the dashboard show system health without querying Redis directly from the web app.

---

## 32. Security

### 32.1 Secrets

Job payloads must not contain:

```text
- GitHub installation tokens
- GitHub private keys
- model provider API keys
- raw source code
- raw prompts/responses
- user session tokens
```

Workers should retrieve tokens from secure services at execution time.

### 32.2 Payload redaction

Before logging job payloads:

```text
- log ids and metadata only
- never log payload wholesale
- redact URLs with embedded credentials
- redact provider headers
```

### 32.3 Tenant isolation

Every job that touches tenant data should include and enforce:

```text
orgId
repoId when applicable
installationId when applicable
```

Worker handlers should verify that referenced records belong to the same org/repo.

### 32.4 Admin controls

Admin actions should be audited:

```text
- cancel job
- retry job
- replay job
- force enqueue
- change queue priority
- disable repo
```

### 32.5 Sandbox boundary

Queue workers should not directly execute untrusted repo commands unless routed through the sandbox execution layer (#24).

Indexing and static-analysis workers should enforce:

```text
- filesystem isolation
- timeouts
- memory limits
- network policy
- cleanup
```

---

## 33. Testing strategy

### 33.1 Unit tests

Test:

```text
- job definition metadata
- dedupe key generation
- payload validation
- enqueue option mapping
- retry classification
- backoff computation
- status transition validation
- role-to-queue mapping
```

### 33.2 Integration tests

Use local Postgres + Redis.

Test:

```text
- create durable job
- enqueue pending job
- worker processes job
- job status transitions to succeeded
- failed job retries
- terminal failure does not retry
- dispatcher recovers pending_enqueue jobs
- duplicate create returns existing active job
- duplicate BullMQ enqueue is safe
- canceled queued job is skipped
- stale running job is reconciled
```

### 33.3 Domain orchestration tests

Use fake GitHub/indexer/LLM adapters.

Test:

```text
- PR review request with missing index creates index jobs and waits
- index completion resumes waiting review
- stale PR head cancels review
- review execution enqueues publish
- publish job skips already published findings
- duplicate publish job does not duplicate comments
```

### 33.4 Load tests

Simulate:

```text
- 1,000 PR webhook events
- duplicate synchronize events for same PR
- 100 repos requiring initial index
- embedding backlog
- Redis restart
- worker crash during publish
- worker crash during index import
```

Measure:

```text
- queue latency
- total review latency
- dead jobs
- duplicate side effects
- DB contention
- Redis CPU/memory
```

### 33.5 Failure injection tests

Inject failures:

```text
- Redis unavailable during enqueue
- Redis unavailable during processing
- Postgres unavailable during status update
- GitHub rate limit
- LLM provider timeout
- indexer process crash
- worker SIGTERM during active job
```

Expected behavior:

```text
- no lost durable jobs
- no duplicate external comments
- jobs eventually retry or go dead
- dashboard can explain state
```

---

## 34. Admin/internal tooling

Add CLI commands:

```bash
pnpm queue:list --queue pr.review
pnpm queue:job --id job_123
pnpm queue:retry --id job_123
pnpm queue:cancel --id job_123 --reason manual
pnpm queue:enqueue-pending --limit 100
pnpm queue:reconcile-running --dry-run
pnpm queue:depth
pnpm queue:dead
pnpm queue:replay --id job_123
```

Dashboard internal tools should show:

```text
- background job detail
- related review run/index version
- payload metadata
- status history
- attempts/errors
- queue timings
- child/parent jobs
- retry/cancel buttons for admins
```

---

## 35. Migration path to Temporal

### 35.1 Keep an orchestration interface

Define:

```ts
export interface JobOrchestrator {
  createJob<TPayload>(input: CreateBackgroundJobInput<TPayload>): Promise<BackgroundJobRecord>;
  enqueueJob(jobId: BackgroundJobId): Promise<void>;
  cancelJob(jobId: BackgroundJobId, reason: string): Promise<void>;
}
```

BullMQ implementation:

```text
/packages/queue/bullmq-orchestrator.ts
```

Future Temporal implementation:

```text
/packages/queue/temporal-orchestrator.ts
```

### 35.2 Map jobs to Temporal concepts

| Current BullMQ concept | Future Temporal concept |
|---|---|
| `pr.review_request` + `pr.review_execute` jobs | `reviewWorkflow` |
| `repo.index_commit` job | `indexCommitActivity` or `indexWorkflow` |
| `embedding.embed_chunks` job | `embedChunksActivity` |
| `review.publish` job | `publishReviewActivity` |
| `background_jobs.id` | workflowId/activity correlation ID |
| `job payload` | single workflow/activity argument object |
| DB status transitions | workflow progress + DB projection |

### 35.3 What should stay the same

Even after Temporal:

```text
- contracts stay the same
- review_runs stay in Postgres
- code indexes stay in Postgres/object storage
- published findings stay in Postgres
- dashboard reads Postgres
- handlers remain activity-like functions
```

Temporal would replace some queue orchestration, not the entire domain model.

### 35.4 Why single-object payloads matter

Temporal recommends object parameters because object fields can be changed without breaking signatures. This is also a good practice for BullMQ jobs. Keep every job payload as one serializable object.

---

## 36. Implementation PR sequence

### PR 1: Queue package skeleton

Implement:

```text
/packages/queue
QueueNames
JobKind definitions
JobDefinition type
basic config
Redis connection
BullMQ queue factory
```

Tests:

```text
- physical queue names include prefix
- every JobKind has a QueueName
- every JobKind has schema/defaults/dedupe
```

### PR 2: Durable job creation

Implement:

```text
createBackgroundJob
payload validation
payloadHash
dedupeKey
DB helper queries
```

Tests:

```text
- valid job inserts pending_enqueue
- invalid payload rejected
- duplicate active dedupe returns existing job
- payloadHash stable
```

### PR 3: Enqueue dispatcher

Implement:

```text
enqueueBackgroundJob
outbox dispatcher loop
pending job scanner
BullMQ add with deterministic jobId
mark queued
```

Tests:

```text
- pending job enqueues
- Redis failure leaves job pending
- duplicate enqueue safe
- runAfter delay respected
```

### PR 4: Worker wrapper

Implement:

```text
Worker registration
handler registry
runBackgroundJob wrapper
status transitions
heartbeat
failure recording
retry classification
```

Tests:

```text
- handler success marks succeeded
- handler failure records error
- terminal failure marks failed_terminal
- waiting result marks waiting
- canceled job skipped
```

### PR 5: Worker app shell

Implement:

```text
/apps/worker
role config
queue registration
graceful shutdown
observability hooks
local dev scripts
```

Tests:

```text
- role maps to expected queues
- worker starts/stops cleanly
```

### PR 6: Maintenance loops

Implement:

```text
maintenance.enqueue_pending_jobs
maintenance.reconcile_running_jobs
maintenance.cleanup_old_jobs placeholder
queue metrics snapshot
```

Tests:

```text
- stale running job requeued
- attempts exhausted -> dead
- queue metrics sampled
```

### PR 7: Domain job handler stubs

Implement handler shells:

```text
github.sync_installation
repo.index_commit
embedding.embed_chunks
pr.review_request
pr.review_execute
review.publish
memory.process_feedback_event
usage.record_event
```

Handlers can initially call placeholder services.

### PR 8: Review orchestration integration

Implement:

```text
pr.review_request creates/fetches review_run
missing index handling
index job creation
review resume handling
pr.review_execute enqueue
```

### PR 9: Publish orchestration integration

Implement:

```text
review.publish handler
publish idempotency checks
stale PR head check
published finding persistence
```

### PR 10: Admin tooling

Implement:

```text
queue CLI
job detail API endpoint
retry/cancel admin API endpoint
```

---

## 37. MVP cut

Build first:

```text
- QueueNames
- JobDefinitions
- createBackgroundJob
- enqueueBackgroundJob
- outbox dispatcher
- worker wrapper
- /apps/worker app
- review/index/publish job kinds
- basic retry/backoff
- job dedupe
- job status transitions
- simple stale job reconciler
- basic queue metrics
```

Defer:

```text
- advanced per-tenant fair scheduling
- sophisticated token-bucket rate limiting
- queue dashboard polish
- full Temporal adapter
- advanced cancellation UI
- complex job dependency graph
- comprehensive load tests
```

The MVP should still be reliable enough that webhooks do not lose work if Redis is temporarily unavailable.

---

## 38. Definition of done

#7 is complete when:

```text
- API/webhook code can create durable jobs without directly touching BullMQ internals.
- Pending jobs are reliably enqueued by dispatcher.
- Workers can process jobs through a shared wrapper.
- Job status is visible in Postgres.
- Duplicate job creation is prevented by dedupe keys.
- Jobs are retryable and idempotent by design.
- Stale running jobs can be reconciled.
- PR review can wait on indexing without blocking a worker slot.
- Publish jobs are separate from review jobs.
- Worker roles can scale independently.
- Queue metrics/logs/traces are emitted.
- Basic admin retry/cancel/replay tooling exists.
- Local dev can run API + worker + Postgres + Redis.
```

---

## 39. Reference config snapshot

```ts
export const QueueWorkerDefaults = {
  [QueueNames.GithubSync]: {
    concurrency: 5,
    lockDurationMs: 60_000,
    maxStalledCount: 2,
    limiter: { max: 20, duration: 1_000 },
  },
  [QueueNames.RepoIndex]: {
    concurrency: 2,
    lockDurationMs: 10 * 60_000,
    maxStalledCount: 1,
  },
  [QueueNames.EmbeddingBatch]: {
    concurrency: 16,
    lockDurationMs: 2 * 60_000,
    maxStalledCount: 2,
  },
  [QueueNames.PrReview]: {
    concurrency: 4,
    lockDurationMs: 5 * 60_000,
    maxStalledCount: 1,
  },
  [QueueNames.ReviewPublish]: {
    concurrency: 10,
    lockDurationMs: 60_000,
    maxStalledCount: 2,
    limiter: { max: 10, duration: 1_000 },
  },
  [QueueNames.MemoryUpdate]: {
    concurrency: 4,
    lockDurationMs: 2 * 60_000,
    maxStalledCount: 2,
  },
  [QueueNames.UsageRecord]: {
    concurrency: 10,
    lockDurationMs: 60_000,
    maxStalledCount: 2,
  },
  [QueueNames.Maintenance]: {
    concurrency: 2,
    lockDurationMs: 5 * 60_000,
    maxStalledCount: 1,
  },
} as const;
```

---

## 40. Reference links

- BullMQ docs: https://docs.bullmq.io/
- BullMQ rate limiting: https://docs.bullmq.io/guide/rate-limiting
- Redis Pub/Sub delivery semantics: https://redis.io/docs/latest/develop/pubsub/
- Temporal TypeScript SDK guide: https://docs.temporal.io/develop/typescript
- Temporal TypeScript workflow basics: https://docs.temporal.io/develop/typescript/workflows/basics
- Temporal local TypeScript setup: https://docs.temporal.io/develop/typescript/set-up-your-local-typescript
