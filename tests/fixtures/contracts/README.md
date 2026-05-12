# Contract Fixtures

This directory contains representative valid payloads for Heimdall JSON Schema contracts.

Valid fixtures use the naming pattern `<schema-name>.valid.json` and mirror schema subdirectories when needed. For example, `events/review-event.valid.json` validates against `contracts/schemas/events/review-event.schema.json`.

Run fixture validation from the repository root:

```sh
pnpm contracts:validate
```
