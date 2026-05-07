# Infrastructure

`compose.yaml` starts the baseline local dependencies:

- Postgres with pgvector on port `5432`
- Redis on port `6379`
- MinIO object storage on port `9000`, with the console on port `9001`

Use `pnpm infra:up`, `pnpm infra:down`, and `pnpm infra:reset` from the repo root.

The local MinIO bootstrap creates the `heimdall-review-artifacts` bucket for review artifact
payloads. Use these environment variables when running the API or worker against local object
storage:

```sh
HEIMDALL_REVIEW_ARTIFACT_BUCKET=heimdall-review-artifacts
HEIMDALL_REVIEW_ARTIFACT_ENDPOINT=http://localhost:9000
HEIMDALL_REVIEW_ARTIFACT_REGION=us-east-1
HEIMDALL_REVIEW_ARTIFACT_ACCESS_KEY_ID=heimdall
HEIMDALL_REVIEW_ARTIFACT_SECRET_ACCESS_KEY=heimdall-local-secret
HEIMDALL_REVIEW_ARTIFACT_FORCE_PATH_STYLE=true
```

## Production Deployment Manifest

`infra/production/railway-admin-control-plane.json` codifies the initial Railway production
deployment for the admin control plane. It lists the API, dashboard, admin gateway, worker,
Postgres, and Redis services; required non-secret environment variable names; release gates;
rollback checks; alert coverage; and the review artifact storage policy. Production review
artifact storage must use a private S3-compatible bucket with public access blocked,
provider-managed encryption, and support-session-gated raw download access.

The deployable Railway services use config-as-code files under `infra/railway/`. In each Railway
service, set the custom config path to the corresponding absolute repository path:

| Service | Railway config path |
| --- | --- |
| API | `/infra/railway/api.railway.json` |
| Dashboard | `/infra/railway/dashboard.railway.json` |
| Admin gateway | `/infra/railway/admin-gateway.railway.json` |
| Worker | `/infra/railway/worker.railway.json` |

Run this audit before promoting or changing the production admin control plane:

```sh
pnpm audit:control-plane:deployment
```

Run the full Railway release gate sequence from one command after `.env.smoke.local` contains the
deployed API, dashboard, gateway, OAuth, CDP, replay, and proof values:

```sh
pnpm release:control-plane:railway
```

Use local-only mode before the deployed browser/OAuth proof inputs are ready:

```sh
pnpm release:control-plane:railway -- --local-only
```
