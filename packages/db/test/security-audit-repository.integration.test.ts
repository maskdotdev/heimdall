import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HeimdallDatabase } from "../src/client";
import { SecurityAuditRepository } from "../src/index";

const integrationDatabaseUrl = process.env.HEIMDALL_DB_TEST_URL;
const testDirectory = fileURLToPath(new URL(".", import.meta.url));
const bootstrapPath = resolve(testDirectory, "../bootstrap/0000_extensions.sql");
const migrationsDirectory = resolve(testDirectory, "../migrations");

describe.runIf(integrationDatabaseUrl)("SecurityAuditRepository integration", () => {
  const schemaName = `heimdall_security_audit_repository_test_${process.pid}_${Date.now()}`.replace(
    /[^A-Za-z0-9_]/g,
    "_",
  );
  const sql = postgres(integrationDatabaseUrl ?? "", { max: 1, onnotice: () => undefined });
  const db = drizzle(sql) as HeimdallDatabase;
  const securityAuditRepository = new SecurityAuditRepository(db);

  beforeAll(async () => {
    await sql.unsafe(await readFile(bootstrapPath, "utf8"));
    await sql.unsafe(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await sql.unsafe(`SET search_path TO ${quoteIdentifier(schemaName)}, public`);
    await applyMigrations(sql, schemaName);
  });

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
    await sql.end();
  });

  it("records artifact access, security events, and audit logs", async () => {
    await securityAuditRepository.recordArtifactAccessEvent({
      accessLevel: "redacted_payload",
      actorType: "admin",
      actorUserId: "admin_security_audit",
      artifactAccessEventId: "artaccess_security_audit",
      artifactRef: {
        kind: "retrieval_trace",
        reviewArtifactId: "artifact_security_audit",
      },
      createdAt: new Date("2026-05-08T00:01:00.000Z"),
      ipAddress: "203.0.113.10",
      reason: "Investigating a support ticket.",
      supportSessionId: "support_session_security_audit",
      userAgent: "vitest",
    });
    await securityAuditRepository.recordSecurityEvent({
      actorId: "admin_security_audit",
      createdAt: new Date("2026-05-08T00:02:00.000Z"),
      metadata: { requestId: "request_security_audit" },
      resourceId: "artifact_security_audit",
      resourceType: "review_artifact",
      securityEventId: "sec_security_audit",
      severity: "medium",
      source: "api",
      status: "new",
      type: "review_artifact_payload_read",
    });
    await securityAuditRepository.recordSecurityEvent({
      actorId: "admin_security_audit_duplicate",
      createdAt: new Date("2026-05-08T00:03:00.000Z"),
      metadata: { requestId: "request_security_audit_duplicate" },
      securityEventId: "sec_security_audit",
      severity: "critical",
      source: "api",
      status: "new",
      type: "duplicate_event",
    });
    await expect(
      securityAuditRepository.recordAuditLog({
        action: "review_artifact.payload_read",
        actorType: "admin",
        actorUserId: "admin_security_audit",
        auditLogId: "audit_security_audit",
        metadata: { requestId: "request_security_audit" },
        occurredAt: new Date("2026-05-08T00:04:00.000Z"),
        resourceId: "artifact_security_audit",
        resourceType: "review_artifact",
      }),
    ).resolves.toMatchObject({
      action: "review_artifact.payload_read",
      auditLogId: "audit_security_audit",
      resourceType: "review_artifact",
    });
    await securityAuditRepository.recordAuditLog({
      action: "repo.settings.updated",
      actorType: "admin",
      actorUserId: "admin_security_audit",
      auditLogId: "audit_security_audit_settings",
      metadata: { requestId: "request_security_audit_settings" },
      occurredAt: new Date("2026-05-08T00:05:00.000Z"),
      resourceId: "repo_security_audit",
      resourceType: "repository",
    });
    await securityAuditRepository.recordAuditLog({
      action: "job.replay.dispatch",
      actorType: "admin",
      actorUserId: "admin_security_audit",
      auditLogId: "audit_security_audit_replay",
      metadata: { replayRunId: "replay_security_audit" },
      occurredAt: new Date("2026-05-08T00:06:00.000Z"),
      resourceId: "job_security_audit",
      resourceType: "background_job",
    });
    await securityAuditRepository.recordAuditLog({
      action: "job.cancel",
      actorType: "admin",
      actorUserId: "admin_security_audit",
      auditLogId: "audit_security_audit_cancel",
      metadata: { previousStatus: "queued" },
      occurredAt: new Date("2026-05-08T00:07:00.000Z"),
      resourceId: "job_security_audit",
      resourceType: "background_job",
    });
    await securityAuditRepository.recordSecurityEvent({
      actorId: "admin_security_audit",
      createdAt: new Date("2026-05-08T00:08:00.000Z"),
      metadata: { marker: "security-list-target" },
      resourceId: "repo_security_audit",
      resourceType: "repository",
      securityEventId: "sec_security_audit_settings",
      severity: "high",
      source: "api",
      status: "triaged",
      type: "repo_settings_changed",
    });

    const [counts] = await sql`
      SELECT
        (SELECT count(*)::int FROM artifact_access_events) AS artifact_access_events,
        (SELECT count(*)::int FROM security_events) AS security_events,
        (SELECT count(*)::int FROM audit_logs) AS audit_logs
    `;
    expect(counts).toEqual({
      artifact_access_events: 1,
      audit_logs: 4,
      security_events: 2,
    });

    const [securityEvent] = await sql`
      SELECT actor_id, metadata, severity, type
      FROM security_events
      WHERE security_event_id = 'sec_security_audit'
    `;
    expect(securityEvent).toEqual({
      actor_id: "admin_security_audit",
      metadata: { requestId: "request_security_audit" },
      severity: "medium",
      type: "review_artifact_payload_read",
    });
    await expect(securityAuditRepository.listAuditLogs({ limit: 10 })).resolves.toMatchObject([
      { auditLogId: "audit_security_audit_cancel" },
      { auditLogId: "audit_security_audit_replay" },
      { auditLogId: "audit_security_audit_settings" },
      { auditLogId: "audit_security_audit" },
    ]);
    await expect(
      securityAuditRepository.listAuditLogs({
        action: "review_artifact.payload_read",
        limit: 10,
        search: "request_security_audit",
      }),
    ).resolves.toMatchObject([{ auditLogId: "audit_security_audit" }]);
    await expect(
      securityAuditRepository.listAuditLogsForResourceActions({
        actions: ["job.replay.dispatch", "job.cancel"],
        limit: 10,
        resourceId: "job_security_audit",
        resourceType: "background_job",
      }),
    ).resolves.toMatchObject([
      { action: "job.cancel", auditLogId: "audit_security_audit_cancel" },
      { action: "job.replay.dispatch", auditLogId: "audit_security_audit_replay" },
    ]);
    await expect(securityAuditRepository.listSecurityEvents({ limit: 10 })).resolves.toMatchObject([
      { securityEventId: "sec_security_audit_settings" },
      { securityEventId: "sec_security_audit" },
    ]);
    await expect(
      securityAuditRepository.listSecurityEvents({
        limit: 10,
        search: "security-list-target",
        severity: "high",
      }),
    ).resolves.toMatchObject([{ securityEventId: "sec_security_audit_settings" }]);
    await expect(securityAuditRepository.listAuditLogs({ limit: 0 })).rejects.toThrow(
      /limit must be an integer/u,
    );
    await expect(securityAuditRepository.listSecurityEvents({ limit: 101 })).rejects.toThrow(
      /limit must be an integer/u,
    );
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
