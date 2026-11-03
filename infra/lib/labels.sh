# M6-F1 (M6-S1): the labels of every Cloud Run service and job of the catalog, so the billing export and the cost
# ledger (catalog_cost_events.component) group cost by the same names:
#   app=catalog                  every catalog resource
#   component=<name>             the Cloud Run service or job name (catalog-worker, catalog-migrate, catalog-test-smoke)
#   env=live|preview|test        live stack, preview stack, or a test, eval or load job (reported apart from operator cost)
# deploy.sh (through deploy_service in infra/lib/gate.sh) and every job script refuse to deploy a service or job whose
# labels miss app or component (catalog_labels_check). Sourced; pure bash, no gcloud.

# live, or preview on the preview stack (CATALOG_PREVIEW=1).
catalog_env() { if [ "${CATALOG_PREVIEW:-0}" = 1 ]; then echo preview; else echo live; fi; }

# catalog_labels <component> [env]: the --labels value, env defaulting to catalog_env.
catalog_labels() { printf 'app=catalog,component=%s,env=%s' "$1" "${2:-$(catalog_env)}"; }

# catalog_labels_check <what> <labels>: 0 when <labels> (k=v,k=v) holds app=catalog, a component and env live, preview
# or test; else the refusal on stderr and 1.
catalog_labels_check() {
  local what=$1 labels=",$2,"
  if [[ "$labels" == *,app=catalog,* && "$labels" =~ ,component=[a-z0-9-]+, && "$labels" =~ ,env=(live|preview|test), ]]; then return 0; fi
  echo "ERROR: refusing to deploy $what without the labels app=catalog, component=<name> and env=live|preview|test (got '$2'); see infra/lib/labels.sh" >&2
  return 1
}

# catalog_labels_in_args <arg>...: the value of the --labels flag among gcloud args (empty when there is none).
catalog_labels_in_args() {
  local arg next=0
  for arg in "$@"; do
    if [ "$next" = 1 ]; then printf '%s' "$arg"; return; fi
    case "$arg" in --labels=*) printf '%s' "${arg#--labels=}"; return ;; --labels) next=1 ;; esac
  done
}
