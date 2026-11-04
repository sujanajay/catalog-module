# shellcheck shell=bash
# M1-F1-R4 admin switch for the Supabase folder paste on catalog-web (sourced by infra/deploy.sh).
#
# supabase_folder_paste <web service> <region>: prints "on" or "off".
# - SUPABASE_FOLDER_PASTE set (on or off): that value; anything else stops the deploy.
# - Unset: the value the live service runs with, so an "off" set at an earlier deploy (or by hand with
#   gcloud run services update) sticks across later plain deploys. A live service without the variable is "on"; a
#   service that does not exist yet (first deploy) is "on". When the live service cannot be read, the deploy stops
#   rather than guess, and says how to choose.
supabase_folder_paste() {
  local service="$1" region="$2" described value
  if [ -n "${SUPABASE_FOLDER_PASTE:-}" ]; then
    case "$SUPABASE_FOLDER_PASTE" in
      on|off) printf '%s\n' "$SUPABASE_FOLDER_PASTE"; return 0 ;;
      *) echo "SUPABASE_FOLDER_PASTE must be on or off" >&2; return 1 ;;
    esac
  fi
  if ! described=$(gcloud run services describe "$service" --region="$region" --format=json 2>&1); then
    if grep -qiE 'NOT_FOUND|not found|could not be found|does not exist' <<<"$described"; then printf 'on\n'; return 0; fi
    printf '%s\n' "$described" >&2
    echo "ERROR: cannot read $service to keep its Supabase folder paste switch; set SUPABASE_FOLDER_PASTE=on or off and deploy again" >&2
    return 1
  fi
  value=$(node -e '
    const s = JSON.parse(require("fs").readFileSync(0, "utf8").replace(/\r/g, "") || "{}");
    const env = s?.spec?.template?.spec?.containers?.[0]?.env ?? [];
    process.stdout.write(env.find((e) => e.name === "SUPABASE_FOLDER_PASTE")?.value ?? "");
  ' <<<"$described") || { echo "ERROR: cannot parse $service to keep its Supabase folder paste switch; set SUPABASE_FOLDER_PASTE=on or off" >&2; return 1; }
  case "$value" in
    off) printf 'off\n' ;;
    *) printf 'on\n' ;;
  esac
}
