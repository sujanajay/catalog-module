#!/usr/bin/env bash
# M0-S4: the daily export of the catalog graph to BigQuery (docs/program/requirements/M0-catalog-graph.md F5, D21).
# Check-then-create and re-runnable: each object is looked up first and printed as SKIP when it matches, UPDATE when it
# differs, CREATE when it is missing. Never deletes anything.
#
# What it makes (all in project image-links-agent, region and location asia-south1):
#   dataset   catalog_os (BigQuery), where the job writes options, listings, listing_keys, key_conflicts,
#             content_versions, change_events, live_intervals, treatment_assignments, outcome_keys and export_runs
#   grants    catalog-worker@: roles/bigquery.dataEditor on catalog_os (GRANT statement; 'bq add-iam-policy-binding'
#             does not cover datasets), roles/bigquery.jobUser and roles/run.invoker on the project (the scheduler
#             starts the job as catalog-worker@). With DATA_TEAM_MEMBER=group:someone@opptra.com also
#             roles/bigquery.dataViewer on catalog_os for the data team (F5 open question: the default reader).
#   job       Cloud Run job catalog-graph-export: the live catalog-worker's image, service account, VPC and database
#             settings (references only; the password stays a Secret Manager reference), DB_POOL_MAX=1, node
#             dist/catalog-graph-export.js, 2 retries, 30-minute task timeout. Labels app=catalog,
#             component=catalog-graph-export, env=live.
#   schedule  Cloud Scheduler job catalog-graph-export: every day at 02:30 UTC (F5-R5: after 02:00 UTC), a POST to the
#             Cloud Run Admin API's jobs:run with an OAuth token of catalog-worker@.
# The freshness alert is policy 15 in infra/monitoring/ (infra/monitoring.sh), fed by the sweep's graph_export_stale
# invariant (packages/core/src/catalog/invariants/checks.ts).
#
# Usage (Git Bash, from the repo root):
#   bash infra/catalog-graph-export.sh          # setup: dataset, grants, job, schedule
#   bash infra/catalog-graph-export.sh job      # only the job, to the current catalog-worker (infra/deploy.sh step 8);
#                                               # leaves a job that was never set up alone
#   bash infra/catalog-graph-export.sh run      # execute the job once and wait (writes to catalog_os)
# PowerShell (from the repo root):
#   & "$env:LOCALAPPDATA\Programs\Git\bin\bash.exe" infra/catalog-graph-export.sh
# Env: DATA_TEAM_MEMBER=group:data-team@opptra.com (optional). Secret values are never read or printed.
set -euo pipefail

PROJECT=image-links-agent
REGION=asia-south1
LOCATION=asia-south1
DATASET=catalog_os
JOB=catalog-graph-export
SCHEDULE="30 2 * * *"
SCHEDULE_TZ=Etc/UTC
WORKER=catalog-worker@$PROJECT.iam.gserviceaccount.com
RUN_URI="https://run.googleapis.com/v2/projects/$PROJECT/locations/$REGION/jobs/$JOB:run"
# Pin this project for every gcloud call without touching global gcloud config.
export CLOUDSDK_CORE_PROJECT=$PROJECT
cd "$(dirname "$0")/.."

log()    { printf '[graph-export] %s\n' "$*"; }
skip()   { printf '[graph-export] SKIP   %s\n' "$*"; }
create() { printf '[graph-export] CREATE %s\n' "$*"; }
update() { printf '[graph-export] UPDATE %s\n' "$*"; }
die()    { printf '[graph-export] ERROR  %s\n' "$*" >&2; exit 1; }

# gcloud and bq on Windows emit CRLF; strip CR from anything we parse.
gcv() { gcloud "$@" | tr -d '\r'; }
bqv() { bq --project_id="$PROJECT" "$@" | tr -d '\r'; }
# Standard SQL statement on stdin, run as a query job in this project.
bq_exec() { # description
  local out
  if ! out=$(bq query --project_id="$PROJECT" --location="$LOCATION" --nouse_legacy_sql 2>&1); then
    printf '%s\n' "$out" | tr -d '\r' | tail -5 >&2
    die "$1 failed"
  fi
}

DATA_TEAM_MEMBER=${DATA_TEAM_MEMBER:-}
if [ -n "$DATA_TEAM_MEMBER" ] && ! [[ "$DATA_TEAM_MEMBER" =~ ^(group|user|serviceAccount):[^[:space:],@\"]+@[^[:space:],@\"]+$ ]]; then
  die "DATA_TEAM_MEMBER must look like group:name@opptra.com"
fi

# --- dataset ---------------------------------------------------------------------------------
ensure_dataset() {
  local json loc
  if json=$(bqv show --format=prettyjson "$PROJECT:$DATASET" 2>/dev/null); then
    loc=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0, "utf8")).location || "")' <<<"$json")
    [ "$loc" = "$LOCATION" ] || die "dataset $PROJECT:$DATASET exists in location '$loc', expected $LOCATION"
    skip "dataset $PROJECT:$DATASET ($LOCATION)"
  else
    create "dataset $PROJECT:$DATASET ($LOCATION)"
    bq --project_id="$PROJECT" --location="$LOCATION" mk --dataset \
      --description="Catalog graph, exported daily by the Cloud Run job $JOB (infra/catalog-graph-export.sh)" \
      "$PROJECT:$DATASET" >/dev/null
  fi
}

# Whether <member> holds <role> on the dataset; the legacy names WRITER and READER count for dataEditor and dataViewer.
dataset_has() { # role member
  bqv show --format=prettyjson "$PROJECT:$DATASET" | node -e '
    const ds = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const [role, member] = process.argv.slice(1);
    const legacy = { "roles/bigquery.dataEditor": "WRITER", "roles/bigquery.dataViewer": "READER" }[role];
    const [kind, email] = member.split(/:(.*)/s);
    const field = { user: "userByEmail", serviceAccount: "userByEmail", group: "groupByEmail" }[kind];
    const hit = (ds.access || []).some((a) => (a.role === role || a.role === legacy) && (a.iamMember === member || (field && a[field] === email)));
    process.exit(hit ? 0 : 1);
  ' "$1" "$2"
}
ensure_dataset_grant() { # role member
  local role=$1 member=$2 bt='`'
  if dataset_has "$role" "$member"; then
    skip "dataset access $PROJECT:$DATASET: $role -> $member"
  else
    create "dataset access $PROJECT:$DATASET: $role -> $member"
    printf 'GRANT %s%s%s ON SCHEMA %s%s%s.%s TO "%s"' "$bt" "$role" "$bt" "$bt" "$PROJECT" "$bt" "$DATASET" "$member" \
      | bq_exec "GRANT $role on $DATASET"
  fi
}

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
ensure_job() { # [existing-only]: leave a missing job alone (deploy.sh: the export is set up by hand first)
  local tmp
  tmp=$(mktemp -d)
  TMP_DIRS+=("$tmp")
  # Environment references only; the mounted DB password is never read here.
  gcloud run services describe catalog-worker --region="$REGION" --format=json > "$tmp/worker.json"
  node --input-type=commonjs - "$tmp" "$JOB" "$WORKER" "$DATASET" <<'NODE'
const fs = require('node:fs'), assert = require('node:assert/strict');
const [dir, name, sa, dataset] = process.argv.slice(2);
const worker = JSON.parse(fs.readFileSync(`${dir}/worker.json`));
const live = worker.spec.template.spec.containers[0];
assert.match(live.image ?? '', /^asia-south1-docker\.pkg\.dev\/image-links-agent\/apps\/worker[:@]/, 'catalog-worker runs no worker image');
const names = ['GCP_PROJECT', 'DB_HOST', 'DB_NAME', 'DB_USER'];
const env = live.env.filter((e) => names.includes(e.name) && typeof e.value === 'string');
for (const n of names) assert(env.find((e) => e.name === n && e.value), `Missing worker ${n}`);
const password = live.env.find((e) => e.name === 'DB_PASSWORD');
assert.equal(password?.valueFrom?.secretKeyRef?.name, 'catalog-db-password', 'DB_PASSWORD must be the catalog-db-password secret reference');
env.push(password, { name: 'DB_POOL_MAX', value: '1' }, { name: 'GRAPH_EXPORT_DATASET', value: dataset });
const annotations = {
  'run.googleapis.com/execution-environment': 'gen2',
  'run.googleapis.com/network-interfaces': JSON.stringify([{ network: 'ila-vpc', subnetwork: 'ila-subnet' }]),
  'run.googleapis.com/vpc-access-egress': 'private-ranges-only',
};
const task = {
  serviceAccountName: sa, maxRetries: 2, timeoutSeconds: '1800',
  containers: [{ image: live.image, command: ['node'], args: ['dist/catalog-graph-export.js'], resources: { limits: { cpu: '2', memory: '4Gi' } }, env }],
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
      if [ "${1:-}" = existing-only ]; then skip "Cloud Run job $JOB (not set up yet; run bash infra/catalog-graph-export.sh)"; return; fi
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

setup() {
  command -v node >/dev/null || die "node is required"
  command -v bq >/dev/null || die "bq is required (Cloud SDK)"
  log "graph export: $PROJECT:$DATASET ($LOCATION), job $JOB, schedule $SCHEDULE $SCHEDULE_TZ"
  ensure_dataset
  ensure_dataset_grant roles/bigquery.dataEditor "serviceAccount:$WORKER"
  if [ -n "$DATA_TEAM_MEMBER" ]; then
    ensure_dataset_grant roles/bigquery.dataViewer "$DATA_TEAM_MEMBER"
  else
    log "no DATA_TEAM_MEMBER given: the data team's read access to $DATASET is not granted here"
  fi
  ensure_project_role roles/bigquery.jobUser "serviceAccount:$WORKER"
  ensure_project_role roles/run.invoker "serviceAccount:$WORKER"
  ensure_job
  ensure_schedule
  log "done"
}

run() {
  [ -n "$(gcv run jobs list --region="$REGION" --filter="metadata.name=$JOB" --format='value(metadata.name)')" ] \
    || die "$JOB does not exist yet; run bash infra/catalog-graph-export.sh first"
  log "EXECUTE $JOB and wait (writes the graph to $PROJECT:$DATASET)"
  gcloud run jobs execute "$JOB" --region="$REGION" --wait
}

case "${1:-setup}" in
  setup) setup ;;
  job) ensure_job existing-only ;;
  run) run ;;
  *) echo "Usage: bash infra/catalog-graph-export.sh [setup|job|run]" >&2; exit 2 ;;
esac
