# LLM Provider Smoke

Use this runbook to prove that the configured OpenAI-compatible LLM provider can return
schema-valid review findings without sending customer data.

## Prerequisites

- Copy `.env.smoke.example` to `.env.smoke.local`.
- Set `HEIMDALL_LLM_PROVIDER_API_KEY` to a live provider key.
- Set `HEIMDALL_LLM_SMOKE_MODEL` to the review model that should match worker configuration.
- Set `HEIMDALL_LLM_SMOKE_ALLOW_LIVE=true` only for the smoke run.

## Run

```sh
pnpm smoke:llm:openai
```

The command exits with status `0` and prints product-safe JSON when the provider returns
schema-valid output. The output includes the provider host, model, gateway task, schema name, and
finding count. It does not print the API key, prompt, raw response, or customer data.

## Expected Result

```json
{
  "status": "passed",
  "provider": "openai",
  "model": "gpt-4.1-mini",
  "task": "review.findings",
  "schemaName": "LLMFindingOutput",
  "findingCount": 0
}
```

Unset `HEIMDALL_LLM_SMOKE_ALLOW_LIVE` or set it to `false` after the smoke run.
