import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "@repo/db";
import type { GitProvider } from "@repo/github";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { publishReviewRun } from "../src";

const integrationDatabaseUrl = process.env.HEIMDALL_DB_TEST_URL;
const testDirectory = fileURLToPath(new URL(".", import.meta.url));
const bootstrapPath = resolve(testDirectory, "../../db/bootstrap/0000_extensions.sql");
const migrationsDirectory = resolve(testDirectory, "../../db/migrations");
const now = "2026-05-05T12:00:00.000Z";

describe.runIf(integrationDatabaseUrl)("publisher integration", () => {
  const schemaName = `heimdall_publisher_${process.pid}_${Date.now()}`.replace(
    /[^A-Za-z0-9_]/g,
    "_",
  );
  const sql = postgres(integrationDatabaseUrl ?? "", { max: 1 });
  const db = drizzle(sql, { schema });

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await sql.end();
  });

  it("publishes check runs, inline comments, summary fallback, and skips stale heads", async () => {
    await sql.unsafe(`CREATE SCHEMA "${schemaName}"`);
    await sql.unsafe(`SET search_path TO "${schemaName}", public`);
    await sql.unsafe(await readFile(bootstrapPath, "utf8"));
    await applyMigrations(sql, schemaName);
    await seedReview(sql, "rrn_publish", "2222222");

    const provider = createPublisherFakeProvider({
      failReviewPublishing: true,
      pullRequestSnapshots: [pullRequestSnapshot("2222222")],
    });
    const result = await publishReviewRun(
      { reviewRunId: "rrn_publish", repoId: "repo_test", pullRequestNumber: 7 },
      { db, gitProvider: provider, now: () => new Date(now) },
    );

    expect(result).toMatchObject({
      annotationCount: 1,
      inlineCommentCount: 0,
      staleHead: false,
      providerSummaryCommentId: expect.stringMatching(/^summary_/u),
    });
    expect(provider.checkRuns).toHaveLength(1);
    expect(provider.publishedSummaryComments).toHaveLength(1);

    await publishReviewRun(
      { reviewRunId: "rrn_publish", repoId: "repo_test", pullRequestNumber: 7 },
      { db, gitProvider: provider, now: () => new Date(now) },
    );
    expect(provider.publishedSummaryComments).toHaveLength(1);

    await seedReview(sql, "rrn_stale", "2222222");
    const staleResult = await publishReviewRun(
      { reviewRunId: "rrn_stale", repoId: "repo_test", pullRequestNumber: 7 },
      {
        db,
        gitProvider: createPublisherFakeProvider({
          pullRequestSnapshots: [pullRequestSnapshot("3333333")],
        }),
        now: () => new Date(now),
      },
    );
    expect(staleResult.staleHead).toBe(true);

    const [counts] = await sql`
      SELECT
        (SELECT count(*)::int FROM published_check_runs) AS check_runs,
        (SELECT count(*)::int FROM published_summary_comments) AS summary_comments,
        (SELECT count(*)::int FROM published_findings) AS findings,
        (SELECT count(*)::int FROM publish_runs WHERE status = 'skipped') AS skipped_runs
    `;

    expect(counts).toEqual({
      check_runs: 1,
      summary_comments: 1,
      findings: 1,
      skipped_runs: 1,
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
        `"${schemaName}".`,
      ),
    );
  }
}

async function seedReview(sql: postgres.Sql, reviewRunId: string, headSha: string): Promise<void> {
  const snapshotId = `prs_${headSha}`;

  await sql`
    INSERT INTO orgs (org_id, name, slug)
    VALUES ('org_test', 'Test Org', 'test-org')
    ON CONFLICT DO NOTHING
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
    ON CONFLICT DO NOTHING
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
    ON CONFLICT DO NOTHING
  `;
  await sql`
    INSERT INTO pull_request_snapshots (
      snapshot_id,
      schema_version,
      provider,
      repo_id,
      installation_id,
      provider_repo_id,
      provider_pull_request_id,
      pull_request_number,
      title,
      author_login,
      state,
      is_draft,
      base_ref,
      base_sha,
      head_ref,
      head_sha,
      changed_files,
      diff_hash,
      additions,
      deletions,
      changed_file_count,
      fetched_at
    )
    VALUES (
      ${snapshotId},
      'pull_request_snapshot.v1',
      'github',
      'repo_test',
      'inst_test',
      '98765',
      '777',
      7,
      'Change app',
      'octocat',
      'open',
      false,
      'main',
      '1111111',
      'feature',
      ${headSha},
      '[]'::jsonb,
      'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      1,
      0,
      1,
      ${now}
    )
    ON CONFLICT DO NOTHING
  `;
  await sql`
    INSERT INTO review_runs (
      review_run_id,
      schema_version,
      repo_id,
      pull_request_snapshot_id,
      pull_request_number,
      base_sha,
      head_sha,
      trigger,
      status,
      completed_at,
      counts
    )
    VALUES (
      ${reviewRunId},
      'review_run.v1',
      'repo_test',
      ${snapshotId},
      7,
      '1111111',
      ${headSha},
      'webhook',
      'completed',
      ${now},
      '{"candidateFindings":1,"validatedFindings":1,"publishedFindings":0,"rejectedFindings":0}'::jsonb
    )
  `;
  await sql`
    INSERT INTO candidate_findings (
      finding_id,
      schema_version,
      review_run_id,
      source,
      source_name,
      category,
      severity,
      title,
      body,
      location,
      evidence,
      confidence,
      fingerprint
    )
    VALUES (
      ${`fnd_${reviewRunId}`},
      'candidate_finding.v1',
      ${reviewRunId},
      'llm',
      'review-pass.correctness',
      'correctness',
      'medium',
      'Check exported value',
      'The exported value is hard-coded without validation.',
      '{"path":"src/index.ts","line":1,"side":"RIGHT","isInDiff":true}'::jsonb,
      '[{"evidenceId":"ev_1","kind":"diff","summary":"Changed line","confidence":0.8}]'::jsonb,
      0.8,
      ${`fp_${reviewRunId}`}
    )
  `;
  await sql`
    INSERT INTO validated_findings (
      finding_id,
      candidate_finding_id,
      review_run_id,
      decision,
      category,
      severity,
      title,
      body,
      location,
      evidence,
      confidence,
      validation,
      rank,
      fingerprint
    )
    VALUES (
      ${`fnd_validated_${reviewRunId}`},
      ${`fnd_${reviewRunId}`},
      ${reviewRunId},
      'publish',
      'correctness',
      'medium',
      'Check exported value',
      'The exported value is hard-coded without validation.',
      '{"path":"src/index.ts","line":1,"side":"RIGHT","isInDiff":true}'::jsonb,
      '[{"evidenceId":"ev_1","kind":"diff","summary":"Changed line","confidence":0.8}]'::jsonb,
      0.8,
      '{"validatedAt":"2026-05-05T12:00:00.000Z","validatorVersion":"0.1.0","reasons":[]}'::jsonb,
      1,
      ${`fp_${reviewRunId}`}
    )
  `;
}

function pullRequestSnapshot(headSha: string) {
  return {
    snapshotId: `prs_fake_${headSha}`,
    schemaVersion: "pull_request_snapshot.v1" as const,
    provider: "github" as const,
    repoId: "repo_test",
    installationId: "inst_test",
    providerRepoId: "98765",
    providerPullRequestId: "777",
    pullRequestNumber: 7,
    title: "Change app",
    authorLogin: "octocat",
    state: "open" as const,
    isDraft: false,
    labels: [],
    baseRef: "main",
    baseSha: "1111111",
    headRef: "feature",
    headSha,
    changedFiles: [],
    diffHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    additions: 1,
    deletions: 0,
    changedFileCount: 1,
    fetchedAt: now,
  };
}

function createPublisherFakeProvider(options: {
  readonly pullRequestSnapshots: readonly ReturnType<typeof pullRequestSnapshot>[];
  readonly failReviewPublishing?: boolean;
}): GitProvider & {
  readonly checkRuns: unknown[];
  readonly publishedSummaryComments: unknown[];
} {
  const publishedSummaryComments: unknown[] = [];
  const checkRuns: unknown[] = [];
  const botCommentBodies = new Map<string, string>();

  return {
    provider: "github",
    getInstallationToken: async () => ({
      token: "token",
      expiresAt: "2099-01-01T00:00:00.000Z",
    }),
    listInstallationRepositories: async () => [],
    syncInstallation: async () => ({ repositories: [] }),
    fetchRepository: async () => {
      throw new Error("fetchRepository is not used by this test.");
    },
    fetchPullRequestSnapshot: async () =>
      options.pullRequestSnapshots[0] ?? pullRequestSnapshot(""),
    fetchChangedFiles: async () => [],
    fetchBranchCommit: async () => ({ ref: "feature", sha: "2222222", metadata: {} }),
    fetchExistingBotComments: async () => [],
    publishReview: async () => {
      if (options.failReviewPublishing) {
        throw new Error("Review comments disabled.");
      }

      return { providerReviewId: "review_1", commentIds: ["comment_1"] };
    },
    createOrUpdateCheckRun: async () => {
      checkRuns.push({});
      return { providerCheckRunId: "check_1" };
    },
    publishSummaryComment: async (input) => {
      const existingCommentId = botCommentBodies.get(input.body);
      if (existingCommentId) {
        return { providerCommentId: existingCommentId };
      }

      const providerCommentId = "summary_1";
      botCommentBodies.set(input.body, providerCommentId);
      publishedSummaryComments.push(input);
      return { providerCommentId };
    },
    getCloneAuth: async () => ({
      cloneUrl: "https://github.example/octo-org/heimdall-test.git",
      username: "x-access-token",
      password: "token",
      expiresAt: "2099-01-01T00:00:00.000Z",
    }),
    checkRuns,
    publishedSummaryComments,
  };
}
