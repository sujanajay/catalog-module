#!/usr/bin/env bash
# Mirror the warehouse objects the nightly master sync reads into project image-links-agent.
#
# What: copies, under the SAME dataset names and in the same location (asia-south1),
#   - tables opptra-datawarehouse.raw_gcc_dimensions.master_sl and .sku_master_sheet_hl
#     (CREATE OR REPLACE TABLE ... AS SELECT *), and
#   - the SQL UDFs opptra-datawarehouse.fact_gcc.alias_gcc_brand and .family_of_gcc_brand
#     (recreated from their definitions with CREATE OR REPLACE FUNCTION),
#   into image-links-agent:raw_gcc_dimensions and image-links-agent:fact_gcc, and grants
#   catalog-worker@ roles/bigquery.jobUser on image-links-agent (project level) and
#   roles/bigquery.dataViewer on the two mirror datasets. The sync SQL (master-sync.ts) uses
#   unqualified names that resolve against the job's project, so with BQ_PROJECT=image-links-agent
#   (the default in infra/deploy.sh while this mirror is in use) it reads the copies unchanged.
#
# Why (temporary): catalog-worker@ has no BigQuery rights in opptra-datawarehouse and the operator
#   cannot grant them there. This mirror stands in until a warehouse admin grants access. The copy is
#   only as fresh as the last run of this script.
#
# Refresh: re-run this script (as the operator, who can read the warehouse). Datasets and IAM are
#   check-then-create (SKIP on a re-run); the tables and UDFs are always replaced with a fresh copy,
#   and the row counts of source and copy are compared (exit 1 when they differ).
#
# Switch back (after the admin runs the commands printed by infra/bootstrap.sh):
#   1. set the BQ_PROJECT default in infra/deploy.sh back to opptra-datawarehouse;
#   2. run bash infra/deploy.sh;
#   3. optionally delete the mirror datasets later, only with the owner's OK.
#   See docs/solutions/infra-bootstrap.md, "Warehouse mirror (temporary)".
#
# Reads opptra-datawarehouse only; never writes to it. Never deletes anything.
# Usage (Git Bash, from the repo root): bash infra/bq-mirror.sh
# Exit codes: 0 done; 1 error.
set -euo pipefail

PROJECT=image-links-agent
LOCATION=asia-south1
SOURCE_PROJECT=opptra-datawarehouse
# The operator's default gcloud project is a different one; pin this project for every gcloud call
# in this script without touching global gcloud config.
export CLOUDSDK_CORE_PROJECT=$PROJECT
# NOTE (Git Bash on Windows): do NOT export MSYS_NO_PATHCONV=1 here; it breaks the gcloud bash
# launcher. SQL goes to bq on stdin, so no argument is subject to MSYS path conversion.

cd "$(dirname "$0")/.."

# Exactly the objects packages/core/src/catalog/master-sync.ts reads (MASTER_SL_SQL, MASTER_HL_SQL).
MIRROR_DATASETS=(raw_gcc_dimensions fact_gcc)
MIRROR_TABLES=(raw_gcc_dimensions.master_sl raw_gcc_dimensions.sku_master_sheet_hl)
MIRROR_ROUTINES=(fact_gcc.alias_gcc_brand fact_gcc.family_of_gcc_brand)

log()    { printf '[bq-mirror] %s\n' "$*"; }
skip()   { printf '[bq-mirror] SKIP   %s\n' "$*"; }
create() { printf '[bq-mirror] CREATE %s\n' "$*"; }
update() { printf '[bq-mirror] UPDATE %s\n' "$*"; }
warn()   { printf '[bq-mirror] WARN   %s\n' "$*" >&2; }
die()    { printf '[bq-mirror] ERROR  %s\n' "$*" >&2; exit 1; }

# gcloud on Windows emits CRLF; strip CR from anything we parse.
gcv() { gcloud "$@" | tr -d '\r'; }

# Retry a command a few times (IAM changes can lag a few seconds).
retry() {
  local n=0 max=6
  until "$@"; do
    n=$((n + 1))
    if [ "$n" -ge "$max" ]; then return 1; fi
    log "retry $n/$max in $((n * 5))s: $*"
    sleep $((n * 5))
  done
}

command -v node >/dev/null || die "node is required (used to parse bq JSON)"
command -v bq >/dev/null || die "bq is required (Cloud SDK)"

# Git Bash on Windows: the bq launcher can pick a python it cannot start ("python3.11: command not
# found"). Fall back to the Cloud SDK's bundled python for bq only, in this shell; gcloud config is
# not touched.
if ! bq version >/dev/null 2>&1 && [ -z "${CLOUDSDK_BQ_PYTHON:-}" ] && BQ_BIN=$(command -v bq); then
  BUNDLED_PY="$(dirname "$BQ_BIN")/../platform/bundledpython/python.exe"
  if [ -x "$BUNDLED_PY" ] && CLOUDSDK_BQ_PYTHON="$BUNDLED_PY" bq version >/dev/null 2>&1; then
    export CLOUDSDK_BQ_PYTHON="$BUNDLED_PY"
    log "bq: using the Cloud SDK bundled python"
  fi
fi
bq version >/dev/null 2>&1 || die "bq does not start in this shell"

# bq with CR stripped, for output we parse.
bqv() { bq --project_id="$PROJECT" "$@" | tr -d '\r'; }
# Standard SQL query job in this project; the statement comes on stdin.
bq_sql() { bq query --project_id="$PROJECT" --location="$LOCATION" --nouse_legacy_sql "$@"; }
# Runs the statement on stdin; bq prints its errors on stdout, so show them only on failure.
bq_exec() { # description
  local out
  if ! out=$(bq_sql 2>&1); then
    printf '%s\n' "$out" | tr -d '\r' | tail -5 >&2
    die "$1 failed"
  fi
}

PN=$(gcv projects describe "$PROJECT" --format='value(projectNumber)')
[ -n "$PN" ] || die "cannot read project $PROJECT; run gcloud auth login"
WORKER=catalog-worker@$PROJECT.iam.gserviceaccount.com
gcloud iam service-accounts describe "$WORKER" --project="$PROJECT" >/dev/null 2>&1 \
  || die "service account $WORKER is missing; run infra/bootstrap.sh first"
log "mirror $SOURCE_PROJECT -> $PROJECT ($LOCATION)"

# --- 1. Datasets ------------------------------------------------------------------------
for ds in "${MIRROR_DATASETS[@]}"; do
  if ds_json=$(bqv show --format=prettyjson "$PROJECT:$ds" 2>/dev/null); then
    ds_loc=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0, "utf8")).location || "")' <<<"$ds_json")
    [ "$ds_loc" = "$LOCATION" ] || die "dataset $PROJECT:$ds exists in location '$ds_loc', expected $LOCATION"
    skip "dataset $PROJECT:$ds ($LOCATION)"
  else
    create "dataset $PROJECT:$ds ($LOCATION)"
    bq --project_id="$PROJECT" --location="$LOCATION" mk --dataset \
      --description="Temporary mirror of $SOURCE_PROJECT:$ds for the catalog master sync (infra/bq-mirror.sh)" \
      "$PROJECT:$ds" >/dev/null
  fi
done

# --- 2. Tables (always refreshed) ------------------------------------------------------------
for t in "${MIRROR_TABLES[@]}"; do
  if bqv show --format=none "$PROJECT:$t" >/dev/null 2>&1; then
    update "table $PROJECT.$t (fresh copy of $SOURCE_PROJECT.$t)"
  else
    create "table $PROJECT.$t (copy of $SOURCE_PROJECT.$t)"
  fi
  printf 'CREATE OR REPLACE TABLE `%s.%s` AS SELECT * FROM `%s.%s`' "$PROJECT" "$t" "$SOURCE_PROJECT" "$t" \
    | bq_exec "copy of $t"
done

# --- 3. SQL UDFs (always recreated from the source definition) --------------------------------
# Prints the CREATE OR REPLACE FUNCTION statement for the routine JSON on stdin. Only scalar SQL
# functions with simple typed arguments are supported; anything else stops the script.
routine_ddl() { # target-name source-project
  node -e '
    const r = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const [target, sourceProject] = process.argv.slice(1);
    const fail = (m) => { console.error(m); process.exit(1); };
    if (r.language !== "SQL" || r.routineType !== "SCALAR_FUNCTION") fail(`unsupported routine: ${r.language} ${r.routineType}`);
    const simple = (t) => t && t.typeKind && !["ARRAY", "STRUCT", "RANGE"].includes(t.typeKind) ? t.typeKind : null;
    const args = (r.arguments || []).map((a) => {
      const type = simple(a.dataType);
      if (!type || a.argumentKind === "ANY_TYPE") fail(`unsupported argument ${a.name}`);
      return `${a.name} ${type}`;
    });
    const ret = r.returnType ? simple(r.returnType) : null;
    if (r.returnType && !ret) fail("unsupported return type");
    const body = r.definitionBody || "";
    if (body.includes(sourceProject)) fail(`body references ${sourceProject}; it would still read the source`);
    process.stdout.write(`CREATE OR REPLACE FUNCTION \`${target}\`(${args.join(", ")})${ret ? ` RETURNS ${ret}` : ""}\nAS (${body})`);
  ' "$1" "$2"
}
routine_body() { node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0, "utf8")).definitionBody || "")'; }

for r in "${MIRROR_ROUTINES[@]}"; do
  src_json=$(bqv show --routine --format=prettyjson "$SOURCE_PROJECT:$r") || die "cannot read routine $SOURCE_PROJECT:$r"
  ddl=$(routine_ddl "$PROJECT.$r" "$SOURCE_PROJECT" <<<"$src_json") || die "cannot recreate routine $r"
  if bqv show --routine --format=none "$PROJECT:$r" >/dev/null 2>&1; then
    update "routine $PROJECT.$r (recreated from $SOURCE_PROJECT.$r)"
  else
    create "routine $PROJECT.$r (from $SOURCE_PROJECT.$r)"
  fi
  printf '%s' "$ddl" | bq_exec "recreate of routine $r"
  # The copy must carry the exact source body.
  [ "$(routine_body <<<"$src_json")" = "$(bqv show --routine --format=prettyjson "$PROJECT:$r" | routine_body)" ] \
    || die "routine $PROJECT.$r body differs from $SOURCE_PROJECT.$r"
done

# --- 4. IAM for catalog-worker@ (this project only) --------------------------------------------
PROJECT_POLICY=""
load_project_policy() {
  PROJECT_POLICY=$(gcv projects get-iam-policy "$PROJECT" --flatten='bindings[].members' \
    --format='csv[no-heading](bindings.role,bindings.members)')
}

project_binding() { # member role
  local member="$1" role="$2"
  [ -n "$PROJECT_POLICY" ] || load_project_policy
  if grep -qxF "$role,$member" <<<"$PROJECT_POLICY"; then
    skip "project binding $role -> $member"
  else
    create "project binding $role -> $member"
    retry gcloud projects add-iam-policy-binding "$PROJECT" --member="$member" \
      --role="$role" --condition=None >/dev/null
    load_project_policy
  fi
}
# The worker's query jobs run in this project (BQ_PROJECT=image-links-agent).
project_binding "serviceAccount:$WORKER" roles/bigquery.jobUser

# Dataset access: dataViewer appears as READER in the dataset's access list. Granted with the GRANT
# DCL statement ('bq add-iam-policy-binding' does not support datasets).
dataset_has_reader() { # dataset
  bqv show --format=prettyjson "$PROJECT:$1" 2>/dev/null | node -e '
    const ds = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const email = process.argv[1];
    const hit = (ds.access || []).some((a) =>
      (a.role === "READER" || a.role === "roles/bigquery.dataViewer") &&
      (a.userByEmail === email || a.iamMember === "serviceAccount:" + email));
    process.exit(hit ? 0 : 1);
  ' "$WORKER"
}
for ds in "${MIRROR_DATASETS[@]}"; do
  if dataset_has_reader "$ds"; then
    skip "dataset access $PROJECT:$ds: roles/bigquery.dataViewer -> serviceAccount:$WORKER"
  else
    create "dataset access $PROJECT:$ds: roles/bigquery.dataViewer -> serviceAccount:$WORKER"
    printf 'GRANT `roles/bigquery.dataViewer` ON SCHEMA `%s`.%s TO "serviceAccount:%s"' "$PROJECT" "$ds" "$WORKER" \
      | bq_exec "dataset grant on $ds"
  fi
done

# --- 5. Row counts: source vs copy ----------------------------------------------------------------
MISMATCH=0
for t in "${MIRROR_TABLES[@]}"; do
  counts=$(printf 'SELECT (SELECT COUNT(*) FROM `%s.%s`) AS source_rows, (SELECT COUNT(*) FROM `%s.%s`) AS copy_rows' \
      "$SOURCE_PROJECT" "$t" "$PROJECT" "$t" | bq_sql --format=csv | tr -d '\r' | tail -1)
  src=${counts%%,*}
  dst=${counts##*,}
  [[ "$src" =~ ^[0-9]+$ && "$dst" =~ ^[0-9]+$ ]] || die "could not read row counts for $t (got '$counts')"
  if [ "$src" = "$dst" ]; then
    log "rows $t: source $src, copy $dst (match)"
  else
    warn "rows $t: source $src, copy $dst (MISMATCH)"
    MISMATCH=1
  fi
done
[ "$MISMATCH" = 0 ] || die "row counts differ between $SOURCE_PROJECT and the $PROJECT copy; re-run this script"

log "done. The worker reads the mirror while infra/deploy.sh sets BQ_PROJECT=$PROJECT."
