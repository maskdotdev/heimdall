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

  it("accepts supplied sandbox staging proof evidence", () => {
    const report = buildProductionReadinessReport(
      productionReadinessInput({
        sandboxEvidence: validSandboxEvidence(),
        sandboxEvidenceFile: "docs/evidence/sandbox-staging-proof.json",
      }),
    );

    expect(report.sandboxEvidenceFile).toBe("docs/evidence/sandbox-staging-proof.json");
    expect(report.sandboxEvidenceGeneratedAt).toBe("2026-05-08T21:15:00.000Z");
    expect(report.gates.map((gate) => gate.name)).toEqual([
      "staging proof evidence",
      "production runbook coverage",
      "replay audit action names",
      "sandbox staging proof evidence",
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

  it("rejects invalid sandbox staging proof evidence when supplied", () => {
    const input = productionReadinessInput({
      sandboxEvidence: {
        ...validSandboxEvidence(),
        sandboxRuns: [
          {
            ...validSandboxRunEvidence(),
            artifacts: [
              {
                ...validSandboxArtifactEvidence(),
                truncated: true,
              },
            ],
            policyDecisionCounts: {
              allowed: 4,
              denied: 1,
              warning: 0,
            },
            runnerKind: "local_process",
            stdoutTruncated: true,
          },
        ],
      },
      sandboxEvidenceFile: "docs/evidence/sandbox-staging-proof.json",
    });

    expect(() => buildProductionReadinessReport(input)).toThrow(
      /sandbox proof run sandbox_run_staging must not use local_process runner/,
    );
    expect(() => buildProductionReadinessReport(input)).toThrow(
      /sandbox proof run sandbox_run_staging must have zero denied policy decisions/,
    );
    expect(() => buildProductionReadinessReport(input)).toThrow(
      /sandbox proof run sandbox_run_staging stdout must not be truncated/,
    );
    expect(() => buildProductionReadinessReport(input)).toThrow(
      /sandbox proof run sandbox_run_staging artifact ruff\.json must not be truncated/,
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

/** Creates a complete sandbox staging proof evidence fixture. */
function validSandboxEvidence(): NonNullable<ProductionReadinessInput["sandboxEvidence"]> {
  return {
    actor: {
      subject: "github_org:12345",
    },
    apiUrl: "https://api.staging.example.com",
    gatewayUrl: "https://idp-gateway.staging.example.com",
    generatedAt: "2026-05-08T21:15:00.000Z",
    query: {
      limit: 10,
      status: "succeeded",
    },
    sandboxRuns: [validSandboxRunEvidence()],
    scope: {
      orgId: "org_staging",
      repoId: "repo_staging",
      reviewRunId: "review_run_staging",
    },
    status: "sandbox staging proof passed",
  };
}

/** Creates one sandbox run proof fixture. */
function validSandboxRunEvidence(): NonNullable<ProductionReadinessInput["sandboxEvidence"]> {
  return {
    artifacts: [validSandboxArtifactEvidence()],
    category: "static_analysis",
    createdAt: "2026-05-08T21:00:00.000Z",
    exitCode: 0,
    finishedAt: "2026-05-08T21:00:02.000Z",
    image: "ghcr.io/heimdall/reviewer-tools-python:2026-05-08",
    orgId: "org_staging",
    policyDecisionCounts: {
      allowed: 6,
      denied: 0,
      warning: 0,
    },
    repoId: "repo_staging",
    requestId: "sandbox_request_staging",
    reviewRunId: "review_run_staging",
    runnerKind: "docker",
    sandboxRunId: "sandbox_run_staging",
    startedAt: "2026-05-08T21:00:01.000Z",
    status: "succeeded",
    stderrTruncated: false,
    stdoutTruncated: false,
    trustLevel: "untrusted",
  };
}

/** Creates one sandbox artifact proof fixture. */
function validSandboxArtifactEvidence(): NonNullable<ProductionReadinessInput["sandboxEvidence"]> {
  return {
    createdAt: "2026-05-08T21:00:02.000Z",
    name: "ruff.json",
    sandboxArtifactId: "sandbox_artifact_staging",
    sha256: "0".repeat(64),
    sizeBytes: 512,
    truncated: false,
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
    "### Post-Release Monitoring and Follow-Up Tracking",
    "### Emergency Disable Path",
    "### Rollback Checks",
    "webhook.requeue_jobs",
    "review.requeue",
    "publish.review",
    "pnpm proof:control-plane:staging",
    "pnpm proof:sandbox:staging",
  ].join("\n");
}
