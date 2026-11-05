#!/usr/bin/env bash
# The route kill switch and its drill as a Cloud Run job (M7-F2-R5, R1 exit item 3). The job catalog-route-switch runs
# dist/catalog-route-switch.js from the live catalog-worker's image (logic in apps/worker/src/route-switch.ts):
#   show    print the route table
#   set     set one route to off or serving; logged in vendor_route_changes with the reason and who asked. Turning off
#           the last serving route of a capability is refused unless --force.
#   drill   turn off the route the batch asks first (its policy judge for judge.render, the classifier model for
#           vision.read; --route=<id> names one instead), then restore it when the batch finishes or the minutes run
#           out. The drill is recorded on the route (vendor_routes.drill_id, restore_at) and the router honours the
#           expiry, so a stopped or crashed drill job never leaves the route off past it.
# Every command prints the capability's routes before and after (in the job log; set and show print it here too).
# Check-then-create and re-runnable: the job is printed as SKIP when it matches, UPDATE when it differs, CREATE when
# it is missing. Never deletes anything.
#
# What it makes (project image-links-agent, region asia-south1):
#   job  Cloud Run job catalog-route-switch: the live catalog-worker's image, service account, VPC and database settings
#        (references only; the password stays a Secret Manager reference), its CATALOG_QA_DEFAULT_MODEL when set (the
#        built-in first judge, so the drill picks the route the worker asks first), DB_POOL_MAX=1, node
#        dist/catalog-route-switch.js, no retries (a retry would act twice), 6 h 10 min task timeout (the longest
#        drill is 360 minutes). Labels app=catalog, component=catalog-route-switch, env=live. No schedule, no
#        OpenRouter key: the job only writes the route table.
#
# Usage (Git Bash, from the repo root):
#   bash infra/catalog-route-switch.sh                         # setup: create or update the job
#   bash infra/catalog-route-switch.sh job                     # only update a job that exists (infra/deploy.sh)
#   bash infra/catalog-route-switch.sh show [capability]
#   bash infra/catalog-route-switch.sh set <route id> off|serving "<reason>" [--force]
#   bash infra/catalog-route-switch.sh drill <capability> <minutes> "<reason>" [batch id] [--route=<route id>]
#                                                              # starts the drill and returns; follow it in the log
# PowerShell (from the repo root):
#   & "$env:LOCALAPPDATA\Programs\Git\bin\bash.exe" infra/catalog-route-switch.sh drill judge.render 90 "R1 exit drill" <batch id>
# Who asked is your active gcloud account (ROUTE_ACTOR=<email> overrides it). A reason is 3 to 200 characters of
# letters, digits, spaces and . , : ( ) / # ' _ - (the job's env is passed through gcloud on Windows).
# set and show start the execution, wait for its end state on GCP and print its log (infra/lib/gcloud-retry.sh); a
# start that names no execution, a failed start and a failed execution all stop with an error.
# Secret values are never read or printed.
set -euo pipefail

PROJECT=image-links-agent
REGION=asia-south1
JOB=catalog-route-switch
WORKER=catalog-worker@$PROJECT.iam.gserviceaccount.com
CAPABILITIES='vision.read|judge.render|image.matte|image.upscale|ocr.read|people.detect'
# set and show finish in seconds: read the execution's state every 5 s.
GCLOUD_POLL_S=${GCLOUD_POLL_S:-5}
# Pin this project for every gcloud call without touching global gcloud config.
export CLOUDSDK_CORE_PROJECT=$PROJECT
cd "$(dirname "$0")/.."
# M6-S1: labels app=catalog, component=<job name>, env (infra/lib/labels.sh); a job without them is never deployed.
# shellcheck source=lib/labels.sh
source infra/lib/labels.sh
# shellcheck source=lib/gcloud-retry.sh
source infra/lib/gcloud-retry.sh
JOB_LABELS=$(catalog_labels "$JOB" live)

log()    { printf '[route-switch] %s\n' "$*"; }
skip()   { printf '[route-switch] SKIP   %s\n' "$*"; }
create() { printf '[route-switch] CREATE %s\n' "$*"; }
update() { printf '[route-switch] UPDATE %s\n' "$*"; }
die()    { printf '[route-switch] ERROR  %s\n' "$*" >&2; exit 1; }
usage()  { echo "Usage: bash infra/catalog-route-switch.sh [setup|job] | show [capability] | set <route id> off|serving \"<reason>\" [--force] | drill <capability> <minutes> \"<reason>\" [batch id] [--route=<route id>]" >&2; exit 2; }

# gcloud on Windows emits CRLF; strip CR from anything we parse.
gcv() { gcloud "$@" | tr -d '\r'; }
job_exists() { [ -n "$(gcv run jobs list --region="$REGION" --filter="metadata.name=$JOB" --format='value(metadata.name)')" ]; }

# --- job -------------------------------------------------------------------------------------
TMP_DIRS=()
cleanup() { local d; for d in "${TMP_DIRS[@]}"; do rm -f -- "$d/worker.json" "$d/job.json" "$d/existing.json" "$d/err"; rmdir -- "$d" 2>/dev/null || true; done; }
trap cleanup EXIT
ensure_job() { # [existing-only]: leave a missing job alone (deploy.sh: the job is set up by hand first)
  local tmp state
  catalog_labels_check "$JOB" "$JOB_LABELS" || exit 1
  tmp=$(mktemp -d)
  TMP_DIRS+=("$tmp")
  # Environment references only; the mounted DB password is never read here.
  gcloud run services describe catalog-worker --region="$REGION" --format=json > "$tmp/worker.json"
  node --input-type=commonjs - "$tmp" "$JOB" "$WORKER" "$JOB_LABELS" <<'NODE'
const fs = require('node:fs'), assert = require('node:assert/strict');
const [dir, name, sa, labelText] = process.argv.slice(2);
const worker = JSON.parse(fs.readFileSync(`${dir}/worker.json`));
const live = worker.spec.template.spec.containers[0];
assert.match(live.image ?? '', /^asia-south1-docker\.pkg\.dev\/image-links-agent\/apps\/worker[:@]/, 'catalog-worker runs no worker image');
const names = ['GCP_PROJECT', 'DB_HOST', 'DB_NAME', 'DB_USER'];
const env = live.env.filter((e) => names.includes(e.name) && typeof e.value === 'string');
for (const n of names) assert(env.find((e) => e.name === n && e.value), `Missing worker ${n}`);
const password = live.env.find((e) => e.name === 'DB_PASSWORD');
assert.equal(password?.valueFrom?.secretKeyRef?.name, 'catalog-db-password', 'DB_PASSWORD must be the catalog-db-password secret reference');
const qaDefault = live.env.find((e) => e.name === 'CATALOG_QA_DEFAULT_MODEL' && typeof e.value === 'string' && e.value);
env.push(password, ...(qaDefault ? [{ name: qaDefault.name, value: qaDefault.value }] : []), { name: 'DB_POOL_MAX', value: '1' });
const labels = Object.fromEntries(labelText.split(',').map((kv) => kv.split('=')));
const annotations = {
  'run.googleapis.com/execution-environment': 'gen2',
  'run.googleapis.com/network-interfaces': JSON.stringify([{ network: 'ila-vpc', subnetwork: 'ila-subnet' }]),
  'run.googleapis.com/vpc-access-egress': 'private-ranges-only',
};
const task = {
  serviceAccountName: sa, maxRetries: 0, timeoutSeconds: '22200',
  containers: [{ image: live.image, command: ['node'], args: ['dist/catalog-route-switch.js'], resources: { limits: { cpu: '1', memory: '512Mi' } }, env }],
};
const desired = { apiVersion: 'run.googleapis.com/v1', kind: 'Job', metadata: { name, labels },
  spec: { template: { metadata: { annotations }, spec: { taskCount: 1, parallelism: 1, template: { spec: task } } } } };
fs.writeFileSync(`${dir}/job.json`, JSON.stringify(desired));
NODE
  # A successful list tells a missing job apart from an API that cannot be read.
  gcloud run jobs list --region="$REGION" --filter="metadata.name=$JOB" --format=json > "$tmp/existing.json"
  state=$(node --input-type=commonjs - "$tmp/existing.json" "$tmp/job.json" <<'NODE'
const fs = require('node:fs');
const [oldFile, newFile] = process.argv.slice(2), old = JSON.parse(fs.readFileSync(oldFile))[0], desired = JSON.parse(fs.readFileSync(newFile));
// A 0 the API leaves out (maxRetries: 0) counts as the same, so a re-run does not replace an unchanged job.
function contains(a, b) { if (b === 0 && a === undefined) return true; if (Array.isArray(b)) return Array.isArray(a) && a.length === b.length && b.every((v, i) => contains(a[i], v)); if (b && typeof b === 'object') return !!a && Object.entries(b).every(([k, v]) => contains(a[k], v)); return a === b; }
process.stdout.write(!old ? 'missing' : contains(old.spec, desired.spec) && contains(old.metadata?.labels, desired.metadata.labels) ? 'same' : 'differs');
NODE
)
  case "$state" in
    same) skip "Cloud Run job $JOB (image, settings and labels match catalog-worker)"; return ;;
    missing)
      if [ "${1:-}" = existing-only ]; then skip "Cloud Run job $JOB (not set up yet; run bash infra/catalog-route-switch.sh)"; return; fi
      create "Cloud Run job $JOB" ;;
    *) update "Cloud Run job $JOB (to the current catalog-worker image and settings)" ;;
  esac
  gcloud run jobs replace "$tmp/job.json" --region="$REGION" --quiet >/dev/null
}

# --- commands ----------------------------------------------------------------------------------
check_reason() {
  [[ "$1" =~ ^[A-Za-z0-9\ .,:\(\)/#\'_-]{3,200}$ ]] || die "the reason must be 3 to 200 characters of letters, digits, spaces and . , : ( ) / # ' _ -"
}
check_route_id() {
  [[ "$1" =~ ^($CAPABILITIES):[a-z-]+:[A-Za-z0-9._/:-]+$ ]] || die "supply a route id like judge.render:openrouter:<model> (bash infra/catalog-route-switch.sh show lists them)"
}
actor() {
  local who=${ROUTE_ACTOR:-}
  [ -n "$who" ] || who=$(gcv config get-value account 2>/dev/null || true)
  [[ "$who" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$ ]] || die "no active gcloud account to record as who asked; log in, or set ROUTE_ACTOR=<email>"
  printf '%s' "$who"
}
# start <KEY=VALUE>...: start one execution with these env values (for this execution only) and print its name. "~"
# separates the values (gcloud topic escaping), so a reason may hold commas. MSYS2_ARG_CONV_EXCL keeps Git Bash from
# rewriting route ids such as "judge.render:openrouter:google/..." as Windows paths. Never retried: a retry could start
# a second execution. A failed start, or one that names no execution, stops here.
EXECUTION=
start() {
  local env tmp status=0
  env=$(IFS='~'; printf '%s' "$*")
  job_exists || die "$JOB does not exist yet; run bash infra/catalog-route-switch.sh first"
  tmp=$(mktemp -d); TMP_DIRS+=("$tmp")
  EXECUTION=$(MSYS2_ARG_CONV_EXCL='--update-env-vars=' gcloud run jobs execute "$JOB" --region="$REGION" --async \
    --update-env-vars="^~^$env" --format='value(metadata.name)' 2>"$tmp/err") || status=$?
  EXECUTION=${EXECUTION//$'\r'/}; EXECUTION=${EXECUTION//$'\n'/}
  if [ "$status" != 0 ]; then
    cat "$tmp/err" >&2
    die "could not start $JOB (exit $status); nothing was changed by this command. Check: gcloud run jobs executions list --job=$JOB --region=$REGION"
  fi
  [[ "$EXECUTION" =~ ^[a-z0-9-]+$ ]] \
    || die "gcloud started $JOB but named no execution ('$EXECUTION'); find it with: gcloud run jobs executions list --job=$JOB --region=$REGION"
}
# finish: wait for the execution's end state on GCP, print its log; fails when the execution failed or is unknown.
finish() {
  local json state status
  log "execution $EXECUTION started; reading its state every $GCLOUD_POLL_S s"
  while :; do
    status=0
    json=$(gcloud_retry gcloud run jobs executions describe "$EXECUTION" --region="$REGION" --format=json) || status=$?
    [ "$status" = 0 ] || die "cannot read execution $EXECUTION: gcloud run jobs executions describe $EXECUTION --region=$REGION"
    state=$(printf '%s' "$json" | gcloud_job_state)
    [ "$state" = running ] || break
    sleep "$GCLOUD_POLL_S"
  done
  gcloud_job_logs "$JOB" "$EXECUTION" "$REGION"
  [ "$state" = succeeded ] || die "execution $EXECUTION: $state (the job log above says why)"
  log "execution $EXECUTION succeeded"
}

show() {
  local capability=${1:-}
  [ -z "$capability" ] || [[ "$capability" =~ ^($CAPABILITIES)$ ]] || die "unknown capability $capability"
  log "EXECUTE $JOB show ${capability:-(all capabilities)}"
  start ROUTE_COMMAND=show "ROUTE_CAPABILITY=$capability"
  finish
}

set_route() {
  local id=${1:-} state=${2:-} reason=${3:-} flag=${4:-} force=0 who
  check_route_id "$id"
  [[ "$state" =~ ^(off|serving)$ ]] || die "the state is off or serving"
  check_reason "$reason"
  case "$flag" in "") ;; --force) force=1 ;; *) usage ;; esac
  [ "$#" -le 4 ] || usage
  who=$(actor)
  log "EXECUTE $JOB set $id to $state (by $who: $reason)$([ "$force" = 1 ] && echo ', forced')"
  start ROUTE_COMMAND=set "ROUTE_ID=$id" "ROUTE_STATE=$state" "ROUTE_REASON=$reason" "ROUTE_ACTOR=$who" "ROUTE_FORCE=$force"
  finish
}

drill() {
  local capability=${1:-} minutes=${2:-} reason=${3:-} batch="" route="" arg who
  [ "$#" -ge 3 ] || usage
  shift 3
  for arg in "$@"; do
    case "$arg" in
      --route=*) route=${arg#--route=}; check_route_id "$route"; [[ "$route" == "$capability":* ]] || die "the route $route is not a $capability route" ;;
      *) [ -z "$batch" ] || usage; batch=$arg ;;
    esac
  done
  [[ "$capability" =~ ^($CAPABILITIES)$ ]] || die "supply a capability ($CAPABILITIES)"
  [[ "$minutes" =~ ^[1-9][0-9]*$ ]] && [ "$minutes" -le 360 ] || die "the drill lasts 1 to 360 minutes"
  check_reason "$reason"
  [ -z "$batch" ] || [[ "$batch" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || die "the batch id is a UUID"
  who=$(actor)
  log "EXECUTE $JOB drill: ${route:-the route $capability asks first${batch:+ for batch $batch}} off for at most $minutes minutes${batch:+, or until batch $batch finishes} (by $who: $reason)"
  start ROUTE_COMMAND=drill "DRILL_CAPABILITY=$capability" "DRILL_MINUTES=$minutes" "DRILL_BATCH=$batch" "DRILL_ROUTE=$route" "ROUTE_REASON=$reason" "ROUTE_ACTOR=$who"
  log "drill running as execution $EXECUTION; its first log lines name the route turned off and the route serving instead."
  log "The route comes back on its own at the expiry even if the job is stopped."
  log "follow it: gcloud logging read 'resource.type=\"cloud_run_job\" AND resource.labels.job_name=\"$JOB\" AND labels.\"run.googleapis.com/execution_name\"=\"$EXECUTION\"' --order=asc --format='value(textPayload)'"
  log "end it early: gcloud run jobs executions cancel $EXECUTION --region=$REGION (the job restores the route when stopped)"
}

case "${1:-setup}" in
  setup) command -v node >/dev/null || die "node is required"; ensure_job ;;
  job) ensure_job existing-only ;;
  show) shift; [ "$#" -le 1 ] || usage; show "$@" ;;
  set) shift; set_route "$@" ;;
  drill) shift; drill "$@" ;;
  *) usage ;;
esac
