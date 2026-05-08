CREATE TABLE "data_deletion_requests" (
	"data_deletion_request_id" text PRIMARY KEY NOT NULL,
	"org_id" text,
	"user_id" text,
	"repo_id" text,
	"reason" text NOT NULL,
	"scope" text NOT NULL,
	"status" text NOT NULL,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"verification_artifact_uri" text,
	"manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "data_deletion_requests" ADD CONSTRAINT "data_deletion_requests_org_id_orgs_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_deletion_requests" ADD CONSTRAINT "data_deletion_requests_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_deletion_requests" ADD CONSTRAINT "data_deletion_requests_repo_id_repositories_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("repo_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_deletion_requests_org_status_idx" ON "data_deletion_requests" USING btree ("org_id","status","requested_at");--> statement-breakpoint
CREATE INDEX "data_deletion_requests_repo_status_idx" ON "data_deletion_requests" USING btree ("repo_id","status","requested_at");--> statement-breakpoint
CREATE INDEX "data_deletion_requests_status_requested_idx" ON "data_deletion_requests" USING btree ("status","requested_at");