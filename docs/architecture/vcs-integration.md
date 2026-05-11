# VCS Integration

Provider-specific behavior should stay behind service and worker adapter boundaries.

Core rules:

- Normalize provider payloads before they enter review logic.
- Keep GitHub and GitLab differences out of shared contracts except where contracts explicitly model provider references.
- Verify webhook signatures at ingress.
- Redact raw provider payloads before logging.
- Treat provider rate limits as synchronization and publishing concerns, not reviewer concerns.

Primary locations:

- `services/api/internal/adapters/vcs` for provider clients and webhook normalization.
- `services/api/internal/transport/http` for webhook ingress.
- `workers/publisher/src/deepreviewer_publisher/providers` for provider-specific comment publishing.
- `contracts` for normalized provider references and publishable review contracts.
