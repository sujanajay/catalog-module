# Requirements template (every module file follows this)

Plain words. Define jargon once. Never use the em dash; use "-". The reader is Sujan (owner, learning to be technical) and
later the builder agents.

## File layout: `Mx-<slug>.md`
1. **Purpose** (3 lines): why this module exists, its outcome metric, and the intents it serves (ids from `../intents.json`).
2. **Scope**: in, out, and later.
3. **Contracts**:
   - what this module reads from and writes to other modules, especially M0 (catalog graph), named as entities and events;
   - the API or queue shapes it needs;
   - anything M0 must provide, listed under "Contract needs from M0".
4. **Features**: one section per feature from `../module-map.md`, using the same ids. Depth depends on priority:
   - **P0 (first slice), in full:**
     - user story;
     - functional requirements, numbered `Mx-Fy-R1`, each testable;
     - non-functional (speed, cost per SKU, reliability, scale target);
     - configuration an admin can change without a deploy;
     - inputs and outputs;
     - the human-in-the-loop rule (who, when, and how it goes away);
     - edge cases and failure modes;
     - buy or build (named vendor plus fallback order, or why build);
     - acceptance tests (end-state, run as a real operator would);
     - open questions, each with a recommended default.
   - **P1, medium:** story, key requirements, acceptance test, buy or build.
   - **P2, Later and Skip, brief:** two to four lines.
5. **Operator experience**: what the person sees and does. Target: zero cognitive load and no babysitting. Name the screens
   and the copy for key moments.
6. **Measurement**: how we know it works. The metric, its baseline, its target, and where the data comes from.
7. **Build slices**: small pieces of work, each one worker in one worktree, with order, dependencies and an acceptance test.
8. **Risks and open questions.**

## Settled decisions (gate 1, 2026-11-02; do not reopen)
- First market is GCC fashion. India Cortina comes next on the same core, then self-serve for outside brands.
- Buy generation, image understanding and text models, each with a fallback vendor. Keep our own GPUs for cleanup
  (background removal, upscaling).
- No Amazon seller API for now. Outcomes come from BigQuery (`opptra-datawarehouse`: sales, stock, price, ads where
  available) plus scraped public pages.
- Background colour 240+ grey; white for Amazon image 1.
- Holdout test starts 10-17 Nov: about 700 vs 700 Namshi and Noon options, with readouts at 8 and 12 weeks.
- Use the draft title lengths and a format-only check on HSN (tax) codes.
- Crops only on Namshi and Noon until their AI-image stance is known.
- Demo Streamoid and Rubick before building text and listing files.
- Scrape our own listings now; buy market data later.
- No per-SKU review queues. Auto-decide by default, with a permanent 2-5% sampled audit. A person still checks product
  truth (colour, logo, shape), modesty, likeness rights and threshold changes.
- Business settings (rules, channels, vendors, thresholds, prompts) are admin-editable. Structure is not, until a second
  customer needs it.
- Zero-downtime deploys. Batches must survive a deploy.

## Evidence (read what you need)
- `C:\Users\Sujan Ajay\Desktop\catalog-module\.runs\2026-11-02-*.md`: outcome baseline, data census, cost and quota, channel
  rules (plus `.json`), Harvey method, gate-1 brief, module tree, and the three competitor reports.
- `../brief-v1.md`, `../module-map.md`, `../../plans/2026-11-02-catalog-os.md`.
- The current code (latest main) lives in this worktree. Reuse what exists; name the files.
