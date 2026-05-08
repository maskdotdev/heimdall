CREATE TABLE "compliance_evidence" (
	"compliance_evidence_id" text PRIMARY KEY NOT NULL,
	"org_id" text,
	"control_id" text NOT NULL,
	"evidence_type" text NOT NULL,
	"evidence_uri" text NOT NULL,
	"evidence_hash" text,
	"collected_at" timestamp with time zone NOT NULL,
	"collected_by" text NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'collected' NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "compliance_evidence" ADD CONSTRAINT "compliance_evidence_org_id_orgs_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "compliance_evidence_org_control_idx" ON "compliance_evidence" USING btree ("org_id","control_id","collected_at");--> statement-breakpoint
CREATE INDEX "compliance_evidence_type_idx" ON "compliance_evidence" USING btree ("evidence_type","collected_at");--> statement-breakpoint
CREATE INDEX "compliance_evidence_status_idx" ON "compliance_evidence" USING btree ("status","collected_at");