import { createHash } from "node:crypto";
import {
  type ChangedSymbol,
  type ChunkRecord,
  ContextBundleSchema,
  type DependencyRecord,
  type FindingCategory,
  parseWithSchema,
  type RepoRule,
  type RouteRecord,
  type SymbolKind,
  type SymbolRecord,
} from "@repo/contracts";
import type { ChangedFile } from "@repo/contracts/pull-request/diff";
import type { PullRequestSnapshot } from "@repo/contracts/pull-request/pull-request";
import type { CodeSnippet, ContextBundle, ContextItem } from "@repo/contracts/review/context";
import { CodeIntelligenceRepository, EmbeddingRepository, type HeimdallDatabase } from "@repo/db";
import {
  formatMemoryFactForContext,
  type MemoryFact,
  type RelevantMemoryRetriever,
  type RelevantMemoryTraceEntry,
} from "@repo/memory";
import {
  classifyTelemetryError,
  OBSERVABILITY_METRIC_NAMES,
  OBSERVABILITY_SPAN_NAMES,
  type TelemetryMetricRecorder,
  type TelemetrySpanHandle,
  type TelemetrySpanRecorder,
} from "@repo/observability";
import { matchesAnyPathPattern } from "@repo/rules";

/** Indexed chunk shape consumed by retrieval. */
export type RetrievalChunk = {
  /** Chunk ID. */
  readonly chunkId: string;
  /** Optional owning symbol ID. */
  readonly symbolId?: string | null;
  /** Repository path. */
  readonly path: string;
  /** 1-based start line. */
  readonly startLine: number;
  /** 1-based end line. */
  readonly endLine: number;
  /** Chunk language. */
  readonly language: string;
  /** Chunk content hash. */
  readonly contentHash: string;
  /** Chunk text. */
  readonly text: string;
  /** Estimated token count. */
  readonly tokenEstimate: number;
  /** Optional score from vector search. */
  readonly score?: number;
  /** Optional source for search-backed chunks. */
  readonly searchSource?: "full_text_search" | "vector_search";
  /** Optional graph direction relative to the changed symbol. */
  readonly relationKind?: "caller" | "callee";
};

/** Indexed symbol shape consumed by retrieval. */
export type RetrievalSymbol = {
  /** Symbol ID. */
  readonly symbolId: string;
  /** File ID. */
  readonly fileId: string;
  /** Path containing the symbol. */
  readonly path: string;
  /** Symbol name. */
  readonly name: string;
  /** Symbol qualified name when the indexer provides one. */
  readonly qualifiedName?: string | null;
  /** Symbol kind. */
  readonly kind: string;
  /** Symbol language. */
  readonly language: string;
  /** 1-based start line. */
  readonly startLine: number;
  /** 1-based end line. */
  readonly endLine: number;
};

/** Dependency metadata imported from package manifests. */
export type RetrievalDependency = {
  /** Stable imported dependency ID. */
  readonly dependencyId: string;
  /** Manifest path that declared the dependency. */
  readonly manifestPath: string;
  /** Package manager or ecosystem when known. */
  readonly packageManager?: string | null;
  /** Dependency package or module name. */
  readonly name: string;
  /** Declared version constraint when known. */
  readonly versionSpec?: string | null;
  /** Resolved version when known. */
  readonly resolvedVersion?: string | null;
  /** Dependency category when known. */
  readonly dependencyType?: string | null;
};

/** Route metadata imported from framework route declarations. */
export type RetrievalRoute = {
  /** Stable imported route ID. */
  readonly routeId: string;
  /** Source path that declared the route. */
  readonly path: string;
  /** Route source language. */
  readonly language: string;
  /** Framework route pattern. */
  readonly routePattern: string;
  /** HTTP methods declared by the route record. */
  readonly methods: readonly string[];
  /** Handler symbol ID when the indexer could resolve it. */
  readonly handlerSymbolId?: string | null;
  /** 1-based start line when known. */
  readonly startLine?: number | null;
  /** 1-based end line when known. */
  readonly endLine?: number | null;
  /** Framework that owns the route when known. */
  readonly framework?: string | null;
  /** Indexer confidence for the route extraction. */
  readonly confidence: number;
};

/** Query interface over an imported repository index. */
export type RetrievalIndex = {
  /** Imported index version ID. */
  readonly indexVersionId: string;
  /** Returns chunks from the same files as changed paths. */
  readonly getSameFileChunks: (paths: readonly string[]) => Promise<readonly RetrievalChunk[]>;
  /** Returns symbols that overlap changed paths. */
  readonly getSymbolsForFiles: (paths: readonly string[]) => Promise<readonly RetrievalSymbol[]>;
  /** Returns graph-related chunks for changed symbols. */
  readonly getRelatedChunks: (symbolIds: readonly string[]) => Promise<readonly RetrievalChunk[]>;
  /** Returns dependency metadata for changed package manifests. */
  readonly getDependenciesForFiles?: (
    paths: readonly string[],
  ) => Promise<readonly RetrievalDependency[]>;
  /** Returns framework route metadata for changed files. */
  readonly getRoutesForFiles?: (paths: readonly string[]) => Promise<readonly RetrievalRoute[]>;
  /** Returns likely related test chunks. */
  readonly getRelatedTestChunks: (paths: readonly string[]) => Promise<readonly RetrievalChunk[]>;
  /** Returns full-text matches for changed text when no embedding search is required. */
  readonly searchFullTextChunks?: (
    query: string,
    limit: number,
  ) => Promise<readonly RetrievalChunk[]>;
  /** Returns semantically similar chunks for changed text. */
  readonly searchSimilarChunks: (
    query: string,
    limit: number,
  ) => Promise<readonly RetrievalChunk[]>;
};

/** Input used to retrieve review context for a pull request snapshot. */
export type RetrieveContextInput = {
  /** Stable review run ID that owns the context bundle. */
  readonly reviewRunId: string;
  /** Pull request snapshot used to build diff-grounded context. */
  readonly snapshot: PullRequestSnapshot;
  /** Whether a repository index is available for richer retrieval. */
  readonly indexAvailable?: boolean;
  /** Optional imported index query interface for index-backed retrieval. */
  readonly index?: RetrievalIndex;
  /** Maximum estimated tokens allowed in the returned context bundle. */
  readonly maxTokens?: number;
  /** Optional relevant-memory retrieval for team facts and preferences. */
  readonly memory?: RetrieveMemoryContextOptions | undefined;
  /** Optional repository rules to expose as review context. */
  readonly rules?: RetrieveRepoRuleContextOptions | undefined;
  /** Optional metric recorder for product-safe aggregate retrieval telemetry. */
  readonly metrics?: TelemetryMetricRecorder | undefined;
  /** Low-cardinality review mode label for aggregate retrieval metrics. */
  readonly reviewMode?: string | undefined;
  /** Timestamp used for deterministic tests. */
  readonly timestamp?: string;
  /** Optional span recorder for product-safe retrieval spans. */
  readonly traces?: TelemetrySpanRecorder | undefined;
};

/** Optional memory retrieval configuration for a context bundle. */
export type RetrieveMemoryContextOptions = {
  /** Organization ID for memory scoping. */
  readonly orgId: string;
  /** Relevant memory retriever implementation. */
  readonly retriever: RelevantMemoryRetriever;
  /** Maximum memory facts to add to the context bundle. */
  readonly maxFacts?: number | undefined;
  /** Maximum estimated tokens for memory facts. */
  readonly maxTokens?: number | undefined;
  /** Optional expected finding categories used to rank relevant memory. */
  readonly findingCategories?: readonly FindingCategory[] | undefined;
};

/** Optional repository-rule retrieval configuration for a context bundle. */
export type RetrieveRepoRuleContextOptions = {
  /** Active or candidate repository rules to evaluate for context inclusion. */
  readonly rules: readonly RepoRule[];
  /** Maximum matching rules to add to the context bundle. */
  readonly maxRules?: number | undefined;
};

/** Non-fatal retrieval issue recorded on the context bundle metadata. */
export type RetrievalWarning = {
  /** Retriever that failed or degraded. */
  readonly retriever: string;
  /** Stable warning code for dashboards and tests. */
  readonly code: string;
  /** Product-safe warning message. */
  readonly message: string;
};

/** Items and warnings produced by index-backed retrieval. */
type IndexedRetrievalResult = {
  /** Context items produced by successful indexed retrievers. */
  readonly items: readonly ContextItem[];
  /** Changed symbols detected from diff lines and imported symbols. */
  readonly changedSymbols: readonly ChangedSymbol[];
  /** Non-fatal warnings from optional indexed retrievers. */
  readonly warnings: readonly RetrievalWarning[];
};

/** Selected and dropped items produced by token-budget packing. */
type PackedContextItems = {
  /** Lower-priority context items excluded by the token budget. */
  readonly droppedItems: readonly ContextItem[];
  /** Context items selected for the final bundle. */
  readonly items: readonly ContextItem[];
};

/** Context items after deterministic rank fusion and duplicate merging. */
type RankedContextItems = {
  /** Ranked and merged context items. */
  readonly items: readonly ContextItem[];
  /** Product-safe ranking trace for bundle metadata and replay inspection. */
  readonly trace: RetrievalRankingTrace;
};

/** Product-safe ranking trace recorded before token-budget packing. */
type RetrievalRankingTrace = {
  /** Raw candidate count before duplicate merging. */
  readonly candidateItemCount: number;
  /** Candidates removed by merge-key dedupe. */
  readonly duplicateCandidateCount: number;
  /** RRF constant used to dampen lower-ranked sources. */
  readonly k: number;
  /** Candidate count after duplicate merging. */
  readonly mergedItemCount: number;
  /** Ranked item trace rows before token-budget packing. */
  readonly items: readonly RetrievalRankingTraceItem[];
  /** Stable ranking strategy name. */
  readonly strategy: "weighted_reciprocal_rank_fusion_v1";
};

/** Product-safe trace row for one ranked context item. */
type RetrievalRankingTraceItem = {
  /** Stable context item ID. */
  readonly contextItemId: string;
  /** Original context item kind. */
  readonly kind: ContextItem["kind"];
  /** Duplicate source item IDs merged into this item. */
  readonly mergedFrom?: readonly string[] | undefined;
  /** Packing priority retained on the context item. */
  readonly priority: number;
  /** Product-safe inclusion reason from item provenance. */
  readonly reason: string;
  /** Rank position after fusion and domain adjustments. */
  readonly rank: number;
  /** Retriever that produced the selected primary item. */
  readonly retriever: string;
  /** Normalized rank-fusion score. */
  readonly score: number;
  /** Primary context item source. */
  readonly source: ContextItem["source"];
  /** Ranked retrieval source types that contributed to this item. */
  readonly sourceTypes: readonly string[];
};

/** Items and trace produced by relevant memory retrieval. */
type MemoryRetrievalResult = {
  /** Context items produced from relevant memory facts. */
  readonly items: readonly ContextItem[];
  /** Memory fact IDs included before final bundle packing. */
  readonly factIds: readonly string[];
  /** Product-safe memory relevance trace. */
  readonly trace: readonly RelevantMemoryTraceEntry[];
};

/** Product-safe trace entry for repository rule context selection. */
export type RepoRuleRetrievalTraceEntry = {
  /** Repository rule evaluated by retrieval. */
  readonly ruleId: string;
  /** Whether the rule was selected before final context packing. */
  readonly included: boolean;
  /** Stable reason for the rule selection result. */
  readonly reason: string;
  /** Changed paths that matched the rule, when applicable. */
  readonly matchedPaths?: readonly string[] | undefined;
  /** Changed languages that matched the rule, when applicable. */
  readonly matchedLanguages?: readonly string[] | undefined;
  /** Pull request labels that matched the rule, when applicable. */
  readonly matchedLabels?: readonly string[] | undefined;
};

/** Items and trace produced by repository rule retrieval. */
type RepoRuleRetrievalResult = {
  /** Context items produced from relevant repository rules. */
  readonly items: readonly ContextItem[];
  /** Rule IDs selected before final bundle packing. */
  readonly ruleIds: readonly string[];
  /** Product-safe rule relevance trace. */
  readonly trace: readonly RepoRuleRetrievalTraceEntry[];
};

type RetrievalTelemetryStatus = "failed" | "succeeded";

type RetrievalTelemetryState = {
  /** Low-cardinality labels shared by request and duration metrics. */
  readonly labels: Readonly<{
    readonly review_mode: string;
  }>;
  /** Monotonic start time used for duration metrics. */
  readonly startedAtMs: number;
  /** Product-safe retrieval span handle. */
  readonly span: TelemetrySpanHandle | undefined;
};

/** RRF constant used by the deterministic retrieval ranker. */
const RANK_FUSION_K = 60;

/** Maximum item trace rows to store in bundle metadata. */
const RANKING_TRACE_ITEM_LIMIT = 100;

/** Source weights for deterministic retrieval rank fusion. */
const RANK_FUSION_SOURCE_WEIGHTS: Readonly<Record<string, number>> = {
  changed_symbol: 2.8,
  config: 1.7,
  dependency_manifest: 1.7,
  diff: 3,
  direct_callee: 2.2,
  direct_caller: 2.4,
  documentation: 1,
  lexical_match: 1.4,
  memory_fact: 2.3,
  related_test: 1.9,
  repo_rule: 2.6,
  same_file: 2.5,
  semantic_match: 1.2,
  static_analysis: 2,
};

/** Retrieves a compact context bundle, falling back to diff context when indexes are missing. */
export async function retrieveContext(input: RetrieveContextInput): Promise<ContextBundle> {
  const telemetry = startRetrievalTelemetry(input);
  const maxTokens = input.maxTokens ?? 8000;
  const timestamp = input.timestamp ?? new Date().toISOString();

  try {
    const diffItems = input.snapshot.changedFiles.flatMap((file) => contextItemsForFile(file));
    const fallbackChangedSymbols = changedSymbolsFromDiff(input.snapshot);
    const indexedResult = input.index
      ? await retrieveIndexedItems({ ...input, index: input.index }, diffItems)
      : { changedSymbols: fallbackChangedSymbols, items: [], warnings: [] };
    const memoryResult = input.memory
      ? await retrieveMemoryItems({ ...input, memory: input.memory }, timestamp)
      : { factIds: [], items: [], trace: [] };
    const ruleResult = input.rules
      ? retrieveRepoRuleItems({ ...input, rules: input.rules }, timestamp)
      : { items: [], ruleIds: [], trace: [] };
    const candidateItems =
      input.indexAvailable === false || !input.index
        ? [...ruleResult.items, ...memoryResult.items, ...withFallbackRule(diffItems)]
        : [...ruleResult.items, ...memoryResult.items, ...indexedResult.items, ...diffItems];
    const rankedItems = rankAndMergeContextItems(candidateItems, input.snapshot.changedFiles);
    const packedItems = packItems(rankedItems.items, maxTokens);
    const items = packedItems.items;
    const warnings = retrievalWarnings(indexedResult.warnings, packedItems);

    const bundle = parseWithSchema("ContextBundle", ContextBundleSchema, {
      schemaVersion: "context_bundle.v1",
      contextBundleId: stableId("ctx", [
        input.reviewRunId,
        input.snapshot.snapshotId,
        input.indexAvailable === false ? "diff-fallback" : "indexed",
        ruleResult.ruleIds.join(","),
        memoryResult.factIds.join(","),
      ]),
      reviewRunId: input.reviewRunId,
      repoId: input.snapshot.repoId,
      pullRequestSnapshotId: input.snapshot.snapshotId,
      baseSha: input.snapshot.baseSha,
      headSha: input.snapshot.headSha,
      changedFiles: input.snapshot.changedFiles,
      changedSymbols: indexedResult.changedSymbols,
      items: [...items],
      tokenBudget: {
        maxTokens,
        estimatedTokens: items.reduce((total, item) => total + item.tokenEstimate, 0),
      },
      createdAt: timestamp,
      metadata: {
        retrievalMode: input.index ? "indexed_context" : "diff_fallback",
        indexAvailable: Boolean(input.index),
        ...(input.index ? { indexVersionId: input.index.indexVersionId } : {}),
        ...(packedItems.droppedItems.length > 0
          ? { packing: packingSummary(candidateItems, packedItems) }
          : {}),
        ranking: rankingSummary(rankedItems.trace, packedItems),
        ...(memoryResult.trace.length > 0
          ? {
              memory: {
                includedFactIds: memoryResult.factIds,
                trace: memoryResult.trace,
              },
            }
          : {}),
        ...(ruleResult.trace.length > 0
          ? {
              rules: {
                includedRuleIds: ruleResult.ruleIds,
                trace: ruleResult.trace,
              },
            }
          : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
      },
    });
    finishRetrievalTelemetry(input.metrics, telemetry, {
      bundle,
      candidateItems,
      status: "succeeded",
    });
    return bundle;
  } catch (error) {
    finishRetrievalTelemetry(input.metrics, telemetry, { error, status: "failed" });
    throw error;
  }
}

/** Starts retrieval telemetry with only product-safe span attributes. */
function startRetrievalTelemetry(input: RetrieveContextInput): RetrievalTelemetryState {
  const labels = { review_mode: normalizeRetrievalLabel(input.reviewMode, "standard") };
  const span = input.traces?.startSpan(OBSERVABILITY_SPAN_NAMES.retrievalBuildContext, {
    attributes: {
      "app.repo_id": input.snapshot.repoId,
      "app.review_run_id": input.reviewRunId,
      "retrieval.changed_file_count": input.snapshot.changedFiles.length,
      "retrieval.index_available": Boolean(input.index),
      "retrieval.review_mode": labels.review_mode,
    },
  });

  return {
    labels,
    span,
    startedAtMs: Date.now(),
  };
}

/** Ends retrieval telemetry and emits bounded aggregate metrics. */
function finishRetrievalTelemetry(
  metrics: TelemetryMetricRecorder | undefined,
  telemetry: RetrievalTelemetryState,
  input: {
    /** Retrieved context bundle, when retrieval succeeded. */
    readonly bundle?: ContextBundle | undefined;
    /** Candidate context items considered before final budget packing. */
    readonly candidateItems?: readonly ContextItem[] | undefined;
    /** Error raised by retrieval, when retrieval failed. */
    readonly error?: unknown;
    /** Final retrieval status. */
    readonly status: RetrievalTelemetryStatus;
  },
): void {
  const durationMs = Date.now() - telemetry.startedAtMs;
  const labels = {
    ...telemetry.labels,
    ...(input.error === undefined ? {} : { error_class: classifyTelemetryError(input.error) }),
    status: input.status,
  };

  metrics?.count(OBSERVABILITY_METRIC_NAMES.retrievalRequestsTotal, { labels });
  metrics?.histogram(OBSERVABILITY_METRIC_NAMES.retrievalDurationMs, Math.max(0, durationMs), {
    labels,
    unit: "ms",
  });

  if (input.candidateItems) {
    recordContextItemCounts(
      metrics,
      OBSERVABILITY_METRIC_NAMES.retrievalSourceCandidatesTotal,
      input.candidateItems,
      "source",
    );
  }
  if (input.bundle) {
    recordContextItemCounts(
      metrics,
      OBSERVABILITY_METRIC_NAMES.retrievalContextItemsTotal,
      input.bundle.items,
      "kind_and_source",
    );
    recordContextTokenCounts(metrics, input.bundle.items);
  }

  telemetry.span?.end({
    ...(input.error === undefined ? {} : { error: input.error }),
    attributes: {
      ...(input.bundle
        ? {
            "retrieval.context_item_count": input.bundle.items.length,
            "retrieval.context_tokens": input.bundle.tokenBudget.estimatedTokens,
          }
        : {}),
      ...(input.candidateItems
        ? { "retrieval.source_candidate_count": input.candidateItems.length }
        : {}),
      ...(input.error === undefined
        ? {}
        : { "retrieval.error_class": classifyTelemetryError(input.error) }),
      "retrieval.status": input.status,
    },
    status: input.status === "succeeded" ? "ok" : "error",
  });
}

/** Records context item count metrics grouped by safe source and optional item type. */
function recordContextItemCounts(
  metrics: TelemetryMetricRecorder | undefined,
  name: string,
  items: readonly ContextItem[],
  mode: "source" | "kind_and_source",
): void {
  for (const [key, count] of groupedContextItemCounts(items, mode)) {
    metrics?.count(name, {
      labels: contextItemMetricLabels(key),
      value: count,
    });
  }
}

/** Records context token count metrics grouped by safe source and item type. */
function recordContextTokenCounts(
  metrics: TelemetryMetricRecorder | undefined,
  items: readonly ContextItem[],
): void {
  const tokensByKey = new Map<string, number>();
  for (const item of items) {
    const key = `${normalizeRetrievalLabel(item.kind, "unknown")}|${normalizeRetrievalLabel(
      item.source,
      "unknown",
    )}`;
    tokensByKey.set(key, (tokensByKey.get(key) ?? 0) + item.tokenEstimate);
  }

  for (const [key, tokenCount] of tokensByKey) {
    metrics?.count(OBSERVABILITY_METRIC_NAMES.retrievalContextTokens, {
      labels: contextItemMetricLabels(key),
      value: tokenCount,
    });
  }
}

/** Groups context item counts by source or by item type and source. */
function groupedContextItemCounts(
  items: readonly ContextItem[],
  mode: "source" | "kind_and_source",
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const source = normalizeRetrievalLabel(item.source, "unknown");
    const key =
      mode === "source"
        ? `|${source}`
        : `${normalizeRetrievalLabel(item.kind, "unknown")}|${source}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** Converts a grouped context item metric key into low-cardinality labels. */
function contextItemMetricLabels(
  key: string,
): Readonly<Record<"item_type" | "source_type", string>> | Readonly<Record<"source_type", string>> {
  const [itemType, sourceType] = key.split("|", 2);
  if (itemType) {
    return { item_type: itemType, source_type: sourceType ?? "unknown" };
  }

  return { source_type: sourceType ?? "unknown" };
}

/** Normalizes bounded retrieval telemetry label values. */
function normalizeRetrievalLabel(value: string | undefined, fallback: string): string {
  const normalized = value
    ?.trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9_.-]+/gu, "_")
    .replaceAll(/^_+|_+$/gu, "")
    .slice(0, 80);

  return normalized && normalized.length > 0 ? normalized : fallback;
}

/** Creates a Drizzle-backed retrieval index over imported chunk, symbol, and edge tables. */
export function createDatabaseRetrievalIndex(options: {
  /** Database used to query imported index tables. */
  readonly db: HeimdallDatabase;
  /** Imported index version ID. */
  readonly indexVersionId: string;
  /** Optional query embedder used for pgvector similarity search. */
  readonly embedQuery?: (query: string) => Promise<readonly number[]>;
  /** Embedding model to use for vector search rows. */
  readonly embeddingModel?: string;
}): RetrievalIndex {
  const codeIntelligenceRepository = new CodeIntelligenceRepository(options.db);
  const embeddingRepository = new EmbeddingRepository(options.db);

  return {
    indexVersionId: options.indexVersionId,
    getSameFileChunks: async (paths) =>
      (
        await codeIntelligenceRepository.listChunksForPaths({
          indexVersionId: options.indexVersionId,
          paths,
        })
      ).map(toRetrievalChunk),
    getSymbolsForFiles: async (paths) =>
      (
        await codeIntelligenceRepository.listSymbolsForPaths({
          indexVersionId: options.indexVersionId,
          paths,
        })
      ).map(toRetrievalSymbol),
    getRelatedChunks: async (symbolIds) =>
      (
        await codeIntelligenceRepository.listRelatedChunksForSymbols({
          indexVersionId: options.indexVersionId,
          symbolIds,
        })
      ).map((row) => ({
        ...toRetrievalChunk(row.chunk),
        relationKind: row.relationKind,
      })),
    getDependenciesForFiles: async (paths) =>
      (
        await codeIntelligenceRepository.listDependenciesForFiles({
          indexVersionId: options.indexVersionId,
          paths,
        })
      ).map(toRetrievalDependency),
    getRoutesForFiles: async (paths) =>
      (
        await codeIntelligenceRepository.listRoutesForFiles({
          indexVersionId: options.indexVersionId,
          paths,
        })
      ).map(toRetrievalRoute),
    getRelatedTestChunks: async (paths) =>
      (
        await codeIntelligenceRepository.listRelatedTestChunks({
          indexVersionId: options.indexVersionId,
          sourcePaths: paths,
        })
      ).map(toRetrievalChunk),
    searchFullTextChunks: async (query, limit) =>
      (
        await codeIntelligenceRepository.searchFullTextChunks({
          indexVersionId: options.indexVersionId,
          limit,
          query,
        })
      ).map((row) => ({
        ...toRetrievalChunk(row.chunk),
        score: row.score,
        searchSource: "full_text_search" as const,
      })),
    searchSimilarChunks: async (query, limit) => {
      if (options.embedQuery) {
        const queryVector = await options.embedQuery(query);
        const rows = await embeddingRepository.vectorSearchChunks({
          embeddingModel: options.embeddingModel ?? "text-embedding-3-small",
          indexVersionId: options.indexVersionId,
          limit,
          queryVector,
        });

        return rows.map((row) => ({
          ...toRetrievalChunk(row.chunk),
          score: row.score,
          searchSource: "vector_search" as const,
        }));
      }

      return [];
    },
  };
}

async function retrieveIndexedItems(
  input: RetrieveContextInput & { readonly index: RetrievalIndex },
  diffItems: readonly ContextItem[],
): Promise<IndexedRetrievalResult> {
  const paths = input.snapshot.changedFiles.map((file) => file.path);
  const query = diffItems.flatMap((item) => item.snippet?.text ?? []).join("\n");
  const [sameFile, symbolsForFiles] = await Promise.all([
    input.index.getSameFileChunks(paths),
    input.index.getSymbolsForFiles(paths),
  ]);
  const changedSymbolsForFiles = symbolsForFiles.filter((symbol) =>
    retrievalSymbolOverlapsChangedLines(symbol, input.snapshot.changedFiles),
  );
  const indexedChangedSymbols = changedSymbolsFromIndexedSymbols(
    input.snapshot,
    changedSymbolsForFiles,
  );
  const indexedSymbolPaths = new Set(indexedChangedSymbols.map((symbol) => symbol.path));
  const changedSymbols = [
    ...indexedChangedSymbols,
    ...changedSymbolsFromDiff(input.snapshot).filter(
      (symbol) => !indexedSymbolPaths.has(symbol.path),
    ),
  ];
  const symbolIds = changedSymbolsForFiles.map((symbol) => symbol.symbolId);
  const [
    relatedResult,
    dependencyResult,
    routeResult,
    relatedTestsResult,
    fullTextResult,
    similarResult,
  ] = await Promise.all([
    retrieveOptionalIndexItems("symbol-graph", "graph_retrieval_failed", () =>
      input.index.getRelatedChunks(symbolIds),
    ),
    retrieveOptionalIndexItems(
      "dependency-metadata",
      "dependency_retrieval_failed",
      () => input.index.getDependenciesForFiles?.(paths) ?? Promise.resolve([]),
    ),
    retrieveOptionalIndexItems(
      "route-metadata",
      "route_retrieval_failed",
      () => input.index.getRoutesForFiles?.(paths) ?? Promise.resolve([]),
    ),
    retrieveOptionalIndexItems("related-tests", "test_retrieval_failed", () =>
      input.index.getRelatedTestChunks(paths),
    ),
    retrieveOptionalIndexItems(
      "full-text-search",
      "full_text_retrieval_failed",
      () => input.index.searchFullTextChunks?.(query, 8) ?? Promise.resolve([]),
    ),
    retrieveOptionalIndexItems("semantic-search", "semantic_retrieval_failed", () =>
      input.index.searchSimilarChunks(query, 8),
    ),
  ]);

  return {
    items: [
      ...sameFile.map((chunk) =>
        chunkItem(chunk, "same_file_context", "Same file indexed context."),
      ),
      ...changedSymbolsForFiles.map(symbolItem),
      ...relatedResult.items.map((chunk) =>
        chunkItem(
          chunk,
          chunk.relationKind ?? "callee",
          `${chunk.relationKind === "caller" ? "Caller" : "Callee"} indexed context.`,
        ),
      ),
      ...dependencyResult.items.map(dependencyItem),
      ...routeResult.items.map(routeItem),
      ...relatedTestsResult.items.map((chunk) =>
        chunkItem(chunk, "related_test", "Related test context."),
      ),
      ...fullTextResult.items.map((chunk) =>
        chunkItem(chunk, "similar_pattern", "Full-text search related context."),
      ),
      ...similarResult.items.map((chunk) =>
        chunkItem(chunk, "similar_pattern", "Vector search related context."),
      ),
    ],
    warnings: [
      ...relatedResult.warnings,
      ...dependencyResult.warnings,
      ...routeResult.warnings,
      ...relatedTestsResult.warnings,
      ...fullTextResult.warnings,
      ...similarResult.warnings,
    ],
    changedSymbols,
  };
}

async function retrieveMemoryItems(
  input: RetrieveContextInput & { readonly memory: RetrieveMemoryContextOptions },
  timestamp: string,
): Promise<MemoryRetrievalResult> {
  const result = await input.memory.retriever.retrieveRelevantMemory({
    orgId: input.memory.orgId,
    repoId: input.snapshot.repoId,
    changedFiles: input.snapshot.changedFiles.map((file) => ({
      path: file.path,
      language: file.language,
    })),
    changedSymbols: [],
    ...(input.memory.findingCategories
      ? { findingCategories: input.memory.findingCategories }
      : {}),
    ...(input.memory.maxFacts === undefined ? {} : { maxFacts: input.memory.maxFacts }),
    ...(input.memory.maxTokens === undefined ? {} : { maxTokens: input.memory.maxTokens }),
    now: timestamp,
  });
  const traceByFactId = new Map(result.trace.map((entry) => [entry.memoryFactId, entry]));

  return {
    factIds: result.facts.map((fact) => fact.id),
    items: result.facts.map((fact) => memoryFactItem(fact, traceByFactId.get(fact.id))),
    trace: result.trace,
  };
}

/** Selects repository rules that should be visible as review context. */
function retrieveRepoRuleItems(
  input: RetrieveContextInput & { readonly rules: RetrieveRepoRuleContextOptions },
  timestamp: string,
): RepoRuleRetrievalResult {
  const maxRules = Math.max(0, input.rules.maxRules ?? 12);
  const evaluations = input.rules.rules.map((rule) =>
    evaluateRepoRuleForContext(rule, input.snapshot, timestamp),
  );
  const selected = evaluations
    .filter((evaluation) => evaluation.trace.included)
    .sort(
      (left, right) =>
        left.rule.priority - right.rule.priority ||
        left.rule.ruleId.localeCompare(right.rule.ruleId),
    )
    .slice(0, maxRules);
  const selectedRuleIds = new Set(selected.map((evaluation) => evaluation.rule.ruleId));
  const trace = evaluations.map((evaluation) =>
    evaluation.trace.included && !selectedRuleIds.has(evaluation.rule.ruleId)
      ? { ...evaluation.trace, included: false, reason: "rule_limit_exceeded" }
      : evaluation.trace,
  );

  return {
    items: selected.map((evaluation) => repoRuleItem(evaluation.rule, evaluation.trace)),
    ruleIds: selected.map((evaluation) => evaluation.rule.ruleId),
    trace,
  };
}

/** Runs an optional indexed retriever and records a warning instead of failing retrieval. */
async function retrieveOptionalIndexItems<TItem>(
  retriever: string,
  code: string,
  run: () => Promise<readonly TItem[]>,
): Promise<{ readonly items: readonly TItem[]; readonly warnings: readonly RetrievalWarning[] }> {
  try {
    return { items: await run(), warnings: [] };
  } catch (error) {
    return {
      items: [],
      warnings: [
        {
          code,
          message: error instanceof Error ? error.message : "Optional retrieval failed.",
          retriever,
        },
      ],
    };
  }
}

/** Internal rule evaluation result used before applying retrieval limits. */
type RepoRuleContextEvaluation = {
  /** Repository rule that was evaluated. */
  readonly rule: RepoRule;
  /** Product-safe selection trace for the rule. */
  readonly trace: RepoRuleRetrievalTraceEntry;
};

/** Evaluates whether one repository rule applies to the pull request snapshot. */
function evaluateRepoRuleForContext(
  rule: RepoRule,
  snapshot: PullRequestSnapshot,
  timestamp: string,
): RepoRuleContextEvaluation {
  if (!rule.enabled) {
    return skippedRepoRuleEvaluation(rule, "disabled_rule");
  }
  if (repoRuleExpired(rule, timestamp)) {
    return skippedRepoRuleEvaluation(rule, "expired_rule");
  }
  if (rule.repoId && rule.repoId !== snapshot.repoId) {
    return skippedRepoRuleEvaluation(rule, "repo_mismatch");
  }

  const pathPatterns = nonEmptyValues(rule.matcher.paths);
  const languageMatchers = nonEmptyValues(rule.matcher.languages);
  const labelMatchers = nonEmptyValues(rule.matcher.labels);
  const authorMatchers = nonEmptyValues(rule.matcher.authors);
  const titleRegex = rule.matcher.titleRegex?.trim();

  const pathMatch = pathPatterns
    ? matchingChangedPaths(snapshot.changedFiles, pathPatterns)
    : { paths: [] };
  if (pathMatch.error) {
    return skippedRepoRuleEvaluation(rule, "invalid_path_matcher");
  }
  if (pathPatterns && pathMatch.paths.length === 0) {
    return skippedRepoRuleEvaluation(rule, "path_not_matched");
  }

  const matchedLanguages = languageMatchers
    ? matchingChangedLanguages(snapshot.changedFiles, languageMatchers)
    : [];
  if (languageMatchers && matchedLanguages.length === 0) {
    return skippedRepoRuleEvaluation(rule, "language_not_matched");
  }

  const matchedLabels = labelMatchers
    ? matchingComparableValues(snapshot.labels, labelMatchers)
    : [];
  if (labelMatchers && matchedLabels.length === 0) {
    return skippedRepoRuleEvaluation(rule, "label_not_matched");
  }

  if (authorMatchers && !matchesComparableValue(snapshot.authorLogin, authorMatchers)) {
    return skippedRepoRuleEvaluation(rule, "author_not_matched");
  }

  if (titleRegex) {
    const titleMatches = matchesRuleTitle(snapshot.title, titleRegex);
    if (titleMatches === "invalid") {
      return skippedRepoRuleEvaluation(rule, "invalid_title_regex");
    }
    if (!titleMatches) {
      return skippedRepoRuleEvaluation(rule, "title_not_matched");
    }
  }

  const trace = {
    ruleId: rule.ruleId,
    included: true,
    reason: repoRuleMatchReason(rule, {
      labels: matchedLabels,
      languages: matchedLanguages,
      paths: pathMatch.paths,
    }),
    ...(pathMatch.paths.length > 0 ? { matchedPaths: pathMatch.paths } : {}),
    ...(matchedLanguages.length > 0 ? { matchedLanguages } : {}),
    ...(matchedLabels.length > 0 ? { matchedLabels } : {}),
  } satisfies RepoRuleRetrievalTraceEntry;

  return { rule, trace };
}

/** Creates a skipped rule evaluation with a stable product-safe reason. */
function skippedRepoRuleEvaluation(
  rule: RepoRule,
  reason: RepoRuleRetrievalTraceEntry["reason"],
): RepoRuleContextEvaluation {
  return {
    rule,
    trace: {
      ruleId: rule.ruleId,
      included: false,
      reason,
    },
  };
}

/** Converts one selected repository rule to a context item. */
function repoRuleItem(rule: RepoRule, trace: RepoRuleRetrievalTraceEntry): ContextItem {
  const matcherSummary = repoRuleMatcherSummary(rule);
  const text = [
    `Repository rule: ${rule.name}`,
    `Effect: ${rule.effect}`,
    ...(rule.description ? [`Description: ${rule.description}`] : []),
    `Instruction: ${rule.instruction}`,
    ...(matcherSummary ? [`Matcher: ${matcherSummary}`] : []),
  ].join("\n");

  return {
    contextItemId: stableId("ctxitem", ["repo-rule", rule.ruleId]),
    kind: "repo_rule",
    source: "repo_rule",
    title: rule.name,
    text,
    priority: repoRulePriority(rule),
    tokenEstimate: estimateTokens(text),
    provenance: {
      retriever: "repo-rule-context",
      reason: repoRuleReasonText(trace.reason),
    },
    metadata: {
      ruleId: rule.ruleId,
      effect: rule.effect,
      priority: rule.priority,
      matcher: rule.matcher,
      ...(trace.matchedPaths ? { matchedPaths: trace.matchedPaths } : {}),
      ...(trace.matchedLanguages ? { matchedLanguages: trace.matchedLanguages } : {}),
      ...(trace.matchedLabels ? { matchedLabels: trace.matchedLabels } : {}),
    },
  };
}

function memoryFactItem(
  fact: MemoryFact,
  trace: RelevantMemoryTraceEntry | undefined,
): ContextItem {
  const text = formatMemoryFactForContext(fact);

  return {
    contextItemId: stableId("ctxitem", ["memory-fact", fact.id]),
    kind: "memory_fact",
    source: "memory",
    title: `${memoryKindLabel(fact.kind)} memory`,
    text,
    ...(trace ? { score: trace.score } : {}),
    priority: memoryFactPriority(fact),
    tokenEstimate: estimateTokens(text),
    provenance: {
      retriever: "relevant-memory",
      reason: trace?.reason ?? "Selected active memory fact.",
    },
    metadata: {
      memoryFactId: fact.id,
      memoryKind: fact.kind,
      memoryScope: fact.scope.level,
      ...(trace ? { matchedDimensions: trace.matchedDimensions } : {}),
    },
  };
}

function contextItemsForFile(file: ChangedFile): readonly ContextItem[] {
  if (file.isBinary || file.status === "deleted") {
    return [];
  }

  return file.hunks.map((hunk, index) => {
    const text = hunk.lines.map((line) => `${prefixForLine(line.kind)}${line.content}`).join("\n");
    const startLine = hunk.lines.find((line) => line.newLine)?.newLine ?? hunk.newStart;
    const endLine =
      [...hunk.lines].reverse().find((line) => line.newLine)?.newLine ??
      Math.max(startLine, hunk.newStart + hunk.newLines - 1);

    return {
      contextItemId: stableId("ctxitem", [file.path, hunk.hunkId, index]),
      kind: "diff",
      source: "diff",
      title: `${file.path}:${startLine}`,
      summary: hunk.header,
      snippet: {
        path: file.path,
        language: file.language,
        range: { startLine: Math.max(1, startLine), endLine: Math.max(1, endLine) },
        text,
        ...(file.newContentHash ? { contentHash: file.newContentHash } : {}),
      },
      priority: file.isTest ? 55 : 80,
      tokenEstimate: estimateTokens(text),
      provenance: {
        retriever: "diff-context",
        reason: "Changed diff hunk included for review grounding.",
      },
      metadata: {
        hunkId: hunk.hunkId,
        status: file.status,
        isGenerated: file.isGenerated,
        isTest: file.isTest,
      },
    };
  });
}

function memoryFactPriority(fact: MemoryFact): number {
  return Math.max(55, Math.min(95, Math.round(60 + fact.priority / 30 + fact.confidence * 10)));
}

function memoryKindLabel(kind: MemoryFact["kind"]): string {
  return kind.replaceAll("_", " ");
}

/** Converts indexed symbols that overlap changed lines into changed-symbol contracts. */
function changedSymbolsFromIndexedSymbols(
  snapshot: PullRequestSnapshot,
  symbolsForFiles: readonly RetrievalSymbol[],
): readonly ChangedSymbol[] {
  const changedFileByPath = new Map(snapshot.changedFiles.map((file) => [file.path, file]));

  return symbolsForFiles.flatMap((symbol) => {
    const file = changedFileByPath.get(symbol.path);
    if (!file) {
      return [];
    }
    const diffHunkIds = file.hunks
      .filter((hunk) =>
        lineRangeOverlaps(
          { startLine: symbol.startLine, endLine: symbol.endLine },
          changedLineRangeForHunk(file, hunk),
        ),
      )
      .map((hunk) => hunk.hunkId);

    return [
      {
        symbolId: symbol.symbolId,
        fileId: symbol.fileId,
        path: symbol.path,
        name: symbol.name,
        ...(symbol.qualifiedName ? { qualifiedName: symbol.qualifiedName } : {}),
        kind: symbolKindForContext(symbol.kind),
        language: languageForContext(symbol.language),
        changeType: file.status,
        newRange: { startLine: symbol.startLine, endLine: symbol.endLine },
        diffHunkIds,
        confidence: diffHunkIds.length > 0 ? 0.9 : 0.75,
      },
    ];
  });
}

/** Creates line-range changed-symbol fallbacks directly from diff hunks. */
function changedSymbolsFromDiff(snapshot: PullRequestSnapshot): readonly ChangedSymbol[] {
  return snapshot.changedFiles.flatMap((file) =>
    file.hunks.map((hunk, index) => {
      const range = changedLineRangeForHunk(file, hunk);
      const patch = hunk.lines
        .map((line) => `${prefixForLine(line.kind)}${line.content}`)
        .join("\n");

      return {
        path: file.path,
        language: file.language,
        changeType: file.status,
        ...(file.status === "deleted" ? { oldRange: range } : { newRange: range }),
        diffHunkIds: [hunk.hunkId],
        patch,
        confidence: 0.55,
        name: `${file.path} hunk ${index + 1}`,
        kind: "unknown",
      } satisfies ChangedSymbol;
    }),
  );
}

/** Returns whether an indexed symbol overlaps at least one changed line range. */
function retrievalSymbolOverlapsChangedLines(
  symbol: RetrievalSymbol,
  files: readonly ChangedFile[],
): boolean {
  const file = files.find((changedFile) => changedFile.path === symbol.path);
  if (!file) {
    return false;
  }

  return file.hunks.some((hunk) =>
    lineRangeOverlaps(
      { startLine: symbol.startLine, endLine: symbol.endLine },
      changedLineRangeForHunk(file, hunk),
    ),
  );
}

/** Builds the changed-line range for a diff hunk on the relevant side. */
function changedLineRangeForHunk(
  file: ChangedFile,
  hunk: ChangedFile["hunks"][number],
): { readonly startLine: number; readonly endLine: number } {
  const changedLines = hunk.lines
    .filter((line) =>
      file.status === "deleted" ? line.kind === "deletion" : line.kind === "addition",
    )
    .map((line) => (file.status === "deleted" ? line.oldLine : line.newLine))
    .filter((line): line is number => line !== undefined);
  if (changedLines.length > 0) {
    return {
      startLine: Math.max(1, Math.min(...changedLines)),
      endLine: Math.max(1, Math.max(...changedLines)),
    };
  }

  const startLine = file.status === "deleted" ? hunk.oldStart : hunk.newStart;
  const lineCount = file.status === "deleted" ? hunk.oldLines : hunk.newLines;

  return {
    startLine: Math.max(1, startLine),
    endLine: Math.max(1, startLine + Math.max(0, lineCount - 1)),
  };
}

/** Returns whether two line ranges overlap. */
function lineRangeOverlaps(
  left: { readonly startLine: number; readonly endLine: number },
  right: { readonly startLine: number; readonly endLine: number },
): boolean {
  return left.startLine <= right.endLine && left.endLine >= right.startLine;
}

/** Maps indexer symbol kinds to the shared symbol-kind contract. */
function symbolKindForContext(kind: string): SymbolKind {
  if (
    kind === "module" ||
    kind === "namespace" ||
    kind === "class" ||
    kind === "interface" ||
    kind === "type" ||
    kind === "enum" ||
    kind === "function" ||
    kind === "method" ||
    kind === "constructor" ||
    kind === "property" ||
    kind === "variable" ||
    kind === "constant" ||
    kind === "route" ||
    kind === "component" ||
    kind === "hook"
  ) {
    return kind;
  }

  return "unknown";
}

function withFallbackRule(items: readonly ContextItem[]): readonly ContextItem[] {
  return [
    {
      contextItemId: stableId("ctxitem", ["retrieval", "missing-index"]),
      kind: "repo_rule",
      source: "repo_rule",
      title: "Repository index unavailable",
      text: "No repository index was available. Review passes must rely on pull request diff context only.",
      priority: 100,
      tokenEstimate: 18,
      provenance: {
        retriever: "diff-fallback",
        reason: "Clean fallback when indexed retrieval is unavailable.",
      },
      metadata: { suppressSpeculativeContextClaims: true },
    },
    ...items,
  ];
}

/** Structural DB chunk row returned by vector search before contract mapping. */
type RetrievalChunkRow = {
  /** Stable chunk ID. */
  readonly chunkId: string;
  /** Optional owning symbol ID. */
  readonly symbolId?: string | null;
  /** Repository-relative source path. */
  readonly path: string;
  /** One-based starting line. */
  readonly startLine: number;
  /** One-based ending line. */
  readonly endLine: number;
  /** Chunk content hash. */
  readonly contentHash: string;
  /** Imported chunk metadata. */
  readonly metadata: unknown;
};

/** Converts either a contract chunk or DB chunk row into retrieval's internal chunk shape. */
function toRetrievalChunk(row: ChunkRecord | RetrievalChunkRow): RetrievalChunk {
  if ("range" in row) {
    return {
      chunkId: row.chunkId,
      ...(row.symbolId ? { symbolId: row.symbolId } : {}),
      path: row.path,
      startLine: row.range.startLine,
      endLine: row.range.endLine,
      language: row.language,
      contentHash: row.contentHash,
      text: row.text,
      tokenEstimate: row.tokenEstimate,
    };
  }

  const metadata = row.metadata;
  const metadataObject = metadata && typeof metadata === "object" ? metadata : {};
  const text =
    "text" in metadataObject && typeof metadataObject.text === "string" ? metadataObject.text : "";
  const tokenEstimate =
    "tokenEstimate" in metadataObject && typeof metadataObject.tokenEstimate === "number"
      ? metadataObject.tokenEstimate
      : estimateTokens(text);
  const language =
    "language" in metadataObject && typeof metadataObject.language === "string"
      ? metadataObject.language
      : "unknown";

  return {
    chunkId: row.chunkId,
    ...(row.symbolId ? { symbolId: row.symbolId } : {}),
    path: row.path,
    startLine: row.startLine,
    endLine: row.endLine,
    language,
    contentHash: row.contentHash,
    text,
    tokenEstimate,
  };
}

/** Converts a symbol contract into retrieval's internal symbol shape. */
function toRetrievalSymbol(record: SymbolRecord): RetrievalSymbol {
  return {
    symbolId: record.symbolId,
    fileId: record.fileId,
    path: record.path,
    name: record.name,
    ...(record.qualifiedName ? { qualifiedName: record.qualifiedName } : {}),
    kind: record.kind,
    language: record.language,
    startLine: record.range.startLine,
    endLine: record.range.endLine,
  };
}

/** Converts a dependency contract into retrieval's dependency metadata shape. */
function toRetrievalDependency(record: DependencyRecord): RetrievalDependency {
  return {
    dependencyId: record.dependencyId,
    manifestPath: record.manifestPath,
    ...(record.packageManager ? { packageManager: record.packageManager } : {}),
    name: record.name,
    ...(record.versionSpec ? { versionSpec: record.versionSpec } : {}),
    ...(record.resolvedVersion ? { resolvedVersion: record.resolvedVersion } : {}),
    ...(record.dependencyType ? { dependencyType: record.dependencyType } : {}),
  };
}

/** Converts a route contract into retrieval's route metadata shape. */
function toRetrievalRoute(record: RouteRecord): RetrievalRoute {
  return {
    routeId: record.routeId,
    path: record.path,
    language: record.language,
    routePattern: record.routePattern,
    methods: record.methods,
    ...(record.handlerSymbolId ? { handlerSymbolId: record.handlerSymbolId } : {}),
    ...(record.range ? { startLine: record.range.startLine, endLine: record.range.endLine } : {}),
    ...(record.framework ? { framework: record.framework } : {}),
    confidence: record.confidence,
  };
}

function chunkItem(
  chunk: RetrievalChunk,
  kind: Extract<
    ContextItem["kind"],
    "same_file_context" | "callee" | "related_test" | "similar_pattern" | "caller"
  >,
  reason: string,
): ContextItem {
  return {
    contextItemId: stableId("ctxitem", [kind, chunk.chunkId]),
    kind,
    source: kind === "similar_pattern" ? (chunk.searchSource ?? "vector_search") : "symbol_graph",
    title: `${chunk.path}:${chunk.startLine}`,
    snippet: {
      path: chunk.path,
      language: languageForContext(chunk.language),
      range: { startLine: chunk.startLine, endLine: chunk.endLine },
      text: chunk.text,
      contentHash: chunk.contentHash,
      ...(chunk.symbolId ? { symbolId: chunk.symbolId } : {}),
      chunkId: chunk.chunkId,
    },
    ...(chunk.score === undefined ? {} : { score: chunk.score }),
    priority: priorityForKind(kind),
    tokenEstimate: chunk.tokenEstimate,
    provenance: {
      retriever: "index-backed-retrieval",
      reason,
      ...(chunk.symbolId ? { relatedSymbolId: chunk.symbolId } : {}),
    },
  };
}

function symbolItem(symbol: RetrievalSymbol): ContextItem {
  return {
    contextItemId: stableId("ctxitem", ["changed-symbol", symbol.symbolId]),
    kind: "changed_symbol",
    source: "symbol_graph",
    title: `${symbol.name} (${symbol.kind})`,
    summary: `${symbol.path}:${symbol.startLine}-${symbol.endLine}`,
    priority: 90,
    tokenEstimate: 8,
    provenance: {
      retriever: "index-backed-retrieval",
      reason: "Changed file symbol from imported index.",
      relatedSymbolId: symbol.symbolId,
      relatedFileId: symbol.fileId,
    },
    metadata: { path: symbol.path, kind: symbol.kind },
  };
}

function dependencyItem(dependency: RetrievalDependency): ContextItem {
  const text = [
    `Dependency: ${dependency.name}`,
    `Manifest: ${dependency.manifestPath}`,
    ...(dependency.versionSpec ? [`Version constraint: ${dependency.versionSpec}`] : []),
    ...(dependency.resolvedVersion ? [`Resolved version: ${dependency.resolvedVersion}`] : []),
    ...(dependency.dependencyType ? [`Dependency type: ${dependency.dependencyType}`] : []),
    ...(dependency.packageManager ? [`Package manager: ${dependency.packageManager}`] : []),
  ].join("\n");

  return {
    contextItemId: stableId("ctxitem", ["dependency", dependency.dependencyId]),
    kind: "dependency",
    source: "symbol_graph",
    title: dependency.name,
    text,
    priority: 66,
    tokenEstimate: estimateTokens(text),
    provenance: {
      retriever: "dependency-index",
      reason: "Changed package manifest dependency imported from the repository index.",
    },
    metadata: {
      dependencyId: dependency.dependencyId,
      manifestPath: dependency.manifestPath,
      ...(dependency.packageManager ? { packageManager: dependency.packageManager } : {}),
      ...(dependency.dependencyType ? { dependencyType: dependency.dependencyType } : {}),
    },
  };
}

function routeItem(route: RetrievalRoute): ContextItem {
  const methods = route.methods.length > 0 ? route.methods.join(", ") : "ANY";
  const text = [
    `Route: ${methods} ${route.routePattern}`,
    `Source: ${route.path}`,
    ...(route.framework ? [`Framework: ${route.framework}`] : []),
    ...(route.handlerSymbolId ? [`Handler symbol: ${route.handlerSymbolId}`] : []),
    `Confidence: ${route.confidence.toFixed(2)}`,
  ].join("\n");

  return {
    contextItemId: stableId("ctxitem", ["route", route.routeId]),
    kind: "config",
    source: "symbol_graph",
    title: `${methods} ${route.routePattern}`,
    text,
    priority: 68,
    tokenEstimate: estimateTokens(text),
    provenance: {
      retriever: "route-index",
      reason: "Changed file declares a framework route in the repository index.",
      ...(route.handlerSymbolId ? { relatedSymbolId: route.handlerSymbolId } : {}),
    },
    metadata: {
      routeId: route.routeId,
      path: route.path,
      routePattern: route.routePattern,
      methods: route.methods,
      ...(route.framework ? { framework: route.framework } : {}),
      ...(route.startLine ? { startLine: route.startLine } : {}),
      ...(route.endLine ? { endLine: route.endLine } : {}),
    },
  };
}

/** Rule matcher dimensions that matched the current pull request. */
type RepoRuleMatchSignals = {
  /** Pull request labels that matched the rule matcher. */
  readonly labels: readonly string[];
  /** Changed file languages that matched the rule matcher. */
  readonly languages: readonly string[];
  /** Changed paths that matched the rule matcher. */
  readonly paths: readonly string[];
};

/** Converts rule effect and explicit priority into context packing priority. */
function repoRulePriority(rule: RepoRule): number {
  const effectPriority =
    rule.effect === "require"
      ? 94
      : rule.effect === "promote"
        ? 88
        : rule.effect === "context" || rule.effect === "style_preference"
          ? 84
          : 78;
  const explicitPriorityBoost = Math.round((1000 - rule.priority) / 100);

  return Math.max(70, Math.min(99, effectPriority + explicitPriorityBoost));
}

/** Builds a compact matcher summary for context text. */
function repoRuleMatcherSummary(rule: RepoRule): string | undefined {
  const matcher = rule.matcher;
  const parts = [
    ...(matcher.paths?.length ? [`paths=${matcher.paths.join(",")}`] : []),
    ...(matcher.languages?.length ? [`languages=${matcher.languages.join(",")}`] : []),
    ...(matcher.categories?.length ? [`categories=${matcher.categories.join(",")}`] : []),
    ...(matcher.severities?.length ? [`severities=${matcher.severities.join(",")}`] : []),
    ...(matcher.authors?.length ? [`authors=${matcher.authors.join(",")}`] : []),
    ...(matcher.labels?.length ? [`labels=${matcher.labels.join(",")}`] : []),
    ...(matcher.titleRegex ? [`titleRegex=${matcher.titleRegex}`] : []),
  ];

  return parts.length > 0 ? parts.join("; ") : undefined;
}

/** Converts a stable rule match reason into review-facing provenance text. */
function repoRuleReasonText(reason: string): string {
  if (reason === "path_matched") return "Repository rule matched a changed path.";
  if (reason === "language_matched") return "Repository rule matched a changed file language.";
  if (reason === "label_matched") return "Repository rule matched a pull request label.";
  if (reason === "author_matched") return "Repository rule matched the pull request author.";
  if (reason === "title_matched") return "Repository rule matched the pull request title.";
  if (reason === "finding_policy_rule") {
    return "Repository rule affects review finding policy and is visible as context.";
  }

  return "Repository rule applies globally to this review.";
}

/** Chooses the most specific stable reason for a matched rule. */
function repoRuleMatchReason(rule: RepoRule, signals: RepoRuleMatchSignals): string {
  if (signals.paths.length > 0) return "path_matched";
  if (signals.languages.length > 0) return "language_matched";
  if (signals.labels.length > 0) return "label_matched";
  if (nonEmptyValues(rule.matcher.authors)) return "author_matched";
  if (rule.matcher.titleRegex?.trim()) return "title_matched";
  if (nonEmptyValues(rule.matcher.categories) || nonEmptyValues(rule.matcher.severities)) {
    return "finding_policy_rule";
  }

  return "global_rule";
}

/** Returns whether a repository rule has expired before retrieval time. */
function repoRuleExpired(rule: RepoRule, timestamp: string): boolean {
  const expiresAt =
    rule.metadata && typeof rule.metadata.expiresAt === "string" ? rule.metadata.expiresAt : "";

  return expiresAt.length > 0 && Date.parse(expiresAt) <= Date.parse(timestamp);
}

/** Returns changed paths that match at least one rule glob. */
function matchingChangedPaths(
  files: readonly ChangedFile[],
  patterns: readonly string[],
): { readonly error?: true; readonly paths: readonly string[] } {
  const matchedPaths: string[] = [];

  try {
    for (const file of files) {
      const paths = [file.path, ...(file.oldPath ? [file.oldPath] : [])];
      if (paths.some((path) => matchesAnyPathPattern(path, patterns))) {
        matchedPaths.push(file.path);
      }
    }
  } catch {
    return { error: true, paths: [] };
  }

  return { paths: uniqueStrings(matchedPaths) };
}

/** Returns changed file languages that match the rule language matcher. */
function matchingChangedLanguages(
  files: readonly ChangedFile[],
  languages: readonly string[],
): readonly string[] {
  const languageSet = new Set(languages);

  return uniqueStrings(
    files.map((file) => file.language).filter((language) => languageSet.has(language)),
  );
}

/** Returns exact normalized PR metadata values that match expected values. */
function matchingComparableValues(
  values: readonly string[],
  expectedValues: readonly string[],
): readonly string[] {
  const expected = new Set(expectedValues.map(normalizeComparable));

  return uniqueStrings(values.filter((value) => expected.has(normalizeComparable(value))));
}

/** Returns whether one normalized PR metadata value is listed in expected values. */
function matchesComparableValue(value: string, expectedValues: readonly string[]): boolean {
  const normalized = normalizeComparable(value);

  return expectedValues.some((expectedValue) => normalizeComparable(expectedValue) === normalized);
}

/** Evaluates a rule title regular expression without throwing on invalid input. */
function matchesRuleTitle(title: string, titleRegex: string): boolean | "invalid" {
  try {
    return new RegExp(titleRegex, "iu").test(title);
  } catch {
    return "invalid";
  }
}

/** Returns a non-empty array or undefined when a matcher dimension is absent. */
function nonEmptyValues<TValue>(
  values: readonly TValue[] | undefined,
): readonly TValue[] | undefined {
  return values && values.length > 0 ? values : undefined;
}

/** Accumulates source ranks and weighted RRF scores for raw context candidates. */
type RankFusionObservations = {
  /** RRF score accumulated per merge key. */
  readonly scoreByMergeKey: ReadonlyMap<string, number>;
  /** Source-specific raw item scores observed per merge key. */
  readonly sourceScoresByMergeKey: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /** Source-specific ranks observed per merge key. */
  readonly sourceRanksByMergeKey: ReadonlyMap<string, ReadonlyMap<string, number>>;
};

/** Mutable merge state used while collapsing duplicate context candidates. */
type ContextItemMergeState = {
  /** Raw candidates that share the same merge key. */
  readonly candidates: ContextItem[];
  /** Merge key used for duplicate detection. */
  readonly mergeKey: string;
  /** Highest-value item retained as the user-visible context item. */
  primary: ContextItem;
  /** Ranked retrieval source types that contributed to this item. */
  readonly sourceTypes: Set<string>;
};

/** Context merge state with an adjusted raw score before normalization. */
type ScoredContextItemMergeState = {
  /** Raw adjusted score before normalization. */
  readonly adjustedScore: number;
  /** Merge state for the context item. */
  readonly state: ContextItemMergeState;
};

/** Merges duplicate context candidates and applies deterministic rank-fusion scores. */
function rankAndMergeContextItems(
  items: readonly ContextItem[],
  changedFiles: readonly ChangedFile[],
): RankedContextItems {
  const observations = observeRankFusionSources(items);
  const stateByMergeKey = mergeContextItemsByKey(items);
  const scoredStates = [...stateByMergeKey.values()]
    .map((state) => ({
      adjustedScore:
        (observations.scoreByMergeKey.get(state.mergeKey) ?? fallbackRankScore(state.primary)) *
        rankingMultiplierForContextItem(state.primary, changedFiles),
      state,
    }))
    .sort(compareScoredContextItemMergeStates);
  const maxScore = Math.max(0, ...scoredStates.map((state) => state.adjustedScore));
  const rankedItems = scoredStates.map(({ adjustedScore, state }) =>
    applyRankingMetadata(state, {
      score: normalizeRankingScore(adjustedScore, maxScore),
      sourceRanks: observations.sourceRanksByMergeKey.get(state.mergeKey) ?? new Map(),
      sourceScores: observations.sourceScoresByMergeKey.get(state.mergeKey) ?? new Map(),
    }),
  );

  return {
    items: rankedItems,
    trace: {
      candidateItemCount: items.length,
      duplicateCandidateCount: Math.max(0, items.length - rankedItems.length),
      items: rankedItems.map(rankingTraceItem).slice(0, RANKING_TRACE_ITEM_LIMIT),
      k: RANK_FUSION_K,
      mergedItemCount: rankedItems.length,
      strategy: "weighted_reciprocal_rank_fusion_v1",
    },
  };
}

/** Builds source-specific rank observations for raw candidates. */
function observeRankFusionSources(items: readonly ContextItem[]): RankFusionObservations {
  const scoreByMergeKey = new Map<string, number>();
  const sourceScoresByMergeKey = new Map<string, Map<string, number>>();
  const sourceRanksByMergeKey = new Map<string, Map<string, number>>();
  const itemsBySource = new Map<string, ContextItem[]>();

  for (const item of items) {
    const sourceType = rankingSourceType(item);
    itemsBySource.set(sourceType, [...(itemsBySource.get(sourceType) ?? []), item]);
  }

  for (const [sourceType, sourceItems] of itemsBySource) {
    const seenMergeKeys = new Set<string>();
    const rankedSourceItems = [...sourceItems].sort(compareRawContextItemsForSourceRank);

    for (const item of rankedSourceItems) {
      const mergeKey = contextItemMergeKey(item);
      if (seenMergeKeys.has(mergeKey)) {
        continue;
      }
      const rank = seenMergeKeys.size + 1;
      seenMergeKeys.add(mergeKey);
      scoreByMergeKey.set(
        mergeKey,
        (scoreByMergeKey.get(mergeKey) ?? 0) +
          (RANK_FUSION_SOURCE_WEIGHTS[sourceType] ?? 1) / (RANK_FUSION_K + rank),
      );
      setNestedNumber(sourceRanksByMergeKey, mergeKey, sourceType, rank);
      setNestedNumber(sourceScoresByMergeKey, mergeKey, sourceType, rawContextItemScore(item));
    }
  }

  return {
    scoreByMergeKey,
    sourceRanksByMergeKey,
    sourceScoresByMergeKey,
  };
}

/** Groups raw candidates by stable merge keys and keeps the best primary candidate. */
function mergeContextItemsByKey(
  items: readonly ContextItem[],
): ReadonlyMap<string, ContextItemMergeState> {
  const stateByMergeKey = new Map<string, ContextItemMergeState>();

  for (const item of items) {
    const mergeKey = contextItemMergeKey(item);
    const state = stateByMergeKey.get(mergeKey);
    if (!state) {
      stateByMergeKey.set(mergeKey, {
        candidates: [item],
        mergeKey,
        primary: item,
        sourceTypes: new Set([rankingSourceType(item)]),
      });
      continue;
    }

    state.candidates.push(item);
    state.sourceTypes.add(rankingSourceType(item));
    state.primary = choosePrimaryContextItem(state.primary, item);
  }

  return stateByMergeKey;
}

/** Selects the best raw context item to represent a merged candidate. */
function choosePrimaryContextItem(left: ContextItem, right: ContextItem): ContextItem {
  const priorityDelta = right.priority - left.priority;
  if (priorityDelta !== 0) {
    return priorityDelta > 0 ? right : left;
  }

  const scoreDelta = rawContextItemScore(right) - rawContextItemScore(left);
  if (scoreDelta !== 0) {
    return scoreDelta > 0 ? right : left;
  }

  return right.contextItemId.localeCompare(left.contextItemId) < 0 ? right : left;
}

/** Applies normalized ranking score and merge trace metadata to one context item. */
function applyRankingMetadata(
  state: ContextItemMergeState,
  input: {
    /** Normalized score in the 0..1 range. */
    readonly score: number;
    /** Source ranks that contributed to this merged item. */
    readonly sourceRanks: ReadonlyMap<string, number>;
    /** Source scores that contributed to this merged item. */
    readonly sourceScores: ReadonlyMap<string, number>;
  },
): ContextItem {
  const sourceTypes = [...state.sourceTypes].sort();
  const mergedFrom = state.candidates.map((candidate) => candidate.contextItemId);
  const metadata = {
    ...(state.primary.metadata ?? {}),
    ranking: {
      mergeKey: state.mergeKey,
      mergedCandidateCount: state.candidates.length,
      mergedFrom,
      sourceRanks: numberMapToRecord(input.sourceRanks),
      sourceScores: numberMapToRecord(input.sourceScores),
      sourceTypes,
      strategy: "weighted_reciprocal_rank_fusion_v1",
    },
  };

  return {
    ...state.primary,
    metadata,
    score: input.score,
  };
}

/** Builds one product-safe ranking trace row for bundle metadata. */
function rankingTraceItem(item: ContextItem, index: number): RetrievalRankingTraceItem {
  const ranking = contextItemRankingMetadata(item);
  const mergedFrom = stringArrayMetadataValue(ranking, "mergedFrom");

  return {
    contextItemId: item.contextItemId,
    kind: item.kind,
    ...(mergedFrom.length > 1 ? { mergedFrom } : {}),
    priority: item.priority,
    reason: item.provenance.reason,
    rank: index + 1,
    retriever: item.provenance.retriever,
    score: roundRankingScore(item.score ?? 0),
    source: item.source,
    sourceTypes: stringArrayMetadataValue(ranking, "sourceTypes"),
  };
}

/** Builds product-safe bundle metadata describing rank fusion and final packing. */
function rankingSummary(
  trace: RetrievalRankingTrace,
  packedItems: PackedContextItems,
): Record<string, unknown> {
  const selectedIds = new Set(packedItems.items.map((item) => item.contextItemId));
  const droppedIds = new Set(packedItems.droppedItems.map((item) => item.contextItemId));

  return {
    candidateItemCount: trace.candidateItemCount,
    duplicateCandidateCount: trace.duplicateCandidateCount,
    droppedItemCount: packedItems.droppedItems.length,
    k: trace.k,
    mergedItemCount: trace.mergedItemCount,
    selectedItemCount: packedItems.items.length,
    selectedItems: trace.items.filter((item) => selectedIds.has(item.contextItemId)),
    droppedItems: trace.items.filter((item) => droppedIds.has(item.contextItemId)),
    sourceWeights: RANK_FUSION_SOURCE_WEIGHTS,
    strategy: trace.strategy,
  };
}

/** Returns the stable merge key for duplicate context candidates. */
function contextItemMergeKey(item: ContextItem): string {
  if (item.snippet?.chunkId) {
    return `chunk:${item.snippet.chunkId}`;
  }
  if (item.kind === "changed_symbol" && item.provenance.relatedSymbolId) {
    return `symbol:${item.provenance.relatedSymbolId}`;
  }

  const memoryFactId = metadataStringValue(item.metadata, "memoryFactId");
  if (memoryFactId) {
    return `memory:${memoryFactId}`;
  }

  const ruleId = metadataStringValue(item.metadata, "ruleId");
  if (ruleId) {
    return `rule:${ruleId}`;
  }

  if (item.snippet) {
    return [
      "snippet",
      item.snippet.path,
      item.snippet.range.startLine,
      item.snippet.range.endLine,
      item.snippet.contentHash ?? stableId("text", [item.snippet.text]),
    ].join(":");
  }

  return `item:${item.contextItemId}`;
}

/** Returns the rank-fusion source type for a context item. */
function rankingSourceType(item: ContextItem): string {
  if (item.source === "full_text_search") return "lexical_match";
  if (item.source === "vector_search") return "semantic_match";
  if (item.kind === "caller") return "direct_caller";
  if (item.kind === "callee") return "direct_callee";
  if (item.kind === "same_file_context") return "same_file";
  if (item.kind === "dependency") return "dependency_manifest";
  if (item.kind === "config") return "config";
  if (item.kind === "related_test") return "related_test";
  if (item.kind === "repo_rule") return "repo_rule";
  if (item.kind === "memory_fact") return "memory_fact";
  if (item.kind === "static_analysis") return "static_analysis";

  return item.kind;
}

/** Compares raw items inside one source list before rank assignment. */
function compareRawContextItemsForSourceRank(left: ContextItem, right: ContextItem): number {
  return (
    rawContextItemScore(right) - rawContextItemScore(left) ||
    right.priority - left.priority ||
    left.tokenEstimate - right.tokenEstimate ||
    left.contextItemId.localeCompare(right.contextItemId)
  );
}

/** Compares scored merge states for final item order. */
function compareScoredContextItemMergeStates(
  left: ScoredContextItemMergeState,
  right: ScoredContextItemMergeState,
): number {
  return (
    right.adjustedScore - left.adjustedScore ||
    right.state.primary.priority - left.state.primary.priority ||
    left.state.primary.tokenEstimate - right.state.primary.tokenEstimate ||
    left.state.primary.contextItemId.localeCompare(right.state.primary.contextItemId)
  );
}

/** Returns a raw score for source-local ranking before RRF. */
function rawContextItemScore(item: ContextItem): number {
  return item.score ?? item.priority / 100;
}

/** Returns a fallback score for items that do not receive source observations. */
function fallbackRankScore(item: ContextItem): number {
  return item.priority / (100 * RANK_FUSION_K);
}

/** Applies small deterministic domain adjustments after RRF scoring. */
function rankingMultiplierForContextItem(
  item: ContextItem,
  changedFiles: readonly ChangedFile[],
): number {
  const changedFile = changedFiles.find((file) => file.path === contextItemPath(item));
  let multiplier = changedFile ? 1.15 : 1;

  if (item.kind === "repo_rule" && item.priority >= 95) {
    multiplier *= 1.4;
  }
  if (item.kind === "memory_fact") {
    multiplier *= 1.1;
  }
  if (changedFile?.isGenerated || metadataBooleanValue(item.metadata, "isGenerated")) {
    multiplier *= 0.65;
  }
  if (item.tokenEstimate > 2000) {
    multiplier *= 0.75;
  } else if (item.tokenEstimate > 1000) {
    multiplier *= 0.85;
  }

  return multiplier;
}

/** Returns the path associated with a context item when metadata exposes one. */
function contextItemPath(item: ContextItem): string | undefined {
  return (
    item.snippet?.path ??
    metadataStringValue(item.metadata, "path") ??
    metadataStringValue(item.metadata, "manifestPath")
  );
}

/** Normalizes a raw score against the maximum score in the ranked set. */
function normalizeRankingScore(score: number, maxScore: number): number {
  if (maxScore <= 0) {
    return 0;
  }

  return roundRankingScore(Math.max(0, Math.min(1, score / maxScore)));
}

/** Rounds a rank-fusion score for stable metadata snapshots. */
function roundRankingScore(score: number): number {
  return Math.round(score * 1_000_000) / 1_000_000;
}

/** Sets a number inside a nested map. */
function setNestedNumber(
  target: Map<string, Map<string, number>>,
  outerKey: string,
  innerKey: string,
  value: number,
): void {
  const inner = target.get(outerKey) ?? new Map<string, number>();
  inner.set(innerKey, value);
  target.set(outerKey, inner);
}

/** Converts a string-keyed number map to a stable record. */
function numberMapToRecord(values: ReadonlyMap<string, number>): Record<string, number> {
  const record: Record<string, number> = {};
  for (const [key, value] of [...values].sort(([left], [right]) => left.localeCompare(right))) {
    record[key] = roundRankingScore(value);
  }

  return record;
}

/** Reads a string metadata field if present. */
function metadataStringValue(
  metadata: ContextItem["metadata"] | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];

  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Reads a boolean metadata field if present. */
function metadataBooleanValue(metadata: ContextItem["metadata"] | undefined, key: string): boolean {
  return metadata?.[key] === true;
}

/** Reads ranking metadata from a context item. */
function contextItemRankingMetadata(item: ContextItem): Record<string, unknown> {
  const ranking = item.metadata?.ranking;

  return ranking && typeof ranking === "object" && !Array.isArray(ranking)
    ? (ranking as Record<string, unknown>)
    : {};
}

/** Reads a string-array field from a metadata record. */
function stringArrayMetadataValue(
  metadata: Record<string, unknown>,
  key: string,
): readonly string[] {
  const value = metadata[key];

  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** Returns unique strings while preserving first-seen order. */
function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

/** Normalizes labels, authors, and similar exact-match strings. */
function normalizeComparable(value: string): string {
  return value.trim().toLowerCase();
}

function priorityForKind(kind: ContextItem["kind"]): number {
  if (kind === "same_file_context") return 86;
  if (kind === "related_test") return 78;
  if (kind === "callee") return 70;
  if (kind === "similar_pattern") return 60;
  return 50;
}

function languageForContext(language: string): CodeSnippet["language"] {
  if (
    language === "typescript" ||
    language === "javascript" ||
    language === "tsx" ||
    language === "jsx" ||
    language === "python" ||
    language === "go" ||
    language === "rust" ||
    language === "java" ||
    language === "kotlin" ||
    language === "csharp" ||
    language === "cpp" ||
    language === "c" ||
    language === "ruby" ||
    language === "php" ||
    language === "swift"
  ) {
    return language;
  }

  return "unknown";
}

function packItems(items: readonly ContextItem[], maxTokens: number): PackedContextItems {
  const packed: ContextItem[] = [];
  const dropped: ContextItem[] = [];
  let usedTokens = 0;

  for (const item of [...items].sort(comparePackedContextItems)) {
    if (usedTokens + item.tokenEstimate > maxTokens) {
      dropped.push(item);
      continue;
    }
    packed.push(item);
    usedTokens += item.tokenEstimate;
  }

  return { droppedItems: dropped, items: packed };
}

/** Sorts ranked context items for token-budget packing. */
function comparePackedContextItems(left: ContextItem, right: ContextItem): number {
  return (
    (right.score ?? 0) - (left.score ?? 0) ||
    right.priority - left.priority ||
    left.tokenEstimate - right.tokenEstimate ||
    left.contextItemId.localeCompare(right.contextItemId)
  );
}

/** Combines retriever warnings with token-budget packing warnings. */
function retrievalWarnings(
  indexedWarnings: readonly RetrievalWarning[],
  packedItems: PackedContextItems,
): readonly RetrievalWarning[] {
  if (packedItems.droppedItems.length === 0) {
    return indexedWarnings;
  }

  return [
    ...indexedWarnings,
    {
      retriever: "context-packer",
      code: "token_budget_exceeded",
      message: "Context token budget excluded one or more lower-priority retrieval items.",
    },
  ];
}

/** Builds a product-safe summary of selected and dropped context item counts. */
function packingSummary(
  candidateItems: readonly ContextItem[],
  packedItems: PackedContextItems,
): Record<string, unknown> {
  return {
    candidateItemCount: candidateItems.length,
    selectedItemCount: packedItems.items.length,
    droppedItemCount: packedItems.droppedItems.length,
    droppedTokenEstimate: packedItems.droppedItems.reduce(
      (total, item) => total + item.tokenEstimate,
      0,
    ),
    droppedSources: countContextItemsBySafeKey(packedItems.droppedItems, (item) => item.source),
    droppedKinds: countContextItemsBySafeKey(packedItems.droppedItems, (item) => item.kind),
  };
}

/** Counts context items by bounded non-content labels. */
function countContextItemsBySafeKey(
  items: readonly ContextItem[],
  key: (item: ContextItem) => string,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const normalizedKey = normalizeRetrievalLabel(key(item), "unknown");
    counts[normalizedKey] = (counts[normalizedKey] ?? 0) + 1;
  }

  return counts;
}

function prefixForLine(kind: "context" | "addition" | "deletion"): string {
  return kind === "addition" ? "+" : kind === "deletion" ? "-" : " ";
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function stableId(prefix: string, parts: readonly unknown[]): string {
  const hash = createHash("sha256")
    .update(parts.map((part) => String(part)).join(":"))
    .digest("base64url")
    .slice(0, 26);

  return `${prefix}_${hash}`;
}
