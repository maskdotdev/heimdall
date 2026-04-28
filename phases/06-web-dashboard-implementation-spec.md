# #6 Web Dashboard Implementation Spec

Version: `web_dashboard.v1`  
Date: 2026-04-28  
Owner: Product/App Platform  
Primary app: `/apps/web`  
Primary stack: TanStack Start, TanStack Router, TanStack Query, TanStack Form, TanStack Table, Tailwind, optional shadcn/ui/Radix primitives

---

## 1. Purpose

The web dashboard is the user-facing control plane for the AI code review product.

It should let users:

```text
- install/connect the GitHub App
- select an organization
- enable/disable repositories
- configure review behavior
- inspect review history
- inspect findings
- debug review runs
- manage rules and memory
- view usage/cost metrics
- manage members and access
- trigger safe, explicit background jobs
```

It should **not**:

```text
- clone repositories
- run indexers
- call LLMs directly
- perform PR reviews directly
- write directly to the database
- bypass the API server
- read secrets/tokens
- expose raw private code unless the user is authorized and the feature is explicitly enabled
```

The dashboard should feel like an operations console for a code review agent: fast, inspectable, low-noise, and built around reviewing the reviewer.

---

## 2. Design principles

### 2.1 The dashboard is a control plane

The dashboard configures and inspects the system. It does not do expensive work itself.

```text
Dashboard
  -> API server
  -> durable state / enqueue commands
  -> workers perform the work
  -> dashboard polls or streams status
```

The web app should never directly depend on:

```text
/packages/db
/packages/repo-sync
/packages/indexer-ts
/packages/review-engine internals
/packages/llm-gateway internals
```

It may depend on:

```text
/packages/contracts
/packages/api-client
/packages/ui
/packages/config
```

### 2.2 Every page is contract-driven

All data rendered in the dashboard should come from typed API DTOs defined in `/packages/contracts` or a dedicated `/packages/api-client` package.

Avoid this:

```ts
const review = await fetch('/api/reviews/' + id).then((r) => r.json())
```

Prefer this:

```ts
const review = await api.reviews.getReviewRun({ reviewRunId })
```

Where the result is runtime-validated at the API boundary and statically typed in the client.

### 2.3 Server state belongs to TanStack Query

The dashboard is mostly server state:

```text
repositories
review runs
findings
rules
memory facts
usage events
members
installations
background jobs
```

TanStack Query should own caching, invalidation, polling, optimistic updates, and error handling for API state.

Local React state should be limited to:

```text
open dialogs
selected tabs
draft form fields
local filters before committing to URL
small UI toggles
```

### 2.4 URL state should be meaningful

Tables and list pages should encode important state in the URL:

```text
/orgs/:orgSlug/reviews?repo=repo_123&status=completed&severity=high&page=2
```

This makes dashboard views shareable, debuggable, and reload-safe.

Prefer URL state for:

```text
- selected org
- selected repo
- filters
- search query
- pagination cursor/page
- selected tab
- time range
- sort order
```

### 2.5 The app should be inspectable by default

This product will need deep debugging. The dashboard should expose review artifacts clearly:

```text
- PR snapshot
- changed files
- context bundle
- candidate findings
- rejected findings
- validation reasons
- published findings
- model calls, if authorized
- token/cost/latency breakdown
- job timeline
```

The dashboard is not just a marketing UI. It is a tool for understanding why the reviewer behaved a certain way.

### 2.6 Redaction and permissions are product features

The dashboard may display private code context. Every view that can expose code, prompts, model outputs, or raw artifacts needs explicit authorization checks and careful redaction.

The UI should make it clear when content is:

```text
- redacted
- unavailable due to permissions
- unavailable due to retention policy
- unavailable because artifact storage is disabled
```

---

## 3. Recommended stack

Use:

```text
Framework:        TanStack Start
Routing:          TanStack Router file-based routes
Server state:     TanStack Query
Forms:            TanStack Form
Tables:           TanStack Table
Large lists:      TanStack Virtual
Styling:          Tailwind CSS
Components:       shadcn/ui or custom components using Radix primitives
Charts:           lightweight chart package, optional
Icons:            lucide-react
Validation:       schemas from /packages/contracts
API client:       /packages/api-client wrapper over Elysia API
Package manager:  pnpm, per #1
Build graph:      Turborepo, per #1
```

Why this stack:

```text
- TanStack Start keeps the app TypeScript-first and Router-powered.
- TanStack Router gives strong typed routing, params, and search state.
- TanStack Query gives predictable server-state management.
- TanStack Table/Virtual are a good fit for review history, repo lists, findings, and usage tables.
- Tailwind + shadcn/Radix lets us build a dashboard quickly while keeping design ownership.
```

Current docs describe TanStack Start as a full-stack React framework powered by TanStack Router with SSR, streaming, server functions, and Vite integration. TanStack Router supports type-safe routing and both file-based and code-based routing. TanStack Query is positioned as a server-state/data-fetching library for fetching, caching, synchronizing, and updating async data. Tailwind is a utility-first CSS framework.

Reference docs:

```text
https://tanstack.com/start/v0/docs/framework/react/overview
https://tanstack.com/router/latest/docs/overview
https://tanstack.com/query/v5/docs/framework/react/overview
https://tanstack.com/form/latest/docs/overview
https://tanstack.com/table/latest/docs/overview
https://tanstack.com/virtual/latest/docs/introduction
https://tailwindcss.com/
https://ui.shadcn.com/
https://www.radix-ui.com/primitives/docs/overview/introduction
```

---

## 4. Relationship to #5 API Server

The API server owns:

```text
- authentication/session issuance
- authorization/RBAC enforcement
- GitHub OAuth callbacks
- GitHub App install callbacks
- org/repo data
- repo settings mutations
- review run queries
- background job commands
- audit logs
- usage data
```

The web dashboard owns:

```text
- rendering
- navigation
- form UX
- table UX
- client-side caching
- optimistic UI where safe
- polling/refresh behavior
- debug visualization
```

The dashboard should call API routes like:

```text
GET    /v1/me
GET    /v1/orgs
GET    /v1/orgs/:orgId
GET    /v1/orgs/:orgId/repositories
GET    /v1/repositories/:repoId
PATCH  /v1/repositories/:repoId/settings
GET    /v1/reviews
GET    /v1/reviews/:reviewRunId
GET    /v1/reviews/:reviewRunId/artifacts
POST   /v1/reviews/:reviewRunId/replay
GET    /v1/rules
POST   /v1/rules
PATCH  /v1/rules/:ruleId
DELETE /v1/rules/:ruleId
GET    /v1/memory
PATCH  /v1/memory/:memoryFactId
GET    /v1/usage
GET    /v1/jobs/:jobId
```

The dashboard should not assume internal table names. API responses should be view-oriented DTOs.

---

## 5. App package structure

Implement `/apps/web` like this:

```text
/apps/web
  package.json
  app.config.ts
  vite.config.ts
  tsconfig.json
  src
    app.tsx
    client.tsx
    router.tsx
    routeTree.gen.ts
    styles.css

    routes
      __root.tsx
      index.tsx
      login.tsx
      logout.tsx
      install.tsx
      install.callback.tsx
      auth.callback.tsx

      _authenticated.tsx
      _authenticated.index.tsx
      _authenticated.orgs.tsx
      _authenticated.orgs.$orgSlug.tsx
      _authenticated.orgs.$orgSlug.index.tsx
      _authenticated.orgs.$orgSlug.repositories.tsx
      _authenticated.orgs.$orgSlug.repositories.$repoId.tsx
      _authenticated.orgs.$orgSlug.repositories.$repoId.settings.tsx
      _authenticated.orgs.$orgSlug.repositories.$repoId.reviews.tsx
      _authenticated.orgs.$orgSlug.repositories.$repoId.reviews.$reviewRunId.tsx
      _authenticated.orgs.$orgSlug.reviews.tsx
      _authenticated.orgs.$orgSlug.reviews.$reviewRunId.tsx
      _authenticated.orgs.$orgSlug.findings.tsx
      _authenticated.orgs.$orgSlug.rules.tsx
      _authenticated.orgs.$orgSlug.memory.tsx
      _authenticated.orgs.$orgSlug.usage.tsx
      _authenticated.orgs.$orgSlug.members.tsx
      _authenticated.orgs.$orgSlug.admin.tsx

    components
      app-shell
      auth
      command-menu
      common
      code
      findings
      forms
      jobs
      layout
      memory
      navigation
      repositories
      reviews
      rules
      settings
      tables
      usage

    features
      auth
      orgs
      repositories
      reviews
      findings
      rules
      memory
      usage
      jobs
      debug

    lib
      api.ts
      auth.ts
      env.ts
      query-client.ts
      query-keys.ts
      route-guards.ts
      format.ts
      dates.ts
      permissions.ts
      search-params.ts
      errors.ts
      telemetry.ts

    test
      fixtures
      render.tsx
      msw
        handlers.ts
        server.ts
```

### 5.1 Recommended package dependencies

```json
{
  "dependencies": {
    "@repo/contracts": "workspace:*",
    "@repo/api-client": "workspace:*",
    "@tanstack/react-start": "latest",
    "@tanstack/react-router": "latest",
    "@tanstack/react-query": "latest",
    "@tanstack/react-form": "latest",
    "@tanstack/react-table": "latest",
    "@tanstack/react-virtual": "latest",
    "tailwindcss": "latest",
    "lucide-react": "latest",
    "clsx": "latest",
    "tailwind-merge": "latest",
    "date-fns": "latest"
  },
  "devDependencies": {
    "@testing-library/react": "latest",
    "@testing-library/user-event": "latest",
    "jsdom": "latest",
    "msw": "latest",
    "vitest": "latest"
  }
}
```

Add shadcn/ui-generated components directly under:

```text
/apps/web/src/components/ui
```

or use a shared package:

```text
/packages/ui
```

If this is a single app for now, keep UI components inside `/apps/web`. Extract to `/packages/ui` only when another app needs them.

---

## 6. Route architecture

Use TanStack Router file-based routing.

Core route groups:

```text
public routes
  /
  /login
  /auth/callback
  /install
  /install/callback

protected routes
  /orgs
  /orgs/:orgSlug
  /orgs/:orgSlug/repositories
  /orgs/:orgSlug/repositories/:repoId
  /orgs/:orgSlug/reviews
  /orgs/:orgSlug/reviews/:reviewRunId
  /orgs/:orgSlug/findings
  /orgs/:orgSlug/rules
  /orgs/:orgSlug/memory
  /orgs/:orgSlug/usage
  /orgs/:orgSlug/members
  /orgs/:orgSlug/admin
```

### 6.1 Root route

`src/routes/__root.tsx`

Responsibilities:

```text
- global HTML shell
- QueryClient provider
- router context
- theme provider
- toast provider
- error boundary
- not-found boundary
- global styles
```

Pseudo-code:

```tsx
import { Outlet, createRootRouteWithContext } from '@tanstack/react-router'
import { QueryClient } from '@tanstack/react-query'

export type RouterContext = {
  queryClient: QueryClient
  auth: AuthClient
  api: ApiClient
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
  errorComponent: RootErrorBoundary,
  notFoundComponent: NotFoundPage,
})

function RootLayout() {
  return (
    <html lang="en">
      <head />
      <body>
        <Outlet />
      </body>
    </html>
  )
}
```

### 6.2 Authenticated layout route

`src/routes/_authenticated.tsx`

Responsibilities:

```text
- require session
- load current user
- load org list
- render app shell
- handle org switcher
- handle global navigation
```

Pseudo-code:

```tsx
export const Route = createFileRoute('/_authenticated')({
  beforeLoad: async ({ context }) => {
    const session = await context.auth.getSession()

    if (!session) {
      throw redirect({ to: '/login' })
    }

    return { session }
  },
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(meQuery()),
      context.queryClient.ensureQueryData(orgsQuery()),
    ])
  },
  component: AuthenticatedLayout,
})
```

### 6.3 Org layout route

`src/routes/_authenticated.orgs.$orgSlug.tsx`

Responsibilities:

```text
- validate org slug
- load org summary
- load user's role in org
- render org navigation
- enforce org-level permission checks
```

URL:

```text
/orgs/:orgSlug
```

### 6.4 Repository layout route

`src/routes/_authenticated.orgs.$orgSlug.repositories.$repoId.tsx`

Responsibilities:

```text
- load repository detail
- display repo header
- display repo navigation tabs
- enforce repo access
```

Tabs:

```text
Overview
Settings
Reviews
Rules
Memory
Debug
```

---

## 7. Page inventory

### 7.1 Public landing page

Route:

```text
/
```

Purpose:

```text
- explain product value briefly
- link to login
- link to install GitHub App
```

MVP content:

```text
- Hero
- 3 value cards
- CTA: Continue with GitHub
```

This can be very simple. The first product version does not need a polished marketing site.

---

### 7.2 Login page

Route:

```text
/login
```

Actions:

```text
- Continue with GitHub
- show auth errors
- redirect authenticated users to /orgs
```

States:

```text
- default
- loading
- OAuth error
- already authenticated
```

---

### 7.3 GitHub auth callback page

Route:

```text
/auth/callback
```

Responsibilities:

```text
- exchange callback state/code via API server
- handle errors
- redirect to intended destination
```

Important:

The web app should not handle GitHub OAuth secrets. The API server owns the OAuth exchange. The dashboard should only show progress/errors and let the API set an HTTP-only session cookie.

---

### 7.4 Install page

Route:

```text
/install
```

Purpose:

```text
- start GitHub App installation
- explain permissions
- show already-installed orgs
```

Actions:

```text
- Install GitHub App
- Manage existing installation
```

---

### 7.5 Install callback page

Route:

```text
/install/callback
```

Responsibilities:

```text
- receive installation_id/setup_action from GitHub redirect
- ask API to sync installation
- show progress
- redirect to org/repo onboarding
```

States:

```text
- syncing installation
- install successful
- install failed
- missing permissions
- installation belongs to org user cannot access
```

---

### 7.6 Org selection page

Route:

```text
/orgs
```

Purpose:

```text
- list orgs user can access
- show GitHub installation status
- route into selected org
```

Columns:

```text
Org
Provider
Role
Repositories enabled
Reviews this month
Status
```

Actions:

```text
Open org
Install GitHub App
```

---

### 7.7 Org overview page

Route:

```text
/orgs/:orgSlug
```

Purpose:

Show high-level health of the reviewer for this org.

Cards:

```text
- enabled repositories
- review runs this week
- findings published
- average time to review
- estimated monthly cost
- failed jobs
```

Tables:

```text
- latest review runs
- repositories needing setup
- recent high-severity findings
```

Actions:

```text
Enable repositories
View review history
Configure org rules
```

---

### 7.8 Repository list page

Route:

```text
/orgs/:orgSlug/repositories
```

Purpose:

Manage repositories connected to the product.

Filters/search:

```text
- search by repo name
- enabled/disabled
- provider
- language
- indexing status
- review mode
```

Columns:

```text
Repository
Enabled
Default branch
Languages
Index status
Last indexed
Review mode
Last review
Actions
```

Actions:

```text
Enable
Disable
Open settings
Trigger reindex
View reviews
```

Important UX:

```text
- bulk enable/disable selected repos
- warning for large repos before enabling
- status badge for indexing/review failures
```

Data:

```ts
export type RepositoryListItem = {
  repoId: RepoId
  orgId: OrgId
  provider: ProviderKind
  fullName: string
  defaultBranch: string | null
  enabled: boolean
  visibility: 'public' | 'private' | 'internal'
  languages: LanguageId[]
  indexStatus: IndexStatus
  lastIndexedAt: IsoDateTime | null
  reviewPolicy: ReviewPolicy
  lastReviewRunAt: IsoDateTime | null
}
```

---

### 7.9 Repository overview page

Route:

```text
/orgs/:orgSlug/repositories/:repoId
```

Purpose:

Show repo-specific health.

Cards:

```text
- enabled/disabled
- current index version
- latest review run
- total findings
- unresolved high-severity findings
- review mode
```

Sections:

```text
- recent PR reviews
- indexing history
- top finding categories
- repo rules summary
- memory facts summary
```

Actions:

```text
Run test review
Reindex default branch
Open settings
View debug artifacts
```

---

### 7.10 Repository settings page

Route:

```text
/orgs/:orgSlug/repositories/:repoId/settings
```

Purpose:

Configure repository-specific behavior.

Settings sections:

```text
General
  - enabled
  - review mode
  - default severity threshold
  - max comments per PR

Triggers
  - review opened PRs
  - review synchronize events
  - review reopened PRs
  - review only when label exists
  - skip draft PRs
  - skip bot-authored PRs

Scope
  - ignored paths
  - included paths
  - generated file behavior
  - max PR files
  - max PR diff bytes

Review categories
  - correctness
  - security
  - tests
  - performance
  - architecture
  - maintainability

Publishing
  - inline comments enabled
  - PR summary enabled
  - check run enabled
  - summary-only mode

Models
  - model profile
  - allow provider fallback
  - prompt logging mode
  - code context retention mode

Debug
  - store context bundles
  - store rejected findings
  - store prompts/responses, redacted
```

Use form schema from contracts:

```ts
RepositorySettingsUpdateSchema
```

Settings UX requirements:

```text
- show inherited org defaults
- show repo overrides separately
- allow resetting to org defaults
- validate paths before save
- confirm dangerous changes
- optimistic update only for safe toggles
```

---

### 7.11 Review history page

Routes:

```text
/orgs/:orgSlug/reviews
/orgs/:orgSlug/repositories/:repoId/reviews
```

Purpose:

List review runs.

Filters:

```text
- repository
- status
- PR number
- author
- branch
- severity
- finding category
- date range
- model profile
- has failures
```

Columns:

```text
PR
Repository
Status
Findings
Published
Rejected
Cost
Duration
Created
Updated
Actions
```

Useful badges:

```text
queued
fetching_snapshot
ensuring_index
retrieving_context
reviewing
validating
publishing
completed
failed
canceled
skipped
```

Actions:

```text
Open review run
Open GitHub PR
Replay review
Cancel queued review
View logs
```

Performance:

```text
- server-side pagination
- URL-backed filters
- TanStack Table for table model
- optional TanStack Virtual for large visible lists
```

---

### 7.12 Review run detail page

Route:

```text
/orgs/:orgSlug/reviews/:reviewRunId
```

or repo-scoped:

```text
/orgs/:orgSlug/repositories/:repoId/reviews/:reviewRunId
```

This is one of the most important pages.

Purpose:

```text
Show exactly what happened during one review.
```

Header:

```text
PR title
Repository
PR number
Review status
Head/base SHA
Created time
Duration
Cost
Open in GitHub
Replay button
```

Tabs:

```text
Summary
Findings
Context
Diff
Jobs
LLM Calls
Artifacts
Timeline
```

#### Summary tab

Show:

```text
- PR metadata
- review status
- published finding count
- rejected candidate count
- categories/severities
- cost/tokens/latency
- high-level review summary
- failure reason if failed
```

#### Findings tab

Sections:

```text
Published findings
Validated but not published findings
Rejected findings
```

For each finding:

```text
- title
- severity
- category
- source
- file:line
- confidence
- evidence
- suggested fix
- validation details
- GitHub comment link if published
```

Need filters:

```text
severity
category
published/rejected
source
validation reason
```

#### Context tab

Show the context bundle used by the model.

Group by context kind:

```text
Changed code
Same-file context
Imports/dependencies
Callers/callees
Related tests
Similar patterns
Repo rules
Memory facts
Diagnostics
```

For each context item:

```text
- why it was included
- source kind
- path/range
- token estimate
- relevance score
- redacted/unredacted status
```

Important: context visibility must respect permissions and retention settings.

#### Diff tab

Show normalized PR diff.

Requirements:

```text
- file list sidebar
- changed lines highlighted
- ability to click a finding and jump to line
- show comment anchors
- support renamed/deleted files
- graceful fallback for huge diffs
```

MVP can use a simple preformatted diff renderer. Later, use a dedicated diff viewer.

#### Jobs tab

Show worker/job timeline:

```text
webhook received
review job enqueued
snapshot fetched
index ensured
context retrieved
LLM passes completed
findings validated
publish completed
```

For each step:

```text
- status
- start/end timestamps
- duration
- retry count
- error details
```

#### LLM Calls tab

Only visible to authorized admins or debug-enabled orgs.

Show:

```text
- call name
- provider
- model
- prompt version
- input tokens
- output tokens
- cost estimate
- latency
- status
- redaction status
```

Prompt/body display should be gated.

#### Artifacts tab

Show artifact refs:

```text
- PR snapshot
- context bundle
- candidate findings
- validated findings
- rejected findings
- published review
- raw webhook event
```

Actions:

```text
Download artifact
Copy artifact ID
Replay from artifact
```

#### Timeline tab

Unified timeline:

```text
webhook events
jobs
status transitions
GitHub comments
user feedback
memory updates
```

---

### 7.13 Findings page

Route:

```text
/orgs/:orgSlug/findings
```

Purpose:

Org-wide finding analytics and search.

Filters:

```text
repository
severity
category
source
published status
outcome
date range
author
language
```

Columns:

```text
Finding
Severity
Category
Repository
PR
Status
Outcome
Confidence
Created
```

Actions:

```text
Open finding detail
Open review run
Open GitHub comment
Create suppression rule
Mark false positive
```

Finding detail drawer:

```text
- full body
- evidence
- related code snippet
- validation result
- outcome history
- memory/rule effects
```

---

### 7.14 Rules page

Route:

```text
/orgs/:orgSlug/rules
```

Purpose:

Manage explicit org/repo rules.

Rule types:

```text
path_ignore
path_include
finding_suppression
review_instruction
severity_override
category_disable
model_setting
publish_setting
```

Rule fields:

```ts
type RepoRuleView = {
  ruleId: string
  scope: 'org' | 'repository'
  repoId: string | null
  kind: RepoRuleKind
  enabled: boolean
  title: string
  description: string | null
  pattern: string | null
  value: unknown
  createdBy: UserSummary
  createdAt: string
  updatedAt: string
}
```

UX:

```text
- create rule dialog
- edit rule dialog
- enable/disable toggle
- dry-run path pattern matching
- show which repos inherit a rule
- show recent reviews affected by rule
```

Rules should be explicit and inspectable. Do not hide memory-derived behavior inside opaque prompts.

---

### 7.15 Memory page

Route:

```text
/orgs/:orgSlug/memory
```

Purpose:

Show learned preferences and suppression facts.

Memory fact categories:

```text
review_preference
suppression
repo_convention
framework_convention
security_assumption
style_preference
feedback_summary
```

Fields:

```text
Fact
Scope
Confidence
Source
Times reinforced
Last used
Expires at
Enabled
```

Actions:

```text
Disable memory fact
Edit memory fact
Promote memory fact to explicit rule
Delete memory fact
View source feedback
```

Important UX:

Memory should never feel spooky. The user should be able to see:

```text
- why the system believes something
- when it last affected a review
- how to disable it
```

---

### 7.16 Usage page

Route:

```text
/orgs/:orgSlug/usage
```

Purpose:

Show usage and cost.

Charts/cards:

```text
- review runs by day
- indexed repositories
- indexed chunks
- embedding tokens
- LLM input/output tokens
- estimated cost
- cost by repository
- cost by model
- failed job count
```

Tables:

```text
usage events
model calls
expensive reviews
large repos
```

Filters:

```text
repository
time range
event type
model
```

MVP can show simple cards and tables; charts can come later.

---

### 7.17 Members page

Route:

```text
/orgs/:orgSlug/members
```

Purpose:

Manage org access.

Fields:

```text
User
Email/GitHub username
Role
Last active
Provider account
```

Roles:

```text
owner
admin
maintainer
viewer
billing
```

Actions:

```text
Invite member
Change role
Remove member
```

MVP may make this read-only if membership is derived from GitHub org access.

---

### 7.18 Admin/debug page

Route:

```text
/orgs/:orgSlug/admin
```

Visible only to internal admins and org owners.

Sections:

```text
System status
Webhook deliveries
Background jobs
Failed jobs
Installation status
Provider tokens status
Artifact retention
Danger zone
```

Actions:

```text
Sync GitHub installation
Sync repositories
Reindex selected repositories
Replay webhook
Replay review
Cancel job
Delete stored artifacts
Disable org
```

All actions must write audit logs.

---

## 8. App shell and navigation

The authenticated app shell should have:

```text
Top bar
  - product logo
  - org switcher
  - global search/command menu
  - notifications/job status
  - user menu

Sidebar
  - Overview
  - Repositories
  - Reviews
  - Findings
  - Rules
  - Memory
  - Usage
  - Members
  - Admin

Main content
  - page header
  - breadcrumbs
  - primary actions
  - content area
```

### 8.1 Command menu

Implement a command menu early if possible.

Commands:

```text
Search repositories
Search review runs
Search PR number
Go to settings
Create rule
View failed jobs
Install GitHub App
```

Shortcut:

```text
Cmd/Ctrl + K
```

MVP can support navigation-only commands.

### 8.2 Breadcrumbs

Example:

```text
Acme Org / repositories / acme/api / reviews / #1432
```

Breadcrumbs help with nested debug views.

---

## 9. Data fetching architecture

### 9.1 Query client setup

`src/lib/query-client.ts`

```ts
import { QueryClient } from '@tanstack/react-query'

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => {
          if (isAuthError(error)) return false
          if (isPermissionError(error)) return false
          return failureCount < 2
        },
      },
      mutations: {
        retry: false,
      },
    },
  })
}
```

### 9.2 Query key factory

`src/lib/query-keys.ts`

```ts
export const qk = {
  me: () => ['me'] as const,
  orgs: () => ['orgs'] as const,
  org: (orgId: string) => ['org', orgId] as const,

  repositories: (orgId: string, filters: RepositoryFilters) =>
    ['org', orgId, 'repositories', filters] as const,

  repository: (repoId: string) => ['repository', repoId] as const,

  reviewRuns: (orgId: string, filters: ReviewRunFilters) =>
    ['org', orgId, 'review-runs', filters] as const,

  reviewRun: (reviewRunId: string) => ['review-run', reviewRunId] as const,

  reviewArtifacts: (reviewRunId: string) =>
    ['review-run', reviewRunId, 'artifacts'] as const,

  findings: (orgId: string, filters: FindingFilters) =>
    ['org', orgId, 'findings', filters] as const,

  rules: (orgId: string) => ['org', orgId, 'rules'] as const,
  memory: (orgId: string, filters: MemoryFilters) => ['org', orgId, 'memory', filters] as const,
  usage: (orgId: string, filters: UsageFilters) => ['org', orgId, 'usage', filters] as const,
}
```

### 9.3 Query definitions

Create query helpers per feature:

```text
src/features/repositories/queries.ts
src/features/reviews/queries.ts
src/features/rules/queries.ts
src/features/memory/queries.ts
```

Example:

```ts
export function repositoriesQuery(orgId: string, filters: RepositoryFilters) {
  return {
    queryKey: qk.repositories(orgId, filters),
    queryFn: () => api.repositories.list({ orgId, ...filters }),
  }
}
```

### 9.4 Mutation invalidation

Example for repo settings:

```ts
export function useUpdateRepositorySettings(repoId: string, orgId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: RepositorySettingsUpdate) =>
      api.repositories.updateSettings({ repoId, input }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: qk.repository(repoId) })
      queryClient.invalidateQueries({ queryKey: ['org', orgId, 'repositories'] })
    },
  })
}
```

### 9.5 Polling behavior

Use polling only where useful.

Poll review runs while active:

```ts
const activeStatuses = new Set([
  'queued',
  'fetching_snapshot',
  'ensuring_index',
  'retrieving_context',
  'reviewing',
  'validating',
  'publishing',
])

export function reviewRunQuery(reviewRunId: string) {
  return {
    queryKey: qk.reviewRun(reviewRunId),
    queryFn: () => api.reviews.get({ reviewRunId }),
    refetchInterval: (query) => {
      const status = query.state.data?.status
      return status && activeStatuses.has(status) ? 2_000 : false
    },
  }
}
```

Poll background jobs while active. Do not poll static pages aggressively.

### 9.6 Server loaders

Use route loaders to prefetch important data for routes. Keep them simple and avoid doing heavy work.

Examples:

```text
authenticated layout: me + orgs
org layout: org summary
repo layout: repository detail
review detail: review run summary
```

---

## 10. API client

Create:

```text
/packages/api-client
```

or, for MVP:

```text
/apps/web/src/lib/api.ts
```

Recommended client shape:

```ts
export type ApiClient = {
  me: {
    get(): Promise<MeResponse>
  }
  orgs: {
    list(): Promise<ListOrgsResponse>
    get(input: { orgId: string }): Promise<GetOrgResponse>
  }
  repositories: {
    list(input: ListRepositoriesInput): Promise<ListRepositoriesResponse>
    get(input: { repoId: string }): Promise<GetRepositoryResponse>
    updateSettings(input: {
      repoId: string
      patch: RepositorySettingsPatch
    }): Promise<UpdateRepositorySettingsResponse>
  }
  reviews: {
    list(input: ListReviewRunsInput): Promise<ListReviewRunsResponse>
    get(input: { reviewRunId: string }): Promise<GetReviewRunResponse>
    artifacts(input: { reviewRunId: string }): Promise<GetReviewArtifactsResponse>
    replay(input: { reviewRunId: string }): Promise<ReplayReviewResponse>
  }
}
```

### 10.1 Client requirements

```text
- sends credentials/cookies
- parses JSON
- maps API errors to typed errors
- supports abort signals
- validates response if validation is enabled
- never logs tokens
- attaches request IDs where appropriate
```

Example:

```ts
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await fetch(`${env.API_BASE_URL}${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  })

  const requestId = response.headers.get('x-request-id')

  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw mapApiError(response.status, body, requestId)
  }

  return response.json() as Promise<T>
}
```

### 10.2 Error model

The API should return a standard error body:

```ts
type ApiErrorBody = {
  error: {
    code: string
    message: string
    details?: unknown
    requestId?: string
  }
}
```

The UI should distinguish:

```text
401 unauthenticated -> redirect to login
403 unauthorized -> permission denied page/card
404 not found -> not found page/card
409 conflict -> show conflict message
422 validation -> show field errors if applicable
429 rate limit -> show retry guidance
500 internal -> show request ID and support/debug link
```

---

## 11. Authentication and session UX

### 11.1 Session model

The dashboard should assume the API server sets an HTTP-only session cookie.

Web app session API:

```text
GET /v1/me
```

Response:

```ts
type MeResponse = {
  user: {
    userId: string
    displayName: string
    email: string | null
    avatarUrl: string | null
  }
  orgs: Array<{
    orgId: string
    slug: string
    displayName: string
    role: OrgRole
  }>
}
```

### 11.2 Route guard behavior

Unauthenticated:

```text
protected route -> /login?redirect=<current-path>
```

Authenticated without orgs:

```text
/orgs -> empty state with install CTA
```

Authenticated without access to org:

```text
403 page/card
```

### 11.3 Logout

Route:

```text
/logout
```

Action:

```text
POST /v1/auth/logout
clear query cache
redirect to /login
```

### 11.4 GitHub install vs user login

Do not conflate:

```text
User login: user identity/session
GitHub App installation: org/repo integration
```

A user may be logged in but not have an installation. An installation may exist for an org but the user may not have access to manage it.

The UI should make this distinction clear.

---

## 12. Authorization and permissions in the UI

The API enforces permissions. The UI uses permissions to show/hide actions and explain disabled states.

Suggested permissions:

```text
org.view
org.manage_members
org.manage_billing
repo.view
repo.configure
repo.enable_disable
repo.trigger_review
repo.trigger_reindex
review.view
review.debug
review.replay
rule.manage
memory.manage
usage.view
admin.view
```

User-facing behavior:

```text
- hide actions the user can never perform
- disable actions the user can perform only after setup
- explain disabled actions with tooltips/help text
- never rely on UI gating for security
```

Example:

```tsx
<Button disabled={!can(user, 'repo.configure', repo)}>
  Save settings
</Button>
```

---

## 13. UI component system

### 13.1 Component categories

```text
components/ui
  Button
  Input
  Textarea
  Select
  Checkbox
  Switch
  Badge
  Card
  Dialog
  DropdownMenu
  Tooltip
  Tabs
  Table primitives
  Toast
  Skeleton
  Alert
  CodeBlock

components/layout
  AppShell
  Sidebar
  Topbar
  Breadcrumbs
  PageHeader
  SectionHeader
  EmptyState
  ErrorState
  LoadingState

components/domain
  RepositoryBadge
  ReviewStatusBadge
  SeverityBadge
  FindingCategoryBadge
  JobStatusBadge
  CostBadge
  ProviderIcon
  GitHubLink
```

### 13.2 Design tokens

Use semantic classes or CSS variables:

```text
--background
--foreground
--muted
--muted-foreground
--border
--card
--card-foreground
--primary
--primary-foreground
--danger
--warning
--success
```

Severity colors should be semantic:

```text
critical
high
medium
low
info
```

Do not hard-code hex values throughout components.

### 13.3 Layout density

This dashboard is information-heavy. Use compact but readable layouts.

Recommended density:

```text
- card padding: moderate
- tables: compact rows, optional density toggle later
- code/diff: monospace, line numbers, sticky headers
- debug artifacts: collapsible sections
```

---

## 14. Forms

Use TanStack Form or a well-supported form library. Since the rest of the app is TanStack-oriented, TanStack Form is a good fit.

Common forms:

```text
Repository settings form
Rule create/edit form
Memory fact edit form
Member invite form
Review replay form
Bulk repo action form
```

### 14.1 Repository settings form

Features:

```text
- initialize from API response
- show inherited defaults
- validate before submit
- unsaved changes prompt
- save bar fixed at bottom
- reset changes
- reset to org default
```

Pseudo-code:

```tsx
const form = useForm({
  defaultValues: repository.settings,
  validators: {
    onSubmit: repositorySettingsUpdateValidator,
  },
  onSubmit: async ({ value }) => {
    await updateSettings.mutateAsync(value)
  },
})
```

### 14.2 Field validation

Field-level examples:

```text
max comments per PR: integer 0..20
severity threshold: low/medium/high/critical
ignored paths: valid glob patterns
review labels: non-empty strings
```

### 14.3 Dirty state

For settings pages, show:

```text
You have unsaved changes
Save
Discard
```

Warn on navigation away if dirty.

---

## 15. Tables and lists

Use TanStack Table for table state and rendering.

Tables needed:

```text
repositories table
review runs table
findings table
rules table
memory facts table
usage events table
model calls table
background jobs table
```

### 15.1 Server-side tables

Most tables should be server-side for filtering/pagination.

State stored in URL:

```ts
type ReviewRunsSearch = {
  repoId?: string
  status?: ReviewRunStatus[]
  severity?: FindingSeverity[]
  page?: number
  limit?: number
  sort?: string
}
```

TanStack Table should own display state; API owns actual pagination/filtering.

### 15.2 Empty states

Each table needs useful empty states.

Examples:

```text
No repositories enabled yet -> CTA to enable repos
No reviews yet -> Explain reviews run on PR open/update
No findings -> Good state, not failure
No rules -> CTA to create first rule
No memory -> Explain memory learns from feedback later
```

### 15.3 Row actions

Use consistent row action menu:

```text
Open
Open in GitHub
Copy ID
Replay
Reindex
Disable
```

Dangerous actions should be separated and confirmed.

---

## 16. Code, diff, and artifact rendering

This product has a lot of code-adjacent UI.

### 16.1 Code snippets

Component:

```text
CodeSnippetCard
```

Props:

```ts
type CodeSnippetCardProps = {
  path: string
  startLine: number
  endLine: number
  language: string | null
  code: string
  reason?: string
  relevanceScore?: number
  redacted?: boolean
}
```

Display:

```text
path:line-range
reason included
line numbers
copy path
copy snippet
open in GitHub if URL available
```

### 16.2 Diff viewer

MVP:

```text
- render unified diff as monospace blocks
- file sections collapsible
- changed lines highlighted by prefix
- finding anchors shown inline or in gutter
```

Later:

```text
- side-by-side diff
- syntax highlighting
- virtualized diff rendering
- jump-to-finding
- line hover actions
```

### 16.3 Artifact viewer

Artifacts may be JSON.

Component:

```text
ArtifactViewer
```

Features:

```text
- summary view
- raw JSON view
- copy JSON
- download artifact
- redaction notice
- schema version badge
```

Large artifacts should be paginated or loaded on demand.

---

## 17. Review status model in UI

Use a clear visual status system.

Review run statuses:

```text
queued
fetching_snapshot
ensuring_index
retrieving_context
reviewing
validating
publishing
completed
failed
canceled
skipped
```

Display groups:

```text
pending: queued
active: fetching_snapshot, ensuring_index, retrieving_context, reviewing, validating, publishing
success: completed
neutral: skipped, canceled
error: failed
```

Status component:

```tsx
<ReviewStatusBadge status={review.status} />
```

Status detail should show:

```text
current phase
last transition time
duration so far
failure reason if any
```

---

## 18. UX for background jobs

Many dashboard actions enqueue jobs:

```text
sync installation
sync repositories
reindex repo
replay review
trigger review
publish retry
memory update
```

When a user triggers a job:

```text
1. API creates durable job
2. UI shows toast with job status link
3. relevant query invalidates
4. job detail can be polled
```

Toast example:

```text
Reindex queued for acme/api. View job.
```

Job detail drawer:

```text
Job ID
Type
Status
Created
Started
Completed
Retry count
Error
Related entity
```

---

## 19. Onboarding flow

MVP onboarding:

```text
1. User logs in with GitHub
2. User installs GitHub App
3. App syncs installation/repositories
4. User selects repositories to enable
5. User chooses review mode
6. App queues initial indexing
7. Dashboard shows repository setup status
```

Route flow:

```text
/login
  -> /install
  -> /install/callback
  -> /orgs/:orgSlug/repositories?onboarding=1
  -> enable repos
  -> /orgs/:orgSlug
```

Onboarding repository table should show:

```text
repo name
private/public
primary language
estimated size if available
recommended enablement
```

Initial review policies:

```text
summary_only
inline_comments_and_summary
check_run_only
disabled
```

---

## 20. Settings inheritance model

Settings may exist at multiple scopes:

```text
system default
org default
repository override
```

The UI should show this clearly.

Example:

```text
Max comments per PR
Current: 5
Inherited from org default
[Override]
```

After override:

```text
Max comments per PR
Repository override: 8
Org default: 5
[Reset to org default]
```

Do not make users guess whether they are editing org-level or repo-level settings.

---

## 21. Search and filtering

### 21.1 Global search

Search categories:

```text
repositories
review runs
pull requests
findings
rules
memory facts
```

MVP can implement only:

```text
repositories
review runs by PR number/title
```

### 21.2 Filter components

Reusable components:

```text
RepoFilter
StatusFilter
SeverityFilter
CategoryFilter
DateRangeFilter
AuthorFilter
LanguageFilter
```

Filters should sync to URL.

### 21.3 Saved views

Later feature:

```text
Failed reviews this week
High severity findings
Expensive reviews
Repos not indexed
```

---

## 22. Notification system

MVP notifications:

```text
toast for mutations
inline banners for setup problems
failed job badges
```

Later:

```text
notification center
websocket/SSE job updates
email/slack integration visibility
```

Use toasts for:

```text
- settings saved
- job queued
- rule created
- replay started
```

Use banners for:

```text
- GitHub App permissions missing
- installation suspended
- repo disabled
- retention policy prevents artifact display
- background job failure
```

---

## 23. Security and privacy UX

### 23.1 Redacted data

Whenever data is redacted, show why.

Examples:

```text
This prompt is redacted because prompt logging is disabled for this repository.
This code context is unavailable because artifact retention expired.
This artifact requires review.debug permission.
```

### 23.2 Sensitive content handling

Do not render secrets accidentally.

Client-side considerations:

```text
- do not store artifacts in localStorage
- do not put code/prompt content in URL params
- do not log API responses containing code
- do not send code snippets to third-party analytics
```

### 23.3 Audit-triggering actions

Actions requiring audit logs:

```text
- enabling/disabling repo
- changing settings
- creating/editing/deleting rules
- replaying review
- triggering reindex
- viewing raw prompts/code artifacts if audited
- changing member roles
```

The API records audit logs, but the UI should identify dangerous actions clearly.

---

## 24. Performance requirements

Target UX:

```text
- app shell loads quickly
- org/repo pages feel instant after initial load
- tables use server-side pagination
- heavy artifacts load only when user opens the tab
- review detail summary loads before large artifacts
```

### 24.1 Avoid over-fetching

Do not load all review artifacts with the review detail page.

Better:

```text
GET /reviews/:id -> summary
GET /reviews/:id/artifacts/context -> context tab only
GET /reviews/:id/artifacts/llm-calls -> LLM tab only
GET /reviews/:id/artifacts/diff -> diff tab only
```

### 24.2 Code splitting

Heavy components should load lazily:

```text
DiffViewer
ArtifactViewer
CodeHighlighter
Charts
Large table pages
```

### 24.3 Virtualization

Use virtualization for:

```text
- huge diff file lists
- large artifact arrays
- long code snippet lists
- high-volume usage events
```

### 24.4 Caching

Use reasonable stale times:

```text
me/orgs: 1-5 minutes
repository settings: 30-60 seconds
review run active: poll every 2 seconds
review run completed: no polling, stale 1 minute
usage: 1-5 minutes
rules/memory: 30-60 seconds
```

---

## 25. Accessibility requirements

Minimum:

```text
- keyboard navigable app shell
- visible focus states
- accessible dialogs/menus/tooltips
- semantic headings
- table headers
- form labels and errors
- color is not the only severity indicator
- reduced-motion respect
```

If using shadcn/ui/Radix primitives, keep the accessibility benefits intact. Do not wrap primitives in ways that drop ARIA attributes or keyboard behavior.

Specific checks:

```text
- command menu works with keyboard
- dialogs trap focus
- dropdowns are keyboard accessible
- tabs are keyboard accessible
- code blocks are scrollable without trapping keyboard
- severity badges include text, not just color
```

---

## 26. Observability for the dashboard

Track:

```text
- page route changes
- API request latency by route
- mutation success/failure
- frontend errors
- query error rates
- job actions triggered
- review replay actions
- settings save actions
```

Do not track:

```text
- raw code snippets
- prompts
- model outputs
- secrets
- full PR diffs
```

Client logs should include:

```text
requestId
userId hash, if allowed
orgId
route
feature
```

Potential package:

```text
/packages/observability
```

or web-only:

```text
/apps/web/src/lib/telemetry.ts
```

---

## 27. Error states

### 27.1 Page-level errors

Use route-level error boundaries.

Error page should show:

```text
- human-readable message
- request ID if available
- retry button
- link back to safe page
```

### 27.2 Component-level errors

For tables/cards:

```text
- show local error state
- do not crash whole page
- allow retry
```

### 27.3 Common error messages

```text
Unauthenticated:
  You need to sign in to continue.

Unauthorized:
  You do not have permission to view this page.

Not found:
  This resource does not exist or you do not have access to it.

GitHub installation missing:
  This organization does not have a GitHub App installation yet.

Artifact unavailable:
  This artifact was not stored, has expired, or your role cannot access it.
```

---

## 28. Loading states

Use skeletons for:

```text
- app shell org switcher
- dashboard cards
- tables
- review detail summary
```

Use spinners for:

```text
- button mutations
- small inline actions
```

Avoid full-page spinners after initial app load.

---

## 29. Empty states

Important empty states:

### No orgs

```text
No organizations connected yet.
Install the GitHub App to get started.
```

CTA:

```text
Install GitHub App
```

### No repositories enabled

```text
Choose repositories for the reviewer to monitor.
```

CTA:

```text
Enable repositories
```

### No reviews

```text
No reviews yet. Reviews run when pull requests are opened or updated.
```

CTA:

```text
Open repository settings
```

### No findings

```text
No findings found for these filters.
```

No CTA required.

### No memory

```text
No learned memory yet. Memory is created from reviewer feedback and explicit preferences.
```

---

## 30. API DTOs needed by dashboard

These should be defined in `/packages/contracts` or `/packages/api-client`.

### 30.1 Current user

```ts
export type MeView = {
  user: UserSummary
  memberships: OrgMembershipView[]
}
```

### 30.2 Org summary

```ts
export type OrgSummaryView = {
  orgId: OrgId
  slug: string
  displayName: string
  provider: ProviderKind
  avatarUrl: string | null
  currentUserRole: OrgRole
  permissions: Permission[]
  installationStatus: InstallationStatus
  enabledRepositoryCount: number
  reviewRunsThisMonth: number
}
```

### 30.3 Repository summary

```ts
export type RepositorySummaryView = {
  repoId: RepoId
  orgId: OrgId
  provider: ProviderKind
  providerRepoId: string
  owner: string
  name: string
  fullName: string
  visibility: RepositoryVisibility
  defaultBranch: string | null
  enabled: boolean
  languages: LanguageId[]
  settings: RepositorySettingsView
  indexStatus: IndexStatus
  lastIndexedAt: IsoDateTime | null
  lastReviewRunAt: IsoDateTime | null
}
```

### 30.4 Review run list item

```ts
export type ReviewRunListItemView = {
  reviewRunId: ReviewRunId
  repoId: RepoId
  repositoryFullName: string
  pullRequestNumber: number
  pullRequestTitle: string
  pullRequestAuthor: string | null
  providerUrl: string | null
  status: ReviewRunStatus
  phase: ReviewPhase | null
  publishedFindingCount: number
  rejectedFindingCount: number
  highestSeverity: FindingSeverity | null
  estimatedCostUsd: string | null
  durationMs: number | null
  createdAt: IsoDateTime
  updatedAt: IsoDateTime
}
```

### 30.5 Review run detail

```ts
export type ReviewRunDetailView = {
  reviewRun: ReviewRunView
  repository: RepositorySummaryView
  pullRequest: PullRequestSummaryView
  stats: ReviewRunStatsView
  publishedFindings: PublishedFindingView[]
  candidateFindingSummary: CandidateFindingSummaryView
  artifactAvailability: ArtifactAvailabilityView
  permissions: Permission[]
}
```

### 30.6 Artifact availability

```ts
export type ArtifactAvailabilityView = {
  prSnapshot: ArtifactAvailability
  contextBundle: ArtifactAvailability
  diff: ArtifactAvailability
  llmCalls: ArtifactAvailability
  candidateFindings: ArtifactAvailability
  rejectedFindings: ArtifactAvailability
}

export type ArtifactAvailability = {
  available: boolean
  redacted: boolean
  reason: string | null
  sizeBytes: number | null
  schemaVersion: string | null
}
```

---

## 31. Feature modules

Each feature should have a folder:

```text
src/features/reviews
  components
  queries.ts
  mutations.ts
  search.ts
  types.ts
  format.ts
```

Recommended modules:

```text
auth
orgs
repositories
reviews
findings
rules
memory
usage
jobs
debug
```

This keeps route files thin. Route files should mostly compose feature components and loaders.

---

## 32. Search param validation

Use schemas for route search params.

Example:

```ts
const ReviewRunsSearchSchema = Type.Object({
  repoId: Type.Optional(Type.String()),
  status: Type.Optional(Type.Array(ReviewRunStatusSchema)),
  severity: Type.Optional(Type.Array(FindingSeveritySchema)),
  page: Type.Optional(Type.Integer({ minimum: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  sort: Type.Optional(Type.String()),
})
```

TanStack Router can validate search params. Invalid params should fall back to defaults instead of crashing.

Defaults:

```ts
const defaultReviewRunsSearch = {
  page: 1,
  limit: 25,
  sort: '-createdAt',
}
```

---

## 33. Review detail implementation outline

Component hierarchy:

```text
ReviewRunPage
  ReviewRunHeader
  ReviewRunStatsGrid
  ReviewRunTabs
    SummaryTab
    FindingsTab
      FindingsTable
      FindingDetailDrawer
    ContextTab
      ContextGroupList
      CodeSnippetCard
    DiffTab
      DiffViewer
    JobsTab
      JobTimeline
    LLMCallsTab
      LLMCallTable
      PromptViewer
    ArtifactsTab
      ArtifactList
      ArtifactViewer
    TimelineTab
      EventTimeline
```

Data loading strategy:

```text
Initial loader:
  GET /reviews/:reviewRunId

On tab open:
  GET /reviews/:reviewRunId/artifacts/context
  GET /reviews/:reviewRunId/artifacts/diff
  GET /reviews/:reviewRunId/llm-calls
  GET /reviews/:reviewRunId/jobs
```

Do not load heavy artifacts until the user opens the tab.

---

## 34. Repository settings implementation outline

Component hierarchy:

```text
RepositorySettingsPage
  SettingsHeader
  SettingsSaveBar
  GeneralSettingsSection
  TriggerSettingsSection
  ScopeSettingsSection
  ReviewCategoriesSection
  PublishingSettingsSection
  ModelSettingsSection
  DebugSettingsSection
  DangerZoneSection
```

Key behaviors:

```text
- form initializes from repository settings
- dirty state shown
- individual sections collapsible
- inherited defaults visible
- save validates entire form
- dangerous changes require confirmation
```

Dangerous actions:

```text
Disable repository
Delete stored artifacts
Clear repository memory
Reset all settings
```

---

## 35. Rules implementation outline

Component hierarchy:

```text
RulesPage
  RulesHeader
  RulesFilters
  RulesTable
  RuleEditorDialog
  RuleImpactPreview
```

Rule editor fields:

```text
scope
repo
kind
title
description
pattern/value
enabled
```

Rule impact preview:

```text
- matching repositories
- matching paths for path rules
- recent findings that would have been suppressed
```

MVP can skip impact preview, but include the UI space for it.

---

## 36. Memory implementation outline

Component hierarchy:

```text
MemoryPage
  MemoryHeader
  MemoryFilters
  MemoryFactTable
  MemoryFactDetailDrawer
  PromoteToRuleDialog
```

Memory fact detail:

```text
- fact text
- scope
- category
- confidence
- source events
- last used
- affected reviews
- enabled/disabled
```

Promote to rule:

```text
Memory fact -> explicit repo/org rule
```

This lets users turn learned behavior into stable policy.

---

## 37. Usage implementation outline

Component hierarchy:

```text
UsagePage
  UsageTimeRangePicker
  UsageStatsGrid
  UsageByRepoTable
  UsageByModelTable
  ExpensiveReviewsTable
  UsageEventsTable
```

Cards:

```text
Reviews
LLM calls
Input tokens
Output tokens
Embedding tokens
Estimated cost
Average review duration
Failed jobs
```

MVP can implement cards + tables before charts.

---

## 38. Styling conventions

### 38.1 Utility helper

Use:

```ts
import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
```

### 38.2 Component style convention

Domain components should accept:

```ts
className?: string
```

And merge it at the outermost element.

### 38.3 Avoid over-abstracting early

Start with simple components. Extract when repeated.

Good early shared components:

```text
PageHeader
StatusBadge
SeverityBadge
EmptyState
ErrorState
DataTable
CodeSnippetCard
```

Avoid building a huge design system before pages exist.

---

## 39. Testing strategy

### 39.1 Unit tests

Test:

```text
formatters
permission helpers
query key factories
search param parsing
badge mapping
form validation helpers
```

### 39.2 Component tests

Use Testing Library.

Test:

```text
repository settings form
review status badge
findings table
rule editor dialog
memory detail drawer
empty states
error states
```

### 39.3 Route tests

Test:

```text
unauthenticated redirect
org route permission denied
review detail loads summary
tab lazy-load behavior
search params update filters
```

### 39.4 Mock API

Use MSW for browser/API mocks.

Fixtures should live in:

```text
/apps/web/src/test/fixtures
```

Reuse domain fixtures from:

```text
/packages/contracts/fixtures
```

### 39.5 Visual checks

At minimum, manually verify:

```text
light/dark mode if supported
small screens
large tables
long repo names
long PR titles
large code snippets
empty states
failed states
```

Optional later:

```text
Storybook
Playwright
Chromatic
```

### 39.6 E2E tests

Use Playwright later for:

```text
login redirect flow with mocked auth
enable repo
edit settings
view review run
create rule
replay review command
```

---

## 40. Local development

Commands:

```bash
pnpm dev:web
pnpm dev:api
pnpm dev
```

Web env file:

```text
/apps/web/.env.local
```

Variables:

```text
VITE_API_BASE_URL=http://localhost:3000
VITE_APP_ENV=local
VITE_ENABLE_DEBUG_UI=true
```

For local dev with API:

```text
1. Start Postgres/Redis with Docker Compose
2. Start API
3. Start web
4. Use mocked GitHub auth or local test user
```

For UI-only dev:

```text
1. Start web with MSW enabled
2. Use fixture data
```

MSW flag:

```text
VITE_MOCK_API=true
```

---

## 41. Implementation order

### PR 1: App shell

Implement:

```text
/apps/web package
TanStack Start setup
root route
basic Tailwind setup
QueryClient provider
basic app shell
login placeholder
orgs placeholder
```

Acceptance:

```text
pnpm dev:web runs
app renders
route tree works
basic styling works
```

### PR 2: API client and auth state

Implement:

```text
api client wrapper
/me query
login page
logout route
authenticated layout guard
org list query
org switcher
```

Acceptance:

```text
unauthenticated users are redirected
authenticated users see orgs
query errors are handled
```

### PR 3: Repository list and enable/disable

Implement:

```text
repositories page
repository table
repository filters
enable/disable mutation
bulk action skeleton
empty states
```

Acceptance:

```text
user can view repos
user can enable/disable repo
queries invalidate correctly
```

### PR 4: Repository settings

Implement:

```text
repo detail layout
settings page
settings form
save/discard behavior
inherited defaults display
```

Acceptance:

```text
settings load/save correctly
dirty state works
validation errors render
```

### PR 5: Review history

Implement:

```text
review runs list
filters/search params
status badges
polling active review runs
open GitHub PR link
```

Acceptance:

```text
review history is filterable
active runs refresh
completed runs do not poll aggressively
```

### PR 6: Review run detail summary/findings

Implement:

```text
review run detail route
header
stats
summary tab
findings tab
finding detail drawer
```

Acceptance:

```text
review run can be inspected
published/rejected findings are visible
```

### PR 7: Review artifacts/debug tabs

Implement:

```text
context tab
diff tab
jobs tab
artifacts tab
redaction states
lazy loading
```

Acceptance:

```text
large artifacts are lazy-loaded
redacted artifacts render safely
```

### PR 8: Rules and memory

Implement:

```text
rules page
rule editor
memory page
memory fact detail
promote-to-rule placeholder
```

Acceptance:

```text
users can manage explicit rules
users can inspect/disable memory facts
```

### PR 9: Usage and admin

Implement:

```text
usage page
admin page
job status drawer
manual sync/reindex/replay actions
```

Acceptance:

```text
usage visible
admin actions enqueue jobs
all dangerous actions confirm
```

### PR 10: Hardening

Implement:

```text
accessibility pass
loading states
empty states
route error boundaries
component tests
MSW fixtures
performance pass
```

Acceptance:

```text
common user flows are tested
large pages are usable
errors are understandable
```

---

## 42. MVP cut

For first launch, implement only:

```text
- login/auth shell
- org switcher
- repository list
- enable/disable repo
- repository settings
- review history
- review run detail summary
- findings tab
- basic context/diff artifact view
- rules page, minimal
- usage cards, minimal
```

Defer:

```text
- full memory editing
- detailed usage charts
- member management
- advanced admin tooling
- global command menu
- saved views
- real-time websocket updates
- advanced diff viewer
- Storybook
```

---

## 43. Definition of done

The dashboard implementation is done for MVP when:

```text
- authenticated users can select an org
- users can see synced repositories
- users can enable/disable repositories
- users can configure repository review settings
- users can see review history
- users can inspect a review run
- users can see published and rejected findings
- users can inspect context artifacts when authorized
- users can see failed job/review errors
- users can create and disable explicit rules
- basic usage/cost data is visible
- all API calls go through typed client/query helpers
- no page imports database or worker packages
- route guards work
- loading/empty/error states exist
- dangerous actions require confirmation
- important actions are audited by the API
- tests cover primary routes/components
```

---

## 44. Common mistakes to avoid

Avoid:

```text
- importing /packages/db into the web app
- letting route files become huge business-logic files
- loading all artifacts on review detail initial load
- putting code snippets or prompt bodies in URL params
- exposing debug tabs to everyone
- using client-side filters for huge server-backed tables
- optimistic updates for dangerous settings
- silently hiding permission failures
- building a custom design system before the product pages exist
- making memory behavior invisible to users
```

---

## 45. Clean mental model

The dashboard exists to answer four questions:

```text
1. What is the reviewer configured to do?
2. What did the reviewer do?
3. Why did the reviewer do it?
4. How can the user correct or improve it?
```

That maps to the UI:

```text
Configuration
  -> repositories, settings, rules

Execution
  -> review runs, jobs, usage

Explanation
  -> context bundles, findings, artifacts, LLM calls

Correction
  -> feedback, memory, rules, replay, suppression
```

If every dashboard page supports one of those four questions, the web app will stay easy to reason about.
