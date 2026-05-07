CREATE TABLE "admin_actions" (
	"admin_action_id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"org_id" text,
	"repo_id" text,
	"review_run_id" text,
	"support_session_id" text,
	"reason" text NOT NULL,
	"request" jsonb NOT NULL,
	"result" jsonb,
	"error" jsonb,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifact_access_events" (
	"artifact_access_event_id" text PRIMARY KEY NOT NULL,
	"actor_type" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"org_id" text,
	"repo_id" text,
	"review_run_id" text,
	"artifact_ref" jsonb NOT NULL,
	"access_level" text NOT NULL,
	"support_session_id" text,
	"reason" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "debug_exports" (
	"debug_export_id" text PRIMARY KEY NOT NULL,
	"admin_action_id" text NOT NULL,
	"org_id" text NOT NULL,
	"repo_id" text,
	"review_run_id" text,
	"export_kind" text NOT NULL,
	"artifact_uri" text,
	"artifact_hash" text,
	"redaction_level" text NOT NULL,
	"status" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by_actor_type" text NOT NULL,
	"created_by_actor_user_id" text NOT NULL,
	"completed_at" timestamp with time zone,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admin_actions" ADD CONSTRAINT "admin_actions_org_id_orgs_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_actions" ADD CONSTRAINT "admin_actions_repo_id_repositories_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("repo_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_actions" ADD CONSTRAINT "admin_actions_review_run_id_review_runs_review_run_id_fk" FOREIGN KEY ("review_run_id") REFERENCES "public"."review_runs"("review_run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_access_events" ADD CONSTRAINT "artifact_access_events_org_id_orgs_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_access_events" ADD CONSTRAINT "artifact_access_events_repo_id_repositories_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("repo_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_access_events" ADD CONSTRAINT "artifact_access_events_review_run_id_review_runs_review_run_id_fk" FOREIGN KEY ("review_run_id") REFERENCES "public"."review_runs"("review_run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debug_exports" ADD CONSTRAINT "debug_exports_admin_action_id_admin_actions_admin_action_id_fk" FOREIGN KEY ("admin_action_id") REFERENCES "public"."admin_actions"("admin_action_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debug_exports" ADD CONSTRAINT "debug_exports_org_id_orgs_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debug_exports" ADD CONSTRAINT "debug_exports_repo_id_repositories_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("repo_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debug_exports" ADD CONSTRAINT "debug_exports_review_run_id_review_runs_review_run_id_fk" FOREIGN KEY ("review_run_id") REFERENCES "public"."review_runs"("review_run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_actions_org_idx" ON "admin_actions" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "admin_actions_actor_idx" ON "admin_actions" USING btree ("actor_user_id","created_at");--> statement-breakpoint
CREATE INDEX "admin_actions_review_run_idx" ON "admin_actions" USING btree ("review_run_id","created_at");--> statement-breakpoint
CREATE INDEX "artifact_access_events_org_idx" ON "artifact_access_events" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "artifact_access_events_review_idx" ON "artifact_access_events" USING btree ("review_run_id","created_at");--> statement-breakpoint
CREATE INDEX "debug_exports_org_idx" ON "debug_exports" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "debug_exports_review_run_idx" ON "debug_exports" USING btree ("review_run_id","created_at");