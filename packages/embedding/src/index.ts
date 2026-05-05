import { createHash } from "node:crypto";
import type { EmbeddingBatchJobPayload } from "@repo/contracts";
import {
  codeChunkEmbeddings,
  codeChunks,
  codeIndexVersions,
  type HeimdallDatabase,
} from "@repo/db";
import { and, eq, inArray, sql } from "drizzle-orm";

export const packageName = "@repo/embedding" as const;

/** Dimension required by the current pgvector storage schema. */
export const DEFAULT_EMBEDDING_DIMENSIONS = 1536;

/** Provider boundary for chunk embeddings. */
export type EmbeddingProvider = {
  /** Embedding model name. */
  readonly model: string;
  /** Vector dimension returned by the provider. */
  readonly dimensions: number;
  /** Embeds input texts in order. */
  readonly embedTexts: (texts: readonly string[]) => Promise<readonly (readonly number[])[]>;
};

/** Result produced after embedding one chunk batch. */
export type EmbedChunkBatchResult = {
  /** Number of chunks newly embedded and stored. */
  readonly embeddedChunkCount: number;
  /** Chunk IDs that were skipped because text was unavailable. */
  readonly skippedChunkIds: readonly string[];
};

/** Embeds queued chunks and stores vectors idempotently for retrieval. */
export async function embedChunkBatch(
  payload: EmbeddingBatchJobPayload,
  options: { readonly db: HeimdallDatabase; readonly provider: EmbeddingProvider },
): Promise<EmbedChunkBatchResult> {
  const rows = await options.db
    .select()
    .from(codeChunks)
    .where(
      and(
        eq(codeChunks.indexVersionId, payload.indexVersionId),
        inArray(codeChunks.chunkId, payload.chunkIds),
      ),
    );
  const chunkTexts = rows
    .map((row) => ({ row, text: textFromMetadata(row.metadata) }))
    .filter((entry): entry is { row: (typeof rows)[number]; text: string } => Boolean(entry.text));
  const vectors = validateEmbeddingVectors(
    await options.provider.embedTexts(chunkTexts.map((entry) => entry.text)),
    chunkTexts.length,
    options.provider.dimensions,
  );
  let insertedChunkCount = 0;

  if (chunkTexts.length > 0) {
    await options.db.transaction(async (tx) => {
      const insertedRows = await tx
        .insert(codeChunkEmbeddings)
        .values(
          chunkTexts.map((entry, index) => ({
            chunkEmbeddingId: stableId("emb", [entry.row.chunkId, payload.embeddingModel]),
            chunkId: entry.row.chunkId,
            repoId: payload.repoId,
            indexVersionId: payload.indexVersionId,
            embeddingModel: payload.embeddingModel,
            embeddingDimension: options.provider.dimensions,
            embedding: [...(vectors[index] ?? [])],
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
            chunkTexts.map((entry) => entry.row.chunkId),
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

  return {
    embeddedChunkCount: insertedChunkCount,
    skippedChunkIds: payload.chunkIds.filter(
      (chunkId) => !chunkTexts.some((entry) => entry.row.chunkId === chunkId),
    ),
  };
}

/** Deterministic local embedding provider for tests and offline retrieval smoke checks. */
export function createHashEmbeddingProvider(
  model = "heimdall-hash-embedding",
  dimensions = DEFAULT_EMBEDDING_DIMENSIONS,
): EmbeddingProvider {
  return {
    model,
    dimensions,
    embedTexts: async (texts) => texts.map((text) => hashVector(text, dimensions)),
  };
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
    return typeof text === "string" ? text : undefined;
  }

  return undefined;
}

/** Builds a deterministic vector from input text for local and test runs. */
function hashVector(text: string, dimensions: number): readonly number[] {
  const hash = createHash("sha256").update(text).digest();
  return Array.from({ length: dimensions }, (_, index) => (hash[index % hash.length] ?? 0) / 255);
}

/** Builds a compact deterministic identifier from stable input parts. */
function stableId(prefix: string, parts: readonly unknown[]): string {
  return `${prefix}_${createHash("sha256")
    .update(parts.map((part) => String(part)).join(":"))
    .digest("base64url")
    .slice(0, 26)}`;
}
