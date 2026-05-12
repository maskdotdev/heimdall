# JSON Schemas

This directory contains Heimdall's JSON Schema contracts for cross-boundary payloads and raw reviewer output.

Use these schemas when data crosses an app, service, worker, workflow, persistence, or publishing boundary. Do not copy these shapes into local service models without a conversion layer.

## Conventions

- Schemas use JSON Schema draft 2020-12.
- Every top-level payload includes `schemaVersion`.
- Shared primitives live in `common.schema.json`.
- Domain schemas live directly in this directory.
- Event schemas live in `events/`.
- LLM output schemas live in `llm/` because model output is untrusted.
- Paths are repository-relative POSIX paths. They must not be absolute or contain `..`.
- Provider IDs are opaque strings. Do not infer permissions or ownership from provider ID shape.
- Raw provider payloads, tokens, private keys, and secrets must not appear in schema-compliant persisted payloads.

## Schema Map

| Schema | Owner | Purpose |
| --- | --- | --- |
| `common.schema.json` | `contracts` | Shared primitives such as IDs, actors, source locations, artifact refs, and redaction summaries. |
| `repository.schema.json` | `services/api` | Normalized repository metadata after provider ingress. |
| `change-request.schema.json` | `services/api` | Normalized pull request, merge request, or equivalent provider change request metadata. |
| `diff.schema.json` | `workers/code-intel` | Changed files, hunks, lines, and diff summary data. |
| `code-graph.schema.json` | `workers/code-intel` | Symbols, dependency edges, language summaries, and related tests. |
| `review-standard.schema.json` | `services/api`, `workers/review` | Review rules and scoped policy guidance. |
| `context-bundle.schema.json` | `workers/review` | Bounded, redacted evidence package for reviewer agents and validators. |
| `finding.schema.json` | `workers/review`, `services/api` | Validated findings after schema, location, evidence, redaction, dedupe, and ranking checks. |
| `review-run.schema.json` | `services/api`, `services/workflows` | Review execution state and lifecycle metadata. |
| `provider.schema.json` | `services/api`, `workers/publisher` | Provider references without raw provider payloads. |
| `publish.schema.json` | `workers/publisher` | Provider-neutral publishable review and comments. |
| `events/review-event.schema.json` | `services/workflows`, `services/api` | Append-only lifecycle and worker progress events. |
| `llm/reviewer-output.schema.json` | `workers/review` | Strict raw model output schema before validation and persistence. |

## Validation Model

The LLM schema is not the same as the persisted finding schema.

1. A reviewer model returns `llm/reviewer-output.schema.json`.
2. `workers/review` validates the raw shape.
3. `workers/review` checks locations against the diff and allowed summary scope.
4. `workers/review` checks evidence quality and redaction.
5. `workers/review` deduplicates and ranks candidate findings.
6. Only validated findings become `finding.schema.json` payloads.
7. Only approved, validated findings become `publish.schema.json` comments.

## Versioning

The current initial schema version is `1.0.0`.

Use additive changes for compatible updates. Removing a field, changing required fields, changing enum meaning, or changing validation semantics is a breaking change and requires a schema version bump.

## Review Checklist

- Confirm each cross-boundary object has one schema owner.
- Confirm fields that may hold provider data document redaction expectations.
- Confirm all path fields use `common.schema.json#/$defs/relativePath`.
- Confirm LLM output remains separated from validated findings.
- Confirm publication uses `publish.schema.json`, not raw findings or raw LLM output.
- Confirm future generated contracts point back to these shapes or their Protobuf/OpenAPI equivalents.

## Examples

See [examples/review-flow.example.json](examples/review-flow.example.json) for a compact end-to-end payload sketch. The example shows the transition from raw LLM output to a validated finding and then to a publishable review.

## Local Checks

Run the schema and fixture validation check from the repository root:

```sh
pnpm contracts:validate
```

The script checks that schema files contain valid JSON, top-level `$id` values are unique, local relative `$ref` targets resolve to existing files and definitions, and valid fixtures under `tests/fixtures/contracts` conform to their matching schemas.

Run the full contract gate before handoff:

```sh
pnpm contracts:check
```

That command also verifies generated TypeScript, Python, and Go artifacts under `contracts/generated` are current.
