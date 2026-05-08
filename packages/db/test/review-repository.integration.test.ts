import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CandidateFinding, ReviewRun, ValidatedFinding } from "@repo/contracts";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HeimdallDatabase } from "../src/client";
import { ReviewRepository } from "../src/index";

const integrationDatabaseUrl = process.env.HEIMDALL_DB_TEST_URL;
const testDirectory = fileURLToPath(new URL(".", import.meta.url));
const bootstrapPath = resolve(testDirectory, "../bootstrap/0000_extensions.sql");
const migrationsDirectory = resolve(testDirectory, "../migrations");

describe.runIf(integrationDatabaseUrl)("ReviewRepository integration", () => {
  const schemaName = `heimdall_review_repository_test_${process.pid}_${Date.now()}`.replace(
    /[^A-Za-z0-9_]/g,
    "_",
  );
  const sql = postgres(integrationDatabaseUrl ?? "", { max: 1, onnotice: () => undefined });
  const db = drizzle(sql) as HeimdallDatabase;
  const reviewRepository = new ReviewRepository(db);

  beforeAll(async () => {
    await sql.unsafe(await readFile(bootstrapPath, "utf8"));
    await sql.unsafe(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await sql.unsafe(`SET search_path TO ${quoteIdentifier(schemaName)}, public`);
    await applyMigrations(sql, schemaName);
    await seedReviewParents(sql);
  });

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
    await sql.end();
  });

  it("upserts review runs and returns stored findings on idempotent conflicts", async () => {
    const createdRun = await reviewRepository.upsertReviewRun(
      reviewRunFixture({ status: "created" }),
    );
    expect(createdRun).toMatchObject({
      reviewRunId: "rrn_review_repository",
      status: "created",
    });

    const completedRun = await reviewRepository.upsertReviewRun(
      reviewRunFixture({
        completedAt: "2026-05-08T00:03:00.000Z",
        counts: {
          candidateFindings: 1,
          publishedFindings: 0,
          rejectedFindings: 0,
          validatedFindings: 1,
        },
        status: "completed",
        summary: "One finding validated.",
      }),
    );
    expect(completedRun).toMatchObject({
      completedAt: "2026-05-08T00:03:00.000Z",
      counts: { candidateFindings: 1, validatedFindings: 1 },
      status: "completed",
      summary: "One finding validated.",
    });

    const candidate = await reviewRepository.insertCandidateFinding(
      candidateFindingFixture({
        findingId: "fnd_review_repository_candidate",
        title: "Validate user input before saving",
      }),
    );
    expect(candidate.findingId).toBe("fnd_review_repository_candidate");

    const duplicateCandidate = await reviewRepository.insertCandidateFinding(
      candidateFindingFixture({
        findingId: "fnd_review_repository_candidate_duplicate",
        title: "Different title should not replace stored finding",
      }),
    );
    expect(duplicateCandidate).toMatchObject({
      findingId: "fnd_review_repository_candidate",
      title: "Validate user input before saving",
    });

    const candidates = await reviewRepository.listCandidateFindings("rrn_review_repository");
    expect(candidates.map((finding) => finding.findingId)).toEqual([
      "fnd_review_repository_candidate",
    ]);

    const validated = await reviewRepository.insertValidatedFinding(
      validatedFindingFixture({
        findingId: "fnd_review_repository_validated",
        title: "Validate user input before saving",
      }),
    );
    expect(validated.findingId).toBe("fnd_review_repository_validated");

    const duplicateValidated = await reviewRepository.insertValidatedFinding(
      validatedFindingFixture({
        findingId: "fnd_review_repository_validated",
        title: "Different validated title should not replace stored finding",
      }),
    );
    expect(duplicateValidated).toMatchObject({
      findingId: "fnd_review_repository_validated",
      title: "Validate user input before saving",
    });

    const validatedFindings = await reviewRepository.listValidatedFindings("rrn_review_repository");
    expect(validatedFindings.map((finding) => finding.findingId)).toEqual([
      "fnd_review_repository_validated",
    ]);

    await reviewRepository.insertSuppressionMatches([
      {
        candidateFindingId: "fnd_review_repository_candidate",
        confidence: 0.91,
        createdAt: "2026-05-08T00:04:00.000Z",
        findingId: "fnd_review_repository_validated",
        matchKind: "exact",
        memoryFactId: "mem_review_repository_suppression",
        orgId: "org_review_repository_test",
        reason: "Matches a stored suppression fact.",
        repoId: "repo_review_repository_test",
        reviewRunId: "rrn_review_repository",
        suppressionMatchId: "sm_review_repository",
      },
    ]);
    const suppressionMatches = await reviewRepository.listRepositorySuppressionMatches({
      limit: 10,
      repoId: "repo_review_repository_test",
    });
    expect(suppressionMatches).toEqual([
      expect.objectContaining({
        candidateFindingId: "fnd_review_repository_candidate",
        confidence: 0.91,
        createdAt: new Date("2026-05-08T00:04:00.000Z"),
        findingCategory: "correctness",
        findingId: "fnd_review_repository_validated",
        findingSeverity: "medium",
        findingTitle: "Validate user input before saving",
        location: expect.objectContaining({ path: "src/service.ts" }),
        matchKind: "exact",
        memoryFactId: "mem_review_repository_suppression",
        memoryStatus: "active",
        memoryText: "Suppress already accepted validation findings.",
        reason: "Matches a stored suppression fact.",
        reviewRunId: "rrn_review_repository",
        suppressionMatchId: "sm_review_repository",
      }),
    ]);
    await expect(
      reviewRepository.listRepositorySuppressionMatches({
        limit: 0,
        repoId: "repo_review_repository_test",
      }),
    ).rejects.toThrow(/limit must be an integer/u);
    await expect(
      reviewRepository.listRepositorySuppressionMatches({
        repoId: "repo_review_repository_other",
      }),
    ).resolves.toEqual([]);
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

/** Inserts repository and pull request snapshot parent rows for review repository tests. */
async function seedReviewParents(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO orgs (org_id, name, slug)
    VALUES ('org_review_repository_test', 'Review Repository Test Org', 'review-repository-test-org')
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
      'inst_review_repository_test',
      'org_review_repository_test',
      'github',
      'review-repository-test-installation',
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
      'repo_review_repository_test',
      'org_review_repository_test',
      'inst_review_repository_test',
      'github',
      'review-repository-test-repo',
      'acme',
      'heimdall',
      'acme/heimdall',
      'private'
    )
  `;
  await sql`
    INSERT INTO memory_facts (
      memory_fact_id,
      org_id,
      repo_id,
      fact_type,
      body,
      status,
      confidence,
      metadata,
      created_at,
      updated_at
    )
    VALUES (
      'mem_review_repository_suppression',
      'org_review_repository_test',
      'repo_review_repository_test',
      'suppression',
      'Suppress already accepted validation findings.',
      'active',
      0.95,
      ${JSON.stringify({ source: "integration_test" })}::jsonb,
      '2026-05-08T00:00:00.000Z',
      '2026-05-08T00:01:00.000Z'
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
      labels,
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
      'prs_review_repository',
      'pull_request_snapshot.v1',
      'github',
      'repo_review_repository_test',
      'inst_review_repository_test',
      'review-repository-test-repo',
      '42',
      42,
      'Improve validation',
      'octocat',
      'open',
      false,
      '[]'::jsonb,
      'main',
      '1111111',
      'feature',
      '2222222',
      '[]'::jsonb,
      ${`sha256:${"d".repeat(64)}`},
      3,
      1,
      1,
      '2026-05-08T00:00:00.000Z'::timestamptz
    )
  `;
}

/** Builds a review-run fixture for repository tests. */
function reviewRunFixture(overrides: Partial<ReviewRun> = {}): ReviewRun {
  return {
    reviewRunId: "rrn_review_repository",
    schemaVersion: "review_run.v1",
    repoId: "repo_review_repository_test",
    pullRequestSnapshotId: "prs_review_repository",
    pullRequestNumber: 42,
    baseSha: "1111111",
    headSha: "2222222",
    trigger: "webhook",
    status: "created",
    createdAt: "2026-05-08T00:01:00.000Z",
    updatedAt: "2026-05-08T00:02:00.000Z",
    artifactRefs: [],
    counts: {
      candidateFindings: 0,
      publishedFindings: 0,
      rejectedFindings: 0,
      validatedFindings: 0,
    },
    ...overrides,
  };
}

/** Builds a candidate finding fixture for repository tests. */
function candidateFindingFixture(overrides: Partial<CandidateFinding> = {}): CandidateFinding {
  return {
    findingId: "fnd_review_repository_candidate",
    schemaVersion: "candidate_finding.v1",
    reviewRunId: "rrn_review_repository",
    source: "llm",
    sourceName: "correctness",
    category: "correctness",
    severity: "medium",
    title: "Validate user input before saving",
    body: "The new code stores unvalidated input.",
    location: {
      path: "src/service.ts",
      line: 12,
      side: "RIGHT",
      isInDiff: true,
    },
    evidence: [
      {
        evidenceId: "ev_review_repository",
        kind: "diff",
        summary: "The changed line saves request input directly.",
        path: "src/service.ts",
        range: { endLine: 12, startLine: 12 },
        confidence: 0.9,
      },
    ],
    confidence: 0.88,
    fingerprint: "review-repository-fingerprint",
    createdAt: "2026-05-08T00:02:00.000Z",
    ...overrides,
  };
}

/** Builds a validated finding fixture for repository tests. */
function validatedFindingFixture(overrides: Partial<ValidatedFinding> = {}): ValidatedFinding {
  const candidate = candidateFindingFixture();

  return {
    findingId: "fnd_review_repository_validated",
    candidateFindingId: "fnd_review_repository_candidate",
    reviewRunId: "rrn_review_repository",
    decision: "publish",
    category: candidate.category,
    severity: candidate.severity,
    title: "Validate user input before saving",
    body: candidate.body,
    location: candidate.location,
    evidence: candidate.evidence,
    confidence: candidate.confidence,
    validation: {
      validatedAt: "2026-05-08T00:03:00.000Z",
      validatorVersion: "review-repository-test",
      reasons: [],
    },
    rank: 1,
    fingerprint: candidate.fingerprint,
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
