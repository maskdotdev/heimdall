CREATE TABLE "billing_meter_events" (
	"billing_meter_event_id" text PRIMARY KEY NOT NULL,
	"billing_account_id" text NOT NULL,
	"org_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_customer_id" text NOT NULL,
	"meter_key" text NOT NULL,
	"provider_event_name" text NOT NULL,
	"period_key" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"quantity" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text NOT NULL,
	"provider_meter_event_id" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"last_error_message" text,
	"source_usage_event_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_meter_events" ADD CONSTRAINT "billing_meter_events_billing_account_id_billing_accounts_billing_account_id_fk" FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_accounts"("billing_account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_meter_events" ADD CONSTRAINT "billing_meter_events_org_id_orgs_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_meter_events_account_status_idx" ON "billing_meter_events" USING btree ("billing_account_id","status");--> statement-breakpoint
CREATE INDEX "billing_meter_events_org_period_idx" ON "billing_meter_events" USING btree ("org_id","period_key");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_meter_events_idempotency_unique" ON "billing_meter_events" USING btree ("provider","idempotency_key");