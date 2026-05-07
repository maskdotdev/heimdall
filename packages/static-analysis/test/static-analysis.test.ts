import { validPullRequestSnapshotFixture } from "@repo/contracts/fixtures/pull-request.fixture";
import { createFakeToolRunner } from "@repo/tool-runner";
import { describe, expect, it } from "vitest";
import {
  createNormalizedToolDiagnostic,
  DEFAULT_STATIC_ANALYSIS_BUDGETS,
  planStaticAnalysis,
  runStaticAnalysis,
  type StaticAnalysisRequest,
} from "../src/index";

const request = {
  schemaVersion: "static_analysis_request.v1",
  orgId: "org_1",
  repoId: validPullRequestSnapshotFixture.repoId,
  reviewRunId: "rrn_01HREVIEW",
  snapshot: validPullRequestSnapshotFixture,
  workspace: {
    workspaceId: "ws_1",
    path: "/workspace/repo",
    commitSha: validPullRequestSnapshotFixture.headSha,
    isTrusted: true,
  },
  mode: "changed_files_fast",
  reason: "review",
  budgets: { ...DEFAULT_STATIC_ANALYSIS_BUDGETS, maxToolRuns: 1 },
  createdAt: "2026-05-06T00:00:00.000Z",
} satisfies StaticAnalysisRequest;

describe("static analysis", () => {
  it("plans bounded changed-file tool runs", () => {
    const plan = planStaticAnalysis(request);

    expect(plan.toolRuns).toHaveLength(1);
    expect(plan.toolRuns[0]).toMatchObject({
      allowFailure: true,
      scope: { kind: "changed_files", paths: ["src/math.ts"] },
    });
    expect(plan.warnings).toEqual([expect.objectContaining({ code: "tool_run_budget_truncated" })]);
  });

  it("maps diagnostics to changed lines", () => {
    const diagnostic = createNormalizedToolDiagnostic({
      location: { filePath: "src/math.ts", startLine: 2 },
      message: "Unexpected number coercion.",
      ruleId: "no-unsafe-number",
      snapshot: validPullRequestSnapshotFixture,
      tool: "eslint",
      toolRunId: "str_1",
    });

    expect(diagnostic).toMatchObject({
      isInChangedFile: true,
      isOnChangedLine: true,
      ruleId: "no-unsafe-number",
    });
  });

  it("builds a deterministic report from fake runner output", async () => {
    const report = await runStaticAnalysis({
      request,
      runner: createFakeToolRunner([{ executable: "eslint", stdout: "[]" }]),
      diagnosticsByTool: {
        eslint: [
          {
            location: { filePath: "src/math.ts", startLine: 2 },
            message: "Unexpected number coercion.",
            ruleId: "no-unsafe-number",
            snapshot: validPullRequestSnapshotFixture,
            tool: "eslint",
            toolRunId: "ignored_by_builder",
          },
        ],
      },
    });

    expect(report).toMatchObject({
      repoId: validPullRequestSnapshotFixture.repoId,
      schemaVersion: "static_analysis_report.v1",
      status: "succeeded",
      summary: {
        diagnosticCount: 1,
        succeededToolRunCount: 1,
        toolRunCount: 1,
      },
    });
    expect(report.diagnostics[0]?.toolRunId).toBe(report.toolRuns[0]?.toolRunId);
  });
});
