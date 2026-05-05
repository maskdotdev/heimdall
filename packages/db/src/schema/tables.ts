import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const vector = customType<{ data: number[]; driverData: string }>({
  dataType: () => "vector(1536)",
  fromDriver: (value) =>
    typeof value === "string" ? value.slice(1, -1).split(",").filter(Boolean).map(Number) : [],
  toDriver: (value) => `[${value.join(",")}]`,
});

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

/** Organizations that own installations and repositories. */
export const orgs = pgTable(
  "orgs",
  {
    orgId: text("org_id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    metadata: jsonb("metadata"),
    ...timestamps,
  },
  (table) => [uniqueIndex("orgs_slug_unique").on(table.slug)],
);

/** Provider installations such as GitHub App installations. */
export const providerInstallations = pgTable(
  "provider_installations",
  {
    installationId: text("installation_id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.orgId),
    provider: text("provider").notNull(),
    providerInstallationId: text("provider_installation_id").notNull(),
    accountLogin: text("account_login").notNull(),
    accountType: text("account_type").notNull(),
    permissions: jsonb("permissions").notNull().default(sql`'{}'::jsonb`),
    installedAt: timestamp("installed_at", { withTimezone: true }).notNull(),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    metadata: jsonb("metadata"),
  },
  (table) => [
    uniqueIndex("provider_installations_provider_external_unique").on(
      table.provider,
      table.providerInstallationId,
    ),
  ],
);

/** Provider-neutral repositories under review. */
export const repositories = pgTable(
  "repositories",
  {
    repoId: text("repo_id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.orgId),
    installationId: text("installation_id")
      .notNull()
      .references(() => providerInstallations.installationId),
    provider: text("provider").notNull(),
    providerRepoId: text("provider_repo_id").notNull(),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    fullName: text("full_name").notNull(),
    defaultBranch: text("default_branch"),
    cloneUrl: text("clone_url"),
    visibility: text("visibility").notNull(),
    isArchived: boolean("is_archived").notNull().default(false),
    isFork: boolean("is_fork").notNull().default(false),
    enabled: boolean("enabled").notNull().default(true),
    metadata: jsonb("metadata"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("repositories_provider_repo_unique").on(table.provider, table.providerRepoId),
  ],
);

/** Mutable repository review settings. */
export const repositorySettings = pgTable("repository_settings", {
  repoId: text("repo_id")
    .primaryKey()
    .references(() => repositories.repoId),
  reviewPolicy: text("review_policy").notNull(),
  severityThreshold: text("severity_threshold").notNull(),
  maxCommentsPerReview: integer("max_comments_per_review").notNull(),
  ignoredPaths: jsonb("ignored_paths").notNull().default(sql`'[]'::jsonb`),
  ignoredAuthors: jsonb("ignored_authors").notNull().default(sql`'[]'::jsonb`),
  ignoredLabels: jsonb("ignored_labels").notNull().default(sql`'[]'::jsonb`),
  requireLabel: text("require_label"),
  skipGeneratedFiles: boolean("skip_generated_files").notNull().default(true),
  skipDraftPullRequests: boolean("skip_draft_pull_requests").notNull().default(true),
  enabledLanguages: jsonb("enabled_languages"),
  customInstructions: text("custom_instructions"),
  ...timestamps,
});

/** Normalized webhook deliveries for idempotency and debugging. */
export const webhookEvents = pgTable(
  "webhook_events",
  {
    webhookEventId: text("webhook_event_id").primaryKey(),
    provider: text("provider").notNull(),
    deliveryId: text("delivery_id").notNull(),
    eventName: text("event_name").notNull(),
    action: text("action"),
    installationId: text("installation_id").references(() => providerInstallations.installationId),
    orgId: text("org_id").references(() => orgs.orgId),
    repoId: text("repo_id").references(() => repositories.repoId),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    status: text("status").notNull().default("received"),
    payloadHash: text("payload_hash").notNull(),
    payload: jsonb("payload"),
    error: jsonb("error"),
    metadata: jsonb("metadata"),
  },
  (table) => [
    uniqueIndex("webhook_events_provider_delivery_unique").on(table.provider, table.deliveryId),
  ],
);

/** Generic idempotency records for expensive or externally visible operations. */
export const idempotencyRecords = pgTable("idempotency_records", {
  idempotencyKey: text("idempotency_key").primaryKey(),
  scope: text("scope").notNull(),
  status: text("status").notNull(),
  requestHash: text("request_hash"),
  responseHash: text("response_hash"),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  metadata: jsonb("metadata"),
  ...timestamps,
});

/** Durable job metadata used for queue debugging and idempotent scheduling. */
export const backgroundJobs = pgTable(
  "background_jobs",
  {
    backgroundJobId: text("background_job_id").primaryKey(),
    queueName: text("queue_name").notNull(),
    jobKey: text("job_key").notNull(),
    jobType: text("job_type").notNull(),
    status: text("status").notNull(),
    orgId: text("org_id").references(() => orgs.orgId),
    repoId: text("repo_id").references(() => repositories.repoId),
    reviewRunId: text("review_run_id"),
    payload: jsonb("payload").notNull(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    error: jsonb("error"),
    metadata: jsonb("metadata"),
    ...timestamps,
  },
  (table) => [uniqueIndex("background_jobs_job_key_unique").on(table.queueName, table.jobKey)],
);

/** Mutable pull request state keyed by provider PR identity. */
export const pullRequests = pgTable(
  "pull_requests",
  {
    pullRequestId: text("pull_request_id").primaryKey(),
    repoId: text("repo_id")
      .notNull()
      .references(() => repositories.repoId),
    provider: text("provider").notNull(),
    providerPullRequestId: text("provider_pull_request_id").notNull(),
    pullRequestNumber: integer("pull_request_number").notNull(),
    title: text("title").notNull(),
    authorLogin: text("author_login").notNull(),
    state: text("state").notNull(),
    isDraft: boolean("is_draft").notNull().default(false),
    baseRef: text("base_ref").notNull(),
    baseSha: text("base_sha").notNull(),
    headRef: text("head_ref").notNull(),
    headSha: text("head_sha").notNull(),
    latestSnapshotId: text("latest_snapshot_id"),
    metadata: jsonb("metadata"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("pull_requests_repo_number_unique").on(table.repoId, table.pullRequestNumber),
    uniqueIndex("pull_requests_provider_id_unique").on(table.provider, table.providerPullRequestId),
  ],
);

/** Immutable imported index version metadata. */
export const codeIndexVersions = pgTable(
  "code_index_versions",
  {
    indexVersionId: text("index_version_id").primaryKey(),
    repoId: text("repo_id")
      .notNull()
      .references(() => repositories.repoId),
    commitSha: text("commit_sha").notNull(),
    indexKey: text("index_key").notNull(),
    status: text("status").notNull(),
    artifactUri: text("artifact_uri").notNull(),
    artifactHash: text("artifact_hash"),
    indexerName: text("indexer_name").notNull(),
    indexerVersion: text("indexer_version").notNull(),
    chunkerVersion: text("chunker_version").notNull(),
    fileCount: integer("file_count").notNull().default(0),
    symbolCount: integer("symbol_count").notNull().default(0),
    edgeCount: integer("edge_count").notNull().default(0),
    chunkCount: integer("chunk_count").notNull().default(0),
    embeddedChunkCount: integer("embedded_chunk_count").notNull().default(0),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    error: jsonb("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("code_index_versions_repo_commit_key_unique").on(
      table.repoId,
      table.commitSha,
      table.indexKey,
    ),
  ],
);

/** Indexed file records imported from index artifacts. */
export const indexedFiles = pgTable(
  "indexed_files",
  {
    fileId: text("file_id").primaryKey(),
    indexVersionId: text("index_version_id")
      .notNull()
      .references(() => codeIndexVersions.indexVersionId),
    repoId: text("repo_id")
      .notNull()
      .references(() => repositories.repoId),
    commitSha: text("commit_sha").notNull(),
    path: text("path").notNull(),
    language: text("language").notNull(),
    contentHash: text("content_hash").notNull(),
    sizeBytes: integer("size_bytes").notNull().default(0),
    lineCount: integer("line_count").notNull().default(0),
    isBinary: boolean("is_binary").notNull().default(false),
    isGenerated: boolean("is_generated").notNull().default(false),
    isTest: boolean("is_test").notNull().default(false),
    isVendored: boolean("is_vendored").notNull().default(false),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("indexed_files_index_path_unique").on(table.indexVersionId, table.path)],
);

/** Symbol records imported from index artifacts. */
export const symbols = pgTable("symbols", {
  symbolId: text("symbol_id").primaryKey(),
  indexVersionId: text("index_version_id")
    .notNull()
    .references(() => codeIndexVersions.indexVersionId),
  fileId: text("file_id")
    .notNull()
    .references(() => indexedFiles.fileId),
  repoId: text("repo_id")
    .notNull()
    .references(() => repositories.repoId),
  commitSha: text("commit_sha").notNull(),
  path: text("path").notNull(),
  language: text("language").notNull(),
  name: text("name").notNull(),
  qualifiedName: text("qualified_name"),
  kind: text("kind").notNull(),
  startLine: integer("start_line").notNull(),
  endLine: integer("end_line").notNull(),
  contentHash: text("content_hash").notNull(),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Graph-like relationships between indexed files, symbols, and chunks. */
export const codeEdges = pgTable("code_edges", {
  edgeId: text("edge_id").primaryKey(),
  indexVersionId: text("index_version_id")
    .notNull()
    .references(() => codeIndexVersions.indexVersionId),
  repoId: text("repo_id")
    .notNull()
    .references(() => repositories.repoId),
  commitSha: text("commit_sha").notNull(),
  fromId: text("from_id").notNull(),
  toId: text("to_id").notNull(),
  fromKind: text("from_kind").notNull(),
  toKind: text("to_kind").notNull(),
  kind: text("kind").notNull(),
  confidence: real("confidence").notNull(),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Vector-ready code chunks imported from index artifacts. */
export const codeChunks = pgTable("code_chunks", {
  chunkId: text("chunk_id").primaryKey(),
  indexVersionId: text("index_version_id")
    .notNull()
    .references(() => codeIndexVersions.indexVersionId),
  fileId: text("file_id").references(() => indexedFiles.fileId),
  symbolId: text("symbol_id").references(() => symbols.symbolId),
  repoId: text("repo_id")
    .notNull()
    .references(() => repositories.repoId),
  path: text("path").notNull(),
  startLine: integer("start_line").notNull(),
  endLine: integer("end_line").notNull(),
  contentHash: text("content_hash").notNull(),
  embeddingStatus: text("embedding_status").notNull().default("pending"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Embeddings are stored separately from chunks to allow model/dimension changes. */
export const codeChunkEmbeddings = pgTable(
  "code_chunk_embeddings",
  {
    chunkEmbeddingId: text("chunk_embedding_id").primaryKey(),
    chunkId: text("chunk_id")
      .notNull()
      .references(() => codeChunks.chunkId),
    repoId: text("repo_id")
      .notNull()
      .references(() => repositories.repoId),
    indexVersionId: text("index_version_id")
      .notNull()
      .references(() => codeIndexVersions.indexVersionId),
    embeddingModel: text("embedding_model").notNull(),
    embeddingDimension: integer("embedding_dimension").notNull().default(1536),
    embedding: vector("embedding").notNull(),
    contentHash: text("content_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("code_chunk_embeddings_chunk_model_unique").on(table.chunkId, table.embeddingModel),
  ],
);

/** Immutable pull request snapshots keyed by provider PR state. */
export const pullRequestSnapshots = pgTable(
  "pull_request_snapshots",
  {
    snapshotId: text("snapshot_id").primaryKey(),
    schemaVersion: text("schema_version").notNull(),
    provider: text("provider").notNull(),
    repoId: text("repo_id")
      .notNull()
      .references(() => repositories.repoId),
    installationId: text("installation_id")
      .notNull()
      .references(() => providerInstallations.installationId),
    providerRepoId: text("provider_repo_id").notNull(),
    providerPullRequestId: text("provider_pull_request_id").notNull(),
    pullRequestNumber: integer("pull_request_number").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    authorLogin: text("author_login").notNull(),
    authorAssociation: text("author_association"),
    state: text("state").notNull(),
    isDraft: boolean("is_draft").notNull(),
    labels: jsonb("labels").notNull().default(sql`'[]'::jsonb`),
    baseRef: text("base_ref").notNull(),
    baseSha: text("base_sha").notNull(),
    headRef: text("head_ref").notNull(),
    headSha: text("head_sha").notNull(),
    mergeBaseSha: text("merge_base_sha"),
    changedFiles: jsonb("changed_files").notNull().default(sql`'[]'::jsonb`),
    diffHash: text("diff_hash").notNull(),
    additions: integer("additions").notNull(),
    deletions: integer("deletions").notNull(),
    changedFileCount: integer("changed_file_count").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    providerMetadata: jsonb("provider_metadata"),
  },
  (table) => [
    uniqueIndex("pull_request_snapshots_repo_pr_head_unique").on(
      table.repoId,
      table.pullRequestNumber,
      table.headSha,
    ),
  ],
);

/** Mutable review run status and immutable review pointers. */
export const reviewRuns = pgTable("review_runs", {
  reviewRunId: text("review_run_id").primaryKey(),
  schemaVersion: text("schema_version").notNull(),
  repoId: text("repo_id")
    .notNull()
    .references(() => repositories.repoId),
  pullRequestSnapshotId: text("pull_request_snapshot_id")
    .notNull()
    .references(() => pullRequestSnapshots.snapshotId),
  pullRequestNumber: integer("pull_request_number").notNull(),
  baseSha: text("base_sha").notNull(),
  headSha: text("head_sha").notNull(),
  trigger: text("trigger").notNull(),
  status: text("status").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  summary: text("summary"),
  artifactRefs: jsonb("artifact_refs").notNull().default(sql`'[]'::jsonb`),
  counts: jsonb("counts").notNull(),
  error: jsonb("error"),
  metadata: jsonb("metadata"),
  ...timestamps,
});

/** Review stage events for replay/debug timelines. */
export const reviewRunStageEvents = pgTable("review_run_stage_events", {
  reviewRunStageEventId: text("review_run_stage_event_id").primaryKey(),
  reviewRunId: text("review_run_id")
    .notNull()
    .references(() => reviewRuns.reviewRunId),
  stage: text("stage").notNull(),
  status: text("status").notNull(),
  message: text("message"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  metadata: jsonb("metadata"),
});

/** Index versions and other durable inputs used by a review run. */
export const reviewRunDependencies = pgTable(
  "review_run_dependencies",
  {
    reviewRunId: text("review_run_id")
      .notNull()
      .references(() => reviewRuns.reviewRunId),
    dependencyType: text("dependency_type").notNull(),
    dependencyId: text("dependency_id").notNull(),
    metadata: jsonb("metadata"),
  },
  (table) => [
    primaryKey({ columns: [table.reviewRunId, table.dependencyType, table.dependencyId] }),
  ],
);

/** Object-storage backed artifacts attached to review runs. */
export const reviewArtifacts = pgTable(
  "review_artifacts",
  {
    reviewArtifactId: text("review_artifact_id").primaryKey(),
    reviewRunId: text("review_run_id")
      .notNull()
      .references(() => reviewRuns.reviewRunId),
    repoId: text("repo_id")
      .notNull()
      .references(() => repositories.repoId),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    uri: text("uri").notNull(),
    hash: text("hash").notNull(),
    sizeBytes: integer("size_bytes").notNull().default(0),
    classification: text("classification").notNull().default("customer_confidential"),
    retentionUntil: timestamp("retention_until", { withTimezone: true }),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("review_artifacts_run_kind_name_unique").on(
      table.reviewRunId,
      table.kind,
      table.name,
    ),
  ],
);

/** Candidate findings emitted by review passes. */
export const candidateFindings = pgTable(
  "candidate_findings",
  {
    findingId: text("finding_id").primaryKey(),
    schemaVersion: text("schema_version").notNull(),
    reviewRunId: text("review_run_id")
      .notNull()
      .references(() => reviewRuns.reviewRunId),
    source: text("source").notNull(),
    sourceName: text("source_name").notNull(),
    category: text("category").notNull(),
    severity: text("severity").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    location: jsonb("location").notNull(),
    evidence: jsonb("evidence").notNull(),
    suggestedFix: text("suggested_fix"),
    confidence: real("confidence").notNull(),
    fingerprint: text("fingerprint").notNull(),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("candidate_findings_review_fingerprint_unique").on(
      table.reviewRunId,
      table.fingerprint,
    ),
  ],
);

/** Findings after validation and ranking. */
export const validatedFindings = pgTable("validated_findings", {
  findingId: text("finding_id").primaryKey(),
  candidateFindingId: text("candidate_finding_id")
    .notNull()
    .references(() => candidateFindings.findingId),
  reviewRunId: text("review_run_id")
    .notNull()
    .references(() => reviewRuns.reviewRunId),
  decision: text("decision").notNull(),
  category: text("category").notNull(),
  severity: text("severity").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  location: jsonb("location").notNull(),
  evidence: jsonb("evidence").notNull(),
  confidence: real("confidence").notNull(),
  validation: jsonb("validation").notNull(),
  rank: integer("rank"),
  fingerprint: text("fingerprint").notNull(),
  metadata: jsonb("metadata"),
});

/** Provider publication state for validated findings. */
export const publishedFindings = pgTable("published_findings", {
  findingId: text("finding_id").primaryKey(),
  validatedFindingId: text("validated_finding_id")
    .notNull()
    .references(() => validatedFindings.findingId),
  reviewRunId: text("review_run_id")
    .notNull()
    .references(() => reviewRuns.reviewRunId),
  provider: text("provider").notNull(),
  providerCommentId: text("provider_comment_id"),
  providerReviewId: text("provider_review_id"),
  providerCheckRunId: text("provider_check_run_id"),
  location: jsonb("location").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
  status: text("status").notNull(),
  error: jsonb("error"),
  fingerprint: text("fingerprint").notNull(),
  metadata: jsonb("metadata"),
});

/** Idempotent publishing attempts for a review run. */
export const publishRuns = pgTable(
  "publish_runs",
  {
    publishRunId: text("publish_run_id").primaryKey(),
    reviewRunId: text("review_run_id")
      .notNull()
      .references(() => reviewRuns.reviewRunId),
    repoId: text("repo_id")
      .notNull()
      .references(() => repositories.repoId),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    error: jsonb("error"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("publish_runs_idempotency_unique").on(table.idempotencyKey)],
);

/** Provider review object created during publishing. */
export const publishedReviews = pgTable("published_reviews", {
  publishedReviewId: text("published_review_id").primaryKey(),
  publishRunId: text("publish_run_id")
    .notNull()
    .references(() => publishRuns.publishRunId),
  reviewRunId: text("review_run_id")
    .notNull()
    .references(() => reviewRuns.reviewRunId),
  provider: text("provider").notNull(),
  providerReviewId: text("provider_review_id").notNull(),
  status: text("status").notNull(),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Summary comments created during publishing. */
export const publishedSummaryComments = pgTable("published_summary_comments", {
  publishedSummaryCommentId: text("published_summary_comment_id").primaryKey(),
  publishRunId: text("publish_run_id")
    .notNull()
    .references(() => publishRuns.publishRunId),
  reviewRunId: text("review_run_id")
    .notNull()
    .references(() => reviewRuns.reviewRunId),
  provider: text("provider").notNull(),
  providerCommentId: text("provider_comment_id").notNull(),
  bodyHash: text("body_hash").notNull(),
  status: text("status").notNull(),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Check runs created during publishing. */
export const publishedCheckRuns = pgTable("published_check_runs", {
  publishedCheckRunId: text("published_check_run_id").primaryKey(),
  publishRunId: text("publish_run_id")
    .notNull()
    .references(() => publishRuns.publishRunId),
  reviewRunId: text("review_run_id")
    .notNull()
    .references(() => reviewRuns.reviewRunId),
  provider: text("provider").notNull(),
  providerCheckRunId: text("provider_check_run_id").notNull(),
  status: text("status").notNull(),
  conclusion: text("conclusion"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Low-level publish operation log for reconciliation. */
export const publishOperations = pgTable("publish_operations", {
  publishOperationId: text("publish_operation_id").primaryKey(),
  publishRunId: text("publish_run_id")
    .notNull()
    .references(() => publishRuns.publishRunId),
  operationType: text("operation_type").notNull(),
  status: text("status").notNull(),
  requestHash: text("request_hash"),
  responseHash: text("response_hash"),
  error: jsonb("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Feedback and outcome events for findings. */
export const findingOutcomes = pgTable("finding_outcomes", {
  findingOutcomeId: text("finding_outcome_id").primaryKey(),
  orgId: text("org_id")
    .notNull()
    .references(() => orgs.orgId),
  repoId: text("repo_id")
    .notNull()
    .references(() => repositories.repoId),
  candidateFindingId: text("candidate_finding_id").references(() => candidateFindings.findingId),
  publishedFindingId: text("published_finding_id").references(() => publishedFindings.findingId),
  outcome: text("outcome").notNull(),
  source: text("source").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** LLM call metadata and usage. */
export const llmCalls = pgTable("llm_calls", {
  llmCallId: text("llm_call_id").primaryKey(),
  orgId: text("org_id")
    .notNull()
    .references(() => orgs.orgId),
  repoId: text("repo_id").references(() => repositories.repoId),
  reviewRunId: text("review_run_id").references(() => reviewRuns.reviewRunId),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  purpose: text("purpose").notNull(),
  status: text("status").notNull(),
  promptHash: text("prompt_hash").notNull(),
  responseHash: text("response_hash"),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  costMicros: integer("cost_micros").notNull().default(0),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  error: jsonb("error"),
  metadata: jsonb("metadata"),
});

/** Links LLM calls to stored prompt/response artifacts. */
export const llmCallArtifacts = pgTable(
  "llm_call_artifacts",
  {
    llmCallId: text("llm_call_id")
      .notNull()
      .references(() => llmCalls.llmCallId),
    reviewArtifactId: text("review_artifact_id")
      .notNull()
      .references(() => reviewArtifacts.reviewArtifactId),
    artifactRole: text("artifact_role").notNull(),
  },
  (table) => [primaryKey({ columns: [table.llmCallId, table.reviewArtifactId] })],
);

/** Append-only usage ledger. */
export const usageEvents = pgTable("usage_events", {
  usageEventId: text("usage_event_id").primaryKey(),
  orgId: text("org_id")
    .notNull()
    .references(() => orgs.orgId),
  repoId: text("repo_id").references(() => repositories.repoId),
  reviewRunId: text("review_run_id").references(() => reviewRuns.reviewRunId),
  eventType: text("event_type").notNull(),
  quantity: integer("quantity").notNull(),
  unit: text("unit").notNull(),
  costMicros: integer("cost_micros").notNull().default(0),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  metadata: jsonb("metadata"),
});

/** Repository rules are useful for MVP debugging even if advanced rules ship later. */
export const repoRules = pgTable("repo_rules", {
  repoRuleId: text("repo_rule_id").primaryKey(),
  orgId: text("org_id")
    .notNull()
    .references(() => orgs.orgId),
  repoId: text("repo_id").references(() => repositories.repoId),
  scope: text("scope").notNull(),
  ruleType: text("rule_type").notNull(),
  body: text("body").notNull(),
  isEnabled: boolean("is_enabled").notNull().default(true),
  metadata: jsonb("metadata"),
  ...timestamps,
});

/** Memory facts derived from accepted feedback or configured knowledge. */
export const memoryFacts = pgTable("memory_facts", {
  memoryFactId: text("memory_fact_id").primaryKey(),
  orgId: text("org_id")
    .notNull()
    .references(() => orgs.orgId),
  repoId: text("repo_id").references(() => repositories.repoId),
  factType: text("fact_type").notNull(),
  body: text("body").notNull(),
  status: text("status").notNull(),
  confidence: real("confidence").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  metadata: jsonb("metadata"),
  ...timestamps,
});

/** Security/compliance audit trail for sensitive operations. */
export const auditLogs = pgTable("audit_logs", {
  auditLogId: text("audit_log_id").primaryKey(),
  orgId: text("org_id").references(() => orgs.orgId),
  actorType: text("actor_type").notNull(),
  actorUserId: text("actor_user_id"),
  action: text("action").notNull(),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  metadata: jsonb("metadata"),
});
