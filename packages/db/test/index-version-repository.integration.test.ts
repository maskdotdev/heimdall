import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CodeIndexVersion } from "@repo/contracts";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HeimdallDatabase } from "../src/client";
import { IndexVersionRepository } from "../src/repositories/index-version-repository";

const integrationDatabaseUrl = process.env.HEIMDALL_DB_TEST_URL;
const testDirectory = fileURLToPath(new URL(".", import.meta.url));
const bootstrapPath = resolve(testDirectory, "../bootstrap/0000_extensions.sql");
const migrationsDirectory = resolve(testDirectory, "../migrations");

describe.runIf(integrationDatabaseUrl)("IndexVersionRepository integration", () => {
  const schemaName = `heimdall_index_version_test_${process.pid}_${Date.now()}`.replace(
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

  it("finds ready versions and applies explicit status transitions", async () => {
    await indexVersionRepository.createIndexVersion(
      indexVersionFixture({
        artifactHash: `sha256:${"a".repeat(64)}`,
        completedAt: "2026-05-08T00:01:00.000Z",
        indexerVersion: "1",
        indexVersionId: "idx_repository_ready_old",
        status: "ready",
      }),
    );
    await indexVersionRepository.createIndexVersion(
      indexVersionFixture({
        artifactHash: `sha256:${"b".repeat(64)}`,
        completedAt: "2026-05-08T00:02:00.000Z",
        indexerVersion: "2",
        indexVersionId: "idx_repository_ready_new",
        status: "ready",
      }),
    );
    await indexVersionRepository.createIndexVersion(
      indexVersionFixture({
        artifactHash: `sha256:${"c".repeat(64)}`,
        indexerName: "transition",
        indexVersionId: "idx_repository_transition",
        status: "pending",
      }),
    );

    const readyByKey = await indexVersionRepository.findReadyIndexVersion({
      commitSha: "abcdef123456",
      indexKey: "tree-sitter:1:chunks-v1",
      repoId: "repo_index_version_test",
    });
    expect(readyByKey?.indexVersionId).toBe("idx_repository_ready_old");

    const latestReady = await indexVersionRepository.getLatestReadyIndexForCommit({
      commitSha: "abcdef123456",
      repoId: "repo_index_version_test",
    });
    expect(latestReady?.indexVersionId).toBe("idx_repository_ready_new");
    await expect(
      indexVersionRepository.getIndexVersionRecord("idx_repository_ready_new"),
    ).resolves.toMatchObject({
      diagnosticCount: 0,
      indexKey: "tree-sitter:2:chunks-v1",
      indexVersionId: "idx_repository_ready_new",
      routeCount: 0,
      testMappingCount: 0,
    });
    await indexVersionRepository.upsertImportingIndexVersion({
      artifactHash: `sha256:${"d".repeat(64)}`,
      artifactUri: "smoke://index-version/importing-upsert",
      chunkerVersion: "chunks-v1",
      commitSha: "abcdef123456",
      counts: {
        chunkCount: 8,
        dependencyCount: 4,
        diagnosticCount: 2,
        edgeCount: 7,
        fileCount: 3,
        routeCount: 5,
        symbolCount: 6,
        testMappingCount: 1,
      },
      indexerName: "tree-sitter",
      indexerVersion: "importing",
      indexKey: "tree-sitter:importing:chunks-v1",
      indexVersionId: "idx_repository_importing_upsert",
      repoId: "repo_index_version_test",
    });
    await expect(
      indexVersionRepository.findIndexVersionForImport({
        artifactHash: `sha256:${"d".repeat(64)}`,
        commitSha: "abcdef123456",
        indexKey: "tree-sitter:importing:chunks-v1",
        repoId: "repo_index_version_test",
      }),
    ).resolves.toMatchObject({
      chunkCount: 8,
      dependencyCount: 4,
      diagnosticCount: 2,
      indexVersionId: "idx_repository_importing_upsert",
      status: "importing",
    });
    await expect(
      indexVersionRepository.getIndexVersionStatus("idx_repository_importing_upsert"),
    ).resolves.toBe("importing");
    await indexVersionRepository.markIndexVersionFailedRecord({
      error: { code: "index.import_failed", message: "Import write failed." },
      indexVersionId: "idx_repository_importing_upsert",
    });
    await expect(
      indexVersionRepository.getIndexVersionStatus("idx_repository_importing_upsert"),
    ).resolves.toBe("failed");
    await indexVersionRepository.markIndexVersionReadyRecord({
      completedAt: new Date("2026-05-08T00:05:00.000Z"),
      indexVersionId: "idx_repository_importing_upsert",
    });
    await expect(
      indexVersionRepository.getIndexVersionRecord("idx_repository_importing_upsert"),
    ).resolves.toMatchObject({
      completedAt: new Date("2026-05-08T00:05:00.000Z"),
      status: "ready",
    });

    const importing = await indexVersionRepository.markIndexImporting("idx_repository_transition");
    expect(importing.status).toBe("importing");
    expect(importing.completedAt).toBeUndefined();
    expect(importing.error).toBeUndefined();

    const ready = await indexVersionRepository.markIndexReady({
      completedAt: "2026-05-08T00:03:00.000Z",
      counts: {
        chunkCount: 4,
        edgeCount: 3,
        embeddedChunkCount: 2,
        fileCount: 1,
        symbolCount: 5,
      },
      indexVersionId: "idx_repository_transition",
    });
    expect(ready).toMatchObject({
      chunkCount: 4,
      completedAt: "2026-05-08T00:03:00.000Z",
      edgeCount: 3,
      embeddedChunkCount: 2,
      fileCount: 1,
      status: "ready",
      symbolCount: 5,
    });

    const failed = await indexVersionRepository.markIndexFailed({
      completedAt: "2026-05-08T00:04:00.000Z",
      errorCode: "index.import_failed",
      errorMessage: "Import artifact failed validation.",
      indexVersionId: "idx_repository_transition",
      retryable: true,
    });
    expect(failed).toMatchObject({
      completedAt: "2026-05-08T00:04:00.000Z",
      error: {
        code: "index.import_failed",
        message: "Import artifact failed validation.",
        retryable: true,
      },
      status: "failed",
    });
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

/** Inserts parent rows required by index version foreign keys. */
async function seedRepositoryParent(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO orgs (org_id, name, slug)
    VALUES ('org_index_version_test', 'Index Version Test Org', 'index-version-test-org')
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
      'inst_index_version_test',
      'org_index_version_test',
      'github',
      'index-version-test-installation',
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
      'repo_index_version_test',
      'org_index_version_test',
      'inst_index_version_test',
      'github',
      'index-version-test-repo',
      'acme',
      'heimdall',
      'acme/heimdall',
      'private'
    )
  `;
}

/** Builds a code index version contract fixture. */
function indexVersionFixture(input: {
  /** Optional artifact hash. */
  readonly artifactHash: string;
  /** Optional completion timestamp. */
  readonly completedAt?: string;
  /** Indexer name. */
  readonly indexerName?: string;
  /** Indexer version. */
  readonly indexerVersion?: string;
  /** Durable index version ID. */
  readonly indexVersionId: string;
  /** Initial status. */
  readonly status: CodeIndexVersion["status"];
}): CodeIndexVersion {
  return {
    artifactHash: input.artifactHash,
    artifactUri: `smoke://index-version/${input.indexVersionId}`,
    chunkCount: 0,
    chunkerVersion: "chunks-v1",
    commitSha: "abcdef123456",
    createdAt: "2026-05-08T00:00:00.000Z",
    edgeCount: 0,
    embeddedChunkCount: 0,
    fileCount: 0,
    indexerName: input.indexerName ?? "tree-sitter",
    indexerVersion: input.indexerVersion ?? "1",
    indexVersionId: input.indexVersionId,
    repoId: "repo_index_version_test",
    status: input.status,
    symbolCount: 0,
    ...(input.completedAt ? { completedAt: input.completedAt } : {}),
  };
}

/** Quotes a trusted Postgres identifier after validating its shape. */
function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(identifier)) {
    throw new Error(`Unsafe Postgres identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}
