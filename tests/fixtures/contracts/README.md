# Contract Fixtures

This directory contains representative valid and invalid payloads for Heimdall JSON Schema contracts.

Valid fixtures use the naming pattern `<schema-name>.valid.json` and mirror schema subdirectories when needed. For example, `events/review-event.valid.json` validates against `contracts/schemas/events/review-event.schema.json`.

Invalid fixtures use the naming pattern `<schema-name>.<case>.invalid.json`. Each invalid fixture must have a sidecar expectation file named `<schema-name>.<case>.expect.json` with:

```json
{
  "instancePath": "/json/pointer",
  "messageContains": "expected message fragment"
}
```

The validator requires each invalid fixture to fail at the expected instance path with a matching message fragment.

Run fixture validation from the repository root:

```sh
pnpm contracts:validate
```
