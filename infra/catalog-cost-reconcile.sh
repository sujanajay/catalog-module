#!/usr/bin/env bash
# M6-S2: the daily cost reconciliation (docs/program/requirements/M6-reliability-cost.md M6-F1-R4 to R6, R10; build
# decisions S2-1 to S2-12). Check-then-create and re-runnable: each object is looked up first and printed as SKIP when
# it matches, UPDATE when it differs, CREATE when it is missing. Never deletes anything.
#
# What it makes (all in project image-links-agent, region asia-south1):
#   grants    catalog-worker@: roles/monitoring.viewer (reads run.googleapis.com/container/billable_instance_time) and
#             roles/run.viewer (reads the shape and labels of every Cloud Run service and job) on the project, plus
#             roles/run.invoker (the scheduler starts the job as catalog-worker@). Read-only roles: the job writes only
#             to the catalog database.
#   job       Cloud Run job catalog-cost-reconcile: the live catalog-worker's image, service account, VPC and database
#             settings (references only; the password stays a Secret Manager reference), DB_POOL_MAX=1, node
#             dist/catalog-cost-reconcile.js, 2 retries, 30-minute task timeout. Labels app=catalog,
#             component=catalog-cost-reconcile, env=live.
#   schedule  Cloud Scheduler job catalog-cost-reconcile: every day at 06:00 UTC (M6-F1-R8: day D at D+1 06:00 UTC), a
#             POST to the Cloud Run Admin API's jobs:run with an OAuth token of catalog-worker@.
#   first run until the job has one successful execution, setup runs it once with COST_RECONCILE_DAYS=14 (a backfill
#             of the last two weeks) and waits, so the Ops cost card has days from the day of setup and a schedule that
#             never fires is reported by the freshness alert (cost_reconcile_stale) 30 hours later.
#             COST_RECONCILE_SKIP_FIRST_RUN=1 skips it.
# Alerts (infra/monitoring/, applied by infra/monitoring.sh): the job writes each alert (a ledger above the bill, an
# unlabelled or unpriced resource, a 7-day batch success rate under target) as an `alert` incident; policy 16 emails it
# through the sweep's daily_check_alert invariant, policy 17 through cost_reconcile_stale (no new rows for 30 hours,
# which also covers a failed run).
#
# Usage (Git Bash, from the repo root):
#   bash infra/catalog-cost-reconcile.sh            # setup: grants, job, schedule, first run
#   bash infra/catalog-cost-reconcile.sh job        # only the job, to the current catalog-worker (infra/deploy.sh step 8);
#                                                   # leaves a job that was never set up alone
#   bash infra/catalog-cost-reconcile.sh run [days] # execute the job once and wait (days: 1 to 42, default 3)
# PowerShell (from the repo root):
#   & "$env:LOCALAPPDATA\Programs\Git\bin\bash.exe" infra/catalog-cost-reconcile.sh
# Secret values are never read or printed.
set -euo pipefail

PROJECT=image-links-agent
REGION=asia-south1
JOB=catalog-cost-reconcile
SCHEDULE="0 6 * * *"
SCHEDULE_TZ=Etc/UTC
FIRST_RUN_DAYS=14
WORKER=catalog-worker@$PROJECT.iam.gserviceaccount.com
RUN_URI="https://run.googleapis.com/v2/projects/$PROJECT/locations/$REGION/jobs/$JOB:run"
# Pin this project for every gcloud call without touching global gcloud config.
export CLOUDSDK_CORE_PROJECT=$PROJECT
cd "$(dirname "$0")/.."

log()    { printf '[cost-reconcile] %s\n' "$*"; }
skip()   { printf '[cost-reconcile] SKIP   %s\n' "$*"; }
create() { printf '[cost-reconcile] CREATE %s\n' "$*"; }
update() { printf '[cost-reconcile] UPDATE %s\n' "$*"; }
die()    { printf '[cost-reconcile] ERROR  %s\n' "$*" >&2; exit 1; }

# gcloud on Windows emits CRLF; strip CR from anything we parse.
gcv() { gcloud "$@" | tr -d '\r'; }

# --- project roles ---------------------------------------------------------------------------
PROJECT_POLICY=
ensure_project_role() { # role member
  local role=$1 member=$2
  [ -n "$PROJECT_POLICY" ] || PROJECT_POLICY=$(gcv projects get-iam-policy "$PROJECT" --flatten='bindings[].members' \
    --format='csv[no-heading](bindings.role,bindings.members)')
  if grep -qxF "$role,$member" <<<"$PROJECT_POLICY"; then
    skip "project binding $role -> $member"
  else
    create "project binding $role -> $member"
    gcloud projects add-iam-policy-binding "$PROJECT" --member="$member" --role="$role" --condition=None >/dev/null
  fi
}

# --- job -------------------------------------------------------------------------------------
# Scratch folders of this run (the worker description and the job file), removed on exit.
TMP_DIRS=()
cleanup() { local d; for d in "${TMP_DIRS[@]}"; do rm -f -- "$d/worker.json" "$d/job.json" "$d/existing.json"; rmdir -- "$d" 2>/dev/null || true; done; }
trap cleanup EXIT
ensure_job() { # [existing-only]: leave a missing job alone (deploy.sh: the reconciliation is set up by hand first)
  local tmp
  tmp=$(mktemp -d)
  TMP_DIRS+=("$tmp")
  # Environment references only; the mounted DB password is never read here.
  gcloud run services describe catalog-worker --region="$REGION" --format=json > "$tmp/worker.json"
  node --input-type=commonjs - "$tmp" "$JOB" "$WORKER" <<'NODE'
const fs = require('node:fs'), assert = require('node:assert/strict');
const [dir, name, sa] = process.argv.slice(2);
const worker = JSON.parse(fs.readFileSync(`${dir}/worker.json`));
const live = worker.spec.template.spec.containers[0];
assert.match(live.image ?? '', /^asia-south1-docker\.pkg\.dev\/image-links-agent\/apps\/worker[:@]/, 'catalog-worker runs no worker image');
const names = ['GCP_PROJECT', 'DB_HOST', 'DB_NAME', 'DB_USER'];
const env = live.env.filter((e) => names.includes(e.name) && typeof e.value === 'string');
for (const n of names) assert(env.find((e) => e.name === n && e.value), `Missing worker ${n}`);
const password = live.env.find((e) => e.name === 'DB_PASSWORD');
assert.equal(password?.valueFrom?.secretKeyRef?.name, 'catalog-db-password', 'DB_PASSWORD must be the catalog-db-password secret reference');
env.push(password, { name: 'DB_POOL_MAX', value: '1' });
const annotations = {
  'run.googleapis.com/execution-environment': 'gen2',
  'run.googleapis.com/network-interfaces': JSON.stringify([{ network: 'ila-vpc', subnetwork: 'ila-subnet' }]),
  'run.googleapis.com/vpc-access-egress': 'private-ranges-only',
};
const task = {
  serviceAccountName: sa, maxRetries: 2, timeoutSeconds: '1800',
  containers: [{ image: live.image, command: ['node'], args: ['dist/catalog-cost-reconcile.js'], resources: { limits: { cpu: '1', memory: '1Gi' } }, env }],
};
const desired = { apiVersion: 'run.googleapis.com/v1', kind: 'Job', metadata: { name, labels: { app: 'catalog', component: name, env: 'live' } },
  spec: { template: { metadata: { annotations }, spec: { taskCount: 1, parallelism: 1, template: { spec: task } } } } };
fs.writeFileSync(`${dir}/job.json`, JSON.stringify(desired));
NODE
  # A successful list tells a missing job apart from an API that cannot be read.
  gcloud run jobs list --region="$REGION" --filter="metadata.name=$JOB" --format=json > "$tmp/existing.json"
  local state
  state=$(node --input-type=commonjs - "$tmp/existing.json" "$tmp/job.json" <<'NODE'
const fs = require('node:fs');
const [oldFile, newFile] = process.argv.slice(2), old = JSON.parse(fs.readFileSync(oldFile))[0], desired = JSON.parse(fs.readFileSync(newFile));
function contains(a, b) { if (Array.isArray(b)) return Array.isArray(a) && a.length === b.length && b.every((v, i) => contains(a[i], v)); if (b && typeof b === 'object') return !!a && Object.entries(b).every(([k, v]) => contains(a[k], v)); return a === b; }
process.stdout.write(!old ? 'missing' : contains(old.spec, desired.spec) && contains(old.metadata?.labels, desired.metadata.labels) ? 'same' : 'differs');
NODE
)
  case "$state" in
    same) skip "Cloud Run job $JOB (image, settings and labels match catalog-worker)"; return ;;
    missing)
      if [ "${1:-}" = existing-only ]; then skip "Cloud Run job $JOB (not set up yet; run bash infra/catalog-cost-reconcile.sh)"; return; fi
      create "Cloud Run job $JOB" ;;
    *) update "Cloud Run job $JOB (to the current catalog-worker image and settings)" ;;
  esac
  gcloud run jobs replace "$tmp/job.json" --region="$REGION" --quiet >/dev/null
}

# --- schedule --------------------------------------------------------------------------------
ensure_schedule() {
  local current want
  want="$SCHEDULE|$SCHEDULE_TZ|$RUN_URI|$WORKER"
  if current=$(gcv scheduler jobs describe "$JOB" --location="$REGION" \
      --format='value[separator="|"](schedule,timeZone,httpTarget.uri,httpTarget.oauthToken.serviceAccountEmail)' 2>/dev/null); then
    if [ "$current" = "$want" ]; then
      skip "scheduler job $JOB ($SCHEDULE $SCHEDULE_TZ)"
    else
      update "scheduler job $JOB ($current -> $want)"
      gcloud scheduler jobs update http "$JOB" --location="$REGION" --schedule="$SCHEDULE" --time-zone="$SCHEDULE_TZ" \
        --uri="$RUN_URI" --http-method=POST --oauth-service-account-email="$WORKER" \
        --oauth-token-scope=https://www.googleapis.com/auth/cloud-platform >/dev/null
    fi
  else
    create "scheduler job $JOB ($SCHEDULE $SCHEDULE_TZ -> $JOB)"
    gcloud scheduler jobs create http "$JOB" --location="$REGION" --schedule="$SCHEDULE" --time-zone="$SCHEDULE_TZ" \
      --uri="$RUN_URI" --http-method=POST --oauth-service-account-email="$WORKER" \
      --oauth-token-scope=https://www.googleapis.com/auth/cloud-platform --attempt-deadline=180s >/dev/null
  fi
}

# --- first run ---------------------------------------------------------------------------------
ensure_first_run() {
  local ok
  ok=$(gcv run jobs executions list --job="$JOB" --region="$REGION" --format='value(metadata.name,status.succeededCount)' | awk '$2 >= 1 { print $1; exit }')
  if [ -n "$ok" ]; then
    skip "first run of $JOB (execution $ok succeeded)"
  elif [ "${COST_RECONCILE_SKIP_FIRST_RUN:-0}" = 1 ]; then
    log "NEXT STEP: no successful run of $JOB yet; run bash infra/catalog-cost-reconcile.sh run $FIRST_RUN_DAYS"
  else
    create "first run of $JOB (the last $FIRST_RUN_DAYS days; executes now and waits)"
    gcloud run jobs execute "$JOB" --region="$REGION" --update-env-vars="COST_RECONCILE_DAYS=$FIRST_RUN_DAYS" --wait \
      || die "the first run of $JOB failed; read its logs: gcloud run jobs executions list --job=$JOB --region=$REGION"
  fi
}

setup() {
  command -v node >/dev/null || die "node is required"
  log "cost reconciliation: job $JOB, schedule $SCHEDULE $SCHEDULE_TZ"
  ensure_project_role roles/monitoring.viewer "serviceAccount:$WORKER"
  ensure_project_role roles/run.viewer "serviceAccount:$WORKER"
  ensure_project_role roles/run.invoker "serviceAccount:$WORKER"
  ensure_job
  ensure_schedule
  ensure_first_run
  log "done"
}

run() {
  local days=${1:-3}
  [[ "$days" =~ ^[0-9]+$ ]] && [ "$days" -ge 1 ] && [ "$days" -le 42 ] || die "days must be a whole number from 1 to 42"
  [ -n "$(gcv run jobs list --region="$REGION" --filter="metadata.name=$JOB" --format='value(metadata.name)')" ] \
    || die "$JOB does not exist yet; run bash infra/catalog-cost-reconcile.sh first"
  log "EXECUTE $JOB for the last $days days and wait (writes catalog_cost_days and catalog_cost_allocations)"
  gcloud run jobs execute "$JOB" --region="$REGION" --update-env-vars="COST_RECONCILE_DAYS=$days" --wait
}

case "${1:-setup}" in
  setup) setup ;;
  job) ensure_job existing-only ;;
  run) run "${2:-}" ;;
  *) echo "Usage: bash infra/catalog-cost-reconcile.sh [setup|job|run [days]]" >&2; exit 2 ;;
esac
