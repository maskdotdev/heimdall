import { JOB_TYPES } from "@repo/contracts";
import type { HeimdallDatabase } from "@repo/db";
import { auditLogs, backgroundJobs, embeddingJobItems, embeddingJobs } from "@repo/db";
import { QUEUE_NAMES } from "@repo/queue";
import { describe, expect, it } from "vitest";
import { getBackgroundJobDebugDetails } from "../src";

describe("getBackgroundJobDebugDetails", () => {
  it("includes embedding job progress and sampled item failures for embedding jobs", async () => {
    const now = new Date("2026-05-07T12:00:00.000Z");
    const rows = new Map<unknown, readonly unknown[]>([
      [
        backgroundJobs,
        [
          {
            attempts: 2,
            backgroundJobId: "job_embedding",
            completedAt: now,
            createdAt: now,
            error: {
              code: "background_job.failed",
              message: "Embedding batch failed.",
              retryable: true,
            },
            jobKey: "embedding:embjob_1:0",
            jobType: JOB_TYPES.EmbeddingBatch,
            maxAttempts: 3,
            metadata: null,
            orgId: "org_1",
            payload: {
              attempt: 1,
              createdAt: now.toISOString(),
              idempotencyKey: "embedding:embjob_1:0",
              jobId: "job_envelope",
              jobType: JOB_TYPES.EmbeddingBatch,
              maxAttempts: 3,
              payload: {
                chunkIds: ["chunk_1", "chunk_2"],
                embeddingJobId: "embjob_1",
                embeddingModel: "text-embedding-3-small",
                indexVersionId: "idx_1",
                repoId: "repo_1",
              },
              schemaVersion: "job_envelope.v1",
            },
            queueName: QUEUE_NAMES.embedding,
            repoId: "repo_1",
            reviewRunId: null,
            scheduledAt: now,
            startedAt: now,
            status: "failed",
            updatedAt: now,
          } satisfies typeof backgroundJobs.$inferSelect,
        ],
      ],
      [
        embeddingJobs,
        [
          {
            attempts: 2,
            chunkCountEmbedded: 1,
            chunkCountFailed: 1,
            chunkCountPlanned: 4,
            chunkCountSkipped: 0,
            commitSha: "abc123",
            createdAt: now,
            dimensions: 1536,
            embeddingJobId: "embjob_1",
            embeddingProfileVersion: "code_embedding_profile.v1",
            finishedAt: now,
            indexVersionId: "idx_1",
            lastErrorCode: "embedding_provider_timeout",
            lastErrorMessage: "Embedding provider timed out.",
            lockedAt: null,
            lockedBy: null,
            metadata: {
              artifactId: "artifact_1",
              artifactUri: "file:///private/artifact.json",
            },
            model: "text-embedding-3-small",
            orgId: "org_1",
            provider: "openai",
            reason: "index_import",
            repoId: "repo_1",
            startedAt: now,
            status: "failed",
          } satisfies typeof embeddingJobs.$inferSelect,
        ],
      ],
      [
        embeddingJobItems,
        [
          {
            attempts: 1,
            cacheKey: "sha256:cache",
            chunkId: "chunk_1",
            createdAt: now,
            embeddingJobId: "embjob_1",
            embeddingJobItemId: "embitem_1",
            finishedAt: now,
            lastErrorCode: null,
            lastErrorMessage: null,
            startedAt: now,
            status: "embedded",
          } satisfies typeof embeddingJobItems.$inferSelect,
          {
            attempts: 2,
            cacheKey: null,
            chunkId: "chunk_2",
            createdAt: now,
            embeddingJobId: "embjob_1",
            embeddingJobItemId: "embitem_2",
            finishedAt: now,
            lastErrorCode: "embedding_vector_invalid",
            lastErrorMessage: "Embedding provider returned a non-finite value.",
            startedAt: now,
            status: "failed",
          } satisfies typeof embeddingJobItems.$inferSelect,
        ],
      ],
      [auditLogs, []],
    ]);

    const details = await getBackgroundJobDebugDetails("job_embedding", {
      db: createAdminDebugDatabaseStub(rows),
    });

    expect(details.embeddingJob).toMatchObject({
      chunkCountEmbedded: 1,
      chunkCountFailed: 1,
      chunkCountPlanned: 4,
      embeddingJobId: "embjob_1",
      metadataKeys: ["artifactId", "artifactUri"],
      progressPercent: 50,
      status: "failed",
    });
    expect(details.embeddingJobItems).toEqual([
      expect.objectContaining({
        chunkId: "chunk_1",
        embeddingJobItemId: "embitem_1",
        status: "embedded",
      }),
      expect.objectContaining({
        chunkId: "chunk_2",
        embeddingJobItemId: "embitem_2",
        failure: expect.objectContaining({
          code: "embedding_vector_invalid",
          source: "embedding_job_item",
        }),
        status: "failed",
      }),
    ]);
    expect(details.failures.map((failure) => failure.source)).toEqual([
      "background_job",
      "embedding_job",
      "embedding_job_item",
    ]);
    expect(JSON.stringify(details)).not.toContain("file:///private/artifact.json");
  });
});

/** Creates a small Drizzle-like select surface for admin debug unit tests. */
function createAdminDebugDatabaseStub(
  rows: ReadonlyMap<unknown, readonly unknown[]>,
): HeimdallDatabase {
  return {
    select: () => new AdminDebugSelectStub(rows),
  } as unknown as HeimdallDatabase;
}

/** Minimal select builder used by admin debug database stubs. */
class AdminDebugSelectStub {
  /** Table selected by the current fake query. */
  private table: unknown = undefined;

  /** Creates a fake select builder backed by table-indexed rows. */
  public constructor(private readonly rows: ReadonlyMap<unknown, readonly unknown[]>) {}

  /** Records the selected table and returns this fake builder. */
  public from(table: unknown): this {
    this.table = table;
    return this;
  }

  /** Ignores predicates because each unit test provides a single relevant row set. */
  public where(): this {
    return this;
  }

  /** Ignores sort expressions and resolves the selected fake rows. */
  public orderBy(): Promise<readonly unknown[]> {
    return Promise.resolve(this.currentRows());
  }

  /** Resolves at most the requested number of fake rows. */
  public limit(count: number): Promise<readonly unknown[]> {
    return Promise.resolve(this.currentRows().slice(0, count));
  }

  /** Returns fake rows for the selected table. */
  private currentRows(): readonly unknown[] {
    return this.rows.get(this.table) ?? [];
  }
}
