import { describe, expect, it } from "vitest";
import {
  buildProofRecord,
  parseManualDrillEvidence,
  validateProofRecord,
} from "../scripts/control-plane-staging-proof";

type ProofEnvironmentInput = Parameters<typeof buildProofRecord>[0];
type ProofCommandInput = Parameters<typeof buildProofRecord>[1][number];

describe("control-plane staging proof evidence", () => {
  it("summarizes matching actor, scope, gateway, and audit evidence", () => {
    const record = buildProofRecord(proofEnvironment(), proofCommands());

    validateProofRecord(record);

    expect(record.actor).toEqual({
      provider: "github_org",
      subject: "github_org:12345",
    });
    expect(record.gatewayUrl).toBe("https://idp-gateway.staging.example.com");
    expect(record.scope).toEqual({
      orgIds: ["org_staging"],
      repoIds: ["repo_staging"],
    });
    expect(record.auditLogIds.manualDrill).toEqual({
      login: "audit_manual_login",
      logout: "audit_manual_logout",
      replay: "audit_manual_replay",
      settings: "audit_manual_settings",
    });
  });

  it("rejects mismatched gateway and scope evidence", () => {
    const commands = proofCommands({
      dashboard: {
        gatewayUrl: "https://other-gateway.staging.example.com",
        orgIds: ["org_other"],
        repoIds: ["repo_other"],
      },
    });
    const record = buildProofRecord(proofEnvironment(), commands);

    expect(() => validateProofRecord(record)).toThrow(
      /proof gateway URL must match dashboard gateway URL/,
    );
    expect(() => validateProofRecord(record)).toThrow(
      /dashboard org scopes must include preflight org scope/,
    );
  });

  it("rejects manual drill evidence that does not match the dashboard actor", () => {
    const record = buildProofRecord(
      proofEnvironment({
        manualDrill: parseManualDrillEvidence(
          JSON.stringify({
            actor: "github_org:99999",
            auditLogIds: {
              login: "audit_manual_login",
              logout: "audit_manual_logout",
              replay: "audit_manual_replay",
              settings: "audit_manual_settings",
            },
            completedAt: "2026-05-06T18:30:00.000Z",
            notes: "Manual dashboard drill completed against staging.",
            steps: [
              "inspect",
              "plan_replay",
              "execute_replay",
              "update_settings",
              "verify_audit_log",
            ],
          }),
        ),
      }),
      proofCommands(),
    );

    expect(() => validateProofRecord(record)).toThrow(
      /manual drill actor must match dashboard proof actor/,
    );
  });
});

/** Creates proof runner environment input for tests. */
function proofEnvironment(overrides: Partial<ProofEnvironmentInput> = {}): ProofEnvironmentInput {
  return {
    evidenceFile: "/tmp/admin-control-plane-staging-proof.json",
    manualDrill: parseManualDrillEvidence(
      JSON.stringify({
        actor: "github_org:12345",
        auditLogIds: {
          login: "audit_manual_login",
          logout: "audit_manual_logout",
          replay: "audit_manual_replay",
          settings: "audit_manual_settings",
        },
        completedAt: "2026-05-06T18:30:00.000Z",
        notes: "Manual dashboard drill completed against staging.",
        steps: ["inspect", "plan_replay", "execute_replay", "update_settings", "verify_audit_log"],
      }),
    ),
    rollbackNotes: "Rollback by disabling admin routes and redeploying the previous revisions.",
    ...overrides,
  };
}

/** Creates proof command evidence input for tests. */
function proofCommands(overrides: ProofOutputOverrides = {}): readonly ProofCommandInput[] {
  return [
    {
      command: "bun run scripts/control-plane-staging-preflight.ts",
      durationMs: 100,
      exitCode: 0,
      name: "preflight",
      output: {
        apiUrl: "https://api.staging.example.com",
        gatewayUrl: "https://idp-gateway.staging.example.com",
        orgId: "org_staging",
        repoId: "repo_staging",
        status: "control-plane staging preflight passed",
        webUrl: "https://admin.staging.example.com",
        ...overrides.preflight,
      },
    },
    {
      command: "bun run scripts/control-plane-staging-smoke.ts",
      durationMs: 100,
      exitCode: 0,
      name: "smoke",
      output: {
        actor: "github_org:12345",
        auditLogIds: {
          login: "audit_smoke_login",
          logout: "audit_smoke_logout",
        },
        gatewayUrl: "https://idp-gateway.staging.example.com",
        orgId: "org_staging",
        repoId: "repo_staging",
        status: "control-plane staging smoke passed",
        ...overrides.smoke,
      },
    },
    {
      command: "bun run scripts/control-plane-dashboard-e2e.ts",
      durationMs: 100,
      exitCode: 0,
      name: "dashboard-e2e",
      output: {
        actor: "github_org:12345",
        auditLogIds: {
          login: "audit_dashboard_login",
          logout: "audit_dashboard_logout",
          replay: "audit_dashboard_replay",
          settings: "audit_dashboard_settings",
        },
        gatewayUrl: "https://idp-gateway.staging.example.com",
        orgIds: ["org_staging"],
        provider: "github_org",
        repoIds: ["repo_staging"],
        status: "control-plane dashboard E2E passed",
        ...overrides.dashboard,
      },
    },
  ];
}

/** Overrides for proof command JSON output in tests. */
type ProofOutputOverrides = {
  /** Dashboard E2E JSON output overrides. */
  readonly dashboard?: Readonly<Record<string, unknown>>;
  /** Preflight JSON output overrides. */
  readonly preflight?: Readonly<Record<string, unknown>>;
  /** Smoke JSON output overrides. */
  readonly smoke?: Readonly<Record<string, unknown>>;
};
