import { createHash } from "node:crypto";
import type { EmbeddingBatchJobPayload } from "@repo/contracts";
import {
  codeChunkEmbeddings,
  codeChunks,
  codeIndexVersions,
  type HeimdallDatabase,
} from "@repo/db";
import {
  classifyTelemetryError,
  OBSERVABILITY_METRIC_NAMES,
  OBSERVABILITY_SPAN_NAMES,
  type TelemetryMetricRecorder,
  type TelemetrySpanHandle,
  type TelemetrySpanRecorder,
  type TelemetryTraceContextInput,
} from "@repo/observability";
import { and, eq, inArray, sql } from "drizzle-orm";

export const packageName = "@repo/embedding" as const;

/** Dimension required by the current pgvector storage schema. */
export const DEFAULT_EMBEDDING_DIMENSIONS = 1536;

/** Default embedding profile version for code chunk inputs. */
export const DEFAULT_CODE_EMBEDDING_PROFILE_VERSION = "code_embedding_profile.v1";

/** Maximum tokens allowed for one code chunk embedding input. */
export const DEFAULT_MAX_EMBEDDING_INPUT_TOKENS = 8192;

/** Default provider request limits for MVP embedding batches. */
export const DEFAULT_EMBEDDING_BATCH_POLICY = {
  maxCharsPerRequest: 1_500_000,
  maxInputsPerRequest: 128,
  maxTokensPerRequest: 200_000,
} as const satisfies EmbeddingBatchPolicy;

/** Default local provider identifier used when no embedding provider is configured. */
export const DEFAULT_EMBEDDING_PROVIDER = "hash";

/** Provider boundary for chunk embeddings. */
export type EmbeddingProvider = {
  /** Low-cardinality provider ID used for telemetry. */
  readonly providerId?: string;
  /** Embedding model name. */
  readonly model: string;
  /** Vector dimension returned by the provider. */
  readonly dimensions: number;
  /** Embeds input texts in order. */
  readonly embedTexts: (texts: readonly string[]) => Promise<readonly (readonly number[])[]>;
};

/** Environment values used to select an embedding provider. */
export type EmbeddingProviderEnvironment = Readonly<Record<string, string | undefined>>;

/** Options for creating an embedding provider from environment values. */
export type CreateEmbeddingProviderFromEnvironmentOptions = {
  /** Model requested by the queued embedding job. */
  readonly model?: string;
};

/** Source data used to build a provider input for one code chunk. */
export type CodeChunkEmbeddingInputSource = {
  /** Stable chunk ID used to correlate provider responses. */
  readonly chunkId: string;
  /** Repository-relative path for retrieval context. */
  readonly path: string;
  /** Optional language hint from importer metadata. */
  readonly language?: string;
  /** Optional chunk kind hint from importer metadata. */
  readonly kind?: string;
  /** Optional symbol ID associated with the chunk. */
  readonly symbolId?: string;
  /** First line covered by the chunk. */
  readonly startLine: number;
  /** Last line covered by the chunk. */
  readonly endLine: number;
  /** Raw immutable chunk text from importer metadata. */
  readonly text: string;
};

/** Options for code chunk embedding input construction. */
export type CodeChunkEmbeddingInputOptions = {
  /** Maximum estimated tokens allowed in the final provider input. */
  readonly maxInputTokens?: number;
};

/** Provider-ready embedding input and metadata. */
export type BuiltEmbeddingInput = {
  /** Stable input ID used to match a vector back to a chunk. */
  readonly inputId: string;
  /** Kind of source represented by the input. */
  readonly inputKind: "code_chunk";
  /** Provider input text after normalization and truncation. */
  readonly text: string;
  /** SHA-256 hash of the final provider input text. */
  readonly inputHash: `sha256:${string}`;
  /** Conservative token estimate for the final provider input text. */
  readonly tokenEstimate: number;
  /** Whether the raw source text was truncated to fit the input policy. */
  readonly wasTruncated: boolean;
};

/** Request batching limits for provider calls. */
export type EmbeddingBatchPolicy = {
  /** Maximum number of inputs per provider request. */
  readonly maxInputsPerRequest: number;
  /** Maximum estimated tokens per provider request. */
  readonly maxTokensPerRequest: number;
  /** Maximum characters per provider request. */
  readonly maxCharsPerRequest: number;
};

/** Result produced after embedding one chunk batch. */
export type EmbedChunkBatchResult = {
  /** Number of chunks newly embedded and stored. */
  readonly embeddedChunkCount: number;
  /** Chunk IDs that were skipped because text was unavailable. */
  readonly skippedChunkIds: readonly string[];
};

/** Options for embedding one queued chunk batch. */
export type EmbedChunkBatchOptions = {
  /** Database used to read chunks and persist vectors. */
  readonly db: HeimdallDatabase;
  /** Embedding provider used for uncached chunk inputs. */
  readonly provider: EmbeddingProvider;
  /** Optional input construction policy. */
  readonly inputOptions?: CodeChunkEmbeddingInputOptions;
  /** Optional provider request batching policy. */
  readonly batchPolicy?: EmbeddingBatchPolicy;
  /** Optional metric recorder for product-safe aggregate embedding telemetry. */
  readonly metrics?: TelemetryMetricRecorder;
  /** Optional trace context propagated from the durable embedding job. */
  readonly traceContext?: TelemetryTraceContextInput | undefined;
  /** Optional span recorder for product-safe embedding spans. */
  readonly traces?: TelemetrySpanRecorder;
};

type EmbeddingTelemetryStatus = "failed" | "succeeded";

type EmbeddingTelemetryState = {
  /** Low-cardinality labels shared by embedding job and duration metrics. */
  readonly labels: Readonly<{
    readonly model_profile: string;
    readonly provider: string;
  }>;
  /** Monotonic start time used for duration metrics. */
  readonly startedAtMs: number;
  /** Product-safe span for this embedding batch. */
  readonly span: TelemetrySpanHandle | undefined;
};

type EmbeddingBatchTelemetryStats = {
  /** Provider request batches planned for the embedding job. */
  readonly batchCount: number;
  /** Number of chunks inserted into vector storage. */
  readonly embeddedChunkCount: number;
  /** Number of provider inputs built from chunk text. */
  readonly inputCount: number;
  /** Number of requested chunks skipped before provider calls. */
  readonly skippedChunkCount: number;
  /** Estimated tokens sent to the embedding provider. */
  readonly tokenCount: number;
  /** Number of provider inputs truncated to fit policy. */
  readonly truncatedInputCount: number;
};

/** Embeds queued chunks and stores vectors idempotently for retrieval. */
export async function embedChunkBatch(
  payload: EmbeddingBatchJobPayload,
  options: EmbedChunkBatchOptions,
): Promise<EmbedChunkBatchResult> {
  const telemetry = startEmbeddingTelemetry(payload, options);
  let telemetryStats: EmbeddingBatchTelemetryStats | undefined;

  try {
    const rows = await options.db
      .select()
      .from(codeChunks)
      .where(
        and(
          eq(codeChunks.indexVersionId, payload.indexVersionId),
          inArray(codeChunks.chunkId, payload.chunkIds),
        ),
      );
    const chunkInputs = rows
      .map((row) => {
        const text = textFromMetadata(row.metadata);
        if (!text) {
          return undefined;
        }

        return {
          input: buildCodeChunkEmbeddingInput(
            {
              chunkId: row.chunkId,
              endLine: row.endLine,
              path: row.path,
              startLine: row.startLine,
              text,
              ...optionalStringProperty("kind", stringFromMetadata(row.metadata, "kind")),
              ...optionalStringProperty("language", stringFromMetadata(row.metadata, "language")),
              ...optionalStringProperty("symbolId", row.symbolId ?? undefined),
            },
            options.inputOptions,
          ),
          row,
        };
      })
      .filter(
        (
          entry,
        ): entry is {
          readonly input: BuiltEmbeddingInput;
          readonly row: (typeof rows)[number];
        } => Boolean(entry),
      );
    const inputChunkIds = new Set(chunkInputs.map((entry) => entry.row.chunkId));
    const skippedChunkIds = payload.chunkIds.filter((chunkId) => !inputChunkIds.has(chunkId));
    const inputBatches = buildEmbeddingInputBatches(
      chunkInputs.map((entry) => entry.input),
      options.batchPolicy,
    );
    telemetryStats = embeddingTelemetryStats(chunkInputs, inputBatches, skippedChunkIds.length);
    const vectorsByInputId = new Map<string, readonly number[]>();

    for (const inputBatch of inputBatches) {
      const vectors = validateEmbeddingVectors(
        await options.provider.embedTexts(inputBatch.map((input) => input.text)),
        inputBatch.length,
        options.provider.dimensions,
      );
      for (const [index, input] of inputBatch.entries()) {
        vectorsByInputId.set(input.inputId, vectors[index] ?? []);
      }
    }

    let insertedChunkCount = 0;

    if (chunkInputs.length > 0) {
      await options.db.transaction(async (tx) => {
        const insertedRows = await tx
          .insert(codeChunkEmbeddings)
          .values(
            chunkInputs.map((entry) => ({
              chunkEmbeddingId: stableId("emb", [entry.row.chunkId, payload.embeddingModel]),
              chunkId: entry.row.chunkId,
              repoId: payload.repoId,
              indexVersionId: payload.indexVersionId,
              embeddingModel: payload.embeddingModel,
              embeddingDimension: options.provider.dimensions,
              embedding: [...requiredVectorForInput(vectorsByInputId, entry.input.inputId)],
              contentHash: entry.row.contentHash,
            })),
          )
          .onConflictDoNothing()
          .returning({ chunkId: codeChunkEmbeddings.chunkId });
        insertedChunkCount = insertedRows.length;

        await tx
          .update(codeChunks)
          .set({ embeddingStatus: "ready" })
          .where(
            inArray(
              codeChunks.chunkId,
              chunkInputs.map((entry) => entry.row.chunkId),
            ),
          );

        const [progress] = await tx
          .select({
            embeddedChunkCount: sql<number>`count(distinct ${codeChunkEmbeddings.chunkId})::int`,
          })
          .from(codeChunkEmbeddings)
          .where(
            and(
              eq(codeChunkEmbeddings.indexVersionId, payload.indexVersionId),
              eq(codeChunkEmbeddings.embeddingModel, payload.embeddingModel),
            ),
          );

        await tx
          .update(codeIndexVersions)
          .set({ embeddedChunkCount: progress?.embeddedChunkCount ?? 0 })
          .where(eq(codeIndexVersions.indexVersionId, payload.indexVersionId));
      });
    }

    const result = {
      embeddedChunkCount: insertedChunkCount,
      skippedChunkIds,
    } satisfies EmbedChunkBatchResult;
    finishEmbeddingTelemetry(options.metrics, telemetry, {
      stats: { ...telemetryStats, embeddedChunkCount: insertedChunkCount },
      status: "succeeded",
    });
    return result;
  } catch (error) {
    finishEmbeddingTelemetry(options.metrics, telemetry, {
      error,
      ...(telemetryStats ? { stats: telemetryStats } : {}),
      status: "failed",
    });
    throw error;
  }
}

/** Starts product-safe embedding telemetry and returns shared metric labels. */
function startEmbeddingTelemetry(
  payload: EmbeddingBatchJobPayload,
  options: EmbedChunkBatchOptions,
): EmbeddingTelemetryState {
  const labels = embeddingMetricLabels(payload, options.provider);
  const span = options.traces?.startSpan(OBSERVABILITY_SPAN_NAMES.embeddingEmbedBatch, {
    attributes: {
      "app.index_version_id": payload.indexVersionId,
      "app.repo_id": payload.repoId,
      "embedding.model_profile": labels.model_profile,
      "embedding.provider": labels.provider,
      "embedding.requested_chunk_count": payload.chunkIds.length,
    },
    kind: "internal",
    ...(options.traceContext ? { traceContext: options.traceContext } : {}),
  });

  return {
    labels,
    span,
    startedAtMs: Date.now(),
  };
}

/** Ends an embedding span and emits aggregate embedding pipeline metrics. */
function finishEmbeddingTelemetry(
  metrics: TelemetryMetricRecorder | undefined,
  telemetry: EmbeddingTelemetryState,
  input: {
    /** Error raised while embedding chunks, when the batch failed. */
    readonly error?: unknown;
    /** Provider input and vector-write stats when planning reached chunk input construction. */
    readonly stats?: EmbeddingBatchTelemetryStats;
    /** Final embedding batch status. */
    readonly status: EmbeddingTelemetryStatus;
  },
): void {
  const durationMs = Date.now() - telemetry.startedAtMs;
  const labels = {
    ...telemetry.labels,
    ...(input.error === undefined ? {} : { error_class: classifyTelemetryError(input.error) }),
    status: input.status,
  };

  metrics?.count(OBSERVABILITY_METRIC_NAMES.embeddingJobsTotal, { labels });
  metrics?.histogram(OBSERVABILITY_METRIC_NAMES.embeddingBatchDurationMs, Math.max(0, durationMs), {
    labels,
    unit: "ms",
  });

  if (input.stats) {
    recordEmbeddingInputMetrics(metrics, telemetry.labels, input.stats);
  }

  telemetry.span?.end({
    ...(input.error === undefined ? {} : { error: input.error }),
    attributes: {
      "embedding.duration_ms": Math.max(0, durationMs),
      ...(input.stats
        ? {
            "embedding.batch_count": input.stats.batchCount,
            "embedding.embedded_chunk_count": input.stats.embeddedChunkCount,
            "embedding.input_count": input.stats.inputCount,
            "embedding.skipped_chunk_count": input.stats.skippedChunkCount,
            "embedding.token_count": input.stats.tokenCount,
            "embedding.truncated_input_count": input.stats.truncatedInputCount,
          }
        : {}),
      ...(input.error === undefined
        ? {}
        : { "embedding.error_class": classifyTelemetryError(input.error) }),
      "embedding.status": input.status,
    },
    status: input.status === "succeeded" ? "ok" : "error",
  });
}

/** Records provider input and estimated token metrics grouped by safe labels. */
function recordEmbeddingInputMetrics(
  metrics: TelemetryMetricRecorder | undefined,
  labels: EmbeddingTelemetryState["labels"],
  stats: EmbeddingBatchTelemetryStats,
): void {
  if (stats.inputCount > 0) {
    metrics?.count(OBSERVABILITY_METRIC_NAMES.embeddingInputsTotal, {
      labels: { ...labels, input_kind: "code_chunk" },
      value: stats.inputCount,
    });
  }
  if (stats.tokenCount > 0) {
    metrics?.count(OBSERVABILITY_METRIC_NAMES.embeddingTokensTotal, {
      labels,
      value: stats.tokenCount,
    });
  }
}

/** Builds aggregate telemetry stats from planned provider inputs. */
function embeddingTelemetryStats(
  chunkInputs: readonly {
    readonly input: BuiltEmbeddingInput;
    readonly row: { readonly chunkId: string };
  }[],
  inputBatches: readonly (readonly BuiltEmbeddingInput[])[],
  skippedChunkCount: number,
): EmbeddingBatchTelemetryStats {
  return {
    batchCount: inputBatches.length,
    embeddedChunkCount: 0,
    inputCount: chunkInputs.length,
    skippedChunkCount,
    tokenCount: chunkInputs.reduce((total, entry) => total + entry.input.tokenEstimate, 0),
    truncatedInputCount: chunkInputs.filter((entry) => entry.input.wasTruncated).length,
  };
}

/** Returns low-cardinality labels shared by embedding pipeline metrics. */
function embeddingMetricLabels(
  payload: EmbeddingBatchJobPayload,
  provider: EmbeddingProvider,
): EmbeddingTelemetryState["labels"] {
  return {
    model_profile: normalizeEmbeddingLabel(payload.embeddingModel || provider.model, "default"),
    provider: normalizeEmbeddingLabel(provider.providerId, "unknown"),
  };
}

/** Normalizes bounded embedding telemetry label values. */
function normalizeEmbeddingLabel(value: string | undefined, fallback: string): string {
  const normalized = value
    ?.trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9_.-]+/gu, "_")
    .replaceAll(/^_+|_+$/gu, "")
    .slice(0, 80);

  return normalized && normalized.length > 0 ? normalized : fallback;
}

/** Builds a stable provider input for one code chunk. */
export function buildCodeChunkEmbeddingInput(
  source: CodeChunkEmbeddingInputSource,
  options: CodeChunkEmbeddingInputOptions = {},
): BuiltEmbeddingInput {
  const trimmedText = source.text.trim();
  if (trimmedText.length === 0) {
    throw new Error("Embedding input text cannot be empty.");
  }

  const header = [
    source.language ? `language: ${source.language}` : undefined,
    `path: ${source.path}`,
    source.symbolId ? `symbol_id: ${source.symbolId}` : undefined,
    source.kind ? `chunk_kind: ${source.kind}` : undefined,
    `lines: ${source.startLine}-${source.endLine}`,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
  const maxInputTokens = options.maxInputTokens ?? DEFAULT_MAX_EMBEDDING_INPUT_TOKENS;
  const maxInputChars = Math.max(1, maxInputTokens * 3);
  const rawInput = `${header}\n\n${trimmedText}`;
  const finalInput =
    roughTokenEstimate(rawInput) > maxInputTokens
      ? `${header}\n\n${truncateEmbeddingBody(trimmedText, Math.max(1, maxInputChars - header.length - 2))}`
      : rawInput;

  return {
    inputHash: sha256(finalInput),
    inputId: source.chunkId,
    inputKind: "code_chunk",
    text: finalInput,
    tokenEstimate: roughTokenEstimate(finalInput),
    wasTruncated: finalInput !== rawInput,
  };
}

/** Builds provider request batches without exceeding count, token, or character limits. */
export function buildEmbeddingInputBatches(
  inputs: readonly BuiltEmbeddingInput[],
  policy: EmbeddingBatchPolicy = DEFAULT_EMBEDDING_BATCH_POLICY,
): readonly (readonly BuiltEmbeddingInput[])[] {
  const batches: BuiltEmbeddingInput[][] = [];
  let currentBatch: BuiltEmbeddingInput[] = [];
  let currentTokens = 0;
  let currentChars = 0;

  for (const input of inputs) {
    const wouldExceed =
      currentBatch.length >= policy.maxInputsPerRequest ||
      currentTokens + input.tokenEstimate > policy.maxTokensPerRequest ||
      currentChars + input.text.length > policy.maxCharsPerRequest;

    if (wouldExceed && currentBatch.length > 0) {
      batches.push(currentBatch);
      currentBatch = [];
      currentTokens = 0;
      currentChars = 0;
    }

    currentBatch.push(input);
    currentTokens += input.tokenEstimate;
    currentChars += input.text.length;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

/** Estimates tokens conservatively for code-heavy embedding inputs. */
export function roughTokenEstimate(text: string): number {
  return Math.ceil(text.length / 3);
}

/** Deterministic local embedding provider for tests and offline retrieval smoke checks. */
export function createHashEmbeddingProvider(
  model = "heimdall-hash-embedding",
  dimensions = DEFAULT_EMBEDDING_DIMENSIONS,
  providerId = DEFAULT_EMBEDDING_PROVIDER,
): EmbeddingProvider {
  return {
    providerId,
    model,
    dimensions,
    embedTexts: async (texts) => texts.map((text) => hashVector(text, dimensions)),
  };
}

/** Creates the configured embedding provider for worker and local runs. */
export function createEmbeddingProviderFromEnvironment(
  env: EmbeddingProviderEnvironment,
  options: CreateEmbeddingProviderFromEnvironmentOptions = {},
): EmbeddingProvider {
  const providerName = (
    env.HEIMDALL_EMBEDDING_PROVIDER ??
    env.EMBEDDING_PROVIDER ??
    DEFAULT_EMBEDDING_PROVIDER
  ).toLowerCase();
  const model =
    options.model ??
    env.HEIMDALL_EMBEDDING_MODEL ??
    env.EMBEDDING_MODEL ??
    "text-embedding-3-small";
  const dimensions =
    optionalPositiveInteger(env.HEIMDALL_EMBEDDING_DIMENSIONS) ??
    optionalPositiveInteger(env.EMBEDDING_DIMENSIONS) ??
    DEFAULT_EMBEDDING_DIMENSIONS;

  if (providerName === "hash" || providerName === "fake" || providerName === "local") {
    return createHashEmbeddingProvider(model, dimensions, providerName);
  }
  if (providerName === "openai") {
    throw new Error("OpenAI embedding provider is not implemented yet.");
  }

  throw new Error(`Unsupported embedding provider: ${providerName}`);
}

/** Validates that provider output matches the storage contract before writing rows. */
function validateEmbeddingVectors(
  vectors: readonly (readonly number[])[],
  expectedCount: number,
  expectedDimensions: number,
): readonly (readonly number[])[] {
  if (vectors.length !== expectedCount) {
    throw new Error(
      `Embedding provider returned ${vectors.length} vectors for ${expectedCount} texts.`,
    );
  }

  for (const [index, vector] of vectors.entries()) {
    if (vector.length !== expectedDimensions) {
      throw new Error(
        `Embedding provider returned ${vector.length} dimensions for vector ${index}; expected ${expectedDimensions}.`,
      );
    }
    if (!vector.every((value) => Number.isFinite(value))) {
      throw new Error(`Embedding provider returned a non-finite value for vector ${index}.`);
    }
  }

  return vectors;
}

/** Extracts chunk text from importer-owned chunk metadata. */
function textFromMetadata(metadata: unknown): string | undefined {
  if (metadata && typeof metadata === "object" && "text" in metadata) {
    const text = (metadata as { readonly text?: unknown }).text;
    return typeof text === "string" && text.trim().length > 0 ? text : undefined;
  }

  return undefined;
}

/** Extracts a string field from importer-owned chunk metadata. */
function stringFromMetadata(metadata: unknown, fieldName: string): string | undefined {
  if (metadata && typeof metadata === "object" && fieldName in metadata) {
    const value = (metadata as Readonly<Record<string, unknown>>)[fieldName];
    return typeof value === "string" && value.trim().length > 0 ? value : undefined;
  }

  return undefined;
}

/** Creates an exact-optional string property only when a value exists. */
function optionalStringProperty<PropertyName extends string>(
  propertyName: PropertyName,
  value: string | undefined,
): Partial<Record<PropertyName, string>> {
  return value === undefined ? {} : ({ [propertyName]: value } as Record<PropertyName, string>);
}

/** Returns a provider vector or fails when response correlation is broken. */
function requiredVectorForInput(
  vectorsByInputId: ReadonlyMap<string, readonly number[]>,
  inputId: string,
): readonly number[] {
  const vector = vectorsByInputId.get(inputId);
  if (!vector) {
    throw new Error(`Embedding provider did not return a vector for input ${inputId}.`);
  }

  return vector;
}

/** Parses a positive integer environment value. */
function optionalPositiveInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** Truncates a chunk body while preserving the start and end of the source text. */
function truncateEmbeddingBody(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  const marker = "\n\n[...truncated...]\n\n";
  if (maxChars <= marker.length + 2) {
    return text.slice(0, maxChars);
  }

  const availableChars = maxChars - marker.length;
  const headChars = Math.ceil(availableChars * 0.7);
  const tailChars = availableChars - headChars;

  return `${text.slice(0, headChars)}${marker}${text.slice(-tailChars)}`;
}

/** Builds a deterministic vector from input text for local and test runs. */
function hashVector(text: string, dimensions: number): readonly number[] {
  const hash = createHash("sha256").update(text).digest();
  return Array.from({ length: dimensions }, (_, index) => (hash[index % hash.length] ?? 0) / 255);
}

/** Hashes provider input text for cache keys and diagnostics. */
function sha256(text: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

/** Builds a compact deterministic identifier from stable input parts. */
function stableId(prefix: string, parts: readonly unknown[]): string {
  return `${prefix}_${createHash("sha256")
    .update(parts.map((part) => String(part)).join(":"))
    .digest("base64url")
    .slice(0, 26)}`;
}
