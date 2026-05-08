import {
  type ChunkRecord,
  ChunkRecordSchema,
  type CodeEdgeKind,
  type DependencyRecord,
  DependencyRecordSchema,
  type EdgeRecord,
  EdgeRecordSchema,
  INDEX_RECORD_SCHEMA_VERSION,
  parseWithSchema,
  type RouteRecord,
  RouteRecordSchema,
  type SymbolRecord,
  SymbolRecordSchema,
} from "@repo/contracts";
import { and, asc, desc, eq, gte, inArray, lte, or, type SQL, sql } from "drizzle-orm";
import type { HeimdallDatabase } from "../client";
import {
  codeChunks,
  codeDependencies,
  codeEdges,
  codeIndexVersions,
  codeRoutes,
  codeTestMappings,
  indexedFiles,
  symbols,
} from "../schema";

/** Lookup input for finding the innermost symbol at a source line. */
export type FindSymbolAtLineInput = {
  /** Repository ID that owns the indexed symbol rows. */
  readonly repoId: string;
  /** Commit SHA for the indexed source. */
  readonly commitSha: string;
  /** Repository-relative source path. */
  readonly path: string;
  /** One-based source line to match. */
  readonly line: number;
};

/** Lookup input for listing symbols from one indexed file. */
export type ListSymbolsForFileInput = {
  /** Index version ID to query. */
  readonly indexVersionId: string;
  /** Repository-relative source path. */
  readonly path: string;
};

/** Lookup input for listing chunks from one indexed file. */
export type ListChunksForFileInput = {
  /** Index version ID to query. */
  readonly indexVersionId: string;
  /** Repository-relative source path. */
  readonly path: string;
};

/** Lookup input for listing symbols from multiple indexed files. */
export type ListSymbolsForPathsInput = {
  /** Index version ID to query. */
  readonly indexVersionId: string;
  /** Repository-relative source paths. */
  readonly paths: readonly string[];
};

/** Lookup input for listing chunks from multiple indexed files. */
export type ListChunksForPathsInput = {
  /** Index version ID to query. */
  readonly indexVersionId: string;
  /** Repository-relative source paths. */
  readonly paths: readonly string[];
};

/** Lookup input for listing edges attached to a source symbol. */
export type ListSymbolEdgesInput = {
  /** Symbol ID to use as the edge endpoint. */
  readonly symbolId: string;
  /** Optional edge kind filter. */
  readonly kinds?: readonly CodeEdgeKind[];
};

/** Lookup input for listing graph-related chunks for changed symbols. */
export type ListRelatedChunksForSymbolsInput = {
  /** Index version ID to query. */
  readonly indexVersionId: string;
  /** Changed symbol IDs to use as graph anchors. */
  readonly symbolIds: readonly string[];
};

/** Chunk related to a changed symbol through the imported graph. */
export type RelatedChunkRecord = {
  /** Imported chunk record. */
  readonly chunk: ChunkRecord;
  /** Direction relative to the changed symbol. */
  readonly relationKind: "caller" | "callee";
};

/** Lookup input for dependency rows declared by changed manifest files. */
export type ListDependenciesForFilesInput = {
  /** Index version ID to query. */
  readonly indexVersionId: string;
  /** Repository-relative changed paths. */
  readonly paths: readonly string[];
};

/** Lookup input for route rows declared by changed source files. */
export type ListRoutesForFilesInput = {
  /** Index version ID to query. */
  readonly indexVersionId: string;
  /** Repository-relative changed paths. */
  readonly paths: readonly string[];
};

/** Lookup input for chunks from test files related to changed source files. */
export type ListRelatedTestChunksInput = {
  /** Index version ID to query. */
  readonly indexVersionId: string;
  /** Repository-relative changed source paths. */
  readonly sourcePaths: readonly string[];
};

/** Lookup input for PostgreSQL full-text search over indexed chunk text. */
export type SearchFullTextChunksInput = {
  /** Index version ID to query. */
  readonly indexVersionId: string;
  /** Search query text. */
  readonly query: string;
  /** Maximum number of chunks to return. */
  readonly limit: number;
};

/** Chunk returned with a search score. */
export type ScoredChunkRecord = {
  /** Imported chunk record. */
  readonly chunk: ChunkRecord;
  /** Search rank score. */
  readonly score: number;
};

type SymbolRow = typeof symbols.$inferSelect;
type CodeChunkRow = typeof codeChunks.$inferSelect;
type CodeEdgeRow = typeof codeEdges.$inferSelect;
type DependencyRow = typeof codeDependencies.$inferSelect;
type RouteRow = typeof codeRoutes.$inferSelect;

/** Query helper for imported code-intelligence records. */
export class CodeIntelligenceRepository {
  /** Creates a code-intelligence query helper. */
  public constructor(private readonly db: HeimdallDatabase) {}

  /** Finds the innermost ready-index symbol that contains a source line. */
  public async findSymbolAtLine(input: FindSymbolAtLineInput): Promise<SymbolRecord | undefined> {
    const [row] = await this.db
      .select({ symbol: symbols })
      .from(symbols)
      .innerJoin(codeIndexVersions, eq(symbols.indexVersionId, codeIndexVersions.indexVersionId))
      .where(
        and(
          eq(symbols.repoId, input.repoId),
          eq(symbols.commitSha, input.commitSha),
          eq(symbols.path, input.path),
          lte(symbols.startLine, input.line),
          gte(symbols.endLine, input.line),
          eq(codeIndexVersions.status, "ready"),
        ),
      )
      .orderBy(
        desc(codeIndexVersions.completedAt),
        asc(sql<number>`${symbols.endLine} - ${symbols.startLine}`),
        desc(symbols.startLine),
      )
      .limit(1);

    return row ? toSymbolRecord(row.symbol) : undefined;
  }

  /** Lists imported symbols for one indexed file in source order. */
  public async listSymbolsForFile(
    input: ListSymbolsForFileInput,
  ): Promise<readonly SymbolRecord[]> {
    return this.listSymbolsForPaths({ indexVersionId: input.indexVersionId, paths: [input.path] });
  }

  /** Lists imported symbols for indexed files in source order. */
  public async listSymbolsForPaths(
    input: ListSymbolsForPathsInput,
  ): Promise<readonly SymbolRecord[]> {
    const paths = uniqueStrings(input.paths);
    if (paths.length === 0) {
      return [];
    }

    const rows = await this.db
      .select()
      .from(symbols)
      .where(and(eq(symbols.indexVersionId, input.indexVersionId), inArray(symbols.path, paths)))
      .orderBy(asc(symbols.path), asc(symbols.startLine), asc(symbols.endLine), asc(symbols.name));

    return rows.map(toSymbolRecord);
  }

  /** Lists imported chunks for one indexed file in source order. */
  public async listChunksForFile(input: ListChunksForFileInput): Promise<readonly ChunkRecord[]> {
    return this.listChunksForPaths({ indexVersionId: input.indexVersionId, paths: [input.path] });
  }

  /** Lists imported chunks for indexed files in source order. */
  public async listChunksForPaths(input: ListChunksForPathsInput): Promise<readonly ChunkRecord[]> {
    const paths = uniqueStrings(input.paths);
    if (paths.length === 0) {
      return [];
    }

    const rows = await this.db
      .select({ chunk: codeChunks, commitSha: codeIndexVersions.commitSha })
      .from(codeChunks)
      .innerJoin(codeIndexVersions, eq(codeChunks.indexVersionId, codeIndexVersions.indexVersionId))
      .where(
        and(eq(codeChunks.indexVersionId, input.indexVersionId), inArray(codeChunks.path, paths)),
      )
      .orderBy(
        asc(codeChunks.path),
        asc(codeChunks.startLine),
        asc(codeChunks.endLine),
        asc(codeChunks.chunkId),
      );

    return rows.map((row) => toChunkRecord(row.chunk, row.commitSha));
  }

  /** Lists graph edges where the symbol is the source endpoint. */
  public async listEdgesFromSymbol(input: ListSymbolEdgesInput): Promise<readonly EdgeRecord[]> {
    const rows = await this.db
      .select()
      .from(codeEdges)
      .where(edgeEndpointCondition(codeEdges.fromId, input))
      .orderBy(asc(codeEdges.kind), asc(codeEdges.toId), asc(codeEdges.edgeId));

    return rows.map(toEdgeRecord);
  }

  /** Lists graph edges where the symbol is the target endpoint. */
  public async listEdgesToSymbol(input: ListSymbolEdgesInput): Promise<readonly EdgeRecord[]> {
    const rows = await this.db
      .select()
      .from(codeEdges)
      .where(edgeEndpointCondition(codeEdges.toId, input))
      .orderBy(asc(codeEdges.kind), asc(codeEdges.fromId), asc(codeEdges.edgeId));

    return rows.map(toEdgeRecord);
  }

  /** Lists chunks connected to changed symbols by imported graph edges. */
  public async listRelatedChunksForSymbols(
    input: ListRelatedChunksForSymbolsInput,
  ): Promise<readonly RelatedChunkRecord[]> {
    const symbolIds = uniqueStrings(input.symbolIds);
    if (symbolIds.length === 0) {
      return [];
    }

    const endpointCondition = orInEndpoints(codeEdges.fromId, codeEdges.toId, symbolIds);
    if (!endpointCondition) {
      return [];
    }

    const edges = await this.db
      .select({ fromId: codeEdges.fromId, toId: codeEdges.toId })
      .from(codeEdges)
      .where(and(eq(codeEdges.indexVersionId, input.indexVersionId), endpointCondition))
      .orderBy(asc(codeEdges.edgeId));
    const relationBySymbolId = new Map<string, "caller" | "callee">();

    for (const edge of edges) {
      if (symbolIds.includes(edge.fromId) && !symbolIds.includes(edge.toId)) {
        relationBySymbolId.set(edge.toId, "callee");
      }
      if (symbolIds.includes(edge.toId) && !symbolIds.includes(edge.fromId)) {
        relationBySymbolId.set(edge.fromId, "caller");
      }
    }

    const relatedIds = uniqueStrings([...relationBySymbolId.keys()]);
    if (relatedIds.length === 0) {
      return [];
    }

    const rows = await this.db
      .select({ chunk: codeChunks, commitSha: codeIndexVersions.commitSha })
      .from(codeChunks)
      .innerJoin(codeIndexVersions, eq(codeChunks.indexVersionId, codeIndexVersions.indexVersionId))
      .where(
        and(
          eq(codeChunks.indexVersionId, input.indexVersionId),
          inArray(codeChunks.symbolId, relatedIds),
        ),
      )
      .orderBy(asc(codeChunks.path), asc(codeChunks.startLine), asc(codeChunks.chunkId));

    return rows.flatMap((row) => {
      const relationKind = row.chunk.symbolId
        ? relationBySymbolId.get(row.chunk.symbolId)
        : undefined;
      return relationKind ? [{ chunk: toChunkRecord(row.chunk, row.commitSha), relationKind }] : [];
    });
  }

  /** Lists dependency records declared by changed manifest files. */
  public async listDependenciesForFiles(
    input: ListDependenciesForFilesInput,
  ): Promise<readonly DependencyRecord[]> {
    const paths = uniqueStrings(input.paths);
    if (paths.length === 0) {
      return [];
    }

    const rows = await this.db
      .select()
      .from(codeDependencies)
      .where(
        and(
          eq(codeDependencies.indexVersionId, input.indexVersionId),
          inArray(codeDependencies.manifestPath, paths),
        ),
      )
      .orderBy(asc(codeDependencies.manifestPath), asc(codeDependencies.name));

    return rows.map(toDependencyRecord);
  }

  /** Lists route records declared by changed source files. */
  public async listRoutesForFiles(input: ListRoutesForFilesInput): Promise<readonly RouteRecord[]> {
    const paths = uniqueStrings(input.paths);
    if (paths.length === 0) {
      return [];
    }

    const rows = await this.db
      .select()
      .from(codeRoutes)
      .where(
        and(eq(codeRoutes.indexVersionId, input.indexVersionId), inArray(codeRoutes.path, paths)),
      )
      .orderBy(asc(codeRoutes.path), asc(codeRoutes.startLine), asc(codeRoutes.routePattern));

    return rows.map(toRouteRecord);
  }

  /** Lists chunks from test files related to changed source paths. */
  public async listRelatedTestChunks(
    input: ListRelatedTestChunksInput,
  ): Promise<readonly ChunkRecord[]> {
    const sourcePaths = uniqueStrings(input.sourcePaths);
    if (sourcePaths.length === 0) {
      return [];
    }

    const changedFiles = await this.db
      .select({ fileId: indexedFiles.fileId })
      .from(indexedFiles)
      .where(
        and(
          eq(indexedFiles.indexVersionId, input.indexVersionId),
          inArray(indexedFiles.path, sourcePaths),
        ),
      );
    const changedFileIds = uniqueStrings(changedFiles.map((file) => file.fileId));
    if (changedFileIds.length > 0) {
      const mappings = await this.db
        .select({ testFileId: codeTestMappings.testFileId })
        .from(codeTestMappings)
        .where(
          and(
            eq(codeTestMappings.indexVersionId, input.indexVersionId),
            inArray(codeTestMappings.targetFileId, changedFileIds),
          ),
        )
        .orderBy(desc(codeTestMappings.confidence), asc(codeTestMappings.testFileId));
      const mappedTestFileIds = uniqueStrings(mappings.map((mapping) => mapping.testFileId));
      const mappedChunks = await this.listChunksForFileIds(input.indexVersionId, mappedTestFileIds);
      if (mappedChunks.length > 0) {
        return mappedChunks;
      }
    }

    return this.listFallbackTestChunks(input.indexVersionId, sourcePaths);
  }

  /** Runs PostgreSQL full-text search over indexed chunk text metadata. */
  public async searchFullTextChunks(
    input: SearchFullTextChunksInput,
  ): Promise<readonly ScoredChunkRecord[]> {
    const fullTextQuery = normalizeFullTextQuery(input.query);
    const limit = boundedResultLimit(input.limit);
    if (fullTextQuery.length === 0 || limit === 0) {
      return [];
    }

    const chunkText = sql<string>`coalesce(${codeChunks.metadata}->>'text', '')`;
    const searchVector = sql`to_tsvector('simple', ${chunkText})`;
    const queryExpression = sql`plainto_tsquery('simple', ${fullTextQuery})`;
    const scoreExpression = sql<number>`ts_rank_cd(${searchVector}, ${queryExpression})`;
    const rows = await this.db
      .select({
        chunk: codeChunks,
        commitSha: codeIndexVersions.commitSha,
        score: scoreExpression,
      })
      .from(codeChunks)
      .innerJoin(codeIndexVersions, eq(codeChunks.indexVersionId, codeIndexVersions.indexVersionId))
      .where(
        and(
          eq(codeChunks.indexVersionId, input.indexVersionId),
          sql`${searchVector} @@ ${queryExpression}`,
        ),
      )
      .orderBy(sql`${scoreExpression} DESC`, asc(codeChunks.chunkId))
      .limit(limit);

    return rows.map((row) => ({
      chunk: toChunkRecord(row.chunk, row.commitSha),
      score: row.score,
    }));
  }

  /** Lists chunks from specific indexed file IDs. */
  private async listChunksForFileIds(
    indexVersionId: string,
    fileIds: readonly string[],
  ): Promise<readonly ChunkRecord[]> {
    const uniqueFileIds = uniqueStrings(fileIds);
    if (uniqueFileIds.length === 0) {
      return [];
    }

    const rows = await this.db
      .select({ chunk: codeChunks, commitSha: codeIndexVersions.commitSha })
      .from(codeChunks)
      .innerJoin(codeIndexVersions, eq(codeChunks.indexVersionId, codeIndexVersions.indexVersionId))
      .where(
        and(
          eq(codeChunks.indexVersionId, indexVersionId),
          inArray(codeChunks.fileId, uniqueFileIds),
        ),
      )
      .orderBy(asc(codeChunks.path), asc(codeChunks.startLine), asc(codeChunks.chunkId));

    return rows.map((row) => toChunkRecord(row.chunk, row.commitSha));
  }

  /** Lists likely test chunks by filename stem when explicit mappings are unavailable. */
  private async listFallbackTestChunks(
    indexVersionId: string,
    sourcePaths: readonly string[],
  ): Promise<readonly ChunkRecord[]> {
    const stems = sourcePaths
      .map((path) =>
        path
          .split("/")
          .at(-1)
          ?.replace(/\.[^.]+$/u, ""),
      )
      .filter(isNonEmptyString);
    if (stems.length === 0) {
      return [];
    }

    const rows = await this.db
      .select({
        chunk: codeChunks,
        commitSha: codeIndexVersions.commitSha,
        filePath: indexedFiles.path,
      })
      .from(codeChunks)
      .innerJoin(indexedFiles, eq(codeChunks.fileId, indexedFiles.fileId))
      .innerJoin(codeIndexVersions, eq(codeChunks.indexVersionId, codeIndexVersions.indexVersionId))
      .where(and(eq(codeChunks.indexVersionId, indexVersionId), eq(indexedFiles.isTest, true)))
      .orderBy(asc(indexedFiles.path), asc(codeChunks.startLine), asc(codeChunks.chunkId));

    return rows
      .filter((row) => stems.some((stem) => row.filePath.includes(stem)))
      .map((row) => toChunkRecord(row.chunk, row.commitSha));
  }
}

/** Converts an imported symbol row into the public index record contract. */
function toSymbolRecord(row: SymbolRow): SymbolRecord {
  const metadata = optionalRecord(row.metadata);
  const signature = metadataString(metadata, "signature");
  const docstring = metadataString(metadata, "docstring");
  const visibility = metadataString(metadata, "visibility");

  return parseWithSchema("SymbolRecord", SymbolRecordSchema, {
    type: "symbol",
    schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
    symbolId: row.symbolId,
    fileId: row.fileId,
    repoId: row.repoId,
    commitSha: row.commitSha,
    path: row.path,
    language: row.language,
    name: row.name,
    ...(row.qualifiedName ? { qualifiedName: row.qualifiedName } : {}),
    kind: row.kind,
    range: { endLine: row.endLine, startLine: row.startLine },
    ...(signature ? { signature } : {}),
    ...(docstring ? { docstring } : {}),
    ...(visibility ? { visibility } : {}),
    ...(metadata ? { metadata } : {}),
    contentHash: row.contentHash,
  });
}

/** Converts an imported chunk row into the public index record contract. */
function toChunkRecord(row: CodeChunkRow, commitSha: string): ChunkRecord {
  const metadata = optionalRecord(row.metadata);
  if (!row.fileId) {
    throw new Error(`Code chunk ${row.chunkId} is missing a file_id.`);
  }

  return parseWithSchema("ChunkRecord", ChunkRecordSchema, {
    type: "chunk",
    schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
    chunkId: row.chunkId,
    fileId: row.fileId,
    ...(row.symbolId ? { symbolId: row.symbolId } : {}),
    repoId: row.repoId,
    commitSha,
    path: row.path,
    language: metadataString(metadata, "language") ?? "unknown",
    range: { endLine: row.endLine, startLine: row.startLine },
    kind: metadataString(metadata, "kind") ?? "unknown",
    text: metadataString(metadata, "text") ?? "",
    contentHash: row.contentHash,
    tokenEstimate: metadataInteger(metadata, "tokenEstimate") ?? 0,
    ...(metadata ? { metadata } : {}),
  });
}

/** Converts an imported edge row into the public index record contract. */
function toEdgeRecord(row: CodeEdgeRow): EdgeRecord {
  const metadata = optionalRecord(row.metadata);

  return parseWithSchema("EdgeRecord", EdgeRecordSchema, {
    type: "edge",
    schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
    edgeId: row.edgeId,
    repoId: row.repoId,
    commitSha: row.commitSha,
    fromId: row.fromId,
    toId: row.toId,
    fromKind: row.fromKind,
    toKind: row.toKind,
    kind: row.kind,
    confidence: row.confidence,
    ...(metadata ? { metadata } : {}),
  });
}

/** Converts an imported dependency row into the public index record contract. */
function toDependencyRecord(row: DependencyRow): DependencyRecord {
  const metadata = optionalRecord(row.metadata);

  return parseWithSchema("DependencyRecord", DependencyRecordSchema, {
    type: "dependency",
    schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
    dependencyId: row.dependencyId,
    repoId: row.repoId,
    commitSha: row.commitSha,
    manifestPath: row.manifestPath,
    ...(row.packageManager ? { packageManager: row.packageManager } : {}),
    name: row.name,
    ...(row.versionSpec ? { versionSpec: row.versionSpec } : {}),
    ...(row.resolvedVersion ? { resolvedVersion: row.resolvedVersion } : {}),
    ...(row.dependencyType
      ? { dependencyType: row.dependencyType as DependencyRecord["dependencyType"] }
      : {}),
    ...(metadata ? { metadata } : {}),
  });
}

/** Converts an imported route row into the public index record contract. */
function toRouteRecord(row: RouteRow): RouteRecord {
  const metadata = optionalRecord(row.metadata);
  const range =
    row.startLine !== null && row.endLine !== null
      ? { endLine: row.endLine, startLine: row.startLine }
      : undefined;

  return parseWithSchema("RouteRecord", RouteRecordSchema, {
    type: "route",
    schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
    routeId: row.routeId,
    repoId: row.repoId,
    commitSha: row.commitSha,
    path: row.path,
    language: row.language,
    routePattern: row.routePattern,
    methods: jsonStringArray(row.methods),
    ...(row.handlerSymbolId ? { handlerSymbolId: row.handlerSymbolId } : {}),
    ...(range ? { range } : {}),
    ...(row.framework ? { framework: row.framework } : {}),
    confidence: row.confidence,
    ...(metadata ? { metadata } : {}),
  });
}

/** Builds an edge endpoint condition with an optional kind filter. */
function edgeEndpointCondition(
  endpoint: typeof codeEdges.fromId | typeof codeEdges.toId,
  input: ListSymbolEdgesInput,
): SQL | undefined {
  const conditions: SQL[] = [eq(endpoint, input.symbolId)];
  if (input.kinds && input.kinds.length > 0) {
    conditions.push(inArray(codeEdges.kind, [...input.kinds]));
  }

  return and(...conditions);
}

/** Builds an edge endpoint condition for either side of an edge. */
function orInEndpoints(
  fromEndpoint: typeof codeEdges.fromId,
  toEndpoint: typeof codeEdges.toId,
  symbolIds: readonly string[],
): SQL | undefined {
  return or(inArray(fromEndpoint, [...symbolIds]), inArray(toEndpoint, [...symbolIds]));
}

/** Returns a JSON-like object when the value can be safely exposed as metadata. */
function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Returns string arrays from JSONB values and ignores malformed entries. */
function jsonStringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/** Returns unique strings while preserving first-seen order. */
function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

/** Returns whether a value is a non-empty string. */
function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Bounds a query result limit to a non-negative integer. */
function boundedResultLimit(limit: number): number {
  return Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
}

/** Normalizes plain-text search input for PostgreSQL full-text lookup. */
function normalizeFullTextQuery(query: string): string {
  return query
    .split(/\s+/u)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3)
    .slice(0, 12)
    .join(" ");
}

/** Reads a string metadata field when present. */
function metadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

/** Reads a non-negative integer metadata field when present. */
function metadataInteger(
  metadata: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = metadata?.[key];
  return Number.isInteger(value) && typeof value === "number" && value >= 0 ? value : undefined;
}
