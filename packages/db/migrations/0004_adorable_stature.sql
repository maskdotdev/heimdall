CREATE TABLE "billing_provider_requests" (
	"billing_provider_request_id" text PRIMARY KEY NOT NULL,
	"org_id" text,
	"billing_account_id" text,
	"provider" text NOT NULL,
	"operation" text NOT NULL,
	"idempotency_key" text,
	"provider_request_id" text,
	"status" text NOT NULL,
	"error_code" text,
	"error_message" text,
	"request_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"response_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_provider_requests" ADD CONSTRAINT "billing_provider_requests_org_id_orgs_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_provider_requests" ADD CONSTRAINT "billing_provider_requests_billing_account_id_billing_accounts_billing_account_id_fk" FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_accounts"("billing_account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_provider_requests_account_idx" ON "billing_provider_requests" USING btree ("billing_account_id");--> statement-breakpoint
CREATE INDEX "billing_provider_requests_org_idx" ON "billing_provider_requests" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_provider_requests_idempotency_unique" ON "billing_provider_requests" USING btree ("provider","idempotency_key");