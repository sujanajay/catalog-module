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

## Settled decisions (gate 1 and owner answers; do not reopen)
- First market is GCC fashion, then self-serve for outside brands. India (Cortina, Amazon.in, Flipkart, Myntra) is out
  of scope for now (owner answer Q17; `../roadmap.md` section 15).
- No timelines in requirements or plans: no dates, weeks, durations or "by X". Order by value and true dependency, by
  release (`../roadmap.md`). Experiment readouts are expressed as "after N weeks of data" only inside M4. Durations that
  describe product behaviour (for example "detected within 7 days") are requirements and are allowed.
- Buy generation, image understanding and text models, each with a fallback vendor. Keep our own GPUs for cleanup
  (background removal, upscaling).
- No Amazon seller API for now. Outcomes come from BigQuery (`opptra-datawarehouse`: sales, stock, price, ads where
  available) plus scraped public pages.
- Background colour 240+ grey; white for Amazon image 1.
- Holdout test: about 700 vs 700 Namshi and Noon options, launched in release R2, with readouts at the points M4
  pre-registers.
- Use the draft title lengths and a format-only check on HSN (tax) codes.
- Crops (a new shot cut from a bigger brand photo, for example head and shoulders from a full-length photo) are never
  used on Styli or Centrepoint (owner, 2026-11-03). Noon and Namshi accept crops and AI-made images; generated images
  still need the M7 gate and, for people, the per-brand likeness flag.
- Image rules the business already set in code stay as they are: the minimum image size (C06) and aspect ratios and
  canvases (C07). Namshi image rules are the ones live in the product today.
- On-model photos are required for all adult softline, including footwear, accessories, lingerie and swimwear (C14,
  owner 2026-11-03). Kids never need a person: flat lay only, and no synthetic children.
- Never invent content without source data: no size chart without a brand size chart (C16 follow-up, owner
  2026-11-03).
- Infographics (C19, owner 2026-11-03): assumed accepted in the Noon gallery (a channel setting, easy to change),
  following the image rules already in code; never image 1. No Arabic text on images for now (English only);
  Arabic on images is a later scope item.
- Video: only for channels that accept it (Noon for eligible sellers, Amazon.ae and .sa, Trendyol); later scope, not
  urgent. Research: `C:/Users/Sujan Ajay/Desktop/catalog-module/.runs/2026-11-03-proxy-noon-video.md`.
- Scraping proxy: Decodo residential, HTML only (no full browser loads), primary; Zyte API (pay on success) as the
  backup. Both start on a trial that proves Saudi and UAE pages load. Ceiling USD 100 a month (Q5).
- Outcome data: use what `opptra-datawarehouse` already has (sales, returns, ads, stock, price, liveness); the gaps
  are in `C:/Users/Sujan Ajay/Desktop/catalog-module/.runs/2026-11-03-data-inventory.md` and are asked of the teams.
  Missing data lowers sensitivity; it never blocks a release.
- All 30 rule conflicts are decided (M5-F2-R4). Trendyol API: later, not now.
- Check Streamoid and Rubick before building text and listing files: by a website teardown plus our own prototype, not
  vendor demos (owner answer Q4).
- Scrape our own listings now (legal OK, Q2); buy market data later.
- No per-SKU review queues. Auto-decide by default, with a permanent 2-5% sampled audit. A person still checks product
  truth (colour, logo, shape), modesty, likeness rights and threshold changes.
- Likeness: Opptra holds likeness rights for brand models; the owner sets a per-brand likeness flag (Q15). No face
  embeddings or biometric templates are stored anywhere (Q18).
- Business settings (rules, channels, vendors, thresholds, prompts) are admin-editable. Structure is not, until a second
  customer needs it.
- Zero-downtime deploys. Batches must survive a deploy.

## Evidence (read what you need)
- `C:\Users\Sujan Ajay\Desktop\catalog-module\.runs\2026-11-02-*.md`: outcome baseline, data census, cost and quota, channel
  rules (plus `.json`), Harvey method, gate-1 brief, module tree, and the three competitor reports.
- `../brief-v1.md`, `../module-map.md`, `../../plans/2026-11-02-catalog-os.md`.
- The current code (latest main) lives in this worktree. Reuse what exists; name the files.
