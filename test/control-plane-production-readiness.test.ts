import { describe, expect, it } from "vitest";
import { buildProductionReadinessReport } from "../scripts/control-plane-production-readiness";

type ProductionReadinessInput = Parameters<typeof buildProductionReadinessReport>[0];

describe("control-plane production readiness", () => {
  it("accepts complete staging evidence and runbook coverage", () => {
    const report = buildProductionReadinessReport(productionReadinessInput());

    expect(report.status).toBe("admin control-plane production readiness passed");
    expect(report.actor).toEqual({
      provider: "github_org",
      subject: "github_org:12345",
    });
    expect(report.gates.map((gate) => gate.name)).toEqual([
      "staging proof evidence",
      "production runbook coverage",
      "replay audit action names",
    ]);
  });

  it("rejects incomplete evidence", () => {
    const input = productionReadinessInput({
      evidence: {
        ...validEvidence(),
        auditLogIds: {
          dashboard: {
            login: "audit_dashboard_login",
            logout: "audit_dashboard_logout",
            settings: "audit_dashboard_settings",
          },
          manualDrill: {
            login: "audit_manual_login",
            logout: "audit_manual_logout",
            replay: "audit_manual_replay",
            settings: "audit_manual_settings",
          },
          smoke: {
            login: "audit_smoke_login",
            logout: "audit_smoke_logout",
          },
        },
      },
    });

    expect(() => buildProductionReadinessReport(input)).toThrow(
      /dashboard audit log ID replay is required/,
    );
  });

  it("rejects runbooks that use stale replay audit action names", () => {
    const input = productionReadinessInput({
      runbookText: validRunbookText().replace("webhook.requeue_jobs", "webhook.replay"),
    });

    expect(() => buildProductionReadinessReport(input)).toThrow(
      /runbook must include replay audit action webhook\.requeue_jobs/,
    );
    expect(() => buildProductionReadinessReport(input)).toThrow(
      /runbook must not use stale replay audit action webhook\.replay/,
    );
  });
});

/** Creates production-readiness input with optional overrides. */
function productionReadinessInput(
  overrides: Partial<ProductionReadinessInput> = {},
): ProductionReadinessInput {
  return {
    evidence: validEvidence(),
    evidenceFile: "docs/evidence/admin-control-plane-staging-proof.json",
    runbookFile: "docs/runbooks/admin-control-plane.md",
    runbookText: validRunbookText(),
    ...overrides,
  };
}

/** Creates a complete staging proof evidence fixture. */
function validEvidence(): ProductionReadinessInput["evidence"] {
  return {
    actor: {
      provider: "github_org",
      subject: "github_org:12345",
    },
    auditLogIds: {
      dashboard: {
        login: "audit_dashboard_login",
        logout: "audit_dashboard_logout",
        replay: "audit_dashboard_replay",
        settings: "audit_dashboard_settings",
      },
      manualDrill: {
        login: "audit_manual_login",
        logout: "audit_manual_logout",
        replay: "audit_manual_replay",
        settings: "audit_manual_settings",
      },
      smoke: {
        login: "audit_smoke_login",
        logout: "audit_smoke_logout",
      },
    },
    commands: [
      {
        exitCode: 0,
        name: "preflight",
      },
      {
        exitCode: 0,
        name: "smoke",
      },
      {
        exitCode: 0,
        name: "dashboard-e2e",
      },
    ],
    gatewayUrl: "https://idp-gateway.production.example.com",
    generatedAt: "2026-05-06T20:42:24.287Z",
    manualDrill: {
      steps: ["inspect", "plan_replay", "execute_replay", "update_settings", "verify_audit_log"],
    },
    rollbackNotes: "Disable admin routes and redeploy the previous API, dashboard, and gateway.",
    scope: {
      orgIds: ["org_production"],
      repoIds: ["repo_production"],
    },
    status: "control-plane staging proof passed",
  };
}

/** Creates runbook text that covers production-readiness requirements. */
function validRunbookText(): string {
  return [
    "## Production Deployment Decision",
    "## Production Rollout Plan",
    "### Acceptance Gates",
    "### Go/No-Go Criteria",
    "## Gateway Hardening Checklist",
    "## Secret Rotation Procedure",
    "## Monitoring and Rollback Checks",
    "### Emergency Disable Path",
    "### Rollback Checks",
    "webhook.requeue_jobs",
    "review.requeue",
    "publish.review",
  ].join("\n");
}
