# Admin Control Plane Runbook

Use this runbook for production admin access, replay operations, repository settings changes, and
audit review.

The staging proof scripts source `.env.smoke.local` before they run. For staging, copy
`.env.smoke.example` or export equivalent values, then replace every local dev value with deployed
staging values. The proof environment must include the deployed `API_URL`, deployed `WEB_URL`,
gateway assertion URL, authenticated gateway session cookie, org and repo scope IDs, dashboard CDP
browser URL, replay target, API admin configuration, gateway public/dashboard/session/CORS
configuration, GitHub organization, GitHub OAuth credentials, manual drill evidence, and rollback
notes. Keep `HEIMDALL_ADMIN_SMOKE_ALLOW_LOCAL_TARGET` unset or `false` for staging proof commands.

## Production Release Gates

Run these gates before enabling or changing the admin control plane in production:

1. Validate environment configuration:

   ```sh
   pnpm env:check
   ```

2. Run the auth and authorization integration tests:

   ```sh
   pnpm --filter @app/admin-gateway test
   pnpm --filter @app/api test
   ```

3. Build and check the dashboard bundle:

   ```sh
   pnpm --filter @app/web build
   WEB_URL=https://admin.example.com \
   API_URL=https://api.example.com \
   HEIMDALL_ADMIN_SMOKE_ASSERTION_URL=https://idp-gateway.example.com/heimdall/assertion \
   HEIMDALL_ADMIN_SMOKE_GATEWAY_COOKIE='heimdall_admin_gateway_session=...' \
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
   dashboard bundle references the configured `API_URL`, and uses the supplied gateway cookie to
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
gateway session cookie, and pass it through `HEIMDALL_ADMIN_SMOKE_GATEWAY_COOKIE`. The smoke and
dashboard proof clients send `WEB_URL` as the request `Origin` for credentialed gateway and API
requests; set `HEIMDALL_ADMIN_SMOKE_ORIGIN` only when that origin must differ from `WEB_URL`. For a
manually retrieved gateway assertion, set
`HEIMDALL_ADMIN_SMOKE_ALLOW_SUPPLIED_ASSERTION=true` with the three
`HEIMDALL_ADMIN_SMOKE_IDP_*` values.
The staging proof commands reject loopback API, dashboard, and gateway URLs. Use
`HEIMDALL_ADMIN_SMOKE_ALLOW_LOCAL_TARGET=true` only for the local development smoke command.

The staging smoke prints the gateway URL, actor ID, org/repo scope, and audit log IDs for login and
logout. The dashboard E2E prints the same identity context plus replay and settings audit log IDs.
Add both JSON outputs to the release record.

Before running `pnpm e2e:dashboard`, launch Chrome with remote debugging enabled and pass the
browser-level WebSocket URL through `HEIMDALL_DASHBOARD_E2E_BROWSER_WS`. The E2E drill logs in with
a gateway-issued assertion, refreshes the dashboard session, plans and dispatches a replay, saves
the current repository settings, searches audit history, logs out, and prints JSON evidence.

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

7. Run the repository-wide check before handoff:

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
| `HEIMDALL_ADMIN_GITHUB_ORG` | GitHub organization login required for access |
| `HEIMDALL_ADMIN_IDENTITY_ASSERTION_SECRET` | Same 32+ character secret configured on the API |
| `HEIMDALL_ADMIN_GATEWAY_SESSION_SECRET` | Distinct 32+ character gateway session secret |
| `HEIMDALL_ADMIN_GATEWAY_ALLOWED_ORIGINS` | Dashboard origins allowed to call `/heimdall/assertion` |
| `HEIMDALL_ADMIN_GATEWAY_ALLOWED_LOGINS` | Comma-separated GitHub login allowlist |
| `HEIMDALL_ADMIN_GATEWAY_ORG_IDS` | Heimdall organization scope IDs granted in assertions |
| `HEIMDALL_ADMIN_GATEWAY_REPO_IDS` | Optional Heimdall repository scope IDs granted in assertions |
| `HEIMDALL_ADMIN_GATEWAY_PERMISSIONS` | Comma-separated `admin.*` permissions granted in assertions |

Leave `HEIMDALL_ADMIN_GATEWAY_ALLOW_ALL_ORG_MEMBERS=false` unless the GitHub organization is already
the exact admin access group. The gateway fails closed without an allowlist or that explicit opt-in.

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
