# Workers

Workers are asynchronous execution pools. Keep each worker focused so heavy work in one pool does not starve the others.

```txt
review/      LLM review intelligence.
code-intel/  Repository analysis and code graph context.
scanner/     Deterministic static analysis and secret scanning.
publisher/   Provider comment publishing and rate-limit handling.
indexer/     Optional later high-performance indexing.
```
