import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import {
  adminActions,
  adminNotes,
  artifactAccessEvents,
  backgroundJobs,
  billingMeterEvents,
  billingProviderRequests,
  billingWebhookEvents,
  codeChunkEmbeddings,
  codeIndexVersions,
  creditGrants,
  debugExports,
  embeddingJobItems,
  embeddingJobs,
  evalBaselines,
  evalCaseResults,
  evalCases,
  evalHumanLabels,
  evalRuns,
  evalSuites,
  evalVariants,
  findingDuplicateGroups,
  findingValidationEvents,
  indexedFiles,
  indexImportBatches,
  invoices,
  memoryCandidates,
  oauthStates,
  orgMemberships,
  publishedCheckRuns,
  publishedReviews,
  publishedSummaryComments,
  publishPlans,
  pullRequests,
  quotaCounters,
  quotaReservations,
  replayRuns,
  replayStageRuns,
  repositories,
  repositorySettings,
  reviewArtifacts,
  reviewRunMetrics,
  sandboxArtifacts,
  sandboxPolicyDecisions,
  sandboxRuns,
  subscriptionItems,
  subscriptions,
  usageEvents,
  userProviderAccounts,
  userSessions,
  users,
  webhookEvents,
} from "../src/schema";

const testDirectory = fileURLToPath(new URL(".", import.meta.url));
const bootstrapPath = resolve(testDirectory, "../bootstrap/0000_extensions.sql");
const migrationsDirectory = resolve(testDirectory, "../migrations");
const migrationPath = resolve(testDirectory, "../migrations/0000_foundation.sql");
const adminToolingMigrationPath = resolve(
  testDirectory,
  "../migrations/0007_acoustic_black_widow.sql",
);
const adminReplayMigrationPath = resolve(testDirectory, "../migrations/0008_minor_thunderball.sql");
const productAuthMigrationPath = resolve(testDirectory, "../migrations/0009_high_sphinx.sql");
const validationEventsMigrationPath = resolve(testDirectory, "../migrations/0010_easy_tusk.sql");
const duplicateGroupsMigrationPath = resolve(
  testDirectory,
  "../migrations/0011_rich_wind_dancer.sql",
);
const publishPlansMigrationPath = resolve(testDirectory, "../migrations/0012_smart_scarecrow.sql");
const memoryCandidatesMigrationPath = resolve(
  testDirectory,
  "../migrations/0013_glossy_proemial_gods.sql",
);
const sandboxRunsMigrationPath = resolve(testDirectory, "../migrations/0014_polite_mesmero.sql");
const sandboxRepositorySettingsMigrationPath = resolve(
  testDirectory,
  "../migrations/0015_spicy_piledriver.sql",
);
const evalHistoryMigrationPath = resolve(testDirectory, "../migrations/0016_grey_ozymandias.sql");
const reviewRunMetricsMigrationPath = resolve(
  testDirectory,
  "../migrations/0017_secret_ironclad.sql",
);
const embeddingJobsMigrationPath = resolve(testDirectory, "../migrations/0020_luxuriant_zarda.sql");
const indexImportBatchesMigrationPath = resolve(
  testDirectory,
  "../migrations/0021_great_iron_monger.sql",
);
const indexArtifactUniquenessMigrationPath = resolve(
  testDirectory,
  "../migrations/0022_futuristic_quicksilver.sql",
);
const integrationDatabaseUrl = process.env.HEIMDALL_DB_TEST_URL;

describe("database schema foundation", () => {
  it("defines the provider repository uniqueness target", () => {
    expect(repositories.providerRepoId.name).toBe("provider_repo_id");
  });

  it("defines the Phase 2 persistence surfaces", () => {
    expect(webhookEvents.webhookEventId.name).toBe("webhook_event_id");
    expect(users.userId.name).toBe("user_id");
    expect(repositorySettings.sandboxPolicy.name).toBe("sandbox_policy");
    expect(userProviderAccounts.userProviderAccountId.name).toBe("user_provider_account_id");
    expect(orgMemberships.role.name).toBe("role");
    expect(userSessions.sessionHash.name).toBe("session_hash");
    expect(oauthStates.stateHash.name).toBe("state_hash");
    expect(backgroundJobs.backgroundJobId.name).toBe("background_job_id");
    expect(pullRequests.pullRequestId.name).toBe("pull_request_id");
    expect(codeIndexVersions.indexKey.name).toBe("index_key");
    expect(indexImportBatches.indexImportBatchId.name).toBe("index_import_batch_id");
    expect(indexedFiles.fileId.name).toBe("file_id");
    expect(reviewArtifacts.reviewArtifactId.name).toBe("review_artifact_id");
    expect(reviewRunMetrics.reviewRunId.name).toBe("review_run_id");
    expect(reviewRunMetrics.totalDurationMs.name).toBe("total_duration_ms");
    expect(sandboxRuns.sandboxRunId.name).toBe("sandbox_run_id");
    expect(sandboxArtifacts.sandboxArtifactId.name).toBe("sandbox_artifact_id");
    expect(sandboxPolicyDecisions.sandboxPolicyDecisionId.name).toBe("sandbox_policy_decision_id");
    expect(findingValidationEvents.findingValidationEventId.name).toBe(
      "finding_validation_event_id",
    );
    expect(findingDuplicateGroups.findingDuplicateGroupId.name).toBe("finding_duplicate_group_id");
    expect(publishPlans.publishPlanId.name).toBe("publish_plan_id");
    expect(memoryCandidates.memoryCandidateId.name).toBe("memory_candidate_id");
    expect(publishedReviews.publishedReviewId.name).toBe("published_review_id");
    expect(publishedSummaryComments.publishedSummaryCommentId.name).toBe(
      "published_summary_comment_id",
    );
    expect(publishedCheckRuns.publishedCheckRunId.name).toBe("published_check_run_id");
    expect(usageEvents.usageEventId.name).toBe("usage_event_id");
    expect(quotaCounters.quotaCounterId.name).toBe("quota_counter_id");
    expect(quotaReservations.quotaReservationId.name).toBe("quota_reservation_id");
    expect(subscriptions.subscriptionId.name).toBe("subscription_id");
    expect(subscriptionItems.subscriptionItemId.name).toBe("subscription_item_id");
    expect(creditGrants.creditGrantId.name).toBe("credit_grant_id");
    expect(invoices.invoiceId.name).toBe("invoice_id");
    expect(billingProviderRequests.billingProviderRequestId.name).toBe(
      "billing_provider_request_id",
    );
    expect(billingWebhookEvents.billingWebhookEventId.name).toBe("billing_webhook_event_id");
    expect(billingMeterEvents.billingMeterEventId.name).toBe("billing_meter_event_id");
    expect(adminActions.adminActionId.name).toBe("admin_action_id");
    expect(replayRuns.replayRunId.name).toBe("replay_run_id");
    expect(replayStageRuns.replayStageRunId.name).toBe("replay_stage_run_id");
    expect(adminNotes.adminNoteId.name).toBe("admin_note_id");
    expect(debugExports.debugExportId.name).toBe("debug_export_id");
    expect(artifactAccessEvents.artifactAccessEventId.name).toBe("artifact_access_event_id");
    expect(evalSuites.evalSuiteId.name).toBe("eval_suite_id");
    expect(evalCases.evalCaseId.name).toBe("eval_case_id");
    expect(evalVariants.evalVariantId.name).toBe("eval_variant_id");
    expect(evalRuns.evalRunId.name).toBe("eval_run_id");
    expect(evalCaseResults.evalCaseResultId.name).toBe("eval_case_result_id");
    expect(evalHumanLabels.evalHumanLabelId.name).toBe("eval_human_label_id");
    expect(evalBaselines.evalRunId.name).toBe("eval_run_id");
    expect(embeddingJobs.embeddingJobId.name).toBe("embedding_job_id");
    expect(embeddingJobItems.embeddingJobItemId.name).toBe("embedding_job_item_id");
  });

  it("defines pgvector storage for code chunk embeddings", () => {
    expect(codeChunkEmbeddings.embedding.name).toBe("embedding");
  });

  it("ships the generated foundation migration and extension bootstrap", async () => {
    const bootstrap = await readFile(bootstrapPath, "utf8");
    const migration = await readFile(migrationPath, "utf8");
    const adminToolingMigration = await readFile(adminToolingMigrationPath, "utf8");
    const adminReplayMigration = await readFile(adminReplayMigrationPath, "utf8");
    const productAuthMigration = await readFile(productAuthMigrationPath, "utf8");
    const validationEventsMigration = await readFile(validationEventsMigrationPath, "utf8");
    const duplicateGroupsMigration = await readFile(duplicateGroupsMigrationPath, "utf8");
    const publishPlansMigration = await readFile(publishPlansMigrationPath, "utf8");
    const memoryCandidatesMigration = await readFile(memoryCandidatesMigrationPath, "utf8");
    const sandboxRunsMigration = await readFile(sandboxRunsMigrationPath, "utf8");
    const sandboxRepositorySettingsMigration = await readFile(
      sandboxRepositorySettingsMigrationPath,
      "utf8",
    );
    const evalHistoryMigration = await readFile(evalHistoryMigrationPath, "utf8");
    const reviewRunMetricsMigration = await readFile(reviewRunMetricsMigrationPath, "utf8");
    const embeddingJobsMigration = await readFile(embeddingJobsMigrationPath, "utf8");
    const indexImportBatchesMigration = await readFile(indexImportBatchesMigrationPath, "utf8");
    const indexArtifactUniquenessMigration = await readFile(
      indexArtifactUniquenessMigrationPath,
      "utf8",
    );

    expect(bootstrap).toContain("CREATE EXTENSION IF NOT EXISTS vector");
    expect(bootstrap).toContain("CREATE EXTENSION IF NOT EXISTS pgcrypto");
    expect(migration).toContain('CREATE TABLE "webhook_events"');
    expect(migration).toContain('CREATE TABLE "background_jobs"');
    expect(migration).toContain('CREATE TABLE "pull_requests"');
    expect(migration).toContain('CREATE TABLE "indexed_files"');
    expect(migration).toContain('CREATE TABLE "symbols"');
    expect(migration).toContain('CREATE TABLE "code_edges"');
    expect(migration).toContain('CREATE TABLE "code_chunk_embeddings"');
    expect(migration).toContain('CREATE TABLE "review_runs"');
    expect(migration).toContain('CREATE TABLE "review_artifacts"');
    expect(migration).toContain('CREATE TABLE "publish_runs"');
    expect(migration).toContain('CREATE TABLE "published_reviews"');
    expect(migration).toContain('CREATE TABLE "published_summary_comments"');
    expect(migration).toContain('CREATE TABLE "published_check_runs"');
    expect(migration).toContain('CREATE TABLE "published_findings"');
    expect(migration).toContain('CREATE TABLE "finding_outcomes"');
    expect(migration).toContain('CREATE TABLE "llm_calls"');
    expect(migration).toContain('CREATE TABLE "llm_call_artifacts"');
    expect(migration).toContain('CREATE TABLE "usage_events"');
    expect(migration).toContain('CREATE UNIQUE INDEX "code_index_versions_repo_commit_key_unique"');
    expect(migration).toContain('"embedding" vector(1536) NOT NULL');
    expect(adminToolingMigration).toContain('CREATE TABLE "admin_actions"');
    expect(adminToolingMigration).toContain('CREATE TABLE "debug_exports"');
    expect(adminToolingMigration).toContain('CREATE TABLE "artifact_access_events"');
    expect(adminReplayMigration).toContain('CREATE TABLE "replay_runs"');
    expect(adminReplayMigration).toContain('CREATE TABLE "replay_stage_runs"');
    expect(adminReplayMigration).toContain('CREATE TABLE "admin_notes"');
    expect(productAuthMigration).toContain('CREATE TABLE "users"');
    expect(productAuthMigration).toContain('CREATE TABLE "user_provider_accounts"');
    expect(productAuthMigration).toContain('CREATE TABLE "org_memberships"');
    expect(productAuthMigration).toContain('CREATE TABLE "user_sessions"');
    expect(productAuthMigration).toContain('CREATE TABLE "oauth_states"');
    expect(validationEventsMigration).toContain('CREATE TABLE "finding_validation_events"');
    expect(duplicateGroupsMigration).toContain('CREATE TABLE "finding_duplicate_groups"');
    expect(publishPlansMigration).toContain('CREATE TABLE "publish_plans"');
    expect(memoryCandidatesMigration).toContain('CREATE TABLE "memory_candidates"');
    expect(sandboxRunsMigration).toContain('CREATE TABLE "sandbox_runs"');
    expect(sandboxRunsMigration).toContain('CREATE TABLE "sandbox_artifacts"');
    expect(sandboxRunsMigration).toContain('CREATE TABLE "sandbox_policy_decisions"');
    expect(sandboxRepositorySettingsMigration).toContain(
      'ALTER TABLE "repository_settings" ADD COLUMN "sandbox_policy" jsonb',
    );
    expect(evalHistoryMigration).toContain('CREATE TABLE "eval_suites"');
    expect(evalHistoryMigration).toContain('CREATE TABLE "eval_cases"');
    expect(evalHistoryMigration).toContain('CREATE TABLE "eval_variants"');
    expect(evalHistoryMigration).toContain('CREATE TABLE "eval_runs"');
    expect(evalHistoryMigration).toContain('CREATE TABLE "eval_case_results"');
    expect(evalHistoryMigration).toContain('CREATE TABLE "eval_human_labels"');
    expect(evalHistoryMigration).toContain('CREATE TABLE "eval_baselines"');
    expect(reviewRunMetricsMigration).toContain('CREATE TABLE "review_run_metrics"');
    expect(reviewRunMetricsMigration).toContain('"estimated_cost_usd" numeric(12, 6)');
    expect(embeddingJobsMigration).toContain('CREATE TABLE "embedding_jobs"');
    expect(embeddingJobsMigration).toContain('CREATE TABLE "embedding_job_items"');
    expect(embeddingJobsMigration).toContain('CREATE INDEX "embedding_jobs_repo_status_idx"');
    expect(indexImportBatchesMigration).toContain('CREATE TABLE "index_import_batches"');
    expect(indexImportBatchesMigration).toContain(
      'CREATE INDEX "index_import_batches_repo_status_idx"',
    );
    expect(indexArtifactUniquenessMigration).toContain(
      'DROP INDEX "code_index_versions_repo_commit_key_unique"',
    );
    expect(indexArtifactUniquenessMigration).toContain(
      'CREATE UNIQUE INDEX "code_index_versions_repo_commit_key_artifact_unique"',
    );
  });
});

describe.runIf(integrationDatabaseUrl)("database migration integration", () => {
  const schemaName = `heimdall_test_${process.pid}_${Date.now()}`.replace(/[^A-Za-z0-9_]/g, "_");
  const sql = postgres(integrationDatabaseUrl ?? "", { max: 1 });

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await sql.end();
  });

  it("applies every migration from an empty schema and supports core rows", async () => {
    const bootstrap = await readFile(bootstrapPath, "utf8");

    await sql.unsafe(`CREATE SCHEMA "${schemaName}"`);
    await sql.unsafe(`SET search_path TO "${schemaName}", public`);
    await sql.unsafe(bootstrap);
    await applyMigrations(sql, schemaName);

    await sql`
      INSERT INTO orgs (org_id, name, slug)
      VALUES ('org_test', 'Test Org', 'test-org')
    `;
    await sql`
      INSERT INTO provider_installations (
        installation_id,
        org_id,
        provider,
        provider_installation_id,
        account_login,
        account_type,
        installed_at
      )
      VALUES ('inst_test', 'org_test', 'github', '123', 'test-org', 'organization', now())
    `;
    await sql`
      INSERT INTO repositories (
        repo_id,
        org_id,
        installation_id,
        provider,
        provider_repo_id,
        owner,
        name,
        full_name,
        visibility
      )
      VALUES (
        'repo_test',
        'org_test',
        'inst_test',
        'github',
        '456',
        'test-org',
        'heimdall',
        'test-org/heimdall',
        'private'
      )
    `;
    await sql`
      INSERT INTO webhook_events (
        webhook_event_id,
        provider,
        delivery_id,
        event_name,
        repo_id,
        payload_hash
      )
      VALUES ('webhook_test', 'github', 'delivery-1', 'pull_request', 'repo_test', 'hash')
    `;
    await sql`
      INSERT INTO code_index_versions (
        index_version_id,
        repo_id,
        commit_sha,
        index_key,
        status,
        artifact_uri,
        indexer_name,
        indexer_version,
        chunker_version
      )
      VALUES (
        'idx_test',
        'repo_test',
        'abcdef123456',
        'tree-sitter:1:1',
        'ready',
        's3://bucket/index',
        'tree-sitter',
        '1',
        '1'
      )
    `;
    await sql`
      INSERT INTO indexed_files (
        file_id,
        index_version_id,
        repo_id,
        commit_sha,
        path,
        language,
        content_hash
      )
      VALUES ('file_test', 'idx_test', 'repo_test', 'abcdef123456', 'src/index.ts', 'typescript', 'hash')
    `;
    await sql`
      INSERT INTO code_chunks (
        chunk_id,
        index_version_id,
        file_id,
        repo_id,
        path,
        start_line,
        end_line,
        content_hash
      )
      VALUES ('chunk_test', 'idx_test', 'file_test', 'repo_test', 'src/index.ts', 1, 3, 'hash')
    `;
    await sql`
      INSERT INTO code_chunk_embeddings (
        chunk_embedding_id,
        chunk_id,
        repo_id,
        index_version_id,
        embedding_model,
        embedding,
        content_hash
      )
      VALUES (
        'emb_test',
        'chunk_test',
        'repo_test',
        'idx_test',
        'text-embedding-3-small',
        ('[' || repeat('0,', 1535) || '0]')::vector,
        'hash'
      )
    `;

    const [result] = await sql`
      SELECT
        (SELECT count(*)::int FROM webhook_events) AS webhook_events,
        (SELECT count(*)::int FROM code_index_versions) AS index_versions,
        (SELECT count(*)::int FROM code_chunk_embeddings) AS embeddings,
        (SELECT to_regclass('admin_actions')::text) AS admin_actions_table,
        (SELECT to_regclass('finding_duplicate_groups')::text) AS finding_duplicate_groups_table,
        (SELECT to_regclass('finding_validation_events')::text) AS finding_validation_events_table,
        (SELECT to_regclass('index_import_batches')::text) AS index_import_batches_table,
        (SELECT to_regclass('memory_candidates')::text) AS memory_candidates_table,
        (SELECT to_regclass('publish_plans')::text) AS publish_plans_table,
        (SELECT to_regclass('replay_runs')::text) AS replay_runs_table,
        (SELECT to_regclass('sandbox_artifacts')::text) AS sandbox_artifacts_table,
        (SELECT to_regclass('sandbox_policy_decisions')::text) AS sandbox_policy_decisions_table,
        (SELECT to_regclass('sandbox_runs')::text) AS sandbox_runs_table,
        (SELECT to_regclass('eval_suites')::text) AS eval_suites_table,
        (SELECT to_regclass('eval_cases')::text) AS eval_cases_table,
        (SELECT to_regclass('eval_variants')::text) AS eval_variants_table,
        (SELECT to_regclass('eval_runs')::text) AS eval_runs_table,
        (SELECT to_regclass('eval_case_results')::text) AS eval_case_results_table,
        (SELECT to_regclass('eval_human_labels')::text) AS eval_human_labels_table,
        (SELECT to_regclass('eval_baselines')::text) AS eval_baselines_table,
        (SELECT to_regclass('review_run_metrics')::text) AS review_run_metrics_table,
        (SELECT to_regclass('users')::text) AS users_table,
        (SELECT to_regclass('oauth_states')::text) AS oauth_states_table
    `;

    expect(result).toEqual({
      admin_actions_table: "admin_actions",
      webhook_events: 1,
      index_versions: 1,
      index_import_batches_table: "index_import_batches",
      embeddings: 1,
      eval_baselines_table: "eval_baselines",
      eval_case_results_table: "eval_case_results",
      eval_cases_table: "eval_cases",
      eval_human_labels_table: "eval_human_labels",
      eval_runs_table: "eval_runs",
      eval_suites_table: "eval_suites",
      eval_variants_table: "eval_variants",
      finding_duplicate_groups_table: "finding_duplicate_groups",
      finding_validation_events_table: "finding_validation_events",
      memory_candidates_table: "memory_candidates",
      publish_plans_table: "publish_plans",
      oauth_states_table: "oauth_states",
      replay_runs_table: "replay_runs",
      review_run_metrics_table: "review_run_metrics",
      sandbox_artifacts_table: "sandbox_artifacts",
      sandbox_policy_decisions_table: "sandbox_policy_decisions",
      sandbox_runs_table: "sandbox_runs",
      users_table: "users",
    });
  });
});

/** Applies all generated SQL migrations in lexical order to a test schema. */
async function applyMigrations(sql: postgres.Sql, schemaName: string): Promise<void> {
  const files = (await readdir(migrationsDirectory))
    .filter((file) => file.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right));

  for (const file of files) {
    await sql.unsafe(
      (await readFile(resolve(migrationsDirectory, file), "utf8")).replaceAll(
        '"public".',
        `"${schemaName}".`,
      ),
    );
  }
}
