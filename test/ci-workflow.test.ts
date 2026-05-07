import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** Main CI workflow file path. */
const CI_WORKFLOW_FILE = resolve(".github/workflows/ci.yml");

/** Turbo configuration file path. */
const TURBO_CONFIG_FILE = resolve("turbo.json");

/** Deterministic evaluation report files that CI should preserve. */
const EVAL_REPORT_PATHS = [
  ".tmp/eval-runs/smoke-full-pipeline-v1/report.md",
  ".tmp/eval-runs/smoke-full-pipeline-v1/report.json",
];

describe("CI workflow", () => {
  it("runs release gates and uploads deterministic eval reports", () => {
    const workflow = readFileSync(CI_WORKFLOW_FILE, "utf8");
    const turboConfig = readFileSync(TURBO_CONFIG_FILE, "utf8");

    expect(workflow).toContain("pnpm ci:control-plane:release");
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
});
