# Contracts

This directory defines the shared language of the system.

Contracts cover:

- Repository references.
- Change request references.
- Diffs and changed files.
- Code graphs.
- Review standards.
- Context bundles.
- Reviewer input and output.
- Review findings.
- Review runs.
- Review events.
- Provider references.
- Publishable reviews.

## Layout

```txt
proto/
  heimdall/
    v1/
      repository.proto
      change_request.proto
      diff.proto
      code_graph.proto
      review_standard.proto
      context_bundle.proto
      finding.proto
      review_run.proto
      events.proto
      provider.proto
      publish.proto

openapi/
  public-api.yaml
  internal-api.yaml

schemas/
  llm/
  events/

generated/
  go/
  ts/
  python/
```

Everything important should flow through contracts. The web app, API service, workflow service, and workers should not each invent their own version of a finding, diff, context bundle, or review run.

## JSON Schema Contracts

The initial JSON Schema contract set is under [schemas/](schemas/README.md).

Use the schemas for payloads that need runtime validation, especially raw LLM output, context bundles, findings, review events, and publishable reviews. The LLM-facing schemas are intentionally separate from validated domain schemas because model output must be treated as untrusted until `workers/review` validates it.

Run the local schema check from the repository root:

```sh
pnpm contracts:validate
```

## Generated Contracts

`contracts/schemas` is the source of truth. Generated runtime types live under:

- `generated/ts`: TypeScript interfaces and literal unions exported as `@heimdall/contracts`.
- `generated/python`: Python 3.12 dataclasses and type aliases exported by `contract_types`.
- `generated/go`: Go structs and aliases in package `contracts`.

Regenerate all targets after changing a schema:

```sh
pnpm contracts:generate
```

Before handoff, run the single contract check:

```sh
pnpm contracts:check
```

The check validates schema structure, validates representative fixtures in `tests/fixtures/contracts`, and fails if generated artifacts drift from `contracts/schemas`.

## Update Workflow

1. Edit the JSON Schema files in `contracts/schemas`.
2. Add or update representative fixtures in `tests/fixtures/contracts`. Name valid fixtures as `<schema-name>.valid.json`; nested fixtures mirror schema subdirectories such as `events/` and `llm/`.
3. Run `pnpm contracts:generate`.
4. Run `pnpm contracts:check`.
5. Review compatibility before merging. Additive optional fields are usually compatible. Removing fields, adding required fields, changing enum meanings, or changing validation semantics is breaking and requires a schema version bump.
