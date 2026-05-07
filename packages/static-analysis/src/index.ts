import { createHash } from "node:crypto";
import {
  type ChangedFile,
  type ChangedSymbol,
  type FindingCategory,
  FindingCategorySchema,
  type PullRequestSnapshot,
} from "@repo/contracts";
import { type CodeLanguage, CodeLanguageSchema } from "@repo/contracts/enums/language";
import type { ToolCommandSpec, ToolRunner, ToolRunnerResult } from "@repo/tool-runner";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/** Static-analysis execution modes. */
export const StaticAnalysisModeSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("changed_files_fast"),
  Type.Literal("affected_projects"),
  Type.Literal("full_head"),
  Type.Literal("base_head_delta"),
  Type.Literal("security_only"),
  Type.Literal("debug_full"),
]);

/** Static-analysis execution mode. */
export type StaticAnalysisMode = Static<typeof StaticAnalysisModeSchema>;

/** Supported static-analysis tool names. */
export const StaticToolNameSchema = Type.Union([
  Type.Literal("eslint"),
  Type.Literal("typescript"),
  Type.Literal("biome"),
  Type.Literal("ruff"),
  Type.Literal("pyright"),
  Type.Literal("mypy"),
  Type.Literal("semgrep"),
  Type.Literal("go_vet"),
  Type.Literal("staticcheck"),
  Type.Literal("cargo_check"),
  Type.Literal("cargo_clippy"),
  Type.Literal("custom_command"),
]);

/** Supported static-analysis tool name. */
export type StaticToolName = Static<typeof StaticToolNameSchema>;

/** Supported static-analysis output formats. */
export const ToolOutputFormatSchema = Type.Union([
  Type.Literal("json"),
  Type.Literal("jsonl"),
  Type.Literal("sarif"),
  Type.Literal("text"),
  Type.Literal("junit_xml"),
  Type.Literal("github_annotations"),
]);

/** Supported static-analysis output format. */
export type ToolOutputFormat = Static<typeof ToolOutputFormatSchema>;

/** Static-analysis budget controls. */
export const StaticAnalysisBudgetsSchema = Type.Object(
  {
    allowFullRepoAnalysis: Type.Boolean(),
    maxArtifactBytesPerTool: Type.Integer({ minimum: 0 }),
    maxChangedFilesForFastMode: Type.Integer({ minimum: 0 }),
    maxDiagnosticsPerTool: Type.Integer({ minimum: 0 }),
    maxDiagnosticsTotal: Type.Integer({ minimum: 0 }),
    maxOutputBytesPerTool: Type.Integer({ minimum: 0 }),
    maxToolRunMs: Type.Integer({ minimum: 1 }),
    maxToolRuns: Type.Integer({ minimum: 0 }),
    maxWallClockMs: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

/** Static-analysis budget controls. */
export type StaticAnalysisBudgets = Static<typeof StaticAnalysisBudgetsSchema>;

/** Default static-analysis budgets for changed-files-fast mode. */
export const DEFAULT_STATIC_ANALYSIS_BUDGETS = {
  allowFullRepoAnalysis: false,
  maxArtifactBytesPerTool: 25_000_000,
  maxChangedFilesForFastMode: 100,
  maxDiagnosticsPerTool: 500,
  maxDiagnosticsTotal: 1_500,
  maxOutputBytesPerTool: 10_000_000,
  maxToolRunMs: 45_000,
  maxToolRuns: 8,
  maxWallClockMs: 120_000,
} as const satisfies StaticAnalysisBudgets;

/** Static tool descriptor metadata used by planning and dashboards. */
export const ToolDescriptorSchema = Type.Object(
  {
    categories: Type.Array(FindingCategorySchema),
    defaultEnabled: Type.Boolean(),
    defaultMaxOutputBytes: Type.Integer({ minimum: 0 }),
    defaultTimeoutMs: Type.Integer({ minimum: 1 }),
    displayName: Type.String({ minLength: 1 }),
    languages: Type.Array(CodeLanguageSchema),
    mayAccessNetwork: Type.Boolean(),
    mayExecuteProjectCode: Type.Boolean(),
    mutatesWorkspace: Type.Boolean(),
    name: StaticToolNameSchema,
    outputFormats: Type.Array(ToolOutputFormatSchema),
    preferredOutputFormat: ToolOutputFormatSchema,
    requiresDependencies: Type.Boolean(),
    supportsBaseHeadDelta: Type.Boolean(),
    supportsChangedFiles: Type.Boolean(),
    supportsFullRepo: Type.Boolean(),
    supportsProjectScope: Type.Boolean(),
  },
  { additionalProperties: false },
);

/** Static tool descriptor metadata used by planning and dashboards. */
export type ToolDescriptor = Static<typeof ToolDescriptorSchema>;

/** Tool run scope selected by the planner. */
export type ToolRunScope = {
  /** Scope kind for the tool command. */
  readonly kind: "changed_files" | "affected_project" | "package" | "workspace" | "full_repo";
  /** Repository paths included in this scope. */
  readonly paths: readonly string[];
  /** Optional project root. */
  readonly projectRoot?: string | undefined;
  /** Optional config file path. */
  readonly configPath?: string | undefined;
  /** Optional package name. */
  readonly packageName?: string | undefined;
  /** Optional primary language. */
  readonly language?: CodeLanguage | undefined;
  /** Commit SHA being analyzed. */
  readonly commitSha: string;
  /** Trust level of the configuration used by the command. */
  readonly configTrust: "base" | "head" | "mixed" | "unknown";
};

/** Planned static-analysis tool run. */
export type ToolRunPlan = {
  /** Stable plan ID. */
  readonly planId: string;
  /** Tool to run. */
  readonly tool: StaticToolName;
  /** Adapter version that created the plan. */
  readonly adapterVersion: string;
  /** Tool run scope. */
  readonly scope: ToolRunScope;
  /** Command specification for a runner. */
  readonly command: ToolCommandSpec;
  /** Expected output format. */
  readonly expectedOutputFormat: ToolOutputFormat;
  /** Timeout in milliseconds. */
  readonly timeoutMs: number;
  /** Maximum captured output bytes. */
  readonly maxOutputBytes: number;
  /** Product-safe plan reason. */
  readonly reason: string;
  /** Whether tool failure should be non-fatal to review. */
  readonly allowFailure: boolean;
  /** Optional deterministic cache key. */
  readonly cacheKey?: string | undefined;
};

/** Static-analysis request. */
export type StaticAnalysisRequest = {
  /** Schema version. */
  readonly schemaVersion: "static_analysis_request.v1";
  /** Organization ID. */
  readonly orgId: string;
  /** Repository ID. */
  readonly repoId: string;
  /** Review run ID. */
  readonly reviewRunId: string;
  /** Pull request snapshot. */
  readonly snapshot: PullRequestSnapshot;
  /** Workspace details. */
  readonly workspace: {
    /** Workspace lease ID. */
    readonly workspaceId: string;
    /** Filesystem path for the workspace. */
    readonly path: string;
    /** Commit SHA checked out in the workspace. */
    readonly commitSha: string;
    /** Whether workspace configuration is trusted. */
    readonly isTrusted: boolean;
  };
  /** Static-analysis mode. */
  readonly mode: StaticAnalysisMode;
  /** Analysis trigger reason. */
  readonly reason: "review" | "manual" | "replay" | "scheduled";
  /** Budget controls. */
  readonly budgets?: StaticAnalysisBudgets | undefined;
  /** Explicit tool allowlist. */
  readonly requestedTools?: readonly StaticToolName[] | undefined;
  /** Explicit disabled tools. */
  readonly disabledTools?: readonly StaticToolName[] | undefined;
  /** Optional changed symbols. */
  readonly changedSymbols?: readonly ChangedSymbol[] | undefined;
  /** Creation timestamp. */
  readonly createdAt: string;
};

/** Tool diagnostic severity. */
export const ToolDiagnosticSeveritySchema = Type.Union([
  Type.Literal("info"),
  Type.Literal("warning"),
  Type.Literal("error"),
  Type.Literal("critical"),
]);

/** Tool diagnostic severity. */
export type ToolDiagnosticSeverity = Static<typeof ToolDiagnosticSeveritySchema>;

/** Tool diagnostic location. */
export type ToolDiagnosticLocation = {
  /** Repository file path. */
  readonly filePath: string;
  /** Start line. */
  readonly startLine: number;
  /** Optional start column. */
  readonly startColumn?: number | undefined;
  /** Optional end line. */
  readonly endLine?: number | undefined;
  /** Optional end column. */
  readonly endColumn?: number | undefined;
  /** Original path emitted by the tool. */
  readonly originalPath?: string | undefined;
  /** Optional source snippet. */
  readonly snippet?: string | undefined;
};

/** Normalized static tool diagnostic. */
export type NormalizedToolDiagnostic = {
  /** Stable diagnostic ID. */
  readonly diagnosticId: string;
  /** Stable diagnostic fingerprint. */
  readonly fingerprint: string;
  /** Source tool. */
  readonly tool: StaticToolName;
  /** Tool run ID. */
  readonly toolRunId: string;
  /** Optional tool rule ID. */
  readonly ruleId?: string | undefined;
  /** Optional tool rule name. */
  readonly ruleName?: string | undefined;
  /** Optional rule documentation URL. */
  readonly ruleUrl?: string | undefined;
  /** Normalized message. */
  readonly message: string;
  /** Raw tool message. */
  readonly rawMessage?: string | undefined;
  /** Diagnostic severity. */
  readonly severity: ToolDiagnosticSeverity;
  /** Review finding category. */
  readonly category: FindingCategory;
  /** Diagnostic confidence. */
  readonly confidence: number;
  /** Primary location. */
  readonly location: ToolDiagnosticLocation;
  /** Whether the primary location is on a changed line. */
  readonly isOnChangedLine: boolean;
  /** Whether the primary location is in a changed file. */
  readonly isInChangedFile: boolean;
  /** Baseline status for base/head comparison. */
  readonly baselineStatus: "unknown" | "new" | "existing" | "fixed";
  /** Trust level of the parsed source. */
  readonly sourceTrust: "tool_output" | "parsed_text" | "adapter_inferred";
  /** Product-safe metadata. */
  readonly metadata: Readonly<Record<string, unknown>>;
};

/** Static-analysis warning. */
export type StaticAnalysisWarning = {
  /** Stable warning code. */
  readonly code: string;
  /** Product-safe warning message. */
  readonly message: string;
  /** Optional warning details. */
  readonly details?: Readonly<Record<string, unknown>> | undefined;
};

/** Static tool run summary stored in reports. */
export type ToolRunResultSummary = {
  /** Tool run ID. */
  readonly toolRunId: string;
  /** Plan ID. */
  readonly planId: string;
  /** Tool name. */
  readonly tool: StaticToolName;
  /** Execution status. */
  readonly status: "succeeded" | "failed_tool_error" | "timed_out" | "skipped" | "cancelled";
  /** Start timestamp. */
  readonly startedAt: string;
  /** Finish timestamp. */
  readonly finishedAt: string;
  /** Duration in milliseconds. */
  readonly durationMs: number;
  /** Exit code when available. */
  readonly exitCode: number | null;
  /** Stdout bytes captured. */
  readonly stdoutBytes: number;
  /** Stderr bytes captured. */
  readonly stderrBytes: number;
  /** Diagnostic count for this run. */
  readonly diagnosticCount: number;
};

/** Static-analysis report. */
export type StaticAnalysisReport = {
  /** Schema version. */
  readonly schemaVersion: "static_analysis_report.v1";
  /** Report ID. */
  readonly reportId: string;
  /** Review run ID. */
  readonly reviewRunId: string;
  /** Repository ID. */
  readonly repoId: string;
  /** Commit SHA analyzed. */
  readonly commitSha: string;
  /** Static-analysis mode. */
  readonly mode: StaticAnalysisMode;
  /** Report status. */
  readonly status: "succeeded" | "partially_succeeded" | "failed" | "skipped";
  /** Start timestamp. */
  readonly startedAt: string;
  /** Finish timestamp. */
  readonly finishedAt: string;
  /** Duration in milliseconds. */
  readonly durationMs: number;
  /** Tool run summaries. */
  readonly toolRuns: readonly ToolRunResultSummary[];
  /** Normalized diagnostics. */
  readonly diagnostics: readonly NormalizedToolDiagnostic[];
  /** Aggregate report summary. */
  readonly summary: {
    /** Tool run count. */
    readonly toolRunCount: number;
    /** Successful tool run count. */
    readonly succeededToolRunCount: number;
    /** Failed tool run count. */
    readonly failedToolRunCount: number;
    /** Timed out tool run count. */
    readonly timedOutToolRunCount: number;
    /** Total diagnostic count. */
    readonly diagnosticCount: number;
    /** Diagnostics on changed lines. */
    readonly changedLineDiagnosticCount: number;
    /** New diagnostics from base/head comparison. */
    readonly newDiagnosticCount: number;
    /** High severity diagnostics. */
    readonly highSeverityDiagnosticCount: number;
  };
  /** Product-safe warnings. */
  readonly warnings: readonly StaticAnalysisWarning[];
};

/** Static-analysis planning result. */
export type StaticAnalysisPlan = {
  /** Planned tool runs. */
  readonly toolRuns: readonly ToolRunPlan[];
  /** Product-safe planner warnings. */
  readonly warnings: readonly StaticAnalysisWarning[];
};

/** Input for a normalized diagnostic fixture. */
export type CreateDiagnosticInput = {
  /** Source tool. */
  readonly tool: StaticToolName;
  /** Tool run ID. */
  readonly toolRunId: string;
  /** Diagnostic message. */
  readonly message: string;
  /** Diagnostic severity. */
  readonly severity?: ToolDiagnosticSeverity | undefined;
  /** Finding category. */
  readonly category?: FindingCategory | undefined;
  /** Diagnostic confidence. */
  readonly confidence?: number | undefined;
  /** Diagnostic location. */
  readonly location: ToolDiagnosticLocation;
  /** Optional tool rule ID. */
  readonly ruleId?: string | undefined;
  /** Pull request snapshot used for diff mapping. */
  readonly snapshot: PullRequestSnapshot;
};

/** Input for running a deterministic static-analysis report. */
export type RunStaticAnalysisInput = {
  /** Static-analysis request. */
  readonly request: StaticAnalysisRequest;
  /** Tool runner implementation. */
  readonly runner: ToolRunner;
  /** Diagnostics emitted by fake adapters, keyed by tool name. */
  readonly diagnosticsByTool?: Partial<Record<StaticToolName, readonly CreateDiagnosticInput[]>>;
};

/** Built-in tool descriptors for MVP planning. */
export const STATIC_TOOL_DESCRIPTORS = [
  descriptor("eslint", "ESLint", ["javascript", "typescript", "jsx", "tsx"], ["maintainability"]),
  descriptor("typescript", "TypeScript", ["typescript", "tsx"], ["correctness"]),
  descriptor("biome", "Biome", ["javascript", "typescript", "jsx", "tsx"], ["style"]),
  descriptor("ruff", "Ruff", ["python"], ["maintainability"]),
  descriptor("pyright", "Pyright", ["python"], ["correctness"]),
  descriptor(
    "semgrep",
    "Semgrep",
    ["javascript", "typescript", "python", "go", "rust"],
    ["security"],
  ),
] as const satisfies readonly ToolDescriptor[];

/** Returns a static tool descriptor by name. */
export function getStaticToolDescriptor(tool: StaticToolName): ToolDescriptor | undefined {
  return STATIC_TOOL_DESCRIPTORS.find((descriptor) => descriptor.name === tool);
}

/** Plans deterministic static-analysis tool runs for a request. */
export function planStaticAnalysis(input: StaticAnalysisRequest): StaticAnalysisPlan {
  const budgets = input.budgets ?? DEFAULT_STATIC_ANALYSIS_BUDGETS;
  if (input.mode === "off") {
    return { toolRuns: [], warnings: [warning("static_analysis_off", "Static analysis is off.")] };
  }

  const changedFiles = reviewableChangedFiles(input.snapshot.changedFiles);
  const languages = new Set(changedFiles.map((file) => file.language));
  const disabled = new Set(input.disabledTools ?? []);
  const requested = input.requestedTools ? new Set(input.requestedTools) : undefined;
  const descriptors = STATIC_TOOL_DESCRIPTORS.filter((descriptor) =>
    toolApplies({ descriptor, disabled, languages, mode: input.mode, requested }),
  );
  const warnings: StaticAnalysisWarning[] = [];
  if (
    input.mode === "changed_files_fast" &&
    changedFiles.length > budgets.maxChangedFilesForFastMode
  ) {
    warnings.push(
      warning(
        "changed_file_budget_exceeded",
        "Static analysis skipped because the PR is too large.",
        {
          changedFileCount: changedFiles.length,
          maxChangedFilesForFastMode: budgets.maxChangedFilesForFastMode,
        },
      ),
    );
    return { toolRuns: [], warnings };
  }

  const toolRuns = descriptors.slice(0, budgets.maxToolRuns).map((descriptor) =>
    toolRunPlan({
      descriptor,
      request: input,
      paths: changedFiles
        .filter((file) => descriptor.languages.includes(file.language))
        .map((file) => file.path),
    }),
  );
  if (descriptors.length > toolRuns.length) {
    warnings.push(
      warning("tool_run_budget_truncated", "Static analysis tools were truncated by budget.", {
        plannedToolCount: descriptors.length,
        maxToolRuns: budgets.maxToolRuns,
      }),
    );
  }

  return { toolRuns, warnings };
}

/** Creates a normalized diagnostic and maps it to changed-file context. */
export function createNormalizedToolDiagnostic(
  input: CreateDiagnosticInput,
): NormalizedToolDiagnostic {
  const file = input.snapshot.changedFiles.find((file) => file.path === input.location.filePath);
  const isOnChangedLine = Boolean(
    file?.hunks.some((hunk) =>
      hunk.lines.some(
        (line) => line.kind === "addition" && line.newLine === input.location.startLine,
      ),
    ),
  );
  const fingerprint = staticDiagnosticFingerprint(input);

  return {
    baselineStatus: "unknown",
    category: input.category ?? categoryForSeverity(input.severity ?? "warning"),
    confidence: input.confidence ?? 0.75,
    diagnosticId: stableId("sdiag", [input.toolRunId, fingerprint]),
    fingerprint,
    isInChangedFile: Boolean(file),
    isOnChangedLine,
    location: input.location,
    message: input.message,
    metadata: {},
    ...(input.ruleId ? { ruleId: input.ruleId } : {}),
    severity: input.severity ?? "warning",
    sourceTrust: "tool_output",
    tool: input.tool,
    toolRunId: input.toolRunId,
  };
}

/** Runs planned static-analysis tools through a runner and builds a report. */
export async function runStaticAnalysis(
  input: RunStaticAnalysisInput,
): Promise<StaticAnalysisReport> {
  const startedAt = input.request.createdAt;
  const plan = planStaticAnalysis(input.request);
  const toolRuns: ToolRunResultSummary[] = [];
  const diagnostics: NormalizedToolDiagnostic[] = [];

  for (const runPlan of plan.toolRuns) {
    const toolRunId = stableId("str", [input.request.reviewRunId, runPlan.planId]);
    const result = await input.runner.run({
      command: runPlan.command,
      maxOutputBytes: runPlan.maxOutputBytes,
      planId: runPlan.planId,
      startedAt,
      timeoutMs: runPlan.timeoutMs,
    });
    const runDiagnostics = (input.diagnosticsByTool?.[runPlan.tool] ?? [])
      .slice(
        0,
        input.request.budgets?.maxDiagnosticsPerTool ??
          DEFAULT_STATIC_ANALYSIS_BUDGETS.maxDiagnosticsPerTool,
      )
      .map((diagnostic) =>
        createNormalizedToolDiagnostic({
          ...diagnostic,
          toolRunId,
        }),
      );

    diagnostics.push(...runDiagnostics);
    toolRuns.push(
      toolRunSummary({ diagnostics: runDiagnostics, plan: runPlan, result, toolRunId }),
    );
  }

  return staticAnalysisReport({
    diagnostics: diagnostics.slice(
      0,
      input.request.budgets?.maxDiagnosticsTotal ??
        DEFAULT_STATIC_ANALYSIS_BUDGETS.maxDiagnosticsTotal,
    ),
    finishedAt: toolRuns.at(-1)?.finishedAt ?? startedAt,
    request: input.request,
    startedAt,
    toolRuns,
    warnings: plan.warnings,
  });
}

/** Parses an unknown value as static-analysis budgets. */
export function parseStaticAnalysisBudgets(value: unknown): StaticAnalysisBudgets {
  if (!Value.Check(StaticAnalysisBudgetsSchema, value)) {
    throw new Error("Static analysis budgets do not match the schema.");
  }

  return value as StaticAnalysisBudgets;
}

/** Creates one tool descriptor. */
function descriptor(
  name: StaticToolName,
  displayName: string,
  languages: readonly CodeLanguage[],
  categories: readonly FindingCategory[],
): ToolDescriptor {
  return {
    categories: [...categories],
    defaultEnabled: true,
    defaultMaxOutputBytes: DEFAULT_STATIC_ANALYSIS_BUDGETS.maxOutputBytesPerTool,
    defaultTimeoutMs: DEFAULT_STATIC_ANALYSIS_BUDGETS.maxToolRunMs,
    displayName,
    languages: [...languages],
    mayAccessNetwork: false,
    mayExecuteProjectCode: name !== "typescript",
    mutatesWorkspace: false,
    name,
    outputFormats: ["json", "text"],
    preferredOutputFormat: "json",
    requiresDependencies: name !== "semgrep",
    supportsBaseHeadDelta: true,
    supportsChangedFiles: true,
    supportsFullRepo: true,
    supportsProjectScope: name === "typescript" || name === "pyright",
  };
}

/** Returns reviewable changed files for static analysis. */
function reviewableChangedFiles(files: readonly ChangedFile[]): readonly ChangedFile[] {
  return files.filter((file) => !file.isBinary && file.status !== "deleted");
}

/** Returns whether one descriptor applies to the current request. */
function toolApplies(input: {
  readonly descriptor: ToolDescriptor;
  readonly disabled: ReadonlySet<StaticToolName>;
  readonly languages: ReadonlySet<CodeLanguage>;
  readonly mode: StaticAnalysisMode;
  readonly requested: ReadonlySet<StaticToolName> | undefined;
}): boolean {
  if (input.disabled.has(input.descriptor.name)) return false;
  if (input.requested && !input.requested.has(input.descriptor.name)) return false;
  if (input.mode === "security_only" && !input.descriptor.categories.includes("security")) {
    return false;
  }
  return input.descriptor.languages.some((language) => input.languages.has(language));
}

/** Creates one tool run plan. */
function toolRunPlan(input: {
  readonly descriptor: ToolDescriptor;
  readonly request: StaticAnalysisRequest;
  readonly paths: readonly string[];
}): ToolRunPlan {
  const paths = [...input.paths].sort();
  const planId = stableId("stplan", [
    input.request.reviewRunId,
    input.descriptor.name,
    paths.join(","),
  ]);

  return {
    adapterVersion: "static-analysis.fake-adapter.v1",
    allowFailure: true,
    command: {
      args: ["--changed-files", ...paths],
      cwd: input.request.workspace.path,
      displayCommand: `${input.descriptor.name} --changed-files ${paths.join(" ")}`.trim(),
      env: {},
      executable: input.descriptor.name,
      filesystemPolicy: "read_only",
      networkPolicy: "none",
    },
    expectedOutputFormat: input.descriptor.preferredOutputFormat,
    maxOutputBytes: input.descriptor.defaultMaxOutputBytes,
    planId,
    reason: `Run ${input.descriptor.displayName} on changed ${input.descriptor.languages.join("/")} files.`,
    scope: {
      commitSha: input.request.workspace.commitSha,
      configTrust: input.request.workspace.isTrusted ? "base" : "head",
      kind: "changed_files",
      paths,
    },
    timeoutMs: input.descriptor.defaultTimeoutMs,
    tool: input.descriptor.name,
  };
}

/** Converts a runner result into a report run summary. */
function toolRunSummary(input: {
  readonly diagnostics: readonly NormalizedToolDiagnostic[];
  readonly plan: ToolRunPlan;
  readonly result: ToolRunnerResult;
  readonly toolRunId: string;
}): ToolRunResultSummary {
  return {
    diagnosticCount: input.diagnostics.length,
    durationMs: input.result.durationMs,
    exitCode: input.result.exitCode,
    finishedAt: input.result.finishedAt,
    planId: input.plan.planId,
    startedAt: input.result.startedAt,
    status: toolRunStatus(input.result),
    stderrBytes: input.result.stderrBytes,
    stdoutBytes: input.result.stdoutBytes,
    tool: input.plan.tool,
    toolRunId: input.toolRunId,
  };
}

/** Maps runner status to static-analysis tool run status. */
function toolRunStatus(result: ToolRunnerResult): ToolRunResultSummary["status"] {
  if (result.status === "timed_out") return "timed_out";
  if (result.status === "cancelled") return "cancelled";
  if (result.status === "succeeded") return "succeeded";
  return "failed_tool_error";
}

/** Builds a report from run summaries and diagnostics. */
function staticAnalysisReport(input: {
  readonly diagnostics: readonly NormalizedToolDiagnostic[];
  readonly finishedAt: string;
  readonly request: StaticAnalysisRequest;
  readonly startedAt: string;
  readonly toolRuns: readonly ToolRunResultSummary[];
  readonly warnings: readonly StaticAnalysisWarning[];
}): StaticAnalysisReport {
  const failedToolRunCount = input.toolRuns.filter(
    (run) => run.status === "failed_tool_error",
  ).length;
  const timedOutToolRunCount = input.toolRuns.filter((run) => run.status === "timed_out").length;
  const status =
    input.toolRuns.length === 0
      ? "skipped"
      : failedToolRunCount > 0 || timedOutToolRunCount > 0
        ? "partially_succeeded"
        : "succeeded";

  return {
    commitSha: input.request.workspace.commitSha,
    diagnostics: input.diagnostics,
    durationMs: Math.max(0, Date.parse(input.finishedAt) - Date.parse(input.startedAt)),
    finishedAt: input.finishedAt,
    mode: input.request.mode,
    repoId: input.request.repoId,
    reportId: stableId("star", [input.request.reviewRunId, input.request.workspace.commitSha]),
    reviewRunId: input.request.reviewRunId,
    schemaVersion: "static_analysis_report.v1",
    startedAt: input.startedAt,
    status,
    summary: {
      changedLineDiagnosticCount: input.diagnostics.filter(
        (diagnostic) => diagnostic.isOnChangedLine,
      ).length,
      diagnosticCount: input.diagnostics.length,
      failedToolRunCount,
      highSeverityDiagnosticCount: input.diagnostics.filter(
        (diagnostic) => diagnostic.severity === "error" || diagnostic.severity === "critical",
      ).length,
      newDiagnosticCount: input.diagnostics.filter(
        (diagnostic) => diagnostic.baselineStatus === "new",
      ).length,
      succeededToolRunCount: input.toolRuns.filter((run) => run.status === "succeeded").length,
      timedOutToolRunCount,
      toolRunCount: input.toolRuns.length,
    },
    toolRuns: input.toolRuns,
    warnings: input.warnings,
  };
}

/** Creates one warning. */
function warning(
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): StaticAnalysisWarning {
  return {
    code,
    message,
    ...(details ? { details } : {}),
  };
}

/** Returns a category default for a diagnostic severity. */
function categoryForSeverity(severity: ToolDiagnosticSeverity): FindingCategory {
  return severity === "critical" || severity === "error" ? "correctness" : "maintainability";
}

/** Creates a stable diagnostic fingerprint. */
function staticDiagnosticFingerprint(input: CreateDiagnosticInput): string {
  return stableId("stfp", [
    input.tool,
    input.ruleId ?? "",
    input.location.filePath,
    input.location.startLine,
    input.message.trim().toLowerCase(),
  ]);
}

/** Creates a deterministic prefixed identifier. */
function stableId(prefix: string, parts: readonly unknown[]): string {
  return `${prefix}_${createHash("sha256")
    .update(parts.map((part) => String(part)).join("\0"))
    .digest("base64url")
    .slice(0, 24)}`;
}
