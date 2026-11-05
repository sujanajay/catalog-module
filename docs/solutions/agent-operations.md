# Agent operations on this machine - notes (R1, 2026-11-04/05)

Facts about running Claude Code agents for this repo that cost time in R1. They are about the tooling, not the
product code.

## Merges and deploys by subagents
- The auto-mode safety check refuses a subagent's `gh pr merge` ("Merge Without Review") and production deploys
  unless the subagent's brief quotes the owner's typed approval word for word, for example
  `approve merge catalog-module#159/#165/#166/#167`. A coordinator saying "the owner approved" does not count, and
  PRs added to a train after the approval are not covered. Evidence: `.runs/2026-11-04-merge-train.md` (#159
  refused), `.runs/2026-11-04-merge-train-2.md` (same PRs merged once the brief quoted the approval),
  `.runs/2026-11-05-merge-174.md`. See also item 3 of `2026-10-31-spec-18-live-lessons.md`.
- The main session can merge with a bare `gh pr merge <n> --squash --match-head-commit <sha>`.
- A refused subagent stops and reports. It never works around the refusal.

## Settings allow rules match the exact command shape
A permission allow rule matches only the command as written. `cd <dir> && gh pr merge ...` does not match a rule for
`gh pr merge ...`, and neither does the same command with other flags in another order. Run allowed commands
standalone, in the shape the rule names, and set the folder with the tool's working directory instead of `cd`.

## gcloud login opens only in Chrome Profile 34
Every `gcloud auth login` must open in the opptra.com Chrome profile ("Profile 34") and sign in with the operator's
opptra.com account. Python's `webbrowser` picks the profile up from the `BROWSER` variable. From PowerShell, in any
folder, run in the background:

```powershell
$env:BROWSER = '"C:/Program Files/Google/Chrome/Application/chrome.exe" --profile-directory="Profile 34" %s'
& "$env:LOCALAPPDATA\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd" auth login <operator account> --update-adc
```

The owner clicks through the sign-in in the tab that this command opened. A tab left from an older attempt fails with
"(mismatching_state) CSRF Warning". Put this command in every brief that may need a login. The rest of the login
routine is in `gcloud-login-after-reboot.md`.

## Deploy builds use the GCS tarball workaround
`gcloud builds submit .` (inside `infra/deploy.sh`) hangs on its source upload from this laptop. What works:
1. `git archive --format=tar.gz -o src-<sha>.tgz <sha>` from a clean worktree of the commit.
2. `gcloud storage cp src-<sha>.tgz gs://image-links-agent_cloudbuild/source/`.
3. `gcloud builds submit gs://image-links-agent_cloudbuild/source/src-<sha>.tgz --config cloudbuild.yaml
   --substitutions=_AR=asia-south1-docker.pkg.dev/image-links-agent/apps,_TAG=<short sha> --async`
   (the same config and substitutions as `deploy.sh`).
4. When the images exist, run `infra/deploy.sh`; it skips the build for a commit whose images are already there.

The catalog-upscale CPU gate in `deploy.sh` failed on slow Cloud Run hosts. The root cause and fix (pixel caps sized
for 167 s/MP hosts, 18% headroom) are in #176.

Evidence: `.runs/2026-11-05-r1-deploy-ca4ce17.md`.
