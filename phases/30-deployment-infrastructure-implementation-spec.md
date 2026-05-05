# #30 Deployment and Infrastructure Implementation Spec

## Status

Proposed implementation spec for the Greptile-like code review system.

This document defines how to deploy, operate, scale, and recover the system described in the previous implementation specs:

```text
#0  Core contracts and shared types
#1  Monorepo and build system
#2  Database layer
#3  GitHub App integration
#4  Webhook ingestion
#5  API server
#6  Web dashboard
#7  Job queue and orchestration
#8  Repo sync and workspace manager
#9  Indexer boundary
#10 Index artifact schema
#11 TypeScript indexer implementation
#12 Index importer
#13 Embedding pipeline
#14 Retrieval engine
#15 PR snapshot and diff model
#16 Review orchestrator
#17 LLM gateway
#18 Review passes
#19 Finding validation, dedupe, and ranking
#20 Publisher
#21 Feedback and memory system
#22 Repo rules and configuration
#23 Static analysis integration
#24 Sandbox execution
#25 Observability
#26 Evaluation harness
#27 Security and compliance layer
#28 Usage and billing
#29 Admin/internal tooling
```

## Goal

Create deployment infrastructure that is:

```text
Fast enough for PR review latency
Simple enough for a small team to operate
Secure enough for private source code
Observable enough to debug bad reviews
Flexible enough to swap infrastructure later
Cost-aware enough to survive early growth
```

The recommended MVP production architecture is:

```text
AWS ECS/Fargate
  + RDS Postgres with pgvector
  + ElastiCache Redis
  + S3 artifacts
  + ECR images
  + Secrets Manager
  + KMS
  + ALB
  + CloudWatch/OpenTelemetry
  + Terraform
```

The recommended scale-up path is:

```text
MVP:
  ECS/Fargate API + worker services
  managed Postgres
  managed Redis
  S3 artifact storage
  ephemeral repo caches per worker task

Scale-up:
  specialized worker pools
  larger Fargate ephemeral storage
  Qdrant
  Temporal
  EC2/EKS index workers with persistent fast disks
  dedicated sandbox runner fleet

Enterprise:
  VPC deployment
  BYOK model providers
  customer-managed object storage
  self-hosted Kubernetes package
  private networking
  regional isolation
```

## Non-goals

This spec does not define:

```text
- application business logic
- review prompt design
- index artifact schema
- database schema details
- GitHub API implementation
- static-analysis tool adapters
- security policy internals
```

Those are covered in earlier sections.

This spec defines how the system runs.

---

# 1. Deployment principles

## 1.1 Treat infrastructure as product architecture

The infrastructure should reinforce the architecture:

```text
API service
  handles requests, auth, webhooks, settings, status

Worker services
  perform expensive asynchronous work

Database
  source of truth for durable state

Redis/BullMQ
  execution broker, not source of truth

S3/object storage
  immutable artifacts and replayable debug data

OpenTelemetry
  cross-service request/job/review visibility
```

## 1.2 Keep the API thin

The API service must not:

```text
- clone repositories
- index code
- run static-analysis tools
- call expensive LLM review passes
- publish long-running review workflows synchronously
- perform migrations at startup
```

The API service may:

```text
- validate requests
- verify GitHub webhook signatures
- enforce auth/RBAC
- read/write durable state
- enqueue jobs
- expose review state
- expose dashboard APIs
```

## 1.3 Use specialized workers

Do not run every job in one generic worker pool forever.

Minimum pools:

```text
api
web
worker-general
worker-index
worker-review
worker-embedding
worker-publisher
worker-maintenance
```

Later pools:

```text
worker-static-analysis
worker-sandbox
worker-memory
worker-evaluation
worker-admin-replay
worker-qdrant-sync
```

## 1.4 Postgres is the source of truth

Redis/BullMQ can lose transient job execution state and the product should recover.

Durable state lives in Postgres:

```text
webhook_events
background_jobs
review_runs
review_artifacts
repo_index_versions
embedding_jobs
publish_runs
usage_events
audit_logs
```

## 1.5 Artifacts are immutable

Large artifacts go to object storage:

```text
raw webhook payloads when retained
raw PR diffs
PR snapshots
index artifacts
retrieval context bundles
review pass outputs
validation reports
publish plans
redacted debug bundles
eval reports
```

Artifact identity:

```text
artifact_uri
artifact_hash
artifact_kind
artifact_schema_version
repo_id
org_id
review_run_id, when relevant
created_at
retention_policy
classification
```

## 1.6 Build for rollback

Every deploy should be able to roll back without corrupting durable state.

Rules:

```text
- database migrations are explicit deployment steps
- destructive migrations are delayed and feature-flagged
- new code can read old records
- old code can tolerate new optional columns where possible
- schema changes and code changes are split when needed
- job payload schema versions are preserved
```

---

# 2. Environment model

## 2.1 Environments

Use four environment types.

```text
local
preview
staging
production
```

### Local

Purpose:

```text
- developer iteration
- local API/web/worker
- fixture PR runs
- indexer tests
- DB migrations
```

Infrastructure:

```text
Docker Compose
Postgres + pgvector
Redis
MinIO or local S3-compatible storage
OpenTelemetry Collector optional
Mail sink optional
Fake GitHub adapter optional
Fake LLM provider optional
```

### Preview

Purpose:

```text
- per-branch UI/API smoke testing
- dashboard review
- contract/API compatibility checks
```

Infrastructure options:

```text
Option A: ephemeral container app environment
Option B: staging stack with preview namespace
Option C: web-only preview plus API staging
```

Recommendation:

```text
Use preview primarily for web/dashboard and API smoke tests.
Do not run expensive indexing/review infrastructure per branch at first.
```

### Staging

Purpose:

```text
- production-like smoke tests
- GitHub App staging installation
- staging webhooks
- deploy validation
- migrations rehearsal
- model/prompt rollout testing
```

Infrastructure:

```text
same topology as production
smaller sizes
separate GitHub App
separate DB
separate Redis
separate S3 bucket
separate secrets
separate model keys if possible
```

### Production

Purpose:

```text
real customer workloads
private source code
billing/usage
audit/compliance
```

Infrastructure:

```text
fully isolated account or at least isolated environment
production GitHub App
production database
production Redis
production artifact buckets
production observability
production secrets
```

## 2.2 Environment naming

Use consistent environment names:

```text
local
preview
staging
prod
```

Avoid ad hoc names like:

```text
dev2
prod-new
test-final
```

## 2.3 Region strategy

MVP:

```text
single region
```

Recommended default:

```text
us-east-1 or us-west-2
```

Choose based on:

```text
- customer base
- model provider latency
- GitHub latency
- managed service availability
- compliance requirements
```

Later:

```text
regional isolation per customer segment
multi-region read-only disaster recovery
active-passive failover
```

## 2.4 Account strategy

Recommended AWS account layout:

```text
root/management account
  ├── shared-services account
  ├── staging account
  └── production account
```

MVP acceptable:

```text
single AWS account with isolated VPCs, IAM roles, prefixes, and state
```

But for private source code, separate staging and production accounts are preferable.

---

# 3. Production topology

## 3.1 High-level topology

```text
Internet
  |
  v
Cloudflare / Route 53 / WAF optional
  |
  v
Application Load Balancer
  |                    \
  v                     v
web service          api service
                         |
                         | enqueue/read/write
                         v
                    Postgres + Redis
                         |
                         v
                    worker services
                         |
        +----------------+----------------+
        |                |                |
        v                v                v
    GitHub API       S3 artifacts       LLM providers
```

Private infrastructure:

```text
RDS Postgres
ElastiCache Redis
worker services
artifact access through IAM
secrets through Secrets Manager
```

Public endpoints:

```text
web dashboard
API routes required by dashboard
GitHub webhook endpoint
GitHub OAuth callback endpoint
health endpoint if exposed through ALB
```

## 3.2 Service topology

```text
ECS Cluster
  ├── web-service
  ├── api-service
  ├── worker-general-service
  ├── worker-index-service
  ├── worker-review-service
  ├── worker-embedding-service
  ├── worker-publisher-service
  ├── worker-maintenance-service
  └── otel-collector-service or sidecars
```

Optional later:

```text
  ├── worker-static-analysis-service
  ├── sandbox-runner-service
  ├── qdrant-service or managed Qdrant
  ├── temporal-worker-service
  └── temporal-cluster or managed Temporal
```

## 3.3 Public vs private placement

Public subnets:

```text
ALB
NAT gateways if used
```

Private subnets:

```text
ECS tasks
RDS
Redis
Qdrant if self-hosted
Temporal if self-hosted
OpenTelemetry Collector
```

ECS tasks should not have public IPs in production.

## 3.4 Network egress

Required egress destinations:

```text
GitHub API and git endpoints
model providers
S3/object storage
observability backend
package registries only for controlled build-time or sandbox cases
```

Runtime services should not require broad package registry egress except sandbox/static-analysis jobs that explicitly allow it.

Default policy:

```text
API, review, embedding, publisher workers:
  allow required outbound network

index workers:
  allow GitHub and object storage

sandbox/static-analysis workers:
  no network by default
  policy-controlled allowlist only when explicitly enabled
```

---

# 4. Service definitions

## 4.1 Web service

Purpose:

```text
TanStack Start dashboard
SSR routes
static assets
authenticated UI
```

Image:

```text
app-web:<git_sha>
```

Runtime:

```text
Bun or Node depending on TanStack Start production support and adapter choice
```

Inbound:

```text
ALB -> web-service
```

Outbound:

```text
api-service
optional auth provider
observability collector
```

Recommended resources:

```text
MVP staging:     0.25 vCPU, 512 MB
MVP production:  0.5 vCPU, 1 GB, min 2 tasks
```

Health checks:

```text
GET /healthz
GET /readyz
```

Readiness should verify:

```text
- server started
- config loaded
- can reach API if server-side API calls are required
```

It should not perform expensive checks.

## 4.2 API service

Purpose:

```text
Elysia API
GitHub webhooks
OAuth callbacks
settings API
review status API
admin APIs
```

Image:

```text
app-api:<git_sha>
```

Runtime:

```text
Bun + Elysia
```

Inbound:

```text
ALB -> api-service
GitHub webhooks -> api-service
web dashboard -> api-service
```

Outbound:

```text
Postgres
Redis
GitHub API
S3/object storage
Secrets Manager/KMS as needed
OpenTelemetry Collector
```

Recommended resources:

```text
MVP staging:     0.25-0.5 vCPU, 512 MB-1 GB
MVP production:  0.5-1 vCPU, 1-2 GB, min 2 tasks
```

Scale signals:

```text
CPU utilization
memory utilization
request latency
ALB request count per target
webhook queue lag
```

Health endpoints:

```text
GET /healthz
GET /readyz
```

`/healthz`:

```text
- returns process health
- no database dependency
```

`/readyz`:

```text
- database reachable
- Redis reachable if needed for enqueue path
- migrations compatible
- critical config present
```

Webhook route:

```text
POST /webhooks/github
```

Must support raw body signature verification.

## 4.3 Worker general service

Purpose:

```text
low-cost, mixed, non-hot-path jobs
installation sync
repo sync metadata
feedback normalization
usage rollups
admin maintenance jobs
```

Image:

```text
app-worker:<git_sha>
```

Runtime:

```text
Bun workers with BullMQ
Node fallback allowed by package-level script
```

Recommended resources:

```text
MVP staging:     0.25 vCPU, 512 MB
MVP production:  0.5 vCPU, 1 GB
```

Scale signals:

```text
queue depth
job age
CPU/memory
```

## 4.4 Worker index service

Purpose:

```text
repo checkout
indexer CLI execution
index artifact creation
index import
```

Image:

```text
app-worker-index:<git_sha>
```

Can be same image as worker with different entrypoint:

```text
bun apps/worker/src/main.ts --role index
```

Recommended resources:

```text
MVP staging:     1-2 vCPU, 2-4 GB, 50-100 GiB ephemeral storage
MVP production:  2-4 vCPU, 4-8 GB, 100-200 GiB ephemeral storage
```

This worker is CPU/disk intensive.

Important:

```text
- maintain per-task local mirror cache
- limit concurrent index jobs per task
- enforce disk quotas
- periodically cleanup old worktrees/mirrors
```

Fargate is acceptable early, but large repo performance may eventually require:

```text
EC2 worker fleet with local NVMe/EBS
or EKS node pool with fast local storage
or dedicated remote indexing service
```

## 4.5 Worker embedding service

Purpose:

```text
embedding_jobs
batch model embedding calls
write pgvector/Qdrant
record usage/cost
```

Recommended resources:

```text
MVP staging:     0.25-0.5 vCPU, 512 MB-1 GB
MVP production:  0.5-1 vCPU, 1-2 GB
```

This worker is network-bound and provider-rate-limit-bound.

Scale signals:

```text
embedding queue depth
embedding job age
provider rate-limit utilization
provider latency
cost budget remaining
```

## 4.6 Worker review service

Purpose:

```text
review orchestration
context retrieval
review passes
LLM gateway calls
finding validation
publish job planning
```

Recommended resources:

```text
MVP staging:     0.5-1 vCPU, 1-2 GB
MVP production:  1-2 vCPU, 2-4 GB
```

This worker is LLM/network-bound but can use CPU for diff/context packing.

Scale signals:

```text
review queue depth
oldest review job age
time to first review
LLM provider latency
LLM provider rate limits
token budget utilization
```

## 4.7 Worker publisher service

Purpose:

```text
publish inline comments
publish summaries
publish check runs
handle GitHub rate limits
reconcile publish state
```

Recommended resources:

```text
MVP staging:     0.25 vCPU, 512 MB
MVP production:  0.25-0.5 vCPU, 512 MB-1 GB
```

This worker is GitHub API-rate-limit-bound.

Scale signals:

```text
publish queue depth
publish failures
GitHub rate-limit remaining
secondary rate-limit incidents
```

## 4.8 Worker maintenance service

Purpose:

```text
outbox dispatch
job reconciliation
retention cleanup
usage rollups
scheduled reindexing
artifact deletion
backup checks
```

Recommended resources:

```text
MVP staging:     0.25 vCPU, 512 MB
MVP production:  0.5 vCPU, 1 GB
```

Run at least one task in production.

## 4.9 Sandbox runner service

MVP may run sandboxed static-analysis jobs in a dedicated worker pool.

Recommended deployment options:

```text
MVP local/staging:
  Docker runner on controlled hosts

MVP production, conservative:
  avoid running untrusted project commands until sandbox runner is hardened

Production+:
  dedicated EC2/EKS/gVisor/Firecracker sandbox fleet
```

Do not run Docker-in-Docker on general Fargate workers as the default production approach.

Sandbox infrastructure should be its own workstream because it has different security and kernel/isolation requirements.

---

# 5. Managed data services

## 5.1 Postgres

Recommended MVP:

```text
Amazon RDS PostgreSQL
pgvector extension enabled
Multi-AZ in production
automated backups enabled
point-in-time recovery enabled
private subnet only
```

Database roles:

```text
app_runtime
migration_runner
readonly_observer
admin_breakglass
```

Application should use least-privilege DB roles.

Connection settings:

```text
API and workers use pooled connections.
Use pgbouncer or RDS Proxy if connection count becomes a bottleneck.
```

Initial sizing guideline:

```text
staging:
  db.t4g.medium or equivalent

production MVP:
  db.m7g.large/r7g.large class depending on memory needs
  storage autoscaling enabled if available
  provisioned IOPS only when observed necessary
```

Required extensions:

```sql
create extension if not exists vector;
create extension if not exists pgcrypto;
```

Optional:

```sql
create extension if not exists pg_stat_statements;
```

Backup requirements:

```text
- automated backups with retention period
- manual snapshot before destructive migrations
- restore drill at least monthly once customers are onboarded
- PITR tested before enterprise customers
```

## 5.2 Redis

Recommended MVP:

```text
Amazon ElastiCache Redis or Valkey-compatible managed Redis
private subnet only
TLS if supported and practical
```

Usage:

```text
BullMQ queues
rate-limit counters
short-lived locks where acceptable
cache entries that are safe to lose
```

Not source of truth:

```text
No durable product state should live only in Redis.
```

Sizing:

```text
staging:
  small single-node instance

production MVP:
  replication group if availability matters
  memory alerts
  eviction policy chosen intentionally
```

Persistence:

```text
RDB/AOF optional depending on managed service support
Still rely on Postgres outbox/reconciliation for recovery
```

## 5.3 Object storage

Recommended MVP:

```text
Amazon S3
```

Buckets:

```text
app-artifacts-prod
app-artifacts-staging
app-logs-prod optional
app-eval-fixtures-prod optional
```

Artifact prefixes:

```text
org/{org_id}/repo/{repo_id}/index/{commit_sha}/...
org/{org_id}/repo/{repo_id}/pr/{pr_number}/review/{review_run_id}/...
org/{org_id}/usage/{year}/{month}/...
internal/evals/...
```

Bucket settings:

```text
- block public access
- server-side encryption with KMS
- versioning for critical buckets
- lifecycle retention by artifact class
- access logs optional
- object lock optional for audit/compliance tiers
```

Access:

```text
- services use IAM roles
- dashboard/API issues short-lived signed URLs only after authorization
- no public artifact URLs
```

## 5.4 Secrets

Recommended MVP:

```text
AWS Secrets Manager
```

Secrets:

```text
DATABASE_URL
REDIS_URL or Redis auth secret
GITHUB_APP_PRIVATE_KEY
GITHUB_WEBHOOK_SECRET
GITHUB_OAUTH_CLIENT_SECRET
OPENAI_API_KEY or model provider keys
STRIPE_SECRET_KEY if billing enabled
STRIPE_WEBHOOK_SECRET if billing enabled
INTERNAL_SESSION_SECRET
ARTIFACT_SIGNING_SECRET if needed
```

Rules:

```text
- never bake secrets into images
- never store secrets in Terraform state unless unavoidable
- prefer secret ARNs in task definitions
- rotate provider keys on schedule
- rotate immediately on suspected exposure
```

## 5.5 KMS

Use KMS keys for:

```text
S3 bucket encryption
RDS encryption
Secrets Manager encryption
possibly Fargate ephemeral storage encryption where applicable
```

Recommended key strategy:

```text
environment-level KMS keys for MVP
customer-level keys later for enterprise/BYOK
```

---

# 6. Container images

## 6.1 Image inventory

Recommended images:

```text
app-web
app-api
app-worker
app-indexer-cli optional if standalone
app-sandbox-runner optional
```

MVP can use one worker image:

```text
app-worker
```

with role-specific entrypoints:

```text
WORKER_ROLE=general
WORKER_ROLE=index
WORKER_ROLE=embedding
WORKER_ROLE=review
WORKER_ROLE=publisher
WORKER_ROLE=maintenance
```

## 6.2 Image tags

Use immutable tags:

```text
<git_sha>
<git_sha>-<build_number>
```

Avoid deploying mutable `latest` to production.

Useful tags:

```text
staging-<git_sha>
prod-<git_sha>
```

but task definitions should still pin the content digest or immutable tag.

## 6.3 Dockerfile principles

Rules:

```text
- multi-stage builds
- copy only required files
- run as non-root
- include only production dependencies
- include indexer CLI only where needed
- include CA certs
- include git only in worker images that need repo sync
- do not include package managers in runtime images unless needed
- no secrets in build args
```

Example API Dockerfile shape:

```dockerfile
FROM oven/bun:1 AS base
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json
RUN corepack enable && pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm turbo run build --filter=@app/api...

FROM oven/bun:1-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system app && adduser --system --ingroup app app
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/node_modules ./node_modules
USER app
CMD ["bun", "apps/api/dist/index.js"]
```

Actual implementation may use pnpm deploy, Turbo prune, or other pruning strategies from #1.

## 6.4 Worker image extras

Worker image may need:

```text
git
openssh-client only if SSH Git remotes are supported
ca-certificates
bash only if scripts require it
indexer-cli binary
static-analysis tools only in dedicated static-analysis image
```

Do not include all language toolchains in the general worker image.

Use dedicated images:

```text
worker-index
worker-static-ts
worker-static-python
worker-static-go
sandbox-base-node
sandbox-base-python
```

as the system matures.

---

# 7. Infrastructure as code

## 7.1 Recommended IaC tool

Use Terraform.

Reasons:

```text
- cloud-neutral enough for future portability
- strong AWS provider ecosystem
- readable modules
- stable CI workflow
- easier to hand off to infra engineers
```

## 7.2 Terraform directory structure

Recommended:

```text
/infra
  /terraform
    /modules
      /vpc
      /ecs-cluster
      /ecs-service
      /rds-postgres
      /redis
      /s3-artifacts
      /secrets
      /kms
      /alb
      /dns
      /iam
      /observability
      /github-oidc
      /waf
    /envs
      /staging
        main.tf
        variables.tf
        outputs.tf
        terraform.tfvars
        backend.tf
      /prod
        main.tf
        variables.tf
        outputs.tf
        terraform.tfvars
        backend.tf
```

Prefer separate environment directories and separate remote state.

Terraform workspaces can be useful, but environment directories with explicit backends are easier to reason about for production infrastructure.

## 7.3 Terraform state

Recommended:

```text
S3 remote backend
DynamoDB state locking or HCP Terraform remote state/locking
separate state per environment
restricted IAM access
```

State contains sensitive references and sometimes sensitive values.

Rules:

```text
- restrict state access
- encrypt state bucket
- enable bucket versioning
- do not output secrets
- do not commit tfvars containing secrets
```

## 7.4 Module boundaries

Each module should have narrow responsibility.

```text
vpc:
  subnets, route tables, security groups baseline

ecs-cluster:
  ECS cluster, capacity providers if needed

ecs-service:
  task definition, service, target group, autoscaling

rds-postgres:
  DB subnet group, parameter group, instance/cluster, backups

redis:
  subnet group, replication group, auth/TLS settings

s3-artifacts:
  buckets, lifecycle, KMS, bucket policy

secrets:
  secret resources, not secret values where possible

iam:
  service task roles, execution roles, GitHub OIDC deploy roles

alb:
  load balancer, listeners, rules, TLS certs

observability:
  collector service, log groups, dashboards/alarms if AWS-native
```

## 7.5 GitHub Actions to AWS auth

Recommended:

```text
GitHub Actions OIDC -> AWS IAM role
```

Avoid long-lived AWS access keys in GitHub secrets.

Deploy role permissions:

```text
- push images to ECR
- register ECS task definitions
- update ECS services
- run migration task
- read required secrets metadata, not secret values unless needed
```

Terraform role permissions:

```text
separate from deploy role
used only by infra pipeline or approved humans
```

---

# 8. Local development infrastructure

## 8.1 Docker Compose services

Local Compose should provide:

```text
postgres
redis
minio or localstack
otel-collector optional
mailpit optional
qdrant optional later
```

Example `compose.yaml`:

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
    ports:
      - "5432:5432"
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: app
      POSTGRES_DB: app
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app -d app"]
      interval: 5s
      timeout: 5s
      retries: 10

  redis:
    image: redis:7
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 10

  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    ports:
      - "9000:9000"
      - "9001:9001"
    environment:
      MINIO_ROOT_USER: minio
      MINIO_ROOT_PASSWORD: minio123
    volumes:
      - minio-data:/data
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:9000/minio/health/live"]
      interval: 5s
      timeout: 5s
      retries: 10

volumes:
  postgres-data:
  minio-data:
```

Optional app services can be added, but for developer iteration it is usually better to run app processes directly:

```text
pnpm dev:api
pnpm dev:web
pnpm dev:worker
```

with Docker Compose only for dependencies.

## 8.2 Local environment file

`.env.local`:

```bash
APP_ENV=local
APP_BASE_URL=http://localhost:3000
API_BASE_URL=http://localhost:4000
DATABASE_URL=postgres://app:app@localhost:5432/app
REDIS_URL=redis://localhost:6379
OBJECT_STORAGE_ENDPOINT=http://localhost:9000
OBJECT_STORAGE_BUCKET=app-artifacts-local
OBJECT_STORAGE_ACCESS_KEY_ID=minio
OBJECT_STORAGE_SECRET_ACCESS_KEY=minio123
GITHUB_APP_ID=
GITHUB_APP_PRIVATE_KEY=
GITHUB_WEBHOOK_SECRET=local-webhook-secret
OPENAI_API_KEY=
LLM_PROVIDER=fake
EMBEDDING_PROVIDER=fake
```

Do not commit real secrets.

## 8.3 Local GitHub webhooks

Options:

```text
ngrok
cloudflared tunnel
smee.io for simple webhook relay
```

Recommended for staging-level testing:

```text
use a separate staging GitHub App pointed at staging API
```

Local webhook testing should also be possible with stored fixture payloads:

```bash
pnpm dev webhook:replay fixtures/webhooks/pull_request.opened.json
```

## 8.4 Local reset commands

Useful commands:

```bash
pnpm infra:up
pnpm infra:down
pnpm infra:reset
pnpm db:migrate
pnpm db:seed
pnpm worker:dev
pnpm api:dev
pnpm web:dev
pnpm eval:smoke
```

---

# 9. CI/CD pipeline

## 9.1 CI stages

CI should run on pull requests:

```text
install dependencies
format check
lint
unit tests
contract/schema tests
typecheck
build packages
build apps
DB migration check
docker build smoke optional
small eval smoke optional
```

Recommended PR CI:

```text
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm db:migration-check
pnpm eval:smoke
```

## 9.2 Image build pipeline

On merge to main:

```text
checkout
install dependencies
run CI checks
build app images
push images to ECR
record image digests
```

Images:

```text
app-web:<git_sha>
app-api:<git_sha>
app-worker:<git_sha>
```

Optional:

```text
app-indexer:<git_sha>
app-sandbox:<git_sha>
```

## 9.3 Staging deployment

Staging deploy flow:

```text
build images
push images
run migration task against staging
update ECS services
wait for stability
run smoke tests
run staging GitHub webhook smoke if safe
```

Smoke tests:

```text
GET /healthz
GET /readyz
login callback route exists
web dashboard loads
worker can connect to Redis
worker can connect to Postgres
artifact bucket write/read/delete test
fake review fixture job completes
```

## 9.4 Production deployment

Production deploy flow:

```text
manual approval or protected branch deploy
verify staging passed
create pre-migration DB snapshot when required
run migration task
update API/web services
update low-risk workers
update index/review workers
monitor SLO dashboards
```

Recommended deployment strategy:

```text
rolling ECS service updates for MVP
blue/green later for API/web if needed
worker canaries for risky review/indexer changes
```

Worker deployment caution:

```text
New workers may pick up old jobs.
Old workers may pick up new jobs during rolling deploy.
```

Therefore:

```text
- job payloads must be versioned
- handlers must reject unsupported versions gracefully
- queues should support draining/canary if needed
```

## 9.5 Database migration pipeline

Rules:

```text
- migrations run as one-off task, not app startup
- migration task uses migration_runner role
- migration logs are retained
- migration failure blocks deployment
- destructive migrations require manual approval
```

Safe migration phases:

```text
Phase A: add nullable columns / new tables / new indexes concurrently where possible
Phase B: deploy code that writes both old and new if needed
Phase C: backfill asynchronously
Phase D: switch readers
Phase E: remove old fields after retention window
```

## 9.6 Rollback process

Application rollback:

```text
update ECS service back to previous task definition
verify health
monitor errors
```

Database rollback:

```text
avoid requiring DB rollback
prefer forward fixes
restore from snapshot only for severe corruption
```

Queue rollback:

```text
pause problematic queues
stop affected worker pool
deploy previous worker task definition
requeue failed jobs if safe
```

Prompt/model rollback:

```text
use config/prompt version flags
roll back prompt version without full deploy where possible
```

---

# 10. Runtime configuration

## 10.1 Config model

Use typed environment config from `/packages/config`.

Rules:

```text
- validate at process startup
- fail fast if required config is missing
- include service name and environment
- never log raw secrets
- use secret references in task definitions
```

## 10.2 Common environment variables

```bash
APP_ENV=prod
SERVICE_NAME=api
SERVICE_VERSION=<git_sha>
PUBLIC_WEB_URL=https://app.example.com
PUBLIC_API_URL=https://api.example.com
DATABASE_URL=...
REDIS_URL=...
ARTIFACT_BUCKET=app-artifacts-prod
ARTIFACT_REGION=us-east-1
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
LOG_LEVEL=info
```

## 10.3 GitHub config

```bash
GITHUB_APP_ID=...
GITHUB_APP_CLIENT_ID=...
GITHUB_APP_PRIVATE_KEY_SECRET_ARN=...
GITHUB_WEBHOOK_SECRET_ARN=...
GITHUB_OAUTH_CLIENT_SECRET_ARN=...
GITHUB_APP_SLUG=...
```

## 10.4 Queue config

```bash
QUEUE_REDIS_URL=...
QUEUE_PREFIX=prod
WORKER_ROLE=review
WORKER_CONCURRENCY=4
WORKER_SHUTDOWN_GRACE_MS=30000
```

## 10.5 LLM config

```bash
LLM_PROVIDER=openai
LLM_DEFAULT_MODEL=...
LLM_REVIEW_MODEL=...
LLM_SUMMARY_MODEL=...
LLM_TIMEOUT_MS=60000
LLM_MAX_RETRIES=2
LLM_DAILY_BUDGET_CENTS=...
```

Provider keys should come from Secrets Manager, not plain env in Terraform.

## 10.6 Repo sync config

```bash
REPO_CACHE_DIR=/var/app/repo-cache
WORKSPACE_DIR=/var/app/workspaces
REPO_CACHE_MAX_BYTES=80000000000
WORKSPACE_MAX_BYTES=20000000000
GIT_FETCH_TIMEOUT_MS=120000
GIT_CHECKOUT_TIMEOUT_MS=120000
GIT_LFS_SKIP_SMUDGE=1
```

On Fargate, ensure ephemeral storage is sized for these directories.

---

# 11. Networking and DNS

## 11.1 Domains

Recommended:

```text
app.example.com       web dashboard
api.example.com       API + webhooks
```

Alternative:

```text
example.com           web
example.com/api       API
example.com/webhooks  webhooks
```

Separate API/web domains are easier to reason about and route.

## 11.2 TLS

Use managed TLS certificates:

```text
AWS ACM for ALB
Cloudflare TLS if using Cloudflare front door
```

Production should redirect HTTP to HTTPS.

## 11.3 ALB routes

Example:

```text
app.example.com/*
  -> web target group

api.example.com/*
  -> api target group
```

Optional same-domain routing:

```text
app.example.com/api/*
  -> api target group

app.example.com/webhooks/*
  -> api target group

app.example.com/*
  -> web target group
```

## 11.4 Security groups

ALB:

```text
inbound 443 from internet
outbound to web/api target groups
```

web service:

```text
inbound from ALB only
outbound to API/observability if needed
```

api service:

```text
inbound from ALB only
outbound to Postgres, Redis, S3, GitHub, model providers, observability
```

workers:

```text
no inbound except health/metrics if internal
outbound to Postgres, Redis, S3, GitHub/model providers as required by role
```

Postgres:

```text
inbound from API/workers/migration task only
no public access
```

Redis:

```text
inbound from API/workers only
no public access
```

## 11.5 WAF and DDoS

MVP optional but recommended once public:

```text
AWS WAF on ALB or Cloudflare front door
rate limits for auth endpoints
allow broad GitHub webhook ingress but verify signatures in app
block obvious malicious traffic
```

Do not rely on IP allowlists alone for GitHub webhook security. Signature verification is mandatory.

---

# 12. IAM and permissions

## 12.1 Task execution role vs task role

Use separate roles:

```text
ECS task execution role:
  pull ECR images
  write logs
  fetch secrets injected by ECS

Application task role:
  application runtime permissions
  S3 artifact bucket access
  Secrets Manager reads if app fetches at runtime
  KMS decrypt for required keys
```

## 12.2 Per-service task roles

Recommended roles:

```text
api-task-role
web-task-role
worker-general-task-role
worker-index-task-role
worker-review-task-role
worker-embedding-task-role
worker-publisher-task-role
worker-maintenance-task-role
migration-task-role
```

This allows least privilege.

Examples:

```text
worker-publisher:
  no S3 write needed except publish artifacts if applicable
  no model provider secrets unless publishing uses LLM, which it should not

worker-embedding:
  embedding provider key
  vector DB access
  usage write access

worker-index:
  GitHub installation token access through app key path
  S3 artifact write
  no LLM provider key required
```

## 12.3 S3 IAM policy pattern

Scope object access by bucket and prefix where possible.

MVP role can access:

```text
arn:aws:s3:::app-artifacts-prod
arn:aws:s3:::app-artifacts-prod/*
```

Later, use finer-grained conditions:

```text
prefix-based access
customer buckets
separate sensitive artifact buckets
```

## 12.4 Deployment IAM

GitHub Actions deploy role can:

```text
- push images to ECR
- register ECS task definitions
- update ECS services
- run ECS migration tasks
- read non-secret outputs
```

It should not:

```text
- read customer artifacts
- read model provider secrets
- access production database directly
```

---

# 13. Storage and filesystem strategy

## 13.1 Repo cache storage

The repo sync system wants bare mirror caches.

Options:

```text
Option A: Fargate ephemeral local cache
Option B: EFS shared cache
Option C: EC2/EBS persistent worker cache
Option D: S3-backed pack/artifact cache
```

Recommendation:

```text
MVP: Fargate ephemeral local cache per index worker task.
Scale-up: EC2/EKS index workers with persistent fast disk.
```

Why:

```text
Fargate is operationally simple.
Ephemeral cache is good enough for early use.
Git workloads often benefit from local disk.
Shared network filesystems can simplify persistence but may hurt Git performance.
```

## 13.2 Fargate ephemeral storage

Configure larger ephemeral storage for index workers.

Recommended:

```text
index worker: 100-200 GiB
review worker: 20-50 GiB if it checks out files
api/web: default
publisher/embedding: default
```

## 13.3 Cleanup policy

Worker cleanup jobs should enforce:

```text
max cache size
max workspace size
max artifact temp size
max age
max orphaned worktrees
```

Cleanup schedule:

```text
on worker startup
before starting a large job
after job completion
periodic maintenance loop
```

## 13.4 Object artifact retention

Default retention classes:

```text
critical_audit:
  1-7 years depending on compliance

review_debug:
  30-180 days depending on plan

index_artifact:
  30-90 days after no longer active

raw_prompt_response:
  disabled by default or short retention with redaction

eval_fixture:
  indefinite if explicitly imported and sanitized
```

Use lifecycle rules to expire old artifacts.

---

# 14. Autoscaling strategy

## 14.1 API/web scaling

Scale API/web by:

```text
CPU
memory
request count per target
p95 latency
```

Minimum production tasks:

```text
web: 2
api: 2
```

Staging can run 1.

## 14.2 Worker scaling

Scale workers by queue metrics:

```text
queue depth
oldest job age
active jobs
failed jobs
```

Recommended targets:

```text
review queue oldest age < 2 minutes for normal load
publish queue oldest age < 1 minute
embedding queue oldest age < 10 minutes unless backfilling
index queue oldest age depends on repo size and plan
```

## 14.3 Specialized autoscaling policies

Worker index:

```text
scale slowly
higher CPU/disk
limit concurrency per task
avoid aggressive scale-in while jobs are running
```

Worker review:

```text
scale by review queue age
also cap by model provider rate limits and cost budget
```

Worker embedding:

```text
scale by embedding queue depth
cap by provider rate limits
batch aggressively
```

Worker publisher:

```text
scale modestly
cap by GitHub rate limits
```

## 14.4 Scale-to-zero

For production:

```text
Do not scale API/web to zero.
Workers can scale down to low min counts, but maintenance should remain available.
```

For staging:

```text
Workers can scale to zero if outbox dispatcher can wake or scheduled jobs can restart them.
```

## 14.5 Cost-aware limits

Hard caps:

```text
max tasks per worker pool
max concurrent reviews per org
max concurrent index jobs per org
max daily LLM spend per org/plan
max embedding backfill spend per org/plan
```

Infrastructure should expose these as config and runtime policy.

---

# 15. Observability deployment

## 15.1 OpenTelemetry architecture

Recommended:

```text
app services emit OTLP
  -> OpenTelemetry Collector
  -> metrics/traces/logs backend
```

MVP backends:

```text
Option A: CloudWatch + X-Ray/AWS-native
Option B: Grafana Cloud
Option C: Datadog
Option D: self-hosted Prometheus/Grafana/Tempo for staging only
```

## 15.2 Collector deployment

ECS options:

```text
Option A: sidecar collector per task
Option B: centralized collector ECS service
Option C: AWS Distro for OpenTelemetry collector
```

Recommendation:

```text
Use centralized collector service for MVP simplicity.
Use sidecars only when per-task isolation/export reliability is needed.
```

## 15.3 Required dashboards

Production dashboards:

```text
API health
web health
queue health
worker health
review latency
index latency
embedding latency/cost
LLM latency/cost
GitHub API health
Postgres health
Redis health
artifact storage errors
deployment health
```

## 15.4 Required alerts

Alerts:

```text
API 5xx rate high
API p95 latency high
web unavailable
GitHub webhook ingestion failures
webhook queue lag high
review queue oldest age high
publisher failures high
index worker disk usage high
Postgres CPU/storage/connections high
Redis memory high
LLM provider errors high
cost budget exceeded
artifact write failures
migration failure
```

## 15.5 Log retention

Suggested:

```text
staging logs: 7-14 days
production logs: 30-90 days depending on plan/compliance
security/audit logs: 1 year+ depending on requirements
```

Never rely on logs for replay. Use artifacts.

---

# 16. Health checks and readiness

## 16.1 Health endpoint semantics

`/healthz`:

```text
process alive
no external dependency checks
safe for frequent polling
```

`/readyz`:

```text
process ready to receive production traffic
checks critical dependencies
```

`/startupz` optional:

```text
startup completed
migrations compatible
required config present
```

## 16.2 Worker health

Workers need health beyond HTTP.

Expose:

```text
worker process alive
Redis connected
Postgres connected
handler registry loaded
currently active jobs
oldest active job age
shutdown state
```

Options:

```text
HTTP health server inside worker task
periodic heartbeat row in Postgres
BullMQ worker events
CloudWatch/ECS health checks
```

Recommendation:

```text
Use lightweight HTTP health for ECS plus Postgres heartbeat for operational debugging.
```

## 16.3 Graceful shutdown

All services must handle SIGTERM.

API/web:

```text
stop accepting new requests
finish in-flight requests up to grace period
close DB/Redis connections
exit
```

Workers:

```text
pause worker
stop taking new jobs
finish active jobs or checkpoint/release safely
extend locks if supported
mark long job interrupted if required
exit before ECS hard timeout
```

Review/index jobs must be idempotent so interrupted jobs can retry.

---

# 17. Disaster recovery and backups

## 17.1 Recovery objectives

Initial suggested targets:

```text
RPO: 24 hours for MVP, improve to <= 1 hour once paid customers exist
RTO: 4-8 hours for MVP, improve to <= 1-2 hours for enterprise
```

Adjust by customer commitments.

## 17.2 Postgres backups

Required:

```text
automated backups
PITR
manual snapshot before high-risk migrations
restore drill
backup retention policy
```

Restore drill should verify:

```text
can restore DB to isolated environment
can run migrations if needed
can start app against restored DB
can inspect review runs/artifacts
```

## 17.3 Object storage backup

Use:

```text
versioning for important buckets
lifecycle rules
optional cross-region replication for enterprise
```

For MVP, S3 durability is usually enough, but deletion bugs are still possible.

Mitigations:

```text
- delayed deletion workflow
- lifecycle rules instead of app hard-delete where possible
- object versioning
- audit logs for deletion
```

## 17.4 Redis recovery

Redis is not source of truth.

If Redis is lost:

```text
- recreate Redis
- maintenance worker scans Postgres background_jobs/outbox
- re-enqueue pending/runnable jobs
- workers resume
```

This must be tested.

## 17.5 Region outage plan

MVP:

```text
manual restore into another region from DB snapshot/artifacts
```

Later:

```text
cross-region DB replica or backup replication
cross-region artifact replication
DNS failover
pre-provisioned standby infrastructure
```

---

# 18. Security infrastructure

## 18.1 Baseline controls

Production must have:

```text
private subnets for stateful services
no public RDS/Redis
least-privilege IAM roles
Secrets Manager for secrets
KMS encryption
TLS for public traffic
security group restrictions
artifact bucket public access blocked
no secrets in logs
WAF or front-door protection once public
```

## 18.2 Build supply chain

Required:

```text
lockfile-enforced installs
container image scanning
dependency vulnerability scanning
SBOM generation optional but recommended
signed images optional later
protected deploy branches
OIDC-based cloud auth
```

## 18.3 Runtime hardening

Containers:

```text
run as non-root
read-only filesystem where practical
drop Linux capabilities where practical
no Docker socket mounted
minimal base image
no SSH server
```

Workers that need writable storage:

```text
explicit writable directories only
/tmp
repo cache
workspace dir
artifact temp dir
```

## 18.4 Artifact access

API should authorize every artifact read.

Flow:

```text
user requests artifact view
API checks org/repo permission
API checks artifact classification/retention
API creates short-lived signed URL or streams redacted artifact
access event is audited
```

No dashboard should link raw S3 object paths directly.

---

# 19. Production GitHub App setup

## 19.1 Separate apps

Use separate GitHub Apps:

```text
local/dev app optional
staging app
production app
```

Reasons:

```text
- separate webhook secrets
- separate callback URLs
- separate installation records
- safer testing
- no staging comments on production repos
```

## 19.2 Production URLs

```text
Webhook URL:
  https://api.example.com/webhooks/github

Callback URL:
  https://api.example.com/auth/github/callback

Setup URL:
  https://app.example.com/install/github
```

## 19.3 Webhook secret rotation

Support:

```text
current secret
previous secret during rotation window
```

Rotate by:

```text
store new secret
update GitHub App setting
accept both old/new temporarily
remove old secret
```

## 19.4 Private key rotation

Support multiple private keys if GitHub allows active overlap operationally.

Application config should identify active key and allow safe deployment during rotation.

---

# 20. Deployment runbooks

## 20.1 First production deploy

Checklist:

```text
1. Provision prod infrastructure with Terraform.
2. Create production GitHub App.
3. Store GitHub secrets/private key in Secrets Manager.
4. Run DB migrations.
5. Deploy API/web workers with fake provider disabled/enabled as intended.
6. Verify /healthz and /readyz.
7. Verify dashboard login.
8. Install GitHub App on test org/repo.
9. Trigger test PR review in production test repo.
10. Verify webhook event, review run, artifacts, comments, logs, metrics.
11. Verify retention cleanup dry run.
12. Verify backup is enabled.
13. Verify rollback task definition exists.
```

## 20.2 Normal deploy

```text
1. CI green.
2. Build/push immutable images.
3. Deploy staging.
4. Run staging smoke tests.
5. Review migration plan.
6. Approve production deploy.
7. Run production migrations.
8. Deploy API/web.
9. Deploy worker pools gradually.
10. Monitor dashboards for 30-60 minutes.
```

## 20.3 Emergency rollback

```text
1. Identify affected service or worker pool.
2. Pause affected queues if needed.
3. Revert ECS service to previous task definition.
4. Resume queues when safe.
5. Requeue failed jobs if idempotent.
6. Open incident record.
7. Preserve debug artifacts.
```

## 20.4 Redis loss recovery

```text
1. Recreate/restore Redis service.
2. Stop workers temporarily if needed.
3. Run background job reconciliation.
4. Re-enqueue pending jobs from Postgres.
5. Start workers.
6. Monitor duplicate job prevention/idempotency.
```

## 20.5 Database restore drill

```text
1. Restore latest backup to isolated staging-like DB.
2. Point temporary app environment to restored DB.
3. Run readonly validation queries.
4. Verify review runs, findings, artifacts references.
5. Verify migrations can run.
6. Document restore time and failures.
```

---

# 21. Terraform resources checklist

## 21.1 Network

```text
VPC
public subnets
private subnets
route tables
NAT gateway or egress strategy
security groups
VPC endpoints for S3/Secrets Manager where useful
```

## 21.2 Compute

```text
ECS cluster
ECR repositories
ALB
target groups
listeners
listener rules
ECS task definitions
ECS services
service autoscaling policies
CloudWatch log groups
```

## 21.3 Data

```text
RDS Postgres
DB subnet group
DB parameter group
DB security group
ElastiCache Redis
Redis subnet group
Redis parameter group
S3 artifact buckets
KMS keys
```

## 21.4 Identity/security

```text
IAM task execution roles
IAM task roles per service
GitHub Actions OIDC provider
GitHub Actions deploy role
Terraform execution role
Secrets Manager secrets
KMS key policies
WAF optional
```

## 21.5 Observability

```text
OpenTelemetry Collector service
CloudWatch alarms
dashboards
log retention policies
SNS/PagerDuty/Slack alert destinations
```

---

# 22. ECS service configuration checklist

For each service:

```text
name
environment
image digest
task CPU/memory
ephemeral storage
task execution role
task role
secrets
environment variables
log group
health check
container port if applicable
security group
subnets
desired count
min/max count
autoscaling policy
deployment circuit breaker
rollback enabled
```

## 22.1 API ECS service

```text
public behind ALB
min count 2 prod
health path /readyz
short shutdown grace
```

## 22.2 Worker ECS services

```text
private only
no ALB unless health endpoint needed
role-specific env
role-specific concurrency
role-specific IAM
role-specific CPU/memory/storage
```

## 22.3 Migration ECS task

```text
one-off task
migration_runner DB role
not a long-running service
logs retained
manual/protected execution in prod
```

---

# 23. Kubernetes migration path

Do not start with Kubernetes unless the team already wants to operate it.

Use Kubernetes/EKS when:

```text
- many specialized worker pools
- custom queue-based autoscaling with KEDA
- sandbox runners need node isolation
- index workers need local PVs/node affinity
- Qdrant/Temporal/self-hosted systems become central
- enterprise self-hosted deployment is required
```

Kubernetes mapping:

```text
web-service              -> Deployment + Service + Ingress
api-service              -> Deployment + Service + Ingress
worker pools             -> Deployments or ScaledObjects
index workers            -> Deployment/StatefulSet with node pool/storage
sandbox runners          -> isolated node pool/runtime class
Postgres                 -> managed RDS still preferred
Redis                    -> managed ElastiCache still preferred
S3                       -> S3 still preferred
OpenTelemetry Collector  -> DaemonSet/Gateway deployment
```

Kubernetes autoscaling:

```text
API/web:
  HPA by CPU/memory/RPS

workers:
  KEDA by Redis/BullMQ queue depth or custom metrics

index/sandbox:
  dedicated node pools
```

Self-hosted enterprise package can later use:

```text
Helm chart
Kustomize overlays
external Postgres/Redis/S3-compatible storage
customer-provided secrets
customer-provided model provider keys
```

---

# 24. Performance-specific infrastructure notes

## 24.1 Repo indexing performance

The index worker is the first infra area likely to need specialization.

Bottlenecks:

```text
git fetch latency
checkout time
disk I/O
parser CPU
artifact writing
DB import throughput
embedding backlog
```

MVP mitigations:

```text
- local mirror cache per running worker task
- large Fargate ephemeral storage
- limit concurrent index jobs per worker
- content-hash reuse
- streaming artifacts
- batch DB inserts
```

Scale mitigations:

```text
- EC2/EKS index workers with local NVMe/EBS
- remote high-performance indexer service
- persistent mirror cache
- object-storage artifact cache
- Rust indexer CLI
- COPY-based importer
```

## 24.2 Review latency

End-to-end review latency depends on:

```text
webhook ingestion time
index availability
embedding availability
retrieval latency
LLM latency
validation latency
GitHub publish latency
```

Infra mitigations:

```text
- pre-index enabled repos on installation
- incremental index by content hash
- keep review workers warm
- use model gateway rate limits
- scale review workers by queue age
- separate publisher workers
```

## 24.3 Embedding cost/latency

Mitigations:

```text
- batch embeddings
- cache by input hash/profile/model
- use separate embedding worker pool
- backfill in low-priority queues
- enforce org-level budgets
```

## 24.4 Artifact and DB import performance

Mitigations:

```text
- stream JSONL artifacts
- batch inserts
- use COPY when Drizzle batch inserts become slow
- avoid one DB transaction for extremely large repos if it causes lock/timeout issues
- store raw artifacts in S3, not DB
```

---

# 25. Cost management

## 25.1 Main cost centers

```text
LLM review calls
embedding calls
Postgres compute/storage
Fargate workers
NAT egress
S3 storage
observability ingestion
GitHub/API retries due to failures
```

## 25.2 Cost controls

```text
per-org review concurrency limits
per-org daily/monthly token budgets
max PR size before summary-only mode
max files before degraded mode
max comments per PR
embedding backfill budget
worker max autoscaling limits
artifact retention limits
sampling for traces/logs
```

## 25.3 NAT gateway caution

NAT gateways can become a meaningful cost source.

Mitigations:

```text
VPC endpoints for S3 and AWS services where useful
avoid unnecessary package downloads at runtime
keep sandbox dependency installation controlled
monitor NAT data processing costs
```

## 25.4 Staging cost controls

```text
smaller DB/Redis
lower worker min counts
scheduled off-hours scale-down
fake LLM/embedding providers by default for tests
short artifact retention
```

---

# 26. Release and feature flags

## 26.1 Feature flag categories

```text
infra flags:
  use_qdrant
  use_temporal
  use_remote_indexer
  use_sandbox_runner

review flags:
  enable_security_pass
  enable_test_pass
  enable_architecture_pass
  enable_static_tools

publishing flags:
  publish_inline_comments
  publish_summary
  publish_check_run

model flags:
  prompt_version
  review_model_profile
  embedding_model_profile
```

## 26.2 Flag storage

Use:

```text
repository_settings
org_settings
environment config
feature flag provider optional later
```

Feature flags should be included in review artifacts:

```text
ReviewPolicySnapshot
ReviewRun metadata
LLMCall metadata
```

## 26.3 Safe rollout

Rollout dimensions:

```text
internal repos
staging orgs
single production org
percentage of repos
plan tier
language
review mode
```

---

# 27. Testing infrastructure

## 27.1 Infra smoke tests

After deploy:

```text
API health
web health
DB connectivity
Redis connectivity
S3 write/read/delete
queue enqueue/dequeue
worker heartbeat
LLM fake call
embedding fake call
GitHub webhook signature fixture
artifact signed URL auth
```

## 27.2 End-to-end staging test

```text
1. Create/modify test PR in staging repo.
2. GitHub webhook delivered.
3. webhook_event row created.
4. review job created.
5. repo indexed or reused.
6. context bundle created.
7. fake or real review pass runs.
8. publish plan created.
9. staging comment or check run published.
10. dashboard shows review run.
```

## 27.3 Load tests

MVP load tests:

```text
webhook ingestion burst
API dashboard request burst
queue worker throughput
index fixture large repo
embedding batch throughput with fake provider
review worker with fake LLM
publisher with fake GitHub adapter
```

Do not load test GitHub/model providers aggressively without respecting provider terms/rate limits.

---

# 28. Implementation sequence

## PR 1: Local infrastructure

Deliver:

```text
compose.yaml with Postgres + pgvector, Redis, MinIO
.env.example updates
infra scripts
health check docs
local reset commands
```

Acceptance:

```text
pnpm infra:up starts dependencies
pnpm db:migrate works
api/worker can connect locally
```

## PR 2: Docker images

Deliver:

```text
Dockerfile.web
Dockerfile.api
Dockerfile.worker
image build scripts
non-root runtime user
basic container smoke tests
```

Acceptance:

```text
images build from clean checkout
containers start with local env
health checks pass
```

## PR 3: Terraform skeleton

Deliver:

```text
infra/terraform/modules skeleton
envs/staging
envs/prod
remote state config docs
provider config
common variables
```

Acceptance:

```text
terraform validate passes
module interfaces documented
```

## PR 4: Core AWS infrastructure

Deliver:

```text
VPC
subnets
security groups
ECR
KMS
S3 artifact buckets
Secrets Manager secret placeholders
```

Acceptance:

```text
terraform apply creates base infra in staging
bucket public access blocked
KMS configured
```

## PR 5: Data services

Deliver:

```text
RDS Postgres
pgvector extension migration path
ElastiCache Redis
DB/Redis security groups
backup settings
```

Acceptance:

```text
migration task can connect
app task can connect
no public DB/Redis access
```

## PR 6: ECS API/web deployment

Deliver:

```text
ECS cluster
ALB
web service
api service
TLS/DNS staging
health checks
logs
```

Acceptance:

```text
staging web loads
staging API ready
ALB health green
```

## PR 7: ECS worker deployment

Deliver:

```text
worker services by role
task roles
queue config
ephemeral storage for index worker
health/heartbeat
```

Acceptance:

```text
worker heartbeat visible
test job completes
index worker has expected disk capacity
```

## PR 8: CI/CD deploy pipeline

Deliver:

```text
GitHub Actions OIDC
image build/push
staging deploy
migration task
smoke tests
manual prod approval placeholder
```

Acceptance:

```text
merge to main deploys staging
smoke tests pass
```

## PR 9: Observability deployment

Deliver:

```text
OpenTelemetry Collector
log groups
baseline dashboards
baseline alerts
service version attributes
```

Acceptance:

```text
API traces visible
worker job traces visible
queue metrics visible
alerts configured
```

## PR 10: Production hardening

Deliver:

```text
production environment
production secrets
production GitHub App config
backup checks
rollback runbook
retention policies
WAF/front-door optional
```

Acceptance:

```text
production test repo PR review completes
restore drill planned/documented
rollback tested in staging
```

---

# 29. MVP cut

Implement for MVP:

```text
- Docker Compose local dependencies
- Docker images for web/api/worker
- Terraform base modules
- staging ECS/Fargate environment
- production ECS/Fargate environment
- RDS Postgres with pgvector
- ElastiCache Redis
- S3 artifact bucket
- Secrets Manager
- KMS
- ALB + TLS + DNS
- ECS services for web/api/workers
- role-specific worker services
- index worker with enlarged ephemeral storage
- GitHub Actions build/deploy pipeline
- one-off migration task
- health/readiness endpoints
- basic autoscaling
- basic dashboards/alerts
- backup configuration
- rollback runbook
```

Defer:

```text
- Kubernetes/EKS
- Temporal cluster
- Qdrant production cluster
- gVisor/Firecracker sandbox fleet
- multi-region active/passive
- customer-managed keys
- self-hosted enterprise chart
- advanced blue/green deploys
- full WAF tuning
- image signing/SBOM enforcement
```

---

# 30. Definition of done

#30 is done when:

```text
Local:
  - developers can run Postgres/Redis/object storage locally
  - API/web/worker can run locally against local dependencies
  - migrations run locally

Staging:
  - staging infra is created by Terraform
  - staging images deploy automatically from main
  - staging migration task runs before deploy
  - staging health checks pass
  - staging GitHub App can process a test PR

Production:
  - production infra is created by Terraform
  - production has isolated secrets and GitHub App
  - production DB/Redis are private
  - production S3 artifacts are encrypted and private
  - production API/web are behind TLS
  - worker pools run with least-privilege roles
  - review/index/publish jobs can complete end-to-end
  - alerts and dashboards exist
  - backups are enabled
  - rollback runbook exists and has been tested in staging

Operational:
  - no secrets are committed or baked into images
  - deployments use immutable image tags
  - migration failures block deployment
  - Redis loss can be recovered from Postgres job state
  - artifact access is authorized and audited
  - costs are visible at service/category level
```

---

# 31. Open questions

Resolve during implementation:

```text
1. Which AWS region is primary?
2. Will web deploy inside ECS or to a frontend platform/CDN?
3. Will production use Cloudflare in front of ALB?
4. What is the first model provider and region policy?
5. What are initial RPO/RTO commitments?
6. How much raw prompt/context artifact retention is allowed?
7. Is staging allowed to use real model providers?
8. What is the initial production GitHub App name/domain?
9. Do we need enterprise self-hosted packaging from day one?
10. When do we introduce EC2/EKS index workers for persistent repo caches?
```

---

# 32. Reference notes

Key external implementation references to verify during actual build:

```text
Docker Compose service definitions and health checks
AWS ECS task definitions, task roles, task execution roles, service autoscaling
AWS Fargate ephemeral storage limits and configuration
AWS RDS PostgreSQL backups, Multi-AZ, and PITR
AWS ElastiCache Redis/Valkey configuration
AWS S3/KMS/Secrets Manager/IAM docs
Terraform modules and remote state docs
OpenTelemetry Collector deployment docs
Kubernetes HPA/KEDA docs if migrating to Kubernetes
```

