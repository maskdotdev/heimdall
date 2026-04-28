# Local Infrastructure

`compose.yaml` starts the baseline local dependencies:

- Postgres with pgvector on port `5432`
- Redis on port `6379`

Use `pnpm infra:up`, `pnpm infra:down`, and `pnpm infra:reset` from the repo root.
