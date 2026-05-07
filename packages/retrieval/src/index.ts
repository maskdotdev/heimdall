import { createHash } from "node:crypto";
import { ContextBundleSchema, type FindingCategory, parseWithSchema } from "@repo/contracts";
import type { ChangedFile } from "@repo/contracts/pull-request/diff";
import type { PullRequestSnapshot } from "@repo/contracts/pull-request/pull-request";
import type { CodeSnippet, ContextBundle, ContextItem } from "@repo/contracts/review/context";
import {
  codeChunkEmbeddings,
  codeChunks,
  codeEdges,
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
  /** Symbol kind. */
  readonly kind: string;
  /** 1-based start line. */
  readonly startLine: number;
  /** 1-based end line. */
  readonly endLine: number;
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
  /** Returns likely related test chunks. */
  readonly getRelatedTestChunks: (paths: readonly string[]) => Promise<readonly RetrievalChunk[]>;
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
  /** Timestamp used for deterministic tests. */
  readonly timestamp?: string;
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
  /** Non-fatal warnings from optional indexed retrievers. */
  readonly warnings: readonly RetrievalWarning[];
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

/** Retrieves a compact context bundle, falling back to diff context when indexes are missing. */
export async function retrieveContext(input: RetrieveContextInput): Promise<ContextBundle> {
  const maxTokens = input.maxTokens ?? 8000;
  const timestamp = input.timestamp ?? new Date().toISOString();
  const diffItems = input.snapshot.changedFiles.flatMap((file) => contextItemsForFile(file));
  const indexedResult = input.index
    ? await retrieveIndexedItems({ ...input, index: input.index }, diffItems)
    : { items: [], warnings: [] };
  const memoryResult = input.memory
    ? await retrieveMemoryItems({ ...input, memory: input.memory }, timestamp)
    : { factIds: [], items: [], trace: [] };
  const items = packItems(
    input.indexAvailable === false || !input.index
      ? [...memoryResult.items, ...withFallbackRule(diffItems)]
      : [...memoryResult.items, ...indexedResult.items, ...diffItems],
    maxTokens,
  );

  return parseWithSchema("ContextBundle", ContextBundleSchema, {
    schemaVersion: "context_bundle.v1",
    contextBundleId: stableId("ctx", [
      input.reviewRunId,
      input.snapshot.snapshotId,
      input.indexAvailable === false ? "diff-fallback" : "indexed",
      memoryResult.factIds.join(","),
    ]),
    reviewRunId: input.reviewRunId,
    repoId: input.snapshot.repoId,
    pullRequestSnapshotId: input.snapshot.snapshotId,
    baseSha: input.snapshot.baseSha,
    headSha: input.snapshot.headSha,
    changedFiles: input.snapshot.changedFiles,
    changedSymbols: [],
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
      ...(memoryResult.trace.length > 0
        ? {
            memory: {
              includedFactIds: memoryResult.factIds,
              trace: memoryResult.trace,
            },
          }
        : {}),
      ...(indexedResult.warnings.length > 0 ? { warnings: indexedResult.warnings } : {}),
    },
  });
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
          name: symbols.name,
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
    getRelatedTestChunks: async (paths) => {
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

        return rows.map((row) => ({ ...toRetrievalChunk(row.chunk), score: row.score }));
      }

      const terms = new Set(
        query
          .toLowerCase()
          .split(/[^a-z0-9_]+/)
          .filter((term) => term.length > 2),
      );
      const rows = await options.db
        .select()
        .from(codeChunks)
        .where(eq(codeChunks.indexVersionId, options.indexVersionId));
      return rows
        .map(toRetrievalChunk)
        .map((chunk) => ({
          ...chunk,
          score: [...terms].filter((term) => chunk.text.toLowerCase().includes(term)).length,
        }))
        .filter((chunk) => (chunk.score ?? 0) > 0)
        .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
        .slice(0, limit);
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
  const symbolIds = symbolsForFiles.map((symbol) => symbol.symbolId);
  const [relatedResult, relatedTestsResult, similarResult] = await Promise.all([
    retrieveOptionalIndexItems("symbol-graph", "graph_retrieval_failed", () =>
      input.index.getRelatedChunks(symbolIds),
    ),
    retrieveOptionalIndexItems("related-tests", "test_retrieval_failed", () =>
      input.index.getRelatedTestChunks(paths),
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
      ...symbolsForFiles.map(symbolItem),
      ...relatedResult.items.map((chunk) =>
        chunkItem(
          chunk,
          chunk.relationKind ?? "callee",
          `${chunk.relationKind === "caller" ? "Caller" : "Callee"} indexed context.`,
        ),
      ),
      ...relatedTestsResult.items.map((chunk) =>
        chunkItem(chunk, "related_test", "Related test context."),
      ),
      ...similarResult.items.map((chunk) =>
        chunkItem(chunk, "similar_pattern", "Vector or lexical search related context."),
      ),
    ]),
    warnings: [
      ...relatedResult.warnings,
      ...relatedTestsResult.warnings,
      ...similarResult.warnings,
    ],
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
    source: kind === "similar_pattern" ? "vector_search" : "symbol_graph",
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

function dedupeContextItems(items: readonly ContextItem[]): readonly ContextItem[] {
  const seen = new Set<string>();
  const deduped: ContextItem[] = [];

  for (const item of items) {
    const key = item.snippet?.chunkId ?? item.provenance.relatedSymbolId ?? item.contextItemId;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
  }

  return deduped;
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

function packItems(items: readonly ContextItem[], maxTokens: number): readonly ContextItem[] {
  const packed: ContextItem[] = [];
  let usedTokens = 0;

  for (const item of [...items].sort((left, right) => right.priority - left.priority)) {
    if (usedTokens + item.tokenEstimate > maxTokens) {
      continue;
    }
    packed.push(item);
    usedTokens += item.tokenEstimate;
  }

  return packed;
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
