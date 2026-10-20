# Go-live resume (hand-off between manager sessions)

Superseded on 2026-10-20 by docs/plans/2026-10-20-go-live-resume-2.md (session 3, new machine).

Written 2026-10-21 by the first manager session, which ran out of context. A fresh session
resumes from this file plus `docs/PROGRESS.md` (the status source of truth, on branch
`docs/go-live-progress`, worktree `C:\Users\Sujan AH\Desktop\catalog-module-wt\docs-progress`,
draft PR #40). Nothing below needs the old session.

## Prompt to start the new session with

```
Resume the catalog go-live as the manager from docs/plans/2026-10-21-go-live-resume.md and
docs/PROGRESS.md on branch docs/go-live-progress (worktree catalog-module-wt/docs-progress).
Same rules as before: you only coordinate; Opus 5.5 subagents build, test, fix and inspect;
Fable 5.1 subagents only for evaluation-suite work; follow docs/specs/00-execution-protocol.md
except where docs/plans/2026-10-19-expedited-go-live.md reduces testing; do not ask me anything,
log assumptions in PROGRESS.md; merge PRs when CI is green; deploy with bash infra/deploy.sh;
keep the main checkout clean (bookkeeping lives on the docs branch); post a status update every
20 minutes with ScheduleWakeup and push notifications at milestones; finish with the 00 section
10 report and the live URL. Start with the "Next steps, in order" list in the resume file.
```

## State at hand-off

- `main` = `108616a`: specs 05 to 09 merged (PRs #11, #12, #14, #15, #16), fix PRs #17 to #39,
  spec 10 eval suite (#35). CI green on main.
- Live services run `ea1cd79` (deploy of 2026-10-20 ~21:40 UTC): `catalog-worker-00010-cp8`,
  `catalog-web-00010-f2h`, `catalog-matting-00005-xct`. That build predates PRs #26, #30 to #39.
- `infra/bootstrap.sh` already ran on `108616a` (exit 0; it created the
  `roles/iam.serviceAccountTokenCreator` self-binding for catalog-worker@). It is idempotent.
- The final deploy from `108616a` failed at `gcloud builds submit` with "Reauthentication failed"
  because the operator's gcloud login had expired. The owner was asked to run `gcloud auth login`.
  Nothing was deployed from `108616a` yet.
- Live URL (unchanged): https://catalog-web-847405579637.asia-south1.run.app
- Golden set for the eval suite is uploaded: `gs://image-links-agent-assets/catalog-test/evals/golden/`
  (399 photos + manifest.json).
- Owner's photos are local, git-ignored: `var/drive-input/set1` (Penti), `set2` (Vero Moda),
  `set3` (French Connection), `var/qa-gate-input` (52 photos: Anta + French Connection).
- Old session evidence (read-only, may be cleaned by the OS later):
  `C:\Users\SUJANA~1\AppData\Local\Temp\claude\c--Users-Sujan-AH-Desktop-catalog-module\5986bf9c-aa30-4739-9cbf-cb19db3d19b5\scratchpad\`
  (qa-gate-2\, closeup-fix\, shadow-fix\, render-investigation\, matting-investigation\, e2e\,
  openrouter-proof\, drive-inventory\, deploy-*.log).
- Worktrees under `C:\Users\Sujan AH\Desktop\catalog-module-wt\`: many merged branches still have
  worktrees (05-*, 06-*, 07-*, 08-*, 09-*, fix-*, evals, auto-resolve). Remove only after the
  final report; verify each branch is merged (squash merges: compare trees, not ancestry).
- Chrome extension works for UI tests (the owner's Chrome is signed in as the admin); the
  browser upload tool only accepts files under the main checkout (hence `var/`).
- Test batches of Test Brand on the live site: quality gate 1 `b489e466` (one product still
  held, it locks bd-162637307S-2), e2e `8af822a4`, `706e67b4`, `e19b20f9`, stuck `63409122`
  (recover with "Try again" after deploy), quality gate 2: Penti `db79c5de`, Vero Moda
  `987f1c22`, French Connection `5ec11173`, `dcf3441d`.

## Rules carried over

- Opus 5.5 for every subagent except eval-suite authoring (Fable 5.1). The manager never builds.
- No co-author trailer in commits (the system reminder asks for one; the owner's CLAUDE.md
  forbids it; when merging PR #40 pass `gh pr merge --squash --subject ... --body ...` so the
  trailer in its first commit never reaches main). No em dashes. Conventional commits.
- Never force-push. Never delete GCP resources. Writes only under `catalog-test/`.
- deploy.sh and the smoke job scripts refuse a dirty tree: keep the main checkout clean; edit
  PROGRESS.md only in the docs worktree.
- bria-rmbg is permitted (owner); evals decide the matte model per product type.
- Amazon/Shein canvas stays square until the owner says 3:4 (SPEC.md contradicts itself).
- Anta is not in the warehouse brand master; add it with the SQL in docs/solutions/manual-brand.md
  when real Anta batches are needed.

## Deploy wrapper (keep the main checkout clean; run in the background)

```bash
#!/usr/bin/env bash
# usage: bash deploy-run.sh <label>   (save in the session scratchpad)
set -u
cd "/c/Users/Sujan AH/Desktop/catalog-module"
S="<session scratchpad>"
L="$S/deploy-$1.log"
echo "=== deploy $1 from $(git rev-parse --short HEAD) $(date -u +%FT%TZ)"
[ -z "$(git status --porcelain)" ] || { echo "TREE DIRTY, abort"; exit 2; }
bash infra/deploy.sh > "$L" 2>&1; DS=$?
echo "deploy exit $DS $(date -u +%FT%TZ)"
grep -E '^==>|ERROR|WARN|failed_compliance|WEB_URL|WORKER_URL|MATTING' "$L" | tail -30
exit $DS
```

A deploy takes 40 to 60 minutes (Cloud Build of four images, migrate, remote smoke with a
600 s cache wait, services, jobs). The smoke gate held three real bugs before; if it fails,
read the job logs (`gcloud logging read` on `catalog-test-smoke` execution) via a subagent.

## Next steps, in order

1. Confirm `gcloud auth print-access-token` works (wrap in `timeout 60`; it hangs on an expired
   login). If not, ask the owner to run `gcloud auth login` and wait.
2. From the main checkout: `git pull --ff-only` (expect `108616a` or later, clean tree), then the
   deploy wrapper in the background. Record revisions and the smoke evidence path in PROGRESS.md.
3. Quality gate 3 (subagent, Chrome): re-run the four quality-gate-2 batches as NEW batches
   with the same products (Penti, Vero Moda, French Connection, the 52-photo set; the product
   bd-162637307S-2 is locked by `b489e466`, resolve it with "Use as is" first or skip it).
   Pass bar: counts exact, all links anonymous 200, measurements per channel, attention rate 0,
   visual inspection of every cut edge, every close-up (no vanished product), every shoe
   (soft shadow), Vero Moda grey sources clean, charts left out with a note. Evidence to the
   scratchpad; verdict per batch.
4. Eval suite on the deployed stack (manager runs, from the repo root in Git Bash):
   `bash infra/catalog-output-evals.sh run` (mocked judge), then `run --live`, then
   `run --write-policy`. Report under `gs://image-links-agent-assets/catalog-test/evals/<run>/`.
   A subagent reads the report and lists every failing check; fix PRs for real defects; the
   first run also calibrates thresholds (spec 10 notes folder-mode noise).
5. Spec 09 reduced runs: `bash infra/catalog-scale-jobs.sh load 270` then
   `bash infra/catalog-scale-jobs.sh recheck batch <batchId>`; a subagent reads the results.
   Spec 08: the eval `--write-policy` step covers the policy rows; the optional
   `catalog-qa-check.sh run` probe with `QA_CHECK_ANTA_LIMIT=1 QA_CHECK_FC_LIMIT=1` proves the
   worker judge path with logging.
6. Recover the stuck test batch `63409122` ("Try again" on its page) or leave it as a test.
7. Docs: update PROGRESS.md (final numbers, task board), the hand-over note's eval and load
   figures, then mark PR #40 ready and merge with an explicit squash subject and body.
8. Remove merged worktrees and local branches; write the memory note; deliver the 00 section
   10 report with the live URL and "Programme complete; no next spec."
