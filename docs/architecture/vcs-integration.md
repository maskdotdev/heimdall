# VCS Integration

Provider-specific behavior should stay behind VCS adapter boundaries.

Core rules:

- Normalize provider payloads before they enter application or review logic.
- Keep GitHub and GitLab differences out of shared review packages.
- Verify webhook signatures at ingress.
- Redact raw provider payloads before logging.
- Treat provider rate limits as publishing and synchronization concerns, not reviewer concerns.

Primary locations:

- `apps/api/src/routes` for ingress routes.
- `apps/api/src/ports` for provider-facing interfaces.
- `packages/vcs` for provider abstractions and normalization.

