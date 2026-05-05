import { createHash } from "node:crypto";
import type { CandidateFinding, ChangedFile, PullRequestSnapshot } from "@repo/contracts";

/** Context provided to every deterministic or model-backed review pass. */
export type ReviewPassContext = {
  /** Stable review run ID that owns all emitted findings. */
  readonly reviewRunId: string;
  /** Pull request snapshot fetched for the review run. */
  readonly snapshot: PullRequestSnapshot;
  /** Timestamp used for deterministic test output. */
  readonly timestamp: string;
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
