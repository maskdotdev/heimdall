import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { HeimdallDatabase } from "@repo/db";
import { IndexVersionRepository } from "@repo/db";
import type { IndexArtifact } from "@repo/index-schema";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importIndexArtifact } from "../src/index";

const integrationDatabaseUrl = process.env.HEIMDALL_DB_TEST_URL;
const testDirectory = fileURLToPath(new URL(".", import.meta.url));
const bootstrapPath = resolve(testDirectory, "../../db/bootstrap/0000_extensions.sql");
const migrationsDirectory = resolve(testDirectory, "../../db/migrations");

describe.runIf(integrationDatabaseUrl)("importIndexArtifact integration", () => {
  const schemaName = `heimdall_index_importer_test_${process.pid}_${Date.now()}`.replace(
    /[^A-Za-z0-9_]/g,
    "_",
  );
  const sql = postgres(integrationDatabaseUrl ?? "", { max: 1, onnotice: () => undefined });
  const db = drizzle(sql) as HeimdallDatabase;
  const indexVersionRepository = new IndexVersionRepository(db);

  beforeAll(async () => {
    await sql.unsafe(await readFile(bootstrapPath, "utf8"));
    await sql.unsafe(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await sql.unsafe(`SET search_path TO ${quoteIdentifier(schemaName)}, public`);
    await applyMigrations(sql, schemaName);
    await seedRepositoryParent(sql);
  });

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
    await sql.end();
  });

  it("imports a valid artifact into Postgres and is safe to replay", async () => {
    const artifact = validIntegrationArtifact();
    const firstImport = await importIndexArtifact(artifact, {
      artifactUri: "integration://index-importer/artifact.json",
      db,
      embeddingBatchSize: 1,
      embeddingDimensions: 2,
      embeddingModel: "text-embedding-3-small",
      embeddingProvider: "hash",
      enqueueEmbeddings: true,
    });

    expect(firstImport).toMatchObject({
      chunkCount: 1,
      edgeCount: 1,
      embeddingJobCount: 1,
      fileCount: 1,
      symbolCount: 1,
    });

    await expect(
      indexVersionRepository.getLatestReadyIndexForCommit({
        commitSha: artifact.manifest.commitSha,
        repoId: artifact.manifest.repoId,
      }),
    ).resolves.toMatchObject({
      indexVersionId: firstImport.indexVersionId,
      status: "ready",
    });

    await expect(countRows(sql, "indexed_files", firstImport.indexVersionId)).resolves.toBe(1);
    await expect(countRows(sql, "symbols", firstImport.indexVersionId)).resolves.toBe(1);
    await expect(countRows(sql, "code_edges", firstImport.indexVersionId)).resolves.toBe(1);
    await expect(countRows(sql, "code_chunks", firstImport.indexVersionId)).resolves.toBe(1);
    await expect(countRows(sql, "embedding_jobs", firstImport.indexVersionId)).resolves.toBe(1);
    await expect(countEmbeddingJobItems(sql, firstImport.indexVersionId)).resolves.toBe(1);
    await expect(countBackgroundJobs(sql, firstImport.indexVersionId)).resolves.toBe(2);

    const [importBatch] = await sql<[{ phase: string; status: string }]>`
      SELECT phase, status
      FROM index_import_batches
      WHERE index_import_batch_id = ${firstImport.importBatchId}
    `;
    expect(importBatch).toEqual({ phase: "complete", status: "complete" });

    const replayedImport = await importIndexArtifact(artifact, {
      artifactUri: "integration://index-importer/artifact.json",
      db,
      enqueueEmbeddings: true,
    });

    expect(replayedImport).toMatchObject({
      embeddingJobCount: 0,
      indexVersionId: firstImport.indexVersionId,
    });
    await expect(countBackgroundJobs(sql, firstImport.indexVersionId)).resolves.toBe(2);
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

/** Inserts parent organization, installation, and repository rows for importer foreign keys. */
async function seedRepositoryParent(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO orgs (org_id, name, slug)
    VALUES ('org_1', 'Index Importer Test Org', 'index-importer-test-org')
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
      'inst_index_importer_test',
      'org_1',
      'github',
      'index-importer-test-installation',
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
      'repo_1',
      'org_1',
      'inst_index_importer_test',
      'github',
      'index-importer-test-repo',
      'acme',
      'heimdall',
      'acme/heimdall',
      'private'
    )
  `;
}

/** Counts rows attached to one imported index version across supported importer tables. */
async function countRows(
  sql: postgres.Sql,
  tableName: string,
  indexVersionId: string,
): Promise<number> {
  const safeTableName = quoteIdentifier(tableName);
  const rows = await sql.unsafe(
    `
      SELECT count(*)::int AS count
      FROM ${safeTableName}
      WHERE index_version_id = $1
    `,
    [indexVersionId],
  );

  return Number(rows[0]?.count ?? 0);
}

/** Counts embedding job item rows attached through their parent embedding job. */
async function countEmbeddingJobItems(sql: postgres.Sql, indexVersionId: string): Promise<number> {
  const rows = await sql`
    SELECT count(*)::int AS count
    FROM embedding_job_items items
    JOIN embedding_jobs jobs ON jobs.embedding_job_id = items.embedding_job_id
    WHERE jobs.index_version_id = ${indexVersionId}
  `;

  return Number(rows[0]?.count ?? 0);
}

/** Counts durable embedding jobs planned for one imported index version. */
async function countBackgroundJobs(sql: postgres.Sql, indexVersionId: string): Promise<number> {
  const rows = await sql`
    SELECT count(*)::int AS count
    FROM background_jobs
    WHERE repo_id = 'repo_1'
      AND payload->'payload'->>'indexVersionId' = ${indexVersionId}
  `;

  return Number(rows[0]?.count ?? 0);
}

/** Builds a compact artifact that exercises files, symbols, edges, chunks, and embedding planning. */
function validIntegrationArtifact(): IndexArtifact {
  return {
    manifest: {
      artifactHash: `sha256:${"9".repeat(64)}`,
      artifactId: "art_index_importer_integration",
      chunkCount: 1,
      chunkerVersion: "chunker.v1",
      commitSha: "abc1234",
      edgeCount: 1,
      fileCount: 1,
      generatedAt: "2026-05-08T12:00:00.000Z",
      indexerName: "integration-indexer",
      indexerVersion: "1.0.0",
      languages: ["typescript"],
      parserVersions: {},
      recordCount: 4,
      recordSchemaVersion: "index_record.v1",
      repoId: "repo_1",
      schemaVersion: "index_artifact.v1",
      symbolCount: 1,
    },
    records: [
      {
        commitSha: "abc1234",
        contentHash: `sha256:${"1".repeat(64)}`,
        fileId: "file_index_importer_integration",
        isBinary: false,
        isGenerated: false,
        isTest: false,
        isVendored: false,
        language: "typescript",
        lineCount: 3,
        path: "src/index.ts",
        repoId: "repo_1",
        schemaVersion: "index_record.v1",
        sizeBytes: 42,
        type: "file",
      },
      {
        commitSha: "abc1234",
        contentHash: `sha256:${"2".repeat(64)}`,
        fileId: "file_index_importer_integration",
        kind: "function",
        language: "typescript",
        name: "getValue",
        path: "src/index.ts",
        range: { endLine: 2, startLine: 1 },
        repoId: "repo_1",
        schemaVersion: "index_record.v1",
        symbolId: "sym_index_importer_integration",
        type: "symbol",
      },
      {
        chunkId: "chunk_index_importer_integration",
        commitSha: "abc1234",
        contentHash: `sha256:${"3".repeat(64)}`,
        fileId: "file_index_importer_integration",
        kind: "symbol",
        language: "typescript",
        path: "src/index.ts",
        range: { endLine: 2, startLine: 1 },
        repoId: "repo_1",
        schemaVersion: "index_record.v1",
        symbolId: "sym_index_importer_integration",
        text: "export function getValue() { return 1; }",
        tokenEstimate: 8,
        type: "chunk",
      },
      {
        commitSha: "abc1234",
        confidence: 1,
        edgeId: "edge_index_importer_integration",
        fromId: "file_index_importer_integration",
        fromKind: "file",
        kind: "imports",
        repoId: "repo_1",
        schemaVersion: "index_record.v1",
        toId: "external:node:path",
        toKind: "external",
        type: "edge",
      },
    ],
  };
}

/** Quotes a trusted Postgres identifier after validating its shape. */
function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(identifier)) {
    throw new Error(`Unsafe Postgres identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}
