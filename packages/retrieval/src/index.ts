import { createHash } from "node:crypto";
import {
  type ChangedSymbol,
  ContextBundleSchema,
  type FindingCategory,
  parseWithSchema,
  type RepoRule,
  type SymbolKind,
} from "@repo/contracts";
import type { ChangedFile } from "@repo/contracts/pull-request/diff";
import type { PullRequestSnapshot } from "@repo/contracts/pull-request/pull-request";
import type { CodeSnippet, ContextBundle, ContextItem } from "@repo/contracts/review/context";
import {
  codeChunkEmbeddings,
  codeChunks,
  codeDependencies,
  codeEdges,
  codeRoutes,
  codeTestMappings,
  type HeimdallDatabase,
  indexedFiles,
  symbols,
} from "@repo/db";
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
import { and, eq, inArray, or, sql } from "drizzle-orm";

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
    const packedItems = packItems(candidateItems, maxTokens);
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
  return {
    indexVersionId: options.indexVersionId,
    getSameFileChunks: async (paths) => chunksForPaths(options.db, options.indexVersionId, paths),
    getSymbolsForFiles: async (paths) => {
      if (paths.length === 0) return [];
      return options.db
        .select({
          symbolId: symbols.symbolId,
          fileId: symbols.fileId,
          path: symbols.path,
          language: symbols.language,
          name: symbols.name,
          qualifiedName: symbols.qualifiedName,
          kind: symbols.kind,
          startLine: symbols.startLine,
          endLine: symbols.endLine,
        })
        .from(symbols)
        .where(
          and(
            eq(symbols.indexVersionId, options.indexVersionId),
            inArray(symbols.path, [...paths]),
          ),
        );
    },
    getRelatedChunks: async (symbolIds) => {
      if (symbolIds.length === 0) return [];
      const edges = await options.db
        .select({ fromId: codeEdges.fromId, toId: codeEdges.toId })
        .from(codeEdges)
        .where(
          and(
            eq(codeEdges.indexVersionId, options.indexVersionId),
            or(inArray(codeEdges.fromId, [...symbolIds]), inArray(codeEdges.toId, [...symbolIds])),
          ),
        );
      const relationBySymbolId = new Map<string, "caller" | "callee">();
      for (const edge of edges) {
        if (symbolIds.includes(edge.fromId) && !symbolIds.includes(edge.toId)) {
          relationBySymbolId.set(edge.toId, "callee");
        }
        if (symbolIds.includes(edge.toId) && !symbolIds.includes(edge.fromId)) {
          relationBySymbolId.set(edge.fromId, "caller");
        }
      }
      const relatedIds = [...relationBySymbolId.keys()];
      if (relatedIds.length === 0) return [];
      const rows = await options.db
        .select()
        .from(codeChunks)
        .where(
          and(
            eq(codeChunks.indexVersionId, options.indexVersionId),
            inArray(codeChunks.symbolId, relatedIds),
          ),
        );
      return rows.map((row) => {
        const chunk = toRetrievalChunk(row);
        const relationKind = row.symbolId ? relationBySymbolId.get(row.symbolId) : undefined;
        return relationKind ? { ...chunk, relationKind } : chunk;
      });
    },
    getDependenciesForFiles: async (paths) => {
      if (paths.length === 0) return [];
      return options.db
        .select({
          dependencyId: codeDependencies.dependencyId,
          manifestPath: codeDependencies.manifestPath,
          packageManager: codeDependencies.packageManager,
          name: codeDependencies.name,
          versionSpec: codeDependencies.versionSpec,
          resolvedVersion: codeDependencies.resolvedVersion,
          dependencyType: codeDependencies.dependencyType,
        })
        .from(codeDependencies)
        .where(
          and(
            eq(codeDependencies.indexVersionId, options.indexVersionId),
            inArray(codeDependencies.manifestPath, [...paths]),
          ),
        );
    },
    getRoutesForFiles: async (paths) => {
      if (paths.length === 0) return [];
      const rows = await options.db
        .select({
          routeId: codeRoutes.routeId,
          path: codeRoutes.path,
          language: codeRoutes.language,
          routePattern: codeRoutes.routePattern,
          methods: codeRoutes.methods,
          handlerSymbolId: codeRoutes.handlerSymbolId,
          startLine: codeRoutes.startLine,
          endLine: codeRoutes.endLine,
          framework: codeRoutes.framework,
          confidence: codeRoutes.confidence,
        })
        .from(codeRoutes)
        .where(
          and(
            eq(codeRoutes.indexVersionId, options.indexVersionId),
            inArray(codeRoutes.path, [...paths]),
          ),
        );

      return rows.map((row) => ({
        ...row,
        methods: jsonStringArray(row.methods),
      }));
    },
    getRelatedTestChunks: async (paths) => {
      if (paths.length === 0) return [];

      const changedFiles = await options.db
        .select({ fileId: indexedFiles.fileId })
        .from(indexedFiles)
        .where(
          and(
            eq(indexedFiles.indexVersionId, options.indexVersionId),
            inArray(indexedFiles.path, [...paths]),
          ),
        );
      const changedFileIds = changedFiles.map((file) => file.fileId);
      if (changedFileIds.length > 0) {
        const mappings = await options.db
          .select({ testFileId: codeTestMappings.testFileId })
          .from(codeTestMappings)
          .where(
            and(
              eq(codeTestMappings.indexVersionId, options.indexVersionId),
              inArray(codeTestMappings.targetFileId, changedFileIds),
            ),
          );
        const testFileIds = uniqueStrings(mappings.map((mapping) => mapping.testFileId));
        if (testFileIds.length > 0) {
          const rows = await options.db
            .select()
            .from(codeChunks)
            .where(
              and(
                eq(codeChunks.indexVersionId, options.indexVersionId),
                inArray(codeChunks.fileId, testFileIds),
              ),
            );
          return rows.map(toRetrievalChunk);
        }
      }

      const stems = paths
        .map((path) =>
          path
            .split("/")
            .at(-1)
            ?.replace(/\.[^.]+$/, ""),
        )
        .filter(Boolean);
      const rows = await options.db
        .select({
          chunk: codeChunks,
          file: indexedFiles,
        })
        .from(codeChunks)
        .innerJoin(indexedFiles, eq(codeChunks.fileId, indexedFiles.fileId))
        .where(
          and(eq(codeChunks.indexVersionId, options.indexVersionId), eq(indexedFiles.isTest, true)),
        );
      return rows
        .filter(({ file }) => stems.some((stem) => file.path.includes(stem ?? "")))
        .map(({ chunk }) => toRetrievalChunk(chunk));
    },
    searchFullTextChunks: async (query, limit) =>
      searchFullTextChunks(options.db, options.indexVersionId, query, limit),
    searchSimilarChunks: async (query, limit) => {
      if (options.embedQuery) {
        const queryVector = await options.embedQuery(query);
        const vectorText = `[${queryVector.join(",")}]`;
        const rows = await options.db
          .select({
            chunk: codeChunks,
            score: sql<number>`1 - (${codeChunkEmbeddings.embedding} <=> ${vectorText}::vector)`,
          })
          .from(codeChunkEmbeddings)
          .innerJoin(codeChunks, eq(codeChunkEmbeddings.chunkId, codeChunks.chunkId))
          .where(
            and(
              eq(codeChunkEmbeddings.indexVersionId, options.indexVersionId),
              eq(
                codeChunkEmbeddings.embeddingModel,
                options.embeddingModel ?? "text-embedding-3-small",
              ),
            ),
          )
          .orderBy(sql`${codeChunkEmbeddings.embedding} <=> ${vectorText}::vector`)
          .limit(limit);

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
    items: dedupeContextItems([
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
    ]),
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

async function chunksForPaths(
  db: HeimdallDatabase,
  indexVersionId: string,
  paths: readonly string[],
): Promise<readonly RetrievalChunk[]> {
  if (paths.length === 0) {
    return [];
  }

  const rows = await db
    .select()
    .from(codeChunks)
    .where(
      and(eq(codeChunks.indexVersionId, indexVersionId), inArray(codeChunks.path, [...paths])),
    );

  return rows.map(toRetrievalChunk);
}

/** Runs PostgreSQL full-text search over indexed chunk text metadata. */
async function searchFullTextChunks(
  db: HeimdallDatabase,
  indexVersionId: string,
  query: string,
  limit: number,
): Promise<readonly RetrievalChunk[]> {
  const fullTextQuery = normalizeFullTextQuery(query);
  if (fullTextQuery.length === 0 || limit <= 0) {
    return [];
  }

  const chunkText = sql<string>`coalesce(${codeChunks.metadata}->>'text', '')`;
  const searchVector = sql`to_tsvector('simple', ${chunkText})`;
  const queryExpression = sql`plainto_tsquery('simple', ${fullTextQuery})`;
  const scoreExpression = sql<number>`ts_rank_cd(${searchVector}, ${queryExpression})`;
  const rows = await db
    .select({
      chunk: codeChunks,
      score: scoreExpression,
    })
    .from(codeChunks)
    .where(
      and(
        eq(codeChunks.indexVersionId, indexVersionId),
        sql`${searchVector} @@ ${queryExpression}`,
      ),
    )
    .orderBy(sql`${scoreExpression} DESC`)
    .limit(limit);

  return rows.map((row) => ({
    ...toRetrievalChunk(row.chunk),
    score: row.score,
    searchSource: "full_text_search",
  }));
}

function toRetrievalChunk(row: typeof codeChunks.$inferSelect): RetrievalChunk {
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
    symbolId: row.symbolId,
    path: row.path,
    startLine: row.startLine,
    endLine: row.endLine,
    language,
    contentHash: row.contentHash,
    text,
    tokenEstimate,
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

function dedupeContextItems(items: readonly ContextItem[]): readonly ContextItem[] {
  const seen = new Set<string>();
  const deduped: ContextItem[] = [];

  for (const item of items) {
    const key =
      item.snippet?.chunkId ??
      (item.kind === "changed_symbol" ? item.provenance.relatedSymbolId : undefined) ??
      item.contextItemId;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
  }

  return deduped;
}

function jsonStringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

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

/** Builds a bounded plain-text query for PostgreSQL full-text search. */
function normalizeFullTextQuery(query: string): string {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9_]+/u)
    .filter((term) => term.length > 2);

  return [...new Set(terms)].slice(0, 32).join(" ");
}

function packItems(items: readonly ContextItem[], maxTokens: number): PackedContextItems {
  const packed: ContextItem[] = [];
  const dropped: ContextItem[] = [];
  let usedTokens = 0;

  for (const item of [...items].sort((left, right) => right.priority - left.priority)) {
    if (usedTokens + item.tokenEstimate > maxTokens) {
      dropped.push(item);
      continue;
    }
    packed.push(item);
    usedTokens += item.tokenEstimate;
  }

  return { droppedItems: dropped, items: packed };
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
