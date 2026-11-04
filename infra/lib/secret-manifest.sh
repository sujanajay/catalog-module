#!/usr/bin/env bash
# Helpers for infra/secret-access.manifest (the one list of catalog service account and secret pairs). Source it; it
# needs PROJECT set. Secret values are never read here: only names.
SECRET_MANIFEST=${SECRET_MANIFEST:-"$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/secret-access.manifest"}

# secret_manifest_pairs: prints "<account email> <secret> <need>" per manifest line; exit 1 on a malformed line.
secret_manifest_pairs() {
  awk -v p="$PROJECT" '
    /^[[:space:]]*(#|$)/ { next }
    NF != 3 || ($1 != "web" && $1 != "worker") || ($3 != "required" && $3 != "optional") || $2 !~ /^[a-z0-9][a-z0-9_-]*$/ {
      printf "secret-access.manifest line %d is not \"<web|worker> <secret> <required|optional>\": %s\n", NR, $0 > "/dev/stderr"; bad = 1; next
    }
    { print "catalog-" $1 "@" p ".iam.gserviceaccount.com", $2, $3 }
    END { exit bad }' "$SECRET_MANIFEST"
}

# secret_manifest_check <web|worker> <--set-secrets list>: exit 1 naming every secret in the list (ENV=secret:version,...)
# that has no manifest line for that account. Without the line, no per-secret grant exists and Cloud Run refuses the
# revision ("Permission denied on secret").
secret_manifest_check() {
  local account="$1" list="$2" ref secret bad=0 pairs
  pairs=$(secret_manifest_pairs) || return 1
  IFS=, read -ra refs <<<"$list"
  for ref in "${refs[@]}"; do
    [ -n "$ref" ] || continue
    secret=${ref#*=}; secret=${secret%%:*}
    if ! awk -v a="catalog-$account@$PROJECT.iam.gserviceaccount.com" -v s="$secret" '$1 == a && $2 == s { f = 1 } END { exit !f }' <<<"$pairs"; then
      echo "secret $secret is mounted on catalog-$account but has no line in infra/secret-access.manifest; add \"$account $secret required\" and run infra/bootstrap.sh" >&2
      bad=1
    fi
  done
  return "$bad"
}
