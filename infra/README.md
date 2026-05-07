# Infrastructure

`compose.yaml` starts the baseline local dependencies:

- Postgres with pgvector on port `5432`
- Redis on port `6379`

Use `pnpm infra:up`, `pnpm infra:down`, and `pnpm infra:reset` from the repo root.

## Production Deployment Manifest

`infra/production/railway-admin-control-plane.json` codifies the initial Railway production
deployment for the admin control plane. It lists the API, dashboard, admin gateway, worker,
Postgres, and Redis services; required non-secret environment variable names; release gates;
rollback checks; and alert coverage.

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
