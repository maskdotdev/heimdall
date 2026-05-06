import { createHash, randomUUID } from "node:crypto";
import type {
  JobEnvelope,
  JobPayload,
  PublishReviewJobPayload,
  ReviewPullRequestJobPayload,
  ReviewRun,
  ValidatedFinding,
} from "@repo/contracts";
import { JOB_TYPES } from "@repo/contracts";
import {
  auditLogs,
  backgroundJobs,
  candidateFindings,
  type HeimdallDatabase,
  llmCalls,
  publishedCheckRuns,
  publishedFindings,
  publishedReviews,
  publishedSummaryComments,
  publishOperations,
  publishRuns,
  pullRequestSnapshots,
  ReviewRepository,
  reviewArtifacts,
  reviewRunDependencies,
  reviewRunStageEvents,
  validatedFindings,
  webhookEvents,
} from "@repo/db";
import { parseJobEnvelope, QUEUE_NAMES, type QueueName } from "@repo/queue";
import { and, asc, desc, eq, inArray, or } from "drizzle-orm";

/** Resource type that an admin debug lookup can target. */
export type AdminDebugResourceType = "webhook_event" | "review_run";

/** Error raised when an admin debug resource does not exist. */
export class AdminDebugNotFoundError extends Error {
  /** Creates an admin debug not-found error. */
  public constructor(
    /** Resource type that was requested. */
    public readonly resourceType: AdminDebugResourceType,
    /** Resource ID that was requested. */
    public readonly resourceId: string,
  ) {
    super(`${resourceType} ${resourceId} was not found.`);
    this.name = "AdminDebugNotFoundError";
  }
}

/** Error raised when an admin replay request uses a stale or invalid confirmation token. */
export class AdminDebugConfirmationError extends Error {
  /** Creates an admin replay confirmation error. */
  public constructor(
    /** Confirmation token provided by the operator. */
    public readonly providedToken: string,
    /** Confirmation token expected for the current durable state. */
    public readonly expectedToken: string,
  ) {
    super("Admin replay confirmation token does not match the current replay plan.");
    this.name = "AdminDebugConfirmationError";
  }
}

/** Source table or event that produced a structured admin failure detail. */
export type AdminFailureSource =
  | "webhook_event"
  | "background_job"
  | "review_run"
  | "review_stage_event"
  | "llm_call"
  | "publish_run"
  | "publish_operation"
  | "published_finding";

/** Structured failure detail shown by admin/debug inspectors. */
export type AdminFailureDetail = {
  /** Table or event source that produced the failure. */
  readonly source: AdminFailureSource;
  /** Machine-readable failure code. */
  readonly code: string;
  /** Human-readable failure message. */
  readonly message: string;
  /** Whether retrying the operation is expected to be safe. */
  readonly retryable?: boolean;
  /** Related database row ID when available. */
  readonly rowId?: string;
  /** ISO timestamp associated with the failure when available. */
  readonly occurredAt?: string;
  /** Additional structured failure metadata. */
  readonly details?: unknown;
};

/** Debug summary for one durable background job row. */
export type AdminBackgroundJobDebugSummary = {
  /** Durable background job row ID. */
  readonly backgroundJobId: string;
  /** Queue that owns the job. */
  readonly queueName: string;
  /** Durable idempotency key used by the job. */
  readonly jobKey: string;
  /** Handler type carried by the job envelope. */
  readonly jobType: string;
  /** Current durable job status. */
  readonly status: string;
  /** Organization associated with the job when available. */
  readonly orgId?: string;
  /** Repository associated with the job when available. */
  readonly repoId?: string;
  /** Review run associated with the job when available. */
  readonly reviewRunId?: string;
  /** Current durable attempt count. */
  readonly attempts: number;
  /** Maximum durable attempts allowed. */
  readonly maxAttempts: number;
  /** ISO timestamp for scheduled execution when available. */
  readonly scheduledAt?: string;
  /** ISO timestamp for handler start when available. */
  readonly startedAt?: string;
  /** ISO timestamp for handler completion when available. */
  readonly completedAt?: string;
  /** ISO timestamp for row creation. */
  readonly createdAt: string;
  /** ISO timestamp for row update. */
  readonly updatedAt: string;
  /** Raw validated or stored job envelope for operator inspection. */
  readonly payload: unknown;
  /** Structured durable job failure when available. */
  readonly failure?: AdminFailureDetail;
};

/** Debug summary for one webhook delivery row. */
export type AdminWebhookEventDebugSummary = {
  /** Normalized webhook event ID. */
  readonly webhookEventId: string;
  /** Source provider for the webhook. */
  readonly provider: string;
  /** Provider delivery ID. */
  readonly deliveryId: string;
  /** Provider event name. */
  readonly eventName: string;
  /** Provider action when present. */
  readonly action?: string;
  /** Heimdall installation ID when present. */
  readonly installationId?: string;
  /** Heimdall organization ID when present. */
  readonly orgId?: string;
  /** Heimdall repository ID when present. */
  readonly repoId?: string;
  /** Current webhook processing status. */
  readonly status: string;
  /** SHA-256 hash of the stored payload. */
  readonly payloadHash: string;
  /** Whether a raw payload is stored in the database row. */
  readonly hasStoredPayload: boolean;
  /** ISO timestamp for receipt. */
  readonly receivedAt: string;
  /** ISO timestamp for processing completion when available. */
  readonly processedAt?: string;
  /** Structured webhook failure when available. */
  readonly failure?: AdminFailureDetail;
};

/** Debug detail for one webhook delivery and its planned durable jobs. */
export type AdminWebhookDebugDetails = {
  /** Webhook event summary. */
  readonly webhookEvent: AdminWebhookEventDebugSummary;
  /** Job keys that the stored webhook payload maps to. */
  readonly expectedJobKeys: readonly string[];
  /** Durable jobs found for the expected job keys. */
  readonly relatedJobs: readonly AdminBackgroundJobDebugSummary[];
  /** Replay decisions already audited for this webhook event. */
  readonly replayAudits: readonly AdminReplayAuditSummary[];
  /** Structured failures collected from the webhook and related jobs. */
  readonly failures: readonly AdminFailureDetail[];
};

/** Replay action that requeues jobs originally planned from a webhook. */
export type WebhookReplayAction = "webhook.requeue_jobs";

/** Source state used to construct one replay job. */
export type AdminReplayJobSource = "existing_job" | "missing_job" | "operator_replay";

/** Durable replay job that can be inserted after operator confirmation. */
export type AdminReplayJobPlan = {
  /** Source state used to construct the replay job. */
  readonly source: AdminReplayJobSource;
  /** Queue that should receive the replay job. */
  readonly queueName: QueueName;
  /** Handler type carried by the replay envelope. */
  readonly jobType: string;
  /** Original durable job row ID when replaying a failed or dead-lettered job. */
  readonly originalBackgroundJobId?: string;
  /** Original idempotency key when replaying or recreating a planned job. */
  readonly originalJobKey?: string;
  /** New idempotency key for the replay row. */
  readonly replayJobKey: string;
  /** Replay job envelope to persist in the durable outbox. */
  readonly envelope: JobEnvelope<JobPayload>;
  /** Organization associated with the replay job when available. */
  readonly orgId?: string;
  /** Repository associated with the replay job when available. */
  readonly repoId?: string;
  /** Review run associated with the replay job when available. */
  readonly reviewRunId?: string;
};

/** Result returned after inserting confirmed replay jobs into the durable outbox. */
export type AdminReplayExecutionResult = {
  /** Replay action that was confirmed. */
  readonly action: WebhookReplayAction | ReviewReplayAction | PublisherReplayAction;
  /** Confirmation token that matched the current replay plan. */
  readonly confirmationToken: string;
  /** Audit log row ID written for the replay decision. */
  readonly auditLogId: string;
  /** Durable job row IDs inserted for this replay. */
  readonly insertedJobIds: readonly string[];
  /** Durable job row IDs that already existed for the replay keys. */
  readonly existingJobIds: readonly string[];
  /** Replay jobs currently present in the durable outbox. */
  readonly replayJobs: readonly AdminBackgroundJobDebugSummary[];
};

/** Authenticated support/admin actor that requested a replay operation. */
export type AdminReplayAuditActor = {
  /** Actor category stored in the audit log. */
  readonly actorType: "admin_user" | "idp_user" | "internal_token";
  /** Stable user or token principal ID stored in the audit log. */
  readonly actorUserId: string;
  /** Access role granted to the actor. */
  readonly role: "support" | "admin";
  /** Request ID that authorized this replay decision. */
  readonly requestId?: string;
  /** Session ID that authorized this replay decision. */
  readonly sessionId?: string;
  /** Identity provider that authenticated the actor when available. */
  readonly provider?: string;
  /** Granular permissions granted to the actor when available. */
  readonly permissions?: readonly string[];
  /** Display name shown in operator views when available. */
  readonly displayName?: string;
  /** Primary email shown in operator views when available. */
  readonly email?: string;
};

/** Replay audit row shown by admin/debug inspectors. */
export type AdminReplayAuditSummary = {
  /** Audit log row ID. */
  readonly auditLogId: string;
  /** Optional organization associated with the audited operation. */
  readonly orgId?: string;
  /** Actor category stored in the audit log. */
  readonly actorType: string;
  /** Stable actor user ID when available. */
  readonly actorUserId?: string;
  /** Replay action that was confirmed. */
  readonly action: string;
  /** Resource type affected by the replay. */
  readonly resourceType: string;
  /** Resource ID affected by the replay when available. */
  readonly resourceId?: string;
  /** ISO timestamp for the audited decision. */
  readonly occurredAt: string;
  /** Replay plan and result metadata recorded with the decision. */
  readonly metadata?: unknown;
};

/** Gated replay plan for webhook-owned durable jobs. */
export type WebhookReplayPlan = {
  /** Action that an operator can dispatch after confirmation. */
  readonly action: WebhookReplayAction;
  /** Webhook event that owns the replay plan. */
  readonly webhookEventId: string;
  /** Provider delivery ID for operator context. */
  readonly deliveryId: string;
  /** Durable job IDs eligible for replay. */
  readonly eligibleJobIds: readonly string[];
  /** Durable job IDs that are intentionally not replayable in their current state. */
  readonly blockedJobIds: readonly string[];
  /** Expected job keys that had no durable row to replay. */
  readonly missingJobKeys: readonly string[];
  /** Replay jobs that can be inserted after confirmation, including recreated missing jobs. */
  readonly jobs: readonly AdminReplayJobPlan[];
  /** Related job summaries used to build the plan. */
  readonly relatedJobs: readonly AdminBackgroundJobDebugSummary[];
  /** Current failure details that motivated or constrain replay. */
  readonly failures: readonly AdminFailureDetail[];
  /** Confirmation token derived from the current plan state. */
  readonly confirmationToken: string;
  /** Whether dispatching this plan can mutate operational state. */
  readonly requiresExplicitConfirmation: true;
};

/** Debug summary for one review stage event. */
export type AdminReviewStageEventDebugSummary = {
  /** Stage event row ID. */
  readonly reviewRunStageEventId: string;
  /** Stage name. */
  readonly stage: string;
  /** Stage status. */
  readonly status: string;
  /** Optional stage message. */
  readonly message?: string;
  /** ISO timestamp for the stage event. */
  readonly occurredAt: string;
  /** Stage metadata. */
  readonly metadata?: unknown;
  /** Structured stage failure when the event failed. */
  readonly failure?: AdminFailureDetail;
};

/** Debug summary for one review dependency row. */
export type AdminReviewDependencyDebugSummary = {
  /** Review run ID that owns the dependency. */
  readonly reviewRunId: string;
  /** Dependency type such as an index version. */
  readonly dependencyType: string;
  /** Dependency row ID. */
  readonly dependencyId: string;
  /** Dependency metadata. */
  readonly metadata?: unknown;
};

/** Debug summary for a pull request snapshot without raw diff content. */
export type AdminPullRequestSnapshotDebugSummary = {
  /** Pull request snapshot row ID. */
  readonly snapshotId: string;
  /** Source provider for the snapshot. */
  readonly provider: string;
  /** Repository that owns the snapshot. */
  readonly repoId: string;
  /** Installation that owns the snapshot. */
  readonly installationId: string;
  /** Provider pull request number. */
  readonly pullRequestNumber: number;
  /** Pull request title. */
  readonly title: string;
  /** Pull request author login. */
  readonly authorLogin: string;
  /** Pull request state. */
  readonly state: string;
  /** Whether the pull request was a draft. */
  readonly isDraft: boolean;
  /** Base branch name. */
  readonly baseRef: string;
  /** Base commit SHA. */
  readonly baseSha: string;
  /** Head branch name. */
  readonly headRef: string;
  /** Head commit SHA. */
  readonly headSha: string;
  /** Diff hash for the snapshot. */
  readonly diffHash: string;
  /** Added line count. */
  readonly additions: number;
  /** Deleted line count. */
  readonly deletions: number;
  /** Changed file count. */
  readonly changedFileCount: number;
  /** Changed file paths and statuses without hunk bodies. */
  readonly changedFiles: readonly {
    /** Repository path for the changed file. */
    readonly path: string;
    /** Provider file status when present. */
    readonly status?: string;
  }[];
  /** ISO timestamp when the snapshot was fetched. */
  readonly fetchedAt: string;
};

/** Debug summary for one review artifact row. */
export type AdminReviewArtifactDebugSummary = {
  /** Review artifact row ID. */
  readonly reviewArtifactId: string;
  /** Artifact kind. */
  readonly kind: string;
  /** Artifact name scoped to the review run. */
  readonly name: string;
  /** Artifact URI. */
  readonly uri: string;
  /** Artifact content hash. */
  readonly hash: string;
  /** Artifact byte size. */
  readonly sizeBytes: number;
  /** Artifact classification. */
  readonly classification: string;
  /** ISO timestamp for artifact creation. */
  readonly createdAt: string;
  /** Whether the artifact row stores a payload in metadata. */
  readonly hasStoredPayload: boolean;
  /** Metadata keys available on the artifact row. */
  readonly metadataKeys: readonly string[];
};

/** Debug summary for one candidate finding. */
export type AdminCandidateFindingDebugSummary = {
  /** Candidate finding ID. */
  readonly findingId: string;
  /** Source type that emitted the finding. */
  readonly source: string;
  /** Source pass or tool name. */
  readonly sourceName: string;
  /** Finding category. */
  readonly category: string;
  /** Finding severity. */
  readonly severity: string;
  /** Finding title. */
  readonly title: string;
  /** Finding location. */
  readonly location: unknown;
  /** Finding confidence. */
  readonly confidence: number;
  /** Finding fingerprint. */
  readonly fingerprint: string;
  /** ISO timestamp for candidate creation. */
  readonly createdAt: string;
};

/** Debug summary for one validated finding. */
export type AdminValidatedFindingDebugSummary = {
  /** Validated finding ID. */
  readonly findingId: string;
  /** Candidate finding ID that produced the validated finding. */
  readonly candidateFindingId: string;
  /** Publish or reject decision. */
  readonly decision: string;
  /** Finding category. */
  readonly category: string;
  /** Finding severity. */
  readonly severity: string;
  /** Finding title. */
  readonly title: string;
  /** Finding location. */
  readonly location: unknown;
  /** Finding rank when publishable. */
  readonly rank?: number;
  /** Finding fingerprint. */
  readonly fingerprint: string;
  /** Validation payload, including rejection reasons. */
  readonly validation: unknown;
};

/** Debug summary for one LLM call linked to a review run. */
export type AdminLlmCallDebugSummary = {
  /** LLM call row ID. */
  readonly llmCallId: string;
  /** Provider used by the call. */
  readonly provider: string;
  /** Model used by the call. */
  readonly model: string;
  /** Call purpose. */
  readonly purpose: string;
  /** Current call status. */
  readonly status: string;
  /** Prompt hash. */
  readonly promptHash: string;
  /** Response hash when available. */
  readonly responseHash?: string;
  /** Input token count. */
  readonly inputTokens: number;
  /** Output token count. */
  readonly outputTokens: number;
  /** Cost in micros. */
  readonly costMicros: number;
  /** ISO timestamp when the call started. */
  readonly startedAt: string;
  /** ISO timestamp when the call completed. */
  readonly completedAt?: string;
  /** Structured call failure when available. */
  readonly failure?: AdminFailureDetail;
};

/** Review run inspector output for admin/debug workflows. */
export type AdminReviewDebugDetails = {
  /** Review run contract row. */
  readonly reviewRun: ReviewRun;
  /** Pull request snapshot summary used by the review run. */
  readonly snapshot?: AdminPullRequestSnapshotDebugSummary;
  /** Stage timeline for the review run. */
  readonly stageEvents: readonly AdminReviewStageEventDebugSummary[];
  /** Durable dependencies used by the review run. */
  readonly dependencies: readonly AdminReviewDependencyDebugSummary[];
  /** Artifacts emitted by the review run. */
  readonly artifacts: readonly AdminReviewArtifactDebugSummary[];
  /** Candidate finding summaries. */
  readonly candidateFindings: readonly AdminCandidateFindingDebugSummary[];
  /** Validated finding summaries. */
  readonly validatedFindings: readonly AdminValidatedFindingDebugSummary[];
  /** LLM calls linked to the review run. */
  readonly llmCalls: readonly AdminLlmCallDebugSummary[];
  /** Related review and publish jobs. */
  readonly relatedJobs: readonly AdminBackgroundJobDebugSummary[];
  /** Replay decisions already audited for this review run. */
  readonly replayAudits: readonly AdminReplayAuditSummary[];
  /** Structured failures collected from review state and related jobs. */
  readonly failures: readonly AdminFailureDetail[];
};

/** Replay action that requeues a review job from persisted review state. */
export type ReviewReplayAction = "review.requeue";

/** Gated replay plan for a review run. */
export type ReviewReplayPlan = {
  /** Action that an operator can dispatch after confirmation. */
  readonly action: ReviewReplayAction;
  /** Review run that owns the replay. */
  readonly reviewRunId: string;
  /** Queue that should receive the replay job. */
  readonly queueName: QueueName;
  /** New replay idempotency key. */
  readonly jobKey: string;
  /** Replay job that can be inserted after confirmation. */
  readonly job: AdminReplayJobPlan;
  /** Payload to dispatch to the review worker. */
  readonly payload: ReviewPullRequestJobPayload;
  /** Current review status. */
  readonly currentStatus: string;
  /** Related job summaries used to build the plan. */
  readonly relatedJobs: readonly AdminBackgroundJobDebugSummary[];
  /** Current failure details that motivated or constrain replay. */
  readonly failures: readonly AdminFailureDetail[];
  /** Confirmation token derived from the current plan state. */
  readonly confirmationToken: string;
  /** Whether dispatching this plan can mutate operational state. */
  readonly requiresExplicitConfirmation: true;
};

/** Debug summary for one publish run row. */
export type AdminPublishRunDebugSummary = {
  /** Durable publish run row ID. */
  readonly publishRunId: string;
  /** Review run that owns the publish run. */
  readonly reviewRunId: string;
  /** Repository that owns the publish run. */
  readonly repoId: string;
  /** Publisher idempotency key. */
  readonly idempotencyKey: string;
  /** Current publish status. */
  readonly status: string;
  /** ISO timestamp when publishing started. */
  readonly startedAt?: string;
  /** ISO timestamp when publishing completed. */
  readonly completedAt?: string;
  /** ISO timestamp when the publish row was created. */
  readonly createdAt: string;
  /** Publish metadata. */
  readonly metadata?: unknown;
  /** Structured publish failure when available. */
  readonly failure?: AdminFailureDetail;
};

/** Debug summary for one low-level publisher operation row. */
export type AdminPublishOperationDebugSummary = {
  /** Publish operation row ID. */
  readonly publishOperationId: string;
  /** Publish run that owns the operation. */
  readonly publishRunId: string;
  /** Operation type. */
  readonly operationType: string;
  /** Current operation status. */
  readonly status: string;
  /** Request hash when available. */
  readonly requestHash?: string;
  /** Response hash when available. */
  readonly responseHash?: string;
  /** ISO timestamp when the operation row was created. */
  readonly createdAt: string;
  /** Structured operation failure when available. */
  readonly failure?: AdminFailureDetail;
};

/** Debug summary of publisher output rows. */
export type AdminPublisherOutputDebugSummary = {
  /** Persisted provider check runs. */
  readonly checkRuns: readonly unknown[];
  /** Persisted provider review objects. */
  readonly reviews: readonly unknown[];
  /** Persisted fallback summary comments. */
  readonly summaryComments: readonly unknown[];
  /** Persisted finding publication rows. */
  readonly findings: readonly unknown[];
};

/** Publisher inspector output for admin/debug workflows. */
export type AdminPublisherDebugDetails = {
  /** Review run being inspected. */
  readonly reviewRunId: string;
  /** Repository that owns the review run. */
  readonly repoId: string;
  /** Publish runs for the review run. */
  readonly publishRuns: readonly AdminPublishRunDebugSummary[];
  /** Low-level publish operations for the publish runs. */
  readonly operations: readonly AdminPublishOperationDebugSummary[];
  /** Durable publisher output rows. */
  readonly outputs: AdminPublisherOutputDebugSummary;
  /** Related publish jobs. */
  readonly relatedJobs: readonly AdminBackgroundJobDebugSummary[];
  /** Publisher replay decisions already audited for this review run. */
  readonly replayAudits: readonly AdminReplayAuditSummary[];
  /** Reconciliation report for the current durable publisher state. */
  readonly reconciliation: PublisherReconciliationReport;
  /** Structured failures collected from publisher state and related jobs. */
  readonly failures: readonly AdminFailureDetail[];
};

/** Dependencies used by the admin/debug inspector service. */
export type AdminDebugServiceDependencies = {
  /** Database used to inspect durable state. */
  readonly db: HeimdallDatabase;
};

/** Admin/debug inspector and replay planning service. */
export type AdminDebugService = {
  /** Gets webhook debug details. */
  readonly getWebhookDebugDetails: (webhookEventId: string) => Promise<AdminWebhookDebugDetails>;
  /** Creates a gated webhook replay plan. */
  readonly createWebhookReplayPlan: (webhookEventId: string) => Promise<WebhookReplayPlan>;
  /** Executes a confirmed webhook replay plan. */
  readonly executeWebhookReplay: (
    webhookEventId: string,
    confirmationToken: string,
    actor: AdminReplayAuditActor,
  ) => Promise<AdminReplayExecutionResult>;
  /** Gets review run debug details. */
  readonly getReviewDebugDetails: (reviewRunId: string) => Promise<AdminReviewDebugDetails>;
  /** Creates a gated review replay plan. */
  readonly createReviewReplayPlan: (reviewRunId: string) => Promise<ReviewReplayPlan>;
  /** Executes a confirmed review replay plan. */
  readonly executeReviewReplay: (
    reviewRunId: string,
    confirmationToken: string,
    actor: AdminReplayAuditActor,
  ) => Promise<AdminReplayExecutionResult>;
  /** Gets publisher debug details. */
  readonly getPublisherDebugDetails: (reviewRunId: string) => Promise<AdminPublisherDebugDetails>;
  /** Creates a gated publisher replay plan. */
  readonly createPublisherReplayPlan: (reviewRunId: string) => Promise<PublisherReplayPlan>;
  /** Executes a confirmed publisher replay plan. */
  readonly executePublisherReplay: (
    reviewRunId: string,
    confirmationToken: string,
    actor: AdminReplayAuditActor,
  ) => Promise<AdminReplayExecutionResult>;
};

/** Creates an admin/debug service backed by durable Heimdall state. */
export function createAdminDebugService(
  dependencies: AdminDebugServiceDependencies,
): AdminDebugService {
  return {
    getWebhookDebugDetails: (webhookEventId) =>
      getWebhookDebugDetails(webhookEventId, dependencies),
    createWebhookReplayPlan: (webhookEventId) =>
      createWebhookReplayPlan(webhookEventId, dependencies),
    executeWebhookReplay: (webhookEventId, confirmationToken, actor) =>
      executeWebhookReplay(webhookEventId, confirmationToken, dependencies, actor),
    getReviewDebugDetails: (reviewRunId) => getReviewDebugDetails(reviewRunId, dependencies),
    createReviewReplayPlan: (reviewRunId) => createReviewReplayPlan(reviewRunId, dependencies),
    executeReviewReplay: (reviewRunId, confirmationToken, actor) =>
      executeReviewReplay(reviewRunId, confirmationToken, dependencies, actor),
    getPublisherDebugDetails: (reviewRunId) => getPublisherDebugDetails(reviewRunId, dependencies),
    createPublisherReplayPlan: (reviewRunId) =>
      createPublisherReplayPlan(reviewRunId, dependencies),
    executePublisherReplay: (reviewRunId, confirmationToken, actor) =>
      executePublisherReplay(reviewRunId, confirmationToken, dependencies, actor),
  };
}

/** Gets webhook event state, related durable jobs, and normalized failures. */
export async function getWebhookDebugDetails(
  webhookEventId: string,
  dependencies: AdminDebugServiceDependencies,
): Promise<AdminWebhookDebugDetails> {
  const row = await getWebhookEventRow(webhookEventId, dependencies.db);
  const expectedJobKeys = deriveWebhookJobKeys(row);
  const [relatedJobs, replayAudits] = await Promise.all([
    listJobsByKeys(dependencies.db, expectedJobKeys),
    listReplayAuditLogs(dependencies.db, {
      actions: ["webhook.requeue_jobs"],
      resourceType: "webhook_event",
      resourceId: webhookEventId,
    }),
  ]);
  const webhookEvent = toWebhookDebugSummary(row);
  const failures = collectFailures([
    webhookEvent.failure,
    ...relatedJobs.map((job) => job.failure),
  ]);

  return {
    webhookEvent,
    expectedJobKeys,
    relatedJobs,
    replayAudits,
    failures,
  };
}

/** Creates a replay plan for durable jobs originally planned from a webhook event. */
export async function createWebhookReplayPlan(
  webhookEventId: string,
  dependencies: AdminDebugServiceDependencies,
): Promise<WebhookReplayPlan> {
  const row = await getWebhookEventRow(webhookEventId, dependencies.db);
  const details = await getWebhookDebugDetails(webhookEventId, dependencies);
  const relatedJobIds = new Set(details.relatedJobs.map((job) => job.backgroundJobId));
  const expectedJobs = new Set(details.expectedJobKeys);
  const eligibleJobs = details.relatedJobs.filter((job) =>
    ["failed", "dead_lettered"].includes(job.status),
  );
  const blockedJobs = details.relatedJobs.filter(
    (job) =>
      !eligibleJobs.some((eligibleJob) => eligibleJob.backgroundJobId === job.backgroundJobId),
  );
  const missingJobKeys = [...expectedJobs].filter(
    (jobKey) => !details.relatedJobs.some((job) => job.jobKey === jobKey),
  );
  const replayJobs = [
    ...eligibleJobs.map((job) => replayJobFromExistingJob(job, webhookEventId)),
    ...deriveWebhookReplayJobs(row)
      .filter((job) => missingJobKeys.includes(job.originalJobKey))
      .map((job) => replayJobFromDerivedWebhookJob(job, webhookEventId)),
  ];
  const confirmationPayload = {
    action: "webhook.requeue_jobs",
    webhookEventId,
    deliveryId: details.webhookEvent.deliveryId,
    eligibleJobIds: eligibleJobs.map((job) => job.backgroundJobId),
    blockedJobIds: [...relatedJobIds].filter(
      (jobId) => !eligibleJobs.some((job) => job.backgroundJobId === jobId),
    ),
    missingJobKeys,
    replayJobs: replayJobs.map(toReplayConfirmationJob),
    failureCodes: details.failures.map((failure) => failure.code),
  };

  return {
    action: "webhook.requeue_jobs",
    webhookEventId,
    deliveryId: details.webhookEvent.deliveryId,
    eligibleJobIds: confirmationPayload.eligibleJobIds,
    blockedJobIds: blockedJobs.map((job) => job.backgroundJobId),
    missingJobKeys,
    jobs: replayJobs,
    relatedJobs: details.relatedJobs,
    failures: details.failures,
    confirmationToken: hashJson(confirmationPayload),
    requiresExplicitConfirmation: true,
  };
}

/** Executes a confirmed webhook replay plan by inserting durable replay jobs. */
export async function executeWebhookReplay(
  webhookEventId: string,
  confirmationToken: string,
  dependencies: AdminDebugServiceDependencies,
  actor: AdminReplayAuditActor,
): Promise<AdminReplayExecutionResult> {
  const row = await getWebhookEventRow(webhookEventId, dependencies.db);
  const plan = await createWebhookReplayPlan(webhookEventId, dependencies);
  assertConfirmationToken(confirmationToken, plan.confirmationToken);
  return insertReplayJobs({
    db: dependencies.db,
    action: plan.action,
    confirmationToken,
    jobs: plan.jobs,
    audit: {
      actor,
      resourceType: "webhook_event",
      resourceId: webhookEventId,
      orgId: firstDefined(plan.jobs.map((job) => job.orgId)) ?? row.orgId ?? undefined,
      plan: auditPlanFromWebhookReplayPlan(plan),
    },
  });
}

/** Gets review state, stage timeline, findings, related jobs, and normalized failures. */
export async function getReviewDebugDetails(
  reviewRunId: string,
  dependencies: AdminDebugServiceDependencies,
): Promise<AdminReviewDebugDetails> {
  const reviewRepository = new ReviewRepository(dependencies.db);
  const reviewRun = await reviewRepository.getReviewRun(reviewRunId);
  if (!reviewRun) {
    throw new AdminDebugNotFoundError("review_run", reviewRunId);
  }

  const [
    snapshotRows,
    stageRows,
    dependencyRows,
    artifactRows,
    candidateRows,
    validatedRows,
    llmRows,
    relatedJobs,
    replayAudits,
  ] = await Promise.all([
    dependencies.db
      .select()
      .from(pullRequestSnapshots)
      .where(eq(pullRequestSnapshots.snapshotId, reviewRun.pullRequestSnapshotId))
      .limit(1),
    dependencies.db
      .select()
      .from(reviewRunStageEvents)
      .where(eq(reviewRunStageEvents.reviewRunId, reviewRunId))
      .orderBy(asc(reviewRunStageEvents.occurredAt)),
    dependencies.db
      .select()
      .from(reviewRunDependencies)
      .where(eq(reviewRunDependencies.reviewRunId, reviewRunId)),
    dependencies.db
      .select()
      .from(reviewArtifacts)
      .where(eq(reviewArtifacts.reviewRunId, reviewRunId))
      .orderBy(asc(reviewArtifacts.createdAt)),
    dependencies.db
      .select()
      .from(candidateFindings)
      .where(eq(candidateFindings.reviewRunId, reviewRunId))
      .orderBy(asc(candidateFindings.createdAt)),
    dependencies.db
      .select()
      .from(validatedFindings)
      .where(eq(validatedFindings.reviewRunId, reviewRunId)),
    dependencies.db
      .select()
      .from(llmCalls)
      .where(eq(llmCalls.reviewRunId, reviewRunId))
      .orderBy(asc(llmCalls.startedAt)),
    listRelatedReviewJobs(dependencies.db, {
      reviewRunId,
      repoId: reviewRun.repoId,
      pullRequestNumber: reviewRun.pullRequestNumber,
      headSha: reviewRun.headSha,
    }),
    listReplayAuditLogs(dependencies.db, {
      actions: ["review.requeue"],
      resourceType: "review_run",
      resourceId: reviewRunId,
    }),
  ]);

  const stageEvents = stageRows.map(toReviewStageEventDebugSummary);
  const reviewFailure = failureFromUnknown({
    source: "review_run",
    fallbackCode: "review_run.failed",
    fallbackMessage: `Review run ${reviewRunId} failed.`,
    rowId: reviewRunId,
    occurredAt: reviewRun.completedAt,
    error: reviewRun.error,
  });
  const llmCallSummaries = llmRows.map(toLlmCallDebugSummary);
  const failures = collectFailures([
    reviewRun.status === "failed" ? reviewFailure : undefined,
    ...stageEvents.map((stageEvent) => stageEvent.failure),
    ...relatedJobs.map((job) => job.failure),
    ...llmCallSummaries.map((llmCall) => llmCall.failure),
  ]);

  return {
    reviewRun,
    ...(snapshotRows[0] ? { snapshot: toPullRequestSnapshotDebugSummary(snapshotRows[0]) } : {}),
    stageEvents,
    dependencies: dependencyRows.map(toReviewDependencyDebugSummary),
    artifacts: artifactRows.map(toReviewArtifactDebugSummary),
    candidateFindings: candidateRows.map(toCandidateFindingDebugSummary),
    validatedFindings: validatedRows.map(toValidatedFindingDebugSummary),
    llmCalls: llmCallSummaries,
    relatedJobs,
    replayAudits,
    failures,
  };
}

/** Creates a replay plan for rerunning a persisted review input through the review worker. */
export async function createReviewReplayPlan(
  reviewRunId: string,
  dependencies: AdminDebugServiceDependencies,
): Promise<ReviewReplayPlan> {
  const details = await getReviewDebugDetails(reviewRunId, dependencies);
  const payload: ReviewPullRequestJobPayload = {
    repoId: details.reviewRun.repoId,
    installationId: snapshotInstallationId(details.snapshot),
    pullRequestNumber: details.reviewRun.pullRequestNumber,
    baseSha: details.reviewRun.baseSha,
    headSha: details.reviewRun.headSha,
    trigger: details.reviewRun.trigger,
  };
  const confirmationSeed = {
    action: "review.requeue",
    reviewRunId,
    payload,
    currentStatus: details.reviewRun.status,
    failureCodes: details.failures.map((failure) => failure.code),
  };
  const confirmationToken = hashJson(confirmationSeed);
  const jobKey = `admin:review:${reviewRunId}:${confirmationToken.slice("sha256:".length, 18)}`;
  const job = replayJobFromPayload({
    source: "operator_replay",
    queueName: QUEUE_NAMES.review,
    jobType: JOB_TYPES.ReviewPullRequest,
    replayJobKey: jobKey,
    payload,
    reviewRunId,
    repoId: payload.repoId,
    createdAt: details.reviewRun.createdAt,
  });

  return {
    action: "review.requeue",
    reviewRunId,
    queueName: QUEUE_NAMES.review,
    jobKey,
    job,
    payload,
    currentStatus: details.reviewRun.status,
    relatedJobs: details.relatedJobs,
    failures: details.failures,
    confirmationToken,
    requiresExplicitConfirmation: true,
  };
}

/** Executes a confirmed review replay plan by inserting a durable review job. */
export async function executeReviewReplay(
  reviewRunId: string,
  confirmationToken: string,
  dependencies: AdminDebugServiceDependencies,
  actor: AdminReplayAuditActor,
): Promise<AdminReplayExecutionResult> {
  const plan = await createReviewReplayPlan(reviewRunId, dependencies);
  assertConfirmationToken(confirmationToken, plan.confirmationToken);
  return insertReplayJobs({
    db: dependencies.db,
    action: plan.action,
    confirmationToken,
    jobs: [plan.job],
    audit: {
      actor,
      resourceType: "review_run",
      resourceId: reviewRunId,
      orgId: plan.job.orgId,
      plan: auditPlanFromReviewReplayPlan(plan),
    },
  });
}

/** Gets publisher state, reconciliation, related jobs, and normalized failures. */
export async function getPublisherDebugDetails(
  reviewRunId: string,
  dependencies: AdminDebugServiceDependencies,
): Promise<AdminPublisherDebugDetails> {
  const reviewRepository = new ReviewRepository(dependencies.db);
  const reviewRun = await reviewRepository.getReviewRun(reviewRunId);
  if (!reviewRun) {
    throw new AdminDebugNotFoundError("review_run", reviewRunId);
  }

  const publishRunRows = await dependencies.db
    .select()
    .from(publishRuns)
    .where(eq(publishRuns.reviewRunId, reviewRunId))
    .orderBy(desc(publishRuns.createdAt));
  const publishRunIds = publishRunRows.map((publishRun) => publishRun.publishRunId);
  const [
    operationRows,
    checkRunRows,
    reviewRows,
    summaryCommentRows,
    findingRows,
    relatedJobs,
    replayAudits,
  ] = await Promise.all([
    listPublishOperations(dependencies.db, publishRunIds),
    listPublishedCheckRuns(dependencies.db, publishRunIds),
    listPublishedReviews(dependencies.db, publishRunIds),
    listPublishedSummaryComments(dependencies.db, publishRunIds),
    dependencies.db
      .select()
      .from(publishedFindings)
      .where(eq(publishedFindings.reviewRunId, reviewRunId)),
    dependencies.db
      .select()
      .from(backgroundJobs)
      .where(
        and(
          eq(backgroundJobs.reviewRunId, reviewRunId),
          eq(backgroundJobs.jobType, JOB_TYPES.PublishReview),
        ),
      )
      .orderBy(desc(backgroundJobs.createdAt)),
    listReplayAuditLogs(dependencies.db, {
      actions: ["publish.review"],
      resourceType: "review_run",
      resourceId: reviewRunId,
    }),
  ]);

  const publishRunSummaries = publishRunRows.map(toPublishRunDebugSummary);
  const operationSummaries = operationRows.map(toPublishOperationDebugSummary);
  const jobSummaries = relatedJobs.map(toBackgroundJobDebugSummary);
  const findingFailures = findingRows.flatMap((finding) => {
    const failure = failureFromUnknown({
      source: "published_finding",
      fallbackCode: "published_finding.failed",
      fallbackMessage: `Published finding ${finding.findingId} failed.`,
      rowId: finding.findingId,
      error: finding.error,
      occurredAt: toIso(finding.publishedAt),
    });

    return finding.status === "failed" ? [failure] : [];
  });
  const reconciliation = await reconcilePublisherRun(reviewRunId, dependencies);
  const failures = collectFailures([
    ...publishRunSummaries.map((publishRun) => publishRun.failure),
    ...operationSummaries.map((operation) => operation.failure),
    ...jobSummaries.map((job) => job.failure),
    ...findingFailures,
  ]);

  return {
    reviewRunId,
    repoId: reviewRun.repoId,
    publishRuns: publishRunSummaries,
    operations: operationSummaries,
    outputs: {
      checkRuns: checkRunRows.map(toPublishedCheckRunDebugOutput),
      reviews: reviewRows.map(toPublishedReviewDebugOutput),
      summaryComments: summaryCommentRows.map(toPublishedSummaryCommentDebugOutput),
      findings: findingRows.map(toPublishedFindingDebugOutput),
    },
    relatedJobs: jobSummaries,
    replayAudits,
    reconciliation,
    failures,
  };
}

/** Publisher replay action that an operator can dispatch after reviewing the plan. */
export type PublisherReplayAction = "publish.review";

/** Summary of comments that the publisher would create or update. */
export type PublisherDryRunCommentPlan = {
  /** Number of inline review comments that are eligible for GitHub review publishing. */
  readonly inlineCommentCount: number;
  /** Number of findings that need the summary-comment fallback. */
  readonly summaryFallbackCount: number;
  /** Stable hash of the rendered fallback body, when a fallback comment is needed. */
  readonly summaryFallbackBodyHash?: `sha256:${string}`;
};

/** Non-mutating publisher plan for a completed review run. */
export type PublisherDryRunPlan = {
  /** Review run that the plan describes. */
  readonly reviewRunId: string;
  /** Repository that owns the review run. */
  readonly repoId: string;
  /** Pull request number that owns the review run. */
  readonly pullRequestNumber: number;
  /** Head SHA that the publisher must re-check before live publishing. */
  readonly headSha: string;
  /** Total publishable findings. */
  readonly findingCount: number;
  /** Check-run conclusion that live publishing would request. */
  readonly checkRunConclusion: "success" | "neutral";
  /** Stable hash of the rendered check-run summary. */
  readonly checkRunSummaryHash: `sha256:${string}`;
  /** Planned comment outputs. */
  readonly comments: PublisherDryRunCommentPlan;
  /** Whether this dry run performed any external or database mutation. */
  readonly mutatesExternalState: false;
};

/** One reconciliation issue found in durable publisher state. */
export type PublisherReconciliationIssue = {
  /** Machine-readable issue code. */
  readonly code:
    | "publish_run_missing"
    | "check_run_missing"
    | "published_finding_missing"
    | "operation_failed"
    | "operation_still_running";
  /** Human-readable issue description for operator output. */
  readonly message: string;
  /** Related database row ID when available. */
  readonly rowId?: string;
};

/** Reconciliation summary for one review run's publish state. */
export type PublisherReconciliationReport = {
  /** Review run that was reconciled. */
  readonly reviewRunId: string;
  /** Durable publish run ID, when one exists. */
  readonly publishRunId?: string;
  /** Stored publish-run status, or missing when no row exists. */
  readonly status: string;
  /** Number of publish operations recorded for the run. */
  readonly operationCount: number;
  /** Number of persisted check-run rows for the run. */
  readonly checkRunCount: number;
  /** Number of persisted review rows for the run. */
  readonly reviewCount: number;
  /** Number of persisted summary-comment rows for the run. */
  readonly summaryCommentCount: number;
  /** Number of persisted finding rows for the run. */
  readonly publishedFindingCount: number;
  /** Issues that require operator attention. */
  readonly issues: readonly PublisherReconciliationIssue[];
};

/** Safe replay plan for an operator-initiated publisher run. */
export type PublisherReplayPlan = {
  /** Action that a worker or CLI can dispatch after confirmation. */
  readonly action: PublisherReplayAction;
  /** Queue that should receive the replay job. */
  readonly queueName: QueueName;
  /** New replay idempotency key. */
  readonly jobKey: string;
  /** Replay job that can be inserted after confirmation. */
  readonly job: AdminReplayJobPlan;
  /** Job payload to dispatch. */
  readonly payload: PublishReviewJobPayload;
  /** Dry-run output that the operator should inspect before dispatch. */
  readonly dryRun: PublisherDryRunPlan;
  /** Reconciliation output that explains current persisted state. */
  readonly reconciliation: PublisherReconciliationReport;
  /** Confirmation token derived from the dry-run and reconciliation state. */
  readonly confirmationToken: string;
  /** Whether dispatching this plan can mutate GitHub state. */
  readonly requiresExplicitConfirmation: true;
};

/** Dependencies for operational publisher controls. */
export type PublisherOperationsDependencies = {
  /** Database used to read review output and publisher state. */
  readonly db: HeimdallDatabase;
};

/** Renders the publisher output plan without writing to GitHub or publisher tables. */
export async function renderPublisherDryRun(
  reviewRunId: string,
  dependencies: PublisherOperationsDependencies,
): Promise<PublisherDryRunPlan> {
  const reviewRepository = new ReviewRepository(dependencies.db);
  const reviewRun = await reviewRepository.getReviewRun(reviewRunId);
  if (!reviewRun) {
    throw new Error(`Review run ${reviewRunId} was not found.`);
  }
  if (reviewRun.status !== "completed") {
    throw new Error(`Review run ${reviewRunId} is not complete.`);
  }

  const findings = (await reviewRepository.listValidatedFindings(reviewRunId)).filter(
    (finding) => finding.decision === "publish",
  );
  const inlineComments = findings.filter((finding) => finding.location.isInDiff !== false);
  const fallbackFindings = findings.filter((finding) => finding.location.isInDiff === false);
  const fallbackBody =
    fallbackFindings.length === 0 ? undefined : renderFallbackSummary(fallbackFindings);

  return {
    reviewRunId,
    repoId: reviewRun.repoId,
    pullRequestNumber: reviewRun.pullRequestNumber,
    headSha: reviewRun.headSha,
    findingCount: findings.length,
    checkRunConclusion: findings.length === 0 ? "success" : "neutral",
    checkRunSummaryHash: hashJson(renderSummary(findings)),
    comments: {
      inlineCommentCount: inlineComments.length,
      summaryFallbackCount: fallbackFindings.length,
      ...(fallbackBody ? { summaryFallbackBodyHash: hashJson(fallbackBody) } : {}),
    },
    mutatesExternalState: false,
  };
}

/** Reconciles durable publisher rows for a review run without mutating external state. */
export async function reconcilePublisherRun(
  reviewRunId: string,
  dependencies: PublisherOperationsDependencies,
): Promise<PublisherReconciliationReport> {
  const reviewRepository = new ReviewRepository(dependencies.db);
  const reviewRun = await reviewRepository.getReviewRun(reviewRunId);
  if (!reviewRun) {
    throw new Error(`Review run ${reviewRunId} was not found.`);
  }
  const findings = (await reviewRepository.listValidatedFindings(reviewRunId)).filter(
    (finding) => finding.decision === "publish",
  );
  const [publishRun] = await dependencies.db
    .select()
    .from(publishRuns)
    .where(eq(publishRuns.reviewRunId, reviewRunId));

  if (!publishRun) {
    return {
      reviewRunId,
      status: "missing",
      operationCount: 0,
      checkRunCount: 0,
      reviewCount: 0,
      summaryCommentCount: 0,
      publishedFindingCount: 0,
      issues: [
        {
          code: "publish_run_missing",
          message: `Review run ${reviewRunId} has no durable publish run.`,
        },
      ],
    };
  }

  const [operations, checkRuns, reviews, summaryComments, publishedFindingRows] = await Promise.all(
    [
      dependencies.db
        .select()
        .from(publishOperations)
        .where(eq(publishOperations.publishRunId, publishRun.publishRunId)),
      dependencies.db
        .select()
        .from(publishedCheckRuns)
        .where(eq(publishedCheckRuns.publishRunId, publishRun.publishRunId)),
      dependencies.db
        .select()
        .from(publishedReviews)
        .where(eq(publishedReviews.publishRunId, publishRun.publishRunId)),
      dependencies.db
        .select()
        .from(publishedSummaryComments)
        .where(eq(publishedSummaryComments.publishRunId, publishRun.publishRunId)),
      dependencies.db
        .select()
        .from(publishedFindings)
        .where(
          and(
            eq(publishedFindings.reviewRunId, reviewRunId),
            eq(publishedFindings.provider, "github"),
          ),
        ),
    ],
  );

  const issues: PublisherReconciliationIssue[] = [];
  if (publishRun.status === "completed" && checkRuns.length === 0) {
    issues.push({
      code: "check_run_missing",
      message: `Completed publish run ${publishRun.publishRunId} has no check-run row.`,
      rowId: publishRun.publishRunId,
    });
  }
  if (publishRun.status === "completed" && publishedFindingRows.length < findings.length) {
    issues.push({
      code: "published_finding_missing",
      message: `Completed publish run ${publishRun.publishRunId} has ${publishedFindingRows.length} of ${findings.length} published finding row(s).`,
      rowId: publishRun.publishRunId,
    });
  }
  for (const operation of operations) {
    if (operation.status === "failed") {
      issues.push({
        code: "operation_failed",
        message: `Publish operation ${operation.operationType} failed.`,
        rowId: operation.publishOperationId,
      });
    }
    if (operation.status === "running") {
      issues.push({
        code: "operation_still_running",
        message: `Publish operation ${operation.operationType} is still marked running.`,
        rowId: operation.publishOperationId,
      });
    }
  }

  return {
    reviewRunId,
    publishRunId: publishRun.publishRunId,
    status: publishRun.status,
    operationCount: operations.length,
    checkRunCount: checkRuns.length,
    reviewCount: reviews.length,
    summaryCommentCount: summaryComments.length,
    publishedFindingCount: publishedFindingRows.length,
    issues,
  };
}

/** Creates an explicit replay plan for re-dispatching publisher output. */
export async function createPublisherReplayPlan(
  reviewRunId: string,
  dependencies: PublisherOperationsDependencies,
): Promise<PublisherReplayPlan> {
  const dryRun = await renderPublisherDryRun(reviewRunId, dependencies);
  const reconciliation = await reconcilePublisherRun(reviewRunId, dependencies);
  const reviewRepository = new ReviewRepository(dependencies.db);
  const reviewRun = await reviewRepository.getReviewRun(reviewRunId);
  if (!reviewRun) {
    throw new Error(`Review run ${reviewRunId} was not found.`);
  }
  const payload = {
    reviewRunId,
    repoId: dryRun.repoId,
    pullRequestNumber: dryRun.pullRequestNumber,
  };
  const confirmationToken = hashJson({
    action: "publish.review",
    payload,
    dryRun,
    reconciliationStatus: reconciliation.status,
    reconciliationIssues: reconciliation.issues.map((issue) => issue.code),
  });
  const jobKey = `admin:publisher:${reviewRunId}:${confirmationToken.slice("sha256:".length, 18)}`;
  const job = replayJobFromPayload({
    source: "operator_replay",
    queueName: QUEUE_NAMES.publishing,
    jobType: JOB_TYPES.PublishReview,
    replayJobKey: jobKey,
    payload,
    reviewRunId,
    repoId: payload.repoId,
    createdAt: reviewRun.createdAt,
  });

  return {
    action: "publish.review",
    queueName: QUEUE_NAMES.publishing,
    jobKey,
    job,
    payload,
    dryRun,
    reconciliation,
    confirmationToken,
    requiresExplicitConfirmation: true,
  };
}

/** Executes a confirmed publisher replay plan by inserting a durable publish job. */
export async function executePublisherReplay(
  reviewRunId: string,
  confirmationToken: string,
  dependencies: PublisherOperationsDependencies,
  actor: AdminReplayAuditActor,
): Promise<AdminReplayExecutionResult> {
  const plan = await createPublisherReplayPlan(reviewRunId, dependencies);
  assertConfirmationToken(confirmationToken, plan.confirmationToken);
  return insertReplayJobs({
    db: dependencies.db,
    action: plan.action,
    confirmationToken,
    jobs: [plan.job],
    audit: {
      actor,
      resourceType: "review_run",
      resourceId: reviewRunId,
      orgId: plan.job.orgId,
      plan: auditPlanFromPublisherReplayPlan(plan),
    },
  });
}

type WebhookEventRow = typeof webhookEvents.$inferSelect;
type BackgroundJobRow = typeof backgroundJobs.$inferSelect;
type AuditLogRow = typeof auditLogs.$inferSelect;
type PullRequestSnapshotRow = typeof pullRequestSnapshots.$inferSelect;
type ReviewStageEventRow = typeof reviewRunStageEvents.$inferSelect;
type ReviewDependencyRow = typeof reviewRunDependencies.$inferSelect;
type ReviewArtifactRow = typeof reviewArtifacts.$inferSelect;
type CandidateFindingRow = typeof candidateFindings.$inferSelect;
type ValidatedFindingRow = typeof validatedFindings.$inferSelect;
type LlmCallRow = typeof llmCalls.$inferSelect;
type PublishRunRow = typeof publishRuns.$inferSelect;
type PublishOperationRow = typeof publishOperations.$inferSelect;
type PublishedCheckRunRow = typeof publishedCheckRuns.$inferSelect;
type PublishedReviewRow = typeof publishedReviews.$inferSelect;
type PublishedSummaryCommentRow = typeof publishedSummaryComments.$inferSelect;
type PublishedFindingRow = typeof publishedFindings.$inferSelect;
type HeimdallTransaction = Parameters<Parameters<HeimdallDatabase["transaction"]>[0]>[0];
type HeimdallDbExecutor = HeimdallDatabase | HeimdallTransaction;

type DerivedWebhookReplayJob = {
  /** Queue that owned the original planned webhook job. */
  readonly queueName: QueueName;
  /** Handler type for the original planned webhook job. */
  readonly jobType: string;
  /** Original idempotency key that the webhook should have produced. */
  readonly originalJobKey: string;
  /** Payload that should be replayed. */
  readonly payload: JobPayload;
  /** Organization associated with the job when available. */
  readonly orgId?: string;
  /** Repository associated with the job when available. */
  readonly repoId?: string;
  /** Stable timestamp used in the replay envelope. */
  readonly createdAt: string;
};

type ReplayAuditInput = {
  /** Actor that confirmed the replay operation. */
  readonly actor: AdminReplayAuditActor;
  /** Resource type affected by the replay. */
  readonly resourceType: AdminDebugResourceType;
  /** Resource ID affected by the replay. */
  readonly resourceId: string;
  /** Organization associated with the replay when available. */
  readonly orgId?: string | undefined;
  /** Replay plan summary that was confirmed. */
  readonly plan: Record<string, unknown>;
};

async function getWebhookEventRow(
  webhookEventId: string,
  db: HeimdallDatabase,
): Promise<WebhookEventRow> {
  const [row] = await db
    .select()
    .from(webhookEvents)
    .where(eq(webhookEvents.webhookEventId, webhookEventId))
    .limit(1);

  if (!row) {
    throw new AdminDebugNotFoundError("webhook_event", webhookEventId);
  }

  return row;
}

async function listJobsByKeys(
  db: HeimdallDbExecutor,
  jobKeys: readonly string[],
): Promise<readonly AdminBackgroundJobDebugSummary[]> {
  if (jobKeys.length === 0) {
    return [];
  }

  const rows = await db
    .select()
    .from(backgroundJobs)
    .where(inArray(backgroundJobs.jobKey, [...jobKeys]))
    .orderBy(asc(backgroundJobs.createdAt));

  return rows.map(toBackgroundJobDebugSummary);
}

async function listReplayAuditLogs(
  db: HeimdallDatabase,
  input: {
    readonly actions: readonly (WebhookReplayAction | ReviewReplayAction | PublisherReplayAction)[];
    readonly resourceType: AdminDebugResourceType;
    readonly resourceId: string;
  },
): Promise<readonly AdminReplayAuditSummary[]> {
  if (input.actions.length === 0) {
    return [];
  }

  const rows = await db
    .select()
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.resourceType, input.resourceType),
        eq(auditLogs.resourceId, input.resourceId),
        inArray(auditLogs.action, [...input.actions]),
      ),
    )
    .orderBy(desc(auditLogs.occurredAt));

  return rows.map(toReplayAuditSummary);
}

async function listRelatedReviewJobs(
  db: HeimdallDatabase,
  input: {
    readonly reviewRunId: string;
    readonly repoId: string;
    readonly pullRequestNumber: number;
    readonly headSha: string;
  },
): Promise<readonly AdminBackgroundJobDebugSummary[]> {
  const reviewJobKey = `github:review:${input.repoId}:${input.pullRequestNumber}:${input.headSha}`;
  const rows = await db
    .select()
    .from(backgroundJobs)
    .where(
      or(
        eq(backgroundJobs.reviewRunId, input.reviewRunId),
        and(
          eq(backgroundJobs.jobType, JOB_TYPES.ReviewPullRequest),
          eq(backgroundJobs.jobKey, reviewJobKey),
        ),
      ),
    )
    .orderBy(asc(backgroundJobs.createdAt));

  return rows.map(toBackgroundJobDebugSummary);
}

async function listPublishOperations(
  db: HeimdallDatabase,
  publishRunIds: readonly string[],
): Promise<readonly (typeof publishOperations.$inferSelect)[]> {
  if (publishRunIds.length === 0) {
    return [];
  }

  return db
    .select()
    .from(publishOperations)
    .where(inArray(publishOperations.publishRunId, [...publishRunIds]))
    .orderBy(asc(publishOperations.createdAt));
}

async function listPublishedCheckRuns(
  db: HeimdallDatabase,
  publishRunIds: readonly string[],
): Promise<readonly (typeof publishedCheckRuns.$inferSelect)[]> {
  if (publishRunIds.length === 0) {
    return [];
  }

  return db
    .select()
    .from(publishedCheckRuns)
    .where(inArray(publishedCheckRuns.publishRunId, [...publishRunIds]))
    .orderBy(asc(publishedCheckRuns.createdAt));
}

async function listPublishedReviews(
  db: HeimdallDatabase,
  publishRunIds: readonly string[],
): Promise<readonly (typeof publishedReviews.$inferSelect)[]> {
  if (publishRunIds.length === 0) {
    return [];
  }

  return db
    .select()
    .from(publishedReviews)
    .where(inArray(publishedReviews.publishRunId, [...publishRunIds]))
    .orderBy(asc(publishedReviews.createdAt));
}

async function listPublishedSummaryComments(
  db: HeimdallDatabase,
  publishRunIds: readonly string[],
): Promise<readonly (typeof publishedSummaryComments.$inferSelect)[]> {
  if (publishRunIds.length === 0) {
    return [];
  }

  return db
    .select()
    .from(publishedSummaryComments)
    .where(inArray(publishedSummaryComments.publishRunId, [...publishRunIds]))
    .orderBy(asc(publishedSummaryComments.createdAt));
}

function toWebhookDebugSummary(row: WebhookEventRow): AdminWebhookEventDebugSummary {
  const failure = failureFromUnknown({
    source: "webhook_event",
    fallbackCode: "webhook_event.failed",
    fallbackMessage: `Webhook delivery ${row.deliveryId} failed.`,
    rowId: row.webhookEventId,
    occurredAt: row.processedAt ? toIso(row.processedAt) : toIso(row.receivedAt),
    error: row.error,
  });

  return {
    webhookEventId: row.webhookEventId,
    provider: row.provider,
    deliveryId: row.deliveryId,
    eventName: row.eventName,
    ...(row.action ? { action: row.action } : {}),
    ...(row.installationId ? { installationId: row.installationId } : {}),
    ...(row.orgId ? { orgId: row.orgId } : {}),
    ...(row.repoId ? { repoId: row.repoId } : {}),
    status: row.status,
    payloadHash: row.payloadHash,
    hasStoredPayload: row.payload !== null,
    receivedAt: toIso(row.receivedAt),
    ...(row.processedAt ? { processedAt: toIso(row.processedAt) } : {}),
    ...(row.status === "failed" ? { failure } : {}),
  };
}

function toBackgroundJobDebugSummary(row: BackgroundJobRow): AdminBackgroundJobDebugSummary {
  const failure = failureFromUnknown({
    source: "background_job",
    fallbackCode: "background_job.failed",
    fallbackMessage: `Background job ${row.jobType}:${row.jobKey} failed.`,
    rowId: row.backgroundJobId,
    occurredAt: row.completedAt ? toIso(row.completedAt) : toIso(row.updatedAt),
    error: row.error,
  });

  return {
    backgroundJobId: row.backgroundJobId,
    queueName: row.queueName,
    jobKey: row.jobKey,
    jobType: row.jobType,
    status: row.status,
    ...(row.orgId ? { orgId: row.orgId } : {}),
    ...(row.repoId ? { repoId: row.repoId } : {}),
    ...(row.reviewRunId ? { reviewRunId: row.reviewRunId } : {}),
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    ...(row.scheduledAt ? { scheduledAt: toIso(row.scheduledAt) } : {}),
    ...(row.startedAt ? { startedAt: toIso(row.startedAt) } : {}),
    ...(row.completedAt ? { completedAt: toIso(row.completedAt) } : {}),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
    payload: row.payload,
    ...(row.status === "failed" || row.status === "dead_lettered" ? { failure } : {}),
  };
}

function toReplayAuditSummary(row: AuditLogRow): AdminReplayAuditSummary {
  return {
    auditLogId: row.auditLogId,
    ...(row.orgId ? { orgId: row.orgId } : {}),
    actorType: row.actorType,
    ...(row.actorUserId ? { actorUserId: row.actorUserId } : {}),
    action: row.action,
    resourceType: row.resourceType,
    ...(row.resourceId ? { resourceId: row.resourceId } : {}),
    occurredAt: toIso(row.occurredAt),
    ...(row.metadata !== null ? { metadata: row.metadata } : {}),
  };
}

function toReviewStageEventDebugSummary(
  row: ReviewStageEventRow,
): AdminReviewStageEventDebugSummary {
  const failure = failureFromUnknown({
    source: "review_stage_event",
    fallbackCode: "review_stage.failed",
    fallbackMessage: row.message ?? `Review stage ${row.stage} failed.`,
    rowId: row.reviewRunStageEventId,
    occurredAt: toIso(row.occurredAt),
    error: {
      message: row.message ?? `Review stage ${row.stage} failed.`,
      details: row.metadata,
    },
  });

  return {
    reviewRunStageEventId: row.reviewRunStageEventId,
    stage: row.stage,
    status: row.status,
    ...(row.message ? { message: row.message } : {}),
    occurredAt: toIso(row.occurredAt),
    ...(row.metadata !== null ? { metadata: row.metadata } : {}),
    ...(row.status === "failed" ? { failure } : {}),
  };
}

function toReviewDependencyDebugSummary(
  row: ReviewDependencyRow,
): AdminReviewDependencyDebugSummary {
  return {
    reviewRunId: row.reviewRunId,
    dependencyType: row.dependencyType,
    dependencyId: row.dependencyId,
    ...(row.metadata !== null ? { metadata: row.metadata } : {}),
  };
}

function toPullRequestSnapshotDebugSummary(
  row: PullRequestSnapshotRow,
): AdminPullRequestSnapshotDebugSummary {
  return {
    snapshotId: row.snapshotId,
    provider: row.provider,
    repoId: row.repoId,
    installationId: row.installationId,
    pullRequestNumber: row.pullRequestNumber,
    title: row.title,
    authorLogin: row.authorLogin,
    state: row.state,
    isDraft: row.isDraft,
    baseRef: row.baseRef,
    baseSha: row.baseSha,
    headRef: row.headRef,
    headSha: row.headSha,
    diffHash: row.diffHash,
    additions: row.additions,
    deletions: row.deletions,
    changedFileCount: row.changedFileCount,
    changedFiles: changedFileSummaries(row.changedFiles),
    fetchedAt: toIso(row.fetchedAt),
  };
}

function toReviewArtifactDebugSummary(row: ReviewArtifactRow): AdminReviewArtifactDebugSummary {
  const metadata = asRecord(row.metadata);

  return {
    reviewArtifactId: row.reviewArtifactId,
    kind: row.kind,
    name: row.name,
    uri: row.uri,
    hash: row.hash,
    sizeBytes: row.sizeBytes,
    classification: row.classification,
    createdAt: toIso(row.createdAt),
    hasStoredPayload: metadata?.payload !== undefined,
    metadataKeys: metadata ? Object.keys(metadata).sort() : [],
  };
}

function toCandidateFindingDebugSummary(
  row: CandidateFindingRow,
): AdminCandidateFindingDebugSummary {
  return {
    findingId: row.findingId,
    source: row.source,
    sourceName: row.sourceName,
    category: row.category,
    severity: row.severity,
    title: row.title,
    location: row.location,
    confidence: row.confidence,
    fingerprint: row.fingerprint,
    createdAt: toIso(row.createdAt),
  };
}

function toValidatedFindingDebugSummary(
  row: ValidatedFindingRow,
): AdminValidatedFindingDebugSummary {
  return {
    findingId: row.findingId,
    candidateFindingId: row.candidateFindingId,
    decision: row.decision,
    category: row.category,
    severity: row.severity,
    title: row.title,
    location: row.location,
    ...(row.rank !== null ? { rank: row.rank } : {}),
    fingerprint: row.fingerprint,
    validation: row.validation,
  };
}

function toLlmCallDebugSummary(row: LlmCallRow): AdminLlmCallDebugSummary {
  const failure = failureFromUnknown({
    source: "llm_call",
    fallbackCode: "llm_call.failed",
    fallbackMessage: `LLM call ${row.llmCallId} failed.`,
    rowId: row.llmCallId,
    occurredAt: row.completedAt ? toIso(row.completedAt) : toIso(row.startedAt),
    error: row.error,
  });

  return {
    llmCallId: row.llmCallId,
    provider: row.provider,
    model: row.model,
    purpose: row.purpose,
    status: row.status,
    promptHash: row.promptHash,
    ...(row.responseHash ? { responseHash: row.responseHash } : {}),
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    costMicros: row.costMicros,
    startedAt: toIso(row.startedAt),
    ...(row.completedAt ? { completedAt: toIso(row.completedAt) } : {}),
    ...(row.status === "failed" ? { failure } : {}),
  };
}

function toPublishRunDebugSummary(row: PublishRunRow): AdminPublishRunDebugSummary {
  const failure = failureFromUnknown({
    source: "publish_run",
    fallbackCode: "publish_run.failed",
    fallbackMessage: `Publish run ${row.publishRunId} failed.`,
    rowId: row.publishRunId,
    occurredAt: row.completedAt ? toIso(row.completedAt) : toIso(row.createdAt),
    error: row.error,
  });

  return {
    publishRunId: row.publishRunId,
    reviewRunId: row.reviewRunId,
    repoId: row.repoId,
    idempotencyKey: row.idempotencyKey,
    status: row.status,
    ...(row.startedAt ? { startedAt: toIso(row.startedAt) } : {}),
    ...(row.completedAt ? { completedAt: toIso(row.completedAt) } : {}),
    createdAt: toIso(row.createdAt),
    ...(row.metadata !== null ? { metadata: row.metadata } : {}),
    ...(row.status === "failed" ? { failure } : {}),
  };
}

function toPublishOperationDebugSummary(
  row: PublishOperationRow,
): AdminPublishOperationDebugSummary {
  const failure = failureFromUnknown({
    source: "publish_operation",
    fallbackCode: "publish_operation.failed",
    fallbackMessage: `Publish operation ${row.operationType} failed.`,
    rowId: row.publishOperationId,
    occurredAt: toIso(row.createdAt),
    error: row.error,
  });

  return {
    publishOperationId: row.publishOperationId,
    publishRunId: row.publishRunId,
    operationType: row.operationType,
    status: row.status,
    ...(row.requestHash ? { requestHash: row.requestHash } : {}),
    ...(row.responseHash ? { responseHash: row.responseHash } : {}),
    createdAt: toIso(row.createdAt),
    ...(row.status === "failed" ? { failure } : {}),
  };
}

function toPublishedCheckRunDebugOutput(row: PublishedCheckRunRow): Record<string, unknown> {
  return {
    publishedCheckRunId: row.publishedCheckRunId,
    publishRunId: row.publishRunId,
    reviewRunId: row.reviewRunId,
    provider: row.provider,
    providerCheckRunId: row.providerCheckRunId,
    status: row.status,
    conclusion: row.conclusion,
    metadata: row.metadata,
    createdAt: toIso(row.createdAt),
  };
}

function toPublishedReviewDebugOutput(row: PublishedReviewRow): Record<string, unknown> {
  return {
    publishedReviewId: row.publishedReviewId,
    publishRunId: row.publishRunId,
    reviewRunId: row.reviewRunId,
    provider: row.provider,
    providerReviewId: row.providerReviewId,
    status: row.status,
    metadata: row.metadata,
    createdAt: toIso(row.createdAt),
  };
}

function toPublishedSummaryCommentDebugOutput(
  row: PublishedSummaryCommentRow,
): Record<string, unknown> {
  return {
    publishedSummaryCommentId: row.publishedSummaryCommentId,
    publishRunId: row.publishRunId,
    reviewRunId: row.reviewRunId,
    provider: row.provider,
    providerCommentId: row.providerCommentId,
    bodyHash: row.bodyHash,
    status: row.status,
    metadata: row.metadata,
    createdAt: toIso(row.createdAt),
  };
}

function toPublishedFindingDebugOutput(row: PublishedFindingRow): Record<string, unknown> {
  const failure = failureFromUnknown({
    source: "published_finding",
    fallbackCode: "published_finding.failed",
    fallbackMessage: `Published finding ${row.findingId} failed.`,
    rowId: row.findingId,
    error: row.error,
    occurredAt: toIso(row.publishedAt),
  });

  return {
    findingId: row.findingId,
    validatedFindingId: row.validatedFindingId,
    reviewRunId: row.reviewRunId,
    provider: row.provider,
    providerCommentId: row.providerCommentId,
    providerReviewId: row.providerReviewId,
    providerCheckRunId: row.providerCheckRunId,
    location: row.location,
    title: row.title,
    publishedAt: toIso(row.publishedAt),
    status: row.status,
    fingerprint: row.fingerprint,
    metadata: row.metadata,
    ...(row.status === "failed" ? { failure } : {}),
  };
}

function changedFileSummaries(
  value: unknown,
): readonly { readonly path: string; readonly status?: string }[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    const record = asRecord(entry);
    const path = stringField(record, "path");
    const status = stringField(record, "status");
    if (!path) {
      return [];
    }

    return [
      {
        path,
        ...(status ? { status } : {}),
      },
    ];
  });
}

function failureFromUnknown(input: {
  readonly source: AdminFailureSource;
  readonly fallbackCode: string;
  readonly fallbackMessage: string;
  readonly rowId?: string | undefined;
  readonly occurredAt?: string | undefined;
  readonly error: unknown;
}): AdminFailureDetail {
  const errorRecord = asRecord(input.error);
  const detailsRecord = errorRecord ? asRecord(errorRecord.details) : undefined;
  const retryable = booleanField(errorRecord, "retryable");
  const detailEntries = errorRecord
    ? Object.entries(errorRecord).filter(
        ([key]) => !["code", "message", "retryable", "details"].includes(key),
      )
    : [];
  const fallbackDetails = detailEntries.length > 0 ? Object.fromEntries(detailEntries) : undefined;
  const details = detailsRecord ?? fallbackDetails;

  return {
    source: input.source,
    code: stringField(errorRecord, "code") ?? input.fallbackCode,
    message: stringField(errorRecord, "message") ?? input.fallbackMessage,
    ...(retryable !== undefined ? { retryable } : {}),
    ...(input.rowId ? { rowId: input.rowId } : {}),
    ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
    ...(details !== undefined ? { details } : {}),
  };
}

function collectFailures(
  values: readonly (AdminFailureDetail | undefined)[],
): readonly AdminFailureDetail[] {
  return values.filter((value): value is AdminFailureDetail => value !== undefined);
}

function firstDefined<T>(values: readonly (T | undefined)[]): T | undefined {
  return values.find((value): value is T => value !== undefined);
}

function deriveWebhookJobKeys(row: WebhookEventRow): readonly string[] {
  if (row.eventName === "installation" && row.installationId && row.action) {
    return [`github:installation:${row.installationId}:${row.action}`];
  }

  if (row.eventName === "repository" && row.installationId) {
    return [`github:repository:${row.installationId}:${row.deliveryId}`];
  }

  if (row.eventName !== "pull_request" || !row.repoId) {
    return [];
  }

  const pullRequest = asRecord(asRecord(row.payload)?.pull_request);
  const pullRequestNumber = numberField(pullRequest, "number");
  const headSha = stringField(asRecord(pullRequest?.head), "sha");
  if (!pullRequestNumber || !headSha) {
    return [];
  }

  return [
    `github:index:${row.repoId}:${headSha}`,
    `github:review:${row.repoId}:${pullRequestNumber}:${headSha}`,
  ];
}

function snapshotInstallationId(snapshot: unknown): string {
  const installationId = stringField(asRecord(snapshot), "installationId");
  if (!installationId) {
    throw new Error("Review replay requires a persisted pull request snapshot installation ID.");
  }

  return installationId;
}

/** Builds replay job plans for missing jobs from the stored webhook payload. */
function deriveWebhookReplayJobs(row: WebhookEventRow): readonly DerivedWebhookReplayJob[] {
  const jobs: DerivedWebhookReplayJob[] = [];
  const createdAt = toIso(row.receivedAt);

  if (
    row.eventName === "installation" &&
    row.installationId &&
    row.action &&
    ["created", "new_permissions_accepted"].includes(row.action)
  ) {
    jobs.push({
      queueName: QUEUE_NAMES.repoSync,
      jobType: JOB_TYPES.SyncInstallation,
      originalJobKey: `github:installation:${row.installationId}:${row.action}`,
      payload: {
        installationId: row.installationId,
        provider: "github",
        reason: "installed",
      },
      ...(row.orgId ? { orgId: row.orgId } : {}),
      createdAt,
    });
  }

  if (
    row.eventName === "repository" &&
    row.installationId &&
    row.action &&
    ["created", "publicized", "privatized", "renamed"].includes(row.action)
  ) {
    jobs.push({
      queueName: QUEUE_NAMES.repoSync,
      jobType: JOB_TYPES.SyncInstallation,
      originalJobKey: `github:repository:${row.installationId}:${row.deliveryId}`,
      payload: {
        installationId: row.installationId,
        provider: "github",
        reason: "repository_added",
      },
      ...(row.orgId ? { orgId: row.orgId } : {}),
      createdAt,
    });
  }

  if (row.eventName !== "pull_request" || !row.repoId || !row.installationId) {
    return jobs;
  }

  const pullRequest = asRecord(asRecord(row.payload)?.pull_request);
  const pullRequestNumber = numberField(pullRequest, "number");
  const headSha = stringField(asRecord(pullRequest?.head), "sha");
  const baseSha = stringField(asRecord(pullRequest?.base), "sha");
  if (
    !pullRequestNumber ||
    !headSha ||
    !baseSha ||
    !["opened", "reopened", "synchronize", "ready_for_review"].includes(row.action ?? "")
  ) {
    return jobs;
  }

  jobs.push({
    queueName: QUEUE_NAMES.indexing,
    jobType: JOB_TYPES.IndexRepoCommit,
    originalJobKey: `github:index:${row.repoId}:${headSha}`,
    payload: {
      repoId: row.repoId,
      installationId: row.installationId,
      commitSha: headSha,
      priority: "high",
      reason: "pr_review",
    },
    ...(row.repoId ? { repoId: row.repoId } : {}),
    createdAt,
  });
  jobs.push({
    queueName: QUEUE_NAMES.review,
    jobType: JOB_TYPES.ReviewPullRequest,
    originalJobKey: `github:review:${row.repoId}:${pullRequestNumber}:${headSha}`,
    payload: {
      repoId: row.repoId,
      installationId: row.installationId,
      pullRequestNumber,
      baseSha,
      headSha,
      trigger: "webhook",
    },
    ...(row.repoId ? { repoId: row.repoId } : {}),
    createdAt,
  });

  return jobs;
}

/** Creates a replay job plan from an existing failed or dead-lettered durable job. */
function replayJobFromExistingJob(
  job: AdminBackgroundJobDebugSummary,
  replayScopeId: string,
): AdminReplayJobPlan {
  const envelope = parseJobEnvelope(job.payload);
  const replayJobKey = `admin:webhook:${replayScopeId}:${job.backgroundJobId}:${hashJson({
    jobType: job.jobType,
    jobKey: job.jobKey,
  }).slice("sha256:".length, 18)}`;

  return {
    source: "existing_job",
    queueName: toQueueName(job.queueName),
    jobType: job.jobType,
    originalBackgroundJobId: job.backgroundJobId,
    originalJobKey: job.jobKey,
    replayJobKey,
    envelope: makeReplayEnvelope({
      baseEnvelope: envelope,
      jobType: job.jobType,
      replayJobKey,
      createdAt: job.createdAt,
    }),
    ...(job.orgId ? { orgId: job.orgId } : {}),
    ...(job.repoId ? { repoId: job.repoId } : {}),
    ...(job.reviewRunId ? { reviewRunId: job.reviewRunId } : {}),
  };
}

/** Creates a replay job plan for a webhook job that is missing from durable state. */
function replayJobFromDerivedWebhookJob(
  job: DerivedWebhookReplayJob,
  replayScopeId: string,
): AdminReplayJobPlan {
  const replayJobKey = `admin:webhook:${replayScopeId}:missing:${hashJson({
    jobType: job.jobType,
    jobKey: job.originalJobKey,
  }).slice("sha256:".length, 18)}`;

  return {
    source: "missing_job",
    queueName: job.queueName,
    jobType: job.jobType,
    originalJobKey: job.originalJobKey,
    replayJobKey,
    envelope: replayEnvelopeFromPayload({
      jobType: job.jobType,
      replayJobKey,
      payload: job.payload,
      createdAt: job.createdAt,
    }),
    ...(job.orgId ? { orgId: job.orgId } : {}),
    ...(job.repoId ? { repoId: job.repoId } : {}),
  };
}

/** Creates an operator replay job plan from a known payload. */
function replayJobFromPayload(input: {
  /** Source state used to construct the replay job. */
  readonly source: AdminReplayJobSource;
  /** Queue that receives the replay job. */
  readonly queueName: QueueName;
  /** Handler type carried by the replay envelope. */
  readonly jobType: string;
  /** New replay idempotency key. */
  readonly replayJobKey: string;
  /** Payload to replay. */
  readonly payload: JobPayload;
  /** Stable timestamp used in the replay envelope. */
  readonly createdAt: string;
  /** Organization associated with the replay job when available. */
  readonly orgId?: string;
  /** Repository associated with the replay job when available. */
  readonly repoId?: string;
  /** Review run associated with the replay job when available. */
  readonly reviewRunId?: string;
}): AdminReplayJobPlan {
  return {
    source: input.source,
    queueName: input.queueName,
    jobType: input.jobType,
    replayJobKey: input.replayJobKey,
    envelope: replayEnvelopeFromPayload({
      jobType: input.jobType,
      replayJobKey: input.replayJobKey,
      payload: input.payload,
      createdAt: input.createdAt,
    }),
    ...(input.orgId ? { orgId: input.orgId } : {}),
    ...(input.repoId ? { repoId: input.repoId } : {}),
    ...(input.reviewRunId ? { reviewRunId: input.reviewRunId } : {}),
  };
}

/** Creates a replay envelope from an existing envelope while replacing idempotency. */
function makeReplayEnvelope(input: {
  /** Original durable job envelope. */
  readonly baseEnvelope: JobEnvelope<JobPayload>;
  /** Handler type for the replay job. */
  readonly jobType: string;
  /** New replay idempotency key. */
  readonly replayJobKey: string;
  /** Stable timestamp used in the replay envelope. */
  readonly createdAt: string;
}): JobEnvelope<JobPayload> {
  return replayEnvelopeFromPayload({
    jobType: input.jobType,
    replayJobKey: input.replayJobKey,
    payload: input.baseEnvelope.payload,
    createdAt: input.createdAt,
    maxAttempts: input.baseEnvelope.maxAttempts,
  });
}

/** Creates a contract-compatible replay envelope. */
function replayEnvelopeFromPayload(input: {
  /** Handler type for the replay job. */
  readonly jobType: string;
  /** New replay idempotency key. */
  readonly replayJobKey: string;
  /** Payload to replay. */
  readonly payload: JobPayload;
  /** Stable timestamp used in the replay envelope. */
  readonly createdAt: string;
  /** Maximum worker attempts. */
  readonly maxAttempts?: number;
}): JobEnvelope<JobPayload> {
  return {
    jobId: stableId("job", [input.replayJobKey]),
    jobType: input.jobType,
    schemaVersion: "job_envelope.v1",
    idempotencyKey: input.replayJobKey,
    createdAt: input.createdAt,
    attempt: 0,
    maxAttempts: input.maxAttempts ?? 3,
    payload: input.payload,
  };
}

/** Inserts confirmed replay jobs into the durable outbox. */
async function insertReplayJobs(input: {
  /** Database used to persist replay rows. */
  readonly db: HeimdallDatabase;
  /** Replay action that was confirmed. */
  readonly action: WebhookReplayAction | ReviewReplayAction | PublisherReplayAction;
  /** Confirmation token that authorized the replay. */
  readonly confirmationToken: string;
  /** Replay jobs to insert. */
  readonly jobs: readonly AdminReplayJobPlan[];
  /** Audit metadata to write with durable replay rows. */
  readonly audit: ReplayAuditInput;
}): Promise<AdminReplayExecutionResult> {
  return input.db.transaction(async (tx) => {
    const insertedJobIds: string[] = [];
    for (const job of input.jobs) {
      const [inserted] = await tx
        .insert(backgroundJobs)
        .values({
          backgroundJobId: newId("job"),
          queueName: job.queueName,
          jobKey: job.replayJobKey,
          jobType: job.jobType,
          status: "pending",
          orgId: job.orgId,
          repoId: job.repoId,
          reviewRunId: job.reviewRunId,
          payload: job.envelope,
          maxAttempts: job.envelope.maxAttempts,
          scheduledAt: job.envelope.scheduledFor ? new Date(job.envelope.scheduledFor) : undefined,
          metadata: {
            replay: true,
            replaySource: job.source,
            ...(job.originalBackgroundJobId
              ? { originalBackgroundJobId: job.originalBackgroundJobId }
              : {}),
            ...(job.originalJobKey ? { originalJobKey: job.originalJobKey } : {}),
            confirmationToken: input.confirmationToken,
          },
        })
        .onConflictDoNothing()
        .returning({ backgroundJobId: backgroundJobs.backgroundJobId });

      if (inserted) {
        insertedJobIds.push(inserted.backgroundJobId);
      }
    }

    const replayJobs = await listJobsByKeys(
      tx,
      input.jobs.map((job) => job.replayJobKey),
    );
    const insertedSet = new Set(insertedJobIds);
    const existingJobIds = replayJobs
      .map((job) => job.backgroundJobId)
      .filter((jobId) => !insertedSet.has(jobId));
    const auditLogId = await insertReplayAuditLog(tx, {
      ...input.audit,
      action: input.action,
      confirmationToken: input.confirmationToken,
      insertedJobIds,
      existingJobIds,
      replayJobs,
    });

    return {
      action: input.action,
      confirmationToken: input.confirmationToken,
      auditLogId,
      insertedJobIds,
      existingJobIds,
      replayJobs,
    };
  });
}

async function insertReplayAuditLog(
  db: HeimdallDbExecutor,
  input: ReplayAuditInput & {
    readonly action: WebhookReplayAction | ReviewReplayAction | PublisherReplayAction;
    readonly confirmationToken: string;
    readonly insertedJobIds: readonly string[];
    readonly existingJobIds: readonly string[];
    readonly replayJobs: readonly AdminBackgroundJobDebugSummary[];
  },
): Promise<string> {
  const auditLogId = newId("audit");
  await db.insert(auditLogs).values({
    auditLogId,
    orgId: input.orgId,
    actorType: input.actor.actorType,
    actorUserId: input.actor.actorUserId,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    occurredAt: new Date(),
    metadata: {
      actor: {
        role: input.actor.role,
        ...(input.actor.requestId ? { requestId: input.actor.requestId } : {}),
        ...(input.actor.sessionId ? { sessionId: input.actor.sessionId } : {}),
        ...(input.actor.provider ? { provider: input.actor.provider } : {}),
        ...(input.actor.permissions ? { permissions: input.actor.permissions } : {}),
        ...(input.actor.displayName ? { displayName: input.actor.displayName } : {}),
        ...(input.actor.email ? { email: input.actor.email } : {}),
      },
      ...(input.actor.requestId ? { requestId: input.actor.requestId } : {}),
      confirmationToken: input.confirmationToken,
      plan: input.plan,
      result: {
        insertedJobIds: input.insertedJobIds,
        existingJobIds: input.existingJobIds,
        replayJobIds: input.replayJobs.map((job) => job.backgroundJobId),
        replayJobKeys: input.replayJobs.map((job) => job.jobKey),
      },
    },
  });

  return auditLogId;
}

function auditPlanFromWebhookReplayPlan(plan: WebhookReplayPlan): Record<string, unknown> {
  return {
    action: plan.action,
    webhookEventId: plan.webhookEventId,
    deliveryId: plan.deliveryId,
    eligibleJobIds: plan.eligibleJobIds,
    blockedJobIds: plan.blockedJobIds,
    missingJobKeys: plan.missingJobKeys,
    replayJobs: plan.jobs.map(toReplayConfirmationJob),
    failureCodes: plan.failures.map((failure) => failure.code),
  };
}

function auditPlanFromReviewReplayPlan(plan: ReviewReplayPlan): Record<string, unknown> {
  return {
    action: plan.action,
    reviewRunId: plan.reviewRunId,
    currentStatus: plan.currentStatus,
    payload: plan.payload,
    replayJobs: [toReplayConfirmationJob(plan.job)],
    relatedJobIds: plan.relatedJobs.map((job) => job.backgroundJobId),
    failureCodes: plan.failures.map((failure) => failure.code),
  };
}

function auditPlanFromPublisherReplayPlan(plan: PublisherReplayPlan): Record<string, unknown> {
  return {
    action: plan.action,
    payload: plan.payload,
    dryRun: plan.dryRun,
    reconciliation: plan.reconciliation,
    replayJobs: [toReplayConfirmationJob(plan.job)],
  };
}

/** Throws when a provided confirmation token does not match the current plan. */
function assertConfirmationToken(providedToken: string, expectedToken: string): void {
  if (providedToken !== expectedToken) {
    throw new AdminDebugConfirmationError(providedToken, expectedToken);
  }
}

/** Converts replay job metadata into a stable confirmation fragment. */
function toReplayConfirmationJob(job: AdminReplayJobPlan): Record<string, unknown> {
  return {
    source: job.source,
    queueName: job.queueName,
    jobType: job.jobType,
    ...(job.originalBackgroundJobId
      ? { originalBackgroundJobId: job.originalBackgroundJobId }
      : {}),
    ...(job.originalJobKey ? { originalJobKey: job.originalJobKey } : {}),
    replayJobKey: job.replayJobKey,
    payloadHash: hashJson(job.envelope.payload),
  };
}

/** Creates a non-deterministic prefixed ID for durable replay rows. */
function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

/** Creates a stable prefixed ID for deterministic replay envelopes. */
function stableId(prefix: string, parts: readonly unknown[]): string {
  return `${prefix}_${createHash("sha256")
    .update(parts.map((part) => String(part)).join(":"))
    .digest("base64url")
    .slice(0, 26)}`;
}

/** Narrows a stored queue name to a known queue name. */
function toQueueName(value: string): QueueName {
  if ((Object.values(QUEUE_NAMES) as readonly string[]).includes(value)) {
    return value as QueueName;
  }

  throw new Error(`Unknown queue name ${value}.`);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" ? value : undefined;
}

function booleanField(
  record: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const value = record?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function renderSummary(findings: readonly ValidatedFinding[]): string {
  if (findings.length === 0) {
    return "Heimdall completed the review and found no publishable issues.";
  }

  return findings
    .map((finding, index) => `${index + 1}. **${finding.title}** in \`${finding.location.path}\``)
    .join("\n");
}

function renderFallbackSummary(findings: readonly ValidatedFinding[]): string {
  if (findings.length === 0) {
    return "Heimdall could not publish inline comments, and found no publishable issues.";
  }

  return [
    "Heimdall could not publish every inline review comment, so it is posting the findings here.",
    "",
    ...findings.map(
      (finding, index) =>
        `${index + 1}. **${finding.title}** in \`${finding.location.path}:${finding.location.line}\`\n${finding.body}`,
    ),
  ].join("\n");
}

function hashJson(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function toIso(value: Date): string {
  return value.toISOString();
}
