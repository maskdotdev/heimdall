# Workflow Service

The workflow service owns durable orchestration.

Expected ownership:

- Review workflows.
- Publishing workflows.
- Repository synchronization workflows.
- Activities that call VCS, clone, diff, code intelligence, scanner, context, review, validation, and publishing workers.
- Task queue names and routing.
- Payload conversion.
- Workflow tests.

Keep review-quality logic in workers and contracts, not in workflow glue.

