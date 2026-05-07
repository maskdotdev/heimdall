import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareEvalReports,
  loadRegisteredEvalSuite,
  parseEvalCase,
  renderEvalComparisonMarkdown,
  renderEvalReportJUnit,
  renderEvalReportMarkdown,
  runEvaluation,
  writeEvalReportArtifacts,
} from "../src/index";

describe("evaluation harness", () => {
  it("loads the registered smoke suite and passes the MVP gate", async () => {
    const suite = await loadRegisteredEvalSuite("smoke-full-pipeline-v1");
    const report = runEvaluation({
      suite,
      timestamp: "2026-05-06T00:00:00.000Z",
    });

    expect(suite.cases.length).toBeGreaterThanOrEqual(10);
    expect(report.gate.status).toBe("pass");
    expect(report.metrics.weightedRecall).toBe(1);
    expect(report.metrics.publishedPrecision).toBe(1);
    expect(report.metrics.retrievalRecallAt10).toBe(1);
    expect(parseEvalCase(suite.cases[0]).caseId).toBe(suite.cases[0]?.caseId);
  });

  it("renders and writes CI-safe report artifacts", async () => {
    const suite = await loadRegisteredEvalSuite("smoke-full-pipeline-v1");
    const report = runEvaluation({
      suite,
      timestamp: "2026-05-06T00:00:00.000Z",
    });
    const outputDir = await mkdtemp(join(tmpdir(), "heimdall-eval-"));

    try {
      const artifacts = await writeEvalReportArtifacts(report, outputDir);
      const junit = await readFile(artifacts.junitPath, "utf8");
      const markdown = await readFile(artifacts.markdownPath, "utf8");
      const json = await readFile(artifacts.jsonPath, "utf8");

      expect(junit).toContain('<testsuite name="smoke-full-pipeline-v1"');
      expect(junit).toContain('classname="eval.gate"');
      expect(renderEvalReportJUnit(report)).not.toContain("ignore all previous instructions");
      expect(markdown).toContain("Evaluation: smoke-full-pipeline-v1");
      expect(markdown).toContain("Status: PASS");
      expect(renderEvalReportMarkdown(report)).not.toContain("ignore all previous instructions");
      expect(JSON.parse(json).schemaVersion).toBe("eval_report.v1");
    } finally {
      await rm(outputDir, { force: true, recursive: true });
    }
  });

  it("reports lost true positives during baseline comparison", async () => {
    const suite = await loadRegisteredEvalSuite("smoke-full-pipeline-v1");
    const baseline = runEvaluation({
      suite,
      timestamp: "2026-05-06T00:00:00.000Z",
    });
    const candidateSuite = {
      ...suite,
      cases: suite.cases.map((evalCase) =>
        evalCase.caseId === "case_ts_missing_await_001"
          ? { ...evalCase, actualFindings: [] }
          : evalCase,
      ),
    };
    const candidate = runEvaluation({
      suite: candidateSuite,
      timestamp: "2026-05-06T00:00:01.000Z",
    });
    const comparison = compareEvalReports(baseline, candidate);
    const markdown = renderEvalComparisonMarkdown(comparison);

    expect(comparison.status).toBe("fail");
    expect(comparison.regressedCaseIds).toContain("case_ts_missing_await_001");
    expect(comparison.lostTruePositives).toContain(
      "case_ts_missing_await_001:expected_missing_await",
    );
    expect(comparison.caseComparisons).toContainEqual(
      expect.objectContaining({
        caseId: "case_ts_missing_await_001",
        status: "regressed",
      }),
    );
    expect(markdown).toContain("Evaluation Comparison");
    expect(markdown).toContain("lost case_ts_missing_await_001:expected_missing_await");
  });
});
