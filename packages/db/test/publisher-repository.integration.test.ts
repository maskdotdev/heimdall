import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HeimdallDatabase } from "../src/client";
import { PublisherRepository } from "../src/index";

const integrationDatabaseUrl = process.env.HEIMDALL_DB_TEST_URL;
const testDirectory = fileURLToPath(new URL(".", import.meta.url));
const bootstrapPath = resolve(testDirectory, "../bootstrap/0000_extensions.sql");
const migrationsDirectory = resolve(testDirectory, "../migrations");

describe.runIf(integrationDatabaseUrl)("PublisherRepository integration", () => {
  const schemaName = `heimdall_publisher_repository_test_${process.pid}_${Date.now()}`.replace(
    /[^A-Za-z0-9_]/g,
    "_",
  );
  const sql = postgres(integrationDatabaseUrl ?? "", { max: 1, onnotice: () => undefined });
  const db = drizzle(sql) as HeimdallDatabase;
  const repository = new PublisherRepository(db);

  beforeAll(async () => {
    await sql.unsafe(await readFile(bootstrapPath, "utf8"));
    await sql.unsafe(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await sql.unsafe(`SET search_path TO ${quoteIdentifier(schemaName)}, public`);
    await applyMigrations(sql, schemaName);
    await seedPublisherRows(sql);
  });

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
    await sql.end();
  });

  it("upserts publish run output rows and records operation attempts", async () => {
    await repository.upsertRunningPublishRun({
      idempotencyKey: "review.publish.v1:rrn_publisher",
      metadata: { pullRequestNumber: 42 },
      publishRunId: "pub_publisher",
      repoId: "repo_publisher",
      reviewRunId: "rrn_publisher",
      startedAt: new Date("2026-05-08T16:00:00.000Z"),
    });
    await repository.upsertRunningPublishRun({
      idempotencyKey: "review.publish.v1:rrn_publisher",
      metadata: { pullRequestNumber: 42, retry: true },
      publishRunId: "pub_publisher",
      repoId: "repo_publisher",
      reviewRunId: "rrn_publisher",
      startedAt: new Date("2026-05-08T16:01:00.000Z"),
    });
    await repository.recordPublishOperation({
      operationType: "check_run.upsert",
      publishOperationId: "pop_publisher_check_started",
      publishRunId: "pub_publisher",
      requestHash: "sha256:request",
      status: "running",
    });
    await repository.recordPublishOperation({
      operationType: "check_run.upsert",
      publishOperationId: "pop_publisher_check_completed",
      publishRunId: "pub_publisher",
      responseHash: "sha256:response",
      status: "completed",
    });
    await repository.upsertPublishedCheckRun({
      conclusion: "neutral",
      metadata: { annotationCount: 1 },
      provider: "github",
      providerCheckRunId: "check_1",
      publishedCheckRunId: "pcr_publisher",
      publishRunId: "pub_publisher",
      reviewRunId: "rrn_publisher",
      status: "published",
    });
    await repository.upsertPublishedCheckRun({
      conclusion: "success",
      metadata: { annotationCount: 0 },
      provider: "github",
      providerCheckRunId: "check_1",
      publishedCheckRunId: "pcr_publisher",
      publishRunId: "pub_publisher",
      reviewRunId: "rrn_publisher",
      status: "published",
    });
    await repository.upsertPublishedReview({
      metadata: { commentIds: ["comment_1"] },
      provider: "github",
      providerReviewId: "review_1",
      publishedReviewId: "prev_publisher",
      publishRunId: "pub_publisher",
      reviewRunId: "rrn_publisher",
      status: "published",
    });
    await repository.upsertPublishedSummaryComment({
      bodyHash: "sha256:summary",
      metadata: { purpose: "fallback" },
      provider: "github",
      providerCommentId: "summary_1",
      publishedSummaryCommentId: "psc_publisher",
      publishRunId: "pub_publisher",
      reviewRunId: "rrn_publisher",
      status: "published",
    });
    await repository.upsertPublishedFinding({
      body: "Finding body",
      findingId: "pf_publisher",
      fingerprint: "fingerprint_publisher",
      location: { line: 7, path: "src/index.ts", side: "RIGHT" },
      metadata: { rank: 1 },
      provider: "github",
      providerCommentId: "comment_1",
      providerReviewId: "review_1",
      publishedAt: new Date("2026-05-08T16:02:00.000Z"),
      reviewRunId: "rrn_publisher",
      status: "published",
      title: "Finding title",
      validatedFindingId: "vf_publisher",
    });
    await repository.updatePublishRunStatus({
      completedAt: new Date("2026-05-08T16:03:00.000Z"),
      error: null,
      idempotencyKey: "review.publish.v1:rrn_publisher",
      metadata: { providerCheckRunId: "check_1" },
      status: "completed",
    });

    const [publishRun] = await sql`
      SELECT status, metadata, completed_at
      FROM publish_runs
      WHERE publish_run_id = 'pub_publisher'
    `;
    expect(publishRun).toMatchObject({
      metadata: { providerCheckRunId: "check_1" },
      status: "completed",
    });

    const [counts] = await sql`
      SELECT
        (SELECT count(*)::int FROM publish_runs) AS publish_runs,
        (SELECT count(*)::int FROM publish_operations) AS publish_operations,
        (SELECT count(*)::int FROM published_check_runs) AS published_check_runs,
        (SELECT count(*)::int FROM published_reviews) AS published_reviews,
        (SELECT count(*)::int FROM published_summary_comments) AS published_summary_comments,
        (SELECT count(*)::int FROM published_findings) AS published_findings
    `;
    expect(counts).toEqual({
      publish_runs: 1,
      publish_operations: 2,
      published_check_runs: 1,
      published_findings: 1,
      published_reviews: 1,
      published_summary_comments: 1,
    });

    const [checkRun] = await sql`
      SELECT conclusion, metadata
      FROM published_check_runs
      WHERE published_check_run_id = 'pcr_publisher'
    `;
    expect(checkRun).toMatchObject({
      conclusion: "success",
      metadata: { annotationCount: 0 },
    });

    await expect(
      repository.getLatestPublishRunForReviewRun("rrn_publisher"),
    ).resolves.toMatchObject({
      publishRunId: "pub_publisher",
      status: "completed",
    });
    await expect(repository.listPublishRunsForReviewRun("rrn_publisher")).resolves.toMatchObject([
      {
        publishRunId: "pub_publisher",
        status: "completed",
      },
    ]);
    await expect(repository.listPublishOperationsForRuns(["pub_publisher"])).resolves.toMatchObject(
      [
        {
          publishOperationId: "pop_publisher_check_started",
          status: "running",
        },
        {
          publishOperationId: "pop_publisher_check_completed",
          status: "completed",
        },
      ],
    );
    await expect(
      repository.listPublishedCheckRunsForRuns(["pub_publisher"]),
    ).resolves.toMatchObject([
      {
        conclusion: "success",
        publishedCheckRunId: "pcr_publisher",
      },
    ]);
    await expect(repository.listPublishedReviewsForRuns(["pub_publisher"])).resolves.toMatchObject([
      {
        providerReviewId: "review_1",
        publishedReviewId: "prev_publisher",
      },
    ]);
    await expect(
      repository.listPublishedSummaryCommentsForRuns(["pub_publisher"]),
    ).resolves.toMatchObject([
      {
        providerCommentId: "summary_1",
        publishedSummaryCommentId: "psc_publisher",
      },
    ]);
    await expect(
      repository.listPublishedFindingsForReviewRun("rrn_publisher", "github"),
    ).resolves.toMatchObject([
      {
        findingId: "pf_publisher",
        providerCommentId: "comment_1",
      },
    ]);
    await expect(repository.listPublishOperationsForRuns([])).resolves.toEqual([]);
  });
});

/** Seeds the minimal repository, review, and finding graph needed by publisher rows. */
async function seedPublisherRows(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO orgs (org_id, name, slug)
    VALUES ('org_publisher', 'Publisher Org', 'publisher-org')
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
      'inst_publisher',
      'org_publisher',
      'github',
      '4242',
      'publisher-org',
      'Organization',
      '2026-05-08T15:00:00.000Z'
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
      default_branch,
      visibility
    )
    VALUES (
      'repo_publisher',
      'org_publisher',
      'inst_publisher',
      'github',
      '99942',
      'publisher-org',
      'repo',
      'publisher-org/repo',
      'main',
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
      diff_hash,
      additions,
      deletions,
      changed_file_count,
      fetched_at
    )
    VALUES (
      'prs_publisher',
      'pull_request_snapshot.v1',
      'github',
      'repo_publisher',
      'inst_publisher',
      '99942',
      'pull_42',
      42,
      'Publisher PR',
      'octocat',
      'open',
      false,
      'main',
      'base_sha',
      'feature',
      'head_sha',
      'sha256:diff',
      1,
      0,
      1,
      '2026-05-08T15:10:00.000Z'
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
      'rrn_publisher',
      'review_run.v1',
      'repo_publisher',
      'prs_publisher',
      42,
      'base_sha',
      'head_sha',
      'webhook',
      'completed',
      '2026-05-08T15:30:00.000Z',
      '{"published":1}'::jsonb
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
      'cf_publisher',
      'candidate_finding.v1',
      'rrn_publisher',
      'llm',
      'review-model',
      'bug',
      'medium',
      'Finding title',
      'Finding body',
      '{"path":"src/index.ts","line":7,"side":"RIGHT"}'::jsonb,
      '[]'::jsonb,
      0.9,
      'fingerprint_publisher'
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
      'vf_publisher',
      'cf_publisher',
      'rrn_publisher',
      'publish',
      'bug',
      'medium',
      'Finding title',
      'Finding body',
      '{"path":"src/index.ts","line":7,"side":"RIGHT"}'::jsonb,
      '[]'::jsonb,
      0.9,
      '{"status":"accepted"}'::jsonb,
      1,
      'fingerprint_publisher'
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
