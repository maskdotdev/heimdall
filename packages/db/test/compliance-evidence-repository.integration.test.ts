import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HeimdallDatabase } from "../src/client";
import { ComplianceEvidenceRepository } from "../src/index";

const integrationDatabaseUrl = process.env.HEIMDALL_DB_TEST_URL;
const testDirectory = fileURLToPath(new URL(".", import.meta.url));
const bootstrapPath = resolve(testDirectory, "../bootstrap/0000_extensions.sql");
const migrationsDirectory = resolve(testDirectory, "../migrations");

describe.runIf(integrationDatabaseUrl)("ComplianceEvidenceRepository integration", () => {
  const schemaName =
    `heimdall_compliance_evidence_repository_test_${process.pid}_${Date.now()}`.replace(
      /[^A-Za-z0-9_]/g,
      "_",
    );
  const sql = postgres(integrationDatabaseUrl ?? "", { max: 1, onnotice: () => undefined });
  const db = drizzle(sql) as HeimdallDatabase;
  const repository = new ComplianceEvidenceRepository(db);

  beforeAll(async () => {
    await sql.unsafe(await readFile(bootstrapPath, "utf8"));
    await sql.unsafe(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await sql.unsafe(`SET search_path TO ${quoteIdentifier(schemaName)}, public`);
    await applyMigrations(sql, schemaName);
    await sql`
      INSERT INTO orgs (org_id, name, slug)
      VALUES ('org_compliance_evidence', 'Compliance Evidence Org', 'compliance-evidence-org')
    `;
  });

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
    await sql.end();
  });

  it("records and lists scoped compliance evidence rows", async () => {
    await expect(
      repository.recordComplianceEvidence({
        collectedAt: new Date("2026-05-08T14:00:00.000Z"),
        collectedBy: "ci:compliance",
        complianceEvidenceId: "cmpev_audit_export",
        controlId: "soc2.cc7.2.audit_logging",
        evidenceHash: "sha256:audit",
        evidenceType: "audit_log_export",
        evidenceUri: "s3://heimdall-evidence/org_compliance_evidence/audit-log-export.jsonl",
        metadata: { requestId: "request_compliance_evidence" },
        orgId: "org_compliance_evidence",
        source: "ci",
        summary: { rowCount: 2 },
      }),
    ).resolves.toMatchObject({
      complianceEvidenceId: "cmpev_audit_export",
      controlId: "soc2.cc7.2.audit_logging",
      evidenceType: "audit_log_export",
      orgId: "org_compliance_evidence",
      status: "collected",
    });

    await repository.recordComplianceEvidence({
      collectedAt: new Date("2026-05-08T14:05:00.000Z"),
      collectedBy: "admin_tool:config",
      complianceEvidenceId: "cmpev_config_snapshot",
      controlId: "soc2.cc8.1.change_management",
      evidenceType: "config_snapshot",
      evidenceUri: "s3://heimdall-evidence/org_compliance_evidence/config-snapshot.json",
      orgId: "org_compliance_evidence",
      source: "admin_tool",
      status: "superseded",
      summary: { configCount: 4 },
    });

    const [counts] = await sql`
      SELECT count(*)::int AS compliance_evidence
      FROM compliance_evidence
    `;
    expect(counts).toEqual({ compliance_evidence: 2 });

    await expect(
      repository.listComplianceEvidence({
        limit: 10,
        orgId: "org_compliance_evidence",
      }),
    ).resolves.toMatchObject([
      { complianceEvidenceId: "cmpev_config_snapshot" },
      { complianceEvidenceId: "cmpev_audit_export" },
    ]);
    await expect(
      repository.listComplianceEvidence({
        controlId: "soc2.cc7.2.audit_logging",
        limit: 10,
        search: "request_compliance_evidence",
      }),
    ).resolves.toMatchObject([{ complianceEvidenceId: "cmpev_audit_export" }]);
    await expect(repository.listComplianceEvidence({ limit: 101 })).rejects.toThrow(
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
