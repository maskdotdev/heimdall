import { createHash } from "node:crypto";
import {
  type ChangedFile,
  type ChangedSymbol,
  type FindingCategory,
  FindingCategorySchema,
  type PullRequestSnapshot,
} from "@repo/contracts";
import { type CodeLanguage, CodeLanguageSchema } from "@repo/contracts/enums/language";
import {
  classifyTelemetryError,
  OBSERVABILITY_METRIC_NAMES,
  OBSERVABILITY_SPAN_NAMES,
  type TelemetryMetricRecorder,
  type TelemetrySpanRecorder,
  type TelemetryTraceContextInput,
} from "@repo/observability";
import type {
  ToolCommandSpec,
  ToolRunner,
  ToolRunnerResult,
  ToolRunnerSandboxContext,
} from "@repo/tool-runner";
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

/** Static-analysis raw tool output retention policy. */
export type StaticAnalysisRawOutputPolicy = {
  /** Policy schema version. */
  readonly schemaVersion: "static_analysis_raw_output_policy.v1";
  /** Whether complete tool stdout bytes are stored in the report artifact. */
  readonly storesRawStdout: false;
  /** Whether complete tool stderr bytes are stored in the report artifact. */
  readonly storesRawStderr: false;
  /** Product-safe fields retained from tool execution results. */
  readonly retainedFields: readonly string[];
  /** Human-readable retention reason for operators. */
  readonly retentionReason: string;
};

/** Default policy for static-analysis report artifacts. */
export const STATIC_ANALYSIS_RAW_OUTPUT_POLICY = {
  retainedFields: [
    "diagnostics",
    "exitCode",
    "finishedAt",
    "startedAt",
    "status",
    "stderrBytes",
    "stdoutBytes",
    "tool",
  ],
  retentionReason:
    "Static-analysis reports retain normalized diagnostics and execution metadata, not full stdout or stderr payloads.",
  schemaVersion: "static_analysis_raw_output_policy.v1",
  storesRawStderr: false,
  storesRawStdout: false,
} as const satisfies StaticAnalysisRawOutputPolicy;

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
  /** Raw tool output storage policy applied to this report. */
  readonly rawOutputPolicy: StaticAnalysisRawOutputPolicy;
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
  /** Optional tool rule name. */
  readonly ruleName?: string | undefined;
  /** Optional rule documentation URL. */
  readonly ruleUrl?: string | undefined;
  /** Raw tool message before normalization. */
  readonly rawMessage?: string | undefined;
  /** Trust level of the parsed source. */
  readonly sourceTrust?: NormalizedToolDiagnostic["sourceTrust"] | undefined;
  /** Product-safe diagnostic metadata. */
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
  /** Pull request snapshot used for diff mapping. */
  readonly snapshot: PullRequestSnapshot;
};

/** Input for parsing diagnostics from one tool runner output. */
export type ParseToolOutputDiagnosticsInput = {
  /** Source tool. */
  readonly tool: StaticToolName;
  /** Tool run ID. */
  readonly toolRunId: string;
  /** Tool runner result with captured output. */
  readonly result: ToolRunnerResult;
  /** Pull request snapshot used for diff mapping. */
  readonly snapshot: PullRequestSnapshot;
  /** Filesystem path for the analyzed workspace. */
  readonly workspacePath: string;
  /** Maximum diagnostics returned by the parser. */
  readonly maxDiagnostics: number;
};

/** Result from parsing one tool runner output. */
export type ParseToolOutputDiagnosticsResult = {
  /** Normalized diagnostics parsed from tool output. */
  readonly diagnostics: readonly NormalizedToolDiagnostic[];
  /** Product-safe parse warnings. */
  readonly warnings: readonly StaticAnalysisWarning[];
};

/** Optional telemetry dependencies used to instrument static-analysis execution. */
export type StaticAnalysisTelemetryOptions = {
  /** Optional metric recorder for aggregate and per-tool static-analysis telemetry. */
  readonly metrics?: TelemetryMetricRecorder;
  /** Optional trace context propagated from the parent review job. */
  readonly traceContext?: TelemetryTraceContextInput | undefined;
  /** Optional span recorder for product-safe static-analysis spans. */
  readonly traces?: TelemetrySpanRecorder;
};

/** Input for running a deterministic static-analysis report. */
export type RunStaticAnalysisInput = StaticAnalysisTelemetryOptions & {
  /** Static-analysis request. */
  readonly request: StaticAnalysisRequest;
  /** Tool runner implementation. */
  readonly runner: ToolRunner;
  /** Additional deterministic diagnostic fixtures, keyed by tool name. */
  readonly diagnosticsByTool?: Partial<Record<StaticToolName, readonly CreateDiagnosticInput[]>>;
};

/** Final telemetry status for a static-analysis run. */
type StaticAnalysisTelemetryStatus = StaticAnalysisReport["status"] | "failed";

/** Low-cardinality labels shared by static-analysis run metrics. */
type StaticAnalysisRunLabels = Readonly<{
  /** Static-analysis execution mode. */
  readonly mode: StaticAnalysisMode;
  /** Metric operation bucket. */
  readonly operation: "run";
  /** Static-analysis trigger reason. */
  readonly reason: StaticAnalysisRequest["reason"];
  /** Final static-analysis run status. */
  readonly status: StaticAnalysisTelemetryStatus;
}>;

/** Low-cardinality labels shared by static-analysis per-tool metrics. */
type StaticAnalysisToolLabels = Readonly<{
  /** Static-analysis execution mode. */
  readonly mode: StaticAnalysisMode;
  /** Metric operation bucket. */
  readonly operation: "tool";
  /** Final static-analysis tool status. */
  readonly status: ToolRunResultSummary["status"];
  /** Static-analysis tool name. */
  readonly tool: StaticToolName;
}>;

/** ESLint JSON formatter message. */
const EslintJsonMessageSchema = Type.Object(
  {
    column: Type.Optional(Type.Integer({ minimum: 0 })),
    endColumn: Type.Optional(Type.Integer({ minimum: 0 })),
    endLine: Type.Optional(Type.Integer({ minimum: 0 })),
    fatal: Type.Optional(Type.Boolean()),
    line: Type.Optional(Type.Integer({ minimum: 0 })),
    message: Type.String(),
    messageId: Type.Optional(Type.String()),
    ruleId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    severity: Type.Integer({ minimum: 0, maximum: 2 }),
  },
  { additionalProperties: true },
);

/** ESLint JSON formatter file result. */
const EslintJsonFileResultSchema = Type.Object(
  {
    filePath: Type.String(),
    messages: Type.Array(EslintJsonMessageSchema),
  },
  { additionalProperties: true },
);

/** ESLint JSON formatter output. */
const EslintJsonOutputSchema = Type.Array(EslintJsonFileResultSchema);

/** ESLint JSON formatter message. */
type EslintJsonMessage = Static<typeof EslintJsonMessageSchema>;

/** ESLint JSON formatter file result. */
type EslintJsonFileResult = Static<typeof EslintJsonFileResultSchema>;

/** Biome JSON reporter location point. */
const BiomeJsonLocationPointSchema = Type.Object(
  {
    column: Type.Optional(Type.Integer({ minimum: 0 })),
    line: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: true },
);

/** Biome JSON reporter diagnostic location. */
const BiomeJsonLocationSchema = Type.Object(
  {
    end: Type.Optional(BiomeJsonLocationPointSchema),
    path: Type.Optional(Type.String()),
    start: Type.Optional(BiomeJsonLocationPointSchema),
  },
  { additionalProperties: true },
);

/** Biome JSON reporter diagnostic. */
const BiomeJsonDiagnosticSchema = Type.Object(
  {
    category: Type.Optional(Type.String()),
    location: Type.Optional(BiomeJsonLocationSchema),
    message: Type.String(),
    severity: Type.String(),
  },
  { additionalProperties: true },
);

/** Biome JSON reporter output. */
const BiomeJsonOutputSchema = Type.Object(
  {
    diagnostics: Type.Array(BiomeJsonDiagnosticSchema),
  },
  { additionalProperties: true },
);

/** Biome JSON reporter diagnostic. */
type BiomeJsonDiagnostic = Static<typeof BiomeJsonDiagnosticSchema>;

type TypeScriptTextDiagnostic = {
  /** TypeScript diagnostic code without the `TS` prefix. */
  readonly code: string;
  /** One-based column parsed from the diagnostic location. */
  readonly column: number;
  /** Repository or workspace path emitted by TypeScript. */
  readonly filePath: string;
  /** One-based line parsed from the diagnostic location. */
  readonly line: number;
  /** Diagnostic message emitted on the first line. */
  readonly message: string;
  /** TypeScript diagnostic severity. */
  readonly severity: "error" | "warning";
};

/** Matches one `tsc --pretty false` diagnostic line with a concrete file location. */
const TYPESCRIPT_TEXT_DIAGNOSTIC_PATTERN =
  /^(?<filePath>.+?)\((?<line>\d+),(?<column>\d+)\): (?<severity>error|warning) TS(?<code>\d+): (?<message>.+)$/u;

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
    metadata: input.metadata ?? {},
    message: input.message,
    ...(input.rawMessage ? { rawMessage: input.rawMessage } : {}),
    ...(input.ruleId ? { ruleId: input.ruleId } : {}),
    ...(input.ruleName ? { ruleName: input.ruleName } : {}),
    ...(input.ruleUrl ? { ruleUrl: input.ruleUrl } : {}),
    severity: input.severity ?? "warning",
    sourceTrust: input.sourceTrust ?? "tool_output",
    tool: input.tool,
    toolRunId: input.toolRunId,
  };
}

/** Parses supported tool outputs into normalized diagnostics. */
export function parseToolOutputDiagnostics(
  input: ParseToolOutputDiagnosticsInput,
): ParseToolOutputDiagnosticsResult {
  if (input.maxDiagnostics <= 0) {
    return { diagnostics: [], warnings: [] };
  }

  if (input.tool === "eslint") {
    return parseEslintJsonDiagnostics(input);
  }
  if (input.tool === "biome") {
    return parseBiomeJsonDiagnostics(input);
  }
  if (input.tool === "typescript") {
    return parseTypeScriptTextDiagnostics(input);
  }

  return { diagnostics: [], warnings: [] };
}

/** Runs planned static-analysis tools through a runner and builds a report. */
export async function runStaticAnalysis(
  input: RunStaticAnalysisInput,
): Promise<StaticAnalysisReport> {
  const startedAt = input.request.createdAt;
  const runStartedAtMs = Date.now();

  try {
    const plan = planStaticAnalysisWithTelemetry(input);
    const sandboxContext = sandboxContextForStaticAnalysis(input.request);
    const toolRuns: ToolRunResultSummary[] = [];
    const diagnostics: NormalizedToolDiagnostic[] = [];
    const warnings: StaticAnalysisWarning[] = [...plan.warnings];

    for (const runPlan of plan.toolRuns) {
      const toolRunId = stableId("str", [input.request.reviewRunId, runPlan.planId]);
      const maxDiagnosticsPerTool =
        input.request.budgets?.maxDiagnosticsPerTool ??
        DEFAULT_STATIC_ANALYSIS_BUDGETS.maxDiagnosticsPerTool;
      const result = await runStaticAnalysisToolWithTelemetry(input, {
        runPlan,
        sandboxContext,
        startedAt,
      });
      const parsedOutput = parseToolOutputDiagnosticsWithTelemetry(input, {
        maxDiagnosticsPerTool,
        result,
        runPlan,
        toolRunId,
      });
      warnings.push(...parsedOutput.warnings);
      const normalized = normalizeStaticAnalysisDiagnosticsWithTelemetry(input, {
        maxDiagnosticsPerTool,
        parsedOutput,
        result,
        runPlan,
        toolRunId,
      });

      warnings.push(...normalized.warnings);
      diagnostics.push(...normalized.diagnostics);
      toolRuns.push(normalized.toolRun);
    }

    const report = staticAnalysisReport({
      diagnostics: diagnostics.slice(
        0,
        input.request.budgets?.maxDiagnosticsTotal ??
          DEFAULT_STATIC_ANALYSIS_BUDGETS.maxDiagnosticsTotal,
      ),
      finishedAt: toolRuns.at(-1)?.finishedAt ?? startedAt,
      request: input.request,
      startedAt,
      toolRuns,
      warnings,
    });

    finishStaticAnalysisRunTelemetry(input, {
      durationMs: Math.max(0, Date.now() - runStartedAtMs),
      report,
    });

    return report;
  } catch (error) {
    finishStaticAnalysisRunTelemetry(input, {
      durationMs: Math.max(0, Date.now() - runStartedAtMs),
      error,
    });
    throw error;
  }
}

/** Result from normalizing one tool run's parsed and fixture diagnostics. */
type NormalizeStaticAnalysisDiagnosticsResult = {
  /** Diagnostics kept for this tool run after per-tool budget enforcement. */
  readonly diagnostics: readonly NormalizedToolDiagnostic[];
  /** Product-safe normalization warnings. */
  readonly warnings: readonly StaticAnalysisWarning[];
  /** Tool run summary built from normalized diagnostics and runner result. */
  readonly toolRun: ToolRunResultSummary;
};

/** Runs static-analysis planning with a product-safe span. */
function planStaticAnalysisWithTelemetry(input: RunStaticAnalysisInput): StaticAnalysisPlan {
  const span = input.traces?.startSpan(OBSERVABILITY_SPAN_NAMES.staticAnalysisPlan, {
    attributes: {
      "app.repo_id": input.request.repoId,
      "app.review_run_id": input.request.reviewRunId,
      "static_analysis.changed_file_count": input.request.snapshot.changedFileCount,
      "static_analysis.disabled_tool_count": input.request.disabledTools?.length ?? 0,
      "static_analysis.max_tool_runs":
        input.request.budgets?.maxToolRuns ?? DEFAULT_STATIC_ANALYSIS_BUDGETS.maxToolRuns,
      "static_analysis.mode": input.request.mode,
      "static_analysis.reason": input.request.reason,
      "static_analysis.requested_tool_count": input.request.requestedTools?.length ?? 0,
    },
    kind: "internal",
    traceContext: input.traceContext,
  });

  try {
    const plan = planStaticAnalysis(input.request);
    span?.end({
      attributes: {
        "static_analysis.planned_tool_count": plan.toolRuns.length,
        "static_analysis.warning_count": plan.warnings.length,
      },
    });

    return plan;
  } catch (error) {
    span?.end({ error });
    throw error;
  }
}

/** Runs one static-analysis tool with product-safe telemetry. */
async function runStaticAnalysisToolWithTelemetry(
  input: RunStaticAnalysisInput,
  context: {
    /** Static-analysis tool run plan. */
    readonly runPlan: ToolRunPlan;
    /** Sandbox metadata passed to the tool runner. */
    readonly sandboxContext: ToolRunnerSandboxContext;
    /** Shared analysis start timestamp. */
    readonly startedAt: string;
  },
): Promise<ToolRunnerResult> {
  const span = input.traces?.startSpan(OBSERVABILITY_SPAN_NAMES.staticAnalysisRunTool, {
    attributes: {
      "app.repo_id": input.request.repoId,
      "app.review_run_id": input.request.reviewRunId,
      "static_analysis.expected_output_format": context.runPlan.expectedOutputFormat,
      "static_analysis.max_output_bytes": context.runPlan.maxOutputBytes,
      "static_analysis.mode": input.request.mode,
      "static_analysis.scope_kind": context.runPlan.scope.kind,
      "static_analysis.scope_path_count": context.runPlan.scope.paths.length,
      "static_analysis.timeout_ms": context.runPlan.timeoutMs,
      "static_analysis.tool": context.runPlan.tool,
      "static_analysis.workspace_trusted": input.request.workspace.isTrusted,
    },
    kind: "internal",
    traceContext: input.traceContext,
  });

  try {
    const result = await input.runner.run({
      command: context.runPlan.command,
      maxOutputBytes: context.runPlan.maxOutputBytes,
      planId: context.runPlan.planId,
      sandboxContext: context.sandboxContext,
      startedAt: context.startedAt,
      timeoutMs: context.runPlan.timeoutMs,
    });
    const status = toolRunStatus(result);
    recordStaticAnalysisToolMetrics(input.metrics, input.request, context.runPlan, result, status);
    span?.end({
      attributes: {
        "static_analysis.duration_ms": result.durationMs,
        "static_analysis.exit_code": result.exitCode ?? undefined,
        "static_analysis.stderr_bytes": result.stderrBytes,
        "static_analysis.stdout_bytes": result.stdoutBytes,
        "static_analysis.timed_out": result.timedOut,
        "static_analysis.tool_status": status,
        "static_analysis.truncated": result.truncated,
      },
      status: status === "succeeded" ? "ok" : "error",
    });

    return result;
  } catch (error) {
    span?.end({
      attributes: { "static_analysis.error_class": classifyTelemetryError(error) },
      error,
    });
    throw error;
  }
}

/** Parses one static-analysis tool output with product-safe telemetry. */
function parseToolOutputDiagnosticsWithTelemetry(
  input: RunStaticAnalysisInput,
  context: {
    /** Maximum diagnostics allowed for this tool. */
    readonly maxDiagnosticsPerTool: number;
    /** Tool runner result with bounded captured output. */
    readonly result: ToolRunnerResult;
    /** Static-analysis tool run plan. */
    readonly runPlan: ToolRunPlan;
    /** Stable tool run ID used by normalized diagnostics. */
    readonly toolRunId: string;
  },
): ParseToolOutputDiagnosticsResult {
  const span = input.traces?.startSpan(OBSERVABILITY_SPAN_NAMES.staticAnalysisParseOutput, {
    attributes: {
      "app.repo_id": input.request.repoId,
      "app.review_run_id": input.request.reviewRunId,
      "static_analysis.expected_output_format": context.runPlan.expectedOutputFormat,
      "static_analysis.max_diagnostics": context.maxDiagnosticsPerTool,
      "static_analysis.stderr_bytes": context.result.stderrBytes,
      "static_analysis.stdout_bytes": context.result.stdoutBytes,
      "static_analysis.tool": context.runPlan.tool,
    },
    kind: "internal",
    traceContext: input.traceContext,
  });

  try {
    const parsed = parseToolOutputDiagnostics({
      maxDiagnostics: context.maxDiagnosticsPerTool,
      result: context.result,
      snapshot: input.request.snapshot,
      tool: context.runPlan.tool,
      toolRunId: context.toolRunId,
      workspacePath: input.request.workspace.path,
    });
    const parseFailures = parsed.warnings.filter(isStaticAnalysisParseFailureWarning);
    for (const parseFailure of parseFailures) {
      input.metrics?.count(OBSERVABILITY_METRIC_NAMES.staticAnalysisParseFailuresTotal, {
        labels: {
          mode: input.request.mode,
          reason: parseFailure.code,
          tool: context.runPlan.tool,
        },
      });
    }
    span?.end({
      attributes: {
        "static_analysis.diagnostic_count": parsed.diagnostics.length,
        "static_analysis.parse_failure_count": parseFailures.length,
        "static_analysis.warning_count": parsed.warnings.length,
      },
      status: parseFailures.length > 0 ? "error" : "ok",
    });

    return parsed;
  } catch (error) {
    span?.end({
      attributes: { "static_analysis.error_class": classifyTelemetryError(error) },
      error,
    });
    throw error;
  }
}

/** Normalizes and budgets diagnostics from parsed output and deterministic fixtures. */
function normalizeStaticAnalysisDiagnosticsWithTelemetry(
  input: RunStaticAnalysisInput,
  context: {
    /** Maximum diagnostics allowed for this tool. */
    readonly maxDiagnosticsPerTool: number;
    /** Parsed diagnostics and warnings from tool output. */
    readonly parsedOutput: ParseToolOutputDiagnosticsResult;
    /** Tool runner result with bounded captured output. */
    readonly result: ToolRunnerResult;
    /** Static-analysis tool run plan. */
    readonly runPlan: ToolRunPlan;
    /** Stable tool run ID used by normalized diagnostics. */
    readonly toolRunId: string;
  },
): NormalizeStaticAnalysisDiagnosticsResult {
  const span = input.traces?.startSpan(
    OBSERVABILITY_SPAN_NAMES.staticAnalysisNormalizeDiagnostics,
    {
      attributes: {
        "app.repo_id": input.request.repoId,
        "app.review_run_id": input.request.reviewRunId,
        "static_analysis.max_diagnostics": context.maxDiagnosticsPerTool,
        "static_analysis.parsed_diagnostic_count": context.parsedOutput.diagnostics.length,
        "static_analysis.tool": context.runPlan.tool,
      },
      kind: "internal",
      traceContext: input.traceContext,
    },
  );

  try {
    const fixtureDiagnostics = (input.diagnosticsByTool?.[context.runPlan.tool] ?? []).map(
      (diagnostic) =>
        createNormalizedToolDiagnostic({
          ...diagnostic,
          toolRunId: context.toolRunId,
        }),
    );
    const diagnostics = [...context.parsedOutput.diagnostics, ...fixtureDiagnostics].slice(
      0,
      context.maxDiagnosticsPerTool,
    );
    const warnings: StaticAnalysisWarning[] = [];
    const wasTruncated =
      context.parsedOutput.diagnostics.length + fixtureDiagnostics.length > diagnostics.length;
    if (wasTruncated) {
      warnings.push(
        warning("tool_diagnostic_budget_truncated", "Static analysis diagnostics were truncated.", {
          maxDiagnosticsPerTool: context.maxDiagnosticsPerTool,
          tool: context.runPlan.tool,
          toolRunId: context.toolRunId,
        }),
      );
    }

    input.metrics?.count(OBSERVABILITY_METRIC_NAMES.staticAnalysisDiagnosticsTotal, {
      labels: {
        mode: input.request.mode,
        operation: "tool",
        status: toolRunStatus(context.result),
        tool: context.runPlan.tool,
      },
      value: diagnostics.length,
    });
    span?.end({
      attributes: {
        "static_analysis.diagnostic_count": diagnostics.length,
        "static_analysis.fixture_diagnostic_count": fixtureDiagnostics.length,
        "static_analysis.truncated": wasTruncated,
        "static_analysis.warning_count": warnings.length,
      },
    });

    return {
      diagnostics,
      toolRun: toolRunSummary({
        diagnostics,
        plan: context.runPlan,
        result: context.result,
        toolRunId: context.toolRunId,
      }),
      warnings,
    };
  } catch (error) {
    span?.end({
      attributes: { "static_analysis.error_class": classifyTelemetryError(error) },
      error,
    });
    throw error;
  }
}

/** Records aggregate static-analysis run metrics after completion or failure. */
function finishStaticAnalysisRunTelemetry(
  input: RunStaticAnalysisInput,
  context: {
    /** Wall-clock duration measured by the telemetry wrapper. */
    readonly durationMs: number;
    /** Error raised before a report could be built. */
    readonly error?: unknown;
    /** Completed static-analysis report. */
    readonly report?: StaticAnalysisReport;
  },
): void {
  const status = context.report?.status ?? "failed";
  const labels = staticAnalysisRunLabels(input.request, status);
  const metricLabels = context.error
    ? { ...labels, error_class: classifyTelemetryError(context.error) }
    : labels;

  input.metrics?.count(OBSERVABILITY_METRIC_NAMES.staticAnalysisRunsTotal, {
    labels: metricLabels,
  });
  input.metrics?.histogram(
    OBSERVABILITY_METRIC_NAMES.staticAnalysisDurationMs,
    context.durationMs,
    {
      labels,
      unit: "ms",
    },
  );
  if (context.report) {
    input.metrics?.count(OBSERVABILITY_METRIC_NAMES.staticAnalysisDiagnosticsTotal, {
      labels,
      value: context.report.summary.diagnosticCount,
    });
  }
}

/** Records per-tool duration, output, and timeout metrics. */
function recordStaticAnalysisToolMetrics(
  metrics: TelemetryMetricRecorder | undefined,
  request: StaticAnalysisRequest,
  runPlan: ToolRunPlan,
  result: ToolRunnerResult,
  status: ToolRunResultSummary["status"],
): void {
  const labels = staticAnalysisToolLabels(request, runPlan.tool, status);
  metrics?.histogram(OBSERVABILITY_METRIC_NAMES.staticAnalysisDurationMs, result.durationMs, {
    labels,
    unit: "ms",
  });
  metrics?.histogram(OBSERVABILITY_METRIC_NAMES.staticAnalysisOutputBytes, result.stdoutBytes, {
    labels: { ...labels, stream: "stdout" },
    unit: "bytes",
  });
  metrics?.histogram(OBSERVABILITY_METRIC_NAMES.staticAnalysisOutputBytes, result.stderrBytes, {
    labels: { ...labels, stream: "stderr" },
    unit: "bytes",
  });
  if (result.timedOut || status === "timed_out") {
    metrics?.count(OBSERVABILITY_METRIC_NAMES.staticAnalysisTimeoutsTotal, {
      labels,
    });
  }
}

/** Creates low-cardinality labels for aggregate static-analysis run metrics. */
function staticAnalysisRunLabels(
  request: StaticAnalysisRequest,
  status: StaticAnalysisTelemetryStatus,
): StaticAnalysisRunLabels {
  return {
    mode: request.mode,
    operation: "run",
    reason: request.reason,
    status,
  };
}

/** Creates low-cardinality labels for per-tool static-analysis metrics. */
function staticAnalysisToolLabels(
  request: StaticAnalysisRequest,
  tool: StaticToolName,
  status: ToolRunResultSummary["status"],
): StaticAnalysisToolLabels {
  return {
    mode: request.mode,
    operation: "tool",
    status,
    tool,
  };
}

/** Returns true when a warning represents a tool output parse failure. */
function isStaticAnalysisParseFailureWarning(warning: StaticAnalysisWarning): boolean {
  return (
    warning.code === "tool_output_parse_failed" || warning.code === "tool_output_schema_mismatch"
  );
}

/** Creates sandbox metadata for static-analysis tool runner requests. */
function sandboxContextForStaticAnalysis(request: StaticAnalysisRequest): ToolRunnerSandboxContext {
  return {
    baseSha: request.snapshot.baseSha,
    commitSha: request.workspace.commitSha,
    headSha: request.snapshot.headSha,
    orgId: request.orgId,
    repoId: request.repoId,
    reviewRunId: request.reviewRunId,
    staticAnalysisRunId: stableId("star", [request.reviewRunId, request.workspace.commitSha]),
    trustLevel: request.workspace.isTrusted ? "trusted_pr" : "untrusted_pr",
    workspaceId: request.workspace.workspaceId,
  };
}

/** Parses an unknown value as static-analysis budgets. */
export function parseStaticAnalysisBudgets(value: unknown): StaticAnalysisBudgets {
  if (!Value.Check(StaticAnalysisBudgetsSchema, value)) {
    throw new Error("Static analysis budgets do not match the schema.");
  }

  return value as StaticAnalysisBudgets;
}

/** Parses ESLint JSON formatter output into normalized diagnostics. */
function parseEslintJsonDiagnostics(
  input: ParseToolOutputDiagnosticsInput,
): ParseToolOutputDiagnosticsResult {
  const rawOutput = input.result.stdout.trim();
  if (rawOutput.length === 0) {
    return { diagnostics: [], warnings: [] };
  }

  const parsedOutput = parseJson(rawOutput);
  if (!parsedOutput.ok) {
    return {
      diagnostics: [],
      warnings: [
        warning("tool_output_parse_failed", "Static analysis could not parse tool output.", {
          format: "eslint_json",
          tool: input.tool,
          toolRunId: input.toolRunId,
        }),
      ],
    };
  }
  if (!Value.Check(EslintJsonOutputSchema, parsedOutput.value)) {
    return {
      diagnostics: [],
      warnings: [
        warning(
          "tool_output_schema_mismatch",
          "Static analysis tool output did not match the expected schema.",
          {
            format: "eslint_json",
            tool: input.tool,
            toolRunId: input.toolRunId,
          },
        ),
      ],
    };
  }

  const parsedDiagnostics = (parsedOutput.value as readonly EslintJsonFileResult[])
    .flatMap((fileResult) =>
      fileResult.messages.map((message) =>
        eslintMessageToDiagnostic({ fileResult, input, message }),
      ),
    )
    .filter(isPresent);
  const diagnostics = parsedDiagnostics.slice(0, input.maxDiagnostics);
  const warnings =
    parsedDiagnostics.length > diagnostics.length
      ? [
          warning(
            "tool_output_diagnostic_budget_truncated",
            "Static analysis tool output diagnostics were truncated.",
            {
              diagnosticCount: parsedDiagnostics.length,
              maxDiagnostics: input.maxDiagnostics,
              tool: input.tool,
              toolRunId: input.toolRunId,
            },
          ),
        ]
      : [];

  return { diagnostics, warnings };
}

/** Parses Biome JSON reporter output into normalized diagnostics. */
function parseBiomeJsonDiagnostics(
  input: ParseToolOutputDiagnosticsInput,
): ParseToolOutputDiagnosticsResult {
  const rawOutput = input.result.stdout.trim();
  if (rawOutput.length === 0) {
    return { diagnostics: [], warnings: [] };
  }

  const parsedOutput = parseJson(rawOutput);
  if (!parsedOutput.ok) {
    return {
      diagnostics: [],
      warnings: [
        warning("tool_output_parse_failed", "Static analysis could not parse tool output.", {
          format: "biome_json",
          tool: input.tool,
          toolRunId: input.toolRunId,
        }),
      ],
    };
  }
  if (!Value.Check(BiomeJsonOutputSchema, parsedOutput.value)) {
    return {
      diagnostics: [],
      warnings: [
        warning(
          "tool_output_schema_mismatch",
          "Static analysis tool output did not match the expected schema.",
          {
            format: "biome_json",
            tool: input.tool,
            toolRunId: input.toolRunId,
          },
        ),
      ],
    };
  }

  const parsedDiagnostics = (
    parsedOutput.value as { diagnostics: readonly BiomeJsonDiagnostic[] }
  ).diagnostics
    .map((diagnostic) => biomeDiagnosticToNormalizedDiagnostic({ diagnostic, input }))
    .filter(isPresent);
  const diagnostics = parsedDiagnostics.slice(0, input.maxDiagnostics);
  const warnings =
    parsedDiagnostics.length > diagnostics.length
      ? [
          warning(
            "tool_output_diagnostic_budget_truncated",
            "Static analysis tool output diagnostics were truncated.",
            {
              diagnosticCount: parsedDiagnostics.length,
              maxDiagnostics: input.maxDiagnostics,
              tool: input.tool,
              toolRunId: input.toolRunId,
            },
          ),
        ]
      : [];

  return { diagnostics, warnings };
}

/** Parses `tsc --pretty false` output into normalized diagnostics. */
function parseTypeScriptTextDiagnostics(
  input: ParseToolOutputDiagnosticsInput,
): ParseToolOutputDiagnosticsResult {
  const rawOutput = [input.result.stdout, input.result.stderr]
    .map((stream) => stream.trim())
    .filter((stream) => stream.length > 0)
    .join("\n");
  if (rawOutput.length === 0) {
    return { diagnostics: [], warnings: [] };
  }

  const parsedDiagnostics = rawOutput
    .split(/\r?\n/u)
    .map(parseTypeScriptDiagnosticLine)
    .filter(isPresent)
    .map((diagnostic) => typeScriptDiagnosticToNormalizedDiagnostic(input, diagnostic));
  const diagnostics = parsedDiagnostics.slice(0, input.maxDiagnostics);
  const warnings: StaticAnalysisWarning[] = [];

  if (parsedDiagnostics.length === 0) {
    warnings.push(
      warning("tool_output_parse_failed", "Static analysis could not parse tool output.", {
        format: "typescript_text",
        tool: input.tool,
        toolRunId: input.toolRunId,
      }),
    );
  }
  if (parsedDiagnostics.length > diagnostics.length) {
    warnings.push(
      warning(
        "tool_output_diagnostic_budget_truncated",
        "Static analysis tool output diagnostics were truncated.",
        {
          diagnosticCount: parsedDiagnostics.length,
          maxDiagnostics: input.maxDiagnostics,
          tool: input.tool,
          toolRunId: input.toolRunId,
        },
      ),
    );
  }

  return { diagnostics, warnings };
}

/** Parses one TypeScript text diagnostic line. */
function parseTypeScriptDiagnosticLine(line: string): TypeScriptTextDiagnostic | undefined {
  const match = TYPESCRIPT_TEXT_DIAGNOSTIC_PATTERN.exec(line.trim());
  const groups = match?.groups;
  if (!groups) {
    return undefined;
  }

  return {
    code: groups.code ?? "",
    column: Math.max(1, Number.parseInt(groups.column ?? "1", 10)),
    filePath: groups.filePath ?? "",
    line: Math.max(1, Number.parseInt(groups.line ?? "1", 10)),
    message: groups.message ?? "",
    severity: groups.severity === "warning" ? "warning" : "error",
  };
}

/** Converts one parsed TypeScript diagnostic into the normalized report shape. */
function typeScriptDiagnosticToNormalizedDiagnostic(
  input: ParseToolOutputDiagnosticsInput,
  diagnostic: TypeScriptTextDiagnostic,
): NormalizedToolDiagnostic {
  const filePath = normalizeToolFilePath(diagnostic.filePath, input.workspacePath);
  const ruleId = `TS${diagnostic.code}`;

  return createNormalizedToolDiagnostic({
    category: "correctness",
    location: {
      filePath,
      startColumn: diagnostic.column,
      startLine: diagnostic.line,
      ...(filePath === diagnostic.filePath ? {} : { originalPath: diagnostic.filePath }),
    },
    message: diagnostic.message,
    metadata: { diagnosticCode: ruleId },
    rawMessage: diagnostic.message,
    ruleId,
    severity: diagnostic.severity,
    snapshot: input.snapshot,
    sourceTrust: "parsed_text",
    tool: "typescript",
    toolRunId: input.toolRunId,
  });
}

/** Converts one ESLint JSON message into a normalized diagnostic. */
function eslintMessageToDiagnostic(input: {
  readonly fileResult: EslintJsonFileResult;
  readonly input: ParseToolOutputDiagnosticsInput;
  readonly message: EslintJsonMessage;
}): NormalizedToolDiagnostic | undefined {
  const message = input.message.message.trim();
  if (message.length === 0) {
    return undefined;
  }

  const severity = eslintSeverity(input.message);
  const filePath = normalizeToolFilePath(input.fileResult.filePath, input.input.workspacePath);
  const ruleUrl = eslintRuleUrl(input.message.ruleId ?? undefined);
  return createNormalizedToolDiagnostic({
    category: categoryForEslintRule(input.message.ruleId ?? undefined, severity),
    location: {
      filePath,
      ...(input.message.column !== undefined
        ? { startColumn: Math.max(1, input.message.column) }
        : {}),
      startLine: Math.max(1, input.message.line ?? 1),
      ...(input.message.endColumn !== undefined
        ? { endColumn: Math.max(1, input.message.endColumn) }
        : {}),
      ...(input.message.endLine !== undefined
        ? { endLine: Math.max(1, input.message.endLine) }
        : {}),
      ...(filePath === input.fileResult.filePath
        ? {}
        : { originalPath: input.fileResult.filePath }),
    },
    message,
    metadata: eslintMessageMetadata(input.message),
    rawMessage: input.message.message,
    ...(input.message.ruleId ? { ruleId: input.message.ruleId } : {}),
    ...(ruleUrl ? { ruleUrl } : {}),
    severity,
    snapshot: input.input.snapshot,
    sourceTrust: "tool_output",
    tool: "eslint",
    toolRunId: input.input.toolRunId,
  });
}

/** Converts one Biome JSON diagnostic into the normalized report shape. */
function biomeDiagnosticToNormalizedDiagnostic(input: {
  /** Biome diagnostic emitted by the JSON reporter. */
  readonly diagnostic: BiomeJsonDiagnostic;
  /** Static-analysis parser input. */
  readonly input: ParseToolOutputDiagnosticsInput;
}): NormalizedToolDiagnostic | undefined {
  const message = input.diagnostic.message.trim();
  const location = input.diagnostic.location;
  const startLine = location?.start?.line ?? 0;
  if (!location?.path || message.length === 0 || startLine < 1) {
    return undefined;
  }

  const filePath = normalizeToolFilePath(location.path, input.input.workspacePath);
  const severity = biomeSeverity(input.diagnostic.severity);
  const ruleId = input.diagnostic.category?.trim();

  return createNormalizedToolDiagnostic({
    category: categoryForBiomeDiagnostic(ruleId, severity),
    location: {
      filePath,
      ...(location.start?.column !== undefined
        ? { startColumn: Math.max(1, location.start.column) }
        : {}),
      startLine,
      ...(location.end?.column !== undefined
        ? { endColumn: Math.max(1, location.end.column) }
        : {}),
      ...(location.end?.line !== undefined && location.end.line > 0
        ? { endLine: location.end.line }
        : {}),
      ...(filePath === location.path ? {} : { originalPath: location.path }),
    },
    message,
    metadata: biomeDiagnosticMetadata(input.diagnostic),
    rawMessage: input.diagnostic.message,
    ...(ruleId ? { ruleId, ruleName: biomeRuleName(ruleId) } : {}),
    severity,
    snapshot: input.input.snapshot,
    sourceTrust: "tool_output",
    tool: "biome",
    toolRunId: input.input.toolRunId,
  });
}

/** Parses JSON without throwing into the report builder. */
function parseJson(
  value: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  try {
    return { ok: true, value: JSON.parse(value) as unknown };
  } catch {
    return { ok: false };
  }
}

/** Maps ESLint severity numbers to normalized diagnostic severities. */
function eslintSeverity(message: EslintJsonMessage): ToolDiagnosticSeverity {
  if (message.fatal || message.severity === 2) return "error";
  if (message.severity === 1) return "warning";
  return "info";
}

/** Maps Biome severity strings to normalized diagnostic severities. */
function biomeSeverity(severity: string): ToolDiagnosticSeverity {
  const normalizedSeverity = severity.toLowerCase();
  if (normalizedSeverity === "fatal") return "critical";
  if (normalizedSeverity === "error") return "error";
  if (normalizedSeverity === "warning" || normalizedSeverity === "warn") return "warning";
  return "info";
}

/** Returns a product category for an ESLint rule. */
function categoryForEslintRule(
  ruleId: string | undefined,
  severity: ToolDiagnosticSeverity,
): FindingCategory {
  const normalizedRule = ruleId?.toLowerCase() ?? "";
  if (normalizedRule.includes("security")) return "security";
  if (
    normalizedRule.includes("import/no-extraneous-dependencies") ||
    normalizedRule.includes("node/no-missing-import")
  ) {
    return "dependency";
  }
  if (
    /(?:style|stylistic|prettier|quotes|semi|indent|spacing|space|comma|eol|max-len)/u.test(
      normalizedRule,
    )
  ) {
    return "style";
  }
  if (/(?:performance|no-await-in-loop)/u.test(normalizedRule)) return "performance";

  return categoryForSeverity(severity);
}

/** Returns a product category for a Biome diagnostic category. */
function categoryForBiomeDiagnostic(
  category: string | undefined,
  severity: ToolDiagnosticSeverity,
): FindingCategory {
  const normalizedCategory = category?.toLowerCase() ?? "";
  if (normalizedCategory.includes("security")) return "security";
  if (normalizedCategory.includes("performance")) return "performance";
  if (normalizedCategory.startsWith("format") || normalizedCategory.includes("style")) {
    return "style";
  }
  if (
    normalizedCategory.includes("correctness") ||
    normalizedCategory.includes("suspicious") ||
    normalizedCategory.includes("a11y")
  ) {
    return "correctness";
  }
  if (normalizedCategory.includes("nursery") || normalizedCategory.includes("complexity")) {
    return "maintainability";
  }

  return categoryForSeverity(severity);
}

/** Builds a documentation URL for core ESLint rules. */
function eslintRuleUrl(ruleId: string | undefined): string | undefined {
  if (!ruleId || ruleId.includes("/") || ruleId.startsWith("@")) {
    return undefined;
  }

  return `https://eslint.org/docs/latest/rules/${encodeURIComponent(ruleId)}`;
}

/** Returns product-safe metadata for an ESLint message. */
function eslintMessageMetadata(message: EslintJsonMessage): Readonly<Record<string, unknown>> {
  return {
    ...(message.fatal !== undefined ? { fatal: message.fatal } : {}),
    ...(message.messageId ? { messageId: message.messageId } : {}),
  };
}

/** Returns product-safe metadata for a Biome diagnostic. */
function biomeDiagnosticMetadata(
  diagnostic: BiomeJsonDiagnostic,
): Readonly<Record<string, unknown>> {
  return {
    ...(diagnostic.category ? { category: diagnostic.category } : {}),
  };
}

/** Returns a compact Biome rule name from a diagnostic category. */
function biomeRuleName(category: string): string {
  const parts = category.split("/").filter((part) => part.length > 0);
  return parts.at(-1) ?? category;
}

/** Normalizes a tool-emitted file path to a repository-relative path when possible. */
function normalizeToolFilePath(filePath: string, workspacePath: string): string {
  const normalizedFilePath = filePath.replaceAll("\\", "/");
  const normalizedWorkspacePath = workspacePath.replaceAll("\\", "/").replace(/\/+$/u, "");
  if (
    normalizedWorkspacePath.length > 0 &&
    normalizedFilePath.startsWith(`${normalizedWorkspacePath}/`)
  ) {
    return normalizedFilePath.slice(normalizedWorkspacePath.length + 1);
  }

  return normalizedFilePath.replace(/^\/+/u, "");
}

/** Returns true when a value is not undefined. */
function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined;
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
    preferredOutputFormat: name === "typescript" ? "text" : "json",
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
    rawOutputPolicy: STATIC_ANALYSIS_RAW_OUTPUT_POLICY,
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
