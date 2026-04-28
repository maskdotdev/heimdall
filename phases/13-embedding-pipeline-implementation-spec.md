# #13 Embedding Pipeline Implementation Spec

**Status:** Draft v0.1  
**Date:** 2026-04-28  
**Owner:** Engineering  
**Primary package:** `/packages/embedding`  
**Primary workers:** `/apps/worker` embedding workers  
**Depends on:**

```text
#0 Core contracts and shared types
#1 Monorepo and build system
#2 Database layer
#7 Job queue and orchestration
#10 Index artifact schema
#12 Index importer
```

---

## 1. Purpose

The embedding pipeline converts imported code chunks into vector representations that the retrieval engine can use for semantic search.

The important design decision:

```text
Indexing extracts code structure.
Importing writes normalized records.
Embedding vectorizes stable chunks.
Retrieval searches those vectors.
```

The embedding pipeline should **not** parse code, write index artifacts, perform PR review, or decide final context relevance. It should be a focused, idempotent, observable pipeline that turns `code_chunks` into `code_chunk_embeddings`.

---

## 2. Architectural position

```text
Indexer
  -> index-manifest.json + records.jsonl
  -> Index Importer
  -> code_chunks
  -> Embedding Planner
  -> embedding_jobs
  -> Embedding Worker
  -> Embedding Provider
  -> code_chunk_embeddings
  -> Retrieval Engine
```

Expanded flow:

```text
Index Importer
  │
  │ inserts/updates code_chunks
  │ detects chunks without embeddings
  │ creates embedding_jobs
  v
Embedding Queue
  │
  v
Embedding Worker
  │
  │ loads pending chunks
  │ builds provider-safe batches
  │ calls embedding provider
  │ validates vector dimensions
  │ writes vectors
  │ records usage/cost
  v
Vector Store
  │
  v
Retrieval Engine
```

The embedding pipeline is a service boundary. Everything downstream should depend on a stable vector-search interface, not on a specific embedding vendor or storage backend.

---

## 3. Goals

### 3.1 Functional goals

Implement a pipeline that can:

```text
- detect chunks needing embeddings
- batch chunks efficiently
- call one or more embedding providers
- validate returned vectors
- store vectors in pgvector for MVP
- cache embeddings by content hash
- track provider usage and cost
- retry transient failures
- isolate provider-specific behavior
- expose vector search APIs for retrieval
- support future Qdrant migration
```

### 3.2 Product goals

Support retrieval queries like:

```text
- "find code similar to this changed function"
- "find auth/session validation patterns"
- "find similar route handlers"
- "find tests related to this symbol"
- "find previous implementations using this config key"
```

### 3.3 Performance goals

The pipeline should be designed around:

```text
- no re-embedding unchanged content
- provider batch calls, not per-chunk calls
- deterministic cache keys
- concurrency limits per provider/model/org
- resumable jobs
- vector queries scoped by repo and commit
- future vector-store replacement
```

### 3.4 Debuggability goals

For any embedded chunk, we should be able to answer:

```text
- Which chunk was embedded?
- Which content hash was embedded?
- Which model produced the embedding?
- Which dimensions were stored?
- When was it embedded?
- Which provider call produced it?
- How many tokens did it cost?
- Which review run or index import triggered it?
```

---

## 4. Non-goals

The embedding pipeline should **not**:

```text
- parse source files
- build symbol graphs
- chunk code directly
- decide PR review findings
- perform final context ranking by itself
- post GitHub comments
- run static analysis tools
- call review LLMs
- write index artifacts
```

It may expose vector search helpers, but final context composition belongs to `/packages/retrieval`.

---

## 5. Recommended MVP stack

```text
Package:            /packages/embedding
Provider:           OpenAI-compatible embedding provider abstraction
MVP model:          configurable, not hardcoded
Vector store:       Postgres + pgvector
Queue:              BullMQ + Redis
Durable state:      Postgres
ORM/query layer:    Drizzle + raw SQL where needed
Worker runtime:     Bun or Node-compatible worker process
```

MVP storage:

```text
code_chunks
code_chunk_embeddings
embedding_jobs
llm_calls or model_calls
usage_events
```

Scale-up storage:

```text
Qdrant or another vector DB
plus Postgres metadata/source-of-truth rows
```

---

## 6. Key recommendation

Use this rule:

```text
Embedding cache key = provider + model + dimensions + input_kind + input_hash + embedding_profile_version
```

Do **not** key embeddings only by `chunk_id`.

`chunk_id` is tied to a repo, commit, path, range, and chunking strategy. The same text may appear across commits, branches, or repos. If the embedding input text and embedding profile are identical, we should be able to reuse the vector.

Recommended cache key components:

```ts
type EmbeddingCacheKeyInput = {
  provider: EmbeddingProviderName;
  model: string;
  dimensions: number;
  inputKind: "code_chunk" | "symbol_summary" | "file_summary" | "query";
  inputHash: Sha256;
  embeddingProfileVersion: string;
};
```

Example:

```text
embedding_cache_key = sha256(
  provider + ":" +
  model + ":" +
  dimensions + ":" +
  input_kind + ":" +
  input_hash + ":" +
  embedding_profile_version
)
```

---

## 7. Package structure

```text
/packages/embedding
  package.json
  tsconfig.json
  src/
    index.ts

    config.ts
    errors.ts
    ids.ts
    hashes.ts

    providers/
      types.ts
      registry.ts
      openai-provider.ts
      fake-provider.ts
      local-provider-placeholder.ts

    text/
      embedding-input-builder.ts
      code-chunk-input.ts
      query-input.ts
      normalization.ts
      token-estimator.ts
      truncation.ts

    planner/
      embedding-planner.ts
      chunk-selector.ts
      job-planner.ts
      stale-embedding-detector.ts

    batching/
      batch-builder.ts
      batch-policy.ts
      rate-limit-policy.ts
      retry-policy.ts

    storage/
      embedding-store.ts
      pgvector-store.ts
      qdrant-store-placeholder.ts
      embedding-cache.ts
      vector-search-store.ts

    workers/
      embed-code-chunks-handler.ts
      embed-query-handler.ts
      reconcile-embedding-jobs-handler.ts
      cleanup-stale-embedding-jobs-handler.ts

    search/
      semantic-code-search.ts
      vector-query.ts
      score-normalization.ts

    observability/
      metrics.ts
      tracing.ts
      logging.ts

    testing/
      fixtures.ts
      fake-embedding-store.ts
      fake-provider.ts
```

Worker app integration:

```text
/apps/worker/src/handlers/embed-code-chunks.ts
/apps/worker/src/handlers/reconcile-embedding-jobs.ts
```

Database package integration:

```text
/packages/db/src/schema/embedding.ts
/packages/db/src/queries/embedding.ts
```

Contracts package integration:

```text
/packages/contracts/src/embedding.ts
/packages/contracts/src/jobs.ts
/packages/contracts/src/usage.ts
```

---

## 8. Core data model

### 8.1 Existing imported chunks

The importer inserts `code_chunks`.

Conceptually:

```ts
type CodeChunk = {
  id: ChunkId;
  repoId: RepoId;
  commitSha: GitSha;
  fileId: FileId;
  symbolId?: SymbolId;
  path: RepoPath;
  language: Language;
  chunkKind: "symbol" | "file_section" | "file" | "test" | "config";
  startLine: number;
  endLine: number;
  text: string;
  contentHash: Sha256;
  chunkerVersion: string;
  metadata: Record<string, unknown>;
};
```

The embedding pipeline should never mutate chunk text. It may build a provider input string from the chunk, but the source chunk is immutable for a given index version.

---

### 8.2 Embedding profile

An embedding profile defines how text is converted into vector input and which model/dimensions produce the vector.

```ts
export type EmbeddingProfile = {
  id: string;
  version: string;
  provider: EmbeddingProviderName;
  model: string;
  dimensions: number;
  distanceMetric: "cosine" | "inner_product" | "l2";
  inputBuilder: "code_chunk_v1" | "query_v1" | "symbol_summary_v1";
  maxInputTokens: number;
  batchPolicyId: string;
  enabled: boolean;
};
```

Example:

```ts
export const DefaultCodeEmbeddingProfile: EmbeddingProfile = {
  id: "code_embedding_default",
  version: "code_embedding_profile.v1",
  provider: "openai",
  model: "text-embedding-3-small",
  dimensions: 1536,
  distanceMetric: "cosine",
  inputBuilder: "code_chunk_v1",
  maxInputTokens: 8192,
  batchPolicyId: "openai_default_v1",
  enabled: true,
};
```

Important: model and dimensions should be configurable. The API reference for OpenAI embeddings supports passing multiple inputs in one request, has model-specific input limits, and supports a `dimensions` parameter for `text-embedding-3` and newer models. Do not hardcode dimensions globally.

---

### 8.3 Embedding record

`code_chunk_embeddings` stores the actual vector attached to a chunk.

```ts
type CodeChunkEmbedding = {
  id: EmbeddingId;
  repoId: RepoId;
  commitSha: GitSha;
  chunkId: ChunkId;
  contentHash: Sha256;
  inputHash: Sha256;
  embeddingCacheKey: Sha256;
  provider: EmbeddingProviderName;
  model: string;
  dimensions: number;
  distanceMetric: "cosine" | "inner_product" | "l2";
  embeddingProfileVersion: string;
  embedding: number[];
  usageTokens?: number;
  createdAt: IsoDateTime;
};
```

The table should have a uniqueness constraint that prevents duplicate embeddings for the same chunk and profile:

```text
unique(chunk_id, embedding_profile_version, provider, model, dimensions)
```

It should also have an index on `embedding_cache_key` for reuse and debugging.

---

### 8.4 Embedding job

An `embedding_jobs` row represents durable work for embedding chunks.

```ts
type EmbeddingJob = {
  id: EmbeddingJobId;
  orgId: OrgId;
  repoId: RepoId;
  indexVersionId?: IndexVersionId;
  commitSha?: GitSha;
  status:
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "canceled"
    | "stale";
  reason:
    | "index_import"
    | "manual_reembed"
    | "profile_changed"
    | "repair"
    | "query_cache";
  embeddingProfileVersion: string;
  chunkCountPlanned: number;
  chunkCountEmbedded: number;
  chunkCountSkipped: number;
  chunkCountFailed: number;
  provider: EmbeddingProviderName;
  model: string;
  dimensions: number;
  attempts: number;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  createdAt: IsoDateTime;
  startedAt?: IsoDateTime;
  finishedAt?: IsoDateTime;
};
```

---

## 9. Database schema

This spec assumes the database spec already created base tables. The embedding pipeline may add or refine these tables.

### 9.1 `embedding_profiles`

Stores configured embedding profiles.

```sql
create table embedding_profiles (
  id text primary key,
  version text not null unique,
  provider text not null,
  model text not null,
  dimensions integer not null,
  distance_metric text not null,
  input_builder text not null,
  max_input_tokens integer not null,
  batch_policy_id text not null,
  enabled boolean not null default true,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

Notes:

```text
- `version` should change when the input builder changes.
- `version` should change when dimensions/model/provider changes.
- `version` should change when text normalization changes materially.
```

---

### 9.2 `embedding_cache`

Optional but recommended for cross-chunk reuse.

```sql
create table embedding_cache (
  cache_key text primary key,
  provider text not null,
  model text not null,
  dimensions integer not null,
  distance_metric text not null,
  input_kind text not null,
  input_hash text not null,
  embedding_profile_version text not null,
  embedding vector(1536) not null,
  usage_tokens integer,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  use_count integer not null default 1
);
```

Caveat: `vector(1536)` is dimension-specific. If you support multiple embedding dimensions in one deployment, use one of these strategies:

```text
Strategy A: one cache table per configured dimension
Strategy B: one generic table with `vector` plus dimension check constraints where supported
Strategy C: separate DB schemas for different embedding profiles
Strategy D: skip cache table and store only per-chunk embeddings until profile stabilizes
```

For MVP, choose one default embedding profile and one fixed dimension.

Recommended MVP:

```text
Use a single default dimensions value.
Create vector columns with that dimension.
Treat dimension changes as a migration/profile cutover.
```

---

### 9.3 `code_chunk_embeddings`

Stores vector rows attached to chunks.

```sql
create table code_chunk_embeddings (
  id text primary key,
  repo_id text not null references repositories(id) on delete cascade,
  commit_sha text not null,
  index_version_id text not null references repo_index_versions(id) on delete cascade,
  chunk_id text not null references code_chunks(id) on delete cascade,
  content_hash text not null,
  input_hash text not null,
  cache_key text not null,
  provider text not null,
  model text not null,
  dimensions integer not null,
  distance_metric text not null,
  embedding_profile_version text not null,
  embedding vector(1536) not null,
  usage_tokens integer,
  created_at timestamptz not null default now(),

  unique(chunk_id, embedding_profile_version, provider, model, dimensions)
);
```

Recommended indexes:

```sql
create index code_chunk_embeddings_repo_commit_idx
  on code_chunk_embeddings (repo_id, commit_sha);

create index code_chunk_embeddings_chunk_idx
  on code_chunk_embeddings (chunk_id);

create index code_chunk_embeddings_cache_key_idx
  on code_chunk_embeddings (cache_key);

create index code_chunk_embeddings_profile_idx
  on code_chunk_embeddings (embedding_profile_version, provider, model, dimensions);
```

Recommended pgvector HNSW index:

```sql
create index code_chunk_embeddings_vector_hnsw_cosine_idx
  on code_chunk_embeddings
  using hnsw (embedding vector_cosine_ops);
```

If the embedding profile uses inner product or L2, create the corresponding index operator class instead.

---

### 9.4 `embedding_jobs`

```sql
create table embedding_jobs (
  id text primary key,
  org_id text not null references orgs(id) on delete cascade,
  repo_id text not null references repositories(id) on delete cascade,
  index_version_id text references repo_index_versions(id) on delete cascade,
  commit_sha text,
  status text not null,
  reason text not null,
  embedding_profile_version text not null,
  provider text not null,
  model text not null,
  dimensions integer not null,
  chunk_count_planned integer not null default 0,
  chunk_count_embedded integer not null default 0,
  chunk_count_skipped integer not null default 0,
  chunk_count_failed integer not null default 0,
  attempts integer not null default 0,
  locked_by text,
  locked_at timestamptz,
  last_error_code text,
  last_error_message text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create index embedding_jobs_repo_status_idx
  on embedding_jobs (repo_id, status, created_at desc);

create index embedding_jobs_index_version_idx
  on embedding_jobs (index_version_id);
```

---

### 9.5 `embedding_job_items`

Use this table if you need per-chunk job tracking. For MVP, you can skip this and let the worker select chunks dynamically by query. For better debuggability and retry precision, add it.

```sql
create table embedding_job_items (
  id text primary key,
  embedding_job_id text not null references embedding_jobs(id) on delete cascade,
  chunk_id text not null references code_chunks(id) on delete cascade,
  status text not null,
  cache_key text,
  attempts integer not null default 0,
  last_error_code text,
  last_error_message text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,

  unique(embedding_job_id, chunk_id)
);

create index embedding_job_items_status_idx
  on embedding_job_items (embedding_job_id, status);
```

Recommended MVP:

```text
Create embedding_jobs.
Skip embedding_job_items initially unless debugging becomes difficult.
```

Recommended serious production version:

```text
Use embedding_job_items for precise status, retries, and per-chunk failures.
```

---

## 10. Provider abstraction

### 10.1 Interface

```ts
export type EmbeddingProviderName =
  | "openai"
  | "voyage"
  | "cohere"
  | "local"
  | "fake";

export type EmbeddingInput = {
  id: string;
  inputKind: "code_chunk" | "query" | "symbol_summary" | "file_summary";
  text: string;
  inputHash: string;
  metadata?: Record<string, unknown>;
};

export type EmbeddingRequest = {
  provider: EmbeddingProviderName;
  model: string;
  dimensions: number;
  inputs: EmbeddingInput[];
  timeoutMs: number;
  requestId: string;
  orgId?: string;
  repoId?: string;
};

export type EmbeddingVector = {
  inputId: string;
  embedding: number[];
  dimensions: number;
};

export type EmbeddingUsage = {
  inputTokens?: number;
  totalTokens?: number;
  providerRaw?: unknown;
};

export type EmbeddingResponse = {
  provider: EmbeddingProviderName;
  model: string;
  dimensions: number;
  vectors: EmbeddingVector[];
  usage: EmbeddingUsage;
};

export interface EmbeddingProvider {
  name: EmbeddingProviderName;
  embed(request: EmbeddingRequest): Promise<EmbeddingResponse>;
}
```

### 10.2 Provider registry

```ts
export class EmbeddingProviderRegistry {
  private providers = new Map<EmbeddingProviderName, EmbeddingProvider>();

  register(provider: EmbeddingProvider): void {
    this.providers.set(provider.name, provider);
  }

  get(name: EmbeddingProviderName): EmbeddingProvider {
    const provider = this.providers.get(name);
    if (!provider) throw new EmbeddingProviderNotConfiguredError(name);
    return provider;
  }
}
```

### 10.3 OpenAI provider implementation

The OpenAI provider should:

```text
- accept an array of strings per request
- include model
- include dimensions when configured and supported
- request float encoding unless base64 is explicitly desired
- preserve response order by index
- validate vector dimension
- normalize provider errors
- record usage tokens when returned
```

Pseudo-code:

```ts
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  name = "openai" as const;

  constructor(private client: OpenAI) {}

  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const response = await this.client.embeddings.create({
      model: request.model,
      input: request.inputs.map((input) => input.text),
      dimensions: request.dimensions,
      encoding_format: "float",
    });

    const vectors = response.data.map((item) => {
      const sourceInput = request.inputs[item.index];
      if (!sourceInput) {
        throw new EmbeddingProviderResponseError("missing_input_for_embedding_index");
      }

      if (item.embedding.length !== request.dimensions) {
        throw new EmbeddingProviderResponseError("embedding_dimension_mismatch", {
          expected: request.dimensions,
          actual: item.embedding.length,
        });
      }

      return {
        inputId: sourceInput.id,
        embedding: item.embedding,
        dimensions: item.embedding.length,
      };
    });

    return {
      provider: "openai",
      model: response.model ?? request.model,
      dimensions: request.dimensions,
      vectors,
      usage: {
        inputTokens: response.usage?.prompt_tokens,
        totalTokens: response.usage?.total_tokens,
      },
    };
  }
}
```

---

## 11. Input construction

### 11.1 Why input construction matters

Embedding quality depends heavily on the text sent to the provider. A raw code chunk may be enough, but adding lightweight metadata can improve retrieval.

For code chunks, use a stable input builder.

Example `code_chunk_v1`:

```text
language: typescript
path: src/auth/session.ts
symbol: validateSession
kind: function
lines: 42-91

export function validateSession(token: string): Session | null {
  ...
}
```

This helps semantic retrieval when the query includes words like `auth`, `session`, or `function` that may not appear enough in the raw code.

---

### 11.2 Input builder interface

```ts
export type EmbeddingInputBuildRequest = {
  chunk: CodeChunk;
  profile: EmbeddingProfile;
};

export type BuiltEmbeddingInput = {
  inputKind: "code_chunk";
  text: string;
  inputHash: Sha256;
  tokenEstimate: number;
  wasTruncated: boolean;
};

export interface EmbeddingInputBuilder {
  id: string;
  build(request: EmbeddingInputBuildRequest): BuiltEmbeddingInput;
}
```

---

### 11.3 Code chunk input builder

```ts
export function buildCodeChunkInput(chunk: CodeChunk): string {
  const header = [
    `language: ${chunk.language}`,
    `path: ${chunk.path}`,
    chunk.symbolId ? `symbol_id: ${chunk.symbolId}` : undefined,
    `chunk_kind: ${chunk.chunkKind}`,
    `lines: ${chunk.startLine}-${chunk.endLine}`,
  ].filter(Boolean).join("\n");

  return `${header}\n\n${chunk.text}`;
}
```

Hash the final provider input text, not only the chunk text:

```ts
const inputHash = sha256(providerInputText);
```

Why:

```text
Changing metadata, normalization, truncation, or builder version changes the embedding input.
That should result in a new embedding cache key.
```

---

### 11.4 Query input builder

Retrieval queries also need embeddings. Query embedding inputs should use a separate builder and cache key.

Example:

```ts
export function buildQueryEmbeddingInput(query: SemanticCodeQuery): string {
  return [
    `task: semantic_code_search`,
    query.language ? `language: ${query.language}` : undefined,
    query.repoPath ? `path_hint: ${query.repoPath}` : undefined,
    "",
    query.text,
  ].filter((x) => x !== undefined).join("\n");
}
```

Do not store ephemeral query embeddings in `code_chunk_embeddings`. Use either:

```text
- in-memory per-request cache
- short-lived Redis cache
- optional query_embedding_cache table
```

MVP: in-memory request cache only.

---

## 12. Token estimation and truncation

The embedding pipeline needs provider-specific limits. The OpenAI API reference currently states that embedding inputs can be strings or arrays of strings, supports multiple inputs in one request, and enforces model input limits and aggregate request limits. The implementation should avoid relying on approximate character counts alone.

### 12.1 Token estimator interface

```ts
export interface TokenEstimator {
  estimate(text: string, model: string): number;
}
```

MVP choices:

```text
- implement conservative char-based estimate
- optionally add tokenizer package later
```

Conservative estimate:

```ts
function roughTokenEstimate(text: string): number {
  return Math.ceil(text.length / 3);
}
```

Use `/3`, not `/4`, to be conservative for code-heavy text.

### 12.2 Truncation policy

```ts
type TruncationPolicy = {
  maxInputTokens: number;
  preserveHeader: boolean;
  preserveStartLines: number;
  preserveEndLines: number;
};
```

Recommended policy:

```text
- preserve metadata header
- preserve beginning of code chunk
- preserve ending of code chunk when possible
- mark metadata.wasTruncated = true
- never silently embed empty text
```

For symbol chunks, truncation should be rare if chunking is correct. If a single symbol is too large, the indexer/chunker should split it in a future chunking version.

---

## 13. Planning embeddings after import

The index importer should call the embedding planner after successfully importing chunks.

```ts
export type PlanEmbeddingsInput = {
  orgId: OrgId;
  repoId: RepoId;
  indexVersionId: IndexVersionId;
  commitSha: GitSha;
  embeddingProfileVersion: string;
  reason: "index_import" | "manual_reembed" | "profile_changed" | "repair";
};

export type PlanEmbeddingsResult = {
  embeddingJobId?: EmbeddingJobId;
  plannedChunkCount: number;
  skippedExistingCount: number;
};
```

Planner algorithm:

```text
1. Load active embedding profile.
2. Select chunks for repo/index version.
3. Build input hash or estimate cache key for each chunk.
4. Exclude chunks with existing valid embedding for same profile.
5. Exclude chunks whose content/input exceeds hard limits unless truncation is allowed.
6. Create embedding_jobs row.
7. Optionally create embedding_job_items rows.
8. Enqueue `embedding.batch` job.
```

SQL sketch for chunks missing embeddings:

```sql
select c.*
from code_chunks c
left join code_chunk_embeddings e
  on e.chunk_id = c.id
 and e.embedding_profile_version = $1
 and e.provider = $2
 and e.model = $3
 and e.dimensions = $4
where c.index_version_id = $5
  and e.id is null
order by c.path asc, c.start_line asc;
```

---

## 14. Worker execution

### 14.1 Queue job payload

From #7 job queue spec:

```ts
export type EmbedCodeChunksJobPayload = {
  jobType: "embedding.batch";
  embeddingJobId: EmbeddingJobId;
  orgId: OrgId;
  repoId: RepoId;
  indexVersionId: IndexVersionId;
  embeddingProfileVersion: string;
};
```

### 14.2 Handler flow

```text
embed-code-chunks job
  -> acquire job lock
  -> mark embedding_job running
  -> load profile
  -> select chunks without embeddings
  -> build provider inputs
  -> check embedding cache
  -> batch uncached inputs
  -> call provider
  -> validate vectors
  -> transactionally write cache + chunk embeddings
  -> record usage
  -> update counters
  -> mark succeeded/failed
```

Pseudo-code:

```ts
export async function handleEmbedCodeChunksJob(payload: EmbedCodeChunksJobPayload) {
  const job = await embeddingJobs.acquire(payload.embeddingJobId);
  if (!job) return;

  const profile = await embeddingProfiles.get(payload.embeddingProfileVersion);

  const chunks = await chunkSelector.selectMissingEmbeddings({
    repoId: payload.repoId,
    indexVersionId: payload.indexVersionId,
    profile,
    limit: profileBatchLimit(profile),
  });

  if (chunks.length === 0) {
    await embeddingJobs.markSucceeded(payload.embeddingJobId);
    return;
  }

  const builtInputs = chunks.map((chunk) => buildEmbeddingInput({ chunk, profile }));

  const { cached, uncached } = await embeddingCache.partitionByCacheHit({
    builtInputs,
    profile,
  });

  await embeddingStore.attachCachedEmbeddings({
    cached,
    chunks,
    profile,
  });

  for (const batch of buildProviderBatches(uncached, profile)) {
    const response = await providerRegistry.get(profile.provider).embed({
      provider: profile.provider,
      model: profile.model,
      dimensions: profile.dimensions,
      inputs: batch,
      timeoutMs: 60_000,
      requestId: createRequestId(),
      orgId: payload.orgId,
      repoId: payload.repoId,
    });

    await embeddingStore.writeProviderResponse({
      response,
      batch,
      chunks,
      profile,
    });

    await usageRecorder.recordEmbeddingUsage({
      orgId: payload.orgId,
      repoId: payload.repoId,
      provider: response.provider,
      model: response.model,
      usage: response.usage,
    });
  }

  await embeddingJobs.updateProgress(payload.embeddingJobId);

  const remaining = await chunkSelector.countMissingEmbeddings({
    repoId: payload.repoId,
    indexVersionId: payload.indexVersionId,
    profile,
  });

  if (remaining > 0) {
    await queue.enqueue("embedding.batch", payload, { delayMs: 0 });
  } else {
    await embeddingJobs.markSucceeded(payload.embeddingJobId);
  }
}
```

Key design:

```text
The job may process a bounded number of chunks per run.
If more remain, it re-enqueues itself.
```

This prevents a single embedding job from monopolizing a worker for very large repos.

---

## 15. Batching policy

### 15.1 Batch policy type

```ts
type EmbeddingBatchPolicy = {
  id: string;
  maxInputsPerRequest: number;
  maxTokensPerInput: number;
  maxTokensPerRequest: number;
  maxCharsPerRequest: number;
  maxConcurrentRequestsPerWorker: number;
  maxRequestsPerMinutePerOrg?: number;
  maxRequestsPerMinuteGlobal?: number;
};
```

### 15.2 Recommended MVP policy

```ts
export const OpenAIDefaultEmbeddingBatchPolicy: EmbeddingBatchPolicy = {
  id: "openai_default_v1",
  maxInputsPerRequest: 128,
  maxTokensPerInput: 8192,
  maxTokensPerRequest: 200_000,
  maxCharsPerRequest: 1_500_000,
  maxConcurrentRequestsPerWorker: 4,
};
```

Use conservative batch limits below hard provider limits to reduce failed requests and make retries cheaper.

### 15.3 Batch builder

```ts
export function buildProviderBatches(
  inputs: BuiltEmbeddingInput[],
  profile: EmbeddingProfile,
  policy: EmbeddingBatchPolicy,
): BuiltEmbeddingInput[][] {
  const batches: BuiltEmbeddingInput[][] = [];
  let current: BuiltEmbeddingInput[] = [];
  let currentTokens = 0;
  let currentChars = 0;

  for (const input of inputs) {
    const wouldExceed =
      current.length >= policy.maxInputsPerRequest ||
      currentTokens + input.tokenEstimate > policy.maxTokensPerRequest ||
      currentChars + input.text.length > policy.maxCharsPerRequest;

    if (wouldExceed && current.length > 0) {
      batches.push(current);
      current = [];
      currentTokens = 0;
      currentChars = 0;
    }

    current.push(input);
    currentTokens += input.tokenEstimate;
    currentChars += input.text.length;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}
```

---

## 16. Idempotency

Every embedding operation must be safe to retry.

### 16.1 Idempotent writes

Use upserts:

```text
embedding_cache.cache_key is unique
code_chunk_embeddings unique(chunk_id, profile, provider, model, dimensions)
```

When a retry inserts the same vector again, it should no-op or update metadata only.

### 16.2 Provider call idempotency

Embedding providers may not support idempotency keys. Therefore:

```text
- avoid duplicate provider calls by checking cache before call
- persist successful vectors immediately after each batch
- on retry, skip newly cached/embedded chunks
```

### 16.3 Partial batch success

If a provider call succeeds but DB write fails, retrying may call the provider again. To reduce this:

```text
- keep batches reasonably small
- write cache + chunk mappings in one transaction
- record provider call metadata after successful DB write when possible
```

---

## 17. Rate limiting

The embedding pipeline needs multiple layers of rate limits:

```text
- global provider concurrency
- per-org concurrency
- per-repo concurrency
- per-provider requests per minute
- per-provider tokens per minute when available
- per-worker concurrency
```

MVP:

```text
- BullMQ concurrency per embedding worker
- provider-specific max concurrent requests per worker
- one embedding job per repo/index version at a time
```

Production:

```text
- Redis token bucket per provider/model/org
- adaptive backoff on 429s
- provider usage telemetry
- quota-based scheduling
```

Rate-limit error behavior:

```text
429 -> retry with exponential backoff + jitter
5xx -> retry with exponential backoff + jitter
timeout -> retry with lower batch size if repeated
4xx invalid input -> fail specific input/chunk, not whole repo
```

---

## 18. Error model

### 18.1 Error categories

```ts
type EmbeddingErrorCode =
  | "embedding_provider_not_configured"
  | "embedding_profile_not_found"
  | "embedding_input_empty"
  | "embedding_input_too_large"
  | "embedding_batch_too_large"
  | "embedding_provider_rate_limited"
  | "embedding_provider_timeout"
  | "embedding_provider_auth_failed"
  | "embedding_provider_bad_request"
  | "embedding_provider_unavailable"
  | "embedding_dimension_mismatch"
  | "embedding_vector_invalid"
  | "embedding_db_write_failed"
  | "embedding_job_stale"
  | "embedding_unknown_error";
```

### 18.2 Retriable errors

```text
Retriable:
- provider rate limited
- provider timeout
- provider unavailable
- transient DB write failure
- queue visibility/lock issue

Not retriable without change:
- auth failed
- profile missing
- invalid dimensions
- empty input
- input too large after truncation disabled
- provider bad request due to invalid model
```

### 18.3 Per-chunk failure policy

A few bad chunks should not fail the entire repo indexing flow.

Recommended policy:

```text
- If <= 2% chunks fail due to invalid input, mark job succeeded_with_warnings or succeeded and record diagnostics.
- If provider-level failure affects all chunks, mark failed and retry.
- If dimension mismatch occurs, fail job immediately; this indicates misconfiguration.
```

MVP statuses can remain:

```text
queued | running | succeeded | failed | canceled | stale
```

Add warning counts in metadata.

---

## 19. Vector validation

Before writing a vector:

```text
- vector must be an array
- length must equal configured dimensions
- every value must be finite number
- no NaN
- no Infinity
- not all zeros unless provider explicitly allows and it is expected
```

Pseudo-code:

```ts
export function validateEmbeddingVector(vector: number[], expectedDimensions: number): void {
  if (!Array.isArray(vector)) throw new Error("embedding_vector_not_array");
  if (vector.length !== expectedDimensions) throw new Error("embedding_dimension_mismatch");

  let nonZero = false;

  for (const value of vector) {
    if (!Number.isFinite(value)) throw new Error("embedding_vector_non_finite");
    if (value !== 0) nonZero = true;
  }

  if (!nonZero) throw new Error("embedding_vector_all_zero");
}
```

---

## 20. pgvector storage and query design

### 20.1 Why pgvector for MVP

Use pgvector because it keeps metadata, durable app state, and vectors in one database. pgvector supports exact and approximate nearest-neighbor search and HNSW/IVFFlat indexes. This is ideal for early-stage simplicity.

### 20.2 Query interface

```ts
export type SemanticCodeSearchInput = {
  repoId: RepoId;
  commitSha: GitSha;
  queryText: string;
  language?: Language;
  pathPrefix?: string;
  excludePaths?: string[];
  limit: number;
  minScore?: number;
  profileVersion: string;
};

export type SemanticCodeSearchResult = {
  chunkId: ChunkId;
  fileId: FileId;
  symbolId?: SymbolId;
  path: RepoPath;
  language: Language;
  startLine: number;
  endLine: number;
  text: string;
  score: number;
  distance: number;
  metadata: Record<string, unknown>;
};
```

### 20.3 Search flow

```text
semanticCodeSearch(input)
  -> build query embedding input
  -> embed query
  -> vector search scoped to repo + commit + profile
  -> join code_chunks
  -> apply path/language filters
  -> normalize scores
  -> return snippets
```

SQL sketch for cosine distance:

```sql
select
  c.id as chunk_id,
  c.file_id,
  c.symbol_id,
  c.path,
  c.language,
  c.start_line,
  c.end_line,
  c.text,
  e.embedding <=> $query_embedding as distance
from code_chunk_embeddings e
join code_chunks c on c.id = e.chunk_id
where e.repo_id = $repo_id
  and e.commit_sha = $commit_sha
  and e.embedding_profile_version = $profile_version
  and ($language is null or c.language = $language)
order by e.embedding <=> $query_embedding
limit $limit;
```

For cosine distance, a smaller distance means closer. The application can convert distance to a rough score:

```ts
function cosineDistanceToScore(distance: number): number {
  return Math.max(0, Math.min(1, 1 - distance));
}
```

Keep both `distance` and `score`. Retrieval/reranking may use the raw distance.

---

## 21. Filtering and path scoping

Semantic search should usually be scoped.

Common filters:

```text
- repo_id
- commit_sha
- language
- path prefix
- file kind
- symbol kind
- chunk kind
- test vs non-test
- generated vs non-generated
- ignored path rules
```

For MVP, use relational filters before/with vector ordering:

```sql
where e.repo_id = $repo_id
  and e.commit_sha = $commit_sha
  and c.is_generated = false
```

Important pgvector nuance:

```text
Approximate vector indexes may apply filtering after scanning vector candidates.
If filters are selective, relational indexes and/or partitioning may matter.
```

Practical MVP approach:

```text
- Always filter by repo_id and commit_sha.
- Add B-tree indexes on repo_id, commit_sha, language, path where useful.
- Start with HNSW cosine index.
- Monitor recall/latency before complex partitioning.
```

---

## 22. Qdrant future adapter

Do not build Qdrant first unless pgvector is already too slow.

But design the vector store interface so Qdrant can replace pgvector later.

```ts
export interface VectorSearchStore {
  upsertChunkEmbeddings(input: UpsertChunkEmbeddingsInput): Promise<void>;
  searchCode(input: SemanticCodeSearchVectorInput): Promise<VectorSearchResult[]>;
  deleteIndexVersion(input: DeleteIndexVersionInput): Promise<void>;
}
```

Qdrant mapping:

```text
collection: code_chunks_{embedding_profile_version}
point id: stable embedding id or chunk/profile id
vector: embedding vector
payload:
  orgId
  repoId
  commitSha
  indexVersionId
  chunkId
  fileId
  symbolId
  path
  language
  chunkKind
  isTest
  isGenerated
  startLine
  endLine
```

Qdrant points are records with vectors and optional payloads, and Qdrant supports search with payload-based filters. This maps cleanly to repo/commit/path/language scoped semantic search.

Migration strategy:

```text
1. Keep Postgres code_chunk_embeddings as source of truth, or keep only metadata there.
2. Add QdrantStore implementing VectorSearchStore.
3. Dual-write vectors for a subset of repos.
4. Compare retrieval results and latency.
5. Switch retrieval to Qdrant by config.
6. Keep Postgres rows for metadata and auditability.
```

---

## 23. Integration with index importer

The index importer should call the embedding planner after import activation.

Recommended sequence:

```text
1. importer validates artifact
2. importer writes files/symbols/chunks/edges
3. importer marks index_version imported
4. importer calls planEmbeddings(indexVersionId)
5. planner creates embedding_job
6. planner enqueues embedding.batch
7. importer returns
```

Do not make import wait for embeddings to finish unless a caller explicitly requested synchronous indexing.

Index version state may be split:

```text
index_import_status: pending | running | succeeded | failed
embedding_status: not_started | queued | running | complete | partial | failed
```

This lets a review proceed in degraded mode if structural context exists but embeddings are still pending.

---

## 24. Integration with retrieval engine

Retrieval should call the embedding package through an interface:

```ts
export interface SemanticSearchService {
  searchCode(input: SemanticCodeSearchInput): Promise<SemanticCodeSearchResult[]>;
}
```

Retrieval should not know:

```text
- which provider is used
- whether vectors are in pgvector or Qdrant
- how query embeddings are cached
- how code chunk inputs were built
```

Retrieval should know:

```text
- repoId
- commitSha
- query text
- filters
- limit
- desired profile
```

---

## 25. Usage and cost tracking

For every provider call, record usage.

### 25.1 Usage event

```ts
type EmbeddingUsageEvent = {
  id: UsageEventId;
  orgId: OrgId;
  repoId?: RepoId;
  source: "embedding";
  provider: EmbeddingProviderName;
  model: string;
  inputTokens?: number;
  totalTokens?: number;
  inputCount: number;
  estimatedCostUsd?: string;
  embeddingJobId?: EmbeddingJobId;
  createdAt: IsoDateTime;
};
```

### 25.2 LLM/model call record

Reuse `llm_calls` or create `model_calls` if you want non-LLM naming.

```ts
type ModelCall = {
  id: ModelCallId;
  kind: "embedding" | "chat" | "rerank";
  provider: string;
  model: string;
  orgId?: string;
  repoId?: string;
  requestHash: string;
  responseHash?: string;
  inputCount?: number;
  inputTokens?: number;
  totalTokens?: number;
  latencyMs: number;
  status: "succeeded" | "failed";
  errorCode?: string;
  createdAt: IsoDateTime;
};
```

Do not store raw code input in usage rows. Store hashes and metadata. Raw code already exists in `code_chunks` and artifacts.

---

## 26. Security and privacy

Embedding requests may send private source code to a provider. Treat this as sensitive.

Required controls:

```text
- provider API keys stored only in secrets manager/env
- no API keys in logs/traces/DB
- code input redacted from logs by default
- prompt/input logging disabled by default for private repos
- org-level provider settings
- data retention settings
- optional bring-your-own-provider later
```

Logging rule:

```text
Log IDs, counts, hashes, durations, and error codes.
Do not log full code chunk text or vectors by default.
```

Vector privacy note:

```text
Embeddings are derived from source code. Treat vectors as sensitive customer data.
```

---

## 27. Observability

### 27.1 Metrics

Record:

```text
embedding_jobs_created_total
embedding_jobs_succeeded_total
embedding_jobs_failed_total
embedding_chunks_planned_total
embedding_chunks_embedded_total
embedding_chunks_cache_hit_total
embedding_chunks_cache_miss_total
embedding_provider_requests_total
embedding_provider_errors_total
embedding_provider_latency_ms
embedding_provider_tokens_total
embedding_db_write_latency_ms
embedding_vector_search_latency_ms
embedding_vector_search_results_count
```

Labels:

```text
provider
model
profile_version
org_id hash/bucket, not raw if needed
repo_id hash/bucket, not raw if needed
error_code
```

### 27.2 Traces

Trace spans:

```text
embedding.plan
embedding.job.acquire
embedding.select_chunks
embedding.build_inputs
embedding.cache_lookup
embedding.provider_call
embedding.write_vectors
embedding.record_usage
embedding.search
```

Attach attributes:

```text
embedding.job_id
repo.id
index_version.id
provider
model
dimensions
batch.size
cache.hit_count
cache.miss_count
```

### 27.3 Logs

Use structured logs:

```json
{
  "event": "embedding.batch.completed",
  "embeddingJobId": "embjob_...",
  "repoId": "repo_...",
  "indexVersionId": "idxv_...",
  "provider": "openai",
  "model": "text-embedding-3-small",
  "chunksEmbedded": 128,
  "cacheHits": 72,
  "latencyMs": 1432
}
```

---

## 28. Performance considerations

### 28.1 Biggest wins

```text
1. Avoid re-embedding unchanged content.
2. Batch provider calls.
3. Keep code chunks reasonably sized.
4. Use HNSW index for vector search.
5. Scope queries by repo and commit.
6. Cache query embeddings during one review run.
7. Process very large repos incrementally.
```

### 28.2 Chunk size guidance

The indexer/chunker should aim for:

```text
small chunk:   50-150 lines
normal chunk:  100-250 lines
large chunk:   250-500 lines max
```

Overly large chunks are expensive and less precise. Overly tiny chunks lose context.

### 28.3 Embedding latency budget

Suggested targets:

```text
small repo import:       < 30 seconds for embeddings after import
medium repo import:      < 2-5 minutes async
large repo import:       async background, progressive availability
single PR query embed:   < 500ms typical provider time excluding queue
semantic search query:   < 200ms DB time for scoped repo queries initially
```

These are product goals, not hard correctness requirements.

---

## 29. Re-embedding strategy

Re-embedding is needed when:

```text
- model changes
- dimensions change
- input builder changes
- normalization changes
- chunking changes
- provider changes
- distance metric changes
```

Use profile versions to avoid destructive migrations.

Bad:

```text
Overwrite old vectors in place when changing models.
```

Good:

```text
Create new embedding_profile_version.
Embed chunks into new version.
Switch retrieval config after coverage is sufficient.
Delete old vectors later.
```

Profile rollout states:

```text
created
backfilling
active
deprecated
retired
```

---

## 30. Backfill and repair jobs

### 30.1 Backfill job

```ts
type BackfillEmbeddingProfileJob = {
  jobType: "embedding.backfill_profile";
  orgId?: OrgId;
  repoId?: RepoId;
  embeddingProfileVersion: string;
  limitRepos?: number;
};
```

Flow:

```text
select repos/index versions missing profile
  -> create embedding jobs
  -> enqueue batches
  -> track coverage
```

### 30.2 Repair job

```ts
type RepairEmbeddingsJob = {
  jobType: "embedding.repair";
  repoId: RepoId;
  indexVersionId: IndexVersionId;
  embeddingProfileVersion: string;
};
```

Repair detects:

```text
- chunks without embeddings
- embeddings with wrong dimensions
- embeddings with stale profile version
- embeddings pointing to missing chunks
- cache rows unused for a retention period
```

---

## 31. Deletion and retention

When deleting repo data:

```text
- delete code_chunk_embeddings for repo
- delete embedding_jobs for repo
- delete query caches for repo if any
- optionally keep global embedding_cache rows only if allowed by policy
```

For strict tenant isolation, do not reuse embedding cache across orgs unless policy explicitly allows it.

Recommended default:

```text
Embedding cache is org-scoped or repo-scoped, not global, for private code.
```

This is less efficient but safer.

Safer cache key:

```text
org_id + provider + model + dimensions + input_hash + profile_version
```

For public/open-source repos, global cache may be acceptable later.

---

## 32. Multi-tenant isolation

Every embedding row must include:

```text
org_id or joinable repo_id -> org_id
repo_id
```

Every query must scope by repo/org authorization before returning snippets.

Do not expose vector search endpoints that accept arbitrary SQL-like filters from clients.

Dashboard/API rule:

```text
Users never query vectors directly.
They ask for review/debug artifacts through authorized API routes.
```

---

## 33. Local development

### 33.1 Fake provider

Implement fake deterministic embeddings for tests/local dev.

```ts
export class FakeEmbeddingProvider implements EmbeddingProvider {
  name = "fake" as const;

  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    return {
      provider: "fake",
      model: request.model,
      dimensions: request.dimensions,
      vectors: request.inputs.map((input) => ({
        inputId: input.id,
        embedding: deterministicVector(input.text, request.dimensions),
        dimensions: request.dimensions,
      })),
      usage: {
        inputTokens: request.inputs.reduce((sum, input) => sum + roughTokenEstimate(input.text), 0),
      },
    };
  }
}
```

`deterministicVector` should be stable:

```ts
function deterministicVector(text: string, dimensions: number): number[] {
  const seed = sha256ToSeed(text);
  const vector = new Array(dimensions).fill(0).map((_, i) => pseudoRandom(seed, i));
  return normalize(vector);
}
```

This enables tests without provider calls.

### 33.2 Local env

```env
EMBEDDING_PROVIDER=fake
EMBEDDING_MODEL=fake-code-embedding
EMBEDDING_DIMENSIONS=1536
EMBEDDING_PROFILE_VERSION=code_embedding_profile.v1
```

For real provider:

```env
EMBEDDING_PROVIDER=openai
OPENAI_API_KEY=...
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMENSIONS=1536
```

---

## 34. Testing strategy

### 34.1 Unit tests

Test:

```text
- input builders
- input hashing
- cache key generation
- token estimation
- truncation
- batch building
- vector validation
- provider response normalization
- score normalization
- error classification
```

### 34.2 Integration tests

Use fake provider + test Postgres with pgvector.

Test:

```text
- planner creates jobs for missing chunks
- planner skips already embedded chunks
- worker embeds chunks
- retry skips completed chunks
- cache hits attach embeddings without provider call
- semantic search returns expected chunks
- deletion removes embeddings
```

### 34.3 Contract tests

Test provider implementations against shared behavior:

```text
- preserves input order
- validates dimensions
- records usage
- maps rate limit errors
- maps auth errors
- rejects empty inputs
```

### 34.4 Performance tests

Create fixtures:

```text
small repo: 100 chunks
medium repo: 10,000 chunks
large synthetic repo: 100,000 chunks
```

Measure:

```text
- planner latency
- embedding worker throughput with fake provider
- DB write throughput
- vector search latency
- HNSW index size
```

---

## 35. Implementation sequence

### PR 1: Package shell and contracts

Implement:

```text
/packages/embedding shell
provider types
embedding profile types
job payload types in /packages/contracts
error types
fake provider
basic unit tests
```

Definition of done:

```text
- package builds
- fake provider returns deterministic vectors
- contracts compile
```

---

### PR 2: Database tables and query helpers

Implement:

```text
embedding_profiles
embedding_jobs
code_chunk_embeddings
optional embedding_cache
Drizzle schema
migrations
query helpers
```

Definition of done:

```text
- migrations run locally
- vector extension enabled
- basic insert/select tests pass
```

---

### PR 3: Input builders and batching

Implement:

```text
code_chunk_v1 input builder
query_v1 input builder
input hash
cache key
rough token estimator
truncation
batch builder
```

Definition of done:

```text
- stable snapshot tests for built inputs
- batch tests cover input count/token/char limits
```

---

### PR 4: Embedding planner

Implement:

```text
select missing chunks
create embedding_jobs
skip existing embeddings
planner called from index importer
queue embedding.batch
```

Definition of done:

```text
- importing an index creates an embedding job
- re-running planner is idempotent
```

---

### PR 5: Embedding worker with fake provider

Implement:

```text
worker handler
job acquisition
chunk selection
cache lookup
provider call
vector validation
DB write
progress updates
usage event recording
```

Definition of done:

```text
- local imported chunks become embedded
- retrying job does not duplicate rows
- failed chunks are recorded
```

---

### PR 6: OpenAI provider

Implement:

```text
OpenAI provider wrapper
API key config
structured error mapping
usage extraction
provider integration tests with mocked client
```

Definition of done:

```text
- no direct OpenAI calls outside provider package
- provider can be swapped by config
```

---

### PR 7: Semantic search service

Implement:

```text
query embedding builder
query embedding provider call
pgvector similarity query
score normalization
filters
semanticCodeSearch API for retrieval package
```

Definition of done:

```text
- retrieval package can call semantic search
- search returns chunks scoped to repo+commit
```

---

### PR 8: Observability and hardening

Implement:

```text
metrics
traces
structured logs
rate-limit/backoff policy
reconciliation job
repair job
admin/debug queries
```

Definition of done:

```text
- embedding throughput and failures visible
- stuck jobs can be repaired
```

---

## 36. MVP cut

For the first version, implement only:

```text
- /packages/embedding
- fake provider
- OpenAI provider
- one default embedding profile
- code_chunk_v1 input builder
- rough token estimator
- conservative truncation
- batch builder
- embedding planner
- embedding_jobs table
- code_chunk_embeddings table
- pgvector HNSW index
- embedding.batch worker
- semanticCodeSearch
- usage event recording
- basic metrics/logs
```

Skip initially:

```text
- Qdrant
- embedding_job_items
- query embedding persistent cache
- multiple active profiles
- org-specific BYO provider
- local embedding models
- sparse/hybrid retrieval
- cross-org cache
- profile backfill dashboard
```

---

## 37. Definition of done

#13 is complete when:

```text
- Imported chunks automatically create embedding work.
- Embedding jobs are durable and idempotent.
- Workers batch provider calls instead of embedding one chunk at a time.
- Unchanged chunks are not re-embedded.
- Vectors are validated before storage.
- Embeddings are stored in pgvector.
- Retrieval can perform semantic search scoped by repo + commit.
- Usage/cost events are recorded.
- Provider calls are isolated behind /packages/embedding.
- Fake provider enables deterministic tests.
- OpenAI provider can be enabled by config.
- Logs/traces/metrics show job progress and failures.
```

---

## 38. Reference architecture summary

```text
Index Importer
  -> planEmbeddings(indexVersion)
  -> embedding_jobs row
  -> BullMQ embedding.batch job

Embedding Worker
  -> load profile
  -> select missing chunks
  -> build code_chunk_v1 inputs
  -> compute input hashes/cache keys
  -> check cache
  -> batch uncached inputs
  -> call provider
  -> validate vectors
  -> write cache + code_chunk_embeddings
  -> record usage
  -> mark progress

Retrieval
  -> build query_v1 input
  -> embed query
  -> pgvector search scoped by repo/commit/profile
  -> return ranked chunks
```

---

## 39. Source notes

The implementation should stay provider-neutral, but this spec was written with these documented capabilities in mind:

- OpenAI’s embeddings guide describes embeddings as vectors where distance measures relatedness, and describes generating vectors through the embeddings endpoint.
- OpenAI’s embeddings API reference documents array inputs for batching, model selection, `dimensions` support for `text-embedding-3` and later models, and returned embedding vectors/usage metadata.
- pgvector supports exact and approximate nearest-neighbor search, HNSW and IVFFlat indexes, multiple distance operator classes, and vector dimension-specific storage/indexing.
- Qdrant models vector data as points with vectors and optional payloads, and supports filtering over payload conditions during retrieval.

References:

```text
OpenAI embeddings guide:
https://developers.openai.com/api/docs/guides/embeddings

OpenAI create embeddings API reference:
https://developers.openai.com/api/reference/resources/embeddings/methods/create/

pgvector documentation:
https://github.com/pgvector/pgvector

Qdrant points documentation:
https://qdrant.tech/documentation/manage-data/points/

Qdrant filtering documentation:
https://qdrant.tech/documentation/search/filtering/
```
