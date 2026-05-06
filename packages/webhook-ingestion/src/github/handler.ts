import type { HeimdallDatabase } from "@repo/db";
import {
  backgroundJobs,
  orgs,
  providerInstallations,
  pullRequestSnapshots,
  pullRequests,
  repositories,
  repositorySettings,
  webhookEvents,
} from "@repo/db";
import {
  type GitHubWebhookHeaders,
  readGitHubWebhookHeaders,
  verifyGitHubWebhookSignature,
} from "@repo/github";
import { eq } from "drizzle-orm";
import { newId, sha256, stableId } from "../ids";
import { type PlannedJob, WebhookAuthenticationError, type WebhookIngestionResult } from "../types";
import {
  type NormalizedGitHubInstallation,
  type NormalizedGitHubPullRequest,
  type NormalizedGitHubRepository,
  normalizeGitHubAccount,
  normalizeGitHubInstallation,
  normalizeGitHubPullRequest,
  normalizeGitHubRepositories,
  parseGitHubWebhookPayload,
} from "./payload";
import { planGitHubWebhookJobs } from "./plan-jobs";

/** Dependencies required by GitHub webhook ingestion. */
export type GitHubWebhookHandlerDependencies = {
  /** Database used for durable webhook and job records. */
  readonly db: HeimdallDatabase;
  /** GitHub webhook secret. */
  readonly webhookSecret: string;
};

/** Request input for GitHub webhook ingestion. */
export type HandleGitHubWebhookInput = {
  /** Request headers from the HTTP route. */
  readonly headers: Headers;
  /** Raw request body bytes. */
  readonly rawBody: Uint8Array;
};

type NormalizedEvent = {
  readonly headers: GitHubWebhookHeaders;
  readonly payloadHash: string;
  readonly payload: Record<string, unknown>;
  readonly installation?: NormalizedGitHubInstallation | undefined;
  readonly repositories: readonly NormalizedGitHubRepository[];
  readonly pullRequest?: NormalizedGitHubPullRequest | undefined;
};

const supportedEvents = new Set(["installation", "repository", "pull_request"]);

/** Handles verified GitHub webhook ingestion and durable job persistence. */
export class GitHubWebhookHandler {
  /** Creates a GitHub webhook handler. */
  public constructor(private readonly dependencies: GitHubWebhookHandlerDependencies) {}

  /** Ingests a GitHub webhook delivery. */
  public async handle(input: HandleGitHubWebhookInput): Promise<WebhookIngestionResult> {
    const headers = readGitHubWebhookHeaders(input.headers);

    if (
      !verifyGitHubWebhookSignature({
        secret: this.dependencies.webhookSecret,
        rawBody: input.rawBody,
        signature256: headers.signature256,
      })
    ) {
      throw new WebhookAuthenticationError("GitHub webhook signature verification failed.");
    }

    const normalized = this.normalize(headers, input.rawBody);
    const result = await this.persist(normalized);

    return result;
  }

  private normalize(headers: GitHubWebhookHeaders, rawBody: Uint8Array): NormalizedEvent {
    const payload = parseGitHubWebhookPayload(rawBody);

    if (!supportedEvents.has(headers.eventName)) {
      return {
        headers,
        payloadHash: sha256(rawBody),
        payload,
        repositories: [],
      };
    }

    const installation = normalizeGitHubInstallation(payload);
    const repositories = normalizeGitHubRepositories(payload);
    const pullRequest =
      headers.eventName === "pull_request" ? normalizeGitHubPullRequest(payload) : undefined;

    return {
      headers,
      payloadHash: sha256(rawBody),
      payload,
      installation,
      repositories,
      pullRequest,
    };
  }

  private async persist(normalized: NormalizedEvent): Promise<WebhookIngestionResult> {
    const result = await this.dependencies.db.transaction(async (tx) => {
      const webhookEventId = stableId("webhook", ["github", normalized.headers.deliveryId]);
      const action =
        typeof normalized.payload.action === "string" ? normalized.payload.action : undefined;
      const status = supportedEvents.has(normalized.headers.eventName) ? "processed" : "ignored";
      const primaryRepo = normalized.repositories[0]?.repository;

      const [existingWebhookRow] = await tx
        .select({ webhookEventId: webhookEvents.webhookEventId })
        .from(webhookEvents)
        .where(eq(webhookEvents.webhookEventId, webhookEventId))
        .limit(1);

      if (existingWebhookRow) {
        return {
          status: "duplicate" as const,
          deliveryId: normalized.headers.deliveryId,
          webhookEventId,
          jobs: [],
        };
      }

      if (normalized.installation) {
        await persistInstallation(tx, normalized.payload, normalized.installation);
      }

      for (const repository of normalized.repositories) {
        await persistRepository(tx, repository);
      }

      if (normalized.pullRequest) {
        await persistPullRequest(tx, normalized.pullRequest);
      }

      const [webhookRow] = await tx
        .insert(webhookEvents)
        .values({
          webhookEventId,
          provider: "github",
          deliveryId: normalized.headers.deliveryId,
          eventName: normalized.headers.eventName,
          action,
          installationId: normalized.installation?.installationId,
          orgId: normalized.installation?.orgId,
          repoId: primaryRepo?.repoId,
          receivedAt: new Date(),
          processedAt: new Date(),
          status,
          payloadHash: normalized.payloadHash,
          payload: normalized.payload,
        })
        .onConflictDoNothing()
        .returning();

      if (!webhookRow) {
        return {
          status: "duplicate" as const,
          deliveryId: normalized.headers.deliveryId,
          webhookEventId,
          jobs: [],
        };
      }

      const jobs = planGitHubWebhookJobs({
        deliveryId: normalized.headers.deliveryId,
        eventName: normalized.headers.eventName,
        action,
        installation: normalized.installation,
        repositories: normalized.repositories,
        pullRequest: normalized.pullRequest,
      });

      for (const job of jobs) {
        await persistJob(tx, job);
      }

      return {
        status: status === "ignored" ? ("ignored" as const) : ("accepted" as const),
        deliveryId: normalized.headers.deliveryId,
        webhookEventId,
        jobs,
      };
    });

    return result;
  }
}

type Transaction = Parameters<HeimdallDatabase["transaction"]>[0] extends (tx: infer T) => unknown
  ? T
  : never;

async function persistInstallation(
  tx: Transaction,
  payload: Record<string, unknown>,
  installation: NormalizedGitHubInstallation,
): Promise<void> {
  const account = normalizeGitHubAccount(payload);
  const now = new Date();

  await tx
    .insert(orgs)
    .values({
      orgId: account.orgId,
      name: account.login,
      slug: account.login.toLowerCase(),
      metadata: account.metadata,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: orgs.orgId,
      set: {
        name: account.login,
        slug: account.login.toLowerCase(),
        metadata: account.metadata,
        updatedAt: now,
      },
    });

  await tx
    .insert(providerInstallations)
    .values({
      installationId: installation.installationId,
      orgId: installation.orgId,
      provider: "github",
      providerInstallationId: installation.providerInstallationId,
      accountLogin: installation.accountLogin,
      accountType: installation.accountType,
      permissions: installation.permissions,
      installedAt: new Date(installation.installedAt),
      metadata: installation.metadata,
    })
    .onConflictDoUpdate({
      target: [providerInstallations.provider, providerInstallations.providerInstallationId],
      set: {
        accountLogin: installation.accountLogin,
        accountType: installation.accountType,
        permissions: installation.permissions,
        metadata: installation.metadata,
      },
    });
}

async function persistRepository(
  tx: Transaction,
  normalizedRepository: NormalizedGitHubRepository,
): Promise<void> {
  const { repository, settings } = normalizedRepository;

  await tx
    .insert(repositories)
    .values({
      ...repository,
      createdAt: new Date(repository.createdAt),
      updatedAt: new Date(repository.updatedAt),
    })
    .onConflictDoUpdate({
      target: [repositories.provider, repositories.providerRepoId],
      set: {
        owner: repository.owner,
        name: repository.name,
        fullName: repository.fullName,
        defaultBranch: repository.defaultBranch,
        cloneUrl: repository.cloneUrl,
        visibility: repository.visibility,
        isArchived: repository.isArchived,
        isFork: repository.isFork,
        metadata: repository.metadata,
        updatedAt: new Date(repository.updatedAt),
      },
    });

  await tx
    .insert(repositorySettings)
    .values({
      ...settings,
      createdAt: new Date(settings.createdAt),
      updatedAt: new Date(settings.updatedAt),
    })
    .onConflictDoNothing();
}

async function persistPullRequest(
  tx: Transaction,
  normalizedPullRequest: NormalizedGitHubPullRequest,
): Promise<void> {
  const { snapshot } = normalizedPullRequest;
  const now = new Date();

  await tx
    .insert(pullRequestSnapshots)
    .values({
      ...snapshot,
      fetchedAt: new Date(snapshot.fetchedAt),
    })
    .onConflictDoNothing();

  await tx
    .insert(pullRequests)
    .values({
      pullRequestId: normalizedPullRequest.pullRequestId,
      repoId: snapshot.repoId,
      provider: snapshot.provider,
      providerPullRequestId: snapshot.providerPullRequestId,
      pullRequestNumber: snapshot.pullRequestNumber,
      title: snapshot.title,
      authorLogin: snapshot.authorLogin,
      state: snapshot.state,
      isDraft: snapshot.isDraft,
      baseRef: snapshot.baseRef,
      baseSha: snapshot.baseSha,
      headRef: snapshot.headRef,
      headSha: snapshot.headSha,
      latestSnapshotId: snapshot.snapshotId,
      metadata: snapshot.providerMetadata,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [pullRequests.repoId, pullRequests.pullRequestNumber],
      set: {
        title: snapshot.title,
        authorLogin: snapshot.authorLogin,
        state: snapshot.state,
        isDraft: snapshot.isDraft,
        baseRef: snapshot.baseRef,
        baseSha: snapshot.baseSha,
        headRef: snapshot.headRef,
        headSha: snapshot.headSha,
        latestSnapshotId: snapshot.snapshotId,
        metadata: snapshot.providerMetadata,
        updatedAt: now,
      },
    });
}

async function persistJob(tx: Transaction, job: PlannedJob): Promise<void> {
  await tx
    .insert(backgroundJobs)
    .values({
      backgroundJobId: newId("job"),
      queueName: job.queueName,
      jobKey: job.envelope.idempotencyKey,
      jobType: job.envelope.jobType,
      status: "pending",
      orgId: job.orgId,
      repoId: job.repoId,
      payload: job.envelope,
      maxAttempts: job.envelope.maxAttempts,
      scheduledAt: job.envelope.scheduledFor ? new Date(job.envelope.scheduledFor) : undefined,
    })
    .onConflictDoNothing();
}
