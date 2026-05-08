import {
  type JobEnvelope,
  JobEnvelopeSchema,
  type JobPayload,
  JobPayloadSchema,
  type JobStatus,
  parseWithSchema,
} from "@repo/contracts";
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { HeimdallDatabase } from "../client";
import { backgroundJobs } from "../schema";

/** Database surface required by background job repository methods. */
type BackgroundJobRepositoryDatabase = Pick<HeimdallDatabase, "insert" | "select" | "update">;

/** Product-safe durable job error payload stored on background job rows. */
export type BackgroundJobError = {
  /** Error class or stable fallback name. */
  readonly name: string;
  /** Human-readable error message. */
  readonly message: string;
  /** Optional stack trace for local debugging. */
  readonly stack?: string;
};

/** Durable job row mapped from the background job table. */
export type BackgroundJobRecord<TPayload extends JobPayload = JobPayload> = {
  /** Durable background job row ID. */
  readonly backgroundJobId: string;
  /** Queue name that receives this job. */
  readonly queueName: string;
  /** Durable idempotency key for this queue. */
  readonly jobKey: string;
  /** Contract job type from the stored envelope. */
  readonly jobType: string;
  /** Current durable job status. */
  readonly status: JobStatus;
  /** Organization scope when known. */
  readonly orgId?: string;
  /** Repository scope when known. */
  readonly repoId?: string;
  /** Review-run scope when known. */
  readonly reviewRunId?: string;
  /** Parsed durable job envelope. */
  readonly envelope: JobEnvelope<TPayload>;
  /** Number of handler attempts recorded by the durable store. */
  readonly attempts: number;
  /** Maximum attempts allowed for this job. */
  readonly maxAttempts: number;
  /** Time when the job becomes eligible for dispatch. */
  readonly scheduledAt?: Date;
  /** Time when a worker last started the job. */
  readonly startedAt?: Date;
  /** Time when the job reached a terminal state. */
  readonly completedAt?: Date;
  /** Product-safe error payload from the latest failed attempt. */
  readonly error?: BackgroundJobError;
  /** Product-safe metadata for internal debugging. */
  readonly metadata?: Record<string, unknown>;
  /** Row creation time. */
  readonly createdAt: Date;
  /** Last row update time. */
  readonly updatedAt: Date;
};

/** Input for idempotently inserting a durable background job row. */
export type InsertBackgroundJobInput<TPayload extends JobPayload = JobPayload> = {
  /** Durable background job row ID. */
  readonly backgroundJobId: string;
  /** Queue name that receives this job. */
  readonly queueName: string;
  /** Durable job envelope stored as the dispatch payload. */
  readonly envelope: JobEnvelope<TPayload>;
  /** Initial durable status. */
  readonly status?: JobStatus;
  /** Organization scope when known. */
  readonly orgId?: string;
  /** Repository scope when known. */
  readonly repoId?: string;
  /** Review-run scope when known. */
  readonly reviewRunId?: string;
  /** Number of attempts already recorded. */
  readonly attempts?: number;
  /** Maximum attempts allowed for this job. */
  readonly maxAttempts?: number;
  /** Time when the job becomes eligible for dispatch. */
  readonly scheduledAt?: Date | string;
  /** Time when a worker last started the job. */
  readonly startedAt?: Date | string;
  /** Time when the job reached a terminal state. */
  readonly completedAt?: Date | string;
  /** Product-safe error payload from the latest failed attempt. */
  readonly error?: BackgroundJobError;
  /** Product-safe metadata for internal debugging. */
  readonly metadata?: Record<string, unknown>;
  /** Row creation time override for tests and migrations. */
  readonly createdAt?: Date | string;
  /** Last row update time override for tests and migrations. */
  readonly updatedAt?: Date | string;
};

/** Result for an idempotent durable job insert. */
export type InsertBackgroundJobResult<TPayload extends JobPayload = JobPayload> = {
  /** Durable job row. */
  readonly job: BackgroundJobRecord<TPayload>;
  /** Whether this call inserted the row. */
  readonly inserted: boolean;
};

/** Durable queue/job-key identity. */
export type BackgroundJobQueueIdentity = {
  /** Queue name that owns the job key. */
  readonly queueName: string;
  /** Durable job idempotency key. */
  readonly jobKey: string;
};

/** Durable job-type/job-key identity. */
export type BackgroundJobTypeIdentity = {
  /** Contract job type from the stored envelope. */
  readonly jobType: string;
  /** Durable job idempotency key. */
  readonly jobKey: string;
};

/** Options for claiming pending durable jobs. */
export type ClaimPendingBackgroundJobsOptions = {
  /** Maximum rows to claim. */
  readonly limit: number;
  /** Current time used for scheduled job eligibility. */
  readonly now: Date;
};

/** Options for repairing stale running durable jobs. */
export type RecoverStaleBackgroundJobsOptions = {
  /** Maximum stale rows to repair. */
  readonly limit?: number;
  /** Current time used to calculate the stale cutoff. */
  readonly now?: Date;
  /** Running duration after which a job is considered stale. */
  readonly staleAfterMs: number;
};

/** Result from one stale running recovery pass. */
export type RecoverStaleBackgroundJobsResult = {
  /** Number of stale running rows considered for repair. */
  readonly inspected: number;
  /** Number of stale rows moved back to queued. */
  readonly requeued: number;
  /** Number of stale rows moved to dead-lettered. */
  readonly deadLettered: number;
  /** Durable job row IDs that were repaired. */
  readonly jobIds: readonly string[];
};

/** Durable job lifecycle state returned when marking a worker run. */
export type BackgroundJobRunState = "running" | "already_completed" | "missing";

const jobEnvelopeSchema = JobEnvelopeSchema(JobPayloadSchema);
const defaultStaleRunningJobRecoveryLimit = 100;
const maxStaleRunningJobRecoveryLimit = 1_000;

/** Query helper for durable background job lifecycle operations. */
export class BackgroundJobRepository {
  /** Creates a background job query helper. */
  public constructor(private readonly db: BackgroundJobRepositoryDatabase) {}

  /** Inserts a durable job row without duplicating queue/job-key pairs. */
  public async insertBackgroundJob<TPayload extends JobPayload>(
    input: InsertBackgroundJobInput<TPayload>,
  ): Promise<InsertBackgroundJobResult<TPayload>> {
    const [insertedRow] = await this.db
      .insert(backgroundJobs)
      .values({
        backgroundJobId: input.backgroundJobId,
        queueName: input.queueName,
        jobKey: input.envelope.idempotencyKey,
        jobType: input.envelope.jobType,
        status: input.status ?? "pending",
        orgId: input.orgId,
        repoId: input.repoId,
        reviewRunId: input.reviewRunId,
        payload: input.envelope,
        attempts: input.attempts,
        maxAttempts: input.maxAttempts ?? input.envelope.maxAttempts,
        scheduledAt: toOptionalDate(input.scheduledAt ?? input.envelope.scheduledFor),
        startedAt: toOptionalDate(input.startedAt),
        completedAt: toOptionalDate(input.completedAt),
        error: input.error,
        metadata: input.metadata,
        createdAt: toOptionalDate(input.createdAt),
        updatedAt: toOptionalDate(input.updatedAt),
      })
      .onConflictDoNothing({
        target: [backgroundJobs.queueName, backgroundJobs.jobKey],
      })
      .returning();

    if (insertedRow) {
      return {
        inserted: true,
        job: toBackgroundJobRecord(insertedRow) as BackgroundJobRecord<TPayload>,
      };
    }

    const existing = await this.getBackgroundJobByQueueAndKey({
      jobKey: input.envelope.idempotencyKey,
      queueName: input.queueName,
    });
    if (!existing) {
      throw new Error("Background job insert conflicted but no existing job row was found.");
    }

    return { inserted: false, job: existing as BackgroundJobRecord<TPayload> };
  }

  /** Gets a durable job by queue and job key. */
  public async getBackgroundJobByQueueAndKey(
    input: BackgroundJobQueueIdentity,
  ): Promise<BackgroundJobRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(backgroundJobs)
      .where(
        and(eq(backgroundJobs.queueName, input.queueName), eq(backgroundJobs.jobKey, input.jobKey)),
      )
      .limit(1);

    return row ? toBackgroundJobRecord(row) : undefined;
  }

  /** Returns pending jobs eligible for dispatch. */
  public async claimPendingJobs(
    options: ClaimPendingBackgroundJobsOptions,
  ): Promise<readonly BackgroundJobRecord[]> {
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

    return rows.map(toBackgroundJobRecord);
  }

  /** Repairs stale running jobs after worker crashes or lost BullMQ attempts. */
  public async recoverStaleRunningJobs(
    options: RecoverStaleBackgroundJobsOptions,
  ): Promise<RecoverStaleBackgroundJobsResult> {
    const now = options.now ?? new Date();
    const cutoff = staleRunningJobCutoff(now, options.staleAfterMs);
    const limit = normalizeStaleRunningJobRecoveryLimit(options.limit);
    const error = staleRunningJobError(cutoff);
    const rows = await this.db
      .select({
        attempts: backgroundJobs.attempts,
        backgroundJobId: backgroundJobs.backgroundJobId,
        maxAttempts: backgroundJobs.maxAttempts,
      })
      .from(backgroundJobs)
      .where(
        and(
          eq(backgroundJobs.status, "running"),
          or(
            lte(backgroundJobs.startedAt, cutoff),
            and(isNull(backgroundJobs.startedAt), lte(backgroundJobs.updatedAt, cutoff)),
          ),
        ),
      )
      .orderBy(asc(backgroundJobs.updatedAt))
      .limit(limit);
    const retryableIds = rows
      .filter((row) => row.attempts < row.maxAttempts)
      .map((row) => row.backgroundJobId);
    const exhaustedIds = rows
      .filter((row) => row.attempts >= row.maxAttempts)
      .map((row) => row.backgroundJobId);
    const requeued = await this.requeueStaleRunningJobs(retryableIds, error, now);
    const deadLettered = await this.deadLetterStaleRunningJobs(exhaustedIds, error, now);

    return {
      deadLettered: deadLettered.length,
      inspected: rows.length,
      jobIds: [...requeued, ...deadLettered],
      requeued: requeued.length,
    };
  }

  /** Marks a pending durable job as queued after Redis accepts it. */
  public async markQueued(input: BackgroundJobQueueIdentity): Promise<void> {
    await this.db
      .update(backgroundJobs)
      .set({ status: "queued", updatedAt: new Date() })
      .where(
        and(
          eq(backgroundJobs.queueName, input.queueName),
          eq(backgroundJobs.jobKey, input.jobKey),
          eq(backgroundJobs.status, "pending"),
        ),
      );
  }

  /** Marks a queued durable job as running and records one handler attempt. */
  public async markRunning(input: BackgroundJobTypeIdentity): Promise<BackgroundJobRunState> {
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
          eq(backgroundJobs.jobType, input.jobType),
          eq(backgroundJobs.jobKey, input.jobKey),
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
        and(eq(backgroundJobs.jobType, input.jobType), eq(backgroundJobs.jobKey, input.jobKey)),
      )
      .limit(1);

    return existing?.status === "completed" ? "already_completed" : "missing";
  }

  /** Marks a durable job as completed. */
  public async markCompleted(input: BackgroundJobTypeIdentity): Promise<void> {
    await this.updateByTypeAndKey(input, {
      completedAt: new Date(),
      error: null,
      status: "completed",
      updatedAt: new Date(),
    });
  }

  /** Marks a durable job as queued for retry. */
  public async markRetrying(
    input: BackgroundJobTypeIdentity,
    error: BackgroundJobError,
  ): Promise<void> {
    await this.updateByTypeAndKey(input, {
      error,
      status: "queued",
      updatedAt: new Date(),
    });
  }

  /** Marks a durable job as permanently failed. */
  public async markFailed(
    input: BackgroundJobTypeIdentity,
    error: BackgroundJobError,
  ): Promise<void> {
    await this.updateByTypeAndKey(input, {
      completedAt: new Date(),
      error,
      status: "failed",
      updatedAt: new Date(),
    });
  }

  /** Applies a partial update by durable job type and key. */
  private async updateByTypeAndKey(
    input: BackgroundJobTypeIdentity,
    values: Partial<typeof backgroundJobs.$inferInsert>,
  ): Promise<void> {
    await this.db
      .update(backgroundJobs)
      .set(values)
      .where(
        and(eq(backgroundJobs.jobType, input.jobType), eq(backgroundJobs.jobKey, input.jobKey)),
      );
  }

  /** Moves retryable stale running rows back to queued. */
  private async requeueStaleRunningJobs(
    backgroundJobIds: readonly string[],
    error: BackgroundJobError,
    now: Date,
  ): Promise<readonly string[]> {
    if (backgroundJobIds.length === 0) {
      return [];
    }

    const rows = await this.db
      .update(backgroundJobs)
      .set({
        completedAt: null,
        error,
        startedAt: null,
        status: "queued",
        updatedAt: now,
      })
      .where(
        and(
          eq(backgroundJobs.status, "running"),
          inArray(backgroundJobs.backgroundJobId, backgroundJobIds),
        ),
      )
      .returning({ backgroundJobId: backgroundJobs.backgroundJobId });

    return rows.map((row) => row.backgroundJobId);
  }

  /** Moves exhausted stale running rows to the dead-letter state. */
  private async deadLetterStaleRunningJobs(
    backgroundJobIds: readonly string[],
    error: BackgroundJobError,
    now: Date,
  ): Promise<readonly string[]> {
    if (backgroundJobIds.length === 0) {
      return [];
    }

    const rows = await this.db
      .update(backgroundJobs)
      .set({
        completedAt: now,
        error,
        status: "dead_lettered",
        updatedAt: now,
      })
      .where(
        and(
          eq(backgroundJobs.status, "running"),
          inArray(backgroundJobs.backgroundJobId, backgroundJobIds),
        ),
      )
      .returning({ backgroundJobId: backgroundJobs.backgroundJobId });

    return rows.map((row) => row.backgroundJobId);
  }
}

/** Maps a database row to the durable background job record contract. */
function toBackgroundJobRecord(row: typeof backgroundJobs.$inferSelect): BackgroundJobRecord {
  const error = toBackgroundJobError(row.error);
  const metadata = toMetadata(row.metadata);

  return {
    backgroundJobId: row.backgroundJobId,
    queueName: row.queueName,
    jobKey: row.jobKey,
    jobType: row.jobType,
    status: row.status as JobStatus,
    ...(row.orgId ? { orgId: row.orgId } : {}),
    ...(row.repoId ? { repoId: row.repoId } : {}),
    ...(row.reviewRunId ? { reviewRunId: row.reviewRunId } : {}),
    envelope: parseJobEnvelope(row.payload),
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    ...(row.scheduledAt ? { scheduledAt: row.scheduledAt } : {}),
    ...(row.startedAt ? { startedAt: row.startedAt } : {}),
    ...(row.completedAt ? { completedAt: row.completedAt } : {}),
    ...(error ? { error } : {}),
    ...(metadata ? { metadata } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Parses a durable job envelope stored in a JSON payload column. */
function parseJobEnvelope(input: unknown): JobEnvelope<JobPayload> {
  return parseWithSchema("JobEnvelope", jobEnvelopeSchema, input) as JobEnvelope<JobPayload>;
}

/** Converts a date-like input to a Date instance for Drizzle writes. */
function toOptionalDate(value: Date | string | undefined): Date | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value instanceof Date ? value : new Date(value);
}

/** Parses a product-safe job error from a JSON column. */
function toBackgroundJobError(input: unknown): BackgroundJobError | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }

  const record = input as Record<string, unknown>;
  if (typeof record.name !== "string" || typeof record.message !== "string") {
    return undefined;
  }

  return {
    name: record.name,
    message: record.message,
    ...(typeof record.stack === "string" ? { stack: record.stack } : {}),
  };
}

/** Returns product-safe metadata from a JSON column. */
function toMetadata(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  return input as Record<string, unknown>;
}

/** Normalizes the maximum stale running rows handled in one recovery pass. */
function normalizeStaleRunningJobRecoveryLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return defaultStaleRunningJobRecoveryLimit;
  }

  if (!Number.isFinite(limit) || limit <= 0) {
    return defaultStaleRunningJobRecoveryLimit;
  }

  return Math.min(Math.trunc(limit), maxStaleRunningJobRecoveryLimit);
}

/** Calculates the stale running cutoff from a current time and duration. */
function staleRunningJobCutoff(now: Date, staleAfterMs: number): Date {
  const normalizedStaleAfterMs =
    Number.isFinite(staleAfterMs) && staleAfterMs > 0 ? Math.trunc(staleAfterMs) : 1;

  return new Date(now.getTime() - normalizedStaleAfterMs);
}

/** Builds a durable error payload for stale running job repair. */
function staleRunningJobError(cutoff: Date): BackgroundJobError {
  return {
    name: "StaleDurableJobError",
    message: `Durable job was still running after stale cutoff ${cutoff.toISOString()}.`,
  };
}
