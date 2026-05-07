CREATE TABLE "finding_duplicate_groups" (
	"finding_duplicate_group_id" text PRIMARY KEY NOT NULL,
	"review_run_id" text NOT NULL,
	"canonical_finding_id" text,
	"canonical_candidate_finding_id" text NOT NULL,
	"group_kind" text NOT NULL,
	"confidence" real,
	"reason" text,
	"group_key" text NOT NULL,
	"duplicate_finding_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"duplicate_candidate_finding_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "finding_duplicate_groups" ADD CONSTRAINT "finding_duplicate_groups_review_run_id_review_runs_review_run_id_fk" FOREIGN KEY ("review_run_id") REFERENCES "public"."review_runs"("review_run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_duplicate_groups" ADD CONSTRAINT "finding_duplicate_groups_canonical_finding_id_validated_findings_finding_id_fk" FOREIGN KEY ("canonical_finding_id") REFERENCES "public"."validated_findings"("finding_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_duplicate_groups" ADD CONSTRAINT "finding_duplicate_groups_canonical_candidate_finding_id_candidate_findings_finding_id_fk" FOREIGN KEY ("canonical_candidate_finding_id") REFERENCES "public"."candidate_findings"("finding_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "finding_duplicate_groups_review_key_unique" ON "finding_duplicate_groups" USING btree ("review_run_id","group_key");--> statement-breakpoint
CREATE INDEX "finding_duplicate_groups_review_run_idx" ON "finding_duplicate_groups" USING btree ("review_run_id");--> statement-breakpoint
CREATE INDEX "finding_duplicate_groups_canonical_candidate_idx" ON "finding_duplicate_groups" USING btree ("canonical_candidate_finding_id");
