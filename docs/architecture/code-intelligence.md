# Code Intelligence

Code intelligence provides repository context for review decisions.

`workers/code-intel` owns:

- Repository clone and fetch operations.
- Diff parsing and patch handling.
- Language and framework detection.
- Source range extraction.
- Changed symbol extraction.
- File, symbol, dependency, and test graph construction.
- Related test detection.
- Repository metadata extraction.
- Code graph, diff, and snapshot artifacts.

`workers/indexer` is optional later. Add it only when the default code intelligence worker and native tools are not enough for large repositories or hot indexing paths.
