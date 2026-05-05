CREATE TABLE "audit_logs" (
	"audit_log_id" text PRIMARY KEY NOT NULL,
	"org_id" text,
	"actor_type" text NOT NULL,
	"actor_user_id" text,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "background_jobs" (
	"background_job_id" text PRIMARY KEY NOT NULL,
	"queue_name" text NOT NULL,
	"job_key" text NOT NULL,
	"job_type" text NOT NULL,
	"status" text NOT NULL,
	"org_id" text,
	"repo_id" text,
	"review_run_id" text,
	"payload" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"scheduled_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error" jsonb,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "candidate_findings" (
	"finding_id" text PRIMARY KEY NOT NULL,
	"schema_version" text NOT NULL,
	"review_run_id" text NOT NULL,
	"source" text NOT NULL,
	"source_name" text NOT NULL,
	"category" text NOT NULL,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"location" jsonb NOT NULL,
	"evidence" jsonb NOT NULL,
	"suggested_fix" text,
	"confidence" real NOT NULL,
	"fingerprint" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "code_chunk_embeddings" (
	"chunk_embedding_id" text PRIMARY KEY NOT NULL,
	"chunk_id" text NOT NULL,
	"repo_id" text NOT NULL,
	"index_version_id" text NOT NULL,
	"embedding_model" text NOT NULL,
	"embedding_dimension" integer DEFAULT 1536 NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "code_chunks" (
	"chunk_id" text PRIMARY KEY NOT NULL,
	"index_version_id" text NOT NULL,
	"file_id" text,
	"symbol_id" text,
	"repo_id" text NOT NULL,
	"path" text NOT NULL,
	"start_line" integer NOT NULL,
	"end_line" integer NOT NULL,
	"content_hash" text NOT NULL,
	"embedding_status" text DEFAULT 'pending' NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "code_edges" (
	"edge_id" text PRIMARY KEY NOT NULL,
	"index_version_id" text NOT NULL,
	"repo_id" text NOT NULL,
	"commit_sha" text NOT NULL,
	"from_id" text NOT NULL,
	"to_id" text NOT NULL,
	"from_kind" text NOT NULL,
	"to_kind" text NOT NULL,
	"kind" text NOT NULL,
	"confidence" real NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "code_index_versions" (
	"index_version_id" text PRIMARY KEY NOT NULL,
	"repo_id" text NOT NULL,
	"commit_sha" text NOT NULL,
	"index_key" text NOT NULL,
	"status" text NOT NULL,
	"artifact_uri" text NOT NULL,
	"artifact_hash" text,
	"indexer_name" text NOT NULL,
	"indexer_version" text NOT NULL,
	"chunker_version" text NOT NULL,
	"file_count" integer DEFAULT 0 NOT NULL,
	"symbol_count" integer DEFAULT 0 NOT NULL,
	"edge_count" integer DEFAULT 0 NOT NULL,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"embedded_chunk_count" integer DEFAULT 0 NOT NULL,
	"completed_at" timestamp with time zone,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finding_outcomes" (
	"finding_outcome_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"repo_id" text NOT NULL,
	"candidate_finding_id" text,
	"published_finding_id" text,
	"outcome" text NOT NULL,
	"source" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_records" (
	"idempotency_key" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"status" text NOT NULL,
	"request_hash" text,
	"response_hash" text,
	"locked_until" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "indexed_files" (
	"file_id" text PRIMARY KEY NOT NULL,
	"index_version_id" text NOT NULL,
	"repo_id" text NOT NULL,
	"commit_sha" text NOT NULL,
	"path" text NOT NULL,
	"language" text NOT NULL,
	"content_hash" text NOT NULL,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"line_count" integer DEFAULT 0 NOT NULL,
	"is_binary" boolean DEFAULT false NOT NULL,
	"is_generated" boolean DEFAULT false NOT NULL,
	"is_test" boolean DEFAULT false NOT NULL,
	"is_vendored" boolean DEFAULT false NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_call_artifacts" (
	"llm_call_id" text NOT NULL,
	"review_artifact_id" text NOT NULL,
	"artifact_role" text NOT NULL,
	CONSTRAINT "llm_call_artifacts_llm_call_id_review_artifact_id_pk" PRIMARY KEY("llm_call_id","review_artifact_id")
);
--> statement-breakpoint
CREATE TABLE "llm_calls" (
	"llm_call_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"repo_id" text,
	"review_run_id" text,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"purpose" text NOT NULL,
	"status" text NOT NULL,
	"prompt_hash" text NOT NULL,
	"response_hash" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_micros" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"error" jsonb,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "memory_facts" (
	"memory_fact_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"repo_id" text,
	"fact_type" text NOT NULL,
	"body" text NOT NULL,
	"status" text NOT NULL,
	"confidence" real NOT NULL,
	"expires_at" timestamp with time zone,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orgs" (
	"org_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_installations" (
	"installation_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_installation_id" text NOT NULL,
	"account_login" text NOT NULL,
	"account_type" text NOT NULL,
	"permissions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"installed_at" timestamp with time zone NOT NULL,
	"suspended_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "publish_operations" (
	"publish_operation_id" text PRIMARY KEY NOT NULL,
	"publish_run_id" text NOT NULL,
	"operation_type" text NOT NULL,
	"status" text NOT NULL,
	"request_hash" text,
	"response_hash" text,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "publish_runs" (
	"publish_run_id" text PRIMARY KEY NOT NULL,
	"review_run_id" text NOT NULL,
	"repo_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error" jsonb,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "published_check_runs" (
	"published_check_run_id" text PRIMARY KEY NOT NULL,
	"publish_run_id" text NOT NULL,
	"review_run_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_check_run_id" text NOT NULL,
	"status" text NOT NULL,
	"conclusion" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "published_findings" (
	"finding_id" text PRIMARY KEY NOT NULL,
	"validated_finding_id" text NOT NULL,
	"review_run_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_comment_id" text,
	"provider_review_id" text,
	"provider_check_run_id" text,
	"location" jsonb NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"error" jsonb,
	"fingerprint" text NOT NULL,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "published_reviews" (
	"published_review_id" text PRIMARY KEY NOT NULL,
	"publish_run_id" text NOT NULL,
	"review_run_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_review_id" text NOT NULL,
	"status" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "published_summary_comments" (
	"published_summary_comment_id" text PRIMARY KEY NOT NULL,
	"publish_run_id" text NOT NULL,
	"review_run_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_comment_id" text NOT NULL,
	"body_hash" text NOT NULL,
	"status" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pull_request_snapshots" (
	"snapshot_id" text PRIMARY KEY NOT NULL,
	"schema_version" text NOT NULL,
	"provider" text NOT NULL,
	"repo_id" text NOT NULL,
	"installation_id" text NOT NULL,
	"provider_repo_id" text NOT NULL,
	"provider_pull_request_id" text NOT NULL,
	"pull_request_number" integer NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"author_login" text NOT NULL,
	"author_association" text,
	"state" text NOT NULL,
	"is_draft" boolean NOT NULL,
	"labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"base_ref" text NOT NULL,
	"base_sha" text NOT NULL,
	"head_ref" text NOT NULL,
	"head_sha" text NOT NULL,
	"merge_base_sha" text,
	"changed_files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"diff_hash" text NOT NULL,
	"additions" integer NOT NULL,
	"deletions" integer NOT NULL,
	"changed_file_count" integer NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"provider_metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "pull_requests" (
	"pull_request_id" text PRIMARY KEY NOT NULL,
	"repo_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_pull_request_id" text NOT NULL,
	"pull_request_number" integer NOT NULL,
	"title" text NOT NULL,
	"author_login" text NOT NULL,
	"state" text NOT NULL,
	"is_draft" boolean DEFAULT false NOT NULL,
	"base_ref" text NOT NULL,
	"base_sha" text NOT NULL,
	"head_ref" text NOT NULL,
	"head_sha" text NOT NULL,
	"latest_snapshot_id" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repo_rules" (
	"repo_rule_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"repo_id" text,
	"scope" text NOT NULL,
	"rule_type" text NOT NULL,
	"body" text NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"repo_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"installation_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_repo_id" text NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"full_name" text NOT NULL,
	"default_branch" text,
	"clone_url" text,
	"visibility" text NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"is_fork" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repository_settings" (
	"repo_id" text PRIMARY KEY NOT NULL,
	"review_policy" text NOT NULL,
	"severity_threshold" text NOT NULL,
	"max_comments_per_review" integer NOT NULL,
	"ignored_paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ignored_authors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ignored_labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"require_label" text,
	"skip_generated_files" boolean DEFAULT true NOT NULL,
	"skip_draft_pull_requests" boolean DEFAULT true NOT NULL,
	"enabled_languages" jsonb,
	"custom_instructions" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_artifacts" (
	"review_artifact_id" text PRIMARY KEY NOT NULL,
	"review_run_id" text NOT NULL,
	"repo_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"uri" text NOT NULL,
	"hash" text NOT NULL,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"classification" text DEFAULT 'customer_confidential' NOT NULL,
	"retention_until" timestamp with time zone,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_run_dependencies" (
	"review_run_id" text NOT NULL,
	"dependency_type" text NOT NULL,
	"dependency_id" text NOT NULL,
	"metadata" jsonb,
	CONSTRAINT "review_run_dependencies_review_run_id_dependency_type_dependency_id_pk" PRIMARY KEY("review_run_id","dependency_type","dependency_id")
);
--> statement-breakpoint
CREATE TABLE "review_run_stage_events" (
	"review_run_stage_event_id" text PRIMARY KEY NOT NULL,
	"review_run_id" text NOT NULL,
	"stage" text NOT NULL,
	"status" text NOT NULL,
	"message" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "review_runs" (
	"review_run_id" text PRIMARY KEY NOT NULL,
	"schema_version" text NOT NULL,
	"repo_id" text NOT NULL,
	"pull_request_snapshot_id" text NOT NULL,
	"pull_request_number" integer NOT NULL,
	"base_sha" text NOT NULL,
	"head_sha" text NOT NULL,
	"trigger" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"summary" text,
	"artifact_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"counts" jsonb NOT NULL,
	"error" jsonb,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "symbols" (
	"symbol_id" text PRIMARY KEY NOT NULL,
	"index_version_id" text NOT NULL,
	"file_id" text NOT NULL,
	"repo_id" text NOT NULL,
	"commit_sha" text NOT NULL,
	"path" text NOT NULL,
	"language" text NOT NULL,
	"name" text NOT NULL,
	"qualified_name" text,
	"kind" text NOT NULL,
	"start_line" integer NOT NULL,
	"end_line" integer NOT NULL,
	"content_hash" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"usage_event_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"repo_id" text,
	"review_run_id" text,
	"event_type" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit" text NOT NULL,
	"cost_micros" integer DEFAULT 0 NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "validated_findings" (
	"finding_id" text PRIMARY KEY NOT NULL,
	"candidate_finding_id" text NOT NULL,
	"review_run_id" text NOT NULL,
	"decision" text NOT NULL,
	"category" text NOT NULL,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"location" jsonb NOT NULL,
	"evidence" jsonb NOT NULL,
	"confidence" real NOT NULL,
	"validation" jsonb NOT NULL,
	"rank" integer,
	"fingerprint" text NOT NULL,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"webhook_event_id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"delivery_id" text NOT NULL,
	"event_name" text NOT NULL,
	"action" text,
	"installation_id" text,
	"org_id" text,
	"repo_id" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"status" text DEFAULT 'received' NOT NULL,
	"payload_hash" text NOT NULL,
	"payload" jsonb,
	"error" jsonb,
	"metadata" jsonb
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_org_id_orgs_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "background_jobs" ADD CONSTRAINT "background_jobs_org_id_orgs_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "background_jobs" ADD CONSTRAINT "background_jobs_repo_id_repositories_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("repo_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_findings" ADD CONSTRAINT "candidate_findings_review_run_id_review_runs_review_run_id_fk" FOREIGN KEY ("review_run_id") REFERENCES "public"."review_runs"("review_run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_chunk_embeddings" ADD CONSTRAINT "code_chunk_embeddings_chunk_id_code_chunks_chunk_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."code_chunks"("chunk_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_chunk_embeddings" ADD CONSTRAINT "code_chunk_embeddings_repo_id_repositories_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("repo_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_chunk_embeddings" ADD CONSTRAINT "code_chunk_embeddings_index_version_id_code_index_versions_index_version_id_fk" FOREIGN KEY ("index_version_id") REFERENCES "public"."code_index_versions"("index_version_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_chunks" ADD CONSTRAINT "code_chunks_index_version_id_code_index_versions_index_version_id_fk" FOREIGN KEY ("index_version_id") REFERENCES "public"."code_index_versions"("index_version_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_chunks" ADD CONSTRAINT "code_chunks_file_id_indexed_files_file_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."indexed_files"("file_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_chunks" ADD CONSTRAINT "code_chunks_symbol_id_symbols_symbol_id_fk" FOREIGN KEY ("symbol_id") REFERENCES "public"."symbols"("symbol_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_chunks" ADD CONSTRAINT "code_chunks_repo_id_repositories_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("repo_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_edges" ADD CONSTRAINT "code_edges_index_version_id_code_index_versions_index_version_id_fk" FOREIGN KEY ("index_version_id") REFERENCES "public"."code_index_versions"("index_version_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_edges" ADD CONSTRAINT "code_edges_repo_id_repositories_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("repo_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_index_versions" ADD CONSTRAINT "code_index_versions_repo_id_repositories_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("repo_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_outcomes" ADD CONSTRAINT "finding_outcomes_org_id_orgs_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_outcomes" ADD CONSTRAINT "finding_outcomes_repo_id_repositories_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("repo_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_outcomes" ADD CONSTRAINT "finding_outcomes_candidate_finding_id_candidate_findings_finding_id_fk" FOREIGN KEY ("candidate_finding_id") REFERENCES "public"."candidate_findings"("finding_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_outcomes" ADD CONSTRAINT "finding_outcomes_published_finding_id_published_findings_finding_id_fk" FOREIGN KEY ("published_finding_id") REFERENCES "public"."published_findings"("finding_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "indexed_files" ADD CONSTRAINT "indexed_files_index_version_id_code_index_versions_index_version_id_fk" FOREIGN KEY ("index_version_id") REFERENCES "public"."code_index_versions"("index_version_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "indexed_files" ADD CONSTRAINT "indexed_files_repo_id_repositories_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("repo_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_call_artifacts" ADD CONSTRAINT "llm_call_artifacts_llm_call_id_llm_calls_llm_call_id_fk" FOREIGN KEY ("llm_call_id") REFERENCES "public"."llm_calls"("llm_call_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_call_artifacts" ADD CONSTRAINT "llm_call_artifacts_review_artifact_id_review_artifacts_review_artifact_id_fk" FOREIGN KEY ("review_artifact_id") REFERENCES "public"."review_artifacts"("review_artifact_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_org_id_orgs_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_repo_id_repositories_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("repo_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_review_run_id_review_runs_review_run_id_fk" FOREIGN KEY ("review_run_id") REFERENCES "public"."review_runs"("review_run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_facts" ADD CONSTRAINT "memory_facts_org_id_orgs_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_facts" ADD CONSTRAINT "memory_facts_repo_id_repositories_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("repo_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_installations" ADD CONSTRAINT "provider_installations_org_id_orgs_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_operations" ADD CONSTRAINT "publish_operations_publish_run_id_publish_runs_publish_run_id_fk" FOREIGN KEY ("publish_run_id") REFERENCES "public"."publish_runs"("publish_run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_runs" ADD CONSTRAINT "publish_runs_review_run_id_review_runs_review_run_id_fk" FOREIGN KEY ("review_run_id") REFERENCES "public"."review_runs"("review_run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_runs" ADD CONSTRAINT "publish_runs_repo_id_repositories_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("repo_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_check_runs" ADD CONSTRAINT "published_check_runs_publish_run_id_publish_runs_publish_run_id_fk" FOREIGN KEY ("publish_run_id") REFERENCES "public"."publish_runs"("publish_run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_check_runs" ADD CONSTRAINT "published_check_runs_review_run_id_review_runs_review_run_id_fk" FOREIGN KEY ("review_run_id") REFERENCES "public"."review_runs"("review_run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_findings" ADD CONSTRAINT "published_findings_validated_finding_id_validated_findings_finding_id_fk" FOREIGN KEY ("validated_finding_id") REFERENCES "public"."validated_findings"("finding_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_findings" ADD CONSTRAINT "published_findings_review_run_id_review_runs_review_run_id_fk" FOREIGN KEY ("review_run_id") REFERENCES "public"."review_runs"("review_run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_reviews" ADD CONSTRAINT "published_reviews_publish_run_id_publish_runs_publish_run_id_fk" FOREIGN KEY ("publish_run_id") REFERENCES "public"."publish_runs"("publish_run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_reviews" ADD CONSTRAINT "published_reviews_review_run_id_review_runs_review_run_id_fk" FOREIGN KEY ("review_run_id") REFERENCES "public"."review_runs"("review_run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_summary_comments" ADD CONSTRAINT "published_summary_comments_publish_run_id_publish_runs_publish_run_id_fk" FOREIGN KEY ("publish_run_id") REFERENCES "public"."publish_runs"("publish_run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_summary_comments" ADD CONSTRAINT "published_summary_comments_review_run_id_review_runs_review_run_id_fk" FOREIGN KEY ("review_run_id") REFERENCES "public"."review_runs"("review_run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_request_snapshots" ADD CONSTRAINT "pull_request_snapshots_repo_id_repositories_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("repo_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_request_snapshots" ADD CONSTRAINT "pull_request_snapshots_installation_id_provider_installations_installation_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."provider_installations"("installation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_repo_id_repositories_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("repo_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_rules" ADD CONSTRAINT "repo_rules_org_id_orgs_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_rules" ADD CONSTRAINT "repo_rules_repo_id_repositories_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("repo_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_org_id_orgs_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_installation_id_provider_installations_installation_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."provider_installations"("installation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_settings" ADD CONSTRAINT "repository_settings_repo_id_repositories_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("repo_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_artifacts" ADD CONSTRAINT "review_artifacts_review_run_id_review_runs_review_run_id_fk" FOREIGN KEY ("review_run_id") REFERENCES "public"."review_runs"("review_run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_artifacts" ADD CONSTRAINT "review_artifacts_repo_id_repositories_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("repo_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_run_dependencies" ADD CONSTRAINT "review_run_dependencies_review_run_id_review_runs_review_run_id_fk" FOREIGN KEY ("review_run_id") REFERENCES "public"."review_runs"("review_run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_run_stage_events" ADD CONSTRAINT "review_run_stage_events_review_run_id_review_runs_review_run_id_fk" FOREIGN KEY ("review_run_id") REFERENCES "public"."review_runs"("review_run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_runs" ADD CONSTRAINT "review_runs_repo_id_repositories_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("repo_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_runs" ADD CONSTRAINT "review_runs_pull_request_snapshot_id_pull_request_snapshots_snapshot_id_fk" FOREIGN KEY ("pull_request_snapshot_id") REFERENCES "public"."pull_request_snapshots"("snapshot_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "symbols" ADD CONSTRAINT "symbols_index_version_id_code_index_versions_index_version_id_fk" FOREIGN KEY ("index_version_id") REFERENCES "public"."code_index_versions"("index_version_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "symbols" ADD CONSTRAINT "symbols_file_id_indexed_files_file_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."indexed_files"("file_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "symbols" ADD CONSTRAINT "symbols_repo_id_repositories_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("repo_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_org_id_orgs_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_repo_id_repositories_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("repo_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_review_run_id_review_runs_review_run_id_fk" FOREIGN KEY ("review_run_id") REFERENCES "public"."review_runs"("review_run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validated_findings" ADD CONSTRAINT "validated_findings_candidate_finding_id_candidate_findings_finding_id_fk" FOREIGN KEY ("candidate_finding_id") REFERENCES "public"."candidate_findings"("finding_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validated_findings" ADD CONSTRAINT "validated_findings_review_run_id_review_runs_review_run_id_fk" FOREIGN KEY ("review_run_id") REFERENCES "public"."review_runs"("review_run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_installation_id_provider_installations_installation_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."provider_installations"("installation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_org_id_orgs_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_repo_id_repositories_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("repo_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "background_jobs_job_key_unique" ON "background_jobs" USING btree ("queue_name","job_key");--> statement-breakpoint
CREATE UNIQUE INDEX "candidate_findings_review_fingerprint_unique" ON "candidate_findings" USING btree ("review_run_id","fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "code_chunk_embeddings_chunk_model_unique" ON "code_chunk_embeddings" USING btree ("chunk_id","embedding_model");--> statement-breakpoint
CREATE UNIQUE INDEX "code_index_versions_repo_commit_key_unique" ON "code_index_versions" USING btree ("repo_id","commit_sha","index_key");--> statement-breakpoint
CREATE UNIQUE INDEX "indexed_files_index_path_unique" ON "indexed_files" USING btree ("index_version_id","path");--> statement-breakpoint
CREATE UNIQUE INDEX "orgs_slug_unique" ON "orgs" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_installations_provider_external_unique" ON "provider_installations" USING btree ("provider","provider_installation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "publish_runs_idempotency_unique" ON "publish_runs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "pull_request_snapshots_repo_pr_head_unique" ON "pull_request_snapshots" USING btree ("repo_id","pull_request_number","head_sha");--> statement-breakpoint
CREATE UNIQUE INDEX "pull_requests_repo_number_unique" ON "pull_requests" USING btree ("repo_id","pull_request_number");--> statement-breakpoint
CREATE UNIQUE INDEX "pull_requests_provider_id_unique" ON "pull_requests" USING btree ("provider","provider_pull_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repositories_provider_repo_unique" ON "repositories" USING btree ("provider","provider_repo_id");--> statement-breakpoint
CREATE UNIQUE INDEX "review_artifacts_run_kind_name_unique" ON "review_artifacts" USING btree ("review_run_id","kind","name");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_provider_delivery_unique" ON "webhook_events" USING btree ("provider","delivery_id");