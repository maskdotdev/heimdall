import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HeimdallDatabase } from "../src/client";
import { DataDeletionRepository } from "../src/index";

const integrationDatabaseUrl = process.env.HEIMDALL_DB_TEST_URL;
const testDirectory = fileURLToPath(new URL(".", import.meta.url));
const bootstrapPath = resolve(testDirectory, "../bootstrap/0000_extensions.sql");
const migrationsDirectory = resolve(testDirectory, "../migrations");

describe.runIf(integrationDatabaseUrl)("DataDeletionRepository integration", () => {
  const schemaName = `heimdall_data_deletion_repository_test_${process.pid}_${Date.now()}`.replace(
    /[^A-Za-z0-9_]/g,
    "_",
  );
  const sql = postgres(integrationDatabaseUrl ?? "", { max: 1, onnotice: () => undefined });
  const db = drizzle(sql) as HeimdallDatabase;
  const dataDeletionRepository = new DataDeletionRepository(db);

  beforeAll(async () => {
    await sql.unsafe(await readFile(bootstrapPath, "utf8"));
    await sql.unsafe(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await sql.unsafe(`SET search_path TO ${quoteIdentifier(schemaName)}, public`);
    await applyMigrations(sql, schemaName);
    await seedScopeRows(sql);
  });

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
    await sql.end();
  });

  it("creates, lists, and updates scoped deletion requests idempotently", async () => {
    const manifest = {
      dbTables: [
        {
          predicateDescription: "repo_id = repo_data_deletion",
          rowCountEstimate: 12,
          table: "review_artifacts",
        },
      ],
      externalProviders: [{ action: "delete_remote_comments", provider: "github" }],
      objectKeys: ["reviews/rrn_data_deletion/context.json"],
      queueKeys: ["github:review:repo_data_deletion:1:abc"],
      repoId: "repo_data_deletion",
      requestId: "ddr_data_deletion",
      vectorNamespaces: ["repo_data_deletion"],
    };

    await expect(
      dataDeletionRepository.createDataDeletionRequest({
        dataDeletionRequestId: "ddr_data_deletion",
        manifest,
        metadata: { ticket: "SEC-100" },
        orgId: "org_data_deletion",
        reason: "customer_request",
        repoId: "repo_data_deletion",
        requestedAt: new Date("2026-05-08T01:00:00.000Z"),
        requestedBy: "usr_data_deletion",
        scope: "repository",
      }),
    ).resolves.toMatchObject({
      inserted: true,
      request: {
        dataDeletionRequestId: "ddr_data_deletion",
        orgId: "org_data_deletion",
        reason: "customer_request",
        repoId: "repo_data_deletion",
        requestedBy: "usr_data_deletion",
        scope: "repository",
        status: "requested",
      },
    });

    await expect(
      dataDeletionRepository.createDataDeletionRequest({
        dataDeletionRequestId: "ddr_data_deletion",
        orgId: "org_data_deletion",
        reason: "incident_response",
        repoId: "repo_data_deletion",
        requestedBy: "usr_data_deletion",
        scope: "repository",
      }),
    ).resolves.toMatchObject({
      inserted: false,
      request: {
        dataDeletionRequestId: "ddr_data_deletion",
        reason: "customer_request",
      },
    });

    await dataDeletionRepository.createDataDeletionRequest({
      dataDeletionRequestId: "ddr_data_deletion_later",
      orgId: "org_data_deletion",
      reason: "app_uninstalled",
      repoId: "repo_data_deletion",
      requestedAt: new Date("2026-05-08T01:30:00.000Z"),
      requestedBy: "system:github_webhook",
      scope: "organization",
      status: "planned",
    });

    await expect(
      dataDeletionRepository.listDataDeletionRequests({
        limit: 10,
        orgId: "org_data_deletion",
        repoId: "repo_data_deletion",
      }),
    ).resolves.toMatchObject([
      { dataDeletionRequestId: "ddr_data_deletion_later" },
      { dataDeletionRequestId: "ddr_data_deletion" },
    ]);

    await expect(
      dataDeletionRepository.updateDataDeletionRequestStatus({
        completedAt: new Date("2026-05-08T02:00:00.000Z"),
        dataDeletionRequestId: "ddr_data_deletion",
        metadata: { completedBy: "worker" },
        status: "completed",
        verificationArtifactUri: "deletion://ddr_data_deletion/verification.json",
      }),
    ).resolves.toMatchObject({
      completedAt: new Date("2026-05-08T02:00:00.000Z"),
      metadata: { completedBy: "worker" },
      status: "completed",
      verificationArtifactUri: "deletion://ddr_data_deletion/verification.json",
    });

    await expect(
      dataDeletionRepository.listDataDeletionRequests({ limit: 10, status: "completed" }),
    ).resolves.toMatchObject([{ dataDeletionRequestId: "ddr_data_deletion" }]);
    await expect(dataDeletionRepository.listDataDeletionRequests({ limit: 0 })).rejects.toThrow(
      /limit must be an integer/u,
    );
  });
});

/** Seeds the minimal tenant scope rows referenced by deletion-request tests. */
async function seedScopeRows(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO orgs (org_id, name, slug, created_at, updated_at)
    VALUES ('org_data_deletion', 'Data Deletion Org', 'data-deletion-org', now(), now())
  `;
  await sql`
    INSERT INTO users (user_id, primary_email, display_name, created_at, updated_at)
    VALUES (
      'usr_data_deletion',
      'data-deletion@example.test',
      'Data Deletion User',
      now(),
      now()
    )
  `;
  await sql`
    INSERT INTO provider_installations (
      installation_id,
      org_id,
      provider,
      provider_installation_id,
      account_login,
      account_type,
      permissions,
      installed_at
    )
    VALUES (
      'inst_data_deletion',
      'org_data_deletion',
      'github',
      '12345',
      'data-deletion-org',
      'Organization',
      '{}'::jsonb,
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
      visibility,
      created_at,
      updated_at
    )
    VALUES (
      'repo_data_deletion',
      'org_data_deletion',
      'inst_data_deletion',
      'github',
      '54321',
      'data-deletion-org',
      'repo',
      'data-deletion-org/repo',
      'private',
      now(),
      now()
    )
  `;
}

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

/** Quotes a trusted Postgres identifier after validating its shape. */
function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(identifier)) {
    throw new Error(`Unsafe Postgres identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}
