# Opptra Catalog OS - first-principles reset (v3)

## Context
Sujan rejected the 9 image-only initiative docs and asked me to question everything: his ground rules, my operating model and
my phases. Inputs so far:
- six research tracks: the live tool and code, vendors, method and operations, the playbook, catalog-wide competitors, and
  measurement;
- "Catalog v2", which covers the Cortina India pilot, IDQ at 64% vs a 90% target, and cost from ₹1,000 to under ₹200 per SKU;
- the Cataloging Playbook.

The reframe: **a catalog is the whole listing, not just images.** That means images, titles, keywords, bullets, descriptions,
A+ content, video, attributes, size charts, listing files, push and monitoring. **The real product is a learning loop** that
measures what works per channel × category × product, controls for price, ads, promotions, stock and season, and carries what
wins across every content type. Images come first. The rest of the catalog follows, then marketing. Later it becomes a
self-serve service and an onboarding hook for Opptra distribution.

## What the evidence says
1. **Generation is a commodity.** Amazon gives listing generation away free (900k sellers use it). Photoroom, Gemini and others
   charge $0.02-0.14 per image. Photoroom even sells a fidelity check with pay-for-pass billing.
   → **Buy generation**, keep 2-3 vendors behind one interface for every capability, and gate it with our own checks.
2. **Nobody closes the loop causally.** PIM tools sync content. Shelf-analytics tools (Profitero, CommerceIQ) correlate content
   with sales, mostly on Amazon US, without controlling for price or ads. Streamoid is the nearest India/GCC rival and has no
   causal loop. The GCC has agencies, not products.
   → **The gap is the learning loop plus Opptra's own multi-brand sales data.**
3. **"More images → more sales" is unproven in our own data.** Images 7-8 show no conversion lift (0.95). Amazon's claims of
   +8-20% for A+ and +9.7% for video are "up to" figures. Cross-pollination is a hypothesis, not a proven effect.
   → **Every content change is an experiment, not an article of faith.**
4. **Per-product learning is statistically impossible for the long tail.** Detecting a 10% lift needs about 14k sessions per
   arm, and 71% of live options sold nothing in 90 days.
   → **Pool learnings** by change type × category × channel, using staggered rollouts and hierarchical models. Keep true A/B
   tests (Amazon Manage Your Experiments) for the top SKUs. Focus effort where revenue sits: the top 10% of SKUs make 86% of
   revenue.
5. **The live tool's measured pains:**
   - Intake failures.
   - Held products block their good images.
   - One shared production stack, so deploys take up to 2.5 h and batches can't run during them.
   - The cost ledger is about 60x low.
   - CPU quota is maxed out.

   → **Reliability and "upload and walk away" are table stakes for any slice.**
6. **The playbook is mostly rules that can be data**: limits, slot order, attributes, banned words, units, tax codes. But it
   contradicts itself in many places and measures nothing.
   → **A rules engine an admin can edit, with conflicts surfaced instead of silently picked.**
7. **People in the loop:** auto-decide by default. A permanent 2-5% audit sample stays, and so do checks on product truth
   (colour, logo, shape), modesty, likeness rights and changes to thresholds. No per-SKU review queues.

## Ground rules questioned (what changed)
| Sujan's rule or my old plan | Verdict |
|---|---|
| North star = image-driven conversion | Keep conversion as the outcome, but measure it pooled and causally. IDQ is only an input: it is undocumented and may be renamed CDQ. |
| Buy what exists | Right for generation. Build the catalog graph, rules engine, measurement and learning. |
| Our moat = judging | Wrong. The moat is the learning loop plus Opptra's outcome data plus GCC/India channel know-how. |
| Analyzer understands everything | Extract what a decision needs. Vision models score 64% F1 on attributes and 34% on whether an attribute applies. |
| Everything configurable | Business knobs yes (rules, channels, vendors, thresholds). Structure no, until a second customer needs it. |
| Many parallel agents | Parallel only for reading, review and grading. One writer per module. State lives in files. |
| Launch in a week | A thin slice, yes. ROI proof needs 4-10 weeks, so the measurement starts on day 1. |

## Target architecture (the modules, each built independently)
1. **Catalog graph:** one record per SKU × channel. It holds attributes, content, assets, and a versioned **change log** of
   every content change, with who or what changed it and why.
2. **Channel rules engine:** the playbook and channel specs as admin-editable data, with conflicts flagged.
3. **Generators and enrichers:** bought vendors behind one interface, with fallbacks. Images first, then text, A+ and video.
4. **Quality gate:** deterministic rules plus garment/logo/text fidelity checks, auto-decide, sampled audit.
5. **Publish:** listing files and links today; marketplace APIs where allowed, after an owner decision.
6. **Outcome data layer:** BigQuery sales, Amazon reports (Search Query Performance, Sales & Traffic), the Ads API, price,
   deals, stock, and channel exports for Noon, Flipkart and Myntra.
7. **Learning engine:** pooled causal estimates of change type → outcome. Winners propagate across content types
   (cross-pollination), so a keyword that wins updates the title, the backend terms, the infographic text and the Q&A.
8. **Benchmark harness:** any new model or vendor gets scored on our golden sets for quality, cost and latency, and is promoted
   automatically if it wins.

## Operating model
- I coordinate. Subagents report to `MAIN/.runs/<date>-<slug>.md` and reply in at most 120 words.
- **Models:** Sonnet for collection, Opus for synthesis and building, Fable twice: the vision brief, and the measurement and
  learning design.
- **Intent ledger** `MAIN/docs/program/intents.json`: every ask with its source quote, status (starts as failing) and an
  end-state test. Progress lives in `MAIN/docs/plans/2026-11-02-catalog-os.md`.
- **To Sujan:** one page per decision (Problem / Why / Tech / Product vision). I only ask what needs a human.

## Phases
- **Phase 0 - Unblock.**
  - Seed the intent ledger and watch the Harvey video (`/watch`).
  - Sujan: authorize the Supabase and Photoroom connectors, free disk on C:, and confirm access to BigQuery
    `opptra-datawarehouse`, Amazon Brand Registry + SP-API (Brand Analytics role) and the Ads API, and the Noon Vantage export.
- **Phase 1 - Close the evidence gaps** (read-only, parallel). One track each:
  - a census of our data and the GCC/India market;
  - a baseline of the outcome data (what is reachable per channel, plus the confounders);
  - a 50-SKU vendor bake-off;
  - true cost per SKU and quota needs;
  - the Harvey method;
  - a playbook-to-rules conversion with a conflict list.
- **Phase 2 - One-page brief and module map** (Fable #1). Sujan's approval is gate 1.
- **Phase 3 - First slice: GCC fashion** (Sujan's choice; Styli, Centrepoint, Noon, Namshi, Amazon AE). India Cortina comes
  next, on the same core. About 1 week:
  - catalog graph and change log;
  - "upload and walk away" intake;
  - auto-decide instead of review queues;
  - zero-downtime deploys;
  - true cost meter;
  - the image set for the chosen market;
  - the outcome data and a holdout design live from day 1.
- **Phase 4 - Learning engine** (Fable #2 for the design), then text, keywords, A+ and video modules, each its own worktree and
  writer, merged by Sujan.

## Verification
- Every intent's end-state test passes on a real batch, run as an operator would.
- Before and after numbers: touches per 1,000 SKUs, time to live, true cost per SKU, IDQ/completeness.
- A batch started during a deploy finishes cleanly.
- The first pooled experiment reports a lift, or no lift, with confidence bounds.

## Progress (updated at milestones)
- [x] 2026-11-02 Plan v3 approved by Sujan; first slice = GCC fashion.
- [ ] Phase 0: intent ledger seeded, Harvey video watched, access confirmed (Supabase, Photoroom, BigQuery, SP-API, Ads API, Noon Vantage).
- [ ] Phase 1: evidence reports in MAIN/.runs (data census, outcome baseline, cost and quota, channel rules, Harvey method, vendor bake-off).
- [ ] Phase 2: one-page brief approved (gate 1).
- [ ] Phase 3: GCC fashion slice live.
- [ ] Phase 4: learning engine, then text, keywords, A+ and video.
