# Go-live progress

This is the single source of truth for the expedited go-live; the manager updates it after every
item; resume from here. The plan is `docs/plans/2026-10-19-expedited-go-live.md`.

Status values: `todo`, `running`, `done`, `blocked`.

| Item | Status | Assumptions | Known issues | Next step |
|---|---|---|---|---|
| 05 gates | todo | - | - | Subagent "05-gates": install, lint, typecheck, test on `feat/catalog-05-matting-and-render`; look for Codex's full-data evidence (max 10 minutes) |
| 05 merge (PR #11) | todo | - | - | `gh pr ready 11`, wait for CI, squash-merge |
| 06 gates | todo | - | - | Subagent "06-gates": merge `main` after PR #11 lands, re-run the four gates, push |
| 06 smoke reorder in deploy.sh | todo | - | - | Reorder `infra/deploy.sh`: build images, remote smoke on the just-built worker image, then update services |
| 06 merge (PR #12) | todo | - | - | `gh pr ready 12`, wait for CI, squash-merge |
| 06 deploy | todo | - | - | From the main checkout: `git pull`, `bash infra/bootstrap.sh` (all SKIP), `bash infra/deploy.sh`; record `WEB_URL` and revisions below |
| 07 worker | todo | - | - | Builder "07-worker": QA stage and publish gate, caps fix, `estimateCost` default, `ensureDefaultPolicies` health, `catalog-qa-check` entry |
| 07 web | todo | - | - | Builder "07-web": five routes and libs, `AttentionList`, `ReplaceModal`, `SkuMapModal`, `EvalLabelBar`, `CostLine`, wired into the batch page |
| 07 infra-tests | todo | - | - | Builder "07-infra-tests": deploy.sh env, `infra/catalog-qa-check.sh`, Playwright steps 7-10, no-model-name grep test |
| 07 integration | todo | - | - | Merge the three builder branches (`--no-ff`), merge `main` after 06 lands, run the four gates, open the PR |
| 07 review | todo | - | - | `/code-review` on the diff; fix bugs and contract violations only; re-run gates |
| 07 merge | todo | - | - | Wait for CI, squash-merge |
| 07 deploy | todo | - | - | `bash infra/deploy.sh` (smoke gate included); record revisions below |
| e2e flow 1 sign-in | todo | - | - | Sign in through IAP lands on `/catalog`; viewer-only account is read-only |
| e2e flow 2 core journey | todo | - | - | New batch, one brand, 3-5 real Anta photos, two channels, start, wait for the end state |
| e2e flow 3 public links | todo | - | - | Two delivered URLs open with no credentials (200, JPEG); sheet downloads; re-check line shown |
| e2e flow 4 overwrite | todo | - | - | Re-upload with one photo changed and one dropped; same links, new generations, removed link gone |
| e2e flow 5 needs attention | todo | - | - | One held product; "Use as is" and "Remove this photo" both work |
| e2e flow 6 cost line and cap | todo | - | - | INR cost line on the batch page; `DAILY_SPEND_CAP_USD` set in the deployed env |
| 08 model bake-off and policy (reduced) | todo | - | - | `catalog-eval` and policy writer; reduced bake-off on Anta and French Connection; write `model_policy` rows |
| 09 scale, guardrails, hand-over (reduced) | todo | - | - | `catalog-recheck`, fault proxy, load driver at one tenth scale (270 options), hand-over note and GIF |

## Assumptions (pre-filled 2026-10-19)

- Codex's spec-05 text changes are accepted without owner review: timeout 180 s, the canvas
  formula, the shadow alpha threshold, the compliance edge rule, and one resident model session.
- The tier 5 smoke gate is reordered to run on the just-built image through the remote job
  (`catalog-test-smoke`), before the services are updated.
- Docker is not required. Anything that needs a local container runs against the deployed service
  or is skipped.
- Full 3,910-photo tier 3 runs are skipped.
- The spec 07 WIP on branches `codex/spec07-web` and `codex/spec07-worker` was committed as-is and
  may not compile.

## Known issues

- Codex's claimed Cloud Build verification id `1ac2bc2a` was not found.
- Anonymous read on the public bucket is not yet proven by a real object (e2e flow 3 is the proof).
- The BigQuery warehouse is still read through the mirror.
- Codex's spend estimate is USD 91.92 of USD 100 for specs 05-07.

## Deployed state

Latest known revisions (spec 04, 2026-10-18):

- `catalog-worker`: `catalog-worker-00006-vk7`
- `catalog-web`: `catalog-web-00006`
- `WEB_URL`: to be filled after the 06 deploy.
