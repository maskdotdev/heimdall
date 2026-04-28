import { type Static, Type } from "@sinclair/typebox";
import { ContractErrorSchema } from "../api/errors";
import {
  FindingCategorySchema,
  FindingSeveritySchema,
  FindingSourceSchema,
} from "../enums/finding";
import { GitProviderSchema } from "../enums/provider";
import {
  ChunkIdSchema,
  FindingIdSchema,
  ReviewRunIdSchema,
  SymbolIdSchema,
} from "../primitives/ids";
import { RepoPathSchema } from "../primitives/paths";
import { LineRangeSchema } from "../primitives/ranges";
import { IsoDateTimeSchema } from "../primitives/time";

export const EvidenceKindSchema = Type.Union([
  Type.Literal("diff"),
  Type.Literal("code_snippet"),
  Type.Literal("symbol_graph"),
  Type.Literal("static_analysis"),
  Type.Literal("repo_rule"),
  Type.Literal("memory_fact"),
  Type.Literal("llm_reasoning"),
  Type.Literal("external"),
]);
export type EvidenceKind = Static<typeof EvidenceKindSchema>;

export const EvidenceSchema = Type.Object(
  {
    evidenceId: Type.String({ pattern: "^ev_[A-Za-z0-9_-]+$" }),
    kind: EvidenceKindSchema,
    summary: Type.String(),
    quote: Type.Optional(Type.String()),
    path: Type.Optional(RepoPathSchema),
    range: Type.Optional(LineRangeSchema),
    contextItemId: Type.Optional(Type.String()),
    symbolId: Type.Optional(SymbolIdSchema),
    chunkId: Type.Optional(ChunkIdSchema),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);
export type Evidence = Static<typeof EvidenceSchema>;

export const DiffSideSchema = Type.Union([Type.Literal("LEFT"), Type.Literal("RIGHT")]);
export type DiffSide = Static<typeof DiffSideSchema>;

export const FindingLocationSchema = Type.Object(
  {
    path: RepoPathSchema,
    line: Type.Integer({ minimum: 1 }),
    startLine: Type.Optional(Type.Integer({ minimum: 1 })),
    side: DiffSideSchema,
    hunkId: Type.Optional(Type.String()),
    isInDiff: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type FindingLocation = Static<typeof FindingLocationSchema>;

export const CandidateFindingSchema = Type.Object(
  {
    findingId: FindingIdSchema,
    schemaVersion: Type.Literal("candidate_finding.v1"),
    reviewRunId: ReviewRunIdSchema,
    source: FindingSourceSchema,
    sourceName: Type.String(),
    category: FindingCategorySchema,
    severity: FindingSeveritySchema,
    title: Type.String({ minLength: 1, maxLength: 200 }),
    body: Type.String({ minLength: 1, maxLength: 4000 }),
    location: FindingLocationSchema,
    evidence: Type.Array(EvidenceSchema, { minItems: 1 }),
    suggestedFix: Type.Optional(Type.String({ maxLength: 8000 })),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    fingerprint: Type.String(),
    createdAt: IsoDateTimeSchema,
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);
export type CandidateFinding = Static<typeof CandidateFindingSchema>;

export const ValidationDecisionSchema = Type.Union([
  Type.Literal("publish"),
  Type.Literal("reject"),
]);
export type ValidationDecision = Static<typeof ValidationDecisionSchema>;

export const FindingRejectionReasonSchema = Type.Union([
  Type.Literal("invalid_schema"),
  Type.Literal("unsupported_schema_version"),
  Type.Literal("missing_file_path"),
  Type.Literal("invalid_file_path"),
  Type.Literal("file_not_in_pr"),
  Type.Literal("file_deleted"),
  Type.Literal("binary_file"),
  Type.Literal("generated_file"),
  Type.Literal("ignored_path"),
  Type.Literal("line_missing"),
  Type.Literal("line_not_in_diff"),
  Type.Literal("line_anchor_unavailable"),
  Type.Literal("wrong_diff_side"),
  Type.Literal("stale_snapshot"),
  Type.Literal("low_confidence"),
  Type.Literal("below_severity_threshold"),
  Type.Literal("category_disabled"),
  Type.Literal("style_only"),
  Type.Literal("not_actionable"),
  Type.Literal("missing_evidence"),
  Type.Literal("weak_evidence"),
  Type.Literal("invalid_context_reference"),
  Type.Literal("contradicted_by_context"),
  Type.Literal("duplicate_exact"),
  Type.Literal("duplicate_location"),
  Type.Literal("duplicate_semantic"),
  Type.Literal("duplicate_previous_comment"),
  Type.Literal("suppressed_by_repo_rule"),
  Type.Literal("suppressed_by_memory"),
  Type.Literal("contains_secret"),
  Type.Literal("unsafe_suggested_fix"),
  Type.Literal("too_verbose"),
  Type.Literal("budget_exceeded"),
  Type.Literal("publisher_unsupported"),
  Type.Literal("internal_error"),
]);
export type FindingRejectionReason = Static<typeof FindingRejectionReasonSchema>;

export const ValidatedFindingSchema = Type.Object(
  {
    findingId: FindingIdSchema,
    candidateFindingId: FindingIdSchema,
    reviewRunId: ReviewRunIdSchema,
    decision: ValidationDecisionSchema,
    category: FindingCategorySchema,
    severity: FindingSeveritySchema,
    title: Type.String(),
    body: Type.String(),
    location: FindingLocationSchema,
    evidence: Type.Array(EvidenceSchema),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    validation: Type.Object(
      {
        validatedAt: IsoDateTimeSchema,
        validatorVersion: Type.String(),
        reasons: Type.Array(FindingRejectionReasonSchema),
        notes: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    rank: Type.Optional(Type.Integer({ minimum: 1 })),
    fingerprint: Type.String(),
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);
export type ValidatedFinding = Static<typeof ValidatedFindingSchema>;

export const PublishedFindingStatusSchema = Type.Union([
  Type.Literal("published"),
  Type.Literal("updated"),
  Type.Literal("failed"),
  Type.Literal("skipped"),
]);
export type PublishedFindingStatus = Static<typeof PublishedFindingStatusSchema>;

export const PublishedFindingSchema = Type.Object(
  {
    findingId: FindingIdSchema,
    validatedFindingId: FindingIdSchema,
    reviewRunId: ReviewRunIdSchema,
    provider: GitProviderSchema,
    providerCommentId: Type.Optional(Type.String()),
    providerReviewId: Type.Optional(Type.String()),
    providerCheckRunId: Type.Optional(Type.String()),
    location: FindingLocationSchema,
    title: Type.String(),
    body: Type.String(),
    publishedAt: IsoDateTimeSchema,
    status: PublishedFindingStatusSchema,
    error: Type.Optional(ContractErrorSchema),
    fingerprint: Type.String(),
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);
export type PublishedFinding = Static<typeof PublishedFindingSchema>;

export const LLMFindingOutputSchema = Type.Object(
  {
    findings: Type.Array(
      Type.Object(
        {
          path: RepoPathSchema,
          line: Type.Integer({ minimum: 1 }),
          severity: FindingSeveritySchema,
          category: FindingCategorySchema,
          title: Type.String({ maxLength: 200 }),
          body: Type.String({ maxLength: 4000 }),
          evidence: Type.Array(Type.String(), { minItems: 1 }),
          suggestedFix: Type.Optional(Type.String({ maxLength: 8000 })),
          confidence: Type.Number({ minimum: 0, maximum: 1 }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type LLMFindingOutput = Static<typeof LLMFindingOutputSchema>;
