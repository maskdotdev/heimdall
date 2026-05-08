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
    await sql`
      INSERT INTO users (user_id, primary_email, display_name)
      VALUES ('user_compliance_owner', 'compliance-owner@example.test', 'Compliance Owner')
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

  it("lists scoped source rows for evidence collectors", async () => {
    await sql`
      INSERT INTO org_memberships (org_id, user_id, role, metadata)
      VALUES (
        'org_compliance_evidence',
        'user_compliance_owner',
        'owner',
        '{"privateNote":"not exported"}'::jsonb
      )
    `;
    await sql`
      INSERT INTO audit_logs (
        audit_log_id,
        org_id,
        actor_type,
        actor_user_id,
        action,
        resource_type,
        resource_id,
        occurred_at,
        metadata
      )
      VALUES (
        'audit_compliance_source',
        'org_compliance_evidence',
        'admin',
        'user_compliance_owner',
        'repo.settings.updated',
        'repository',
        'repo_compliance_source',
        '2026-05-08T15:00:00.000Z',
        '{"ticket":"SEC-1"}'::jsonb
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
        'inst_compliance_source',
        'org_compliance_evidence',
        'github',
        '9001',
        'compliance-org',
        'Organization',
        '2026-05-08T15:00:00.000Z'
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
        default_branch,
        visibility
      )
      VALUES (
        'repo_compliance_source',
        'org_compliance_evidence',
        'inst_compliance_source',
        'github',
        '1239001',
        'compliance-org',
        'source',
        'compliance-org/source',
        'main',
        'private'
      )
    `;
    await sql`
      INSERT INTO repository_settings (
        repo_id,
        review_policy,
        severity_threshold,
        max_comments_per_review,
        ignored_paths,
        ignored_authors,
        ignored_labels,
        require_label,
        custom_instructions,
        sandbox_policy
      )
      VALUES (
        'repo_compliance_source',
        'balanced',
        'medium',
        5,
        '["vendor/**"]'::jsonb,
        '["dependabot"]'::jsonb,
        '["wip"]'::jsonb,
        'review-me',
        'Do not export raw instructions.',
        '{"network":"none"}'::jsonb
      )
    `;
    await sql`
      INSERT INTO org_settings (
        org_id,
        settings_json,
        version,
        updated_by_user_id
      )
      VALUES (
        'org_compliance_evidence',
        '{"defaultReviewPolicy":"balanced"}'::jsonb,
        2,
        'user_compliance_owner'
      )
    `;
    await sql`
      INSERT INTO security_events (
        security_event_id,
        org_id,
        repo_id,
        type,
        severity,
        source,
        status,
        actor_id,
        resource_type,
        resource_id,
        metadata
      )
      VALUES (
        'secevt_compliance_source',
        'org_compliance_evidence',
        'repo_compliance_source',
        'provider_permission_denied',
        'high',
        'github',
        'open',
        'user_compliance_owner',
        'repository',
        'repo_compliance_source',
        '{"metadataKey":"metadataValue"}'::jsonb
      )
    `;

    await expect(
      repository.listAccessReviewEvidenceRows({
        limit: 10,
        orgId: "org_compliance_evidence",
      }),
    ).resolves.toMatchObject([
      {
        orgId: "org_compliance_evidence",
        role: "owner",
        userId: "user_compliance_owner",
      },
    ]);
    await expect(
      repository.listAuditLogEvidenceRows({
        limit: 10,
        orgId: "org_compliance_evidence",
      }),
    ).resolves.toMatchObject([
      {
        action: "repo.settings.updated",
        auditLogId: "audit_compliance_source",
      },
    ]);
    await expect(
      repository.listSecurityEventEvidenceRows({
        limit: 10,
        orgId: "org_compliance_evidence",
      }),
    ).resolves.toMatchObject([
      {
        securityEventId: "secevt_compliance_source",
        type: "provider_permission_denied",
      },
    ]);

    const configRows = await repository.listConfigSnapshotEvidenceRows({
      limit: 10,
      orgId: "org_compliance_evidence",
    });
    expect(configRows.orgSettingsRows).toMatchObject([
      {
        orgId: "org_compliance_evidence",
        version: 2,
      },
    ]);
    expect(configRows.repositoryRows).toMatchObject([
      {
        repoId: "repo_compliance_source",
      },
    ]);
    expect(configRows.repositorySettingsRows).toMatchObject([
      {
        repoId: "repo_compliance_source",
        reviewPolicy: "balanced",
      },
    ]);
    await expect(repository.listAccessReviewEvidenceRows({ limit: 1_001 })).rejects.toThrow(
      /source row limit must be an integer/u,
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
