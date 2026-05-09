import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HeimdallDatabase } from "../src/client";
import { AdminDebugRepository } from "../src/index";

const integrationDatabaseUrl = process.env.HEIMDALL_DB_TEST_URL;
const testDirectory = fileURLToPath(new URL(".", import.meta.url));
const bootstrapPath = resolve(testDirectory, "../bootstrap/0000_extensions.sql");
const migrationsDirectory = resolve(testDirectory, "../migrations");

describe.runIf(integrationDatabaseUrl)("AdminDebugRepository integration", () => {
  const schemaName = `heimdall_admin_debug_repository_test_${process.pid}_${Date.now()}`.replace(
    /[^A-Za-z0-9_]/g,
    "_",
  );
  const sql = postgres(integrationDatabaseUrl ?? "", { max: 1, onnotice: () => undefined });
  const db = drizzle(sql) as HeimdallDatabase;
  const adminDebugRepository = new AdminDebugRepository(db);

  beforeAll(async () => {
    await sql.unsafe(await readFile(bootstrapPath, "utf8"));
    await sql.unsafe(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await sql.unsafe(`SET search_path TO ${quoteIdentifier(schemaName)}, public`);
    await applyMigrations(sql, schemaName);
    await sql`
      INSERT INTO orgs (org_id, name, slug)
      VALUES ('org_admin_debug_repository_test', 'Admin Debug Repository Test Org', 'admin-debug-repository-test-org')
    `;
  });

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
    await sql.end();
  });

  it("records admin actions, debug exports, replay runs, and replay stages", async () => {
    const completedAt = new Date("2026-05-08T00:10:00.000Z");

    await adminDebugRepository.recordAdminAction({
      adminActionId: "admact_admin_debug_repository_test",
      actorType: "admin_user",
      actorUserId: "admin_debug_repository_operator",
      completedAt,
      kind: "debug_bundle.export",
      orgId: "org_admin_debug_repository_test",
      reason: "Export a redacted support bundle.",
      request: {
        redactionLevel: "metadata",
        reviewRunId: "rrn_admin_debug_repository_test",
      },
      result: {
        debugExportId: "dbgexp_admin_debug_repository_test",
        payloadHash: `sha256:${"a".repeat(64)}`,
      },
      startedAt: completedAt,
      status: "completed",
      supportSessionId: "support_admin_debug_repository_test",
    });
    await adminDebugRepository.recordDebugExport({
      adminActionId: "admact_admin_debug_repository_test",
      artifactHash: `sha256:${"a".repeat(64)}`,
      completedAt,
      createdByActorType: "admin_user",
      createdByActorUserId: "admin_debug_repository_operator",
      debugExportId: "dbgexp_admin_debug_repository_test",
      expiresAt: new Date("2026-05-09T00:10:00.000Z"),
      exportKind: "review_run_debug_bundle",
      orgId: "org_admin_debug_repository_test",
      redactionLevel: "metadata",
      status: "completed",
    });
    await adminDebugRepository.recordReplayRun({
      replayRunId: "rply_admin_debug_repository_test",
      adminActionId: "admact_admin_debug_repository_test",
      completedAt,
      createdByActorType: "admin_user",
      createdByActorUserId: "admin_debug_repository_operator",
      mode: "operator_dispatch",
      orgId: "org_admin_debug_repository_test",
      reason: "Replay an operator-selected job.",
      result: {
        replayJobIds: ["job_admin_debug_repository_test"],
      },
      stages: [
        {
          jobType: "review.pull_request.v1",
          queueName: "review",
          replayJobKey: "replay:admin-debug-repository-test",
          source: "background_job",
          stage: "review",
        },
      ],
      startedAt: completedAt,
      status: "completed",
      supportSessionId: "support_admin_debug_repository_test",
    });
    await adminDebugRepository.recordReplayStageRuns([
      {
        replayStageRunId: "rplystg_admin_debug_repository_test",
        replayRunId: "rply_admin_debug_repository_test",
        completedAt,
        inputArtifactRef: {
          replayJobKey: "replay:admin-debug-repository-test",
        },
        metrics: {
          replayJobCount: 1,
        },
        outputArtifactRef: {
          replayJobKey: "replay:admin-debug-repository-test",
        },
        stage: "review",
        startedAt: completedAt,
        status: "completed",
      },
    ]);

    const [counts] = await sql`
      SELECT
        (SELECT count(*)::int FROM admin_actions) AS admin_actions,
        (SELECT count(*)::int FROM debug_exports) AS debug_exports,
        (SELECT count(*)::int FROM replay_runs) AS replay_runs,
        (SELECT count(*)::int FROM replay_stage_runs) AS replay_stage_runs
    `;
    expect(counts).toEqual({
      admin_actions: 1,
      debug_exports: 1,
      replay_runs: 1,
      replay_stage_runs: 1,
    });

    const [replayRun] = await sql`
      SELECT mode, result, stages, support_session_id
      FROM replay_runs
      WHERE replay_run_id = 'rply_admin_debug_repository_test'
    `;
    expect(replayRun).toEqual({
      mode: "operator_dispatch",
      result: {
        replayJobIds: ["job_admin_debug_repository_test"],
      },
      stages: [
        {
          jobType: "review.pull_request.v1",
          queueName: "review",
          replayJobKey: "replay:admin-debug-repository-test",
          source: "background_job",
          stage: "review",
        },
      ],
      support_session_id: "support_admin_debug_repository_test",
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

/** Quotes a trusted Postgres identifier after validating its shape. */
function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(identifier)) {
    throw new Error(`Unsafe Postgres identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}
