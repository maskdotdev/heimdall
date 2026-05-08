import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type EmbeddingBatchJobPayload,
  type EmbeddingRepairJobPayload,
  JOB_TYPES,
  type JobEnvelope,
  type SyncInstallationJobPayload,
} from "@repo/contracts";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HeimdallDatabase } from "../src/client";
import { BackgroundJobRepository } from "../src/index";

const integrationDatabaseUrl = process.env.HEIMDALL_DB_TEST_URL;
const testDirectory = fileURLToPath(new URL(".", import.meta.url));
const bootstrapPath = resolve(testDirectory, "../bootstrap/0000_extensions.sql");
const migrationsDirectory = resolve(testDirectory, "../migrations");

describe.runIf(integrationDatabaseUrl)("BackgroundJobRepository integration", () => {
  const schemaName = `heimdall_background_job_repository_test_${process.pid}_${Date.now()}`.replace(
    /[^A-Za-z0-9_]/g,
    "_",
  );
  const sql = postgres(integrationDatabaseUrl ?? "", { max: 1, onnotice: () => undefined });
  const db = drizzle(sql) as HeimdallDatabase;
  const backgroundJobRepository = new BackgroundJobRepository(db);

  beforeAll(async () => {
    await sql.unsafe(await readFile(bootstrapPath, "utf8"));
    await sql.unsafe(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await sql.unsafe(`SET search_path TO ${quoteIdentifier(schemaName)}, public`);
    await applyMigrations(sql, schemaName);
  });

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
    await sql.end();
  });

  it("inserts jobs idempotently and applies lifecycle transitions", async () => {
    const now = new Date("2026-05-08T00:10:00.000Z");
    const pendingEnvelope = syncInstallationEnvelope("sync:background:pending");
    const inserted = await backgroundJobRepository.insertBackgroundJob({
      backgroundJobId: "job_background_pending",
      queueName: "repo-sync",
      envelope: pendingEnvelope,
      metadata: { source: "background_job_repository_test" },
      createdAt: "2026-05-08T00:00:00.000Z",
      updatedAt: "2026-05-08T00:00:00.000Z",
    });
    expect(inserted).toMatchObject({
      inserted: true,
      job: {
        backgroundJobId: "job_background_pending",
        jobKey: "sync:background:pending",
        metadata: { source: "background_job_repository_test" },
        status: "pending",
      },
    });

    const duplicate = await backgroundJobRepository.insertBackgroundJob({
      backgroundJobId: "job_background_pending_duplicate",
      queueName: "repo-sync",
      envelope: pendingEnvelope,
    });
    expect(duplicate).toMatchObject({
      inserted: false,
      job: { backgroundJobId: "job_background_pending", status: "pending" },
    });

    await backgroundJobRepository.insertBackgroundJob({
      backgroundJobId: "job_background_future",
      queueName: "repo-sync",
      envelope: syncInstallationEnvelope("sync:background:future"),
      scheduledAt: "2026-05-08T01:00:00.000Z",
    });

    const claimed = await backgroundJobRepository.claimPendingJobs({ limit: 10, now });
    expect(claimed.map((job) => job.backgroundJobId)).toEqual(["job_background_pending"]);

    await backgroundJobRepository.markQueued({
      jobKey: pendingEnvelope.idempotencyKey,
      queueName: "repo-sync",
    });
    expect(
      await backgroundJobRepository.getBackgroundJobByQueueAndKey({
        jobKey: pendingEnvelope.idempotencyKey,
        queueName: "repo-sync",
      }),
    ).toMatchObject({ status: "queued" });

    await expect(
      backgroundJobRepository.markRunning({
        jobKey: pendingEnvelope.idempotencyKey,
        jobType: pendingEnvelope.jobType,
      }),
    ).resolves.toBe("running");
    expect(
      await backgroundJobRepository.getBackgroundJobByQueueAndKey({
        jobKey: pendingEnvelope.idempotencyKey,
        queueName: "repo-sync",
      }),
    ).toMatchObject({ attempts: 1, status: "running" });

    await backgroundJobRepository.markRetrying(
      { jobKey: pendingEnvelope.idempotencyKey, jobType: pendingEnvelope.jobType },
      { message: "Retry the durable job.", name: "RetryableJobError" },
    );
    expect(
      await backgroundJobRepository.getBackgroundJobByQueueAndKey({
        jobKey: pendingEnvelope.idempotencyKey,
        queueName: "repo-sync",
      }),
    ).toMatchObject({
      error: { message: "Retry the durable job.", name: "RetryableJobError" },
      status: "queued",
    });

    await backgroundJobRepository.markCompleted({
      jobKey: pendingEnvelope.idempotencyKey,
      jobType: pendingEnvelope.jobType,
    });
    expect(
      await backgroundJobRepository.getBackgroundJobByQueueAndKey({
        jobKey: pendingEnvelope.idempotencyKey,
        queueName: "repo-sync",
      }),
    ).toMatchObject({ status: "completed" });
    await expect(
      backgroundJobRepository.markRunning({
        jobKey: pendingEnvelope.idempotencyKey,
        jobType: pendingEnvelope.jobType,
      }),
    ).resolves.toBe("already_completed");
    await expect(
      backgroundJobRepository.markRunning({
        jobKey: "sync:background:missing",
        jobType: JOB_TYPES.SyncInstallation,
      }),
    ).resolves.toBe("missing");
  });

  it("recovers stale running jobs without touching fresh running jobs", async () => {
    const now = new Date("2026-05-08T02:00:00.000Z");
    const staleTimestamp = new Date("2026-05-08T01:00:00.000Z");
    const freshTimestamp = new Date("2026-05-08T01:45:00.000Z");

    await backgroundJobRepository.insertBackgroundJob({
      backgroundJobId: "job_background_retryable_stale",
      queueName: "repo-sync",
      envelope: syncInstallationEnvelope("sync:background:retryable_stale"),
      status: "running",
      attempts: 1,
      maxAttempts: 3,
      startedAt: staleTimestamp,
      updatedAt: staleTimestamp,
    });
    await backgroundJobRepository.insertBackgroundJob({
      backgroundJobId: "job_background_exhausted_stale",
      queueName: "repo-sync",
      envelope: syncInstallationEnvelope("sync:background:exhausted_stale"),
      status: "running",
      attempts: 3,
      maxAttempts: 3,
      startedAt: staleTimestamp,
      updatedAt: staleTimestamp,
    });
    await backgroundJobRepository.insertBackgroundJob({
      backgroundJobId: "job_background_fresh",
      queueName: "repo-sync",
      envelope: syncInstallationEnvelope("sync:background:fresh"),
      status: "running",
      attempts: 1,
      maxAttempts: 3,
      startedAt: freshTimestamp,
      updatedAt: freshTimestamp,
    });

    const result = await backgroundJobRepository.recoverStaleRunningJobs({
      now,
      staleAfterMs: 30 * 60 * 1_000,
    });
    expect(result).toMatchObject({ deadLettered: 1, inspected: 2, requeued: 1 });
    expect(result.jobIds).toEqual(
      expect.arrayContaining(["job_background_retryable_stale", "job_background_exhausted_stale"]),
    );

    await expect(
      backgroundJobRepository.getBackgroundJobByQueueAndKey({
        jobKey: "sync:background:retryable_stale",
        queueName: "repo-sync",
      }),
    ).resolves.toMatchObject({
      error: { name: "StaleDurableJobError" },
      status: "queued",
      updatedAt: now,
    });
    await expect(
      backgroundJobRepository.getBackgroundJobByQueueAndKey({
        jobKey: "sync:background:exhausted_stale",
        queueName: "repo-sync",
      }),
    ).resolves.toMatchObject({
      completedAt: now,
      error: { name: "StaleDurableJobError" },
      status: "dead_lettered",
    });
    await expect(
      backgroundJobRepository.getBackgroundJobByQueueAndKey({
        jobKey: "sync:background:fresh",
        queueName: "repo-sync",
      }),
    ).resolves.toMatchObject({ status: "running" });
  });

  it("deletes embedding background jobs for one embedding job key family", async () => {
    const embeddingJobId = "embjob_background_cleanup";
    const unrelatedEmbeddingJobId = "embjob_background_cleanup_other";
    const matchingBatchJobKey = `embedding:${embeddingJobId}:0`;
    const matchingRepairJobKeys = [
      `embedding:repair:${embeddingJobId}`,
      `embedding:repair:${embeddingJobId}:batch:0`,
    ];
    const matchingJobKeys = [matchingBatchJobKey, ...matchingRepairJobKeys];
    const unrelatedJobKey = `embedding:${unrelatedEmbeddingJobId}:0`;

    await backgroundJobRepository.insertBackgroundJob({
      backgroundJobId: `job_${matchingBatchJobKey.replace(/[^A-Za-z0-9_-]/g, "_")}`,
      envelope: embeddingBatchEnvelope(matchingBatchJobKey, embeddingJobId),
      queueName: "embedding",
    });
    for (const jobKey of matchingRepairJobKeys) {
      await backgroundJobRepository.insertBackgroundJob({
        backgroundJobId: `job_${jobKey.replace(/[^A-Za-z0-9_-]/g, "_")}`,
        envelope: embeddingRepairEnvelope(jobKey, embeddingJobId),
        queueName: "embedding",
      });
    }
    await backgroundJobRepository.insertBackgroundJob({
      backgroundJobId: "job_embedding_unrelated",
      envelope: embeddingBatchEnvelope(unrelatedJobKey, unrelatedEmbeddingJobId),
      queueName: "embedding",
    });

    await backgroundJobRepository.deleteEmbeddingBackgroundJobsForEmbeddingJob(embeddingJobId);

    for (const jobKey of matchingJobKeys) {
      await expect(
        backgroundJobRepository.getBackgroundJobByQueueAndKey({
          jobKey,
          queueName: "embedding",
        }),
      ).resolves.toBeUndefined();
    }
    await expect(
      backgroundJobRepository.getBackgroundJobByQueueAndKey({
        jobKey: unrelatedJobKey,
        queueName: "embedding",
      }),
    ).resolves.toMatchObject({ backgroundJobId: "job_embedding_unrelated" });
  });
});

/** Builds a sync-installation durable job envelope for repository tests. */
function syncInstallationEnvelope(idempotencyKey: string): JobEnvelope<SyncInstallationJobPayload> {
  const stableSuffix = idempotencyKey.replace(/[^A-Za-z0-9_-]/g, "_");

  return {
    attempt: 0,
    createdAt: "2026-05-08T00:00:00.000Z",
    idempotencyKey,
    jobId: `job_${stableSuffix}`,
    jobType: JOB_TYPES.SyncInstallation,
    maxAttempts: 3,
    payload: {
      installationId: "inst_background_job_repository_test",
      provider: "github",
      reason: "manual",
    },
    schemaVersion: "job_envelope.v1",
  };
}

/** Builds an embedding batch durable job envelope for repository tests. */
function embeddingBatchEnvelope(
  idempotencyKey: string,
  embeddingJobId: string,
): JobEnvelope<EmbeddingBatchJobPayload> {
  const stableSuffix = idempotencyKey.replace(/[^A-Za-z0-9_-]/g, "_");

  return {
    attempt: 0,
    createdAt: "2026-05-08T00:00:00.000Z",
    idempotencyKey,
    jobId: `job_${stableSuffix}`,
    jobType: JOB_TYPES.EmbeddingBatch,
    maxAttempts: 3,
    payload: {
      chunkIds: ["chunk_background_job_repository_test"],
      embeddingJobId,
      embeddingModel: "text-embedding-3-small",
      embeddingProfileVersion: "code_embedding_profile.v1",
      indexVersionId: "idx_background_job_repository_test",
      repoId: "repo_background_job_repository_test",
    },
    schemaVersion: "job_envelope.v1",
  };
}

/** Builds an embedding repair durable job envelope for repository tests. */
function embeddingRepairEnvelope(
  idempotencyKey: string,
  embeddingJobId: string,
): JobEnvelope<EmbeddingRepairJobPayload> {
  const stableSuffix = idempotencyKey.replace(/[^A-Za-z0-9_-]/g, "_");

  return {
    attempt: 0,
    createdAt: "2026-05-08T00:00:00.000Z",
    idempotencyKey,
    jobId: `job_${stableSuffix}`,
    jobType: JOB_TYPES.EmbeddingRepair,
    maxAttempts: 3,
    payload: {
      dimensions: 1536,
      embeddingJobId,
      embeddingProfileVersion: "code_embedding_profile.v1",
      indexVersionId: "idx_background_job_repository_test",
      model: "text-embedding-3-small",
      provider: "openai",
      repoId: "repo_background_job_repository_test",
    },
    schemaVersion: "job_envelope.v1",
  };
}

/** Applies all generated SQL migrations in lexical order to a test schema. */
async function applyMigrations(sql: postgres.Sql, schemaName: string): Promise<void> {
  const files = (await readdir(migrationsDirectory))
    .filter((file) => file.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right));

  for (const file of files) {
    await sql.unsafe(
      (await readFile(resolve(migrationsDirectory, file), "utf8")).replaceAll(
        '"public".',
        `${quoteIdentifier(schemaName)}.`,
      ),
    );
  }
}

/** Quotes a trusted Postgres identifier after validating its shape. */
function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(identifier)) {
    throw new Error(`Unsafe Postgres identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}
