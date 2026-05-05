import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import {
  backgroundJobs,
  codeChunkEmbeddings,
  codeIndexVersions,
  indexedFiles,
  publishedCheckRuns,
  publishedReviews,
  publishedSummaryComments,
  pullRequests,
  repositories,
  reviewArtifacts,
  usageEvents,
  webhookEvents,
} from "../src/schema";

const testDirectory = fileURLToPath(new URL(".", import.meta.url));
const bootstrapPath = resolve(testDirectory, "../bootstrap/0000_extensions.sql");
const migrationPath = resolve(testDirectory, "../migrations/0000_foundation.sql");
const integrationDatabaseUrl = process.env.HEIMDALL_DB_TEST_URL;

describe("database schema foundation", () => {
  it("defines the provider repository uniqueness target", () => {
    expect(repositories.providerRepoId.name).toBe("provider_repo_id");
  });

  it("defines the Phase 2 persistence surfaces", () => {
    expect(webhookEvents.webhookEventId.name).toBe("webhook_event_id");
    expect(backgroundJobs.backgroundJobId.name).toBe("background_job_id");
    expect(pullRequests.pullRequestId.name).toBe("pull_request_id");
    expect(codeIndexVersions.indexKey.name).toBe("index_key");
    expect(indexedFiles.fileId.name).toBe("file_id");
    expect(reviewArtifacts.reviewArtifactId.name).toBe("review_artifact_id");
    expect(publishedReviews.publishedReviewId.name).toBe("published_review_id");
    expect(publishedSummaryComments.publishedSummaryCommentId.name).toBe(
      "published_summary_comment_id",
    );
    expect(publishedCheckRuns.publishedCheckRunId.name).toBe("published_check_run_id");
    expect(usageEvents.usageEventId.name).toBe("usage_event_id");
  });

  it("defines pgvector storage for code chunk embeddings", () => {
    expect(codeChunkEmbeddings.embedding.name).toBe("embedding");
  });

  it("ships the generated foundation migration and extension bootstrap", async () => {
    const bootstrap = await readFile(bootstrapPath, "utf8");
    const migration = await readFile(migrationPath, "utf8");

    expect(bootstrap).toContain("CREATE EXTENSION IF NOT EXISTS vector");
    expect(bootstrap).toContain("CREATE EXTENSION IF NOT EXISTS pgcrypto");
    expect(migration).toContain('CREATE TABLE "webhook_events"');
    expect(migration).toContain('CREATE TABLE "background_jobs"');
    expect(migration).toContain('CREATE TABLE "pull_requests"');
    expect(migration).toContain('CREATE TABLE "indexed_files"');
    expect(migration).toContain('CREATE TABLE "symbols"');
    expect(migration).toContain('CREATE TABLE "code_edges"');
    expect(migration).toContain('CREATE TABLE "code_chunk_embeddings"');
    expect(migration).toContain('CREATE TABLE "review_runs"');
    expect(migration).toContain('CREATE TABLE "review_artifacts"');
    expect(migration).toContain('CREATE TABLE "publish_runs"');
    expect(migration).toContain('CREATE TABLE "published_reviews"');
    expect(migration).toContain('CREATE TABLE "published_summary_comments"');
    expect(migration).toContain('CREATE TABLE "published_check_runs"');
    expect(migration).toContain('CREATE TABLE "published_findings"');
    expect(migration).toContain('CREATE TABLE "finding_outcomes"');
    expect(migration).toContain('CREATE TABLE "llm_calls"');
    expect(migration).toContain('CREATE TABLE "llm_call_artifacts"');
    expect(migration).toContain('CREATE TABLE "usage_events"');
    expect(migration).toContain('CREATE UNIQUE INDEX "code_index_versions_repo_commit_key_unique"');
    expect(migration).toContain('"embedding" vector(1536) NOT NULL');
  });
});

describe.runIf(integrationDatabaseUrl)("foundation migration integration", () => {
  const schemaName = `heimdall_test_${process.pid}_${Date.now()}`.replace(/[^A-Za-z0-9_]/g, "_");
  const sql = postgres(integrationDatabaseUrl ?? "", { max: 1 });

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await sql.end();
  });

  it("applies from an empty schema and supports core Phase 2 rows", async () => {
    const bootstrap = await readFile(bootstrapPath, "utf8");
    const migration = await readFile(migrationPath, "utf8");

    await sql.unsafe(`CREATE SCHEMA "${schemaName}"`);
    await sql.unsafe(`SET search_path TO "${schemaName}", public`);
    await sql.unsafe(bootstrap);
    await sql.unsafe(migration);

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
      VALUES ('inst_test', 'org_test', 'github', '123', 'test-org', 'organization', now())
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
        '456',
        'test-org',
        'heimdall',
        'test-org/heimdall',
        'private'
      )
    `;
    await sql`
      INSERT INTO webhook_events (
        webhook_event_id,
        provider,
        delivery_id,
        event_name,
        repo_id,
        payload_hash
      )
      VALUES ('webhook_test', 'github', 'delivery-1', 'pull_request', 'repo_test', 'hash')
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
        'idx_test',
        'repo_test',
        'abcdef123456',
        'tree-sitter:1:1',
        'ready',
        's3://bucket/index',
        'tree-sitter',
        '1',
        '1'
      )
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
      VALUES ('file_test', 'idx_test', 'repo_test', 'abcdef123456', 'src/index.ts', 'typescript', 'hash')
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
      VALUES ('chunk_test', 'idx_test', 'file_test', 'repo_test', 'src/index.ts', 1, 3, 'hash')
    `;
    await sql`
      INSERT INTO code_chunk_embeddings (
        chunk_embedding_id,
        chunk_id,
        repo_id,
        index_version_id,
        embedding_model,
        embedding,
        content_hash
      )
      VALUES (
        'emb_test',
        'chunk_test',
        'repo_test',
        'idx_test',
        'text-embedding-3-small',
        '[' || repeat('0,', 1535) || '0]',
        'hash'
      )
    `;

    const [result] = await sql`
      SELECT
        (SELECT count(*)::int FROM webhook_events) AS webhook_events,
        (SELECT count(*)::int FROM code_index_versions) AS index_versions,
        (SELECT count(*)::int FROM code_chunk_embeddings) AS embeddings
    `;

    expect(result).toEqual({
      webhook_events: 1,
      index_versions: 1,
      embeddings: 1,
    });
  });
});
