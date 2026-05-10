# Tech Stack

Heimdall uses the following target technology stack.

| Area | Technology |
| --- | --- |
| Frontend | React, Vite, TanStack Router, TanStack Query |
| API | Go |
| Workflow | Temporal |
| Review workers | Python |
| Code indexing | Python first, Rust later for hot paths |
| Database | Postgres |
| Artifacts | S3-compatible object storage |
| Cache and limits | Redis |
| Compute | Kubernetes for production, optional for MVP |
| Contracts | Protobuf, OpenAPI, JSON Schema |
| Observability | OpenTelemetry, Prometheus/Grafana, Sentry |
