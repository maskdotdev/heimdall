import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HeimdallDatabase } from "../src/client";
import {
  type SandboxArtifactInsert,
  type SandboxPolicyDecisionInsert,
  SandboxRepository,
  type SandboxRunInsert,
} from "../src/index";

const integrationDatabaseUrl = process.env.HEIMDALL_DB_TEST_URL;
const testDirectory = fileURLToPath(new URL(".", import.meta.url));
const bootstrapPath = resolve(testDirectory, "../bootstrap/0000_extensions.sql");
const migrationsDirectory = resolve(testDirectory, "../migrations");

describe.runIf(integrationDatabaseUrl)("SandboxRepository integration", () => {
  const schemaName = `heimdall_sandbox_repository_test_${process.pid}_${Date.now()}`.replace(
    /[^A-Za-z0-9_]/g,
    "_",
  );
  const sql = postgres(integrationDatabaseUrl ?? "", { max: 1, onnotice: () => undefined });
  const db = drizzle(sql) as HeimdallDatabase;
  const sandboxRepository = new SandboxRepository(db);

  beforeAll(async () => {
    await sql.unsafe(await readFile(bootstrapPath, "utf8"));
    await sql.unsafe(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await sql.unsafe(`SET search_path TO ${quoteIdentifier(schemaName)}, public`);
    await applyMigrations(sql, schemaName);
    await seedSandboxParents(sql);
    await seedSandboxRuns(sql);
  });

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
    await sql.end();
  });

  it("upserts sandbox runs and replaces child rows", async () => {
    await sandboxRepository.upsertSandboxRunWithChildren({
      artifacts: [sandboxArtifactInsertFixture()],
      policyDecisions: [sandboxPolicyDecisionInsertFixture()],
      run: sandboxRunInsertFixture(),
    });

    const [created] = await sql`
      SELECT
        status,
        stdout_hash,
        (
          SELECT count(*)::int
          FROM sandbox_artifacts
          WHERE sandbox_run_id = 'srun_sandbox_persisted'
        ) AS artifact_count,
        (
          SELECT count(*)::int
          FROM sandbox_policy_decisions
          WHERE sandbox_run_id = 'srun_sandbox_persisted'
        ) AS policy_decision_count
      FROM sandbox_runs
      WHERE sandbox_run_id = 'srun_sandbox_persisted'
    `;
    expect(created).toMatchObject({
      artifact_count: 1,
      policy_decision_count: 1,
      status: "completed",
      stdout_hash: "sha256:initial-stdout",
    });

    await sandboxRepository.upsertSandboxRunWithChildren({
      artifacts: [
        sandboxArtifactInsertFixture({
          name: "replacement-log.json",
          sandboxArtifactId: "sart_sandbox_persisted_replacement_log",
          uri: "file:///tmp/sandbox-persisted-replacement-log.json",
        }),
      ],
      policyDecisions: [],
      run: sandboxRunInsertFixture({
        errorJson: { message: "Sandbox command failed." },
        exitCode: 1,
        finishedAt: new Date("2026-05-08T00:12:00.000Z"),
        status: "failed",
        stdoutHash: "sha256:updated-stdout",
        updatedAt: new Date("2026-05-08T00:12:00.000Z"),
      }),
    });

    const [updated] = await sql`
      SELECT
        status,
        stdout_hash,
        error_json,
        (
          SELECT count(*)::int
          FROM sandbox_artifacts
          WHERE sandbox_run_id = 'srun_sandbox_persisted'
        ) AS artifact_count,
        (
          SELECT count(*)::int
          FROM sandbox_policy_decisions
          WHERE sandbox_run_id = 'srun_sandbox_persisted'
        ) AS policy_decision_count
      FROM sandbox_runs
      WHERE sandbox_run_id = 'srun_sandbox_persisted'
    `;
    expect(updated).toMatchObject({
      artifact_count: 1,
      error_json: { message: "Sandbox command failed." },
      policy_decision_count: 0,
      status: "failed",
      stdout_hash: "sha256:updated-stdout",
    });
    await expect(
      sandboxRepository.listSandboxArtifactUrisForRuns(["srun_sandbox_persisted"]),
    ).resolves.toEqual([{ uri: "file:///tmp/sandbox-persisted-replacement-log.json" }]);
  });

  it("lists cleanup targets and deletes sandbox runs with cascaded children", async () => {
    await expect(
      sandboxRepository.listSandboxRunCleanupTargets({
        cutoff: new Date("2026-05-08T00:05:00.000Z"),
        limit: 10,
        repoId: "repo_sandbox_repository_test",
      }),
    ).resolves.toEqual([
      { sandboxRunId: "srun_sandbox_old_a" },
      { sandboxRunId: "srun_sandbox_old_b" },
    ]);
    await expect(
      sandboxRepository.listSandboxRunCleanupTargets({
        cutoff: new Date("2026-05-08T00:05:00.000Z"),
        limit: 1,
        repoId: "repo_sandbox_repository_test",
      }),
    ).resolves.toEqual([{ sandboxRunId: "srun_sandbox_old_a" }]);
    await expect(
      sandboxRepository.listSandboxRunCleanupTargets({
        cutoff: new Date("2026-05-08T00:05:00.000Z"),
        limit: 0,
        repoId: "repo_sandbox_repository_test",
      }),
    ).rejects.toThrow(/limit must be an integer/u);
    await expect(sandboxRepository.listSandboxArtifactUrisForRuns([])).resolves.toEqual([]);
    await expect(
      sandboxRepository.listSandboxArtifactUrisForRuns([
        "srun_sandbox_old_b",
        "srun_sandbox_old_a",
        "srun_sandbox_old_b",
      ]),
    ).resolves.toEqual([
      { uri: "file:///tmp/sandbox-old-a-log.json" },
      { uri: "file:///tmp/sandbox-old-b-report.json" },
      { uri: "file:///tmp/sandbox-old-b-trace.json" },
    ]);

    await sandboxRepository.deleteSandboxRuns(["srun_sandbox_old_b", "srun_sandbox_old_a"]);
    await sandboxRepository.deleteSandboxRuns([]);

    const [counts] = await sql`
      SELECT
        (
          SELECT count(*)::int
          FROM sandbox_runs
          WHERE sandbox_run_id IN ('srun_sandbox_old_a', 'srun_sandbox_old_b')
        ) AS deleted_runs,
        (
          SELECT count(*)::int
          FROM sandbox_artifacts
          WHERE sandbox_run_id IN ('srun_sandbox_old_a', 'srun_sandbox_old_b')
        ) AS deleted_artifacts,
        (
          SELECT count(*)::int
          FROM sandbox_policy_decisions
          WHERE sandbox_run_id IN ('srun_sandbox_old_a', 'srun_sandbox_old_b')
        ) AS deleted_policy_decisions,
        (
          SELECT count(*)::int
          FROM sandbox_runs
          WHERE sandbox_run_id = 'srun_sandbox_boundary'
        ) AS retained_boundary_run,
        (
          SELECT count(*)::int
          FROM sandbox_runs
          WHERE sandbox_run_id = 'srun_sandbox_other_repo'
        ) AS retained_other_repo_run
    `;
    expect(counts).toEqual({
      deleted_artifacts: 0,
      deleted_policy_decisions: 0,
      deleted_runs: 0,
      retained_boundary_run: 1,
      retained_other_repo_run: 1,
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
        `${quoteIdentifier(schemaName)}.`,
      ),
    );
  }
}

/** Inserts organization, installation, and repository parents for sandbox tests. */
async function seedSandboxParents(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO orgs (org_id, name, slug)
    VALUES ('org_sandbox_repository_test', 'Sandbox Repository Test Org', 'sandbox-repo-test-org')
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
      'inst_sandbox_repository_test',
      'org_sandbox_repository_test',
      'github',
      'sandbox-repository-test-installation',
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
    VALUES
      (
        'repo_sandbox_repository_test',
        'org_sandbox_repository_test',
        'inst_sandbox_repository_test',
        'github',
        'sandbox-repository-test-repo',
        'acme',
        'heimdall',
        'acme/heimdall',
        'private'
      ),
      (
        'repo_sandbox_repository_other',
        'org_sandbox_repository_test',
        'inst_sandbox_repository_test',
        'github',
        'sandbox-repository-other-repo',
        'acme',
        'other',
        'acme/other',
        'private'
      )
  `;
}

/** Inserts sandbox run, artifact, and policy decision rows for cleanup tests. */
async function seedSandboxRuns(sql: postgres.Sql): Promise<void> {
  const commandJson = JSON.stringify(["bun", "test"]);
  const policyJson = JSON.stringify({ network: "deny" });
  const limitsJson = JSON.stringify({ timeoutMs: 30_000 });

  await sql`
    INSERT INTO sandbox_runs (
      sandbox_run_id,
      org_id,
      repo_id,
      request_id,
      runner_kind,
      trust_level,
      category,
      image,
      command_json,
      policy_json,
      limits_json,
      status,
      created_at,
      updated_at
    )
    VALUES
      (
        'srun_sandbox_old_a',
        'org_sandbox_repository_test',
        'repo_sandbox_repository_test',
        'sandbox-request-old-a',
        'docker',
        'untrusted',
        'static_analysis',
        'node:22',
        ${commandJson}::jsonb,
        ${policyJson}::jsonb,
        ${limitsJson}::jsonb,
        'completed',
        '2026-05-08T00:01:00.000Z',
        '2026-05-08T00:01:30.000Z'
      ),
      (
        'srun_sandbox_old_b',
        'org_sandbox_repository_test',
        'repo_sandbox_repository_test',
        'sandbox-request-old-b',
        'docker',
        'untrusted',
        'static_analysis',
        'node:22',
        ${commandJson}::jsonb,
        ${policyJson}::jsonb,
        ${limitsJson}::jsonb,
        'completed',
        '2026-05-08T00:02:00.000Z',
        '2026-05-08T00:02:30.000Z'
      ),
      (
        'srun_sandbox_boundary',
        'org_sandbox_repository_test',
        'repo_sandbox_repository_test',
        'sandbox-request-boundary',
        'docker',
        'untrusted',
        'static_analysis',
        'node:22',
        ${commandJson}::jsonb,
        ${policyJson}::jsonb,
        ${limitsJson}::jsonb,
        'completed',
        '2026-05-08T00:05:00.000Z',
        '2026-05-08T00:05:30.000Z'
      ),
      (
        'srun_sandbox_other_repo',
        'org_sandbox_repository_test',
        'repo_sandbox_repository_other',
        'sandbox-request-other-repo',
        'docker',
        'untrusted',
        'static_analysis',
        'node:22',
        ${commandJson}::jsonb,
        ${policyJson}::jsonb,
        ${limitsJson}::jsonb,
        'completed',
        '2026-05-08T00:00:30.000Z',
        '2026-05-08T00:01:00.000Z'
      )
  `;
  await sql`
    INSERT INTO sandbox_artifacts (
      sandbox_artifact_id,
      sandbox_run_id,
      name,
      uri,
      sha256,
      size_bytes,
      content_type,
      truncated,
      created_at
    )
    VALUES
      (
        'sart_sandbox_old_a_log',
        'srun_sandbox_old_a',
        'log.json',
        'file:///tmp/sandbox-old-a-log.json',
        ${"a".repeat(64)},
        42,
        'application/json',
        false,
        '2026-05-08T00:01:10.000Z'
      ),
      (
        'sart_sandbox_old_b_report',
        'srun_sandbox_old_b',
        'report.json',
        'file:///tmp/sandbox-old-b-report.json',
        ${"b".repeat(64)},
        84,
        'application/json',
        false,
        '2026-05-08T00:02:10.000Z'
      ),
      (
        'sart_sandbox_old_b_trace',
        'srun_sandbox_old_b',
        'trace.json',
        'file:///tmp/sandbox-old-b-trace.json',
        ${"c".repeat(64)},
        21,
        'application/json',
        false,
        '2026-05-08T00:02:20.000Z'
      )
  `;
  await sql`
    INSERT INTO sandbox_policy_decisions (
      sandbox_policy_decision_id,
      sandbox_run_id,
      status,
      code,
      message,
      details
    )
    VALUES (
      'spol_sandbox_old_a',
      'srun_sandbox_old_a',
      'allowed',
      'sandbox.allowed',
      'Sandbox execution was allowed.',
      '{"source":"integration_test"}'::jsonb
    )
  `;
}

/** Builds a sandbox run insert row for repository tests. */
function sandboxRunInsertFixture(overrides: Partial<SandboxRunInsert> = {}): SandboxRunInsert {
  return {
    category: "static_analysis",
    commandJson: ["bun", "test"],
    createdAt: new Date("2026-05-08T00:10:00.000Z"),
    errorJson: null,
    exitCode: 0,
    finishedAt: new Date("2026-05-08T00:11:00.000Z"),
    image: "node:22",
    imageDigest: null,
    limitsJson: { timeoutMs: 30_000 },
    orgId: "org_sandbox_repository_test",
    policyJson: { network: "deny" },
    repoId: "repo_sandbox_repository_test",
    requestId: "sandbox-request-persisted",
    resourceUsageJson: { durationMs: 1_000 },
    reviewRunId: null,
    runnerKind: "docker",
    sandboxRunId: "srun_sandbox_persisted",
    signal: null,
    startedAt: new Date("2026-05-08T00:10:00.000Z"),
    staticAnalysisRunId: null,
    status: "completed",
    stderrHash: "sha256:initial-stderr",
    stderrTruncated: false,
    stdoutHash: "sha256:initial-stdout",
    stdoutTruncated: false,
    toolRunId: null,
    trustLevel: "untrusted",
    updatedAt: new Date("2026-05-08T00:11:00.000Z"),
    warningsJson: [],
    ...overrides,
  };
}

/** Builds a sandbox artifact insert row for repository tests. */
function sandboxArtifactInsertFixture(
  overrides: Partial<SandboxArtifactInsert> = {},
): SandboxArtifactInsert {
  return {
    contentType: "application/json",
    createdAt: new Date("2026-05-08T00:11:05.000Z"),
    name: "log.json",
    sandboxArtifactId: "sart_sandbox_persisted_log",
    sandboxRunId: "srun_sandbox_persisted",
    sha256: "d".repeat(64),
    sizeBytes: 64,
    truncated: false,
    uri: "file:///tmp/sandbox-persisted-log.json",
    ...overrides,
  };
}

/** Builds a sandbox policy decision insert row for repository tests. */
function sandboxPolicyDecisionInsertFixture(
  overrides: Partial<SandboxPolicyDecisionInsert> = {},
): SandboxPolicyDecisionInsert {
  return {
    code: "sandbox.allowed",
    createdAt: new Date("2026-05-08T00:10:01.000Z"),
    details: { source: "integration_test" },
    message: "Sandbox execution was allowed.",
    sandboxPolicyDecisionId: "spol_sandbox_persisted_allowed",
    sandboxRunId: "srun_sandbox_persisted",
    status: "allowed",
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
