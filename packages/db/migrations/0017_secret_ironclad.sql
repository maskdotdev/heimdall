CREATE TABLE "review_run_metrics" (
	"review_run_id" text PRIMARY KEY NOT NULL,
	"total_duration_ms" integer,
	"snapshot_duration_ms" integer,
	"index_wait_duration_ms" integer,
	"retrieval_duration_ms" integer,
	"review_engine_duration_ms" integer,
	"validation_duration_ms" integer,
	"publishing_duration_ms" integer,
	"candidate_findings" integer,
	"validated_findings" integer,
	"published_findings" integer,
	"rejected_findings" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"estimated_cost_usd" numeric(12, 6),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "review_run_metrics" ADD CONSTRAINT "review_run_metrics_review_run_id_review_runs_review_run_id_fk" FOREIGN KEY ("review_run_id") REFERENCES "public"."review_runs"("review_run_id") ON DELETE no action ON UPDATE no action;