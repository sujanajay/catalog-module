# DD6: Infographics compositor - feature callouts and use-case panels (bucket B5)

Date: 2026-10-22. Deep dive DD6 of the Catalog Connect GCC program (bucket B5, deferred bucket prepared now).
Program: docs/plans/2026-10-21-catalog-connect-gcc-intent-map.md (sections 2, 3 and 6). Builds on
docs/plans/deep-dives/05-attributes-listing-fill.md (the fact sheet; `features[]` is the only callout input),
04-footwear-bags-lifestyle.md (generators, composite path, price per image, slot and cap rules),
07-review-ingestion-enhancement.md (the review-theme hand-off record that may reorder callouts),
01-shot-roles-channel-compliance.md and 01a-channel-guidelines-external-vs-internal.md (roles and channel rules),
02-derived-shots-fidelity-gate.md (gate G1 to G6), 03-on-model-generation-bake-off.md (request shape, prices) and
08-brand-style-profile-model-registry.md (fonts and colours were left to B5). Investigation only. Nothing here is built;
SPEC.md is not edited (the wording in R8 is a draft for the owner).
Trial scripts and images live in the session scratchpad
`C:\Users\SUJANA~1\AppData\Local\Temp\claude\c--Users-Sujan-Ajay-Desktop-catalog-module\d63636f6-cfe2-4e73-8088-d201473357ee\scratchpad\dd6\`
(`inputs/`, `outputs/`, `meta/` with `runs.jsonl`, `locate_runs.jsonl`, `vocr_runs.jsonl`, `checks.json` and one `*.boxes.json` per
render, `scripts/`, `fonts/`, `frames/`). Model ids appear here as technical facts only; none may reach UI copy.

Words used here:
- **Infographic**: one product image with text on it, made to explain the product. Two kinds are in scope.
- **Feature callout (layout C)**: the product photo with short labels such as "ADJUSTABLE STRAPS", each joined by a thin
  line (the **pointer** or leader line) to the spot on the product it describes. A **detail tile** is a variant: a zoomed
  crop of the feature with the label under it, used when the feature cannot be seen on the main photo.
- **Use-case panels (layout P)**: one title and three photos side by side, each with a short heading, for example
  "URBAN EXPLORATION / RELAXED WEEKEND / CASUAL WORKDAY".
- **Compositor**: code that assembles the image from parts: the product photo, text, lines and panel photos.
- **Rendered in code**: the letters are drawn by a font engine from a known string, so the text is exact by construction.
  **Painted by a model**: an image model draws the letters as pixels, so the text is whatever the model drew.
- **Shaping**: joining Arabic letters into their connected forms and ordering mixed Arabic and English text right to left.
  A renderer without shaping prints Arabic as separate, reversed letters.
- **RTL**: right to left. **OCR**: reading text back out of an image by software.
- **OFL**: SIL Open Font License 1.1, a free font licence that allows commercial use.

## Summary

1. The meeting shows two layout families, both from the Birkenstock Arizona Black page on a UAE marketplace (frames 80 and
   98 of the recording): a title with feature tiles ("ARIZONA ... Premium", tiles labelled "ADJUSTABLE STRAPS") and a 3-panel
   use-case image ("ARIZONA BLACK: YOUR EVERYDAY ESSENTIAL", panels "URBAN EXPLORATION / RELAXED WEEKEND / CASUAL WORKDAY" with
   worn-shoe scenes). The Amazon.com Birkenstock page (frame 102) is A+ content (a brand video and a "Features" row), a separate
   surface below the gallery. Naz asked for the infographic as an image in the gallery (transcript 18:33 to 21:57).
2. Every callout text comes from DD5's fact sheet: `features[]` claims with status `confirmed`, labels from a fixed
   bilingual glossary keyed by feature key. A claim with no data source is never drawn. DD7's hand-off may only reorder
   confirmed features. Panel headings come from the typed `occasion` values, or, for brand photos, from the shot role.
3. catalog-service lets the image model paint overlay text. Six of its 75 commits fix what the model painted (callout
   budget, unit systems, PIM keys painted as labels, duplicate facts, unsupported claims), and its brief carries about 20
   prompt rules against painted mistakes (`server/pipelines/generation/gallery.py` lines 1131 to 1172). The patterns worth
   lifting are slot selection with a callout budget, one-fact-one-slot ownership and "no facts, no overlay slot".
4. Arabic works in the module's own renderer. sharp 0.35.5 (already a dependency) bundles Pango 1.58.2, HarfBuzz 14.5.0 and
   FriBidi 1.0.17. A local render shaped Arabic correctly (joined letters, lam-alef ligature, shadda, right-to-left order,
   mixed Arabic and English on one line) through both sharp's text input and SVG text. Fonts: Montserrat, IBM Plex Sans
   Arabic and Noto Sans Arabic, all OFL. One trap was found: a font without Arabic glyphs falls back silently to another
   font, so a code check must reject any character the chosen font lacks.
5. Channels: Amazon's official Amazon.ae shoes and handbags guide bans text and graphics on the MAIN image only.
   Noon's official page says "If you're adding text to the images, make sure the language is not offensive", but also
   "Only photographs are permitted ... illustrations are not allowed" and "No logos, watermarks, unwanted text". Trendyol
   already shows a brand insole infographic on a Keds listing (DD4 F2). Namshi, 6thStreet, Styli, Centrepoint, Shein and
   VogaCloset publish nothing. An infographic is never image 1, and it goes only to channels marked allowed.
6. Trial (3 products: Campus running shoe, Vero Moda braided bag, French Connection shirt): 36 code renders (callout and
   panels, 6 canvas sizes, English plus Arabic), 4 pointer-location calls, 2 generated panel scenes, 2 model-painted
   controls and 4 vision-OCR calls. Every vision-model point used in a render (6 of 6) sat on the right part, and both
   "not visible" answers (2 of 2) were correct. English OCR read back 144 of 144 text boxes. Tesseract Arabic failed 23 of 126 boxes,
   all on correct renders, while a vision model read them exactly. Spend: 0.4500 USD of the 10 USD cap.
7. The model-painted controls spelled every line correctly in both languages. They also painted a claim with no data
   behind it ("GRIP OUTSOLE", because the prompt asked), redrew the shoe, and placed pointers on the wrong part (Nano Banana
   2: at most 1 of 3 right by eye; GPT Image 2: 2 of 3). Each canvas size and each language needs a new paid generation.
8. Recommendation: build the compositor inside catalog-module on sharp. Use code templates for layouts C and P, text only
   from the fact sheet and glossary, pointer spots from the vision model clamped to the matte with an operator drag
   to override, and panel photos from the brand's own photos first, then DD4's gated generator. Checks before publish:
   glyph coverage, read-back (vision model for Arabic), contrast, thumbnail legibility and channel safe areas. Every
   infographic is reviewed until the exit numbers hold. Do not buy a template API.
9. Cost per infographic for DD9: callout 0.0108 USD per product across all channels; panels from brand photos
   0.0079 USD; panels with 2 generated scenes about 0.41 USD.

## Findings

### F1. Layout families in the meeting references and what each needs

Evidence: transcript `meetings_folder/Catalog-Module-Connect-GCC-14e47c7c-2580.md` (18:33 to 21:57, 31:21 to 34:33) and the
recording's frames 79, 80, 98 and 102 (zoomed copies in `frames/`). The UAE marketplace page is an `en-ae` storefront with
prices in AED and delivery to Jebel Ali; its domain cannot be read in the recording (owner question Q1).

| # | Layout (reference) | What is on it | Inputs it needs | Who supplies each input |
|---|---|---|---|---|
| L1 | Feature tiles (Birkenstock gallery image, frame 80) | Title "ARIZONA" and a tagline line, the shoe large, a row of square close-up tiles of the product, each with an uppercase label ("ADJUSTABLE STRAPS", a second tile cut off) | Product name, 2 to 4 features each with a close-up crop, optional tagline | Fact sheet `productName`, `features[]`; crops from the brand's own photos (DD1 PK detail views) |
| L2 | Pointer callouts (the B5 brief; also how both image models drew it in F8) | The product photo, 2 to 4 labels at the sides, a thin line from each label to the feature | Features, a spot on the product per feature, a clean product photo | Fact sheet; vision model or operator for the spot (F5); the module's matte for the product |
| L3 | 3-panel use case (Birkenstock gallery image, frame 98) | Title "ARIZONA BLACK: YOUR EVERYDAY ESSENTIAL", three worn-shoe scenes, a heading and two lines of small body text under each | Three scenes of the product in use, three headings, optional body lines | Panel scenes from the brand's photos, B4 lifestyle (DD4) or new generations (F6); headings from `occasion` |
| L4 | A+ "Features" row (Amazon.com, frame 102) | Brand video, a paragraph of brand copy, a row of 4 image modules with captions | A+ modules uploaded to a separate surface | Amazon Brand Registry owner (F4) |

Reading:
- L1 and L2 are the same product on one canvas. L1 suits features that are best shown up close (straps, insole, weave),
  and L2 suits features with an obvious spot on the whole product. The trial renders both in one layout: pointers where
  the feature is visible on the main photo, a detail tile where it is not (F5). This is layout C.
- L3 is layout P. Its small body text under each heading ("Navigate city streets in comfort...") is marketing copy. It
  is not a fact and not in DD5's schema, so it is left out. Headings alone carry the idea.
- The tagline in L1 and L3 ("Premium ...", "YOUR EVERYDAY ESSENTIAL") is also copy. It is left out unless the brand
  supplies it as an approved text field in its style profile (DD8), never generated per product.
- The Namshi and Trendyol listings shown at 26:07 and in DD4's sample have no pointer infographics for our brands. One Keds
  Trendyol listing carries the brand's own insole infographic (DD4 F2).

### F2. Text and facts: where every word comes from, and catalog-service's painted-text history

The fact sheet (DD5 "Proposed fact sheet schema") defines `features[]` as "list of short typed claims { key, text } ...
The only input B5 infographics may render as callouts. A claim with no data source is never added". Sources in precedence
order: operator, brand-manager sheet, sku_master_p2p (where "MEMORY INSOLE" sits misfiled as a material), and Trendyol
description extraction (status `proposed` only). DD7 adds the record `{ productId, featureKey, reason: "customers praise",
evidenceCount }`, which "may only reorder or select among existing DD5 features[] with status confirmed", and its guard
rail 2: "Customers love..." copy and any rating or review count are never rendered on images.

Rules derived for B5:
- A callout is drawn only for a `features[]` entry with status `confirmed`. Proposed, conflicting or missing features are
  shown to Naz as "check this" and never drawn. In the trial, "GRIP OUTSOLE" (no data source) and the bag's "ZIP CLOSURE"
  (no data source) were skipped by code (`skipped` in `meta/*.boxes.json`).
- The words on the image are not the free text of the fact. Each feature key maps to a fixed English and Arabic label in
  a reviewed glossary (`memory_foam_insole` gives "MEMORY FOAM INSOLE" / "نعل داخلي من الميموري فوم"). No model writes
  label text. A key with no glossary entry is not drawn, and the operator sees "No label yet for this feature". This
  keeps Arabic quality to a one-time native review of a short list, instead of per-product generation (DD5 R3 holds
  generated Arabic for review).
- The title is brand + style name from the fact sheet identity (`brand`, `productName`), and the subtitle is a glossary label for the
  DD0 subcategory and gender ("Men's running shoes" / "حذاء جري رجالي").
- Panel headings come from the typed `usage.occasion` values through the same glossary ("running" gives "MORNING RUN" /
  "جري الصباح"). With fewer than three occasion values, or when the panels are the brand's own photos, headings name what the
  photo shows (shot role: "ON THE SHOULDER", "FULL LOOK", "CUFF DETAIL"). Those make no product claim.
- Order of callouts: the glossary's default order per subcategory, then DD7's praise records move a confirmed feature
  up. Complaints never change an infographic.
- Never on an image: prices, discounts, ratings, review counts, "best seller", certifications not in the fact sheet,
  competitor names, seller names or logos (Noon bans "seller names, or seller logos").

catalog-service evidence (read only, `C:\Users\Sujan Ajay\Desktop\catalog-service`, commit 1f95291):
- The gallery planner builds a "product card" whose facts an AI call extracts from product data
  (`gallery.py` lines 285 to 335: "You build identity and unique overlay facts"), then sends them to the image model to
  paint: "Render every fact visibly and legibly in the finished image" (`_overlay_rules_when_facts`, lines 1131 to 1172).
- Its fixes are mostly about what the model painted: `fb397f9` "cap on-image text at max_callouts (#70)", `31c27c2` "keep one
  unit system on generated image overlays (#76)", `c3b2bea` "keep overlay callouts as shopper values, not PIM keys (#86)",
  `2ccd3b2` "use overlay source_field with value as shopper context (#89)", `39be253` "mark verification Needs review when overlay
  claims are unsupported (#95)", `26e9756` "complete dimension facts (#82)". Six of 75 commits.
- The verifier (`verify.py` lines 546 to 590) scores painted "overlay chrome" against the facts with an AI judge, and
  the result is advisory (program doc section 7). It catches some invented or contradicting text after the money is spent,
  and cannot fix it.

What to lift, as patterns only (rebuilt in TypeScript, no code imported):
- **Slot definitions as data**: `role`, `kind` (`infographic`, `detail`, hero), `priority` (`core` first), `owns`,
  `feature_priority`, `max_callouts` (`category.py` lines 45 to 52, `gallery.py` `_candidate_ci_slots`). In B5 this becomes a
  per-subcategory layout row: which layouts, which feature keys in which order, a callout budget per layout.
- **Fact ownership**: one shopper fact appears once per gallery (`_parse_card_facts` drops duplicate shopper facts; unused
  facts go to empty overlay slots, lines 900 to 1060). In B5, a feature drawn on the callout image is not repeated on
  the panels image.
- **No facts, no overlay slot**: `_slot_usable` skips overlay slots when the product has no facts (lines 596 to 604). In
  B5, a product with fewer than 2 confirmed, glossary-covered features gets no callout image. That is a typed reason in
  the links sheet, not a blank.
- **Brief layout as sections**: the sectioned brief (SUBJECT, IDENTITY, OVERLAY FACTS) maps to a typed render spec (title,
  hero, callouts[], tiles[], panels[]), which code renders and the check stage reads back. Nothing is sent to a model as text
  to paint.

Not lifted: AI extraction of facts, painted text, advisory-only verification, and free-text "Brand DNA" typography
(DD8 rejected it; `common_image.py` compresses DNA into fonts and colours by an AI call).

### F3. Arabic and English typography, RTL and font licensing (local render test)

The module renders with sharp (`packages/core/package.json` `"sharp": "^0.35.5"`; `render.ts` imports it on line 1 and
composites with it on line 605). `sharp.versions` on the installed build reports `pango 1.58.2`, `harfbuzz 14.5.0`,
`fribidi 1.0.17`, `fontconfig 2.18.3`, `freetype 2.14.3`, `rsvg 2.63.2`, `cairo 1.18.6`. Text therefore goes through Pango,
which shapes with HarfBuzz and orders bidirectional text with FriBidi. This holds for sharp's `text` input and for SVG
`<text>` (librsvg lays text out with Pango).

Test (`scripts/artest.cjs`, output `outputs/ar_test.png`):
- Strings: "أشرطة قابلة للتعديل" (adjustable straps), "نعل مريح من الفلين ١٠٠٪" (Arabic-Indic digits and percent), "ADJUSTABLE STRAPS",
  and a mixed line "Memory foam نعل مريح 100%".
- Path A, sharp `text` input with `fontfile` (IBM Plex Sans Arabic Bold, Noto Sans Arabic): letters joined, lam-alef ligature
  in "للتعديل", digits and percent placed at the left end as RTL requires.
- Path B, SVG `<text direction="rtl">` through librsvg with a private `fonts.conf` (`FONTCONFIG_FILE`): same result, and the
  mixed line ordered correctly.
- The trial renders also drew the shadda in "مضفّر" stacked on the right letter (`meta/ocr_fail_crops.png`).
- Trap found (`meta/fallback_test.png`): rendering Arabic with the Latin-only Montserrat file still produced Arabic,
  because Pango fell back to another installed font. On a Cloud Run image with no fallback font, the same call would
  draw empty boxes. A code check must list every character of every string, confirm the assigned font file has a glyph
  for it, and fail the render otherwise.
- fontconfig printed "No writable cache directories" with a read-only cache path. The worker image needs a writable cache
  directory (for example under /tmp) or the `fontfile` path, which the trial used without a cache.

Typography rules from the test and the reference images:
- One font per script, set per brand style profile (DD8) with an OFL default: Montserrat (Latin, Birkenstock-like
  geometric caps) and IBM Plex Sans Arabic (Arabic), both checked for full glyph coverage of the glossary.
- Bilingual by default: the English label with the Arabic label under it in one block (the two painted controls chose the
  same pattern unprompted). An Arabic-first variant mirrors the layout: title right-aligned, labels on the right column
  read right to left. That is a layout flag, not a second design. Whether channels want bilingual or separate
  images is owner question Q3.
- Western digits in Arabic labels. Arabic-Indic digits render correctly, but tesseract read "٪١٠٠" as "7٠٠١", and digits are
  where a wrong claim does most harm.
- Uppercase is a Latin-only treatment. Arabic has no case, so the Arabic line uses a heavier weight, not a larger size.

Font licensing (fonts downloaded from the google/fonts repository into `fonts/`, licence file `fonts/OFL.txt`):
- Montserrat, IBM Plex Sans Arabic ("This Font Software is licensed under the SIL Open Font License, Version 1.1",
  Reserved Font Name "Plex") and Noto Sans Arabic are OFL 1.1. OFL allows commercial use and bundling with software. The
  only limit is that the font may not be sold by itself. Images made with the font are not covered by the licence, so
  marketplace images carry no obligation.
- A brand's own typeface (for example Birkenstock's) needs a licence that covers server-side rendering for Opptra. Most
  desktop font licences do not. The default is OFL fonts unless the brand supplies a font file with written rights
  (owner question Q5, the same rights record as DD8).

### F4. Channel acceptance of text and graphics, and the slot (repo first, then external gaps)

Repo today (`packages/core/src/catalog/channels.ts`, `compliance.ts`, `qa/judge.ts`, SPEC.md):
- No role and no slot concept. Output n equals source n (DD1 F1). `backgroundFor` gives Amazon and Shein a white image 1.
- `compliance.ts` `checkOutput` fails `background` and `inside_safe_box` when any pixel outside the safe box differs from
  the canvas colour by more than `BG_TOLERANCE` 24. Labels and lines placed in the margins fail both checks by design.
- The judge's `no_text_or_watermark` dimension raises `text_or_watermark` (`qa/judge.ts` line 27), listed in SPEC.md line 297
  as a QA-detected defect, and a held source photo gets `holdCause: "photo_one"` (`apps/worker/src/catalog/pipeline.test.ts`
  line 393). The Keds brand insole infographic would be held today as a defect, and our own infographic would be flagged
  if it went through the judge.
- SPEC.md non-goals (line 849): "No photo-shoot, template, gallery or prompt features from the earlier app."

External (official sources marked; fetched 2026-10-22):

| Channel | Text and graphics on a non-primary image | Slot | Source and status | Proposed setting |
|---|---|---|---|---|
| Noon | Allowed with conditions: "If you're adding text to the images, make sure the language is not offensive or in any way inappropriate"; but "Only photographs are permitted, CAD drawings, thumbnails, or illustrations are not allowed" and "No logos, watermarks, unwanted text or objects are allowed" | Sequence "Front, Back, Side, Any other angles, Details, Usage"; primary always a front view | noon support page "Image Requirements and Rejection Reasons for the Seller SKU" (official, https://supportagent.noon.partners/portal/en/kb/articles/image-requirements-and-rejection-reasons-for-the-seller-sku-12-3-2024) | Allowed, pending confirmation (Q2): callout in the "Details" position, panels in "Usage" (last). Layouts built from real photographs only, no icons-only or illustration layouts |
| Namshi | Not published | Assume Noon | Secondary only (DD1a E8); the reference page may be Namshi or another UAE site (Q1) | As Noon, pending confirmation |
| Trendyol | Not published; a secondary blog says text may be rejected | Not published | Practice: a Keds Trendyol listing carries the brand's own insole infographic (DD4 F2) | Allowed. Cap of 8 images: Keds and Campus average 7.0 to 7.8, so the slot competes with LS and the size chart (Q4) |
| 6thStreet | Not published (vendor portal) | Unknown | Ask | Not sent until confirmed |
| Amazon (.ae, .sa) gallery | Allowed on alternates: the rules list "MAIN images must not have any borders, logos, watermarks, text, colour blocks, inset images or other graphics" under MAIN only; alternates are recommended for "a product specific size mapping chart" | Never MAIN; cap 1 MAIN + 8 alternates | Amazon.ae "Shoes, Handbags & Shoe Accessories" style guide (official, https://m.media-amazon.com/images/G/39/help/Shoes_and_Handbags_Styleguide_EN_AE._CB1198675309_.pdf, pages 3 to 4) | Allowed as alternates |
| Amazon A+ | A separate surface (brand story, modules with images and text) below the gallery, managed in Seller Central or the A+ Content API, available to the brand owner registered in Amazon Brand Registry | Not a gallery slot | Reference frame 102; A+ module specs not fetched | Out of scope for B5 now (R7) |
| Styli | The studio email defines a 5-shot apparel sequence and nothing else | No slot for an infographic | Owner's email (DD1a E9) | Not sent until Styli confirms |
| Centrepoint | Not published (Landmark portal) | Unknown | Ask | Not sent until confirmed |
| Shein | Not published; DD4 found an official AI content policy about AI imagery that misrepresents items | Unknown | Secondary (DD1a E6) | Not sent until confirmed (a generated panel scene would also fall under the AI policy) |
| VogaCloset | Not published | Unknown | Secondary (DD1a E7) | Not sent until confirmed. Cap 10 |

Reading:
- No channel with a public rule allows text on image 1. The infographic is always an additional image.
- "Details" then "Usage" (Noon) gives a natural order: brand photos by role, then the callout, then lifestyle (LS, DD4)
  or the panels last. On channels at their cap, the extra images compete for the same slots (Q4).
- Safe area: marketplace apps draw their own badges over gallery images. Frame 98 shows a "77 OTHERS ARE VIEWING" pill over
  the bottom of the reference infographic, and the wishlist heart sits in a top corner on most GCC apps. Text and
  pointer dots stay out of the bottom 8% and the top-right corner square of 12%, on top of each channel's margins.
- Model-painted text would add a further risk on Noon: "illustrations are not allowed" is read by a human reviewer, and
  a model-drawn product is less of a photograph than the brand's own pixels.

### F5. Pointer placement: how a callout finds its spot, and failure modes

Three ways, compared in the trial (`scripts/locate.cjs`, `meta/locate_runs.jsonl`, `meta/located.json`):
1. **Vision model locates the feature.** One call per photo returns, per feature key, `visible`, a point `[y, x]` and a box,
   normalised 0 to 1000 (google/gemini-3.8-flash, chosen automatically in production and never shown). 4 calls, 13
   feature queries, 0.01143 USD in total (0.0018 to 0.0042 per photo). Results, judged by eye on the renders:
   - Campus side view: lace-up, heel tab and outsole located on the right parts. "memory foam insole" was answered
     `visible: false` ("The inside insole of the shoe is not visible from this exterior side view"), which is correct.
   - Campus top view: the insole was located inside the opening (used for the detail tile).
   - Vero Moda bag packshot: weave at the body centre, handle at its top, "zip closure" `visible: false`, which is correct.
   - French Connection shirt on model: waist tie, sleeve and neckline on the right parts.
   - 6 of 6 points used in the renders landed on the right part (checked by eye on the outputs); the other 5 located
     points were not drawn and not checked. 2 of 2 "not visible" answers were correct. This is a small sample.
2. **Matte geometry.** The module's matte (`render.ts` `shotGeometry`, `detailFeatures` around lines 281 to 360, which
   already finds compact high-contrast regions such as logos and buckles) gives the product silhouette and part
   positions by rule (sole band at the bottom of a side-view shoe, `soleStrip` in `apps/worker/src/catalog/chunk.ts` line
   185). This works for a few parts only (sole, toe, heel, handle top) and knows nothing about straps, insoles or ties.
   It is used as a check, not as the source: the point must sit inside the matte at alpha 128 or more
   (`ANCHOR_MASK_ALPHA` in `compliance.ts`). Otherwise it is snapped to the nearest matte pixel within 3% of the
   canvas, or the callout is held.
3. **Operator pick.** In the review card, Naz drags the dot. One click per feature, always available, and it wins.

Failure modes and the rule for each:

| Failure | Seen in | Rule |
|---|---|---|
| Feature not visible from the hero angle (insole, lining, inner pocket) | Campus side view | Detail tile from another photo where `visible` is true (the trial took the insole from the top view); if none, no callout for that feature |
| Feature is the whole product (weave, fabric, "breathable") | Bag weave | Point at the box centre is acceptable; better as a detail tile (texture crop) when a close-up photo exists |
| Point on the background or the edge | Not seen in the trial | Matte check, snap within 3% or hold |
| Pair or symmetric product (two shoes, two sleeves) | Shirt sleeves | One point, on the item nearest its label |
| Labels crowd one side, lines cross | Shirt (2 labels on the left) | Labels sorted by point height per side, pushed apart by code; at most 4 callouts (catalog-service `max_callouts`); more features go to tiles |
| Point drifts when the model is wrong | Nano Banana 2 painted control (F8) | Painted pointers cannot be checked or moved; code pointers can be moved by the operator |

### F6. Backgrounds and panel scenes: generation or pure design

Callout image (layout C): no generation. A plain canvas in the brand profile's colour (default the channel grey, or the
photo's own studio colour, measured by code as `productBox` does in the trial), the brand's own product pixels, and code
text. Nothing on it is generated, so the product needs no fidelity gate.

Panels image (layout P), in order of preference:
1. **The brand's own photos.** French Connection and Vero Moda already ship 3 or more worn or carried photos per option
   (DD4 F2: French Connection bags 7 of 8 sets, Vero Moda bags 4 of 8). The trial's bag and shirt panels use only brand
   photos (`vmbag_panels_*`, `fcshirt_panels_*`), with no generation and nothing to gate.
2. **B4's lifestyle image plus new scenes from DD4's generator.** For footwear, where a worn scene is missing about 99% of
   the time, the panel scenes are DD4 LS frames (Nano Banana 2 full generation for adults, the composite still life for
   kids and thin bag sets), one scene per occasion. They pass DD2's gate plus DD4's scene checks S1 to S4 before they reach a
   panel, and the panel image is flagged `generated`. The trial reused DD4's Campus plaza frame and generated two more
   (running path at sunrise, office lobby): the shoe kept its colour, red accents and logo positions in both. The running
   frame shows a skyline that looks like a real Gulf waterfront, the same S3 landmark risk DD4 found on Puma, so S3 would
   hold it.
3. **Pure design without photos** (icons, drawn scenes): not used. Noon allows "Only photographs".

Panel crops: each scene is cropped to the panel's aspect around the product box (sharp `position: "attention"` in the
trial; production uses the matte's product box from the generated frame, as DD4 R4 does). The product must stay whole
inside each panel (DD4 S4).

### F7. Options for the compositor: build vs ready-made template APIs (prices read 2026-10-22)

| Option | What it is | Price (USD) | Arabic | Fit | Trade-offs |
|---|---|---|---|---|---|
| O1 Build on sharp in catalog-module | Templates as TypeScript layout functions; text by Pango, lines by SVG, images by sharp composite; renders per channel canvas | Compute only: 0.18 to 1.16 s per render measured on this laptop; at the module's 0.0000265 USD per vCPU-second (DD9) under 0.00004 per render | Shaped correctly (F3) | Same stack, same worker, same compliance, naming and publish contract; no new library | We own the layout code; layouts need taste and care per aspect (F8 showed portrait canvases too sparse) |
| O2 Bannerbear | Template designer plus REST API | Automate 49/month (1,000 API credits), Scale 149/month (10,000), Enterprise 299/month (50,000); 1 credit per image; requests refused when credits run out (bannerbear.com/pricing) | Not stated on the pricing page | Designer-friendly templates | Second vendor, key and data-processing review; product photos and facts leave the module; RTL and shaping unverified; per-channel sizes need one template per size |
| O3 Placid | Template designer plus REST API | Basic 19/month (500 credits), Pro 39/month (2,500), Business 89/month (25,000), VIP 249/month (100,000) (credits from placid.app/pricing; dollar figures from TrustRadius, the official page did not render them) | Not stated | As O2 | As O2 |
| O4 Templated.io | Template API | Starter 29/month (1,000 renders), Scale 79/month (5,000), Enterprise 179/month (25,000), billed annually (templated.io/pricing) | Not stated | As O2 | As O2 |
| O5 Canva Connect Autofill API | Fill brand templates from data via Canva's API | Requires "a Canva plan that includes Autofill, such as Canva Pro, Canva Teams, or Canva Enterprise" (canva.dev autofill guide); usage limits "will be introduced"; plan price not read | Canva supports Arabic in its editor; API rendering not tested | Naz could edit templates herself | Per-user plan, an OAuth integration and a second system of record; automation limits not yet published |
| O6 Image model paints the whole infographic | Nano Banana 2 or GPT Image 2 with the facts in the prompt | 0.1031 and 0.1026 per image measured (F8), per canvas size and per language | Spelled correctly in the trial | Fast to try | Redraws the product, pointers unreliable, claims depend on the prompt, no deterministic re-render, catalog-service's bug history (F2) |
| O7 Keep the manual route | Naz with ChatGPT (transcript 21:33) | Her time | Unchecked | Works for a few styles | Does not reach the catalogue; no fact link |
| MCP plug-ins | Canva and template vendors offer connectors for desktop assistants | As O2 to O5 | As above | A way to try a vendor from a desktop | Not a pipeline component (same conclusion as DD4 for fal.ai and Photoroom MCP) |

Open vs closed: O1 runs on open-source libraries already in the image (sharp is Apache-2.0, libvips LGPL, Pango and HarfBuzz
LGPL and MIT-style) and OFL fonts. O2 to O5 are closed hosted services. Other open renderers were not tested: node-canvas
(Cairo and Pango, which would shape the same way) adds nothing over sharp, and HTML-to-image tools add a browser to the
worker image.

Build vs buy on cost and fit: a template API costs 0.005 to 0.05 USD per image on its plans, against under 0.0001 for O1.
Price is not the deciding factor. Fit is: the vendors need our product photos and facts sent out, do not state RTL
shaping, render one template per canvas size, and would sit outside the module's compliance, review and publish
contract. The meeting's "copy with pride" test (transcript 31:21) is answered for the image model (bought, DD3) but not
for the layout, which is a few hundred lines on a renderer the module already runs.

### F8. Trial (3 products, the recommended path plus model-painted controls)

Products (public Trendyol CDN images, read only):
- Footwear: Campus "Men Glitch Memory Foam Lace-Up Running Shoes - Black" (`22G-1329_GLITCH_Blk-Red`), DD4's inputs.
- Bag: Vero Moda "VMMARLA Braided Bag" Black (`VM_10350639_OD_Black`), 5 images: 4 carried, 1 packshot.
- Apparel: French Connection "Women Arezzo Long Sleeve Waist Tie Shirt" (Winter White), DD3's inputs.

Trial fact sheets (`meta/facts.json`): the warehouse could not be read in this session (BigQuery re-authentication
required), so features were taken from the Trendyol product names and categories and marked `proposed`. Under R2,
proposed facts are never published; the trial treats them as confirmed stand-ins. Arabic labels were written for the
trial and need native review before any use.

Runs:
- Code renders (`scripts/compose.cjs`): layouts C and P for each product at Amazon 2000x2000, Noon 1080x1480, Trendyol
  1200x1800, Styli 2342x3123, Centrepoint 3000x3000 and 6thStreet 2000x2667. 36 renders, 0.18 to 1.16 s each, 102 KB to 1.09
  MB (all under the 2 MB limit), sRGB JPEG 4:4:4 like the module's encoder. Each render writes its text boxes to
  `meta/<name>.boxes.json`.
- Pointer location: 4 vision calls (F5).
- Panel scenes: 2 Nano Banana 2 generations for Campus (`outputs/P_nb2_campus_run.png`, `P_nb2_campus_commute.png`), 2K 3:4,
  4 references, DD4's prompt shape; the third panel reused DD4's `A1_nb2_campus.png`.
- Painted controls: the same Campus references, and a prompt asking for a square infographic with the title "GLITCH: YOUR
  DAILY RUN", three callouts with pointers ("MEMORY FOAM INSOLE", "LACE-UP FIT", "GRIP OUTSOLE") and the three Arabic labels.
  Nano Banana 2 at 2K (`N_nb2_painted.png`) and GPT Image 2 at 1024x1024 medium (`N_gpt2_painted.png`).
- Checks (`scripts/check.cjs`, `meta/checks.json`): 270 text boxes across the 30 channel renders (the 1:1 drafts excluded).

Results:

| Item | Result |
|---|---|
| Callouts drawn from facts | Campus: "LACE-UP FIT" pointer plus "MEMORY FOAM INSOLE" detail tile (insole crop from the top view); "GRIP OUTSOLE" skipped (no source). Bag: "SHOULDER CARRY" and "BRAIDED WEAVE"; "ZIP CLOSURE" skipped. Shirt: "LONG SLEEVES" and "WAIST TIE" |
| Pointer spots | 6 of 6 drawn points on the right part; 2 of 2 "not visible" correct |
| Product pixels | The brand's own photo on every callout and on the bag and shirt panels; nothing redrawn |
| Arabic shaping | Correct on every render, checked by eye on zoomed crops and by the vision model's transcription |
| Read-back, English (tesseract.js 6.0.1, eng) | 144 of 144 boxes matched (similarity 0.9 or more after normalising) |
| Read-back, Arabic (tesseract.js, ara) | 103 of 126 matched. The 23 failures are all tesseract misreads of correct renders: "مضفّر" with shadda read as "مضف" or nothing, "الصباح" read as "الصباج". The vision model transcribed the three failing strings and the full bag callout exactly (`meta/vocr_runs.jsonl`) |
| Contrast (WCAG ratio, ink vs ground inside each box) | Minimum 6.8:1 (bar 4.5:1); 0 failures |
| Thumbnail legibility (cap height on a 400 px long side) | 81 of 270 boxes under 5 px, all on portrait canvases (Trendyol 39, Noon 24, 6thStreet 9, Styli 9): the trial sized text from the short side. Square canvases passed. Text size must be set per aspect against the thumbnail |
| Safe area (4% inner margin) | 270 of 270 inside |
| Layout quality by eye | Square canvases read well. Portrait canvases leave a large empty band (P on Trendyol, C on Noon); production needs a stacked or 2-plus-1 panel layout and a larger hero for 2:3 and 0.73 |
| Generated panel scenes | Shoe colour, accents and logo positions kept in both; the running frame's skyline resembles a real Gulf waterfront (S3 hold) |
| Painted controls: spelling | Both models spelled every requested English and Arabic line exactly (vision transcription) |
| Painted controls: claims | Both painted "GRIP OUTSOLE", which has no data source, because the prompt asked. The model cannot know which facts are true; control has to happen before the model, and then the model adds nothing to code text |
| Painted controls: pointers | Nano Banana 2: at most 1 of 3 right by eye ("LACE-UP FIT" ends near the lowest eyelet; "GRIP OUTSOLE" ends in empty space beside the heel; "MEMORY FOAM INSOLE" ends on the laces). GPT Image 2: lace-up and outsole right, insole at the heel collar |
| Painted controls: product | Both redrew the shoe; Nano Banana 2 changed the view and the sole lettering (read back as "WINNEREFLEX"). Neither is the brand's pixels |
| Latency | Code render 0.18 to 1.16 s; generation 25.3 to 40.1 s per image; vision location 1 to 4 s |

### F9. Checks before publish and how they join the needs-attention flow

Checks, all on the final JPEG of each channel render:
1. **Fact gate (code, before rendering)**: every label and heading is a glossary entry for a `confirmed` feature or a
   typed `occasion` or role; fewer than 2 callouts or 3 panels means no image and a typed reason.
2. **Glyph coverage (code)**: every character of every string has a glyph in its assigned font file (F3 fallback trap).
3. **Read-back (OCR)**: each placed text box is cropped from the final JPEG and read back. English uses tesseract on CPU
   (Apache-2.0, 144 of 144 in the trial). Arabic uses a vision-model transcription once per aspect family (square, 3:4,
   2:3), because tesseract's Arabic misread 18% of correct boxes. A mismatch after normalising (case, diacritics, alef
   forms, digit forms) holds the image. Since the strings are known, this mainly catches render faults: clipping,
   missing glyphs, wrong font, text under a pointer dot.
4. **Contrast (code)**: WCAG ratio of ink to ground inside each box of at least 4.5:1, measured on the pixels.
5. **Legibility (code)**: cap height at a 400 px long-side thumbnail of at least 6 px for labels and 8 px for titles
   (the trial showed which canvases fail).
6. **Safe area (code)**: text and dots inside the channel's margins (Noon 5% sides and 10% top and bottom, Styli
   guides), outside the badge zones (bottom 8%, top-right 12% square) and outside the product mask (labels never
   cover the product; pointer lines may cross it).
7. **Pointer (code plus operator)**: the dot inside the matte (alpha 128 or more), or moved by the operator.
8. **Panel scenes**: generated scenes carry their DD2 and DD4 gate result; a scene on hold holds the panel image.
9. **Compliance**: `checkOutput` keeps `magic`, `bytes`, `extension`, `format`, `dims`, `density`, and skips `background`,
   `inside_safe_box`, `styli_anchor` and `noon_wide` for infographic outputs (the same carve-out DD4 R2 asks for LS).
   The judge's `text_or_watermark` is not run on an infographic output; the read-back replaces it.

Needs-attention flow (`packages/core/src/catalog/attention.ts`, the `{ why, what }` card pattern in `render.ts` around
line 557):
- New typed reasons, plain words for Naz, no model names: "A feature on this image has not been confirmed yet" (fact
  gate), "Some text did not read back correctly" (read-back), "The arrow may point at the wrong spot" (pointer outside the
  matte), "Text is too small on this marketplace" (legibility), "One of the scenes is waiting for review" (panel scene).
- The card shows the image with each pointer draggable and each label listed with its source ("from: brand sheet").
  Approve, drag a dot, or switch a callout off. Text cannot be typed on the card; a wrong word is fixed in the
  fact sheet or the glossary, and the image re-renders.
- Review-all for every infographic until the exit numbers hold (R5). After that, callout images whose checks all pass
  publish without review; panels with generated scenes follow DD4's LS exit numbers.
- The links sheet gets the infographic in its own column per channel, or a reason ("Not added: this marketplace has not
  confirmed it accepts infographics", "Not added: fewer than 2 confirmed features").

### F10. What catalog-module reuses and what is new (repo evidence, worktree `01-intent-map` at 4ef72df)

Reused as is:
- sharp and its bundled Pango, HarfBuzz and FriBidi (`packages/core/package.json`); the JPEG encoder loop, ICC profile, density
  and 4:4:4 sampling in `render.ts` lines 608 to 613; `planCanvas` canvas sizes from `channels.ts` `CHANNELS`.
- The matte and product box (`render.ts` `renderSource`, `shotGeometry`), `ANCHOR_MASK_ALPHA` for the pointer check.
- The judge's `view` and DD1's roles to pick detail-tile sources (PK sub-views `top`, `inside`, `detail`) and panel photos (FM,
  FL, LS, carried).
- The LLM layer (`packages/core/src/llm/openrouter.ts` `chatCompletion`, which already sends images) for pointer location and
  Arabic read-back; spend caps in `packages/core/src/catalog/qa/caps.ts`; costs in the cost ledger (`cost.ts`).
- Attention cards, links sheet and publish contract (naming `catalog/<brand>/<path_key>/<channel>/<path_key>_<n>.jpg`).

New for B5:
- A role value `infographic` for outputs (and for brand-supplied infographics such as the Keds insole image, so the judge
  stops treating them as `text_or_watermark` defects), and a slot rule per channel (after Details, before or instead of Usage).
- A channel table column `infographicAllowed: yes | no | unknown` (unknown means not sent), part of `CHANNEL_RULES_VERSION`.
- A layout registry as data per subcategory: layouts offered, feature-key order, callout budget, theme (fonts, colours)
  from DD8's style profile.
- A bilingual feature glossary (feature key to English and Arabic label), versioned and reviewed by a native reader.
- The compositor (layouts C and P per canvas aspect), the checks in F9, and a `render_key` that includes the fact-sheet
  version, glossary version, layout version and pointer positions, so an infographic re-renders when any of them changes.

## Options (summary)

| Option | Cost per infographic (USD) | Text accuracy | Product truth | Arabic | Verdict |
|---|---|---|---|---|---|
| A. Code compositor in catalog-module (O1), brand photos first, DD4 generator for missing scenes | 0.0079 to 0.0108 (no generation); about 0.41 for footwear panels with 2 generated scenes | Exact by construction, read back | Brand pixels on callouts; gated scenes on panels | Shaped by HarfBuzz, glossary reviewed once | Recommended |
| B. Template API (Bannerbear, Placid, Templated, Canva) | 0.005 to 0.05 per image on plan, plus O1-level checks we still need | Exact | Brand pixels | Unverified | No: a second system for a small layout job |
| C. Image model paints the infographic (O6) | 0.103 per canvas size and language | Spelled right in the trial, claims only as good as the prompt, pointers wrong | Redrawn | Spelled right in the trial | No |
| D. Callouts only, no panels | 0.0108 | Exact | Brand pixels | As A | Fallback if the owner rejects generated panel scenes |
| E. Manual (Naz with ChatGPT) | Her time | Unchecked | Redrawn | Unchecked | No |

## Recommendation

R1. Scope. Two layouts, as additional images only:
- **C, feature callouts**: brand + style title, a subtitle from the subcategory glossary, the brand's own hero photo,
  2 to 4 pointer callouts, and up to 2 detail tiles for features not visible on the hero.
- **P, use-case panels**: title, three panels, a heading under each, no body copy.
- Footwear, bags and apparel. Product types without a glossary entry for at least 2 features get no infographic.
- Amazon A+ is out of scope (R7).

R2. Facts and words. Only `features[]` with status `confirmed`, through the bilingual glossary; titles from identity;
headings from `occasion` or shot role. DD7's praise records may reorder confirmed features only. Never prices,
ratings, review words, taglines or seller marks. No model writes any text that appears on an image.

R3. Rendering. TypeScript layout functions in `packages/core` on sharp: Pango text with explicit `fontfile` per script,
SVG for lines and dots, composite for images, rendered natively at each channel's canvas (no cropping of a master),
encoded by the module's encoder. Default fonts Montserrat and IBM Plex Sans Arabic (OFL), overridable by DD8's style
profile only with a font file the brand has licensed for server use. Bilingual labels by default; an Arabic-first
mirrored layout behind a flag. Western digits. Font sizes set per aspect against the thumbnail rule in F9.5.

R4. Pointers and panels. Pointer spots from one vision call per hero and detail photo (model chosen automatically, never
shown), checked against the matte, draggable by the operator. Detail tiles when a feature is not visible on the hero.
Panel photos: the brand's own photos by role first; for footwear without them, DD4's LS frames and new scenes from DD4's
gated generator (adults only, scene rules from DD4 F4 keyed on `occasion`), flagged `generated`.

R5. Checks and review. The nine checks in F9, the new attention reasons, review-all for every infographic. Exit for
callout images: 100 labelled callout images across at least 3 brands and all 3 departments with zero wrong words
and zero wrong claims, and at least 95% of pointers accepted without a drag. After the exit, callout images whose
checks pass publish without review. Panels with generated scenes follow DD4's LS exit.

R6. Channels and slots. A per-channel `infographicAllowed` setting: Amazon and Trendyol yes; Noon and Namshi yes,
pending confirmation (Q2); 6thStreet, Styli, Centrepoint, Shein and VogaCloset unknown, so not sent until confirmed.
Never image 1. Order after the brand's photos: callout image at Noon's "Details" position, then LS (DD4) and panels last.
At a channel's cap (Trendyol 8, Amazon 9), the owner's priority list decides (Q4); otherwise the image is not sent and
the links sheet says why.

R7. Amazon A+. Out of scope for B5. A+ modules are a separate surface owned through Brand Registry, and the module
publishes gallery images by public link. If the owner later wants A+, the same compositor can render A+ module images.
Upload goes through Seller Central or the A+ Content API, a separate integration and a separate approval.

R8. SPEC.md amendment (draft; the owner edits SPEC.md). In "Non-goals", replace

> - No photo-shoot, template, gallery or prompt features from the earlier app.

with

> - No photo-shoot, template, gallery or prompt features from the earlier app, except the infographics of spec <nn>: a
>   feature-callout image and a use-case panels image per product, laid out and lettered by code from the product's
>   fact sheet (confirmed features only, through the reviewed bilingual glossary) and the brand's own photos; never
>   lettered by an image model; panel scenes from the brand's photos or from the lifestyle generator of spec <nn> under its
>   gate; always an additional image, never image 1, only on marketplaces marked as accepting infographics; read back and
>   checked before publish and held for a person until the spec <nn> exit numbers are met and recorded here.

Also add to the QA-detected list (SPEC.md line 297) "(not run on the module's own infographic outputs, which are read
back instead; a brand-supplied infographic is classified as role `infographic`, not as `text_or_watermark`)". Add a
row to the models table: "Infographic pointer location and Arabic read-back (spec <nn>): the vision tier of the judge
policy, chosen automatically; cost per image recorded in the cost ledger."

## Exact costs

Measured in this trial by per-response `usage.cost` (OpenRouter), as DD4 did. Compute uses the module's
`COMPUTE_USD_PER_VCPU_SECOND` default of 0.0000265 (Cloud Run Tier 1, request-based; DD9 and
`docs/solutions/catalog-go-live-2026-10-19.md` line 164).

| Item | Cost (USD) | Basis |
|---|---|---|
| Pointer location, one vision call per photo | 0.0029 mean (0.0018 to 0.0042) | 4 calls, 0.01143 total |
| Arabic read-back, one vision call per aspect family | 0.0026 (0.0023 to 0.0026 on renders; 0.0094 to 0.0123 on 2K painted images) | 4 calls, 0.026523 total |
| Code render, one layout, one channel | under 0.00004 | 0.18 to 1.16 s at 1 vCPU |
| **Callout image, one product, all 9 channels** | **0.0108** | 1 location call 0.0029 + 3 Arabic read-backs 0.0078 + about 2.5 vCPU-seconds 0.0001; tesseract English on CPU |
| **Panels image from brand photos, all 9 channels** | **0.0079** | 3 Arabic read-backs 0.0078 + about 5 vCPU-seconds 0.0001 |
| **Panels image with 2 generated scenes (footwear), all 9 channels** | **about 0.41** | 2 scenes at DD4's 0.20 per accepted LS image + 0.0079; the third scene is the B4 LS image (counted in B4). One attempt costs 0.1032 (measured 0.10316 and 0.10316) |
| Painted infographic (rejected option C), per canvas size and language | 0.1031 (Nano Banana 2, 2K) / 0.1026 (GPT Image 2, 1024 medium) | Measured |
| Template APIs (rejected option B) | 49 to 299/month (Bannerbear), 19 to 249/month (Placid), 29 to 179/month (Templated), Canva plan with Autofill | F7 |
| Glossary review | Owner's Arabic reviewer, once per glossary version | No vendor cost |

Catalogue numbers for DD9 (upper bounds; the share of options with at least 2 confirmed features is unknown until DD5's
fact sheet exists, and could not be sized from the warehouse in this session):
- Callout images for all 3,748 options: 3,748 x 0.0108 = 40.48 USD.
- Panels from brand photos for all 3,748 options: 3,748 x 0.0079 = 29.61 USD.
- Footwear panels with generated scenes for the 1,146 adult and kids footwear style-colours less the 85 kids (DD4 F1:
  no generated child): 1,061 x 0.41 = 435.01 USD. Bags with 3 or more carried brand photos use brand photos.
- The agency's INR 60 per style (about 0.71 USD at INR 84) covers images and templates; one callout image costs about
  1.5% of it.

## Repo evidence

catalog-module (worktree `C:\Users\Sujan Ajay\Desktop\catalog-module-wt\01-intent-map`, commit 4ef72df):
- `packages/core/package.json` (sharp ^0.35.5); `packages/core/src/catalog/render.ts` (line 1 import, `renderSource` from
  line 536, composite line 605, encoder lines 608 to 613, `detailFeatures` around lines 281 to 360, attention card around
  line 557)
- `packages/core/src/catalog/channels.ts` (`CHANNELS`, `backgroundFor`, `CHANNEL_RULES_VERSION` "10", `MAX_OUTPUT_BYTES`)
- `packages/core/src/catalog/compliance.ts` (`BG_TOLERANCE`, `ANCHOR_MASK_ALPHA`, `checkOutput` background, safe box,
  `styli_anchor`, `noon_wide`)
- `packages/core/src/catalog/qa/judge.ts` (line 20 `QA_DIMENSIONS`, line 27 `DIMENSION_FLAGS` `no_text_or_watermark`, line 183
  `CHART_VIEW`); `apps/worker/src/catalog/qa-stage.ts` line 158; `apps/worker/src/catalog/pipeline.test.ts` line 393 (hold on
  `text_or_watermark`); `packages/core/src/catalog/evals/attention.ts` line 64 (`JUDGE_ONLY_FLAGS`)
- `apps/worker/src/catalog/chunk.ts` line 185 (`soleStrip`); `packages/core/src/llm/openrouter.ts`; `packages/core/src/catalog/qa/caps.ts`;
  `packages/core/src/catalog/cost.ts`
- `docs/SPEC.md` lines 297 to 299 (QA-detected text and watermarks), 835 to 849 (non-goals)

catalog-service (`C:\Users\Sujan Ajay\Desktop\catalog-service`, read only, commit 1f95291):
- `server/pipelines/generation/gallery.py` (lines 1 to 8 planner summary; 49 to 130 `SlotPlan`, `CardFact`, `AssignedFact`;
  163 to 205 slot selection and `max_callouts`; 285 to 335 AI fact extraction; 596 to 660 `_slot_usable` and selection;
  900 to 1060 fact ownership; 1101 to 1172 painted overlay rules)
- `server/pipelines/generation/category.py` lines 45 to 52 (slot keys); `verify.py` lines 546 to 590; `common_image.py`
  (fonts and colours from Brand DNA); `server/tests/test_gallery.py` lines 34 to 470
- Commits `fb397f9`, `31c27c2`, `c3b2bea`, `2ccd3b2`, `39be253`, `26e9756`

Meeting: `meetings_folder/Catalog-Module-Connect-GCC-14e47c7c-2580.md` (18:33 to 22:38, 31:21 to 37:12) and the recording's frames
79, 80, 98 and 102.

## Context7 and libraries

Context7 was not available in this session (no Context7 tool was offered), as in DD1a, DD2, DD3, DD4 and DD5. No new
library is recommended for the build. Facts used here came from the installed sharp (`sharp.versions`, local renders) and
vendor pages named above. Before any build, check these with Context7:
- sharp's `text` input options (`fontfile`, `width`, `align`, `wrap`, `rgba`, `dpi`) and SVG text through librsvg on the
  Linux build used by the worker image;
- fontconfig cache configuration on Cloud Run;
- tesseract.js (used only in the trial; version 6.0.1, while npm lists 7.0.0) if CPU OCR is kept for English;
- the OpenRouter chat request with image input and `response_format` for the location and read-back calls.

## Depends on earlier DD answers

The recommendation assumes every earlier deep dive's recommendation is approved. What changes if the owner answers
differently:

| Earlier answer | If approved (assumed) | If not |
|---|---|---|
| DD5 fact sheet with `features[]`, statuses and provenance | Callouts draw only confirmed features; labels via glossary | No callout images at all (nothing may be drawn without a fact source). Panels from brand photos with role headings remain possible |
| DD5 source precedence (sku_master_p2p as the main structured source) | Features from p2p's misfiled values and brand sheets | With brand sheets only, callouts cover only brands that send sheets; French Connection, Puma and Nautica (absent from p2p) depend on that anyway |
| DD7 review hand-off record | Praise reorders confirmed callouts | Glossary default order only; nothing else changes |
| DD0 taxonomy (subcategory, department) | Layout registry and glossary keyed by subcategory | Keyed by product type only; one generic layout per type, subtitle without subcategory |
| DD1 roles and order (option B) | Detail tiles and panels chosen by role; infographic placed by slot | Without roles, the operator ticks the panel and tile photos per product, and the infographic is appended last |
| DD1a channel rules and caps | `infographicAllowed` and caps encoded | Infographics risk silent drops at the Trendyol and Amazon caps and rejections on unconfirmed channels |
| DD2 gate and DD4 scene checks | Generated panel scenes gated | Footwear panels only from brand photos, which are rare (DD4 F2); in practice option D (callouts only) for footwear |
| DD3 and DD4 generator (Nano Banana 2 via OpenRouter) | 0.20 per accepted scene | Another generator changes the panel price; callouts are unaffected |
| DD8 style profile | Fonts, colours and per-brand layout choices from the profile | One global OFL theme for every brand |
| DD9 money model | Uses F-costs above | Numbers scale with the option universe and DD4's price |

## Questions only the owner can answer

- Q1. Which site is the Birkenstock Arizona reference (frames 79 to 98, an `en-ae` storefront priced in AED)? If it is one of
  our nine channels, it is the best evidence that the channel accepts infographics.
- Q2. Can Naz or the account managers confirm in writing that Noon and Namshi accept a text-and-photo infographic as an
  additional image (Noon's page both mentions "adding text" and bans "illustrations")? Same question for 6thStreet, Styli,
  Centrepoint, Shein and VogaCloset.
- Q3. Bilingual images (English with Arabic under it, as the trial does), or separate English and Arabic images per locale
  where a channel shows locale-specific galleries?
- Q4. At the image cap (Trendyol 8, Amazon 9), what is the priority among the size chart, the lifestyle image (B4), the
  callout image and the panels image?
- Q5. Do the brands' written rights (DD8's record) allow Opptra to letter their product images, and does any brand require its
  own typeface or forbid feature claims beyond its own sheet?
- Q6. Who reviews the Arabic glossary (the same native reader as DD5's golden set)?
- Q7. Is Amazon A+ wanted later, and does Opptra hold Brand Registry access for any of the 9 brands on Amazon.ae or .sa?

## Approval question

Do you approve, as the basis for a B5 spec: (a) two layouts, feature callouts (with detail tiles) and 3-panel use-case
images, as additional images only, never image 1, for footwear, bags and apparel; (b) every word from DD5's confirmed
`features[]`, identity, `occasion` or shot role through a reviewed bilingual glossary, with no text ever lettered by an image
model; (c) building the compositor inside catalog-module on sharp with OFL fonts by default, instead of a template API;
(d) pointer spots from the vision model checked against the matte and draggable by Naz; (e) panel scenes from the brand's own
photos first and DD4's gated generator second; (f) the nine checks and review-all until 100 labelled callout images show
zero wrong words and claims; (g) sending only to channels marked as accepting infographics; (h) 0.0108 USD per callout image
and about 0.41 USD per generated-scene panels image as the numbers DD9 uses; and (i) the SPEC.md wording in R8?

Trial spend: 0.45 USD (0.4500285 by per-response `usage.cost`: Nano Banana 2 3 images 0.3094385, GPT Image 2 1 image 0.102637,
pointer location 4 calls 0.01143, vision read-back 4 calls 0.026523). Cap for this deep dive 10 USD. Program spend before
this deep dive, as recorded: DD3 5.39 and DD4 1.80.

Status: done, awaiting owner answer
