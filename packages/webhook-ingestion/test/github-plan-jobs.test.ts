import { JOB_TYPES } from "@repo/contracts";
import { QUEUE_NAMES } from "@repo/queue";
import { createDefaultOrgSettings } from "@repo/rules";
import { describe, expect, it } from "vitest";
import {
  normalizeGitHubFeedback,
  normalizeGitHubInstallation,
  normalizeGitHubPullRequest,
  normalizeGitHubRepositories,
  planGitHubWebhookJobs,
} from "../src";
import {
  installationPayload,
  issueCommentPayload,
  pullRequestPayload,
  reactionPayload,
  reviewThreadPayload,
} from "./fixtures";

describe("GitHub webhook job planning", () => {
  it("plans installation sync jobs", () => {
    const [job] = planGitHubWebhookJobs({
      deliveryId: "delivery-1",
      eventName: "installation",
      action: "created",
      installation: normalizeGitHubInstallation(installationPayload),
      repositories: normalizeGitHubRepositories(installationPayload),
      traceContext: {
        parentEventId: "webhook_1",
        requestId: "delivery-1",
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      },
    });

    expect(job?.queueName).toBe(QUEUE_NAMES.repoSync);
    expect(job?.envelope.jobType).toBe(JOB_TYPES.SyncInstallation);
    expect(job?.envelope.traceContext).toEqual({
      parentEventId: "webhook_1",
      requestId: "delivery-1",
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    });
  });

  it("plans index and review jobs for pull request openings", () => {
    const jobs = planGitHubWebhookJobs({
      deliveryId: "delivery-2",
      eventName: "pull_request",
      action: "opened",
      installation: normalizeGitHubInstallation(pullRequestPayload),
      repositories: normalizeGitHubRepositories(pullRequestPayload),
      pullRequest: normalizeGitHubPullRequest(pullRequestPayload),
    });

    expect(jobs.map((job) => job.queueName)).toEqual([QUEUE_NAMES.indexing, QUEUE_NAMES.review]);
    expect(jobs.map((job) => job.envelope.jobType)).toEqual([
      JOB_TYPES.IndexRepoCommit,
      JOB_TYPES.ReviewPullRequest,
    ]);
  });

  it("skips pull request review work when repository policy disables review", () => {
    const [repository] = normalizeGitHubRepositories(pullRequestPayload);
    const jobs = planGitHubWebhookJobs({
      deliveryId: "delivery-3",
      eventName: "pull_request",
      action: "opened",
      installation: normalizeGitHubInstallation(pullRequestPayload),
      repositories: repository ? [repository] : [],
      repositorySettings: repository
        ? [
            {
              ...repository.settings,
              reviewPolicy: "disabled",
            },
          ]
        : [],
      pullRequest: normalizeGitHubPullRequest(pullRequestPayload),
    });

    expect(jobs).toEqual([]);
  });

  it("skips draft pull request review work before durable jobs are planned", () => {
    const pullRequest = normalizeGitHubPullRequest(pullRequestPayload);
    const jobs = planGitHubWebhookJobs({
      deliveryId: "delivery-4",
      eventName: "pull_request",
      action: "opened",
      installation: normalizeGitHubInstallation(pullRequestPayload),
      repositories: normalizeGitHubRepositories(pullRequestPayload),
      pullRequest: {
        ...pullRequest,
        snapshot: {
          ...pullRequest.snapshot,
          isDraft: true,
        },
      },
    });

    expect(jobs).toEqual([]);
  });

  it("skips pull request review work when the repository is disabled", () => {
    const [repository] = normalizeGitHubRepositories(pullRequestPayload);
    const jobs = planGitHubWebhookJobs({
      deliveryId: "delivery-5",
      eventName: "pull_request",
      action: "opened",
      installation: normalizeGitHubInstallation(pullRequestPayload),
      repositories: repository
        ? [
            {
              ...repository,
              repository: {
                ...repository.repository,
                enabled: false,
              },
            },
          ]
        : [],
      pullRequest: normalizeGitHubPullRequest(pullRequestPayload),
    });

    expect(jobs).toEqual([]);
  });

  it("uses persisted trigger settings when deciding whether to enqueue review jobs", () => {
    const [repository] = normalizeGitHubRepositories(pullRequestPayload);
    const jobs = planGitHubWebhookJobs({
      deliveryId: "delivery-6",
      eventName: "pull_request",
      action: "opened",
      installation: normalizeGitHubInstallation(pullRequestPayload),
      repositories: repository ? [repository] : [],
      repositorySettings: repository
        ? [
            {
              ...repository.settings,
              ignoredLabels: ["ready-for-review"],
            },
          ]
        : [],
      pullRequest: normalizeGitHubPullRequest(pullRequestPayload),
    });

    expect(jobs).toEqual([]);
  });

  it("uses organization trigger defaults when deciding whether to enqueue review jobs", () => {
    const [repository] = normalizeGitHubRepositories(pullRequestPayload);
    const jobs = planGitHubWebhookJobs({
      deliveryId: "delivery-6b",
      eventName: "pull_request",
      action: "opened",
      installation: normalizeGitHubInstallation(pullRequestPayload),
      orgSettings: repository
        ? [
            {
              ...createDefaultOrgSettings(
                repository.repository.orgId,
                repository.settings.updatedAt,
              ),
              defaultTriggerPolicy: {
                enabledActions: ["opened"],
                ignoredAuthors: [],
                ignoredLabels: ["ready-for-review"],
                skipDraftPullRequests: true,
              },
            },
          ]
        : [],
      repositories: repository ? [repository] : [],
      pullRequest: normalizeGitHubPullRequest(pullRequestPayload),
    });

    expect(jobs).toEqual([]);
  });

  it("plans memory update jobs for pull request comments and reactions", () => {
    const commentJobs = planGitHubWebhookJobs({
      action: "created",
      deliveryId: "delivery-7",
      eventName: "issue_comment",
      feedback: normalizeGitHubFeedback(issueCommentPayload, "issue_comment"),
      installation: normalizeGitHubInstallation(issueCommentPayload),
      repositories: normalizeGitHubRepositories(issueCommentPayload),
    });
    const reactionJobs = planGitHubWebhookJobs({
      action: "created",
      deliveryId: "delivery-8",
      eventName: "reaction",
      feedback: normalizeGitHubFeedback(reactionPayload, "reaction"),
      installation: normalizeGitHubInstallation(reactionPayload),
      repositories: normalizeGitHubRepositories(reactionPayload),
    });

    expect(commentJobs).toHaveLength(1);
    expect(commentJobs[0]?.queueName).toBe(QUEUE_NAMES.memory);
    expect(commentJobs[0]?.envelope.jobType).toBe(JOB_TYPES.UpdateMemory);
    expect(commentJobs[0]?.envelope.payload).toMatchObject({
      actorLogin: "maintainer",
      feedbackCommand: {
        commandKind: "mark_false_positive",
      },
      feedbackKind: "comment_reply",
      reason: "comment_reply",
    });
    expect(reactionJobs[0]?.envelope.payload).toMatchObject({
      externalCommentId: "888",
      feedbackKind: "negative_reaction",
      reason: "provider_reaction",
    });
  });

  it("plans memory update jobs for review thread feedback", () => {
    const threadJobs = planGitHubWebhookJobs({
      action: "resolved",
      deliveryId: "delivery-9",
      eventName: "pull_request_review_thread",
      feedback: normalizeGitHubFeedback(reviewThreadPayload, "pull_request_review_thread"),
      installation: normalizeGitHubInstallation(reviewThreadPayload),
      repositories: normalizeGitHubRepositories(reviewThreadPayload),
    });

    expect(threadJobs).toHaveLength(1);
    expect(threadJobs[0]?.queueName).toBe(QUEUE_NAMES.memory);
    expect(threadJobs[0]?.envelope.jobType).toBe(JOB_TYPES.UpdateMemory);
    expect(threadJobs[0]?.envelope.payload).toMatchObject({
      externalCommentId: "888",
      externalThreadId: "444",
      feedbackKind: "thread_resolved",
      reason: "comment_thread",
    });
  });
});
