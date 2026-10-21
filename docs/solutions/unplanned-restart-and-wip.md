# Unplanned restart and work in progress - learnings

## What happened
On 2026-10-21 at about 01:00 UTC a Windows update restarted the operator laptop in the middle of
session 4. Every running subagent (three builders, a gate verdict reader) and every background watcher
died with it, and nothing resumed on its own after the reboot. Nothing on GCP was mid-write: no
deploy, eval or load execution was running at the time.

The uncommitted work in the builder worktrees survived on disk. After the restart it was pushed as
three WIP branches, none tested and none with a PR:
- `fix/chart-detector-tinted-table` (chart detector for tinted-table size charts),
- `fix/matte-translucent-and-passthrough-flood` (translucent mattes and the pass-through flood),
- `fix/evals-run3-calibration-2` (eval suite calibration from run 3).
Two of them edited the same file (`matte-guard.ts`), so a conflict was expected, and two still held
debug scratch files (`zz-*`).

## Why it hurt
- A subagent lives only as long as the session; a restart loses its context, its plan and anything
  it had not written to disk.
- Work that is only on disk is one cleaned folder or one lost laptop away from gone, and a new session
  cannot see it unless someone knows where to look.
- Without a written list of next steps, the new session has to rebuild the state from logs.

## What to do
- Commit and push WIP to its branch before any run longer than about 20 minutes, and before handing a
  long wait to a subagent. A WIP commit costs seconds; the restart costs the session.
- Keep a resume file in `docs/plans/` with the machine quirks, the state at hand-off, the rules and
  the ordered next steps, so a fresh session can bootstrap from it alone (session 5 started from
  `docs/plans/2026-10-21-go-live-resume-4.md`).
- A WIP branch is a draft and is never merged untested. In session 5 a builder re-read each branch
  critically, removed the scratch files, added tests, rebased where needed and ran the offline
  regression before opening a PR. The three branches landed as PR #74 (chart detector), PR #75
  (translucent mattes and the pass-through flood) and PR #73 (eval calibration 2).
- After any reboot, also re-check the gcloud login (see `gcloud-login-after-reboot.md`).
