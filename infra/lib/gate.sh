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
#
# After a call: GATE_URL (the service URL), GATE_TAG_URL (the candidate URL, or the service URL on SKIP or when
# reused), GATE_REVISION (the revision the gate deployed or found live), GATE_PREVIOUS (the revision that served
# before), GATE_CHANGED (1 when a new revision was deployed).
# Return codes: 0 passed, SKIP or reused; 1 failed; 75 quota refused on first creation of a SVC_QUOTA_OPTIONAL
# service (the caller warns and continues without it).
#
# Every gcloud call goes through gate_gcloud. Tests define their own gate_gcloud before sourcing this file, so no
# test reaches gcloud.

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
# Prints the JSON (without CR) on success; on failure passes gcloud's stderr on and returns its status.
gate_describe() {
  local err out status=0
  err=$(mktemp)
  out=$(gate_gcloud "$@" --format=json 2>"$err") || status=$?
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
  digest=$(gate_gcloud artifacts docker images describe "$SVC_IMAGE" --format='value(image_summary.digest)' 2>/dev/null | tr -d '\r') || return 1
  [ -n "$digest" ] || return 1
  revision_json=$(gate_gcloud run revisions describe "$revision" --region="$SVC_REGION" --format=json | tr -d '\r') || return 1
  node -e '
    const r = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const [digest, env] = process.argv.slice(1);
    const live = (r?.spec?.containers?.[0]?.env ?? []).filter((e) => e.value !== undefined).map((e) => `${e.name}=${e.value}`).sort();
    const want = env.split(",").filter(Boolean).sort();
    const sameEnv = live.length === want.length && live.every((e, i) => e === want[i]);
    process.exit(String(r?.status?.imageDigest ?? "").endsWith("@" + digest) && sameEnv ? 0 : 1);
  ' "$digest" "$env" <<<"$revision_json"
}

deploy_service() {
  local name=$1 fn exists=0 service_json previous fingerprint env deploy_out status started tag describe_err
  local -a args
  fn=service_${name//-/_}
  declare -F "$fn" >/dev/null || { echo "ERROR: $name is not in the service registry (infra/lib/services.sh)" >&2; return 1; }
  SVC_TAG=""
  "$fn"
  GATE_URL=""; GATE_TAG_URL=""; GATE_REVISION=""; GATE_PREVIOUS=""; GATE_CHANGED=0
  tag=${SVC_TAG:-$CANDIDATE_TAG}

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
    [ -n "$GATE_URL" ] || { echo "ERROR: $SVC_NAME is reused but has no URL" >&2; return 1; }
    GATE_TAG_URL=$GATE_URL; GATE_REVISION=$previous
    echo "==> $SVC_NAME: reused as it is ($previous)"
    return 0
  fi

  fingerprint=$(gate_fingerprint)
  env="$SVC_ENV,DEPLOY_ARGS_SHA=$fingerprint"
  if [ -n "$previous" ] && [ "${GATE_FORCE:-0}" != 1 ] && gate_matches_live "$previous" "$env"; then
    GATE_URL=$(gate_json 'j?.status?.url' <<<"$service_json")
    GATE_TAG_URL=$GATE_URL; GATE_REVISION=$previous
    echo "==> $SVC_NAME: SKIP (live revision $previous already runs this image and env)"
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

  echo "==> $SVC_NAME: probe $GATE_REVISION at $GATE_TAG_URL (at most ${SVC_PROBE_TIMEOUT} s)"
  started=$SECONDS
  status=0
  # The probe's output streams as it runs (the worker's smoke takes minutes) and stays above the verdict.
  # pipefail (restored on return by `local -`) so the probe's exit status, not sed's, decides.
  local -; set -o pipefail
  timeout --kill-after=10 "$SVC_PROBE_TIMEOUT" "${SVC_PROBE[@]}" "$GATE_TAG_URL" 2>&1 | sed 's/^/    probe | /' || status=${PIPESTATUS[0]}
  if [ "$status" != 0 ]; then
    if [ "$status" = 124 ] || [ "$status" = 137 ]; then
      echo "ERROR: $SVC_NAME: probe of $GATE_REVISION timed out after ${SVC_PROBE_TIMEOUT} s; traffic was not changed" >&2
    else
      echo "ERROR: $SVC_NAME: probe of $GATE_REVISION failed (exit $status) after $((SECONDS - started)) s; traffic was not changed" >&2
    fi
    gate_rollback_line "$SVC_NAME" "$previous" "$SVC_REGION"
    return 1
  fi

  if [ "$SVC_SHIFT" != 1 ]; then
    echo "==> $SVC_NAME: candidate ($GATE_REVISION) passed; traffic not shifted"
    return 0
  fi
  # The revision serving now is what deploy.sh --rollback returns to, never a candidate that failed its probe.
  if [ -n "$previous" ] && [ "$previous" != "$GATE_REVISION" ]; then
    gate_gcloud run services update-traffic "$SVC_NAME" --region="$SVC_REGION" --update-tags="$PREVIOUS_TAG=$previous" --quiet >/dev/null || {
      gate_fail "could not tag $previous as $PREVIOUS_TAG; traffic was not changed"
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
  if service_json=$(gate_describe run services describe "$SVC_NAME" --region="$SVC_REGION") \
      && [ -n "$(gate_json '(j?.status?.traffic ?? []).find((t) => t.tag === a[0] && t.revisionName !== a[1])?.revisionName' \
        "$CANDIDATE_TAG" "$GATE_REVISION" <<<"$service_json")" ]; then
    gate_gcloud run services update-traffic "$SVC_NAME" --region="$SVC_REGION" --remove-tags="$CANDIDATE_TAG" --quiet >/dev/null \
      || echo "WARN: $SVC_NAME: could not remove the stale $CANDIDATE_TAG tag" >&2
  fi
  return 0
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
