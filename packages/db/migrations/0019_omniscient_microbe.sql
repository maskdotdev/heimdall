ALTER TABLE "code_chunk_embeddings" ADD COLUMN "input_hash" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "code_chunk_embeddings" ADD COLUMN "input_kind" text DEFAULT 'code_chunk' NOT NULL;--> statement-breakpoint
ALTER TABLE "code_chunk_embeddings" ADD COLUMN "embedding_cache_key" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "code_chunk_embeddings" ADD COLUMN "embedding_profile_version" text DEFAULT 'code_embedding_profile.v1' NOT NULL;--> statement-breakpoint
ALTER TABLE "code_chunk_embeddings" ADD COLUMN "provider" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
CREATE INDEX "code_chunk_embeddings_cache_idx" ON "code_chunk_embeddings" USING btree ("embedding_cache_key","repo_id","embedding_model","embedding_dimension");