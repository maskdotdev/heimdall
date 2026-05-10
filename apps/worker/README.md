# Worker App

Background review pipeline boundary.

Expected ownership:

- Repository checkout jobs.
- Diff and code graph jobs.
- Context bundle construction jobs.
- Reviewer execution jobs.
- Finding validation jobs.
- Publishing jobs.
- Workspace cleanup.

Reusable logic should live in packages and be called from jobs.

