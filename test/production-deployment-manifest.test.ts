import { describe, expect, it } from "vitest";
import {
  buildProductionDeploymentAuditReport,
  productionDeploymentIssues,
} from "../scripts/validate-production-deployment";

type ProductionDeploymentAuditInput = Parameters<typeof buildProductionDeploymentAuditReport>[0];

describe("production deployment manifest", () => {
  it("accepts a complete Railway production manifest", () => {
    const report = buildProductionDeploymentAuditReport(productionDeploymentInput());

    expect(report.status).toBe("admin control-plane production deployment audit passed");
    expect(report.services).toEqual([
      "api",
      "dashboard",
      "admin-gateway",
      "worker",
      "postgres",
      "redis",
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

  it("rejects missing service Dockerfiles when file existence is supplied", () => {
    const input = productionDeploymentInput({
      fileExists: () => false,
    });

    expect(productionDeploymentIssues(input)).toEqual(
      expect.arrayContaining(["service dockerfile infra/staging/Dockerfile.api must exist"]),
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
    },
    provider: "railway",
    releaseGates: [
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
          "GITHUB_WEBHOOK_SECRET",
          "HEIMDALL_ADMIN_ENABLED",
          "HEIMDALL_ADMIN_ROUTE_EXPOSURE",
          "HEIMDALL_ADMIN_IDENTITY_PROVIDER",
          "HEIMDALL_ADMIN_IDENTITY_ASSERTION_SECRET",
          "HEIMDALL_ADMIN_SESSION_SECRET",
          "HEIMDALL_ADMIN_ALLOWED_ORIGINS",
          "HEIMDALL_ADMIN_GITHUB_ORG",
          "WEB_URL",
        ],
        "infra/staging/Dockerfile.api",
      ),
      service("dashboard", ["VITE_HEIMDALL_API_BASE_URL"], "infra/staging/Dockerfile.web"),
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
      ),
      service("worker", ["DATABASE_URL", "REDIS_URL"], "infra/staging/Dockerfile.worker"),
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
      "smoke:control-plane:staging": "bun run scripts/control-plane-staging-smoke.ts",
    },
  };
}

/** Creates an alert fixture. */
function alert(id: string) {
  return { id, query: "query", severity: "critical" };
}

/** Creates a release-gate fixture. */
function gate(command: string) {
  return { command, name: command };
}

/** Creates a service fixture. */
function service(name: string, requiredEnv: readonly string[], dockerfile?: string) {
  return {
    ...(dockerfile ? { dockerfile } : {}),
    healthCheck: "/healthz",
    name,
    package: name,
    requiredEnv,
  };
}
