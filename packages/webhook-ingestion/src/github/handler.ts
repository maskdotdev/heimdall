import {
  type OrgSettings,
  OrgSettingsSchema,
  parseWithSchema,
  type RepositorySettings,
  RepositorySettingsSchema,
} from "@repo/contracts";
import type { HeimdallDatabase } from "@repo/db";
import {
  backgroundJobs,
  orgSettings,
  orgs,
  providerInstallations,
  pullRequestSnapshots,
  pullRequests,
  repositories,
  repositorySettings,
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
import { inArray } from "drizzle-orm";
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
        await persistInstallation(tx, normalized.payload, normalized.installation);
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

  const rows = await tx
    .select({ enabled: repositories.enabled, repoId: repositories.repoId })
    .from(repositories)
    .where(inArray(repositories.repoId, repoIds));
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

  const rows = await tx
    .select()
    .from(repositorySettings)
    .where(inArray(repositorySettings.repoId, repoIds));

  return rows.map(parseRepositorySettingsRow);
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

  const rows = await tx.select().from(orgSettings).where(inArray(orgSettings.orgId, orgIds));

  return rows.map(parseOrgSettingsRow);
}

/** Parses an organization settings database row into the public contract. */
function parseOrgSettingsRow(row: {
  readonly orgId: string;
  readonly settingsJson: unknown;
  readonly version: number;
  readonly updatedByUserId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}): OrgSettings {
  const settingsJson =
    row.settingsJson && typeof row.settingsJson === "object" && !Array.isArray(row.settingsJson)
      ? (row.settingsJson as Record<string, unknown>)
      : {};

  return parseWithSchema("OrgSettings", OrgSettingsSchema, {
    ...settingsJson,
    orgId: row.orgId,
    version: row.version,
    updatedByUserId: row.updatedByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

/** Parses a repository settings database row into the public contract. */
function parseRepositorySettingsRow(row: {
  readonly repoId: string;
  readonly reviewPolicy: string;
  readonly severityThreshold: string;
  readonly maxCommentsPerReview: number;
  readonly ignoredPaths: unknown;
  readonly ignoredAuthors: unknown;
  readonly ignoredLabels: unknown;
  readonly requireLabel: string | null;
  readonly skipGeneratedFiles: boolean;
  readonly skipDraftPullRequests: boolean;
  readonly enabledLanguages: unknown;
  readonly customInstructions: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}): RepositorySettings {
  return parseWithSchema("RepositorySettings", RepositorySettingsSchema, {
    repoId: row.repoId,
    reviewPolicy: row.reviewPolicy,
    severityThreshold: row.severityThreshold,
    maxCommentsPerReview: row.maxCommentsPerReview,
    ignoredPaths: row.ignoredPaths,
    ignoredAuthors: row.ignoredAuthors,
    ignoredLabels: row.ignoredLabels,
    ...(row.requireLabel === null ? {} : { requireLabel: row.requireLabel }),
    skipGeneratedFiles: row.skipGeneratedFiles,
    skipDraftPullRequests: row.skipDraftPullRequests,
    ...(row.enabledLanguages === null ? {} : { enabledLanguages: row.enabledLanguages }),
    ...(row.customInstructions === null ? {} : { customInstructions: row.customInstructions }),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

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
