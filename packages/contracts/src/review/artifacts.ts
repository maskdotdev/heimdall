import { type Static, Type } from "@sinclair/typebox";
import { Sha256Schema } from "../primitives/hashes";
import { ArtifactIdSchema } from "../primitives/ids";
import { IsoDateTimeSchema } from "../primitives/time";

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
    createdAt: IsoDateTimeSchema,
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);
export type ReviewArtifactRef = Static<typeof ReviewArtifactRefSchema>;
