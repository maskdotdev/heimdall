CREATE TABLE "queue_health_snapshots" (
	"queue_health_snapshot_id" text PRIMARY KEY NOT NULL,
	"queue_name" text NOT NULL,
	"waiting_count" integer DEFAULT 0 NOT NULL,
	"delayed_count" integer DEFAULT 0 NOT NULL,
	"active_count" integer DEFAULT 0 NOT NULL,
	"completed_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"oldest_waiting_age_ms" integer DEFAULT 0 NOT NULL,
	"sampled_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "queue_health_snapshots_queue_sampled_idx" ON "queue_health_snapshots" USING btree ("queue_name","sampled_at");