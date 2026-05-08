import "./styles.css";
import { requestDashboardBlob, requestDashboardData, requestGatewayJson } from "./api-client";

/** Structured failure detail shown by admin inspectors. */
type AdminFailureDetail = {
  /** Source table or event that produced the failure. */
  readonly source: string;
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

/** Durable background job summary shown by inspectors. */
type AdminBackgroundJobDebugSummary = {
  /** Durable background job row ID. */
  readonly backgroundJobId: string;
  /** Queue that owns the job. */
  readonly queueName: string;
  /** Durable idempotency key. */
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
  readonly attempts?: number;
  /** Maximum durable attempts allowed. */
  readonly maxAttempts?: number;
  /** ISO timestamp when the job was scheduled. */
  readonly scheduledAt?: string;
  /** ISO timestamp when the job started. */
  readonly startedAt?: string;
  /** ISO timestamp when the job completed. */
  readonly completedAt?: string;
  /** ISO timestamp when the job was created. */
  readonly createdAt?: string;
  /** ISO timestamp when the job was updated. */
  readonly updatedAt?: string;
  /** Structured failure summary when the job failed. */
  readonly failure?: AdminFailureDetail;
  /** Raw validated or stored job envelope. */
  readonly payload?: unknown;
};

/** Replay audit row shown by inspectors. */
type AdminReplayAuditSummary = {
  /** Actor category stored in the audit log. */
  readonly actorType: string;
  /** Stable actor ID when available. */
  readonly actorUserId?: string;
  /** Replay action that was confirmed. */
  readonly action: string;
  /** ISO timestamp for the audited decision. */
  readonly occurredAt: string;
  /** Replay plan and result metadata recorded with the decision. */
  readonly metadata?: unknown;
};

/** Webhook debug response consumed by the dashboard. */
type AdminWebhookDebugDetails = {
  /** Webhook event summary. */
  readonly webhookEvent: {
    /** Current webhook status. */
    readonly status: string;
    /** Provider event name. */
    readonly eventName: string;
    /** Provider action when available. */
    readonly action?: string;
  };
  /** Expected durable job keys. */
  readonly expectedJobKeys: readonly string[];
  /** Related durable jobs. */
  readonly relatedJobs: readonly AdminBackgroundJobDebugSummary[];
  /** Audited replay decisions. */
  readonly replayAudits: readonly AdminReplayAuditSummary[];
  /** Structured failures. */
  readonly failures: readonly AdminFailureDetail[];
};

/** Background job debug response consumed by the dashboard. */
type AdminBackgroundJobDebugDetails = {
  /** Durable job summary. */
  readonly job: AdminBackgroundJobDebugSummary;
  /** Audited replay decisions. */
  readonly replayAudits: readonly AdminReplayAuditSummary[];
  /** Structured failures. */
  readonly failures: readonly AdminFailureDetail[];
};

/** Result returned after canceling one durable background job. */
type AdminBackgroundJobCancelResult = {
  /** Admin action that was executed. */
  readonly action: "job.cancel";
  /** Durable admin action row ID. */
  readonly adminActionId: string;
  /** Audit log row ID. */
  readonly auditLogId: string;
  /** Durable background job row ID. */
  readonly backgroundJobId: string;
  /** Status observed before cancellation. */
  readonly previousStatus: string;
  /** Current durable job status. */
  readonly currentStatus: "canceled";
  /** Product-safe operator reason. */
  readonly reason: string;
  /** ISO timestamp when the cancellation was recorded. */
  readonly canceledAt: string;
  /** Durable job summary after cancellation. */
  readonly job: AdminBackgroundJobDebugSummary;
};

/** Review debug response consumed by the dashboard. */
type AdminReviewDebugDetails = {
  /** Review run summary. */
  readonly reviewRun: {
    /** Review run ID. */
    readonly reviewRunId?: string;
    /** Repository ID that owns this review. */
    readonly repoId?: string;
    /** Current review status. */
    readonly status: string;
    /** Provider pull request number. */
    readonly pullRequestNumber: number;
    /** Review summary when available. */
    readonly summary?: string;
    /** Persisted finding counts. */
    readonly counts?: AdminReviewFindingCounts;
  };
  /** Pull request snapshot summary when available. */
  readonly snapshot?: {
    /** Pull request title. */
    readonly title?: string;
    /** Pull request author login. */
    readonly authorLogin?: string;
    /** Head SHA. */
    readonly headSha: string;
    /** Base SHA. */
    readonly baseSha: string;
    /** Changed file count. */
    readonly changedFileCount: number;
    /** Diff hash. */
    readonly diffHash: string;
  };
  /** Stage timeline. */
  readonly stageEvents: readonly {
    /** Stage name. */
    readonly stage: string;
    /** Stage status. */
    readonly status: string;
    /** ISO event timestamp. */
    readonly occurredAt: string;
  }[];
  /** Durable dependencies attached to the review run. */
  readonly dependencies?: readonly AdminReviewDependencySummary[];
  /** Review artifacts attached to the review run. */
  readonly artifacts?: readonly AdminReviewArtifactSummary[];
  /** Candidate finding summaries. */
  readonly candidateFindings: readonly AdminCandidateFindingSummary[];
  /** Validated finding summaries. */
  readonly validatedFindings: readonly AdminValidatedFindingSummary[];
  /** LLM call summaries linked to the review run. */
  readonly llmCalls?: readonly AdminLlmCallSummary[];
  /** Sandbox run summaries linked to the review run. */
  readonly sandboxRuns?: readonly AdminSandboxRunSummary[];
  /** Related durable jobs. */
  readonly relatedJobs: readonly AdminBackgroundJobDebugSummary[];
  /** Audited replay decisions. */
  readonly replayAudits: readonly AdminReplayAuditSummary[];
  /** Structured failures. */
  readonly failures: readonly AdminFailureDetail[];
};

/** Finding counts attached to one review run. */
type AdminReviewFindingCounts = {
  /** Candidate findings emitted before validation. */
  readonly candidateFindings: number;
  /** Findings accepted by validation. */
  readonly validatedFindings: number;
  /** Findings published to the provider. */
  readonly publishedFindings: number;
  /** Findings rejected by validation. */
  readonly rejectedFindings: number;
};

/** Durable dependency summary shown on review inspectors. */
type AdminReviewDependencySummary = {
  /** Dependency type. */
  readonly dependencyType: string;
  /** Dependency row ID. */
  readonly dependencyId: string;
};

/** Review artifact summary shown on review inspectors. */
type AdminReviewArtifactSummary = {
  /** Artifact row ID. */
  readonly reviewArtifactId: string;
  /** Review run that owns the artifact when returned by product APIs. */
  readonly reviewRunId?: string;
  /** Repository that owns the artifact when returned by product APIs. */
  readonly repoId?: string;
  /** Artifact kind. */
  readonly kind: string;
  /** Artifact display name. */
  readonly name: string;
  /** Artifact URI. */
  readonly uri: string;
  /** Artifact content hash when available. */
  readonly hash?: string;
  /** Artifact byte size. */
  readonly sizeBytes: number;
  /** Data classification label when available. */
  readonly classification?: string;
  /** Retention expiration timestamp when configured. */
  readonly retentionUntil?: string;
  /** Artifact creation timestamp. */
  readonly createdAt: string;
  /** Whether artifact metadata indicates an inline stored payload. */
  readonly hasStoredPayload?: boolean;
  /** Metadata keys present on the artifact row. */
  readonly metadataKeys?: readonly string[];
  /** Payload-free static-analysis counters when this artifact stores a static-analysis report. */
  readonly staticAnalysis?: AdminStaticAnalysisArtifactSummary;
};

/** Payload-free static-analysis counters attached to report artifacts. */
type AdminStaticAnalysisArtifactSummary = {
  /** Static-analysis report ID. */
  readonly reportId: string;
  /** Static-analysis mode used for the report. */
  readonly mode: string;
  /** Final static-analysis report status. */
  readonly status: string;
  /** Total static-analysis duration in milliseconds. */
  readonly durationMs: number;
  /** Planned tool run count. */
  readonly toolRunCount: number;
  /** Successful tool run count. */
  readonly succeededToolRunCount: number;
  /** Failed tool run count. */
  readonly failedToolRunCount: number;
  /** Timed-out tool run count. */
  readonly timedOutToolRunCount: number;
  /** Total normalized diagnostic count. */
  readonly diagnosticCount: number;
  /** Diagnostic count on changed lines. */
  readonly changedLineDiagnosticCount: number;
  /** Diagnostic count marked new by the analyzer. */
  readonly newDiagnosticCount: number;
  /** Error or critical diagnostic count. */
  readonly highSeverityDiagnosticCount: number;
  /** Product-safe warning count. */
  readonly warningCount: number;
};

/** Audited artifact payload response shown in product review inspectors. */
type AdminReviewArtifactPayloadSummary = {
  /** Payload-free artifact metadata. */
  readonly artifact: AdminReviewArtifactSummary;
  /** Artifact access event row written by the API. */
  readonly artifactAccessEventId: string;
  /** Payload access level authorized for this response. */
  readonly accessLevel: "redacted" | "raw_allowed";
  /** Redacted artifact payload returned by the API. */
  readonly payload: unknown;
};

/** Sandbox artifact metadata shown on review inspectors. */
type AdminSandboxArtifactSummary = {
  /** Sandbox artifact row ID. */
  readonly sandboxArtifactId: string;
  /** Artifact display name. */
  readonly name: string;
  /** Artifact URI. */
  readonly uri: string;
  /** Artifact SHA-256 digest. */
  readonly sha256: string;
  /** Artifact byte size. */
  readonly sizeBytes: number;
  /** Artifact content type when available. */
  readonly contentType?: string;
  /** Whether artifact persistence truncated the payload. */
  readonly truncated: boolean;
  /** Artifact creation timestamp. */
  readonly createdAt: string;
};

/** Product-safe policy decision counts for one sandbox run. */
type AdminSandboxPolicyDecisionCounts = {
  /** Allowed policy decision count. */
  readonly allowed: number;
  /** Warning policy decision count. */
  readonly warning: number;
  /** Denied policy decision count. */
  readonly denied: number;
};

/** Sandbox run metadata shown on review inspectors. */
type AdminSandboxRunSummary = {
  /** Sandbox run row ID. */
  readonly sandboxRunId: string;
  /** Unique sandbox request ID. */
  readonly requestId: string;
  /** Runner kind used for the execution. */
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
  /** Artifact metadata collected by the run. */
  readonly artifacts: readonly AdminSandboxArtifactSummary[];
  /** Execution start timestamp when available. */
  readonly startedAt?: string;
  /** Execution finish timestamp when available. */
  readonly finishedAt?: string;
  /** Row creation timestamp. */
  readonly createdAt: string;
};

/** Candidate finding summary shown on review inspectors. */
type AdminCandidateFindingSummary = {
  /** Finding ID. */
  readonly findingId: string;
  /** Finding source. */
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
  /** Candidate creation timestamp. */
  readonly createdAt: string;
};

/** Validated finding summary shown on review inspectors. */
type AdminValidatedFindingSummary = {
  /** Finding ID. */
  readonly findingId: string;
  /** Candidate finding ID. */
  readonly candidateFindingId: string;
  /** Validation decision. */
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
  /** Validation payload. */
  readonly validation: unknown;
};

/** LLM call summary shown on review inspectors. */
type AdminLlmCallSummary = {
  /** LLM call row ID. */
  readonly llmCallId: string;
  /** Provider used by the call. */
  readonly provider: string;
  /** Model used by the call. */
  readonly model: string;
  /** Call purpose. */
  readonly purpose: string;
  /** Call status. */
  readonly status: string;
  /** Input token count. */
  readonly inputTokens: number;
  /** Output token count. */
  readonly outputTokens: number;
  /** Cost in micros. */
  readonly costMicros: number;
  /** Start timestamp. */
  readonly startedAt: string;
};

/** Publisher reconciliation issue shown in dashboard state. */
type PublisherReconciliationIssue = {
  /** Machine-readable issue code. */
  readonly code: string;
  /** Human-readable issue message. */
  readonly message: string;
};

/** Publish run summary shown in the publisher inspector. */
type AdminPublishRunDebugSummary = {
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
  /** ISO timestamp when the publish run row was created. */
  readonly createdAt: string;
  /** Publish metadata captured by the worker. */
  readonly metadata?: unknown;
  /** Structured publish failure when available. */
  readonly failure?: AdminFailureDetail;
};

/** Low-level publish operation summary shown in the publisher inspector. */
type AdminPublishOperationDebugSummary = {
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

/** Durable publisher output row shown in the publisher inspector. */
type AdminPublisherOutputDebugRow = {
  /** Additional row fields returned by the debug API. */
  readonly [key: string]: unknown;
  /** Durable publish run that owns the output row. */
  readonly publishRunId?: string;
  /** Output provider name. */
  readonly provider?: string;
  /** Output publication status. */
  readonly status?: string;
  /** Provider check-run ID when this row represents a check run. */
  readonly providerCheckRunId?: string;
  /** Provider review ID when this row represents an inline review. */
  readonly providerReviewId?: string;
  /** Provider comment ID when this row represents a comment or finding. */
  readonly providerCommentId?: string;
  /** Published finding row ID when this row represents a finding. */
  readonly findingId?: string;
  /** Validated finding row ID when this row represents a finding. */
  readonly validatedFindingId?: string;
  /** Finding title when this row represents a finding. */
  readonly title?: string;
  /** Check-run conclusion when this row represents a check run. */
  readonly conclusion?: string;
  /** Summary comment body hash when this row represents a summary comment. */
  readonly bodyHash?: string;
  /** ISO timestamp when the output row was created. */
  readonly createdAt?: string;
  /** ISO timestamp when the finding was published. */
  readonly publishedAt?: string;
  /** Output metadata captured by the publisher. */
  readonly metadata?: unknown;
  /** Structured output failure when available. */
  readonly failure?: AdminFailureDetail;
};

/** Publisher debug response consumed by the dashboard. */
type AdminPublisherDebugDetails = {
  /** Repository that owns the review run. */
  readonly repoId: string;
  /** Publish run summaries. */
  readonly publishRuns: readonly AdminPublishRunDebugSummary[];
  /** Low-level publisher operation summaries. */
  readonly operations: readonly AdminPublishOperationDebugSummary[];
  /** Durable publisher output rows. */
  readonly outputs: {
    /** Provider check runs. */
    readonly checkRuns: readonly AdminPublisherOutputDebugRow[];
    /** Provider reviews. */
    readonly reviews: readonly AdminPublisherOutputDebugRow[];
    /** Fallback summary comments. */
    readonly summaryComments: readonly AdminPublisherOutputDebugRow[];
    /** Published findings. */
    readonly findings: readonly AdminPublisherOutputDebugRow[];
  };
  /** Related durable jobs. */
  readonly relatedJobs: readonly AdminBackgroundJobDebugSummary[];
  /** Audited replay decisions. */
  readonly replayAudits: readonly AdminReplayAuditSummary[];
  /** Reconciliation report. */
  readonly reconciliation: {
    /** Current publisher durable state. */
    readonly status: string;
    /** Check-run row count. */
    readonly checkRunCount: number;
    /** Provider review row count. */
    readonly reviewCount: number;
    /** Summary comment row count. */
    readonly summaryCommentCount: number;
    /** Published finding row count. */
    readonly publishedFindingCount: number;
    /** Reconciliation issues. */
    readonly issues: readonly PublisherReconciliationIssue[];
  };
  /** Structured failures. */
  readonly failures: readonly AdminFailureDetail[];
};

/** One durable replay job plan shown by replay planning. */
type AdminReplayJobPlan = {
  /** Queue that should receive the replay job. */
  readonly queueName: string;
  /** Handler type carried by the replay envelope. */
  readonly jobType: string;
  /** New idempotency key for the replay row. */
  readonly replayJobKey: string;
};

/** Webhook replay plan response. */
type WebhookReplayPlan = {
  /** Replay action. */
  readonly action: "webhook.requeue_jobs";
  /** Durable job IDs blocked from replay. */
  readonly blockedJobIds: readonly string[];
  /** Expected job keys missing from durable state. */
  readonly missingJobKeys: readonly string[];
  /** Replay jobs that can be inserted. */
  readonly jobs: readonly AdminReplayJobPlan[];
  /** Current failures. */
  readonly failures: readonly AdminFailureDetail[];
  /** Confirmation token for this plan. */
  readonly confirmationToken: string;
};

/** Background job replay plan response. */
type BackgroundJobReplayPlan = {
  /** Replay action. */
  readonly action: "job.requeue";
  /** Durable background job being replayed. */
  readonly backgroundJobId: string;
  /** Current durable job status. */
  readonly currentStatus: string;
  /** Queue that should receive the replay job. */
  readonly queueName: string;
  /** Handler type carried by the replay envelope. */
  readonly jobType: string;
  /** Replay job that can be inserted. */
  readonly job: AdminReplayJobPlan;
  /** Current failures. */
  readonly failures: readonly AdminFailureDetail[];
  /** Confirmation token for this plan. */
  readonly confirmationToken: string;
};

/** Review replay plan response. */
type ReviewReplayPlan = {
  /** Replay action. */
  readonly action: "review.requeue";
  /** Current review status. */
  readonly currentStatus: string;
  /** Related durable jobs. */
  readonly relatedJobs: readonly AdminBackgroundJobDebugSummary[];
  /** Replay job that can be inserted. */
  readonly job: AdminReplayJobPlan;
  /** Worker payload to replay. */
  readonly payload: unknown;
  /** Current failures. */
  readonly failures: readonly AdminFailureDetail[];
  /** Confirmation token for this plan. */
  readonly confirmationToken: string;
};

/** Publisher replay plan response. */
type PublisherReplayPlan = {
  /** Replay action. */
  readonly action: "publish.review";
  /** Replay job that can be inserted. */
  readonly job: AdminReplayJobPlan;
  /** Worker payload to replay. */
  readonly payload: unknown;
  /** Non-mutating publisher dry-run. */
  readonly dryRun: {
    /** Total publishable findings. */
    readonly findingCount: number;
    /** Planned comment outputs. */
    readonly comments: {
      /** Inline comment count. */
      readonly inlineCommentCount: number;
      /** Summary fallback count. */
      readonly summaryFallbackCount: number;
    };
  };
  /** Reconciliation report. */
  readonly reconciliation: {
    /** Current publisher durable state. */
    readonly status: string;
    /** Reconciliation issues. */
    readonly issues: readonly PublisherReconciliationIssue[];
  };
  /** Confirmation token for this plan. */
  readonly confirmationToken: string;
};

/** Context bundle summary for a retrieval replay dry-run. */
type RetrievalReplayBundleSummary = {
  /** Context bundle ID when present. */
  readonly contextBundleId?: string;
  /** Retrieval mode used by the bundle. */
  readonly retrievalMode?: string;
  /** Index version ID used by indexed retrieval. */
  readonly indexVersionId?: string;
  /** Context item count. */
  readonly itemCount: number;
  /** Estimated token count. */
  readonly estimatedTokens: number;
  /** Maximum token budget. */
  readonly maxTokens: number;
};

/** Inspectable retrieval context item summary. */
type RetrievalReplayItemInspection = {
  /** Stable context item ID. */
  readonly contextItemId: string;
  /** Context item kind. */
  readonly kind: string;
  /** Retrieval source. */
  readonly source: string;
  /** Context item title when present. */
  readonly title?: string;
  /** Repository path when present. */
  readonly path?: string;
  /** Line range when present. */
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
  /** Context packing priority. */
  readonly priority: number;
  /** Estimated token count. */
  readonly tokenEstimate: number;
  /** Retrieval score when present. */
  readonly score?: number;
  /** Retriever that selected the item. */
  readonly retriever: string;
  /** Product-safe selection reason. */
  readonly reason: string;
  /** Short context preview when present. */
  readonly textPreview?: string;
  /** Metadata keys present on the item. */
  readonly metadataKeys: readonly string[];
};

/** Context item comparison row for retrieval replay. */
type RetrievalReplayItemComparison = {
  /** Stable comparison key. */
  readonly key: string;
  /** Comparison status. */
  readonly status: "unchanged" | "changed" | "added" | "removed";
  /** Original item kind when present. */
  readonly originalKind?: string;
  /** Replayed item kind when present. */
  readonly replayedKind?: string;
  /** Original item title when present. */
  readonly originalTitle?: string;
  /** Replayed item title when present. */
  readonly replayedTitle?: string;
  /** Original item priority when present. */
  readonly originalPriority?: number;
  /** Replayed item priority when present. */
  readonly replayedPriority?: number;
  /** Original item inspection when present. */
  readonly originalItem?: RetrievalReplayItemInspection;
  /** Replayed item inspection when present. */
  readonly replayedItem?: RetrievalReplayItemInspection;
};

/** Non-mutating retrieval replay dry-run result. */
type RetrievalReplayDryRun = {
  /** Dry-run schema version. */
  readonly schemaVersion: "admin_retrieval_replay_dry_run.v1";
  /** Review run that was replayed. */
  readonly reviewRunId: string;
  /** Pull request snapshot used by retrieval. */
  readonly pullRequestSnapshotId: string;
  /** ISO timestamp when the dry-run was generated. */
  readonly generatedAt: string;
  /** Whether this dry-run mutated production state. */
  readonly mutatesProductionState: false;
  /** Original persisted context bundle summary when available. */
  readonly original?: RetrievalReplayBundleSummary;
  /** Replayed context bundle summary. */
  readonly replayed: RetrievalReplayBundleSummary;
  /** Item-level comparisons. */
  readonly comparisons: readonly RetrievalReplayItemComparison[];
  /** Warnings about dry-run fidelity. */
  readonly warnings: readonly string[];
};

/** Decision count block for a validation replay dry-run. */
type ValidationReplayDecisionCounts = {
  /** Publish decision count. */
  readonly publish: number;
  /** Reject decision count. */
  readonly reject: number;
};

/** Finding-level comparison row for validation replay. */
type ValidationReplayFindingComparison = {
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
  /** Comparison status. */
  readonly status: "unchanged" | "changed" | "added" | "removed";
  /** Finding title. */
  readonly title: string;
};

/** Non-mutating validation replay dry-run result. */
type ValidationReplayDryRun = {
  /** Dry-run schema version. */
  readonly schemaVersion: "admin_validation_replay_dry_run.v1";
  /** Review run that was replayed. */
  readonly reviewRunId: string;
  /** Pull request snapshot used by validation. */
  readonly pullRequestSnapshotId: string;
  /** ISO timestamp when the dry-run was generated. */
  readonly generatedAt: string;
  /** Whether this dry-run mutated production state. */
  readonly mutatesProductionState: false;
  /** Candidate finding input count. */
  readonly candidateFindingCount: number;
  /** Original persisted validation decision counts. */
  readonly original: ValidationReplayDecisionCounts;
  /** Replayed validation decision counts. */
  readonly replayed: ValidationReplayDecisionCounts;
  /** Finding-level comparisons. */
  readonly comparisons: readonly ValidationReplayFindingComparison[];
  /** Warnings about dry-run fidelity. */
  readonly warnings: readonly string[];
};

/** Replay execution result returned after dispatch. */
type AdminReplayExecutionResult = {
  /** Replay action that was confirmed. */
  readonly action: string;
  /** Durable admin action row ID for this replay dispatch. */
  readonly adminActionId: string;
  /** Durable replay run row ID for this replay dispatch. */
  readonly replayRunId: string;
  /** Audit log row ID when an actor was provided. */
  readonly auditLogId?: string | undefined;
  /** Durable job row IDs inserted for this replay. */
  readonly insertedJobIds: readonly string[];
  /** Durable job row IDs that already existed for the replay keys. */
  readonly existingJobIds: readonly string[];
  /** Replay jobs currently present in the durable outbox. */
  readonly replayJobs: readonly AdminBackgroundJobDebugSummary[];
};

/** Redacted review-run debug bundle returned by the admin API. */
type AdminReviewRunDebugBundle = {
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
  readonly redactionLevel: string;
  /** ISO timestamp when the bundle was generated. */
  readonly generatedAt: string;
  /** ISO timestamp when the debug bundle should no longer be used. */
  readonly expiresAt: string;
  /** Hash of the redacted payload returned to the operator. */
  readonly payloadHash: string;
  /** Audit log row written for the export. */
  readonly auditLogId: string;
  /** Redacted review, publisher, and replay metadata. */
  readonly payload: unknown;
};

/** Eval import draft returned by the admin API. */
type AdminReviewRunEvalImportDraft = {
  /** Draft contract version. */
  readonly schemaVersion: "admin_eval_import_draft.v1";
  /** Generated eval import draft ID. */
  readonly importDraftId: string;
  /** Durable admin action row ID for this draft creation. */
  readonly adminActionId: string;
  /** Review run used as the source. */
  readonly reviewRunId: string;
  /** Repository that owns the review run. */
  readonly repoId: string;
  /** Target suite ID. */
  readonly suiteId: string;
  /** Eval case generated from review state. */
  readonly evalCase: {
    /** Generated case ID. */
    readonly caseId: string;
    /** Case title. */
    readonly title: string;
    /** Changed files in the generated case. */
    readonly changedFiles: readonly unknown[];
    /** Expected findings in the generated case. */
    readonly expectedFindings: readonly unknown[];
    /** Actual findings in the generated case. */
    readonly actualFindings: readonly unknown[];
  };
  /** Proposed files for a later fixture commit. */
  readonly files: readonly {
    /** Proposed path. */
    readonly path: string;
    /** Proposed file kind. */
    readonly kind: string;
  }[];
  /** Redaction level used for generated files. */
  readonly redactionLevel: string;
  /** Warnings that require human review. */
  readonly warnings: readonly string[];
  /** Audit log row written for the draft creation. */
  readonly auditLogId: string;
};

/** Repository summary returned by the memory and rules inspector. */
type AdminMemoryRulesRepositorySummary = {
  /** Repository ID being inspected. */
  readonly repoId: string;
  /** Organization that owns the repository. */
  readonly orgId: string;
  /** Source code hosting provider. */
  readonly provider: string;
  /** Provider owner and repository name. */
  readonly fullName: string;
  /** Default branch when available. */
  readonly defaultBranch?: string;
  /** Provider visibility label. */
  readonly visibility: string;
  /** Whether reviews are enabled for the repository. */
  readonly enabled: boolean;
  /** Whether the provider marks the repository as archived. */
  readonly isArchived: boolean;
  /** Whether the provider marks the repository as a fork. */
  readonly isFork: boolean;
};

/** Memory fact row returned by the memory and rules inspector. */
type AdminMemoryFactDebugSummary = {
  /** Durable memory fact row ID. */
  readonly memoryFactId: string;
  /** Organization that owns the fact. */
  readonly orgId: string;
  /** Repository that owns the fact when repository-scoped. */
  readonly repoId?: string;
  /** Effective fact scope. */
  readonly scope: "repository" | "organization";
  /** Machine-readable fact type. */
  readonly factType: string;
  /** Stored fact body. */
  readonly body: string;
  /** Current fact status. */
  readonly status: string;
  /** Confidence score assigned to the fact. */
  readonly confidence: number;
  /** Fact expiration timestamp when temporary. */
  readonly expiresAt?: string;
  /** Metadata keys available on the row. */
  readonly metadataKeys: readonly string[];
  /** Hash of the metadata payload when metadata exists. */
  readonly metadataHash?: string;
  /** Fact creation timestamp. */
  readonly createdAt: string;
  /** Fact update timestamp. */
  readonly updatedAt: string;
};

/** Memory candidate row returned by the memory and rules inspector. */
type AdminMemoryCandidateDebugSummary = {
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
  /** Current candidate status. */
  readonly status: string;
  /** Candidate confidence score. */
  readonly confidence: number;
  /** Trust level assigned to the candidate. */
  readonly trustLevel: string;
  /** User login that created the candidate when available. */
  readonly createdByLogin?: string;
  /** Source finding ID when known. */
  readonly sourceFindingId?: string;
  /** Memory fact created from this candidate when approved. */
  readonly approvedMemoryFactId?: string;
  /** User ID that made the moderation decision when present. */
  readonly decidedByUserId?: string;
  /** Moderation decision timestamp when present. */
  readonly decidedAt?: string;
  /** Expiration timestamp when present. */
  readonly expiresAt?: string;
  /** Sorted proposed scope keys. */
  readonly proposedScopeKeys: readonly string[];
  /** Sorted proposed applies-to keys. */
  readonly proposedAppliesToKeys: readonly string[];
  /** Metadata keys available on the row. */
  readonly metadataKeys: readonly string[];
  /** Candidate creation timestamp. */
  readonly createdAt: string;
  /** Candidate update timestamp. */
  readonly updatedAt: string;
};

/** Memory fact row returned by product repository memory routes. */
type ProductMemoryFactSummary = {
  /** Durable memory fact row ID. */
  readonly memoryFactId: string;
  /** Memory fact kind shown to product users. */
  readonly kind: string;
  /** Human-readable memory text. */
  readonly text: string;
  /** Durable memory status. */
  readonly status: string;
  /** Memory fact scope. */
  readonly scope: "organization" | "repository";
  /** Confidence score assigned to the fact. */
  readonly confidence: number;
  /** Fact update timestamp. */
  readonly updatedAt: string;
};

/** Memory candidate row returned by product repository memory routes. */
type ProductMemoryCandidateSummary = {
  /** Durable memory candidate row ID. */
  readonly memoryCandidateId: string;
  /** Source that proposed the candidate. */
  readonly sourceKind: string;
  /** Candidate kind proposed by feedback processing. */
  readonly candidateKind: string;
  /** Proposed durable memory text. */
  readonly proposedContent: string;
  /** Candidate lifecycle status. */
  readonly status: string;
  /** Candidate confidence score. */
  readonly confidence: number;
  /** Trust level assigned to the proposing signal. */
  readonly trustLevel: string;
  /** Source finding ID when known. */
  readonly sourceFindingId?: string;
  /** Memory fact created from this candidate when approved. */
  readonly approvedMemoryFactId?: string;
  /** Moderation decision timestamp when present. */
  readonly decidedAt?: string;
  /** Candidate update timestamp. */
  readonly updatedAt: string;
};

/** Recent memory suppression match returned by product repository memory routes. */
type ProductSuppressionMatchSummary = {
  /** Durable suppression match row ID. */
  readonly suppressionMatchId: string;
  /** Review run that emitted the suppression decision. */
  readonly reviewRunId: string;
  /** Validated finding row suppressed by memory. */
  readonly findingId: string;
  /** Durable memory fact responsible for suppression. */
  readonly memoryFactId: string;
  /** Human-readable memory fact body. */
  readonly memoryText: string;
  /** Finding title associated with the suppressed candidate. */
  readonly findingTitle: string;
  /** Finding category associated with the suppressed candidate. */
  readonly findingCategory: string;
  /** Finding severity associated with the suppressed candidate. */
  readonly findingSeverity: string;
  /** Finding location associated with the suppressed candidate. */
  readonly location: unknown;
  /** Suppression match strategy. */
  readonly matchKind: string;
  /** Suppression matcher confidence from zero to one. */
  readonly confidence: number;
  /** Product-safe matcher reason when available. */
  readonly reason?: string;
  /** Match creation timestamp. */
  readonly createdAt: string;
};

/** Product repository memory response. */
type ProductRepositoryMemoryResponse = {
  /** Stored memory facts that can apply to the repository. */
  readonly memoryFacts: readonly ProductMemoryFactSummary[];
  /** Proposed memory candidates that can apply to the repository. */
  readonly memoryCandidates: readonly ProductMemoryCandidateSummary[];
  /** Recent suppression matches recorded for the repository. */
  readonly suppressionMatches: readonly ProductSuppressionMatchSummary[];
};

/** Effective rule row returned by the memory and rules inspector. */
type AdminRepoRuleDebugSummary = {
  /** Rule ID used by typed policy snapshots. */
  readonly ruleId: string;
  /** Organization that owns the rule. */
  readonly orgId: string;
  /** Repository that owns the rule when repository-scoped. */
  readonly repoId?: string;
  /** Effective rule scope. */
  readonly scope: "repository" | "organization";
  /** Human-readable rule name. */
  readonly name: string;
  /** Human-readable rule description when available. */
  readonly description?: string;
  /** Rule effect consumed by the policy engine. */
  readonly effect: string;
  /** Structured matcher consumed by the policy engine. */
  readonly matcher: AdminRepoRuleSummary["matcher"];
  /** Rule instruction consumed by policy and review context assembly. */
  readonly instruction: string;
  /** Rule priority. */
  readonly priority: number;
  /** Whether the rule is enabled. */
  readonly enabled: boolean;
  /** User that created the rule when available. */
  readonly createdByUserId?: string;
  /** Metadata keys available on the typed rule. */
  readonly metadataKeys: readonly string[];
  /** Rule creation timestamp. */
  readonly createdAt: string;
  /** Rule update timestamp. */
  readonly updatedAt: string;
};

/** Tool entry returned by the memory and rules inspector. */
type AdminMemoryRulesDebugTool = {
  /** Stable tool identifier. */
  readonly toolId: string;
  /** Human-readable tool label. */
  readonly label: string;
  /** Whether this tool is available. */
  readonly status: "available" | "unavailable";
  /** Admin API route for available tools. */
  readonly route?: string;
  /** Explanation for unavailable tools. */
  readonly reason?: string;
};

/** Memory and rules inspector response. */
type AdminMemoryRulesDebugDetails = {
  /** Repository being inspected. */
  readonly repository: AdminMemoryRulesRepositorySummary;
  /** Stored memory facts that can apply to the repository. */
  readonly memoryFacts: readonly AdminMemoryFactDebugSummary[];
  /** Proposed memory candidates that can apply to the repository. */
  readonly memoryCandidates: readonly AdminMemoryCandidateDebugSummary[];
  /** Effective repository and organization rules. */
  readonly rules: readonly AdminRepoRuleDebugSummary[];
  /** Candidate moderation support in the current implementation. */
  readonly candidateActions: {
    /** Whether approval is available. */
    readonly canApprove: boolean;
    /** Whether rejection is available. */
    readonly canReject: boolean;
    /** Explanation of the current moderation availability. */
    readonly reason: string;
  };
  /** Policy and finding evaluation tools. */
  readonly evaluationTools: readonly AdminMemoryRulesDebugTool[];
  /** Warnings that need operator attention. */
  readonly warnings: readonly string[];
};

/** Inspector kind available in the support console. */
type InspectorKind = "webhook" | "job" | "review" | "publisher" | "memory";

/** Primary dashboard view. */
type ViewKind =
  | "overview"
  | "inspectors"
  | "settings"
  | "evaluation"
  | "usage"
  | "plan"
  | "billing"
  | "security"
  | "audit";

/** Top-level console mode. */
type ConsoleMode = "product" | "admin";

/** Query-backed dashboard state parsed from the current browser URL. */
type DashboardRouteState = {
  /** Requested top-level console mode. */
  readonly mode?: ConsoleMode | undefined;
  /** Requested admin dashboard view. */
  readonly view?: ViewKind | undefined;
  /** Requested admin inspector tab. */
  readonly inspectorKind?: InspectorKind | undefined;
  /** Requested admin inspector resource ID. */
  readonly inspectorResourceId?: string | undefined;
  /** Requested product organization ID. */
  readonly productOrgId?: string | undefined;
  /** Requested product repository ID. */
  readonly productRepoId?: string | undefined;
  /** Requested product review run ID. */
  readonly productReviewRunId?: string | undefined;
  /** Requested product finding ID. */
  readonly productFindingId?: string | undefined;
  /** Requested admin settings repository ID. */
  readonly settingsRepoId?: string | undefined;
  /** Requested repository search text for the admin overview. */
  readonly repositorySearch?: string | undefined;
  /** Requested review repository filter for the admin overview. */
  readonly reviewRepoId?: string | undefined;
  /** Requested review status filter for the admin overview. */
  readonly reviewStatus?: string | undefined;
  /** Requested review search text for the admin overview. */
  readonly reviewSearch?: string | undefined;
  /** Requested evaluation suite ID. */
  readonly evaluationSuiteId?: string | undefined;
  /** Requested evaluation run ID. */
  readonly evaluationRunId?: string | undefined;
  /** Requested audit organization filter. */
  readonly auditOrgId?: string | undefined;
  /** Requested audit action filter. */
  readonly auditAction?: string | undefined;
  /** Requested audit resource type filter. */
  readonly auditResourceType?: string | undefined;
  /** Requested audit resource ID filter. */
  readonly auditResourceId?: string | undefined;
  /** Requested audit actor user ID filter. */
  readonly auditActorUserId?: string | undefined;
  /** Requested audit search text. */
  readonly auditSearch?: string | undefined;
  /** Requested security organization filter. */
  readonly securityOrgId?: string | undefined;
  /** Requested security repository filter. */
  readonly securityRepoId?: string | undefined;
  /** Requested security event type filter. */
  readonly securityType?: string | undefined;
  /** Requested security event severity filter. */
  readonly securitySeverity?: string | undefined;
  /** Requested security event source filter. */
  readonly securitySource?: string | undefined;
  /** Requested security event status filter. */
  readonly securityStatus?: string | undefined;
  /** Requested security event actor ID filter. */
  readonly securityActorId?: string | undefined;
  /** Requested security event resource type filter. */
  readonly securityResourceType?: string | undefined;
  /** Requested security event resource ID filter. */
  readonly securityResourceId?: string | undefined;
  /** Requested security event search text. */
  readonly securitySearch?: string | undefined;
  /** Requested usage organization filter. */
  readonly usageOrgId?: string | undefined;
  /** Requested usage repository filter. */
  readonly usageRepoId?: string | undefined;
  /** Requested usage period start filter. */
  readonly usagePeriodStart?: string | undefined;
  /** Requested usage period end filter. */
  readonly usagePeriodEnd?: string | undefined;
  /** Requested entitlement organization filter. */
  readonly entitlementOrgId?: string | undefined;
  /** Requested billing organization filter. */
  readonly billingOrgId?: string | undefined;
  /** Requested billing meter status filter. */
  readonly billingMeterStatus?: string | undefined;
  /** Requested billing meter period key filter. */
  readonly billingMeterPeriodKey?: string | undefined;
};

/** API envelope returned by the admin API for failed requests. */
type ApiErrorEnvelope = {
  /** Structured API error. */
  readonly error: {
    /** Machine-readable error code. */
    readonly code: string;
    /** Human-readable error message. */
    readonly message: string;
  };
};

/** Header names accepted by the admin API for trusted identity assertions. */
const ADMIN_IDENTITY_HEADER_NAMES = {
  assertion: "x-heimdall-idp-assertion",
  signature: "x-heimdall-idp-signature",
  timestamp: "x-heimdall-idp-timestamp",
} as const;

/** Gateway-issued identity assertion headers accepted by the admin API. */
type AdminIdentityRequestHeaders = {
  /** Base64url-encoded identity assertion emitted by the trusted gateway. */
  readonly [ADMIN_IDENTITY_HEADER_NAMES.assertion]: string;
  /** Assertion signature emitted by the trusted gateway. */
  readonly [ADMIN_IDENTITY_HEADER_NAMES.signature]: string;
  /** Assertion timestamp emitted by the trusted gateway. */
  readonly [ADMIN_IDENTITY_HEADER_NAMES.timestamp]: string;
};

/** Authenticated admin session returned by the API. */
type AdminSession = {
  /** Authenticated actor. */
  readonly actor: {
    /** Actor category. */
    readonly actorType: string;
    /** Stable actor user ID. */
    readonly userId: string;
    /** Granted access role. */
    readonly role: "support" | "admin";
    /** Display name when available. */
    readonly displayName?: string | undefined;
    /** Email when available. */
    readonly email?: string | undefined;
    /** Identity provider that authenticated the actor. */
    readonly provider?: string | undefined;
  };
  /** Capabilities granted to the actor. */
  readonly capabilities: {
    /** Whether the actor can inspect debug state. */
    readonly canInspect: boolean;
    /** Whether the actor can create replay plans. */
    readonly canPlanReplay: boolean;
    /** Whether the actor can execute replay. */
    readonly canExecuteReplay: boolean;
    /** Whether the actor can manage repository settings. */
    readonly canManageSettings: boolean;
    /** Whether the actor can view audit history. */
    readonly canViewAuditHistory: boolean;
  };
  /** Session-bound CSRF token used for mutations. */
  readonly csrfToken: string;
  /** Session expiration timestamp. */
  readonly expiresAt: string;
  /** Granular permissions granted to the actor. */
  readonly permissions: readonly string[];
  /** Granted organization and repository scopes. */
  readonly scopes: {
    /** Organization scope IDs. */
    readonly orgIds: readonly string[];
    /** Repository scope IDs. */
    readonly repoIds: readonly string[];
  };
  /** Opaque session ID. */
  readonly sessionId: string;
};

/** Repository summary returned by settings APIs. */
type ControlPlaneRepository = {
  /** Repository ID. */
  readonly repoId: string;
  /** Organization ID. */
  readonly orgId: string;
  /** Repository full name. */
  readonly fullName: string;
  /** Whether review automation is enabled. */
  readonly enabled: boolean;
};

/** Repository discovery row returned by admin overview routes. */
type AdminRepositorySummary = ControlPlaneRepository & {
  /** Repository visibility. */
  readonly visibility: string;
  /** Default branch when known. */
  readonly defaultBranch?: string;
  /** Repository update timestamp. */
  readonly updatedAt: string;
  /** Latest review run ID when available. */
  readonly latestReviewRunId?: string;
  /** Latest review status when available. */
  readonly latestReviewStatus?: string;
  /** Latest review update timestamp when available. */
  readonly latestReviewUpdatedAt?: string;
};

/** Review history row returned by admin overview routes. */
type AdminReviewRunSummary = {
  /** Review run ID. */
  readonly reviewRunId: string;
  /** Repository ID. */
  readonly repoId: string;
  /** Organization ID. */
  readonly orgId: string;
  /** Repository full name. */
  readonly repoFullName: string;
  /** Provider pull request number. */
  readonly pullRequestNumber: number;
  /** Pull request title when available. */
  readonly pullRequestTitle?: string;
  /** Pull request author when available. */
  readonly authorLogin?: string;
  /** Changed file count when available. */
  readonly changedFileCount?: number;
  /** Review trigger. */
  readonly trigger: string;
  /** Review status. */
  readonly status: string;
  /** Base commit SHA. */
  readonly baseSha: string;
  /** Head commit SHA. */
  readonly headSha: string;
  /** Review summary when available. */
  readonly summary?: string;
  /** Finding counts. */
  readonly counts: AdminReviewFindingCounts;
  /** Creation timestamp. */
  readonly createdAt: string;
  /** Update timestamp. */
  readonly updatedAt: string;
  /** Start timestamp when available. */
  readonly startedAt?: string;
  /** Completion timestamp when available. */
  readonly completedAt?: string;
  /** Structured failure summary when the review failed. */
  readonly failure?: AdminFailureDetail;
  /** Durable jobs tied to this review when detail data is loaded. */
  readonly relatedJobs?: readonly AdminBackgroundJobDebugSummary[];
};

/** Evaluation run summary returned by admin history routes. */
type EvaluationRunSummary = {
  /** Baseline variant ID when this run compares against one. */
  readonly baselineVariantId?: string;
  /** Source branch associated with the run when known. */
  readonly branch?: string;
  /** Number of cases evaluated. */
  readonly caseCount: number;
  /** Completion timestamp when the run finished. */
  readonly completedAt?: string;
  /** Execution environment label. */
  readonly environment: string;
  /** Structured run error when present. */
  readonly error?: unknown;
  /** Evaluation run ID. */
  readonly evalRunId: string;
  /** Evaluation suite ID. */
  readonly evalSuiteId: string;
  /** Evaluation variant ID. */
  readonly evalVariantId: string;
  /** Source commit SHA when known. */
  readonly gitCommitSha?: string;
  /** Report artifact URI when available. */
  readonly reportUri?: string;
  /** Run start timestamp. */
  readonly startedAt: string;
  /** Run status. */
  readonly status: string;
  /** Structured metric summary. */
  readonly summary?: unknown;
  /** Actor or system that triggered the run. */
  readonly triggeredBy: string;
};

/** Active baseline pointer returned with an evaluation suite. */
type EvaluationBaselineSummary = {
  /** Whether the baseline pointer is active. */
  readonly active: boolean;
  /** Baseline variant ID. */
  readonly baselineVariantId: string;
  /** Baseline creation timestamp. */
  readonly createdAt: string;
  /** Evaluation run ID when the baseline points at a run. */
  readonly evalRunId?: string;
  /** Evaluation suite ID. */
  readonly evalSuiteId: string;
};

/** Evaluation suite summary returned by admin history routes. */
type EvaluationSuiteSummary = {
  /** Active baseline pointer when configured. */
  readonly activeBaseline?: EvaluationBaselineSummary;
  /** Suite creation timestamp. */
  readonly createdAt: string;
  /** Default grader configuration. */
  readonly defaultGraders: unknown;
  /** Default runner key. */
  readonly defaultRunner: string;
  /** Suite description. */
  readonly description: string;
  /** Evaluation suite ID. */
  readonly evalSuiteId: string;
  /** Latest run summary when one exists. */
  readonly latestRun?: EvaluationRunSummary;
  /** Suite display name. */
  readonly name: string;
  /** Owning team or subsystem. */
  readonly owner: string;
  /** Suite tags. */
  readonly tags: unknown;
  /** Gate thresholds. */
  readonly thresholds: unknown;
  /** Suite update timestamp. */
  readonly updatedAt: string;
  /** Suite version. */
  readonly version: string;
};

/** Per-case result row returned for one evaluation run. */
type EvaluationCaseResultSummary = {
  /** Artifact references emitted for the case result. */
  readonly artifacts: unknown;
  /** Cost metrics emitted for the case result. */
  readonly costs: unknown;
  /** Case result creation timestamp. */
  readonly createdAt: string;
  /** Structured case error when present. */
  readonly error?: unknown;
  /** Evaluation case ID. */
  readonly evalCaseId: string;
  /** Evaluation case result ID. */
  readonly evalCaseResultId: string;
  /** Evaluation run ID. */
  readonly evalRunId: string;
  /** Matched finding references. */
  readonly matchedFindings: unknown;
  /** Score rows emitted by graders. */
  readonly scores: unknown;
  /** Case result status. */
  readonly status: string;
  /** Timing metrics emitted for the case result. */
  readonly timings: unknown;
  /** Expected finding references that were not matched. */
  readonly unmatchedExpectedFindings: unknown;
  /** Generated finding references that were not matched. */
  readonly unmatchedGeneratedFindings: unknown;
};

/** Evaluation run details returned by admin history routes. */
type EvaluationRunDetails = {
  /** Per-case result rows. */
  readonly caseResults: readonly EvaluationCaseResultSummary[];
  /** Evaluation run summary. */
  readonly run: EvaluationRunSummary;
};

/** Provider publication state attached to one review finding. */
type AdminReviewFindingPublicationSummary = {
  /** Published finding row ID. */
  readonly findingId: string;
  /** Provider that received the finding. */
  readonly provider: string;
  /** Publication status. */
  readonly status: string;
  /** Provider comment ID when the finding was published inline. */
  readonly providerCommentId?: string | undefined;
  /** Provider review ID when the finding was published in a review. */
  readonly providerReviewId?: string | undefined;
  /** Provider check-run ID when the finding was published to a check run. */
  readonly providerCheckRunId?: string | undefined;
  /** Publication error when present. */
  readonly error?: string | undefined;
  /** Publication timestamp when present. */
  readonly publishedAt?: string | undefined;
};

/** Latest human or system outcome attached to one finding. */
type AdminReviewFindingOutcomeSummary = {
  /** Outcome row ID. */
  readonly outcomeId: string;
  /** Outcome value. */
  readonly outcome: string;
  /** Outcome source. */
  readonly source: string;
  /** Optional human notes. */
  readonly notes?: string | undefined;
  /** Outcome timestamp. */
  readonly createdAt: string;
};

/** Feedback signal attached to one finding feedback event. */
type AdminReviewFindingFeedbackSignalSummary = {
  /** Feedback signal row ID. */
  readonly feedbackSignalId: string;
  /** Classified signal kind. */
  readonly signalKind: string;
  /** Signal polarity. */
  readonly polarity: string;
  /** Signal strength. */
  readonly strength: number;
  /** Classifier confidence. */
  readonly confidence: number;
  /** Product-safe signal reason. */
  readonly reason: string;
  /** Signal creation timestamp. */
  readonly createdAt: string;
};

/** Feedback event attached to one finding. */
type AdminReviewFindingFeedbackEventSummary = {
  /** Feedback event row ID. */
  readonly feedbackEventId: string;
  /** Provider that delivered the feedback. */
  readonly provider: string;
  /** Feedback source. */
  readonly source: string;
  /** Normalized event kind. */
  readonly eventKind: string;
  /** Provider event ID when available. */
  readonly externalEventId?: string | undefined;
  /** Actor login when available. */
  readonly actorLogin?: string | undefined;
  /** Pull request number when available. */
  readonly pullRequestNumber?: number | undefined;
  /** Provider comment ID when available. */
  readonly externalCommentId?: string | undefined;
  /** Redacted event metadata. */
  readonly payloadRedacted?: Record<string, unknown> | undefined;
  /** Event receipt timestamp. */
  readonly receivedAt: string;
  /** Classified signals for this event. */
  readonly signals: readonly AdminReviewFindingFeedbackSignalSummary[];
};

/** Finding row returned by scoped review finding APIs. */
type AdminReviewFindingSummary = {
  /** Canonical validated finding ID. */
  readonly findingId: string;
  /** Candidate finding ID emitted before validation. */
  readonly candidateFindingId: string;
  /** Published finding ID when available. */
  readonly publishedFindingId?: string | undefined;
  /** Review run that produced the finding. */
  readonly reviewRunId: string;
  /** Repository that owns the finding. */
  readonly repoId: string;
  /** Organization that owns the finding. */
  readonly orgId: string;
  /** Repository full name. */
  readonly repoFullName: string;
  /** Validation decision. */
  readonly decision: string;
  /** Finding category. */
  readonly category: string;
  /** Finding severity. */
  readonly severity: string;
  /** Finding title. */
  readonly title: string;
  /** Finding body. */
  readonly body: string;
  /** Finding location. */
  readonly location: unknown;
  /** Evidence payload captured for the finding. */
  readonly evidence: unknown;
  /** Finding confidence. */
  readonly confidence: number;
  /** Validation payload captured for the finding. */
  readonly validation: unknown;
  /** Rank within the review when available. */
  readonly rank?: number | undefined;
  /** Stable duplicate-detection fingerprint. */
  readonly fingerprint: string;
  /** Finding metadata. */
  readonly metadata?: Record<string, unknown> | undefined;
  /** Publication state when available. */
  readonly publication?: AdminReviewFindingPublicationSummary | undefined;
  /** Latest outcome when available. */
  readonly latestOutcome?: AdminReviewFindingOutcomeSummary | undefined;
};

/** Response returned after creating a suppress-similar rule. */
type AdminFindingSuppressionSummary = {
  /** Finding that seeded the suppression. */
  readonly finding: AdminReviewFindingSummary;
  /** Created or reused suppression rule. */
  readonly rule: AdminRepoRuleSummary;
  /** Suppression scope that was applied. */
  readonly scope: "repo" | "org";
  /** Audit row written by the API. */
  readonly auditLogId: string;
};

/** API health status returned by readiness probes. */
type ApiHealthStatus = "fail" | "pass";

/** One API readiness check shown in the operator overview. */
type ApiHealthCheck = {
  /** Stable subsystem name. */
  readonly name: string;
  /** Product-safe health status. */
  readonly status: ApiHealthStatus;
  /** Optional product-safe check detail. */
  readonly message?: string;
};

/** Product-safe API readiness summary shown in the operator overview. */
type ApiHealthResponse = {
  /** Individual readiness checks. */
  readonly checks: readonly ApiHealthCheck[];
  /** Whether all checks passed. */
  readonly ok: boolean;
  /** Service identifier. */
  readonly service: "api";
  /** Aggregate readiness status. */
  readonly status: ApiHealthStatus;
  /** ISO timestamp for the health response. */
  readonly timestamp: string;
};

/** Dashboard overview response. */
type AdminDashboardOverview = {
  /** Scoped repositories available to the actor. */
  readonly repositories: readonly AdminRepositorySummary[];
  /** Recent review runs available to the actor. */
  readonly recentReviews: readonly AdminReviewRunSummary[];
  /** Durable review rollup metrics for the current actor scope. */
  readonly reviewMetrics: AdminReviewMetricsSummary;
  /** Recent audit entries when the actor has audit access. */
  readonly recentAuditLogs: readonly AdminAuditLogSummary[];
  /** Product-safe API readiness summary. */
  readonly runtimeHealth: ApiHealthResponse;
};

/** Durable review rollup metrics returned by the overview API. */
type AdminReviewMetricsSummary = {
  /** Total review runs in scope. */
  readonly totalRuns: number;
  /** Completed review runs in scope. */
  readonly completedRuns: number;
  /** Failed review runs in scope. */
  readonly failedRuns: number;
  /** Skipped review runs in scope. */
  readonly skippedRuns: number;
  /** Superseded review runs in scope. */
  readonly supersededRuns: number;
  /** Median end-to-end duration in milliseconds when metrics exist. */
  readonly medianDurationMs?: number;
  /** P95 end-to-end duration in milliseconds when metrics exist. */
  readonly p95DurationMs?: number;
  /** Candidate findings recorded by terminal review metrics. */
  readonly candidateFindings: number;
  /** Validated findings recorded by terminal review metrics. */
  readonly validatedFindings: number;
  /** Published findings recorded by terminal review metrics. */
  readonly publishedFindings: number;
  /** Rejected findings recorded by terminal review metrics. */
  readonly rejectedFindings: number;
  /** Average published findings per review run. */
  readonly averagePublishedFindings: number;
  /** Estimated review cost in USD as a decimal string. */
  readonly estimatedCostUsd: string;
  /** ISO timestamp when the rollup was generated. */
  readonly generatedAt: string;
};

/** Product GitHub App setup returned by the public onboarding API. */
type ProductGitHubAppSetup = {
  /** Whether the deployment is ready to accept a GitHub App install. */
  readonly configured: boolean;
  /** GitHub App ID when configured. */
  readonly appId?: string;
  /** GitHub App slug when configured. */
  readonly appSlug?: string;
  /** GitHub App install URL. */
  readonly installUrl?: string;
  /** Whether webhook signature verification is configured. */
  readonly webhookConfigured: boolean;
  /** Webhook URL to configure in GitHub. */
  readonly webhookUrl?: string;
};

/** Product installation row returned by the public onboarding API. */
type ProductInstallationSummary = {
  /** Git provider. */
  readonly provider: string;
  /** GitHub account login. */
  readonly accountLogin: string;
  /** GitHub account type. */
  readonly accountType: string;
  /** Installation timestamp. */
  readonly installedAt: string;
  /** Suspension timestamp when present. */
  readonly suspendedAt?: string;
  /** Deletion timestamp when present. */
  readonly deletedAt?: string;
};

/** Product-facing repository summary returned by onboarding. */
type ProductRepositorySummary = {
  /** Repository full name. */
  readonly fullName: string;
  /** Default branch when present. */
  readonly defaultBranch?: string;
  /** Repository visibility. */
  readonly visibility: string;
  /** Whether review automation is enabled. */
  readonly enabled: boolean;
  /** Latest review status when present. */
  readonly latestReviewStatus?: string;
};

/** Product-facing review summary returned by onboarding. */
type ProductReviewSummary = {
  /** Repository full name. */
  readonly repoFullName: string;
  /** Pull request number. */
  readonly pullRequestNumber: number;
  /** Pull request title when present. */
  readonly pullRequestTitle?: string;
  /** Pull request author login when present. */
  readonly authorLogin?: string;
  /** Review run status. */
  readonly status: string;
  /** Review finding counts. */
  readonly counts: AdminReviewFindingCounts;
  /** Last update timestamp. */
  readonly updatedAt: string;
};

/** Product webhook summary returned by the public onboarding API. */
type ProductWebhookSummary = {
  /** Total persisted webhook deliveries. */
  readonly totalDeliveries: number;
  /** Latest delivery timestamp when present. */
  readonly latestDeliveryAt?: string;
  /** Latest webhook event name when present. */
  readonly latestEventName?: string;
  /** Latest webhook action when present. */
  readonly latestAction?: string;
  /** Latest webhook processing status when present. */
  readonly latestStatus?: string;
};

/** Product onboarding response. */
type ProductOnboardingSummary = {
  /** GitHub App setup state. */
  readonly githubApp: ProductGitHubAppSetup;
  /** GitHub App installations known to the API. */
  readonly installations: readonly ProductInstallationSummary[];
  /** Repositories known from GitHub webhooks. */
  readonly repositories: readonly ProductRepositorySummary[];
  /** Recent review runs. */
  readonly recentReviews: readonly ProductReviewSummary[];
  /** Webhook delivery activity. */
  readonly webhook: ProductWebhookSummary;
};

/** Current product user response returned by the API. */
type ProductMeResponse = {
  /** Product user attached to the current session. */
  readonly user: {
    /** Stable product user ID. */
    readonly userId: string;
    /** Primary email address when known. */
    readonly primaryEmail?: string;
    /** Display name when known. */
    readonly displayName?: string;
    /** Avatar URL when known. */
    readonly avatarUrl?: string;
  };
  /** Selected organization for dashboard convenience. */
  readonly selectedOrgId?: string;
  /** Organization memberships available to the user. */
  readonly memberships: readonly {
    /** Organization ID. */
    readonly orgId: string;
    /** Product role. */
    readonly role: string;
    /** Permissions granted by the role. */
    readonly permissions: readonly string[];
    /** Dashboard capability flags derived from the role. */
    readonly capabilities: Record<string, boolean>;
  }[];
  /** Provider installations visible through the user's memberships. */
  readonly installations: readonly {
    /** Stable installation ID. */
    readonly installationId: string;
    /** Organization that owns the installation. */
    readonly orgId: string;
    /** Provider name. */
    readonly provider: string;
    /** Provider installation ID. */
    readonly providerInstallationId: string;
    /** Provider account login. */
    readonly accountLogin: string;
    /** Provider account type. */
    readonly accountType: string;
  }[];
  /** Current session summary. */
  readonly session: {
    /** Stable product session ID. */
    readonly sessionId: string;
    /** Session expiration timestamp. */
    readonly expiresAt: string;
  };
};

/** Product organization row returned by authenticated product APIs. */
type ProductOrganizationSummary = {
  /** Organization ID. */
  readonly orgId: string;
  /** Organization display name. */
  readonly name: string;
  /** Organization slug. */
  readonly slug: string;
  /** Number of connected provider installations. */
  readonly installationCount: number;
  /** Number of repositories known to the app. */
  readonly repositoryCount: number;
};

/** Product usage summary returned by authenticated product APIs. */
type ProductUsageSummary = {
  /** Completed review count. */
  readonly reviewRuns: number;
  /** Indexed commit count. */
  readonly indexedCommits: number;
  /** Embedding token count. */
  readonly embeddingTokens: number;
  /** Review input token count. */
  readonly reviewInputTokens: number;
  /** Review output token count. */
  readonly reviewOutputTokens: number;
  /** Estimated internal cost in USD. */
  readonly estimatedCostUsd: string;
};

/** Authenticated product workspace state. */
type ProductResourcesState = {
  /** Organizations visible to the product user. */
  readonly orgs: readonly ProductOrganizationSummary[];
  /** Currently selected organization ID. */
  readonly selectedOrgId?: string | undefined;
  /** Repositories visible in the selected organization. */
  readonly repositories: readonly AdminRepositorySummary[];
  /** Recent review runs in the selected organization. */
  readonly reviews: readonly AdminReviewRunSummary[];
  /** Basic usage summary for the selected organization. */
  readonly usage?: ProductUsageSummary | undefined;
  /** Whether resource data has loaded at least once. */
  readonly loaded: boolean;
  /** Loading label. */
  readonly loading?: string | undefined;
  /** Error message. */
  readonly error?: string | undefined;
};

/** Sandbox runner kinds accepted by repository settings. */
type SandboxRunnerSetting = "docker" | "gvisor" | "microvm";

/** Minimum sandbox runner settings accepted for forked pull requests. */
type SandboxForkRunnerSetting = SandboxRunnerSetting | "disabled";

/** Repository-level sandbox policy overrides returned by settings APIs. */
type SandboxPolicySettings = {
  /** Whether sandbox execution is enabled. */
  readonly enabled?: boolean | undefined;
  /** Default sandbox runner kind. */
  readonly defaultRunner?: SandboxRunnerSetting | undefined;
  /** Minimum runner required for forked pull requests. */
  readonly minimumRunnerForForks?: SandboxForkRunnerSetting | undefined;
  /** Whether sandbox network access is requested. */
  readonly allowNetwork?: boolean | undefined;
  /** Whether dependency installation is requested. */
  readonly allowDependencyInstall?: boolean | undefined;
  /** Whether custom commands are requested. */
  readonly allowCustomCommands?: boolean | undefined;
  /** Maximum sandbox command timeout. */
  readonly maxTimeoutMs?: number | undefined;
  /** Maximum sandbox memory. */
  readonly maxMemoryBytes?: number | undefined;
  /** Maximum sandbox CPU count. */
  readonly maxCpuCount?: number | undefined;
  /** Maximum captured output. */
  readonly maxOutputBytes?: number | undefined;
  /** Maximum collected artifact bytes. */
  readonly maxArtifactBytes?: number | undefined;
};

/** Repository settings returned by settings APIs. */
type ControlPlaneSettings = {
  /** Review policy. */
  readonly reviewPolicy: string;
  /** Minimum severity threshold. */
  readonly severityThreshold: string;
  /** Maximum inline comments per review. */
  readonly maxCommentsPerReview: number;
  /** Ignored path globs. */
  readonly ignoredPaths: readonly string[];
  /** Ignored pull request authors. */
  readonly ignoredAuthors: readonly string[];
  /** Ignored pull request labels. */
  readonly ignoredLabels: readonly string[];
  /** Required label for reviews when configured. */
  readonly requireLabel?: string | undefined;
  /** Whether generated files are skipped. */
  readonly skipGeneratedFiles: boolean;
  /** Whether draft pull requests are skipped. */
  readonly skipDraftPullRequests: boolean;
  /** Custom instructions for this repository. */
  readonly customInstructions?: string | undefined;
  /** Optional repository-level sandbox policy overrides. */
  readonly sandboxPolicy?: SandboxPolicySettings | undefined;
};

/** Control-plane settings payload. */
type ControlPlaneSettingsResponse = {
  /** Repository being controlled. */
  readonly repository: ControlPlaneRepository;
  /** Mutable review settings. */
  readonly settings: ControlPlaneSettings;
};

/** Organization default trigger policy returned by the product API. */
type ProductOrgTriggerPolicy = {
  /** Enabled pull request actions. */
  readonly enabledActions: readonly string[];
  /** Ignored pull request authors. */
  readonly ignoredAuthors: readonly string[];
  /** Ignored pull request labels. */
  readonly ignoredLabels: readonly string[];
  /** Required pull request label. */
  readonly requireLabel?: string | undefined;
  /** Whether draft pull requests are skipped. */
  readonly skipDraftPullRequests: boolean;
};

/** Organization default finding policy returned by the product API. */
type ProductOrgFindingPolicy = {
  /** Whether style findings can be published. */
  readonly allowStyleFindings: boolean;
  /** Enabled finding categories. */
  readonly enabledCategories: readonly string[];
  /** Maximum findings published per review. */
  readonly maxCommentsPerReview: number;
  /** Minimum confidence needed for publishing. */
  readonly minimumConfidence: number;
  /** Minimum severity threshold. */
  readonly severityThreshold: string;
  /** Whether generated-file findings are suppressed. */
  readonly suppressGeneratedFileFindings: boolean;
};

/** Organization default publishing policy returned by the product API. */
type ProductOrgPublishingPolicy = {
  /** Maximum comments published per review. */
  readonly maxCommentsPerReview: number;
  /** Whether check runs are published. */
  readonly publishCheckRun: boolean;
  /** Whether inline comments are published. */
  readonly publishInlineComments: boolean;
  /** Whether summary comments are published. */
  readonly publishSummaryComment: boolean;
};

/** Organization default memory policy returned by the product API. */
type ProductOrgMemoryPolicy = {
  /** Whether exact finding suppression is allowed. */
  readonly allowExactFindingSuppression: boolean;
  /** Whether natural-language memory instructions are allowed. */
  readonly allowNaturalLanguageInstructions: boolean;
  /** Whether path/category suppression is allowed. */
  readonly allowPathCategorySuppression: boolean;
  /** Whether memory facts are added to context. */
  readonly enableMemoryContext: boolean;
  /** Whether memory can suppress repeated findings. */
  readonly enableMemorySuppression: boolean;
  /** Maximum memory facts included in context. */
  readonly maxMemoryFactsInContext: number;
  /** Memory TTL in days when configured. */
  readonly memoryTtlDays?: number | undefined;
  /** Whether memory facts require approval. */
  readonly requireApprovalForMemoryFacts: boolean;
  /** Trusted roles for feedback-derived memory. */
  readonly trustedFeedbackRoles: readonly string[];
};

/** Organization-wide policy defaults returned by the product API. */
type ProductOrgSettings = {
  /** Settings schema version. */
  readonly schemaVersion: string;
  /** Organization ID. */
  readonly orgId: string;
  /** Default review publication policy. */
  readonly defaultReviewPolicy: string;
  /** Default trigger policy. */
  readonly defaultTriggerPolicy: ProductOrgTriggerPolicy;
  /** Default finding policy. */
  readonly defaultFindingPolicy: ProductOrgFindingPolicy;
  /** Default publishing policy. */
  readonly defaultPublishingPolicy: ProductOrgPublishingPolicy;
  /** Default memory policy. */
  readonly defaultMemoryPolicy: ProductOrgMemoryPolicy;
  /** Allowed model routing profiles. */
  readonly allowedModelProfiles?: readonly string[] | undefined;
  /** Whether repo-local config is allowed. */
  readonly allowRepoLocalConfig: boolean;
  /** Whether memory suppression is allowed. */
  readonly allowMemorySuppression: boolean;
  /** Whether user-defined repository rules are allowed. */
  readonly allowUserDefinedRules: boolean;
  /** Settings creation timestamp. */
  readonly createdAt: string;
  /** Settings update timestamp. */
  readonly updatedAt: string;
  /** Last updating product user ID. */
  readonly updatedByUserId: string | null;
  /** Monotonic settings version. */
  readonly version: number;
};

/** Organization settings response returned by the product API. */
type ProductOrgSettingsResponse = {
  /** Organization policy defaults and guardrails. */
  readonly settings: ProductOrgSettings;
};

/** Repository or organization rule row shown by repository settings UX. */
type AdminRepoRuleSummary = {
  /** Rule ID used by typed policy snapshots. */
  readonly ruleId: string;
  /** Rule row ID. */
  readonly repoRuleId: string;
  /** Organization ID that owns the rule. */
  readonly orgId: string;
  /** Repository ID when the rule is repository-scoped. */
  readonly repoId?: string;
  /** Human-readable rule name. */
  readonly name: string;
  /** Optional human-readable rule description. */
  readonly description?: string;
  /** Rule effect consumed by the policy engine. */
  readonly effect: string;
  /** Structured matcher consumed by the policy engine. */
  readonly matcher: {
    /** Path patterns matched by the rule. */
    readonly paths?: readonly string[];
    /** Languages matched by the rule. */
    readonly languages?: readonly string[];
    /** Finding categories matched by the rule. */
    readonly categories?: readonly string[];
    /** Finding severities matched by the rule. */
    readonly severities?: readonly string[];
    /** Pull request authors matched by the rule. */
    readonly authors?: readonly string[];
    /** Pull request labels matched by the rule. */
    readonly labels?: readonly string[];
    /** Finding title regex matched by the rule. */
    readonly titleRegex?: string;
    /** Finding confidence must be less than this value to match. */
    readonly confidenceLessThan?: number;
  };
  /** Rule instruction consumed by the policy engine. */
  readonly instruction: string;
  /** Rule priority. Lower values run first. */
  readonly priority: number;
  /** Whether the rule currently applies. */
  readonly enabled: boolean;
  /** User ID that created the rule when available. */
  readonly createdByUserId?: string;
  /** Rule scope label. */
  readonly scope: string;
  /** Rule type label. */
  readonly ruleType: string;
  /** Rule body or instruction. */
  readonly body: string;
  /** Whether the rule currently applies. */
  readonly isEnabled: boolean;
  /** Rule creation timestamp. */
  readonly createdAt: string;
  /** Rule update timestamp. */
  readonly updatedAt: string;
};

/** Compiler warning returned by policy preview. */
type ControlPlanePolicyWarning = {
  /** Stable warning code. */
  readonly code: string;
  /** Human-readable warning message. */
  readonly message: string;
  /** Optional structured warning details. */
  readonly details?: Readonly<Record<string, unknown>>;
};

/** Policy decision trace returned by policy preview. */
type ControlPlanePolicyTrace = {
  /** Decision type. */
  readonly decisionType: string;
  /** Decision result. */
  readonly decision: string;
  /** Stable reason code. */
  readonly reasonCode: string;
  /** Optional structured trace details. */
  readonly details?: Readonly<Record<string, unknown>>;
};

/** Effective policy subset rendered by the settings preview. */
type ControlPlaneEffectivePolicy = {
  /** Whether automated review is enabled after compilation. */
  readonly enabled: boolean;
  /** Review policy mode. */
  readonly reviewPolicy: string;
  /** Finding policy. */
  readonly findings: {
    /** Effective severity threshold. */
    readonly severityThreshold: string;
    /** Effective comment budget. */
    readonly maxCommentsPerReview: number;
    /** Effective confidence threshold. */
    readonly minimumConfidence: number;
  };
  /** Publishing policy. */
  readonly publishing: {
    /** Whether a check run is published. */
    readonly publishCheckRun: boolean;
    /** Whether inline comments are published. */
    readonly publishInlineComments: boolean;
    /** Whether a summary comment is published. */
    readonly publishSummaryComment: boolean;
    /** Effective comment budget. */
    readonly maxCommentsPerReview: number;
  };
  /** Sandbox policy when returned by the compiler. */
  readonly sandbox?: {
    /** Whether sandbox execution is enabled. */
    readonly enabled: boolean;
    /** Default sandbox runner kind. */
    readonly defaultRunner: string;
    /** Minimum runner required for forked pull requests. */
    readonly minimumRunnerForForks: string;
    /** Whether sandbox network access is allowed. */
    readonly allowNetwork: boolean;
    /** Whether dependency installation is allowed in sandbox runs. */
    readonly allowDependencyInstall: boolean;
    /** Whether custom commands are allowed in sandbox runs. */
    readonly allowCustomCommands: boolean;
    /** Maximum sandbox command timeout. */
    readonly maxTimeoutMs: number;
    /** Maximum sandbox memory. */
    readonly maxMemoryBytes: number;
    /** Maximum sandbox CPU count. */
    readonly maxCpuCount: number;
    /** Maximum captured output. */
    readonly maxOutputBytes: number;
    /** Maximum collected artifact bytes. */
    readonly maxArtifactBytes: number;
  };
  /** Trigger policy. */
  readonly trigger: {
    /** Enabled pull request actions. */
    readonly enabledActions: readonly string[];
    /** Included base branch patterns. Empty means all base branches. */
    readonly includeBaseBranches?: readonly string[];
    /** Ignored pull request authors. */
    readonly ignoredAuthors: readonly string[];
    /** Ignored pull request labels. */
    readonly ignoredLabels: readonly string[];
    /** Pull request labels where any one can satisfy the review gate. */
    readonly requireAnyLabels?: readonly string[];
    /** Required pull request label. */
    readonly requireLabel?: string;
    /** Whether draft pull requests are skipped. */
    readonly skipDraftPullRequests: boolean;
  };
  /** Compiled review instructions. */
  readonly instructions: readonly string[];
};

/** Policy preview returned by the admin API. */
type ControlPlanePolicyPreview = {
  /** Preview policy snapshot ID. */
  readonly policySnapshotId: string;
  /** Stable effective policy hash. */
  readonly policyHash: string;
  /** Effective compiled policy. */
  readonly effectivePolicy: ControlPlaneEffectivePolicy;
  /** Compiler warnings. */
  readonly warnings: readonly ControlPlanePolicyWarning[];
  /** Compiler trace. */
  readonly trace: ControlPlanePolicyTrace;
};

/** Mutable settings form state. */
type SettingsFormState = {
  /** Whether the repository is enabled. */
  repositoryEnabled: boolean;
  /** Review policy. */
  reviewPolicy: string;
  /** Minimum severity threshold. */
  severityThreshold: string;
  /** Maximum inline comments per review. */
  maxCommentsPerReview: string;
  /** Ignored path globs, one per line. */
  ignoredPaths: string;
  /** Ignored authors, one per line. */
  ignoredAuthors: string;
  /** Ignored labels, one per line. */
  ignoredLabels: string;
  /** Required label. */
  requireLabel: string;
  /** Whether generated files are skipped. */
  skipGeneratedFiles: boolean;
  /** Whether draft pull requests are skipped. */
  skipDraftPullRequests: boolean;
  /** Custom instructions. */
  customInstructions: string;
  /** Sandbox policy override fields. */
  sandboxPolicy: SandboxPolicyFormState;
};

/** Mutable sandbox policy form state. */
type SandboxPolicyFormState = {
  /** Whether sandbox execution is enabled. */
  enabled: boolean;
  /** Default sandbox runner kind. */
  defaultRunner: SandboxRunnerSetting;
  /** Minimum runner required for forked pull requests. */
  minimumRunnerForForks: SandboxForkRunnerSetting;
  /** Whether sandbox network access is requested. */
  allowNetwork: boolean;
  /** Whether dependency installation is requested. */
  allowDependencyInstall: boolean;
  /** Whether custom commands are requested. */
  allowCustomCommands: boolean;
  /** Maximum sandbox command timeout in milliseconds. */
  maxTimeoutMs: string;
  /** Maximum sandbox memory in bytes. */
  maxMemoryBytes: string;
  /** Maximum sandbox CPU count. */
  maxCpuCount: string;
  /** Maximum captured sandbox output in bytes. */
  maxOutputBytes: string;
  /** Maximum collected sandbox artifact bytes. */
  maxArtifactBytes: string;
};

/** Mutable repository rule form state. */
type RuleFormState = {
  /** Rule ID being edited. Empty when creating a rule. */
  editingRuleId: string;
  /** Human-readable rule name. */
  name: string;
  /** Rule effect. */
  effect: string;
  /** Rule priority. Lower values run first. */
  priority: string;
  /** Whether the rule is enabled. */
  enabled: boolean;
  /** Path matchers, one per line. */
  matcherPaths: string;
  /** Category matchers, one per line. */
  matcherCategories: string;
  /** Severity matchers, one per line. */
  matcherSeverities: string;
  /** Optional confidence upper bound for matching findings. */
  matcherConfidenceLessThan: string;
  /** Finding title regular expression. */
  titleRegex: string;
  /** Rule instruction. */
  instruction: string;
};

/** Mutable organization settings form state. */
type ProductOrgSettingsFormState = {
  /** Default review publication policy. */
  defaultReviewPolicy: string;
  /** Enabled pull request actions, one per line. */
  enabledActions: string;
  /** Ignored pull request authors, one per line. */
  ignoredAuthors: string;
  /** Ignored pull request labels, one per line. */
  ignoredLabels: string;
  /** Required pull request label. */
  requireLabel: string;
  /** Whether draft pull requests are skipped. */
  skipDraftPullRequests: boolean;
  /** Whether style findings are allowed. */
  allowStyleFindings: boolean;
  /** Enabled finding categories, one per line. */
  enabledCategories: string;
  /** Finding and publishing comment budget. */
  maxCommentsPerReview: string;
  /** Minimum confidence. */
  minimumConfidence: string;
  /** Minimum severity threshold. */
  severityThreshold: string;
  /** Whether generated-file findings are suppressed. */
  suppressGeneratedFileFindings: boolean;
  /** Whether check runs are published. */
  publishCheckRun: boolean;
  /** Whether inline comments are published. */
  publishInlineComments: boolean;
  /** Whether summary comments are published. */
  publishSummaryComment: boolean;
  /** Whether memory facts are added to context. */
  enableMemoryContext: boolean;
  /** Whether memory can suppress findings. */
  enableMemorySuppression: boolean;
  /** Maximum memory facts included in context. */
  maxMemoryFactsInContext: string;
  /** Memory TTL in days. */
  memoryTtlDays: string;
  /** Whether memory facts require approval. */
  requireApprovalForMemoryFacts: boolean;
  /** Trusted feedback roles, one per line. */
  trustedFeedbackRoles: string;
  /** Allowed model profiles, one per line. */
  allowedModelProfiles: string;
  /** Whether repo-local config is allowed. */
  allowRepoLocalConfig: boolean;
  /** Whether memory suppression is allowed at the org level. */
  allowMemorySuppression: boolean;
  /** Whether user-defined repository rules are allowed. */
  allowUserDefinedRules: boolean;
};

/** Product-facing organization settings panel state. */
type ProductOrgSettingsState = {
  /** Selected organization ID. */
  orgId: string;
  /** Loaded organization settings payload. */
  data?: ProductOrgSettings | undefined;
  /** Editable form state. */
  form?: ProductOrgSettingsFormState | undefined;
  /** Loading label. */
  loading?: string | undefined;
  /** Error message. */
  error?: string | undefined;
  /** Save confirmation message. */
  saved?: string | undefined;
};

/** Product-facing repository settings panel state. */
type ProductRepositorySettingsState = {
  /** Selected repository ID. */
  repoId: string;
  /** Loaded settings payload. */
  data?: ControlPlaneSettingsResponse | undefined;
  /** Editable form state. */
  form?: SettingsFormState | undefined;
  /** Rules that currently affect the selected repository. */
  rules: readonly AdminRepoRuleSummary[];
  /** Editable repository rule form. */
  ruleForm: RuleFormState;
  /** Latest effective policy preview for the current form state. */
  preview?: ControlPlanePolicyPreview | undefined;
  /** Stored memory facts that can apply to the repository. */
  memoryFacts: readonly ProductMemoryFactSummary[];
  /** Proposed memory candidates that can apply to the repository. */
  memoryCandidates: readonly ProductMemoryCandidateSummary[];
  /** Recent suppression matches recorded for this repository. */
  suppressionMatches: readonly ProductSuppressionMatchSummary[];
  /** Loading label. */
  loading?: string | undefined;
  /** Error message. */
  error?: string | undefined;
  /** Save confirmation message. */
  saved?: string | undefined;
};

/** Product-facing review detail and finding inspection state. */
type ProductReviewDetailState = {
  /** Selected review run ID. */
  reviewRunId: string;
  /** Loaded review run detail. */
  reviewRun?: AdminReviewRunSummary | undefined;
  /** Loaded finding rows for the selected review. */
  findings: readonly AdminReviewFindingSummary[];
  /** Payload-free artifact metadata rows for the selected review. */
  artifacts?: readonly AdminReviewArtifactSummary[] | undefined;
  /** Whether artifact metadata has been requested for this review. */
  artifactsLoaded?: boolean | undefined;
  /** Human-readable reason draft for artifact payload access. */
  artifactAccessReason: string;
  /** Last redacted artifact payload loaded for the selected review. */
  artifactPayload?: AdminReviewArtifactPayloadSummary | undefined;
  /** Selected finding detail. */
  selectedFinding?: AdminReviewFindingSummary | undefined;
  /** Feedback timeline for the selected finding. */
  selectedFindingFeedbackEvents?: readonly AdminReviewFindingFeedbackEventSummary[] | undefined;
  /** Outcome note draft for finding feedback. */
  outcomeNote: string;
  /** Suppress-similar reason draft. */
  suppressionReason: string;
  /** Suppress-similar scope draft. */
  suppressionScope: "repo" | "org";
  /** Loading label. */
  loading?: string | undefined;
  /** Error message. */
  error?: string | undefined;
  /** Save confirmation message. */
  saved?: string | undefined;
};

/** Field and action wiring for shared repository settings controls. */
type SettingsFormRenderOptions = {
  /** Data-field prefix used for repository settings fields. */
  readonly settingsFieldPrefix: string;
  /** Data-field prefix used for repository rule fields. */
  readonly ruleFieldPrefix: string;
  /** Container class for the shared settings form body. */
  readonly formContainerClass: string;
  /** Whether settings inputs are editable. */
  readonly canManageSettings: boolean;
  /** Whether rule inputs and rule mutations are available. */
  readonly canManageRules: boolean;
  /** Action used to save a rule. */
  readonly saveRuleAction: string;
  /** Action used to edit a rule. */
  readonly editRuleAction: string;
  /** Action used to cancel rule editing. */
  readonly cancelRuleEditAction: string;
  /** Action used to delete a rule. */
  readonly deleteRuleAction: string;
};

/** Mutable overview view state. */
type OverviewViewState = {
  /** Repository search text. */
  repositorySearch: string;
  /** Repository filter applied to review history. */
  reviewRepoId: string;
  /** Review status filter. */
  reviewStatus: string;
  /** Review search text. */
  reviewSearch: string;
  /** Loaded repositories. */
  repositories: readonly AdminRepositorySummary[];
  /** Loaded recent or filtered reviews. */
  reviews: readonly AdminReviewRunSummary[];
  /** Loaded recent audit entries. */
  auditLogs: readonly AdminAuditLogSummary[];
  /** Latest product-safe runtime health returned by the overview endpoint. */
  runtimeHealth?: ApiHealthResponse | undefined;
  /** Durable review rollup metrics returned by the overview endpoint. */
  reviewMetrics?: AdminReviewMetricsSummary | undefined;
  /** Whether the overview route has returned at least once in this session. */
  loaded: boolean;
  /** Whether repository discovery has returned at least once in this session. */
  repositoriesLoaded: boolean;
  /** Whether review discovery has returned at least once in this session. */
  reviewsLoaded: boolean;
  /** Loading label. */
  loading?: string | undefined;
  /** Error message. */
  error?: string | undefined;
};

/** Mutable settings view state. */
type SettingsViewState = {
  /** Repository ID input. */
  repoId: string;
  /** Loaded settings payload. */
  data?: ControlPlaneSettingsResponse | undefined;
  /** Editable form state. */
  form?: SettingsFormState | undefined;
  /** Rules that currently affect the loaded repository. */
  rules: readonly AdminRepoRuleSummary[];
  /** Editable repository rule form. */
  ruleForm: RuleFormState;
  /** Latest effective policy preview for the current form state. */
  preview?: ControlPlanePolicyPreview | undefined;
  /** Loading label. */
  loading?: string | undefined;
  /** Error message. */
  error?: string | undefined;
  /** Save confirmation message. */
  saved?: string | undefined;
};

/** Audit log row returned by the API. */
type AdminAuditLogSummary = {
  /** Audit log row ID. */
  readonly auditLogId: string;
  /** Organization ID when available. */
  readonly orgId?: string | undefined;
  /** Actor category. */
  readonly actorType: string;
  /** Actor user ID when available. */
  readonly actorUserId?: string | undefined;
  /** Audit action. */
  readonly action: string;
  /** Resource type. */
  readonly resourceType: string;
  /** Resource ID when available. */
  readonly resourceId?: string | undefined;
  /** Event timestamp. */
  readonly occurredAt: string;
  /** Event metadata. */
  readonly metadata?: unknown;
};

/** Security event row returned by the API. */
type AdminSecurityEventSummary = {
  /** Security event row ID. */
  readonly securityEventId: string;
  /** Organization ID when available. */
  readonly orgId?: string | undefined;
  /** Repository ID when available. */
  readonly repoId?: string | undefined;
  /** Security event type. */
  readonly type: string;
  /** Event severity. */
  readonly severity: string;
  /** Emitting service or subsystem. */
  readonly source: string;
  /** Triage status. */
  readonly status: string;
  /** Actor ID when known. */
  readonly actorId?: string | undefined;
  /** Resource type when available. */
  readonly resourceType?: string | undefined;
  /** Resource ID when available. */
  readonly resourceId?: string | undefined;
  /** Product-safe event metadata. */
  readonly metadata: Readonly<Record<string, unknown>>;
  /** Event creation timestamp. */
  readonly createdAt: string;
  /** Event update timestamp. */
  readonly updatedAt: string;
};

/** Usage rollup row returned by the API. */
type AdminUsageRollupSummary = {
  /** Organization that owns the usage. */
  readonly orgId: string;
  /** Repository that caused the usage when available. */
  readonly repoId?: string;
  /** Usage event type. */
  readonly eventType: string;
  /** Usage unit. */
  readonly unit: string;
  /** Number of ledger events in the rollup. */
  readonly eventCount: number;
  /** Signed quantity sum. */
  readonly quantity: number;
  /** Signed cost in micro-USD. */
  readonly costMicros: number;
};

/** Usage totals returned by the API. */
type AdminUsageTotals = {
  /** Number of ledger events included in returned rollups. */
  readonly eventCount: number;
  /** Signed cost in micro-USD. */
  readonly costMicros: number;
  /** Completed review count. */
  readonly reviewCount: number;
  /** LLM token count. */
  readonly llmTokens: number;
};

/** Usage summary returned by the API. */
type AdminUsageSummary = {
  /** Period start when applied. */
  readonly periodStart?: string;
  /** Period end when applied. */
  readonly periodEnd?: string;
  /** Aggregated usage rows. */
  readonly rollups: readonly AdminUsageRollupSummary[];
  /** Aggregated totals. */
  readonly totals: AdminUsageTotals;
};

/** Stable plan snapshot returned by the entitlement API. */
type AdminPlanSnapshot = {
  /** Snapshot schema version. */
  readonly schemaVersion: "plan_snapshot.v1";
  /** Organization that owns the snapshot. */
  readonly orgId: string;
  /** Billing account ID used by the snapshot. */
  readonly billingAccountId: string;
  /** Plan key, such as free, team, business, or internal. */
  readonly planKey: string;
  /** Plan version ID. */
  readonly planVersionId: string;
  /** Subscription or local account status. */
  readonly subscriptionStatus: string;
  /** Payment status used for access decisions. */
  readonly paymentStatus: string;
  /** Feature values compiled from plan defaults and overrides. */
  readonly features: Readonly<Record<string, unknown>>;
  /** Limit values compiled from plan defaults and overrides. */
  readonly limits: Readonly<Record<string, number | boolean | string>>;
  /** Snapshot compile timestamp. */
  readonly compiledAt: string;
};

/** Feature decision returned by the entitlement API. */
type AdminEntitlementDecision = {
  /** Organization checked by the decision. */
  readonly orgId: string;
  /** Feature or limit key checked by the decision. */
  readonly featureKey: string;
  /** Whether the feature is allowed. */
  readonly allowed: boolean;
  /** Stable decision reason. */
  readonly reason: string;
  /** Decision source. */
  readonly source: string;
  /** Optional decision value. */
  readonly value?: unknown;
};

/** Entitlement override row returned by the entitlement API. */
type AdminEntitlementRow = {
  /** Entitlement row ID. */
  readonly entitlementId: string;
  /** Organization that owns the entitlement. */
  readonly orgId: string;
  /** Feature key affected by the entitlement. */
  readonly featureKey: string;
  /** Whether the entitlement enables access. */
  readonly enabled: boolean;
  /** Entitlement source. */
  readonly source: string;
  /** Optional source row ID. */
  readonly sourceId?: string;
  /** Entitlement value payload. */
  readonly value: Readonly<Record<string, unknown>>;
  /** Entitlement effective timestamp. */
  readonly effectiveFrom: string;
  /** Entitlement end timestamp when present. */
  readonly effectiveTo?: string;
};

/** Entitlement summary returned by the API. */
type AdminEntitlementSummary = {
  /** Organization that owns the summary. */
  readonly orgId: string;
  /** Stable plan snapshot. */
  readonly planSnapshot: AdminPlanSnapshot;
  /** Feature decisions. */
  readonly decisions: readonly AdminEntitlementDecision[];
  /** Entitlement override rows. */
  readonly entitlements: readonly AdminEntitlementRow[];
  /** Summary compile timestamp. */
  readonly checkedAt: string;
};

/** Billing account row returned by the billing API. */
type AdminBillingAccount = {
  /** Billing account ID. */
  readonly billingAccountId: string;
  /** Organization that owns the account. */
  readonly orgId: string;
  /** Billing mode, such as free, self_serve, or internal. */
  readonly billingMode: string;
  /** Local account status. */
  readonly status: string;
  /** Billing provider name. */
  readonly provider: string;
  /** Provider customer ID when present. */
  readonly providerCustomerId?: string;
  /** Current plan key. */
  readonly currentPlanKey?: string;
  /** Current plan version ID. */
  readonly currentPlanVersionId?: string;
  /** Payment status used for access decisions. */
  readonly paymentStatus: string;
  /** Account creation timestamp. */
  readonly createdAt: string;
  /** Account update timestamp. */
  readonly updatedAt: string;
};

/** Subscription mirror returned by the billing API. */
type AdminSubscription = {
  /** Subscription ID. */
  readonly subscriptionId: string;
  /** Billing account ID. */
  readonly billingAccountId: string;
  /** Billing provider name. */
  readonly provider: string;
  /** Provider subscription ID when present. */
  readonly providerSubscriptionId?: string;
  /** Subscription status. */
  readonly status: string;
  /** Plan version ID when linked. */
  readonly billingPlanVersionId?: string;
  /** Current period start. */
  readonly currentPeriodStart?: string;
  /** Current period end. */
  readonly currentPeriodEnd?: string;
  /** Whether cancellation is scheduled. */
  readonly cancelAtPeriodEnd: boolean;
  /** Subscription quantity when present. */
  readonly quantity?: number;
};

/** Subscription item mirror returned by the billing API. */
type AdminSubscriptionItem = {
  /** Subscription item ID. */
  readonly subscriptionItemId: string;
  /** Subscription ID. */
  readonly subscriptionId: string;
  /** Item type. */
  readonly itemType: string;
  /** Quantity when present. */
  readonly quantity?: number;
  /** Meter key when present. */
  readonly meterKey?: string;
  /** Whether the item is active. */
  readonly active: boolean;
};

/** Credit grant returned by the billing API. */
type AdminCreditGrant = {
  /** Credit grant ID. */
  readonly creditGrantId: string;
  /** Credit type. */
  readonly creditType: string;
  /** Original quantity. */
  readonly quantity: number;
  /** Remaining quantity. */
  readonly remainingQuantity: number;
  /** Grant reason. */
  readonly reason: string;
  /** Grant source. */
  readonly source: string;
  /** Expiration timestamp when present. */
  readonly expiresAt?: string;
};

/** Invoice mirror returned by the billing API. */
type AdminInvoice = {
  /** Invoice ID. */
  readonly invoiceId: string;
  /** Provider invoice ID. */
  readonly providerInvoiceId: string;
  /** Invoice status. */
  readonly status: string;
  /** Currency code. */
  readonly currency: string;
  /** Amount due in micros. */
  readonly amountDueMicros: number;
  /** Amount paid in micros. */
  readonly amountPaidMicros: number;
  /** Amount remaining in micros. */
  readonly amountRemainingMicros: number;
  /** Invoice period start when present. */
  readonly periodStart?: string;
  /** Invoice period end when present. */
  readonly periodEnd?: string;
  /** Hosted invoice URL when present. */
  readonly hostedInvoiceUrl?: string;
  /** Invoice PDF URL when present. */
  readonly invoicePdfUrl?: string;
};

/** Billing summary returned by the API. */
type AdminBillingSummary = {
  /** Organization that owns the summary. */
  readonly orgId: string;
  /** Local billing account. */
  readonly billingAccount: AdminBillingAccount;
  /** Stable plan snapshot. */
  readonly planSnapshot: AdminPlanSnapshot;
  /** Current subscription mirror when present. */
  readonly subscription?: AdminSubscription;
  /** Subscription items for the current subscription. */
  readonly subscriptionItems: readonly AdminSubscriptionItem[];
  /** Manual or promotional credit grants. */
  readonly creditGrants: readonly AdminCreditGrant[];
  /** Provider invoice mirrors. */
  readonly invoices: readonly AdminInvoice[];
  /** Entitlement rows available to the compiler. */
  readonly entitlements: readonly AdminEntitlementRow[];
  /** Summary compile timestamp. */
  readonly checkedAt: string;
};

/** Customer portal session returned by the billing API. */
type AdminPortalSessionRef = {
  /** Billing provider name. */
  readonly provider: string;
  /** Provider portal session ID. */
  readonly portalSessionId: string;
  /** URL that opens the provider customer portal. */
  readonly url: string;
};

/** Billing meter event row returned by the billing debug API. */
type AdminBillingMeterEventSummary = {
  /** Local meter event row ID. */
  readonly billingMeterEventId: string;
  /** Local billing account ID. */
  readonly billingAccountId: string;
  /** Organization that owns the row. */
  readonly orgId: string;
  /** Billing provider name. */
  readonly provider: string;
  /** Provider customer ID. */
  readonly providerCustomerId: string;
  /** Internal meter key. */
  readonly meterKey: string;
  /** Provider event name configured on the meter. */
  readonly providerEventName: string;
  /** Billing period key. */
  readonly periodKey: string;
  /** Usage period start. */
  readonly periodStart: string;
  /** Usage period end. */
  readonly periodEnd: string;
  /** Planned provider quantity. */
  readonly quantity: number;
  /** Provider idempotency key. */
  readonly idempotencyKey: string;
  /** Send status. */
  readonly status: string;
  /** Provider meter event ID after send. */
  readonly providerMeterEventId?: string;
  /** Number of send attempts. */
  readonly attemptCount: number;
  /** Last provider error code when present. */
  readonly lastErrorCode?: string;
  /** Last provider error message when present. */
  readonly lastErrorMessage?: string;
  /** Usage event IDs rolled into this meter event. */
  readonly sourceUsageEventIds: readonly string[];
  /** Provider send timestamp when present. */
  readonly sentAt?: string;
  /** Row creation timestamp. */
  readonly createdAt: string;
  /** Row update timestamp. */
  readonly updatedAt: string;
};

/** Billing meter event debug response. */
type AdminBillingMeterEventsSummary = {
  /** Organization that owns the rows. */
  readonly orgId: string;
  /** Status filter when applied. */
  readonly status?: string;
  /** Period filter when applied. */
  readonly periodKey?: string;
  /** Meter event rows. */
  readonly meterEvents: readonly AdminBillingMeterEventSummary[];
};

/** Billing reconciliation issue severity. */
type AdminBillingReconciliationSeverity = "warning" | "critical";

/** Billing reconciliation issue shown on the billing dashboard. */
type AdminBillingReconciliationIssue = {
  /** Issue severity. */
  readonly severity: AdminBillingReconciliationSeverity;
  /** Machine-readable issue category. */
  readonly category: string;
  /** Human-readable issue title. */
  readonly title: string;
  /** Concise issue detail. */
  readonly detail: string;
  /** Related local resource type. */
  readonly resourceType: string;
  /** Related local resource ID when present. */
  readonly resourceId?: string;
  /** Issue timestamp. */
  readonly occurredAt: string;
};

/** Billing reconciliation report returned by the admin API. */
type AdminBillingReconciliationSummary = {
  /** Organization that owns the report. */
  readonly orgId: string;
  /** Report generation timestamp. */
  readonly checkedAt: string;
  /** Billing period key filter when applied. */
  readonly periodKey?: string;
  /** Usage anomaly period start when applied. */
  readonly periodStart?: string;
  /** Usage anomaly period end when applied. */
  readonly periodEnd?: string;
  /** Reconciliation issues ordered by severity and recency. */
  readonly issues: readonly AdminBillingReconciliationIssue[];
};

/** Durable billing reconciliation job returned by the admin API. */
type AdminBillingReconciliationRunSummary = {
  /** Durable background job row ID. */
  readonly backgroundJobId: string;
  /** Durable job idempotency key. */
  readonly jobKey: string;
  /** Current durable job status. */
  readonly status: string;
};

/** Mutable audit history view state. */
type AuditViewState = {
  /** Organization filter. */
  orgId: string;
  /** Action filter. */
  action: string;
  /** Resource type filter. */
  resourceType: string;
  /** Resource ID filter. */
  resourceId: string;
  /** Actor user ID filter. */
  actorUserId: string;
  /** Free-text search. */
  search: string;
  /** Loaded audit rows. */
  rows: readonly AdminAuditLogSummary[];
  /** Loading label. */
  loading?: string | undefined;
  /** Error message. */
  error?: string | undefined;
};

/** Mutable security event view state. */
type SecurityEventViewState = {
  /** Organization filter. */
  orgId: string;
  /** Repository filter. */
  repoId: string;
  /** Security event type filter. */
  type: string;
  /** Severity filter. */
  severity: string;
  /** Source subsystem filter. */
  source: string;
  /** Triage status filter. */
  status: string;
  /** Actor ID filter. */
  actorId: string;
  /** Resource type filter. */
  resourceType: string;
  /** Resource ID filter. */
  resourceId: string;
  /** Free-text search. */
  search: string;
  /** Loaded security event rows. */
  rows: readonly AdminSecurityEventSummary[];
  /** Loading label. */
  loading?: string | undefined;
  /** Error message. */
  error?: string | undefined;
};

/** Mutable usage view state. */
type UsageViewState = {
  /** Organization filter. */
  orgId: string;
  /** Repository filter. */
  repoId: string;
  /** Inclusive period start. */
  periodStart: string;
  /** Exclusive period end. */
  periodEnd: string;
  /** Loaded usage summary. */
  data?: AdminUsageSummary | undefined;
  /** Loading label. */
  loading?: string | undefined;
  /** Error message. */
  error?: string | undefined;
};

/** Mutable plan and entitlement view state. */
type EntitlementsViewState = {
  /** Organization filter. */
  orgId: string;
  /** Feature keys to check, one per line. */
  featureKeys: string;
  /** Loaded entitlement summary. */
  data?: AdminEntitlementSummary | undefined;
  /** Loading label. */
  loading?: string | undefined;
  /** Error message. */
  error?: string | undefined;
};

/** Mutable billing account view state. */
type BillingViewState = {
  /** Organization filter. */
  orgId: string;
  /** Meter event status filter. */
  meterStatus: string;
  /** Meter event billing period filter. */
  meterPeriodKey: string;
  /** Loaded billing summary. */
  data?: AdminBillingSummary | undefined;
  /** Current-month usage rollups for quota visibility. */
  monthlyUsage?: AdminUsageSummary | undefined;
  /** Loaded billing meter event rows. */
  meterEvents?: AdminBillingMeterEventsSummary | undefined;
  /** Loaded billing reconciliation report. */
  reconciliation?: AdminBillingReconciliationSummary | undefined;
  /** Last durable reconciliation job created by the operator. */
  reconciliationRun?: AdminBillingReconciliationRunSummary | undefined;
  /** Reconciliation run enqueue loading label. */
  reconciliationRunLoading?: string | undefined;
  /** Reconciliation run enqueue error. */
  reconciliationRunError?: string | undefined;
  /** Latest generated customer portal URL. */
  portalUrl?: string | undefined;
  /** Customer portal creation loading label. */
  portalLoading?: string | undefined;
  /** Customer portal creation error. */
  portalError?: string | undefined;
  /** Loading label. */
  loading?: string | undefined;
  /** Error message. */
  error?: string | undefined;
};

/** Mutable evaluation history view state. */
type EvaluationViewState = {
  /** Persisted evaluation suites. */
  suites: readonly EvaluationSuiteSummary[];
  /** Recent runs for the selected suite. */
  runs: readonly EvaluationRunSummary[];
  /** Selected suite ID. */
  selectedSuiteId: string;
  /** Loaded details for the selected run. */
  selectedRun?: EvaluationRunDetails | undefined;
  /** Loading label. */
  loading?: string | undefined;
  /** Error message. */
  error?: string | undefined;
};

/** Mutable product onboarding state. */
type ProductViewState = {
  /** Loaded product onboarding payload. */
  data?: ProductOnboardingSummary | undefined;
  /** Loaded product session payload. */
  session?: ProductMeResponse | undefined;
  /** Authenticated product workspace resources. */
  resources?: ProductResourcesState | undefined;
  /** Selected product organization settings. */
  orgSettings?: ProductOrgSettingsState | undefined;
  /** Selected product repository settings and rules. */
  repositorySettings?: ProductRepositorySettingsState | undefined;
  /** Selected product review run and finding details. */
  reviewDetail?: ProductReviewDetailState | undefined;
  /** Loading label. */
  loading?: string | undefined;
  /** Product session loading label. */
  sessionLoading?: string | undefined;
  /** Error message. */
  error?: string | undefined;
  /** Product authentication error message. */
  authError?: string | undefined;
};

/** Inspector API route builder configuration. */
type InspectorConfig = {
  /** Inspector kind. */
  readonly kind: InspectorKind;
  /** Short tab label. */
  readonly label: string;
  /** Main heading for the inspector. */
  readonly title: string;
  /** ID input label. */
  readonly idLabel: string;
  /** ID input placeholder. */
  readonly placeholder: string;
  /** Builds the debug details route. */
  readonly detailsPath: (id: string) => string;
  /** Builds the replay plan route. */
  readonly replayPlanPath?: (id: string) => string;
  /** Builds the replay execution route. */
  readonly replayPath?: (id: string) => string;
  /** Builds the background job cancellation route when supported by the inspector. */
  readonly cancelPath?: (id: string) => string;
  /** Builds the debug bundle export route when supported by the inspector. */
  readonly debugBundlePath?: (id: string) => string;
  /** Builds the eval import route when supported by the inspector. */
  readonly evalImportPath?: (id: string) => string;
  /** Builds the retrieval replay dry-run route when supported by the inspector. */
  readonly retrievalReplayPath?: (id: string) => string;
  /** Builds the validation replay dry-run route when supported by the inspector. */
  readonly validationReplayPath?: (id: string) => string;
};

/** Inspector detail response union. */
type InspectorDetails =
  | AdminWebhookDebugDetails
  | AdminBackgroundJobDebugDetails
  | AdminReviewDebugDetails
  | AdminPublisherDebugDetails
  | AdminMemoryRulesDebugDetails;

/** Inspector replay plan response union. */
type InspectorReplayPlan =
  | WebhookReplayPlan
  | BackgroundJobReplayPlan
  | ReviewReplayPlan
  | PublisherReplayPlan;

/** Mutable view state for one inspector. */
type InspectorViewState = {
  /** Current resource ID input. */
  id: string;
  /** Loaded debug details. */
  details?: InspectorDetails | undefined;
  /** Loaded replay plan. */
  plan?: InspectorReplayPlan | undefined;
  /** Last replay execution result. */
  result?: AdminReplayExecutionResult | undefined;
  /** Last background job cancellation result. */
  cancelResult?: AdminBackgroundJobCancelResult | undefined;
  /** Last exported redacted debug bundle. */
  debugBundle?: AdminReviewRunDebugBundle | undefined;
  /** Last generated eval import draft. */
  evalImportDraft?: AdminReviewRunEvalImportDraft | undefined;
  /** Last retrieval replay dry-run result. */
  retrievalReplay?: RetrievalReplayDryRun | undefined;
  /** Last validation replay dry-run result. */
  validationReplay?: ValidationReplayDryRun | undefined;
  /** Typed confirmation token for replay execution. */
  confirmationTokenInput: string;
  /** Operator reason used for background job cancellation. */
  cancelReasonInput: string;
  /** Current inspector-specific error. */
  error?: string | undefined;
  /** Current inspector-specific loading label. */
  loading?: string | undefined;
};

/** Moderation decision available for one pending memory candidate. */
type MemoryCandidateModerationDecision = "approve" | "reject";

/** Finding outcome values accepted by the scoped API. */
type ProductFindingOutcomeValue = "accepted" | "rejected" | "ignored" | "resolved" | "dismissed";

/** Product finding outcome action shown in the review detail panel. */
type ProductFindingOutcomeAction = {
  /** API outcome value sent to the scoped API. */
  readonly outcome: ProductFindingOutcomeValue;
  /** Button label shown to the user. */
  readonly label: string;
};

/** Mutable application state. */
type AppState = {
  /** Active top-level console mode. */
  activeMode: ConsoleMode;
  /** Active primary dashboard view. */
  activeView: ViewKind;
  /** Active inspector tab. */
  activeKind: InspectorKind;
  /** API base URL. Empty string means same origin. */
  apiBaseUrl: string;
  /** Admin gateway base URL. Empty string means same origin. */
  gatewayBaseUrl: string;
  /** Authenticated admin session. */
  session?: AdminSession | undefined;
  /** Current authentication loading label. */
  authLoading?: string | undefined;
  /** Global authentication error. */
  authError?: string | undefined;
  /** Last parsed URL state used for reload-safe dashboard selections. */
  route: DashboardRouteState;
  /** Per-inspector state. */
  inspectors: Record<InspectorKind, InspectorViewState>;
  /** Product onboarding state. */
  product: ProductViewState;
  /** Overview view state. */
  overview: OverviewViewState;
  /** Settings view state. */
  settings: SettingsViewState;
  /** Audit history view state. */
  audit: AuditViewState;
  /** Security event history view state. */
  security: SecurityEventViewState;
  /** Usage ledger inspection state. */
  usage: UsageViewState;
  /** Plan and entitlement inspection state. */
  entitlements: EntitlementsViewState;
  /** Billing account inspection state. */
  billing: BillingViewState;
  /** Evaluation history inspection state. */
  evaluation: EvaluationViewState;
};

const appRoot = document.querySelector<HTMLElement>("#app");

if (!appRoot) {
  throw new Error("Missing app root");
}

const app = appRoot;

const apiBaseUrl = import.meta.env.VITE_HEIMDALL_API_BASE_URL ?? "";
const gatewayBaseUrl = import.meta.env.VITE_HEIMDALL_ADMIN_GATEWAY_BASE_URL ?? "";
const API_BASE_URL_STORAGE_KEY = "heimdall:admin-api-base-url";
const GATEWAY_BASE_URL_STORAGE_KEY = "heimdall:admin-gateway-base-url";
const PENDING_GATEWAY_LOGIN_STORAGE_KEY = "heimdall:pending-admin-gateway-login";
const DEFAULT_ENTITLEMENT_FEATURE_KEYS = [
  "reviews.enabled",
  "reviews.inline_comments",
  "reviews.pr_summary",
  "reviews.max_comments_per_pr",
  "reviews.max_monthly_review_credits",
  "memory.enabled",
  "rules.advanced",
  "static_analysis.enabled",
  "security.audit_logs",
].join("\n");
/** Selectable security event severities shown in the operator dashboard. */
const SECURITY_EVENT_SEVERITY_OPTIONS = ["", "critical", "high", "medium", "low", "info"];
/** Selectable security event sources shown in the operator dashboard. */
const SECURITY_EVENT_SOURCE_OPTIONS = [
  "",
  "api",
  "worker",
  "github",
  "sandbox",
  "llm_gateway",
  "system",
];
/** Selectable security event statuses shown in the operator dashboard. */
const SECURITY_EVENT_STATUS_OPTIONS = ["", "new", "triaged", "dismissed", "incident_created"];
/** Query parameter names owned by the dashboard router shim. */
const DASHBOARD_ROUTE_PARAM_KEYS = [
  "mode",
  "view",
  "inspector",
  "resourceId",
  "orgId",
  "productRepoId",
  "reviewRunId",
  "findingId",
  "settingsRepoId",
  "action",
  "resourceType",
  "actorUserId",
  "repoId",
  "search",
  "type",
  "severity",
  "source",
  "status",
  "actorId",
  "periodStart",
  "periodEnd",
  "meterStatus",
  "meterPeriodKey",
  "repositorySearch",
  "reviewRepoId",
  "reviewStatus",
  "reviewSearch",
  "suiteId",
  "evalRunId",
] as const;
/** Sandbox runner options shown in repository settings. */
const SANDBOX_RUNNER_OPTIONS = ["docker", "gvisor", "microvm"] as const;
/** Forked pull request runner options shown in repository settings. */
const SANDBOX_FORK_RUNNER_OPTIONS = ["gvisor", "microvm", "docker", "disabled"] as const;
/** Default editable sandbox policy values used when no repository override exists. */
const DEFAULT_SANDBOX_POLICY_FORM: SandboxPolicyFormState = {
  allowCustomCommands: false,
  allowDependencyInstall: false,
  allowNetwork: false,
  defaultRunner: "docker",
  enabled: true,
  maxArtifactBytes: "25000000",
  maxCpuCount: "2",
  maxMemoryBytes: "1073741824",
  maxOutputBytes: "10000000",
  maxTimeoutMs: "45000",
  minimumRunnerForForks: "gvisor",
};
const PRODUCT_FINDING_OUTCOME_ACTIONS: readonly ProductFindingOutcomeAction[] = [
  { outcome: "accepted", label: "Useful" },
  { outcome: "rejected", label: "False positive" },
  { outcome: "ignored", label: "Not useful" },
  { outcome: "resolved", label: "Addressed" },
  { outcome: "dismissed", label: "Dismissed" },
];
const ADMIN_SETTINGS_RENDER_OPTIONS: SettingsFormRenderOptions = {
  settingsFieldPrefix: "settings",
  ruleFieldPrefix: "rule",
  formContainerClass: "panel",
  canManageSettings: true,
  canManageRules: true,
  saveRuleAction: "save-rule",
  editRuleAction: "edit-rule",
  cancelRuleEditAction: "cancel-rule-edit",
  deleteRuleAction: "delete-rule",
};
const PRODUCT_SETTINGS_RENDER_OPTIONS: Omit<
  SettingsFormRenderOptions,
  "canManageSettings" | "canManageRules"
> = {
  settingsFieldPrefix: "productSettings",
  ruleFieldPrefix: "productRule",
  formContainerClass: "settings-inline-panel",
  saveRuleAction: "save-product-rule",
  editRuleAction: "edit-product-rule",
  cancelRuleEditAction: "cancel-product-rule-edit",
  deleteRuleAction: "delete-product-rule",
};

const inspectorConfigs: Record<InspectorKind, InspectorConfig> = {
  webhook: {
    kind: "webhook",
    label: "Webhook",
    title: "Webhook Inspector",
    idLabel: "Webhook event ID",
    placeholder: "webhook_...",
    detailsPath: (id) => `/admin/debug/webhooks/${encodeURIComponent(id)}`,
    replayPlanPath: (id) => `/admin/debug/webhooks/${encodeURIComponent(id)}/replay-plan`,
    replayPath: (id) => `/admin/debug/webhooks/${encodeURIComponent(id)}/replay`,
  },
  job: {
    kind: "job",
    label: "Job",
    title: "Job Inspector",
    idLabel: "Background job ID",
    placeholder: "job_...",
    detailsPath: (id) => `/admin/debug/jobs/${encodeURIComponent(id)}`,
    replayPlanPath: (id) => `/admin/debug/jobs/${encodeURIComponent(id)}/replay-plan`,
    replayPath: (id) => `/admin/debug/jobs/${encodeURIComponent(id)}/replay`,
    cancelPath: (id) => `/admin/debug/jobs/${encodeURIComponent(id)}/cancel`,
  },
  review: {
    kind: "review",
    label: "Review",
    title: "Review Inspector",
    idLabel: "Review run ID",
    placeholder: "rrn_...",
    detailsPath: (id) => `/admin/debug/reviews/${encodeURIComponent(id)}`,
    replayPlanPath: (id) => `/admin/debug/reviews/${encodeURIComponent(id)}/replay-plan`,
    replayPath: (id) => `/admin/debug/reviews/${encodeURIComponent(id)}/replay`,
    debugBundlePath: (id) => `/admin/debug/reviews/${encodeURIComponent(id)}/debug-bundle`,
    evalImportPath: (id) => `/admin/debug/reviews/${encodeURIComponent(id)}/import-eval`,
    retrievalReplayPath: (id) => `/admin/debug/reviews/${encodeURIComponent(id)}/retrieval-replay`,
    validationReplayPath: (id) =>
      `/admin/debug/reviews/${encodeURIComponent(id)}/validation-replay`,
  },
  publisher: {
    kind: "publisher",
    label: "Publisher",
    title: "Publisher Inspector",
    idLabel: "Review run ID",
    placeholder: "rrn_...",
    detailsPath: (id) => `/admin/debug/publisher/${encodeURIComponent(id)}`,
    replayPlanPath: (id) => `/admin/debug/publisher/${encodeURIComponent(id)}/replay-plan`,
    replayPath: (id) => `/admin/debug/publisher/${encodeURIComponent(id)}/replay`,
  },
  memory: {
    kind: "memory",
    label: "Memory",
    title: "Memory & Rules Inspector",
    idLabel: "Repository ID",
    placeholder: "repo_...",
    detailsPath: (id) => `/admin/debug/repos/${encodeURIComponent(id)}/memory-rules`,
  },
};

const initialRouteState = readDashboardRouteState();

const state: AppState = {
  activeMode: initialRouteState.mode ?? "product",
  activeView: initialRouteState.view ?? "overview",
  activeKind: initialRouteState.inspectorKind ?? "webhook",
  apiBaseUrl: sessionStorage.getItem(API_BASE_URL_STORAGE_KEY) ?? apiBaseUrl,
  gatewayBaseUrl: sessionStorage.getItem(GATEWAY_BASE_URL_STORAGE_KEY) ?? gatewayBaseUrl,
  route: initialRouteState,
  inspectors: {
    webhook: initialInspectorState("webhook", initialRouteState),
    job: initialInspectorState("job", initialRouteState),
    review: initialInspectorState("review", initialRouteState),
    publisher: initialInspectorState("publisher", initialRouteState),
    memory: initialInspectorState("memory", initialRouteState),
  },
  product: {},
  overview: {
    repositorySearch: initialRouteState.repositorySearch ?? "",
    reviewRepoId: initialRouteState.reviewRepoId ?? "",
    reviewStatus: initialRouteState.reviewStatus ?? "",
    reviewSearch: initialRouteState.reviewSearch ?? "",
    repositories: [],
    reviews: [],
    auditLogs: [],
    loaded: false,
    repositoriesLoaded: false,
    reviewsLoaded: false,
  },
  settings: {
    repoId: initialRouteState.settingsRepoId ?? "",
    ruleForm: defaultRuleForm(),
    rules: [],
  },
  audit: {
    orgId: initialRouteState.auditOrgId ?? "",
    action: initialRouteState.auditAction ?? "",
    resourceType: initialRouteState.auditResourceType ?? "",
    resourceId: initialRouteState.auditResourceId ?? "",
    actorUserId: initialRouteState.auditActorUserId ?? "",
    search: initialRouteState.auditSearch ?? "",
    rows: [],
  },
  security: {
    orgId: initialRouteState.securityOrgId ?? "",
    repoId: initialRouteState.securityRepoId ?? "",
    type: initialRouteState.securityType ?? "",
    severity: initialRouteState.securitySeverity ?? "",
    source: initialRouteState.securitySource ?? "",
    status: initialRouteState.securityStatus ?? "",
    actorId: initialRouteState.securityActorId ?? "",
    resourceType: initialRouteState.securityResourceType ?? "",
    resourceId: initialRouteState.securityResourceId ?? "",
    search: initialRouteState.securitySearch ?? "",
    rows: [],
  },
  usage: {
    orgId: initialRouteState.usageOrgId ?? "",
    repoId: initialRouteState.usageRepoId ?? "",
    periodStart: initialRouteState.usagePeriodStart ?? currentMonthStartIso(),
    periodEnd: initialRouteState.usagePeriodEnd ?? "",
  },
  entitlements: {
    orgId: initialRouteState.entitlementOrgId ?? "",
    featureKeys: DEFAULT_ENTITLEMENT_FEATURE_KEYS,
  },
  billing: {
    orgId: initialRouteState.billingOrgId ?? "",
    meterPeriodKey: initialRouteState.billingMeterPeriodKey ?? currentMonthKey(),
    meterStatus: initialRouteState.billingMeterStatus ?? "all",
  },
  evaluation: {
    runs: [],
    selectedSuiteId: initialRouteState.evaluationSuiteId ?? "",
    suites: [],
  },
};

readProductAuthReturn();
app.addEventListener("click", (event) => {
  void handleClick(event);
});
app.addEventListener("input", handleInput);
window.addEventListener("popstate", () => {
  void applyDashboardRouteFromBrowser();
});

render();
void loadProductSession();
void loadProductOnboarding();
void completePendingGatewayLogin();

/** Handles delegated click events from the dashboard. */
async function handleClick(event: MouseEvent): Promise<void> {
  const target = event.target instanceof HTMLElement ? event.target : undefined;
  const element = target?.closest<HTMLElement>("[data-action],[data-tab],[data-view]");
  if (!element) {
    return;
  }

  const view = element.dataset.view as ViewKind | undefined;
  if (view && isViewKind(view)) {
    state.activeView = view;
    replaceDashboardRouteFromState("push");
    render();
    if (view === "overview" && state.session && state.overview.repositories.length === 0) {
      await loadOverview();
    }
    if (view === "usage" && state.session && !state.usage.data) {
      await loadUsageSummary();
    }
    if (view === "plan" && state.session && !state.entitlements.data) {
      await loadEntitlementSummary();
    }
    if (view === "billing" && state.session && !state.billing.data) {
      await loadBillingSummary();
    }
    if (view === "evaluation" && state.session && state.evaluation.suites.length === 0) {
      await loadEvaluationSuites();
    }
    return;
  }

  const tab = element.dataset.tab as InspectorKind | undefined;
  if (tab && isInspectorKind(tab)) {
    state.activeKind = tab;
    replaceDashboardRouteFromState("push");
    render();
    return;
  }

  const action = element.dataset.action;
  if (!action) {
    return;
  }

  event.preventDefault();
  if (action === "show-product") {
    state.activeMode = "product";
    replaceDashboardRouteFromState("push");
    render();
    if (!state.product.data && !state.product.loading) {
      await loadProductOnboarding();
    }
    return;
  }

  if (action === "show-admin") {
    state.activeMode = "admin";
    replaceDashboardRouteFromState("push");
    render();
    return;
  }

  if (action === "load-product") {
    await loadProductOnboarding();
    return;
  }

  if (action === "install-github-app") {
    openGitHubInstall();
    return;
  }

  if (action === "login-product-github") {
    startProductGitHubLogin();
    return;
  }

  if (action === "refresh-product-session") {
    await loadProductSession();
    return;
  }

  if (action === "load-product-resources") {
    await loadProductResources();
    return;
  }

  if (action === "select-product-org") {
    await loadProductResources(requiredDatasetValue(element, "orgId"), "push");
    return;
  }

  if (action === "refresh-product-org-settings") {
    await loadProductOrgSettings(requiredDatasetValue(element, "orgId"));
    return;
  }

  if (action === "save-product-org-settings") {
    await saveProductOrgSettings();
    return;
  }

  if (action === "toggle-product-repository") {
    await setProductRepositoryEnabled(
      requiredDatasetValue(element, "repoId"),
      requiredDatasetValue(element, "enabled") === "true",
    );
    return;
  }

  if (action === "reindex-product-repository") {
    await reindexProductRepository(requiredDatasetValue(element, "repoId"));
    return;
  }

  if (action === "open-product-repository-settings") {
    await loadProductRepositorySettings(requiredDatasetValue(element, "repoId"), "push");
    return;
  }

  if (action === "open-product-review-detail") {
    await loadProductReviewDetail(requiredDatasetValue(element, "reviewRunId"), "push");
    return;
  }

  if (action === "refresh-product-review-detail") {
    const reviewRunId = state.product.reviewDetail?.reviewRunId;
    if (reviewRunId) {
      await loadProductReviewDetail(reviewRunId);
    }
    return;
  }

  if (action === "load-product-review-artifacts") {
    await loadProductReviewArtifacts(requiredDatasetValue(element, "reviewRunId"));
    return;
  }

  if (action === "load-product-review-artifact-payload") {
    await loadProductReviewArtifactPayload(
      requiredDatasetValue(element, "reviewRunId"),
      requiredDatasetValue(element, "artifactId"),
    );
    return;
  }

  if (action === "download-product-review-artifact-payload") {
    await downloadProductReviewArtifactPayload(
      requiredDatasetValue(element, "reviewRunId"),
      requiredDatasetValue(element, "artifactId"),
    );
    return;
  }

  if (action === "select-product-finding") {
    await loadProductFindingDetail(requiredDatasetValue(element, "findingId"), "push");
    return;
  }

  if (action === "set-product-finding-outcome") {
    const outcome = requiredDatasetValue(element, "outcome");
    if (isProductFindingOutcomeValue(outcome)) {
      await recordProductFindingOutcome(requiredDatasetValue(element, "findingId"), outcome);
    }
    return;
  }

  if (action === "suppress-product-finding-similar") {
    await suppressProductFindingSimilar(requiredDatasetValue(element, "findingId"));
    return;
  }

  if (action === "rerun-product-review") {
    await rerunProductReview(requiredDatasetValue(element, "reviewRunId"));
    return;
  }

  if (action === "preview-product-policy") {
    await previewProductPolicy();
    return;
  }

  if (action === "save-product-settings") {
    await saveProductRepositorySettings();
    return;
  }

  if (action === "save-product-rule") {
    await saveProductRepositoryRule();
    return;
  }

  if (action === "edit-product-rule") {
    editProductRepositoryRule(requiredDatasetValue(element, "ruleId"));
    return;
  }

  if (action === "cancel-product-rule-edit") {
    if (state.product.repositorySettings) {
      state.product.repositorySettings.ruleForm = defaultRuleForm();
    }
    render();
    return;
  }

  if (action === "delete-product-rule") {
    await deleteProductRepositoryRule(requiredDatasetValue(element, "ruleId"));
    return;
  }

  if (action === "approve-product-memory-candidate") {
    await moderateProductMemoryCandidate(
      requiredDatasetValue(element, "memoryCandidateId"),
      "approve",
    );
    return;
  }

  if (action === "reject-product-memory-candidate") {
    await moderateProductMemoryCandidate(
      requiredDatasetValue(element, "memoryCandidateId"),
      "reject",
    );
    return;
  }

  if (action === "refresh-product-memory") {
    const settings = state.product.repositorySettings;
    if (settings) {
      settings.loading = "Refreshing repository memory";
      settings.error = undefined;
      render();
      try {
        await refreshProductRepositoryMemory(settings.repoId);
      } catch (error) {
        settings.error = errorMessage(error);
      } finally {
        settings.loading = undefined;
        render();
      }
    }
    return;
  }

  if (action === "logout-product") {
    await logoutProductSession();
    return;
  }

  if (action === "login-github") {
    startGitHubLogin();
    return;
  }

  if (action === "connect-admin-session") {
    await connectAdminSession();
    return;
  }

  if (action === "refresh-session") {
    await refreshAdminSession();
    return;
  }

  if (action === "clear-auth") {
    await clearAuth();
    return;
  }

  if (action === "load-details") {
    await loadDetails(state.activeKind);
    return;
  }

  if (action === "load-overview") {
    await loadOverview();
    return;
  }

  if (action === "search-repositories") {
    await loadRepositories();
    return;
  }

  if (action === "search-reviews") {
    await loadReviewHistory();
    return;
  }

  if (action === "clear-review-filter") {
    state.overview.reviewRepoId = "";
    state.overview.reviewStatus = "";
    state.overview.reviewSearch = "";
    replaceDashboardRouteFromState();
    await loadReviewHistory();
    return;
  }

  if (action === "open-settings") {
    await openRepositorySettings(requiredDatasetValue(element, "repoId"));
    return;
  }

  if (action === "filter-reviews-repo") {
    state.activeView = "overview";
    state.overview.reviewRepoId = requiredDatasetValue(element, "repoId");
    replaceDashboardRouteFromState();
    await loadReviewHistory();
    return;
  }

  if (action === "open-repository-audit") {
    await openAuditSearch({
      resourceId: requiredDatasetValue(element, "repoId"),
      resourceType: "repository",
    });
    return;
  }

  if (action === "open-review-inspector") {
    await openInspector("review", requiredDatasetValue(element, "reviewRunId"));
    return;
  }

  if (action === "open-publisher-inspector") {
    await openInspector("publisher", requiredDatasetValue(element, "reviewRunId"));
    return;
  }

  if (action === "open-review-audit") {
    await openAuditSearch({
      resourceId: requiredDatasetValue(element, "reviewRunId"),
      search: requiredDatasetValue(element, "reviewRunId"),
    });
    return;
  }

  if (action === "open-audit-row") {
    await openAuditSearch({
      resourceId: element.dataset.resourceId,
      resourceType: element.dataset.resourceType,
      search: element.dataset.search,
    });
    return;
  }

  if (action === "create-plan") {
    await createReplayPlan(state.activeKind);
    return;
  }

  if (action === "run-retrieval-replay") {
    await runRetrievalReplay(state.activeKind);
    return;
  }

  if (action === "run-validation-replay") {
    await runValidationReplay(state.activeKind);
    return;
  }

  if (action === "execute-replay") {
    await executeReplay(state.activeKind);
    return;
  }

  if (action === "cancel-job") {
    await cancelBackgroundJob(state.activeKind);
    return;
  }

  if (action === "export-debug-bundle") {
    await exportDebugBundle(state.activeKind);
    return;
  }

  if (action === "import-eval") {
    await importToEval(state.activeKind);
    return;
  }

  if (action === "approve-memory-candidate") {
    await moderateMemoryCandidate(requiredDatasetValue(element, "memoryCandidateId"), "approve");
    return;
  }

  if (action === "reject-memory-candidate") {
    await moderateMemoryCandidate(requiredDatasetValue(element, "memoryCandidateId"), "reject");
    return;
  }

  if (action === "load-settings") {
    await loadSettings();
    return;
  }

  if (action === "preview-policy") {
    await previewPolicy();
    return;
  }

  if (action === "save-settings") {
    await saveSettings();
    return;
  }

  if (action === "save-rule") {
    await saveRepositoryRule();
    return;
  }

  if (action === "edit-rule") {
    editRepositoryRule(requiredDatasetValue(element, "ruleId"));
    return;
  }

  if (action === "cancel-rule-edit") {
    state.settings.ruleForm = defaultRuleForm();
    render();
    return;
  }

  if (action === "delete-rule") {
    await deleteRepositoryRule(requiredDatasetValue(element, "ruleId"));
    return;
  }

  if (action === "load-audit") {
    await loadAuditHistory();
    return;
  }

  if (action === "load-security") {
    await loadSecurityEvents();
    return;
  }

  if (action === "load-usage") {
    await loadUsageSummary();
    return;
  }

  if (action === "load-entitlements") {
    await loadEntitlementSummary();
    return;
  }

  if (action === "load-billing") {
    await loadBillingSummary();
    return;
  }

  if (action === "load-evaluation") {
    await loadEvaluationSuites();
    return;
  }

  if (action === "select-evaluation-suite") {
    await loadEvaluationRuns(requiredDatasetValue(element, "suiteId"));
    return;
  }

  if (action === "open-evaluation-run") {
    await loadEvaluationRun(requiredDatasetValue(element, "runId"));
    return;
  }

  if (action === "create-billing-portal-session") {
    await createBillingPortalSession();
    return;
  }

  if (action === "run-billing-reconciliation") {
    await runBillingReconciliation();
  }
}

/** Handles delegated input events from the dashboard. */
function handleInput(event: Event): void {
  const target = event.target;
  if (
    !(
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement
    )
  ) {
    return;
  }

  const field = target.dataset.field;
  if (field === "api-base-url") {
    state.apiBaseUrl = target.value;
    return;
  }

  if (field === "gateway-base-url") {
    state.gatewayBaseUrl = target.value;
    return;
  }

  if (field === "resource-id") {
    const inspector = currentInspectorState();
    inspector.id = target.value;
    inspector.error = undefined;
    replaceDashboardRouteFromState();
    return;
  }

  if (field === "confirmation-token") {
    currentInspectorState().confirmationTokenInput = target.value;
    return;
  }

  if (field === "cancel-reason") {
    currentInspectorState().cancelReasonInput = target.value;
    return;
  }

  if (field?.startsWith("overview.")) {
    updateOverviewField(field.slice("overview.".length), target.value);
    replaceDashboardRouteFromState();
    return;
  }

  if (field === "settings-repo-id") {
    state.settings.repoId = target.value;
    state.settings.error = undefined;
    replaceDashboardRouteFromState();
    return;
  }

  if (field?.startsWith("settings.")) {
    updateSettingsFormField(field.slice("settings.".length), target);
    return;
  }

  if (field?.startsWith("productOrgSettings.")) {
    updateProductOrgSettingsFormField(field.slice("productOrgSettings.".length), target);
    return;
  }

  if (field?.startsWith("productSettings.")) {
    updateProductSettingsFormField(field.slice("productSettings.".length), target);
    return;
  }

  if (field?.startsWith("rule.")) {
    updateRuleFormField(field.slice("rule.".length), target);
    return;
  }

  if (field?.startsWith("productRule.")) {
    updateProductRuleFormField(field.slice("productRule.".length), target);
    return;
  }

  if (field === "productFinding.outcomeNote") {
    if (state.product.reviewDetail) {
      state.product.reviewDetail.outcomeNote = target.value;
    }
    return;
  }

  if (field === "productReview.artifactAccessReason") {
    if (state.product.reviewDetail) {
      state.product.reviewDetail.artifactAccessReason = target.value;
    }
    return;
  }

  if (field === "productFinding.suppressionReason") {
    if (state.product.reviewDetail) {
      state.product.reviewDetail.suppressionReason = target.value;
    }
    return;
  }

  if (field === "productFinding.suppressionScope") {
    if (state.product.reviewDetail && (target.value === "repo" || target.value === "org")) {
      state.product.reviewDetail.suppressionScope = target.value;
    }
    return;
  }

  if (field?.startsWith("audit.")) {
    updateAuditField(field.slice("audit.".length), target.value);
    replaceDashboardRouteFromState();
    return;
  }

  if (field?.startsWith("security.")) {
    updateSecurityEventField(field.slice("security.".length), target.value);
    replaceDashboardRouteFromState();
    return;
  }

  if (field?.startsWith("usage.")) {
    updateUsageField(field.slice("usage.".length), target.value);
    replaceDashboardRouteFromState();
    return;
  }

  if (field?.startsWith("entitlements.")) {
    updateEntitlementsField(field.slice("entitlements.".length), target.value);
    replaceDashboardRouteFromState();
    return;
  }

  if (field?.startsWith("billing.")) {
    updateBillingField(field.slice("billing.".length), target.value);
    replaceDashboardRouteFromState();
  }
}

/** Continues the GitHub login return path when OAuth redirected back to the dashboard. */
async function completePendingGatewayLogin(): Promise<void> {
  if (sessionStorage.getItem(PENDING_GATEWAY_LOGIN_STORAGE_KEY) !== "true") {
    return;
  }

  state.activeMode = "admin";
  replaceDashboardRouteFromState();
  await connectAdminSession();
}

/** Reads product OAuth callback status from the dashboard URL. */
function readProductAuthReturn(): void {
  const url = new URL(window.location.href);
  const authError = url.searchParams.get("authError");
  if (!authError) {
    return;
  }

  state.activeMode = "product";
  state.product.authError = authErrorMessage(authError);
  state.route = { ...state.route, mode: "product" };
  url.searchParams.delete("authError");
  url.searchParams.set("mode", "product");
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

/** Starts the product GitHub OAuth login flow through the API. */
function startProductGitHubLogin(): void {
  state.product.authError = undefined;
  persistLoginConfig();
  window.location.assign(productGitHubLoginStartUrl());
}

/** Starts the GitHub OAuth login flow through the configured admin gateway. */
function startGitHubLogin(): void {
  state.authError = undefined;
  persistLoginConfig();
  sessionStorage.setItem(PENDING_GATEWAY_LOGIN_STORAGE_KEY, "true");
  window.location.assign(githubLoginStartUrl());
}

/** Connects the dashboard to the admin API using a gateway-issued identity assertion. */
async function connectAdminSession(): Promise<void> {
  state.authError = undefined;
  state.authLoading = "Connecting admin session";
  render();
  try {
    persistLoginConfig();
    const assertion = await requestGatewayAssertion();
    await requestAdminData<AdminSession>("/admin/auth/login", {
      headers: identityAssertionHeaders(assertion),
      method: "POST",
    });
    const session = await requestAdminData<AdminSession>("/admin/session");
    state.session = session;
    sessionStorage.removeItem(PENDING_GATEWAY_LOGIN_STORAGE_KEY);
    await loadAdminRouteData();
  } catch (error) {
    state.session = undefined;
    state.authError = errorMessage(error);
    sessionStorage.removeItem(PENDING_GATEWAY_LOGIN_STORAGE_KEY);
  } finally {
    state.authLoading = undefined;
    render();
  }
}

/** Refreshes the current API session cookie and reloads the overview. */
async function refreshAdminSession(): Promise<void> {
  state.authError = undefined;
  state.authLoading = "Refreshing admin session";
  render();
  try {
    persistLoginConfig();
    const session = await requestAdminData<AdminSession>("/admin/session");
    state.session = session;
    await loadAdminRouteData();
  } catch (error) {
    state.session = undefined;
    state.authError = errorMessage(error);
  } finally {
    state.authLoading = undefined;
    render();
  }
}

/** Clears authentication state from memory and session storage. */
async function clearAuth(): Promise<void> {
  state.authError = undefined;
  state.authLoading = "Logging out";
  render();
  try {
    if (state.session) {
      await requestAdminData<{ readonly ok: boolean }>("/admin/auth/logout", { method: "POST" });
    }
  } catch (error) {
    state.authError = errorMessage(error);
  } finally {
    sessionStorage.removeItem(PENDING_GATEWAY_LOGIN_STORAGE_KEY);
    state.session = undefined;
    state.overview = {
      ...state.overview,
      auditLogs: [],
      error: undefined,
      loaded: false,
      loading: undefined,
      repositories: [],
      repositoriesLoaded: false,
      reviews: [],
      reviewsLoaded: false,
    };
    state.evaluation = {
      runs: [],
      selectedSuiteId: "",
      suites: [],
    };
    state.authLoading = undefined;
    render();
  }
}

/** Loads the current product session when the user has a product cookie. */
async function loadProductSession(): Promise<void> {
  state.product.sessionLoading = "Checking product session";
  state.product.authError = undefined;
  render();
  try {
    state.product.session = await requestProductData<ProductMeResponse>("/api/v1/me");
    await loadProductResources(state.route.productOrgId);
    await loadProductRouteSelections();
  } catch (error) {
    state.product.session = undefined;
    state.product.resources = undefined;
    state.product.orgSettings = undefined;
    state.product.repositorySettings = undefined;
    state.product.reviewDetail = undefined;
    if (!isUnauthorizedError(error)) {
      state.product.authError = errorMessage(error);
    }
  } finally {
    state.product.sessionLoading = undefined;
    render();
  }
}

/** Revokes the current product session and clears product UI state. */
async function logoutProductSession(): Promise<void> {
  state.product.sessionLoading = "Signing out";
  state.product.authError = undefined;
  render();
  try {
    if (state.product.session) {
      await requestProductData<{ readonly ok: boolean }>("/api/v1/auth/logout", {
        method: "POST",
      });
    }
  } catch (error) {
    state.product.authError = errorMessage(error);
  } finally {
    state.product.session = undefined;
    state.product.resources = undefined;
    state.product.orgSettings = undefined;
    state.product.repositorySettings = undefined;
    state.product.reviewDetail = undefined;
    state.product.sessionLoading = undefined;
    render();
  }
}

/** Loads authenticated product organizations, repositories, reviews, and usage. */
async function loadProductResources(
  orgId?: string,
  historyMode: "replace" | "push" = "replace",
): Promise<void> {
  if (!state.product.session) {
    return;
  }

  state.product.resources = {
    ...defaultProductResources(state.product.resources),
    loading: "Loading product workspace",
  };
  render();

  try {
    const orgsResponse = await requestProductData<{
      readonly orgs: readonly ProductOrganizationSummary[];
    }>("/api/v1/orgs?limit=50");
    const selectedOrgId = selectedProductOrgId(orgsResponse.orgs, orgId);
    if (!selectedOrgId) {
      state.product.resources = {
        orgs: orgsResponse.orgs,
        repositories: [],
        reviews: [],
        loaded: true,
      };
      state.product.orgSettings = undefined;
      replaceDashboardRouteFromState(historyMode);
      return;
    }

    state.product.orgSettings = {
      orgId: selectedOrgId,
      loading: "Loading organization settings",
    };

    const [repositoriesResponse, reviewsResponse, usage, orgSettings] = await Promise.all([
      requestProductData<{ readonly repositories: readonly AdminRepositorySummary[] }>(
        `/api/v1/orgs/${encodeURIComponent(selectedOrgId)}/repositories?limit=50`,
      ),
      requestProductData<{ readonly reviews: readonly AdminReviewRunSummary[] }>(
        `/api/v1/orgs/${encodeURIComponent(selectedOrgId)}/review-runs?limit=10`,
      ),
      requestProductData<ProductUsageSummary>(
        `/api/v1/orgs/${encodeURIComponent(selectedOrgId)}/usage/summary?groupBy=repo`,
      ),
      requestProductData<ProductOrgSettingsResponse>(
        `/api/v1/orgs/${encodeURIComponent(selectedOrgId)}/settings`,
      ),
    ]);

    state.product.resources = {
      orgs: orgsResponse.orgs,
      repositories: repositoriesResponse.repositories,
      reviews: reviewsResponse.reviews,
      selectedOrgId,
      usage,
      loaded: true,
    };
    state.product.orgSettings = {
      data: orgSettings.settings,
      form: productOrgSettingsFormFromSettings(orgSettings.settings),
      orgId: selectedOrgId,
    };
    replaceDashboardRouteFromState(historyMode);
  } catch (error) {
    state.product.resources = {
      ...defaultProductResources(state.product.resources),
      error: errorMessage(error),
    };
    if (state.product.orgSettings) {
      state.product.orgSettings = {
        ...state.product.orgSettings,
        error: errorMessage(error),
        loading: undefined,
      };
    }
  } finally {
    render();
  }
}

/** Enables or disables a repository through the authenticated product API. */
async function setProductRepositoryEnabled(repoId: string, enabled: boolean): Promise<void> {
  const resources = defaultProductResources(state.product.resources);
  state.product.resources = {
    ...resources,
    loading: enabled ? "Enabling repository" : "Disabling repository",
  };
  render();

  try {
    await requestProductData<unknown>(
      `/api/v1/repositories/${encodeURIComponent(repoId)}/${enabled ? "enable" : "disable"}`,
      { method: "POST" },
    );
    await loadProductResources(resources.selectedOrgId);
  } catch (error) {
    state.product.resources = {
      ...resources,
      error: errorMessage(error),
    };
    render();
  }
}

/** Enqueues a default-branch repository reindex through the authenticated product API. */
async function reindexProductRepository(repoId: string): Promise<void> {
  const resources = defaultProductResources(state.product.resources);
  state.product.resources = {
    ...resources,
    loading: "Queueing repository reindex",
  };
  render();

  try {
    await requestProductData<unknown>(
      `/api/v1/repositories/${encodeURIComponent(repoId)}/reindex`,
      {
        body: JSON.stringify({
          force: true,
          reason: "Manual product dashboard reindex",
        }),
        headers: {
          "idempotency-key": `product-reindex-${repoId}-${crypto.randomUUID()}`,
        },
        method: "POST",
      },
    );
    await loadProductResources(resources.selectedOrgId);
  } catch (error) {
    state.product.resources = {
      ...resources,
      error: errorMessage(error),
    };
    render();
  }
}

/** Refreshes organization policy defaults for the selected product organization. */
async function loadProductOrgSettings(orgId: string): Promise<void> {
  state.product.orgSettings = {
    orgId,
    loading: "Loading organization settings",
  };
  render();

  try {
    const data = await requestProductData<ProductOrgSettingsResponse>(
      `/api/v1/orgs/${encodeURIComponent(orgId)}/settings`,
    );
    state.product.orgSettings = {
      data: data.settings,
      form: productOrgSettingsFormFromSettings(data.settings),
      orgId,
    };
  } catch (error) {
    state.product.orgSettings = {
      orgId,
      error: errorMessage(error),
    };
  } finally {
    render();
  }
}

/** Saves organization policy defaults for the selected product organization. */
async function saveProductOrgSettings(): Promise<void> {
  const settings = state.product.orgSettings;
  const form = settings?.form;
  if (!settings || !form) {
    return;
  }

  settings.loading = "Saving organization settings";
  settings.error = undefined;
  settings.saved = undefined;
  render();

  try {
    const data = await requestProductData<ProductOrgSettingsResponse>(
      `/api/v1/orgs/${encodeURIComponent(settings.orgId)}/settings`,
      {
        body: JSON.stringify(productOrgSettingsPatchFromForm(form)),
        method: "PATCH",
      },
    );
    settings.data = data.settings;
    settings.form = productOrgSettingsFormFromSettings(data.settings);
    settings.saved = "Organization settings saved.";
  } catch (error) {
    settings.error = errorMessage(error);
  } finally {
    settings.loading = undefined;
    render();
  }
}

/** Loads product repository settings, rules, and effective policy preview. */
async function loadProductRepositorySettings(
  repoId: string,
  historyMode: "replace" | "push" = "replace",
): Promise<void> {
  state.product.repositorySettings = {
    memoryCandidates: [],
    memoryFacts: [],
    repoId,
    ruleForm: defaultRuleForm(),
    rules: [],
    suppressionMatches: [],
    loading: "Loading repository settings",
  };
  replaceDashboardRouteFromState(historyMode);
  render();

  try {
    const [data, rulesData, memoryData] = await Promise.all([
      requestProductData<ControlPlaneSettingsResponse>(
        `/api/v1/repositories/${encodeURIComponent(repoId)}`,
      ),
      requestProductData<{ readonly rules: readonly AdminRepoRuleSummary[] }>(
        `/api/v1/repositories/${encodeURIComponent(repoId)}/rules`,
      ),
      requestProductRepositoryMemory(repoId),
    ]);
    const form = settingsFormFromResponse(data);
    state.product.repositorySettings = {
      data,
      form,
      memoryCandidates: memoryData.memoryCandidates,
      memoryFacts: memoryData.memoryFacts,
      preview: await requestProductPolicyPreview(repoId, form),
      repoId,
      ruleForm: defaultRuleForm(),
      rules: rulesData.rules,
      suppressionMatches: memoryData.suppressionMatches,
    };
  } catch (error) {
    state.product.repositorySettings = {
      memoryCandidates: [],
      memoryFacts: [],
      repoId,
      ruleForm: defaultRuleForm(),
      rules: [],
      suppressionMatches: [],
      error: errorMessage(error),
    };
  } finally {
    render();
  }
}

/** Saves the selected product repository settings through the product API. */
async function saveProductRepositorySettings(): Promise<void> {
  const settings = state.product.repositorySettings;
  const form = settings?.form;
  if (!settings || !form) {
    return;
  }

  settings.loading = "Saving repository settings";
  settings.error = undefined;
  settings.saved = undefined;
  render();

  try {
    const data = await requestProductData<ControlPlaneSettingsResponse>(
      `/api/v1/repositories/${encodeURIComponent(settings.repoId)}/settings`,
      {
        body: JSON.stringify(settingsPatchFromForm(form)),
        method: "PATCH",
      },
    );
    settings.data = data;
    settings.form = settingsFormFromResponse(data);
    settings.preview = await requestProductPolicyPreview(settings.repoId, settings.form);
    settings.saved = "Settings saved and policy preview refreshed.";
    if (state.product.resources?.selectedOrgId) {
      await loadProductResources(state.product.resources.selectedOrgId);
    }
  } catch (error) {
    settings.error = errorMessage(error);
  } finally {
    settings.loading = undefined;
    render();
  }
}

/** Refreshes the product policy preview for the current unsaved settings form. */
async function previewProductPolicy(): Promise<void> {
  const settings = state.product.repositorySettings;
  const form = settings?.form;
  if (!settings || !form) {
    return;
  }

  settings.loading = "Compiling policy preview";
  settings.error = undefined;
  settings.saved = undefined;
  render();

  try {
    settings.preview = await requestProductPolicyPreview(settings.repoId, form);
  } catch (error) {
    settings.error = errorMessage(error);
  } finally {
    settings.loading = undefined;
    render();
  }
}

/** Requests a product policy preview for one repository settings form. */
async function requestProductPolicyPreview(
  repoId: string,
  form: SettingsFormState,
): Promise<ControlPlanePolicyPreview> {
  return requestProductData<ControlPlanePolicyPreview>(
    `/api/v1/repositories/${encodeURIComponent(repoId)}/policy-preview`,
    {
      body: JSON.stringify(settingsPatchFromForm(form)),
      method: "POST",
    },
  );
}

/** Saves the product repository rule form as a new or updated rule. */
async function saveProductRepositoryRule(): Promise<void> {
  const settings = state.product.repositorySettings;
  if (!settings?.form) {
    return;
  }

  const ruleForm = settings.ruleForm;
  settings.loading = ruleForm.editingRuleId ? "Updating repository rule" : "Creating rule";
  settings.error = undefined;
  settings.saved = undefined;
  render();

  try {
    const editingRuleId = ruleForm.editingRuleId.trim();
    await requestProductData<AdminRepoRuleSummary>(
      editingRuleId
        ? `/api/v1/repositories/${encodeURIComponent(settings.repoId)}/rules/${encodeURIComponent(editingRuleId)}`
        : `/api/v1/repositories/${encodeURIComponent(settings.repoId)}/rules`,
      {
        body: JSON.stringify(ruleRequestFromForm(ruleForm)),
        method: editingRuleId ? "PATCH" : "POST",
      },
    );
    await refreshProductRepositoryRulesAndPreview(settings.repoId);
    settings.ruleForm = defaultRuleForm();
    settings.saved = editingRuleId ? "Rule updated." : "Rule created.";
  } catch (error) {
    settings.error = errorMessage(error);
  } finally {
    settings.loading = undefined;
    render();
  }
}

/** Deletes one product repository rule after explicit confirmation. */
async function deleteProductRepositoryRule(ruleId: string): Promise<void> {
  const settings = state.product.repositorySettings;
  if (!settings?.form) {
    return;
  }
  if (!window.confirm(`Delete repository rule ${ruleId}?`)) {
    return;
  }

  settings.loading = "Deleting repository rule";
  settings.error = undefined;
  settings.saved = undefined;
  render();

  try {
    await requestProductData<AdminRepoRuleSummary>(
      `/api/v1/repositories/${encodeURIComponent(settings.repoId)}/rules/${encodeURIComponent(ruleId)}`,
      { method: "DELETE" },
    );
    await refreshProductRepositoryRulesAndPreview(settings.repoId);
    if (settings.ruleForm.editingRuleId === ruleId) {
      settings.ruleForm = defaultRuleForm();
    }
    settings.saved = "Rule deleted.";
  } catch (error) {
    settings.error = errorMessage(error);
  } finally {
    settings.loading = undefined;
    render();
  }
}

/** Loads an existing product rule into the repository rule form. */
function editProductRepositoryRule(ruleId: string): void {
  const settings = state.product.repositorySettings;
  const rule = settings?.rules.find((candidate) => candidate.ruleId === ruleId);
  if (!settings || !rule) {
    return;
  }

  settings.ruleForm = ruleFormFromSummary(rule);
  settings.error = undefined;
  settings.saved = undefined;
  render();
}

/** Refreshes product rule rows and policy preview after a rule mutation. */
async function refreshProductRepositoryRulesAndPreview(repoId: string): Promise<void> {
  const settings = state.product.repositorySettings;
  if (!settings) {
    return;
  }

  settings.rules = await requestProductRepositoryRules(repoId);
  if (settings.form) {
    settings.preview = await requestProductPolicyPreview(repoId, settings.form);
  }
}

/** Refreshes product memory facts and candidates after a moderation decision. */
async function refreshProductRepositoryMemory(repoId: string): Promise<void> {
  const settings = state.product.repositorySettings;
  if (!settings) {
    return;
  }

  const data = await requestProductRepositoryMemory(repoId);
  settings.memoryCandidates = data.memoryCandidates;
  settings.memoryFacts = data.memoryFacts;
  settings.suppressionMatches = data.suppressionMatches;
}

/** Requests product repository and organization rules for one repository. */
async function requestProductRepositoryRules(
  repoId: string,
): Promise<readonly AdminRepoRuleSummary[]> {
  const data = await requestProductData<{ readonly rules: readonly AdminRepoRuleSummary[] }>(
    `/api/v1/repositories/${encodeURIComponent(repoId)}/rules`,
  );
  return data.rules;
}

/** Requests product repository memory facts and candidates for one repository. */
async function requestProductRepositoryMemory(
  repoId: string,
): Promise<ProductRepositoryMemoryResponse> {
  return requestProductData<ProductRepositoryMemoryResponse>(
    `/api/v1/repositories/${encodeURIComponent(repoId)}/memory`,
  );
}

/** Loads product review details and validated findings for one review run. */
async function loadProductReviewDetail(
  reviewRunId: string,
  historyMode: "replace" | "push" = "replace",
): Promise<void> {
  const previousDetail = state.product.reviewDetail;
  const previousArtifacts =
    previousDetail?.reviewRunId === reviewRunId ? previousDetail.artifacts : undefined;
  const previousArtifactsLoaded =
    previousDetail?.reviewRunId === reviewRunId ? previousDetail.artifactsLoaded : undefined;
  const previousArtifactAccessReason =
    previousDetail?.reviewRunId === reviewRunId ? previousDetail.artifactAccessReason : "";
  const previousArtifactPayload =
    previousDetail?.reviewRunId === reviewRunId ? previousDetail.artifactPayload : undefined;
  const previousSelectedFindingId =
    previousDetail?.reviewRunId === reviewRunId
      ? previousDetail.selectedFinding?.findingId
      : undefined;

  state.product.reviewDetail = {
    reviewRunId,
    artifactAccessReason: previousArtifactAccessReason,
    artifactPayload: previousArtifactPayload,
    artifacts: previousArtifacts,
    artifactsLoaded: previousArtifactsLoaded,
    findings: previousDetail?.reviewRunId === reviewRunId ? previousDetail.findings : [],
    outcomeNote: "",
    suppressionReason:
      previousDetail?.reviewRunId === reviewRunId ? previousDetail.suppressionReason : "",
    suppressionScope:
      previousDetail?.reviewRunId === reviewRunId ? previousDetail.suppressionScope : "repo",
    loading: "Loading review detail",
  };
  replaceDashboardRouteFromState(historyMode);
  render();

  try {
    const [detailResponse, findingsResponse] = await Promise.all([
      requestProductData<{ readonly reviewRun: AdminReviewRunSummary }>(
        `/api/v1/review-runs/${encodeURIComponent(reviewRunId)}`,
      ),
      requestProductData<{
        readonly findings: readonly AdminReviewFindingSummary[];
        readonly reviewRun: AdminReviewRunSummary;
      }>(`/api/v1/review-runs/${encodeURIComponent(reviewRunId)}/findings?limit=50`),
    ]);
    const selectedFinding =
      findingsResponse.findings.find(
        (finding) => finding.findingId === previousSelectedFindingId,
      ) ?? findingsResponse.findings[0];
    state.product.reviewDetail = {
      artifactAccessReason: previousArtifactAccessReason,
      artifactPayload: previousArtifactPayload,
      artifacts: previousArtifacts,
      artifactsLoaded: previousArtifactsLoaded,
      findings: findingsResponse.findings,
      outcomeNote: selectedFinding?.latestOutcome?.notes ?? "",
      reviewRun: detailResponse.reviewRun,
      reviewRunId,
      selectedFinding,
      suppressionReason:
        previousDetail?.reviewRunId === reviewRunId ? previousDetail.suppressionReason : "",
      suppressionScope:
        previousDetail?.reviewRunId === reviewRunId ? previousDetail.suppressionScope : "repo",
    };
    replaceDashboardRouteFromState(historyMode);
  } catch (error) {
    state.product.reviewDetail = {
      reviewRunId,
      artifactAccessReason: "",
      artifacts: previousArtifacts,
      artifactsLoaded: previousArtifactsLoaded,
      findings: [],
      outcomeNote: "",
      suppressionReason: "",
      suppressionScope: "repo",
      error: errorMessage(error),
    };
  } finally {
    render();
  }
}

/** Loads payload-free artifact metadata for the selected product review. */
async function loadProductReviewArtifacts(reviewRunId: string): Promise<void> {
  const detail = state.product.reviewDetail;
  if (!detail || detail.reviewRunId !== reviewRunId) {
    return;
  }

  detail.loading = "Loading artifact metadata";
  detail.error = undefined;
  detail.saved = undefined;
  render();

  try {
    const data = await requestProductData<{
      readonly artifacts: readonly AdminReviewArtifactSummary[];
      readonly reviewRun: AdminReviewRunSummary;
    }>(`/api/v1/review-runs/${encodeURIComponent(reviewRunId)}/artifacts`);
    const activeDetail = state.product.reviewDetail;
    if (!activeDetail || activeDetail.reviewRunId !== reviewRunId) {
      return;
    }

    activeDetail.artifacts = data.artifacts;
    activeDetail.artifactsLoaded = true;
    activeDetail.reviewRun = data.reviewRun;
  } catch (error) {
    const activeDetail = state.product.reviewDetail;
    if (activeDetail?.reviewRunId === reviewRunId) {
      activeDetail.error = errorMessage(error);
    }
  } finally {
    const activeDetail = state.product.reviewDetail;
    if (activeDetail?.reviewRunId === reviewRunId) {
      activeDetail.loading = undefined;
    }
    render();
  }
}

/** Loads a redacted artifact payload for the selected product review. */
async function loadProductReviewArtifactPayload(
  reviewRunId: string,
  artifactId: string,
): Promise<void> {
  const detail = state.product.reviewDetail;
  if (!detail || detail.reviewRunId !== reviewRunId) {
    return;
  }

  const reason = detail.artifactAccessReason.trim();
  if (!reason) {
    detail.error = "Enter an access reason before viewing an artifact payload.";
    render();
    return;
  }

  detail.loading = "Loading redacted artifact payload";
  detail.error = undefined;
  detail.saved = undefined;
  render();

  try {
    const query = new URLSearchParams({ reason });
    const data = await requestProductData<{
      readonly accessLevel: "redacted" | "raw_allowed";
      readonly artifact: AdminReviewArtifactSummary;
      readonly artifactAccessEventId: string;
      readonly payload: unknown;
      readonly reviewRun: AdminReviewRunSummary;
    }>(
      `/api/v1/review-runs/${encodeURIComponent(reviewRunId)}/artifacts/${encodeURIComponent(
        artifactId,
      )}/payload?${query.toString()}`,
    );
    const activeDetail = state.product.reviewDetail;
    if (!activeDetail || activeDetail.reviewRunId !== reviewRunId) {
      return;
    }

    activeDetail.artifactPayload = {
      accessLevel: data.accessLevel,
      artifact: data.artifact,
      artifactAccessEventId: data.artifactAccessEventId,
      payload: data.payload,
    };
    activeDetail.reviewRun = data.reviewRun;
    activeDetail.saved = "Redacted artifact payload loaded.";
  } catch (error) {
    const activeDetail = state.product.reviewDetail;
    if (activeDetail?.reviewRunId === reviewRunId) {
      activeDetail.error = errorMessage(error);
    }
  } finally {
    const activeDetail = state.product.reviewDetail;
    if (activeDetail?.reviewRunId === reviewRunId) {
      activeDetail.loading = undefined;
    }
    render();
  }
}

/** Downloads a redacted artifact payload for the selected product review. */
async function downloadProductReviewArtifactPayload(
  reviewRunId: string,
  artifactId: string,
): Promise<void> {
  const detail = state.product.reviewDetail;
  if (!detail || detail.reviewRunId !== reviewRunId) {
    return;
  }

  const reason = detail.artifactAccessReason.trim();
  if (!reason) {
    detail.error = "Enter an access reason before downloading an artifact payload.";
    render();
    return;
  }

  detail.loading = "Downloading redacted artifact payload";
  detail.error = undefined;
  detail.saved = undefined;
  render();

  try {
    const query = new URLSearchParams({ reason });
    const blob = await requestProductBlob(
      `/api/v1/review-runs/${encodeURIComponent(reviewRunId)}/artifacts/${encodeURIComponent(
        artifactId,
      )}/download?${query.toString()}`,
    );
    const artifact = detail.artifacts?.find(
      (candidate) => candidate.reviewArtifactId === artifactId,
    );
    downloadBlob(blob, artifactDownloadName(artifact, artifactId));
    detail.saved = "Redacted artifact payload downloaded.";
  } catch (error) {
    detail.error = errorMessage(error);
  } finally {
    detail.loading = undefined;
    render();
  }
}

/** Loads full product finding detail for the selected finding panel. */
async function loadProductFindingDetail(
  findingId: string,
  historyMode: "replace" | "push" = "replace",
): Promise<void> {
  const detail = state.product.reviewDetail;
  if (!detail) {
    return;
  }

  detail.loading = "Loading finding detail";
  detail.error = undefined;
  detail.saved = undefined;
  render();

  try {
    const [findingData, feedbackData] = await Promise.all([
      requestProductData<{ readonly finding: AdminReviewFindingSummary }>(
        `/api/v1/findings/${encodeURIComponent(findingId)}`,
      ),
      requestProductData<{
        readonly feedbackEvents: readonly AdminReviewFindingFeedbackEventSummary[];
      }>(`/api/v1/findings/${encodeURIComponent(findingId)}/feedback-events`),
    ]);
    detail.selectedFinding = findingData.finding;
    detail.selectedFindingFeedbackEvents = feedbackData.feedbackEvents;
    detail.outcomeNote = findingData.finding.latestOutcome?.notes ?? "";
    detail.suppressionReason = "";
    detail.findings = detail.findings.map((finding) =>
      finding.findingId === findingData.finding.findingId ? findingData.finding : finding,
    );
    replaceDashboardRouteFromState(historyMode);
  } catch (error) {
    detail.error = errorMessage(error);
  } finally {
    detail.loading = undefined;
    render();
  }
}

/** Records one product finding outcome and refreshes the selected finding. */
async function recordProductFindingOutcome(
  findingId: string,
  outcome: ProductFindingOutcomeValue,
): Promise<void> {
  const detail = state.product.reviewDetail;
  if (!detail) {
    return;
  }

  detail.loading = "Recording finding outcome";
  detail.error = undefined;
  detail.saved = undefined;
  render();

  try {
    await requestProductData<unknown>(`/api/v1/findings/${encodeURIComponent(findingId)}/outcome`, {
      body: JSON.stringify({
        notes: detail.outcomeNote.trim(),
        outcome,
      }),
      method: "PATCH",
    });
    await loadProductFindingDetail(findingId);
    if (state.product.reviewDetail) {
      state.product.reviewDetail.saved = `Outcome recorded: ${outcome}.`;
    }
  } catch (error) {
    detail.error = errorMessage(error);
  } finally {
    detail.loading = undefined;
    render();
  }
}

/** Creates a suppress-similar rule from the selected product finding. */
async function suppressProductFindingSimilar(findingId: string): Promise<void> {
  const detail = state.product.reviewDetail;
  if (!detail) {
    return;
  }

  const reason = detail.suppressionReason.trim();
  if (!reason) {
    detail.error = "Enter a reason before suppressing similar findings.";
    render();
    return;
  }

  detail.loading = "Creating suppression rule";
  detail.error = undefined;
  detail.saved = undefined;
  render();

  try {
    const suppression = await requestProductData<AdminFindingSuppressionSummary>(
      `/api/v1/findings/${encodeURIComponent(findingId)}/suppress-similar`,
      {
        body: JSON.stringify({
          reason,
          scope: detail.suppressionScope,
        }),
        headers: {
          "idempotency-key": `finding-suppress-${findingId}-${crypto.randomUUID()}`,
        },
        method: "POST",
      },
    );
    detail.suppressionReason = "";
    detail.saved = `Suppression rule created: ${suppression.rule.name}.`;
    if (state.product.repositorySettings?.repoId === suppression.finding.repoId) {
      await refreshProductRepositoryRulesAndPreview(suppression.finding.repoId);
    }
  } catch (error) {
    detail.error = errorMessage(error);
  } finally {
    detail.loading = undefined;
    render();
  }
}

/** Moderates one pending memory candidate from the product repository view. */
async function moderateProductMemoryCandidate(
  memoryCandidateId: string,
  decision: MemoryCandidateModerationDecision,
): Promise<void> {
  const settings = state.product.repositorySettings;
  if (!settings) {
    return;
  }

  const candidate = settings.memoryCandidates.find(
    (row) => row.memoryCandidateId === memoryCandidateId,
  );
  if (!candidate) {
    settings.error = `Memory candidate ${memoryCandidateId} is not in the loaded repository data.`;
    render();
    return;
  }

  const reason = window.prompt(decision === "approve" ? "Approval reason" : "Rejection reason", "");
  if (reason === null) {
    return;
  }

  settings.loading =
    decision === "approve" ? "Approving memory candidate" : "Rejecting memory candidate";
  settings.error = undefined;
  settings.saved = undefined;
  render();

  try {
    await requestProductData<unknown>(
      `/api/v1/memory-candidates/${encodeURIComponent(memoryCandidateId)}/${decision}`,
      {
        body: JSON.stringify({
          metadata: {
            candidateKind: candidate.candidateKind,
            repoId: settings.repoId,
            source: "product_repository_memory",
          },
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        }),
        headers: {
          "idempotency-key": `product-memory-candidate-${decision}-${memoryCandidateId}-${crypto.randomUUID()}`,
        },
        method: "POST",
      },
    );
    await refreshProductRepositoryMemory(settings.repoId);
    settings.saved =
      decision === "approve" ? "Memory candidate approved." : "Memory candidate rejected.";
  } catch (error) {
    settings.error = errorMessage(error);
  } finally {
    settings.loading = undefined;
    render();
  }
}

/** Enqueues a product review rerun when the current role permits it. */
async function rerunProductReview(reviewRunId: string): Promise<void> {
  const detail = state.product.reviewDetail;
  if (detail) {
    detail.loading = "Queueing review rerun";
    detail.error = undefined;
    detail.saved = undefined;
  }
  render();

  try {
    await requestProductData<unknown>(
      `/api/v1/review-runs/${encodeURIComponent(reviewRunId)}/rerun`,
      {
        method: "POST",
      },
    );
    if (state.product.reviewDetail) {
      state.product.reviewDetail.saved = "Review rerun queued.";
    }
  } catch (error) {
    if (state.product.reviewDetail) {
      state.product.reviewDetail.error = errorMessage(error);
    }
  } finally {
    if (state.product.reviewDetail) {
      state.product.reviewDetail.loading = undefined;
    }
    render();
  }
}

/** Returns product resource state with stable empty collections. */
function defaultProductResources(
  resources: ProductResourcesState | undefined,
): ProductResourcesState {
  return (
    resources ?? {
      orgs: [],
      repositories: [],
      reviews: [],
      loaded: false,
    }
  );
}

/** Selects an organization for product workspace API calls. */
function selectedProductOrgId(
  orgs: readonly ProductOrganizationSummary[],
  requestedOrgId: string | undefined,
): string | undefined {
  if (requestedOrgId && orgs.some((org) => org.orgId === requestedOrgId)) {
    return requestedOrgId;
  }
  const sessionOrgId = state.product.session?.selectedOrgId;
  if (sessionOrgId && orgs.some((org) => org.orgId === sessionOrgId)) {
    return sessionOrgId;
  }

  return orgs[0]?.orgId;
}

/** Loads the product onboarding dashboard. */
async function loadProductOnboarding(): Promise<void> {
  state.product.loading = "Loading GitHub App setup";
  state.product.error = undefined;
  render();
  try {
    state.product.data = await requestProductData<ProductOnboardingSummary>("/app/onboarding");
  } catch (error) {
    state.product.error = errorMessage(error);
  } finally {
    state.product.loading = undefined;
    render();
  }
}

/** Opens the configured GitHub App installation URL. */
function openGitHubInstall(): void {
  const installUrl = state.product.data?.githubApp.installUrl;
  if (!installUrl) {
    state.product.error = "Configure HEIMDALL_GITHUB_APP_SLUG or HEIMDALL_GITHUB_APP_INSTALL_URL.";
    render();
    return;
  }

  window.location.assign(installUrl);
}

/** Loads debug details for the selected inspector. */
async function loadDetails(kind: InspectorKind): Promise<void> {
  const config = inspectorConfigs[kind];
  const inspector = state.inspectors[kind];
  const id = inspector.id.trim();
  if (!id) {
    inspector.error = `${config.idLabel} is required.`;
    render();
    return;
  }

  inspector.loading = "Loading inspector";
  inspector.error = undefined;
  inspector.cancelResult = undefined;
  inspector.debugBundle = undefined;
  inspector.evalImportDraft = undefined;
  inspector.plan = undefined;
  inspector.result = undefined;
  inspector.retrievalReplay = undefined;
  inspector.validationReplay = undefined;
  try {
    inspector.details = await requestAdminData<InspectorDetails>(config.detailsPath(id));
  } catch (error) {
    inspector.error = errorMessage(error);
  } finally {
    inspector.loading = undefined;
    render();
  }
}

/** Creates a replay plan for the selected inspector. */
async function createReplayPlan(kind: InspectorKind): Promise<void> {
  const config = inspectorConfigs[kind];
  const inspector = state.inspectors[kind];
  const id = inspector.id.trim();
  if (!config.replayPlanPath) {
    inspector.error = "Replay planning is not available for this inspector.";
    render();
    return;
  }
  if (!id) {
    inspector.error = `${config.idLabel} is required.`;
    render();
    return;
  }

  inspector.loading = "Creating replay plan";
  inspector.error = undefined;
  inspector.cancelResult = undefined;
  inspector.result = undefined;
  inspector.retrievalReplay = undefined;
  inspector.validationReplay = undefined;
  inspector.confirmationTokenInput = "";
  try {
    inspector.plan = await requestAdminData<InspectorReplayPlan>(config.replayPlanPath(id), {
      method: "POST",
    });
  } catch (error) {
    inspector.error = errorMessage(error);
  } finally {
    inspector.loading = undefined;
    render();
  }
}

/** Runs retrieval replay in dry-run mode for the selected review inspector. */
async function runRetrievalReplay(kind: InspectorKind): Promise<void> {
  const config = inspectorConfigs[kind];
  const inspector = state.inspectors[kind];
  const id = inspector.id.trim();
  if (!config.retrievalReplayPath) {
    inspector.error = "Retrieval replay is not available for this inspector.";
    render();
    return;
  }
  if (!id) {
    inspector.error = `${config.idLabel} is required.`;
    render();
    return;
  }

  inspector.loading = "Running retrieval replay";
  inspector.error = undefined;
  inspector.retrievalReplay = undefined;
  try {
    inspector.retrievalReplay = await requestAdminData<RetrievalReplayDryRun>(
      config.retrievalReplayPath(id),
      {
        method: "POST",
      },
    );
  } catch (error) {
    inspector.error = errorMessage(error);
  } finally {
    inspector.loading = undefined;
    render();
  }
}

/** Runs validation replay in dry-run mode for the selected review inspector. */
async function runValidationReplay(kind: InspectorKind): Promise<void> {
  const config = inspectorConfigs[kind];
  const inspector = state.inspectors[kind];
  const id = inspector.id.trim();
  if (!config.validationReplayPath) {
    inspector.error = "Validation replay is not available for this inspector.";
    render();
    return;
  }
  if (!id) {
    inspector.error = `${config.idLabel} is required.`;
    render();
    return;
  }

  inspector.loading = "Running validation replay";
  inspector.error = undefined;
  inspector.validationReplay = undefined;
  try {
    inspector.validationReplay = await requestAdminData<ValidationReplayDryRun>(
      config.validationReplayPath(id),
      {
        method: "POST",
      },
    );
  } catch (error) {
    inspector.error = errorMessage(error);
  } finally {
    inspector.loading = undefined;
    render();
  }
}

/** Executes a confirmed replay plan for the selected inspector. */
async function executeReplay(kind: InspectorKind): Promise<void> {
  const config = inspectorConfigs[kind];
  const inspector = state.inspectors[kind];
  const id = inspector.id.trim();
  const expectedToken = inspector.plan?.confirmationToken;
  const providedToken = inspector.confirmationTokenInput.trim();
  if (!config.replayPath) {
    inspector.error = "Replay execution is not available for this inspector.";
    render();
    return;
  }
  if (!expectedToken) {
    inspector.error = "Create a replay plan before dispatch.";
    render();
    return;
  }
  if (providedToken !== expectedToken) {
    inspector.error = "Confirmation token does not match the current plan.";
    render();
    return;
  }

  inspector.loading = "Dispatching replay";
  inspector.error = undefined;
  try {
    inspector.result = await requestAdminData<AdminReplayExecutionResult>(config.replayPath(id), {
      method: "POST",
      body: JSON.stringify({ confirmationToken: providedToken }),
    });
    inspector.details = await requestAdminData<InspectorDetails>(config.detailsPath(id));
  } catch (error) {
    inspector.error = errorMessage(error);
  } finally {
    inspector.loading = undefined;
    render();
  }
}

/** Cancels one pending, queued, or running background job from the job inspector. */
async function cancelBackgroundJob(kind: InspectorKind): Promise<void> {
  const config = inspectorConfigs[kind];
  const inspector = state.inspectors[kind];
  const id = inspector.id.trim();
  const reason = inspector.cancelReasonInput.trim();
  if (!config.cancelPath) {
    inspector.error = "Cancellation is not available for this inspector.";
    render();
    return;
  }
  if (!id) {
    inspector.error = `${config.idLabel} is required.`;
    render();
    return;
  }
  if (!reason) {
    inspector.error = "Cancellation requires a reason.";
    render();
    return;
  }

  inspector.loading = "Canceling job";
  inspector.error = undefined;
  inspector.cancelResult = undefined;
  try {
    inspector.cancelResult = await requestAdminData<AdminBackgroundJobCancelResult>(
      config.cancelPath(id),
      {
        method: "POST",
        body: JSON.stringify({ reason }),
      },
    );
    inspector.details = await requestAdminData<InspectorDetails>(config.detailsPath(id));
  } catch (error) {
    inspector.error = errorMessage(error);
  } finally {
    inspector.loading = undefined;
    render();
  }
}

/** Exports a redacted debug bundle for the selected review inspector. */
async function exportDebugBundle(kind: InspectorKind): Promise<void> {
  const config = inspectorConfigs[kind];
  const inspector = state.inspectors[kind];
  const id = inspector.id.trim();
  if (!config.debugBundlePath) {
    inspector.error = "Debug bundle export is not available for this inspector.";
    render();
    return;
  }
  if (!id) {
    inspector.error = `${config.idLabel} is required.`;
    render();
    return;
  }

  inspector.loading = "Exporting debug bundle";
  inspector.error = undefined;
  try {
    inspector.debugBundle = await requestAdminData<AdminReviewRunDebugBundle>(
      config.debugBundlePath(id),
      {
        method: "POST",
      },
    );
  } catch (error) {
    inspector.error = errorMessage(error);
  } finally {
    inspector.loading = undefined;
    render();
  }
}

/** Creates a review-run eval import draft for the selected review inspector. */
async function importToEval(kind: InspectorKind): Promise<void> {
  const config = inspectorConfigs[kind];
  const inspector = state.inspectors[kind];
  const id = inspector.id.trim();
  if (!config.evalImportPath) {
    inspector.error = "Eval import is not available for this inspector.";
    render();
    return;
  }
  if (!id) {
    inspector.error = `${config.idLabel} is required.`;
    render();
    return;
  }

  inspector.loading = "Creating eval import draft";
  inspector.error = undefined;
  try {
    inspector.evalImportDraft = await requestAdminData<AdminReviewRunEvalImportDraft>(
      config.evalImportPath(id),
      {
        method: "POST",
        body: JSON.stringify({
          caseName: `Imported review ${id}`,
          labels: ["admin-import"],
          reason: "Imported from the admin review inspector.",
          redactionLevel: "redacted",
          suiteId: "smoke-full-pipeline-v1",
        }),
      },
    );
  } catch (error) {
    inspector.error = errorMessage(error);
  } finally {
    inspector.loading = undefined;
    render();
  }
}

/** Moderates one pending memory candidate from the memory and rules inspector. */
async function moderateMemoryCandidate(
  memoryCandidateId: string,
  decision: MemoryCandidateModerationDecision,
): Promise<void> {
  const inspector = state.inspectors.memory;
  const details = inspector.details;
  if (!details || !isMemoryRulesDetails(details)) {
    inspector.error = "Load memory and rules details before moderating a candidate.";
    render();
    return;
  }

  const candidate = details.memoryCandidates.find(
    (row) => row.memoryCandidateId === memoryCandidateId,
  );
  if (!candidate) {
    inspector.error = `Memory candidate ${memoryCandidateId} is not in the loaded inspector data.`;
    render();
    return;
  }

  const reason = window.prompt(decision === "approve" ? "Approval reason" : "Rejection reason", "");
  if (reason === null) {
    return;
  }

  const trimmedReason = reason.trim();
  inspector.loading =
    decision === "approve" ? "Approving memory candidate" : "Rejecting memory candidate";
  inspector.error = undefined;
  render();

  try {
    await requestAdminData<unknown>(
      `/api/v1/memory-candidates/${encodeURIComponent(memoryCandidateId)}/${decision}`,
      {
        body: JSON.stringify({
          metadata: {
            candidateKind: candidate.candidateKind,
            inspectorRepoId: details.repository.repoId,
            source: "memory_rules_inspector",
          },
          ...(trimmedReason ? { reason: trimmedReason } : {}),
        }),
        headers: {
          "idempotency-key": `memory-candidate-${decision}-${memoryCandidateId}-${crypto.randomUUID()}`,
        },
        method: "POST",
      },
    );
    inspector.details = await requestAdminData<InspectorDetails>(
      inspectorConfigs.memory.detailsPath(details.repository.repoId),
    );
  } catch (error) {
    inspector.error = errorMessage(error);
  } finally {
    inspector.loading = undefined;
    render();
  }
}

/** Loads the dashboard overview for repository and review discovery. */
async function loadOverview(): Promise<void> {
  state.overview.loading = "Loading dashboard overview";
  state.overview.error = undefined;
  try {
    const data = await requestAdminData<AdminDashboardOverview>("/admin/overview?limit=12");
    state.overview.repositories = data.repositories;
    state.overview.reviews = data.recentReviews;
    state.overview.auditLogs = data.recentAuditLogs;
    state.overview.runtimeHealth = data.runtimeHealth;
    state.overview.reviewMetrics = data.reviewMetrics;
    state.overview.loaded = true;
    state.overview.repositoriesLoaded = true;
    state.overview.reviewsLoaded = true;
  } catch (error) {
    state.overview.error = errorMessage(error);
  } finally {
    state.overview.loading = undefined;
    render();
  }
}

/** Searches repositories available to the current admin actor. */
async function loadRepositories(): Promise<void> {
  state.overview.loading = "Searching repositories";
  state.overview.error = undefined;
  try {
    const params = new URLSearchParams();
    appendQueryParam(params, "search", state.overview.repositorySearch);
    params.set("limit", "50");
    const data = await requestAdminData<{
      readonly repositories: readonly AdminRepositorySummary[];
    }>(`/admin/repos?${params.toString()}`);
    state.overview.repositories = data.repositories;
    state.overview.repositoriesLoaded = true;
    replaceDashboardRouteFromState();
  } catch (error) {
    state.overview.error = errorMessage(error);
  } finally {
    state.overview.loading = undefined;
    render();
  }
}

/** Searches review history available to the current admin actor. */
async function loadReviewHistory(): Promise<void> {
  state.overview.loading = "Loading review history";
  state.overview.error = undefined;
  try {
    const params = new URLSearchParams();
    appendQueryParam(params, "repoId", state.overview.reviewRepoId);
    appendQueryParam(params, "status", state.overview.reviewStatus);
    appendQueryParam(params, "search", state.overview.reviewSearch);
    params.set("limit", "50");
    const data = await requestAdminData<{ readonly reviews: readonly AdminReviewRunSummary[] }>(
      `/admin/reviews?${params.toString()}`,
    );
    state.overview.reviews = data.reviews;
    state.overview.reviewsLoaded = true;
    replaceDashboardRouteFromState();
  } catch (error) {
    state.overview.error = errorMessage(error);
  } finally {
    state.overview.loading = undefined;
    render();
  }
}

/** Loads persisted evaluation suites for the operator dashboard. */
async function loadEvaluationSuites(): Promise<void> {
  state.evaluation.loading = "Loading evaluation suites";
  state.evaluation.error = undefined;
  try {
    const data = await requestAdminData<{
      readonly suites: readonly EvaluationSuiteSummary[];
    }>("/admin/evaluation/suites?limit=25");
    state.evaluation.suites = data.suites;
    const selectedSuiteId =
      data.suites.find((suite) => suite.evalSuiteId === state.evaluation.selectedSuiteId)
        ?.evalSuiteId ??
      data.suites[0]?.evalSuiteId ??
      "";
    state.evaluation.selectedSuiteId = selectedSuiteId;
    state.evaluation.selectedRun = undefined;
    state.evaluation.runs = [];
    if (selectedSuiteId) {
      await loadEvaluationRuns(selectedSuiteId);
    }
  } catch (error) {
    state.evaluation.error = errorMessage(error);
  } finally {
    state.evaluation.loading = undefined;
    render();
  }
}

/** Loads recent evaluation runs for one persisted suite. */
async function loadEvaluationRuns(evalSuiteId: string): Promise<void> {
  state.evaluation.loading = "Loading evaluation runs";
  state.evaluation.error = undefined;
  state.evaluation.selectedSuiteId = evalSuiteId;
  state.evaluation.selectedRun = undefined;
  replaceDashboardRouteFromState();
  try {
    const data = await requestAdminData<{
      readonly runs: readonly EvaluationRunSummary[];
    }>(`/admin/evaluation/suites/${encodeURIComponent(evalSuiteId)}/runs?limit=25`);
    state.evaluation.runs = data.runs;
  } catch (error) {
    state.evaluation.error = errorMessage(error);
  } finally {
    state.evaluation.loading = undefined;
    render();
  }
}

/** Loads case-level details for one persisted evaluation run. */
async function loadEvaluationRun(evalRunId: string): Promise<void> {
  state.evaluation.loading = "Loading evaluation run";
  state.evaluation.error = undefined;
  try {
    state.evaluation.selectedRun = await requestAdminData<EvaluationRunDetails>(
      `/admin/evaluation/runs/${encodeURIComponent(evalRunId)}`,
    );
    replaceDashboardRouteFromState();
  } catch (error) {
    state.evaluation.error = errorMessage(error);
  } finally {
    state.evaluation.loading = undefined;
    render();
  }
}

/** Opens repository settings for a discovered repository. */
async function openRepositorySettings(repoId: string): Promise<void> {
  state.activeView = "settings";
  state.settings.repoId = repoId;
  replaceDashboardRouteFromState("push");
  await loadSettings();
}

/** Opens one inspector with a discovered resource ID. */
async function openInspector(kind: InspectorKind, resourceId: string): Promise<void> {
  state.activeView = "inspectors";
  state.activeKind = kind;
  state.inspectors[kind].id = resourceId;
  replaceDashboardRouteFromState("push");
  await loadDetails(kind);
}

/** Opens audit history with prefilled filters. */
async function openAuditSearch(input: {
  /** Resource type filter. */
  readonly resourceType?: string | undefined;
  /** Resource ID filter. */
  readonly resourceId?: string | undefined;
  /** Search text. */
  readonly search?: string | undefined;
}): Promise<void> {
  state.activeView = "audit";
  state.audit.resourceType = input.resourceType ?? "";
  state.audit.resourceId = input.resourceId ?? "";
  state.audit.search = input.search ?? "";
  replaceDashboardRouteFromState("push");
  await loadAuditHistory();
}

/** Loads repository settings into the settings form. */
async function loadSettings(): Promise<void> {
  const repoId = state.settings.repoId.trim();
  if (!repoId) {
    state.settings.error = "Repository ID is required.";
    render();
    return;
  }

  state.settings.loading = "Loading repository settings";
  state.settings.error = undefined;
  state.settings.saved = undefined;
  state.settings.preview = undefined;
  try {
    const [data, rulesData] = await Promise.all([
      requestAdminData<ControlPlaneSettingsResponse>(
        `/admin/repos/${encodeURIComponent(repoId)}/settings`,
      ),
      requestAdminData<{ readonly rules: readonly AdminRepoRuleSummary[] }>(
        `/admin/repos/${encodeURIComponent(repoId)}/rules`,
      ),
    ]);
    state.settings.data = data;
    state.settings.form = settingsFormFromResponse(data);
    state.settings.rules = rulesData.rules;
    state.settings.ruleForm = defaultRuleForm();
    state.settings.preview = await requestPolicyPreview(repoId, state.settings.form);
  } catch (error) {
    state.settings.error = errorMessage(error);
  } finally {
    state.settings.loading = undefined;
    render();
  }
}

/** Saves the current repository settings form. */
async function saveSettings(): Promise<void> {
  const repoId = state.settings.repoId.trim();
  const form = state.settings.form;
  if (!repoId || !form) {
    state.settings.error = "Load repository settings before saving.";
    render();
    return;
  }

  state.settings.loading = "Saving repository settings";
  state.settings.error = undefined;
  state.settings.saved = undefined;
  try {
    const data = await requestAdminData<ControlPlaneSettingsResponse>(
      `/admin/repos/${encodeURIComponent(repoId)}/settings`,
      {
        method: "PATCH",
        body: JSON.stringify(settingsPatchFromForm(form)),
      },
    );
    state.settings.data = data;
    state.settings.form = settingsFormFromResponse(data);
    state.settings.preview = await requestPolicyPreview(repoId, state.settings.form);
    state.settings.saved = "Settings saved and policy preview refreshed.";
  } catch (error) {
    state.settings.error = errorMessage(error);
  } finally {
    state.settings.loading = undefined;
    render();
  }
}

/** Refreshes the effective policy preview for the current unsaved settings form. */
async function previewPolicy(): Promise<void> {
  const repoId = state.settings.repoId.trim();
  const form = state.settings.form;
  if (!repoId || !form) {
    state.settings.error = "Load repository settings before previewing policy.";
    render();
    return;
  }

  state.settings.loading = "Compiling policy preview";
  state.settings.error = undefined;
  state.settings.saved = undefined;
  try {
    state.settings.preview = await requestPolicyPreview(repoId, form);
  } catch (error) {
    state.settings.error = errorMessage(error);
  } finally {
    state.settings.loading = undefined;
    render();
  }
}

/** Requests a policy preview for one repository settings form. */
async function requestPolicyPreview(
  repoId: string,
  form: SettingsFormState,
): Promise<ControlPlanePolicyPreview> {
  return requestAdminData<ControlPlanePolicyPreview>(
    `/admin/repos/${encodeURIComponent(repoId)}/policy-preview`,
    {
      method: "POST",
      body: JSON.stringify(settingsPatchFromForm(form)),
    },
  );
}

/** Saves the repository rule form as a new or updated rule. */
async function saveRepositoryRule(): Promise<void> {
  const repoId = state.settings.repoId.trim();
  const ruleForm = state.settings.ruleForm;
  if (!repoId || !state.settings.form) {
    state.settings.error = "Load repository settings before saving a rule.";
    render();
    return;
  }

  state.settings.loading = ruleForm.editingRuleId ? "Updating repository rule" : "Creating rule";
  state.settings.error = undefined;
  state.settings.saved = undefined;
  try {
    const editingRuleId = ruleForm.editingRuleId.trim();
    await requestAdminData<AdminRepoRuleSummary>(
      editingRuleId
        ? `/admin/repos/${encodeURIComponent(repoId)}/rules/${encodeURIComponent(editingRuleId)}`
        : `/admin/repos/${encodeURIComponent(repoId)}/rules`,
      {
        method: editingRuleId ? "PATCH" : "POST",
        body: JSON.stringify(ruleRequestFromForm(ruleForm)),
      },
    );
    await refreshRepositoryRulesAndPreview(repoId);
    state.settings.ruleForm = defaultRuleForm();
    state.settings.saved = editingRuleId ? "Rule updated." : "Rule created.";
  } catch (error) {
    state.settings.error = errorMessage(error);
  } finally {
    state.settings.loading = undefined;
    render();
  }
}

/** Deletes one repository-scoped rule after operator confirmation. */
async function deleteRepositoryRule(ruleId: string): Promise<void> {
  const repoId = state.settings.repoId.trim();
  if (!repoId || !state.settings.form) {
    state.settings.error = "Load repository settings before deleting a rule.";
    render();
    return;
  }
  if (!window.confirm(`Delete repository rule ${ruleId}?`)) {
    return;
  }

  state.settings.loading = "Deleting repository rule";
  state.settings.error = undefined;
  state.settings.saved = undefined;
  try {
    await requestAdminData<AdminRepoRuleSummary>(
      `/admin/repos/${encodeURIComponent(repoId)}/rules/${encodeURIComponent(ruleId)}`,
      { method: "DELETE" },
    );
    await refreshRepositoryRulesAndPreview(repoId);
    if (state.settings.ruleForm.editingRuleId === ruleId) {
      state.settings.ruleForm = defaultRuleForm();
    }
    state.settings.saved = "Rule deleted.";
  } catch (error) {
    state.settings.error = errorMessage(error);
  } finally {
    state.settings.loading = undefined;
    render();
  }
}

/** Loads an existing rule into the repository rule form. */
function editRepositoryRule(ruleId: string): void {
  const rule = state.settings.rules.find((candidate) => candidate.ruleId === ruleId);
  if (!rule) {
    state.settings.error = `Rule ${ruleId} was not found in the loaded settings.`;
    render();
    return;
  }

  state.settings.ruleForm = ruleFormFromSummary(rule);
  state.settings.error = undefined;
  state.settings.saved = undefined;
  render();
}

/** Refreshes rule rows and policy preview after a rule mutation. */
async function refreshRepositoryRulesAndPreview(repoId: string): Promise<void> {
  state.settings.rules = await requestRepositoryRules(repoId);
  if (state.settings.form) {
    state.settings.preview = await requestPolicyPreview(repoId, state.settings.form);
  }
}

/** Requests repository and organization rules for one repository. */
async function requestRepositoryRules(repoId: string): Promise<readonly AdminRepoRuleSummary[]> {
  const data = await requestAdminData<{ readonly rules: readonly AdminRepoRuleSummary[] }>(
    `/admin/repos/${encodeURIComponent(repoId)}/rules`,
  );
  return data.rules;
}

/** Loads audit history using the current filters. */
async function loadAuditHistory(): Promise<void> {
  state.audit.loading = "Loading audit history";
  state.audit.error = undefined;
  try {
    const params = new URLSearchParams();
    appendQueryParam(params, "orgId", state.audit.orgId);
    appendQueryParam(params, "action", state.audit.action);
    appendQueryParam(params, "resourceType", state.audit.resourceType);
    appendQueryParam(params, "resourceId", state.audit.resourceId);
    appendQueryParam(params, "actorUserId", state.audit.actorUserId);
    appendQueryParam(params, "search", state.audit.search);
    params.set("limit", "50");
    const result = await requestAdminData<{ readonly auditLogs: readonly AdminAuditLogSummary[] }>(
      `/admin/audit-logs?${params.toString()}`,
    );
    state.audit.rows = result.auditLogs;
  } catch (error) {
    state.audit.error = errorMessage(error);
  } finally {
    state.audit.loading = undefined;
    render();
  }
}

/** Loads security event history using the current filters. */
async function loadSecurityEvents(): Promise<void> {
  state.security.loading = "Loading security events";
  state.security.error = undefined;
  try {
    const params = new URLSearchParams();
    appendQueryParam(params, "orgId", state.security.orgId);
    appendQueryParam(params, "repoId", state.security.repoId);
    appendQueryParam(params, "type", state.security.type);
    appendQueryParam(params, "severity", state.security.severity);
    appendQueryParam(params, "source", state.security.source);
    appendQueryParam(params, "status", state.security.status);
    appendQueryParam(params, "actorId", state.security.actorId);
    appendQueryParam(params, "resourceType", state.security.resourceType);
    appendQueryParam(params, "resourceId", state.security.resourceId);
    appendQueryParam(params, "search", state.security.search);
    params.set("limit", "50");
    const result = await requestAdminData<{
      readonly securityEvents: readonly AdminSecurityEventSummary[];
    }>(`/admin/security-events?${params.toString()}`);
    state.security.rows = result.securityEvents;
  } catch (error) {
    state.security.error = errorMessage(error);
  } finally {
    state.security.loading = undefined;
    render();
  }
}

/** Loads internal usage rollups using the current filters. */
async function loadUsageSummary(): Promise<void> {
  state.usage.loading = "Loading usage rollups";
  state.usage.error = undefined;
  try {
    const params = new URLSearchParams();
    appendQueryParam(params, "orgId", state.usage.orgId);
    appendQueryParam(params, "repoId", state.usage.repoId);
    appendQueryParam(params, "periodStart", state.usage.periodStart);
    appendQueryParam(params, "periodEnd", state.usage.periodEnd);
    params.set("limit", "50");
    state.usage.data = await requestAdminData<AdminUsageSummary>(
      `/admin/usage?${params.toString()}`,
    );
  } catch (error) {
    state.usage.error = errorMessage(error);
  } finally {
    state.usage.loading = undefined;
    render();
  }
}

/** Loads the current plan snapshot and entitlement decisions. */
async function loadEntitlementSummary(): Promise<void> {
  state.entitlements.loading = "Loading plan snapshot";
  state.entitlements.error = undefined;
  try {
    const params = new URLSearchParams();
    appendQueryParam(params, "orgId", state.entitlements.orgId);
    for (const featureKey of linesFromText(state.entitlements.featureKeys)) {
      params.append("featureKey", featureKey);
    }
    state.entitlements.data = await requestAdminData<AdminEntitlementSummary>(
      `/admin/entitlements?${params.toString()}`,
    );
  } catch (error) {
    state.entitlements.error = errorMessage(error);
  } finally {
    state.entitlements.loading = undefined;
    render();
  }
}

/** Loads local billing account, subscription, credit, invoice, and plan state. */
async function loadBillingSummary(): Promise<void> {
  state.billing.loading = "Loading billing account";
  state.billing.error = undefined;
  state.billing.portalError = undefined;
  state.billing.portalUrl = undefined;
  try {
    const billingParams = new URLSearchParams();
    appendQueryParam(billingParams, "orgId", state.billing.orgId);
    const usageParams = new URLSearchParams();
    appendQueryParam(usageParams, "orgId", state.billing.orgId);
    appendQueryParam(usageParams, "periodStart", currentMonthStartIso());
    appendQueryParam(usageParams, "periodEnd", currentMonthEndIso());
    usageParams.set("limit", "50");
    const meterParams = new URLSearchParams();
    appendQueryParam(meterParams, "orgId", state.billing.orgId);
    appendQueryParam(meterParams, "periodKey", state.billing.meterPeriodKey);
    if (state.billing.meterStatus !== "all") {
      appendQueryParam(meterParams, "status", state.billing.meterStatus);
    }
    meterParams.set("limit", "25");
    const reconciliationParams = new URLSearchParams();
    appendQueryParam(reconciliationParams, "orgId", state.billing.orgId);
    appendQueryParam(reconciliationParams, "periodKey", state.billing.meterPeriodKey);
    appendQueryParam(reconciliationParams, "periodStart", currentMonthStartIso());
    appendQueryParam(reconciliationParams, "periodEnd", currentMonthEndIso());
    reconciliationParams.set("costAnomalyMicros", "5000000");
    reconciliationParams.set("limit", "25");
    reconciliationParams.set("meterLagMinutes", "120");
    const [summary, monthlyUsage, meterEvents, reconciliation] = await Promise.all([
      requestAdminData<AdminBillingSummary>(`/admin/billing?${billingParams.toString()}`),
      requestAdminData<AdminUsageSummary>(`/admin/usage?${usageParams.toString()}`),
      requestAdminData<AdminBillingMeterEventsSummary>(
        `/admin/billing/meter-events?${meterParams.toString()}`,
      ),
      requestAdminData<AdminBillingReconciliationSummary>(
        `/admin/billing/reconciliation?${reconciliationParams.toString()}`,
      ),
    ]);

    state.billing.data = summary;
    state.billing.monthlyUsage = monthlyUsage;
    state.billing.meterEvents = meterEvents;
    state.billing.reconciliation = reconciliation;
  } catch (error) {
    state.billing.error = errorMessage(error);
  } finally {
    state.billing.loading = undefined;
    render();
  }
}

/** Creates a customer portal session for the loaded billing account. */
async function createBillingPortalSession(): Promise<void> {
  state.billing.portalLoading = "Creating portal link";
  state.billing.portalError = undefined;
  try {
    const session = await requestAdminData<AdminPortalSessionRef>("/admin/billing/portal-session", {
      body: JSON.stringify({
        ...(state.billing.orgId.trim().length > 0 ? { orgId: state.billing.orgId.trim() } : {}),
        returnUrl: window.location.href,
      }),
      method: "POST",
    });
    state.billing.portalUrl = session.url;
  } catch (error) {
    state.billing.portalError = errorMessage(error);
  } finally {
    state.billing.portalLoading = undefined;
    render();
  }
}

/** Enqueues a durable billing reconciliation repair job for the current billing scope. */
async function runBillingReconciliation(): Promise<void> {
  state.billing.reconciliationRunLoading = "Queueing reconciliation";
  state.billing.reconciliationRunError = undefined;
  state.billing.reconciliationRun = undefined;
  try {
    const params = new URLSearchParams();
    appendQueryParam(params, "orgId", state.billing.orgId);
    appendQueryParam(params, "periodKey", state.billing.meterPeriodKey);
    appendQueryParam(params, "periodStart", currentMonthStartIso());
    appendQueryParam(params, "periodEnd", currentMonthEndIso());
    params.set("limit", "100");
    state.billing.reconciliationRun = await requestAdminData<AdminBillingReconciliationRunSummary>(
      `/admin/billing/reconciliation/run?${params.toString()}`,
      { method: "POST" },
    );
  } catch (error) {
    state.billing.reconciliationRunError = errorMessage(error);
  } finally {
    state.billing.reconciliationRunLoading = undefined;
    render();
  }
}

/** Requests a typed data payload from the admin API. */
async function requestAdminData<T>(path: string, init: RequestInit = {}): Promise<T> {
  return requestDashboardData<T>({
    csrfToken: state.session?.csrfToken,
    errorMessage: apiErrorMessage,
    includeCsrf: true,
    init,
    onUnauthorized: clearAdminSession,
    url: adminUrl(path),
  });
}

/** Requests a typed data payload from the product API. */
async function requestProductData<T>(path: string, init: RequestInit = {}): Promise<T> {
  return requestDashboardData<T>({
    errorMessage: apiErrorMessage,
    init,
    onUnauthorized: clearProductSession,
    url: adminUrl(path),
  });
}

/** Requests a blob payload from the product API. */
async function requestProductBlob(path: string): Promise<Blob> {
  return requestDashboardBlob({
    errorMessage: apiErrorMessage,
    onUnauthorized: clearProductSession,
    url: adminUrl(path),
  });
}

/** Requests a signed identity assertion from the configured admin gateway. */
async function requestGatewayAssertion(): Promise<AdminIdentityRequestHeaders> {
  const body = await requestGatewayJson<unknown>({
    body: { purpose: "dashboard-login" },
    errorMessage: apiErrorMessage,
    url: gatewayAssertionUrl(),
  });

  return identityAssertionFromGatewayBody(body);
}

/** Clears the cached admin session after an authenticated admin request is rejected. */
function clearAdminSession(): void {
  state.session = undefined;
}

/** Clears cached product session-scoped data after a product request is rejected. */
function clearProductSession(): void {
  state.product.session = undefined;
  state.product.resources = undefined;
  state.product.orgSettings = undefined;
  state.product.repositorySettings = undefined;
  state.product.reviewDetail = undefined;
}

/** Returns a complete admin API URL for a route path. */
function adminUrl(path: string): string {
  const baseUrl = state.apiBaseUrl.trim().replace(/\/$/u, "");
  return `${baseUrl}${path}`;
}

/** Returns the GitHub OAuth start URL for the configured admin gateway. */
function githubLoginStartUrl(): string {
  const url = new URL("/auth/github/start", gatewayBaseOriginUrl());
  url.searchParams.set("returnTo", window.location.href);
  return url.toString();
}

/** Returns the product GitHub OAuth start URL for the configured API. */
function productGitHubLoginStartUrl(): string {
  const url = new URL(adminUrl("/api/v1/auth/github/start"), window.location.origin);
  url.searchParams.set("redirectTo", productReturnPath());
  return url.toString();
}

/** Returns the current dashboard path used after product login. */
function productReturnPath(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}` || "/";
}

/** Builds initial inspector state from route query parameters. */
function initialInspectorState(
  kind: InspectorKind,
  route: DashboardRouteState,
): InspectorViewState {
  return {
    cancelReasonInput: "",
    confirmationTokenInput: "",
    id: route.inspectorKind === kind ? (route.inspectorResourceId ?? "") : "",
  };
}

/** Reads shareable dashboard selections from the current browser URL. */
function readDashboardRouteState(): DashboardRouteState {
  const params = new URL(window.location.href).searchParams;
  const mode = queryConsoleMode(params.get("mode"));
  const view = queryViewKind(params.get("view"));
  const inspectorKind = queryInspectorKind(params.get("inspector"));
  const orgId = boundedQueryParam(params, "orgId");
  const repoId = boundedQueryParam(params, "repoId");
  const resourceId = boundedQueryParam(params, "resourceId");

  return {
    auditAction: view === "audit" ? boundedQueryParam(params, "action") : undefined,
    auditActorUserId: view === "audit" ? boundedQueryParam(params, "actorUserId") : undefined,
    auditOrgId: view === "audit" ? orgId : undefined,
    auditResourceId: view === "audit" ? resourceId : undefined,
    auditResourceType: view === "audit" ? boundedQueryParam(params, "resourceType") : undefined,
    auditSearch: view === "audit" ? boundedQueryParam(params, "search") : undefined,
    billingMeterPeriodKey:
      view === "billing" ? boundedQueryParam(params, "meterPeriodKey") : undefined,
    billingMeterStatus: view === "billing" ? boundedQueryParam(params, "meterStatus") : undefined,
    billingOrgId: view === "billing" ? orgId : undefined,
    entitlementOrgId: view === "plan" ? orgId : undefined,
    evaluationRunId: boundedQueryParam(params, "evalRunId"),
    evaluationSuiteId: boundedQueryParam(params, "suiteId"),
    inspectorKind,
    inspectorResourceId: view === "inspectors" ? resourceId : undefined,
    mode,
    productFindingId: boundedQueryParam(params, "findingId"),
    productOrgId: mode === "product" ? orgId : undefined,
    productRepoId: boundedQueryParam(params, "productRepoId"),
    productReviewRunId: boundedQueryParam(params, "reviewRunId"),
    repositorySearch: boundedQueryParam(params, "repositorySearch"),
    reviewRepoId: boundedQueryParam(params, "reviewRepoId"),
    reviewSearch: boundedQueryParam(params, "reviewSearch"),
    reviewStatus: boundedQueryParam(params, "reviewStatus"),
    securityActorId: view === "security" ? boundedQueryParam(params, "actorId") : undefined,
    securityOrgId: view === "security" ? orgId : undefined,
    securityRepoId: view === "security" ? repoId : undefined,
    securityResourceId: view === "security" ? resourceId : undefined,
    securityResourceType:
      view === "security" ? boundedQueryParam(params, "resourceType") : undefined,
    securitySearch: view === "security" ? boundedQueryParam(params, "search") : undefined,
    securitySeverity: view === "security" ? boundedQueryParam(params, "severity") : undefined,
    securitySource: view === "security" ? boundedQueryParam(params, "source") : undefined,
    securityStatus: view === "security" ? boundedQueryParam(params, "status") : undefined,
    securityType: view === "security" ? boundedQueryParam(params, "type") : undefined,
    settingsRepoId: boundedQueryParam(params, "settingsRepoId"),
    usageOrgId: view === "usage" ? orgId : undefined,
    usagePeriodEnd: view === "usage" ? boundedQueryParam(params, "periodEnd") : undefined,
    usagePeriodStart: view === "usage" ? boundedQueryParam(params, "periodStart") : undefined,
    usageRepoId: view === "usage" ? repoId : undefined,
    view,
  };
}

/** Replaces or pushes owned dashboard URL query parameters from the current in-memory state. */
function replaceDashboardRouteFromState(historyMode: "replace" | "push" = "replace"): void {
  const route = dashboardRouteStateFromState();
  state.route = route;
  const url = new URL(window.location.href);
  for (const key of DASHBOARD_ROUTE_PARAM_KEYS) {
    url.searchParams.delete(key);
  }

  setDashboardRouteParam(url.searchParams, "mode", route.mode);
  setDashboardRouteParam(url.searchParams, "view", route.view);
  setDashboardRouteParam(url.searchParams, "inspector", route.inspectorKind);
  setDashboardRouteParam(
    url.searchParams,
    "orgId",
    route.productOrgId ??
      route.auditOrgId ??
      route.securityOrgId ??
      route.usageOrgId ??
      route.entitlementOrgId ??
      route.billingOrgId,
  );
  setDashboardRouteParam(url.searchParams, "productRepoId", route.productRepoId);
  setDashboardRouteParam(url.searchParams, "reviewRunId", route.productReviewRunId);
  setDashboardRouteParam(url.searchParams, "findingId", route.productFindingId);
  setDashboardRouteParam(url.searchParams, "settingsRepoId", route.settingsRepoId);
  setDashboardRouteParam(url.searchParams, "repositorySearch", route.repositorySearch);
  setDashboardRouteParam(url.searchParams, "reviewRepoId", route.reviewRepoId);
  setDashboardRouteParam(url.searchParams, "reviewStatus", route.reviewStatus);
  setDashboardRouteParam(url.searchParams, "reviewSearch", route.reviewSearch);
  setDashboardRouteParam(url.searchParams, "suiteId", route.evaluationSuiteId);
  setDashboardRouteParam(url.searchParams, "evalRunId", route.evaluationRunId);
  setDashboardRouteParam(url.searchParams, "action", route.auditAction);
  setDashboardRouteParam(url.searchParams, "actorUserId", route.auditActorUserId);
  setDashboardRouteParam(url.searchParams, "repoId", route.securityRepoId ?? route.usageRepoId);
  setDashboardRouteParam(
    url.searchParams,
    "resourceType",
    route.securityResourceType ?? route.auditResourceType,
  );
  setDashboardRouteParam(
    url.searchParams,
    "resourceId",
    route.securityResourceId ?? route.auditResourceId ?? route.inspectorResourceId,
  );
  setDashboardRouteParam(url.searchParams, "search", route.securitySearch ?? route.auditSearch);
  setDashboardRouteParam(url.searchParams, "type", route.securityType);
  setDashboardRouteParam(url.searchParams, "severity", route.securitySeverity);
  setDashboardRouteParam(url.searchParams, "source", route.securitySource);
  setDashboardRouteParam(url.searchParams, "status", route.securityStatus);
  setDashboardRouteParam(url.searchParams, "actorId", route.securityActorId);
  setDashboardRouteParam(url.searchParams, "periodStart", route.usagePeriodStart);
  setDashboardRouteParam(url.searchParams, "periodEnd", route.usagePeriodEnd);
  setDashboardRouteParam(url.searchParams, "meterStatus", route.billingMeterStatus);
  setDashboardRouteParam(url.searchParams, "meterPeriodKey", route.billingMeterPeriodKey);
  const nextPath = `${url.pathname}${url.search}${url.hash}`;
  if (historyMode === "push" && nextPath !== productReturnPath()) {
    window.history.pushState({}, "", nextPath);
    return;
  }

  window.history.replaceState({}, "", nextPath);
}

/** Builds route state from current dashboard selections. */
function dashboardRouteStateFromState(): DashboardRouteState {
  if (state.activeMode === "product") {
    return {
      mode: "product",
      productFindingId: optionalRouteValue(state.product.reviewDetail?.selectedFinding?.findingId),
      productOrgId: optionalRouteValue(state.product.resources?.selectedOrgId),
      productRepoId: optionalRouteValue(state.product.repositorySettings?.repoId),
      productReviewRunId: optionalRouteValue(state.product.reviewDetail?.reviewRunId),
    };
  }

  if (state.activeView === "inspectors") {
    return {
      inspectorKind: state.activeKind,
      inspectorResourceId: optionalRouteValue(currentInspectorState().id),
      mode: "admin",
      view: state.activeView,
    };
  }

  if (state.activeView === "settings") {
    return {
      mode: "admin",
      settingsRepoId: optionalRouteValue(state.settings.repoId),
      view: state.activeView,
    };
  }

  if (state.activeView === "evaluation") {
    return {
      evaluationRunId: optionalRouteValue(state.evaluation.selectedRun?.run.evalRunId),
      evaluationSuiteId: optionalRouteValue(state.evaluation.selectedSuiteId),
      mode: "admin",
      view: state.activeView,
    };
  }

  if (state.activeView === "overview") {
    return {
      mode: "admin",
      repositorySearch: optionalRouteValue(state.overview.repositorySearch),
      reviewRepoId: optionalRouteValue(state.overview.reviewRepoId),
      reviewSearch: optionalRouteValue(state.overview.reviewSearch),
      reviewStatus: optionalRouteValue(state.overview.reviewStatus),
      view: state.activeView,
    };
  }

  if (state.activeView === "audit") {
    return {
      auditAction: optionalRouteValue(state.audit.action),
      auditActorUserId: optionalRouteValue(state.audit.actorUserId),
      auditOrgId: optionalRouteValue(state.audit.orgId),
      auditResourceId: optionalRouteValue(state.audit.resourceId),
      auditResourceType: optionalRouteValue(state.audit.resourceType),
      auditSearch: optionalRouteValue(state.audit.search),
      mode: "admin",
      view: state.activeView,
    };
  }

  if (state.activeView === "security") {
    return {
      mode: "admin",
      securityActorId: optionalRouteValue(state.security.actorId),
      securityOrgId: optionalRouteValue(state.security.orgId),
      securityRepoId: optionalRouteValue(state.security.repoId),
      securityResourceId: optionalRouteValue(state.security.resourceId),
      securityResourceType: optionalRouteValue(state.security.resourceType),
      securitySearch: optionalRouteValue(state.security.search),
      securitySeverity: optionalRouteValue(state.security.severity),
      securitySource: optionalRouteValue(state.security.source),
      securityStatus: optionalRouteValue(state.security.status),
      securityType: optionalRouteValue(state.security.type),
      view: state.activeView,
    };
  }

  if (state.activeView === "usage") {
    return {
      mode: "admin",
      usageOrgId: optionalRouteValue(state.usage.orgId),
      usagePeriodEnd: optionalRouteValue(state.usage.periodEnd),
      usagePeriodStart: optionalRouteValue(state.usage.periodStart),
      usageRepoId: optionalRouteValue(state.usage.repoId),
      view: state.activeView,
    };
  }

  if (state.activeView === "plan") {
    return {
      entitlementOrgId: optionalRouteValue(state.entitlements.orgId),
      mode: "admin",
      view: state.activeView,
    };
  }

  if (state.activeView === "billing") {
    return {
      billingMeterPeriodKey: optionalRouteValue(state.billing.meterPeriodKey),
      billingMeterStatus:
        state.billing.meterStatus === "all"
          ? undefined
          : optionalRouteValue(state.billing.meterStatus),
      billingOrgId: optionalRouteValue(state.billing.orgId),
      mode: "admin",
      view: state.activeView,
    };
  }

  return {
    mode: "admin",
    view: state.activeView,
  };
}

/** Loads the admin data implied by URL-restored selections. */
async function loadAdminRouteData(): Promise<void> {
  if (!state.session) {
    return;
  }

  if (state.activeView === "settings" && state.settings.repoId.trim().length > 0) {
    await loadSettings();
    return;
  }

  if (state.activeView === "inspectors" && currentInspectorState().id.trim().length > 0) {
    await loadDetails(state.activeKind);
    return;
  }

  if (state.activeView === "evaluation") {
    const requestedRunId = state.route.evaluationRunId;
    await loadEvaluationSuites();
    if (requestedRunId) {
      await loadEvaluationRun(requestedRunId);
    }
    return;
  }

  if (state.activeView === "audit") {
    await loadAuditHistory();
    return;
  }

  if (state.activeView === "usage") {
    await loadUsageSummary();
    return;
  }

  if (state.activeView === "plan") {
    await loadEntitlementSummary();
    return;
  }

  if (state.activeView === "billing") {
    await loadBillingSummary();
    return;
  }

  if (state.activeView === "security") {
    await loadSecurityEvents();
    return;
  }

  await loadOverview();
  const shouldLoadRepositorySearch = state.overview.repositorySearch.trim().length > 0;
  const shouldLoadReviewSearch =
    state.overview.reviewRepoId.trim().length > 0 ||
    state.overview.reviewSearch.trim().length > 0 ||
    state.overview.reviewStatus.trim().length > 0;
  await Promise.all([
    shouldLoadRepositorySearch ? loadRepositories() : Promise.resolve(),
    shouldLoadReviewSearch ? loadReviewHistory() : Promise.resolve(),
  ]);
}

/** Loads product subpanels requested through URL-restored selections. */
async function loadProductRouteSelections(): Promise<void> {
  const route = state.route;
  if (route.productRepoId) {
    await loadProductRepositorySettings(route.productRepoId);
  }
  if (route.productReviewRunId) {
    await loadProductReviewDetail(route.productReviewRunId);
  }
  if (route.productFindingId) {
    await loadProductFindingDetail(route.productFindingId);
  }
}

/** Applies URL route state after browser back/forward navigation. */
async function applyDashboardRouteFromBrowser(): Promise<void> {
  const route = readDashboardRouteState();
  applyDashboardRouteState(route);
  render();

  if (state.activeMode === "product") {
    if (state.product.session) {
      await loadProductResources(route.productOrgId);
      await loadProductRouteSelections();
    }
    return;
  }

  if (state.session) {
    await loadAdminRouteData();
  }
}

/** Copies parsed dashboard route state into mutable view state. */
function applyDashboardRouteState(route: DashboardRouteState): void {
  state.route = route;
  state.activeMode = route.mode ?? "product";
  state.activeView = route.view ?? "overview";
  state.activeKind = route.inspectorKind ?? "webhook";
  if (route.inspectorKind) {
    state.inspectors[route.inspectorKind].id = route.inspectorResourceId ?? "";
    state.inspectors[route.inspectorKind].error = undefined;
  }

  state.overview.repositorySearch = route.repositorySearch ?? "";
  state.overview.reviewRepoId = route.reviewRepoId ?? "";
  state.overview.reviewStatus = route.reviewStatus ?? "";
  state.overview.reviewSearch = route.reviewSearch ?? "";
  state.settings.repoId = route.settingsRepoId ?? "";
  state.settings.error = undefined;
  state.audit.orgId = route.auditOrgId ?? "";
  state.audit.action = route.auditAction ?? "";
  state.audit.resourceType = route.auditResourceType ?? "";
  state.audit.resourceId = route.auditResourceId ?? "";
  state.audit.actorUserId = route.auditActorUserId ?? "";
  state.audit.search = route.auditSearch ?? "";
  state.security.orgId = route.securityOrgId ?? "";
  state.security.repoId = route.securityRepoId ?? "";
  state.security.type = route.securityType ?? "";
  state.security.severity = route.securitySeverity ?? "";
  state.security.source = route.securitySource ?? "";
  state.security.status = route.securityStatus ?? "";
  state.security.actorId = route.securityActorId ?? "";
  state.security.resourceType = route.securityResourceType ?? "";
  state.security.resourceId = route.securityResourceId ?? "";
  state.security.search = route.securitySearch ?? "";
  state.usage.orgId = route.usageOrgId ?? "";
  state.usage.repoId = route.usageRepoId ?? "";
  state.usage.periodStart = route.usagePeriodStart ?? currentMonthStartIso();
  state.usage.periodEnd = route.usagePeriodEnd ?? "";
  state.entitlements.orgId = route.entitlementOrgId ?? "";
  state.billing.orgId = route.billingOrgId ?? "";
  state.billing.meterPeriodKey = route.billingMeterPeriodKey ?? currentMonthKey();
  state.billing.meterStatus = route.billingMeterStatus ?? "all";
  state.evaluation.selectedSuiteId = route.evaluationSuiteId ?? "";
  state.evaluation.selectedRun = undefined;
}

/** Writes one optional dashboard route query parameter. */
function setDashboardRouteParam(
  params: URLSearchParams,
  key: (typeof DASHBOARD_ROUTE_PARAM_KEYS)[number],
  value: string | undefined,
): void {
  const routeValue = optionalRouteValue(value);
  if (routeValue) {
    params.set(key, routeValue);
  }
}

/** Reads a bounded non-empty query parameter. */
function boundedQueryParam(params: URLSearchParams, key: string): string | undefined {
  const value = optionalRouteValue(params.get(key) ?? undefined);
  return value ? value.slice(0, 300) : undefined;
}

/** Returns a normalized non-empty route value. */
function optionalRouteValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Narrows a query parameter to a console mode. */
function queryConsoleMode(value: string | null): ConsoleMode | undefined {
  return value && isConsoleMode(value) ? value : undefined;
}

/** Narrows a query parameter to an admin view kind. */
function queryViewKind(value: string | null): ViewKind | undefined {
  return value && isViewKind(value) ? value : undefined;
}

/** Narrows a query parameter to an inspector kind. */
function queryInspectorKind(value: string | null): InspectorKind | undefined {
  return value && isInspectorKind(value) ? value : undefined;
}

/** Returns the signed assertion endpoint URL for the configured admin gateway. */
function gatewayAssertionUrl(): string {
  const configured = state.gatewayBaseUrl.trim();
  if (configured.length === 0) {
    return "/heimdall/assertion";
  }

  const url = new URL(configured, window.location.origin);
  if (url.pathname.endsWith("/assertion")) {
    return url.toString();
  }

  return new URL("/heimdall/assertion", url).toString();
}

/** Returns the gateway origin used by the OAuth start endpoint. */
function gatewayBaseOriginUrl(): string {
  const configured = state.gatewayBaseUrl.trim();
  if (configured.length === 0) {
    return window.location.origin;
  }

  return new URL(configured, window.location.origin).origin;
}

/** Persists login endpoint configuration for redirects and browser reloads. */
function persistLoginConfig(): void {
  sessionStorage.setItem(API_BASE_URL_STORAGE_KEY, state.apiBaseUrl);
  sessionStorage.setItem(GATEWAY_BASE_URL_STORAGE_KEY, state.gatewayBaseUrl);
}

/** Converts a gateway assertion tuple into API login headers. */
function identityAssertionHeaders(assertion: AdminIdentityRequestHeaders): Headers {
  const headers = new Headers();
  headers.set(
    ADMIN_IDENTITY_HEADER_NAMES.assertion,
    assertion[ADMIN_IDENTITY_HEADER_NAMES.assertion],
  );
  headers.set(
    ADMIN_IDENTITY_HEADER_NAMES.signature,
    assertion[ADMIN_IDENTITY_HEADER_NAMES.signature],
  );
  headers.set(
    ADMIN_IDENTITY_HEADER_NAMES.timestamp,
    assertion[ADMIN_IDENTITY_HEADER_NAMES.timestamp],
  );
  return headers;
}

/** Parses a gateway assertion response into API login headers. */
function identityAssertionFromGatewayBody(body: unknown): AdminIdentityRequestHeaders {
  const record = asRecord(body);
  const headerRecord = asRecord(record?.headers);
  const encodedAssertion =
    stringField(record, "encodedAssertion") ??
    stringField(record, "assertion") ??
    stringField(headerRecord, ADMIN_IDENTITY_HEADER_NAMES.assertion);
  const signature =
    stringField(record, "signature") ??
    stringField(headerRecord, ADMIN_IDENTITY_HEADER_NAMES.signature);
  const timestamp =
    stringField(record, "timestamp") ??
    stringField(headerRecord, ADMIN_IDENTITY_HEADER_NAMES.timestamp);

  if (!encodedAssertion || !signature || !timestamp) {
    throw new Error("Admin gateway response did not include a complete identity assertion.");
  }

  return {
    [ADMIN_IDENTITY_HEADER_NAMES.assertion]: encodedAssertion,
    [ADMIN_IDENTITY_HEADER_NAMES.signature]: signature,
    [ADMIN_IDENTITY_HEADER_NAMES.timestamp]: timestamp,
  };
}

/** Extracts a useful API error message from an unknown response body. */
function apiErrorMessage(body: unknown, status: number): string {
  const record = asRecord(body);
  const error = asRecord(record?.error) as ApiErrorEnvelope["error"] | undefined;
  if (error?.message) {
    return `${error.code}: ${error.message}`;
  }

  return `Request failed with HTTP ${status}.`;
}

/** Renders the complete dashboard. */
function render(): void {
  app.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">Heimdall</p>
          <h1>${state.activeMode === "product" ? "Product Console" : "Operator Console"}</h1>
        </div>
        ${renderModeSwitch()}
        ${renderSessionBadge()}
      </header>
      ${
        state.activeMode === "product"
          ? renderProductDashboard()
          : `${renderAuthPanel()}${
              state.session
                ? `${renderPrimaryNav()}${renderActiveView()}`
                : renderDisconnectedWorkspace()
            }`
      }
    </div>
  `;
}

/** Renders the top-level console switch. */
function renderModeSwitch(): string {
  return `
    <nav class="mode-switch" aria-label="Console mode">
      <button
        class="${state.activeMode === "product" ? "active" : ""}"
        data-action="show-product"
        type="button"
      >
        Product
      </button>
      <button
        class="${state.activeMode === "admin" ? "active" : ""}"
        data-action="show-admin"
        type="button"
      >
        Admin
      </button>
    </nav>
  `;
}

/** Renders the normal product dashboard and onboarding flow. */
function renderProductDashboard(): string {
  const product = state.product;
  const data = product.data;

  return `
    <main class="product-workspace">
      <section class="product-hero">
        <div>
          <p class="eyebrow">GitHub App Flow</p>
          <h2>Install Heimdall, open a pull request, and watch reviews land.</h2>
          <p>
            This is the normal application path. The admin console is only for internal replay,
            audit, and support operations.
          </p>
        </div>
        <div class="product-actions">
          ${renderProductAuthPanel()}
          <button
            class="primary"
            data-action="install-github-app"
            type="button"
            ${data?.githubApp.installUrl ? "" : "disabled"}
          >
            Install GitHub App
          </button>
          <button data-action="load-product" type="button">Refresh</button>
        </div>
      </section>
      ${product.loading ? `<p class="notice">${escapeHtml(product.loading)}...</p>` : ""}
      ${product.error ? `<p class="error-line">${escapeHtml(product.error)}</p>` : ""}
      ${data ? renderProductReadiness(data) : renderProductLoadingState()}
    </main>
  `;
}

/** Renders product session controls. */
function renderProductAuthPanel(): string {
  const session = state.product.session;
  const disabled = state.product.sessionLoading ? "disabled" : "";
  const loadingMessage = state.product.sessionLoading
    ? `<p class="notice compact">${escapeHtml(state.product.sessionLoading)}...</p>`
    : "";
  if (session) {
    const label = session.user.displayName ?? session.user.primaryEmail ?? session.user.userId;
    const orgLabel =
      session.memberships.length === 0
        ? "No org membership"
        : `${session.memberships.length} org${session.memberships.length === 1 ? "" : "s"}`;
    return `
      <div class="product-session connected">
        <div class="product-session-summary">
          <span class="status ok">signed in</span>
          <strong>${escapeHtml(label)}</strong>
          <small>${escapeHtml(orgLabel)}</small>
        </div>
        <button class="ghost small" data-action="refresh-product-session" type="button" ${disabled}>
          Refresh
        </button>
        <button class="ghost small" data-action="logout-product" type="button" ${disabled}>
          Sign out
        </button>
        ${loadingMessage}
        ${state.product.authError ? `<p class="error-line">${escapeHtml(state.product.authError)}</p>` : ""}
      </div>
    `;
  }

  return `
    <div class="product-session">
      <button class="primary" data-action="login-product-github" type="button" ${disabled}>
        Sign in with GitHub
      </button>
      <button class="ghost small" data-action="refresh-product-session" type="button" ${disabled}>
        Check session
      </button>
      ${loadingMessage}
      ${state.product.authError ? `<p class="error-line">${escapeHtml(state.product.authError)}</p>` : ""}
    </div>
  `;
}

/** Renders product setup and activity state. */
function renderProductReadiness(data: ProductOnboardingSummary): string {
  return `
    <section class="summary-grid product-summary">
      ${renderMetric("GitHub App", data.githubApp.configured ? "ready" : "needs config", !data.githubApp.configured)}
      ${renderMetric("Installations", String(data.installations.length))}
      ${renderMetric("Repositories", String(data.repositories.length))}
      ${renderMetric("Webhooks", String(data.webhook.totalDeliveries))}
    </section>
    ${renderProductNextStepPanel(data)}
    ${state.product.session ? renderProductWorkspace() : ""}
    <section class="product-grid">
      ${renderProductSetupPanel(data)}
      ${renderProductInstallations(data.installations)}
      ${renderProductRepositories(data.repositories)}
      ${renderProductReviews(data.recentReviews)}
    </section>
  `;
}

/** Renders the main product workflow as actionable steps. */
function renderProductNextStepPanel(data: ProductOnboardingSummary): string {
  const firstRepository = data.repositories[0];
  const repoUrl = firstRepository ? githubRepositoryUrl(firstRepository.fullName) : undefined;
  const pullsUrl = firstRepository ? `${repoUrl}/pulls` : undefined;
  const webhookLabel = data.webhook.latestEventName
    ? `${data.webhook.latestEventName}${data.webhook.latestAction ? `:${data.webhook.latestAction}` : ""} ${data.webhook.latestStatus ?? ""}`.trim()
    : "No GitHub webhook has been received yet.";

  return `
    <section class="panel product-panel product-next-step">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Next step</p>
          <h3>Trigger a review from GitHub</h3>
        </div>
        <span class="status ${data.webhook.latestStatus === "processed" ? "ok" : "muted"}">
          ${escapeHtml(webhookLabel)}
        </span>
      </div>
      <div class="next-step-grid">
        <article>
          <strong>1. Open or update a pull request</strong>
          <p class="muted-text">A GitHub pull request event is what starts a new Heimdall review.</p>
          <div class="row-actions">
            ${
              repoUrl
                ? `<a class="button-link ghost small" href="${escapeAttribute(repoUrl)}" target="_blank" rel="noreferrer">Open repo</a>`
                : ""
            }
            ${
              pullsUrl
                ? `<a class="button-link small" href="${escapeAttribute(pullsUrl)}" target="_blank" rel="noreferrer">Open PRs</a>`
                : ""
            }
          </div>
        </article>
        <article>
          <strong>2. Refresh this dashboard</strong>
          <p class="muted-text">Use this after pushing a commit, opening a PR, or redelivering a webhook.</p>
          <button class="ghost small" data-action="load-product" type="button">Refresh status</button>
        </article>
        <article>
          <strong>3. Sign in for controls</strong>
          <p class="muted-text">Signed-in users can inspect repositories, settings, review runs, memory, and reruns.</p>
          ${
            state.product.session
              ? `<button class="ghost small" data-action="load-product-resources" type="button">Load workspace</button>`
              : `<button class="small" data-action="login-product-github" type="button">Sign in with GitHub</button>`
          }
        </article>
      </div>
    </section>
  `;
}

/** Renders authenticated product workspace resources. */
function renderProductWorkspace(): string {
  const resources = state.product.resources;
  if (!resources) {
    return `
      <section class="panel product-panel product-resource-panel">
        <div class="section-heading">
          <div>
            <p class="eyebrow">Workspace</p>
            <h3>Organizations and repositories</h3>
          </div>
          <button class="ghost small" data-action="load-product-resources" type="button">
            Load workspace
          </button>
        </div>
      </section>
    `;
  }

  const selectedOrg = resources.orgs.find((org) => org.orgId === resources.selectedOrgId);
  const membership = state.product.session?.memberships.find(
    (row) => row.orgId === resources.selectedOrgId,
  );
  const canManageRepositories = Boolean(membership?.capabilities.canManageRepositorySettings);
  const canManageOrgSettings = Boolean(
    membership?.capabilities.canManageOrgSettings || membership?.permissions.includes("org:manage"),
  );
  const canManageRules = Boolean(membership?.permissions.includes("rule:write"));
  const canManageMemory = Boolean(membership?.permissions.includes("memory:write"));
  const canReadMemory = Boolean(membership?.permissions.includes("memory:read"));
  const canWriteFindings = Boolean(membership?.permissions.includes("finding:write"));
  const canSuppressFindings = Boolean(membership?.permissions.includes("rule:write"));
  const canRerunReviews = Boolean(membership?.capabilities.canRerunReviews);
  const canReadReviewDebug = Boolean(membership?.permissions.includes("review:debug:read"));

  return `
    <section class="panel product-panel product-resource-panel">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Workspace</p>
          <h3>${escapeHtml(selectedOrg?.name ?? "Organizations")}</h3>
        </div>
        <button class="ghost small" data-action="load-product-resources" type="button">
          Refresh
        </button>
      </div>
      ${resources.loading ? `<p class="notice compact">${escapeHtml(resources.loading)}...</p>` : ""}
      ${resources.error ? `<p class="error-line">${escapeHtml(resources.error)}</p>` : ""}
      ${renderProductOrgSwitcher(resources)}
      ${
        resources.selectedOrgId
          ? `
            ${renderProductUsageCards(resources.usage)}
            ${renderProductOrgSettingsPanel(canManageOrgSettings)}
            <div class="product-resource-grid">
              ${renderAuthenticatedProductRepositories(resources.repositories, canManageRepositories)}
            ${renderAuthenticatedProductReviews(resources.reviews)}
            </div>
            ${renderProductRepositorySettingsPanel(
              canManageRepositories,
              canManageRules,
              canReadMemory,
              canManageMemory,
            )}
            ${renderProductReviewDetailPanel(
              canWriteFindings,
              canSuppressFindings,
              canRerunReviews,
              canReadReviewDebug,
            )}
          `
          : `<p class="inline-empty">No organizations are connected to this product user yet.</p>`
      }
    </section>
  `;
}

/** Renders product organization selection controls. */
function renderProductOrgSwitcher(resources: ProductResourcesState): string {
  if (resources.orgs.length === 0) {
    return "";
  }

  return `
    <div class="org-switcher">
      ${resources.orgs
        .map((org) => {
          const selected = org.orgId === resources.selectedOrgId;
          return `
            <button
              class="${selected ? "primary" : "ghost"} small"
              data-action="select-product-org"
              data-org-id="${escapeAttribute(org.orgId)}"
              type="button"
            >
              ${escapeHtml(org.name)}
            </button>
          `;
        })
        .join("")}
    </div>
  `;
}

/** Renders basic product usage cards. */
function renderProductUsageCards(usage: ProductUsageSummary | undefined): string {
  if (!usage) {
    return "";
  }

  return `
    <section class="summary-grid product-summary compact-summary">
      ${renderMetric("Reviews", String(usage.reviewRuns))}
      ${renderMetric("Indexed commits", String(usage.indexedCommits))}
      ${renderMetric("LLM tokens", formatCompactNumber(usage.reviewInputTokens + usage.reviewOutputTokens))}
      ${renderMetric("Estimated cost", `$${usage.estimatedCostUsd}`)}
    </section>
  `;
}

/** Renders organization-level policy default controls for the product workspace. */
function renderProductOrgSettingsPanel(canManageSettings: boolean): string {
  const settings = state.product.orgSettings;
  if (!settings) {
    return "";
  }

  const form = settings.form;
  const disabled = !canManageSettings || !form;

  return `
    <section class="settings-inline-panel product-org-settings-panel">
      <div class="section-heading compact-heading">
        <div>
          <p class="eyebrow">Organization Settings</p>
          <h3>Policy defaults</h3>
        </div>
        <div class="row-actions">
          <button
            class="ghost small"
            data-action="refresh-product-org-settings"
            data-org-id="${escapeAttribute(settings.orgId)}"
            type="button"
          >
            Refresh
          </button>
          <button
            data-action="save-product-org-settings"
            type="button"
            ${disabled ? "disabled" : ""}
          >
            Save
          </button>
        </div>
      </div>
      ${renderProductOrgSettingsNotice(settings)}
      ${
        form && settings.data
          ? renderProductOrgSettingsForm(settings.data, form, disabled)
          : `<p class="inline-empty">Organization policy defaults are not loaded.</p>`
      }
    </section>
  `;
}

/** Renders product organization settings loading, error, or saved state. */
function renderProductOrgSettingsNotice(settings: ProductOrgSettingsState): string {
  if (settings.loading) {
    return `<p class="notice compact">${escapeHtml(settings.loading)}...</p>`;
  }
  if (settings.error) {
    return `<p class="error-line">${escapeHtml(settings.error)}</p>`;
  }
  if (settings.saved) {
    return `<p class="notice success compact">${escapeHtml(settings.saved)}</p>`;
  }

  return "";
}

/** Renders editable organization policy defaults. */
function renderProductOrgSettingsForm(
  settings: ProductOrgSettings,
  form: ProductOrgSettingsFormState,
  disabled: boolean,
): string {
  return `
    <div class="summary-grid compact-summary">
      ${renderMetric("Version", String(settings.version))}
      ${renderMetric("Updated", formatTime(settings.updatedAt))}
      ${renderMetric("Rules", form.allowUserDefinedRules ? "enabled" : "locked")}
      ${renderMetric("Memory", form.allowMemorySuppression ? "suppression on" : "context only")}
    </div>
    <div class="org-settings-grid">
      <section class="settings-subsection">
        <div class="section-heading compact-heading">
          <div>
            <p class="eyebrow">Review</p>
            <h4>Triggers and findings</h4>
          </div>
        </div>
        <div class="form-grid">
          ${renderSelect(
            "productOrgSettings.defaultReviewPolicy",
            "Review policy",
            form.defaultReviewPolicy,
            [
              "disabled",
              "summary_only",
              "inline_comments",
              "inline_comments_and_summary",
              "check_run_only",
              "inline_comments_summary_and_check_run",
            ],
            disabled,
          )}
          ${renderSelect(
            "productOrgSettings.severityThreshold",
            "Severity threshold",
            form.severityThreshold,
            ["low", "medium", "high", "critical"],
            disabled,
          )}
          ${renderNumberInput(
            "productOrgSettings.maxCommentsPerReview",
            "Max comments",
            form.maxCommentsPerReview,
            "0",
            "50",
            disabled,
          )}
          <label>
            <span>Minimum confidence</span>
            <input
              data-field="productOrgSettings.minimumConfidence"
              min="0"
              max="1"
              step="0.01"
              type="number"
              value="${escapeAttribute(form.minimumConfidence)}"
              ${disabled ? "disabled" : ""}
            />
          </label>
          <label>
            <span>Required label</span>
            <input
              data-field="productOrgSettings.requireLabel"
              placeholder="security-review"
              value="${escapeAttribute(form.requireLabel)}"
              ${disabled ? "disabled" : ""}
            />
          </label>
          ${renderCheckbox(
            "productOrgSettings.skipDraftPullRequests",
            "Skip draft pull requests",
            form.skipDraftPullRequests,
            disabled,
          )}
          ${renderCheckbox(
            "productOrgSettings.allowStyleFindings",
            "Allow style findings",
            form.allowStyleFindings,
            disabled,
          )}
          ${renderCheckbox(
            "productOrgSettings.suppressGeneratedFileFindings",
            "Suppress generated-file findings",
            form.suppressGeneratedFileFindings,
            disabled,
          )}
        </div>
        <div class="form-grid textareas">
          ${renderTextarea(
            "productOrgSettings.enabledActions",
            "Enabled actions",
            form.enabledActions,
            disabled,
          )}
          ${renderTextarea(
            "productOrgSettings.enabledCategories",
            "Finding categories",
            form.enabledCategories,
            disabled,
          )}
          ${renderTextarea(
            "productOrgSettings.ignoredAuthors",
            "Ignored authors",
            form.ignoredAuthors,
            disabled,
          )}
          ${renderTextarea(
            "productOrgSettings.ignoredLabels",
            "Ignored labels",
            form.ignoredLabels,
            disabled,
          )}
        </div>
      </section>
      <section class="settings-subsection">
        <div class="section-heading compact-heading">
          <div>
            <p class="eyebrow">Publishing and Memory</p>
            <h4>Organization guardrails</h4>
          </div>
        </div>
        <div class="form-grid">
          ${renderCheckbox(
            "productOrgSettings.publishInlineComments",
            "Publish inline comments",
            form.publishInlineComments,
            disabled,
          )}
          ${renderCheckbox(
            "productOrgSettings.publishSummaryComment",
            "Publish summary comments",
            form.publishSummaryComment,
            disabled,
          )}
          ${renderCheckbox(
            "productOrgSettings.publishCheckRun",
            "Publish check runs",
            form.publishCheckRun,
            disabled,
          )}
          ${renderCheckbox(
            "productOrgSettings.enableMemoryContext",
            "Use memory context",
            form.enableMemoryContext,
            disabled,
          )}
          ${renderCheckbox(
            "productOrgSettings.enableMemorySuppression",
            "Use memory suppression",
            form.enableMemorySuppression,
            disabled,
          )}
          ${renderCheckbox(
            "productOrgSettings.requireApprovalForMemoryFacts",
            "Require memory approval",
            form.requireApprovalForMemoryFacts,
            disabled,
          )}
          ${renderCheckbox(
            "productOrgSettings.allowRepoLocalConfig",
            "Allow repo-local config",
            form.allowRepoLocalConfig,
            disabled,
          )}
          ${renderCheckbox(
            "productOrgSettings.allowUserDefinedRules",
            "Allow repository rules",
            form.allowUserDefinedRules,
            disabled,
          )}
          ${renderCheckbox(
            "productOrgSettings.allowMemorySuppression",
            "Allow org memory suppression",
            form.allowMemorySuppression,
            disabled,
          )}
          ${renderNumberInput(
            "productOrgSettings.maxMemoryFactsInContext",
            "Memory facts in context",
            form.maxMemoryFactsInContext,
            "0",
            "20",
            disabled,
          )}
          ${renderNumberInput(
            "productOrgSettings.memoryTtlDays",
            "Memory TTL days",
            form.memoryTtlDays,
            "1",
            "3650",
            disabled,
          )}
        </div>
        <div class="form-grid textareas">
          ${renderTextarea(
            "productOrgSettings.trustedFeedbackRoles",
            "Trusted feedback roles",
            form.trustedFeedbackRoles,
            disabled,
          )}
          ${renderTextarea(
            "productOrgSettings.allowedModelProfiles",
            "Allowed model profiles",
            form.allowedModelProfiles,
            disabled,
          )}
        </div>
      </section>
    </div>
  `;
}

/** Renders authenticated repository controls. */
function renderAuthenticatedProductRepositories(
  rows: readonly AdminRepositorySummary[],
  canManageRepositories: boolean,
): string {
  return `
    <section>
      <div class="section-heading compact-heading">
        <div>
          <p class="eyebrow">Repositories</p>
          <h3>Synced repositories</h3>
        </div>
      </div>
      ${
        rows.length === 0
          ? `<p class="inline-empty">No repositories are visible for this organization yet.</p>`
          : `<div class="repo-list">${rows.map((row) => renderAuthenticatedProductRepository(row, canManageRepositories)).join("")}</div>`
      }
    </section>
  `;
}

/** Renders one authenticated product repository row. */
function renderAuthenticatedProductRepository(
  repository: AdminRepositorySummary,
  canManageRepositories: boolean,
): string {
  return `
    <article class="repo-card">
      <div>
        <div class="repo-title">
          <strong>${escapeHtml(repository.fullName)}</strong>
          <span class="status ${repository.enabled ? "ok" : "muted"}">
            ${repository.enabled ? "reviewing" : "paused"}
          </span>
        </div>
        <p class="muted-text">
          ${escapeHtml(repository.visibility)}${repository.defaultBranch ? ` · ${escapeHtml(repository.defaultBranch)}` : ""}
        </p>
      </div>
      <div class="row-actions">
        ${
          repository.latestReviewStatus
            ? `<span class="status ${statusClass(repository.latestReviewStatus)}">${escapeHtml(repository.latestReviewStatus)}</span>`
            : `<span class="status muted">no reviews</span>`
        }
        <button
          class="small"
          data-action="open-product-repository-settings"
          data-repo-id="${escapeAttribute(repository.repoId)}"
          type="button"
        >
          Settings
        </button>
        <button
          class="ghost small"
          data-action="reindex-product-repository"
          data-repo-id="${escapeAttribute(repository.repoId)}"
          type="button"
          ${canManageRepositories ? "" : "disabled"}
        >
          Reindex
        </button>
        <button
          class="ghost small"
          data-action="toggle-product-repository"
          data-enabled="${repository.enabled ? "false" : "true"}"
          data-repo-id="${escapeAttribute(repository.repoId)}"
          type="button"
          ${canManageRepositories ? "" : "disabled"}
        >
          ${repository.enabled ? "Pause" : "Enable"}
        </button>
      </div>
    </article>
  `;
}

/** Renders the selected product repository settings and rules panel. */
function renderProductRepositorySettingsPanel(
  canManageSettings: boolean,
  canManageRules: boolean,
  canReadMemory: boolean,
  canManageMemory: boolean,
): string {
  const settings = state.product.repositorySettings;
  if (!settings) {
    return "";
  }

  const form = settings.form;
  const options: SettingsFormRenderOptions = {
    ...PRODUCT_SETTINGS_RENDER_OPTIONS,
    canManageRules: Boolean(canManageRules && form),
    canManageSettings: Boolean(canManageSettings && form),
  };

  return `
    <section class="product-repository-settings">
      <div class="section-heading compact-heading">
        <div>
          <p class="eyebrow">Repository Settings</p>
          <h3>${escapeHtml(settings.data?.repository.fullName ?? settings.repoId)}</h3>
        </div>
        <div class="row-actions">
          <button
            data-action="save-product-settings"
            type="button"
            ${options.canManageSettings ? "" : "disabled"}
          >
            Save
          </button>
          <button
            class="ghost small"
            data-action="preview-product-policy"
            type="button"
            ${form ? "" : "disabled"}
          >
            Preview
          </button>
        </div>
      </div>
      ${renderSettingsNotice(settings)}
      ${
        form
          ? renderSettingsForm(
              form,
              settings.ruleForm,
              settings.data,
              settings.rules,
              settings.preview,
              options,
            )
          : `<p class="inline-empty">Select Settings on a repository to load review policy controls.</p>`
      }
      ${renderProductRepositoryMemoryPanel(settings, canReadMemory, canManageMemory)}
    </section>
  `;
}

/** Renders product-facing memory facts and pending candidates for one repository. */
function renderProductRepositoryMemoryPanel(
  settings: ProductRepositorySettingsState,
  canReadMemory: boolean,
  canManageMemory: boolean,
): string {
  if (!canReadMemory) {
    return `<p class="inline-empty">This role cannot view repository memory.</p>`;
  }

  const pendingCandidates = settings.memoryCandidates.filter(
    (candidate) => candidate.status === "pending",
  );
  const activeFacts = settings.memoryFacts.filter((fact) => fact.status === "active");
  const recentSuppressionMatches = settings.suppressionMatches;

  return `
    <section class="settings-inline-panel product-memory-panel">
      <div class="section-heading compact-heading">
        <div>
          <p class="eyebrow">Memory</p>
          <h4>Repository guidance</h4>
        </div>
        <div class="row-actions">
          <span class="status ${pendingCandidates.length > 0 ? "warn" : "ok"}">
            ${pendingCandidates.length} pending
          </span>
          <button class="ghost small" data-action="refresh-product-memory" type="button">
            Refresh
          </button>
        </div>
      </div>
      ${renderProductMemoryCandidateRows(pendingCandidates, canManageMemory)}
      ${renderProductMemoryFactRows(activeFacts)}
      ${renderProductSuppressionMatchRows(recentSuppressionMatches)}
    </section>
  `;
}

/** Renders pending product memory candidate rows. */
function renderProductMemoryCandidateRows(
  candidates: readonly ProductMemoryCandidateSummary[],
  canManageMemory: boolean,
): string {
  if (candidates.length === 0) {
    return `<p class="inline-empty">No pending memory candidates currently apply to this repository.</p>`;
  }

  return `
    <div class="table-wrap compact-table">
      <table>
        <thead>
          <tr><th>Candidate</th><th>Trust</th><th>Confidence</th><th>Updated</th><th>Actions</th></tr>
        </thead>
        <tbody>
          ${candidates
            .map((candidate) => renderProductMemoryCandidateRow(candidate, canManageMemory))
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

/** Renders one pending product memory candidate row. */
function renderProductMemoryCandidateRow(
  candidate: ProductMemoryCandidateSummary,
  canManageMemory: boolean,
): string {
  const disabled = canManageMemory ? "" : "disabled";

  return `
    <tr>
      <td>
        <strong>${escapeHtml(candidate.candidateKind)}</strong>
        <p class="muted-text">${escapeHtml(candidate.proposedContent)}</p>
        <small>${escapeHtml(candidate.sourceKind)}${candidate.sourceFindingId ? ` · ${escapeHtml(candidate.sourceFindingId)}` : ""}</small>
      </td>
      <td>${escapeHtml(candidate.trustLevel)}</td>
      <td>${formatPercent(candidate.confidence)}</td>
      <td>${formatTime(candidate.updatedAt)}</td>
      <td>
        <div class="row-actions">
          <button
            class="small"
            data-action="approve-product-memory-candidate"
            data-memory-candidate-id="${escapeAttribute(candidate.memoryCandidateId)}"
            type="button"
            ${disabled}
          >
            Approve
          </button>
          <button
            class="danger small"
            data-action="reject-product-memory-candidate"
            data-memory-candidate-id="${escapeAttribute(candidate.memoryCandidateId)}"
            type="button"
            ${disabled}
          >
            Reject
          </button>
        </div>
      </td>
    </tr>
  `;
}

/** Renders recent product memory suppression matches. */
function renderProductSuppressionMatchRows(
  matches: readonly ProductSuppressionMatchSummary[],
): string {
  if (matches.length === 0) {
    return "";
  }

  return `
    <details class="finding-json product-suppression-matches">
      <summary class="finding-json-summary">Suppression hits</summary>
      <div class="table-wrap compact-table">
        <table>
          <thead>
            <tr><th>Finding</th><th>Memory</th><th>Match</th><th>When</th></tr>
          </thead>
          <tbody>
            ${matches.map(renderProductSuppressionMatchRow).join("")}
          </tbody>
        </table>
      </div>
    </details>
  `;
}

/** Renders one recent product memory suppression match row. */
function renderProductSuppressionMatchRow(match: ProductSuppressionMatchSummary): string {
  return `
    <tr>
      <td>
        <strong>${escapeHtml(match.findingTitle)}</strong>
        <p class="muted-text">${escapeHtml(locationLabel(match.location))}</p>
        <small>${escapeHtml(`${match.findingSeverity} / ${match.findingCategory}`)}</small>
      </td>
      <td>
        <strong>${escapeHtml(shortHash(match.memoryFactId))}</strong>
        <p class="muted-text">${escapeHtml(match.memoryText)}</p>
      </td>
      <td>
        <strong>${escapeHtml(match.matchKind)}</strong>
        <p class="muted-text">${escapeHtml(match.reason ?? "No reason recorded")}</p>
        <small>${formatPercent(match.confidence)}</small>
      </td>
      <td>${formatTime(match.createdAt)}</td>
    </tr>
  `;
}

/** Renders active product memory fact rows. */
function renderProductMemoryFactRows(facts: readonly ProductMemoryFactSummary[]): string {
  if (facts.length === 0) {
    return "";
  }

  return `
    <details class="finding-json product-memory-facts">
      <summary class="finding-json-summary">Active memory</summary>
      <div class="table-wrap compact-table">
        <table>
          <thead>
            <tr><th>Fact</th><th>Scope</th><th>Confidence</th><th>Updated</th></tr>
          </thead>
          <tbody>
            ${facts
              .map(
                (fact) => `
                  <tr>
                    <td>
                      <strong>${escapeHtml(fact.kind)}</strong>
                      <p class="muted-text">${escapeHtml(fact.text)}</p>
                    </td>
                    <td>${escapeHtml(fact.scope)}</td>
                    <td>${formatPercent(fact.confidence)}</td>
                    <td>${formatTime(fact.updatedAt)}</td>
                  </tr>
                `,
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </details>
  `;
}

/** Renders product review detail, finding list, and selected finding inspection. */
function renderProductReviewDetailPanel(
  canWriteFindings: boolean,
  canSuppressFindings: boolean,
  canRerunReviews: boolean,
  canReadReviewDebug: boolean,
): string {
  const detail = state.product.reviewDetail;
  if (!detail) {
    return "";
  }

  const reviewRun = detail.reviewRun;
  const title = reviewRun
    ? `#${reviewRun.pullRequestNumber} ${reviewRun.pullRequestTitle ?? reviewRun.trigger}`
    : detail.reviewRunId;

  return `
    <section class="product-review-detail">
      <div class="section-heading compact-heading">
        <div>
          <p class="eyebrow">Review Detail</p>
          <h3>${escapeHtml(title)}</h3>
        </div>
        <div class="row-actions">
          <button
            class="ghost small"
            data-action="refresh-product-review-detail"
            type="button"
          >
            Refresh
          </button>
          <button
            class="ghost small"
            data-action="rerun-product-review"
            data-review-run-id="${escapeAttribute(detail.reviewRunId)}"
            type="button"
            ${canRerunReviews ? "" : "disabled"}
          >
            Rerun
          </button>
        </div>
      </div>
      ${detail.loading ? `<p class="notice compact">${escapeHtml(detail.loading)}...</p>` : ""}
      ${detail.error ? `<p class="error-line">${escapeHtml(detail.error)}</p>` : ""}
      ${detail.saved ? `<p class="notice success compact">${escapeHtml(detail.saved)}</p>` : ""}
      ${reviewRun ? renderProductReviewSummary(reviewRun) : ""}
      <div class="product-review-grid">
        ${renderProductFindingList(detail.findings, detail.selectedFinding)}
        ${renderProductFindingDetail(
          detail,
          detail.selectedFinding,
          canWriteFindings,
          canSuppressFindings,
        )}
      </div>
      ${renderProductReviewArtifacts(detail, canReadReviewDebug)}
    </section>
  `;
}

/** Renders compact product review metadata. */
function renderProductReviewSummary(reviewRun: AdminReviewRunSummary): string {
  return `
    <div class="detail-grid compact-detail-grid">
      <div class="detail-item">
        <span>Status</span>
        <strong>${escapeHtml(reviewRun.status)}</strong>
      </div>
      <div class="detail-item">
        <span>Repository</span>
        <strong>${escapeHtml(reviewRun.repoFullName)}</strong>
      </div>
      <div class="detail-item">
        <span>Findings</span>
        <strong>${reviewRun.counts.publishedFindings}/${reviewRun.counts.validatedFindings}</strong>
      </div>
      <div class="detail-item">
        <span>Updated</span>
        <strong>${formatTime(reviewRun.updatedAt)}</strong>
      </div>
    </div>
    ${
      reviewRun.summary
        ? `<p class="muted-text product-review-summary">${escapeHtml(reviewRun.summary)}</p>`
        : ""
    }
    ${renderProductReviewFailure(reviewRun.failure)}
    ${renderProductReviewJobs(reviewRun.relatedJobs ?? [])}
  `;
}

/** Renders one product-safe review failure summary. */
function renderProductReviewFailure(failure: AdminFailureDetail | undefined): string {
  if (!failure) {
    return "";
  }

  return `
    <div class="review-failure">
      <strong>${escapeHtml(failure.code)}</strong>
      <p>${escapeHtml(failure.message)}</p>
      <small>
        ${failure.occurredAt ? escapeHtml(formatTime(failure.occurredAt)) : ""}
        ${failure.retryable === undefined ? "" : ` · retryable: ${String(failure.retryable)}`}
      </small>
    </div>
  `;
}

/** Renders product-safe durable jobs tied to one review run. */
function renderProductReviewJobs(jobs: readonly AdminBackgroundJobDebugSummary[]): string {
  if (jobs.length === 0) {
    return "";
  }
  const failedCount = jobs.filter(
    (job) => job.status === "failed" || job.status === "dead_lettered",
  ).length;

  return `
    <section class="product-review-jobs">
      <div class="section-heading compact-heading">
        <div>
          <p class="eyebrow">Jobs</p>
          <h4>Durable timeline</h4>
        </div>
        <span class="status ${failedCount > 0 ? "bad" : "ok"}">
          ${failedCount > 0 ? `${failedCount} failed` : `${jobs.length} tracked`}
        </span>
      </div>
      <div class="table-wrap compact-table">
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Queue</th>
              <th>Type</th>
              <th>Attempts</th>
              <th>Updated</th>
              <th>Failure</th>
            </tr>
          </thead>
          <tbody>
            ${jobs.map(renderProductReviewJobRow).join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

/** Renders one product-safe durable job row. */
function renderProductReviewJobRow(job: AdminBackgroundJobDebugSummary): string {
  const attempts =
    job.attempts === undefined || job.maxAttempts === undefined
      ? "n/a"
      : `${job.attempts}/${job.maxAttempts}`;
  const updatedAt = job.updatedAt ?? job.completedAt ?? job.startedAt ?? job.createdAt;

  return `
    <tr>
      <td><span class="status ${statusClass(job.status)}">${escapeHtml(job.status)}</span></td>
      <td>${escapeHtml(job.queueName)}</td>
      <td>${escapeHtml(job.jobType)}</td>
      <td>${escapeHtml(attempts)}</td>
      <td>${updatedAt ? formatTime(updatedAt) : "n/a"}</td>
      <td>
        ${
          job.failure
            ? `<strong>${escapeHtml(job.failure.code)}</strong><small>${escapeHtml(
                job.failure.message,
              )}</small>`
            : `<span class="muted-text">none</span>`
        }
      </td>
    </tr>
  `;
}

/** Renders payload-free artifact metadata attached to a product review. */
function renderProductReviewArtifacts(
  detail: ProductReviewDetailState,
  canReadReviewDebug: boolean,
): string {
  const artifacts = detail.artifacts ?? [];

  return `
    <section class="product-review-artifacts">
      <div class="section-heading compact-heading">
        <div>
          <p class="eyebrow">Artifacts</p>
          <h4>Debug references</h4>
        </div>
        <button
          class="ghost small"
          data-action="load-product-review-artifacts"
          data-review-run-id="${escapeAttribute(detail.reviewRunId)}"
          type="button"
          ${canReadReviewDebug ? "" : "disabled"}
        >
          ${detail.artifactsLoaded ? "Refresh" : "Load metadata"}
        </button>
      </div>
      ${
        canReadReviewDebug
          ? renderProductReviewArtifactRows(detail, artifacts, Boolean(detail.artifactsLoaded))
          : `<p class="inline-empty">This role cannot view review debug artifact metadata.</p>`
      }
    </section>
  `;
}

/** Renders product artifact metadata rows or the current empty state. */
function renderProductReviewArtifactRows(
  detail: ProductReviewDetailState,
  artifacts: readonly AdminReviewArtifactSummary[],
  artifactsLoaded: boolean,
): string {
  if (!artifactsLoaded) {
    return `<p class="inline-empty">Artifact metadata has not been loaded for this review.</p>`;
  }
  if (artifacts.length === 0) {
    return `<p class="inline-empty">No artifacts are attached to this review run.</p>`;
  }
  const hasStoredPayload = artifacts.some((artifact) => Boolean(artifact.hasStoredPayload));

  return `
    ${
      hasStoredPayload
        ? `<div class="artifact-access-row">
            <label>
              Access reason
              <input
                data-field="productReview.artifactAccessReason"
                placeholder="Support ticket or incident reason"
                type="text"
                value="${escapeAttribute(detail.artifactAccessReason)}"
              />
            </label>
          </div>`
        : ""
    }
    <div class="table-wrap artifact-table">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Kind</th>
            <th>Class</th>
            <th>Size</th>
            <th>Hash</th>
            <th>Metadata</th>
            <th>Created</th>
            <th>Payload</th>
          </tr>
        </thead>
        <tbody>
          ${artifacts.map((artifact) => renderProductReviewArtifactRow(detail, artifact)).join("")}
        </tbody>
      </table>
    </div>
    ${renderProductReviewArtifactPayload(detail)}
  `;
}

/** Renders one product artifact metadata row. */
function renderProductReviewArtifactRow(
  detail: ProductReviewDetailState,
  artifact: AdminReviewArtifactSummary,
): string {
  const metadataKeys = artifact.metadataKeys ?? [];

  return `
    <tr>
      <td>
        <strong>${escapeHtml(artifact.name)}</strong>
        <small>${escapeHtml(artifact.uri)}</small>
      </td>
      <td>${escapeHtml(artifact.kind)}</td>
      <td>${escapeHtml(artifact.classification ?? "n/a")}</td>
      <td>${formatBytes(artifact.sizeBytes)}</td>
      <td>${artifact.hash ? `<code>${escapeHtml(shortHash(artifact.hash))}</code>` : "n/a"}</td>
      <td>
        ${
          metadataKeys.length > 0
            ? `<span>${escapeHtml(metadataKeys.join(", "))}</span>`
            : `<span class="muted-text">none</span>`
        }
        ${artifact.hasStoredPayload ? `<small>stored payload</small>` : ""}
        ${renderStaticAnalysisArtifactSummary(artifact)}
      </td>
      <td>${formatTime(artifact.createdAt)}</td>
      <td>
        <div class="artifact-actions">
          <button
            class="ghost small"
            data-action="load-product-review-artifact-payload"
            data-artifact-id="${escapeAttribute(artifact.reviewArtifactId)}"
            data-review-run-id="${escapeAttribute(detail.reviewRunId)}"
            type="button"
            ${artifact.hasStoredPayload ? "" : "disabled"}
          >
            View
          </button>
          <button
            class="ghost small"
            data-action="download-product-review-artifact-payload"
            data-artifact-id="${escapeAttribute(artifact.reviewArtifactId)}"
            data-review-run-id="${escapeAttribute(detail.reviewRunId)}"
            type="button"
            ${artifact.hasStoredPayload ? "" : "disabled"}
          >
            Download
          </button>
        </div>
      </td>
    </tr>
  `;
}

/** Renders compact static-analysis counters for artifact list rows. */
function renderStaticAnalysisArtifactSummary(artifact: AdminReviewArtifactSummary): string {
  const summary = artifact.staticAnalysis;
  if (!summary) {
    return "";
  }

  const diagnostics = formatCompactNumber(summary.diagnosticCount);
  const changedLineDiagnostics = formatCompactNumber(summary.changedLineDiagnosticCount);
  const highSeverityDiagnostics = formatCompactNumber(summary.highSeverityDiagnosticCount);
  const warnings = formatCompactNumber(summary.warningCount);
  const toolRuns = `${formatCompactNumber(summary.succeededToolRunCount)}/${formatCompactNumber(
    summary.toolRunCount,
  )}`;

  return `
    <small>
      ${escapeHtml(summary.status)} ${escapeHtml(summary.mode)}:
      ${diagnostics} diagnostics,
      ${changedLineDiagnostics} changed-line,
      ${highSeverityDiagnostics} high-severity,
      ${warnings} warnings,
      ${toolRuns} tools,
      ${formatDurationMs(summary.durationMs)}
    </small>
  `;
}

/** Renders the selected redacted artifact payload preview. */
function renderProductReviewArtifactPayload(detail: ProductReviewDetailState): string {
  const payload = detail.artifactPayload;
  if (!payload) {
    return "";
  }

  return `
    <section class="artifact-payload-preview">
      <div class="section-heading compact-heading">
        <div>
          <p class="eyebrow">Payload</p>
          <h4>${escapeHtml(payload.artifact.name)}</h4>
        </div>
        <span class="status">${escapeHtml(payload.accessLevel)}</span>
      </div>
      <p class="meta-line">
        Audit event <code>${escapeHtml(payload.artifactAccessEventId)}</code>
      </p>
      <pre>${escapeHtml(JSON.stringify(payload.payload, null, 2))}</pre>
    </section>
  `;
}

/** Renders validated finding rows for one product review. */
function renderProductFindingList(
  findings: readonly AdminReviewFindingSummary[],
  selectedFinding: AdminReviewFindingSummary | undefined,
): string {
  return `
    <section>
      <div class="section-heading compact-heading">
        <div>
          <p class="eyebrow">Findings</p>
          <h4>Validated findings</h4>
        </div>
        <span class="status muted">${findings.length}</span>
      </div>
      ${
        findings.length === 0
          ? `<p class="inline-empty">No validated findings are attached to this review run.</p>`
          : `<div class="finding-list">${findings.map((finding) => renderProductFindingRow(finding, selectedFinding?.findingId === finding.findingId)).join("")}</div>`
      }
    </section>
  `;
}

/** Renders one selectable product finding row. */
function renderProductFindingRow(finding: AdminReviewFindingSummary, selected: boolean): string {
  return `
    <button
      class="finding-row ${selected ? "selected" : ""}"
      data-action="select-product-finding"
      data-finding-id="${escapeAttribute(finding.findingId)}"
      type="button"
    >
      <span class="status ${statusClass(finding.decision)}">${escapeHtml(finding.decision)}</span>
      <strong>${escapeHtml(finding.title)}</strong>
      <small>${escapeHtml(`${finding.severity} / ${finding.category}`)}</small>
      <small>${escapeHtml(locationLabel(finding.location))}</small>
    </button>
  `;
}

/** Renders selected product finding detail and outcome controls. */
function renderProductFindingDetail(
  detail: ProductReviewDetailState,
  finding: AdminReviewFindingSummary | undefined,
  canWriteFindings: boolean,
  canSuppressFindings: boolean,
): string {
  if (!finding) {
    return `
      <section>
        <div class="section-heading compact-heading">
          <div>
            <p class="eyebrow">Finding</p>
            <h4>Detail</h4>
          </div>
        </div>
        <p class="inline-empty">Select a finding to inspect validation, publication, and outcome state.</p>
      </section>
    `;
  }

  return `
    <section>
      <div class="section-heading compact-heading">
        <div>
          <p class="eyebrow">Finding</p>
          <h4>${escapeHtml(finding.title)}</h4>
        </div>
        <span class="status ${statusClass(finding.severity)}">${escapeHtml(finding.severity)}</span>
      </div>
      <div class="finding-detail">
        <p>${escapeHtml(finding.body)}</p>
        <dl>
          <div><dt>Location</dt><dd>${escapeHtml(locationLabel(finding.location))}</dd></div>
          <div><dt>Confidence</dt><dd>${formatPercent(finding.confidence)}</dd></div>
          <div><dt>Fingerprint</dt><dd>${escapeHtml(shortHash(finding.fingerprint))}</dd></div>
          <div><dt>Publication</dt><dd>${escapeHtml(finding.publication?.status ?? "not published")}</dd></div>
          <div><dt>Latest outcome</dt><dd>${escapeHtml(finding.latestOutcome?.outcome ?? "none")}</dd></div>
        </dl>
        ${renderProductFindingFeedbackTimeline(detail.selectedFindingFeedbackEvents)}
        ${renderProductFindingJson("Validation", finding.validation)}
        ${renderProductFindingJson("Evidence", finding.evidence)}
        ${renderProductFindingOutcomeControls(finding, detail.outcomeNote, canWriteFindings)}
        ${renderProductFindingSuppressionControls(finding, detail, canSuppressFindings)}
      </div>
    </section>
  `;
}

/** Renders one compact JSON payload for finding detail tabs. */
function renderProductFindingJson(title: string, value: unknown): string {
  return `
    <details class="finding-json">
      <summary class="finding-json-summary">${escapeHtml(title)}</summary>
      <pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>
    </details>
  `;
}

/** Renders the selected finding feedback timeline. */
function renderProductFindingFeedbackTimeline(
  events: readonly AdminReviewFindingFeedbackEventSummary[] | undefined,
): string {
  if (!events) {
    return `<p class="inline-empty">Open a finding to load feedback events.</p>`;
  }
  if (events.length === 0) {
    return `<p class="inline-empty">No feedback events have been recorded for this finding.</p>`;
  }

  return `
    <details class="finding-json finding-feedback-timeline" open>
      <summary class="finding-json-summary">Feedback timeline</summary>
      <div class="timeline-list">
        ${events.map(renderProductFindingFeedbackEvent).join("")}
      </div>
    </details>
  `;
}

/** Renders one selected finding feedback timeline event. */
function renderProductFindingFeedbackEvent(event: AdminReviewFindingFeedbackEventSummary): string {
  const signals = event.signals.length
    ? event.signals.map(renderProductFindingFeedbackSignal).join("")
    : `<span class="muted-text">No classified signals</span>`;

  return `
    <div class="timeline-item">
      <div>
        <strong>${escapeHtml(event.eventKind)}</strong>
        <small>${escapeHtml(event.actorLogin ?? event.provider)} · ${escapeHtml(formatTime(event.receivedAt))}</small>
      </div>
      <div class="timeline-signals">${signals}</div>
    </div>
  `;
}

/** Renders one selected finding feedback signal chip. */
function renderProductFindingFeedbackSignal(
  signal: AdminReviewFindingFeedbackSignalSummary,
): string {
  return `
    <span class="signal-chip ${statusClass(signal.polarity)}" title="${escapeAttribute(
      signal.reason,
    )}">
      ${escapeHtml(signal.signalKind)} · ${formatPercent(signal.confidence)}
    </span>
  `;
}

/** Renders product finding outcome controls. */
function renderProductFindingOutcomeControls(
  finding: AdminReviewFindingSummary,
  outcomeNote: string,
  canWriteFindings: boolean,
): string {
  const disabled = canWriteFindings ? "" : "disabled";
  return `
    <div class="finding-outcome-controls">
      <label>
        <span>Outcome note</span>
        <textarea
          data-field="productFinding.outcomeNote"
          rows="3"
          ${disabled}
        >${escapeHtml(outcomeNote)}</textarea>
      </label>
      <div class="row-actions">
        ${PRODUCT_FINDING_OUTCOME_ACTIONS.map(
          (action) => `
              <button
                class="ghost small"
                data-action="set-product-finding-outcome"
                data-finding-id="${escapeAttribute(finding.findingId)}"
                data-outcome="${escapeAttribute(action.outcome)}"
                type="button"
                ${disabled}
              >
                ${escapeHtml(action.label)}
              </button>
            `,
        ).join("")}
      </div>
    </div>
  `;
}

/** Renders product finding suppression controls. */
function renderProductFindingSuppressionControls(
  finding: AdminReviewFindingSummary,
  detail: ProductReviewDetailState,
  canSuppressFindings: boolean,
): string {
  const disabled = canSuppressFindings ? "" : "disabled";
  return `
    <div class="finding-suppression-controls">
      <div class="form-grid compact-form">
        <label>
          <span>Suppress scope</span>
          <select data-field="productFinding.suppressionScope" ${disabled}>
            <option value="repo" ${detail.suppressionScope === "repo" ? "selected" : ""}>Repository</option>
            <option value="org" ${detail.suppressionScope === "org" ? "selected" : ""}>Organization</option>
          </select>
        </label>
        <label>
          <span>Reason</span>
          <input
            data-field="productFinding.suppressionReason"
            maxlength="1000"
            placeholder="Repeated false positive"
            type="text"
            value="${escapeAttribute(detail.suppressionReason)}"
            ${disabled}
          />
        </label>
        <button
          class="ghost small"
          data-action="suppress-product-finding-similar"
          data-finding-id="${escapeAttribute(finding.findingId)}"
          type="button"
          ${disabled}
        >
          Suppress similar
        </button>
      </div>
    </div>
  `;
}

/** Renders authenticated product review history. */
function renderAuthenticatedProductReviews(rows: readonly AdminReviewRunSummary[]): string {
  return `
    <section>
      <div class="section-heading compact-heading">
        <div>
          <p class="eyebrow">Reviews</p>
          <h3>Recent review runs</h3>
        </div>
      </div>
      ${
        rows.length === 0
          ? `<p class="inline-empty">No review runs are visible for this organization yet.</p>`
          : renderAuthenticatedProductReviewRows(rows)
      }
    </section>
  `;
}

/** Renders authenticated product review rows. */
function renderAuthenticatedProductReviewRows(rows: readonly AdminReviewRunSummary[]): string {
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Pull request</th>
            <th>Repository</th>
            <th>Status</th>
            <th>Findings</th>
            <th>Updated</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${rows
            .map(
              (row) => `
                <tr>
                  <td>
                    <strong>#${row.pullRequestNumber}</strong>
                    <p class="muted-text">${escapeHtml(row.pullRequestTitle ?? row.trigger)}</p>
                  </td>
                  <td>${escapeHtml(row.repoFullName)}</td>
                  <td>
                    <span class="status ${statusClass(row.status)}">${escapeHtml(row.status)}</span>
                    ${
                      row.failure
                        ? `<p class="error-line compact-error">${escapeHtml(row.failure.message)}</p>`
                        : ""
                    }
                  </td>
                  <td>${row.counts.publishedFindings}/${row.counts.validatedFindings}</td>
                  <td>${formatTime(row.updatedAt)}</td>
                  <td>
                    <button
                      class="small"
                      data-action="open-product-review-detail"
                      data-review-run-id="${escapeAttribute(row.reviewRunId)}"
                      type="button"
                    >
                      Open
                    </button>
                  </td>
                </tr>
              `,
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

/** Renders product setup details. */
function renderProductSetupPanel(data: ProductOnboardingSummary): string {
  const app = data.githubApp;
  const webhookLabel = data.webhook.latestEventName
    ? `${data.webhook.latestEventName}${data.webhook.latestAction ? `:${data.webhook.latestAction}` : ""}`
    : "No deliveries yet";

  return `
    <section class="panel product-panel product-setup">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Setup</p>
          <h3>GitHub App</h3>
        </div>
        <span class="status ${app.configured ? "ok" : "warn"}">
          ${app.configured ? "ready" : "missing config"}
        </span>
      </div>
      <div class="setup-list">
        ${renderSetupRow("App ID", app.appId ?? "Not configured", Boolean(app.appId))}
        ${renderSetupRow("Install URL", app.installUrl ?? "Set HEIMDALL_GITHUB_APP_SLUG", Boolean(app.installUrl))}
        ${renderSetupRow("Webhook secret", app.webhookConfigured ? "Configured" : "Missing", app.webhookConfigured)}
        ${renderSetupRow("Webhook URL", app.webhookUrl ?? "Set HEIMDALL_API_PUBLIC_URL or WEB_URL", Boolean(app.webhookUrl))}
        ${renderSetupRow("Latest webhook", webhookLabel, Boolean(data.webhook.latestEventName))}
      </div>
    </section>
  `;
}

/** Renders one setup checklist row. */
function renderSetupRow(label: string, value: string, ok: boolean): string {
  return `
    <div class="setup-row">
      <span class="status ${ok ? "ok" : "warn"}">${ok ? "ready" : "todo"}</span>
      <div>
        <strong>${escapeHtml(label)}</strong>
        <code>${escapeHtml(value)}</code>
      </div>
    </div>
  `;
}

/** Renders known GitHub App installations. */
function renderProductInstallations(rows: readonly ProductInstallationSummary[]): string {
  return `
    <section class="panel product-panel">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Connection</p>
          <h3>Installations</h3>
        </div>
      </div>
      ${
        rows.length === 0
          ? `<p class="inline-empty">No GitHub App installation webhook has arrived yet.</p>`
          : `<div class="install-list">${rows.map(renderProductInstallation).join("")}</div>`
      }
    </section>
  `;
}

/** Renders one product installation row. */
function renderProductInstallation(row: ProductInstallationSummary): string {
  const status = row.deletedAt ? "deleted" : row.suspendedAt ? "suspended" : "active";
  return `
    <article class="mini-row">
      <div>
        <strong>${escapeHtml(row.accountLogin)}</strong>
        <span>${escapeHtml(row.provider)} · ${escapeHtml(row.accountType)}</span>
      </div>
      <span class="status ${status === "active" ? "ok" : "warn"}">${escapeHtml(status)}</span>
    </article>
  `;
}

/** Renders known product repositories. */
function renderProductRepositories(rows: readonly ProductRepositorySummary[]): string {
  return `
    <section class="panel product-panel product-wide">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Repositories</p>
          <h3>Monitored Repos</h3>
        </div>
      </div>
      ${
        rows.length === 0
          ? `<p class="inline-empty">Install the GitHub App on a repository to populate this list.</p>`
          : `<div class="repo-list">${rows.map(renderProductRepositoryCard).join("")}</div>`
      }
    </section>
  `;
}

/** Renders one product repository card without admin-only controls. */
function renderProductRepositoryCard(repository: ProductRepositorySummary): string {
  const repoUrl = githubRepositoryUrl(repository.fullName);
  return `
    <article class="repo-card">
      <div>
        <div class="repo-title">
          <strong>${escapeHtml(repository.fullName)}</strong>
          <span class="status ${repository.enabled ? "ok" : "muted"}">
            ${repository.enabled ? "reviewing" : "paused"}
          </span>
        </div>
        <p class="muted-text">
          ${escapeHtml(repository.visibility)}${repository.defaultBranch ? ` · ${escapeHtml(repository.defaultBranch)}` : ""}
        </p>
      </div>
      <div class="row-actions">
        ${
          repository.latestReviewStatus
            ? `<span class="status ${statusClass(repository.latestReviewStatus)}">${escapeHtml(repository.latestReviewStatus)}</span>`
            : `<span class="status muted">waiting for PR</span>`
        }
        <a class="button-link ghost small" href="${escapeAttribute(repoUrl)}" target="_blank" rel="noreferrer">
          Repo
        </a>
        <a class="button-link small" href="${escapeAttribute(`${repoUrl}/pulls`)}" target="_blank" rel="noreferrer">
          PRs
        </a>
      </div>
    </article>
  `;
}

/** Returns the GitHub repository URL for a provider full name. */
function githubRepositoryUrl(fullName: string): string {
  return `https://github.com/${encodeURI(fullName)}`;
}

/** Renders product review activity. */
function renderProductReviews(rows: readonly ProductReviewSummary[]): string {
  return `
    <section class="panel product-panel product-wide">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Reviews</p>
          <h3>Recent PR Reviews</h3>
        </div>
      </div>
      ${
        rows.length === 0
          ? `<p class="inline-empty">Open or update a pull request after installation to trigger review work.</p>`
          : renderProductReviewRows(rows)
      }
    </section>
  `;
}

/** Renders product review rows without admin-only inspector actions. */
function renderProductReviewRows(rows: readonly ProductReviewSummary[]): string {
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Pull request</th>
            <th>Repository</th>
            <th>Status</th>
            <th>Findings</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          ${rows
            .map(
              (review) => `
                <tr>
                  <td>
                    <strong>${escapeHtml(review.pullRequestTitle ?? `PR #${review.pullRequestNumber}`)}</strong>
                    <span class="muted-text">#${review.pullRequestNumber}${review.authorLogin ? ` by ${escapeHtml(review.authorLogin)}` : ""}</span>
                  </td>
                  <td>${escapeHtml(review.repoFullName)}</td>
                  <td><span class="status ${statusClass(review.status)}">${escapeHtml(review.status)}</span></td>
                  <td>${escapeHtml(`${review.counts.publishedFindings} published`)}</td>
                  <td>${escapeHtml(formatTime(review.updatedAt))}</td>
                </tr>
              `,
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

/** Renders the product dashboard before the first load completes. */
function renderProductLoadingState(): string {
  return `
    <section class="panel product-panel">
      <p class="inline-empty">Loading deployment setup and GitHub App activity.</p>
    </section>
  `;
}

/** Renders the current session badge. */
function renderSessionBadge(): string {
  if (state.activeMode === "product" && state.product.session) {
    const user = state.product.session.user;
    const label = user.displayName ?? user.primaryEmail ?? user.userId;
    return `
      <div class="actor">
        <span class="status ok">product</span>
        <strong>${escapeHtml(label)}</strong>
      </div>
    `;
  }

  if (!state.session) {
    return "";
  }

  const actor = state.session.actor;
  const label = actor.displayName ?? actor.email ?? actor.userId;
  return `
    <div class="actor">
      <span class="status ${actor.role === "admin" ? "ok" : "warn"}">${escapeHtml(actor.role)}</span>
      <strong>${escapeHtml(label)}</strong>
    </div>
  `;
}

/** Renders the authentication controls. */
function renderAuthPanel(): string {
  const disabled = state.authLoading ? "disabled" : "";

  // Connected state - minimal inline status
  if (state.session) {
    return `
      <section class="auth-panel connected">
        <div class="session-info">
          <span class="connection-dot"></span>
          <span>Connected to <strong>${escapeHtml(formatApiHost())}</strong></span>
        </div>
        <div class="session-actions">
          <button class="ghost small" data-action="refresh-session" type="button" ${disabled}>
            Refresh
          </button>
          <button class="ghost small" data-action="clear-auth" type="button" ${disabled}>
            Disconnect
          </button>
        </div>
        ${state.authError ? `<p class="error-line">${escapeHtml(state.authError)}</p>` : ""}
      </section>
    `;
  }

  // Disconnected state - guided onboarding flow
  const loadingMessage = state.authLoading
    ? `<p class="notice">${escapeHtml(state.authLoading)}...</p>`
    : "";

  return `
    <section class="auth-panel disconnected">
      <div class="auth-icon">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <circle cx="12" cy="8" r="4" />
          <path d="M4 20c0-4 4-6 8-6s8 2 8 6" />
        </svg>
      </div>
      <h3>Connect to Heimdall</h3>
      <p>Authenticate with GitHub to access repository controls, review inspectors, and audit history.</p>

      ${loadingMessage}
      ${state.authError ? `<p class="error-line">${escapeHtml(state.authError)}</p>` : ""}

      <div class="auth-actions">
        <button class="primary" data-action="login-github" type="button" ${disabled}>
          Sign in with GitHub
        </button>
        <button data-action="connect-admin-session" type="button" ${disabled}>
          Connect existing session
        </button>
      </div>

      <details class="auth-advanced">
        <summary>Advanced configuration</summary>
        <div class="auth-advanced-content">
          <label>
            <span>API URL</span>
            <input
              data-field="api-base-url"
              placeholder="https://api.heimdall.example.com"
              value="${escapeAttribute(state.apiBaseUrl)}"
            />
          </label>
          <label>
            <span>Gateway URL</span>
            <input
              data-field="gateway-base-url"
              placeholder="https://gateway.heimdall.example.com"
              value="${escapeAttribute(state.gatewayBaseUrl)}"
            />
          </label>
        </div>
      </details>
    </section>
  `;
}

/** Formats the API host for display in the connection status. */
function formatApiHost(): string {
  const url = state.apiBaseUrl.trim();
  if (!url) {
    return `${window.location.host} (same origin)`;
  }
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 40);
  }
}

/** Formats the gateway host for display in the connection status. */
function formatGatewayHost(): string {
  const url = state.gatewayBaseUrl.trim();
  if (!url) {
    return `${window.location.host} (same origin)`;
  }
  try {
    return new URL(url, window.location.origin).host;
  } catch {
    return url.slice(0, 40);
  }
}

/** Renders the disconnected landing workspace. */
function renderDisconnectedWorkspace(): string {
  const pendingLogin = sessionStorage.getItem(PENDING_GATEWAY_LOGIN_STORAGE_KEY) === "true";
  const statuses: readonly {
    readonly label: string;
    readonly value: string;
    readonly state: "ok" | "warn" | "muted";
  }[] = [
    {
      label: "API",
      state: state.apiBaseUrl.trim() ? "ok" : "muted",
      value: formatApiHost(),
    },
    {
      label: "Gateway",
      state: state.gatewayBaseUrl.trim() ? "ok" : "muted",
      value: formatGatewayHost(),
    },
    {
      label: "Session",
      state: pendingLogin || state.authLoading ? "warn" : "muted",
      value: pendingLogin ? "OAuth return pending" : (state.authLoading ?? "Not connected"),
    },
  ];

  return `
    <main class="preflight-workspace">
      <section class="operator-brief">
        <div>
          <p class="eyebrow">Operator Path</p>
          <h2>Connect once, then work from the overview.</h2>
        </div>
        <p>
          Use the overview to open repositories, review runs, settings, and audit history without
          copying internal IDs.
        </p>
      </section>
      <section class="connection-grid" aria-label="Connection readiness">
        ${statuses
          .map(
            (item) => `
              <article class="connection-card">
                <span class="status ${item.state}">${escapeHtml(item.label)}</span>
                <strong>${escapeHtml(item.value)}</strong>
              </article>
            `,
          )
          .join("")}
      </section>
      <section class="guided-path" aria-label="Operator workflow">
        ${renderPathStep("1", "GitHub login", "Authenticate through the admin gateway.", "active")}
        ${renderPathStep("2", "Admin session", "Exchange the gateway assertion for API access.", "pending")}
        ${renderPathStep("3", "Overview", "Load scoped repositories, reviews, and audit events.", "pending")}
      </section>
    </main>
  `;
}

/** Renders one step in the disconnected operator path. */
function renderPathStep(
  number: string,
  title: string,
  body: string,
  stateName: "active" | "pending",
): string {
  return `
    <article class="path-step ${stateName}">
      <span>${escapeHtml(number)}</span>
      <div>
        <strong>${escapeHtml(title)}</strong>
        <p>${escapeHtml(body)}</p>
      </div>
    </article>
  `;
}

/** Renders primary control-plane navigation. */
function renderPrimaryNav(): string {
  const views: readonly { readonly kind: ViewKind; readonly label: string }[] = [
    { kind: "overview", label: "Overview" },
    { kind: "inspectors", label: "Inspectors" },
    { kind: "settings", label: "Settings" },
    { kind: "evaluation", label: "Evaluation" },
    { kind: "usage", label: "Usage" },
    { kind: "plan", label: "Plan" },
    { kind: "billing", label: "Billing" },
    { kind: "security", label: "Security" },
    { kind: "audit", label: "Audit" },
  ];
  return `
    <nav class="primary-nav" aria-label="Control-plane views">
      ${views
        .map(
          (view) => `
            <button
              class="tab ${state.activeView === view.kind ? "active" : ""}"
              data-view="${view.kind}"
              type="button"
            >
              ${escapeHtml(view.label)}
            </button>
          `,
        )
        .join("")}
    </nav>
  `;
}

/** Renders the active primary control-plane view. */
function renderActiveView(): string {
  if (state.activeView === "overview") {
    return renderOverviewView();
  }
  if (state.activeView === "settings") {
    return renderSettingsView();
  }
  if (state.activeView === "evaluation") {
    return renderEvaluationView();
  }
  if (state.activeView === "audit") {
    return renderAuditView();
  }
  if (state.activeView === "usage") {
    return renderUsageView();
  }
  if (state.activeView === "plan") {
    return renderEntitlementsView();
  }
  if (state.activeView === "billing") {
    return renderBillingView();
  }
  if (state.activeView === "security") {
    return renderSecurityEventView();
  }

  return `
    <section class="workspace">
      <nav class="tabs" aria-label="Inspector views">
        ${objectValues(inspectorConfigs)
          .map((config) => renderTab(config))
          .join("")}
      </nav>
      ${renderInspector()}
    </section>
  `;
}

/** Renders the dashboard overview with discovery and activity. */
function renderOverviewView(): string {
  const overview = state.overview;
  const stats = computeOverviewStats(overview);

  return `
    <main class="inspector overview-view">
      <section class="inspector-header">
        <div>
          <p class="eyebrow">Dashboard</p>
          <h2>Control Overview</h2>
        </div>
        <button class="primary" data-action="load-overview" type="button">Refresh</button>
      </section>
      ${renderOverviewNotice(overview)}
      ${renderOverviewStats(stats)}
      ${renderRuntimeHealthPanel(overview.runtimeHealth)}
      <section class="overview-grid">
        ${renderRepositoryDiscovery(overview)}
        ${renderReviewHistoryDiscovery(overview)}
      </section>
      ${renderRecentActivity(overview.auditLogs)}
    </main>
  `;
}

/** Overview statistics computed from loaded data. */
type OverviewStats = {
  readonly totalRepos: number;
  readonly enabledRepos: number;
  readonly recentReviews: number;
  readonly completedReviews: number;
  readonly failedReviews: number;
  readonly skippedReviews: number;
  readonly totalFindings: number;
  readonly publishedFindings: number;
  readonly averagePublishedFindings: number;
  readonly medianDurationMs?: number | undefined;
  readonly p95DurationMs?: number | undefined;
  readonly estimatedCostUsd?: string | undefined;
};

/** Computes statistics for the overview dashboard. */
function computeOverviewStats(overview: OverviewViewState): OverviewStats {
  const enabledRepos = overview.repositories.filter((r) => r.enabled).length;
  const metrics = overview.reviewMetrics;
  const failedReviews =
    metrics?.failedRuns ?? overview.reviews.filter((r) => r.status === "failed").length;
  const totalFindings =
    metrics?.validatedFindings ??
    overview.reviews.reduce((sum, r) => sum + r.counts.validatedFindings, 0);
  const publishedFindings =
    metrics?.publishedFindings ??
    overview.reviews.reduce((sum, r) => sum + r.counts.publishedFindings, 0);

  return {
    totalRepos: overview.repositories.length,
    enabledRepos,
    recentReviews: metrics?.totalRuns ?? overview.reviews.length,
    completedReviews:
      metrics?.completedRuns ?? overview.reviews.filter((r) => r.status === "completed").length,
    failedReviews,
    skippedReviews:
      metrics?.skippedRuns ?? overview.reviews.filter((r) => r.status === "skipped").length,
    totalFindings,
    publishedFindings,
    averagePublishedFindings:
      metrics?.averagePublishedFindings ??
      (overview.reviews.length > 0 ? publishedFindings / overview.reviews.length : 0),
    ...(metrics?.medianDurationMs !== undefined
      ? { medianDurationMs: metrics.medianDurationMs }
      : {}),
    ...(metrics?.p95DurationMs !== undefined ? { p95DurationMs: metrics.p95DurationMs } : {}),
    ...(metrics?.estimatedCostUsd !== undefined
      ? { estimatedCostUsd: metrics.estimatedCostUsd }
      : {}),
  };
}

/** Renders overview statistics cards. */
function renderOverviewStats(stats: OverviewStats): string {
  if (stats.totalRepos === 0 && stats.recentReviews === 0) {
    return "";
  }

  return `
    <section class="summary-grid">
      ${renderMetric("Repositories", `${stats.enabledRepos}/${stats.totalRepos} enabled`)}
      ${renderMetric("Reviews", `${stats.completedReviews}/${stats.recentReviews} completed`)}
      ${renderMetric("Failed", String(stats.failedReviews), stats.failedReviews > 0)}
      ${renderMetric("Skipped", String(stats.skippedReviews))}
      ${renderMetric("Findings", `${stats.publishedFindings} published`)}
      ${renderMetric("Median Duration", formatDurationMs(stats.medianDurationMs))}
      ${renderMetric("P95 Duration", formatDurationMs(stats.p95DurationMs))}
      ${renderMetric("Avg Findings", stats.averagePublishedFindings.toFixed(2))}
      ${renderMetric("Est. Cost", formatUsd(stats.estimatedCostUsd))}
    </section>
  `;
}

/** Renders product-safe API readiness checks on the operator overview. */
function renderRuntimeHealthPanel(runtimeHealth: ApiHealthResponse | undefined): string {
  if (!runtimeHealth) {
    return "";
  }

  return `
    <section class="panel runtime-health-panel">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Runtime</p>
          <h3>API Health</h3>
        </div>
        <span class="status ${runtimeHealth.ok ? "ok" : "bad"}">
          ${runtimeHealth.ok ? "ready" : "degraded"}
        </span>
      </div>
      <div class="setup-list">
        ${runtimeHealth.checks.map(renderRuntimeHealthCheck).join("")}
      </div>
      <p class="muted-text">Updated ${formatTime(runtimeHealth.timestamp)}</p>
    </section>
  `;
}

/** Renders one API readiness check row. */
function renderRuntimeHealthCheck(check: ApiHealthCheck): string {
  return `
    <div class="setup-row">
      <span class="status ${check.status === "pass" ? "ok" : "bad"}">
        ${escapeHtml(check.status)}
      </span>
      <div>
        <strong>${escapeHtml(check.name)}</strong>
        ${check.message ? `<code>${escapeHtml(check.message)}</code>` : ""}
      </div>
    </div>
  `;
}

/** Renders overview loading and error state. */
function renderOverviewNotice(overview: OverviewViewState): string {
  if (overview.loading) {
    return `<p class="notice">${escapeHtml(overview.loading)}...</p>`;
  }
  if (overview.error) {
    return `<p class="error-line">${escapeHtml(overview.error)}</p>`;
  }

  return "";
}

/** Renders the evaluation history dashboard. */
function renderEvaluationView(): string {
  const evaluation = state.evaluation;
  return `
    <main class="inspector evaluation-view">
      <section class="inspector-header">
        <div>
          <p class="eyebrow">Quality Gates</p>
          <h2>Evaluation History</h2>
        </div>
        <button class="primary" data-action="load-evaluation" type="button">Refresh</button>
      </section>
      ${renderEvaluationNotice(evaluation)}
      <section class="overview-grid evaluation-grid">
        ${renderEvaluationSuites(evaluation)}
        ${renderEvaluationRuns(evaluation)}
      </section>
      ${evaluation.selectedRun ? renderEvaluationRunDetails(evaluation.selectedRun) : ""}
    </main>
  `;
}

/** Renders evaluation loading and error state. */
function renderEvaluationNotice(evaluation: EvaluationViewState): string {
  if (evaluation.loading) {
    return `<p class="notice">${escapeHtml(evaluation.loading)}...</p>`;
  }
  if (evaluation.error) {
    return `<p class="error-line">${escapeHtml(evaluation.error)}</p>`;
  }

  return "";
}

/** Renders persisted evaluation suite cards. */
function renderEvaluationSuites(evaluation: EvaluationViewState): string {
  return `
    <section class="panel discovery-panel">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Suites</p>
          <h3>Persisted Suites</h3>
        </div>
        <span class="status muted">${escapeHtml(String(evaluation.suites.length))}</span>
      </div>
      ${
        evaluation.suites.length === 0
          ? `<p class="inline-empty">No evaluation suites have been persisted yet.</p>`
          : `<div class="repo-list">${evaluation.suites.map(renderEvaluationSuiteCard).join("")}</div>`
      }
    </section>
  `;
}

/** Renders one evaluation suite card. */
function renderEvaluationSuiteCard(suite: EvaluationSuiteSummary): string {
  const latestRun = suite.latestRun;
  const selected = suite.evalSuiteId === state.evaluation.selectedSuiteId;
  const status = latestRun?.status ?? "no runs";
  return `
    <article class="repo-card ${selected ? "selected" : ""}">
      <div>
        <div class="repo-title">
          <strong>${escapeHtml(suite.name)}</strong>
          <span class="status ${latestRun ? statusClass(latestRun.status) : "muted"}">${escapeHtml(status)}</span>
        </div>
        <p class="muted-text">
          ${escapeHtml(suite.evalSuiteId)}
          · ${escapeHtml(suite.owner)}
          · v${escapeHtml(suite.version)}
        </p>
        ${
          latestRun
            ? `<p class="muted-text">${escapeHtml(String(latestRun.caseCount))} cases · ${escapeHtml(formatTime(latestRun.startedAt))}</p>`
            : ""
        }
      </div>
      <div class="card-actions">
        <button
          class="small"
          data-action="select-evaluation-suite"
          data-suite-id="${escapeAttribute(suite.evalSuiteId)}"
          type="button"
        >
          Runs
        </button>
      </div>
    </article>
  `;
}

/** Renders recent evaluation runs for the selected suite. */
function renderEvaluationRuns(evaluation: EvaluationViewState): string {
  const selectedSuite = evaluation.suites.find(
    (suite) => suite.evalSuiteId === evaluation.selectedSuiteId,
  );
  return `
    <section class="panel discovery-panel">
      <div class="section-heading">
        <div>
          <p class="eyebrow">${escapeHtml(selectedSuite?.evalSuiteId ?? "No suite selected")}</p>
          <h3>Recent Runs</h3>
        </div>
        ${
          selectedSuite?.activeBaseline
            ? `<span class="status ok">baseline</span>`
            : `<span class="status muted">no baseline</span>`
        }
      </div>
      ${selectedSuite ? renderEvaluationSuiteMeta(selectedSuite) : ""}
      ${
        evaluation.runs.length === 0
          ? `<p class="inline-empty">No runs are stored for this suite.</p>`
          : renderEvaluationRunTable(evaluation.runs)
      }
    </section>
  `;
}

/** Renders compact metadata for the selected evaluation suite. */
function renderEvaluationSuiteMeta(suite: EvaluationSuiteSummary): string {
  return `
    <div class="detail-grid compact">
      ${renderDetail("Runner", suite.defaultRunner)}
      ${renderDetail("Updated", formatTime(suite.updatedAt))}
      ${renderDetail("Baseline", suite.activeBaseline?.baselineVariantId ?? "none")}
      ${renderDetail("Tags", unknownListLabel(suite.tags))}
    </div>
  `;
}

/** Renders evaluation run rows. */
function renderEvaluationRunTable(runs: readonly EvaluationRunSummary[]): string {
  return `
    <div class="table-wrap compact-table">
      <table>
        <thead>
          <tr>
            <th>Run</th>
            <th>Status</th>
            <th>Cases</th>
            <th>Started</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${runs
            .map(
              (run) => `
                <tr>
                  <td>
                    <strong>${escapeHtml(shortHash(run.evalRunId))}</strong>
                    <p class="muted-text">${escapeHtml(run.environment)}${run.branch ? ` · ${escapeHtml(run.branch)}` : ""}</p>
                  </td>
                  <td><span class="status ${statusClass(run.status)}">${escapeHtml(run.status)}</span></td>
                  <td>${escapeHtml(String(run.caseCount))}</td>
                  <td>${formatTime(run.startedAt)}</td>
                  <td>
                    <button
                      class="small"
                      data-action="open-evaluation-run"
                      data-run-id="${escapeAttribute(run.evalRunId)}"
                      type="button"
                    >
                      Open
                    </button>
                  </td>
                </tr>
              `,
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

/** Renders case-level details for one evaluation run. */
function renderEvaluationRunDetails(details: EvaluationRunDetails): string {
  const run = details.run;
  return `
    <section class="panel">
      <div class="section-heading">
        <div>
          <p class="eyebrow">${escapeHtml(run.evalSuiteId)}</p>
          <h3>${escapeHtml(run.evalRunId)}</h3>
        </div>
        <span class="status ${statusClass(run.status)}">${escapeHtml(run.status)}</span>
      </div>
      <div class="summary-grid">
        ${renderMetric("Cases", String(run.caseCount))}
        ${renderMetric("Passed", String(countEvaluationResults(details.caseResults, "passed")))}
        ${renderMetric("Failed", String(countEvaluationResults(details.caseResults, "failed")), countEvaluationResults(details.caseResults, "failed") > 0)}
        ${renderMetric("Started", formatTime(run.startedAt))}
      </div>
      <div class="detail-grid compact">
        ${renderDetail("Variant", run.evalVariantId)}
        ${renderDetail("Baseline Variant", run.baselineVariantId ?? "none")}
        ${renderDetail("Triggered By", run.triggeredBy)}
        ${renderDetail("Commit", run.gitCommitSha ? shortHash(run.gitCommitSha) : "n/a")}
        ${renderDetail("Report", run.reportUri ?? "n/a")}
        ${renderDetail("Completed", run.completedAt ? formatTime(run.completedAt) : "n/a")}
      </div>
      ${run.summary ? renderEvaluationJsonBlock("Summary", run.summary) : ""}
      ${renderEvaluationCaseResultRows(details.caseResults)}
    </section>
  `;
}

/** Counts case results that match one status. */
function countEvaluationResults(
  results: readonly EvaluationCaseResultSummary[],
  status: string,
): number {
  return results.filter((result) => result.status === status).length;
}

/** Renders case-level evaluation result rows. */
function renderEvaluationCaseResultRows(results: readonly EvaluationCaseResultSummary[]): string {
  if (results.length === 0) {
    return `<p class="inline-empty">This run has no persisted case results.</p>`;
  }

  return `
    <div class="table-wrap compact-table">
      <table>
        <thead>
          <tr>
            <th>Case</th>
            <th>Status</th>
            <th>Scores</th>
            <th>Unmatched</th>
            <th>Artifacts</th>
          </tr>
        </thead>
        <tbody>
          ${results
            .map(
              (result) => `
                <tr>
                  <td>
                    <strong>${escapeHtml(result.evalCaseId)}</strong>
                    <p class="muted-text">${escapeHtml(shortHash(result.evalCaseResultId))}</p>
                  </td>
                  <td><span class="status ${statusClass(result.status)}">${escapeHtml(result.status)}</span></td>
                  <td>${escapeHtml(unknownListLabel(result.scores))}</td>
                  <td>${escapeHtml(evaluationUnmatchedLabel(result))}</td>
                  <td>${escapeHtml(unknownListLabel(result.artifacts))}</td>
                </tr>
              `,
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

/** Renders a compact JSON block for structured evaluation data. */
function renderEvaluationJsonBlock(title: string, value: unknown): string {
  return `
    <details class="finding-json">
      <summary class="finding-json-summary">${escapeHtml(title)}</summary>
      <pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>
    </details>
  `;
}

/** Returns a compact label for unknown list-like JSON values. */
function unknownListLabel(value: unknown): string {
  if (Array.isArray(value)) {
    return `${value.length} item${value.length === 1 ? "" : "s"}`;
  }
  if (value && typeof value === "object") {
    return `${Object.keys(value).length} key${Object.keys(value).length === 1 ? "" : "s"}`;
  }
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  return "none";
}

/** Returns compact unmatched finding counts for one case result. */
function evaluationUnmatchedLabel(result: EvaluationCaseResultSummary): string {
  const expected = Array.isArray(result.unmatchedExpectedFindings)
    ? result.unmatchedExpectedFindings.length
    : 0;
  const generated = Array.isArray(result.unmatchedGeneratedFindings)
    ? result.unmatchedGeneratedFindings.length
    : 0;

  return `${expected} expected / ${generated} generated`;
}

/** Renders repository discovery cards. */
function renderRepositoryDiscovery(overview: OverviewViewState): string {
  return `
    <section class="panel discovery-panel">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Repositories</p>
          <h3>Monitored Repos</h3>
        </div>
      </div>
      <div class="inline-controls">
        <label>
          <span>Search</span>
          <input
            data-field="overview.repositorySearch"
            placeholder="owner/name"
            value="${escapeAttribute(overview.repositorySearch)}"
          />
        </label>
        <button data-action="search-repositories" type="button">Search</button>
      </div>
      ${
        overview.repositories.length === 0
          ? renderRepositoryEmptyState(overview)
          : `<div class="repo-list">${overview.repositories.map(renderRepositoryCard).join("")}</div>`
      }
    </section>
  `;
}

/** Renders the repository discovery empty state. */
function renderRepositoryEmptyState(overview: OverviewViewState): string {
  if (!overview.repositoriesLoaded) {
    return `<p class="inline-empty">Refresh loads the repositories granted to this admin session.</p>`;
  }

  if (overview.repositorySearch.trim()) {
    return `<p class="inline-empty">No repositories matched this search.</p>`;
  }

  return `<p class="inline-empty">No repositories are available for this admin scope.</p>`;
}

/** Renders one repository discovery card. */
function renderRepositoryCard(repository: AdminRepositorySummary): string {
  const hasRecentReview = Boolean(repository.latestReviewRunId);
  const reviewStatusClass = repository.latestReviewStatus
    ? statusClass(repository.latestReviewStatus)
    : "muted";

  return `
    <article class="repo-card">
      <div>
        <div class="repo-title">
          <strong>${escapeHtml(repository.fullName)}</strong>
          <span class="status ${repository.enabled ? "ok" : "muted"}">
            ${repository.enabled ? "active" : "paused"}
          </span>
        </div>
        <p class="muted-text">
          ${escapeHtml(repository.visibility)}${repository.defaultBranch ? ` · ${escapeHtml(repository.defaultBranch)}` : ""}${hasRecentReview ? ` · <span class="status ${reviewStatusClass}">${escapeHtml(repository.latestReviewStatus ?? "unknown")}</span>` : ""}
        </p>
      </div>
      <div class="card-actions">
        <button class="small" data-action="filter-reviews-repo" data-repo-id="${escapeAttribute(repository.repoId)}" type="button">
          Reviews
        </button>
        <button class="small" data-action="open-settings" data-repo-id="${escapeAttribute(repository.repoId)}" type="button">
          Settings
        </button>
      </div>
    </article>
  `;
}

/** Renders review history search and rows. */
function renderReviewHistoryDiscovery(overview: OverviewViewState): string {
  const hasFilter = overview.reviewRepoId || overview.reviewStatus || overview.reviewSearch;

  return `
    <section class="panel discovery-panel">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Reviews</p>
          <h3>Recent Activity</h3>
        </div>
        <button class="small" data-action="search-reviews" type="button">Refresh</button>
      </div>
      <div class="form-grid compact-form">
        ${renderTextInput("overview.reviewSearch", "Search", overview.reviewSearch, "PR title, author, #")}
        ${renderReviewStatusSelect(overview.reviewStatus)}
        <button data-action="search-reviews" type="button">Filter</button>
      </div>
      ${
        hasFilter
          ? `<div class="filter-chips">
              ${overview.reviewRepoId ? `<span class="status muted">repo: ${escapeHtml(overview.reviewRepoId.slice(0, 16))}</span>` : ""}
              ${overview.reviewStatus ? `<span class="status muted">status: ${escapeHtml(overview.reviewStatus)}</span>` : ""}
              <button class="ghost small" data-action="clear-review-filter" type="button">Clear filters</button>
            </div>`
          : ""
      }
      ${renderReviewRows(overview.reviews)}
    </section>
  `;
}

/** Renders the review status filter. */
function renderReviewStatusSelect(value: string): string {
  const statuses = ["", "queued", "reviewing", "completed", "failed", "cancelled"];
  return `
    <label>
      <span>Status</span>
      <select data-field="overview.reviewStatus">
        ${statuses
          .map(
            (status) => `
              <option value="${escapeAttribute(status)}" ${status === value ? "selected" : ""}>
                ${escapeHtml(status || "Any")}
              </option>
            `,
          )
          .join("")}
      </select>
    </label>
  `;
}

/** Renders review history rows. */
function renderReviewRows(rows: readonly AdminReviewRunSummary[]): string {
  if (rows.length === 0) {
    return `<p class="inline-empty">${escapeHtml(reviewEmptyStateText())}</p>`;
  }

  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Review</th>
            <th>Status</th>
            <th>Findings</th>
            <th>Updated</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(renderReviewRow).join("")}
        </tbody>
      </table>
    </div>
  `;
}

/** Returns the review history empty-state text. */
function reviewEmptyStateText(): string {
  if (!state.overview.reviewsLoaded) {
    return "Refresh loads the latest review runs for this session.";
  }
  if (
    state.overview.reviewRepoId.trim() ||
    state.overview.reviewSearch.trim() ||
    state.overview.reviewStatus.trim()
  ) {
    return "No review runs matched the current filters.";
  }

  return "No review runs are available for this admin scope.";
}

/** Renders one review history row. */
function renderReviewRow(review: AdminReviewRunSummary): string {
  const title =
    review.pullRequestTitle ?? review.summary ?? `Review ${review.reviewRunId.slice(0, 12)}`;
  const findingsLabel =
    review.counts.publishedFindings > 0
      ? `${review.counts.publishedFindings} published`
      : review.counts.validatedFindings > 0
        ? `${review.counts.validatedFindings} validated`
        : "—";

  return `
    <tr>
      <td>
        <strong>${escapeHtml(review.repoFullName)} #${review.pullRequestNumber}</strong>
        <p class="muted-text">${escapeHtml(title.slice(0, 60))}${title.length > 60 ? "…" : ""}</p>
      </td>
      <td><span class="status ${statusClass(review.status)}">${escapeHtml(review.status)}</span></td>
      <td>${findingsLabel}</td>
      <td><span class="muted-text">${formatTime(review.updatedAt)}</span></td>
      <td>
        <div class="row-actions">
          <button data-action="open-review-inspector" data-review-run-id="${escapeAttribute(review.reviewRunId)}" type="button">
            Inspect
          </button>
          <button data-action="open-publisher-inspector" data-review-run-id="${escapeAttribute(review.reviewRunId)}" type="button">
            Publish
          </button>
        </div>
      </td>
    </tr>
  `;
}

/** Renders recent audit activity from the overview. */
function renderRecentActivity(rows: readonly AdminAuditLogSummary[]): string {
  if (rows.length === 0) {
    return "";
  }

  return `
    <section class="panel">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Activity</p>
          <h3>Recent Audit Events</h3>
        </div>
        <button class="small" data-view="audit" type="button">View all</button>
      </div>
      ${renderAuditActivityRows(rows)}
    </section>
  `;
}

/** Renders recent audit rows in a compact table. */
function renderAuditActivityRows(rows: readonly AdminAuditLogSummary[]): string {
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>Time</th><th>Actor</th><th>Action</th><th>Resource</th><th>Open</th></tr>
        </thead>
        <tbody>
          ${rows
            .map(
              (row) => `
                <tr>
                  <td>${formatTime(row.occurredAt)}</td>
                  <td>${escapeHtml(row.actorUserId ?? row.actorType)}</td>
                  <td>${escapeHtml(row.action)}</td>
                  <td>${escapeHtml(row.resourceId ?? row.resourceType)}</td>
                  <td>
                    <button
                      data-action="open-audit-row"
                      data-resource-id="${escapeAttribute(row.resourceId ?? "")}"
                      data-resource-type="${escapeAttribute(row.resourceType)}"
                      data-search="${escapeAttribute(row.action)}"
                      type="button"
                    >
                      Filter
                    </button>
                  </td>
                </tr>
              `,
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

/** Renders repository settings controls. */
function renderSettingsView(): string {
  const settings = state.settings;
  const form = settings.form;
  const canSave = Boolean(state.session?.capabilities.canManageSettings && form);
  const options: SettingsFormRenderOptions = {
    ...ADMIN_SETTINGS_RENDER_OPTIONS,
    canManageRules: canSave,
    canManageSettings: canSave,
  };
  return `
    <main class="inspector">
      <section class="inspector-header">
        <div>
          <p class="eyebrow">Repository</p>
          <h2>Review Settings</h2>
        </div>
        <div class="resource-controls compact-controls">
          <label>
            <span>Repository ID</span>
            <input
              data-field="settings-repo-id"
              placeholder="repo_..."
              value="${escapeAttribute(settings.repoId)}"
            />
          </label>
          <button class="primary" data-action="load-settings" type="button">Load</button>
          <button
            data-action="save-settings"
            type="button"
            ${canSave ? "" : "disabled"}
          >
            Save Changes
          </button>
          <button
            data-action="preview-policy"
            type="button"
            ${form ? "" : "disabled"}
          >
            Preview Policy
          </button>
        </div>
      </section>
      ${renderSettingsNotice(settings)}
      ${
        form
          ? renderSettingsForm(
              form,
              settings.ruleForm,
              settings.data,
              settings.rules,
              settings.preview,
              options,
            )
          : renderEmptyState("Enter a repository ID and click Load to view settings.")
      }
    </main>
  `;
}

/** Renders settings loading, error, or saved state. */
function renderSettingsNotice(settings: SettingsViewState): string {
  if (settings.loading) {
    return `<p class="notice">${escapeHtml(settings.loading)}...</p>`;
  }
  if (settings.error) {
    return `<p class="error-line">${escapeHtml(settings.error)}</p>`;
  }
  if (settings.saved) {
    return `<p class="notice success">${escapeHtml(settings.saved)}</p>`;
  }

  return "";
}

/** Renders the repository settings form. */
function renderSettingsForm(
  form: SettingsFormState,
  ruleForm: RuleFormState,
  data: ControlPlaneSettingsResponse | undefined,
  rules: readonly AdminRepoRuleSummary[],
  preview: ControlPlanePolicyPreview | undefined,
  options: SettingsFormRenderOptions,
): string {
  const disabled = options.canManageSettings ? "" : "disabled";
  return `
    <section class="${escapeAttribute(options.formContainerClass)}">
      ${
        data
          ? `
            <div class="summary-grid">
              <div class="metric">
                <span>Repository</span>
                <strong>${escapeHtml(data.repository.fullName)}</strong>
              </div>
              <div class="metric">
                <span>Organization</span>
                <strong>${escapeHtml(data.repository.orgId)}</strong>
              </div>
              <div class="metric">
                <span>Automation</span>
                <strong>${data.repository.enabled ? "Enabled" : "Disabled"}</strong>
              </div>
            </div>
          `
          : ""
      }
      <div class="form-grid">
        ${renderCheckbox(`${options.settingsFieldPrefix}.repositoryEnabled`, "Review automation", form.repositoryEnabled, !options.canManageSettings)}
        ${renderSelect(
          `${options.settingsFieldPrefix}.reviewPolicy`,
          "Review policy",
          form.reviewPolicy,
          [
            "disabled",
            "summary_only",
            "inline_comments",
            "inline_comments_and_summary",
            "check_run_only",
            "inline_comments_summary_and_check_run",
          ],
          !options.canManageSettings,
        )}
        ${renderSelect(
          `${options.settingsFieldPrefix}.severityThreshold`,
          "Severity threshold",
          form.severityThreshold,
          ["low", "medium", "high", "critical"],
          !options.canManageSettings,
        )}
        <label>
          <span>Max comments</span>
          <input
            data-field="${escapeAttribute(`${options.settingsFieldPrefix}.maxCommentsPerReview`)}"
            min="0"
            max="50"
            type="number"
            value="${escapeAttribute(form.maxCommentsPerReview)}"
            ${disabled}
          />
        </label>
        <label>
          <span>Required label</span>
          <input
            data-field="${escapeAttribute(`${options.settingsFieldPrefix}.requireLabel`)}"
            placeholder="security-review"
            value="${escapeAttribute(form.requireLabel)}"
            ${disabled}
          />
        </label>
        ${renderCheckbox(`${options.settingsFieldPrefix}.skipGeneratedFiles`, "Skip generated files", form.skipGeneratedFiles, !options.canManageSettings)}
        ${renderCheckbox(
          `${options.settingsFieldPrefix}.skipDraftPullRequests`,
          "Skip draft pull requests",
          form.skipDraftPullRequests,
          !options.canManageSettings,
        )}
      </div>
      <div class="form-grid textareas">
        ${renderTextarea(`${options.settingsFieldPrefix}.ignoredPaths`, "Ignored paths", form.ignoredPaths, !options.canManageSettings)}
        ${renderTextarea(`${options.settingsFieldPrefix}.ignoredAuthors`, "Ignored authors", form.ignoredAuthors, !options.canManageSettings)}
        ${renderTextarea(`${options.settingsFieldPrefix}.ignoredLabels`, "Ignored labels", form.ignoredLabels, !options.canManageSettings)}
      </div>
      ${renderSandboxPolicySettings(form.sandboxPolicy, options)}
      <label>
        <span>Custom instructions</span>
        <textarea
          data-field="${escapeAttribute(`${options.settingsFieldPrefix}.customInstructions`)}"
          rows="8"
          ${disabled}
        >${escapeHtml(form.customInstructions)}</textarea>
      </label>
      ${renderPolicyPreview(preview)}
      ${renderRepositoryRules(rules, ruleForm, options)}
    </section>
  `;
}

/** Renders repository sandbox policy controls. */
function renderSandboxPolicySettings(
  sandboxPolicy: SandboxPolicyFormState,
  options: SettingsFormRenderOptions,
): string {
  const disabled = !options.canManageSettings;
  const prefix = `${options.settingsFieldPrefix}.sandboxPolicy`;
  return `
    <section class="settings-subsection">
      <div class="section-heading compact-heading">
        <div>
          <p class="eyebrow">Sandbox</p>
          <h3>Execution Policy</h3>
        </div>
        <span class="status ${sandboxPolicy.enabled ? "ok" : "muted"}">
          ${sandboxPolicy.enabled ? "enabled" : "disabled"}
        </span>
      </div>
      <div class="form-grid">
        ${renderCheckbox(`${prefix}.enabled`, "Sandbox execution", sandboxPolicy.enabled, disabled)}
        ${renderSelect(
          `${prefix}.defaultRunner`,
          "Default runner",
          sandboxPolicy.defaultRunner,
          SANDBOX_RUNNER_OPTIONS,
          disabled,
        )}
        ${renderSelect(
          `${prefix}.minimumRunnerForForks`,
          "Fork runner",
          sandboxPolicy.minimumRunnerForForks,
          SANDBOX_FORK_RUNNER_OPTIONS,
          disabled,
        )}
        ${renderCheckbox(`${prefix}.allowNetwork`, "Network access", sandboxPolicy.allowNetwork, disabled)}
        ${renderCheckbox(
          `${prefix}.allowDependencyInstall`,
          "Dependency installs",
          sandboxPolicy.allowDependencyInstall,
          disabled,
        )}
        ${renderCheckbox(
          `${prefix}.allowCustomCommands`,
          "Custom commands",
          sandboxPolicy.allowCustomCommands,
          disabled,
        )}
      </div>
      <div class="form-grid">
        ${renderNumberInput(`${prefix}.maxTimeoutMs`, "Timeout ms", sandboxPolicy.maxTimeoutMs, "1", "600000", disabled)}
        ${renderNumberInput(
          `${prefix}.maxMemoryBytes`,
          "Memory bytes",
          sandboxPolicy.maxMemoryBytes,
          "1",
          "8589934592",
          disabled,
        )}
        ${renderNumberInput(`${prefix}.maxCpuCount`, "CPU count", sandboxPolicy.maxCpuCount, "1", "16", disabled)}
        ${renderNumberInput(
          `${prefix}.maxOutputBytes`,
          "Output bytes",
          sandboxPolicy.maxOutputBytes,
          "0",
          "100000000",
          disabled,
        )}
        ${renderNumberInput(
          `${prefix}.maxArtifactBytes`,
          "Artifact bytes",
          sandboxPolicy.maxArtifactBytes,
          "0",
          "250000000",
          disabled,
        )}
      </div>
    </section>
  `;
}

/** Renders the effective policy preview for the current settings form. */
function renderPolicyPreview(preview: ControlPlanePolicyPreview | undefined): string {
  if (!preview) {
    return `
      <section class="settings-subsection">
        <div class="section-heading">
          <div>
            <p class="eyebrow">Policy</p>
            <h3>Effective Policy Preview</h3>
          </div>
          <span class="status muted">not compiled</span>
        </div>
        <p class="inline-empty">No policy preview is available for the current form state.</p>
      </section>
    `;
  }

  const policy = preview.effectivePolicy;
  return `
    <section class="settings-subsection">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Policy</p>
          <h3>Effective Policy Preview</h3>
        </div>
        <span class="status ${policy.enabled ? "ok" : "muted"}">
          ${policy.enabled ? "enabled" : "disabled"}
        </span>
      </div>
      <div class="summary-grid">
        <div class="metric">
          <span>Policy hash</span>
          <strong>${escapeHtml(shortHash(preview.policyHash))}</strong>
        </div>
        <div class="metric">
          <span>Review mode</span>
          <strong>${escapeHtml(policy.reviewPolicy)}</strong>
        </div>
        <div class="metric">
          <span>Severity</span>
          <strong>${escapeHtml(policy.findings.severityThreshold)}</strong>
        </div>
        <div class="metric">
          <span>Comments</span>
          <strong>${policy.findings.maxCommentsPerReview}</strong>
        </div>
      </div>
      ${renderPolicyPreviewDetails(preview)}
    </section>
  `;
}

/** Renders detailed policy preview rows. */
function renderPolicyPreviewDetails(preview: ControlPlanePolicyPreview): string {
  const policy = preview.effectivePolicy;
  const rows = [
    ["Check run", policy.publishing.publishCheckRun ? "on" : "off"],
    ["Inline comments", policy.publishing.publishInlineComments ? "on" : "off"],
    ["Summary comment", policy.publishing.publishSummaryComment ? "on" : "off"],
    ["Trigger actions", policy.trigger.enabledActions.join(", ")],
    ["Base branches", policy.trigger.includeBaseBranches?.join(", ") || "all"],
    ["Ignored labels", policy.trigger.ignoredLabels.join(", ") || "none"],
    ["Ignored authors", policy.trigger.ignoredAuthors.join(", ") || "none"],
    [
      "Required labels",
      policy.trigger.requireAnyLabels && policy.trigger.requireAnyLabels.length > 0
        ? policy.trigger.requireAnyLabels.join(", ")
        : (policy.trigger.requireLabel ?? "none"),
    ],
    ["Draft PRs", policy.trigger.skipDraftPullRequests ? "skipped" : "reviewed"],
    ["Instructions", String(policy.instructions.length)],
    ...sandboxPolicyPreviewRows(policy.sandbox),
    ["Trace", `${preview.trace.decisionType}:${preview.trace.reasonCode}`],
  ] as const;

  return `
    <div class="table-wrap">
      <table>
        <tbody>
          ${rows
            .map(
              ([label, value]) => `
                <tr>
                  <th>${escapeHtml(label)}</th>
                  <td>${escapeHtml(value)}</td>
                </tr>
              `,
            )
            .join("")}
        </tbody>
      </table>
    </div>
    ${renderPolicyWarnings(preview.warnings)}
  `;
}

/** Builds sandbox policy rows for the settings preview table. */
function sandboxPolicyPreviewRows(
  sandbox: ControlPlaneEffectivePolicy["sandbox"],
): readonly (readonly [string, string])[] {
  if (!sandbox) {
    return [];
  }

  return [
    ["Sandbox", sandbox.enabled ? sandbox.defaultRunner : "disabled"],
    ["Fork sandbox", sandbox.minimumRunnerForForks],
    ["Sandbox network", sandbox.allowNetwork ? "allowed" : "blocked"],
    ["Sandbox installs", sandbox.allowDependencyInstall ? "allowed" : "blocked"],
    ["Sandbox custom commands", sandbox.allowCustomCommands ? "allowed" : "blocked"],
    ["Sandbox timeout", `${sandbox.maxTimeoutMs} ms`],
    ["Sandbox memory", formatBytes(sandbox.maxMemoryBytes)],
    ["Sandbox output", formatBytes(sandbox.maxOutputBytes)],
  ];
}

/** Renders policy compiler warnings. */
function renderPolicyWarnings(warnings: readonly ControlPlanePolicyWarning[]): string {
  if (warnings.length === 0) {
    return `<p class="notice success">Policy compiled without warnings.</p>`;
  }

  return `
    <div class="notice warning">
      ${warnings
        .map(
          (warning) =>
            `<p><strong>${escapeHtml(warning.code)}</strong>: ${escapeHtml(warning.message)}</p>`,
        )
        .join("")}
    </div>
  `;
}

/** Renders repository rules that affect the loaded repository. */
function renderRepositoryRules(
  rules: readonly AdminRepoRuleSummary[],
  ruleForm: RuleFormState,
  options: SettingsFormRenderOptions,
): string {
  return `
    <section class="settings-subsection">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Rules</p>
          <h3>Repository Rules</h3>
        </div>
        <span class="status muted">${rules.length} rule${rules.length === 1 ? "" : "s"}</span>
      </div>
      ${
        options.canManageRules
          ? renderRepositoryRuleForm(ruleForm, options)
          : `<p class="inline-empty">Repository rules are read-only for your current role.</p>`
      }
      ${
        rules.length === 0
          ? `<p class="inline-empty">No repository or organization rules found.</p>`
          : renderRepositoryRuleRows(rules, options)
      }
    </section>
  `;
}

/** Renders the repository rule create/edit form. */
function renderRepositoryRuleForm(form: RuleFormState, options: SettingsFormRenderOptions): string {
  const editing = form.editingRuleId.length > 0;
  return `
    <div class="settings-rule-form">
      <div class="section-heading">
        <div>
          <p class="eyebrow">${editing ? "Edit" : "Create"}</p>
          <h4>${editing ? escapeHtml(form.editingRuleId) : "New Repository Rule"}</h4>
        </div>
        ${
          editing
            ? `<button class="ghost small" data-action="${escapeAttribute(options.cancelRuleEditAction)}" type="button">Cancel</button>`
            : ""
        }
      </div>
      <div class="form-grid">
        <label>
          <span>Name</span>
          <input
            data-field="${escapeAttribute(`${options.ruleFieldPrefix}.name`)}"
            placeholder="Suppress generated client findings"
            value="${escapeAttribute(form.name)}"
          />
        </label>
        ${renderSelect(`${options.ruleFieldPrefix}.effect`, "Effect", form.effect, [
          "suppress",
          "promote",
          "require",
          "context",
          "style_preference",
        ])}
        <label>
          <span>Priority</span>
          <input
            data-field="${escapeAttribute(`${options.ruleFieldPrefix}.priority`)}"
            min="0"
            max="1000"
            type="number"
            value="${escapeAttribute(form.priority)}"
          />
        </label>
        ${renderCheckbox(`${options.ruleFieldPrefix}.enabled`, "Enabled", form.enabled)}
      </div>
      <div class="form-grid textareas">
        ${renderTextarea(`${options.ruleFieldPrefix}.matcherPaths`, "Path matchers", form.matcherPaths)}
        ${renderTextarea(`${options.ruleFieldPrefix}.matcherCategories`, "Category matchers", form.matcherCategories)}
        ${renderTextarea(`${options.ruleFieldPrefix}.matcherSeverities`, "Severity matchers", form.matcherSeverities)}
      </div>
      <label>
        <span>Confidence less than</span>
        <input
          data-field="${escapeAttribute(`${options.ruleFieldPrefix}.matcherConfidenceLessThan`)}"
          max="1"
          min="0"
          step="0.01"
          type="number"
          value="${escapeAttribute(form.matcherConfidenceLessThan)}"
        />
      </label>
      <label>
        <span>Title regex</span>
        <input
          data-field="${escapeAttribute(`${options.ruleFieldPrefix}.titleRegex`)}"
          placeholder="generated|snapshot"
          value="${escapeAttribute(form.titleRegex)}"
        />
      </label>
      <label>
        <span>Instruction</span>
        <textarea data-field="${escapeAttribute(`${options.ruleFieldPrefix}.instruction`)}" rows="5">${escapeHtml(form.instruction)}</textarea>
      </label>
      <div class="row-actions">
        <button class="primary" data-action="${escapeAttribute(options.saveRuleAction)}" type="button">
          ${editing ? "Update Rule" : "Create Rule"}
        </button>
      </div>
    </div>
  `;
}

/** Renders repository rule rows. */
function renderRepositoryRuleRows(
  rules: readonly AdminRepoRuleSummary[],
  options: SettingsFormRenderOptions,
): string {
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>State</th>
            <th>Rule</th>
            <th>Effect</th>
            <th>Matcher</th>
            <th>Updated</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${rules
            .map(
              (rule) => `
                <tr>
                  <td>
                    <span class="status ${rule.enabled ? "ok" : "muted"}">
                      ${rule.enabled ? "enabled" : "disabled"}
                    </span>
                  </td>
                  <td>
                    <strong>${escapeHtml(rule.name)}</strong>
                    <p class="muted-text">${escapeHtml(rule.instruction)}</p>
                  </td>
                  <td>${escapeHtml(`${rule.repoId ? "repository" : "organization"}:${rule.effect}`)}</td>
                  <td>${escapeHtml(ruleMatcherLabel(rule))}</td>
                  <td>${formatTime(rule.updatedAt)}</td>
                  <td>
                    <div class="row-actions">
                      ${
                        rule.repoId && options.canManageRules
                          ? `
                            <button class="small" data-action="${escapeAttribute(options.editRuleAction)}" data-rule-id="${escapeAttribute(rule.ruleId)}" type="button">Edit</button>
                            <button class="danger small" data-action="${escapeAttribute(options.deleteRuleAction)}" data-rule-id="${escapeAttribute(rule.ruleId)}" type="button">Delete</button>
                          `
                          : `<span class="status muted">${rule.repoId ? "read only" : "org rule"}</span>`
                      }
                    </div>
                  </td>
                </tr>
              `,
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

/** Returns a compact matcher label for a repository rule row. */
function ruleMatcherLabel(rule: { readonly matcher: AdminRepoRuleSummary["matcher"] }): string {
  const parts = [
    matcherPart("paths", rule.matcher.paths),
    matcherPart("languages", rule.matcher.languages),
    matcherPart("categories", rule.matcher.categories),
    matcherPart("severities", rule.matcher.severities),
    rule.matcher.confidenceLessThan !== undefined
      ? `confidence<${formatPercent(rule.matcher.confidenceLessThan)}`
      : "",
    rule.matcher.titleRegex ? `title:${rule.matcher.titleRegex}` : "",
  ].filter((part) => part.length > 0);

  return parts.join(" | ") || "all findings";
}

/** Returns a compact label for one matcher field. */
function matcherPart(label: string, values: readonly string[] | undefined): string {
  return values && values.length > 0 ? `${label}:${values.join(",")}` : "";
}

/** Renders internal usage and cost rollups. */
function renderUsageView(): string {
  const usage = state.usage;
  return `
    <main class="inspector">
      <section class="inspector-header">
        <div>
          <p class="eyebrow">Usage</p>
          <h2>Ledger Rollups</h2>
        </div>
        <button class="primary" data-action="load-usage" type="button">Refresh</button>
      </section>
      ${renderUsageNotice(usage)}
      <section class="panel">
        <div class="form-grid">
          ${renderTextInput("usage.orgId", "Organization", usage.orgId, "org_...")}
          ${renderTextInput("usage.repoId", "Repository", usage.repoId, "repo_...")}
          ${renderTextInput("usage.periodStart", "Period start", usage.periodStart, "2026-05-01T00:00:00.000Z")}
          ${renderTextInput("usage.periodEnd", "Period end", usage.periodEnd, "2026-06-01T00:00:00.000Z")}
        </div>
      </section>
      ${usage.data ? renderUsageSummary(usage.data) : renderEmptyState("Refresh loads usage rollups for your admin scope.")}
    </main>
  `;
}

/** Renders usage loading and error state. */
function renderUsageNotice(usage: UsageViewState): string {
  if (usage.loading) {
    return `<p class="notice">${escapeHtml(usage.loading)}...</p>`;
  }
  if (usage.error) {
    return `<p class="error-line">${escapeHtml(usage.error)}</p>`;
  }

  return "";
}

/** Renders usage summary metrics and rollup rows. */
function renderUsageSummary(summary: AdminUsageSummary): string {
  return `
    <section class="summary-grid">
      ${renderMetric("Review Runs", String(summary.totals.reviewCount))}
      ${renderMetric("LLM Tokens", formatCompactNumber(summary.totals.llmTokens))}
      ${renderMetric("Cost", formatMicros(summary.totals.costMicros))}
      ${renderMetric("Ledger Events", String(summary.totals.eventCount))}
    </section>
    <section class="panel">
      <div class="section-heading">
        <div>
          <p class="eyebrow">${escapeHtml(usagePeriodLabel(summary))}</p>
          <h3>Usage by Source</h3>
        </div>
        <span class="status muted">${summary.rollups.length} row${summary.rollups.length === 1 ? "" : "s"}</span>
      </div>
      ${
        summary.rollups.length === 0
          ? `<p class="inline-empty">No usage events matched these filters.</p>`
          : renderUsageRollupRows(summary.rollups)
      }
    </section>
  `;
}

/** Renders usage rollup table rows. */
function renderUsageRollupRows(rollups: readonly AdminUsageRollupSummary[]): string {
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Scope</th>
            <th>Event</th>
            <th>Quantity</th>
            <th>Events</th>
            <th>Cost</th>
          </tr>
        </thead>
        <tbody>
          ${rollups
            .map(
              (rollup) => `
                <tr>
                  <td>
                    <strong>${escapeHtml(rollup.orgId)}</strong>
                    <p class="muted-text">${escapeHtml(rollup.repoId ?? "all repositories")}</p>
                  </td>
                  <td>${escapeHtml(rollup.eventType)} <span class="status muted">${escapeHtml(rollup.unit)}</span></td>
                  <td>${formatCompactNumber(rollup.quantity)}</td>
                  <td>${rollup.eventCount}</td>
                  <td>${formatMicros(rollup.costMicros)}</td>
                </tr>
              `,
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

/** Returns a compact label for a usage period. */
function usagePeriodLabel(summary: AdminUsageSummary): string {
  if (summary.periodStart && summary.periodEnd) {
    return `${formatDateOnly(summary.periodStart)} to ${formatDateOnly(summary.periodEnd)}`;
  }
  if (summary.periodStart) {
    return `Since ${formatDateOnly(summary.periodStart)}`;
  }
  if (summary.periodEnd) {
    return `Before ${formatDateOnly(summary.periodEnd)}`;
  }

  return "All Time";
}

/** Renders the plan snapshot and entitlement decision view. */
function renderEntitlementsView(): string {
  const entitlements = state.entitlements;
  return `
    <main class="inspector">
      <section class="inspector-header">
        <div>
          <p class="eyebrow">Billing</p>
          <h2>Plan Snapshot</h2>
        </div>
        <button class="primary" data-action="load-entitlements" type="button">Refresh</button>
      </section>
      ${renderEntitlementsNotice(entitlements)}
      <section class="panel">
        <div class="form-grid">
          ${renderTextInput("entitlements.orgId", "Organization", entitlements.orgId, "org_...")}
          ${renderTextarea("entitlements.featureKeys", "Feature keys", entitlements.featureKeys)}
        </div>
      </section>
      ${
        entitlements.data
          ? renderEntitlementsSummary(entitlements.data)
          : renderEmptyState(
              "Refresh loads the plan snapshot and entitlement decisions for your org scope.",
            )
      }
    </main>
  `;
}

/** Renders entitlement loading and error state. */
function renderEntitlementsNotice(entitlements: EntitlementsViewState): string {
  if (entitlements.loading) {
    return `<p class="notice">${escapeHtml(entitlements.loading)}...</p>`;
  }
  if (entitlements.error) {
    return `<p class="error-line">${escapeHtml(entitlements.error)}</p>`;
  }

  return "";
}

/** Renders plan snapshot metrics, decisions, and overrides. */
function renderEntitlementsSummary(summary: AdminEntitlementSummary): string {
  const snapshot = summary.planSnapshot;
  return `
    <section class="summary-grid">
      ${renderMetric("Plan", snapshot.planKey)}
      ${renderMetric("Subscription", snapshot.subscriptionStatus, snapshot.subscriptionStatus !== "active")}
      ${renderMetric("Payment", snapshot.paymentStatus, paymentNeedsAttention(snapshot.paymentStatus))}
      ${renderMetric("Review Credits", String(snapshot.limits["reviews.max_monthly_review_credits"] ?? "n/a"))}
    </section>
    <section class="panel">
      <div class="section-heading">
        <div>
          <p class="eyebrow">${escapeHtml(formatTime(summary.checkedAt))}</p>
          <h3>Feature Decisions</h3>
        </div>
        <span class="status muted">${summary.decisions.length} checked</span>
      </div>
      ${renderEntitlementDecisionRows(summary.decisions)}
    </section>
    <section class="panel">
      <div class="section-heading">
        <div>
          <p class="eyebrow">${escapeHtml(snapshot.planVersionId)}</p>
          <h3>Active Overrides</h3>
        </div>
        <span class="status muted">${summary.entitlements.length} row${summary.entitlements.length === 1 ? "" : "s"}</span>
      </div>
      ${renderEntitlementRows(summary.entitlements)}
    </section>
  `;
}

/** Renders local billing account and provider mirror state. */
function renderBillingView(): string {
  const billing = state.billing;
  return `
    <main class="inspector">
      <section class="inspector-header">
        <div>
          <p class="eyebrow">Billing</p>
          <h2>Account State</h2>
        </div>
        <button class="primary" data-action="load-billing" type="button">Refresh</button>
      </section>
      ${renderBillingNotice(billing)}
      <section class="panel">
        <div class="form-grid">
          ${renderTextInput("billing.orgId", "Organization", billing.orgId, "org_...")}
          ${renderTextInput("billing.meterPeriodKey", "Meter period", billing.meterPeriodKey, "2026-05")}
          ${renderSelect("billing.meterStatus", "Meter status", billing.meterStatus, [
            "all",
            "ready_to_send",
            "failed",
            "sent",
          ])}
        </div>
      </section>
      ${
        billing.data
          ? renderBillingSummary(billing.data)
          : renderEmptyState(
              "Refresh loads billing account, subscription, credit, invoice, and plan state.",
            )
      }
    </main>
  `;
}

/** Renders billing loading and error state. */
function renderBillingNotice(billing: BillingViewState): string {
  if (billing.loading) {
    return `<p class="notice">${escapeHtml(billing.loading)}...</p>`;
  }
  if (billing.error) {
    return `<p class="error-line">${escapeHtml(billing.error)}</p>`;
  }

  return "";
}

/** Renders billing summary metrics and mirror rows. */
function renderBillingSummary(summary: AdminBillingSummary): string {
  const account = summary.billingAccount;
  const subscription = summary.subscription;
  const monthlyUsage = state.billing.monthlyUsage;
  const meterEvents = state.billing.meterEvents?.meterEvents ?? [];
  const reconciliation = state.billing.reconciliation;
  const remainingCredits = summary.creditGrants.reduce(
    (sum, grant) => sum + grant.remainingQuantity,
    0,
  );
  const outstandingMicros = summary.invoices.reduce(
    (sum, invoice) => sum + invoice.amountRemainingMicros,
    0,
  );
  const reviewCreditUsage = monthlyUsage
    ? usageQuantity(monthlyUsage, "review.credit", "credit")
    : 0;
  const reviewCreditLimit = numericLimit(
    summary.planSnapshot.limits["reviews.max_monthly_review_credits"],
  );

  return `
    ${renderBillingAlerts(summary, monthlyUsage, reconciliation)}
    <section class="summary-grid">
      ${renderMetric("Plan", summary.planSnapshot.planKey)}
      ${renderMetric("Account", account.status, account.status !== "active")}
      ${renderMetric("Payment", account.paymentStatus, paymentNeedsAttention(account.paymentStatus))}
      ${renderMetric("Subscription", subscription?.status ?? "none", subscriptionStatusNeedsAttention(subscription?.status))}
      ${renderMetric(
        "Review Credits",
        reviewCreditLimit
          ? `${formatCompactNumber(reviewCreditUsage)} / ${formatCompactNumber(reviewCreditLimit)}`
          : formatCompactNumber(reviewCreditUsage),
        quotaNeedsAttention(reviewCreditUsage, reviewCreditLimit),
      )}
      ${renderMetric("Credits Left", formatCompactNumber(remainingCredits))}
      ${renderMetric("Outstanding", formatMicros(outstandingMicros), outstandingMicros > 0)}
    </section>
    ${renderBillingReconciliationPanel(reconciliation)}
    ${renderBillingPortalPanel(state.billing)}
    <section class="panel">
      <div class="section-heading">
        <div>
          <p class="eyebrow">${escapeHtml(formatTime(summary.checkedAt))}</p>
          <h3>Billing Account</h3>
        </div>
        <span class="status muted">${escapeHtml(account.billingMode)}</span>
      </div>
      <div class="detail-grid">
        ${renderDetail("Account ID", account.billingAccountId)}
        ${renderDetail("Provider", account.provider)}
        ${renderDetail("Provider Customer", account.providerCustomerId ?? "none")}
        ${renderDetail("Plan Version", account.currentPlanVersionId ?? summary.planSnapshot.planVersionId)}
      </div>
    </section>
    ${renderBillingUsagePanel(summary, monthlyUsage)}
    ${renderSubscriptionSummary(subscription, summary.subscriptionItems)}
    ${renderCreditGrantRows(summary.creditGrants)}
    ${renderInvoiceRows(summary.invoices)}
    ${renderMeterEventRows(meterEvents)}
  `;
}

/** Renders billing risk banners for support and customer status. */
function renderBillingAlerts(
  summary: AdminBillingSummary,
  monthlyUsage: AdminUsageSummary | undefined,
  reconciliation: AdminBillingReconciliationSummary | undefined,
): string {
  const alerts: string[] = [];
  const account = summary.billingAccount;
  const unpaidInvoices = summary.invoices.filter(
    (invoice) => invoice.amountRemainingMicros > 0 || invoiceStatusNeedsAttention(invoice.status),
  );
  const reviewCreditUsage = monthlyUsage
    ? usageQuantity(monthlyUsage, "review.credit", "credit")
    : 0;
  const reviewCreditLimit = numericLimit(
    summary.planSnapshot.limits["reviews.max_monthly_review_credits"],
  );

  if (paymentNeedsAttention(account.paymentStatus)) {
    alerts.push(
      `<p class="error-line">Payment status is ${escapeHtml(account.paymentStatus)}. Product access decisions may deny paid features until the provider state recovers.</p>`,
    );
  }
  if (subscriptionStatusNeedsAttention(summary.subscription?.status)) {
    alerts.push(
      `<p class="notice warning">Subscription status is ${escapeHtml(summary.subscription?.status ?? "none")}. Confirm provider state before changing plan access manually.</p>`,
    );
  }
  if (unpaidInvoices.length > 0) {
    alerts.push(
      `<p class="notice warning">${unpaidInvoices.length} invoice${unpaidInvoices.length === 1 ? "" : "s"} need attention.</p>`,
    );
  }
  if (quotaNeedsAttention(reviewCreditUsage, reviewCreditLimit)) {
    alerts.push(
      `<p class="notice warning">Monthly review credit usage is at ${formatPercent(quotaRatio(reviewCreditUsage, reviewCreditLimit))} of the plan limit.</p>`,
    );
  }
  if (reconciliation) {
    const criticalIssues = reconciliation.issues.filter(
      (issue) => issue.severity === "critical",
    ).length;
    const warningIssues = reconciliation.issues.length - criticalIssues;
    if (criticalIssues > 0) {
      alerts.push(
        `<p class="error-line">Billing reconciliation found ${criticalIssues} critical issue${criticalIssues === 1 ? "" : "s"}.</p>`,
      );
    } else if (warningIssues > 0) {
      alerts.push(
        `<p class="notice warning">Billing reconciliation found ${warningIssues} warning${warningIssues === 1 ? "" : "s"}.</p>`,
      );
    }
  }
  if (state.billing.portalError) {
    alerts.push(`<p class="error-line">${escapeHtml(state.billing.portalError)}</p>`);
  }

  return alerts.length > 0 ? `<section class="alert-stack">${alerts.join("")}</section>` : "";
}

/** Renders billing drift, sync failure, and usage anomaly issues. */
function renderBillingReconciliationPanel(
  reconciliation: AdminBillingReconciliationSummary | undefined,
): string {
  if (!reconciliation) {
    return `
      <section class="panel">
        <div class="section-heading">
          <div>
            <p class="eyebrow">Reconciliation</p>
            <h3>Billing Drift</h3>
          </div>
          <span class="status muted">not loaded</span>
        </div>
        <p class="inline-empty">Refresh loads billing reconciliation state.</p>
      </section>
    `;
  }

  const criticalIssues = reconciliation.issues.filter(
    (issue) => issue.severity === "critical",
  ).length;
  const statusClassName =
    criticalIssues > 0 ? "bad" : reconciliation.issues.length > 0 ? "warn" : "ok";
  const statusLabel =
    reconciliation.issues.length === 0 ? "clear" : `${reconciliation.issues.length} issue(s)`;

  return `
    <section class="panel">
      <div class="section-heading">
        <div>
          <p class="eyebrow">${escapeHtml(formatTime(reconciliation.checkedAt))}</p>
          <h3>Billing Reconciliation</h3>
        </div>
        <div class="row-actions">
          <span class="status ${statusClassName}">${escapeHtml(statusLabel)}</span>
          <button
            class="small"
            data-action="run-billing-reconciliation"
            ${state.session?.capabilities.canManageSettings && !state.billing.reconciliationRunLoading ? "" : "disabled"}
            type="button"
          >
            ${state.billing.reconciliationRunLoading ? "Queueing..." : "Queue repair"}
          </button>
        </div>
      </div>
      ${renderBillingReconciliationRunState(state.billing)}
      <div class="detail-grid compact">
        ${renderDetail("Period", reconciliation.periodKey ?? "current")}
        ${renderDetail("Usage Window", reconciliationPeriodLabel(reconciliation))}
        ${renderDetail("Critical", String(criticalIssues))}
        ${renderDetail("Warnings", String(reconciliation.issues.length - criticalIssues))}
      </div>
      ${renderBillingReconciliationIssues(reconciliation.issues)}
    </section>
  `;
}

/** Renders the latest billing reconciliation run enqueue state. */
function renderBillingReconciliationRunState(billing: BillingViewState): string {
  if (billing.reconciliationRunError) {
    return `<p class="error-line">${escapeHtml(billing.reconciliationRunError)}</p>`;
  }
  if (billing.reconciliationRun) {
    return `
      <p class="notice success">
        Queued ${escapeHtml(shortHash(billing.reconciliationRun.backgroundJobId))}
        with status ${escapeHtml(billing.reconciliationRun.status)}.
      </p>
    `;
  }

  return "";
}

/** Renders billing reconciliation issue rows. */
function renderBillingReconciliationIssues(
  issues: readonly AdminBillingReconciliationIssue[],
): string {
  if (issues.length === 0) {
    return `<p class="inline-empty">No billing drift, sync lag, or usage anomalies are visible.</p>`;
  }

  return `
    <ul class="issue-list billing-issues">
      ${issues
        .map(
          (issue) => `
            <li class="${issue.severity === "critical" ? "critical" : ""}">
              <div class="issue-row-head">
                <code>${escapeHtml(issue.category)}</code>
                <span class="status ${reconciliationSeverityClass(issue.severity)}">${escapeHtml(issue.severity)}</span>
              </div>
              <strong>${escapeHtml(issue.title)}</strong>
              <span>${escapeHtml(issue.detail)}</span>
              <p class="issue-meta">
                ${escapeHtml(issue.resourceType)}
                ${issue.resourceId ? ` · ${escapeHtml(shortHash(issue.resourceId))}` : ""}
                · ${escapeHtml(formatTime(issue.occurredAt))}
              </p>
            </li>
          `,
        )
        .join("")}
    </ul>
  `;
}

/** Renders customer portal controls and the latest generated portal link. */
function renderBillingPortalPanel(billing: BillingViewState): string {
  return `
    <section class="panel">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Customer Controls</p>
          <h3>Billing Portal</h3>
        </div>
        <button
          class="small"
          data-action="create-billing-portal-session"
          ${billing.portalLoading ? "disabled" : ""}
          type="button"
        >
          ${billing.portalLoading ? "Creating..." : "Create portal link"}
        </button>
      </div>
      ${
        billing.portalUrl
          ? `
            <div class="portal-link-row">
              <a class="button-link" href="${escapeAttribute(billing.portalUrl)}" rel="noreferrer" target="_blank">
                Open portal
              </a>
              <code>${escapeHtml(shortHash(billing.portalUrl))}</code>
            </div>
          `
          : `<p class="inline-empty">Create a portal link when a customer needs to manage billing details.</p>`
      }
    </section>
  `;
}

/** Renders current-month usage against plan limits. */
function renderBillingUsagePanel(
  summary: AdminBillingSummary,
  monthlyUsage: AdminUsageSummary | undefined,
): string {
  const reviewCreditUsage = monthlyUsage
    ? usageQuantity(monthlyUsage, "review.credit", "credit")
    : 0;
  const reviewCreditLimit = numericLimit(
    summary.planSnapshot.limits["reviews.max_monthly_review_credits"],
  );
  const ratio = quotaRatio(reviewCreditUsage, reviewCreditLimit);

  return `
    <section class="panel">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Current Month</p>
          <h3>Usage and Limits</h3>
        </div>
        <span class="status ${quotaNeedsAttention(reviewCreditUsage, reviewCreditLimit) ? "warn" : "ok"}">
          ${reviewCreditLimit ? formatPercent(ratio) : "unlimited"}
        </span>
      </div>
      <div class="quota-meter">
        <div>
          <strong>${formatCompactNumber(reviewCreditUsage)}</strong>
          <span>review credits used</span>
        </div>
        <div>
          <strong>${reviewCreditLimit ? formatCompactNumber(reviewCreditLimit) : "n/a"}</strong>
          <span>plan limit</span>
        </div>
        <div class="quota-track" aria-label="Monthly review credit quota">
          <span style="width: ${Math.round(Math.min(1, ratio) * 100)}%"></span>
        </div>
      </div>
      ${
        monthlyUsage && monthlyUsage.rollups.length > 0
          ? renderUsageBars(monthlyUsage.rollups)
          : `<p class="inline-empty">No current-month usage rollups are loaded for this billing scope.</p>`
      }
    </section>
  `;
}

/** Renders compact usage bars for the largest current-month usage rows. */
function renderUsageBars(rollups: readonly AdminUsageRollupSummary[]): string {
  const largestQuantity = Math.max(1, ...rollups.map((rollup) => Math.abs(rollup.quantity)));
  return `
    <div class="usage-bars">
      ${rollups
        .slice(0, 6)
        .map((rollup) => {
          const width = Math.round((Math.abs(rollup.quantity) / largestQuantity) * 100);
          return `
            <div class="usage-bar-row">
              <div>
                <strong>${escapeHtml(rollup.eventType)}</strong>
                <span>${escapeHtml(rollup.unit)}</span>
              </div>
              <div class="usage-bar-track">
                <span style="width: ${width}%"></span>
              </div>
              <code>${escapeHtml(formatCompactNumber(rollup.quantity))}</code>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

/** Renders the current subscription and item mirrors. */
function renderSubscriptionSummary(
  subscription: AdminSubscription | undefined,
  items: readonly AdminSubscriptionItem[],
): string {
  if (!subscription) {
    return `
      <section class="panel">
        <div class="section-heading">
          <h3>Current Subscription</h3>
          <span class="status muted">none</span>
        </div>
        <p class="inline-empty">This account does not have a subscription mirror.</p>
      </section>
    `;
  }

  return `
    <section class="panel">
      <div class="section-heading">
        <div>
          <p class="eyebrow">${escapeHtml(subscription.providerSubscriptionId ?? subscription.subscriptionId)}</p>
          <h3>Current Subscription</h3>
        </div>
        <span class="status ${subscriptionStatusNeedsAttention(subscription.status) ? "bad" : "ok"}">${escapeHtml(subscription.status)}</span>
      </div>
      <div class="detail-grid">
        ${renderDetail("Provider", subscription.provider)}
        ${renderDetail("Quantity", String(subscription.quantity ?? "n/a"))}
        ${renderDetail("Period", subscriptionPeriodLabel(subscription))}
        ${renderDetail("Cancel Scheduled", subscription.cancelAtPeriodEnd ? "yes" : "no")}
      </div>
      ${renderSubscriptionItemRows(items)}
    </section>
  `;
}

/** Renders subscription item rows. */
function renderSubscriptionItemRows(items: readonly AdminSubscriptionItem[]): string {
  if (items.length === 0) {
    return `<p class="inline-empty">No subscription items are mirrored.</p>`;
  }

  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Item</th>
            <th>Quantity</th>
            <th>Meter</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${items
            .map(
              (item) => `
                <tr>
                  <td><code>${escapeHtml(item.itemType)}</code></td>
                  <td>${escapeHtml(String(item.quantity ?? "n/a"))}</td>
                  <td>${escapeHtml(item.meterKey ?? "none")}</td>
                  <td><span class="status ${item.active ? "ok" : "muted"}">${item.active ? "active" : "inactive"}</span></td>
                </tr>
              `,
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

/** Renders credit grant rows. */
function renderCreditGrantRows(grants: readonly AdminCreditGrant[]): string {
  return `
    <section class="panel">
      <div class="section-heading">
        <h3>Credit Grants</h3>
        <span class="status muted">${grants.length} row${grants.length === 1 ? "" : "s"}</span>
      </div>
      ${
        grants.length === 0
          ? `<p class="inline-empty">No manual or promotional credits are mirrored.</p>`
          : `
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Credit</th>
                    <th>Remaining</th>
                    <th>Reason</th>
                    <th>Expires</th>
                  </tr>
                </thead>
                <tbody>
                  ${grants
                    .map(
                      (grant) => `
                        <tr>
                          <td><code>${escapeHtml(grant.creditType)}</code></td>
                          <td>${formatCompactNumber(grant.remainingQuantity)} / ${formatCompactNumber(grant.quantity)}</td>
                          <td>${escapeHtml(grant.reason)} <span class="status muted">${escapeHtml(grant.source)}</span></td>
                          <td>${escapeHtml(grant.expiresAt ? formatDateOnly(grant.expiresAt) : "never")}</td>
                        </tr>
                      `,
                    )
                    .join("")}
                </tbody>
              </table>
            </div>
          `
      }
    </section>
  `;
}

/** Renders invoice mirror rows. */
function renderInvoiceRows(invoices: readonly AdminInvoice[]): string {
  return `
    <section class="panel">
      <div class="section-heading">
        <h3>Invoices</h3>
        <span class="status muted">${invoices.length} row${invoices.length === 1 ? "" : "s"}</span>
      </div>
      ${
        invoices.length === 0
          ? `<p class="inline-empty">No invoice mirrors are available.</p>`
          : `
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Invoice</th>
                    <th>Status</th>
                    <th>Period</th>
                    <th>Paid</th>
                    <th>Remaining</th>
                  </tr>
                </thead>
                <tbody>
                  ${invoices
                    .map(
                      (invoice) => `
                        <tr>
                          <td>
                            ${renderInvoiceLink(invoice)}
                            <p class="muted-text">${escapeHtml(invoice.providerInvoiceId)}</p>
                            ${renderInvoicePdfLink(invoice)}
                          </td>
                          <td><span class="status ${invoiceStatusNeedsAttention(invoice.status) ? "bad" : "ok"}">${escapeHtml(invoice.status)}</span></td>
                          <td>${escapeHtml(invoicePeriodLabel(invoice))}</td>
                          <td>${formatMicros(invoice.amountPaidMicros)}</td>
                          <td>${formatMicros(invoice.amountRemainingMicros)}</td>
                        </tr>
                      `,
                    )
                    .join("")}
                </tbody>
              </table>
            </div>
          `
      }
    </section>
  `;
}

/** Renders billing meter event debug rows. */
function renderMeterEventRows(events: readonly AdminBillingMeterEventSummary[]): string {
  return `
    <section class="panel">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Provider Sync</p>
          <h3>Meter Events</h3>
        </div>
        <span class="status muted">${events.length} row${events.length === 1 ? "" : "s"}</span>
      </div>
      ${
        events.length === 0
          ? `<p class="inline-empty">No meter events matched the debug filters.</p>`
          : `
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Meter</th>
                    <th>Status</th>
                    <th>Quantity</th>
                    <th>Attempts</th>
                    <th>Updated</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  ${events
                    .map(
                      (event) => `
                        <tr>
                          <td>
                            <strong>${escapeHtml(event.meterKey)}</strong>
                            <p class="muted-text">${escapeHtml(event.periodKey)} · ${escapeHtml(event.providerEventName)}</p>
                          </td>
                          <td>
                            <span class="status ${meterEventStatusClass(event.status)}">
                              ${escapeHtml(event.status)}
                            </span>
                            ${event.lastErrorMessage ? `<p class="muted-text">${escapeHtml(event.lastErrorMessage)}</p>` : ""}
                          </td>
                          <td>${formatCompactNumber(event.quantity)}</td>
                          <td>${event.attemptCount}</td>
                          <td>${formatTime(event.updatedAt)}</td>
                          <td>
                            <code>${escapeHtml(shortHash(event.idempotencyKey))}</code>
                            <p class="muted-text">${event.sourceUsageEventIds.length} usage events</p>
                          </td>
                        </tr>
                      `,
                    )
                    .join("")}
                </tbody>
              </table>
            </div>
          `
      }
    </section>
  `;
}

/** Renders one compact label/value pair for detail grids. */
function renderDetail(label: string, value: string): string {
  return `
    <div class="detail-item">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

/** Returns a compact subscription period label. */
function subscriptionPeriodLabel(subscription: AdminSubscription): string {
  if (subscription.currentPeriodStart && subscription.currentPeriodEnd) {
    return `${formatDateOnly(subscription.currentPeriodStart)} to ${formatDateOnly(subscription.currentPeriodEnd)}`;
  }
  if (subscription.currentPeriodEnd) {
    return `Until ${formatDateOnly(subscription.currentPeriodEnd)}`;
  }

  return "n/a";
}

/** Returns a compact invoice period label. */
function invoicePeriodLabel(invoice: AdminInvoice): string {
  if (invoice.periodStart && invoice.periodEnd) {
    return `${formatDateOnly(invoice.periodStart)} to ${formatDateOnly(invoice.periodEnd)}`;
  }
  if (invoice.periodEnd) {
    return `Until ${formatDateOnly(invoice.periodEnd)}`;
  }

  return "n/a";
}

/** Returns the usage window label for a billing reconciliation report. */
function reconciliationPeriodLabel(reconciliation: AdminBillingReconciliationSummary): string {
  if (reconciliation.periodStart && reconciliation.periodEnd) {
    return `${formatDateOnly(reconciliation.periodStart)} to ${formatDateOnly(reconciliation.periodEnd)}`;
  }
  if (reconciliation.periodStart) {
    return `Since ${formatDateOnly(reconciliation.periodStart)}`;
  }

  return "not filtered";
}

/** Renders an invoice label with a link when a hosted URL exists. */
function renderInvoiceLink(invoice: AdminInvoice): string {
  if (!invoice.hostedInvoiceUrl) {
    return `<strong>${escapeHtml(invoice.invoiceId)}</strong>`;
  }

  return `
    <a href="${escapeAttribute(invoice.hostedInvoiceUrl)}" rel="noreferrer" target="_blank">
      ${escapeHtml(invoice.invoiceId)}
    </a>
  `;
}

/** Renders an invoice PDF link when the provider exposes one. */
function renderInvoicePdfLink(invoice: AdminInvoice): string {
  if (!invoice.invoicePdfUrl) {
    return "";
  }

  return `
    <a class="muted-link" href="${escapeAttribute(invoice.invoicePdfUrl)}" rel="noreferrer" target="_blank">
      PDF
    </a>
  `;
}

/** Returns whether a subscription status needs operator attention. */
function subscriptionStatusNeedsAttention(status: string | undefined): boolean {
  return status === "past_due" || status === "cancelled" || status === "unpaid";
}

/** Returns whether an invoice status needs operator attention. */
function invoiceStatusNeedsAttention(status: string): boolean {
  return status === "open" || status === "uncollectible";
}

/** Returns a status badge class for a billing meter event. */
function meterEventStatusClass(status: string): string {
  if (status === "sent") {
    return "ok";
  }
  if (status === "failed") {
    return "bad";
  }

  return "warn";
}

/** Returns a status badge class for a billing reconciliation severity. */
function reconciliationSeverityClass(severity: AdminBillingReconciliationSeverity): string {
  return severity === "critical" ? "bad" : "warn";
}

/** Renders entitlement decision rows. */
function renderEntitlementDecisionRows(decisions: readonly AdminEntitlementDecision[]): string {
  if (decisions.length === 0) {
    return `<p class="inline-empty">No feature keys were checked.</p>`;
  }

  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Feature</th>
            <th>Decision</th>
            <th>Source</th>
            <th>Value</th>
          </tr>
        </thead>
        <tbody>
          ${decisions
            .map(
              (decision) => `
                <tr>
                  <td><code>${escapeHtml(decision.featureKey)}</code></td>
                  <td>
                    <span class="status ${decision.allowed ? "ok" : "warn"}">
                      ${decision.allowed ? "allowed" : "blocked"}
                    </span>
                    <p class="muted-text">${escapeHtml(decision.reason)}</p>
                  </td>
                  <td>${escapeHtml(decision.source)}</td>
                  <td>${escapeHtml(compactJson(decision.value))}</td>
                </tr>
              `,
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

/** Renders entitlement override rows. */
function renderEntitlementRows(rows: readonly AdminEntitlementRow[]): string {
  if (rows.length === 0) {
    return `<p class="inline-empty">No entitlement overrides are active for this organization.</p>`;
  }

  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Feature</th>
            <th>State</th>
            <th>Source</th>
            <th>Effective</th>
          </tr>
        </thead>
        <tbody>
          ${rows
            .map(
              (row) => `
                <tr>
                  <td><code>${escapeHtml(row.featureKey)}</code></td>
                  <td>${row.enabled ? "enabled" : "disabled"}</td>
                  <td>${escapeHtml(row.sourceId ? `${row.source}:${row.sourceId}` : row.source)}</td>
                  <td>
                    ${formatDateOnly(row.effectiveFrom)}
                    <p class="muted-text">${escapeHtml(row.effectiveTo ? `until ${formatDateOnly(row.effectiveTo)}` : "open-ended")}</p>
                  </td>
                </tr>
              `,
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

/** Renders an audit history search view. */
function renderAuditView(): string {
  const audit = state.audit;
  return `
    <main class="inspector">
      <section class="inspector-header">
        <div>
          <p class="eyebrow">History</p>
          <h2>Audit Events</h2>
        </div>
        <button class="primary" data-action="load-audit" type="button">Search</button>
      </section>
      ${audit.loading ? `<p class="notice">${escapeHtml(audit.loading)}...</p>` : ""}
      ${audit.error ? `<p class="error-line">${escapeHtml(audit.error)}</p>` : ""}
      <section class="panel">
        <h3>Filters</h3>
        <div class="form-grid">
          ${renderTextInput("audit.search", "Search", audit.search, "keyword search")}
          ${renderTextInput("audit.action", "Action", audit.action, "repo.settings.updated")}
          ${renderTextInput("audit.resourceType", "Resource type", audit.resourceType, "repository")}
          ${renderTextInput("audit.resourceId", "Resource ID", audit.resourceId, "repo_...")}
          ${renderTextInput("audit.actorUserId", "Actor", audit.actorUserId, "oidc:...")}
          ${renderTextInput("audit.orgId", "Organization ID", audit.orgId, "org_...")}
        </div>
      </section>
      ${renderAuditRows(audit.rows)}
    </main>
  `;
}

/** Renders audit result rows. */
function renderAuditRows(rows: readonly AdminAuditLogSummary[]): string {
  if (rows.length === 0) {
    return renderEmptyState();
  }

  return `
    <section class="panel">
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Resource</th>
              <th>Request</th>
            </tr>
          </thead>
          <tbody>
            ${rows
              .map(
                (row) => `
                  <tr>
                    <td>${formatTime(row.occurredAt)}</td>
                    <td>${escapeHtml(row.actorUserId ?? row.actorType)}</td>
                    <td>${escapeHtml(row.action)}</td>
                    <td>${escapeHtml(row.resourceId ?? row.resourceType)}</td>
                    <td><code>${escapeHtml(requestIdFromMetadata(row.metadata) ?? "n/a")}</code></td>
                  </tr>
                `,
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

/** Renders a security event history search view. */
function renderSecurityEventView(): string {
  const security = state.security;
  return `
    <main class="inspector">
      <section class="inspector-header">
        <div>
          <p class="eyebrow">Security</p>
          <h2>Security Events</h2>
        </div>
        <button class="primary" data-action="load-security" type="button">Search</button>
      </section>
      ${security.loading ? `<p class="notice">${escapeHtml(security.loading)}...</p>` : ""}
      ${security.error ? `<p class="error-line">${escapeHtml(security.error)}</p>` : ""}
      <section class="panel">
        <h3>Filters</h3>
        <div class="form-grid">
          ${renderTextInput("security.search", "Search", security.search, "keyword search")}
          ${renderTextInput("security.type", "Type", security.type, "cross_tenant_access_attempt")}
          ${renderSelect(
            "security.severity",
            "Severity",
            security.severity,
            SECURITY_EVENT_SEVERITY_OPTIONS,
          )}
          ${renderSelect(
            "security.source",
            "Source",
            security.source,
            SECURITY_EVENT_SOURCE_OPTIONS,
          )}
          ${renderSelect(
            "security.status",
            "Status",
            security.status,
            SECURITY_EVENT_STATUS_OPTIONS,
          )}
          ${renderTextInput("security.actorId", "Actor", security.actorId, "oidc:...")}
          ${renderTextInput("security.resourceType", "Resource type", security.resourceType, "repository")}
          ${renderTextInput("security.resourceId", "Resource ID", security.resourceId, "repo_...")}
          ${renderTextInput("security.repoId", "Repository ID", security.repoId, "repo_...")}
          ${renderTextInput("security.orgId", "Organization ID", security.orgId, "org_...")}
        </div>
      </section>
      ${renderSecurityEventRows(security.rows)}
    </main>
  `;
}

/** Renders security event result rows. */
function renderSecurityEventRows(rows: readonly AdminSecurityEventSummary[]): string {
  if (rows.length === 0) {
    return renderEmptyState();
  }

  return `
    <section class="panel">
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Severity</th>
              <th>Status</th>
              <th>Type</th>
              <th>Actor</th>
              <th>Scope</th>
              <th>Request</th>
            </tr>
          </thead>
          <tbody>
            ${rows
              .map(
                (row) => `
                  <tr>
                    <td>${formatTime(row.createdAt)}</td>
                    <td>
                      <span class="status ${securitySeverityClass(row.severity)}">
                        ${escapeHtml(row.severity)}
                      </span>
                    </td>
                    <td><span class="status ${statusClass(row.status)}">${escapeHtml(row.status)}</span></td>
                    <td>${escapeHtml(row.type)}</td>
                    <td>${escapeHtml(row.actorId ?? "system")}</td>
                    <td>${escapeHtml(securityEventScopeLabel(row))}</td>
                    <td><code>${escapeHtml(requestIdFromMetadata(row.metadata) ?? "n/a")}</code></td>
                  </tr>
                `,
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

/** Renders one inspector tab. */
function renderTab(config: InspectorConfig): string {
  const active = state.activeKind === config.kind;
  return `
    <button class="tab ${active ? "active" : ""}" data-tab="${config.kind}" type="button">
      ${escapeHtml(config.label)}
    </button>
  `;
}

/** Renders the active inspector. */
function renderInspector(): string {
  const config = inspectorConfigs[state.activeKind];
  const inspector = currentInspectorState();
  const hasDetails = Boolean(inspector.details);
  const canPlanReplay =
    Boolean(config.replayPlanPath) && state.session?.capabilities.canPlanReplay && hasDetails;
  const canExportDebugBundle =
    Boolean(config.debugBundlePath) &&
    Boolean(state.session?.capabilities.canInspect) &&
    hasDetails;
  const canImportToEval =
    Boolean(config.evalImportPath) && Boolean(state.session?.capabilities.canInspect) && hasDetails;
  const canRunRetrievalReplay =
    Boolean(config.retrievalReplayPath) &&
    Boolean(state.session?.capabilities.canPlanReplay) &&
    hasDetails;
  const canRunValidationReplay =
    Boolean(config.validationReplayPath) &&
    Boolean(state.session?.capabilities.canPlanReplay) &&
    hasDetails;
  const canCancelJob =
    Boolean(config.cancelPath) &&
    Boolean(state.session?.capabilities.canExecuteReplay) &&
    inspector.details !== undefined &&
    isBackgroundJobDetails(inspector.details) &&
    isCancelableBackgroundJobStatus(inspector.details.job.status) &&
    inspector.cancelReasonInput.trim().length > 0;

  return `
    <main class="inspector">
      <section class="inspector-header">
        <div>
          <p class="eyebrow">${escapeHtml(config.label)} Inspector</p>
          <h2>Debug & Replay</h2>
        </div>
        <div class="resource-controls">
          <label>
            <span>${escapeHtml(config.idLabel)}</span>
            <input
              data-field="resource-id"
              placeholder="${escapeAttribute(config.placeholder)}"
              value="${escapeAttribute(inspector.id)}"
            />
          </label>
          <button class="primary" data-action="load-details" type="button">Load</button>
          ${
            config.replayPlanPath
              ? `<button
                  data-action="create-plan"
                  type="button"
                  ${canPlanReplay ? "" : "disabled"}
                >
                  Plan Replay
                </button>`
              : ""
          }
          ${
            config.debugBundlePath
              ? `<button
                  data-action="export-debug-bundle"
                  type="button"
                  ${canExportDebugBundle ? "" : "disabled"}
                >
                  Export Bundle
                </button>`
              : ""
          }
          ${
            config.evalImportPath
              ? `<button
                  data-action="import-eval"
                  type="button"
                  ${canImportToEval ? "" : "disabled"}
                >
                  Import to Eval
                </button>`
              : ""
          }
          ${
            config.retrievalReplayPath
              ? `<button
                  data-action="run-retrieval-replay"
                  type="button"
                  ${canRunRetrievalReplay ? "" : "disabled"}
                >
                  Retrieve Dry-Run
                </button>`
              : ""
          }
          ${
            config.validationReplayPath
              ? `<button
                  data-action="run-validation-replay"
                  type="button"
                  ${canRunValidationReplay ? "" : "disabled"}
                >
                  Validate Dry-Run
                </button>`
              : ""
          }
          ${
            config.cancelPath
              ? `<label>
                  <span>Cancel reason</span>
                  <input
                    data-field="cancel-reason"
                    placeholder="Reason"
                    value="${escapeAttribute(inspector.cancelReasonInput)}"
                  />
                </label>
                <button
                  class="danger"
                  data-action="cancel-job"
                  type="button"
                  ${canCancelJob ? "" : "disabled"}
                >
                  Cancel Job
                </button>`
              : ""
          }
        </div>
      </section>
      ${renderInspectorNotice(inspector)}
      ${inspector.details ? renderDetails(inspector.details) : renderEmptyState("Enter an ID and click Load to inspect debug details.")}
      ${inspector.plan ? renderReplayPlan(inspector.plan) : ""}
      ${inspector.retrievalReplay ? renderRetrievalReplay(inspector.retrievalReplay) : ""}
      ${inspector.validationReplay ? renderValidationReplay(inspector.validationReplay) : ""}
      ${inspector.result ? renderReplayResult(inspector.result) : ""}
      ${inspector.cancelResult ? renderJobCancelResult(inspector.cancelResult) : ""}
      ${inspector.debugBundle ? renderDebugBundle(inspector.debugBundle) : ""}
      ${inspector.evalImportDraft ? renderEvalImportDraft(inspector.evalImportDraft) : ""}
    </main>
  `;
}

/** Renders current loading or error state for an inspector. */
function renderInspectorNotice(inspector: InspectorViewState): string {
  if (inspector.loading) {
    return `<p class="notice">${escapeHtml(inspector.loading)}...</p>`;
  }
  if (inspector.error) {
    return `<p class="error-line">${escapeHtml(inspector.error)}</p>`;
  }

  return "";
}

/** Renders the empty inspector state. */
function renderEmptyState(message = "No data loaded."): string {
  return `
    <section class="empty-state">
      <div class="empty-mark"></div>
      <p class="muted-text">${escapeHtml(message)}</p>
    </section>
  `;
}

/** Renders debug details for any inspector. */
function renderDetails(details: InspectorDetails): string {
  if (isWebhookDetails(details)) {
    return renderWebhookDetails(details);
  }
  if (isBackgroundJobDetails(details)) {
    return renderBackgroundJobDetails(details);
  }
  if (isReviewDetails(details)) {
    return renderReviewDetails(details);
  }
  if (isMemoryRulesDetails(details)) {
    return renderMemoryRulesDetails(details);
  }

  return renderPublisherDetails(details);
}

/** Renders durable background job debug details. */
function renderBackgroundJobDetails(details: AdminBackgroundJobDebugDetails): string {
  const job = details.job;
  return `
    <section class="summary-grid">
      ${renderMetric("Status", job.status, job.status === "failed" || job.status === "dead_lettered")}
      ${renderMetric("Queue", job.queueName)}
      ${renderMetric("Type", job.jobType)}
      ${renderMetric("Failures", String(details.failures.length), details.failures.length > 0)}
    </section>
    ${renderJobs([job])}
    ${renderFailures(details.failures)}
    ${renderAudits(details.replayAudits)}
    ${renderJsonBlock("Payload", job.payload ?? job)}
  `;
}

/** Renders webhook debug details. */
function renderWebhookDetails(details: AdminWebhookDebugDetails): string {
  const event = details.webhookEvent;
  return `
    <section class="summary-grid">
      ${renderMetric("Status", event.status)}
      ${renderMetric("Event", `${event.eventName}${event.action ? `:${event.action}` : ""}`)}
      ${renderMetric("Expected jobs", String(details.expectedJobKeys.length))}
      ${renderMetric("Failures", String(details.failures.length), details.failures.length > 0)}
    </section>
    ${renderKeyList("Expected job keys", details.expectedJobKeys)}
    ${renderFailures(details.failures)}
    ${renderJobs(details.relatedJobs)}
    ${renderAudits(details.replayAudits)}
  `;
}

/** Renders review debug details. */
function renderReviewDetails(details: AdminReviewDebugDetails): string {
  const run = details.reviewRun;
  return `
    <section class="summary-grid">
      ${renderMetric("Status", run.status)}
      ${renderMetric("Pull request", `#${run.pullRequestNumber}`)}
      ${renderMetric("Candidates", String(details.candidateFindings.length))}
      ${renderMetric("Validated", String(details.validatedFindings.length))}
      ${renderMetric("Failures", String(details.failures.length), details.failures.length > 0)}
    </section>
    <section class="split">
      ${renderTimeline(details.stageEvents)}
      ${renderSnapshot(details)}
    </section>
    ${renderCandidateFindings(details.candidateFindings)}
    ${renderValidatedFindings(details.validatedFindings)}
    ${renderReviewArtifacts(details.artifacts ?? [])}
    ${renderSandboxRuns(details.sandboxRuns ?? [])}
    ${renderReviewDependencies(details.dependencies ?? [])}
    ${renderLlmCalls(details.llmCalls ?? [])}
    ${renderFailures(details.failures)}
    ${renderJobs(details.relatedJobs)}
    ${renderAudits(details.replayAudits)}
  `;
}

/** Renders publisher debug details. */
function renderPublisherDetails(details: AdminPublisherDebugDetails): string {
  const outputCount =
    details.outputs.checkRuns.length +
    details.outputs.reviews.length +
    details.outputs.summaryComments.length +
    details.outputs.findings.length;
  return `
    <section class="summary-grid">
      ${renderMetric("Publish runs", String(details.publishRuns.length))}
      ${renderMetric("Operations", String(details.operations.length))}
      ${renderMetric("Outputs", String(outputCount))}
      ${renderMetric(
        "Reconciliation issues",
        String(details.reconciliation.issues.length),
        details.reconciliation.issues.length > 0,
      )}
      ${renderMetric("Failures", String(details.failures.length), details.failures.length > 0)}
    </section>
    ${renderReconciliation(details.reconciliation)}
    ${renderPublishRuns(details.publishRuns)}
    ${renderPublishOperations(details.operations)}
    ${renderPublisherOutputs(details.outputs)}
    ${renderFailures(details.failures)}
    ${renderJobs(details.relatedJobs)}
    ${renderAudits(details.replayAudits)}
  `;
}

/** Renders repository memory facts and effective rules. */
function renderMemoryRulesDetails(details: AdminMemoryRulesDebugDetails): string {
  const repository = details.repository;
  const enabledRuleCount = details.rules.filter((rule) => rule.enabled).length;
  const activeFactCount = details.memoryFacts.filter((fact) => fact.status === "active").length;
  const pendingCandidateCount = details.memoryCandidates.filter(
    (candidate) => candidate.status === "pending",
  ).length;
  const inspectorBusy = Boolean(state.inspectors.memory.loading);

  return `
    <section class="summary-grid">
      ${renderMetric("Repository", repository.fullName)}
      ${renderMetric("Active facts", String(activeFactCount))}
      ${renderMetric("Pending candidates", String(pendingCandidateCount))}
      ${renderMetric("Enabled rules", String(enabledRuleCount))}
      ${renderMetric("Warnings", String(details.warnings.length), details.warnings.length > 0)}
    </section>
    <section class="split">
      <section class="panel">
        <h3>Repository</h3>
        <dl class="data-list compact">
          <div><dt>Repository ID</dt><dd><code>${escapeHtml(repository.repoId)}</code></dd></div>
          <div><dt>Organization ID</dt><dd><code>${escapeHtml(repository.orgId)}</code></dd></div>
          <div><dt>Provider</dt><dd>${escapeHtml(repository.provider)}</dd></div>
          <div><dt>Default branch</dt><dd>${escapeHtml(repository.defaultBranch ?? "n/a")}</dd></div>
          <div><dt>Visibility</dt><dd>${escapeHtml(repository.visibility)}</dd></div>
          <div><dt>State</dt><dd>${escapeHtml(repository.enabled ? "enabled" : "disabled")}</dd></div>
        </dl>
      </section>
      ${renderMemoryRuleTools(details)}
    </section>
    ${renderMemoryWarnings(details.warnings)}
    ${renderMemoryCandidates(details.memoryCandidates, details.candidateActions, inspectorBusy)}
    ${renderMemoryFacts(details.memoryFacts)}
    ${renderEffectiveRules(details.rules)}
  `;
}

/** Renders memory candidate and policy tool availability. */
function renderMemoryRuleTools(details: AdminMemoryRulesDebugDetails): string {
  return `
    <section class="panel">
      <h3>Tools</h3>
      <dl class="data-list compact">
        <div>
          <dt>Candidate approval</dt>
          <dd>${details.candidateActions.canApprove ? "available" : "unavailable"}</dd>
        </div>
        <div>
          <dt>Candidate rejection</dt>
          <dd>${details.candidateActions.canReject ? "available" : "unavailable"}</dd>
        </div>
      </dl>
      <p class="muted-text">${escapeHtml(details.candidateActions.reason)}</p>
      <div class="key-list">
        ${details.evaluationTools
          .map(
            (tool) => `
              <code>${escapeHtml(`${tool.status}:${tool.label}`)}</code>
            `,
          )
          .join("")}
      </div>
    </section>
  `;
}

/** Renders memory and rules inspector warnings. */
function renderMemoryWarnings(warnings: readonly string[]): string {
  if (warnings.length === 0) {
    return "";
  }

  return `
    <section class="panel">
      <h3>Warnings</h3>
      <ul class="issue-list">
        ${warnings
          .map(
            (warning) => `
              <li>
                <code>notice</code>
                <span>${escapeHtml(warning)}</span>
              </li>
            `,
          )
          .join("")}
      </ul>
    </section>
  `;
}

/** Renders proposed memory candidate rows. */
function renderMemoryCandidates(
  candidates: readonly AdminMemoryCandidateDebugSummary[],
  actions: AdminMemoryRulesDebugDetails["candidateActions"],
  inspectorBusy: boolean,
): string {
  if (candidates.length === 0) {
    return renderEmptyState("No memory candidates currently apply to this repository.");
  }

  return `
    <section class="panel">
      <h3>Memory Candidates</h3>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Candidate</th><th>Status</th><th>Trust</th><th>Confidence</th><th>Updated</th><th>Actions</th></tr>
          </thead>
          <tbody>
            ${candidates
              .map((candidate) => renderMemoryCandidateRow(candidate, actions, inspectorBusy))
              .join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

/** Renders one memory candidate table row. */
function renderMemoryCandidateRow(
  candidate: AdminMemoryCandidateDebugSummary,
  actions: AdminMemoryRulesDebugDetails["candidateActions"],
  inspectorBusy: boolean,
): string {
  const canApprove = candidate.status === "pending" && actions.canApprove && !inspectorBusy;
  const canReject = candidate.status === "pending" && actions.canReject && !inspectorBusy;

  return `
    <tr>
      <td>
        <strong>${escapeHtml(candidate.candidateKind)}</strong>
        <p class="muted-text">${escapeHtml(candidate.proposedContent)}</p>
        <p class="muted-text">${escapeHtml(candidate.sourceKind)}${candidate.createdByLogin ? ` by ${escapeHtml(candidate.createdByLogin)}` : ""}</p>
        ${candidate.approvedMemoryFactId ? `<p class="muted-text">fact: ${escapeHtml(candidate.approvedMemoryFactId)}</p>` : ""}
        ${candidate.decidedAt ? `<p class="muted-text">decided: ${escapeHtml(formatTime(candidate.decidedAt))}</p>` : ""}
        ${candidate.proposedScopeKeys.length > 0 ? `<p class="muted-text">scope: ${escapeHtml(candidate.proposedScopeKeys.join(", "))}</p>` : ""}
        ${candidate.proposedAppliesToKeys.length > 0 ? `<p class="muted-text">applies: ${escapeHtml(candidate.proposedAppliesToKeys.join(", "))}</p>` : ""}
      </td>
      <td><span class="status ${statusClass(candidate.status)}">${escapeHtml(candidate.status)}</span></td>
      <td>${escapeHtml(candidate.trustLevel)}</td>
      <td>${Math.round(candidate.confidence * 100)}%</td>
      <td>${formatTime(candidate.updatedAt)}</td>
      <td>
        <div class="row-actions">
          <button
            class="small"
            data-action="approve-memory-candidate"
            data-memory-candidate-id="${escapeAttribute(candidate.memoryCandidateId)}"
            type="button"
            ${canApprove ? "" : "disabled"}
          >
            Approve
          </button>
          <button
            class="danger small"
            data-action="reject-memory-candidate"
            data-memory-candidate-id="${escapeAttribute(candidate.memoryCandidateId)}"
            type="button"
            ${canReject ? "" : "disabled"}
          >
            Reject
          </button>
        </div>
      </td>
    </tr>
  `;
}

/** Renders stored memory fact rows. */
function renderMemoryFacts(facts: readonly AdminMemoryFactDebugSummary[]): string {
  if (facts.length === 0) {
    return renderEmptyState("No memory facts currently apply to this repository.");
  }

  return `
    <section class="panel">
      <h3>Memory Facts</h3>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Fact</th><th>Scope</th><th>Status</th><th>Confidence</th><th>Updated</th></tr>
          </thead>
          <tbody>
            ${facts
              .map(
                (fact) => `
                  <tr>
                    <td>
                      <strong>${escapeHtml(fact.factType)}</strong>
                      <p class="muted-text">${escapeHtml(fact.body)}</p>
                      ${fact.metadataKeys.length > 0 ? `<p class="muted-text">metadata: ${escapeHtml(fact.metadataKeys.join(", "))}</p>` : ""}
                    </td>
                    <td>${escapeHtml(fact.scope)}</td>
                    <td><span class="status ${statusClass(fact.status)}">${escapeHtml(fact.status)}</span></td>
                    <td>${Math.round(fact.confidence * 100)}%</td>
                    <td>${formatTime(fact.updatedAt)}</td>
                  </tr>
                `,
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

/** Renders effective repository and organization rules. */
function renderEffectiveRules(rules: readonly AdminRepoRuleDebugSummary[]): string {
  if (rules.length === 0) {
    return renderEmptyState("No repository or organization rules currently apply.");
  }

  return `
    <section class="panel">
      <h3>Effective Rules</h3>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>State</th><th>Rule</th><th>Effect</th><th>Matcher</th><th>Priority</th></tr>
          </thead>
          <tbody>
            ${rules
              .map(
                (rule) => `
                  <tr>
                    <td><span class="status ${rule.enabled ? "ok" : "muted"}">${rule.enabled ? "enabled" : "disabled"}</span></td>
                    <td>
                      <strong>${escapeHtml(rule.name)}</strong>
                      <p class="muted-text">${escapeHtml(rule.instruction)}</p>
                      ${rule.metadataKeys.length > 0 ? `<p class="muted-text">metadata: ${escapeHtml(rule.metadataKeys.join(", "))}</p>` : ""}
                    </td>
                    <td>${escapeHtml(`${rule.scope}:${rule.effect}`)}</td>
                    <td>${escapeHtml(ruleMatcherLabel(rule))}</td>
                    <td>${rule.priority}</td>
                  </tr>
                `,
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

/** Renders one dashboard metric. */
function renderMetric(label: string, value: string, alert = false): string {
  return `
    <article class="metric ${alert ? "alert" : ""}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </article>
  `;
}

/** Renders a list of opaque keys. */
function renderKeyList(title: string, values: readonly string[]): string {
  if (values.length === 0) {
    return "";
  }

  return `
    <section class="panel">
      <h3>${escapeHtml(title)}</h3>
      <div class="key-list">
        ${values.map((value) => `<code>${escapeHtml(value)}</code>`).join("")}
      </div>
    </section>
  `;
}

/** Renders review stage events as a timeline. */
function renderTimeline(events: AdminReviewDebugDetails["stageEvents"]): string {
  return `
    <section class="panel">
      <h3>Stage timeline</h3>
      <ol class="timeline">
        ${events
          .map(
            (event) => `
              <li>
                <span class="dot ${event.status === "failed" ? "failed" : ""}"></span>
                <strong>${escapeHtml(event.stage)}</strong>
                <span>${escapeHtml(event.status)}</span>
                <time>${formatTime(event.occurredAt)}</time>
              </li>
            `,
          )
          .join("")}
      </ol>
    </section>
  `;
}

/** Renders pull request snapshot metadata for a review run. */
function renderSnapshot(details: AdminReviewDebugDetails): string {
  if (!details.snapshot) {
    return `
      <section class="panel">
        <h3>Snapshot</h3>
        <p class="muted-text">No snapshot row found.</p>
      </section>
    `;
  }

  const snapshot = details.snapshot;
  return `
    <section class="panel">
      <h3>Snapshot</h3>
      <dl class="data-list">
        <div><dt>Head</dt><dd>${escapeHtml(snapshot.headSha)}</dd></div>
        <div><dt>Base</dt><dd>${escapeHtml(snapshot.baseSha)}</dd></div>
        <div><dt>Files</dt><dd>${snapshot.changedFileCount}</dd></div>
        <div><dt>Diff hash</dt><dd>${escapeHtml(snapshot.diffHash)}</dd></div>
      </dl>
    </section>
  `;
}

/** Renders candidate finding summaries for a review. */
function renderCandidateFindings(findings: readonly AdminCandidateFindingSummary[]): string {
  if (findings.length === 0) {
    return "";
  }

  return `
    <section class="panel">
      <h3>Candidate Findings</h3>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Finding</th><th>Severity</th><th>Source</th><th>Location</th><th>Confidence</th></tr>
          </thead>
          <tbody>
            ${findings
              .map(
                (finding) => `
                  <tr>
                    <td>
                      <strong>${escapeHtml(finding.title)}</strong>
                      <p class="muted-text"><code>${escapeHtml(finding.findingId)}</code></p>
                    </td>
                    <td>${escapeHtml(finding.severity)}</td>
                    <td>${escapeHtml(`${finding.source}:${finding.sourceName}`)}</td>
                    <td>${escapeHtml(locationLabel(finding.location))}</td>
                    <td>${Math.round(finding.confidence * 100)}%</td>
                  </tr>
                `,
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

/** Renders validated finding summaries for a review. */
function renderValidatedFindings(findings: readonly AdminValidatedFindingSummary[]): string {
  if (findings.length === 0) {
    return "";
  }

  return `
    <section class="panel">
      <h3>Validated Findings</h3>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Finding</th><th>Decision</th><th>Severity</th><th>Location</th><th>Validation</th></tr>
          </thead>
          <tbody>
            ${findings
              .map(
                (finding) => `
                  <tr>
                    <td>
                      <strong>${escapeHtml(finding.title)}</strong>
                      <p class="muted-text"><code>${escapeHtml(finding.findingId)}</code></p>
                    </td>
                    <td><span class="status ${finding.decision === "publish" ? "ok" : "muted"}">${escapeHtml(finding.decision)}</span></td>
                    <td>${escapeHtml(finding.severity)}</td>
                    <td>${escapeHtml(locationLabel(finding.location))}</td>
                    <td>${escapeHtml(validationReasons(finding.validation))}</td>
                  </tr>
                `,
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

/** Renders review artifact summaries. */
function renderReviewArtifacts(artifacts: readonly AdminReviewArtifactSummary[]): string {
  if (artifacts.length === 0) {
    return "";
  }

  return `
    <section class="panel">
      <h3>Artifacts</h3>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Name</th><th>Kind</th><th>Size</th><th>URI</th><th>Created</th></tr>
          </thead>
          <tbody>
            ${artifacts
              .map(
                (artifact) => `
                  <tr>
                    <td>${escapeHtml(artifact.name)}</td>
                    <td>
                      ${escapeHtml(artifact.kind)}
                      ${renderStaticAnalysisArtifactSummary(artifact)}
                    </td>
                    <td>${formatBytes(artifact.sizeBytes)}</td>
                    <td><code>${escapeHtml(artifact.uri)}</code></td>
                    <td>${formatTime(artifact.createdAt)}</td>
                  </tr>
                `,
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

/** Renders persisted sandbox run summaries linked to a review. */
function renderSandboxRuns(runs: readonly AdminSandboxRunSummary[]): string {
  if (runs.length === 0) {
    return "";
  }

  return `
    <section class="panel">
      <h3>Sandbox Runs</h3>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Status</th><th>Runner</th><th>Tool run</th><th>Policy</th><th>Output</th><th>Artifacts</th><th>Finished</th></tr>
          </thead>
          <tbody>
            ${runs
              .map(
                (run) => `
                  <tr>
                    <td><span class="status ${statusClass(run.status)}">${escapeHtml(run.status)}</span></td>
                    <td>
                      ${escapeHtml(`${run.runnerKind}/${run.category}`)}
                      <div class="muted-text">${escapeHtml(run.trustLevel)}</div>
                    </td>
                    <td>${renderSandboxToolRunCell(run)}</td>
                    <td>${renderSandboxPolicyCell(run)}</td>
                    <td>${renderSandboxOutputCell(run)}</td>
                    <td>${renderSandboxArtifactsCell(run.artifacts)}</td>
                    <td>${run.finishedAt ? formatTime(run.finishedAt) : "n/a"}</td>
                  </tr>
                `,
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

/** Renders the sandbox tool-run identifier cell. */
function renderSandboxToolRunCell(run: AdminSandboxRunSummary): string {
  const primaryId = run.toolRunId ?? run.staticAnalysisRunId ?? run.requestId;
  const secondaryId = run.toolRunId
    ? (run.staticAnalysisRunId ?? run.requestId)
    : run.staticAnalysisRunId
      ? run.requestId
      : run.sandboxRunId;

  return `
    <code>${escapeHtml(shortHash(primaryId))}</code>
    <div class="muted-text">${escapeHtml(shortHash(secondaryId))}</div>
  `;
}

/** Renders product-safe sandbox policy counts. */
function renderSandboxPolicyCell(run: AdminSandboxRunSummary): string {
  const decisions = run.policyDecisionCounts;
  const decisionText = `${decisions.allowed}/${decisions.warning}/${decisions.denied}`;
  const warningText =
    run.warningCount > 0 ? `<div class="muted-text">${run.warningCount} warnings</div>` : "";

  return `${escapeHtml(decisionText)}${warningText}`;
}

/** Renders captured-output hashes and truncation state for a sandbox run. */
function renderSandboxOutputCell(run: AdminSandboxRunSummary): string {
  const stdoutLabel = run.stdoutHash ? `stdout ${shortHash(run.stdoutHash)}` : "stdout n/a";
  const stderrLabel = run.stderrHash ? `stderr ${shortHash(run.stderrHash)}` : "stderr n/a";
  const flags = [
    run.stdoutTruncated ? "stdout truncated" : undefined,
    run.stderrTruncated ? "stderr truncated" : undefined,
  ].filter((flag): flag is string => typeof flag === "string");
  const flagText =
    flags.length > 0 ? `<div class="muted-text">${escapeHtml(flags.join(", "))}</div>` : "";

  return `
    <code>${escapeHtml(stdoutLabel)}</code>
    <div><code>${escapeHtml(stderrLabel)}</code></div>
    ${flagText}
  `;
}

/** Renders sandbox artifact names without loading payload content. */
function renderSandboxArtifactsCell(artifacts: readonly AdminSandboxArtifactSummary[]): string {
  if (artifacts.length === 0) {
    return "none";
  }

  return artifacts
    .map((artifact) => {
      const size = formatBytes(artifact.sizeBytes);
      const truncated = artifact.truncated ? " truncated" : "";
      return `<code>${escapeHtml(artifact.name)}</code><div class="muted-text">${escapeHtml(`${size}${truncated}`)}</div>`;
    })
    .join("");
}

/** Renders durable dependencies attached to a review. */
function renderReviewDependencies(dependencies: readonly AdminReviewDependencySummary[]): string {
  if (dependencies.length === 0) {
    return "";
  }

  return `
    <section class="panel">
      <h3>Dependencies</h3>
      <div class="key-list">
        ${dependencies
          .map(
            (dependency) =>
              `<code>${escapeHtml(`${dependency.dependencyType}:${dependency.dependencyId}`)}</code>`,
          )
          .join("")}
      </div>
    </section>
  `;
}

/** Renders LLM call summaries linked to a review. */
function renderLlmCalls(calls: readonly AdminLlmCallSummary[]): string {
  if (calls.length === 0) {
    return "";
  }

  return `
    <section class="panel">
      <h3>Model Calls</h3>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Status</th><th>Purpose</th><th>Model</th><th>Tokens</th><th>Cost</th></tr>
          </thead>
          <tbody>
            ${calls
              .map(
                (call) => `
                  <tr>
                    <td><span class="status ${statusClass(call.status)}">${escapeHtml(call.status)}</span></td>
                    <td>${escapeHtml(call.purpose)}</td>
                    <td>${escapeHtml(`${call.provider}/${call.model}`)}</td>
                    <td>${call.inputTokens + call.outputTokens}</td>
                    <td>${formatMicros(call.costMicros)}</td>
                  </tr>
                `,
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

/** Renders publisher reconciliation state. */
function renderReconciliation(
  reconciliation: AdminPublisherDebugDetails["reconciliation"],
): string {
  return `
    <section class="panel">
      <h3>Reconciliation</h3>
      <dl class="data-list compact">
        <div><dt>Status</dt><dd>${escapeHtml(reconciliation.status)}</dd></div>
        <div><dt>Check runs</dt><dd>${reconciliation.checkRunCount}</dd></div>
        <div><dt>Reviews</dt><dd>${reconciliation.reviewCount}</dd></div>
        <div><dt>Summary comments</dt><dd>${reconciliation.summaryCommentCount}</dd></div>
        <div><dt>Published findings</dt><dd>${reconciliation.publishedFindingCount}</dd></div>
      </dl>
      ${renderIssueList(reconciliation.issues)}
    </section>
  `;
}

/** Renders durable publish run rows. */
function renderPublishRuns(publishRuns: readonly AdminPublishRunDebugSummary[]): string {
  if (publishRuns.length === 0) {
    return renderEmptyState("No durable publish run rows were found.");
  }

  return `
    <section class="panel">
      <h3>Publish Runs</h3>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Status</th><th>Publish run</th><th>Idempotency</th><th>Started</th><th>Completed</th><th>Metadata</th></tr>
          </thead>
          <tbody>
            ${publishRuns
              .map(
                (publishRun) => `
                  <tr>
                    <td><span class="status ${statusClass(publishRun.status)}">${escapeHtml(publishRun.status)}</span></td>
                    <td><code>${escapeHtml(shortHash(publishRun.publishRunId))}</code></td>
                    <td><code>${escapeHtml(shortHash(publishRun.idempotencyKey))}</code></td>
                    <td>${publishRun.startedAt ? formatTime(publishRun.startedAt) : "n/a"}</td>
                    <td>${publishRun.completedAt ? formatTime(publishRun.completedAt) : "n/a"}</td>
                    <td><code>${escapeHtml(compactJson(publishRun.metadata))}</code></td>
                  </tr>
                `,
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

/** Renders low-level publisher operation rows. */
function renderPublishOperations(operations: readonly AdminPublishOperationDebugSummary[]): string {
  if (operations.length === 0) {
    return "";
  }

  return `
    <section class="panel">
      <h3>Publish Operations</h3>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Status</th><th>Operation</th><th>Publish run</th><th>Request</th><th>Response</th><th>Created</th></tr>
          </thead>
          <tbody>
            ${operations
              .map(
                (operation) => `
                  <tr>
                    <td><span class="status ${statusClass(operation.status)}">${escapeHtml(operation.status)}</span></td>
                    <td>${escapeHtml(operation.operationType)}</td>
                    <td><code>${escapeHtml(shortHash(operation.publishRunId))}</code></td>
                    <td>${operation.requestHash ? `<code>${escapeHtml(shortHash(operation.requestHash))}</code>` : "n/a"}</td>
                    <td>${operation.responseHash ? `<code>${escapeHtml(shortHash(operation.responseHash))}</code>` : "n/a"}</td>
                    <td>${formatTime(operation.createdAt)}</td>
                  </tr>
                `,
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

/** Renders durable publisher output rows. */
function renderPublisherOutputs(outputs: AdminPublisherDebugDetails["outputs"]): string {
  const totalRows =
    outputs.checkRuns.length +
    outputs.reviews.length +
    outputs.summaryComments.length +
    outputs.findings.length;
  if (totalRows === 0) {
    return renderEmptyState("No durable publisher output rows were found.");
  }

  return [
    renderPublisherOutputTable("Check Runs", outputs.checkRuns),
    renderPublisherOutputTable("Inline Reviews", outputs.reviews),
    renderPublisherOutputTable("Summary Comments", outputs.summaryComments),
    renderPublisherOutputTable("Published Findings", outputs.findings),
  ].join("");
}

/** Renders one publisher output table. */
function renderPublisherOutputTable(
  title: string,
  rows: readonly AdminPublisherOutputDebugRow[],
): string {
  if (rows.length === 0) {
    return "";
  }

  return `
    <section class="panel">
      <h3>${escapeHtml(title)}</h3>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Status</th><th>Provider</th><th>Provider ID</th><th>Publish run</th><th>Details</th><th>When</th></tr>
          </thead>
          <tbody>
            ${rows
              .map(
                (row) => `
                  <tr>
                    <td><span class="status ${statusClass(row.status ?? "unknown")}">${escapeHtml(row.status ?? "unknown")}</span></td>
                    <td>${escapeHtml(row.provider ?? "github")}</td>
                    <td><code>${escapeHtml(shortHash(publisherOutputProviderId(row)))}</code></td>
                    <td>${row.publishRunId ? `<code>${escapeHtml(shortHash(row.publishRunId))}</code>` : "n/a"}</td>
                    <td>${escapeHtml(publisherOutputDetails(row))}</td>
                    <td>${publisherOutputTime(row)}</td>
                  </tr>
                `,
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

/** Returns the provider-visible ID for one publisher output row. */
function publisherOutputProviderId(row: AdminPublisherOutputDebugRow): string {
  return (
    row.providerCheckRunId ??
    row.providerReviewId ??
    row.providerCommentId ??
    row.findingId ??
    "n/a"
  );
}

/** Returns compact operator-facing details for one publisher output row. */
function publisherOutputDetails(row: AdminPublisherOutputDebugRow): string {
  const details = [
    row.title,
    row.conclusion ? `conclusion: ${row.conclusion}` : undefined,
    row.bodyHash ? `body: ${shortHash(row.bodyHash)}` : undefined,
    row.validatedFindingId ? `validated: ${shortHash(row.validatedFindingId)}` : undefined,
    row.failure ? `failure: ${row.failure.code}` : undefined,
  ].filter((detail): detail is string => detail !== undefined && detail.length > 0);

  return details.length > 0 ? details.join(" | ") : compactJson(row.metadata);
}

/** Returns the most relevant timestamp for one publisher output row. */
function publisherOutputTime(row: AdminPublisherOutputDebugRow): string {
  const timestamp = row.publishedAt ?? row.createdAt;
  return timestamp ? formatTime(timestamp) : "n/a";
}

/** Renders replay plan details. */
function renderReplayPlan(plan: InspectorReplayPlan): string {
  const inspector = currentInspectorState();
  return `
    <section class="replay-panel">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Replay Plan</p>
          <h3>${escapeHtml(plan.action)}</h3>
        </div>
        <span class="status warn">Confirmation required</span>
      </div>
      ${renderPlanDiff(plan)}
      <div class="confirmation">
        <label>
          <span>Confirmation token</span>
          <code>${escapeHtml(plan.confirmationToken)}</code>
        </label>
        <label>
          <span>Type token to dispatch</span>
          <input
            data-field="confirmation-token"
            value="${escapeAttribute(inspector.confirmationTokenInput)}"
          />
        </label>
        <button
          class="danger"
          data-action="execute-replay"
          ${state.session?.capabilities.canExecuteReplay ? "" : "disabled"}
          type="button"
        >
          Dispatch replay
        </button>
      </div>
    </section>
  `;
}

/** Renders retrieval replay dry-run output. */
function renderRetrievalReplay(dryRun: RetrievalReplayDryRun): string {
  const unchangedCount = retrievalReplayStatusCount(dryRun, "unchanged");
  const changedCount = retrievalReplayStatusCount(dryRun, "changed");
  const addedCount = retrievalReplayStatusCount(dryRun, "added");
  const removedCount = retrievalReplayStatusCount(dryRun, "removed");
  return `
    <section class="replay-panel">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Retrieval Replay</p>
          <h3>${escapeHtml(dryRun.reviewRunId)}</h3>
        </div>
        <span class="status ok">Dry-run</span>
      </div>
      <section class="diff-grid">
        ${renderDiffColumn("Input", [
          `snapshot: ${dryRun.pullRequestSnapshotId}`,
          `generated: ${dryRun.generatedAt}`,
        ])}
        ${renderDiffColumn("Original bundle", retrievalReplayBundleLines(dryRun.original))}
        ${renderDiffColumn("Replayed bundle", retrievalReplayBundleLines(dryRun.replayed))}
        ${renderDiffColumn("Comparison", [
          `${unchangedCount} unchanged`,
          `${changedCount} changed`,
          `${addedCount} added`,
          `${removedCount} removed`,
        ])}
      </section>
      ${renderRetrievalReplayWarnings(dryRun.warnings)}
      ${renderRetrievalReplayComparisons(dryRun.comparisons)}
    </section>
  `;
}

/** Counts retrieval replay comparisons by status. */
function retrievalReplayStatusCount(
  dryRun: RetrievalReplayDryRun,
  status: RetrievalReplayItemComparison["status"],
): number {
  return dryRun.comparisons.filter((comparison) => comparison.status === status).length;
}

/** Builds display lines for one retrieval replay bundle summary. */
function retrievalReplayBundleLines(
  bundle: RetrievalReplayBundleSummary | undefined,
): readonly string[] {
  if (!bundle) {
    return ["missing"];
  }

  return [
    `${bundle.itemCount} item(s)`,
    `${bundle.estimatedTokens} / ${bundle.maxTokens} tokens`,
    `mode: ${bundle.retrievalMode ?? "unknown"}`,
    ...(bundle.indexVersionId ? [`index: ${bundle.indexVersionId}`] : []),
  ];
}

/** Renders retrieval replay warning text. */
function renderRetrievalReplayWarnings(warnings: readonly string[]): string {
  if (warnings.length === 0) {
    return "";
  }

  return `
    <section class="warning-list">
      <h4>Warnings</h4>
      <ul>${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>
    </section>
  `;
}

/** Renders item-level retrieval replay comparisons. */
function renderRetrievalReplayComparisons(
  comparisons: readonly RetrievalReplayItemComparison[],
): string {
  if (comparisons.length === 0) {
    return `<p class="muted-text">No retrieval context items were present in either run.</p>`;
  }

  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Status</th>
            <th>Context</th>
            <th>Original</th>
            <th>Replayed</th>
          </tr>
        </thead>
        <tbody>
          ${comparisons
            .map(
              (comparison) => `
                <tr>
                  <td>${escapeHtml(comparison.status)}</td>
                  <td><code>${escapeHtml(comparison.key)}</code></td>
                  <td>${renderRetrievalReplayItemInspection(
                    comparison.originalItem,
                    retrievalReplayItemLabel(
                      comparison.originalKind,
                      comparison.originalTitle,
                      comparison.originalPriority,
                    ),
                  )}</td>
                  <td>${renderRetrievalReplayItemInspection(
                    comparison.replayedItem,
                    retrievalReplayItemLabel(
                      comparison.replayedKind,
                      comparison.replayedTitle,
                      comparison.replayedPriority,
                    ),
                  )}</td>
                </tr>
              `,
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

/** Renders an inspectable retrieval replay context item cell. */
function renderRetrievalReplayItemInspection(
  item: RetrievalReplayItemInspection | undefined,
  fallback: string,
): string {
  if (!item) {
    return `<span class="muted-text">${escapeHtml(fallback)}</span>`;
  }

  const location = retrievalReplayItemLocation(item);
  const metadata = item.metadataKeys.length > 0 ? item.metadataKeys.join(", ") : "none";

  return `
    <div class="retrieval-item-detail">
      <strong>${escapeHtml(item.title ?? item.contextItemId)}</strong>
      <span>${escapeHtml(item.kind)} / ${escapeHtml(item.source)} / priority ${item.priority} / ${item.tokenEstimate} token(s)</span>
      ${location ? `<span>${escapeHtml(location)}</span>` : ""}
      <span>${escapeHtml(item.retriever)}: ${escapeHtml(item.reason)}</span>
      ${item.score === undefined ? "" : `<span>score ${escapeHtml(item.score.toFixed(3))}</span>`}
      ${item.textPreview ? `<p>${escapeHtml(item.textPreview)}</p>` : ""}
      <span>metadata: ${escapeHtml(metadata)}</span>
    </div>
  `;
}

/** Builds a compact location label for retrieval replay item inspection. */
function retrievalReplayItemLocation(item: RetrievalReplayItemInspection): string | undefined {
  if (!item.path) {
    return undefined;
  }
  if (!item.lineRange) {
    return item.path;
  }

  return `${item.path}:${item.lineRange.startLine}-${item.lineRange.endLine}`;
}

/** Builds a compact context item label for comparison tables. */
function retrievalReplayItemLabel(
  kind: string | undefined,
  title: string | undefined,
  priority: number | undefined,
): string {
  if (!kind && !title && priority === undefined) {
    return "missing";
  }

  const priorityText = priority === undefined ? "" : ` / priority ${priority}`;
  return `${kind ?? "unknown"} / ${title ?? "untitled"}${priorityText}`;
}

/** Renders validation replay dry-run output. */
function renderValidationReplay(dryRun: ValidationReplayDryRun): string {
  const unchangedCount = validationReplayStatusCount(dryRun, "unchanged");
  const changedCount = validationReplayStatusCount(dryRun, "changed");
  const addedCount = validationReplayStatusCount(dryRun, "added");
  const removedCount = validationReplayStatusCount(dryRun, "removed");
  return `
    <section class="replay-panel">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Validation Replay</p>
          <h3>${escapeHtml(dryRun.reviewRunId)}</h3>
        </div>
        <span class="status ok">Dry-run</span>
      </div>
      <section class="diff-grid">
        ${renderDiffColumn("Input", [
          `snapshot: ${dryRun.pullRequestSnapshotId}`,
          `${dryRun.candidateFindingCount} candidate finding(s)`,
          `generated: ${dryRun.generatedAt}`,
        ])}
        ${renderDiffColumn("Original decisions", [
          `${dryRun.original.publish} publish`,
          `${dryRun.original.reject} reject`,
        ])}
        ${renderDiffColumn("Replayed decisions", [
          `${dryRun.replayed.publish} publish`,
          `${dryRun.replayed.reject} reject`,
        ])}
        ${renderDiffColumn("Comparison", [
          `${unchangedCount} unchanged`,
          `${changedCount} changed`,
          `${addedCount} added`,
          `${removedCount} removed`,
        ])}
      </section>
      ${renderValidationReplayWarnings(dryRun.warnings)}
      ${renderValidationReplayComparisons(dryRun.comparisons)}
    </section>
  `;
}

/** Counts validation replay comparisons by status. */
function validationReplayStatusCount(
  dryRun: ValidationReplayDryRun,
  status: ValidationReplayFindingComparison["status"],
): number {
  return dryRun.comparisons.filter((comparison) => comparison.status === status).length;
}

/** Renders validation replay warning text. */
function renderValidationReplayWarnings(warnings: readonly string[]): string {
  if (warnings.length === 0) {
    return "";
  }

  return `
    <section class="warning-list">
      <h4>Warnings</h4>
      <ul>${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>
    </section>
  `;
}

/** Renders finding-level validation replay comparisons. */
function renderValidationReplayComparisons(
  comparisons: readonly ValidationReplayFindingComparison[],
): string {
  if (comparisons.length === 0) {
    return `<p class="muted-text">No validation findings were present in either run.</p>`;
  }

  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Status</th>
            <th>Finding</th>
            <th>Original</th>
            <th>Replayed</th>
          </tr>
        </thead>
        <tbody>
          ${comparisons
            .map(
              (comparison) => `
                <tr>
                  <td>${escapeHtml(comparison.status)}</td>
                  <td>
                    <strong>${escapeHtml(comparison.title)}</strong>
                    <p class="muted-text">${escapeHtml(comparison.candidateFindingId ?? comparison.key)}</p>
                  </td>
                  <td>${escapeHtml(validationReplayDecisionLabel(comparison.originalDecision, comparison.originalReasons))}</td>
                  <td>${escapeHtml(validationReplayDecisionLabel(comparison.replayedDecision, comparison.replayedReasons))}</td>
                </tr>
              `,
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

/** Builds a compact validation decision label for comparison tables. */
function validationReplayDecisionLabel(
  decision: string | undefined,
  reasons: readonly string[],
): string {
  const reasonText = reasons.length > 0 ? ` (${reasons.join(", ")})` : "";
  return `${decision ?? "missing"}${reasonText}`;
}

/** Renders the current-state versus replay-plan comparison. */
function renderPlanDiff(plan: InspectorReplayPlan): string {
  if (isWebhookReplayPlan(plan)) {
    return `
      <section class="diff-grid">
        ${renderDiffColumn("Blocked jobs", plan.blockedJobIds)}
        ${renderDiffColumn("Missing jobs", plan.missingJobKeys)}
        ${renderDiffColumn(
          "Replay jobs",
          plan.jobs.map((job) => `${job.queueName} / ${job.jobType} / ${job.replayJobKey}`),
        )}
      </section>
      ${renderFailures(plan.failures)}
    `;
  }

  if (isBackgroundJobReplayPlan(plan)) {
    return `
      <section class="diff-grid">
        ${renderDiffColumn("Current status", [plan.currentStatus])}
        ${renderDiffColumn("Source job", [
          plan.backgroundJobId,
          `${plan.queueName} / ${plan.jobType}`,
        ])}
        ${renderDiffColumn("Replay jobs", [plan.job.replayJobKey])}
      </section>
      ${renderFailures(plan.failures)}
    `;
  }

  if (isReviewReplayPlan(plan)) {
    return `
      <section class="diff-grid">
        ${renderDiffColumn("Current status", [plan.currentStatus])}
        ${renderDiffColumn(
          "Related jobs",
          plan.relatedJobs.map((job) => job.backgroundJobId),
        )}
        ${renderDiffColumn("Replay jobs", [plan.job.replayJobKey])}
      </section>
      ${renderFailures(plan.failures)}
      ${renderJsonBlock("Payload", plan.payload)}
    `;
  }

  return `
    <section class="diff-grid">
      ${renderDiffColumn("Durable state", [
        plan.reconciliation.status,
        ...plan.reconciliation.issues.map((issue) => issue.code),
      ])}
      ${renderDiffColumn("Dry run", [
        `${plan.dryRun.findingCount} finding(s)`,
        `${plan.dryRun.comments.inlineCommentCount} inline comment(s)`,
        `${plan.dryRun.comments.summaryFallbackCount} summary fallback(s)`,
      ])}
      ${renderDiffColumn("Replay jobs", [plan.job.replayJobKey])}
    </section>
    ${renderIssueList(plan.reconciliation.issues)}
    ${renderJsonBlock("Payload", plan.payload)}
  `;
}

/** Renders one diff column for replay planning. */
function renderDiffColumn(title: string, values: readonly string[]): string {
  return `
    <article class="diff-column">
      <h4>${escapeHtml(title)}</h4>
      ${
        values.length === 0
          ? `<p class="muted-text">None</p>`
          : `<ul>${values.map((value) => `<li>${escapeHtml(value)}</li>`).join("")}</ul>`
      }
    </article>
  `;
}

/** Renders replay execution output. */
function renderReplayResult(result: AdminReplayExecutionResult): string {
  return `
    <section class="panel result-panel">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Replay Result</p>
          <h3>${escapeHtml(result.action)}</h3>
        </div>
        ${result.auditLogId ? `<span class="status ok">${escapeHtml(result.auditLogId)}</span>` : ""}
      </div>
      <section class="diff-grid">
        ${renderDiffColumn("Action records", [
          `action: ${result.adminActionId}`,
          `replay: ${result.replayRunId}`,
          ...(result.auditLogId ? [`audit: ${result.auditLogId}`] : []),
        ])}
        ${renderDiffColumn("Inserted job IDs", result.insertedJobIds)}
        ${renderDiffColumn("Existing job IDs", result.existingJobIds)}
        ${renderDiffColumn(
          "Final replay jobs",
          result.replayJobs.map((job) => `${job.status} / ${job.backgroundJobId}`),
        )}
      </section>
    </section>
  `;
}

/** Renders a durable background job cancellation result. */
function renderJobCancelResult(result: AdminBackgroundJobCancelResult): string {
  return `
    <section class="panel result-panel">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Cancellation Result</p>
          <h3>${escapeHtml(result.action)}</h3>
        </div>
        <span class="status ok">${escapeHtml(result.auditLogId)}</span>
      </div>
      <section class="diff-grid">
        ${renderDiffColumn("Action records", [
          `action: ${result.adminActionId}`,
          `audit: ${result.auditLogId}`,
        ])}
        ${renderDiffColumn("Status", [
          `previous: ${result.previousStatus}`,
          `current: ${result.currentStatus}`,
          `canceled: ${formatTime(result.canceledAt)}`,
        ])}
        ${renderDiffColumn("Job", [
          result.backgroundJobId,
          result.job.queueName,
          result.job.jobType,
        ])}
      </section>
      ${renderJsonBlock("Reason", { reason: result.reason })}
    </section>
  `;
}

/** Renders a redacted debug bundle export result. */
function renderDebugBundle(bundle: AdminReviewRunDebugBundle): string {
  return `
    <section class="panel result-panel">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Debug Bundle</p>
          <h3>${escapeHtml(bundle.bundleId)}</h3>
        </div>
        <span class="status ok">${escapeHtml(bundle.auditLogId)}</span>
      </div>
      <section class="diff-grid">
        ${renderDiffColumn("Bundle", [
          bundle.reviewRunId,
          bundle.repoId,
          bundle.redactionLevel,
          bundle.payloadHash,
          `export: ${bundle.debugExportId}`,
          `action: ${bundle.adminActionId}`,
        ])}
        ${renderDiffColumn("Generated", [
          formatTime(bundle.generatedAt),
          `expires: ${formatTime(bundle.expiresAt)}`,
        ])}
      </section>
      <h3>Redacted payload</h3>
      <pre>${escapeHtml(JSON.stringify(bundle.payload, null, 2))}</pre>
    </section>
  `;
}

/** Renders a generated eval import draft. */
function renderEvalImportDraft(draft: AdminReviewRunEvalImportDraft): string {
  return `
    <section class="panel result-panel">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Eval Import Draft</p>
          <h3>${escapeHtml(draft.evalCase.caseId)}</h3>
        </div>
        <span class="status ok">${escapeHtml(draft.auditLogId)}</span>
      </div>
      <section class="diff-grid">
        ${renderDiffColumn("Action records", [
          `action: ${draft.adminActionId}`,
          `audit: ${draft.auditLogId}`,
        ])}
        ${renderDiffColumn("Case", [
          draft.suiteId,
          draft.evalCase.title,
          `${draft.evalCase.expectedFindings.length} expected`,
          `${draft.evalCase.actualFindings.length} actual`,
        ])}
        ${renderDiffColumn(
          "Files",
          draft.files.map((file) => `${file.kind} / ${file.path}`),
        )}
      </section>
      ${renderIssueList(
        draft.warnings.map((warning) => ({
          code: "needs_review",
          message: warning,
          severity: "warning",
        })),
      )}
      <h3>Eval case</h3>
      <pre>${escapeHtml(JSON.stringify(draft.evalCase, null, 2))}</pre>
    </section>
  `;
}

/** Renders structured failures. */
function renderFailures(failures: readonly AdminFailureDetail[]): string {
  if (failures.length === 0) {
    return "";
  }

  return `
    <section class="panel">
      <h3>Failures</h3>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Source</th><th>Code</th><th>Message</th><th>Retryable</th></tr>
          </thead>
          <tbody>
            ${failures
              .map(
                (failure) => `
                  <tr>
                    <td>${escapeHtml(failure.source)}</td>
                    <td><code>${escapeHtml(failure.code)}</code></td>
                    <td>${escapeHtml(failure.message)}</td>
                    <td>${failure.retryable === undefined ? "" : String(failure.retryable)}</td>
                  </tr>
                `,
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

/** Renders durable background jobs. */
function renderJobs(jobs: readonly AdminBackgroundJobDebugSummary[]): string {
  if (jobs.length === 0) {
    return "";
  }

  return `
    <section class="panel">
      <h3>Durable jobs</h3>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Status</th><th>Queue</th><th>Type</th><th>Job ID</th><th>Key</th></tr>
          </thead>
          <tbody>
            ${jobs.map(renderJobRow).join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

/** Renders one durable job row. */
function renderJobRow(job: AdminBackgroundJobDebugSummary): string {
  return `
    <tr>
      <td><span class="status ${statusClass(job.status)}">${escapeHtml(job.status)}</span></td>
      <td>${escapeHtml(job.queueName)}</td>
      <td>${escapeHtml(job.jobType)}</td>
      <td><code>${escapeHtml(job.backgroundJobId)}</code></td>
      <td><code>${escapeHtml(job.jobKey)}</code></td>
    </tr>
  `;
}

/** Renders replay audit rows. */
function renderAudits(audits: readonly AdminReplayAuditSummary[]): string {
  if (audits.length === 0) {
    return "";
  }

  return `
    <section class="panel">
      <h3>Replay audit</h3>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>When</th><th>Actor</th><th>Action</th><th>Inserted jobs</th></tr>
          </thead>
          <tbody>
            ${audits
              .map(
                (audit) => `
                  <tr>
                    <td>${formatTime(audit.occurredAt)}</td>
                    <td>${escapeHtml(audit.actorUserId ?? audit.actorType)}</td>
                    <td>${escapeHtml(audit.action)}</td>
                    <td>${escapeHtml(insertedJobSummary(audit.metadata))}</td>
                  </tr>
                `,
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

/** Renders reconciliation issue rows. */
function renderIssueList(
  issues: readonly AdminPublisherDebugDetails["reconciliation"]["issues"][number][],
): string {
  if (issues.length === 0) {
    return `<p class="muted-text">No reconciliation issues.</p>`;
  }

  return `
    <ul class="issue-list">
      ${issues
        .map(
          (issue) => `
            <li>
              <code>${escapeHtml(issue.code)}</code>
              <span>${escapeHtml(issue.message)}</span>
            </li>
          `,
        )
        .join("")}
    </ul>
  `;
}

/** Renders an inspectable JSON block. */
function renderJsonBlock(title: string, value: unknown): string {
  return `
    <section class="panel">
      <h3>${escapeHtml(title)}</h3>
      <pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>
    </section>
  `;
}

/** Renders a text input for forms. */
function renderTextInput(field: string, label: string, value: string, placeholder: string): string {
  return `
    <label>
      <span>${escapeHtml(label)}</span>
      <input
        data-field="${escapeAttribute(field)}"
        placeholder="${escapeAttribute(placeholder)}"
        value="${escapeAttribute(value)}"
      />
    </label>
  `;
}

/** Renders a checkbox control. */
function renderCheckbox(field: string, label: string, checked: boolean, disabled = false): string {
  return `
    <label class="check-field">
      <input data-field="${escapeAttribute(field)}" type="checkbox" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""} />
      <span>${escapeHtml(label)}</span>
    </label>
  `;
}

/** Renders a bounded number input for forms. */
function renderNumberInput(
  field: string,
  label: string,
  value: string,
  min: string,
  max: string,
  disabled = false,
): string {
  return `
    <label>
      <span>${escapeHtml(label)}</span>
      <input
        data-field="${escapeAttribute(field)}"
        min="${escapeAttribute(min)}"
        max="${escapeAttribute(max)}"
        type="number"
        value="${escapeAttribute(value)}"
        ${disabled ? "disabled" : ""}
      />
    </label>
  `;
}

/** Renders a select control. */
function renderSelect(
  field: string,
  label: string,
  value: string,
  options: readonly string[],
  disabled = false,
): string {
  return `
    <label>
      <span>${escapeHtml(label)}</span>
      <select data-field="${escapeAttribute(field)}" ${disabled ? "disabled" : ""}>
        ${options
          .map(
            (option) => `
              <option value="${escapeAttribute(option)}" ${option === value ? "selected" : ""}>
                ${escapeHtml(option)}
              </option>
            `,
          )
          .join("")}
      </select>
    </label>
  `;
}

/** Renders a textarea control. */
function renderTextarea(field: string, label: string, value: string, disabled = false): string {
  return `
    <label>
      <span>${escapeHtml(label)}</span>
      <textarea data-field="${escapeAttribute(field)}" rows="7" ${disabled ? "disabled" : ""}>${escapeHtml(value)}</textarea>
    </label>
  `;
}

/** Returns the active inspector state. */
function currentInspectorState(): InspectorViewState {
  return state.inspectors[state.activeKind];
}

/** Updates one overview filter field. */
function updateOverviewField(field: string, value: string): void {
  if (field in state.overview) {
    (
      state.overview as Record<
        string,
        | string
        | readonly AdminRepositorySummary[]
        | readonly AdminReviewRunSummary[]
        | readonly AdminAuditLogSummary[]
        | boolean
        | undefined
      >
    )[field] = value;
  }
}

/** Updates one settings form field from an input element. */
function updateSettingsFormField(
  field: string,
  target: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
): void {
  const form = state.settings.form;
  if (!form) {
    return;
  }

  if (field === "repositoryEnabled" && target instanceof HTMLInputElement) {
    form.repositoryEnabled = target.checked;
    state.settings.preview = undefined;
    return;
  }
  if (field === "skipGeneratedFiles" && target instanceof HTMLInputElement) {
    form.skipGeneratedFiles = target.checked;
    state.settings.preview = undefined;
    return;
  }
  if (field === "skipDraftPullRequests" && target instanceof HTMLInputElement) {
    form.skipDraftPullRequests = target.checked;
    state.settings.preview = undefined;
    return;
  }
  if (field.startsWith("sandboxPolicy.")) {
    updateSandboxPolicyFormField(form.sandboxPolicy, field.slice("sandboxPolicy.".length), target);
    state.settings.preview = undefined;
    return;
  }

  if (updateSettingsScalarFormField(form, field, target.value)) {
    state.settings.preview = undefined;
  }
}

/** Updates one repository rule form field from an input element. */
function updateRuleFormField(
  field: string,
  target: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
): void {
  const form = state.settings.ruleForm;
  if (field === "enabled" && target instanceof HTMLInputElement) {
    form.enabled = target.checked;
    return;
  }

  if (field in form) {
    (form as Record<string, string | boolean>)[field] = target.value;
  }
}

/** Updates one product organization settings form field from an input element. */
function updateProductOrgSettingsFormField(
  field: string,
  target: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
): void {
  const form = state.product.orgSettings?.form;
  if (!form) {
    return;
  }

  if (isProductOrgSettingsBooleanField(field) && target instanceof HTMLInputElement) {
    form[field] = target.checked;
    return;
  }

  if (isProductOrgSettingsTextField(field)) {
    form[field] = target.value;
  }
}

/** Returns whether one organization settings field is checkbox-backed. */
function isProductOrgSettingsBooleanField(
  field: string,
): field is keyof Pick<
  ProductOrgSettingsFormState,
  | "allowMemorySuppression"
  | "allowRepoLocalConfig"
  | "allowStyleFindings"
  | "allowUserDefinedRules"
  | "enableMemoryContext"
  | "enableMemorySuppression"
  | "publishCheckRun"
  | "publishInlineComments"
  | "publishSummaryComment"
  | "requireApprovalForMemoryFacts"
  | "skipDraftPullRequests"
  | "suppressGeneratedFileFindings"
> {
  return [
    "allowMemorySuppression",
    "allowRepoLocalConfig",
    "allowStyleFindings",
    "allowUserDefinedRules",
    "enableMemoryContext",
    "enableMemorySuppression",
    "publishCheckRun",
    "publishInlineComments",
    "publishSummaryComment",
    "requireApprovalForMemoryFacts",
    "skipDraftPullRequests",
    "suppressGeneratedFileFindings",
  ].includes(field);
}

/** Returns whether one organization settings field is text/select-backed. */
function isProductOrgSettingsTextField(
  field: string,
): field is keyof Pick<
  ProductOrgSettingsFormState,
  | "allowedModelProfiles"
  | "defaultReviewPolicy"
  | "enabledActions"
  | "enabledCategories"
  | "ignoredAuthors"
  | "ignoredLabels"
  | "maxCommentsPerReview"
  | "maxMemoryFactsInContext"
  | "memoryTtlDays"
  | "minimumConfidence"
  | "requireLabel"
  | "severityThreshold"
  | "trustedFeedbackRoles"
> {
  return [
    "allowedModelProfiles",
    "defaultReviewPolicy",
    "enabledActions",
    "enabledCategories",
    "ignoredAuthors",
    "ignoredLabels",
    "maxCommentsPerReview",
    "maxMemoryFactsInContext",
    "memoryTtlDays",
    "minimumConfidence",
    "requireLabel",
    "severityThreshold",
    "trustedFeedbackRoles",
  ].includes(field);
}

/** Updates one product settings form field from an input element. */
function updateProductSettingsFormField(
  field: string,
  target: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
): void {
  const settings = state.product.repositorySettings;
  const form = settings?.form;
  if (!settings || !form) {
    return;
  }

  if (field === "repositoryEnabled" && target instanceof HTMLInputElement) {
    form.repositoryEnabled = target.checked;
    settings.preview = undefined;
    return;
  }
  if (field === "skipGeneratedFiles" && target instanceof HTMLInputElement) {
    form.skipGeneratedFiles = target.checked;
    settings.preview = undefined;
    return;
  }
  if (field === "skipDraftPullRequests" && target instanceof HTMLInputElement) {
    form.skipDraftPullRequests = target.checked;
    settings.preview = undefined;
    return;
  }
  if (field.startsWith("sandboxPolicy.")) {
    updateSandboxPolicyFormField(form.sandboxPolicy, field.slice("sandboxPolicy.".length), target);
    settings.preview = undefined;
    return;
  }

  if (updateSettingsScalarFormField(form, field, target.value)) {
    settings.preview = undefined;
  }
}

/** Updates one scalar repository settings field. */
function updateSettingsScalarFormField(
  form: SettingsFormState,
  field: string,
  value: string,
): boolean {
  switch (field) {
    case "reviewPolicy":
      form.reviewPolicy = value;
      return true;
    case "severityThreshold":
      form.severityThreshold = value;
      return true;
    case "maxCommentsPerReview":
      form.maxCommentsPerReview = value;
      return true;
    case "ignoredPaths":
      form.ignoredPaths = value;
      return true;
    case "ignoredAuthors":
      form.ignoredAuthors = value;
      return true;
    case "ignoredLabels":
      form.ignoredLabels = value;
      return true;
    case "requireLabel":
      form.requireLabel = value;
      return true;
    case "customInstructions":
      form.customInstructions = value;
      return true;
    default:
      return false;
  }
}

/** Updates one sandbox policy form field from an input element. */
function updateSandboxPolicyFormField(
  form: SandboxPolicyFormState,
  field: string,
  target: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
): void {
  if (
    (field === "enabled" ||
      field === "allowNetwork" ||
      field === "allowDependencyInstall" ||
      field === "allowCustomCommands") &&
    target instanceof HTMLInputElement
  ) {
    form[field] = target.checked;
    return;
  }

  if (field === "defaultRunner") {
    form.defaultRunner = sandboxRunnerSettingFromForm(target.value);
    return;
  }

  if (field === "minimumRunnerForForks") {
    form.minimumRunnerForForks = sandboxForkRunnerSettingFromForm(target.value);
    return;
  }

  if (field in form) {
    (form as Record<string, string | boolean>)[field] = target.value;
  }
}

/** Updates one product repository rule form field from an input element. */
function updateProductRuleFormField(
  field: string,
  target: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
): void {
  const form = state.product.repositorySettings?.ruleForm;
  if (!form) {
    return;
  }
  if (field === "enabled" && target instanceof HTMLInputElement) {
    form.enabled = target.checked;
    return;
  }

  if (field in form) {
    (form as Record<string, string | boolean>)[field] = target.value;
  }
}

/** Updates one audit filter field. */
function updateAuditField(field: string, value: string): void {
  if (field in state.audit) {
    (state.audit as Record<string, string | readonly AdminAuditLogSummary[] | undefined>)[field] =
      value;
  }
}

/** Updates one security event filter field. */
function updateSecurityEventField(field: string, value: string): void {
  if (field in state.security) {
    (state.security as Record<string, string | readonly AdminSecurityEventSummary[] | undefined>)[
      field
    ] = value;
  }
}

/** Updates one usage filter field. */
function updateUsageField(field: string, value: string): void {
  if (field in state.usage) {
    (state.usage as Record<string, string | AdminUsageSummary | undefined>)[field] = value;
  }
}

/** Updates one plan and entitlement filter field. */
function updateEntitlementsField(field: string, value: string): void {
  if (field in state.entitlements) {
    (state.entitlements as Record<string, string | AdminEntitlementSummary | undefined>)[field] =
      value;
  }
}

/** Updates one billing filter field. */
function updateBillingField(field: string, value: string): void {
  if (field in state.billing) {
    (
      state.billing as Record<
        string,
        | string
        | AdminBillingSummary
        | AdminUsageSummary
        | AdminBillingMeterEventsSummary
        | AdminBillingReconciliationSummary
        | AdminBillingReconciliationRunSummary
        | undefined
      >
    )[field] = value;
  }
}

/** Converts a loaded settings payload into editable form state. */
function settingsFormFromResponse(data: ControlPlaneSettingsResponse): SettingsFormState {
  return {
    repositoryEnabled: data.repository.enabled,
    reviewPolicy: data.settings.reviewPolicy,
    severityThreshold: data.settings.severityThreshold,
    maxCommentsPerReview: String(data.settings.maxCommentsPerReview),
    ignoredPaths: data.settings.ignoredPaths.join("\n"),
    ignoredAuthors: data.settings.ignoredAuthors.join("\n"),
    ignoredLabels: data.settings.ignoredLabels.join("\n"),
    requireLabel: data.settings.requireLabel ?? "",
    skipGeneratedFiles: data.settings.skipGeneratedFiles,
    skipDraftPullRequests: data.settings.skipDraftPullRequests,
    customInstructions: data.settings.customInstructions ?? "",
    sandboxPolicy: sandboxPolicyFormFromSettings(data.settings.sandboxPolicy),
  };
}

/** Converts the settings form into an API patch payload. */
function settingsPatchFromForm(form: SettingsFormState): Record<string, unknown> {
  return {
    repositoryEnabled: form.repositoryEnabled,
    reviewPolicy: form.reviewPolicy,
    severityThreshold: form.severityThreshold,
    maxCommentsPerReview: boundedNumber(form.maxCommentsPerReview, 0, 50),
    ignoredPaths: linesFromText(form.ignoredPaths),
    ignoredAuthors: linesFromText(form.ignoredAuthors),
    ignoredLabels: linesFromText(form.ignoredLabels),
    requireLabel: form.requireLabel.trim(),
    skipGeneratedFiles: form.skipGeneratedFiles,
    skipDraftPullRequests: form.skipDraftPullRequests,
    customInstructions: form.customInstructions.trim(),
    sandboxPolicy: sandboxPolicyPatchFromForm(form.sandboxPolicy),
  };
}

/** Converts loaded organization settings into editable form values. */
function productOrgSettingsFormFromSettings(
  settings: ProductOrgSettings,
): ProductOrgSettingsFormState {
  return {
    allowedModelProfiles: (settings.allowedModelProfiles ?? []).join("\n"),
    allowMemorySuppression: settings.allowMemorySuppression,
    allowRepoLocalConfig: settings.allowRepoLocalConfig,
    allowStyleFindings: settings.defaultFindingPolicy.allowStyleFindings,
    allowUserDefinedRules: settings.allowUserDefinedRules,
    defaultReviewPolicy: settings.defaultReviewPolicy,
    enableMemoryContext: settings.defaultMemoryPolicy.enableMemoryContext,
    enableMemorySuppression: settings.defaultMemoryPolicy.enableMemorySuppression,
    enabledActions: settings.defaultTriggerPolicy.enabledActions.join("\n"),
    enabledCategories: settings.defaultFindingPolicy.enabledCategories.join("\n"),
    ignoredAuthors: settings.defaultTriggerPolicy.ignoredAuthors.join("\n"),
    ignoredLabels: settings.defaultTriggerPolicy.ignoredLabels.join("\n"),
    maxCommentsPerReview: String(settings.defaultFindingPolicy.maxCommentsPerReview),
    maxMemoryFactsInContext: String(settings.defaultMemoryPolicy.maxMemoryFactsInContext),
    memoryTtlDays:
      settings.defaultMemoryPolicy.memoryTtlDays === undefined
        ? ""
        : String(settings.defaultMemoryPolicy.memoryTtlDays),
    minimumConfidence: String(settings.defaultFindingPolicy.minimumConfidence),
    publishCheckRun: settings.defaultPublishingPolicy.publishCheckRun,
    publishInlineComments: settings.defaultPublishingPolicy.publishInlineComments,
    publishSummaryComment: settings.defaultPublishingPolicy.publishSummaryComment,
    requireApprovalForMemoryFacts: settings.defaultMemoryPolicy.requireApprovalForMemoryFacts,
    requireLabel: settings.defaultTriggerPolicy.requireLabel ?? "",
    severityThreshold: settings.defaultFindingPolicy.severityThreshold,
    skipDraftPullRequests: settings.defaultTriggerPolicy.skipDraftPullRequests,
    suppressGeneratedFileFindings: settings.defaultFindingPolicy.suppressGeneratedFileFindings,
    trustedFeedbackRoles: settings.defaultMemoryPolicy.trustedFeedbackRoles.join("\n"),
  };
}

/** Converts the organization settings form into an API patch payload. */
function productOrgSettingsPatchFromForm(
  form: ProductOrgSettingsFormState,
): Record<string, unknown> {
  const memoryPolicy: Record<string, unknown> = {
    enableMemoryContext: form.enableMemoryContext,
    enableMemorySuppression: form.enableMemorySuppression,
    maxMemoryFactsInContext: boundedNumber(form.maxMemoryFactsInContext, 0, 20),
    requireApprovalForMemoryFacts: form.requireApprovalForMemoryFacts,
    trustedFeedbackRoles: linesFromText(form.trustedFeedbackRoles),
  };
  const memoryTtlDays = optionalBoundedNumber(form.memoryTtlDays, 1, 3650);
  if (memoryTtlDays !== undefined) {
    memoryPolicy.memoryTtlDays = memoryTtlDays;
  }

  const maxCommentsPerReview = boundedNumber(form.maxCommentsPerReview, 0, 50);
  return {
    allowedModelProfiles: linesFromText(form.allowedModelProfiles),
    allowMemorySuppression: form.allowMemorySuppression,
    allowRepoLocalConfig: form.allowRepoLocalConfig,
    allowUserDefinedRules: form.allowUserDefinedRules,
    defaultFindingPolicy: {
      allowStyleFindings: form.allowStyleFindings,
      enabledCategories: linesFromText(form.enabledCategories),
      maxCommentsPerReview,
      minimumConfidence: boundedDecimal(form.minimumConfidence, 0, 1),
      severityThreshold: form.severityThreshold,
      suppressGeneratedFileFindings: form.suppressGeneratedFileFindings,
    },
    defaultMemoryPolicy: memoryPolicy,
    defaultPublishingPolicy: {
      maxCommentsPerReview,
      publishCheckRun: form.publishCheckRun,
      publishInlineComments: form.publishInlineComments,
      publishSummaryComment: form.publishSummaryComment,
    },
    defaultReviewPolicy: form.defaultReviewPolicy,
    defaultTriggerPolicy: {
      enabledActions: linesFromText(form.enabledActions),
      ignoredAuthors: linesFromText(form.ignoredAuthors),
      ignoredLabels: linesFromText(form.ignoredLabels),
      ...(form.requireLabel.trim() ? { requireLabel: form.requireLabel.trim() } : {}),
      skipDraftPullRequests: form.skipDraftPullRequests,
    },
  };
}

/** Converts optional sandbox settings into editable form values. */
function sandboxPolicyFormFromSettings(
  settings: SandboxPolicySettings | undefined,
): SandboxPolicyFormState {
  return {
    allowCustomCommands:
      settings?.allowCustomCommands ?? DEFAULT_SANDBOX_POLICY_FORM.allowCustomCommands,
    allowDependencyInstall:
      settings?.allowDependencyInstall ?? DEFAULT_SANDBOX_POLICY_FORM.allowDependencyInstall,
    allowNetwork: settings?.allowNetwork ?? DEFAULT_SANDBOX_POLICY_FORM.allowNetwork,
    defaultRunner: settings?.defaultRunner ?? DEFAULT_SANDBOX_POLICY_FORM.defaultRunner,
    enabled: settings?.enabled ?? DEFAULT_SANDBOX_POLICY_FORM.enabled,
    maxArtifactBytes: String(
      settings?.maxArtifactBytes ?? DEFAULT_SANDBOX_POLICY_FORM.maxArtifactBytes,
    ),
    maxCpuCount: String(settings?.maxCpuCount ?? DEFAULT_SANDBOX_POLICY_FORM.maxCpuCount),
    maxMemoryBytes: String(settings?.maxMemoryBytes ?? DEFAULT_SANDBOX_POLICY_FORM.maxMemoryBytes),
    maxOutputBytes: String(settings?.maxOutputBytes ?? DEFAULT_SANDBOX_POLICY_FORM.maxOutputBytes),
    maxTimeoutMs: String(settings?.maxTimeoutMs ?? DEFAULT_SANDBOX_POLICY_FORM.maxTimeoutMs),
    minimumRunnerForForks:
      settings?.minimumRunnerForForks ?? DEFAULT_SANDBOX_POLICY_FORM.minimumRunnerForForks,
  };
}

/** Converts sandbox form values into a repository settings patch. */
function sandboxPolicyPatchFromForm(form: SandboxPolicyFormState): SandboxPolicySettings {
  return {
    allowCustomCommands: form.allowCustomCommands,
    allowDependencyInstall: form.allowDependencyInstall,
    allowNetwork: form.allowNetwork,
    defaultRunner: form.defaultRunner,
    enabled: form.enabled,
    maxArtifactBytes: boundedNumber(form.maxArtifactBytes, 0, 250_000_000),
    maxCpuCount: boundedNumber(form.maxCpuCount, 1, 16),
    maxMemoryBytes: boundedNumber(form.maxMemoryBytes, 1, 8_589_934_592),
    maxOutputBytes: boundedNumber(form.maxOutputBytes, 0, 100_000_000),
    maxTimeoutMs: boundedNumber(form.maxTimeoutMs, 1, 600_000),
    minimumRunnerForForks: form.minimumRunnerForForks,
  };
}

/** Returns a valid sandbox runner setting from form input. */
function sandboxRunnerSettingFromForm(value: string): SandboxRunnerSetting {
  return SANDBOX_RUNNER_OPTIONS.includes(value as SandboxRunnerSetting)
    ? (value as SandboxRunnerSetting)
    : DEFAULT_SANDBOX_POLICY_FORM.defaultRunner;
}

/** Returns a valid fork runner setting from form input. */
function sandboxForkRunnerSettingFromForm(value: string): SandboxForkRunnerSetting {
  return SANDBOX_FORK_RUNNER_OPTIONS.includes(value as SandboxForkRunnerSetting)
    ? (value as SandboxForkRunnerSetting)
    : DEFAULT_SANDBOX_POLICY_FORM.minimumRunnerForForks;
}

/** Creates the default repository rule form state. */
function defaultRuleForm(): RuleFormState {
  return {
    editingRuleId: "",
    name: "",
    effect: "suppress",
    priority: "500",
    enabled: true,
    matcherPaths: "",
    matcherCategories: "",
    matcherSeverities: "",
    matcherConfidenceLessThan: "",
    titleRegex: "",
    instruction: "",
  };
}

/** Converts a loaded rule row into editable form state. */
function ruleFormFromSummary(rule: AdminRepoRuleSummary): RuleFormState {
  return {
    editingRuleId: rule.ruleId,
    name: rule.name,
    effect: rule.effect,
    priority: String(rule.priority),
    enabled: rule.enabled,
    matcherPaths: (rule.matcher.paths ?? []).join("\n"),
    matcherCategories: (rule.matcher.categories ?? []).join("\n"),
    matcherSeverities: (rule.matcher.severities ?? []).join("\n"),
    matcherConfidenceLessThan:
      rule.matcher.confidenceLessThan !== undefined ? String(rule.matcher.confidenceLessThan) : "",
    titleRegex: rule.matcher.titleRegex ?? "",
    instruction: rule.instruction,
  };
}

/** Converts the repository rule form into an API request payload. */
function ruleRequestFromForm(form: RuleFormState): Record<string, unknown> {
  const matcher: Record<string, unknown> = {};
  const paths = linesFromText(form.matcherPaths);
  const categories = linesFromText(form.matcherCategories);
  const severities = linesFromText(form.matcherSeverities);
  if (paths.length > 0) {
    matcher.paths = paths;
  }
  if (categories.length > 0) {
    matcher.categories = categories;
  }
  if (severities.length > 0) {
    matcher.severities = severities;
  }
  const confidenceLessThan = optionalBoundedDecimal(form.matcherConfidenceLessThan, 0, 1);
  if (confidenceLessThan !== undefined) {
    matcher.confidenceLessThan = confidenceLessThan;
  }
  if (form.titleRegex.trim().length > 0) {
    matcher.titleRegex = form.titleRegex.trim();
  }

  return {
    name: form.name.trim(),
    effect: form.effect,
    matcher,
    instruction: form.instruction.trim(),
    priority: boundedNumber(form.priority, 0, 1000),
    enabled: form.enabled,
  };
}

/** Parses non-empty lines from textarea input. */
function linesFromText(value: string): readonly string[] {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Parses a bounded integer. */
function boundedNumber(value: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    return minimum;
  }

  return Math.min(maximum, Math.max(minimum, parsed));
}

/** Parses an optional bounded integer from a form field. */
function optionalBoundedNumber(
  value: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (!value.trim()) {
    return undefined;
  }

  return boundedNumber(value, minimum, maximum);
}

/** Parses an optional bounded decimal from a form field. */
function optionalBoundedDecimal(
  value: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (!value.trim()) {
    return undefined;
  }

  return boundedDecimal(value, minimum, maximum);
}

/** Parses a bounded decimal number. */
function boundedDecimal(value: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return minimum;
  }

  return Math.min(maximum, Math.max(minimum, parsed));
}

/** Appends a non-empty query parameter. */
function appendQueryParam(params: URLSearchParams, key: string, value: string): void {
  const trimmed = value.trim();
  if (trimmed.length > 0) {
    params.set(key, trimmed);
  }
}

/** Reads a required data attribute from a delegated action element. */
function requiredDatasetValue(element: HTMLElement, key: string): string {
  const value = element.dataset[key];
  if (!value) {
    throw new Error(`Missing data-${key} for dashboard action.`);
  }

  return value;
}

/** Reads the audit request ID from metadata. */
function requestIdFromMetadata(metadata: unknown): string | undefined {
  const record = asRecord(metadata);
  const requestId = record?.requestId;
  return typeof requestId === "string" ? requestId : undefined;
}

/** Returns a compact scope label for one security event. */
function securityEventScopeLabel(row: AdminSecurityEventSummary): string {
  const resource =
    row.resourceId && row.resourceType ? `${row.resourceType}:${row.resourceId}` : undefined;
  const scope = [row.orgId, row.repoId, resource]
    .filter((value): value is string => Boolean(value))
    .join(" / ");
  return scope.length > 0 ? scope : "global";
}

/** Returns a CSS class for security event severity. */
function securitySeverityClass(severity: string): string {
  if (severity === "critical" || severity === "high") {
    return "bad";
  }
  if (severity === "medium") {
    return "warn";
  }
  if (severity === "low" || severity === "info") {
    return "muted";
  }

  return "muted";
}

/** Returns a CSS class for a durable status. */
function statusClass(status: string): string {
  if (["active", "completed", "passed", "processed", "published", "succeeded"].includes(status)) {
    return "ok";
  }
  if (
    [
      "dead_lettered",
      "failed",
      "killed",
      "policy_denied",
      "resource_exceeded",
      "runner_error",
      "timed_out",
    ].includes(status)
  ) {
    return "bad";
  }
  if (["pending", "running", "received"].includes(status)) {
    return "warn";
  }

  return "muted";
}

/** Returns a compact inserted-job summary from audit metadata. */
function insertedJobSummary(metadata: unknown): string {
  const result = asRecord(asRecord(metadata)?.result);
  const insertedJobIds = result?.insertedJobIds;
  if (!Array.isArray(insertedJobIds)) {
    return "";
  }

  return insertedJobIds.filter((value): value is string => typeof value === "string").join(", ");
}

/** Returns a compact finding location label from an unknown location payload. */
function locationLabel(location: unknown): string {
  const record = asRecord(location);
  const path = typeof record?.path === "string" ? record.path : "unknown path";
  const line = typeof record?.line === "number" ? record.line : undefined;
  return line ? `${path}:${line}` : path;
}

/** Returns validation reason text from an unknown validation payload. */
function validationReasons(validation: unknown): string {
  const reasons = asRecord(validation)?.reasons;
  if (!Array.isArray(reasons)) {
    return "";
  }

  return reasons.filter((reason): reason is string => typeof reason === "string").join(", ");
}

/** Formats a byte count for compact tables. */
function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }

  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/** Formats a millisecond duration for dashboard metric cards. */
function formatDurationMs(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "n/a";
  }
  if (value < 1000) {
    return `${Math.round(value)} ms`;
  }

  return `${(value / 1000).toFixed(1)} s`;
}

/** Downloads a browser blob with a temporary object URL. */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** Returns a safe filename for a downloaded artifact payload. */
function artifactDownloadName(
  artifact: AdminReviewArtifactSummary | undefined,
  artifactId: string,
): string {
  const source = artifact?.name || `${artifactId}.json`;
  const baseName = source
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 120);
  const filename = baseName || artifactId;

  return filename.endsWith(".json") ? filename : `${filename}.json`;
}

/** Formats micro currency units for compact tables. */
function formatMicros(value: number): string {
  return `$${(value / 1_000_000).toFixed(4)}`;
}

/** Formats a decimal USD string for compact dashboard metric cards. */
function formatUsd(value: string | undefined): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) {
    return "n/a";
  }

  return `$${amount.toFixed(4)}`;
}

/** Formats a number for dense dashboard metrics. */
function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact" }).format(value);
}

/** Formats a ratio as a dashboard percentage. */
function formatPercent(value: number): string {
  if (!Number.isFinite(value)) {
    return "n/a";
  }

  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 0,
    style: "percent",
  }).format(value);
}

/** Formats an ISO timestamp as a date-only label. */
function formatDateOnly(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}

/** Returns the first instant of the current month as an ISO string. */
function currentMonthStartIso(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/** Returns the first instant of next month as an ISO string. */
function currentMonthEndIso(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

/** Returns the current UTC billing month key. */
function currentMonthKey(): string {
  const now = new Date();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${now.getUTCFullYear()}-${month}`;
}

/** Shortens a hash or opaque ID for compact dashboard display. */
function shortHash(value: string): string {
  if (value.length <= 18) {
    return value;
  }

  return `${value.slice(0, 10)}...${value.slice(-6)}`;
}

/** Formats an ISO timestamp for dashboard display. */
function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

/** Returns whether a payment status should be highlighted. */
function paymentNeedsAttention(status: string): boolean {
  return status === "blocked" || status === "failed" || status === "past_due";
}

/** Returns the summed quantity for a usage rollup type and optional unit. */
function usageQuantity(
  summary: AdminUsageSummary,
  eventType: string,
  unit?: string | undefined,
): number {
  return summary.rollups
    .filter((rollup) => rollup.eventType === eventType && (!unit || rollup.unit === unit))
    .reduce((sum, rollup) => sum + rollup.quantity, 0);
}

/** Parses a numeric limit from a plan snapshot value. */
function numericLimit(value: number | boolean | string | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

/** Returns used divided by limit, defaulting to zero when no finite limit exists. */
function quotaRatio(used: number, limit: number | undefined): number {
  return limit && limit > 0 ? used / limit : 0;
}

/** Returns whether quota usage should be highlighted. */
function quotaNeedsAttention(used: number, limit: number | undefined): boolean {
  return quotaRatio(used, limit) >= 0.8;
}

/** Formats small JSON-like values for dense tables. */
function compactJson(value: unknown): string {
  if (value === undefined) {
    return "n/a";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return JSON.stringify(value);
}

/** Returns the message for an unknown error. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected admin console error.";
}

/** Returns whether an error came from an unauthenticated product session check. */
function isUnauthorizedError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("HTTP 401") || error.message.includes("product_auth.unauthorized"))
  );
}

/** Maps product auth callback errors to user-facing copy. */
function authErrorMessage(code: string): string {
  if (code === "github_oauth.state_invalid") {
    return "GitHub sign-in expired. Start the login flow again.";
  }
  if (code === "github_oauth.unconfigured") {
    return "GitHub sign-in is not configured for this deployment.";
  }
  if (code.startsWith("github_oauth.")) {
    return "GitHub sign-in failed. Try again.";
  }

  return code;
}

/** Escapes text content before injecting it into HTML. */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/** Escapes input attributes before injecting them into HTML. */
function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

/** Returns object values with stable typing. */
function objectValues<T extends Record<string, unknown>>(value: T): T[keyof T][] {
  return Object.values(value) as T[keyof T][];
}

/** Narrows a string to an inspector kind. */
function isInspectorKind(value: string): value is InspectorKind {
  return (
    value === "webhook" ||
    value === "job" ||
    value === "review" ||
    value === "publisher" ||
    value === "memory"
  );
}

/** Narrows a string to a primary view kind. */
function isViewKind(value: string): value is ViewKind {
  return (
    value === "overview" ||
    value === "inspectors" ||
    value === "settings" ||
    value === "evaluation" ||
    value === "usage" ||
    value === "plan" ||
    value === "billing" ||
    value === "security" ||
    value === "audit"
  );
}

/** Narrows a string to a top-level console mode. */
function isConsoleMode(value: string): value is ConsoleMode {
  return value === "product" || value === "admin";
}

/** Narrows unknown values to object records. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Reads a string field from an unknown object record. */
function stringField(
  record: Record<string, unknown> | undefined,
  field: string,
): string | undefined {
  const value = record?.[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Narrows inspector details to webhook details. */
function isWebhookDetails(details: InspectorDetails): details is AdminWebhookDebugDetails {
  return "webhookEvent" in details;
}

/** Narrows inspector details to durable background job details. */
function isBackgroundJobDetails(
  details: InspectorDetails,
): details is AdminBackgroundJobDebugDetails {
  return "job" in details && "replayAudits" in details && "failures" in details;
}

/** Returns whether a durable background job can be canceled from the dashboard. */
function isCancelableBackgroundJobStatus(status: string): boolean {
  return status === "pending" || status === "queued" || status === "running";
}

/** Narrows inspector details to review details. */
function isReviewDetails(details: InspectorDetails): details is AdminReviewDebugDetails {
  return "reviewRun" in details;
}

/** Narrows inspector details to memory and rules details. */
function isMemoryRulesDetails(details: InspectorDetails): details is AdminMemoryRulesDebugDetails {
  return (
    "memoryFacts" in details &&
    "memoryCandidates" in details &&
    "rules" in details &&
    "repository" in details
  );
}

/** Narrows a string to a scoped API finding outcome value. */
function isProductFindingOutcomeValue(value: string): value is ProductFindingOutcomeValue {
  return PRODUCT_FINDING_OUTCOME_ACTIONS.some((action) => action.outcome === value);
}

/** Narrows replay plans to webhook replay plans. */
function isWebhookReplayPlan(plan: InspectorReplayPlan): plan is WebhookReplayPlan {
  return plan.action === "webhook.requeue_jobs";
}

/** Narrows replay plans to durable background job replay plans. */
function isBackgroundJobReplayPlan(plan: InspectorReplayPlan): plan is BackgroundJobReplayPlan {
  return plan.action === "job.requeue";
}

/** Narrows replay plans to review replay plans. */
function isReviewReplayPlan(plan: InspectorReplayPlan): plan is ReviewReplayPlan {
  return plan.action === "review.requeue";
}
