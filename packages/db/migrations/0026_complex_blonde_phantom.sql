CREATE TABLE "org_settings" (
	"org_id" text PRIMARY KEY NOT NULL,
	"settings_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_org_id_orgs_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_updated_by_user_id_users_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("user_id") ON DELETE no action ON UPDATE no action;