import { createHash, randomUUID } from "node:crypto";
import type {
  ContextBundle,
  ContextItem,
  JobEnvelope,
  JobPayload,
  PublishReviewJobPayload,
  RepoRule,
  Repository,
  ReviewPullRequestJobPayload,
  ReviewRun,
  ValidatedFinding,
} from "@repo/contracts";
import { ContextBundleSchema, JOB_TYPES, parseWithSchema } from "@repo/contracts";
import {
  adminActions,
  auditLogs,
  type BackgroundJobRecord,
  BackgroundJobRepository,
  candidateFindings,
  codeChunkEmbeddings,
  codeChunks,
  codeDependencies,
  codeEdges,
  codeIndexDiagnostics,
  codeRoutes,
  codeTestMappings,
  debugExports,
  embeddingJobItems,
  embeddingJobs,
  type HeimdallDatabase,
  type IndexVersionRecord,
  IndexVersionRepository,
  indexedFiles,
  indexImportBatches,
  llmCalls,
  type MemoryCandidateRecord,
  MemoryCandidateRepository,
  type MemoryFactRecord,
  MemoryFactRepository,
  PullRequestRepository,
  publishedCheckRuns,
  publishedFindings,
  publishedReviews,
  publishedSummaryComments,
  publishOperations,
  publishRuns,
  pullRequestSnapshots,
  quotaCounters,
  quotaReservations,
  RepoRuleRepository,
  RepositoryRepository,
  ReviewRepository,
  replayRuns,
  replayStageRuns,
  reviewArtifacts,
  reviewRunDependencies,
  reviewRunStageEvents,
  sandboxArtifacts,
  sandboxPolicyDecisions,
  sandboxRuns,
  symbols,
  usageEvents,
  validatedFindings,
  webhookEvents,
} from "@repo/db";
import {
  type EvalActualFinding,
  type EvalCase,
  type EvalChangedFile,
  type EvalExpectedFinding,
  type EvalFindingLocation,
  parseEvalCase,
} from "@repo/evaluation";
import {
  type ExistingBotComment,
  type GitHubCommentMarker,
  type GitHubRepositoryRef,
  type GitProvider,
  parseGitHubCommentMarkers,
} from "@repo/github";
import { parseJobEnvelope, QUEUE_NAMES, type QueueName } from "@repo/queue";
import { createDatabaseRetrievalIndex, retrieveContext } from "@repo/retrieval";
import { validateAndRankCandidateFindings } from "@repo/review-engine";
import { type EffectiveReviewPolicy, parseReviewPolicySnapshot } from "@repo/rules";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

export * from "./compliance-evidence";

/** Resource type that an admin debug lookup can target. */
export type AdminDebugResourceType =
  | "webhook_event"
  | "background_job"
  | "index_version"
  | "review_run"
  | "repository";

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

/** Error raised when an admin debug operation is well-formed but cannot run. */
export class AdminDebugOperationError extends Error {
  /** Creates an admin debug operation error. */
  public constructor(
    /** Stable API error code. */
    public readonly code: string,
    message: string,
    /** HTTP status code that should represent this failure. */
    public readonly status: number,
  ) {
    super(message);
    this.name = "AdminDebugOperationError";
  }
}

/** Source table or event that produced a structured admin failure detail. */
export type AdminFailureSource =
  | "webhook_event"
  | "background_job"
  | "embedding_job"
  | "embedding_job_item"
  | "review_run"
  | "review_stage_event"
  | "llm_call"
  | "sandbox_run"
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

/** Debug summary for one durable embedding job row. */
export type AdminEmbeddingJobDebugSummary = {
  /** Durable embedding job row ID. */
  readonly embeddingJobId: string;
  /** Organization that owns the embedding job. */
  readonly orgId: string;
  /** Repository being embedded. */
  readonly repoId: string;
  /** Imported index version being embedded when available. */
  readonly indexVersionId?: string;
  /** Commit SHA being embedded when available. */
  readonly commitSha?: string;
  /** Current durable embedding job status. */
  readonly status: string;
  /** Reason the embedding job was planned. */
  readonly reason: string;
  /** Embedding profile version used by this job. */
  readonly embeddingProfileVersion: string;
  /** Embedding provider used by this job. */
  readonly provider: string;
  /** Embedding model used by this job. */
  readonly model: string;
  /** Vector dimension configured for this job. */
  readonly dimensions: number;
  /** Number of chunks planned for embedding. */
  readonly chunkCountPlanned: number;
  /** Number of chunks embedded so far. */
  readonly chunkCountEmbedded: number;
  /** Number of chunks skipped so far. */
  readonly chunkCountSkipped: number;
  /** Number of chunks failed so far. */
  readonly chunkCountFailed: number;
  /** Rounded completion percentage derived from chunk counters. */
  readonly progressPercent: number;
  /** Current durable attempt count. */
  readonly attempts: number;
  /** Worker or process that holds the job lock when available. */
  readonly lockedBy?: string;
  /** ISO timestamp for the current lock when available. */
  readonly lockedAt?: string;
  /** Machine-readable last error code when available. */
  readonly lastErrorCode?: string;
  /** Product-safe last error message when available. */
  readonly lastErrorMessage?: string;
  /** Stored metadata keys without raw metadata values. */
  readonly metadataKeys: readonly string[];
  /** ISO timestamp for row creation. */
  readonly createdAt: string;
  /** ISO timestamp for first start when available. */
  readonly startedAt?: string;
  /** ISO timestamp for terminal completion when available. */
  readonly finishedAt?: string;
  /** Structured embedding job failure when available. */
  readonly failure?: AdminFailureDetail;
};

/** Debug summary for one sampled embedding job item row. */
export type AdminEmbeddingJobItemDebugSummary = {
  /** Durable embedding job item row ID. */
  readonly embeddingJobItemId: string;
  /** Durable embedding job row ID. */
  readonly embeddingJobId: string;
  /** Code chunk attached to this item. */
  readonly chunkId: string;
  /** Current per-chunk embedding status. */
  readonly status: string;
  /** Stable embedding cache key when known. */
  readonly cacheKey?: string;
  /** Current item attempt count. */
  readonly attempts: number;
  /** Machine-readable last error code when available. */
  readonly lastErrorCode?: string;
  /** Product-safe last error message when available. */
  readonly lastErrorMessage?: string;
  /** ISO timestamp for row creation. */
  readonly createdAt: string;
  /** ISO timestamp for first start when available. */
  readonly startedAt?: string;
  /** ISO timestamp for terminal completion when available. */
  readonly finishedAt?: string;
  /** Structured item failure when available. */
  readonly failure?: AdminFailureDetail;
};

/** Count metric shown by the admin index-version inspector. */
export type AdminIndexVersionCountMetric =
  | "chunks"
  | "dependencies"
  | "diagnostics"
  | "edges"
  | "embeddings"
  | "files"
  | "routes"
  | "symbols"
  | "testMappings";

/** Expected and actual row counts for one imported index metric. */
export type AdminIndexVersionCountSummary = {
  /** Expected count stored on the code_index_versions row. */
  readonly expected: number;
  /** Actual count observed in normalized child tables. */
  readonly actual: number;
};

/** Count mismatch emitted when stored metadata differs from normalized rows. */
export type AdminIndexVersionCountMismatch = {
  /** Count metric that did not match. */
  readonly metric: AdminIndexVersionCountMetric;
  /** Expected count stored on the code_index_versions row. */
  readonly expected: number;
  /** Actual count observed in normalized child tables. */
  readonly actual: number;
  /** Actual minus expected. */
  readonly delta: number;
};

/** Count summaries for one imported index version. */
export type AdminIndexVersionCountSummaries = {
  /** Imported file count summary. */
  readonly files: AdminIndexVersionCountSummary;
  /** Imported symbol count summary. */
  readonly symbols: AdminIndexVersionCountSummary;
  /** Imported edge count summary. */
  readonly edges: AdminIndexVersionCountSummary;
  /** Imported chunk count summary. */
  readonly chunks: AdminIndexVersionCountSummary;
  /** Imported diagnostic count summary. */
  readonly diagnostics: AdminIndexVersionCountSummary;
  /** Imported dependency count summary. */
  readonly dependencies: AdminIndexVersionCountSummary;
  /** Imported route count summary. */
  readonly routes: AdminIndexVersionCountSummary;
  /** Imported test mapping count summary. */
  readonly testMappings: AdminIndexVersionCountSummary;
  /** Stored chunk embedding count summary. */
  readonly embeddings: AdminIndexVersionCountSummary;
};

/** Debug summary for one durable index import batch row. */
export type AdminIndexImportBatchDebugSummary = {
  /** Durable index import batch ID. */
  readonly indexImportBatchId: string;
  /** Repository that owns the import batch. */
  readonly repoId: string;
  /** Commit SHA that the imported artifact indexes. */
  readonly commitSha: string;
  /** Indexer/chunker key used by this import. */
  readonly indexKey: string;
  /** Imported index version when one was created. */
  readonly indexVersionId?: string;
  /** Artifact URI used by the importer. */
  readonly artifactUri: string;
  /** Artifact content hash when available. */
  readonly artifactHash?: string;
  /** Durable import status. */
  readonly status: string;
  /** Last recorded import phase. */
  readonly phase: string;
  /** Records observed in the artifact manifest. */
  readonly recordCount: number;
  /** File records planned or imported by the batch. */
  readonly fileCount: number;
  /** Symbol records planned or imported by the batch. */
  readonly symbolCount: number;
  /** Edge records planned or imported by the batch. */
  readonly edgeCount: number;
  /** Chunk records planned or imported by the batch. */
  readonly chunkCount: number;
  /** Diagnostic records planned or imported by the batch. */
  readonly diagnosticCount: number;
  /** Dependency records planned or imported by the batch. */
  readonly dependencyCount: number;
  /** Route records planned or imported by the batch. */
  readonly routeCount: number;
  /** Test mapping records planned or imported by the batch. */
  readonly testMappingCount: number;
  /** Embedding jobs created by the batch. */
  readonly embeddingJobCount: number;
  /** Product-safe serialized import error when present. */
  readonly error?: unknown;
  /** Metadata keys present on the import batch without exposing raw metadata. */
  readonly metadataKeys: readonly string[];
  /** ISO timestamp when the import batch started. */
  readonly startedAt?: string;
  /** ISO timestamp when the import batch finished. */
  readonly finishedAt?: string;
  /** ISO timestamp when the row was created. */
  readonly createdAt: string;
  /** ISO timestamp when the row was last updated. */
  readonly updatedAt: string;
};

/** Admin-facing inspection details for one imported index version. */
export type AdminIndexVersionInspection = {
  /** Imported index version ID. */
  readonly indexVersionId: string;
  /** Repository that owns the index version. */
  readonly repoId: string;
  /** Commit SHA indexed by this version. */
  readonly commitSha: string;
  /** Indexer/chunker key for this version. */
  readonly indexKey: string;
  /** Current index version status. */
  readonly status: string;
  /** Artifact URI persisted for replay. */
  readonly artifactUri: string;
  /** Artifact content hash when available. */
  readonly artifactHash?: string;
  /** Indexer implementation name. */
  readonly indexerName: string;
  /** Indexer implementation version. */
  readonly indexerVersion: string;
  /** Chunker implementation version. */
  readonly chunkerVersion: string;
  /** Expected and actual normalized row counts. */
  readonly counts: AdminIndexVersionCountSummaries;
  /** Count mismatches that require cleanup or investigation. */
  readonly mismatches: readonly AdminIndexVersionCountMismatch[];
  /** Related import batches ordered newest first. */
  readonly importBatches: readonly AdminIndexImportBatchDebugSummary[];
  /** Related embedding jobs ordered newest first. */
  readonly embeddingJobs: readonly AdminEmbeddingJobDebugSummary[];
  /** Product-safe serialized index error when present. */
  readonly error?: unknown;
  /** ISO timestamp when the index version completed. */
  readonly completedAt?: string;
  /** ISO timestamp when the index version row was created. */
  readonly createdAt: string;
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

/** Debug detail for one durable background job. */
export type AdminBackgroundJobDebugDetails = {
  /** Durable job summary. */
  readonly job: AdminBackgroundJobDebugSummary;
  /** Embedding job referenced by an embedding batch payload when available. */
  readonly embeddingJob?: AdminEmbeddingJobDebugSummary;
  /** Sampled embedding job items for the referenced embedding job when available. */
  readonly embeddingJobItems?: readonly AdminEmbeddingJobItemDebugSummary[];
  /** Replay decisions already audited for this background job. */
  readonly replayAudits: readonly AdminReplayAuditSummary[];
  /** Structured failures collected from the job. */
  readonly failures: readonly AdminFailureDetail[];
};

/** Replay action that requeues jobs originally planned from a webhook. */
export type WebhookReplayAction = "webhook.requeue_jobs";

/** Replay action that requeues one failed durable background job. */
export type BackgroundJobReplayAction = "job.requeue";

/** Admin action that cancels one pending, queued, or running durable background job. */
export type BackgroundJobCancelAction = "job.cancel";

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

/** Gated replay plan for one durable background job. */
export type BackgroundJobReplayPlan = {
  /** Action that an operator can dispatch after confirmation. */
  readonly action: BackgroundJobReplayAction;
  /** Durable background job being replayed. */
  readonly backgroundJobId: string;
  /** Current durable job status. */
  readonly currentStatus: string;
  /** Queue that should receive the replay job. */
  readonly queueName: QueueName;
  /** Handler type carried by the replay envelope. */
  readonly jobType: string;
  /** Replay job that can be inserted after confirmation. */
  readonly job: AdminReplayJobPlan;
  /** Current failure details that motivated or constrain replay. */
  readonly failures: readonly AdminFailureDetail[];
  /** Confirmation token derived from the current plan state. */
  readonly confirmationToken: string;
  /** Whether dispatching this plan can mutate operational state. */
  readonly requiresExplicitConfirmation: true;
};

/** Result returned after inserting confirmed replay jobs into the durable outbox. */
export type AdminReplayExecutionResult = {
  /** Replay action that was confirmed. */
  readonly action:
    | WebhookReplayAction
    | BackgroundJobReplayAction
    | ReviewReplayAction
    | PublisherReplayAction;
  /** Durable admin action row ID written for this replay dispatch. */
  readonly adminActionId: string;
  /** Durable replay run row ID written for this replay dispatch. */
  readonly replayRunId: string;
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

/** Result returned after a confirmed durable background job cancellation. */
export type AdminBackgroundJobCancelResult = {
  /** Admin action that was executed. */
  readonly action: BackgroundJobCancelAction;
  /** Durable admin action row ID written for this cancellation. */
  readonly adminActionId: string;
  /** Audit log row ID written for the cancellation decision. */
  readonly auditLogId: string;
  /** Durable background job row ID that was canceled. */
  readonly backgroundJobId: string;
  /** Status observed before cancellation. */
  readonly previousStatus: string;
  /** Current durable job status after cancellation. */
  readonly currentStatus: "canceled";
  /** Product-safe operator reason. */
  readonly reason: string;
  /** ISO timestamp when the cancellation was recorded. */
  readonly canceledAt: string;
  /** Durable job summary after cancellation. */
  readonly job: AdminBackgroundJobDebugSummary;
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
  /** Support-session ID that authorized privileged raw artifact handling. */
  readonly supportSessionId?: string;
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

/** Debug summary for one artifact collected by a sandbox run. */
export type AdminSandboxArtifactDebugSummary = {
  /** Sandbox artifact row ID. */
  readonly sandboxArtifactId: string;
  /** Artifact name scoped to the sandbox run. */
  readonly name: string;
  /** Durable artifact URI. */
  readonly uri: string;
  /** Artifact SHA-256 digest. */
  readonly sha256: string;
  /** Artifact byte size. */
  readonly sizeBytes: number;
  /** Artifact content type when available. */
  readonly contentType?: string;
  /** Whether the artifact was truncated before persistence. */
  readonly truncated: boolean;
  /** ISO timestamp for artifact creation. */
  readonly createdAt: string;
};

/** Product-safe policy decision counts for one sandbox run. */
export type AdminSandboxPolicyDecisionCounts = {
  /** Allowed decision count. */
  readonly allowed: number;
  /** Warning decision count. */
  readonly warning: number;
  /** Denied decision count. */
  readonly denied: number;
};

/** Debug summary for one persisted sandbox run. */
export type AdminSandboxRunDebugSummary = {
  /** Sandbox run row ID. */
  readonly sandboxRunId: string;
  /** Unique sandbox request ID. */
  readonly requestId: string;
  /** Runner kind, such as docker or gvisor. */
  readonly runnerKind: string;
  /** Sandbox trust level. */
  readonly trustLevel: string;
  /** Sandbox execution category. */
  readonly category: string;
  /** Static-analysis run ID when available. */
  readonly staticAnalysisRunId?: string;
  /** Tool run ID when available. */
  readonly toolRunId?: string;
  /** Container image name. */
  readonly image: string;
  /** Container image digest when available. */
  readonly imageDigest?: string;
  /** Final sandbox status. */
  readonly status: string;
  /** Process exit code when available. */
  readonly exitCode?: number;
  /** Process signal when available. */
  readonly signal?: string;
  /** Captured stdout hash when available. */
  readonly stdoutHash?: string;
  /** Captured stderr hash when available. */
  readonly stderrHash?: string;
  /** Whether stdout was truncated. */
  readonly stdoutTruncated: boolean;
  /** Whether stderr was truncated. */
  readonly stderrTruncated: boolean;
  /** Product-safe warning count. */
  readonly warningCount: number;
  /** Product-safe policy decision counts. */
  readonly policyDecisionCounts: AdminSandboxPolicyDecisionCounts;
  /** Artifacts collected for the sandbox run. */
  readonly artifacts: readonly AdminSandboxArtifactDebugSummary[];
  /** ISO timestamp when execution started. */
  readonly startedAt?: string;
  /** ISO timestamp when execution finished. */
  readonly finishedAt?: string;
  /** ISO timestamp when the sandbox run row was created. */
  readonly createdAt: string;
  /** Structured sandbox failure when available. */
  readonly failure?: AdminFailureDetail;
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

/** Debug summary for one append-only usage ledger event. */
export type AdminUsageEventDebugSummary = {
  /** Durable usage event ID. */
  readonly usageEventId: string;
  /** Organization that owns the usage. */
  readonly orgId: string;
  /** Repository that caused the usage when available. */
  readonly repoId?: string;
  /** Review run that caused the usage when available. */
  readonly reviewRunId?: string;
  /** Product usage event type. */
  readonly eventType: string;
  /** Signed usage quantity. */
  readonly quantity: number;
  /** Usage unit. */
  readonly unit: string;
  /** Estimated internal cost in micro-USD. */
  readonly costMicros: number;
  /** Usage occurrence timestamp. */
  readonly occurredAt: string;
  /** Sorted metadata keys available on the event. */
  readonly metadataKeys: readonly string[];
  /** Stable metadata hash when metadata is present. */
  readonly metadataHash?: `sha256:${string}`;
};

/** Rollup row for review-run usage and cost inspection. */
export type AdminUsageRollupDebugSummary = {
  /** Usage event type summarized by this row. */
  readonly eventType: string;
  /** Usage unit summarized by this row. */
  readonly unit: string;
  /** Signed usage quantity total. */
  readonly quantity: number;
  /** Number of usage events summarized. */
  readonly eventCount: number;
  /** Estimated internal cost total in micro-USD. */
  readonly costMicros: number;
};

/** Quota reservation or counter state linked to a review run. */
export type AdminQuotaDecisionDebugSummary = {
  /** Durable quota reservation row ID. */
  readonly quotaReservationId: string;
  /** Quota key that was reserved. */
  readonly quotaKey: string;
  /** Quota period key, such as 2026-05. */
  readonly periodKey: string;
  /** Source type that created the reservation. */
  readonly sourceType: string;
  /** Source ID that created the reservation. */
  readonly sourceId: string;
  /** Reserved quantity. */
  readonly quantity: number;
  /** Reservation lifecycle status. */
  readonly status: string;
  /** Counter used quantity at inspection time. */
  readonly usedQuantity: number;
  /** Counter reserved quantity at inspection time. */
  readonly reservedQuantity: number;
  /** Counter limit quantity when configured. */
  readonly limitQuantity?: number;
  /** Reservation creation timestamp. */
  readonly createdAt: string;
  /** Reservation expiry timestamp. */
  readonly expiresAt: string;
  /** Reservation consumption timestamp when consumed. */
  readonly consumedAt?: string;
  /** Reservation release timestamp when released. */
  readonly releasedAt?: string;
};

/** Review-run usage and cost inspector output for admin/debug workflows. */
export type AdminUsageCostInspection = {
  /** Organization that owns the inspected usage. */
  readonly orgId: string;
  /** Repository that owns the inspected usage when known. */
  readonly repoId?: string;
  /** Review run being inspected when scoped to a review. */
  readonly reviewRunId?: string;
  /** Append-only usage events included in the inspection. */
  readonly usageEvents: readonly AdminUsageEventDebugSummary[];
  /** Usage rollups grouped by event type and unit. */
  readonly rollups: readonly AdminUsageRollupDebugSummary[];
  /** Estimated internal cost in micro-USD. */
  readonly estimatedCostMicros: number;
  /** Estimated internal cost formatted as a fixed USD string. */
  readonly estimatedCostUsd: string;
  /** Customer-understandable billable units derived from usage events. */
  readonly billableUnits: Readonly<Record<string, number>>;
  /** Quota reservation state associated with the review run. */
  readonly quotaDecisions: readonly AdminQuotaDecisionDebugSummary[];
  /** Human-review warnings for missing or suspicious usage state. */
  readonly warnings: readonly string[];
};

/** Input used to build a review-run usage and cost inspection. */
export type BuildUsageCostInspectionInput = {
  /** Organization that owns the inspected usage. */
  readonly orgId: string;
  /** Repository that owns the inspected usage when known. */
  readonly repoId?: string;
  /** Review run being inspected when scoped to a review. */
  readonly reviewRunId?: string;
  /** Usage events to inspect. */
  readonly usageEvents: readonly AdminUsageEventDebugSummary[];
  /** Quota reservations to inspect. */
  readonly quotaDecisions?: readonly AdminQuotaDecisionDebugSummary[];
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
  /** Sandbox runs linked to the review run. */
  readonly sandboxRuns: readonly AdminSandboxRunDebugSummary[];
  /** Related review and publish jobs. */
  readonly relatedJobs: readonly AdminBackgroundJobDebugSummary[];
  /** Replay decisions already audited for this review run. */
  readonly replayAudits: readonly AdminReplayAuditSummary[];
  /** Structured failures collected from review state and related jobs. */
  readonly failures: readonly AdminFailureDetail[];
};

/** Actor details recorded on redacted debug bundle exports. */
export type AdminDebugBundleActorSummary = {
  /** Actor category stored in audit records. */
  readonly actorType: AdminReplayAuditActor["actorType"];
  /** Stable user or token principal ID stored in audit records. */
  readonly actorUserId: string;
  /** Access role granted to the actor. */
  readonly role: AdminReplayAuditActor["role"];
  /** Request ID that authorized the export. */
  readonly requestId?: string;
  /** Session ID that authorized the export. */
  readonly sessionId?: string;
  /** Support-session ID that authorized privileged raw artifact handling. */
  readonly supportSessionId?: string;
  /** Identity provider that authenticated the actor when available. */
  readonly provider?: string;
  /** Display name shown in operator views when available. */
  readonly displayName?: string;
  /** Primary email shown in operator views when available. */
  readonly email?: string;
};

/** Placeholder value used when a debug bundle field is intentionally redacted. */
export type AdminDebugBundleRedactedValue = {
  /** Whether the original value was replaced. */
  readonly redacted: true;
  /** Field key that triggered redaction. */
  readonly key: string;
  /** Reason the original value is omitted. */
  readonly reason: "sensitive_field";
  /** Runtime type of the original value. */
  readonly valueType: string;
  /** SHA-256 hash of the original serialized value for correlation. */
  readonly sha256: `sha256:${string}`;
  /** Serialized byte size of the original value. */
  readonly sizeBytes: number;
};

/** Redacted review-run debug bundle safe for support and engineering handoff. */
export type AdminReviewRunDebugBundle = {
  /** Bundle contract version. */
  readonly schemaVersion: "admin_debug_bundle.v1";
  /** Generated debug bundle ID. */
  readonly bundleId: string;
  /** Durable debug export row ID for operator history. */
  readonly debugExportId: string;
  /** Durable admin action row ID for this export. */
  readonly adminActionId: string;
  /** Review run exported into the bundle. */
  readonly reviewRunId: string;
  /** Repository that owns the review run. */
  readonly repoId: string;
  /** Redaction policy applied to the payload. */
  readonly redactionLevel: "metadata";
  /** ISO timestamp when the bundle was generated. */
  readonly generatedAt: string;
  /** ISO timestamp when the debug bundle should no longer be used. */
  readonly expiresAt: string;
  /** Actor that requested the export. */
  readonly generatedBy: AdminDebugBundleActorSummary;
  /** Hash of the redacted payload returned to the operator. */
  readonly payloadHash: `sha256:${string}`;
  /** Audit log row written for the export. */
  readonly auditLogId: string;
  /** Redacted review, publisher, and replay metadata. */
  readonly payload: unknown;
};

/** Artifact groups that can be proposed by a review-run eval import. */
export type EvalImportArtifactSelection = {
  /** Include pull request snapshot metadata. */
  readonly pullRequestSnapshot: boolean;
  /** Include a raw diff patch when permitted. */
  readonly rawDiff: boolean;
  /** Include retrieval context bundle metadata when available. */
  readonly contextBundle: boolean;
  /** Include review output metadata. */
  readonly reviewOutputs: boolean;
  /** Include validation output metadata. */
  readonly validationOutputs: boolean;
};

/** Request to create a review-run eval fixture draft. */
export type ImportReviewRunToEvalRequest = {
  /** Review run that should seed the eval case. */
  readonly reviewRunId: string;
  /** Eval suite ID that would receive the approved case. */
  readonly suiteId: string;
  /** Human-readable case name. */
  readonly caseName: string;
  /** Reason the operator wants the case in eval coverage. */
  readonly reason: string;
  /** Artifact groups to include in the generated draft files. */
  readonly includeArtifacts: EvalImportArtifactSelection;
  /** Redaction level for the generated draft. */
  readonly redactionLevel: "redacted" | "synthetic" | "raw_allowed";
  /** Optional labels to add as eval case tags. */
  readonly labels?: readonly string[];
};

/** One proposed file emitted by a review-run eval import draft. */
export type AdminEvalImportDraftFile = {
  /** Path where the draft file would live if accepted. */
  readonly path: string;
  /** Stable draft file kind. */
  readonly kind:
    | "eval_case"
    | "pull_request_snapshot"
    | "expected_findings"
    | "actual_findings"
    | "notes";
  /** Redacted JSON or Markdown content. */
  readonly content: unknown;
};

/** Draft eval import generated from a review run without mutating committed fixtures. */
export type AdminReviewRunEvalImportDraft = {
  /** Draft contract version. */
  readonly schemaVersion: "admin_eval_import_draft.v1";
  /** Generated eval import draft ID. */
  readonly importDraftId: string;
  /** Durable admin action row ID written for this draft creation. */
  readonly adminActionId: string;
  /** Review run used as the source. */
  readonly reviewRunId: string;
  /** Repository that owns the review run. */
  readonly repoId: string;
  /** Target suite ID. */
  readonly suiteId: string;
  /** Eval case generated from review state. */
  readonly evalCase: EvalCase;
  /** Proposed files for a later human-reviewed fixture commit. */
  readonly files: readonly AdminEvalImportDraftFile[];
  /** Redaction level used for generated files. */
  readonly redactionLevel: ImportReviewRunToEvalRequest["redactionLevel"];
  /** Warnings that require human review before fixture approval. */
  readonly warnings: readonly string[];
  /** Audit log row written for the draft creation. */
  readonly auditLogId: string;
  /** ISO timestamp when the draft was generated. */
  readonly generatedAt: string;
  /** Actor that requested the draft. */
  readonly generatedBy: AdminDebugBundleActorSummary;
};

/** Repository summary used by the memory and rules debug inspector. */
export type AdminMemoryRulesRepositorySummary = {
  /** Repository ID being inspected. */
  readonly repoId: string;
  /** Organization that owns the repository. */
  readonly orgId: string;
  /** Source code hosting provider. */
  readonly provider: string;
  /** Provider owner and repository name. */
  readonly fullName: string;
  /** Default branch when the provider supplied one. */
  readonly defaultBranch?: string;
  /** Provider visibility label. */
  readonly visibility: string;
  /** Whether Heimdall reviews are enabled for the repository. */
  readonly enabled: boolean;
  /** Whether the provider marks the repository as archived. */
  readonly isArchived: boolean;
  /** Whether the provider marks the repository as a fork. */
  readonly isFork: boolean;
};

/** Debug summary for one stored repository or organization memory fact. */
export type AdminMemoryFactDebugSummary = {
  /** Durable memory fact row ID. */
  readonly memoryFactId: string;
  /** Organization that owns the fact. */
  readonly orgId: string;
  /** Repository that owns the fact when repository-scoped. */
  readonly repoId?: string;
  /** Whether this fact applies through repository or organization scope. */
  readonly scope: "repository" | "organization";
  /** Machine-readable fact type. */
  readonly factType: string;
  /** Stored fact body used by review context assembly. */
  readonly body: string;
  /** Current fact lifecycle status. */
  readonly status: string;
  /** Confidence score assigned to the fact. */
  readonly confidence: number;
  /** Expiration timestamp when the fact is temporary. */
  readonly expiresAt?: string;
  /** Sorted metadata keys available on the row. */
  readonly metadataKeys: readonly string[];
  /** Hash of the metadata payload when metadata exists. */
  readonly metadataHash?: `sha256:${string}`;
  /** Fact creation timestamp. */
  readonly createdAt: string;
  /** Fact update timestamp. */
  readonly updatedAt: string;
};

/** Debug summary for one proposed memory candidate. */
export type AdminMemoryCandidateDebugSummary = {
  /** Durable memory candidate row ID. */
  readonly memoryCandidateId: string;
  /** Organization that owns the candidate. */
  readonly orgId: string;
  /** Repository that owns the candidate when repository-scoped. */
  readonly repoId?: string;
  /** Source that proposed the candidate. */
  readonly sourceKind: string;
  /** Machine-readable candidate kind. */
  readonly candidateKind: string;
  /** Proposed memory text. */
  readonly proposedContent: string;
  /** Current candidate lifecycle status. */
  readonly status: string;
  /** Confidence score assigned to the candidate. */
  readonly confidence: number;
  /** Trust level assigned to the proposing actor or source. */
  readonly trustLevel: string;
  /** User login that created the candidate when available. */
  readonly createdByLogin?: string;
  /** Source finding linked to the candidate when available. */
  readonly sourceFindingId?: string;
  /** Memory fact created from the candidate when approved. */
  readonly approvedMemoryFactId?: string;
  /** User that made the moderation decision when available. */
  readonly decidedByUserId?: string;
  /** Decision timestamp when available. */
  readonly decidedAt?: string;
  /** Expiration timestamp when the candidate is temporary. */
  readonly expiresAt?: string;
  /** Sorted proposed scope keys. */
  readonly proposedScopeKeys: readonly string[];
  /** Stable hash of the proposed scope payload when present. */
  readonly proposedScopeHash?: `sha256:${string}`;
  /** Sorted proposed applies-to keys. */
  readonly proposedAppliesToKeys: readonly string[];
  /** Stable hash of the proposed applies-to payload when present. */
  readonly proposedAppliesToHash?: `sha256:${string}`;
  /** Sorted metadata keys available on the row. */
  readonly metadataKeys: readonly string[];
  /** Hash of the metadata payload when metadata exists. */
  readonly metadataHash?: `sha256:${string}`;
  /** Candidate creation timestamp. */
  readonly createdAt: string;
  /** Candidate update timestamp. */
  readonly updatedAt: string;
};

/** Debug summary for one effective repository or organization rule. */
export type AdminRepoRuleDebugSummary = {
  /** Rule ID used by typed policy snapshots. */
  readonly ruleId: string;
  /** Organization that owns the rule. */
  readonly orgId: string;
  /** Repository that owns the rule when repository-scoped. */
  readonly repoId?: string;
  /** Whether this rule applies through repository or organization scope. */
  readonly scope: "repository" | "organization";
  /** Human-readable rule name. */
  readonly name: string;
  /** Human-readable description when configured. */
  readonly description?: string;
  /** Rule effect consumed by the policy engine. */
  readonly effect: RepoRule["effect"];
  /** Matcher consumed by the policy engine. */
  readonly matcher: RepoRule["matcher"];
  /** Instruction consumed by policy and review context assembly. */
  readonly instruction: string;
  /** Lower values run first. */
  readonly priority: number;
  /** Whether the rule is enabled. */
  readonly enabled: boolean;
  /** User that created the rule when available. */
  readonly createdByUserId?: string;
  /** Sorted metadata keys available on the typed rule. */
  readonly metadataKeys: readonly string[];
  /** Rule creation timestamp. */
  readonly createdAt: string;
  /** Rule update timestamp. */
  readonly updatedAt: string;
};

/** Tool entry surfaced by the memory and rules inspector. */
export type AdminMemoryRulesDebugTool = {
  /** Stable tool identifier. */
  readonly toolId: string;
  /** Human-readable tool label. */
  readonly label: string;
  /** Whether this tool can run in the current implementation. */
  readonly status: "available" | "unavailable";
  /** Admin API route for available tools. */
  readonly route?: string;
  /** Explanation for unavailable tools. */
  readonly reason?: string;
};

/** Memory and rules inspector output for one repository. */
export type AdminMemoryRulesDebugDetails = {
  /** Repository being inspected. */
  readonly repository: AdminMemoryRulesRepositorySummary;
  /** Stored memory facts that can apply to the repository. */
  readonly memoryFacts: readonly AdminMemoryFactDebugSummary[];
  /** Proposed memory candidates that can apply to the repository. */
  readonly memoryCandidates: readonly AdminMemoryCandidateDebugSummary[];
  /** Effective organization and repository rules that can apply to the repository. */
  readonly rules: readonly AdminRepoRuleDebugSummary[];
  /** Candidate moderation capability shown by the inspector. */
  readonly candidateActions: {
    /** Whether an operator can approve memory candidates from this inspector. */
    readonly canApprove: boolean;
    /** Whether an operator can reject memory candidates from this inspector. */
    readonly canReject: boolean;
    /** Explanation of the current moderation availability. */
    readonly reason: string;
  };
  /** Policy and finding evaluation tools available from this repository context. */
  readonly evaluationTools: readonly AdminMemoryRulesDebugTool[];
  /** Warnings that need operator attention. */
  readonly warnings: readonly string[];
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

/** Summary of one context bundle used by retrieval replay comparison. */
export type RetrievalReplayBundleSummary = {
  /** Context bundle ID when a bundle exists. */
  readonly contextBundleId?: string;
  /** Retrieval mode recorded in bundle metadata. */
  readonly retrievalMode?: string;
  /** Index version used by indexed retrieval when available. */
  readonly indexVersionId?: string;
  /** Number of context items. */
  readonly itemCount: number;
  /** Estimated tokens included in the bundle. */
  readonly estimatedTokens: number;
  /** Maximum token budget for the bundle. */
  readonly maxTokens: number;
};

/** Inspectable summary of one retrieval context item. */
export type RetrievalReplayItemInspection = {
  /** Stable context item ID. */
  readonly contextItemId: string;
  /** Context item kind. */
  readonly kind: string;
  /** Retrieval source that produced the item. */
  readonly source: string;
  /** Context item title when present. */
  readonly title?: string;
  /** Repository path when the item has a code snippet. */
  readonly path?: string;
  /** Line range when the item has a code snippet. */
  readonly lineRange?: {
    /** 1-based start line. */
    readonly startLine: number;
    /** 1-based end line. */
    readonly endLine: number;
  };
  /** Related symbol ID when present. */
  readonly symbolId?: string;
  /** Chunk ID when present. */
  readonly chunkId?: string;
  /** Context item priority used for packing. */
  readonly priority: number;
  /** Estimated tokens consumed by the item. */
  readonly tokenEstimate: number;
  /** Retrieval score when available. */
  readonly score?: number;
  /** Retriever name that selected the item. */
  readonly retriever: string;
  /** Product-safe reason the retriever selected the item. */
  readonly reason: string;
  /** Short bounded text or snippet preview. */
  readonly textPreview?: string;
  /** Metadata keys present on the context item. */
  readonly metadataKeys: readonly string[];
};

/** One context item comparison emitted by retrieval dry-run replay. */
export type RetrievalReplayItemComparison = {
  /** Stable comparison key. */
  readonly key: string;
  /** Whether the item stayed the same, changed, was added, or was removed. */
  readonly status: "unchanged" | "changed" | "added" | "removed";
  /** Original context item kind when present. */
  readonly originalKind?: string;
  /** Replayed context item kind when present. */
  readonly replayedKind?: string;
  /** Original context title when present. */
  readonly originalTitle?: string;
  /** Replayed context title when present. */
  readonly replayedTitle?: string;
  /** Original item priority when present. */
  readonly originalPriority?: number;
  /** Replayed item priority when present. */
  readonly replayedPriority?: number;
  /** Original context item inspection when present. */
  readonly originalItem?: RetrievalReplayItemInspection;
  /** Replayed context item inspection when present. */
  readonly replayedItem?: RetrievalReplayItemInspection;
};

/** Non-mutating dry-run result for deterministic retrieval replay. */
export type RetrievalReplayDryRun = {
  /** Dry-run contract version. */
  readonly schemaVersion: "admin_retrieval_replay_dry_run.v1";
  /** Review run that was replayed. */
  readonly reviewRunId: string;
  /** Pull request snapshot used by retrieval. */
  readonly pullRequestSnapshotId: string;
  /** ISO timestamp when the replay was generated. */
  readonly generatedAt: string;
  /** Whether the dry-run mutated review state. */
  readonly mutatesProductionState: false;
  /** Persisted original context bundle summary when available. */
  readonly original?: RetrievalReplayBundleSummary;
  /** Replayed context bundle summary. */
  readonly replayed: RetrievalReplayBundleSummary;
  /** Item-level comparison rows. */
  readonly comparisons: readonly RetrievalReplayItemComparison[];
  /** Warnings that explain weak comparison fidelity. */
  readonly warnings: readonly string[];
};

/** Summary count block for validation replay findings. */
export type ValidationReplayDecisionCounts = {
  /** Number of publish decisions. */
  readonly publish: number;
  /** Number of reject decisions. */
  readonly reject: number;
};

/** One finding comparison emitted by validation dry-run replay. */
export type ValidationReplayFindingComparison = {
  /** Stable comparison key. */
  readonly key: string;
  /** Candidate finding ID when known. */
  readonly candidateFindingId?: string;
  /** Original validated finding ID when present. */
  readonly originalFindingId?: string;
  /** Replayed validated finding ID when present. */
  readonly replayedFindingId?: string;
  /** Original validation decision when present. */
  readonly originalDecision?: string;
  /** Replayed validation decision when present. */
  readonly replayedDecision?: string;
  /** Original rejection reasons. */
  readonly originalReasons: readonly string[];
  /** Replayed rejection reasons. */
  readonly replayedReasons: readonly string[];
  /** Whether rank, decision, or reasons changed. */
  readonly status: "unchanged" | "changed" | "added" | "removed";
  /** Finding title for operator context. */
  readonly title: string;
};

/** Non-mutating dry-run result for deterministic validation replay. */
export type ValidationReplayDryRun = {
  /** Dry-run contract version. */
  readonly schemaVersion: "admin_validation_replay_dry_run.v1";
  /** Review run that was replayed. */
  readonly reviewRunId: string;
  /** Pull request snapshot used by validation. */
  readonly pullRequestSnapshotId: string;
  /** ISO timestamp when the replay was generated. */
  readonly generatedAt: string;
  /** Whether the dry-run mutated review state. */
  readonly mutatesProductionState: false;
  /** Number of candidate findings used as replay input. */
  readonly candidateFindingCount: number;
  /** Counts for persisted original validation decisions. */
  readonly original: ValidationReplayDecisionCounts;
  /** Counts for replayed validation decisions. */
  readonly replayed: ValidationReplayDecisionCounts;
  /** Finding-level comparison rows. */
  readonly comparisons: readonly ValidationReplayFindingComparison[];
  /** Warnings that explain weak comparison fidelity. */
  readonly warnings: readonly string[];
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
  /** Gets durable background job debug details. */
  readonly getBackgroundJobDebugDetails: (
    backgroundJobId: string,
  ) => Promise<AdminBackgroundJobDebugDetails>;
  /** Gets imported index version diagnostics and row-count comparison details. */
  readonly getIndexVersionInspection: (
    indexVersionId: string,
  ) => Promise<AdminIndexVersionInspection>;
  /** Creates a gated replay plan for one failed durable background job. */
  readonly createBackgroundJobReplayPlan: (
    backgroundJobId: string,
  ) => Promise<BackgroundJobReplayPlan>;
  /** Executes a confirmed background job replay plan. */
  readonly executeBackgroundJobReplay: (
    backgroundJobId: string,
    confirmationToken: string,
    actor: AdminReplayAuditActor,
  ) => Promise<AdminReplayExecutionResult>;
  /** Cancels one pending, queued, or running durable background job. */
  readonly cancelBackgroundJob: (
    backgroundJobId: string,
    reason: string,
    actor: AdminReplayAuditActor,
  ) => Promise<AdminBackgroundJobCancelResult>;
  /** Gets review run debug details. */
  readonly getReviewDebugDetails: (reviewRunId: string) => Promise<AdminReviewDebugDetails>;
  /** Creates a gated review replay plan. */
  readonly createReviewReplayPlan: (reviewRunId: string) => Promise<ReviewReplayPlan>;
  /** Replays retrieval in dry-run mode without mutating review state. */
  readonly replayRetrievalDryRun: (reviewRunId: string) => Promise<RetrievalReplayDryRun>;
  /** Replays finding validation in dry-run mode without mutating review state. */
  readonly replayValidationDryRun: (reviewRunId: string) => Promise<ValidationReplayDryRun>;
  /** Executes a confirmed review replay plan. */
  readonly executeReviewReplay: (
    reviewRunId: string,
    confirmationToken: string,
    actor: AdminReplayAuditActor,
  ) => Promise<AdminReplayExecutionResult>;
  /** Exports a redacted debug bundle for one review run. */
  readonly exportReviewRunDebugBundle: (
    reviewRunId: string,
    actor: AdminReplayAuditActor,
  ) => Promise<AdminReviewRunDebugBundle>;
  /** Creates an audited eval import draft from one review run. */
  readonly createReviewRunEvalImportDraft: (
    request: ImportReviewRunToEvalRequest,
    actor: AdminReplayAuditActor,
  ) => Promise<AdminReviewRunEvalImportDraft>;
  /** Gets memory and rules debug details for a repository. */
  readonly getMemoryRulesDebugDetails: (repoId: string) => Promise<AdminMemoryRulesDebugDetails>;
  /** Gets usage ledger, billable unit, cost, and quota state for a review run. */
  readonly getUsageCostInspection: (reviewRunId: string) => Promise<AdminUsageCostInspection>;
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
    getBackgroundJobDebugDetails: (backgroundJobId) =>
      getBackgroundJobDebugDetails(backgroundJobId, dependencies),
    getIndexVersionInspection: (indexVersionId) =>
      getIndexVersionInspection(indexVersionId, dependencies),
    createBackgroundJobReplayPlan: (backgroundJobId) =>
      createBackgroundJobReplayPlan(backgroundJobId, dependencies),
    executeBackgroundJobReplay: (backgroundJobId, confirmationToken, actor) =>
      executeBackgroundJobReplay(backgroundJobId, confirmationToken, dependencies, actor),
    cancelBackgroundJob: (backgroundJobId, reason, actor) =>
      cancelBackgroundJob(backgroundJobId, reason, dependencies, actor),
    getReviewDebugDetails: (reviewRunId) => getReviewDebugDetails(reviewRunId, dependencies),
    createReviewReplayPlan: (reviewRunId) => createReviewReplayPlan(reviewRunId, dependencies),
    replayRetrievalDryRun: (reviewRunId) => replayRetrievalDryRun(reviewRunId, dependencies),
    replayValidationDryRun: (reviewRunId) => replayValidationDryRun(reviewRunId, dependencies),
    executeReviewReplay: (reviewRunId, confirmationToken, actor) =>
      executeReviewReplay(reviewRunId, confirmationToken, dependencies, actor),
    exportReviewRunDebugBundle: (reviewRunId, actor) =>
      exportReviewRunDebugBundle(reviewRunId, dependencies, actor),
    createReviewRunEvalImportDraft: (request, actor) =>
      createReviewRunEvalImportDraft(request, dependencies, actor),
    getMemoryRulesDebugDetails: (repoId) => getMemoryRulesDebugDetails(repoId, dependencies),
    getUsageCostInspection: (reviewRunId) => getUsageCostInspection(reviewRunId, dependencies),
    getPublisherDebugDetails: (reviewRunId) => getPublisherDebugDetails(reviewRunId, dependencies),
    createPublisherReplayPlan: (reviewRunId) =>
      createPublisherReplayPlan(reviewRunId, dependencies),
    executePublisherReplay: (reviewRunId, confirmationToken, actor) =>
      executePublisherReplay(reviewRunId, confirmationToken, dependencies, actor),
  };
}

/** Builds a review-run usage and cost inspection from already scoped usage rows. */
export function buildUsageCostInspection(
  input: BuildUsageCostInspectionInput,
): AdminUsageCostInspection {
  const usageRows = input.usageEvents
    .filter((event) => usageEventBelongsToInspection(event, input))
    .sort(compareAdminUsageEvents);
  const quotaDecisions = [...(input.quotaDecisions ?? [])].sort(compareAdminQuotaDecisions);
  const rollups = summarizeAdminUsageRollups(usageRows);
  const estimatedCostMicros = usageRows.reduce((sum, event) => sum + event.costMicros, 0);
  const billableUnits = summarizeBillableUnits(usageRows);
  const warnings = usageCostInspectionWarnings({
    quotaDecisions,
    ...(input.reviewRunId ? { reviewRunId: input.reviewRunId } : {}),
    usageEvents: usageRows,
  });

  return {
    billableUnits,
    estimatedCostMicros,
    estimatedCostUsd: microsToUsdString(estimatedCostMicros),
    orgId: input.orgId,
    ...(input.repoId ? { repoId: input.repoId } : {}),
    ...(input.reviewRunId ? { reviewRunId: input.reviewRunId } : {}),
    quotaDecisions,
    rollups,
    usageEvents: usageRows,
    warnings,
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

/** Gets durable background job state and replay audit history. */
export async function getBackgroundJobDebugDetails(
  backgroundJobId: string,
  dependencies: AdminDebugServiceDependencies,
): Promise<AdminBackgroundJobDebugDetails> {
  const row = await getBackgroundJobRow(backgroundJobId, dependencies.db);
  const embeddingJobId = embeddingJobIdFromBackgroundJob(row);
  const [replayAudits, embeddingJob, embeddingJobItems] = await Promise.all([
    listReplayAuditLogs(dependencies.db, {
      actions: ["job.requeue", "job.cancel"],
      resourceType: "background_job",
      resourceId: backgroundJobId,
    }),
    embeddingJobId
      ? getEmbeddingJobDebugSummary(dependencies.db, embeddingJobId)
      : Promise.resolve(undefined),
    embeddingJobId
      ? listEmbeddingJobItemDebugSummaries(dependencies.db, embeddingJobId)
      : Promise.resolve([]),
  ]);
  const job = toBackgroundJobDebugSummary(row);
  const itemFailures = embeddingJobItems.map((item) => item.failure);

  return {
    job,
    ...(embeddingJob ? { embeddingJob } : {}),
    ...(embeddingJobId ? { embeddingJobItems } : {}),
    replayAudits,
    failures: collectFailures([job.failure, embeddingJob?.failure, ...itemFailures]),
  };
}

/** Gets index version state, related import batches, embedding jobs, and count mismatches. */
export async function getIndexVersionInspection(
  indexVersionId: string,
  dependencies: AdminDebugServiceDependencies,
): Promise<AdminIndexVersionInspection> {
  const row = await getIndexVersionRow(indexVersionId, dependencies.db);
  const [
    actualFileCount,
    actualSymbolCount,
    actualEdgeCount,
    actualChunkCount,
    actualDiagnosticCount,
    actualDependencyCount,
    actualRouteCount,
    actualTestMappingCount,
    actualEmbeddingCount,
    importBatchRows,
    embeddingJobRows,
  ] = await Promise.all([
    countIndexedFileRows(dependencies.db, indexVersionId),
    countSymbolRows(dependencies.db, indexVersionId),
    countCodeEdgeRows(dependencies.db, indexVersionId),
    countCodeChunkRows(dependencies.db, indexVersionId),
    countCodeIndexDiagnosticRows(dependencies.db, indexVersionId),
    countCodeDependencyRows(dependencies.db, indexVersionId),
    countCodeRouteRows(dependencies.db, indexVersionId),
    countCodeTestMappingRows(dependencies.db, indexVersionId),
    countCodeChunkEmbeddingRows(dependencies.db, indexVersionId),
    listIndexImportBatchRows(dependencies.db, indexVersionId),
    listEmbeddingJobRowsForIndexVersion(dependencies.db, indexVersionId),
  ]);
  const counts = {
    chunks: { actual: actualChunkCount, expected: row.chunkCount },
    dependencies: { actual: actualDependencyCount, expected: row.dependencyCount },
    diagnostics: { actual: actualDiagnosticCount, expected: row.diagnosticCount },
    edges: { actual: actualEdgeCount, expected: row.edgeCount },
    embeddings: { actual: actualEmbeddingCount, expected: row.embeddedChunkCount },
    files: { actual: actualFileCount, expected: row.fileCount },
    routes: { actual: actualRouteCount, expected: row.routeCount },
    symbols: { actual: actualSymbolCount, expected: row.symbolCount },
    testMappings: { actual: actualTestMappingCount, expected: row.testMappingCount },
  } satisfies AdminIndexVersionCountSummaries;

  return {
    indexVersionId: row.indexVersionId,
    repoId: row.repoId,
    commitSha: row.commitSha,
    indexKey: row.indexKey,
    status: row.status,
    artifactUri: row.artifactUri,
    ...(row.artifactHash ? { artifactHash: row.artifactHash } : {}),
    indexerName: row.indexerName,
    indexerVersion: row.indexerVersion,
    chunkerVersion: row.chunkerVersion,
    counts,
    mismatches: buildIndexVersionCountMismatches(counts),
    importBatches: importBatchRows.map(toIndexImportBatchDebugSummary),
    embeddingJobs: embeddingJobRows.map(toEmbeddingJobDebugSummary),
    ...(row.error !== null ? { error: row.error } : {}),
    ...(row.completedAt ? { completedAt: toIso(row.completedAt) } : {}),
    createdAt: toIso(row.createdAt),
  };
}

/** Builds count mismatches for an imported index version inspection. */
export function buildIndexVersionCountMismatches(
  counts: AdminIndexVersionCountSummaries,
): readonly AdminIndexVersionCountMismatch[] {
  const metrics = Object.entries(counts) as readonly [
    AdminIndexVersionCountMetric,
    AdminIndexVersionCountSummary,
  ][];

  return metrics
    .filter(([, countSummary]) => countSummary.expected !== countSummary.actual)
    .map(([metric, countSummary]) => ({
      actual: countSummary.actual,
      delta: countSummary.actual - countSummary.expected,
      expected: countSummary.expected,
      metric,
    }));
}

/** Creates a replay plan for one failed or dead-lettered durable background job. */
export async function createBackgroundJobReplayPlan(
  backgroundJobId: string,
  dependencies: AdminDebugServiceDependencies,
): Promise<BackgroundJobReplayPlan> {
  const details = await getBackgroundJobDebugDetails(backgroundJobId, dependencies);
  if (!isReplayableBackgroundJobStatus(details.job.status)) {
    throw new AdminDebugNotFoundError("background_job", backgroundJobId);
  }

  const job = replayJobFromExistingJob(details.job, backgroundJobId, "job");
  const confirmationPayload = {
    action: "job.requeue",
    backgroundJobId,
    currentStatus: details.job.status,
    replayJob: toReplayConfirmationJob(job),
    failureCodes: details.failures.map((failure) => failure.code),
  };

  return {
    action: "job.requeue",
    backgroundJobId,
    currentStatus: details.job.status,
    queueName: job.queueName,
    jobType: job.jobType,
    job,
    failures: details.failures,
    confirmationToken: hashJson(confirmationPayload),
    requiresExplicitConfirmation: true,
  };
}

/** Executes a confirmed durable background job replay plan. */
export async function executeBackgroundJobReplay(
  backgroundJobId: string,
  confirmationToken: string,
  dependencies: AdminDebugServiceDependencies,
  actor: AdminReplayAuditActor,
): Promise<AdminReplayExecutionResult> {
  const plan = await createBackgroundJobReplayPlan(backgroundJobId, dependencies);
  assertConfirmationToken(confirmationToken, plan.confirmationToken);
  return insertReplayJobs({
    db: dependencies.db,
    action: plan.action,
    confirmationToken,
    jobs: [plan.job],
    audit: {
      actor,
      resourceType: "background_job",
      resourceId: backgroundJobId,
      orgId: plan.job.orgId,
      plan: auditPlanFromBackgroundJobReplayPlan(plan),
    },
  });
}

/** Cancels one pending, queued, or running durable background job. */
export async function cancelBackgroundJob(
  backgroundJobId: string,
  reason: string,
  dependencies: AdminDebugServiceDependencies,
  actor: AdminReplayAuditActor,
): Promise<AdminBackgroundJobCancelResult> {
  const normalizedReason = reason.trim();
  if (normalizedReason.length === 0) {
    throw new AdminDebugOperationError(
      "admin_debug.reason_required",
      "Background job cancellation requires a non-empty reason.",
      400,
    );
  }

  const existing = await getBackgroundJobRow(backgroundJobId, dependencies.db);
  if (!isCancelableBackgroundJobStatus(existing.status)) {
    throw new AdminDebugOperationError(
      "admin_debug.job_not_cancelable",
      `Background job ${backgroundJobId} is ${existing.status} and cannot be canceled.`,
      409,
    );
  }

  const canceledAt = new Date();
  const adminActionId = newId("admact");
  const auditLogId = newId("audit");
  const result = await dependencies.db.transaction(async (tx) => {
    const repository = new BackgroundJobRepository(tx);
    const cancelResult = await repository.cancelBackgroundJobById({
      backgroundJobId,
      now: canceledAt,
      reason: normalizedReason,
    });
    if (!cancelResult.job || !cancelResult.canceled || cancelResult.job.status !== "canceled") {
      throw new AdminDebugOperationError(
        "admin_debug.job_not_cancelable",
        `Background job ${backgroundJobId} could not be canceled because its status changed.`,
        409,
      );
    }

    const job = toBackgroundJobDebugSummary(cancelResult.job);
    const previousStatus = cancelResult.previousStatus ?? existing.status;
    await tx.insert(adminActions).values({
      adminActionId,
      actorType: actor.actorType,
      actorUserId: actor.actorUserId,
      completedAt: canceledAt,
      kind: "job.cancel",
      orgId: job.orgId,
      reason: normalizedReason,
      repoId: job.repoId,
      request: {
        backgroundJobId,
        previousStatus,
        reason: normalizedReason,
      },
      result: {
        backgroundJobId,
        currentStatus: job.status,
        previousStatus,
      },
      reviewRunId: job.reviewRunId,
      startedAt: canceledAt,
      status: "completed",
      ...(actor.supportSessionId ? { supportSessionId: actor.supportSessionId } : {}),
    });
    await tx.insert(auditLogs).values({
      auditLogId,
      action: "job.cancel",
      actorType: actor.actorType,
      actorUserId: actor.actorUserId,
      metadata: {
        actor: {
          role: actor.role,
          ...(actor.requestId ? { requestId: actor.requestId } : {}),
          ...(actor.sessionId ? { sessionId: actor.sessionId } : {}),
          ...(actor.supportSessionId ? { supportSessionId: actor.supportSessionId } : {}),
          ...(actor.provider ? { provider: actor.provider } : {}),
          ...(actor.permissions ? { permissions: actor.permissions } : {}),
          ...(actor.displayName ? { displayName: actor.displayName } : {}),
          ...(actor.email ? { email: actor.email } : {}),
        },
        adminActionId,
        currentStatus: job.status,
        previousStatus,
        reason: normalizedReason,
      },
      occurredAt: canceledAt,
      orgId: job.orgId,
      resourceId: backgroundJobId,
      resourceType: "background_job",
    });

    return {
      action: "job.cancel",
      adminActionId,
      auditLogId,
      backgroundJobId,
      canceledAt: toIso(canceledAt),
      currentStatus: "canceled",
      job,
      previousStatus,
      reason: normalizedReason,
    } satisfies AdminBackgroundJobCancelResult;
  });

  return result;
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
    sandboxRunRows,
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
    dependencies.db
      .select()
      .from(sandboxRuns)
      .where(eq(sandboxRuns.reviewRunId, reviewRunId))
      .orderBy(asc(sandboxRuns.createdAt)),
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
  const sandboxRunIds = sandboxRunRows.map((row) => row.sandboxRunId);
  const [sandboxArtifactRows, sandboxPolicyDecisionRows] = await Promise.all([
    listSandboxArtifactsForRuns(dependencies.db, sandboxRunIds),
    listSandboxPolicyDecisionsForRuns(dependencies.db, sandboxRunIds),
  ]);
  const sandboxArtifactsByRun = rowsBySandboxRunId(sandboxArtifactRows);
  const sandboxPolicyDecisionsByRun = rowsBySandboxRunId(sandboxPolicyDecisionRows);

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
  const sandboxRunSummaries = sandboxRunRows.map((row) =>
    toSandboxRunDebugSummary(
      row,
      sandboxArtifactsByRun.get(row.sandboxRunId) ?? [],
      sandboxPolicyDecisionsByRun.get(row.sandboxRunId) ?? [],
    ),
  );
  const failures = collectFailures([
    reviewRun.status === "failed" ? reviewFailure : undefined,
    ...stageEvents.map((stageEvent) => stageEvent.failure),
    ...relatedJobs.map((job) => job.failure),
    ...llmCallSummaries.map((llmCall) => llmCall.failure),
    ...sandboxRunSummaries.map((sandboxRun) => sandboxRun.failure),
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
    sandboxRuns: sandboxRunSummaries,
    relatedJobs,
    replayAudits,
    failures,
  };
}

/** Gets usage ledger events, billable units, costs, and quota state for one review run. */
export async function getUsageCostInspection(
  reviewRunId: string,
  dependencies: AdminDebugServiceDependencies,
): Promise<AdminUsageCostInspection> {
  const reviewRepository = new ReviewRepository(dependencies.db);
  const reviewRun = await reviewRepository.getReviewRun(reviewRunId);
  if (!reviewRun) {
    throw new AdminDebugNotFoundError("review_run", reviewRunId);
  }

  const orgId = await getRepositoryOrgId(dependencies.db, reviewRun.repoId);
  if (!orgId) {
    throw new AdminDebugNotFoundError("repository", reviewRun.repoId);
  }

  const [usageRows, quotaRows] = await Promise.all([
    dependencies.db
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.reviewRunId, reviewRunId))
      .orderBy(asc(usageEvents.occurredAt), asc(usageEvents.usageEventId)),
    dependencies.db
      .select({ counter: quotaCounters, reservation: quotaReservations })
      .from(quotaReservations)
      .innerJoin(quotaCounters, eq(quotaReservations.quotaCounterId, quotaCounters.quotaCounterId))
      .where(
        and(
          eq(quotaReservations.sourceType, "review_run"),
          eq(quotaReservations.sourceId, reviewRunId),
        ),
      )
      .orderBy(asc(quotaReservations.createdAt), asc(quotaReservations.quotaReservationId)),
  ]);

  return buildUsageCostInspection({
    orgId,
    repoId: reviewRun.repoId,
    reviewRunId,
    quotaDecisions: quotaRows.map((row) =>
      toAdminQuotaDecisionDebugSummary(row.reservation, row.counter),
    ),
    usageEvents: usageRows.map(toAdminUsageEventDebugSummary),
  });
}

/** Exports a redacted debug bundle for one review run and records an audit log first. */
export async function exportReviewRunDebugBundle(
  reviewRunId: string,
  dependencies: AdminDebugServiceDependencies,
  actor: AdminReplayAuditActor,
): Promise<AdminReviewRunDebugBundle> {
  const [reviewDetails, publisherDetails] = await Promise.all([
    getReviewDebugDetails(reviewRunId, dependencies),
    getPublisherDebugDetails(reviewRunId, dependencies),
  ]);
  const generatedAt = new Date();
  const generatedAtIso = toIso(generatedAt);
  const expiresAt = new Date(generatedAt.getTime() + 24 * 60 * 60 * 1000);
  const expiresAtIso = toIso(expiresAt);
  const repoOrgId = await getRepositoryOrgId(dependencies.db, reviewDetails.reviewRun.repoId);
  if (!repoOrgId) {
    throw new AdminDebugNotFoundError("repository", reviewDetails.reviewRun.repoId);
  }
  const payload = redactDebugBundleValue({
    publisher: publisherDetails,
    review: reviewDetails,
  });
  const payloadHash = hashJson(payload);
  const bundleId = newId("dbg");
  const adminActionId = newId("admact");
  const auditLogId = newId("audit");
  const debugExportId = newId("dbgexp");
  const actorSummary = debugBundleActorSummary(actor);

  await dependencies.db.transaction(async (tx) => {
    await tx.insert(adminActions).values({
      adminActionId,
      actorType: actor.actorType,
      actorUserId: actor.actorUserId,
      completedAt: generatedAt,
      kind: "debug_bundle.export",
      orgId: repoOrgId,
      reason: "Redacted debug bundle export from admin review inspector.",
      repoId: reviewDetails.reviewRun.repoId,
      request: {
        redactionLevel: "metadata",
        reviewRunId,
      },
      result: {
        bundleId,
        debugExportId,
        payloadHash,
      },
      reviewRunId,
      startedAt: generatedAt,
      status: "completed",
      ...(actor.supportSessionId ? { supportSessionId: actor.supportSessionId } : {}),
    });
    await tx.insert(debugExports).values({
      adminActionId,
      artifactHash: payloadHash,
      completedAt: generatedAt,
      createdByActorType: actor.actorType,
      createdByActorUserId: actor.actorUserId,
      debugExportId,
      expiresAt,
      exportKind: "review_run_debug_bundle",
      orgId: repoOrgId,
      redactionLevel: "metadata",
      repoId: reviewDetails.reviewRun.repoId,
      reviewRunId,
      status: "completed",
    });
    await tx.insert(auditLogs).values({
      auditLogId,
      orgId: repoOrgId,
      actorType: actor.actorType,
      actorUserId: actor.actorUserId,
      action: "debug_bundle.export",
      resourceType: "review_run",
      resourceId: reviewRunId,
      occurredAt: generatedAt,
      metadata: {
        actor: actorSummary,
        adminActionId,
        bundleId,
        debugExportId,
        expiresAt: expiresAtIso,
        generatedAt: generatedAtIso,
        payloadHash,
        redactionLevel: "metadata",
        repoId: reviewDetails.reviewRun.repoId,
      },
    });
  });

  return {
    schemaVersion: "admin_debug_bundle.v1",
    adminActionId,
    auditLogId,
    bundleId,
    debugExportId,
    expiresAt: expiresAtIso,
    generatedAt: generatedAtIso,
    generatedBy: actorSummary,
    payload,
    payloadHash,
    redactionLevel: "metadata",
    repoId: reviewDetails.reviewRun.repoId,
    reviewRunId,
  };
}

/** Recursively redacts sensitive values from a debug bundle payload. */
export function redactDebugBundleValue(value: unknown): unknown {
  return redactDebugBundleValueAtKey(value, "");
}

/** Creates an audited eval import draft from one review run. */
export async function createReviewRunEvalImportDraft(
  request: ImportReviewRunToEvalRequest,
  dependencies: AdminDebugServiceDependencies,
  actor: AdminReplayAuditActor,
): Promise<AdminReviewRunEvalImportDraft> {
  const reviewDetails = await getReviewDebugDetails(request.reviewRunId, dependencies);
  const repoOrgId = await getRepositoryOrgId(dependencies.db, reviewDetails.reviewRun.repoId);
  const generatedAt = new Date();
  const generatedAtIso = toIso(generatedAt);
  const importDraftId = newId("evaldraft");
  const adminActionId = newId("admact");
  const auditLogId = newId("audit");
  const warnings = evalImportWarnings(reviewDetails, request);
  const evalCase = buildReviewRunEvalCase(reviewDetails, request, warnings);
  const files = evalImportDraftFiles(evalCase, reviewDetails, request, warnings);

  await dependencies.db.transaction(async (tx) => {
    await tx.insert(adminActions).values({
      adminActionId,
      actorType: actor.actorType,
      actorUserId: actor.actorUserId,
      completedAt: generatedAt,
      kind: "eval_import.draft_create",
      orgId: repoOrgId,
      reason: request.reason,
      repoId: reviewDetails.reviewRun.repoId,
      request: {
        caseName: request.caseName,
        includeArtifacts: request.includeArtifacts,
        labels: request.labels ?? [],
        redactionLevel: request.redactionLevel,
        reviewRunId: request.reviewRunId,
        suiteId: request.suiteId,
      },
      result: {
        caseId: evalCase.caseId,
        filePaths: files.map((file) => file.path),
        importDraftId,
        warningCount: warnings.length,
      },
      reviewRunId: request.reviewRunId,
      startedAt: generatedAt,
      status: "completed",
      ...(actor.supportSessionId ? { supportSessionId: actor.supportSessionId } : {}),
    });
    await tx.insert(auditLogs).values({
      auditLogId,
      orgId: repoOrgId,
      actorType: actor.actorType,
      actorUserId: actor.actorUserId,
      action: "eval_import.draft_created",
      resourceType: "review_run",
      resourceId: request.reviewRunId,
      occurredAt: generatedAt,
      metadata: {
        actor: debugBundleActorSummary(actor),
        adminActionId,
        caseId: evalCase.caseId,
        importDraftId,
        redactionLevel: request.redactionLevel,
        repoId: reviewDetails.reviewRun.repoId,
        suiteId: request.suiteId,
        warningCount: warnings.length,
      },
    });
  });

  return {
    schemaVersion: "admin_eval_import_draft.v1",
    adminActionId,
    auditLogId,
    evalCase,
    files,
    generatedAt: generatedAtIso,
    generatedBy: debugBundleActorSummary(actor),
    importDraftId,
    redactionLevel: request.redactionLevel,
    repoId: reviewDetails.reviewRun.repoId,
    reviewRunId: request.reviewRunId,
    suiteId: request.suiteId,
    warnings,
  };
}

/** Builds a schema-validated eval case from review inspector details. */
export function buildReviewRunEvalCase(
  details: AdminReviewDebugDetails,
  request: ImportReviewRunToEvalRequest,
  warnings: readonly string[] = evalImportWarnings(details, request),
): EvalCase {
  const actualFindings = details.validatedFindings.flatMap(toEvalActualFinding);
  const expectedFindings = details.validatedFindings
    .filter((finding) => finding.decision === "publish")
    .flatMap(toEvalExpectedFinding);
  const changedFiles = evalChangedFiles(details, [...actualFindings, ...expectedFindings]);
  const latencyMs = reviewLatencyMs(details);
  const costUsd = details.llmCalls.reduce((sum, call) => sum + call.costMicros / 1_000_000, 0);

  return parseEvalCase({
    caseId: evalCaseId(request.suiteId, request.caseName, request.reviewRunId),
    title: request.caseName,
    description: `Imported from review run ${request.reviewRunId}. Reason: ${request.reason}`,
    tags: evalCaseTags(request, warnings),
    changedFiles,
    expectedContexts: [],
    retrievedContexts: [],
    expectedFindings,
    actualFindings,
    latencyMs,
    costUsd,
  });
}

/** Gets memory facts and effective repository rules for a repository inspector. */
export async function getMemoryRulesDebugDetails(
  repoId: string,
  dependencies: AdminDebugServiceDependencies,
): Promise<AdminMemoryRulesDebugDetails> {
  const repository = await getRepositoryForDebug(repoId, dependencies.db);
  const [facts, candidates, rules] = await Promise.all([
    listMemoryFactsForRepository(dependencies.db, {
      orgId: repository.orgId,
      repoId,
    }),
    listMemoryCandidatesForRepository(dependencies.db, {
      orgId: repository.orgId,
      repoId,
    }),
    new RepoRuleRepository(dependencies.db).listEffectiveRules({
      orgId: repository.orgId,
      repoId,
    }),
  ]);

  const memoryFactsSummary = facts.map(toMemoryFactDebugSummary);
  const memoryCandidatesSummary = candidates.map(toMemoryCandidateDebugSummary);
  const rulesSummary = [...rules]
    .sort(compareRepoRulesForDebug)
    .map((rule) => toRepoRuleDebugSummary(rule, repoId));

  return {
    repository: toMemoryRulesRepositorySummary(repository),
    memoryFacts: memoryFactsSummary,
    memoryCandidates: memoryCandidatesSummary,
    rules: rulesSummary,
    candidateActions: {
      canApprove: true,
      canReject: true,
      reason: "Pending candidates can be moderated through the scoped API.",
    },
    evaluationTools: [
      {
        toolId: "repository.policy_preview",
        label: "Policy preview",
        route: `/admin/repos/${repoId}/policy-preview`,
        status: "available",
      },
      {
        toolId: "repository.rules_crud",
        label: "Repository rules",
        route: `/admin/repos/${repoId}/rules`,
        status: "available",
      },
      {
        toolId: "finding.policy_evaluation",
        label: "Finding policy evaluation",
        reason:
          "Dedicated finding-evaluation inputs are not persisted yet; use review inspector validated findings with policy preview.",
        status: "unavailable",
      },
    ],
    warnings: memoryRulesWarnings(memoryFactsSummary, memoryCandidatesSummary, rulesSummary),
  };
}

/** Creates a replay plan for rerunning a persisted review input through the review worker. */
export async function createReviewReplayPlan(
  reviewRunId: string,
  dependencies: AdminDebugServiceDependencies,
): Promise<ReviewReplayPlan> {
  const details = await getReviewDebugDetails(reviewRunId, dependencies);
  const repoOrgId = await getRepositoryOrgId(dependencies.db, details.reviewRun.repoId);
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
    ...(repoOrgId ? { orgId: repoOrgId } : {}),
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

/** Replays deterministic retrieval without mutating production review state. */
export async function replayRetrievalDryRun(
  reviewRunId: string,
  dependencies: AdminDebugServiceDependencies,
): Promise<RetrievalReplayDryRun> {
  const reviewRepository = new ReviewRepository(dependencies.db);
  const pullRequestRepository = new PullRequestRepository(dependencies.db);
  const reviewRun = await reviewRepository.getReviewRun(reviewRunId);
  if (!reviewRun) {
    throw new AdminDebugNotFoundError("review_run", reviewRunId);
  }

  const warnings: string[] = [];
  const [snapshot, originalBundle] = await Promise.all([
    pullRequestRepository.getSnapshot(reviewRun.pullRequestSnapshotId),
    loadOriginalContextBundle(dependencies.db, reviewRunId, warnings),
  ]);
  if (!snapshot) {
    throw new AdminDebugNotFoundError("review_run", reviewRunId);
  }

  if (!originalBundle) {
    warnings.push("Review run has no persisted context bundle artifact to compare.");
  }

  const generatedAt = new Date().toISOString();
  const preferredIndexVersionId =
    stringField(asRecord(originalBundle?.metadata), "indexVersionId") ??
    (await findReadyIndexVersionId(dependencies.db, snapshot.repoId, snapshot.headSha));
  const retrievalIndex = preferredIndexVersionId
    ? createDatabaseRetrievalIndex({
        db: dependencies.db,
        indexVersionId: preferredIndexVersionId,
      })
    : undefined;
  if (!retrievalIndex) {
    warnings.push("Retrieval replay used diff fallback because no ready index version was found.");
  }
  const activeRules = await loadRetrievalReplayRules(dependencies.db, snapshot.repoId, warnings);

  const replayedBundle = await retrieveContext({
    reviewRunId,
    snapshot,
    indexAvailable: Boolean(retrievalIndex),
    ...(retrievalIndex ? { index: retrievalIndex } : {}),
    rules: { rules: activeRules },
    timestamp: generatedAt,
  });

  return {
    schemaVersion: "admin_retrieval_replay_dry_run.v1",
    comparisons: compareRetrievalReplayItems(originalBundle?.items ?? [], replayedBundle.items),
    generatedAt,
    mutatesProductionState: false,
    ...(originalBundle ? { original: retrievalReplayBundleSummary(originalBundle) } : {}),
    pullRequestSnapshotId: snapshot.snapshotId,
    replayed: retrievalReplayBundleSummary(replayedBundle),
    reviewRunId,
    warnings,
  };
}

/** Loads active rules for deterministic retrieval replay context. */
async function loadRetrievalReplayRules(
  db: HeimdallDatabase,
  repoId: string,
  warnings: string[],
): Promise<readonly RepoRule[]> {
  const orgId = await getRepositoryOrgId(db, repoId);
  if (!orgId) {
    warnings.push("Retrieval replay could not load repository rules because the repo row is gone.");
    return [];
  }

  return new RepoRuleRepository(db).listEffectiveRules({
    orgId,
    repoId,
  });
}

/** Replays deterministic finding validation without mutating production review state. */
export async function replayValidationDryRun(
  reviewRunId: string,
  dependencies: AdminDebugServiceDependencies,
): Promise<ValidationReplayDryRun> {
  const reviewRepository = new ReviewRepository(dependencies.db);
  const pullRequestRepository = new PullRequestRepository(dependencies.db);
  const reviewRun = await reviewRepository.getReviewRun(reviewRunId);
  if (!reviewRun) {
    throw new AdminDebugNotFoundError("review_run", reviewRunId);
  }

  const [snapshot, candidates, originalValidated] = await Promise.all([
    pullRequestRepository.getSnapshot(reviewRun.pullRequestSnapshotId),
    reviewRepository.listCandidateFindings(reviewRunId),
    reviewRepository.listValidatedFindings(reviewRunId),
  ]);
  if (!snapshot) {
    throw new AdminDebugNotFoundError("review_run", reviewRunId);
  }

  const warnings: string[] = [];
  const policy = await loadValidationReplayPolicy(dependencies.db, reviewRunId, warnings);
  const generatedAt = new Date().toISOString();
  const replayedValidated = validateAndRankCandidateFindings({
    findings: candidates,
    ...(policy ? { config: { policy } } : {}),
    snapshot,
    timestamp: generatedAt,
  });

  if (candidates.length === 0) {
    warnings.push("Review run has no candidate findings to validate.");
  }
  if (!policy) {
    warnings.push(
      "Validation replay used default validation policy because no policy snapshot was available.",
    );
  }

  return {
    schemaVersion: "admin_validation_replay_dry_run.v1",
    candidateFindingCount: candidates.length,
    comparisons: compareValidationReplayFindings(originalValidated, replayedValidated),
    generatedAt,
    mutatesProductionState: false,
    original: validationDecisionCounts(originalValidated),
    pullRequestSnapshotId: snapshot.snapshotId,
    replayed: validationDecisionCounts(replayedValidated),
    reviewRunId,
    warnings,
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
    new BackgroundJobRepository(dependencies.db)
      .listBackgroundJobsForReviewRun(reviewRunId)
      .then((jobs) =>
        jobs
          .filter((job) => job.jobType === JOB_TYPES.PublishReview)
          .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime()),
      ),
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
    | "provider_comment_missing"
    | "provider_inline_comment_untracked"
    | "provider_reconciliation_failed"
    | "provider_summary_comment_untracked"
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

/** Provider-visible publisher artifacts discovered during read-only reconciliation. */
export type ProviderPublisherArtifactSnapshot = {
  /** Inline review comment IDs keyed by validated finding ID parsed from hidden markers. */
  readonly inlineCommentIdsByFindingId: Readonly<Record<string, string>>;
  /** Provider IDs for summary issue comments with Heimdall summary markers. */
  readonly summaryCommentIds: readonly string[];
};

/** Minimal published-finding row used by provider reconciliation. */
export type ProviderPublishedFindingReconciliationRow = {
  /** Validated finding ID linked to the published row. */
  readonly validatedFindingId: string;
  /** Provider comment ID stored for the published finding, when available. */
  readonly providerCommentId?: string | null;
};

/** Minimal summary-comment row used by provider reconciliation. */
export type ProviderSummaryCommentReconciliationRow = {
  /** Provider summary comment ID stored for the durable row. */
  readonly providerCommentId: string;
};

/** Input used to compare provider-visible comments with durable publisher rows. */
export type ProviderPublisherReconciliationInput = {
  /** Review run being reconciled. */
  readonly reviewRunId: string;
  /** Publishable findings that should have provider rows after publish. */
  readonly findings: readonly Pick<ValidatedFinding, "findingId">[];
  /** Durable published-finding rows for the review run. */
  readonly publishedFindings: readonly ProviderPublishedFindingReconciliationRow[];
  /** Durable summary comment rows for the publish run. */
  readonly summaryComments: readonly ProviderSummaryCommentReconciliationRow[];
  /** Provider-visible comments discovered by hidden marker parsing. */
  readonly providerArtifacts: ProviderPublisherArtifactSnapshot;
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
  /** Number of provider-visible inline comments found by hidden marker parsing. */
  readonly providerInlineCommentCount?: number;
  /** Number of provider-visible summary comments found by hidden marker parsing. */
  readonly providerSummaryCommentCount?: number;
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
  /** Optional Git provider used for read-only provider-side reconciliation. */
  readonly gitProvider?: GitProvider;
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

/** Compares provider-visible publisher markers with durable publisher rows. */
export function reconcileProviderPublisherArtifacts(
  input: ProviderPublisherReconciliationInput,
): readonly PublisherReconciliationIssue[] {
  const issues: PublisherReconciliationIssue[] = [];
  const findingIds = new Set(input.findings.map((finding) => finding.findingId));
  const providerCommentIds = new Set([
    ...Object.values(input.providerArtifacts.inlineCommentIdsByFindingId),
    ...input.providerArtifacts.summaryCommentIds,
  ]);
  const publishedCommentIds = new Set(
    input.publishedFindings
      .map((finding) => finding.providerCommentId)
      .filter((providerCommentId): providerCommentId is string => Boolean(providerCommentId)),
  );
  const summaryCommentIds = new Set(
    input.summaryComments.map((summaryComment) => summaryComment.providerCommentId),
  );

  for (const [findingId, providerCommentId] of Object.entries(
    input.providerArtifacts.inlineCommentIdsByFindingId,
  )) {
    if (!findingIds.has(findingId)) {
      issues.push({
        code: "provider_inline_comment_untracked",
        message: `Provider inline comment ${providerCommentId} references unknown finding ${findingId}.`,
        rowId: providerCommentId,
      });
      continue;
    }
    if (!publishedCommentIds.has(providerCommentId)) {
      issues.push({
        code: "provider_inline_comment_untracked",
        message: `Provider inline comment ${providerCommentId} for finding ${findingId} is missing a durable published finding row.`,
        rowId: providerCommentId,
      });
    }
  }

  for (const providerCommentId of input.providerArtifacts.summaryCommentIds) {
    if (!summaryCommentIds.has(providerCommentId)) {
      issues.push({
        code: "provider_summary_comment_untracked",
        message: `Provider summary comment ${providerCommentId} is missing a durable summary comment row.`,
        rowId: providerCommentId,
      });
    }
  }

  for (const publishedFinding of input.publishedFindings) {
    if (
      publishedFinding.providerCommentId &&
      !providerCommentIds.has(publishedFinding.providerCommentId)
    ) {
      issues.push({
        code: "provider_comment_missing",
        message: `Durable published finding row references missing provider comment ${publishedFinding.providerCommentId}.`,
        rowId: publishedFinding.providerCommentId,
      });
    }
  }

  for (const summaryComment of input.summaryComments) {
    if (!providerCommentIds.has(summaryComment.providerCommentId)) {
      issues.push({
        code: "provider_comment_missing",
        message: `Durable summary comment row references missing provider comment ${summaryComment.providerCommentId}.`,
        rowId: summaryComment.providerCommentId,
      });
    }
  }

  return issues;
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
  const providerReconciliation = await loadProviderPublisherArtifactSnapshot(
    reviewRun,
    dependencies,
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
      ...providerReconciliationCounts(providerReconciliation),
      issues: [
        {
          code: "publish_run_missing",
          message: `Review run ${reviewRunId} has no durable publish run.`,
        },
        ...providerReconciliationIssues({
          findings,
          providerReconciliation,
          publishedFindingRows: [],
          reviewRunId,
          summaryComments: [],
        }),
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
  issues.push(
    ...providerReconciliationIssues({
      findings,
      providerReconciliation,
      publishedFindingRows,
      reviewRunId,
      summaryComments,
    }),
  );

  return {
    reviewRunId,
    publishRunId: publishRun.publishRunId,
    status: publishRun.status,
    operationCount: operations.length,
    checkRunCount: checkRuns.length,
    reviewCount: reviews.length,
    summaryCommentCount: summaryComments.length,
    publishedFindingCount: publishedFindingRows.length,
    ...providerReconciliationCounts(providerReconciliation),
    issues,
  };
}

async function loadProviderPublisherArtifactSnapshot(
  reviewRun: ReviewRun,
  dependencies: PublisherOperationsDependencies,
): Promise<
  | {
      readonly snapshot?: ProviderPublisherArtifactSnapshot;
      readonly error?: unknown;
    }
  | undefined
> {
  if (!dependencies.gitProvider) {
    return undefined;
  }

  try {
    const repository = await loadGitHubRepositoryRef(dependencies.db, reviewRun.repoId);
    const pullRequest = {
      ...repository,
      pullRequestNumber: reviewRun.pullRequestNumber,
    };
    const [summaryComments, reviewComments] = await Promise.all([
      dependencies.gitProvider.fetchExistingBotComments(pullRequest),
      dependencies.gitProvider.fetchExistingReviewComments(pullRequest),
    ]);

    return {
      snapshot: {
        inlineCommentIdsByFindingId: inlineCommentIdsByFindingIdFromProviderComments(
          reviewComments,
          reviewRun.reviewRunId,
        ),
        summaryCommentIds: summaryCommentIdsFromProviderComments(summaryComments, reviewRun),
      },
    };
  } catch (error) {
    return { error };
  }
}

function providerReconciliationCounts(
  reconciliation:
    | {
        readonly snapshot?: ProviderPublisherArtifactSnapshot;
        readonly error?: unknown;
      }
    | undefined,
): Pick<
  PublisherReconciliationReport,
  "providerInlineCommentCount" | "providerSummaryCommentCount"
> {
  if (!reconciliation?.snapshot) {
    return {};
  }

  return {
    providerInlineCommentCount: Object.keys(reconciliation.snapshot.inlineCommentIdsByFindingId)
      .length,
    providerSummaryCommentCount: reconciliation.snapshot.summaryCommentIds.length,
  };
}

function providerReconciliationIssues(input: {
  readonly findings: readonly ValidatedFinding[];
  readonly providerReconciliation:
    | {
        readonly snapshot?: ProviderPublisherArtifactSnapshot;
        readonly error?: unknown;
      }
    | undefined;
  readonly publishedFindingRows: readonly PublishedFindingRow[];
  readonly reviewRunId: string;
  readonly summaryComments: readonly ProviderSummaryCommentReconciliationRow[];
}): readonly PublisherReconciliationIssue[] {
  if (!input.providerReconciliation) {
    return [];
  }
  if (input.providerReconciliation.error) {
    return [
      {
        code: "provider_reconciliation_failed",
        message: `Provider reconciliation failed: ${errorMessage(input.providerReconciliation.error)}.`,
      },
    ];
  }
  if (!input.providerReconciliation.snapshot) {
    return [];
  }

  return reconcileProviderPublisherArtifacts({
    findings: input.findings,
    providerArtifacts: input.providerReconciliation.snapshot,
    publishedFindings: input.publishedFindingRows,
    reviewRunId: input.reviewRunId,
    summaryComments: input.summaryComments,
  });
}

function inlineCommentIdsByFindingIdFromProviderComments(
  comments: readonly ExistingBotComment[],
  reviewRunId: string,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    comments.flatMap((comment) =>
      parseGitHubCommentMarkers(comment.body)
        .filter(
          (marker): marker is Extract<GitHubCommentMarker, { readonly kind: "finding" }> =>
            marker.kind === "finding" && marker.reviewRunId === reviewRunId,
        )
        .map((marker) => [marker.findingId, comment.providerCommentId]),
    ),
  );
}

function summaryCommentIdsFromProviderComments(
  comments: readonly ExistingBotComment[],
  reviewRun: ReviewRun,
): readonly string[] {
  return [
    ...new Set(
      comments.flatMap((comment) =>
        parseGitHubCommentMarkers(comment.body).some((marker) =>
          summaryMarkerMatchesReviewRun(marker, reviewRun),
        )
          ? [comment.providerCommentId]
          : [],
      ),
    ),
  ];
}

function summaryMarkerMatchesReviewRun(marker: GitHubCommentMarker, reviewRun: ReviewRun): boolean {
  return (
    marker.kind === "summary" &&
    ((marker.scope === "review_run" && marker.reviewRunId === reviewRun.reviewRunId) ||
      (marker.scope === "pull_request" && marker.pullRequestNumber === reviewRun.pullRequestNumber))
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  const repoOrgId = await getRepositoryOrgId(dependencies.db, reviewRun.repoId);
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
    ...(repoOrgId ? { orgId: repoOrgId } : {}),
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
type BackgroundJobRow = BackgroundJobRecord;
type AuditLogRow = typeof auditLogs.$inferSelect;
type PullRequestSnapshotRow = typeof pullRequestSnapshots.$inferSelect;
type ReviewStageEventRow = typeof reviewRunStageEvents.$inferSelect;
type ReviewDependencyRow = typeof reviewRunDependencies.$inferSelect;
type ReviewArtifactRow = typeof reviewArtifacts.$inferSelect;
type SandboxRunRow = typeof sandboxRuns.$inferSelect;
type SandboxArtifactRow = typeof sandboxArtifacts.$inferSelect;
type SandboxPolicyDecisionRow = typeof sandboxPolicyDecisions.$inferSelect;
type CandidateFindingRow = typeof candidateFindings.$inferSelect;
type ValidatedFindingRow = typeof validatedFindings.$inferSelect;
type LlmCallRow = typeof llmCalls.$inferSelect;
type UsageEventRow = typeof usageEvents.$inferSelect;
type QuotaReservationRow = typeof quotaReservations.$inferSelect;
type QuotaCounterRow = typeof quotaCounters.$inferSelect;
type PublishRunRow = typeof publishRuns.$inferSelect;
type PublishOperationRow = typeof publishOperations.$inferSelect;
type PublishedCheckRunRow = typeof publishedCheckRuns.$inferSelect;
type PublishedReviewRow = typeof publishedReviews.$inferSelect;
type PublishedSummaryCommentRow = typeof publishedSummaryComments.$inferSelect;
type PublishedFindingRow = typeof publishedFindings.$inferSelect;
type MemoryFactRow = MemoryFactRecord;
type MemoryCandidateRow = MemoryCandidateRecord;
type IndexVersionRow = IndexVersionRecord;
type IndexImportBatchRow = typeof indexImportBatches.$inferSelect;
type EmbeddingJobRow = typeof embeddingJobs.$inferSelect;
type EmbeddingJobItemRow = typeof embeddingJobItems.$inferSelect;
type HeimdallTransaction = Parameters<Parameters<HeimdallDatabase["transaction"]>[0]>[0];
type HeimdallDbExecutor = HeimdallDatabase | HeimdallTransaction;

type MutableAdminUsageRollupDebugSummary = Omit<
  AdminUsageRollupDebugSummary,
  "costMicros" | "eventCount" | "quantity"
> & {
  /** Mutable usage quantity total. */
  quantity: number;
  /** Mutable usage event count. */
  eventCount: number;
  /** Mutable cost total in micro-USD. */
  costMicros: number;
};

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

/** Gets one durable background job row or raises an admin debug not-found error. */
async function getBackgroundJobRow(
  backgroundJobId: string,
  db: HeimdallDatabase,
): Promise<BackgroundJobRow> {
  const row = await new BackgroundJobRepository(db).getBackgroundJobById(backgroundJobId);

  if (!row) {
    throw new AdminDebugNotFoundError("background_job", backgroundJobId);
  }

  return row;
}

/** Gets one index version row or raises an admin debug not-found error. */
async function getIndexVersionRow(
  indexVersionId: string,
  db: HeimdallDatabase,
): Promise<IndexVersionRow> {
  const row = await new IndexVersionRepository(db).getIndexVersionRecord(indexVersionId);

  if (!row) {
    throw new AdminDebugNotFoundError("index_version", indexVersionId);
  }

  return row;
}

/** Counts imported file rows for one index version. */
async function countIndexedFileRows(db: HeimdallDatabase, indexVersionId: string): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(indexedFiles)
    .where(eq(indexedFiles.indexVersionId, indexVersionId));

  return Number(row?.value ?? 0);
}

/** Counts imported symbol rows for one index version. */
async function countSymbolRows(db: HeimdallDatabase, indexVersionId: string): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(symbols)
    .where(eq(symbols.indexVersionId, indexVersionId));

  return Number(row?.value ?? 0);
}

/** Counts imported code edge rows for one index version. */
async function countCodeEdgeRows(db: HeimdallDatabase, indexVersionId: string): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(codeEdges)
    .where(eq(codeEdges.indexVersionId, indexVersionId));

  return Number(row?.value ?? 0);
}

/** Counts imported code chunk rows for one index version. */
async function countCodeChunkRows(db: HeimdallDatabase, indexVersionId: string): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(codeChunks)
    .where(eq(codeChunks.indexVersionId, indexVersionId));

  return Number(row?.value ?? 0);
}

/** Counts imported index diagnostic rows for one index version. */
async function countCodeIndexDiagnosticRows(
  db: HeimdallDatabase,
  indexVersionId: string,
): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(codeIndexDiagnostics)
    .where(eq(codeIndexDiagnostics.indexVersionId, indexVersionId));

  return Number(row?.value ?? 0);
}

/** Counts imported dependency rows for one index version. */
async function countCodeDependencyRows(
  db: HeimdallDatabase,
  indexVersionId: string,
): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(codeDependencies)
    .where(eq(codeDependencies.indexVersionId, indexVersionId));

  return Number(row?.value ?? 0);
}

/** Counts imported route rows for one index version. */
async function countCodeRouteRows(db: HeimdallDatabase, indexVersionId: string): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(codeRoutes)
    .where(eq(codeRoutes.indexVersionId, indexVersionId));

  return Number(row?.value ?? 0);
}

/** Counts imported test mapping rows for one index version. */
async function countCodeTestMappingRows(
  db: HeimdallDatabase,
  indexVersionId: string,
): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(codeTestMappings)
    .where(eq(codeTestMappings.indexVersionId, indexVersionId));

  return Number(row?.value ?? 0);
}

/** Counts stored code chunk embedding rows for one index version. */
async function countCodeChunkEmbeddingRows(
  db: HeimdallDatabase,
  indexVersionId: string,
): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(codeChunkEmbeddings)
    .where(eq(codeChunkEmbeddings.indexVersionId, indexVersionId));

  return Number(row?.value ?? 0);
}

/** Lists import batches attached to one index version, newest first. */
async function listIndexImportBatchRows(
  db: HeimdallDatabase,
  indexVersionId: string,
): Promise<readonly IndexImportBatchRow[]> {
  return db
    .select()
    .from(indexImportBatches)
    .where(eq(indexImportBatches.indexVersionId, indexVersionId))
    .orderBy(desc(indexImportBatches.updatedAt));
}

/** Lists embedding jobs attached to one index version, newest first. */
async function listEmbeddingJobRowsForIndexVersion(
  db: HeimdallDatabase,
  indexVersionId: string,
): Promise<readonly EmbeddingJobRow[]> {
  return db
    .select()
    .from(embeddingJobs)
    .where(eq(embeddingJobs.indexVersionId, indexVersionId))
    .orderBy(desc(embeddingJobs.createdAt));
}

/** Gets one embedding job summary for background-job debug details. */
async function getEmbeddingJobDebugSummary(
  db: HeimdallDatabase,
  embeddingJobId: string,
): Promise<AdminEmbeddingJobDebugSummary | undefined> {
  const [row] = await db
    .select()
    .from(embeddingJobs)
    .where(eq(embeddingJobs.embeddingJobId, embeddingJobId))
    .limit(1);

  return row ? toEmbeddingJobDebugSummary(row) : undefined;
}

/** Lists a bounded sample of embedding job item summaries for debug details. */
async function listEmbeddingJobItemDebugSummaries(
  db: HeimdallDatabase,
  embeddingJobId: string,
): Promise<readonly AdminEmbeddingJobItemDebugSummary[]> {
  const rows = await db
    .select()
    .from(embeddingJobItems)
    .where(eq(embeddingJobItems.embeddingJobId, embeddingJobId))
    .limit(50);

  return rows.map(toEmbeddingJobItemDebugSummary);
}

/** Gets one repository contract or raises an admin debug not-found error. */
async function getRepositoryForDebug(repoId: string, db: HeimdallDatabase): Promise<Repository> {
  const repository = await new RepositoryRepository(db).getRepository(repoId);

  if (!repository) {
    throw new AdminDebugNotFoundError("repository", repoId);
  }

  return repository;
}

/** Lists memory facts that can apply to a repository. */
async function listMemoryFactsForRepository(
  db: HeimdallDatabase,
  input: {
    /** Organization that owns the inspected repository. */
    readonly orgId: string;
    /** Repository ID being inspected. */
    readonly repoId: string;
  },
): Promise<readonly MemoryFactRow[]> {
  return new MemoryFactRepository(db).listRepositoryMemoryFacts(input);
}

/** Lists memory candidates that can apply to a repository. */
async function listMemoryCandidatesForRepository(
  db: HeimdallDatabase,
  input: {
    /** Organization that owns the inspected repository. */
    readonly orgId: string;
    /** Repository ID being inspected. */
    readonly repoId: string;
  },
): Promise<readonly MemoryCandidateRow[]> {
  return new MemoryCandidateRepository(db).listRepositoryMemoryCandidates(input);
}

async function listJobsByKeys(
  db: HeimdallDbExecutor,
  jobKeys: readonly string[],
): Promise<readonly AdminBackgroundJobDebugSummary[]> {
  const rows = await new BackgroundJobRepository(db as HeimdallDatabase).listBackgroundJobsByKeys(
    jobKeys,
  );

  return rows.map(toBackgroundJobDebugSummary);
}

async function listReplayAuditLogs(
  db: HeimdallDatabase,
  input: {
    readonly actions: readonly (
      | WebhookReplayAction
      | BackgroundJobReplayAction
      | BackgroundJobCancelAction
      | ReviewReplayAction
      | PublisherReplayAction
    )[];
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
  const backgroundJobRepository = new BackgroundJobRepository(db);
  const rows = [
    ...(await backgroundJobRepository.listBackgroundJobsForReviewRun(input.reviewRunId)),
    ...(await backgroundJobRepository.listBackgroundJobsByKeys([reviewJobKey])).filter(
      (job) => job.jobType === JOB_TYPES.ReviewPullRequest,
    ),
  ];
  const seenJobIds = new Set<string>();
  const uniqueRows = rows
    .filter((job) => {
      if (seenJobIds.has(job.backgroundJobId)) {
        return false;
      }
      seenJobIds.add(job.backgroundJobId);
      return true;
    })
    .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());

  return uniqueRows.map(toBackgroundJobDebugSummary);
}

/** Lists artifact rows collected by the given sandbox runs. */
async function listSandboxArtifactsForRuns(
  db: HeimdallDatabase,
  sandboxRunIds: readonly string[],
): Promise<readonly SandboxArtifactRow[]> {
  if (sandboxRunIds.length === 0) {
    return [];
  }

  return db
    .select()
    .from(sandboxArtifacts)
    .where(inArray(sandboxArtifacts.sandboxRunId, [...sandboxRunIds]))
    .orderBy(asc(sandboxArtifacts.createdAt), asc(sandboxArtifacts.sandboxArtifactId));
}

/** Lists policy decision rows emitted by the given sandbox runs. */
async function listSandboxPolicyDecisionsForRuns(
  db: HeimdallDatabase,
  sandboxRunIds: readonly string[],
): Promise<readonly SandboxPolicyDecisionRow[]> {
  if (sandboxRunIds.length === 0) {
    return [];
  }

  return db
    .select()
    .from(sandboxPolicyDecisions)
    .where(inArray(sandboxPolicyDecisions.sandboxRunId, [...sandboxRunIds]))
    .orderBy(
      asc(sandboxPolicyDecisions.createdAt),
      asc(sandboxPolicyDecisions.sandboxPolicyDecisionId),
    );
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

/** Converts a repository row to a memory and rules inspector summary. */
function toMemoryRulesRepositorySummary(row: Repository): AdminMemoryRulesRepositorySummary {
  return {
    repoId: row.repoId,
    orgId: row.orgId,
    provider: row.provider,
    fullName: row.fullName,
    ...(row.defaultBranch ? { defaultBranch: row.defaultBranch } : {}),
    visibility: row.visibility,
    enabled: row.enabled,
    isArchived: row.isArchived,
    isFork: row.isFork,
  };
}

/** Converts a memory fact row to an operator-facing debug summary. */
function toMemoryFactDebugSummary(row: MemoryFactRow): AdminMemoryFactDebugSummary {
  const metadata = asRecord(row.metadata);
  const metadataKeys = sortedRecordKeys(metadata);

  return {
    memoryFactId: row.memoryFactId,
    orgId: row.orgId,
    ...(row.repoId ? { repoId: row.repoId } : {}),
    scope: row.repoId ? "repository" : "organization",
    factType: row.factType,
    body: row.body,
    status: row.status,
    confidence: row.confidence,
    ...(row.expiresAt ? { expiresAt: toIso(row.expiresAt) } : {}),
    metadataKeys,
    ...(metadataKeys.length > 0 && metadata ? { metadataHash: hashJson(metadata) } : {}),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

/** Converts a memory candidate row to an operator-facing debug summary. */
function toMemoryCandidateDebugSummary(row: MemoryCandidateRow): AdminMemoryCandidateDebugSummary {
  const metadata = asRecord(row.metadata);
  const metadataKeys = sortedRecordKeys(metadata);
  const proposedScope = asRecord(row.proposedScope);
  const proposedScopeKeys = sortedRecordKeys(proposedScope);
  const proposedAppliesTo = asRecord(row.proposedAppliesTo);
  const proposedAppliesToKeys = sortedRecordKeys(proposedAppliesTo);

  return {
    memoryCandidateId: row.memoryCandidateId,
    orgId: row.orgId,
    ...(row.repoId ? { repoId: row.repoId } : {}),
    sourceKind: row.sourceKind,
    candidateKind: row.candidateKind,
    proposedContent: row.proposedContent,
    status: row.status,
    confidence: row.confidence,
    trustLevel: row.trustLevel,
    ...(row.createdByLogin ? { createdByLogin: row.createdByLogin } : {}),
    ...(row.sourceFindingId ? { sourceFindingId: row.sourceFindingId } : {}),
    ...(row.approvedMemoryFactId ? { approvedMemoryFactId: row.approvedMemoryFactId } : {}),
    ...(row.decidedByUserId ? { decidedByUserId: row.decidedByUserId } : {}),
    ...(row.decidedAt ? { decidedAt: toIso(row.decidedAt) } : {}),
    ...(row.expiresAt ? { expiresAt: toIso(row.expiresAt) } : {}),
    proposedScopeKeys,
    ...(proposedScopeKeys.length > 0 && proposedScope
      ? { proposedScopeHash: hashJson(proposedScope) }
      : {}),
    proposedAppliesToKeys,
    ...(proposedAppliesToKeys.length > 0 && proposedAppliesTo
      ? { proposedAppliesToHash: hashJson(proposedAppliesTo) }
      : {}),
    metadataKeys,
    ...(metadataKeys.length > 0 && metadata ? { metadataHash: hashJson(metadata) } : {}),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

/** Converts a typed repository rule to an operator-facing debug summary. */
function toRepoRuleDebugSummary(rule: RepoRule, repoId: string): AdminRepoRuleDebugSummary {
  const metadataKeys = sortedRecordKeys(rule.metadata);

  return {
    ruleId: rule.ruleId,
    orgId: rule.orgId,
    ...(rule.repoId ? { repoId: rule.repoId } : {}),
    scope: rule.repoId === repoId ? "repository" : "organization",
    name: rule.name,
    ...(rule.description ? { description: rule.description } : {}),
    effect: rule.effect,
    matcher: rule.matcher,
    instruction: rule.instruction,
    priority: rule.priority,
    enabled: rule.enabled,
    ...(rule.createdByUserId ? { createdByUserId: rule.createdByUserId } : {}),
    metadataKeys,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  };
}

/** Sorts effective rules in policy evaluation order with disabled rules last. */
function compareRepoRulesForDebug(left: RepoRule, right: RepoRule): number {
  if (left.enabled !== right.enabled) {
    return left.enabled ? -1 : 1;
  }

  return left.priority - right.priority || left.ruleId.localeCompare(right.ruleId);
}

/** Builds warnings for the memory and rules inspector response. */
function memoryRulesWarnings(
  facts: readonly AdminMemoryFactDebugSummary[],
  candidates: readonly AdminMemoryCandidateDebugSummary[],
  rules: readonly AdminRepoRuleDebugSummary[],
): readonly string[] {
  const warnings: string[] = [];
  if (facts.length === 0) {
    warnings.push("No memory facts currently apply to this repository.");
  }
  if (candidates.length === 0) {
    warnings.push("No memory candidates currently apply to this repository.");
  }
  if (!rules.some((rule) => rule.enabled)) {
    warnings.push("No enabled repository or organization rules currently apply.");
  }

  return warnings;
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
    payload: row.envelope,
    ...(row.status === "failed" || row.status === "dead_lettered" ? { failure } : {}),
  };
}

/** Converts a durable index import batch row into an operator-facing summary. */
function toIndexImportBatchDebugSummary(
  row: IndexImportBatchRow,
): AdminIndexImportBatchDebugSummary {
  const metadata = asRecord(row.metadata);

  return {
    indexImportBatchId: row.indexImportBatchId,
    repoId: row.repoId,
    commitSha: row.commitSha,
    indexKey: row.indexKey,
    ...(row.indexVersionId ? { indexVersionId: row.indexVersionId } : {}),
    artifactUri: row.artifactUri,
    ...(row.artifactHash ? { artifactHash: row.artifactHash } : {}),
    status: row.status,
    phase: row.phase,
    recordCount: row.recordCount,
    fileCount: row.fileCount,
    symbolCount: row.symbolCount,
    edgeCount: row.edgeCount,
    chunkCount: row.chunkCount,
    diagnosticCount: row.diagnosticCount,
    dependencyCount: row.dependencyCount,
    routeCount: row.routeCount,
    testMappingCount: row.testMappingCount,
    embeddingJobCount: row.embeddingJobCount,
    ...(row.error !== null ? { error: row.error } : {}),
    metadataKeys: sortedRecordKeys(metadata),
    ...(row.startedAt ? { startedAt: toIso(row.startedAt) } : {}),
    ...(row.finishedAt ? { finishedAt: toIso(row.finishedAt) } : {}),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

/** Converts a durable embedding job row into an operator-facing summary. */
function toEmbeddingJobDebugSummary(row: EmbeddingJobRow): AdminEmbeddingJobDebugSummary {
  const metadata = asRecord(row.metadata);
  const failure = embeddingJobFailure(row);

  return {
    embeddingJobId: row.embeddingJobId,
    orgId: row.orgId,
    repoId: row.repoId,
    ...(row.indexVersionId ? { indexVersionId: row.indexVersionId } : {}),
    ...(row.commitSha ? { commitSha: row.commitSha } : {}),
    status: row.status,
    reason: row.reason,
    embeddingProfileVersion: row.embeddingProfileVersion,
    provider: row.provider,
    model: row.model,
    dimensions: row.dimensions,
    chunkCountPlanned: row.chunkCountPlanned,
    chunkCountEmbedded: row.chunkCountEmbedded,
    chunkCountSkipped: row.chunkCountSkipped,
    chunkCountFailed: row.chunkCountFailed,
    progressPercent: embeddingJobProgressPercent(row),
    attempts: row.attempts,
    ...(row.lockedBy ? { lockedBy: row.lockedBy } : {}),
    ...(row.lockedAt ? { lockedAt: toIso(row.lockedAt) } : {}),
    ...(row.lastErrorCode ? { lastErrorCode: row.lastErrorCode } : {}),
    ...(row.lastErrorMessage ? { lastErrorMessage: row.lastErrorMessage } : {}),
    metadataKeys: sortedRecordKeys(metadata),
    createdAt: toIso(row.createdAt),
    ...(row.startedAt ? { startedAt: toIso(row.startedAt) } : {}),
    ...(row.finishedAt ? { finishedAt: toIso(row.finishedAt) } : {}),
    ...(failure ? { failure } : {}),
  };
}

/** Converts a sampled embedding item row into an operator-facing summary. */
function toEmbeddingJobItemDebugSummary(
  row: EmbeddingJobItemRow,
): AdminEmbeddingJobItemDebugSummary {
  const failure = embeddingJobItemFailure(row);

  return {
    embeddingJobItemId: row.embeddingJobItemId,
    embeddingJobId: row.embeddingJobId,
    chunkId: row.chunkId,
    status: row.status,
    ...(row.cacheKey ? { cacheKey: row.cacheKey } : {}),
    attempts: row.attempts,
    ...(row.lastErrorCode ? { lastErrorCode: row.lastErrorCode } : {}),
    ...(row.lastErrorMessage ? { lastErrorMessage: row.lastErrorMessage } : {}),
    createdAt: toIso(row.createdAt),
    ...(row.startedAt ? { startedAt: toIso(row.startedAt) } : {}),
    ...(row.finishedAt ? { finishedAt: toIso(row.finishedAt) } : {}),
    ...(failure ? { failure } : {}),
  };
}

/** Extracts an embedding job ID from a durable embedding batch job payload. */
function embeddingJobIdFromBackgroundJob(row: BackgroundJobRow): string | undefined {
  if (row.jobType !== JOB_TYPES.EmbeddingBatch) {
    return undefined;
  }

  return stringField(asRecord(row.envelope.payload), "embeddingJobId");
}

/** Computes a rounded embedding completion percentage from durable counters. */
function embeddingJobProgressPercent(
  row: Pick<EmbeddingJobRow, "chunkCountPlanned"> & {
    readonly chunkCountEmbedded: number;
    readonly chunkCountSkipped: number;
    readonly chunkCountFailed: number;
  },
): number {
  if (row.chunkCountPlanned <= 0) {
    return 100;
  }

  const completed = row.chunkCountEmbedded + row.chunkCountSkipped + row.chunkCountFailed;
  return Math.max(0, Math.min(100, Math.round((completed / row.chunkCountPlanned) * 100)));
}

/** Returns a structured failure for terminal embedding job rows. */
function embeddingJobFailure(row: EmbeddingJobRow): AdminFailureDetail | undefined {
  if (row.status !== "failed") {
    return undefined;
  }

  return {
    source: "embedding_job",
    code: row.lastErrorCode ?? "embedding_job.failed",
    message: row.lastErrorMessage ?? `Embedding job ${row.embeddingJobId} failed.`,
    rowId: row.embeddingJobId,
    occurredAt: row.finishedAt ? toIso(row.finishedAt) : toIso(row.createdAt),
  };
}

/** Returns a structured failure for terminal embedding item rows. */
function embeddingJobItemFailure(row: EmbeddingJobItemRow): AdminFailureDetail | undefined {
  if (row.status !== "failed") {
    return undefined;
  }

  return {
    source: "embedding_job_item",
    code: row.lastErrorCode ?? "embedding_job_item.failed",
    message: row.lastErrorMessage ?? `Embedding item ${row.embeddingJobItemId} failed.`,
    rowId: row.embeddingJobItemId,
    occurredAt: row.finishedAt ? toIso(row.finishedAt) : toIso(row.createdAt),
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

/** Converts a sandbox artifact row into review inspector metadata. */
function toSandboxArtifactDebugSummary(row: SandboxArtifactRow): AdminSandboxArtifactDebugSummary {
  return {
    sandboxArtifactId: row.sandboxArtifactId,
    name: row.name,
    uri: row.uri,
    sha256: row.sha256,
    sizeBytes: row.sizeBytes,
    ...(row.contentType ? { contentType: row.contentType } : {}),
    truncated: row.truncated,
    createdAt: toIso(row.createdAt),
  };
}

/** Converts a persisted sandbox run and child rows into review inspector metadata. */
function toSandboxRunDebugSummary(
  row: SandboxRunRow,
  artifacts: readonly SandboxArtifactRow[],
  policyDecisions: readonly SandboxPolicyDecisionRow[],
): AdminSandboxRunDebugSummary {
  const failure = failureFromUnknown({
    source: "sandbox_run",
    fallbackCode: `sandbox.${row.status}`,
    fallbackMessage: `Sandbox run ${row.sandboxRunId} finished with status ${row.status}.`,
    rowId: row.sandboxRunId,
    occurredAt: row.finishedAt ? toIso(row.finishedAt) : undefined,
    error: row.errorJson,
  });

  return {
    sandboxRunId: row.sandboxRunId,
    requestId: row.requestId,
    runnerKind: row.runnerKind,
    trustLevel: row.trustLevel,
    category: row.category,
    ...(row.staticAnalysisRunId ? { staticAnalysisRunId: row.staticAnalysisRunId } : {}),
    ...(row.toolRunId ? { toolRunId: row.toolRunId } : {}),
    image: row.image,
    ...(row.imageDigest ? { imageDigest: row.imageDigest } : {}),
    status: row.status,
    ...(row.exitCode !== null ? { exitCode: row.exitCode } : {}),
    ...(row.signal ? { signal: row.signal } : {}),
    ...(row.stdoutHash ? { stdoutHash: row.stdoutHash } : {}),
    ...(row.stderrHash ? { stderrHash: row.stderrHash } : {}),
    stdoutTruncated: row.stdoutTruncated,
    stderrTruncated: row.stderrTruncated,
    warningCount: sandboxWarningCount(row.warningsJson),
    policyDecisionCounts: sandboxPolicyDecisionCounts(policyDecisions),
    artifacts: artifacts.map(toSandboxArtifactDebugSummary),
    ...(row.startedAt ? { startedAt: toIso(row.startedAt) } : {}),
    ...(row.finishedAt ? { finishedAt: toIso(row.finishedAt) } : {}),
    createdAt: toIso(row.createdAt),
    ...(isFailureSandboxStatus(row.status) ? { failure } : {}),
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

function toAdminUsageEventDebugSummary(row: UsageEventRow): AdminUsageEventDebugSummary {
  const metadata = asRecord(row.metadata);
  const metadataKeys = sortedRecordKeys(metadata);

  return {
    costMicros: row.costMicros,
    eventType: row.eventType,
    ...(metadata && metadataKeys.length > 0 ? { metadataHash: hashJson(metadata) } : {}),
    metadataKeys,
    occurredAt: toIso(row.occurredAt),
    orgId: row.orgId,
    quantity: row.quantity,
    ...(row.repoId ? { repoId: row.repoId } : {}),
    ...(row.reviewRunId ? { reviewRunId: row.reviewRunId } : {}),
    unit: row.unit,
    usageEventId: row.usageEventId,
  };
}

function toAdminQuotaDecisionDebugSummary(
  reservation: QuotaReservationRow,
  counter: QuotaCounterRow,
): AdminQuotaDecisionDebugSummary {
  return {
    ...(counter.limitQuantity === null ? {} : { limitQuantity: counter.limitQuantity }),
    createdAt: toIso(reservation.createdAt),
    expiresAt: toIso(reservation.expiresAt),
    periodKey: counter.periodKey,
    quantity: reservation.quantity,
    quotaKey: counter.quotaKey,
    quotaReservationId: reservation.quotaReservationId,
    ...(reservation.consumedAt ? { consumedAt: toIso(reservation.consumedAt) } : {}),
    ...(reservation.releasedAt ? { releasedAt: toIso(reservation.releasedAt) } : {}),
    reservedQuantity: counter.reservedQuantity,
    sourceId: reservation.sourceId,
    sourceType: reservation.sourceType,
    status: reservation.status,
    usedQuantity: counter.usedQuantity,
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

/** Groups rows that belong to the same sandbox run. */
function rowsBySandboxRunId<T extends { readonly sandboxRunId: string }>(
  rows: readonly T[],
): ReadonlyMap<string, readonly T[]> {
  const byRunId = new Map<string, T[]>();
  for (const row of rows) {
    const existing = byRunId.get(row.sandboxRunId);
    if (existing) {
      existing.push(row);
    } else {
      byRunId.set(row.sandboxRunId, [row]);
    }
  }

  return byRunId;
}

/** Counts product-safe policy decisions by status. */
function sandboxPolicyDecisionCounts(
  decisions: readonly SandboxPolicyDecisionRow[],
): AdminSandboxPolicyDecisionCounts {
  return decisions.reduce<AdminSandboxPolicyDecisionCounts>(
    (counts, decision) => ({
      allowed: counts.allowed + (decision.status === "allowed" ? 1 : 0),
      warning: counts.warning + (decision.status === "warning" ? 1 : 0),
      denied: counts.denied + (decision.status === "denied" ? 1 : 0),
    }),
    { allowed: 0, denied: 0, warning: 0 },
  );
}

/** Counts product-safe sandbox warnings stored as JSON. */
function sandboxWarningCount(warningsJson: unknown): number {
  return Array.isArray(warningsJson) ? warningsJson.length : 0;
}

/** Returns whether a sandbox run status should surface as a failure. */
function isFailureSandboxStatus(status: string): boolean {
  return [
    "failed",
    "killed",
    "policy_denied",
    "resource_exceeded",
    "runner_error",
    "timed_out",
  ].includes(status);
}

/** Compares persisted retrieval output with dry-run retrieval output. */
export function compareRetrievalReplayItems(
  original: readonly ContextItem[],
  replayed: readonly ContextItem[],
): readonly RetrievalReplayItemComparison[] {
  const originalByKey = new Map(original.map((item) => [retrievalReplayItemKey(item), item]));
  const replayedByKey = new Map(replayed.map((item) => [retrievalReplayItemKey(item), item]));
  const keys = [...new Set([...originalByKey.keys(), ...replayedByKey.keys()])].sort(
    (left, right) => left.localeCompare(right),
  );

  return keys.map((key) =>
    retrievalReplayComparison(key, originalByKey.get(key), replayedByKey.get(key)),
  );
}

/** Loads the original context bundle payload for a review run when present. */
async function loadOriginalContextBundle(
  db: HeimdallDatabase,
  reviewRunId: string,
  warnings: string[],
): Promise<ContextBundle | undefined> {
  const [row] = await db
    .select()
    .from(reviewArtifacts)
    .where(
      and(eq(reviewArtifacts.reviewRunId, reviewRunId), eq(reviewArtifacts.kind, "context_bundle")),
    )
    .orderBy(desc(reviewArtifacts.createdAt))
    .limit(1);
  const payload = asRecord(row?.metadata)?.payload;
  if (!payload) {
    return undefined;
  }

  try {
    return parseWithSchema("ContextBundle", ContextBundleSchema, payload);
  } catch (error) {
    warnings.push(
      `Stored context bundle could not be parsed for retrieval replay: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}

/** Returns the newest ready index version for a repository commit. */
async function findReadyIndexVersionId(
  db: HeimdallDatabase,
  repoId: string,
  commitSha: string,
): Promise<string | undefined> {
  const indexVersion = await new IndexVersionRepository(db).getLatestReadyIndexForCommit({
    commitSha,
    repoId,
  });

  return indexVersion?.indexVersionId;
}

/** Summarizes a context bundle for operator-facing retrieval replay output. */
function retrievalReplayBundleSummary(bundle: ContextBundle): RetrievalReplayBundleSummary {
  const metadata = asRecord(bundle.metadata);
  const indexVersionId = stringField(metadata, "indexVersionId");
  const retrievalMode = stringField(metadata, "retrievalMode");
  return {
    contextBundleId: bundle.contextBundleId,
    estimatedTokens: bundle.tokenBudget.estimatedTokens,
    itemCount: bundle.items.length,
    maxTokens: bundle.tokenBudget.maxTokens,
    ...(indexVersionId ? { indexVersionId } : {}),
    ...(retrievalMode ? { retrievalMode } : {}),
  };
}

/** Builds one comparison row for a retrieval dry-run context item. */
function retrievalReplayComparison(
  key: string,
  original: ContextItem | undefined,
  replayed: ContextItem | undefined,
): RetrievalReplayItemComparison {
  return {
    key,
    ...(original ? { originalKind: original.kind, originalPriority: original.priority } : {}),
    ...(original?.title ? { originalTitle: original.title } : {}),
    ...(original ? { originalItem: retrievalReplayItemInspection(original) } : {}),
    ...(replayed ? { replayedKind: replayed.kind, replayedPriority: replayed.priority } : {}),
    ...(replayed?.title ? { replayedTitle: replayed.title } : {}),
    ...(replayed ? { replayedItem: retrievalReplayItemInspection(replayed) } : {}),
    status: retrievalReplayStatus(original, replayed),
  };
}

/** Builds a bounded operator-facing inspection summary for a context item. */
function retrievalReplayItemInspection(item: ContextItem): RetrievalReplayItemInspection {
  const textPreview = retrievalReplayTextPreview(item);
  return {
    contextItemId: item.contextItemId,
    kind: item.kind,
    source: item.source,
    ...(item.title ? { title: item.title } : {}),
    ...(item.snippet?.path ? { path: item.snippet.path } : {}),
    ...(item.snippet?.range ? { lineRange: item.snippet.range } : {}),
    ...(item.snippet?.symbolId ? { symbolId: item.snippet.symbolId } : {}),
    ...(item.snippet?.chunkId ? { chunkId: item.snippet.chunkId } : {}),
    priority: item.priority,
    tokenEstimate: item.tokenEstimate,
    ...(item.score === undefined ? {} : { score: item.score }),
    retriever: item.provenance.retriever,
    reason: item.provenance.reason,
    ...(textPreview ? { textPreview } : {}),
    metadataKeys: sortedRecordKeys(asRecord(item.metadata)),
  };
}

/** Builds a short context preview without returning full context item text. */
function retrievalReplayTextPreview(item: ContextItem): string | undefined {
  const text = item.snippet?.text ?? item.text ?? item.summary;
  const normalized = text?.replaceAll(/\s+/gu, " ").trim();
  if (!normalized) {
    return undefined;
  }

  return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
}

/** Classifies one retrieval comparison row. */
function retrievalReplayStatus(
  original: ContextItem | undefined,
  replayed: ContextItem | undefined,
): RetrievalReplayItemComparison["status"] {
  if (!original) {
    return "added";
  }
  if (!replayed) {
    return "removed";
  }
  if (retrievalReplayItemSignature(original) === retrievalReplayItemSignature(replayed)) {
    return "unchanged";
  }

  return "changed";
}

/** Builds a comparable item signature without relying on the comparison key. */
function retrievalReplayItemSignature(item: ContextItem): string {
  return JSON.stringify({
    kind: item.kind,
    metadata: item.metadata,
    priority: item.priority,
    provenance: item.provenance,
    score: item.score,
    snippet: item.snippet,
    source: item.source,
    summary: item.summary,
    text: item.text,
    title: item.title,
    tokenEstimate: item.tokenEstimate,
  });
}

/** Builds a stable comparison key for original and replayed context items. */
function retrievalReplayItemKey(item: ContextItem): string {
  return item.snippet?.chunkId ?? item.provenance.relatedSymbolId ?? item.contextItemId;
}

/** Compares persisted validation output with dry-run validation output. */
export function compareValidationReplayFindings(
  original: readonly ValidatedFinding[],
  replayed: readonly ValidatedFinding[],
): readonly ValidationReplayFindingComparison[] {
  const originalByKey = new Map(original.map((finding) => [validationReplayKey(finding), finding]));
  const replayedByKey = new Map(replayed.map((finding) => [validationReplayKey(finding), finding]));
  const keys = [...new Set([...originalByKey.keys(), ...replayedByKey.keys()])].sort(
    (left, right) => left.localeCompare(right),
  );

  return keys.map((key) => {
    const originalFinding = originalByKey.get(key);
    const replayedFinding = replayedByKey.get(key);
    return validationReplayComparison(key, originalFinding, replayedFinding);
  });
}

/** Loads the effective policy snapshot used for validation replay when it is available. */
async function loadValidationReplayPolicy(
  db: HeimdallDatabase,
  reviewRunId: string,
  warnings: string[],
): Promise<EffectiveReviewPolicy | undefined> {
  const [row] = await db
    .select()
    .from(reviewArtifacts)
    .where(
      and(
        eq(reviewArtifacts.reviewRunId, reviewRunId),
        eq(reviewArtifacts.kind, "policy_snapshot"),
      ),
    )
    .orderBy(desc(reviewArtifacts.createdAt))
    .limit(1);

  const payload = asRecord(asRecord(row?.metadata)?.payload);
  const snapshotPayload = payload?.snapshot;
  if (!snapshotPayload) {
    return undefined;
  }

  try {
    return parseReviewPolicySnapshot(snapshotPayload).effectivePolicy;
  } catch (error) {
    warnings.push(
      `Stored policy snapshot could not be parsed for validation replay: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}

/** Counts validation decisions for an operator-facing replay summary. */
function validationDecisionCounts(
  findings: readonly ValidatedFinding[],
): ValidationReplayDecisionCounts {
  return {
    publish: findings.filter((finding) => finding.decision === "publish").length,
    reject: findings.filter((finding) => finding.decision === "reject").length,
  };
}

/** Builds one comparison row for a validation dry-run finding. */
function validationReplayComparison(
  key: string,
  original: ValidatedFinding | undefined,
  replayed: ValidatedFinding | undefined,
): ValidationReplayFindingComparison {
  const originalReasons = original?.validation.reasons ?? [];
  const replayedReasons = replayed?.validation.reasons ?? [];
  const candidateFindingId = original?.candidateFindingId ?? replayed?.candidateFindingId;
  const status = validationReplayStatus(original, replayed);
  return {
    key,
    ...(candidateFindingId ? { candidateFindingId } : {}),
    ...(original
      ? { originalDecision: original.decision, originalFindingId: original.findingId }
      : {}),
    originalReasons,
    ...(replayed
      ? { replayedDecision: replayed.decision, replayedFindingId: replayed.findingId }
      : {}),
    replayedReasons,
    status,
    title: original?.title ?? replayed?.title ?? key,
  };
}

/** Classifies one validation comparison row. */
function validationReplayStatus(
  original: ValidatedFinding | undefined,
  replayed: ValidatedFinding | undefined,
): ValidationReplayFindingComparison["status"] {
  if (!original) {
    return "added";
  }
  if (!replayed) {
    return "removed";
  }
  if (
    original.decision === replayed.decision &&
    original.rank === replayed.rank &&
    sameStringArray(original.validation.reasons, replayed.validation.reasons)
  ) {
    return "unchanged";
  }

  return "changed";
}

/** Builds a stable comparison key for original and replayed validation rows. */
function validationReplayKey(finding: ValidatedFinding): string {
  return finding.candidateFindingId || finding.fingerprint || finding.findingId;
}

/** Returns whether two string arrays contain the same values in the same order. */
function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
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
  replayScope: "webhook" | "job" = "webhook",
): AdminReplayJobPlan {
  const envelope = parseJobEnvelope(job.payload);
  const replayJobKey = `admin:${replayScope}:${replayScopeId}:${job.backgroundJobId}:${hashJson({
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

/** Returns whether a durable background job can be replayed through the generic job inspector. */
function isReplayableBackgroundJobStatus(status: string): boolean {
  return status === "failed" || status === "dead_lettered";
}

/** Returns whether a durable background job can be canceled by an operator. */
function isCancelableBackgroundJobStatus(status: string): boolean {
  return status === "pending" || status === "queued" || status === "running";
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
  readonly action:
    | WebhookReplayAction
    | BackgroundJobReplayAction
    | ReviewReplayAction
    | PublisherReplayAction;
  /** Confirmation token that authorized the replay. */
  readonly confirmationToken: string;
  /** Replay jobs to insert. */
  readonly jobs: readonly AdminReplayJobPlan[];
  /** Audit metadata to write with durable replay rows. */
  readonly audit: ReplayAuditInput;
}): Promise<AdminReplayExecutionResult> {
  return input.db.transaction(async (tx) => {
    const completedAt = new Date();
    const adminActionId = newId("admact");
    const replayRunId = newId("rply");
    const insertedJobIds: string[] = [];
    const backgroundJobRepository = new BackgroundJobRepository(tx as HeimdallDatabase);
    for (const job of input.jobs) {
      const result = await backgroundJobRepository.insertBackgroundJob({
        backgroundJobId: newId("job"),
        envelope: job.envelope,
        metadata: {
          replay: true,
          replaySource: job.source,
          ...(job.originalBackgroundJobId
            ? { originalBackgroundJobId: job.originalBackgroundJobId }
            : {}),
          ...(job.originalJobKey ? { originalJobKey: job.originalJobKey } : {}),
          confirmationToken: input.confirmationToken,
        },
        queueName: job.queueName,
        ...(job.orgId ? { orgId: job.orgId } : {}),
        ...(job.repoId ? { repoId: job.repoId } : {}),
        ...(job.reviewRunId ? { reviewRunId: job.reviewRunId } : {}),
      });

      if (result.inserted) {
        insertedJobIds.push(result.job.backgroundJobId);
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
    const result = {
      existingJobIds,
      insertedJobIds,
      replayJobIds: replayJobs.map((job) => job.backgroundJobId),
      replayJobKeys: replayJobs.map((job) => job.jobKey),
      replayRunId,
    };
    const adminActionReason = adminActionReasonForReplayAction(input.action);
    const orgId = input.audit.orgId ?? firstDefined(input.jobs.map((job) => job.orgId));
    const repoId = firstDefined(input.jobs.map((job) => job.repoId));
    const reviewRunId =
      firstDefined(input.jobs.map((job) => job.reviewRunId)) ??
      (input.audit.resourceType === "review_run" ? input.audit.resourceId : undefined);
    const replayStageSummaries = input.jobs.map((job, index) => ({
      jobType: job.jobType,
      queueName: job.queueName,
      replayJobKey: job.replayJobKey,
      source: job.source,
      stage: replayStageNameForJob(input.action, job, index),
    }));
    await tx.insert(adminActions).values({
      adminActionId,
      actorType: input.audit.actor.actorType,
      actorUserId: input.audit.actor.actorUserId,
      completedAt,
      kind: adminActionKindForReplayAction(input.action),
      orgId,
      reason: adminActionReason,
      repoId,
      request: {
        action: input.action,
        confirmationToken: input.confirmationToken,
        plan: input.audit.plan,
        resourceId: input.audit.resourceId,
        resourceType: input.audit.resourceType,
      },
      result,
      reviewRunId,
      startedAt: completedAt,
      status: "completed",
      ...(input.audit.actor.supportSessionId
        ? { supportSessionId: input.audit.actor.supportSessionId }
        : {}),
    });
    await tx.insert(replayRuns).values({
      replayRunId,
      adminActionId,
      completedAt,
      configOverrides: {},
      createdByActorType: input.audit.actor.actorType,
      createdByActorUserId: input.audit.actor.actorUserId,
      mode: "operator_dispatch",
      orgId,
      reason: adminActionReason,
      repoId,
      result,
      sourceReviewRunId: reviewRunId,
      stages: replayStageSummaries,
      startedAt: completedAt,
      status: "completed",
      ...(input.audit.actor.supportSessionId
        ? { supportSessionId: input.audit.actor.supportSessionId }
        : {}),
    });
    if (replayStageSummaries.length > 0) {
      await tx.insert(replayStageRuns).values(
        replayStageSummaries.map((stageSummary) => ({
          replayStageRunId: newId("rplystg"),
          replayRunId,
          completedAt,
          inputArtifactRef: {
            replayJobKey: stageSummary.replayJobKey,
          },
          metrics: {
            replayJobCount: 1,
          },
          outputArtifactRef: {
            replayJobKey: stageSummary.replayJobKey,
          },
          stage: stageSummary.stage,
          startedAt: completedAt,
          status: "completed",
        })),
      );
    }
    const auditLogId = await insertReplayAuditLog(tx, {
      ...input.audit,
      action: input.action,
      adminActionId,
      confirmationToken: input.confirmationToken,
      insertedJobIds,
      existingJobIds,
      replayRunId,
      replayJobs,
    });

    return {
      action: input.action,
      adminActionId,
      replayRunId,
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
    readonly action:
      | WebhookReplayAction
      | BackgroundJobReplayAction
      | ReviewReplayAction
      | PublisherReplayAction;
    readonly adminActionId: string;
    readonly confirmationToken: string;
    readonly insertedJobIds: readonly string[];
    readonly existingJobIds: readonly string[];
    readonly replayRunId: string;
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
        ...(input.actor.supportSessionId ? { supportSessionId: input.actor.supportSessionId } : {}),
        ...(input.actor.provider ? { provider: input.actor.provider } : {}),
        ...(input.actor.permissions ? { permissions: input.actor.permissions } : {}),
        ...(input.actor.displayName ? { displayName: input.actor.displayName } : {}),
        ...(input.actor.email ? { email: input.actor.email } : {}),
      },
      adminActionId: input.adminActionId,
      ...(input.actor.requestId ? { requestId: input.actor.requestId } : {}),
      ...(input.actor.supportSessionId ? { supportSessionId: input.actor.supportSessionId } : {}),
      confirmationToken: input.confirmationToken,
      plan: input.plan,
      replayRunId: input.replayRunId,
      result: {
        insertedJobIds: input.insertedJobIds,
        existingJobIds: input.existingJobIds,
        replayRunId: input.replayRunId,
        replayJobIds: input.replayJobs.map((job) => job.backgroundJobId),
        replayJobKeys: input.replayJobs.map((job) => job.jobKey),
      },
    },
  });

  return auditLogId;
}

/** Returns the durable admin action kind used for a replay dispatch. */
function adminActionKindForReplayAction(
  _action:
    | WebhookReplayAction
    | BackgroundJobReplayAction
    | ReviewReplayAction
    | PublisherReplayAction,
): "replay.dispatch" {
  return "replay.dispatch";
}

/** Returns the replay stage label stored for a dispatched durable job. */
function replayStageNameForJob(
  action:
    | WebhookReplayAction
    | BackgroundJobReplayAction
    | ReviewReplayAction
    | PublisherReplayAction,
  job: AdminReplayJobPlan,
  index: number,
): string {
  switch (action) {
    case "job.requeue":
      return "job_dispatch";
    case "publish.review":
      return "publisher_dispatch";
    case "review.requeue":
      return "review_dispatch";
    case "webhook.requeue_jobs":
      return `${job.source === "missing_job" ? "webhook_missing_job" : "webhook_existing_job"}_${
        index + 1
      }`;
  }
}

/** Returns a concise operator reason for a replay dispatch action record. */
function adminActionReasonForReplayAction(
  action:
    | WebhookReplayAction
    | BackgroundJobReplayAction
    | ReviewReplayAction
    | PublisherReplayAction,
): string {
  switch (action) {
    case "job.requeue":
      return "Operator-confirmed background job replay dispatch.";
    case "publish.review":
      return "Operator-confirmed publisher replay dispatch.";
    case "review.requeue":
      return "Operator-confirmed review replay dispatch.";
    case "webhook.requeue_jobs":
      return "Operator-confirmed webhook replay dispatch.";
  }
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

function auditPlanFromBackgroundJobReplayPlan(
  plan: BackgroundJobReplayPlan,
): Record<string, unknown> {
  return {
    action: plan.action,
    backgroundJobId: plan.backgroundJobId,
    currentStatus: plan.currentStatus,
    replayJob: toReplayConfirmationJob(plan.job),
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

/** Returns sorted object keys for metadata summaries. */
function sortedRecordKeys(value: Readonly<Record<string, unknown>> | undefined): readonly string[] {
  return value ? Object.keys(value).sort((left, right) => left.localeCompare(right)) : [];
}

/** Returns true when a usage event belongs in the requested usage/cost inspection. */
function usageEventBelongsToInspection(
  event: AdminUsageEventDebugSummary,
  input: Pick<BuildUsageCostInspectionInput, "orgId" | "repoId" | "reviewRunId">,
): boolean {
  return (
    event.orgId === input.orgId &&
    (!input.repoId || !event.repoId || event.repoId === input.repoId) &&
    (!input.reviewRunId || event.reviewRunId === input.reviewRunId)
  );
}

/** Groups usage events by event type and unit for review-run inspection. */
function summarizeAdminUsageRollups(
  usageRows: readonly AdminUsageEventDebugSummary[],
): readonly AdminUsageRollupDebugSummary[] {
  const rowsByKey = new Map<string, MutableAdminUsageRollupDebugSummary>();

  for (const event of usageRows) {
    const key = `${event.eventType}:${event.unit}`;
    const row =
      rowsByKey.get(key) ??
      ({
        costMicros: 0,
        eventCount: 0,
        eventType: event.eventType,
        quantity: 0,
        unit: event.unit,
      } satisfies MutableAdminUsageRollupDebugSummary);
    row.costMicros += event.costMicros;
    row.eventCount += 1;
    row.quantity += event.quantity;
    rowsByKey.set(key, row);
  }

  return [...rowsByKey.values()].sort(compareAdminUsageRollups);
}

/** Builds customer-understandable billable unit totals from usage events. */
function summarizeBillableUnits(
  usageRows: readonly AdminUsageEventDebugSummary[],
): Readonly<Record<string, number>> {
  const units: Record<string, number> = {};

  for (const event of usageRows) {
    const key = billableUnitKey(event);
    if (!key) {
      continue;
    }
    units[key] = (units[key] ?? 0) + event.quantity;
  }

  return Object.fromEntries(
    Object.entries(units).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey)),
  );
}

/** Returns the customer-facing billable unit key for a usage event when one exists. */
function billableUnitKey(event: AdminUsageEventDebugSummary): string | undefined {
  if (event.eventType === "review.credit" && event.unit === "credit") {
    return "review_credits";
  }
  if (event.eventType === "review.run" && event.unit === "count") {
    return "review_runs";
  }

  return undefined;
}

/** Builds warnings for weak or missing usage/cost inspection data. */
function usageCostInspectionWarnings(input: {
  /** Review run being inspected when available. */
  readonly reviewRunId?: string;
  /** Usage events included in the inspection. */
  readonly usageEvents: readonly AdminUsageEventDebugSummary[];
  /** Quota decisions included in the inspection. */
  readonly quotaDecisions: readonly AdminQuotaDecisionDebugSummary[];
}): readonly string[] {
  const warnings: string[] = [];
  if (input.usageEvents.length === 0) {
    warnings.push("No usage events are linked to this review run.");
  }
  if (input.reviewRunId && input.quotaDecisions.length === 0) {
    warnings.push("No quota reservation is linked to this review run.");
  }
  if (
    input.usageEvents.some(
      (event) =>
        event.eventType === "review.credit" && event.unit === "credit" && event.quantity < 0,
    )
  ) {
    warnings.push("Review credit usage includes a correction event.");
  }

  return warnings;
}

/** Formats micro-USD as a fixed USD decimal string. */
function microsToUsdString(micros: number): string {
  return (micros / 1_000_000).toFixed(6);
}

/** Sorts usage events in stable ledger display order. */
function compareAdminUsageEvents(
  left: AdminUsageEventDebugSummary,
  right: AdminUsageEventDebugSummary,
): number {
  return (
    left.occurredAt.localeCompare(right.occurredAt) ||
    left.usageEventId.localeCompare(right.usageEventId)
  );
}

/** Sorts usage rollups by event type and unit. */
function compareAdminUsageRollups(
  left: AdminUsageRollupDebugSummary,
  right: AdminUsageRollupDebugSummary,
): number {
  return left.eventType.localeCompare(right.eventType) || left.unit.localeCompare(right.unit);
}

/** Sorts quota decisions by period, quota key, and reservation ID. */
function compareAdminQuotaDecisions(
  left: AdminQuotaDecisionDebugSummary,
  right: AdminQuotaDecisionDebugSummary,
): number {
  return (
    left.periodKey.localeCompare(right.periodKey) ||
    left.quotaKey.localeCompare(right.quotaKey) ||
    left.quotaReservationId.localeCompare(right.quotaReservationId)
  );
}

/** Builds human-review warnings for an eval import draft. */
function evalImportWarnings(
  details: AdminReviewDebugDetails,
  request: ImportReviewRunToEvalRequest,
): readonly string[] {
  const warnings: string[] = [];
  if (request.redactionLevel === "raw_allowed") {
    warnings.push("Raw eval imports require a separate support-session approval before commit.");
  }
  if (request.includeArtifacts.rawDiff) {
    warnings.push("Raw diff content is not included in metadata-only admin import drafts.");
  }
  if (request.includeArtifacts.contextBundle) {
    warnings.push("Context bundle content is not included until artifact storage reads are gated.");
  }
  if (!details.snapshot) {
    warnings.push("Review run has no pull request snapshot summary.");
  }
  if (details.validatedFindings.length === 0) {
    warnings.push("Review run has no validated findings; this draft starts as a no-finding case.");
  }

  const skippedFindings = details.validatedFindings.filter(
    (finding) => !evalFindingLocation(finding.location),
  );
  if (skippedFindings.length > 0) {
    warnings.push(
      `${skippedFindings.length} finding(s) were skipped because their anchor is missing.`,
    );
  }

  return warnings;
}

/** Builds proposed files for a later human-approved eval fixture commit. */
function evalImportDraftFiles(
  evalCase: EvalCase,
  details: AdminReviewDebugDetails,
  request: ImportReviewRunToEvalRequest,
  warnings: readonly string[],
): readonly AdminEvalImportDraftFile[] {
  const basePath = `packages/evaluation/fixtures/${request.suiteId}/${evalCase.caseId}`;
  const files: AdminEvalImportDraftFile[] = [
    {
      content: evalCase,
      kind: "eval_case",
      path: `${basePath}/eval-case.json`,
    },
    {
      content: evalCase.expectedFindings,
      kind: "expected_findings",
      path: `${basePath}/expected-findings.json`,
    },
    {
      content: evalCase.actualFindings,
      kind: "actual_findings",
      path: `${basePath}/actual-findings.json`,
    },
    {
      content: evalImportNotesMarkdown(evalCase, request, warnings),
      kind: "notes",
      path: `${basePath}/notes.md`,
    },
  ];

  if (request.includeArtifacts.pullRequestSnapshot && details.snapshot) {
    files.push({
      content: details.snapshot,
      kind: "pull_request_snapshot",
      path: `${basePath}/pr-snapshot.json`,
    });
  }

  return files;
}

/** Renders review notes for a generated eval import draft. */
function evalImportNotesMarkdown(
  evalCase: EvalCase,
  request: ImportReviewRunToEvalRequest,
  warnings: readonly string[],
): string {
  return [
    `# ${request.caseName}`,
    "",
    `Source review run: \`${request.reviewRunId}\``,
    `Target suite: \`${request.suiteId}\``,
    `Redaction level: \`${request.redactionLevel}\``,
    "",
    `Reason: ${request.reason}`,
    "",
    `Expected findings: ${evalCase.expectedFindings.length}`,
    `Actual findings: ${evalCase.actualFindings.length}`,
    "",
    "## Warnings",
    warnings.length === 0 ? "- None" : warnings.map((warning) => `- ${warning}`).join("\n"),
  ].join("\n");
}

/** Builds stable tags for an imported eval case. */
function evalCaseTags(
  request: ImportReviewRunToEvalRequest,
  warnings: readonly string[],
): readonly string[] {
  const labels = request.labels?.map(slugPart).filter((label) => label.length > 0) ?? [];
  return [
    "production-import",
    request.redactionLevel,
    ...labels,
    ...(warnings.length > 0 ? ["needs-review"] : []),
  ];
}

/** Builds a deterministic eval case ID for a draft. */
function evalCaseId(suiteId: string, caseName: string, reviewRunId: string): string {
  const slug = slugPart(caseName) || "review-run";
  const hash = createHash("sha256")
    .update(`${suiteId}:${caseName}:${reviewRunId}`)
    .digest("hex")
    .slice(0, 10);
  return `case_${slug}_${hash}`;
}

/** Converts a validated finding summary into an eval actual finding when it has a valid anchor. */
function toEvalActualFinding(
  finding: AdminValidatedFindingDebugSummary,
): readonly EvalActualFinding[] {
  const location = evalFindingLocation(finding.location);
  if (!location) {
    return [];
  }

  return [
    {
      findingId: finding.findingId,
      title: finding.title,
      body: `Imported metadata-only finding ${finding.findingId}. Review the source run before approving this fixture.`,
      category: evalFindingCategory(finding.category),
      severity: evalFindingSeverity(finding.severity),
      location,
    },
  ];
}

/** Converts a publishable finding summary into an expected eval finding label. */
function toEvalExpectedFinding(
  finding: AdminValidatedFindingDebugSummary,
): readonly EvalExpectedFinding[] {
  const location = evalFindingLocation(finding.location);
  if (!location) {
    return [];
  }

  return [
    {
      expectedFindingId: `expected_${slugPart(finding.findingId)}`,
      title: finding.title,
      category: evalFindingCategory(finding.category),
      severity: evalFindingSeverity(finding.severity),
      location,
      bodyKeywords: bodyKeywords(finding.title),
      maxLineDistance: 0,
    },
  ];
}

/** Converts an unknown finding location payload into the eval location shape. */
function evalFindingLocation(value: unknown): EvalFindingLocation | undefined {
  const record = asRecord(value);
  const path = stringField(record, "path");
  const line = numberField(record, "line");
  if (!path || line === undefined || !Number.isInteger(line) || line < 1) {
    return undefined;
  }

  return { path, line };
}

/** Converts a review category into an eval-supported category. */
function evalFindingCategory(category: string): EvalActualFinding["category"] {
  const categories: readonly EvalActualFinding["category"][] = [
    "correctness",
    "security",
    "performance",
    "test_coverage",
    "maintainability",
    "architecture",
    "dependency",
    "documentation",
    "style",
    "other",
  ];
  return categories.includes(category as EvalActualFinding["category"])
    ? (category as EvalActualFinding["category"])
    : "other";
}

/** Converts a review severity into an eval-supported severity. */
function evalFindingSeverity(severity: string): EvalActualFinding["severity"] {
  const severities: readonly EvalActualFinding["severity"][] = [
    "info",
    "low",
    "medium",
    "high",
    "critical",
  ];
  return severities.includes(severity as EvalActualFinding["severity"])
    ? (severity as EvalActualFinding["severity"])
    : "medium";
}

/** Builds lightweight expected-body keywords from a finding title. */
function bodyKeywords(title: string): string[] {
  const keywords = title
    .split(/[^A-Za-z0-9_]+/u)
    .map((word) => word.trim().toLowerCase())
    .filter((word) => word.length >= 4)
    .slice(0, 4);
  return keywords.length > 0 ? keywords : ["review"];
}

/** Builds eval changed-file metadata from snapshot data plus finding anchors. */
function evalChangedFiles(
  details: AdminReviewDebugDetails,
  findings: readonly (EvalActualFinding | EvalExpectedFinding)[],
): readonly EvalChangedFile[] {
  const linesByPath = new Map<string, Set<number>>();
  for (const finding of findings) {
    const lines = linesByPath.get(finding.location.path) ?? new Set<number>();
    lines.add(finding.location.line);
    linesByPath.set(finding.location.path, lines);
  }

  const changedFiles = new Map<string, EvalChangedFile>();
  for (const file of details.snapshot?.changedFiles ?? []) {
    changedFiles.set(file.path, {
      path: file.path,
      changeType: evalChangeType(file.status),
      reviewableLines: [...(linesByPath.get(file.path) ?? new Set<number>())].sort(
        (left, right) => left - right,
      ),
    });
  }

  for (const [path, lines] of linesByPath) {
    if (!changedFiles.has(path)) {
      changedFiles.set(path, {
        path,
        changeType: "modified",
        reviewableLines: [...lines].sort((left, right) => left - right),
      });
    }
  }

  return [...changedFiles.values()].sort((left, right) => left.path.localeCompare(right.path));
}

/** Converts provider change status text into eval change types. */
function evalChangeType(status: string | undefined): EvalChangedFile["changeType"] {
  switch (status) {
    case "added":
      return "added";
    case "deleted":
    case "removed":
      return "deleted";
    case "renamed":
      return "renamed";
    case "generated":
      return "generated";
    default:
      return "modified";
  }
}

/** Computes review latency in milliseconds when start and completion timestamps are available. */
function reviewLatencyMs(details: AdminReviewDebugDetails): number {
  const startedAt = details.reviewRun.startedAt ? Date.parse(details.reviewRun.startedAt) : NaN;
  const completedAt = details.reviewRun.completedAt
    ? Date.parse(details.reviewRun.completedAt)
    : NaN;
  return Number.isFinite(startedAt) && Number.isFinite(completedAt)
    ? Math.max(0, completedAt - startedAt)
    : 0;
}

/** Converts arbitrary operator-facing text into a compact lowercase identifier fragment. */
function slugPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 48);
}

/** Looks up the organization that owns a repository for audit scoping. */
async function getRepositoryOrgId(
  db: HeimdallDatabase,
  repoId: string,
): Promise<string | undefined> {
  return new RepositoryRepository(db).getRepositoryOrgId(repoId);
}

/** Loads the GitHub repository reference needed for provider-side publisher reconciliation. */
async function loadGitHubRepositoryRef(
  db: HeimdallDatabase,
  repoId: string,
): Promise<GitHubRepositoryRef> {
  const repository = await new RepositoryRepository(db).getRepositoryProviderRef({
    provider: "github",
    repoId,
  });

  if (!repository) {
    throw new Error(`GitHub repository ${repoId} was not found.`);
  }

  return {
    provider: "github",
    installationId: repository.installationId,
    providerInstallationId: repository.providerInstallationId,
    owner: repository.owner,
    repo: repository.repo,
    providerRepoId: repository.providerRepoId,
  };
}

/** Converts a debug-bundle actor into a compact serializable summary. */
function debugBundleActorSummary(actor: AdminReplayAuditActor): AdminDebugBundleActorSummary {
  return {
    actorType: actor.actorType,
    actorUserId: actor.actorUserId,
    role: actor.role,
    ...(actor.requestId ? { requestId: actor.requestId } : {}),
    ...(actor.sessionId ? { sessionId: actor.sessionId } : {}),
    ...(actor.supportSessionId ? { supportSessionId: actor.supportSessionId } : {}),
    ...(actor.provider ? { provider: actor.provider } : {}),
    ...(actor.displayName ? { displayName: actor.displayName } : {}),
    ...(actor.email ? { email: actor.email } : {}),
  };
}

/** Recursively redacts values for fields that can contain source, prompt, or provider payloads. */
function redactDebugBundleValueAtKey(value: unknown, key: string): unknown {
  if (key && isSensitiveDebugBundleKey(key)) {
    return redactedDebugBundleValue(key, value);
  }

  if (value instanceof Date) {
    return toIso(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactDebugBundleValueAtKey(item, ""));
  }

  const record = asRecord(value);
  if (!record) {
    return value;
  }

  const redacted: Record<string, unknown> = {};
  for (const [fieldKey, fieldValue] of Object.entries(record)) {
    redacted[fieldKey] = redactDebugBundleValueAtKey(fieldValue, fieldKey);
  }
  return redacted;
}

/** Returns whether a debug bundle field name should be replaced with a hash placeholder. */
function isSensitiveDebugBundleKey(key: string): boolean {
  const normalizedKey = key.toLowerCase();
  if (normalizedKey.endsWith("hash")) {
    return false;
  }

  return (
    normalizedKey.includes("payload") ||
    normalizedKey.includes("prompt") ||
    normalizedKey.includes("response") ||
    normalizedKey.includes("body") ||
    normalizedKey.includes("diff") ||
    normalizedKey.includes("patch") ||
    normalizedKey.includes("content") ||
    normalizedKey.includes("snippet") ||
    normalizedKey.includes("evidence") ||
    normalizedKey.includes("code") ||
    normalizedKey.includes("secret") ||
    normalizedKey.includes("token") ||
    normalizedKey.includes("signature") ||
    normalizedKey.includes("authorization") ||
    normalizedKey.includes("cookie")
  );
}

/** Builds a redacted value placeholder that preserves correlation without leaking content. */
function redactedDebugBundleValue(key: string, value: unknown): AdminDebugBundleRedactedValue {
  const serialized = serializedDebugBundleValue(value);
  return {
    redacted: true,
    key,
    reason: "sensitive_field",
    sha256: `sha256:${createHash("sha256").update(serialized).digest("hex")}`,
    sizeBytes: Buffer.byteLength(serialized),
    valueType: debugBundleValueType(value),
  };
}

/** Serializes an unknown debug bundle value for hashing and byte-size accounting. */
function serializedDebugBundleValue(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return "[unserializable]";
  }
}

/** Returns a stable runtime type label for a debug bundle value. */
function debugBundleValueType(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
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
