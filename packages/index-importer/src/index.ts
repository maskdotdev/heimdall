import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type ReviewArtifactFetch, S3CompatibleReviewArtifactPayloadStore } from "@repo/artifacts";
import {
  type EmbeddingBatchJobPayload,
  type EmbeddingRepairJobPayload,
  JOB_TYPES,
} from "@repo/contracts";
import {
  backgroundJobs,
  codeChunkEmbeddings,
  codeChunks,
  codeEdges,
  codeIndexVersions,
  embeddingJobItems,
  embeddingJobs,
  type HeimdallDatabase,
  indexedFiles,
  indexImportBatches,
  repositories,
  symbols,
} from "@repo/db";
import {
  type ChunkRecord,
  createStableId,
  type IndexArtifact,
  validateIndexArtifact,
} from "@repo/index-schema";
import { type ReadIndexArtifactPathOptions, readIndexArtifactPath } from "@repo/index-schema/node";
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
import { and, asc, eq, inArray, like, lt, not, or } from "drizzle-orm";

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

/** Default safety limits for one index artifact import. */
export const DEFAULT_INDEX_IMPORT_LIMITS = {
  maxChunkTextBytes: 256_000,
  maxChunks: 500_000,
  maxEdges: 1_000_000,
  maxFiles: 100_000,
  maxRecordBytes: 2_000_000,
  maxRecords: 1_000_000,
  maxSymbols: 500_000,
} satisfies IndexImportLimits;

/** Resolver that loads an index artifact from a durable URI or local path. */
export type IndexArtifactResolver = {
  /** Reads and parses an index artifact from the provided URI. */
  readonly readArtifact: (
    artifactUri: string,
    options?: IndexArtifactReadOptions,
  ) => Promise<IndexArtifact>;
};

/** Optional controls used while reading artifact bytes from durable storage. */
export type IndexArtifactReadOptions = {
  /** Optional safety limits that readers can enforce before a full artifact is assembled. */
  readonly importLimits?: Partial<IndexImportLimits>;
};

/** Options for the default filesystem-backed artifact resolver. */
export type FileSystemIndexArtifactResolverOptions = {
  /** Optional root directory that resolved local paths must stay inside. */
  readonly rootPath?: string;
};

/** Options for direct filesystem artifact reads. */
export type ReadIndexArtifactFromUriOptions = FileSystemIndexArtifactResolverOptions &
  IndexArtifactReadOptions;

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

/** Configurable safety limits for one index artifact import. */
export type IndexImportLimits = {
  /** Maximum UTF-8 bytes allowed for one chunk text payload. */
  readonly maxChunkTextBytes: number;
  /** Maximum chunk records allowed in one artifact. */
  readonly maxChunks: number;
  /** Maximum edge records allowed in one artifact. */
  readonly maxEdges: number;
  /** Maximum file records allowed in one artifact. */
  readonly maxFiles: number;
  /** Maximum UTF-8 JSON bytes allowed for one artifact record. */
  readonly maxRecordBytes: number;
  /** Maximum total records allowed in one artifact. */
  readonly maxRecords: number;
  /** Maximum symbol records allowed in one artifact. */
  readonly maxSymbols: number;
};

/** Environment values used to configure index import limits. */
export type IndexImportLimitsEnvironment = Readonly<Record<string, string | undefined>>;

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
  /** Optional safety limits for artifact record and chunk sizes. */
  readonly importLimits?: Partial<IndexImportLimits>;
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
  /** Durable import batch ID that records phase and outcome state. */
  readonly importBatchId: string;
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

/** Options for reconciling abandoned import batches after worker crashes. */
export type ReconcileStaleIndexImportsOptions = {
  /** Database used to mark stale imports failed and clean partial rows. */
  readonly db: HeimdallDatabase;
  /** Maximum stale import batches reconciled in one pass. */
  readonly limit?: number;
  /** Current time used to calculate the stale cutoff. */
  readonly now?: Date;
  /** Running duration after which an import batch is considered stale. */
  readonly staleAfterMs: number;
};

/** Summary returned after one stale index import reconciliation pass. */
export type ReconcileStaleIndexImportsResult = {
  /** Cutoff timestamp used to select stale import batches. */
  readonly cutoff: string;
  /** Stale import batch IDs selected for reconciliation. */
  readonly importBatchIds: readonly string[];
  /** Number of stale import batches marked failed. */
  readonly importBatchCount: number;
  /** Failed index version IDs that had partial child rows cleaned. */
  readonly indexVersionIds: readonly string[];
};

/** Options for deleting partial child rows attached to one imported index version. */
export type CleanupIndexImportRowsOptions = {
  /** Database used to inspect and clean import rows. */
  readonly db: HeimdallDatabase;
  /** Index version whose partial child rows should be cleaned. */
  readonly indexVersionId: string;
  /** Allows cleanup for non-failed index versions during documented break-glass recovery. */
  readonly force?: boolean;
};

/** Summary returned after cleaning partial child rows for one imported index version. */
export type CleanupIndexImportRowsResult = {
  /** Index version whose child rows were cleaned. */
  readonly indexVersionId: string;
  /** Status observed before cleanup ran. */
  readonly status: string;
  /** Whether force mode allowed cleanup of a non-failed version. */
  readonly force: boolean;
  /** Embedding job IDs that were cleaned with the index child rows. */
  readonly embeddingJobIds: readonly string[];
  /** Whether cleanup completed. */
  readonly cleaned: boolean;
};

type IndexImporterTelemetryStatus = "failed" | "succeeded";

type IndexImportBatchPhase =
  | "activating_index_version"
  | "complete"
  | "creating_index_version"
  | "failed"
  | "planning_embeddings"
  | "validating_manifest"
  | "writing_records";

type IndexImportPlan = {
  /** Artifact content hash used for idempotency and support lookup. */
  readonly artifactHash: `sha256:${string}`;
  /** Chunks classified from the artifact records. */
  readonly chunks: readonly ChunkRecord[];
  /** Edge records classified from the artifact records. */
  readonly edgeRecords: readonly Extract<IndexArtifact["records"][number], { type: "edge" }>[];
  /** Bounded number of chunk IDs placed in one embedding batch job. */
  readonly embeddingBatchSize: number;
  /** Embedding vector dimensions recorded on durable planner rows. */
  readonly embeddingDimensions: number;
  /** Deterministic embedding job ID for this import/profile combination. */
  readonly embeddingJobId: string;
  /** Embedding model recorded on durable planner rows. */
  readonly embeddingModel: string;
  /** Embedding profile version recorded on durable planner rows. */
  readonly embeddingProfileVersion: string;
  /** Embedding provider recorded on durable planner rows. */
  readonly embeddingProvider: string;
  /** File records classified from the artifact records. */
  readonly files: readonly Extract<IndexArtifact["records"][number], { type: "file" }>[];
  /** Durable import batch ID that owns progress state. */
  readonly importBatchId: string;
  /** Fully resolved safety limits for artifact record and chunk sizes. */
  readonly importLimits: IndexImportLimits;
  /** Bounded insert batch size for normalized record writes. */
  readonly importRecordBatchSize: number;
  /** Deterministic index key for this importer/chunker profile. */
  readonly indexKey: string;
  /** Deterministic index version ID for this artifact profile. */
  readonly indexVersionId: string;
  /** Symbol records classified from the artifact records. */
  readonly symbolRecords: readonly Extract<IndexArtifact["records"][number], { type: "symbol" }>[];
};

type ExistingIndexVersionForImport = {
  /** Artifact hash stored for the existing index version, when present. */
  readonly artifactHash: string | null;
  /** Number of chunks recorded on the existing index version. */
  readonly chunkCount: number;
  /** Number of edges recorded on the existing index version. */
  readonly edgeCount: number;
  /** Number of files recorded on the existing index version. */
  readonly fileCount: number;
  /** Existing index version ID. */
  readonly indexVersionId: string;
  /** Number of symbols recorded on the existing index version. */
  readonly symbolCount: number;
  /** Existing index version status. */
  readonly status: string;
};

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
    readArtifact: async (artifactUri, readOptions) => {
      const artifactPath = resolveLocalArtifactPath(artifactUri, rootPath);

      return readIndexArtifactPath(
        artifactPath,
        artifactPathReadOptions(readOptions?.importLimits),
      );
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

/** Creates fully resolved index import safety limits from environment variables. */
export function createIndexImportLimitsFromEnvironment(
  env: IndexImportLimitsEnvironment,
): IndexImportLimits {
  const limits: Partial<IndexImportLimits> = {};
  assignOptionalLimit(limits, "maxChunkTextBytes", env.INDEX_IMPORT_MAX_CHUNK_TEXT_BYTES);
  assignOptionalLimit(limits, "maxChunks", env.INDEX_IMPORT_MAX_CHUNKS);
  assignOptionalLimit(limits, "maxEdges", env.INDEX_IMPORT_MAX_EDGES);
  assignOptionalLimit(limits, "maxFiles", env.INDEX_IMPORT_MAX_FILES);
  assignOptionalLimit(limits, "maxRecordBytes", env.INDEX_IMPORT_MAX_RECORD_BYTES);
  assignOptionalLimit(limits, "maxRecords", env.INDEX_IMPORT_MAX_RECORDS);
  assignOptionalLimit(limits, "maxSymbols", env.INDEX_IMPORT_MAX_SYMBOLS);

  return resolveIndexImportLimits(limits);
}

/** Reads a filesystem-backed index artifact from a file URL or local path. */
export async function readIndexArtifactFromUri(
  artifactUri: string,
  options: ReadIndexArtifactFromUriOptions = {},
): Promise<IndexArtifact> {
  return createFileSystemIndexArtifactResolver(options).readArtifact(
    artifactUri,
    indexArtifactReadOptions(options.importLimits),
  );
}

/** Resolves an artifact URI and imports the loaded artifact into normalized DB tables. */
export async function importIndexArtifactFromUri(
  options: ImportIndexArtifactFromUriOptions,
): Promise<ImportIndexArtifactResult> {
  const resolver = options.artifactResolver ?? createFileSystemIndexArtifactResolver();
  const artifact = await resolver.readArtifact(
    options.artifactUri,
    indexArtifactReadOptions(options.importLimits),
  );

  return importIndexArtifact(artifact, options);
}

/** Imports a validated index artifact into normalized DB tables idempotently. */
export async function importIndexArtifact(
  artifact: IndexArtifact,
  options: ImportIndexArtifactOptions,
): Promise<ImportIndexArtifactResult> {
  const telemetry = startIndexImporterTelemetry(artifact, options);
  const importPlan = createIndexImportPlan(artifact, options);
  let importBatchStarted = false;
  let validationFailureCount = 0;

  try {
    const existingIndexVersion = await findExistingIndexVersionForImport(
      options.db,
      artifact,
      importPlan,
    );
    if (existingIndexVersion?.status === "ready") {
      const result = {
        importBatchId: importPlan.importBatchId,
        indexVersionId: existingIndexVersion.indexVersionId,
        fileCount: existingIndexVersion.fileCount,
        symbolCount: existingIndexVersion.symbolCount,
        edgeCount: existingIndexVersion.edgeCount,
        chunkCount: existingIndexVersion.chunkCount,
        embeddingJobCount: 0,
      } satisfies ImportIndexArtifactResult;
      finishIndexImporterTelemetry(options.metrics, telemetry, {
        artifact,
        result,
        status: "succeeded",
      });
      return result;
    }

    await markIndexImportBatchRunning(options.db, artifact, options, importPlan, {
      phase: "validating_manifest",
    });
    importBatchStarted = true;

    const validationErrors = validateIndexArtifact(artifact);
    validationFailureCount = validationErrors.length;
    if (validationErrors.length > 0) {
      throw new Error(`Invalid index artifact: validation failed: ${validationErrors.join("; ")}`);
    }
    const limitErrors = validateIndexImportLimits(artifact, importPlan);
    validationFailureCount = limitErrors.length;
    if (limitErrors.length > 0) {
      throw new Error(
        `Invalid index artifact: validation limits exceeded: ${limitErrors.join("; ")}`,
      );
    }

    await markIndexImportBatchRunning(options.db, artifact, options, importPlan, {
      phase: "creating_index_version",
    });

    if (existingIndexVersion?.status === "failed") {
      await cleanupFailedIndexImportRows(options.db, importPlan);
    }

    await options.db.transaction(async (tx) => {
      await tx
        .insert(codeIndexVersions)
        .values({
          indexVersionId: importPlan.indexVersionId,
          repoId: artifact.manifest.repoId,
          commitSha: artifact.manifest.commitSha,
          indexKey: importPlan.indexKey,
          status: "importing",
          artifactUri: options.artifactUri,
          artifactHash: importPlan.artifactHash,
          indexerName: artifact.manifest.indexerName,
          indexerVersion: artifact.manifest.indexerVersion,
          chunkerVersion: artifact.manifest.chunkerVersion,
          fileCount: importPlan.files.length,
          symbolCount: importPlan.symbolRecords.length,
          edgeCount: importPlan.edgeRecords.length,
          chunkCount: importPlan.chunks.length,
          embeddedChunkCount: 0,
          completedAt: null,
          error: null,
        })
        .onConflictDoUpdate({
          target: [
            codeIndexVersions.repoId,
            codeIndexVersions.commitSha,
            codeIndexVersions.indexKey,
            codeIndexVersions.artifactHash,
          ],
          set: {
            status: "importing",
            artifactUri: options.artifactUri,
            artifactHash: importPlan.artifactHash,
            fileCount: importPlan.files.length,
            symbolCount: importPlan.symbolRecords.length,
            edgeCount: importPlan.edgeRecords.length,
            chunkCount: importPlan.chunks.length,
            completedAt: null,
            error: null,
          },
        });

      await tx
        .update(indexImportBatches)
        .set({
          indexVersionId: importPlan.indexVersionId,
          phase: "writing_records",
          updatedAt: new Date(),
        })
        .where(eq(indexImportBatches.indexImportBatchId, importPlan.importBatchId));

      if (importPlan.files.length > 0) {
        const fileRows = importPlan.files.map((file) => ({
          fileId: file.fileId,
          indexVersionId: importPlan.indexVersionId,
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
        for (const batch of batchRecords(fileRows, importPlan.importRecordBatchSize)) {
          await tx.insert(indexedFiles).values(batch).onConflictDoNothing();
        }
      }

      if (importPlan.symbolRecords.length > 0) {
        const symbolRows = importPlan.symbolRecords.map((symbol) => ({
          symbolId: symbol.symbolId,
          indexVersionId: importPlan.indexVersionId,
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
        for (const batch of batchRecords(symbolRows, importPlan.importRecordBatchSize)) {
          await tx.insert(symbols).values(batch).onConflictDoNothing();
        }
      }

      if (importPlan.edgeRecords.length > 0) {
        const edgeRows = importPlan.edgeRecords.map((edge) => ({
          edgeId: edge.edgeId,
          indexVersionId: importPlan.indexVersionId,
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
        for (const batch of batchRecords(edgeRows, importPlan.importRecordBatchSize)) {
          await tx.insert(codeEdges).values(batch).onConflictDoNothing();
        }
      }

      if (importPlan.chunks.length > 0) {
        const chunkRows = importPlan.chunks.map((chunk) => ({
          chunkId: chunk.chunkId,
          indexVersionId: importPlan.indexVersionId,
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
        for (const batch of batchRecords(chunkRows, importPlan.importRecordBatchSize)) {
          await tx.insert(codeChunks).values(batch).onConflictDoNothing();
        }
      }
    });

    let embeddingJobCount = 0;
    if (options.enqueueEmbeddings) {
      await markIndexImportBatchRunning(options.db, artifact, options, importPlan, {
        phase: "planning_embeddings",
      });
      embeddingJobCount = await enqueueEmbeddingBatches({
        artifact,
        options,
        plan: importPlan,
        repoId: artifact.manifest.repoId,
      });
    }

    await markIndexImportBatchRunning(options.db, artifact, options, importPlan, {
      phase: "activating_index_version",
    });
    await completeIndexImportBatch(options.db, artifact, importPlan, { embeddingJobCount });

    const result = {
      importBatchId: importPlan.importBatchId,
      indexVersionId: importPlan.indexVersionId,
      fileCount: importPlan.files.length,
      symbolCount: importPlan.symbolRecords.length,
      edgeCount: importPlan.edgeRecords.length,
      chunkCount: importPlan.chunks.length,
      embeddingJobCount,
    } satisfies ImportIndexArtifactResult;
    finishIndexImporterTelemetry(options.metrics, telemetry, {
      artifact,
      result,
      status: "succeeded",
    });
    return result;
  } catch (error) {
    if (importBatchStarted) {
      await markIndexImportBatchFailed(options.db, importPlan, error).catch(() => undefined);
    }
    finishIndexImporterTelemetry(options.metrics, telemetry, {
      error,
      status: "failed",
      ...(validationFailureCount > 0 ? { validationFailureCount } : {}),
    });
    throw error;
  }
}

/** Marks stale running import batches failed and cleans their partial index rows. */
export async function reconcileStaleIndexImports(
  options: ReconcileStaleIndexImportsOptions,
): Promise<ReconcileStaleIndexImportsResult> {
  const now = options.now ?? new Date();
  const cutoff = staleIndexImportCutoff(now, options.staleAfterMs);
  const limit = boundedReconciliationLimit(options.limit);
  const rows = await options.db
    .select({
      importBatchId: indexImportBatches.indexImportBatchId,
      indexVersionId: indexImportBatches.indexVersionId,
    })
    .from(indexImportBatches)
    .where(
      and(
        not(inArray(indexImportBatches.status, ["complete", "failed"])),
        lt(indexImportBatches.updatedAt, cutoff),
      ),
    )
    .orderBy(asc(indexImportBatches.updatedAt))
    .limit(limit);
  const importBatchIds = rows.map((row) => row.importBatchId);
  const indexVersionIds = uniqueStrings(
    rows
      .map((row) => row.indexVersionId)
      .filter((indexVersionId): indexVersionId is string => indexVersionId !== null),
  );

  if (rows.length === 0) {
    return {
      cutoff: cutoff.toISOString(),
      importBatchCount: 0,
      importBatchIds,
      indexVersionIds,
    };
  }

  const serializedError = staleIndexImportError(cutoff);
  await options.db.transaction(async (tx) => {
    for (const importBatchId of importBatchIds) {
      await tx
        .update(indexImportBatches)
        .set({
          error: serializedError,
          finishedAt: now,
          phase: "failed",
          status: "failed",
          updatedAt: now,
        })
        .where(eq(indexImportBatches.indexImportBatchId, importBatchId));
    }

    for (const indexVersionId of indexVersionIds) {
      await tx
        .update(codeIndexVersions)
        .set({
          error: serializedError,
          status: "failed",
        })
        .where(eq(codeIndexVersions.indexVersionId, indexVersionId));
    }
  });

  for (const indexVersionId of indexVersionIds) {
    await cleanupFailedIndexVersionRows(options.db, { indexVersionId });
  }

  return {
    cutoff: cutoff.toISOString(),
    importBatchCount: rows.length,
    importBatchIds,
    indexVersionIds,
  };
}

/** Deletes partial child rows for a failed index version while preserving parent diagnostics. */
export async function cleanupIndexImportRows(
  options: CleanupIndexImportRowsOptions,
): Promise<CleanupIndexImportRowsResult> {
  const [row] = await options.db
    .select({ status: codeIndexVersions.status })
    .from(codeIndexVersions)
    .where(eq(codeIndexVersions.indexVersionId, options.indexVersionId))
    .limit(1);

  if (!row) {
    throw new Error(`Index version ${options.indexVersionId} was not found.`);
  }

  if (!options.force && row.status !== "failed") {
    throw new Error(
      `Refusing to cleanup index version ${options.indexVersionId} with status ${row.status}. Use --force only for a documented break-glass cleanup.`,
    );
  }

  const embeddingJobIds = await loadEmbeddingJobIdsForIndexVersion(
    options.db,
    options.indexVersionId,
  );
  await cleanupFailedIndexVersionRows(options.db, {
    embeddingJobIds,
    indexVersionId: options.indexVersionId,
  });

  return {
    cleaned: true,
    embeddingJobIds,
    force: options.force ?? false,
    indexVersionId: options.indexVersionId,
    status: row.status,
  };
}

/** Builds deterministic IDs and typed record groups for one artifact import. */
function createIndexImportPlan(
  artifact: IndexArtifact,
  options: ImportIndexArtifactOptions,
): IndexImportPlan {
  const indexKey = [
    artifact.manifest.indexerName,
    artifact.manifest.indexerVersion,
    artifact.manifest.chunkerVersion,
  ].join(":");
  const artifactHash = artifactHashForImport(artifact);
  const files = artifact.records.filter((record) => record.type === "file");
  const symbolRecords = artifact.records.filter((record) => record.type === "symbol");
  const edgeRecords = artifact.records.filter((record) => record.type === "edge");
  const chunks = artifact.records.filter(
    (record): record is ChunkRecord => record.type === "chunk",
  );
  const importLimits = resolveIndexImportLimits(options.importLimits);
  const embeddingBatchSize = boundedEmbeddingBatchSize(options.embeddingBatchSize);
  const embeddingModel = options.embeddingModel ?? "text-embedding-3-small";
  const embeddingProfileVersion =
    options.embeddingProfileVersion ?? DEFAULT_CODE_EMBEDDING_PROFILE_VERSION;
  const embeddingProvider = options.embeddingProvider ?? "configured";
  const embeddingDimensions = options.embeddingDimensions ?? DEFAULT_EMBEDDING_DIMENSIONS;
  const indexVersionId = createStableId("idx", [
    artifact.manifest.repoId,
    artifact.manifest.commitSha,
    artifact.manifest.indexerName,
    artifact.manifest.indexerVersion,
    artifact.manifest.chunkerVersion,
    artifactHash,
  ]);
  const embeddingJobId = createStableId("embjob", [
    artifact.manifest.repoId,
    indexVersionId,
    embeddingProfileVersion,
    embeddingProvider,
    embeddingModel,
    embeddingDimensions,
  ]);

  return {
    artifactHash,
    chunks,
    edgeRecords,
    embeddingBatchSize,
    embeddingDimensions,
    embeddingJobId,
    embeddingModel,
    embeddingProfileVersion,
    embeddingProvider,
    files,
    importBatchId: createStableId("imb", [
      artifact.manifest.repoId,
      artifact.manifest.commitSha,
      indexKey,
      artifactHash,
    ]),
    importLimits,
    importRecordBatchSize: boundedImportRecordBatchSize(options.importRecordBatchSize),
    indexKey,
    indexVersionId,
    symbolRecords,
  };
}

/** Validates configured import safety limits against manifest and record payload sizes. */
function validateIndexImportLimits(artifact: IndexArtifact, plan: IndexImportPlan): string[] {
  const limits = plan.importLimits;
  const errors: string[] = [];

  collectLimitError(errors, "recordCount", artifact.manifest.recordCount, limits.maxRecords);
  collectLimitError(errors, "fileCount", artifact.manifest.fileCount, limits.maxFiles);
  collectLimitError(errors, "symbolCount", artifact.manifest.symbolCount, limits.maxSymbols);
  collectLimitError(errors, "edgeCount", artifact.manifest.edgeCount, limits.maxEdges);
  collectLimitError(errors, "chunkCount", artifact.manifest.chunkCount, limits.maxChunks);
  collectLimitError(errors, "actualRecordCount", artifact.records.length, limits.maxRecords);
  collectLimitError(errors, "actualFileCount", plan.files.length, limits.maxFiles);
  collectLimitError(errors, "actualSymbolCount", plan.symbolRecords.length, limits.maxSymbols);
  collectLimitError(errors, "actualEdgeCount", plan.edgeRecords.length, limits.maxEdges);
  collectLimitError(errors, "actualChunkCount", plan.chunks.length, limits.maxChunks);

  artifact.records.forEach((record, index) => {
    collectLimitError(
      errors,
      `recordBytes[${index + 1}:${record.type}]`,
      byteLength(JSON.stringify(record)),
      limits.maxRecordBytes,
    );
  });

  plan.chunks.forEach((chunk, index) => {
    collectLimitError(
      errors,
      `chunkTextBytes[${index + 1}]`,
      byteLength(chunk.text),
      limits.maxChunkTextBytes,
    );
  });

  return errors;
}

/** Appends a product-safe validation error when a count exceeds its configured maximum. */
function collectLimitError(errors: string[], name: string, actual: number, maximum: number): void {
  if (actual > maximum) {
    errors.push(`${name} ${actual} exceeds configured maximum ${maximum}`);
  }
}

/** Creates or refreshes the visible import batch phase for a running artifact import. */
async function markIndexImportBatchRunning(
  db: HeimdallDatabase,
  artifact: IndexArtifact,
  options: ImportIndexArtifactOptions,
  plan: IndexImportPlan,
  input: {
    /** Import phase now being executed. */
    readonly phase: IndexImportBatchPhase;
  },
): Promise<void> {
  const now = new Date();
  const indexVersionId = importBatchPhaseHasIndexVersion(input.phase) ? plan.indexVersionId : null;

  await db
    .insert(indexImportBatches)
    .values({
      indexImportBatchId: plan.importBatchId,
      repoId: artifact.manifest.repoId,
      commitSha: artifact.manifest.commitSha,
      indexKey: plan.indexKey,
      indexVersionId,
      artifactUri: options.artifactUri,
      artifactHash: plan.artifactHash,
      status: "running",
      phase: input.phase,
      recordCount: artifact.manifest.recordCount,
      fileCount: plan.files.length,
      symbolCount: plan.symbolRecords.length,
      edgeCount: plan.edgeRecords.length,
      chunkCount: plan.chunks.length,
      embeddingJobCount: 0,
      error: null,
      metadata: {
        artifactId: artifact.manifest.artifactId,
        chunkerVersion: artifact.manifest.chunkerVersion,
        importLimits: plan.importLimits,
        importRecordBatchSize: plan.importRecordBatchSize,
        indexerName: artifact.manifest.indexerName,
        indexerVersion: artifact.manifest.indexerVersion,
        schemaVersion: artifact.manifest.schemaVersion,
      },
      startedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: indexImportBatches.indexImportBatchId,
      set: {
        indexVersionId,
        artifactUri: options.artifactUri,
        artifactHash: plan.artifactHash,
        status: "running",
        phase: input.phase,
        recordCount: artifact.manifest.recordCount,
        fileCount: plan.files.length,
        symbolCount: plan.symbolRecords.length,
        edgeCount: plan.edgeRecords.length,
        chunkCount: plan.chunks.length,
        error: null,
        metadata: {
          artifactId: artifact.manifest.artifactId,
          chunkerVersion: artifact.manifest.chunkerVersion,
          importLimits: plan.importLimits,
          importRecordBatchSize: plan.importRecordBatchSize,
          indexerName: artifact.manifest.indexerName,
          indexerVersion: artifact.manifest.indexerVersion,
          schemaVersion: artifact.manifest.schemaVersion,
        },
        startedAt: now,
        finishedAt: null,
        updatedAt: now,
      },
    });
}

/** Marks an import batch complete and activates its index version atomically. */
async function completeIndexImportBatch(
  db: HeimdallDatabase,
  artifact: IndexArtifact,
  plan: IndexImportPlan,
  input: {
    /** Number of durable embedding jobs planned by the import. */
    readonly embeddingJobCount: number;
  },
): Promise<void> {
  const now = new Date();

  await db.transaction(async (tx) => {
    await tx
      .update(codeIndexVersions)
      .set({
        completedAt: new Date(artifact.manifest.generatedAt),
        error: null,
        status: "ready",
      })
      .where(eq(codeIndexVersions.indexVersionId, plan.indexVersionId));

    await tx
      .update(indexImportBatches)
      .set({
        embeddingJobCount: input.embeddingJobCount,
        finishedAt: now,
        phase: "complete",
        status: "complete",
        updatedAt: now,
      })
      .where(eq(indexImportBatches.indexImportBatchId, plan.importBatchId));
  });
}

/** Loads an existing index version for the import key that could affect retry safety. */
async function findExistingIndexVersionForImport(
  db: HeimdallDatabase,
  artifact: IndexArtifact,
  plan: IndexImportPlan,
): Promise<ExistingIndexVersionForImport | undefined> {
  const [row] = await db
    .select({
      artifactHash: codeIndexVersions.artifactHash,
      chunkCount: codeIndexVersions.chunkCount,
      edgeCount: codeIndexVersions.edgeCount,
      fileCount: codeIndexVersions.fileCount,
      indexVersionId: codeIndexVersions.indexVersionId,
      status: codeIndexVersions.status,
      symbolCount: codeIndexVersions.symbolCount,
    })
    .from(codeIndexVersions)
    .where(
      and(
        eq(codeIndexVersions.repoId, artifact.manifest.repoId),
        eq(codeIndexVersions.commitSha, artifact.manifest.commitSha),
        eq(codeIndexVersions.indexKey, plan.indexKey),
        eq(codeIndexVersions.artifactHash, plan.artifactHash),
      ),
    )
    .limit(1);

  return row;
}

/** Marks the visible import batch and its index version as failed. */
async function markIndexImportBatchFailed(
  db: HeimdallDatabase,
  plan: IndexImportPlan,
  error: unknown,
): Promise<void> {
  const now = new Date();
  const serializedError = serializeIndexImportError(error);

  await db
    .update(indexImportBatches)
    .set({
      error: serializedError,
      finishedAt: now,
      phase: "failed",
      status: "failed",
      updatedAt: now,
    })
    .where(eq(indexImportBatches.indexImportBatchId, plan.importBatchId));

  await db
    .update(codeIndexVersions)
    .set({
      error: serializedError,
      status: "failed",
    })
    .where(eq(codeIndexVersions.indexVersionId, plan.indexVersionId));

  await cleanupFailedIndexImportRows(db, plan).catch(() => undefined);
}

/** Deletes partial child rows for a failed index version while keeping diagnostic parent rows. */
async function cleanupFailedIndexImportRows(
  db: HeimdallDatabase,
  plan: IndexImportPlan,
): Promise<void> {
  await cleanupFailedIndexVersionRows(db, {
    embeddingJobIds: [plan.embeddingJobId],
    indexVersionId: plan.indexVersionId,
  });
}

/** Deletes partial child rows for a failed index version while keeping diagnostic parent rows. */
async function cleanupFailedIndexVersionRows(
  db: HeimdallDatabase,
  input: {
    /** Embedding job IDs to clean without an extra lookup when already known. */
    readonly embeddingJobIds?: readonly string[];
    /** Failed index version whose partial child rows should be deleted. */
    readonly indexVersionId: string;
  },
): Promise<void> {
  const embeddingJobIds =
    input.embeddingJobIds ?? (await loadEmbeddingJobIdsForIndexVersion(db, input.indexVersionId));

  await db.transaction(async (tx) => {
    for (const embeddingJobId of embeddingJobIds) {
      await tx
        .delete(backgroundJobs)
        .where(
          or(
            like(backgroundJobs.jobKey, `embedding:${embeddingJobId}:%`),
            eq(backgroundJobs.jobKey, `embedding:repair:${embeddingJobId}`),
            like(backgroundJobs.jobKey, `embedding:repair:${embeddingJobId}:batch:%`),
          ),
        );
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
    await tx.delete(codeEdges).where(eq(codeEdges.indexVersionId, input.indexVersionId));
    await tx.delete(codeChunks).where(eq(codeChunks.indexVersionId, input.indexVersionId));
    await tx.delete(symbols).where(eq(symbols.indexVersionId, input.indexVersionId));
    await tx.delete(indexedFiles).where(eq(indexedFiles.indexVersionId, input.indexVersionId));
  });
}

/** Loads embedding job IDs attached to an index version for stale import cleanup. */
async function loadEmbeddingJobIdsForIndexVersion(
  db: HeimdallDatabase,
  indexVersionId: string,
): Promise<readonly string[]> {
  const rows = await db
    .select({ embeddingJobId: embeddingJobs.embeddingJobId })
    .from(embeddingJobs)
    .where(eq(embeddingJobs.indexVersionId, indexVersionId));

  return rows.map((row) => row.embeddingJobId);
}

/** Serializes an import failure into product-safe database metadata. */
function serializeIndexImportError(error: unknown): Record<string, string> {
  return {
    class: classifyTelemetryError(error),
    message:
      error instanceof Error ? error.message.slice(0, 1_000) : "Unknown index import failure.",
  };
}

/** Serializes an abandoned import failure into product-safe database metadata. */
function staleIndexImportError(cutoff: Date): Record<string, string> {
  return {
    class: "timeout_error",
    message: `Index import did not update before ${cutoff.toISOString()} and was marked failed.`,
  };
}

/** Returns the manifest artifact hash when valid, or computes a deterministic fallback hash. */
function artifactHashForImport(artifact: IndexArtifact): `sha256:${string}` {
  const artifactHash = artifact.manifest.artifactHash;
  if (artifactHash?.startsWith("sha256:")) {
    return artifactHash as `sha256:${string}`;
  }

  return hashArtifact(artifact);
}

/** Resolves caller-provided import limits against conservative defaults. */
function resolveIndexImportLimits(
  limits: Partial<IndexImportLimits> | undefined,
): IndexImportLimits {
  return {
    maxChunkTextBytes: boundedPositiveInteger(
      limits?.maxChunkTextBytes,
      DEFAULT_INDEX_IMPORT_LIMITS.maxChunkTextBytes,
    ),
    maxChunks: boundedPositiveInteger(limits?.maxChunks, DEFAULT_INDEX_IMPORT_LIMITS.maxChunks),
    maxEdges: boundedPositiveInteger(limits?.maxEdges, DEFAULT_INDEX_IMPORT_LIMITS.maxEdges),
    maxFiles: boundedPositiveInteger(limits?.maxFiles, DEFAULT_INDEX_IMPORT_LIMITS.maxFiles),
    maxRecordBytes: boundedPositiveInteger(
      limits?.maxRecordBytes,
      DEFAULT_INDEX_IMPORT_LIMITS.maxRecordBytes,
    ),
    maxRecords: boundedPositiveInteger(limits?.maxRecords, DEFAULT_INDEX_IMPORT_LIMITS.maxRecords),
    maxSymbols: boundedPositiveInteger(limits?.maxSymbols, DEFAULT_INDEX_IMPORT_LIMITS.maxSymbols),
  };
}

/** Bounds one positive integer configuration value to a safe importer limit. */
function boundedPositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isSafeInteger(value)) {
    return fallback;
  }

  return Math.max(1, value);
}

/** Assigns a parsed environment limit only when the value is present and valid. */
function assignOptionalLimit<K extends keyof IndexImportLimits>(
  limits: Partial<IndexImportLimits>,
  key: K,
  value: string | undefined,
): void {
  const parsed = parseOptionalPositiveInteger(value);
  if (parsed !== undefined) {
    limits[key] = parsed;
  }
}

/** Builds resolver read options only when caller-provided limits exist. */
function indexArtifactReadOptions(
  importLimits: Partial<IndexImportLimits> | undefined,
): IndexArtifactReadOptions | undefined {
  return importLimits === undefined ? undefined : { importLimits };
}

/** Builds split-artifact path read limits from resolved importer safety limits. */
function artifactPathReadOptions(
  importLimits: Partial<IndexImportLimits> | undefined,
): ReadIndexArtifactPathOptions {
  const limits = resolveIndexImportLimits(importLimits);

  return {
    recordLimits: {
      maxRecordBytes: limits.maxRecordBytes,
      maxRecords: limits.maxRecords,
    },
  };
}

/** Parses an optional positive integer from an environment variable. */
function parseOptionalPositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** Returns the UTF-8 byte length of a string. */
function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** Returns whether an import phase can safely reference an existing index version row. */
function importBatchPhaseHasIndexVersion(phase: IndexImportBatchPhase): boolean {
  return phase !== "validating_manifest" && phase !== "creating_index_version";
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

/** Returns a positive embedding batch size for durable planner jobs. */
function boundedEmbeddingBatchSize(value: number | undefined): number {
  if (value === undefined || !Number.isSafeInteger(value)) {
    return 128;
  }

  return Math.max(1, value);
}

/** Calculates the stale import cutoff from a current time and duration. */
function staleIndexImportCutoff(now: Date, staleAfterMs: number): Date {
  const boundedStaleAfterMs =
    Number.isFinite(staleAfterMs) && staleAfterMs > 0 ? Math.trunc(staleAfterMs) : 1;

  return new Date(now.getTime() - boundedStaleAfterMs);
}

/** Bounds stale import reconciliation batches to a positive safety limit. */
function boundedReconciliationLimit(value: number | undefined): number {
  if (value === undefined || !Number.isSafeInteger(value)) {
    return 100;
  }

  return Math.min(Math.max(value, 1), 1_000);
}

/** Returns unique strings while preserving first-seen order. */
function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
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
  /** Import options that carry queue and profile settings. */
  readonly options: ImportIndexArtifactOptions;
  /** Import plan that carries deterministic IDs and embedding settings. */
  readonly plan: IndexImportPlan;
  /** Repository that owns the chunks. */
  readonly repoId: string;
}): Promise<number> {
  if (input.plan.chunks.length === 0) {
    return 0;
  }

  const options = input.options;
  const batchSize = input.plan.embeddingBatchSize;
  const embeddingModel = input.plan.embeddingModel;
  const embeddingProfileVersion = input.plan.embeddingProfileVersion;
  const embeddingProvider = input.plan.embeddingProvider;
  const embeddingDimensions = input.plan.embeddingDimensions;
  const importRecordBatchSize = input.plan.importRecordBatchSize;
  const orgId = await loadRepositoryOrgId(options.db, input.repoId);
  const embeddingJobId = input.plan.embeddingJobId;
  let count = 0;

  await options.db
    .insert(embeddingJobs)
    .values({
      embeddingJobId,
      orgId,
      repoId: input.repoId,
      indexVersionId: input.plan.indexVersionId,
      commitSha: input.artifact.manifest.commitSha,
      status: "pending",
      reason: "index_import",
      embeddingProfileVersion,
      provider: embeddingProvider,
      model: embeddingModel,
      dimensions: embeddingDimensions,
      chunkCountPlanned: input.plan.chunks.length,
      metadata: {
        artifactId: input.artifact.manifest.artifactId,
        artifactUri: options.artifactUri,
        batchSize,
        indexerName: input.artifact.manifest.indexerName,
        indexerVersion: input.artifact.manifest.indexerVersion,
      },
    })
    .onConflictDoNothing();

  const embeddingJobItemRows = input.plan.chunks.map((chunk) => ({
    embeddingJobItemId: createStableId("embitem", [embeddingJobId, chunk.chunkId]),
    embeddingJobId,
    chunkId: chunk.chunkId,
    status: "pending",
  }));
  for (const batch of batchRecords(embeddingJobItemRows, importRecordBatchSize)) {
    await options.db.insert(embeddingJobItems).values(batch).onConflictDoNothing();
  }

  for (let index = 0; index < input.plan.chunks.length; index += batchSize) {
    const chunkIds = input.plan.chunks
      .slice(index, index + batchSize)
      .map((chunk) => chunk.chunkId);
    const payload: EmbeddingBatchJobPayload = {
      repoId: input.repoId,
      indexVersionId: input.plan.indexVersionId,
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
        backgroundJobId: createStableId("job", [jobKey]),
        queueName: QUEUE_NAMES.embedding,
        jobKey,
        jobType: JOB_TYPES.EmbeddingBatch,
        status: "pending",
        repoId: input.repoId,
        payload: {
          jobId: createStableId("job", [jobKey, "envelope"]),
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
    indexVersionId: input.plan.indexVersionId,
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
      backgroundJobId: createStableId("job", [jobKey]),
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
        jobId: createStableId("job", [jobKey, "envelope"]),
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
