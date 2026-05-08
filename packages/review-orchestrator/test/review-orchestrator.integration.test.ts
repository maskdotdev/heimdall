import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "@repo/db";
import type { GitProvider } from "@repo/github";
import { createStaticLLMGateway } from "@repo/llm-gateway";
import { hashRawDiff } from "@repo/pr-snapshot";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { runPullRequestReview } from "../src";

const integrationDatabaseUrl = process.env.HEIMDALL_DB_TEST_URL;
const testDirectory = fileURLToPath(new URL(".", import.meta.url));
const bootstrapPath = resolve(testDirectory, "../../db/bootstrap/0000_extensions.sql");
const migrationsDirectory = resolve(testDirectory, "../../db/migrations");
const now = "2026-04-28T12:00:00.000Z";
const rawDiff = [
  "diff --git a/src/index.ts b/src/index.ts",
  "--- a/src/index.ts",
  "+++ b/src/index.ts",
  "@@ -1,0 +1,1 @@",
  "+export const value = 1;",
  "",
].join("\n");

describe.runIf(integrationDatabaseUrl)("review orchestrator integration", () => {
  const schemaName = `heimdall_review_${process.pid}_${Date.now()}`.replace(/[^A-Za-z0-9_]/g, "_");
  const sql = postgres(integrationDatabaseUrl ?? "", { max: 1 });
  const db = drizzle(sql, { schema });

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await sql.end();
  });

  it("persists a review run, findings, validation output, and publish job", async () => {
    await resetDatabase(sql, schemaName);

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
            {
              path: "src/index.ts",
              line: 1,
              severity: "medium",
              category: "correctness",
              title: "Validate exported value",
              body: "The exported value is still hard-coded and should be validated.",
              evidence: ["The added line exports the same literal value."],
              confidence: 0.81,
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

    expect(result.candidateFindingCount).toBe(2);
    expect(result.validatedFindingCount).toBe(1);
    expect(result.publishJobKey).toBe(`review.publish.v1:${result.reviewRunId}`);

    const [counts] = await sql`
      SELECT
        (SELECT count(*)::int FROM pull_request_snapshots WHERE jsonb_array_length(changed_files) = 1) AS full_snapshots,
        (SELECT count(*)::int FROM review_runs WHERE status = 'completed') AS completed_runs,
        (SELECT count(*)::int FROM review_artifacts) AS artifacts,
        (SELECT count(*)::int FROM review_artifacts WHERE kind = 'change_set') AS change_set_artifacts,
        (SELECT count(*)::int FROM review_artifacts WHERE kind = 'line_anchor_index') AS line_anchor_artifacts,
        (SELECT count(*)::int FROM review_artifacts WHERE kind = 'raw_diff') AS raw_diff_artifacts,
        (SELECT count(*)::int FROM review_artifacts WHERE kind = 'retrieval_trace') AS retrieval_trace_artifacts,
        (SELECT count(*)::int FROM review_artifacts WHERE kind = 'ranking_report') AS ranking_artifacts,
        (SELECT count(*)::int FROM review_artifacts WHERE kind = 'rejected_findings') AS rejected_artifacts,
        (SELECT count(*)::int FROM review_artifacts WHERE kind = 'llm_prompt') AS llm_prompt_artifacts,
        (SELECT count(*)::int FROM review_artifacts WHERE kind = 'llm_response') AS llm_response_artifacts,
        (SELECT count(*)::int FROM review_artifacts WHERE kind = 'publish_plan') AS publish_plan_artifacts,
        (SELECT count(*)::int FROM review_artifacts WHERE classification = 'customer_code') AS customer_code_artifacts,
        (SELECT count(*)::int FROM review_artifacts WHERE classification = 'customer_confidential') AS customer_confidential_artifacts,
        (SELECT count(*)::int FROM review_artifacts WHERE metadata->>'redactionLevel' = 'contains_code') AS code_redaction_artifacts,
        (SELECT count(*)::int FROM review_artifacts WHERE metadata->>'redactionLevel' = 'contains_prompt') AS prompt_redaction_artifacts,
        (SELECT count(*)::int FROM review_artifacts WHERE metadata->>'redactionLevel' = 'safe') AS safe_redaction_artifacts,
        (SELECT count(*)::int FROM review_artifacts WHERE metadata->>'redactionLevel' = 'contains_sensitive') AS sensitive_redaction_artifacts,
        (SELECT count(*)::int FROM publish_plans) AS publish_plans,
        (SELECT count(*)::int FROM candidate_findings) AS candidate_findings,
        (SELECT count(*)::int FROM validated_findings) AS validated_findings,
        (SELECT count(*)::int FROM finding_validation_events) AS validation_events,
        (SELECT count(*)::int FROM finding_duplicate_groups) AS duplicate_groups,
        (SELECT count(*)::int FROM review_run_stage_events) AS stage_events,
        (SELECT count(*)::int FROM llm_calls WHERE status = 'succeeded') AS llm_calls,
        (SELECT count(*)::int FROM llm_call_artifacts) AS llm_call_artifact_links,
        (SELECT count(*)::int FROM usage_events WHERE event_type = 'llm.token') AS llm_usage_events,
        (SELECT count(*)::int FROM usage_events WHERE event_type = 'review.run') AS review_usage_events,
        (SELECT count(*)::int FROM usage_events WHERE event_type = 'review.credit') AS review_credit_events,
        (SELECT count(*)::int FROM quota_reservations WHERE status = 'consumed') AS consumed_quota_reservations,
        (SELECT count(*)::int FROM background_jobs WHERE job_type = 'review.publish.v1') AS publish_jobs,
        (SELECT count(*)::int FROM background_jobs WHERE job_type = 'review.publish.v1' AND payload->'payload'->>'publishPlanId' IS NOT NULL AND payload->'payload'->>'publishPlanArtifactId' IS NOT NULL) AS publish_jobs_with_plan
    `;

    expect(counts).toEqual({
      full_snapshots: 1,
      completed_runs: 1,
      artifacts: 16,
      candidate_findings: 2,
      change_set_artifacts: 1,
      code_redaction_artifacts: 10,
      consumed_quota_reservations: 1,
      customer_code_artifacts: 12,
      customer_confidential_artifacts: 4,
      duplicate_groups: 1,
      line_anchor_artifacts: 1,
      llm_call_artifact_links: 2,
      llm_prompt_artifacts: 1,
      llm_response_artifacts: 1,
      raw_diff_artifacts: 1,
      retrieval_trace_artifacts: 1,
      ranking_artifacts: 1,
      rejected_artifacts: 1,
      publish_plan_artifacts: 1,
      publish_plans: 1,
      prompt_redaction_artifacts: 2,
      safe_redaction_artifacts: 3,
      sensitive_redaction_artifacts: 1,
      validation_events: 12,
      validated_findings: 2,
      stage_events: 12,
      llm_calls: 1,
      llm_usage_events: 1,
      review_credit_events: 1,
      review_usage_events: 1,
      publish_jobs: 1,
      publish_jobs_with_plan: 1,
    });
  });

  it("does not enqueue publish work when all findings are rejected", async () => {
    await resetDatabase(sql, schemaName);

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
              title: "Maybe check exported value",
              body: "The exported value might need validation.",
              evidence: ["The added line exports a literal value."],
              confidence: 0.2,
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
    expect(result.validatedFindingCount).toBe(0);
    expect(result.publishJobKey).toBeUndefined();

    const [counts] = await sql`
      SELECT
        (SELECT count(*)::int FROM review_runs WHERE status = 'completed') AS completed_runs,
        (SELECT count(*)::int FROM review_artifacts WHERE kind = 'publish_plan') AS publish_plan_artifacts,
        (SELECT count(*)::int FROM publish_plans WHERE mode = 'none') AS empty_publish_plans,
        (SELECT count(*)::int FROM validated_findings WHERE decision = 'reject') AS rejected_findings,
        (SELECT count(*)::int FROM review_run_stage_events WHERE stage = 'publish' AND status = 'skipped') AS skipped_publish_events,
        (SELECT count(*)::int FROM background_jobs WHERE job_type = 'review.publish.v1') AS publish_jobs,
        (SELECT count(*)::int FROM quota_reservations WHERE status = 'consumed') AS consumed_quota_reservations,
        (SELECT count(*)::int FROM usage_events WHERE event_type = 'review.run') AS review_usage_events
    `;

    expect(counts).toEqual({
      completed_runs: 1,
      consumed_quota_reservations: 1,
      empty_publish_plans: 1,
      publish_jobs: 0,
      publish_plan_artifacts: 1,
      rejected_findings: 1,
      review_usage_events: 1,
      skipped_publish_events: 1,
    });
  });

  it("runs the full review pipeline in dry-run mode without enqueueing publish work", async () => {
    await resetDatabase(sql, schemaName);

    const result = await runPullRequestReview(
      {
        repoId: "repo_test",
        installationId: "inst_test",
        pullRequestNumber: 7,
        baseSha: "1111111",
        headSha: "2222222",
        trigger: "webhook",
        dryRun: true,
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
    expect(result.publishJobKey).toBeUndefined();

    const [counts] = await sql`
      SELECT
        (SELECT count(*)::int FROM review_runs WHERE status = 'completed') AS completed_runs,
        (SELECT count(*)::int FROM review_runs WHERE metadata->'publishSkipped'->>'reason' = 'dry_run') AS dry_run_review_runs,
        (SELECT count(*)::int FROM review_artifacts WHERE kind = 'publish_plan') AS publish_plan_artifacts,
        (SELECT count(*)::int FROM publish_plans WHERE mode <> 'none') AS publish_plans_with_writes,
        (SELECT count(*)::int FROM validated_findings WHERE decision = 'publish') AS publishable_findings,
        (SELECT count(*)::int FROM review_run_stage_events WHERE stage = 'publish' AND status = 'skipped' AND metadata->>'reason' = 'dry_run') AS dry_run_publish_events,
        (SELECT count(*)::int FROM background_jobs WHERE job_type = 'review.publish.v1') AS publish_jobs,
        (SELECT count(*)::int FROM usage_events WHERE event_type = 'review.run') AS review_usage_events
    `;

    expect(counts).toEqual({
      completed_runs: 1,
      dry_run_publish_events: 1,
      dry_run_review_runs: 1,
      publish_jobs: 0,
      publish_plan_artifacts: 1,
      publish_plans_with_writes: 1,
      publishable_findings: 1,
      review_usage_events: 1,
    });
  });
});

async function resetDatabase(sql: postgres.Sql, schemaName: string): Promise<void> {
  await sql.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
  await sql.unsafe(`CREATE SCHEMA "${schemaName}"`);
  await sql.unsafe(`SET search_path TO "${schemaName}", public`);
  await sql.unsafe(await readFile(bootstrapPath, "utf8"));
  await applyMigrations(sql, schemaName);
  await seedRepository(sql);
}

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
  fetchPullRequestSnapshotWithRawDiff: async () => {
    const fetchedSnapshot = await fakeGitProvider.fetchPullRequestSnapshot({
      provider: "github",
      installationId: "inst_test",
      owner: "octo-org",
      repo: "heimdall-test",
      providerRepoId: "98765",
      pullRequestNumber: 7,
    });
    const rawDiffHash = hashRawDiff(rawDiff);
    const snapshot = { ...fetchedSnapshot, diffHash: rawDiffHash };

    return {
      rawDiff,
      rawDiffBytes: new TextEncoder().encode(rawDiff).byteLength,
      rawDiffHash,
      snapshot,
    };
  },
  fetchChangedFiles: async () => [],
  fetchBranchCommit: async () => ({ ref: "main", sha: "1111111", metadata: {} }),
  fetchExistingBotComments: async () => [],
  fetchExistingReviewComments: async () => [],
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
