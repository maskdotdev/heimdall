import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "@repo/db";
import type { GitProvider } from "@repo/github";
import { createStaticLLMGateway } from "@repo/llm-gateway";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { runPullRequestReview } from "../src";

const integrationDatabaseUrl = process.env.HEIMDALL_DB_TEST_URL;
const testDirectory = fileURLToPath(new URL(".", import.meta.url));
const bootstrapPath = resolve(testDirectory, "../../db/bootstrap/0000_extensions.sql");
const migrationPath = resolve(testDirectory, "../../db/migrations/0000_foundation.sql");
const now = "2026-04-28T12:00:00.000Z";

describe.runIf(integrationDatabaseUrl)("review orchestrator integration", () => {
  const schemaName = `heimdall_review_${process.pid}_${Date.now()}`.replace(/[^A-Za-z0-9_]/g, "_");
  const sql = postgres(integrationDatabaseUrl ?? "", { max: 1 });
  const db = drizzle(sql, { schema });

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await sql.end();
  });

  it("persists a review run, findings, validation output, and publish job", async () => {
    await sql.unsafe(`CREATE SCHEMA "${schemaName}"`);
    await sql.unsafe(`SET search_path TO "${schemaName}", public`);
    await sql.unsafe(await readFile(bootstrapPath, "utf8"));
    await sql.unsafe(await readFile(migrationPath, "utf8"));
    await seedRepository(sql);

    const result = await runPullRequestReview(
      {
        repoId: "repo_test",
        installationId: "inst_test",
        pullRequestNumber: 7,
        baseSha: "1111111",
        headSha: "2222222",
        trigger: "webhook",
      },
      {
        db,
        gitProvider: fakeGitProvider,
        now: () => new Date(now),
        llmGateway: createStaticLLMGateway({
          findings: [
            {
              path: "src/index.ts",
              line: 1,
              severity: "medium",
              category: "correctness",
              title: "Check exported value",
              body: "The exported value is hard-coded without validation.",
              evidence: ["The added line exports a literal value."],
              confidence: 0.82,
            },
          ],
        }),
        syncWorkspace: async () => ({
          workspacePath: "/tmp/heimdall-review-test",
          checkedOutSha: "2222222",
          cleanedUp: true,
        }),
        indexWaitTimeoutMs: 0,
      },
    );

    expect(result.candidateFindingCount).toBe(1);
    expect(result.validatedFindingCount).toBe(1);
    expect(result.publishJobKey).toBe(`review.publish.v1:${result.reviewRunId}`);

    const [counts] = await sql`
      SELECT
        (SELECT count(*)::int FROM pull_request_snapshots WHERE jsonb_array_length(changed_files) = 1) AS full_snapshots,
        (SELECT count(*)::int FROM review_runs WHERE status = 'completed') AS completed_runs,
        (SELECT count(*)::int FROM review_artifacts) AS artifacts,
        (SELECT count(*)::int FROM candidate_findings) AS candidate_findings,
        (SELECT count(*)::int FROM validated_findings) AS validated_findings,
        (SELECT count(*)::int FROM review_run_stage_events) AS stage_events,
        (SELECT count(*)::int FROM background_jobs WHERE job_type = 'review.publish.v1') AS publish_jobs
    `;

    expect(counts).toEqual({
      full_snapshots: 1,
      completed_runs: 1,
      artifacts: 5,
      candidate_findings: 1,
      validated_findings: 1,
      stage_events: 3,
      publish_jobs: 1,
    });
  });
});

async function seedRepository(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO orgs (org_id, name, slug)
    VALUES ('org_test', 'Test Org', 'test-org')
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
    VALUES ('inst_test', 'org_test', 'github', '12345', 'octo-org', 'Organization', ${now})
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
      'repo_test',
      'org_test',
      'inst_test',
      'github',
      '98765',
      'octo-org',
      'heimdall-test',
      'octo-org/heimdall-test',
      'private'
    )
  `;
}

const fakeGitProvider: GitProvider = {
  provider: "github",
  getInstallationToken: async () => ({ token: "token", expiresAt: now }),
  listInstallationRepositories: async () => [],
  syncInstallation: async () => ({ repositories: [] }),
  fetchRepository: async () => {
    throw new Error("fetchRepository is not used by this test.");
  },
  fetchPullRequestSnapshot: async () => ({
    snapshotId: "prs_test",
    schemaVersion: "pull_request_snapshot.v1",
    provider: "github",
    repoId: "repo_test",
    installationId: "inst_test",
    providerRepoId: "98765",
    providerPullRequestId: "777",
    pullRequestNumber: 7,
    title: "Change app",
    authorLogin: "octocat",
    state: "open",
    isDraft: false,
    labels: [],
    baseRef: "main",
    baseSha: "1111111",
    headRef: "feature",
    headSha: "2222222",
    changedFiles: [
      {
        path: "src/index.ts",
        status: "modified",
        language: "typescript",
        additions: 1,
        deletions: 0,
        changes: 1,
        isBinary: false,
        isGenerated: false,
        isTest: false,
        patch: "@@ -1,0 +1,1 @@\n+export const value = 1;",
        hunks: [
          {
            hunkId: "hunk_1",
            header: "@@ -1,0 +1,1 @@",
            oldStart: 1,
            oldLines: 0,
            newStart: 1,
            newLines: 1,
            lines: [{ kind: "addition", content: "export const value = 1;", newLine: 1 }],
          },
        ],
      },
    ],
    diffHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    additions: 1,
    deletions: 0,
    changedFileCount: 1,
    fetchedAt: now,
  }),
  fetchChangedFiles: async () => [],
  fetchBranchCommit: async () => ({ ref: "main", sha: "1111111", metadata: {} }),
  fetchExistingBotComments: async () => [],
  publishReview: async () => ({ providerReviewId: "review_1", commentIds: [] }),
  createOrUpdateCheckRun: async () => ({ providerCheckRunId: "check_1" }),
  publishSummaryComment: async () => ({ providerCommentId: "comment_1" }),
  getCloneAuth: async () => ({
    cloneUrl: "https://github.com/octo-org/heimdall-test.git",
    username: "x-access-token",
    password: "token",
    expiresAt: now,
  }),
};
