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
