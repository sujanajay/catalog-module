# Go-live resume 4 (hand-off to session 5, same machine)

Written 2026-10-21 about 03:55 UTC by a docs subagent closing session 4. Session 4 (2026-10-20 16:43 UTC
to 2026-10-21 about 01:00 UTC) ended without a planned hand-off: an unplanned Windows update restart of the
laptop at about 01:00 UTC killed the manager's subagents and background watchers. The work in flight was
saved as WIP branches after the restart (see "State at hand-off"). Session 5 bootstraps from this file plus
`docs/PROGRESS.md` (on `main` once PR #64 is merged). `docs/plans/2026-10-20-go-live-resume-3.md` is
superseded; its rules still apply unless changed here.

Assumptions made while writing this file (no questions were asked): times are UTC from gh, job logs and the
session notes; the gate 3g verdict was written by a Fable reader after the restart (04:02 UTC) and is
recorded in full; the three WIP branches are untested and are treated as drafts, not as reviewed fixes.

## Prompt to start session 5 with

```
You are the manager for the catalog module go-live, session 5, on the same machine as session 4
(clone C:\Users\Sujan Ajay\Desktop\catalog-module, everything installed). First check gcloud:
if `gcloud auth print-access-token` fails (the login expires after a reboot), ask me to run
`gcloud auth login` and wait; that and an IAP sign-in are the only things to ask me. Read, in
full, from the clone after git pull: docs/plans/2026-10-21-go-live-resume-4.md (source of truth
for state, rules and the ordered next steps), docs/PROGRESS.md, CLAUDE.md, AGENTS.md,
docs/specs/00-execution-protocol.md. Work as session 4 did: you only coordinate; every task goes
through subagents; Fable 5.1 subagents for critical judgement and evaluation work (eval reading,
gate verdicts, fidelity and policy decisions), Opus 5.5 subagents for the rest (build, test,
fix, deploy, inspect, docs); expedite with parallel subagents without compromising quality; one
worktree per workstream under ..\catalog-module-wt\<slug>; conventional commits, no co-author
trailer, no em dashes; merge PRs with gh when CI is green; deploy with bash infra/deploy.sh from
the pinned worktree ..\catalog-module-wt\deploy and never move it while it runs; one heavy run
on the stack at a time; NEVER start a load test, an eval run or any multi-batch run while I may
be using the site: check the batch list for operator batches in the last 60 minutes and ask me
for a window first; every fix PR re-runs the gate case that found it; commit WIP before any long
run; log every assumption in PROGRESS.md on the docs worktree only; keep every checkout clean;
writes only under catalog-test/; never delete GCP resources; never read secrets. Post a status
update every 20 minutes with ScheduleWakeup and a push notification at each milestone. Follow
the resume file's "Next steps, in order" to the end, fix every defect through fix PRs,
redeploys and re-runs, and finish and close the project with the 00 section 10 report, the live
URL and "Programme complete; no next spec."
```

## This machine (session 4 findings; nothing to install)

- Everything in resume 3 "This machine" still holds: git 2.51.1, node 22.20.0, pnpm 9.15.0, python 3.13,
  gh signed in as sujanajay, Google Cloud SDK 589.0.0 for sujan@opptra.com, gcloud NOT on PATH (in every Git
  Bash call `export CLOUDSDK_CORE_PROJECT=image-links-agent` and
  `export PATH="/c/Users/Sujan Ajay/AppData/Local/Google/Cloud SDK/google-cloud-sdk/bin:$PATH"`), Git Bash
  `C:\Program Files\Git\bin\bash.exe`, IST clock (take UTC from logs and `date -u`), Playwright with the saved
  IAP state `apps/web/.playwright/auth-state.json` (check with `pnpm exec tsx .playwright/verify.ts`).
- NEW: the gcloud login expired with the restart (2026-10-21 about 01:00 UTC); only the owner can run
  `gcloud auth login`. Check it before anything that touches GCP. The IAP state may also need a re-login
  (`human:login`, the owner signs in with sujan@opptra.com).
- NEW: a Windows update restart kills every subagent and every background watcher; nothing resumes on its
  own. Commit and push WIP before any run longer than about 20 minutes.
- NEW: a subagent cannot wait more than about 20 to 30 minutes for a job; split long waits into a poll by
  the manager (ScheduleWakeup) and a fresh reader subagent when the result lands.
- Docker is not running on this machine (not needed: builds run in Cloud Build).
- Worktrees: `..\catalog-module-wt\deploy` (pinned, detached; it was at `8bfbd04` for D1),
  `..\catalog-module-wt\docs-progress` (branch `docs/go-live-progress-4`, PR #64; session 5 creates
  `docs/go-live-progress-5` the same way after #64 is merged).
- Session 4 scratchpad (local, lost if the temp folder is cleaned):
  `C:\Users\SUJANA~1\AppData\Local\Temp\claude\c--Users-Sujan-Ajay-Desktop-catalog-module\ed303dca-fad3-4a8a-aa56-fa8d81f73dd2\scratchpad\`
  with `evals-run3\` (all eight set analyses, `RUN3.md`, evidence crops), `enh-d\run\` (fidelity gate,
  `GATE-VERDICT.md`), `qa-gate-3g\` (gate 3g measurements, NOT yet uploaded).
- Evidence of session 4 in the bucket: `gs://image-links-agent-assets/catalog-test/handoff/2026-10-20/evidence/session4/`
  (`qa-gate-3f/`, `enhancement-gate/`); `qa-gate-3g/` is owed (step 1).

## State at hand-off (2026-10-21, about 03:55 UTC)

- `origin/main` = `aed157a`. Merged in session 4, in order: #65 spec 11 docs (`cbaeaca`), #67 spec 11 image
  enhancement code (`a99daea`, supersedes the closed #66), #68 busy-background fix for clean close-ups
  (`8bfbd04`), #69 eval suite calibration 1 (`0262f61`), #70 sole strip recovery (`aed157a`, merged
  2026-10-21 03:45 UTC after the restart). PR #66 closed as superseded.
- Live = D1 `8bfbd04` (deployed 20:07 UTC): `catalog-worker-00019-cdg`, `catalog-web-00018-dx7`,
  `catalog-matting-00014-ql5`, `catalog-matting-gpu-00014-5b5`, `UPSCALE_MODEL` off. NOT deployed: #69 (eval
  code, it runs in the job image) and #70.
- Live URL: https://catalog-web-847405579637.asia-south1.run.app
- Eval run 3 (mocked) is complete: `t26kp` (19:46 UTC, 45,110 of 46,877 checks pass, 2 products need
  attention) and `hg7bc` (20:02 UTC, 41,723 of 43,274, 1 product); all 8 set records and both `report.json`
  exist; all 8 sets read by Fable. Real defects: busy false hold (fixed by #68), lime sole sliver (fixed by
  #70), and three NEW ones, not fixed on main:
  1. translucent "ghost" matte published (penti `ZBE55F7B86F158FEA0EB9Z` shot 5, 8 channels: matte alpha about
     40 to 60 everywhere; the guard counts only alpha <= 10 as dropped and > 128 as kept, and the
     frame-filling branch returns early);
  2. ragged pass-through on white-on-near-white (vero_moda `Z40E29CD878FAA726501DZ` shot 1, 8 channels: the
     pass-through's border flood grew into the white top);
  3. tinted-table size chart published (penti `Z659062EFB3FB0720BF56Z` drive shot 7 and its planted copy, 16
     outputs: `detectTextImage` misses the pink header and the tinted cells).
- Spec-vs-code reading for the owner: standing wide bags and candles get no synthesised shadow because
  `shadow.ts` tests box.h > box.w while SPEC.md says "upright pose" (OPEN decision; the outputs are
  acceptable without one).
- Suite items beyond #69 (from `ANALYSIS-penti_model.md`, `ANALYSIS-vero_moda.md`, `ANALYSIS-small-sets.md`):
  flush not run on a pass-through, canvas strips subtracted in the estimate, a `cutout.opaque_share` check,
  manifest shots mapped by source sha256, chart flags in the manifest, the kept-shadow mask in halo and
  footprint, fringe not run on thin structures, `background_kept` on pass-throughs, duplicate sources counted
  once, `shadow.expected_synthesis` as information, product-level completeness rows.
- Bake-offs: footwear `birefnet-general` stands; apparel and bag sets inconclusive until the softness bar
  change (in #69) is re-read on the live run; no bag policy row (under 10 sources per set; 13 bag sources
  across the two sets).
- WIP branches pushed after the restart (uncommitted work saved; none tested, none has a PR):
  - `fix/matte-translucent-and-passthrough-flood` `4b7ccbc` (defects 1 and 2): `matte-guard.ts` +123/-30 with
    `GUARD_OPAQUE_ALPHA`, `passthroughGuide`, `passthroughProductLoss`; no unit tests; debug scratch files
    `packages/core/src/catalog/zz-*.ts` and `zz-*.real.test.ts` must be removed.
  - `fix/chart-detector-tinted-table` `ceceb71` (defect 3): `matte-guard.ts` +170/-22 with `TEXT_TINT_*`,
    `textMarks`, `textLines`; tests and a spec note added; scratch files `zz-chart.real.test.ts` and
    `zz-guard-orig.ts` to remove. Both matte branches touch `matte-guard.ts`: expect a merge conflict.
  - `fix/evals-run3-calibration-2` `d097e03` (suite PR 2): 14 files +335/-49 across the evals checkers, the
    worker CLI and the golden fixtures; no tests yet.
- Fidelity gate (spec 11 D, run `enh-20261020201359-43bfe5`, 20:14 to 20:20 UTC on the L4): none passes the
  absolute bars; realesrgan-x2plus is worse than the baseline on every fidelity metric (dropped); swinir-x2
  beats the Lanczos plus sharpening baseline on every bar (SSIM 0.9318 vs 0.8799, stand-in LPIPS 0.0494 vs
  0.0780, dE mean 1.29 vs 1.78, halo 2.69 vs 5.68, text regions faithful, deterministic, 0 errors) and fails
  only dE < 2 on 3 photos and texture flags 22.5%, bars the baseline fails worse. The golden set has no photo
  above 1,200 px, so the run restored 400x600 to 800x1200 (harder than real use). Production-size time per
  800x1200 photo: realesrgan 2.24 s, swinir 5.59 s; cost per product on a Trendyol mix +USD 0.0042 and
  +USD 0.0097 (+198% on the USD 0.0049 baseline); cold start from zero over 60 s. `UPSCALE_MODEL` stays off;
  the owner has the choice "enable swinir" (OPEN).
- Gate 3g (b1 and b3 re-run on D1, 20:22 to 20:33 UTC): b1 `577e9479` 80 made 0 held, b3 `e6344b62` 144 made
  0 held; Fable verdict (`scratchpad\qa-gate-3g\VERDICT-3g.md`): b1 PASS, b3 PASS: `Z02B2EE44E3A08044B816Z`
  published on all 8 channels as a strip-free pass-through, flush where the aspect allows and fitted with
  truthful band notes elsewhere (both gate 3f defects verified fixed live); every other output within 5 px of
  3f; 0 model-name hits; cost lines USD 0.0219 and 0.0282. NEW medium finding: the spec 11 sharpening has NO
  effect on model-matted cut-outs (every cut-out output is byte-identical or within JPEG noise of its
  unsharpened 3f twin; only the whole-photo pass-through Z91D shot 4 is sharpened, MAD 0.55, gradient +5.1%):
  `enhance.ts` enlargeCutout adds the delta only where the resized alpha is exactly 255, which model-matte
  interiors and the Lanczos resize of a soft matte never reach, so the delivered Trendyol, Centrepoint,
  6thStreet and Amazon images are plain Lanczos as before D1. Low: a 2 px top band on Noon and Namshi img 6
  of Z02B2 carries a band note (snap to flush or suppress notes under a few px); shots 1 (hand-held) and 2
  (feet on the edge) are editorial, as in 3d. Evidence local only (`scratchpad\qa-gate-3g\`).
- Owner decisions OPEN (list them in every status; build nothing until the owner says go): A fair sharing, B
  throughput fixes, E 2x shape, F 1,000-product measurement, G upload fixes, Styli un-skip, swinir
  enablement, upright-shadow pose for wide bags and candles, bands with a whole logo vs flush on the square
  channels, the throughput plan (`docs/plans/2026-10-21-throughput-7000.md`, PARKED: "not now").

## Rules carried over and added

- Everything in resume 3 "Rules carried over and added" (and resume 2's) still applies, including the
  60-minute batch guard before any eval, load or multi-batch run and before any deploy.
- Subagent models: Fable 5.1 for critical judgement and evaluation work; Opus 5.5 for the rest. Every task
  goes through subagents; run independent workstreams in parallel.
- Commit and push WIP before any long run and before handing a long wait to a subagent; a restart loses
  everything uncommitted and every running subagent.
- No subagent waits more than about 20 minutes; the manager polls long jobs and starts a fresh reader.
- A WIP branch is a draft: a builder re-reads it, removes the `zz-*` scratch files, adds tests and runs the
  offline regression before any PR.
- gcloud auth check (`gcloud auth print-access-token`, output never printed) at the start and after any
  reboot.

## Next steps, in order

1. Prerequisites (0:20): `git pull --ff-only`; `pnpm install --frozen-lockfile`; `pnpm lint`, `pnpm typecheck`,
   `pnpm test` on main (expect 103 files / 1,069 tests or more); create the docs worktree on
   `docs/go-live-progress-5` and open its draft PR; gcloud auth check (ask the owner to log in if expired);
   `pnpm exec tsx .playwright/verify.ts`; upload the gate 3g evidence folder (`scratchpad\qa-gate-3g\` to
   `gs://image-links-agent-assets/catalog-test/handoff/2026-10-20/evidence/session4/qa-gate-3g/`); confirm the
   live revisions match D1.
2. Finish the WIP and the sharpening fix (about 2:00, in parallel): Opus builders, one per matte branch, each removes the scratch
   files, adds unit tests, runs the offline regression against the deployed matting services (the 265 photos
   x 8 policies of #68: ZBE55 shot 5 must leave the ghost path, Z40E29 shot 1 must stop flooding or hold, the
   Z659062 chart must be left out as `chart_image`, the court and the lifestyle candle still held, nothing
   else changed), PR, CI, merge. Merge order: chart first, then ghost and pass-through rebased on it (both
   edit `matte-guard.ts`). In parallel a Fable builder finishes suite PR 2 from
   `fix/evals-run3-calibration-2` (tests, offline re-evaluation of the run 3 records, spec 10 section 15
   sentences), PR, CI, merge. Also in parallel (Opus, small, about 0:45): fix the sharpening on cut-outs
   in `enhance.ts` enlargeCutout (apply the delta for alpha above a threshold such as 250, or on the matte
   interior eroded by 1 px), a unit test with a real-like soft matte, PR, CI, merge; optionally snap a 1 to
   2 px band to flush (low). The b1 Trendyol gate case is re-run on D2 in step 5.
3. Deploy D2 (0:35): `aed157a` plus the PRs of step 2, from the pinned worktree after the batch guard; smoke;
   record the revisions in PROGRESS.md "Deployed state". After suite PR 2, re-upload the golden manifest
   (manifest-only `gcloud storage cp`).
4. Live eval run (2:30): `bash infra/catalog-output-evals.sh run --live --write-policy` as two parallel
   executions of 4 sets each, in an owner-approved window or after a clear 60-minute guard; a Fable reader
   per set as records land; record the chosen cut-out model per product type in PROGRESS.md only (never in
   UI copy); any real defect gets one more fix round.
5. Gate re-run on D2 (1:00): b3 and b1 with the new suffix `-qg3h`, full checklist, plus a Fable verdict;
   it must show the sharpening on the b1 Trendyol cut-outs (pixel diff against 3g, no halo).
6. Only if the owner says "enable swinir" (1:00): set `UPSCALE_MODEL=swinir-x2` in the `infra/deploy.sh`
   env, `SKIP_BUILD=1` deploy (about 15 min) plus a gate re-run of b1 and b2 with inspection of every
   upscaled output; cost per product and per 1,000 in PROGRESS.md; the operator note in the hand-over.
7. Load (1:15): `bash infra/catalog-scale-jobs.sh load 270` and `recheck batch <id>`, alone on the stack in
   the owner's window; an Opus subagent writes throughput, errors, spend and recheck counts into PROGRESS.md
   and `docs/handover/catalog-for-the-operator.md`.
8. Docs (0:30): PROGRESS.md final rows, task board, session summary, hand-over figures, `docs/solutions/`
   entries (the reboot lesson, the gcloud re-login, the subagent wait limit); merge origin/main into the docs
   branch; `gh pr ready`; CI; squash-merge with a conventional subject and no co-author.
9. Memory note; final 00 section 10 report with the live URL and "Programme complete; no next spec."; push
   notification.

## Time estimate for the remaining programme (made at hand-off)

About 7 to 8 hours of mostly machine time with parallel subagents, plus the owner's windows (the 0:45
sharpening fix runs inside step 2's 2:00 window); each extra defect round about 1.5 h.
