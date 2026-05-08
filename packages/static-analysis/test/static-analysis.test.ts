import { validPullRequestSnapshotFixture } from "@repo/contracts/fixtures/pull-request.fixture";
import {
  OBSERVABILITY_METRIC_NAMES,
  OBSERVABILITY_SPAN_NAMES,
  type TelemetryAttributeValue,
  type TelemetryMetricRecorder,
  type TelemetrySpanRecorder,
} from "@repo/observability";
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

  it("records static-analysis telemetry without raw output or workspace paths", async () => {
    const metrics: RecordedMetric[] = [];
    const spans: RecordedSpan[] = [];

    const report = await runStaticAnalysis({
      metrics: createRecordingMetrics(metrics),
      request,
      runner: createFakeToolRunner([
        {
          durationMs: 19,
          executable: "eslint",
          stdout: JSON.stringify([
            {
              filePath: "/workspace/repo/src/math.ts",
              messages: [
                {
                  line: 2,
                  message: "raw diagnostic text",
                  ruleId: "no-undef",
                  severity: 2,
                },
              ],
            },
          ]),
        },
      ]),
      traces: createRecordingTraces(spans),
    });

    expect(report.summary.diagnosticCount).toBe(1);
    expect(metrics).toContainEqual({
      kind: "counter",
      labels: {
        mode: "changed_files_fast",
        operation: "run",
        reason: "review",
        status: "succeeded",
      },
      name: OBSERVABILITY_METRIC_NAMES.staticAnalysisRunsTotal,
      value: 1,
    });
    expect(metrics).toContainEqual({
      kind: "histogram",
      labels: {
        mode: "changed_files_fast",
        operation: "tool",
        status: "succeeded",
        tool: "eslint",
      },
      name: OBSERVABILITY_METRIC_NAMES.staticAnalysisDurationMs,
      unit: "ms",
      value: 19,
    });
    expect(metrics).toContainEqual({
      kind: "counter",
      labels: {
        mode: "changed_files_fast",
        operation: "run",
        reason: "review",
        status: "succeeded",
      },
      name: OBSERVABILITY_METRIC_NAMES.staticAnalysisDiagnosticsTotal,
      value: 1,
    });
    expect(spans.map((span) => span.name)).toEqual(
      expect.arrayContaining([
        OBSERVABILITY_SPAN_NAMES.staticAnalysisPlan,
        OBSERVABILITY_SPAN_NAMES.staticAnalysisRunTool,
        OBSERVABILITY_SPAN_NAMES.staticAnalysisParseOutput,
        OBSERVABILITY_SPAN_NAMES.staticAnalysisNormalizeDiagnostics,
      ]),
    );
    expect(spans).toContainEqual({
      endAttributes: expect.objectContaining({
        "static_analysis.diagnostic_count": 1,
        "static_analysis.parse_failure_count": 0,
      }),
      name: OBSERVABILITY_SPAN_NAMES.staticAnalysisParseOutput,
      startAttributes: expect.objectContaining({
        "static_analysis.tool": "eslint",
      }),
      status: "ok",
    });
    const serializedTelemetry = JSON.stringify({ metrics, spans });
    expect(serializedTelemetry).not.toContain("raw diagnostic text");
    expect(serializedTelemetry).not.toContain("/workspace/repo");
  });

  it("records static-analysis parse failures and timeouts", async () => {
    const metrics: RecordedMetric[] = [];

    const report = await runStaticAnalysis({
      metrics: createRecordingMetrics(metrics),
      request,
      runner: createFakeToolRunner([
        {
          executable: "eslint",
          status: "timed_out",
          stdout: "not-json",
        },
      ]),
    });

    expect(report.status).toBe("partially_succeeded");
    expect(metrics).toContainEqual({
      kind: "counter",
      labels: {
        mode: "changed_files_fast",
        operation: "tool",
        status: "timed_out",
        tool: "eslint",
      },
      name: OBSERVABILITY_METRIC_NAMES.staticAnalysisTimeoutsTotal,
      value: 1,
    });
    expect(metrics).toContainEqual({
      kind: "counter",
      labels: {
        mode: "changed_files_fast",
        reason: "tool_output_parse_failed",
        tool: "eslint",
      },
      name: OBSERVABILITY_METRIC_NAMES.staticAnalysisParseFailuresTotal,
      value: 1,
    });
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

  it("parses Biome JSON output into normalized diagnostics", () => {
    const parsed = parseToolOutputDiagnostics({
      maxDiagnostics: 10,
      result: {
        durationMs: 1,
        exitCode: 1,
        finishedAt: "2026-05-06T00:00:00.001Z",
        signal: null,
        startedAt: "2026-05-06T00:00:00.000Z",
        status: "failed",
        stderr: "",
        stderrBytes: 0,
        stdout: JSON.stringify({
          command: "check",
          diagnostics: [
            {
              category: "lint/correctness/noUnusedVariables",
              location: {
                end: { column: 13, line: 2 },
                path: "/workspace/repo/src/math.ts",
                start: { column: 7, line: 2 },
              },
              message: "This variable total is unused.",
              severity: "error",
            },
          ],
          summary: { errors: 1, warnings: 0 },
        }),
        stdoutBytes: 356,
        timedOut: false,
        truncated: false,
      },
      snapshot: validPullRequestSnapshotFixture,
      tool: "biome",
      toolRunId: "str_biome",
      workspacePath: "/workspace/repo",
    });

    expect(parsed.warnings).toEqual([]);
    expect(parsed.diagnostics).toHaveLength(1);
    expect(parsed.diagnostics[0]).toMatchObject({
      category: "correctness",
      isOnChangedLine: true,
      location: {
        endColumn: 13,
        endLine: 2,
        filePath: "src/math.ts",
        originalPath: "/workspace/repo/src/math.ts",
        startColumn: 7,
        startLine: 2,
      },
      metadata: { category: "lint/correctness/noUnusedVariables" },
      ruleId: "lint/correctness/noUnusedVariables",
      ruleName: "noUnusedVariables",
      severity: "error",
      sourceTrust: "tool_output",
      tool: "biome",
    });
  });

  it("parses TypeScript text output into normalized diagnostics", () => {
    const parsed = parseToolOutputDiagnostics({
      maxDiagnostics: 10,
      result: {
        durationMs: 1,
        exitCode: 2,
        finishedAt: "2026-05-06T00:00:00.001Z",
        signal: null,
        startedAt: "2026-05-06T00:00:00.000Z",
        status: "failed",
        stderr: "",
        stderrBytes: 0,
        stdout:
          "/workspace/repo/src/math.ts(2,10): error TS2322: Type 'string' is not assignable to type 'number'.",
        stdoutBytes: 101,
        timedOut: false,
        truncated: false,
      },
      snapshot: validPullRequestSnapshotFixture,
      tool: "typescript",
      toolRunId: "str_ts",
      workspacePath: "/workspace/repo",
    });

    expect(parsed.warnings).toEqual([]);
    expect(parsed.diagnostics).toHaveLength(1);
    expect(parsed.diagnostics[0]).toMatchObject({
      category: "correctness",
      isOnChangedLine: true,
      location: {
        filePath: "src/math.ts",
        originalPath: "/workspace/repo/src/math.ts",
        startColumn: 10,
        startLine: 2,
      },
      metadata: { diagnosticCode: "TS2322" },
      ruleId: "TS2322",
      severity: "error",
      sourceTrust: "parsed_text",
      tool: "typescript",
    });
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

/** Metric record captured by telemetry assertions. */
type RecordedMetric = {
  /** Metric instrument kind. */
  readonly kind: "counter" | "histogram";
  /** Metric labels attached to the record. */
  readonly labels?: Readonly<Record<string, TelemetryAttributeValue | undefined>> | undefined;
  /** Metric name. */
  readonly name: string;
  /** Metric unit. */
  readonly unit?: string | undefined;
  /** Metric value. */
  readonly value: number;
};

/** Span record captured by telemetry assertions. */
type RecordedSpan = {
  /** Span attributes captured when the span ended. */
  readonly endAttributes?:
    | Readonly<Record<string, TelemetryAttributeValue | undefined>>
    | undefined;
  /** Span name. */
  readonly name: string;
  /** Span attributes captured when the span started. */
  readonly startAttributes?:
    | Readonly<Record<string, TelemetryAttributeValue | undefined>>
    | undefined;
  /** Span status. */
  readonly status?: "error" | "ok" | "unset" | undefined;
};

/** Creates a metric recorder that stores metric records in memory. */
function createRecordingMetrics(records: RecordedMetric[]): TelemetryMetricRecorder {
  return {
    count: (name, options) => {
      records.push({
        kind: "counter",
        labels: options?.labels,
        name,
        unit: options?.unit,
        value: options?.value ?? 1,
      });
    },
    gauge: () => undefined,
    histogram: (name, value, options) => {
      records.push({
        kind: "histogram",
        labels: options?.labels,
        name,
        unit: options?.unit,
        value,
      });
    },
  };
}

/** Creates a span recorder that stores span records in memory. */
function createRecordingTraces(records: RecordedSpan[]): TelemetrySpanRecorder {
  return {
    startSpan: (name, options) => ({
      end: (endOptions = {}) => {
        records.push({
          endAttributes: endOptions.attributes,
          name,
          startAttributes: options?.attributes,
          status: endOptions.status,
        });
        return undefined;
      },
    }),
  };
}
