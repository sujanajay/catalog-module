# The Cloud Tasks queues of a stack and their slots (spec 16 3.2.3, spec 17 G4). Sourced by infra/deploy.sh after
# the shape (infra/lib/shape.sh: TASKS_, BULK_ and INGEST_MAX_DISPATCHES). Two steps, so a deploy never takes
# slots away from the live worker before the new worker is live (2026-10-28: a run that stopped at its first gate
# had already cut catalog-bulk from 36 to 1 and catalog-ingest from 4 to 2):
#   queues_create_missing  before the services: creates each queue the new revisions' env names that does not
#                          exist yet, at its shape slots. It never changes an existing queue.
#   queues_apply_shape     right after the worker gate passed (or found the worker already live): every queue of
#                          the stack to its shape slots and retry. When the new shape has fewer slots, the queue can
#                          send more than the smaller worker takes for the seconds between the traffic shift and
#                          this call; those tasks meet 429 and the queue's retry sends them again (G4 below).
# A bulk queue left from a bigger shape stays (it is never deleted) at 1 slot once BULK_MAX_DISPATCHES is 0: the env
# no longer names it, so it gets no new tasks, and a backlog in it drains slowly instead of flooding the worker.

# Spec 17 G4: a chunk queue (main and bulk) never drops a task on a burst of 429 or 503 (a worker with no free
# instance answers 429 before the app runs). It keeps retrying for 30 minutes, at most a minute apart
# (10, 20, 40, then every 60 s), whatever the attempt count; the handler is safe under repeats. The main queue also
# carries publish and finalize, and the bulk queue publish: both idempotent, so they get the same retry (a failure
# that repeats, such as finalize's exports mismatch, retries for the full 30 minutes). The ingest queue keeps its
# 5 attempts.
CHUNK_QUEUE_RETRY=(--max-attempts=-1 --max-retry-duration=1800s --min-backoff=10s --max-backoff=60s --max-doublings=3)
INGEST_QUEUE_RETRY=(--max-attempts=5 --min-backoff=10s)

# The queue names that exist in the region, one per line. gcloud 589 prints short names from list while older
# releases print the full projects/.../queues/<name>; keep basenames so both match (docs/solutions/gcloud-list-names.md).
QUEUES_EXISTING=""
queues_read_existing() {
  QUEUES_EXISTING=$(gcv tasks queues list --location="$REGION" --format='value(name)' | sed 's#.*/##')
}
queue_exists() { grep -qxF "$1" <<<"$QUEUES_EXISTING"; }

# The stack's queues as "<name> <slots> <chunk|ingest>" lines, from the shape. Needs queues_read_existing first.
queues_shape() {
  echo "$QUEUE $TASKS_MAX_DISPATCHES chunk"
  echo "$QUEUE-ingest $INGEST_MAX_DISPATCHES ingest"
  if [ "$BULK_MAX_DISPATCHES" -gt 0 ]; then echo "$BULK_QUEUE $BULK_MAX_DISPATCHES chunk"
  elif queue_exists "$BULK_QUEUE"; then echo "$BULK_QUEUE 1 chunk"
  fi
}

queue_call() {
  local verb=$1 name=$2 slots=$3 kind=$4
  local -a retry=("${CHUNK_QUEUE_RETRY[@]}")
  [ "$kind" = ingest ] && retry=("${INGEST_QUEUE_RETRY[@]}")
  gcloud tasks queues "$verb" "$name" --location="$REGION" --max-concurrent-dispatches="$slots" "${retry[@]}" >/dev/null
}

queues_create_missing() {
  local line name slots kind
  local -a plan
  queues_read_existing
  mapfile -t plan < <(queues_shape)
  for line in "${plan[@]}"; do
    read -r name slots kind <<<"$line"
    queue_exists "$name" && continue
    queue_call create "$name" "$slots" "$kind"
    echo "==> tasks queue $name: CREATE, max-concurrent-dispatches $slots"
  done
}

queues_apply_shape() {
  local line name slots kind
  local -a plan
  queues_read_existing
  mapfile -t plan < <(queues_shape)
  for line in "${plan[@]}"; do
    read -r name slots kind <<<"$line"
    queue_call update "$name" "$slots" "$kind"
    echo "==> tasks queue $name: max-concurrent-dispatches $slots"
  done
}
