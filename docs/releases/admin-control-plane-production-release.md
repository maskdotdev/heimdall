# Admin Control-Plane Production Release

Use this document as the production release ticket when GitHub Issues is unavailable. Prefer the
GitHub issue template in `.github/ISSUE_TEMPLATE/admin-control-plane-production-release.md` for the
actual release record.

## Objective

Promote the admin control plane to Railway production using the committed manifest, service
configuration files, release gates, and rollback plan.

## Release Inputs

| Input | Location |
| --- | --- |
| Deployment manifest | `infra/production/railway-admin-control-plane.json` |
| API Railway config | `/infra/railway/api.railway.json` |
| Dashboard Railway config | `/infra/railway/dashboard.railway.json` |
| Admin gateway Railway config | `/infra/railway/admin-gateway.railway.json` |
| Worker general Railway config | `/infra/railway/worker-general.railway.json` |
| Worker index Railway config | `/infra/railway/worker-index.railway.json` |
| Worker review Railway config | `/infra/railway/worker-review.railway.json` |
| Worker embedding Railway config | `/infra/railway/worker-embedding.railway.json` |
| Worker publisher Railway config | `/infra/railway/worker-publisher.railway.json` |
| Worker maintenance Railway config | `/infra/railway/worker-maintenance.railway.json` |
| Staging proof evidence | `docs/evidence/admin-control-plane-staging-proof.json` |
| Sandbox staging proof evidence | `docs/evidence/sandbox-staging-proof.json` |
| Production runbook | `docs/runbooks/admin-control-plane.md` |
| CI release gate | `pnpm ci:control-plane:release` |

## Owner Assignments

| Owner role | Person | Status |
| --- | --- | --- |
| Release owner | TBD | Pending |
| Gateway owner | TBD | Pending |
| API/dashboard owner | TBD | Pending |
| Operations owner | TBD | Pending |
| Security owner | TBD | Pending |

## Gate Checklist

- [ ] Release commit is selected.
- [ ] `pnpm ci:control-plane:release` passed locally or in CI on the release commit.
- [ ] `pnpm proof:sandbox:staging` passed against the deployed staging worker sandbox evidence.
- [ ] CI passed on `main` for the release commit.
- [ ] Railway service settings point to the committed config-as-code files.
- [ ] API, dashboard, admin gateway, worker, Postgres, and Redis services exist in production.
- [ ] Production secrets are present in Railway and not copied into this ticket.
- [ ] Production alerts exist for health, auth failure rate, replay audit visibility, settings
      audit visibility, and emergency disable.
- [ ] Production monitoring dashboards exist for health, auth/access, actions/audit, worker queues,
      data services, artifact security, and release/rollback checks.
- [ ] Rollback revisions and emergency disable commands are identified.

## Enablement Record

| Step | Evidence |
| --- | --- |
| API deployed with admin disabled | Pending |
| Dashboard deployed with production API URL | Pending |
| Gateway deployed with GitHub OAuth and strict origins | Pending |
| Worker deployed with production queue/database variables | Pending |
| Health checks pass | Pending |
| Admin routes return 404 while disabled | Pending |
| Gateway login and assertion proof pass | Pending |
| Negative origin/login checks pass | Pending |
| API admin routes enabled | Pending |
| Manual dashboard drill completed | Pending |
| Audit log IDs recorded | Pending |

## Production Monitoring Record

| Dashboard or signal | Link or query | Status | Notes |
| --- | --- | --- | --- |
| Control-plane health | Pending | Pending | API, dashboard, and gateway health |
| Auth and access | Pending | Pending | Admin auth success, denials, and gateway rejections |
| Actions and audit | Pending | Pending | Replay, settings, debug export, and eval import audit visibility |
| Worker queues | Pending | Pending | Worker heartbeat, queue depth, and oldest job age |
| Data services | Pending | Pending | Postgres, Redis, migrations, and queue recovery |
| Artifact security | Pending | Pending | Artifact storage errors and raw-access denials |
| Release and rollback | Pending | Pending | Deploy revisions, gate results, and emergency disable |

## Follow-Up Issue Tracking

| Issue | Owner | Severity | Due date | Status |
| --- | --- | --- | --- | --- |
| Pending | TBD | TBD | TBD | Pending |

## Go/No-Go Decision

- Decision: Pending
- Decider: TBD
- Decision time: TBD
- Notes: TBD

## Rollback Record

- Emergency disable command: Pending
- API rollback revision: Pending
- Dashboard rollback revision: Pending
- Admin gateway rollback revision: Pending
- Verification output: Pending

## Post-Enablement

- [ ] Watch production for one hour after enablement.
- [ ] Confirm no unexpected `admin.access.denied` spike.
- [ ] Confirm every `admin.replay.dispatched` has a matching replay audit row.
- [ ] Confirm every `admin.settings.updated` has a matching `repo.settings.updated` row.
- [ ] Record production dashboard links and alert check results.
- [ ] Create follow-up issues for every unresolved alert, manual mitigation, missing dashboard,
      missing alert, disabled route, or deferred phase risk.
- [ ] Close the release after owners sign off and critical follow-up issues have owners.
