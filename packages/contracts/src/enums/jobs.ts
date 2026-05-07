import { type Static, Type } from "@sinclair/typebox";

export const JobStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("dead_lettered"),
]);
export type JobStatus = Static<typeof JobStatusSchema>;

export const JobPrioritySchema = Type.Union([
  Type.Literal("low"),
  Type.Literal("normal"),
  Type.Literal("high"),
]);
export type JobPriority = Static<typeof JobPrioritySchema>;

export const JOB_TYPES = {
  SyncInstallation: "github.sync_installation.v1",
  IndexRepoCommit: "repo.index_commit.v1",
  EmbeddingBatch: "embedding.batch.v1",
  ReviewPullRequest: "pr.review.v1",
  PublishReview: "review.publish.v1",
  UpdateMemory: "memory.update.v1",
  BillingReconcile: "billing.reconcile.v1",
  SandboxCleanup: "sandbox.cleanup.v1",
} as const;
