import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HeimdallDatabase } from "../src/client";
import { CodeIntelligenceRepository } from "../src/repositories/code-intelligence-repository";

const integrationDatabaseUrl = process.env.HEIMDALL_DB_TEST_URL;
const testDirectory = fileURLToPath(new URL(".", import.meta.url));
const bootstrapPath = resolve(testDirectory, "../bootstrap/0000_extensions.sql");
const migrationsDirectory = resolve(testDirectory, "../migrations");

describe.runIf(integrationDatabaseUrl)("CodeIntelligenceRepository integration", () => {
  const schemaName = `heimdall_code_intelligence_test_${process.pid}_${Date.now()}`.replace(
    /[^A-Za-z0-9_]/g,
    "_",
  );
  const sql = postgres(integrationDatabaseUrl ?? "", { max: 1, onnotice: () => undefined });
  const db = drizzle(sql) as HeimdallDatabase;
  const codeIntelligenceRepository = new CodeIntelligenceRepository(db);

  beforeAll(async () => {
    await sql.unsafe(await readFile(bootstrapPath, "utf8"));
    await sql.unsafe(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await sql.unsafe(`SET search_path TO ${quoteIdentifier(schemaName)}, public`);
    await applyMigrations(sql, schemaName);
    await seedCodeIntelligenceRows(sql);
  });

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
    await sql.end();
  });

  it("queries symbols, chunks, and graph edges from imported index rows", async () => {
    const symbolAtLine = await codeIntelligenceRepository.findSymbolAtLine({
      commitSha: "abcdef123456",
      line: 6,
      path: "src/service.ts",
      repoId: "repo_code_intel_test",
    });
    expect(symbolAtLine).toMatchObject({
      name: "handle",
      range: { endLine: 8, startLine: 5 },
      signature: "function handle(): void",
      symbolId: "sym_code_intel_handle",
    });

    const symbolsForFile = await codeIntelligenceRepository.listSymbolsForFile({
      indexVersionId: "idx_code_intel_new",
      path: "src/service.ts",
    });
    expect(symbolsForFile.map((symbol) => symbol.symbolId)).toEqual([
      "sym_code_intel_service",
      "sym_code_intel_handle",
    ]);

    const chunksForFile = await codeIntelligenceRepository.listChunksForFile({
      indexVersionId: "idx_code_intel_new",
      path: "src/service.ts",
    });
    expect(chunksForFile).toHaveLength(1);
    expect(chunksForFile[0]).toMatchObject({
      chunkId: "chunk_code_intel_handle",
      commitSha: "abcdef123456",
      kind: "symbol",
      language: "typescript",
      range: { endLine: 8, startLine: 5 },
      symbolId: "sym_code_intel_handle",
      text: "export function handle(): void { console.log('ok'); }",
      tokenEstimate: 8,
    });

    const outgoingEdges = await codeIntelligenceRepository.listEdgesFromSymbol({
      kinds: ["calls"],
      symbolId: "sym_code_intel_handle",
    });
    expect(outgoingEdges.map((edge) => edge.edgeId)).toEqual(["edge_code_intel_calls_console"]);

    const incomingEdges = await codeIntelligenceRepository.listEdgesToSymbol({
      symbolId: "sym_code_intel_handle",
    });
    expect(incomingEdges.map((edge) => edge.edgeId)).toEqual(["edge_code_intel_reference"]);
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

/** Inserts repository, index, symbol, chunk, and edge rows for code-intelligence tests. */
async function seedCodeIntelligenceRows(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO orgs (org_id, name, slug)
    VALUES ('org_code_intel_test', 'Code Intelligence Test Org', 'code-intelligence-test-org')
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
      'inst_code_intel_test',
      'org_code_intel_test',
      'github',
      'code-intelligence-test-installation',
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
      'repo_code_intel_test',
      'org_code_intel_test',
      'inst_code_intel_test',
      'github',
      'code-intelligence-test-repo',
      'acme',
      'heimdall',
      'acme/heimdall',
      'private'
    )
  `;
  await sql`
    INSERT INTO code_index_versions (
      index_version_id,
      repo_id,
      commit_sha,
      index_key,
      status,
      artifact_uri,
      artifact_hash,
      indexer_name,
      indexer_version,
      chunker_version,
      completed_at
    )
    VALUES
      (
        'idx_code_intel_old',
        'repo_code_intel_test',
        'abcdef123456',
        'tree-sitter:1:chunks-v1',
        'ready',
        'smoke://code-intel/old',
        ${`sha256:${"1".repeat(64)}`},
        'tree-sitter',
        '1',
        'chunks-v1',
        '2026-05-08T00:01:00.000Z'::timestamptz
      ),
      (
        'idx_code_intel_new',
        'repo_code_intel_test',
        'abcdef123456',
        'tree-sitter:2:chunks-v1',
        'ready',
        'smoke://code-intel/new',
        ${`sha256:${"2".repeat(64)}`},
        'tree-sitter',
        '2',
        'chunks-v1',
        '2026-05-08T00:02:00.000Z'::timestamptz
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
    VALUES
      (
        'file_code_intel_old',
        'idx_code_intel_old',
        'repo_code_intel_test',
        'abcdef123456',
        'src/service.ts',
        'typescript',
        ${`sha256:${"3".repeat(64)}`}
      ),
      (
        'file_code_intel_new',
        'idx_code_intel_new',
        'repo_code_intel_test',
        'abcdef123456',
        'src/service.ts',
        'typescript',
        ${`sha256:${"4".repeat(64)}`}
      )
  `;
  await sql`
    INSERT INTO symbols (
      symbol_id,
      index_version_id,
      file_id,
      repo_id,
      commit_sha,
      path,
      language,
      name,
      qualified_name,
      kind,
      start_line,
      end_line,
      content_hash,
      metadata
    )
    VALUES
      (
        'sym_code_intel_old_service',
        'idx_code_intel_old',
        'file_code_intel_old',
        'repo_code_intel_test',
        'abcdef123456',
        'src/service.ts',
        'typescript',
        'oldService',
        'oldService',
        'function',
        1,
        20,
        ${`sha256:${"5".repeat(64)}`},
        '{"signature":"function oldService(): void"}'::jsonb
      ),
      (
        'sym_code_intel_service',
        'idx_code_intel_new',
        'file_code_intel_new',
        'repo_code_intel_test',
        'abcdef123456',
        'src/service.ts',
        'typescript',
        'service',
        'service',
        'function',
        1,
        20,
        ${`sha256:${"6".repeat(64)}`},
        '{"signature":"function service(): void"}'::jsonb
      ),
      (
        'sym_code_intel_handle',
        'idx_code_intel_new',
        'file_code_intel_new',
        'repo_code_intel_test',
        'abcdef123456',
        'src/service.ts',
        'typescript',
        'handle',
        'service.handle',
        'function',
        5,
        8,
        ${`sha256:${"7".repeat(64)}`},
        '{"signature":"function handle(): void"}'::jsonb
      )
  `;
  await sql`
    INSERT INTO code_chunks (
      chunk_id,
      index_version_id,
      file_id,
      symbol_id,
      repo_id,
      path,
      start_line,
      end_line,
      content_hash,
      metadata
    )
    VALUES (
      'chunk_code_intel_handle',
      'idx_code_intel_new',
      'file_code_intel_new',
      'sym_code_intel_handle',
      'repo_code_intel_test',
      'src/service.ts',
      5,
      8,
      ${`sha256:${"8".repeat(64)}`},
      '{"language":"typescript","kind":"symbol","text":"export function handle(): void { console.log(''ok''); }","tokenEstimate":8}'::jsonb
    )
  `;
  await sql`
    INSERT INTO code_edges (
      edge_id,
      index_version_id,
      repo_id,
      commit_sha,
      from_id,
      to_id,
      from_kind,
      to_kind,
      kind,
      confidence
    )
    VALUES
      (
        'edge_code_intel_calls_console',
        'idx_code_intel_new',
        'repo_code_intel_test',
        'abcdef123456',
        'sym_code_intel_handle',
        'external_console',
        'symbol',
        'external',
        'calls',
        0.95
      ),
      (
        'edge_code_intel_reference',
        'idx_code_intel_new',
        'repo_code_intel_test',
        'abcdef123456',
        'external_route',
        'sym_code_intel_handle',
        'external',
        'symbol',
        'references',
        0.9
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
