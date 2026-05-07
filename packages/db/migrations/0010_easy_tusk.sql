CREATE TABLE "finding_validation_events" (
	"finding_validation_event_id" text PRIMARY KEY NOT NULL,
	"review_run_id" text NOT NULL,
	"finding_id" text,
	"candidate_finding_id" text NOT NULL,
	"stage" text NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"message" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "finding_validation_events" ADD CONSTRAINT "finding_validation_events_review_run_id_review_runs_review_run_id_fk" FOREIGN KEY ("review_run_id") REFERENCES "public"."review_runs"("review_run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_validation_events" ADD CONSTRAINT "finding_validation_events_finding_id_validated_findings_finding_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."validated_findings"("finding_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_validation_events" ADD CONSTRAINT "finding_validation_events_candidate_finding_id_candidate_findings_finding_id_fk" FOREIGN KEY ("candidate_finding_id") REFERENCES "public"."candidate_findings"("finding_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "finding_validation_events_review_run_idx" ON "finding_validation_events" USING btree ("review_run_id");--> statement-breakpoint
CREATE INDEX "finding_validation_events_candidate_idx" ON "finding_validation_events" USING btree ("candidate_finding_id");--> statement-breakpoint
CREATE INDEX "finding_validation_events_finding_idx" ON "finding_validation_events" USING btree ("finding_id");
