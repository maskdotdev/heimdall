import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** Main CI workflow file path. */
const CI_WORKFLOW_FILE = resolve(".github/workflows/ci.yml");

/** Scheduled eval history workflow file path. */
const EVAL_HISTORY_WORKFLOW_FILE = resolve(".github/workflows/evaluation-history.yml");

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

/** Review orchestrator integration test file path. */
const REVIEW_ORCHESTRATOR_INTEGRATION_TEST_FILE = resolve(
  "packages/review-orchestrator/test/review-orchestrator.integration.test.ts",
);

/** Checked-in deterministic eval baseline report used by CI comparison gates. */
const EVAL_BASELINE_REPORT_FILE =
  "packages/evaluation/fixtures/smoke-full-pipeline-v1-baseline-report.json";

/** Deterministic eval comparison report file that CI should preserve. */
const EVAL_COMPARISON_REPORT_PATH = ".tmp/eval-runs/smoke-full-pipeline-v1/comparison.md";

/** Deterministic evaluation report files that CI should preserve. */
const EVAL_REPORT_PATHS = [
  ".tmp/eval-runs/smoke-full-pipeline-v1/report.md",
  ".tmp/eval-runs/smoke-full-pipeline-v1/report.json",
  EVAL_COMPARISON_REPORT_PATH,
];

/** Scheduled evaluation history report files that should be retained. */
const SCHEDULED_EVAL_REPORT_PATHS = [
  ".tmp/eval-runs/smoke-full-pipeline-v1/report.md",
  ".tmp/eval-runs/smoke-full-pipeline-v1/report.html",
  ".tmp/eval-runs/smoke-full-pipeline-v1/report.json",
  ".tmp/eval-runs/smoke-full-pipeline-v1/report.junit.xml",
  EVAL_COMPARISON_REPORT_PATH,
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
    const baselineReport = readFileSync(resolve(EVAL_BASELINE_REPORT_FILE), "utf8");

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
    expect(packageJson).toContain("pnpm eval compare");
    expect(packageJson).toContain(`--baseline-report ${EVAL_BASELINE_REPORT_FILE}`);
    expect(packageJson).toContain(
      "--candidate-report .tmp/eval-runs/smoke-full-pipeline-v1/report.json",
    );
    expect(packageJson).toContain(`--output-file ${EVAL_COMPARISON_REPORT_PATH}`);
    expect(baselineReport).toContain('"schemaVersion": "eval_report.v1"');
    expect(baselineReport).toContain('"suiteId": "smoke-full-pipeline-v1"');
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

  it("keeps the fake PR end-to-end review path in the CI gate", () => {
    const workflow = readFileSync(CI_WORKFLOW_FILE, "utf8");
    const packageJson = readFileSync(PACKAGE_JSON_FILE, "utf8");
    const integrationTests = readFileSync(REVIEW_ORCHESTRATOR_INTEGRATION_TEST_FILE, "utf8");

    expect(workflow).toContain("HEIMDALL_DB_TEST_URL:");
    expect(workflow).toContain("pnpm ci:control-plane:release");
    expect(packageJson).toContain("pnpm test");
    expect(integrationTests).toContain("describe.runIf(integrationDatabaseUrl)");
    expect(integrationTests).toContain("runPullRequestReview");
    expect(integrationTests).toContain("gitProvider: fakeGitProvider");
    expect(integrationTests).toContain("createStaticLLMGateway");
    expect(integrationTests).toContain("syncWorkspace: async ()");
    expect(integrationTests).toContain(
      "persists a review run, findings, validation output, and publish job",
    );
    expect(integrationTests).toContain(
      "does not enqueue publish work when all findings are rejected",
    );
    expect(integrationTests).toContain("fetchPullRequestSnapshot");
  });

  it("keeps scheduled eval history persistence wired", () => {
    const workflow = readFileSync(EVAL_HISTORY_WORKFLOW_FILE, "utf8");

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("schedule:");
    expect(workflow).toContain('cron: "17 8 * * *"');
    expect(workflow).toContain("EVAL_HISTORY_DATABASE_URL:");
    expect(workflow).toContain("secrets.EVAL_HISTORY_DATABASE_URL");
    expect(workflow).toContain("pnpm eval:ci");
    expect(workflow).toContain("pnpm eval run");
    expect(workflow).toContain("--suite smoke-full-pipeline-v1");
    expect(workflow).toContain("--variant scheduled");
    expect(workflow).toContain("--no-live-models");
    expect(workflow).toContain('--database-url "$EVAL_HISTORY_DATABASE_URL"');
    expect(workflow).toContain("--triggered-by github-actions.schedule");
    expect(workflow).toContain("--history-environment scheduled-ci");
    expect(workflow).toContain('--git-commit "$GITHUB_SHA"');
    expect(workflow).toContain('--branch "$GITHUB_REF_NAME"');
    expect(workflow).toContain("pnpm eval compare");
    expect(workflow).toContain(`--baseline-report ${EVAL_BASELINE_REPORT_FILE}`);
    expect(workflow).toContain(
      "--candidate-report .tmp/eval-runs/smoke-full-pipeline-v1/report.json",
    );
    expect(workflow).toContain(`--output-file ${EVAL_COMPARISON_REPORT_PATH}`);
    expect(workflow).toContain("name: scheduled-smoke-full-pipeline-v1-eval-report");

    for (const reportPath of SCHEDULED_EVAL_REPORT_PATHS) {
      expect(workflow).toContain(reportPath);
    }
  });
});
