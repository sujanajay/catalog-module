# M6-F2-R7 (M6-S5): which images a deploy builds, and with which Cloud Build config. Sourced by infra/deploy.sh; also
# run by cloudbuild.yaml as `bash infra/lib/build.sh verify-matting-source <tag>` (below).
#
# The worker and web images are tagged with the deployed commit (TAG). The matting images (matting, matting-gpu: the
# services catalog-matting, catalog-upscale, catalog-upscale-gpu and catalog-matting-gpu) are tagged with MATTING_TAG,
# a hash of their source: every file of services/matting (their whole build context, Dockerfile included) and
# cloudbuild.yaml (their build steps). A commit that leaves both alone therefore reuses the very same images, so the
# four matting services keep their image digest, the gate finds each live revision unchanged (SKIP, no probe), and
# the build makes only the worker and web images (about 3 minutes instead of about 17; Cloud Build history
# 2026-10-28 to 2026-11-05). Before this, every commit rebuilt them (the image carries GIT_SHA), so every deploy
# re-ran every matting probe, about 54 minutes on 2026-11-03.
#
# The tag names content, and the build proves it: cloudbuild.yaml's first step hashes the source it was actually given
# (the upload, or a hand-made tarball) and fails the whole build, before any image is pushed, unless that hash is the
# tag. So an image tagged MATTING_TAG is always built from exactly that source, and a build from a wrong or dirty copy
# can never be reused by later deploys (2026-11-05 review P2-3).
#
# The hash: one "<path> <git blob sha1>" line per file (paths from the repo root), sorted bytewise, then the first 12
# hex digits of the sha256 of those lines. Locally it comes from the committed tree (git ls-tree HEAD; deploy.sh
# refuses a dirty tree), in Cloud Build from the files on disk, computed the way git hashes a blob. 12 hex digits, so
# the tag also passes infra/check-matting.sh's version check.
#
# build_plan sets:
#   BUILD_NEEDED         1 when an image is missing from Artifact Registry
#   BUILD_CONFIG         cloudbuild.yaml (all four images) when a matting image is missing, else
#                        infra/cloudbuild-preview.yaml (worker and web only)
#   BUILD_SUBSTITUTIONS  the --substitutions value; _MATTING_TAG only for cloudbuild.yaml (Cloud Build refuses a
#                        substitution the config does not use, and one it uses but is not given)
# Every gcloud call goes through build_gcloud; tests define their own before sourcing this file.

declare -F build_gcloud >/dev/null || build_gcloud() { gcloud "$@"; }
# shellcheck source=gcloud-retry.sh
source "$(dirname "${BASH_SOURCE[0]}")/gcloud-retry.sh"

BUILD_FULL_CONFIG=cloudbuild.yaml
BUILD_APP_CONFIG=infra/cloudbuild-preview.yaml
# The source the matting images are built from (and named by).
MATTING_SOURCE_PATHS=(services/matting cloudbuild.yaml)
# Where a hand-built source tarball goes (the Cloud Build source bucket).
BUILD_SOURCE_BUCKET=${BUILD_SOURCE_BUCKET:-gs://image-links-agent_cloudbuild/source}

matting_source_digest() { LC_ALL=C sort | sha256sum | cut -c1-12; }

# matting_source_tag: the hash of MATTING_SOURCE_PATHS in the committed tree (HEAD).
matting_source_tag() {
  local listing
  listing=$(git ls-tree -r HEAD -- "${MATTING_SOURCE_PATHS[@]}") || return 1
  [ -n "$listing" ] || { echo "ERROR: no matting source in HEAD" >&2; return 1; }
  # "<mode> <type> <sha>\t<path>" -> "<path> <sha>"
  awk -F'\t' '{ split($1, a, " "); print $2 " " a[3] }' <<<"$listing" | matting_source_digest
}

# matting_source_tag_of_files [dir]: the same hash from the files on disk under dir (default .), as Cloud Build sees them.
matting_source_tag_of_files() {
  local dir=${1:-.} path file size sha
  (
    cd "$dir" || exit 1
    for path in "${MATTING_SOURCE_PATHS[@]}"; do
      [ -e "$path" ] || { echo "ERROR: $path is missing from the build source" >&2; exit 1; }
      if [ -d "$path" ]; then find "$path" -type f -print0; else printf '%s\0' "$path"; fi
    done | while IFS= read -r -d '' file; do
      size=$(wc -c <"$file" | tr -d ' ')
      sha=$({ printf 'blob %s\0' "$size"; cat "$file"; } | sha1sum | cut -d' ' -f1)
      printf '%s %s\n' "$file" "$sha"
    done | matting_source_digest
  )
}

# build_image_missing <image ref>: 0 when it is not in Artifact Registry, 1 when it is; 2 when the check itself failed
# (the error is printed), so a gcloud hiccup never turns into a paid build or a deploy of a missing image.
build_image_missing() {
  local out
  # A network blip is retried (2026-11-05 stop #15: one DNS miss here ended a deploy); NOT_FOUND is an answer.
  if out=$(gcloud_retry build_gcloud artifacts docker images describe "$1" 2>&1); then return 1; fi
  if grep -qiE 'NOT_FOUND|not found|does not exist' <<<"$out"; then return 0; fi
  printf '%s\n' "$out" >&2
  return 2
}

# build_plan <AR> <TAG> <MATTING_TAG> <images...>: images are worker, web, matting, matting-gpu (the ones this run
# deploys). Returns 1 when an image could not be checked.
build_plan() {
  local ar=$1 tag=$2 matting_tag=$3 image ref status
  shift 3
  BUILD_NEEDED=0; BUILD_CONFIG=$BUILD_APP_CONFIG; BUILD_SUBSTITUTIONS=""
  for image in "$@"; do
    case "$image" in matting|matting-gpu) ref=$ar/$image:$matting_tag ;; *) ref=$ar/$image:$tag ;; esac
    status=0; build_image_missing "$ref" || status=$?
    case "$status" in
      0) BUILD_NEEDED=1; case "$image" in matting|matting-gpu) BUILD_CONFIG=$BUILD_FULL_CONFIG ;; esac ;;
      1) ;;
      *) echo "ERROR: cannot check existing images; stopping before a paid build" >&2; return 1 ;;
    esac
  done
  BUILD_SUBSTITUTIONS="_AR=$ar,_TAG=$tag"
  if [ "$BUILD_CONFIG" = "$BUILD_FULL_CONFIG" ]; then BUILD_SUBSTITUTIONS+=",_MATTING_TAG=$matting_tag"; fi
}

# The build command for this plan, as deploy.sh runs it (source: the current directory).
build_command() { printf 'gcloud builds submit --config %s --substitutions=%s .' "$BUILD_CONFIG" "$BUILD_SUBSTITUTIONS"; }

# build_tarball_commands <TAG>: the by-hand build from an uploaded tarball (gcloud builds submit . hangs on upload from
# the owner's laptop). The tarball is git archive of HEAD, never a copy of the working folder, so it holds exactly the
# committed source; Cloud Build still checks the matting source against _MATTING_TAG.
build_tarball_commands() {
  local tgz="catalog-src-$1.tgz"
  printf '%s\n' "git archive --format=tar.gz -o \"\$TEMP/$tgz\" HEAD" \
    "gcloud storage cp \"\$TEMP/$tgz\" $BUILD_SOURCE_BUCKET/$tgz" \
    "gcloud builds submit $BUILD_SOURCE_BUCKET/$tgz --config $BUILD_CONFIG --substitutions=$BUILD_SUBSTITUTIONS --async"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -euo pipefail
  case "${1:-}" in
    # cloudbuild.yaml's first step, in /workspace: the source given to this build must hash to the tag.
    verify-matting-source)
      want=${2:-}
      [[ "$want" =~ ^[0-9a-f]{12}$ ]] || { echo "ERROR: _MATTING_TAG must be the 12-digit source hash (bash infra/deploy.sh --build-command), got '$want'" >&2; exit 2; }
      got=$(matting_source_tag_of_files .)
      if [ "$got" != "$want" ]; then
        echo "ERROR: the matting source in this build hashes to $got, not _MATTING_TAG=$want: the source is not the committed tree the tag was computed from. Build from git archive HEAD of a clean checkout (bash infra/deploy.sh --build-command). No image was pushed." >&2
        exit 1
      fi
      echo "matting source $got matches _MATTING_TAG" ;;
    *) echo "usage: bash infra/lib/build.sh verify-matting-source <tag>" >&2; exit 2 ;;
  esac
fi
