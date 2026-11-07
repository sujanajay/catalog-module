# DD4: Footwear and bags lifestyle image with scene rules (bucket B4)

Date: 2026-10-22. Deep dive DD4 of the Catalog Connect GCC program (bucket B4, re-opened by the owner on 2026-10-22).
Program: docs/plans/2026-10-21-catalog-connect-gcc-intent-map.md (sections 2, 3 and 6). Builds on
docs/plans/deep-dives/00-softline-taxonomy.md (taxonomy, roles LO and LS), 01-shot-roles-channel-compliance.md and
01a-channel-guidelines-external-vs-internal.md (channel rules), 02-derived-shots-fidelity-gate.md (checks G1 to G6),
03-on-model-generation-bake-off.md (generator, request shape, prices), 08-brand-style-profile-model-registry.md and
09-business-impact.md. Investigation only. Nothing here is built; SPEC.md is not edited (the wording in R7 is a draft for the owner).
Trial scripts and images live in the session scratchpad
`C:\Users\SUJANA~1\AppData\Local\Temp\claude\c--Users-Sujan-Ajay-Desktop-catalog-module\d63636f6-cfe2-4e73-8088-d201473357ee\scratchpad\dd4\`
(`inputs/`, `cut/`, `place/`, `outputs/`, `meta/` with `runs.jsonl` per request, `scripts/`, `sample/`, `sql/`). Model ids appear here as
technical facts only; none may reach UI copy.

Words used here:
- **Lifestyle image (role LS)**: the product in a real-looking place, worn or carried, or standing in a scene. DD0 role code LS.
- **Legs-only (role LO)**: the shoe worn, the frame cropped at or below the knee, no face.
- **Still life**: the product alone in a scene, no person.
- **Style-colour**: one design in one colour; one lifestyle image is made per style-colour, never per size.
- **Composite**: the brand's real product pixels cut out and placed into a generated scene, so the product cannot change.
- **Full generation**: an image model draws the whole picture, product included, from the brand's photos as references.

## Summary

1. The target is 1,222 style-colours: 1,146 footwear (USPA 529, Campus 406, Puma 106, Keds 105) and 76 bags (French Connection 63, Vero Moda 13). Campus option ids in master_sl carry a size code, so its 1,012 option ids are 406 style-colours. 85 of the 1,222 are kids' products.
2. Subcategory comes from the data, not from a sheet: no warehouse table has a filled `sub_category` (0 rows on all brands in dimensions.unified_sku_master_gcc). Trendyol, Noon, 6thStreet and Styli labels, read in DD0's order, give a footwear or bag subcategory for all but 4 style-colours. The largest groups are sneakers (838), running and sports (203), slip-ons and loafers (42), slides and slippers (33) and handbags (63). The Namshi full-listing sheet is not in the repo or the warehouse.
3. Naz's "lifestyle missing 99%" holds for real-world scenes: 1 of 48 sampled Trendyol option sets has one. But worn or carried studio photos are common: Puma 4 of 8, French Connection bags 7 of 8, Vero Moda bags 4 of 8. Every sampled Campus set has a styled studio prop shot. Keds and USPA have neither. So "when not to generate" is a real rule, not an edge case.
4. Channels: every channel with a public rule allows a lifestyle image only as an additional image, never as image 1. Noon says so in words; Amazon's footwear guides require a single left shoe on white for the main image and allow "environmental shots" as alternates. Trendyol caps a listing at 8 images, and Keds and Campus already carry 7.0 to 7.8 images there, so a lifestyle image must replace one (the size chart is the candidate) or it is silently dropped.
5. Trial: 17 billed images, 5 products (Campus, Keds, Puma, USPA, Vero Moda bag), 3 approaches. Spend 1.80 USD of the 20 USD cap for this deep dive.
6. Full generation with Nano Banana 2 (DD3's generator) made a worn, legs-only shot that matches Naz's ChatGPT benchmark on every footwear product: 6 of 6 kept the shoe, its colour and its logo positions. GPT Image 2 re-drew the USPA monogram as a different letterform. Both models changed the Vero Moda bag's silhouette when given only 1 reference photo. Nano Banana 2 ignored "keep the frame below the knee" on the men's slides.
7. The composite approach keeps product pixels identical (paste-back measured 0 difference on every opaque product pixel), but it makes still lifes only, not worn shots. The edit model alone changed 10% to 60% of the product's pixels by more than 24 of 255 before paste-back, so paste-back is mandatory. The lighting fit is weaker than with full generation.
8. Recommendation: Nano Banana 2 full generation for adult footwear and for bags with at least 3 reference views, gated by DD2's checks plus 4 scene checks. The composite still life is the product-locked fallback (kids, bags with 1 or 2 photos, embellished items, any product that fails the gate after the ladder). One 2K 3:4 frame per style-colour, cropped per channel by code, placed last on each channel, flagged `generated`, all reviewed until the exit numbers hold. Cost: 0.103 USD per attempt, 0.20 USD per accepted image (DD3's ladder figure), 244.40 USD for the whole backlog.

## Findings

### F1. Footwear and bag subcategories per brand (exact)

Sources and query shapes (BigQuery project opptra-datawarehouse, read only, 2026-10-22; scripts in `sql/` and `scripts/classify.py`):
- `dimensions.unified_sku_master_gcc`: `SELECT brand, category, COUNT(*), COUNTIF(sub_category IS NOT NULL AND TRIM(sub_category)!='') ... GROUP BY 1,2` over the 9 softline brands. `with_sub` is 0 on every row. `category` holds "Footwear" (Campus 9,336 rows, Puma 729), "DEFAULT" (Keds 5,301, USPA 10,980), "Shoes" (USPA 9,090), "SLIPPERS" (USPA 1,168), "BOOTS" (USPA 326), "Handbag" (French Connection 444), "Bags" (Vero Moda 7). These are channel-SKU rows, not options.
- `raw_gcc_dimensions.master_sl` (16,612 rows, 3,748 non-empty option ids) per option, joined to:
  - Trendyol `raw_gcc_table_cleaned.product_list_trendyol_3p_{uae,ksa}.category_name` on barcode = ean;
  - Noon `traffic_sales_noon_3p_uae.family/product_type/product_subtype` on partner_sku = master_sl.noon_ae (3,377 keys match; sku and sku_config match 0);
  - Styli `inventory_styli_3p_ksa.l2/l3/l4` on sku = master_sl.styli_sku (183 keys match);
  - 6thStreet `inventory_sixth_street_1p.item_class/item_subclass` on barcode = ean.
- The most frequent label per option and source was taken, then mapped to the DD0 subcategories. Precedence follows DD0: master_sl specific label, then Trendyol, Noon, 6thStreet, Styli, then keywords in master_sl.name.
- Department: footwear if any source names a footwear label or the brand is footwear-only (Campus, Keds, USPA); bags if any source names a bag label.

Totals: 1,752 footwear option ids (DD0 counted 1,744; the 8 Keds options DD0 left "unknown" are footwear here because Keds is footwear-only) and 76 bag option ids. Campus option ids carry a size code (for example `S1447B-03-G11` and `-G12`); stripping it gives 406 Campus style-colours, which matches the 408 distinct Campus image URLs in DD2. Other brands' option ids are already style-colours.

| Department | Subcategory (DD0) | Campus | Keds | Puma | USPA | French Connection | Vero Moda | Total style-colours |
|---|---|---|---|---|---|---|---|---|
| footwear.closed | sneaker | 197 | 100 | 67 | 474 | | | 838 |
| footwear.closed | running_sports | 169 | | 33 | 1 | | | 203 |
| footwear.closed | loafer_slip_on | 37 | 5 | | | | | 42 |
| footwear.closed | football | | | 4 | | | | 4 |
| footwear.closed | boot | | | | 10 | | | 10 |
| footwear.closed | lace-up comfort (Noon "oxfords_lace_ups") | 1 | | | | | | 1 |
| footwear.open | sandal | | | | 11 | | | 11 |
| footwear.open | slide_flip_flop and slipper | | | | 33 | | | 33 |
| footwear | unknown | 2 | | 2 | | | | 4 |
| bags | handbag | | | | | 55 | 8 | 63 |
| bags | shoulder | | | | | 6 | 5 | 11 |
| bags | clutch | | | | | 2 | | 2 |
| Total | | 406 | 105 | 106 | 529 | 63 | 13 | 1,222 |

Notes on the table:
- Campus is counted by style-colour, with the most frequent label across its sizes. 34 of the 406 Campus style-colours carry different labels on different sizes. At option-id level (sizes counted) Campus is sneaker 577, running_sports 200, loafer_slip_on 145, lace-up 2, unknown 88.
- Source of the label (footwear and bag option ids): Trendyol 1,461, Noon 220, master_sl 44, name keywords 13, none 90 (DD0's 309 Campus unknowns drop to 88 option ids, 2 style-colours, once Noon is read).
- Channels disagree on Campus: of 369 Campus option ids that Trendyol calls "Sneakers" and Noon also labels, Noon calls 161 "slip_ons" (`footwear/loafers_slip_ons/slip_ons`). For scene choice both are casual, so the disagreement does not change the scene; it is flagged as DD0 already proposes.
- Kids (no person in the scene, see F4): USPA 49 (gender "kids", "boy", "girl"), Puma 31 (names with "Jr", "Inf", "PS", "AC"), Campus 5. Total 85.
- Gender per style-colour: Campus 233 men, 148 women, 20 unisex, 5 kids; Keds 105 women; Puma 14 men, 33 women, 59 unisex; USPA 249 men, 231 women, 49 kids; French Connection and Vero Moda bags all women.
- The Namshi full-listing sheet that Naz named as the subcategory source (transcript 26:07) is not in the repo, the meetings folder or the warehouse (DD0 open item 16). The data above makes it optional for B4; it stays useful as a cross-check.

### F2. Do lifestyle images already exist? (sample, by eye)

Method: 8 random options per group from `gcc_channel_reports.product_list_trendyol_3p_uae` (latest file_date per option), all images 1 to 8 downloaded, read as contact sheets (`sample/all_*.jpg`, `sample/manifest.csv`). Trendyol serves every image at 1200x1800.

Trendyol image counts per option (same table, all footwear and bag options): Campus 7.03 to 7.18 by subcategory (380 options), Keds 7.82 to 8.00 (169), Puma 6.00 to 6.52 (107), USPA 4.82 to 5.93 (549), French Connection bags 3.50 to 7.69 (63), Vero Moda bags 2.00 to 2.50 (12).

| Group (8 options each) | Real-world scene | Worn or carried, studio | Styled studio set, no person | Packshots only |
|---|---|---|---|---|
| Campus | 0 | 0 | 8 (props: ladder, chair, blocks, coloured backdrops) | 0 |
| Keds | 0 | 0 | 0 | 8 (1 has an insole infographic) |
| Puma | 1 (cricket pitch) | 4 (legs-only or full model) | 0 | 4 |
| USPA | 0 | 0 | 0 | 8 |
| French Connection bags | 0 | 7 (model carrying the bag) | 0 | 1 (crystal clutch) |
| Vero Moda bags | 0 | 4 | 0 | 4 (1 or 2 images in total) |
| Total (48) | 1 | 15 | 8 | 25 |

Reading: Naz is right that a real-world lifestyle image is almost never supplied (1 of 48). But 15 of 48 sets already show the product worn or carried, and every Campus set has a styled studio shot. Whether these count as "lifestyle" decides how many products need a generated one; it is an owner question (Q2). The meeting itself notes that Campus and kids lifestyle images sometimes arrive later (transcript 23:44), so generation must also stop when a real one appears.

### F3. What the meeting asked for (transcript, meetings_folder/Catalog-Module-Connect-GCC-14e47c7c-2580.md)

- 18:20 to 21:57: footwear and handbags are the other categories. Naz wants a packshot with shadow, a model image focused on the product, a lifestyle image, and an infographic; the lifestyle image is "more catchy". The Birkenstock Arizona on a UAE marketplace is the visual reference (program doc section 2).
- 23:44: "Generally it is not there. 99%"; generate only when it is missing.
- 24:46 to 25:21: the scene depends on the subcategory: a formal shoe near an office, a casual loafer on a street or a beach, sneakers, sports and running shoes each in their own setting.
- 28:04 to 30:31: her ChatGPT benchmark is a plain Campus shoe given with a short prompt; "it's a leg model, it will only show a leg"; "the campus logo and everything is visible"; she can ask for "no face"; she then asks for a Namshi-sized or Trendyol-sized version, or a plain background "as Amazon". ChatGPT limits her to 5 or 6 images a day.
- 30:46: the same channel conditions apply, with a model wearing the product and a lifestyle background.

The benchmark Naz accepted therefore has five properties the trial reproduces: legs only, no face, seated on a concrete ledge, logo legible, cropped at the knees.

### F4. Scene rules per subcategory (proposal)

Rules that apply to every scene:
- Setting plausible for a modern UAE or Saudi city: plazas, cafe terraces, waterfront paths, hotel lobbies, offices, pool decks, desert-toned stone. No real landmarks or recognisable skylines, no readable signs or text, no other brands, no alcohol, no religious buildings, no flags.
- No faces in any scene. Legs-only frames end at or below the knee. Bag frames run from shoulder to hip.
- Modesty: women's legs covered to the ankle (wide-leg trousers, maxi skirt or dress, full-length tights); men's knees covered except on pool or beach scenes, where the frame stops below the knee. Long sleeves on any visible arm in women's bag shots. Bare feet only for open footwear.
- Kids: never a generated child. A still life only (composite), or no lifestyle image.
- The product stays whole and inside the centre square of the 3:4 frame, so every channel crop keeps it (R4).

| Subcategory | Style-colours | Scene (worn) | Scene (still life fallback) | Styling and modesty |
|---|---|---|---|---|
| sneaker | 838 | Legs-only, seated on a concrete ledge or walking in a modern plaza, late afternoon (Naz's benchmark) | Pair on a concrete ledge or steps | Men: slim joggers or chinos to the ankle. Women: wide-leg trousers to the ankle |
| running_sports | 203 | Legs-only, mid-stride on a waterfront running path or track at sunrise | Pair on a running track edge | Full-length tights or track pants |
| loafer_slip_on | 42 | Legs-only on a cafe terrace or a marble lobby; formal styles near an office entrance | Pair on light stone paving | Tailored trousers to the ankle |
| football | 4 | Legs-only on a floodlit artificial pitch, ball at the foot | Pair on turf | Full socks, shorts hem out of frame |
| boot | 10 | Legs-only on desert-toned stone steps or an evening street | Pair on stone | Trousers over or tucked into the boot |
| lace-up comfort | 1 | As loafer | As loafer | As loafer |
| sandal | 11 | Feet-only on a pool deck or a beach boardwalk | Pair on wooden decking | Frame from mid-calf down; women: maxi hem visible |
| slide_flip_flop, slipper | 33 | Feet-only on a pool deck (slides) or a bedroom rug (home slippers) | Pair on decking or rug | As sandal |
| unknown | 4 | None until the subcategory is known | Neutral studio still life | n/a |
| handbag, shoulder | 74 | Carried on the shoulder in a hotel lobby, cafe or boutique street, shoulder to hip | On a marble side table or a cafe table | Long-sleeve modest dress or abaya-style coat; no face |
| clutch | 2 | Held at the waist in an evening lobby | On a marble console | As above |
| any, age = kids | 85 | None | Still life only | n/a |

The table is a starting point. DD8's brand style profile is where a brand overrides it, for example Puma always sport, French Connection always city. Per DD8 the profile is versioned and owner-approved, so no per-brand code is needed.

### F5. Channel acceptance and slot of a lifestyle image (repo first, then external gaps)

What the repo encodes (`packages/core/src/catalog/channels.ts`, `compliance.ts`, worktree of main at `db716b3`):
- No role and no slot concept: output n equals source n (DD1 F1). `backgroundFor(id, shotNumber)` gives Amazon and Shein a white first image and every other image `#E0E0E0`.
- `compliance.ts` `checkOutput` fails `background` and `inside_safe_box` when any pixel outside the product mask differs from the canvas colour by more than `BG_TOLERANCE` 24. A full-frame scene fails both checks by design, on every channel.
- A brand's own lifestyle photo is held today: the matte guard reads busy scenery as `leftover_background` and holds the photo (`matte-guard.ts` around lines 974 and 1029, `auto-resolve.ts` `busyBackgroundHold`; spec 10 eval run 2 defect A1, the tennis-court lifestyle photo). So the module cannot publish any lifestyle image today, supplied or generated.

Per channel (verified sources from DD1 and DD1a; new sources marked):

| Channel | Lifestyle allowed | Slot | Source and status | Other limits that bite |
|---|---|---|---|---|
| Noon | Yes, as an additional image | Last: sequence "Front, Back, Side, Any other angles, Details, Usage"; "Lifestyle images are not permitted for the primary images" | Noon help centre (official, DD1a E1) | "Only photographs are permitted" (no illustrations); whether a generated photograph counts is not stated. No logos, watermarks or text |
| Namshi | Not published | Assume Noon (the repo already treats Namshi as "= Noon rules") | Secondary only (Streamoid) | |
| Trendyol | Not published | Assume additional only | Secondary only | Cap of 8 images (DD1a E5). Keds and Campus already average 7.0 to 7.8 on Trendyol, so an LS image must replace one (size chart is the candidate) |
| 6thStreet | Not published (vendor portal) | Unknown | Ask the account manager | |
| Amazon (.ae, .sa) | Yes, as an alternate | Never MAIN. Amazon.ae "Shoes, Handbags & Shoe Accessories" guide (Dec 2018): "MAIN image must show only ONE and LEFT shoe", "must not be shot with a human model". US Shoes guide (2019): alternates may show "environmental shots" | https://m.media-amazon.com/images/G/39/help/Shoes_and_Handbags_Styleguide_EN_AE._CB1198675309_.pdf and https://m.media-amazon.com/images/G/01/AMAZON_FASHION/SHOES/Shoes_StyleGuide.pdf (official, new in DD4) | Cap of 9 images. Secondary report (July 2026): photorealistic AI people need the `contains-synthetic-performer` keyword in XMP dc:subject (New York law); not verified on an Amazon page |
| Styli | Not covered by the studio email (apparel only) | Unknown | Owner's email (DD1a E9) | 2342x3123 canvas with guides; a full-frame scene ignores the guides |
| Centrepoint | Not published (Landmark portal) | Unknown | Ask | 3000x3000 in the repo (unverified, DD1a) |
| Shein | Not published | Assume additional only | Secondary (EU guide) | Cap of 10. Shein's AI content policy bans AI imagery that misrepresents the item (official page, mainly Shein's own content) |
| VogaCloset | Not published | Assume additional only | Secondary (Tradebyte) | Cap of 10, minimum 4 |

Reading: LS is never image 1 on any channel, and it is the last image wherever an order is published. No channel bans AI-generated images outright; Amazon may need a metadata label for synthetic people and Noon's "only photographs" is ambiguous (owner question Q4). The Amazon footwear MAIN rule (single left shoe, three-quarter view, toe left) is a packshot rule outside this bucket; DD1's role order should carry it.

### F6. Trial (5 products, 3 approaches, 17 billed images)

Products, all from Trendyol UAE (public CDN, read only, `meta/inputs.json`, 1200x1800):
- Campus "Men Glitch Memory Foam Lace-Up Running Shoes - Black" (`22G-1329_GLITCH_Blk-Red`), the same black-shoe case as Naz's benchmark.
- Keds "Women's Champion Canvas Lace Up Casual Sneaker Pink" (`KW-CHAMP-2D_Neon Pink_OD`), a colour and small-label test.
- Puma "Evoflex Strong Gray" running shoe (`31110903 Strong Gray_OD`), formstrip and tongue label test.
- USPA men's black slides (`MATIS GLB 6FX MEN OD_BLACK`), large white monogram, bare feet.
- Vero Moda "VMMARLA Braided Bag" (`VM_10350639_OD_Chocolate Torte`), the only image of its listing, weave texture test.

Approaches (prompts in `scripts/genjobs.py`, runner `scripts/run.js` copied from DD3, every request `POST /api/v1/images`):
- A1 full generation, Nano Banana 2 (`google/gemini-3.1-flash-image`, 2K, 3:4): 3 to 4 product photos as references (1 for the bag), product described, the scene from F4, the common rules, and "do not add, remove, move, mirror or restyle any logo, label, print or text". Repeated once on Campus and Keds.
- A2 the same request on GPT Image 2 (`openai/gpt-image-2`, 1536x2048, quality medium), the model family behind Naz's ChatGPT benchmark. A3 the Campus request once on Nano Banana Pro.
- B composite: the product cut out (a flood-fill matte, a stand-in for the matting service, `scripts/matte.py`), placed on a 1536x2048 grey canvas (`place/`), Nano Banana 2 asked to replace only the grey with the scene and add a contact shadow, then the real cut-out pasted back by code at the same place (`scripts/pasteback.py`). USPA was left out: the flood fill lost the white monogram on the light grey background, the hard case the production matte guard exists for.

Judging: by eye on `meta/judge_*.jpg` and the zoomed crops `meta/zoom_*.jpg`, against DD2's checks; paste-back measured in `meta/pasteback.json`.

| Approach, product | Product identity and logo | Colour | Scene and framing | Verdict |
|---|---|---|---|---|
| A1 Campus (2 runs) | Same shoe, red accents and side text in place | Black kept | Seated on a concrete ledge, cropped at the knees, no face: matches the benchmark | Pass |
| A1 Keds (2 runs) | Small side label and blue heel tab kept | Hot pink kept | Cafe terrace, cream wide-leg trousers to the ankle | Pass |
| A1 Puma | Formstrip and "PUMA" tongue label legible and correct | Greys kept | Waterfront at sunrise; the skyline looks like a real Gulf city skyline (landmark rule at risk) | Pass on product, hold on scene |
| A1 USPA | Monogram close to the source letterform | Black kept | Pool deck; the frame shows the legs up to navy swim shorts above the knee, against the prompt | Pass on product, hold on framing |
| A1 Vero Moda bag (1 reference) | Weave kept, but the body became trapezoid and the handle a single shoulder strap | Brown kept | Hotel lobby, modest long-sleeve dress, no face | Fail (wrong product shape) |
| A2 Campus, Keds, Puma | Same shoe; labels kept | Kept | Same scenes; slightly more staged | Pass |
| A2 USPA | Monogram re-drawn as a different letterform | Kept | Legs shown above the knee | Fail (logo changed) |
| A2 Vero Moda bag | Body became pentagonal, strap thinner | Kept | Lobby, modest | Fail (wrong product shape) |
| A3 Nano Banana Pro, Campus | Same shoe | Kept | Benchmark scene | Pass, but delivered 896x1200 although 2K was requested (billed 0.139 USD) |
| B composite, Campus, Keds, Puma, Vero Moda bag | Identical by construction: 0 difference on every opaque product pixel after paste-back | Identical | Still life on a ledge, a cafe floor, a running track, a marble table. A pale fringe at the base from the crude matte (Campus, bag); the product lit flatter than the scene; Keds the most convincing | Pass on fidelity, weaker on realism |

Measured on the composite before paste-back (product region of the raw edit output against the cut-out): mean absolute change 20.8 (Campus), 33.1 (Keds), 14.3 (Puma), 11.4 (bag) of 255; share of product pixels changed by more than 24: 26.4%, 60.1%, 14.1%, 9.6%. An edit model asked to "keep the product exactly" still relights and redraws it; only the paste-back locks it.

Findings that hold across the trial:
- Footwear logos are large, structured marks. Nano Banana 2 kept them in place on 6 of 6 footwear outputs; GPT Image 2 changed 1 of 4 (the monogram). DD2's G2 check (OCR and template match on `detailFeatures` regions) is the one that would have caught it.
- Bags with one reference photo are not safe to generate in full: both models invented a new silhouette. Shape needs at least front, side and back views, or the composite.
- Instructions about framing are followed loosely (USPA). The framing rule (frame at or below the knee) must be checked by code on the output, not trusted to the prompt.
- Scene safety (landmarks, signs) needs its own judge question; the Puma skyline is the example.
- Output size: Nano Banana 2 at 2K is 1792x2400 on every request; GPT Image 2 is 1536x2048; Nano Banana Pro returned 896x1200 on a 2K request.
- Latency 22 to 47 s per image (`runs.jsonl` `ms`). No request was refused or moderated.

### F7. Locking product truth: what each method can promise

| Method | Product pixels | Logo and colour | Worn shot possible | What checks it |
|---|---|---|---|---|
| Composite (real cut-out into a generated scene, paste-back) | Identical | Identical | No (still life only; a shoe cannot be pasted onto a generated foot convincingly) | Code: pixel equality on the mask; judge for realism (scale, shadow, light) |
| Full generation with references | Redrawn | Usually kept on footwear, at risk on monograms and small text; shape at risk on bags with few views | Yes | DD2 G1 identity, G2 logo and text, G3 colour, G4 texture, plus the scene checks in R3 |
| Edit model asked to keep the product, no paste-back | Redrawn (10% to 60% of pixels changed in the trial) | At risk | Limited | Same as full generation; no advantage |
| Generate the worn shot, then paste the real shoe over the generated shoe | Partly real | Real where pasted | Yes in principle | Needs pose-matched packshots and warping; the side angle of a worn shoe rarely matches a packshot. Not trialled, not recommended |

### F8. Options for the generator

Prices are list prices read 2026-10-22 (vendor page or OpenRouter endpoint) or the `usage.cost` OpenRouter returned in this trial. Context7 was not available in this session (no Context7 tool was offered), as in DD1a, DD2 and DD3; every API fact comes from the vendor page named or the OpenRouter responses saved in `meta/`. Any build must re-check the docs with Context7 first, per the repo rule.

| Option | What it is | Price per image (USD) | Fit | Trade-offs |
|---|---|---|---|---|
| O1 Nano Banana 2 full generation through OpenRouter (DD3's generator) | Worn or carried scene from 3 to 4 reference photos | 0.1032 observed at 2K with 4 references (0.1015 with 1); 0.151 list at 4K | Worn shots that match Naz's benchmark; one request shape, `usage.cost`, key and spend caps already in the module | Redraws the product: the gate decides; bags need 3+ views; framing and scene rules need code and judge checks |
| O2 Composite with an edit model making the scene around the placed cut-out, then paste-back (Nano Banana 2) | Still life with locked pixels | 0.1015 observed | Product truth guaranteed by code; uses the module's own matte, sole-strip recovery and contact shadow | No worn shot; light mismatch; the matte quality shows at the base |
| O3 Buy a scene-around-product API | Bria Product Shot "lifestyle by text" 0.032 (bria.ai/pricing; on fal.ai 0.04); Stability "Replace Background and Relight" 0.08 (8 credits, docs.stability.ai/pricing); Photoroom Image Editing API Plus 0.10 (photoroom.com/api/pricing); Claid AI Photoshoot about 0.24 (4 credits at 59 USD per 1,000 credits); Pebblely not published (secondary 0.05 to 0.20); Picsart not published; Vertex Imagen Product Recontext 0.12 (preview, 1024x1024 only, regenerates the product) | 0.032 to 0.24 | Still life only, like O2; none of them makes a worn shot from packshots. A second vendor account, key and data-processing review; Bria offers capped indemnity on pay-as-you-go | Not trialled (no account or key). Bria is the one to re-test if composite volume grows, at a third of O2's price |
| O4 Open weights on the L4 GPU (services/matting pattern) | FLUX.2 klein 4B (Apache-2.0, about 13 GB) for scene plates; IC-Light v1 (Apache-2.0, SD1.5 class; its bundled RMBG-1.4 remover is non-commercial and would be replaced by our BiRefNet) to relight a composite | GPU time only, 0.00034884 USD per second on the L4 (spec 11) | Fits the existing GPU service shape (`/matte`, `/convert`, `/upscale` today in `services/matting/app.py`) | Not trialled. DD3 found FLUX 3 klein weaker on identity; FLUX.1 Fill and Kontext dev need a paid BFL licence for production; IC-Light v2 has no open weights. Revisit for O2 relighting only |
| O5 GPT Image 2 as primary | Naz's ChatGPT model family | 0.080 to 0.117 observed | Good scenes | Re-drew the USPA monogram; 1536x2048 needs the upscaler for Styli and Centrepoint; DD3 found head cuts. Keep as a second opinion only |
| O6 Keep the manual route | Naz with ChatGPT, 5 to 6 images a day (transcript 28:40) | Her time | Works today | Does not reach 1,222 style-colours; no gate, no record |
| MCP or plug-ins | fal.ai official MCP (`mcp.fal.ai/mcp`) reaches Bria, IC-Light v2 and FLUX Kontext; Photoroom has an official MCP connector | as O3 | A route to try O3 vendors from a desktop, not a pipeline component | Not for the Cloud Run path |

Build vs buy on cost and fit: the per-image price (0.03 to 0.12) is small next to the agency's INR 60 per style (about 0.71 USD at INR 84) in every option. Fit decides: only full generation makes the worn shot Naz asked for, and only the composite locks the pixels. So buy the generator (O1, as DD3 already decided), build the composite path from parts the module already has (O2), and keep O3 Bria as the cheaper scene maker to re-test if the fallback becomes the main path. Open weights (O4) stay a later option for relighting.

### F9. What catalog-module reuses and what is new (repo evidence, main at db716b3)

Reused as is:
- Footwear matte and shadow: `packages/core/src/catalog/qa/policy.ts` `DEFAULT_POLICIES.footwear` and `bag_accessory` (`shadowMode: "preserve_else_synthesise"`), `shadowSynthesisAllowed` (footwear, bag_accessory, other only); `packages/core/src/catalog/shadow.ts` (`SHADOW_SYNTH_INTENSITY_GREY` 0.25, `SHADOW_SYNTH_INTENSITY_WHITE` 0.15); `apps/worker/src/catalog/chunk.ts` line 185 (`handRule` on for non-apparel, `soleStrip` for footwear); `packages/core/src/catalog/matte-guard.ts` around line 839 (sole strip recovery). The composite path needs exactly this cut-out and contact shadow.
- Policy lookup: `resolvePolicy` (brand, category) fallback in `policy.ts`; a lifestyle scene preset can hang off the same row (DD8's `style_profile_id`).
- Render, compliance and publish: `render.ts` `renderSource` (line 545) and its pass-through path (around line 579) already place a whole frame without a matte; `planCanvas`, the x2 upscaler and the JPEG encoder apply unchanged; `compliance.ts` keeps `magic`, `bytes`, `extension`, `format`, `dims`, `density`; the publish contract, naming and links sheet stay.
- LLM layer and caps: `packages/core/src/llm/openrouter.ts` (`chatCompletion` line 179 already parses `message.images` at line 201; DD3's `createImage` against `/images` is the one new call); `packages/core/src/catalog/qa/caps.ts` (`DAILY_SPEND_CAP_USD`, default 10, and the per-batch cap). The backlog at 0.20 per accepted image is 244.40 USD, so the daily cap paces a backfill unless the owner raises it.
- Fidelity gate: DD2's G1 to G6 and its hold flags, `gen_key`, review-all and the ladder; DD3's request shape and regeneration ladder.

New for B4:
- A role LS (and LO) on `catalog_outputs` (DD1's role model) and a rule that LS is placed after every brand photo, never image 1.
- A full-frame render mode for LS: crop the 3:4 frame to each channel's aspect around the product box (cover, never pad with grey), then the normal encoder. `compliance.ts` skips `background`, `inside_safe_box`, `styli_anchor` and `noon_wide` for LS only.
- The `leftover_background` hold must not fire on an LS output; a brand-supplied lifestyle photo would also need an explicit LS route instead of today's hold.
- Scene checks (R3) and the scene table (F4) as data in the style profile.
- Per-channel slot handling where a cap is reached (Trendyol 8, Amazon 9).

## Options (summary)

| Option | Cost per accepted image (USD) | Worn shot | Product truth | Verdict |
|---|---|---|---|---|
| A. Full generation only (O1) | about 0.20 with the ladder | Yes | Gated, redrawn | Not alone: bags with few photos and kids have no safe path |
| B. Composite only (O2) | about 0.10 to 0.20 | No | Locked | Not alone: does not give Naz the worn, catchy shot she asked for |
| C. Full generation first, composite fallback (O1 plus O2) | about 0.20 | Yes where safe | Gated or locked | Recommended |
| D. Buy a scene API for the fallback (O1 plus O3 Bria) | 0.032 to 0.04 for the fallback | Yes where safe | Gated or locked | Re-test only if fallback volume grows; a second vendor today buys little |
| E. Manual (O6) | Naz's time | Yes | Unchecked | No |

## Recommendation

R1. Scope and the "do not generate" rules. One LS image per style-colour for adult footwear and bags. Do not generate when:
1. any source photo of the style-colour is already a lifestyle or worn or carried photo (the judge's role, DD1; the owner decides in Q2 whether studio worn or carried photos count, F2);
2. the product is for kids (85 style-colours): still life composite only, never a generated child;
3. the footwear subcategory is unknown (4 style-colours): wait for data or the owner's override;
4. a bag has fewer than 3 distinct views, or the product is embellished, transparent or mirror-like (crystal clutch): still life composite only;
5. the brand's style profile switches lifestyle off (DD8);
6. every ticked channel is at its image cap and the owner has not named a photo LS may replace (Q3);
7. the source photos are below the module's floor (`small_source`) or held: the references must pass first;
8. a real lifestyle image arrives later: the generated one is retired at the next run (the brand's photo wins).

R2. Method per product:
- Adult footwear: full generation (O1) with the scene from F4; on two failed gate attempts and a failed Nano Banana Pro attempt (DD3's ladder), fall back to the composite still life; if that also fails, the product is held with a reason.
- Bags with 3 or more views: full generation, carried scene. Bags with 1 or 2 views, kids and embellished products: composite still life only.
- References: the brand's packshots of the same style-colour, side view first, then pair, top and heel, with the size chart and infographics excluded (the judge's `chart` view already marks them).

R3. Gate: DD2 G1 to G6 on the product region (the region located by the matte model run on the generated frame, then compared with the brand's packshot of the nearest view), plus four scene checks:
- S1 framing by code: no face (judge plus a face detector on the frame), the frame top at or below the knee for legs-only, shoulder to hip for bags.
- S2 modesty by judge: the F4 coverage rules.
- S3 scene safety by judge: no readable text, other brands, landmarks or skylines, alcohol, religious buildings or flags.
- S4 crop safety by code: the product box inside the centre square of the 3:4 frame with a 5% margin, so every channel crop keeps it whole.
Composite outputs skip G1 to G4 (pixels are identical, proved by code) and keep S2 to S4 plus a realism question (scale, shadow, light). Every LS output is flagged `generated`, carries `gen_key`, and stays in review-all until DD2's exit numbers hold on at least 100 labelled LS images across at least three brands (LS is one image per product, so the 300 of DD2 is not needed).

R4. One frame, cropped per channel. Generate once at 2K 3:4 (1792x2400). Crop by code: Noon and Namshi 0.73 (1751x2400), Trendyol 2:3 (1600x2400), Styli 3:4 (enlarged 1.30x to 2342x3123), 6thStreet and VogaCloset 3:4 (1.11x), Amazon and Shein 1:1 (1792x1792, 1.12x), Centrepoint 1:1 (1792 to 3000, 1.67x: the existing x2 upscaler, or 4K at 0.151 USD where Centrepoint is ticked). No grey padding, no guides, no white first image (LS is never first).

R5. Slot: LS is always the last image on every channel. Where a channel is at its cap (Trendyol 8, Amazon 9, Shein and VogaCloset 10), LS replaces the size chart only if the owner says so (Q3); otherwise LS is not sent to that channel and the links sheet says "Not added: this marketplace already has its maximum number of photos".

R6. Cost for DD9: 0.1032 USD per full-generation attempt, 0.1015 per composite attempt, 0.20 per accepted LS image with the ladder; backlog 1,222 style-colours = 244.40 USD once at 0.20 (126.11 at one attempt each); gate compute about 0.0004 per image (DD2). Kids, unknown and capped products reduce this.

R7. SPEC.md amendment (draft; the owner edits SPEC.md). In "Non-goals", replace

> - No lifestyle-background option and no "four options" variant; only what the sheet specifies.

with

> - No lifestyle-background option except one lifestyle image (role LS) per footwear or bag style-colour under spec <nn>: made only when none of the brand's photos of that style-colour is a lifestyle, worn or carried photo; only by a generator the owner has approved in writing; worn or carried scenes only for adults, with no face and the modesty and scene rules of the brand's style profile; a still life of the brand's own cut-out pixels for kids and for products with too few photos; always gated by the spec 12 checks plus the scene checks; flagged `generated`; placed after every brand photo and never as image 1; held for a person until the spec <nn> exit numbers are met and recorded here. No "four options" variant.

and add to the cropping bullet (as amended by DD2 R4): "A generated lifestyle frame is cropped to each channel's aspect around the product, which stays whole; this is the only crop of a generated frame." Add a row to the models table: "Lifestyle image (spec <nn>): the generator of spec 12 (owner-approved), conditioned on the brand's packshots; composite fallback uses the module's own matte and contact shadow; cost per accepted image recorded in the cost ledger."

## Depends on earlier DD answers

The recommendation assumes every earlier deep dive's recommendation is approved. What changes if the owner answers differently:

| Earlier answer | If approved (assumed) | If not |
|---|---|---|
| DD0 taxonomy and data-first classification | Scene keyed on the subcategory from data (F1) | Scene keyed on the product type only (one footwear scene, one bag scene), or on the Trendyol label read directly; the 838 sneakers are unaffected, the other 308 footwear style-colours get a generic scene |
| DD0 open item 8 (legs-only in B2/B3 or B4) | LO is made here as the worn LS shot | If LO moves to B3, the worn shot is B3's and B4 keeps only still lifes and carried bag scenes |
| DD0 open item 7 (kids) | No generated children; still life only | If generated children are allowed, 85 more style-colours get worn shots, with stricter review |
| DD1 roles and reorder (option B) | LS is a role, placed last, never first | Without roles, LS is appended after the last uploaded photo, and the "already has a lifestyle photo" rule (R1.1) cannot be read from the judge; the operator must tick it per product |
| DD1a caps and slot rules | R5 replaces or skips at the cap | Without caps encoded, LS can be silently dropped on Trendyol and Amazon, the gap DD1a ranked second |
| DD2 gate and exit numbers | R3 reuses G1 to G6 plus S1 to S4 | Without the gate, full generation stays review-all forever; only the composite path (pixel-exact) could leave review on code checks alone |
| DD3 generator (Nano Banana 2 via OpenRouter) | O1 as specified | Another generator changes prices and the trial evidence; GPT Image 2 would fail the monogram case in F6; a direct Gemini API key changes only the client, not the planner |
| DD8 style profile and model registry | Scene table and modesty rules live in the profile, per brand | Scene rules become one global table in code; no brand override. Legs-only needs no brand model; a brand that wants its own models' legs depends on DD8's registry and rights |
| DD9 money model | B4 enters at 0.20 per accepted image | Numbers shift with any change to DD3's price |

## Approval question

Do you approve, as the basis for a B4 spec: (a) one lifestyle image per adult footwear and bag style-colour, made by Nano Banana 2 full generation (worn legs-only or carried, no face, the F4 scene and modesty rules keyed on subcategory) with the composite still life of the brand's own cut-out as the fallback and the only path for kids and for bags with fewer than 3 photos; (b) the "do not generate" rules in R1; (c) DD2's gate plus the four scene checks, review-all until 100 labelled lifestyle images meet DD2's exit numbers; (d) one 2K frame cropped per channel, placed last and never as image 1; (e) 0.20 USD per accepted image (244.40 USD for the 1,222 style-colour backlog) as the number DD9 uses; and (f) the SPEC.md wording in R7?

Open items only the owner can answer:
- Q1. The Namshi full-listing sheet: still wanted as a cross-check for subcategory, given the data covers all but 4 style-colours?
- Q2. Do studio photos of the product worn or carried (Puma, French Connection and Vero Moda bags) and Campus's styled studio sets count as "lifestyle already present", or should those products also get a real-world scene?
- Q3. On channels at their image cap (Trendyol 8, Amazon 9), may the lifestyle image replace the size chart, or should it not be sent there?
- Q4. Do you or Naz know whether Noon ("only photographs are permitted"), Amazon (synthetic-performer label) or any GCC channel requires a label on, or refuses, generated images? Should every generated image carry an embedded "AI-generated" metadata tag by default?
- Q5. Does each brand (Campus, Keds, Puma, USPA, French Connection, Vero Moda) allow generated lifestyle imagery of its products under Opptra's written rights (DD8's rights record)?
- Q6. Lifestyle rules for 6thStreet, Styli, Centrepoint, Shein and VogaCloset are not public: can Naz ask the account managers, or share portal screenshots?

Trial spend: 1.80 USD (1.8016 by per-response `usage.cost`: Nano Banana 2 11 images 1.1257, GPT Image 2 5 images 0.5365, Nano Banana Pro 1 image 0.1394). The account counter (`GET /api/v1/key`) moved 38.2919 to 39.8906 (1.5987) over the same window; other deep dives share the key, so the per-response figure, the higher one, is reported. Cap for this deep dive 20 USD.

Status: done, awaiting owner answer
