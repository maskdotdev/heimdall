import type { EmbeddingBatchJobPayload } from "@repo/contracts";
import type { HeimdallDatabase } from "@repo/db";
import {
  OBSERVABILITY_METRIC_NAMES,
  OBSERVABILITY_SPAN_NAMES,
  type TelemetryMetricOptions,
  type TelemetryMetricRecorder,
  type TelemetrySpanEndOptions,
  type TelemetrySpanOptions,
  type TelemetrySpanRecorder,
} from "@repo/observability";
import { describe, expect, it } from "vitest";
import {
  type BuiltEmbeddingInput,
  buildCodeChunkEmbeddingInput,
  buildEmbeddingInputBatches,
  createEmbeddingProviderFromEnvironment,
  createHashEmbeddingProvider,
  createOpenAIEmbeddingProvider,
  DEFAULT_EMBEDDING_DIMENSIONS,
  type EmbeddingProvider,
  EmbeddingProviderError,
  embedChunkBatch,
  type OpenAIEmbeddingsFetch,
  roughTokenEstimate,
} from "../src";

type RecordedMetric = {
  /** Metric instrument kind recorded by the fake recorder. */
  readonly kind: "counter" | "histogram";
  /** Low-cardinality metric labels. */
  readonly labels?: TelemetryMetricOptions["labels"] | undefined;
  /** Metric name. */
  readonly name: string;
  /** Metric unit. */
  readonly unit?: string | undefined;
  /** Metric value. */
  readonly value: number;
};

type RecordedSpan = {
  /** Attributes attached when the span ended. */
  readonly endAttributes?: TelemetrySpanEndOptions["attributes"] | undefined;
  /** Error attached when the span ended. */
  readonly error?: unknown;
  /** Span name. */
  readonly name: string;
  /** Attributes attached when the span started. */
  readonly startAttributes?: TelemetrySpanOptions["attributes"] | undefined;
  /** Span status attached when the span ended. */
  readonly status?: TelemetrySpanEndOptions["status"] | undefined;
};

type RecordedOpenAIEmbeddingsFetchCall = {
  /** Fetch init used for the provider request. */
  readonly init?: RequestInit | undefined;
  /** URL passed to the fetch boundary. */
  readonly url: string;
};

type TestCodeChunkRow = {
  /** Stable chunk ID returned by the fake chunk query. */
  readonly chunkId: string;
  /** Immutable chunk content hash persisted with embeddings. */
  readonly contentHash: string;
  /** Last source line covered by the chunk. */
  readonly endLine: number;
  /** Importer-owned metadata containing optional source text. */
  readonly metadata: unknown;
  /** Repository-relative path used only to build provider input. */
  readonly path: string;
  /** First source line covered by the chunk. */
  readonly startLine: number;
  /** Optional symbol ID attached to the chunk. */
  readonly symbolId: string | null;
};

describe("createHashEmbeddingProvider", () => {
  it("matches the pgvector storage dimension by default", async () => {
    const provider = createHashEmbeddingProvider("text-embedding-3-small");
    const [vector] = await provider.embedTexts(["export const value = 1;"]);

    expect(provider.dimensions).toBe(DEFAULT_EMBEDDING_DIMENSIONS);
    expect(vector).toHaveLength(DEFAULT_EMBEDDING_DIMENSIONS);
  });
});

describe("createOpenAIEmbeddingProvider", () => {
  it("sends float embedding requests and returns vectors in input order", async () => {
    const calls: RecordedOpenAIEmbeddingsFetchCall[] = [];
    const provider = createOpenAIEmbeddingProvider({
      apiKey: "sk-test-openai-key",
      baseUrl: "https://provider.example/v1/",
      dimensions: 2,
      fetch: recordingOpenAIEmbeddingsFetch(calls, {
        data: [
          { embedding: [0.3, 0.4], index: 1 },
          { embedding: [0.1, 0.2], index: 0 },
        ],
      }),
      model: "text-embedding-3-small",
    });

    await expect(provider.embedTexts(["first", "second"])).resolves.toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);

    const call = requireFirstOpenAIEmbeddingsFetchCall(calls);
    expect(call.url).toBe("https://provider.example/v1/embeddings");
    expect(call.init).toMatchObject({
      headers: expect.objectContaining({
        Authorization: "Bearer sk-test-openai-key",
        "Content-Type": "application/json",
      }),
      method: "POST",
    });
    expect(openAIEmbeddingsRequestJsonBody(call)).toEqual({
      dimensions: 2,
      encoding_format: "float",
      input: ["first", "second"],
      model: "text-embedding-3-small",
    });
  });

  it("normalizes OpenAI embeddings HTTP errors without exposing provider bodies", async () => {
    const provider = createOpenAIEmbeddingProvider({
      apiKey: "sk-test-openai-key",
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "invalid_api_key",
              message: "raw provider message with sk-secret-value",
              type: "invalid_request_error",
            },
          }),
          {
            headers: { "x-request-id": "req_embedding_auth" },
            status: 401,
          },
        ),
      model: "text-embedding-3-small",
    });

    let caughtError: unknown;
    try {
      await provider.embedTexts(["first"]);
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(EmbeddingProviderError);
    expect(caughtError).toMatchObject({
      code: "provider_auth_failed",
      details: {
        errorCode: "invalid_api_key",
        errorType: "invalid_request_error",
        requestId: "req_embedding_auth",
        status: 401,
      },
      retryable: false,
    });
    expect(caughtError).not.toMatchObject({ message: expect.stringContaining("sk-secret-value") });
  });
});

describe("createEmbeddingProviderFromEnvironment", () => {
  it("creates the default local hash provider with the queued job model", async () => {
    const provider = createEmbeddingProviderFromEnvironment(
      {},
      { model: "text-embedding-3-small" },
    );
    const [vector] = await provider.embedTexts(["const value = 1;"]);

    expect(provider).toMatchObject({
      dimensions: DEFAULT_EMBEDDING_DIMENSIONS,
      model: "text-embedding-3-small",
    });
    expect(vector).toHaveLength(DEFAULT_EMBEDDING_DIMENSIONS);
  });

  it("uses explicit local provider dimensions from environment", () => {
    const provider = createEmbeddingProviderFromEnvironment({
      EMBEDDING_DIMENSIONS: "8",
      EMBEDDING_MODEL: "fake-code-embedding",
      EMBEDDING_PROVIDER: "fake",
    });

    expect(provider).toMatchObject({
      dimensions: 8,
      model: "fake-code-embedding",
    });
  });

  it("creates an OpenAI embedding provider from direct environment values", async () => {
    const provider = createEmbeddingProviderFromEnvironment({
      EMBEDDING_DIMENSIONS: "2",
      EMBEDDING_MODEL: "text-embedding-3-small",
      EMBEDDING_PROVIDER: "openai",
      OPENAI_API_KEY: "sk-test-openai-key",
    });

    expect(provider).toMatchObject({
      dimensions: 2,
      model: "text-embedding-3-small",
      providerId: "openai",
    });
  });

  it("rejects unsupported provider names", () => {
    expect(() => createEmbeddingProviderFromEnvironment({ EMBEDDING_PROVIDER: "bogus" })).toThrow(
      "Unsupported embedding provider: bogus",
    );
  });
});

describe("embedChunkBatch", () => {
  it("records product-safe embedding metrics and spans", async () => {
    const metrics: RecordedMetric[] = [];
    const spans: RecordedSpan[] = [];
    const payload = testEmbeddingPayload(["chunk_1", "chunk_empty", "chunk_missing"]);
    const db = createEmbeddingDatabaseStub({
      insertedChunkIds: ["chunk_1"],
      rows: [
        testCodeChunkRow("chunk_1", {
          metadata: {
            language: "typescript",
            text: "export const secretToken = process.env.SECRET_TOKEN;",
          },
          path: "src/secret.ts",
        }),
        testCodeChunkRow("chunk_empty", {
          metadata: { text: "   " },
          path: "src/empty.ts",
        }),
      ],
    });

    const result = await embedChunkBatch(payload, {
      db,
      metrics: createRecordingMetrics(metrics),
      provider: createHashEmbeddingProvider("text-embedding-3-small", 4, "hash"),
      traceContext: {
        traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
      },
      traces: createRecordingTraces(spans),
    });

    expect(result).toEqual({
      embeddedChunkCount: 1,
      skippedChunkIds: ["chunk_empty", "chunk_missing"],
    });
    expect(metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "counter",
          labels: {
            model_profile: "text-embedding-3-small",
            provider: "hash",
            status: "succeeded",
          },
          name: OBSERVABILITY_METRIC_NAMES.embeddingJobsTotal,
          value: 1,
        }),
        expect.objectContaining({
          kind: "histogram",
          labels: {
            model_profile: "text-embedding-3-small",
            provider: "hash",
            status: "succeeded",
          },
          name: OBSERVABILITY_METRIC_NAMES.embeddingBatchDurationMs,
          unit: "ms",
        }),
        expect.objectContaining({
          labels: {
            input_kind: "code_chunk",
            model_profile: "text-embedding-3-small",
            provider: "hash",
          },
          name: OBSERVABILITY_METRIC_NAMES.embeddingInputsTotal,
          value: 1,
        }),
        expect.objectContaining({
          labels: {
            model_profile: "text-embedding-3-small",
            provider: "hash",
          },
          name: OBSERVABILITY_METRIC_NAMES.embeddingTokensTotal,
        }),
      ]),
    );
    expect(spans).toEqual([
      expect.objectContaining({
        endAttributes: expect.objectContaining({
          "embedding.embedded_chunk_count": 1,
          "embedding.input_count": 1,
          "embedding.skipped_chunk_count": 2,
          "embedding.status": "succeeded",
        }),
        name: OBSERVABILITY_SPAN_NAMES.embeddingEmbedBatch,
        startAttributes: expect.objectContaining({
          "app.index_version_id": "idx_01HREVIEW",
          "app.repo_id": "repo_01HREVIEW",
          "embedding.model_profile": "text-embedding-3-small",
          "embedding.provider": "hash",
          "embedding.requested_chunk_count": 3,
        }),
        status: "ok",
      }),
    ]);
    expect(JSON.stringify(metrics)).not.toContain("src/secret.ts");
    expect(JSON.stringify(spans)).not.toContain("src/secret.ts");
    expect(JSON.stringify(spans)).not.toContain("SECRET_TOKEN");
  });

  it("records failed embedding telemetry when vector validation fails", async () => {
    const metrics: RecordedMetric[] = [];
    const spans: RecordedSpan[] = [];
    const provider = {
      dimensions: 2,
      embedTexts: async (texts) => texts.map(() => [1]),
      model: "text-embedding-3-small",
      providerId: "fake",
    } satisfies EmbeddingProvider;

    await expect(
      embedChunkBatch(testEmbeddingPayload(["chunk_1"]), {
        db: createEmbeddingDatabaseStub({
          rows: [testCodeChunkRow("chunk_1", { path: "src/private.ts" })],
        }),
        metrics: createRecordingMetrics(metrics),
        provider,
        traces: createRecordingTraces(spans),
      }),
    ).rejects.toThrow("Embedding provider returned 1 dimensions for vector 0; expected 2.");

    expect(metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          labels: {
            error_class: "provider_error",
            model_profile: "text-embedding-3-small",
            provider: "fake",
            status: "failed",
          },
          name: OBSERVABILITY_METRIC_NAMES.embeddingJobsTotal,
        }),
      ]),
    );
    expect(spans).toEqual([
      expect.objectContaining({
        endAttributes: expect.objectContaining({
          "embedding.error_class": "provider_error",
          "embedding.input_count": 1,
          "embedding.status": "failed",
        }),
        status: "error",
      }),
    ]);
    expect(JSON.stringify(metrics)).not.toContain("src/private.ts");
    expect(JSON.stringify(spans)).not.toContain("src/private.ts");
  });
});

describe("buildCodeChunkEmbeddingInput", () => {
  it("builds stable code chunk provider input with useful metadata", () => {
    const input = buildCodeChunkEmbeddingInput({
      chunkId: "chunk_1",
      endLine: 12,
      kind: "symbol",
      language: "typescript",
      path: "src/auth/session.ts",
      startLine: 4,
      symbolId: "sym_validateSession",
      text: "export function validateSession() {\n  return true;\n}",
    });

    expect(input).toMatchObject({
      inputId: "chunk_1",
      inputKind: "code_chunk",
      tokenEstimate: roughTokenEstimate(input.text),
      wasTruncated: false,
    });
    expect(input.text).toBe(
      [
        "language: typescript",
        "path: src/auth/session.ts",
        "symbol_id: sym_validateSession",
        "chunk_kind: symbol",
        "lines: 4-12",
        "",
        "export function validateSession() {\n  return true;\n}",
      ].join("\n"),
    );
    expect(input.inputHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("truncates oversized input while preserving the header and tail", () => {
    const input = buildCodeChunkEmbeddingInput(
      {
        chunkId: "chunk_large",
        endLine: 900,
        path: "src/large.ts",
        startLine: 1,
        text: `${"a".repeat(200)}\nTAIL_MARKER`,
      },
      { maxInputTokens: 40 },
    );

    expect(input.wasTruncated).toBe(true);
    expect(input.text).toContain("path: src/large.ts");
    expect(input.text).toContain("[...truncated...]");
    expect(input.text).toContain("TAIL_MARKER");
    expect(input.tokenEstimate).toBeLessThanOrEqual(40);
  });

  it("rejects empty chunk text", () => {
    expect(() =>
      buildCodeChunkEmbeddingInput({
        chunkId: "chunk_empty",
        endLine: 1,
        path: "src/empty.ts",
        startLine: 1,
        text: "   ",
      }),
    ).toThrow("Embedding input text cannot be empty.");
  });
});

describe("buildEmbeddingInputBatches", () => {
  it("splits provider requests by input count and token budget", () => {
    const inputs = [
      testInput("chunk_1", 10, 10),
      testInput("chunk_2", 10, 10),
      testInput("chunk_3", 10, 10),
      testInput("chunk_4", 60, 10),
    ];

    const batches = buildEmbeddingInputBatches(inputs, {
      maxCharsPerRequest: 1_000,
      maxInputsPerRequest: 2,
      maxTokensPerRequest: 50,
    });

    expect(batches.map((batch) => batch.map((input) => input.inputId))).toEqual([
      ["chunk_1", "chunk_2"],
      ["chunk_3"],
      ["chunk_4"],
    ]);
  });
});

/** Creates a fake OpenAI embeddings fetch that records request data. */
function recordingOpenAIEmbeddingsFetch(
  records: RecordedOpenAIEmbeddingsFetchCall[],
  body: unknown,
): OpenAIEmbeddingsFetch {
  return async (url, init) => {
    records.push({ ...(init ? { init } : {}), url: String(url) });

    return new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    });
  };
}

/** Returns the first recorded OpenAI embeddings fetch call or fails the test. */
function requireFirstOpenAIEmbeddingsFetchCall(
  calls: readonly RecordedOpenAIEmbeddingsFetchCall[],
): RecordedOpenAIEmbeddingsFetchCall {
  const call = calls[0];
  if (!call) {
    throw new Error("Expected at least one OpenAI embeddings fetch call.");
  }

  return call;
}

/** Parses the JSON request body from a recorded OpenAI embeddings fetch call. */
function openAIEmbeddingsRequestJsonBody(call: RecordedOpenAIEmbeddingsFetchCall): unknown {
  if (typeof call.init?.body !== "string") {
    throw new Error("Expected OpenAI embeddings request body to be a JSON string.");
  }

  return JSON.parse(call.init.body) as unknown;
}

/** Creates a minimal built embedding input for batch policy tests. */
function testInput(inputId: string, tokenEstimate: number, charCount: number): BuiltEmbeddingInput {
  return {
    inputHash: `sha256:${"a".repeat(64)}`,
    inputId,
    inputKind: "code_chunk",
    text: "x".repeat(charCount),
    tokenEstimate,
    wasTruncated: false,
  };
}

function testEmbeddingPayload(chunkIds: readonly string[]): EmbeddingBatchJobPayload {
  return {
    chunkIds: [...chunkIds],
    embeddingModel: "text-embedding-3-small",
    indexVersionId: "idx_01HREVIEW",
    repoId: "repo_01HREVIEW",
  };
}

function testCodeChunkRow(
  chunkId: string,
  overrides: Partial<TestCodeChunkRow> = {},
): TestCodeChunkRow {
  return {
    chunkId,
    contentHash: `sha256:${"b".repeat(64)}`,
    endLine: 4,
    metadata: { text: "export function run() { return true; }" },
    path: "src/index.ts",
    startLine: 1,
    symbolId: null,
    ...overrides,
  };
}

function createEmbeddingDatabaseStub(options: {
  /** Chunk rows returned by the fake initial chunk lookup. */
  readonly rows: readonly TestCodeChunkRow[];
  /** Chunk IDs returned by the fake embedding insert. */
  readonly insertedChunkIds?: readonly string[];
}): HeimdallDatabase {
  const insertedChunkIds = options.insertedChunkIds ?? options.rows.map((row) => row.chunkId);
  const tx = {
    insert: (_table: unknown) => ({
      values: (_values: unknown) => ({
        onConflictDoNothing: () => ({
          returning: async (_projection: unknown) =>
            insertedChunkIds.map((chunkId) => ({ chunkId })),
        }),
      }),
    }),
    select: (_projection: unknown) => ({
      from: (_table: unknown) => ({
        where: async (_condition: unknown) => [{ embeddedChunkCount: insertedChunkIds.length }],
      }),
    }),
    update: (_table: unknown) => ({
      set: (_values: unknown) => ({
        where: async (_condition: unknown) => undefined,
      }),
    }),
  };
  const db = {
    select: () => ({
      from: (_table: unknown) => ({
        where: async (_condition: unknown) => options.rows,
      }),
    }),
    transaction: async (callback: (transaction: unknown) => Promise<unknown>) => callback(tx),
  };

  return db as unknown as HeimdallDatabase;
}

function createRecordingMetrics(records: RecordedMetric[]): TelemetryMetricRecorder {
  return {
    count: (name, options) => {
      records.push({
        kind: "counter",
        labels: options?.labels,
        name,
        unit: options?.unit,
        value: options?.value ?? 1,
      });
    },
    gauge: () => undefined,
    histogram: (name, value, options) => {
      records.push({
        kind: "histogram",
        labels: options?.labels,
        name,
        unit: options?.unit,
        value,
      });
    },
  };
}

function createRecordingTraces(records: RecordedSpan[]): TelemetrySpanRecorder {
  return {
    startSpan: (name, options) => ({
      end: (endOptions = {}) => {
        records.push({
          endAttributes: endOptions.attributes,
          error: endOptions.error,
          name,
          startAttributes: options?.attributes,
          status: endOptions.status,
        });
        return undefined;
      },
    }),
  };
}
