import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { type ReviewArtifactFetch, S3CompatibleReviewArtifactPayloadStore } from "@repo/artifacts";
import {
  type EmbeddingBatchJobPayload,
  type EmbeddingRepairJobPayload,
  JOB_TYPES,
} from "@repo/contracts";
import {
  backgroundJobs,
  codeChunks,
  codeEdges,
  codeIndexVersions,
  embeddingJobItems,
  embeddingJobs,
  type HeimdallDatabase,
  indexedFiles,
  repositories,
  symbols,
} from "@repo/db";
import type { ChunkRecord } from "@repo/index-schema";
import type { IndexArtifact } from "@repo/indexer-driver";
import { validateIndexArtifact } from "@repo/indexer-driver";
import {
  classifyTelemetryError,
  OBSERVABILITY_METRIC_NAMES,
  OBSERVABILITY_SPAN_NAMES,
  type TelemetryMetricRecorder,
  type TelemetrySpanHandle,
  type TelemetrySpanRecorder,
  type TelemetryTraceContextInput,
} from "@repo/observability";
import { QUEUE_NAMES } from "@repo/queue";
import { eq } from "drizzle-orm";

export const packageName = "@repo/index-importer" as const;

/** Default embedding profile version used by the current code-chunk input builder. */
const DEFAULT_CODE_EMBEDDING_PROFILE_VERSION = "code_embedding_profile.v1";

/** Default embedding dimension used by the current pgvector storage schema. */
const DEFAULT_EMBEDDING_DIMENSIONS = 1536;

/** Delay before a scheduled embedding repair job checks for progress drift. */
const EMBEDDING_REPAIR_DELAY_MS = 15 * 60 * 1000;

/** Default number of normalized index records written per insert statement. */
const DEFAULT_IMPORT_RECORD_BATCH_SIZE = 1_000;

/** Maximum record batch size accepted from caller-provided import options. */
const MAX_IMPORT_RECORD_BATCH_SIZE = 5_000;

/** Resolver that loads an index artifact from a durable URI or local path. */
export type IndexArtifactResolver = {
  /** Reads and parses an index artifact from the provided URI. */
  readonly readArtifact: (artifactUri: string) => Promise<IndexArtifact>;
};

/** Options for the default filesystem-backed artifact resolver. */
export type FileSystemIndexArtifactResolverOptions = {
  /** Optional root directory that resolved local paths must stay inside. */
  readonly rootPath?: string;
};

/** Options for S3/R2-compatible whole-artifact JSON resolution. */
export type S3CompatibleIndexArtifactResolverOptions = {
  /** Bucket that owns index artifact objects. */
  readonly bucket: string;
  /** AWS-compatible region for request signing. */
  readonly region: string;
  /** Access key ID for SigV4 signing. */
  readonly accessKeyId: string;
  /** Secret access key for SigV4 signing. */
  readonly secretAccessKey: string;
  /** Optional session token for temporary credentials. */
  readonly sessionToken?: string;
  /** Optional S3-compatible endpoint, such as an R2 endpoint. */
  readonly endpoint?: string;
  /** Whether to address objects as endpoint/bucket/key instead of bucket.endpoint/key. */
  readonly forcePathStyle?: boolean;
  /** Optional fetch implementation for tests. */
  readonly fetch?: ReviewArtifactFetch;
  /** Optional clock for deterministic signing tests. */
  readonly now?: () => Date;
};

/** Environment values used to choose the runtime index artifact resolver. */
export type IndexArtifactResolverEnvironment = Readonly<Record<string, string | undefined>>;

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
  /** Embedding provider expected to service queued chunks. */
  readonly embeddingProvider?: string;
  /** Embedding profile version recorded on durable embedding planning rows. */
  readonly embeddingProfileVersion?: string;
  /** Embedding vector dimension recorded on durable embedding planning rows. */
  readonly embeddingDimensions?: number;
  /** Maximum chunk IDs per embedding job. */
  readonly embeddingBatchSize?: number;
  /** Maximum normalized records written per database insert statement. */
  readonly importRecordBatchSize?: number;
  /** Optional metric recorder for aggregate index-import telemetry. */
  readonly metrics?: TelemetryMetricRecorder;
  /** Optional trace context propagated from the durable indexing job. */
  readonly traceContext?: TelemetryTraceContextInput | undefined;
  /** Optional span recorder for product-safe index-import spans. */
  readonly traces?: TelemetrySpanRecorder;
};

/** Options for importing an artifact by resolving its URI first. */
export type ImportIndexArtifactFromUriOptions = ImportIndexArtifactOptions & {
  /** Optional resolver for non-filesystem artifact stores. */
  readonly artifactResolver?: IndexArtifactResolver;
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

type IndexImporterTelemetryStatus = "failed" | "succeeded";

type IndexImporterTelemetryState = {
  /** Low-cardinality labels shared by index-import metrics. */
  readonly labels: Readonly<{
    readonly indexer: string;
  }>;
  /** Monotonic start time used for duration metrics. */
  readonly startedAtMs: number;
  /** Product-safe import span. */
  readonly span: TelemetrySpanHandle | undefined;
};

/** Creates a resolver that reads filesystem-backed index artifact layouts. */
export function createFileSystemIndexArtifactResolver(
  options: FileSystemIndexArtifactResolverOptions = {},
): IndexArtifactResolver {
  const rootPath = options.rootPath ? resolve(options.rootPath) : undefined;

  return {
    readArtifact: async (artifactUri) => {
      const artifactPath = resolveLocalArtifactPath(artifactUri, rootPath);

      return readFilesystemIndexArtifact(artifactPath);
    },
  };
}

/** Creates an S3/R2-compatible resolver for whole-artifact JSON objects. */
export function createS3CompatibleIndexArtifactResolver(
  options: S3CompatibleIndexArtifactResolverOptions,
): IndexArtifactResolver {
  const store = new S3CompatibleReviewArtifactPayloadStore(options);

  return {
    readArtifact: async (artifactUri) => {
      const result = await store.getJson({
        metadata: {},
        uri: normalizeObjectArtifactUri(artifactUri),
      });
      if (!result.exists) {
        throw new Error(`Index artifact object was not found: ${artifactUri}`);
      }

      return result.payload as IndexArtifact;
    },
  };
}

/** Creates the configured index artifact resolver from environment variables. */
export function createIndexArtifactResolverFromEnvironment(
  env: IndexArtifactResolverEnvironment,
): IndexArtifactResolver {
  const rootPath = env.HEIMDALL_INDEX_ARTIFACT_ROOT ?? env.INDEX_ARTIFACT_ROOT;
  if (rootPath && rootPath.trim().length > 0) {
    return createFileSystemIndexArtifactResolver({ rootPath });
  }

  const bucket = env.HEIMDALL_INDEX_ARTIFACT_BUCKET ?? env.OBJECT_STORAGE_BUCKET;
  const accessKeyId = env.HEIMDALL_INDEX_ARTIFACT_ACCESS_KEY_ID ?? env.AWS_ACCESS_KEY_ID;
  const secretAccessKey =
    env.HEIMDALL_INDEX_ARTIFACT_SECRET_ACCESS_KEY ?? env.AWS_SECRET_ACCESS_KEY;
  if (bucket && accessKeyId && secretAccessKey) {
    const forcePathStyle = booleanEnv(env.HEIMDALL_INDEX_ARTIFACT_FORCE_PATH_STYLE);
    const sessionToken = env.HEIMDALL_INDEX_ARTIFACT_SESSION_TOKEN ?? env.AWS_SESSION_TOKEN;

    return createS3CompatibleIndexArtifactResolver({
      accessKeyId,
      bucket,
      region:
        env.HEIMDALL_INDEX_ARTIFACT_REGION ??
        env.AWS_REGION ??
        env.AWS_DEFAULT_REGION ??
        "us-east-1",
      secretAccessKey,
      ...(env.HEIMDALL_INDEX_ARTIFACT_ENDPOINT
        ? { endpoint: env.HEIMDALL_INDEX_ARTIFACT_ENDPOINT }
        : {}),
      ...(forcePathStyle === undefined ? {} : { forcePathStyle }),
      ...(sessionToken ? { sessionToken } : {}),
    });
  }

  return createFileSystemIndexArtifactResolver();
}

/** Reads a filesystem-backed index artifact from a file URL or local path. */
export async function readIndexArtifactFromUri(
  artifactUri: string,
  options: FileSystemIndexArtifactResolverOptions = {},
): Promise<IndexArtifact> {
  return createFileSystemIndexArtifactResolver(options).readArtifact(artifactUri);
}

/** Resolves an artifact URI and imports the loaded artifact into normalized DB tables. */
export async function importIndexArtifactFromUri(
  options: ImportIndexArtifactFromUriOptions,
): Promise<ImportIndexArtifactResult> {
  const resolver = options.artifactResolver ?? createFileSystemIndexArtifactResolver();
  const artifact = await resolver.readArtifact(options.artifactUri);

  return importIndexArtifact(artifact, options);
}

/** Imports a validated index artifact into normalized DB tables idempotently. */
export async function importIndexArtifact(
  artifact: IndexArtifact,
  options: ImportIndexArtifactOptions,
): Promise<ImportIndexArtifactResult> {
  const telemetry = startIndexImporterTelemetry(artifact, options);
  const validationErrors = validateIndexArtifact(artifact);
  if (validationErrors.length > 0) {
    finishIndexImporterTelemetry(options.metrics, telemetry, {
      error: new Error(`Invalid index artifact validation failed: ${validationErrors.join("; ")}`),
      status: "failed",
      validationFailureCount: validationErrors.length,
    });
    throw new Error(`Invalid index artifact: ${validationErrors.join("; ")}`);
  }

  try {
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
    const importRecordBatchSize = boundedImportRecordBatchSize(options.importRecordBatchSize);

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
          target: [
            codeIndexVersions.repoId,
            codeIndexVersions.commitSha,
            codeIndexVersions.indexKey,
          ],
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
        const fileRows = files.map((file) => ({
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
        }));
        for (const batch of batchRecords(fileRows, importRecordBatchSize)) {
          await tx.insert(indexedFiles).values(batch).onConflictDoNothing();
        }
      }

      if (symbolRecords.length > 0) {
        const symbolRows = symbolRecords.map((symbol) => ({
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
        }));
        for (const batch of batchRecords(symbolRows, importRecordBatchSize)) {
          await tx.insert(symbols).values(batch).onConflictDoNothing();
        }
      }

      if (edgeRecords.length > 0) {
        const edgeRows = edgeRecords.map((edge) => ({
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
        }));
        for (const batch of batchRecords(edgeRows, importRecordBatchSize)) {
          await tx.insert(codeEdges).values(batch).onConflictDoNothing();
        }
      }

      if (chunks.length > 0) {
        const chunkRows = chunks.map((chunk) => ({
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
        }));
        for (const batch of batchRecords(chunkRows, importRecordBatchSize)) {
          await tx.insert(codeChunks).values(batch).onConflictDoNothing();
        }
      }
    });

    const embeddingJobCount = options.enqueueEmbeddings
      ? await enqueueEmbeddingBatches({
          artifact,
          chunks,
          indexVersionId,
          options,
          repoId: artifact.manifest.repoId,
        })
      : 0;
    const result = {
      indexVersionId,
      fileCount: files.length,
      symbolCount: symbolRecords.length,
      edgeCount: edgeRecords.length,
      chunkCount: chunks.length,
      embeddingJobCount,
    } satisfies ImportIndexArtifactResult;
    finishIndexImporterTelemetry(options.metrics, telemetry, {
      artifact,
      result,
      status: "succeeded",
    });
    return result;
  } catch (error) {
    finishIndexImporterTelemetry(options.metrics, telemetry, { error, status: "failed" });
    throw error;
  }
}

/** Starts product-safe index-import telemetry and returns shared metric labels. */
function startIndexImporterTelemetry(
  artifact: IndexArtifact,
  options: ImportIndexArtifactOptions,
): IndexImporterTelemetryState {
  const labels = { indexer: normalizeIndexImporterLabel(artifact.manifest.indexerName) };
  const span = options.traces?.startSpan(OBSERVABILITY_SPAN_NAMES.indexImporterImportArtifact, {
    attributes: {
      "app.repo_id": artifact.manifest.repoId,
      "index_importer.chunk_count": artifact.manifest.chunkCount,
      "index_importer.edge_count": artifact.manifest.edgeCount,
      "index_importer.file_count": artifact.manifest.fileCount,
      "index_importer.indexer": labels.indexer,
      "index_importer.record_count": artifact.manifest.recordCount,
      "index_importer.schema_version": artifact.manifest.schemaVersion,
      "index_importer.symbol_count": artifact.manifest.symbolCount,
    },
    ...(options.traceContext ? { traceContext: options.traceContext } : {}),
  });

  return {
    labels,
    span,
    startedAtMs: Date.now(),
  };
}

/** Ends an index-import span and emits aggregate import metrics. */
function finishIndexImporterTelemetry(
  metrics: TelemetryMetricRecorder | undefined,
  telemetry: IndexImporterTelemetryState,
  input: {
    /** Imported artifact, when import reached record classification. */
    readonly artifact?: IndexArtifact;
    /** Error raised while importing, when the operation failed. */
    readonly error?: unknown;
    /** Import result, when the operation succeeded. */
    readonly result?: ImportIndexArtifactResult;
    /** Final index-import status. */
    readonly status: IndexImporterTelemetryStatus;
    /** Number of artifact validation failures, when validation failed. */
    readonly validationFailureCount?: number;
  },
): void {
  const durationMs = Date.now() - telemetry.startedAtMs;
  const labels = {
    ...telemetry.labels,
    ...(input.error === undefined ? {} : { error_class: classifyTelemetryError(input.error) }),
    status: input.status,
  };

  metrics?.count(OBSERVABILITY_METRIC_NAMES.indexImporterImportsTotal, { labels });
  metrics?.histogram(OBSERVABILITY_METRIC_NAMES.indexImporterDurationMs, Math.max(0, durationMs), {
    labels,
    unit: "ms",
  });

  if (input.artifact) {
    recordIndexImporterRecordMetrics(metrics, input.artifact);
  }
  if (input.validationFailureCount && input.validationFailureCount > 0) {
    metrics?.count(OBSERVABILITY_METRIC_NAMES.indexImporterValidationFailuresTotal, {
      labels: telemetry.labels,
      value: input.validationFailureCount,
    });
  }

  telemetry.span?.end({
    ...(input.error === undefined ? {} : { error: input.error }),
    attributes: {
      "index_importer.duration_ms": Math.max(0, durationMs),
      ...(input.result
        ? {
            "app.index_version_id": input.result.indexVersionId,
            "index_importer.embedding_job_count": input.result.embeddingJobCount,
          }
        : {}),
      ...(input.validationFailureCount
        ? { "index_importer.validation_failure_count": input.validationFailureCount }
        : {}),
      ...(input.error === undefined
        ? {}
        : { "index_importer.error_class": classifyTelemetryError(input.error) }),
      "index_importer.status": input.status,
    },
    status: input.status === "succeeded" ? "ok" : "error",
  });
}

/** Records imported record counts grouped by bounded record type. */
function recordIndexImporterRecordMetrics(
  metrics: TelemetryMetricRecorder | undefined,
  artifact: IndexArtifact,
): void {
  const countsByType = new Map<string, number>();
  for (const record of artifact.records) {
    countsByType.set(record.type, (countsByType.get(record.type) ?? 0) + 1);
  }

  for (const [recordType, count] of countsByType) {
    metrics?.count(OBSERVABILITY_METRIC_NAMES.indexImporterRecordsTotal, {
      labels: { record_type: recordType },
      value: count,
    });
  }
}

/** Normalizes index-importer telemetry label values. */
function normalizeIndexImporterLabel(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9_.-]+/gu, "_")
    .replaceAll(/^_+|_+$/gu, "")
    .slice(0, 80);

  return normalized.length > 0 ? normalized : "unknown";
}

/** Returns a bounded import record batch size for normalized row inserts. */
function boundedImportRecordBatchSize(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_IMPORT_RECORD_BATCH_SIZE;
  }
  if (!Number.isSafeInteger(value)) {
    return DEFAULT_IMPORT_RECORD_BATCH_SIZE;
  }

  return Math.min(MAX_IMPORT_RECORD_BATCH_SIZE, Math.max(1, value));
}

/** Yields stable slices of row values for bounded batch inserts. */
function* batchRecords<T>(records: readonly T[], batchSize: number): Generator<T[]> {
  for (let offset = 0; offset < records.length; offset += batchSize) {
    yield records.slice(offset, offset + batchSize);
  }
}

/** Enqueues durable embedding batch jobs and records phase-specific embedding planner state. */
async function enqueueEmbeddingBatches(input: {
  /** Imported artifact that created the embedding work. */
  readonly artifact: IndexArtifact;
  /** Chunks that need embedding work planned. */
  readonly chunks: readonly ChunkRecord[];
  /** Durable index version ID created for the artifact. */
  readonly indexVersionId: string;
  /** Import options that carry queue and profile settings. */
  readonly options: ImportIndexArtifactOptions;
  /** Repository that owns the chunks. */
  readonly repoId: string;
}): Promise<number> {
  if (input.chunks.length === 0) {
    return 0;
  }

  const options = input.options;
  const batchSize = options.embeddingBatchSize ?? 128;
  const embeddingModel = options.embeddingModel ?? "text-embedding-3-small";
  const embeddingProfileVersion =
    options.embeddingProfileVersion ?? DEFAULT_CODE_EMBEDDING_PROFILE_VERSION;
  const embeddingProvider = options.embeddingProvider ?? "configured";
  const embeddingDimensions = options.embeddingDimensions ?? DEFAULT_EMBEDDING_DIMENSIONS;
  const orgId = await loadRepositoryOrgId(options.db, input.repoId);
  const embeddingJobId = stableId("embjob", [
    input.repoId,
    input.indexVersionId,
    embeddingProfileVersion,
    embeddingProvider,
    embeddingModel,
    embeddingDimensions,
  ]);
  let count = 0;

  await options.db
    .insert(embeddingJobs)
    .values({
      embeddingJobId,
      orgId,
      repoId: input.repoId,
      indexVersionId: input.indexVersionId,
      commitSha: input.artifact.manifest.commitSha,
      status: "pending",
      reason: "index_import",
      embeddingProfileVersion,
      provider: embeddingProvider,
      model: embeddingModel,
      dimensions: embeddingDimensions,
      chunkCountPlanned: input.chunks.length,
      metadata: {
        artifactId: input.artifact.manifest.artifactId,
        artifactUri: options.artifactUri,
        batchSize,
        indexerName: input.artifact.manifest.indexerName,
        indexerVersion: input.artifact.manifest.indexerVersion,
      },
    })
    .onConflictDoNothing();

  await options.db
    .insert(embeddingJobItems)
    .values(
      input.chunks.map((chunk) => ({
        embeddingJobItemId: stableId("embitem", [embeddingJobId, chunk.chunkId]),
        embeddingJobId,
        chunkId: chunk.chunkId,
        status: "pending",
      })),
    )
    .onConflictDoNothing();

  for (let index = 0; index < input.chunks.length; index += batchSize) {
    const chunkIds = input.chunks.slice(index, index + batchSize).map((chunk) => chunk.chunkId);
    const payload: EmbeddingBatchJobPayload = {
      repoId: input.repoId,
      indexVersionId: input.indexVersionId,
      chunkIds,
      embeddingModel,
      embeddingJobId,
      embeddingProfileVersion,
    };
    const now = new Date().toISOString();
    const jobKey = `embedding:${embeddingJobId}:${index / batchSize}`;
    await options.db
      .insert(backgroundJobs)
      .values({
        backgroundJobId: stableId("job", [jobKey]),
        queueName: QUEUE_NAMES.embedding,
        jobKey,
        jobType: JOB_TYPES.EmbeddingBatch,
        status: "pending",
        repoId: input.repoId,
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

  await enqueueEmbeddingRepairJob({
    db: options.db,
    dimensions: embeddingDimensions,
    embeddingJobId,
    embeddingModel,
    embeddingProfileVersion,
    embeddingProvider,
    indexVersionId: input.indexVersionId,
    orgId,
    repoId: input.repoId,
  });

  return count;
}

/** Schedules a delayed repair pass for embedding progress drift after batch jobs run. */
async function enqueueEmbeddingRepairJob(input: {
  /** Database used to persist the delayed durable repair job. */
  readonly db: HeimdallDatabase;
  /** Embedding vector dimensions recorded on the planned job. */
  readonly dimensions: number;
  /** Durable embedding job row ID repaired by the backstop. */
  readonly embeddingJobId: string;
  /** Embedding model recorded on the planned job. */
  readonly embeddingModel: string;
  /** Embedding profile version recorded on the planned job. */
  readonly embeddingProfileVersion: string;
  /** Embedding provider recorded on the planned job. */
  readonly embeddingProvider: string;
  /** Imported index version associated with the repair job. */
  readonly indexVersionId: string;
  /** Organization that owns the repository. */
  readonly orgId: string;
  /** Repository that owns the embedding job. */
  readonly repoId: string;
}): Promise<void> {
  const scheduledAt = new Date(Date.now() + EMBEDDING_REPAIR_DELAY_MS);
  const payload: EmbeddingRepairJobPayload = {
    dimensions: input.dimensions,
    embeddingJobId: input.embeddingJobId,
    embeddingProfileVersion: input.embeddingProfileVersion,
    indexVersionId: input.indexVersionId,
    model: input.embeddingModel,
    provider: input.embeddingProvider,
    repoId: input.repoId,
  };
  const jobKey = `embedding:repair:${input.embeddingJobId}`;

  await input.db
    .insert(backgroundJobs)
    .values({
      backgroundJobId: stableId("job", [jobKey]),
      jobKey,
      jobType: JOB_TYPES.EmbeddingRepair,
      maxAttempts: 3,
      metadata: {
        source: "embedding_planner_repair_backstop",
      },
      orgId: input.orgId,
      payload: {
        attempt: 0,
        createdAt: new Date().toISOString(),
        idempotencyKey: jobKey,
        jobId: stableId("job", [jobKey, "envelope"]),
        jobType: JOB_TYPES.EmbeddingRepair,
        maxAttempts: 3,
        payload,
        scheduledFor: scheduledAt.toISOString(),
        schemaVersion: "job_envelope.v1",
      },
      queueName: QUEUE_NAMES.embedding,
      repoId: input.repoId,
      scheduledAt,
      status: "pending",
    })
    .onConflictDoNothing();
}

/** Loads a repository owner org for embedding planner rows. */
async function loadRepositoryOrgId(db: HeimdallDatabase, repoId: string): Promise<string> {
  const [repository] = await db
    .select({ orgId: repositories.orgId })
    .from(repositories)
    .where(eq(repositories.repoId, repoId))
    .limit(1);

  if (!repository) {
    throw new Error(`Repository ${repoId} was not found for embedding planning.`);
  }

  return repository.orgId;
}

/** Resolves and bounds a local artifact path against an optional root directory. */
function resolveLocalArtifactPath(artifactUri: string, rootPath: string | undefined): string {
  const artifactPath = localPathFromArtifactUri(artifactUri, rootPath);
  if (rootPath && !isPathInsideRoot(rootPath, artifactPath)) {
    throw new Error("Index artifact path is outside the configured artifact root.");
  }

  return artifactPath;
}

/** Reads either a whole-artifact JSON file or a split artifact directory. */
async function readFilesystemIndexArtifact(artifactPath: string): Promise<IndexArtifact> {
  const info = await stat(artifactPath);
  if (info.isDirectory()) {
    return readSplitIndexArtifactDirectory(artifactPath);
  }

  return JSON.parse(await readFile(artifactPath, "utf8")) as IndexArtifact;
}

/** Reads an artifact directory containing manifest.json and records.jsonl files. */
async function readSplitIndexArtifactDirectory(directoryPath: string): Promise<IndexArtifact> {
  const [manifestJson, records] = await Promise.all([
    readFile(resolve(directoryPath, "manifest.json"), "utf8"),
    readJsonlIndexRecords(resolve(directoryPath, "records.jsonl")),
  ]);

  return {
    manifest: JSON.parse(manifestJson) as IndexArtifact["manifest"],
    records,
  };
}

/** Streams newline-delimited index records from a split artifact records file. */
async function readJsonlIndexRecords(recordsPath: string): Promise<IndexArtifact["records"]> {
  const records: Array<IndexArtifact["records"][number]> = [];
  const lines = createInterface({
    crlfDelay: Number.POSITIVE_INFINITY,
    input: createReadStream(recordsPath, { encoding: "utf8" }),
  });
  let lineNumber = 0;

  for await (const line of lines) {
    lineNumber += 1;
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    try {
      records.push(JSON.parse(trimmed) as IndexArtifact["records"][number]);
    } catch (error) {
      throw new Error(`Invalid index artifact JSONL record at line ${lineNumber}.`, {
        cause: error,
      });
    }
  }

  return records;
}

/** Converts R2 object URIs to S3-compatible URIs for the shared object reader. */
function normalizeObjectArtifactUri(artifactUri: string): string {
  if (artifactUri.startsWith("r2://")) {
    return `s3://${artifactUri.slice("r2://".length)}`;
  }

  return artifactUri;
}

/** Converts a supported artifact URI or local path to an absolute filesystem path. */
function localPathFromArtifactUri(artifactUri: string, rootPath: string | undefined): string {
  if (hasUriScheme(artifactUri)) {
    const url = new URL(artifactUri);
    if (url.protocol !== "file:") {
      throw new Error(`Unsupported index artifact URI scheme: ${url.protocol}`);
    }

    return fileURLToPath(url);
  }

  if (isAbsolute(artifactUri)) {
    return resolve(artifactUri);
  }

  return resolve(rootPath ?? process.cwd(), artifactUri);
}

/** Returns whether a value starts with a URI scheme. */
function hasUriScheme(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
}

/** Returns whether a path is inside a configured root directory. */
function isPathInsideRoot(rootPath: string, targetPath: string): boolean {
  const relativePath = relative(resolve(rootPath), resolve(targetPath));

  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

/** Parses an environment boolean where undefined means caller default. */
function booleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }

  return value === "true" || value === "1";
}

/** Computes a stable SHA-256 hash for an index artifact payload. */
function hashArtifact(artifact: IndexArtifact): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(JSON.stringify(artifact)).digest("hex")}`;
}

/** Creates a deterministic ID from ordered stringable parts. */
function stableId(prefix: string, parts: readonly unknown[]): string {
  return `${prefix}_${createHash("sha256")
    .update(parts.map((part) => String(part)).join(":"))
    .digest("base64url")
    .slice(0, 26)}`;
}
