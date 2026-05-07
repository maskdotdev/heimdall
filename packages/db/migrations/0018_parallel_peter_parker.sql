CREATE TABLE "security_events" (
	"security_event_id" text PRIMARY KEY NOT NULL,
	"org_id" text,
	"repo_id" text,
	"type" text NOT NULL,
	"severity" text NOT NULL,
	"source" text NOT NULL,
	"status" text NOT NULL,
	"actor_id" text,
	"resource_type" text,
	"resource_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_org_id_orgs_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_repo_id_repositories_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("repo_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "security_events_org_idx" ON "security_events" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "security_events_repo_idx" ON "security_events" USING btree ("repo_id","created_at");--> statement-breakpoint
CREATE INDEX "security_events_severity_idx" ON "security_events" USING btree ("severity","created_at");--> statement-breakpoint
CREATE INDEX "security_events_status_idx" ON "security_events" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "security_events_type_idx" ON "security_events" USING btree ("type","created_at");--> statement-breakpoint
CREATE INDEX "security_events_actor_idx" ON "security_events" USING btree ("actor_id","created_at");