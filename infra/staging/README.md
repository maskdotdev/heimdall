# Staging Containers

Build these images from the repository root with the repository root as the Docker build context.
The images are intentionally platform-neutral so they can run on ECS, Fly, Render, Railway, or any
other container host.

```sh
docker build -f infra/staging/Dockerfile.api -t heimdall-api:staging .
docker build -f infra/staging/Dockerfile.admin-gateway -t heimdall-admin-gateway:staging .
docker build \
  --build-arg VITE_HEIMDALL_API_BASE_URL=https://api.staging.example.com \
  --build-arg VITE_HEIMDALL_ADMIN_GATEWAY_BASE_URL=https://gateway.staging.example.com \
  -f infra/staging/Dockerfile.web \
  -t heimdall-web:staging \
  .
```

Run the API container with the admin control-plane variables from the runbook:

```sh
HEIMDALL_ADMIN_ENABLED=true
HEIMDALL_ADMIN_ROUTE_EXPOSURE=public
HEIMDALL_ADMIN_IDENTITY_PROVIDER=github_org
HEIMDALL_ADMIN_ALLOWED_ORIGINS=https://admin.staging.example.com
```

Run the gateway container with matching `HEIMDALL_ADMIN_IDENTITY_ASSERTION_SECRET`, a distinct
`HEIMDALL_ADMIN_GATEWAY_SESSION_SECRET`, `HEIMDALL_ADMIN_GITHUB_ORG`, GitHub OAuth credentials, and
strict `HEIMDALL_ADMIN_GATEWAY_ALLOWED_ORIGINS`. Assertion and logout requests must send an
`Origin` header that matches one of those allowed origins.
Admin API mutations also require an `Origin` header that matches
`HEIMDALL_ADMIN_ALLOWED_ORIGINS`.

After deployment, authenticate through the gateway and run:

```sh
pnpm preflight:control-plane:staging
pnpm proof:control-plane:staging
```

Run these commands from the repository root with `.env.smoke.local` populated from
`.env.smoke.example` using the deployed staging API, dashboard, gateway, GitHub OAuth, scope, replay,
manual drill, and rollback evidence values. The package scripts load `.env.smoke.local`
automatically and fail closed when required staging values are missing or point at localhost.

The preflight fails if the dashboard bundle does not contain the configured `API_URL` and gateway
URL, or if the gateway-issued assertion does not verify against the API assertion secret, GitHub
organization, requested org/repo scope, and required dashboard proof permissions. Rebuild the web
image with `--build-arg VITE_HEIMDALL_API_BASE_URL=<staging API URL>` and
`--build-arg VITE_HEIMDALL_ADMIN_GATEWAY_BASE_URL=<staging gateway URL>` for each staging login
origin change.

Before pushing images, run local container probes with staging-like environment values:

```sh
docker run --rm -p 127.0.0.1:30080:3000 \
  -e NODE_ENV=production \
  -e DATABASE_URL=postgresql://postgres:postgres@localhost:5432/review_agent \
  -e REDIS_URL=redis://localhost:6379 \
  -e GITHUB_WEBHOOK_SECRET=runtime-test-webhook-secret \
  -e HEIMDALL_ADMIN_ENABLED=true \
  -e HEIMDALL_ADMIN_ROUTE_EXPOSURE=public \
  -e HEIMDALL_ADMIN_IDENTITY_PROVIDER=github_org \
  -e HEIMDALL_ADMIN_IDENTITY_ASSERTION_SECRET=assertion-secret-with-at-least-32-chars \
  -e HEIMDALL_ADMIN_SESSION_SECRET=admin-session-secret-with-at-least-32-chars \
  -e HEIMDALL_ADMIN_ALLOWED_ORIGINS=https://admin.staging.example.com \
  -e HEIMDALL_ADMIN_GITHUB_ORG=example-org \
  heimdall-api:staging

curl -fsS http://127.0.0.1:30080/healthz
```

```sh
docker run --rm -p 127.0.0.1:43180:4318 \
  -e NODE_ENV=production \
  -e HEIMDALL_ADMIN_GATEWAY_PUBLIC_URL=https://gateway.staging.example.com \
  -e HEIMDALL_ADMIN_GATEWAY_DASHBOARD_URL=https://admin.staging.example.com \
  -e HEIMDALL_ADMIN_GATEWAY_SESSION_SECRET=gateway-session-secret-with-at-least-32-chars \
  -e HEIMDALL_ADMIN_IDENTITY_ASSERTION_SECRET=assertion-secret-with-at-least-32-chars \
  -e HEIMDALL_ADMIN_GITHUB_ORG=example-org \
  -e HEIMDALL_ADMIN_GATEWAY_ALLOWED_ORIGINS=https://admin.staging.example.com \
  -e HEIMDALL_ADMIN_GATEWAY_ALLOWED_LOGINS=example-user \
  -e HEIMDALL_ADMIN_GATEWAY_ORG_IDS=org_staging \
  -e HEIMDALL_ADMIN_GATEWAY_REPO_IDS=repo_staging \
  -e HEIMDALL_ADMIN_GATEWAY_PERMISSIONS=admin.inspect,admin.replay.plan,admin.replay.execute,admin.settings.manage,admin.audit.view \
  -e HEIMDALL_ADMIN_GATEWAY_GITHUB_CLIENT_ID=dummy-client-id \
  -e HEIMDALL_ADMIN_GATEWAY_GITHUB_CLIENT_SECRET=dummy-client-secret \
  heimdall-admin-gateway:staging

curl -fsS http://127.0.0.1:43180/healthz
```

```sh
docker run --rm -p 127.0.0.1:30081:3001 heimdall-web:staging
curl -fsS http://127.0.0.1:30081/
```
