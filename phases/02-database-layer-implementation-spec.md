# #2 Database Layer — Implementation Specification

## Purpose

This document defines the database layer for a Greptile-like code review system.

The goal of #2 is to create the durable persistence foundation for:

```text
GitHub App installation state
repository configuration
webhook idempotency
repo index versions
code intelligence records
embedding state
pull request snapshots
review runs
candidate findings
published comments
feedback outcomes
team memory
LLM usage
billing/usage events
audit logs
internal debugging artifacts
```

The database should be boring, durable, easy to query, and strict enough to prevent the system from drifting into untraceable state.

The database layer does **not** implement GitHub logic, review logic, retrieval logic, model calls, or indexing logic. It provides schemas, migrations, transaction helpers, and query modules that other packages use.

---

## Executive summary

Recommended setup:

```text
Primary database:      Postgres
Vector extension:      pgvector
ORM/query layer:       Drizzle
Driver:                postgres.js
ID strategy:           app-generated prefixed ULID-style text IDs
Migrations:            drizzle-kit generated SQL, reviewed before merge
Schema style:          relational core + JSONB for artifacts/metadata
Vector MVP:            code_chunk_embeddings with vector(1536)
Artifacts:             stored in object storage, referenced from Postgres
Runtime validation:    all DB boundary objects mapped to @repo/contracts
```

Core principle:

> Postgres is the source of truth for state, relationships, status, and queryable metadata. Large replayable artifacts live outside the database and are referenced by hash and URI.

The first version should use:

```text
Postgres + pgvector + Drizzle + postgres.js
```

Do not add Qdrant, Temporal, Kafka, or a graph database yet. Design the schema so those can be added later without rewriting the product.

---

## Non-goals

The database layer should not:

```text
- call GitHub APIs
- call model providers
- parse code
- run retrieval algorithms
- execute review prompts
- publish comments
- own business logic that belongs to services
- store unbounded raw repo snapshots inline
- hide provider-specific data inside JSON when it needs to be queried
```

The database layer should:

```text
- define tables
- define migrations
- expose typed query helpers
- expose transaction helpers
- enforce idempotency where possible
- provide consistent state transitions
- store enough metadata for replay/debugging
- preserve clear tenant boundaries
```

---

## Database design principles

### 1. Application-generated IDs

Use application-generated prefixed IDs from `@repo/contracts`.

Examples:

```text
org_01HW...
usr_01HW...
inst_01HW...
repo_01HW...
pr_01HW...
idx_01HW...
file_01HW...
sym_01HW...
chunk_01HW...
rrn_01HW...
fnd_01HW...
```

Use `text` columns for these IDs.

Do not use provider IDs as primary keys. Provider IDs are stored separately.

Reasoning:

```text
- provider-neutral core
- easier fixture generation
- easier replay
- easier future GitLab support
- stable IDs across service boundaries
- no need to wait for DB-generated IDs inside artifact pipelines
```

---

### 2. Provider IDs are external references

For GitHub repositories, installations, comments, users, and PRs, store provider IDs as text.

Example:

```text
repo.id                     = repo_01HW...
repo.provider               = github
repo.provider_repo_id       = 123456789
repo.full_name              = owner/name
```

Unique constraints should use provider IDs where appropriate:

```text
unique(provider, provider_repo_id)
unique(provider, provider_installation_id)
unique(repo_id, pull_request_number)
unique(repo_id, provider_pull_request_id)
```

---

### 3. Immutable snapshots, mutable status rows

A review run should be reproducible.

Immutable or append-only data:

```text
PR snapshot
raw diff hash
context bundle artifact
LLM prompt artifact
LLM response artifact
candidate findings
validation results
published finding record
finding outcome event
```

Mutable data:

```text
review run status
index version status
repository enabled flag
repository settings
memory fact status
published comment status
```

A good debugging question should always be answerable:

```text
For review run rrn_123:
- which PR snapshot was used?
- which index versions were used?
- what context was retrieved?
- which prompts were sent?
- what candidate findings were generated?
- which findings were rejected and why?
- which findings were published?
- what user feedback happened afterward?
```

---

### 4. Queryable fields should be columns

Do not hide important query fields in JSONB.

Use columns for:

```text
org_id
repo_id
commit_sha
pull_request_number
head_sha
base_sha
status
provider
created_at
updated_at
severity
category
confidence
file_path
line
model
prompt_version
cost
```

Use JSONB for:

```text
provider-specific raw metadata
LLM structured raw output
artifact metadata
parser metadata
diagnostic payloads
settings with low query frequency
future extension fields
```

Rule of thumb:

> If you need to filter, join, sort, paginate, or aggregate on it, make it a column.

---

### 5. Denormalize `org_id` and `repo_id` where useful

Many rows can technically infer `org_id` from `repo_id`. Still, include `org_id` on high-volume tables.

High-volume tables should usually include:

```text
org_id
repo_id
created_at
```

Examples:

```text
repo_index_versions
indexed_files
symbols
code_chunks
review_runs
review_run_stage_events
review_run_dependencies
candidate_findings
publish_runs
published_reviews
published_findings
published_summary_comments
published_check_runs
publish_operations
llm_calls
llm_call_artifacts
usage_events
```

Reasoning:

```text
- faster tenant-scoped queries
- easier billing rollups
- easier deletion/export by org
- easier partitioning later
- simpler access-control checks
```

---

### 6. Prefer soft deletion for customer-visible entities

Soft-delete:

```text
orgs
users
repositories
repo_rules
memory_facts
```

Hard-delete or expire:

```text
old webhook payloads
old debug artifacts
old temporary job records
short-lived idempotency records
```

Use:

```text
deleted_at timestamptz null
```

for soft-deleted entities.

---

### 7. Keep artifact data replayable

Large artifacts should live in object storage:

```text
s3://.../review-runs/rrn_123/context-bundle.json
s3://.../review-runs/rrn_123/prompt-correctness.json
s3://.../indexes/idx_123/records.jsonl
```

Postgres stores:

```text
artifact_uri
artifact_hash
artifact_kind
size_bytes
content_type
created_at
```

Small artifacts can be stored inline in JSONB for convenience, but the default should be external artifact references.

---

### 8. Make jobs idempotent

The database should help prevent duplicate work.

Important unique keys:

```text
webhook_events(provider, delivery_id)
repositories(provider, provider_repo_id)
pull_requests(repo_id, pull_request_number)
repo_index_versions(repo_id, commit_sha, index_key)
review_runs(repo_id, pull_request_number, head_sha, settings_hash, prompt_version)
publish_runs(idempotency_key)
published_findings(candidate_finding_id, artifact_type)
published_findings(repo_id, pull_request_number, head_sha, fingerprint, artifact_type)
published_findings(provider, external_comment_id)
code_chunk_embeddings(content_hash, embedding_model)
```

Idempotency should exist at three layers:

```text
1. webhook delivery ID
2. queue/job dedupe key
3. DB unique constraints
```

---

## Package location

Implement the database layer here:

```text
/packages/db
```

Suggested structure:

```text
/packages/db
  package.json
  drizzle.config.ts
  src/
    index.ts
    client.ts
    migrate.ts
    health.ts
    ids.ts
    errors.ts
    locks.ts
    sql.ts
    transaction.ts
    schema/
      index.ts
      common.ts
      identity.ts
      installations.ts
      repositories.ts
      webhooks.ts
      pull-requests.ts
      indexing.ts
      embeddings.ts
      reviews.ts
      findings.ts
      memory.ts
      llm.ts
      usage.ts
      audit.ts
      jobs.ts
      idempotency.ts
    queries/
      index.ts
      orgs.ts
      users.ts
      installations.ts
      repositories.ts
      webhooks.ts
      pull-requests.ts
      indexes.ts
      chunks.ts
      embeddings.ts
      review-runs.ts
      findings.ts
      memory.ts
      llm.ts
      usage.ts
      jobs.ts
    mappers/
      repository.ts
      pull-request.ts
      index-records.ts
      review.ts
      finding.ts
    test/
      fixtures.ts
      test-db.ts
  drizzle/
    0000_extensions.sql
    0001_initial_schema.sql
```

Root-level integration:

```text
/apps/api        imports @repo/db
/apps/worker     imports @repo/db
/packages/...    import query modules only where needed
```

---

## Package dependencies

`/packages/db/package.json`:

```json
{
  "name": "@repo/db",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "build": "tsc -b",
    "typecheck": "tsc -b --pretty false",
    "test": "vitest run",
    "test:watch": "vitest",
    "db:generate": "drizzle-kit generate --config drizzle.config.ts",
    "db:migrate": "bun src/migrate.ts",
    "db:studio": "drizzle-kit studio --config drizzle.config.ts",
    "db:check": "drizzle-kit check --config drizzle.config.ts"
  },
  "dependencies": {
    "@repo/contracts": "workspace:*",
    "@repo/config": "workspace:*",
    "drizzle-orm": "^0.36.0",
    "postgres": "^3.4.0"
  },
  "devDependencies": {
    "drizzle-kit": "^0.27.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

Version numbers should be pinned according to the monorepo dependency policy from #1.

---

## Environment variables

Database configuration should live in `@repo/config` and be consumed by `@repo/db`.

Required:

```text
DATABASE_URL
```

Recommended:

```text
DATABASE_POOL_MAX=10
DATABASE_IDLE_TIMEOUT_SECONDS=30
DATABASE_CONNECT_TIMEOUT_SECONDS=10
DATABASE_SSL=false
DATABASE_STATEMENT_TIMEOUT_MS=30000
DATABASE_MIGRATION_LOCK_TIMEOUT_MS=30000
```

Optional later:

```text
DATABASE_READ_REPLICA_URL
DATABASE_SHADOW_URL
DATABASE_LOG_QUERIES=false
DATABASE_APPLICATION_NAME=code-review-agent
```

---

## Extensions

First migration:

```sql
create extension if not exists vector;
create extension if not exists pgcrypto;
```

Optional:

```sql
create extension if not exists citext;
```

Do not rely on database-generated UUIDs for core IDs, but `pgcrypto` is still useful for occasional database-side hashes and migration utilities.

---

## Enum strategy

Recommendation:

> Use `text` columns with TypeScript-level enum typing and contract validation. Avoid Postgres enum types for fast-moving product states.

Why:

```text
- states evolve frequently early on
- Postgres enum migrations are more annoying
- text columns are easier to extend
- @repo/contracts already defines runtime schemas
```

For highly stable values, add check constraints later.

Examples of text-enum columns:

```text
provider
repository_status
review_status
finding_severity
finding_category
index_status
job_status
```

Use Drizzle `$type<...>()` to retain TypeScript typing.

---

## Common columns and helpers

`src/schema/common.ts`:

```ts
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  integer,
  jsonb,
  numeric,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const createdAt = timestamp("created_at", { withTimezone: true })
  .notNull()
  .defaultNow();

export const updatedAt = timestamp("updated_at", { withTimezone: true })
  .notNull()
  .defaultNow();

export const deletedAt = timestamp("deleted_at", { withTimezone: true });

export const timestamptz = (name: string) =>
  timestamp(name, { withTimezone: true });

export const metadata = jsonb("metadata")
  .$type<Record<string, unknown>>()
  .notNull()
  .default(sql`'{}'::jsonb`);

export const requiredJsonb = <T>(name: string) =>
  jsonb(name).$type<T>().notNull();

export const optionalJsonb = <T>(name: string) =>
  jsonb(name).$type<T>();

export const moneyMicros = (name: string) =>
  bigint(name, { mode: "number" }).notNull().default(0);

export const positiveInteger = (name: string) =>
  integer(name).notNull();
```

For `updated_at`, either update it in application code or install a trigger. The trigger is useful because it prevents stale timestamps when raw SQL is used.

```sql
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;
```

Then per table:

```sql
create trigger set_repositories_updated_at
before update on repositories
for each row
execute function set_updated_at();
```

Recommendation:

```text
Use DB triggers for updated_at on mutable tables.
Do not use triggers for business logic.
```

---

## Database client

`src/client.ts`:

```ts
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema";
import { config } from "@repo/config";

export function createSqlClient(options?: { max?: number }) {
  return postgres(config.database.url, {
    max: options?.max ?? config.database.poolMax,
    idle_timeout: config.database.idleTimeoutSeconds,
    connect_timeout: config.database.connectTimeoutSeconds,
    prepare: true,
    onnotice: () => {},
  });
}

export function createDb(options?: { max?: number }) {
  const sql = createSqlClient(options);
  const db = drizzle(sql, { schema });
  return { db, sql };
}

export type DbClient = ReturnType<typeof createDb>["db"];
export type SqlClient = ReturnType<typeof createDb>["sql"];
```

For services:

```ts
export const { db, sql } = createDb();
```

For tests:

```ts
const { db, sql } = createDb({ max: 1 });
```

Guidance:

```text
API service:    pool max 5-20 depending on deployment
worker service: pool max tuned by worker concurrency
migrations:     pool max 1
scripts:        pool max 1-3
```

Avoid creating new pools per request or per job.

---

## Migration setup

`drizzle.config.ts`:

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  verbose: true,
  strict: true,
});
```

Migration runner:

`src/migrate.ts`:

```ts
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "./client";

async function main() {
  const { db, sql } = createDb({ max: 1 });

  try {
    await migrate(db, { migrationsFolder: "./drizzle" });
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

Commands:

```bash
pnpm --filter @repo/db db:generate
pnpm --filter @repo/db db:migrate
pnpm --filter @repo/db db:studio
pnpm --filter @repo/db db:check
```

Migration rules:

```text
- generated SQL must be reviewed before merge
- migrations must be forward-compatible with currently running services
- use additive migrations before code changes when possible
- use backfills as separate scripts/jobs, not giant deploy-time migrations
- never drop columns/tables in the same release that stops using them
- avoid long exclusive locks on high-volume tables
```

---

## Schema overview

Tables by domain:

```text
Identity and tenancy
  orgs
  users
  org_memberships
  user_provider_accounts

Provider installation and repositories
  provider_installations
  repositories
  repository_settings

Webhook and idempotency
  webhook_events
  idempotency_records
  background_jobs

Pull requests
  pull_requests
  pull_request_snapshots

Indexing and code intelligence
  repo_index_versions
  indexed_files
  symbols
  code_edges
  code_chunks
  index_import_batches

Embeddings
  code_chunk_embeddings
  embedding_jobs

Reviews and findings
  review_runs
  review_run_stage_events
  review_run_dependencies
  review_artifacts
  candidate_findings
  publish_runs
  published_reviews
  published_findings
  published_summary_comments
  published_check_runs
  publish_operations
  finding_outcomes

Rules and memory
  repo_rules
  memory_facts

LLM and usage
  llm_calls
  llm_call_artifacts
  usage_events

Audit and admin
  audit_logs
```

---

# 1. Identity and tenancy tables

## `orgs`

Represents a customer/team/org inside your product.

Columns:

```text
id                text primary key      org_...
name              text not null
slug              text not null unique
avatar_url        text null
billing_status    text not null default 'none'
plan              text not null default 'free'
metadata          jsonb not null default '{}'
created_at        timestamptz not null default now()
updated_at        timestamptz not null default now()
deleted_at        timestamptz null
```

Indexes:

```sql
create unique index orgs_slug_unique_idx on orgs (slug) where deleted_at is null;
create index orgs_created_at_idx on orgs (created_at desc);
```

Notes:

```text
- org.id is internal and provider-neutral
- slug is user-facing and can change later with history if needed
- billing fields are simple placeholders until #28
```

---

## `users`

Represents a product user.

Columns:

```text
id                text primary key      usr_...
primary_email     text null
name              text null
avatar_url        text null
status            text not null default 'active'
last_login_at     timestamptz null
metadata          jsonb not null default '{}'
created_at        timestamptz not null default now()
updated_at        timestamptz not null default now()
deleted_at        timestamptz null
```

Indexes:

```sql
create unique index users_primary_email_lower_unique_idx
on users (lower(primary_email))
where primary_email is not null and deleted_at is null;

create index users_status_idx on users (status);
```

---

## `org_memberships`

Maps users to orgs.

Columns:

```text
org_id            text not null references orgs(id)
user_id           text not null references users(id)
role              text not null        owner | admin | member | viewer
status            text not null        active | invited | removed
created_at        timestamptz not null default now()
updated_at        timestamptz not null default now()
removed_at        timestamptz null
```

Primary key:

```sql
primary key (org_id, user_id)
```

Indexes:

```sql
create index org_memberships_user_id_idx on org_memberships (user_id);
create index org_memberships_org_role_idx on org_memberships (org_id, role);
```

---

## `user_provider_accounts`

Maps a product user to GitHub or future providers.

Columns:

```text
id                    text primary key
user_id               text not null references users(id)
provider              text not null        github | gitlab | bitbucket
provider_user_id      text not null
provider_login        text not null
provider_email        text null
avatar_url            text null
profile_url           text null
raw                   jsonb not null default '{}'
created_at            timestamptz not null default now()
updated_at            timestamptz not null default now()
```

Indexes:

```sql
create unique index user_provider_accounts_provider_user_unique_idx
on user_provider_accounts (provider, provider_user_id);

create index user_provider_accounts_user_idx
on user_provider_accounts (user_id);
```

---

# 2. Provider installation and repository tables

## `provider_installations`

Represents a GitHub App installation or equivalent future provider installation.

Columns:

```text
id                            text primary key      inst_...
org_id                        text not null references orgs(id)
provider                      text not null          github
authorizing_user_id            text null references users(id)
provider_installation_id       text not null
provider_account_id            text null
provider_account_login         text null
provider_account_type          text null             User | Organization
status                         text not null          active | suspended | deleted
permissions                    jsonb not null default '{}'
events                         jsonb not null default '[]'
installed_at                   timestamptz null
suspended_at                   timestamptz null
uninstalled_at                 timestamptz null
metadata                       jsonb not null default '{}'
created_at                     timestamptz not null default now()
updated_at                     timestamptz not null default now()
```

Indexes:

```sql
create unique index provider_installations_provider_installation_unique_idx
on provider_installations (provider, provider_installation_id);

create index provider_installations_org_idx
on provider_installations (org_id, status);
```

Notes:

```text
- Do not store installation access tokens here.
- Installation tokens are short-lived and should be requested on demand.
- If any long-lived secret is stored later, encrypt it outside normal JSONB columns.
```

---

## `repositories`

Represents a repository known to the system.

Columns:

```text
id                    text primary key      repo_...
org_id                text not null references orgs(id)
installation_id       text not null references provider_installations(id)
provider              text not null          github
provider_repo_id      text not null
owner                 text not null
name                  text not null
full_name             text not null          owner/name
default_branch        text null
visibility            text not null          private | public | internal
is_private            boolean not null default true
is_fork               boolean not null default false
is_archived           boolean not null default false
is_enabled            boolean not null default false
status                text not null default 'active'
primary_language      text null
html_url              text null
clone_url             text null
provider_created_at   timestamptz null
provider_updated_at   timestamptz null
provider_pushed_at    timestamptz null
last_synced_at        timestamptz null
metadata              jsonb not null default '{}'
created_at            timestamptz not null default now()
updated_at            timestamptz not null default now()
deleted_at            timestamptz null
```

Indexes:

```sql
create unique index repositories_provider_repo_unique_idx
on repositories (provider, provider_repo_id);

create unique index repositories_org_full_name_unique_idx
on repositories (org_id, lower(full_name))
where deleted_at is null;

create index repositories_org_enabled_idx
on repositories (org_id, is_enabled, status);

create index repositories_installation_idx
on repositories (installation_id);

create index repositories_full_name_trgm_idx
on repositories using gin (full_name gin_trgm_ops);
```

The trigram index requires `pg_trgm`; skip it for MVP unless repository search becomes important.

Notes:

```text
- is_enabled controls whether review jobs are allowed.
- status tracks provider-level lifecycle: active, archived, deleted, unavailable.
- deleted_at is internal soft deletion.
```

---

## `repository_settings`

Mutable per-repository review settings.

Columns:

```text
repo_id                     text primary key references repositories(id)
org_id                      text not null references orgs(id)
is_review_enabled            boolean not null default false
review_policy                text not null default 'inline_comments_and_summary'
severity_threshold           text not null default 'medium'
max_comments_per_pr          integer not null default 5
max_context_tokens           integer not null default 120000
ignored_paths                text[] not null default '{}'
ignored_authors              text[] not null default '{}'
ignored_labels               text[] not null default '{}'
required_labels              text[] not null default '{}'
skip_draft_prs               boolean not null default true
skip_generated_files         boolean not null default true
include_tests_in_context     boolean not null default true
allow_static_analysis        boolean not null default false
allow_sandbox_execution      boolean not null default false
model_profile                text not null default 'default'
settings_hash                text not null
metadata                     jsonb not null default '{}'
created_at                   timestamptz not null default now()
updated_at                   timestamptz not null default now()
```

Indexes:

```sql
create index repository_settings_org_idx
on repository_settings (org_id);

create index repository_settings_enabled_idx
on repository_settings (is_review_enabled)
where is_review_enabled = true;
```

Notes:

```text
- settings_hash should be updated whenever review-affecting settings change.
- review_runs should copy the settings_hash they used.
- This lets you understand why two reviews at the same head SHA differed.
```

---

# 3. Webhook, idempotency, and background job tables

## `webhook_events`

Stores normalized webhook deliveries for idempotency and debugging.

Columns:

```text
id                            text primary key
provider                      text not null            github
delivery_id                   text not null
event_name                    text not null            pull_request, installation, etc.
action                        text null                opened, synchronize, etc.
org_id                        text null references orgs(id)
installation_id               text null references provider_installations(id)
provider_installation_id      text null
repo_id                       text null references repositories(id)
provider_repo_id              text null
pull_request_number           integer null
status                        text not null default 'received'
received_at                   timestamptz not null default now()
queued_at                     timestamptz null
processed_at                  timestamptz null
failed_at                     timestamptz null
payload_hash                  text not null
payload                       jsonb not null
error_message                 text null
metadata                      jsonb not null default '{}'
```

Indexes:

```sql
create unique index webhook_events_provider_delivery_unique_idx
on webhook_events (provider, delivery_id);

create index webhook_events_repo_received_idx
on webhook_events (repo_id, received_at desc);

create index webhook_events_status_idx
on webhook_events (status, received_at desc);

create index webhook_events_event_action_idx
on webhook_events (event_name, action, received_at desc);
```

Retention:

```text
- Keep full payloads for 30-90 days by default.
- Keep normalized metadata longer if needed.
- Payload retention should become org-configurable for enterprise.
```

---

## `idempotency_records`

Generic idempotency table for operations that must not run twice.

Columns:

```text
key                 text primary key
scope               text not null             webhook | review | index | publish | billing
operation           text not null
status              text not null             started | completed | failed
request_hash        text null
result              jsonb null
locked_until        timestamptz null
expires_at          timestamptz null
created_at          timestamptz not null default now()
updated_at          timestamptz not null default now()
```

Indexes:

```sql
create index idempotency_records_scope_idx
on idempotency_records (scope, created_at desc);

create index idempotency_records_expires_idx
on idempotency_records (expires_at)
where expires_at is not null;
```

Examples of keys:

```text
webhook:github:<delivery_id>
index:<repo_id>:<commit_sha>:<index_key>
review:<repo_id>:<pr_number>:<head_sha>:<settings_hash>:<prompt_version>
publish:<review_run_id>
```

---

## `background_jobs`

Postgres status mirror for queue jobs. BullMQ remains the actual queue, but this table gives durable product-level visibility.

Columns:

```text
id                    text primary key
queue_name            text not null
job_name              text not null
job_key               text not null
bullmq_job_id         text null
org_id                text null references orgs(id)
repo_id               text null references repositories(id)
review_run_id         text null
status                text not null           queued | running | succeeded | failed | canceled | dead
priority              integer not null default 0
attempts              integer not null default 0
max_attempts          integer not null default 3
payload               jsonb not null
result                jsonb null
error_message         text null
error_stack           text null
scheduled_at          timestamptz null
started_at            timestamptz null
completed_at          timestamptz null
failed_at             timestamptz null
created_at            timestamptz not null default now()
updated_at            timestamptz not null default now()
```

Indexes:

```sql
create unique index background_jobs_job_key_unique_idx
on background_jobs (queue_name, job_key);

create index background_jobs_status_idx
on background_jobs (status, created_at desc);

create index background_jobs_repo_idx
on background_jobs (repo_id, created_at desc);

create index background_jobs_review_run_idx
on background_jobs (review_run_id);
```

Notes:

```text
- Do not put huge payloads here.
- Store artifact refs for large payloads.
- Use job_key for dedupe.
```

---

# 4. Pull request tables

## `pull_requests`

Current known state of a PR/MR.

Columns:

```text
id                         text primary key        pr_...
org_id                     text not null references orgs(id)
repo_id                    text not null references repositories(id)
provider                   text not null            github
provider_pull_request_id   text null
pull_request_number        integer not null
title                      text not null
body                       text null
author_login               text null
author_provider_user_id    text null
state                      text not null            open | closed | merged
draft                      boolean not null default false
base_branch                text not null
head_branch                text not null
base_sha                   text not null
head_sha                   text not null
merge_base_sha             text null
labels                     text[] not null default '{}'
html_url                   text null
opened_at                  timestamptz null
closed_at                  timestamptz null
merged_at                  timestamptz null
last_synced_at             timestamptz not null default now()
metadata                   jsonb not null default '{}'
created_at                 timestamptz not null default now()
updated_at                 timestamptz not null default now()
```

Indexes:

```sql
create unique index pull_requests_repo_number_unique_idx
on pull_requests (repo_id, pull_request_number);

create unique index pull_requests_provider_pr_unique_idx
on pull_requests (provider, provider_pull_request_id)
where provider_pull_request_id is not null;

create index pull_requests_repo_state_idx
on pull_requests (repo_id, state, updated_at desc);

create index pull_requests_org_updated_idx
on pull_requests (org_id, updated_at desc);
```

---

## `pull_request_snapshots`

Immutable normalized snapshots used by review runs.

Columns:

```text
id                         text primary key
org_id                     text not null references orgs(id)
repo_id                    text not null references repositories(id)
pull_request_id            text not null references pull_requests(id)
pull_request_number        integer not null
base_sha                   text not null
head_sha                   text not null
merge_base_sha             text null
diff_hash                  text not null
snapshot_hash              text not null
changed_file_count         integer not null
changed_line_count         integer not null default 0
artifact_uri               text null
artifact_size_bytes        bigint null
snapshot_inline            jsonb null
created_at                 timestamptz not null default now()
```

Indexes:

```sql
create unique index pull_request_snapshots_unique_idx
on pull_request_snapshots (repo_id, pull_request_number, base_sha, head_sha, diff_hash);

create index pull_request_snapshots_pr_idx
on pull_request_snapshots (pull_request_id, created_at desc);

create index pull_request_snapshots_repo_head_idx
on pull_request_snapshots (repo_id, head_sha);
```

Notes:

```text
- Store small snapshots inline if useful.
- Store large snapshots as artifact files.
- review_runs should reference the snapshot used.
```

---

# 5. Indexing and code intelligence tables

## Indexing model

The indexer emits a versioned artifact:

```text
index-manifest.json
records.jsonl
```

The importer writes normalized rows into Postgres.

The active query path should only use complete/ready index versions:

```text
repo_index_versions.status = 'ready'
```

Partial imports should never be visible to retrieval.

---

## `repo_index_versions`

Represents one index of one repo at one commit using one indexer configuration.

Columns:

```text
id                         text primary key        idx_...
org_id                     text not null references orgs(id)
repo_id                    text not null references repositories(id)
commit_sha                 text not null
index_key                  text not null
schema_version             text not null
indexer_name               text not null
indexer_version            text not null
chunker_version            text not null
parser_versions            jsonb not null default '{}'
languages                  text[] not null default '{}'
status                     text not null            queued | running | importing | embedding | ready | failed | superseded
artifact_uri               text null
artifact_hash              text null
artifact_size_bytes        bigint null
file_count                 integer not null default 0
symbol_count               integer not null default 0
edge_count                 integer not null default 0
chunk_count                integer not null default 0
embedded_chunk_count       integer not null default 0
started_at                 timestamptz null
imported_at                timestamptz null
embedded_at                timestamptz null
completed_at               timestamptz null
failed_at                  timestamptz null
error_message              text null
metadata                   jsonb not null default '{}'
created_at                 timestamptz not null default now()
updated_at                 timestamptz not null default now()
```

`index_key` should be deterministic from:

```text
schema_version
indexer_name
indexer_version
chunker_version
selected language analyzers
indexer options
```

Indexes:

```sql
create unique index repo_index_versions_unique_idx
on repo_index_versions (repo_id, commit_sha, index_key);

create index repo_index_versions_repo_commit_status_idx
on repo_index_versions (repo_id, commit_sha, status);

create index repo_index_versions_repo_created_idx
on repo_index_versions (repo_id, created_at desc);

create index repo_index_versions_status_idx
on repo_index_versions (status, created_at desc);
```

Important query:

```sql
select *
from repo_index_versions
where repo_id = $1
  and commit_sha = $2
  and index_key = $3
  and status = 'ready'
limit 1;
```

---

## `index_import_batches`

Tracks batch-level importer progress. Useful for large repos and debugging.

Columns:

```text
id                    text primary key
index_version_id      text not null references repo_index_versions(id)
org_id                text not null references orgs(id)
repo_id               text not null references repositories(id)
batch_number          integer not null
record_type           text not null       file | symbol | edge | chunk | diagnostic
record_count          integer not null default 0
status                text not null       started | completed | failed
started_at            timestamptz not null default now()
completed_at          timestamptz null
error_message         text null
metadata              jsonb not null default '{}'
```

Indexes:

```sql
create unique index index_import_batches_unique_idx
on index_import_batches (index_version_id, record_type, batch_number);

create index index_import_batches_status_idx
on index_import_batches (status, started_at desc);
```

MVP can skip this table if importer is simple, but it is useful once repos become large.

---

## `indexed_files`

One file record in one index version.

Columns:

```text
id                    text primary key          file_...
index_version_id      text not null references repo_index_versions(id)
org_id                text not null references orgs(id)
repo_id               text not null references repositories(id)
commit_sha            text not null
path                  text not null
language              text null
content_hash          text not null             sha256:...
size_bytes            bigint not null default 0
line_count            integer not null default 0
is_test               boolean not null default false
is_generated          boolean not null default false
is_binary             boolean not null default false
is_vendor             boolean not null default false
symbol_count          integer not null default 0
chunk_count           integer not null default 0
metadata              jsonb not null default '{}'
created_at            timestamptz not null default now()
```

Indexes:

```sql
create unique index indexed_files_index_path_unique_idx
on indexed_files (index_version_id, path);

create index indexed_files_repo_commit_path_idx
on indexed_files (repo_id, commit_sha, path);

create index indexed_files_content_hash_idx
on indexed_files (content_hash);

create index indexed_files_repo_language_idx
on indexed_files (repo_id, commit_sha, language);
```

---

## `symbols`

Function/class/type/module symbols extracted by the indexer.

Columns:

```text
id                    text primary key          sym_...
index_version_id      text not null references repo_index_versions(id)
org_id                text not null references orgs(id)
repo_id               text not null references repositories(id)
commit_sha            text not null
file_id               text not null references indexed_files(id)
path                  text not null
name                  text not null
qualified_name        text null
kind                  text not null             function | class | method | module | type | variable | interface | enum
parent_symbol_id      text null
start_line            integer not null
end_line              integer not null
start_column          integer null
end_column            integer null
start_byte            integer null
end_byte              integer null
signature             text null
docstring             text null
content_hash          text not null
metadata              jsonb not null default '{}'
created_at            timestamptz not null default now()
```

Indexes:

```sql
create index symbols_index_file_idx
on symbols (index_version_id, file_id);

create index symbols_repo_commit_path_line_idx
on symbols (repo_id, commit_sha, path, start_line, end_line);

create index symbols_repo_name_idx
on symbols (repo_id, commit_sha, name);

create index symbols_repo_qualified_name_idx
on symbols (repo_id, commit_sha, qualified_name)
where qualified_name is not null;

create index symbols_content_hash_idx
on symbols (content_hash);
```

Line lookup query:

```sql
select *
from symbols
where repo_id = $1
  and commit_sha = $2
  and path = $3
  and start_line <= $4
  and end_line >= $4
order by (end_line - start_line) asc
limit 1;
```

---

## `code_edges`

Graph-like relationships between files/symbols.

Columns:

```text
id                    text primary key          edge_...
index_version_id      text not null references repo_index_versions(id)
org_id                text not null references orgs(id)
repo_id               text not null references repositories(id)
commit_sha            text not null
from_file_id          text null references indexed_files(id)
from_symbol_id        text null references symbols(id)
to_file_id            text null references indexed_files(id)
to_symbol_id          text null references symbols(id)
kind                  text not null             imports | exports | calls | references | tests | configures | routes_to | reads | writes
confidence            numeric(4,3) not null default 1.0
metadata              jsonb not null default '{}'
created_at            timestamptz not null default now()
```

Indexes:

```sql
create index code_edges_from_symbol_idx
on code_edges (from_symbol_id, kind);

create index code_edges_to_symbol_idx
on code_edges (to_symbol_id, kind);

create index code_edges_from_file_idx
on code_edges (from_file_id, kind);

create index code_edges_to_file_idx
on code_edges (to_file_id, kind);

create index code_edges_repo_kind_idx
on code_edges (repo_id, commit_sha, kind);
```

Notes:

```text
- Use confidence because some edges are exact and others are heuristic.
- For imports, file-to-file edges may be enough.
- For calls, symbol-to-symbol edges are preferred when available.
```

---

## `code_chunks`

Text chunks used for retrieval and embeddings.

Columns:

```text
id                    text primary key          chunk_...
index_version_id      text not null references repo_index_versions(id)
org_id                text not null references orgs(id)
repo_id               text not null references repositories(id)
commit_sha            text not null
file_id               text not null references indexed_files(id)
symbol_id             text null references symbols(id)
path                  text not null
chunk_kind            text not null default 'code'      code | symbol | file_summary | module_summary | doc | config | test
start_line            integer not null
end_line              integer not null
content               text not null
content_hash          text not null
content_tokens        integer null
language              text null
is_test               boolean not null default false
is_generated          boolean not null default false
metadata              jsonb not null default '{}'
created_at            timestamptz not null default now()
```

Indexes:

```sql
create unique index code_chunks_index_path_range_unique_idx
on code_chunks (index_version_id, path, start_line, end_line, content_hash);

create index code_chunks_repo_commit_path_idx
on code_chunks (repo_id, commit_sha, path);

create index code_chunks_repo_symbol_idx
on code_chunks (repo_id, commit_sha, symbol_id)
where symbol_id is not null;

create index code_chunks_content_hash_idx
on code_chunks (content_hash);

create index code_chunks_repo_kind_idx
on code_chunks (repo_id, commit_sha, chunk_kind);
```

Notes:

```text
- Storing chunk content in Postgres is fine for MVP.
- Later, very large content can move to object storage with content_uri.
- Keep content_hash stable across index versions to reuse embeddings.
```

---

# 6. Embedding tables

## Embedding model

Separate indexing from embedding.

Flow:

```text
index artifact imported
  -> code_chunks inserted
  -> embedding jobs created for chunks without embedding
  -> embedding worker batches calls
  -> code_chunk_embeddings inserted
```

Embeddings should be cached by content hash and model.

---

## `code_chunk_embeddings`

Stores vectors for chunks.

Columns:

```text
id                    text primary key
org_id                text not null references orgs(id)
repo_id               text not null references repositories(id)
index_version_id      text not null references repo_index_versions(id)
chunk_id              text not null references code_chunks(id)
content_hash          text not null
embedding_model       text not null
embedding_dimension   integer not null default 1536
embedding             vector(1536) not null
created_at            timestamptz not null default now()
```

Indexes:

```sql
create unique index code_chunk_embeddings_chunk_model_unique_idx
on code_chunk_embeddings (chunk_id, embedding_model);

create index code_chunk_embeddings_content_model_idx
on code_chunk_embeddings (content_hash, embedding_model);

create index code_chunk_embeddings_repo_commit_idx
on code_chunk_embeddings (repo_id, index_version_id);

create index code_chunk_embeddings_vector_hnsw_idx
on code_chunk_embeddings
using hnsw (embedding vector_cosine_ops);
```

Important:

```text
- vector(1536) assumes the selected MVP embedding dimension.
- If you switch embedding dimensions, create a separate table or migration.
- Do not mix dimensions in one indexed vector column.
```

Possible future design:

```text
code_chunk_embeddings_1536
code_chunk_embeddings_3072
```

or:

```text
embedding_spaces
embedding_space_chunks
```

Do not implement that complexity in MVP unless needed.

---

## `embedding_jobs`

Optional status table for embedding batches.

Columns:

```text
id                    text primary key
org_id                text not null references orgs(id)
repo_id               text not null references repositories(id)
index_version_id      text not null references repo_index_versions(id)
embedding_model       text not null
status                text not null       queued | running | succeeded | failed
chunk_count           integer not null default 0
attempts              integer not null default 0
started_at            timestamptz null
completed_at          timestamptz null
failed_at             timestamptz null
error_message         text null
created_at            timestamptz not null default now()
updated_at            timestamptz not null default now()
```

Indexes:

```sql
create index embedding_jobs_status_idx
on embedding_jobs (status, created_at desc);

create index embedding_jobs_index_version_idx
on embedding_jobs (index_version_id);
```

MVP can rely on `background_jobs` instead. Add this table only if embedding-specific observability becomes useful.

---

# 7. Review and finding tables

## `review_runs`

One attempt to review a PR snapshot.

Columns:

```text
id                         text primary key        rrn_...
org_id                     text not null references orgs(id)
repo_id                    text not null references repositories(id)
pull_request_id            text not null references pull_requests(id)
pull_request_snapshot_id   text null references pull_request_snapshots(id)
pull_request_number        integer not null
triggering_event_id        text null references webhook_events(id)
status                     text not null            created | snapshotting | waiting_for_index | waiting_for_embeddings | retrieving_context | reviewing | validating_findings | publish_queued | completed | skipped | superseded | canceled | failed
skip_reason                text null
base_sha                   text not null
head_sha                   text not null
merge_base_sha             text null
diff_hash                  text not null
base_index_version_id      text null references repo_index_versions(id)
head_index_version_id      text null references repo_index_versions(id)
settings_hash              text not null
prompt_version             text not null
model_profile              text not null
review_policy              text not null
execution_mode             text not null
pass_mode                  text not null
publish_mode               text not null
review_size_class          text not null
summary                    text null
summary_artifact_id        text null
provider_check_run_id      text null
provider_review_id         text null
published_comment_count    integer not null default 0
candidate_finding_count    integer not null default 0
rejected_finding_count     integer not null default 0
latency_ms                 integer null
cost_usd_micros            bigint not null default 0
started_at                 timestamptz null
completed_at               timestamptz null
failed_at                  timestamptz null
error_message              text null
metadata                   jsonb not null default '{}'
created_at                 timestamptz not null default now()
updated_at                 timestamptz not null default now()
```

Indexes:

```sql
create unique index review_runs_idempotency_unique_idx
on review_runs (repo_id, pull_request_number, head_sha, settings_hash, prompt_version);

create index review_runs_repo_pr_idx
on review_runs (repo_id, pull_request_number, created_at desc);

create index review_runs_org_created_idx
on review_runs (org_id, created_at desc);

create index review_runs_status_idx
on review_runs (status, created_at desc);

create index review_runs_head_sha_idx
on review_runs (repo_id, head_sha);
```

Notes:

```text
- Review run is the central debug object.
- All review artifacts and findings connect back to review_run_id.
- Idempotency includes settings_hash and prompt_version because those affect output.
- Review policy, execution mode, pass mode, and publish mode are separate columns. Do not collapse them into one generic mode column.
- Status values mirror the canonical ReviewRunStatus contract from #0.
```

---

## `review_run_stage_events`

Append-only stage events for review orchestration debugging, replay, and latency analysis.

Columns:

```text
id                    text primary key
review_run_id         text not null references review_runs(id)
stage                 text not null
status                text not null        started | completed | failed | skipped
message               text null
metadata              jsonb not null default '{}'
started_at            timestamptz null
completed_at          timestamptz null
created_at            timestamptz not null default now()
```

Indexes:

```sql
create index review_run_stage_events_run_idx
on review_run_stage_events (review_run_id, created_at);
```

---

## `review_run_dependencies`

Durable dependencies that explain why a review is waiting for indexing, embeddings, or another prerequisite.

Columns:

```text
id                    text primary key
review_run_id         text not null references review_runs(id)
dependency_type       text not null        index_base | index_head | embeddings | external
dependency_key        text not null
status                text not null        pending | waiting | satisfied | failed | skipped
required              boolean not null default true
background_job_id     text null references background_jobs(id)
metadata              jsonb not null default '{}'
created_at            timestamptz not null default now()
updated_at            timestamptz not null default now()
```

Indexes:

```sql
create unique index review_run_dependencies_unique_idx
on review_run_dependencies (review_run_id, dependency_type, dependency_key);

create index review_run_dependencies_pending_idx
on review_run_dependencies (status, dependency_type);
```

---

## `review_artifacts`

Pointers to immutable debug/replay artifacts.

Columns:

```text
id                    text primary key
org_id                text not null references orgs(id)
repo_id               text not null references repositories(id)
review_run_id         text not null references review_runs(id)
kind                  text not null        pull_request_snapshot | raw_diff | diff_model | line_anchor_index | change_set | context_bundle | retrieval_trace | llm_prompt | llm_response | review_output | candidate_findings | validated_findings | rejected_findings | ranking_report | publish_plan | published_findings | publisher_trace | orchestrator_trace | static_analysis | debug_log
name                  text not null
artifact_uri          text null
artifact_hash         text not null
content_type          text not null default 'application/json'
size_bytes            bigint null
compression           text not null default 'none'    none | gzip | zstd
redaction_status      text not null default 'not_required'    not_required | redacted | contains_code
inline_content        jsonb null
metadata              jsonb not null default '{}'
created_at            timestamptz not null default now()
```

Indexes:

```sql
create unique index review_artifacts_run_kind_name_unique_idx
on review_artifacts (review_run_id, kind, name);

create index review_artifacts_repo_created_idx
on review_artifacts (repo_id, created_at desc);
```

Rule:

```text
Use either artifact_uri or inline_content.
Large artifacts should use artifact_uri.
Artifact kind names mirror ReviewArtifactKind from #0. Later phases must not define their own artifact vocabulary.
```

---

## `candidate_findings`

All findings generated by review passes before or after validation.

Columns:

```text
id                    text primary key        fnd_...
org_id                text not null references orgs(id)
repo_id               text not null references repositories(id)
review_run_id         text not null references review_runs(id)
source                text not null            llm | static_analysis | rule | memory | hybrid
source_pass           text null                correctness | security | tests | etc.
file_path             text not null
line                  integer null
end_line              integer null
side                  text null                LEFT | RIGHT
diff_hunk             text null
severity              text not null            info | low | medium | high | critical
category              text not null            correctness | security | performance | test_coverage | maintainability | architecture | style | dependency | documentation | other
title                 text not null
body                  text not null
suggested_fix         text null
evidence              jsonb not null default '[]'
confidence            numeric(4,3) not null
dedupe_key            text not null
validation_status     text not null default 'pending'    pending | accepted | rejected
rejection_reason      text null                canonical FindingRejectionReason from #0
validation_notes      text null
raw                   jsonb not null default '{}'
created_at            timestamptz not null default now()
validated_at          timestamptz null
```

Indexes:

```sql
create unique index candidate_findings_run_dedupe_unique_idx
on candidate_findings (review_run_id, dedupe_key);

create index candidate_findings_run_idx
on candidate_findings (review_run_id, created_at);

create index candidate_findings_repo_file_idx
on candidate_findings (repo_id, file_path);

create index candidate_findings_validation_idx
on candidate_findings (review_run_id, validation_status);

create index candidate_findings_severity_idx
on candidate_findings (repo_id, severity, created_at desc);
```

Notes:

```text
- Rejected findings are valuable. Keep them.
- They help improve prompts and validators.
- Do not publish directly from this table unless validation_status = accepted.
```

---

## `publish_runs`

One attempt to publish a validated publish plan.

Columns:

```text
id                       text primary key
publish_plan_id          text not null
review_run_id            text not null references review_runs(id)
repo_id                  text not null references repositories(id)
pull_request_number      integer not null
base_sha                 text not null
head_sha                 text not null
status                   text not null        pending | in_progress | published | partially_published | skipped | failed | canceled
mode                     text not null        canonical PublishMode from #0
dry_run                  boolean not null default false
idempotency_key          text not null
started_at               timestamptz not null default now()
completed_at             timestamptz null
skipped_reason           text null
failure_reason           text null
error_json               jsonb null
metadata                 jsonb not null default '{}'
created_at               timestamptz not null default now()
updated_at               timestamptz not null default now()
```

Indexes:

```sql
create unique index publish_runs_idempotency_unique_idx
on publish_runs (idempotency_key);

create index publish_runs_review_run_idx
on publish_runs (review_run_id, created_at desc);

create index publish_runs_repo_pr_idx
on publish_runs (repo_id, pull_request_number, created_at desc);
```

---

## `published_reviews`

Provider-visible grouped pull request reviews.

Columns:

```text
id                       text primary key
publish_run_id           text not null references publish_runs(id)
review_run_id            text not null references review_runs(id)
provider                 text not null
external_review_id       text not null
external_node_id         text null
external_url             text null
state                    text not null
body_hash                text null
comment_count            integer not null default 0
created_at               timestamptz not null default now()
```

Indexes:

```sql
create unique index published_reviews_external_unique_idx
on published_reviews (provider, external_review_id);
```

---

## `published_findings`

Findings that became provider-visible inline comments, check annotations, or summary references.

Columns:

```text
id                       text primary key
publish_run_id           text not null references publish_runs(id)
review_run_id            text not null references review_runs(id)
candidate_finding_id     text null references candidate_findings(id)
validated_finding_id     text not null
org_id                   text not null references orgs(id)
repo_id                  text not null references repositories(id)
pull_request_number      integer not null
head_sha                 text not null
provider                 text not null
artifact_type            text not null        review_comment | check_annotation | summary_reference
external_review_id       text null
external_comment_id      text null
external_check_run_id    text null
external_url             text null
file_path                text not null
line                     integer null
side                     text null            LEFT | RIGHT
fingerprint              text not null
body_hash                text not null
hidden_marker            text not null
status                   text not null        published | outdated | deleted | failed | skipped
published_at             timestamptz null
updated_at               timestamptz not null default now()
created_at               timestamptz not null default now()
metadata                 jsonb not null default '{}'
```

Indexes:

```sql
create unique index published_findings_candidate_artifact_unique_idx
on published_findings (candidate_finding_id, artifact_type)
where candidate_finding_id is not null;

create unique index published_findings_external_comment_unique_idx
on published_findings (provider, external_comment_id)
where external_comment_id is not null;

create unique index published_findings_fingerprint_unique_idx
on published_findings (repo_id, pull_request_number, head_sha, fingerprint, artifact_type);

create index published_findings_review_run_idx
on published_findings (review_run_id);

create index published_findings_repo_created_idx
on published_findings (repo_id, created_at desc);
```

Notes:

```text
- This table prevents reposting duplicate comments and annotations.
- external_comment_id may be null if publishing failed or if the finding was emitted as a check annotation only.
```

---

## `published_summary_comments`

Provider-visible PR-level summary comments.

Columns:

```text
id                       text primary key
publish_run_id           text not null references publish_runs(id)
review_run_id            text not null references review_runs(id)
repo_id                  text not null references repositories(id)
pull_request_number      integer not null
head_sha                 text not null
provider                 text not null
external_comment_id      text not null
external_url             text null
body_hash                text not null
hidden_marker            text not null
status                   text not null        published | updated | failed | skipped
created_at               timestamptz not null default now()
updated_at               timestamptz not null default now()
```

Indexes:

```sql
create unique index published_summary_comments_external_unique_idx
on published_summary_comments (provider, external_comment_id);
```

---

## `published_check_runs`

Provider-visible check runs created or updated by the publisher.

Columns:

```text
id                       text primary key
publish_run_id           text not null references publish_runs(id)
review_run_id            text not null references review_runs(id)
repo_id                  text not null references repositories(id)
head_sha                 text not null
provider                 text not null
external_check_run_id    text not null
external_url             text null
name                     text not null
status                   text not null
conclusion               text null
annotations_count        integer not null default 0
output_hash              text null
created_at               timestamptz not null default now()
updated_at               timestamptz not null default now()
```

Indexes:

```sql
create unique index published_check_runs_external_unique_idx
on published_check_runs (provider, external_check_run_id);
```

---

## `publish_operations`

Optional but recommended operation log for publish debugging and replay.

Columns:

```text
id                       text primary key
publish_run_id           text not null references publish_runs(id)
operation_type           text not null
provider                 text not null
status                   text not null        started | succeeded | failed | skipped
request_hash             text not null
response_json            jsonb null
error_json               jsonb null
started_at               timestamptz not null
completed_at             timestamptz null
created_at               timestamptz not null default now()
```

Indexes:

```sql
create index publish_operations_run_idx
on publish_operations (publish_run_id, created_at);
```

---

## `finding_outcomes`

Signals about whether findings were useful.

Columns:

```text
id                       text primary key
org_id                   text not null references orgs(id)
repo_id                  text not null references repositories(id)
review_run_id            text null references review_runs(id)
candidate_finding_id     text null references candidate_findings(id)
published_finding_id     text null references published_findings(id)
outcome                  text not null        accepted | rejected | ignored | resolved | replied | thumbs_up | thumbs_down | suppressed | fixed_in_commit
signal_source            text not null        github_reaction | github_reply | code_change | admin_label | system
actor_user_id            text null references users(id)
actor_login              text null
confidence               numeric(4,3) not null default 1.0
occurred_at              timestamptz not null
metadata                 jsonb not null default '{}'
created_at               timestamptz not null default now()
```

Indexes:

```sql
create index finding_outcomes_published_idx
on finding_outcomes (published_finding_id, occurred_at desc);

create index finding_outcomes_candidate_idx
on finding_outcomes (candidate_finding_id, occurred_at desc);

create index finding_outcomes_repo_outcome_idx
on finding_outcomes (repo_id, outcome, occurred_at desc);

create index finding_outcomes_org_created_idx
on finding_outcomes (org_id, created_at desc);
```

Notes:

```text
- This table is append-only.
- Do not overwrite history when feedback changes.
- Memory generation consumes this table.
```

---

# 8. Rules and memory tables

## `repo_rules`

Explicit user/system rules for review behavior.

Columns:

```text
id                    text primary key
org_id                text not null references orgs(id)
repo_id               text null references repositories(id)
scope                 text not null        org | repo
kind                  text not null        ignore_path | suppress_finding | review_instruction | severity_override | custom_rule
name                  text not null
description           text null
pattern               text null
category              text null
severity              text null
is_enabled            boolean not null default true
source                text not null default 'user'     user | system | memory
rule                  jsonb not null default '{}'
created_by_user_id    text null references users(id)
created_at            timestamptz not null default now()
updated_at            timestamptz not null default now()
deleted_at            timestamptz null
```

Indexes:

```sql
create index repo_rules_org_scope_idx
on repo_rules (org_id, scope, is_enabled)
where deleted_at is null;

create index repo_rules_repo_idx
on repo_rules (repo_id, is_enabled)
where deleted_at is null;
```

Examples:

```text
ignore_path:         src/generated/**
suppress_finding:   do not comment on import ordering
review_instruction: prioritize migration safety
severity_override:  auth issues are high severity
```

---

## `memory_facts`

Derived or manually added knowledge about a team/repo.

Columns:

```text
id                       text primary key
org_id                   text not null references orgs(id)
repo_id                  text null references repositories(id)
scope                    text not null           org | repo
fact_type                text not null           preference | suppression | architecture | convention | prior_decision | domain_knowledge
text                     text not null
status                   text not null default 'active'     active | expired | suppressed
confidence               numeric(4,3) not null default 0.8
evidence                 jsonb not null default '[]'
created_from_outcome_id  text null references finding_outcomes(id)
created_by_user_id       text null references users(id)
last_used_at             timestamptz null
expires_at               timestamptz null
created_at               timestamptz not null default now()
updated_at               timestamptz not null default now()
metadata                 jsonb not null default '{}'
```

Indexes:

```sql
create index memory_facts_repo_active_idx
on memory_facts (repo_id, status, confidence desc)
where status = 'active';

create index memory_facts_org_active_idx
on memory_facts (org_id, status, confidence desc)
where status = 'active';

create index memory_facts_expires_idx
on memory_facts (expires_at)
where expires_at is not null;
```

Notes:

```text
- Memory should be inspectable.
- Avoid hidden personalization that users cannot debug.
- Low-confidence memory should be retrieved but not used for suppression unless validated.
```

---

# 9. LLM and usage tables

## `llm_calls`

Tracks model calls for debugging, cost, and observability.

Columns:

```text
id                       text primary key
org_id                   text null references orgs(id)
repo_id                  text null references repositories(id)
review_run_id            text null references review_runs(id)
purpose                  text not null         summarize_file | review_correctness | judge_findings | embed_chunks | rerank_context
provider                 text not null
model                    text not null
model_version            text null
prompt_version           text null
status                   text not null         pending | running | succeeded | failed | cache_hit | canceled | timed_out | budget_exceeded
input_hash               text null
output_hash              text null
request_artifact_uri     text null
response_artifact_uri    text null
prompt_tokens            integer not null default 0
completion_tokens        integer not null default 0
total_tokens             integer not null default 0
cached_tokens            integer not null default 0
cost_usd_micros          bigint not null default 0
latency_ms               integer null
redaction_version        text null
started_at               timestamptz not null default now()
completed_at             timestamptz null
error_message            text null
metadata                 jsonb not null default '{}'
```

Indexes:

```sql
create index llm_calls_review_run_idx
on llm_calls (review_run_id, started_at desc);

create index llm_calls_org_started_idx
on llm_calls (org_id, started_at desc);

create index llm_calls_model_idx
on llm_calls (provider, model, started_at desc);

create index llm_calls_status_idx
on llm_calls (status, started_at desc);
```

Notes:

```text
- Store prompt/response artifacts only if logging policy allows.
- Always store hashes and usage/cost metadata.
- Redact secrets before artifact storage.
- Status values mirror the canonical LLMCallStatus contract from #0.
```

---

## `llm_call_artifacts`

Optional pointers from an LLM call to prompt, response, repair, or provider-debug artifacts.

Columns:

```text
id                       text primary key
llm_call_id              text not null references llm_calls(id)
review_run_id            text null references review_runs(id)
artifact_id              text not null references review_artifacts(id)
artifact_role            text not null        request | response | repair_attempt | provider_error | redaction_report
created_at               timestamptz not null default now()
```

Indexes:

```sql
create index llm_call_artifacts_call_idx
on llm_call_artifacts (llm_call_id, created_at);

create unique index llm_call_artifacts_unique_idx
on llm_call_artifacts (llm_call_id, artifact_id, artifact_role);
```

---

## `usage_events`

Append-only usage ledger.

Columns:

```text
id                    text primary key
org_id                text not null references orgs(id)
repo_id               text null references repositories(id)
review_run_id         text null references review_runs(id)
event_type            text not null       review_run | index_file | index_chunk | embedding_token | llm_token | storage_byte | comment_published
quantity              numeric(18,4) not null
unit                  text not null       count | token | byte | usd_micro | millisecond
cost_usd_micros       bigint not null default 0
occurred_at           timestamptz not null
metadata              jsonb not null default '{}'
created_at            timestamptz not null default now()
```

Indexes:

```sql
create index usage_events_org_occurred_idx
on usage_events (org_id, occurred_at desc);

create index usage_events_repo_occurred_idx
on usage_events (repo_id, occurred_at desc);

create index usage_events_type_idx
on usage_events (event_type, occurred_at desc);
```

Future rollups:

```text
usage_daily_rollups
usage_monthly_rollups
```

Do not implement rollups until the raw ledger exists.

---

# 10. Audit table

## `audit_logs`

Records sensitive/admin actions.

Columns:

```text
id                    text primary key
org_id                text null references orgs(id)
actor_user_id         text null references users(id)
actor_type            text not null       user | system | api_key | worker
action                text not null       repo.enabled | rule.created | review.rerun | etc.
resource_type         text null
resource_id           text null
ip_address            text null
user_agent            text null
metadata              jsonb not null default '{}'
occurred_at           timestamptz not null default now()
created_at            timestamptz not null default now()
```

Indexes:

```sql
create index audit_logs_org_occurred_idx
on audit_logs (org_id, occurred_at desc);

create index audit_logs_actor_idx
on audit_logs (actor_user_id, occurred_at desc);

create index audit_logs_resource_idx
on audit_logs (resource_type, resource_id, occurred_at desc);
```

---

# Drizzle schema examples

## ID typing helper

`src/schema/common.ts`:

```ts
import { text } from "drizzle-orm/pg-core";

export function idColumn<T extends string = string>(name = "id") {
  return text(name).$type<T>().primaryKey();
}

export function refColumn<T extends string = string>(name: string) {
  return text(name).$type<T>();
}
```

Usage:

```ts
import type { OrgId, RepoId } from "@repo/contracts";

id: idColumn<RepoId>(),
orgId: refColumn<OrgId>("org_id").notNull(),
```

---

## Repositories table example

```ts
import { relations, sql } from "drizzle-orm";
import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { OrgId, InstallationId, RepoId, GitProvider } from "@repo/contracts";
import { orgs } from "./identity";
import { providerInstallations } from "./installations";
import { createdAt, updatedAt, deletedAt, metadata, idColumn, refColumn } from "./common";

export const repositories = pgTable(
  "repositories",
  {
    id: idColumn<RepoId>(),
    orgId: refColumn<OrgId>("org_id").notNull().references(() => orgs.id),
    installationId: refColumn<InstallationId>("installation_id")
      .notNull()
      .references(() => providerInstallations.id),
    provider: text("provider").$type<GitProvider>().notNull(),
    providerRepoId: text("provider_repo_id").notNull(),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    fullName: text("full_name").notNull(),
    defaultBranch: text("default_branch"),
    visibility: text("visibility").notNull(),
    isPrivate: boolean("is_private").notNull().default(true),
    isFork: boolean("is_fork").notNull().default(false),
    isArchived: boolean("is_archived").notNull().default(false),
    isEnabled: boolean("is_enabled").notNull().default(false),
    status: text("status").notNull().default("active"),
    primaryLanguage: text("primary_language"),
    htmlUrl: text("html_url"),
    cloneUrl: text("clone_url"),
    providerCreatedAt: timestamp("provider_created_at", { withTimezone: true }),
    providerUpdatedAt: timestamp("provider_updated_at", { withTimezone: true }),
    providerPushedAt: timestamp("provider_pushed_at", { withTimezone: true }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    metadata,
    createdAt,
    updatedAt,
    deletedAt,
  },
  (table) => ({
    providerRepoUnique: uniqueIndex("repositories_provider_repo_unique_idx").on(
      table.provider,
      table.providerRepoId,
    ),
    orgEnabledIdx: index("repositories_org_enabled_idx").on(
      table.orgId,
      table.isEnabled,
      table.status,
    ),
    installationIdx: index("repositories_installation_idx").on(table.installationId),
  }),
);
```

---

## Code chunk table example

```ts
import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { ChunkId, FileId, OrgId, RepoId, SymbolId } from "@repo/contracts";
import { repoIndexVersions } from "./indexing";
import { indexedFiles } from "./indexing";
import { symbols } from "./indexing";
import { createdAt, metadata, idColumn, refColumn } from "./common";

export const codeChunks = pgTable(
  "code_chunks",
  {
    id: idColumn<ChunkId>(),
    indexVersionId: text("index_version_id").notNull().references(() => repoIndexVersions.id),
    orgId: refColumn<OrgId>("org_id").notNull(),
    repoId: refColumn<RepoId>("repo_id").notNull(),
    commitSha: text("commit_sha").notNull(),
    fileId: refColumn<FileId>("file_id").notNull().references(() => indexedFiles.id),
    symbolId: refColumn<SymbolId>("symbol_id").references(() => symbols.id),
    path: text("path").notNull(),
    chunkKind: text("chunk_kind").notNull().default("code"),
    startLine: integer("start_line").notNull(),
    endLine: integer("end_line").notNull(),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    contentTokens: integer("content_tokens"),
    language: text("language"),
    isTest: boolean("is_test").notNull().default(false),
    isGenerated: boolean("is_generated").notNull().default(false),
    metadata,
    createdAt,
  },
  (table) => ({
    indexPathRangeUnique: uniqueIndex("code_chunks_index_path_range_unique_idx").on(
      table.indexVersionId,
      table.path,
      table.startLine,
      table.endLine,
      table.contentHash,
    ),
    repoCommitPathIdx: index("code_chunks_repo_commit_path_idx").on(
      table.repoId,
      table.commitSha,
      table.path,
    ),
    contentHashIdx: index("code_chunks_content_hash_idx").on(table.contentHash),
  }),
);
```

---

## Vector table example

If your Drizzle version supports vector columns directly, use the native helper. Otherwise, define a custom type.

Conceptual schema:

```ts
import { index, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { codeChunks } from "./indexing";
import { createdAt, idColumn, refColumn } from "./common";

export const codeChunkEmbeddings = pgTable(
  "code_chunk_embeddings",
  {
    id: idColumn(),
    orgId: text("org_id").notNull(),
    repoId: text("repo_id").notNull(),
    indexVersionId: text("index_version_id").notNull(),
    chunkId: text("chunk_id").notNull().references(() => codeChunks.id),
    contentHash: text("content_hash").notNull(),
    embeddingModel: text("embedding_model").notNull(),
    embeddingDimension: integer("embedding_dimension").notNull().default(1536),
    // Use vector("embedding", { dimensions: 1536 }) if available.
    // Otherwise use a custom type and create indexes in raw SQL migrations.
    embedding: vector("embedding", { dimensions: 1536 }).notNull(),
    createdAt,
  },
  (table) => ({
    chunkModelUnique: uniqueIndex("code_chunk_embeddings_chunk_model_unique_idx").on(
      table.chunkId,
      table.embeddingModel,
    ),
    contentModelIdx: index("code_chunk_embeddings_content_model_idx").on(
      table.contentHash,
      table.embeddingModel,
    ),
  }),
);
```

Vector index migration:

```sql
create index if not exists code_chunk_embeddings_vector_hnsw_idx
on code_chunk_embeddings
using hnsw (embedding vector_cosine_ops);
```

Retrieval query shape:

```sql
select
  cc.id,
  cc.path,
  cc.start_line,
  cc.end_line,
  cc.content,
  cce.embedding <=> $1::vector as distance
from code_chunk_embeddings cce
join code_chunks cc on cc.id = cce.chunk_id
where cce.repo_id = $2
  and cce.index_version_id = $3
  and cce.embedding_model = $4
order by cce.embedding <=> $1::vector
limit $5;
```

---

# Query modules

Each domain should expose query functions. Other packages should not write arbitrary SQL unless there is a clear reason.

Recommended modules:

```text
src/queries/orgs.ts
src/queries/repositories.ts
src/queries/webhooks.ts
src/queries/pull-requests.ts
src/queries/indexes.ts
src/queries/chunks.ts
src/queries/embeddings.ts
src/queries/review-runs.ts
src/queries/findings.ts
src/queries/memory.ts
src/queries/llm.ts
src/queries/usage.ts
src/queries/jobs.ts
```

## Repository queries

```ts
export async function upsertRepositoryFromProvider(input: UpsertRepositoryInput): Promise<Repository>;

export async function listEnabledRepositories(input: {
  orgId: OrgId;
  limit: number;
  cursor?: string;
}): Promise<PaginatedResult<Repository>>;

export async function getRepositoryById(repoId: RepoId): Promise<Repository | null>;

export async function getRepositoryByProviderId(input: {
  provider: GitProvider;
  providerRepoId: string;
}): Promise<Repository | null>;

export async function updateRepositorySettings(input: {
  repoId: RepoId;
  patch: RepositorySettingsPatch;
}): Promise<RepositorySettings>;
```

---

## Webhook queries

```ts
export async function insertWebhookEvent(input: NormalizedWebhookEvent): Promise<{
  event: WebhookEventRow;
  inserted: boolean;
}>;

export async function markWebhookQueued(eventId: string): Promise<void>;

export async function markWebhookProcessed(eventId: string): Promise<void>;

export async function markWebhookFailed(input: {
  eventId: string;
  errorMessage: string;
}): Promise<void>;
```

The insert should use `on conflict do nothing` on `(provider, delivery_id)`.

---

## Index queries

```ts
export async function findReadyIndexVersion(input: {
  repoId: RepoId;
  commitSha: string;
  indexKey: string;
}): Promise<CodeIndexVersion | null>;

export async function createIndexVersion(input: CreateIndexVersionInput): Promise<CodeIndexVersion>;

export async function markIndexImporting(indexVersionId: IndexVersionId): Promise<void>;

export async function markIndexReady(input: {
  indexVersionId: IndexVersionId;
  counts: IndexCounts;
}): Promise<void>;

export async function markIndexFailed(input: {
  indexVersionId: IndexVersionId;
  errorMessage: string;
}): Promise<void>;

export async function getLatestReadyIndexForCommit(input: {
  repoId: RepoId;
  commitSha: string;
}): Promise<CodeIndexVersion | null>;
```

Important:

```text
createIndexVersion should be idempotent by (repo_id, commit_sha, index_key).
```

---

## Code intelligence queries

```ts
export async function findSymbolAtLine(input: {
  repoId: RepoId;
  commitSha: string;
  path: string;
  line: number;
}): Promise<SymbolRecord | null>;

export async function listSymbolsForFile(input: {
  indexVersionId: IndexVersionId;
  path: string;
}): Promise<SymbolRecord[]>;

export async function listChunksForFile(input: {
  indexVersionId: IndexVersionId;
  path: string;
}): Promise<CodeChunk[]>;

export async function listEdgesFromSymbol(input: {
  symbolId: SymbolId;
  kinds?: CodeEdgeKind[];
}): Promise<CodeEdge[]>;

export async function listEdgesToSymbol(input: {
  symbolId: SymbolId;
  kinds?: CodeEdgeKind[];
}): Promise<CodeEdge[]>;
```

---

## Embedding queries

```ts
export async function listChunksNeedingEmbeddings(input: {
  indexVersionId: IndexVersionId;
  embeddingModel: string;
  limit: number;
}): Promise<CodeChunk[]>;

export async function insertChunkEmbeddings(input: {
  embeddingModel: string;
  embeddings: Array<{
    chunkId: ChunkId;
    contentHash: string;
    vector: number[];
  }>;
}): Promise<void>;

export async function vectorSearchChunks(input: {
  repoId: RepoId;
  indexVersionId: IndexVersionId;
  embeddingModel: string;
  queryVector: number[];
  limit: number;
  filters?: {
    pathPrefix?: string;
    language?: string;
    includeTests?: boolean;
  };
}): Promise<Array<CodeChunk & { distance: number }>>;
```

---

## Review run queries

```ts
export async function createReviewRun(input: CreateReviewRunInput): Promise<{
  reviewRun: ReviewRun;
  inserted: boolean;
}>;

export async function markReviewRunning(reviewRunId: ReviewRunId): Promise<void>;

export async function attachReviewIndexes(input: {
  reviewRunId: ReviewRunId;
  baseIndexVersionId?: IndexVersionId;
  headIndexVersionId?: IndexVersionId;
}): Promise<void>;

export async function completeReviewRun(input: {
  reviewRunId: ReviewRunId;
  summary?: string;
  counts: ReviewCounts;
  latencyMs: number;
  costUsdMicros: number;
}): Promise<void>;

export async function failReviewRun(input: {
  reviewRunId: ReviewRunId;
  errorMessage: string;
}): Promise<void>;

export async function listReviewRunsForRepo(input: {
  repoId: RepoId;
  limit: number;
  cursor?: string;
}): Promise<PaginatedResult<ReviewRun>>;
```

---

## Finding queries

```ts
export async function insertCandidateFindings(input: {
  reviewRunId: ReviewRunId;
  findings: CandidateFinding[];
}): Promise<void>;

export async function updateFindingValidation(input: {
  findingId: FindingId;
  validationStatus: "accepted" | "rejected";
  rejectionReason?: string;
  validationNotes?: string;
}): Promise<void>;

export async function listAcceptedFindings(reviewRunId: ReviewRunId): Promise<CandidateFinding[]>;

export async function insertPublishedFinding(input: PublishedFindingInput): Promise<PublishedFinding>;

export async function getPublishedFindingByProviderComment(input: {
  provider: GitProvider;
  providerCommentId: string;
}): Promise<PublishedFinding | null>;

export async function insertFindingOutcome(input: FindingOutcomeInput): Promise<FindingOutcome>;
```

---

# Transaction boundaries

## General rules

Use transactions for:

```text
- creating org + installation + initial repos
- inserting webhook event + background job record
- creating review run + snapshot reference
- importing a batch of index records
- inserting candidates + updating review run counts
- publishing finding record + updating review run count
```

Avoid long transactions for:

```text
- entire large repo index import
- embedding thousands of chunks
- full review orchestration
- external API calls
- model calls
```

Never hold a DB transaction while calling:

```text
GitHub
OpenAI/Anthropic/etc.
embedding provider
object storage
indexer CLI
```

---

## Transaction helper

`src/transaction.ts`:

```ts
import type { DbClient } from "./client";

export async function withTransaction<T>(
  db: DbClient,
  fn: (tx: Parameters<DbClient["transaction"]>[0]) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    return fn(tx);
  });
}
```

Services should accept a DB-like object when possible:

```ts
async function createReviewRun(db: DbLike, input: CreateReviewRunInput) {
  // works with db or tx
}
```

---

# Advisory locks

Use Postgres advisory locks to prevent duplicate expensive work.

Examples:

```text
index repo@commit
review pr@head_sha
publish review_run
```

`src/locks.ts`:

```ts
import { sql } from "drizzle-orm";
import type { DbClient } from "./client";

export async function withAdvisoryTransactionLock<T>(
  db: DbClient,
  lockKey: string,
  fn: () => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);
    return fn();
  });
}
```

Example keys:

```text
index:repo_123:abc123:index_key
review:repo_123:42:head_sha:settings_hash:prompt_version
publish:rrn_123
```

Notes:

```text
- Advisory locks are not a replacement for unique constraints.
- Use both locks and unique constraints for expensive idempotent work.
```

---

# Importer strategy

The index importer should be efficient and safe.

Flow:

```text
1. create or reuse repo_index_versions row with status='importing'
2. read artifact manifest
3. validate schema version
4. stream records.jsonl
5. batch insert files
6. batch insert symbols
7. batch insert edges
8. batch insert chunks
9. update counts
10. mark status='embedding' or 'ready'
11. enqueue embedding jobs for chunks missing embeddings
```

Important:

```text
- Do not make imported rows visible as ready until all required rows are imported.
- If import fails, mark index version failed.
- Keep failed rows for debugging, or clean them up with a maintenance job.
```

Batch sizes:

```text
files:      1,000 rows
symbols:    1,000-5,000 rows
edges:      5,000-10,000 rows
chunks:       500-2,000 rows depending on content size
```

Use raw SQL for large batch inserts if Drizzle becomes slow. Keep the query module interface unchanged.

---

# Review data flow through DB

A PR review should create/update rows in this order:

```text
webhook_events
  -> background_jobs
  -> pull_requests
  -> pull_request_snapshots
  -> review_runs
  -> review_run_stage_events / review_run_dependencies
  -> repo_index_versions
  -> review_artifacts(context/prompt/responses/publish plan)
  -> candidate_findings
  -> publish_runs / published_reviews
  -> published_findings
  -> published_summary_comments / published_check_runs / publish_operations
  -> finding_outcomes later
  -> usage_events / llm_calls / llm_call_artifacts throughout
```

A useful review-run detail page should be queryable from:

```text
review_runs
  join repositories
  join pull_requests
  left join review_artifacts
  left join candidate_findings
  left join publish_runs
  left join published_findings
  left join published_summary_comments
  left join published_check_runs
  left join llm_calls
```

---

# State machines

## Index version status

```text
queued
  -> running
  -> importing
  -> embedding
  -> ready

queued/running/importing/embedding
  -> failed

ready
  -> superseded
```

Rules:

```text
- Retrieval only uses ready.
- Failed versions are not retried by mutating the same row unless the index_key is identical and retry semantics are clear.
- It is acceptable to create a new index version for a new index_key.
```

---

## Review run status

```text
created
  -> snapshotting
  -> waiting_for_index
  -> waiting_for_embeddings
  -> retrieving_context
  -> reviewing
  -> validating_findings
  -> publish_queued
  -> completed

any non-terminal state
  -> skipped
  -> superseded
  -> canceled
  -> failed
```

Rules:

```text
- A skipped review run should store skip_reason.
- A failed review run should store error_message and relevant artifacts if available.
- A completed review may publish zero comments.
```

---

## Candidate finding validation status

```text
pending
  -> accepted
  -> rejected
```

Common rejection reasons:

```text
line_not_in_diff
missing_evidence
low_confidence
duplicate_exact
style_only
suppressed_by_repo_rule
suppressed_by_memory
not_actionable
line_anchor_unavailable
wrong_diff_side
```

---

## Published finding status

```text
published
  -> outdated
  -> deleted
  -> failed
```

---

# Performance considerations

## Hot tables

Likely high-volume tables:

```text
webhook_events
repo_index_versions
indexed_files
symbols
code_edges
code_chunks
code_chunk_embeddings
review_runs
review_run_stage_events
review_run_dependencies
candidate_findings
publish_runs
published_findings
llm_calls
llm_call_artifacts
usage_events
```

Early MVP can keep them unpartitioned.

Add partitioning later for:

```text
webhook_events by received_at month
llm_calls by started_at month
usage_events by occurred_at month
candidate_findings by created_at month if very high volume
```

Do not partition prematurely.

---

## Index import performance

Potential bottlenecks:

```text
- inserting millions of edges
- inserting large chunk content
- embedding writes
- vector index updates
```

Mitigations:

```text
- batch inserts
- skip generated/vendor files
- cap indexed file size
- reuse content hashes
- insert embeddings after chunk import
- use COPY/raw SQL if Drizzle insert overhead becomes large
- mark index ready only after import and embedding requirements are met
```

---

## Vector search performance

MVP vector query:

```text
filter by repo_id + index_version_id + embedding_model
order by distance
limit k
```

Potential issue:

```text
HNSW index searches globally, then filters. For very large multi-tenant datasets, this can degrade.
```

Near-term mitigations:

```text
- keep indexes per active code chunk set small enough
- use repo_id and index_version_id filters
- increase ef_search if needed
- keep only active/recent embeddings in hot table
```

Scale-up options:

```text
- move vectors to Qdrant
- partition embeddings by org or embedding model
- use separate embedding tables per dimension/model
- materialize active index chunks
```

Do not start with those unless measurements justify it.

---

# Security and privacy

## Secrets

Do not store:

```text
- GitHub installation access tokens
- model provider API keys in plain text
- user OAuth access tokens in plain text
```

If you must store secrets:

```text
- encrypt with KMS or a secrets manager
- store encrypted value separately
- track key version
- avoid JSONB blobs for secrets
```

Suggested future table:

```text
encrypted_secrets
  id
  org_id
  kind
  ciphertext
  key_version
  created_at
  rotated_at
```

Not needed for MVP if using environment-managed provider keys and on-demand GitHub installation tokens.

---

## Prompt and code logging

Review artifacts may include customer code.

Implement controls:

```text
- org setting: store_prompt_artifacts true/false
- org setting: artifact_retention_days
- redact secrets before artifact storage
- store hashes even when content storage is disabled
```

Tables should support artifact references without requiring inline content.

---

## Tenant isolation

MVP:

```text
- every app query scopes by org_id/repo_id
- access checks in API service
- no RLS initially
```

Future enterprise:

```text
- optional Row Level Security
- per-org encryption keys
- per-org artifact buckets/prefixes
- bring-your-own-storage
```

---

# Data retention

Recommended defaults:

```text
webhook_events.payload:          30-90 days
review_artifacts:                90 days or org-configurable
llm prompt/response artifacts:    30-90 days or disabled
review_runs/findings metadata:    keep indefinitely unless org deleted
code index rows:                 keep recent commits + active PR heads
embeddings:                      keep while index version retained
usage_events:                    keep indefinitely for billing/audit
```

Cleanup jobs:

```text
cleanup.old_webhook_payloads
cleanup.old_review_artifacts
cleanup.old_index_versions
cleanup.expired_idempotency_records
cleanup.deleted_org_data
```

Do not build complex cleanup first, but design with `created_at`, `expires_at`, and artifact URIs so cleanup is easy.

---

# Backup and recovery

Minimum production requirements:

```text
- managed Postgres with point-in-time recovery
- daily snapshots
- tested restore process
- migration rollback plan
- object storage versioning or retention policy for artifacts
```

Important:

```text
Postgres backups alone are not enough if artifacts live in object storage.
```

For a full restore, you need:

```text
Postgres snapshot + object storage artifacts + secrets/config
```

---

# Local development setup

From #1, local Compose should include Postgres and Redis.

`compose.yaml` database service:

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: code_review_agent
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d code_review_agent"]
      interval: 5s
      timeout: 5s
      retries: 10

volumes:
  postgres_data:
```

Local env:

```text
DATABASE_URL=postgres://postgres:postgres@localhost:5432/code_review_agent
```

Reset command:

```bash
docker compose down -v
docker compose up -d postgres
pnpm --filter @repo/db db:migrate
```

---

# Testing strategy

## Schema tests

Tests should verify:

```text
- migrations apply from empty DB
- all expected tables exist
- required extensions exist
- key indexes exist
- updated_at trigger works where configured
```

---

## Query tests

Use a real Postgres test DB, not SQLite.

Test scenarios:

```text
- create org/user/membership
- upsert installation twice idempotently
- upsert repository twice idempotently
- insert webhook event twice and detect duplicate
- create index version idempotently
- import simple index artifact
- find symbol at line
- insert chunks and embeddings
- vector search returns expected chunk
- create review run idempotently
- insert candidate findings and dedupe
- publish finding once only
- insert finding outcomes
```

---

## Fixture data

Create fixtures in:

```text
/packages/db/src/test/fixtures.ts
```

Suggested fixture builders:

```ts
createOrgFixture()
createUserFixture()
createInstallationFixture()
createRepositoryFixture()
createPullRequestFixture()
createIndexVersionFixture()
createCodeChunkFixture()
createReviewRunFixture()
createCandidateFindingFixture()
```

Builders should generate valid prefixed IDs from `@repo/contracts`.

---

# Implementation order

## Step 1: Package skeleton

Create:

```text
/packages/db/package.json
/packages/db/tsconfig.json
/packages/db/drizzle.config.ts
/packages/db/src/index.ts
/packages/db/src/client.ts
/packages/db/src/schema/index.ts
/packages/db/src/migrate.ts
```

Add root scripts:

```json
{
  "scripts": {
    "db:generate": "pnpm --filter @repo/db db:generate",
    "db:migrate": "pnpm --filter @repo/db db:migrate",
    "db:studio": "pnpm --filter @repo/db db:studio"
  }
}
```

---

## Step 2: Extensions migration

Create initial migration:

```sql
create extension if not exists vector;
create extension if not exists pgcrypto;
```

Add `set_updated_at()` trigger function.

---

## Step 3: Identity and repository schema

Implement:

```text
orgs
users
org_memberships
user_provider_accounts
provider_installations
repositories
repository_settings
```

Add basic query helpers.

---

## Step 4: Webhook and job schema

Implement:

```text
webhook_events
idempotency_records
background_jobs
```

Add webhook idempotency tests.

---

## Step 5: Pull request schema

Implement:

```text
pull_requests
pull_request_snapshots
```

Add upsert and snapshot creation helpers.

---

## Step 6: Index schema

Implement:

```text
repo_index_versions
indexed_files
symbols
code_edges
code_chunks
```

Add importer-oriented query helpers.

---

## Step 7: Embedding schema

Implement:

```text
code_chunk_embeddings
```

Add vector index migration manually if Drizzle does not generate it cleanly.

Add a vector search smoke test.

---

## Step 8: Review and finding schema

Implement:

```text
review_runs
review_run_stage_events
review_run_dependencies
review_artifacts
candidate_findings
publish_runs
published_reviews
published_findings
published_summary_comments
published_check_runs
publish_operations
finding_outcomes
```

Add idempotent review-run and publish tests.

---

## Step 9: Memory, LLM, usage, audit schema

Implement:

```text
repo_rules
memory_facts
llm_calls
llm_call_artifacts
usage_events
audit_logs
```

Add basic insertion/listing tests.

---

## Step 10: Mappers to contracts

For every query module, return contract-shaped objects.

Example:

```ts
export function mapRepositoryRow(row: RepositoryRow): Repository {
  return RepositorySchema.parse({
    repoId: row.id,
    orgId: row.orgId,
    installationId: row.installationId,
    provider: row.provider,
    providerRepoId: row.providerRepoId,
    owner: row.owner,
    name: row.name,
    fullName: row.fullName,
    defaultBranch: row.defaultBranch,
    isPrivate: row.isPrivate,
    isEnabled: row.isEnabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}
```

The DB layer can have row types, but cross-package returns should match `@repo/contracts`.

---

# Minimal MVP schema cut

If you want the smallest useful version, implement only:

```text
orgs
users
org_memberships
provider_installations
repositories
repository_settings
webhook_events
background_jobs
pull_requests
pull_request_snapshots
repo_index_versions
indexed_files
symbols
code_edges
code_chunks
code_chunk_embeddings
review_runs
review_run_stage_events
review_run_dependencies
review_artifacts
candidate_findings
publish_runs
published_reviews
published_findings
published_summary_comments
published_check_runs
publish_operations
finding_outcomes
llm_calls
llm_call_artifacts
usage_events
```

Can defer:

```text
user_provider_accounts
idempotency_records
index_import_batches
embedding_jobs
repo_rules
memory_facts
audit_logs
```

However, adding `repo_rules`, `memory_facts`, and `audit_logs` early is low effort and helps product debugging.

---

# Definition of done

#2 is complete when:

```text
- @repo/db package exists and builds
- Drizzle config works
- local Postgres with pgvector works
- migrations apply from empty database
- all MVP tables exist
- all major unique constraints and indexes exist
- database client exports db/sql handles
- core query modules are implemented
- repository, webhook, index, review, and finding operations are idempotent
- vector search smoke test passes
- migration tests pass in CI
- query tests run against real Postgres
- DB rows map to @repo/contracts objects
- no service imports raw schema tables unless intended
```

---

# Practical implementation checklist

```text
[ ] Create /packages/db
[ ] Add Drizzle, postgres.js, drizzle-kit
[ ] Add drizzle.config.ts
[ ] Add createDb() and migration runner
[ ] Add extension migration for pgvector and pgcrypto
[ ] Add common column helpers
[ ] Add identity schema
[ ] Add provider installation schema
[ ] Add repository schema/settings
[ ] Add webhook_events
[ ] Add background_jobs
[ ] Add pull_requests and pull_request_snapshots
[ ] Add repo_index_versions
[ ] Add indexed_files
[ ] Add symbols
[ ] Add code_edges
[ ] Add code_chunks
[ ] Add code_chunk_embeddings and vector index
[ ] Add review_runs
[ ] Add review_run_stage_events and review_run_dependencies
[ ] Add review_artifacts
[ ] Add candidate_findings
[ ] Add publish_runs and published_reviews
[ ] Add published_findings
[ ] Add published_summary_comments, published_check_runs, and publish_operations
[ ] Add finding_outcomes
[ ] Add repo_rules and memory_facts
[ ] Add llm_calls
[ ] Add llm_call_artifacts
[ ] Add usage_events
[ ] Add audit_logs
[ ] Add query modules
[ ] Add mapper modules to @repo/contracts
[ ] Add migration test
[ ] Add idempotency tests
[ ] Add vector search smoke test
[ ] Add CI database test job
```

---

# Recommended first PR for #2

The first implementation PR should not try to build every query module.

First PR scope:

```text
- /packages/db package setup
- DB client
- migration runner
- extensions migration
- common helpers
- identity tables
- installation/repository/settings tables
- webhook_events
- background_jobs
- basic tests
```

Second PR:

```text
- pull request tables
- index tables
- embedding table
- vector search smoke test
```

Third PR:

```text
- review/finding tables
- llm_calls
- usage_events
- query helpers
```

Fourth PR:

```text
- memory/rules/audit tables
- full mapper layer
- integration tests
```

This keeps the database layer reviewable while still moving quickly.

---

# Final database mental model

The clean database model is:

```text
Org/Installation/Repo
  -> PR Snapshot
  -> Review Run
  -> Index Versions
  -> Retrieved Context Artifacts
  -> Candidate Findings
  -> Published Findings
  -> Outcomes/Memory
  -> Usage/LLM/Audit
```

The database should make the whole product explainable:

```text
What happened?
Why did it happen?
Which code was used?
Which model was called?
Which comments were published?
How did humans respond?
What did it cost?
```

If the database can answer those questions, the rest of the system becomes much easier to reason about.
