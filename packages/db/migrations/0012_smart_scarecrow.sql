CREATE TABLE "publish_plans" (
	"publish_plan_id" text PRIMARY KEY NOT NULL,
	"review_run_id" text NOT NULL,
	"review_artifact_id" text,
	"head_sha" text NOT NULL,
	"mode" text NOT NULL,
	"inline_comments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"file_comments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"check_annotations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "publish_plans" ADD CONSTRAINT "publish_plans_review_run_id_review_runs_review_run_id_fk" FOREIGN KEY ("review_run_id") REFERENCES "public"."review_runs"("review_run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_plans" ADD CONSTRAINT "publish_plans_review_artifact_id_review_artifacts_review_artifact_id_fk" FOREIGN KEY ("review_artifact_id") REFERENCES "public"."review_artifacts"("review_artifact_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "publish_plans_review_run_unique" ON "publish_plans" USING btree ("review_run_id");--> statement-breakpoint
CREATE INDEX "publish_plans_review_artifact_idx" ON "publish_plans" USING btree ("review_artifact_id");
