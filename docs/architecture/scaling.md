# Scaling

Heimdall should scale by separating control-plane work from heavy background work.

MVP:

- `apps/api` handles control-plane requests.
- `apps/worker` runs background review jobs.
- Packages define reusable review, repository intelligence, and security behavior.

Later:

- Split worker pools by queue when code intelligence, scanner, review, or publishing work begins competing for resources.
- Introduce generated contracts under `contracts/`.
- Add production deployment manifests under `infra/k8s` and `infra/terraform`.
- Move hot indexing paths behind the existing repo-intel boundaries.

