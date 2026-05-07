import { JOB_TYPES, type JobPayload, type RepositorySettings } from "@repo/contracts";
import { QUEUE_NAMES } from "@repo/queue";
import { buildReviewPolicySnapshot, shouldReviewPr } from "@repo/rules";
import { newId } from "../ids";
import type { PlannedJob } from "../types";
import type {
  NormalizedGitHubFeedback,
  NormalizedGitHubInstallation,
  NormalizedGitHubPullRequest,
  NormalizedGitHubRepository,
} from "./payload";

type PlanOptions = {
  readonly deliveryId: string;
  readonly eventName: string;
  readonly action?: string | undefined;
  readonly installation?: NormalizedGitHubInstallation | undefined;
  readonly repositories: readonly NormalizedGitHubRepository[];
  readonly repositorySettings?: readonly RepositorySettings[];
  readonly pullRequest?: NormalizedGitHubPullRequest | undefined;
  readonly feedback?: NormalizedGitHubFeedback | undefined;
};

const createdAt = (): string => new Date().toISOString();

const envelope = <TPayload extends JobPayload>(
  jobType: string,
  idempotencyKey: string,
  payload: TPayload,
) => ({
  jobId: newId("job"),
  jobType,
  schemaVersion: "job_envelope.v1",
  idempotencyKey,
  createdAt: createdAt(),
  attempt: 0,
  maxAttempts: 3,
  payload,
});

/** Plans durable downstream jobs for a normalized GitHub webhook. */
export function planGitHubWebhookJobs(options: PlanOptions): readonly PlannedJob[] {
  const jobs: PlannedJob[] = [];
  const action = options.action ?? "";

  if (
    options.installation &&
    options.eventName === "installation" &&
    ["created", "new_permissions_accepted"].includes(action)
  ) {
    jobs.push({
      queueName: QUEUE_NAMES.repoSync,
      orgId: options.installation.orgId,
      envelope: envelope(
        JOB_TYPES.SyncInstallation,
        `github:installation:${options.installation.installationId}:${action}`,
        {
          installationId: options.installation.installationId,
          provider: "github",
          reason: "installed",
        },
      ),
    });
  }

  if (
    options.installation &&
    options.eventName === "repository" &&
    ["created", "publicized", "privatized", "renamed"].includes(action)
  ) {
    jobs.push({
      queueName: QUEUE_NAMES.repoSync,
      orgId: options.installation.orgId,
      envelope: envelope(
        JOB_TYPES.SyncInstallation,
        `github:repository:${options.installation.installationId}:${options.deliveryId}`,
        {
          installationId: options.installation.installationId,
          provider: "github",
          reason: "repository_added",
        },
      ),
    });
  }

  if (
    options.pullRequest &&
    ["opened", "reopened", "synchronize", "ready_for_review"].includes(action)
  ) {
    const snapshot = options.pullRequest.snapshot;
    const normalizedRepository = options.repositories.find(
      (repository) => repository.repository.repoId === snapshot.repoId,
    );

    if (!normalizedRepository) {
      return jobs;
    }

    const settings =
      options.repositorySettings?.find((candidate) => candidate.repoId === snapshot.repoId) ??
      normalizedRepository.settings;
    const { snapshot: policySnapshot } = buildReviewPolicySnapshot({
      repository: normalizedRepository.repository,
      settings,
    });
    const triggerDecision = shouldReviewPr({
      action,
      authorLogin: snapshot.authorLogin,
      isDraft: snapshot.isDraft,
      labels: snapshot.labels,
      policy: policySnapshot.effectivePolicy,
    });

    if (!triggerDecision.shouldReview) {
      return jobs;
    }

    jobs.push({
      queueName: QUEUE_NAMES.indexing,
      repoId: snapshot.repoId,
      envelope: envelope(
        JOB_TYPES.IndexRepoCommit,
        `github:index:${snapshot.repoId}:${snapshot.headSha}`,
        {
          repoId: snapshot.repoId,
          installationId: snapshot.installationId,
          commitSha: snapshot.headSha,
          priority: "high",
          reason: "pr_review",
        },
      ),
    });
    jobs.push({
      queueName: QUEUE_NAMES.review,
      repoId: snapshot.repoId,
      envelope: envelope(
        JOB_TYPES.ReviewPullRequest,
        `github:review:${snapshot.repoId}:${snapshot.pullRequestNumber}:${snapshot.headSha}`,
        {
          repoId: snapshot.repoId,
          installationId: snapshot.installationId,
          pullRequestNumber: snapshot.pullRequestNumber,
          baseSha: snapshot.baseSha,
          headSha: snapshot.headSha,
          trigger: "webhook",
        },
      ),
    });
  }

  if (options.feedback) {
    const reason =
      options.feedback.feedbackKind === "positive_reaction" ||
      options.feedback.feedbackKind === "negative_reaction"
        ? "provider_reaction"
        : "comment_reply";
    jobs.push({
      queueName: QUEUE_NAMES.memory,
      ...(options.installation ? { orgId: options.installation.orgId } : {}),
      repoId: options.feedback.repoId,
      envelope: envelope(
        JOB_TYPES.UpdateMemory,
        `github:memory:${options.feedback.feedbackEventId}`,
        {
          repoId: options.feedback.repoId,
          reason,
          provider: "github",
          feedbackKind: options.feedback.feedbackKind,
          externalEventId: options.feedback.feedbackEventId,
          ...(options.feedback.externalCommentId
            ? { externalCommentId: options.feedback.externalCommentId }
            : {}),
          ...(options.feedback.externalParentCommentId
            ? { externalParentCommentId: options.feedback.externalParentCommentId }
            : {}),
          ...(options.feedback.externalReactionId
            ? { externalReactionId: options.feedback.externalReactionId }
            : {}),
          ...(options.feedback.actorLogin ? { actorLogin: options.feedback.actorLogin } : {}),
          ...(options.feedback.bodyHash ? { bodyHash: options.feedback.bodyHash } : {}),
          ...(options.feedback.pullRequestNumber
            ? { pullRequestNumber: options.feedback.pullRequestNumber }
            : {}),
          ...(options.feedback.command ? { feedbackCommand: options.feedback.command } : {}),
        },
      ),
    });
  }

  return jobs;
}
