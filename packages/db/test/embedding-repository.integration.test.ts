import { Buffer } from "node:buffer";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HeimdallDatabase } from "../src/client";
import { EmbeddingRepository, type StoreChunkEmbeddingInput } from "../src/index";

const integrationDatabaseUrl = process.env.HEIMDALL_DB_TEST_URL;
const testDirectory = fileURLToPath(new URL(".", import.meta.url));
const bootstrapPath = resolve(testDirectory, "../bootstrap/0000_extensions.sql");
const migrationsDirectory = resolve(testDirectory, "../migrations");

describe.runIf(integrationDatabaseUrl)("EmbeddingRepository integration", () => {
  const schemaName = `heimdall_embedding_repository_test_${process.pid}_${Date.now()}`.replace(
    /[^A-Za-z0-9_]/g,
    "_",
  );
  const sql = postgres(integrationDatabaseUrl ?? "", { max: 1, onnotice: () => undefined });
  const db = drizzle(sql) as HeimdallDatabase;
  const embeddingRepository = new EmbeddingRepository(db);

  beforeAll(async () => {
    await sql.unsafe(await readFile(bootstrapPath, "utf8"));
    await sql.unsafe(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await sql.unsafe(`SET search_path TO ${quoteIdentifier(schemaName)}, public`);
    await applyMigrations(sql, schemaName);
    await seedEmbeddingRows(sql);
  });

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
    await sql.end();
  });

  it("stores reusable vectors and searches embedded chunks", async () => {
    const chunks = await embeddingRepository.listEmbeddingInputChunks({
      chunkIds: ["chunk_embedding_beta", "chunk_embedding_alpha", "chunk_missing"],
      indexVersionId: "idx_embedding_repository",
    });
    expect(chunks.map((chunk) => chunk.chunkId)).toEqual([
      "chunk_embedding_alpha",
      "chunk_embedding_beta",
    ]);
    expect(chunks[0]).toMatchObject({
      kind: "symbol",
      language: "typescript",
      text: "export function alpha(): string { return 'alpha'; }",
      tokenEstimate: 8,
    });

    const firstStore = await embeddingRepository.storeChunkEmbeddings({
      embeddings: [
        embeddingRow("chunk_embedding_alpha", {
          cacheKey: cacheHash("alpha"),
          contentHash: contentHash("a"),
          vector: unitVector(0),
        }),
        embeddingRow("chunk_embedding_beta", {
          cacheKey: cacheHash("beta"),
          contentHash: contentHash("b"),
          vector: unitVector(1),
        }),
      ],
    });
    expect(firstStore).toEqual({
      embeddedChunkCount: 2,
      insertedChunkIds: ["chunk_embedding_alpha", "chunk_embedding_beta"],
    });

    const secondStore = await embeddingRepository.storeChunkEmbeddings({
      embeddings: [
        embeddingRow("chunk_embedding_alpha", {
          cacheKey: cacheHash("alpha"),
          contentHash: contentHash("a"),
          vector: unitVector(0),
        }),
        embeddingRow("chunk_embedding_beta", {
          cacheKey: cacheHash("beta"),
          contentHash: contentHash("b"),
          vector: unitVector(1),
        }),
      ],
    });
    expect(secondStore).toEqual({ embeddedChunkCount: 2, insertedChunkIds: [] });

    const reusableVectors = await embeddingRepository.listReusableEmbeddingVectors({
      cacheKeys: [cacheHash("alpha")],
      contentHashes: [contentHash("b")],
      embeddingDimension: 1536,
      embeddingModel: "text-embedding-3-small",
      embeddingProfileVersion: "code_embedding_profile.v1",
      repoId: "repo_embedding_repository_test",
    });
    expect(reusableVectors.map((row) => row.chunkId)).toEqual([
      "chunk_embedding_alpha",
      "chunk_embedding_beta",
    ]);
    expect(reusableVectors[0]?.embedding).toHaveLength(1536);

    const searchResults = await embeddingRepository.vectorSearchChunks({
      embeddingDimension: 1536,
      embeddingModel: "text-embedding-3-small",
      indexVersionId: "idx_embedding_repository",
      limit: 2,
      queryVector: unitVector(0),
    });
    expect(searchResults.map((result) => result.chunk.chunkId)).toEqual([
      "chunk_embedding_alpha",
      "chunk_embedding_beta",
    ]);
    expect(searchResults[0]?.score).toBeGreaterThan(searchResults[1]?.score ?? 0);

    const [progress] = await sql`
      SELECT
        (SELECT embedded_chunk_count FROM code_index_versions WHERE index_version_id = 'idx_embedding_repository')::int
          AS embedded_chunk_count,
        (SELECT count(*)::int FROM code_chunks WHERE embedding_status = 'ready') AS ready_chunks
    `;
    expect(progress).toMatchObject({ embedded_chunk_count: 2, ready_chunks: 2 });
  });
});

/** Applies all generated SQL migrations in lexical order to a test schema. */
async function applyMigrations(sql: postgres.Sql, schemaName: string): Promise<void> {
  const files = (await readdir(migrationsDirectory))
    .filter((file) => file.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right));

  for (const file of files) {
    await sql.unsafe(
      (await readFile(resolve(migrationsDirectory, file), "utf8")).replaceAll(
        '"public".',
        `${quoteIdentifier(schemaName)}.`,
      ),
    );
  }
}

/** Inserts repository, index, file, and chunk rows for embedding repository tests. */
async function seedEmbeddingRows(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO orgs (org_id, name, slug)
    VALUES ('org_embedding_repository_test', 'Embedding Repository Test Org', 'embedding-repository-test-org')
  `;
  await sql`
    INSERT INTO provider_installations (
      installation_id,
      org_id,
      provider,
      provider_installation_id,
      account_login,
      account_type,
      installed_at
    )
    VALUES (
      'inst_embedding_repository_test',
      'org_embedding_repository_test',
      'github',
      'embedding-repository-test-installation',
      'acme',
      'organization',
      now()
    )
  `;
  await sql`
    INSERT INTO repositories (
      repo_id,
      org_id,
      installation_id,
      provider,
      provider_repo_id,
      owner,
      name,
      full_name,
      visibility
    )
    VALUES (
      'repo_embedding_repository_test',
      'org_embedding_repository_test',
      'inst_embedding_repository_test',
      'github',
      'embedding-repository-test-repo',
      'acme',
      'heimdall',
      'acme/heimdall',
      'private'
    )
  `;
  await sql`
    INSERT INTO code_index_versions (
      index_version_id,
      repo_id,
      commit_sha,
      index_key,
      status,
      artifact_uri,
      artifact_hash,
      indexer_name,
      indexer_version,
      chunker_version,
      completed_at
    )
    VALUES (
      'idx_embedding_repository',
      'repo_embedding_repository_test',
      'abcdef123456',
      'tree-sitter:1:chunks-v1',
      'ready',
      'smoke://embedding-repository',
      ${`sha256:${"1".repeat(64)}`},
      'tree-sitter',
      '1',
      'chunks-v1',
      '2026-05-08T00:01:00.000Z'::timestamptz
    )
  `;
  await sql`
    INSERT INTO indexed_files (
      file_id,
      index_version_id,
      repo_id,
      commit_sha,
      path,
      language,
      content_hash
    )
    VALUES (
      'file_embedding_repository',
      'idx_embedding_repository',
      'repo_embedding_repository_test',
      'abcdef123456',
      'src/service.ts',
      'typescript',
      ${`sha256:${"2".repeat(64)}`}
    )
  `;
  await sql`
    INSERT INTO code_chunks (
      chunk_id,
      index_version_id,
      file_id,
      repo_id,
      path,
      start_line,
      end_line,
      content_hash,
      metadata
    )
    VALUES
      (
        'chunk_embedding_alpha',
        'idx_embedding_repository',
        'file_embedding_repository',
        'repo_embedding_repository_test',
        'src/service.ts',
        1,
        3,
        ${contentHash("a")},
        ${JSON.stringify({
          kind: "symbol",
          language: "typescript",
          text: "export function alpha(): string { return 'alpha'; }",
          tokenEstimate: 8,
        })}::jsonb
      ),
      (
        'chunk_embedding_beta',
        'idx_embedding_repository',
        'file_embedding_repository',
        'repo_embedding_repository_test',
        'src/service.ts',
        5,
        7,
        ${contentHash("b")},
        ${JSON.stringify({
          kind: "symbol",
          language: "typescript",
          text: "export function beta(): string { return 'beta'; }",
          tokenEstimate: 8,
        })}::jsonb
      )
  `;
}

/** Builds a durable embedding row fixture for one chunk. */
function embeddingRow(
  chunkId: string,
  input: {
    /** Stable cache key for vector reuse. */
    readonly cacheKey: `sha256:${string}`;
    /** Immutable chunk content hash. */
    readonly contentHash: `sha256:${string}`;
    /** Vector values to store. */
    readonly vector: readonly number[];
  },
): StoreChunkEmbeddingInput {
  return {
    chunkEmbeddingId: `emb_${chunkId}`,
    chunkId,
    repoId: "repo_embedding_repository_test",
    indexVersionId: "idx_embedding_repository",
    embeddingModel: "text-embedding-3-small",
    embeddingDimension: 1536,
    embedding: input.vector,
    contentHash: input.contentHash,
    inputHash: contentHash(`input-${chunkId}`),
    inputKind: "code_chunk",
    embeddingCacheKey: input.cacheKey,
    embeddingProfileVersion: "code_embedding_profile.v1",
    provider: "hash",
  };
}

/** Creates a 1536-d unit vector for deterministic pgvector ordering. */
function unitVector(index: number): readonly number[] {
  return Array.from({ length: 1536 }, (_value, candidateIndex) =>
    candidateIndex === index ? 1 : 0,
  );
}

/** Creates a deterministic SHA-256-shaped content hash. */
function contentHash(seed: string): `sha256:${string}` {
  return `sha256:${Buffer.from(seed).toString("hex").padEnd(64, "0").slice(0, 64)}` as const;
}

/** Creates a deterministic SHA-256-shaped cache key. */
function cacheHash(seed: string): `sha256:${string}` {
  return contentHash(`cache-${seed}`);
}

/** Quotes a trusted Postgres identifier after validating its shape. */
function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(identifier)) {
    throw new Error(`Unsafe Postgres identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}
