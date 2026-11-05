# M6-F2-R7 (M6-S5): which images a deploy builds, and with which Cloud Build config. Sourced by infra/deploy.sh.
#
# The worker and web images are tagged with the deployed commit (TAG). The matting images (matting, matting-gpu: the
# services catalog-matting, catalog-upscale, catalog-upscale-gpu and catalog-matting-gpu) are tagged with MATTING_TAG,
# the last commit that changed their source: services/matting (their whole build context, Dockerfile included) or
# cloudbuild.yaml (their build steps). A commit that leaves both alone therefore reuses the very same images, so the
# four matting services keep their image digest, the gate finds each live revision unchanged (SKIP, no probe), and
# the build makes only the worker and web images (about 3 minutes instead of about 17; Cloud Build history
# 2026-10-28 to 2026-11-05). Before this, every commit rebuilt them (the image carries GIT_SHA), so every deploy
# re-ran every matting probe, about 54 minutes on 2026-11-03.
#
# build_plan sets:
#   BUILD_NEEDED         1 when an image is missing from Artifact Registry
#   BUILD_CONFIG         cloudbuild.yaml (all four images) when a matting image is missing, else
#                        infra/cloudbuild-preview.yaml (worker and web only)
#   BUILD_SUBSTITUTIONS  the --substitutions value; _MATTING_TAG only for cloudbuild.yaml (Cloud Build refuses a
#                        substitution the config does not use, and one it uses but is not given)
# Every gcloud call goes through build_gcloud; tests define their own before sourcing this file.

declare -F build_gcloud >/dev/null || build_gcloud() { gcloud "$@"; }

BUILD_FULL_CONFIG=cloudbuild.yaml
BUILD_APP_CONFIG=infra/cloudbuild-preview.yaml
# The paths whose last change names the matting images.
MATTING_SOURCE_PATHS=(services/matting cloudbuild.yaml)

# matting_source_tag: the short id of the last commit that changed MATTING_SOURCE_PATHS. When the source at HEAD is
# not exactly that commit's (possible only through a merge), the HEAD tag, so an image is never reused for other source.
matting_source_tag() {
  local commit path
  commit=$(git log -1 --format=%H -- "${MATTING_SOURCE_PATHS[@]}") || return 1
  if [ -z "$commit" ]; then git rev-parse --short HEAD; return; fi
  for path in "${MATTING_SOURCE_PATHS[@]}"; do
    if [ "$(git rev-parse "HEAD:$path" 2>/dev/null)" != "$(git rev-parse "$commit:$path" 2>/dev/null)" ]; then
      git rev-parse --short HEAD
      return
    fi
  done
  git rev-parse --short "$commit"
}

# build_image_missing <image ref>: 0 when it is not in Artifact Registry, 1 when it is; 2 when the check itself failed
# (the error is printed), so a gcloud hiccup never turns into a paid build or a deploy of a missing image.
build_image_missing() {
  local out
  if out=$(build_gcloud artifacts docker images describe "$1" 2>&1); then return 1; fi
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

# The build command for this plan, as deploy.sh runs it (also for a by-hand build from an uploaded source tarball:
# replace the final "." with the gs:// tarball).
build_command() { printf 'gcloud builds submit --config %s --substitutions=%s .' "$BUILD_CONFIG" "$BUILD_SUBSTITUTIONS"; }
