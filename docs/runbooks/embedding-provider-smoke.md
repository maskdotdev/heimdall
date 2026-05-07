# Embedding Provider Smoke

Use this runbook to prove that the configured OpenAI-compatible embedding provider can return a
valid vector without sending customer data.

## Prerequisites

- Copy `.env.smoke.example` to `.env.smoke.local`.
- Set `HEIMDALL_EMBEDDING_PROVIDER_API_KEY` to a live provider key.
- Keep `OPENAI_EMBEDDING_MODEL` and `OPENAI_EMBEDDING_DIMENSIONS` aligned with the worker
  embedding configuration.
- Set `HEIMDALL_EMBEDDING_SMOKE_ALLOW_LIVE=true` only for the smoke run.

## Run

```sh
pnpm smoke:embedding:openai
```

The command exits with status `0` and prints product-safe JSON when the provider returns a vector.
The output includes the provider host, model, vector length, input count, and token usage when the
provider returns usage data. It does not print the API key or vector contents.

## Expected Result

```json
{
  "status": "passed",
  "provider": "openai",
  "model": "text-embedding-3-small",
  "vectorLength": 1536,
  "inputCount": 1
}
```

Unset `HEIMDALL_EMBEDDING_SMOKE_ALLOW_LIVE` or set it to `false` after the smoke run.
