# Contracts

This directory is reserved for cross-language contracts and generated outputs.

For the TypeScript MVP, shared runtime types live in `packages/contracts`. Add files here when the project introduces Protobuf, OpenAPI, JSON Schema, or generated clients that must be shared across languages or service boundaries.

## Layout

```txt
proto/       Protobuf source definitions.
openapi/     Public and internal HTTP API specifications.
schemas/     JSON schemas for LLM outputs and event payloads.
generated/   Generated Go, TypeScript, Python, or other contract outputs.
```

