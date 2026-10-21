#!/usr/bin/env bash
# Email alerts, log-based metrics and the "Catalog ops" dashboard for the catalog services.
# Check-then-create and re-runnable: every object is looked up first and printed as SKIP when it
# already matches its file, UPDATE when it exists but differs, CREATE when it is missing. Never
# deletes anything and never touches objects it did not create (it matches only the names and
# display names below). Called at the end of infra/deploy.sh and runnable alone.
#
# What it makes (definitions live in infra/monitoring/):
#   APIs           monitoring.googleapis.com, clouderrorreporting.googleapis.com (enabled if off)
#   email channel  catalog-email-tech -> ALERT_EMAIL (default sujan@opptra.com)
#   log metrics    catalog/<file name> for each infra/monitoring/metrics/*.json. They match Cloud
#                  Run services only (resource.type cloud_run_revision), not Cloud Run jobs, on
#                  purpose: the eval, smoke, load and QA-check jobs fail on purpose in tests and
#                  must never send an alert email.
#   alert policies one per infra/monitoring/policies/*.json, matched by displayName; the
#                  placeholder __CATALOG_EMAIL_CHANNEL__ is replaced with the channel at run time
#   dashboard      "Catalog ops" from infra/monitoring/dashboard.json
#
# gcloud tracks: notification channels exist only as "gcloud beta monitoring channels" (there is no
# GA group), so this script needs the beta component. Policies, dashboards and log metrics are GA.
#
# Usage (Git Bash, from the repo root): bash infra/monitoring.sh
# Env: ALERT_EMAIL=someone@opptra.com bash infra/monitoring.sh
set -euo pipefail

PROJECT=image-links-agent
# The operator's default gcloud project is a different one; pin this project for every gcloud call
# in this script without touching global gcloud config.
export CLOUDSDK_CORE_PROJECT=$PROJECT
cd "$(dirname "$0")/.."

ALERT_EMAIL=${ALERT_EMAIL:-sujan@opptra.com}
CHANNEL_DISPLAY_NAME=catalog-email-tech
CHANNEL_PLACEHOLDER=__CATALOG_EMAIL_CHANNEL__
DIR=infra/monitoring
APIS=(monitoring.googleapis.com clouderrorreporting.googleapis.com)

log()    { printf '[monitoring] %s\n' "$*"; }
skip()   { printf '[monitoring] SKIP   %s\n' "$*"; }
create() { printf '[monitoring] CREATE %s\n' "$*"; }
update() { printf '[monitoring] UPDATE %s\n' "$*"; }
warn()   { printf '[monitoring] WARN   %s\n' "$*" >&2; }
die()    { printf '[monitoring] ERROR  %s\n' "$*" >&2; exit 1; }

[[ "$ALERT_EMAIL" =~ ^[^[:space:],@]+@[^[:space:],@]+$ ]] || die "ALERT_EMAIL must be one email address"

# gcloud on Windows emits CRLF; strip CR from anything we parse.
gcv() { gcloud "$@" | tr -d '\r'; }
# gcloud on Windows is a Python program and needs C:/... paths for --*-from-file.
native_path() { cygpath -m "$1" 2>/dev/null || printf '%s\n' "$1"; }

# Retry a command a few times (a log-based metric can take a moment before a policy may use it).
retry() {
  local n=0 max=5
  until "$@"; do
    n=$((n + 1))
    if [ "$n" -ge "$max" ]; then return 1; fi
    log "retry $n/$max in $((n * 5))s: $*"
    sleep $((n * 5))
  done
}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Print the "name" of every item in the JSON list on stdin whose field $1 equals $2.
json_names() {
  node -e '
    const raw = require("fs").readFileSync(0, "utf8").trim();
    const [key, value] = process.argv.slice(1);
    for (const item of JSON.parse(raw || "[]")) if (item[key] === value) console.log(item.name);
  ' "$1" "$2"
}

# Print field $2 of the item named $1 in the JSON list on stdin.
json_field() {
  node -e '
    const raw = require("fs").readFileSync(0, "utf8").trim();
    const [name, key] = process.argv.slice(1);
    const item = JSON.parse(raw || "[]").find((i) => i.name === name);
    console.log(key.split(".").reduce((v, k) => v?.[k], item) ?? "");
  ' "$1" "$2"
}

# Exit 0 when the item named $1 in the JSON list on stdin already holds everything in the desired
# file $2. Fields the server adds are ignored, a field the server leaves out counts as its zero value
# (proto3 JSON drops 0, "", false, "0s" and empty lists), and notification channels compare by id.
json_matches() {
  node -e '
    const fs = require("fs");
    const raw = fs.readFileSync(0, "utf8").trim();
    const [name, file] = process.argv.slice(1);
    const cur = JSON.parse(raw || "[]").find((i) => i.name === name);
    const want = JSON.parse(fs.readFileSync(file, "utf8"));
    const isZero = (v) => v === 0 || v === "" || v === false || v === "0s" ||
      (Array.isArray(v) && v.length === 0) || (v && typeof v === "object" && Object.keys(v).length === 0);
    const id = (s) => String(s).split("/").pop();
    function contains(a, b, key) {
      if (a === undefined) return isZero(b);
      if (key === "notificationChannels") return Array.isArray(a) && a.length === b.length && b.every((v, i) => id(a[i]) === id(v));
      if (Array.isArray(b)) return Array.isArray(a) && a.length === b.length && b.every((v, i) => contains(a[i], v));
      if (b && typeof b === "object") return !!a && typeof a === "object" && Object.entries(b).every(([k, v]) => contains(a[k], v, k));
      return a === b || String(a) === String(b);
    }
    process.exit(cur && contains(cur, want) ? 0 : 1);
  ' "$1" "$(native_path "$2")"
}

# Copy $1 to $2 with the channel placeholder replaced and, when $3 is set, the dashboard etag added.
render() {
  node -e '
    const fs = require("fs");
    const [src, dst, channel, etag] = process.argv.slice(1);
    const obj = JSON.parse(fs.readFileSync(src, "utf8").split(process.argv[5]).join(channel));
    if (etag) obj.etag = etag;
    fs.writeFileSync(dst, JSON.stringify(obj, null, 2));
  ' "$(native_path "$1")" "$(native_path "$2")" "${CHANNEL:-}" "${3:-}" "$CHANNEL_PLACEHOLDER"
}

# --- 0. Preflight -----------------------------------------------------------------------------
# Read only: the channel commands need the beta component. This script never installs anything.
BETA_STATE=$(gcv components list --filter=id=beta --format='value(state.name)')
[ "$BETA_STATE" = Installed ] || die "the gcloud beta component is missing; run: gcloud components install beta"

# --- 1. APIs ----------------------------------------------------------------------------------
ENABLED=$(gcv services list --enabled --format='value(config.name)')
for api in "${APIS[@]}"; do
  if grep -qxF "$api" <<<"$ENABLED"; then
    skip "api $api (enabled)"
  else
    create "api $api"
    gcloud services enable "$api"
  fi
done

# --- 2. Email channel -------------------------------------------------------------------------
CHANNELS=$(gcv beta monitoring channels list --format=json)
mapfile -t FOUND < <(node -e '
  const raw = require("fs").readFileSync(0, "utf8").trim();
  for (const c of JSON.parse(raw || "[]")) if (c.displayName === process.argv[1] && c.type === "email") console.log(c.name);
' "$CHANNEL_DISPLAY_NAME" <<<"$CHANNELS")
if [ "${#FOUND[@]}" -gt 1 ]; then
  warn "${#FOUND[@]} email channels are named $CHANNEL_DISPLAY_NAME; using the first, ${FOUND[0]}"
fi
if [ "${#FOUND[@]}" -ge 1 ]; then
  CHANNEL=${FOUND[0]}
  CURRENT_EMAIL=$(json_field "$CHANNEL" labels.email_address <<<"$CHANNELS")
  if [ "$CURRENT_EMAIL" = "$ALERT_EMAIL" ]; then
    skip "email channel $CHANNEL_DISPLAY_NAME -> $ALERT_EMAIL"
  else
    update "email channel $CHANNEL_DISPLAY_NAME -> $ALERT_EMAIL (was $CURRENT_EMAIL)"
    gcloud beta monitoring channels update "$CHANNEL" --update-channel-labels="email_address=$ALERT_EMAIL" >/dev/null
  fi
else
  create "email channel $CHANNEL_DISPLAY_NAME -> $ALERT_EMAIL"
  CHANNEL=$(gcv beta monitoring channels create --display-name="$CHANNEL_DISPLAY_NAME" --type=email \
    --description="Catalog alert emails (infra/monitoring.sh)" --user-labels=app=catalog \
    --channel-labels="email_address=$ALERT_EMAIL" --format='value(name)')
fi
[[ "$CHANNEL" == projects/*/notificationChannels/* ]] || die "could not read the email channel name (got '$CHANNEL')"

# --- 3. Log-based metrics ---------------------------------------------------------------------
METRICS=$(gcv logging metrics list --format=json)
for file in "$DIR"/metrics/*.json; do
  name="catalog/$(basename "$file" .json)"
  if [ -n "$(json_names name "$name" <<<"$METRICS")" ]; then
    if json_matches "$name" "$file" <<<"$METRICS"; then
      skip "log metric $name"
    else
      update "log metric $name"
      gcloud logging metrics update "$name" --config-from-file="$(native_path "$file")" >/dev/null
    fi
  else
    create "log metric $name"
    gcloud logging metrics create "$name" --config-from-file="$(native_path "$file")" >/dev/null
  fi
done

# --- 4. Alert policies ------------------------------------------------------------------------
# One create attempt. Before every attempt it lists the policies again and stops if one with this
# display name exists now, so a create that failed after the server stored the policy (a timeout,
# a dropped connection) is never repeated into a duplicate.
CREATE_ATTEMPTED=""
create_policy() {
  if [ "$CREATE_ATTEMPTED" = "$1" ]; then
    local now
    now=$(gcv monitoring policies list --format=json) || return 1
    if [ -n "$(json_names displayName "$1" <<<"$now")" ]; then
      log "policy \"$1\" exists after the failed attempt; not creating it again"
      return 0
    fi
  fi
  CREATE_ATTEMPTED=$1
  gcloud monitoring policies create --policy-from-file="$(native_path "$2")" >/dev/null
}
POLICIES=$(gcv monitoring policies list --format=json)
for file in "$DIR"/policies/*.json; do
  rendered="$TMP/$(basename "$file")"
  render "$file" "$rendered"
  title=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).displayName)' "$(native_path "$rendered")" | tr -d '\r')
  mapfile -t FOUND < <(json_names displayName "$title" <<<"$POLICIES")
  if [ "${#FOUND[@]}" -gt 1 ]; then
    warn "policy \"$title\": ${#FOUND[@]} policies have this name; left as they are, remove the extra one in the console"
  elif [ "${#FOUND[@]}" = 1 ]; then
    if json_matches "${FOUND[0]}" "$rendered" <<<"$POLICIES"; then
      skip "policy \"$title\""
    else
      update "policy \"$title\""
      gcloud monitoring policies update "${FOUND[0]}" --policy-from-file="$(native_path "$rendered")" >/dev/null
    fi
  else
    create "policy \"$title\""
    retry create_policy "$title" "$rendered"
  fi
done

# --- 5. Dashboard -----------------------------------------------------------------------------
DASHBOARDS=$(gcv monitoring dashboards list --format=json)
title=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).displayName)' "$(native_path "$DIR/dashboard.json")" | tr -d '\r')
mapfile -t FOUND < <(json_names displayName "$title" <<<"$DASHBOARDS")
if [ "${#FOUND[@]}" -gt 1 ]; then
  warn "dashboard \"$title\": ${#FOUND[@]} dashboards have this name; left as they are"
elif [ "${#FOUND[@]}" = 1 ]; then
  if json_matches "${FOUND[0]}" "$DIR/dashboard.json" <<<"$DASHBOARDS"; then
    skip "dashboard \"$title\""
  else
    update "dashboard \"$title\""
    render "$DIR/dashboard.json" "$TMP/dashboard.json" "$(json_field "${FOUND[0]}" etag <<<"$DASHBOARDS")"
    gcloud monitoring dashboards update "${FOUND[0]}" --config-from-file="$(native_path "$TMP/dashboard.json")" >/dev/null
  fi
else
  create "dashboard \"$title\""
  gcloud monitoring dashboards create --config-from-file="$(native_path "$DIR/dashboard.json")" >/dev/null
fi

log "done: alerts email $ALERT_EMAIL through channel $CHANNEL_DISPLAY_NAME"
