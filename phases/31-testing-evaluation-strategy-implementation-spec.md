# #31 Testing and Evaluation Strategy Implementation Spec

## Status

Implementation-ready coordination spec.

This phase turns testing and the `26A` evaluation harness into release gates. It does not replace the detailed test sections inside each phase; it defines the cross-system standard every phase must meet.

## 1. Purpose

Heimdall succeeds only if it avoids noisy, stale, unsafe, or duplicate review output. Unit tests alone are not enough because the product is a pipeline:

```text
GitHub event
  -> immutable PR snapshot
  -> index artifact
  -> imported code intelligence
  -> retrieved context
  -> structured review findings
  -> validation/ranking
  -> published comments
```

This phase ensures every important boundary has behavior tests, fixture tests, and replayable evaluation coverage.

## 2. Testing Philosophy

Follow the repository testing philosophy:

```text
Good tests exercise real code through public interfaces.
Good tests describe what the system does.
Good tests survive internal refactors.
Good tests read like specifications.
```

Avoid tests that mock internal collaborators just to assert call counts or implementation shape.

## 3. Required Test Layers

Every package should have focused tests at the public boundary it owns.

Required layers:

```text
- contract/schema validation tests
- database migration and repository tests
- GitHub webhook and publishing adapter tests
- queue/job idempotency tests
- index artifact fixture and compatibility tests
- index importer fixture tests
- retrieval fixture tests
- review-engine fake LLM tests
- finding validation/ranking golden tests
- publisher dry-run/idempotency tests
- cross-tenant and redaction tests
- end-to-end fake PR tests
```

## 4. MVP Evaluation Gate

The first production MVP must include `26A`:

```text
- /packages/evaluation
- 10-20 curated fixture PR cases
- fake LLM replay
- retrieval grading
- line-anchor grading
- validation/ranking grading
- no-finding cases
- prompt-injection cases
- baseline comparison
- markdown/json report output
- CI threshold gate
```

The first fixture suite should include:

```text
- safe rename-only change
- generated file update
- style-only formatting change
- line anchor on added line
- renamed file
- deleted file
- correctness bug requiring caller context
- missing test case
- auth/security regression
- malicious prompt injection in code comment
```

## 5. CI Gates

`pnpm check` should fail on:

```text
- typecheck failure
- lint failure
- unit/fixture test failure
- schema validation fixture failure
- migration test failure
- package dependency boundary violation
- eval baseline regression above threshold
- redaction/cross-tenant security test failure
```

Live-model evals are not required on every PR. They should run before prompt/model/retrieval/indexer releases and on a schedule.

## 6. Definition of Done

#31 is complete when:

```text
- package boundary checks run in CI
- each core package has public-interface tests
- database migrations are tested from an empty DB
- end-to-end fake PR test runs without real GitHub/model calls
- /packages/evaluation implements the 26A MVP gate
- at least 10 curated eval cases exist
- CI produces a markdown/json eval report
- baseline comparison can fail CI on quality regression
- security redaction and cross-tenant tests run in CI
```

