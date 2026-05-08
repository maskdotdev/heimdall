import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HeimdallDatabase } from "../src/client";
import { MemoryCandidateRepository } from "../src/repositories/memory-candidate-repository";
import { MemoryFactRepository } from "../src/repositories/memory-fact-repository";

const integrationDatabaseUrl = process.env.HEIMDALL_DB_TEST_URL;
const testDirectory = fileURLToPath(new URL(".", import.meta.url));
const bootstrapPath = resolve(testDirectory, "../bootstrap/0000_extensions.sql");
const migrationsDirectory = resolve(testDirectory, "../migrations");

describe.runIf(integrationDatabaseUrl)("MemoryFactRepository integration", () => {
  const schemaName = `heimdall_memory_fact_test_${process.pid}_${Date.now()}`.replace(
    /[^A-Za-z0-9_]/g,
    "_",
  );
  const sql = postgres(integrationDatabaseUrl ?? "", { max: 1, onnotice: () => undefined });
  const db = drizzle(sql) as HeimdallDatabase;
  const memoryCandidateRepository = new MemoryCandidateRepository(db);
  const memoryFactRepository = new MemoryFactRepository(db);

  beforeAll(async () => {
    await sql.unsafe(await readFile(bootstrapPath, "utf8"));
    await sql.unsafe(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await sql.unsafe(`SET search_path TO ${quoteIdentifier(schemaName)}, public`);
    await applyMigrations(sql, schemaName);
    await seedRepositoryParents(sql);
    await seedMemoryFacts(sql);
    await seedMemoryCandidates(sql);
  });

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
    await sql.end();
  });

  it("lists active repository and organization memory facts for review", async () => {
    const facts = await memoryFactRepository.listActiveReviewMemoryFacts({
      limit: 10,
      now: new Date("2026-05-08T12:00:00.000Z"),
      orgId: "org_memory_fact_test",
      repoId: "repo_memory_fact_test",
    });

    expect(facts.map((fact) => fact.memoryFactId)).toEqual([
      "mem_memory_fact_repo_recent",
      "mem_memory_fact_org",
    ]);
    expect(facts[0]).toMatchObject({
      body: "Do not comment on generated client snapshots.",
      factType: "suppression",
      metadata: {
        appliesTo: {
          pathGlobs: ["src/generated/**"],
        },
        source: "feedback",
      },
      orgId: "org_memory_fact_test",
      repoId: "repo_memory_fact_test",
      status: "active",
    });

    await expect(
      memoryFactRepository.listActiveReviewMemoryFacts({
        limit: 1,
        now: new Date("2026-05-08T12:00:00.000Z"),
        orgId: "org_memory_fact_test",
        repoId: "repo_memory_fact_test",
      }),
    ).resolves.toHaveLength(1);
    await expect(
      memoryFactRepository.listActiveReviewMemoryFacts({
        limit: 0,
        now: new Date("2026-05-08T12:00:00.000Z"),
        orgId: "org_memory_fact_test",
        repoId: "repo_memory_fact_test",
      }),
    ).rejects.toThrow(/limit must be an integer/u);
  });

  it("lists repository and organization memory facts for inspection", async () => {
    await expect(memoryFactRepository.getMemoryFact("mem_memory_fact_org")).resolves.toMatchObject({
      body: "Prefer concise findings.",
      memoryFactId: "mem_memory_fact_org",
      repoId: null,
    });
    await expect(memoryFactRepository.getMemoryFact("mem_memory_fact_missing")).resolves.toBe(
      undefined,
    );

    const facts = await memoryFactRepository.listRepositoryMemoryFacts({
      orgId: "org_memory_fact_test",
      repoId: "repo_memory_fact_test",
    });

    expect(facts.map((fact) => fact.memoryFactId)).toEqual([
      "mem_memory_fact_expired",
      "mem_memory_fact_repo_recent",
      "mem_memory_fact_org",
      "mem_memory_fact_disabled",
    ]);

    const filteredFacts = await memoryFactRepository.listRepositoryMemoryFacts({
      factType: "suppression",
      includeOrgFacts: false,
      limit: 1,
      orgId: "org_memory_fact_test",
      repoId: "repo_memory_fact_test",
      status: "active",
    });
    expect(filteredFacts.map((fact) => fact.memoryFactId)).toEqual(["mem_memory_fact_expired"]);
  });

  it("lists repository and organization memory candidates for inspection", async () => {
    await expect(
      memoryCandidateRepository.getMemoryCandidate("memcand_memory_fact_repo_recent"),
    ).resolves.toMatchObject({
      memoryCandidateId: "memcand_memory_fact_repo_recent",
      proposedContent: "Suppress generated client comments.",
      repoId: "repo_memory_fact_test",
    });
    await expect(
      memoryCandidateRepository.getMemoryCandidate("memcand_memory_fact_missing"),
    ).resolves.toBe(undefined);

    const candidates = await memoryCandidateRepository.listRepositoryMemoryCandidates({
      orgId: "org_memory_fact_test",
      repoId: "repo_memory_fact_test",
    });

    expect(candidates.map((candidate) => candidate.memoryCandidateId)).toEqual([
      "memcand_memory_fact_org",
      "memcand_memory_fact_repo_recent",
      "memcand_memory_fact_repo_older",
    ]);
    expect(candidates[1]).toMatchObject({
      candidateKind: "suppression",
      createdByLogin: "maintainer",
      metadata: { source: "review_feedback" },
      orgId: "org_memory_fact_test",
      proposedAppliesTo: { pathGlobs: ["src/generated/**"] },
      proposedContent: "Suppress generated client comments.",
      proposedScope: { scope: "repository" },
      repoId: "repo_memory_fact_test",
      sourceKind: "feedback",
      status: "pending",
      trustLevel: "maintainer",
    });

    const filteredCandidates = await memoryCandidateRepository.listRepositoryMemoryCandidates({
      candidateKind: "suppression",
      includeOrgCandidates: false,
      limit: 1,
      orgId: "org_memory_fact_test",
      repoId: "repo_memory_fact_test",
      status: "pending",
    });
    expect(filteredCandidates.map((candidate) => candidate.memoryCandidateId)).toEqual([
      "memcand_memory_fact_repo_recent",
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

/** Inserts organization, installation, and repository rows for memory fact tests. */
async function seedRepositoryParents(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO orgs (org_id, name, slug)
    VALUES
      ('org_memory_fact_test', 'Memory Fact Test Org', 'memory-fact-test-org'),
      ('org_memory_fact_other', 'Other Memory Fact Org', 'other-memory-fact-org')
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
    VALUES
      (
        'inst_memory_fact_test',
        'org_memory_fact_test',
        'github',
        'memory-fact-test-installation',
        'acme',
        'organization',
        now()
      ),
      (
        'inst_memory_fact_other',
        'org_memory_fact_other',
        'github',
        'memory-fact-other-installation',
        'other',
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
    VALUES
      (
        'repo_memory_fact_test',
        'org_memory_fact_test',
        'inst_memory_fact_test',
        'github',
        'memory-fact-test-repo',
        'acme',
        'heimdall',
        'acme/heimdall',
        'private'
      ),
      (
        'repo_memory_fact_other',
        'org_memory_fact_other',
        'inst_memory_fact_other',
        'github',
        'memory-fact-other-repo',
        'other',
        'heimdall',
        'other/heimdall',
        'private'
      )
  `;
}

/** Inserts memory fact rows that exercise scope, status, expiration, and ordering filters. */
async function seedMemoryFacts(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO memory_facts (
      memory_fact_id,
      org_id,
      repo_id,
      fact_type,
      body,
      status,
      confidence,
      expires_at,
      metadata,
      created_at,
      updated_at
    )
    VALUES
      (
        'mem_memory_fact_org',
        'org_memory_fact_test',
        null,
        'team_preference',
        'Prefer concise findings.',
        'active',
        0.85,
        null,
        ${JSON.stringify({ source: "manual" })}::jsonb,
        '2026-05-08T00:00:00.000Z',
        '2026-05-08T00:01:00.000Z'
      ),
      (
        'mem_memory_fact_repo_recent',
        'org_memory_fact_test',
        'repo_memory_fact_test',
        'suppression',
        'Do not comment on generated client snapshots.',
        'active',
        0.92,
        null,
        ${JSON.stringify({
          appliesTo: {
            pathGlobs: ["src/generated/**"],
          },
          source: "feedback",
        })}::jsonb,
        '2026-05-08T00:00:00.000Z',
        '2026-05-08T00:02:00.000Z'
      ),
      (
        'mem_memory_fact_disabled',
        'org_memory_fact_test',
        'repo_memory_fact_test',
        'suppression',
        'Disabled facts are not review inputs.',
        'disabled',
        0.5,
        null,
        ${JSON.stringify({ source: "manual" })}::jsonb,
        '2026-05-08T00:00:00.000Z',
        '2026-05-08T00:03:00.000Z'
      ),
      (
        'mem_memory_fact_expired',
        'org_memory_fact_test',
        'repo_memory_fact_test',
        'suppression',
        'Expired facts are not review inputs.',
        'active',
        0.5,
        '2026-05-08T00:00:00.000Z',
        ${JSON.stringify({ source: "manual" })}::jsonb,
        '2026-05-08T00:00:00.000Z',
        '2026-05-08T00:04:00.000Z'
      ),
      (
        'mem_memory_fact_other_repo',
        'org_memory_fact_other',
        'repo_memory_fact_other',
        'suppression',
        'Other repositories are not review inputs.',
        'active',
        0.5,
        null,
        ${JSON.stringify({ source: "manual" })}::jsonb,
        '2026-05-08T00:00:00.000Z',
        '2026-05-08T00:05:00.000Z'
      )
  `;
}

/** Inserts memory candidate rows that exercise scope and ordering filters. */
async function seedMemoryCandidates(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO memory_candidates (
      memory_candidate_id,
      org_id,
      repo_id,
      source_kind,
      candidate_kind,
      proposed_content,
      proposed_scope,
      proposed_applies_to,
      confidence,
      trust_level,
      status,
      created_by_login,
      metadata,
      created_at,
      updated_at
    )
    VALUES
      (
        'memcand_memory_fact_org',
        'org_memory_fact_test',
        null,
        'manual',
        'team_preference',
        'Prefer short explanations.',
        ${JSON.stringify({ scope: "organization" })}::jsonb,
        ${JSON.stringify({})}::jsonb,
        0.8,
        'admin',
        'approved',
        'owner',
        ${JSON.stringify({ source: "manual" })}::jsonb,
        '2026-05-08T00:00:00.000Z',
        '2026-05-08T00:01:00.000Z'
      ),
      (
        'memcand_memory_fact_repo_recent',
        'org_memory_fact_test',
        'repo_memory_fact_test',
        'feedback',
        'suppression',
        'Suppress generated client comments.',
        ${JSON.stringify({ scope: "repository" })}::jsonb,
        ${JSON.stringify({ pathGlobs: ["src/generated/**"] })}::jsonb,
        0.92,
        'maintainer',
        'pending',
        'maintainer',
        ${JSON.stringify({ source: "review_feedback" })}::jsonb,
        '2026-05-08T00:00:00.000Z',
        '2026-05-08T00:03:00.000Z'
      ),
      (
        'memcand_memory_fact_repo_older',
        'org_memory_fact_test',
        'repo_memory_fact_test',
        'feedback',
        'suppression',
        'Suppress generated fixtures.',
        ${JSON.stringify({ scope: "repository" })}::jsonb,
        ${JSON.stringify({ pathGlobs: ["fixtures/**"] })}::jsonb,
        0.7,
        'maintainer',
        'pending',
        'maintainer',
        ${JSON.stringify({ source: "review_feedback" })}::jsonb,
        '2026-05-08T00:00:00.000Z',
        '2026-05-08T00:02:00.000Z'
      ),
      (
        'memcand_memory_fact_other',
        'org_memory_fact_other',
        'repo_memory_fact_other',
        'manual',
        'team_preference',
        'Other org candidates are not visible.',
        ${JSON.stringify({ scope: "repository" })}::jsonb,
        ${JSON.stringify({})}::jsonb,
        0.5,
        'admin',
        'pending',
        'owner',
        ${JSON.stringify({ source: "manual" })}::jsonb,
        '2026-05-08T00:00:00.000Z',
        '2026-05-08T00:04:00.000Z'
      )
  `;
}

/** Quotes a trusted Postgres identifier after validating its shape. */
function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(identifier)) {
    throw new Error(`Unsafe Postgres identifier: ${identifier}`);
  }

  return `"${identifier.replaceAll('"', '""')}"`;
}
