import { type Static, Type } from "@sinclair/typebox";
import { Sha256Schema } from "../primitives/hashes";
import { ArtifactIdSchema } from "../primitives/ids";
import { IsoDateTimeSchema } from "../primitives/time";

/** Redaction levels used when exposing artifact metadata outside trusted storage. */
export const ReviewArtifactRedactionLevelSchema = Type.Union([
  Type.Literal("safe"),
  Type.Literal("contains_code"),
  Type.Literal("contains_prompt"),
  Type.Literal("contains_sensitive"),
]);

/** Redaction level used when exposing artifact metadata outside trusted storage. */
export type ReviewArtifactRedactionLevel = Static<typeof ReviewArtifactRedactionLevelSchema>;

export const ReviewArtifactKindSchema = Type.Union([
  Type.Literal("pull_request_snapshot"),
  Type.Literal("raw_diff"),
  Type.Literal("diff_model"),
  Type.Literal("line_anchor_index"),
  Type.Literal("change_set"),
  Type.Literal("context_bundle"),
  Type.Literal("retrieval_trace"),
  Type.Literal("llm_prompt"),
  Type.Literal("llm_response"),
  Type.Literal("review_output"),
  Type.Literal("candidate_findings"),
  Type.Literal("validated_findings"),
  Type.Literal("rejected_findings"),
  Type.Literal("ranking_report"),
  Type.Literal("policy_snapshot"),
  Type.Literal("plan_snapshot"),
  Type.Literal("publish_plan"),
  Type.Literal("published_findings"),
  Type.Literal("publisher_trace"),
  Type.Literal("orchestrator_trace"),
  Type.Literal("static_analysis"),
  Type.Literal("debug_log"),
]);
export type ReviewArtifactKind = Static<typeof ReviewArtifactKindSchema>;

export const ReviewArtifactRefSchema = Type.Object(
  {
    artifactId: ArtifactIdSchema,
    kind: ReviewArtifactKindSchema,
    uri: Type.String(),
    contentHash: Type.Optional(Sha256Schema),
    byteSize: Type.Optional(Type.Integer({ minimum: 0 })),
    redactionLevel: Type.Optional(ReviewArtifactRedactionLevelSchema),
    createdAt: IsoDateTimeSchema,
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);
export type ReviewArtifactRef = Static<typeof ReviewArtifactRefSchema>;

/** Review artifact kinds that contain prompt or prompt-derived payloads. */
const promptSensitiveReviewArtifactKinds = new Set<ReviewArtifactKind>([
  "llm_prompt",
  "llm_response",
]);

/** Review artifact kinds that contain source code, diffs, snippets, or code-derived findings. */
const codeSensitiveReviewArtifactKinds = new Set<ReviewArtifactKind>([
  "raw_diff",
  "diff_model",
  "line_anchor_index",
  "change_set",
  "context_bundle",
  "retrieval_trace",
  "review_output",
  "candidate_findings",
  "validated_findings",
  "rejected_findings",
  "ranking_report",
  "publish_plan",
  "published_findings",
  "static_analysis",
]);

/** Review artifact kinds that are intentionally metadata-only operational records. */
const safeReviewArtifactKinds = new Set<ReviewArtifactKind>([
  "policy_snapshot",
  "plan_snapshot",
  "orchestrator_trace",
]);

/** Returns the observability redaction level for one review artifact kind. */
export function getReviewArtifactRedactionLevel(
  kind: ReviewArtifactKind,
): ReviewArtifactRedactionLevel {
  if (promptSensitiveReviewArtifactKinds.has(kind)) {
    return "contains_prompt";
  }
  if (codeSensitiveReviewArtifactKinds.has(kind)) {
    return "contains_code";
  }
  if (safeReviewArtifactKinds.has(kind)) {
    return "safe";
  }

  return "contains_sensitive";
}
