# Shorter deploys (M6-S5, M6-F2-R7 and R11)

## Why a worker-only change took over an hour
Every commit rebuilt the matting images (`cloudbuild.yaml` bakes `GIT_SHA` into them), so their image digest changed on
every deploy and the gate never found the four matting services unchanged. Each deploy therefore ran every matting probe
one after the other. On 2026-11-03 (4ff1e82, from revision and job execution times):

| Step | Minutes |
|---|---|
| pre-flight, shape, build SKIP | 1.1 |
| migrate, queues | 0.4 |
| catalog-matting (candidate 3.3, probe 1.5) | 5.5 |
| catalog-upscale (probe job 35.4) | 37.5 |
| catalog-upscale-gpu | 5.5 |
| catalog-matting-gpu | 5.2 |
| catalog-web | 1.0 |
| catalog-worker (smoke 13.4) | 14.3 |
| queues, IAP, CORS, 7 jobs, monitoring | 2.5 |
| total after the build | 73.0 |

The full Cloud Build (four images) took 15 to 20.5 minutes (about 17) on 2026-10-28 to 2026-11-05; a worker and web
build took 2.7 to 3.5 minutes (the preview builds of 2026-10-30).

## What changed
- `infra/lib/build.sh`: the matting images are tagged with a hash of their source (`MATTING_TAG`, 12 hex digits): one
  `<path> <git blob sha1>` line per file of `services/matting` and `cloudbuild.yaml`, sorted, then sha256. A commit that
  leaves them alone reuses the same images: the build makes only worker and web (`infra/cloudbuild-preview.yaml`), and the
  four matting services are SKIP (no candidate, no probe). The worker's smoke then runs against the live matting services
  (their service URLs).
- The tag names content, and the build proves it: the first step of `cloudbuild.yaml` (`verify-matting-source`) hashes
  the files it was actually given, the same way git hashes a blob, and fails the build before any image is pushed unless
  that is `_MATTING_TAG`. So a tarball made from a dirty folder or another commit can never put a wrong image under a tag
  that later deploys reuse. `deploy.sh` and `--build-command` refuse a dirty tree.
- `gate_group` (`infra/lib/gate.sh`): when matting services did change, their candidates deploy at once, then their
  probes run at once; traffic moves only when every one passed. One failure moves no traffic and changes no service's
  max instances (a SKIP member's max is applied in the shift round, after every probe passed).
- Each matting probe runs as its own Cloud Run job, `catalog-check-<service>` (catalog-check-matting, -upscale,
  -upscale-gpu, -matting-gpu), since a probe job carries its arguments in the job. The first deploy that probes in
  parallel creates the three new jobs (1 vCPU each, labelled env=test, nothing runs when idle; within the 8 vCPU the
  shape keeps for jobs).
- R11 (`queues_lower_wait` in `infra/lib/queues.sh`): a lower max instances of any matting service or the worker, or
  fewer queue slots, wait until no queue of the stack holds a task, at most `SHAPE_LOWER_WAIT_S` (1800 s), then apply with a warning.
- The deploy ends with the minutes per step and `DEPLOY_OK <tag> in <m>m<s>s`.

## Expected durations (from the table above)
- Worker or web change, matting source unchanged: pre-flight 1.1 + build 3.5 + migrate 0.4 + four SKIPs 0.5 + web 1.0 +
  worker 14.3 (smoke 9.4 to 15.1 over the last 8 runs) + post 2.5 = about 23 minutes from `bash infra/deploy.sh` to
  `DEPLOY_OK` (about 20 when the images were built beforehand). Target: under 30.
- Matting change (all four services, same image): pre-flight 1.1 + build 17 + migrate 0.4 + group (candidates about 3.5,
  then the slowest probe, catalog-upscale, 35.4, then 4 shifts about 1) + web 1.0 + worker 14.3 + post 2.5 = about 76
  minutes with the build, about 59 without (was about 90 and 73). The CPU upscale probe alone is now the long pole.

## Building from an uploaded tarball
`gcloud builds submit .` hangs on upload from the owner's laptop, so builds go through a tarball in GCS. From a clean
checkout of the commit to deploy, run `bash infra/deploy.sh --build-command`: it prints the three commands (a
`git archive` of HEAD, the upload, and `gcloud builds submit` with the exact config and substitutions; `_MATTING_TAG`
only for `cloudbuild.yaml`, since Cloud Build refuses a substitution the config does not use), or says no build is
needed. Never tar the working folder: anything that differs from the commit makes `verify-matting-source` fail the build.

## R11 reads fail closed
`queues_lower_wait` compares the new shape with the live one for the max instances of every service it is given (the
matting group before the group; the worker, with the queue slots, before the worker gate). A live value that cannot be
read counts as lowered, and a queue that cannot be read counts as busy, so a gcloud hiccup makes the deploy wait (at most
`SHAPE_LOWER_WAIT_S`), never lowers a shape under a batch. Only a service that does not exist yet has nothing to lower.

## Not done: skipping a probe that passed in an earlier run (review P2-2)
A re-run after a failed group re-deploys and re-probes every changed member, including those whose probe passed (for the
CPU upscaler about 35 minutes). Reusing an earlier pass was left out: the only record of it would be local state on the
machine that ran it, the pass says nothing about a probe that changed since (`infra/check-matting.sh`, the shape's
probe sizes and rounds) or about what the probe measures outside the revision (the model files, the GPU host, quota),
and the gate's rule is that traffic moves only to a revision probed in the same run as the rest of its group. The cost
falls only on the retry of a failed matting deploy, which is rare now that matting source rarely changes.

## Known timing gaps
- A full matting change is about 76 minutes with the build (R7 asks 75): the CPU upscale probe (35.4 minutes) is the
  long pole, unchanged by this slice.
- F2 test 3 (a worker-only change deploys in under 30 minutes) is shown by the model above; the live proof is the first
  worker-only deploy after this merges, when `DEPLOY_OK <tag> in <m>m<s>s` gives the measured time.
