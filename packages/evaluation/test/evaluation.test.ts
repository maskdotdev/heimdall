import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildEvalHistoryWrite,
  compareEvalReports,
  createEvalHumanLabelFile,
  importEvalCaseIntoSuite,
  loadRegisteredEvalSuite,
  parseEvalCase,
  parseEvalCaseImportSource,
  parseEvalHumanFindingLabel,
  parseEvalHumanLabelFile,
  renderEvalComparisonMarkdown,
  renderEvalReportHtml,
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
      const html = await readFile(artifacts.htmlPath, "utf8");
      const junit = await readFile(artifacts.junitPath, "utf8");
      const markdown = await readFile(artifacts.markdownPath, "utf8");
      const json = await readFile(artifacts.jsonPath, "utf8");

      expect(html).toContain("<html");
      expect(html).toContain("Evaluation: smoke-full-pipeline-v1");
      expect(renderEvalReportHtml(report)).not.toContain("ignore all previous instructions");
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

  it("builds product-safe eval history rows for persistence", async () => {
    const suite = await loadRegisteredEvalSuite("smoke-full-pipeline-v1");
    const report = runEvaluation({
      suite,
      timestamp: "2026-05-06T00:00:00.000Z",
    });
    const history = buildEvalHistoryWrite({
      branch: "main",
      environment: "ci",
      gitCommitSha: "abc123",
      report,
      setAsActiveBaseline: true,
      suite,
      triggeredBy: "vitest",
    });

    expect(history.suite.evalSuiteId).toBe("smoke-full-pipeline-v1");
    expect(history.variant.evalVariantId).toBe("local");
    expect(history.run.evalRunId).toBe(report.evalRunId);
    expect(history.run.environment).toBe("ci");
    expect(history.cases).toHaveLength(suite.cases.length);
    expect(history.caseResults).toHaveLength(report.caseResults.length);
    expect(history.baseline).toMatchObject({
      active: true,
      baselineVariantId: "local",
      evalRunId: report.evalRunId,
    });
    expect(JSON.stringify(history)).not.toContain("The new branch can read session.expiresAt");
  });

  it("imports reviewed production eval drafts into suite fixtures", async () => {
    const suite = await loadRegisteredEvalSuite("smoke-full-pipeline-v1");
    const baseCase = suite.cases[0];
    if (!baseCase) {
      throw new Error("Smoke suite did not include a base case.");
    }
    const evalCase = {
      ...baseCase,
      caseId: "case_imported_review_regression",
      tags: ["production-import", "redacted"],
      title: "Imported review regression",
    };
    const draft = {
      schemaVersion: "admin_eval_import_draft.v1",
      evalCase,
    };
    const importedCase = parseEvalCaseImportSource(draft);
    const result = importEvalCaseIntoSuite({ evalCase: importedCase, suite });

    expect(importedCase.caseId).toBe("case_imported_review_regression");
    expect(result.inserted).toBe(true);
    expect(result.replaced).toBe(false);
    expect(result.caseCount).toBe(suite.cases.length + 1);
    expect(result.suite.cases.at(-1)?.caseId).toBe("case_imported_review_regression");
    expect(() => importEvalCaseIntoSuite({ evalCase: baseCase, suite })).toThrow(/already exists/u);
    expect(
      importEvalCaseIntoSuite({
        evalCase: { ...baseCase, title: "Reviewed replacement" },
        replaceExisting: true,
        suite,
      }).replaced,
    ).toBe(true);
  });

  it("validates portable human label files for import and export", async () => {
    const suite = await loadRegisteredEvalSuite("smoke-full-pipeline-v1");
    const label = {
      adjudicationStatus: "pending",
      createdAt: "2026-05-06T00:00:00.000Z",
      evalCaseId: "case_ts_missing_await_001",
      evalHumanLabelId: "eval_label_case_ts_missing_await_001_finding_1_reviewer_1",
      findingFingerprint: "finding_1",
      label: {
        anchorAppropriate: true,
        categoryAppropriate: true,
        correctness: "correct",
        evidenceAccurate: true,
        fixUseful: true,
        notes: "The finding points at the missing await and is actionable.",
        severityAppropriate: true,
        shouldPublish: true,
        usefulness: 5,
      },
      labelerUserId: "user_reviewer_1",
      updatedAt: "2026-05-06T00:00:00.000Z",
    } as const;
    const labelFile = createEvalHumanLabelFile({
      exportedAt: "2026-05-06T00:00:01.000Z",
      labels: [label],
      suiteId: suite.suiteId,
    });

    expect(parseEvalHumanFindingLabel(label.label).usefulness).toBe(5);
    expect(parseEvalHumanLabelFile(labelFile)).toMatchObject({
      schemaVersion: "eval_human_labels.v1",
      suiteId: "smoke-full-pipeline-v1",
    });
    expect(labelFile.labels[0]?.label.shouldPublish).toBe(true);
    expect(JSON.stringify(labelFile)).not.toContain("The new branch can read session.expiresAt");
    expect(() =>
      parseEvalHumanLabelFile({
        ...labelFile,
        labels: [
          {
            ...label,
            label: {
              ...label.label,
              usefulness: 6,
            },
          },
        ],
      }),
    ).toThrow(/EvalHumanLabelFile/u);
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
