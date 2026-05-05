import { loadRuntimeConfig } from "@repo/config";
import {
  type JobEnvelope,
  JobEnvelopeSchema,
  type JobPayload,
  JobPayloadSchema,
  type JobStatus,
  parseWithSchema,
} from "@repo/contracts";
import { backgroundJobs, type HeimdallDatabase } from "@repo/db";
import { type Job as BullMqJob, Queue } from "bullmq";
import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import IORedis from "ioredis";

/** Queue names used by Heimdall workers. */
export const QUEUE_NAMES = {
  repoSync: "repo-sync",
  indexing: "indexing",
  review: "review",
  memory: "memory",
  publishing: "publishing",
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

/** Durable lifecycle state returned when a worker starts a job. */
export type DurableJobRunState = "running" | "already_completed" | "missing";

/** Durable job state store used by dispatchers and workers. */
export type DurableJobStore = {
  /** Returns pending jobs eligible for enqueue. */
  readonly claimPending: (options: ClaimPendingJobsOptions) => Promise<readonly DurableJob[]>;
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
};

const jobEnvelopeSchema = JobEnvelopeSchema(JobPayloadSchema);
const queueNameValues = new Set<string>(Object.values(QUEUE_NAMES));

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

  /** Marks a pending durable job as queued. */
  public async markQueued(job: DurableJob): Promise<void> {
    const existing = this.jobs.get(this.key(job.envelope));
    if (!existing || existing.status !== "pending") {
      return;
    }

    this.jobs.set(this.key(job.envelope), { ...existing, status: "queued" });
  }

  /** Marks a queued durable job as running. */
  public async markRunning(envelope: JobEnvelope<JobPayload>): Promise<DurableJobRunState> {
    const existing = this.jobs.get(this.key(envelope));
    if (!existing) {
      return "missing";
    }
    if (existing.status === "completed") {
      return "already_completed";
    }

    this.jobs.set(this.key(envelope), {
      ...existing,
      attempts: existing.attempts + 1,
      status: "running",
    });
    return "running";
  }

  /** Marks a durable job as completed. */
  public async markCompleted(envelope: JobEnvelope<JobPayload>): Promise<void> {
    const existing = this.jobs.get(this.key(envelope));
    if (existing) {
      this.jobs.set(this.key(envelope), { ...existing, status: "completed" });
    }
  }

  /** Marks a durable job as queued for retry. */
  public async markRetrying(
    envelope: JobEnvelope<JobPayload>,
    _error: SerializedJobError,
  ): Promise<void> {
    const existing = this.jobs.get(this.key(envelope));
    if (existing) {
      this.jobs.set(this.key(envelope), { ...existing, status: "queued" });
    }
  }

  /** Marks a durable job as permanently failed. */
  public async markFailed(
    envelope: JobEnvelope<JobPayload>,
    _error: SerializedJobError,
  ): Promise<void> {
    const existing = this.jobs.get(this.key(envelope));
    if (existing) {
      this.jobs.set(this.key(envelope), { ...existing, status: "failed" });
    }
  }

  private key(envelope: JobEnvelope<JobPayload>): string {
    return `${envelope.jobType}:${envelope.idempotencyKey}`;
  }
}

/** Drizzle-backed durable job store for Postgres background job rows. */
export class DrizzleDurableJobStore implements DurableJobStore {
  /** Creates a durable job store backed by a Heimdall database. */
  public constructor(private readonly db: HeimdallDatabase) {}

  /** Returns pending jobs eligible for enqueue. */
  public async claimPending(options: ClaimPendingJobsOptions): Promise<readonly DurableJob[]> {
    const rows = await this.db
      .select()
      .from(backgroundJobs)
      .where(
        and(
          eq(backgroundJobs.status, "pending"),
          or(isNull(backgroundJobs.scheduledAt), lte(backgroundJobs.scheduledAt, options.now)),
        ),
      )
      .orderBy(asc(backgroundJobs.createdAt))
      .limit(options.limit);

    return rows.map((row) => ({
      backgroundJobId: row.backgroundJobId,
      queueName: toQueueName(row.queueName),
      envelope: parseJobEnvelope(row.payload),
      status: row.status as JobStatus,
      attempts: row.attempts,
      maxAttempts: row.maxAttempts,
    }));
  }

  /** Marks a pending durable job as queued. */
  public async markQueued(job: DurableJob): Promise<void> {
    await this.db
      .update(backgroundJobs)
      .set({ status: "queued", updatedAt: new Date() })
      .where(
        and(
          eq(backgroundJobs.queueName, job.queueName),
          eq(backgroundJobs.jobKey, job.envelope.idempotencyKey),
          eq(backgroundJobs.status, "pending"),
        ),
      );
  }

  /** Marks a queued durable job as running. */
  public async markRunning(envelope: JobEnvelope<JobPayload>): Promise<DurableJobRunState> {
    const [updated] = await this.db
      .update(backgroundJobs)
      .set({
        status: "running",
        attempts: sql`${backgroundJobs.attempts} + 1`,
        startedAt: new Date(),
        error: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(backgroundJobs.jobType, envelope.jobType),
          eq(backgroundJobs.jobKey, envelope.idempotencyKey),
          or(eq(backgroundJobs.status, "pending"), eq(backgroundJobs.status, "queued")),
        ),
      )
      .returning({ status: backgroundJobs.status });

    if (updated) {
      return "running";
    }

    const [existing] = await this.db
      .select({ status: backgroundJobs.status })
      .from(backgroundJobs)
      .where(
        and(
          eq(backgroundJobs.jobType, envelope.jobType),
          eq(backgroundJobs.jobKey, envelope.idempotencyKey),
        ),
      )
      .limit(1);

    return existing?.status === "completed" ? "already_completed" : "missing";
  }

  /** Marks a durable job as completed. */
  public async markCompleted(envelope: JobEnvelope<JobPayload>): Promise<void> {
    await this.db
      .update(backgroundJobs)
      .set({
        status: "completed",
        completedAt: new Date(),
        error: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(backgroundJobs.jobType, envelope.jobType),
          eq(backgroundJobs.jobKey, envelope.idempotencyKey),
        ),
      );
  }

  /** Marks a durable job as queued for retry. */
  public async markRetrying(
    envelope: JobEnvelope<JobPayload>,
    error: SerializedJobError,
  ): Promise<void> {
    await this.db
      .update(backgroundJobs)
      .set({
        status: "queued",
        error,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(backgroundJobs.jobType, envelope.jobType),
          eq(backgroundJobs.jobKey, envelope.idempotencyKey),
        ),
      );
  }

  /** Marks a durable job as permanently failed. */
  public async markFailed(
    envelope: JobEnvelope<JobPayload>,
    error: SerializedJobError,
  ): Promise<void> {
    await this.db
      .update(backgroundJobs)
      .set({
        status: "failed",
        completedAt: new Date(),
        error,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(backgroundJobs.jobType, envelope.jobType),
          eq(backgroundJobs.jobKey, envelope.idempotencyKey),
        ),
      );
  }
}

/** BullMQ-backed queue producer. */
export class BullMqQueueProducer implements QueueProducer {
  private readonly connection: IORedis;
  private readonly queues = new Map<QueueName, Queue>();

  /** Creates a BullMQ queue producer. */
  public constructor(redisUrl = loadRuntimeConfig().redisUrl) {
    this.connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  }

  /** Enqueues a job intent with the job idempotency key as BullMQ job ID. */
  public async enqueue(intent: QueueJobIntent): Promise<void> {
    const queue = this.getQueue(intent.queueName);

    await queue.add(intent.envelope.jobType, intent.envelope, {
      jobId: intent.envelope.idempotencyKey,
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
    const runState = await options.store.markRunning(envelope);
    if (runState === "already_completed") {
      return;
    }

    const handler = options.handlers[envelope.jobType];
    if (!handler) {
      const error = new Error(`No handler registered for job type ${envelope.jobType}.`);
      await options.store.markFailed(envelope, serializeJobError(error));
      throw error;
    }

    try {
      await handler(envelope);
      await options.store.markCompleted(envelope);
    } catch (error) {
      const serialized = serializeJobError(error);
      const isFinalAttempt = job.attemptsMade + 1 >= envelope.maxAttempts;
      if (isFinalAttempt) {
        await options.store.markFailed(envelope, serialized);
      } else {
        await options.store.markRetrying(envelope, serialized);
      }
      throw error;
    }
  };
}

function toQueueName(value: string): QueueName {
  if (!queueNameValues.has(value)) {
    throw new Error(`Unknown queue name ${value}.`);
  }

  return value as QueueName;
}
