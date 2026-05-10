# API App

API and control-plane boundary.

Expected ownership:

- HTTP routes and middleware.
- Authentication and authorization checks.
- Provider webhook ingress.
- Application use cases.
- Job dispatch.
- Persistence and provider port wiring.

Shared review behavior belongs in packages, not app internals.

