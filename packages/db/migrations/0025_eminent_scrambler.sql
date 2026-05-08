CREATE TABLE "suppression_matches" (
	"suppression_match_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"repo_id" text NOT NULL,
	"review_run_id" text NOT NULL,
	"finding_id" text NOT NULL,
	"candidate_finding_id" text NOT NULL,
	"memory_fact_id" text NOT NULL,
	"match_kind" text NOT NULL,
	"confidence" real NOT NULL,
	"reason" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "suppression_matches" ADD CONSTRAINT "suppression_matches_org_id_orgs_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppression_matches" ADD CONSTRAINT "suppression_matches_repo_id_repositories_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("repo_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppression_matches" ADD CONSTRAINT "suppression_matches_review_run_id_review_runs_review_run_id_fk" FOREIGN KEY ("review_run_id") REFERENCES "public"."review_runs"("review_run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppression_matches" ADD CONSTRAINT "suppression_matches_finding_id_validated_findings_finding_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."validated_findings"("finding_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppression_matches" ADD CONSTRAINT "suppression_matches_candidate_finding_id_candidate_findings_finding_id_fk" FOREIGN KEY ("candidate_finding_id") REFERENCES "public"."candidate_findings"("finding_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppression_matches" ADD CONSTRAINT "suppression_matches_memory_fact_id_memory_facts_memory_fact_id_fk" FOREIGN KEY ("memory_fact_id") REFERENCES "public"."memory_facts"("memory_fact_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "suppression_matches_review_candidate_fact_unique" ON "suppression_matches" USING btree ("review_run_id","candidate_finding_id","memory_fact_id","match_kind");--> statement-breakpoint
CREATE INDEX "suppression_matches_org_repo_created_idx" ON "suppression_matches" USING btree ("org_id","repo_id","created_at");--> statement-breakpoint
CREATE INDEX "suppression_matches_review_run_idx" ON "suppression_matches" USING btree ("review_run_id");--> statement-breakpoint
CREATE INDEX "suppression_matches_memory_fact_idx" ON "suppression_matches" USING btree ("memory_fact_id");--> statement-breakpoint
CREATE INDEX "suppression_matches_finding_idx" ON "suppression_matches" USING btree ("finding_id");