# Cloud Run service-level max instances - learnings

## What differed
Cloud Run has two max-instance caps, and the lower one wins:
- Revision-level: `gcloud run deploy --max-instances=N` (annotation `autoscaling.knative.dev/maxScale` on the
  revision template). Immutable per revision; changing it deploys a new revision. This is the only one
  infra/lib/services.sh set before 2026-10-30.
- Service-level: `gcloud run deploy --max=N` or `gcloud run services update --max=N` (annotation
  `run.googleapis.com/maxScale` in the service's `metadata.annotations`). Takes effect immediately and,
  per the gcloud 589 help and the Cloud Run docs, "can be modified without deploying a new Revision".

Every catalog service still carried a service-level max from its first deploy, which the repo never set:

| Service | Service-level | Revision-level |
|---|---|---|
| catalog-worker | 10 | 24 |
| catalog-upscale | 4 | 16 |
| catalog-matting | 20 | 4 |
| catalog-web | 10 | 3 |
| catalog-matting-gpu | 3 | 3 |

## How it was found
2026-10-30, during the 200-product live load test (load batch c90d496c): catalog-upscale never went past 4
instances although the shape (infra/lib/shape.sh) and the revision said 16. `gcloud run services describe`
showed `run.googleapis.com/maxScale: 4` on the service next to `autoscaling.knative.dev/maxScale: 16` on the
template. The worker was capped the same way (10 instead of 24).

## Fix
- Each registry entry in infra/lib/services.sh sets `SVC_MAX` from the same variable as its `--max-instances`.
- `deploy_service` (infra/lib/gate.sh) calls `gate_service_max` whenever a revision is left serving (after the
  traffic shift, and on SKIP): it reads `run.googleapis.com/maxScale` and runs
  `gcloud run services update <svc> --max=<SVC_MAX>` only when it differs. A no-shift candidate (measure rungs,
  the preview GPU) and a reused service never change it, so a measure rung cannot throttle the live service.
- The shape's CPU quota count (`CPU_TOTAL`, limit 190 vCPU, 187 at today's shape) uses the same variables, so it
  now holds at both levels.
- Do not use `--max-instances` on `services update` to fix a cap live: that deploys a new revision.

## Check
```
gcloud run services describe <svc> --region=asia-south1 \
  --format="value(metadata.annotations['run.googleapis.com/maxScale'],spec.template.metadata.annotations['autoscaling.knative.dev/maxScale'])"
```
Both values should match.
