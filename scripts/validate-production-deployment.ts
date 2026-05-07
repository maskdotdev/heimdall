import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/** Default production deployment manifest path. */
const DEFAULT_MANIFEST_FILE = "infra/production/railway-admin-control-plane.json";

/** Required production services for the admin control-plane deployment. */
const REQUIRED_SERVICES = ["api", "dashboard", "admin-gateway", "worker", "postgres", "redis"];

/** Required production alert IDs for admin control-plane operations. */
const REQUIRED_ALERT_IDS = [
  "admin_api_health",
  "admin_gateway_health",
  "admin_dashboard_health",
  "admin_auth_failure_rate",
  "admin_replay_dispatch_audit",
  "admin_settings_update_audit",
  "admin_emergency_disable",
];

/** Services that must use Railway config-as-code. */
const REQUIRED_RAILWAY_CONFIG_SERVICES = ["api", "dashboard", "admin-gateway", "worker"];

/** Required production artifact-storage policy fields. */
const REQUIRED_ARTIFACT_STORAGE_POLICY = {
  bucketAccess: "private",
  encryption: "provider-managed",
  provider: "s3-compatible",
  publicAccess: "blocked",
  rawDownloadAccess: "support-session-gated",
};

/** Required workspace scripts that back the production release gates. */
const REQUIRED_PACKAGE_SCRIPTS = [
  "check",
  "preflight:control-plane:staging",
  "smoke:control-plane:staging",
  "e2e:dashboard",
  "proof:control-plane:staging",
  "readiness:control-plane:production",
  "release:control-plane:railway",
];

/** Required release-gate commands in the production deployment manifest. */
const REQUIRED_RELEASE_GATE_COMMANDS = REQUIRED_PACKAGE_SCRIPTS.map((script) => `pnpm ${script}`);

/** Required object-storage environment variables for immutable review artifact payloads. */
const REQUIRED_REVIEW_ARTIFACT_ENV = [
  "HEIMDALL_REVIEW_ARTIFACT_BUCKET",
  "HEIMDALL_REVIEW_ARTIFACT_ENDPOINT",
  "HEIMDALL_REVIEW_ARTIFACT_REGION",
  "HEIMDALL_REVIEW_ARTIFACT_ACCESS_KEY_ID",
  "HEIMDALL_REVIEW_ARTIFACT_SECRET_ACCESS_KEY",
];

/** Required API environment variables for production admin routes. */
const REQUIRED_API_ENV = [
  "DATABASE_URL",
  "REDIS_URL",
  "GITHUB_WEBHOOK_SECRET",
  "HEIMDALL_ADMIN_ENABLED",
  "HEIMDALL_ADMIN_ROUTE_EXPOSURE",
  "HEIMDALL_ADMIN_IDENTITY_PROVIDER",
  "HEIMDALL_ADMIN_IDENTITY_ASSERTION_SECRET",
  "HEIMDALL_ADMIN_SESSION_SECRET",
  "HEIMDALL_ADMIN_ALLOWED_ORIGINS",
  "HEIMDALL_ADMIN_GITHUB_ORG",
  "WEB_URL",
  ...REQUIRED_REVIEW_ARTIFACT_ENV,
];

/** Required dashboard build-time environment variables for production login. */
const REQUIRED_DASHBOARD_ENV = [
  "VITE_HEIMDALL_API_BASE_URL",
  "VITE_HEIMDALL_ADMIN_GATEWAY_BASE_URL",
];

/** Required admin gateway environment variables for production OAuth. */
const REQUIRED_GATEWAY_ENV = [
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "HEIMDALL_ADMIN_GATEWAY_PUBLIC_URL",
  "HEIMDALL_ADMIN_GATEWAY_DASHBOARD_URL",
  "HEIMDALL_ADMIN_GATEWAY_SESSION_SECRET",
  "HEIMDALL_ADMIN_GATEWAY_ALLOWED_LOGINS",
  "HEIMDALL_ADMIN_GATEWAY_ORG_IDS",
  "HEIMDALL_ADMIN_GATEWAY_PERMISSIONS",
  "HEIMDALL_ADMIN_IDENTITY_ASSERTION_SECRET",
  "HEIMDALL_ADMIN_GITHUB_ORG",
];

/** Required worker environment variables for review orchestration and artifact writes. */
const REQUIRED_WORKER_ENV = [
  "DATABASE_URL",
  "REDIS_URL",
  "GITHUB_APP_ID",
  "GITHUB_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
  ...REQUIRED_REVIEW_ARTIFACT_ENV,
];

/** JSON object shape used by deployment manifests. */
type JsonRecord = Readonly<Record<string, unknown>>;

/** Inputs used to validate the production deployment manifest. */
export type ProductionDeploymentAuditInput = {
  /** Optional file existence predicate for manifest-local artifact paths. */
  readonly fileExists?: ((path: string) => boolean) | undefined;
  /** Parsed production deployment manifest. */
  readonly manifest: JsonRecord;
  /** Manifest file used in report output. */
  readonly manifestFile: string;
  /** Parsed root package.json. */
  readonly packageJson: JsonRecord;
};

/** Production deployment audit report emitted by the validator. */
export type ProductionDeploymentAuditReport = {
  /** Alert IDs validated by the audit. */
  readonly alerts: readonly string[];
  /** Release-gate commands validated by the audit. */
  readonly releaseGates: readonly string[];
  /** Production services validated by the audit. */
  readonly services: readonly string[];
  /** Overall audit status. */
  readonly status: "admin control-plane production deployment audit passed";
};

/** Runs the production deployment audit from local files. */
async function main(): Promise<void> {
  const manifestFile = resolve(
    process.env.HEIMDALL_PRODUCTION_DEPLOYMENT_FILE ?? DEFAULT_MANIFEST_FILE,
  );
  const packageJsonFile = resolve("package.json");
  const report = buildProductionDeploymentAuditReport({
    fileExists: (path) => existsSync(resolve(path)),
    manifest: parseJsonRecord(await readFile(manifestFile, "utf8"), manifestFile),
    manifestFile,
    packageJson: parseJsonRecord(await readFile(packageJsonFile, "utf8"), packageJsonFile),
  });

  console.log(JSON.stringify(report, null, 2));
}

/** Builds and validates the admin control-plane production deployment audit report. */
export function buildProductionDeploymentAuditReport(
  input: ProductionDeploymentAuditInput,
): ProductionDeploymentAuditReport {
  const issues = productionDeploymentIssues(input);
  if (issues.length > 0) {
    throw new Error(
      `Admin control-plane production deployment audit failed: ${issues.join("; ")}.`,
    );
  }

  return {
    alerts: alertIds(input.manifest),
    releaseGates: releaseGateCommands(input.manifest),
    services: serviceNames(input.manifest),
    status: "admin control-plane production deployment audit passed",
  };
}

/** Returns all production deployment audit issues. */
export function productionDeploymentIssues(
  input: ProductionDeploymentAuditInput,
): readonly string[] {
  const services = serviceRecords(input.manifest);
  const apiService = serviceByName(services, "api");
  const dashboardService = serviceByName(services, "dashboard");
  const gatewayService = serviceByName(services, "admin-gateway");
  const workerService = serviceByName(services, "worker");
  const scripts = recordField(input.packageJson, "scripts");

  return [
    stringField(input.manifest, "provider") !== "railway"
      ? "production deployment provider must be railway"
      : undefined,
    stringField(input.manifest, "environment") !== "production"
      ? "production deployment environment must be production"
      : undefined,
    ...REQUIRED_SERVICES.filter((service) => !serviceNames(input.manifest).includes(service)).map(
      (service) => `production service ${service} is required`,
    ),
    ...REQUIRED_API_ENV.filter((envName) => !requiredEnv(apiService).includes(envName)).map(
      (envName) => `api requiredEnv must include ${envName}`,
    ),
    ...REQUIRED_DASHBOARD_ENV.filter(
      (envName) => !requiredEnv(dashboardService).includes(envName),
    ).map((envName) => `dashboard requiredEnv must include ${envName}`),
    ...REQUIRED_GATEWAY_ENV.filter((envName) => !requiredEnv(gatewayService).includes(envName)).map(
      (envName) => `admin-gateway requiredEnv must include ${envName}`,
    ),
    ...REQUIRED_WORKER_ENV.filter((envName) => !requiredEnv(workerService).includes(envName)).map(
      (envName) => `worker requiredEnv must include ${envName}`,
    ),
    ...artifactStoragePolicyIssues(input.manifest),
    ...REQUIRED_RELEASE_GATE_COMMANDS.filter(
      (command) => !releaseGateCommands(input.manifest).includes(command),
    ).map((command) => `release gate ${command} is required`),
    ...REQUIRED_PACKAGE_SCRIPTS.filter((script) => !stringField(scripts, script)).map(
      (script) => `package script ${script} is required`,
    ),
    ...REQUIRED_ALERT_IDS.filter((alertId) => !alertIds(input.manifest).includes(alertId)).map(
      (alertId) => `observability alert ${alertId} is required`,
    ),
    ...missingDockerfileIssues(input),
    ...missingRailwayConfigIssues(input),
    requiredStringArray(recordField(input.manifest, "rollback"), "commands").length === 0
      ? "rollback commands are required"
      : undefined,
    requiredStringArray(recordField(input.manifest, "rollback"), "checks").length === 0
      ? "rollback checks are required"
      : undefined,
  ].filter((issue): issue is string => typeof issue === "string");
}

/** Returns issues for the production review artifact-storage policy. */
function artifactStoragePolicyIssues(manifest: JsonRecord): readonly string[] {
  const artifactStorage = recordField(manifest, "artifactStorage");

  return Object.entries(REQUIRED_ARTIFACT_STORAGE_POLICY)
    .filter(
      ([fieldName, expectedValue]) => stringField(artifactStorage, fieldName) !== expectedValue,
    )
    .map(([fieldName, expectedValue]) => `artifactStorage.${fieldName} must be ${expectedValue}`);
}

/** Returns issues for required Railway config-as-code files that do not exist. */
function missingRailwayConfigIssues(input: ProductionDeploymentAuditInput): readonly string[] {
  const services = serviceRecords(input.manifest);
  return REQUIRED_RAILWAY_CONFIG_SERVICES.flatMap((serviceName) => {
    const service = serviceByName(services, serviceName);
    const railwayConfig = stringField(service, "railwayConfig");
    if (!railwayConfig) {
      return [`${serviceName} railwayConfig is required`];
    }
    if (input.fileExists && !input.fileExists(railwayConfig)) {
      return [`railway config ${railwayConfig} must exist`];
    }

    return [];
  });
}

/** Returns issues for service Dockerfiles that do not exist. */
function missingDockerfileIssues(input: ProductionDeploymentAuditInput): readonly string[] {
  if (!input.fileExists) {
    return [];
  }

  return serviceRecords(input.manifest)
    .map((service) => stringField(service, "dockerfile"))
    .filter((dockerfile): dockerfile is string => typeof dockerfile === "string")
    .filter((dockerfile) => !input.fileExists?.(dockerfile))
    .map((dockerfile) => `service dockerfile ${dockerfile} must exist`);
}

/** Returns release-gate commands from a manifest. */
function releaseGateCommands(manifest: JsonRecord): readonly string[] {
  return recordArray(manifest, "releaseGates")
    .map((gate) => stringField(gate, "command"))
    .filter((command): command is string => typeof command === "string");
}

/** Returns alert IDs from a manifest. */
function alertIds(manifest: JsonRecord): readonly string[] {
  return recordArray(recordField(manifest, "observability"), "alerts")
    .map((alert) => stringField(alert, "id"))
    .filter((alertId): alertId is string => typeof alertId === "string");
}

/** Returns service names from a manifest. */
function serviceNames(manifest: JsonRecord): readonly string[] {
  return serviceRecords(manifest)
    .map((service) => stringField(service, "name"))
    .filter((service): service is string => typeof service === "string");
}

/** Returns service records from a manifest. */
function serviceRecords(manifest: JsonRecord): readonly JsonRecord[] {
  return recordArray(manifest, "services");
}

/** Returns one service record by name. */
function serviceByName(services: readonly JsonRecord[], name: string): JsonRecord {
  return services.find((service) => stringField(service, "name") === name) ?? {};
}

/** Returns required environment variables from a service record. */
function requiredEnv(service: JsonRecord): readonly string[] {
  return requiredStringArray(service, "requiredEnv");
}

/** Parses JSON text as an object record. */
function parseJsonRecord(text: string, label: string): JsonRecord {
  const parsed = JSON.parse(text) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`${label} must contain a JSON object.`);
  }

  return parsed;
}

/** Returns a nested object record from one record. */
function recordField(record: JsonRecord, field: string): JsonRecord {
  const value = record[field];
  return isRecord(value) ? value : {};
}

/** Returns an array of records from one record. */
function recordArray(record: JsonRecord, field: string): readonly JsonRecord[] {
  const value = record[field];
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** Returns a required string array from one record. */
function requiredStringArray(record: JsonRecord, field: string): readonly string[] {
  const value = record[field];
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : [];
}

/** Returns an optional string from one record. */
function stringField(record: JsonRecord, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Returns whether a value is a JSON object record. */
function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

if (import.meta.main) {
  await main();
}
