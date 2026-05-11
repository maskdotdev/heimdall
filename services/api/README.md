# API Service

The API service owns the control plane.

Expected ownership:

- Authentication and provider authorization flows.
- Repository, change request, review run, and finding APIs.
- Provider webhook ingress.
- Review-run creation and workflow starts.
- Publishing commands.
- Persistence, VCS, object storage, rate-limit, secret, Redis, metrics, and logging adapter wiring.

Shared payloads belong in `contracts`, not local service-only copies.

