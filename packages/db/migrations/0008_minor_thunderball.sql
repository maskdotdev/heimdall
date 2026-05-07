CREATE TABLE "admin_notes" (
	"admin_note_id" text PRIMARY KEY NOT NULL,
	"actor_type" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"org_id" text,
	"repo_id" text,
	"review_run_id" text,
	"finding_id" text,
	"visibility" text NOT NULL,
	"body" text NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "replay_runs" (
	"replay_run_id" text PRIMARY KEY NOT NULL,
	"admin_action_id" text NOT NULL,
	"source_review_run_id" text,
	"org_id" text,
	"repo_id" text,
	"mode" text NOT NULL,
	"stages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"config_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text NOT NULL,
	"created_by_actor_type" text NOT NULL,
	"created_by_actor_user_id" text NOT NULL,
	"support_session_id" text,
	"reason" text NOT NULL,
	"result" jsonb,
	"error" jsonb,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "replay_stage_runs" (
	"replay_stage_run_id" text PRIMARY KEY NOT NULL,
	"replay_run_id" text NOT NULL,
	"stage" text NOT NULL,
	"status" text NOT NULL,
	"input_artifact_ref" jsonb,
	"output_artifact_ref" jsonb,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" jsonb,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admin_notes" ADD CONSTRAINT "admin_notes_org_id_orgs_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_notes" ADD CONSTRAINT "admin_notes_repo_id_repositories_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("repo_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_notes" ADD CONSTRAINT "admin_notes_review_run_id_review_runs_review_run_id_fk" FOREIGN KEY ("review_run_id") REFERENCES "public"."review_runs"("review_run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replay_runs" ADD CONSTRAINT "replay_runs_admin_action_id_admin_actions_admin_action_id_fk" FOREIGN KEY ("admin_action_id") REFERENCES "public"."admin_actions"("admin_action_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replay_runs" ADD CONSTRAINT "replay_runs_source_review_run_id_review_runs_review_run_id_fk" FOREIGN KEY ("source_review_run_id") REFERENCES "public"."review_runs"("review_run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replay_runs" ADD CONSTRAINT "replay_runs_org_id_orgs_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replay_runs" ADD CONSTRAINT "replay_runs_repo_id_repositories_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("repo_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replay_stage_runs" ADD CONSTRAINT "replay_stage_runs_replay_run_id_replay_runs_replay_run_id_fk" FOREIGN KEY ("replay_run_id") REFERENCES "public"."replay_runs"("replay_run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_notes_review_run_idx" ON "admin_notes" USING btree ("review_run_id","created_at");--> statement-breakpoint
CREATE INDEX "admin_notes_org_idx" ON "admin_notes" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "replay_runs_source_idx" ON "replay_runs" USING btree ("source_review_run_id","created_at");--> statement-breakpoint
CREATE INDEX "replay_runs_org_idx" ON "replay_runs" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "replay_runs_admin_action_idx" ON "replay_runs" USING btree ("admin_action_id");--> statement-breakpoint
CREATE INDEX "replay_stage_runs_replay_idx" ON "replay_stage_runs" USING btree ("replay_run_id","stage");