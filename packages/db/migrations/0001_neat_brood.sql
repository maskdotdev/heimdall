CREATE TABLE "billing_accounts" (
	"billing_account_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"billing_mode" text NOT NULL,
	"status" text NOT NULL,
	"provider" text DEFAULT 'stripe' NOT NULL,
	"provider_customer_id" text,
	"billing_email" text,
	"billing_name" text,
	"billing_country" text,
	"current_plan_key" text,
	"current_plan_version_id" text,
	"trial_ends_at" timestamp with time zone,
	"grace_period_ends_at" timestamp with time zone,
	"payment_status" text DEFAULT 'not_required' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_plan_versions" (
	"billing_plan_version_id" text PRIMARY KEY NOT NULL,
	"billing_plan_id" text NOT NULL,
	"version" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"provider" text,
	"provider_product_id" text,
	"provider_base_price_id" text,
	"currency" text DEFAULT 'usd' NOT NULL,
	"base_amount_micros" integer,
	"billing_interval" text,
	"included" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"limits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"features" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"overage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_plans" (
	"billing_plan_id" text PRIMARY KEY NOT NULL,
	"plan_key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"audience" text NOT NULL,
	"public" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entitlements" (
	"entitlement_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"feature_key" text NOT NULL,
	"enabled" boolean NOT NULL,
	"source" text NOT NULL,
	"source_id" text,
	"value" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD CONSTRAINT "billing_accounts_org_id_orgs_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_plan_versions" ADD CONSTRAINT "billing_plan_versions_billing_plan_id_billing_plans_billing_plan_id_fk" FOREIGN KEY ("billing_plan_id") REFERENCES "public"."billing_plans"("billing_plan_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_org_id_orgs_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_accounts_org_unique" ON "billing_accounts" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_plan_versions_plan_version_unique" ON "billing_plan_versions" USING btree ("billing_plan_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_plans_plan_key_unique" ON "billing_plans" USING btree ("plan_key");--> statement-breakpoint
CREATE UNIQUE INDEX "entitlements_org_feature_source_effective_unique" ON "entitlements" USING btree ("org_id","feature_key","source","effective_from");--> statement-breakpoint
CREATE INDEX "entitlements_active_idx" ON "entitlements" USING btree ("org_id","feature_key","effective_from","effective_to");