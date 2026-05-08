CREATE TABLE "code_dependencies" (
	"dependency_id" text PRIMARY KEY NOT NULL,
	"index_version_id" text NOT NULL,
	"repo_id" text NOT NULL,
	"commit_sha" text NOT NULL,
	"manifest_path" text NOT NULL,
	"package_manager" text,
	"name" text NOT NULL,
	"version_spec" text,
	"resolved_version" text,
	"dependency_type" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "code_index_diagnostics" (
	"diagnostic_id" text PRIMARY KEY NOT NULL,
	"index_version_id" text NOT NULL,
	"repo_id" text NOT NULL,
	"commit_sha" text NOT NULL,
	"path" text,
	"start_line" integer,
	"end_line" integer,
	"source" text NOT NULL,
	"severity" text NOT NULL,
	"code" text,
	"message" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "code_routes" (
	"route_id" text PRIMARY KEY NOT NULL,
	"index_version_id" text NOT NULL,
	"repo_id" text NOT NULL,
	"commit_sha" text NOT NULL,
	"path" text NOT NULL,
	"language" text NOT NULL,
	"route_pattern" text NOT NULL,
	"methods" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"handler_symbol_id" text,
	"start_line" integer,
	"end_line" integer,
	"framework" text,
	"confidence" real NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "code_test_mappings" (
	"test_mapping_id" text PRIMARY KEY NOT NULL,
	"index_version_id" text NOT NULL,
	"repo_id" text NOT NULL,
	"commit_sha" text NOT NULL,
	"test_file_id" text NOT NULL,
	"target_file_id" text,
	"target_symbol_id" text,
	"confidence" real NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "code_index_versions" ADD COLUMN "diagnostic_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "code_index_versions" ADD COLUMN "dependency_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "code_index_versions" ADD COLUMN "route_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "code_index_versions" ADD COLUMN "test_mapping_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "index_import_batches" ADD COLUMN "diagnostic_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "index_import_batches" ADD COLUMN "dependency_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "index_import_batches" ADD COLUMN "route_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "index_import_batches" ADD COLUMN "test_mapping_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "code_dependencies" ADD CONSTRAINT "code_dependencies_index_version_id_code_index_versions_index_version_id_fk" FOREIGN KEY ("index_version_id") REFERENCES "public"."code_index_versions"("index_version_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_dependencies" ADD CONSTRAINT "code_dependencies_repo_id_repositories_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("repo_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_index_diagnostics" ADD CONSTRAINT "code_index_diagnostics_index_version_id_code_index_versions_index_version_id_fk" FOREIGN KEY ("index_version_id") REFERENCES "public"."code_index_versions"("index_version_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_index_diagnostics" ADD CONSTRAINT "code_index_diagnostics_repo_id_repositories_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("repo_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_routes" ADD CONSTRAINT "code_routes_index_version_id_code_index_versions_index_version_id_fk" FOREIGN KEY ("index_version_id") REFERENCES "public"."code_index_versions"("index_version_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_routes" ADD CONSTRAINT "code_routes_repo_id_repositories_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("repo_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_routes" ADD CONSTRAINT "code_routes_handler_symbol_id_symbols_symbol_id_fk" FOREIGN KEY ("handler_symbol_id") REFERENCES "public"."symbols"("symbol_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_test_mappings" ADD CONSTRAINT "code_test_mappings_index_version_id_code_index_versions_index_version_id_fk" FOREIGN KEY ("index_version_id") REFERENCES "public"."code_index_versions"("index_version_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_test_mappings" ADD CONSTRAINT "code_test_mappings_repo_id_repositories_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("repo_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_test_mappings" ADD CONSTRAINT "code_test_mappings_test_file_id_indexed_files_file_id_fk" FOREIGN KEY ("test_file_id") REFERENCES "public"."indexed_files"("file_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_test_mappings" ADD CONSTRAINT "code_test_mappings_target_file_id_indexed_files_file_id_fk" FOREIGN KEY ("target_file_id") REFERENCES "public"."indexed_files"("file_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_test_mappings" ADD CONSTRAINT "code_test_mappings_target_symbol_id_symbols_symbol_id_fk" FOREIGN KEY ("target_symbol_id") REFERENCES "public"."symbols"("symbol_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "code_dependencies_index_version_idx" ON "code_dependencies" USING btree ("index_version_id");--> statement-breakpoint
CREATE INDEX "code_dependencies_repo_name_idx" ON "code_dependencies" USING btree ("repo_id","name");--> statement-breakpoint
CREATE INDEX "code_index_diagnostics_index_version_idx" ON "code_index_diagnostics" USING btree ("index_version_id");--> statement-breakpoint
CREATE INDEX "code_index_diagnostics_repo_severity_idx" ON "code_index_diagnostics" USING btree ("repo_id","severity");--> statement-breakpoint
CREATE INDEX "code_routes_index_version_idx" ON "code_routes" USING btree ("index_version_id");--> statement-breakpoint
CREATE INDEX "code_routes_repo_pattern_idx" ON "code_routes" USING btree ("repo_id","route_pattern");--> statement-breakpoint
CREATE INDEX "code_test_mappings_index_version_idx" ON "code_test_mappings" USING btree ("index_version_id");--> statement-breakpoint
CREATE INDEX "code_test_mappings_target_file_idx" ON "code_test_mappings" USING btree ("target_file_id");