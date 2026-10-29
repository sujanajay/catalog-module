# DD5: Attributes backbone (product fact sheet) and GCC listing fill

Date: 2026-10-22. Deep dive for bucket B6 of the Catalog Connect GCC program (deferred bucket; this
document prepares it and defines the fact sheet that B4 lifestyle, B5 infographics and B7 review-driven
fixes build on). This is an investigation only. Nothing here is built, no GCP resource was changed, and no
model or image spend was made.

Words used in this document:
- **Fact sheet**: one typed record per product (one brand + style + colour) holding what is true about
  it: identity, category, material, care, fit, sizes, origin. Every value carries where it came from.
- **Provenance**: the source of one value (for example "the brand's sheet, row 14" or "read from photo 2").
- **Listing template**: the spreadsheet a marketplace asks a seller to fill to create listings.
- **Listing copy**: the text written for a listing (title, description, highlights) in English and Arabic.
  It is made from the fact sheet but is not part of it.
- **Fill rule**: how one template column gets its value (a fixed value, a fact, a list choice, generated
  copy, image links, or left blank).
- **Gap**: a cell that could not be filled, with a typed reason the operator can act on.
- **Option**: one style in one colour (`option_id_style_color`), the unit the agency charges for.
- **PIM**: product information management software, a ready-made system that stores product facts.
- **Text model / vision model**: AI models that write text or read photos. Model ids never appear in UI copy.

## Summary

1. The warehouse already holds a structured attribute source the module has never used:
   `dimensions.sku_master_p2p`, refreshed daily, with material, care, fit, size system, gender, age group
   and subcategory. Joined on EAN it covers 2,419 of the 3,748 softline options (65%): material for 2,195
   (59%), care for 2,334 (62%), fit for 1,311 (35%), subcategory for 2,375 (63%). French Connection, Puma
   and Nautica (1,248 options) are absent from it entirely. It also holds Anta (523 SKUs, 64 options),
   which DD0 found in no warehouse table.
2. `master_sl` gives identity only. Its `description` and `description_1` columns hold product codes
   (for example `529A7_WHITE_OD_L/12`), not descriptions. Name, colour, size, gender, EAN and HS code are
   filled on nearly every row; MRP is filled on only 1,970 of 15,659 option rows.
3. Trendyol listings give real English description text for 3,207 options (at least 80 characters,
   average 196 to 706 per brand). No source anywhere in the warehouse holds Arabic text: 0 Arabic
   characters in Trendyol titles or descriptions, and the "local" name and description fields in
   sku_master_p2p are English.
4. Public template specs exist only for Trendyol (full API) and Amazon (API, credentials needed). Noon
   publishes its rules (English mandatory on UAE and KSA, Arabic optional but advised, "We are not
   providing translations", title 5 to 200 characters, a separate "noon Size" for fashion) but the field
   list and enums are only in the logged-in template download. Namshi, Styli, Centrepoint and 6thStreet
   publish nothing; the evidence points to vendor sheets plus in-house curation at Landmark (Styli,
   Centrepoint). The real blank templates must come from the owner's seller accounts.
5. No ready-made tool fills Noon, Namshi, Styli and Centrepoint templates with Arabic and fashion
   attributes. GCC connectors (Unicommerce, ChannelEngine) sync orders and stock; Unicommerce states
   Namshi catalog sync is manual. AI copy tools name no GCC template. Buying covers at most a slice.
6. catalog-service's listing-fill engine is a sound pattern (six fill rule types, eleven typed gap
   reasons, list choices constrained to the template's valid values, "blank is better than a guess"), but
   it has no typed fact sheet, no brand scoping of SKUs, in-memory locks, no migrations, overwritten
   outputs, a bug that drops "required" flags, no Arabic and no validator for generated text.
7. Recommendation: build inside catalog-module. A versioned fact sheet per product, filled by code from
   sources in a per-field precedence (operator, brand-manager sheet, sku_master_p2p, Namshi sheet,
   channel listings, master_sl, then vision for visual attributes only); a template registry with the
   catalog-service rule types re-designed in TypeScript; English and Arabic copy generated from the fact
   sheet only, checked by code, with Arabic reviewed by a native speaker on a golden set before it is
   trusted. Lift patterns, not Python code.
8. Runtime cost is small: about USD 0.064 (about INR 5.4) per option for English copy on a mid tier
   plus Arabic copy on a high tier, about USD 240 for the whole 3,748-option catalogue; template filling
   itself is code and costs nothing per cell.
9. Approval asked: the fact sheet schema, the per-field source precedence, and build-inside-catalog-module
   with the agency's template work replaced channel by channel once each channel's real template is in hand.

## Findings

### F1. Sources per field and their fill rates (exact, warehouse, read only)

Universe: master_sl rows with a non-empty `option_id_style_color` (15,659 SKU rows, 3,748 options, 9
softline brands, the same option universe as DD0 and DD9). Queries were small aggregates; no PII column
was selected (`listing_observation.pincode` was never read).

**master_sl (raw_gcc_dimensions.master_sl), SKU rows**

| Brand | SKU rows | Options | name | color | size | gender | EAN | HS code | image_url | MRP |
|---|---|---|---|---|---|---|---|---|---|---|
| French Connection | 4,086 | 899 | 4,086 | 4,071 | 4,086 | 4,073 | 4,086 | 4,086 | 4,085 | 0 |
| Penti | 3,149 | 615 | 3,149 | 3,149 | 3,149 | 3,149 | 3,149 | 3,149 | 3,146 | 1,151 |
| U.S. Polo Assn. | 2,974 | 529 | 2,974 | 2,974 | 2,974 | 2,974 | 2,974 | 2,974 | 2,974 | 0 |
| Campus | 1,767 | 1,012 | 1,767 | 1,767 | 1,767 | 1,767 | 1,767 | 1,767 | 1,767 | 692 |
| Puma | 972 | 190 | 972 | 972 | 972 | 972 | 972 | 972 | 972 | 2 |
| Nautica | 848 | 159 | 848 | 848 | 848 | 838 | 848 | 848 | 848 | 0 |
| Vero Moda | 679 | 120 | 679 | 679 | 679 | 679 | 679 | 679 | 679 | 0 |
| Keds | 671 | 105 | 671 | 671 | 671 | 671 | 671 | 671 | 671 | 0 |
| Cardio Bunny | 513 | 119 | 513 | 513 | 513 | 513 | 513 | 513 | 513 | 125 |

- `description` is filled on every row but is the per-size product code (average 19 to 38 characters,
  one distinct value per SKU, samples `529A7_WHITE_OD_L/12`, `4W ACHILLE MEN OD_BLACK_40`).
  `description_1` is the style code (samples `529A7`, `CB-822-01A`). Neither is a description. The style
  code is useful as an identity field.
- `name` is a style name, inconsistent across brands (DD0 F1: style codes for USPA, Turkish and English
  mixed for Penti).
- `category_name` is unusable on its own (DD0 F1). No material, care, fit, origin or Arabic column exists.

**sku_master_p2p (dimensions.sku_master_p2p), UAE entity "Oppdoor General Trading LLC.", latest snapshot
2026-10-22.** Three GCC entities (two UAE in AED, one KSA in SAR) carry near-identical copies; one
entity is used to avoid triple counting.

| Brand | SKU rows | Options (its own option_id) | material | care | fit | subcategory filled | size_system | Arabic text |
|---|---|---|---|---|---|---|---|---|
| USPA | 3,400 | 537 | 2,708 | 2,805 | 2,520 | 3,252 | 3,398 | 0 |
| Penti | 3,282 | 664 | 3,149 | 3,282 | 766 | 3,149 | 1 | 0 |
| Campus | 1,921 | 452 | 1,848 | 1,917 | 606 | 1,897 | 1,921 | 0 |
| Vero Moda | 1,426 | 308 | 993 | 1,426 | 0 | 925 | 301 | 0 |
| Keds | 641 | 77 | 641 | 641 | 0 | 542 | 641 | 0 |
| Cardio Bunny | 548 | 135 | 548 | 548 | 548 | 548 | 0 | 0 |
| ANTA | 523 | 64 | 523 | 523 | 0 | 523 | 489 | 0 |
| Only | 72 | 12 | 72 | 72 | 0 | 72 | 72 | 0 |

- Gender, age group, colour name, GTIN, English product name, season and product image links are filled
  on 100% of these rows. `catalog_approval_date` is empty on every row, so "approved" is not recorded.
  Rows were first created between 2026-07-21 and 2026-10-19 and updated up to 2026-10-21: this is a live,
  maintained master.
- `product_name_local` and `product_desc_local` are filled for some brands (ANTA 523, Vero Moda 888 in
  the desc field) but contain English, not Arabic (0 rows with any Arabic character).
- Value quality is mixed free text, not enums. Examples: material "95% COTTON, 5% ELASTAN", "PU",
  "Mesh/TPU/Synthetic Leather_EVA/Rubber", "MEMORY INSOLE" (a feature, not a material); fit
  "regular_classic_fit", "Regular Fit", "Relaxed"; care copied across a whole brand ("Wipe clean with a
  damp cloth..." on 2,520 USPA shoes). Vero Moda has "TPR" as material on 78 rows. So it is a good
  first source that still needs normalising and checks.
- Subcategory labels are a clean, small set per brand ("Apparel / Pyjama Sets", "Footwear / Low-Top
  Sneakers"), which maps into the DD0 taxonomy.

**sku_master_p2p joined to master_sl on EAN, options**

| Brand | Options | Joined | material | care | fit | subcategory |
|---|---|---|---|---|---|---|
| Campus | 1,012 | 1,012 | 956 | 1,012 | 583 | 1,012 |
| French Connection | 899 | 0 | 0 | 0 | 0 | 0 |
| Penti | 615 | 615 | 615 | 615 | 165 | 615 |
| U.S. Polo Assn. | 529 | 529 | 400 | 444 | 444 | 529 |
| Puma | 190 | 0 | 0 | 0 | 0 | 0 |
| Nautica | 159 | 0 | 0 | 0 | 0 | 0 |
| Vero Moda | 120 | 39 | 0 | 39 | 0 | 14 |
| Cardio Bunny | 119 | 119 | 119 | 119 | 119 | 119 |
| Keds | 105 | 105 | 105 | 105 | 0 | 86 |
| Total | 3,748 | 2,419 | 2,195 | 2,334 | 1,311 | 2,375 |

Vero Moda joins badly (39 of 120) although sku_master_p2p has 308 Vero Moda options: the two masters
hold different Vero Moda ranges or EANs. Matching on style code is a fallback to test.

**Trendyol listings (gcc_channel_reports.product_list_trendyol_3p_uae and _ksa), joined on barcode = EAN**

| Brand | Options | On Trendyol | Description of 80+ characters | Average description length | Arabic |
|---|---|---|---|---|---|
| Campus | 1,012 | 704 | 704 | 415 | 0 |
| Cardio Bunny | 119 | 119 | 119 | 706 | 0 |
| French Connection | 899 | 811 | 793 | 390 | 0 |
| Keds | 105 | 97 | 97 | 669 | 0 |
| Nautica | 159 | 141 | 114 | 196 | 0 |
| Penti | 615 | 612 | 610 | 512 | 0 |
| Puma | 190 | 188 | 153 | 291 | 0 |
| U.S. Polo Assn. | 529 | 529 | 506 | 504 | 0 |
| Vero Moda | 120 | 111 | 111 | 418 | 0 |
| Total | 3,748 | 3,312 | 3,207 | | 0 |

Trendyol also gives a specific category for 88% of options (DD0 F2) and a colour and gender per listing.
Its description is the only prose source for French Connection, Puma and Nautica. It is a channel's
copy, written by whoever listed it, so it is evidence for facts, not a source to copy verbatim.

**Other sources**

| Source | What it holds | Coverage and quality |
|---|---|---|
| Styli inventory (raw_gcc_table_cleaned.inventory_styli_3p_ksa l1 to l4) | Gender, department, category, subcategory | 174 options matched to master_sl (DD0 F2). Clean labels, small coverage |
| Noon traffic (traffic_sales_noon_3p_uae family, product_type, product_subtype) | Noon's own 3-level product type | 1,079 configs across 5 brands, only SKUs with traffic (DD0 F2). Useful as the target value for Noon's product type column |
| 6thStreet inventory (item_department, item_class, item_subclass, season, gender) | Department, class | 728 config rows across 8 brands (DD0 F2) |
| dimensions.unified_sku_master_gcc | Channel SKU ids, category, sub_category | sub_category null on every row (DD0 F1). Identity crosswalk only |
| Scout scrape (internal_brand_dashboard.listing_observation, Namshi.ae) | material, fit, pattern, sleeve_type, browse_path, product_highlights | 1,923 Namshi.ae listings, 1,462 with material and 1,249 with fit, but `brand` is null on every row and the material field often holds marketing prose ("Innerwear is the silent foundation of..."). Noon and Amazon rows have no attributes. Low quality; usable only as evidence after cleaning |
| dimensions.listing_observation, brand_intelligence.listing_observation | Same columns | 2 rows per platform (test rows) |
| dimensions.opptra_sku_brand_mapping | material, category, sub_category | India catalogue (Amazon.in, Flipkart, Myntra ids). Not GCC |
| Namshi full-listing sheet | Subcategory per product (meeting) | Not in the warehouse (DD0 item 16). Not measured. Owner to supply |
| Brand-manager sheets | Unknown | Not in the warehouse and not in the repo. Owner to supply |
| Vision extraction from product photos | Visual attributes (neckline, sleeve length, pattern, closure, length, toe shape, colour family) | Any product with photos. Cannot see composition percentages, care, origin or HS code |

### F2. Arabic: what exists and what the channels ask

- No Arabic text exists in any warehouse source checked (master_sl, sku_master_p2p, Trendyol UAE and KSA).
  Every Arabic word on a listing today was written by the agency, the channel, or Naz by hand.
- Noon (official, fetched): on UAE and KSA English is mandatory and must be approved; Arabic is optional
  but noon advises at least an Arabic title; "We are not providing translations"; a listing with only
  English may show only on the English site
  (https://supportagent.noon.partners/portal/en/kb/articles/seller-sku-content-language-requirements).
  The bulk template is downloaded as "English only" or "English + Arabic".
- Trendyol International: the product API accepts `Accept-Language: ar` or `en` and a storefront code
  (AE, SA) (https://developers.trendyol.com/v3.0/docs/product-create-v2). Whether Arabic is mandatory was
  not found.
- Namshi: Arabic described as optional by one secondary source (Streamoid, a vendor of cataloguing
  services; unverified). Styli, Centrepoint, 6thStreet: nothing public.
- Amazon.ae: reportedly optional Arabic fields (secondary); exact requirement needs the product type
  definition for the AE marketplace, which needs seller API access.

### F3. Template requirements per channel (reconstructed; web research 2026-10-22)

[OFF] official marketplace source, [SEC] integrator or vendor source, [NF] nothing public found.

| Field group | Noon | Namshi | Styli | Centrepoint | Trendyol Intl (AE, SA) | Amazon.ae |
|---|---|---|---|---|---|---|
| Format | Bulk .xlsm per category and product type from Seller Lab, English or English + Arabic [OFF snippet, SEC]; SFTP also exists [OFF] | Excel per category, subcategory and gender (Bulk Upload) [SEC] | Vendor template, Styli does QC and curation (job ads) [SEC, inferred] | Supplier information to Landmark's internal content platform (job ad) [SEC, inferred] | REST API, product create v2, max 1,000 items per request, asynchronous approval [OFF] | SP-API Listings Items + Product Type Definitions JSON schema per product type [OFF] |
| Identity | Partner SKU, GTIN/EAN/UPC, brand must match registered brand exactly [OFF snippet] | partner_sku [SEC] | Vendor style id, option, SKU (warehouse columns) | Not public | barcode (max 40), productMainId groups variants (max 40), brandId, stockCode [OFF] | SKU, product id, brand |
| Variants | Parent with size and colour children; each child its own barcode and Partner SKU; fashion adds a "noon Size" (closest international size) beside the label size [OFF snippet] | Parent style > colour > size; "One size" for single items [SEC] | Option and size in warehouse data | Not public | Variants grouped by productMainId [OFF] | Size is a complex attribute: size system, class, size, body type, height type [OFF] |
| Category | Product type chosen at download | Category, subcategory, gender [SEC] | l1 to l4 (gender, department, category, subcategory) seen in our data | Department, segment (coarse) seen in our data | Leaf categoryId only [OFF] | Product type (SHIRT, PANTS, SHOES...) [OFF] |
| Text | Title 5 to 200 characters, must include the product type, no special characters, no repeated words; material in the title must match specs and highlights [OFF snippet]; description; key features (highlights) [SEC] | Title, description [SEC] | Not public | Titles and descriptions fixed by Landmark's content team [SEC, inferred] | Title max 100, description max 30,000 (HTML) [OFF] | Title max 200, banned characters, no word more than twice [OFF forum] |
| Attributes | Colour, material, fit/style, size chart for fashion [SEC]; colour family and other enums only in the template [NF] | Colour, size (EU/UK/US), material/fabric, pattern, fit, model measurements; apparel: sleeve, neckline, closure, composition; footwear: sole material, heel height, strap type [SEC] | Not public | Not public | Category attribute API returns attribute ids, required flag, allowCustom (colour yes; size and age group no) and allowed values [OFF] | Per product type schema with enums [OFF] |
| Origin and other | Country of origin, price incl. VAT, currency [SEC] | Country of origin, MRP and selling price in AED and SAR [SEC] | Not public | Not public | origin (2-letter country), vatRate, listPrice >= salePrice [OFF] | Country of origin and compliance fields per type |
| Images | URLs in the template | URLs | Studio rules (DD1a) | Not public | HTTPS, max 8 per barcode, 1200x1800 [OFF] | Up to 9 (DD1a) |
| Arabic | Optional on UAE/KSA, advised title, no translation by noon [OFF] | "Optional" [SEC, unverified] | [NF] | [NF] | ar and en both accepted [OFF]; mandatory not found | Optional fields reportedly [SEC] |

6thStreet: no public seller program, template or connector found [NF].

Consequences:
- The field union across the four target channels is covered by the fact sheet in the schema section
  below; no channel asks for a fact the schema lacks, except price (commercial data, kept outside the
  fact sheet and read from Opptra's price source) and model measurements on Namshi (a photo-shoot fact,
  owner to say whether it is known).
- Enum lists (colour family, sizes, neckline, sleeve) live inside the real templates. The engine must read
  them from the template's own valid-value sheets and data validations, as catalog-service does for
  Amazon, Flipkart and Myntra (F5), and never from memory.
- The real blank templates for Noon (one per fashion product type), Namshi, Styli and Centrepoint are a
  prerequisite only the owner can supply.

### F4. catalog-module today (repo evidence)

Paths are relative to the worktree `C:\Users\Sujan Ajay\Desktop\catalog-module-wt\01-intent-map`.

- Workbook writing already exists with `exceljs` ^4.4.0 (`packages/core/package.json`):
  - `packages/core/src/catalog/sheet.ts` `writeLinksXlsx` writes the links sheet as xlsx and csv from one
    grid, and `compareXlsxCsv` proves the two carry the same cells.
  - `fillProductListWorkbook` (same file, around line 226) loads the operator's own workbook, keeps every
    sheet, column and value, finds the header row, matches each row by identifier or option id (and their
    size-level forms), appends `link_status` and per-channel image columns, and never modifies the input
    buffer. The filled file is offered as the "filled" export (`apps/web/lib/catalog/exports.ts`,
    `apps/web/app/api/catalog/batches/[id]/export/route.ts`). This is the nearest existing pattern to
    template filling: header discovery, row matching, append without damage.
- No attribute, listing copy, template registry, Arabic text or text generation exists anywhere.
  `packages/core/src/catalog/ingest/links-sheet.ts` (around line 44, `OTHER_KNOWN`) recognises "name",
  "description", "category", "gender", "price", "mrp" headings in an uploaded sheet only to ignore them.
- `packages/core/src/catalog/master-sync.ts` `MASTER_SL_SQL` reads product_code, option id, ean, color,
  size, brand, image_url and channel ids from master_sl into `sku_map`. It never reads `name`, `gender`,
  `hsn_code` or `description_1`, and never reads sku_master_p2p.
- Text models: the LLM layer (`packages/core/src/llm/llm.ts`, `packages/core/src/llm/openrouter.ts`) with
  spend accounting (`spend_days` in `packages/core/src/db/schema.ts`, `packages/core/src/catalog/cost.ts`)
  is used only by the QA judge and the product-type classifier. Model choice per brand and category lives
  in `model_policy` (`packages/core/src/catalog/qa/policy.ts`), never shown in the UI.
- Migrations exist: drizzle (`packages/core/drizzle/0000_init.sql`, `0001_users.sql`,
  `packages/core/src/db/migrate.ts`). Product claims are database locks (`catalog_products.lock_batch_id`,
  `packages/core/src/catalog/products.ts` around line 226), not in-memory.
- SPEC.md: models are used only for the QA judge and the classifier (DD0 F4, SPEC around lines 74 to 78);
  the non-goals (line 835 onwards) exclude "template, gallery or prompt features from the earlier app" and
  say "No model names or technical settings in the operator UI". Listing fill and text generation are a
  scope change that needs an owner amendment (draft in R7).

### F5. catalog-service listing-fill engine (read only, `C:\Users\Sujan Ajay\Desktop\catalog-service`)

What it is:
- Rule types `ListingFillType` = `SKIP`, `CONSTANT`, `ENUM`, `DIRECT_MAP`, `AI_TEXT`, `IMAGE`
  (`server/entities/catalog/attribute_enums.py:54-70`), validated per type in
  `server/dto/listing_config.py:64-171`. One `listing_template_column` row per Excel column with a JSONB
  config and a `resolve_stage` (dependency depth, so a child list waits for its parent column; cycles
  detected, `server/utils/listing_template_columns.py:715-740`).
- Typed gaps `ListingFillGapReason` (`attribute_enums.py:85-102`): `TOO_MANY_DROPDOWN_VALUES`,
  `UNRESOLVED_DROPDOWN`, `ENUM_HAS_NO_VALID_VALUES`, `ENUM_PARENT_NOT_FILLED`, `ENUM_NO_VALUES_FOR_PARENT`,
  `ENUM_MISSING_PARENT_MAP`, `ENUM_NOT_IN_VALID_VALUES`, `ENUM_NO_VALID_VALUE`, `REQUIRED_EMPTY`,
  `IMAGE_UPLOAD_FAILED`, `UNSUPPORTED_FILL_TYPE`, each with a user sentence checked at import
  (`attribute_enums.py:109-140`). Gaps go to a `gaps.json` sidecar and the UI groups them by SKU
  (`client/src/components/batch-content/ListingExportPanel.tsx`).
- Template parsing (`build_columns`, `listing_template_columns.py:541-712`) reads list data validations,
  named ranges and valid-value sheets; Amazon cascading lists become parent-dependent value lists; required
  flags come from Amazon's Data Definitions sheet. Per-marketplace layout (sheet name, label row, data
  start row) is in `server/utils/marketplace_listing_workbooks.json`.
- "Template to SQL": `render_sql` (`listing_template_columns.py:743-807`) and `ops/listing_mapping/` turn
  a blank template plus a human mapping workbook into hand-run SQL (DELETE then INSERT of column rules).
- List choice: exact match of the product-data hint first; otherwise one batched model call constrained
  by a JSON-schema enum and re-checked (`server/pipelines/listing/enum_select.py`, temperature 0), with
  fill, skip or no_valid_value; lists over 150 values become a gap.
- Generated text: forced tool call with fill or skip per column, "from evidence only... blank is correct,
  guessing is wrong", "Never invent dimensions, materials, or claims" (`server/pipelines/listing/ai_text.py:17-24,
  115-118`). Write-back with openpyxl into the blank template (`server/utils/listing_workbook.py:63-138`).

Defects confirmed:
- No typed fact sheet: product facts are a JSONB bag keyed by the client's spreadsheet headers
  (`sku_master.attributes`, `server/services/product_attributes.py`).
- No brand scoping of SKUs: `SkuMaster` has no brand column; lookups are global on the SKU string
  (`repositories/catalog/sku_master.py:14-33`, `services/job.py:1590-1616`).
- In-memory locks (`_running_fills_lock`, `server/services/listing.py:75-121`), lost on restart. Fill runs
  in the API process via FastAPI background tasks: no queue, no stored job status, no retry.
- No migrations; schema and rule changes are hand-run SQL.
- Outputs overwritten: filled file and gaps at fixed keys; re-uploading a template overwrites it.
- The mapping overlay drops `requiredness` (`ops/listing_mapping/overlay.py:220`), so `REQUIRED_EMPTY`
  never fires for mapped columns.
- Generated text has no length limits, no validator and no verifier; the prompt says "Amazon" for every
  marketplace. No Arabic or any second language. No size or parent/child variant handling. Flipkart and
  Myntra sheet names are hard-coded to bedsheets.
- No end-to-end test against a real template and no test that formatting and validations survive the
  round trip.

### F6. One product identity across links sheet, SKUs and attributes (catalog-module)

- `catalog_products` (`packages/core/src/db/schema.ts`): one row per brand + test flag + `product_key`,
  with `identifier`, `option_id_style_color`, `opptra_sku_ids` (all sizes), `sku_method`, `product_type`.
  Unique on (brand_slug, is_test, product_key) and on path_key.
- `catalog_product_aliases`: alias kinds `identifier`, `opptra_sku`, `option_id`, `channel_id`, `manual`
  (`packages/core/src/catalog/types.ts:27`), unique per brand.
- `sku_map`: one row per Opptra SKU with brand_slug, option_key, ean, color, size, channel_ids.
- `packages/core/src/catalog/sku-mapping.ts`: deterministic resolution restricted to the batch's brand:
  option_key, then ean, then channel id (`styli_sku`, `styli_ae_ksa`, `child_zsku`, `noon_ae`, `noon_sa`,
  `amazon`, `amazon_uae_ksa_asin`), then product_code without its size segment, then manual map.

So the identity the fact sheet needs already exists and is brand-scoped: the fact sheet hangs off
`catalog_products.id` (the option), and its variants are the product's `opptra_sku_ids` joined to
`sku_map` (EAN, size, channel ids). Every source in F1 joins through keys this resolver already knows
(EAN for sku_master_p2p and Trendyol, channel ids for Noon and Styli, option id for the Namshi sheet if it
carries one). The links sheet, the fact sheet and the filled templates therefore share one product id,
and catalog-service's brand-scoping defect does not arise.

### F7. Build vs buy: market scan (vendor pages read 2026-10-22)

[V] read on the vendor's page, [3P] third-party or search snippet, [U] not found.

| Tool | GCC coverage | What it does | Public price |
|---|---|---|---|
| Unicommerce / Uniware | Noon UAE/KSA, Namshi, Trendyol, Amazon.ae; Styli and Centrepoint connectors in docs [V] | Orders and inventory sync; "catalog sync is manual" for Namshi [V]; no AI content | On request [V] |
| ChannelEngine | Noon and Namshi direct [V] | Listing create, content and variant mapping, price, stock; Arabic not mentioned | Custom: onboarding fee + monthly licence + success fee [V]; a snippet showed Start USD 500/month, Grow USD 1,590/month [3P, possibly stale] |
| Streamoid Catalogix | Namshi seller guide only [V] | Managed AI cataloguing, enrichment, translation, marketplace exports; Arabic not stated | Free 300 credits; Pro USD 50/month for 1,000, USD 150 for 3,000, USD 350 for 7,000; 1 credit = 1 style [V] |
| Akeneo (PIM + Activation) | None of the 7 natively; custom XLSX/XLSM retailer templates accepted [V] | PIM, AI enrichment, syndication | On request; Growth "from USD 45,000/year" [3P] |
| Pimcore | No GCC connectors | Open-core PIM | Community free; Professional USD 9,900/year; Enterprise USD 29,900/year [V] |
| Plytix | No GCC | PIM, feeds, AI credits | Standard from EUR 0, Pro from EUR 149, Enterprise from EUR 699 per month at 100 SKUs, scaling with SKUs [V] |
| Salsify, Sales Layer, Lengow, Tradebyte, Rithum, Feedonomics | No GCC named (Tradebyte: Trendyol Turkey and EU only) [V/U] | PIM or syndication | On request; Rithum around EUR 1,000/month, Feedonomics USD 500 to 5,000/month [3P] |
| Zentail | US channels only [V] | Listing hub | USD 300/month + USD 0.10 per active listing + USD 0.50 per order [V] |
| Hypotenuse AI | No templates | AI product text in 40+ languages including Arabic, bulk CSV/XLSX [V] | Custom [V] |
| Describely | No GCC | AI descriptions and enrichment | USD 0.75 per product pay as you go [V] |
| Lily AI, Pixyle, Vue.ai, Rubick | None | Fashion attribute tagging from images | On request [3P] |
| ECOSIRE | Noon, Namshi, Trendyol connectors for Shopify/Magento [3P] | Custom sync build | One-time from USD 249 to 499 [3P] |
| MCP servers | Trendyol: community `koraynar/trendyol-seller-mcp` (MIT, unofficial); Amazon SP-API: several community servers; Noon: none [3P] | Agent access to seller APIs | Free, unofficial |
| Official APIs | Amazon SP-API Listings + Product Type Definitions: free to sellers (announced fees cancelled 2026-05-12 [3P]); Trendyol seller API with an International section [V]; Noon API for onboarded sellers and certified integrators only [3P] | Programmatic listing | Free |

No tool covers the four target channels' templates with Arabic and fashion attributes. ChannelEngine and
Unicommerce are order and stock plumbing first; their value would be publishing, not filling the agency's
templates. Streamoid is the cheapest managed copy service but names no Noon, Styli or Centrepoint template.

### F8. Text model list prices (OpenRouter public models endpoint, read 2026-10-22, USD per million tokens)

| Tier | Example models (doc only, never shown to the operator) | Input | Output |
|---|---|---|---|
| Low | google/gemini-2.5-flash-lite (current QA judge) | 0.10 | 0.40 |
| Low | anthropic/claude-haiku-5.5 (current second judge) | 0.10 | 0.50 |
| Mid | google/gemini-3.7-flash | 0.75 | 3.75 |
| Mid | anthropic/claude-sonnet-5.5 | 2.00 | 10.00 |
| Mid | openai/gpt-5.6-terra | 2.00 | 12.00 |
| High | anthropic/claude-opus-5.5 | 4.00 | 20.00 |
| High | openai/gpt-5.5 | 5.00 | 30.00 |

Batch variants are half price where offered (for example claude-sonnet-5.5:batch 1.00 / 5.00).

## Proposed fact sheet schema (for approval; DD for B5 infographics and B7 review enhancement build on this)

Unit: one fact sheet per `catalog_products` row (brand + option). Stored as a versioned document
validated by a zod schema (the module's existing validation pattern), one row per version in a new
`catalog_fact_sheets` table (product_id, version, facts jsonb, created_by, created_at), with the current
version pointed to from the product. A new version is written whenever a source changes a value or the
operator edits one; nothing is overwritten.

Every field is a `Fact<T>`:

| Part | Meaning |
|---|---|
| `value` | The typed value (enum key, number, string, list), or null |
| `source` | One of `operator`, `brand_sheet`, `p2p_master`, `namshi_sheet`, `channel_trendyol`, `channel_styli`, `channel_noon`, `channel_sixth_street`, `master_sl`, `vision`, `derived` |
| `sourceRef` | Where exactly: table and key, sheet name and row, or photo id |
| `raw` | The original text before normalising (for example "95% COTTON, 5% ELASTAN") |
| `status` | `confirmed` (from data or the operator), `proposed` (vision or a single weak source, shown for a check), `conflict` (two allowed sources disagree), `missing` |
| `observedAt` | When the source value was read |

Top-level fields:

| Group | Field | Type | Allowed sources (in precedence order) | Notes |
|---|---|---|---|---|
| identity | `brand` | brand_master slug and display name | catalog-module | Never generated |
| identity | `styleCode` | string | master_sl `description_1`, sku_master_p2p `brand_sku`, brand sheet | |
| identity | `optionId` | string | catalog_products | The option (style + colour) |
| identity | `productName` | string | brand sheet, p2p `product_name_en`, master_sl `name` | Brand's own name, input to titles |
| identity | `variants[]` | list of { opptraSku, ean, sizeLabel, sizeSystem (EU, UK, US, alpha, age), sizeIntl, channelIds } | sku_map, p2p `size_system`, brand sheet | `sizeIntl` is the "noon Size" style mapping, done by a code table per size system |
| classification | `department`, `category`, `subcategory` | DD0 taxonomy keys | as DD0 (operator, sheet, master, Trendyol, Noon, Styli, 6thStreet, name rules, vision) | DD0 owns this ladder; sku_master_p2p `sub_category` is added after master_sl in it |
| classification | `gender`, `ageGroup` | enum (women, men, unisex; adult, kids) | operator, brand sheet, p2p, master_sl, channel | Normalised from the 9 spellings (DD0 F1) |
| colour | `colourName` | string | brand sheet, p2p `color_name`, master_sl `color` | Brand's colour word |
| colour | `colourFamily` | canonical enum (about 20 values) | derived from colourName by a code table, then vision | Mapped per channel to its colour list |
| material | `composition[]` | list of { fibre enum, percent } | brand sheet, p2p, namshi_sheet | Parsed by code from text; percentages must sum to 100 or the fact is `conflict`. Never from vision or generation |
| material | `materialMain` | enum (cotton, polyester, leather, PU, canvas, mesh, ...) | derived from composition, else brand sheet, p2p, namshi_sheet | Footwear: `upper`, `lining`, `sole` sub-fields |
| construction | `fit` | enum (slim, regular, relaxed, oversized, ...) | brand sheet, p2p `fit_type`, namshi_sheet, channel | Vision may propose, never confirm |
| construction | `neckline`, `sleeveLength`, `length`, `rise`, `closure`, `pattern` | enums per category | brand sheet, namshi_sheet, channel, vision (proposed) | Visual, so vision is allowed as a proposal |
| construction | footwear `heelHeight`, `toeShape`, `fastening`, `soleType` | enums | brand sheet, p2p, vision (proposed) | |
| features | `features[]` | list of short typed claims { key, text } (for example "memory foam insole", "quick dry") | brand sheet, p2p (misfiled material values such as "MEMORY INSOLE"), Trendyol description (extracted, proposed) | The only input B5 infographics may render as callouts. A claim with no data source is never added |
| care | `careText`, `careCodes[]` | text and enum list (machine wash 30, do not bleach, ...) | brand sheet, p2p `care_instructions` | Never from vision or generation |
| origin | `countryOfOrigin` | ISO 3166 alpha-2 | brand sheet, p2p, namshi_sheet | Never generated; missing is a gap |
| origin | `hsCode` | string | master_sl `hsn_code`, p2p `hsn_code` | |
| usage | `occasion`, `season` | enums | brand sheet, p2p `season`, channel | |
| media | `images` | per channel ordered public links with shot role | catalog_outputs and DD1 shot roles | Read from the module, not stored twice |
| reserved | `voiceOfCustomer` | list of { theme, polarity, count, sourceRef } | B7 (review ingestion) | Empty until B7; listed so B7 adds to the schema without a rename |

Kept outside the fact sheet on purpose:
- **Commercial data** (price, MRP per currency, VAT, stock): read at fill time from Opptra's price source;
  the operator or a CONSTANT rule supplies it if no source exists. Never generated.
- **Listing copy** (`catalog_listing_copy`: product_id, fact_sheet_version, locale en or ar, channel or
  `master`, title, description, highlights[], status draft/checked/approved, checks jsonb): generated from
  one fact sheet version only, so any copy can be traced to the facts it used.

## Source precedence: confirm or challenge

The earlier default was "Namshi sheet first, brand-manager sheet overrides". Challenge, on the data:
- A brand-manager sheet overriding is right: the brand knows its product best, and a deliberate human
  answer should win over any copy of it.
- Namshi first is wrong as the general base. The Namshi sheet is one channel's listing data (itself
  likely filled by the agency or Namshi's team), is not in the warehouse, and its coverage is unknown.
  sku_master_p2p is Opptra's own maintained GCC master, joins on EAN with code, covers 65% of options
  today, and is refreshed daily.
- One order for all fields is also wrong: identity and sizes must come from the masters; visual
  attributes may come from photos; composition, care and origin must never come from photos or a model.

Proposed per-field precedence (first allowed source with a value wins; a disagreement between two
allowed data sources marks the fact `conflict` and shows both to the operator):
1. Operator edit in the module.
2. Brand-manager sheet uploaded for the brand.
3. sku_master_p2p (EAN join; style-code join as fallback).
4. Namshi full-listing sheet (best source for subcategory and enumerated attributes on Namshi).
5. Channel listings in the warehouse (Trendyol category, colour, gender; Styli l1 to l4; Noon product type;
   6thStreet class) and facts extracted from Trendyol descriptions (proposed only).
6. master_sl (identity, colour, size, gender, HS code).
7. Vision on the product's photos, visual attributes only, always `proposed`.

## Options

| Option | What it is | For | Against |
|---|---|---|---|
| A. Keep the agency for templates | Module does images; agency keeps filling templates inside INR 60 per style | No build; agency already knows the templates | Keeps the cost and turnaround; no fact sheet for B4, B5, B7; Arabic quality unknown and unchecked; agency invoice split between images and templates unknown |
| B. Buy a PIM with syndication (Akeneo, Pimcore, Plytix, Salsify) | Facts in a PIM, custom XLSX channel exports | Mature data model and UI | No GCC channel natively; Akeneo from about USD 45,000/year [3P], Pimcore Professional USD 9,900/year; a second system beside catalog-module, identity duplicated; still needs Arabic copy and every template mapped by us |
| C. Buy a connector (ChannelEngine, Unicommerce) | Publish listings to Noon and Namshi via their connectors | Real API publishing for Noon and Namshi | Order and stock first; Unicommerce Namshi catalog sync is manual; no Styli or Centrepoint content; no Arabic or attribute filling; ChannelEngine about USD 500/month plus success fee [3P] |
| D. Buy managed copy (Streamoid, Describely, Hypotenuse) | Send products, receive enriched copy | Cheap (Streamoid USD 50 per 1,000 styles; Describely USD 0.75 per product) | Their own fact model, not ours; no GCC template output except a Namshi guide; Arabic unproven; B5 and B7 cannot build on it; data leaves the module |
| E. Lift catalog-service's engine as code | Port or call the Python engine | Exists and has tests | Wrong language and runtime; carries the defects in F5; India templates; no fact sheet; no Arabic |
| F. Build inside catalog-module, lifting patterns (recommended) | Fact sheet + template registry + rule engine + copy generation in TypeScript on the existing identity, LLM layer, locks, migrations and workbook code | One identity, one platform; deterministic for most cells; typed gaps; versioned; feeds B4, B5, B7; costs cents per option | We own the template mappings for each channel and their upkeep when a channel changes its template; Arabic quality must be proven before trust |

## Recommendation

Option F.

### R1. Fact sheet store and filling
- The schema above, versioned, one document per product version, zod-validated, in Cloud SQL via a drizzle
  migration.
- A deterministic "assemble facts" step per product: read each source by the keys the SKU resolver
  already uses, normalise with code tables (colour family, fibre names, fit words, care codes, size systems,
  country names), apply the per-field precedence, and record provenance. No model takes part except vision
  proposals for visual attributes.
- Vision extraction runs on the low tier, on the product's photos (not photo 1 only), returning only
  enum keys from the fixed lists, as `proposed`.
- master-sync extended to read sku_master_p2p and the unused master_sl columns (`name`, `gender`,
  `hsn_code`, `description_1`) into the module, read only.

### R2. Template registry and fill engine (patterns lifted from catalog-service, rebuilt)
- `channel_template` (channel, category key, version, file object, sheet, label row, data start row,
  parsed columns) and `channel_template_column` (column index, label, required, valid values, parent
  column, rule). Uploading a new blank template creates a new version; nothing is overwritten.
- Rule types: `SKIP`, `CONSTANT`, `FACT` (a fact key plus a code transform, catalog-service's DIRECT_MAP
  bound to the typed fact sheet instead of a header bag), `ENUM` (crosswalk from the fact's canonical value
  to the template's valid values by code; a constrained model pick only for an unmapped value, capped list
  size, result re-checked against the list), `COPY` (generated title, description or highlight n for a
  locale), `IMAGE` (public links from the module by shot role and order), and `MANUAL` (operator must type
  it, for example a value no source holds).
- Required flags come from the template where it declares them and from the column mapping otherwise,
  and are never dropped (fixes the overlay bug). A required gap keeps the product out of "ready".
- Typed gap reasons, lifted and extended: catalog-service's eleven plus `FACT_MISSING`, `FACT_CONFLICT`,
  `FACT_ONLY_PROPOSED`, `COPY_CHECK_FAILED`, `COPY_NOT_APPROVED`, `SIZE_NOT_MAPPED`, each with one plain
  sentence in the UI and a test that every reason has one.
- Column mappings are code-reviewed data (a JSON file per channel template version with unit tests), not
  hand-run SQL; the registry loads them through migrations or a seed step.
- Write-back keeps the module's existing rule from `fillProductListWorkbook`: load the blank template,
  write only data cells, never touch other sheets, never modify the input. Noon's template is `.xlsm`;
  whether exceljs keeps macros, data validations and valid-value sheets on a round trip must be checked
  against current exceljs documentation (Context7) and a real-template round-trip test before build. If it
  cannot, cells are written by editing the sheet XML inside a copy of the file.
- Fill runs as a worker job with database claims (the existing lock pattern), stored job status, and
  versioned output objects. One filled workbook per channel and template, plus a gaps sheet inside it.

### R3. Listing copy, English and Arabic
- Generated per product from one fact sheet version, in one call per locale: a master title, description
  and highlights. Per-channel variants (title length, required words such as Noon's product type, banned
  characters) are made by code from the master copy where possible, and by a second call only when a
  channel needs a different shape.
- Arabic is written directly from the facts, not translated from the English, with a per-category code
  glossary for garment terms, colour words and size words, and brand names kept as registered.
- Checks by code on every copy: script ratio (Arabic copy is Arabic apart from brand, size and numbers),
  every number and percentage present in the facts, no material, claim or care word that is not in the
  facts, channel length limits, banned characters, no repeated words. A failed check is a `COPY_CHECK_FAILED`
  gap, not a silent retry loop.
- Tier: chosen automatically per brand and category through a text policy row like `model_policy`, never
  shown. Start Arabic copy on a high-quality tier and English on a mid tier; move to a lower tier only when
  a labelled golden set says it holds. The cost difference is cents per option (see Costs).
- Review: a native Arabic reader labels a golden set of 50 options across the 9 brands (fluency,
  accuracy against facts, register) before Arabic copy is offered; until that bar holds, every Arabic copy
  is "needs review". English copy is reviewed by sampling.

### R4. What Naz sees (non-technical operator)
- On the brand page, a "Product details" view per product: plain words, a small "from: brand sheet /
  company master / photo" label per value, and a yellow "check this" on any proposed or conflicting value
  with one-click accept or edit. No model names, no confidence numbers.
- A "Listing sheets" step at the end of a batch (or for a chosen set of products): she ticks Noon, Namshi,
  Styli, Centrepoint; each product shows "Ready" or "Needs info" with a sentence such as "Country of
  origin is missing - add it in the brand sheet or type it here" or "Arabic text waiting for review".
- She downloads one filled template per channel, already in the channel's own file, and uploads it to the
  channel as the agency does today. The links sheet gains the same "ready / needs info" column.
- Uploading a brand-manager sheet or a channel's new blank template is a drag-and-drop on the brand page;
  the module says which columns it recognised and which it could not map.

### R5. How the agency's template work is replaced
Channel by channel, in this order, each only after its real blank template is in hand and a side-by-side
on a sample of the agency's filled sheets shows equal or better cell coverage and no wrong facts: Namshi
and Noon first (about 95% of softline revenue, DD9), then Styli and Centrepoint. Until a channel passes,
the agency keeps that channel's templates. Brands with no sku_master_p2p data (French Connection, Puma,
Nautica) are filled from a brand-manager sheet or stay "Needs info" for material, care and origin; the
module never invents them.

### R6. Lift vs rebuild from catalog-service
Lift as patterns: the rule type set, typed gaps with user sentences and the every-reason-has-a-message
test, staged resolution for dependent lists, reading valid values from the template itself, constrained
list choice with re-check, "blank beats guess" generation with a forced fill-or-skip decision, gaps grouped
per product in the UI.
Rebuild: the fact model (typed and versioned, not a header bag), brand scoping (already in the module),
locks and job status (database claims and the worker), migrations (drizzle), versioned outputs,
required-flag handling, per-channel copy rules and checks, Arabic, size and variant handling, an
end-to-end test against each real template.
Do not lift: hand-run SQL rule loading, the Dropbox image hand-off, the India category specifics.

### R7. Draft SPEC.md amendment (for the owner at Gate C)
"The module keeps a versioned fact sheet per product. Facts come from the operator, the brand's sheet and
Opptra's masters first; a vision model may only propose visual attributes, which the operator confirms.
Composition, care, origin, price and sizes are never produced by a model. Listing copy in English and
Arabic is generated only from a stored fact sheet version and is checked by code before use; Arabic copy
needs review until its labelled golden set passes. The module fills marketplace listing templates the
operator supplies, writing only data cells, and reports each unfilled cell with a reason. No model names
appear in the operator UI."

### Context7 and libraries
No new library is recommended. The only library involved, exceljs (already a dependency at ^4.4.0), must
be checked against its current documentation with Context7 before build for `.xlsm` and data-validation
round trips; Context7 was not available in this session, so that check is listed as a build prerequisite,
not done here.

## Exact costs

| Item | Cost | Basis |
|---|---|---|
| Agency today | INR 60 per style for images plus templates, about INR 224,880 for all 3,748 options | Meeting figure, unverified; the template share of the 60 is unknown |
| Copy generation, mid tier English + high tier Arabic (recommended start) | About USD 0.064 per option (about INR 5.4); about USD 240 for 3,748 options | Approximate. Per locale 4,000 input tokens; output 1,000 (en) or 1,500 (ar). English on claude-sonnet-5.5 at 2.00/10.00 = USD 0.018; Arabic on claude-opus-5.5 at 4.00/20.00 = USD 0.046 |
| Copy generation, mid tier both locales | About USD 0.041 per option (about INR 3.4); about USD 154 for the catalogue | Same tokens, claude-sonnet-5.5 list price for both |
| Copy generation, low tier both locales | About USD 0.002 per option; about USD 8 for the catalogue | Same tokens, claude-haiku-5.5 at 0.10/0.50 |
| Vision proposals for visual attributes | About USD 0.001 per option | 5 photos, about 6,500 input and 400 output tokens on gemini-2.5-flash-lite at 0.10/0.40 |
| Template filling, fact assembly, checks | No model cost; compute on the existing worker | Code |
| Arabic golden-set review | Owner's reviewer; no vendor cost | 50 options |
| Buy alternatives | Akeneo about USD 45,000/year [3P]; Pimcore Professional USD 9,900/year [V]; ChannelEngine about USD 500/month + success fee [3P]; Streamoid USD 50/month per 1,000 styles [V]; Describely USD 0.75 per product [V] | F7 |

Exchange rate INR 84 per USD, as DD9. Token counts are approximate; the exact cost per option is
recorded by the module's existing cost ledger once built.

## Repo evidence

catalog-module (worktree `C:\Users\Sujan Ajay\Desktop\catalog-module-wt\01-intent-map`):
- `packages/core/src/catalog/sheet.ts` (`writeLinksXlsx`, `fillProductListWorkbook`, `compareXlsxCsv`)
- `apps/web/lib/catalog/exports.ts`, `apps/web/app/api/catalog/batches/[id]/export/route.ts`
- `packages/core/src/catalog/ingest/links-sheet.ts` (`OTHER_KNOWN`)
- `packages/core/src/catalog/master-sync.ts` (`MASTER_SL_SQL`)
- `packages/core/src/catalog/sku-mapping.ts` (resolution order, `RESOLVE_CHANNEL_KEYS`)
- `packages/core/src/db/schema.ts` (`catalog_products`, `catalog_product_aliases`, `sku_map`, `model_policy`, `spend_days`)
- `packages/core/src/catalog/types.ts` (`ALIAS_KINDS`, `PRODUCT_TYPES`)
- `packages/core/src/catalog/products.ts` (lock_batch_id claim)
- `packages/core/src/llm/llm.ts`, `packages/core/src/llm/openrouter.ts`, `packages/core/src/catalog/cost.ts`
- `packages/core/src/catalog/qa/policy.ts`, `packages/core/src/catalog/qa/classify.ts`
- `packages/core/drizzle/0000_init.sql`, `packages/core/drizzle/0001_users.sql`, `packages/core/package.json` (exceljs ^4.4.0)
- `docs/SPEC.md` (models only for judge and classifier; non-goals from line 835)

catalog-service (`C:\Users\Sujan Ajay\Desktop\catalog-service`, read only):
- `server/entities/catalog/attribute_enums.py`, `server/dto/listing_config.py`, `server/services/listing.py`
- `server/utils/listing_template_columns.py`, `server/utils/listing_workbook.py`, `server/utils/marketplace_listing_workbooks.json`
- `server/pipelines/listing/ai_text.py`, `server/pipelines/listing/enum_select.py`
- `server/services/product_attributes.py`, `repositories/catalog/sku_master.py`, `services/job.py`
- `ops/listing_mapping/` (`__main__.py`, `overlay.py`, `mapping_workbook.py`, `render.py`)
- `client/src/components/batch-content/ListingExportPanel.tsx`
- Tests: `server/tests/test_listing_fill_gaps.py`, `test_listing_mapping.py`, `test_listing_workbook.py` and others

Warehouse (opptra-datawarehouse, read only): `raw_gcc_dimensions.master_sl`, `dimensions.sku_master_p2p`,
`gcc_channel_reports.product_list_trendyol_3p_uae/_ksa`, `internal_brand_dashboard.listing_observation`,
`dimensions.unified_sku_master_gcc`, `raw_gcc_table_cleaned.inventory_styli_3p_ksa`,
`raw_gcc_table_cleaned.traffic_sales_noon_3p_uae`, `raw_gcc_table_cleaned.inventory_sixth_street_1p`.

## Depends on earlier DD answers

Gate B is assumed open with every earlier recommendation approved. If the owner answers differently:

- **DD0 taxonomy rejected or changed.** The classification fields change their keys and the channel
  category crosswalks are re-targeted; if Option C (a channel's taxonomy as canonical) were chosen instead,
  `category` and `subcategory` would hold Trendyol or Noon labels and every other channel would need its
  own mapping from them. The rest of the schema is unaffected.
- **DD0 item 16 (Namshi full-listing sheet).** If it cannot be added as a source, step 4 of the precedence
  drops out; subcategory then relies on sku_master_p2p and channel data, and Namshi enumerated attributes
  are filled from the fact sheet via crosswalk, with more `FACT_MISSING` gaps for Namshi-only fields.
- **DD0 item 14 (Anta).** sku_master_p2p now holds Anta (523 SKUs, 64 options); if the owner confirms
  it as Anta's master, Anta gets fact sheets like the other brands; if not, Anta relies on its own sheet.
- **DD0 item 15 (USPA apparel).** If a USPA apparel master exists outside the warehouse, it becomes a
  brand-manager sheet source; otherwise USPA stays footwear only.
- **DD1 and DD1a shot roles and order.** The `IMAGE` rule picks links by shot role and channel order. If
  roles are not approved, image columns fill in file-name order only, and a channel's "incorrect
  sequencing" risk (Noon) remains.
- **DD2 and DD3 generated shots.** If generated shots are approved, the `IMAGE` rule must honour a
  per-channel "generated allowed" flag; if not, only source-derived images are written.
- **DD8 brand style profile.** If approved, copy tone may read the profile's approved text fields; if not,
  tone comes only from the per-category glossary. DD8 rejected free-text brand DNA; this deep dive keeps
  that rule for copy too.
- **DD9 option universe and agency figure.** Costs here use 3,748 options and INR 60 per style. A
  different universe scales the catalogue totals linearly; an invoice showing the template share of the
  INR 60 would change only the savings line, not the recommendation.

## Questions only the owner can answer

1. Where is the Namshi full-listing sheet, who maintains it, and may the module read it (read only)?
2. Which brands have brand-manager sheets with material, care, fit and origin, and where are they? In
   particular French Connection, Puma and Nautica, which have no sku_master_p2p rows.
3. Who owns `dimensions.sku_master_p2p`, is it the intended company product master for GCC, and may the
   module treat it as the main structured source? Why is `catalog_approval_date` empty?
4. Can you supply the real blank templates: Noon (English + Arabic, one per fashion product type used),
   Namshi, Styli and Centrepoint vendor sheets, plus a few agency-filled examples per channel for the
   side-by-side?
5. Who can review Arabic copy (a native reader inside Opptra or at a channel), and is Arabic required for
   your Namshi, Styli and Centrepoint accounts?
6. Does the agency invoice split images from template filling within the INR 60?
7. Namshi asks for model measurements on apparel: are these known per shoot or per brand?
8. May catalog-worker be granted read access to `dimensions.sku_master_p2p` (a different dataset from the
   `raw_gcc_dimensions` it reads today)?

## Approval question

Do you approve (1) the fact sheet schema above (typed fields with provenance, versioned per product,
listing copy and commercial data kept separate), (2) the per-field source precedence (operator, then
brand-manager sheet, then sku_master_p2p, then the Namshi sheet, then channel listings, then master_sl,
then photos for visual attributes only), replacing "Namshi sheet first", and (3) building the listing fill
inside catalog-module by lifting catalog-service's patterns, with English and Arabic copy generated only
from the fact sheet and Arabic held for native review until its golden set passes, replacing the agency's
template work channel by channel once each channel's real template is supplied?

Status: done, awaiting owner answer
