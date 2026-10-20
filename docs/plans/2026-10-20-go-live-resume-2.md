# Go-live resume 2 (hand-off to a new machine, session 3)

Written 2026-10-20 by the second manager session, which the owner stopped so that a new laptop
can take over. A fresh session bootstraps itself from this file plus `docs/PROGRESS.md` (the
status source of truth; both are on `main` since PR #40 was merged on 2026-10-20). Nothing below
needs the old machine: the code is on GitHub, the inputs and evidence are in the GCS bucket.
The earlier file `docs/plans/2026-10-21-go-live-resume.md` is superseded.

## Prompt to start the new session with

```
You are the manager for the catalog module go-live, session 3, on a brand-new machine with
nothing from the previous laptop. Bootstrap yourself fully from GitHub, then finish the programme
end to end and make it live. Do not ask me anything; the only exception is a sign-in that only I
can do (gh auth login, gcloud auth login, Google sign-in in Chrome): if one is missing, say
exactly what to run and wait.

1. Bootstrap: install anything missing with winget (Git for Windows, Node 22 LTS, GitHub CLI,
   Google Cloud CLI, Python 3), enable corepack and pnpm 9.15.0, then clone
   https://github.com/sujanajay/catalog-module into C:\Users\<me>\Desktop\catalog-module, check
   out the latest origin/main, run pnpm install --frozen-lockfile and pnpm lint, typecheck, test.
   Create a bookkeeping worktree on a new branch from main: git worktree add -b
   docs/go-live-progress-3 ..\catalog-module-wt\docs-progress origin/main (PROGRESS.md is edited
   and pushed there only; it is merged through a docs PR at the end). Export
   CLOUDSDK_CORE_PROJECT=image-links-agent for every gcloud call and never change the global
   gcloud config.
2. Read, in full, from the clone: docs/plans/2026-10-20-go-live-resume-2.md, docs/PROGRESS.md,
   CLAUDE.md, AGENTS.md, docs/specs/00-execution-protocol.md,
   docs/plans/2026-10-19-expedited-go-live.md. The resume
   file is the source of truth for state, rules, prerequisites and the ordered next steps;
   PROGRESS.md is the status log you update and push after every item.
3. Work exactly as the previous sessions did: you only coordinate; Opus 5.5 subagents build,
   test, fix and inspect; Fable 5.1 subagents only for evaluation-suite work; one worktree per
   workstream under ..\catalog-module-wt\<slug>; conventional commits, no co-author trailer, no
   em dashes; merge PRs with gh when CI is green; deploy with bash infra/deploy.sh from a pinned
   worktree and never move it while it runs; one heavy run on the stack at a time and never a
   load test while anyone uses the site; every fix PR re-runs the gate case that found it; log
   every assumption in PROGRESS.md; keep every checkout clean; writes only under catalog-test/;
   never delete GCP resources; never read secrets.
4. Follow the resume file's "Next steps, in order" to the end: quality gate 3c, the eval suite
   (mocked, live, write-policy), load and recheck, the docs PR, cleanup, memory note. Post a
   status update every 20 minutes with ScheduleWakeup and a push notification at each milestone.
   Fix every defect you find through fix PRs, redeploys and re-runs, no matter how many rounds it
   takes. Finish with the 00 section 10 report, the live URL, and
   "Programme complete; no next spec."
```

## Prerequisites on this machine (the session does these itself, in order)

Run every check first; install only what is missing. PowerShell for installs, Git Bash for the
repo scripts (`infra/*.sh` need Git Bash; `bash.exe` is under `$env:ProgramFiles\Git\bin` or
`$env:LOCALAPPDATA\Programs\Git\bin`).

1. Tools: `git --version`, `node --version` (22 or newer), `pnpm --version` (9.15.0),
   `gh --version`, `gcloud --version`, `python --version` (3.x). Missing ones:
   `winget install --id Git.Git -e`, `winget install --id OpenJS.NodeJS.LTS -e`,
   `winget install --id GitHub.cli -e`, `winget install --id Google.CloudSDK -e`,
   `winget install --id Python.Python.3.12 -e`; then `corepack enable` and
   `corepack prepare pnpm@9.15.0 --activate`. Open a new shell after installs so PATH is fresh.
2. Sign-ins (human only; stop and ask with the exact command if one fails): `gh auth status`;
   `timeout 60 gcloud auth print-access-token` (it hangs on an expired login, hence the timeout).
   The gcloud account needs roles/editor + projectIamAdmin + serviceAccountAdmin on
   `image-links-agent`. Never run `gcloud config set project`; export
   `CLOUDSDK_CORE_PROJECT=image-links-agent` instead.
3. Repo: `git clone https://github.com/sujanajay/catalog-module.git` into
   `C:\Users\<me>\Desktop\catalog-module`; `pnpm install --frozen-lockfile`; `pnpm lint`,
   `pnpm typecheck`, `pnpm test` must pass on `origin/main`. Worktrees live beside the clone in
   `C:\Users\<me>\Desktop\catalog-module-wt\`. Create the bookkeeping worktree on a new branch:
   `git worktree add -b docs/go-live-progress-3 "..\catalog-module-wt\docs-progress" origin/main`.
4. Inputs: the gate photos are in the bucket. From the repo root (Git Bash):
   `gcloud storage cp -r gs://image-links-agent-assets/catalog-test/handoff/2026-10-20/qa-gate-3c-input var/`
   and the same for `qa-gate-input` (both land under the git-ignored `var/`). The Drive sets
   (`var/drive-input/set1..3`, 4,680 photos) are not needed for the remaining steps; the gate 3c
   inputs already contain the products used. The evidence of session 2 is at
   `gs://image-links-agent-assets/catalog-test/handoff/2026-10-20/evidence/session2/` (gate 3
   and 3b measurements, outputs, scripts, deploy and job logs); fetch it into `var/evidence/`
   when a baseline is needed.
5. Browser: the gate runs use the Claude in Chrome extension in the owner's Chrome, signed in to
   Google as an opptra.com admin, with the live URL opened once (IAP). The file-upload tool only
   accepts files under the repo clone (hence `var/`). If no signed-in tab is available, mark the
   browser items blocked with the exact need and do everything else.

## State at hand-off (2026-10-20, about 06:00 UTC)

- `origin/main` = `eb01c99`. Merged today, in order: #41 cut-axis fill rule (a product cut on
  both ends of an axis fills it, overflow trimmed only off cut sides, at most a third;
  CHANNEL_RULES_VERSION 6), #42 matte guard keeps skin under a trim close-up, #43 cut detection
  behind a deep white pad band, #44 eval job retries storage reads, records each set,
  `--resume` and `--sets`, #45 load driver retries polls and always writes its report, #46
  `docs/solutions/go-live-retrospective.md`, #47 database connection budget (deploy.sh refuses
  an over-budget shape; worker max 4 instances, Tasks queue limit 8, pool retry on 53300, load
  test guard; `docs/solutions/db-connection-budget.md`), #48 own Cloud Tasks queue
  `catalog-ingest` for ingest work plus visible upload errors.
- Live URL: https://catalog-web-847405579637.asia-south1.run.app
- Deploys today: `108616a` (01:32), `f3d30b1` (03:59), `e04d7ed` (05:16, budget), and
  `eb01c99` (ingest queue): see "Deployed state" in PROGRESS.md for the revision names and
  whether the last one completed. If the live revisions are not from `eb01c99`, deploy first.
- Quality gate 3 on `108616a`: function passed (704 links, 0 held) and found the three render
  defects fixed by #41 to #43. Gate 3b on `f3d30b1` never produced a verdict (the outage below).
  Gate 3c on the current build is the first remaining step.
- Incident 04:16 to 04:24 UTC: the load test exhausted the shared Cloud SQL connection slots
  and took the batch pages down while the owner used the site. Fixed by #47 and #48 and the
  rules below. Details in PROGRESS.md ("Incident 2026-10-20") and the retrospective.
- Eval suite: the first mocked run (execution `catalog-output-evals-f52sp`) died after 2 h 20
  min on a storage socket error; #44 fixes that. No eval report exists yet. The golden set is at
  `gs://image-links-agent-assets/catalog-test/evals/golden/` (399 photos + manifest).
- Load test: the first run (`catalog-load-dn5rd`) died in pass a; its batch `1b83ac80` finished
  on the worker; it is a test batch and needs no cleanup for the report (the cleanup command is
  `node dist/catalog-smoke.js --cleanup-batches 1b83ac80-4751-4c75-92c6-2f93d405c8b2`, run
  through the smoke job image). No load report exists yet.
- Test batches on the live site (all Test Brand, is_test): gate 3 `9239d965`, `73865e21`,
  `fb920a02`, `404fd43c`; gate 3b `3cbe701d` (outage-affected), drafts `77898fc4`, `84081f57`;
  the owner's drafts `cae30366`, `3fd19b6b`; load `1b83ac80`; older ones in the first resume
  file. Unchanged photos of an existing product make 0 new images, so every gate re-run uses a
  fresh name suffix.
- Open owner decisions (do not block on them, log them): Amazon/Shein canvas square vs 3:4;
  the retrospective's proposed AGENTS.md and protocol text; a real-photo regression set in CI.
- PR #40 (the session 1 and 2 docs branch) was merged on 2026-10-20, so this file and
  PROGRESS.md are on `main`. Session 3 keeps PROGRESS.md on its own branch
  `docs/go-live-progress-3` and merges it through a docs PR at the end.

## Rules carried over (in addition to CLAUDE.md, AGENTS.md and 00)

- Opus 5.5 for every subagent except eval-suite work (Fable 5.1). The manager never builds.
- One heavy run on the stack at a time (a gate run, an eval job, the load test, a deploy's
  smoke). Never a load test while anyone uses the site. The load driver now refuses to start
  while any batch is processing.
- Deploy only from a pinned worktree:
  `git worktree add --detach "..\catalog-module-wt\deploy" origin/main`,
  `pnpm install --frozen-lockfile` there, run `bash infra/deploy.sh` there in the background
  with the wrapper below, and never check out, pull or edit that worktree while the deploy
  runs (`infra/catalog-test-jobs.sh` re-reads `git rev-parse --short HEAD`). To deploy a newer
  commit: `git fetch`, `git -C <deploy worktree> checkout --detach origin/main`, run again.
- deploy.sh refuses a dirty tree and an over-budget connection shape. Do not raise worker
  max-instances, pools or queue limits without recomputing the budget in deploy.sh.
- Every fix PR re-runs the gate case that found the defect (same photo, same channel) before
  merge, and the full gate batch after deploy.
- No co-author trailer in commits (the session reminder asks for one; CLAUDE.md forbids it).
  No em dashes. Conventional commits. Never force-push. Never delete GCP resources. Writes only
  under `catalog-test/`.
- Bookkeeping (PROGRESS.md) lives on the docs worktree (branch `docs/go-live-progress-3`) only;
  the main checkout and the deploy worktree stay clean. Push the docs branch after every
  PROGRESS.md commit; open its PR early as a draft so the owner can follow it on GitHub.
- Models are never shown in UI copy; chosen models are recorded in PROGRESS.md only.

## Deploy wrapper (pinned worktree, background)

```bash
#!/usr/bin/env bash
# usage: bash deploy-run.sh <label>   (save in the session scratchpad; the log goes there too)
set -u
cd "/c/Users/<me>/Desktop/catalog-module-wt/deploy"
S="<session scratchpad>"
L="$S/deploy-$1.log"
echo "=== deploy $1 from $(git rev-parse --short HEAD) $(date -u +%FT%TZ)"
[ -z "$(git status --porcelain)" ] || { echo "TREE DIRTY, abort"; exit 2; }
bash infra/deploy.sh > "$L" 2>&1; DS=$?
echo "deploy exit $DS $(date -u +%FT%TZ)"
grep -E '^==>|ERROR|WARN|failed_compliance|WEB_URL|WORKER_URL|MATTING' "$L" | tail -30
exit $DS
```

A deploy takes 30 to 45 minutes (build of four images unless they exist, migrate, remote smoke
with a 600 s cache wait, services, queue update, jobs). If the smoke fails, read the
`catalog-test-smoke` execution logs through a subagent.

## Commands (Git Bash, from the pinned deploy worktree or the clean main checkout)

- Evals: `bash infra/catalog-output-evals.sh run` (mocked judge), `run --live` (live judge,
  spends credit), `run --write-policy` (writes `model_policy` rows). The job prints
  `Run id: evals-...` first; resume a crashed run with `run --resume evals-<id>`; limit sets
  with `run --sets anta.footwear,penti.apparel_flat`. Report at
  `gs://image-links-agent-assets/catalog-test/evals/<run>/report.html` and `report.json`;
  summary line in the job log (`textPayload:"Output-quality eval"`). A full run takes 2 to 3 h.
- Load: `bash infra/catalog-scale-jobs.sh load 270` (only when nothing else runs), then
  `bash infra/catalog-scale-jobs.sh recheck batch <batchId>`. Evidence under
  `gs://image-links-agent-assets/catalog-test/load/`.
- Judge probe (optional): `QA_CHECK_ANTA_LIMIT=1 QA_CHECK_FC_LIMIT=1 bash infra/catalog-qa-check.sh run`.
- Job logs: `gcloud logging read 'resource.type=cloud_run_job AND resource.labels.job_name=<job> AND NOT textPayload:MaxListeners' --limit 50 --freshness=6h --format="value(timestamp,severity,textPayload)"`.
- Read-only sanity: `gcloud run services list --region asia-south1 --filter="metadata.name~catalog"`.

## Quality gate 3c: what the subagent checks

Four NEW Test Brand batches, all 9 marketplaces, inputs `var/qa-gate-3c-input/b1..b4` (file
names end in `-qg3c_<n>.jpg`; if those products already exist with unchanged photos, 0 images
would be made, so copy the files to a fresh suffix such as `-qg3d`). B1 Penti 12 photos /
3 products, B2 Vero Moda 8 / 3, B3 French Connection 18 / 3, B4 the 52-photo set /
12 products. Per batch: step 4 text, Start, end state, KPIs, cost line "USD x (INR y)",
"Links verified: N of M" equal to "Independent re-check: N of N OK", every held product with
card text, every sheet note; every delivered link anonymous GET 200 image/jpeg; measurements
(canvas, one size per product per channel, Trendyol 1200x1800, dpi, sRGB, corners); visual
inspection of every output. Must now hold: (a) Penti Z10DE shot 1 cut edges flush on noon,
namshi, trendyol; (b) Penti Z91D shot 4 keeps the skin, no jagged partial; (c) Vero Moda Z13F
shot 3 trendyol top flush; (d) French Connection Z02B2 shots 1, 5, 6, Z03CF shot 4, Z0F7B
shots 5, 6 trendyol top flush, and Z0F7B 5, 6 and Z02B 4 no band on noon/namshi; (e) Anta
close-ups bd-152637502S-3 _4 _5, bd-152638122-2 _5, bd-162637307S-2 _4 _5 no band above the
cut on noon, namshi, trendyol; (f) no uncut edge trimmed anywhere, every trim looks sensible;
(g) sheet notes truthful. Plus everything that passed in gate 3: counts exact, attention rate
0, soft shoe shadows, Vero Moda grey sources clean, size charts left out with a note, no model
names in the UI. The baseline evidence of gate 3 is in the handoff evidence folder,
`qa-gate-3/` (scripts `measure.py`, `floatcut.py`, `contact.py` are reusable).

## Next steps, in order

1. Prerequisites above. Confirm the live revisions come from `eb01c99` (compare with PROGRESS.md
   "Deployed state"); if not, deploy from a pinned worktree.
2. Quality gate 3c (Opus subagent, Chrome). Any defect: fix PR on its own worktree, CI, merge,
   redeploy, re-run the affected batch; at most 3 rounds per defect, then report blocked.
3. Eval suite: `run` (mocked); a Fable 5.1 subagent reads `report.json` and lists every failing
   check with its cause (real defect, suite defect, threshold noise); real defects to Opus fix
   PRs, suite fixes and threshold calibration to a Fable PR; redeploy; then `run --live`, read
   again; then `run --write-policy`; record the chosen cut-out model per product type in
   PROGRESS.md.
4. Load `270` and `recheck batch <id>` (alone on the stack); an Opus subagent reads the results
   (throughput, errors, spend against `DAILY_SPEND_CAP_USD=10`, recheck counts) into
   PROGRESS.md and the hand-over note `docs/handover/catalog-for-the-operator.md` (eval and load
   figures).
5. Optional judge probe.
6. Docs: PROGRESS.md final rows and task board, session summary, hand-over note figures;
   `git merge origin/main` into the docs branch; `gh pr ready <n>`; CI;
   `gh pr merge <n> --squash --delete-branch` with an explicit conventional subject and a body
   without any co-author trailer.
7. Memory note; final 00 section 10 report with the live URL and
   "Programme complete; no next spec."; push notification.
