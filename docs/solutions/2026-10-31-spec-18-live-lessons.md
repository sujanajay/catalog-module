# Spec 18 live run - lessons (2026-10-30 to 2026-10-31)

The non-obvious things learned while taking spec 18 (reliable enlargement) live. Evidence is in the `.runs/`
reports named per item. Each item ends with the check or guard that now covers it.

## 1. Cloud Run has a hidden service-level max instances
- Next to the revision-level `--max-instances`, every service carries a service-level max
  (`run.googleapis.com/maxScale`, gcloud `--max`) that it took from its first-ever deploy. The repo never set it,
  and the lower of the two wins.
- Seen: catalog-upscale stuck at 4 instances while the shape and the revision said 16; the worker at 10 instead
  of 24 (its 429s during chunking).
- Guard: #130, the gate sets the service-level max to the revision value on every deploy. Details and the check
  command: `docs/solutions/cloud-run-service-level-max.md`. Evidence: `.runs/2026-10-30-18-service-max.md`.

## 2. The enlarge queue rate, not instances, was the real bottleneck
- After the cap lift the upscaler still ran at about 4 to 4.5 enlargements a minute with 16 instances. The bulk
  lane `catalog-enlarge-bulk` had `maxDispatchesPerSecond` 0.075 (one call every 13 s), so the queue, not
  the machines, set the pace. Adding instances alone would not have helped.
- Rule: when a stage is slow, read the queue's dispatch rate and concurrency next to the instance count before
  asking for more capacity.
- Guard: #131 makes the lane rates part of the shape (`ENLARGE_BULK_DISPATCHES_PER_SECOND`), and `shape_check`
  refuses a summed lane rate above the measured capacity. Evidence: `.runs/2026-10-30-18-scale-options.md`,
  `.runs/2026-10-30-18-cpu-scale.md`.

## 3. A subagent's permission classifier does not see approvals given in the main session
- The owner approved a production deploy in the main session; the subagent that ran `bash infra/deploy.sh` was
  refused by the auto-mode classifier as a "Production Deploy", and a `gcloud artifacts docker tags add` as
  "Modify Shared Resources". A manager message relaying the approval does not count as the owner's approval.
- Rule: run owner-approved production steps (deploys, shared-resource changes) from the session where the owner
  approved them, or have the owner run them. A subagent that is refused stops and reports; it never works around
  the refusal. Evidence: `.runs/2026-10-30-18-cpu-scale.md`, `.runs/2026-10-30-18-deploy.md`.

## 4. A gate on one x4 call against one x2 call is too noisy
- The deploy gate compared a single x4 p95 with a single x2 p95 (`UPSCALE_X4_TIME_RATIO` 1.3). One fast x2 call
  (the fastest on record) made the ratio 1.51 and failed a healthy deploy.
- Guard: #134, the gate takes the median of several calls per model and checks each model's estimate at its pixel
  cap against the timeout with the 2x margin, instead of a ratio between two single calls.

## 5. The gcloud login can expire in the middle of a long run
- On 2026-10-30 the login expired about 20:35 UTC, during the 8-hour load. The test itself ran on (Cloud Run and
  Cloud Tasks do not need the laptop), but every read and the next deploy failed with "Reauthentication failed.
  cannot prompt during non-interactive execution" until the manager refreshed the login at about 01:45 UTC.
- Rule: before a long run and before any deploy, check `gcloud auth print-access-token > /dev/null`; a subagent
  that sees the reauthentication error reports "LOGIN EXPIRED" and stops. See also
  `docs/solutions/gcloud-login-after-reboot.md`. Evidence: `.runs/2026-10-30-18-load-5.md`,
  `.runs/2026-10-31-18-combined-deploy.md`.

## 6. CI takes about 35 minutes
- A pull request's CI run took about 34 to 35 minutes (PR #130: 34 min 19 s). Plan merges and deploys around it,
  and use a watcher instead of polling. Speeding it up is a follow-up in
  `docs/plans/2026-10-28-post-deploy-status.md`.

## 7. RTX PRO 6000 GPUs were granted automatically in asia-south2
- The first deploy of `catalog-upscale-gpu` with `--no-gpu-zonal-redundancy` in asia-south2 got 3 RTX PRO 6000
  GPUs (quota `NvidiaRtxPro6000GpuAllocNoZonalRedundancyPerProjectRegion`, counted in milli GPU: 3000) with no
  request form. L4 in asia-south1 is by invitation only, so a new region was the fast path to a GPU.
- The increase to 6 (`infra/request-gpu-upscale-quota.sh`) shows as granted (6000) on 2026-10-31;
  `UPSCALE_GPU_MAX_INSTANCES` is still 3 until a deploy raises it.
- Details: `docs/solutions/2026-10-30-gpu-upscaler-rtx-pro-6000.md`. Evidence: `.runs/2026-10-30-18-gpu-upscale.md`.
