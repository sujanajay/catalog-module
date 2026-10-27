#!/usr/bin/env bash
# Spec 16 3.2.5: change the machine size (tier) of the shared Cloud SQL instance ila-pg. Check-then-change and
# re-runnable: it prints the current tier and does nothing when it already matches SQL_TIER. A change restarts
# ila-pg for a few minutes, for the catalog and for the earlier ila apps that share it, so it refuses unless
# CONFIRM_RESTART=1 (run it in a quiet window: no operator request on catalog-web for 60 minutes, no batch
# processing). It runs only "gcloud sql instances patch ila-pg --tier=...": no other setting, never a delete.
#
# Usage (Git Bash, from the repo root):
#   bash infra/sql-tier.sh                                   # prints the tier; SKIP when it is db-custom-2-7680
#   CONFIRM_RESTART=1 bash infra/sql-tier.sh                 # changes it to db-custom-2-7680
#   CONFIRM_RESTART=1 SQL_TIER=db-f1-micro bash infra/sql-tier.sh   # rollback, only after DB_MAX_CONNECTIONS=25
#
# After a change, deploy with DB_MAX_CONNECTIONS at most the new tier's default (printed below); infra/deploy.sh
# refuses a budget the live tier does not allow.
set -euo pipefail

PROJECT=image-links-agent
# Pin this project for every gcloud call without touching global gcloud config.
export CLOUDSDK_CORE_PROJECT=$PROJECT
cd "$(dirname "$0")/.."
# shellcheck source=lib/shape.sh
source infra/lib/shape.sh

gcv() { gcloud "$@" | tr -d '\r'; }

INSTANCE=ila-pg
SQL_TIER=${SQL_TIER:-db-custom-2-7680}
if ! [[ "$SQL_TIER" =~ ^(db-f1-micro|db-g1-small|db-custom-[1-9][0-9]*-[1-9][0-9]*)$ ]]; then
  echo "ERROR: SQL_TIER must be db-f1-micro, db-g1-small or db-custom-<vCPU>-<MiB>, got '$SQL_TIER'" >&2
  exit 1
fi

CURRENT=$(gcv sql instances describe "$INSTANCE" --format='value(settings.tier)')
[ -n "$CURRENT" ] || { echo "ERROR: cannot read the tier of $INSTANCE" >&2; exit 1; }
echo "==> $INSTANCE tier: $CURRENT (default max_connections $(tier_max_connections "$CURRENT" || true))"

if [ "$CURRENT" = "$SQL_TIER" ]; then
  echo "==> sql tier: SKIP ($INSTANCE is already $SQL_TIER)"
  exit 0
fi

if [ "${CONFIRM_RESTART:-0}" != 1 ]; then
  echo "ERROR: changing $INSTANCE from $CURRENT to $SQL_TIER restarts it for a few minutes (the catalog and the earlier ila apps). Re-run in a quiet window with CONFIRM_RESTART=1." >&2
  exit 1
fi

echo "==> sql tier: PATCH $CURRENT -> $SQL_TIER (restarts $INSTANCE)"
gcloud sql instances patch "$INSTANCE" --tier="$SQL_TIER" --quiet
AFTER=$(gcv sql instances describe "$INSTANCE" --format='value(settings.tier)')
if [ "$AFTER" != "$SQL_TIER" ]; then
  echo "ERROR: $INSTANCE reports tier '$AFTER' after the patch, expected $SQL_TIER" >&2
  exit 1
fi
echo "==> $INSTANCE tier: $AFTER (default max_connections $(tier_max_connections "$AFTER" || true)); deploy with DB_MAX_CONNECTIONS up to that"
