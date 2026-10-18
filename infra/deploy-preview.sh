#!/usr/bin/env bash
# Protected review deployment from the unmerged 06 branch. Production services are not updated.
# Uses catalog-web-preview, catalog-worker-preview and catalog-preview, all with zero minimum instances.
set -euo pipefail
export CATALOG_PREVIEW=1
exec bash "$(dirname "$0")/deploy.sh"
