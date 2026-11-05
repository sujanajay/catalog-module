# Fake gcloud for infra/tests/gcloud-retry.test.mjs (see the sequences described there). No GCP call; every call is
# logged to $LOG, and the position in each sequence is kept under $STATE.
next() { local kind=$1 seq=$2 n; n=$(( $(cat "$STATE/$kind" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$STATE/$kind"
  IFS=, read -ra items <<<"$seq"; echo "${items[n-1]:-${items[-1]}}"; }
dns() { echo "ERROR: gcloud crashed (ConnectionError): HTTPSConnectionPool(host='asia-south1-run.googleapis.com', port=443): Max retries exceeded with url: /x (Caused by NameResolutionError(\"Failed to resolve 'asia-south1-run.googleapis.com' ([Errno 11001] getaddrinfo failed)\"))" >&2; return 1; }
reset() { echo "ERROR: gcloud crashed (ConnectionError): ('Connection aborted.', ConnectionResetError(10054, 'An existing connection was forcibly closed by the remote host'))" >&2; return 1; }
gcloud() {
  printf '%s\n' "$*" >> "$LOG"
  local step
  case "$*" in
    "run jobs execute "*)
      step=$(next exec "${EXEC_SEQ:-ok}")
      case "$step" in ok) printf 'probe-job-ab12c\r\n' ;; dns) dns ;; reset) reset ;; denied) echo "ERROR: (gcloud.run.jobs.execute) PERMISSION_DENIED: no" >&2; return 1 ;; esac ;;
    "run jobs executions describe "*)
      step=$(next poll "${POLL_SEQ:-succeeded}")
      case "$step" in
        running) echo '{"status":{"conditions":[{"type":"Started","status":"True"}]}}' ;;
        succeeded) echo '{"status":{"conditions":[{"type":"Completed","status":"True"}],"succeededCount":1}}' ;;
        failed) echo '{"status":{"conditions":[{"type":"Completed","status":"False","reason":"NonZeroExitCode","message":"Task probe-job-ab12c-task0 failed with exit code: 1"}],"failedCount":1}}' ;;
        garbage) echo 'not json' ;;
        partial) echo '{"status":{"conditions":[{"type":"Completed","status":"True"}],"succeededCount":1,"failedCount":1}}' ;;
        busy) echo "ERROR: (gcloud.run.jobs.executions.describe) UNAVAILABLE: The service is currently unavailable." >&2; return 1 ;;
        dns) dns ;;
        denied) echo "ERROR: (gcloud.run.jobs.executions.describe) PERMISSION_DENIED: no" >&2; return 1 ;;
        nospace) echo "ERROR: gcloud failed to load: [Errno 28] No space left on device" >&2; return 1 ;;
      esac ;;
    "run jobs executions cancel "*) echo "cancelled" ;;
    "logging read "*) printf '| model | size |\nprobe passed\n' ;;
    *)
      step=$(next read "${READ_SEQ:-ok}")
      case "$step" in
        ok) echo '{"status":{"url":"https://x.run.app"}}' ;;
        dns) dns ;; reset) reset ;;
        notfound) echo "ERROR: (gcloud.run.services.describe) Cannot find service [x] NOT_FOUND" >&2; return 1 ;;
        denied) echo "ERROR: (gcloud.run.services.describe) PERMISSION_DENIED: no" >&2; return 1 ;;
        reauth) echo "ERROR: (gcloud.auth.print-access-token) Reauthentication failed. cannot prompt during non-interactive execution." >&2; return 1 ;;
      esac ;;
  esac
}
export -f gcloud next dns reset
