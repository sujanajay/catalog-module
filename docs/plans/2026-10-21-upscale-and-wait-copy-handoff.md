# Hand-off: upscaler on for every channel, Styli un-skip, and honest waiting copy

Written 2026-10-21 (session 5 follow-up) for a fresh Claude Code session. This file is the source of truth for
that session. It replaces nothing: `docs/SPEC.md`, `docs/specs/11-image-enhancement.md` and
`docs/PROGRESS.md` still apply. Read `CLAUDE.md` and `AGENTS.md` first; every rule there holds.

## 1. Why (the owner's words, 2026-10-21 about 14:30 UTC)

- A small operator batch (56bb7072, Penti, 5 photos of 800x1200, Noon + Styli + Centrepoint) looked "stuck at
  processing" and produced nothing for Styli.
- Investigation (two read-only subagents, evidence under the session scratchpad, summary in section 3): the
  batch was not stuck, it finished in 3.5 min; 2.5 min of that was the matting services' cold start with the
  page showing "0 of 10 images made" and no reason. Styli skipped all 5 photos by the recorded low-resolution
  rule, and the Ready banner never said so.
- Owner decisions, taken: (1) turn the upscaler ON, for every channel wherever a photo must be enlarged, not
  only for Styli; cost is not a concern; (2) the Styli skip must judge the upscaled size, so these photos get
  made for Styli; (3) the page must tell the operator what is happening while they wait, give a time estimate,
  say they can leave, and show a progress bar once images are being made.
- The owner wants the simplest change that really works, no exhaustive testing, no unnecessary steps, but
  thorough enough that it is verified working on the live site this time.

## 2. Scope (build exactly this)

### A. Upscaler on, everywhere it applies

1. Make `swinir-x2` the default upscaler in `infra/deploy.sh`: change line 176 from `UPSCALE_MODEL=${UPSCALE_MODEL:-}`
   to default `swinir-x2`, so a later deploy does not silently switch it off again (today the env var is only
   written when set, lines 278-282). Keep the "off" path reachable with `UPSCALE_MODEL="" bash infra/deploy.sh`
   is NOT required; `UPSCALE_MODEL=off` may be added as an explicit off value if cheap. Update the comment at
   lines 170-175 and the `docs/specs/02` env table row if one exists.
2. `UPSCALE_MIN_SCALE` stays 1.5 (upscale.ts:14, channels.ts:206 MAX_UPSCALE). The render already upscales any
   channel whose plan enlarges beyond 1.5x (render.ts:541, `shouldUpscale`), the x2 image is made once per photo
   and shared by all channels. So "every channel" needs no render change beyond the Styli rule below. Confirm
   this by reading render.ts:455-550 and `upscale.ts`, and say so in the PR.
3. The GPU matting service (`catalog-matting-gpu`, region asia-southeast1, see deploy.sh:22 and 256-263) serves
   `/upscale`; its `/health` lists `upscale.models`. Verify with a read-only `/health` call through the worker's
   auth pattern or `gcloud run services describe` that `swinir-x2` is listed before relying on it. Spec 11
   section 4.2 has the service contract.

### B. Styli judges the upscaled size

1. `render.ts:461` computes `lowResolution = fit(min) > MAX_UPSCALE` from the ORIGINAL pixels and `render.ts:504`
   skips Styli before the upscaler runs at `render.ts:541`. Change: when an upscaler is configured
   (`input.upscaler` non-null), the Styli skip test uses the enlargement that remains AFTER the x2 upscale
   (`fit(min) / UPSCALE_FACTOR > MAX_UPSCALE`). If the upscale call fails at render time (upscale.ts falls back
   to the plain path), the output must still be made (do not skip retroactively); flag `low_resolution` and
   keep the existing "may look soft" note.
2. Keep the skip for photos that are too small even after x2 (so a 400x600 photo is still skipped for Styli with
   the same note). The note text "Skipped for Styli: the photo is smaller than Styli needs." stays unchanged
   (evals depend on it, completeness.ts:9).
3. Mirror the rule in the wizard warning (`ingest/group.ts:383-396`, `STYLI_MIN_SOURCE_HEIGHT_PX` 1482 at
   channels.ts:210): with the upscaler on, the threshold is half (741 px). Simplest: derive the threshold from
   whether `UPSCALE_MODEL` is set, through the same env read as `upscale.ts:24-28`; the web app must see the same
   env value, so add `UPSCALE_MODEL` to the web service env in deploy.sh as well, or pass the threshold from the
   worker's health into the preview. Pick the simplest that keeps wizard and render consistent and say which.
4. Mirror in the evals (`evals/completeness.ts:50`) and the cost line's Styli skip count (grep `skipped` in the
   cost module) so they use the same threshold function. One exported function in channels.ts,
   `styliMinSourceHeightPx(upscaleFactor)`, used by all three sites, is the intended shape.
5. Bump `CHANNEL_RULES_VERSION` (channels.ts, today 9 -> 10) so products re-render on their next upload.
   Record in `docs/SPEC.md` R8 / lines 106-108 and 173-175 that the Styli agreement now applies to the
   upscaled size, and close the open items at SPEC.md:52 and spec 11 lines 357-358 ("x2 un-skips Styli") with
   the owner's decision and date.
6. Model ids never appear in UI copy (AGENTS.md). The flag `upscaled` and `UPSCALED_SENTENCE` (types.ts) already
   handle the note; do not add the model name anywhere operator-facing.

### C. Honest waiting copy and ETA

Files: `packages/core/src/catalog/pipeline/status.ts` (lines 19, 31-38, 44), `apps/web/components/catalog/BatchBanner.tsx`
(lines 7-19), `apps/web/app/catalog/[id]/page.tsx:63`, `apps/web/lib/catalog/copy.ts` (33-36, 63-68),
`apps/web/components/catalog/WizardStep4.tsx:8-10`. Quote-level findings in section 3.

1. Step 4 (before Start): add "This usually takes about {L} to {H} minutes. After you press Start you can close
   this page; the batch keeps going, and you can come back to it any time from All batches."
   ETA rule (pure function in status.ts next to `deriveBatchState`): images = planned outputs from step 4;
   L = ceil(1 + images/120), H = ceil(4 + images/90) minutes. Checks: 10 images -> 1 to 5 min (measured 1 and
   3.5); 5,032 images -> 43 to 60 (measured 43). Add "Another batch is running; yours may wait behind it." when
   any other batch is processing (the list query at apps/web/lib/catalog/batches.ts already knows).
2. Processing banner: keep the existing progress bar (status.ts `progress`), and make the text
   "{done} of {planned} images made · about {L} to {H} min left. You can close this page and come back; nothing
   stops." Compute the range on the server from `startedAt` and the made count (survives reloads; today the ETA
   lives only in browser snapshots, BatchBanner.tsx:7-15, and effectively never shows on 1-product batches).
   Before 10% is made show the range; after that "about N min left" from the measured rate. Move the
   "You can close this page" sentence from page.tsx:63 into the banner (keep it in the card too if trivial).
3. Before the first image (made = 0 and the batch is in matting or chunking): add the line "Starting the image
   services. The first pictures usually take a minute or two on the first batch after a quiet spell."
4. Ready banner (status.ts:44): when skipped > 0 say "All {n} images are live and passed every check.
   {k} Styli images were not made because the photos are too small for Styli even after enlargement (see the
   notes column)." Today the Ready banner hides the skip entirely.
5. Collecting (copy.ts:63-68): "Copying your files. Processing starts by itself. You can close this page."
6. Unit tests in status.test.ts for: the ETA range function (the two checks above), the made = 0 line, the Ready
   skip clause, and the banner text with and without `startedAt`.

### Explicitly NOT in scope (deferred, note them in PROGRESS.md "deferred" row)
- Worker cold-start changes: `MattingClient.health()` waiting for both services (matte.ts:130-139), pre-warming
  at upload, the endless finalize loop on old batches (finalize.ts:32-37, batch b489e466). Noted as findings;
  the owner chose copy over worker changes for now. Do them only if the owner asks.
- Email or push on completion.
- Any eval suite re-calibration. Run the suite only if a test in it breaks from the Styli rule change (completeness).

## 3. Facts the new session should not re-derive

- Live = D3 commit `c73eefe`: catalog-worker-00021-t2v, catalog-web-00020-ghr, catalog-matting-00016-jcz,
  catalog-matting-gpu-00016-j5p; `UPSCALE_MODEL` unset, `UPSCALE_MIN_SCALE=1.5`. main = `c9a1afb`, two commits
  ahead (#79 evals calibration 3, #80 guard log line, #81 classifier back-off), all CI green, none deployed.
  The next deploy from main takes them live; that is intended.
- Batch 56bb7072 (operator, sujan@opptra.com, brand penti, "sujan test 388"): created 13:35:46 UTC, Start
  13:36:19, done 13:39:49. 1 product Z3CB249D65FEB10FC95A6Z, 5 photos 800x1200 72 dpi, 15 outputs planned,
  10 verified, 5 skipped (all Styli), 0 held, 0 failed. Noon and Centrepoint published; Centrepoint enlarged
  2.5x with the low_resolution information note. Styli needs min(2042/800, 2223/1200) = 1.85x > 1.5 -> skipped.
  With x2 the remaining factor is 0.93x, so the same photos pass.
- Timeline of the "stuck" look: first chunk task received 13:36:19 and returned 200 after 146.8 s; the worker's
  health check waited 122 s for catalog-matting (CPU) and 74 s for catalog-matting-gpu, both "Starting new
  instance"; first `/matte` at 13:38:25 (11 s, bria-rmbg loads on first use); the rest took under 1 s each.
  No retries, no 429, no lock, no exception, no timeout (worker timeout 900 s). The CPU service's cold start took
  73 to 122 s about 100 times between 10-18 and 10-21; the long waits on 10-20 (18 to 31 min) were operator
  batches queued behind the 270-product load test (PROGRESS.md:47), a different cause.
- Spec 11 results for swinir-x2 (PROGRESS.md:55, run enh-20261020201359-43bfe5): best candidate on every
  measure, deterministic, no errors; failed the absolute bars on colour accuracy for 3 photos and texture loss on
  22.5% (test was 400x600 restored to 800x1200, harder than real use); +USD 0.0097 per product (+198%) on a
  Trendyol mix; 5.59 s per 800x1200 photo; GPU cold start over 60 s. Owner now accepts the cost.
- Evidence from the investigations (session scratchpad, may not survive): batch.json, batches.json, logs-batch.txt,
  logs-window.json under `stuck-batch-56bb7072\`; batch.json, preview.json, sheet.csv, page-text.txt, overview.png,
  Sheet.png, src\ (the 5 raw photos) under `styli-upscale\` in
  `C:\Users\SUJANA~1\AppData\Local\Temp\claude\c--Users-Sujan-Ajay-Desktop-catalog-module\229837d4-14df-4da8-bbdc-da8090231cf4\scratchpad\`.
- Read-only tooling that worked: `apps/web/.playwright/g3d-get.ts` for GET calls against the live API with the
  saved IAP state `apps/web/.playwright/auth-state.json` (set `MSYS_NO_PATHCONV=1` in Git Bash or "/api/..."
  becomes a Windows path); `apps/web/.playwright/lock-holder-batches.ts` lists batches; gate drivers
  `g3h-run.ts` / `g3h-scan.ts` (git-ignored) create and scan Test Brand batches.
- gcloud is NOT on PATH. Every Git Bash command: `export CLOUDSDK_CORE_PROJECT=image-links-agent; export PATH="/c/Users/Sujan Ajay/AppData/Local/Google/Cloud SDK/google-cloud-sdk/bin:$PATH"`.
  The gcloud login expires after about a day and after a reboot; only the owner can run `gcloud auth login`.
  Machine clock is IST. Docker is not running; images build on Cloud Build via deploy.sh.
- Deploy only from the pinned worktree `..\catalog-module-wt\deploy` with `bash infra/deploy.sh` (build, migrate,
  remote smoke, services, queues, jobs; about 35 min; a transient `next/font` build failure is known, re-run once).
  `git fetch && git checkout --detach <sha>` there first. Record revisions and the smoke evidence prefix in
  PROGRESS.md "Deployed state". The `catalog-test-cleanup` job is not updated by deploy.sh (not needed here).
- Learnings already written: `docs/solutions/unplanned-restart-and-wip.md`, `gcloud-login-after-reboot.md`,
  `subagent-wait-limit.md`, `live-judge-rate-limits-and-refusals.md`.

## 4. Order of work

1. Prerequisites: `gcloud auth print-access-token > /dev/null` (ask the owner to run `gcloud auth login` if it
   fails); `pnpm install --frozen-lockfile && pnpm typecheck && pnpm test` on main (expect 103 files, about
   1,138 tests); `pnpm exec tsx .playwright/verify.ts` in apps/web. Create the docs worktree
   `..\catalog-module-wt\docs-progress-6` on branch `docs/go-live-progress-6` and add a bootstrap row to
   PROGRESS.md. Commit this hand-off file on that docs branch (it is untracked in the main clone right now).
2. One feature branch `feat/upscale-on-and-styli-x2` in worktree `..\catalog-module-wt\upscale-styli` for scope A
   and B; one branch `feat/batch-wait-copy-and-eta` in worktree `..\catalog-module-wt\wait-copy` for scope C.
   They touch different files; build them in parallel with two Opus subagents. Each PR: conventional subject,
   no co-author trailer, no em dashes, the 00 section 8 body, CI green, squash-merge with gh, delete branch and
   worktree.
3. Tier 1 and 2 tests only (unit tests named above plus the existing suites). Add one render test: an 800x1200
   source, Styli, with a fake upscaler -> output made with flag `upscaled`; same source without an upscaler ->
   skipped with the agreed note; a 400x600 source with the upscaler -> still skipped.
4. Deploy main (after both merges) from the pinned worktree with `UPSCALE_MODEL=swinir-x2` now the default.
   Check the batch guard first (no operator batch created in the last 60 minutes, or ask the owner for a
   window). Confirm the worker env shows `UPSCALE_MODEL=swinir-x2` in the deploy.sh summary (line 423) and in
   `gcloud run services describe catalog-worker`.
5. Verify on the live site, the way the owner did:
   a. Wait until the matting services have been idle for 20 minutes (or do this first thing after the deploy's
      smoke, which already woke them, and note that the cold-start line could then not be observed).
   b. Create ONE Test Brand batch through the wizard or the gate driver: 1 product, the same five 800x1200
      Penti photos (copies are under the scratchpad `styli-upscale\src\`; if gone, any five 800x1200 photos),
      channels Noon, Styli, Centrepoint, name suffix `-upscale-check`.
   c. Expect: step 4 shows the time range and the "you can close this page" sentence and NO "smaller than Styli
      needs" warning for 800x1200; during the run the banner shows the "Starting the image services" line
      while made = 0, then the progress bar with "about L to H min left"; the batch ends Ready with 15 made and
      0 skipped; the sheet has Styli Image 1-5 links; every Styli and Centrepoint output carries the `upscaled`
      flag and the model-free "enlarged" sentence; every link returns 200 anonymously; the batch's cost line
      is higher than before and recorded.
   d. Open at least two Styli outputs and one Centrepoint output at full size and look at them: no halo, no
      colour shift against the source, text on labels readable. Save the screenshots and the batch JSON under
      `gs://image-links-agent-assets/catalog-test/handoff/2026-10-21/evidence/upscale-check/`.
   e. Re-run gate case b1 (Penti) as a Test Brand batch with the gate driver and confirm 0 held and all links
      200, since every enlargement above 1.5x now goes through the upscaler. That is the only gate re-run.
6. Docs: PROGRESS.md rows (decision, PRs, deploy, verification with numbers, cost per product measured on the
   check batch, the deferred worker cold-start items); `docs/handover/catalog-for-the-operator.md`: a short
   section "Small photos and Styli" (what happens now, the 741 px floor) and update section 16/17 timings if
   they changed; close the SPEC.md open items. Merge the docs PR last.
7. Close with the 00 section 10 report, the live URL https://catalog-web-847405579637.asia-south1.run.app and
   "Programme complete; no next spec."

Estimated time: about 5 to 6 hours of mostly machine time (two PRs 2 h in parallel, deploy 35 to 50 min, live
check 30 min, gate b1 30 min, docs 30 min).

## 5. Rules that bit us before (keep them)

- Never start a heavy run (load test, eval suite, multi-batch) while the owner may be on the site; check the
  batch list for operator batches in the last 60 minutes and ask for a window. The single check batch and the
  b1 re-run are small; still check the list first.
- Commit and push WIP before any run longer than 20 minutes (a Windows update rebooted the laptop once).
- Subagents cannot wait more than about 20 minutes; the manager polls with ScheduleWakeup.
- Never delete GCP resources, never read secret values, writes only under `catalog-test/`.
- Keep every checkout clean; the main clone has untracked IDE folders (`.claude/skills/`, `.cursor/`,
  `meetings_folder/`) that are not ours; leave them.
- Status to the owner every 20 minutes and a push notification at each milestone (PRs merged, deploy live,
  live check passed, final report).
