# R6 requirements session: Rich media

Self-contained brief for a fresh Claude Code session. Planning only: change no product code.

## 1. Goal

Bring every R6 feature (`docs/program/roadmap.md` section 10) to build-ready depth and write the R6 build brief. R6's
value: infographics in English and Arabic, still-life and worn scenes, on-model faces from the brand's own models, A+
and listing video, each chosen by policy (never per product) and each measured through M4.

No timelines anywhere: no dates, weeks, durations or "by X". Durations that describe product behaviour are allowed.

## 2. When to open this session

After the R3 and R4 requirements PRs are merged: R6 reuses R3's generation interface, fidelity checks and the in-memory
similarity check, and R4's text, Arabic rules, bilingual check and Brand DNA.

## 3. Setup and read first

- Worktree from latest `main`: `C:\Users\Sujan Ajay\Desktop\catalog-module-wt\<nn>-r6-requirements`, branch
  `docs/r6-requirements`.
- Read: `roadmap.md` (1 to 4, 10, 13 to 15), `owner-questions.md`, `requirements/00-template.md`;
  `M11-rich-media.md` (all), `M12-admin-self-serve.md` (F3, M12-S6), `M3-images.md` (F5 identity rule, F6 AI flag),
  `M7-quality-benchmark.md` (F4, F6, F7, F9 as deepened in R3 and R4), `M5-channel-rules.md` (C19, gaps workflow),
  `M8-text-attributes.md` (Arabic, as deepened in R4), `M4-measurement.md` (registry, ad signals), `UX-design-system.md`
  (section 11 RTL).
- P0 depth example: `M3-images.md` M3-F1.
- Evidence: `C:\Users\Sujan Ajay\Desktop\catalog-module\.runs\2026-11-02-competitors-visual.md`,
  `2026-11-02-channel-rules.md`; old designs
  `C:\Users\Sujan Ajay\Desktop\catalog-module-wt\initiative-requirements\04-scene-images.md`, `05-brand-faces.md` (its
  biometric handling is superseded by Q18), `07-infographics.md`.

## 4. What to produce

1. **Upgrade to P0 depth** (template section 4) for: M11-F1, M11-F2, M11-F3, M11-F4, M11-F5, and M12-F3-R5/R6 (the
   rights record with lifestyle scope and expiry, `M12-S6`).
2. **Build slices** `M11-S1` to `M11-S10` checked and refined (ids, true dependencies, acceptance tests, additive
   migrations, including the M0 role and source additions named in M11 D4).
3. **Operator experience and measurement** updated (policy table, "Extras" digest block, copy).
4. **Integration decisions** in each touched module's section 9.
5. **New owner questions** with defaults (for example scene and video vendor budgets, channel acceptance pilot sizes).
6. **`docs/program/sessions/R6-build.md`** in the shape of `R1-build.md` (lanes, true dependencies, parallel slices, hot
   files, one writer per module, model per step, clean-context review, `/ce-commit-push-pr`, Sujan merges, report line,
   acceptance tests, release exit, gates G5 per asset type and channel, G4, G8, G2, done check).
7. In `roadmap.md` section 10, set "Requirements status" to build-ready; add the R6 build session's first message to
   `sessions/README.md`.

## 5. Decisions already settled (do not reopen)

- Rich media is an add-on after the photographic set: never image 1, never displacing a brand photo. Chosen by policy
  (brand x channel x category x asset type), never per product. No per-product approval queue.
- Infographics are drawn by our code; words come byte-for-byte from trusted versions (facts or M8 text); models never
  draw text. Arabic is RTL with shaping checks; one image per language unless M5 says one gallery serves both; Western
  digits by default.
- Likeness (Q15): Opptra holds complete rights to brand models' likeness; generated people (exact model or lookalike)
  are allowed when the owner's per-brand likeness flag is on. Kids only as the brand's own kids model, kids flag off by
  default; never a synthetic child; never a child lookalike.
- No biometric data (Q18, resolved by design): no face embeddings, biometric templates, face clusters or identity
  vectors stored anywhere. Identity from model pack inputs, an in-memory similarity check discarded after each attempt,
  and the sampled audit (1 in 4 kids, 1 in 10 adults). Model packs are built by a person choosing photos, not by face
  matching.
- Scenes: still life first (product pixels proved identical), then worn footwear, then carried bags; the rights record
  sets the ceiling; never a face in a scene; generated scenes do not go to Noon or Namshi until their AI stance is known.
- A+ is Amazon.ae and Amazon.sa by download pack (no seller API for GCC). India is out of scope (Q17).
- Video version one is stills-to-motion drawn by code; build video only after two channels say yes (M11 Q6).
- No overlays on Noon and Namshi until the channel managers answer C19 (Q14 default).

## 6. Questions to resolve in this session

1. Canva or Adobe Express APIs for Arabic templates (M11 Q1): check current docs (Context7 or vendor pages, Sonnet), and
   decide build versus buy for the composer.
2. A+ module specs for Amazon.ae and Amazon.sa and listing video specs per channel (collection by Sonnet; record as M5
   data with evidence grades).
3. Reuse of R3's similarity check and fidelity checks for faces and worn scenes; extra checks (modesty skin share, hand
   scale, strap continuity).
4. Experiment design per asset type with M4 (ad conversion for scenes; infographic registration before first publish).
5. Channel acceptance pilot (M11-S5): sizes, the pause rule after refusals, how results move rules from "assumed".
6. Hot files and migrations for the M11 slices.

## 7. How to work

- You are the manager. Collection: Sonnet (`kit:researcher`). Writing: Opus. Fable only if Sujan asks.
- Clean-context review: `ce-doc-review` in a fresh subagent; fix findings.
- Every subagent brief ends with: "Write the full report to
  `C:\Users\Sujan Ajay\Desktop\catalog-module\.runs\<yyyy-mm-dd>-<slug>.md` in the main checkout and reply in at most 120
  words (outcome, branch/PR, tests, blockers, report path)."
- Ship the docs with `/ce-commit-push-pr`. Sujan merges.

## 8. Done check

- Every feature in section 4.1 has every P0 subsection; every slice has an id, dependencies and a test.
- A test in `M11-S10` proves zero stored face embeddings or biometric templates.
- `sessions/R6-build.md` exists and is executable by a fresh session.
- No dates, weeks or "by X" in any doc you touched (grep before committing).
- `ce-doc-review` findings fixed; PR open; report written to `.runs`.
