# M11 Rich media - requirements (draft for review, 2026-11-02)

Follows `00-template.md`. Plain words; jargon is defined the first time it appears. Sources are listed at the end.

## 1. Purpose

- **Why it exists.** Infographics, lifestyle scenes, brand faces, A+ pages and listing video are the content that vendors
  crowd into, but for Opptra each one is gated: no brand rights are on file, Noon and Namshi acceptance of text on images
  is unknown (conflict C19), GCC Amazon is small, and lift is unproven. The one real market gap is **Arabic and
  right-to-left (RTL) infographics and A+**, which nobody offers (`competitors-visual`, "What nobody does well" 3).
- **Outcome metric.** Per asset type and channel: acceptance rate (share published without rejection) and measured lift
  through a pre-registered M4 experiment. Secondary: cost per accepted asset, and share of winning keywords that reach the
  infographic within one change set (I039).
- **Intents served:** I037 (whole catalog, incl. A+ and video), I039 (winning signals propagate to the infographic), I014
  (people only for rights, likeness, modesty, audits), I002 and I003 (buy generation, with fallbacks), I008 and I017
  (upload and walk away, one digest), I021 (settings without code), I026 (consistency across brands), I028 (every
  module tied to an outcome), I004 (measured, not assumed).

## 2. Scope

**In (when promoted; nothing here is in the first slice):**
- An **add-on slot layer**: rich media is appended after the photographic shot set (from M3), never image 1, never
  displacing a brand photo. This follows the C19 recommendation in `channel-rules` (Layer A photos, Layer B add-ons).
- Infographics drawn by our own code, in English and Arabic, RTL for Arabic, from text that already exists as versions in
  M0 (product facts from M2, keywords and text from M8, winners from M10).
- Lifestyle scenes for shoes and bags, still life first (the brand's own product pixels pasted into a generated
  background, no person).
- Brand faces and kids on-model, only with written rights and approved model packs.
- Amazon A+ modules, drawn by code first (India first), and listing video, made from approved stills first.
- One policy per brand x channel x category that decides who gets which asset, so no person ticks products.

**Out:**
- Ad-creative and avatar video (Creatify, Arcads, Pencil): ad creative, not catalog.
- Any per-product approval queue or "spot-check card" per product. Audits are sampled (M7), never a queue.
- Free text typed by an operator reaching any generator. Settings pick from fixed lists.
- Prices, discounts, ratings, awards or marketplace badges on any image.
- A synthetic (AI-invented) child, ever.

**Later (beyond this file's features):** callout pointers to detected product parts; an infographic drawn on a scene
frame; Hindi and regional infographics (India); generated video from a bought image-to-video model; 360 spins.

## 3. Contracts

### 3.1 Reads

| From | Entity or event | What M11 uses it for |
|---|---|---|
| M0 | `product`, `listing` (SKU x channel), `content_version` (images with role, source, hash, cut-out mask) | Base photos, current gallery per channel, positions |
| M0 | `content_version` of kind text (title, bullets, highlights, Arabic text) with `trust_state` | The words drawn on infographics and A+ |
| M0 | `experiment_assignment` and the "do not touch" control flag | Never change a control listing; tag treatment assets with the arm |
| M0 | `change_set` | Group a winning keyword's title, backend terms and infographic into one treatment (I039) |
| M2 | Image analysis (shot role, presence: packshot, worn, carried, scene; kids present; text overlay) and gap report | Eligibility; "already has a scene" detection |
| M2 | Product facts with source and trust state | Candidate highlight lines |
| M5 | Channel rules: text on image allowed, logo allowed, style (plain band or branded), max images, add-on slot order, video spec, AI disclosure rule, kids-on-model allowed, generated images allowed | Where an asset may go and how it must look |
| M5 | Claims and banned words; Arabic and RTL rules | Refuse a line before drawing |
| M7 | Fidelity check, planted-defect suite, audit sampling, blocking human calls, bilingual consistency check | Gate every generated or drawn asset |
| M8 | Titles, bullets, Arabic text, keywords from paid search terms | Highlights and A+ copy |
| M10 | Budget and priority list; winners per change type | Who gets rich media first; what propagates |
| M12 | Brand DNA: colours, fonts, logos, voice, scene profile, rights record, model packs | Styling, permissions, likeness |
| M6 | Vendor interface, cost meter, spend caps | Every paid call |

### 3.2 Writes

| To | Entity or event | Notes |
|---|---|---|
| M0 | `content_version` with `role` in {`infographic`, `scene`, `on_model_b`, `aplus_module`, `video`} | `source` in {`code_drawn`, `composite`, `generated`, `brand`}; `ai_generated` true when any pixel was generated |
| M0 | `content_version.renders_text_ids` | The text version ids an infographic or A+ module draws, so a text change can retire the asset |
| M0 | `rich_media.made`, `rich_media.not_made` (reason code + plain sentence), `rich_media.retired` (superseded, rights expired, channel refused) | Feed the digest (M1) and the learning log (M10) |
| M6 | One cost event per paid attempt, with asset type and route | Zero-cost events for code-drawn assets are still written (count only) |
| M7 | Check results per asset (numbers and words, never vendor names) | Audit sampling reads these |

### 3.3 Queue and API shapes

```
POST /api/rich-media/plan            # called by the pipeline after M3 publishes a product's shot set
{ "batch_id": "...", "product_ids": ["..."], "trigger": "batch" | "change_set" | "policy_change" | "rights_change" }
-> 202 { "planned": 1240, "skipped_by_policy": 760 }

queue: rich_media.make  (one task per product x asset_type x language; idempotent key = product_id + asset_type + language + input_hash)
{ "product_id": "...", "asset_type": "infographic", "language": "ar", "channels": ["noon","amazon_ae"],
  "inputs": { "base_image_version": "...", "text_version_ids": ["..."], "brand_dna_version": 7, "rules_version": 41 },
  "change_set_id": null | "...", "experiment_arm": null | "treatment" }

event: rich_media.made     { product_id, asset_type, language, channel, version_id, position, cost_usd, change_set_id }
event: rich_media.not_made { product_id, asset_type, language, channel, reason_code, sentence }
```

The `input_hash` makes re-runs safe: the same inputs never make a second asset (no duplicates after a deploy or a retry).

### 3.4 Contract needs from M0

1. The role and source values above, plus an `ai_generated` flag on every image version (M3 already needs it).
2. `renders_text_ids` on image versions, and an event when any of those text versions is superseded.
3. `change_set` as a first-class record that groups versions across content types, with one treatment id for M4.
4. Per-channel positions, so the add-on layer can append after the photographic set.
5. The control flag, readable before any make task starts and again before publish.
6. A retirement event that the publish step (M9) turns into "remove from channel" on the next listing file.

## 4. Features

All M11 features are P2 or Later in `module-map.md`, so by the template each gets a brief section. Because Sujan asked
for detail and these features are mined from three long old initiatives, each brief is followed by the **rules carried
forward** (simplified) and the **gate to promote it**, so nobody needs to re-read initiatives 04, 05 and 07.

### M11-F1 Infographics, Arabic and English (P2; I037, I039)

**Brief.** One extra image per product: the brand's own product photo (cut out) beside a solid text panel with up to
three short highlight lines, in the brand's colours and font. All words are drawn by our code, never by an image model,
so the text is exact. Arabic versions are drawn right to left with an Arabic font. Placed last, never image 1. No paid
call is made (about USD 0.00004 of compute per image, judged).

**Rules carried forward (from initiative 07, simplified).**
- M11-F1-R1. Text is drawn by code (SVG rendered from shipped font files, layered over the cut-out). No image model draws
  text, panels or callouts.
- M11-F1-R2. Every drawn line equals its stored text version byte for byte (only outer spaces trimmed). A check reads the
  drawn text back and compares.
- M11-F1-R3. Up to three highlights, each at most 40 characters (counted as characters, not bytes). One line each in a
  bottom band; up to two lines each in a side panel. Text is never cut short; if it does not fit at the minimum readable
  size, that layout does not fit.
- M11-F1-R4. Refused before drawing: price or currency next to a number, "% off", promotion words, superlatives and
  badges ("best seller", "#1"), restricted claims ("antibacterial", "eco-friendly"), and any brand or channel banned
  word from M5. "100% cotton" stays allowed.
- M11-F1-R5. The product is never covered: the product mask grown by a clearance margin shares zero pixels with any
  panel, letter or logo. Product pixels are unchanged except scaling.
- M11-F1-R6. Contrast of text on panel is at least 4.5 (the WCAG ratio; 1 is the same colour, 21 is black on white).
- M11-F1-R7. Noon and Namshi get a "plain band": a flat colour band, no logo, no bullets, no shapes, over the brand's
  unchanged photograph, until the channel manager confirms text overlays (conflict C19). Other channels get the branded
  style with the brand's logo where M5 allows it.
- M11-F1-R8. Position: after every other image, within the channel's maximum image count. When a scene image and an
  infographic both do not fit, the scene keeps its slot. A brand photo is never dropped for an infographic.
- M11-F1-R9. A check that cannot run counts as a failure. A failed asset is "not made" with a plain sentence and never
  holds back the product's other images.
- M11-F1-R10. **Arabic (new, the gap).** Arabic highlights come from M8's Arabic text versions (never machine-translated
  at draw time). Drawn RTL with an OFL-licensed Arabic font (Noto Sans Arabic or IBM Plex Sans Arabic; builder confirms
  licences). Letters are shaped (joined) by a text-shaping library; the check compares the shaped output's characters with
  the stored text. The layout mirrors: panel on the left, text right-aligned, bullets on the right. Digits follow a
  per-channel setting (Western digits by default). No letter spacing and no italics on Arabic.
- M11-F1-R11. **Bilingual.** Per channel rule: one image per language (default), or one bilingual band where M5 says the
  channel shows one gallery for both languages. M7's bilingual consistency check must pass: the English and Arabic lines
  state the same facts.
- M11-F1-R12. **Where the words come from (simplified from initiative 07).** The old design needed a person to type a
  highlights sheet. The new default needs nobody: highlights are picked by code from trusted text versions in this order:
  (1) a highlight the brand or an operator gave (sheet column or product page), (2) winning keywords from M10 that match a
  trusted product fact, (3) trusted facts from M2 (material, sole, closure, fit), ranked by the brand voice's keyword
  family. A fact with trust state below "trusted" is never drawn. Nothing is invented.
- M11-F1-R13. **Cross-pollination (I039).** When M10 promotes a winning keyword for a product group, it opens one change
  set that updates the title (M8), the backend terms (M8) and the infographic highlight (M11) together, logged as one
  treatment in M4. The infographic is re-drawn automatically; no person acts.
- M11-F1-R14. **Who gets one.** A policy, not a tick list: per brand x channel x category, "infographic: off | top N by
  revenue | all eligible". Default "off" until the gate below passes; then "top 20% by revenue" (the top 10% of options earn
  86% of revenue, `outcome-baseline`).

**Gate to promote to P1.** (a) M8 text exists for the target products; (b) at least one channel's text-overlay stance is
confirmed in M5 (ask Noon's channel manager; seed: Amazon and Trendyol branded, Noon and Namshi plain band); (c) a
20-product pilot per channel shows no rejection; (d) an M4 experiment is pre-registered.

**Acceptance test (end state).** An admin sets the US Polo footwear policy to "top 20% by revenue" for Amazon.ae and Noon.
The next batch, with no operator action, produces English and Arabic infographics for those products; Noon's are plain
bands without logos; every drawn word matches its stored text; the digest line reads "Infographics: 36 made in English and
Arabic, 2 not made (the highlights are too long for Noon's band)". Promoting a test keyword in M10 updates the title and the
infographic in one change set visible in M0.

**Buy or build.** Build: nobody sells Arabic or RTL infographics (`competitors-visual`). English-only generators (Rewarx,
Phot.AI, Dresma, Helium 10) are vendor claims and draw text with models, which we refuse. First check whether Canva or
Adobe Express APIs render Arabic templates well enough to buy (open question Q1).

### M11-F2 Lifestyle scenes for shoes and bags (Later; I002, I037)

**Brief.** One generated scene image per selected shoe or bag, placed after brand photos, never image 1, never a face.
Still life first (the brand's own cut-out pasted unchanged into a generated background; zero product-fidelity risk), then
worn footwear (legs or feet only), then carried bags (below the head). About USD 0.20 per accepted image (measured
attempts of USD 0.10 to 0.14), capped at USD 0.81 per product.

**Rules carried forward (from initiative 04, simplified).**
- Selection is a policy (brand x category: off | still life | worn or carried), not a per-product tick. The brand's
  rights record sets the ceiling: a policy can only be lowered by rights, never raised.
- The setting comes from a short fixed list of scene hints per product type (office, street, track, park, pitch, beach,
  poolside, cafe, evening, home, playground), each mapped to a sentence approved per brand. No typed text reaches the
  generator.
- Never in a scene: a face, readable text or signs, other brands or logos, real landmarks, alcohol, religious buildings,
  flags. Modesty is fixed: women's legs covered to the ankle; men's knees covered except pool or beach scenes for sandals
  and slides; long sleeves on any visible arm in bag scenes.
- Kids and unknown audience: legs or feet only, one child, no adult, no face, head or body above the knee (bags held at
  the waist). The audience is set to kids by code from size and name words (towards safety).
- Every frame passes every check (framing by a people detector that stores no face data, modesty with a measured skin
  share, scene safety, crop safety for every channel's crop, realism, product fidelity, and for carried bags hand scale,
  strap continuity and hardware). Two independent judges must both pass. A failed frame is "not made"; nobody is asked to
  rescue it.
- Still-life product pixels are proved identical to the brand's cut-out. Every generated file carries the AI-generated
  tag and the M0 `ai_generated` flag.
- A real brand lifestyle photo, when it arrives, retires the generated scene on the next publish.
- Generated scenes do not go to Noon or Namshi until their AI-image stance is known (gate-1 decision: crops only there).

**Gate to promote.** Rights on file for the brand with a lifestyle scope (M12-F3), M7 fidelity check live, a scene-versus-
none experiment pre-registered. The cheapest fast signal is ad conversion on sponsored US Polo pages (USD 55,280 of ads
land on packshot-only pages, initiative 04).

**Buy or build.** Buy generation behind the M6 vendor interface: Photoroom Plus (USD 0.10 per image; negotiate the
pay-only-for-passing-images Guarantee), Claid as second, a router such as fal.ai as fallback. Pebblely, Booth and Flair are
weak on fidelity. Build the checks, policy and placement.

### M11-F3 Brand faces and kids (Later; I014, I037)

**Brief.** Garments that arrive as flat lays only are shown on the brand's own approved model; kids clothes appear on a
child only on the brand's approved kids model, only where the channel allows it, never a synthetic child. Every face
needs a written likeness right on file and a person-approved model pack. Face data is sensitive personal data.

**Rules carried forward (from initiative 05, simplified).**
- Rights are one record per brand (M12-F3): who granted it, a document reference (never the text), the sites covered,
  "may use model photos as reference" yes or no, "may generate the model's likeness" yes or no, valid from and to. Flat lay
  to on-model needs both yes answers. An expired record stops new faces the same day.
- Models: the system groups the brand's own model photos into people (within one brand only); a person confirms each
  group ("Same person", "Split", "Not usable") and approves a model pack of four standard photos. An approved pack is never
  edited; a change is a new version. Adults and kids are kept apart.
- **The person is permanent here** (Sujan's ask: "brand rights and likeness need a person"). A person records every rights
  record and approves every model pack. That is per brand and per model, not per product.
- **Simplified from the old design:** the old design asked one person to approve an "anchor" photo for every product.
  The new rule removes that per-product step: until a licensed face-identity check (one that measures whether the face is
  the approved model) exists and passes on the golden set, **face-showing shots are not made at all**. Once it exists,
  they are checked automatically and audited at a higher rate (1 in 4 for kids, 1 in 10 for adults; M7).
- Kids: never on Noon or Amazon; kids underwear, lingerie and swimwear never on a child; no crop or logo cut from a photo
  that shows a child; one child, no adult in the frame.
- Biometric handling: face measurements only for the brand's own models, never operators, shoppers or passers-by; never
  compared across brands; never in any page, export, log or report; stored only in private storage; seen only by admins.
  UAE and KSA data protection laws treat biometric data as sensitive; get legal confirmation before go-live (open
  question Q4).
- Deletion at three levels: one photo, one model ("Delete this model's data", typed confirmation), one brand ("Delete this
  brand's data", typed confirmation). Counts are recorded, never images. Published product images stay.

**Gate to promote.** Legal confirmation on biometric and child data in UAE and KSA; a commercially licensed face-identity
model; at least one brand's rights record with likeness; a pre-registered experiment.

**Buy or build.** Buy on-model generation (FASHN, which does not charge for failed outputs; Botika at about USD 0.75 per
photo; Caimera; Modelia). Build rights, model packs, checks and data handling.

### M11-F4 A+ content (Later; I037)

**Brief.** Amazon A+ modules (image and text blocks under the listing) for brands with Brand Registry, India first
(Cortina targets A+ coverage above 90%, `channel-rules`), GCC Amazon later because it is small (about 140 softline units a
week). Modules are drawn by code from approved photos and M8 text, in English and, where Amazon.sa or .ae accepts it,
Arabic, using the same composer and checks as M11-F1.

**Key rules.** A fixed set of module templates per category (comparison chart, feature grid with up to four images,
brand story); no claims outside M5's approved list; module sizes and counts from M5 data (Amazon's specs are a gap today,
`channel-rules` gap list); upload through the SP-API A+ content endpoints only where a token exists (India), otherwise a
download pack for Seller Central. Amazon's own free A+ AI drafting (US English) is used as a benchmark only.

**Buy or build.** Build the composer (shared with infographics); verify the A+ upload route per marketplace (open question
Q5).

### M11-F5 Listing video (Later; I037)

**Brief.** A 15 to 30 second product video to each channel's spec, for channels that accept video (Amazon yes; Noon,
Namshi and Trendyol unknown; ask through the M5 channel gaps workflow). Version one is **motion from approved stills**
drawn by code (slow pan and cross-fade over the brand's photos plus the infographic, no generated pixels), which costs
almost nothing and carries no fidelity risk. Generated video comes later.

**Key rules.** No music with unclear licence; captions from M8 text; no faces beyond those already approved; spec checks
(length, size, format, aspect) from M5 data.

**Buy or build.** Build the stills-to-motion step; buy image-to-video later (Photoroom enterprise, Caimera) behind the M6
interface, gated by an experiment, because the market's video tools are made for ads, not marketplace spec.

### M11-F6 Ad-creative and avatar video (Skip)

Skipped: ad creative, not catalog (Creatify, Arcads, Pencil). Revisit only if Opptra's ads team asks for it as a separate
product.

## 5. Operator experience

**Target: nobody does anything per product.** Rich media is decided by policy and made in the background after the
photographic set is live. It never delays links.

- **New batch:** no extra step, card or tick list. If the brand's policy includes rich media, the Start line reads
  "Infographics and scenes follow the brand's settings." with a link "Change" (admins only).
- **While the batch runs:** the single progress line gains one phrase when it applies: "Links ready. Adding infographics
  to 36 products."
- **Digest (M1), one block "Extras":**
  - "Infographics: 36 made (English and Arabic). 2 not made: the highlights are too long for Noon's band."
  - "Scenes: 12 made as still life. 0 needed you."
  - "Not made" reasons are grouped with counts, never listed per product on screen; the exceptions sheet lists them.
- **Product page:** an "Extras" row under each channel's gallery, showing each asset with its source in plain words: "Drawn
  from your product facts", "Generated background, product unchanged", "Generated, checked automatically". A "Remove"
  action writes a retirement version (undo for 10 seconds).
- **Settings (M12):** Brand page sections "Infographic look" (colours, font, logo corner, layout, with a live preview in
  English and Arabic), "Scenes" (on or off, still life or worn, allowed hints), "Faces" (only shown when rights include
  likeness). Policy table per channel: "Off", "Top 20% by revenue", "All eligible".
- **The only person moments in M11:** recording a brand's rights, approving a model pack, approving a Brand DNA version
  (look, voice, scene sentences), and the sampled audit (M7). All are per brand or sampled, never per product.

**Copy for key moments.**
- Not made (infographic): "No infographic: the highlights are too long to fit at a readable size on Noon. They will be
  shortened when the text is next updated."
- Not made (rights): "No scene: this brand's written permission for generated images is not on record."
- Rights about to expire (to admins, 30 days ahead): "Vero Moda's image permission ends on 30 Nov. After that, no new
  scenes or on-model photos are made. Existing images stay."
- Channel refused: "Noon refused 3 infographics this week. Infographics on Noon are paused until you choose what to do."
  Buttons: "Keep paused" and "Try again".

## 6. Measurement

| Metric | Baseline | Target | Data source |
|---|---|---|---|
| Acceptance rate per asset type x channel | Unknown; one Cardio Bunny infographic live on Trendyol with clipped text (`07-infographics`) | 98% or more accepted | M9 rejection feed |
| Lift per asset type (pre-registered, pooled) | Unproven; "up to" vendor figures (A+ +8-20%, video +9.7%) are not evidence (`catalog-os` plan) | A bounded estimate within 12 weeks | M4 estimators |
| Ad conversion on sponsored pages with a scene vs without | Not measured | Detect a 15% change (ad signals have a smaller MDE than organic sales) | Ads tables in BigQuery |
| Words drawn that differ from the stored text | n/a | 0 | Check T3 results |
| Faces made without a valid rights record | n/a | 0 (hard block) | M0 + M12 join |
| Cost per accepted asset | Infographic about USD 0.00004 (judged); scene about USD 0.20 | Within 10% of billing | M6 cost meter |
| Winning keywords reaching the infographic in the same change set | n/a | 100% of promoted winners where an infographic exists | M0 change sets |
| Person minutes per 1,000 products | Initiative 04 assumed a spot check on 1 in 10 products | Under 5 minutes (audits only) | M7 audit log |

Honest note: at GCC volumes a single asset type on the top 20% of options will not reach the 18% MDE (minimum detectable
effect) of the first holdout. Pool across brands (M10) and use ad signals for scenes.

## 7. Build slices

| # | Slice (one worker, one worktree) | Depends on | Acceptance test |
|---|---|---|---|
| S11.1 | Add-on slot layer: policy table (brand x channel x category x asset type) as M5 data, placement after the photographic set, retirement events | M0 roles, M5 rules as data | A policy change in the admin UI changes which products the next batch plans; nothing is planned for control listings |
| S11.2 | English infographic composer and checks (layouts, text fitting, plain band, branded style, product-clear and words-exact checks) | S11.1, Brand DNA look (M12-F3) | 200 golden products drawn; zero failed checks published; planted defects (clipped text, covered product, banned word) all caught |
| S11.3 | Arabic RTL composer: shaping, mirrored layouts, Arabic fonts, digit setting, bilingual check hook | S11.2, M8 Arabic text, M7 bilingual check | 50 Arabic infographics reviewed once by two Arabic readers: zero broken joins or reversed words; checks catch planted mistakes |
| S11.4 | Highlight picker from trusted facts and winning keywords, plus the change-set hook from M10 | S11.2, M2 facts, M10 winners | A promoted test keyword updates title, backend terms and infographic in one change set |
| S11.5 | Channel acceptance pilot: 20 products per channel on Amazon.ae, Trendyol, Noon, Namshi; record outcomes in M5 | S11.2, channel managers | Each channel's text-overlay rule moves from "assumed" to "documented" or "refused" |
| S11.6 | Experiment registration for infographics (and later scenes) | M4 registry | Experiment pre-registered with its MDE before the first treated publish |
| S11.7 | Still-life scenes (composite, no person), with the vendor interface and caps | M6 vendor interface, M7 fidelity, M12 rights | 100 still lifes; product pixels proved identical; zero published without the AI tag |
| S11.8 | Worn footwear, then carried bags | S11.7 | Per initiative 04's check list; cost per accepted within 20% of USD 0.20 |
| S11.9 | Stills-to-motion video and A+ modules from the shared composer | S11.2, M5 video and A+ specs | Files pass each channel's spec checks; upload pack downloads in one click |
| S11.10 | Faces and kids | Legal confirmation, licensed identity check, rights with likeness | Zero face outputs while any gate is missing (tested by removing each gate in staging) |

## 8. Risks and open questions

| # | Risk or question | Recommended default |
|---|---|---|
| R1 | Noon's "only photographs" and "no unwanted text" rules may refuse infographics (C19) | Plain band only on Noon and Namshi; pilot 20 first; pause automatically after 3 refusals in a week |
| R2 | Marketplaces may strip the AI tag from files | Keep the M0 flag as our record; disclosure follows each channel's rule in M5 |
| R3 | Lift is unproven and probably small | Pre-register every asset type; scale only after a readout; report "below X%" honestly |
| R4 | Every added image may need a manual re-upload on portals with no API | Add rich media in the same listing file as the next planned update, not as its own submission |
| R5 | Children's biometric data | No face work until legal confirmation; kids default stays off-figure |
| R6 | Arabic shaping bugs are invisible to non-Arabic readers | Shaping check in code plus a one-off review by two Arabic readers per font and layout |
| Q1 | Can Canva or Adobe render Arabic templates via API well enough to buy? | Check in the S11.3 bake-off; build if neither passes the words-exact check |
| Q2 | One image per language, or one bilingual band? | One per language, unless M5 says the channel shows one gallery for both |
| Q3 | Which digits on Arabic images (Western or Arabic-Indic)? | Western digits by default; a channel setting |
| Q4 | Legal confirmation route for biometric data (UAE PDPL, KSA PDPL) | Ask Opptra legal before S11.10 is scheduled |
| Q5 | A+ upload route: SP-API A+ endpoints for India tokens; GCC by download pack | Confirm token scopes; download pack as fallback |
| Q6 | Do Noon, Namshi and Trendyol accept listing video? | Ask through the M5 channel gaps workflow; build video only after two channels say yes |
| Q7 | Should infographics wait for M8 text, or start from facts alone? | Start from trusted facts (S11.4) so infographics do not wait on M8; M8 text replaces them when ready |

## Sources

- `module-map.md` (M11 rows, risks, cuts), `brief-v1.md`, `00-template.md` settled decisions.
- `C:\Users\Sujan Ajay\Desktop\catalog-module\.runs\2026-11-02-competitors-visual.md` (no Arabic infographics or A+;
  video tools for ads; Photoroom pay-for-pass), `-competitors-listing.md`, `-competitors-measurement.md`,
  `-channel-rules.md` (C11, C19, gaps), `-outcome-baseline.md`, `-data-census.md`.
- `C:\Users\Sujan Ajay\Desktop\catalog-module-wt\initiative-requirements\04-scene-images.md`, `05-brand-faces.md`,
  `07-infographics.md`.
