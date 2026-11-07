# shellcheck shell=bash
# gcloud calls that survive a laptop network blip (2026-11-05 root-cause review, item 2: deploy stops #11, #12 and #15).
# deploy.sh and the gate probes run gcloud from the operator's laptop for an hour or more. One DNS miss used to end a
# `gcloud run jobs execute --wait` (the worker smoke and an upscale probe failed the gate although the job on GCP ran on
# and, for the smoke, passed) or a read-only check (the image check). Sourced by deploy.sh (through preflight.sh,
# build.sh and gate.sh), infra/check-matting.sh, infra/catalog-smoke-linux.sh and infra/catalog-test-jobs.sh.
#
#   gcloud_retry <command> [args...]
#       For read-only or idempotent calls (describe, list, print-access-token, jobs deploy/replace of a whole
#       definition). Runs the command (gcloud, or a wrapper function such as gate_gcloud); after a network error
#       (GCLOUD_TRANSPORT_RE: DNS, refused, reset, timeout, gcloud crashing on a ConnectionError) it tries again,
#       GCLOUD_RETRY_ATTEMPTS times in all, GCLOUD_RETRY_DELAY_S apart and doubling, and prints each retry. Any other
#       failure (NOT_FOUND, PERMISSION_DENIED, an expired login) returns at once with gcloud's error.
#   gcloud_exists <gcloud describe args...>
#       0 when the resource exists, 1 when gcloud says it does not (NOT_FOUND), 2 when the check itself failed after
#       the network retries (the error is printed), so a DNS blip is never reported as "missing".
#   gcloud_job_run <job> <region> [cancel on TERM: 1 (default) or 0]
#       Runs one execution of a Cloud Run job and judges it only from the execution's final state on GCP: starts it with
#       --async (retried only when the request never left the laptop, so a retry can never start a second execution),
#       then reads `executions describe` every GCLOUD_POLL_S seconds until its Completed condition is True (0) or False
#       (1). A network error while polling is waited out for up to GCLOUD_POLL_OUTAGE_S seconds in a row; past that, or
#       on any other read error, the result is unknown and it returns 1, so a gate keeps the old traffic. Afterwards the
#       execution's log is printed (best effort; it never changes the verdict). TERM or INT (the gate's hard timeout)
#       cancels the execution, so a probe the gate gave up on stops running on the candidate (0 for a job that must
#       never stop half-way, such as catalog-migrate). A Run API 429 or 503 while polling (GCLOUD_API_BUSY_RE) is waited
#       out like a network error. A local failure to judge the state (a full disk, no temp file) returns unknown (1) at
#       once with a "local disk/temp error" line. Success needs Completed True and no failed task.
# Tests set the variables below to 0 and put a fake gcloud first on PATH (or define gcloud as a function).

GCLOUD_RETRY_ATTEMPTS=${GCLOUD_RETRY_ATTEMPTS:-5}
GCLOUD_RETRY_DELAY_S=${GCLOUD_RETRY_DELAY_S:-5}
GCLOUD_POLL_S=${GCLOUD_POLL_S:-20}
GCLOUD_POLL_OUTAGE_S=${GCLOUD_POLL_OUTAGE_S:-900}
# What gcloud prints when the network, not the API, failed (gcloud crashes with the Python exception name; a token
# refresh that cannot reach oauth2.googleapis.com says "Failed to resolve" too). An expired login ("Reauthentication
# failed") and API answers (NOT_FOUND, PERMISSION_DENIED, INVALID_ARGUMENT) do not match.
GCLOUD_TRANSPORT_RE='gcloud crashed \((ConnectionError|SSLError|Timeout|ReadTimeout|ConnectTimeout|TransportError|ConnectionResetError|RemoteDisconnected|ProtocolError|ChunkedEncodingError|MaxRetryError|NewConnectionError)\)|NameResolutionError|getaddrinfo failed|Failed to resolve|Temporary failure in name resolution|Name or service not known|Connection reset by peer|Connection aborted|Connection refused|Max retries exceeded|Read timed out|Connection timed out'
# A Run API that is briefly overloaded: during polling waited out like a network error (the request itself is a read).
GCLOUD_API_BUSY_RE='RESOURCE_EXHAUSTED|UNAVAILABLE|HTTPError 503|HTTPError 429|code=503|code=429|Service Unavailable|Too Many Requests'
# A local failure on the laptop (full disk, no temp file), not an answer from GCP: an unknown result at once.
GCLOUD_LOCAL_DISK_RE='No space left on device|ENOSPC|Errno 28|cannot create temp file|Disk quota exceeded'
# The subset where the request certainly never reached Google (no name, no connection): safe to repeat even for a call
# that is not idempotent, such as starting a job execution.
GCLOUD_UNSENT_RE='NameResolutionError|getaddrinfo failed|Failed to resolve|Temporary failure in name resolution|Name or service not known|Connection refused|ConnectTimeout|NewConnectionError'

# The first network-error phrase in a gcloud error file, for the retry line.
gcloud_network_reason() {
  local found
  # The whole first matching line (it names the host and the cause), cut to a readable length.
  found=$(grep -m1 -E "$GCLOUD_TRANSPORT_RE|${GCLOUD_API_BUSY_RE:-^$}" "$1" 2>/dev/null) || found="network error"
  found=${found//$'\r'/}
  echo "${found:0:240}"
}

gcloud_retry() {
  local attempt=1 delay=$GCLOUD_RETRY_DELAY_S err status out
  err=$(mktemp)
  while :; do
    status=0
    out=$("$@" 2>"$err") || status=$?
    if [ "$status" = 0 ]; then
      cat "$err" >&2; rm -f "$err"
      [ -z "$out" ] || printf '%s\n' "$out"
      return 0
    fi
    if [ "$attempt" -ge "$GCLOUD_RETRY_ATTEMPTS" ] || ! grep -qE "$GCLOUD_TRANSPORT_RE" "$err"; then
      cat "$err" >&2; rm -f "$err"
      [ "$attempt" -lt 2 ] || echo "ERROR: ${*:2:4}: still failing after $attempt attempts" >&2
      return "$status"
    fi
    echo "WARN: ${*:2:4}: $(gcloud_network_reason "$err") (attempt $attempt of $GCLOUD_RETRY_ATTEMPTS); trying again in $delay s" >&2
    sleep "$delay"
    attempt=$((attempt + 1)); delay=$((delay * 2))
  done
}

gcloud_exists() {
  local out status=0
  out=$(gcloud_retry gcloud "$@" 2>&1 >/dev/null) || status=$?
  # The retry lines stay visible; the rest of gcloud's stderr only on a failed check.
  grep -E '^WARN: ' <<<"$out" >&2 || true
  [ "$status" != 0 ] || return 0
  if grep -qiE "NOT_FOUND|not found|does not exist|could not be found|cannot find" <<<"$out"; then return 1; fi
  printf '%s\n' "$out" >&2
  return 2
}

# gcloud_job_state < execution JSON: running | succeeded | failed: <message> | unreadable
gcloud_job_state() {
  node -e '
    let s = ""; process.stdin.on("data", (d) => s += d).on("end", () => {
      let j; try { j = JSON.parse(s.replace(/\r/g, "")); } catch { console.log("unreadable"); return; }
      const c = (j?.status?.conditions ?? []).find((x) => x.type === "Completed");
      if (c?.status === "True" && Number(j?.status?.failedCount ?? 0) === 0) console.log("succeeded");
      else if (c?.status === "True") console.log("failed: " + j.status.failedCount + " task(s) failed");
      else if (c?.status === "False") console.log("failed: " + String(c.message || c.reason || "no message").replace(/\s+/g, " "));
      else console.log("running");
    });'
}

gcloud_job_cancel() {
  local job=$1 execution=$2 region=$3
  echo "==> $job: cancelling execution $execution (the gate stopped waiting)" >&2
  gcloud_retry gcloud run jobs executions cancel "$execution" --region="$region" --quiet >/dev/null 2>&1 \
    || echo "WARN: $job: could not cancel $execution; it ends at its task timeout. By hand: gcloud run jobs executions cancel $execution --region=$region" >&2
}

# The execution's own output, after it ended (best effort: the log can lag a few seconds behind the end).
gcloud_job_logs() {
  local job=$1 execution=$2 region=$3 logs
  logs=$(GCLOUD_RETRY_ATTEMPTS=2 gcloud_retry gcloud logging read \
    "resource.type=\"cloud_run_job\" AND resource.labels.job_name=\"$job\" AND labels.\"run.googleapis.com/execution_name\"=\"$execution\"" \
    --order=asc --limit=400 --freshness=2d --format='value(textPayload)' 2>/dev/null) || logs=""
  logs=${logs//$'\r'/}
  if [ -n "$logs" ]; then
    echo "--- $execution log ---"; printf '%s\n' "$logs"; echo "--- end of $execution log ---"
  else
    echo "(log of $execution not readable yet: gcloud logging read 'labels.\"run.googleapis.com/execution_name\"=\"$execution\"')"
  fi
}

gcloud_job_run() {
  local job=$1 region=$2 cancel=${3:-1} execution="" err status json state="" outage_since="" attempt=1 delay=$GCLOUD_RETRY_DELAY_S
  if ! err=$(mktemp); then
    echo "ERROR: $job: local disk/temp error: cannot create a temp file in ${TMPDIR:-/tmp} (is the disk full?); nothing was started, so this does not pass" >&2
    return 1
  fi
  while :; do
    status=0
    # GCLOUD_JOB_EXECUTE_FLAGS (an array, optional): flags for this one execution, such as its --args and one env var.
    execution=$(gcloud run jobs execute "$job" --region="$region" --async --format='value(metadata.name)' ${GCLOUD_JOB_EXECUTE_FLAGS[@]+"${GCLOUD_JOB_EXECUTE_FLAGS[@]}"} 2>"$err") || status=$?
    execution=${execution//$'\r'/}; execution=${execution//$'\n'/}
    [ "$status" != 0 ] || break
    if [ "$attempt" -lt "$GCLOUD_RETRY_ATTEMPTS" ] && grep -qE "$GCLOUD_UNSENT_RE" "$err"; then
      echo "WARN: $job: $(gcloud_network_reason "$err") before the start request left (attempt $attempt of $GCLOUD_RETRY_ATTEMPTS); trying again in $delay s" >&2
      sleep "$delay"; attempt=$((attempt + 1)); delay=$((delay * 2))
      continue
    fi
    cat "$err" >&2
    if grep -qE "$GCLOUD_TRANSPORT_RE" "$err"; then
      echo "ERROR: $job: the network failed while starting an execution, so it may or may not have started (gcloud run jobs executions list --job=$job --region=$region). No result, so this does not pass." >&2
    fi
    rm -f "$err"; return 1
  done
  if ! [[ "$execution" =~ ^[a-z0-9-]+$ ]]; then
    echo "ERROR: $job: gcloud started no execution it could name ('$execution'); no result, so this does not pass" >&2
    rm -f "$err"; return 1
  fi
  echo "==> $job: execution $execution started; reading its state every $GCLOUD_POLL_S s"
  # shellcheck disable=SC2064 # the names are fixed now
  if [ "$cancel" = 1 ]; then
    trap "gcloud_job_cancel '$job' '$execution' '$region'; exit 143" TERM INT
  else
    trap "echo \"==> $job: stopped waiting; execution $execution runs on (gcloud run jobs executions describe $execution --region=$region)\" >&2; exit 143" TERM INT
  fi
  while :; do
    status=0
    json=$(gcloud run jobs executions describe "$execution" --region="$region" --format=json 2>"$err") || status=$?
    if [ "$status" != 0 ]; then
      if ! grep -qE "$GCLOUD_TRANSPORT_RE|$GCLOUD_API_BUSY_RE" "$err"; then
        cat "$err" >&2
        if grep -qE "$GCLOUD_LOCAL_DISK_RE" "$err"; then
          state="unknown: local disk/temp error on this laptop while reading execution $execution (is the disk full?). It may still be running: gcloud run jobs executions describe $execution --region=$region"
        else
          state="unknown: cannot read execution $execution"
        fi
        break
      fi
      [ -n "$outage_since" ] || outage_since=$SECONDS
      if [ $((SECONDS - outage_since)) -ge "$GCLOUD_POLL_OUTAGE_S" ]; then
        cat "$err" >&2
        state="unknown: no read of execution $execution for $((SECONDS - outage_since)) s (network; limit $GCLOUD_POLL_OUTAGE_S s). It may still be running: gcloud run jobs executions describe $execution --region=$region"
        break
      fi
      echo "WARN: $job: cannot read execution $execution: $(gcloud_network_reason "$err"); trying again in $GCLOUD_POLL_S s" >&2
      sleep "$GCLOUD_POLL_S"
      continue
    fi
    outage_since=""
    # Piped, not a here-string: bash may write a here-string to a temp file, and on a full disk that failed and the
    # probe never read a state (2026-11-05, deploy of 9b9abfc). A local failure to judge the state is an unknown result
    # at once, never a pass and never another wait.
    status=0
    state=$(printf "%s" "$json" | gcloud_job_state) || status=$?
    if [ "$status" != 0 ] || [ -z "$state" ]; then
      state="unknown: local disk/temp error on this laptop: could not judge the state of execution $execution (exit $status; is the disk full?). It may still be running: gcloud run jobs executions describe $execution --region=$region"
      break
    fi
    [ "$state" = running ] || break
    sleep "$GCLOUD_POLL_S"
  done
  trap - TERM INT
  rm -f "$err"
  case "$state" in
    succeeded|failed:*) gcloud_job_logs "$job" "$execution" "$region" ;;
  esac
  if [ "$state" = succeeded ]; then
    echo "==> $job: execution $execution succeeded"
    return 0
  fi
  echo "ERROR: $job: execution $execution: $state; this does not pass" >&2
  return 1
}
