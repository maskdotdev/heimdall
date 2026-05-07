CREATE TABLE "embedding_job_items" (
	"embedding_job_item_id" text PRIMARY KEY NOT NULL,
	"embedding_job_id" text NOT NULL,
	"chunk_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"cache_key" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"last_error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "embedding_jobs" (
	"embedding_job_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"repo_id" text NOT NULL,
	"index_version_id" text,
	"commit_sha" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text NOT NULL,
	"embedding_profile_version" text DEFAULT 'code_embedding_profile.v1' NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"dimensions" integer NOT NULL,
	"chunk_count_planned" integer DEFAULT 0 NOT NULL,
	"chunk_count_embedded" integer DEFAULT 0 NOT NULL,
	"chunk_count_skipped" integer DEFAULT 0 NOT NULL,
	"chunk_count_failed" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"locked_by" text,
	"locked_at" timestamp with time zone,
	"last_error_code" text,
	"last_error_message" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "embedding_job_items" ADD CONSTRAINT "embedding_job_items_embedding_job_id_embedding_jobs_embedding_job_id_fk" FOREIGN KEY ("embedding_job_id") REFERENCES "public"."embedding_jobs"("embedding_job_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embedding_job_items" ADD CONSTRAINT "embedding_job_items_chunk_id_code_chunks_chunk_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."code_chunks"("chunk_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embedding_jobs" ADD CONSTRAINT "embedding_jobs_org_id_orgs_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embedding_jobs" ADD CONSTRAINT "embedding_jobs_repo_id_repositories_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("repo_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embedding_jobs" ADD CONSTRAINT "embedding_jobs_index_version_id_code_index_versions_index_version_id_fk" FOREIGN KEY ("index_version_id") REFERENCES "public"."code_index_versions"("index_version_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "embedding_job_items_job_chunk_unique" ON "embedding_job_items" USING btree ("embedding_job_id","chunk_id");--> statement-breakpoint
CREATE INDEX "embedding_job_items_status_idx" ON "embedding_job_items" USING btree ("embedding_job_id","status");--> statement-breakpoint
CREATE INDEX "embedding_jobs_repo_status_idx" ON "embedding_jobs" USING btree ("repo_id","status","created_at");--> statement-breakpoint
CREATE INDEX "embedding_jobs_index_version_idx" ON "embedding_jobs" USING btree ("index_version_id");