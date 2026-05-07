CREATE TABLE "memory_candidates" (
	"memory_candidate_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"repo_id" text,
	"source_kind" text NOT NULL,
	"candidate_kind" text NOT NULL,
	"proposed_content" text NOT NULL,
	"proposed_scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"proposed_applies_to" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"confidence" real NOT NULL,
	"trust_level" text NOT NULL,
	"status" text NOT NULL,
	"created_by_login" text,
	"source_feedback_event_id" text,
	"source_finding_id" text,
	"approved_memory_fact_id" text,
	"decided_by_user_id" text,
	"decided_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_candidates" ADD CONSTRAINT "memory_candidates_org_id_orgs_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_candidates" ADD CONSTRAINT "memory_candidates_repo_id_repositories_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("repo_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_candidates" ADD CONSTRAINT "memory_candidates_source_finding_id_published_findings_finding_id_fk" FOREIGN KEY ("source_finding_id") REFERENCES "public"."published_findings"("finding_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_candidates" ADD CONSTRAINT "memory_candidates_approved_memory_fact_id_memory_facts_memory_fact_id_fk" FOREIGN KEY ("approved_memory_fact_id") REFERENCES "public"."memory_facts"("memory_fact_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_candidates" ADD CONSTRAINT "memory_candidates_decided_by_user_id_users_user_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_candidates_org_repo_status_idx" ON "memory_candidates" USING btree ("org_id","repo_id","status");--> statement-breakpoint
CREATE INDEX "memory_candidates_source_finding_idx" ON "memory_candidates" USING btree ("source_finding_id");--> statement-breakpoint
CREATE INDEX "memory_candidates_approved_fact_idx" ON "memory_candidates" USING btree ("approved_memory_fact_id");