# M6-F2-R8 (M6-S4): the deploy pre-flight. Before deploy.sh builds anything it checks that
#   1. the gcloud login works without a prompt (two deploys stopped on an expired login, 30 and 31 Oct),
#   2. the login has at least PREFLIGHT_MIN_HOURS (3) left, and
#   3. the Cloud Build identity and the job identity (catalog-worker) exist and are enabled,
# and otherwise stops with the login command. Sourced; reads no secret and never prints a token.
#
# How much login is left: gcloud does not report when a user login will ask for reauthentication. On this machine it
# lasts roughly a day (docs/solutions/gcloud-login-after-reboot.md); GCLOUD_SESSION_HOURS (default 20, an assumption
# kept below "roughly a day") is that length, counted from the last `gcloud auth login`, which rewrites credentials.db
# in the gcloud config folder (token refreshes do not). A reboot also ends the login; check 1 catches that.
# Tests replace preflight_gcloud with a fake and set PREFLIGHT_CREDENTIALS_FILE and PREFLIGHT_NOW.
#
# disk_preflight runs first: the drive holding the temp folder and the repo's drive each need DEPLOY_MIN_FREE_GB (8)
# free. On 2026-11-05 (deploy of 9b9abfc) C: reached 0 bytes mid-deploy (the build tarball, gcloud temp files and the
# logs all write there; free space swung between 0 and 4 GB), a here-string could not get its temp file and a probe
# gate timed out. Tests replace preflight_df with a fake.

PREFLIGHT_MIN_HOURS=${PREFLIGHT_MIN_HOURS:-3}
GCLOUD_SESSION_HOURS=${GCLOUD_SESSION_HOURS:-20}
PREFLIGHT_LOGIN_COMMAND=${PREFLIGHT_LOGIN_COMMAND:-gcloud auth login --update-adc}
DEPLOY_MIN_FREE_GB=${DEPLOY_MIN_FREE_GB:-8}

# shellcheck source=gcloud-retry.sh
source "$(dirname "${BASH_SOURCE[0]}")/gcloud-retry.sh"
# Every pre-flight call is a read; a network blip is retried (2026-11-05 stop #15), an expired login is not.
preflight_gcloud() { gcloud_retry gcloud "$@"; }

# POSIX df in KiB (Git Bash on Windows and Linux both accept it); line 2 is: filesystem, size, used, available, ...
preflight_df() { df -Pk "$1"; }

# The temp folder (TMPDIR, else TEMP on Windows, else /tmp), as a path this shell can pass to df.
preflight_temp_dir() {
  local tmp=${TMPDIR:-${TEMP:-/tmp}}
  if command -v cygpath > /dev/null 2>&1; then tmp=$(cygpath -u "$tmp"); fi
  printf '%s' "$tmp"
}

# disk_preflight: 0 when every drive a deploy writes to has DEPLOY_MIN_FREE_GB free, else the measured free space and
# a hint on stderr and 1. Pipes only (no here-string or process substitution), so it still answers on a full disk.
disk_preflight() {
  local min_kb ok=0 entry label dir line fs avail gb seen=$'\n' repo
  if ! [[ "$DEPLOY_MIN_FREE_GB" =~ ^[0-9]+$ ]]; then
    echo "ERROR: pre-flight: DEPLOY_MIN_FREE_GB must be a whole number of GB ('$DEPLOY_MIN_FREE_GB')" >&2
    return 1
  fi
  min_kb=$((DEPLOY_MIN_FREE_GB * 1024 * 1024))
  repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
  for entry in "temp folder|$(preflight_temp_dir)" "repo|$repo"; do
    label=${entry%%|*}; dir=${entry#*|}
    line=$(preflight_df "$dir" 2>/dev/null | awk 'NR == 2') || line=""
    fs=$(printf '%s' "$line" | awk '{print $1}')
    avail=$(printf '%s' "$line" | awk '{print $4}')
    if ! [[ "$avail" =~ ^[0-9]+$ ]]; then
      echo "ERROR: pre-flight: cannot measure the free space for the $label ($dir) with df -Pk, so it cannot promise the ${DEPLOY_MIN_FREE_GB} GB a deploy needs" >&2
      ok=1; continue
    fi
    # One line per drive: the temp folder and the repo are usually both on C:.
    [[ "$seen" == *$'\n'"$fs"$'\n'* ]] && continue
    seen+="$fs"$'\n'
    gb=$(awk -v k="$avail" 'BEGIN { printf "%.1f", int(k * 10 / 1048576) / 10 }') # rounded down
    if [ "$avail" -lt "$min_kb" ]; then
      echo "ERROR: pre-flight: only $gb GB free on $fs (the $label, $dir); a deploy needs ${DEPLOY_MIN_FREE_GB} GB (DEPLOY_MIN_FREE_GB) because the build tarball, gcloud temp files and the logs all write there. Free space (Windows Settings > System > Storage, or remove merged worktrees: git worktree list), then re-run" >&2
      ok=1
    else
      echo "==> pre-flight: $gb GB free on $fs (the $label; a deploy needs ${DEPLOY_MIN_FREE_GB} GB)"
    fi
  done
  return "$ok"
}

# The credentials.db of the active gcloud config folder (CLOUDSDK_CONFIG wins), as a path this shell can stat.
preflight_credentials_file() {
  if [ -n "${PREFLIGHT_CREDENTIALS_FILE:-}" ]; then printf '%s' "$PREFLIGHT_CREDENTIALS_FILE"; return; fi
  local dir=${CLOUDSDK_CONFIG:-}
  [ -n "$dir" ] || dir=$(preflight_gcloud info --format='get(config.paths.global_config_dir)' 2>/dev/null | tr -d '\r')
  if [ -n "$dir" ] && command -v cygpath > /dev/null 2>&1; then dir=$(cygpath -u "$dir"); fi
  [ -n "$dir" ] && printf '%s/credentials.db' "$dir"
}

# preflight_login_works: 0 when gcloud gets a token without a prompt, else the login command on stderr and 1. deploy.sh
# runs it before its first gcloud read, so an expired login stops with this line rather than a reauth trace.
preflight_login_works() {
  preflight_gcloud auth print-access-token > /dev/null 2>&1 && return 0
  echo "ERROR: pre-flight: the gcloud login does not work without a prompt (expired, or a reboot ended it). Log in again, then re-run: $PREFLIGHT_LOGIN_COMMAND" >&2
  return 1
}

# login_preflight <build service account> <job service account>: 0 when all checks pass, else the reasons and the
# login command on stderr and 1.
login_preflight() {
  local build_sa=$1 job_sa=$2 ok=0 file login_at now left_s min_s sa disabled
  preflight_login_works || return 1
  now=${PREFLIGHT_NOW:-$(date +%s)}
  min_s=$((PREFLIGHT_MIN_HOURS * 3600))
  file=$(preflight_credentials_file)
  if [ -n "$file" ] && login_at=$(stat -c %Y "$file" 2>/dev/null) && [[ "$login_at" =~ ^[0-9]+$ ]]; then
    left_s=$((login_at + GCLOUD_SESSION_HOURS * 3600 - now))
    if [ "$left_s" -lt "$min_s" ]; then
      echo "ERROR: pre-flight: the gcloud login is about $(((now - login_at) / 3600)) h old and has about $((left_s > 0 ? left_s / 60 : 0)) min left of a ${GCLOUD_SESSION_HOURS} h login; a deploy needs ${PREFLIGHT_MIN_HOURS} h. Log in again, then re-run: $PREFLIGHT_LOGIN_COMMAND" >&2
      ok=1
    else
      echo "==> pre-flight: gcloud login works, about $((left_s / 3600)) h left (of an assumed ${GCLOUD_SESSION_HOURS} h)"
    fi
  else
    echo "ERROR: pre-flight: cannot tell when gcloud last logged in (no credentials.db found), so it cannot promise the ${PREFLIGHT_MIN_HOURS} h a deploy needs. Log in again, then re-run: $PREFLIGHT_LOGIN_COMMAND" >&2
    ok=1
  fi
  for sa in "$build_sa" "$job_sa"; do
    if ! disabled=$(preflight_gcloud iam service-accounts describe "$sa" --format='value(disabled)' 2>/dev/null | tr -d '\r'); then
      echo "ERROR: pre-flight: cannot read the service account $sa (missing, or this login may not read it); run infra/bootstrap.sh or check IAM first" >&2
      ok=1
    elif [ "${disabled,,}" = true ]; then
      echo "ERROR: pre-flight: the service account $sa is disabled; enable it first (gcloud iam service-accounts enable $sa)" >&2
      ok=1
    fi
  done
  [ "$ok" = 0 ] && echo "==> pre-flight: the build identity and the job identity are enabled"
  return "$ok"
}
