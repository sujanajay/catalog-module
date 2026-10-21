# DD0: Softline category taxonomy and product classification

Date: 2026-10-22. Deep dive DD0 of the Catalog Connect GCC program (foundation for B1, B2, B3).
Investigation only; nothing here is built.

## Summary

1. The warehouse master (raw_gcc_dimensions.master_sl) holds 9 softline brands, 16,612 SKUs, 3,748 option ids. Anta is not in any warehouse table; GTPlayer is hardline (gaming and office chairs).
2. master_sl.category_name is unusable on its own: 4,541 SKUs say "Default" and many more say only "Apparel", "Footwear" or the brand name; no table has a filled sub_category.
3. Trendyol's category, joined on EAN, gives a specific category for 3,315 of 3,748 options (88%). With master_sl's own specific labels, only 71 options stay fully unknown, plus 309 Campus shoes with no footwear subcategory.
4. Today the catalog module never reads any category data. It asks a vision model to sort photo 1 into 6 product types that mix "what it is" with "how it is shown" (apparel on model vs laid flat). There is no subcategory, gender or age, and the model's confidence score is ignored.
5. Proposal: one taxonomy of 4 departments, 14 categories and their subcategories, with gender and age as separate tags. Categories come from the data first, then the vision model when the data has nothing, and the owner can always override. The 6 product types stay as the internal matting key and are derived from the new categories.
6. A per-category handling matrix says which of the 8 shot roles apply and whether each role can be cut from an existing photo (cropping, in B2) or must be generated (B3). Footwear, bag and accessory scenes stay deferred to B4.
7. Of the 3,748 options: 1,746 apparel, 1,744 footwear, 76 bags, 25 accessories, 86 home fragrance (French Connection candles and sprays), 71 unknown.
8. 16 points have no agreed handling and need an owner answer. The largest are bottoms and dresses (250 and 154 options) and lingerie, sleepwear and swimwear (551 options, nearly all Penti).
9. Approval asked: the taxonomy and the handling matrix.

## Findings

### F1. Brands and coverage in the warehouse (exact)

Query shape: `SELECT alias_gcc_brand(brand), family_of_gcc_brand(...), COUNT(*), COUNT(DISTINCT option_id_style_color), COUNTIF(category_name IS NULL OR '' OR 'Default') FROM raw_gcc_dimensions.master_sl GROUP BY 1,2`.

| Brand | Line | SKUs | Options | SKUs with no usable category_name (null, empty, "Default") |
|---|---|---|---|---|
| French Connection | softline | 4,343 | 900 | 391 |
| Penti | softline | 3,290 | 616 | 1,785 |
| USPA (U.S. Polo Assn.) | softline | 2,974 | 529 | 1,326 |
| Campus | softline | 1,792 | 1,013 | 25 |
| Vero Moda | softline | 1,207 | 121 | 528 |
| Puma | softline | 972 | 190 | 0 |
| Nautica | softline | 848 | 159 | 766 |
| Keds | softline | 673 | 106 | 673 |
| Cardio Bunny | softline | 513 | 119 | 0 |
| Total | | 16,612 | 3,753 (3,748 with a non-empty option id) | 5,494 |

- The "Default" label alone covers 4,541 SKUs (French Connection 134, Keds 671, Nautica 766, Penti 1,644, USPA 1,326). That matches the figure in the brief.
- Other vague labels that do not name a garment: "Apparel" (French Connection 2,505 SKUs, Puma 369), "Footwear" (Campus 1,767, Puma 600), "Penti" (1,505), "PUMA" (3), "French Connection" (20). Every brand except Cardio Bunny has some.
- category_code repeats category_name. dimensions.unified_sku_master_gcc copies these labels into `category`, and `sub_category` is null on every row (query: `COUNTIF(sub_category IS NOT NULL)` per brand = 0 for all 22 brands).
- unified_sku_master_gcc also holds SKUs that are not in the master sheet, labelled only "Softline": Campus 892, Vero Moda 197, Penti 163, USPA 126, French Connection 106, Keds 32.
- Gender is filled on nearly every row but spelled inconsistently ("Female", "female", "Male", "unisex", "Unisex", "Kids", "KIDS", "BOY", "GIRL"). Kids appear for USPA (49 options), Campus (5), Penti (12 GIRL), and Puma ("Jr" and "Inf" in names).
- `name` is filled on every row with a category, so names can serve as a last data-only signal. They are inconsistent, though: style codes such as "AMADEO GLB 6FX" for USPA, and mixed Turkish and English for Penti ("FLEX SUTYEN").
- The softline brands named in the brief that are missing: Anta has no rows in master_sl, sku_master_sheet_hl or unified_sku_master_gcc. Anta exists in the repo only as a manually added brand with a footwear eval set (docs/solutions/manual-brand.md, docs/handover/catalog-for-the-operator.md, the `anta.footwear` set in docs/plans/2026-10-20-go-live-resume-2.md). GTPlayer appears only in sku_master_sheet_hl as hardline: 20 SKUs, unified category "Gaming Chair" 14 and "Office Chair" 5.
- Non-softline items sold under softline brands: French Connection "Default" includes 85 candle, diffuser or room-spray SKUs and 12 jewellery or hair SKUs (by keywords in the name). Trendyol lists French Connection under "Candle & Candle Holder" (41 models), "Room Spray" (26), "Odor Remover and Air Purifier" (19), "Jewelry Earrings" (9) and "Hair Clips" (5). On 6thStreet, Vero Moda has 3 configs under "COSMETICS / EYES ACCESSORIES".
- USPA in master_sl is footwear only (labels "Shoes", "Kids Shoes", "SLIPPERS", "BOOTS", sneakers, and "Default" names that are shoe style codes). The meeting note "US Polo has 2,700 options" does not match 529 options here; it is closer to the 2,974 SKUs.

### F2. Channel category vocabularies (exact, softline brands only)

Each channel was checked for a category column and its labels were counted per brand. Small tables only; the large Noon catalogue tables (657 MB and 299 MB) were not scanned.

| Channel | Table and columns | Quality | Softline coverage |
|---|---|---|---|
| Trendyol | raw_gcc_table_cleaned.product_list_trendyol_3p_{uae,ksa}.category_name, gender | Specific (for example "Bras", "Pajama Sets", "Polo T-Shirts", "Ballerina Flats"); also mixes in sport and plus-size variants | Joined to master_sl on barcode = ean: 3,315 of 3,753 options matched. Only 82 options map to more than one Trendyol category (Penti 57, Puma 18, USPA 4, Vero Moda 2, Cardio Bunny 1) |
| Noon | raw_gcc_table_cleaned.traffic_sales_noon_3p_uae.family, product_type, product_subtype | Clean 3 levels (for example apparel / lingerie / bras; footwear / sneakers / low_top_sneaker) | Only SKUs that had traffic; 1,079 configs across 5 brands (Campus, French Connection, Nautica, Penti, USPA) |
| Styli | raw_gcc_table_cleaned.inventory_styli_3p_ksa.l1..l4 | Clean 4 levels: gender, department, category, subcategory (for example Women / Lingerie & Nightwear / Lingerie / Briefs) | 174 options matched to master_sl via styli_sku or styli_ae_ksa |
| 6thStreet | raw_gcc_table_cleaned.inventory_sixth_street_1p.item_department, item_class, item_subclass | Medium; some "Garments / others" | 728 config rows across 8 brands (all but Puma) |
| Centrepoint | raw_gcc_table_cleaned.sales_centrepoint_3p.departmentnew, all_segment, all_sub_segment | Coarse only ("Fashion Clothing", "SPORTS FOOTWEAR", "Innerwear") | Not useful for subcategory |
| Amazon | raw_gcc_table_cleaned.active_listings_amazon_3p_uae.zshop_category1 | Empty on all 13,415 rows | None |
| Namshi | gcc_channel_reports.catalog_live_namshi_3p_*, catalog_non_live_namshi_3p_* | No category column (title, brand, prices, status only) | None. The "Namshi full-listing sheet" with subcategory from the meeting is not in the warehouse |
| VogaCloset, Shein | No catalogue table found | None | None |

Per-brand Trendyol labels, counted as distinct model_code (query: `SELECT alias_gcc_brand(brand), category_name, COUNT(DISTINCT model_code) FROM (trendyol uae UNION ALL ksa) WHERE family_of_gcc_brand(...)='softline' GROUP BY 1,2`). Main lines:
- Penti: Pajama Sets 196, Bras 115, Briefs 93, Undershirt 54, Pajama Tops 33, Corsets 32, Nightgowns 24, Kimono & Kaftan 19, Bikini Tops 18, and 31 smaller labels.
- French Connection: Dresses 124, Shirts 98, Blouses 88, T-Shirts 69, Trousers 59, Handbags 55, Candle 41, Shorts & Bermudas 30, Polo 28, Skirts 26, and 30 smaller labels.
- USPA: Sneakers 498, Sports Slippers 15, Sandals 12, Home Slippers 12, Mules 10.
- Campus: Sneakers 183, Running Shoes 93, Walking Shoes 83.
- Keds: Sneakers 151, Loafer Shoes 11, Ballerina Flats 4, Mules 1.
- Puma: Sneakers 72, T-Shirts 59, Running Shoes 23, Sweatshirts 19, Outdoor Shoes 15, and others.
- Nautica: Polo 88, T-Shirts 54, Dresses 26, Shirts 7, Hats 5, and others.
- Vero Moda: Blouses 66, Dresses 34, Trousers 26, Shirts 23, Skirts 18, and 22 smaller labels including bags, scarves, gloves and socks.
- Cardio Bunny: Sports T-Shirts 30, T-Shirts 22, Sports Leggings 19, Sports Shorts 12, Sports Bra 11, and others.

### F3. Canonical category per option when data is used first (exact under the stated mapping)

How it was computed (scratch query, read only): for each master_sl option with a non-empty option id, take the Trendyol category_name joined on EAN; if there is none, take master_sl.category_name when it is specific (not null, empty, "Default", "Apparel", "Footwear" or the brand name). Then map that label to the proposed categories with ordered keyword rules. Counts are distinct options. The mapping rules are an approximation; the counts under those rules are exact.

| Brand | Category | Options | Label from Trendyol | Label from master_sl |
|---|---|---|---|---|
| Campus | footwear.closed | 704 | 704 | 0 |
| Campus | footwear, subcategory unknown | 308 | 0 | 0 |
| Cardio Bunny | apparel.tops (incl. sport) | 55 | 55 | 0 |
| Cardio Bunny | apparel.active_bottoms | 43 | 43 | 0 |
| Cardio Bunny | apparel.knit_sweat | 16 | 16 | 0 |
| Cardio Bunny | apparel sports bra | 4 | 4 | 0 |
| Cardio Bunny | apparel.outerwear | 1 | 1 | 0 |
| French Connection | apparel.tops | 309 | 288 | 21 |
| French Connection | apparel.bottoms | 144 | 136 | 8 |
| French Connection | apparel.dresses_jumpsuits | 132 | 127 | 5 |
| French Connection | home fragrance (not softline) | 86 | 86 | 0 |
| French Connection | apparel.knit_sweat | 67 | 58 | 9 |
| French Connection | bags | 63 | 63 | 0 |
| French Connection | unknown | 41 | 0 | 0 |
| French Connection | apparel.outerwear | 33 | 29 | 4 |
| French Connection | accessories.jewellery_hair | 19 | 19 | 0 |
| French Connection | apparel.lingerie_underwear | 3 | 3 | 0 |
| French Connection | apparel.active_bottoms | 2 | 2 | 0 |
| Keds | footwear.closed | 97 | 97 | 0 |
| Keds | unknown | 8 | 0 | 0 |
| Nautica | apparel.tops | 113 | 113 | 0 |
| Nautica | unknown | 18 | 0 | 0 |
| Nautica | apparel.dresses_jumpsuits | 15 | 15 | 0 |
| Nautica | apparel.bottoms | 8 | 8 | 0 |
| Nautica | accessories (hats) | 5 | 5 | 0 |
| Penti | apparel.lingerie_underwear | 252 | 252 | 0 |
| Penti | apparel.sleep_lounge | 239 | 239 | 0 |
| Penti | apparel.swimwear | 55 | 55 | 0 |
| Penti | apparel.tops | 31 | 31 | 0 |
| Penti | apparel.active_bottoms | 14 | 14 | 0 |
| Penti | apparel.bottoms | 11 | 11 | 0 |
| Penti | apparel sports bra and sport tops | 7 | 7 | 0 |
| Penti | unknown | 3 | 0 | 0 |
| Penti | apparel.knit_sweat | 2 | 2 | 0 |
| Penti | apparel.dresses_jumpsuits | 1 | 1 | 0 |
| Puma | footwear.closed | 105 | 105 | 0 |
| Puma | apparel.tops | 63 | 63 | 0 |
| Puma | apparel.knit_sweat | 20 | 20 | 0 |
| Puma | unknown / footwear subcategory unknown | 1 / 1 | 0 | 0 |
| USPA | footwear.closed | 495 | 495 | 0 |
| USPA | footwear.open | 34 | 34 | 0 |
| Vero Moda | apparel.tops | 49 | 49 | 0 |
| Vero Moda | apparel.bottoms | 28 | 27 | 1 |
| Vero Moda | apparel.outerwear (incl. "Tailoring") | 14 | 11 | 3 |
| Vero Moda | bags | 13 | 8 | 5 |
| Vero Moda | apparel.knit_sweat | 7 | 7 | 0 |
| Vero Moda | apparel.dresses_jumpsuits | 6 | 6 | 0 |
| Vero Moda | apparel.lingerie_underwear | 2 | 2 | 0 |
| Vero Moda | accessories (scarf, gloves, socks) | 1 | 1 | 0 |

Totals by department across the 3,748 options:
- Apparel: 1,746.
- Footwear: 1,744. Of these, 1,401 are closed shoes, 34 are open shoes and 309 have no subcategory.
- Bags: 76. Accessories: 25. Home fragrance: 86. Unknown: 71.

Within apparel:
- Lingerie and underwear: 257. Sleep and lounge: 239. Swimwear: 55. Together 551, nearly all Penti.
- Bottoms (including active bottoms): 250. Dresses and jumpsuits: 154.

### F4. How a product's category is decided today, and where it fails (repo)

- `packages/core/src/catalog/types.ts`: `PRODUCT_TYPES = auto | footwear | apparel_model | apparel_flat | bag_accessory | other`. This is the only category concept in the module. Two of the values describe presentation (on a model vs laid flat), not what the product is.
- `packages/core/src/catalog/qa/templates.ts` (`PRODUCT_TYPE_TEMPLATE`) and `packages/core/src/catalog/qa/classify.ts` (`classifyProductType`): one vision call on one photo returns `type`, `confidence`, `transparent` and `chart`.
- `apps/worker/src/catalog/chunk.ts` (around lines 96 to 119): the lowest-numbered photo is classified. If it is a chart, the next photo is tried once. The result is written to `catalog_products.product_type` for the whole product. On a spend cap the product becomes `other` with flag `type_unknown`. On classifier failure (`classify.ts`), it becomes `other`, confidence 0, flag `type_unknown`. A batch can force one type for every product (`catalog_batches.product_type`, `packages/core/src/db/schema.ts`).
- `packages/core/src/catalog/qa/policy.ts`: `model_policy` is keyed by `(brand_slug | *, category)`, where category is a PRODUCT_TYPE. The type also drives other behaviour:
  - shadow synthesis (`shadowSynthesisAllowed`: only footwear, bag_accessory and other);
  - the matte hand rule and sole strip (`chunk.ts`);
  - top protection on trims for apparel_model (`trimRules` in `packages/core/src/catalog/render.ts`);
  - the judge prompt's product words (`PRODUCT_TYPE_WORDS`).
- `docs/SPEC.md` (around line 317) states the auto type is taken from shot 1 and drives the shadow band, detail heuristics and policy row. Around lines 74 to 78, it states that models are used only for the QA judge and this classifier.
- What identity data is already pulled but unused:
  - `packages/core/src/catalog/master-sync.ts` `MASTER_SL_SQL` reads product_code, option id, ean, color, size, brand, line, image_url and channel ids from master_sl. It does not read `category_name`, `category_code`, `gender`, `name` or `description`.
  - `sku_map` (`schema.ts`) has no category, gender or name column.
  - `packages/core/src/catalog/ingest/links-sheet.ts` recognises "category" and "gender" headings in an uploaded sheet only so that it can ignore them (`OTHER_KNOWN`).
  - So every category signal the warehouse and the operator already hold is thrown away, which confirms the owner's statement that "there is no proper way" today.
- The judge's per-photo `view` (`CATALOG_QA_TEMPLATE` in `templates.ts`): front, side, back, sole, top, inside, detail, on-model, flat, chart. It does not name the shot roles that Styli and Centrepoint ask for (mid-thigh, full-length, back at hips, head-and-shoulders, fabric close-up).

Failure modes, from the code:
1. The type comes from one photo. If photo 1 is a flat lay or a close-up while the rest are on-model, or the reverse, every photo gets the wrong apparel_model or apparel_flat rules.
2. The confidence score is returned but never used: no threshold, no flag for a low-confidence type.
3. There is no subcategory, gender or age, so no per-category shot list, model choice or channel rule can be expressed.
4. Non-apparel items under softline brands (candles, jewellery, hats) land in `other` or `bag_accessory` with no distinction.
5. A forced batch type is applied to every product, even in a mixed folder.
6. A spend cap or classifier outage yields `type_unknown`, and the product loses its type-specific matte and shadow rules.

How often each failure happens in production was not measured; that needs a read of catalog_products in Cloud SQL, which this deep dive did not do.

### F5. Shot roles in scope (from the program intent map, section 2)

The Styli and Landmark sequence on a white or light grey background, same model and lighting, is:
1. Front, cropped at mid-thigh (FM).
2. Full-length, head to toe (FL).
3. Fabric close-up without the model (FC).
4. Back, cropped at the hips (BH).
5. Head-and-shoulders close-up (HS).

Body crops pass; head cuts fail. Centrepoint and Styli expect 5 photos with a model. Namshi, Noon and Trendyol accept 1, but 5 is "good catalog". The footwear wish list is packshot (PK), legs-only (LO) and lifestyle (LS). The required role list per channel is DD1's job, not this one's.

## Options

| Option | What it is | For | Against |
|---|---|---|---|
| A. Vision only, larger enum | Extend `PRODUCT_TYPE_TEMPLATE` with subcategories and keep classifying photo 1 | Smallest change; works for brands with no warehouse data (Anta) | Ignores 88% exact data that already exists. Pays a model call per product. One-photo errors stay. Gender and age guessed from a photo. Results can drift between runs |
| B. Data first, vision fallback, owner override (canonical taxonomy plus crosswalk) | A fixed Opptra taxonomy. A crosswalk maps each source label (master_sl, Trendyol, Noon, Styli, 6thStreet, uploaded sheet) to it. Vision is used only when data is silent. The owner can override per product or per batch | Deterministic for 98% of known options, in line with the SPEC rule that SKU resolution is code, not model. Exact, auditable, same answer every time. Works across 9 channels because each channel label maps in | Needs a crosswalk to maintain as new labels appear. Only works when the product's identifier resolves to an Opptra SKU. Two new fields per product and a sync change |
| C. Adopt one channel's taxonomy as canonical (Trendyol or Noon) | Use Trendyol category_name (or Noon family/type/subtype) directly | No taxonomy to invent; Trendyol covers 88% | Trendyol has more than 100 labels that mix gender, sport and plus size. Noon covers only SKUs with traffic. A channel can rename labels at any time. The other 8 channels still need a mapping |
| D. Owner-maintained sheet per option | Naz or the agency fills a category per option | Most accurate | 3,748 options by hand, more each season; it repeats work the data already did |

## Recommendation

Option B, with the following taxonomy and rules.

### Taxonomy (department > category > subcategory; gender and age are separate tags)

| Department | Category | Subcategories |
|---|---|---|
| apparel | tops | t_shirt, polo, shirt, blouse, tank_vest, crop_top, tunic, bodysuit_top |
| apparel | knit_sweat | sweater, cardigan, sweatshirt_hoodie, sweater_vest |
| apparel | outerwear | jacket, coat, trench, blazer, waistcoat |
| apparel | dresses_jumpsuits | dress_mini, dress_midi, dress_maxi, jumpsuit, beach_dress |
| apparel | bottoms | trousers, jeans, shorts, skirt |
| apparel | active | sports_bra, sports_top, leggings, sports_shorts, joggers_sweatpants |
| apparel | lingerie_underwear | bra, brief, shapewear_corset, slip_chemise, undershirt, boxer_trunk, multipack |
| apparel | sleep_lounge | pyjama_set, pyjama_top, pyjama_bottom, nightgown, robe_kimono |
| apparel | swimwear | bikini_top, bikini_bottom, swimsuit, swim_shorts, cover_up |
| footwear | closed | sneaker, running_sports, football, loafer_slip_on, ballerina_flat, boot, mule |
| footwear | open | sandal, slide_flip_flop, slipper |
| bags | bags | handbag, shoulder, tote, clutch, crossbody, pouch |
| accessories | accessories | headwear, scarf, belt, socks, gloves, jewellery, hair_accessory |
| other | not_softline | home_fragrance, cosmetics_accessory |

Tags:
- gender: women, men, unisex.
- age: adult, kids. Normalised from the 9 spellings in master_sl and from Styli l1.

Derived internal key: the existing PRODUCT_TYPE stays as the matting, shadow and policy key, so `model_policy` keys do not change.
- footwear becomes footwear.
- bags and accessories become bag_accessory.
- other becomes other.
- apparel becomes apparel_model or apparel_flat from the photo's view (per photo, from the judge's on-model or flat view), not from photo 1 alone.

UI copy names categories in plain words only and never names a model.

### Classification method and where each signal lives

The order below is the order of precedence: the first source that gives a specific answer wins.

| Order | Signal | Where it lives | Key |
|---|---|---|---|
| 1 | Owner override, per product or per batch | catalog module (new product field and batch option) | product |
| 2 | Uploaded sheet "category" and "gender" columns | Operator upload; `links-sheet.ts` already finds the heading | row identifier |
| 3 | master_sl.category_name when specific, plus gender | BigQuery raw_gcc_dimensions.master_sl, through `master-sync.ts` into `sku_map` (new columns) | opptra SKU or option |
| 4 | Trendyol category_name | raw_gcc_table_cleaned.product_list_trendyol_3p_{uae,ksa} | barcode = ean |
| 5 | Noon family/product_type/product_subtype; Styli l1 to l4; 6thStreet class/subclass | traffic_sales_noon_3p_*, inventory_styli_3p_ksa, inventory_sixth_street_1p | partner sku, styli sku or option, barcode |
| 6 | Keyword rules on master_sl.name | master_sl.name | option |
| 7 | Vision model on the product's photos (not photo 1 only), returning department, category and subcategory from the fixed list | `classify.ts`, `templates.ts` | product photos |

How the steps combine:
- A crosswalk table maps every source label to a canonical key. It is maintained in code with unit tests, so steps 2 to 6 are deterministic.
- The source used is stored with the product (`category_source`), so the operator and the links sheet can show where the answer came from.
- When step 7 is used, or two data sources disagree (82 options today), the product gets an information flag ("category guessed from the photo, check it") rather than being blocked.
- Products whose identifier does not resolve to an Opptra SKU (for example Anta) go straight to step 7 plus owner override.

No external library, API or SDK is recommended here, so no Context7 lookup was needed.

### Per-category handling matrix (proposal for approval)

Role codes:
- FM: front, mid-thigh.
- FL: full-length.
- FC: fabric close-up.
- BH: back at hips.
- HS: head-and-shoulders.
- PK: packshot, including side, pair, top, sole, back, inside and detail.
- LO: legs-only.
- LS: lifestyle.

"Crop" means a role can be made by cropping an existing photo, if the source is large enough (B2). "Generate" means made by a generator behind the fidelity gate (B3, V3).

| Category | On-model expected | Roles that apply | Derive by crop | Generation |
|---|---|---|---|---|
| apparel.tops | Yes | FM, FL, FC, BH, HS | FM from FL; HS from FL or FM; FC from any on-model or flat shot | BH and FL when missing; flat lay to on-model (B3) |
| apparel.knit_sweat | Yes | FM, FL, FC, BH, HS | As tops | As tops (B3) |
| apparel.outerwear | Yes | FM, FL, FC, BH, HS | As tops; FM for long coats needs care | As tops (B3) |
| apparel.dresses_jumpsuits | Yes | FL, FM, FC, BH, HS | HS and FC yes; FM on maxi length is an open question | B3 after the open question is answered |
| apparel.bottoms | Yes | Open question (FM and HS do not describe trousers or skirts) | FC yes; waistband detail likely | B3 after the role list is agreed |
| apparel.active | Yes | Tops rules for sports_top, bottoms rules for leggings, shorts and joggers; sports_bra open | As tops or bottoms | B3, except sports_bra (open) |
| apparel.lingerie_underwear | Open question | PK at least; on-model roles open | FC yes | Deferred until the owner answers |
| apparel.sleep_lounge | Yes | FM, FL, FC, BH, HS (sets judged as one outfit) | As tops | B3 |
| apparel.swimwear | Open question | PK at least; on-model roles open | FC yes | Deferred until the owner answers |
| footwear.closed, footwear.open | No | PK (side, pair, top, sole, back, detail), LO, LS | Detail crop possible, low value; not planned | LO open question; LS is B4, deferred |
| bags | Optional | PK (front, side, back, inside, detail), on-model carry optional, LS | Detail crop possible | LS is B4, deferred; no on-model generation now |
| accessories | Optional | PK; on-model optional | No | Not in scope |
| other.not_softline | No | PK | No | Not in scope; follows hardline rules |
| any category with age = kids | As the category | As the category | As the category | Open question (generated child models) |

## Categories needing owner clarity

1. **Bottoms (250 options).** Mid-thigh and head-and-shoulders do not describe trousers, jeans, shorts or skirts. What is the 5-shot list for bottoms? A possible list is front waist-to-feet, back, side, fabric close-up and waistband detail. Do Styli and Centrepoint publish one?
2. **Dresses and jumpsuits (154 options).** Is a front cropped at mid-thigh acceptable for midi and maxi lengths, or is full-length the only front shot?
3. **Lingerie and underwear (257 options, mostly Penti).** Do GCC channels accept these on a model, on a mannequin, or only as a packshot? May the module ever generate an on-model lingerie image?
4. **Swimwear (55 options, Penti).** Same question as lingerie.
5. **Multipacks and sets** (Penti "5 PACK", Nautica "Pack of 4 Brief"; 82 options carry two or more Trendyol categories). Is the main image the pack or one item? Which roles apply?
6. **Sports bras (11 options).** Do they follow activewear rules (on-model) or lingerie rules?
7. **Kids (USPA 49, Penti 12, Campus 5 options, plus Puma "Jr" and "Inf").** Are generated or harvested child models ever allowed, or do kids products stay packshot-only?
8. **Footwear legs-only.** Is legs-only part of B2/B3 now, or does it belong with lifestyle in B4 (deferred)?
9. **Footwear subcategory (309 Campus options with none).** Footwear subcategory matters only for B4 scene rules. May it stay unknown until B4?
10. **Accessories (headwear, scarves, belts, socks, gloves; 25 options).** Is a packshot enough on all 9 channels, or is on-model ever required?
11. **Jewellery and hair accessories (French Connection, 19 options).** Are these in scope for the catalog module at all?
12. **Home fragrance and cosmetics accessories (French Connection 86 options, Vero Moda 3 configs).** Should they be treated as hardline packshots (other) or left out of the softline program?
13. **GTPlayer.** The warehouse lists it as hardline chairs (20 SKUs), but the meeting reviewed its output as model shots. Which line and categories does GTPlayer belong to for this program?
14. **Anta.** It has no warehouse master, and only a footwear eval set exists. Which Anta categories are sold in GCC, and is there a sheet to use as its data source?
15. **USPA.** The meeting said 2,700 options; master_sl has 529 options (2,974 SKUs), all footwear. Is there a USPA apparel range or a second master not in the warehouse?
16. **Namshi full-listing sheet.** It holds a subcategory per product but is not in the warehouse. Where is it, and may it be added as a read-only source?

## Approval question

Do you approve the proposed softline taxonomy (4 departments, 14 categories with the listed subcategories, gender and age as separate tags, decided data-first with the vision model as fallback and your override on top) and the per-category handling matrix above as the foundation for B1, B2 and B3, with the 16 open items answered separately?

Status: done, awaiting owner answer
