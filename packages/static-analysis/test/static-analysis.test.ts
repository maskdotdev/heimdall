import { validPullRequestSnapshotFixture } from "@repo/contracts/fixtures/pull-request.fixture";
import { createFakeToolRunner } from "@repo/tool-runner";
import { describe, expect, it } from "vitest";
import {
  createNormalizedToolDiagnostic,
  DEFAULT_STATIC_ANALYSIS_BUDGETS,
  parseToolOutputDiagnostics,
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

  it("parses ESLint JSON output into normalized report diagnostics", async () => {
    const report = await runStaticAnalysis({
      request,
      runner: createFakeToolRunner([
        {
          executable: "eslint",
          stdout: JSON.stringify([
            {
              filePath: "/workspace/repo/src/math.ts",
              messages: [
                {
                  column: 10,
                  endColumn: 11,
                  endLine: 2,
                  line: 2,
                  message: "'total' is not defined.",
                  ruleId: "no-undef",
                  severity: 2,
                },
              ],
            },
          ]),
        },
      ]),
    });

    expect(report.summary).toMatchObject({
      changedLineDiagnosticCount: 1,
      diagnosticCount: 1,
    });
    expect(report.diagnostics[0]).toMatchObject({
      category: "correctness",
      isOnChangedLine: true,
      location: {
        filePath: "src/math.ts",
        originalPath: "/workspace/repo/src/math.ts",
        startColumn: 10,
        startLine: 2,
      },
      ruleId: "no-undef",
      ruleUrl: "https://eslint.org/docs/latest/rules/no-undef",
      severity: "error",
      sourceTrust: "tool_output",
    });
    expect(report.toolRuns[0]?.diagnosticCount).toBe(1);
  });

  it("returns product-safe warnings for invalid ESLint JSON output", () => {
    const parsed = parseToolOutputDiagnostics({
      maxDiagnostics: 10,
      result: {
        durationMs: 1,
        exitCode: 0,
        finishedAt: "2026-05-06T00:00:00.001Z",
        signal: null,
        startedAt: "2026-05-06T00:00:00.000Z",
        status: "succeeded",
        stderr: "",
        stderrBytes: 0,
        stdout: "not-json",
        stdoutBytes: 8,
        timedOut: false,
        truncated: false,
      },
      snapshot: validPullRequestSnapshotFixture,
      tool: "eslint",
      toolRunId: "str_1",
      workspacePath: "/workspace/repo",
    });

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.warnings).toEqual([
      expect.objectContaining({
        code: "tool_output_parse_failed",
        details: expect.objectContaining({ format: "eslint_json", tool: "eslint" }),
      }),
    ]);
  });
});
