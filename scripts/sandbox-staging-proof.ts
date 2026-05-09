import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  type AdminIdentityRequestHeaders,
  readGatewayIdentityAssertion,
} from "./admin-smoke-identity";

/** Default file path for sandbox staging proof evidence. */
const DEFAULT_EVIDENCE_FILE = "docs/evidence/sandbox-staging-proof.json";

/** Default sandbox run status expected by the staging proof. */
const DEFAULT_EXPECTED_SANDBOX_STATUS = "succeeded";

/** Environment values required for the sandbox staging proof. */
type SandboxProofEnvironment = {
  /** Dashboard origin allowed to use admin credentials. */
  readonly adminOrigin: string;
  /** Staging API base URL. */
  readonly apiUrl: string;
  /** Absolute path where the proof record should be written. */
  readonly evidenceFile: string;
  /** Expected sandbox run status. */
  readonly expectedStatus: string;
  /** Maximum sandbox runs to inspect. */
  readonly limit: number;
  /** Organization scope requested from the identity gateway. */
  readonly orgId: string;
  /** Provider subject used for the proof actor. */
  readonly providerSubject: string;
  /** Repository scope requested from the identity gateway. */
  readonly repoId: string;
  /** Optional review run that must own the sandbox proof rows. */
  readonly reviewRunId?: string | undefined;
};

/** Minimal API envelope returned by admin routes. */
type ApiEnvelope<T> = {
  /** Response payload. */
  readonly data: T;
};

/** Session payload returned by the admin API. */
type SandboxProofSession = {
  /** Authenticated actor summary. */
  readonly actor: {
    /** Provider-backed actor ID. */
    readonly userId: string;
  };
};

/** Product-safe policy decision counts for one sandbox run. */
type SandboxPolicyDecisionCounts = {
  /** Allowed policy decision count. */
  readonly allowed: number;
  /** Denied policy decision count. */
  readonly denied: number;
  /** Warning policy decision count. */
  readonly warning: number;
};

/** Product-safe sandbox artifact summary returned by the admin API. */
type SandboxArtifactSummary = {
  /** Artifact creation timestamp. */
  readonly createdAt: string;
  /** Whether the artifact was truncated before persistence. */
  readonly truncated: boolean;
  /** Artifact name scoped to the sandbox run. */
  readonly name: string;
  /** Sandbox artifact row ID. */
  readonly sandboxArtifactId: string;
  /** Artifact SHA-256 digest. */
  readonly sha256: string;
  /** Artifact byte size. */
  readonly sizeBytes: number;
  /** Durable artifact URI. */
  readonly uri: string;
};

/** Product-safe sandbox run summary returned by the admin API. */
type SandboxRunSummary = {
  /** Artifacts collected for the sandbox run. */
  readonly artifacts: readonly SandboxArtifactSummary[];
  /** Sandbox execution category. */
  readonly category: string;
  /** ISO timestamp when the sandbox run row was created. */
  readonly createdAt: string;
  /** Process exit code when available. */
  readonly exitCode?: number | undefined;
  /** ISO timestamp when execution finished. */
  readonly finishedAt?: string | undefined;
  /** Container image name. */
  readonly image: string;
  /** Organization that owns the sandbox run. */
  readonly orgId: string;
  /** Product-safe policy decision counts. */
  readonly policyDecisionCounts: SandboxPolicyDecisionCounts;
  /** Repository that owns the sandbox run. */
  readonly repoId: string;
  /** Unique sandbox request ID. */
  readonly requestId: string;
  /** Review run that owns the sandbox run when available. */
  readonly reviewRunId?: string | undefined;
  /** Runner kind, such as docker or gvisor. */
  readonly runnerKind: string;
  /** Sandbox run row ID. */
  readonly sandboxRunId: string;
  /** Whether stderr was truncated before persistence. */
  readonly stderrTruncated: boolean;
  /** Whether stdout was truncated before persistence. */
  readonly stdoutTruncated: boolean;
  /** ISO timestamp when execution started. */
  readonly startedAt?: string | undefined;
  /** Final sandbox status. */
  readonly status: string;
  /** Sandbox trust level. */
  readonly trustLevel: string;
};

/** Actor evidence summarized at the top level of the proof record. */
type SandboxProofActor = {
  /** Provider-backed actor subject stored by the API. */
  readonly subject: string;
};

/** Query summarized at the top level of the proof record. */
type SandboxProofQuery = {
  /** Maximum sandbox runs inspected. */
  readonly limit: number;
  /** Expected sandbox run status. */
  readonly status: string;
};

/** Scope summarized at the top level of the proof record. */
type SandboxProofScope = {
  /** Organization scope requested from the identity gateway. */
  readonly orgId: string;
  /** Repository scope used for proof discovery. */
  readonly repoId: string;
  /** Review-run scope for the proof query when present. */
  readonly reviewRunId?: string | undefined;
};

/** Evidence retained for one sandbox run. */
type SandboxRunProof = {
  /** Artifact proof summaries. */
  readonly artifacts: readonly SandboxArtifactProof[];
  /** Sandbox execution category. */
  readonly category: string;
  /** ISO timestamp when the sandbox run row was created. */
  readonly createdAt: string;
  /** Process exit code when available. */
  readonly exitCode?: number | undefined;
  /** ISO timestamp when execution finished. */
  readonly finishedAt?: string | undefined;
  /** Container image name. */
  readonly image: string;
  /** Organization that owns the sandbox run. */
  readonly orgId: string;
  /** Product-safe policy decision counts. */
  readonly policyDecisionCounts: SandboxPolicyDecisionCounts;
  /** Repository that owns the sandbox run. */
  readonly repoId: string;
  /** Unique sandbox request ID. */
  readonly requestId: string;
  /** Review run that owns the sandbox run when available. */
  readonly reviewRunId?: string | undefined;
  /** Runner kind, such as docker or gvisor. */
  readonly runnerKind: string;
  /** Sandbox run row ID. */
  readonly sandboxRunId: string;
  /** Whether stderr was truncated before persistence. */
  readonly stderrTruncated: boolean;
  /** Whether stdout was truncated before persistence. */
  readonly stdoutTruncated: boolean;
  /** ISO timestamp when execution started. */
  readonly startedAt?: string | undefined;
  /** Final sandbox status. */
  readonly status: string;
  /** Sandbox trust level. */
  readonly trustLevel: string;
};

/** Product-safe artifact proof summary. */
type SandboxArtifactProof = {
  /** Artifact creation timestamp. */
  readonly createdAt: string;
  /** Whether the artifact was truncated before persistence. */
  readonly truncated: boolean;
  /** Artifact name scoped to the sandbox run. */
  readonly name: string;
  /** Sandbox artifact row ID. */
  readonly sandboxArtifactId: string;
  /** Artifact SHA-256 digest. */
  readonly sha256: string;
  /** Artifact byte size. */
  readonly sizeBytes: number;
};

/** Combined sandbox staging proof evidence record. */
export type SandboxStagingProofRecord = {
  /** Staging API base URL covered by the proof. */
  readonly apiUrl: string;
  /** Provider actor summarized from the proof login. */
  readonly actor: SandboxProofActor;
  /** ISO timestamp when the proof record was generated. */
  readonly generatedAt: string;
  /** Staging identity gateway URL used by the proof. */
  readonly gatewayUrl: string;
  /** Sandbox run query used for proof discovery. */
  readonly query: SandboxProofQuery;
  /** Sandbox run evidence rows returned by the deployed API. */
  readonly sandboxRuns: readonly SandboxRunProof[];
  /** Organization and repository scope covered by the proof. */
  readonly scope: SandboxProofScope;
  /** Overall proof status. */
  readonly status: "sandbox staging proof passed";
};

/** Input used to build a sandbox staging proof record. */
export type SandboxStagingProofInput = {
  /** Staging API base URL covered by the proof. */
  readonly apiUrl: string;
  /** Provider actor summarized from the proof login. */
  readonly actor: SandboxProofActor;
  /** Expected sandbox run status. */
  readonly expectedStatus: string;
  /** Staging identity gateway URL used by the proof. */
  readonly gatewayUrl: string;
  /** Maximum sandbox runs inspected. */
  readonly limit: number;
  /** Organization scope requested from the identity gateway. */
  readonly orgId: string;
  /** Repository scope for the proof query. */
  readonly repoId: string;
  /** Review-run scope for the proof query when present. */
  readonly reviewRunId?: string | undefined;
  /** Sandbox run rows returned by the deployed API. */
  readonly sandboxRuns: readonly SandboxRunSummary[];
};

/** Runs the sandbox staging proof and writes one evidence record. */
async function main(): Promise<void> {
  const env = readEnvironment();
  const identity = await readGatewayIdentityAssertion({
    orgId: env.orgId,
    providerSubject: env.providerSubject,
    purpose: "sandbox-staging-proof",
    repoId: env.repoId,
  });
  const login = await loginAdmin(env, identity.headers);
  const sandboxRuns = await listSandboxRuns(env, login.cookie);
  const proofRecord = buildSandboxStagingProofRecord({
    actor: { subject: login.session.actor.userId },
    apiUrl: env.apiUrl,
    expectedStatus: env.expectedStatus,
    gatewayUrl: identity.source,
    limit: env.limit,
    orgId: env.orgId,
    repoId: env.repoId,
    ...(env.reviewRunId ? { reviewRunId: env.reviewRunId } : {}),
    sandboxRuns,
  });

  await writeProofRecord(env.evidenceFile, proofRecord);
  console.log(
    JSON.stringify(
      {
        actor: proofRecord.actor,
        evidenceFile: env.evidenceFile,
        gatewayUrl: proofRecord.gatewayUrl,
        query: proofRecord.query,
        sandboxRunCount: proofRecord.sandboxRuns.length,
        scope: proofRecord.scope,
        status: proofRecord.status,
      },
      null,
      2,
    ),
  );
}

/** Builds and validates one sandbox staging proof record. */
export function buildSandboxStagingProofRecord(
  input: SandboxStagingProofInput,
): SandboxStagingProofRecord {
  const record: SandboxStagingProofRecord = {
    actor: input.actor,
    apiUrl: input.apiUrl,
    generatedAt: new Date().toISOString(),
    gatewayUrl: input.gatewayUrl,
    query: {
      limit: input.limit,
      status: input.expectedStatus,
    },
    sandboxRuns: input.sandboxRuns.map(toSandboxRunProof),
    scope: {
      orgId: input.orgId,
      repoId: input.repoId,
      ...(input.reviewRunId ? { reviewRunId: input.reviewRunId } : {}),
    },
    status: "sandbox staging proof passed",
  };
  const issues = sandboxStagingProofIssues(record);
  if (issues.length > 0) {
    throw new Error(`Sandbox staging proof failed: ${issues.join("; ")}.`);
  }

  return record;
}

/** Returns validation issues for one sandbox staging proof record. */
export function sandboxStagingProofIssues(record: SandboxStagingProofRecord): readonly string[] {
  return [
    !isNonLocalHttpsUrl(record.apiUrl) ? "apiUrl must be deployed https" : undefined,
    !isNonLocalHttpsUrl(record.gatewayUrl) ? "gatewayUrl must be deployed https" : undefined,
    !isIsoTimestamp(record.generatedAt) ? "generatedAt must be an ISO timestamp" : undefined,
    !record.actor.subject ? "actor subject is required" : undefined,
    !record.scope.orgId ? "scope orgId is required" : undefined,
    !record.scope.repoId ? "scope repoId is required" : undefined,
    !record.query.status ? "query status is required" : undefined,
    record.sandboxRuns.length === 0 ? "at least one sandbox run is required" : undefined,
    ...record.sandboxRuns.flatMap((run) => sandboxRunProofIssues(record, run)),
  ].filter((issue): issue is string => typeof issue === "string");
}

/** Logs into the staging API with a signed identity assertion. */
async function loginAdmin(
  env: SandboxProofEnvironment,
  identityHeaders: AdminIdentityRequestHeaders,
): Promise<{
  /** Cookie header value returned by the API. */
  readonly cookie: string;
  /** Authenticated session payload. */
  readonly session: SandboxProofSession;
}> {
  const response = await fetch(new URL("/admin/auth/login", env.apiUrl), {
    method: "POST",
    headers: {
      ...identityHeaders,
      origin: env.adminOrigin,
    },
  });
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  const body = await response.json().catch(() => undefined);
  if (!response.ok || !cookie) {
    throw new Error(
      `Admin login for sandbox staging proof failed with HTTP ${response.status}: ${JSON.stringify(
        body,
      )}`,
    );
  }

  return { cookie, session: (body as ApiEnvelope<SandboxProofSession>).data };
}

/** Lists sandbox runs from the deployed admin API. */
async function listSandboxRuns(
  env: SandboxProofEnvironment,
  cookie: string,
): Promise<readonly SandboxRunSummary[]> {
  const url = new URL("/admin/sandbox/runs", env.apiUrl);
  url.searchParams.set("limit", String(env.limit));
  url.searchParams.set("repoId", env.repoId);
  url.searchParams.set("status", env.expectedStatus);
  if (env.reviewRunId) {
    url.searchParams.set("reviewRunId", env.reviewRunId);
  }

  const body = await getJson<ApiEnvelope<{ readonly sandboxRuns: readonly SandboxRunSummary[] }>>(
    url,
    { headers: { cookie } },
  );
  return body.data.sandboxRuns;
}

/** Gets JSON from one proof endpoint and fails on non-2xx responses. */
async function getJson<T>(url: URL, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new Error(`${url.pathname} failed with HTTP ${response.status}: ${JSON.stringify(body)}`);
  }

  return body as T;
}

/** Reads and validates proof environment variables. */
function readEnvironment(): SandboxProofEnvironment {
  const env = requiredEnvironment([
    "API_URL",
    "HEIMDALL_ADMIN_SMOKE_ASSERTION_URL",
    "HEIMDALL_ADMIN_SMOKE_ORG_ID",
    "HEIMDALL_ADMIN_SMOKE_REPO_ID",
  ] as const);
  const allowLocalTarget = process.env.HEIMDALL_ADMIN_SMOKE_ALLOW_LOCAL_TARGET === "true";
  assertNonLocalProofTarget("API_URL", env.API_URL, allowLocalTarget);
  assertNonLocalProofTarget(
    "HEIMDALL_ADMIN_SMOKE_ASSERTION_URL",
    env.HEIMDALL_ADMIN_SMOKE_ASSERTION_URL,
    allowLocalTarget,
  );

  return {
    adminOrigin: adminSmokeOrigin(allowLocalTarget),
    apiUrl: env.API_URL,
    evidenceFile: resolve(
      process.env.HEIMDALL_SANDBOX_STAGING_EVIDENCE_FILE ?? DEFAULT_EVIDENCE_FILE,
    ),
    expectedStatus:
      emptyToUndefined(process.env.HEIMDALL_SANDBOX_SMOKE_STATUS) ??
      DEFAULT_EXPECTED_SANDBOX_STATUS,
    limit: readLimit(process.env.HEIMDALL_SANDBOX_SMOKE_LIMIT),
    orgId: env.HEIMDALL_ADMIN_SMOKE_ORG_ID,
    providerSubject: process.env.HEIMDALL_ADMIN_SMOKE_PROVIDER_SUBJECT ?? "sandbox-staging-proof",
    repoId: env.HEIMDALL_ADMIN_SMOKE_REPO_ID,
    ...(emptyToUndefined(process.env.HEIMDALL_SANDBOX_SMOKE_REVIEW_RUN_ID)
      ? { reviewRunId: emptyToUndefined(process.env.HEIMDALL_SANDBOX_SMOKE_REVIEW_RUN_ID) }
      : {}),
  };
}

/** Converts one API sandbox run summary to retained proof evidence. */
function toSandboxRunProof(run: SandboxRunSummary): SandboxRunProof {
  return {
    artifacts: run.artifacts.map((artifact) => ({
      createdAt: artifact.createdAt,
      name: artifact.name,
      sandboxArtifactId: artifact.sandboxArtifactId,
      sha256: artifact.sha256,
      sizeBytes: artifact.sizeBytes,
      truncated: artifact.truncated,
    })),
    category: run.category,
    createdAt: run.createdAt,
    ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
    ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
    image: run.image,
    orgId: run.orgId,
    policyDecisionCounts: run.policyDecisionCounts,
    repoId: run.repoId,
    requestId: run.requestId,
    ...(run.reviewRunId ? { reviewRunId: run.reviewRunId } : {}),
    runnerKind: run.runnerKind,
    sandboxRunId: run.sandboxRunId,
    stderrTruncated: run.stderrTruncated,
    stdoutTruncated: run.stdoutTruncated,
    ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    status: run.status,
    trustLevel: run.trustLevel,
  };
}

/** Returns validation issues for one sandbox run proof row. */
function sandboxRunProofIssues(
  record: SandboxStagingProofRecord,
  run: SandboxRunProof,
): readonly string[] {
  return [
    !run.sandboxRunId ? "sandbox run id is required" : undefined,
    run.orgId !== record.scope.orgId
      ? `sandbox run ${run.sandboxRunId} orgId must match ${record.scope.orgId}`
      : undefined,
    run.repoId !== record.scope.repoId
      ? `sandbox run ${run.sandboxRunId} repoId must match ${record.scope.repoId}`
      : undefined,
    run.status !== record.query.status
      ? `sandbox run ${run.sandboxRunId} status must be ${record.query.status}`
      : undefined,
    run.runnerKind === "local_process"
      ? `sandbox run ${run.sandboxRunId} must not use local_process runner`
      : undefined,
    !run.requestId ? `sandbox run ${run.sandboxRunId} requestId is required` : undefined,
    !run.image ? `sandbox run ${run.sandboxRunId} image is required` : undefined,
    run.stdoutTruncated
      ? `sandbox run ${run.sandboxRunId} stdout must not be truncated`
      : undefined,
    run.stderrTruncated
      ? `sandbox run ${run.sandboxRunId} stderr must not be truncated`
      : undefined,
    !isIsoTimestamp(run.createdAt)
      ? `sandbox run ${run.sandboxRunId} createdAt is invalid`
      : undefined,
    run.startedAt && !isIsoTimestamp(run.startedAt)
      ? `sandbox run ${run.sandboxRunId} startedAt is invalid`
      : undefined,
    run.finishedAt && !isIsoTimestamp(run.finishedAt)
      ? `sandbox run ${run.sandboxRunId} finishedAt is invalid`
      : undefined,
    run.policyDecisionCounts.denied > 0
      ? `sandbox run ${run.sandboxRunId} has denied policy decisions`
      : undefined,
    record.scope.reviewRunId && run.reviewRunId !== record.scope.reviewRunId
      ? `sandbox run ${run.sandboxRunId} reviewRunId must match ${record.scope.reviewRunId}`
      : undefined,
    run.artifacts.length === 0
      ? `sandbox run ${run.sandboxRunId} must include at least one artifact`
      : undefined,
    ...run.artifacts.flatMap((artifact) => sandboxArtifactProofIssues(run, artifact)),
  ].filter((issue): issue is string => typeof issue === "string");
}

/** Returns validation issues for one sandbox artifact proof row. */
function sandboxArtifactProofIssues(
  run: SandboxRunProof,
  artifact: SandboxArtifactProof,
): readonly string[] {
  return [
    !artifact.sandboxArtifactId
      ? `sandbox run ${run.sandboxRunId} artifact id is required`
      : undefined,
    !artifact.name ? `sandbox run ${run.sandboxRunId} artifact name is required` : undefined,
    !isSandboxArtifactSha256(artifact.sha256)
      ? `sandbox run ${run.sandboxRunId} artifact ${artifact.name} sha256 is invalid`
      : undefined,
    artifact.sizeBytes <= 0
      ? `sandbox run ${run.sandboxRunId} artifact ${artifact.name} size is invalid`
      : undefined,
    artifact.truncated
      ? `sandbox run ${run.sandboxRunId} artifact ${artifact.name} must not be truncated`
      : undefined,
    !isIsoTimestamp(artifact.createdAt)
      ? `sandbox run ${run.sandboxRunId} artifact ${artifact.name} createdAt is invalid`
      : undefined,
  ].filter((issue): issue is string => typeof issue === "string");
}

/** Writes the proof record to disk. */
async function writeProofRecord(
  evidenceFile: string,
  record: SandboxStagingProofRecord,
): Promise<void> {
  await mkdir(dirname(evidenceFile), { recursive: true });
  await writeFile(evidenceFile, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

/** Resolves the dashboard origin sent on credentialed admin requests. */
function adminSmokeOrigin(allowLocalTarget: boolean): string {
  const configuredOrigin = emptyToUndefined(process.env.HEIMDALL_ADMIN_SMOKE_ORIGIN);
  if (configuredOrigin) {
    return new URL(configuredOrigin).origin;
  }

  const webUrl = emptyToUndefined(process.env.WEB_URL);
  if (webUrl) {
    return new URL(webUrl).origin;
  }

  if (allowLocalTarget) {
    return "http://localhost:3001";
  }

  throw new Error("WEB_URL or HEIMDALL_ADMIN_SMOKE_ORIGIN is required for sandbox staging proof.");
}

/** Reads required environment variables and reports all missing names at once. */
function requiredEnvironment<const Names extends readonly string[]>(
  names: Names,
): { readonly [Key in Names[number]]: string } {
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}.`);
  }

  return Object.fromEntries(names.map((name) => [name, process.env[name] ?? ""])) as {
    readonly [Key in Names[number]]: string;
  };
}

/** Reads a bounded sandbox proof list limit. */
function readLimit(value: string | undefined): number {
  if (!value) {
    return 10;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error("HEIMDALL_SANDBOX_SMOKE_LIMIT must be an integer between 1 and 100.");
  }

  return parsed;
}

/** Ensures a staging proof target does not point at local development services. */
function assertNonLocalProofTarget(name: string, value: string, allowLocalTarget: boolean): void {
  if (allowLocalTarget) {
    return;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL.`);
  }

  if (isLocalHostname(url.hostname)) {
    throw new Error(
      `${name} must point at a deployed staging target. Set HEIMDALL_ADMIN_SMOKE_ALLOW_LOCAL_TARGET=true only for local development proof.`,
    );
  }
}

/** Converts a blank string to undefined. */
function emptyToUndefined(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

/** Returns whether a string is an ISO timestamp. */
function isIsoTimestamp(value: string | undefined): boolean {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/** Returns whether a URL is HTTPS and not local development infrastructure. */
function isNonLocalHttpsUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  return url.protocol === "https:" && !isLocalHostname(url.hostname);
}

/** Returns whether a sandbox artifact hash is a SHA-256 digest. */
function isSandboxArtifactSha256(value: string): boolean {
  return /^(sha256:)?[a-f0-9]{64}$/u.test(value);
}

/** Returns whether a hostname targets local development infrastructure. */
function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "localhost.localdomain" ||
    normalized === "host.docker.internal" ||
    normalized === "0.0.0.0" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    /^127\./u.test(normalized)
  );
}

if (import.meta.main) {
  await main();
}
