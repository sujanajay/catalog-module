# R3 requirements session: Made where nothing else works

Self-contained brief for a fresh Claude Code session. Planning only: change no product code.

## 1. Goal

Bring every R3 feature (`docs/program/roadmap.md` section 7) to build-ready depth, then write the R3 build brief.
R3's value: where no crop can fill a required shot, a bought generator makes it from the brand's own models, our own
fidelity checks gate it, and any new vendor or model is scored and promoted without code.

No timelines anywhere: no dates, weeks, durations or "by X". Durations that describe product behaviour are allowed.

## 2. Setup

- Worktree from latest `main`: `C:\Users\Sujan Ajay\Desktop\catalog-module-wt\<nn>-r3-requirements`, branch
  `docs/r3-requirements`. If `docs/program/sessions/` is missing on `main`, stop and tell Sujan that the planning branch
  `docs/catalog-os-reset` must be merged first.
- Edit the module docs in place (same files, same feature ids). Do not create parallel spec files.

## 3. Read first

1. `docs/program/roadmap.md` (sections 1 to 4, 7, 13, 14) and `docs/program/owner-questions.md`.
2. `docs/program/requirements/00-template.md`: the template and the settled decisions.
3. `requirements/M3-images.md` (F5 to F8, section 9), `M7-quality-benchmark.md` (F2, F4 to F8, section 9),
   `M12-admin-self-serve.md` (F1, F3-R5, F3-R7, section 9), `M6-reliability-cost.md` (F1, spend caps),
   `M11-rich-media.md` F3 (the identity rule shared with R6), `UX-design-system.md` (UX5, UX6, sections 5.4, 5.5, 5.7).
4. A P0 example of the target depth: `M3-images.md` M3-F1 and `M7-quality-benchmark.md` M7-F2.
5. Evidence: `C:\Users\Sujan Ajay\Desktop\catalog-module\.runs\2026-11-02-competitors-visual.md`,
   `2026-11-02-cost-and-quota.md`, `2026-11-02-harvey-method.md`; old design
   `C:\Users\Sujan Ajay\Desktop\catalog-module-wt\initiative-requirements\03-made-photos.md` if present.
6. Current code the features extend (name the files in the docs): the `image.make` area, `packages/core/src/qa/`,
   `packages/core/src/cost.ts`, the settings store from `M12-S1`.

## 4. What to produce

1. **Upgrade to P0 depth** (template section 4, "P0, in full": user story; numbered testable requirements; non-functional;
   admin configuration; inputs and outputs; human-in-the-loop rule; edge cases; buy or build with named vendors and
   fallback order; acceptance tests run as a real operator would; open questions each with a default) for:
   M3-F5, M3-F6, M3-F7, M3-F8; M7-F4, M7-F5, M7-F6, M7-F7, M7-F8; M12-F1 (settings UI: `M12-S2`, `M12-S3`) and the
   per-brand likeness and kids flags as settings.
2. **Build slices** in each module's section 7: ids, true dependencies, acceptance test, migrations (additive). Add new
   slices for M3-F7 and M3-F8 (`M3-S9`, `M3-S10`), and split `M7-S9` into `M7-S9a` (blocking human calls, R3) and
   `M7-S9b` (bilingual check, R4). Include UX5 and UX6.
3. **Operator experience and measurement** sections updated for these features (screens, copy, metric, baseline,
   target, source).
4. **Integration decisions**: every technical decision you make, in each module's section 9.
5. **New owner questions** (business, money, legal, marketplace only) added to `owner-questions.md` with a default, a
   status and the release that needs them.
6. **`docs/program/sessions/R3-build.md`** in the same shape as `R1-build.md`: goal, read list, requirements status,
   setup, lanes with slices in order and true dependencies, what can start in parallel, hot files and merge order, one
   writer per module, model per step, clean-context review per PR, ship with `/ce-commit-push-pr`, Sujan merges every
   PR, the subagent report line, acceptance tests, the release exit, human gates, done check.
7. In `roadmap.md` section 7, change "Requirements status" to "Build-ready: `sessions/R3-build.md`" and list any slice
   ids you added. Add the R3 build session's paste-ready first message to `sessions/README.md`.

## 5. Decisions already settled (do not reopen)

- Buy generation behind M7's one interface (`image.make`), two ranked vendors plus a fallback; M7 owns routes, M6
  meters cost and caps spend. Seed chains are in M3-F5.
- Likeness (Q15): Opptra holds complete rights to brand models' likeness. Generated people may use the brand's own
  models (reference photos from the brand's photos or website), the exact model or a lookalike, when the owner's
  per-brand likeness flag is on. Never a synthetic child; never a child lookalike.
- No biometric data (Q18): no face embeddings, biometric templates, face clusters or identity vectors stored anywhere.
  Identity consistency comes from model reference photos as inputs, a visual similarity check computed in memory and
  discarded (only pass or fail and the score kept), and the sampled human audit.
- `generated_allowed` per channel is off by default, and on for Noon and Namshi (owner 2026-11-03). Styli and
  Centrepoint never take crops. Generated images publish only after the cell (brand x category x capability) passes the bake-off and
  its first 20 audited images; the cell waits, never a product.
- Every generated image carries the IPTC "trained algorithmic media" tag and the M0 `generated` source; a missing tag
  blocks the output.
- Bake-off budget up to USD 500; paid use only after the bake-off and a written no-training clause (Q13 default; gate
  G4).
- Cap per batch: planned shots x USD 0.20 x 1.5, at least USD 1. No per-SKU review queue.
- Owner-only settings use the `M12-S1` owner allow-list; owner approvals for many people (`M12-S4`) are R7.

## 6. Questions to resolve in this session

Resolve technical ones yourself and record them; send owner ones to `owner-questions.md`.
1. The in-memory similarity check: which visual similarity model (commercial licence required; check its licence and
   current docs with Context7 or the vendor page), what it compares (whole output versus reference crop), threshold and
   calibration on the golden set, and a test that proves nothing is written to storage, logs, caches or exports.
2. The M7 generation golden set (`GS-E` in M7): composition, size, planted defects per capability, who labels it.
3. Bake-off protocol per capability (`reference_edit`, `tryon`, `model_swap`, `ghost_to_model`): metrics, the scored
   report fields (`M7-S8`), licence and terms checks, how the USD 500 is split.
4. Staged gate and automatic promotion (`M7-F6`): stage bars, rollback trigger, how promotion interacts with the audit
   rates and the M4 live test.
5. Blocking human calls (`M7-F8`): the exact list (modesty, kids, likeness), who is asked, the safe default when nobody
   answers.
6. Settings UI scope for R3: which settings appear (generation on, routes, caps, likeness and kids flags), preview by
   replay, history and revert.
7. Hot files and migrations the R3 slices touch, and their merge order.
8. Whether any vendor terms forbid generating a lookalike of a real person; record the vendor order accordingly.

## 7. How to work

- You are the manager. Collection (vendor docs and terms, current code reading, Context7 lookups): Sonnet subagents
  (`kit:researcher`). Writing the requirements: Opus (`kit:worker` or yourself for small parts). Fable only if Sujan asks
  ("critical design"); the similarity check design is the one place worth offering it.
- Clean-context review: run `ce-doc-review` in a fresh subagent on the changed docs; fix findings.
- Every subagent brief ends with: "Write the full report to
  `C:\Users\Sujan Ajay\Desktop\catalog-module\.runs\<yyyy-mm-dd>-<slug>.md` in the main checkout and reply in at most 120
  words (outcome, branch/PR, tests, blockers, report path)."
- Ship the docs with `/ce-commit-push-pr` (the repo has no no-mistakes gate). Sujan merges.

## 8. Done check

- Every feature in section 4.1 has every P0 subsection, with numbered requirements and operator-run acceptance tests.
- Every R3 slice has an id, true dependencies and an acceptance test; new ids are listed in the roadmap.
- `sessions/R3-build.md` exists and a fresh session could execute it without this conversation.
- No dates, weeks or "by X" in any doc you touched (grep before committing).
- `ce-doc-review` findings fixed; PR open; report written to `.runs`.
