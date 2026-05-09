import { and, asc, eq, inArray, lt, not } from "drizzle-orm";
import type { HeimdallDatabase } from "../client";
import {
  codeChunkEmbeddings,
  codeChunks,
  codeDependencies,
  codeEdges,
  codeIndexDiagnostics,
  codeRoutes,
  codeTestMappings,
  embeddingJobItems,
  embeddingJobs,
  indexedFiles,
  indexImportBatches,
  symbols,
} from "../schema";
import { BackgroundJobRepository } from "./background-job-repository";

/** Database surface required by index import repository methods. */
type IndexImportRepositoryDatabase = Pick<
  HeimdallDatabase,
  "delete" | "insert" | "select" | "update"
> &
  Partial<Pick<HeimdallDatabase, "transaction">>;

/** Normalized code chunk row written during index import. */
export type CodeChunkImportRow = typeof codeChunks.$inferInsert;

/** Normalized dependency row written during index import. */
export type CodeDependencyImportRow = typeof codeDependencies.$inferInsert;

/** Normalized diagnostic row written during index import. */
export type CodeDiagnosticImportRow = typeof codeIndexDiagnostics.$inferInsert;

/** Normalized code edge row written during index import. */
export type CodeEdgeImportRow = typeof codeEdges.$inferInsert;

/** Normalized indexed file row written during index import. */
export type IndexedFileImportRow = typeof indexedFiles.$inferInsert;

/** Normalized route row written during index import. */
export type CodeRouteImportRow = typeof codeRoutes.$inferInsert;

/** Normalized symbol row written during index import. */
export type SymbolImportRow = typeof symbols.$inferInsert;

/** Normalized related-test mapping row written during index import. */
export type CodeTestMappingImportRow = typeof codeTestMappings.$inferInsert;

/** Embedding job item row planned during index import. */
export type EmbeddingJobItemImportRow = typeof embeddingJobItems.$inferInsert;

/** Input used to upsert a visible running import batch. */
export type UpsertRunningIndexImportBatchInput = {
  /** Durable import batch ID. */
  readonly indexImportBatchId: string;
  /** Repository that owns the import. */
  readonly repoId: string;
  /** Commit SHA carried by the index artifact. */
  readonly commitSha: string;
  /** Stable indexer/chunker key. */
  readonly indexKey: string;
  /** Index version attached to phases after version creation. */
  readonly indexVersionId: string | null;
  /** Artifact URI being imported. */
  readonly artifactUri: string;
  /** Artifact content hash used for idempotency. */
  readonly artifactHash: string;
  /** Current import phase. */
  readonly phase: string;
  /** Total artifact record count. */
  readonly recordCount: number;
  /** Number of file records in the import plan. */
  readonly fileCount: number;
  /** Number of symbol records in the import plan. */
  readonly symbolCount: number;
  /** Number of edge records in the import plan. */
  readonly edgeCount: number;
  /** Number of chunk records in the import plan. */
  readonly chunkCount: number;
  /** Number of diagnostic records in the import plan. */
  readonly diagnosticCount: number;
  /** Number of dependency records in the import plan. */
  readonly dependencyCount: number;
  /** Number of route records in the import plan. */
  readonly routeCount: number;
  /** Number of related-test mapping records in the import plan. */
  readonly testMappingCount: number;
  /** Product-safe metadata describing the importer and safety limits. */
  readonly metadata: unknown;
  /** Optional timestamp for deterministic tests. */
  readonly now?: Date | undefined;
};

/** Input used to move a running import batch into record-writing phase. */
export type MarkIndexImportBatchWritingRecordsInput = {
  /** Durable import batch ID. */
  readonly indexImportBatchId: string;
  /** Index version now attached to the import batch. */
  readonly indexVersionId: string;
};

/** Input used to mark a visible import batch complete. */
export type MarkIndexImportBatchCompleteInput = {
  /** Durable import batch ID. */
  readonly indexImportBatchId: string;
  /** Number of durable embedding jobs planned by the import. */
  readonly embeddingJobCount: number;
  /** Optional completion timestamp for deterministic tests. */
  readonly now?: Date | undefined;
};

/** Input used to mark a visible import batch failed. */
export type MarkIndexImportBatchFailedInput = {
  /** Durable import batch ID. */
  readonly indexImportBatchId: string;
  /** Product-safe serialized failure payload. */
  readonly error: unknown;
  /** Optional failure timestamp for deterministic tests. */
  readonly now?: Date | undefined;
};

/** Input used to list stale running import batches. */
export type ListStaleIndexImportBatchesInput = {
  /** Updated-at cutoff before which an import is stale. */
  readonly cutoff: Date;
  /** Maximum number of stale batches to return. */
  readonly limit: number;
};

/** Stale import batch selected for reconciliation. */
export type StaleIndexImportBatchRecord = {
  /** Durable import batch ID. */
  readonly importBatchId: string;
  /** Index version attached to the batch when available. */
  readonly indexVersionId: string | null;
};

/** Input used to delete child rows for a failed index version. */
export type DeleteIndexVersionChildRowsInput = {
  /** Embedding job IDs to clean without an extra lookup when already known. */
  readonly embeddingJobIds?: readonly string[] | undefined;
  /** Failed index version whose partial child rows should be deleted. */
  readonly indexVersionId: string;
};

/** Result returned after deleting failed index version child rows. */
export type DeleteIndexVersionChildRowsResult = {
  /** Embedding job IDs whose child rows and background jobs were cleaned. */
  readonly embeddingJobIds: readonly string[];
};

/** Input used to create a durable embedding planner job for imported chunks. */
export type CreateIndexEmbeddingJobInput = {
  /** Durable embedding job ID. */
  readonly embeddingJobId: string;
  /** Organization that owns the job. */
  readonly orgId: string;
  /** Repository that owns the job. */
  readonly repoId: string;
  /** Index version whose chunks need embeddings. */
  readonly indexVersionId: string;
  /** Commit SHA indexed by the job. */
  readonly commitSha: string;
  /** Embedding profile version. */
  readonly embeddingProfileVersion: string;
  /** Embedding provider expected to service the job. */
  readonly provider: string;
  /** Embedding model expected to service the job. */
  readonly model: string;
  /** Embedding vector dimensions. */
  readonly dimensions: number;
  /** Number of chunks planned for embedding. */
  readonly chunkCountPlanned: number;
  /** Product-safe planner metadata. */
  readonly metadata: unknown;
};

/** Query helper for durable index import progress, record writes, and cleanup. */
export class IndexImportRepository {
  /** Creates an index import query helper. */
  public constructor(private readonly db: IndexImportRepositoryDatabase) {}

  /** Creates or refreshes a running import batch row. */
  public async upsertRunningImportBatch(input: UpsertRunningIndexImportBatchInput): Promise<void> {
    const now = input.now ?? new Date();
    await this.db
      .insert(indexImportBatches)
      .values({
        artifactHash: input.artifactHash,
        artifactUri: input.artifactUri,
        chunkCount: input.chunkCount,
        commitSha: input.commitSha,
        dependencyCount: input.dependencyCount,
        diagnosticCount: input.diagnosticCount,
        edgeCount: input.edgeCount,
        embeddingJobCount: 0,
        error: null,
        fileCount: input.fileCount,
        indexImportBatchId: input.indexImportBatchId,
        indexKey: input.indexKey,
        indexVersionId: input.indexVersionId,
        metadata: input.metadata,
        phase: input.phase,
        recordCount: input.recordCount,
        repoId: input.repoId,
        routeCount: input.routeCount,
        startedAt: now,
        status: "running",
        symbolCount: input.symbolCount,
        testMappingCount: input.testMappingCount,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: indexImportBatches.indexImportBatchId,
        set: {
          artifactHash: input.artifactHash,
          artifactUri: input.artifactUri,
          chunkCount: input.chunkCount,
          commitSha: input.commitSha,
          dependencyCount: input.dependencyCount,
          diagnosticCount: input.diagnosticCount,
          edgeCount: input.edgeCount,
          error: null,
          fileCount: input.fileCount,
          finishedAt: null,
          indexKey: input.indexKey,
          indexVersionId: input.indexVersionId,
          metadata: input.metadata,
          phase: input.phase,
          recordCount: input.recordCount,
          repoId: input.repoId,
          routeCount: input.routeCount,
          startedAt: now,
          status: "running",
          symbolCount: input.symbolCount,
          testMappingCount: input.testMappingCount,
          updatedAt: now,
        },
      });
  }

  /** Marks an import batch as writing normalized index records. */
  public async markWritingRecords(input: MarkIndexImportBatchWritingRecordsInput): Promise<void> {
    await this.db
      .update(indexImportBatches)
      .set({
        indexVersionId: input.indexVersionId,
        phase: "writing_records",
        updatedAt: new Date(),
      })
      .where(eq(indexImportBatches.indexImportBatchId, input.indexImportBatchId));
  }

  /** Marks an import batch complete after all record writes finish. */
  public async markComplete(input: MarkIndexImportBatchCompleteInput): Promise<void> {
    const now = input.now ?? new Date();
    await this.db
      .update(indexImportBatches)
      .set({
        embeddingJobCount: input.embeddingJobCount,
        finishedAt: now,
        phase: "complete",
        status: "complete",
        updatedAt: now,
      })
      .where(eq(indexImportBatches.indexImportBatchId, input.indexImportBatchId));
  }

  /** Marks an import batch failed with a product-safe error payload. */
  public async markFailed(input: MarkIndexImportBatchFailedInput): Promise<void> {
    const now = input.now ?? new Date();
    await this.db
      .update(indexImportBatches)
      .set({
        error: input.error,
        finishedAt: now,
        phase: "failed",
        status: "failed",
        updatedAt: now,
      })
      .where(eq(indexImportBatches.indexImportBatchId, input.indexImportBatchId));
  }

  /** Lists running import batches whose updated timestamp is stale. */
  public async listStaleRunningBatches(
    input: ListStaleIndexImportBatchesInput,
  ): Promise<readonly StaleIndexImportBatchRecord[]> {
    return this.db
      .select({
        importBatchId: indexImportBatches.indexImportBatchId,
        indexVersionId: indexImportBatches.indexVersionId,
      })
      .from(indexImportBatches)
      .where(
        and(
          not(inArray(indexImportBatches.status, ["complete", "failed"])),
          lt(indexImportBatches.updatedAt, input.cutoff),
        ),
      )
      .orderBy(asc(indexImportBatches.updatedAt))
      .limit(input.limit);
  }

  /** Writes normalized file rows in bounded insert batches. */
  public async writeFiles(rows: readonly IndexedFileImportRow[], batchSize: number): Promise<void> {
    await this.writeRows(indexedFiles, rows, batchSize);
  }

  /** Writes normalized symbol rows in bounded insert batches. */
  public async writeSymbols(rows: readonly SymbolImportRow[], batchSize: number): Promise<void> {
    await this.writeRows(symbols, rows, batchSize);
  }

  /** Writes normalized edge rows in bounded insert batches. */
  public async writeEdges(rows: readonly CodeEdgeImportRow[], batchSize: number): Promise<void> {
    await this.writeRows(codeEdges, rows, batchSize);
  }

  /** Writes normalized chunk rows in bounded insert batches. */
  public async writeChunks(rows: readonly CodeChunkImportRow[], batchSize: number): Promise<void> {
    await this.writeRows(codeChunks, rows, batchSize);
  }

  /** Writes normalized dependency rows in bounded insert batches. */
  public async writeDependencies(
    rows: readonly CodeDependencyImportRow[],
    batchSize: number,
  ): Promise<void> {
    await this.writeRows(codeDependencies, rows, batchSize);
  }

  /** Writes normalized route rows in bounded insert batches. */
  public async writeRoutes(rows: readonly CodeRouteImportRow[], batchSize: number): Promise<void> {
    await this.writeRows(codeRoutes, rows, batchSize);
  }

  /** Writes normalized related-test mapping rows in bounded insert batches. */
  public async writeTestMappings(
    rows: readonly CodeTestMappingImportRow[],
    batchSize: number,
  ): Promise<void> {
    await this.writeRows(codeTestMappings, rows, batchSize);
  }

  /** Writes normalized diagnostic rows in bounded insert batches. */
  public async writeDiagnostics(
    rows: readonly CodeDiagnosticImportRow[],
    batchSize: number,
  ): Promise<void> {
    await this.writeRows(codeIndexDiagnostics, rows, batchSize);
  }

  /** Creates a durable embedding planner job for imported chunks. */
  public async createEmbeddingJob(input: CreateIndexEmbeddingJobInput): Promise<void> {
    await this.db
      .insert(embeddingJobs)
      .values({
        chunkCountPlanned: input.chunkCountPlanned,
        commitSha: input.commitSha,
        dimensions: input.dimensions,
        embeddingJobId: input.embeddingJobId,
        embeddingProfileVersion: input.embeddingProfileVersion,
        indexVersionId: input.indexVersionId,
        metadata: input.metadata,
        model: input.model,
        orgId: input.orgId,
        provider: input.provider,
        reason: "index_import",
        repoId: input.repoId,
        status: "pending",
      })
      .onConflictDoNothing();
  }

  /** Writes durable embedding planner item rows in bounded insert batches. */
  public async writeEmbeddingJobItems(
    rows: readonly EmbeddingJobItemImportRow[],
    batchSize: number,
  ): Promise<void> {
    await this.writeRows(embeddingJobItems, rows, batchSize);
  }

  /** Lists durable embedding job IDs attached to one index version. */
  public async listEmbeddingJobIdsForIndexVersion(
    indexVersionId: string,
  ): Promise<readonly string[]> {
    const rows = await this.db
      .select({ embeddingJobId: embeddingJobs.embeddingJobId })
      .from(embeddingJobs)
      .where(eq(embeddingJobs.indexVersionId, indexVersionId));

    return rows.map((row) => row.embeddingJobId);
  }

  /** Deletes partial child rows for a failed index version while preserving parent rows. */
  public async deleteIndexVersionChildRows(
    input: DeleteIndexVersionChildRowsInput,
  ): Promise<DeleteIndexVersionChildRowsResult> {
    const embeddingJobIds =
      input.embeddingJobIds ??
      (await this.listEmbeddingJobIdsForIndexVersion(input.indexVersionId));
    if (!this.db.transaction) {
      throw new Error("Index import cleanup requires a transaction-capable database.");
    }

    await this.db.transaction(async (tx) => {
      const backgroundJobRepository = new BackgroundJobRepository(tx);

      for (const embeddingJobId of embeddingJobIds) {
        await backgroundJobRepository.deleteEmbeddingBackgroundJobsForEmbeddingJob(embeddingJobId);
      }
      if (embeddingJobIds.length > 0) {
        await tx
          .delete(embeddingJobItems)
          .where(inArray(embeddingJobItems.embeddingJobId, [...embeddingJobIds]));
      }
      await tx
        .delete(codeChunkEmbeddings)
        .where(eq(codeChunkEmbeddings.indexVersionId, input.indexVersionId));
      await tx.delete(embeddingJobs).where(eq(embeddingJobs.indexVersionId, input.indexVersionId));
      await tx
        .delete(codeIndexDiagnostics)
        .where(eq(codeIndexDiagnostics.indexVersionId, input.indexVersionId));
      await tx
        .delete(codeTestMappings)
        .where(eq(codeTestMappings.indexVersionId, input.indexVersionId));
      await tx.delete(codeRoutes).where(eq(codeRoutes.indexVersionId, input.indexVersionId));
      await tx
        .delete(codeDependencies)
        .where(eq(codeDependencies.indexVersionId, input.indexVersionId));
      await tx.delete(codeEdges).where(eq(codeEdges.indexVersionId, input.indexVersionId));
      await tx.delete(codeChunks).where(eq(codeChunks.indexVersionId, input.indexVersionId));
      await tx.delete(symbols).where(eq(symbols.indexVersionId, input.indexVersionId));
      await tx.delete(indexedFiles).where(eq(indexedFiles.indexVersionId, input.indexVersionId));
    });

    return { embeddingJobIds };
  }

  /** Writes table rows in deterministic bounded batches. */
  private async writeRows<Row>(
    table: unknown,
    rows: readonly Row[],
    batchSize: number,
  ): Promise<void> {
    if (rows.length === 0) {
      return;
    }

    for (const batch of batchRecords(rows, batchSize)) {
      await this.db
        .insert(table as never)
        .values(batch as never)
        .onConflictDoNothing();
    }
  }
}

/** Yields stable slices of row values for bounded batch inserts. */
function* batchRecords<T>(records: readonly T[], batchSize: number): Generator<T[]> {
  for (let offset = 0; offset < records.length; offset += batchSize) {
    yield records.slice(offset, offset + batchSize);
  }
}
