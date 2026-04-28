# #4 Webhook Ingestion — Implementation Spec

**Status:** Draft for implementation  
**Target app:** `/apps/api`  
**Recommended package:** `/packages/webhook-ingestion`  
**Primary dependencies:** `/packages/contracts`, `/packages/db`, `/packages/github`, `/packages/queue`, `/packages/observability`, `/packages/config`  
**Stack:** Bun, Elysia, TypeScript, Drizzle/Postgres, BullMQ/Redis, structured logs, OpenTelemetry  
**Last reviewed against public GitHub/Elysia docs:** 2026-04-28

---

## 1. Purpose

This workstream implements the HTTP ingestion layer for provider webhooks, starting with GitHub App webhooks.

The webhook ingestion layer is the system boundary between external provider events and internal durable jobs.

It should:

```text
receive GitHub webhook deliveries
verify authenticity using the raw request body
parse and normalize the event
persist the delivery for idempotency and replay/debugging
decide the minimal job fanout for the event type/action
durably create job intents
enqueue async work
return quickly to GitHub
```

It should not:

```text
review pull requests
fetch full pull request snapshots
clone repositories
parse code
call LLMs
publish review comments
infer feedback/memory meaning
own GitHub API business logic beyond webhook delivery handling
```

Clean mental model:

```text
GitHub delivery
  -> raw body verification
  -> normalized webhook event
  -> durable event row
  -> durable job intents
  -> async workers
```

The webhook route should be fast, boring, idempotent, and safe to replay.

---

## 2. Executive summary

Recommended setup:

```text
Endpoint:              POST /webhooks/github
Runtime:               Bun
HTTP framework:        Elysia
Body parsing:          disabled for webhook route until signature is verified
Verification:          X-Hub-Signature-256 HMAC-SHA256 over raw body
Idempotency key:       provider + X-GitHub-Delivery
Persistence:           webhook_events + background_jobs in Postgres
Queue:                 BullMQ after durable DB write
Response:              202 Accepted once event/job intents are durably recorded
Unsupported events:    persist, mark ignored, return 202
Duplicates:            return 202 with duplicate status
```

Core principle:

> The webhook route should never do expensive product work. It should verify, persist, normalize, plan jobs, and return.

The route may attempt to enqueue BullMQ jobs immediately after commit, but Redis/BullMQ should not be the only durable record of work. The safest MVP design is an outbox-style flow:

```text
Webhook route
  -> transaction inserts webhook_events row
  -> transaction inserts background_jobs rows
  -> after commit, best-effort enqueue to BullMQ
  -> dispatcher/sweeper re-enqueues undispatched DB jobs
```

This avoids losing webhook work if Redis, BullMQ, or the worker fleet has a temporary failure.

---

## 3. Relationship to other workstreams

### 3.1 Depends on

```text
#0 Core contracts and shared types
#1 Monorepo and build system
#2 Database layer
#3 GitHub App integration
#7 Job queue and orchestration
#25 Observability
```

### 3.2 Feeds into

```text
#5 API server
#7 Job queue and orchestration
#16 Review orchestrator
#20 Publisher
#21 Feedback and memory
#29 Admin/internal tooling
```

### 3.3 Boundary with #3 GitHub App Integration

`/packages/github` owns GitHub-specific helper logic:

```text
GitHub header names
GitHub payload type definitions
GitHub webhook signature verification helper
GitHub-specific event normalization helpers
GitHub installation/repository/PR metadata extraction helpers
```

`/packages/webhook-ingestion` owns ingestion flow:

```text
read raw HTTP request
call verification helper
persist webhook event
create job plan
create durable job intents
enqueue jobs
return response
```

`/apps/api` wires the route:

```text
POST /webhooks/github
```

---

## 4. Non-goals

Do not implement these in #4:

```text
- GitHub App creation/configuration UI
- installation access token generation
- repository discovery details
- pull request snapshot fetching
- raw diff fetching
- PR review orchestration
- code indexing
- retrieval
- model calls
- comment publishing
- billing
- long-term memory inference
- full redelivery automation
- GitLab/Bitbucket webhook ingestion
```

This workstream may define extension points for those things, but should not implement them.

---

## 5. High-level architecture

```text
GitHub
  |
  | POST /webhooks/github
  v
Elysia route in /apps/api
  |
  | read raw bytes
  | extract headers
  | verify X-Hub-Signature-256
  v
Webhook Ingestion Service
  |
  | parse JSON
  | normalize event
  | compute payload hash
  | compute job plan
  v
Postgres transaction
  |
  | insert webhook_events
  | insert background_jobs
  v
After-commit enqueue
  |
  | enqueue BullMQ jobs
  v
Workers
  |
  | sync installation
  | review PR
  | update memory
  | mark repository changes
```

The route should return without waiting for workers.

---

## 6. Package layout

Recommended files:

```text
/apps/api
  src/routes/webhooks/github.ts
  src/routes/webhooks/index.ts

/packages/webhook-ingestion
  package.json
  tsconfig.json
  src/index.ts
  src/config.ts
  src/types.ts
  src/errors.ts
  src/github/handler.ts
  src/github/headers.ts
  src/github/normalize.ts
  src/github/plan-jobs.ts
  src/github/signature.ts
  src/persist.ts
  src/enqueue.ts
  src/outbox.ts
  src/status.ts
  src/testing/fixtures.ts
  src/testing/signature-fixtures.ts
  test/github-signature.test.ts
  test/github-normalize.test.ts
  test/github-plan-jobs.test.ts
  test/github-route.test.ts
  test/idempotency.test.ts
```

Alternative:

```text
/packages/github/src/webhooks/*
```

can own `headers.ts`, `normalize.ts`, and `signature.ts`, while `/packages/webhook-ingestion` owns `handler.ts`, `persist.ts`, and `enqueue.ts`.

The important boundary is not the exact folder name. The important boundary is that HTTP ingestion is not mixed with review/indexing/model logic.

---

## 7. Webhook endpoint contract

### 7.1 Route

```text
POST /webhooks/github
```

### 7.2 Required request properties

For production GitHub App webhooks, require:

```text
Content-Type: application/json
X-GitHub-Event: <event name>
X-GitHub-Delivery: <globally unique delivery GUID>
X-Hub-Signature-256: sha256=<hex digest>
User-Agent: GitHub-Hookshot/...
```

Also capture if present:

```text
X-GitHub-Hook-ID
X-GitHub-Hook-Installation-Target-Type
X-GitHub-Hook-Installation-Target-ID
X-Hub-Signature       # legacy SHA-1; capture but do not rely on it
```

### 7.3 Response semantics

Use these status codes:

| Case | Response | Persist? | Notes |
|---|---:|---|---|
| Valid delivery, jobs planned | `202` | yes | Normal path. |
| Valid delivery, unsupported event/action | `202` | yes | Mark `ignored`. |
| Duplicate delivery ID | `202` | no new event row or update duplicate count | Do not enqueue duplicate jobs. |
| `ping` event | `200` or `202` | yes | Either is fine; prefer `202` for consistency. |
| Missing required headers | `400` | optional security log only | Do not process. |
| Unsupported content type | `415` | optional security log only | App should be configured for JSON. |
| Payload too large | `413` | optional security log only | Enforce internal limit. |
| Signature missing/invalid | `401` or `403` | security log only | Do not parse or enqueue. |
| Malformed JSON after valid signature | `400` | yes, mark parse failure | Signature valid means it came from GitHub, so retain metadata. |
| DB unavailable | `500` | no | Cannot safely accept. |
| Durable job intent created but BullMQ enqueue failed | `202` | yes | Outbox sweeper must enqueue later. |

Use `202 Accepted` for normal async handling because processing is deferred.

### 7.4 Response body

Keep the response body tiny.

Example:

```json
{
  "ok": true,
  "deliveryId": "72d3162e-cc78-11e3-81ab-4c9367dc0958",
  "status": "accepted"
}
```

For duplicates:

```json
{
  "ok": true,
  "deliveryId": "72d3162e-cc78-11e3-81ab-4c9367dc0958",
  "status": "duplicate"
}
```

For invalid signatures, do not include details that help attackers.

```json
{
  "ok": false,
  "error": "unauthorized"
}
```

---

## 8. Elysia route design

### 8.1 Important: disable automatic body parsing

The webhook signature must be computed over the raw payload bytes. Do not allow Elysia to parse JSON before verification.

Use route-level `parse: "none"` and read the `Request` directly.

```ts
import { Elysia } from "elysia";
import { handleGithubWebhookRequest } from "@repo/webhook-ingestion/github";

export const githubWebhookRoute = new Elysia({ name: "github-webhook-route" }).post(
  "/webhooks/github",
  async ({ request, status }) => {
    const result = await handleGithubWebhookRequest({ request });

    if (result.kind === "accepted") {
      return status(202, {
        ok: true,
        deliveryId: result.deliveryId,
        status: result.status,
      });
    }

    if (result.kind === "duplicate") {
      return status(202, {
        ok: true,
        deliveryId: result.deliveryId,
        status: "duplicate",
      });
    }

    if (result.kind === "bad_request") {
      return status(400, {
        ok: false,
        error: "bad_request",
      });
    }

    if (result.kind === "unauthorized") {
      return status(401, {
        ok: false,
        error: "unauthorized",
      });
    }

    if (result.kind === "payload_too_large") {
      return status(413, {
        ok: false,
        error: "payload_too_large",
      });
    }

    if (result.kind === "unsupported_media_type") {
      return status(415, {
        ok: false,
        error: "unsupported_media_type",
      });
    }

    return status(500, {
      ok: false,
      error: "internal_error",
    });
  },
  {
    parse: "none",
  },
);
```

### 8.2 Why the route should not use a body schema

Do not do this on the webhook route:

```ts
.post("/webhooks/github", handler, {
  body: t.Object({ ... }),
});
```

A body schema encourages the framework to parse the request before signature verification. For webhooks, validation happens after authenticity verification.

---

## 9. Configuration

Add configuration keys under `/packages/config`:

```ts
export const WebhookConfigSchema = Type.Object({
  githubWebhookSecret: Type.String({ minLength: 16 }),
  githubPreviousWebhookSecret: Type.Optional(Type.String({ minLength: 16 })),
  githubWebhookMaxBytes: Type.Integer({ minimum: 1024, maximum: 30 * 1024 * 1024 }),
  githubWebhookRequireJson: Type.Boolean(),
  githubWebhookPersistRawPayload: Type.Boolean(),
  githubWebhookRawPayloadRetentionDays: Type.Integer({ minimum: 1, maximum: 90 }),
  githubWebhookEnableIpAllowlist: Type.Boolean(),
  githubWebhookReturnDebugResponses: Type.Boolean(),
});
```

Recommended defaults:

```text
GITHUB_WEBHOOK_MAX_BYTES=26214400        # 25 MiB
GITHUB_WEBHOOK_REQUIRE_JSON=true
GITHUB_WEBHOOK_PERSIST_RAW_PAYLOAD=true in dev/staging, configurable in prod
GITHUB_WEBHOOK_RAW_PAYLOAD_RETENTION_DAYS=30
GITHUB_WEBHOOK_ENABLE_IP_ALLOWLIST=false initially
GITHUB_WEBHOOK_RETURN_DEBUG_RESPONSES=false in prod
```

Secret rotation:

```text
GITHUB_WEBHOOK_SECRET=current secret
GITHUB_PREVIOUS_WEBHOOK_SECRET=previous secret during rotation window
```

During rotation, verify against the active secret first and previous secret second. Store which secret version matched, not the secret.

---

## 10. Core contracts

Add or confirm these contracts in `/packages/contracts`.

### 10.1 Provider webhook headers

```ts
export type GithubWebhookHeaders = {
  eventName: string;
  deliveryId: string;
  hookId?: string;
  signatureSha256: string;
  signatureSha1?: string;
  userAgent?: string;
  installationTargetType?: string;
  installationTargetId?: string;
  contentType?: string;
};
```

### 10.2 Normalized webhook event

```ts
export type NormalizedWebhookEvent = {
  schemaVersion: "webhook_event.v1";
  provider: "github";
  providerDeliveryId: string;
  providerEventName: string;
  action: string | null;
  receivedAt: string;

  payloadSha256: string;
  signatureVerified: boolean;
  signatureVersion: "sha256";
  matchedSecretVersion: "current" | "previous";

  providerInstallationId?: string;
  providerRepositoryId?: string;
  repositoryFullName?: string;
  organizationLogin?: string;

  sender?: {
    providerUserId?: string;
    login?: string;
    type?: string;
  };

  target?:
    | {
        kind: "installation";
        providerInstallationId: string;
      }
    | {
        kind: "repository";
        providerRepositoryId: string;
        fullName: string;
      }
    | {
        kind: "pull_request";
        providerRepositoryId: string;
        fullName: string;
        pullRequestNumber: number;
        headSha?: string;
        baseSha?: string;
        draft?: boolean;
      }
    | {
        kind: "comment";
        providerRepositoryId?: string;
        fullName?: string;
        commentId: string;
        pullRequestNumber?: number;
      }
    | {
        kind: "unknown";
      };

  rawHeaders: Record<string, string>;
  normalizedMetadata: Record<string, unknown>;
};
```

### 10.3 Ingestion result

```ts
export type WebhookIngestionResult =
  | {
      kind: "accepted";
      deliveryId: string;
      eventId: string;
      status: "accepted" | "ignored";
      jobIds: string[];
    }
  | {
      kind: "duplicate";
      deliveryId: string;
      eventId: string;
    }
  | {
      kind: "bad_request";
      reason: string;
    }
  | {
      kind: "unauthorized";
      reason: string;
    }
  | {
      kind: "payload_too_large";
      maxBytes: number;
    }
  | {
      kind: "unsupported_media_type";
      contentType: string | null;
    }
  | {
      kind: "internal_error";
      reason: string;
    };
```

### 10.4 Job plan

```ts
export type WebhookJobPlan = {
  eventId: string;
  deliveryId: string;
  jobs: PlannedWebhookJob[];
};

export type PlannedWebhookJob = {
  queueName:
    | "github.sync"
    | "pr.review"
    | "memory.update"
    | "usage.record";
  jobName: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  priority: "low" | "normal" | "high";
  delayMs?: number;
};
```

---

## 11. Database records

This workstream uses tables from #2.

### 11.1 `webhook_events`

Important columns:

```text
id                         text primary key
provider                   text not null
provider_delivery_id       text not null
event_name                 text not null
action                     text null
status                     text not null
received_at                timestamptz not null
verified_at                timestamptz null
processed_at               timestamptz null
ignored_at                 timestamptz null

payload_sha256             text not null
payload_size_bytes         integer not null
payload_json               jsonb null
payload_storage_uri        text null
payload_storage_sha256     text null

headers_json               jsonb not null
signature_verified         boolean not null default false
matched_secret_version     text null

provider_installation_id   text null
provider_repository_id     text null
repository_full_name       text null
pull_request_number        integer null
sender_login               text null
sender_type                text null

job_plan_json              jsonb null
planned_job_count          integer not null default 0
enqueued_job_count         integer not null default 0

error_code                 text null
error_message              text null

created_at                 timestamptz not null
updated_at                 timestamptz not null
```

Unique constraint:

```sql
unique(provider, provider_delivery_id)
```

Useful indexes:

```sql
create index webhook_events_received_at_idx
on webhook_events (received_at desc);

create index webhook_events_event_action_idx
on webhook_events (provider, event_name, action);

create index webhook_events_repo_pr_idx
on webhook_events (provider_repository_id, pull_request_number);

create index webhook_events_status_idx
on webhook_events (status);
```

### 11.2 `background_jobs`

The webhook route should create job intents in the `background_jobs` table.

Important columns:

```text
id                    text primary key
queue_name            text not null
job_name              text not null
idempotency_key       text not null
status                text not null
priority              text not null
payload_json          jsonb not null
source_type           text not null       # webhook_event
source_id             text not null       # webhook_events.id
available_at          timestamptz not null
created_at            timestamptz not null
enqueued_at           timestamptz null
started_at            timestamptz null
completed_at          timestamptz null
failed_at             timestamptz null
attempt_count         integer not null default 0
last_error_code       text null
last_error_message    text null
```

Unique constraint:

```sql
unique(queue_name, idempotency_key)
```

This prevents duplicate jobs even if different webhook deliveries point to the same semantic work.

---

## 12. Ingestion status model

Use explicit statuses for `webhook_events.status`:

```text
received              row created, not yet verified
verified              signature verified
parsed                JSON parsed
normalized            normalized event created
ignored               valid event, no work planned
duplicate             duplicate delivery observed
jobs_planned          durable job rows created
enqueued              all planned jobs enqueued or dispatchable
failed_verification   invalid signature or missing signature
failed_parse          valid signature but malformed JSON
failed_persist        failed to persist, normally not stored
failed_enqueue        durable row exists, queue push failed
```

A simple MVP can collapse some of these:

```text
accepted
ignored
duplicate
failed_verification
failed_parse
failed_enqueue
```

But detailed statuses help debugging.

---

## 13. Signature verification

### 13.1 Verification rules

The signature verification function should:

```text
- require X-Hub-Signature-256
- require sha256= prefix
- compute HMAC-SHA256 using the raw request body bytes
- compare using constant-time comparison
- support current + previous webhook secret during rotation
- return matched secret version
- never log the secret, expected signature, or full received signature
```

Do not use `X-Hub-Signature` except as a diagnostic field. It uses SHA-1 and should not be trusted for new implementations.

### 13.2 Implementation

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

export type VerifyGithubSignatureInput = {
  rawBody: Buffer;
  signatureSha256: string | null;
  secrets: {
    current: string;
    previous?: string;
  };
};

export type VerifyGithubSignatureResult =
  | {
      ok: true;
      matchedSecretVersion: "current" | "previous";
    }
  | {
      ok: false;
      reason:
        | "missing_signature"
        | "invalid_prefix"
        | "invalid_signature"
        | "invalid_signature_length";
    };

export function verifyGithubSignature(
  input: VerifyGithubSignatureInput,
): VerifyGithubSignatureResult {
  const received = input.signatureSha256;

  if (!received) {
    return { ok: false, reason: "missing_signature" };
  }

  if (!received.startsWith("sha256=")) {
    return { ok: false, reason: "invalid_prefix" };
  }

  const candidates: Array<["current" | "previous", string]> = [
    ["current", input.secrets.current],
  ];

  if (input.secrets.previous) {
    candidates.push(["previous", input.secrets.previous]);
  }

  for (const [version, secret] of candidates) {
    const expected =
      "sha256=" + createHmac("sha256", secret).update(input.rawBody).digest("hex");

    const expectedBytes = Buffer.from(expected, "utf8");
    const receivedBytes = Buffer.from(received, "utf8");

    if (expectedBytes.length !== receivedBytes.length) {
      continue;
    }

    if (timingSafeEqual(expectedBytes, receivedBytes)) {
      return {
        ok: true,
        matchedSecretVersion: version,
      };
    }
  }

  return { ok: false, reason: "invalid_signature" };
}
```

### 13.3 Signature test fixture

Include GitHub's documented test vector as a unit test:

```text
secret:  It's a Secret to Everybody
payload: Hello, World!
expected X-Hub-Signature-256:
sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17
```

Test cases:

```text
valid signature
missing signature
wrong prefix
wrong body same signature
wrong secret
unicode payload
previous secret match
active secret preferred over previous
constant-time function handles length mismatch safely
```

---

## 14. Header extraction

Implement a small helper that converts Web Standard headers into normalized GitHub headers.

```ts
export function extractGithubWebhookHeaders(headers: Headers): GithubWebhookHeaders {
  return {
    eventName: requireHeader(headers, "x-github-event"),
    deliveryId: requireHeader(headers, "x-github-delivery"),
    hookId: optionalHeader(headers, "x-github-hook-id"),
    signatureSha256: requireHeader(headers, "x-hub-signature-256"),
    signatureSha1: optionalHeader(headers, "x-hub-signature"),
    userAgent: optionalHeader(headers, "user-agent"),
    installationTargetType: optionalHeader(
      headers,
      "x-github-hook-installation-target-type",
    ),
    installationTargetId: optionalHeader(
      headers,
      "x-github-hook-installation-target-id",
    ),
    contentType: optionalHeader(headers, "content-type"),
  };
}
```

Validation:

```text
- eventName must be a non-empty string
- deliveryId must be a non-empty string
- signatureSha256 must be present for production
- contentType must include application/json, unless explicitly disabled
- userAgent should start with GitHub-Hookshot/ in production, but do not rely on this alone for security
```

---

## 15. Raw body reading

### 15.1 Helper

```ts
export async function readRawBodyWithLimit(input: {
  request: Request;
  maxBytes: number;
}): Promise<
  | { ok: true; rawBody: Buffer; sizeBytes: number }
  | { ok: false; reason: "payload_too_large" }
> {
  const contentLength = input.request.headers.get("content-length");

  if (contentLength && Number(contentLength) > input.maxBytes) {
    return { ok: false, reason: "payload_too_large" };
  }

  const arrayBuffer = await input.request.arrayBuffer();

  if (arrayBuffer.byteLength > input.maxBytes) {
    return { ok: false, reason: "payload_too_large" };
  }

  return {
    ok: true,
    rawBody: Buffer.from(arrayBuffer),
    sizeBytes: arrayBuffer.byteLength,
  };
}
```

### 15.2 Notes

```text
- request bodies are one-shot streams
- read the raw body once
- verify signature using the raw body
- parse JSON from rawBody.toString("utf8") after verification
- never call request.json() before verification
```

---

## 16. JSON parsing

After signature verification:

```ts
export function parseVerifiedGithubPayload(rawBody: Buffer): unknown {
  const text = rawBody.toString("utf8");
  return JSON.parse(text);
}
```

Do not validate the whole GitHub payload shape at this layer. GitHub payloads are large, provider-specific, and can evolve.

Instead:

```text
- validate required top-level fields needed for routing
- extract only stable metadata
- preserve the raw JSON payload for later consumers
- let downstream GitHub-specific jobs fetch canonical state when necessary
```

Required fields by event category:

| Event | Required routing fields |
|---|---|
| `ping` | `zen`, `hook` optional |
| `installation` | `action`, `installation.id` |
| `installation_repositories` | `action`, `installation.id` |
| `installation_target` | `action`, `installation.id` |
| `pull_request` | `action`, `installation.id`, `repository.id`, `repository.full_name`, `number`, `pull_request.head.sha`, `pull_request.base.sha` |
| `pull_request_review_comment` | `action`, `installation.id`, `repository.id`, `pull_request.number`, `comment.id` |
| `pull_request_review_thread` | `action`, `installation.id`, `repository.id`, `pull_request.number` |
| `issue_comment` | `action`, `installation.id`, `repository.id`, `issue.number`, `comment.id` |
| `repository` | `action`, `installation.id`, `repository.id`, `repository.full_name` |

---

## 17. Normalization

Normalization should produce a small provider-neutral object without losing the original payload.

### 17.1 Normalization flow

```text
headers + verified payload
  -> extract common fields
  -> derive target kind
  -> derive repo/installation/sender metadata
  -> derive PR/comment metadata when applicable
  -> emit NormalizedWebhookEvent
```

### 17.2 Implementation sketch

```ts
export function normalizeGithubWebhookEvent(input: {
  headers: GithubWebhookHeaders;
  payload: unknown;
  receivedAt: string;
  payloadSha256: string;
  payloadSizeBytes: number;
  matchedSecretVersion: "current" | "previous";
}): NormalizedWebhookEvent {
  const p = input.payload as Record<string, any>;

  const action = typeof p.action === "string" ? p.action : null;
  const installationId = p.installation?.id ? String(p.installation.id) : undefined;
  const repositoryId = p.repository?.id ? String(p.repository.id) : undefined;
  const repositoryFullName =
    typeof p.repository?.full_name === "string" ? p.repository.full_name : undefined;

  return {
    schemaVersion: "webhook_event.v1",
    provider: "github",
    providerDeliveryId: input.headers.deliveryId,
    providerEventName: input.headers.eventName,
    action,
    receivedAt: input.receivedAt,
    payloadSha256: input.payloadSha256,
    signatureVerified: true,
    signatureVersion: "sha256",
    matchedSecretVersion: input.matchedSecretVersion,
    providerInstallationId: installationId,
    providerRepositoryId: repositoryId,
    repositoryFullName,
    organizationLogin: p.organization?.login,
    sender: p.sender
      ? {
          providerUserId: p.sender.id ? String(p.sender.id) : undefined,
          login: p.sender.login,
          type: p.sender.type,
        }
      : undefined,
    target: deriveGithubWebhookTarget(input.headers.eventName, p),
    rawHeaders: normalizeHeadersForStorage(input.headers),
    normalizedMetadata: deriveGithubNormalizedMetadata(input.headers.eventName, p),
  };
}
```

### 17.3 Target derivation

```ts
export function deriveGithubWebhookTarget(
  eventName: string,
  payload: Record<string, any>,
): NormalizedWebhookEvent["target"] {
  if (eventName === "installation") {
    return {
      kind: "installation",
      providerInstallationId: String(payload.installation?.id),
    };
  }

  if (eventName === "pull_request") {
    return {
      kind: "pull_request",
      providerRepositoryId: String(payload.repository?.id),
      fullName: payload.repository?.full_name,
      pullRequestNumber: payload.number,
      headSha: payload.pull_request?.head?.sha,
      baseSha: payload.pull_request?.base?.sha,
      draft: Boolean(payload.pull_request?.draft),
    };
  }

  if (eventName === "pull_request_review_comment") {
    return {
      kind: "comment",
      providerRepositoryId: String(payload.repository?.id),
      fullName: payload.repository?.full_name,
      commentId: String(payload.comment?.id),
      pullRequestNumber: payload.pull_request?.number,
    };
  }

  if (eventName === "issue_comment") {
    return {
      kind: "comment",
      providerRepositoryId: String(payload.repository?.id),
      fullName: payload.repository?.full_name,
      commentId: String(payload.comment?.id),
      pullRequestNumber: payload.issue?.pull_request ? payload.issue?.number : undefined,
    };
  }

  if (payload.repository?.id && payload.repository?.full_name) {
    return {
      kind: "repository",
      providerRepositoryId: String(payload.repository.id),
      fullName: payload.repository.full_name,
    };
  }

  return { kind: "unknown" };
}
```

---

## 18. Event routing and job planning

The webhook ingestion layer should map events to durable jobs. It should not make deep product decisions.

Example:

```text
pull_request.synchronize
  -> create pr.review job
```

The review orchestrator later decides:

```text
- is the repo enabled?
- is the PR draft?
- is this author ignored?
- are labels configured?
- should this review be skipped?
- should only summary be generated?
```

### 18.1 MVP event matrix

| GitHub event | Actions | Planned job | Notes |
|---|---|---|---|
| `ping` | any | none or `usage.record` | Persist and acknowledge. |
| `installation` | `created`, `deleted`, other | `github.syncInstallation` | Sync/disable installation in #3/#5 workers. |
| `installation_repositories` | `added`, `removed` | `github.syncInstallationRepositories` | Update accessible repo set. |
| `installation_target` | `renamed` | `github.syncInstallation` | Account/org rename handling. |
| `repository` | `renamed`, `transferred`, `privatized`, `publicized`, `deleted`, `archived`, `unarchived` | `github.syncRepository` | Optional MVP, useful later. |
| `pull_request` | `opened`, `synchronize`, `reopened`, `ready_for_review` | `pr.review` | Review orchestrator may skip. |
| `pull_request` | `edited`, `labeled`, `unlabeled` | `pr.evaluateReviewTrigger` | Optional; useful for label-gated review. |
| `pull_request` | `closed` | `pr.markClosed` | Mark open review runs stale/closed. |
| `pull_request_review_comment` | `created`, `edited`, `deleted` | `memory.updateFromReviewComment` | Feedback/memory layer classifies. |
| `pull_request_review_thread` | `resolved`, `unresolved` | `memory.updateFromReviewThread` | Useful for outcome tracking. |
| `pull_request_review` | `submitted`, `dismissed`, `edited` | `memory.updateFromReview` | Optional MVP. |
| `issue_comment` | `created`, `edited`, `deleted` | `memory.updateFromIssueComment` or `pr.command` | Only PR issue comments matter for slash commands/replies. |
| other | any | none | Persist and mark ignored. |

### 18.2 Job planning implementation

```ts
export function planGithubWebhookJobs(input: {
  eventId: string;
  normalized: NormalizedWebhookEvent;
  payload: unknown;
}): WebhookJobPlan {
  const n = input.normalized;
  const jobs: PlannedWebhookJob[] = [];

  const base = {
    provider: "github" as const,
    webhookEventId: input.eventId,
    providerDeliveryId: n.providerDeliveryId,
    providerInstallationId: n.providerInstallationId,
    providerRepositoryId: n.providerRepositoryId,
    repositoryFullName: n.repositoryFullName,
  };

  if (n.providerEventName === "installation") {
    jobs.push({
      queueName: "github.sync",
      jobName: "github.syncInstallation",
      idempotencyKey: `github.syncInstallation:${n.providerInstallationId}:${n.providerDeliveryId}`,
      payload: {
        ...base,
        action: n.action,
      },
      priority: "high",
    });
  }

  if (n.providerEventName === "installation_repositories") {
    jobs.push({
      queueName: "github.sync",
      jobName: "github.syncInstallationRepositories",
      idempotencyKey: `github.syncInstallationRepositories:${n.providerInstallationId}:${n.providerDeliveryId}`,
      payload: {
        ...base,
        action: n.action,
      },
      priority: "high",
    });
  }

  if (n.providerEventName === "pull_request") {
    const target = n.target?.kind === "pull_request" ? n.target : null;

    if (
      target &&
      ["opened", "synchronize", "reopened", "ready_for_review"].includes(n.action ?? "")
    ) {
      jobs.push({
        queueName: "pr.review",
        jobName: "reviewPullRequest",
        idempotencyKey: `reviewPullRequest:github:${target.providerRepositoryId}:${target.pullRequestNumber}:${target.headSha ?? n.providerDeliveryId}`,
        payload: {
          ...base,
          pullRequestNumber: target.pullRequestNumber,
          baseSha: target.baseSha,
          headSha: target.headSha,
          action: n.action,
        },
        priority: n.action === "synchronize" ? "normal" : "high",
      });
    }

    if (target && n.action === "closed") {
      jobs.push({
        queueName: "pr.review",
        jobName: "markPullRequestClosed",
        idempotencyKey: `markPullRequestClosed:github:${target.providerRepositoryId}:${target.pullRequestNumber}:${n.providerDeliveryId}`,
        payload: {
          ...base,
          pullRequestNumber: target.pullRequestNumber,
          action: n.action,
        },
        priority: "normal",
      });
    }
  }

  if (
    n.providerEventName === "pull_request_review_comment" ||
    n.providerEventName === "pull_request_review_thread" ||
    n.providerEventName === "pull_request_review" ||
    n.providerEventName === "issue_comment"
  ) {
    jobs.push({
      queueName: "memory.update",
      jobName: "updateMemoryFromGithubWebhook",
      idempotencyKey: `updateMemoryFromGithubWebhook:${n.providerDeliveryId}`,
      payload: {
        ...base,
        providerEventName: n.providerEventName,
        action: n.action,
        target: n.target,
      },
      priority: "low",
    });
  }

  return {
    eventId: input.eventId,
    deliveryId: n.providerDeliveryId,
    jobs,
  };
}
```

### 18.3 Self-event loop prevention

The ingestion layer should persist self-generated webhook events, but route them carefully.

Rules:

```text
- If sender is the app's bot account, never trigger pr.review.
- If sender is the app's bot account and event is a comment creation, mark as self_event.
- If sender is the app's bot account and comment maps to a published finding, allow publisher/memory reconciliation if needed.
- If sender is a human replying to the bot's comment, enqueue memory.update.
```

Do not drop self-events before persistence. They are useful for debugging publishing behavior and avoiding duplicate comments.

Add metadata:

```ts
normalizedMetadata: {
  isFromThisApp: boolean,
  senderLogin: "my-app[bot]",
}
```

The bot login can be configured or discovered from installation/app metadata.

---

## 19. Idempotency

### 19.1 Delivery idempotency

Use:

```text
provider + X-GitHub-Delivery
```

as the unique webhook delivery key.

Behavior:

```text
- first delivery inserts webhook_events row
- redelivery with same ID returns duplicate/accepted without duplicate jobs
- duplicate should not produce a hard error
```

### 19.2 Job idempotency

Delivery idempotency is not enough. Different webhook deliveries may imply the same semantic work.

Examples:

```text
pull_request.opened and pull_request.synchronize with same head SHA
multiple label changes that trigger the same evaluateReviewTrigger job
a user manually redelivers a webhook after job already completed
```

Use semantic idempotency keys for jobs:

```text
reviewPullRequest:github:{providerRepoId}:{prNumber}:{headSha}
markPullRequestClosed:github:{providerRepoId}:{prNumber}:{deliveryId}
updateMemoryFromGithubWebhook:{deliveryId}
github.syncInstallation:{providerInstallationId}:{deliveryId}
```

### 19.3 Transaction strategy

Preferred transaction:

```text
begin
  insert webhook_events, unique(provider, provider_delivery_id)
  if duplicate:
    commit
    return duplicate
  insert background_jobs with unique(queue_name, idempotency_key)
  update webhook_events.job_plan_json/planned_job_count/status
commit
best-effort enqueue background_jobs to BullMQ
return 202
```

This makes the event accepted only after the work is durable.

---

## 20. Persistence implementation

```ts
export async function persistGithubWebhookEvent(input: {
  normalized: NormalizedWebhookEvent;
  rawPayloadJson: unknown;
  rawPayloadStorageUri?: string;
  rawPayloadStorageSha256?: string;
  payloadSizeBytes: number;
  jobPlan: WebhookJobPlan;
}): Promise<
  | { kind: "inserted"; eventId: string; backgroundJobIds: string[] }
  | { kind: "duplicate"; eventId: string }
> {
  return await db.transaction(async (tx) => {
    const eventId = createId("wh");

    const inserted = await tx
      .insert(webhookEvents)
      .values({
        id: eventId,
        provider: input.normalized.provider,
        providerDeliveryId: input.normalized.providerDeliveryId,
        eventName: input.normalized.providerEventName,
        action: input.normalized.action,
        status: input.jobPlan.jobs.length ? "jobs_planned" : "ignored",
        receivedAt: new Date(input.normalized.receivedAt),
        verifiedAt: new Date(),
        payloadSha256: input.normalized.payloadSha256,
        payloadSizeBytes: input.payloadSizeBytes,
        payloadJson: shouldStorePayloadInline(input.payloadSizeBytes)
          ? input.rawPayloadJson
          : null,
        payloadStorageUri: input.rawPayloadStorageUri,
        payloadStorageSha256: input.rawPayloadStorageSha256,
        headersJson: input.normalized.rawHeaders,
        signatureVerified: true,
        matchedSecretVersion: input.normalized.matchedSecretVersion,
        providerInstallationId: input.normalized.providerInstallationId,
        providerRepositoryId: input.normalized.providerRepositoryId,
        repositoryFullName: input.normalized.repositoryFullName,
        pullRequestNumber:
          input.normalized.target?.kind === "pull_request"
            ? input.normalized.target.pullRequestNumber
            : input.normalized.target?.kind === "comment"
              ? input.normalized.target.pullRequestNumber
              : null,
        senderLogin: input.normalized.sender?.login,
        senderType: input.normalized.sender?.type,
        jobPlanJson: input.jobPlan,
        plannedJobCount: input.jobPlan.jobs.length,
        enqueuedJobCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoNothing({
        target: [webhookEvents.provider, webhookEvents.providerDeliveryId],
      })
      .returning({ id: webhookEvents.id });

    if (!inserted.length) {
      const existing = await tx.query.webhookEvents.findFirst({
        where: and(
          eq(webhookEvents.provider, input.normalized.provider),
          eq(webhookEvents.providerDeliveryId, input.normalized.providerDeliveryId),
        ),
      });

      if (!existing) {
        throw new Error("webhook duplicate lookup failed");
      }

      return { kind: "duplicate", eventId: existing.id } as const;
    }

    const backgroundJobIds: string[] = [];

    for (const planned of input.jobPlan.jobs) {
      const jobId = createId("job");

      const jobInsert = await tx
        .insert(backgroundJobs)
        .values({
          id: jobId,
          queueName: planned.queueName,
          jobName: planned.jobName,
          idempotencyKey: planned.idempotencyKey,
          status: "pending",
          priority: planned.priority,
          payloadJson: planned.payload,
          sourceType: "webhook_event",
          sourceId: eventId,
          availableAt: new Date(Date.now() + (planned.delayMs ?? 0)),
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .onConflictDoNothing({
          target: [backgroundJobs.queueName, backgroundJobs.idempotencyKey],
        })
        .returning({ id: backgroundJobs.id });

      if (jobInsert[0]?.id) {
        backgroundJobIds.push(jobInsert[0].id);
      }
    }

    return {
      kind: "inserted",
      eventId,
      backgroundJobIds,
    } as const;
  });
}
```

---

## 21. Enqueueing and outbox dispatch

### 21.1 Immediate after-commit enqueue

After the DB transaction commits, try to enqueue the newly inserted `background_jobs` rows into BullMQ.

```ts
export async function enqueueBackgroundJobs(jobIds: string[]): Promise<void> {
  const jobs = await db.query.backgroundJobs.findMany({
    where: inArray(backgroundJobs.id, jobIds),
  });

  for (const job of jobs) {
    await queues[job.queueName].add(job.jobName, job.payloadJson, {
      jobId: job.idempotencyKey,
      priority: priorityToBullMq(job.priority),
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 1_000,
      },
    });

    await markBackgroundJobEnqueued(job.id);
  }
}
```

### 21.2 Outbox dispatcher

Implement a periodic dispatcher that finds pending DB jobs not yet enqueued:

```text
select * from background_jobs
where status = 'pending'
  and enqueued_at is null
  and available_at <= now()
order by created_at asc
limit 100
for update skip locked
```

Then enqueue them to BullMQ and mark `enqueued_at`.

This dispatcher can live in:

```text
/apps/worker/src/jobs/dispatch-background-jobs.ts
```

or inside #7 Job Queue.

### 21.3 Why this matters

If the webhook route writes only to BullMQ and Redis is unavailable, you must return `500` to GitHub. GitHub records the failure, but does not automatically redeliver. With a durable DB outbox, a temporary Redis failure does not cause lost work.

---

## 22. Full request handler

```ts
export async function handleGithubWebhookRequest(input: {
  request: Request;
}): Promise<WebhookIngestionResult> {
  const receivedAt = new Date().toISOString();

  const contentType = input.request.headers.get("content-type");
  if (config.githubWebhookRequireJson && !contentType?.includes("application/json")) {
    return {
      kind: "unsupported_media_type",
      contentType,
    };
  }

  let headers: GithubWebhookHeaders;
  try {
    headers = extractGithubWebhookHeaders(input.request.headers);
  } catch (error) {
    return {
      kind: "bad_request",
      reason: "missing_required_headers",
    };
  }

  const rawBodyResult = await readRawBodyWithLimit({
    request: input.request,
    maxBytes: config.githubWebhookMaxBytes,
  });

  if (!rawBodyResult.ok) {
    return {
      kind: "payload_too_large",
      maxBytes: config.githubWebhookMaxBytes,
    };
  }

  const signature = verifyGithubSignature({
    rawBody: rawBodyResult.rawBody,
    signatureSha256: headers.signatureSha256,
    secrets: {
      current: config.githubWebhookSecret,
      previous: config.githubPreviousWebhookSecret,
    },
  });

  if (!signature.ok) {
    await recordFailedWebhookVerification({
      provider: "github",
      deliveryId: headers.deliveryId,
      eventName: headers.eventName,
      reason: signature.reason,
      headers: safeHeadersForStorage(headers),
      receivedAt,
    });

    return {
      kind: "unauthorized",
      reason: signature.reason,
    };
  }

  let payload: unknown;
  try {
    payload = parseVerifiedGithubPayload(rawBodyResult.rawBody);
  } catch {
    await recordVerifiedButMalformedWebhook({
      provider: "github",
      deliveryId: headers.deliveryId,
      eventName: headers.eventName,
      payloadSha256: sha256Hex(rawBodyResult.rawBody),
      payloadSizeBytes: rawBodyResult.sizeBytes,
      headers: safeHeadersForStorage(headers),
      receivedAt,
    });

    return {
      kind: "bad_request",
      reason: "malformed_json",
    };
  }

  const payloadSha256 = sha256Hex(rawBodyResult.rawBody);

  const normalized = normalizeGithubWebhookEvent({
    headers,
    payload,
    receivedAt,
    payloadSha256,
    payloadSizeBytes: rawBodyResult.sizeBytes,
    matchedSecretVersion: signature.matchedSecretVersion,
  });

  const provisionalEventId = createId("wh");

  const jobPlan = planGithubWebhookJobs({
    eventId: provisionalEventId,
    normalized,
    payload,
  });

  const persisted = await persistGithubWebhookEvent({
    normalized,
    rawPayloadJson: payload,
    payloadSizeBytes: rawBodyResult.sizeBytes,
    jobPlan,
  });

  if (persisted.kind === "duplicate") {
    return {
      kind: "duplicate",
      deliveryId: headers.deliveryId,
      eventId: persisted.eventId,
    };
  }

  // Best effort. If this fails, the outbox dispatcher must recover it.
  try {
    await enqueueBackgroundJobs(persisted.backgroundJobIds);
  } catch (error) {
    await markWebhookEventEnqueueFailed({
      eventId: persisted.eventId,
      error,
    });
  }

  return {
    kind: "accepted",
    deliveryId: headers.deliveryId,
    eventId: persisted.eventId,
    status: jobPlan.jobs.length ? "accepted" : "ignored",
    jobIds: persisted.backgroundJobIds,
  };
}
```

Note: in the actual implementation, ensure the `eventId` used in the job plan is the same as the persisted event ID. The simplest approach is to create the event ID before planning and pass it into persistence.

---

## 23. Payload storage strategy

### 23.1 Inline JSONB storage

For MVP, store webhook payloads inline in `webhook_events.payload_json`.

Pros:

```text
- simple
- easy debugging
- easy replay
- no object storage dependency
```

Cons:

```text
- large payloads can bloat Postgres
- retention policies matter
- payloads may include sensitive code/comment snippets
```

### 23.2 Object storage option

For larger deployments, store payloads in S3/R2 and keep only metadata in Postgres.

```text
s3://bucket/webhooks/github/{yyyy}/{mm}/{dd}/{deliveryId}.json
```

Postgres stores:

```text
payload_storage_uri
payload_storage_sha256
payload_size_bytes
payload_json = null
```

Recommended MVP rule:

```text
- inline payloads <= 256 KiB
- object storage for payloads > 256 KiB
- configurable retention
```

### 23.3 Retention

Suggested retention:

```text
raw payloads:           30 days
headers + metadata:     180+ days
payload hash:           forever or same as webhook_events
security failure logs:  90 days
```

Make retention configurable per environment.

---

## 24. Security requirements

### 24.1 Must-have

```text
- verify X-Hub-Signature-256 using raw body bytes
- reject invalid signatures before parsing JSON
- require HTTPS in production
- never include secrets in webhook URLs
- do not log raw payload by default
- do not log webhook secrets or computed signatures
- support request body size limits
- store only redacted/safe headers
- use provider + delivery ID for replay protection
- return minimal error responses in production
```

### 24.2 Good follow-up

```text
- IP allowlist using GitHub /meta endpoint
- previous-secret rotation window
- webhook security dashboard
- anomaly alerts for invalid signatures
- per-provider request rate limits
- object-storage payload encryption
```

### 24.3 IP allowlisting

HMAC verification is the primary security control. IP allowlisting is optional defense-in-depth.

If enabled:

```text
- periodically fetch GitHub webhook IP ranges from GitHub's metadata endpoint
- cache ranges
- compare source IP from trusted proxy header only if proxy is configured correctly
- never trust arbitrary X-Forwarded-For from the public internet
```

Do not implement IP allowlisting before signature verification works reliably.

---

## 25. Replay/redelivery behavior

### 25.1 GitHub redelivery behavior

GitHub may redeliver manually requested deliveries with the same `X-GitHub-Delivery` value as the original delivery.

Therefore:

```text
- duplicate delivery ID should not error
- duplicate delivery ID should not enqueue duplicate jobs
- duplicate should return 202
- duplicate counter/last_seen_at can be updated
```

### 25.2 Internal replay

Admin/internal tooling should support replaying from stored payloads.

Replay command shape:

```text
dev replay-webhook <webhook_event_id>
```

Replay should:

```text
- load stored payload and normalized metadata
- not re-verify signature unless raw headers/body are preserved
- create a new internal replay event or mark replay attempt
- reuse job idempotency keys unless explicitly forced
```

### 25.3 Failed deliveries

If the route returns non-2xx, GitHub records the delivery as failed. Do not rely on GitHub automatically trying again.

Later, implement a scheduled job to query provider delivery logs and request redelivery for failed deliveries.

---

## 26. Local development

### 26.1 Expose local API

Use a tunnel or webhook proxy:

```text
https://<your-tunnel>/webhooks/github
```

Options:

```text
smee.io
ngrok
cloudflared tunnel
GitHub Codespaces forwarded port
```

### 26.2 Local caveat

Any proxy/tunnel used for local webhook development must preserve the raw request body. Signature verification fails if the body is modified before your route sees it.

### 26.3 Local env

```text
GITHUB_WEBHOOK_SECRET=local-dev-secret
GITHUB_WEBHOOK_REQUIRE_JSON=true
GITHUB_WEBHOOK_MAX_BYTES=26214400
```

### 26.4 Manual test with a fixture

Provide a dev script:

```bash
pnpm dev:webhook:send-fixture \
  --event pull_request \
  --action opened \
  --url http://localhost:3000/webhooks/github \
  --secret "$GITHUB_WEBHOOK_SECRET"
```

This script should:

```text
- load fixture JSON
- compute X-Hub-Signature-256
- send the request with GitHub-like headers
- print status/body
```

---

## 27. Testing strategy

### 27.1 Unit tests

Signature tests:

```text
valid GitHub test vector
invalid body
invalid secret
missing signature
wrong prefix
length mismatch
unicode payload
previous secret fallback
```

Header tests:

```text
extracts all required headers
rejects missing event header
rejects missing delivery header
rejects missing signature
handles case-insensitive headers
```

Normalization tests:

```text
ping
installation.created
installation_repositories.added
installation_repositories.removed
pull_request.opened
pull_request.synchronize
pull_request.closed
pull_request_review_comment.created
pull_request_review_thread.resolved
issue_comment.created on PR
issue_comment.created on issue
unsupported event
```

Job planning tests:

```text
pull_request.opened -> reviewPullRequest
pull_request.synchronize same head SHA -> same semantic idempotency key
pull_request.closed -> markPullRequestClosed
issue_comment on PR -> memory.update or command job
issue_comment on issue -> ignored or low-priority memory job depending config
self bot event -> no pr.review
unsupported event -> no jobs
```

### 27.2 Route tests

Use `app.handle(new Request(...))` with Elysia.

Cases:

```text
valid request returns 202
valid unsupported event returns 202 ignored
duplicate delivery returns 202 duplicate
invalid signature returns 401
missing headers returns 400
wrong content type returns 415
payload too large returns 413
malformed JSON with valid signature returns 400 and records failure
DB insert failure returns 500
BullMQ enqueue failure returns 202 if DB outbox row exists
```

### 27.3 Integration tests

Use local Postgres + Redis test containers or Docker Compose.

Cases:

```text
event persisted in webhook_events
background_jobs row created
BullMQ job enqueued
outbox dispatcher enqueues pending job
idempotent duplicate does not create second job
different delivery with same PR head SHA does not create duplicate review job
```

### 27.4 Fixture policy

Store fixtures under:

```text
/packages/webhook-ingestion/test/fixtures/github/
  ping.json
  installation.created.json
  installation_repositories.added.json
  pull_request.opened.json
  pull_request.synchronize.json
  pull_request.closed.json
  pull_request_review_comment.created.json
  pull_request_review_thread.resolved.json
  issue_comment.created.pr.json
  issue_comment.created.issue.json
```

Redact all real payload fixtures.

---

## 28. Observability

### 28.1 Logs

Every accepted/ignored/duplicate webhook should log one structured event:

```json
{
  "msg": "github webhook ingested",
  "provider": "github",
  "deliveryId": "...",
  "eventName": "pull_request",
  "action": "synchronize",
  "providerInstallationId": "123",
  "providerRepositoryId": "456",
  "repositoryFullName": "owner/repo",
  "pullRequestNumber": 42,
  "status": "accepted",
  "plannedJobCount": 1,
  "latencyMs": 37
}
```

Invalid signatures should log:

```json
{
  "msg": "github webhook rejected",
  "provider": "github",
  "deliveryId": "...",
  "eventName": "pull_request",
  "reason": "invalid_signature",
  "remoteIp": "redacted-or-trusted-proxy-ip"
}
```

Do not log:

```text
raw payload
secret
expected signature
full received signature
private key
installation token
```

### 28.2 Metrics

Counters:

```text
webhook_received_total{provider,event,action}
webhook_accepted_total{provider,event,action}
webhook_ignored_total{provider,event,action}
webhook_duplicate_total{provider,event,action}
webhook_rejected_total{provider,reason}
webhook_jobs_planned_total{provider,queue,job}
webhook_enqueue_failed_total{provider,queue,job}
```

Histograms:

```text
webhook_ingestion_latency_ms{provider,event}
webhook_payload_size_bytes{provider,event}
webhook_jobs_per_event{provider,event}
```

Gauges:

```text
background_jobs_pending_total{queue}
background_jobs_enqueue_lag_seconds{queue}
webhook_enqueue_backlog_total
```

### 28.3 Tracing

Create spans:

```text
webhook.github.receive
webhook.github.read_raw_body
webhook.github.verify_signature
webhook.github.parse_json
webhook.github.normalize
webhook.github.plan_jobs
webhook.github.persist
webhook.github.enqueue
```

Attach attributes:

```text
provider
delivery_id
event_name
action
provider_installation_id
provider_repository_id
repository_full_name
pull_request_number
payload_size_bytes
planned_job_count
```

Do not attach raw payload or secrets.

---

## 29. Error handling

### 29.1 Typed errors

Define internal error codes:

```ts
export type WebhookErrorCode =
  | "missing_header"
  | "unsupported_content_type"
  | "payload_too_large"
  | "missing_signature"
  | "invalid_signature_prefix"
  | "invalid_signature"
  | "malformed_json"
  | "normalization_failed"
  | "persist_failed"
  | "enqueue_failed";
```

### 29.2 Production response policy

In production, response bodies should be generic:

```text
401 -> unauthorized
400 -> bad_request
413 -> payload_too_large
415 -> unsupported_media_type
500 -> internal_error
```

Detailed error codes should go to logs/traces, not public responses.

### 29.3 When to return 500

Return `500` only when the system cannot safely accept the event.

Examples:

```text
DB unavailable before event/job intent persisted
fatal config missing
unexpected internal error before durable write
```

Do not return `500` for:

```text
unsupported event
duplicate delivery
BullMQ enqueue failure after durable job row exists
memory/review worker failure
```

---

## 30. Provider-neutral extension points

Design #4 so GitLab or Bitbucket can be added later.

Provider-neutral interface:

```ts
export interface WebhookProviderHandler {
  provider: "github" | "gitlab" | "bitbucket";
  extractHeaders(request: Request): ProviderWebhookHeaders;
  verify(input: VerifyWebhookInput): Promise<VerifyWebhookResult>;
  parse(input: ParseWebhookInput): Promise<unknown>;
  normalize(input: NormalizeWebhookInput): NormalizedWebhookEvent;
  planJobs(input: PlanWebhookJobsInput): WebhookJobPlan;
}
```

Route registry:

```ts
const providerHandlers = {
  github: githubWebhookHandler,
};
```

Future routes:

```text
POST /webhooks/gitlab
POST /webhooks/bitbucket
```

Do not implement non-GitHub providers in #4, but keep the shape clean.

---

## 31. Admin/internal tooling

Useful commands:

```bash
pnpm webhook:verify-fixture --fixture pull_request.opened.json --secret "$GITHUB_WEBHOOK_SECRET"
pnpm webhook:send-fixture --fixture pull_request.opened.json --url http://localhost:3000/webhooks/github
pnpm webhook:replay --event-id wh_...
pnpm webhook:print-job-plan --fixture pull_request.synchronize.json
pnpm webhook:inspect --delivery-id 72d3162e-...
pnpm webhook:dispatch-pending --limit 100
```

Dashboard/debug view should show:

```text
delivery ID
event/action
received time
signature verification status
payload hash
payload size
repo/installation/PR metadata
job plan
created background jobs
enqueue status
error reason if any
raw payload link if retained
```

---

## 32. Implementation order

### PR 1: Package and route shell

```text
- create /packages/webhook-ingestion
- create /apps/api/src/routes/webhooks/github.ts
- wire POST /webhooks/github
- add config schema
- return 501 or basic 202 for ping fixture only
```

### PR 2: Raw body + signature verification

```text
- implement readRawBodyWithLimit
- implement extractGithubWebhookHeaders
- implement verifyGithubSignature
- add GitHub test vector
- add route tests for valid/invalid signatures
- enforce parse: "none"
```

### PR 3: Persistence and idempotency

```text
- insert webhook_events rows
- unique provider+delivery ID
- duplicate handling
- payload hash and size
- safe header storage
- failed verification security log
```

### PR 4: Normalization

```text
- implement normalizeGithubWebhookEvent
- support ping
- support installation
- support installation_repositories
- support pull_request
- support pull_request_review_comment
- support pull_request_review_thread
- support issue_comment
- fixture tests
```

### PR 5: Job planning and background job rows

```text
- implement planGithubWebhookJobs
- insert background_jobs rows transactionally
- semantic job idempotency keys
- unsupported events marked ignored
- duplicate events do not create duplicate jobs
```

### PR 6: BullMQ enqueue + outbox dispatcher

```text
- enqueue background jobs after commit
- mark enqueued_at
- implement dispatcher for pending jobs
- handle enqueue failure without losing events
- add metrics for backlog/enqueue lag
```

### PR 7: Observability and hardening

```text
- structured logs
- metrics
- traces
- invalid signature alerts
- payload retention settings
- production response policy
```

### PR 8: Local dev tooling

```text
- send fixture script
- replay webhook script
- inspect delivery script
- documentation/runbook
```

---

## 33. MVP cut

For the first production-capable version, implement:

```text
POST /webhooks/github
raw body reading with parse: none
X-Hub-Signature-256 verification
Content-Type: application/json enforcement
25 MiB body limit
webhook_events persistence
provider+delivery idempotency
normalization for ping, installation, installation_repositories, pull_request, pull_request_review_comment, issue_comment
job planning for installation sync, PR review, feedback/memory update
background_jobs outbox rows
BullMQ enqueue after commit
outbox dispatcher
structured logs
unit/integration tests
fixture sender
```

Skip initially:

```text
GitLab/Bitbucket
IP allowlisting
automatic GitHub failed-delivery redelivery
full admin dashboard
object storage payload spillover
advanced memory inference
provider delivery log scanner
```

---

## 34. Definition of done

#4 is done when:

```text
- GitHub App can send signed webhook deliveries to POST /webhooks/github.
- The route verifies X-Hub-Signature-256 using the raw body.
- Invalid signatures are rejected before JSON parsing.
- Valid deliveries are persisted in webhook_events.
- Duplicate X-GitHub-Delivery values do not create duplicate jobs.
- Supported events produce expected background_jobs rows.
- Pull request opened/synchronize/reopened events enqueue review jobs.
- Installation events enqueue sync jobs.
- Comment/thread events enqueue memory update jobs.
- Unsupported events are stored and marked ignored.
- BullMQ enqueue failure after DB persistence does not lose work.
- Outbox dispatcher can enqueue pending jobs.
- Route returns within a small latency budget under normal conditions.
- Logs/metrics/traces identify delivery ID, event, action, repo, PR, and planned jobs without leaking secrets or raw payloads.
- Unit tests cover signature/header/normalization/job planning.
- Integration tests cover persistence/idempotency/outbox dispatch.
- Local fixture sender can generate signed webhook requests.
```

Suggested latency budget:

```text
p50 ingestion latency: < 50 ms after warm DB connection
p95 ingestion latency: < 250 ms without object storage spillover
hard upper target:      respond well under GitHub's webhook timeout window
```

---

## 35. Key design choices recap

```text
Use raw body verification before parsing.
Use X-Hub-Signature-256, not SHA-1.
Use provider + delivery ID for webhook idempotency.
Use semantic idempotency keys for jobs.
Persist events and job intents before returning 202.
Use BullMQ as dispatch, not the only durable record.
Keep route logic thin.
Store enough data to replay/debug.
Do not let webhook ingestion become review orchestration.
```

The resulting flow should be:

```text
GitHub
  -> Elysia route
  -> verify raw body
  -> persist normalized event
  -> create durable job intents
  -> enqueue async work
  -> return 202
```

That is the clean, performant, and replaceable ingestion layer the rest of the system can build on.

---

## 36. Reference notes

Current implementation assumptions reviewed against:

```text
GitHub webhook signature validation:
https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries

GitHub webhook events, payloads, delivery headers, and payload cap:
https://docs.github.com/en/webhooks/webhook-events-and-payloads

GitHub webhook handling and response timing guidance:
https://docs.github.com/en/webhooks/using-webhooks/handling-webhook-deliveries

GitHub webhook best practices:
https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks

GitHub failed delivery/redelivery behavior:
https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries

Elysia lifecycle/body parser behavior:
https://elysiajs.com/essential/life-cycle
```
