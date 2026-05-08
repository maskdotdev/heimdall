import type { OrgSettings, RepositorySettings } from "@repo/contracts";
import type { HeimdallDatabase } from "@repo/db";
import {
  BackgroundJobRepository,
  ProviderInstallationRepository,
  PullRequestRepository,
  RepositoryRepository,
  WebhookRepository,
} from "@repo/db";
import {
  type GitHubWebhookHeaders,
  readGitHubWebhookHeaders,
  verifyGitHubWebhookSignatureWithSecrets,
} from "@repo/github";
import {
  createTelemetryTraceContextFromHeaders,
  normalizeTelemetryTraceContext,
  type TelemetryMetricRecorder,
  type TelemetrySpanRecorder,
  type TelemetryTraceContext,
} from "@repo/observability";
import { newId, sha256, stableId } from "../ids";
import { type PlannedJob, WebhookAuthenticationError, type WebhookIngestionResult } from "../types";
import {
  type NormalizedGitHubFeedback,
  type NormalizedGitHubInstallation,
  type NormalizedGitHubPullRequest,
  type NormalizedGitHubRepository,
  normalizeGitHubAccount,
  normalizeGitHubFeedback,
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
  /** Optional metric recorder used for webhook planning policy telemetry. */
  readonly metrics?: TelemetryMetricRecorder | undefined;
  /** Optional span recorder used for webhook planning policy telemetry. */
  readonly traces?: TelemetrySpanRecorder | undefined;
  /** GitHub webhook secret. */
  readonly webhookSecret: string;
  /** Previous GitHub webhook secret accepted during a rotation window. */
  readonly previousWebhookSecret?: string | undefined;
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
  readonly matchedSecretVersion: string;
  readonly payloadHash: string;
  readonly payload: Record<string, unknown>;
  readonly traceContext: TelemetryTraceContext;
  readonly installation?: NormalizedGitHubInstallation | undefined;
  readonly repositories: readonly NormalizedGitHubRepository[];
  readonly pullRequest?: NormalizedGitHubPullRequest | undefined;
  readonly feedback?: NormalizedGitHubFeedback | undefined;
};

const supportedEvents = new Set([
  "installation",
  "repository",
  "pull_request",
  "issue_comment",
  "pull_request_review_comment",
  "reaction",
]);

/** Handles verified GitHub webhook ingestion and durable job persistence. */
export class GitHubWebhookHandler {
  /** Creates a GitHub webhook handler. */
  public constructor(private readonly dependencies: GitHubWebhookHandlerDependencies) {}

  /** Ingests a GitHub webhook delivery. */
  public async handle(input: HandleGitHubWebhookInput): Promise<WebhookIngestionResult> {
    const headers = readGitHubWebhookHeaders(input.headers);
    const verification = verifyGitHubWebhookSignatureWithSecrets({
      rawBody: input.rawBody,
      secrets: [
        { secret: this.dependencies.webhookSecret, version: "current" },
        ...(this.dependencies.previousWebhookSecret
          ? [{ secret: this.dependencies.previousWebhookSecret, version: "previous" }]
          : []),
      ],
      signature256: headers.signature256,
    });

    if (!verification.ok) {
      throw new WebhookAuthenticationError("GitHub webhook signature verification failed.");
    }

    const inboundTraceContext = createTelemetryTraceContextFromHeaders(input.headers);
    const normalized = this.normalize(
      headers,
      input.rawBody,
      inboundTraceContext,
      verification.matchedSecretVersion,
    );
    const result = await this.persist(normalized);

    return result;
  }

  private normalize(
    headers: GitHubWebhookHeaders,
    rawBody: Uint8Array,
    traceContext: TelemetryTraceContext,
    matchedSecretVersion: string,
  ): NormalizedEvent {
    const payload = parseGitHubWebhookPayload(rawBody);

    if (!supportedEvents.has(headers.eventName)) {
      return {
        headers,
        matchedSecretVersion,
        payloadHash: sha256(rawBody),
        payload,
        traceContext,
        repositories: [],
      };
    }

    const installation = normalizeGitHubInstallation(payload);
    const repositories = normalizeGitHubRepositories(payload);
    const pullRequest =
      headers.eventName === "pull_request" ? normalizeGitHubPullRequest(payload) : undefined;
    const feedback = normalizeGitHubFeedback(payload, headers.eventName);

    return {
      headers,
      matchedSecretVersion,
      payloadHash: sha256(rawBody),
      payload,
      traceContext,
      installation,
      repositories,
      pullRequest,
      feedback,
    };
  }

  private async persist(normalized: NormalizedEvent): Promise<WebhookIngestionResult> {
    const result = await this.dependencies.db.transaction(async (tx) => {
      const webhookEventId = stableId("webhook", ["github", normalized.headers.deliveryId]);
      const action =
        typeof normalized.payload.action === "string" ? normalized.payload.action : undefined;
      const status = supportedEvents.has(normalized.headers.eventName) ? "processed" : "ignored";
      const primaryRepo = normalized.repositories[0]?.repository;
      const webhookRepository = new WebhookRepository(tx);

      if (await webhookRepository.getWebhookEvent(webhookEventId)) {
        return {
          status: "duplicate" as const,
          deliveryId: normalized.headers.deliveryId,
          webhookEventId,
          jobs: [],
        };
      }

      if (normalized.installation) {
        await persistInstallation(tx, normalized.payload, normalized.installation, action);
      }

      for (const repository of normalized.repositories) {
        await persistRepository(tx, repository);
      }

      if (normalized.pullRequest) {
        await persistPullRequest(tx, normalized.pullRequest);
      }

      const webhookInsert = await webhookRepository.insertWebhookEvent({
        webhookEventId,
        provider: "github",
        deliveryId: normalized.headers.deliveryId,
        eventName: normalized.headers.eventName,
        ...(action ? { action } : {}),
        ...(normalized.installation?.installationId
          ? { installationId: normalized.installation.installationId }
          : {}),
        ...(normalized.installation?.orgId ? { orgId: normalized.installation.orgId } : {}),
        ...(primaryRepo?.repoId ? { repoId: primaryRepo.repoId } : {}),
        receivedAt: new Date().toISOString(),
        processedAt: new Date().toISOString(),
        status,
        payloadHash: normalized.payloadHash,
        payload: normalized.payload,
        metadata: { githubWebhookSecretVersion: normalized.matchedSecretVersion },
      });

      if (!webhookInsert.inserted) {
        return {
          status: "duplicate" as const,
          deliveryId: normalized.headers.deliveryId,
          webhookEventId,
          jobs: [],
        };
      }

      const traceContext = normalizeTelemetryTraceContext({
        ...normalized.traceContext,
        parentEventId: webhookEventId,
        requestId: normalized.headers.deliveryId,
      });
      const jobs = planGitHubWebhookJobs({
        deliveryId: normalized.headers.deliveryId,
        eventName: normalized.headers.eventName,
        action,
        installation: normalized.installation,
        orgSettings: await loadPersistedOrgSettings(tx, normalized.repositories),
        repositories: await loadRepositoriesForPlanning(tx, normalized.repositories),
        repositorySettings: await loadPersistedRepositorySettings(tx, normalized.repositories),
        pullRequest: normalized.pullRequest,
        feedback: normalized.feedback,
        ...(this.dependencies.metrics ? { metrics: this.dependencies.metrics } : {}),
        traceContext,
        ...(this.dependencies.traces ? { traces: this.dependencies.traces } : {}),
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

/** Returns unique repository IDs from normalized repository payloads. */
function uniqueRepositoryIds(
  normalizedRepositories: readonly NormalizedGitHubRepository[],
): readonly string[] {
  return [...new Set(normalizedRepositories.map((repository) => repository.repository.repoId))];
}

/** Returns unique organization IDs from normalized repository payloads. */
function uniqueOrgIds(
  normalizedRepositories: readonly NormalizedGitHubRepository[],
): readonly string[] {
  return [...new Set(normalizedRepositories.map((repository) => repository.repository.orgId))];
}

/** Applies persisted repository enablement to normalized repositories before job planning. */
async function loadRepositoriesForPlanning(
  tx: Transaction,
  normalizedRepositories: readonly NormalizedGitHubRepository[],
): Promise<readonly NormalizedGitHubRepository[]> {
  const repoIds = uniqueRepositoryIds(normalizedRepositories);

  if (repoIds.length === 0) {
    return normalizedRepositories;
  }

  const rows = await new RepositoryRepository(tx).listRepositoriesByIds(repoIds);
  const enabledByRepoId = new Map(rows.map((row) => [row.repoId, row.enabled]));

  return normalizedRepositories.map((normalizedRepository) => ({
    ...normalizedRepository,
    repository: {
      ...normalizedRepository.repository,
      enabled:
        enabledByRepoId.get(normalizedRepository.repository.repoId) ??
        normalizedRepository.repository.enabled,
    },
  }));
}

/** Loads persisted repository settings so trigger gating uses the current configured policy. */
async function loadPersistedRepositorySettings(
  tx: Transaction,
  normalizedRepositories: readonly NormalizedGitHubRepository[],
): Promise<readonly RepositorySettings[]> {
  const repoIds = uniqueRepositoryIds(normalizedRepositories);

  if (repoIds.length === 0) {
    return [];
  }

  return new RepositoryRepository(tx).listSettingsForRepositories(repoIds);
}

/** Loads persisted organization settings so trigger gating uses organization defaults. */
async function loadPersistedOrgSettings(
  tx: Transaction,
  normalizedRepositories: readonly NormalizedGitHubRepository[],
): Promise<readonly OrgSettings[]> {
  const orgIds = uniqueOrgIds(normalizedRepositories);

  if (orgIds.length === 0) {
    return [];
  }

  return new RepositoryRepository(tx).listOrgSettings(orgIds);
}

async function persistInstallation(
  tx: Transaction,
  payload: Record<string, unknown>,
  installation: NormalizedGitHubInstallation,
  action: string | undefined,
): Promise<void> {
  const account = normalizeGitHubAccount(payload);
  const now = new Date().toISOString();
  const deletedAt = action === "deleted" ? now : undefined;

  await new ProviderInstallationRepository(tx).upsertProviderInstallation({
    installation: {
      accountLogin: installation.accountLogin,
      accountType: installation.accountType,
      ...(deletedAt ? { deletedAt } : {}),
      installationId: installation.installationId,
      installedAt: installation.installedAt,
      metadata: installation.metadata,
      orgId: installation.orgId,
      permissions: installation.permissions,
      provider: "github",
      providerInstallationId: installation.providerInstallationId,
    },
    org: {
      createdAt: now,
      metadata: account.metadata,
      orgId: account.orgId,
      name: account.login,
      slug: account.login.toLowerCase(),
      updatedAt: now,
    },
  });
}

async function persistRepository(
  tx: Transaction,
  normalizedRepository: NormalizedGitHubRepository,
): Promise<void> {
  const { repository, settings } = normalizedRepository;
  const repositoryRepository = new RepositoryRepository(tx);

  await repositoryRepository.upsertProviderRepositoryMetadata(repository);
  await repositoryRepository.insertSettingsIfAbsent(settings);
}

async function persistPullRequest(
  tx: Transaction,
  normalizedPullRequest: NormalizedGitHubPullRequest,
): Promise<void> {
  await new PullRequestRepository(tx).upsertPullRequest({
    pullRequestId: normalizedPullRequest.pullRequestId,
    snapshot: normalizedPullRequest.snapshot,
  });
}

async function persistJob(tx: Transaction, job: PlannedJob): Promise<void> {
  await new BackgroundJobRepository(tx).insertBackgroundJob({
    backgroundJobId: newId("job"),
    queueName: job.queueName,
    envelope: job.envelope,
    ...(job.orgId ? { orgId: job.orgId } : {}),
    ...(job.repoId ? { repoId: job.repoId } : {}),
  });
}
