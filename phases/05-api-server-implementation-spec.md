# #5 API Server Implementation Spec

_Last updated: 2026-04-28_

This document specifies the implementation plan for **#5 API Server** in the Greptile-like code review system.

The API server is the product's **control plane**. It handles authenticated user requests, repository settings, review history, debug inspection, rule configuration, usage reporting, and safe job enqueueing. It should not perform expensive work such as repository cloning, indexing, embedding, or pull-request review. Those belong to worker services.

---

## 1. Executive summary

Use:

```text
Runtime:       Bun
HTTP server:   Elysia
DB access:     @repo/db / Drizzle
Contracts:     @repo/contracts
Queue access:  @repo/queue
GitHub access: @repo/github
Auth:          GitHub OAuth + opaque DB-backed sessions
Docs:          Elysia OpenAPI plugin
Client:        Eden Treaty optional for internal/dashboard client
```

The API server should be built around these principles:

```text
- Control-plane only; no long-running jobs.
- Contract-first request and response types.
- One request context object per request.
- Explicit tenant/org scoping on every protected route.
- RBAC checks in service boundaries, not only UI.
- Uniform JSON response envelopes.
- Stable API versioning from day one.
- All state changes are audited.
- All expensive operations are converted into durable background jobs.
```

Recommended API shape:

```text
/apps/api
  src/
    index.ts
    app.ts
    env.ts
    context.ts
    errors.ts
    plugins/
    middleware/
    routes/
    services/
    clients/
    utils/
    tests/
```

Primary URL spaces:

```text
GET  /healthz
GET  /readyz
GET  /version

POST /webhooks/github                  # implemented in #4, mounted here

/api/v1/auth/*                         # user auth/session
/api/v1/me                             # current user/session
/api/v1/orgs/*                         # orgs and membership
/api/v1/installations/*                # provider installations
/api/v1/repositories/*                 # repo control
/api/v1/review-runs/*                  # review history/detail
/api/v1/findings/*                     # finding history/actions
/api/v1/rules/*                        # repo/team rules
/api/v1/memory/*                       # explicit memory facts
/api/v1/usage/*                        # usage/cost reporting
/api/v1/debug/*                        # gated debug tools
/internal/v1/*                         # internal service endpoints if needed
```

---

## 2. Scope

### 2.1 Responsibilities

The API server owns:

```text
- User login/logout/session handling
- Current user and org context
- Organization and membership APIs
- Repository enablement and settings APIs
- Repository rule APIs
- Review-run listing and detail APIs
- Finding listing and manual outcome/suppression APIs
- Memory fact visibility and editing APIs
- Usage and cost reporting APIs
- Internal/debug artifact access APIs
- Safe job enqueueing APIs
- Admin-only operational APIs
- OpenAPI documentation generation
- Uniform error responses
- HTTP-level security and rate limiting
- Request logging, tracing, and metrics
```

### 2.2 Non-responsibilities

The API server should **not** own:

```text
- Repository cloning/fetching
- Indexing
- Embedding generation
- Context retrieval for live review jobs
- LLM review execution
- GitHub comment publishing
- Static analysis execution
- Long-running GitHub syncs
- Direct prompt/model orchestration
- Worker scheduling logic beyond enqueueing durable jobs
```

Those belong to:

```text
#7  Job Queue and Orchestration
#8  Repo Sync and Workspace Manager
#11 TypeScript Indexer
#13 Embedding Pipeline
#14 Retrieval Engine
#16 Review Orchestrator
#17 LLM Gateway
#20 Publisher
```

---

## 3. Dependencies on previous sections

The API server depends on:

```text
#0 Core Contracts and Shared Types
#1 Monorepo and Build System
#2 Database Layer
#3 GitHub App Integration
#4 Webhook Ingestion
```

Specifically:

```text
@repo/contracts
  - API DTOs
  - IDs
  - repository settings schemas
  - review/finding schemas
  - job payload schemas
  - error codes

@repo/db
  - Drizzle client
  - transaction helpers
  - repository modules
  - audit log writer

@repo/github
  - GitHub OAuth helpers if implemented there
  - installation sync helpers
  - repository discovery helpers
  - GitHub App install URLs

@repo/queue
  - typed enqueue helpers
  - job dedupe helpers

@repo/observability
  - logger
  - metrics
  - tracing
```

If `user_sessions` was not included in #2, add it before implementing auth.

Recommended table addition:

```sql
create table user_sessions (
  id text primary key,
  user_id text not null references users(id),
  org_id text references orgs(id),
  session_hash text not null unique,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  ip_hash text,
  user_agent_hash text,
  metadata jsonb not null default '{}'
);

create index user_sessions_user_id_idx on user_sessions(user_id);
create index user_sessions_expires_at_idx on user_sessions(expires_at);
create index user_sessions_active_idx
  on user_sessions(user_id, expires_at)
  where revoked_at is null;
```

---

## 4. Design goals

### 4.1 API shape should be boring

Prefer simple REST endpoints with explicit nouns:

```text
GET    /api/v1/repositories/:repoId
PATCH  /api/v1/repositories/:repoId/settings
POST   /api/v1/repositories/:repoId/reindex
GET    /api/v1/review-runs/:reviewRunId
```

Avoid clever RPC routes for user-facing APIs unless the action is truly command-like:

```text
POST /api/v1/repositories/:repoId/reindex
POST /api/v1/review-runs/:reviewRunId/replay
POST /api/v1/review-runs/:reviewRunId/rerun
```

### 4.2 Every protected request has explicit context

Every protected handler should receive:

```ts
type RequestContext = {
  requestId: string;
  traceId?: string;
  actor: AuthenticatedActor;
  org?: ScopedOrg;
  ip?: string;
  userAgent?: string;
  startedAt: number;
};
```

Do not pass raw cookies, raw sessions, or raw database users into service methods.

### 4.3 Services enforce authorization

UI checks are not enough.

Every service method that reads or mutates tenant data should explicitly check access:

```ts
await accessControl.requireRepoPermission(ctx.actor, repoId, "repo:settings:write");
```

### 4.4 Queue jobs are durable before acknowledgement

For API actions like `reindex`, `sync`, or `rerun review`, first create a durable job row in Postgres, then enqueue to BullMQ.

```text
API request
  -> validate permissions
  -> transaction:
       insert background_jobs row
       insert audit log row
  -> enqueue BullMQ job
  -> return 202 Accepted
```

If BullMQ enqueue fails after the DB insert, the outbox/dispatcher from #7 should enqueue later.

### 4.5 Runtime validation is mandatory

All inbound request bodies, query params, and path params should be runtime-validated.

All external outputs should be generated from typed DTOs.

---

## 5. Stack choices

### 5.1 Elysia on Bun

Use Elysia for the API because it is TypeScript-first, has strong route typing, plugin composition, OpenAPI support, lifecycle hooks, and an official Eden Treaty client option.

The API should expose its app type for optional Eden Treaty use:

```ts
// apps/api/src/app.ts
export const createApp = () => {
  return new Elysia({ name: "api" })
    .use(corePlugins())
    .use(routes());
};

export type App = ReturnType<typeof createApp>;
```

The web dashboard can use either:

```text
- a generated OpenAPI client
- Eden Treaty
- a small manually-written fetch client around @repo/contracts
```

Recommendation:

```text
MVP: manually-written fetch client + @repo/contracts DTOs
Later: Eden Treaty for internal type-safe dashboard calls or generated OpenAPI client
```

### 5.2 OpenAPI

Enable OpenAPI documentation in non-production environments and optionally behind admin auth in production.

```ts
import { openapi } from "@elysia/openapi";

app.use(
  openapi({
    path: "/openapi",
    documentation: {
      info: {
        title: "Code Review Agent API",
        version: "1.0.0"
      }
    }
  })
);
```

Recommended exposure:

```text
local/dev:     /openapi enabled
staging:       /openapi enabled behind auth
production:    disabled or admin-only
```

### 5.3 CORS

Only allow the configured dashboard origins.

Do not use wildcard CORS in production.

```ts
import { cors } from "@elysia/cors";

app.use(
  cors({
    origin: ({ headers }) => {
      const origin = headers.get("origin");
      return origin != null && config.web.allowedOrigins.includes(origin);
    },
    credentials: true,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Request-Id", "X-CSRF-Token"]
  })
);
```

### 5.4 Environment config

Use a single config loader:

```text
/apps/api/src/env.ts
```

Example:

```ts
import { Type } from "@sinclair/typebox";
import { parseWithSchema } from "@repo/contracts/validation";

const EnvSchema = Type.Object({
  NODE_ENV: Type.Union([
    Type.Literal("development"),
    Type.Literal("test"),
    Type.Literal("staging"),
    Type.Literal("production")
  ]),
  API_PORT: Type.String({ default: "3000" }),
  PUBLIC_API_BASE_URL: Type.String(),
  WEB_BASE_URL: Type.String(),
  DATABASE_URL: Type.String(),
  REDIS_URL: Type.String(),
  SESSION_SECRET: Type.String({ minLength: 32 }),
  GITHUB_APP_ID: Type.String(),
  GITHUB_APP_PRIVATE_KEY: Type.String(),
  GITHUB_WEBHOOK_SECRET: Type.String(),
  GITHUB_OAUTH_CLIENT_ID: Type.String(),
  GITHUB_OAUTH_CLIENT_SECRET: Type.String()
});

export const env = parseWithSchema(EnvSchema, process.env);
```

Bun automatically reads `.env` files, but production secrets should come from the deployment platform or secrets manager, not checked-in files.

---

## 6. App layout

Recommended files:

```text
/apps/api
  package.json
  tsconfig.json
  src/
    index.ts
    app.ts
    env.ts
    context.ts
    errors.ts
    response.ts
    auth/
      github-oauth.ts
      session.ts
      csrf.ts
      cookies.ts
    plugins/
      core.ts
      request-id.ts
      logger.ts
      error-handler.ts
      security-headers.ts
      cors.ts
      auth.ts
      org-scope.ts
      rate-limit.ts
      openapi.ts
    routes/
      index.ts
      health.routes.ts
      auth.routes.ts
      me.routes.ts
      org.routes.ts
      installation.routes.ts
      repository.routes.ts
      rule.routes.ts
      review-run.routes.ts
      finding.routes.ts
      memory.routes.ts
      usage.routes.ts
      debug.routes.ts
      admin.routes.ts
      internal.routes.ts
    services/
      access-control.service.ts
      auth.service.ts
      org.service.ts
      installation.service.ts
      repository.service.ts
      rule.service.ts
      review-run.service.ts
      finding.service.ts
      memory.service.ts
      usage.service.ts
      audit.service.ts
      job-command.service.ts
    clients/
      db.ts
      queue.ts
      github.ts
    utils/
      pagination.ts
      etag.ts
      redaction.ts
      assert.ts
    tests/
      fixtures.ts
      app.test.ts
      auth.test.ts
      repository.routes.test.ts
      review-run.routes.test.ts
```

Recommended package dependencies:

```json
{
  "dependencies": {
    "@elysia/cors": "latest",
    "@elysia/openapi": "latest",
    "@repo/contracts": "workspace:*",
    "@repo/db": "workspace:*",
    "@repo/github": "workspace:*",
    "@repo/queue": "workspace:*",
    "@repo/observability": "workspace:*",
    "elysia": "latest"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "vitest": "latest"
  }
}
```

---

## 7. Request lifecycle

Every request should follow this flow:

```text
HTTP request
  -> request ID assignment
  -> basic security headers
  -> CORS if browser route
  -> route matching
  -> auth/session parsing for protected routes
  -> org/repo scope loading if required
  -> RBAC permission check
  -> input validation
  -> service call
  -> DB transaction / queue command if needed
  -> response envelope
  -> structured log + metrics + trace
```

### 7.1 Request ID

Headers:

```text
Input:  X-Request-Id optional
Output: X-Request-Id always
```

Rules:

```text
- If caller sends a valid request ID, keep it.
- Otherwise generate one.
- Include it in logs, traces, error responses, and audit logs.
```

Example:

```ts
export const requestIdPlugin = new Elysia({ name: "request-id" })
  .derive(({ headers, set }) => {
    const incoming = headers["x-request-id"];
    const requestId = isValidRequestId(incoming) ? incoming : crypto.randomUUID();
    set.headers["x-request-id"] = requestId;
    return { requestId };
  });
```

### 7.2 Uniform response envelope

All successful API responses should use:

```ts
type ApiSuccess<T> = {
  ok: true;
  data: T;
  meta?: ApiMeta;
};
```

All errors:

```ts
type ApiError = {
  ok: false;
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: unknown;
  };
};
```

Example success:

```json
{
  "ok": true,
  "data": {
    "repoId": "repo_123",
    "enabled": true
  }
}
```

Example error:

```json
{
  "ok": false,
  "error": {
    "code": "repo.not_found",
    "message": "Repository not found.",
    "requestId": "req_01HV..."
  }
}
```

Do not return raw ORM rows directly.

---

## 8. Authentication model

### 8.1 Recommended approach

Use:

```text
GitHub OAuth for user identity
Opaque DB-backed session cookie for dashboard/API auth
GitHub App installation token only for GitHub API calls
Internal service token for protected internal routes
```

Do not use GitHub installation tokens as user sessions.

Do not store GitHub OAuth access tokens unless you have a specific need. For most of this product, you need GitHub App installation tokens, not user access tokens.

### 8.2 Session cookie

Cookie:

```text
Name:      car_session or __Host-car_session
Type:      opaque random token
Flags:     HttpOnly, Secure, SameSite=Lax, Path=/
Storage:   store only hash in DB
TTL:       14 days default
Rotation:  rotate on login and optionally every N days
```

Recommended cookie rules:

```text
- Use __Host- prefix in production if served over HTTPS and Path=/.
- Never expose session token to JavaScript.
- Store sha256(sessionToken + serverPepper) in DB.
- Revoke on logout.
- Extend last_seen_at opportunistically, not every request.
```

Session object:

```ts
type Session = {
  sessionId: SessionId;
  userId: UserId;
  selectedOrgId?: OrgId;
  expiresAt: ISODateTime;
  createdAt: ISODateTime;
};
```

### 8.3 GitHub OAuth flow

Routes:

```text
GET /api/v1/auth/github/start
GET /api/v1/auth/github/callback
POST /api/v1/auth/logout
```

Flow:

```text
GET /auth/github/start
  -> generate state
  -> store state in signed short-lived cookie or DB oauth_states table
  -> redirect to GitHub OAuth authorization URL

GET /auth/github/callback
  -> validate state
  -> exchange code for token
  -> fetch GitHub user identity
  -> upsert users row
  -> upsert user_provider_accounts row
  -> create user session
  -> redirect to dashboard
```

Recommended `oauth_states` table if using DB-backed state:

```sql
create table oauth_states (
  id text primary key,
  state_hash text not null unique,
  redirect_to text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  metadata jsonb not null default '{}'
);
```

State validation rules:

```text
- State must be unexpired.
- State must be one-time-use.
- Redirect target must be relative or allowlisted.
- Callback should create a new session and clear OAuth state cookie.
```

### 8.4 Current user route

```text
GET /api/v1/me
```

Returns:

```ts
type GetMeResponse = {
  user: UserDto;
  selectedOrgId?: OrgId;
  orgs: OrgMembershipDto[];
  featureFlags: Record<string, boolean>;
};
```

### 8.5 Logout

```text
POST /api/v1/auth/logout
```

Behavior:

```text
- revoke current user_sessions row
- clear cookie
- write audit log
- return ok
```

### 8.6 Internal service auth

For `/internal/v1/*`, use a separate internal token or mTLS later.

Header:

```text
Authorization: Bearer <internal-service-token>
```

Rules:

```text
- Do not allow user session cookies on internal routes.
- Do not allow internal token on user routes.
- Rotate internal token via secrets manager.
- Log internal actor name, not secret material.
```

---

## 9. Authorization and tenancy

### 9.1 Roles

Use org-level roles:

```text
owner
admin
member
viewer
```

Suggested permissions:

```text
org:view
org:manage
org:members:read
org:members:write
installation:read
installation:sync
repo:read
repo:settings:write
repo:enable
repo:disable
repo:reindex
review:read
review:debug:read
review:rerun
finding:read
finding:write
rule:read
rule:write
memory:read
memory:write
usage:read
audit:read
```

Mapping:

```text
owner:
  all org permissions

admin:
  all except owner-only billing/security operations

member:
  repo:read, review:read, finding:read, rule:read, memory:read, usage:read maybe

viewer:
  read-only subset
```

### 9.2 Scoped resource access

Never trust path IDs alone.

For a route like:

```text
GET /api/v1/repositories/:repoId/review-runs
```

The handler must:

```text
- load repo by repoId
- check repo.orgId is accessible to actor
- check actor permission for review:read
- use repo.orgId in all DB queries
```

Service example:

```ts
export async function getRepositoryOrThrow(ctx: RequestContext, repoId: RepoId) {
  const repo = await repositoriesRepo.findById(repoId);
  if (!repo) throw new NotFoundError("repo.not_found", "Repository not found.");

  await accessControl.requireOrgPermission(ctx.actor, repo.orgId, "repo:read");

  return repo;
}
```

### 9.3 Org selection

Support selected org in session for dashboard convenience, but do not use it as the only authorization source.

Routes:

```text
GET  /api/v1/orgs
POST /api/v1/me/selected-org
```

Payload:

```ts
type SetSelectedOrgRequest = {
  orgId: OrgId;
};
```

Rules:

```text
- selectedOrgId must be an org the user belongs to
- selectedOrgId only affects default filtering
- every resource route still checks actual resource org
```

---

## 10. Route inventory

This section lists the recommended API routes for MVP and near-term expansion.

### 10.1 Health and metadata

#### `GET /healthz`

Purpose: shallow health check.

Does not check dependencies.

Response:

```json
{ "ok": true, "data": { "status": "ok" } }
```

#### `GET /readyz`

Purpose: readiness check.

Checks:

```text
- DB can be queried
- Redis/queue can be reached if configured
- app config loaded
```

Response:

```ts
type ReadinessResponse = {
  status: "ready" | "not_ready";
  checks: Array<{
    name: string;
    status: "ok" | "failed";
    latencyMs?: number;
  }>;
};
```

#### `GET /version`

Response:

```ts
type VersionResponse = {
  service: "api";
  version: string;
  gitSha?: string;
  builtAt?: string;
  environment: "development" | "test" | "staging" | "production";
};
```

---

### 10.2 Auth routes

```text
GET  /api/v1/auth/github/start
GET  /api/v1/auth/github/callback
POST /api/v1/auth/logout
GET  /api/v1/me
POST /api/v1/me/selected-org
```

#### `GET /api/v1/auth/github/start`

Query:

```ts
type StartGithubAuthQuery = {
  redirectTo?: string;
};
```

Behavior:

```text
- validate redirectTo
- create OAuth state
- redirect to GitHub
```

#### `GET /api/v1/auth/github/callback`

Query:

```ts
type GithubCallbackQuery = {
  code: string;
  state: string;
};
```

Behavior:

```text
- validate state
- exchange code
- fetch GitHub identity
- upsert user
- create session
- redirect to dashboard
```

#### `GET /api/v1/me`

Auth required.

Response:

```ts
type MeResponse = {
  user: UserDto;
  selectedOrgId?: OrgId;
  memberships: OrgMembershipDto[];
  installations: ProviderInstallationSummaryDto[];
};
```

---

### 10.3 Org routes

```text
GET /api/v1/orgs
GET /api/v1/orgs/:orgId
GET /api/v1/orgs/:orgId/members
GET /api/v1/orgs/:orgId/audit-logs
```

#### `GET /api/v1/orgs`

Returns orgs accessible by current user.

Query:

```ts
type ListOrgsQuery = {
  includeInactive?: boolean;
};
```

#### `GET /api/v1/orgs/:orgId`

Returns org detail.

#### `GET /api/v1/orgs/:orgId/members`

Requires:

```text
org:members:read
```

Query:

```ts
type ListMembersQuery = {
  cursor?: string;
  limit?: number;
  role?: "owner" | "admin" | "member" | "viewer";
};
```

#### `GET /api/v1/orgs/:orgId/audit-logs`

Requires:

```text
audit:read
```

Query:

```ts
type ListAuditLogsQuery = {
  cursor?: string;
  limit?: number;
  actorUserId?: UserId;
  action?: string;
  start?: ISODateTime;
  end?: ISODateTime;
};
```

---

### 10.4 Installation routes

```text
GET  /api/v1/installations
GET  /api/v1/installations/:installationId
POST /api/v1/installations/:installationId/sync
GET  /api/v1/github/install-url
GET  /api/v1/github/install-callback
```

#### `GET /api/v1/installations`

Returns installations visible to current user.

#### `POST /api/v1/installations/:installationId/sync`

Requires:

```text
installation:sync
```

Behavior:

```text
- create durable background job: github.sync_installation
- return 202
```

Response:

```ts
type EnqueueJobResponse = {
  jobId: BackgroundJobId;
  status: "queued";
};
```

#### `GET /api/v1/github/install-url`

Returns GitHub App installation URL.

Response:

```ts
type GithubInstallUrlResponse = {
  url: string;
};
```

#### `GET /api/v1/github/install-callback`

Handles redirect after GitHub App installation.

Query:

```ts
type GithubInstallCallbackQuery = {
  installation_id?: string;
  setup_action?: "install" | "update";
  state?: string;
};
```

Behavior:

```text
- validate state if present
- sync installation metadata
- associate installation with org if possible
- redirect to dashboard onboarding
```

---

### 10.5 Repository routes

```text
GET   /api/v1/orgs/:orgId/repositories
GET   /api/v1/repositories/:repoId
PATCH /api/v1/repositories/:repoId/settings
POST  /api/v1/repositories/:repoId/enable
POST  /api/v1/repositories/:repoId/disable
POST  /api/v1/repositories/:repoId/sync
POST  /api/v1/repositories/:repoId/reindex
GET   /api/v1/repositories/:repoId/index-versions
GET   /api/v1/repositories/:repoId/review-runs
```

#### `GET /api/v1/orgs/:orgId/repositories`

Requires:

```text
repo:read
```

Query:

```ts
type ListRepositoriesQuery = {
  cursor?: string;
  limit?: number;
  provider?: "github";
  enabled?: boolean;
  search?: string;
  owner?: string;
  language?: string;
};
```

Response:

```ts
type ListRepositoriesResponse = {
  items: RepositorySummaryDto[];
  pageInfo: PageInfo;
};
```

#### `GET /api/v1/repositories/:repoId`

Response:

```ts
type RepositoryDetailResponse = {
  repository: RepositoryDto;
  settings: RepositorySettingsDto;
  latestIndex?: RepoIndexVersionSummaryDto;
  stats: {
    reviewRunsLast30Days: number;
    avgReviewLatencyMs?: number;
    publishedFindingsLast30Days: number;
  };
};
```

#### `PATCH /api/v1/repositories/:repoId/settings`

Requires:

```text
repo:settings:write
```

Request:

```ts
type UpdateRepositorySettingsRequest = {
  reviewPolicy?: ReviewPolicy;
  maxCommentsPerReview?: number;
  minimumSeverity?: "low" | "medium" | "high" | "critical";
  ignoredPaths?: string[];
  ignoredAuthors?: string[];
  ignoredLabels?: string[];
  requireLabel?: string;
  skipGeneratedFiles?: boolean;
  allowDraftPullRequests?: boolean;
  enabledLanguages?: string[];
};
```

Behavior:

```text
- load repo
- check permission
- validate settings
- update settings row
- write audit log
- return updated settings
```

#### `POST /api/v1/repositories/:repoId/enable`

Requires:

```text
repo:enable
```

Behavior:

```text
- set enabled=true
- enqueue optional initial index job
- write audit log
- return 202 if job enqueued, otherwise 200
```

#### `POST /api/v1/repositories/:repoId/disable`

Requires:

```text
repo:disable
```

Behavior:

```text
- set enabled=false
- do not delete index data immediately
- write audit log
```

#### `POST /api/v1/repositories/:repoId/sync`

Behavior:

```text
- enqueue github.sync_repository
- return jobId
```

#### `POST /api/v1/repositories/:repoId/reindex`

Request:

```ts
type ReindexRepositoryRequest = {
  commitSha?: string;
  reason?: string;
  force?: boolean;
};
```

Behavior:

```text
- if commitSha omitted, use default branch head known in DB or fetch via GitHub adapter
- create repo.index job
- dedupe unless force=true
- return 202
```

---

### 10.6 Rule routes

Rules may be org-level or repo-level.

```text
GET    /api/v1/repositories/:repoId/rules
POST   /api/v1/repositories/:repoId/rules
GET    /api/v1/rules/:ruleId
PATCH  /api/v1/rules/:ruleId
DELETE /api/v1/rules/:ruleId
```

#### Rule DTO

```ts
type RepoRuleDto = {
  ruleId: RepoRuleId;
  repoId?: RepoId;
  orgId: OrgId;
  name: string;
  description?: string;
  enabled: boolean;
  severity?: "low" | "medium" | "high" | "critical";
  category?: FindingCategory;
  ruleType:
    | "instruction"
    | "suppression"
    | "path_ignore"
    | "severity_override"
    | "custom_review_focus";
  match: {
    paths?: string[];
    languages?: string[];
    findingCategories?: FindingCategory[];
    text?: string;
  };
  action: {
    suppress?: boolean;
    instruction?: string;
    minimumSeverity?: FindingSeverity;
  };
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
};
```

Examples:

```text
- Do not comment on files under src/generated/**
- Only publish security findings for infra/**
- Treat missing tests as high severity in billing/**
- This repo intentionally uses custom session middleware
```

Rule writes should create audit logs.

---

### 10.7 Review run routes

```text
GET  /api/v1/orgs/:orgId/review-runs
GET  /api/v1/repositories/:repoId/review-runs
GET  /api/v1/review-runs/:reviewRunId
GET  /api/v1/review-runs/:reviewRunId/findings
GET  /api/v1/review-runs/:reviewRunId/artifacts
GET  /api/v1/review-runs/:reviewRunId/logs
POST /api/v1/review-runs/:reviewRunId/rerun
POST /api/v1/review-runs/:reviewRunId/cancel
```

#### `GET /api/v1/orgs/:orgId/review-runs`

Query:

```ts
type ListReviewRunsQuery = {
  cursor?: string;
  limit?: number;
  repoId?: RepoId;
  status?: ReviewRunStatus;
  prNumber?: number;
  author?: string;
  start?: ISODateTime;
  end?: ISODateTime;
};
```

Response:

```ts
type ListReviewRunsResponse = {
  items: ReviewRunSummaryDto[];
  pageInfo: PageInfo;
};
```

#### `GET /api/v1/review-runs/:reviewRunId`

Response:

```ts
type ReviewRunDetailResponse = {
  reviewRun: ReviewRunDto;
  repository: RepositorySummaryDto;
  pullRequest: PullRequestSummaryDto;
  stats: {
    candidateFindings: number;
    validatedFindings: number;
    publishedFindings: number;
    rejectedFindings: number;
    totalLatencyMs?: number;
    llmCostUsd?: string;
  };
  latestArtifacts: ReviewArtifactSummaryDto[];
};
```

#### `GET /api/v1/review-runs/:reviewRunId/findings`

Query:

```ts
type ListFindingsQuery = {
  source?: "candidate" | "published";
  severity?: FindingSeverity;
  category?: FindingCategory;
  status?: "published" | "rejected" | "suppressed";
};
```

#### `GET /api/v1/review-runs/:reviewRunId/artifacts`

Requires:

```text
review:debug:read
```

Returns artifact metadata only by default. Do not return full prompt/code artifacts unless caller has debug permission.

#### `POST /api/v1/review-runs/:reviewRunId/rerun`

Request:

```ts
type RerunReviewRequest = {
  reason?: string;
  mode?: "same_snapshot" | "latest_pr_state";
  publish?: boolean;
};
```

Behavior:

```text
- check review:rerun permission
- create new review job
- link parentReviewRunId
- return 202
```

Rules:

```text
- same_snapshot reruns with old base/head/diff
- latest_pr_state fetches current PR state
- publish=false is useful for internal eval/debug only
```

#### `POST /api/v1/review-runs/:reviewRunId/cancel`

Only works for queued/not-started jobs unless workers support cooperative cancellation.

---

### 10.8 Finding routes

```text
GET   /api/v1/findings/:findingId
PATCH /api/v1/findings/:findingId/outcome
POST  /api/v1/findings/:findingId/suppress-similar
```

#### `GET /api/v1/findings/:findingId`

Returns full finding detail if user can view the underlying repo/review run.

#### `PATCH /api/v1/findings/:findingId/outcome`

Request:

```ts
type UpdateFindingOutcomeRequest = {
  outcome:
    | "accepted"
    | "rejected"
    | "false_positive"
    | "not_actionable"
    | "duplicate"
    | "resolved"
    | "ignored";
  note?: string;
};
```

Behavior:

```text
- create or update finding_outcomes row
- optionally enqueue memory.update
- write audit log
```

#### `POST /api/v1/findings/:findingId/suppress-similar`

Request:

```ts
type SuppressSimilarFindingRequest = {
  scope: "repo" | "org";
  reason: string;
  expiresAt?: ISODateTime;
};
```

Behavior:

```text
- create suppression RepoRule or MemoryFact
- enqueue memory.update
- audit log
```

---

### 10.9 Memory routes

```text
GET    /api/v1/repositories/:repoId/memory
POST   /api/v1/repositories/:repoId/memory
GET    /api/v1/memory/:memoryFactId
PATCH  /api/v1/memory/:memoryFactId
DELETE /api/v1/memory/:memoryFactId
```

Memory facts should be explicit and inspectable.

#### Memory fact DTO

```ts
type MemoryFactDto = {
  memoryFactId: MemoryFactId;
  orgId: OrgId;
  repoId?: RepoId;
  kind:
    | "team_preference"
    | "repo_convention"
    | "suppression"
    | "architecture_note"
    | "review_instruction";
  text: string;
  confidence: number;
  source: "manual" | "feedback" | "system";
  enabled: boolean;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  expiresAt?: ISODateTime;
};
```

Manual memory creation:

```ts
type CreateMemoryFactRequest = {
  kind: MemoryFactDto["kind"];
  text: string;
  enabled?: boolean;
  expiresAt?: ISODateTime;
};
```

---

### 10.10 Usage routes

```text
GET /api/v1/orgs/:orgId/usage/summary
GET /api/v1/orgs/:orgId/usage/events
GET /api/v1/repositories/:repoId/usage/summary
```

#### `GET /api/v1/orgs/:orgId/usage/summary`

Query:

```ts
type UsageSummaryQuery = {
  start?: ISODateTime;
  end?: ISODateTime;
  groupBy?: "day" | "week" | "month" | "repo";
};
```

Response:

```ts
type UsageSummaryResponse = {
  reviewRuns: number;
  indexedCommits: number;
  embeddingTokens: number;
  reviewInputTokens: number;
  reviewOutputTokens: number;
  estimatedCostUsd: string;
  byRepo?: Array<{
    repoId: RepoId;
    repoName: string;
    reviewRuns: number;
    estimatedCostUsd: string;
  }>;
};
```

---

### 10.11 Debug routes

Debug routes are very useful but sensitive because they may expose code snippets, prompts, model outputs, and internal decision traces.

```text
GET  /api/v1/debug/review-runs/:reviewRunId/context-bundle
GET  /api/v1/debug/review-runs/:reviewRunId/prompts
GET  /api/v1/debug/review-runs/:reviewRunId/rejected-findings
GET  /api/v1/debug/index-versions/:indexVersionId/artifact
POST /api/v1/debug/review-runs/:reviewRunId/replay
POST /api/v1/debug/retrieval/run
```

Requirements:

```text
- require review:debug:read or admin role
- redact secrets
- support audit logging
- optionally disable in production
- never expose GitHub tokens, session tokens, installation tokens, or raw secrets
```

#### `POST /api/v1/debug/retrieval/run`

Request:

```ts
type DebugRetrievalRequest = {
  repoId: RepoId;
  commitSha: string;
  filePath: string;
  line?: number;
  query?: string;
  includeMemory?: boolean;
  includeVectorResults?: boolean;
};
```

Behavior:

```text
- enqueue debug retrieval job or run only if cheap
- return context items and ranking reasons
```

MVP can omit live debug retrieval and only expose stored artifacts.

---

### 10.12 Admin routes

```text
GET  /api/v1/admin/orgs
GET  /api/v1/admin/repositories
GET  /api/v1/admin/review-runs
GET  /api/v1/admin/jobs
POST /api/v1/admin/jobs/:jobId/retry
POST /api/v1/admin/webhook-events/:eventId/replay
```

Admin routes should be gated by platform-level role, not org role.

Platform roles:

```text
platform_admin
platform_support
```

Rules:

```text
- platform_support can inspect metadata
- platform_admin can replay/retry
- raw code/prompt access should require elevated debug permission
```

---

## 11. Elysia app composition

### 11.1 `index.ts`

```ts
import { createApp } from "./app";
import { env } from "./env";
import { logger } from "@repo/observability";

const app = createApp();

app.listen({
  port: Number(env.API_PORT),
  hostname: env.API_HOST ?? "0.0.0.0"
});

logger.info("api.server.started", {
  port: env.API_PORT,
  env: env.NODE_ENV
});

export type App = typeof app;
```

### 11.2 `app.ts`

```ts
import { Elysia } from "elysia";
import { corePlugins } from "./plugins/core";
import { routes } from "./routes";

export function createApp() {
  return new Elysia({ name: "code-review-agent-api" })
    .use(corePlugins())
    .use(routes());
}

export type ApiApp = ReturnType<typeof createApp>;
```

### 11.3 Core plugins

```ts
import { Elysia } from "elysia";
import { requestIdPlugin } from "./request-id";
import { loggerPlugin } from "./logger";
import { errorHandlerPlugin } from "./error-handler";
import { securityHeadersPlugin } from "./security-headers";
import { corsPlugin } from "./cors";
import { authPlugin } from "./auth";
import { rateLimitPlugin } from "./rate-limit";
import { openApiPlugin } from "./openapi";

export function corePlugins() {
  return new Elysia({ name: "core-plugins" })
    .use(requestIdPlugin)
    .use(loggerPlugin)
    .use(errorHandlerPlugin)
    .use(securityHeadersPlugin)
    .use(corsPlugin)
    .use(rateLimitPlugin)
    .use(authPlugin)
    .use(openApiPlugin);
}
```

### 11.4 Routes index

```ts
import { Elysia } from "elysia";
import { healthRoutes } from "./health.routes";
import { authRoutes } from "./auth.routes";
import { meRoutes } from "./me.routes";
import { orgRoutes } from "./org.routes";
import { installationRoutes } from "./installation.routes";
import { repositoryRoutes } from "./repository.routes";
import { reviewRunRoutes } from "./review-run.routes";
import { findingRoutes } from "./finding.routes";
import { ruleRoutes } from "./rule.routes";
import { memoryRoutes } from "./memory.routes";
import { usageRoutes } from "./usage.routes";
import { debugRoutes } from "./debug.routes";

export function routes() {
  return new Elysia({ name: "routes" })
    .use(healthRoutes)
    .group("/api/v1", app =>
      app
        .use(authRoutes)
        .use(meRoutes)
        .use(orgRoutes)
        .use(installationRoutes)
        .use(repositoryRoutes)
        .use(reviewRunRoutes)
        .use(findingRoutes)
        .use(ruleRoutes)
        .use(memoryRoutes)
        .use(usageRoutes)
        .use(debugRoutes)
    );
}
```

---

## 12. Route implementation pattern

Each route file should be thin.

Route handlers should:

```text
- parse path/query/body
- require auth if needed
- call service method
- return DTO envelope
```

They should not:

```text
- perform complex SQL directly
- call GitHub directly except through service wrappers
- enqueue raw BullMQ jobs without durable DB job row
- contain authorization logic beyond invoking access-control helpers
```

Example:

```ts
import { Elysia, t } from "elysia";
import { requireAuth } from "../plugins/auth";
import { repositoryService } from "../services/repository.service";
import { ok } from "../response";

export const repositoryRoutes = new Elysia({ name: "repository-routes" })
  .use(requireAuth)
  .get(
    "/orgs/:orgId/repositories",
    async ({ ctx, params, query }) => {
      const result = await repositoryService.listRepositories(ctx, {
        orgId: params.orgId,
        cursor: query.cursor,
        limit: query.limit,
        enabled: query.enabled,
        search: query.search
      });

      return ok(result);
    },
    {
      params: t.Object({ orgId: t.String() }),
      query: t.Object({
        cursor: t.Optional(t.String()),
        limit: t.Optional(t.Number({ minimum: 1, maximum: 100 })),
        enabled: t.Optional(t.Boolean()),
        search: t.Optional(t.String({ maxLength: 200 }))
      })
    }
  );
```

If you use schemas from `@repo/contracts`, keep route-level validators synchronized with those schemas.

---

## 13. Services

Services are where business logic lives.

Recommended services:

```text
access-control.service.ts
  - permission checks
  - role mapping
  - resource access checks

auth.service.ts
  - OAuth state
  - session create/read/revoke
  - GitHub user identity upsert

org.service.ts
  - org list/detail
  - memberships
  - selected org

installation.service.ts
  - installation list/detail
  - installation sync job command

repository.service.ts
  - repo list/detail/settings
  - enable/disable
  - sync/reindex commands

rule.service.ts
  - rule CRUD
  - rule validation

review-run.service.ts
  - list/detail
  - artifact metadata
  - rerun/cancel command

finding.service.ts
  - finding detail
  - outcome update
  - suppress similar

memory.service.ts
  - memory fact CRUD

usage.service.ts
  - usage summary
  - usage events

audit.service.ts
  - writes audit logs

job-command.service.ts
  - durable job row creation
  - queue enqueue
  - dedupe/idempotency
```

### 13.1 Service method shape

Use explicit input types:

```ts
export async function updateRepositorySettings(
  ctx: RequestContext,
  input: {
    repoId: RepoId;
    patch: UpdateRepositorySettingsRequest;
  }
): Promise<RepositorySettingsDto> {
  // ...
}
```

Avoid service methods like:

```ts
updateRepositorySettings(req: Request)
```

The service layer should not know about Elysia-specific request objects.

---

## 14. Job command service

The API server triggers jobs, but does not execute them.

### 14.1 Durable job command pattern

```ts
type CreateJobCommandInput<TPayload> = {
  queueName: QueueName;
  jobType: JobType;
  payload: TPayload;
  dedupeKey?: string;
  actorUserId?: UserId;
  orgId?: OrgId;
  repoId?: RepoId;
};
```

Implementation:

```ts
export async function createAndEnqueueJob<TPayload>(
  ctx: RequestContext,
  input: CreateJobCommandInput<TPayload>
): Promise<BackgroundJobDto> {
  return db.transaction(async tx => {
    const job = await backgroundJobsRepo.insert(tx, {
      id: makeBackgroundJobId(),
      queueName: input.queueName,
      jobType: input.jobType,
      payload: input.payload,
      dedupeKey: input.dedupeKey,
      actorUserId: input.actorUserId,
      orgId: input.orgId,
      repoId: input.repoId,
      status: "queued"
    });

    await auditService.write(tx, {
      actorUserId: ctx.actor.userId,
      orgId: input.orgId,
      action: `job.${input.jobType}.created`,
      resourceId: job.id
    });

    await queueOutboxRepo.insert(tx, {
      jobId: job.id,
      queueName: input.queueName,
      payload: input.payload
    });

    return job;
  });
}
```

Then a dispatcher enqueues to BullMQ.

MVP shortcut:

```text
Insert background_jobs row inside transaction, then immediately enqueue BullMQ outside the transaction.
Also have a periodic reconciler for queued DB jobs missing BullMQ state.
```

### 14.2 Job dedupe examples

```text
repo sync:
  dedupeKey = github.sync_repository:${repoId}

repo reindex:
  dedupeKey = repo.index:${repoId}:${commitSha}:${indexerVersion}

PR review:
  dedupeKey = pr.review:${repoId}:${pullRequestNumber}:${headSha}

review rerun:
  no dedupe if explicit user command, unless same_snapshot+same parent run
```

---

## 15. Error handling

### 15.1 Error classes

Implement app-specific errors:

```ts
export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly message: string,
    public readonly status: number,
    public readonly details?: unknown
  ) {
    super(message);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Authentication required.") {
    super("auth.unauthorized", message, 401);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Permission denied.") {
    super("auth.forbidden", message, 403);
  }
}

export class NotFoundError extends AppError {
  constructor(code = "resource.not_found", message = "Resource not found.") {
    super(code, message, 404);
  }
}
```

### 15.2 Error taxonomy

Recommended codes:

```text
auth.unauthorized
auth.forbidden
auth.session_expired
auth.csrf_invalid

org.not_found
org.permission_denied

installation.not_found
installation.sync_failed

repo.not_found
repo.disabled
repo.settings_invalid
repo.reindex_already_queued

review_run.not_found
review_run.not_rerunnable
review_run.cancel_not_allowed

finding.not_found
finding.outcome_invalid

rule.not_found
rule.invalid

memory.not_found
memory.invalid

job.not_found
job.enqueue_failed

validation.invalid_request
rate_limit.exceeded
internal.error
```

### 15.3 Elysia error handler

```ts
export const errorHandlerPlugin = new Elysia({ name: "error-handler" })
  .onError(({ error, set, requestId }) => {
    if (error instanceof AppError) {
      set.status = error.status;
      return {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          requestId,
          details: sanitizeErrorDetails(error.details)
        }
      };
    }

    set.status = 500;
    return {
      ok: false,
      error: {
        code: "internal.error",
        message: "Internal server error.",
        requestId
      }
    };
  });
```

Do not expose raw stack traces in production.

---

## 16. Pagination, filtering, and sorting

Use cursor pagination for list endpoints.

Generic query:

```ts
type CursorPaginationQuery = {
  cursor?: string;
  limit?: number;
};
```

Generic response:

```ts
type PageInfo = {
  hasNextPage: boolean;
  nextCursor?: string;
};
```

Rules:

```text
- Default limit: 25
- Max limit: 100
- Cursor should be opaque
- Cursor should include sort key + stable tie-breaker ID
- Never expose SQL offsets for large tables
```

Example cursor payload before signing/base64url encoding:

```json
{
  "sort": "created_at_desc",
  "createdAt": "2026-04-25T18:30:00.000Z",
  "id": "rr_123"
}
```

---

## 17. Idempotency

Use idempotency for mutation routes that may be retried by clients.

Header:

```text
Idempotency-Key: <client-generated-key>
```

Apply to:

```text
POST /api/v1/repositories/:repoId/reindex
POST /api/v1/review-runs/:reviewRunId/rerun
POST /api/v1/findings/:findingId/suppress-similar
POST /api/v1/installations/:installationId/sync
```

Implementation:

```text
- hash method + path + actor + idempotency key
- store request hash and response body in idempotency_records
- if same key and same request hash, return stored response
- if same key but different request hash, return 409
```

---

## 18. Rate limiting

Rate limits should be conservative but not annoying.

Suggested buckets:

```text
Unauthenticated:
  60 requests/min/IP

Authenticated user:
  600 requests/min/user

State-changing authenticated routes:
  120 requests/min/user

Expensive command routes:
  20 requests/hour/org/repo for reindex/rerun

Internal routes:
  token-specific limits
```

Rate-limit keys:

```text
anonymous: ip hash
user: userId
org command: orgId + route group
repo command: repoId + route group
```

Return:

```text
HTTP 429
Retry-After: seconds
```

Error code:

```text
rate_limit.exceeded
```

---

## 19. Security headers

Set at minimum:

```text
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: no-referrer
Strict-Transport-Security: max-age=31536000; includeSubDomains; preload  # production HTTPS only
Content-Security-Policy: restrictive policy for any HTML/OpenAPI pages
```

Since most API responses are JSON, CSP mainly matters for OpenAPI/debug pages if served from API.

---

## 20. Audit logging

Audit all important state changes:

```text
auth.login
auth.logout
org.selected
installation.synced
repo.enabled
repo.disabled
repo.settings.updated
repo.sync.queued
repo.reindex.queued
rule.created
rule.updated
rule.deleted
review.rerun.queued
finding.outcome.updated
finding.suppression.created
memory.created
memory.updated
memory.deleted
admin.webhook.replayed
admin.job.retried
```

Audit log input:

```ts
type AuditLogInput = {
  actorUserId?: UserId;
  actorType: "user" | "system" | "internal";
  orgId?: OrgId;
  repoId?: RepoId;
  action: string;
  resourceType?: string;
  resourceId?: string;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
  requestId?: string;
  ipHash?: string;
  userAgentHash?: string;
};
```

Rules:

```text
- Redact secrets before audit logs.
- Store before/after diffs for settings/rules where useful.
- Never store raw session tokens, OAuth codes, GitHub installation tokens, or model provider keys.
```

---

## 21. Response caching and ETags

Most dashboard APIs can be uncached initially.

Optional later:

```text
GET /api/v1/review-runs/:id
GET /api/v1/repositories/:id
GET /api/v1/repositories/:id/settings
```

Use ETags for relatively stable resources:

```text
ETag: sha256(updatedAt + id + version)
If-None-Match: <etag>
```

Do not cache routes containing debug artifacts unless access is carefully controlled.

---

## 22. Data redaction

Before returning any debug/artifact data:

```text
- redact GitHub tokens
- redact OAuth codes
- redact session cookies
- redact Authorization headers
- redact known secret patterns
- redact env var-looking values
- optionally redact code snippets depending on org settings
```

Implement:

```text
/apps/api/src/utils/redaction.ts
/packages/observability/redaction.ts
```

Redaction should be used in:

```text
- logs
- audit metadata
- debug responses
- error details
- prompt/response artifacts shown to users
```

---

## 23. Observability

### 23.1 Logs

Log per request:

```text
requestId
method
path template, not raw full URL if query may contain secrets
status
latencyMs
actorUserId if authenticated
orgId if scoped
repoId if scoped
errorCode if failed
```

Do not log:

```text
raw cookies
Authorization headers
GitHub tokens
OAuth codes
full request bodies by default
raw model prompts by default
```

### 23.2 Metrics

Recommended API metrics:

```text
api_requests_total{method,route,status}
api_request_duration_ms{method,route,status}
api_errors_total{code,route}
api_auth_failures_total{reason}
api_rate_limited_total{bucket}
api_jobs_enqueued_total{jobType}
api_db_query_duration_ms{operation}
api_active_sessions_total
```

### 23.3 Tracing

Trace spans:

```text
api.request
  db.query
  access_control.check
  service.operation
  job_command.create
  queue.enqueue
  github.api_call if used
```

Always propagate `requestId` into job payload metadata:

```ts
type JobMetadata = {
  requestId?: string;
  actorUserId?: UserId;
  source: "api" | "webhook" | "system";
};
```

---

## 24. Testing strategy

### 24.1 Unit tests

Test:

```text
- auth service session creation/revocation
- OAuth state validation
- access-control permission matrix
- pagination cursor encoding/decoding
- idempotency behavior
- error mapping
- settings validation
- rule validation
```

### 24.2 Route tests

Use Elysia app directly in tests.

Examples:

```ts
const app = createApp();
const res = await app.handle(
  new Request("http://localhost/api/v1/me", {
    headers: { Cookie: makeTestSessionCookie(user) }
  })
);

expect(res.status).toBe(200);
```

Test route groups:

```text
health routes
unauthenticated auth routes
protected route rejects anonymous
protected route accepts valid session
org access denied for non-member
repo settings update requires admin
reindex returns 202 and creates durable job
review detail returns only accessible review
```

### 24.3 Integration tests

Use test Postgres and Redis.

Scenarios:

```text
- login creates session and user rows
- enable repo updates settings and writes audit log
- reindex creates background job and queue outbox row
- rerun review creates new review job linked to old run
- suppress finding creates memory/rule and audit log
```

### 24.4 Security tests

Test:

```text
- invalid session cookie rejected
- revoked session rejected
- expired session rejected
- CSRF required for browser mutation routes if using SameSite=None or cross-site flows
- redirectTo open redirect prevention
- users cannot access another org's repo
- platform admin routes reject org admins
- debug routes reject normal members
- secrets are redacted in errors/logs/debug responses
```

### 24.5 Contract tests

For each route:

```text
- sample request validates against schema
- sample response validates against schema
- invalid request returns validation.invalid_request
```

---

## 25. MVP implementation order

### PR 1: API shell

Implement:

```text
/apps/api package
createApp/index.ts
healthz/readyz/version routes
env loader
request ID plugin
error handler
response envelope helpers
basic logs
```

Definition of done:

```text
- API boots locally
- health checks pass
- test can call app.handle()
- request ID included in response
```

### PR 2: Auth/session foundation

Implement:

```text
user_sessions table if not present
session service
cookie helpers
requireAuth plugin
GET /api/v1/me
POST /api/v1/auth/logout
```

Definition of done:

```text
- test session works
- expired/revoked sessions rejected
- logout revokes session and clears cookie
```

### PR 3: GitHub OAuth login

Implement:

```text
GET /auth/github/start
GET /auth/github/callback
oauth_states storage
user upsert
provider account upsert
session creation
redirect safety
```

Definition of done:

```text
- local OAuth login works
- state is one-time-use
- open redirect tests pass
```

### PR 4: Org and installation APIs

Implement:

```text
GET /orgs
GET /orgs/:orgId
GET /installations
POST /installations/:id/sync
GET /github/install-url
GET /github/install-callback
```

Definition of done:

```text
- user sees accessible orgs/installations
- installation sync enqueues durable job
```

### PR 5: Repository APIs

Implement:

```text
GET /orgs/:orgId/repositories
GET /repositories/:repoId
PATCH /repositories/:repoId/settings
POST /repositories/:repoId/enable
POST /repositories/:repoId/disable
POST /repositories/:repoId/sync
POST /repositories/:repoId/reindex
```

Definition of done:

```text
- repo access is org-scoped
- settings update validates input
- enable/reindex creates audit logs and jobs
```

### PR 6: Review and finding APIs

Implement:

```text
GET /orgs/:orgId/review-runs
GET /repositories/:repoId/review-runs
GET /review-runs/:id
GET /review-runs/:id/findings
GET /findings/:id
PATCH /findings/:id/outcome
POST /review-runs/:id/rerun
```

Definition of done:

```text
- review history is visible
- outcomes are updateable
- rerun queues job
```

### PR 7: Rules and memory APIs

Implement:

```text
rule CRUD
memory CRUD
suppression helper route
```

Definition of done:

```text
- rule/memory writes are audited
- validator rejects unsafe or invalid rules
```

### PR 8: Usage and debug APIs

Implement:

```text
usage summary
debug artifact metadata
debug context/prompt access if permitted
redaction
```

Definition of done:

```text
- org usage summary visible
- debug routes gated
- redaction tests pass
```

### PR 9: Hardening

Implement:

```text
rate limiting
idempotency
OpenAPI docs
CORS restrictions
security headers
admin routes
full route test pass
```

Definition of done:

```text
- production-safe config
- OpenAPI generated
- all protected routes enforce auth/RBAC
```

---

## 26. Local development

Commands:

```bash
pnpm dev:api
pnpm test --filter @apps/api
pnpm typecheck --filter @apps/api
```

Environment:

```text
DATABASE_URL=postgres://...
REDIS_URL=redis://...
WEB_BASE_URL=http://localhost:3001
PUBLIC_API_BASE_URL=http://localhost:3000
SESSION_SECRET=...
GITHUB_APP_ID=...
GITHUB_APP_PRIVATE_KEY=...
GITHUB_WEBHOOK_SECRET=...
GITHUB_OAUTH_CLIENT_ID=...
GITHUB_OAUTH_CLIENT_SECRET=...
```

Local boot order:

```text
1. docker compose up postgres redis
2. pnpm db:migrate
3. pnpm dev:api
4. pnpm dev:web
```

---

## 27. Configuration flags

Recommended API config:

```ts
type ApiConfig = {
  env: "development" | "test" | "staging" | "production";
  port: number;
  publicApiBaseUrl: string;
  webBaseUrl: string;
  allowedOrigins: string[];
  enableOpenApi: boolean;
  enableDebugRoutes: boolean;
  enableAdminRoutes: boolean;
  sessionCookieName: string;
  sessionTtlDays: number;
  rateLimits: {
    enabled: boolean;
    anonymousPerMinute: number;
    authenticatedPerMinute: number;
    commandPerHour: number;
  };
};
```

Production defaults:

```text
enableOpenApi=false or admin-only
enableDebugRoutes=false unless explicitly needed
secure cookies=true
cors allowlist only
rate limits enabled
```

---

## 28. Common pitfalls to avoid

Avoid:

```text
- Running review/index jobs inside API handlers
- Returning raw DB rows
- Letting GitHub/Octokit response objects leak into API DTOs
- Trusting selectedOrgId without checking actual resource org
- Logging request bodies that may contain code or secrets
- Using wildcard CORS with credentials
- Storing session tokens in plaintext
- Storing OAuth codes or installation tokens in logs
- Exposing debug artifacts to normal members
- Mixing user session auth and internal service auth
- Implementing authorization only in frontend
- Using offset pagination for large tables
- Posting jobs to BullMQ without durable DB state
```

---

## 29. Definition of done for #5

#5 is complete when:

```text
- /apps/api boots with Bun + Elysia
- health/readiness/version endpoints work
- app has request IDs, logging, error envelope, and security headers
- GitHub OAuth login creates users and sessions
- protected routes reject anonymous/expired/revoked sessions
- org/repo access is RBAC-enforced
- repository settings can be read/updated
- repo enable/disable/sync/reindex APIs work
- review runs and findings can be listed/read
- review rerun queues a durable job
- rules and memory facts can be managed
- usage summary endpoint exists
- debug artifact access is gated and redacted
- OpenAPI docs work in dev/staging
- route tests cover auth, RBAC, validation, and job enqueueing
- state-changing routes write audit logs
- no expensive work happens in API request handlers
```

---

## 30. Suggested first API contracts to add to #0

If not already present, add these DTOs to `@repo/contracts`:

```text
ApiSuccess<T>
ApiError
PageInfo
CursorPaginationQuery
MeResponse
OrgDto
OrgMembershipDto
ProviderInstallationSummaryDto
RepositorySummaryDto
RepositoryDetailResponse
RepositorySettingsDto
UpdateRepositorySettingsRequest
EnqueueJobResponse
ReviewRunSummaryDto
ReviewRunDetailResponse
FindingDetailDto
UpdateFindingOutcomeRequest
RepoRuleDto
CreateRepoRuleRequest
UpdateRepoRuleRequest
MemoryFactDto
CreateMemoryFactRequest
UsageSummaryResponse
ReadinessResponse
VersionResponse
```

---

## 31. Reference implementation snippets

### 31.1 `ok` helper

```ts
export function ok<T>(data: T, meta?: ApiMeta): ApiSuccess<T> {
  return meta ? { ok: true, data, meta } : { ok: true, data };
}
```

### 31.2 Auth guard plugin pattern

```ts
export const requireAuth = new Elysia({ name: "require-auth" })
  .derive(async ({ cookie, requestId }) => {
    const token = cookie.car_session?.value;
    if (!token) throw new UnauthorizedError();

    const session = await sessionService.getSessionFromToken(token);
    if (!session) throw new UnauthorizedError("Invalid or expired session.");

    return {
      ctx: {
        requestId,
        actor: {
          type: "user",
          userId: session.userId,
          sessionId: session.sessionId
        },
        startedAt: Date.now()
      } satisfies RequestContext
    };
  });
```

### 31.3 Repository settings route

```ts
export const repositorySettingsRoutes = new Elysia({ name: "repository-settings" })
  .use(requireAuth)
  .patch(
    "/repositories/:repoId/settings",
    async ({ ctx, params, body }) => {
      const settings = await repositoryService.updateSettings(ctx, {
        repoId: params.repoId,
        patch: body
      });

      return ok({ settings });
    },
    {
      params: t.Object({ repoId: t.String() }),
      body: t.Object({
        reviewPolicy: t.Optional(t.Union([
          t.Literal("disabled"),
          t.Literal("summary_only"),
          t.Literal("inline_comments"),
          t.Literal("inline_comments_and_summary"),
          t.Literal("check_run_only"),
          t.Literal("inline_comments_summary_and_check_run")
        ])),
        maxCommentsPerReview: t.Optional(t.Number({ minimum: 0, maximum: 20 })),
        minimumSeverity: t.Optional(t.Union([
          t.Literal("low"),
          t.Literal("medium"),
          t.Literal("high"),
          t.Literal("critical")
        ])),
        ignoredPaths: t.Optional(t.Array(t.String({ maxLength: 500 }), { maxItems: 500 })),
        skipGeneratedFiles: t.Optional(t.Boolean())
      })
    }
  );
```

### 31.4 Reindex command route

```ts
export const reindexRoute = new Elysia({ name: "repo-reindex" })
  .use(requireAuth)
  .post(
    "/repositories/:repoId/reindex",
    async ({ ctx, params, body }) => {
      const job = await repositoryService.enqueueReindex(ctx, {
        repoId: params.repoId,
        commitSha: body.commitSha,
        force: body.force ?? false,
        reason: body.reason
      });

      return ok({ jobId: job.id, status: "queued" as const });
    },
    {
      params: t.Object({ repoId: t.String() }),
      body: t.Object({
        commitSha: t.Optional(t.String({ minLength: 7, maxLength: 64 })),
        force: t.Optional(t.Boolean()),
        reason: t.Optional(t.String({ maxLength: 500 }))
      })
    }
  );
```

---

## 32. API server mental model

The API server is a typed, authenticated, audited command/query layer:

```text
Dashboard request
  -> API route
  -> auth/session
  -> tenant/RBAC check
  -> service method
  -> DB query or durable job command
  -> typed response
```

It should be fast because it does not do heavy work.

It should be safe because every request has an actor, tenant scope, validation, and audit trail.

It should be easy to reason about because route handlers are thin and services operate on typed contracts.

---

## 33. External references

- Elysia OpenAPI plugin: https://elysiajs.com/plugins/openapi
- Elysia OpenAPI pattern: https://elysiajs.com/patterns/openapi
- Elysia Eden Treaty: https://elysiajs.com/eden/overview
- Elysia plugins: https://elysiajs.com/essential/plugin
- Elysia lifecycle and error handling: https://elysiajs.com/essential/life-cycle
- Elysia CORS plugin: https://elysiajs.com/plugins/cors
- Bun environment variables: https://bun.com/docs/runtime/environment-variables
