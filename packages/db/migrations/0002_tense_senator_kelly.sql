CREATE TABLE "quota_counters" (
	"quota_counter_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"quota_key" text NOT NULL,
	"period_key" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"used_quantity" integer DEFAULT 0 NOT NULL,
	"reserved_quantity" integer DEFAULT 0 NOT NULL,
	"limit_quantity" integer,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quota_reservations" (
	"quota_reservation_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"quota_counter_id" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"quantity" integer NOT NULL,
	"status" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "quota_counters" ADD CONSTRAINT "quota_counters_org_id_orgs_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quota_reservations" ADD CONSTRAINT "quota_reservations_org_id_orgs_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quota_reservations" ADD CONSTRAINT "quota_reservations_quota_counter_id_quota_counters_quota_counter_id_fk" FOREIGN KEY ("quota_counter_id") REFERENCES "public"."quota_counters"("quota_counter_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "quota_counters_org_quota_period_unique" ON "quota_counters" USING btree ("org_id","quota_key","period_key");--> statement-breakpoint
CREATE UNIQUE INDEX "quota_reservations_source_counter_unique" ON "quota_reservations" USING btree ("source_type","source_id","quota_counter_id");