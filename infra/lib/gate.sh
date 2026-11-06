# Spec 17 3.2.2: deploy_service <name>, the one deploy gate for every Cloud Run service in the registry
# (infra/lib/services.sh). Sourced by infra/deploy.sh after services.sh.
#
#   1. gcloud run deploy <name> ... --no-traffic --tag candidate (a new service cannot take --no-traffic; its first
#      revision serves at once, there is nothing older to protect). SVC_TAG overrides the tag (the preview GPU uses
#      a per-commit tag, so a later deploy never moves the URL the preview worker calls).
#   2. The candidate's own URL: status.traffic[].url where tag=candidate.
#   3. The service's probe against that URL under a hard timeout. Non-zero exit or timeout = failure.
#   4. Pass (unless the registry says SVC_SHIFT=0): tag the outgoing revision "previous" (what --rollback returns
#      to), move all traffic to exactly the probed revision (--to-revisions, never --to-latest, so a revision created
#      meanwhile can never take traffic unprobed), drop a stale candidate tag, print "==> <name>: live (<revision>)".
#   5. Fail: traffic stays where it was; print the probe output, the rollback line, return non-zero.
# SKIP when the live revision already runs the same image digest with the same env, unless GATE_FORCE=1 (an operator
# override; deploy.sh re-runs the worker's smoke after a matting change through the worker's env). The env carries DEPLOY_ARGS_SHA,
# a hash of every other deploy flag, so a flag-only change (concurrency, CPU) is not skipped.
# Spec 18 measure rungs (tag measure-*, UPSCALE_MEASURE=1): rung 1 of a brand-new catalog-upscale serves the service
# URL, because Cloud Run cannot create a service with --no-traffic. A live revision that carries a measure-* tag is
# therefore never a SKIP match (the first real deploy of that shape still runs its own probe), never tagged "previous"
# when traffic moves on, and never the default target of --rollback (name it to return to it).
#
# Service-level max instances (run.googleapis.com/maxScale on the service, gcloud --max): Cloud Run caps a service at
# the lower of it and the revision's --max-instances, and gcloud run deploy --max-instances sets only the revision.
# Whenever this gate leaves a revision serving (after a traffic shift, or on SKIP), it sets the service-level max to
# SVC_MAX when it differs (gcloud run services update --max: no new revision, traffic unchanged). A candidate that
# does not take traffic (SVC_SHIFT=0: measure rungs, the preview GPU) and a reused service never change it.
#
# M6-F2-R7 (M6-S5): steps 1 and 2 are gate_prepare, step 3 gate_probe, step 4 gate_promote; gate_group runs them for
# several services with the candidates and the probes at once (below). A service whose image digest, env and flags
# match its live revision is SKIP and never probed.
# After a call: GATE_URL (the service URL), GATE_TAG_URL (the candidate URL, or the service URL on SKIP or when
# reused), GATE_REVISION (the revision the gate deployed or found live), GATE_PREVIOUS (the revision that served
# before), GATE_CHANGED (1 when a new revision was deployed), GATE_NEEDS_SHIFT (1 when a probed candidate takes traffic).
# Return codes: 0 passed, SKIP or reused; 1 failed; 75 quota refused on first creation of a SVC_QUOTA_OPTIONAL
# service (the caller warns and continues without it).
#
# Every gcloud call goes through gate_gcloud. Tests define their own gate_gcloud before sourcing this file, so no
# test reaches gcloud.

# shellcheck source=labels.sh
source "$(dirname "${BASH_SOURCE[0]}")/labels.sh"
# shellcheck source=gcloud-retry.sh
source "$(dirname "${BASH_SOURCE[0]}")/gcloud-retry.sh"

CANDIDATE_TAG=candidate
PREVIOUS_TAG=previous
declare -F gate_gcloud >/dev/null || gate_gcloud() { gcloud "$@"; }

# Plain node reading JSON from stdin; argv[1] is a JS expression of `j` (the parsed input) and `a` (extra args).
gate_json() {
  local expr=$1; shift
  node -e '
    const j = JSON.parse(require("fs").readFileSync(0, "utf8").trim() || "null");
    const a = process.argv.slice(2);
    const v = (0, eval)("(j, a) => (" + process.argv[1] + ")")(j, a);
    console.log(v ?? "");
  ' "$expr" "$@"
}

# The revision serving the most traffic (the one a rollback returns to), from a service description.
gate_previous_revision() {
  gate_json '(j?.status?.traffic ?? []).filter((t) => t.percent > 0).sort((x, y) => y.percent - x.percent)[0]?.revisionName'
}

# gate_measure_tagged <revision> < service description: 0 when that revision carries a measure-* tag (a spec 18 ladder
# rung, deployed only to be measured).
gate_measure_tagged() {
  [ -n "$1" ] || return 1
  [ "$(gate_json '(j?.status?.traffic ?? []).some((t) => t.revisionName === a[0] && String(t.tag ?? "").startsWith("measure-")) ? 1 : 0' "$1")" = 1 ]
}

# The exact rollback line the spec names, plus where to run it.
gate_rollback_line() {
  local name=$1 previous=$2 region=$3
  if [ -z "$previous" ]; then
    echo "$name had no revision serving traffic before this deploy; nothing to roll back to." >&2
    return
  fi
  echo "gcloud run services update-traffic $name --to-revisions $previous=100" >&2
  echo "(region $region: add --region=$region if gcloud asks for one)" >&2
}

# Inside deploy_service: the error for this service plus its rollback line. The caller still returns 1 itself.
gate_fail() {
  echo "ERROR: $SVC_NAME: $1" >&2
  gate_rollback_line "$SVC_NAME" "$GATE_PREVIOUS" "$SVC_REGION"
}

# gate_service_max [service description]: set the service-level max instances to SVC_MAX when it differs (see the
# header). Without a description it updates unconditionally (the update is idempotent). Nothing when SVC_MAX is unset.
gate_service_max() {
  [ -n "${SVC_MAX:-}" ] || return 0
  local live=""
  [ -n "${1:-}" ] && live=$(gate_json 'j?.metadata?.annotations?.["run.googleapis.com/maxScale"]' <<<"$1")
  [ "$live" = "$SVC_MAX" ] && return 0
  echo "==> $SVC_NAME: service max instances ${live:-unset} -> $SVC_MAX (no new revision, traffic unchanged)"
  gate_gcloud run services update "$SVC_NAME" --region="$SVC_REGION" --max="$SVC_MAX" --quiet >/dev/null && return 0
  echo "ERROR: $SVC_NAME: could not set the service max instances to $SVC_MAX (now ${live:-unknown}); this step changed no revision or traffic." >&2
  echo "Set it by hand: gcloud run services update $SVC_NAME --region=$SVC_REGION --max=$SVC_MAX" >&2
  return 1
}

# The flags deploy_service passes to gcloud run deploy, one per line (also used by the tests).
gate_deploy_args() {
  local exists=$1 fingerprint=$2
  printf '%s\n' run deploy "$SVC_NAME" --quiet --image="$SVC_IMAGE" --region="$SVC_REGION" "${SVC_ARGS[@]}" \
    --set-env-vars="$SVC_ENV,DEPLOY_ARGS_SHA=$fingerprint"
  # --no-allow-unauthenticated re-sets service IAM on every deploy; pass it only when creating the service and
  # --invoker-iam-check afterwards (docs/solutions/deploy-cloud-run.md). --no-traffic needs an existing service.
  if [ "$exists" = 1 ]; then printf '%s\n' --invoker-iam-check --no-traffic; else printf '%s\n' --no-allow-unauthenticated; fi
  printf '%s\n' --tag "${SVC_TAG:-$CANDIDATE_TAG}"
}

# gcloud ... --format=json with stderr kept apart, so a warning or update notice never lands in the parsed JSON.
# Prints the JSON (without CR) on success; on failure passes gcloud's stderr on and returns its status. A read, so a
# network blip is retried (gcloud_retry); NOT_FOUND and every other API answer are not.
gate_describe() {
  local err out status=0
  err=$(mktemp)
  out=$(gcloud_retry gate_gcloud "$@" --format=json 2>"$err") || status=$?
  if [ "$status" = 0 ]; then tr -d '\r' <<<"$out"; else cat "$err" >&2; fi
  rm -f "$err"
  return "$status"
}

# A short hash of every deploy flag except the image (compared by digest) and the env (compared directly).
gate_fingerprint() {
  printf '%s\n' "$SVC_NAME" "$SVC_REGION" "${SVC_ARGS[@]}" | sha256sum | cut -c1-16
}

# 0 when the live revision has the image digest of SVC_IMAGE and exactly the desired plain env values.
gate_matches_live() {
  local revision=$1 env=$2 digest revision_json
  digest=$(gcloud_retry gate_gcloud artifacts docker images describe "$SVC_IMAGE" --format='value(image_summary.digest)' 2>/dev/null | tr -d '\r') || return 1
  [ -n "$digest" ] || return 1
  revision_json=$(gcloud_retry gate_gcloud run revisions describe "$revision" --region="$SVC_REGION" --format=json | tr -d '\r') || return 1
  node -e '
    const r = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const [digest, env] = process.argv.slice(1);
    const live = (r?.spec?.containers?.[0]?.env ?? []).filter((e) => e.value !== undefined).map((e) => `${e.name}=${e.value}`).sort();
    const want = env.split(",").filter(Boolean).sort();
    const sameEnv = live.length === want.length && live.every((e, i) => e === want[i]);
    process.exit(String(r?.status?.imageDigest ?? "").endsWith("@" + digest) && sameEnv ? 0 : 1);
  ' "$digest" "$env" <<<"$revision_json"
}

# deploy_service <name>: the whole gate for one service: gate_prepare (SKIP, reuse or the no-traffic candidate), then
# gate_probe on the candidate's tag URL, then gate_promote (the traffic shift). M6-F2-R7 (M6-S5): gate_group runs the
# same three steps for several services, the first two at once.
deploy_service() {
  gate_prepare "$1" || return $?
  [ "$GATE_PROBE_NEEDED" = 1 ] || return 0
  gate_probe || return $?
  gate_promote
}

# gate_prepare <name>: calls the registry function, then SKIP, reuse or the candidate deploy (steps 1 and 2 of the header).
# Sets GATE_PROBE_NEEDED=1 only when a candidate was deployed and still needs its probe.
gate_prepare() {
  local name=$1 fn exists=0 service_json previous fingerprint env deploy_out tag describe_err
  local -a args
  fn=service_${name//-/_}
  declare -F "$fn" >/dev/null || { echo "ERROR: $name is not in the service registry (infra/lib/services.sh)" >&2; return 1; }
  SVC_TAG=""; SVC_MAX=""
  "$fn"
  GATE_URL=""; GATE_TAG_URL=""; GATE_REVISION=""; GATE_PREVIOUS=""; GATE_CHANGED=0
  GATE_PROBE_NEEDED=0; GATE_NEEDS_SHIFT=0; GATE_NEEDS_MAX=0; GATE_PREVIOUS_MEASURE=0
  tag=${SVC_TAG:-$CANDIDATE_TAG}
  if [ "$SVC_DEPLOY" = skip ]; then
    echo "==> $SVC_NAME: not deployed (${SVC_SKIP_REASON:-not used by this deploy})"
    return 0
  fi
  # M6-F1 (M6-S1): no service is deployed without app, component and env labels (the cost ledger and the billing
  # export group by them).
  if [ "$SVC_DEPLOY" = 1 ] && ! catalog_labels_check "$SVC_NAME" "$(catalog_labels_in_args "${SVC_ARGS[@]}")"; then return 1; fi

  # Only "not found" means a new service; any other describe failure stops here, so a passing gcloud hiccup never
  # turns into a deploy without --no-traffic.
  describe_err=$(mktemp)
  if service_json=$(gate_describe run services describe "$SVC_NAME" --region="$SVC_REGION" 2>"$describe_err"); then
    exists=1
  elif ! grep -qiE 'NOT_FOUND|could not be found|cannot find' "$describe_err"; then
    cat "$describe_err" >&2; rm -f "$describe_err"
    echo "ERROR: $SVC_NAME: cannot read the service; nothing was changed" >&2
    return 1
  fi
  rm -f "$describe_err"
  previous=""; [ "$exists" = 1 ] && previous=$(gate_previous_revision <<<"$service_json")
  GATE_PREVIOUS=$previous

  if [ "$SVC_DEPLOY" != 1 ]; then
    [ "$exists" = 1 ] && GATE_URL=$(gate_json 'j?.status?.url' <<<"$service_json")
    [ -n "$GATE_URL" ] || { echo "ERROR: $SVC_NAME is reused as it is but does not exist yet; deploy it from main first (bash infra/deploy.sh)" >&2; return 1; }
    GATE_TAG_URL=$GATE_URL; GATE_REVISION=$previous
    echo "==> $SVC_NAME: reused as it is ($previous)"
    return 0
  fi

  fingerprint=$(gate_fingerprint)
  env="$SVC_ENV,DEPLOY_ARGS_SHA=$fingerprint"
  if gate_measure_tagged "$previous" <<<"$service_json"; then
    GATE_PREVIOUS_MEASURE=1
    echo "==> $SVC_NAME: the live revision $previous is a measure rung; deploying and probing, never SKIP"
  fi
  if [ -n "$previous" ] && [ "$GATE_PREVIOUS_MEASURE" = 0 ] && [ "${GATE_FORCE:-0}" != 1 ] && gate_matches_live "$previous" "$env"; then
    GATE_URL=$(gate_json 'j?.status?.url' <<<"$service_json")
    GATE_TAG_URL=$GATE_URL; GATE_REVISION=$previous
    echo "==> $SVC_NAME: SKIP (live revision $previous already runs this image and env)"
    # A no-shift candidate (the preview GPU) that finds the live revision unchanged never sets the live service max.
    # In a group (GATE_DEFER_MAX=1) the max waits for gate_promote, which runs only when every probe of the group
    # passed (2026-11-05 review P2-1).
    if [ "$SVC_SHIFT" = 1 ]; then
      if [ "${GATE_DEFER_MAX:-0}" = 1 ]; then GATE_NEEDS_MAX=1; else gate_service_max "$service_json" || return 1; fi
    fi
    return 0
  fi

  echo "==> $SVC_NAME: deploy candidate${previous:+ (live: $previous)}"
  mapfile -t args < <(gate_deploy_args "$exists" "$fingerprint")
  # Git Bash would rewrite an env value starting with "/" (the web's IAP_AUDIENCE) into a Windows path; excluding
  # only this flag keeps the conversion the gcloud launcher needs (docs/solutions/catalog-iap.md).
  if ! deploy_out=$(MSYS2_ARG_CONV_EXCL='--set-env-vars=' gate_gcloud "${args[@]}" 2>&1); then
    printf '%s\n' "$deploy_out" >&2
    if [ "$exists" = 0 ] && [ "$SVC_QUOTA_OPTIONAL" = 1 ] && grep -qiE 'quota|RESOURCE_EXHAUSTED' <<<"$deploy_out"; then
      echo "WARN: $SVC_NAME: quota refused the first deploy; continuing without it" >&2
      return 75
    fi
    gate_fail "the candidate deploy failed; traffic was not changed"
    return 1
  fi

  GATE_CHANGED=1
  service_json=$(gate_describe run services describe "$SVC_NAME" --region="$SVC_REGION") || {
    gate_fail "cannot read the service after the candidate deploy; traffic was not changed"
    return 1
  }
  GATE_URL=$(gate_json 'j?.status?.url' <<<"$service_json")
  if [ -z "$GATE_URL" ]; then gate_fail "the service has no URL after the candidate deploy; traffic was not changed"; return 1; fi
  GATE_TAG_URL=$(gate_json '(j?.status?.traffic ?? []).find((t) => t.tag === a[0])?.url' "$tag" <<<"$service_json")
  GATE_REVISION=$(gate_json '(j?.status?.traffic ?? []).find((t) => t.tag === a[0])?.revisionName' "$tag" <<<"$service_json")
  if [ -z "$GATE_TAG_URL" ] || [ -z "$GATE_REVISION" ]; then
    gate_fail "no traffic entry tagged $tag after the deploy"
    return 1
  fi
  GATE_PROBE_NEEDED=1
}

# gate_probe: step 3, the probe of the candidate gate_prepare deployed (SVC_* and GATE_* as it left them). On a pass
# sets GATE_NEEDS_SHIFT=1 when the registry moves traffic (SVC_SHIFT=1).
# gate_probe_lines: prints the probe's output as it comes. A probe that used its allowance of unexplained 502s
# (Unexplained502s in services/matting/tests/cloudrun_check.py) also goes on DEPLOY_NOTES_FILE for the deploy report,
# because the deploy can pass after it and nobody reads the job log of a passing gate.
gate_probe_lines() {
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    printf '    probe | %s\n' "$line"
    case "$line" in
      "unexplained 502s: "[1-9]*) if [ -n "${DEPLOY_NOTES_FILE:-}" ]; then printf '%s: %s\n' "$SVC_NAME" "$line" >> "$DEPLOY_NOTES_FILE"; fi ;;
    esac
  done
}

gate_probe() {
  local status started
  echo "==> $SVC_NAME: probe $GATE_REVISION at $GATE_TAG_URL (at most ${SVC_PROBE_TIMEOUT} s)"
  started=$SECONDS
  status=0
  # The probe's output streams as it runs (the worker's smoke takes minutes) and stays above the verdict.
  # pipefail (restored on return by `local -`) so the probe's exit status, not gate_probe_lines', decides.
  local -; set -o pipefail
  # GATE_SERVICE names the service to the probe (the matting probes run as their own job, catalog-check-<service>,
  # so probes that run at once never share a job). On the timeout every process of the probe gets TERM; timeout
  # returns 124 as soon as its direct child (bash services.sh) exits, while the nested check-matting.sh runs its TERM
  # trap and cancels its job execution (gcloud_job_run) on its own, gate_probe_lines keeping the pipe open until it is done. KILL
  # (60 s later) reaches only a probe that is still the direct child.
  GATE_SERVICE="$SVC_NAME" timeout --kill-after=60 "$SVC_PROBE_TIMEOUT" "${SVC_PROBE[@]}" "$GATE_TAG_URL" 2>&1 | gate_probe_lines || status=${PIPESTATUS[0]}
  if [ "$status" != 0 ]; then
    if [ "$status" = 124 ] || [ "$status" = 137 ]; then
      echo "ERROR: $SVC_NAME: probe of $GATE_REVISION timed out after ${SVC_PROBE_TIMEOUT} s; traffic was not changed" >&2
    else
      echo "ERROR: $SVC_NAME: probe of $GATE_REVISION failed (exit $status) after $((SECONDS - started)) s; traffic was not changed" >&2
    fi
    gate_rollback_line "$SVC_NAME" "$GATE_PREVIOUS" "$SVC_REGION"
    return 1
  fi
  echo "==> $SVC_NAME: probe passed after $((SECONDS - started)) s"
  if [ "$SVC_SHIFT" != 1 ]; then
    echo "==> $SVC_NAME: candidate ($GATE_REVISION) passed; traffic not shifted"
    return 0
  fi
  GATE_NEEDS_SHIFT=1
}

# gate_promote: step 4, the traffic shift to exactly the probed revision. Nothing when gate_probe left
# GATE_NEEDS_SHIFT=0 (SKIP, reuse, a no-shift candidate), except the service max a SKIP in a group deferred to here
# (GATE_NEEDS_MAX=1).
gate_promote() {
  local service_json
  if [ "$GATE_NEEDS_SHIFT" != 1 ]; then
    [ "${GATE_NEEDS_MAX:-0}" = 1 ] || return 0
    service_json=$(gate_describe run services describe "$SVC_NAME" --region="$SVC_REGION") || {
      echo "ERROR: $SVC_NAME: cannot read the service to set its max instances; traffic was not changed" >&2
      return 1
    }
    gate_service_max "$service_json" || return 1
    return 0
  fi
  # The revision serving now is what deploy.sh --rollback returns to, never a candidate that failed its probe, and
  # never a measure rung (it served only because the service was new).
  if [ "$GATE_PREVIOUS_MEASURE" = 1 ]; then
    echo "==> $SVC_NAME: $GATE_PREVIOUS is a measure rung; not tagged $PREVIOUS_TAG"
  elif [ -n "$GATE_PREVIOUS" ] && [ "$GATE_PREVIOUS" != "$GATE_REVISION" ]; then
    gate_gcloud run services update-traffic "$SVC_NAME" --region="$SVC_REGION" --update-tags="$PREVIOUS_TAG=$GATE_PREVIOUS" --quiet >/dev/null || {
      gate_fail "could not tag $GATE_PREVIOUS as $PREVIOUS_TAG; traffic was not changed"
      return 1
    }
  fi
  gate_gcloud run services update-traffic "$SVC_NAME" --region="$SVC_REGION" --to-revisions="$GATE_REVISION=100" --quiet >/dev/null || {
    gate_fail "the traffic shift to $GATE_REVISION failed"
    return 1
  }
  echo "==> $SVC_NAME: live ($GATE_REVISION)"
  # The deploy moved the candidate tag to the new revision; one left on any other revision is stale. Traffic has
  # moved already, so a failure here only warns.
  service_json=$(gate_describe run services describe "$SVC_NAME" --region="$SVC_REGION") || service_json=""
  if [ -n "$service_json" ] \
      && [ -n "$(gate_json '(j?.status?.traffic ?? []).find((t) => t.tag === a[0] && t.revisionName !== a[1])?.revisionName' \
        "$CANDIDATE_TAG" "$GATE_REVISION" <<<"$service_json")" ]; then
    gate_gcloud run services update-traffic "$SVC_NAME" --region="$SVC_REGION" --remove-tags="$CANDIDATE_TAG" --quiet >/dev/null \
      || echo "WARN: $SVC_NAME: could not remove the stale $CANDIDATE_TAG tag" >&2
  fi
  gate_service_max "$service_json" || return 1
  return 0
}

# ---- M6-F2-R7 (M6-S5): several services through the gate at once ----
# gate_group <name>...: the same gate as deploy_service for each service, in three rounds:
#   1. gate_prepare of every service at once (SKIP checks and no-traffic candidate deploys), then wait for all, so
#      every candidate is ready before any probe starts (the probe job reads catalog-matting and refuses a service
#      whose newest revision is not ready yet);
#   2. gate_probe of every candidate at once, each under its own timeout;
#   3. only when every service passed (or was SKIP, reused, not deployed, or a soft quota refusal, status 75): the
#      traffic shifts, one at a time in the order given, and the service max instances of each SKIP member (deferred
#      from round 1 with GATE_DEFER_MAX, so a failed group changes no service's shape either).
# One failure in round 1 or 2: no service of the group moves traffic (each keeps its live revision; its candidate stays
# without traffic), every failure is printed with its rollback line, and it returns 1. A shift that fails in round 3
# returns 1 with the services already shifted in GATE_GROUP_SHIFTED. Each service's output is printed in the order
# given once its round ends, never interleaved. Afterwards gate_group_load <name> restores what deploy_service would have
# left: SVC_* (the registry function), GATE_* and GATE_STATUS. Only services that read nothing from each other go in
# one group (PARALLEL_SERVICES in infra/lib/services.sh).
GATE_GROUP_DIR=""
GATE_GROUP_SHIFTED=()

# The GATE_* values of the current service as shell assignments (round 1 and 2 run in subshells).
gate_state() {
  local v
  for v in GATE_URL GATE_TAG_URL GATE_REVISION GATE_PREVIOUS GATE_CHANGED GATE_PROBE_NEEDED GATE_NEEDS_SHIFT GATE_NEEDS_MAX GATE_PREVIOUS_MEASURE GATE_STATUS; do
    printf '%s=%q\n' "$v" "${!v}"
  done
}

gate_group_load() {
  local fn=service_${1//-/_}
  SVC_TAG=""; SVC_MAX=""
  "$fn"
  # shellcheck source=/dev/null
  source "$GATE_GROUP_DIR/$1.state"
}

# gate_group_round <prepare|probe> <name>...: runs that step for every service at once, prints each one's output in
# order, and returns 1 when any failed (75, the soft quota refusal, is not a failure).
gate_group_round() {
  local step=$1 name i status failed=0
  shift
  local -a pids=()
  for name in "$@"; do
    (
      GATE_STATUS=0
      if [ "$step" = prepare ]; then
        GATE_DEFER_MAX=1 gate_prepare "$name" || GATE_STATUS=$?
      else
        gate_group_load "$name"
        if [ "$GATE_PROBE_NEEDED" = 1 ]; then gate_probe || GATE_STATUS=$?; fi
      fi
      gate_state > "$GATE_GROUP_DIR/$name.state.new"
      mv "$GATE_GROUP_DIR/$name.state.new" "$GATE_GROUP_DIR/$name.state"
      exit "$GATE_STATUS"
    ) >"$GATE_GROUP_DIR/$name.$step.out" 2>"$GATE_GROUP_DIR/$name.$step.err" &
    pids+=($!)
  done
  i=0
  for name in "$@"; do
    status=0
    wait "${pids[$i]}" || status=$?
    i=$((i + 1))
    cat "$GATE_GROUP_DIR/$name.$step.out"
    cat "$GATE_GROUP_DIR/$name.$step.err" >&2
    if [ ! -f "$GATE_GROUP_DIR/$name.state" ]; then
      echo "ERROR: $name: the $step step ended without a result (exit $status)" >&2
      failed=1
    elif [ "$status" != 0 ] && [ "$status" != 75 ]; then
      failed=1
    fi
  done
  return "$failed"
}

gate_group() {
  local name
  GATE_GROUP_SHIFTED=()
  GATE_GROUP_DIR=$(mktemp -d)
  echo "==> $*: candidates and probes at once; traffic moves only when every one passed"
  if ! gate_group_round prepare "$@" || ! gate_group_round probe "$@"; then
    echo "ERROR: a candidate or probe of $* failed; none of them moved traffic (each keeps its live revision)" >&2
    return 1
  fi
  for name in "$@"; do
    gate_group_load "$name"
    gate_promote || return 1
    if [ "$GATE_NEEDS_SHIFT" = 1 ]; then GATE_GROUP_SHIFTED+=("$name"); fi
  done
}

# deploy.sh --rollback <name> [revision]: all traffic back to <revision>, by default the revision the gate tagged
# "previous" when it last shifted traffic (the one that served before; never a candidate that failed its probe).
# Seconds, no build, no smoke.
rollback_service() {
  local name=$1 target=${2:-} region service_json live
  region=$(service_region "$name")
  service_json=$(gate_describe run services describe "$name" --region="$region") || return 1
  live=$(gate_previous_revision <<<"$service_json")
  if [ -z "$target" ]; then
    target=$(gate_json '(j?.status?.traffic ?? []).find((t) => t.tag === a[0])?.revisionName' "$PREVIOUS_TAG" <<<"$service_json")
    # A measure rung (spec 18) never served real calls; it is a target only when named.
    if gate_measure_tagged "$target" <<<"$service_json"; then
      echo "ERROR: $name: $target is a measure rung (measure-* tag), not a revision that served the worker; name it to return to it: bash infra/deploy.sh --rollback $name $target" >&2
      return 1
    fi
  fi
  if [ -z "$target" ] || [ "$target" = "$live" ]; then
    echo "ERROR: $name: no earlier revision tagged $PREVIOUS_TAG to roll back to (live: ${live:-none}); name one: bash infra/deploy.sh --rollback $name <revision>" >&2
    return 1
  fi
  echo "==> $name: rollback $live -> $target"
  echo "gcloud run services update-traffic $name --to-revisions $target=100"
  gate_gcloud run services update-traffic "$name" --region="$region" --to-revisions="$target=100" --quiet >/dev/null
  echo "==> $name: live ($target)"
}
