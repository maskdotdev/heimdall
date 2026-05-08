import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/** Default staging proof evidence path used by the production-readiness gate. */
const DEFAULT_EVIDENCE_FILE = "docs/evidence/admin-control-plane-staging-proof.json";

/** Default admin control-plane runbook path used by the production-readiness gate. */
const DEFAULT_RUNBOOK_FILE = "docs/runbooks/admin-control-plane.md";

/** Staging proof commands required before production rollout. */
const REQUIRED_COMMANDS = ["preflight", "smoke", "dashboard-e2e"] as const;

/** Manual drill steps required before production rollout. */
const REQUIRED_MANUAL_DRILL_STEPS = [
  "inspect",
  "plan_replay",
  "execute_replay",
  "update_settings",
  "verify_audit_log",
] as const;

/** Runbook sections required for production-readiness handoff. */
const REQUIRED_RUNBOOK_SECTIONS = [
  "## Production Deployment Decision",
  "## Production Rollout Plan",
  "### Acceptance Gates",
  "### Go/No-Go Criteria",
  "## Gateway Hardening Checklist",
  "## Secret Rotation Procedure",
  "## Monitoring and Rollback Checks",
  "### Post-Release Monitoring and Follow-Up Tracking",
  "### Emergency Disable Path",
  "### Rollback Checks",
] as const;

/** Audit actions that production monitoring must search for after replay dispatch. */
const REQUIRED_REPLAY_AUDIT_ACTIONS = [
  "webhook.requeue_jobs",
  "review.requeue",
  "publish.review",
] as const;

/** Stale replay action labels that do not match persisted audit rows. */
const STALE_REPLAY_AUDIT_ACTIONS = ["webhook.replay", "review.replay"] as const;

/** JSON object shape used by proof artifacts. */
type JsonRecord = Readonly<Record<string, unknown>>;

/** One production-readiness gate included in the summary report. */
type ProductionReadinessGate = {
  /** Human-readable gate detail. */
  readonly detail: string;
  /** Machine-readable gate name. */
  readonly name: string;
};

/** Inputs used to validate admin control-plane production readiness. */
export type ProductionReadinessInput = {
  /** Parsed staging proof evidence. */
  readonly evidence: JsonRecord;
  /** Evidence file path used in report output. */
  readonly evidenceFile: string;
  /** Admin control-plane runbook contents. */
  readonly runbookText: string;
  /** Runbook file path used in report output. */
  readonly runbookFile: string;
};

/** Production-readiness report emitted by the gate. */
export type ProductionReadinessReport = {
  /** Actor summarized from staging proof evidence. */
  readonly actor: {
    /** Identity provider that authenticated the proof actor. */
    readonly provider: string;
    /** Provider-backed subject stored by the API. */
    readonly subject: string;
  };
  /** Staging proof evidence path. */
  readonly evidenceFile: string;
  /** ISO timestamp when the staging proof evidence was generated. */
  readonly evidenceGeneratedAt: string;
  /** Successful production-readiness gates. */
  readonly gates: readonly ProductionReadinessGate[];
  /** Staging gateway URL covered by the proof. */
  readonly gatewayUrl: string;
  /** Admin control-plane runbook path. */
  readonly runbookFile: string;
  /** Organization and repository scope covered by the proof. */
  readonly scope: {
    /** Organization scope IDs covered by the proof. */
    readonly orgIds: readonly string[];
    /** Repository scope IDs covered by the proof. */
    readonly repoIds: readonly string[];
  };
  /** Overall gate status. */
  readonly status: "admin control-plane production readiness passed";
};

/** Runs the production-readiness gate from local files. */
async function main(): Promise<void> {
  const evidenceFile = resolve(
    process.env.HEIMDALL_CONTROL_PLANE_EVIDENCE_FILE ?? DEFAULT_EVIDENCE_FILE,
  );
  const runbookFile = resolve(
    process.env.HEIMDALL_CONTROL_PLANE_RUNBOOK_FILE ?? DEFAULT_RUNBOOK_FILE,
  );
  const report = buildProductionReadinessReport({
    evidence: parseJsonRecord(await readFile(evidenceFile, "utf8"), evidenceFile),
    evidenceFile,
    runbookFile,
    runbookText: await readFile(runbookFile, "utf8"),
  });

  console.log(JSON.stringify(report, null, 2));
}

/** Builds and validates the admin control-plane production-readiness report. */
export function buildProductionReadinessReport(
  input: ProductionReadinessInput,
): ProductionReadinessReport {
  const issues = productionReadinessIssues(input);
  if (issues.length > 0) {
    throw new Error(`Admin control-plane production readiness failed: ${issues.join("; ")}.`);
  }

  const actor = recordField(input.evidence, "actor");
  const scope = recordField(input.evidence, "scope");
  return {
    actor: {
      provider: requiredString(actor, "provider"),
      subject: requiredString(actor, "subject"),
    },
    evidenceFile: input.evidenceFile,
    evidenceGeneratedAt: requiredString(input.evidence, "generatedAt"),
    gates: [
      {
        detail:
          "staging proof evidence passed and includes command, actor, scope, audit, and rollback data",
        name: "staging proof evidence",
      },
      {
        detail:
          "runbook includes rollout, hardening, rotation, monitoring, follow-up tracking, rollback, and disable procedures",
        name: "production runbook coverage",
      },
      {
        detail: "runbook monitoring checks use the persisted replay audit action names",
        name: "replay audit action names",
      },
    ],
    gatewayUrl: requiredString(input.evidence, "gatewayUrl"),
    runbookFile: input.runbookFile,
    scope: {
      orgIds: requiredStringArray(scope, "orgIds"),
      repoIds: requiredStringArray(scope, "repoIds"),
    },
    status: "admin control-plane production readiness passed",
  };
}

/** Returns production-readiness issues found in evidence and runbook text. */
function productionReadinessIssues(input: ProductionReadinessInput): readonly string[] {
  return [
    ...stagingProofEvidenceIssues(input.evidence),
    ...runbookCoverageIssues(input.runbookText),
  ];
}

/** Returns issues in the staging proof evidence. */
function stagingProofEvidenceIssues(evidence: JsonRecord): readonly string[] {
  const actor = recordField(evidence, "actor");
  const scope = recordField(evidence, "scope");
  const auditLogIds = recordField(evidence, "auditLogIds");
  const dashboardAudit = recordField(auditLogIds, "dashboard");
  const manualAudit = recordField(auditLogIds, "manualDrill");
  const smokeAudit = recordField(auditLogIds, "smoke");
  const manualDrill = recordField(evidence, "manualDrill");
  const commands = arrayField(evidence, "commands").filter(isRecord);
  const commandNames = commands
    .map((command) => stringField(command, "name"))
    .filter((name): name is string => typeof name === "string");
  return [
    stringField(evidence, "status") !== "control-plane staging proof passed"
      ? "staging proof status must be passed"
      : undefined,
    !isIsoTimestamp(stringField(evidence, "generatedAt"))
      ? "staging proof generatedAt must be an ISO timestamp"
      : undefined,
    !isHttpsUrl(stringField(evidence, "gatewayUrl"))
      ? "staging proof gatewayUrl must be https"
      : undefined,
    stringField(actor, "provider") !== "github_org"
      ? "staging proof actor provider must be github_org"
      : undefined,
    !stringField(actor, "subject") ? "staging proof actor subject is required" : undefined,
    requiredStringArrayIssue(scope, "orgIds", "staging proof org scope is required"),
    requiredStringArrayIssue(scope, "repoIds", "staging proof repo scope is required"),
    ...REQUIRED_COMMANDS.filter((name) => !commandNames.includes(name)).map(
      (name) => `staging proof command ${name} is required`,
    ),
    ...commands
      .filter((command) => numberField(command, "exitCode") !== 0)
      .map(
        (command) => `staging proof command ${stringField(command, "name") ?? "unknown"} failed`,
      ),
    ...requiredAuditIds(dashboardAudit, "dashboard", ["login", "logout", "replay", "settings"]),
    ...requiredAuditIds(manualAudit, "manual drill", ["login", "logout", "replay", "settings"]),
    ...requiredAuditIds(smokeAudit, "smoke", ["login", "logout"]),
    ...REQUIRED_MANUAL_DRILL_STEPS.filter(
      (step) => !requiredStringArray(manualDrill, "steps").includes(step),
    ).map((step) => `manual drill step ${step} is required`),
    !stringField(evidence, "rollbackNotes") ? "rollback notes are required" : undefined,
  ].filter((issue): issue is string => typeof issue === "string");
}

/** Returns issues in the production runbook coverage. */
function runbookCoverageIssues(runbookText: string): readonly string[] {
  return [
    ...REQUIRED_RUNBOOK_SECTIONS.filter((section) => !runbookText.includes(section)).map(
      (section) => `runbook must include ${section}`,
    ),
    ...REQUIRED_REPLAY_AUDIT_ACTIONS.filter((action) => !runbookText.includes(action)).map(
      (action) => `runbook must include replay audit action ${action}`,
    ),
    ...STALE_REPLAY_AUDIT_ACTIONS.filter((action) => runbookText.includes(action)).map(
      (action) => `runbook must not use stale replay audit action ${action}`,
    ),
  ];
}

/** Parses JSON text as an object record. */
function parseJsonRecord(text: string, label: string): JsonRecord {
  const parsed = JSON.parse(text) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`${label} must contain a JSON object.`);
  }

  return parsed;
}

/** Returns required audit log ID issues for one audit group. */
function requiredAuditIds(
  record: JsonRecord,
  label: string,
  fields: readonly string[],
): readonly string[] {
  return fields
    .filter((field) => !stringField(record, field))
    .map((field) => `${label} audit log ID ${field} is required`);
}

/** Returns an issue when a required string array field is absent or empty. */
function requiredStringArrayIssue(
  record: JsonRecord,
  field: string,
  message: string,
): string | undefined {
  return requiredStringArray(record, field).length > 0 ? undefined : message;
}

/** Returns a required string from one record. */
function requiredString(record: JsonRecord, field: string): string {
  const value = stringField(record, field);
  if (!value) {
    throw new Error(`${field} is required.`);
  }

  return value;
}

/** Returns a required string array from one record. */
function requiredStringArray(record: JsonRecord, field: string): readonly string[] {
  const value = arrayField(record, field);
  return value.every((entry) => typeof entry === "string") ? (value as readonly string[]) : [];
}

/** Returns an optional string from one record. */
function stringField(record: JsonRecord, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Returns an optional number from one record. */
function numberField(record: JsonRecord, field: string): number | undefined {
  const value = record[field];
  return typeof value === "number" ? value : undefined;
}

/** Returns a nested object record from one record. */
function recordField(record: JsonRecord, field: string): JsonRecord {
  const value = record[field];
  return isRecord(value) ? value : {};
}

/** Returns an array field from one record. */
function arrayField(record: JsonRecord, field: string): readonly unknown[] {
  const value = record[field];
  return Array.isArray(value) ? value : [];
}

/** Returns whether a value is a JSON object record. */
function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Returns whether a value is an ISO timestamp string. */
function isIsoTimestamp(value: string | undefined): boolean {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/** Returns whether a value is an HTTPS URL. */
function isHttpsUrl(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

if (import.meta.main) {
  await main();
}
