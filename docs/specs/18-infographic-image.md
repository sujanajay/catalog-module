# 18 Infographic image

Written 2026-10-28 from the approved plan (initiative 7) and the 27 Oct meeting with Ashish.

Catalog module, spec 18. Execute with `docs/specs/00-execution-protocol.md`. Source of truth: `docs/SPEC.md`,
amended by this spec in the words of 0.5. Depends on 04 (ingestion, sheets), 05 (render, matting), 06 (chunks,
publish, sheet, finalize), 07 (attention, decisions), 10 (eval job) and **12** (`docs/specs/12-apparel-shot-set.md`,
initiative 1 merged; see 0.3 and 0.4). Uses spec 13 (`docs/specs/13-footwear-scene-image.md`) only where its
contracts are on `main` (placement after the scene image, `composeOnCanvas`, `pasteBackEqual`). Branch
`feat/catalog-18-infographic-image`, worktree `C:\Users\Sujan Ajay\Desktop\catalog-module-wt\18-infographic-image`.
Deploys `catalog-worker` and `catalog-web` through `infra/deploy.sh`; no new service and no new job.

Sources (cite by these short names): the approved plan `C:\Users\Sujan Ajay\.claude\plans\below-is-one-message-mossy-diffie.md`
(PLAN, sections A, B, C, D item 7, G); the marketplace research of 2026-10-28, copied to
`docs/plans/proposals/2026-10-28-marketplace-rules-research.md` ("research 2026-10-28", section numbers are its
headings: 1 image rules, 2 templates, 3 vocabularies, 4 approaches); the meeting transcript
`Ashish_New_Meeting/Ashish-Sujan-e91cba57-46f1.md` lines 42-65 and 147-149 (MEET); the image audit
`.runs/2026-10-26-image-audit.md` in the main checkout (AUDIT). SPEC line numbers are `docs/SPEC.md` on
`origin/main` at `ee0f4c9` (the docs branch base); where specs 12 and 13 cite `d82cc36`, that number follows in
brackets. Code pointers are `path:line` at `ee0f4c9`; bare `*.ts` names are under `packages/core/src/catalog/`.
Re-derive any line by its heading before editing.

Status: draft for owner approval. **Blocked until gate G0b (0.4) is closed.**

## 0. Scope, words, dependencies, SPEC amendments

### 0.1 Purpose and non-goals

An infographic image is one extra image per product that shows the brand's own product photo beside up to three
short feature highlights ("Cushioned footbed", "Canvas upper", "Rubber sole"), in the brand's colours and font
(MEET 42-52). The business picks which live products get one, by stock and visits, and sends the highlights in a
sheet; not every product gets one (MEET 55-65). This spec answers Ashish's open question "how do you want to take
output" (MEET 59): the infographic link comes back in the same links sheet as every other image, in its own
"<Channel> infographic" column and at its place in the image columns, and on the product page.

Today nothing makes infographics. 15 of 141 audited live products already carry brand-made infographics (AUDIT
L24, L115), and the ones we saw show why text must not be drawn by an image model: a generated Cardio Bunny
infographic is live with its text clipped at the edge ("MOVEMEI", AUDIT L195), and a US Polo infographic is a
600x800 padded image mixed into a 1600x1600 set (AUDIT L200). Image models still misspell, invent facts and place
text badly (research 2026-10-28, section 4).

Nine rules carry this spec (PLAN C, first-principles decisions 1 to 9, as they apply here):

1. **Text is composed by code, never drawn by an image model.** The text layer is SVG rendered by code with a
   font file we ship; the product pixels are the brand's own cut-out. V1 makes no paid call of any kind.
2. **The module never invents facts.** Every word on the image comes from the business's sheet, exactly as typed
   (byte for byte), after deterministic checks: at most 40 characters, no price, no word on the forbidden list.
3. **Marketplace rules are data.** Whether a channel takes text on an image, where an infographic may sit and
   whether a logo may show are rows in the channel policy table, each marked documented, assumed or reported by
   sellers, with its source. An admin changes them without a deploy.
4. **Sheet-driven, live products first.** A new infographic batch is a normal batch whose input is a highlights
   sheet read through the existing sheet ingestion. The products' current photos are carried into the batch, so
   nothing already live changes except the new image.
5. **Never image 1.** The infographic takes the last slot the channel's `max_images` allows, after every brand
   photo, made photo and scene image. A channel whose row says no text on images gets none, and the sheet says why.
6. **The product is never covered.** The product mask (the cut-out we already have) is kept clear of every panel,
   letter and logo, with a margin, and this is proved by code on every image.
7. **Review is for layout only.** Text correctness is checked by code; a person checks layout on the existing
   spot-check card, one person per image, until the brand has 50 clean infographics in a row; then 1 in 20.
8. **Arabic is V2.** The text is a separate layer from the start, so an Arabic variant is a second render, not a
   redesign (section 10).
9. **Order of dependencies, not priorities.** This spec needs spec 12 initiative 1 and the Brand DNA page shell;
   it does not need paid generation, so it can ship before initiative 3 by building the shell itself (0.4).

Non-goals (V1):
- No image model anywhere: no generated background, no generated text, no generated callout (V2 may add a
  background only, section 10).
- No person in an infographic: the base photo is always a product-only photo (packshot, flat lay, footwear or bag
  view). So Amazon's `contains-synthetic-performer` keyword (research 2026-10-28, section 1, Amazon) does not apply:
  the image holds no person, real or generated. Kids products are allowed for the same reason; the kids modesty and
  styling rules of specs 12 and 13 are unaffected.
- No product facts from photos or from brand data (spec 19), no highlight suggestions (V2), no listing templates
  (spec 20).
- No new screen: the flow uses the wizard, the batch page, the product page, the links sheet, the spot-check card
  and one new Brand DNA tab, "Brand voice" (2.5, section 7).
- No price, discount, sale, rating, award or marketplace badge on any image (1.5).
- No free text from a reviewer reaches the image; a reviewer picks reasons or another layout (6.3).
- No re-submission to marketplace portals by the module; the operator acts on the sheet's "What to do" (5.4).
- No infographic on new inflow without a sheet row (V2, PLAN G item 4), no infographic as image 1, no bulk approve.
- No model id or vendor name in any operator copy (spec 07 banned-names test); V1 calls no model, so none exists to
  leak.

### 0.2 Words

**Infographic (role `ig`, IG in copy):** the image made here: the brand's product photo, a text panel and up to
three highlights, optionally the brand's logo. **Highlight:** one short feature line from the sheet (columns
`highlight_1` to `highlight_3`). **Highlights sheet:** the business's sheet of products and highlights (2.1); a third
sheet kind beside "links sheet" and "product list" (SPEC L238, L242). **Base photo:** the one current brand photo of
the product, with no person, whose cut-out the infographic shows (2.4). **Cut-out / product mask:** the base photo's
alpha matte from the matte stage, placed on the canvas; the mask is every placed pixel with alpha 1 or more.
**Composed:** a new source kind (beside spec 12's `brand`, `derived`, `generated`): an image built by code from
brand pixels and sheet text, with no new product pixels. **Layout:** one of `bottom_band`, `side_panel`, `split`
(3.3). **Panel:** the solid-colour area that holds the text. **Safe box:** the part of a channel canvas where text,
panels and logo may sit (3.3). **Brand voice:** the Brand DNA part that holds the keyword family, brand colours,
font, logo placement and default layout (1.3, section 7). **Keyword family:** the words a brand uses about itself
(Campus "sports, running"; US Polo "lifestyle"; MEET 42-52); shown to writers, never added to an image by code.
**T1 to T9:** the infographic checks (section 4). **Spot check, "Checked by a person", "Automatic", "Paused",
"Needs me":** spec 12 s0.3 and s7. **Clean:** a person's "All good" on an infographic card (6.4). **Not made / Not
added:** an infographic that failed a check or a product rule (not made), or one channel that does not take it
(not added); neither ever publishes. **Carry:** re-inserting a product's current sources into a new batch so its
live outputs are kept (2.4, 5.3). **Switch:** `INFOGRAPHIC_ENABLED`, the deploy env flag (8.1).

### 0.3 What this spec takes from specs 12 and 13 (not re-specified here)

| From | Taken as is | Added by spec 18 |
|---|---|---|
| S12 s1.1 source columns | `kind`, `role`, `role_by`, `head`, `detection`; `MADE_N_BASE` = 101 and the next free made `n` per product, kept for life; `derivedPath` private files | kind `composed`, role `ig` (1.6) |
| S12 s1.2 outputs and options | `catalog_outputs.position`; `BatchOptions` slots | `options.infographic` (1.6) |
| S12 s1.3 labels and gate state | `catalog_review_labels` with `answers` and `origin`, `catalog_gate_state` with `scope`, `phase` and `evidence.sampleRate` | scope `infographic`, per brand (6.4) |
| S12 s1.4 channel policy | `catalog_channel_policy`, its admin `PUT` route, `ensureChannelPolicies` check-then-insert, `status` | six columns (1.4) |
| S12 s1.6 Brand DNA tables | `brand_style_profile` (versioned zod `body`, one approved per brand), `brand_dna_mark`, `brand_dna_word` | `body.voice` (1.3); marks used on images by code (7.3) |
| S12 s1.7 version sets and signals | `catalog_version_sets`, `catalog_signals` | the infographic versions and signal kinds (1.6) |
| S12 s2.1 to s2.4 roles, detection, flow | role and head state per photo, judge `view`, the step 4 plan with no inputs, "Details", the Products tab, the "Needs me" tab, the product page | the step 4 card, statuses and product page section (2.5, 5.5) |
| S12 s7.1 to s7.5 card, one person, exit, spot checks | the card in `listAttention`, `POST /api/catalog/review/[sourceId]`, one person per image, the deterministic product sample (`sampledForQa` pattern, `qa/policy.ts:67`), the 7-day expiry, pause and resume | the infographic card variant, its reasons, the per-brand exit and relapse (section 6) |
| S12 s8.1, s8.3, s8.4 order, change, sheet | order by `position`, `ls` last; `change` precedence; "What to do" column; "Details" worksheet | `ig` after `ls`; `infographic_added`; "<Channel> infographic" column (5.1, 5.4) |
| S12 s9.2, s9.6 Brand DNA page and Logos tab | the page `/catalog/brands/[slug]/dna`, admin only, tab pattern, "Add a logo file", approve and retire | the "Brand voice" tab (section 7) |
| S12 s11.5 evaluation programme | the nightly job, regression set, planted defects, Ops panels | the `infographic` check group (9.4) |
| S13 s1.5 channel policy | `max_images` (Trendyol 8, Amazon 9, Shein 10, VogaCloset 10, others null) | read for placement (5.1) |
| S13 s4.2, s4.5 | `composeOnCanvas`, `pasteBackEqual` | used for the product layer and check T8 (3.7, 4) |

If a contract in this table is not on `main` when spec 18 runs, spec 18 stops and reports it (00 section 11),
except the two named fallbacks of 0.4 (the Brand DNA shell and, if the owner agrees, the card shell) and the spec
13 helpers, which workstream C builds under the spec 13 names and signatures when spec 13 is not merged.

### 0.4 Before execution (manager checks; any open item is `Blocked:` in the report)

- [ ] **G0b, migration exception.** `00-execution-protocol.md` s11 lists the granted migrations: "(granted: 0002
      cost events, 0003 intake states, 0004 chunk leases, spec 12 `0005_shot_set.sql`, spec 13 `0006_scene.sql`)".
      This spec needs `0007_infographic.sql` (section 1) and additions to the 02 contracts `SOURCE_KINDS` (spec
      12's), `SHOT_ROLES` (spec 12's), `CHANGE_KINDS`, `OUTPUT_FLAGS`, `EVENT_KINDS` and `CHUNK_STAGES`, all
      additive. The owner types approval of this change to the granted list, which the manager commits in its own
      docs PR before this spec runs: "(granted: 0002 cost events, 0003 intake states, 0004 chunk leases, spec 12
      `0005_shot_set.sql`, spec 13 `0006_scene.sql`, spec 18 `0007_infographic.sql`)". The rule's other words stay.
      Until then this spec is `Blocked: owner approval of 0007_infographic.sql in 00 s11 (gate G0b)`, exactly as
      spec 12 is blocked on G0 (S12 s0.4). If spec 13 has not shipped `0006_scene.sql` when this spec merges, the
      migration is still numbered after the latest one on `origin/main` at merge time (00 s11), and the report says
      which number it took.
- [ ] **Spec 12 initiative 1 merged** (shipping plan, initiative 1): migration `0005_shot_set.sql`, the source
      columns, `catalog_channel_policy`, `brand_style_profile`, `brand_dna_mark`, `catalog_gate_state`,
      `catalog_review_labels`, `catalog_signals`, detection per photo (role, head, view), the Products tab and the
      sheet columns of S12 s8.4. Without it: `Blocked: spec 12 initiative 1 not on main`.
- [ ] **Brand DNA page shell.** If spec 12 initiative 3 (which builds the page with Logos, Brand words and Brand
      permissions) is merged, the Brand voice tab is added to it. If not, workstream I-lite (0.6) builds the shell
      at spec 12's paths (`apps/web/app/catalog/brands/[slug]/dna/page.tsx`, S12 s9.2) with two tabs only, "Logos
      and marks" (manual "Add a logo file", approve, retire; no harvester suggestions) and "Brand voice", so that
      initiative 3 later adds its tabs to the same page instead of building a second one.
- [ ] **Spot-check card shell.** Spec 12 s7.1 to s7.5 (card, review route, labels, gate state, sampling, expiry)
      arrives with initiative 2. If it is not merged, the default is to wait (`Blocked: spec 12 s7.1-s7.5 card not
      on main`); the alternative the owner may type is workstream G-lite, which builds exactly those contracts at
      spec 12's paths (`ReviewCard.tsx`, `catalog/shotset/review.ts`) and nothing of 7.6 (12.2 Q7).
- [ ] **G12, highlights sheet columns agreed** with Naaz and Taranum and typed by the owner: the columns of 2.1
      (proposal PLAN G item 3). The parser is built from the agreed list; any change is a spec edit.
- [ ] **G9, text-on-image rows approved as data** by the owner with the assumed rows marked (1.4). Soft: the seed
      applies by default; the owner may switch any row to `not_allowed`.
- [ ] **Test-run brand picked by the owner** (8.2) and a highlights sheet of about 50 of its live products supplied
      by the business.
- [ ] The fonts of 3.6 are on file with their licence text (assumed SIL Open Font License for every one; the
      builder confirms each licence and records it in `packages/core/assets/fonts/LICENSES.md`).

### 0.5 SPEC.md amendments (this spec's PR; exact text, applied by the manager after the owner's typed yes)

Lines on `ee0f4c9` (in brackets on `d82cc36` where specs 12 and 13 cite them). Specs 12 and 13 amend some of the
same paragraphs first; the edits below apply to the text they leave.

1. **Non-goal L894 [L869]**, "- No photo-shoot, template, gallery or prompt features from the earlier app." becomes:
   > - No photo-shoot, gallery or prompt features from the earlier app, and no image templates, with one
   > exception: the spec 18 infographic image, made only for products the business lists in a highlights sheet;
   > it shows the brand's own product cut-out, never covered and never regenerated, beside up to three highlights
   > typed by the business and rendered by code exactly as typed (never by an image model); it is never image 1,
   > never on a channel whose policy row says no text on images, and a person checks its layout until the brand
   > has 50 clean infographics in a row, then 1 in 20. Listing templates are spec 20's.
2. **Non-goal L882-884 [L857-859]** as spec 12's A5 leaves it: append "The spec 18 infographic regenerates no
   product pixel: the brand's cut-out is scaled and placed as in any render, and code proves its pixels unchanged."
3. **Image policy L314** (Backgrounds): after "output = product RGBA over the target colour;" insert "an infographic
   (spec 18) adds a solid text panel beside the product, never over it;".
4. **R2 L107-108**: append "A highlights sheet (spec 18: identifier, optional image link, highlight 1 to 3,
   optional layout and channels) is a third sheet kind; it adds an infographic to the products it lists and
   carries their current photos into the batch unchanged."
5. **Ingestion sources table, after L242**, new row: `| Highlights sheet (xlsx/csv or Google Sheet) | drag or paste,
   read as "highlights sheet" in "Check what we found" | parsed; highlight columns detected by header; each row
   checked by code (spec 18 s2.3) | identifier column; products matched to the catalog by the product-list rule |`
6. **R13 L147-149**: append "Spec 18 adds, per selected channel that has at least one infographic in the batch, one
   column '<Channel> infographic' after that channel's image columns, holding the infographic's link when it is
   live there."
7. **Re-submit list L406 and the `change` enum L409 [L397-398, L401]** as specs 12 and 13 leave them: the re-submit
   list gains `infographic_added` and the enum gains `infographic_added`.
8. **R21 L182**: append "Spec 18 infographics are checked by a person per brand until that brand's exit (50 clean
   in a row), then spot-checked 1 in 20."
9. **Data model heading L830 [L805]**: add "and spec 18's `0007_infographic.sql`" to the list specs 12 and 13 leave.
10. **Models table L464**: no change. The infographic uses no model; add one row: `| Infographic text (spec 18) |
    none: SVG composed by code, rendered with resvg-js from shipped font files, composited with sharp |
    catalog-worker | render time only, in the cost ledger (stage render, engine catalog_compute) |`
11. **Decisions log** (after the last entry): "Spec 18 (owner, <date of typed yes>): infographic images for the
    products the business lists in a highlights sheet (identifier, optional image link, highlight 1 to 3 of at
    most 40 characters each, optional layout and channels); text composed by code exactly as typed, never drawn by
    an image model, no price and no forbidden word; no person in an infographic; never image 1, last slot within the
    channel's maximum; text-on-image rules per channel are data marked documented, assumed or reported by sellers,
    Noon and Namshi a plain text band with no logo; layouts bottom band, side panel and split in the brand's colours
    and font; the product never covered (proved by code); one person checks layout until the brand has 50 clean in
    a row, then 1 in 20, with relapse; switch `INFOGRAPHIC_ENABLED` off at deploy, enabled per brand; test run on
    <brand>; V1 makes no paid call."

Spec 12 and 13 text this spec needs changed (the manager applies them in the same docs PR; listed so nothing is
silently assumed):
- S12 s9.2: the tab list gains "Brand voice" after "Kids look"; the summary strip gains "Brand voice: version <k>
  approved".
- S12 s9.6: the Logos tab notice "Logos are used only to check made photos. They are never given to the photo
  maker, so a logo is never added to a product that does not have one." gains the sentence "An approved logo file
  may also be placed by code on the brand's infographics (spec 18); it is never given to an image maker."
- S12 s1.1: `SOURCE_KINDS` gains `composed`, `SHOT_ROLES` gains `ig`; S12 s8.1 order: "then role `ls`, then role
  `ig` after all others".
- S13 s7.1 to s7.3: "LS comes last" reads "LS comes after every other source except a spec 18 infographic"; at a
  cap the infographic yields before the scene image (5.1, 12.2 Q5).

### 0.6 Workstreams and build order

| Workstream | Worktree suffix | Files owned | Depends on |
|---|---|---|---|
| A data and policy | `-a-data` | `drizzle/0007_infographic.sql`, `db/schema.ts`, `types.ts`, `infographic/types.ts`, `infographic/voice.ts` (zod), the channel policy and text rule seeds | spec 12 initiative 1 merged, G0b |
| B intake | `-b-intake` | `ingest/highlights-sheet.ts` (new), `ingest/detect-step.ts` (sheet kind), `infographic/rows.ts` (validation), `infographic/text-rules.ts`, `infographic/carry.ts`, `infographic/base.ts`, `apps/web/components/catalog/WizardStep2.tsx` (sheet kind line) | A |
| C compose | `-c-compose` | `infographic/layout.ts`, `fit.ts`, `svg.ts`, `compose.ts`, `packages/core/assets/fonts/*`, `render.ts` (`renderInfographic`; `composeOnCanvas` if spec 13 is not merged), `apps/worker/src/catalog/infographic-stage.ts`, chunk dispatch in `apps/worker/src/catalog/chunk.ts` | A (B fakes C's contract) |
| D checks | `-d-checks` | `infographic/checks.ts` (T1 to T9), `infographic/contrast.ts`, `compliance.ts` (the `ig` skip list) | A, C contract |
| E publish and sheet | `-e-publish` | `pipeline/publish.ts` (placement 5.1), `pipeline/report.ts`, `sheet.ts` ("<Channel> infographic"), `decisions.ts` ("Remove infographic") | A, C |
| F operator flow and review | `-f-ui` | the step 4 card in `WizardStep4.tsx`, the Products tab statuses, the infographic card variant in `ReviewCard.tsx` and `AttentionProductCard.tsx`, the product page section, the Brand voice tab (`apps/web/app/catalog/brands/[slug]/dna/voice.tsx`), `public/catalog/templates/highlights.xlsx`, operator guide | A, D, E contracts; spec 12 card and page shells |
| I-lite Brand DNA shell (only if initiative 3 is not merged) | `-i-shell` | `apps/web/app/catalog/brands/[slug]/dna/page.tsx`, Logos tab (manual add, approve, retire), the page's admin guard | A |
| G-lite card shell (only on the owner's typed yes, 0.4) | `-g-card` | spec 12 s7.1 to s7.5 contracts at spec 12 paths, nothing of s7.6 | A |
| H evals and ops | `-h-evals` | `evals/infographic.ts`, the layout regression set and planted defects, the nightly group, the Ops "Infographics" block, `docs/handover/` notes | C, D, E |

Hot files (one owner at a time; spec 12 and 13 owners merge first and this spec rebases): chunk dispatch
(`apps/worker/src/catalog/chunk.ts`), `render.ts`, `pipeline/publish.ts`, `pipeline/report.ts`, `sheet.ts`,
`ingest/detect-step.ts`, `WizardStep4.tsx`, the attention card, the Ops page, the Brand DNA page.

Before using sharp's composite and raw output, `@resvg/resvg-js`, opentype.js, ExcelJS or drizzle migrations, the
builder fetches current docs through Context7 (00 section 4). Read for this spec on 2026-10-28 through Context7:
sharp `composite()` (inputs as buffer or `raw`, `top`, `left`, `blend: "over"`) and `raw()` with `ensureAlpha()` and
`extractChannel()` (`/lovell/sharp`, v0.35.5, the version in `packages/core/package.json`); resvg-js `new
Resvg(svg, { font: { fontFiles, loadSystemFonts: false, defaultFontFamily } })`, `render().asPng()`
(`/thx/resvg-js`); opentype.js `parse`, `Font.getAdvanceWidth(text, fontSize, options)`, `charToGlyph`, glyph and
path bounding boxes (`/opentypejs/opentype.js`). Exact method names that this spec uses beyond those are
**assumed** and re-checked by the builder.

## 1. Data model (`packages/core/drizzle/0007_infographic.sql`)

One additive migration generated by drizzle-kit from `db/schema.ts`: new tables, new nullable or defaulted columns,
widened enum checks; no rewrite or drop of existing rows or columns. Re-run is a no-op.

### 1.1 `catalog_infographic_rows` (one per sheet row per batch)

| Column | Type | Meaning |
|---|---|---|
| `id` | uuid PK | |
| `batch_id` | uuid FK `catalog_batches` | |
| `upload_id` | uuid FK `catalog_uploads` | the highlights sheet |
| `sheet_title`, `sheet_row` | text, int | where the row is, for sentences ("Row 7") |
| `identifier_raw` | text | the cell as typed |
| `product_id` | uuid FK `catalog_products` null | the matched product (2.4); null when not matched |
| `image_link` | text null | the cell as typed |
| `highlights` | jsonb | `[{ k: 1|2|3, text, raw }]`: `raw` is the cell, `text` the stored string (2.3), empty cells left out |
| `layout_requested` | text null | `bottom_band`, `side_panel`, `split`, `auto`, `none` (2.3) |
| `channels_requested` | jsonb null | channel ids parsed from the `channels` cell |
| `status` | text `accepted,rejected` | |
| `problems` | jsonb | `[{ field, code, sentence }]` (2.3) |
| `is_current` | boolean default false | true on the newest accepted row of a product (one per product) |
| `created_at` | timestamptz | |

Unique (`batch_id`, `upload_id`, `sheet_row`); partial unique (`product_id`) where `is_current`. Rows are never
edited; a later sheet row for the same product sets the older row's `is_current` false in the same transaction.
They hold business text only (no customer data); the forbidden-word rules keep price and claims out (1.5).

### 1.2 `catalog_infographics` (one per composed source)

| Column | Type | Meaning |
|---|---|---|
| `id` | uuid PK | |
| `product_id`, `batch_id` | uuid FK | |
| `source_image_id` | uuid FK `catalog_source_images` | the composed source (kind `composed`, role `ig`) |
| `row_id` | uuid FK `catalog_infographic_rows` | the highlights used |
| `base_source_id` | uuid FK `catalog_source_images` | the base photo (2.4) |
| `base_origin` | text `rule,sheet_link,own_link` | how the base was chosen (2.4) |
| `version` | int | per product, from 1; +1 on every new composition (5.3) |
| `layout_version` | text | `INFOGRAPHIC_LAYOUT_VERSION`, starts at `"1"` |
| `voice_profile_id`, `voice_profile_version` | uuid, int | the approved `brand_style_profile` row used |
| `font_id`, `font_sha` | text | from the fixed list (3.6), sha256 of the font file |
| `logo_mark_id`, `logo_mark_version` | uuid null, int null | the approved `brand_dna_mark` placed, if any |
| `compose_key` | text | sha256 of the inputs above plus the base sha, the stored texts and the channel rows read (5.3) |
| `state` | text | `planned,composing,checking,in_review,ready,live,not_made` |
| `why` | text null | when `in_review`: `test_run,brand_new,spot,paused,relapse` (6.2) |
| `not_made` | text null | the reason key of 4.3 |
| `per_channel` | jsonb | `{ <channel>: { layout, requestedLayout, fontPx, lines, boxes, checks, outcome, sentence, ms } }` |
| `created_at`, `updated_at` | timestamptz | |

The composed source row (`catalog_source_images`): `kind = 'composed'`, `role = 'ig'`, `role_by = 'planner'`,
`head = 'na'`, `n` the next free made number from `MADE_N_BASE` (101), kept for life so the public link
`<pathKey>_<n>.jpg` never changes (S12 s1.1); `raw_uri` the private PNG of the composition on the 3:4 reference
canvas 1792x2400 at `derivedPath(prefix, pathKey, n, "ig")` (`naming.ts:133`), used by the card and the product
page; `sha256` of that PNG; `derivation = { type: "compose", infographicId, composeKey, layoutVersion }`. The matte,
render and QA stages skip role `ig` (3.1). Each channel image is a normal `catalog_outputs` row with `n`,
`position`, flags `infographic`, `compliance.infographic` (the 4 check results in words and numbers) and
`qa_scores = { kind: "infographic", checks }`, so no `ig` output is ever "unjudged" (`pipeline/publish.ts:107`).

### 1.3 Brand voice: `brand_style_profile.body.voice` (table from S12 s1.6)

No new column. The profile's zod `body` gains an optional key `voice`; a profile without it, or with
`voice.enabled = false`, means infographics are off for the brand. A change is a new profile version (S12 s1.6),
approved on the Brand voice tab (section 7).

```ts
// packages/core/src/catalog/infographic/voice.ts
export const LAYOUTS = ["bottom_band", "side_panel", "split"] as const;
export const LOGO_PLACES = ["top_left", "top_right", "bottom_left", "bottom_right", "none"] as const;
export const FONT_IDS = ["inter", "montserrat", "poppins", "lato", "noto_sans"] as const;     // 3.6
const Hex = z.string().regex(/^#[0-9A-F]{6}$/);
export const BrandVoice = z.object({
  enabled: z.boolean(),
  keywordFamily: z.array(z.string().min(1).max(30)).max(12),        // shown to writers only (0.2)
  colours: z.object({ panel: Hex, text: Hex, accent: Hex }),
  font: z.enum(FONT_IDS),
  logo: z.object({ markId: z.string().uuid().nullable(), place: z.enum(LOGO_PLACES) })
    .refine(l => l.place === "none" || l.markId !== null),
  defaultLayout: z.enum([...LAYOUTS, "auto"]),
  panelSide: z.enum(["right", "left"]),                              // side_panel and split
}).refine(v => contrastRatio(v.colours.text, v.colours.panel) >= IG_MIN_CONTRAST);     // 4, T4
export const DEFAULT_VOICE: z.infer<typeof BrandVoice> = { enabled: false, keywordFamily: [],
  colours: { panel: "#FFFFFF", text: "#1A1A1A", accent: "#1A1A1A" }, font: "inter",
  logo: { markId: null, place: "none" }, defaultLayout: "auto", panelSide: "right" };
```

A database check on approve: the named mark is `approved`, of the same brand, kind `logo` or `wordmark`, and has a
file uploaded by an admin (`source = 'upload'`, S12 s1.6), PNG with alpha, long side at least 600 px. A mark cut from
photos by the harvester is never placed on an image (its edges are not clean enough).

### 1.4 Channel policy columns (on S12 s1.4's `catalog_channel_policy`)

New columns, read from the channel's `*` department row in V1 (a department row's values are ignored for
infographics until a later spec needs them):

| Column | Type | Meaning |
|---|---|---|
| `text_on_image` | text `allowed,assumed_allowed,not_allowed`, default `assumed_allowed` | may an extra image carry added text |
| `text_on_image_status` | text `documented,assumed,seller_reported`, default `assumed` | what the value rests on |
| `text_on_image_source` | text null | URL or document reference, with the date it was read |
| `infographic_slot` | int null, check `>= 2` | the last position at which an infographic is placed; null = no limit beyond `max_images` (5.1) |
| `infographic_style` | text `branded,plain_band`, default `branded` | `plain_band`: bottom band only, solid band, text only (3.6) |
| `infographic_logo` | boolean default true | may the brand's logo show on this channel's infographic |

Seed (check-then-insert through `ensureChannelPolicies`, filling only nulls, never overwriting an owner's value).
Every row is from research 2026-10-28, section 1; "[DOC]", "[3P]" and "[NOT FOUND]" there map to `documented`,
`seller_reported` and `assumed`:

| Channel | `text_on_image` | status | Source and wording | style | logo |
|---|---|---|---|---|---|
| amazon | assumed_allowed | seller_reported | eComEngine (2025-02-27) on the Amazon style guide: additional images may carry "props, backgrounds, text, graphics, logos"; Feedvisor: "text or demonstrative graphics"; the style guide PDF itself was not readable (section 1, Amazon) | branded | true |
| noon | assumed_allowed | documented | noon partners "Image Requirements and Rejection Reasons": text allowed if "not offensive or in any way inappropriate"; "No logos, watermarks, unwanted text or objects"; "Only photographs are permitted, CAD drawings, thumbnails, or illustrations are not allowed" (section 1, Noon) | plain_band | false |
| namshi | assumed_allowed | assumed | no public rule; noon-owned, Partner Portal on noon infrastructure, so treated as noon (section 1, Namshi) | plain_band | false |
| trendyol | assumed_allowed | seller_reported | Turkish seller guides say text and watermarks can cause rejection; no official page (section 1, Trendyol); highest risk, 12.2 Q2 | branded | true |
| shein | assumed_allowed | assumed | not found (section 1, SHEIN) | branded | true |
| vogacloset | assumed_allowed | assumed | not found; Tradebyte sheet has no text rule (section 1, VogaCloset) | branded | true |
| styli | assumed_allowed | assumed | not found; managed by the Styli account team (section 1) | branded | true |
| centrepoint | assumed_allowed | assumed | not found; vendor-managed (section 1) | branded | true |
| sixthstreet | assumed_allowed | assumed | not found (section 1) | branded | true |

`infographic_slot` is null on every row (12.2 Q4 asks about Amazon, where sellers report that the first 7 of up to 9
images show, research 2026-10-28, section 1, Amazon, "Counts"). Noon's "only photographs" rule is why its rows start
as a plain band over the unchanged product photo: the band is a flat colour with text, not a drawing, and the product
is the brand's photograph; the row stays `assumed_allowed` until the channel manager answers (G9). The Ops page shows
the new columns with their status and source; the admin `PUT` route accepts them (S12 s1.4).

### 1.5 `catalog_text_rules` (forbidden words and price, as data)

`id`, `scope` (`program,channel,brand`), `scope_key` (`*`, a channel id or a brand slug), `kind`
(`word,phrase,pattern`), `value` (a word or phrase matched case-insensitively on word boundaries, or a pattern in
the RE2 subset), `reason` (`price,promotion,superlative,restricted_claim,marketplace_badge,brand_rule`),
`status` (`documented,assumed,seller_reported`), `source` text null, `enabled` boolean, `updated_by`,
`updated_at`. Unique (`scope`, `scope_key`, `kind`, `value`). Seeded check-then-insert, edited by an admin on the
Ops page (`PUT /api/catalog/text-rules/[id]`, admin only, the S12 s1.4 route pattern); every edit is a
`catalog_signals` row `policy_edit`.

Seed, scope `program` (applies to every channel and brand):
- `price`, patterns: a currency code or sign next to a number (`AED`, `SAR`, `KWD`, `QAR`, `BHD`, `OMR`, `USD`,
  `INR`, `Rs`, `$`, `€`, `£`, `₹`, `د.إ`, `ر.س`), `\b\d+\s?%\s?off\b`, `\b(was|now)\s+\d`; status `assumed` (the
  owner's rule: no price on an image). A percentage that is not a discount stays allowed ("100% cotton").
- `promotion`, words: "sale", "discount", "offer", "deal", "free", "buy 1", "limited time", "clearance"; `assumed`.
- `superlative` and `marketplace_badge`: "best seller", "bestseller", "top-rated", "top rated", "#1", "number one",
  "Amazon's Choice", "Amazon Choice", "guaranteed"; `seller_reported` (research 2026-10-28, section 1, Amazon:
  sellersonar, myamazonguy).
- `restricted_claim`: "eco-friendly", "biodegradable", "antibacterial", "antimicrobial", "anti-bacterial",
  "anti-microbial", "non-toxic"; `seller_reported` (same section; the pesticide-claim rule is US-driven and its
  reach to AE and SA is unverified, so the rows apply everywhere as the cautious default).
Scope `brand` rows are added by an admin per brand (for example a word the brand's legal team bans); none seeded.

### 1.6 Enums, options, ledger, versions

- `SOURCE_KINDS` (S12 s1.1) adds `composed`; `SHOT_ROLES` adds `ig` (code IG; never a required role on any
  channel, never image 1).
- `CHANGE_KINDS` (`types.ts:10`) adds `infographic_added`; the re-submit list and precedence of 5.2.
- `OUTPUT_FLAGS` (`types.ts:14`) adds the information flag `infographic` and the failure flags `ig_text_outside`,
  `ig_covers_product`, `ig_text_mismatch`, `ig_glyph_missing`, `ig_low_contrast`, `ig_logo_missing`,
  `ig_forbidden_word`, `ig_does_not_fit`, `ig_product_changed`, `ig_product_small` (section 4).
- `EVENT_KINDS` (`types.ts:28`) adds `infographic_added`, `infographic_updated`, `infographic_retired`,
  `infographic_not_made`, `infographic_relapse`, `infographic_exit`; spot-check, pause and resume events are spec
  12's, written with `scope = 'infographic'`.
- `CHUNK_STAGES` (`schema.ts:60`) adds `infographic`. The widened check constraint is part of the migration.
- `catalog_signals.kind` (S12 s1.7) adds `highlight_row_rejected`, `infographic_layout_retry`,
  `infographic_removed`, `voice_versioned`.
- `BatchOptions` (`types.ts:60-68`) gains `infographic?: { sheetDriven: boolean; rows: number; testRun?: boolean }`,
  written by the start route from the highlights sheet (2.5); absent means no infographic step.
- `catalog_uploads.detected` records `sheetKind: "highlights"` and the column mapping (2.2); no new upload kind.
- Ledger: one `catalog_cost_events` row per composed output, existing stage `render`, kind `render`, spend engine
  `catalog_compute`, with `ms` and the USD computed from it (3.8). No `llm_call`, no `generate_call`.
- `catalog_version_sets` (S12 s1.7) records, for an infographic, `INFOGRAPHIC_LAYOUT_VERSION`, the font sha, the
  voice profile version, the logo mark version and `CHANNEL_RULES_VERSION` plus the channel policy rows read.
- `CHANNEL_RULES_VERSION` (`channels.ts:216`) is **not** bumped: infographic outputs have their own key (5.3), so no
  existing output re-renders because of this spec.

## 2. Input: the highlights sheet

### 2.1 Columns (gate G12; PLAN G item 3)

One row per product. Header names are compared after the SPEC L267 normalisation (lowercase, letters and digits
only), so "Highlight 1", "highlight_1" and "HIGHLIGHT-1" are the same column.

| Column | Required | Rule |
|---|---|---|
| `identifier` | yes | the style+colour identifier, or the style and colour-code pair, as the links sheet reads it (SPEC L270-272); also accepted under the identifier headings the links sheet knows |
| `image_link` | no when the product exists; yes otherwise | an https link to a photo of the product (2.4) |
| `highlight_1` | yes | at most 40 characters (2.3) |
| `highlight_2`, `highlight_3` | no | at most 40 characters each; empty cells are left out, and the lines close up |
| `layout` | no | `bottom band`, `side panel`, `split`, `auto` (empty = the brand's default), or `none` to remove this product's infographic (5.3) |
| `channels` | no | channel names as in SPEC L224 (Noon, Namshi, Trendyol, Styli, Centrepoint, 6thStreet, VogaCloset, Shein, Amazon), separated by `,` or `;`; limits this product's infographic to those channels among the ticked ones |

There is no price column, no description column and no free-form notes column. Extra columns are ignored and listed
once ("Columns not used: <names>."). A downloadable template with these headers, one example row and an
instructions sheet (the 2.3 rules in plain words, and "Words this brand uses: <keyword family>" filled per brand
when downloaded from the product's brand page) is served at `/catalog/templates/highlights.xlsx`; the operator
guide links it.

### 2.2 Detection as a third sheet kind

`ingest/detect-step.ts` reads every sheet as today. A sheet whose header row (found by the SPEC L268 rule) contains
`highlight1` is read as a **highlights sheet**, whatever else it contains; its `image_link` column is never read as
a shot column. "Check what we found" shows "Sheet `<name>`: identifier column `<header>`, <h> highlight columns,
read as highlights sheet" with Change (the kind is a real control, as SPEC L275-276 says for the other two kinds).
A batch takes at most one highlights sheet (a second one: "Use one highlights sheet per batch. <name> was not
read."). A highlights sheet can sit beside photo uploads or a links sheet in the same batch; the photos then belong
to their products as today.

With `INFOGRAPHIC_ENABLED` not `1`, the sheet is still detected but not used: "This sheet has highlight columns.
Infographics are not switched on yet, so this sheet was not read." and the batch continues without it. No language
model takes part in detection, matching or validation (SPEC L85-87); all of it is code with unit tests.

### 2.3 Row checks (deterministic; a failing row is left out with a sentence, the others go on)

`checkHighlightRow(row, ctx)` in `infographic/rows.ts`, in this order; every failure is collected (not first-stop),
stored in `problems`, shown in step 2 and step 4 "Details", and written to the links sheet "Details" worksheet with
the row number. Nothing is corrected silently.

1. **Identifier.** Empty: "Row <r>: no identifier." Duplicated in the sheet: the first row is used and the others
   get "Row <r>: <identifier> appears again in row <first>; the first row is used." (SPEC L277-278 rule).
2. **Stored text.** `text` is the cell value with leading and trailing white space removed and nothing else
   changed: no case change, no spelling fix, no quote or dash substitution, no Unicode normalisation. `raw` keeps
   the cell. The rendered string must equal `text` byte for byte in UTF-8 (T3).
3. **Length.** At most 40 Unicode code points: "Row <r>: highlight <k> is <n> characters long; the most is 40.
   Shorten it." `highlight_1` empty: "Row <r>: highlight 1 is empty."
4. **One line, plain characters.** A tab, a line break, two spaces in a row, a control character or an emoji:
   "Row <r>: highlight <k> has <a line break | a tab | two spaces in a row | an emoji>. Use one line of plain text."
5. **Script.** Any character outside Latin, Latin-1 Supplement, Latin Extended-A, general punctuation and digits
   (so Arabic, Devanagari and CJK): "Row <r>: highlight <k> uses letters we cannot show yet. Arabic comes in a later
   version." (section 10).
6. **Glyphs.** Every character must have a glyph in the brand's approved font (`charToGlyph(c).index !== 0`): "Row
   <r>: highlight <k> has a character the brand's font cannot show (<c>)." Checked again at compose time (T3).
7. **Forbidden words and price.** Every enabled `catalog_text_rules` row of scope `program`, of the brand, and of
   every ticked channel: "Row <r>: highlight <k> has <a price | a promotion word | a word marketplaces do not
   allow> ("<matched text>"). Change it and upload the sheet again."
8. **Brand name spelling.** When the brand has approved Brand words (S12 s9.6), a highlight token that is a near
   miss of one (the G2c rule of S12 s6.2) but not exact: "Row <r>: highlight <k> spells "<token>"; the brand's
   approved spelling is "<word>"."
9. **Layout and channels.** An unknown layout word: "Row <r>: layout "<value>" is not one of bottom band, side
   panel, split, auto or none." An unknown channel name: "Row <r>: channel "<value>" is not a marketplace we know."
   A channel not ticked for the batch: "Row <r>: <Channel> is not ticked for this batch, so no infographic is made
   for it."
10. **Image link.** Not https, not fetchable through `safeFetch` (`safe-url.ts`), or not an image: the SPEC L278-279
    link sentence with the row and column.

`layout = none` rows skip checks 3 to 8 (they carry no text) and need an existing product.

### 2.4 Matching products, the base photo, carrying current photos

**Matching.** A row's identifier is matched to `catalog_products` of the batch's brand by the product-list rule
(SPEC L280-288: base identifier, `_rect` and `_square` shapes, the size-row rule, the style and colour-code pair).
- Matched: the product is in the batch; its current sources are carried (below).
- Not matched, with an `image_link`: the link is read as shot 1 of a new product of that identifier, through the
  normal links-sheet path, and the product is made as any new product; its infographic sits at position 2 or later
  (never 1). Step 4 says "<n> products are not in the catalog yet: their image link becomes their first photo."
- Not matched, without an `image_link`: rejected, "Row <r>: <identifier> is not in the catalog for <brand>, and the
  row has no image link."
- Matched, but the product is locked by a running batch (`lock_batch_id`): the row waits like any product of a
  batch (the existing lock rule); it is never skipped silently.

**Carrying current photos (`infographic/carry.ts`).** `planPublish` deletes a live output whose `n` has no source
row in the batch (`pipeline/publish.ts:63`), so a batch that brings no photo for a product would delete its live
images. For every matched product without new photos in the batch, the batch re-inserts each current source of the
product (brand, and spec 12 and 13 made sources by their own carry rules, S12 s3.5, S13 s2.4) as a source row of the
batch with the same `n`, `sha256`, `raw_uri`, `matte_uri`, `kind`, `role`, `detection` and `derivation`, status
`matted` (no download, no matte call). The render stage then finds a live output with the same key and makes
nothing (`apps/worker/src/catalog/chunk.ts:306-307`), so brand outputs stay `kept` and are not copied again. A
product that also has new photos in the batch follows today's overwrite rule for its photos (SPEC R14), and its
infographic is composed from the new current set. The carry runs in the collect step, before grouping is shown,
so step 4 counts are exact. Spec 12 initiative 6 ("already live, on request") shares this function.

**Batch behaviour.** A highlights-sheet batch (`options.infographic.sheetDriven`) makes infographics and nothing
else new: spec 12's shot-set planning runs in report mode only (no crop, no generation; `options.shotSet` absent),
and spec 13's scene step is off (`options.scene.mode = 'off'`), so a highlights batch never spends on paid calls.
Carried made photos and scene images stay as they are. A new product brought by an image link is processed by the
normal pipeline (matte, render, QA judge), whose costs are today's.

**Base photo (`infographic/base.ts`).** The base is one current brand source of the product with no person, chosen
in this order:
1. The `image_link`, when it is one of this product's own public links (`catalog/<brand>/<path_key>/<channel>/
   <path_key>_<n>.jpg`, parsed by code): the source at that `n` (`base_origin = own_link`).
2. The `image_link`, when its downloaded bytes equal the sha256 of a current source of the product: that source
   (`sheet_link`).
3. The `image_link`, when it is a different photo: it is stored privately as the base only, at
   `derivedPath(prefix, pathKey, n, "ig-base")`, matted once, and never published as its own image; note "The photo
   at the image link is used for the infographic only." (`sheet_link`).
4. No link: the first current brand source by role and view: footwear and bags (spec 13 presence `packshot`) by
   judge view `side`, `pair`, `top`, `front`; apparel by role `flat`, `pk`, `fb`; then the lowest `n`
   (`rule`).
Every candidate must have head state `na` and no person (S12 s2.1 detection; a detection `null` is "not checked"
and does not qualify), not be role `chart`, carry no `text_or_watermark`, `small_source` or hold flag, have a long
side of 500 px or more (`channels.ts:214`), and have a clean saved matte (not `fallback_matte`, `passthrough`, a
busy background or `cut_in_source`; the spec 13 s4.1 rule, `matte-guard.ts:1021,1030`). A link photo (3) that shows
a person or fails a rule is not used: "The photo at the image link shows a person or cannot be cut out cleanly, so
it was not used." and the rule order (4) runs. No base at all: not made, `no_base_photo` (4.3). An apparel product
with only on-model photos therefore gets no infographic in V1 (12.2 Q10).

### 2.5 Operator flow

Written from the operator's seat; the copy is plain, never names a model, vendor or check, and every default is
right without reading. The flow adds no screen of its own. A batch with no highlights sheet looks exactly as today.

1. **Prepare the sheet.** The business (Naaz or Taranum) fills the template (2.1) for the products it picked by
   stock and visits: one row per product, at most three highlights of at most 40 characters, no price.
2. **Upload.** "New batch" (`apps/web/components/catalog/CatalogWizard.tsx`), step 1 "Brand and files": pick the
   brand and drop the sheet or paste its Google Sheet link (shared as SPEC L239 says). Photos may come too, but are
   not needed for products already in the catalog.
3. **Check what we found** (step 2, `WizardStep2.tsx`): the sheet line "Sheet `<name>`: identifier column
   `identifier`, 3 highlight columns, read as highlights sheet" with Change, then "<a> rows ready, <b> rows left
   out" and, when any is left out, the list of row sentences of 2.3 (first 20, then "and <k> more in Details").
   Fixing a row means editing the sheet and adding it again; nothing is typed here.
4. **Channels** (step 3, `WizardStep3.tsx`): as today, nothing pre-ticked (SPEC R10). The help line under the
   cards, only for a highlights batch: "Tick the marketplaces where these products are live."
5. **Plan on step 4** (`WizardStep4.tsx`): one card "Infographics", shown only when the batch has a highlights
   sheet, with no input on it:
   - first line, bold: "Infographics: 42 products carry highlights. Each gets one infographic, shown last.";
   - second line, by the brand's phase (6.2): "A person checks each one until this brand has 50 good ones in a
     row." or "They go live once they pass our checks. We check 1 in 20 by hand.";
   - third line: "The words come from your sheet exactly as typed. No extra cost.";
   - when the brand's voice is not approved: "Infographics are switched off for this brand. An admin switches them
     on in the brand's Brand DNA page, Brand voice tab." (and no infographic is planned);
   - "Details" (closed): "<b> rows were left out:" with the 2.3 sentences; "<c> products have no photo without a
     person, so they get no infographic."; "<d> products are not in the catalog yet: their image link becomes
     their first photo."; "On Noon and Namshi: a plain text band, no logo."; "<e> marketplaces do not take images
     with added text: <names>." (from rows `not_allowed`); "Layouts: <x> bottom band, <y> side panel, <z>
     split."; "Photos already live stay as they are."
6. **Make.** Nothing to do. The batch page progress line adds "Infographics: 30 made, 5 being checked, 7 not made".
   The Products tab shows one status per product (5.5 table).
7. **Spot check** ("Needs me", section 6): an infographic waits for one person while the brand is "Checked by a
   person", when its product is picked for a spot check (1 in 20), or when automatic publishing is paused. One card
   per product, layout reasons only (6.3).
8. **Links sheet** (5.4): the "What to do" column says "Re-submit images on Noon and Amazon"; the
   "<Channel> infographic" column holds each link.
9. **Re-submit.** For each `infographic_added` row, on each channel named, the operator uploads the product's image
   columns again from the sheet (the infographic is last), exactly as for `updated` today; or pastes the one link
   from "<Channel> infographic" where the portal allows adding one image.
10. **Change or remove later.** A new sheet row for the product makes a new version at the same link (5.3); a row
    with layout `none`, or "Remove infographic" on the product page, removes it (5.3).

States and defaults at a glance:

| Screen | Shown when | Default | Operator action |
|---|---|---|---|
| Step 2 sheet line | a highlights sheet is in the batch | read as highlights sheet | none, or Change |
| Step 2 row list | a row failed a 2.3 check | listed, left out | fix the sheet if wanted |
| Step 4 "Infographics" card | a highlights sheet is in the batch | as computed | none |
| Spot-check card | 6.2 | nothing pre-selected | "All good" or one action |
| Product page "Remove infographic" | the product has a live infographic and is not locked | none | optional |
| Sheet "What to do" | every product | as computed | re-submit where it says |

## 3. Composition engine

### 3.1 Where it runs

New chunk stage `infographic`, one chunk per up to 20 products with an accepted row, created by the QA stage once
every carried and new source of those products has its matte and detection (as spec 13 s3.1 creates its scene
chunk after triage, `apps/worker/src/catalog/qa-stage.ts:204`); writes run under the chunk lease (`underClaim`,
`apps/worker/src/catalog/chunk.ts:48`). For a product with a queued or running `infographic` chunk, the QA chunk's
`finish` skips the publish enqueue and the infographic chunk's `finish` enqueues it, so the product publishes once
with its IG row present (the spec 13 s3.1 rule). Role `ig` is skipped by the matte, render and QA stages
(`renderFor("ig")` is `{ mode: "composed", matte: false, outputJudge: false }`, the spec 13 s1.4 pattern; without
spec 13, a two-entry `ROLE_RENDER` in `infographic/types.ts` with the same shape). The stage, per product:
`planned` -> `composing` -> per channel compose and check (3.2 to 3.7, section 4) -> `checking` done -> `ready`
(outputs `staged`) or `in_review` (outputs `needs_attention`, 6.2) or `not_made` (outputs `skipped`, 4.3).

### 3.2 Base cut-out

The base photo's raw pixels and saved alpha (`resolveMatte`, `apps/worker/src/catalog/chunk.ts:202`, with the
footwear sole-strip recovery the render uses). The product box is the alpha's bounding box (alpha 1 or more). The
contact shadow is the module's own (`shadowLayer`, `shadow.ts:149`; synthesised for footwear and bags, none for
apparel, SPEC L314-318). Product pixels are never changed except by the scaling every render does.

### 3.3 Canvas, safe box, regions

- **Canvas:** the channel's `targetCanvas` (`channels.ts:54-180`): Noon and Namshi 1080x1480, Trendyol 1200x1800,
  Styli 2342x3123, Centrepoint 3000x3000, 6thStreet and VogaCloset 2000x2667, Amazon and Shein 2000x2000. Background
  the channel's `background` (`#E0E0E0`); an infographic is never image 1, so `firstImageBackground` never applies.
- **Safe box S:** the canvas less the channel's margins (`margins`, SPEC L193-201: Noon top and bottom 10% and side
  5%; Namshi top and bottom 10%; Styli guides 450, 450, 150, 150 px), and less `IG_INSET` = 4% of the canvas's
  short side on every side that has no margin. Text, panels (except the `split` panel's full-bleed fill, below),
  bullets and the logo stay inside S.
- **Clearance:** `IG_CLEARANCE` = 1% of the short side (at least 12 px): the gap kept between the product mask and
  anything drawn over the canvas.
- **Regions per layout** (fractions of S; the product region holds the cut-out, the text region holds the panel):

| Layout | Text region | Product region | Gutter | Panel |
|---|---|---|---|---|
| `bottom_band` | bottom 30% of S, full width | top 70% of S less the gutter | 3% of S height | a solid band filling the text region |
| `side_panel` | 40% of S width on `panelSide`, full height | the other 60% less the gutter | 3% of S width | a solid rectangle filling the text region, corner radius 2% of S width |
| `split` | 45% of the canvas width on `panelSide`, full canvas height (fill only); its text box is the part of the region inside S | the other side, within S, less the gutter | 3% of S width | a full-bleed solid fill from the canvas edge |

The cut-out is scaled to fill 0.92 of the product region on its binding side, never above `MAX_UPSCALE` 1.5
(`channels.ts:211`; a small product stays smaller, and T8 decides whether it is still large enough), centred in the
region, or bottom-centred on Styli (its anchor rule, SPEC R8). The contact shadow is drawn under it as in the render.

### 3.4 Layout choice and fallback

Per channel, in this order, the first layout whose text fits (3.5) and whose checks T7 and T8 pass is used:
1. A channel with `infographic_style = plain_band` (Noon, Namshi): `bottom_band` only, plain (3.6). If it does not
   fit, that channel gets no infographic ("Not added: the highlights are too long for a text band on <Channel>.
   Shorten them in your sheet.").
2. The row's `layout` when it names one; else the brand's `defaultLayout` when not `auto`.
3. Auto, from the product box's width over height `a`: `a >= 1.2` (most shoes, bags on their side) tries
   `bottom_band`, `split`, `side_panel`; `a <= 0.8` (tall garments, upright bags) tries `side_panel`, `split`,
   `bottom_band`; otherwise `split`, `bottom_band`, `side_panel`.
A requested layout that did not fit falls back to the auto order and the product page and Details note say "Made
with the <used> layout: the <requested> layout did not fit on <Channel>." (`infographic_layout_retry` signal).
No layout fits on any ticked channel: not made, `does_not_fit`.

### 3.5 Text fitting (`infographic/fit.ts`, code only)

- One font size for all highlights of one image, the largest that fits, found by stepping down 1 px from
  `maxPx` = 7% of S height (bottom band: 9% of the text region height) to `IG_MIN_FONT_PX` = the larger of 28 px and
  2.8% of the canvas's short side (Noon 30 px, Trendyol 34 px, Amazon 56 px, Centrepoint 84 px). Below the floor
  the layout does not fit (T7).
- Widths come from the font file with opentype.js (`getAdvanceWidth` with kerning on); ink boxes from the glyph
  paths. Line height 1.25 x font size; 0.6 x font size between highlights.
- Wrapping: a highlight is broken only at a single space (2.3 rule 4 guarantees there are no double spaces), never
  inside a word, with no hyphen and no ellipsis. `bottom_band`: 1 line per highlight; `side_panel` and `split`: at
  most 2 lines per highlight. Text is never truncated: if a word does not fit the region width at the floor size,
  the layout does not fit.
- Alignment: left-aligned inside the text box with an inner padding of 6% of the box's short side; the block is
  centred vertically in the text box. Each highlight starts with a bullet (3.6) except in `plain_band`.
- Output: per line `{ k, text, x, y, fontPx, inkBox }` stored in `per_channel.<channel>.lines`; joining the lines of
  highlight k with one space must give `text` exactly (T3).

### 3.6 Brand styling, fonts, logo, the plain band

- **Colours** from the approved voice: `panel` fills the panel, `text` colours every letter, `accent` colours the
  bullets (a filled square of side 0.35 x font size, vertically centred on the first line's x-height) and the
  `split` panel's 4 px divider. The panel and text colours pass T4 at approval (1.3), and T4 runs again per image.
- **Fonts**, a fixed safe list shipped in `packages/core/assets/fonts/`, each pinned by sha256 and recorded in
  `LICENSES.md` (assumed SIL Open Font License 1.1 for all; the builder confirms): `inter` (Inter SemiBold),
  `montserrat` (Montserrat SemiBold), `poppins` (Poppins SemiBold), `lato` (Lato Bold), `noto_sans` (Noto Sans
  SemiBold). Static TTF files, Latin and Latin Extended-A coverage at least. No system font is ever loaded
  (resvg-js `loadSystemFonts: false`), so the same input gives the same pixels on every machine. A brand's own font
  is not in V1 (12.2 Q8).
- **Logo:** when the voice names a mark and a place other than `none`, and the channel's `infographic_logo` is true,
  the mark's approved PNG is placed in the named corner of the text region (never the product region), scaled so its
  width is 18% of the text region's width (at most 25% of its height), inside S, with `IG_CLEARANCE` from every
  line. If it collides with the text block, the text block shrinks by font size (3.5) before the logo moves; a logo
  that cannot be placed fails T5. Noon and Namshi never show the logo: "No logos, watermarks, unwanted text" and
  "Images should not contain ... seller logos" (research 2026-10-28, section 1, Noon).
- **Plain band** (`infographic_style = plain_band`): `bottom_band` only, the panel colour as a flat band, text in the
  text colour, no bullet, no accent, no divider, no logo, no rounded corner, no shape of any kind. The product is the
  brand's photograph, unchanged apart from scaling, which is the reading of Noon's "only photographs are permitted"
  that this spec takes until the channel manager answers (G9; 12.2 Q3).

### 3.7 Rendering pipeline (`infographic/svg.ts`, `compose.ts`, `render.ts` `renderInfographic`)

1. **Product layer** (RGB): `composeOnCanvas({ background: channel colour, shadowLayer, cutout, at })` (spec 13
   s4.2; the composition at `render.ts:639` today), keeping the placed alpha and offset for T2 and T8.
2. **Overlay SVG** (one string, canvas size, `xml:space="preserve"`): panel rectangles, bullets, and one `<text>`
   element per line with the font family of the chosen font, the font size, the fill, `x` and `y` from 3.5; text
   content XML-escaped by one function. No `<clipPath>`, `<mask>`, `<filter>`, `<foreignObject>`, external
   reference or embedded image is ever emitted (a unit test parses the SVG and refuses them).
3. **Render the overlay** with `@resvg/resvg-js` (`new Resvg(svg, { font: { fontFiles: [<the one font file>],
   loadSystemFonts: false, defaultFontFamily: <its family> } }).render().asPng()`), to an RGBA PNG of the canvas
   size with a transparent background. Also render a **text-only** SVG (the same `<text>` elements, nothing else)
   for T1 and T3.
4. **Logo layer:** the approved mark PNG scaled with sharp (Lanczos3) to its box.
5. **Composite** with sharp: `sharp(productLayer).composite([{ input: overlayPng, top: 0, left: 0, blend: "over" },
   { input: logoPng, top, left, blend: "over" }])`.
6. **Encode** exactly as `render.ts:645` does for the channel (JPEG 4:4:4, sRGB ICC, quality 90 stepping to 70,
   at most 2,000,000 bytes, channel DPI, EXIF stripped). No AI tag: the image holds no generated pixel, so no IPTC
   `trainedAlgorithmicMedia` source type is written, the "<Channel> AI-made" column of S12 s8.4 stays empty for it,
   and the synthetic-performer keyword never applies.
7. **Checks** (section 4) on the raw buffers of steps 1, 3, 4 and 5 before the encode, and T9 after it.
8. The 3:4 reference composition (1792x2400, the same steps on a neutral canvas with the Noon margins) is the
   composed source's private `raw_uri` (1.2).

`compliance.ts` `checkOutput` (`compliance.ts:85`) skips, for role `ig`, `background`, `inside_safe_box`,
`styli_anchor` and `noon_wide` (they compare the canvas with a flat colour or the cut-out safe box, which a panel
breaks; T1 and T2 replace them) and keeps `magic`, `bytes`, `trendyol_name`, `extension`, `format`, `dims`,
`density`. Other roles are unchanged (a test asserts identical failure lists on the existing fixtures).

### 3.8 Cost (platform, render time only; zero paid calls)

No paid call is made: no judge, no generator, no OCR service. The only cost is worker time. Estimate, **assumed**
until the test run measures it from the ledger: about 1.5 s of one vCPU per channel image (resvg at up to 3000x3000,
one sharp composite, the JPEG quality loop) at Cloud Run list prices of about 0.000024 USD per vCPU-second and
0.0000025 USD per GiB-second with 2 GiB (assumed; the builder re-reads the asia-south1 price list): 1.5 x (0.000024
+ 2 x 0.0000025) = about 0.00004 USD per image, about 0.0002 USD per product on four channels, about 0.2 USD per
1,000 products. Storage of one more image per channel is negligible. Each composed output writes its ledger row
(1.6), so the Ops page's per-image cost (SPEC R16a) shows the measured figure, and the scorecard replaces the
estimate with it (8.2).

## 4. Checks (every one gates; code only; results in `per_channel.<channel>.checks` and `compliance.infographic`)

### 4.1 The checks

| # | Check | How (on raw buffers) | Fails as |
|---|---|---|---|
| T1 | Text and logo inside the safe box, and not clipped | the alpha bounding box of the text-only render and of the logo layer lies inside S; each line's ink box from the text-only render equals the ink box predicted from the font (3.5) within 2 px on every side, so a line cut at an edge (the "MOVEMEI" case, AUDIT L195) fails | `ig_text_outside` |
| T2 | Product never covered | the placed product alpha (1 or more), dilated by `IG_CLEARANCE`, shares zero pixels with the overlay alpha (panels, bullets, text) and with the logo alpha | `ig_covers_product` |
| T3 | Words exactly as typed | the SVG text nodes, parsed back from the emitted string and unescaped, joined per highlight with one space, equal each stored `text` byte for byte (UTF-8), in order 1, 2, 3, with nothing added; every character has a non-`.notdef` glyph in the font file used | `ig_text_mismatch`, `ig_glyph_missing` |
| T4 | Contrast | WCAG 2.x contrast ratio of the text colour on the panel colour, and of the text colour on the canvas colour where any line's ink box is not fully on the panel (never, by layout), at least `IG_MIN_CONTRAST` 4.5 | `ig_low_contrast` |
| T5 | Logo present when the brand asks | when the voice names a logo and the channel allows it: the logo layer is non-empty, its sha equals the approved mark version's file, its width is at least 6% of the canvas width, and it is inside S | `ig_logo_missing` |
| T6 | No forbidden word or price | the 2.3 rule 7 match, run again on the stored texts with the rules enabled at compose time | `ig_forbidden_word` |
| T7 | Readable size | font size at least `IG_MIN_FONT_PX` (3.5) | `ig_does_not_fit` (try the next layout) |
| T8 | Product unchanged and large enough | (a) `pasteBackEqual` (spec 13 s4.5) between the product layer and the scaled cut-out: every pixel with placed alpha 255 has exactly the cut-out's RGB; (b) the product box's share of the canvas area is at least 0.6 of its share in the same source's plain output on that channel (from that output's `canvas`, `scale`, `placed`), so an infographic never shrinks the product by more than 40% | (a) `ig_product_changed`; (b) `ig_product_small` (try the next layout) |
| T9 | Output rules | `checkOutput` with the `ig` skip list (3.7) passes; the output is not at position 1 (5.1) | the compliance code |

T7 and T8 (b) send the composition to the next layout of 3.4; every other failure ends that channel's image.
A check that cannot run (a font file missing, a buffer that cannot be decoded) is a failure, never a pass.

### 4.2 Why a person does not check the words

T1 and T3 prove that each string drawn is the stored string and is whole inside the safe box; the stored string is
the sheet's cell. A typo in the sheet is therefore the sheet's, and the card says so (6.3): "The words come from
your sheet exactly as typed." This is the deterministic replacement of a person's text check (PLAN C decision 6).

### 4.3 Not made, not added (sentences; never a held image)

An infographic that fails is never published, never waits on a card and never holds the brand photos. Per product
(`catalog_infographics.not_made`), shown on the product page and in the sheet notes as "No infographic: <sentence>":
- `no_base_photo` "this product has no photo without a person, and infographics use a product-only photo."
- `base_unusable` "the product photo is too small or its cut-out is not clean enough to place text beside it."
- `does_not_fit` "the highlights are too long to fit at a readable size. Shorten them in your sheet."
- `brand_off` "infographics are switched off for this brand."
- `code_fault` (any T1, T2, T3, T5 or T8 (a) failure; event alerted, 11.2) "our fault: we make it again by
  ourselves." Once the fault is fixed, the product's next batch composes it again with no operator action; there is
  no "Try again" for a code fault.
- `low_contrast` (T4 at compose time, which approval should prevent) "the brand's text and panel colours are too
  close to read. An admin can change them on the Brand voice tab."
- `forbidden_word` (T6, a rule added after the sheet was read) "highlight <k> has a word marketplaces do not allow
  ("<matched>"). Change it in your sheet."
- `spot_check_expired` "the spot check was not done in time."
- `removed` "a person chose not to use it."
- `superseded` "a newer sheet row for this product replaced this one."

Per channel (output `skipped`, sheet note "<Channel> img <n>: <sentence>", or "<Channel>: <sentence>" when no `n`):
- `text_on_image = not_allowed`: "Not added: this marketplace does not take images with added text."
- not in the row's `channels`: "Not added: the highlights sheet did not ask for this marketplace."
- no brand photo published or kept live there: "Not added: an infographic is never the first image, and no product
  photo is on this marketplace yet."
- at the cap (5.1): "Not added: this marketplace already has its maximum number of photos."
- past `infographic_slot` (5.1): "Not added: on this marketplace an infographic would sit after the photos shoppers
  see."
- no layout fits on this channel: "Not added: the highlights are too long to fit on <Channel>. Shorten them in your
  sheet."
A product made on some channels and not added on others is `ready` or `live` with those notes.

## 5. Placement, publish, carry, links sheet, product page

### 5.1 Placement per channel

`count` = the outputs that will be live on the channel for the product after this publish, infographic excluded
(copies plus kept, less deletes, `pipeline/publish.ts:55-67`), including a scene image (role `ls`) that will be
live. `cap` = the lower of `max_images` (S13 s1.5; null = no cap) and `infographic_slot` (null = no limit). The
infographic is sent when `count + 1 <= cap`, at `position = count + 1`, after every other source (S12 s8.1 order
gains "then role `ig`"). It never moves another image, never takes position 1 (a product with no other live image on
the channel gets none, 4.3), and brand photos are never dropped for it. When both a scene image and an infographic
would pass the cap, the scene image keeps its slot and the infographic is not added (default, 12.2 Q5). A
channel whose `text_on_image` is `not_allowed`, or that the row's `channels` leaves out, gets an output row with
status `skipped` and its sentence, so `missingPairs` (`pipeline/publish.ts:91`) never fires for `ig`.

### 5.2 Publish, change, lock

- `planPublish` receives the composed source like any source, so a live infographic's outputs are not deleted when
  it is carried (`pipeline/publish.ts:63`). A `ready` infographic's outputs are `staged` with the infographic
  `qa_scores` and publish with the product in one publish.
- **Waiting for a person.** While `state = in_review`, its outputs are `needs_attention` with no decision; the hold
  test of `publishProduct` (`pipeline/publish.ts:107-108`) gains the clause `igPending(o) = source(o).role === 'ig'
  && infographic.state in ('composing','checking','in_review') && o.decision === null`, joined to spec 12's
  `madePending` (S12 s6.3) the way spec 13's `lsPending` is. Pending infographic outputs hold nothing, are not good
  shots and are not copied; carried brand photos stay live and the product's `change` is `pending_review` ("Brand
  photos are live; the infographic waits for a spot check."). The lock is released at finalize (S12 s6.3 rule);
  "All good" re-takes it through `applyDecision` (`decisions.ts:44`, `:37-42,55`), publishes only the infographic
  outputs inside `assertWithinProduct` (`naming.ts:166`) and the batch's channels, sets `live`, and enqueues
  finalize, which writes a new sheet version. A decision after a newer batch took the lock is refused (409,
  `decisions.ts:40`) and the infographic is `superseded`; the newer batch composes again (free).
- **`change`.** `infographic_added` when the only copies of the product are infographic outputs and the infographic
  is new on that channel; `updated` when an existing infographic's bytes change (a new version at the same link);
  `shots_removed` when it is removed. Precedence (S12 s8.3 and S13 s7.5 as amended): `failed` > `shots_removed` >
  `new` > `cut_replaced` > `role_added` > `reordered` > `scene_added` > `infographic_added` > `updated` >
  `unchanged`, with `pending_review` while an infographic waits. Events `infographic_added` (channels, `n`,
  position, version), `infographic_updated`, `infographic_retired`.

### 5.3 Carry-forward, new versions, removal

- **Carry.** A later batch that touches the product carries the composed source (same `n`, `sha256`, `raw_uri`,
  `derivation`) when the new `compose_key` equals the stored one: the base photo is still current, the current
  highlights row is the same, the voice profile version, font sha, logo mark version, `INFOGRAPHIC_LAYOUT_VERSION`
  and the channel rows read are unchanged. Its outputs keep their keys and nothing is copied. The answer it got
  (6.2) carries with it.
- **New version.** Any difference makes a new composition: same `n` (so the same public link), `version + 1`, all
  checks again, the review rule of 6.2 again; the output `render_key` is `sha256(compose_key | channel | n)`, so the
  publish overwrites the bytes at the same link and `change` is `updated`. Causes: a new sheet row for the product
  (event `infographic_updated`, the older row `superseded`), a replaced base photo (the next current base by 2.4),
  a new voice version (applies on the product's next batch only; nothing re-composes on approve, 12.2 Q15), or a new
  layout version (applies on the next batch; the nightly eval shows the diff first, 9.4).
- **Removal.** A sheet row with layout `none`, or "Remove infographic" on the product page (operator or admin; the
  product must not be locked: "Locked by a running batch" otherwise): decision `remove` on every infographic
  output of the product through the decisions path, a publish under the re-taken lock that deletes those objects
  inside the product's prefix, the source not current, `state = not_made` (`removed`), event
  `infographic_retired`, `change = shots_removed`, note "Infographic removed by <a person | the highlights sheet>."
  The private files stay.
- **Base gone.** When the base source is no longer current and no other base qualifies, the infographic is retired
  in the publish that removes the base, with "Infographic removed: its product photo was removed."

### 5.4 Links sheet and report

- The infographic link sits at its `position` in the channel's image columns (S12 s8.4 places by position), so
  re-submitting a product's image columns includes it last.
- New column per ticked channel that has at least one infographic in the batch, "<Channel> infographic", placed
  after that channel's "<Channel> shots" and "<Channel> missing" columns (S12 s8.4), holding the infographic's
  public link when it is live there, else empty. `sheet.ts` (`sheet.ts:92` column build) writes it in the xlsx and
  the csv (flat header "<Channel> infographic"); `compareXlsxCsv` covers it.
- "<Channel> shots" names it "<k> infographic". "What to do" (S12 s8.4): `infographic_added` "Re-submit images on
  <channels>"; `pending_review` "Nothing yet: new photos waiting for a spot check"; a not-made or not-added
  infographic with nothing else changed "Nothing to do". Above the table, "To re-submit in this version:" lists them.
- Notes: the main worksheet carries only "<Channel> img <n>: Infographic added from your highlights sheet." on
  added outputs and the not-made sentence of a product; the "Details" worksheet carries every 2.3 row sentence (with
  sheet row numbers), every not-added sentence, the layout used per channel and fallback notes.
- The filled product list and the brand sheet carry the same columns; `pnpm catalog:recheck` and the independent
  re-check count infographic links like any link.
- `report-v<k>.json` gains `infographic: { rows: { read, accepted, rejected: {<code>: n} }, products, made,
  notMade: {<reason>: n}, notAdded: {<channel>: {<reason>: n}}, layouts: {<layout>: n}, fallbacks, spot: {checked,
  allGood, removed, otherLayout, expired}, msP50, msP95, usd }`.

### 5.5 Products tab and product page

Products tab statuses (one per product, S12 s2.4 pattern):

| Status | When | Action |
|---|---|---|
| "Adding an infographic" | composing or checking | none |
| "Spot check waiting" or "Waiting for a person to check" | `in_review` | "Check" |
| "Infographic live" | `live` on at least one channel | none |
| "No infographic: <short reason>" | `not_made` | "Open" (product page) |

Product page section "Infographic" (`apps/web/app/catalog/products/[brand]/[key]/page.tsx`), only for a product
that has or had one: the status line ("Infographic: being made", "being checked", "waiting for a spot check", "live",
"not made", "removed"); the highlights as stored ("From your highlights sheet, row <r> of <sheet>, <date>"); per
channel a thumbnail with "Live", "Not added: <sentence>" or "Waiting"; "Layout: <words>" and any fallback note;
"Version <k>" with the earlier versions under "Earlier versions" (thumbnail, highlights, date); "Remove infographic"
(5.3). Under "Show how this product was worked out": the base photo with "Base photo: photo <n> (<how it was
chosen>)", and each check in words ("Words exactly as in your sheet", "Text inside the marketplace's safe area",
"Product not covered", "Contrast 7.2", "Logo placed").

## 6. Review: spot checks, exit per brand, relapse

### 6.1 Taken from spec 12 s7

The card in `listAttention` (`catalog/attention.ts:15`), one card per product in "Needs me" > "Spot checks", one
person per image (the batch's operator, any operator or admin may answer), `POST /api/catalog/review/[sourceId]`,
`catalog_review_labels` (one row per infographic source, `answers` keyed by the 6.3 reasons, `origin = 'first'`),
the deterministic sample by hash of product id (`sampledForQa`, `qa/policy.ts:67`), the 7-day expiry, "Pause
automatic publishing" and "Resume automatic publishing", keys Y, N, J, K, "Answered (<n>)", no bulk approve, no
second rater outside a test-run overlap (there is none here, 6.4), no third opinion.

### 6.2 When a person sees an infographic (`why`)

Gate state rows `catalog_gate_state` with `scope = 'infographic'`, `brand_slug` = the brand, `cell = '*'`; absent
row = `review_all`. A row (`*`, `infographic`, `*`) with `phase = 'paused'` pauses every brand.
- `test_run`: every infographic of the test-run batches (8.2).
- `brand_new`: the brand is `review_all` ("Checked by a person"): every infographic until the brand has 50 clean in
  a row (6.4).
- `spot`: the brand is `sampled` ("Automatic") and the product is picked: a deterministic 1 in 20 by hash of
  product id (`evidence.sampleRate` = 20; learning may only raise the rate, S12 s11.7).
- `paused`: the brand or the program is paused.
- `relapse`: the brand relapsed (6.4); same as `brand_new` in effect, with its own pill.
Not picked, in an automatic brand: `ready` on the checks alone, and it publishes with the product.

### 6.3 The infographic card

Spec 12's card (`AttentionProductCard.tsx`, `ReviewCard.tsx`) with an infographic variant:
- Header pill: "Checked by a person: <brand> has <n> of 50 good infographics in a row", "Spot check: about 1 in
  20", "Test run: every infographic is checked", "Automatic publishing is paused", "Checked by a person again: a
  spot check found a problem".
- Lead: "Is this infographic laid out well? The words come from your sheet exactly as typed." The base photo
  ("Product photo <n>") and, large, each channel's image side by side with the channel name; a channel not added
  shows its "Not added" sentence instead. Below: the highlights as text ("From your sheet: ...").
- "All good" (Y): answers the card, publish yes; toast "Thanks. The infographic is live." (or "... goes live with
  the batch." while the batch is still running).
- "Something is wrong" (N): "What is wrong? (pick all that apply)":
  `covers` "Text or the panel covers part of the product"; `readable` "The text is hard to read (too small, too
  light, crowded)"; `layout` "The layout looks wrong (off-centre, cramped, too much empty space)"; `logo` "The logo
  is wrong, misplaced or missing"; `brand` "It does not look like the brand (colours or font)"; `words` "The words
  are wrong". Then the buttons "Try another layout", "Remove this infographic" and "Cancel".
  - `words` shows at once: "The words come from row <r> of your sheet. Fix the row and upload the sheet again; this
    infographic is not used until then." and offers only "Remove this infographic". It is a sheet problem, not a
    layout fault: it does not count against the brand's run and does not relapse (6.4).
  - "Try another layout": composes again with the next layout of the 3.4 order not yet tried on any channel of
    this card (free, no paid call), keeps every check, and returns a new card (pill "Another layout, try <k> of 2")
    answered by one person. At most two tries per version; then only "Remove this infographic". Event and signal
    `infographic_layout_retry`.
  - "Remove this infographic": decision `remove`, `state = not_made` (`removed`).
- No free text box: nothing a reviewer types can reach an image (0.1). No model, vendor or check name on the card.

### 6.4 Exit per brand, relapse

- **Clean** = an "All good" on a first-try infographic card (not a "Try another layout" card). A "Something is
  wrong" with any reason other than `words` resets the brand's run to 0. A `words` answer, a removal for `words`,
  an expiry and a "Try another layout" card neither count nor reset.
- **Exit:** a brand moves from `review_all` to `sampled` ("Automatic") when it reaches 50 clean in a row (event
  `infographic_exit`, an Ops notice, and the decisions-log line "Spec 18 exit, <brand>, <date>: 50 clean
  infographics in a row; automatic with 1 in 20 spot checks from now."). The run counts test-run and live answers
  alike. `evidence` holds the run, the last 200 answers and their reasons.
- **Relapse:** in an automatic brand, a spot check that picks `covers`, `readable`, `layout`, `logo` or `brand` sends
  that brand back to "Checked by a person" at once (event `infographic_relapse`, alert as S12 s12.2, Ops notice
  "<brand>: infographics back to "Checked by a person". A spot check found <reason in words>. That infographic did
  not go live, and every infographic of this brand is checked by one person again until 50 new clean ones in a
  row."). An admin may mark the finding "Not a real fault" on the Ops page, which restores `sampled` with the reason
  recorded. A `covers` answer on an image that passed T2 also opens an engineering alert ("Product-cover check
  passed but a person saw the product covered"), because it means the matte missed part of the product.
- **Program pause:** two relapses in different brands within 7 days, or any `ig_covers_product`, `ig_text_mismatch`
  or `ig_text_outside` code fault, pauses every brand (`*` row, event `scope_paused`, `decided_by = system`) until an
  admin resumes it after the fix.
- Every answer, retry, removal and expiry is a `catalog_signals` row with the version set (S12 s11.6), and every
  answered infographic joins the layout regression set (9.4).

## 7. Brand DNA: the Brand voice tab

### 7.1 Where

A tab "Brand voice" on spec 12's Brand DNA page (`/catalog/brands/[slug]/dna`, admin only, S12 s9.2), after "Kids
look", built by workstream F; the summary strip gains "Brand voice: version <k> approved" or "Brand voice: not set".
If initiative 3 has not built the page, workstream I-lite builds the shell with "Logos and marks" and "Brand voice"
only (0.4).

### 7.2 Content (copy follows the prototype's style; the prototype gains this tab, 12.3)

- Status: "Approved version <k>, by <person> on <date>" or "No approved brand voice: infographics are off for this
  brand." Lead: "How this brand's infographics look. The words always come from the highlights sheet; nothing here
  writes words on an image. A draft is used only once approved."
- "Infographics on for this brand" (switch, `voice.enabled`).
- "Words this brand uses" (keyword family): chips with "Remove" and "Add a word" (at most 12, 30 characters each).
  Help: "Shown to the people who write the highlights, in the sheet template. We never add them to an image by
  ourselves."
- "Brand colours": "Panel", "Text" and "Accent" with a hex field and a swatch each, and the live line "Text on panel:
  contrast <x> (needs 4.5)" in red below 4.5, which also disables "Approve".
- "Font": a select of the five fonts of 3.6, each shown as a sample line in that font ("Cushioned footbed").
- "Logo": "Which logo" (the brand's approved logo or wordmark files from "Logos and marks"; only uploaded files are
  offered) and "Where" ("Top left", "Top right", "Bottom left", "Bottom right", "No logo"). Help: "Never shown on
  Noon or Namshi, which do not allow logos on images."
- "Default layout": "Choose for each product (recommended)", "Bottom band", "Side panel", "Split"; "Panel side":
  "Right", "Left".
- "Preview": the three layouts rendered by the real engine on the brand's most recent product photo that qualifies
  as a base (2.4), with the sample highlights "Cushioned footbed", "Breathable canvas upper", "Rubber sole", on a 3:4
  and a 1:1 canvas (no ledger row; a preview is never stored as an output).
- "Approve": zod validation (1.3) plus the database checks; makes a new `brand_style_profile` version with
  `approved_by` (event `brand_dna_approved`, signal `voice_versioned`) and lists it under "Versions". Warnings before
  approve: no logo chosen ("Infographics will have no logo."), the switch off.

### 7.3 Logos on images

The Logos and marks tab (S12 s9.6) keeps its rule that marks are used by checks and never given to an image maker.
An approved uploaded logo file may in addition be placed by code on this brand's infographics when the Brand voice
names it (0.5, spec 12 amendment). The file is used as uploaded (scaled only), never redrawn.

## 8. Rollout

### 8.1 Switches

- `INFOGRAPHIC_ENABLED`: deploy env flag on `catalog-worker` and `catalog-web`, **unset (off) at deploy**. Off: a
  highlights sheet is detected and not used (2.2), no `infographic` chunk is created, step 4 shows no card, and the
  Brand voice tab can be edited and approved but shows "Infographics are not switched on yet." On:
  `INFOGRAPHIC_ENABLED=1` in the deploy env and `SKIP_BUILD=1 bash infra/deploy.sh`.
- Per brand: an approved Brand voice with `enabled = true` (section 7). A brand without it gets "No infographic:
  infographics are switched off for this brand." on every row.
- Per channel: the `text_on_image` rows (1.4); `not_allowed` stops a channel at once, with no deploy.
- Program: "Pause automatic publishing" on the Ops page (6.4) sends every new infographic to a person.

### 8.2 Test run on one brand (picked by the owner)

The owner names one brand (12.2 Q6). The business supplies a highlights sheet of about 50 of that brand's live
products, chosen by stock and visits, with at least 10 shoes or bags, at least 10 apparel products that have a
person-free photo (when the brand sells apparel), rows of 1, 2 and 3 highlights, and at least 5 rows at the
40-character limit. Steps:
1. Deployed with the switch off; the brand's Brand voice approved by an admin; the manager runs the layout
   regression set (9.4) green.
2. Switch on. The test batch is an `isTest` batch under `catalog-test/` (no live channel sees it), every channel the
   brand sells on ticked, started when the owner says the module is free; it is not a test tier.
3. One person labels every infographic (`why = test_run`), one person per image; there is no second rater (nothing
   judged by a model needs agreement measured). The answers count towards the brand's run of 50 (6.4).
4. Acceptance numbers for the run: T1, T2 and T3 pass on 100% of the images made (the code checks are also run on
   the full 50-product set offline by the eval, 9.4); zero `covers` answers; at most 10% of infographics need "Try
   another layout"; every not-made and not-added sentence reads right to the business; compose time p95 under 3 s
   per image.
5. The manager writes the scorecard (8.3 fields) to the report and `docs/solutions/`.
If the run ends with 50 clean in a row, the brand starts live as "Automatic"; otherwise it starts live as "Checked
by a person" and earns its exit on live batches.

### 8.3 Live, per brand

1. Each brand is live once its Brand voice is approved and enabled. A brand that was not in the test run starts as
   "Checked by a person" and earns its own exit (50 clean in a row); nothing waits for another brand.
2. A highlights batch runs whenever the business sends a sheet, started when the owner says the module is free
   (the throughput rule of the go-live process). A sheet of more than 200 rows is split into batches of at most 200
   rows by the operator ("This sheet has <n> rows. Use at most 200 rows per batch." at step 2), so a review-all
   brand never faces more than 200 cards at once.
3. Scorecard per brand from `report-v<k>.json` `infographic`, the ledger and the labels: rows read, accepted and
   rejected by code; products made, not made by reason; not added per channel by reason; layouts and fallbacks;
   "All good" rate, run length, relapses; "Try another layout" rate; compose ms p50 and p95; USD per image measured
   against the 0.00004 estimate.
4. Live pages per channel and the effect on conversion are not module figures; the business measures them.

### 8.4 Stop rules

After each batch, at the first that applies: (1) any T1, T2 or T3 code fault on a live or test image: pause every
brand (6.4) and fix before the next batch; (2) a `covers` answer: relapse and engineering alert (6.4); (3) more than
20% of rows rejected for one reason that the business did not expect: stop and agree the sheet rule with the
business (G12) before the next sheet; (4) a channel manager says a marketplace rejects the images: the admin sets
that channel's `text_on_image` to `not_allowed` the same day, the manager lists the live infographics on it (Ops
query, 11.2), and the operator removes them from the portal (the module never touches portals); (5) compose p95
above 5 s per image: fix before the next batch.

## 9. Tests and evals

### 9.1 Tier 1 (`pnpm test`)

- Sheet detection: a sheet with `highlight1` is a highlights sheet whatever else it holds; its `image_link` is never
  a shot column; header variants ("Highlight 1", "HIGHLIGHT-1"); two highlights sheets in one batch; switch off
  gives the 2.2 sentence and no rows.
- Row checks, one case per 2.3 rule and sentence: 40 and 41 characters counted in code points (an `é` is one); a
  leading and trailing space trimmed and nothing else changed (curly quotes, a hyphen and a trailing full stop kept
  byte for byte); a tab, a line break, two spaces, an emoji, an Arabic word, a Devanagari word, a character missing
  from the font; each seed text rule: "AED 199", "199 AED", "SAR 99", "₹999", "$20", "50% off", "was 99", "SALE",
  "Best Seller", "eco-friendly"; and the allowed cases "100% cotton", "3-layer sole", "Size 42", "2-way stretch";
  a brand word near miss ("U.S. POLO ASN.") and the exact word; unknown layout and channel words; a channel not
  ticked; duplicates; `layout = none` without a product.
- Matching and base: the product-list rule cases; an own public link maps to its `n`; a link with the same bytes
  maps to the source; a different photo becomes the private base and is never published; a link photo with a
  person or a dirty matte falls back to the rule order with its sentence; the rule order per department; a product
  with only on-model photos gives `no_base_photo`; a new product with a link gets the link as shot 1 and the
  infographic at position 2 or later.
- Carry: a highlights-only batch for a live product re-inserts every current source with the same `n` and sha,
  renders nothing for them, deletes nothing, and the publish copies only the infographic outputs; the batch has no
  shot-set generation and no scene step.
- Layout geometry, for all nine channels and all three layouts: S, regions and gutters from 3.3; the product fits
  0.92 of its region and never above 1.5x; Styli bottom-centre.
- Fitting: the largest size that fits; the floor per channel (Noon 30, Trendyol 34, Amazon 56, Centrepoint 84);
  wrapping only at spaces, never inside a word, no ellipsis; three 40-character highlights of wide letters
  ("WWWW...") that cannot fit give `does_not_fit` and the 3.4 fallback order; lines joined give the stored text.
- SVG: XML escaping of `&`, `<`, `>`, quotes; parsing the SVG back gives the stored texts; no `clipPath`, `mask`,
  `filter`, `foreignObject`, external reference or embedded image; resvg loads no system font (a test runs with an
  empty font directory and gets the same pixels).
- Determinism: the same inputs give byte-identical PNG overlays and identical JPEG bytes twice in a row and on the
  CI machine and the worker image (golden hashes for 9 channels x 3 layouts on two fixtures).
- Checks, each with a passing case and the planted failure of 9.4: T1 (a line pushed 1 px past S; a line clipped at
  the canvas edge, the "MOVEMEI" fixture), T2 (a panel 1 px into the dilated mask; a logo over the product), T3 (one
  character changed, one dropped, two highlights swapped, a straight quote turned curly, a trailing space added,
  a `.notdef` glyph), T4 (4.49 fails, 4.5 passes, computed exactly), T5 (logo asked and missing, wrong sha, too
  small, outside S), T6 (a rule enabled after intake), T7, T8 (a) (one product pixel changed by one level fails;
  blended edge pixels are not compared) and (b) (a product shrunk past 0.6 of its plain share), T9 (position 1
  refused; the `ig` skip list exactly the four codes; other roles unchanged on existing fixtures).
- Plain band: Noon and Namshi get `bottom_band` only, no logo, no bullet, no shape; a row asking for `side_panel` is
  made as a band there and as a side panel elsewhere, with the fallback note.
- Placement: `count + 1 <= cap` with `max_images` and `infographic_slot`; never position 1; a scene image keeps its
  slot and the infographic yields at the cap; `not_allowed`, not-in-`channels` and no-live-photo give `skipped`
  outputs with their sentences.
- Publish and change: `infographic_added` precedence; `pending_review` while waiting, brand photos live, lock
  released at finalize; "All good" re-takes the lock and publishes only the infographic inside the product prefix
  and the batch's channels; 409 after a newer batch, then `superseded`; carry with an equal `compose_key` copies
  nothing; a new sheet row makes version 2 at the same `n` and link with `change = updated`; removal deletes only
  that product's infographic objects and records `infographic_retired`.
- Review: the sample is 1 in 20 within 1 point over 10,000 synthetic product ids and stable per id; `review_all`,
  `paused` and `relapse` always go to a person; the run counts to 50 and exits; a non-`words` reason resets and, in
  an automatic brand, relapses; `words` neither counts nor resets; "Try another layout" twice then only removal; the
  7-day expiry; "Not a real fault" restores `sampled`; two relapses in 7 days pause the program.
- Links sheet: the "<Channel> infographic" column appears only for channels with an infographic in the batch, in
  xlsx and csv, after "<Channel> missing"; "What to do" values; the Details worksheet holds every row sentence with
  its row number.
- Brand voice: `DEFAULT_VOICE` validates; contrast below 4.5 refused; a harvested mark refused; a mark of another
  brand refused; approve makes a new version.
- Banned names: the spec 07 test passes with every new string (step 2 and 4 copy, card, product page, Brand voice
  tab, sheet notes, Ops block); no check code (T1 to T9) appears in operator copy.

### 9.2 Tier 2 (PGlite, in-memory storage; no network)

A brand with an approved voice and three live products (a shoe, a bag, a flat-lay T-shirt) and one product with
only on-model photos; a highlights sheet with those four rows, one row for a product not in the catalog with an
image link, and two failing rows. On four channels (Noon, Trendyol, Amazon, Styli): the live photos are carried and
unchanged; three infographics are made (plain band on Noon, branded elsewhere), the on-model product gets
`no_base_photo`, the new product gets photo 1 from its link and an infographic at position 2, the failing rows are
listed with their sentences. Review-all phase: outputs wait, brand photos stay live, `pending_review`; "All good"
publishes each at the last position with `infographic_added` and a new sheet version with the "<Channel>
infographic" column. A second batch with the same sheet carries everything (zero composes, zero copies); a third
with one changed highlight makes version 2 at the same link; a fourth with layout `none` removes it. With Trendyol's
`max_images` reached by brand photos, Trendyol gets "Not added" and the others get theirs. With the brand set to
`sampled`, an unpicked infographic publishes in the first publish and a picked one waits.

### 9.3 Tiers 3 and 5

Tier 3: `REAL_DATA=1 pnpm test:real` composes infographics for two golden products of real brands on all nine
channels with the local matting container (no paid call exists to mock), writes only under `catalog-test/` and
deletes in `finally`; the manager looks at the 54 images once and records the look in the report. Tier 5: the deploy
smoke runs with `INFOGRAPHIC_ENABLED` unset and asserts that a highlights sheet is detected and not read and that no
`ig` output exists.

### 9.4 Nightly evals (the `infographic` group of S12 s11.5)

The scheduled eval job (S12 s11.5, nightly at 02:00 Gulf time and on every change to the layout code, a font, the
seeds or a voice version) runs the `infographic` group, which makes no paid call at all, so it runs in full every
night:
- **Layout regression set:** 60 golden products (pinned by sha256) across footwear, bags and person-free apparel of
  at least four brands, each with five highlight sets (1, 2 and 3 highlights; three at the 40-character limit with
  wide letters; mixed punctuation and digits such as "100% cotton"), composed on all nine channels and all three
  layouts with each of the five fonts and two voices: T1 to T9 must pass on 100% of the compositions that fit, and
  the "does not fit" set must be exactly the expected one. Bar: 100% on the 50-product subset named in PLAN F item 7
  ("no text outside the safe area, no overlap with the product mask on 100% of a 50-product set").
- **Pixel regression:** every composition's PNG sha must equal its stored golden; any difference fails the run
  unless `INFOGRAPHIC_LAYOUT_VERSION` changed, in which case the run writes a side-by-side report of every changed
  image for a person to look at before the new goldens are stored.
- **Planted defects** (built by deterministic edits of golden compositions, each labelled with the check that must
  catch it): a text box moved over the product mask (T2); a panel edge 1 px into the clearance (T2); a logo over the
  product (T2); a line extended past the canvas edge, the "MOVEMEI" case (T1); a line past the safe box (T1); one
  character changed, one dropped, swapped highlight order, a curly quote, a trailing space, a lower-cased letter
  (T3); a glyph missing from the font (T3); text and panel colours at contrast 4.4 (T4); a logo missing or replaced
  by another brand's mark (T5); "AED 99" and "Best Seller" injected after intake (T6); a font size below the floor
  (T7); one product pixel altered and a product shrunk to half its plain share (T8); an infographic placed at
  position 1 (T9). Bar: 100% caught, each by its expected check.
- **Answers:** every answered infographic (6.4) joins the set with its answers; a composition whose answer was
  `covers` is re-checked nightly and must fail T2 once the fix for it is in, or stay listed as an open fault.
- Output under `catalog-test/evals/<run>/infographic/`, deleted at the end even on failure; a failed bar exits 1,
  blocks the change that caused it, and alerts (S12 s12.2).

## 10. Version 2 (specified here, not built in V1)

Each item is a later spec or an amendment to this one; none is built by this spec's workstreams.

1. **Callout pointers anchored to detected parts** (the shown example of MEET 42-52: lining, upper, footbed, sole).
   A detector (a judge call with a closed list, or a keypoint model on the matting service) returns a point per part
   from a fixed list per department: footwear `sole`, `upper`, `lining`, `footbed`, `heel`, `toe`, `laces`; bags
   `strap`, `handle`, `closure`, `body`; apparel `collar`, `cuff`, `hem`, `pocket`, `waistband`. A highlight row gains
   an optional `part_1` to `part_3` column; a callout is a thin line from the part's point to its text in the panel,
   drawn by code; the line may cross the clearance only at its end dot, which sits on the part. New check: the dot
   lies inside the product mask on the named part's box, and both judges agree the part is the one named. Noon and
   Namshi stay a plain band (a pointer is a drawing).
2. **Lifestyle plus infographic:** spec 13's accepted scene frame as the base, with the panel placed on the frame's
   area outside its core box (S13 s5.4); the scene stays AI-made, so the output carries spec 13's AI tag and the
   "<Channel> AI-made" column; never on channels whose `lifestyle` row is `off`.
3. **Arabic variant:** a second text layer from `highlight_1_ar` to `highlight_3_ar` columns, rendered right to left
   with an Arabic-capable font from the safe list (Noto Sans Arabic or IBM Plex Sans Arabic, licences to confirm) and
   shaping done by the renderer (resvg's text shaping, to be verified on golden Arabic strings); T3 compares the
   Arabic strings byte for byte; one image per language or a bilingual band per channel rule (noon NIS templates
   exist EN and EN+AR, research 2026-10-28, section 2).
4. **Product-page pick:** on the product page, choose the base photo and the layout per product, writing a new
   version (the same path as a new sheet row).
5. **Highlight suggestions from spec 19 facts:** suggested highlights built from a product's facts with their
   source, shown in the sheet template and on the product page as suggestions only; never published unless a person
   puts them in the sheet (rule 2 of 0.1 stands).
6. **Optional generated background behind the band:** a background-only request to spec 12's bench (a new use
   `infographic_background`), under spec 12's caps and approvals, with the product pasted back (S13 s4.5) and the
   panel and text still by code; outputs then carry the AI tag; never on Noon or Namshi.
7. **Infographics on new inflow** when the brand's own product sheet carries highlights (PLAN G item 4), and
   on-model base photos for apparel (masking the whole person), each after its own owner decision.

## 11. Acceptance, monitoring, operator guide, report

### 11.1 Acceptance checklist (the manager ticks each in the 00 section 10 report)

1. [ ] G0b approved and committed; `0007_infographic.sql` (or the number it took, 0.4) applied; a re-run is a no-op.
2. [ ] Spec 12 initiative 1 contracts present on `main`, or the report says `Blocked:`; the Brand DNA shell and,
       if typed by the owner, the card shell built at spec 12's paths.
3. [ ] `pnpm lint && pnpm typecheck && pnpm test` green; every 9.1 and 9.2 case passes.
4. [ ] SPEC.md carries the 0.5 amendments verbatim; the spec 12 and 13 text changes of 0.5 applied in the same docs
       PR; `CHANNEL_RULES_VERSION` unchanged.
5. [ ] The channel policy columns seeded as in 1.4, each row with its status and source, visible on the Ops page and
       editable through the admin route.
6. [ ] The text rules seeded as in 1.5, editable by an admin, each edit a signal.
7. [ ] Fonts shipped with sha256 pins and licences recorded; resvg never loads a system font.
8. [ ] The layout regression set, pixel goldens and planted defects (9.4) pass: T1 and T2 at 100% on the 50-product
       subset, every planted defect caught by its check; the nightly job runs the group.
9. [ ] Deployed with `INFOGRAPHIC_ENABLED` unset; tier 5 green (sheet detected, not read; no `ig` output).
10. [ ] The Brand voice tab works for an admin only, with the contrast line, the preview and versions.
11. [ ] Test run done on the owner's brand per 8.2: every infographic labelled by one person; the 8.2 numbers met
        or each miss explained; the scorecard written.
12. [ ] At least one live highlights batch run with the switch on: rows read, products matched, live photos
        unchanged (zero copies of brand outputs, checked in the ledger and the publish plan), infographics placed
        last, the sheet's "<Channel> infographic" column filled, `infographic_added` rows re-submitted by the
        operator.
13. [ ] No live infographic is image 1, covers its product mask (a query over `per_channel.checks` of every live
        one, plus T2 re-run on a fetch of each), or differs from its sheet text (T3 re-run on each).
14. [ ] No live infographic on a channel whose row is `not_allowed`, and none on Noon or Namshi with a logo or a
        non-band layout.
15. [ ] Zero paid calls: no `llm_call` or `generate_call` ledger row with an infographic in its detail for any
        infographic batch; measured USD per image recorded against the 3.8 estimate.
16. [ ] Per-brand exit state shown on Ops; the exit or the remaining run recorded for the test brand.
17. [ ] Ops "Infographics" block, alerts, log events and the monitoring-guide queries exist (11.2).
18. [ ] Operator guide section and the sheet template exist (11.3).

**UX acceptance** (the manager on a real test batch, from the operator's seat):
19. [ ] A first-time operator runs a highlights batch without the guide: one sheet dropped, channels ticked, Start.
20. [ ] Step 2 lists every rejected row with a sentence the business can act on without help.
21. [ ] Step 4 has one "Infographics" card with no input; its counts match the batch page after the run.
22. [ ] A card is answered with one key (Y) when the layout is right; "Something is wrong" offers only layout reasons
        plus "The words are wrong", which points to the sheet row.
23. [ ] The links sheet's "What to do" and "<Channel> infographic" columns let the operator re-submit without
        reading notes.
24. [ ] No model, vendor or check name on any page, card, note, sheet or toast.

### 11.2 Monitoring and cost hooks

Ops page (`apps/web/app/catalog/ops/page.tsx`), under spec 12's "How photos go live": a card "Infographics" per
brand with its status pill ("Checked by a person: <n> of 50 in a row", "Automatic, 1 in 20 checked by hand",
"Paused"), "Pause automatic publishing" / "Resume automatic publishing", and "Not a real fault" after a relapse; a
table "Infographics per brand" (7 and 30 days: rows read, rows left out by reason, made, not made by reason, not
added per marketplace by reason, layouts, "Try another layout" rate, spot checks all good / removed / expired,
compose ms p50 and p95, USD per image); "Infographics per marketplace" (text on images: value, status, source;
slot; plain band; logo), editable by an admin; "Words not allowed on images" (the text rules), editable by an admin.
Log events `ig_row_rejected` (code, no text), `ig_compose` (channel, layout, ms, outcome), `ig_check_failed` (check,
channel; alerted for T1, T2, T3, T5, T8 (a)), `ig_not_made`, `ig_relapse` (alerted), `ig_exit`, `ig_paused`,
`ig_eval_failed` (alerted). `docs/handover/monitoring-guide.md` gets two queries: live infographics per channel
(for a stop rule 4 pull-back list) and USD per image from the ledger.

### 11.3 Operator guide and UI copy

`docs/handover/catalog-for-the-operator.md` gets one section in plain words: what an infographic is (the brand's
photo, up to three short highlights, last image, never first), who writes the highlights and how (the template, at
most 40 characters, no price, no "best seller" or "sale", one line each, English for now), how to start a highlights
batch, what step 2 and step 4 show, why a row is left out and how to fix it, how to answer an infographic card
("All good", "Something is wrong", "Try another layout", "Remove this infographic", "The words are wrong" means fix
the sheet), that Noon and Namshi get a plain band with no logo, what "Not added" means per marketplace, how to
re-submit ("What to do", "<Channel> infographic"), and how to change or remove an infographic later. Brand voice is
documented in the admin notes of `docs/handover/` (admin only).

### 11.4 Report

The 00 section 10 report plus the SPEC.md diff, the migration name it took, the channel policy rows as seeded and as
the owner left them, the test-run scorecard, the per-brand exit state, the measured compose time and USD per image
against 3.8, the first live highlights batches and their re-submission counts, the UX acceptance results, and the
12.2 questions still open. Ends with "Ready for the next spec" or `Blocked: <exact thing needed>`.

## 12. Settled questions, open questions, prototype

### 12.1 Settled (binding; not reopened)

| # | Question | Settled as |
|---|---|---|
| 1 | Who draws the text | Code: SVG rendered with resvg-js from shipped fonts, composited with sharp; never an image model (PLAN decisions 3 and C1; AUDIT L195) |
| 2 | Where the words come from | The business's highlights sheet only, exactly as typed, at most 40 characters, no price, forbidden words as data (PLAN C2, G3) |
| 3 | Input path | A highlights sheet through the existing sheet ingestion, live products first; current photos carried unchanged (PLAN C4) |
| 4 | Output | The links sheet: the infographic at its position in the image columns and in "<Channel> infographic", plus the product page (MEET 59; PLAN C, R3) |
| 5 | Placement | Never image 1; the last slot `max_images` allows, after every other image; per-channel rows as data (PLAN C5) |
| 6 | Noon and Namshi | `assumed_allowed`, plain text band over the unchanged product photo, no logo, until the channel manager answers (PLAN G2; research 2026-10-28, section 1) |
| 7 | Other channels | `assumed_allowed` with the status the research supports (1.4) |
| 8 | Review | Layout only, on spec 12's card, one person per image; per-brand exit after 50 clean in a row, then 1 in 20; relapse (PLAN C6) |
| 9 | People and kids | No person in an infographic, so Amazon's synthetic-performer tag does not apply; kids products allowed; modesty rules unaffected |
| 10 | Paid calls | None in V1; platform cost from render time only (3.8) |
| 11 | Arabic | V2; the text layer is separate from the start (PLAN C8) |
| 12 | Render keys | Own `compose_key`; `CHANNEL_RULES_VERSION` not bumped, so no existing output re-renders |

### 12.2 Open questions (defaults apply; only G0b blocks)

1. Q1. G12: confirm the columns of 2.1 with Naaz and Taranum, including `layout = none` to remove and the
   channel names in the `channels` column. Default: as written.
2. Q2. Trendyol: Turkish seller guides say text on images can cause rejection (research 2026-10-28, section 1).
   Keep the row `assumed_allowed`, or start it `not_allowed` until the channel manager answers? Default: assumed
   allowed, as the plan says; this is the highest-risk row.
3. Q3. Noon and Namshi plain band: in the brand's panel and text colours (default) or always neutral white with
   near-black text?
4. Q4. Amazon: sellers report that the first 7 of up to 9 images show (research 2026-10-28, section 1). Set
   Amazon's `infographic_slot` to 7? Default: null (last allowed slot).
5. Q5. At a channel's cap, which yields, the scene image or the infographic? Default: the infographic yields.
6. Q6. Which brand runs the test run (owner's pick). Footwear-heavy brands (Campus, US Polo) suit V1 best because
   their photos have no person.
7. Q7. If spec 12 initiative 2 (the spot-check card) is not merged first: wait (default), or build the card shell
   here as workstream G-lite?
8. Q8. Fonts: confirm the five-font safe list and its licences; allow a brand's own font file later?
9. Q9. Spec 12 s9.6 says logos are used only by checks. Approve the amendment that lets code place an uploaded logo
   file on infographics (never given to an image maker)?
10. Q10. Apparel with only on-model photos gets no infographic in V1 (no person on an infographic). Accept, or move
    on-model bases into V1?
11. Q11. Contrast floor 4.5 (WCAG AA for normal text) or 3.0 (AA for large text, which most highlights are)?
    Default 4.5.
12. Q12. Keyword family: shown to writers only (default), or also a soft warning on rows that use none of the words?
13. Q13. A row for a product not in the catalog with an image link creates the product (its link becomes photo 1).
    Accept, or refuse such rows in V1?
14. Q14. Highlights in Arabic now: refused in V1 with a sentence (default).
15. Q15. A new Brand voice version: applied on each product's next batch (default), or re-compose every live
    infographic of the brand at once (which would make every one a re-submit)?
16. Q16. Stop rule 4 pull-back: the module lists live infographics per channel; removing them from a portal stays
    manual. Enough, or does the business want a bulk "remove all infographics on <Channel>" admin action?

### 12.3 Prototype screens that need changes

Prototype v2 (`docs/prototype/shot-set-and-scene-prototype.html`) has no infographic screen. Before the build, the
prototype gains: the step 2 sheet line "read as highlights sheet" and the rejected-row list; the step 4
"Infographics" card with its "Details"; the infographic variant of the spot-check card (pills, layout reasons, "The
words are wrong", "Try another layout"); the Products tab statuses; the product page "Infographic" section; the
Brand DNA "Brand voice" tab with the contrast line and preview; the links sheet preview with "<Channel> infographic";
and the Ops "Infographics" block. Where the prototype's copy and this spec differ after that, the owner's decision
wins, then the prototype.
