# Agent Notes

## Testing Philosophy

| Good Tests | Bad Tests |
| --- | --- |
| Exercise real code through public interfaces | Mock internal collaborators |
| Describe WHAT the system does | Test HOW it's implemented |
| Survive internal refactors unchanged | Break on refactoring without behavior change |
| Read like specifications | Test the shape of data structures |
| Focus on user-facing behavior | Verify through external means (DB queries, call counts) |
