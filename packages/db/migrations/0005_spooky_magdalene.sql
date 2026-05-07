CREATE TABLE "billing_webhook_events" (
	"billing_webhook_event_id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"org_id" text,
	"billing_account_id" text,
	"provider_customer_id" text,
	"provider_subscription_id" text,
	"status" text NOT NULL,
	"payload_hash" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" jsonb,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_webhook_events" ADD CONSTRAINT "billing_webhook_events_org_id_orgs_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_webhook_events" ADD CONSTRAINT "billing_webhook_events_billing_account_id_billing_accounts_billing_account_id_fk" FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_accounts"("billing_account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_webhook_events_account_idx" ON "billing_webhook_events" USING btree ("billing_account_id");--> statement-breakpoint
CREATE INDEX "billing_webhook_events_org_idx" ON "billing_webhook_events" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_webhook_events_provider_event_unique" ON "billing_webhook_events" USING btree ("provider","provider_event_id");