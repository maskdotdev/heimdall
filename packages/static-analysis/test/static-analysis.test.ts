import type { ChangedFile, PullRequestSnapshot } from "@repo/contracts";
import {
  validChangedFileFixture,
  validDiffHunkFixture,
  validPullRequestSnapshotFixture,
} from "@repo/contracts/fixtures/pull-request.fixture";
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
  compareStaticAnalysisDiagnosticBaselines,
  createNormalizedToolDiagnostic,
  DEFAULT_STATIC_ANALYSIS_BUDGETS,
  parseToolOutputDiagnostics,
  planStaticAnalysis,
  runStaticAnalysis,
  STATIC_ANALYSIS_RAW_OUTPUT_POLICY,
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

const pythonChangedFile = {
  ...validChangedFileFixture,
  language: "python",
  path: "src/app.py",
  patch: "@@ -1,3 +1,5 @@",
  hunks: [
    {
      ...validDiffHunkFixture,
      lines: [
        {
          kind: "context",
          content: "import os",
          oldLine: 1,
          newLine: 1,
        },
        {
          kind: "addition",
          content: "print(os.getcwd())",
          newLine: 2,
        },
      ],
    },
  ],
} satisfies ChangedFile;

const pythonConfigChangedFile = {
  ...validChangedFileFixture,
  language: "unknown",
  path: "pyproject.toml",
  patch: "@@ -1,2 +1,3 @@",
  hunks: [
    {
      ...validDiffHunkFixture,
      lines: [
        {
          kind: "addition",
          content: "[tool.ruff]",
          newLine: 1,
        },
      ],
    },
  ],
} satisfies ChangedFile;

const pythonPullRequestSnapshotFixture = {
  ...validPullRequestSnapshotFixture,
  changedFiles: [pythonChangedFile],
  changedFileCount: 1,
} satisfies PullRequestSnapshot;

const pythonRequest = {
  ...request,
  snapshot: pythonPullRequestSnapshotFixture,
} satisfies StaticAnalysisRequest;

const goChangedFile = {
  ...validChangedFileFixture,
  language: "go",
  path: "pkg/foo.go",
  patch: "@@ -8,3 +8,5 @@",
  hunks: [
    {
      ...validDiffHunkFixture,
      lines: [
        {
          kind: "context",
          content: "func main() {",
          oldLine: 9,
          newLine: 9,
        },
        {
          kind: "addition",
          content: 'fmt.Printf("%s")',
          newLine: 10,
        },
      ],
    },
  ],
} satisfies ChangedFile;

const goPullRequestSnapshotFixture = {
  ...validPullRequestSnapshotFixture,
  changedFiles: [goChangedFile],
  changedFileCount: 1,
} satisfies PullRequestSnapshot;

const goRequest = {
  ...request,
  snapshot: goPullRequestSnapshotFixture,
} satisfies StaticAnalysisRequest;

const rustChangedFile = {
  ...validChangedFileFixture,
  language: "rust",
  path: "src/lib.rs",
  patch: "@@ -1,3 +1,5 @@",
  hunks: [
    {
      ...validDiffHunkFixture,
      lines: [
        {
          kind: "context",
          content: "pub fn compute() -> i32 {",
          oldLine: 2,
          newLine: 2,
        },
        {
          kind: "addition",
          content: "let value = 1;",
          newLine: 3,
        },
      ],
    },
  ],
} satisfies ChangedFile;

const rustPullRequestSnapshotFixture = {
  ...validPullRequestSnapshotFixture,
  changedFiles: [rustChangedFile],
  changedFileCount: 1,
} satisfies PullRequestSnapshot;

const rustRequest = {
  ...request,
  snapshot: rustPullRequestSnapshotFixture,
} satisfies StaticAnalysisRequest;

describe("static analysis", () => {
  it("plans bounded changed-file tool runs", () => {
    const plan = planStaticAnalysis(request);

    expect(plan.toolRuns).toHaveLength(1);
    expect(plan.toolRuns[0]).toMatchObject({
      adapterVersion: "static-analysis.command-adapter.v1",
      allowFailure: true,
      command: {
        args: ["--format", "json", "src/math.ts"],
        displayCommand: "eslint --format json src/math.ts",
        executable: "eslint",
      },
      scope: { kind: "changed_files", paths: ["src/math.ts"] },
    });
    expect(plan.warnings).toEqual([expect.objectContaining({ code: "tool_run_budget_truncated" })]);
  });

  it("warns when a pull request changes static-analysis configuration", () => {
    const plan = planStaticAnalysis({
      ...pythonRequest,
      snapshot: {
        ...pythonPullRequestSnapshotFixture,
        changedFileCount: 2,
        changedFiles: [pythonChangedFile, pythonConfigChangedFile],
      },
    });

    expect(plan.warnings).toContainEqual(
      expect.objectContaining({
        code: "static_analysis_config_changed",
        details: {
          affectedTools: ["mypy", "pyright", "ruff"],
          changedConfigCount: 1,
          changedConfigPaths: ["pyproject.toml"],
        },
      }),
    );
  });

  it("plans runnable commands for supported local tools", () => {
    const biomePlan = planStaticAnalysis({ ...request, requestedTools: ["biome"] });
    const mypyPlan = planStaticAnalysis({ ...pythonRequest, requestedTools: ["mypy"] });
    const pyrightPlan = planStaticAnalysis({ ...pythonRequest, requestedTools: ["pyright"] });
    const ruffPlan = planStaticAnalysis({ ...pythonRequest, requestedTools: ["ruff"] });
    const semgrepPlan = planStaticAnalysis({ ...request, requestedTools: ["semgrep"] });
    const typeScriptPlan = planStaticAnalysis({ ...request, requestedTools: ["typescript"] });
    const goVetPlan = planStaticAnalysis({ ...goRequest, requestedTools: ["go_vet"] });
    const staticcheckPlan = planStaticAnalysis({ ...goRequest, requestedTools: ["staticcheck"] });
    const cargoCheckPlan = planStaticAnalysis({ ...rustRequest, requestedTools: ["cargo_check"] });
    const cargoClippyPlan = planStaticAnalysis({
      ...rustRequest,
      requestedTools: ["cargo_clippy"],
    });

    expect(biomePlan.toolRuns[0]?.command).toMatchObject({
      args: ["check", "--reporter=json", "src/math.ts"],
      displayCommand: "biome check --reporter=json src/math.ts",
      executable: "biome",
    });
    expect(mypyPlan.toolRuns[0]?.command).toMatchObject({
      args: [
        "--show-column-numbers",
        "--show-error-end",
        "--show-error-codes",
        "--no-error-summary",
        "--no-color-output",
        "src/app.py",
      ],
      displayCommand:
        "mypy --show-column-numbers --show-error-end --show-error-codes --no-error-summary --no-color-output src/app.py",
      executable: "mypy",
    });
    expect(pyrightPlan.toolRuns[0]?.command).toMatchObject({
      args: ["--outputjson", "src/app.py"],
      displayCommand: "pyright --outputjson src/app.py",
      executable: "pyright",
    });
    expect(ruffPlan.toolRuns[0]?.command).toMatchObject({
      args: ["check", "--output-format", "json", "src/app.py"],
      displayCommand: "ruff check --output-format json src/app.py",
      executable: "ruff",
    });
    expect(semgrepPlan.toolRuns[0]?.command).toMatchObject({
      args: ["scan", "--json", "--metrics=off", "--config=auto", "src/math.ts"],
      displayCommand: "semgrep scan --json --metrics=off --config=auto src/math.ts",
      executable: "semgrep",
      networkPolicy: "metadata_only",
    });
    expect(typeScriptPlan.toolRuns[0]?.command).toMatchObject({
      args: ["--noEmit", "--pretty", "false"],
      displayCommand: "tsc --noEmit --pretty false",
      executable: "tsc",
    });
    expect(goVetPlan.toolRuns[0]?.command).toMatchObject({
      args: ["vet", "-json", "./..."],
      displayCommand: "go vet -json ./...",
      env: { GOCACHE: "/tmp/heimdall-go-cache" },
      executable: "go",
    });
    expect(staticcheckPlan.toolRuns[0]?.command).toMatchObject({
      args: ["-f", "json", "./..."],
      displayCommand: "staticcheck -f json ./...",
      env: { GOCACHE: "/tmp/heimdall-go-cache" },
      executable: "staticcheck",
    });
    expect(cargoCheckPlan.toolRuns[0]?.command).toMatchObject({
      args: ["check", "--message-format=json", "--all-targets", "--locked"],
      displayCommand: "cargo check --message-format=json --all-targets --locked",
      env: { CARGO_TARGET_DIR: "/tmp/heimdall-cargo-target" },
      executable: "cargo",
    });
    expect(cargoClippyPlan.toolRuns[0]?.command).toMatchObject({
      args: ["clippy", "--message-format=json", "--all-targets", "--locked"],
      displayCommand: "cargo clippy --message-format=json --all-targets --locked",
      env: { CARGO_TARGET_DIR: "/tmp/heimdall-cargo-target" },
      executable: "cargo",
    });
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

  it("compares base and head diagnostics by stable fingerprint", () => {
    const baseExistingDiagnostic = createNormalizedToolDiagnostic({
      location: { filePath: "src/math.ts", startLine: 2 },
      message: "Unexpected number coercion.",
      ruleId: "no-unsafe-number",
      snapshot: validPullRequestSnapshotFixture,
      tool: "eslint",
      toolRunId: "str_base_existing",
    });
    const baseFixedDiagnostic = createNormalizedToolDiagnostic({
      location: { filePath: "src/math.ts", startLine: 1 },
      message: "Unused temporary value.",
      ruleId: "no-unused-vars",
      snapshot: validPullRequestSnapshotFixture,
      tool: "eslint",
      toolRunId: "str_base_fixed",
    });
    const headExistingDiagnostic = createNormalizedToolDiagnostic({
      location: { filePath: "src/math.ts", startLine: 2 },
      message: "Unexpected number coercion.",
      ruleId: "no-unsafe-number",
      snapshot: validPullRequestSnapshotFixture,
      tool: "eslint",
      toolRunId: "str_head_existing",
    });
    const headNewDiagnostic = createNormalizedToolDiagnostic({
      location: { filePath: "src/math.ts", startLine: 2 },
      message: "'total' is not defined.",
      ruleId: "no-undef",
      snapshot: validPullRequestSnapshotFixture,
      tool: "eslint",
      toolRunId: "str_head_new",
    });

    const comparison = compareStaticAnalysisDiagnosticBaselines({
      baseDiagnostics: [baseExistingDiagnostic, baseFixedDiagnostic],
      headDiagnostics: [headExistingDiagnostic, headNewDiagnostic],
      includeFixedDiagnostics: true,
    });

    expect(comparison.summary).toEqual({
      baseDiagnosticCount: 2,
      existingDiagnosticCount: 1,
      fixedDiagnosticCount: 1,
      headDiagnosticCount: 2,
      newDiagnosticCount: 1,
    });
    expect(
      comparison.diagnostics.map((diagnostic) => ({
        baselineStatus: diagnostic.baselineStatus,
        introducedByPr: diagnostic.introducedByPr,
        ruleId: diagnostic.ruleId,
      })),
    ).toEqual([
      { baselineStatus: "existing", introducedByPr: false, ruleId: "no-unsafe-number" },
      { baselineStatus: "new", introducedByPr: true, ruleId: "no-undef" },
      { baselineStatus: "fixed", introducedByPr: false, ruleId: "no-unused-vars" },
    ]);
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
      rawOutputPolicy: {
        schemaVersion: "static_analysis_raw_output_policy.v1",
        storesRawStderr: false,
        storesRawStdout: false,
      },
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
    expect(report.rawOutputPolicy).toEqual(STATIC_ANALYSIS_RAW_OUTPUT_POLICY);
  });

  it("classifies report diagnostics against optional baseline diagnostics", async () => {
    const baselineDiagnostic = createNormalizedToolDiagnostic({
      location: { filePath: "src/math.ts", startLine: 2 },
      message: "Unexpected number coercion.",
      ruleId: "no-unsafe-number",
      snapshot: validPullRequestSnapshotFixture,
      tool: "eslint",
      toolRunId: "str_base",
    });

    const report = await runStaticAnalysis({
      baselineDiagnosticsByTool: {
        eslint: [baselineDiagnostic],
      },
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
            toolRunId: "ignored_existing",
          },
          {
            location: { filePath: "src/math.ts", startLine: 2 },
            message: "'total' is not defined.",
            ruleId: "no-undef",
            snapshot: validPullRequestSnapshotFixture,
            tool: "eslint",
            toolRunId: "ignored_new",
          },
        ],
      },
    });

    expect(report.summary).toMatchObject({
      diagnosticCount: 2,
      newDiagnosticCount: 1,
    });
    expect(
      report.diagnostics.map((diagnostic) => ({
        baselineStatus: diagnostic.baselineStatus,
        introducedByPr: diagnostic.introducedByPr,
        ruleId: diagnostic.ruleId,
      })),
    ).toEqual([
      { baselineStatus: "existing", introducedByPr: false, ruleId: "no-unsafe-number" },
      { baselineStatus: "new", introducedByPr: true, ruleId: "no-undef" },
    ]);
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
                  rawOnlyField: "raw stdout field not retained",
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
    expect(report.rawOutputPolicy.storesRawStderr).toBe(false);
    expect(report.rawOutputPolicy.storesRawStdout).toBe(false);
    expect(JSON.stringify(report)).not.toContain("raw stdout field not retained");
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

  it("parses mypy text output into normalized diagnostics", () => {
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
        stdout:
          '/workspace/repo/src/app.py:2:6:2:10: error: Incompatible types in assignment (expression has type "str", variable has type "int")  [assignment]',
        stdoutBytes: 142,
        timedOut: false,
        truncated: false,
      },
      snapshot: pythonPullRequestSnapshotFixture,
      tool: "mypy",
      toolRunId: "str_mypy",
      workspacePath: "/workspace/repo",
    });

    expect(parsed.warnings).toEqual([]);
    expect(parsed.diagnostics).toHaveLength(1);
    expect(parsed.diagnostics[0]).toMatchObject({
      category: "correctness",
      isOnChangedLine: true,
      location: {
        endColumn: 11,
        endLine: 2,
        filePath: "src/app.py",
        originalPath: "/workspace/repo/src/app.py",
        startColumn: 7,
        startLine: 2,
      },
      metadata: { errorCode: "assignment" },
      ruleId: "assignment",
      ruleName: "assignment",
      severity: "error",
      sourceTrust: "parsed_text",
      tool: "mypy",
    });
  });

  it("parses Semgrep JSON output into normalized diagnostics", () => {
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
          errors: [],
          results: [
            {
              check_id: "python.lang.security.audit.subprocess-shell-true",
              end: { col: 23, line: 2, offset: 42 },
              extra: {
                message: "Avoid invoking subprocess with shell=True.",
                severity: "ERROR",
              },
              path: "/workspace/repo/src/app.py",
              start: { col: 7, line: 2, offset: 26 },
            },
          ],
          version: "1.120.0",
        }),
        stdoutBytes: 320,
        timedOut: false,
        truncated: false,
      },
      snapshot: pythonPullRequestSnapshotFixture,
      tool: "semgrep",
      toolRunId: "str_semgrep",
      workspacePath: "/workspace/repo",
    });

    expect(parsed.warnings).toEqual([]);
    expect(parsed.diagnostics).toHaveLength(1);
    expect(parsed.diagnostics[0]).toMatchObject({
      category: "security",
      isOnChangedLine: true,
      location: {
        endColumn: 23,
        endLine: 2,
        filePath: "src/app.py",
        originalPath: "/workspace/repo/src/app.py",
        startColumn: 7,
        startLine: 2,
      },
      metadata: {
        checkId: "python.lang.security.audit.subprocess-shell-true",
        severity: "ERROR",
      },
      ruleId: "python.lang.security.audit.subprocess-shell-true",
      ruleName: "subprocess-shell-true",
      severity: "error",
      sourceTrust: "tool_output",
      tool: "semgrep",
    });
  });

  it("parses Go vet JSON output into normalized diagnostics", () => {
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
          "example.com/repo": {
            printf: [
              {
                category: "printf",
                end: "/workspace/repo/pkg/foo.go:10:19",
                message: "fmt.Printf format %s reads arg #1, but call has 0 args",
                posn: "/workspace/repo/pkg/foo.go:10:6",
              },
            ],
          },
        }),
        stdoutBytes: 260,
        timedOut: false,
        truncated: false,
      },
      snapshot: goPullRequestSnapshotFixture,
      tool: "go_vet",
      toolRunId: "str_go_vet",
      workspacePath: "/workspace/repo",
    });

    expect(parsed.warnings).toEqual([]);
    expect(parsed.diagnostics).toHaveLength(1);
    expect(parsed.diagnostics[0]).toMatchObject({
      category: "correctness",
      isOnChangedLine: true,
      location: {
        endColumn: 19,
        endLine: 10,
        filePath: "pkg/foo.go",
        originalPath: "/workspace/repo/pkg/foo.go",
        startColumn: 6,
        startLine: 10,
      },
      metadata: {
        analyzer: "printf",
        category: "printf",
        packageId: "example.com/repo",
      },
      ruleId: "printf",
      ruleName: "printf",
      severity: "warning",
      sourceTrust: "tool_output",
      tool: "go_vet",
    });
  });

  it("parses Staticcheck JSONL output into normalized diagnostics", () => {
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
          code: "SA4006",
          end: { column: 14, file: "/workspace/repo/pkg/foo.go", line: 10 },
          location: { column: 6, file: "/workspace/repo/pkg/foo.go", line: 10 },
          message: "this value of result is never used",
          severity: "error",
        }),
        stdoutBytes: 220,
        timedOut: false,
        truncated: false,
      },
      snapshot: goPullRequestSnapshotFixture,
      tool: "staticcheck",
      toolRunId: "str_staticcheck",
      workspacePath: "/workspace/repo",
    });

    expect(parsed.warnings).toEqual([]);
    expect(parsed.diagnostics).toHaveLength(1);
    expect(parsed.diagnostics[0]).toMatchObject({
      category: "correctness",
      isOnChangedLine: true,
      location: {
        endColumn: 14,
        endLine: 10,
        filePath: "pkg/foo.go",
        originalPath: "/workspace/repo/pkg/foo.go",
        startColumn: 6,
        startLine: 10,
      },
      metadata: { code: "SA4006", severity: "error" },
      ruleId: "SA4006",
      ruleName: "SA4006",
      severity: "error",
      sourceTrust: "tool_output",
      tool: "staticcheck",
    });
  });

  it("parses Cargo JSONL compiler messages into normalized diagnostics", () => {
    const cargoMessage = JSON.stringify({
      manifest_path: "/workspace/repo/Cargo.toml",
      message: {
        children: [],
        code: { code: "unused_variables", explanation: null },
        level: "warning",
        message: "unused variable: `value`",
        rendered: "warning: unused variable: `value`",
        spans: [
          {
            column_end: 14,
            column_start: 5,
            file_name: "/workspace/repo/src/lib.rs",
            is_primary: true,
            line_end: 3,
            line_start: 3,
            text: [
              {
                highlight_end: 14,
                highlight_start: 5,
                text: "let value = 1;",
              },
            ],
          },
        ],
      },
      package_id: "path+file:///workspace/repo#heimdall-test@0.1.0",
      reason: "compiler-message",
    });

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
        stdout: cargoMessage,
        stdoutBytes: cargoMessage.length,
        timedOut: false,
        truncated: false,
      },
      snapshot: rustPullRequestSnapshotFixture,
      tool: "cargo_check",
      toolRunId: "str_cargo_check",
      workspacePath: "/workspace/repo",
    });

    expect(parsed.warnings).toEqual([]);
    expect(parsed.diagnostics).toHaveLength(1);
    expect(parsed.diagnostics[0]).toMatchObject({
      category: "correctness",
      isOnChangedLine: true,
      location: {
        endColumn: 14,
        endLine: 3,
        filePath: "src/lib.rs",
        originalPath: "/workspace/repo/src/lib.rs",
        startColumn: 5,
        startLine: 3,
      },
      metadata: {
        code: "unused_variables",
        level: "warning",
        packageId: "path+file:///workspace/repo#heimdall-test@0.1.0",
      },
      ruleId: "unused_variables",
      ruleName: "unused_variables",
      severity: "warning",
      sourceTrust: "tool_output",
      tool: "cargo_check",
    });
  });

  it("parses Pyright JSON output into normalized diagnostics", () => {
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
          generalDiagnostics: [
            {
              file: "/workspace/repo/src/app.py",
              message: 'Type "str" is not assignable to type "int".',
              range: {
                end: { character: 10, line: 1 },
                start: { character: 6, line: 1 },
              },
              rule: "reportAssignmentType",
              severity: "error",
            },
          ],
          summary: {
            errorCount: 1,
            filesAnalyzed: 1,
            informationCount: 0,
            timeInSec: 0.11,
            warningCount: 0,
          },
          time: "2026-05-06T00:00:00.001Z",
          version: "1.1.409",
        }),
        stdoutBytes: 360,
        timedOut: false,
        truncated: false,
      },
      snapshot: pythonPullRequestSnapshotFixture,
      tool: "pyright",
      toolRunId: "str_pyright",
      workspacePath: "/workspace/repo",
    });

    expect(parsed.warnings).toEqual([]);
    expect(parsed.diagnostics).toHaveLength(1);
    expect(parsed.diagnostics[0]).toMatchObject({
      category: "correctness",
      isOnChangedLine: true,
      location: {
        endColumn: 11,
        endLine: 2,
        filePath: "src/app.py",
        originalPath: "/workspace/repo/src/app.py",
        startColumn: 7,
        startLine: 2,
      },
      metadata: { rule: "reportAssignmentType" },
      ruleId: "reportAssignmentType",
      ruleName: "reportAssignmentType",
      severity: "error",
      sourceTrust: "tool_output",
      tool: "pyright",
    });
  });

  it("parses Ruff JSON output into normalized diagnostics", () => {
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
        stdout: JSON.stringify([
          {
            code: "F401",
            end_location: { column: 10, row: 2 },
            filename: "/workspace/repo/src/app.py",
            location: { column: 8, row: 2 },
            message: "`os` imported but unused",
            url: "https://docs.astral.sh/ruff/rules/unused-import",
          },
        ]),
        stdoutBytes: 220,
        timedOut: false,
        truncated: false,
      },
      snapshot: pythonPullRequestSnapshotFixture,
      tool: "ruff",
      toolRunId: "str_ruff",
      workspacePath: "/workspace/repo",
    });

    expect(parsed.warnings).toEqual([]);
    expect(parsed.diagnostics).toHaveLength(1);
    expect(parsed.diagnostics[0]).toMatchObject({
      category: "correctness",
      isOnChangedLine: true,
      location: {
        endColumn: 10,
        endLine: 2,
        filePath: "src/app.py",
        originalPath: "/workspace/repo/src/app.py",
        startColumn: 8,
        startLine: 2,
      },
      metadata: { code: "F401" },
      ruleId: "F401",
      ruleUrl: "https://docs.astral.sh/ruff/rules/unused-import",
      severity: "warning",
      sourceTrust: "tool_output",
      tool: "ruff",
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
