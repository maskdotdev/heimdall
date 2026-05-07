import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  numeric,
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

/** Human users who authenticate to the product dashboard. */
export const users = pgTable(
  "users",
  {
    userId: text("user_id").primaryKey(),
    primaryEmail: text("primary_email"),
    displayName: text("display_name"),
    avatarUrl: text("avatar_url"),
    metadata: jsonb("metadata"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("users_primary_email_unique")
      .on(table.primaryEmail)
      .where(sql`${table.primaryEmail} is not null`),
  ],
);

/** External identity provider accounts linked to product users. */
export const userProviderAccounts = pgTable(
  "user_provider_accounts",
  {
    userProviderAccountId: text("user_provider_account_id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.userId),
    provider: text("provider").notNull(),
    providerUserId: text("provider_user_id").notNull(),
    providerLogin: text("provider_login"),
    email: text("email"),
    metadata: jsonb("metadata"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("user_provider_accounts_provider_user_unique").on(
      table.provider,
      table.providerUserId,
    ),
    index("user_provider_accounts_user_idx").on(table.userId),
  ],
);

/** Organization memberships and product roles for authenticated users. */
export const orgMemberships = pgTable(
  "org_memberships",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.orgId),
    userId: text("user_id")
      .notNull()
      .references(() => users.userId),
    role: text("role").notNull(),
    metadata: jsonb("metadata"),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.userId] }),
    index("org_memberships_user_idx").on(table.userId),
    index("org_memberships_org_role_idx").on(table.orgId, table.role),
  ],
);

/** Opaque DB-backed sessions for product dashboard/API authentication. */
export const userSessions = pgTable(
  "user_sessions",
  {
    sessionId: text("session_id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.userId),
    sessionHash: text("session_hash").notNull(),
    selectedOrgId: text("selected_org_id").references(() => orgs.orgId),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    metadata: jsonb("metadata"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("user_sessions_hash_unique").on(table.sessionHash),
    index("user_sessions_user_id_idx").on(table.userId),
    index("user_sessions_expires_at_idx").on(table.expiresAt),
    index("user_sessions_active_idx")
      .on(table.userId, table.expiresAt)
      .where(sql`${table.revokedAt} is null`),
  ],
);

/** One-time GitHub OAuth state records used to defend login callbacks. */
export const oauthStates = pgTable(
  "oauth_states",
  {
    oauthStateId: text("oauth_state_id").primaryKey(),
    stateHash: text("state_hash").notNull(),
    redirectTo: text("redirect_to"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("oauth_states_state_hash_unique").on(table.stateHash)],
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
  sandboxPolicy: jsonb("sandbox_policy"),
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

/** Durable rollup metrics for dashboard and analytics queries. */
export const reviewRunMetrics = pgTable("review_run_metrics", {
  reviewRunId: text("review_run_id")
    .primaryKey()
    .references(() => reviewRuns.reviewRunId),
  totalDurationMs: integer("total_duration_ms"),
  snapshotDurationMs: integer("snapshot_duration_ms"),
  indexWaitDurationMs: integer("index_wait_duration_ms"),
  retrievalDurationMs: integer("retrieval_duration_ms"),
  reviewEngineDurationMs: integer("review_engine_duration_ms"),
  validationDurationMs: integer("validation_duration_ms"),
  publishingDurationMs: integer("publishing_duration_ms"),
  candidateFindings: integer("candidate_findings"),
  validatedFindings: integer("validated_findings"),
  publishedFindings: integer("published_findings"),
  rejectedFindings: integer("rejected_findings"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  estimatedCostUsd: numeric("estimated_cost_usd", { precision: 12, scale: 6 }),
  ...timestamps,
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

/** Sandbox command executions attached to review and static-analysis work. */
export const sandboxRuns = pgTable(
  "sandbox_runs",
  {
    sandboxRunId: text("sandbox_run_id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.orgId),
    repoId: text("repo_id")
      .notNull()
      .references(() => repositories.repoId),
    reviewRunId: text("review_run_id").references(() => reviewRuns.reviewRunId),
    staticAnalysisRunId: text("static_analysis_run_id"),
    toolRunId: text("tool_run_id"),
    requestId: text("request_id").notNull(),
    runnerKind: text("runner_kind").notNull(),
    trustLevel: text("trust_level").notNull(),
    category: text("category").notNull(),
    image: text("image").notNull(),
    imageDigest: text("image_digest"),
    commandJson: jsonb("command_json").notNull(),
    policyJson: jsonb("policy_json").notNull(),
    limitsJson: jsonb("limits_json").notNull(),
    status: text("status").notNull(),
    exitCode: integer("exit_code"),
    signal: text("signal"),
    stdoutHash: text("stdout_hash"),
    stderrHash: text("stderr_hash"),
    stdoutTruncated: boolean("stdout_truncated").notNull().default(false),
    stderrTruncated: boolean("stderr_truncated").notNull().default(false),
    resourceUsageJson: jsonb("resource_usage_json"),
    errorJson: jsonb("error_json"),
    warningsJson: jsonb("warnings_json").notNull().default(sql`'[]'::jsonb`),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("sandbox_runs_request_id_unique").on(table.requestId),
    index("sandbox_runs_review_run_idx").on(table.reviewRunId),
    index("sandbox_runs_repo_created_idx").on(table.repoId, table.createdAt),
    index("sandbox_runs_status_idx").on(table.status),
  ],
);

/** Artifacts collected from sandbox output directories. */
export const sandboxArtifacts = pgTable(
  "sandbox_artifacts",
  {
    sandboxArtifactId: text("sandbox_artifact_id").primaryKey(),
    sandboxRunId: text("sandbox_run_id")
      .notNull()
      .references(() => sandboxRuns.sandboxRunId, { onDelete: "cascade" }),
    name: text("name").notNull(),
    uri: text("uri").notNull(),
    sha256: text("sha256").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    contentType: text("content_type"),
    truncated: boolean("truncated").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("sandbox_artifacts_run_name_unique").on(table.sandboxRunId, table.name)],
);

/** Product-safe sandbox policy decisions emitted during planning or execution. */
export const sandboxPolicyDecisions = pgTable(
  "sandbox_policy_decisions",
  {
    sandboxPolicyDecisionId: text("sandbox_policy_decision_id").primaryKey(),
    sandboxRunId: text("sandbox_run_id")
      .notNull()
      .references(() => sandboxRuns.sandboxRunId, { onDelete: "cascade" }),
    status: text("status").notNull(),
    code: text("code").notNull(),
    message: text("message").notNull(),
    details: jsonb("details").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("sandbox_policy_decisions_run_idx").on(table.sandboxRunId)],
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

/** Product-safe validation events emitted for each candidate finding stage. */
export const findingValidationEvents = pgTable(
  "finding_validation_events",
  {
    findingValidationEventId: text("finding_validation_event_id").primaryKey(),
    reviewRunId: text("review_run_id")
      .notNull()
      .references(() => reviewRuns.reviewRunId),
    findingId: text("finding_id").references(() => validatedFindings.findingId),
    candidateFindingId: text("candidate_finding_id")
      .notNull()
      .references(() => candidateFindings.findingId),
    stage: text("stage").notNull(),
    status: text("status").notNull(),
    reason: text("reason"),
    reasons: jsonb("reasons").notNull().default(sql`'[]'::jsonb`),
    message: text("message"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("finding_validation_events_review_run_idx").on(table.reviewRunId),
    index("finding_validation_events_candidate_idx").on(table.candidateFindingId),
    index("finding_validation_events_finding_idx").on(table.findingId),
  ],
);

/** Duplicate groups discovered during validation and ranking. */
export const findingDuplicateGroups = pgTable(
  "finding_duplicate_groups",
  {
    findingDuplicateGroupId: text("finding_duplicate_group_id").primaryKey(),
    reviewRunId: text("review_run_id")
      .notNull()
      .references(() => reviewRuns.reviewRunId),
    canonicalFindingId: text("canonical_finding_id").references(() => validatedFindings.findingId),
    canonicalCandidateFindingId: text("canonical_candidate_finding_id")
      .notNull()
      .references(() => candidateFindings.findingId),
    groupKind: text("group_kind").notNull(),
    confidence: real("confidence"),
    reason: text("reason"),
    groupKey: text("group_key").notNull(),
    duplicateFindingIds: jsonb("duplicate_finding_ids").notNull().default(sql`'[]'::jsonb`),
    duplicateCandidateFindingIds: jsonb("duplicate_candidate_finding_ids")
      .notNull()
      .default(sql`'[]'::jsonb`),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("finding_duplicate_groups_review_key_unique").on(table.reviewRunId, table.groupKey),
    index("finding_duplicate_groups_review_run_idx").on(table.reviewRunId),
    index("finding_duplicate_groups_canonical_candidate_idx").on(table.canonicalCandidateFindingId),
  ],
);

/** Durable publish plans produced after validation and before publisher handoff. */
export const publishPlans = pgTable(
  "publish_plans",
  {
    publishPlanId: text("publish_plan_id").primaryKey(),
    reviewRunId: text("review_run_id")
      .notNull()
      .references(() => reviewRuns.reviewRunId),
    reviewArtifactId: text("review_artifact_id").references(() => reviewArtifacts.reviewArtifactId),
    headSha: text("head_sha").notNull(),
    mode: text("mode").notNull(),
    inlineComments: jsonb("inline_comments").notNull().default(sql`'[]'::jsonb`),
    fileComments: jsonb("file_comments").notNull().default(sql`'[]'::jsonb`),
    checkAnnotations: jsonb("check_annotations").notNull().default(sql`'[]'::jsonb`),
    summary: jsonb("summary").notNull().default(sql`'{}'::jsonb`),
    stats: jsonb("stats").notNull().default(sql`'{}'::jsonb`),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("publish_plans_review_run_unique").on(table.reviewRunId),
    index("publish_plans_review_artifact_idx").on(table.reviewArtifactId),
  ],
);

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

/** Billing plan catalog rows. */
export const billingPlans = pgTable(
  "billing_plans",
  {
    billingPlanId: text("billing_plan_id").primaryKey(),
    planKey: text("plan_key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    audience: text("audience").notNull(),
    public: boolean("public").notNull().default(false),
    active: boolean("active").notNull().default(true),
    ...timestamps,
  },
  (table) => [uniqueIndex("billing_plans_plan_key_unique").on(table.planKey)],
);

/** Versioned billing plan configuration used for stable plan snapshots. */
export const billingPlanVersions = pgTable(
  "billing_plan_versions",
  {
    billingPlanVersionId: text("billing_plan_version_id").primaryKey(),
    billingPlanId: text("billing_plan_id")
      .notNull()
      .references(() => billingPlans.billingPlanId),
    version: text("version").notNull(),
    active: boolean("active").notNull().default(true),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
    provider: text("provider"),
    providerProductId: text("provider_product_id"),
    providerBasePriceId: text("provider_base_price_id"),
    currency: text("currency").notNull().default("usd"),
    baseAmountMicros: integer("base_amount_micros"),
    billingInterval: text("billing_interval"),
    included: jsonb("included").notNull().default(sql`'{}'::jsonb`),
    limits: jsonb("limits").notNull().default(sql`'{}'::jsonb`),
    features: jsonb("features").notNull().default(sql`'{}'::jsonb`),
    overage: jsonb("overage").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("billing_plan_versions_plan_version_unique").on(table.billingPlanId, table.version),
  ],
);

/** Organization billing account mirror used for local entitlement decisions. */
export const billingAccounts = pgTable(
  "billing_accounts",
  {
    billingAccountId: text("billing_account_id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.orgId),
    billingMode: text("billing_mode").notNull(),
    status: text("status").notNull(),
    provider: text("provider").notNull().default("stripe"),
    providerCustomerId: text("provider_customer_id"),
    billingEmail: text("billing_email"),
    billingName: text("billing_name"),
    billingCountry: text("billing_country"),
    currentPlanKey: text("current_plan_key"),
    currentPlanVersionId: text("current_plan_version_id"),
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
    gracePeriodEndsAt: timestamp("grace_period_ends_at", { withTimezone: true }),
    paymentStatus: text("payment_status").notNull().default("not_required"),
    ...timestamps,
  },
  (table) => [uniqueIndex("billing_accounts_org_unique").on(table.orgId)],
);

/** Internal subscription mirror owned by one billing account. */
export const subscriptions = pgTable(
  "subscriptions",
  {
    subscriptionId: text("subscription_id").primaryKey(),
    billingAccountId: text("billing_account_id")
      .notNull()
      .references(() => billingAccounts.billingAccountId),
    provider: text("provider").notNull(),
    providerSubscriptionId: text("provider_subscription_id"),
    status: text("status").notNull(),
    billingPlanVersionId: text("billing_plan_version_id").references(
      () => billingPlanVersions.billingPlanVersionId,
    ),
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    trialStart: timestamp("trial_start", { withTimezone: true }),
    trialEnd: timestamp("trial_end", { withTimezone: true }),
    quantity: integer("quantity"),
    rawProviderStatus: jsonb("raw_provider_status").notNull().default(sql`'{}'::jsonb`),
    ...timestamps,
  },
  (table) => [
    index("subscriptions_billing_account_idx").on(table.billingAccountId),
    uniqueIndex("subscriptions_provider_subscription_unique").on(
      table.provider,
      table.providerSubscriptionId,
    ),
  ],
);

/** Internal subscription item mirror. */
export const subscriptionItems = pgTable(
  "subscription_items",
  {
    subscriptionItemId: text("subscription_item_id").primaryKey(),
    subscriptionId: text("subscription_id")
      .notNull()
      .references(() => subscriptions.subscriptionId),
    providerItemId: text("provider_item_id"),
    providerPriceId: text("provider_price_id"),
    itemType: text("item_type").notNull(),
    quantity: integer("quantity"),
    meterKey: text("meter_key"),
    active: boolean("active").notNull().default(true),
    ...timestamps,
  },
  (table) => [
    index("subscription_items_subscription_idx").on(table.subscriptionId),
    uniqueIndex("subscription_items_provider_item_unique").on(table.providerItemId),
  ],
);

/** Manual or promotional credits applied outside provider invoices. */
export const creditGrants = pgTable(
  "credit_grants",
  {
    creditGrantId: text("credit_grant_id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.orgId),
    creditType: text("credit_type").notNull(),
    quantity: integer("quantity").notNull(),
    remainingQuantity: integer("remaining_quantity").notNull(),
    reason: text("reason").notNull(),
    source: text("source").notNull(),
    sourceId: text("source_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdByUserId: text("created_by_user_id"),
    ...timestamps,
  },
  (table) => [index("credit_grants_org_idx").on(table.orgId)],
);

/** Provider invoice mirror for customer support and billing dashboards. */
export const invoices = pgTable(
  "invoices",
  {
    invoiceId: text("invoice_id").primaryKey(),
    billingAccountId: text("billing_account_id")
      .notNull()
      .references(() => billingAccounts.billingAccountId),
    provider: text("provider").notNull(),
    providerInvoiceId: text("provider_invoice_id").notNull(),
    status: text("status").notNull(),
    currency: text("currency").notNull(),
    amountDueMicros: integer("amount_due_micros").notNull().default(0),
    amountPaidMicros: integer("amount_paid_micros").notNull().default(0),
    amountRemainingMicros: integer("amount_remaining_micros").notNull().default(0),
    periodStart: timestamp("period_start", { withTimezone: true }),
    periodEnd: timestamp("period_end", { withTimezone: true }),
    hostedInvoiceUrl: text("hosted_invoice_url"),
    invoicePdfUrl: text("invoice_pdf_url"),
    rawProviderInvoice: jsonb("raw_provider_invoice").notNull().default(sql`'{}'::jsonb`),
    ...timestamps,
  },
  (table) => [
    index("invoices_billing_account_idx").on(table.billingAccountId),
    uniqueIndex("invoices_provider_invoice_unique").on(table.provider, table.providerInvoiceId),
  ],
);

/** Audit log for outbound billing provider API requests. */
export const billingProviderRequests = pgTable(
  "billing_provider_requests",
  {
    billingProviderRequestId: text("billing_provider_request_id").primaryKey(),
    orgId: text("org_id").references(() => orgs.orgId),
    billingAccountId: text("billing_account_id").references(() => billingAccounts.billingAccountId),
    provider: text("provider").notNull(),
    operation: text("operation").notNull(),
    idempotencyKey: text("idempotency_key"),
    providerRequestId: text("provider_request_id"),
    status: text("status").notNull(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    requestMetadata: jsonb("request_metadata").notNull().default(sql`'{}'::jsonb`),
    responseMetadata: jsonb("response_metadata").notNull().default(sql`'{}'::jsonb`),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("billing_provider_requests_account_idx").on(table.billingAccountId),
    index("billing_provider_requests_org_idx").on(table.orgId),
    uniqueIndex("billing_provider_requests_idempotency_unique").on(
      table.provider,
      table.idempotencyKey,
    ),
  ],
);

/** Idempotent log for inbound billing provider webhook events. */
export const billingWebhookEvents = pgTable(
  "billing_webhook_events",
  {
    billingWebhookEventId: text("billing_webhook_event_id").primaryKey(),
    provider: text("provider").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    eventType: text("event_type").notNull(),
    orgId: text("org_id").references(() => orgs.orgId),
    billingAccountId: text("billing_account_id").references(() => billingAccounts.billingAccountId),
    providerCustomerId: text("provider_customer_id"),
    providerSubscriptionId: text("provider_subscription_id"),
    status: text("status").notNull(),
    payloadHash: text("payload_hash").notNull(),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    error: jsonb("error"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("billing_webhook_events_account_idx").on(table.billingAccountId),
    index("billing_webhook_events_org_idx").on(table.orgId),
    uniqueIndex("billing_webhook_events_provider_event_unique").on(
      table.provider,
      table.providerEventId,
    ),
  ],
);

/** Planned and sent usage-based billing meter events. */
export const billingMeterEvents = pgTable(
  "billing_meter_events",
  {
    billingMeterEventId: text("billing_meter_event_id").primaryKey(),
    billingAccountId: text("billing_account_id")
      .notNull()
      .references(() => billingAccounts.billingAccountId),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.orgId),
    provider: text("provider").notNull(),
    providerCustomerId: text("provider_customer_id").notNull(),
    meterKey: text("meter_key").notNull(),
    providerEventName: text("provider_event_name").notNull(),
    periodKey: text("period_key").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    quantity: integer("quantity").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status").notNull(),
    providerMeterEventId: text("provider_meter_event_id"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    sourceUsageEventIds: jsonb("source_usage_event_ids").notNull().default(sql`'[]'::jsonb`),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("billing_meter_events_account_status_idx").on(table.billingAccountId, table.status),
    index("billing_meter_events_org_period_idx").on(table.orgId, table.periodKey),
    uniqueIndex("billing_meter_events_idempotency_unique").on(table.provider, table.idempotencyKey),
  ],
);

/** Active and historical feature entitlements for organizations. */
export const entitlements = pgTable(
  "entitlements",
  {
    entitlementId: text("entitlement_id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.orgId),
    featureKey: text("feature_key").notNull(),
    enabled: boolean("enabled").notNull(),
    source: text("source").notNull(),
    sourceId: text("source_id"),
    value: jsonb("value").notNull().default(sql`'{}'::jsonb`),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("entitlements_org_feature_source_effective_unique").on(
      table.orgId,
      table.featureKey,
      table.source,
      table.effectiveFrom,
    ),
    index("entitlements_active_idx").on(
      table.orgId,
      table.featureKey,
      table.effectiveFrom,
      table.effectiveTo,
    ),
  ],
);

/** Fast quota counter state for one organization and billing period. */
export const quotaCounters = pgTable(
  "quota_counters",
  {
    quotaCounterId: text("quota_counter_id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.orgId),
    quotaKey: text("quota_key").notNull(),
    periodKey: text("period_key").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    usedQuantity: integer("used_quantity").notNull().default(0),
    reservedQuantity: integer("reserved_quantity").notNull().default(0),
    limitQuantity: integer("limit_quantity"),
    source: text("source").notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("quota_counters_org_quota_period_unique").on(
      table.orgId,
      table.quotaKey,
      table.periodKey,
    ),
  ],
);

/** Durable quota reservations for idempotent expensive work starts. */
export const quotaReservations = pgTable(
  "quota_reservations",
  {
    quotaReservationId: text("quota_reservation_id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.orgId),
    quotaCounterId: text("quota_counter_id")
      .notNull()
      .references(() => quotaCounters.quotaCounterId),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    quantity: integer("quantity").notNull(),
    status: text("status").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("quota_reservations_source_counter_unique").on(
      table.sourceType,
      table.sourceId,
      table.quotaCounterId,
    ),
  ],
);

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

/** Candidate memory facts proposed from maintainer feedback or automated signals. */
export const memoryCandidates = pgTable(
  "memory_candidates",
  {
    memoryCandidateId: text("memory_candidate_id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.orgId),
    repoId: text("repo_id").references(() => repositories.repoId),
    sourceKind: text("source_kind").notNull(),
    candidateKind: text("candidate_kind").notNull(),
    proposedContent: text("proposed_content").notNull(),
    proposedScope: jsonb("proposed_scope").notNull().default(sql`'{}'::jsonb`),
    proposedAppliesTo: jsonb("proposed_applies_to").notNull().default(sql`'{}'::jsonb`),
    confidence: real("confidence").notNull(),
    trustLevel: text("trust_level").notNull(),
    status: text("status").notNull(),
    createdByLogin: text("created_by_login"),
    sourceFeedbackEventId: text("source_feedback_event_id"),
    sourceFindingId: text("source_finding_id").references(() => publishedFindings.findingId),
    approvedMemoryFactId: text("approved_memory_fact_id").references(
      () => memoryFacts.memoryFactId,
    ),
    decidedByUserId: text("decided_by_user_id").references(() => users.userId),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    metadata: jsonb("metadata"),
    ...timestamps,
  },
  (table) => [
    index("memory_candidates_org_repo_status_idx").on(table.orgId, table.repoId, table.status),
    index("memory_candidates_source_finding_idx").on(table.sourceFindingId),
    index("memory_candidates_approved_fact_idx").on(table.approvedMemoryFactId),
  ],
);

/** Versioned evaluation suites used for deterministic and live quality gates. */
export const evalSuites = pgTable(
  "eval_suites",
  {
    evalSuiteId: text("eval_suite_id").primaryKey(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    version: text("version").notNull(),
    owner: text("owner").notNull(),
    tags: jsonb("tags").notNull().default(sql`'[]'::jsonb`),
    defaultRunner: text("default_runner").notNull(),
    defaultGraders: jsonb("default_graders").notNull().default(sql`'[]'::jsonb`),
    thresholds: jsonb("thresholds").notNull().default(sql`'{}'::jsonb`),
    ...timestamps,
  },
  (table) => [
    index("eval_suites_owner_idx").on(table.owner),
    uniqueIndex("eval_suites_name_version_unique").on(table.name, table.version),
  ],
);

/** Evaluation cases and expected labels that belong to a suite. */
export const evalCases = pgTable(
  "eval_cases",
  {
    evalCaseId: text("eval_case_id").primaryKey(),
    evalSuiteId: text("eval_suite_id")
      .notNull()
      .references(() => evalSuites.evalSuiteId),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    language: text("language").notNull(),
    tags: jsonb("tags").notNull().default(sql`'[]'::jsonb`),
    source: text("source").notNull(),
    privacyLevel: text("privacy_level").notNull(),
    difficulty: text("difficulty").notNull(),
    fixture: jsonb("fixture").notNull(),
    input: jsonb("input").notNull(),
    labels: jsonb("labels").notNull(),
    expected: jsonb("expected").notNull().default(sql`'{}'::jsonb`),
    active: boolean("active").notNull().default(true),
    ...timestamps,
  },
  (table) => [
    index("eval_cases_suite_active_idx").on(table.evalSuiteId, table.active),
    index("eval_cases_source_idx").on(table.source),
    index("eval_cases_privacy_idx").on(table.privacyLevel),
  ],
);

/** Serializable evaluation variant configurations under comparison. */
export const evalVariants = pgTable(
  "eval_variants",
  {
    evalVariantId: text("eval_variant_id").primaryKey(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    config: jsonb("config").notNull(),
    gitCommitSha: text("git_commit_sha"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("eval_variants_git_commit_idx").on(table.gitCommitSha),
    index("eval_variants_created_by_idx").on(table.createdBy),
  ],
);

/** Historical evaluation run summaries for CI, release, and scheduled quality gates. */
export const evalRuns = pgTable(
  "eval_runs",
  {
    evalRunId: text("eval_run_id").primaryKey(),
    evalSuiteId: text("eval_suite_id")
      .notNull()
      .references(() => evalSuites.evalSuiteId),
    evalVariantId: text("eval_variant_id")
      .notNull()
      .references(() => evalVariants.evalVariantId),
    baselineVariantId: text("baseline_variant_id").references(() => evalVariants.evalVariantId),
    status: text("status").notNull(),
    triggeredBy: text("triggered_by").notNull(),
    environment: text("environment").notNull(),
    gitCommitSha: text("git_commit_sha"),
    branch: text("branch"),
    caseCount: integer("case_count").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    reportUri: text("report_uri"),
    summary: jsonb("summary"),
    error: jsonb("error"),
  },
  (table) => [
    index("eval_runs_suite_started_idx").on(table.evalSuiteId, table.startedAt),
    index("eval_runs_variant_started_idx").on(table.evalVariantId, table.startedAt),
    index("eval_runs_status_idx").on(table.status),
    index("eval_runs_git_commit_idx").on(table.gitCommitSha),
  ],
);

/** Per-case evaluation results with scores, costs, timings, and artifact references. */
export const evalCaseResults = pgTable(
  "eval_case_results",
  {
    evalCaseResultId: text("eval_case_result_id").primaryKey(),
    evalRunId: text("eval_run_id")
      .notNull()
      .references(() => evalRuns.evalRunId, { onDelete: "cascade" }),
    evalCaseId: text("eval_case_id")
      .notNull()
      .references(() => evalCases.evalCaseId),
    status: text("status").notNull(),
    scores: jsonb("scores").notNull().default(sql`'[]'::jsonb`),
    matchedFindings: jsonb("matched_findings").notNull().default(sql`'[]'::jsonb`),
    unmatchedExpectedFindings: jsonb("unmatched_expected_findings")
      .notNull()
      .default(sql`'[]'::jsonb`),
    unmatchedGeneratedFindings: jsonb("unmatched_generated_findings")
      .notNull()
      .default(sql`'[]'::jsonb`),
    timings: jsonb("timings").notNull().default(sql`'{}'::jsonb`),
    costs: jsonb("costs").notNull().default(sql`'{}'::jsonb`),
    artifacts: jsonb("artifacts").notNull().default(sql`'[]'::jsonb`),
    error: jsonb("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("eval_case_results_run_case_unique").on(table.evalRunId, table.evalCaseId),
    index("eval_case_results_case_idx").on(table.evalCaseId),
    index("eval_case_results_status_idx").on(table.status),
  ],
);

/** Human labels and adjudication metadata for curated evaluation cases. */
export const evalHumanLabels = pgTable(
  "eval_human_labels",
  {
    evalHumanLabelId: text("eval_human_label_id").primaryKey(),
    evalCaseId: text("eval_case_id")
      .notNull()
      .references(() => evalCases.evalCaseId),
    findingFingerprint: text("finding_fingerprint"),
    labelerUserId: text("labeler_user_id").references(() => users.userId),
    label: jsonb("label").notNull(),
    adjudicationStatus: text("adjudication_status").notNull().default("pending"),
    ...timestamps,
  },
  (table) => [
    index("eval_human_labels_case_idx").on(table.evalCaseId),
    index("eval_human_labels_labeler_idx").on(table.labelerUserId),
    index("eval_human_labels_status_idx").on(table.adjudicationStatus),
  ],
);

/** Active baseline pointers for suite and variant comparison gates. */
export const evalBaselines = pgTable(
  "eval_baselines",
  {
    evalSuiteId: text("eval_suite_id")
      .notNull()
      .references(() => evalSuites.evalSuiteId),
    baselineVariantId: text("baseline_variant_id")
      .notNull()
      .references(() => evalVariants.evalVariantId),
    evalRunId: text("eval_run_id").references(() => evalRuns.evalRunId),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.evalSuiteId, table.baselineVariantId] }),
    index("eval_baselines_active_idx").on(table.evalSuiteId, table.active),
    index("eval_baselines_run_idx").on(table.evalRunId),
  ],
);

/** Durable record of privileged internal admin actions. */
export const adminActions = pgTable(
  "admin_actions",
  {
    adminActionId: text("admin_action_id").primaryKey(),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    actorType: text("actor_type").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    orgId: text("org_id").references(() => orgs.orgId),
    repoId: text("repo_id").references(() => repositories.repoId),
    reviewRunId: text("review_run_id").references(() => reviewRuns.reviewRunId),
    supportSessionId: text("support_session_id"),
    reason: text("reason").notNull(),
    request: jsonb("request").notNull(),
    result: jsonb("result"),
    error: jsonb("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("admin_actions_org_idx").on(table.orgId, table.createdAt),
    index("admin_actions_actor_idx").on(table.actorUserId, table.createdAt),
    index("admin_actions_review_run_idx").on(table.reviewRunId, table.createdAt),
  ],
);

/** Durable replay run rows that link operator dispatches to replay artifacts and jobs. */
export const replayRuns = pgTable(
  "replay_runs",
  {
    replayRunId: text("replay_run_id").primaryKey(),
    adminActionId: text("admin_action_id")
      .notNull()
      .references(() => adminActions.adminActionId),
    sourceReviewRunId: text("source_review_run_id").references(() => reviewRuns.reviewRunId),
    orgId: text("org_id").references(() => orgs.orgId),
    repoId: text("repo_id").references(() => repositories.repoId),
    mode: text("mode").notNull(),
    stages: jsonb("stages").notNull().default(sql`'[]'::jsonb`),
    configOverrides: jsonb("config_overrides").notNull().default(sql`'{}'::jsonb`),
    status: text("status").notNull(),
    createdByActorType: text("created_by_actor_type").notNull(),
    createdByActorUserId: text("created_by_actor_user_id").notNull(),
    supportSessionId: text("support_session_id"),
    reason: text("reason").notNull(),
    result: jsonb("result"),
    error: jsonb("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("replay_runs_source_idx").on(table.sourceReviewRunId, table.createdAt),
    index("replay_runs_org_idx").on(table.orgId, table.createdAt),
    index("replay_runs_admin_action_idx").on(table.adminActionId),
  ],
);

/** Durable per-stage replay rows for later replay runner and comparison artifacts. */
export const replayStageRuns = pgTable(
  "replay_stage_runs",
  {
    replayStageRunId: text("replay_stage_run_id").primaryKey(),
    replayRunId: text("replay_run_id")
      .notNull()
      .references(() => replayRuns.replayRunId),
    stage: text("stage").notNull(),
    status: text("status").notNull(),
    inputArtifactRef: jsonb("input_artifact_ref"),
    outputArtifactRef: jsonb("output_artifact_ref"),
    metrics: jsonb("metrics").notNull().default(sql`'{}'::jsonb`),
    error: jsonb("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [index("replay_stage_runs_replay_idx").on(table.replayRunId, table.stage)],
);

/** Internal operator notes attached to admin-inspected resources. */
export const adminNotes = pgTable(
  "admin_notes",
  {
    adminNoteId: text("admin_note_id").primaryKey(),
    actorType: text("actor_type").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    orgId: text("org_id").references(() => orgs.orgId),
    repoId: text("repo_id").references(() => repositories.repoId),
    reviewRunId: text("review_run_id").references(() => reviewRuns.reviewRunId),
    findingId: text("finding_id"),
    visibility: text("visibility").notNull(),
    body: text("body").notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("admin_notes_review_run_idx").on(table.reviewRunId, table.createdAt),
    index("admin_notes_org_idx").on(table.orgId, table.createdAt),
  ],
);

/** Durable debug bundle export rows for operator history and expiration tracking. */
export const debugExports = pgTable(
  "debug_exports",
  {
    debugExportId: text("debug_export_id").primaryKey(),
    adminActionId: text("admin_action_id")
      .notNull()
      .references(() => adminActions.adminActionId),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.orgId),
    repoId: text("repo_id").references(() => repositories.repoId),
    reviewRunId: text("review_run_id").references(() => reviewRuns.reviewRunId),
    exportKind: text("export_kind").notNull(),
    artifactUri: text("artifact_uri"),
    artifactHash: text("artifact_hash"),
    redactionLevel: text("redaction_level").notNull(),
    status: text("status").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdByActorType: text("created_by_actor_type").notNull(),
    createdByActorUserId: text("created_by_actor_user_id").notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    error: jsonb("error"),
    ...timestamps,
  },
  (table) => [
    index("debug_exports_org_idx").on(table.orgId, table.createdAt),
    index("debug_exports_review_run_idx").on(table.reviewRunId, table.createdAt),
  ],
);

/** Auditable event for sensitive artifact access attempts and downloads. */
export const artifactAccessEvents = pgTable(
  "artifact_access_events",
  {
    artifactAccessEventId: text("artifact_access_event_id").primaryKey(),
    actorType: text("actor_type").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    orgId: text("org_id").references(() => orgs.orgId),
    repoId: text("repo_id").references(() => repositories.repoId),
    reviewRunId: text("review_run_id").references(() => reviewRuns.reviewRunId),
    artifactRef: jsonb("artifact_ref").notNull(),
    accessLevel: text("access_level").notNull(),
    supportSessionId: text("support_session_id"),
    reason: text("reason").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("artifact_access_events_org_idx").on(table.orgId, table.createdAt),
    index("artifact_access_events_review_idx").on(table.reviewRunId, table.createdAt),
  ],
);

/** Durable security events emitted by API, worker, provider, and system boundaries. */
export const securityEvents = pgTable(
  "security_events",
  {
    securityEventId: text("security_event_id").primaryKey(),
    orgId: text("org_id").references(() => orgs.orgId),
    repoId: text("repo_id").references(() => repositories.repoId),
    type: text("type").notNull(),
    severity: text("severity").notNull(),
    source: text("source").notNull(),
    status: text("status").notNull(),
    actorId: text("actor_id"),
    resourceType: text("resource_type"),
    resourceId: text("resource_id"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    ...timestamps,
  },
  (table) => [
    index("security_events_org_idx").on(table.orgId, table.createdAt),
    index("security_events_repo_idx").on(table.repoId, table.createdAt),
    index("security_events_severity_idx").on(table.severity, table.createdAt),
    index("security_events_status_idx").on(table.status, table.createdAt),
    index("security_events_type_idx").on(table.type, table.createdAt),
    index("security_events_actor_idx").on(table.actorId, table.createdAt),
  ],
);

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
