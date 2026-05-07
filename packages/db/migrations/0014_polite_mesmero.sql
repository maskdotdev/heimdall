CREATE TABLE "sandbox_artifacts" (
	"sandbox_artifact_id" text PRIMARY KEY NOT NULL,
	"sandbox_run_id" text NOT NULL,
	"name" text NOT NULL,
	"uri" text NOT NULL,
	"sha256" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"content_type" text,
	"truncated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sandbox_policy_decisions" (
	"sandbox_policy_decision_id" text PRIMARY KEY NOT NULL,
	"sandbox_run_id" text NOT NULL,
	"status" text NOT NULL,
	"code" text NOT NULL,
	"message" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sandbox_runs" (
	"sandbox_run_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"repo_id" text NOT NULL,
	"review_run_id" text,
	"static_analysis_run_id" text,
	"tool_run_id" text,
	"request_id" text NOT NULL,
	"runner_kind" text NOT NULL,
	"trust_level" text NOT NULL,
	"category" text NOT NULL,
	"image" text NOT NULL,
	"image_digest" text,
	"command_json" jsonb NOT NULL,
	"policy_json" jsonb NOT NULL,
	"limits_json" jsonb NOT NULL,
	"status" text NOT NULL,
	"exit_code" integer,
	"signal" text,
	"stdout_hash" text,
	"stderr_hash" text,
	"stdout_truncated" boolean DEFAULT false NOT NULL,
	"stderr_truncated" boolean DEFAULT false NOT NULL,
	"resource_usage_json" jsonb,
	"error_json" jsonb,
	"warnings_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sandbox_artifacts" ADD CONSTRAINT "sandbox_artifacts_sandbox_run_id_sandbox_runs_sandbox_run_id_fk" FOREIGN KEY ("sandbox_run_id") REFERENCES "public"."sandbox_runs"("sandbox_run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_policy_decisions" ADD CONSTRAINT "sandbox_policy_decisions_sandbox_run_id_sandbox_runs_sandbox_run_id_fk" FOREIGN KEY ("sandbox_run_id") REFERENCES "public"."sandbox_runs"("sandbox_run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_runs" ADD CONSTRAINT "sandbox_runs_org_id_orgs_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_runs" ADD CONSTRAINT "sandbox_runs_repo_id_repositories_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("repo_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_runs" ADD CONSTRAINT "sandbox_runs_review_run_id_review_runs_review_run_id_fk" FOREIGN KEY ("review_run_id") REFERENCES "public"."review_runs"("review_run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_artifacts_run_name_unique" ON "sandbox_artifacts" USING btree ("sandbox_run_id","name");--> statement-breakpoint
CREATE INDEX "sandbox_policy_decisions_run_idx" ON "sandbox_policy_decisions" USING btree ("sandbox_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_runs_request_id_unique" ON "sandbox_runs" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "sandbox_runs_review_run_idx" ON "sandbox_runs" USING btree ("review_run_id");--> statement-breakpoint
CREATE INDEX "sandbox_runs_repo_created_idx" ON "sandbox_runs" USING btree ("repo_id","created_at");--> statement-breakpoint
CREATE INDEX "sandbox_runs_status_idx" ON "sandbox_runs" USING btree ("status");