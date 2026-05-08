import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** Main CI workflow file path. */
const CI_WORKFLOW_FILE = resolve(".github/workflows/ci.yml");

/** Root package manifest file path. */
const PACKAGE_JSON_FILE = resolve("package.json");

/** Turbo configuration file path. */
const TURBO_CONFIG_FILE = resolve("turbo.json");

/** API integration test file path. */
const API_TEST_FILE = resolve("apps/api/src/app.test.ts");

/** Security package test file path. */
const SECURITY_TEST_FILE = resolve("packages/security/test/index.test.ts");

/** Admin tools debug bundle test file path. */
const ADMIN_TOOLS_DEBUG_BUNDLE_TEST_FILE = resolve(
  "packages/admin-tools/test/debug-bundle.test.ts",
);

/** Observability package test file path. */
const OBSERVABILITY_TEST_FILE = resolve("packages/observability/test/index.test.ts");

/** Deterministic evaluation report files that CI should preserve. */
const EVAL_REPORT_PATHS = [
  ".tmp/eval-runs/smoke-full-pipeline-v1/report.md",
  ".tmp/eval-runs/smoke-full-pipeline-v1/report.json",
];

/** Representative cross-tenant API tests that the release gate must keep running. */
const CROSS_TENANT_API_TESTS = [
  "blocks cross-tenant product artifact routes before reading artifact data",
  "blocks cross-tenant debug bundle export before creating an export",
  "blocks cross-tenant eval import drafts before creating a draft",
  "blocks cross-tenant retrieval replay dry-runs before replaying retrieval",
  "blocks cross-tenant validation replay dry-runs before replaying validation",
  "blocks cross-tenant memory and rules inspection",
  "blocks cross-tenant background job replay plans before replaying jobs",
];

describe("CI workflow", () => {
  it("runs release gates and uploads deterministic eval reports", () => {
    const workflow = readFileSync(CI_WORKFLOW_FILE, "utf8");
    const packageJson = readFileSync(PACKAGE_JSON_FILE, "utf8");
    const turboConfig = readFileSync(TURBO_CONFIG_FILE, "utf8");

    expect(workflow).toContain("pnpm ci:control-plane:release");
    expect(packageJson).toContain(
      '"ci:control-plane:release": ' +
        '"pnpm audit:control-plane:deployment && pnpm readiness:control-plane:production && ' +
        'pnpm check && pnpm build"',
    );
    expect(packageJson).toContain(
      '"check": "pnpm typecheck && pnpm lint && pnpm test && pnpm eval:ci && ' +
        'pnpm boundaries:check"',
    );
    expect(workflow).toContain("image: pgvector/pgvector:pg17");
    expect(workflow).toContain("HEIMDALL_DB_TEST_URL:");
    expect(turboConfig).toContain('"HEIMDALL_DB_TEST_URL"');
    expect(workflow).toContain("actions/upload-artifact@v4");
    expect(workflow).toContain("name: smoke-full-pipeline-v1-eval-report");
    expect(workflow).toContain("if: always()");

    for (const reportPath of EVAL_REPORT_PATHS) {
      expect(workflow).toContain(reportPath);
    }
  });

  it("keeps security redaction and cross-tenant tests in the CI gate", () => {
    const workflow = readFileSync(CI_WORKFLOW_FILE, "utf8");
    const packageJson = readFileSync(PACKAGE_JSON_FILE, "utf8");
    const apiTests = readFileSync(API_TEST_FILE, "utf8");
    const securityTests = readFileSync(SECURITY_TEST_FILE, "utf8");
    const adminToolsTests = readFileSync(ADMIN_TOOLS_DEBUG_BUNDLE_TEST_FILE, "utf8");
    const observabilityTests = readFileSync(OBSERVABILITY_TEST_FILE, "utf8");

    expect(workflow).toContain("pnpm ci:control-plane:release");
    expect(packageJson).toContain("pnpm check");
    expect(packageJson).toContain("pnpm test");

    for (const apiTest of CROSS_TENANT_API_TESTS) {
      expect(apiTests).toContain(apiTest);
    }

    expect(securityTests).toContain("redacts secret patterns before prompt and log use");
    expect(adminToolsTests).toContain("redactDebugBundleValue");
    expect(observabilityTests).toContain(
      "redacts Phase 25 secret and source-code regression fixtures",
    );
  });
});
