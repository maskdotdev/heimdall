CREATE TABLE "feedback_events" (
	"feedback_event_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"repo_id" text NOT NULL,
	"provider" text NOT NULL,
	"source" text NOT NULL,
	"event_kind" text NOT NULL,
	"external_event_id" text,
	"webhook_event_id" text,
	"actor_login" text,
	"actor_provider_user_id" text,
	"actor_association" text,
	"actor_permission" text,
	"actor_is_bot" boolean DEFAULT false NOT NULL,
	"pull_request_number" integer,
	"review_run_id" text,
	"published_finding_id" text,
	"external_comment_id" text,
	"external_thread_id" text,
	"payload_redacted" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback_signals" (
	"feedback_signal_id" text PRIMARY KEY NOT NULL,
	"feedback_event_id" text NOT NULL,
	"published_finding_id" text,
	"signal_kind" text NOT NULL,
	"polarity" text NOT NULL,
	"strength" real NOT NULL,
	"confidence" real NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "feedback_events" ADD CONSTRAINT "feedback_events_org_id_orgs_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_events" ADD CONSTRAINT "feedback_events_repo_id_repositories_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("repo_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_events" ADD CONSTRAINT "feedback_events_review_run_id_review_runs_review_run_id_fk" FOREIGN KEY ("review_run_id") REFERENCES "public"."review_runs"("review_run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_events" ADD CONSTRAINT "feedback_events_published_finding_id_published_findings_finding_id_fk" FOREIGN KEY ("published_finding_id") REFERENCES "public"."published_findings"("finding_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_signals" ADD CONSTRAINT "feedback_signals_feedback_event_id_feedback_events_feedback_event_id_fk" FOREIGN KEY ("feedback_event_id") REFERENCES "public"."feedback_events"("feedback_event_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_signals" ADD CONSTRAINT "feedback_signals_published_finding_id_published_findings_finding_id_fk" FOREIGN KEY ("published_finding_id") REFERENCES "public"."published_findings"("finding_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feedback_events_org_repo_received_idx" ON "feedback_events" USING btree ("org_id","repo_id","received_at");--> statement-breakpoint
CREATE INDEX "feedback_events_published_finding_idx" ON "feedback_events" USING btree ("published_finding_id");--> statement-breakpoint
CREATE INDEX "feedback_events_external_comment_idx" ON "feedback_events" USING btree ("provider","external_comment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_events_provider_external_unique" ON "feedback_events" USING btree ("provider","external_event_id");--> statement-breakpoint
CREATE INDEX "feedback_signals_event_idx" ON "feedback_signals" USING btree ("feedback_event_id");--> statement-breakpoint
CREATE INDEX "feedback_signals_published_finding_idx" ON "feedback_signals" USING btree ("published_finding_id");