CREATE TABLE "eval_baselines" (
	"eval_suite_id" text NOT NULL,
	"baseline_variant_id" text NOT NULL,
	"eval_run_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "eval_baselines_eval_suite_id_baseline_variant_id_pk" PRIMARY KEY("eval_suite_id","baseline_variant_id")
);
--> statement-breakpoint
CREATE TABLE "eval_case_results" (
	"eval_case_result_id" text PRIMARY KEY NOT NULL,
	"eval_run_id" text NOT NULL,
	"eval_case_id" text NOT NULL,
	"status" text NOT NULL,
	"scores" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"matched_findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"unmatched_expected_findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"unmatched_generated_findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"timings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"costs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"artifacts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_cases" (
	"eval_case_id" text PRIMARY KEY NOT NULL,
	"eval_suite_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"language" text NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source" text NOT NULL,
	"privacy_level" text NOT NULL,
	"difficulty" text NOT NULL,
	"fixture" jsonb NOT NULL,
	"input" jsonb NOT NULL,
	"labels" jsonb NOT NULL,
	"expected" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_human_labels" (
	"eval_human_label_id" text PRIMARY KEY NOT NULL,
	"eval_case_id" text NOT NULL,
	"finding_fingerprint" text,
	"labeler_user_id" text,
	"label" jsonb NOT NULL,
	"adjudication_status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_runs" (
	"eval_run_id" text PRIMARY KEY NOT NULL,
	"eval_suite_id" text NOT NULL,
	"eval_variant_id" text NOT NULL,
	"baseline_variant_id" text,
	"status" text NOT NULL,
	"triggered_by" text NOT NULL,
	"environment" text NOT NULL,
	"git_commit_sha" text,
	"branch" text,
	"case_count" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"report_uri" text,
	"summary" jsonb,
	"error" jsonb
);
--> statement-breakpoint
CREATE TABLE "eval_suites" (
	"eval_suite_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"version" text NOT NULL,
	"owner" text NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"default_runner" text NOT NULL,
	"default_graders" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"thresholds" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_variants" (
	"eval_variant_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"config" jsonb NOT NULL,
	"git_commit_sha" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "eval_baselines" ADD CONSTRAINT "eval_baselines_eval_suite_id_eval_suites_eval_suite_id_fk" FOREIGN KEY ("eval_suite_id") REFERENCES "public"."eval_suites"("eval_suite_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_baselines" ADD CONSTRAINT "eval_baselines_baseline_variant_id_eval_variants_eval_variant_id_fk" FOREIGN KEY ("baseline_variant_id") REFERENCES "public"."eval_variants"("eval_variant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_baselines" ADD CONSTRAINT "eval_baselines_eval_run_id_eval_runs_eval_run_id_fk" FOREIGN KEY ("eval_run_id") REFERENCES "public"."eval_runs"("eval_run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_case_results" ADD CONSTRAINT "eval_case_results_eval_run_id_eval_runs_eval_run_id_fk" FOREIGN KEY ("eval_run_id") REFERENCES "public"."eval_runs"("eval_run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_case_results" ADD CONSTRAINT "eval_case_results_eval_case_id_eval_cases_eval_case_id_fk" FOREIGN KEY ("eval_case_id") REFERENCES "public"."eval_cases"("eval_case_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_cases" ADD CONSTRAINT "eval_cases_eval_suite_id_eval_suites_eval_suite_id_fk" FOREIGN KEY ("eval_suite_id") REFERENCES "public"."eval_suites"("eval_suite_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_human_labels" ADD CONSTRAINT "eval_human_labels_eval_case_id_eval_cases_eval_case_id_fk" FOREIGN KEY ("eval_case_id") REFERENCES "public"."eval_cases"("eval_case_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_human_labels" ADD CONSTRAINT "eval_human_labels_labeler_user_id_users_user_id_fk" FOREIGN KEY ("labeler_user_id") REFERENCES "public"."users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_eval_suite_id_eval_suites_eval_suite_id_fk" FOREIGN KEY ("eval_suite_id") REFERENCES "public"."eval_suites"("eval_suite_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_eval_variant_id_eval_variants_eval_variant_id_fk" FOREIGN KEY ("eval_variant_id") REFERENCES "public"."eval_variants"("eval_variant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_baseline_variant_id_eval_variants_eval_variant_id_fk" FOREIGN KEY ("baseline_variant_id") REFERENCES "public"."eval_variants"("eval_variant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "eval_baselines_active_idx" ON "eval_baselines" USING btree ("eval_suite_id","active");--> statement-breakpoint
CREATE INDEX "eval_baselines_run_idx" ON "eval_baselines" USING btree ("eval_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "eval_case_results_run_case_unique" ON "eval_case_results" USING btree ("eval_run_id","eval_case_id");--> statement-breakpoint
CREATE INDEX "eval_case_results_case_idx" ON "eval_case_results" USING btree ("eval_case_id");--> statement-breakpoint
CREATE INDEX "eval_case_results_status_idx" ON "eval_case_results" USING btree ("status");--> statement-breakpoint
CREATE INDEX "eval_cases_suite_active_idx" ON "eval_cases" USING btree ("eval_suite_id","active");--> statement-breakpoint
CREATE INDEX "eval_cases_source_idx" ON "eval_cases" USING btree ("source");--> statement-breakpoint
CREATE INDEX "eval_cases_privacy_idx" ON "eval_cases" USING btree ("privacy_level");--> statement-breakpoint
CREATE INDEX "eval_human_labels_case_idx" ON "eval_human_labels" USING btree ("eval_case_id");--> statement-breakpoint
CREATE INDEX "eval_human_labels_labeler_idx" ON "eval_human_labels" USING btree ("labeler_user_id");--> statement-breakpoint
CREATE INDEX "eval_human_labels_status_idx" ON "eval_human_labels" USING btree ("adjudication_status");--> statement-breakpoint
CREATE INDEX "eval_runs_suite_started_idx" ON "eval_runs" USING btree ("eval_suite_id","started_at");--> statement-breakpoint
CREATE INDEX "eval_runs_variant_started_idx" ON "eval_runs" USING btree ("eval_variant_id","started_at");--> statement-breakpoint
CREATE INDEX "eval_runs_status_idx" ON "eval_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "eval_runs_git_commit_idx" ON "eval_runs" USING btree ("git_commit_sha");--> statement-breakpoint
CREATE INDEX "eval_suites_owner_idx" ON "eval_suites" USING btree ("owner");--> statement-breakpoint
CREATE UNIQUE INDEX "eval_suites_name_version_unique" ON "eval_suites" USING btree ("name","version");--> statement-breakpoint
CREATE INDEX "eval_variants_git_commit_idx" ON "eval_variants" USING btree ("git_commit_sha");--> statement-breakpoint
CREATE INDEX "eval_variants_created_by_idx" ON "eval_variants" USING btree ("created_by");