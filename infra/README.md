# Infrastructure

Infrastructure files are grouped by deployment concern.

```txt
docker/      Container definitions.
k8s/         Kubernetes base manifests and environment overlays.
terraform/   Cloud resources and environment composition.
temporal/    Workflow task queues and worker settings.
migrations/  Database migrations.
```

Keep local development configuration separate from production deployment configuration.

