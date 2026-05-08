import {
  type ChunkRecord,
  ChunkRecordSchema,
  type CodeEdgeKind,
  type EdgeRecord,
  EdgeRecordSchema,
  INDEX_RECORD_SCHEMA_VERSION,
  parseWithSchema,
  type SymbolRecord,
  SymbolRecordSchema,
} from "@repo/contracts";
import { and, asc, desc, eq, gte, inArray, lte, type SQL, sql } from "drizzle-orm";
import type { HeimdallDatabase } from "../client";
import { codeChunks, codeEdges, codeIndexVersions, symbols } from "../schema";

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

/** Lookup input for listing edges attached to a source symbol. */
export type ListSymbolEdgesInput = {
  /** Symbol ID to use as the edge endpoint. */
  readonly symbolId: string;
  /** Optional edge kind filter. */
  readonly kinds?: readonly CodeEdgeKind[];
};

type SymbolRow = typeof symbols.$inferSelect;
type CodeChunkRow = typeof codeChunks.$inferSelect;
type CodeEdgeRow = typeof codeEdges.$inferSelect;

/** Query helper for imported symbol, chunk, and edge records. */
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
    const rows = await this.db
      .select()
      .from(symbols)
      .where(and(eq(symbols.indexVersionId, input.indexVersionId), eq(symbols.path, input.path)))
      .orderBy(asc(symbols.startLine), asc(symbols.endLine), asc(symbols.name));

    return rows.map(toSymbolRecord);
  }

  /** Lists imported chunks for one indexed file in source order. */
  public async listChunksForFile(input: ListChunksForFileInput): Promise<readonly ChunkRecord[]> {
    const rows = await this.db
      .select({ chunk: codeChunks, commitSha: codeIndexVersions.commitSha })
      .from(codeChunks)
      .innerJoin(codeIndexVersions, eq(codeChunks.indexVersionId, codeIndexVersions.indexVersionId))
      .where(
        and(eq(codeChunks.indexVersionId, input.indexVersionId), eq(codeChunks.path, input.path)),
      )
      .orderBy(asc(codeChunks.startLine), asc(codeChunks.endLine), asc(codeChunks.chunkId));

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

/** Returns a JSON-like object when the value can be safely exposed as metadata. */
function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
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
