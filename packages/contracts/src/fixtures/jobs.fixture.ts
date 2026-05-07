import type {
  BillingReconcileJobPayload,
  EmbeddingBatchJobPayload,
  IndexRepoCommitJobPayload,
  PublishReviewJobPayload,
  ReviewPullRequestJobPayload,
  SyncInstallationJobPayload,
  UpdateMemoryJobPayload,
} from "#contracts/jobs/payloads";
import { ids } from "./common";

export const validSyncInstallationJobPayloadFixture = {
  installationId: ids.installationId,
  provider: "github",
  reason: "installed",
} satisfies SyncInstallationJobPayload;

export const validIndexRepoCommitJobPayloadFixture = {
  repoId: ids.repoId,
  installationId: ids.installationId,
  commitSha: "2222222",
  priority: "normal",
  reason: "pr_review",
  previousIndexVersionId: ids.indexVersionId,
} satisfies IndexRepoCommitJobPayload;

export const validEmbeddingBatchJobPayloadFixture = {
  repoId: ids.repoId,
  indexVersionId: ids.indexVersionId,
  chunkIds: [ids.chunkId],
  embeddingModel: "text-embedding-3-large",
} satisfies EmbeddingBatchJobPayload;

export const validReviewPullRequestJobPayloadFixture = {
  repoId: ids.repoId,
  installationId: ids.installationId,
  pullRequestNumber: 42,
  baseSha: "1111111",
  headSha: "2222222",
  trigger: "webhook",
} satisfies ReviewPullRequestJobPayload;

export const validPublishReviewJobPayloadFixture = {
  reviewRunId: ids.reviewRunId,
  repoId: ids.repoId,
  pullRequestNumber: 42,
} satisfies PublishReviewJobPayload;

export const validUpdateMemoryJobPayloadFixture = {
  repoId: ids.repoId,
  findingId: ids.findingId,
  outcomeId: ids.outcomeId,
  reason: "finding_outcome",
} satisfies UpdateMemoryJobPayload;

export const validBillingReconcileJobPayloadFixture = {
  orgId: ids.orgId,
  periodEnd: "2026-06-01T00:00:00.000Z",
  periodKey: "2026-05",
  periodStart: "2026-05-01T00:00:00.000Z",
  provider: "stripe",
} satisfies BillingReconcileJobPayload;
