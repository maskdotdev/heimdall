import { JOB_TYPES, type JobPayload } from "@repo/contracts";
import { QUEUE_NAMES } from "@repo/queue";
import { newId } from "../ids";
import type { PlannedJob } from "../types";
import type {
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
  readonly pullRequest?: NormalizedGitHubPullRequest | undefined;
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

  if (
    options.installation &&
    options.eventName === "installation" &&
    ["created", "new_permissions_accepted"].includes(options.action ?? "")
  ) {
    jobs.push({
      queueName: QUEUE_NAMES.repoSync,
      orgId: options.installation.orgId,
      envelope: envelope(
        JOB_TYPES.SyncInstallation,
        `github:installation:${options.installation.installationId}:${options.action}`,
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
    ["created", "publicized", "privatized", "renamed"].includes(options.action ?? "")
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
    ["opened", "reopened", "synchronize", "ready_for_review"].includes(options.action ?? "")
  ) {
    const snapshot = options.pullRequest.snapshot;

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

  return jobs;
}
