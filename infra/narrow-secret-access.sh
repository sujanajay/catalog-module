#!/usr/bin/env bash
# Narrow Secret Manager access for catalog-web and catalog-worker (owner approved 2026-11-04, "Yes, narrow it").
#
# Both service accounts held roles/secretmanager.secretAccessor at project level, so they could read every secret in
# image-links-agent (other apps' secrets too). This script gives each one secretAccessor on exactly the secrets it needs,
# checks every one of those per-secret bindings, and only then removes the two accounts from the project-level binding.
#
#   bash infra/narrow-secret-access.sh --dry-run   read only: prints the plan, changes nothing
#   bash infra/narrow-secret-access.sh             applies the plan (runs with a deploy approval, never by itself)
#
# What "needed" means, per account:
#   - every pair in infra/secret-access.manifest (the same list infra/bootstrap.sh binds and infra/deploy.sh checks its
#     mounts against; "optional" pairs such as the Supabase ones are bound once the secret exists), plus
#   - every secret that a Cloud Run service or job running as that account mounts today (env or volume), read from the
#     live definitions in every region (region-less list). The jobs that run as catalog-worker (migrate, eval, qa-check,
#     load, recheck, invariants, test jobs) are found this way, and so is any service of another name that uses these
#     accounts. Only each resource's current template is read; the tagged rollback revisions mounted the same secrets
#     on 2026-11-04 (review), so check them by hand if a rollback revision ever mounts something extra.
# The project-level removal is refused (exit 1) when any needed binding is missing or cannot be checked, when a needed
# secret does not exist, or when a definition cannot be read. Other principals' bindings (ila-web, ila-worker and the
# rest) are never touched; the script only names them. Secret values are never read: only names and IAM policies.
# Idempotent: a second run finds every binding in place and no project-level binding left, and changes nothing.
#
# Rollback (an instance start or job run fails with "Permission denied on secret" after this ran): give the account
# its project-level grant back; the per-secret bindings can stay. One line per account:
#   gcloud projects add-iam-policy-binding image-links-agent --member=serviceAccount:catalog-web@image-links-agent.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor --condition=None
#   gcloud projects add-iam-policy-binding image-links-agent --member=serviceAccount:catalog-worker@image-links-agent.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor --condition=None
# Then add the missing pair to infra/secret-access.manifest, run infra/bootstrap.sh, and run this script again.
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT=image-links-agent
export CLOUDSDK_CORE_PROJECT=$PROJECT
ROLE=roles/secretmanager.secretAccessor
WEB_SA=catalog-web@$PROJECT.iam.gserviceaccount.com
WORKER_SA=catalog-worker@$PROJECT.iam.gserviceaccount.com
# Seconds to wait after adding per-secret bindings before the project binding goes. Google documents IAM propagation
# as typically about 2 minutes, sometimes 7 or more; a cold start in that gap would fail, so run it at a quiet time.
NARROW_PROPAGATION_S=${NARROW_PROPAGATION_S:-180}
# shellcheck source=lib/secret-manifest.sh
source infra/lib/secret-manifest.sh

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,29p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg (use --dry-run or nothing)" >&2; exit 2 ;;
  esac
done

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
BLOCKED=0
block() { echo "BLOCKED: $*" >&2; BLOCKED=1; }
say() { echo "$*"; }
[ "$DRY_RUN" = 1 ] && say "==> dry run: read only, nothing is changed" || say "==> applying"

# --- 1. what the services and jobs mount ---------------------------------------------------------------------------
# Prints "<account> <secret> <kind>/<region>/<name>" for every secret a resource running as one of our accounts mounts,
# a NOTE line for a resource of another name that runs as one of them, and a CROSS line for a secret in another project
# (a full projects/<p>/secrets/<name> reference, which this script cannot bind).
mounts_of() { # kind < list json (every region)
  node -e '
    const [kind, project, ...accounts] = process.argv.slice(1);
    const items = JSON.parse(require("fs").readFileSync(0, "utf8") || "[]");
    for (const it of items) {
      const spec = kind === "service" ? it.spec?.template?.spec : it.spec?.template?.spec?.template?.spec;
      const name = it.metadata?.name ?? "?";
      const region = it.metadata?.labels?.["cloud.googleapis.com/location"] ?? "?";
      const sa = spec?.serviceAccountName ?? "";
      if (!accounts.includes(sa)) continue;
      if (!name.startsWith("catalog-")) console.log(`NOTE ${sa} ${kind}/${region}/${name}`);
      const secrets = new Set();
      for (const c of spec.containers ?? []) for (const e of c.env ?? []) if (e.valueFrom?.secretKeyRef?.name) secrets.add(e.valueFrom.secretKeyRef.name);
      for (const v of spec.volumes ?? []) if (v.secret?.secretName) secrets.add(v.secret.secretName);
      for (const s of secrets) {
        const m = /^projects\/([^/]+)\/secrets\/([^/]+)/.exec(s);
        if (m && m[1] !== project) console.log(`CROSS ${sa} ${s} ${kind}/${region}/${name}`);
        else console.log(`${sa} ${m ? m[2] : s} ${kind}/${region}/${name}`);
      }
    }' "$1" "$PROJECT" "$WEB_SA" "$WORKER_SA"
}

: > "$TMP/mounted"
for kind in service job; do
  noun=services; [ "$kind" = job ] && noun=jobs
  # No --region: the list covers every region, so a service or job in a region nobody named is not missed.
  if ! gcloud run "$noun" list --format=json > "$TMP/list.json" 2> "$TMP/err"; then
    block "cannot read the Cloud Run $noun ($(head -c 200 "$TMP/err" | tr '\n' ' '))"
    continue
  fi
  mounts_of "$kind" < "$TMP/list.json" >> "$TMP/mounted" || block "cannot parse the Cloud Run $noun"
done
grep '^NOTE ' "$TMP/mounted" | while read -r _ sa where; do say "note: $where runs as $sa (not a catalog-* name); its secrets are kept"; done || true
grep '^CROSS ' "$TMP/mounted" > "$TMP/cross" || true
while read -r _ sa ref where; do
  block "$where (as $sa) mounts $ref from another project; grant it there by hand, then run this again"
done < "$TMP/cross"
grep -v -e '^NOTE ' -e '^CROSS ' "$TMP/mounted" > "$TMP/mounts" || true

say ""
say "==> secrets mounted today, by account"
for sa in "$WEB_SA" "$WORKER_SA"; do
  list=$(awk -v sa="$sa" '$1 == sa { print $2 " (" $3 ")" }' "$TMP/mounts" | sort)
  say "$sa:"
  if [ -n "$list" ]; then printf '%s\n' "$list" | sed 's/^/  /'; else say "  (none found)"; fi
done

# --- 2. the needed pairs --------------------------------------------------------------------------------------------
: > "$TMP/pairs" # "<account> <secret> required|optional"
secret_manifest_pairs >> "$TMP/pairs" || block "infra/secret-access.manifest is malformed"
awk '{ print $1, $2, "required" }' "$TMP/mounts" >> "$TMP/pairs"
# One line per pair; "required" wins over "optional" (a mounted optional secret is required).
sort -k1,1 -k2,2 -k3,3r "$TMP/pairs" | awk '!seen[$1 FS $2]++' > "$TMP/needed"

# has_binding <secret> <account>: 0 when the secret's policy grants ROLE to the account with no condition; 1 when not;
# 2 when the policy cannot be read.
has_binding() {
  gcloud secrets get-iam-policy "$1" --format=json > "$TMP/policy.json" 2> /dev/null || return 2
  node -e '
    const [role, member] = process.argv.slice(1);
    const p = JSON.parse(require("fs").readFileSync(0, "utf8") || "{}");
    process.exit((p.bindings ?? []).some(b => b.role === role && !b.condition && (b.members ?? []).includes(member)) ? 0 : 1);
  ' "$ROLE" "serviceAccount:$2" < "$TMP/policy.json"
}
# secret_exists <secret>: 0 when it exists, 1 when Secret Manager answers NOT_FOUND, 2 when the check itself fails (then
# even an optional secret blocks: a passing error must not look like "nothing to bind").
secret_exists() {
  gcloud secrets describe "$1" --format='value(name)' > /dev/null 2> "$TMP/describe-err" && return 0
  grep -q 'NOT_FOUND' "$TMP/describe-err" && return 1
  return 2
}

say ""
say "==> per-secret bindings ($ROLE)"
: > "$TMP/to-add"
: > "$TMP/to-check"
while read -r sa secret need; do
  set +e; secret_exists "$secret"; rc=$?; set -e
  if [ "$rc" = 2 ]; then block "cannot check whether $secret exists ($(head -c 200 "$TMP/describe-err" | tr '\n' ' '))"; continue; fi
  if [ "$rc" = 1 ]; then
    if [ "$need" = optional ]; then say "skip: $secret does not exist yet (nothing mounts it), no binding for $sa"; continue; fi
    block "$secret is needed by $sa but does not exist"; continue
  fi
  echo "$sa $secret" >> "$TMP/to-check"
  set +e; has_binding "$secret" "$sa"; rc=$?; set -e
  case $rc in
    0) say "ok: $secret -> $sa (already bound)" ;;
    1) say "$([ "$DRY_RUN" = 1 ] && echo "would add" || echo "add"): $secret -> $sa"; echo "$sa $secret" >> "$TMP/to-add" ;;
    *) block "cannot read the IAM policy of $secret" ;;
  esac
done < "$TMP/needed"

if [ "$DRY_RUN" = 0 ] && [ "$BLOCKED" = 0 ]; then
  while read -r sa secret; do
    gcloud secrets add-iam-policy-binding "$secret" --member="serviceAccount:$sa" --role="$ROLE" --condition=None --quiet > /dev/null \
      || block "could not add $ROLE on $secret for $sa"
  done < "$TMP/to-add"
  # Verify every needed binding from a fresh read before anything is removed.
  while read -r sa secret; do
    set +e; has_binding "$secret" "$sa"; rc=$?; set -e
    if [ "$rc" = 0 ]; then say "verified: $secret -> $sa"; else block "binding $secret -> $sa is not in place after adding it"; fi
  done < "$TMP/to-check"
  if [ "$BLOCKED" = 0 ] && [ -s "$TMP/to-add" ] && [ "$NARROW_PROPAGATION_S" -gt 0 ]; then
    say "waiting ${NARROW_PROPAGATION_S}s for the new bindings to take effect"; sleep "$NARROW_PROPAGATION_S"
  fi
fi

# --- 3. the project-level binding -----------------------------------------------------------------------------------
# Prints "<account> unconditional|conditional" for each of our accounts the project policy grants ROLE, then
# "OTHER <member>" for every other member of an unconditional ROLE binding (named, never touched).
project_grants() {
  node -e '
    const [role, ...accounts] = process.argv.slice(1);
    const p = JSON.parse(require("fs").readFileSync(0, "utf8") || "{}");
    const others = new Set();
    for (const b of p.bindings ?? []) {
      if (b.role !== role) continue;
      for (const m of b.members ?? []) {
        const sa = m.replace(/^serviceAccount:/, "");
        if (m.startsWith("serviceAccount:") && accounts.includes(sa)) console.log(`${sa} ${b.condition ? "conditional" : "unconditional"}`);
        else if (!b.condition) others.add(m);
      }
    }
    for (const m of others) console.log(`OTHER ${m}`);
  ' "$ROLE" "$WEB_SA" "$WORKER_SA"
}
read_project_grants() {
  gcloud projects get-iam-policy "$PROJECT" --format=json > "$TMP/project.json" 2> /dev/null || return 1
  project_grants < "$TMP/project.json"
}

say ""
say "==> project-level $ROLE"
if ! read_project_grants > "$TMP/grants"; then block "cannot read the project IAM policy"; : > "$TMP/grants"; fi
grep '^OTHER ' "$TMP/grants" | while read -r _ m; do say "left alone: $m"; done || true
grep -v '^OTHER ' "$TMP/grants" > "$TMP/ours" || true
if grep -q ' conditional$' "$TMP/ours"; then
  grep ' conditional$' "$TMP/ours" | while read -r sa _; do say "left alone: a conditional project binding for $sa (review it by hand)"; done
fi
grep ' unconditional$' "$TMP/ours" | awk '{ print $1 }' > "$TMP/to-remove" || true
if [ ! -s "$TMP/to-remove" ]; then say "nothing to remove: neither account holds it unconditionally"; fi

if [ "$BLOCKED" = 1 ]; then
  while read -r sa; do say "refused: remove $sa (a needed per-secret binding is missing or unchecked, see BLOCKED above)"; done < "$TMP/to-remove"
  exit 1
fi
if [ "$DRY_RUN" = 1 ]; then
  while read -r sa; do say "would remove: $sa (after the per-secret bindings above are added and verified)"; done < "$TMP/to-remove"
  say ""
  say "==> dry run done: $(wc -l < "$TMP/to-add" | tr -d ' ') binding(s) to add, $(wc -l < "$TMP/to-remove" | tr -d ' ') project grant(s) to remove"
  exit 0
fi
while read -r sa; do
  gcloud projects remove-iam-policy-binding "$PROJECT" --member="serviceAccount:$sa" --role="$ROLE" --condition=None --quiet > /dev/null
  say "removed: $sa from the project-level $ROLE"
done < "$TMP/to-remove"
# Final check: neither account holds it unconditionally at project level, and every per-secret binding is still there.
read_project_grants > "$TMP/grants" || { echo "cannot re-read the project IAM policy" >&2; exit 1; }
if grep -q ' unconditional$' "$TMP/grants"; then echo "a project-level grant is still there: $(grep ' unconditional$' "$TMP/grants" | tr '\n' ' ')" >&2; exit 1; fi
while read -r sa secret; do has_binding "$secret" "$sa" || { echo "binding $secret -> $sa is missing after the removal" >&2; exit 1; }; done < "$TMP/to-check"
say ""
say "==> done: $(wc -l < "$TMP/to-add" | tr -d ' ') binding(s) added, $(wc -l < "$TMP/to-remove" | tr -d ' ') project grant(s) removed"
