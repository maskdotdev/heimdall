# Context Bundle

The context bundle is the reviewed unit of evidence passed into reviewer agents and validators.

It should contain only the material needed to make supported findings:

- Change request metadata.
- Changed files and diff hunks.
- Changed symbols.
- Relevant surrounding source snippets.
- Dependency frontier.
- Related tests.
- Applicable review standards.
- Prior review comments when available.
- Scanner signals when deterministic scanners are added.

The bundle must avoid secrets and large unbounded payloads. Redaction and size limits should happen before data reaches model prompts or persisted artifacts.

