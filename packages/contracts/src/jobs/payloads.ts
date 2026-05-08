import { type Static, Type } from "@sinclair/typebox";
import { JobPrioritySchema } from "../enums/jobs";
import { GitProviderSchema } from "../enums/provider";
import { ReviewTriggerSchema } from "../enums/review";
import {
  ArtifactIdSchema,
  ChunkIdSchema,
  DataDeletionRequestIdSchema,
  FindingIdSchema,
  IndexVersionIdSchema,
  InstallationIdSchema,
  OrgIdSchema,
  OutcomeIdSchema,
  RepoIdSchema,
  ReviewRunIdSchema,
  UserIdSchema,
} from "../primitives/ids";
import { IsoDateTimeSchema } from "../primitives/time";
import { GitCommitShaSchema } from "../pull-request/pull-request";
import { DataDeletionReasonSchema, DataDeletionScopeSchema } from "../security/data-deletion";

export const SyncInstallationReasonSchema = Type.Union([
  Type.Literal("installed"),
  Type.Literal("repository_added"),
  Type.Literal("manual"),
  Type.Literal("scheduled"),
]);
export type SyncInstallationReason = Static<typeof SyncInstallationReasonSchema>;

export const SyncInstallationJobPayloadSchema = Type.Object(
  {
    installationId: InstallationIdSchema,
    provider: GitProviderSchema,
    reason: SyncInstallationReasonSchema,
  },
  { additionalProperties: false },
);
export type SyncInstallationJobPayload = Static<typeof SyncInstallationJobPayloadSchema>;

export const IndexRepoCommitReasonSchema = Type.Union([
  Type.Literal("initial_index"),
  Type.Literal("pr_review"),
  Type.Literal("manual"),
  Type.Literal("scheduled_reindex"),
]);
export type IndexRepoCommitReason = Static<typeof IndexRepoCommitReasonSchema>;

export const IndexRepoCommitJobPayloadSchema = Type.Object(
  {
    repoId: RepoIdSchema,
    installationId: InstallationIdSchema,
    commitSha: GitCommitShaSchema,
    priority: JobPrioritySchema,
    reason: IndexRepoCommitReasonSchema,
    previousIndexVersionId: Type.Optional(IndexVersionIdSchema),
  },
  { additionalProperties: false },
);
export type IndexRepoCommitJobPayload = Static<typeof IndexRepoCommitJobPayloadSchema>;

export const EmbeddingBatchJobPayloadSchema = Type.Object(
  {
    repoId: RepoIdSchema,
    indexVersionId: IndexVersionIdSchema,
    chunkIds: Type.Array(ChunkIdSchema, { minItems: 1, maxItems: 512 }),
    embeddingModel: Type.String(),
    embeddingJobId: Type.Optional(Type.String({ minLength: 1 })),
    embeddingProfileVersion: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);
export type EmbeddingBatchJobPayload = Static<typeof EmbeddingBatchJobPayloadSchema>;

/** Payload used by scheduled or operator-triggered embedding repair jobs. */
export const EmbeddingRepairJobPayloadSchema = Type.Object(
  {
    repoId: RepoIdSchema,
    indexVersionId: IndexVersionIdSchema,
    embeddingProfileVersion: Type.String({ minLength: 1 }),
    dimensions: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
    embeddingJobId: Type.Optional(Type.String({ minLength: 1 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    model: Type.Optional(Type.String({ minLength: 1 })),
    provider: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);
export type EmbeddingRepairJobPayload = Static<typeof EmbeddingRepairJobPayloadSchema>;

export const ReviewPullRequestJobPayloadSchema = Type.Object(
  {
    repoId: RepoIdSchema,
    installationId: InstallationIdSchema,
    pullRequestNumber: Type.Integer({ minimum: 1 }),
    baseSha: GitCommitShaSchema,
    headSha: GitCommitShaSchema,
    trigger: ReviewTriggerSchema,
    dryRun: Type.Optional(Type.Boolean()),
    requestedByUserId: Type.Optional(UserIdSchema),
  },
  { additionalProperties: false },
);
export type ReviewPullRequestJobPayload = Static<typeof ReviewPullRequestJobPayloadSchema>;

export const PublishReviewJobPayloadSchema = Type.Object(
  {
    reviewRunId: ReviewRunIdSchema,
    repoId: RepoIdSchema,
    pullRequestNumber: Type.Integer({ minimum: 1 }),
    publishPlanId: Type.Optional(Type.String({ pattern: "^pp_[A-Za-z0-9_-]+$" })),
    publishPlanArtifactId: Type.Optional(ArtifactIdSchema),
  },
  { additionalProperties: false },
);
export type PublishReviewJobPayload = Static<typeof PublishReviewJobPayloadSchema>;

export const UpdateMemoryReasonSchema = Type.Union([
  Type.Literal("finding_outcome"),
  Type.Literal("comment_reply"),
  Type.Literal("comment_thread"),
  Type.Literal("provider_reaction"),
  Type.Literal("manual_rule"),
  Type.Literal("scheduled"),
]);
export type UpdateMemoryReason = Static<typeof UpdateMemoryReasonSchema>;

/** Command kinds recognized from provider feedback comments. */
export const UpdateMemoryFeedbackCommandKindSchema = Type.Union([
  Type.Literal("mark_false_positive"),
  Type.Literal("mark_not_useful"),
  Type.Literal("suppress_exact"),
  Type.Literal("suppress_similar"),
  Type.Literal("remember_fact"),
  Type.Literal("disable_category_in_scope"),
  Type.Literal("set_review_preference"),
]);
export type UpdateMemoryFeedbackCommandKind = Static<typeof UpdateMemoryFeedbackCommandKindSchema>;

/** Redacted command metadata carried by provider feedback memory jobs. */
export const UpdateMemoryFeedbackCommandPayloadSchema = Type.Object(
  {
    commandKind: UpdateMemoryFeedbackCommandKindSchema,
    commandHash: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    content: Type.Optional(Type.String({ minLength: 1 })),
    proposedScope: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    proposedAppliesTo: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);
export type UpdateMemoryFeedbackCommandPayload = Static<
  typeof UpdateMemoryFeedbackCommandPayloadSchema
>;

export const UpdateMemoryJobPayloadSchema = Type.Object(
  {
    repoId: RepoIdSchema,
    findingId: Type.Optional(FindingIdSchema),
    outcomeId: Type.Optional(OutcomeIdSchema),
    reason: UpdateMemoryReasonSchema,
    provider: Type.Optional(GitProviderSchema),
    feedbackKind: Type.Optional(Type.String({ minLength: 1 })),
    externalEventId: Type.Optional(Type.String({ minLength: 1 })),
    externalCommentId: Type.Optional(Type.String({ minLength: 1 })),
    externalParentCommentId: Type.Optional(Type.String({ minLength: 1 })),
    externalReactionId: Type.Optional(Type.String({ minLength: 1 })),
    externalThreadId: Type.Optional(Type.String({ minLength: 1 })),
    feedbackSource: Type.Optional(
      Type.Union([Type.Literal("webhook"), Type.Literal("reconciliation")]),
    ),
    actorLogin: Type.Optional(Type.String({ minLength: 1 })),
    bodyHash: Type.Optional(Type.String({ pattern: "^sha256:[a-f0-9]{64}$" })),
    pullRequestNumber: Type.Optional(Type.Integer({ minimum: 1 })),
    feedbackCommand: Type.Optional(UpdateMemoryFeedbackCommandPayloadSchema),
  },
  { additionalProperties: false },
);
export type UpdateMemoryJobPayload = Static<typeof UpdateMemoryJobPayloadSchema>;

/** Payload used by scheduled or operator-triggered billing reconciliation jobs. */
export const BillingReconcileJobPayloadSchema = Type.Object(
  {
    orgId: Type.Optional(OrgIdSchema),
    provider: Type.Optional(Type.String({ minLength: 1 })),
    periodKey: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}$" })),
    periodStart: Type.Optional(IsoDateTimeSchema),
    periodEnd: Type.Optional(IsoDateTimeSchema),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  },
  { additionalProperties: false },
);
export type BillingReconcileJobPayload = Static<typeof BillingReconcileJobPayloadSchema>;

/** Payload used by customer-data deletion planning jobs. */
export const DataDeletionPlanJobPayloadSchema = Type.Object(
  {
    dataDeletionRequestId: DataDeletionRequestIdSchema,
    reason: DataDeletionReasonSchema,
    requestedAt: IsoDateTimeSchema,
    requestedBy: Type.String({ minLength: 1 }),
    scope: DataDeletionScopeSchema,
    dryRun: Type.Optional(Type.Boolean()),
    orgId: Type.Optional(OrgIdSchema),
    repoId: Type.Optional(RepoIdSchema),
    sourceWebhookEventId: Type.Optional(Type.String({ minLength: 1 })),
    userId: Type.Optional(UserIdSchema),
  },
  { additionalProperties: false },
);
export type DataDeletionPlanJobPayload = Static<typeof DataDeletionPlanJobPayloadSchema>;

/** Reason a sandbox cleanup job was scheduled. */
export const SandboxCleanupReasonSchema = Type.Union([
  Type.Literal("scheduled"),
  Type.Literal("manual"),
  Type.Literal("retention_policy"),
]);
export type SandboxCleanupReason = Static<typeof SandboxCleanupReasonSchema>;

/** Payload used by scheduled or operator-triggered sandbox cleanup jobs. */
export const SandboxCleanupJobPayloadSchema = Type.Object(
  {
    before: Type.Optional(IsoDateTimeSchema),
    dryRun: Type.Optional(Type.Boolean()),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
    olderThanDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 3650 })),
    reason: Type.Optional(SandboxCleanupReasonSchema),
    repoId: Type.Optional(RepoIdSchema),
  },
  { additionalProperties: false },
);
export type SandboxCleanupJobPayload = Static<typeof SandboxCleanupJobPayloadSchema>;

/** Reason a review artifact cleanup job was scheduled. */
export const ReviewArtifactCleanupReasonSchema = Type.Union([
  Type.Literal("scheduled"),
  Type.Literal("manual"),
  Type.Literal("retention_policy"),
]);
export type ReviewArtifactCleanupReason = Static<typeof ReviewArtifactCleanupReasonSchema>;

/** Payload used by scheduled or operator-triggered review artifact cleanup jobs. */
export const ReviewArtifactCleanupJobPayloadSchema = Type.Object(
  {
    before: Type.Optional(IsoDateTimeSchema),
    dryRun: Type.Optional(Type.Boolean()),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
    reason: Type.Optional(ReviewArtifactCleanupReasonSchema),
    repoId: Type.Optional(RepoIdSchema),
  },
  { additionalProperties: false },
);
export type ReviewArtifactCleanupJobPayload = Static<typeof ReviewArtifactCleanupJobPayloadSchema>;

/** Compliance evidence collection targets supported by scheduled worker jobs. */
export const ComplianceEvidenceCollectTargetSchema = Type.Union([
  Type.Literal("all"),
  Type.Literal("access_review_export"),
  Type.Literal("audit_log_export"),
  Type.Literal("security_event_export"),
  Type.Literal("config_snapshot"),
]);
export type ComplianceEvidenceCollectTarget = Static<typeof ComplianceEvidenceCollectTargetSchema>;

/** Reason a compliance evidence collection job was scheduled. */
export const ComplianceEvidenceCollectReasonSchema = Type.Union([
  Type.Literal("scheduled"),
  Type.Literal("manual"),
]);
export type ComplianceEvidenceCollectReason = Static<typeof ComplianceEvidenceCollectReasonSchema>;

/** Payload used by scheduled or operator-triggered compliance evidence collection jobs. */
export const ComplianceEvidenceCollectJobPayloadSchema = Type.Object(
  {
    target: ComplianceEvidenceCollectTargetSchema,
    artifactRootDir: Type.Optional(Type.String({ minLength: 1 })),
    collectedBy: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
    orgId: Type.Optional(OrgIdSchema),
    reason: Type.Optional(ComplianceEvidenceCollectReasonSchema),
  },
  { additionalProperties: false },
);
export type ComplianceEvidenceCollectJobPayload = Static<
  typeof ComplianceEvidenceCollectJobPayloadSchema
>;

export const JobPayloadSchema = Type.Union([
  SyncInstallationJobPayloadSchema,
  IndexRepoCommitJobPayloadSchema,
  EmbeddingBatchJobPayloadSchema,
  EmbeddingRepairJobPayloadSchema,
  ReviewPullRequestJobPayloadSchema,
  PublishReviewJobPayloadSchema,
  UpdateMemoryJobPayloadSchema,
  BillingReconcileJobPayloadSchema,
  DataDeletionPlanJobPayloadSchema,
  SandboxCleanupJobPayloadSchema,
  ReviewArtifactCleanupJobPayloadSchema,
  ComplianceEvidenceCollectJobPayloadSchema,
]);
export type JobPayload = Static<typeof JobPayloadSchema>;
