import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "@repo/db";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { createPublisherReplayPlan, reconcilePublisherRun, renderPublisherDryRun } from "../src";

const integrationDatabaseUrl = process.env.HEIMDALL_DB_TEST_URL;
const testDirectory = fileURLToPath(new URL(".", import.meta.url));
const bootstrapPath = resolve(testDirectory, "../../db/bootstrap/0000_extensions.sql");
const migrationPath = resolve(testDirectory, "../../db/migrations/0000_foundation.sql");
const now = "2026-05-05T12:00:00.000Z";

describe.runIf(integrationDatabaseUrl)("publisher operational controls", () => {
  const schemaName = `heimdall_admin_tools_${process.pid}_${Date.now()}`.replace(
    /[^A-Za-z0-9_]/g,
    "_",
  );
  const sql = postgres(integrationDatabaseUrl ?? "", { max: 1 });
  const db = drizzle(sql, { schema });

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await sql.end();
  });

  it("renders dry-run output, reconciles durable state, and creates gated replay plans", async () => {
    await sql.unsafe(`CREATE SCHEMA "${schemaName}"`);
    await sql.unsafe(`SET search_path TO "${schemaName}", public`);
    await sql.unsafe(await readFile(bootstrapPath, "utf8"));
    await sql.unsafe(
      (await readFile(migrationPath, "utf8")).replaceAll('"public".', `"${schemaName}".`),
    );
    await seedReview(sql);

    const dryRun = await renderPublisherDryRun("rrn_admin", { db });

    expect(dryRun).toMatchObject({
      reviewRunId: "rrn_admin",
      repoId: "repo_admin",
      pullRequestNumber: 12,
      headSha: "2222222",
      findingCount: 2,
      checkRunConclusion: "neutral",
      comments: {
        inlineCommentCount: 1,
        summaryFallbackCount: 1,
      },
      mutatesExternalState: false,
    });
    expect(dryRun.checkRunSummaryHash).toMatch(/^sha256:/u);
    expect(dryRun.comments.summaryFallbackBodyHash).toMatch(/^sha256:/u);

    const missingReport = await reconcilePublisherRun("rrn_admin", { db });
    expect(missingReport.issues.map((issue) => issue.code)).toEqual(["publish_run_missing"]);

    await seedPartialPublishState(sql);
    const report = await reconcilePublisherRun("rrn_admin", { db });
    expect(report).toMatchObject({
      publishRunId: "pub_admin",
      status: "completed",
      operationCount: 2,
      checkRunCount: 0,
      reviewCount: 0,
      summaryCommentCount: 0,
      publishedFindingCount: 1,
    });
    expect(report.issues.map((issue) => issue.code)).toEqual([
      "check_run_missing",
      "published_finding_missing",
      "operation_failed",
    ]);

    const replayPlan = await createPublisherReplayPlan("rrn_admin", { db });
    expect(replayPlan).toMatchObject({
      action: "publish.review",
      payload: {
        reviewRunId: "rrn_admin",
        repoId: "repo_admin",
        pullRequestNumber: 12,
      },
      requiresExplicitConfirmation: true,
    });
    expect(replayPlan.confirmationToken).toMatch(/^sha256:/u);
  });
});

async function seedReview(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO orgs (org_id, name, slug)
    VALUES ('org_admin', 'Admin Org', 'admin-org')
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
    VALUES ('inst_admin', 'org_admin', 'github', '12345', 'octo-org', 'Organization', ${now})
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
      'repo_admin',
      'org_admin',
      'inst_admin',
      'github',
      '98765',
      'octo-org',
      'heimdall-test',
      'octo-org/heimdall-test',
      'private'
    )
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
      'prs_admin',
      'pull_request_snapshot.v1',
      'github',
      'repo_admin',
      'inst_admin',
      '98765',
      '777',
      12,
      'Change app',
      'octocat',
      'open',
      false,
      'main',
      '1111111',
      'feature',
      '2222222',
      '[]'::jsonb,
      'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      2,
      0,
      2,
      ${now}
    )
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
      'rrn_admin',
      'review_run.v1',
      'repo_admin',
      'prs_admin',
      12,
      '1111111',
      '2222222',
      'webhook',
      'completed',
      ${now},
      '{"candidateFindings":2,"validatedFindings":2,"publishedFindings":0,"rejectedFindings":0}'::jsonb
    )
  `;
  await insertFinding(sql, "fnd_inline", true, 1);
  await insertFinding(sql, "fnd_summary", false, 2);
}

async function insertFinding(
  sql: postgres.Sql,
  findingId: string,
  isInDiff: boolean,
  rank: number,
): Promise<void> {
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
      ${`fnd_candidate_${findingId}`},
      'candidate_finding.v1',
      'rrn_admin',
      'llm',
      'review-pass.correctness',
      'correctness',
      'medium',
      'Check exported value',
      'The exported value is hard-coded without validation.',
      ${JSON.stringify({ path: "src/index.ts", line: rank, side: "RIGHT", isInDiff })}::jsonb,
      '[{"evidenceId":"ev_1","kind":"diff","summary":"Changed line","confidence":0.8}]'::jsonb,
      0.8,
      ${`fp_${findingId}`}
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
      ${findingId},
      ${`fnd_candidate_${findingId}`},
      'rrn_admin',
      'publish',
      'correctness',
      'medium',
      'Check exported value',
      'The exported value is hard-coded without validation.',
      ${JSON.stringify({ path: "src/index.ts", line: rank, side: "RIGHT", isInDiff })}::jsonb,
      '[{"evidenceId":"ev_1","kind":"diff","summary":"Changed line","confidence":0.8}]'::jsonb,
      0.8,
      '{"validatedAt":"2026-05-05T12:00:00.000Z","validatorVersion":"0.1.0","reasons":[]}'::jsonb,
      ${rank},
      ${`fp_${findingId}`}
    )
  `;
}

async function seedPartialPublishState(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO publish_runs (
      publish_run_id,
      review_run_id,
      repo_id,
      idempotency_key,
      status,
      started_at,
      completed_at
    )
    VALUES (
      'pub_admin',
      'rrn_admin',
      'repo_admin',
      'review.publish.v1:rrn_admin',
      'completed',
      ${now},
      ${now}
    )
  `;
  await sql`
    INSERT INTO published_findings (
      finding_id,
      validated_finding_id,
      review_run_id,
      provider,
      provider_comment_id,
      location,
      title,
      body,
      published_at,
      status,
      fingerprint
    )
    VALUES (
      'pf_admin',
      'fnd_inline',
      'rrn_admin',
      'github',
      'comment_1',
      '{"path":"src/index.ts","line":1,"side":"RIGHT","isInDiff":true}'::jsonb,
      'Check exported value',
      'The exported value is hard-coded without validation.',
      ${now},
      'published',
      'fp_fnd_inline'
    )
  `;
  await sql`
    INSERT INTO publish_operations (
      publish_operation_id,
      publish_run_id,
      operation_type,
      status
    )
    VALUES
      ('pop_completed', 'pub_admin', 'check_run.upsert', 'completed'),
      ('pop_failed', 'pub_admin', 'review.inline_comments', 'failed')
  `;
}
