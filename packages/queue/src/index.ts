import { createHash } from "node:crypto";
import { loadRuntimeConfig } from "@repo/config";
import {
  type JobEnvelope,
  JobEnvelopeSchema,
  type JobPayload,
  JobPayloadSchema,
  type JobStatus,
  parseWithSchema,
} from "@repo/contracts";
import { type BackgroundJobRecord, BackgroundJobRepository, type HeimdallDatabase } from "@repo/db";
import {
  classifyTelemetryError,
  OBSERVABILITY_METRIC_NAMES,
  OBSERVABILITY_SPAN_NAMES,
  type TelemetryMetricRecorder,
  type TelemetrySpanRecorder,
} from "@repo/observability";
import { type Job as BullMqJob, Queue } from "bullmq";
import IORedis from "ioredis";

/** Queue names used by Heimdall workers. */
export const QUEUE_NAMES = {
  repoSync: "repo-sync",
  indexing: "indexing",
  embedding: "embedding",
  review: "review",
  memory: "memory",
  publishing: "publishing",
  billing: "billing",
} as const;

/** Known queue name. */
export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/** Durable job intent passed from Postgres to Redis. */
export type QueueJobIntent<TPayload extends JobPayload = JobPayload> = {
  /** Queue name that receives the job. */
  readonly queueName: QueueName;
  /** Job envelope stored in the durable outbox. */
  readonly envelope: JobEnvelope<TPayload>;
};

/** Durable job row selected from the Postgres outbox. */
export type DurableJob<TPayload extends JobPayload = JobPayload> = QueueJobIntent<TPayload> & {
  /** Durable job row ID. */
  readonly backgroundJobId: string;
  /** Current durable job state. */
  readonly status: JobStatus;
  /** Number of handler attempts recorded by the durable store. */
  readonly attempts: number;
  /** Maximum attempts allowed for the job. */
  readonly maxAttempts: number;
  /** Time the durable worker last started this job. */
  readonly startedAt?: Date;
  /** Time the durable job reached a terminal state. */
  readonly completedAt?: Date;
  /** Last durable job row update time known to the store. */
  readonly updatedAt?: Date;
  /** Last JSON-safe error recorded for this durable job. */
  readonly error?: SerializedJobError;
};

/** Minimal queue producer interface used by ingestion code. */
export type QueueProducer = {
  /** Enqueues a job intent. */
  readonly enqueue: (intent: QueueJobIntent) => Promise<void>;
  /** Closes queue resources. */
  readonly close: () => Promise<void>;
};

/** Pending job claim options used by outbox dispatchers. */
export type ClaimPendingJobsOptions = {
  /** Maximum rows to claim in one dispatcher pass. */
  readonly limit: number;
  /** Current time used for scheduled job eligibility. */
  readonly now: Date;
};

/** Options used to repair durable jobs stuck in the running state. */
export type RecoverStaleRunningJobsOptions = {
  /** Maximum stale running rows to repair in one pass. */
  readonly limit?: number;
  /** Current time used to calculate the stale cutoff. */
  readonly now?: Date;
  /** Running duration after which a job is considered stale. */
  readonly staleAfterMs: number;
};

/** Result returned by one stale running job recovery pass. */
export type RecoverStaleRunningJobsResult = {
  /** Number of stale running jobs considered for repair. */
  readonly inspected: number;
  /** Number of stale jobs moved back to queued for another BullMQ attempt. */
  readonly requeued: number;
  /** Number of stale jobs moved to dead-lettered after exhausting attempts. */
  readonly deadLettered: number;
  /** Durable job row IDs that were repaired. */
  readonly jobIds: readonly string[];
};

/** Durable lifecycle state returned when a worker starts a job. */
export type DurableJobRunState = "running" | "already_completed" | "canceled" | "missing";

/** Durable job state store used by dispatchers and workers. */
export type DurableJobStore = {
  /** Returns pending jobs eligible for enqueue. */
  readonly claimPending: (options: ClaimPendingJobsOptions) => Promise<readonly DurableJob[]>;
  /** Repairs stale running jobs after worker crashes or lost BullMQ attempts. */
  readonly recoverStaleRunningJobs: (
    options: RecoverStaleRunningJobsOptions,
  ) => Promise<RecoverStaleRunningJobsResult>;
  /** Marks a pending durable job as queued after BullMQ accepts it. */
  readonly markQueued: (job: DurableJob) => Promise<void>;
  /** Marks a queued durable job as running and records a handler attempt. */
  readonly markRunning: (envelope: JobEnvelope<JobPayload>) => Promise<DurableJobRunState>;
  /** Marks a durable job as completed. */
  readonly markCompleted: (envelope: JobEnvelope<JobPayload>) => Promise<void>;
  /** Marks a durable job as queued for a BullMQ retry. */
  readonly markRetrying: (
    envelope: JobEnvelope<JobPayload>,
    error: SerializedJobError,
  ) => Promise<void>;
  /** Marks a durable job as permanently failed. */
  readonly markFailed: (
    envelope: JobEnvelope<JobPayload>,
    error: SerializedJobError,
  ) => Promise<void>;
};

/** Serialized error stored on durable job rows. */
export type SerializedJobError = {
  /** Error class or fallback name. */
  readonly name: string;
  /** Human-readable error message. */
  readonly message: string;
  /** Optional stack trace for local debugging. */
  readonly stack?: string;
};

/** Result returned by one outbox dispatcher pass. */
export type DispatchPendingJobsResult = {
  /** Number of pending rows read from the durable store. */
  readonly claimed: number;
  /** Number of rows successfully enqueued into BullMQ. */
  readonly enqueued: number;
};

/** Handler for one durable job envelope. */
export type DurableJobHandler<TPayload extends JobPayload = JobPayload> = (
  envelope: JobEnvelope<TPayload>,
) => Promise<void>;

/** Job type to durable handler mapping used by worker processes. */
export type DurableJobHandlerMap = Readonly<Record<string, DurableJobHandler | undefined>>;

/** Dependencies required by the durable worker processor wrapper. */
export type DurableJobProcessorOptions = {
  /** Durable job store used for lifecycle updates. */
  readonly store: DurableJobStore;
  /** Registered job handlers keyed by job type. */
  readonly handlers: DurableJobHandlerMap;
  /** Optional metric recorder used to aggregate durable job processing. */
  readonly metrics?: TelemetryMetricRecorder;
  /** Optional span recorder used to trace durable job processing. */
  readonly traces?: TelemetrySpanRecorder;
};

const jobEnvelopeSchema = JobEnvelopeSchema(JobPayloadSchema);
const defaultStaleRunningJobRecoveryLimit = 100;
const maxStaleRunningJobRecoveryLimit = 1_000;
const queueNameValues = new Set<string>(Object.values(QUEUE_NAMES));
const staleRunningJobErrorName = "StaleDurableJobError";

/** Parses and validates a durable job envelope. */
export function parseJobEnvelope(input: unknown): JobEnvelope<JobPayload> {
  return parseWithSchema("JobEnvelope", jobEnvelopeSchema, input) as JobEnvelope<JobPayload>;
}

/** Converts an unknown thrown value into a JSON-safe job error. */
export function serializeJobError(error: unknown): SerializedJobError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }

  return {
    name: "Error",
    message: String(error),
  };
}

/** Queue producer that records jobs in memory for tests. */
export class InMemoryQueueProducer implements QueueProducer {
  /** Jobs enqueued through this producer. */
  public readonly jobs: QueueJobIntent[] = [];

  /** Records a job intent. */
  public async enqueue(intent: QueueJobIntent): Promise<void> {
    this.jobs.push(intent);
  }

  /** No-op close method for interface compatibility. */
  public async close(): Promise<void> {}
}

/** In-memory durable job store for worker and dispatcher unit tests. */
export class InMemoryDurableJobStore implements DurableJobStore {
  private readonly jobs = new Map<string, DurableJob>();

  /** Creates an in-memory store with optional seed jobs. */
  public constructor(jobs: readonly DurableJob[] = []) {
    for (const job of jobs) {
      this.jobs.set(this.key(job.envelope), job);
    }
  }

  /** Returns a snapshot of stored jobs for assertions. */
  public list(): readonly DurableJob[] {
    return [...this.jobs.values()];
  }

  /** Adds a durable job to the in-memory store. */
  public add(job: DurableJob): void {
    this.jobs.set(this.key(job.envelope), job);
  }

  /** Returns pending jobs eligible for enqueue. */
  public async claimPending(options: ClaimPendingJobsOptions): Promise<readonly DurableJob[]> {
    return this.list()
      .filter((job) => job.status === "pending")
      .slice(0, options.limit);
  }

  /** Repairs stale running jobs after worker crashes or lost BullMQ attempts. */
  public async recoverStaleRunningJobs(
    options: RecoverStaleRunningJobsOptions,
  ): Promise<RecoverStaleRunningJobsResult> {
    const now = options.now ?? new Date();
    const cutoff = staleRunningJobCutoff(now, options.staleAfterMs);
    const error = staleRunningJobError(cutoff);
    const staleJobs = this.list()
      .filter((job) => isStaleRunningJob(job, cutoff))
      .slice(0, normalizeStaleRunningJobRecoveryLimit(options.limit));
    let requeued = 0;
    let deadLettered = 0;

    for (const job of staleJobs) {
      if (job.attempts < job.maxAttempts) {
        this.jobs.set(this.key(job.envelope), {
          ...job,
          error,
          status: "queued",
          updatedAt: now,
        });
        requeued += 1;
      } else {
        this.jobs.set(this.key(job.envelope), {
          ...job,
          completedAt: now,
          error,
          status: "dead_lettered",
          updatedAt: now,
        });
        deadLettered += 1;
      }
    }

    return {
      deadLettered,
      inspected: staleJobs.length,
      jobIds: staleJobs.map((job) => job.backgroundJobId),
      requeued,
    };
  }

  /** Marks a pending durable job as queued. */
  public async markQueued(job: DurableJob): Promise<void> {
    const existing = this.jobs.get(this.key(job.envelope));
    if (!existing || existing.status !== "pending") {
      return;
    }

    this.jobs.set(this.key(job.envelope), {
      ...existing,
      status: "queued",
      updatedAt: new Date(),
    });
  }

  /** Marks a queued durable job as running. */
  public async markRunning(envelope: JobEnvelope<JobPayload>): Promise<DurableJobRunState> {
    const existing = this.jobs.get(this.key(envelope));
    if (!existing) {
      return "missing";
    }
    if (existing.status === "canceled") {
      return "canceled";
    }
    if (isTerminalDurableJobStatus(existing.status)) {
      return "already_completed";
    }

    const now = new Date();
    this.jobs.set(this.key(envelope), {
      ...existing,
      attempts: existing.attempts + 1,
      startedAt: now,
      status: "running",
      updatedAt: now,
    });
    return "running";
  }

  /** Marks a durable job as completed. */
  public async markCompleted(envelope: JobEnvelope<JobPayload>): Promise<void> {
    const existing = this.jobs.get(this.key(envelope));
    if (existing && isActiveDurableJobStatus(existing.status)) {
      const now = new Date();
      this.jobs.set(this.key(envelope), {
        ...existing,
        completedAt: now,
        status: "completed",
        updatedAt: now,
      });
    }
  }

  /** Marks a durable job as queued for retry. */
  public async markRetrying(
    envelope: JobEnvelope<JobPayload>,
    error: SerializedJobError,
  ): Promise<void> {
    const existing = this.jobs.get(this.key(envelope));
    if (existing && isActiveDurableJobStatus(existing.status)) {
      this.jobs.set(this.key(envelope), {
        ...existing,
        error,
        status: "queued",
        updatedAt: new Date(),
      });
    }
  }

  /** Marks a durable job as permanently failed. */
  public async markFailed(
    envelope: JobEnvelope<JobPayload>,
    error: SerializedJobError,
  ): Promise<void> {
    const existing = this.jobs.get(this.key(envelope));
    if (existing && isActiveDurableJobStatus(existing.status)) {
      this.jobs.set(this.key(envelope), {
        ...existing,
        completedAt: new Date(),
        error,
        status: "failed",
        updatedAt: new Date(),
      });
    }
  }

  private key(envelope: JobEnvelope<JobPayload>): string {
    return `${envelope.jobType}:${envelope.idempotencyKey}`;
  }
}

/** Drizzle-backed durable job store for Postgres background job rows. */
export class DrizzleDurableJobStore implements DurableJobStore {
  private readonly backgroundJobs: BackgroundJobRepository;

  /** Creates a durable job store backed by a Heimdall database. */
  public constructor(db: HeimdallDatabase) {
    this.backgroundJobs = new BackgroundJobRepository(db);
  }

  /** Returns pending jobs eligible for enqueue. */
  public async claimPending(options: ClaimPendingJobsOptions): Promise<readonly DurableJob[]> {
    const rows = await this.backgroundJobs.claimPendingJobs(options);

    return rows.map(toDurableJob);
  }

  /** Repairs stale running jobs after worker crashes or lost BullMQ attempts. */
  public async recoverStaleRunningJobs(
    options: RecoverStaleRunningJobsOptions,
  ): Promise<RecoverStaleRunningJobsResult> {
    return this.backgroundJobs.recoverStaleRunningJobs(options);
  }

  /** Marks a pending durable job as queued. */
  public async markQueued(job: DurableJob): Promise<void> {
    await this.backgroundJobs.markQueued({
      jobKey: job.envelope.idempotencyKey,
      queueName: job.queueName,
    });
  }

  /** Marks a queued durable job as running. */
  public async markRunning(envelope: JobEnvelope<JobPayload>): Promise<DurableJobRunState> {
    return this.backgroundJobs.markRunning({
      jobKey: envelope.idempotencyKey,
      jobType: envelope.jobType,
    });
  }

  /** Marks a durable job as completed. */
  public async markCompleted(envelope: JobEnvelope<JobPayload>): Promise<void> {
    await this.backgroundJobs.markCompleted({
      jobKey: envelope.idempotencyKey,
      jobType: envelope.jobType,
    });
  }

  /** Marks a durable job as queued for retry. */
  public async markRetrying(
    envelope: JobEnvelope<JobPayload>,
    error: SerializedJobError,
  ): Promise<void> {
    await this.backgroundJobs.markRetrying(
      { jobKey: envelope.idempotencyKey, jobType: envelope.jobType },
      error,
    );
  }

  /** Marks a durable job as permanently failed. */
  public async markFailed(
    envelope: JobEnvelope<JobPayload>,
    error: SerializedJobError,
  ): Promise<void> {
    await this.backgroundJobs.markFailed(
      { jobKey: envelope.idempotencyKey, jobType: envelope.jobType },
      error,
    );
  }
}

/** Converts a DB-owned background job row into the queue store contract. */
function toDurableJob(row: BackgroundJobRecord): DurableJob {
  return {
    backgroundJobId: row.backgroundJobId,
    queueName: toQueueName(row.queueName),
    envelope: row.envelope,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    ...(row.startedAt ? { startedAt: row.startedAt } : {}),
    ...(row.completedAt ? { completedAt: row.completedAt } : {}),
    ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}),
    ...(row.error ? { error: row.error } : {}),
  };
}

/** BullMQ-backed queue producer. */
export class BullMqQueueProducer implements QueueProducer {
  private readonly connection: IORedis;
  private readonly queues = new Map<QueueName, Queue>();

  /** Creates a BullMQ queue producer. */
  public constructor(redisUrl = loadRuntimeConfig().redisUrl) {
    this.connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  }

  /** Enqueues a job intent with a BullMQ-safe hash of the durable idempotency key. */
  public async enqueue(intent: QueueJobIntent): Promise<void> {
    const queue = this.getQueue(intent.queueName);

    await queue.add(intent.envelope.jobType, intent.envelope, {
      jobId: bullMqJobIdForIdempotencyKey(intent.envelope.idempotencyKey),
      attempts: intent.envelope.maxAttempts,
      removeOnComplete: false,
      removeOnFail: false,
    });
  }

  /** Closes BullMQ queues and Redis connection. */
  public async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    await this.connection.quit();
  }

  private getQueue(queueName: QueueName): Queue {
    const existing = this.queues.get(queueName);
    if (existing) {
      return existing;
    }

    const queue = new Queue(queueName, { connection: this.connection });
    this.queues.set(queueName, queue);
    return queue;
  }
}

/** Converts a durable idempotency key into a BullMQ-safe custom job ID. */
export function bullMqJobIdForIdempotencyKey(idempotencyKey: string): string {
  return `heimdall_${createHash("sha256").update(idempotencyKey).digest("base64url")}`;
}

/** Enqueues pending durable jobs into BullMQ and marks accepted rows queued. */
export async function dispatchPendingJobs(options: {
  /** Durable job store containing pending rows. */
  readonly store: DurableJobStore;
  /** Queue producer that writes to BullMQ. */
  readonly queueProducer: QueueProducer;
  /** Maximum rows to dispatch in one pass. */
  readonly batchSize?: number;
  /** Current time override for tests. */
  readonly now?: Date;
}): Promise<DispatchPendingJobsResult> {
  const jobs = await options.store.claimPending({
    limit: options.batchSize ?? 50,
    now: options.now ?? new Date(),
  });
  let enqueued = 0;

  for (const job of jobs) {
    await options.queueProducer.enqueue(job);
    await options.store.markQueued(job);
    enqueued += 1;
  }

  return {
    claimed: jobs.length,
    enqueued,
  };
}

/** Creates a BullMQ processor that wraps handlers with durable lifecycle updates. */
export function createDurableJobProcessor(options: DurableJobProcessorOptions) {
  return async (job: BullMqJob<unknown>): Promise<void> => {
    const envelope = parseJobEnvelope(job.data);
    const queueName = queueNameFromBullMqJob(job);
    const startedAtMs = Date.now();
    const span = options.traces?.startSpan(OBSERVABILITY_SPAN_NAMES.durableJobProcess, {
      attributes: durableJobSpanAttributes(envelope, queueName),
      kind: "consumer",
      ...(envelope.traceContext ? { traceContext: envelope.traceContext } : {}),
    });
    let runState: DurableJobRunState;
    try {
      runState = await options.store.markRunning(envelope);
    } catch (error) {
      recordDurableJobFailureMetrics(
        options.metrics,
        envelope,
        queueName,
        "mark_running_failed",
        Date.now() - startedAtMs,
        error,
      );
      span?.end({ attributes: { "job.run_state": "mark_running_failed" }, error });
      throw error;
    }
    if (runState === "already_completed" || runState === "canceled") {
      span?.end({ attributes: { "job.run_state": runState } });
      return;
    }
    if (runState === "missing") {
      const error = new Error(
        `Durable job ${envelope.jobType}:${envelope.idempotencyKey} was not found or is not runnable.`,
      );
      recordDurableJobFailureMetrics(
        options.metrics,
        envelope,
        queueName,
        runState,
        Date.now() - startedAtMs,
        error,
      );
      span?.end({ attributes: { "job.run_state": runState }, error });
      throw error;
    }
    recordDurableJobStartedMetric(options.metrics, envelope, queueName);

    const handler = options.handlers[envelope.jobType];
    if (!handler) {
      const error = new Error(`No handler registered for job type ${envelope.jobType}.`);
      try {
        await options.store.markFailed(envelope, serializeJobError(error));
      } finally {
        recordDurableJobFailureMetrics(
          options.metrics,
          envelope,
          queueName,
          "missing_handler",
          Date.now() - startedAtMs,
          error,
        );
        span?.end({ attributes: { "job.run_state": "missing_handler" }, error });
      }
      throw error;
    }

    try {
      await handler(envelope);
      await options.store.markCompleted(envelope);
      recordDurableJobCompletedMetrics(
        options.metrics,
        envelope,
        queueName,
        Date.now() - startedAtMs,
      );
      span?.end({ attributes: { "job.run_state": "completed" } });
    } catch (error) {
      const serialized = serializeJobError(error);
      const isFinalAttempt = job.attemptsMade + 1 >= envelope.maxAttempts;
      try {
        if (isFinalAttempt) {
          await options.store.markFailed(envelope, serialized);
        } else {
          await options.store.markRetrying(envelope, serialized);
        }
      } finally {
        if (isFinalAttempt) {
          recordDurableJobFailureMetrics(
            options.metrics,
            envelope,
            queueName,
            "failed",
            Date.now() - startedAtMs,
            error,
          );
        } else {
          recordDurableJobRetryMetrics(
            options.metrics,
            envelope,
            queueName,
            Date.now() - startedAtMs,
            error,
          );
        }
        span?.end({
          attributes: { "job.run_state": isFinalAttempt ? "failed" : "retrying" },
          error,
        });
      }
      throw error;
    }
  };
}

/** Returns low-cardinality span attributes for one durable job envelope. */
function durableJobSpanAttributes(
  envelope: JobEnvelope<JobPayload>,
  queueName: QueueName | "unknown",
): Readonly<Record<string, string | number>> {
  return {
    "job.attempt": envelope.attempt,
    "job.max_attempts": envelope.maxAttempts,
    "job.type": envelope.jobType,
    "queue.name": queueName,
  };
}

/** Records a durable job start counter. */
function recordDurableJobStartedMetric(
  metrics: TelemetryMetricRecorder | undefined,
  envelope: JobEnvelope<JobPayload>,
  queueName: QueueName | "unknown",
): void {
  metrics?.count(OBSERVABILITY_METRIC_NAMES.queueJobsStartedTotal, {
    labels: durableJobMetricLabels(envelope, queueName, "started"),
  });
}

/** Records durable job completion counters and duration histograms. */
function recordDurableJobCompletedMetrics(
  metrics: TelemetryMetricRecorder | undefined,
  envelope: JobEnvelope<JobPayload>,
  queueName: QueueName | "unknown",
  durationMs: number,
): void {
  const labels = durableJobMetricLabels(envelope, queueName, "completed");
  metrics?.count(OBSERVABILITY_METRIC_NAMES.queueJobsCompletedTotal, { labels });
  metrics?.histogram(OBSERVABILITY_METRIC_NAMES.queueJobDurationMs, Math.max(0, durationMs), {
    labels,
    unit: "ms",
  });
}

/** Records durable job final failure counters and duration histograms. */
function recordDurableJobFailureMetrics(
  metrics: TelemetryMetricRecorder | undefined,
  envelope: JobEnvelope<JobPayload>,
  queueName: QueueName | "unknown",
  status: string,
  durationMs: number,
  error: unknown,
): void {
  const labels = durableJobMetricLabels(envelope, queueName, status, error);
  metrics?.count(OBSERVABILITY_METRIC_NAMES.queueJobsFailedTotal, { labels });
  metrics?.histogram(OBSERVABILITY_METRIC_NAMES.queueJobDurationMs, Math.max(0, durationMs), {
    labels,
    unit: "ms",
  });
}

/** Records durable job retry counters and duration histograms. */
function recordDurableJobRetryMetrics(
  metrics: TelemetryMetricRecorder | undefined,
  envelope: JobEnvelope<JobPayload>,
  queueName: QueueName | "unknown",
  durationMs: number,
  error: unknown,
): void {
  const labels = durableJobMetricLabels(envelope, queueName, "retrying", error);
  metrics?.count(OBSERVABILITY_METRIC_NAMES.queueRetriesTotal, { labels });
  metrics?.histogram(OBSERVABILITY_METRIC_NAMES.queueJobDurationMs, Math.max(0, durationMs), {
    labels,
    unit: "ms",
  });
}

/** Returns low-cardinality metric labels for one durable job event. */
function durableJobMetricLabels(
  envelope: JobEnvelope<JobPayload>,
  queueName: QueueName | "unknown",
  status: string,
  error?: unknown,
): Readonly<Record<string, string>> {
  return {
    ...(error === undefined ? {} : { error_class: classifyTelemetryError(error) }),
    job_type: envelope.jobType,
    queue_name: queueName,
    status,
  };
}

/** Reads a BullMQ queue name without trusting untyped test doubles. */
function queueNameFromBullMqJob(job: BullMqJob<unknown>): QueueName | "unknown" {
  const queueName = (job as { readonly queueName?: unknown }).queueName;
  if (typeof queueName === "string" && queueNameValues.has(queueName)) {
    return queueName as QueueName;
  }

  return "unknown";
}

/** Returns whether a durable job status can still receive lifecycle updates. */
function isActiveDurableJobStatus(status: JobStatus): boolean {
  return status === "pending" || status === "queued" || status === "running";
}

/** Returns whether a durable job status is terminal for handler dispatch. */
function isTerminalDurableJobStatus(status: JobStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "dead_lettered" ||
    status === "canceled"
  );
}

/** Returns whether a durable job is running beyond the configured cutoff. */
function isStaleRunningJob(job: DurableJob, cutoff: Date): boolean {
  const runningTimestamp = job.startedAt ?? job.updatedAt;

  return (
    job.status === "running" &&
    runningTimestamp !== undefined &&
    runningTimestamp.getTime() <= cutoff.getTime()
  );
}

/** Calculates the stale running cutoff from a current time and duration. */
function staleRunningJobCutoff(now: Date, staleAfterMs: number): Date {
  const normalizedStaleAfterMs =
    Number.isFinite(staleAfterMs) && staleAfterMs > 0 ? Math.trunc(staleAfterMs) : 1;

  return new Date(now.getTime() - normalizedStaleAfterMs);
}

/** Builds a durable error payload for stale running job repair. */
function staleRunningJobError(cutoff: Date): SerializedJobError {
  return {
    message: `Durable job exceeded the running timeout before ${cutoff.toISOString()}.`,
    name: staleRunningJobErrorName,
  };
}

/** Normalizes stale running recovery limits to a bounded positive integer. */
function normalizeStaleRunningJobRecoveryLimit(limit: number | undefined): number {
  const requestedLimit =
    limit === undefined || !Number.isFinite(limit) || limit <= 0
      ? defaultStaleRunningJobRecoveryLimit
      : Math.trunc(limit);

  return Math.min(maxStaleRunningJobRecoveryLimit, Math.max(1, requestedLimit));
}

function toQueueName(value: string): QueueName {
  if (!queueNameValues.has(value)) {
    throw new Error(`Unknown queue name ${value}.`);
  }

  return value as QueueName;
}
