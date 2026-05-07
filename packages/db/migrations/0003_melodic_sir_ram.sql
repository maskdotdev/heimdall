CREATE TABLE "credit_grants" (
	"credit_grant_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"credit_type" text NOT NULL,
	"quantity" integer NOT NULL,
	"remaining_quantity" integer NOT NULL,
	"reason" text NOT NULL,
	"source" text NOT NULL,
	"source_id" text,
	"expires_at" timestamp with time zone,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"invoice_id" text PRIMARY KEY NOT NULL,
	"billing_account_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_invoice_id" text NOT NULL,
	"status" text NOT NULL,
	"currency" text NOT NULL,
	"amount_due_micros" integer DEFAULT 0 NOT NULL,
	"amount_paid_micros" integer DEFAULT 0 NOT NULL,
	"amount_remaining_micros" integer DEFAULT 0 NOT NULL,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"hosted_invoice_url" text,
	"invoice_pdf_url" text,
	"raw_provider_invoice" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription_items" (
	"subscription_item_id" text PRIMARY KEY NOT NULL,
	"subscription_id" text NOT NULL,
	"provider_item_id" text,
	"provider_price_id" text,
	"item_type" text NOT NULL,
	"quantity" integer,
	"meter_key" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"subscription_id" text PRIMARY KEY NOT NULL,
	"billing_account_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_subscription_id" text,
	"status" text NOT NULL,
	"billing_plan_version_id" text,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"cancelled_at" timestamp with time zone,
	"trial_start" timestamp with time zone,
	"trial_end" timestamp with time zone,
	"quantity" integer,
	"raw_provider_status" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credit_grants" ADD CONSTRAINT "credit_grants_org_id_orgs_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_billing_account_id_billing_accounts_billing_account_id_fk" FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_accounts"("billing_account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_items" ADD CONSTRAINT "subscription_items_subscription_id_subscriptions_subscription_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("subscription_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_billing_account_id_billing_accounts_billing_account_id_fk" FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_accounts"("billing_account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_billing_plan_version_id_billing_plan_versions_billing_plan_version_id_fk" FOREIGN KEY ("billing_plan_version_id") REFERENCES "public"."billing_plan_versions"("billing_plan_version_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_grants_org_idx" ON "credit_grants" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "invoices_billing_account_idx" ON "invoices" USING btree ("billing_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_provider_invoice_unique" ON "invoices" USING btree ("provider","provider_invoice_id");--> statement-breakpoint
CREATE INDEX "subscription_items_subscription_idx" ON "subscription_items" USING btree ("subscription_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_items_provider_item_unique" ON "subscription_items" USING btree ("provider_item_id");--> statement-breakpoint
CREATE INDEX "subscriptions_billing_account_idx" ON "subscriptions" USING btree ("billing_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_provider_subscription_unique" ON "subscriptions" USING btree ("provider","provider_subscription_id");