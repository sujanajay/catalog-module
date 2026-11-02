# M2 Analyze - requirements (draft for review, 2026-11-02)

Follows `00-template.md`. Feature ids `M2-F1` to `M2-F7` are the rows of the M2 table in `../module-map.md`, in table
order. Jargon is defined the first time it appears. Evidence: data census, image audit, competitor study (visual),
Harvey method (all `C:\Users\Sujan Ajay\Desktop\catalog-module\.runs\2026-11-02-*` and `2026-10-26-image-audit.md`),
and the old initiatives 01, 02, 03 and 08 (still-valid detail reused, review cards cut).

## 1. Purpose

- **Why:** every acting module (M3 images, M8 text, M7 quality, M9 publish) needs the same facts first: what the product
  is, what each photo shows, and what each channel still lacks. M2 reads them once, stores them in M0, and says how
  sure it is about each one.
- **Outcome metric:** per-attribute accuracy on the golden set (defined in M7), and gaps found versus a human check.
- **Intents:** I018 (an analyzer that understands each image), I022 (analysis apart from acting), I017 (no
  babysitting), I037 (all content types later), I021 (settings editable), I019 (whole taxonomy over time).

## 2. Scope

**In (P0, first slice):** a decision-grade reading of every photo and every product (M2-F1), and a gap report per
product x channel (M2-F2), for GCC fashion: apparel, lingerie and swim, activewear, footwear, bags. Both run with no
human question; ambiguity is settled by written rules.

**Out:** writing titles or attributes into listing files (M8, M9); making images (M3); deciding pass or fail of a
generated image (M7); channel rules themselves (M5 owns them, M2 reads them).

**Later:** listing attributes such as sleeve length and neckline (M2-F3, P1); channel taxonomy mapping (M2-F4, P1);
listing quality score (M2-F5, P1); web research for missing values (M2-F6, P2); market census (M2-F7, P2); the
non-fashion verticals (home, toys, beauty, hardline), which the schema supports from day one but which get golden
labels and rules only when their turn comes.

## 3. Contracts

### 3.1 Reads
- From **M0**: product, option (style-colour), SKU and channel keys; every source photo as a content version (bytes
  location, sha256 fingerprint, source kind brand / crop / upscaled / generated / vendor); the brand master row
  (category, gender, colour, name, size labels) when it exists.
- From **M5**: the image set policy per channel x taxonomy node (required roles in order, minimum and maximum counts,
  head-cut rule, crop size bars, whether a person may appear), and the colour and pattern lists per channel (P1).
- From **M7**: the current vendor routing for the capability `vision.read` and each attribute's measured accuracy and
  release state (see 4.1.2 R14).
- From **M12** (settings): thresholds and rule tables listed under "Configuration".

### 3.2 Writes (all to M0, all versioned, all with the analyzer version)
- `PhotoReading` per source photo fingerprint (one row per photo per analyzer version; never recomputed for the same
  fingerprint and version).
- `ProductReading` per product (taxonomy node, audience, length, pack, colours, how each was decided).
- `AttributeValue` rows: attribute id, value, source (sheet, image, listing text, rule, web), confidence, trust state
  (`trusted` / `usable` / `unknown`), analyzer version.
- `GapReport` per product x channel x batch.
- Events: `photo.read`, `product.read`, `gaps.computed`, `reading.degraded` (a vendor or check could not run).

### 3.3 Shapes (sketch; builders refine)

```
PhotoReading {
  photo_sha, analyzer_version, read_at,
  measured: { width, height, bytes, format, colour_profile, exif_orientation, aspect,
              border_rgb_median, background_class: white|light_grey|grey|complex|dark,
              background_lightness_min, phash, blur_score, duplicate_of_sha?, text_area_share },
  read:     { taxonomy_node, shot_role, view, framing, head_state: full|none|cut|na,
              head_cut_position?: above_nose|nose_lip|below_lip, product_cut_sides: [top|bottom|left|right],
              person_present, person_count, child_present, text_overlay: none|size_chart|infographic|watermark|label,
              is_collage, is_lifestyle, wrong_item_suspect, defects: [DefectCode] },
  confidence: { per field 0..1 }, decided_by: { per field: code|model_1|model_2|rule|operator },
  vendor_trace_id   // engineering only, never shown to an operator
}
ProductReading {
  product_id, analyzer_version, taxonomy_node, taxonomy_candidates: [{node, score}] (top 3),
  audience: women|men|unisex|baby|kids|teen|unknown, garment_length?: short|knee|long,
  pack: single|multipack, pack_piece_node?, primary_colours: [{hex, share}], colour_family?,
  decided_by: { per field: data|model_1|model_2|name_rule|sibling|same_plan|strictest_plan|operator }
}
GapReport { product_id, channel, policy_version, roles_required[], roles_filled{role: photo_sha},
  roles_cut{role: photo_sha}, roles_missing[], fixable_by: {role: existing|reorder|crop|generate|none},
  reasons{role: ReasonCode}, image_count_ok, main_image_ok, size_ok }
```

Queue shape: one task per product (`analyze.product`, idempotent on product id + set of photo fingerprints +
analyzer version), fanned out by the M1 intake. The task makes at most one vision call per product for the decision
fields (all photos at once, as old initiative 01 designed) plus code measurements per photo.

### 3.4 Contract needs from M0
1. A stable photo fingerprint (sha256 of bytes) as the cache key, and a `content_version` row per photo.
2. (Owned by M2, not M0.) The taxonomy table (4.1.2 R1) and the attribute definition table, both data, both
   versioned, live in M2's own migration. They are the **only** category tree in the system: M5 rules scope by these
   node ids and M5's "Add a category" writes here (integration decision D1).
3. (Owned by M2, not M0.) `PhotoReading`, `ProductReading`, `AttributeValue` and `GapReport` live in M2 tables keyed by
   M0's asset sha256, content version id and option id, with the analyzer version. Trusted listing attributes (P1) are
   also written to M0 as attribute versions so M8 can cite them.
4. The brand master fields joined to the product (census: category is unreliable on most fashion rows; M2 treats it
   as a weak hint, not truth).
5. The holdout control flag (M4), so M2 never triggers a change for a control option. Analysis itself is allowed on
   controls (it changes nothing live).

## 4. Features

### M2-F1 Decision-grade image analyzer (P0)

#### 4.1.1 User story
As the operator who drops 2,000 SKUs, I want every photo and product read correctly without being asked anything,
so that crops, renders, gaps and the digest are right and I never sort photos by hand.

#### 4.1.2 Functional requirements

Schema that grows with the taxonomy:
- **M2-F1-R1** The taxonomy is a tree stored as data: vertical (fashion, home, toys, beauty, hardline) > department >
  product type, each node with an id, parent, names, and the attribute and shot-role sets that apply to it. Adding a
  vertical or product type is a data change plus golden labels, never a code or table change. Seed: the fashion nodes
  from old initiative 01 (Top; Knitwear or sweatshirt; Jacket or coat; Dress or jumpsuit; Trousers, jeans, shorts or
  skirt; Sports top or sports bra; Leggings, sports shorts or joggers; Lingerie or underwear; Nightwear or loungewear;
  Swimwear; Pack of several pieces), Footwear (shoes, sandals and slides, boots, slippers), Bags, Accessories, Home
  (candles, diffusers), plus one `unknown` node per level. Hardline, toys and baby nodes are seeded empty with a
  `not_released` state.
- **M2-F1-R2** Attributes are defined as data: id, value type (enum, number with unit, text, colour), allowed values,
  which taxonomy nodes it applies to, tier (`decision` or `listing`), and source precedence. A test proves a new
  attribute can be added and read without a code change.
- **M2-F1-R3** Shot roles are defined as data per taxonomy node. Seed for apparel (old initiative 02): FM front to
  mid-thigh (to the knee for long garments), FL full length, FC fabric close-up with no model, BH back to the hips, HS
  head and shoulders, BL back full length, FW front from the waist down, BW back from the waist down, DT detail on the
  body, PK all pieces of a pack, flat (front flat lay, packshot or ghost mannequin), FB back flat lay, chart (size
  chart), lifestyle, other. Footwear seed: side, pair, top, sole, back, detail, on-foot, lifestyle, chart. Bags seed:
  front, side, back, inside, detail, carried, lifestyle. A photo that fits no role gets `other`.

Measured by code (deterministic, no vendor, runs on every photo):
- **M2-F1-R4** Pixel size, bytes, format, colour profile, orientation, aspect; background class from a 2% border strip
  (rules from the image audit: white = border median 248+ on all channels; light grey = neutral 195+; complex = under
  80% of border pixels near the median), plus the measured lightness so M3 can test the 240+ rule.
- **M2-F1-R5** Perceptual hash per photo; two photos of one product within the duplicate distance are marked
  `duplicate_of` (the audit found a 14-image Vero Moda set with near duplicates). The larger file is kept as the
  original.
- **M2-F1-R6** Text area share by an OCR pass (text, size chart, infographic, watermark). The OCR runs in our worker.
- **M2-F1-R7** Primary colours: the three main colours of the product area (product mask from the matting service),
  as hex with area share, measured in a standard colour space so M7 can compare them (Delta E). Colour names are not
  read here (P1, mapped to channel lists in M2-F4).
- **M2-F1-R8** Blur score and a "too small to read" mark below 500 px on the long side (the census minimum is 95 px).
- **M2-F1-R9** Head and body points from a people detector with a commercial-use licence on our GPU: person count,
  head inside frame, where the top edge crosses the face. This gives head state and head-cut position by code; the
  vision model is a second opinion, not the only one (head cut is the defect with the highest rejection cost).

Read by a vision model (one call per product, every photo in it):
- **M2-F1-R10** Per photo: taxonomy node, shot role, view (front, back, side, pair, top, sole, inside, detail), framing,
  head state (full = whole head and top of hair inside, a cut above the hairline still counts as full; none = crop at
  or below the chin; cut = top edge crosses the face between hairline and chin; na = no person), product-cut sides,
  person present, child present, lifestyle, collage, and a wrong-item suspicion against the other photos of the
  product. Each with a confidence from 0 to 1.
- **M2-F1-R11** Per product: taxonomy node with top three candidates and scores, audience (women, men, unisex, baby 0-2,
  kids 3-8, teen 9-14), garment length (short, knee, long = hem above, at or below the knee), and pack type.
- **M2-F1-R12** The call replaces today's product-type call in `qa/classify.ts`; the matting step reuses its result.
  It never adds a second call where one result already exists for the same photo fingerprints and analyzer version.

Ambiguity, settled by rules, never by asking a person:
- **M2-F1-R13** Ladder for each per-photo field: (1) code measurement where one exists (R4-R9) wins for measured
  facts; (2) model 1 at or above the field's confidence floor (seed 0.7 for roles and head state, 0.8 for taxonomy);
  (3) below it, model 2 is asked once; (4) if both are below the floor or disagree, the value is `unknown`. An unknown
  role fills no slot, is never marked cut, and never retires a photo. It blocks nothing.
- **M2-F1-R14** Ladder for the product taxonomy node (old initiative 01, step 8 "ask" removed): (1) brand master when
  its category is specific (not `Default`, `Apparel`, `Footwear`, a brand name or a tax slab); (2) model 1 sure; (3)
  model 2 once; (4) name words (an admin-edited list: legging, bra, brief, bikini, dress, jogger, pack of, 3-pack, girls,
  JR, PS, INF, KID, BOY, GIRL, YOUTH and similar); (5) siblings with the same style-number stem and a sure node; (6)
  same plan: if the top candidates lead to the same image set policy, take the most likely; (7) strictest plan: if the
  plans differ, take the strictest for anything that can go live without a person: kids over adult, lingerie or swim
  over top, long over short, multipack over single, unknown audience treated as kids. The deciding step is stored.
- **M2-F1-R15** Kids detection leans to safety: any of kids gender, kids words (R14 step 4) or a child in any photo
  sets audience kids. Bar: no kids product is ever called adult (100% on the golden set).
- **M2-F1-R16** Source conflicts: when the sheet and the image disagree on a decision field (for example the sheet
  says Men and the photo shows a child), the safer value wins by R14 step 7 and the product is marked
  `conflict` for audit priority (M7 samples conflicts first). No question is raised.
- **M2-F1-R17** A vendor refusal (lingerie photos were refused as "prohibited content" 5 times in one load run) or an
  unavailable vendor after the fallback chain gives `unknown` for the model fields, keeps every code measurement, and
  emits `reading.degraded`. Nothing downstream may treat unknown as a pass.

Release by measured accuracy:
- **M2-F1-R18** Every field has a release state from the M7 harness: `released` (meets its bar on the golden set,
  frozen split), `shadow` (computed and stored, not used for decisions), `off`. Only released fields drive M3 or the
  gap report. Seed bars (old initiative 01, kept): each required role at least 95% correct on at least 20 labelled
  photos each; taxonomy node at least 95% on the plan it produces ("a wrong label that gives the same plan is not an
  error"); head cut 100% of cut labels caught and no full or none photo called cut; kids 100%; strictest-plan step
  never less strict than the true label.
- **M2-F1-R19** Confidence calibration: before a floor is used, the harness checks that answers at the floor are right
  at least that often (a 0.8 answer must be right about 80% of the time). A floor change is a threshold change and
  needs one admin approval (settled decision), shown as a proposed change with its evidence.
- **M2-F1-R20** Results are cached by photo fingerprint and analyzer version. A new analyzer version re-reads lazily
  (on the next batch that touches the photo) unless the harness asks for a backfill.

Metadata and safety:
- **M2-F1-R21** Any text read from a photo is data, never an instruction. The vision prompt says so, and the golden
  set holds a planted photo with instruction-like text (M7).
- **M2-F1-R22** No vendor, model or check name in any operator text (tested, as today in `qa/reasons.ts`).
- **M2-F1-R23** M2 never writes to a live listing, takes no product lock, and never writes to Supabase.

#### 4.1.3 Non-functional
- Speed: p95 under 20 s per product end to end (code measurements in parallel with the one vision call); throughput
  2,000 products an hour (I034) with the vendor's rate limits shared with the M7 judges.
- Cost: at most USD 0.01 per product for analysis (today's judge is about USD 0.0009 per product; one multi-photo
  call at about 1,024 px per photo should stay well under the target). Measured by the M6 cost meter, stage `analyze`.
- Reliability: a product always gets a reading, even if degraded (R17). Batches survive a deploy (the task is
  idempotent and cached).
- Scale: 16,358 GCC softline SKUs (4,075 options) in the first backfill; India 10,988 SKUs later.

#### 4.1.4 Configuration (admin, no deploy)
Confidence floors per field; name-word list; sibling rule on or off (default off, as old initiative 01); duplicate
distance; small-photo limit (500 px); field release states (set by the harness, overridable down to `off` by an
admin, never up without a passing run); routing order for `vision.read` (owned by M7-F2).

#### 4.1.5 Inputs and outputs
In: the product's source photos (all, up to 100) and the brand master row. Out: `PhotoReading` per photo,
`ProductReading`, decision `AttributeValue` rows, events. A photo over 40 MB or unreadable gets a reading with only
`measured.bytes` and defect `unreadable`.

#### 4.1.6 Human-in-the-loop rule
None per product. People touch M2 only through (a) the one-off golden labelling (M7-F1), (b) the 2-5% sampled audit
(M7-F3), where a wrong role or wrong taxonomy is one of the audit answers and becomes a new golden case, and (c) one
approval for a floor change (R19). An operator may override a role on the product page; the override wins over every
later reading of that photo and is carried to later batches, but nothing ever asks for one.

#### 4.1.7 Edge cases and failure modes
1. Product type unreadable from category (census: FC uses `Apparel` and `Default`, Penti `Default` or `Penti`, Campus,
   Keds and Puma one `Footwear` label, Hamleys a tax slab): R14 steps 2 onwards.
2. 95 px thumbnails and 9.8 MB, 4,480 px files in one batch: measurements work on both; the vision call receives each
   photo downscaled to the model's best size, never upscaled.
3. One product in 2-3 Supabase folders with different renders: duplicates by perceptual hash (R5); the largest file
   wins.
4. Collage or multi-view image: `is_collage`, role `other`, never a crop parent.
5. Size chart and infographic photos: role `chart` or `other`, text overlay set; excluded from generation references.
6. Mixed backgrounds in one set (36% of audited sets): reported per photo; M3 renders them to one background.
7. Lifestyle shot as photo 1 (7 of 37 live Trendyol listings): role `lifestyle`; the gap report flags `main_image_ok`
   false on channels that need a front first.
8. Wrong product in the folder (1 of 37 live): `wrong_item_suspect` when one photo's garment differs from the rest;
   the product is marked for audit priority; the photo is not used as a crop parent.
9. Vendor rate limit bursts (about 3.5% of judge calls hit 429): back-off as `qa/judge.ts` does today, then the
   fallback chain.
10. Analyzer version change mid-batch: the batch keeps the version it started with.

#### 4.1.8 Buy or build
Buy the vision model, build the schema, rules, code measurements and measurement.
- `vision.read` routing (M7-F2 interface), seed order: (1) Gemini Flash-class model (today `google/gemini-2.5-flash-lite`
  through OpenRouter, the current judge), (2) Claude Haiku-class model (today `anthropic/claude-haiku-5.5`, the
  current second judge), (3) an OpenAI vision model or the open-weight `qwen/qwen3-vl-30b-a3b-instruct` already in
  the bake-off list, whichever scores better. Transport fallback: the same Gemini model direct on Vertex AI (API
  already enabled) when OpenRouter itself fails. Final order is whatever the harness ranks first per field; a field may
  route to a different model than another field (routing, Harvey step 2).
- People detector and OCR: open models with commercial-use licences on our own GPU or worker, pinned versions,
  licence recorded (old initiative 04 rule). Fallback: the vision model's head answer alone, with the field moved to
  `shadow` until the detector returns.
- Vendors Vue.ai, Rubick and Streamoid sell tagging but publish no per-attribute accuracy; they may enter the harness
  as candidates after the demos (gate-1 decision), scored like any model.

#### 4.1.9 Acceptance tests (run as a real operator would)
1. Drop a real 200-product mixed batch (Vero Moda, French Connection, Penti, Campus, US Polo). Every photo has a reading
   and every product a taxonomy node or `unknown`; no question, card or Next appears; the cost meter shows stage
   `analyze` at or under USD 0.01 per product.
2. On the frozen golden split, the harness report shows each released field at or above its bar (R18), with kids 100%
   and head cut 100% caught.
3. Kill model 1 (M7 kill-the-primary switch) and rerun 20 products: readings complete through model 2; the report
   shows the route used.
4. A Penti lingerie photo refused by the vendor: the product still finishes, model fields are `unknown`, the digest
   counts it under "read partly", and the photo is never cropped or used as a parent.
5. Add a taxonomy node "Curtains" and an attribute "panel width" in settings; a Cortina product is read with the new
   node without a deploy (fields stay `shadow` until labelled).

#### 4.1.10 Open questions (each with a recommended default)
1. Floors before calibration: default 0.7 roles and head state, 0.8 taxonomy, as in old initiative 01.
2. Read photos with the brand master category when it is specific, or always from the image? Default: trust a specific
   master category, still read from the image, and flag a disagreement as `conflict`.
3. Sibling rule: default off (old default), switch on after the golden set shows it is right at least 95% of the time.
4. Model input size per photo: default the model's documented best size, decided by the bake-off on cost per correct
   answer.

### M2-F2 Gap report per product x channel (P0)

#### 4.2.1 User story
As the operator, I want one digest that says, for each channel, which shots each product still lacks and whether we
will fill them, so I know the batch is complete without opening any product.

#### 4.2.2 Functional requirements
- **M2-F2-R1** For each product and each ticked channel, compare released readings with the M5 image set policy for the
  product's taxonomy node and audience (kids rows for kids whatever the garment; multipack rows for packs; default row
  when no row exists; `unknown` node = default row, crops only).
- **M2-F2-R2** Each required role gets one state: `filled` (an uncut photo of that role exists), `reorder` (it exists
  but not in position; for image 1, any uncut photo of the channel's image-1 type moves to position 1), `cut` (only a
  cut photo fills it, or a cut photo is image 1), `missing`.
- **M2-F2-R3** Cut state per photo (old initiative 02): head cut is a fault under rule `fail` (every marketplace except
  Amazon) and under `amazon_nose_lip` unless the cut is between nose and lip. Product cut is a fault when the cut side is
  not allowed for the role: FL and flat none; FM and BH bottom only; HS bottom, left, right; FC any; other bottom.
- **M2-F2-R4** For every `missing` or `cut` role, `fixable_by` names the cheapest fix allowed: `existing` > `reorder` >
  `crop` (a parent exists per the M3 parent table, the head is full where needed, and the crop height clears the
  channel's crop size bar) > `generate` (only when M3-F5 is on for that brand and channel) > `none`, with a reason code
  (`too_small`, `no_whole_head`, `no_parent`, `no_view`, `child`, `crops_off_channel`, `making_off`, `unknown_type`).
- **M2-F2-R5** Channel checks beyond roles: image count against min and max (VogaCloset at least 4, Shein at least 2,
  Trendyol at most 8, Amazon at most 9, Shein and VogaCloset at most 10), main image rules (front first, no lifestyle
  first, not cut), and the smallest image against the channel floor.
- **M2-F2-R6** The report is computed before M3 acts (planned gaps) and again after M3 (remaining gaps); the digest
  shows the second. A crop on a channel where crops are off (M3-F1 R2) shows as `crops_off_channel`, so Styli and
  Centrepoint gaps stay visible without being filled.
- **M2-F2-R7** The digest line per batch is counts, not cards: "Shot sets complete on Namshi 412 of 450, Noon 405 of
  450. 38 missing head-and-shoulders: no photo shows the whole head." An exceptions sheet lists every remaining gap with
  its plain reason. No reason means "you must act".
- **M2-F2-R8** A `missing` role is never a product status and never holds the product's links (M1 provisional links).

#### 4.2.3 Non-functional
Pure computation on stored readings and M5 data: under 50 ms per product x channel; zero vendor cost; recomputed when
M5 policy changes (with a new `policy_version`).

#### 4.2.4 Configuration
None of its own: policies, head-cut rules, crop size bars, counts and channel on/off for crops all live in M5 and M3
settings.

#### 4.2.5 Inputs and outputs
In: readings (M2-F1), M5 policy rows, M3 settings. Out: `GapReport` rows, digest counts, exceptions sheet rows.

#### 4.2.6 Human-in-the-loop rule
None. The audit (M7-F3) includes a "gap report was wrong" answer for sampled products; misses become golden cases.

#### 4.2.7 Edge cases and failure modes
1. A role reading is `unknown`: it fills nothing and blocks nothing; the gap shows as `missing` with reason "we could
   not tell which shot photo n is".
2. Uncertain taxonomy: the strictest plan's roles are used (M2-F1 R14).
3. Policy missing for a channel: report `no_policy` (six channels have no content rules today); never invent one.
4. A product with more than 100 photos: intake fails it (M1), M2 is not called.
5. Policy change while a batch runs: the batch keeps its `policy_version`.

#### 4.2.8 Buy or build
Build. Rubick CAST and Salsify do this for US retailers, nobody for Namshi or Noon, and the logic is a small join of
our own data.

#### 4.2.9 Acceptance tests
1. On the golden set, the gap report matches a person's check for at least 95% of product x channel x role cells, with
   zero `filled` claims where the person saw a cut head.
2. A real batch's digest shows per-channel counts and one exceptions sheet; no per-product card exists anywhere.
3. An admin changes Noon's required roles in M5; the next batch's report follows the new list with no deploy.

#### 4.2.10 Open questions
1. Should the report also list text and attribute gaps now? Default: shots only in P0; text and attribute gaps join
   with M8 (P1).
2. Count gaps per option or per SKU? Default per option (style-colour), because photos belong to the option.

### M2-F3 Product facts from photos and sheets (P1)
- **Story:** as the listing writer (M8), I need attributes such as sleeve length, neckline, length, fit, pattern,
  closure, material and colour name, each with a source and a trust state, so listing files can be filled without
  guessing.
- **Key requirements:** listing-tier attributes defined as data (M2-F1 R2) per taxonomy node; sources in precedence
  order per attribute (brand sheet, Trendyol listing text, image reading, rule, web); trust state `trusted` (from a
  trusted source or a released attribute at its floor), `usable` (released but below the floor, used only where a
  channel field is optional), `unknown` (never written). Selective answering: research puts vision models at about
  64% F1 on free-form attributes, so each attribute is released only when the harness shows at least 90% precision
  at its floor on the golden set, and otherwise stays `shadow`; coverage is reported beside precision. Order of work:
  the attributes Namshi and Noon listing files require first, then the rest. No "Confirm or Correct" per product (old
  initiative 08 cut).
- **Acceptance test:** on the frozen split, every released attribute shows precision at or above its bar and its
  coverage; a listing file built from them has no `unknown` value written as a guess.
- **Buy or build:** buy the vision and text model (same `vision.read` chain), build schema, precedence and measurement.

### M2-F4 Category and taxonomy mapping (P1)
- **Story:** as M9, I need each product's node mapped to each channel's category tree and its colour and pattern
  lists, so files are accepted.
- **Key requirements:** mapping tables as data (our node to channel category, our colour family to channel colour
  value); a classifier proposes a mapping for unmapped nodes; a mapping is used automatically when the harness shows
  it right at least 95% of the time on labelled pairs, else the node maps to the channel's nearest parent category.
- **Acceptance test:** at least 95% of golden products map to the category a channel manager would choose, on Noon,
  Namshi and Trendyol.
- **Buy or build:** buy the classifier (any `vision.read` or text model), build the tables (nobody has Namshi, Noon or
  Styli mappings).

### M2-F5 Listing quality score per marketplace (P1)
- **Story:** as an admin, I want one score per listing per channel so I can see where content is weakest and, later,
  where improvement pays.
- **Key requirements:** score = weighted share of M5 rules met (images, then text and attributes once M8 exists);
  weights start equal and are later replaced by measured lift from M4 and M10; stored per listing per day.
- **Acceptance test:** the score is computed for every live Namshi and Noon option and its distribution is shown on
  the ops page; a rule edit in M5 changes the next day's score.
- **Buy or build:** build (Rubick, Syndigo and Profitero are generic or US and not tied to lift).

### M2-F6 Web research for missing attributes (P2)
Looks up missing listing attributes on the brand's own site or public pages and proposes them with a source URL, as
trust state `usable` until the harness releases that source. Buy (search plus a model). Starts after M2-F3 shows which
attributes stay unknown most often.

### M2-F7 Market and category census (P2)
Brands, categories, product types and gallery norms on Namshi, Noon and Amazon.ae from bought public data (Actowiz,
DataWeBot, 42Signals), used to seed taxonomy nodes and gallery counts. Buy data; waits for the bought-data decision
after the first readout.

## 5. Operator experience
- **No screen of its own in P0.** The operator sees M2 only in the batch digest (M1): "All 450 products read. 3 read
  partly: the photo service refused them; they still got links." and the per-channel shot counts from M2-F2.
- **Product page (optional, never required):** each photo shows its shot name in plain words ("front to mid-thigh",
  "back to the hips", "not sure") and, when a head is cut, "Head cut between nose and lip". A small "Change shot" menu
  lets an operator correct it; nothing prompts them to.
- **Ops page (admin):** analyzer health: share of `unknown` per field this week, degraded readings, cost per product,
  and the release state of each field with its last measured accuracy.
- Copy rule: never a model name, a confidence number or a check code in operator text.

## 6. Measurement

| Metric | Baseline | Target | Source |
|---|---|---|---|
| Per-field accuracy on the frozen golden split (roles, taxonomy, head state, audience, pack, length) | not measured; today's classifier has 5 product types and no role | each released field at its bar (95%; kids and head cut 100%) | M7 harness report |
| Calibration error per field (answers at the floor vs their real accuracy) | none | within 5 points | M7 harness |
| Gap report agreement with a person | none | at least 95% of cells; zero false `filled` on cut heads | golden set and the audit |
| Share of photos with `unknown` role | none | under 5% of apparel photos | M0 `PhotoReading` |
| Analysis cost per product | about USD 0.0009 judge today (classification only) | at most USD 0.01 | M6 cost meter, stage `analyze` |
| Listing attribute precision and coverage (P1) | none | 90% precision per released attribute; coverage reported | M7 harness |
| Taxonomy coverage | 5 product types | all fashion nodes released; home, toys, beauty seeded `not_released` | M0 taxonomy table |

## 7. Build slices (one worker, one worktree each)

| # | Slice | Depends on | Acceptance test |
|---|---|---|---|
| M2-S1 | Taxonomy, attribute and shot-role tables as data, seeded for fashion (including M5's garment groups, `kids`, `multipack`, `unknown`); empty seeds for home (curtains, bedsheets), toys, beauty, hardline | none (first M2 merge; M5-S1 references its node ids) | A new node and attribute are added in settings and read by a test without code change |
| M2-S2 | Code measurements (R4-R8): size, background class and lightness, perceptual hash duplicates, OCR text share, primary colours, blur | M2-S1 | On the 300-row golden sample photos, every measured field is filled; duplicates found match a person's list |
| M2-S3 | People detector on the GPU service for head state and head-cut position (R9) | none (service work) | Head-cut test photos (forehead cut = cut; shoulder cut = none; nose-lip = cut) all pass |
| M2-S4 | One vision call per product (R10-R12) behind the M7 `vision.read` interface, replacing `qa/classify.ts`, with the caching key | M2-S1, M7-S2 | A batch makes one call per product; a rerun makes zero calls |
| M2-S5 | Ambiguity ladders and strictest plan (R13-R17) | M2-S2 to S4 | Unit tests per ladder step; the kids rule counts the inventory's kids products exactly |
| M2-S6 | Gap report and digest counts (M2-F2) from M5 policy rows | M2-S5, M5-S1 | Acceptance tests 4.2.9 1 and 2 |
| M2-S7 | Release states and calibration from the harness (R18-R19) | M7-S1, M7-S3 | A field below its bar stays `shadow` and is not used by the gap report |

## 8. Risks and open questions

| Risk | Effect | Mitigation |
|---|---|---|
| Golden labels slip (300 products need people) | Fields cannot be released; M3 crops wait | Label 100 first (M7 plan), release the fields that pass; crops run on code-measured head state |
| Vision models are weak on fine attributes (about 64% F1) | Wrong facts in listings | Decision fields first; listing attributes only when released per attribute; abstain otherwise |
| Vendor refuses lingerie and swimwear (Penti 756 options) | Many `unknown` readings on one brand | Second vendor in the chain; code measurements still run; the product still gets links |
| Analyzer version changes shift readings silently | Downstream drift | Version on every row; a new version must pass the harness before routing; nightly drift check (M7) |
| Strictest plan over-restricts (lingerie rules applied to tops) | Fewer on-model shots than allowed | Measured on the golden set; the share of strictest-plan decisions is on the ops page |
| Non-commercial licences (`bria-rmbg` is CC BY-NC 4.0) | Not usable once outside brands self-serve | Record licences; replace before M12 self-serve (raised for M3) |

Open questions are listed per feature above, each with a default.

## 9. Integration decisions (2026-11-02)

| # | Decision | Why |
|---|---|---|
| D1 | One taxonomy, owned by M2 (M2-S1). M5's category tree (M5-F1-R5) is the same table, not a second one; M5 and M12 edit it through M2's store | M2-F1-R1 and M5-F1-R5 each defined a category tree |
| D2 | M2-S1 has no dependency and merges first among M2 and M5 slices | It blocked M5-S1, M7-S1 and every M2 slice |
| D3 | M2-S3 (people detector) lives in `services/matting` and may run beside other M2 slices (the roadmap's named exception to one writer per module) | It shares no files with the other M2 slices and is on the holdout's critical path |
| D4 | "One admin approval" for a floor change means the owner role until M12 roles exist | Same rule in M2, M5, M7, M12 |
| D5 | Open questions answered: floors 0.7 and 0.8 before calibration; trust a specific master category but still read the image and flag disagreement; sibling rule off until 95% on the golden set; model input size set by the bake-off; P0 gap report covers shots only; gaps counted per option | Technical defaults |
