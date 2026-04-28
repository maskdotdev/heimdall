import type {
  CandidateFinding,
  PublishedFinding,
  ValidatedFinding
} from "#contracts/review/finding";
import { ids, now } from "./common";

export const validCandidateFindingFixture = {
  findingId: ids.findingId,
  schemaVersion: "candidate_finding.v1",
  reviewRunId: ids.reviewRunId,
  source: "llm",
  sourceName: "review-pass.correctness",
  category: "correctness",
  severity: "medium",
  title: "Handle non-finite numeric inputs",
  body: "The new coercion accepts NaN and Infinity, which can propagate unexpected values to callers.",
  location: {
    path: "src/math.ts",
    line: 2,
    side: "RIGHT",
    hunkId: "hunk_1",
    isInDiff: true
  },
  evidence: [
    {
      evidenceId: "ev_01HXAMPLE",
      kind: "diff",
      summary: "The changed line coerces both inputs with Number().",
      path: "src/math.ts",
      range: { startLine: 2, endLine: 2 },
      confidence: 0.82
    }
  ],
  suggestedFix: "Guard with Number.isFinite before returning the sum.",
  confidence: 0.82,
  fingerprint: "fp_math_add_non_finite",
  createdAt: now
} satisfies CandidateFinding;

export const validValidatedFindingFixture = {
  findingId: ids.validatedFindingId,
  candidateFindingId: ids.findingId,
  reviewRunId: ids.reviewRunId,
  decision: "publish",
  category: "correctness",
  severity: "medium",
  title: validCandidateFindingFixture.title,
  body: validCandidateFindingFixture.body,
  location: validCandidateFindingFixture.location,
  evidence: validCandidateFindingFixture.evidence,
  confidence: 0.82,
  validation: {
    validatedAt: now,
    validatorVersion: "0.1.0",
    reasons: []
  },
  rank: 1,
  fingerprint: validCandidateFindingFixture.fingerprint
} satisfies ValidatedFinding;

export const validPublishedFindingFixture = {
  findingId: "fnd_01HPUBLISHED",
  validatedFindingId: ids.validatedFindingId,
  reviewRunId: ids.reviewRunId,
  provider: "github",
  providerCommentId: "123456",
  location: validCandidateFindingFixture.location,
  title: validCandidateFindingFixture.title,
  body: validCandidateFindingFixture.body,
  publishedAt: now,
  status: "published",
  fingerprint: validCandidateFindingFixture.fingerprint
} satisfies PublishedFinding;
