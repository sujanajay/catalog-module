# gcloud login after a reboot - learnings

## Symptom
After the restart of 2026-10-21 (and again after roughly a day without one) every gcloud call failed
with "Reauthentication failed. cannot prompt during non-interactive execution". Scripts and subagents
run gcloud non-interactively, so they cannot answer the prompt and stop at the first GCP call.

## Why
The gcloud user login on this machine expires after a reboot and after roughly a day. A new login
needs a browser sign-in, which only the owner can complete.

## What to do
- At the start of every session and after any reboot, check the login before anything touches GCP:
  `gcloud auth print-access-token > /dev/null && echo ok`. Never print the token itself.
- If it fails, the manager launches `gcloud auth login` and the owner completes it in the browser.
  No subagent and no script tries to log in on its own.
- gcloud is not on PATH on this machine. In every Git Bash call prepend the SDK and set the project
  for that call only:
  `export PATH="/c/Users/Sujan Ajay/AppData/Local/Google/Cloud SDK/google-cloud-sdk/bin:$PATH"`
  (that is `%LOCALAPPDATA%\Google\Cloud SDK\google-cloud-sdk\bin`) and
  `export CLOUDSDK_CORE_PROJECT=image-links-agent`.
- Never change the global gcloud config (`gcloud config set project ...`): the operator's default
  project is a different one and other work depends on it.
- The Playwright IAP sign-in state can expire too; check it with `pnpm exec tsx .playwright/verify.ts`
  and ask the owner to sign in again if it fails.
