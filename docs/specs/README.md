# Catalog module specs

Source of truth: `docs/SPEC.md`. These files are the executable specs for it, run strictly in
order, one PR each. Every spec is self-contained once you have read `00-execution-protocol.md`.
Shared contracts (types, enums, tables, object paths, routes, env vars, helpers) are defined in
`02-scaffold-and-foundations.md`; roles and sign-in are defined in `03-auth-and-roles.md`. Later
specs restate what they use and say "defined in 02" or "defined in 03"; they never redefine it.

| Order | File | Branch | One line |
|---|---|---|---|
| 00 | `00-execution-protocol.md` | n/a | How the manager runs a spec: roles, preconditions, worktrees, subagent briefs, test tiers, PR, merge, deploy, the "Ready for the next spec" report, blocking rules. Read once; applies to all. |
| 01 | `01-ui-prototype.md` | n/a (approval gate) | The clickable prototype (version 2) transcribed: every screen, state and sentence the real UI must copy, plus the pages added by the product-identity decision (product page, brand page, overwrite preview, "Not refreshed in this batch"). |
| 02 | `02-scaffold-and-foundations.md` | `feat/catalog-02-scaffold-and-foundations` | pnpm monorepo scaffold and the lift list from the earlier app; channel table; naming and public paths (product-owned, no batch id, no version suffix); storage additions; the whole schema and migration `0000_init.sql`; tasks; bootstrap (database `catalog`, public bucket, queue, service accounts, secret containers); brand master and `sku_map` sync; worker skeleton with `/healthz`, `sync-master` and `sweep`. Deploys worker, migrate job, infra. |
| 03 | `03-auth-and-roles.md` | `feat/catalog-03-auth-and-roles` | Google sign-in through Cloud Run IAP (`--iap`, Google-managed OAuth client, `domain:opptra.com` granted by gcloud; no console step); IAP JWT verification in the app; `users` table and migration `0001_users.sql`; roles admin, operator, viewer; `currentUser` and `requireRole`; the People modal and `/api/people`. Deploys web. |
| 04 | `04-ingestion.md` | `feat/catalog-04-ingestion` | Every input adapter (files, zip, links sheet, Google Sheet, Drive folder, pasted URLs, product list); identifier modes and precedence; sheet column detection that never guesses, including composite style+colour identifiers; the step 2 controls (identifier column, image columns, read as links sheet or product list); product-list matching (base identifier for `_rect`/`_square`, size-level rows, tokens inside file names); Google access check; product matching through aliases; step 4 preview data including the overwrite preview and the new warning sentences; HEIC read as a normal image; `link_status`; `catalog-local` collection. |
| 05 | `05-matting-and-render.md` | `feat/catalog-05-matting-and-render` | `catalog-matting` service; matting client with circuit breaker and flood-fill fallback; render pipeline (fit, never crop; adaptive canvas; shadow; encode under 2,000,000 bytes); compliance checks; `catalog-local` render. |
| 06 | `06-pipeline-and-ui.md` | `feat/catalog-06-pipeline-and-ui` | Chunks and stages, the per-product publish stage (stage, verify, swap with `ifGenerationMatch`, scoped delete), finalize with the sheet writers, the filled product-list export and the independent re-check of the sheet just written ("Independent re-check: N of N OK" next to "Links verified: N of N"); the four-step wizard with the step 2 sheet controls and the step 4 estimate line, batch page, product and brand pages, the three downloads; deploy of all three services; the human-like browser test; the per-brand smoke inside deploy. |
| 07 | `07-qa-attention-and-skus.md` | `feat/catalog-07-qa-attention-and-skus` | Vision QA judge and product-type classifier; the "Needs attention (N products)" tab with "Use as is", "Remove this photo" and "Replace photo N"; SKU id mapping sheet; eval-mode labels; spend attribution and the INR cost line against INR 60; the `catalog-qa-check` job. |
| 08 | `08-model-bakeoff-and-policy.md` | `feat/catalog-08-model-bakeoff-and-policy` | Golden set for every brand; `catalog-eval` with compliance, judges and human labels; bake-off of all candidates; `model_policy` with gates (auto-pass precision at least 97%, flag recall at least 90% per category) applied automatically at batch start; the operator never sees a model name. |
| 09 | `09-scale-guardrails-handover.md` | `feat/catalog-09-scale-guardrails-handover` | Load test (2,700 options, 100,000 outputs, about 2 hours); fault injection on breaker, caps and locks; the `catalog-recheck` CLI with its sheet-level modes (`--batch`, `--sheet`, `--csv`, `--sample`: `.jpg` suffix, one row per product, unique URLs, hyperlink cells, xlsx against csv, contact sheet); GIF of the human-like test; final `docs/SPEC.md` pass; learnings; README; operator role for the catalog operator; plain-language hand-over note with the process behaviours from 00. Ends with "Programme complete; no next spec." |

## The one approval gate

Nothing after 01 starts until the human has clicked through the prototype and said "approved"
(01 "Approval gate"). Changes requested there are folded into 01, 06 and 07 before execution.

## How to start

Open a spec and say "execute". The main session then follows 00: it reads the spec, `docs/SPEC.md`
and `CLAUDE.md`, creates the worktree and branch, delegates to builder subagents, integrates, tests
through the tiers the spec names, reviews, opens and merges the PR, deploys when the spec says so,
and ends with one report that finishes "Ready for the next spec: <nn+1> <title>". It asks nothing
in between; if something truly blocks, the report says exactly what is needed.

Specs run strictly in order (00 section 2 checks that the previous one is merged). If a later spec
cannot be met without changing a contract from 02 or 03, the manager proposes the change in the
report instead of making it (00 section 11).
