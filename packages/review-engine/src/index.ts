import { createHash } from "node:crypto";
import type { FindingCategory, FindingSeverity } from "@repo/contracts/enums/finding";
import type { ChangedFile } from "@repo/contracts/pull-request/diff";
import type { PullRequestSnapshot } from "@repo/contracts/pull-request/pull-request";
import type { ContextBundle } from "@repo/contracts/review/context";
import type {
  CandidateFinding,
  Evidence,
  FindingRejectionReason,
  LLMFindingOutput,
  ValidatedFinding,
} from "@repo/contracts/review/finding";
import type { LLMGateway } from "@repo/llm-gateway";

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

/** Runs review passes in order and returns all emitted candidate findings. */
export async function runReviewPasses(input: {
  /** Passes to execute. */
  readonly passes?: readonly ReviewPass[];
  /** Review pass context shared across passes. */
  readonly context: ReviewPassContext;
}): Promise<readonly CandidateFinding[]> {
  const passes = input.passes ?? [deterministicBoundaryPass];
  const findingSets = await Promise.all(passes.map((pass) => pass.run(input.context)));

  return findingSets.flat();
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
};

/** Input for candidate validation, dedupe, suppression, and ranking. */
export type ValidateAndRankCandidateFindingsInput = {
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
  const config = {
    minimumSeverity: input.config?.minimumSeverity ?? "low",
    enabledCategories:
      input.config?.enabledCategories ??
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
    allowStyleFindings: input.config?.allowStyleFindings ?? false,
    maxPublishableFindings: input.config?.maxPublishableFindings ?? 10,
    repoRules: input.config?.repoRules ?? [],
  };
  const state = buildAnchorState(input.snapshot);
  const seenFingerprints = new Set<string>();
  const seenLocations = new Set<string>();
  const accepted: ValidatedFinding[] = [];
  const rejected: ValidatedFinding[] = [];

  for (const finding of input.findings) {
    const reasons = rejectionReasons(finding, state, config, seenFingerprints, seenLocations);
    const decision = reasons.length === 0 ? "publish" : "reject";
    const validated = toValidatedFinding(finding, input.timestamp, decision, reasons);

    if (decision === "publish") {
      seenFingerprints.add(finding.fingerprint);
      seenLocations.add(locationKey(finding));
      accepted.push(validated);
    } else {
      rejected.push(validated);
    }
  }

  return [
    ...rankFindings(accepted).slice(0, config.maxPublishableFindings),
    ...rankFindings(accepted)
      .slice(config.maxPublishableFindings)
      .map((finding) => rejectForBudget(finding)),
    ...rejected,
  ];
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

function rejectionReasons(
  finding: CandidateFinding,
  state: AnchorState,
  config: Required<FindingValidationConfig>,
  seenFingerprints: ReadonlySet<string>,
  seenLocations: ReadonlySet<string>,
): readonly FindingRejectionReason[] {
  const reasons: FindingRejectionReason[] = [];
  const file = state.files.get(finding.location.path);
  const addedLines = state.addedLinesByPath.get(finding.location.path);

  if (!file) reasons.push("file_not_in_pr");
  if (file?.status === "deleted") reasons.push("file_deleted");
  if (file?.isBinary) reasons.push("binary_file");
  if (file?.isGenerated) reasons.push("generated_file");
  if (finding.location.side !== "RIGHT") reasons.push("wrong_diff_side");
  if (!finding.location.line) reasons.push("line_missing");
  if (!addedLines?.has(finding.location.line)) reasons.push("line_not_in_diff");
  if (finding.evidence.length === 0) reasons.push("missing_evidence");
  if (finding.confidence < 0.55) reasons.push("low_confidence");
  if (severityRank(finding.severity) < severityRank(config.minimumSeverity)) {
    reasons.push("below_severity_threshold");
  }
  if (!config.enabledCategories.includes(finding.category)) reasons.push("category_disabled");
  if (finding.category === "style" && !config.allowStyleFindings) reasons.push("style_only");
  if (seenFingerprints.has(finding.fingerprint)) reasons.push("duplicate_exact");
  if (seenLocations.has(locationKey(finding))) reasons.push("duplicate_location");
  if (isSuppressedByRepoRule(finding, config.repoRules)) reasons.push("suppressed_by_repo_rule");

  return reasons;
}

function toValidatedFinding(
  finding: CandidateFinding,
  timestamp: string,
  decision: "publish" | "reject",
  reasons: readonly FindingRejectionReason[],
): ValidatedFinding {
  return {
    findingId: stableId("vfnd", [finding.findingId, "validation.v2"]),
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
      reasons: [...reasons],
    },
    fingerprint: finding.fingerprint,
    metadata: { candidateSourceName: finding.sourceName },
  };
}

function rankFindings(findings: readonly ValidatedFinding[]): readonly ValidatedFinding[] {
  return [...findings]
    .sort(
      (left, right) =>
        scoreFinding(right) - scoreFinding(left) || left.findingId.localeCompare(right.findingId),
    )
    .map((finding, index) => ({ ...finding, rank: index + 1 }));
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

function isReviewableFile(file: ChangedFile): boolean {
  return !file.isBinary && file.status !== "deleted" && file.additions > 0;
}

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
