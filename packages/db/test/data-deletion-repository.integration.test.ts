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

  it("resolves scoped deletion targets and applies durable cleanup side effects", async () => {
    await seedDeletionExecutionRows(sql);

    await expect(
      dataDeletionRepository.listRepositoryIdsForDeletionScope({
        orgId: "org_data_deletion",
      }),
    ).resolves.toEqual([{ repoId: "repo_data_deletion" }]);

    await expect(
      dataDeletionRepository.listReviewArtifactPayloadDeletionTargets({
        excludeUriPrefix: "deleted://review_artifacts/",
        limit: 10,
        repoIds: ["repo_data_deletion"],
      }),
    ).resolves.toMatchObject([
      {
        reviewArtifactId: "rart_data_deletion_exec",
        uri: "db://review_artifacts/rrn_data_deletion_exec/context/context.json",
      },
    ]);
    await expect(
      dataDeletionRepository.listProviderPublicationDeletionTargets({
        limit: 10,
        provider: "github",
        repoIds: ["repo_data_deletion"],
      }),
    ).resolves.toMatchObject([
      {
        kind: "review_comment",
        providerResourceId: "provider_review_comment_data_deletion",
        repoId: "repo_data_deletion",
        sourceTable: "published_findings",
      },
      {
        kind: "issue_comment",
        providerResourceId: "provider_summary_comment_data_deletion",
        repoId: "repo_data_deletion",
        sourceTable: "published_summary_comments",
      },
      {
        kind: "check_run",
        providerResourceId: "provider_check_run_data_deletion",
        repoId: "repo_data_deletion",
        sourceTable: "published_check_runs",
      },
    ]);

    await expect(
      dataDeletionRepository.deleteCodeChunkEmbeddingsForRepositories(["repo_data_deletion"]),
    ).resolves.toBe(1);
    await expect(
      dataDeletionRepository.cancelPendingBackgroundJobsForDeletionScope({
        now: new Date("2026-05-08T03:00:00.000Z"),
        orgId: "org_data_deletion",
        reason: "data deletion request ddr_data_deletion",
        repoIds: ["repo_data_deletion"],
      }),
    ).resolves.toBe(1);
    await expect(
      dataDeletionRepository.disableRepositoriesForDeletion(["repo_data_deletion"]),
    ).resolves.toBe(1);

    const [embeddingCount] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM code_chunk_embeddings
      WHERE repo_id = 'repo_data_deletion'
    `;
    const [job] = await sql<{ error: { name?: string } | null; status: string }[]>`
      SELECT error, status
      FROM background_jobs
      WHERE background_job_id = 'job_data_deletion_pending'
    `;
    const [repository] = await sql<{ enabled: boolean }[]>`
      SELECT enabled
      FROM repositories
      WHERE repo_id = 'repo_data_deletion'
    `;

    expect(embeddingCount?.count).toBe(0);
    expect(job).toMatchObject({
      error: { name: "DataDeletionCanceledJobError" },
      status: "canceled",
    });
    expect(repository?.enabled).toBe(false);
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

/** Seeds rows touched by scoped data-deletion cleanup methods. */
async function seedDeletionExecutionRows(sql: postgres.Sql): Promise<void> {
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
      'prs_data_deletion_exec',
      'pull_request_snapshot.v1',
      'github',
      'repo_data_deletion',
      'inst_data_deletion',
      '54321',
      '99',
      99,
      'Deletion execution fixture',
      'octocat',
      'open',
      false,
      'main',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'branch',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'sha256:deletion',
      1,
      0,
      1,
      now()
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
      counts,
      created_at,
      updated_at
    )
    VALUES (
      'rrn_data_deletion_exec',
      'review_run.v1',
      'repo_data_deletion',
      'prs_data_deletion_exec',
      99,
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'manual',
      'completed',
      '{}'::jsonb,
      now(),
      now()
    )
    ON CONFLICT DO NOTHING
  `;
  await sql`
    INSERT INTO review_artifacts (
      review_artifact_id,
      review_run_id,
      repo_id,
      kind,
      name,
      uri,
      hash,
      size_bytes,
      metadata
    )
    VALUES (
      'rart_data_deletion_exec',
      'rrn_data_deletion_exec',
      'repo_data_deletion',
      'context',
      'context.json',
      'db://review_artifacts/rrn_data_deletion_exec/context/context.json',
      'sha256:context',
      128,
      '{"payload": {"sensitive": true}}'::jsonb
    )
    ON CONFLICT DO NOTHING
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
      'cfnd_data_deletion_exec',
      'candidate_finding.v1',
      'rrn_data_deletion_exec',
      'llm',
      'test',
      'correctness',
      'medium',
      'Deletion finding',
      'Finding body',
      '{"path": "src/index.ts", "startLine": 1, "endLine": 1}'::jsonb,
      '{}'::jsonb,
      0.9,
      'sha256:deletion-finding'
    )
    ON CONFLICT DO NOTHING
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
      'vfnd_data_deletion_exec',
      'cfnd_data_deletion_exec',
      'rrn_data_deletion_exec',
      'publish',
      'correctness',
      'medium',
      'Deletion finding',
      'Finding body',
      '{"path": "src/index.ts", "startLine": 1, "endLine": 1}'::jsonb,
      '{}'::jsonb,
      0.9,
      '{}'::jsonb,
      1,
      'sha256:deletion-finding'
    )
    ON CONFLICT DO NOTHING
  `;
  await sql`
    INSERT INTO publish_runs (
      publish_run_id,
      review_run_id,
      repo_id,
      idempotency_key,
      status
    )
    VALUES (
      'pub_data_deletion_exec',
      'rrn_data_deletion_exec',
      'repo_data_deletion',
      'publish:rrn_data_deletion_exec',
      'completed'
    )
    ON CONFLICT DO NOTHING
  `;
  await sql`
    INSERT INTO published_findings (
      finding_id,
      validated_finding_id,
      review_run_id,
      provider,
      provider_comment_id,
      provider_review_id,
      location,
      title,
      body,
      published_at,
      status,
      fingerprint
    )
    VALUES (
      'pfnd_data_deletion_exec',
      'vfnd_data_deletion_exec',
      'rrn_data_deletion_exec',
      'github',
      'provider_review_comment_data_deletion',
      'provider_review_data_deletion',
      '{"path": "src/index.ts", "startLine": 1, "endLine": 1}'::jsonb,
      'Deletion finding',
      'Finding body',
      now(),
      'published',
      'sha256:deletion-finding'
    )
    ON CONFLICT DO NOTHING
  `;
  await sql`
    INSERT INTO published_summary_comments (
      published_summary_comment_id,
      publish_run_id,
      review_run_id,
      provider,
      provider_comment_id,
      body_hash,
      status
    )
    VALUES (
      'psum_data_deletion_exec',
      'pub_data_deletion_exec',
      'rrn_data_deletion_exec',
      'github',
      'provider_summary_comment_data_deletion',
      'sha256:summary',
      'published'
    )
    ON CONFLICT DO NOTHING
  `;
  await sql`
    INSERT INTO published_check_runs (
      published_check_run_id,
      publish_run_id,
      review_run_id,
      provider,
      provider_check_run_id,
      status,
      conclusion
    )
    VALUES (
      'pchk_data_deletion_exec',
      'pub_data_deletion_exec',
      'rrn_data_deletion_exec',
      'github',
      'provider_check_run_data_deletion',
      'completed',
      'success'
    )
    ON CONFLICT DO NOTHING
  `;
  await sql`
    INSERT INTO code_index_versions (
      index_version_id,
      repo_id,
      commit_sha,
      index_key,
      status,
      artifact_uri,
      indexer_name,
      indexer_version,
      chunker_version
    )
    VALUES (
      'idx_data_deletion_exec',
      'repo_data_deletion',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'main',
      'ready',
      'file:///tmp/deletion-index.json',
      'test-indexer',
      '1.0.0',
      '1.0.0'
    )
    ON CONFLICT DO NOTHING
  `;
  await sql`
    INSERT INTO indexed_files (
      file_id,
      index_version_id,
      repo_id,
      commit_sha,
      path,
      language,
      content_hash
    )
    VALUES (
      'file_data_deletion_exec',
      'idx_data_deletion_exec',
      'repo_data_deletion',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'src/index.ts',
      'typescript',
      'sha256:file'
    )
    ON CONFLICT DO NOTHING
  `;
  await sql`
    INSERT INTO code_chunks (
      chunk_id,
      index_version_id,
      file_id,
      repo_id,
      path,
      start_line,
      end_line,
      content_hash
    )
    VALUES (
      'chunk_data_deletion_exec',
      'idx_data_deletion_exec',
      'file_data_deletion_exec',
      'repo_data_deletion',
      'src/index.ts',
      1,
      2,
      'sha256:chunk'
    )
    ON CONFLICT DO NOTHING
  `;
  await sql.unsafe(`
    INSERT INTO code_chunk_embeddings (
      chunk_embedding_id,
      chunk_id,
      repo_id,
      index_version_id,
      embedding_model,
      embedding_dimension,
      embedding,
      content_hash
    )
    VALUES (
      'emb_data_deletion_exec',
      'chunk_data_deletion_exec',
      'repo_data_deletion',
      'idx_data_deletion_exec',
      'test-embedding',
      1536,
      '${testVectorLiteral()}'::vector,
      'sha256:chunk'
    )
    ON CONFLICT DO NOTHING
  `);
  await sql`
    INSERT INTO background_jobs (
      background_job_id,
      queue_name,
      job_key,
      job_type,
      status,
      org_id,
      repo_id,
      review_run_id,
      payload
    )
    VALUES (
      'job_data_deletion_pending',
      'review',
      'review:repo_data_deletion:99',
      'pr.review.v1',
      'pending',
      'org_data_deletion',
      'repo_data_deletion',
      'rrn_data_deletion_exec',
      '{}'::jsonb
    )
    ON CONFLICT DO NOTHING
  `;
}

/** Builds a deterministic 1536-d pgvector literal for integration fixtures. */
function testVectorLiteral(): string {
  return `[${Array.from({ length: 1536 }, (_, index) => (index === 0 ? "1" : "0")).join(",")}]`;
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
