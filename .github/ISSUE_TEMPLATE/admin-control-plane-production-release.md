---
name: Admin control-plane production release
about: Promote the admin control plane to production with gated evidence.
title: "release: admin control-plane production"
labels: ["release", "admin-control-plane"]
assignees: ""
---

## Objective

Promote the admin control plane to Railway production using the committed manifest, release gates,
and rollback plan.

## Owners

- Release owner:
- Gateway owner:
- API/dashboard owner:
- Operations owner:
- Security owner:

## Commit and Artifacts

- Release commit:
- Production deployment manifest: `infra/production/railway-admin-control-plane.json`
- API Railway config: `/infra/railway/api.railway.json`
- Dashboard Railway config: `/infra/railway/dashboard.railway.json`
- Admin gateway Railway config: `/infra/railway/admin-gateway.railway.json`
- Worker general Railway config: `/infra/railway/worker-general.railway.json`
- Worker index Railway config: `/infra/railway/worker-index.railway.json`
- Worker review Railway config: `/infra/railway/worker-review.railway.json`
- Worker embedding Railway config: `/infra/railway/worker-embedding.railway.json`
- Worker publisher Railway config: `/infra/railway/worker-publisher.railway.json`
- Worker maintenance Railway config: `/infra/railway/worker-maintenance.railway.json`
- Staging proof evidence: `docs/evidence/admin-control-plane-staging-proof.json`
- Runbook: `docs/runbooks/admin-control-plane.md`

## Pre-Enablement Gates

- [ ] `pnpm ci:control-plane:release` passed on the release commit.
- [ ] CI passed on `main` for the release commit.
- [ ] Railway services use the config paths listed above.
- [ ] API, dashboard, admin gateway, worker, Postgres, and Redis services exist in production.
- [ ] Production GitHub OAuth app callback is exactly the gateway callback URL.
- [ ] Production secrets are generated and stored only in Railway.
- [ ] API starts with `HEIMDALL_ADMIN_ENABLED=false` or route exposure disabled.
- [ ] Gateway login allowlist is explicit or security owner approved all-org access.
- [ ] Alert checks are configured for health, auth failures, replay audit, settings audit, and disable.

## Enablement Checklist

- [ ] Deploy API with admin routes disabled.
- [ ] Deploy dashboard with the production API base URL.
- [ ] Deploy admin gateway with GitHub OAuth and strict dashboard origins.
- [ ] Deploy worker with production database and queue variables.
- [ ] Verify API `/healthz`, gateway `/healthz`, and dashboard root.
- [ ] Verify admin API routes return 404 while disabled.
- [ ] Complete gateway login and assertion issuance with an allowlisted operator.
- [ ] Verify missing, unlisted, and unrelated origins are rejected.
- [ ] Enable API admin routes with strict allowed origins.
- [ ] Complete the manual dashboard drill on the approved production target.
- [ ] Record login, logout, replay, and settings audit log IDs.

## Go/No-Go Decision

- Decision:
- Decider:
- Decision time:
- Notes:

## Rollback

- API disable command or Railway env change:
- API rollback revision:
- Dashboard rollback revision:
- Admin gateway rollback revision:
- Verification output:

## Post-Enablement

- [ ] Watch production for one hour after enablement.
- [ ] Confirm no unexpected `admin.access.denied` spike.
- [ ] Confirm every `admin.replay.dispatched` has a matching replay audit row.
- [ ] Confirm every `admin.settings.updated` has a matching `repo.settings.updated` row.
- [ ] Close the release after owners sign off.
