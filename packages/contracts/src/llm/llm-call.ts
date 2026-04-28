import { Type, type Static } from "@sinclair/typebox";
import { ContractErrorSchema } from "../api/errors";
import { Sha256Schema } from "../primitives/hashes";
import { LLMCallIdSchema, OrgIdSchema, RepoIdSchema, ReviewRunIdSchema } from "../primitives/ids";
import { IsoDateTimeSchema } from "../primitives/time";
import { ReviewArtifactRefSchema } from "../review/artifacts";

export const LLMOperationSchema = Type.Union([
  Type.Literal("summarize_file"),
  Type.Literal("summarize_pr"),
  Type.Literal("generate_findings"),
  Type.Literal("judge_findings"),
  Type.Literal("rerank_context"),
  Type.Literal("classify_feedback"),
  Type.Literal("embed_chunks")
]);
export type LLMOperation = Static<typeof LLMOperationSchema>;

export const LLMCallStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("running"),
  Type.Literal("succeeded"),
  Type.Literal("failed"),
  Type.Literal("cache_hit"),
  Type.Literal("canceled"),
  Type.Literal("timed_out"),
  Type.Literal("budget_exceeded")
]);
export type LLMCallStatus = Static<typeof LLMCallStatusSchema>;

export const LLMCallSchema = Type.Object({
  llmCallId: LLMCallIdSchema,
  orgId: OrgIdSchema,
  repoId: Type.Optional(RepoIdSchema),
  reviewRunId: Type.Optional(ReviewRunIdSchema),
  operation: LLMOperationSchema,
  provider: Type.String(),
  model: Type.String(),
  promptVersion: Type.String(),
  inputHash: Sha256Schema,
  outputHash: Type.Optional(Sha256Schema),
  inputTokens: Type.Integer({ minimum: 0 }),
  outputTokens: Type.Integer({ minimum: 0 }),
  cachedInputTokens: Type.Optional(Type.Integer({ minimum: 0 })),
  latencyMs: Type.Integer({ minimum: 0 }),
  costMicros: Type.Integer({ minimum: 0 }),
  status: LLMCallStatusSchema,
  startedAt: IsoDateTimeSchema,
  completedAt: Type.Optional(IsoDateTimeSchema),
  error: Type.Optional(ContractErrorSchema),
  artifactRefs: Type.Optional(Type.Array(ReviewArtifactRefSchema)),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown()))
}, { additionalProperties: false });
export type LLMCall = Static<typeof LLMCallSchema>;
