import { JOB_TYPES } from "@repo/contracts";
import { QUEUE_NAMES } from "@repo/queue";
import { describe, expect, it } from "vitest";
import {
  normalizeGitHubInstallation,
  normalizeGitHubPullRequest,
  normalizeGitHubRepositories,
  planGitHubWebhookJobs,
} from "../src";
import { installationPayload, pullRequestPayload } from "./fixtures";

describe("GitHub webhook job planning", () => {
  it("plans installation sync jobs", () => {
    const [job] = planGitHubWebhookJobs({
      deliveryId: "delivery-1",
      eventName: "installation",
      action: "created",
      installation: normalizeGitHubInstallation(installationPayload),
      repositories: normalizeGitHubRepositories(installationPayload),
    });

    expect(job?.queueName).toBe(QUEUE_NAMES.repoSync);
    expect(job?.envelope.jobType).toBe(JOB_TYPES.SyncInstallation);
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
});
