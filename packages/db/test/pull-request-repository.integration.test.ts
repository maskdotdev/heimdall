import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PullRequestSnapshot } from "@repo/contracts";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HeimdallDatabase } from "../src/client";
import { PullRequestRepository } from "../src/index";

const integrationDatabaseUrl = process.env.HEIMDALL_DB_TEST_URL;
const testDirectory = fileURLToPath(new URL(".", import.meta.url));
const bootstrapPath = resolve(testDirectory, "../bootstrap/0000_extensions.sql");
const migrationsDirectory = resolve(testDirectory, "../migrations");

describe.runIf(integrationDatabaseUrl)("PullRequestRepository integration", () => {
  const schemaName = `heimdall_pull_request_repository_test_${process.pid}_${Date.now()}`.replace(
    /[^A-Za-z0-9_]/g,
    "_",
  );
  const sql = postgres(integrationDatabaseUrl ?? "", { max: 1, onnotice: () => undefined });
  const db = drizzle(sql) as HeimdallDatabase;
  const pullRequestRepository = new PullRequestRepository(db);

  beforeAll(async () => {
    await sql.unsafe(await readFile(bootstrapPath, "utf8"));
    await sql.unsafe(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await sql.unsafe(`SET search_path TO ${quoteIdentifier(schemaName)}, public`);
    await applyMigrations(sql, schemaName);
    await seedPullRequestParents(sql);
  });

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
    await sql.end();
  });

  it("upserts snapshots and mutable pull request state idempotently", async () => {
    const created = await pullRequestRepository.upsertPullRequest({
      observedAt: "2026-05-08T00:01:00.000Z",
      pullRequestId: "pr_pull_request_repository",
      snapshot: pullRequestSnapshotFixture({
        fetchedAt: "2026-05-08T00:00:00.000Z",
        snapshotId: "prs_pull_request_repository_initial",
        title: "Add repository boundary",
      }),
    });
    expect(created).toMatchObject({
      latestSnapshotId: "prs_pull_request_repository_initial",
      pullRequestId: "pr_pull_request_repository",
      title: "Add repository boundary",
      updatedAt: "2026-05-08T00:01:00.000Z",
    });

    const refreshed = await pullRequestRepository.upsertPullRequest({
      observedAt: "2026-05-08T00:03:00.000Z",
      pullRequestId: "pr_pull_request_repository_duplicate",
      snapshot: pullRequestSnapshotFixture({
        changedFileCount: 2,
        fetchedAt: "2026-05-08T00:02:00.000Z",
        headSha: "3333333",
        isDraft: true,
        snapshotId: "prs_pull_request_repository_refreshed",
        title: "Add pull request repository boundary",
      }),
    });
    expect(refreshed).toMatchObject({
      headSha: "3333333",
      isDraft: true,
      latestSnapshotId: "prs_pull_request_repository_refreshed",
      pullRequestId: "pr_pull_request_repository",
      title: "Add pull request repository boundary",
      updatedAt: "2026-05-08T00:03:00.000Z",
    });

    const byRepoNumber = await pullRequestRepository.getPullRequest(
      "repo_pull_request_repository_test",
      42,
    );
    expect(byRepoNumber?.latestSnapshotId).toBe("prs_pull_request_repository_refreshed");

    const byProviderId = await pullRequestRepository.getPullRequestByProviderId({
      provider: "github",
      providerPullRequestId: "pull-request-repository-provider-pr",
    });
    expect(byProviderId?.pullRequestId).toBe("pr_pull_request_repository");

    const latestSnapshot = await pullRequestRepository.getLatestSnapshot(
      "repo_pull_request_repository_test",
      42,
    );
    expect(latestSnapshot).toMatchObject({
      headSha: "3333333",
      snapshotId: "prs_pull_request_repository_refreshed",
      title: "Add pull request repository boundary",
    });

    const duplicateSnapshot = await pullRequestRepository.insertSnapshot(
      pullRequestSnapshotFixture({
        fetchedAt: "2026-05-08T00:04:00.000Z",
        headSha: "3333333",
        snapshotId: "prs_pull_request_repository_refreshed",
        title: "Refresh duplicate snapshot payload",
      }),
    );
    expect(duplicateSnapshot).toMatchObject({
      fetchedAt: "2026-05-08T00:04:00.000Z",
      snapshotId: "prs_pull_request_repository_refreshed",
      title: "Refresh duplicate snapshot payload",
    });
    await expect(
      pullRequestRepository.getSnapshotRecord("prs_pull_request_repository_refreshed"),
    ).resolves.toMatchObject({
      fetchedAt: new Date("2026-05-08T00:04:00.000Z"),
      snapshotId: "prs_pull_request_repository_refreshed",
      title: "Refresh duplicate snapshot payload",
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

/** Inserts parent rows required by pull request repository tests. */
async function seedPullRequestParents(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO orgs (org_id, name, slug)
    VALUES ('org_pull_request_repository_test', 'Pull Request Repository Test Org', 'pull-request-repository-test-org')
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
      'inst_pull_request_repository_test',
      'org_pull_request_repository_test',
      'github',
      'pull-request-repository-test-installation',
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
      'repo_pull_request_repository_test',
      'org_pull_request_repository_test',
      'inst_pull_request_repository_test',
      'github',
      'pull-request-repository-test-repo',
      'acme',
      'heimdall',
      'acme/heimdall',
      'private'
    )
  `;
}

/** Builds a pull request snapshot fixture for repository tests. */
function pullRequestSnapshotFixture(
  overrides: Partial<PullRequestSnapshot> = {},
): PullRequestSnapshot {
  return {
    additions: 4,
    authorLogin: "octocat",
    baseRef: "main",
    baseSha: "1111111",
    changedFileCount: 1,
    changedFiles: [],
    deletions: 1,
    diffHash: `sha256:${"a".repeat(64)}`,
    fetchedAt: "2026-05-08T00:00:00.000Z",
    headRef: "feature/pull-request-repository",
    headSha: "2222222",
    installationId: "inst_pull_request_repository_test",
    isDraft: false,
    labels: ["ready-for-review"],
    provider: "github",
    providerPullRequestId: "pull-request-repository-provider-pr",
    providerRepoId: "pull-request-repository-test-repo",
    pullRequestNumber: 42,
    repoId: "repo_pull_request_repository_test",
    schemaVersion: "pull_request_snapshot.v1",
    snapshotId: "prs_pull_request_repository_initial",
    state: "open",
    title: "Add repository boundary",
    ...overrides,
  };
}

/** Quotes a trusted Postgres identifier after validating its shape. */
function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(identifier)) {
    throw new Error(`Unsafe Postgres identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}
