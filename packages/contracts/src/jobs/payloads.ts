import { Type, type Static } from "@sinclair/typebox";
import { JobPrioritySchema } from "../enums/jobs";
import { GitProviderSchema } from "../enums/provider";
import { ReviewTriggerSchema } from "../enums/review";
import {
  ChunkIdSchema,
  FindingIdSchema,
  IndexVersionIdSchema,
  InstallationIdSchema,
  OutcomeIdSchema,
  RepoIdSchema,
  ReviewRunIdSchema,
  UserIdSchema
} from "../primitives/ids";
import { GitCommitShaSchema } from "../pull-request/pull-request";

export const SyncInstallationReasonSchema = Type.Union([
  Type.Literal("installed"),
  Type.Literal("repository_added"),
  Type.Literal("manual"),
  Type.Literal("scheduled")
]);
export type SyncInstallationReason = Static<typeof SyncInstallationReasonSchema>;

export const SyncInstallationJobPayloadSchema = Type.Object({
  installationId: InstallationIdSchema,
  provider: GitProviderSchema,
  reason: SyncInstallationReasonSchema
}, { additionalProperties: false });
export type SyncInstallationJobPayload = Static<typeof SyncInstallationJobPayloadSchema>;

export const IndexRepoCommitReasonSchema = Type.Union([
  Type.Literal("initial_index"),
  Type.Literal("pr_review"),
  Type.Literal("manual"),
  Type.Literal("scheduled_reindex")
]);
export type IndexRepoCommitReason = Static<typeof IndexRepoCommitReasonSchema>;

export const IndexRepoCommitJobPayloadSchema = Type.Object({
  repoId: RepoIdSchema,
  installationId: InstallationIdSchema,
  commitSha: GitCommitShaSchema,
  priority: JobPrioritySchema,
  reason: IndexRepoCommitReasonSchema,
  previousIndexVersionId: Type.Optional(IndexVersionIdSchema)
}, { additionalProperties: false });
export type IndexRepoCommitJobPayload = Static<typeof IndexRepoCommitJobPayloadSchema>;

export const EmbeddingBatchJobPayloadSchema = Type.Object({
  repoId: RepoIdSchema,
  indexVersionId: IndexVersionIdSchema,
  chunkIds: Type.Array(ChunkIdSchema, { minItems: 1, maxItems: 512 }),
  embeddingModel: Type.String()
}, { additionalProperties: false });
export type EmbeddingBatchJobPayload = Static<typeof EmbeddingBatchJobPayloadSchema>;

export const ReviewPullRequestJobPayloadSchema = Type.Object({
  repoId: RepoIdSchema,
  installationId: InstallationIdSchema,
  pullRequestNumber: Type.Integer({ minimum: 1 }),
  baseSha: GitCommitShaSchema,
  headSha: GitCommitShaSchema,
  trigger: ReviewTriggerSchema,
  requestedByUserId: Type.Optional(UserIdSchema)
}, { additionalProperties: false });
export type ReviewPullRequestJobPayload = Static<typeof ReviewPullRequestJobPayloadSchema>;

export const PublishReviewJobPayloadSchema = Type.Object({
  reviewRunId: ReviewRunIdSchema,
  repoId: RepoIdSchema,
  pullRequestNumber: Type.Integer({ minimum: 1 })
}, { additionalProperties: false });
export type PublishReviewJobPayload = Static<typeof PublishReviewJobPayloadSchema>;

export const UpdateMemoryReasonSchema = Type.Union([
  Type.Literal("finding_outcome"),
  Type.Literal("comment_reply"),
  Type.Literal("manual_rule"),
  Type.Literal("scheduled")
]);
export type UpdateMemoryReason = Static<typeof UpdateMemoryReasonSchema>;

export const UpdateMemoryJobPayloadSchema = Type.Object({
  repoId: RepoIdSchema,
  findingId: Type.Optional(FindingIdSchema),
  outcomeId: Type.Optional(OutcomeIdSchema),
  reason: UpdateMemoryReasonSchema
}, { additionalProperties: false });
export type UpdateMemoryJobPayload = Static<typeof UpdateMemoryJobPayloadSchema>;

export const JobPayloadSchema = Type.Union([
  SyncInstallationJobPayloadSchema,
  IndexRepoCommitJobPayloadSchema,
  EmbeddingBatchJobPayloadSchema,
  ReviewPullRequestJobPayloadSchema,
  PublishReviewJobPayloadSchema,
  UpdateMemoryJobPayloadSchema
]);
export type JobPayload = Static<typeof JobPayloadSchema>;
