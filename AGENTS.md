# Working rules for this repo
- Source of truth: docs/SPEC.md. Plans live in docs/plans/, learnings in docs/solutions/.
  Executable specs live in docs/specs/ and are run through docs/specs/00-execution-protocol.md
  (open a spec, say "execute").
- GCP project image-links-agent, region asia-south1. Use gcloud only; every infra change goes in
  infra/*.sh, idempotent (check-then-create), re-runnable.
- The operator's gcloud default project is NOT this one. Scripts must export
  CLOUDSDK_CORE_PROJECT=image-links-agent rather than changing global gcloud config.
- Never print, read, or log secret values. Secrets come from Secret Manager env mounts only.
  Never run `gcloud secrets versions access`.
- My IAM: roles/editor + projectIamAdmin + serviceAccountAdmin. Resource-level IAM on Cloud Run
  services may be denied; grant at project level instead and note it in docs/solutions/.
- No deletes of GCP resources without asking me.
- Shared resources from the earlier app in the same project (VPC ila-vpc, subnet ila-subnet,
  Cloud SQL instance ila-pg, bucket image-links-agent-assets, Artifact Registry repo apps, secret
  openrouter-api-key) are reused and never deleted. The earlier ila-web and ila-worker services
  are not touched.
- Supabase is read only. Never write to it.
- Live OpenRouter calls only in Cloud Run jobs gated by LIVE_SMOKE=1. All other tests mock OpenRouter.
- Keep costs low: Cloud Run min-instances 0, Cloud SQL db-f1-micro, no always-on resources.
- Use subagents for independent workstreams; one git worktree per workstream
  (C:\Users\Sujan AH\Desktop\catalog-module-wt\<nn>-<slug>); merge via PR.
- Conventional commit messages (feat:, fix:, chore:, docs:). Never commit directly to main.
  Never add an agent name as co-author.
- No em dashes anywhere (code, docs, UI text, commits). Use "-".
- Test cleanup only under the catalog-test/ prefix, in both buckets.
- The worker only overwrites or deletes public objects under the prefix of the product it holds
  the lock for, and only on the channels of the running batch (assertWithinProduct). Never raw,
  never exports, never outside catalog/ and catalog-test/.
- Before using any external library, framework, API or SDK, look up its current docs with Context7.
- Models are chosen automatically per brand and category and are never shown to the operator.
  Model ids never appear in UI copy.


