import { createHash } from "node:crypto";
import type {
  FindingCategory,
  FindingSeverity,
  FindingSource,
} from "@repo/contracts/enums/finding";
import type { ChangedFile } from "@repo/contracts/pull-request/diff";
import type { PullRequestSnapshot } from "@repo/contracts/pull-request/pull-request";
import type { ContextBundle } from "@repo/contracts/review/context";
import {
  type CandidateFinding,
  CandidateFindingSchema,
  type Evidence,
  type FindingRejectionReason,
  type LLMFindingOutput,
  type PublishedFinding,
  type ValidatedFinding,
} from "@repo/contracts/review/finding";
import { safeParseWithSchema } from "@repo/contracts/validation/parse";
import type { LLMGateway } from "@repo/llm-gateway";
import { evaluateSuppression, type MemoryFact, type SuppressionDecision } from "@repo/memory";
import {
  classifyTelemetryError,
  OBSERVABILITY_METRIC_NAMES,
  OBSERVABILITY_SPAN_NAMES,
  type TelemetryAttributeValue,
  type TelemetryMetricRecorder,
  type TelemetrySpanHandle,
  type TelemetrySpanRecorder,
  type TelemetryTraceContextInput,
} from "@repo/observability";
import { type EffectiveReviewPolicy, evaluateFindingPolicy } from "@repo/rules";
import type { NormalizedToolDiagnostic, StaticAnalysisReport } from "@repo/static-analysis";

/** Valid finding categories used when normalizing schema-invalid candidates. */
const FINDING_CATEGORIES = new Set<FindingCategory>([
  "architecture",
  "correctness",
  "dependency",
  "documentation",
  "maintainability",
  "other",
  "performance",
  "security",
  "style",
  "test_coverage",
]);

/** Valid finding severities used when normalizing schema-invalid candidates. */
const FINDING_SEVERITIES = new Set<FindingSeverity>(["critical", "high", "info", "low", "medium"]);

/** Valid finding sources used when normalizing schema-invalid candidates. */
const FINDING_SOURCES = new Set<FindingSource>([
  "hybrid",
  "llm",
  "memory",
  "rule",
  "static_analysis",
]);

/** Maximum accepted candidate title length from the public contract. */
const MAX_CANDIDATE_TITLE_LENGTH = 200;

/** Maximum accepted candidate body length from the public contract. */
const MAX_CANDIDATE_BODY_LENGTH = 4000;

/** Maximum accepted suggested fix length from the public contract. */
const MAX_SUGGESTED_FIX_LENGTH = 8000;

/** Minimum evidence summary length before evidence is considered useful. */
const MIN_EVIDENCE_SUMMARY_LENGTH = 12;

/** Minimum evidence confidence before evidence is considered useful. */
const MIN_EVIDENCE_CONFIDENCE = 0.2;

/** Maximum static-analysis diagnostics converted by one review pass. */
const STATIC_ANALYSIS_FINDING_LIMIT = 10;

/** Normalization failures that make later candidate validators unreliable. */
const SCHEMA_BLOCKING_REASONS = new Set<FindingRejectionReason>([
  "invalid_file_path",
  "invalid_schema",
  "line_missing",
  "missing_file_path",
  "unsupported_schema_version",
]);

type NormalizedCandidateFindingForValidation = {
  /** Candidate normalized enough that validation can persist an explicit rejection. */
  readonly finding: CandidateFinding;
  /** Rejection reasons discovered while normalizing schema-invalid boundary data. */
  readonly reasons: readonly FindingRejectionReason[];
};

/** Optional telemetry dependencies used by review-engine operations. */
export type ReviewEngineTelemetryOptions = {
  /** Optional metric recorder for review pass and validation counters. */
  readonly metrics?: TelemetryMetricRecorder | undefined;
  /** Optional trace context propagated from the parent review job. */
  readonly traceContext?: TelemetryTraceContextInput | undefined;
  /** Optional span recorder for product-safe review-engine spans. */
  readonly traces?: TelemetrySpanRecorder | undefined;
};

/** Context provided to every deterministic or model-backed review pass. */
export type ReviewPassContext = {
  /** Stable review run ID that owns all emitted findings. */
  readonly reviewRunId: string;
  /** Pull request snapshot fetched for the review run. */
  readonly snapshot: PullRequestSnapshot;
  /** Timestamp used for deterministic test output. */
  readonly timestamp: string;
  /** Retrieved context bundle used by codebase-aware review passes. */
  readonly contextBundle?: ContextBundle;
  /** Optional gateway used by model-backed review passes. */
  readonly llmGateway?: LLMGateway;
  /** Optional static-analysis report used by static-tool synthesis passes. */
  readonly staticAnalysisReport?: StaticAnalysisReport;
};

/** Candidate finding pass boundary implemented by review-engine passes. */
export interface ReviewPass {
  /** Stable pass identifier used in artifacts and finding source names. */
  readonly name: string;
  /** Human-readable pass version. */
  readonly version: string;
  /** Runs the pass and returns structured candidate findings. */
  run(context: ReviewPassContext): Promise<readonly CandidateFinding[]>;
}

/** Review pass execution modes used to select specialized passes. */
export type ReviewPassMode =
  | "off"
  | "summary_only"
  | "normal"
  | "strict"
  | "security_only"
  | "tests_only"
  | "dry_run";

/** Stable identifiers for planned review passes. */
export type ReviewPassId =
  | "pr_summary"
  | "behavior_change"
  | "correctness"
  | "security"
  | "test_coverage"
  | "performance"
  | "architecture_pattern"
  | "api_contract_regression"
  | "static_tool_synthesis"
  | "finding_judge";

/** Budget controls used by pass selection and future pass runners. */
export type ReviewBudgets = {
  /** Maximum number of passes to select. */
  readonly maxPasses: number;
  /** Maximum candidates any single pass may emit. */
  readonly maxCandidatesPerPass: number;
  /** Maximum merged candidates before judging. */
  readonly maxCandidatesBeforeJudge: number;
  /** Maximum LLM calls allowed for the review. */
  readonly maxLlmCalls: number;
  /** Maximum review wall-clock time in milliseconds. */
  readonly maxWallClockMs: number;
};

/** Input used to deterministically select review passes for a pull request. */
export type SelectReviewPassesInput = {
  /** Pull request snapshot to classify. */
  readonly snapshot: PullRequestSnapshot;
  /** Optional retrieved context used for security and architecture signals. */
  readonly contextBundle?: ContextBundle;
  /** Review pass mode. Defaults to `normal`. */
  readonly mode?: ReviewPassMode;
  /** Optional pass budget. Defaults to `DEFAULT_REVIEW_BUDGETS`. */
  readonly budgets?: ReviewBudgets;
};

/** Default conservative budget for the first pass-selection implementation. */
export const DEFAULT_REVIEW_BUDGETS: ReviewBudgets = {
  maxPasses: 8,
  maxCandidatesPerPass: 5,
  maxCandidatesBeforeJudge: 20,
  maxLlmCalls: 8,
  maxWallClockMs: 120_000,
};

/** Deterministic pass that emits one reviewable-boundary finding for pipeline handoff tests. */
export const deterministicBoundaryPass: ReviewPass = {
  name: "deterministic-boundary",
  version: "1.0.0",
  run: async (context) => createDeterministicBoundaryFindings(context),
};

/** LLM-backed review pass that converts structured model output into candidate findings. */
export const llmReviewPass: ReviewPass = {
  name: "llm-review",
  version: "1.0.0",
  run: async (context) => {
    if (!context.llmGateway) {
      return [];
    }

    const output = await context.llmGateway.generateReviewFindings({
      prompt: renderReviewPrompt(context),
      metadata: {
        reviewRunId: context.reviewRunId,
        snapshotId: context.snapshot.snapshotId,
        contextBundleId: context.contextBundle?.contextBundleId,
      },
    });

    return findingsFromLLMOutput(context, output);
  },
};

/** Review pass that converts static-analysis diagnostics into candidate findings. */
export const staticAnalysisReviewPass: ReviewPass = {
  name: "static-analysis-synthesis",
  version: "1.0.0",
  run: async (context) => staticAnalysisFindingsFromReport(context),
};

/** Input for executing selected review passes with optional telemetry. */
export type RunReviewPassesInput = ReviewEngineTelemetryOptions & {
  /** Passes to execute. Defaults to the deterministic boundary pass. */
  readonly passes?: readonly ReviewPass[];
  /** Review pass context shared across passes. */
  readonly context: ReviewPassContext;
};

/** Runs review passes in order and returns all emitted candidate findings. */
export async function runReviewPasses(
  input: RunReviewPassesInput,
): Promise<readonly CandidateFinding[]> {
  const passes = input.passes ?? [deterministicBoundaryPass];
  const telemetry = startReviewEngineRunTelemetry(input, passes.length);

  try {
    const findingSets = await Promise.all(
      passes.map((pass, index) => runReviewPassWithTelemetry(input, pass, index)),
    );
    const findings = recordCandidateNormalizationTelemetry(input, findingSets.flat());
    recordCandidateJudgeTelemetry(input, passes, findings);
    finishReviewEngineRunTelemetry(telemetry, {
      candidateCount: findings.length,
      passCount: passes.length,
      status: "succeeded",
    });

    return findings;
  } catch (error) {
    finishReviewEngineRunTelemetry(telemetry, {
      error,
      errorClass: classifyTelemetryError(error),
      passCount: passes.length,
      status: "failed",
    });
    throw error;
  }
}

/** Final status attached to pass-level review metrics. */
type ReviewPassTelemetryStatus = "failed" | "succeeded";

/** Low-cardinality labels shared by review pass metrics. */
type ReviewPassTelemetryLabels = Readonly<{
  /** Stable pass identifier. */
  readonly pass_name: string;
  /** Final pass execution status. */
  readonly status: ReviewPassTelemetryStatus;
}>;

/** Mutable state carried while the review-engine run span is open. */
type ReviewEngineRunTelemetryState = {
  /** Product-safe run span, when tracing is configured. */
  readonly span?: TelemetrySpanHandle | undefined;
  /** Monotonic start time used for duration attributes. */
  readonly startedAtMs: number;
};

/** Starts product-safe telemetry for one review-engine pass set. */
function startReviewEngineRunTelemetry(
  input: RunReviewPassesInput,
  passCount: number,
): ReviewEngineRunTelemetryState {
  const span = input.traces?.startSpan(OBSERVABILITY_SPAN_NAMES.reviewEngineRun, {
    attributes: {
      "app.repo_id": input.context.snapshot.repoId,
      "app.review_run_id": input.context.reviewRunId,
      "review.context_item_count": input.context.contextBundle?.items.length ?? 0,
      "review.pass_count": passCount,
      "review.static_analysis_reported": input.context.staticAnalysisReport !== undefined,
    },
    kind: "internal",
    traceContext: input.traceContext,
  });

  return {
    span,
    startedAtMs: Date.now(),
  };
}

/** Runs one review pass and records bounded pass metrics and spans. */
async function runReviewPassWithTelemetry(
  input: RunReviewPassesInput,
  pass: ReviewPass,
  passIndex: number,
): Promise<readonly CandidateFinding[]> {
  const startedAtMs = Date.now();
  const span = input.traces?.startSpan(OBSERVABILITY_SPAN_NAMES.reviewEnginePass, {
    attributes: {
      "app.repo_id": input.context.snapshot.repoId,
      "app.review_run_id": input.context.reviewRunId,
      "review.pass_index": passIndex,
      "review.pass_name": sanitizeReviewTelemetryLabel(pass.name),
      "review.pass_version": sanitizeReviewTelemetryLabel(pass.version),
    },
    kind: "internal",
    traceContext: input.traceContext,
  });

  try {
    const findings = await pass.run(input.context);
    const durationMs = Math.max(0, Date.now() - startedAtMs);
    const labels = reviewPassTelemetryLabels(pass, "succeeded");

    input.metrics?.histogram(OBSERVABILITY_METRIC_NAMES.reviewPassDurationMs, durationMs, {
      labels,
      unit: "ms",
    });
    input.metrics?.count(OBSERVABILITY_METRIC_NAMES.reviewPassCandidatesTotal, {
      labels,
      value: findings.length,
    });
    span?.end({
      attributes: {
        "review.candidate_count": findings.length,
        "review.pass_duration_ms": durationMs,
        "review.pass_status": "succeeded",
      },
    });

    return findings;
  } catch (error) {
    const durationMs = Math.max(0, Date.now() - startedAtMs);
    const errorClass = classifyTelemetryError(error);
    const labels = reviewPassTelemetryLabels(pass, "failed");

    input.metrics?.histogram(OBSERVABILITY_METRIC_NAMES.reviewPassDurationMs, durationMs, {
      labels,
      unit: "ms",
    });
    input.metrics?.count(OBSERVABILITY_METRIC_NAMES.reviewPassFailuresTotal, {
      labels: { ...labels, error_class: errorClass },
    });
    span?.end({
      attributes: {
        "review.error_class": errorClass,
        "review.pass_duration_ms": durationMs,
        "review.pass_status": "failed",
      },
      error,
    });
    throw error;
  }
}

/** Records the candidate normalization step without inspecting candidate text. */
function recordCandidateNormalizationTelemetry(
  input: RunReviewPassesInput,
  findings: readonly CandidateFinding[],
): readonly CandidateFinding[] {
  const span = input.traces?.startSpan(OBSERVABILITY_SPAN_NAMES.reviewEngineNormalizeCandidates, {
    attributes: {
      "app.repo_id": input.context.snapshot.repoId,
      "app.review_run_id": input.context.reviewRunId,
      "review.input_candidate_count": findings.length,
    },
    kind: "internal",
    traceContext: input.traceContext,
  });

  span?.end({
    attributes: {
      "review.normalized_candidate_count": findings.length,
      "review.normalized_schema": "candidate_finding.v1",
    },
  });

  return findings;
}

/** Records the current judge step state without storing prompt or finding content. */
function recordCandidateJudgeTelemetry(
  input: RunReviewPassesInput,
  passes: readonly ReviewPass[],
  findings: readonly CandidateFinding[],
): void {
  const span = input.traces?.startSpan(OBSERVABILITY_SPAN_NAMES.reviewEngineJudgeCandidates, {
    attributes: {
      "app.repo_id": input.context.snapshot.repoId,
      "app.review_run_id": input.context.reviewRunId,
      "review.input_candidate_count": findings.length,
      "review.judge_pass_count": 0,
      "review.pass_version_count": new Set(passes.map((pass) => pass.version)).size,
    },
    kind: "internal",
    traceContext: input.traceContext,
  });

  span?.end({
    attributes: {
      "review.judge_enabled": false,
      "review.output_candidate_count": findings.length,
    },
  });
}

/** Ends the review-engine run span with aggregate candidate counts. */
function finishReviewEngineRunTelemetry(
  telemetry: ReviewEngineRunTelemetryState,
  context: {
    /** Candidate count emitted by all completed passes. */
    readonly candidateCount?: number | undefined;
    /** Optional error raised by pass execution. */
    readonly error?: unknown;
    /** Product-safe error class for failed runs. */
    readonly errorClass?: string | undefined;
    /** Number of selected passes. */
    readonly passCount: number;
    /** Final run status. */
    readonly status: "failed" | "succeeded";
  },
): void {
  const durationMs = Math.max(0, Date.now() - telemetry.startedAtMs);

  telemetry.span?.end({
    ...(context.error ? { error: context.error } : {}),
    attributes: {
      ...(context.candidateCount !== undefined
        ? { "review.candidate_count": context.candidateCount }
        : {}),
      ...(context.errorClass ? { "review.error_class": context.errorClass } : {}),
      "review.duration_ms": durationMs,
      "review.pass_count": context.passCount,
      "review.run_status": context.status,
    },
    status: context.status === "succeeded" ? "ok" : "error",
  });
}

/** Creates bounded labels for pass-level review metrics. */
function reviewPassTelemetryLabels(
  pass: ReviewPass,
  status: ReviewPassTelemetryStatus,
): ReviewPassTelemetryLabels {
  return {
    pass_name: sanitizeReviewTelemetryLabel(pass.name),
    status,
  };
}

/** Converts externally provided names into bounded telemetry label values. */
function sanitizeReviewTelemetryLabel(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9_.-]+/gu, "_")
    .slice(0, 80);

  return normalized.length > 0 ? normalized : "unknown";
}

/** Selects review passes from mode, changed files, retrieved context, and pass budgets. */
export function selectReviewPasses(input: SelectReviewPassesInput): readonly ReviewPassId[] {
  const mode = input.mode ?? "normal";
  const budgets = input.budgets ?? DEFAULT_REVIEW_BUDGETS;
  if (mode === "off") {
    return [];
  }

  const passes: ReviewPassId[] = ["pr_summary"];
  if (mode === "summary_only" || isDocumentationOnlyPullRequest(input.snapshot)) {
    return applyPassBudget(passes, budgets);
  }

  passes.push("behavior_change");
  if (mode === "security_only") {
    passes.push("security", "finding_judge");
    return applyPassBudget(passes, budgets);
  }
  if (mode === "tests_only") {
    passes.push("test_coverage", "finding_judge");
    return applyPassBudget(passes, budgets);
  }

  const hasSourceChanges = pullRequestHasSourceChanges(input.snapshot);
  if (hasSourceChanges) {
    passes.push("correctness", "test_coverage");
  }
  if (hasSecuritySensitiveChanges(input.snapshot, input.contextBundle)) {
    passes.push("security");
  }
  if (mode === "strict" && hasSourceChanges) {
    passes.push("performance", "architecture_pattern");
    if (hasApiContractChanges(input.snapshot)) {
      passes.push("api_contract_regression");
    }
  }
  if (passes.some(isCandidateGenerationPass)) {
    passes.push("finding_judge");
  }

  return applyPassBudget(passes, budgets);
}

/** Validation settings for deterministic finding quality gates. */
export type FindingValidationConfig = {
  /** Minimum severity that may be published. */
  readonly minimumSeverity?: FindingSeverity;
  /** Enabled categories. Defaults to all non-style categories. */
  readonly enabledCategories?: readonly FindingCategory[];
  /** Whether style-only findings are publishable. */
  readonly allowStyleFindings?: boolean;
  /** Maximum number of publishable findings after ranking. */
  readonly maxPublishableFindings?: number;
  /** Repo rule text used for basic suppression decisions. */
  readonly repoRules?: readonly string[];
  /** Previously published findings on the same pull request used for comment dedupe. */
  readonly previousPublishedFindings?: readonly PreviousPublishedFinding[];
  /** Retrieved context bundle used to validate evidence context references. */
  readonly contextBundle?: Pick<ContextBundle, "items">;
  /** Active and inactive memory facts available for validation suppression. */
  readonly memorySuppression?: FindingMemorySuppressionConfig;
  /** Immutable review policy snapshot used for policy-aware validation. */
  readonly policy?: EffectiveReviewPolicy;
};

/** Published finding fields needed to suppress duplicate visible comments on reruns. */
export type PreviousPublishedFinding = Pick<
  PublishedFinding,
  "fingerprint" | "title" | "body" | "location"
>;

/** Memory facts and repository scope used for finding suppression. */
export type FindingMemorySuppressionConfig = {
  /** Organization ID used when evaluating org-scoped memory. */
  readonly orgId: string;
  /** Repository ID used when evaluating repo-scoped memory. */
  readonly repoId: string;
  /** Memory facts available to the current review run. */
  readonly memoryFacts: readonly MemoryFact[];
};

/** Normalized validation config with defaults and optional compiled policy. */
type NormalizedFindingValidationConfig = {
  /** Minimum severity that may be published. */
  readonly minimumSeverity: FindingSeverity;
  /** Enabled categories. */
  readonly enabledCategories: readonly FindingCategory[];
  /** Whether style-only findings are publishable. */
  readonly allowStyleFindings: boolean;
  /** Maximum number of publishable findings after ranking. */
  readonly maxPublishableFindings: number;
  /** Repo rule text used for basic suppression decisions. */
  readonly repoRules: readonly string[];
  /** Previously published findings on the same pull request. */
  readonly previousPublishedFindings: readonly PreviousPublishedFinding[];
  /** Retrieved context bundle used to validate evidence context references. */
  readonly contextBundle?: Pick<ContextBundle, "items">;
  /** Active and inactive memory facts available for validation suppression. */
  readonly memorySuppression?: FindingMemorySuppressionConfig;
  /** Immutable review policy snapshot used for policy-aware validation. */
  readonly policy?: EffectiveReviewPolicy;
};

/** Duplicate group emitted by deterministic validation. */
export type FindingDuplicateGroup = {
  /** Dedupe strategy that created the group. */
  readonly groupKind: "exact" | "location" | "semantic" | "root_cause";
  /** Canonical candidate retained for ranking. */
  readonly canonicalCandidateFindingId: string;
  /** Duplicate candidates rejected in favor of the canonical candidate. */
  readonly duplicateCandidateFindingIds: readonly string[];
  /** Stable grouping key used for debugging. */
  readonly groupKey: string;
};

/** Product-safe validation event stage. */
export type FindingValidationEventStage =
  | "anchor"
  | "evidence"
  | "policy"
  | "suppression"
  | "dedupe"
  | "ranking";

/** Product-safe event explaining one validation stage for one candidate. */
export type FindingValidationEvent = {
  /** Stable event ID. */
  readonly eventId: string;
  /** Candidate finding inspected by this event. */
  readonly candidateFindingId: string;
  /** Validation stage that produced the event. */
  readonly stage: FindingValidationEventStage;
  /** Whether the candidate passed this stage. */
  readonly status: "passed" | "rejected";
  /** Rejection reasons associated with this stage. */
  readonly reasons: readonly FindingRejectionReason[];
};

/** Aggregate validation statistics for dashboards and evaluation. */
export type FindingValidationStats = {
  /** Total input candidate count. */
  readonly candidateCount: number;
  /** Count of findings accepted for publishing after ranking and budget enforcement. */
  readonly acceptedCount: number;
  /** Count of findings rejected for any validation reason. */
  readonly rejectedCount: number;
  /** Count of rejected duplicate findings. */
  readonly duplicateCount: number;
  /** Rejection counts keyed by canonical rejection reason. */
  readonly rejectionReasonCounts: Partial<Record<FindingRejectionReason, number>>;
};

/** Full validation result with publishable findings, rejected findings, stats, and trace data. */
export type FindingValidationResult = {
  /** Accepted findings in publish rank order. */
  readonly accepted: readonly ValidatedFinding[];
  /** Rejected findings with validation reasons. */
  readonly rejected: readonly ValidatedFinding[];
  /** All validated findings in deterministic persistence order. */
  readonly validated: readonly ValidatedFinding[];
  /** Duplicate groups discovered during validation. */
  readonly duplicateGroups: readonly FindingDuplicateGroup[];
  /** Aggregate validation statistics. */
  readonly stats: FindingValidationStats;
  /** Product-safe validation trace. */
  readonly trace: {
    /** Validator version that generated the trace. */
    readonly validatorVersion: string;
    /** Validation start timestamp. */
    readonly startedAt: string;
    /** Validation completion timestamp. */
    readonly completedAt: string;
    /** Per-candidate stage events. */
    readonly events: readonly FindingValidationEvent[];
  };
};

/** Input for candidate validation, dedupe, suppression, and ranking. */
export type ValidateAndRankCandidateFindingsInput = ReviewEngineTelemetryOptions & {
  /** Pull request snapshot used for anchor validation. */
  readonly snapshot: PullRequestSnapshot;
  /** Candidate findings emitted by review passes. */
  readonly findings: readonly CandidateFinding[];
  /** Timestamp used for deterministic validation output. */
  readonly timestamp: string;
  /** Optional validation policy. */
  readonly config?: FindingValidationConfig;
};

/** Validates, suppresses, deduplicates, and ranks candidate findings deterministically. */
export function validateAndRankCandidateFindings(
  input: ValidateAndRankCandidateFindingsInput,
): readonly ValidatedFinding[] {
  return validateCandidateFindings(input).validated;
}

/** Validates, suppresses, deduplicates, ranks, and explains candidate findings. */
export function validateCandidateFindings(
  input: ValidateAndRankCandidateFindingsInput,
): FindingValidationResult {
  const telemetry = startFindingValidationTelemetry(input);

  try {
    const result = validateCandidateFindingsCore(input);
    finishFindingValidationTelemetry(input, telemetry, { result });

    return result;
  } catch (error) {
    finishFindingValidationTelemetry(input, telemetry, {
      error,
      errorClass: classifyTelemetryError(error),
    });
    throw error;
  }
}

/** Runs deterministic candidate validation without telemetry side effects. */
function validateCandidateFindingsCore(
  input: ValidateAndRankCandidateFindingsInput,
): FindingValidationResult {
  const config = normalizeFindingValidationConfig(input.config);
  const state = buildAnchorState(input.snapshot);
  const seenFingerprints = new Set<string>();
  const seenLocations = new Set<string>();
  const seenSemanticSignatures: SemanticFindingSignature[] = [];
  const accepted: ValidatedFinding[] = [];
  const rejected: ValidatedFinding[] = [];
  const normalizedCandidates: CandidateFinding[] = [];

  for (const rawFinding of input.findings as readonly unknown[]) {
    const normalizedFinding = normalizeCandidateFindingForValidation(rawFinding, input.timestamp);
    const finding = normalizedFinding.finding;
    normalizedCandidates.push(finding);
    const validatorAnalysis = shouldSkipCandidateValidators(normalizedFinding.reasons)
      ? { reasons: [] }
      : rejectionAnalysis(
          finding,
          state,
          config,
          seenFingerprints,
          seenLocations,
          seenSemanticSignatures,
        );
    const analysis = {
      ...validatorAnalysis,
      reasons: mergeRejectionReasons(normalizedFinding.reasons, validatorAnalysis.reasons),
    };
    const decision = analysis.reasons.length === 0 ? "publish" : "reject";
    const validated = toValidatedFinding(finding, input.timestamp, decision, analysis);

    if (decision === "publish") {
      seenFingerprints.add(finding.fingerprint);
      seenLocations.add(locationKey(finding));
      seenSemanticSignatures.push(buildSemanticSignature(finding));
      accepted.push(validated);
    } else {
      rejected.push(validated);
    }
  }

  const rootCauseDedupe = dedupeRootCauseFindings(rankFindings(accepted));
  const rankedAccepted = rankFindings(rootCauseDedupe.accepted);
  const validated = [
    ...rankedAccepted.slice(0, config.maxPublishableFindings),
    ...rankedAccepted
      .slice(config.maxPublishableFindings)
      .map((finding) => rejectForBudget(finding)),
    ...rootCauseDedupe.rejected,
    ...rejected,
  ];
  const finalAccepted = validated.filter((finding) => finding.decision === "publish");
  const finalRejected = validated.filter((finding) => finding.decision === "reject");

  return {
    accepted: finalAccepted,
    duplicateGroups: buildDuplicateGroups(normalizedCandidates),
    rejected: finalRejected,
    stats: buildValidationStats(input.findings.length, finalAccepted, finalRejected),
    trace: buildValidationTrace(input.timestamp, validated),
    validated,
  };
}

/** Mutable state carried while the finding-validation run span is open. */
type FindingValidationTelemetryState = {
  /** Product-safe validation run span, when tracing is configured. */
  readonly span?: TelemetrySpanHandle | undefined;
  /** Monotonic start time used for duration attributes. */
  readonly startedAtMs: number;
};

/** Starts product-safe telemetry for one finding-validation run. */
function startFindingValidationTelemetry(
  input: ValidateAndRankCandidateFindingsInput,
): FindingValidationTelemetryState {
  const span = input.traces?.startSpan(OBSERVABILITY_SPAN_NAMES.findingValidationRun, {
    attributes: {
      ...findingValidationBaseAttributes(input),
      "finding_validation.candidate_count": input.findings.length,
      "finding_validation.context_item_count": input.config?.contextBundle?.items.length ?? 0,
      "finding_validation.memory_fact_count":
        input.config?.memorySuppression?.memoryFacts.length ?? 0,
      "finding_validation.previous_published_count":
        input.config?.previousPublishedFindings?.length ?? 0,
    },
    kind: "internal",
    traceContext: input.traceContext,
  });

  return {
    span,
    startedAtMs: Date.now(),
  };
}

/** Finishes finding-validation telemetry after completion or failure. */
function finishFindingValidationTelemetry(
  input: ValidateAndRankCandidateFindingsInput,
  telemetry: FindingValidationTelemetryState,
  context: {
    /** Optional error raised during validation. */
    readonly error?: unknown;
    /** Product-safe error class for failed validation. */
    readonly errorClass?: string | undefined;
    /** Completed validation result. */
    readonly result?: FindingValidationResult;
  },
): void {
  const durationMs = Math.max(0, Date.now() - telemetry.startedAtMs);
  const status = context.result ? "succeeded" : "failed";

  if (context.result) {
    recordFindingValidationMetrics(input.metrics, context.result);
    recordFindingValidationStageSpans(input, context.result);
  }

  telemetry.span?.end({
    ...(context.error ? { error: context.error } : {}),
    attributes: findingValidationRunEndAttributes(input, durationMs, status, context),
    status: status === "succeeded" ? "ok" : "error",
  });
}

/** Records aggregate validation counters without candidate text or paths. */
function recordFindingValidationMetrics(
  metrics: TelemetryMetricRecorder | undefined,
  result: FindingValidationResult,
): void {
  if (result.accepted.length > 0) {
    metrics?.count(OBSERVABILITY_METRIC_NAMES.reviewFindingsValidatedTotal, {
      labels: { decision: "publish" },
      value: result.accepted.length,
    });
    metrics?.count(OBSERVABILITY_METRIC_NAMES.reviewFindingsPublishedTotal, {
      labels: { status: "published" },
      value: result.accepted.length,
    });
  }

  if (result.rejected.length > 0) {
    metrics?.count(OBSERVABILITY_METRIC_NAMES.reviewFindingsValidatedTotal, {
      labels: { decision: "reject" },
      value: result.rejected.length,
    });
  }

  for (const [reason, count] of Object.entries(result.stats.rejectionReasonCounts) as [
    FindingRejectionReason,
    number,
  ][]) {
    if (count <= 0) {
      continue;
    }

    metrics?.count(OBSERVABILITY_METRIC_NAMES.reviewFindingsRejectedTotal, {
      labels: {
        reason,
        stage: validationStageForReason(reason),
      },
      value: count,
    });
  }
}

/** Records product-safe spans for validation sub-steps. */
function recordFindingValidationStageSpans(
  input: ValidateAndRankCandidateFindingsInput,
  result: FindingValidationResult,
): void {
  recordFindingValidationStageSpan(input, OBSERVABILITY_SPAN_NAMES.findingValidationAnchorCheck, {
    "finding_validation.checked_count": result.stats.candidateCount,
    "finding_validation.rejected_count": rejectedFindingCountForStage(result, "anchor"),
    "finding_validation.stage": "anchor",
  });
  recordFindingValidationStageSpan(input, OBSERVABILITY_SPAN_NAMES.findingValidationEvidenceCheck, {
    "finding_validation.checked_count": result.stats.candidateCount,
    "finding_validation.rejected_count": rejectedFindingCountForStage(result, "evidence"),
    "finding_validation.stage": "evidence",
  });
  recordFindingValidationStageSpan(
    input,
    OBSERVABILITY_SPAN_NAMES.findingValidationSuppressionCheck,
    {
      "finding_validation.checked_count": result.stats.candidateCount,
      "finding_validation.rejected_count": rejectedFindingCountForStage(result, "suppression"),
      "finding_validation.stage": "suppression",
    },
  );
  recordFindingValidationStageSpan(input, OBSERVABILITY_SPAN_NAMES.findingValidationDedupe, {
    "finding_validation.duplicate_group_count": result.duplicateGroups.length,
    "finding_validation.duplicate_removed_count": result.stats.duplicateCount,
    "finding_validation.rejected_count": rejectedFindingCountForStage(result, "dedupe"),
    "finding_validation.stage": "dedupe",
  });
  recordFindingValidationStageSpan(input, OBSERVABILITY_SPAN_NAMES.findingValidationRank, {
    "finding_validation.budget_truncated_count": rejectionReasonCount(result, "budget_exceeded"),
    "finding_validation.published_count": result.accepted.length,
    "finding_validation.rejected_count": rejectedFindingCountForStage(result, "ranking"),
    "finding_validation.stage": "ranking",
  });
}

/** Records one instantaneous finding-validation stage span. */
function recordFindingValidationStageSpan(
  input: ValidateAndRankCandidateFindingsInput,
  name: string,
  attributes: Readonly<Record<string, TelemetryAttributeValue | undefined>>,
): void {
  const span = input.traces?.startSpan(name, {
    attributes: {
      ...findingValidationBaseAttributes(input),
      ...attributes,
    },
    kind: "internal",
    traceContext: input.traceContext,
  });

  span?.end({
    attributes: { "finding_validation.status": "completed" },
  });
}

/** Builds product-safe shared validation span attributes. */
function findingValidationBaseAttributes(
  input: ValidateAndRankCandidateFindingsInput,
): Readonly<Record<string, TelemetryAttributeValue | undefined>> {
  return {
    "app.repo_id": input.snapshot.repoId,
    ...(reviewRunIdFromCandidateInput(input.findings)
      ? { "app.review_run_id": reviewRunIdFromCandidateInput(input.findings) }
      : {}),
  };
}

/** Builds aggregate validation run completion attributes. */
function findingValidationRunEndAttributes(
  input: ValidateAndRankCandidateFindingsInput,
  durationMs: number,
  status: "failed" | "succeeded",
  context: {
    /** Product-safe error class for failed validation. */
    readonly errorClass?: string | undefined;
    /** Completed validation result. */
    readonly result?: FindingValidationResult;
  },
): Readonly<Record<string, TelemetryAttributeValue | undefined>> {
  const result = context.result;

  return {
    ...findingValidationBaseAttributes(input),
    ...(context.errorClass ? { "finding_validation.error_class": context.errorClass } : {}),
    ...(result
      ? {
          "finding_validation.anchor_invalid_count": rejectedFindingCountForStage(result, "anchor"),
          "finding_validation.budget_truncated_count": rejectionReasonCount(
            result,
            "budget_exceeded",
          ),
          "finding_validation.candidate_count": result.stats.candidateCount,
          "finding_validation.duplicate_group_count": result.duplicateGroups.length,
          "finding_validation.duplicate_removed_count": result.stats.duplicateCount,
          "finding_validation.evidence_invalid_count": rejectedFindingCountForStage(
            result,
            "evidence",
          ),
          "finding_validation.published_count": result.accepted.length,
          "finding_validation.rejected_count": result.rejected.length,
          "finding_validation.schema_invalid_count": schemaInvalidCount(result),
          "finding_validation.schema_valid_count": Math.max(
            0,
            result.stats.candidateCount - schemaInvalidCount(result),
          ),
          "finding_validation.suppressed_count": rejectedFindingCountForStage(
            result,
            "suppression",
          ),
          "finding_validation.validated_count": result.validated.length,
        }
      : { "finding_validation.candidate_count": input.findings.length }),
    "finding_validation.duration_ms": durationMs,
    "finding_validation.status": status,
  };
}

/** Counts rejected findings with at least one reason for the requested stage. */
function rejectedFindingCountForStage(
  result: FindingValidationResult,
  stage: FindingValidationEventStage,
): number {
  const stageReasons = reasonsForValidationStage(stage);

  return result.rejected.filter((finding) =>
    finding.validation.reasons.some((reason) => stageReasons.has(reason)),
  ).length;
}

/** Counts occurrences of one validation rejection reason. */
function rejectionReasonCount(
  result: FindingValidationResult,
  reason: FindingRejectionReason,
): number {
  return result.stats.rejectionReasonCounts[reason] ?? 0;
}

/** Counts schema-invalid candidates using canonical schema rejection reasons. */
function schemaInvalidCount(result: FindingValidationResult): number {
  return (
    rejectionReasonCount(result, "invalid_schema") +
    rejectionReasonCount(result, "unsupported_schema_version")
  );
}

/** Returns the canonical validation stage for a rejection reason. */
function validationStageForReason(reason: FindingRejectionReason): FindingValidationEventStage {
  return (
    VALIDATION_EVENT_STAGES.find((stage) => reasonsForValidationStage(stage).has(reason)) ??
    "policy"
  );
}

/** Extracts a review run ID from boundary data without trusting candidate shape. */
function reviewRunIdFromCandidateInput(findings: readonly unknown[]): string | undefined {
  for (const finding of findings) {
    if (isRecord(finding) && typeof finding.reviewRunId === "string" && finding.reviewRunId) {
      return finding.reviewRunId;
    }
  }

  return undefined;
}

function normalizeFindingValidationConfig(
  config: FindingValidationConfig | undefined,
): NormalizedFindingValidationConfig {
  return {
    minimumSeverity: config?.policy?.findings.severityThreshold ?? config?.minimumSeverity ?? "low",
    enabledCategories:
      config?.policy?.findings.enabledCategories ??
      config?.enabledCategories ??
      ([
        "correctness",
        "security",
        "performance",
        "test_coverage",
        "maintainability",
        "architecture",
        "dependency",
        "documentation",
        "other",
      ] satisfies readonly FindingCategory[]),
    allowStyleFindings:
      config?.policy?.findings.allowStyleFindings ?? config?.allowStyleFindings ?? false,
    maxPublishableFindings:
      config?.policy?.findings.maxCommentsPerReview ?? config?.maxPublishableFindings ?? 10,
    ...(config?.contextBundle ? { contextBundle: config.contextBundle } : {}),
    previousPublishedFindings: config?.previousPublishedFindings ?? [],
    repoRules: config?.repoRules ?? [],
    ...(config?.memorySuppression ? { memorySuppression: config.memorySuppression } : {}),
    ...(config?.policy ? { policy: config.policy } : {}),
  };
}

/** Normalizes boundary data so every candidate can produce a validation decision. */
function normalizeCandidateFindingForValidation(
  rawFinding: unknown,
  timestamp: string,
): NormalizedCandidateFindingForValidation {
  const parsed = safeParseWithSchema("CandidateFinding", CandidateFindingSchema, rawFinding);
  if (parsed.ok) {
    return { finding: parsed.value, reasons: [] };
  }

  return {
    finding: fallbackCandidateFinding(rawFinding, timestamp),
    reasons: schemaRejectionReasons(rawFinding),
  };
}

/** Creates a contract-shaped candidate for invalid boundary data. */
function fallbackCandidateFinding(rawFinding: unknown, timestamp: string): CandidateFinding {
  const record = isRecord(rawFinding) ? rawFinding : {};
  const locationRecord = isRecord(record.location) ? record.location : {};
  const findingId = findingIdFromUnknown(record.findingId, rawFinding);
  const location = locationFromUnknown(locationRecord);
  const evidence = evidenceFromUnknown(record.evidence, findingId, location);
  const suggestedFix = boundedOptionalString(record.suggestedFix, MAX_SUGGESTED_FIX_LENGTH);

  return {
    findingId,
    schemaVersion: "candidate_finding.v1",
    reviewRunId: reviewRunIdFromUnknown(record.reviewRunId, rawFinding),
    source: findingSourceFromUnknown(record.source),
    sourceName: boundedRequiredString(record.sourceName, "unknown-source", 200),
    category: findingCategoryFromUnknown(record.category),
    severity: findingSeverityFromUnknown(record.severity),
    title: boundedRequiredString(
      record.title,
      "Invalid candidate finding",
      MAX_CANDIDATE_TITLE_LENGTH,
    ),
    body: boundedRequiredString(
      record.body,
      "Candidate finding failed schema validation.",
      MAX_CANDIDATE_BODY_LENGTH,
    ),
    location,
    evidence,
    ...(suggestedFix ? { suggestedFix } : {}),
    confidence: confidenceFromUnknown(record.confidence),
    fingerprint: boundedRequiredString(
      record.fingerprint,
      stableId("fp", [safeStableString(rawFinding)]),
      512,
    ),
    createdAt: boundedRequiredString(record.createdAt, timestamp, 64),
    ...(isRecord(record.metadata) ? { metadata: record.metadata } : {}),
  };
}

/** Maps schema failures to product validation reasons where possible. */
function schemaRejectionReasons(rawFinding: unknown): readonly FindingRejectionReason[] {
  const reasons: FindingRejectionReason[] = [];
  const record = isRecord(rawFinding) ? rawFinding : undefined;
  const locationRecord = record && isRecord(record.location) ? record.location : undefined;

  if (!record) {
    pushReason(reasons, "invalid_schema");
    return reasons;
  }

  if (record.schemaVersion !== undefined && record.schemaVersion !== "candidate_finding.v1") {
    pushReason(reasons, "unsupported_schema_version");
  }
  if (!locationRecord || typeof locationRecord.path !== "string" || !locationRecord.path.trim()) {
    pushReason(reasons, "missing_file_path");
  } else {
    const pathReason = repoPathRejectionReason(locationRecord.path);
    if (pathReason) pushReason(reasons, pathReason);
  }
  if (!locationRecord || !isPositiveInteger(locationRecord.line)) {
    pushReason(reasons, "line_missing");
  }
  if (!Array.isArray(record.evidence) || record.evidence.length === 0) {
    pushReason(reasons, "missing_evidence");
  }
  if (
    stringTooLong(record.title, MAX_CANDIDATE_TITLE_LENGTH) ||
    stringTooLong(record.body, MAX_CANDIDATE_BODY_LENGTH) ||
    stringTooLong(record.suggestedFix, MAX_SUGGESTED_FIX_LENGTH)
  ) {
    pushReason(reasons, "too_verbose");
  }
  if (
    !isFindingId(record.findingId) ||
    !isReviewRunId(record.reviewRunId) ||
    !isFindingSource(record.source) ||
    !isFindingCategory(record.category) ||
    !isFindingSeverity(record.severity) ||
    !isNonEmptyString(record.title) ||
    !isNonEmptyString(record.body) ||
    !isConfidence(record.confidence)
  ) {
    pushReason(reasons, "invalid_schema");
  }
  if (reasons.length === 0) {
    pushReason(reasons, "invalid_schema");
  }

  return reasons;
}

/** Returns whether schema normalization found a blocker for later validators. */
function shouldSkipCandidateValidators(reasons: readonly FindingRejectionReason[]): boolean {
  return reasons.some((reason) => SCHEMA_BLOCKING_REASONS.has(reason));
}

/** Merges validation reasons while preserving first-seen order. */
function mergeRejectionReasons(
  left: readonly FindingRejectionReason[],
  right: readonly FindingRejectionReason[],
): readonly FindingRejectionReason[] {
  const reasons: FindingRejectionReason[] = [];
  for (const reason of [...left, ...right]) {
    pushReason(reasons, reason);
  }

  return reasons;
}

function buildDuplicateGroups(
  findings: readonly CandidateFinding[],
): readonly FindingDuplicateGroup[] {
  const groups = new Map<string, FindingDuplicateGroup>();
  const canonicalByFingerprint = new Map<string, string>();
  const canonicalByLocation = new Map<string, string>();
  const canonicalSemanticSignatures: SemanticFindingSignature[] = [];
  const canonicalRootCauseSignatures: RootCauseFindingSignature[] = [];

  for (const finding of findings) {
    const isExactDuplicate = canonicalByFingerprint.has(finding.fingerprint);
    const isLocationDuplicate = canonicalByLocation.has(locationKey(finding));
    collectDuplicateGroup({
      canonicalByKey: canonicalByFingerprint,
      finding,
      groupKind: "exact",
      groups,
      key: finding.fingerprint,
    });
    collectDuplicateGroup({
      canonicalByKey: canonicalByLocation,
      finding,
      groupKind: "location",
      groups,
      key: locationKey(finding),
    });
    if (!isExactDuplicate && !isLocationDuplicate) {
      collectSemanticDuplicateGroup({
        canonicalSignatures: canonicalSemanticSignatures,
        finding,
        groups,
      });
    }
  }

  for (const finding of rankCandidateFindingsForDedupe(findings)) {
    collectRootCauseDuplicateGroup({
      canonicalSignatures: canonicalRootCauseSignatures,
      finding,
      groups,
    });
  }

  return [...groups.values()]
    .filter((group) => group.duplicateCandidateFindingIds.length > 0)
    .sort((left, right) => left.groupKey.localeCompare(right.groupKey));
}

function collectDuplicateGroup(input: {
  readonly canonicalByKey: Map<string, string>;
  readonly finding: CandidateFinding;
  readonly groupKind: FindingDuplicateGroup["groupKind"];
  readonly groups: Map<string, FindingDuplicateGroup>;
  readonly key: string;
}): void {
  const canonicalCandidateFindingId = input.canonicalByKey.get(input.key);
  if (!canonicalCandidateFindingId) {
    input.canonicalByKey.set(input.key, input.finding.findingId);
    return;
  }

  const groupKey = `${input.groupKind}:${input.key}`;
  const existingGroup = input.groups.get(groupKey);
  input.groups.set(groupKey, {
    canonicalCandidateFindingId,
    duplicateCandidateFindingIds: [
      ...(existingGroup?.duplicateCandidateFindingIds ?? []),
      input.finding.findingId,
    ],
    groupKey,
    groupKind: input.groupKind,
  });
}

function collectSemanticDuplicateGroup(input: {
  readonly canonicalSignatures: SemanticFindingSignature[];
  readonly finding: CandidateFinding;
  readonly groups: Map<string, FindingDuplicateGroup>;
}): void {
  const signature = buildSemanticSignature(input.finding);
  const canonicalSignature = input.canonicalSignatures.find((candidate) =>
    semanticSignaturesMatch(signature, candidate),
  );
  if (!canonicalSignature) {
    input.canonicalSignatures.push(signature);
    return;
  }

  const groupKey = `semantic:${semanticGroupKey(canonicalSignature)}`;
  const existingGroup = input.groups.get(groupKey);
  input.groups.set(groupKey, {
    canonicalCandidateFindingId: canonicalSignature.candidateFindingId,
    duplicateCandidateFindingIds: [
      ...(existingGroup?.duplicateCandidateFindingIds ?? []),
      input.finding.findingId,
    ],
    groupKey,
    groupKind: "semantic",
  });
}

function collectRootCauseDuplicateGroup(input: {
  readonly canonicalSignatures: RootCauseFindingSignature[];
  readonly finding: CandidateFinding;
  readonly groups: Map<string, FindingDuplicateGroup>;
}): void {
  const signature = buildRootCauseSignature(input.finding);
  const canonicalSignature = input.canonicalSignatures.find((candidate) =>
    rootCauseSignaturesMatch(signature, candidate),
  );
  if (!canonicalSignature) {
    input.canonicalSignatures.push(signature);
    return;
  }

  const groupKey = `root_cause:${rootCauseGroupKey(canonicalSignature)}`;
  const existingGroup = input.groups.get(groupKey);
  input.groups.set(groupKey, {
    canonicalCandidateFindingId: canonicalSignature.candidateFindingId,
    duplicateCandidateFindingIds: [
      ...(existingGroup?.duplicateCandidateFindingIds ?? []),
      input.finding.findingId,
    ],
    groupKey,
    groupKind: "root_cause",
  });
}

function rankCandidateFindingsForDedupe(
  findings: readonly CandidateFinding[],
): readonly CandidateFinding[] {
  return [...findings].sort(
    (left, right) =>
      scoreCandidateFinding(right) - scoreCandidateFinding(left) ||
      left.findingId.localeCompare(right.findingId),
  );
}

function scoreCandidateFinding(finding: CandidateFinding): number {
  return (
    severityRank(finding.severity) * 100 +
    finding.confidence * 50 +
    categoryPriority(finding.category)
  );
}

function buildValidationStats(
  candidateCount: number,
  accepted: readonly ValidatedFinding[],
  rejected: readonly ValidatedFinding[],
): FindingValidationStats {
  const rejectionReasonCounts: Partial<Record<FindingRejectionReason, number>> = {};
  for (const finding of rejected) {
    for (const reason of finding.validation.reasons) {
      rejectionReasonCounts[reason] = (rejectionReasonCounts[reason] ?? 0) + 1;
    }
  }

  return {
    acceptedCount: accepted.length,
    candidateCount,
    duplicateCount: rejected.filter((finding) =>
      finding.validation.reasons.some((reason) => DUPLICATE_REASONS.has(reason)),
    ).length,
    rejectedCount: rejected.length,
    rejectionReasonCounts,
  };
}

function buildValidationTrace(
  timestamp: string,
  findings: readonly ValidatedFinding[],
): FindingValidationResult["trace"] {
  return {
    completedAt: timestamp,
    events: findings.flatMap((finding) => validationEventsForFinding(timestamp, finding)),
    startedAt: timestamp,
    validatorVersion: "finding-validation.v2",
  };
}

function validationEventsForFinding(
  timestamp: string,
  finding: ValidatedFinding,
): readonly FindingValidationEvent[] {
  return VALIDATION_EVENT_STAGES.map((stage) => {
    const reasons = finding.validation.reasons.filter((reason) =>
      reasonsForValidationStage(stage).has(reason),
    );
    return {
      candidateFindingId: finding.candidateFindingId,
      eventId: stableId("fve", [finding.candidateFindingId, stage, timestamp]),
      reasons,
      stage,
      status: reasons.length > 0 ? "rejected" : "passed",
    };
  });
}

function reasonsForValidationStage(
  stage: FindingValidationEventStage,
): ReadonlySet<FindingRejectionReason> {
  return VALIDATION_REASONS_BY_STAGE[stage];
}

function createDeterministicBoundaryFindings(
  context: ReviewPassContext,
): readonly CandidateFinding[] {
  const file = context.snapshot.changedFiles.find(isReviewableFile);
  if (!file) {
    return [];
  }

  const line = firstAddedLine(file) ?? 1;
  const fingerprint = sha256(`${context.reviewRunId}:${file.path}:${line}:review-engine-boundary`);

  return [
    {
      findingId: stableId("fnd", [context.reviewRunId, file.path, line, fingerprint]),
      schemaVersion: "candidate_finding.v1",
      reviewRunId: context.reviewRunId,
      source: "rule",
      sourceName: deterministicBoundaryPass.name,
      category: "maintainability",
      severity: "info",
      title: "Review engine boundary reached",
      body: "This deterministic finding proves candidate findings cross the review-engine package boundary.",
      location: {
        path: file.path,
        line,
        side: "RIGHT",
        isInDiff: true,
      },
      evidence: [
        {
          evidenceId: stableId("ev", [context.reviewRunId, file.path, line]),
          kind: "diff",
          summary: "First reviewable changed file selected by the deterministic review pass.",
          path: file.path,
          range: { startLine: line, endLine: line },
          confidence: 1,
        },
      ],
      confidence: 1,
      fingerprint,
      createdAt: context.timestamp,
      metadata: { passVersion: deterministicBoundaryPass.version },
    },
  ];
}

function findingsFromLLMOutput(
  context: ReviewPassContext,
  output: LLMFindingOutput,
): readonly CandidateFinding[] {
  return output.findings.map((finding, index) => {
    const fingerprint = sha256(
      [
        context.reviewRunId,
        finding.path,
        finding.line,
        finding.category,
        finding.title,
        finding.body,
      ].join(":"),
    );

    return {
      findingId: stableId("fnd", [context.reviewRunId, llmReviewPass.name, index, fingerprint]),
      schemaVersion: "candidate_finding.v1",
      reviewRunId: context.reviewRunId,
      source: "llm",
      sourceName: llmReviewPass.name,
      category: finding.category,
      severity: finding.severity,
      title: finding.title,
      body: finding.body,
      location: {
        path: finding.path,
        line: finding.line,
        side: "RIGHT",
        isInDiff: true,
      },
      evidence: finding.evidence.map(
        (summary, evidenceIndex): Evidence => ({
          evidenceId: stableId("ev", [
            context.reviewRunId,
            finding.path,
            finding.line,
            evidenceIndex,
          ]),
          kind: "llm_reasoning",
          summary,
          path: finding.path,
          range: { startLine: finding.line, endLine: finding.line },
          confidence: finding.confidence,
        }),
      ),
      ...(finding.suggestedFix ? { suggestedFix: finding.suggestedFix } : {}),
      confidence: finding.confidence,
      fingerprint,
      createdAt: context.timestamp,
      metadata: { passVersion: llmReviewPass.version },
    };
  });
}

/** Converts a static-analysis report into candidate findings anchored to changed lines. */
function staticAnalysisFindingsFromReport(context: ReviewPassContext): readonly CandidateFinding[] {
  const report = context.staticAnalysisReport;
  if (!report) {
    return [];
  }

  return report.diagnostics
    .filter((diagnostic) => diagnostic.isInChangedFile && diagnostic.isOnChangedLine)
    .slice(0, STATIC_ANALYSIS_FINDING_LIMIT)
    .map((diagnostic, index) =>
      staticAnalysisDiagnosticFinding(context, report, diagnostic, index),
    );
}

/** Converts one normalized static-analysis diagnostic into a candidate finding. */
function staticAnalysisDiagnosticFinding(
  context: ReviewPassContext,
  report: StaticAnalysisReport,
  diagnostic: NormalizedToolDiagnostic,
  index: number,
): CandidateFinding {
  const line = Math.max(1, diagnostic.location.startLine);
  const fingerprint = sha256(["static-analysis", diagnostic.fingerprint].join(":"));
  const title = boundedText(
    `${staticAnalysisRuleLabel(diagnostic)}: ${diagnostic.message}`,
    MAX_CANDIDATE_TITLE_LENGTH,
  );
  const body = boundedText(
    [
      `${diagnostic.tool} reported this issue on a changed line.`,
      diagnostic.rawMessage ?? diagnostic.message,
      diagnostic.ruleUrl ? `Rule documentation: ${diagnostic.ruleUrl}` : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    MAX_CANDIDATE_BODY_LENGTH,
  );

  return {
    body,
    category: diagnostic.category,
    confidence: diagnostic.confidence,
    createdAt: context.timestamp,
    evidence: [
      {
        confidence: diagnostic.confidence,
        evidenceId: stableId("ev", [
          context.reviewRunId,
          staticAnalysisReviewPass.name,
          diagnostic.diagnosticId,
        ]),
        kind: "static_analysis",
        metadata: {
          diagnosticId: diagnostic.diagnosticId,
          reportId: report.reportId,
          tool: diagnostic.tool,
          toolRunId: diagnostic.toolRunId,
          ...(diagnostic.ruleId ? { ruleId: diagnostic.ruleId } : {}),
        },
        path: diagnostic.location.filePath,
        range: {
          endLine: diagnostic.location.endLine ?? line,
          startLine: line,
        },
        summary: boundedText(diagnostic.message, 1_000),
      },
    ],
    findingId: stableId("fnd", [
      context.reviewRunId,
      staticAnalysisReviewPass.name,
      index,
      fingerprint,
    ]),
    fingerprint,
    location: {
      isInDiff: true,
      line,
      path: diagnostic.location.filePath,
      side: "RIGHT",
    },
    metadata: {
      diagnosticId: diagnostic.diagnosticId,
      passVersion: staticAnalysisReviewPass.version,
      reportId: report.reportId,
      tool: diagnostic.tool,
      toolRunId: diagnostic.toolRunId,
      ...(diagnostic.ruleId ? { ruleId: diagnostic.ruleId } : {}),
    },
    reviewRunId: context.reviewRunId,
    schemaVersion: "candidate_finding.v1",
    severity: severityFromStaticDiagnostic(diagnostic.severity),
    source: "static_analysis",
    sourceName: staticAnalysisReviewPass.name,
    title,
  };
}

/** Returns a concise rule label for a static-analysis diagnostic. */
function staticAnalysisRuleLabel(diagnostic: NormalizedToolDiagnostic): string {
  return diagnostic.ruleId ?? diagnostic.ruleName ?? diagnostic.tool;
}

/** Maps normalized static-analysis severity to review finding severity. */
function severityFromStaticDiagnostic(
  severity: NormalizedToolDiagnostic["severity"],
): FindingSeverity {
  switch (severity) {
    case "critical":
      return "critical";
    case "error":
      return "high";
    case "warning":
      return "medium";
    case "info":
      return "low";
  }
}

/** Truncates text to a character limit without returning an empty string. */
function boundedText(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed.length > 0 ? trimmed : "Static-analysis diagnostic.";
  }

  return trimmed.slice(0, Math.max(1, maxLength - 1)).trimEnd();
}

function renderReviewPrompt(context: ReviewPassContext): string {
  const files = context.snapshot.changedFiles.map((file) => ({
    path: file.path,
    status: file.status,
    language: file.language,
    isGenerated: file.isGenerated,
    isTest: file.isTest,
    hunks: file.hunks.map((hunk) => ({
      hunkId: hunk.hunkId,
      header: hunk.header,
      lines: hunk.lines.map((line) => ({
        kind: line.kind,
        oldLine: line.oldLine,
        newLine: line.newLine,
        content: line.content,
      })),
    })),
  }));
  const contextItems =
    context.contextBundle?.items.map((item) => ({
      kind: item.kind,
      source: item.source,
      title: item.title,
      summary: item.summary,
      snippet: item.snippet,
      text: item.text,
      priority: item.priority,
    })) ?? [];

  return JSON.stringify({
    task: "Find concrete correctness, security, performance, test coverage, or maintainability issues.",
    rules: [
      "Return findings only for changed RIGHT-side diff lines.",
      "Do not return style-only comments.",
      "Each finding must include concrete evidence.",
      "Prefer no findings over speculative findings.",
    ],
    pullRequest: {
      title: context.snapshot.title,
      body: context.snapshot.body,
      baseSha: context.snapshot.baseSha,
      headSha: context.snapshot.headSha,
    },
    changedFiles: files,
    retrievedContext: contextItems,
  });
}

type AnchorState = {
  readonly files: ReadonlyMap<string, ChangedFile>;
  readonly addedLinesByPath: ReadonlyMap<string, ReadonlySet<number>>;
};

/** Lexical signature used for conservative deterministic semantic dedupe. */
type SemanticFindingSignature = {
  /** Candidate finding represented by this signature. */
  readonly candidateFindingId: string;
  /** Finding category used to avoid cross-domain grouping. */
  readonly category: FindingCategory;
  /** Repository path used to keep semantic groups local to a changed file. */
  readonly path: string;
  /** Normalized title and body tokens used for overlap scoring. */
  readonly tokens: ReadonlySet<string>;
};

/** Conservative signature used to collapse multiple symptoms of one root cause. */
type RootCauseFindingSignature = SemanticFindingSignature & {
  /** Line used to keep root-cause grouping local to nearby changes. */
  readonly line: number;
};

/** Rejection reasons plus explainable suppression context for one candidate. */
type FindingRejectionAnalysis = {
  /** Canonical rejection reasons produced during validation. */
  readonly reasons: readonly FindingRejectionReason[];
  /** Product-safe memory suppression decision when memory rejected the candidate. */
  readonly memorySuppression?: SuppressionDecision;
};

function buildAnchorState(snapshot: PullRequestSnapshot): AnchorState {
  return {
    files: new Map(snapshot.changedFiles.map((file) => [file.path, file])),
    addedLinesByPath: new Map(
      snapshot.changedFiles.map((file) => [
        file.path,
        new Set(
          file.hunks.flatMap((hunk) =>
            hunk.lines.flatMap((line) =>
              line.kind === "addition" && line.newLine ? [line.newLine] : [],
            ),
          ),
        ),
      ]),
    ),
  };
}

function rejectionAnalysis(
  finding: CandidateFinding,
  state: AnchorState,
  config: NormalizedFindingValidationConfig,
  seenFingerprints: ReadonlySet<string>,
  seenLocations: ReadonlySet<string>,
  seenSemanticSignatures: readonly SemanticFindingSignature[],
): FindingRejectionAnalysis {
  const reasons: FindingRejectionReason[] = [];
  const pathReason = repoPathRejectionReason(finding.location.path);
  if (pathReason) pushReason(reasons, pathReason);
  const file = pathReason ? undefined : state.files.get(finding.location.path);
  const addedLines = pathReason ? undefined : state.addedLinesByPath.get(finding.location.path);

  if (!pathReason && !file) pushReason(reasons, "file_not_in_pr");
  if (!pathReason && file?.status === "deleted") pushReason(reasons, "file_deleted");
  if (!pathReason && file?.isBinary) pushReason(reasons, "binary_file");
  if (!pathReason && file?.isGenerated) pushReason(reasons, "generated_file");
  if (finding.location.side !== "RIGHT") pushReason(reasons, "wrong_diff_side");
  if (!isPositiveInteger(finding.location.line)) pushReason(reasons, "line_missing");
  if (
    isPositiveInteger(finding.location.line) &&
    !pathReason &&
    !addedLines?.has(finding.location.line)
  ) {
    pushReason(reasons, "line_not_in_diff");
  }
  if (finding.evidence.length === 0) pushReason(reasons, "missing_evidence");
  if (hasWeakEvidence(finding)) pushReason(reasons, "weak_evidence");
  if (hasInvalidContextReference(finding, config)) {
    pushReason(reasons, "invalid_context_reference");
  }
  if (hasUnsafeSuggestedFix(finding)) pushReason(reasons, "unsafe_suggested_fix");
  if (containsSecretLikeValue(finding)) pushReason(reasons, "contains_secret");
  if (finding.confidence < 0.55) pushReason(reasons, "low_confidence");
  if (severityRank(finding.severity) < severityRank(config.minimumSeverity)) {
    pushReason(reasons, "below_severity_threshold");
  }
  if (!config.enabledCategories.includes(finding.category))
    pushReason(reasons, "category_disabled");
  if (finding.category === "style" && !config.allowStyleFindings) pushReason(reasons, "style_only");
  const isExactDuplicate = seenFingerprints.has(finding.fingerprint);
  const isLocationDuplicate = seenLocations.has(locationKey(finding));
  if (isExactDuplicate) pushReason(reasons, "duplicate_exact");
  if (isLocationDuplicate) pushReason(reasons, "duplicate_location");
  if (
    !isExactDuplicate &&
    !isLocationDuplicate &&
    hasSemanticDuplicate(finding, seenSemanticSignatures)
  ) {
    pushReason(reasons, "duplicate_semantic");
  }
  if (isDuplicatePreviousPublishedFinding(finding, config.previousPublishedFindings)) {
    pushReason(reasons, "duplicate_previous_comment");
  }
  if (isSuppressedByRepoRule(finding, config.repoRules)) {
    pushReason(reasons, "suppressed_by_repo_rule");
  }
  const memorySuppression = memorySuppressionDecision(finding, config);
  if (memorySuppression?.suppressed) {
    pushReason(reasons, "suppressed_by_memory");
  }
  if (config.policy) {
    const policyDecision = evaluateFindingPolicy({ policy: config.policy, finding });
    const policyReason = policyReasonToRejectionReason(policyDecision.reasonCode);
    if (!policyDecision.shouldPublish && policyReason) {
      pushReason(reasons, policyReason);
    }
  }

  return {
    ...(memorySuppression?.suppressed ? { memorySuppression } : {}),
    reasons,
  };
}

/** Returns whether evidence is present but too weak to support a finding. */
function hasWeakEvidence(finding: CandidateFinding): boolean {
  return finding.evidence.some(
    (evidence) =>
      evidence.summary.trim().length < MIN_EVIDENCE_SUMMARY_LENGTH ||
      evidence.confidence < MIN_EVIDENCE_CONFIDENCE,
  );
}

/** Returns whether a candidate references context outside the retrieved bundle. */
function hasInvalidContextReference(
  finding: CandidateFinding,
  config: NormalizedFindingValidationConfig,
): boolean {
  const referencedContextIds = finding.evidence
    .map((evidence) => evidence.contextItemId)
    .filter((contextItemId): contextItemId is string => Boolean(contextItemId));
  if (referencedContextIds.length === 0) {
    return false;
  }

  const knownContextIds = new Set(
    config.contextBundle?.items.map((item) => item.contextItemId) ?? [],
  );
  if (knownContextIds.size === 0) {
    return true;
  }

  return referencedContextIds.some((contextItemId) => !knownContextIds.has(contextItemId));
}

/** Returns whether a suggested fix contains unsafe shell-like operations. */
function hasUnsafeSuggestedFix(finding: CandidateFinding): boolean {
  const suggestedFix = finding.suggestedFix?.toLowerCase();
  if (!suggestedFix) {
    return false;
  }

  return UNSAFE_SUGGESTED_FIX_PATTERNS.some((pattern) => pattern.test(suggestedFix));
}

/** Evaluates configured memory facts for one candidate finding. */
function memorySuppressionDecision(
  finding: CandidateFinding,
  config: NormalizedFindingValidationConfig,
): SuppressionDecision | undefined {
  if (!config.memorySuppression || config.memorySuppression.memoryFacts.length === 0) {
    return undefined;
  }

  return evaluateSuppression({
    candidateFinding: finding,
    memoryFacts: config.memorySuppression.memoryFacts,
    orgId: config.memorySuppression.orgId,
    repoId: config.memorySuppression.repoId,
  });
}

/** Adds a rejection reason once while preserving decision order. */
function pushReason(reasons: FindingRejectionReason[], reason: FindingRejectionReason): void {
  if (!reasons.includes(reason)) {
    reasons.push(reason);
  }
}

/** Returns whether a value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns whether a value is a non-empty string. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Returns whether a value is a valid finding ID. */
function isFindingId(value: unknown): value is CandidateFinding["findingId"] {
  return typeof value === "string" && /^fnd_[A-Za-z0-9_-]+$/u.test(value);
}

/** Returns whether a value is a valid evidence ID. */
function isEvidenceId(value: unknown): value is Evidence["evidenceId"] {
  return typeof value === "string" && /^ev_[A-Za-z0-9_-]+$/u.test(value);
}

/** Returns whether a value is a valid review run ID. */
function isReviewRunId(value: unknown): value is CandidateFinding["reviewRunId"] {
  return typeof value === "string" && /^rrn_[A-Za-z0-9_-]+$/u.test(value);
}

/** Returns whether a value is a valid finding source. */
function isFindingSource(value: unknown): value is FindingSource {
  return typeof value === "string" && FINDING_SOURCES.has(value as FindingSource);
}

/** Returns whether a value is a valid finding category. */
function isFindingCategory(value: unknown): value is FindingCategory {
  return typeof value === "string" && FINDING_CATEGORIES.has(value as FindingCategory);
}

/** Returns whether a value is a valid finding severity. */
function isFindingSeverity(value: unknown): value is FindingSeverity {
  return typeof value === "string" && FINDING_SEVERITIES.has(value as FindingSeverity);
}

/** Returns whether a value is a valid confidence score. */
function isConfidence(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Returns whether a value is a positive integer. */
function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1;
}

/** Returns whether a string field exceeds a contract maximum. */
function stringTooLong(value: unknown, maxLength: number): boolean {
  return typeof value === "string" && value.length > maxLength;
}

/** Builds a stable finding ID from unknown boundary data. */
function findingIdFromUnknown(value: unknown, rawFinding: unknown): CandidateFinding["findingId"] {
  return isFindingId(value)
    ? value
    : stableId("fnd", ["invalid-candidate", safeStableString(rawFinding)]);
}

/** Builds a stable review run ID from unknown boundary data. */
function reviewRunIdFromUnknown(
  value: unknown,
  rawFinding: unknown,
): CandidateFinding["reviewRunId"] {
  return isReviewRunId(value)
    ? value
    : stableId("rrn", ["invalid-candidate", safeStableString(rawFinding)]);
}

/** Coerces an unknown value into a known finding source. */
function findingSourceFromUnknown(value: unknown): FindingSource {
  return isFindingSource(value) ? value : "llm";
}

/** Coerces an unknown value into a known finding category. */
function findingCategoryFromUnknown(value: unknown): FindingCategory {
  return isFindingCategory(value) ? value : "other";
}

/** Coerces an unknown value into a known finding severity. */
function findingSeverityFromUnknown(value: unknown): FindingSeverity {
  return isFindingSeverity(value) ? value : "low";
}

/** Coerces an unknown value into a bounded confidence score. */
function confidenceFromUnknown(value: unknown): number {
  return isConfidence(value) ? value : 0;
}

/** Coerces an unknown value into a bounded required string. */
function boundedRequiredString(value: unknown, fallback: string, maxLength: number): string {
  const source = isNonEmptyString(value) ? value : fallback;
  return source.slice(0, maxLength);
}

/** Coerces an unknown value into a bounded optional string. */
function boundedOptionalString(value: unknown, maxLength: number): string | undefined {
  return isNonEmptyString(value) ? value.slice(0, maxLength) : undefined;
}

/** Builds a safe fallback candidate location from unknown boundary data. */
function locationFromUnknown(value: Record<string, unknown>): CandidateFinding["location"] {
  const rawPath = typeof value.path === "string" ? value.path : "";
  const pathReason = repoPathRejectionReason(rawPath);
  const path =
    pathReason === "missing_file_path"
      ? "__missing_path__"
      : pathReason === "invalid_file_path"
        ? "__invalid_path__"
        : rawPath;

  return {
    path,
    line: isPositiveInteger(value.line) ? value.line : 1,
    side: value.side === "LEFT" || value.side === "RIGHT" ? value.side : "RIGHT",
    isInDiff: value.isInDiff === true,
  };
}

/** Builds safe fallback evidence from unknown boundary data. */
function evidenceFromUnknown(
  value: unknown,
  findingId: string,
  location: CandidateFinding["location"],
): Evidence[] {
  if (Array.isArray(value) && value.length > 0) {
    return value.map((rawEvidence, index) =>
      evidenceItemFromUnknown(rawEvidence, findingId, index, location),
    );
  }

  return [
    {
      evidenceId: stableId("ev", [findingId, "schema-validation"]),
      kind: "external",
      summary: "Candidate failed schema validation before evidence could be trusted.",
      path: location.path,
      range: { startLine: location.line, endLine: location.line },
      confidence: 0,
    },
  ];
}

/** Builds one safe fallback evidence item from unknown boundary data. */
function evidenceItemFromUnknown(
  rawEvidence: unknown,
  findingId: string,
  index: number,
  location: CandidateFinding["location"],
): Evidence {
  const record = isRecord(rawEvidence) ? rawEvidence : {};
  return {
    evidenceId: isEvidenceId(record.evidenceId)
      ? record.evidenceId
      : stableId("ev", [findingId, index]),
    kind: evidenceKindFromUnknown(record.kind),
    summary: boundedRequiredString(
      record.summary,
      "Candidate evidence failed schema validation.",
      1000,
    ),
    path:
      typeof record.path === "string" && !repoPathRejectionReason(record.path)
        ? record.path
        : location.path,
    range: { startLine: location.line, endLine: location.line },
    confidence: isConfidence(record.confidence) ? record.confidence : 0,
    ...(isNonEmptyString(record.contextItemId)
      ? { contextItemId: boundedRequiredString(record.contextItemId, "", 128) }
      : {}),
  };
}

/** Coerces an unknown evidence kind into a known evidence kind. */
function evidenceKindFromUnknown(value: unknown): Evidence["kind"] {
  const evidenceKinds = new Set<Evidence["kind"]>([
    "code_snippet",
    "diff",
    "external",
    "llm_reasoning",
    "memory_fact",
    "repo_rule",
    "static_analysis",
    "symbol_graph",
  ]);
  return typeof value === "string" && evidenceKinds.has(value as Evidence["kind"])
    ? (value as Evidence["kind"])
    : "external";
}

/** Returns a path rejection reason for unsafe or missing repository paths. */
function repoPathRejectionReason(
  path: string,
): "missing_file_path" | "invalid_file_path" | undefined {
  const trimmedPath = path.trim();
  if (!trimmedPath) {
    return "missing_file_path";
  }
  if (
    trimmedPath.startsWith("/") ||
    trimmedPath.includes("\\") ||
    trimmedPath.split("/").some((segment) => segment === "..")
  ) {
    return "invalid_file_path";
  }

  return undefined;
}

/** Serializes unknown boundary data for deterministic fallback IDs. */
function safeStableString(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Maps policy reason codes to finding rejection reasons. */
function policyReasonToRejectionReason(reasonCode: string): FindingRejectionReason | undefined {
  switch (reasonCode) {
    case "review_disabled":
      return "publisher_unsupported";
    case "path_ignored":
      return "ignored_path";
    case "generated_file":
      return "generated_file";
    case "missing_evidence":
      return "missing_evidence";
    case "confidence_below_threshold":
      return "low_confidence";
    case "severity_below_threshold":
      return "below_severity_threshold";
    case "category_disabled":
      return "category_disabled";
    case "style_disabled":
      return "style_only";
    case "suppressed_by_repo_rule":
      return "suppressed_by_repo_rule";
    default:
      return undefined;
  }
}

function toValidatedFinding(
  finding: CandidateFinding,
  timestamp: string,
  decision: "publish" | "reject",
  analysis: FindingRejectionAnalysis,
): ValidatedFinding {
  return {
    findingId: stableId("fnd", [finding.findingId, "validation.v2"]),
    candidateFindingId: finding.findingId,
    reviewRunId: finding.reviewRunId,
    decision,
    category: finding.category,
    severity: finding.severity,
    title: finding.title,
    body: finding.body,
    location: finding.location,
    evidence: finding.evidence,
    confidence: finding.confidence,
    validation: {
      validatedAt: timestamp,
      validatorVersion: "finding-validation.v2",
      reasons: [...analysis.reasons],
    },
    fingerprint: finding.fingerprint,
    metadata: validationMetadata(finding, analysis),
  };
}

/** Builds product-safe validation metadata for persisted findings. */
function validationMetadata(
  finding: CandidateFinding,
  analysis: FindingRejectionAnalysis,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = { candidateSourceName: finding.sourceName };
  if (analysis.memorySuppression?.suppressed) {
    metadata.memorySuppression = {
      confidence: analysis.memorySuppression.confidence,
      matchKind: analysis.memorySuppression.matchKind,
      memoryFactId: analysis.memorySuppression.memoryFactId,
      reason: analysis.memorySuppression.reason,
    };
  }

  return metadata;
}

function rankFindings(findings: readonly ValidatedFinding[]): readonly ValidatedFinding[] {
  return [...findings]
    .sort(
      (left, right) =>
        scoreFinding(right) - scoreFinding(left) || left.findingId.localeCompare(right.findingId),
    )
    .map((finding, index) => ({ ...finding, rank: index + 1 }));
}

/** Collapses accepted findings that are likely symptoms of one root cause. */
function dedupeRootCauseFindings(findings: readonly ValidatedFinding[]): {
  readonly accepted: readonly ValidatedFinding[];
  readonly rejected: readonly ValidatedFinding[];
} {
  const accepted: ValidatedFinding[] = [];
  const rejected: ValidatedFinding[] = [];
  const rootCauseSignatures: RootCauseFindingSignature[] = [];

  for (const finding of findings) {
    const signature = buildRootCauseSignature(finding);
    if (
      rootCauseSignatures.some((canonicalSignature) =>
        rootCauseSignaturesMatch(signature, canonicalSignature),
      )
    ) {
      rejected.push(rejectForRootCause(finding));
    } else {
      rootCauseSignatures.push(signature);
      accepted.push(finding);
    }
  }

  return { accepted, rejected };
}

function rejectForRootCause(finding: ValidatedFinding): ValidatedFinding {
  const { rank: _rank, ...unrankedFinding } = finding;
  return {
    ...unrankedFinding,
    decision: "reject",
    validation: {
      ...finding.validation,
      reasons: ["duplicate_root_cause"],
    },
  };
}

function rejectForBudget(finding: ValidatedFinding): ValidatedFinding {
  return {
    findingId: finding.findingId,
    candidateFindingId: finding.candidateFindingId,
    reviewRunId: finding.reviewRunId,
    decision: "reject",
    category: finding.category,
    severity: finding.severity,
    title: finding.title,
    body: finding.body,
    location: finding.location,
    evidence: finding.evidence,
    confidence: finding.confidence,
    validation: {
      ...finding.validation,
      reasons: ["budget_exceeded"],
    },
    fingerprint: finding.fingerprint,
    ...(finding.metadata ? { metadata: finding.metadata } : {}),
  };
}

function scoreFinding(finding: ValidatedFinding): number {
  return (
    severityRank(finding.severity) * 100 +
    finding.confidence * 50 +
    categoryPriority(finding.category)
  );
}

function severityRank(severity: FindingSeverity): number {
  return { info: 0, low: 1, medium: 2, high: 3, critical: 4 }[severity];
}

function categoryPriority(category: FindingCategory): number {
  return {
    security: 8,
    correctness: 7,
    performance: 5,
    test_coverage: 4,
    dependency: 4,
    architecture: 3,
    maintainability: 2,
    documentation: 1,
    other: 0,
    style: -5,
  }[category];
}

function locationKey(finding: CandidateFinding): string {
  return `${finding.location.path}:${finding.location.side}:${finding.location.line}`;
}

/** Returns whether the candidate overlaps strongly with a previously accepted finding. */
function hasSemanticDuplicate(
  finding: CandidateFinding,
  seenSignatures: readonly SemanticFindingSignature[],
): boolean {
  const signature = buildSemanticSignature(finding);
  return seenSignatures.some((seenSignature) => semanticSignaturesMatch(signature, seenSignature));
}

/** Returns whether this candidate duplicates a previously published visible finding. */
function isDuplicatePreviousPublishedFinding(
  finding: CandidateFinding,
  previousFindings: readonly PreviousPublishedFinding[],
): boolean {
  if (previousFindings.length === 0) {
    return false;
  }

  return previousFindings.some(
    (previousFinding) =>
      previousFinding.fingerprint === finding.fingerprint ||
      previousPublishedFindingMatches(finding, previousFinding),
  );
}

/** Compares a candidate against one previous published finding using product-safe fields. */
function previousPublishedFindingMatches(
  finding: CandidateFinding,
  previousFinding: PreviousPublishedFinding,
): boolean {
  if (previousFinding.location.path !== finding.location.path) {
    return false;
  }

  const sameLine = previousFinding.location.line === finding.location.line;
  const candidateTokens = semanticTokens(`${finding.title}\n${finding.body}`);
  const previousTokens = semanticTokens(`${previousFinding.title}\n${previousFinding.body}`);
  const overlap = intersectionSize(candidateTokens, previousTokens);
  if (overlap < SEMANTIC_DUPLICATE_MIN_OVERLAP) {
    return false;
  }

  const union = candidateTokens.size + previousTokens.size - overlap;
  return union > 0 && (sameLine || overlap / union >= SEMANTIC_DUPLICATE_SIMILARITY);
}

/** Builds a deterministic semantic signature from user-facing finding text. */
function buildSemanticSignature(finding: CandidateFinding): SemanticFindingSignature {
  return {
    candidateFindingId: finding.findingId,
    category: finding.category,
    path: finding.location.path,
    tokens: semanticTokens(`${finding.title}\n${finding.body}`),
  };
}

/** Builds a root-cause signature from the fields shared by candidate and validated findings. */
function buildRootCauseSignature(
  finding: Pick<CandidateFinding | ValidatedFinding, "category" | "title" | "body" | "location"> &
    Partial<Pick<CandidateFinding, "findingId">> &
    Partial<Pick<ValidatedFinding, "candidateFindingId">>,
): RootCauseFindingSignature {
  return {
    candidateFindingId: finding.candidateFindingId ?? finding.findingId ?? "unknown_candidate",
    category: finding.category,
    line: finding.location.line,
    path: finding.location.path,
    tokens: semanticTokens(`${finding.title}\n${finding.body}`),
  };
}

/** Returns whether two semantic signatures are close enough to collapse. */
function semanticSignaturesMatch(
  left: SemanticFindingSignature,
  right: SemanticFindingSignature,
): boolean {
  if (left.category !== right.category || left.path !== right.path) return false;

  const overlap = intersectionSize(left.tokens, right.tokens);
  if (overlap < SEMANTIC_DUPLICATE_MIN_OVERLAP) return false;

  const union = left.tokens.size + right.tokens.size - overlap;
  return union > 0 && overlap / union >= SEMANTIC_DUPLICATE_SIMILARITY;
}

/** Returns whether two findings likely describe symptoms of one root cause. */
function rootCauseSignaturesMatch(
  left: RootCauseFindingSignature,
  right: RootCauseFindingSignature,
): boolean {
  if (left.path !== right.path || !rootCauseCategoriesCompatible(left.category, right.category)) {
    return false;
  }
  if (Math.abs(left.line - right.line) > ROOT_CAUSE_MAX_LINE_DISTANCE) {
    return false;
  }

  const overlap = intersectionSize(left.tokens, right.tokens);
  if (overlap < ROOT_CAUSE_MIN_OVERLAP) {
    return false;
  }

  const union = left.tokens.size + right.tokens.size - overlap;
  return union > 0 && overlap / union >= ROOT_CAUSE_SIMILARITY;
}

/** Returns whether categories may describe the same root cause. */
function rootCauseCategoriesCompatible(
  left: CandidateFinding["category"],
  right: CandidateFinding["category"],
): boolean {
  if (left === right) {
    return true;
  }

  const pair = new Set([left, right]);
  return (
    (pair.has("correctness") && pair.has("security")) ||
    (pair.has("correctness") && pair.has("test_coverage")) ||
    (pair.has("performance") && pair.has("architecture"))
  );
}

/** Creates a stable group key for semantically equivalent findings. */
function semanticGroupKey(signature: SemanticFindingSignature): string {
  return [
    signature.path,
    signature.category,
    [...signature.tokens].sort().slice(0, SEMANTIC_DUPLICATE_GROUP_KEY_TOKEN_LIMIT).join("-"),
  ].join(":");
}

/** Creates a stable group key for root-cause-equivalent findings. */
function rootCauseGroupKey(signature: RootCauseFindingSignature): string {
  return [
    signature.path,
    [...signature.tokens].sort().slice(0, ROOT_CAUSE_GROUP_KEY_TOKEN_LIMIT).join("-"),
  ].join(":");
}

/** Extracts normalized content tokens for deterministic semantic dedupe. */
function semanticTokens(text: string): ReadonlySet<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .map(normalizeSemanticToken)
      .filter((token) => token.length >= SEMANTIC_TOKEN_MIN_LENGTH)
      .filter((token) => !SEMANTIC_STOP_WORDS.has(token)),
  );
}

/** Normalizes one token without introducing language-specific stemming dependencies. */
function normalizeSemanticToken(token: string): string {
  if (token.length > 5 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 6 && token.endsWith("ing")) return token.slice(0, -3);
  if (token.length > 5 && token.endsWith("ed")) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith("s") && !token.endsWith("ss")) {
    return token.slice(0, -1);
  }

  return token;
}

/** Counts shared entries in two sets. */
function intersectionSize(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let count = 0;
  const [smaller, larger] = left.size < right.size ? [left, right] : [right, left];
  for (const value of smaller) {
    if (larger.has(value)) count += 1;
  }

  return count;
}

function isSuppressedByRepoRule(finding: CandidateFinding, repoRules: readonly string[]): boolean {
  const haystack = `${finding.location.path}\n${finding.title}\n${finding.body}`.toLowerCase();
  return repoRules.some((rule) => {
    const normalizedRule = rule.toLowerCase();
    return (
      (normalizedRule.includes("do not publish") || normalizedRule.includes("suppress")) &&
      normalizedRule
        .split(/[^a-z0-9_.-]+/)
        .filter((token) => token.length >= 4)
        .some((token) => haystack.includes(token))
    );
  });
}

/** Detects high-confidence secret-like values in user-visible finding text. */
function containsSecretLikeValue(finding: CandidateFinding): boolean {
  const visibleText = [
    finding.title,
    finding.body,
    finding.suggestedFix,
    ...finding.evidence.flatMap((evidence) => [evidence.summary, evidence.quote]),
  ]
    .filter(Boolean)
    .join("\n");

  return SECRET_LIKE_PATTERNS.some((pattern) => pattern.test(visibleText));
}

function applyPassBudget(
  passes: readonly ReviewPassId[],
  budgets: ReviewBudgets,
): readonly ReviewPassId[] {
  return passes.slice(0, Math.max(0, budgets.maxPasses));
}

function isCandidateGenerationPass(passId: ReviewPassId): boolean {
  return passId !== "pr_summary" && passId !== "behavior_change" && passId !== "finding_judge";
}

function isDocumentationOnlyPullRequest(snapshot: PullRequestSnapshot): boolean {
  const reviewableFiles = snapshot.changedFiles.filter(
    (file) => isReviewableFile(file) && !file.isGenerated,
  );
  return reviewableFiles.length > 0 && reviewableFiles.every(isDocumentationFile);
}

function pullRequestHasSourceChanges(snapshot: PullRequestSnapshot): boolean {
  return snapshot.changedFiles.some(
    (file) =>
      isReviewableFile(file) && !file.isGenerated && !file.isTest && !isDocumentationFile(file),
  );
}

function hasSecuritySensitiveChanges(
  snapshot: PullRequestSnapshot,
  contextBundle?: ContextBundle,
): boolean {
  const snapshotText = snapshot.changedFiles.map(fileSearchText).join("\n").toLowerCase();
  const contextText =
    contextBundle?.items
      .map((item) => [item.title, item.summary, item.text].filter(Boolean).join("\n"))
      .join("\n")
      .toLowerCase() ?? "";
  const haystack = `${snapshotText}\n${contextText}`;
  return SECURITY_SENSITIVE_TERMS.some((term) => haystack.includes(term));
}

function hasApiContractChanges(snapshot: PullRequestSnapshot): boolean {
  return snapshot.changedFiles.some((file) => {
    const path = file.path.toLowerCase();
    return API_CONTRACT_PATH_TERMS.some((term) => path.includes(term));
  });
}

function isDocumentationFile(file: ChangedFile): boolean {
  const path = file.path.toLowerCase();
  return (
    path.startsWith("docs/") ||
    path.endsWith(".md") ||
    path.endsWith(".mdx") ||
    path.endsWith(".txt") ||
    path.endsWith(".adoc") ||
    path.endsWith(".rst")
  );
}

function fileSearchText(file: ChangedFile): string {
  return [
    file.path,
    file.language,
    file.patch,
    ...file.hunks.flatMap((hunk) => hunk.lines.map((line) => line.content)),
  ]
    .filter(Boolean)
    .join("\n");
}

function isReviewableFile(file: ChangedFile): boolean {
  return !file.isBinary && file.status !== "deleted" && file.additions > 0;
}

const SECURITY_SENSITIVE_TERMS = [
  "auth",
  "authorization",
  "credential",
  "csrf",
  "jwt",
  "oauth",
  "password",
  "permission",
  "secret",
  "session",
  "token",
] as const;

const API_CONTRACT_PATH_TERMS = [
  "api/",
  "contract",
  "migration",
  "openapi",
  "schema",
  "types",
] as const;

const SECRET_LIKE_PATTERNS = [
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bgh[pousr]_[A-Za-z0-9_]{36,}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{16,}/iu,
] as const;

const UNSAFE_SUGGESTED_FIX_PATTERNS = [
  /\brm\s+-rf\s+\/(?:\s|$)/u,
  /\b(?:curl|wget)\b[^\n|;&]*(?:\||&&)\s*(?:sh|bash)\b/u,
  /-----begin [a-z ]*private key-----/u,
] as const;

const VALIDATION_EVENT_STAGES = [
  "anchor",
  "evidence",
  "policy",
  "suppression",
  "dedupe",
  "ranking",
] as const satisfies readonly FindingValidationEventStage[];

const ANCHOR_REASONS = new Set<FindingRejectionReason>([
  "binary_file",
  "file_deleted",
  "file_not_in_pr",
  "generated_file",
  "invalid_file_path",
  "line_anchor_unavailable",
  "line_missing",
  "line_not_in_diff",
  "missing_file_path",
  "stale_snapshot",
  "wrong_diff_side",
]);

const EVIDENCE_REASONS = new Set<FindingRejectionReason>([
  "contradicted_by_context",
  "contains_secret",
  "invalid_context_reference",
  "missing_evidence",
  "not_actionable",
  "too_verbose",
  "unsafe_suggested_fix",
  "weak_evidence",
]);

const POLICY_REASONS = new Set<FindingRejectionReason>([
  "below_severity_threshold",
  "category_disabled",
  "ignored_path",
  "internal_error",
  "invalid_schema",
  "low_confidence",
  "publisher_unsupported",
  "style_only",
  "unsupported_schema_version",
]);

const SUPPRESSION_REASONS = new Set<FindingRejectionReason>([
  "suppressed_by_memory",
  "suppressed_by_repo_rule",
]);

const DUPLICATE_REASONS = new Set<FindingRejectionReason>([
  "duplicate_exact",
  "duplicate_location",
  "duplicate_previous_comment",
  "duplicate_root_cause",
  "duplicate_semantic",
]);

const RANKING_REASONS = new Set<FindingRejectionReason>(["budget_exceeded"]);

const SEMANTIC_DUPLICATE_GROUP_KEY_TOKEN_LIMIT = 12;

const SEMANTIC_DUPLICATE_MIN_OVERLAP = 5;

const SEMANTIC_DUPLICATE_SIMILARITY = 0.5;

const ROOT_CAUSE_GROUP_KEY_TOKEN_LIMIT = 10;

const ROOT_CAUSE_MAX_LINE_DISTANCE = 120;

const ROOT_CAUSE_MIN_OVERLAP = 4;

const ROOT_CAUSE_SIMILARITY = 0.35;

const SEMANTIC_TOKEN_MIN_LENGTH = 4;

const SEMANTIC_STOP_WORDS = new Set([
  "about",
  "after",
  "before",
  "could",
  "from",
  "have",
  "into",
  "more",
  "return",
  "that",
  "this",
  "when",
  "which",
  "with",
  "without",
]);

const VALIDATION_REASONS_BY_STAGE: Record<
  FindingValidationEventStage,
  ReadonlySet<FindingRejectionReason>
> = {
  anchor: ANCHOR_REASONS,
  dedupe: DUPLICATE_REASONS,
  evidence: EVIDENCE_REASONS,
  policy: POLICY_REASONS,
  ranking: RANKING_REASONS,
  suppression: SUPPRESSION_REASONS,
};

function firstAddedLine(file: ChangedFile): number | undefined {
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "addition" && line.newLine) {
        return line.newLine;
      }
    }
  }

  return undefined;
}

function stableId(prefix: string, parts: readonly unknown[]): string {
  const hash = createHash("sha256")
    .update(parts.map((part) => String(part)).join(":"))
    .digest("base64url")
    .slice(0, 26);

  return `${prefix}_${hash}`;
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
