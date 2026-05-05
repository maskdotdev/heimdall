import { createHash } from "node:crypto";
import { type EmbeddingBatchJobPayload, JOB_TYPES } from "@repo/contracts";
import {
  backgroundJobs,
  codeChunks,
  codeEdges,
  codeIndexVersions,
  type HeimdallDatabase,
  indexedFiles,
  symbols,
} from "@repo/db";
import type { ChunkRecord } from "@repo/index-schema";
import type { IndexArtifact } from "@repo/indexer-driver";
import { validateIndexArtifact } from "@repo/indexer-driver";
import { QUEUE_NAMES } from "@repo/queue";

export const packageName = "@repo/index-importer" as const;

/** Options for importing a validated artifact. */
export type ImportIndexArtifactOptions = {
  /** Database used for idempotent persistence. */
  readonly db: HeimdallDatabase;
  /** Artifact URI, local path, or object-storage key. */
  readonly artifactUri: string;
  /** Whether to create durable embedding batch jobs after import. */
  readonly enqueueEmbeddings?: boolean;
  /** Embedding model to request for queued chunk batches. */
  readonly embeddingModel?: string;
  /** Maximum chunk IDs per embedding job. */
  readonly embeddingBatchSize?: number;
};

/** Summary returned after importing an index artifact. */
export type ImportIndexArtifactResult = {
  /** Imported index version ID. */
  readonly indexVersionId: string;
  /** Number of persisted file records. */
  readonly fileCount: number;
  /** Number of persisted symbol records. */
  readonly symbolCount: number;
  /** Number of persisted edge records. */
  readonly edgeCount: number;
  /** Number of persisted chunk records. */
  readonly chunkCount: number;
  /** Number of queued embedding jobs. */
  readonly embeddingJobCount: number;
};

/** Imports a validated index artifact into normalized DB tables idempotently. */
export async function importIndexArtifact(
  artifact: IndexArtifact,
  options: ImportIndexArtifactOptions,
): Promise<ImportIndexArtifactResult> {
  const validationErrors = validateIndexArtifact(artifact);
  if (validationErrors.length > 0) {
    throw new Error(`Invalid index artifact: ${validationErrors.join("; ")}`);
  }

  const indexVersionId = stableId("idx", [
    artifact.manifest.repoId,
    artifact.manifest.commitSha,
    artifact.manifest.indexerName,
    artifact.manifest.indexerVersion,
    artifact.manifest.chunkerVersion,
  ]);
  const artifactHash = artifact.manifest.artifactHash ?? hashArtifact(artifact);
  const files = artifact.records.filter((record) => record.type === "file");
  const symbolRecords = artifact.records.filter((record) => record.type === "symbol");
  const edgeRecords = artifact.records.filter((record) => record.type === "edge");
  const chunks = artifact.records.filter(
    (record): record is ChunkRecord => record.type === "chunk",
  );

  await options.db.transaction(async (tx) => {
    await tx
      .insert(codeIndexVersions)
      .values({
        indexVersionId,
        repoId: artifact.manifest.repoId,
        commitSha: artifact.manifest.commitSha,
        indexKey: [
          artifact.manifest.indexerName,
          artifact.manifest.indexerVersion,
          artifact.manifest.chunkerVersion,
        ].join(":"),
        status: "ready",
        artifactUri: options.artifactUri,
        artifactHash,
        indexerName: artifact.manifest.indexerName,
        indexerVersion: artifact.manifest.indexerVersion,
        chunkerVersion: artifact.manifest.chunkerVersion,
        fileCount: files.length,
        symbolCount: symbolRecords.length,
        edgeCount: edgeRecords.length,
        chunkCount: chunks.length,
        embeddedChunkCount: 0,
        completedAt: new Date(artifact.manifest.generatedAt),
      })
      .onConflictDoUpdate({
        target: [codeIndexVersions.repoId, codeIndexVersions.commitSha, codeIndexVersions.indexKey],
        set: {
          status: "ready",
          artifactUri: options.artifactUri,
          artifactHash,
          fileCount: files.length,
          symbolCount: symbolRecords.length,
          edgeCount: edgeRecords.length,
          chunkCount: chunks.length,
          completedAt: new Date(artifact.manifest.generatedAt),
          error: null,
        },
      });

    if (files.length > 0) {
      await tx
        .insert(indexedFiles)
        .values(
          files.map((file) => ({
            fileId: file.fileId,
            indexVersionId,
            repoId: file.repoId,
            commitSha: file.commitSha,
            path: file.path,
            language: file.language,
            contentHash: file.contentHash,
            sizeBytes: file.sizeBytes,
            lineCount: file.lineCount,
            isBinary: file.isBinary,
            isGenerated: file.isGenerated,
            isTest: file.isTest,
            isVendored: file.isVendored,
            metadata: file.metadata,
          })),
        )
        .onConflictDoNothing();
    }

    if (symbolRecords.length > 0) {
      await tx
        .insert(symbols)
        .values(
          symbolRecords.map((symbol) => ({
            symbolId: symbol.symbolId,
            indexVersionId,
            fileId: symbol.fileId,
            repoId: symbol.repoId,
            commitSha: symbol.commitSha,
            path: symbol.path,
            language: symbol.language,
            name: symbol.name,
            qualifiedName: symbol.qualifiedName,
            kind: symbol.kind,
            startLine: symbol.range.startLine,
            endLine: symbol.range.endLine,
            contentHash: symbol.contentHash,
            metadata: { ...symbol.metadata, signature: symbol.signature },
          })),
        )
        .onConflictDoNothing();
    }

    if (edgeRecords.length > 0) {
      await tx
        .insert(codeEdges)
        .values(
          edgeRecords.map((edge) => ({
            edgeId: edge.edgeId,
            indexVersionId,
            repoId: edge.repoId,
            commitSha: edge.commitSha,
            fromId: edge.fromId,
            toId: edge.toId,
            fromKind: edge.fromKind,
            toKind: edge.toKind,
            kind: edge.kind,
            confidence: edge.confidence,
            metadata: edge.metadata,
          })),
        )
        .onConflictDoNothing();
    }

    if (chunks.length > 0) {
      await tx
        .insert(codeChunks)
        .values(
          chunks.map((chunk) => ({
            chunkId: chunk.chunkId,
            indexVersionId,
            fileId: chunk.fileId,
            symbolId: chunk.symbolId,
            repoId: chunk.repoId,
            path: chunk.path,
            startLine: chunk.range.startLine,
            endLine: chunk.range.endLine,
            contentHash: chunk.contentHash,
            embeddingStatus: "pending",
            metadata: {
              ...chunk.metadata,
              language: chunk.language,
              kind: chunk.kind,
              text: chunk.text,
              tokenEstimate: chunk.tokenEstimate,
            },
          })),
        )
        .onConflictDoNothing();
    }
  });

  const embeddingJobCount = options.enqueueEmbeddings
    ? await enqueueEmbeddingBatches(indexVersionId, artifact.manifest.repoId, chunks, options)
    : 0;

  return {
    indexVersionId,
    fileCount: files.length,
    symbolCount: symbolRecords.length,
    edgeCount: edgeRecords.length,
    chunkCount: chunks.length,
    embeddingJobCount,
  };
}

async function enqueueEmbeddingBatches(
  indexVersionId: string,
  repoId: string,
  chunks: readonly ChunkRecord[],
  options: ImportIndexArtifactOptions,
): Promise<number> {
  const batchSize = options.embeddingBatchSize ?? 128;
  const embeddingModel = options.embeddingModel ?? "text-embedding-3-small";
  let count = 0;

  for (let index = 0; index < chunks.length; index += batchSize) {
    const chunkIds = chunks.slice(index, index + batchSize).map((chunk) => chunk.chunkId);
    const payload: EmbeddingBatchJobPayload = { repoId, indexVersionId, chunkIds, embeddingModel };
    const now = new Date().toISOString();
    const jobKey = `embedding:${indexVersionId}:${embeddingModel}:${index / batchSize}`;
    await options.db
      .insert(backgroundJobs)
      .values({
        backgroundJobId: stableId("job", [jobKey]),
        queueName: QUEUE_NAMES.embedding,
        jobKey,
        jobType: JOB_TYPES.EmbeddingBatch,
        status: "pending",
        repoId,
        payload: {
          jobId: stableId("job", [jobKey, "envelope"]),
          jobType: JOB_TYPES.EmbeddingBatch,
          schemaVersion: "job_envelope.v1",
          idempotencyKey: jobKey,
          createdAt: now,
          attempt: 0,
          maxAttempts: 3,
          payload,
        },
        maxAttempts: 3,
      })
      .onConflictDoNothing();
    count += 1;
  }

  return count;
}

function hashArtifact(artifact: IndexArtifact): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(JSON.stringify(artifact)).digest("hex")}`;
}

function stableId(prefix: string, parts: readonly unknown[]): string {
  return `${prefix}_${createHash("sha256")
    .update(parts.map((part) => String(part)).join(":"))
    .digest("base64url")
    .slice(0, 26)}`;
}
