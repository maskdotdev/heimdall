import { describe, expect, it } from "vitest";
import {
  buildProductionDeploymentAuditReport,
  productionDeploymentIssues,
} from "../scripts/validate-production-deployment";

type ProductionDeploymentAuditInput = Parameters<typeof buildProductionDeploymentAuditReport>[0];

/** Required object-storage environment variables for review artifact payloads. */
const REQUIRED_REVIEW_ARTIFACT_ENV = [
  "HEIMDALL_REVIEW_ARTIFACT_BUCKET",
  "HEIMDALL_REVIEW_ARTIFACT_ENDPOINT",
  "HEIMDALL_REVIEW_ARTIFACT_REGION",
  "HEIMDALL_REVIEW_ARTIFACT_ACCESS_KEY_ID",
  "HEIMDALL_REVIEW_ARTIFACT_SECRET_ACCESS_KEY",
];

/** Required AWS environment variables for production SecretRef resolution. */
const REQUIRED_AWS_SECRET_RESOLUTION_ENV = [
  "AWS_ACCESS_KEY_ID",
  "AWS_REGION",
  "AWS_SECRET_ACCESS_KEY",
];

/** Required worker environment variables shared by role-specific worker services. */
const REQUIRED_WORKER_ENV = [
  "DATABASE_URL",
  "REDIS_URL",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY_SECRET_REF",
  ...REQUIRED_AWS_SECRET_RESOLUTION_ENV,
  ...REQUIRED_REVIEW_ARTIFACT_ENV,
];

describe("production deployment manifest", () => {
  it("accepts a complete Railway production manifest", () => {
    const report = buildProductionDeploymentAuditReport(productionDeploymentInput());

    expect(report.status).toBe("admin control-plane production deployment audit passed");
    expect(report.services).toEqual([
      "api",
      "dashboard",
      "admin-gateway",
      "worker-general",
      "worker-index",
      "worker-review",
      "worker-embedding",
      "worker-publisher",
      "worker-maintenance",
      "postgres",
      "redis",
    ]);
    expect(report.dashboards).toEqual([
      "admin_control_plane_health",
      "admin_auth_access",
      "admin_actions_audit",
      "admin_worker_queues",
      "admin_data_services",
      "admin_artifact_security",
      "admin_release_rollback",
    ]);
  });

  it("rejects missing admin gateway service coverage", () => {
    const input = productionDeploymentInput({
      manifest: {
        ...validManifest(),
        services: validManifest().services.filter((service) => service.name !== "admin-gateway"),
      },
    });

    expect(() => buildProductionDeploymentAuditReport(input)).toThrow(
      /production service admin-gateway is required/,
    );
  });

  it("reports missing alerts and gate scripts", () => {
    const input = productionDeploymentInput({
      manifest: {
        ...validManifest(),
        observability: {
          alerts: validManifest().observability.alerts.filter(
            (alert) => alert.id !== "admin_auth_failure_rate",
          ),
        },
      },
      packageJson: {
        scripts: {
          check: "pnpm typecheck",
        },
      },
    });

    expect(productionDeploymentIssues(input)).toEqual(
      expect.arrayContaining([
        "observability alert admin_auth_failure_rate is required",
        "package script preflight:control-plane:staging is required",
      ]),
    );
  });

  it("reports missing production dashboard coverage", () => {
    const input = productionDeploymentInput({
      manifest: {
        ...validManifest(),
        observability: {
          ...validManifest().observability,
          dashboards: validManifest().observability.dashboards.filter(
            (dashboard) => dashboard.id !== "admin_actions_audit",
          ),
        },
      },
    });

    expect(productionDeploymentIssues(input)).toEqual(
      expect.arrayContaining(["observability dashboard admin_actions_audit is required"]),
    );
  });

  it("reports incomplete production dashboard records", () => {
    const input = productionDeploymentInput({
      manifest: {
        ...validManifest(),
        observability: {
          ...validManifest().observability,
          dashboards: validManifest().observability.dashboards.map((dashboard) =>
            dashboard.id === "admin_worker_queues" ? { id: dashboard.id, signals: [] } : dashboard,
          ),
        },
      },
    });

    expect(productionDeploymentIssues(input)).toEqual(
      expect.arrayContaining([
        "observability dashboard admin_worker_queues owner is required",
        "observability dashboard admin_worker_queues signals are required",
        "observability dashboard admin_worker_queues title is required",
      ]),
    );
  });

  it("reports missing review artifact storage and worker runtime environment", () => {
    const input = productionDeploymentInput({
      manifest: {
        ...validManifest(),
        services: validManifest().services.map((serviceRecord) => {
          if (serviceRecord.name === "api") {
            return removeRequiredEnv(serviceRecord, "HEIMDALL_REVIEW_ARTIFACT_BUCKET");
          }
          if (serviceRecord.name === "worker-index") {
            return removeRequiredEnv(
              removeRequiredEnv(serviceRecord, "GITHUB_APP_ID"),
              "HEIMDALL_REVIEW_ARTIFACT_BUCKET",
            );
          }

          return serviceRecord;
        }),
      },
    });

    expect(productionDeploymentIssues(input)).toEqual(
      expect.arrayContaining([
        "api requiredEnv must include HEIMDALL_REVIEW_ARTIFACT_BUCKET",
        "worker-index requiredEnv must include GITHUB_APP_ID",
        "worker-index requiredEnv must include HEIMDALL_REVIEW_ARTIFACT_BUCKET",
      ]),
    );
  });

  it("reports missing production SecretRef provider environment", () => {
    const input = productionDeploymentInput({
      manifest: {
        ...validManifest(),
        services: validManifest().services.map((serviceRecord) => {
          if (serviceRecord.name === "api" || serviceRecord.name === "worker-index") {
            return replaceSecretProviderEnv(serviceRecord, []);
          }

          return serviceRecord;
        }),
      },
    });

    expect(productionDeploymentIssues(input)).toEqual(
      expect.arrayContaining([
        "api requiredEnv must include one SecretRef provider group (AWS/GCP/Vault)",
        "worker-index requiredEnv must include one SecretRef provider group (AWS/GCP/Vault)",
      ]),
    );
  });

  it("accepts GCP and Vault production SecretRef provider environment groups", () => {
    const input = productionDeploymentInput({
      manifest: {
        ...validManifest(),
        services: validManifest().services.map((serviceRecord) => {
          if (serviceRecord.name === "api") {
            return replaceSecretProviderEnv(serviceRecord, ["GCP_SECRET_MANAGER_ACCESS_TOKEN"]);
          }
          if (serviceRecord.name.startsWith("worker-")) {
            return replaceSecretProviderEnv(serviceRecord, ["VAULT_ADDR", "VAULT_TOKEN"]);
          }

          return serviceRecord;
        }),
      },
    });

    expect(productionDeploymentIssues(input)).not.toEqual(
      expect.arrayContaining([
        "api requiredEnv must include one SecretRef provider group (AWS/GCP/Vault)",
        "worker-index requiredEnv must include one SecretRef provider group (AWS/GCP/Vault)",
      ]),
    );
  });

  it("reports missing role-specific worker deployment coverage", () => {
    const input = productionDeploymentInput({
      manifest: {
        ...validManifest(),
        services: validManifest().services.map((serviceRecord) =>
          serviceRecord.name === "worker-review"
            ? { ...serviceRecord, workerRole: "embedding" }
            : serviceRecord,
        ),
      },
    });

    expect(productionDeploymentIssues(input)).toEqual(
      expect.arrayContaining(["worker-review workerRole must be review"]),
    );
  });

  it("reports unsafe review artifact object-storage policy", () => {
    const input = productionDeploymentInput({
      manifest: {
        ...validManifest(),
        artifactStorage: {
          ...validManifest().artifactStorage,
          bucketAccess: "public",
          encryption: "none",
          publicAccess: "allowed",
        },
      },
    });

    expect(productionDeploymentIssues(input)).toEqual(
      expect.arrayContaining([
        "artifactStorage.bucketAccess must be private",
        "artifactStorage.encryption must be provider-managed",
        "artifactStorage.publicAccess must be blocked",
      ]),
    );
  });

  it("rejects missing service Dockerfiles when file existence is supplied", () => {
    const input = productionDeploymentInput({
      fileExists: () => false,
    });

    expect(productionDeploymentIssues(input)).toEqual(
      expect.arrayContaining(["service dockerfile infra/staging/Dockerfile.api must exist"]),
    );
  });

  it("rejects missing Railway config-as-code files when file existence is supplied", () => {
    const input = productionDeploymentInput({
      fileExists: (path) => !path.endsWith(".railway.json"),
    });

    expect(productionDeploymentIssues(input)).toEqual(
      expect.arrayContaining(["railway config infra/railway/api.railway.json must exist"]),
    );
  });
});

/** Creates production deployment audit input with optional overrides. */
function productionDeploymentInput(
  overrides: Partial<ProductionDeploymentAuditInput> = {},
): ProductionDeploymentAuditInput {
  return {
    manifest: validManifest(),
    manifestFile: "infra/production/railway-admin-control-plane.json",
    packageJson: validPackageJson(),
    ...overrides,
  };
}

/** Creates a complete production manifest fixture. */
function validManifest() {
  return {
    artifactStorage: {
      bucketAccess: "private",
      encryption: "provider-managed",
      provider: "s3-compatible",
      publicAccess: "blocked",
      rawDownloadAccess: "support-session-gated",
    },
    environment: "production",
    observability: {
      alerts: [
        alert("admin_api_health"),
        alert("admin_gateway_health"),
        alert("admin_dashboard_health"),
        alert("admin_auth_failure_rate"),
        alert("admin_replay_dispatch_audit"),
        alert("admin_settings_update_audit"),
        alert("admin_emergency_disable"),
      ],
      dashboards: [
        dashboard("admin_control_plane_health"),
        dashboard("admin_auth_access"),
        dashboard("admin_actions_audit"),
        dashboard("admin_worker_queues"),
        dashboard("admin_data_services"),
        dashboard("admin_artifact_security"),
        dashboard("admin_release_rollback"),
      ],
    },
    provider: "railway",
    releaseGates: [
      gate("pnpm release:control-plane:railway"),
      gate("pnpm check"),
      gate("pnpm preflight:control-plane:staging"),
      gate("pnpm smoke:control-plane:staging"),
      gate("pnpm e2e:dashboard"),
      gate("pnpm proof:control-plane:staging"),
      gate("pnpm readiness:control-plane:production"),
    ],
    rollback: {
      checks: ["Admin routes return 404 after emergency disable"],
      commands: ["railway variables --set HEIMDALL_ADMIN_ENABLED=false --service api"],
    },
    services: [
      service(
        "api",
        [
          "DATABASE_URL",
          "REDIS_URL",
          "GITHUB_WEBHOOK_SECRET_REF",
          "HEIMDALL_ADMIN_ENABLED",
          "HEIMDALL_ADMIN_ROUTE_EXPOSURE",
          "HEIMDALL_ADMIN_IDENTITY_PROVIDER",
          "HEIMDALL_ADMIN_IDENTITY_ASSERTION_SECRET",
          "HEIMDALL_ADMIN_SESSION_SECRET",
          "HEIMDALL_ADMIN_ALLOWED_ORIGINS",
          "HEIMDALL_ADMIN_GITHUB_ORG",
          "WEB_URL",
          ...REQUIRED_AWS_SECRET_RESOLUTION_ENV,
          ...REQUIRED_REVIEW_ARTIFACT_ENV,
        ],
        "infra/staging/Dockerfile.api",
        "infra/railway/api.railway.json",
      ),
      service(
        "dashboard",
        ["VITE_HEIMDALL_API_BASE_URL", "VITE_HEIMDALL_ADMIN_GATEWAY_BASE_URL"],
        "infra/staging/Dockerfile.web",
        "infra/railway/dashboard.railway.json",
      ),
      service(
        "admin-gateway",
        [
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
        ],
        "infra/staging/Dockerfile.admin-gateway",
        "infra/railway/admin-gateway.railway.json",
      ),
      workerService(
        "worker-general",
        "repo-sync,memory,billing,security",
        "infra/railway/worker-general.railway.json",
      ),
      workerService("worker-index", "index", "infra/railway/worker-index.railway.json"),
      workerService("worker-review", "review", "infra/railway/worker-review.railway.json", [
        "HEIMDALL_LLM_MODEL",
        "HEIMDALL_LLM_PROVIDER",
        "HEIMDALL_LLM_PROVIDER_API_KEY_SECRET_REF",
      ]),
      workerService(
        "worker-embedding",
        "embedding",
        "infra/railway/worker-embedding.railway.json",
        [
          "HEIMDALL_EMBEDDING_API_KEY_SECRET_REF",
          "HEIMDALL_EMBEDDING_MODEL",
          "HEIMDALL_EMBEDDING_PROVIDER",
        ],
      ),
      workerService("worker-publisher", "publisher", "infra/railway/worker-publisher.railway.json"),
      workerService(
        "worker-maintenance",
        "maintenance",
        "infra/railway/worker-maintenance.railway.json",
      ),
      service("postgres", ["DATABASE_URL"]),
      service("redis", ["REDIS_URL"]),
    ],
  };
}

/** Creates a root package.json fixture with required scripts. */
function validPackageJson() {
  return {
    scripts: {
      check: "pnpm typecheck",
      "e2e:dashboard": "bun run scripts/control-plane-dashboard-e2e.ts",
      "preflight:control-plane:staging": "bun run scripts/control-plane-staging-preflight.ts",
      "proof:control-plane:staging": "bun run scripts/control-plane-staging-proof.ts",
      "readiness:control-plane:production": "bun run scripts/control-plane-production-readiness.ts",
      "release:control-plane:railway": "bun run scripts/control-plane-railway-release.ts",
      "smoke:control-plane:staging": "bun run scripts/control-plane-staging-smoke.ts",
    },
  };
}

/** Creates an alert fixture. */
function alert(id: string) {
  return { id, query: "query", severity: "critical" };
}

/** Creates a dashboard fixture. */
function dashboard(id: string) {
  return { id, owner: "operations", signals: ["health"], title: id };
}

/** Creates a release-gate fixture. */
function gate(command: string) {
  return { command, name: command };
}

/** Creates a service fixture. */
function service(
  name: string,
  requiredEnv: readonly string[],
  dockerfile?: string,
  railwayConfig?: string,
  workerRole?: string,
) {
  return {
    ...(dockerfile ? { dockerfile } : {}),
    healthCheck: "/healthz",
    name,
    package: name,
    ...(railwayConfig ? { railwayConfig } : {}),
    requiredEnv,
    ...(workerRole ? { workerRole } : {}),
  };
}

/** Creates a role-specific worker service fixture. */
function workerService(
  name: string,
  workerRole: string,
  railwayConfig: string,
  extraRequiredEnv: readonly string[] = [],
) {
  return service(
    name,
    [...REQUIRED_WORKER_ENV, ...extraRequiredEnv],
    "infra/staging/Dockerfile.worker",
    railwayConfig,
    workerRole,
  );
}

/** Removes one required environment variable from a service fixture. */
function removeRequiredEnv(serviceRecord: ReturnType<typeof service>, envName: string) {
  return {
    ...serviceRecord,
    requiredEnv: serviceRecord.requiredEnv.filter((requiredEnv) => requiredEnv !== envName),
  };
}

/** Replaces the AWS SecretRef provider env group in a service fixture. */
function replaceSecretProviderEnv(
  serviceRecord: ReturnType<typeof service>,
  replacementEnv: readonly string[],
) {
  return {
    ...serviceRecord,
    requiredEnv: [
      ...serviceRecord.requiredEnv.filter(
        (requiredEnv) => !REQUIRED_AWS_SECRET_RESOLUTION_ENV.includes(requiredEnv),
      ),
      ...replacementEnv,
    ],
  };
}
