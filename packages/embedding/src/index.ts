import { createHash } from "node:crypto";
import { type EmbeddingBatchJobPayload, parseWithSchema } from "@repo/contracts";
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
import { type Static, Type } from "@sinclair/typebox";
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

const OpenAIEmbeddingObjectSchema = Type.Object(
  {
    embedding: Type.Array(Type.Number()),
    index: Type.Integer(),
  },
  { additionalProperties: true },
);

const OpenAIEmbeddingsResponseSchema = Type.Object(
  {
    data: Type.Array(OpenAIEmbeddingObjectSchema),
  },
  { additionalProperties: true },
);

const OpenAIErrorResponseSchema = Type.Object(
  {
    error: Type.Optional(
      Type.Object(
        {
          code: Type.Optional(Type.Union([Type.String(), Type.Number(), Type.Null()])),
          type: Type.Optional(Type.String()),
        },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
);

type OpenAIEmbeddingsResponse = Static<typeof OpenAIEmbeddingsResponseSchema>;

type OpenAIHttpErrorMapping = {
  /** Normalized embedding provider error code. */
  readonly code: EmbeddingProviderErrorCode;
  /** Whether the request is safe to retry later. */
  readonly retryable: boolean;
};

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

/** Fetch boundary used by the OpenAI Embeddings provider. */
export type OpenAIEmbeddingsFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Options used to create an OpenAI-compatible embeddings provider. */
export type OpenAIEmbeddingProviderOptions = {
  /** Secret API key used only in the Authorization header. */
  readonly apiKey: string;
  /** Optional OpenAI-compatible API base URL. Defaults to https://api.openai.com/v1. */
  readonly baseUrl?: string;
  /** Optional vector dimensions to request from supported embedding models. */
  readonly dimensions?: number;
  /** Optional fetch implementation for tests or alternate runtimes. */
  readonly fetch?: OpenAIEmbeddingsFetch;
  /** Model identifier sent to the provider. */
  readonly model: string;
  /** Optional OpenAI organization header value. */
  readonly organization?: string;
  /** Optional OpenAI project header value. */
  readonly project?: string;
  /** Optional request timeout in milliseconds. */
  readonly timeoutMs?: number;
};

/** Normalized embedding provider failure codes. */
export type EmbeddingProviderErrorCode =
  | "provider_unavailable"
  | "provider_rate_limited"
  | "provider_auth_failed"
  | "model_not_found"
  | "model_capability_missing"
  | "input_too_large"
  | "timeout"
  | "schema_validation_failed"
  | "unknown";

/** Details used to construct a normalized embedding provider error. */
export type EmbeddingProviderErrorOptions = {
  /** Stable provider error code. */
  readonly code: EmbeddingProviderErrorCode;
  /** Original error object, never serialized by embedding callers. */
  readonly cause?: unknown;
  /** Product-safe diagnostic metadata. */
  readonly details?: Readonly<Record<string, unknown>>;
  /** Model that raised or caused the error. */
  readonly model?: string;
  /** Provider adapter that raised or caused the error. */
  readonly provider?: string;
  /** Whether retrying the same request is expected to be safe. */
  readonly retryable?: boolean;
};

/** Error raised by embedding provider adapters after provider or response failures. */
export class EmbeddingProviderError extends Error {
  /** Stable provider error code. */
  public readonly code: EmbeddingProviderErrorCode;
  /** Original error object, never serialized by embedding callers. */
  public override readonly cause?: unknown;
  /** Product-safe diagnostic metadata. */
  public readonly details?: Readonly<Record<string, unknown>>;
  /** Model that raised or caused the error. */
  public readonly model?: string;
  /** Provider adapter that raised or caused the error. */
  public readonly provider?: string;
  /** Whether retrying the same request is expected to be safe. */
  public readonly retryable: boolean;

  /** Creates a normalized embedding provider error. */
  public constructor(message: string, options: EmbeddingProviderErrorOptions) {
    super(message);
    this.name = "EmbeddingProviderError";
    this.code = options.code;
    this.retryable = options.retryable ?? isRetryableEmbeddingProviderErrorCode(options.code);

    if (options.cause) {
      this.cause = options.cause;
    }
    if (options.details) {
      this.details = options.details;
    }
    if (options.model) {
      this.model = options.model;
    }
    if (options.provider) {
      this.provider = options.provider;
    }
  }
}

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

/** Provider adapter backed by the OpenAI-compatible Embeddings HTTP API. */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  /** Low-cardinality provider ID used for telemetry. */
  public readonly providerId = "openai";

  /** Vector dimension returned by the provider. */
  public readonly dimensions: number;

  /** Model identifier sent to the provider. */
  public readonly model: string;

  /** Secret API key used only for request authorization. */
  private readonly apiKey: string;

  /** OpenAI-compatible API base URL without a trailing slash. */
  private readonly baseUrl: string;

  /** Requested embedding dimensions, when explicitly configured. */
  private readonly dimensionsParameter: number | undefined;

  /** Fetch implementation used for provider requests. */
  private readonly fetchFn: OpenAIEmbeddingsFetch;

  /** Optional organization header value. */
  private readonly organization: string | undefined;

  /** Optional project header value. */
  private readonly project: string | undefined;

  /** Optional request timeout in milliseconds. */
  private readonly timeoutMs: number | undefined;

  /** Creates an OpenAI-compatible embeddings provider. */
  public constructor(options: OpenAIEmbeddingProviderOptions) {
    this.apiKey = requireOpenAIProviderString(options.apiKey, "apiKey");
    this.baseUrl = normalizeOpenAIBaseUrl(options.baseUrl ?? "https://api.openai.com/v1");
    this.dimensionsParameter = optionalPositiveNumber(options.dimensions);
    this.dimensions = this.dimensionsParameter ?? DEFAULT_EMBEDDING_DIMENSIONS;
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.model = requireOpenAIProviderString(options.model, "model");
    this.organization = optionalProviderString(options.organization);
    this.project = optionalProviderString(options.project);
    this.timeoutMs = optionalPositiveNumber(options.timeoutMs);
  }

  /** Calls the embeddings endpoint and returns vectors in the original input order. */
  public async embedTexts(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    if (texts.length === 0) {
      return [];
    }
    if (texts.some((text) => text.trim().length === 0)) {
      throw new EmbeddingProviderError("OpenAI embeddings input cannot contain empty text.", {
        code: "schema_validation_failed",
        model: this.model,
        provider: this.providerId,
        retryable: false,
      });
    }

    const response = await this.fetchEmbeddings(texts);
    if (!response.ok) {
      throw await openAIEmbeddingsHttpError(response, this.model);
    }

    const body = await readOpenAIEmbeddingsJsonResponse(response, this.model);
    const embeddings = parseOpenAIEmbeddingsResponse(body, this.model);

    return openAIEmbeddingVectorsByInputOrder(embeddings, texts.length, this.model);
  }

  /** Sends one embeddings request with optional timeout handling. */
  private async fetchEmbeddings(texts: readonly string[]): Promise<Response> {
    const controller = this.timeoutMs ? new AbortController() : undefined;
    const timeout =
      controller && this.timeoutMs
        ? setTimeout(() => controller.abort(), this.timeoutMs)
        : undefined;

    try {
      return await this.fetchFn(`${this.baseUrl}/embeddings`, {
        body: JSON.stringify(this.createRequestBody(texts)),
        headers: this.createRequestHeaders(),
        method: "POST",
        ...(controller ? { signal: controller.signal } : {}),
      });
    } catch (error) {
      const isTimeout = controller?.signal.aborted === true;
      throw new EmbeddingProviderError(
        isTimeout ? "OpenAI embeddings request timed out." : "OpenAI embeddings request failed.",
        {
          cause: error,
          code: isTimeout ? "timeout" : "provider_unavailable",
          model: this.model,
          provider: this.providerId,
          retryable: true,
        },
      );
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  /** Builds the provider request body for a float embeddings call. */
  private createRequestBody(texts: readonly string[]): Record<string, unknown> {
    return {
      encoding_format: "float",
      input: texts,
      model: this.model,
      ...(this.dimensionsParameter ? { dimensions: this.dimensionsParameter } : {}),
    };
  }

  /** Builds request headers without exposing the API key to logs or metadata. */
  private createRequestHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      ...(this.organization ? { "OpenAI-Organization": this.organization } : {}),
      ...(this.project ? { "OpenAI-Project": this.project } : {}),
    };
  }
}

/** Creates an OpenAI-compatible embeddings provider adapter. */
export function createOpenAIEmbeddingProvider(
  options: OpenAIEmbeddingProviderOptions,
): EmbeddingProvider {
  return new OpenAIEmbeddingProvider(options);
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
  const configuredDimensions =
    optionalPositiveInteger(env.HEIMDALL_EMBEDDING_DIMENSIONS) ??
    optionalPositiveInteger(env.EMBEDDING_DIMENSIONS);
  const model =
    options.model ??
    env.HEIMDALL_EMBEDDING_MODEL ??
    env.EMBEDDING_MODEL ??
    "text-embedding-3-small";
  const dimensions = configuredDimensions ?? DEFAULT_EMBEDDING_DIMENSIONS;

  if (providerName === "hash" || providerName === "fake" || providerName === "local") {
    return createHashEmbeddingProvider(model, dimensions, providerName);
  }
  if (isOpenAIEmbeddingProviderName(providerName)) {
    const apiKey =
      optionalProviderString(env.HEIMDALL_EMBEDDING_API_KEY) ??
      optionalProviderString(env.EMBEDDING_PROVIDER_API_KEY) ??
      optionalProviderString(env.OPENAI_EMBEDDING_API_KEY) ??
      optionalProviderString(env.OPENAI_API_KEY);
    if (!apiKey) {
      throw new Error(
        "EMBEDDING_PROVIDER_API_KEY or OPENAI_API_KEY is required when EMBEDDING_PROVIDER=openai.",
      );
    }

    const baseUrl =
      optionalProviderString(env.HEIMDALL_EMBEDDING_BASE_URL) ??
      optionalProviderString(env.EMBEDDING_PROVIDER_BASE_URL) ??
      optionalProviderString(env.OPENAI_BASE_URL);
    const timeoutMs =
      optionalPositiveInteger(env.HEIMDALL_EMBEDDING_TIMEOUT_MS) ??
      optionalPositiveInteger(env.EMBEDDING_PROVIDER_TIMEOUT_MS) ??
      optionalPositiveInteger(env.OPENAI_TIMEOUT_MS);

    return createOpenAIEmbeddingProvider({
      apiKey,
      ...(baseUrl ? { baseUrl } : {}),
      ...(configuredDimensions ? { dimensions: configuredDimensions } : {}),
      model,
      ...(timeoutMs ? { timeoutMs } : {}),
    });
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

/** Returns whether an embedding provider error code is retryable by default. */
function isRetryableEmbeddingProviderErrorCode(code: EmbeddingProviderErrorCode): boolean {
  return code === "provider_unavailable" || code === "provider_rate_limited" || code === "timeout";
}

/** Returns whether a provider selector names an OpenAI-compatible embeddings provider. */
function isOpenAIEmbeddingProviderName(value: string): boolean {
  const normalized = normalizeProviderSelector(value);

  return (
    normalized === "openai" ||
    normalized === "openai_compatible" ||
    normalized === "openai_embeddings"
  );
}

/** Normalizes provider selectors from configuration into low-cardinality tokens. */
function normalizeProviderSelector(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "_")
    .replaceAll(/^_+|_+$/gu, "");
}

/** Reads a required OpenAI provider option string. */
function requireOpenAIProviderString(value: string | undefined, fieldName: string): string {
  const trimmed = optionalProviderString(value);
  if (!trimmed) {
    throw new Error(`OpenAI embedding provider option ${fieldName} is required.`);
  }

  return trimmed;
}

/** Reads a non-empty provider string. */
function optionalProviderString(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/** Parses a positive finite number option. */
function optionalPositiveNumber(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Normalizes an OpenAI-compatible base URL without a trailing slash. */
function normalizeOpenAIBaseUrl(value: string): string {
  const url = requireOpenAIProviderString(value, "baseUrl");
  return url.replaceAll(/\/+$/gu, "");
}

/** Reads an embeddings response body as JSON without trusting its shape. */
async function readOpenAIEmbeddingsJsonResponse(
  response: Response,
  model: string,
): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch (error) {
    throw new EmbeddingProviderError("OpenAI embeddings response was not valid JSON.", {
      cause: error,
      code: "provider_unavailable",
      details: { responseShape: "embeddings" },
      model,
      provider: "openai",
      retryable: true,
    });
  }
}

/** Parses the provider response envelope without trusting provider output shape. */
function parseOpenAIEmbeddingsResponse(body: unknown, model: string): OpenAIEmbeddingsResponse {
  try {
    return parseWithSchema("OpenAIEmbeddingsResponse", OpenAIEmbeddingsResponseSchema, body);
  } catch (error) {
    throw openAIEmbeddingsResponseShapeError("OpenAI embeddings response envelope was invalid.", {
      cause: error,
      model,
    });
  }
}

/** Orders OpenAI embedding objects by their provider-returned input index. */
function openAIEmbeddingVectorsByInputOrder(
  response: OpenAIEmbeddingsResponse,
  expectedCount: number,
  model: string,
): readonly (readonly number[])[] {
  const vectors = new Array<readonly number[] | undefined>(expectedCount);

  for (const item of response.data) {
    if (item.index < 0 || item.index >= expectedCount) {
      throw openAIEmbeddingsResponseShapeError(
        "OpenAI embeddings response included an out-of-range embedding index.",
        { model },
      );
    }
    if (vectors[item.index]) {
      throw openAIEmbeddingsResponseShapeError(
        "OpenAI embeddings response included a duplicate embedding index.",
        { model },
      );
    }

    vectors[item.index] = item.embedding;
  }

  return vectors.map((vector, index) => {
    if (!vector) {
      throw openAIEmbeddingsResponseShapeError(
        `OpenAI embeddings response did not include embedding index ${index}.`,
        { model },
      );
    }

    return vector;
  });
}

/** Creates a provider-unavailable error for an invalid OpenAI embeddings response envelope. */
function openAIEmbeddingsResponseShapeError(
  message: string,
  options: {
    /** Original validation or parsing error. */
    readonly cause?: unknown;
    /** Model that returned the invalid response. */
    readonly model: string;
  },
): EmbeddingProviderError {
  return new EmbeddingProviderError(message, {
    ...(options.cause ? { cause: options.cause } : {}),
    code: "provider_unavailable",
    details: { responseShape: "embeddings" },
    model: options.model,
    provider: "openai",
    retryable: true,
  });
}

/** Creates a normalized provider error from an OpenAI embeddings HTTP failure. */
async function openAIEmbeddingsHttpError(
  response: Response,
  model: string,
): Promise<EmbeddingProviderError> {
  const details = await openAIEmbeddingsHttpErrorDetails(response);
  const mapping = openAIEmbeddingsErrorMappingForStatus(
    response.status,
    stringDetail(details, "errorCode"),
  );

  return new EmbeddingProviderError(
    `OpenAI embeddings request failed with HTTP ${response.status}.`,
    {
      code: mapping.code,
      details,
      model,
      provider: "openai",
      retryable: mapping.retryable,
    },
  );
}

/** Extracts product-safe details from an OpenAI embeddings HTTP error response. */
async function openAIEmbeddingsHttpErrorDetails(
  response: Response,
): Promise<Readonly<Record<string, unknown>>> {
  const parsed = await safeReadOpenAIErrorBody(response);
  const error = parseOpenAIErrorBody(parsed);
  const requestId =
    optionalProviderString(response.headers.get("x-request-id")) ??
    optionalProviderString(response.headers.get("openai-request-id"));
  const errorCode = openAIErrorCodeString(error?.code);

  return {
    ...(errorCode ? { errorCode } : {}),
    ...(optionalProviderString(error?.type)
      ? { errorType: optionalProviderString(error?.type) }
      : {}),
    ...(requestId ? { requestId } : {}),
    status: response.status,
    statusFamily: `${Math.trunc(response.status / 100)}xx`,
  };
}

/** Reads an OpenAI error body when the response body is valid JSON. */
async function safeReadOpenAIErrorBody(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}

/** Parses an OpenAI error response with a narrow boundary schema. */
function parseOpenAIErrorBody(
  value: unknown,
): Static<typeof OpenAIErrorResponseSchema>["error"] | undefined {
  try {
    return parseWithSchema("OpenAIErrorResponse", OpenAIErrorResponseSchema, value).error;
  } catch {
    return undefined;
  }
}

/** Converts an OpenAI error code value into a safe string detail. */
function openAIErrorCodeString(value: string | number | null | undefined): string | undefined {
  if (typeof value === "string") {
    return optionalProviderString(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return undefined;
}

/** Maps OpenAI embeddings HTTP statuses into the provider error model. */
function openAIEmbeddingsErrorMappingForStatus(
  status: number,
  errorCode: string | undefined,
): OpenAIHttpErrorMapping {
  const normalizedErrorCode = errorCode?.trim().toLowerCase();
  if (normalizedErrorCode === "context_length_exceeded" || status === 413) {
    return { code: "input_too_large", retryable: false };
  }

  if (status === 401 || status === 403) {
    return { code: "provider_auth_failed", retryable: false };
  }
  if (status === 404) {
    return { code: "model_not_found", retryable: false };
  }
  if (status === 408) {
    return { code: "timeout", retryable: true };
  }
  if (status === 429) {
    return { code: "provider_rate_limited", retryable: true };
  }
  if (status >= 500) {
    return { code: "provider_unavailable", retryable: true };
  }
  if (status === 400) {
    return { code: "model_capability_missing", retryable: false };
  }

  return { code: "unknown", retryable: false };
}

/** Reads one string field from a product-safe detail record. */
function stringDetail(details: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = details[key];
  return typeof value === "string" ? value : undefined;
}
