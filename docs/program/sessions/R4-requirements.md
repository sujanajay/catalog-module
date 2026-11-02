# R4 requirements session: Every listing has words

Self-contained brief for a fresh Claude Code session. Planning only: change no product code (the throwaway prototype in
step 2 is a comparison, not product code, and is never merged).

## 1. Goal

Decide buy or build for text and listing files, then bring every R4 feature (`docs/program/roadmap.md` section 8) to
build-ready depth and write the R4 build brief. R4's value: grounded English and native Arabic titles, bullets,
descriptions, attributes and filled listing files per channel, with every rejection turned into a fix and a rule.

No timelines anywhere: no dates, weeks, durations or "by X". Durations that describe product behaviour are allowed.

## 2. Steps in order

1. **Read the teardown.** `C:\Users\Sujan Ajay\Desktop\catalog-module\.runs\2026-11-03-streamoid-rubick.md` (the website
   teardown of Streamoid and Rubick). If it does not exist yet, stop and tell Sujan; do not guess vendor capabilities.
2. **Run `M8-S0`.** A `kit:worker` (Opus) builds the throwaway prototype on the 30-product pack described in
   `M8-text-attributes.md` M8-F1 (no Cortina rows), in a scratch worktree that is never merged, and writes the memo: the
   teardown evidence per question (M8-F1 and M9-F2 lists), prototype scores, and the decision rule outcome. Model calls
   go through the existing OpenRouter key; no new paid contract.
3. **Arabic rating.** Ask Sujan for the two native Arabic readers (Q9 answered yes) to rate the prototype blind.
4. **Owner decision.** Present the memo to Sujan in plain words. He decides build, paid trial (gate G4), or buy or
   partner. Record the decision in M8 and M9 section 9.
5. **Deepen the requirements** for that decision (section 4 below).
6. **Write `sessions/R4-build.md`** and update the roadmap and the sessions README.

## 3. Setup and read first

- Worktree from latest `main`: `C:\Users\Sujan Ajay\Desktop\catalog-module-wt\<nn>-r4-requirements`, branch
  `docs/r4-requirements`. If `docs/program/sessions/` is missing on `main`, stop: the planning branch
  `docs/catalog-os-reset` must be merged first.
- Read: `roadmap.md` (1 to 4, 8, 13 to 15), `owner-questions.md`, `requirements/00-template.md`;
  `M8-text-attributes.md` (all), `M9-publish-monitor.md` (F2 to F4), `M2-analyze.md` (F3 to F5, contracts),
  `M5-channel-rules.md` (F5 to F8), `M7-quality-benchmark.md` (F3, F9), `M0-catalog-graph.md` (F7, F8, contracts),
  `M12-admin-self-serve.md` (F3), `UX-design-system.md` (UX7, section 11 English and Arabic).
- P0 depth examples: `M1-intake.md` M1-F3 and `M5-channel-rules.md` M5-F1.
- Evidence: `C:\Users\Sujan Ajay\Desktop\catalog-module\.runs\2026-11-02-competitors-listing.md`,
  `2026-11-02-channel-rules.md` (and `.json`), `2026-11-02-data-census.md`; old design
  `C:\Users\Sujan Ajay\Desktop\catalog-module-wt\initiative-requirements\09-listing-files.md` and `08-*.md` if present.

## 4. What to produce

1. **Upgrade to P0 depth** (template section 4: user story; numbered testable requirements; non-functional; admin
   configuration; inputs and outputs; human-in-the-loop rule; edge cases; buy or build with vendor and fallback order;
   operator-run acceptance tests; open questions with defaults) for: M8-F1, M8-F2, M8-F3, M8-F4 (and the text sheet of
   `M8-S5`); M2-F3, M2-F4, M2-F5; M5-F5, M5-F6, M5-F7, M5-F8; M7-F9; M9-F2, M9-F3, M9-F4; M0-F7, M0-F8; M12-F3 (Brand DNA
   minus the rights record, which is R6); UX7.
2. **Build slices**: ids, true dependencies, acceptance tests, additive migrations. Add slices for M2-F3 to F5 (`M2-S8`
   onward) and M0-F7, M0-F8 (`M0-S8`, `M0-S9`); use `M7-S9b` for the bilingual check (R3 owns `M7-S9a`).
3. **Operator experience and measurement** updated (screens, copy, metric, baseline, target, source).
4. **Integration decisions** in each touched module's section 9. Also fix the stale "after their demos" wording in
   `M7-quality-benchmark.md` M7-F7.
5. **New owner questions** (business, money, legal, marketplace only) in `owner-questions.md`, each with a default.
6. **`docs/program/sessions/R4-build.md`** in the shape of `R1-build.md`: goal, read list, requirements status, setup,
   lanes with slices in order and true dependencies, parallel slices, hot files (`finalize.ts`: M8-S1 before M9-S4) and
   merge order, one writer per module, model per step, clean-context review per PR, ship with `/ce-commit-push-pr`,
   Sujan merges every PR, the subagent report line, acceptance tests, release exit, human gates, done check.
7. In `roadmap.md` section 8, set "Requirements status" to "Build-ready: `sessions/R4-build.md`", list new slice ids,
   and record the buy or build outcome. Add the R4 build session's first message to `sessions/README.md`.

## 5. Decisions already settled (do not reopen)

- No vendor demos; the website teardown plus `M8-S0` decide buy or build (Q4). The decision rules are in M8-F1 and M9-F2.
- C01, C03, C04: the recommended answers apply (Q11). Text cost ceiling USD 0.25 per product, all channels, English plus
  Arabic (Q12). Two native Arabic readers available (Q9). Data team owns the scraper fields and the stale Noon not-live
  feed (Q3 default).
- Arabic is written natively from facts, never translated word by word; formal or Gulf register per brand and channel.
- M8 uses only facts M2 marks trusted; M2 owns facts and channel mapping; M5 holds rules; M7 runs judgement checks and the
  one auditor screen (text is a mode); change sets are M0's `change_set_id`; M8-S3 owns the search-term job.
- Listing files: write only what is known; never placeholder text; never cut a value short; never fill price, stock,
  offer, shipping or tax; never submit; managed channels (Styli, Centrepoint, 6th Street) get files only when their
  account teams send a line sheet.
- No per-SKU review: auto-decide plus the 3% audit (M7 single rule).
- Text on treated or control listings only inside a newly registered experiment (G2); otherwise options outside the
  experiment only.
- India is out of scope (Q17): no Amazon.in, Flipkart or Myntra rules, templates or text.

## 6. Questions to resolve in this session

1. Trust bars per attribute for M2-F3 (what accuracy makes a fact `trusted`), and the sources (photos, sheets, Trendyol).
2. Taxonomy mapping per channel (M2-F4): which channel trees and colour or pattern lists to capture (collection by
   Sonnet), and the review rule for new mappings without a per-SKU queue.
3. Listing quality score (M2-F5): the formula from M5 rules now, and how lift weights replace it later (R5).
4. Noon NIS and Namshi templates: collect the current files (Sonnet); confirm the parser rules; the golden fill owner.
5. Rejection sources and the reason taxonomy (M9-F3, F4): what the data team can provide; the error file drop flow.
6. Variants and size runs (M0-F7) and brand master versus channel overlay (M0-F8): entities, migrations, how Noon's
   Parent Group Key is produced.
7. The text experiment design with M4: which options, which metric, MDE.
8. Hot files and the merge order across M8 and M9 in `finalize.ts`.

## 7. How to work

- You are the manager. Collection (templates, channel trees, vendor pages, current code reading, Context7): Sonnet
  subagents (`kit:researcher`). Writing and the prototype: Opus. Fable only if Sujan asks.
- Clean-context review: `ce-doc-review` in a fresh subagent on the changed docs; fix findings.
- Every subagent brief ends with: "Write the full report to
  `C:\Users\Sujan Ajay\Desktop\catalog-module\.runs\<yyyy-mm-dd>-<slug>.md` in the main checkout and reply in at most 120
  words (outcome, branch/PR, tests, blockers, report path)."
- Ship the docs with `/ce-commit-push-pr`. Sujan merges.

## 8. Done check

- The buy or build memo exists and Sujan's decision is recorded in M8 and M9.
- Every feature in section 4.1 has every P0 subsection with operator-run acceptance tests; every slice has an id,
  dependencies and a test.
- `sessions/R4-build.md` exists and a fresh session could execute it without this conversation.
- No dates, weeks or "by X" in any doc you touched (grep before committing).
- `ce-doc-review` findings fixed; PR open; report written to `.runs`.
