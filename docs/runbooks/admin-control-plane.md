# Admin Control Plane Runbook

Use this runbook for production admin access, replay operations, repository settings changes, and
audit review.

The staging proof scripts source `.env.smoke.local` before they run. For staging, copy
`.env.smoke.example` or export equivalent values, then replace every local dev value with deployed
staging values. The proof environment must include the deployed `API_URL`, deployed `WEB_URL`,
gateway public URL, gateway assertion URL, authenticated gateway session cookie for smoke checks,
org and repo scope IDs, dashboard CDP browser URL, replay target, API admin configuration,
gateway public/dashboard/session/CORS
configuration, GitHub organization, GitHub OAuth credentials, manual drill evidence, and rollback
notes. Keep `HEIMDALL_ADMIN_SMOKE_ALLOW_LOCAL_TARGET` unset or `false` for staging proof commands.

## Production Deployment Decision

Use Railway for the first production admin control-plane rollout. The staging proof already passed
on Railway with the API, dashboard, and GitHub org gateway split into separate services, so Railway
is the lowest-risk production target for this stage.

Treat Railway as a time-boxed production host, not the final infrastructure architecture. Move to a
more formal target, such as ECS, Kubernetes, or another IaC-managed container platform, before any of
these conditions apply:

- Admin routes must be private-network only instead of public with strict GitHub org auth and CORS.
- Compliance work requires managed secret rotation history, change approvals, or environment
  promotion records outside Railway.
- The product needs multi-region routing, private service discovery, or central observability
  collectors.
- The team cannot complete rollback from the Railway dashboard and CLI within the release window.

For the Railway production rollout, use three independently deployable services:

| Service | Production role | Emergency disable action |
| --- | --- | --- |
| `@app/api` | Owns admin sessions, CSRF checks, scoped authorization, mutations, and audit writes | Set `HEIMDALL_ADMIN_ENABLED=false` or `HEIMDALL_ADMIN_ROUTE_EXPOSURE=disabled`, then redeploy |
| `@app/admin-gateway` | Owns GitHub OAuth, org membership verification, login allowlist admission, and signed assertions | Remove allowed logins or rotate `HEIMDALL_ADMIN_GATEWAY_SESSION_SECRET`, then redeploy |
| `@app/web` | Serves the operator dashboard bundle built with the production API and gateway URLs | Roll back to the previous Railway revision or disable access at the edge |

## Production Rollout Plan

Record one release ticket before rollout. The ticket must name these owner roles and link to the
evidence from every gate:

| Owner role | Accountable for | Required evidence |
| --- | --- | --- |
| Release owner | Coordinates the rollout, decides go/no-go, and owns the release ticket | Completed gate checklist and go/no-go decision |
| Gateway owner | GitHub OAuth app, org allowlist, gateway session policy, and assertion signing | OAuth settings screenshot or export, gateway env diff, and login/assertion proof |
| API/dashboard owner | API admin env, dashboard build, admin sessions, CORS, and dashboard drill | `pnpm check`, preflight output, dashboard proof output, and audit log IDs |
| Operations owner | Railway deploys, health checks, monitoring, and rollback | Deploy revisions, health output, alert checks, and rollback command notes |
| Security owner | Secret handling, access review, and emergency disable approval | Secret rotation record and allowlist review |

### Enablement Order

1. Freeze the staging proof evidence and confirm that `pnpm proof:control-plane:staging` passed
   against the current API, dashboard, and gateway revisions.
2. Create a dedicated production GitHub OAuth app for the admin gateway. Configure only the exact
   callback URL `https://<gateway-production-origin>/auth/github/callback`.
3. Generate four distinct production secrets: `HEIMDALL_ADMIN_SESSION_SECRET`,
   `HEIMDALL_ADMIN_IDENTITY_ASSERTION_SECRET`, `HEIMDALL_ADMIN_GATEWAY_SESSION_SECRET`, and the
   GitHub OAuth client secret.
4. Deploy the API, dashboard, and gateway to Railway with admin access still disabled on the API:
   `HEIMDALL_ADMIN_ENABLED=false` or `HEIMDALL_ADMIN_ROUTE_EXPOSURE=disabled`.
   In Railway service settings, set each service config path to the committed config-as-code file:
   `/infra/railway/api.railway.json`, `/infra/railway/dashboard.railway.json`,
   `/infra/railway/admin-gateway.railway.json`, and `/infra/railway/worker.railway.json`.
5. Verify health for the API, dashboard, and gateway. Verify that admin API routes return 404 while
   disabled.
6. Configure the gateway with `HEIMDALL_ADMIN_GATEWAY_ALLOW_ALL_ORG_MEMBERS=false`, an explicit
   `HEIMDALL_ADMIN_GATEWAY_ALLOWED_LOGINS` list, strict `HEIMDALL_ADMIN_GATEWAY_ALLOWED_ORIGINS`,
   production org/repo scope, and only the required `admin.*` permissions.
7. Authenticate one release operator through `/auth/github/start`, then request one assertion from
   `/heimdall/assertion` with the production dashboard origin. Confirm denied requests for a
   missing origin, an unlisted origin, and an unallowlisted GitHub login.
8. Enable the API with `HEIMDALL_ADMIN_ENABLED=true`,
   `HEIMDALL_ADMIN_IDENTITY_PROVIDER=github_org`, the matching assertion secret, and strict
   `HEIMDALL_ADMIN_ALLOWED_ORIGINS`. Use `HEIMDALL_ADMIN_ROUTE_EXPOSURE=public` for the initial
   Railway rollout. Use `internal` only when a trusted proxy injects and strips the configured
   internal header.
9. Run the release gates in this runbook against production URLs. The proof scripts keep
   "staging" in their names, but they validate deployed HTTPS targets and can be used as production
   promotion gates when pointed at production.
10. Complete the manual dashboard drill on a safe production target. Do not dispatch a replay unless
    the release ticket identifies the exact replay resource and confirms that duplicate processing
    is acceptable.
11. Keep the release owner, operations owner, and security owner online for the first hour after
    enablement.

### Acceptance Gates

All gates must pass before the release owner marks the rollout complete:

| Gate | Acceptance criteria |
| --- | --- |
| Repository verification | `pnpm check` passes on the release commit |
| Staging proof | `pnpm proof:control-plane:staging` passes with committed or attached evidence |
| Production health | API `/healthz`, gateway `/healthz`, and dashboard root return healthy responses from production |
| Gateway auth | Allowlisted active GitHub org member can login and request a signed assertion; unallowlisted login cannot |
| Origin controls | API and gateway accept only the production dashboard origin and reject wildcard, missing, or unrelated origins |
| Session policy | API and gateway cookies are `HttpOnly`, `Secure`, bounded to 8 hours or less, and use the documented SameSite policy |
| Audit visibility | Login, logout, settings, and any replay drill produce searchable `audit_logs` rows with actor, request, and session IDs |
| Rollback readiness | Operations owner can name the exact Railway revisions and env changes used for emergency disable |

### Go/No-Go Criteria

Go only when every acceptance gate passes, all owner roles are assigned, rollback is rehearsed, and
the release ticket includes the production env diff with secret values redacted.

Do not go, or stop the rollout immediately, when any of these conditions exists:

- `HEIMDALL_ADMIN_GATEWAY_ALLOWED_ORIGINS` or `HEIMDALL_ADMIN_ALLOWED_ORIGINS` contains `*`.
- `HEIMDALL_ADMIN_GATEWAY_ALLOW_ALL_ORG_MEMBERS=true` without explicit security owner approval.
- The GitHub OAuth app allows a callback origin other than the production gateway origin.
- Any admin mutation does not produce an audit row.
- API or gateway health fails during rollout.
- Gateway or API auth failures spike above the baseline during the first hour.
- The operations owner cannot disable admin access and verify 404 responses within 10 minutes.

## Gateway Hardening Checklist

Use this checklist for production and for every gateway configuration change:

| Area | Required production behavior |
| --- | --- |
| Org allowlist | Require active membership in `HEIMDALL_ADMIN_GITHUB_ORG` and keep `HEIMDALL_ADMIN_GATEWAY_ALLOWED_LOGINS` explicit. Leave `HEIMDALL_ADMIN_GATEWAY_ALLOW_ALL_ORG_MEMBERS=false` unless the GitHub org is itself the admin access group and the security owner approves it. |
| Scope grants | Grant only the required `HEIMDALL_ADMIN_GATEWAY_ORG_IDS`, optional `HEIMDALL_ADMIN_GATEWAY_REPO_IDS`, and `admin.*` permissions for the release. Avoid `*` scopes unless the release ticket documents why global access is required. |
| Session policy | Gateway sessions use signed, `HttpOnly`, `Secure`, `SameSite=Lax` cookies with `HEIMDALL_ADMIN_GATEWAY_SESSION_MAX_AGE_SECONDS<=28800`. OAuth state uses `SameSite=Lax` and `HEIMDALL_ADMIN_GATEWAY_OAUTH_STATE_MAX_AGE_SECONDS<=900`. API admin sessions use signed, `HttpOnly`, `Secure` cookies with CSRF on unsafe methods. |
| OAuth app settings | Use a dedicated production GitHub OAuth app. Configure only the production gateway callback URL, request `read:org`, disable signup in the authorization request, and store the client secret only in the deployment secret store. |
| Origin checks | Set exact HTTPS dashboard origins in both `HEIMDALL_ADMIN_ALLOWED_ORIGINS` and `HEIMDALL_ADMIN_GATEWAY_ALLOWED_ORIGINS`. Do not use wildcard origins. Verify credentialed CORS with the preflight command before and after changes. |
| Failure modes | Disabled admin routes return 404. Misconfigured API auth returns 503. Missing or expired sessions return 401. Origin, CSRF, scope, and login denials return 403. GitHub token or API validation failures return 502. Logs must include error codes but not secrets, OAuth codes, assertion payloads, or cookies. |

## Production Release Gates

Run these gates before enabling or changing the admin control plane in production:

1. Validate environment configuration:

   ```sh
   pnpm env:check
   pnpm audit:control-plane:deployment
   ```

2. Run the auth and authorization integration tests:

   ```sh
   pnpm --filter @app/admin-gateway test
   pnpm --filter @app/api test
   ```

3. Build and check the dashboard bundle:

   ```sh
   VITE_HEIMDALL_API_BASE_URL=https://api.example.com \
   VITE_HEIMDALL_ADMIN_GATEWAY_BASE_URL=https://idp-gateway.example.com \
   pnpm --filter @app/web build
   WEB_URL=https://admin.example.com \
   API_URL=https://api.example.com \
   HEIMDALL_ADMIN_GATEWAY_PUBLIC_URL=https://idp-gateway.example.com \
   HEIMDALL_ADMIN_SMOKE_ORG_ID=org_staging \
   HEIMDALL_ADMIN_SMOKE_REPO_ID=repo_staging \
   HEIMDALL_DASHBOARD_E2E_BROWSER_WS=ws://127.0.0.1:9222/devtools/browser/... \
   HEIMDALL_DASHBOARD_E2E_REPLAY_KIND=webhook \
   HEIMDALL_DASHBOARD_E2E_REPLAY_ID=webhook_staging \
   HEIMDALL_DASHBOARD_E2E_ALLOW_SETTINGS_WRITE=true \
   HEIMDALL_DASHBOARD_E2E_ALLOW_REPLAY_WRITE=true \
   pnpm e2e:dashboard
   ```

4. Run the staging preflight against the deployed API, dashboard, and admin identity gateway:

   ```sh
   WEB_URL=https://admin.staging.example.com \
   API_URL=https://api.staging.example.com \
   HEIMDALL_ADMIN_GATEWAY_PUBLIC_URL=https://idp-gateway.staging.example.com \
   HEIMDALL_ADMIN_SMOKE_ASSERTION_URL=https://idp-gateway.staging.example.com/heimdall/assertion \
   HEIMDALL_ADMIN_SMOKE_GATEWAY_COOKIE='heimdall_admin_gateway_session=...' \
   HEIMDALL_ADMIN_SMOKE_ORG_ID=org_staging \
   HEIMDALL_ADMIN_SMOKE_REPO_ID=repo_staging \
   HEIMDALL_DASHBOARD_E2E_BROWSER_WS=ws://127.0.0.1:9222/devtools/browser/... \
   HEIMDALL_DASHBOARD_E2E_REPLAY_KIND=webhook \
   HEIMDALL_DASHBOARD_E2E_REPLAY_ID=webhook_staging \
   HEIMDALL_DASHBOARD_E2E_ALLOW_SETTINGS_WRITE=true \
   HEIMDALL_DASHBOARD_E2E_ALLOW_REPLAY_WRITE=true \
   pnpm preflight:control-plane:staging
   ```

   The preflight probes API and gateway health, validates credentialed CORS, verifies that the
   dashboard bundle references the configured `API_URL` and gateway URL, and uses the supplied gateway cookie to
   request one signed assertion for the configured org/repo scope. It verifies that assertion with
   the shared API assertion secret and fails unless the assertion uses `github_org`, matches the
   configured GitHub organization, includes the requested org/repo scope, and grants all dashboard
   proof permissions.

5. Complete the manual dashboard drill as an authenticated admin:

   - Inspect the configured replay target.
   - Create a replay plan.
   - Execute the replay.
   - Update repository settings.
   - Verify the login, logout, replay, and settings audit rows.

   Record that drill as JSON in `HEIMDALL_CONTROL_PLANE_MANUAL_DRILL_EVIDENCE`:

   ```json
   {
     "actor": "github_org:12345",
     "auditLogIds": {
       "login": "audit_login",
       "logout": "audit_logout",
       "replay": "audit_replay",
       "settings": "audit_settings"
     },
     "completedAt": "2026-05-06T18:30:00.000Z",
     "notes": "Manual dashboard drill completed against staging.",
     "steps": ["inspect", "plan_replay", "execute_replay", "update_settings", "verify_audit_log"]
   }
   ```

6. Run the full staging proof and write the evidence record:

   ```sh
   HEIMDALL_CONTROL_PLANE_MANUAL_DRILL_EVIDENCE='{"actor":"github_org:12345","auditLogIds":{"login":"audit_login","logout":"audit_logout","replay":"audit_replay","settings":"audit_settings"},"completedAt":"2026-05-06T18:30:00.000Z","notes":"Manual dashboard drill completed against staging.","steps":["inspect","plan_replay","execute_replay","update_settings","verify_audit_log"]}' \
   HEIMDALL_CONTROL_PLANE_ROLLBACK_NOTES='Rollback by disabling HEIMDALL_ADMIN_ENABLED and redeploying the previous API, dashboard, and gateway revisions.' \
   pnpm proof:control-plane:staging
   ```

   The proof command runs the same staging preflight, API smoke, and dashboard E2E scripts in order.
   It validates the manual dashboard drill evidence, verifies that actor, gateway, org scope, and
   repo scope match across proof steps, and writes the parsed JSON evidence plus top-level actor,
   scope, and audit summaries to `HEIMDALL_CONTROL_PLANE_EVIDENCE_FILE`, or
   `docs/evidence/admin-control-plane-staging-proof.json` by default.

7. Run the staging smoke against a staging API and staging admin identity gateway when you need to
   rerun only the API gate:

   ```sh
   API_URL=https://api.staging.example.com \
   WEB_URL=https://admin.staging.example.com \
   HEIMDALL_ADMIN_SMOKE_ASSERTION_URL=https://idp-gateway.staging.example.com/heimdall/assertion \
   HEIMDALL_ADMIN_SMOKE_GATEWAY_COOKIE='heimdall_admin_gateway_session=...' \
   HEIMDALL_ADMIN_SMOKE_ORG_ID=org_staging \
   HEIMDALL_ADMIN_SMOKE_REPO_ID=repo_staging \
   pnpm smoke:control-plane:staging
   ```

The smoke scripts must receive assertions from the deployed identity gateway. Do not give these
scripts `HEIMDALL_ADMIN_IDENTITY_ASSERTION_SECRET`; local assertion minting does not prove the
gateway integration. For the GitHub gateway, authenticate through `/auth/github/start`, copy the
gateway session cookie, and pass it through `HEIMDALL_ADMIN_SMOKE_GATEWAY_COOKIE` for smoke and
preflight assertion checks. The smoke clients and dashboard browser requests send `WEB_URL` as the
request `Origin` for credentialed gateway and API requests; set `HEIMDALL_ADMIN_SMOKE_ORIGIN` only
when that origin must differ from `WEB_URL`. For a
manually retrieved gateway assertion, set
`HEIMDALL_ADMIN_SMOKE_ALLOW_SUPPLIED_ASSERTION=true` with the three
`HEIMDALL_ADMIN_SMOKE_IDP_*` values.
The staging proof commands reject loopback API, dashboard, and gateway URLs. Use
`HEIMDALL_ADMIN_SMOKE_ALLOW_LOCAL_TARGET=true` only for the local development smoke command.

The staging smoke prints the gateway URL, actor ID, org/repo scope, and audit log IDs for login and
logout. The dashboard E2E prints the same identity context plus replay and settings audit log IDs.
Add both JSON outputs to the release record.

Before running `pnpm e2e:dashboard`, launch Chrome with remote debugging enabled and pass the
browser-level WebSocket URL through `HEIMDALL_DASHBOARD_E2E_BROWSER_WS`. The E2E drill opens the
dashboard, starts the GitHub gateway login from the browser, lets the dashboard exchange the
gateway assertion for an API session, refreshes the dashboard session, plans and dispatches a
replay, saves the current repository settings, searches audit history, logs out, and prints JSON
evidence.

## Local Development Gateway

Use the local gateway only while building the app before the real OIDC/SAML/GitHub-org gateway
exists. It signs the same assertion shape as production, but it does not authenticate a real user.

Run these commands in separate terminals:

```sh
pnpm infra:prepare
pnpm smoke:control-plane:api
pnpm dev:web
pnpm dev:admin-idp
```

Then run the API control-plane smoke:

```sh
pnpm smoke:control-plane:local
```

This local smoke proves API login, session cookies, CSRF-protected logout, and audit-history access
through the assertion contract. It does not replace the staging gate because the local gateway does
not verify real identity-provider membership.

Run the repository-wide check before handoff:

```sh
pnpm check
```

## Required Production Settings

Set these variables before enabling admin routes:

| Variable | Required value |
| --- | --- |
| `HEIMDALL_ADMIN_ENABLED` | `true` |
| `HEIMDALL_ADMIN_ROUTE_EXPOSURE` | `internal` behind a trusted proxy, or `public` only with strict IdP and CORS controls |
| `HEIMDALL_ADMIN_IDENTITY_PROVIDER` | `oidc`, `saml`, or `github_org` |
| `HEIMDALL_ADMIN_IDENTITY_ASSERTION_SECRET` | A 32+ character secret shared with the identity gateway |
| `HEIMDALL_ADMIN_SESSION_SECRET` | A distinct 32+ character session signing secret |
| `HEIMDALL_ADMIN_ALLOWED_ORIGINS` | Comma-separated dashboard origins |
| `HEIMDALL_ADMIN_GITHUB_ORG` | Required when `HEIMDALL_ADMIN_IDENTITY_PROVIDER=github_org` |
| `VITE_HEIMDALL_API_BASE_URL` | Admin API origin built into the dashboard bundle |
| `VITE_HEIMDALL_ADMIN_GATEWAY_BASE_URL` | Admin gateway origin built into the dashboard bundle |

For internal exposure, also set `HEIMDALL_ADMIN_INTERNAL_HEADER_NAME` and
`HEIMDALL_ADMIN_INTERNAL_HEADER_VALUE`. The trusted proxy must inject this header and block clients
from setting it directly.

## GitHub Org Gateway Settings

Deploy `@app/admin-gateway` with these variables:

| Variable | Required value |
| --- | --- |
| `HEIMDALL_ADMIN_GATEWAY_PUBLIC_URL` | Public gateway origin, such as `https://idp-gateway.staging.example.com` |
| `HEIMDALL_ADMIN_GATEWAY_DASHBOARD_URL` | Dashboard URL to open after GitHub login |
| `HEIMDALL_ADMIN_GATEWAY_GITHUB_CLIENT_ID` / `HEIMDALL_ADMIN_GATEWAY_GITHUB_CLIENT_SECRET` | GitHub OAuth app credentials. The gateway also accepts `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` as fallbacks |
| `HEIMDALL_ADMIN_GATEWAY_GITHUB_SCOPES` | Must include `read:org` |
| `HEIMDALL_ADMIN_GITHUB_ORG` | GitHub organization login required for access |
| `HEIMDALL_ADMIN_IDENTITY_ASSERTION_SECRET` | Same 32+ character secret configured on the API |
| `HEIMDALL_ADMIN_GATEWAY_SESSION_SECRET` | Distinct 32+ character gateway session secret |
| `HEIMDALL_ADMIN_GATEWAY_SESSION_MAX_AGE_SECONDS` | `28800` or less |
| `HEIMDALL_ADMIN_GATEWAY_OAUTH_STATE_MAX_AGE_SECONDS` | `900` or less |
| `HEIMDALL_ADMIN_GATEWAY_ALLOWED_ORIGINS` | Dashboard origins allowed to call `/heimdall/assertion` |
| `HEIMDALL_ADMIN_GATEWAY_ALLOWED_LOGINS` | Comma-separated GitHub login allowlist |
| `HEIMDALL_ADMIN_GATEWAY_ORG_IDS` | Heimdall organization scope IDs granted in assertions |
| `HEIMDALL_ADMIN_GATEWAY_REPO_IDS` | Optional Heimdall repository scope IDs granted in assertions |
| `HEIMDALL_ADMIN_GATEWAY_PERMISSIONS` | Comma-separated `admin.*` permissions granted in assertions |

Leave `HEIMDALL_ADMIN_GATEWAY_ALLOW_ALL_ORG_MEMBERS=false` unless the GitHub organization is already
the exact admin access group. The gateway fails closed without an allowlist or that explicit opt-in.

## Secret Rotation Procedure

Rotate one secret at a time unless there is an active incident. Record the old secret name, new
secret name, owner, deployment revision, verification output, and rollback decision in the release
ticket. Never paste secret values into the ticket, logs, chat, or command history.

General rotation steps:

1. Confirm the operations owner can roll back the API, dashboard, and gateway Railway revisions.
2. Generate a new 32+ character random value in the deployment secret store.
3. Update only the affected service environment variables.
4. Redeploy the affected service.
5. Verify health, login, assertion issuance when relevant, CORS, and audit visibility.
6. Remove or revoke the old secret after verification.

| Secret | Rotation procedure | Expected user impact | Verification |
| --- | --- | --- | --- |
| `HEIMDALL_ADMIN_SESSION_SECRET` | Update the API secret and redeploy `@app/api`. Existing API admin sessions become invalid. | Operators must refresh the dashboard session and log in again. | Login succeeds through the gateway, `/admin/auth/session` returns the new session, logout writes an audit row, and old cookies return 401. |
| `HEIMDALL_ADMIN_IDENTITY_ASSERTION_SECRET` | This secret is shared by the gateway and API and has no dual-secret window. Disable admin routes or schedule a short maintenance window, update the gateway and API to the same new value, redeploy both, then re-enable admin routes. | Assertions minted before the cutover fail after the API deploy. Operators must request a new assertion and API session. | `pnpm preflight:control-plane:staging` passes against the target URLs, assertion timestamps are current, and invalid old assertions fail with `admin_auth.invalid_signature`. |
| `HEIMDALL_ADMIN_GATEWAY_SESSION_SECRET` | Update the gateway secret and redeploy `@app/admin-gateway`. | Operators must repeat GitHub OAuth login because gateway session cookies become invalid. API sessions remain valid until they expire, but operators need a new gateway session for refresh. | `/heimdall/assertion` returns 401 for the old gateway cookie, then succeeds after a new GitHub login. |
| GitHub OAuth client secret | Generate or rotate the client secret in the GitHub OAuth app, update `HEIMDALL_ADMIN_GATEWAY_GITHUB_CLIENT_SECRET`, and redeploy the gateway. Revoke the old secret after login verification. | New OAuth callbacks fail during a bad deploy. Existing gateway and API sessions continue until expiration. | `/auth/github/start` redirects to GitHub, callback completes, gateway sets a new session cookie, and no `admin_gateway.github_token_exchange_failed` errors appear. |

During an incident, prefer emergency disable before rotation. Set
`HEIMDALL_ADMIN_ENABLED=false` or `HEIMDALL_ADMIN_ROUTE_EXPOSURE=disabled` on the API, redeploy,
verify admin routes return 404, then rotate affected secrets.

## Monitoring and Rollback Checks

Railway logging is sufficient for the initial production rollout, but the operations owner must
create equivalent alerts before moving to a formal infrastructure target.

| Signal | Check | Alert condition |
| --- | --- | --- |
| API health | `GET <API_URL>/healthz` returns `{ "ok": true, "service": "api" }` | Two consecutive failures or any 5xx during rollout |
| Gateway health | `GET <GATEWAY_URL>/healthz` returns `{ "ok": true, "service": "admin-gateway" }` | Two consecutive failures or any 5xx during rollout |
| Dashboard health | `GET <WEB_URL>/` returns the dashboard shell built with the production API URL | 4xx/5xx or missing production API URL in the bundle |
| Auth failures | Count API `admin.access.denied` telemetry by `attributes.code` and gateway `admin_gateway.*` rejection codes in logs | More than 5 failures in 10 minutes after excluding a planned negative test |
| Replay audit visibility | Search `audit_logs` for `webhook.requeue_jobs`, `review.requeue`, and `publish.review` after any `admin.replay.dispatched` event | Replay dispatch returns without a matching audit row |
| Settings audit visibility | Search `audit_logs` for `repo.settings.updated` after any `admin.settings.updated` event | Settings update returns without a matching audit row |
| Admin action volume | Count `audit_logs` by action each hour | Zero rows after a known manual drill, or more than 3 settings/replay mutations outside a release or incident |
| Emergency disable | API admin routes return 404 after `HEIMDALL_ADMIN_ENABLED=false` or `HEIMDALL_ADMIN_ROUTE_EXPOSURE=disabled` deploy | Disable cannot complete and verify within 10 minutes |

Use these SQL checks when direct database access is available:

```sql
select action, count(*) as events
from audit_logs
where occurred_at >= now() - interval '1 hour'
group by action
order by events desc;
```

```sql
select audit_log_id, action, actor_user_id, resource_type, resource_id, occurred_at
from audit_logs
where action in ('webhook.requeue_jobs', 'review.requeue', 'publish.review')
order by occurred_at desc
limit 20;
```

Run the local production-readiness gate after updating the release evidence or this runbook:

```sh
pnpm audit:control-plane:deployment
pnpm readiness:control-plane:production
```

The deployment audit verifies that the Railway production manifest includes all required services,
release gates, environment variable names, rollback checks, and alert coverage. The readiness gate
verifies that the committed staging proof passed, includes actor, scope, audit, command, and
rollback evidence, and that this runbook covers rollout, hardening, rotation, monitoring, rollback,
emergency disable, and the persisted replay audit action names.

### Emergency Disable Path

1. Set `HEIMDALL_ADMIN_ENABLED=false` on `@app/api`, or set
   `HEIMDALL_ADMIN_ROUTE_EXPOSURE=disabled`.
2. Redeploy the API service.
3. Verify `/admin/auth/session`, `/admin/audit-logs`, and replay/settings routes return 404.
4. Remove `HEIMDALL_ADMIN_GATEWAY_ALLOWED_LOGINS` or rotate
   `HEIMDALL_ADMIN_GATEWAY_SESSION_SECRET` on `@app/admin-gateway`.
5. Redeploy the gateway and verify `/heimdall/assertion` returns 401 for previous gateway cookies.
6. Roll back the dashboard or gateway Railway revision if the incident came from a bad deploy.
7. Record the disable time, verification output, affected users, and follow-up owner in the
   incident record.

### Rollback Checks

After any rollback or emergency disable:

- API and worker non-admin routes still pass their health checks.
- Admin API routes return 404 when disabled.
- The gateway no longer issues assertions for removed logins or old gateway cookies.
- New admin audit rows stop after disable, except for expected login/logout attempts during
  verification.
- The incident record includes the Railway revision restored or the env values changed.

## Emergency Replay

1. Open the dashboard and refresh the admin session.
2. Load the failing webhook, review run, or publisher run in the inspector.
3. Select **Plan replay**.
4. Review blocked jobs, missing jobs, dry-run output, and failure codes.
5. Copy the confirmation token into the confirmation field.
6. Select **Dispatch replay**.
7. Copy the returned audit log ID and durable job IDs into the incident record.
8. Search audit history by the request ID or replay action to verify the audit record.

Replay execution requires `admin.replay.execute`. Support users with only `admin.replay.plan` can
inspect and plan, but cannot dispatch replay jobs.

## Emergency Settings Change

1. Open **Settings** in the dashboard.
2. Load the repository ID.
3. Change only the required controls.
4. Save the settings.
5. Search **Audit Events** for `repo.settings.updated`.
6. Verify that the audit row includes the request ID, actor, before settings, and after settings.
7. Roll back by restoring the previous values from the audit row if the change causes regressions.

Settings changes require `admin.settings.manage` and repository or organization scope.

## Audit Review

Use **Audit Events** to search by organization, action, resource, actor, or free text. For scoped
actors, include an `orgId` filter. Global audit viewers can search without an organization filter.

Every admin mutation must write an audit row. Treat a mutation without a matching audit row as an
incident.
