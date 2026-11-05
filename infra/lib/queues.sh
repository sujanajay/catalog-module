# The Cloud Tasks queues of a stack and their slots (spec 16 3.2.3, spec 17 G4). Sourced by infra/deploy.sh after
# the shape (infra/lib/shape.sh: TASKS_, BULK_, INGEST_ and, spec 18, ENLARGE_ and ENLARGE_BULK_MAX_DISPATCHES). Two steps, so a deploy never takes
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
# that repeats, such as finalize's exports mismatch, retries for the full 30 minutes).
CHUNK_QUEUE_RETRY=(--max-attempts=-1 --max-retry-duration=1800s --min-backoff=10s --max-backoff=60s --max-doublings=3)
# M6-F2-R4 (M6-S4): the ingest queue never drops a task because of a deploy or a burst of 429. Unlimited attempts and
# no time limit, 10 s to 15 minutes apart (10, 20, ..., 640, then 900 s); the handler alone decides when an upload is
# terminal: it counts failed deliveries on the upload row (catalog_uploads.ingest_failures, INGEST_MAX_FAILURES in
# apps/worker/src/catalog/ingest.ts) and answers 200 once it stopped the batch. The sweep re-sends an intake task when
# a batch has been ingesting with no progress for 30 minutes (INGEST_RESEND_MS).
INGEST_QUEUE_RETRY=(--max-attempts=-1 --max-retry-duration=0s --min-backoff=10s --max-backoff=900s --max-doublings=7)
# Spec 18 lifecycle 3.8: an enlarge lane never drops a task. The handler alone decides when a row is terminal (it
# counts attempts and timeouts on the row and answers 200 then), and a wait (service down or paused, a tile hand-off,
# a cold start) answers 503 without counting, for as long as it lasts. So unlimited attempts (-1, the API's
# "unlimited attempts"; the chunk queue uses the same form) and no time limit (0s, up to the task retention limit),
# 30 s to 900 s apart (30, 60, 120, 240, 480, then 900 s), paced by ENLARGE_DISPATCHES_PER_SECOND (the operator lane)
# or ENLARGE_BULK_DISPATCHES_PER_SECOND (the bulk lane) so a burst of new enlargements never meets a cold upscaler all
# at once. The sweep re-sends a lost task (ENLARGE_STALE_MS).
ENLARGE_QUEUE_RETRY=(--max-attempts=-1 --max-retry-duration=0s --min-backoff=30s --max-backoff=900s --max-doublings=5)

# The queue names that exist in the region, one per line. gcloud 589 prints short names from list while older
# releases print the full projects/.../queues/<name>; keep basenames so both match (docs/solutions/gcloud-list-names.md).
QUEUES_EXISTING=""
queues_read_existing() {
  QUEUES_EXISTING=$(gcv tasks queues list --location="$REGION" --format='value(name)' | sed 's#.*/##')
}
queue_exists() { grep -qxF "$1" <<<"$QUEUES_EXISTING"; }

# The stack's queues as "<name> <slots> <chunk|ingest|enlarge|enlarge-bulk>" lines, from the shape. Needs queues_read_existing
# first. A bulk queue or enlarge lane left from a bigger shape keeps 1 slot (never deleted, as above).
queues_shape() {
  echo "$QUEUE $TASKS_MAX_DISPATCHES chunk"
  echo "$QUEUE-ingest $INGEST_MAX_DISPATCHES ingest"
  if [ "$BULK_MAX_DISPATCHES" -gt 0 ]; then echo "$BULK_QUEUE $BULK_MAX_DISPATCHES chunk"
  elif queue_exists "$BULK_QUEUE"; then echo "$BULK_QUEUE 1 chunk"
  fi
  if [ "$ENLARGE_MAX_DISPATCHES" -gt 0 ]; then echo "$QUEUE-enlarge $ENLARGE_MAX_DISPATCHES enlarge"
  elif queue_exists "$QUEUE-enlarge"; then echo "$QUEUE-enlarge 1 enlarge"
  fi
  if [ "$ENLARGE_BULK_MAX_DISPATCHES" -gt 0 ]; then echo "$QUEUE-enlarge-bulk $ENLARGE_BULK_MAX_DISPATCHES enlarge-bulk"
  elif queue_exists "$QUEUE-enlarge-bulk"; then echo "$QUEUE-enlarge-bulk 1 enlarge-bulk"
  fi
}

queue_call() {
  local verb=$1 name=$2 slots=$3 kind=$4
  local -a retry=("${CHUNK_QUEUE_RETRY[@]}")
  [ "$kind" = ingest ] && retry=("${INGEST_QUEUE_RETRY[@]}")
  [ "$kind" = enlarge ] && retry=(--max-dispatches-per-second="$ENLARGE_DISPATCHES_PER_SECOND" "${ENLARGE_QUEUE_RETRY[@]}")
  [ "$kind" = enlarge-bulk ] && retry=(--max-dispatches-per-second="$ENLARGE_BULK_DISPATCHES_PER_SECOND" "${ENLARGE_QUEUE_RETRY[@]}")
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

# M6-F2-R11 (M6-S5): a deploy never lowers the worker's max instances or a queue's slots under batches in flight. Run
# right before the worker gate (which applies the worker's max at its traffic shift; queues_apply_shape follows it):
# when the new shape is lower than the live one somewhere, it waits until no queue of the stack holds a task (no batch
# in flight), checking every SHAPE_LOWER_POLL_S seconds, for at most SHAPE_LOWER_WAIT_S (default 1800, 30 minutes);
# then it applies the lower shape with a warning. Equal or higher shapes never wait. A queue that cannot be read counts
# as busy, so a gcloud hiccup only makes the deploy wait. Needs WORKER_SERVICE and WORKER_MAX_INSTANCES (deploy.sh).
SHAPE_LOWER_WAIT_S=${SHAPE_LOWER_WAIT_S:-1800}
SHAPE_LOWER_POLL_S=${SHAPE_LOWER_POLL_S:-60}

# What the new shape lowers, one "<what> <live> -> <new>" line each; nothing when nothing is lowered.
queues_lowering() {
  local live line name slots kind live_slots worker_live
  local -a plan
  queues_read_existing
  live=$(gcv tasks queues list --location="$REGION" --format='value(name.basename(),rateLimits.maxConcurrentDispatches)') || live=""
  mapfile -t plan < <(queues_shape)
  for line in "${plan[@]}"; do
    read -r name slots kind <<<"$line"
    live_slots=$(awk -v q="$name" '$1 == q { print $2 }' <<<"$live")
    if [[ "$live_slots" =~ ^[0-9]+$ ]] && [ "$slots" -lt "$live_slots" ]; then echo "tasks queue $name slots $live_slots -> $slots"; fi
  done
  worker_live=$(gcv run services describe "$WORKER_SERVICE" --region="$REGION" \
    --format='value(metadata.annotations."run.googleapis.com/maxScale")' 2>/dev/null) || worker_live=""
  if [[ "$worker_live" =~ ^[0-9]+$ ]] && [ "$WORKER_MAX_INSTANCES" -lt "$worker_live" ]; then
    echo "$WORKER_SERVICE max instances $worker_live -> $WORKER_MAX_INSTANCES"
  fi
}

# Prints the first queue of the stack that holds a task and returns 0; returns 1 when every queue is empty.
queues_busy() {
  local line name slots kind out
  local -a plan
  mapfile -t plan < <(queues_shape)
  for line in "${plan[@]}"; do
    read -r name slots kind <<<"$line"
    queue_exists "$name" || continue
    out=$(gcv tasks list --queue="$name" --location="$REGION" --limit=1 --format='value(name)') || { echo "$name (unreadable)"; return 0; }
    if [ -n "$out" ]; then echo "$name"; return 0; fi
  done
  return 1
}

queues_lower_wait() {
  local lowering busy waited=0
  lowering=$(queues_lowering)
  [ -n "$lowering" ] || return 0
  # queues_lowering ran in a subshell; queues_busy needs the queue names here.
  queues_read_existing
  echo "==> shape: this deploy lowers:"
  sed 's/^/    /' <<<"$lowering"
  while busy=$(queues_busy); do
    if [ "$waited" -ge "$SHAPE_LOWER_WAIT_S" ]; then
      echo "WARN: a batch is still in flight ($busy holds tasks) after ${SHAPE_LOWER_WAIT_S} s; applying the lower shape now (SHAPE_LOWER_WAIT_S)" >&2
      return 0
    fi
    echo "==> shape: a batch is in flight ($busy holds tasks); waiting for the stack to be idle before lowering (${waited} of ${SHAPE_LOWER_WAIT_S} s)"
    sleep "$SHAPE_LOWER_POLL_S"
    waited=$((waited + SHAPE_LOWER_POLL_S))
  done
  echo "==> shape: no batch in flight; applying the lower shape"
}
