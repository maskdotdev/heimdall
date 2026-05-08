CREATE TABLE "index_import_batches" (
	"index_import_batch_id" text PRIMARY KEY NOT NULL,
	"repo_id" text NOT NULL,
	"commit_sha" text NOT NULL,
	"index_key" text NOT NULL,
	"index_version_id" text,
	"artifact_uri" text NOT NULL,
	"artifact_hash" text,
	"status" text DEFAULT 'running' NOT NULL,
	"phase" text DEFAULT 'created' NOT NULL,
	"record_count" integer DEFAULT 0 NOT NULL,
	"file_count" integer DEFAULT 0 NOT NULL,
	"symbol_count" integer DEFAULT 0 NOT NULL,
	"edge_count" integer DEFAULT 0 NOT NULL,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"embedding_job_count" integer DEFAULT 0 NOT NULL,
	"error" jsonb,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "index_import_batches" ADD CONSTRAINT "index_import_batches_repo_id_repositories_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("repo_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "index_import_batches" ADD CONSTRAINT "index_import_batches_index_version_id_code_index_versions_index_version_id_fk" FOREIGN KEY ("index_version_id") REFERENCES "public"."code_index_versions"("index_version_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "index_import_batches_repo_status_idx" ON "index_import_batches" USING btree ("repo_id","status","created_at");--> statement-breakpoint
CREATE INDEX "index_import_batches_index_version_idx" ON "index_import_batches" USING btree ("index_version_id");--> statement-breakpoint
CREATE INDEX "index_import_batches_artifact_hash_idx" ON "index_import_batches" USING btree ("artifact_hash");