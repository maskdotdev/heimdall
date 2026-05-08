import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HeimdallDatabase } from "../src/client";
import { LlmCallRepository } from "../src/index";

const integrationDatabaseUrl = process.env.HEIMDALL_DB_TEST_URL;
const testDirectory = fileURLToPath(new URL(".", import.meta.url));
const bootstrapPath = resolve(testDirectory, "../bootstrap/0000_extensions.sql");
const migrationsDirectory = resolve(testDirectory, "../migrations");

/** Query result for one persisted LLM call row. */
type LlmCallRow = {
  /** Stable LLM call ID. */
  readonly llmCallId: string;
  /** Stored token count used to verify conflict-safe inserts. */
  readonly inputTokens: number;
  /** Stored metadata task value. */
  readonly task: string | null;
  /** Number of durable call rows matching the stable ID. */
  readonly totalRows: number;
};

/** Query result for one persisted LLM call artifact link. */
type LlmCallArtifactLinkRow = {
  /** Linked review artifact ID. */
  readonly reviewArtifactId: string;
  /** Link role, such as prompt or response. */
  readonly artifactRole: string;
};

describe.runIf(integrationDatabaseUrl)("LlmCallRepository integration", () => {
  const schemaName = `heimdall_llm_call_repository_test_${process.pid}_${Date.now()}`.replace(
    /[^A-Za-z0-9_]/g,
    "_",
  );
  const sql = postgres(integrationDatabaseUrl ?? "", { max: 1, onnotice: () => undefined });
  const db = drizzle(sql) as HeimdallDatabase;
  const llmCallRepository = new LlmCallRepository(db);

  beforeAll(async () => {
    await sql.unsafe(await readFile(bootstrapPath, "utf8"));
    await sql.unsafe(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await sql.unsafe(`SET search_path TO ${quoteIdentifier(schemaName)}, public`);
    await applyMigrations(sql, schemaName);
    await seedLlmCallParents(sql);
  });

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
    await sql.end();
  });

  it("inserts LLM calls and artifact links idempotently", async () => {
    await llmCallRepository.insertLlmCall({
      artifactLinks: [
        {
          artifactRole: "prompt",
          llmCallId: "llm_call_repository_test",
          reviewArtifactId: "rart_llm_call_prompt",
        },
        {
          artifactRole: "response",
          llmCallId: "llm_call_repository_test",
          reviewArtifactId: "rart_llm_call_response",
        },
      ],
      call: {
        completedAt: "2026-05-08T00:02:03.000Z",
        costMicros: 1234,
        inputTokens: 37,
        llmCallId: "llm_call_repository_test",
        metadata: { task: "review_model" },
        model: "gpt-test",
        orgId: "org_llm_call_repository_test",
        outputTokens: 11,
        promptHash: "sha256:prompt",
        provider: "openai",
        purpose: "review_model",
        repoId: "repo_llm_call_repository_test",
        responseHash: "sha256:response",
        reviewRunId: "rrn_llm_call_repository",
        startedAt: "2026-05-08T00:02:00.000Z",
        status: "succeeded",
      },
    });

    await llmCallRepository.insertLlmCall({
      artifactLinks: [
        {
          artifactRole: "prompt",
          llmCallId: "llm_call_repository_test",
          reviewArtifactId: "rart_llm_call_prompt",
        },
        {
          artifactRole: "response",
          llmCallId: "llm_call_repository_test",
          reviewArtifactId: "rart_llm_call_response",
        },
      ],
      call: {
        completedAt: "2026-05-08T00:03:03.000Z",
        costMicros: 9999,
        inputTokens: 999,
        llmCallId: "llm_call_repository_test",
        metadata: { task: "should_not_replace" },
        model: "gpt-test",
        orgId: "org_llm_call_repository_test",
        outputTokens: 999,
        promptHash: "sha256:prompt",
        provider: "openai",
        purpose: "review_model",
        repoId: "repo_llm_call_repository_test",
        responseHash: "sha256:response",
        reviewRunId: "rrn_llm_call_repository",
        startedAt: "2026-05-08T00:03:00.000Z",
        status: "succeeded",
      },
    });

    const [call] = await sql<LlmCallRow[]>`
      SELECT
        llm_call_id AS "llmCallId",
        input_tokens::int AS "inputTokens",
        metadata->>'task' AS task,
        count(*) OVER ()::int AS "totalRows"
      FROM llm_calls
      WHERE llm_call_id = 'llm_call_repository_test'
    `;
    expect(call).toEqual({
      inputTokens: 37,
      llmCallId: "llm_call_repository_test",
      task: "review_model",
      totalRows: 1,
    });

    const artifactLinks = await sql<LlmCallArtifactLinkRow[]>`
      SELECT
        review_artifact_id AS "reviewArtifactId",
        artifact_role AS "artifactRole"
      FROM llm_call_artifacts
      WHERE llm_call_id = 'llm_call_repository_test'
      ORDER BY artifact_role ASC
    `;
    expect(artifactLinks).toEqual([
      {
        artifactRole: "prompt",
        reviewArtifactId: "rart_llm_call_prompt",
      },
      {
        artifactRole: "response",
        reviewArtifactId: "rart_llm_call_response",
      },
    ]);
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

/** Seeds parent rows required by LLM call and artifact foreign keys. */
async function seedLlmCallParents(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO orgs (org_id, name, slug)
    VALUES (
      'org_llm_call_repository_test',
      'LLM Call Repository Test Org',
      'llm-call-repository-test-org'
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
      installed_at
    )
    VALUES (
      'inst_llm_call_repository_test',
      'org_llm_call_repository_test',
      'github',
      'llm-call-repository-test-installation',
      'acme',
      'organization',
      '2026-05-08T00:00:00.000Z'::timestamptz
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
      'repo_llm_call_repository_test',
      'org_llm_call_repository_test',
      'inst_llm_call_repository_test',
      'github',
      'llm-call-repository-test-repo',
      'acme',
      'heimdall',
      'acme/heimdall',
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
      'prs_llm_call_repository',
      'pull_request_snapshot.v1',
      'github',
      'repo_llm_call_repository_test',
      'inst_llm_call_repository_test',
      'llm-call-repository-test-repo',
      '123',
      123,
      'Exercise LLM call repository',
      'octocat',
      'open',
      false,
      'main',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'feature',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'sha256:llm-call-repository-diff',
      3,
      1,
      1,
      '2026-05-08T00:01:00.000Z'::timestamptz
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
      counts,
      created_at,
      updated_at
    )
    VALUES (
      'rrn_llm_call_repository',
      'review_run.v1',
      'repo_llm_call_repository_test',
      'prs_llm_call_repository',
      123,
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'webhook',
      'completed',
      '{}'::jsonb,
      '2026-05-08T00:01:30.000Z'::timestamptz,
      '2026-05-08T00:02:30.000Z'::timestamptz
    )
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
    VALUES
      (
        'rart_llm_call_prompt',
        'rrn_llm_call_repository',
        'repo_llm_call_repository_test',
        'llm_prompt',
        'prompt.json',
        'db://review_artifacts/rrn_llm_call_repository/llm_prompt/prompt.json',
        'sha256:prompt',
        128,
        '{"source":"integration_test"}'::jsonb
      ),
      (
        'rart_llm_call_response',
        'rrn_llm_call_repository',
        'repo_llm_call_repository_test',
        'llm_response',
        'response.json',
        'db://review_artifacts/rrn_llm_call_repository/llm_response/response.json',
        'sha256:response',
        256,
        '{"source":"integration_test"}'::jsonb
      )
  `;
}

/** Quotes a trusted Postgres identifier after validating its shape. */
function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(identifier)) {
    throw new Error(`Unsafe Postgres identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}
