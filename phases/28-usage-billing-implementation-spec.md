# #28 Usage and Billing Implementation Spec

Status: draft implementation spec  
Owner: product/platform  
Primary packages: `/packages/usage`, `/packages/billing`, `/packages/entitlements`  
Primary apps: `/apps/api`, `/apps/worker`, `/apps/web`  
Depends on: #0 contracts, #2 database, #5 API server, #7 queue, #16 review orchestrator, #17 LLM gateway, #25 observability, #27 security/compliance

---

## 1. Purpose

This document defines the usage and billing system for the code-review agent.

The goal is to make product usage, internal cost, quotas, entitlements, and customer billing explicit and durable from the beginning, while avoiding premature monetization complexity.

The system should support three stages:

```text
Stage 1: Internal usage ledger
  Track product usage and cost accurately before charging anyone.

Stage 2: Plan and entitlement enforcement
  Gate features, quotas, and limits based on org plan.

Stage 3: Billing provider integration
  Use Stripe for subscriptions, checkout, customer portal, invoices, and metered usage.
```

The main recommendation:

```text
Build usage tracking as a first-class internal ledger.
Treat Stripe as an adapter, not the source of product truth.
```

The product should be able to answer:

```text
What did this org use?
What did it cost us?
Which repo/user/job/model caused that cost?
Which usage is billable?
Which usage is included?
Which usage exceeded quota?
Which features should this org have access to?
What should we send to Stripe?
What did Stripe bill?
Can we explain a customer invoice?
```

---

## 2. Design principles

### 2.1 Usage is an immutable ledger

Usage events should be append-only.

Do not update old usage events to “fix” them. If correction is needed, create a correcting event.

```text
usage_event: review_completed +1
usage_event: correction -1 with reason duplicate_review
```

This keeps invoice debugging and customer disputes possible.

---

### 2.2 Internal usage is more granular than billable usage

Track many internal dimensions:

```text
review requested
review completed
review skipped
index completed
files indexed
chunks embedded
LLM input tokens
LLM cached input tokens
LLM output tokens
sandbox CPU milliseconds
static analysis seconds
storage bytes
published findings
```

But bill only simple customer-understandable units:

```text
seats
active repositories
PR reviews
review credits
AI overage credits
enterprise flat fee
```

Do not expose model token details as the primary customer pricing unit unless the product explicitly chooses token pass-through billing.

---

### 2.3 Billing provider is not product state

Stripe knows about:

```text
customers
subscriptions
prices
invoices
payment status
meter events
portal sessions
checkout sessions
```

The app knows about:

```text
orgs
users
repos
review runs
entitlements
quotas
usage events
feature access
internal costs
```

Stripe state should be synchronized into internal tables, but product code should not call Stripe every time it needs to decide whether a review can run.

---

### 2.4 Every billing-affecting decision must be explainable

For each review, we should be able to reconstruct:

```text
review_run_id
org_id
repo_id
policy snapshot
plan snapshot
quota decision
usage emitted
billable meter events planned
billable meter events sent
provider request ids
invoice period affected
```

This is critical for support and enterprise trust.

---

### 2.5 Costs and revenue are separate ledgers

Track internal costs independently from what the customer is charged.

```text
Cost examples:
  LLM provider cost
  embedding provider cost
  sandbox compute cost
  storage cost
  GitHub API cost, if any

Revenue examples:
  monthly seat subscription
  PR review overage
  review credits
  enterprise contract
```

A review may cost $0.28 internally but consume 1 customer review credit. Store both.

---

### 2.6 Do not hardcode provider pricing

Model and infrastructure prices change.

Use versioned rate cards:

```text
provider: openai
model: gpt-x
input_token_usd_per_1m: ...
output_token_usd_per_1m: ...
effective_from: ...
effective_to: ...
source: manual | provider_api | imported_invoice
```

At call time, store:

```text
provider
model
usage counts
rate_card_version_id
estimated_cost_usd
```

This makes historical cost estimates reproducible.

---

### 2.7 Avoid customer surprise

Default enforcement should be conservative:

```text
- show usage clearly
- warn before limits
- grace period for payment issues
- do not silently create large overages
- enterprise override support
- manual admin controls
```

For early product stages, prefer soft limits and notifications over hard shutdowns.

---

## 3. Scope

### In scope

```text
- internal usage ledger
- usage event APIs
- idempotent usage recording
- usage rollups
- internal cost tracking
- plan and price catalog
- entitlements
- quota enforcement
- billing account model
- Stripe customer/subscription integration
- Stripe Checkout integration
- Stripe Customer Portal integration
- Stripe webhook processing
- Stripe metered usage sync
- invoice and payment state sync
- dashboard usage views
- admin billing views
- testing/fake billing provider
```

### Out of scope for MVP

```text
- multi-currency invoices controlled by us
- tax calculation owned by us
- revenue recognition accounting system
- reseller/channel billing
- marketplace billing
- GitHub Marketplace billing
- custom procurement workflow
- public pricing page CMS
- enterprise contract lifecycle management
- automatic refunds/credits beyond simple manual credits
```

---

## 4. High-level architecture

```text
Product services
  |
  | emit usage
  v
/packages/usage
  |
  | append immutable usage_events
  v
Postgres usage ledger
  |
  +--> usage rollup workers
  |       |
  |       v
  |    hourly/daily/monthly usage summaries
  |
  +--> cost calculation workers
  |       |
  |       v
  |    internal cost summaries
  |
  +--> quota/entitlement service
  |       |
  |       v
  |    allow / warn / deny decisions
  |
  +--> billing sync workers
          |
          v
/packages/billing
          |
          v
Stripe adapter
          |
          v
Stripe customers / subscriptions / meters / invoices
```

Key boundary:

```text
All packages can emit usage.
Only /packages/usage writes the usage ledger.
Only /packages/billing talks to Stripe.
Only /packages/entitlements decides feature access.
```

---

## 5. Package layout

```text
/packages
  /usage
    src/
      index.ts
      emit.ts
      usage-event.ts
      usage-types.ts
      rollups.ts
      cost-estimator.ts
      cost-rate-card.ts
      quota-counters.ts
      repositories/
      workers/
      test/

  /billing
    src/
      index.ts
      billing-provider.ts
      stripe/
        stripe-client.ts
        stripe-config.ts
        stripe-customer.ts
        stripe-checkout.ts
        stripe-portal.ts
        stripe-subscription.ts
        stripe-meter-events.ts
        stripe-webhooks.ts
        stripe-reconciliation.ts
      plans.ts
      invoices.ts
      credits.ts
      repositories/
      test/

  /entitlements
    src/
      index.ts
      entitlement-service.ts
      quota-service.ts
      plan-snapshot.ts
      feature-gates.ts
      repositories/
      test/

/apps
  /api
    src/routes/billing.ts
    src/routes/usage.ts
    src/routes/entitlements.ts
    src/routes/webhooks/stripe.ts

  /worker
    src/jobs/usage-rollup.ts
    src/jobs/cost-rollup.ts
    src/jobs/billing-sync.ts
    src/jobs/stripe-meter-sync.ts
    src/jobs/stripe-reconcile.ts
    src/jobs/quota-recalculate.ts

  /web
    src/routes/billing/*
    src/routes/usage/*
```

---

## 6. Usage taxonomy

### 6.1 Usage event categories

Usage events should have a stable category and type.

```ts
export type UsageCategory =
  | "review"
  | "indexing"
  | "embedding"
  | "llm"
  | "retrieval"
  | "static_analysis"
  | "sandbox"
  | "storage"
  | "publishing"
  | "user"
  | "billing"
  | "correction";
```

### 6.2 Usage event types

Initial event types:

```ts
export type UsageEventType =
  // Review lifecycle
  | "review_requested"
  | "review_started"
  | "review_completed"
  | "review_skipped"
  | "review_failed"
  | "review_cancelled"

  // Review outputs
  | "finding_candidate_generated"
  | "finding_validated"
  | "finding_published"
  | "summary_published"

  // Indexing
  | "index_requested"
  | "index_completed"
  | "indexed_file"
  | "indexed_loc"
  | "indexed_chunk"
  | "indexed_symbol"

  // Embeddings
  | "embedding_requested"
  | "embedding_completed"
  | "embedding_input_token"
  | "embedding_vector_stored"

  // LLM
  | "llm_call_completed"
  | "llm_input_token"
  | "llm_cached_input_token"
  | "llm_output_token"
  | "llm_reasoning_token"

  // Retrieval
  | "context_bundle_created"
  | "context_item_selected"

  // Static analysis / sandbox
  | "static_analysis_run_completed"
  | "sandbox_run_completed"
  | "sandbox_cpu_ms"
  | "sandbox_wall_ms"

  // Storage
  | "artifact_stored"
  | "storage_bytes_snapshot"

  // Seats/users/repos
  | "seat_active_snapshot"
  | "repo_active_snapshot"

  // Billing
  | "billable_review_credit"
  | "billable_pr_review"
  | "billable_seat_month"
  | "billable_repo_month"

  // Corrections
  | "usage_correction";
```

### 6.3 Usage units

```ts
export type UsageUnit =
  | "count"
  | "token"
  | "line"
  | "file"
  | "chunk"
  | "symbol"
  | "byte"
  | "millisecond"
  | "second"
  | "credit"
  | "seat"
  | "repo"
  | "usd_micro";
```

Use integer quantities only.

For money-like internal calculations, store micro-units:

```text
1 USD = 1,000,000 usd_micro
```

This avoids floating point errors.

---

## 7. Product usage dimensions

### 7.1 Review usage

Track:

```text
review_requested
review_completed
review_skipped
review_failed
review_cancelled
review_mode
review_trigger
changed_files_count
changed_lines_added
changed_lines_deleted
candidate_findings_count
published_findings_count
summary_published
review_latency_ms
```

Recommended billable unit:

```text
1 completed PR review = 1 billable review unit
```

Do not bill skipped reviews.

For failed reviews:

```text
Do not bill if failure is system-side.
Do not bill if review was superseded before publishing.
Optionally bill if review completed but publishing failed due to GitHub permissions, but default should be no.
```

### 7.2 Indexing usage

Track:

```text
index_requested
index_completed
files_seen
files_indexed
files_skipped
lines_indexed
bytes_indexed
symbols_extracted
chunks_created
index_duration_ms
indexer_version
schema_version
```

Usually not directly billable in early plans.

It is important for:

```text
- cost analytics
- abuse prevention
- enterprise sizing
- per-repo performance monitoring
```

### 7.3 Embedding usage

Track:

```text
embedding_model
embedding_provider
input_tokens
chunks_embedded
vectors_stored
dimensions
batch_count
cached_chunks
new_chunks
estimated_cost_usd_micro
```

Usually not directly billable.

It contributes to:

```text
internal cost
review credit cost model
enterprise usage reports
```

### 7.4 LLM usage

Track every LLM call through #17 LLM Gateway:

```text
llm_call_id
task
provider
model
model_profile
prompt_version
input_tokens
cached_input_tokens
output_tokens
reasoning_tokens if available
request_latency_ms
estimated_cost_usd_micro
cache_hit
fallback_used
```

Never rely only on monthly provider invoices to understand product cost. Provider invoices are reconciliation data, not product attribution.

### 7.5 Static analysis and sandbox usage

Track:

```text
tool_name
tool_version
run_mode
workspace_trust_level
wall_ms
cpu_ms
memory_peak_bytes
stdout_bytes
stderr_bytes
artifact_bytes
exit_code
timeout
```

This supports:

```text
- cost attribution
- timeout tuning
- abuse detection
- enterprise auditability
```

### 7.6 Storage usage

Track storage using scheduled snapshots, not per-byte event spam.

```text
storage_bytes_snapshot
  raw_diffs
  index_artifacts
  context_bundles
  prompt_artifacts
  review_artifacts
  logs
  object_store_total
```

Use daily snapshots per org/repo.

---

## 8. Recommended pricing model

This is not final pricing; this is the implementation-friendly packaging model.

### 8.1 Recommended initial packaging

```text
Free / Developer
  - limited private repos
  - limited PR reviews per month
  - summary-only or low max comments
  - community support

Team
  - per-seat or base subscription
  - included monthly PR reviews
  - overage via review credits
  - standard models
  - repo settings and rules

Business
  - more included reviews
  - higher limits
  - team memory
  - static analysis integrations
  - priority queue
  - admin/audit views

Enterprise
  - custom pricing
  - SSO/SAML
  - self-hosted/VPC/BYOK options
  - custom data retention
  - custom limits
  - dedicated support
```

### 8.2 Why not token billing first?

Raw token billing is technically accurate but poor product UX.

Problems:

```text
- customers cannot predict token usage easily
- model changes change costs invisibly
- context retrieval quality affects customer bills
- prompt changes affect customer bills
- cached-token behavior is provider-specific
- customers compare PR review value, not token volume
```

Recommended:

```text
Track tokens internally.
Bill review credits externally.
```

### 8.3 Normalized review credits

A review credit should be deterministic and explainable.

Option A: simple

```text
1 completed PR review = 1 review credit
```

Option B: size-adjusted

```text
small PR:   1 credit
medium PR:  2 credits
large PR:   4 credits
huge PR:    require explicit confirmation or skip
```

Recommended MVP:

```text
Use Option A for customer billing.
Use size-adjusted internal scoring for cost limits and abuse prevention.
```

### 8.4 Billable meter candidates

Possible Stripe meters:

```text
pr_reviews
review_credits
active_seats
active_repositories
ai_overage_credits
```

Recommended early meters:

```text
review_credits
```

Keep seats as subscription quantity if pricing is seat-based.

---

## 9. Data model

This section describes the main tables. Exact Drizzle definitions should live in `/packages/db`.

### 9.1 `usage_events`

Immutable usage ledger.

```sql
create table usage_events (
  id text primary key,
  org_id text not null references orgs(id),
  repo_id text references repositories(id),
  user_id text references users(id),

  category text not null,
  type text not null,
  unit text not null,
  quantity bigint not null,

  occurred_at timestamptz not null,
  recorded_at timestamptz not null default now(),

  source_service text not null,
  source_id text,
  idempotency_key text not null,

  review_run_id text references review_runs(id),
  repo_index_version_id text references repo_index_versions(id),
  llm_call_id text references llm_calls(id),
  sandbox_run_id text,

  attributes jsonb not null default '{}',

  is_billable_candidate boolean not null default false,
  billable_meter_key text,

  correction_of_usage_event_id text references usage_events(id),
  correction_reason text,

  created_at timestamptz not null default now(),

  unique (org_id, idempotency_key)
);

create index usage_events_org_time_idx
  on usage_events (org_id, occurred_at desc);

create index usage_events_type_time_idx
  on usage_events (type, occurred_at desc);

create index usage_events_review_run_idx
  on usage_events (review_run_id);

create index usage_events_billable_idx
  on usage_events (org_id, billable_meter_key, occurred_at)
  where is_billable_candidate = true;
```

Rules:

```text
- quantity can be negative only for corrections.
- occurred_at is when usage happened.
- recorded_at is when our system persisted it.
- idempotency_key is required.
- attributes must never contain raw code, prompts, secrets, or provider tokens.
```

---

### 9.2 `usage_rollups_hourly`

Fast dashboard and quota reads.

```sql
create table usage_rollups_hourly (
  id text primary key,
  org_id text not null references orgs(id),
  repo_id text references repositories(id),

  bucket_start timestamptz not null,
  bucket_end timestamptz not null,

  category text not null,
  type text not null,
  unit text not null,
  quantity bigint not null,

  source_event_count integer not null,
  finalized boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (org_id, repo_id, bucket_start, category, type, unit)
);
```

Also create daily/monthly rollups:

```text
usage_rollups_daily
usage_rollups_monthly
```

Monthly rollups are useful for billing-period dashboards, but do not replace the immutable event ledger.

---

### 9.3 `cost_rate_cards`

Versioned internal cost rates.

```sql
create table cost_rate_cards (
  id text primary key,
  provider text not null,
  model text,
  service text not null,

  unit text not null,
  cost_usd_micro_per_unit bigint not null,

  dimensions jsonb not null default '{}',

  effective_from timestamptz not null,
  effective_to timestamptz,

  source text not null,
  source_url text,
  notes text,

  created_at timestamptz not null default now(),

  unique (provider, service, model, unit, effective_from)
);
```

Examples:

```text
provider=openai, service=llm, model=gpt-..., unit=input_token
provider=openai, service=llm, model=gpt-..., unit=output_token
provider=openai, service=embedding, model=text-embedding-..., unit=input_token
provider=aws, service=sandbox_compute, unit=vcpu_second
provider=s3, service=object_storage, unit=gb_month
```

---

### 9.4 `cost_events`

Internal cost attribution ledger.

```sql
create table cost_events (
  id text primary key,
  org_id text not null references orgs(id),
  repo_id text references repositories(id),

  occurred_at timestamptz not null,
  recorded_at timestamptz not null default now(),

  source_type text not null,
  source_id text not null,

  provider text not null,
  service text not null,
  model text,
  unit text not null,
  quantity bigint not null,

  rate_card_id text references cost_rate_cards(id),
  estimated_cost_usd_micro bigint not null,

  attributes jsonb not null default '{}',

  created_at timestamptz not null default now(),

  unique (source_type, source_id, provider, service, model, unit)
);

create index cost_events_org_time_idx
  on cost_events (org_id, occurred_at desc);
```

Cost events are separate from usage events because cost attribution has different semantics.

---

### 9.5 `billing_accounts`

One billing account per organization by default.

```sql
create table billing_accounts (
  id text primary key,
  org_id text not null unique references orgs(id),

  billing_mode text not null,
  status text not null,

  provider text not null default 'stripe',
  provider_customer_id text,

  billing_email text,
  billing_name text,
  billing_country text,

  current_plan_key text,
  current_plan_version_id text,

  trial_ends_at timestamptz,
  grace_period_ends_at timestamptz,

  payment_status text not null default 'not_required',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

Possible `billing_mode`:

```text
free
self_serve
enterprise_contract
internal
suspended
```

Possible `status`:

```text
active
trialing
past_due
grace_period
cancelled
suspended
manual_review
```

---

### 9.6 `billing_plans`

Plan catalog.

```sql
create table billing_plans (
  id text primary key,
  plan_key text not null unique,
  name text not null,
  description text,
  audience text not null,
  public boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

Example `plan_key` values:

```text
free
developer
team
business
enterprise
internal
```

---

### 9.7 `billing_plan_versions`

Versioned pricing/config snapshot.

```sql
create table billing_plan_versions (
  id text primary key,
  plan_id text not null references billing_plans(id),
  version text not null,

  active boolean not null default true,
  effective_from timestamptz not null,
  effective_to timestamptz,

  provider text,
  provider_product_id text,
  provider_base_price_id text,

  currency text not null default 'usd',
  base_amount_usd_micro bigint,
  billing_interval text,

  included jsonb not null default '{}',
  limits jsonb not null default '{}',
  features jsonb not null default '{}',
  overage jsonb not null default '{}',

  created_at timestamptz not null default now(),

  unique (plan_id, version)
);
```

Example `included`:

```json
{
  "review_credits_per_month": 500,
  "active_repos": 20,
  "seats": 10
}
```

Example `limits`:

```json
{
  "max_comments_per_pr": 8,
  "max_changed_files_per_review": 300,
  "max_indexed_repo_bytes": 2000000000,
  "max_monthly_llm_cost_usd_micro": 50000000
}
```

Example `features`:

```json
{
  "inline_comments": true,
  "pr_summary": true,
  "team_memory": true,
  "static_analysis": true,
  "advanced_rules": true,
  "audit_logs": false,
  "sso": false,
  "self_hosted": false
}
```

---

### 9.8 `subscriptions`

Internal subscription mirror.

```sql
create table subscriptions (
  id text primary key,
  billing_account_id text not null references billing_accounts(id),

  provider text not null,
  provider_subscription_id text unique,

  status text not null,
  plan_version_id text references billing_plan_versions(id),

  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  cancelled_at timestamptz,

  trial_start timestamptz,
  trial_end timestamptz,

  quantity integer,

  raw_provider_status jsonb not null default '{}',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

---

### 9.9 `subscription_items`

Mirror of provider subscription items.

```sql
create table subscription_items (
  id text primary key,
  subscription_id text not null references subscriptions(id),

  provider_item_id text unique,
  provider_price_id text,

  item_type text not null,
  quantity integer,

  meter_key text,
  active boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

Possible `item_type`:

```text
base_subscription
seat_quantity
metered_review_credits
metered_ai_credits
enterprise_flat
```

---

### 9.10 `entitlements`

Feature access state for an org.

```sql
create table entitlements (
  id text primary key,
  org_id text not null references orgs(id),

  feature_key text not null,
  enabled boolean not null,

  source text not null,
  source_id text,

  value jsonb not null default '{}',

  effective_from timestamptz not null,
  effective_to timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (org_id, feature_key, source, effective_from)
);

create index entitlements_active_idx
  on entitlements (org_id, feature_key, effective_from, effective_to);
```

Examples:

```text
inline_comments = true
team_memory = true
static_analysis = true
max_comments_per_pr = 8
monthly_review_credit_limit = 500
sso = false
```

---

### 9.11 `quota_counters`

Fast counter state for limits.

```sql
create table quota_counters (
  id text primary key,
  org_id text not null references orgs(id),

  quota_key text not null,
  period_key text not null,
  period_start timestamptz not null,
  period_end timestamptz not null,

  used_quantity bigint not null default 0,
  reserved_quantity bigint not null default 0,
  limit_quantity bigint,

  source text not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (org_id, quota_key, period_key)
);
```

Examples:

```text
monthly_review_credits
monthly_pr_reviews
monthly_llm_cost_usd_micro
active_repositories
active_seats
```

---

### 9.12 `quota_reservations`

Prevent concurrent workers from exceeding limits.

```sql
create table quota_reservations (
  id text primary key,
  org_id text not null references orgs(id),
  quota_counter_id text not null references quota_counters(id),

  source_type text not null,
  source_id text not null,

  quantity bigint not null,
  status text not null,

  expires_at timestamptz not null,
  consumed_at timestamptz,
  released_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (source_type, source_id, quota_counter_id)
);
```

Reservation states:

```text
reserved
consumed
released
expired
cancelled
```

Use reservations for expensive review starts.

---

### 9.13 `credit_grants`

Manual or promotional usage credits.

```sql
create table credit_grants (
  id text primary key,
  org_id text not null references orgs(id),

  credit_type text not null,
  quantity bigint not null,
  remaining_quantity bigint not null,

  reason text not null,
  source text not null,
  source_id text,

  expires_at timestamptz,

  created_by_user_id text references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

Credit types:

```text
review_credit
ai_credit
usd_micro_credit
```

---

### 9.14 `billing_meter_events`

Internal record of what should be sent or was sent to Stripe.

```sql
create table billing_meter_events (
  id text primary key,
  org_id text not null references orgs(id),
  billing_account_id text not null references billing_accounts(id),

  provider text not null default 'stripe',
  meter_key text not null,

  quantity bigint not null,
  unit text not null,

  period_start timestamptz not null,
  period_end timestamptz not null,

  source_usage_event_ids text[] not null default '{}',
  source_rollup_id text,

  provider_customer_id text,
  provider_meter_event_id text,
  provider_event_name text,
  provider_idempotency_key text not null,

  status text not null,
  error_code text,
  error_message text,

  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (provider, provider_idempotency_key)
);
```

States:

```text
planned
ready_to_send
sending
sent
failed
cancelled
superseded
```

---

### 9.15 `invoices`

Provider invoice mirror.

```sql
create table invoices (
  id text primary key,
  billing_account_id text not null references billing_accounts(id),

  provider text not null,
  provider_invoice_id text not null unique,

  status text not null,
  currency text not null,
  amount_due_usd_micro bigint,
  amount_paid_usd_micro bigint,
  amount_remaining_usd_micro bigint,

  period_start timestamptz,
  period_end timestamptz,

  hosted_invoice_url text,
  invoice_pdf_url text,

  raw_provider_invoice jsonb not null default '{}',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

---

### 9.16 `billing_provider_requests`

Audit of outbound provider API calls.

```sql
create table billing_provider_requests (
  id text primary key,
  org_id text references orgs(id),
  billing_account_id text references billing_accounts(id),

  provider text not null,
  operation text not null,
  idempotency_key text,
  provider_request_id text,

  status text not null,
  error_code text,
  error_message text,

  request_metadata jsonb not null default '{}',
  response_metadata jsonb not null default '{}',

  started_at timestamptz not null,
  completed_at timestamptz,

  created_at timestamptz not null default now()
);
```

Never store full card/payment details.

---

### 9.17 `billing_webhook_events`

Stripe webhook ingestion table.

```sql
create table billing_webhook_events (
  id text primary key,
  provider text not null,
  provider_event_id text not null,
  event_type text not null,

  received_at timestamptz not null default now(),
  processed_at timestamptz,

  status text not null,
  error_code text,
  error_message text,

  related_billing_account_id text references billing_accounts(id),
  related_org_id text references orgs(id),

  raw_event_ref text,
  raw_event_hash text,

  created_at timestamptz not null default now(),

  unique (provider, provider_event_id)
);
```

Store raw event payload in object storage if needed. Do not keep sensitive payment data longer than necessary.

---

## 10. Core contracts

These should be added to `/packages/contracts` or exported from `/packages/usage` and `/packages/billing` with contract schemas.

### 10.1 Usage event input

```ts
export type EmitUsageEventInput = {
  orgId: OrgId;
  repoId?: RepositoryId;
  userId?: UserId;

  category: UsageCategory;
  type: UsageEventType;
  unit: UsageUnit;
  quantity: number;

  occurredAt: string;

  sourceService: string;
  sourceId?: string;
  idempotencyKey: string;

  reviewRunId?: ReviewRunId;
  repoIndexVersionId?: RepoIndexVersionId;
  llmCallId?: LLMCallId;
  sandboxRunId?: string;

  attributes?: Record<string, unknown>;

  billable?: {
    isCandidate: boolean;
    meterKey?: BillingMeterKey;
  };
};
```

### 10.2 Usage event output

```ts
export type UsageEvent = EmitUsageEventInput & {
  id: UsageEventId;
  recordedAt: string;
  correctionOfUsageEventId?: UsageEventId;
  correctionReason?: string;
};
```

### 10.3 Usage emitter interface

```ts
export interface UsageEmitter {
  emit(input: EmitUsageEventInput): Promise<UsageEvent>;
  emitMany(inputs: EmitUsageEventInput[]): Promise<UsageEvent[]>;
  correct(input: CorrectUsageEventInput): Promise<UsageEvent>;
}
```

### 10.4 Cost event input

```ts
export type RecordCostEventInput = {
  orgId: OrgId;
  repoId?: RepositoryId;

  occurredAt: string;

  sourceType: "llm_call" | "embedding_batch" | "sandbox_run" | "storage_snapshot";
  sourceId: string;

  provider: string;
  service: string;
  model?: string;

  unit: UsageUnit;
  quantity: number;

  rateCardId?: CostRateCardId;
  estimatedCostUsdMicro: number;

  attributes?: Record<string, unknown>;
};
```

### 10.5 Entitlement decision

```ts
export type EntitlementDecision = {
  orgId: OrgId;
  featureKey: FeatureKey;
  allowed: boolean;
  reason:
    | "enabled"
    | "disabled_by_plan"
    | "disabled_by_admin"
    | "payment_past_due"
    | "trial_expired"
    | "quota_exceeded"
    | "org_suspended";
  source: "plan" | "override" | "stripe" | "manual" | "internal";
  value?: unknown;
};
```

### 10.6 Quota decision

```ts
export type QuotaDecision = {
  orgId: OrgId;
  quotaKey: QuotaKey;
  allowed: boolean;
  mode: "allow" | "warn" | "deny";
  usedQuantity: number;
  reservedQuantity: number;
  requestedQuantity: number;
  limitQuantity?: number;
  remainingQuantity?: number;
  periodStart: string;
  periodEnd: string;
  reason:
    | "under_limit"
    | "soft_limit_exceeded"
    | "hard_limit_exceeded"
    | "no_limit"
    | "payment_restricted"
    | "manual_override";
};
```

### 10.7 Billing provider interface

```ts
export interface BillingProvider {
  createCustomer(input: CreateBillingCustomerInput): Promise<BillingCustomerRef>;
  createCheckoutSession(input: CreateCheckoutSessionInput): Promise<CheckoutSessionRef>;
  createCustomerPortalSession(input: CreatePortalSessionInput): Promise<PortalSessionRef>;
  getSubscription(input: GetSubscriptionInput): Promise<ProviderSubscription>;
  sendMeterEvent(input: SendMeterEventInput): Promise<ProviderMeterEventRef>;
  parseWebhook(input: ParseBillingWebhookInput): Promise<ParsedBillingWebhookEvent>;
}
```

### 10.8 Billing provider adapter rule

No application package should import Stripe directly.

Allowed:

```text
/packages/billing/src/stripe/*
```

Forbidden:

```text
/apps/api directly importing stripe
/apps/worker directly importing stripe
/packages/usage directly importing stripe
/packages/entitlements directly importing stripe
```

---

## 11. Usage emission points

### 11.1 Review orchestrator

Emit:

```text
review_requested
review_started
review_completed
review_skipped
review_failed
billable_review_credit
```

Rules:

```text
review_requested: when durable ReviewRun is created
review_started: when review enters running state
review_completed: when findings are validated and publish job is ready
billable_review_credit: after review is complete and not skipped/superseded
review_failed: terminal failure
review_skipped: policy skip or unsupported PR
```

Example:

```ts
await usage.emit({
  orgId,
  repoId,
  category: "review",
  type: "review_completed",
  unit: "count",
  quantity: 1,
  occurredAt: new Date().toISOString(),
  sourceService: "review-orchestrator",
  sourceId: reviewRunId,
  idempotencyKey: `review_completed:${reviewRunId}`,
  reviewRunId,
  attributes: {
    changedFilesCount,
    addedLines,
    deletedLines,
    candidateFindingsCount,
    publishedFindingsCount,
    reviewMode,
  },
});
```

---

### 11.2 Index importer

Emit:

```text
index_completed
indexed_file
indexed_loc
indexed_chunk
indexed_symbol
```

Use aggregate events, not one event per file, unless needed for debugging.

```ts
await usage.emitMany([
  {
    orgId,
    repoId,
    category: "indexing",
    type: "indexed_file",
    unit: "file",
    quantity: filesIndexed,
    idempotencyKey: `indexed_file:${indexVersionId}`,
    sourceService: "index-importer",
    sourceId: indexVersionId,
    repoIndexVersionId: indexVersionId,
    occurredAt,
  },
  {
    orgId,
    repoId,
    category: "indexing",
    type: "indexed_chunk",
    unit: "chunk",
    quantity: chunksCreated,
    idempotencyKey: `indexed_chunk:${indexVersionId}`,
    sourceService: "index-importer",
    sourceId: indexVersionId,
    repoIndexVersionId: indexVersionId,
    occurredAt,
  },
]);
```

---

### 11.3 Embedding worker

Emit:

```text
embedding_completed
embedding_input_token
embedding_vector_stored
```

Record cost events in the same job.

```ts
await usage.emit({
  orgId,
  repoId,
  category: "embedding",
  type: "embedding_input_token",
  unit: "token",
  quantity: inputTokens,
  occurredAt,
  sourceService: "embedding-worker",
  sourceId: embeddingBatchId,
  idempotencyKey: `embedding_input_token:${embeddingBatchId}`,
  attributes: { provider, model, dimensions, chunks: chunkCount },
});
```

---

### 11.4 LLM Gateway

Every successful LLM call should emit usage and cost.

Emit:

```text
llm_call_completed
llm_input_token
llm_cached_input_token
llm_output_token
llm_reasoning_token
```

Also write:

```text
llm_calls
cost_events
usage_events
```

The LLM Gateway should be the single place that translates provider usage fields into normalized usage events.

---

### 11.5 Static analysis and sandbox

Emit after a sandbox run completes:

```text
sandbox_run_completed
sandbox_wall_ms
sandbox_cpu_ms
static_analysis_run_completed
```

Use one aggregate event per run.

---

### 11.6 Publisher

Emit:

```text
finding_published
summary_published
```

These are usually not billable, but useful for analytics.

---

### 11.7 Daily storage snapshot worker

Emit:

```text
storage_bytes_snapshot
```

Attributes:

```json
{
  "objectStoreBytes": 123456,
  "dbApproxBytes": 123456,
  "artifactBytes": 123456,
  "indexArtifactBytes": 123456,
  "reviewArtifactBytes": 123456
}
```

---

## 12. Idempotency strategy

Usage emits must be idempotent.

Recommended key patterns:

```text
review_requested:{review_run_id}
review_completed:{review_run_id}
billable_review_credit:{review_run_id}
index_completed:{repo_index_version_id}
embedding_completed:{embedding_batch_id}
llm_input_token:{llm_call_id}
llm_output_token:{llm_call_id}
sandbox_run_completed:{sandbox_run_id}
finding_published:{published_finding_id}
```

`usage_events` has:

```text
unique (org_id, idempotency_key)
```

`emit()` should behave like:

```text
if event exists with same org_id + idempotency_key:
  return existing event
else:
  insert event
```

If same key but different payload hash is supplied, fail loudly.

Create a helper:

```ts
function usagePayloadHash(input: EmitUsageEventInput): string
```

Store it in `attributes._payloadHash` or a dedicated column if desired.

---

## 13. Rollup strategy

### 13.1 Why rollups exist

Do not compute dashboard and quota summaries by scanning raw usage events every time.

Use rollups for:

```text
- monthly usage dashboard
- quota checks
- billing meter planning
- admin cost reports
- anomaly detection
```

### 13.2 Rollup levels

```text
hourly:  operational visibility and near-real-time quotas
 daily:  customer dashboard and trends
monthly: billing-period summaries
```

### 13.3 Rollup job behavior

The rollup job should be repeatable and idempotent.

```text
for each open bucket:
  aggregate usage_events by org/repo/category/type/unit
  upsert rollup row
  mark finalized only after lateness window passes
```

Recommended lateness windows:

```text
hourly bucket finalized after 2 hours
daily bucket finalized after 36 hours
monthly bucket finalized after invoice reconciliation
```

### 13.4 Corrections

If a correction event arrives after a bucket is finalized:

```text
- include correction in the correction event's occurred_at bucket, or
- maintain adjustment rollup rows
```

Recommended MVP:

```text
Correction event uses current occurred_at.
Dashboard can show adjustments separately.
Billing sync should avoid finalizing billable meters too early.
```

---

## 14. Cost estimation

### 14.1 LLM cost calculation

Inputs:

```text
provider
model
input_tokens
cached_input_tokens
output_tokens
reasoning_tokens
service_tier
batch_mode
rate_card_version
```

Output:

```text
estimated_cost_usd_micro
```

Cost should be calculated immediately after each provider call because:

```text
- provider usage is available
- model/profile is known
- rate card version can be captured
- cost attribution is precise
```

### 14.2 Rate card versioning

When provider pricing changes, create a new `cost_rate_cards` row.

Never update historical rows in place except to fix incorrect metadata with an audit entry.

### 14.3 Reconciliation

Monthly provider invoice reconciliation should compare:

```text
sum(cost_events.estimated_cost_usd_micro)
vs
actual provider invoice/export
```

Expected differences:

```text
- rounding
- discounts
- cached token accounting
- provider invoice timing
- failed/refunded requests
- free credits
```

Create `cost_reconciliation_runs` later if needed.

---

## 15. Entitlements and feature gates

### 15.1 Entitlement sources

Entitlements can come from:

```text
plan version
manual admin override
enterprise contract
Stripe entitlement webhook
internal/test mode
```

Precedence recommendation:

```text
1. manual suspension deny
2. manual admin override
3. enterprise contract override
4. active subscription / plan version
5. free/default plan
```

### 15.2 Feature keys

Initial feature keys:

```text
reviews.enabled
reviews.inline_comments
reviews.pr_summary
reviews.max_comments_per_pr
reviews.max_monthly_review_credits
reviews.max_changed_files
reviews.max_patch_bytes

indexing.enabled
indexing.max_repo_bytes
indexing.max_file_bytes
indexing.languages

memory.enabled
rules.advanced
static_analysis.enabled
sandbox.enabled

security.audit_logs
security.sso
security.data_retention_custom
enterprise.self_hosted
enterprise.byok
```

### 15.3 Entitlement service interface

```ts
export interface EntitlementService {
  getOrgEntitlements(orgId: OrgId): Promise<EntitlementSet>;
  checkFeature(input: CheckFeatureInput): Promise<EntitlementDecision>;
  compilePlanSnapshot(input: CompilePlanSnapshotInput): Promise<PlanSnapshot>;
}
```

### 15.4 Plan snapshot

Every review run should store a plan snapshot or policy snapshot containing relevant billing constraints.

```ts
export type PlanSnapshot = {
  schemaVersion: "plan_snapshot.v1";
  orgId: OrgId;
  billingAccountId: BillingAccountId;
  planKey: string;
  planVersionId: BillingPlanVersionId;
  subscriptionStatus: string;
  paymentStatus: string;
  features: Record<string, unknown>;
  limits: Record<string, number | boolean | string>;
  compiledAt: string;
};
```

This prevents old review runs from changing meaning when plans are updated.

---

## 16. Quota enforcement

### 16.1 Quota keys

```text
monthly_review_credits
monthly_pr_reviews
monthly_llm_cost_usd_micro
monthly_indexed_bytes
monthly_embedding_tokens
active_repositories
active_seats
concurrent_reviews
```

### 16.2 Quota service

```ts
export interface QuotaService {
  check(input: CheckQuotaInput): Promise<QuotaDecision>;
  reserve(input: ReserveQuotaInput): Promise<QuotaReservation>;
  consumeReservation(input: ConsumeReservationInput): Promise<void>;
  releaseReservation(input: ReleaseReservationInput): Promise<void>;
  recalculate(input: RecalculateQuotaInput): Promise<void>;
}
```

### 16.3 Review-start quota flow

```text
Review job starts
  -> compile plan/policy snapshot
  -> estimate required review credits
  -> quota.reserve(monthly_review_credits)
  -> if allowed: proceed
  -> if warn: proceed and include warning in review_run metadata
  -> if denied: skip review with billing/quota reason
```

After review outcome:

```text
review completed and billable:
  consume reservation
  emit billable_review_credit

review skipped, failed system-side, superseded:
  release reservation
```

### 16.4 Soft vs hard limits

Plan config should support:

```json
{
  "monthly_review_credits": {
    "included": 500,
    "softLimit": 500,
    "hardLimit": 650,
    "overageAllowed": true,
    "warningThresholds": [0.8, 0.95, 1.0]
  }
}
```

Recommended MVP:

```text
Free: hard limits
Paid self-serve: soft limit + overage or grace
Enterprise: custom or no hard limit with admin alerts
```

---

## 17. Billing provider architecture

### 17.1 Provider-neutral layer

```text
/packages/billing
  BillingProvider interface
  StripeBillingProvider implementation
  FakeBillingProvider for tests
```

The API routes and workers call provider-neutral methods.

### 17.2 Stripe as default provider

Stripe owns:

```text
- customer object
- payment method collection
- subscription lifecycle
- invoices
- payment failure state
- customer portal
- checkout sessions
- meter events for usage-based billing
```

Internal app owns:

```text
- feature access decisions
- quota counters
- usage ledger
- cost attribution
- product state
- review eligibility
```

---

## 18. Stripe integration

### 18.1 Required Stripe objects

```text
Customer
Product
Price
Subscription
Subscription Item
Checkout Session
Customer Portal Session
Billing Meter
Meter Event
Invoice
Webhook Event
```

### 18.2 Stripe customer creation

Create a Stripe Customer when:

```text
- org starts checkout, or
- admin converts org to paid, or
- enterprise contract needs invoice sync
```

Do not create Stripe Customers for every free org unless needed.

Store:

```text
billing_accounts.provider_customer_id
```

### 18.3 Checkout flow

```text
User clicks upgrade
  -> API checks org admin permission
  -> ensure billing_account exists
  -> ensure Stripe customer exists
  -> create Stripe Checkout Session
  -> return checkout URL
  -> user completes checkout
  -> Stripe sends checkout.session.completed
  -> webhook syncs subscription
  -> entitlements refresh
```

API endpoint:

```http
POST /api/billing/checkout-session
```

Request:

```json
{
  "orgId": "org_...",
  "planKey": "team",
  "successUrl": "https://app.example.com/billing/success",
  "cancelUrl": "https://app.example.com/billing"
}
```

### 18.4 Customer portal flow

```text
User opens billing settings
  -> API checks org billing admin permission
  -> create Stripe Customer Portal Session
  -> redirect user to portal URL
  -> user updates subscription/payment details
  -> Stripe webhooks update internal state
```

API endpoint:

```http
POST /api/billing/portal-session
```

Use portal for:

```text
- payment method updates
- invoice downloads
- subscription cancellation
- upgrades/downgrades if configured
```

### 18.5 Stripe webhooks

Route:

```http
POST /webhooks/stripe
```

Requirements:

```text
- raw body access
- Stripe signature verification
- persist provider event id
- idempotent processing
- durable background job for processing
- never trust unverified webhook payloads
```

Initial events:

```text
checkout.session.completed
customer.created
customer.updated
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
invoice.created
invoice.finalized
invoice.paid
invoice.payment_failed
invoice.voided
invoice.marked_uncollectible
payment_method.attached
entitlements.active_entitlement_summary.updated
```

Processing rules:

```text
- Use provider event id for idempotency.
- Update billing account/subscription mirrors.
- Refresh entitlements after subscription changes.
- Update payment status after invoice/payment events.
- Do not grant access solely from Checkout redirect success; wait for webhook or verify provider state.
```

### 18.6 Metered usage sync

Internal billable usage is planned as `billing_meter_events`.

Flow:

```text
usage_events / rollups
  -> billable usage planner
  -> billing_meter_events planned
  -> stripe meter sync worker
  -> Stripe meter event API
  -> mark sent
```

For each meter event, include:

```text
provider event name
customer id
quantity/value
period timestamp
idempotency key
```

Recommended MVP sync cadence:

```text
Hourly for paid self-serve.
Daily is acceptable early if limits are enforced internally.
```

Do not wait until the last minute of the billing period to send all usage.

### 18.7 Meter event idempotency

Provider idempotency key pattern:

```text
stripe_meter:{org_id}:{meter_key}:{period_start}:{period_end}:{source_rollup_id}
```

If sending per review:

```text
stripe_meter:review_credit:{review_run_id}
```

Prefer rollup-based meter events for lower volume.

### 18.8 Subscription status mapping

Internal mapping example:

```text
Stripe active       -> active
Stripe trialing     -> trialing
Stripe past_due     -> grace_period or past_due
Stripe canceled     -> cancelled
Stripe unpaid       -> suspended or past_due
Stripe incomplete   -> pending_payment
```

Do not immediately hard-suspend on first failed payment. Use grace period.

### 18.9 Payment failure behavior

Recommended behavior:

```text
invoice.payment_failed
  -> billing_account.payment_status = past_due
  -> grace_period_ends_at = now + configured grace days
  -> notify admins
  -> continue reviews until grace expires, subject to abuse limits

Grace expired
  -> deny new reviews
  -> allow dashboard access
  -> allow billing portal access
  -> do not delete data
```

---

## 19. Billing lifecycle flows

### 19.1 Free org creation

```text
Org created
  -> billing_account created with billing_mode=free
  -> assign free plan version
  -> create default entitlements
  -> no Stripe customer yet
```

### 19.2 Upgrade to paid

```text
Org admin selects plan
  -> create/reuse billing_account
  -> create/reuse Stripe customer
  -> create checkout session
  -> redirect to Stripe
  -> webhook confirms subscription
  -> update internal subscription mirror
  -> refresh entitlements
  -> dashboard shows paid plan
```

### 19.3 Plan change

```text
User changes plan in portal or app
  -> Stripe subscription updated
  -> webhook received
  -> internal subscription mirror updated
  -> entitlements refreshed
  -> review policy snapshots use new plan from this point forward
```

### 19.4 Cancellation

```text
User cancels
  -> subscription cancel_at_period_end true or deleted
  -> webhook updates subscription
  -> entitlements remain until period end if cancel_at_period_end
  -> after period end, downgrade to free or cancelled policy
```

### 19.5 Enterprise manual contract

```text
Admin sets billing_mode=enterprise_contract
  -> choose plan_key=enterprise
  -> set custom entitlements/limits
  -> optional Stripe invoice/customer linkage
  -> no self-serve portal required
```

### 19.6 Internal/test org

```text
billing_mode=internal
  -> unlimited or configured internal limits
  -> not sent to Stripe
  -> usage still recorded
```

---

## 20. Billing policies

### 20.1 What is billable?

Default billable rules:

```text
Bill completed reviews that generated a final review result.
Do not bill skipped reviews.
Do not bill reviews superseded before publish.
Do not bill reviews that fail due to system/provider errors.
Do not bill dry-run/internal eval reviews.
Do not bill replay/debug reviews.
```

Configurable later:

```text
Bill summary-only reviews.
Bill manual re-runs.
Bill static-analysis-only reviews.
Bill by review size.
```

### 20.2 Billable review event source

Use `review_run_id` as the source of truth.

A single review run can emit at most one:

```text
billable_review_credit
```

Enforce with idempotency:

```text
billable_review_credit:{review_run_id}
```

### 20.3 Draft PRs

If policy skips draft PRs:

```text
not billable
```

If policy reviews draft PRs:

```text
billable if completed
```

### 20.4 Bot-authored PRs

Configurable.

Default:

```text
skip bot-authored PRs unless explicitly enabled
not billable when skipped
```

### 20.5 Huge PRs

Default behavior:

```text
If PR exceeds plan limit:
  skip or summary-only
  not bill full review credit unless review actually runs
```

If summary-only runs:

```text
billable only if plan defines summary-only billing
```

---

## 21. API surface

### 21.1 Billing account

```http
GET /api/orgs/:orgId/billing/account
```

Returns:

```json
{
  "billingAccount": {},
  "subscription": {},
  "plan": {},
  "entitlements": {},
  "paymentStatus": "active"
}
```

### 21.2 Create checkout session

```http
POST /api/orgs/:orgId/billing/checkout-session
```

Body:

```json
{
  "planKey": "team",
  "successUrl": "https://app.example.com/orgs/org_123/billing/success",
  "cancelUrl": "https://app.example.com/orgs/org_123/billing"
}
```

### 21.3 Create portal session

```http
POST /api/orgs/:orgId/billing/portal-session
```

Body:

```json
{
  "returnUrl": "https://app.example.com/orgs/org_123/billing"
}
```

### 21.4 Usage summary

```http
GET /api/orgs/:orgId/usage/summary?period=current_month
```

Returns:

```json
{
  "period": {
    "start": "2026-04-01T00:00:00Z",
    "end": "2026-05-01T00:00:00Z"
  },
  "reviewCredits": {
    "used": 213,
    "included": 500,
    "remaining": 287
  },
  "cost": {
    "estimatedUsdMicro": 1234567
  },
  "byRepo": [],
  "byCategory": []
}
```

### 21.5 Usage events

```http
GET /api/orgs/:orgId/usage/events?cursor=...&type=review_completed
```

Admin only or billing admin only.

### 21.6 Entitlements

```http
GET /api/orgs/:orgId/entitlements
```

### 21.7 Admin billing override

```http
PATCH /api/admin/orgs/:orgId/billing
```

Admin only.

Supports:

```text
- billing mode
- plan override
- grace period
- manual credit grants
- suspension
- custom limits
```

---

## 22. Dashboard surfaces

### 22.1 Billing page

Show:

```text
current plan
subscription status
payment status
billing email
renewal date
cancel-at-period-end state
included usage
current usage
portal button
upgrade button
invoice list
```

### 22.2 Usage page

Show:

```text
review credits used this month
PR reviews by repo
LLM/internal cost estimate, admin-only
indexing usage
embedding usage
static analysis usage
storage usage
trend chart
```

### 22.3 Repo usage page

Show:

```text
reviews this month
average cost per review, admin/internal only
avg latency
published comments
accepted/resolved findings if feedback exists
```

### 22.4 Admin billing page

Show:

```text
org billing mode
plan version
subscription mirror
Stripe customer/subscription IDs
usage rollups
meter event sync status
failed provider requests
manual credit grants
entitlements
quota counters
```

### 22.5 Review run billing/debug panel

For each review run:

```text
billable? yes/no
billable reason
review credits consumed
quota reservation id
plan snapshot
usage events
LLM cost events
meter event status
```

---

## 23. Worker jobs

### 23.1 `usage.rollup.hourly`

```text
Input: bucket_start, bucket_end optional
Output: usage_rollups_hourly rows
Schedule: every 15 minutes
```

### 23.2 `usage.rollup.daily`

```text
Input: day
Output: usage_rollups_daily rows
Schedule: hourly, finalizes after lateness window
```

### 23.3 `cost.rollup`

```text
Input: period
Output: cost summaries
Schedule: hourly/daily
```

### 23.4 `quota.recalculate`

```text
Input: org_id, quota_key, period
Output: quota_counters
Trigger: usage event, subscription update, manual admin action
```

### 23.5 `billing.plan-meter-events`

```text
Input: billing_account_id, period
Output: billing_meter_events rows
Schedule: hourly/daily
```

### 23.6 `billing.send-meter-events`

```text
Input: billing_meter_event_id or batch
Output: sent/failed billing_meter_events
Schedule: continuous worker
```

### 23.7 `billing.sync-provider-state`

```text
Input: billing_account_id
Output: refreshed customer/subscription/invoice mirror
Trigger: webhook, manual admin, reconciliation schedule
```

### 23.8 `billing.reconcile-invoices`

```text
Input: period
Output: invoice mirror + discrepancy reports
Schedule: daily/monthly
```

---

## 24. Billing meter planning

### 24.1 Internal to external meter mapping

Create a config table or code registry:

```ts
export type BillingMeterConfig = {
  meterKey: string;
  provider: "stripe";
  providerEventName: string;
  internalUsageType: UsageEventType;
  unit: UsageUnit;
  aggregation: "sum" | "count";
  syncCadence: "hourly" | "daily";
  enabled: boolean;
};
```

Example:

```json
{
  "meterKey": "review_credits",
  "provider": "stripe",
  "providerEventName": "review_credits",
  "internalUsageType": "billable_review_credit",
  "unit": "credit",
  "aggregation": "sum",
  "syncCadence": "hourly",
  "enabled": true
}
```

### 24.2 Meter event planner algorithm

```text
for each billing account with active metered subscription:
  find unsent billable usage in period
  group by meter_key and time bucket
  create billing_meter_events rows with idempotency keys
```

Pseudo-code:

```ts
async function planMeterEvents(input: PlanMeterEventsInput) {
  const accounts = await billingAccounts.findActiveMeteredAccounts(input.period);

  for (const account of accounts) {
    const groups = await usage.findBillableUsageGroups({
      orgId: account.orgId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      unsentOnly: true,
    });

    for (const group of groups) {
      await billingMeterEvents.upsertPlanned({
        orgId: account.orgId,
        billingAccountId: account.id,
        meterKey: group.meterKey,
        quantity: group.quantity,
        unit: group.unit,
        periodStart: group.periodStart,
        periodEnd: group.periodEnd,
        sourceUsageEventIds: group.usageEventIds,
        providerEventName: meterConfig.providerEventName,
        providerCustomerId: account.providerCustomerId,
        providerIdempotencyKey: makeMeterIdempotencyKey(group),
      });
    }
  }
}
```

### 24.3 Meter event sender algorithm

```text
find billing_meter_events where status=ready_to_send
for each:
  acquire row lock
  send to provider with idempotency key
  mark sent or failed
```

Retry failed network/provider temporary errors.

Do not retry permanent mapping errors forever.

---

## 25. Security and privacy

### 25.1 Sensitive data rules

Usage attributes must not contain:

```text
raw source code
raw diffs
raw prompts
raw model outputs
secrets
GitHub tokens
Stripe API keys
payment method details
full billing addresses unless necessary
```

Allowed metadata:

```text
counts
IDs
hashes
provider names
model names
duration
status
category
cost estimates
```

### 25.2 Billing permissions

Roles:

```text
org_owner
billing_admin
admin
support_admin
```

Permissions:

```text
billing.view
billing.manage
billing.portal
billing.admin_override
usage.view
usage.view_costs
usage.export
```

Default:

```text
owners can manage billing
billing admins can manage billing
regular members can see limited plan/usage summary if enabled
internal cost views are admin/support only
```

### 25.3 Stripe webhook security

Requirements:

```text
- verify signature using raw body
- reject unsigned/invalid events
- persist provider event id
- idempotent processing
- never expose webhook secret to app logs
```

### 25.4 Provider ID exposure

Dashboard may show Stripe invoice links and customer portal links.

Do not expose internal provider IDs broadly unless admin/debug view.

### 25.5 Data retention

Usage events should be retained long enough for:

```text
- invoice disputes
- enterprise reports
- fraud investigation
- product analytics
```

Recommended defaults:

```text
raw usage_events: 24 months
usage rollups: 36 months
billing provider request metadata: 24 months
raw Stripe webhook payload artifacts: 90-180 days unless needed
invoices mirror: 7 years or per finance/legal policy
```

Final retention should align with #27 compliance policy.

---

## 26. Failure modes

### 26.1 Usage emit fails

Usage emit should generally be part of the same transaction as the state transition if billing-affecting.

For non-billing telemetry usage, best-effort async is acceptable.

Examples:

```text
billable_review_credit -> must persist transactionally
llm_input_token -> should persist, but can be reconstructed from llm_calls
context_item_selected -> best effort
```

### 26.2 Stripe API unavailable

Do not block product usage solely because Stripe is temporarily unavailable.

```text
- continue recording internal usage
- keep billing_meter_events unsent
- retry later
- alert if lag exceeds threshold
```

### 26.3 Stripe webhook delayed

Checkout success redirect may happen before webhook.

Dashboard should show:

```text
Payment pending, syncing subscription...
```

API can optionally verify provider state directly after checkout return, but webhook remains the durable source.

### 26.4 Meter sync lag

If internal quotas are enforced, meter sync lag should not allow unbounded overuse.

Alert if:

```text
unsent metered usage > threshold
oldest unsent meter event age > threshold
```

### 26.5 Duplicate webhook

Use:

```text
unique(provider, provider_event_id)
```

Duplicate webhook should no-op.

### 26.6 Duplicate meter send

Use:

```text
provider idempotency key
unique(provider, provider_idempotency_key)
```

Provider retries should be safe.

### 26.7 Plan config error

If plan config is invalid:

```text
- fail deployment validation if static config
- reject admin update if dynamic config
- keep previous active plan version
```

Never partially activate invalid plan config.

---

## 27. Observability

Metrics:

```text
usage_events_created_total{type,category}
usage_emit_errors_total{type,reason}
usage_rollup_latency_ms
usage_rollup_lag_seconds
cost_events_created_total{provider,service,model}
estimated_cost_usd_micro_total{provider,service,model}
quota_denials_total{quota_key,plan}
quota_warnings_total{quota_key,plan}
billing_meter_events_planned_total{meter_key}
billing_meter_events_sent_total{meter_key,provider}
billing_meter_events_failed_total{meter_key,provider,error_code}
stripe_webhook_events_received_total{event_type}
stripe_webhook_events_failed_total{event_type,error_code}
subscription_status_count{status}
payment_status_count{status}
```

Logs should include:

```text
org_id
billing_account_id
review_run_id when relevant
usage_event_id
quota_key
meter_key
provider
provider_request_id when safe
idempotency_key hash, not necessarily raw key
```

Traces:

```text
review orchestrator span
  usage.reserve_quota
  usage.emit_review_completed
  usage.emit_billable_credit

billing sync span
  plan_meter_events
  send_stripe_meter_event
```

Alerts:

```text
Stripe meter sync lag > 6 hours
billing webhook failure rate > 1%
usage rollup lag > 2 hours
quota counter reconciliation mismatch
unexpected spike in LLM cost per review
payment failure webhook processing failing
```

---

## 28. Testing strategy

### 28.1 Unit tests

```text
UsageEmitter idempotency
UsageEmitter correction events
CostEstimator rate selection
QuotaService check/reserve/consume/release
PlanSnapshot compiler
EntitlementService precedence
BillingProvider fake adapter
Stripe mapper functions
Meter event planner
```

### 28.2 Integration tests

```text
usage event insert + rollup
review completed -> billable credit -> quota consume
checkout session creation with fake provider
stripe webhook event -> subscription mirror update
meter event planning -> provider send -> sent state
payment failed -> grace period state
subscription cancelled -> entitlement downgrade
```

### 28.3 Contract tests

```text
billing API response schemas
usage event schemas
provider webhook normalized event schemas
entitlement decision schemas
quota decision schemas
```

### 28.4 Idempotency tests

```text
same usage emit twice returns same event
same webhook twice no double subscription update
same meter event send twice uses same idempotency key
same review_run cannot emit two billable credits
```

### 28.5 Failure tests

```text
Stripe unavailable
Stripe webhook invalid signature
Stripe webhook unknown customer
meter event permanent provider error
quota reservation expires
review fails after quota reserved
plan config invalid
billing account missing provider customer id
```

### 28.6 End-to-end tests

Use fake billing provider:

```text
create org
upgrade to team plan
run review
usage emitted
quota consumed
meter event planned
meter event sent
dashboard shows usage
cancel subscription
entitlements downgraded after period end
```

---

## 29. Local development

### 29.1 Fake billing provider

Implement `FakeBillingProvider` first.

It should support:

```text
createCustomer
createCheckoutSession
createPortalSession
getSubscription
sendMeterEvent
parseWebhook
```

Use fake provider for local tests and CI.

### 29.2 Stripe test mode

Use Stripe test mode for manual integration.

Local webhook testing should use Stripe CLI or equivalent forwarding.

Required env:

```text
BILLING_PROVIDER=stripe
STRIPE_SECRET_KEY=...
STRIPE_WEBHOOK_SECRET=...
STRIPE_PRICE_TEAM_BASE=...
STRIPE_PRICE_REVIEW_CREDITS=...
STRIPE_PORTAL_RETURN_URL=...
```

### 29.3 Dev seed data

Seed:

```text
free plan
team plan
business plan
internal plan
feature catalog
rate cards
fake orgs
fake usage events
fake subscriptions
```

---

## 30. Implementation sequence

### PR 1: Usage package and ledger

Implement:

```text
/packages/usage package
UsageEvent contracts
usage_events table
UsageEmitter
idempotency handling
emit/emitMany/correct
unit tests
```

Definition of done:

```text
Any service can emit idempotent usage events.
Duplicate emits do not duplicate ledger rows.
```

---

### PR 2: Cost events and rate cards

Implement:

```text
cost_rate_cards table
cost_events table
CostEstimator
rate card seed data
LLM Gateway integration stub
unit tests
```

Definition of done:

```text
LLM calls can record normalized usage and estimated cost.
```

---

### PR 3: Rollups

Implement:

```text
usage_rollups_hourly
usage_rollups_daily
rollup worker
rollup repository
basic usage summary API
```

Definition of done:

```text
Dashboard/API can read current-month review usage without scanning raw events.
```

---

### PR 4: Plans and entitlements

Implement:

```text
billing_plans
billing_plan_versions
entitlements
EntitlementService
PlanSnapshot compiler
seed free/team/business/internal plans
```

Definition of done:

```text
Org feature access can be determined without calling Stripe.
```

---

### PR 5: Quota service

Implement:

```text
quota_counters
quota_reservations
QuotaService
review credit quota
reservation consume/release
review orchestrator integration
```

Definition of done:

```text
Review runs can reserve/consume monthly review credits idempotently.
```

---

### PR 6: Billing account model

Implement:

```text
billing_accounts
subscriptions
subscription_items
credit_grants
invoices
API read endpoints
basic dashboard billing page
```

Definition of done:

```text
Every org has a billing account and visible plan/usage state.
```

---

### PR 7: Fake billing provider

Implement:

```text
BillingProvider interface
FakeBillingProvider
fake checkout/portal URLs
fake subscription webhook fixtures
integration tests
```

Definition of done:

```text
Billing flows can be tested without Stripe.
```

---

### PR 8: Stripe customer, checkout, portal

Implement:

```text
StripeBillingProvider
createCustomer
createCheckoutSession
createCustomerPortalSession
billing API endpoints
provider request logging
idempotency keys
```

Definition of done:

```text
Org admin can start Stripe Checkout and open Stripe Customer Portal.
```

---

### PR 9: Stripe webhooks

Implement:

```text
/webhooks/stripe route
raw body signature verification
billing_webhook_events
webhook processor
subscription mirror sync
invoice mirror sync
payment status sync
```

Definition of done:

```text
Checkout/session/subscription/payment changes update internal billing state idempotently.
```

---

### PR 10: Metered usage sync

Implement:

```text
billing_meter_events
meter config registry
meter event planner
Stripe meter event sender
retry/error handling
admin debug view
```

Definition of done:

```text
Billable review credits are sent to Stripe as idempotent meter events.
```

---

### PR 11: Billing dashboard hardening

Implement:

```text
usage charts
invoice list
portal links
quota warnings
payment failure banners
admin billing debug view
```

Definition of done:

```text
Customers and support can explain current plan, usage, invoices, and limits.
```

---

### PR 12: Reconciliation and alerts

Implement:

```text
meter sync lag alerts
usage/cost anomaly alerts
provider state reconciliation worker
quota counter reconciliation
billing event dashboards
```

Definition of done:

```text
Billing drift and sync failures are visible and recoverable.
```

---

## 31. MVP cut

For MVP, implement:

```text
- usage_events
- UsageEmitter
- core usage event types
- LLM usage/cost recording
- review_completed and billable_review_credit usage
- usage_rollups_daily/monthly
- billing_accounts with free/internal modes
- billing_plans and billing_plan_versions
- basic entitlements
- quota_counters and quota_reservations for review credits
- usage summary API
- billing/usage dashboard basics
- FakeBillingProvider
```

Can defer:

```text
- Stripe Checkout
- Stripe Customer Portal
- Stripe webhooks
- Stripe metered usage
- invoice reconciliation
- credit grants
- advanced cost reconciliation
- enterprise contract tooling
```

If launching paid beta, add:

```text
- Stripe Checkout
- Stripe Customer Portal
- Stripe webhook processor
- subscription mirror
- invoice mirror
```

If launching usage-based paid beta, also add:

```text
- billing_meter_events
- Stripe meter event sync
- meter sync alerts
```

---

## 32. Definition of done

#28 is complete when:

```text
- Product services can emit idempotent usage events.
- Usage events are immutable and queryable by org/repo/review.
- LLM Gateway records token usage and estimated cost.
- Review runs emit billable review credit events exactly once.
- Usage rollups power dashboard summaries.
- Plans and entitlements can be compiled into a stable plan snapshot.
- QuotaService can reserve/consume/release review credits.
- Billing account state exists for every org.
- FakeBillingProvider supports full local billing flow tests.
- Stripe adapter is implemented if paid self-serve is enabled.
- Stripe webhooks are signature-verified and idempotent if Stripe is enabled.
- Metered usage sync is implemented if usage-based billing is enabled.
- Dashboard shows current plan, usage, quota, and invoices/portal when applicable.
- Admin/support can inspect usage, quota, subscription, provider request, and meter event state.
- Billing-affecting decisions are auditable.
```

---

## 33. Open questions

Decide before paid launch:

```text
1. Is pricing seat-based, review-credit-based, repo-based, or hybrid?
2. Are overages allowed automatically or only after opt-in?
3. Are draft PR reviews billable?
4. Are manual re-runs billable?
5. Does summary-only mode consume credits?
6. How many grace days after payment failure?
7. Should free-tier private repos be supported?
8. How should enterprise contract limits override self-serve limits?
9. Should usage data be exportable by customers?
10. How long should raw billing webhook payloads be retained?
```

Recommended defaults:

```text
1. Hybrid: subscription + included review credits + optional overage.
2. Overage opt-in for self-serve.
3. Draft PRs billable only if explicitly reviewed.
4. Manual re-runs billable after free retry window.
5. Summary-only not billable in MVP.
6. 7-14 day grace period.
7. Yes, but limited.
8. Enterprise overrides win.
9. Yes, CSV/JSON export for billing admins.
10. 90-180 days, with sanitized mirror retained longer.
```

---

## 34. External references checked

These references are useful when implementing the provider adapter. Always re-check provider docs during implementation because billing APIs and pricing can change.

```text
Stripe usage-based billing:
https://docs.stripe.com/billing/subscriptions/usage-based

Stripe billing meters:
https://docs.stripe.com/api/billing/meter

Stripe meter events:
https://docs.stripe.com/api/billing/meter-event

Stripe recording usage API:
https://docs.stripe.com/billing/subscriptions/usage-based/recording-usage-api

Stripe Customer Portal:
https://docs.stripe.com/customer-management

Stripe Checkout Sessions:
https://docs.stripe.com/api/checkout/sessions

Stripe Subscriptions:
https://docs.stripe.com/api/subscriptions

Stripe webhook signatures:
https://docs.stripe.com/webhooks/signature

Stripe idempotent requests:
https://docs.stripe.com/api/idempotent_requests

Stripe entitlements:
https://docs.stripe.com/billing/entitlements

OpenAI API pricing:
https://openai.com/api/pricing/

OpenAI Usage API and Cost API cookbook:
https://developers.openai.com/cookbook/examples/completions_usage_api
```
