import { validPullRequestSnapshotFixture } from "@repo/contracts/fixtures/pull-request.fixture";
import { createStaticRelevantMemoryRetriever, type MemoryFact } from "@repo/memory";
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
import { type RetrievalIndex, retrieveContext } from "../src/index";

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

describe("retrieveContext", () => {
  it("returns diff context with an explicit missing-index fallback", async () => {
    const bundle = await retrieveContext({
      reviewRunId: "rrn_01HREVIEW",
      snapshot: validPullRequestSnapshotFixture,
      indexAvailable: false,
      timestamp: "2026-05-05T00:00:00.000Z",
    });

    expect(bundle.metadata).toMatchObject({
      retrievalMode: "diff_fallback",
      indexAvailable: false,
    });
    expect(bundle.items[0]).toMatchObject({
      kind: "repo_rule",
      title: "Repository index unavailable",
    });
    expect(bundle.items.some((item) => item.kind === "diff")).toBe(true);
  });

  it("records product-safe retrieval metrics and spans", async () => {
    const metrics: RecordedMetric[] = [];
    const spans: RecordedSpan[] = [];
    const bundle = await retrieveContext({
      reviewRunId: "rrn_01HREVIEW",
      snapshot: validPullRequestSnapshotFixture,
      indexAvailable: false,
      metrics: createRecordingMetrics(metrics),
      reviewMode: "Strict Mode",
      timestamp: "2026-05-05T00:00:00.000Z",
      traces: createRecordingTraces(spans),
    });

    expect(bundle.items.some((item) => item.kind === "diff")).toBe(true);
    expect(metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "counter",
          labels: {
            review_mode: "strict_mode",
            status: "succeeded",
          },
          name: OBSERVABILITY_METRIC_NAMES.retrievalRequestsTotal,
        }),
        expect.objectContaining({
          kind: "histogram",
          labels: {
            review_mode: "strict_mode",
            status: "succeeded",
          },
          name: OBSERVABILITY_METRIC_NAMES.retrievalDurationMs,
          unit: "ms",
        }),
        expect.objectContaining({
          labels: { source_type: "diff" },
          name: OBSERVABILITY_METRIC_NAMES.retrievalSourceCandidatesTotal,
        }),
        expect.objectContaining({
          labels: { item_type: "diff", source_type: "diff" },
          name: OBSERVABILITY_METRIC_NAMES.retrievalContextItemsTotal,
        }),
        expect.objectContaining({
          labels: { item_type: "diff", source_type: "diff" },
          name: OBSERVABILITY_METRIC_NAMES.retrievalContextTokens,
        }),
      ]),
    );
    expect(spans).toEqual([
      expect.objectContaining({
        endAttributes: expect.objectContaining({
          "retrieval.status": "succeeded",
        }),
        name: OBSERVABILITY_SPAN_NAMES.retrievalBuildContext,
        startAttributes: expect.objectContaining({
          "app.review_run_id": "rrn_01HREVIEW",
          "retrieval.review_mode": "strict_mode",
        }),
        status: "ok",
      }),
    ]);
    expect(JSON.stringify(metrics)).not.toContain("src/index.ts");
    expect(JSON.stringify(spans)).not.toContain("src/index.ts");
  });

  it("validates context bundles against the shared runtime contract", async () => {
    await expect(
      retrieveContext({
        reviewRunId: "invalid-review-run-id",
        snapshot: validPullRequestSnapshotFixture,
        indexAvailable: false,
        timestamp: "2026-05-05T00:00:00.000Z",
      }),
    ).rejects.toThrow(/ContextBundle/u);
  });

  it("records failed retrieval telemetry when validation fails", async () => {
    const metrics: RecordedMetric[] = [];
    const spans: RecordedSpan[] = [];

    await expect(
      retrieveContext({
        reviewRunId: "invalid-review-run-id",
        snapshot: validPullRequestSnapshotFixture,
        indexAvailable: false,
        metrics: createRecordingMetrics(metrics),
        timestamp: "2026-05-05T00:00:00.000Z",
        traces: createRecordingTraces(spans),
      }),
    ).rejects.toThrow(/ContextBundle/u);

    expect(metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          labels: {
            error_class: "validation_error",
            review_mode: "standard",
            status: "failed",
          },
          name: OBSERVABILITY_METRIC_NAMES.retrievalRequestsTotal,
        }),
      ]),
    );
    expect(spans).toEqual([
      expect.objectContaining({
        endAttributes: expect.objectContaining({
          "retrieval.error_class": "validation_error",
          "retrieval.status": "failed",
        }),
        status: "error",
      }),
    ]);
  });

  it("adds relevant memory facts as explicit context items", async () => {
    const memoryFact = {
      id: "mem_context",
      orgId: "org_1",
      repoId: validPullRequestSnapshotFixture.repoId,
      kind: "testing_convention",
      content: "Generated clients under src/generated are covered by contract tests.",
      normalizedContent: "generated clients under src/generated are covered by contract tests.",
      scope: {
        level: "repo",
        orgId: "org_1",
        repoId: validPullRequestSnapshotFixture.repoId,
      },
      appliesTo: {
        languages: ["typescript"],
        categories: ["test_coverage"],
      },
      sourceKind: "command",
      trustLevel: "explicit_maintainer",
      confidence: 0.93,
      status: "active",
      priority: 450,
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-05T00:00:00.000Z",
    } satisfies MemoryFact;

    const bundle = await retrieveContext({
      reviewRunId: "rrn_01HREVIEW",
      snapshot: validPullRequestSnapshotFixture,
      indexAvailable: false,
      memory: {
        orgId: "org_1",
        retriever: createStaticRelevantMemoryRetriever([memoryFact]),
        findingCategories: ["test_coverage"],
        maxFacts: 3,
        maxTokens: 200,
      },
      timestamp: "2026-05-05T00:00:00.000Z",
    });

    expect(bundle.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "memory_fact",
          source: "memory",
          text: expect.stringContaining("Generated clients under src/generated"),
        }),
      ]),
    );
    expect(bundle.metadata).toMatchObject({
      memory: {
        includedFactIds: ["mem_context"],
        trace: [expect.objectContaining({ included: true, memoryFactId: "mem_context" })],
      },
    });
  });

  it("adds index-backed same-file, symbol, test, full-text, and similar context", async () => {
    const index: RetrievalIndex = {
      indexVersionId: "idx_123",
      getSameFileChunks: async () => [
        {
          chunkId: "chunk_same",
          symbolId: "sym_same",
          path: "src/index.ts",
          startLine: 1,
          endLine: 3,
          language: "typescript",
          contentHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          text: "export function run() {}",
          tokenEstimate: 6,
        },
      ],
      getSymbolsForFiles: async () => [
        {
          symbolId: "sym_same",
          fileId: "file_same",
          path: "src/index.ts",
          name: "run",
          kind: "function",
          startLine: 1,
          endLine: 1,
        },
      ],
      getRelatedChunks: async () => [],
      getDependenciesForFiles: async () => [
        {
          dependencyId: "dep_hono",
          manifestPath: "package.json",
          packageManager: "pnpm",
          name: "hono",
          versionSpec: "^4.0.0",
          dependencyType: "prod",
        },
      ],
      getRoutesForFiles: async () => [
        {
          routeId: "route_user",
          path: "src/index.ts",
          language: "typescript",
          routePattern: "/api/users/:id",
          methods: ["GET"],
          handlerSymbolId: "sym_same",
          startLine: 1,
          endLine: 3,
          framework: "hono",
          confidence: 0.95,
        },
      ],
      getRelatedTestChunks: async () => [
        {
          chunkId: "chunk_test",
          path: "src/index.test.ts",
          startLine: 1,
          endLine: 5,
          language: "typescript",
          contentHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          text: "it('runs', () => run());",
          tokenEstimate: 6,
        },
      ],
      searchFullTextChunks: async () => [
        {
          chunkId: "chunk_full_text",
          path: "src/search.ts",
          startLine: 2,
          endLine: 4,
          language: "typescript",
          contentHash: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
          text: "export function searchRun() { return run(); }",
          tokenEstimate: 10,
          score: 0.8,
          searchSource: "full_text_search",
        },
      ],
      searchSimilarChunks: async () => [
        {
          chunkId: "chunk_similar",
          path: "src/other.ts",
          startLine: 1,
          endLine: 2,
          language: "typescript",
          contentHash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          text: "export function other() {}",
          tokenEstimate: 6,
          score: 1,
          searchSource: "vector_search",
        },
      ],
    };

    const bundle = await retrieveContext({
      reviewRunId: "rrn_01HREVIEW",
      snapshot: validPullRequestSnapshotFixture,
      index,
      timestamp: "2026-05-05T00:00:00.000Z",
    });

    expect(bundle.metadata).toMatchObject({
      retrievalMode: "indexed_context",
      indexAvailable: true,
      indexVersionId: "idx_123",
    });
    expect(bundle.items.map((item) => item.kind)).toEqual(
      expect.arrayContaining([
        "same_file_context",
        "changed_symbol",
        "dependency",
        "config",
        "related_test",
        "similar_pattern",
        "diff",
      ]),
    );
    expect(bundle.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "dependency",
          text: expect.stringContaining("Dependency: hono"),
        }),
        expect.objectContaining({
          kind: "config",
          text: expect.stringContaining("Route: GET /api/users/:id"),
        }),
        expect.objectContaining({
          kind: "similar_pattern",
          source: "full_text_search",
          snippet: expect.objectContaining({ path: "src/search.ts" }),
        }),
        expect.objectContaining({
          kind: "similar_pattern",
          source: "vector_search",
          snippet: expect.objectContaining({ path: "src/other.ts" }),
        }),
      ]),
    );
  });

  it("keeps required context when optional indexed retrievers fail", async () => {
    const index: RetrievalIndex = {
      indexVersionId: "idx_123",
      getSameFileChunks: async () => [
        {
          chunkId: "chunk_same",
          symbolId: "sym_same",
          path: "src/index.ts",
          startLine: 1,
          endLine: 3,
          language: "typescript",
          contentHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          text: "export function run() {}",
          tokenEstimate: 6,
        },
      ],
      getSymbolsForFiles: async () => [],
      getRelatedChunks: async () => {
        throw new Error("Graph retriever unavailable.");
      },
      getRelatedTestChunks: async () => [],
      searchFullTextChunks: async () => {
        throw new Error("Full-text retriever unavailable.");
      },
      searchSimilarChunks: async () => {
        throw new Error("Semantic retriever unavailable.");
      },
    };

    const bundle = await retrieveContext({
      reviewRunId: "rrn_01HREVIEW",
      snapshot: validPullRequestSnapshotFixture,
      index,
      timestamp: "2026-05-05T00:00:00.000Z",
    });

    expect(bundle.items.map((item) => item.kind)).toEqual(
      expect.arrayContaining(["same_file_context", "diff"]),
    );
    expect(bundle.metadata).toMatchObject({
      warnings: [
        expect.objectContaining({ code: "graph_retrieval_failed", retriever: "symbol-graph" }),
        expect.objectContaining({
          code: "full_text_retrieval_failed",
          retriever: "full-text-search",
        }),
        expect.objectContaining({
          code: "semantic_retrieval_failed",
          retriever: "semantic-search",
        }),
      ],
    });
  });
});

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
