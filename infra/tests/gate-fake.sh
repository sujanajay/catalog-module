# Test double for infra/tests/gate.test.mjs (sourced before infra/lib/gate.sh). No GCP call.
# Fake gcloud: logs every call (one line each) to $LOG and answers from the scenario variables:
#   EXISTS=0 the service is not found; DESCRIBE_ERROR=1 describe fails with another error;
#   DEPLOY_ERROR=<text> the deploy fails with that text; LIVE_MATCH=1 the live revision has this image and env;
#   LIVE_FP=<hash> the live DEPLOY_ARGS_SHA (other flags at the last deploy; default: the current flags);
#   LIVE_DIGEST=<digest> the live revision's image digest (default $DIGEST, the image being deployed);
#   SHIFT_ERROR=1 update-traffic --to-revisions fails; ROLLBACK_TAGGED=1 $NEW is live and $OLD carries the previous tag;
#   WARN_ON_STDERR=1 describe also prints a warning on stderr (which must never reach the parsed JSON);
#   MEASURE_LIVE=1 $OLD also carries the tag measure-4c-4t-1r (a spec 18 ladder rung).
# After "run deploy" ($STATE/deployed) the description lists the candidate tag ($CAND_TAG) on the new revision.
gate_gcloud() {
  printf '%s\n' "$*" >> "$LOG"
  local measure=""
  if [ "${MEASURE_LIVE:-0}" = 1 ]; then measure=',{"revisionName":"'"$OLD"'","percent":0,"tag":"measure-4c-4t-1r","url":"https://measure-4c-4t-1r---test-svc-abc-el.a.run.app"}'; fi
  case "$1 $2 $3" in
    "run services describe")
      if [ "${WARN_ON_STDERR:-0}" = 1 ]; then echo "WARNING: an update to the Google Cloud CLI is available" >&2; fi
      if [ "${DESCRIBE_ERROR:-0}" = 1 ]; then echo "ERROR: PERMISSION_DENIED mocked" >&2; return 1; fi
      if [ -f "$STATE/deployed" ]; then
        printf '%s\r\n' '{"status":{"url":"'"$URL"'","traffic":[{"revisionName":"'"$OLD"'","percent":100},{"revisionName":"'"$NEW"'","percent":0,"tag":"'"${CAND_TAG:-candidate}"'","url":"'"$TAG_URL"'"}'"$measure"']}}'
      elif [ "${ROLLBACK_TAGGED:-0}" = 1 ]; then
        printf '%s\r\n' '{"status":{"url":"'"$URL"'","traffic":[{"revisionName":"'"$NEW"'","percent":100,"tag":"candidate"},{"revisionName":"'"$OLD"'","percent":0,"tag":"previous"}'"$measure"']}}'
      elif [ "${EXISTS:-1}" = 1 ]; then
        printf '%s\r\n' '{"status":{"url":"'"$URL"'","traffic":[{"revisionName":"'"$OLD"'","percent":100}'"$measure"']}}'
      else
        echo "ERROR: (gcloud.run.services.describe) Cannot find service [$4]" >&2; return 1
      fi ;;
    "artifacts docker images") printf '%s\r\n' "$DIGEST" ;;
    "run revisions describe")
      local env='[{"name":"OTHER","value":"x"}]'
      if [ "${LIVE_MATCH:-0}" = 1 ]; then
        env=$(node -e 'console.log(JSON.stringify(process.argv[1].split(",").map((p) => ({name: p.split("=")[0], value: p.slice(p.indexOf("=") + 1)})).concat([{name: "DB_PASSWORD", valueFrom: {secretKeyRef: {name: "s", key: "latest"}}}])))' "$SVC_ENV,DEPLOY_ARGS_SHA=${LIVE_FP:-$(gate_fingerprint)}")
      fi
      printf '%s\r\n' '{"spec":{"containers":[{"env":'"$env"'}]},"status":{"imageDigest":"asia-south1-docker.pkg.dev/p/apps/test@'"${LIVE_DIGEST:-$DIGEST}"'"}}' ;;
    "run services update-traffic")
      if [ "${SHIFT_ERROR:-0}" = 1 ] && [[ "$*" == *--to-revisions* ]]; then echo "ERROR: shift mocked" >&2; return 1; fi ;;
    "run deploy test-svc"|"run deploy catalog-matting"|"run deploy catalog-matting-gpu"|"run deploy catalog-upscale")
      if [ -n "${DEPLOY_ERROR:-}" ]; then echo "$DEPLOY_ERROR" >&2; return 1; fi
      touch "$STATE/deployed" ;;
    *) ;;
  esac
}

# One extra registry entry, as a new service would add it: one function and one probe ($PROBE).
service_test_svc() {
  SVC_NAME=test-svc; SVC_REGION=asia-south1; SVC_IMAGE=asia-south1-docker.pkg.dev/p/apps/test:abc1234
  SVC_ARGS=(--service-account=sa@p.iam.gserviceaccount.com --cpu=1 --labels=app=catalog)
  SVC_ENV="A=1,B=two"
  SVC_PROBE=(bash -c "$PROBE" probe)
  SVC_PROBE_TIMEOUT=${PROBE_TIMEOUT:-30}
  SVC_DEPLOY=1; SVC_SHIFT=${SHIFT:-1}; SVC_QUOTA_OPTIONAL=${QUOTA_OPTIONAL:-0}
  if [ -n "${CAND_TAG:-}" ]; then SVC_TAG=$CAND_TAG; fi
}
