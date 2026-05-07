import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { EvalHistoryWrite } from "@repo/db";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/** Schema version emitted by evaluation suite fixtures. */
export const EVAL_SUITE_SCHEMA_VERSION = "eval_suite.v1" as const;

/** Schema version emitted by evaluation reports. */
export const EVAL_REPORT_SCHEMA_VERSION = "eval_report.v1" as const;

/** Schema version emitted by portable human-label export files. */
export const EVAL_HUMAN_LABEL_FILE_SCHEMA_VERSION = "eval_human_labels.v1" as const;

/** Published finding categories understood by the MVP grader. */
export const EvalFindingCategorySchema = Type.Union([
  Type.Literal("correctness"),
  Type.Literal("security"),
  Type.Literal("performance"),
  Type.Literal("test_coverage"),
  Type.Literal("maintainability"),
  Type.Literal("architecture"),
  Type.Literal("dependency"),
  Type.Literal("documentation"),
  Type.Literal("style"),
  Type.Literal("other"),
]);

/** Published finding severities understood by the MVP grader. */
export const EvalFindingSeveritySchema = Type.Union([
  Type.Literal("info"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("critical"),
]);

/** Location for an expected or actual finding in a fixture PR. */
export const EvalFindingLocationSchema = Type.Object({
  path: Type.String({ minLength: 1 }),
  line: Type.Integer({ minimum: 1 }),
});

/** Type for a finding location in a fixture PR. */
export type EvalFindingLocation = Static<typeof EvalFindingLocationSchema>;

/** Changed file metadata used by anchor grading. */
export const EvalChangedFileSchema = Type.Object({
  path: Type.String({ minLength: 1 }),
  changeType: Type.Union([
    Type.Literal("added"),
    Type.Literal("modified"),
    Type.Literal("renamed"),
    Type.Literal("deleted"),
    Type.Literal("generated"),
  ]),
  reviewableLines: Type.Array(Type.Integer({ minimum: 1 })),
});

/** Type for changed file metadata used by anchor grading. */
export type EvalChangedFile = Static<typeof EvalChangedFileSchema>;

/** Expected context item that retrieval should provide for one eval case. */
export const EvalExpectedContextSchema = Type.Object({
  label: Type.String({ minLength: 1 }),
  path: Type.String({ minLength: 1 }),
  keywords: Type.Array(Type.String({ minLength: 1 })),
});

/** Type for expected context that retrieval should provide. */
export type EvalExpectedContext = Static<typeof EvalExpectedContextSchema>;

/** Retrieved context item produced by a fixture runner. */
export const EvalRetrievedContextSchema = Type.Object({
  label: Type.String({ minLength: 1 }),
  path: Type.String({ minLength: 1 }),
  text: Type.String(),
  rank: Type.Integer({ minimum: 1 }),
});

/** Type for retrieved context produced by a fixture runner. */
export type EvalRetrievedContext = Static<typeof EvalRetrievedContextSchema>;

/** Expected finding label used by exact matching and anchor grading. */
export const EvalExpectedFindingSchema = Type.Object({
  expectedFindingId: Type.String({ minLength: 1 }),
  title: Type.String({ minLength: 1 }),
  category: EvalFindingCategorySchema,
  severity: EvalFindingSeveritySchema,
  location: EvalFindingLocationSchema,
  bodyKeywords: Type.Array(Type.String({ minLength: 1 })),
  maxLineDistance: Type.Integer({ minimum: 0 }),
});

/** Type for an expected finding label. */
export type EvalExpectedFinding = Static<typeof EvalExpectedFindingSchema>;

/** Actual finding output produced by a deterministic fixture runner. */
export const EvalActualFindingSchema = Type.Object({
  findingId: Type.String({ minLength: 1 }),
  title: Type.String({ minLength: 1 }),
  body: Type.String({ minLength: 1 }),
  category: EvalFindingCategorySchema,
  severity: EvalFindingSeveritySchema,
  location: EvalFindingLocationSchema,
});

/** Type for actual finding output produced by a deterministic fixture runner. */
export type EvalActualFinding = Static<typeof EvalActualFindingSchema>;

/** Thresholds used by CI gates for one evaluation suite. */
export const EvalMetricThresholdsSchema = Type.Object({
  minWeightedRecall: Type.Number({ minimum: 0, maximum: 1 }),
  minPublishedPrecision: Type.Number({ minimum: 0, maximum: 1 }),
  maxFalsePositiveRate: Type.Number({ minimum: 0, maximum: 1 }),
  minAnchorValidity: Type.Number({ minimum: 0, maximum: 1 }),
  minRetrievalRecallAt10: Type.Number({ minimum: 0, maximum: 1 }),
  maxMeanCostUsd: Type.Number({ minimum: 0 }),
  maxP95LatencyMs: Type.Number({ minimum: 0 }),
});

/** Type for CI gate thresholds for one evaluation suite. */
export type EvalMetricThresholds = Static<typeof EvalMetricThresholdsSchema>;

/** One curated fixture PR case. */
export const EvalCaseSchema = Type.Object({
  caseId: Type.String({ minLength: 1 }),
  title: Type.String({ minLength: 1 }),
  description: Type.String({ minLength: 1 }),
  tags: Type.Array(Type.String({ minLength: 1 })),
  changedFiles: Type.Array(EvalChangedFileSchema),
  expectedContexts: Type.Array(EvalExpectedContextSchema),
  retrievedContexts: Type.Array(EvalRetrievedContextSchema),
  expectedFindings: Type.Array(EvalExpectedFindingSchema),
  actualFindings: Type.Array(EvalActualFindingSchema),
  latencyMs: Type.Number({ minimum: 0 }),
  costUsd: Type.Number({ minimum: 0 }),
});

/** Type for one curated fixture PR case. */
export type EvalCase = Static<typeof EvalCaseSchema>;

/** Human label correctness decision for one generated finding. */
export const EvalHumanCorrectnessSchema = Type.Union([
  Type.Literal("correct"),
  Type.Literal("partially_correct"),
  Type.Literal("incorrect"),
]);

/** Type for a human label correctness decision. */
export type EvalHumanCorrectness = Static<typeof EvalHumanCorrectnessSchema>;

/** Human label usefulness score for one generated finding. */
export const EvalHumanUsefulnessSchema = Type.Union([
  Type.Literal(1),
  Type.Literal(2),
  Type.Literal(3),
  Type.Literal(4),
  Type.Literal(5),
]);

/** Type for a human label usefulness score. */
export type EvalHumanUsefulness = Static<typeof EvalHumanUsefulnessSchema>;

/** Human label payload used to calibrate automated finding graders. */
export const EvalHumanFindingLabelSchema = Type.Object(
  {
    anchorAppropriate: Type.Boolean(),
    categoryAppropriate: Type.Boolean(),
    correctness: EvalHumanCorrectnessSchema,
    evidenceAccurate: Type.Boolean(),
    fixUseful: Type.Boolean(),
    notes: Type.Optional(Type.String()),
    severityAppropriate: Type.Boolean(),
    shouldPublish: Type.Boolean(),
    usefulness: EvalHumanUsefulnessSchema,
  },
  { additionalProperties: false },
);

/** Type for a human label payload used to calibrate automated finding graders. */
export type EvalHumanFindingLabel = Static<typeof EvalHumanFindingLabelSchema>;

/** Adjudication state for a human label row. */
export const EvalHumanLabelAdjudicationStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("adjudicated"),
  Type.Literal("disputed"),
  Type.Literal("rejected"),
]);

/** Type for the adjudication state of a human label row. */
export type EvalHumanLabelAdjudicationStatus = Static<
  typeof EvalHumanLabelAdjudicationStatusSchema
>;

/** Portable human label record for import, export, and DB persistence. */
export const EvalHumanLabelRecordSchema = Type.Object(
  {
    adjudicationStatus: EvalHumanLabelAdjudicationStatusSchema,
    createdAt: Type.Optional(Type.String({ minLength: 1 })),
    evalCaseId: Type.String({ minLength: 1 }),
    evalHumanLabelId: Type.String({ minLength: 1 }),
    findingFingerprint: Type.Optional(Type.String({ minLength: 1 })),
    label: EvalHumanFindingLabelSchema,
    labelerUserId: Type.Optional(Type.String({ minLength: 1 })),
    updatedAt: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

/** Type for a portable human label record. */
export type EvalHumanLabelRecord = Static<typeof EvalHumanLabelRecordSchema>;

/** Portable human label file used by CLI import and export commands. */
export const EvalHumanLabelFileSchema = Type.Object(
  {
    exportedAt: Type.String({ minLength: 1 }),
    labels: Type.Array(EvalHumanLabelRecordSchema),
    schemaVersion: Type.Literal(EVAL_HUMAN_LABEL_FILE_SCHEMA_VERSION),
    suiteId: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

/** Type for a portable human label file. */
export type EvalHumanLabelFile = Static<typeof EvalHumanLabelFileSchema>;

/** Versioned evaluation suite fixture. */
export const EvalSuiteSchema = Type.Object({
  schemaVersion: Type.Literal(EVAL_SUITE_SCHEMA_VERSION),
  suiteId: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  description: Type.String({ minLength: 1 }),
  thresholds: EvalMetricThresholdsSchema,
  cases: Type.Array(EvalCaseSchema, { minItems: 1 }),
});

/** Type for a versioned evaluation suite fixture. */
export type EvalSuite = Static<typeof EvalSuiteSchema>;

/** Evaluation variant metadata for the current run. */
export const EvalVariantSchema = Type.Object({
  variantId: Type.String({ minLength: 1 }),
  label: Type.String({ minLength: 1 }),
  liveModel: Type.Boolean(),
});

/** Type for evaluation variant metadata for the current run. */
export type EvalVariant = Static<typeof EvalVariantSchema>;

/** Safe metrics for one evaluated case. */
export const EvalCaseMetricsSchema = Type.Object({
  expectedFindings: Type.Integer({ minimum: 0 }),
  matchedFindings: Type.Integer({ minimum: 0 }),
  actualFindings: Type.Integer({ minimum: 0 }),
  falsePositives: Type.Integer({ minimum: 0 }),
  anchorChecked: Type.Integer({ minimum: 0 }),
  anchorValid: Type.Integer({ minimum: 0 }),
  retrievalExpected: Type.Integer({ minimum: 0 }),
  retrievalMatched: Type.Integer({ minimum: 0 }),
  latencyMs: Type.Number({ minimum: 0 }),
  costUsd: Type.Number({ minimum: 0 }),
});

/** Type for safe metrics for one evaluated case. */
export type EvalCaseMetrics = Static<typeof EvalCaseMetricsSchema>;

/** Evaluation result for one case without raw code or context text. */
export const EvalCaseResultSchema = Type.Object({
  caseId: Type.String({ minLength: 1 }),
  title: Type.String({ minLength: 1 }),
  status: Type.Union([Type.Literal("pass"), Type.Literal("fail")]),
  metrics: EvalCaseMetricsSchema,
  matchedExpectedFindingIds: Type.Array(Type.String({ minLength: 1 })),
  missedExpectedFindingIds: Type.Array(Type.String({ minLength: 1 })),
  falsePositiveFindingIds: Type.Array(Type.String({ minLength: 1 })),
  invalidAnchorFindingIds: Type.Array(Type.String({ minLength: 1 })),
  matchedContextLabels: Type.Array(Type.String({ minLength: 1 })),
  missedContextLabels: Type.Array(Type.String({ minLength: 1 })),
  failureReasons: Type.Array(Type.String({ minLength: 1 })),
});

/** Type for evaluation result for one case. */
export type EvalCaseResult = Static<typeof EvalCaseResultSchema>;

/** Aggregated report metrics safe to print in CI logs. */
export const EvalReportMetricsSchema = Type.Object({
  cases: Type.Integer({ minimum: 0 }),
  expectedFindings: Type.Integer({ minimum: 0 }),
  matchedFindings: Type.Integer({ minimum: 0 }),
  actualFindings: Type.Integer({ minimum: 0 }),
  falsePositives: Type.Integer({ minimum: 0 }),
  weightedRecall: Type.Number({ minimum: 0, maximum: 1 }),
  publishedPrecision: Type.Number({ minimum: 0, maximum: 1 }),
  falsePositiveRate: Type.Number({ minimum: 0, maximum: 1 }),
  anchorValidity: Type.Number({ minimum: 0, maximum: 1 }),
  retrievalRecallAt10: Type.Number({ minimum: 0, maximum: 1 }),
  meanCostUsd: Type.Number({ minimum: 0 }),
  p95LatencyMs: Type.Number({ minimum: 0 }),
});

/** Type for aggregated report metrics. */
export type EvalReportMetrics = Static<typeof EvalReportMetricsSchema>;

/** One threshold check in an evaluation gate. */
export const EvalGateCheckSchema = Type.Object({
  metric: Type.String({ minLength: 1 }),
  actual: Type.Number(),
  threshold: Type.Number(),
  comparator: Type.Union([Type.Literal(">="), Type.Literal("<=")]),
  status: Type.Union([Type.Literal("pass"), Type.Literal("fail")]),
});

/** Type for one threshold check in an evaluation gate. */
export type EvalGateCheck = Static<typeof EvalGateCheckSchema>;

/** CI gate result for an evaluation report. */
export const EvalGateResultSchema = Type.Object({
  status: Type.Union([Type.Literal("pass"), Type.Literal("fail")]),
  checks: Type.Array(EvalGateCheckSchema),
});

/** Type for a CI gate result for an evaluation report. */
export type EvalGateResult = Static<typeof EvalGateResultSchema>;

/** Evaluation report emitted as JSON and Markdown artifacts. */
export const EvalReportSchema = Type.Object({
  schemaVersion: Type.Literal(EVAL_REPORT_SCHEMA_VERSION),
  evalRunId: Type.String({ minLength: 1 }),
  suiteId: Type.String({ minLength: 1 }),
  variant: EvalVariantSchema,
  startedAt: Type.String({ minLength: 1 }),
  completedAt: Type.String({ minLength: 1 }),
  metrics: EvalReportMetricsSchema,
  gate: EvalGateResultSchema,
  caseResults: Type.Array(EvalCaseResultSchema),
});

/** Type for an evaluation report emitted as artifacts. */
export type EvalReport = Static<typeof EvalReportSchema>;

/** Input for a deterministic evaluation run. */
export type RunEvaluationInput = {
  /** Evaluation suite to run. */
  readonly suite: EvalSuite;
  /** Variant metadata to include in the report. */
  readonly variant?: EvalVariant;
  /** Clock value for deterministic tests. */
  readonly timestamp?: string;
};

/** Paths written for one evaluation report artifact set. */
export type EvalReportArtifacts = {
  /** Absolute path to the HTML report. */
  readonly htmlPath: string;
  /** Absolute path to the JSON report. */
  readonly jsonPath: string;
  /** Absolute path to the JUnit XML report. */
  readonly junitPath: string;
  /** Absolute path to the Markdown report. */
  readonly markdownPath: string;
};

/** Input for converting an eval report into durable history rows. */
export type BuildEvalHistoryWriteInput = {
  /** Suite used to produce the report. */
  readonly suite: EvalSuite;
  /** Report to persist. */
  readonly report: EvalReport;
  /** Optional report artifacts to link from history rows. */
  readonly artifacts?: EvalReportArtifacts;
  /** Actor or system that triggered the eval run. */
  readonly triggeredBy?: string;
  /** Runtime environment where the eval ran. */
  readonly environment?: string;
  /** Optional commit SHA evaluated by this run. */
  readonly gitCommitSha?: string;
  /** Optional branch evaluated by this run. */
  readonly branch?: string;
  /** Owner label to persist with the suite row. */
  readonly suiteOwner?: string;
  /** Version label to persist with the suite row. */
  readonly suiteVersion?: string;
  /** Whether this run should become the active baseline for its suite and variant. */
  readonly setAsActiveBaseline?: boolean;
};

/** Product-safe artifact reference persisted with eval history rows. */
export type EvalHistoryArtifactRef = {
  /** Artifact kind. */
  readonly kind: "html" | "json" | "junit" | "markdown";
  /** Artifact display name. */
  readonly name: string;
  /** File URI for the artifact. */
  readonly uri: string;
};

/** Input for adding a reviewed eval case to a suite fixture. */
export type ImportEvalCaseIntoSuiteInput = {
  /** Suite that should receive the case. */
  readonly suite: EvalSuite;
  /** Reviewed eval case to add to the suite. */
  readonly evalCase: EvalCase;
  /** Whether an existing case with the same ID may be replaced. */
  readonly replaceExisting?: boolean;
};

/** Result of importing an eval case into a suite fixture. */
export type ImportEvalCaseIntoSuiteResult = {
  /** Updated suite fixture. */
  readonly suite: EvalSuite;
  /** Whether the case was newly inserted. */
  readonly inserted: boolean;
  /** Whether an existing case was replaced. */
  readonly replaced: boolean;
  /** Number of cases in the updated suite. */
  readonly caseCount: number;
};

/** Input for building a portable human-label file. */
export type CreateEvalHumanLabelFileInput = {
  /** Timestamp recorded in the exported label file. */
  readonly exportedAt?: string;
  /** Human labels to include in the file. */
  readonly labels: readonly EvalHumanLabelRecord[];
  /** Optional suite ID associated with the labels. */
  readonly suiteId?: string;
};

/** Baseline comparison output for candidate and baseline reports. */
export type EvalReportComparison = {
  /** Baseline report ID. */
  readonly baselineEvalRunId: string;
  /** Baseline report metrics. */
  readonly baselineMetrics: EvalReportMetrics;
  /** Case-level comparison rows. */
  readonly caseComparisons: readonly EvalCaseComparison[];
  /** Candidate report metrics. */
  readonly candidateMetrics: EvalReportMetrics;
  /** Candidate report ID. */
  readonly candidateEvalRunId: string;
  /** Case IDs where the candidate improves quality or reduces noise. */
  readonly improvedCaseIds: readonly string[];
  /** Metric deltas where positive means the candidate metric is larger. */
  readonly metricDeltas: Readonly<Record<keyof EvalReportMetrics, number>>;
  /** Expected findings that were missed in baseline and matched in candidate. */
  readonly newTruePositives: readonly string[];
  /** Expected findings that were matched in baseline and missed in candidate. */
  readonly lostTruePositives: readonly string[];
  /** Candidate false positives that were not present in baseline. */
  readonly newFalsePositives: readonly string[];
  /** Baseline false positives that were removed by the candidate. */
  readonly resolvedFalsePositives: readonly string[];
  /** Case IDs where the candidate loses quality or adds noise. */
  readonly regressedCaseIds: readonly string[];
  /** Whether the candidate passes its configured gate and has no lost findings. */
  readonly status: "pass" | "fail";
};

/** Case-level baseline comparison output. */
export type EvalCaseComparison = {
  /** Baseline case status. */
  readonly baselineStatus?: EvalCaseResult["status"] | undefined;
  /** Candidate case status. */
  readonly candidateStatus?: EvalCaseResult["status"] | undefined;
  /** Case ID. */
  readonly caseId: string;
  /** Candidate metric deltas for this case. */
  readonly metricDeltas: Readonly<Record<keyof EvalCaseMetrics, number>>;
  /** Expected findings matched only by the candidate. */
  readonly newTruePositives: readonly string[];
  /** Candidate false positives that were absent in baseline. */
  readonly newFalsePositives: readonly string[];
  /** Baseline false positives removed by the candidate. */
  readonly resolvedFalsePositives: readonly string[];
  /** Expected findings lost by the candidate. */
  readonly lostTruePositives: readonly string[];
  /** Case comparison status. */
  readonly status: "improved" | "regressed" | "unchanged";
};

/** Report metric names rendered in stable comparison order. */
const evalReportMetricNames = [
  "cases",
  "expectedFindings",
  "matchedFindings",
  "actualFindings",
  "falsePositives",
  "weightedRecall",
  "publishedPrecision",
  "falsePositiveRate",
  "anchorValidity",
  "retrievalRecallAt10",
  "meanCostUsd",
  "p95LatencyMs",
] as const satisfies readonly (keyof EvalReportMetrics)[];

/** Case metric names rendered in stable comparison order. */
const evalCaseMetricNames = [
  "expectedFindings",
  "matchedFindings",
  "actualFindings",
  "falsePositives",
  "anchorChecked",
  "anchorValid",
  "retrievalExpected",
  "retrievalMatched",
  "latencyMs",
  "costUsd",
] as const satisfies readonly (keyof EvalCaseMetrics)[];

/** Report metrics formatted as rates in comparison output. */
const rateMetricNames = new Set<keyof EvalReportMetrics>([
  "weightedRecall",
  "publishedPrecision",
  "falsePositiveRate",
  "anchorValidity",
  "retrievalRecallAt10",
]);

/** Validation error raised when eval boundary data fails schema checks. */
export class EvalValidationError extends Error {
  /** Name of the schema that rejected the value. */
  public readonly schemaName: string;

  /** Creates an eval validation error. */
  public constructor(schemaName: string, details: string) {
    super(`${schemaName} validation failed: ${details}`);
    this.name = "EvalValidationError";
    this.schemaName = schemaName;
  }
}

/** Loads and validates a registered suite fixture by ID. */
export async function loadRegisteredEvalSuite(suiteId: string): Promise<EvalSuite> {
  return loadEvalSuiteFromFile(defaultSuitePath(suiteId));
}

/** Loads and validates an eval suite from a JSON file. */
export async function loadEvalSuiteFromFile(filePath: string): Promise<EvalSuite> {
  const text = await readFile(filePath, "utf8");
  return parseEvalSuite(JSON.parse(text) as unknown);
}

/** Validates unknown data as an eval suite. */
export function parseEvalSuite(value: unknown): EvalSuite {
  return parseWithSchema("EvalSuite", EvalSuiteSchema, value);
}

/** Validates unknown data as one eval case. */
export function parseEvalCase(value: unknown): EvalCase {
  return parseWithSchema("EvalCase", EvalCaseSchema, value);
}

/** Extracts an eval case from a raw case file or admin eval import draft. */
export function parseEvalCaseImportSource(value: unknown): EvalCase {
  const record = asRecord(value);
  if (record?.schemaVersion === "admin_eval_import_draft.v1" && "evalCase" in record) {
    return parseEvalCase(record.evalCase);
  }

  return parseEvalCase(value);
}

/** Validates unknown data as a human finding label payload. */
export function parseEvalHumanFindingLabel(value: unknown): EvalHumanFindingLabel {
  return parseWithSchema("EvalHumanFindingLabel", EvalHumanFindingLabelSchema, value);
}

/** Validates unknown data as a portable human label record. */
export function parseEvalHumanLabelRecord(value: unknown): EvalHumanLabelRecord {
  return parseWithSchema("EvalHumanLabelRecord", EvalHumanLabelRecordSchema, value);
}

/** Validates unknown data as a portable human label file. */
export function parseEvalHumanLabelFile(value: unknown): EvalHumanLabelFile {
  return parseWithSchema("EvalHumanLabelFile", EvalHumanLabelFileSchema, value);
}

/** Builds a schema-valid portable human-label file. */
export function createEvalHumanLabelFile(input: CreateEvalHumanLabelFileInput): EvalHumanLabelFile {
  return parseEvalHumanLabelFile({
    exportedAt: input.exportedAt ?? new Date().toISOString(),
    labels: input.labels.map(parseEvalHumanLabelRecord),
    schemaVersion: EVAL_HUMAN_LABEL_FILE_SCHEMA_VERSION,
    ...(input.suiteId ? { suiteId: input.suiteId } : {}),
  });
}

/** Adds a reviewed eval case to a suite fixture without mutating the input suite. */
export function importEvalCaseIntoSuite(
  input: ImportEvalCaseIntoSuiteInput,
): ImportEvalCaseIntoSuiteResult {
  const existingIndex = input.suite.cases.findIndex(
    (evalCase) => evalCase.caseId === input.evalCase.caseId,
  );
  if (existingIndex >= 0 && !input.replaceExisting) {
    throw new EvalValidationError(
      "EvalCaseImport",
      `caseId "${input.evalCase.caseId}" already exists; pass replaceExisting to overwrite it`,
    );
  }

  const cases =
    existingIndex >= 0
      ? input.suite.cases.map((evalCase, index) =>
          index === existingIndex ? input.evalCase : evalCase,
        )
      : [...input.suite.cases, input.evalCase];
  const suite = parseEvalSuite({
    ...input.suite,
    cases,
  });

  return {
    caseCount: suite.cases.length,
    inserted: existingIndex < 0,
    replaced: existingIndex >= 0,
    suite,
  };
}

/** Validates unknown data as an eval report. */
export function parseEvalReport(value: unknown): EvalReport {
  return parseWithSchema("EvalReport", EvalReportSchema, value);
}

/** Runs a deterministic fixture evaluation and returns a report. */
export function runEvaluation(input: RunEvaluationInput): EvalReport {
  const startedAt = input.timestamp ?? new Date().toISOString();
  const completedAt = startedAt;
  const variant =
    input.variant ??
    ({
      variantId: "local",
      label: "Local deterministic fake LLM",
      liveModel: false,
    } satisfies EvalVariant);
  const caseResults = input.suite.cases.map(evaluateCase);
  const metrics = aggregateMetrics(caseResults);
  const gate = evaluateGate(metrics, input.suite.thresholds);
  const report = {
    schemaVersion: EVAL_REPORT_SCHEMA_VERSION,
    evalRunId: stableEvalRunId(input.suite.suiteId, variant.variantId, startedAt),
    suiteId: input.suite.suiteId,
    variant,
    startedAt,
    completedAt,
    metrics,
    gate,
    caseResults,
  } satisfies EvalReport;

  return parseEvalReport(report);
}

/** Writes HTML, JSON, JUnit XML, and Markdown report artifacts to an output directory. */
export async function writeEvalReportArtifacts(
  report: EvalReport,
  outputDir: string,
): Promise<EvalReportArtifacts> {
  const absoluteOutputDir = resolve(outputDir);
  await mkdir(absoluteOutputDir, { recursive: true });
  const htmlPath = resolve(absoluteOutputDir, "report.html");
  const jsonPath = resolve(absoluteOutputDir, "report.json");
  const junitPath = resolve(absoluteOutputDir, "report.junit.xml");
  const markdownPath = resolve(absoluteOutputDir, "report.md");
  await writeFile(htmlPath, renderEvalReportHtml(report), "utf8");
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(junitPath, renderEvalReportJUnit(report), "utf8");
  await writeFile(markdownPath, renderEvalReportMarkdown(report), "utf8");
  return { htmlPath, jsonPath, junitPath, markdownPath };
}

/** Builds durable, product-safe eval history rows from a suite and report. */
export function buildEvalHistoryWrite(input: BuildEvalHistoryWriteInput): EvalHistoryWrite {
  const artifactRefs = input.artifacts ? buildEvalHistoryArtifactRefs(input.artifacts) : [];
  const suiteVersion = input.suiteVersion ?? EVAL_SUITE_SCHEMA_VERSION;
  const startedAt = new Date(input.report.startedAt);
  const completedAt = new Date(input.report.completedAt);

  return {
    suite: {
      evalSuiteId: input.suite.suiteId,
      name: input.suite.name,
      description: input.suite.description,
      version: suiteVersion,
      owner: input.suiteOwner ?? "heimdall",
      tags: [...new Set(input.suite.cases.flatMap((evalCase) => evalCase.tags))],
      defaultRunner: "deterministic_fixture",
      defaultGraders: [
        "expected_finding_match",
        "line_anchor_validity",
        "retrieval_recall_at_10",
        "cost_latency_gate",
      ],
      thresholds: input.suite.thresholds,
    },
    cases: input.suite.cases.map((evalCase) => buildEvalHistoryCase(input.suite.suiteId, evalCase)),
    variant: {
      evalVariantId: input.report.variant.variantId,
      name: input.report.variant.label,
      description: input.report.variant.liveModel ? "Live model evaluation" : "Deterministic eval",
      config: {
        label: input.report.variant.label,
        liveModel: input.report.variant.liveModel,
      },
      createdBy: input.triggeredBy ?? "eval-cli",
      ...(input.gitCommitSha ? { gitCommitSha: input.gitCommitSha } : {}),
    },
    run: {
      evalRunId: input.report.evalRunId,
      evalSuiteId: input.report.suiteId,
      evalVariantId: input.report.variant.variantId,
      status: input.report.gate.status,
      triggeredBy: input.triggeredBy ?? "eval-cli",
      environment: input.environment ?? "local",
      caseCount: input.report.metrics.cases,
      startedAt,
      completedAt,
      reportUri: artifactRefs.find((artifact) => artifact.kind === "json")?.uri,
      summary: {
        gate: input.report.gate,
        metrics: input.report.metrics,
        artifacts: artifactRefs,
      },
      ...(input.branch ? { branch: input.branch } : {}),
      ...(input.gitCommitSha ? { gitCommitSha: input.gitCommitSha } : {}),
    },
    caseResults: input.report.caseResults.map((caseResult) =>
      buildEvalHistoryCaseResult(input.report.evalRunId, caseResult, artifactRefs),
    ),
    ...(input.setAsActiveBaseline
      ? {
          baseline: {
            evalSuiteId: input.report.suiteId,
            baselineVariantId: input.report.variant.variantId,
            evalRunId: input.report.evalRunId,
            active: true,
          },
        }
      : {}),
  };
}

/** Renders a CI-safe Markdown report without raw fixture code or context text. */
export function renderEvalReportMarkdown(report: EvalReport): string {
  const failedCases = report.caseResults.filter((caseResult) => caseResult.status === "fail");
  const lines = [
    `# Evaluation: ${report.suiteId}`,
    "",
    `Variant: ${report.variant.variantId}`,
    `Status: ${report.gate.status.toUpperCase()}`,
    `Cases: ${report.metrics.cases}`,
    "",
    "## Metrics",
    "",
    `- Weighted recall: ${formatRate(report.metrics.weightedRecall)}`,
    `- Published precision: ${formatRate(report.metrics.publishedPrecision)}`,
    `- False positive rate: ${formatRate(report.metrics.falsePositiveRate)}`,
    `- Anchor validity: ${formatRate(report.metrics.anchorValidity)}`,
    `- Retrieval recall@10: ${formatRate(report.metrics.retrievalRecallAt10)}`,
    `- Mean cost: $${report.metrics.meanCostUsd.toFixed(4)}`,
    `- P95 latency: ${report.metrics.p95LatencyMs.toFixed(0)}ms`,
    "",
    "## Gate",
    "",
    "| Metric | Actual | Gate | Status |",
    "| --- | ---: | ---: | --- |",
    ...report.gate.checks.map(
      (check) =>
        `| ${check.metric} | ${formatGateNumber(check.actual)} | ${check.comparator} ${formatGateNumber(
          check.threshold,
        )} | ${check.status.toUpperCase()} |`,
    ),
    "",
    "## Failed Cases",
    "",
    failedCases.length === 0
      ? "None."
      : failedCases
          .map((caseResult) => `- ${caseResult.caseId}: ${caseResult.failureReasons.join("; ")}`)
          .join("\n"),
    "",
  ];

  return `${lines.join("\n")}\n`;
}

/** Renders a CI-safe static HTML report without raw fixture code or context text. */
export function renderEvalReportHtml(report: EvalReport): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Evaluation ${escapeXml(report.suiteId)}</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 32px; color: #17202a; }
    table { border-collapse: collapse; width: 100%; margin: 16px 0 24px; }
    th, td { border: 1px solid #d7dde5; padding: 8px 10px; text-align: left; }
    th { background: #f3f6f9; }
    .pass { color: #166534; font-weight: 700; }
    .fail { color: #991b1b; font-weight: 700; }
    .metric-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
    .metric { border: 1px solid #d7dde5; padding: 12px; }
    .metric span { display: block; color: #526173; font-size: 12px; text-transform: uppercase; }
    .metric strong { display: block; margin-top: 4px; font-size: 20px; }
  </style>
</head>
<body>
  <h1>Evaluation: ${escapeXml(report.suiteId)}</h1>
  <p>Variant: ${escapeXml(report.variant.variantId)}</p>
  <p>Status: <span class="${report.gate.status}">${report.gate.status.toUpperCase()}</span></p>
  <section>
    <h2>Metrics</h2>
    <div class="metric-grid">
      <div class="metric"><span>Weighted recall</span><strong>${formatRate(report.metrics.weightedRecall)}</strong></div>
      <div class="metric"><span>Published precision</span><strong>${formatRate(report.metrics.publishedPrecision)}</strong></div>
      <div class="metric"><span>False positive rate</span><strong>${formatRate(report.metrics.falsePositiveRate)}</strong></div>
      <div class="metric"><span>Anchor validity</span><strong>${formatRate(report.metrics.anchorValidity)}</strong></div>
      <div class="metric"><span>Retrieval recall@10</span><strong>${formatRate(report.metrics.retrievalRecallAt10)}</strong></div>
      <div class="metric"><span>P95 latency</span><strong>${report.metrics.p95LatencyMs.toFixed(0)}ms</strong></div>
    </div>
  </section>
  <section>
    <h2>Gate</h2>
    <table>
      <thead><tr><th>Metric</th><th>Actual</th><th>Gate</th><th>Status</th></tr></thead>
      <tbody>${report.gate.checks.map(renderEvalGateHtmlRow).join("")}</tbody>
    </table>
  </section>
  <section>
    <h2>Cases</h2>
    <table>
      <thead><tr><th>Case</th><th>Status</th><th>Matched</th><th>False positives</th><th>Reasons</th></tr></thead>
      <tbody>${report.caseResults.map(renderEvalCaseHtmlRow).join("")}</tbody>
    </table>
  </section>
</body>
</html>
`;
}

/** Renders one eval gate check as a static HTML row. */
function renderEvalGateHtmlRow(check: EvalGateCheck): string {
  return `<tr><td>${escapeXml(check.metric)}</td><td>${formatGateNumber(check.actual)}</td><td>${check.comparator} ${formatGateNumber(
    check.threshold,
  )}</td><td class="${check.status}">${check.status.toUpperCase()}</td></tr>`;
}

/** Renders one eval case as a static HTML row. */
function renderEvalCaseHtmlRow(caseResult: EvalCaseResult): string {
  return `<tr><td>${escapeXml(caseResult.caseId)}</td><td class="${caseResult.status}">${caseResult.status.toUpperCase()}</td><td>${caseResult.metrics.matchedFindings}/${caseResult.metrics.expectedFindings}</td><td>${caseResult.metrics.falsePositives}</td><td>${escapeXml(
    caseResult.failureReasons.join("; ") || "None",
  )}</td></tr>`;
}

/** Renders a CI-safe JUnit XML report without raw fixture code or context text. */
export function renderEvalReportJUnit(report: EvalReport): string {
  const failedCases = report.caseResults.filter((caseResult) => caseResult.status === "fail");
  const failedChecks = report.gate.checks.filter((check) => check.status === "fail");
  const testCount = report.caseResults.length + report.gate.checks.length;
  const failureCount = failedCases.length + failedChecks.length;
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="${escapeXml(report.suiteId)}" tests="${testCount}" failures="${failureCount}" errors="0" skipped="0" timestamp="${escapeXml(
      report.startedAt,
    )}">`,
    `  <properties><property name="variant" value="${escapeXml(report.variant.variantId)}" /></properties>`,
    ...report.caseResults.map(renderEvalCaseJUnitTestcase),
    ...report.gate.checks.map(renderEvalGateJUnitTestcase),
    "</testsuite>",
    "",
  ];

  return lines.join("\n");
}

/** Renders one eval case result as a JUnit testcase. */
function renderEvalCaseJUnitTestcase(caseResult: EvalCaseResult): string {
  const opening = `  <testcase classname="eval.case" name="${escapeXml(caseResult.caseId)}">`;
  if (caseResult.status === "pass") {
    return `${opening}</testcase>`;
  }

  const message = caseResult.failureReasons.join("; ");
  return [
    opening,
    `    <failure message="${escapeXml(message)}">${escapeXml(message)}</failure>`,
    "  </testcase>",
  ].join("\n");
}

/** Renders one eval gate check as a JUnit testcase. */
function renderEvalGateJUnitTestcase(check: EvalGateCheck): string {
  const opening = `  <testcase classname="eval.gate" name="${escapeXml(check.metric)}">`;
  if (check.status === "pass") {
    return `${opening}</testcase>`;
  }

  const message = `${check.metric} ${formatGateNumber(check.actual)} did not satisfy ${check.comparator} ${formatGateNumber(
    check.threshold,
  )}`;
  return [
    opening,
    `    <failure message="${escapeXml(message)}">${escapeXml(message)}</failure>`,
    "  </testcase>",
  ].join("\n");
}

/** Builds product-safe artifact references for persisted eval history. */
function buildEvalHistoryArtifactRefs(
  artifacts: EvalReportArtifacts,
): readonly EvalHistoryArtifactRef[] {
  return [
    {
      kind: "markdown",
      name: "report.md",
      uri: pathToFileURL(artifacts.markdownPath).toString(),
    },
    {
      kind: "html",
      name: "report.html",
      uri: pathToFileURL(artifacts.htmlPath).toString(),
    },
    {
      kind: "json",
      name: "report.json",
      uri: pathToFileURL(artifacts.jsonPath).toString(),
    },
    {
      kind: "junit",
      name: "report.junit.xml",
      uri: pathToFileURL(artifacts.junitPath).toString(),
    },
  ];
}

/** Builds a sanitized eval case row without raw context text or actual finding bodies. */
function buildEvalHistoryCase(
  evalSuiteId: string,
  evalCase: EvalCase,
): NonNullable<EvalHistoryWrite["cases"]>[number] {
  const expectedFindingLabels = evalCase.expectedFindings.map((finding) => ({
    category: finding.category,
    expectedFindingId: finding.expectedFindingId,
    location: finding.location,
    maxLineDistance: finding.maxLineDistance,
    severity: finding.severity,
    title: finding.title,
  }));
  const expectedContextLabels = evalCase.expectedContexts.map((context) => context.label);

  return {
    evalCaseId: evalCase.caseId,
    evalSuiteId,
    name: evalCase.title,
    description: evalCase.description,
    language: inferEvalCaseLanguage(evalCase.tags),
    tags: evalCase.tags,
    source: "curated_fixture",
    privacyLevel: "synthetic",
    difficulty: inferEvalCaseDifficulty(evalCase),
    fixture: {
      caseId: evalCase.caseId,
      changedFiles: evalCase.changedFiles.map((changedFile) => ({
        changeType: changedFile.changeType,
        path: changedFile.path,
        reviewableLines: changedFile.reviewableLines,
      })),
      schemaVersion: EVAL_SUITE_SCHEMA_VERSION,
    },
    input: {
      changedFilePaths: evalCase.changedFiles.map((changedFile) => changedFile.path),
      expectedContextLabels,
      tags: evalCase.tags,
    },
    labels: {
      expectedFindings: expectedFindingLabels,
    },
    expected: {
      expectedContextLabels,
      expectedFindingIds: evalCase.expectedFindings.map((finding) => finding.expectedFindingId),
    },
    active: true,
  };
}

/** Builds a product-safe eval case result row for history storage. */
function buildEvalHistoryCaseResult(
  evalRunId: string,
  caseResult: EvalCaseResult,
  artifactRefs: readonly EvalHistoryArtifactRef[],
): EvalHistoryWrite["caseResults"][number] {
  return {
    evalCaseResultId: stableEvalCaseResultId(evalRunId, caseResult.caseId),
    evalRunId,
    evalCaseId: caseResult.caseId,
    status: caseResult.status,
    scores: evalCaseMetricNames.map((metric) => ({
      metric,
      value: caseResult.metrics[metric],
    })),
    matchedFindings: caseResult.matchedExpectedFindingIds,
    unmatchedExpectedFindings: caseResult.missedExpectedFindingIds,
    unmatchedGeneratedFindings: caseResult.falsePositiveFindingIds,
    timings: {
      latencyMs: caseResult.metrics.latencyMs,
    },
    costs: {
      costUsd: caseResult.metrics.costUsd,
    },
    artifacts: artifactRefs,
    error:
      caseResult.failureReasons.length > 0
        ? {
            failureReasons: caseResult.failureReasons,
          }
        : undefined,
  };
}

/** Infers a primary language label from eval case tags. */
function inferEvalCaseLanguage(tags: readonly string[]): string {
  return tags.find((tag) => tag === "typescript") ?? "mixed";
}

/** Infers a coarse difficulty label for the persisted eval case. */
function inferEvalCaseDifficulty(evalCase: EvalCase): string {
  if (evalCase.expectedFindings.length === 0) {
    return "noise_guard";
  }

  if (evalCase.tags.includes("retrieval")) {
    return "cross_context";
  }

  return "mvp";
}

/** Throws when an evaluation report fails its configured gate. */
export function assertEvalGate(report: EvalReport): void {
  if (report.gate.status === "fail") {
    const failedChecks = report.gate.checks
      .filter((check) => check.status === "fail")
      .map((check) => check.metric)
      .join(", ");
    throw new Error(`Evaluation gate failed for ${report.suiteId}: ${failedChecks}`);
  }
}

/** Compares candidate report metrics and case results against a baseline report. */
export function compareEvalReports(
  baseline: EvalReport,
  candidate: EvalReport,
): EvalReportComparison {
  const caseComparisons = compareEvalCases(baseline.caseResults, candidate.caseResults);
  const lostTruePositives = caseComparisons.flatMap((comparison) => comparison.lostTruePositives);
  const newTruePositives = caseComparisons.flatMap((comparison) => comparison.newTruePositives);
  const newFalsePositives = caseComparisons.flatMap((comparison) => comparison.newFalsePositives);
  const resolvedFalsePositives = caseComparisons.flatMap(
    (comparison) => comparison.resolvedFalsePositives,
  );
  const metricDeltas = Object.fromEntries(
    evalReportMetricNames.map((metric) => [
      metric,
      candidate.metrics[metric] - baseline.metrics[metric],
    ]),
  ) as Record<keyof EvalReportMetrics, number>;
  const regressedCaseIds = caseComparisons
    .filter((comparison) => comparison.status === "regressed")
    .map((comparison) => comparison.caseId);
  const improvedCaseIds = caseComparisons
    .filter((comparison) => comparison.status === "improved")
    .map((comparison) => comparison.caseId);

  return {
    baselineEvalRunId: baseline.evalRunId,
    baselineMetrics: baseline.metrics,
    caseComparisons,
    candidateMetrics: candidate.metrics,
    candidateEvalRunId: candidate.evalRunId,
    improvedCaseIds,
    metricDeltas,
    newTruePositives,
    lostTruePositives,
    newFalsePositives,
    resolvedFalsePositives,
    regressedCaseIds,
    status:
      candidate.gate.status === "pass" &&
      lostTruePositives.length === 0 &&
      newFalsePositives.length === 0
        ? "pass"
        : "fail",
  };
}

/** Renders a CI-safe Markdown baseline comparison report. */
export function renderEvalComparisonMarkdown(comparison: EvalReportComparison): string {
  const lines = [
    "# Evaluation Comparison",
    "",
    `Baseline: ${comparison.baselineEvalRunId}`,
    `Candidate: ${comparison.candidateEvalRunId}`,
    `Status: ${comparison.status.toUpperCase()}`,
    "",
    "## Metric Deltas",
    "",
    "| Metric | Baseline | Candidate | Delta |",
    "| --- | ---: | ---: | ---: |",
    ...evalReportMetricNames.map((metric) =>
      renderMetricDeltaRow(
        metric,
        comparison.baselineMetrics[metric],
        comparison.candidateMetrics[metric],
        comparison.metricDeltas[metric],
      ),
    ),
    "",
    "## Regressions",
    "",
    comparison.regressedCaseIds.length === 0
      ? "None."
      : comparison.caseComparisons
          .filter((caseComparison) => caseComparison.status === "regressed")
          .map((caseComparison) => renderCaseComparisonBullet(caseComparison))
          .join("\n"),
    "",
    "## Improvements",
    "",
    comparison.improvedCaseIds.length === 0
      ? "None."
      : comparison.caseComparisons
          .filter((caseComparison) => caseComparison.status === "improved")
          .map((caseComparison) => renderCaseComparisonBullet(caseComparison))
          .join("\n"),
    "",
  ];

  return `${lines.join("\n")}\n`;
}

/** Compares case results by case ID. */
function compareEvalCases(
  baselineCases: readonly EvalCaseResult[],
  candidateCases: readonly EvalCaseResult[],
): readonly EvalCaseComparison[] {
  const baselineByCaseId = new Map(
    baselineCases.map((caseResult) => [caseResult.caseId, caseResult]),
  );
  const candidateByCaseId = new Map(
    candidateCases.map((caseResult) => [caseResult.caseId, caseResult]),
  );
  const caseIds = [...new Set([...baselineByCaseId.keys(), ...candidateByCaseId.keys()])].sort();

  return caseIds.map((caseId) =>
    compareEvalCase(caseId, baselineByCaseId.get(caseId), candidateByCaseId.get(caseId)),
  );
}

/** Compares one baseline/candidate case result pair. */
function compareEvalCase(
  caseId: string,
  baselineCase: EvalCaseResult | undefined,
  candidateCase: EvalCaseResult | undefined,
): EvalCaseComparison {
  const baselineMatched = new Set(baselineCase?.matchedExpectedFindingIds ?? []);
  const candidateMatched = new Set(candidateCase?.matchedExpectedFindingIds ?? []);
  const baselineFalsePositives = new Set(baselineCase?.falsePositiveFindingIds ?? []);
  const candidateFalsePositives = new Set(candidateCase?.falsePositiveFindingIds ?? []);
  const lostTruePositives = withCasePrefix(
    caseId,
    setDifference([...baselineMatched], candidateMatched),
  );
  const newTruePositives = withCasePrefix(
    caseId,
    setDifference([...candidateMatched], baselineMatched),
  );
  const newFalsePositives = withCasePrefix(
    caseId,
    setDifference([...candidateFalsePositives], baselineFalsePositives),
  );
  const resolvedFalsePositives = withCasePrefix(
    caseId,
    setDifference([...baselineFalsePositives], candidateFalsePositives),
  );
  const metricDeltas = Object.fromEntries(
    evalCaseMetricNames.map((metric) => [
      metric,
      (candidateCase?.metrics[metric] ?? 0) - (baselineCase?.metrics[metric] ?? 0),
    ]),
  ) as Record<keyof EvalCaseMetrics, number>;
  const regressed =
    lostTruePositives.length > 0 ||
    newFalsePositives.length > 0 ||
    (baselineCase?.status === "pass" && candidateCase?.status === "fail");
  const improved =
    newTruePositives.length > 0 ||
    resolvedFalsePositives.length > 0 ||
    (baselineCase?.status === "fail" && candidateCase?.status === "pass");

  return {
    ...(baselineCase ? { baselineStatus: baselineCase.status } : {}),
    ...(candidateCase ? { candidateStatus: candidateCase.status } : {}),
    caseId,
    metricDeltas,
    newTruePositives,
    newFalsePositives,
    resolvedFalsePositives,
    lostTruePositives,
    status: regressed ? "regressed" : improved ? "improved" : "unchanged",
  };
}

/** Renders one metric-delta row for comparison Markdown. */
function renderMetricDeltaRow(
  metric: keyof EvalReportMetrics,
  baselineValue: number,
  candidateValue: number,
  delta: number,
): string {
  return `| ${metric} | ${formatComparisonMetric(metric, baselineValue)} | ${formatComparisonMetric(
    metric,
    candidateValue,
  )} | ${formatSignedComparisonMetric(metric, delta)} |`;
}

/** Renders one case-comparison bullet for comparison Markdown. */
function renderCaseComparisonBullet(comparison: EvalCaseComparison): string {
  const reasons = [
    ...comparison.lostTruePositives.map((findingId) => `lost ${findingId}`),
    ...comparison.newTruePositives.map((findingId) => `found ${findingId}`),
    ...comparison.newFalsePositives.map((findingId) => `new false positive ${findingId}`),
    ...comparison.resolvedFalsePositives.map((findingId) => `resolved false positive ${findingId}`),
  ];

  return `- ${comparison.caseId}: ${reasons.length === 0 ? comparison.status : reasons.join("; ")}`;
}

/** Formats a comparison metric value. */
function formatComparisonMetric(metric: keyof EvalReportMetrics, value: number): string {
  if (metric === "meanCostUsd") {
    return `$${value.toFixed(4)}`;
  }
  if (metric === "p95LatencyMs") {
    return `${value.toFixed(0)}ms`;
  }
  if (rateMetricNames.has(metric)) {
    return value.toFixed(3);
  }

  return value.toFixed(0);
}

/** Formats a signed comparison metric delta. */
function formatSignedComparisonMetric(metric: keyof EvalReportMetrics, value: number): string {
  const prefix = value > 0 ? "+" : "";
  if (metric === "meanCostUsd") {
    return `${prefix}$${value.toFixed(4)}`;
  }
  if (metric === "p95LatencyMs") {
    return `${prefix}${value.toFixed(0)}ms`;
  }
  if (rateMetricNames.has(metric)) {
    return `${prefix}${value.toFixed(3)}`;
  }

  return `${prefix}${value.toFixed(0)}`;
}

/** Returns entries from left that are absent in right. */
function setDifference(values: readonly string[], right: ReadonlySet<string>): readonly string[] {
  return values.filter((value) => !right.has(value));
}

/** Prefixes finding IDs with their case ID. */
function withCasePrefix(caseId: string, findingIds: readonly string[]): readonly string[] {
  return findingIds.map((findingId) => `${caseId}:${findingId}`);
}

/** Evaluates one case through retrieval, review output, anchor, and latency/cost graders. */
function evaluateCase(evalCase: EvalCase): EvalCaseResult {
  const reviewableLineByPath = new Map(
    evalCase.changedFiles.map((file) => [file.path, new Set(file.reviewableLines)]),
  );
  const matches = matchFindings(evalCase.expectedFindings, evalCase.actualFindings);
  const matchedActualIds = new Set(matches.map((match) => match.actual.findingId));
  const matchedExpectedFindingIds = matches.map((match) => match.expected.expectedFindingId);
  const missedExpectedFindingIds = evalCase.expectedFindings
    .filter((expected) => !matchedExpectedFindingIds.includes(expected.expectedFindingId))
    .map((expected) => expected.expectedFindingId);
  const falsePositiveFindingIds = evalCase.actualFindings
    .filter((actual) => !matchedActualIds.has(actual.findingId))
    .map((actual) => actual.findingId);
  const invalidAnchorFindingIds = evalCase.actualFindings
    .filter((actual) => !isReviewableAnchor(actual, reviewableLineByPath))
    .map((actual) => actual.findingId);
  const matchedContextLabels = matchContexts(
    evalCase.expectedContexts,
    evalCase.retrievedContexts,
  ).map((context) => context.label);
  const missedContextLabels = evalCase.expectedContexts
    .filter((context) => !matchedContextLabels.includes(context.label))
    .map((context) => context.label);
  const metrics = {
    expectedFindings: evalCase.expectedFindings.length,
    matchedFindings: matchedExpectedFindingIds.length,
    actualFindings: evalCase.actualFindings.length,
    falsePositives: falsePositiveFindingIds.length,
    anchorChecked: evalCase.actualFindings.length,
    anchorValid: evalCase.actualFindings.length - invalidAnchorFindingIds.length,
    retrievalExpected: evalCase.expectedContexts.length,
    retrievalMatched: matchedContextLabels.length,
    latencyMs: evalCase.latencyMs,
    costUsd: evalCase.costUsd,
  } satisfies EvalCaseMetrics;
  const failureReasons = [
    ...missedExpectedFindingIds.map((findingId) => `missed expected finding ${findingId}`),
    ...falsePositiveFindingIds.map((findingId) => `false positive finding ${findingId}`),
    ...invalidAnchorFindingIds.map((findingId) => `invalid anchor for finding ${findingId}`),
    ...missedContextLabels.map((label) => `missed context ${label}`),
  ];

  return {
    caseId: evalCase.caseId,
    title: evalCase.title,
    status: failureReasons.length === 0 ? "pass" : "fail",
    metrics,
    matchedExpectedFindingIds,
    missedExpectedFindingIds,
    falsePositiveFindingIds,
    invalidAnchorFindingIds,
    matchedContextLabels,
    missedContextLabels,
    failureReasons,
  };
}

/** Aggregates case-level metrics into the report-level gate metrics. */
function aggregateMetrics(caseResults: readonly EvalCaseResult[]): EvalReportMetrics {
  const totals = caseResults.reduce(
    (current, caseResult) => ({
      expectedFindings: current.expectedFindings + caseResult.metrics.expectedFindings,
      matchedFindings: current.matchedFindings + caseResult.metrics.matchedFindings,
      actualFindings: current.actualFindings + caseResult.metrics.actualFindings,
      falsePositives: current.falsePositives + caseResult.metrics.falsePositives,
      anchorChecked: current.anchorChecked + caseResult.metrics.anchorChecked,
      anchorValid: current.anchorValid + caseResult.metrics.anchorValid,
      retrievalExpected: current.retrievalExpected + caseResult.metrics.retrievalExpected,
      retrievalMatched: current.retrievalMatched + caseResult.metrics.retrievalMatched,
      costUsd: current.costUsd + caseResult.metrics.costUsd,
    }),
    {
      expectedFindings: 0,
      matchedFindings: 0,
      actualFindings: 0,
      falsePositives: 0,
      anchorChecked: 0,
      anchorValid: 0,
      retrievalExpected: 0,
      retrievalMatched: 0,
      costUsd: 0,
    },
  );
  const latencies = caseResults.map((caseResult) => caseResult.metrics.latencyMs);

  return {
    cases: caseResults.length,
    expectedFindings: totals.expectedFindings,
    matchedFindings: totals.matchedFindings,
    actualFindings: totals.actualFindings,
    falsePositives: totals.falsePositives,
    weightedRecall: divideOrDefault(totals.matchedFindings, totals.expectedFindings, 1),
    publishedPrecision: divideOrDefault(
      totals.matchedFindings,
      totals.actualFindings,
      totals.expectedFindings === 0 ? 1 : 0,
    ),
    falsePositiveRate: divideOrDefault(totals.falsePositives, totals.actualFindings, 0),
    anchorValidity: divideOrDefault(totals.anchorValid, totals.anchorChecked, 1),
    retrievalRecallAt10: divideOrDefault(totals.retrievalMatched, totals.retrievalExpected, 1),
    meanCostUsd: caseResults.length === 0 ? 0 : totals.costUsd / caseResults.length,
    p95LatencyMs: percentile(latencies, 0.95),
  };
}

/** Evaluates aggregated metrics against suite thresholds. */
function evaluateGate(
  metrics: EvalReportMetrics,
  thresholds: EvalMetricThresholds,
): EvalGateResult {
  const checks = [
    minCheck("weightedRecall", metrics.weightedRecall, thresholds.minWeightedRecall),
    minCheck("publishedPrecision", metrics.publishedPrecision, thresholds.minPublishedPrecision),
    maxCheck("falsePositiveRate", metrics.falsePositiveRate, thresholds.maxFalsePositiveRate),
    minCheck("anchorValidity", metrics.anchorValidity, thresholds.minAnchorValidity),
    minCheck("retrievalRecallAt10", metrics.retrievalRecallAt10, thresholds.minRetrievalRecallAt10),
    maxCheck("meanCostUsd", metrics.meanCostUsd, thresholds.maxMeanCostUsd),
    maxCheck("p95LatencyMs", metrics.p95LatencyMs, thresholds.maxP95LatencyMs),
  ];

  return {
    status: checks.every((check) => check.status === "pass") ? "pass" : "fail",
    checks,
  };
}

/** Finds one-to-one expected-to-actual finding matches for a case. */
function matchFindings(
  expectedFindings: readonly EvalExpectedFinding[],
  actualFindings: readonly EvalActualFinding[],
): readonly { readonly expected: EvalExpectedFinding; readonly actual: EvalActualFinding }[] {
  const usedActualIds = new Set<string>();
  const matches = [];

  for (const expected of expectedFindings) {
    const actual = actualFindings.find(
      (candidate) => !usedActualIds.has(candidate.findingId) && findingMatches(expected, candidate),
    );
    if (actual) {
      usedActualIds.add(actual.findingId);
      matches.push({ expected, actual });
    }
  }

  return matches;
}

/** Returns whether one actual finding satisfies an expected label. */
function findingMatches(expected: EvalExpectedFinding, actual: EvalActualFinding): boolean {
  const searchableText = normalizeText(`${actual.title} ${actual.body}`);
  const expectedKeywordsPresent = expected.bodyKeywords.every((keyword) =>
    searchableText.includes(normalizeText(keyword)),
  );
  const lineDistance = Math.abs(actual.location.line - expected.location.line);

  return (
    expected.category === actual.category &&
    expected.severity === actual.severity &&
    expected.location.path === actual.location.path &&
    lineDistance <= expected.maxLineDistance &&
    expectedKeywordsPresent
  );
}

/** Returns whether an actual finding is anchored to a reviewable changed line. */
function isReviewableAnchor(
  actual: EvalActualFinding,
  reviewableLineByPath: ReadonlyMap<string, ReadonlySet<number>>,
): boolean {
  return reviewableLineByPath.get(actual.location.path)?.has(actual.location.line) ?? false;
}

/** Matches expected retrieval contexts against top-ten retrieved context labels and keywords. */
function matchContexts(
  expectedContexts: readonly EvalExpectedContext[],
  retrievedContexts: readonly EvalRetrievedContext[],
): readonly EvalExpectedContext[] {
  const topTenContexts = [...retrievedContexts]
    .sort((left, right) => left.rank - right.rank)
    .slice(0, 10);

  return expectedContexts.filter((expected) =>
    topTenContexts.some((retrieved) => contextMatches(expected, retrieved)),
  );
}

/** Returns whether one retrieved context satisfies an expected context label. */
function contextMatches(expected: EvalExpectedContext, retrieved: EvalRetrievedContext): boolean {
  if (expected.label === retrieved.label) {
    return true;
  }

  const searchableText = normalizeText(retrieved.text);
  return (
    expected.path === retrieved.path &&
    expected.keywords.every((keyword) => searchableText.includes(normalizeText(keyword)))
  );
}

/** Creates a lower-case normalized text form for matching. */
function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Creates a minimum-threshold gate check. */
function minCheck(metric: string, actual: number, threshold: number): EvalGateCheck {
  return {
    metric,
    actual,
    threshold,
    comparator: ">=",
    status: actual >= threshold ? "pass" : "fail",
  };
}

/** Creates a maximum-threshold gate check. */
function maxCheck(metric: string, actual: number, threshold: number): EvalGateCheck {
  return {
    metric,
    actual,
    threshold,
    comparator: "<=",
    status: actual <= threshold ? "pass" : "fail",
  };
}

/** Divides two values, using a default for zero denominators. */
function divideOrDefault(numerator: number, denominator: number, zeroDefault: number): number {
  return denominator === 0 ? zeroDefault : numerator / denominator;
}

/** Returns a nearest-rank percentile from a set of numeric values. */
function percentile(values: readonly number[], percentileValue: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(percentileValue * sorted.length) - 1);
  return sorted[index] ?? 0;
}

/** Creates a stable run ID from suite, variant, and timestamp. */
function stableEvalRunId(suiteId: string, variantId: string, timestamp: string): string {
  return `eval_${hashParts([suiteId, variantId, timestamp]).slice(0, 24)}`;
}

/** Creates a stable case result ID for a persisted eval run. */
function stableEvalCaseResultId(evalRunId: string, caseId: string): string {
  return `evalcase_${hashParts([evalRunId, caseId]).slice(0, 24)}`;
}

/** Creates a SHA-256 hash from deterministic parts. */
function hashParts(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

/** Formats a percentage rate for Markdown output. */
function formatRate(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/** Formats one gate number for human-readable reports. */
function formatGateNumber(value: number): string {
  return value > 1 ? value.toFixed(2) : value.toFixed(3);
}

/** Escapes text for XML element and attribute contexts. */
function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** Validates unknown data with a TypeBox schema and returns the typed value. */
function parseWithSchema<T>(
  schemaName: string,
  schema: Parameters<typeof Value.Check>[0],
  value: unknown,
): T {
  if (Value.Check(schema, value)) {
    return value as T;
  }

  const details = [...Value.Errors(schema, value)]
    .map((error) => `${error.path || "/"} ${error.message}`)
    .join("; ");
  throw new EvalValidationError(schemaName, details);
}

/** Narrows unknown JSON data to an object record. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Resolves the default registered fixture path for a suite ID. */
function defaultSuitePath(suiteId: string): string {
  const fixtureName = `${suiteId}.json`;
  return fileURLToPath(new URL(`../fixtures/${fixtureName}`, import.meta.url));
}

/** Ensures a parent directory exists before a caller writes a nested output file. */
export async function ensureParentDirectory(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}
