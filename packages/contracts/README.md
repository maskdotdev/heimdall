# @repo/contracts

Shared TypeBox schemas, TypeScript types, fixtures, and validation helpers for Heimdall boundary objects.

```ts
import {
  PullRequestSnapshotSchema,
  type PullRequestSnapshot
} from "@repo/contracts/pull-request/pull-request";
import { parseWithSchema } from "@repo/contracts/validation/parse";

const snapshot = parseWithSchema(
  "PullRequestSnapshot",
  PullRequestSnapshotSchema,
  input
) satisfies PullRequestSnapshot;
```

Every exported boundary object has a runtime schema and a matching static type. Cross-process artifacts use explicit `schemaVersion` fields.
