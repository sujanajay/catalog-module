# Go-live runbook

This is what you (the owner) do on the new laptop to take the catalog module live. You run a few
setup commands, start Claude Code, paste one prompt, and then wait for the final report. Claude
Code does the building, testing, merging and deploying on its own and records every step in
`docs/PROGRESS.md`.

All commands are for Windows PowerShell. Each step says which folder to run it in. To open
PowerShell in a folder: open the folder in File Explorer, click the address bar, type
`powershell` and press Enter.

## Words used in this runbook

- **Repository (repo)**: the project folder, with its full history, kept by Git.
- **Clone**: download a full copy of the repo from GitHub to your laptop.
- **Branch**: a separate line of work inside the repo. `main` is the live line.
- **Pull request (PR)**: a request on GitHub to bring one branch's changes into `main`.
- **Merge**: accept a PR so its changes land on `main`. A "squash merge" folds all its commits into one.
- **CI (continuous integration)**: the automatic checks GitHub runs on every PR (lint, type check, tests).
- **Deploy**: put the new version on Google Cloud so people can use it.
- **Cloud Run**: the Google Cloud product that runs the catalog web app and its background jobs.
- **Revision**: one deployed version of a Cloud Run service. Each deploy creates a new one.
- **IAP (Identity-Aware Proxy)**: the Google sign-in gate in front of the web app.
- **Smoke test**: a short end-to-end check that runs before a deploy is allowed to finish.
- **Worktree**: a second folder checked out from the same repo on another branch, so several
  pieces of work can happen side by side.
- **Manager session**: the Claude Code window you start. It only coordinates.
- **Subagent**: a helper that the manager session starts for one piece of work.
- **Environment variable**: a named setting that programs read from the system, like `REAL_DATA_DIR`.
- **Rollback**: go back to the previous working version.

## 1. Install the tools (once)

Install these on the new laptop:

- **Git**: https://git-scm.com/download/win (this also installs Git Bash, which the deploy script needs).
- **Node.js 22 or newer** (the repo was built on 24.19): https://nodejs.org
- **pnpm 9.15.0** (the package manager this repo uses). Run in any folder:

  ```powershell
  corepack enable
  corepack prepare pnpm@9.15.0 --activate
  ```

- **Google Cloud SDK** (the `gcloud` command): https://cloud.google.com/sdk/docs/install. Then
  sign in as sujan@opptra.com. Run in any folder:

  ```powershell
  gcloud auth login
  gcloud auth application-default login
  ```

  Do not change the default project. The repo's scripts pick the right project themselves.

- **GitHub CLI** (the `gh` command): https://cli.github.com. Then sign in as sujanajay. Run in
  any folder:

  ```powershell
  gh auth login
  ```

- **Claude Code** (the `claude` command).
- **Chrome**, for the browser test.
- Docker is optional and not needed for this run.

## 2. Clone the repo

Put the clone in a folder that can also hold a sibling folder `catalog-module-wt` (the subagents
create their worktrees there, beside the clone). The Desktop is the usual choice. Run in
`C:\Users\<you>\Desktop`:

```powershell
git clone https://github.com/sujanajay/catalog-module.git
```

You now have `C:\Users\<you>\Desktop\catalog-module`. Every later step that says "repo root"
means this folder.

## 3. Copy the real photos

The end-to-end test uses real product photos. Copy this folder from the old laptop:

- `C:\Users\Sujan AH\Desktop\opptra-image-links` (it holds `new_resources_4\Images`, 630 Anta
  photos, and `new_resources_3\French Connection Final`, 3,280 photos).

Put it at the same place on the new laptop (`C:\Users\<you>\Desktop\opptra-image-links`). If you
put it anywhere else, tell the programs where it is by setting an environment variable. Run in
any folder, then close and reopen PowerShell:

```powershell
[Environment]::SetEnvironmentVariable("REAL_DATA_DIR", "D:\wherever\opptra-image-links", "User")
```

The smoke test that runs during a deploy does not need these files; it uses copies already
stored in Google Cloud.

## 4. First checks

Run in the repo root, one command at a time. Each must finish without a red error:

```powershell
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
gcloud auth print-access-token | Out-Null
gh pr list
```

`gh pr list` should show PR #11 and PR #12 (and the docs PR that added this runbook, if it is not
merged yet). If any check fails, stop and read the error before going on.

## 5. Merge the docs PR (only if it is still open)

The plan, the progress file and this runbook arrive through one docs PR. If `gh pr list` still
shows it, merge it yourself, then update your copy. Run in the repo root (replace `<n>` with the
PR number from `gh pr list`):

```powershell
gh pr merge <n> --squash --delete-branch
git pull
```

## 6. Start the run

As of 2026-10-20 the programme is resumed, not started: specs 05 to 10 are merged and deployed,
and the remaining steps are in docs/plans/2026-10-20-go-live-resume-2.md on branch
docs/go-live-progress. That file holds the exact prompt to paste and the prerequisites the
session installs itself (sections 1 to 4 above are then optional: the session does them).
Run in any empty folder:

```powershell
claude
```

Then paste the prompt from the section "Prompt to start the new session with" of that file.
To see where the run is at any moment, open docs/PROGRESS.md on that branch.

## 7. What you may still need to do by hand

The final report lists anything only a person can do. Typical items:

- add a new secret version in Google Cloud Secret Manager;
- grant a Google Cloud role that the session reports as denied;
- share a Google Sheet;
- add the catalog operator in the People window of the app.

Do these, then start the run again as described below.

## If the session stops

If Claude Code closes, crashes, or runs out of room, nothing is lost: `docs/PROGRESS.md` records
what is done. Run in the repo root:

```powershell
git pull
claude
```

Then paste the same start prompt from step 6. The new session reads `docs/PROGRESS.md` and
resumes from the first item that is not `done`.

## Rollback

If a deploy goes live and something is badly wrong, put back the previous version. This reuses
the images already built for an older commit, so nothing is rebuilt.

1. Find the last good commit on `main`. Run in the repo root:

   ```powershell
   git fetch origin
   git log --oneline -10 origin/main
   ```

   Pick the commit just before the bad one and note its short id (for example `4ca79cb`).

2. Make a separate folder on that commit, so your main copy is not disturbed. Run in the repo
   root (replace `<id>`):

   ```powershell
   git worktree add "..\catalog-module-wt\rollback" <id>
   ```

3. Redeploy that version without rebuilding. Run in
   `C:\Users\<you>\Desktop\catalog-module-wt\rollback`:

   ```powershell
   $env:SKIP_BUILD = "1"
   bash infra/deploy.sh
   Remove-Item Env:SKIP_BUILD
   ```

   This works only for a commit that was deployed before (its images exist). Database changes
   are not undone by a rollback.

4. When you are done, remove the folder. Run in the repo root:

   ```powershell
   git worktree remove "..\catalog-module-wt\rollback"
   ```
