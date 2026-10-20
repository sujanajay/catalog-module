# Go-live resume 3 (hand-off to session 4, same machine)

Written 2026-10-20 about 16:30 UTC by the third manager session, which the owner closed because its
context window was nearly full. Session 4 bootstraps from this file plus `docs/PROGRESS.md` (the
status log, on `main` once PR #50 is merged). The earlier file
`docs/plans/2026-10-20-go-live-resume-2.md` is superseded; its rules still apply unless changed here.

## Prompt to start session 4 with

```
You are the manager for the catalog module go-live, session 4, on the same machine as session 3
(clone C:\Users\Sujan Ajay\Desktop\catalog-module, everything installed, signed in). Do not ask me
anything except for a sign-in only I can do. Read, in full, from the clone after git pull:
docs/plans/2026-10-20-go-live-resume-3.md (source of truth for state, rules and the ordered next
steps), docs/PROGRESS.md, CLAUDE.md, AGENTS.md, docs/specs/00-execution-protocol.md. Work exactly
as session 3 did: you only coordinate; Opus 5.5 subagents build, test, fix and inspect; Fable 5.1
subagents only for evaluation-suite work; one worktree per workstream under
..\catalog-module-wt\<slug>; conventional commits, no co-author trailer, no em dashes; merge PRs
with gh when CI is green; deploy with bash infra/deploy.sh from the pinned worktree
..\catalog-module-wt\deploy and never move it while it runs; one heavy run on the stack at a time;
NEVER start a load test, an eval run or any multi-batch run while I may be using the site: check
the batch list for operator batches in the last 60 minutes and ask me for a window first (this
broke twice); every fix PR re-runs the gate case that found it; log every assumption in
PROGRESS.md on the docs worktree only; keep every checkout clean; writes only under catalog-test/;
never delete GCP resources; never read secrets. Post a status update every 20 minutes with
ScheduleWakeup and a push notification at each milestone. Follow the resume file's "Next steps, in
order" to the end, fix every defect through fix PRs, redeploys and re-runs, and finish with the 00
section 10 report, the live URL and "Programme complete; no next spec."
```

## This machine (session 3 findings; nothing to install)

- git 2.51.1, node 22.20.0, pnpm 9.15.0, python 3.13, gh signed in as sujanajay (repo scope),
  Google Cloud SDK 589.0.0 signed in as sujan@opptra.com (roles/editor, projectIamAdmin,
  serviceAccountAdmin, iap.httpsResourceAccessor). gcloud is NOT on PATH: in every Git Bash call
  `export CLOUDSDK_CORE_PROJECT=image-links-agent` and
  `export PATH="/c/Users/Sujan Ajay/AppData/Local/Google/Cloud SDK/google-cloud-sdk/bin:$PATH"`.
  Never change the global gcloud config. Git Bash is `C:\Program Files\Git\bin\bash.exe`.
- The machine clock is IST (UTC+5:30). Take times from job logs and the deploy wrapper (`date -u`),
  not from the wakeup clock.
- Browser: the Claude in Chrome extension tools are NOT exposed to Claude Code sessions here. The
  gate runs use Playwright (`@playwright/test` 1.64.1, `channel: "chrome"`) with the owner's saved
  IAP state `apps/web/.playwright/auth-state.json` (git-ignored, saved 2026-10-20 06:28 UTC as
  sujan@opptra.com, Admin). Check it first with `cd apps/web && pnpm exec tsx .playwright/verify.ts`
  (prints the user menu and whether New batch is visible). If it redirects to accounts.google.com,
  run `WEB_URL=https://catalog-web-847405579637.asia-south1.run.app pnpm --filter @catalog/web human:login`
  and ask the owner to sign in with sujan@opptra.com in the window that opens (the seeded admin;
  sujan.ajay.gcc@opptra.com may only be a viewer). Working scripts for the gate and the batch API
  live in `apps/web/.playwright/` (`g3c-run.ts`, `g3c-api.ts`, `lock-holder-batches.ts`,
  `ob-fetch.ts`, `amz-fetch.ts`); reuse them.
- Inputs on disk (git-ignored): `var/qa-gate-3c-input/`, `var/qa-gate-3d-input/`,
  `var/qa-gate-3e-input/` (byte copies with suffixes `-qg3c`, `-qg3d`, `-qg3e`; all three sets of
  products now exist on the live site, so the next gate run needs a NEW suffix such as `-qg3f`),
  `var/qa-gate-input/`, `var/evidence/session2/` (gate scripts `measure.py`, `floatcut.py`,
  `contact.py` under `qa-gate-3/`), `var/evals-golden/` (partial).
- Evidence of session 3 in the bucket: `gs://image-links-agent-assets/catalog-test/handoff/2026-10-20/evidence/session3/`
  (`qa-gate-3c/`, `qa-gate-3d/`, `investigations/`, `evals-run2/`, `fix-evidence/`, `logs/`).
- Worktrees: `..\catalog-module-wt\deploy` (pinned, detached at the last deployed commit) and
  `..\catalog-module-wt\docs-progress` (branch `docs/go-live-progress-3`, merged through PR #50 at the
  end of session 3; session 4 creates `docs/go-live-progress-4` the same way).
- Deploy wrapper: `deploy-run.sh` from resume 2 with the two exports above added; keep it in the
  session scratchpad; a deploy takes 30 to 35 minutes; `next/font` can fail the web image build on
  a transient Google Fonts fetch (happened once, the re-run passed; self-host the font if it repeats).

## State at hand-off (2026-10-20, about 16:30 UTC)

- `origin/main` = `cbe378d` plus the docs PR #50. Merged in session 3, in order: #51 Git Bash path
  helper, #52 report export scrub (model ids never reach the operator), #53 cut fill on Trendyol
  and logo-safe trims (`CHANNEL_RULES_VERSION` 7), #54 matte guard garment rule, #55 eval overwrite
  passes on released products, #57 smoke retries on a cold cut-out service, #58 gcloud short-name
  checks in deploy.sh, #59 pass-through recolours only the true background, #60 thin coloured
  sliver counts as lost product, #61 eval suite calibration, #62 apparel eval calibration and
  graded backgrounds, #63 busy-background hold and no trimming in a pass-through.
- Live: see "Deployed state" in PROGRESS.md. The last deploy of session 3 is `fixes7b` of
  `cbe378d` (see the row; if it did not complete, deploy first from the pinned worktree).
- Live URL: https://catalog-web-847405579637.asia-south1.run.app
- Quality gate: gate 3c on `eb01c99` found five look defects; gate 3d on `dda56bc` passed B2, B3, B4
  and left one remnant on B1 (fixed by #59). PRs #60 and #63 changed the matte guard, the
  pass-through and the trim rules after gate 3d, so the FULL gate (all four batches, suffix
  `-qg3f`) must be re-run on the deployed `cbe378d` build before anything else. Watch for the new
  busy-background holds on the leather close-ups `Z02B2..._3`, `_6` under the no-second-model
  policy (PR #63 noted them; if they hold on the live site, that is a defect to fix: a clean
  close-up must not be held).
- Eval suite: run 1 and run 2 (mocked) were cancelled by the manager after 1 and 2 recorded sets
  (`evals-20261020072959-c4f8fd`, `evals-20261020111831-8d62d7`); their anta and French Connection
  records drove PRs #55, #60, #61, #62, #63. No report exists yet. The golden manifest in the bucket
  was re-uploaded after #62 (expects the tennis-court lifestyle shot held with `leftover_background`).
  Known manifest gap: `Z011CB57531CA8FA0CBDDZ_1` (lifestyle candle) will now hold with
  `leftover_background` too and the manifest expects only `text_or_watermark`; add it in the next
  Fable suite PR. Bake-off so far: footwear `birefnet-general` (gpu), apparel_model ranking hinges
  on the edge_softness bar (bria-rmbg vs birefnet-general-lite); the chosen models are recorded in
  PROGRESS.md only, never in UI copy.
- Load test: two executions failed or were cancelled (`7wkjf` on stale locks, `6jtv6` cancelled
  because the owner was using the site). No load report exists. The load driver's test batches and
  the stale session 2 batch were cleaned. The load must run alone, in a window the owner names.
- Owner decisions taken in session 3: Noon margin question closed (the batch had no Amazon images;
  rules and code stay exactly as they are: cut photos flush and trimmed, Amazon and Shein square).
  Owner decisions still OPEN (the owner said "let me know first"; do not build them until the owner
  says go, but list them in every status): A fair sharing between batches, queue position and ETA,
  sweeper and judge 429 fixes, load driver re-check; B free throughput fixes (GPU model cache,
  judge concurrency limit, compute accounting); C and D (sharpening and the upscaler) are APPROVED,
  see step 8 below; E 2x shape
  (db-g1-small, 7 workers, maintenance window); F 1,000-product load measurement (empty UTC day);
  G upload path fixes. Estimates and evidence are in the PROGRESS.md investigation rows and the
  bucket folder `investigations/`.

## Rules carried over and added

- Everything in resume 2 "Rules carried over" still applies.
- NEVER start the load test, an eval run or any multi-batch run while the owner may be using the
  site: list the batches (`apps/web/.playwright/lock-holder-batches.ts`) and refuse if any
  non-test-brand batch or any batch not created by the run itself was created or updated in the
  last 60 minutes; ask the owner for a window. The queue serves tasks in arrival order and a big
  batch starves every operator batch (incident rows 04:16 and 14:17 UTC in PROGRESS.md).
- Cancelling a Cloud Run job execution does not stop the worker from draining that batch's tasks;
  clean the batch with `infra/catalog-test-cleanup.sh <ids>` (test batches only) to free it.
- Before a deploy, check the batch list the same way; the smoke adds two products of load.
- After every merge: `git pull --ff-only` in the main checkout, then in the deploy worktree
  `git checkout --detach origin/main` and `pnpm install --frozen-lockfile`; remove the fix worktree
  and its local branch.
- The eval job's `run` executes the deployed job image; it does not depend on the local commit.
- PROGRESS.md times in UTC from the logs.

## Next steps, in order

1. Prerequisites above; `git pull`; `pnpm install --frozen-lockfile`; `pnpm lint`, `pnpm typecheck`,
   `pnpm test` on main (expect 100 files / 1,015 tests or more); create the docs worktree on
   `docs/go-live-progress-4` and open its draft PR; verify the saved sign-in; confirm the live
   revisions are from `cbe378d` (PROGRESS.md "Deployed state"), else deploy from the pinned worktree.
2. Quality gate re-run (Opus subagent, Playwright): all four batches with suffix `-qg3f` on the
   live build, the full checklist of resume 2's "Quality gate 3c" section plus gate 3d's items
   (1) to (8) in PROGRESS.md. Any defect: fix PR, CI, merge, redeploy, re-run the affected batch; at
   most 3 rounds per defect.
3. Eval suite run 3: `bash infra/catalog-output-evals.sh run` (mocked), ONLY in an owner-approved
   window or when the batch list shows no operator activity for 60 minutes; 8 sets, 3 to 4 hours.
   Then a Fable 5.1 subagent reads `report.json` (and the set records) and classifies every failing
   check (real defect, suite defect, threshold noise); real defects to Opus fix PRs, suite fixes to
   a Fable PR; redeploy; re-run the affected sets with `--sets`; then `run --live`, read again; then
   `run --write-policy`; record the chosen cut-out model per product type in PROGRESS.md.
4. Load: `bash infra/catalog-scale-jobs.sh load 270` and `recheck batch <id>`, alone on the stack in
   an owner-approved window; an Opus subagent writes throughput, errors, spend and recheck counts
   into PROGRESS.md and `docs/handover/catalog-for-the-operator.md`.
5. Optional judge probe.
6. Docs: PROGRESS.md final rows, task board, session summary, hand-over figures; merge origin/main
   into the docs branch; `gh pr ready`; CI; squash-merge with a conventional subject and no co-author.
7. Memory note; final 00 section 10 report with the live URL and "Programme complete; no next spec.";
   push notification.
8. Image enhancement (APPROVED by the owner on 2026-10-20 16:40 UTC: "go with the best option, try it
   out, test it, see which is best"). Run it as spec 11 `docs/specs/11-image-enhancement.md`
   (write the spec first from the research in the bucket folder `investigations/`
   (`image-enhancement.md`, `enhancement-cost.md`), through the 00 protocol: Opus builders, Fable
   for the eval gate). Scope, in order:
   a. Sharpening after any enlargement in the render (`sharp` unsharp mask, only when scale > 1),
      fix the misleading "Trendyol wants at least 1800 px" review text, bump `CHANNEL_RULES_VERSION`,
      spec 10 evals must stay green; small PR, deploy, gate case: the Penti and Vero Moda 800x1200
      sources on Trendyol.
   b. `/upscale` endpoint on `catalog-matting-gpu` (same service, not a new one) running
      Real-ESRGAN x2plus as ONNX on the existing onnxruntime-gpu (BSD-3), colour through the model
      and alpha through Lanczos, JPEG response, used only when the enlargement exceeds 1.5x, behind
      an env flag (`UPSCALE_MODEL`, default off) with Lanczos plus sharpening as the fallback on any
      failure, outputs flagged `upscaled` (information, never a hold), `render_key` includes the
      upscaler so re-renders stay identical, no model name in UI copy or the sheet.
   c. Fidelity gate before enabling it (Fable 5.1, as a spec 10 check set): take golden photos of
      1,600 px or more, shrink 2x, restore with Lanczos plus sharpening, Real-ESRGAN x2plus, and at
      least one alternative open model (SwinIR or HAT) on the same endpoint; compare to the original
      on the product area: SSIM and LPIPS better than Lanczos plus sharpening, CIEDE2000 colour
      difference under 2, OCR and crop diff show no logo or label text change, no invented or
      flattened fabric texture, no halo at the cut-out edge; measure p50 and p95 seconds per photo
      on the L4, cold start, error rate, the real share of photos that need it, and identical bytes
      on a re-run. Pick the best candidate by these numbers; if none passes, test Topaz Precision
      (closed source, non-generative, about USD 470 per 1,000 products, photos leave GCP) only
      after the owner confirms that trade.
   d. Enable the winner per channel (Trendyol first), run the gate batches again, visual inspection
      of every upscaled output, record cost per product and per 1,000 in PROGRESS.md (baseline USD
      0.0049; Real-ESRGAN estimate +USD 0.0022), and the operator note in the hand-over.
   e. Owner decisions to record in SPEC.md as part of the spec: an upscaler is allowed in the default
      path behind the flag (the owner approved trying it); whether an x2 upscale may un-skip Styli
      (800x1200 sources would clear Styli's 1,482 px minimum) stays an OPEN owner decision, ask it
      in the status when (c) is done; no paid image API without a separate owner yes.
   Estimate: (a) 2 to 3 h; (b) and (c) 1.5 to 2 days; (d) half a day.
   Items A, B, E, F and G stay open until the owner says go.

## Time estimate for the remaining programme (made at hand-off)

About 8 to 10 hours of mostly machine time if the gate re-run passes and the eval and load runs
get their windows: gate re-run 1 h; eval run 3 3 to 4 h plus 1 to 2 h of reading, suite PR and
redeploy; live run 2 to 3 h and policy write; load and recheck 1 to 2 h; docs and report 30 min.
Each defect round adds about 3 hours. Items A to G are about three working days on top, if the
owner approves them.
