import { and, asc, eq, inArray, or, type SQL, sql } from "drizzle-orm";
import type { HeimdallDatabase } from "../client";
import { codeChunkEmbeddings, codeChunks, codeIndexVersions } from "../schema";

/** Database surface required for embedding repository write operations. */
type EmbeddingRepositoryWriteDatabase = Pick<HeimdallDatabase, "insert" | "select" | "update">;

/** Database surface accepted by embedding repository methods. */
type EmbeddingRepositoryDatabase = EmbeddingRepositoryWriteDatabase &
  Partial<Pick<HeimdallDatabase, "transaction">>;

/** Chunk row shape prepared for embedding input construction. */
export type EmbeddingInputChunk = {
  /** Stable imported chunk ID. */
  readonly chunkId: string;
  /** Optional indexed file ID that owns the chunk. */
  readonly fileId?: string;
  /** Optional indexed symbol ID that owns the chunk. */
  readonly symbolId?: string;
  /** Repository ID that owns the chunk. */
  readonly repoId: string;
  /** Imported index version ID that owns the chunk. */
  readonly indexVersionId: string;
  /** Repository-relative source path. */
  readonly path: string;
  /** One-based starting line. */
  readonly startLine: number;
  /** One-based ending line. */
  readonly endLine: number;
  /** Immutable chunk content hash from the index artifact. */
  readonly contentHash: string;
  /** Raw chunk text from importer metadata. */
  readonly text: string;
  /** Optional language hint from importer metadata. */
  readonly language?: string;
  /** Optional chunk kind hint from importer metadata. */
  readonly kind?: string;
  /** Optional token estimate from importer metadata. */
  readonly tokenEstimate?: number;
};

/** Input for loading chunks that need embedding input construction. */
export type ListEmbeddingInputChunksInput = {
  /** Imported index version ID to query. */
  readonly indexVersionId: string;
  /** Chunk IDs requested by the embedding job. */
  readonly chunkIds: readonly string[];
};

/** Stored reusable embedding vector row. */
export type ReusableEmbeddingVector = {
  /** Stable vector row ID. */
  readonly chunkEmbeddingId: string;
  /** Imported chunk ID that produced the vector. */
  readonly chunkId: string;
  /** Immutable chunk content hash. */
  readonly contentHash: string;
  /** Final provider input hash. */
  readonly inputHash: string;
  /** Stable cache key for provider/model/profile reuse. */
  readonly embeddingCacheKey: string;
  /** Stored vector values. */
  readonly embedding: readonly number[];
};

/** Input for loading reusable embedding vectors. */
export type ListReusableEmbeddingVectorsInput = {
  /** Repository ID that owns the vectors. */
  readonly repoId: string;
  /** Embedding model name. */
  readonly embeddingModel: string;
  /** Stored vector dimension. */
  readonly embeddingDimension: number;
  /** Embedding input profile version. */
  readonly embeddingProfileVersion: string;
  /** Exact cache keys computed from current embedding inputs. */
  readonly cacheKeys: readonly string[];
  /** Chunk content hashes eligible for profile-level reuse. */
  readonly contentHashes: readonly string[];
};

/** Embedding row to store for one imported chunk. */
export type StoreChunkEmbeddingInput = {
  /** Stable vector row ID. */
  readonly chunkEmbeddingId: string;
  /** Imported chunk ID that produced the vector. */
  readonly chunkId: string;
  /** Repository ID that owns the vector. */
  readonly repoId: string;
  /** Imported index version ID that owns the vector. */
  readonly indexVersionId: string;
  /** Embedding model name. */
  readonly embeddingModel: string;
  /** Stored vector dimension. */
  readonly embeddingDimension: number;
  /** Vector values to store in pgvector. */
  readonly embedding: readonly number[];
  /** Immutable chunk content hash. */
  readonly contentHash: string;
  /** Final provider input hash. */
  readonly inputHash: string;
  /** Embedding input kind, such as code_chunk. */
  readonly inputKind: string;
  /** Stable cache key for provider/model/profile reuse. */
  readonly embeddingCacheKey: string;
  /** Embedding input profile version. */
  readonly embeddingProfileVersion: string;
  /** Low-cardinality provider ID. */
  readonly provider: string;
};

/** Input for storing one batch of chunk embeddings. */
export type StoreChunkEmbeddingsInput = {
  /** Embedding rows to store idempotently. */
  readonly embeddings: readonly StoreChunkEmbeddingInput[];
};

/** Result from storing chunk embeddings. */
export type StoreChunkEmbeddingsResult = {
  /** Chunk IDs inserted by this call, excluding conflict hits. */
  readonly insertedChunkIds: readonly string[];
  /** Current distinct embedded chunk count for the index and model. */
  readonly embeddedChunkCount: number;
};

/** Input for pgvector similarity search over stored chunk vectors. */
export type VectorSearchChunksInput = {
  /** Imported index version ID to query. */
  readonly indexVersionId: string;
  /** Embedding model name to query. */
  readonly embeddingModel: string;
  /** Query vector values. */
  readonly queryVector: readonly number[];
  /** Maximum number of chunks to return. */
  readonly limit: number;
  /** Optional vector dimension filter. */
  readonly embeddingDimension?: number;
};

/** Vector search result with the imported chunk row and cosine similarity score. */
export type VectorSearchChunkResult = {
  /** Imported chunk row. */
  readonly chunk: typeof codeChunks.$inferSelect;
  /** Cosine similarity score where larger is better. */
  readonly score: number;
};

/** Query helper for chunk embedding and vector-search persistence. */
export class EmbeddingRepository {
  /** Creates an embedding query helper. */
  public constructor(private readonly db: EmbeddingRepositoryDatabase) {}

  /** Lists imported chunks for embedding input construction. */
  public async listEmbeddingInputChunks(
    input: ListEmbeddingInputChunksInput,
  ): Promise<readonly EmbeddingInputChunk[]> {
    const chunkIds = uniqueStrings(input.chunkIds);
    if (chunkIds.length === 0) {
      return [];
    }

    const rows = await this.db
      .select()
      .from(codeChunks)
      .where(
        and(
          eq(codeChunks.indexVersionId, input.indexVersionId),
          inArray(codeChunks.chunkId, chunkIds),
        ),
      )
      .orderBy(
        asc(codeChunks.path),
        asc(codeChunks.startLine),
        asc(codeChunks.endLine),
        asc(codeChunks.chunkId),
      );

    return rows.map(toEmbeddingInputChunk);
  }

  /** Loads reusable vectors by exact cache key or imported chunk content hash. */
  public async listReusableEmbeddingVectors(
    input: ListReusableEmbeddingVectorsInput,
  ): Promise<readonly ReusableEmbeddingVector[]> {
    const reuseCondition = embeddingReuseLookupCondition(input);
    if (!reuseCondition) {
      return [];
    }

    const rows = await this.db
      .select({
        chunkEmbeddingId: codeChunkEmbeddings.chunkEmbeddingId,
        chunkId: codeChunkEmbeddings.chunkId,
        contentHash: codeChunkEmbeddings.contentHash,
        inputHash: codeChunkEmbeddings.inputHash,
        embeddingCacheKey: codeChunkEmbeddings.embeddingCacheKey,
        embedding: codeChunkEmbeddings.embedding,
      })
      .from(codeChunkEmbeddings)
      .where(
        and(
          eq(codeChunkEmbeddings.repoId, input.repoId),
          eq(codeChunkEmbeddings.embeddingModel, input.embeddingModel),
          eq(codeChunkEmbeddings.embeddingDimension, input.embeddingDimension),
          eq(codeChunkEmbeddings.embeddingProfileVersion, input.embeddingProfileVersion),
          reuseCondition,
        ),
      )
      .orderBy(
        asc(codeChunkEmbeddings.embeddingCacheKey),
        asc(codeChunkEmbeddings.contentHash),
        asc(codeChunkEmbeddings.chunkId),
      );

    return rows.map((row) => ({ ...row, embedding: [...row.embedding] }));
  }

  /** Stores chunk embeddings idempotently and updates chunk/index progress rows. */
  public async storeChunkEmbeddings(
    input: StoreChunkEmbeddingsInput,
  ): Promise<StoreChunkEmbeddingsResult> {
    if (input.embeddings.length === 0) {
      return { embeddedChunkCount: 0, insertedChunkIds: [] };
    }

    if (this.db.transaction) {
      return this.db.transaction(async (tx) => storeChunkEmbeddings(input, tx));
    }

    return storeChunkEmbeddings(input, this.db);
  }

  /** Runs pgvector cosine-nearest-neighbor search over embedded chunks. */
  public async vectorSearchChunks(
    input: VectorSearchChunksInput,
  ): Promise<readonly VectorSearchChunkResult[]> {
    const limit = boundedResultLimit(input.limit);
    if (limit === 0) {
      return [];
    }

    const vectorText = pgVectorLiteral(input.queryVector);
    const distanceExpression = sql<number>`${codeChunkEmbeddings.embedding} <=> ${vectorText}::vector`;
    const filters: SQL[] = [
      eq(codeChunkEmbeddings.indexVersionId, input.indexVersionId),
      eq(codeChunkEmbeddings.embeddingModel, input.embeddingModel),
    ];
    if (input.embeddingDimension !== undefined) {
      filters.push(eq(codeChunkEmbeddings.embeddingDimension, input.embeddingDimension));
    }

    const rows = await this.db
      .select({
        chunk: codeChunks,
        score: sql<number>`1 - (${distanceExpression})`,
      })
      .from(codeChunkEmbeddings)
      .innerJoin(codeChunks, eq(codeChunkEmbeddings.chunkId, codeChunks.chunkId))
      .where(and(...filters))
      .orderBy(distanceExpression, asc(codeChunkEmbeddings.chunkId))
      .limit(limit);

    return rows;
  }
}

/** Stores chunk embeddings and progress updates in the provided database scope. */
async function storeChunkEmbeddings(
  input: StoreChunkEmbeddingsInput,
  db: EmbeddingRepositoryWriteDatabase,
): Promise<StoreChunkEmbeddingsResult> {
  const scope = sharedEmbeddingScope(input.embeddings);
  const chunkIds = uniqueStrings(input.embeddings.map((embedding) => embedding.chunkId));

  const insertedRows = await db
    .insert(codeChunkEmbeddings)
    .values(
      input.embeddings.map((embedding) => ({
        chunkEmbeddingId: embedding.chunkEmbeddingId,
        chunkId: embedding.chunkId,
        repoId: embedding.repoId,
        indexVersionId: embedding.indexVersionId,
        embeddingModel: embedding.embeddingModel,
        embeddingDimension: embedding.embeddingDimension,
        embedding: validatedVector(embedding),
        contentHash: embedding.contentHash,
        inputHash: embedding.inputHash,
        inputKind: embedding.inputKind,
        embeddingCacheKey: embedding.embeddingCacheKey,
        embeddingProfileVersion: embedding.embeddingProfileVersion,
        provider: embedding.provider,
      })),
    )
    .onConflictDoNothing()
    .returning({ chunkId: codeChunkEmbeddings.chunkId });

  await db
    .update(codeChunks)
    .set({ embeddingStatus: "ready" })
    .where(inArray(codeChunks.chunkId, chunkIds));

  const [progress] = await db
    .select({
      embeddedChunkCount: sql<number>`count(distinct ${codeChunkEmbeddings.chunkId})::int`,
    })
    .from(codeChunkEmbeddings)
    .where(
      and(
        eq(codeChunkEmbeddings.indexVersionId, scope.indexVersionId),
        eq(codeChunkEmbeddings.embeddingModel, scope.embeddingModel),
      ),
    );
  const embeddedChunkCount = progress?.embeddedChunkCount ?? 0;

  await db
    .update(codeIndexVersions)
    .set({ embeddedChunkCount })
    .where(eq(codeIndexVersions.indexVersionId, scope.indexVersionId));

  return {
    embeddedChunkCount,
    insertedChunkIds: insertedRows.map((row) => row.chunkId),
  };
}

/** Converts a chunk row into an embedding input source. */
function toEmbeddingInputChunk(row: typeof codeChunks.$inferSelect): EmbeddingInputChunk {
  const metadata = optionalRecord(row.metadata);
  const kind = metadataString(metadata, "kind");
  const language = metadataString(metadata, "language");
  const tokenEstimate = metadataInteger(metadata, "tokenEstimate");

  return {
    chunkId: row.chunkId,
    ...(row.fileId ? { fileId: row.fileId } : {}),
    ...(row.symbolId ? { symbolId: row.symbolId } : {}),
    repoId: row.repoId,
    indexVersionId: row.indexVersionId,
    path: row.path,
    startLine: row.startLine,
    endLine: row.endLine,
    contentHash: row.contentHash,
    text: metadataString(metadata, "text") ?? "",
    ...(language ? { language } : {}),
    ...(kind ? { kind } : {}),
    ...(tokenEstimate !== undefined ? { tokenEstimate } : {}),
  };
}

/** Builds a reusable vector lookup predicate. */
function embeddingReuseLookupCondition(input: ListReusableEmbeddingVectorsInput): SQL | undefined {
  const cacheKeys = uniqueStrings(input.cacheKeys);
  const contentHashes = uniqueStrings(input.contentHashes);

  if (cacheKeys.length > 0 && contentHashes.length > 0) {
    return or(
      inArray(codeChunkEmbeddings.embeddingCacheKey, cacheKeys),
      inArray(codeChunkEmbeddings.contentHash, contentHashes),
    );
  }

  if (cacheKeys.length > 0) {
    return inArray(codeChunkEmbeddings.embeddingCacheKey, cacheKeys);
  }

  if (contentHashes.length > 0) {
    return inArray(codeChunkEmbeddings.contentHash, contentHashes);
  }

  return undefined;
}

/** Returns the shared storage scope after validating all rows match it. */
function sharedEmbeddingScope(embeddings: readonly StoreChunkEmbeddingInput[]): {
  /** Imported index version ID shared by the batch. */
  readonly indexVersionId: string;
  /** Embedding model shared by the batch. */
  readonly embeddingModel: string;
} {
  const first = embeddings[0];
  if (!first) {
    throw new Error("Embedding batch cannot be empty.");
  }

  for (const embedding of embeddings) {
    if (
      embedding.indexVersionId !== first.indexVersionId ||
      embedding.embeddingModel !== first.embeddingModel
    ) {
      throw new Error("Embedding batch rows must share one index version and model.");
    }
  }

  return {
    embeddingModel: first.embeddingModel,
    indexVersionId: first.indexVersionId,
  };
}

/** Validates a vector before handing it to the pgvector driver. */
function validatedVector(input: StoreChunkEmbeddingInput): number[] {
  if (input.embedding.length !== input.embeddingDimension) {
    throw new Error(
      `Embedding ${input.chunkEmbeddingId} has ${input.embedding.length} dimensions, expected ${input.embeddingDimension}.`,
    );
  }

  for (const value of input.embedding) {
    if (!Number.isFinite(value)) {
      throw new Error(`Embedding ${input.chunkEmbeddingId} contains a non-finite value.`);
    }
  }

  return [...input.embedding];
}

/** Serializes a finite vector for a parameterized pgvector query. */
function pgVectorLiteral(vector: readonly number[]): string {
  if (vector.length === 0) {
    throw new Error("Query vector cannot be empty.");
  }

  for (const value of vector) {
    if (!Number.isFinite(value)) {
      throw new Error("Query vector contains a non-finite value.");
    }
  }

  return `[${vector.join(",")}]`;
}

/** Clamps search result limits to a bounded database query size. */
function boundedResultLimit(limit: number): number {
  if (!Number.isInteger(limit)) {
    throw new Error("Search limit must be an integer.");
  }

  return Math.max(0, Math.min(limit, 100));
}

/** Returns a de-duplicated list of strings while preserving first-seen order. */
function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
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
