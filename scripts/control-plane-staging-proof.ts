import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/** Default file path for the staging control-plane proof evidence record. */
const DEFAULT_EVIDENCE_FILE = "docs/evidence/admin-control-plane-staging-proof.json";

/** Manual dashboard drill steps required before recording the staging proof. */
const REQUIRED_MANUAL_DRILL_STEPS = [
  "inspect",
  "plan_replay",
  "execute_replay",
  "update_settings",
  "verify_audit_log",
] as const;

/** Commands that make up the staging control-plane proof. */
const PROOF_COMMANDS = [
  {
    args: ["run", "scripts/control-plane-staging-preflight.ts"],
    name: "preflight",
  },
  {
    args: ["run", "scripts/control-plane-staging-smoke.ts"],
    name: "smoke",
  },
  {
    args: ["run", "scripts/control-plane-dashboard-e2e.ts"],
    name: "dashboard-e2e",
  },
] as const;

/** Names of commands that make up the staging proof. */
type ProofCommandName = (typeof PROOF_COMMANDS)[number]["name"];

/** JSON object emitted by one proof command. */
type JsonRecord = Readonly<Record<string, unknown>>;

/** Runtime inputs for proof evidence recording. */
type ProofEnvironment = {
  /** Absolute path where the proof record should be written. */
  readonly evidenceFile: string;
  /** Human-recorded manual dashboard drill evidence. */
  readonly manualDrill: ManualDrillEvidence;
  /** Human-authored rollback notes to store with the proof. */
  readonly rollbackNotes: string;
};

/** Audit log IDs observed during the manual dashboard drill. */
type ManualDrillAuditLogIds = {
  /** Manual drill login audit log ID. */
  readonly login: string;
  /** Manual drill logout audit log ID. */
  readonly logout: string;
  /** Manual drill replay audit log ID. */
  readonly replay: string;
  /** Manual drill settings audit log ID. */
  readonly settings: string;
};

/** Human-recorded evidence for the required manual dashboard drill. */
type ManualDrillEvidence = {
  /** API actor ID used for the manual drill. */
  readonly actor: string;
  /** Audit log IDs observed during the manual drill. */
  readonly auditLogIds: ManualDrillAuditLogIds;
  /** ISO timestamp when the manual drill was completed. */
  readonly completedAt: string;
  /** Human-readable notes about the manual drill. */
  readonly notes: string;
  /** Manual drill steps completed by the operator. */
  readonly steps: readonly string[];
};

/** Actor evidence summarized at the top level of the proof record. */
type ProofActorEvidence = {
  /** Identity provider that authenticated the actor. */
  readonly provider: string;
  /** Provider-backed actor subject stored by the API. */
  readonly subject: string;
};

/** Audit log evidence summarized at the top level of the proof record. */
type ProofAuditLogEvidence = {
  /** Dashboard E2E audit log IDs. */
  readonly dashboard: ManualDrillAuditLogIds;
  /** Manually observed dashboard drill audit log IDs. */
  readonly manualDrill: ManualDrillAuditLogIds;
  /** API smoke audit log IDs. */
  readonly smoke: {
    /** Smoke login audit log ID. */
    readonly login: string;
    /** Smoke logout audit log ID. */
    readonly logout: string;
  };
};

/** Organization and repository scope evidence summarized by the proof record. */
type ProofScopeEvidence = {
  /** Organization IDs granted to the proof actor. */
  readonly orgIds: readonly string[];
  /** Repository IDs granted to the proof actor. */
  readonly repoIds: readonly string[];
};

/** Captured result for one proof command. */
type ProofCommandResult = {
  /** Command arguments passed to Bun. */
  readonly args: readonly string[];
  /** Elapsed command runtime in milliseconds. */
  readonly durationMs: number;
  /** Process exit code. */
  readonly exitCode: number;
  /** Logical command name. */
  readonly name: ProofCommandName;
  /** Standard error emitted by the command. */
  readonly stderr: string;
  /** Standard output emitted by the command. */
  readonly stdout: string;
};

/** Evidence retained for one successful proof command. */
type ProofCommandEvidence = {
  /** Command line that produced the evidence. */
  readonly command: string;
  /** Elapsed command runtime in milliseconds. */
  readonly durationMs: number;
  /** Process exit code. */
  readonly exitCode: number;
  /** Logical command name. */
  readonly name: ProofCommandName;
  /** Parsed JSON output from the command. */
  readonly output: JsonRecord;
};

/** Combined staging proof evidence record. */
type StagingProofRecord = {
  /** Provider actor summarized from the proof commands. */
  readonly actor: ProofActorEvidence;
  /** Audit log IDs summarized from automated and manual proof steps. */
  readonly auditLogIds: ProofAuditLogEvidence;
  /** Successful command evidence in execution order. */
  readonly commands: readonly ProofCommandEvidence[];
  /** Dashboard E2E JSON evidence. */
  readonly dashboard: JsonRecord;
  /** ISO timestamp when the proof record was generated. */
  readonly generatedAt: string;
  /** Staging gateway origin used by the proof. */
  readonly gatewayUrl: string;
  /** Human-recorded manual dashboard drill evidence. */
  readonly manualDrill: ManualDrillEvidence;
  /** Operator-authored rollback notes. */
  readonly rollbackNotes: string;
  /** Organization and repository scope summarized from the proof commands. */
  readonly scope: ProofScopeEvidence;
  /** Staging smoke JSON evidence. */
  readonly smoke: JsonRecord;
  /** Overall proof status. */
  readonly status: "control-plane staging proof passed";
  /** Staging preflight JSON evidence. */
  readonly preflight: JsonRecord;
};

/** Runs all staging proof commands and writes one evidence record. */
export async function main(): Promise<void> {
  const env = readEnvironment();
  const commandEvidence: ProofCommandEvidence[] = [];

  for (const command of PROOF_COMMANDS) {
    console.error(`running ${command.name}: bun ${command.args.join(" ")}`);
    const result = await runProofCommand(command);
    if (result.exitCode !== 0) {
      throw new Error(failedCommandMessage(result));
    }

    commandEvidence.push({
      command: `bun ${command.args.join(" ")}`,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      name: command.name,
      output: parseCommandJson(result),
    });
  }

  const proofRecord = buildProofRecord(env, commandEvidence);
  validateProofRecord(proofRecord);
  await writeProofRecord(env.evidenceFile, proofRecord);

  console.log(
    JSON.stringify(
      {
        actor: proofRecord.actor,
        auditLogIds: proofRecord.auditLogIds,
        evidenceFile: env.evidenceFile,
        gatewayUrl: proofRecord.gatewayUrl,
        scope: proofRecord.scope,
        status: proofRecord.status,
      },
      null,
      2,
    ),
  );
}

/** Reads proof runner environment variables. */
function readEnvironment(): ProofEnvironment {
  const rollbackNotes = process.env.HEIMDALL_CONTROL_PLANE_ROLLBACK_NOTES?.trim();
  if (!rollbackNotes) {
    throw new Error("HEIMDALL_CONTROL_PLANE_ROLLBACK_NOTES is required for evidence recording.");
  }

  return {
    evidenceFile: resolve(
      process.env.HEIMDALL_CONTROL_PLANE_EVIDENCE_FILE ?? DEFAULT_EVIDENCE_FILE,
    ),
    manualDrill: parseManualDrillEvidence(process.env.HEIMDALL_CONTROL_PLANE_MANUAL_DRILL_EVIDENCE),
    rollbackNotes,
  };
}

/** Runs one Bun proof command and captures its output. */
function runProofCommand(command: (typeof PROOF_COMMANDS)[number]): Promise<ProofCommandResult> {
  const startedAt = performance.now();
  const child = spawn("bun", command.args, {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: string[] = [];
  const stderr: string[] = [];

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => stdout.push(chunk));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => stderr.push(chunk));

  return new Promise((resolvePromise, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      resolvePromise({
        args: command.args,
        durationMs: Math.round(performance.now() - startedAt),
        exitCode: code ?? 1,
        name: command.name,
        stderr: stderr.join(""),
        stdout: stdout.join(""),
      });
    });
  });
}

/** Builds the combined proof record from command evidence. */
export function buildProofRecord(
  env: ProofEnvironment,
  commands: readonly ProofCommandEvidence[],
): StagingProofRecord {
  const preflight = commandOutput(commands, "preflight");
  const smoke = commandOutput(commands, "smoke");
  const dashboard = commandOutput(commands, "dashboard-e2e");
  return {
    actor: buildProofActor(dashboard),
    auditLogIds: buildProofAuditLogIds(smoke, dashboard, env.manualDrill),
    commands,
    dashboard,
    gatewayUrl: requiredString(smoke, "gatewayUrl"),
    generatedAt: new Date().toISOString(),
    manualDrill: env.manualDrill,
    preflight,
    rollbackNotes: env.rollbackNotes,
    scope: buildProofScope(dashboard),
    smoke,
    status: "control-plane staging proof passed",
  };
}

/** Writes a proof record to disk. */
async function writeProofRecord(path: string, record: StagingProofRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

/** Parses JSON output from one successful command. */
function parseCommandJson(result: ProofCommandResult): JsonRecord {
  const trimmed = result.stdout.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error(`${result.name} did not emit a JSON evidence object.`);
  }

  const parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`${result.name} emitted non-object JSON evidence.`);
  }

  return parsed;
}

/** Validates that the combined proof covers the required evidence fields. */
export function validateProofRecord(record: StagingProofRecord): void {
  const smokeAudit = recordField(record.smoke, "auditLogIds");
  const dashboardAudit = recordField(record.dashboard, "auditLogIds");
  const dashboardActor = stringField(record.dashboard, "actor");
  const dashboardOrgIds = stringArrayField(record.dashboard, "orgIds");
  const dashboardRepoIds = stringArrayField(record.dashboard, "repoIds");
  const preflightOrgId = stringField(record.preflight, "orgId");
  const preflightRepoId = stringField(record.preflight, "repoId");
  const smokeOrgId = stringField(record.smoke, "orgId");
  const smokeRepoId = stringField(record.smoke, "repoId");
  const issues = [
    requiredFieldIssue(record.preflight, "gatewayUrl", "preflight gateway URL"),
    requiredFieldIssue(record.preflight, "apiUrl", "preflight API URL"),
    requiredFieldIssue(record.preflight, "webUrl", "preflight dashboard URL"),
    requiredFieldIssue(record.smoke, "gatewayUrl", "smoke gateway URL"),
    requiredFieldIssue(record.smoke, "actor", "smoke actor"),
    requiredFieldIssue(record.smoke, "orgId", "smoke org scope"),
    requiredFieldIssue(record.smoke, "repoId", "smoke repo scope"),
    requiredFieldIssue(record.dashboard, "gatewayUrl", "dashboard gateway URL"),
    requiredFieldIssue(record.dashboard, "actor", "dashboard actor"),
    requiredFieldIssue(record.dashboard, "provider", "dashboard provider"),
    requiredArrayIssue(record.dashboard, "orgIds", "dashboard org scopes"),
    requiredArrayIssue(record.dashboard, "repoIds", "dashboard repo scopes"),
    requiredFieldIssue(smokeAudit, "login", "smoke login audit log ID"),
    requiredFieldIssue(smokeAudit, "logout", "smoke logout audit log ID"),
    requiredFieldIssue(dashboardAudit, "login", "dashboard login audit log ID"),
    requiredFieldIssue(dashboardAudit, "logout", "dashboard logout audit log ID"),
    requiredFieldIssue(dashboardAudit, "replay", "dashboard replay audit log ID"),
    requiredFieldIssue(dashboardAudit, "settings", "dashboard settings audit log ID"),
    record.actor.provider !== "github_org" ? "proof actor provider must be github_org" : undefined,
    equalityIssue(
      "proof gateway URL",
      record.gatewayUrl,
      "preflight gateway URL",
      stringField(record.preflight, "gatewayUrl"),
    ),
    equalityIssue(
      "proof gateway URL",
      record.gatewayUrl,
      "dashboard gateway URL",
      stringField(record.dashboard, "gatewayUrl"),
    ),
    equalityIssue(
      "smoke actor",
      stringField(record.smoke, "actor"),
      "dashboard actor",
      dashboardActor,
    ),
    equalityIssue("preflight org scope", preflightOrgId, "smoke org scope", smokeOrgId),
    equalityIssue("preflight repo scope", preflightRepoId, "smoke repo scope", smokeRepoId),
    arrayIncludesIssue(
      dashboardOrgIds,
      preflightOrgId,
      "dashboard org scopes",
      "preflight org scope",
    ),
    arrayIncludesIssue(dashboardOrgIds, smokeOrgId, "dashboard org scopes", "smoke org scope"),
    arrayIncludesIssue(
      dashboardRepoIds,
      preflightRepoId,
      "dashboard repo scopes",
      "preflight repo scope",
    ),
    arrayIncludesIssue(dashboardRepoIds, smokeRepoId, "dashboard repo scopes", "smoke repo scope"),
    ...manualDrillIssues(record.manualDrill, dashboardActor),
    record.rollbackNotes.trim().length === 0 ? "rollback notes are required" : undefined,
  ].filter((issue): issue is string => typeof issue === "string");

  if (issues.length > 0) {
    throw new Error(`Staging proof evidence is incomplete: ${issues.join("; ")}.`);
  }
}

/** Returns a named command output from the evidence list. */
function commandOutput(
  commands: readonly ProofCommandEvidence[],
  name: ProofCommandName,
): JsonRecord {
  const command = commands.find((entry) => entry.name === name);
  if (!command) {
    throw new Error(`Missing command evidence for ${name}.`);
  }

  return command.output;
}

/** Builds the top-level actor evidence from dashboard output. */
function buildProofActor(dashboard: JsonRecord): ProofActorEvidence {
  return {
    provider: requiredString(dashboard, "provider"),
    subject: requiredString(dashboard, "actor"),
  };
}

/** Builds the top-level audit log evidence from command output and manual evidence. */
function buildProofAuditLogIds(
  smoke: JsonRecord,
  dashboard: JsonRecord,
  manualDrill: ManualDrillEvidence,
): ProofAuditLogEvidence {
  const smokeAudit = recordField(smoke, "auditLogIds");
  const dashboardAudit = recordField(dashboard, "auditLogIds");
  return {
    dashboard: {
      login: requiredString(dashboardAudit, "login"),
      logout: requiredString(dashboardAudit, "logout"),
      replay: requiredString(dashboardAudit, "replay"),
      settings: requiredString(dashboardAudit, "settings"),
    },
    manualDrill: manualDrill.auditLogIds,
    smoke: {
      login: requiredString(smokeAudit, "login"),
      logout: requiredString(smokeAudit, "logout"),
    },
  };
}

/** Builds the top-level scope evidence from dashboard output. */
function buildProofScope(dashboard: JsonRecord): ProofScopeEvidence {
  return {
    orgIds: requiredStringArray(dashboard, "orgIds"),
    repoIds: requiredStringArray(dashboard, "repoIds"),
  };
}

/** Parses manually recorded dashboard drill evidence from JSON. */
export function parseManualDrillEvidence(value: string | undefined): ManualDrillEvidence {
  if (!value || value.trim().length === 0) {
    throw new Error("HEIMDALL_CONTROL_PLANE_MANUAL_DRILL_EVIDENCE is required.");
  }

  const parsed = JSON.parse(value) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("HEIMDALL_CONTROL_PLANE_MANUAL_DRILL_EVIDENCE must be a JSON object.");
  }

  const auditLogIds = recordField(parsed, "auditLogIds");
  const completedAt = requiredString(parsed, "completedAt");
  if (Number.isNaN(Date.parse(completedAt))) {
    throw new Error("manual drill completedAt must be an ISO timestamp.");
  }

  return {
    actor: requiredString(parsed, "actor"),
    auditLogIds: {
      login: requiredString(auditLogIds, "login"),
      logout: requiredString(auditLogIds, "logout"),
      replay: requiredString(auditLogIds, "replay"),
      settings: requiredString(auditLogIds, "settings"),
    },
    completedAt,
    notes: requiredString(parsed, "notes"),
    steps: requiredStringArray(parsed, "steps"),
  };
}

/** Returns validation issues for manual drill evidence. */
function manualDrillIssues(
  evidence: ManualDrillEvidence,
  dashboardActor: string | undefined,
): readonly string[] {
  return [
    dashboardActor && evidence.actor !== dashboardActor
      ? "manual drill actor must match dashboard proof actor"
      : undefined,
    ...REQUIRED_MANUAL_DRILL_STEPS.filter((step) => !evidence.steps.includes(step)).map(
      (step) => `manual drill evidence must include ${step}`,
    ),
  ].filter((issue): issue is string => typeof issue === "string");
}

/** Returns an issue when two optional strings are both present and unequal. */
function equalityIssue(
  leftLabel: string,
  left: string | undefined,
  rightLabel: string,
  right: string | undefined,
): string | undefined {
  return left && right && left !== right ? `${leftLabel} must match ${rightLabel}` : undefined;
}

/** Returns an issue when an optional array does not contain an expected optional value. */
function arrayIncludesIssue(
  values: readonly string[] | undefined,
  expected: string | undefined,
  valuesLabel: string,
  expectedLabel: string,
): string | undefined {
  return values && expected && !values.includes(expected)
    ? `${valuesLabel} must include ${expectedLabel}`
    : undefined;
}

/** Builds a useful failure message for a failed proof command. */
function failedCommandMessage(result: ProofCommandResult): string {
  const output = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
  return `Staging proof command failed: bun ${result.args.join(" ")} exited with ${result.exitCode}${
    output ? `\n${output}` : ""
  }`;
}

/** Returns a required string field from one JSON record. */
function requiredString(record: JsonRecord, field: string): string {
  const value = stringField(record, field);
  if (!value) {
    throw new Error(`${field} is required.`);
  }

  return value;
}

/** Returns an optional string field from one JSON record. */
function stringField(record: JsonRecord, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Returns a required string array field from one JSON record. */
function requiredStringArray(record: JsonRecord, field: string): readonly string[] {
  const value = stringArrayField(record, field);
  if (!value) {
    throw new Error(`${field} must be a string array.`);
  }

  return value;
}

/** Returns an optional string array field from one JSON record. */
function stringArrayField(record: JsonRecord, field: string): readonly string[] | undefined {
  const value = record[field];
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : undefined;
}

/** Returns a nested JSON object field. */
function recordField(record: JsonRecord, field: string): JsonRecord {
  const value = record[field];
  return isRecord(value) ? value : {};
}

/** Returns an issue when a string field is missing. */
function requiredFieldIssue(record: JsonRecord, field: string, label: string): string | undefined {
  const value = record[field];
  return typeof value === "string" && value.length > 0 ? undefined : `${label} is required`;
}

/** Returns an issue when a non-empty array field is missing. */
function requiredArrayIssue(record: JsonRecord, field: string, label: string): string | undefined {
  const value = record[field];
  return Array.isArray(value) && value.length > 0 ? undefined : `${label} are required`;
}

/** Returns whether a value is a JSON-like object record. */
function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

if (import.meta.main) {
  await main();
}
