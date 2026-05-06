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

Run this audit before promoting or changing the production admin control plane:

```sh
pnpm audit:control-plane:deployment
```
