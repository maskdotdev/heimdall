# Code Intelligence

Code intelligence provides repository context for review decisions.

Current TypeScript package ownership:

- `packages/git`: clone, fetch, diff, patch, and blame helpers.
- `packages/repo-intel`: language detection, indexing, dependency graph, symbol graph, ownership, and test impact.
- `packages/context-builder`: converts repository intelligence into bounded review context.

Future high-throughput indexing can be added behind these package boundaries without changing API or worker callers.

