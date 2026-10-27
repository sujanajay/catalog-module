---
name: build-test-quirks
description: Build and test quirks of the catalog-module repo on Sujan's Windows machine (bash, pytest, infra tests, gcloud)
metadata:
  type: project
---

- PowerShell `bash` is WSL with no distro (fails); use the Bash tool (Git Bash) with plain single commands, or run infra tests with `node infra/tests/<name>.test.mjs` (they find Git Bash themselves).
- Matting service pytest is not wired to pnpm; locally make a venv with fastapi, python-multipart, pillow, pillow-heif, numpy, onnxruntime, pytest, httpx (rembg is mocked) and run `python -m pytest tests -q` in services/matting.
- `pnpm test` takes several minutes; run it in the background. `pnpm typecheck` can pass 120 s too.
- Read-only gcloud: `& "$env:LOCALAPPDATA\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"` with `$env:CLOUDSDK_CORE_PROJECT='image-links-agent'`; in PowerShell use `$($arr[1])`, not `$arr[1]`, inside `--region=` strings.

**Why:** each cost a failed attempt on 2026-10-27 (spec 16 build).
**How to apply:** check this before running gates or infra tests in this repo.
