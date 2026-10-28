# 20 Listing template files

Catalog module, spec 20. Written 2026-10-28 from the approved plan of that day (initiative 9). Execute with
`docs/specs/00-execution-protocol.md`. Source of truth: `docs/SPEC.md`, amended by this spec in the words of
section 0.4. Depends on 06 (finalize, links sheet, filled product list), 12 initiative 1 (`0005_shot_set.sql`,
detection outputs, the "Details" worksheet of the links sheet, links placed by `position`) and **19 V1**
(`docs/specs/19-product-facts-and-channel-vocabulary.md`, product facts). Uses 19 V2 (channel vocabulary)
when it is merged and works without it. Branch `feat/catalog-20-listing-template-files`, worktree
`C:\Users\Sujan Ajay\Desktop\catalog-module-wt\20-listing-template-files`. Deploys `catalog-worker` and
`catalog-web` through `infra/deploy.sh`; no new service, job or secret in V1.

Sources (read for the why; contracts are here): the approved plan
`C:\Users\Sujan Ajay\.claude\plans\below-is-one-message-mossy-diffie.md` (sections A R3, R9 to R11; B1 to B4;
"Decisions taken by Sujan"; C, first-principles decisions 3 and 7; D item 9), and its marketplace research
`below-is-one-message-mossy-diffie-agent-a2a2d43a94c8be68d.md` sections 2 and 3 (in this repo as
`docs/plans/proposals/2026-10-28-marketplace-rules-research.md`). Code pointers are `path:line` on the docs branch base `35d0e91`;
paths without a prefix are under `packages/core/src/catalog/`. Re-derive lines by heading at execution.

Status: **Blocked until gate G0b** (the owner adds `0009_listing_templates.sql` to the granted list of
00 section 11, see 0.3) **and gate G10** (at least two channel templates on record). Draft for owner approval.

## 0. Scope, words, dependencies, SPEC amendments

### 0.1 Purpose and non-goals

Today the operator downloads the links sheet and copies links into each marketplace's own listing file by
hand, and an agency is paid per style to fill those files for every platform (21 Oct meeting L20-21, plan
B1). Ashish asked for the next step on 27 Oct: once a product's facts are known per channel, the channel's
listing file with the links "is created automatically, nothing else required" (plan R10, transcript L97-102),
and he has templates of his own to prepare (R11, L80-81). His open question "how do you want to take output"
(R3, L59) is answered here for listings: a filled file per channel, next to the links sheet.

This spec adds: a **template registry** (each marketplace listing file the module knows, as data), a
**fill** that writes one filled copy of the channel's own file per batch, per channel and per template,
with every cell the module cannot fill left blank and shaded, a **validation report** (in the file and in
the links sheet's Details worksheet), and a **"Template fills"** panel on the Ops page. The operator
downloads the file and uploads it in the marketplace portal by hand. V1 covers the two channels whose
templates the owner names at execution (gate G10; expected noon NIS and Namshi Excel), with the Amazon flat
file as the third if the Amazon channel manager provides it.

Non-goals (V1 and V2):
- **No submission.** Templates are filled, never submitted. The module calls no marketplace write API: no
  Amazon Listings Items `putListingsItem` or `patchListingsItem`, no Amazon `JSON_LISTINGS_FEED` through the
  Feeds API, no Trendyol `createProducts`, no noon or Namshi API. Automated push is a later, separate owner
  decision with its own spec; nothing here prepares credentials for it. Spec 12's "no portal re-submission"
  rule stands (plan C decision 7).
- No invented values. A cell is filled only from the published links, the existing masters (`brand_master`,
  `sku_map`, the product row) or a spec 19 fact; otherwise it stays blank. Price, stock, offer, shipping and
  tax columns are never filled (commercial data belongs to the channel manager).
- No AI call in V1. The fill is pure data and code; cost is storage only (section 10).
- No Arabic text is written (V2 marks Arabic columns with a note, 7).
- No new public object. Template sources and filled files are private, under `exports/`.
- No change to the links sheet's main worksheet or to the filled product list (SPEC R23); only the Details
  worksheet gains a block (4.9).
- No SEO titles, bullets or keywords in V1; a per-channel title formula is V2 (7).

### 0.2 Words

**Channel:** one of the nine marketplaces of `channels.ts` (`CHANNEL_IDS`). **Template:** a marketplace's own
listing file (spreadsheet or attribute list) for one category or product type, for example the noon NIS sheet
for "Fashion / T-shirts". **Registry row:** one template the module knows (`catalog_listing_templates`).
**Template version:** one uploaded source file of a template and its parsed **column spec**
(`catalog_listing_template_versions`); versions are never edited after approval. **Column spec:** the list
of the template's columns with, per column, its header, whether it is required, its type, its allowed values
(a list or a vocabulary reference), its maximum length, an example and its **binding**. **Binding:** which
module value fills the column (an identifier, an image position, a spec 19 fact, a constant, or blank).
**Fill:** one filled file for one batch, one channel, one template version and one links sheet version
(`catalog_template_fills`). **Issue:** one problem found on one cell or product (`catalog_template_fill_issues`).
**Needs you:** a cell the operator must fill or check before upload: shaded in the file and listed on the
file's "Needs you" tab. **Parent and child rows:** a template that lists sizes as separate rows uses one parent
row per style-colour and one child row per size. **Evidence status:** for every claim about a marketplace,
`documented` (the marketplace's own file, help page or developer docs), `seller_reported` (integrators,
sellers, blogs) or `assumed` (the writer's inference, or nothing public found). **Product facts** and
**channel vocabulary:** spec 19's contracts (0.3).

### 0.3 Dependencies, contracts taken, preconditions

| From | Taken as is | Added by spec 20 |
|---|---|---|
| SPEC / spec 06 | `SheetSpec` and `SheetRow` (`sheet.ts:10-27`), links by channel in shot order, `writeLinksXlsx`, `fillProductListWorkbook` (the pattern of filling a supplied workbook), finalize's claim, attempt paths and snapshot check (`apps/worker/src/catalog/finalize.ts`), `exportPath` and `batchPrefix` (`naming.ts:108,143`), `report-v<k>.json` `exports` | the fill step inside finalize, `exports.templateFills` in the report, the Details block |
| Spec 12 initiative 1 | detection outputs on `catalog_products` (department, audience, garment length), links placed by `position` (s8.4), the "Details" worksheet (s8.4), `catalog_channel_policy` with `recommended_count` and its admin `PUT` route pattern (s1.4) | template matching on department; image minimum read from the template or the policy |
| Spec 13 (optional) | `catalog_products.subcategory` and `audience` (s1.3) | template matching on subcategory when present |
| Spec 19 V1 | product facts: per product and attribute a value (or `unknown`), a source, a confidence and the evidence | facts read through bindings (4.5) |
| Spec 19 V2 (optional) | channel vocabulary map: canonical value to channel value per channel, category and attribute, with a status | enum cells mapped through it (4.5) |

**Assumed spec 19 contract** (spec 19 is written in parallel; if its merged names differ, spec 20 adapts to
spec 19 and records the mapping in its report):

```ts
// from packages/core/src/catalog/facts/ (spec 19 V1)
export interface ProductFact { productId: string; attribute: string;          // canonical key, e.g. "sleeve_length"
  value: string | null;                                                       // null = unknown
  source: "photo" | "brand_sheet" | "operator" | "master";
  confidence: number;                                                         // 0..1; 1 for brand_sheet, operator, master
  needsConfirmation: boolean; evidence: unknown; version: string }
export function getProductFacts(db: Db, productIds: string[]): Promise<Map<string, ProductFact[]>>;
// spec 19 V2
export function mapToChannel(db: Db, q: { channel: ChannelId; category: string; attribute: string;
  value: string }): Promise<{ value: string; status: "documented" | "seller_reported" | "assumed" } | null>;
```

Preconditions (manager checks, 00 section 2; any missing item is `Blocked:` in the report):
- [ ] **G0b, migration grant.** 00 section 11 lists the granted additive migrations (0002 to 0004, spec 12
      `0005_shot_set.sql`, spec 13 `0006_scene.sql`). This spec needs `0009_listing_templates.sql` (numbered
      after specs 18 and 19, expected `0007` and `0008`; the final number is the next free one on
      `origin/main` at merge time) and additions to the 02 contracts `EVENT_KINDS` and the report's
      `ExportPaths` (2.6). The owner types approval of appending "spec 20 `0009_listing_templates.sql`" to
      the granted list, which the manager commits in its own docs PR before this spec runs. Without it the
      spec is `Blocked:`.
- [ ] **G10, templates on record.** For each V1 channel, the channel's own template file for at least one
      category the next batches carry, obtained from the person named in section 12, and the owner's typed
      choice of the two V1 channels (expected noon and Namshi; Amazon third if its flat file arrives). A
      channel without a template on record is simply not filled; G10 is hard per channel.
- [ ] Spec 19 V1 merged, with `getProductFacts` (or its merged name) on `main`. Spec 12 initiative 1 merged.
- [ ] **Golden fill partner.** Naaz agrees to hand-fill one real batch per V1 channel in the same template
      version (6.2). Without it the spec can merge but cannot leave the internal phase.

If a contract above is not on `main`, the spec stops and reports it (00 section 11); it never builds its own
copy of facts or detection.

### 0.4 SPEC.md amendments (this spec's PR; lines on `35d0e91`, re-derived by heading at execution)

1. **Non-goals, L894.** Replace "- No photo-shoot, template, gallery or prompt features from the earlier
   app." with:
   > - No photo-shoot, gallery or prompt features from the earlier app. The only template feature is the
   > spec 20 listing template fill: a marketplace's own listing file, uploaded by an admin, filled per batch
   > and channel from the module's links, masters and product facts, with every unknown cell left blank and
   > shaded, downloaded by the operator and uploaded in the marketplace's portal by hand.
2. **Non-goals, new bullet after it:**
   > - No writes to any marketplace: no listing, feed or product-creation API call and no portal action. A
   > later automated push needs its own owner decision and spec.
3. **Output, after R13 (L147-149), new R13a:**
   > - R13a Per batch and per ticked channel with an approved template (spec 20), a filled copy of the
   > channel's listing file sits next to the links sheet: one row per product (parent and size rows where
   > the template needs them), image columns from the published links in that channel's order, identifiers
   > from the masters, attributes from product facts; blanks and unsure values shaded and listed on a
   > "Needs you" tab; never submitted by the module.
4. **Sheet rules, after the filled product-list bullet (L419-425), new bullet:**
   > - Listing template fills (spec 20): finalize writes `<prefix>/exports/<channel>-<template_key>-v<k>.xlsx`
   > per approved template that matches at least one batch product; a fill that fails is reported and never
   > fails finalize or the links sheet; the links sheet's Details worksheet carries a "Template checks" block;
   > `report.json` records `exports.templateFills`.
5. **Operator told (L447):** after "submit marketplace templates only from a batch that says 'Ready to
   download'" add "; when the batch page offers a filled template for that marketplace, start from it, fill
   every shaded cell, then upload it in the portal".
6. **Batch page (L602):** after "Download filled product list" add "and one 'Download <Channel> listing file
   (<template label>)' per template fill, with '<n> cells need you'".
7. **Storage layout (L770):** add `catalog/exports/templates/` (template sources) to the private bucket line;
   the brand slug `exports` is reserved.
8. **Data model heading (L830):** add "and spec 20's `0009_listing_templates.sql`" to the granted migrations.
9. **Decisions log:** "Spec 20 (owner, <date of approval>): listing templates are data uploaded by an admin,
   filled per batch and channel, never submitted; no marketplace write API; V1 channels <A, B>; golden fill
   by Naaz with zero wrong values."

### 0.5 Workstreams and build order

| Workstream | Worktree suffix | Files owned | Depends on |
|---|---|---|---|
| A data and registry | `-a-data` | `db/schema.ts`, `drizzle/0009_listing_templates.sql`, `templates/types.ts` (zod), `templates/registry.ts`, `types.ts` (`EVENT_KINDS`), `naming.ts` (`templateSourcePath`) | G0b |
| B parsers | `-b-parse` | `templates/parse/index.ts`, `parse/nis.ts`, `parse/amazon-flat.ts`, `parse/generic.ts`, `parse/csv.ts`, `templates/bind.ts` (proposed bindings) | A |
| C fill and validation | `-c-fill` | `templates/match.ts`, `templates/fill.ts`, `templates/validate.ts`, `templates/write.ts`, `pipeline/report.ts` (`templateFills`), `sheet.ts` (Details block), `apps/worker/src/catalog/finalize.ts` (fill step) | A, B contracts, spec 19 |
| D admin and operator UI | `-d-ui` | `apps/web/app/catalog/templates/page.tsx` and `[id]/page.tsx` (new), `apps/web/app/api/catalog/templates/**` (new), batch page downloads and "Make files again", `apps/web/app/catalog/ops/page.tsx` ("Template fills") | A, C contracts |
| E evals and docs | `-e-evals` | `templates/compare.ts`, `pnpm catalog:template-compare` script, parse regression set, `docs/handover/catalog-for-the-operator.md` section, monitoring-guide query | B, C |

Before using any ExcelJS API (workbook load, cell `fill`, `dataValidation`, worksheet iteration) the builder
re-reads the current docs through Context7 (00 section 4). Read for this spec on 2026-10-28 from
`/exceljs/exceljs/v4.4.0` (the repo pins `exceljs ^4.4.0`, `packages/core/package.json:18`): solid fills are
`cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } }`; list validations are
`cell.dataValidation = { type: 'list', formulae: ['"A,B"' or '$D$5:$F$5'] }`; `workbook.xlsx.load(buffer)`
reads `dataValidations` unless told to ignore them; worksheets are walked with `eachSheet` or `worksheets`
(never `getWorksheet(1)`, whose ids may not start at 1). ExcelJS reads `.xlsx` only, not legacy `.xls`.

## 1. Marketplace templates on record (evidence, 2026-10-28)

Every row keeps the research labels. Where nothing is public, the channel manager holds the template (G10).

| Channel | Template | Per category? | Image columns | Programmatic read | Status |
|---|---|---|---|---|---|
| noon | NIS sheet, CSV, TSV or Excel, EN or EN+AR, with an instructions tab; header colours red = mandatory, green = discovery, grey = not applicable; up to 10,000 SKUs a sheet; variants on the Size axis only | yes: generated after choosing category, product type and subtype | image URLs on the parent row; "direct links ending .JPEG or Google Drive links", comma-separated | template download is portal only (Catalog > My Catalog > Add Products > Create Multiple Products); an API platform exists, content endpoints unverified | documented: https://supportagent.noon.partners/portal/en/kb/articles/seller-sku-bulk-creation ; API: https://support.noon.partners/portal/en/kb/articles/noon-api-platform (page timed out, search summary) |
| namshi | Excel catalog upload in the Namshi Partner Portal, which runs on noon partners infrastructure | unverified | not found | product creation by API not documented | seller_reported: https://www.omniful.ai/docs/integration/namshi-integration-document , https://streamoid.com/resources/guides/namshi-seller-guide ; 21 Oct meeting L153-155 "sports/casual is in the Namshi catalog sheet" |
| amazon (AE, SA) | Seller Central flat file per product type, with a Valid Values tab | yes, per product type | `main_product_image_locator`, `other_product_image_locator_1..8` (names unverified on AE/SA) | Product Type Definitions API returns a JSON Schema per product type and marketplace (AE `A2VIGQ35RCS4UG`, SA `A17E79C6D8DWNP`) | flat file seller_reported: https://support.storeautomator.com/hc/en-us/articles/4411195600146-Flat-File-Templates-for-Amazon ; API documented: https://developer-docs.amazon/sp-api/docs/product-type-definitions-api , https://developer-docs.amazon/sp-api/docs/marketplace-ids |
| trendyol | seller panel Excel unverified; the public REST API is the documented path | yes, attributes per lowest-level category | `images[]` of https URLs, at most 8 per barcode | `getCategoryTree`, `getCategoryAttributes` (`required`, `allowCustom`, `varianter`, `slicer`, `allowMultipleAttributeValues`), `getCategoryAttributeValues`; refresh weekly | documented: https://developers.trendyol.com/v3.0/docs/product-create-v2 , https://developers.trendyol.com/v2.0/docs/category-attribute-list-v2 |
| shein | Seller Hub; Open Platform needs an approved account | unverified | image type 1 main, 2 other | approved-account API | seller_reported: https://apis.io/providers/shein/ |
| vogacloset | no seller template; through integrators (ChannelEngine, Tradebyte); EAN-13, weight, origin, description required | categories managed by the channel | article images, at least 4 | integrator only | seller_reported: https://help.tradebyte.com/doc_cs_vogacloset.html |
| styli | managed by the Styli account team ("Styli lists, optimizes, and syncs your catalog") | not found | not found | not found | not found: https://seller.stylishop.com/getting-started |
| centrepoint, sixthstreet | vendor or concession line sheet from the retailer's buying or content team | not found | not found | not found | not found |

Consequences for this spec: noon is the only channel whose template layout is documented well enough to
write a dedicated parser before the file is in hand; the Amazon flat-file parser is written against the
seller-reported layout and confirmed on the real file; Namshi, Styli, Centrepoint, 6th Street, Shein and
VogaCloset use the generic parser (3.2) on whatever file the channel manager sends. The noon ".JPEG" wording
conflicts with the module's `.jpg` links; links of the module are already pasted into noon templates today
(SPEC R14 L154), so the fill writes them as they are and the image rule records the wording as an open
question (11.2 Q4).

## 2. Data model (`0009_listing_templates.sql`, additive)

One migration generated by drizzle-kit from `db/schema.ts`; new tables only, no change to existing rows or
columns; re-running it is a no-op.

### 2.1 `catalog_listing_templates` (the registry)

`id uuid pk`, `channel text not null` (a `CHANNEL_IDS` value), `template_key text not null` (slug, for example
`noon-fashion-tshirts`), `label text not null` (operator-facing, for example "noon T-shirts"), `applies_to
jsonb not null` (`TemplateMatch[]`, 4.2), `source_kind text not null` (`nis_xlsx`, `amazon_flat_file`,
`generic_xlsx`, `csv`; V2 adds `trendyol_api`, `amazon_ptd`), `owner text not null` (who supplied it and keeps
it current, a role or name, for example "noon channel manager"), `status text not null default 'draft'`
(`draft`, `active`, `retired`), `active_version int null`, `created_by`, `created_at`, `updated_at`; unique
(`channel`, `template_key`). Two `active` rows of one channel may not share a `TemplateMatch` of equal
specificity (checked on activation, 3.4).

### 2.2 `catalog_listing_template_versions`

`id uuid pk`, `template_id uuid not null` (fk), `version int not null`, `source_uri text not null`,
`source_name text not null`, `source_sha256 text not null`, `parser_version text not null`, `layout jsonb not
null`, `columns jsonb not null`, `image_rules jsonb not null`, `evidence_status text not null`
(`documented`, `seller_reported`, `assumed`), `notes text`, `state text not null default 'draft'` (`draft`,
`approved`, `superseded`), `uploaded_by`, `uploaded_at`, `approved_by`, `approved_at`; unique (`template_id`,
`version`). An approved version is never edited; a change is a new version.

```ts
// packages/core/src/catalog/templates/types.ts
export const COLUMN_TYPES = ["text","number","url","enum","multi_enum","date","boolean"] as const;
export const BINDING_KINDS = ["brand","identifier","option_id","opptra_sku","ean","size","colour_master",
  "image","image_list","fact","constant","parent_key","blank"] as const;
export const NEVER_FILLED = ["price","stock","offer","shipping","tax"] as const;   // a column tagged with one
                                                                                  // of these is always blank
export const Allowed = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("list"), values: z.array(z.string()).min(1),
    caseSensitive: z.boolean() }),                                // from a dropdown or Valid Values tab
  z.object({ kind: z.literal("vocabulary"), attribute: z.string(), category: z.string() }) ]); // spec 19 V2
export const Binding = z.discriminatedUnion("kind", [
  z.object({ kind: z.enum(["brand","identifier","option_id","opptra_sku","ean","size","colour_master",
    "parent_key"]) }),
  z.object({ kind: z.literal("image"), position: z.number().int().min(1) }),     // 1 = image 1 of the channel
  z.object({ kind: z.literal("image_list"), from: z.number().int().min(1), max: z.number().int().min(1),
    separator: z.string() }),                                                    // noon: "," in one cell
  z.object({ kind: z.literal("fact"), attribute: z.string() }),                  // spec 19 canonical key
  z.object({ kind: z.literal("constant"), value: z.string(), why: z.string().min(1) }),
  z.object({ kind: z.literal("blank"), reason: z.enum(["not_held","never_filled","arabic","admin"]),
    tag: z.enum(NEVER_FILLED).optional() }) ]);
export const TemplateColumn = z.object({
  key: z.string(),                       // stable id: the template's attribute name when it has one, else the header
  header: z.string(), sheet: z.string(), col: z.number().int().min(1),
  required: z.enum(["required","conditional","optional"]),
  requiredFrom: z.enum(["header_colour","instructions","valid_values","api","admin"]),
  type: z.enum(COLUMN_TYPES), allowed: Allowed.nullable(),
  maxLength: z.number().int().positive().nullable(), example: z.string().nullable(),
  level: z.enum(["parent","child","both"]), language: z.enum(["en","ar","none"]),
  binding: Binding, bindingConfirmed: z.boolean(),     // false until an admin confirms (3.3)
  status: z.enum(["documented","seller_reported","assumed"]), note: z.string().nullable() });
export const TemplateLayout = z.object({ dataSheet: z.string(), headerRow: z.number().int().min(1),
  keyRow: z.number().int().min(1).nullable(),          // a row of attribute names (Amazon), if any
  firstDataRow: z.number().int().min(1), variantModel: z.enum(["single","parent_child","size_rows"]),
  extraTabsAllowed: z.boolean(),                       // false: "Needs you" goes to a side file (4.7)
  sizeAxis: z.string().nullable() });
export const ImageRules = z.object({ min: z.number().int().min(0), max: z.number().int().min(1),
  minFrom: z.enum(["template","channel_policy","admin"]), urlPattern: z.string().nullable(),
  status: z.enum(["documented","seller_reported","assumed"]) });
```

### 2.3 `catalog_template_fills`

`id uuid pk`, `batch_id uuid not null` (fk), `channel text not null`, `template_version_id uuid not null`
(fk), `export_k int not null` (the links sheet version `k` the fill belongs to), `file_uri text null`,
`side_file_uri text null`, `products int not null`, `rows int not null`, `counts jsonb not null`
(`{ cells, filled, blank, shaded, lowConfidence, issues: { <kind>: n } }`), `status text not null`
(`done`, `failed`), `error text null`, `trigger text not null` (`finalize`, `make_again`), `created_at`;
unique (`batch_id`, `template_version_id`, `export_k`).

### 2.4 `catalog_template_fill_issues`

`id bigserial pk`, `fill_id uuid not null` (fk, cascade), `product_id uuid null` (null for a file-level
issue), `row int null`, `cell text null` (A1 address), `column_key text null`, `kind text not null`,
`severity text not null` (`blocker`, `check`), `value text null` (at most 200 characters; product data only,
never a person's data), `message text not null`. Kinds: `required_blank`, `not_allowed`, `too_long`,
`too_few_images`, `too_many_images`, `low_confidence`, `no_channel_word`, `needs_sizes`, `no_template`,
`binding_unconfirmed`, `reread_mismatch`.

### 2.5 Storage

- Template sources (written by `catalog-web` on upload): private bucket
  `catalog/exports/templates/<channel>/<template_key>/v<version>/<sanitized source name>`
  (`catalog-test/exports/templates/...` for tests), built only by `templateSourcePath` in `naming.ts`. No
  `customTime` is set, so `infra/lifecycle-assets.json` never deletes them; `exports/` is never deleted
  (SPEC storage rules). A new version is a new object; nothing is overwritten.
- Fills (written by `catalog-worker` in finalize): the attempt path of finalize,
  `<prefix>/exports/<claim>/<channel>-<template_key>-v<k>.xlsx` and, when `extraTabsAllowed` is false,
  `<channel>-<template_key>-v<k>-needs-you.xlsx`. Same lifecycle as `links-v<k>.xlsx`.

### 2.6 Contracts extended (02, additive)

- `EVENT_KINDS` (`types.ts`) adds `template_uploaded`, `template_approved`, `template_retired` (written as
  admin events with the actor) and `template_fill_failed`.
- `ExportPaths` (`pipeline/report.ts`) adds `templateFills: { channel, templateKey, version, xlsx,
  sideFile, counts, status }[]`; older reports without it read as `[]`.
- No change to `CHANGE_KINDS`, `OUTPUT_FLAGS`, `CHUNK_STAGES`, cost stages or task routes.

## 3. Getting a template in: upload, parse, confirm, approve

### 3.1 Admin page and routes

Page `/catalog/templates` (admin only; operators and viewers see it read-only), linked from the Ops page.
Lead: "Marketplace listing files the module can fill. Each one comes from the marketplace itself, through
its channel manager. The module fills them; it never sends them." Table: Marketplace, File (label), For
(the `applies_to` in words, for example "Apparel, tops, women"), Version, Status ("Active", "Draft",
"Retired"), Evidence ("From the marketplace's own file", "Reported by sellers", "Assumed"), Owner, Last
used. Button "Add a listing file".

Add flow, one page per step:
1. "Which marketplace and which products?" Marketplace (select), label, "Used for" (product type, then
   optional department, subcategory, audience; the 4.2 match), owner (free text, required).
2. "Upload the file exactly as the marketplace gave it." Accepts `.xlsx`, `.csv`, `.tsv` up to 25 MB through
   the signed-upload pattern of batch uploads (spec 04). A `.xls` or `.xlsm` file is refused with "Save it as
   .xlsx (Excel Workbook) and upload again." (ExcelJS reads `.xlsx` only; 11.2 Q3 covers Amazon's `.xlsm`.)
3. "Check what we read." The parsed column spec as a table: Column, Required, Type, Allowed values (count,
   expandable), Max length, Example, **Filled from** (the proposed binding in words: "Image 1", "Images 2 to
   9, comma-separated", "Style and colour code", "Brand", "Sleeve length (product facts)", "Left blank: price
   is never filled", "Left blank: not held by the module"), Evidence. Each "Filled from" is a select; each
   row has "Looks right" (confirms the binding). Warnings above the table: required columns left blank by
   binding ("<n> required columns will always need you"), unconfirmed bindings, image columns found versus
   the image rule.
4. "Approve" (enabled only when every binding is confirmed): the version becomes `approved`, the registry row
   `active` with `active_version` set; the previous approved version becomes `superseded`. Events
   `template_uploaded` and `template_approved` with the actor.

Routes (admin only unless noted; zod-validated; the `catalog_channel_policy` `PUT` pattern of spec 12 s1.4):
`GET /api/catalog/templates` (any signed-in role), `POST /api/catalog/templates` (create a registry row),
`POST /api/catalog/templates/[id]/versions` (body: the uploaded object path; parses, stores a `draft`
version, returns the column spec), `PUT /api/catalog/templates/[id]/versions/[version]` (draft only:
bindings, `required`, allowed lists, image rules, layout, notes), `POST .../approve`,
`POST /api/catalog/templates/[id]/retire`. An approved version answers 409 to `PUT`.

### 3.2 Parsers (`templates/parse/`, one per `source_kind`, versioned `PARSER_VERSION`)

Each parser returns `{ layout, columns, imageRules, warnings }` with every column `bindingConfirmed: false`.
Unknown layouts never throw silently: a parser that cannot find a header row returns a warning and lets the
admin set `headerRow`, `firstDataRow` and `dataSheet` by hand on step 3.

- **`nis_xlsx` (noon, documented layout; details assumed until the file is in hand).** Finds the data sheet
  and the instructions tab ("With Instructions" download). `required` from the header cell fill: red =
  `required`, green = `optional` (discovery), grey = column kept but bound `blank` with reason `admin`
  (not applicable), `requiredFrom: header_colour`. Allowed lists from the data sheet's list validations; a
  validation pointing at a range on another sheet is resolved by reading that range. Max length, examples and
  descriptions from the instructions tab where a column's header matches. `variantModel: parent_child`,
  `sizeAxis` from the column whose header contains "size" with a list validation. `language` from header
  suffixes (EN, AR). `imageRules`: the image URL column on the parent row, `image_list` binding with
  separator ",", `min` 3 (noon recommends at least 3 images, documented on the image requirements page
  https://supportagent.noon.partners/portal/en/kb/articles/image-requirements-and-rejection-reasons-for-the-seller-sku-12-3-2024),
  `urlPattern` null with the ".JPEG" note (1).
- **`amazon_flat_file` (seller-reported layout).** The template tab has a row of labels and a row of
  attribute names (`keyRow`); `key` is the attribute name. `Valid Values` tab gives allowed lists per
  attribute; a "Data Definitions" tab, when present, gives required flags (`requiredFrom: instructions`).
  `variantModel: parent_child` when `parent_child` and `relationship_type` columns exist. Image columns
  `main_product_image_locator` (`image` position 1) and `other_product_image_locator_<n>` (position n + 1).
  Every column `seller_reported` until the admin confirms the file, then `documented` (the file is
  Amazon's own).
- **`generic_xlsx` (Namshi and every other channel).** Header row = the first row with at least 5 non-empty
  text cells (admin can change it). Allowed lists from list validations; `required` from a header fill that
  differs from the row's majority, a trailing `*`, or the word "mandatory" or "required" in the header or a
  comment, else `optional` with `requiredFrom: admin` (the admin marks required columns on step 3).
- **`csv`** (CSV or TSV through `packages/core/src/csv`): headers only; every rule comes from the admin.
  Help on step 2: "A CSV has no colours or dropdowns. Upload the Excel version if the marketplace offers one."

### 3.3 Proposed bindings (`templates/bind.ts`) and confirmation

A seed dictionary proposes a binding per column by header or attribute name, case- and space-insensitive:
seller SKU, partner SKU, `item_sku`, "style code" to `identifier` or `option_id` (the admin picks which the
channel uses; noon's partner SKU is the product code in the warehouse join, so `identifier` is proposed);
barcode, EAN, GTIN to `ean`; brand, `brand_name` to `brand`; size to `size`; colour to `fact colour_family`
when spec 19 has it, else `colour_master` (`sku_map.color`); image columns to `image` or `image_list`;
parent SKU to `parent_key`; any header containing price, MRP, stock, quantity, offer, sale, shipping, VAT,
HSN or tax to `blank` with `never_filled`; an Arabic column to `blank` with `arabic`; a header matching a
spec 19 attribute key or synonym to `fact`. Everything else is `blank` `not_held`. Nothing is used until an
admin confirms every binding ("Looks right"); an unconfirmed binding blocks approval.

### 3.4 Activation and versions

On approve: zod validation of the full version; every `fact` binding names an attribute spec 19 knows; every
`vocabulary` reference names an attribute spec 19 V2 knows, or the column falls back to its `list`; no other
`active` template of the same channel has a `TemplateMatch` of equal specificity that overlaps ("noon
T-shirts already covers Apparel, tops. Make this one more specific or retire the other."). Retiring a
template stops new fills; earlier fills keep their files. A later upload of a changed marketplace file is a
new version; the step 3 page shows a column diff against the active version (added, removed, changed
required, changed allowed list) before approval.

## 4. Fill

### 4.1 When it runs

Inside finalize (`apps/worker/src/catalog/finalize.ts`), after `buildReport` and before `writeLinksXlsx`:
`buildTemplateFills(tx, batch, sheet)` reads the batch's products, their facts (`getProductFacts`), the
`sku_map` rows of their `opptra_sku_ids` and the active template versions in the **same repeatable-read
transaction** as `buildReport`, so the fill and the links sheet show the same state. Files are written to
the attempt path (2.5) with the links sheet, so an expired attempt never overwrites a newer one. The
template checks are passed to the links sheet writer for the Details block (4.9).

A fill never fails finalize: an exception in one fill is caught, the fill row gets `status = 'failed'` with
the error, event `template_fill_failed`, and finalize continues; the links sheet, the filled product list
and the re-check are unchanged. Fills run only for ticked channels, only on products with at least one live
link on that channel, and never on a test batch's products outside `catalog-test/`.

"Make files again" on the batch page (4.10) re-enqueues finalize, which writes `links-v<k+1>` and new fills
(`trigger = 'make_again'`): used after facts were corrected or a template version was approved.

### 4.2 Which template per product (`templates/match.ts`)

`TemplateMatch = { productType: ProductType; department?: Department; subcategory?: Subcategory;
audience?: Audience }`. For each product and ticked channel, every `active` template of that channel whose
match is satisfied by the product (spec 12 department, spec 13 subcategory when present, the live
`product_type`) is a candidate; the most specific one (most fields set) wins. No candidate: no row, issue
`no_template` (file-level, listed on the batch page as "No <Channel> listing file for <n> products: <type>.
Ask an admin to add one."). One file per (channel, template) with at least one product.

### 4.3 Rows

- `single`: one row per product, in the links sheet's order (natural sort of `identifier`, `sheet.ts`).
- `parent_child` and `size_rows`: one parent row per product (for `parent_child`) and one child row per size.
  Sizes come from the `sku_map` rows of the product's `opptra_sku_ids` (`size`, `ean`, `opptra_sku`),
  natural-sorted. A product with no size rows in the masters gets its parent row only (or one row for
  `size_rows`) and a `needs_sizes` blocker: "No sizes on record for this product. Add one row per size."
  (Assumption: `sku_map` carries sizes for warehouse brands; manual brands have none, SPEC open point 2.)
- Columns at `level: parent` are written on parent rows only, `child` on child rows only, `both` on both;
  `parent_key` is the product's `identifier` on child rows.

### 4.4 Cell values per binding

| Binding | Value | Shaded when |
|---|---|---|
| `brand` | `brand_master.name` | value not in the column's allowed list (`not_allowed`, value left blank) |
| `identifier`, `option_id` | the product row, written as text (`numFmt "@"`, as `sheet.ts` does) | never |
| `opptra_sku`, `ean`, `size` | the child row's `sku_map` values; on a single row, the value only when the product has exactly one | missing (`required_blank` if required) |
| `colour_master` | `sku_map.color` when every size row agrees | rows disagree or missing |
| `image`, `image_list` | 4.6 | 4.6 |
| `fact` | 4.5 | 4.5 |
| `constant` | the admin's value (with its `why`, shown on step 3) | never |
| `blank` | nothing | required (`required_blank`) |

Rules for every cell: the module writes a value only when it is known; it never writes placeholder text
("N/A", "TBD", "-") into a data cell, because a portal would upload it. Values are never truncated: a value
over `maxLength` is written and shaded red with `too_long` ("<n> characters; the limit is <m>."). A value
outside an allowed list is never written; the cell is blank and shaded with the value we hold in the issue.

### 4.5 Facts and channel vocabulary

For a `fact` binding, the product's spec 19 fact with that attribute is used:
- `value` null (unknown) or no fact: blank; `required_blank` when required.
- `source` `brand_sheet`, `operator` or `master`: written.
- `source` `photo`: written when `confidence` is at least `write_bar` and `needsConfirmation` is false;
  written and shaded amber with `low_confidence` when `confidence` is at least `write_bar` but below
  `check_bar` or `needsConfirmation` is true; blank below `write_bar` (`required_blank` or nothing).
  `write_bar` 0.85 and `check_bar` 0.95 are data in `model_policy` (category `templates`, the
  `ensureDefaultPolicies` pattern, `qa/policy.ts:35`), so the owner can raise them without a deploy; the
  golden fill (6.2) sets their final values.
- For a column with `allowed`: the value is passed through spec 19 V2's `mapToChannel` when the vocabulary
  exists; a mapped value with status `assumed` is written and shaded amber. Without a map row, the canonical
  value is written only when it equals an allowed value exactly (case per `caseSensitive`); otherwise the
  cell is blank with `no_channel_word`: "We know '<value>' for <attribute>, but <Channel> has no matching word
  on record. Pick one from the list." The module never guesses a mapping ("half sleeve" is never written as
  "short sleeve" until a map row says so; research section 3, plan B4).
- A `multi_enum` column takes every mapped value joined by the template's separator.

### 4.6 Images

Image cells come only from the published links of that channel for that product, in the channel's order
(the `SheetRow.links[channel]` array, which spec 12 orders by `position`): `image` position n takes link n;
`image_list` takes links `from` to `from + max - 1` joined by `separator`. Empty positions (removed or
missing) are skipped, never shifted silently: a product whose links have gaps gets a `check` issue. Fewer
live links than `imageRules.min` (from the template, else the channel policy's `recommended_count`):
`too_few_images` blocker ("<n> photos; <Channel> asks for at least <m>."). More links than the template's
image columns hold: the first ones are written and `too_many_images` is a `check` issue ("Photos <a> to <b>
did not fit in this file."). A `needs_attention` product (SPEC: previous live links shown) uses the same live
links as the links sheet. When `urlPattern` is set, a link that does not match is written and shaded.

### 4.7 Writing the file (`templates/write.ts`)

The fill loads the approved version's source file with ExcelJS and writes values into the data sheet from
`firstDataRow`, so the channel's own headers, instruction tabs, dropdowns and colours stay as the
marketplace made them; rows already holding example data are cleared first (values only). Shading uses
solid fills on data cells only: blocker light red `FFFFC7CE`, check amber `FFFFEB9C`. A **"Needs you"** tab
is added as the last tab when `extraTabsAllowed` is true, else written to the side file: first line "<n>
cells need you on <m> products. Fill or check each one, then upload this file in <Channel>."; then one row
per issue: Row, Cell, Identifier, Column, Problem, What to do, Must fix (yes for blockers). Sorted by row then
column. A file with no issue gets the line "Nothing needs you in this file." The output is always `.xlsx`.

A tier 1 round-trip test (8.1) proves, per parser fixture, that load and write keep every sheet, header,
list validation and header fill; if a real template loses a feature in the round trip (for example macros
or extension lists), the version's `layout.notes` records it and the step 3 page warns "This file loses
<feature> when we fill it. Check one upload with the channel manager first."

### 4.8 Validation and the independent re-read (`templates/validate.ts`)

Issues are collected while filling. Then the written buffer is read back with a fresh ExcelJS workbook and
every data row is checked against the column spec with no database: required columns empty, values outside
the allowed list, lengths over the limit, image counts under the minimum, type checks (`url` starts with
`https://`, `number` parses). The re-read issue list must equal the collected list (by cell and kind); any
difference adds a `reread_mismatch` issue and marks the fill `failed` (the file is still stored for
debugging, but not offered for download). This mirrors the links sheet's independent re-check (SPEC R24).

### 4.9 Details worksheet and report

The links sheet's "Details" worksheet (spec 12 s8.4) gains a block "Template checks" after its existing
content: per fill a header line "<Channel>, <template label> v<version>: <n> cells need you (<b> must be
fixed)", then one row per issue: identifier, cell, column, problem. A failed fill writes "<Channel>, <label>:
the file could not be made. <short error>. The links sheet is not affected." `report-v<k>.json` gains
`exports.templateFills` (2.6). The main worksheet and the CSV are unchanged, so `compareXlsxCsv` is unchanged.

### 4.10 Batch page and product page

Batch page Overview, downloads: after "Download filled product list", one link per done fill: "Download
<Channel> listing file (<label>)", with "<n> cells need you" or "Ready to upload" under it. Help line: "Fill
the shaded cells, then upload the file in the marketplace's portal. The module never sends it." A failed
fill shows "<Channel> listing file: could not be made. The links sheet is fine." A `no_template` line lists
the product types without a file. "Make files again" (operator and admin) appears when at least one fill
exists and every product's `last_batch_id` is this batch; otherwise its place shows "Some products were
updated in a later batch. Make the files from that batch." (finalize waits on products owned by a later
batch, `finalize.ts` `not_ready`, so the button never loops). The product page lists, per channel, "Listing
file: <label>, <n> cells need you" with the issues of its latest fill.

## 5. Ops panel "Template fills" (`apps/web/app/catalog/ops/page.tsx`)

Admin Ops page, new block "Template fills": per channel, active templates (label, version, evidence, owner,
approved on), fills in the last 7 and 30 days, products filled, share of cells filled, shaded, blank; the 10
columns most often left blank (by template); issues by kind; product types with no template (from
`no_template`); failed fills with their error; link to `/catalog/templates`. No model or vendor names exist
in this feature; the spec 07 banned-names test runs on every new string anyway.

## 6. Rollout

### 6.1 Internal phase

1. G0b and G10 done; the owner names the V1 channels.
2. An admin uploads each V1 template, confirms bindings on step 3 with Naaz, approves.
3. Finalize runs on a `catalog-test` re-finalize of one recent real batch per channel (no publish, no public
   write; fills under `catalog-test/`).

### 6.2 Golden fill per channel

For each V1 channel, Naaz fills the same approved template version by hand for one real batch of at least 20
products across the product types that template covers (the "hand file"). `pnpm catalog:template-compare
<fill.xlsx> <hand.xlsx>` compares cell by cell over the data rows (rows matched by identifier and size;
values normalised by trimming, case per column type, URLs exactly):
- **Wrong:** a cell the module filled whose value differs from Naaz's. **Zero allowed.**
- **Blank:** a cell Naaz filled and the module left blank. Allowed; reported per column as coverage.
- **Extra:** a cell the module filled that Naaz left blank. Shown to Naaz; counted as wrong if she says so.
A wrong value is fixed at its root (binding, master, fact bar, vocabulary row) and the compare re-run. The
result (cells, filled, wrong, blank, extra, per column) goes into the 00 section 10 report and becomes a
fixture of the eval (8.3). The final `write_bar` and `check_bar` are the lowest values with zero wrong.

### 6.3 Live

After the golden fill passes for a channel, its fills are offered on every batch with that channel ticked.
The operator uses the file for the next real portal upload of that batch and tells the manager whether the
portal accepted it (first upload per channel is a checked step: extra tab, shading and `.jpg` links, 11.2).
The agency's per-style template work for that channel can then be reviewed by the business; that decision is
not part of this spec.

## 7. V2 (described, built after V1 passes; same tables)

1. Remaining channels as their templates arrive, each with its own golden fill.
2. **Amazon product type definitions, read only.** `getDefinitionsProductType` for AE and SA per product type
   (for example `SHIRT`, `SHOES`, `HANDBAG`) builds a column spec (`source_kind amazon_ptd`, `documented`):
   required flags and enums from the JSON Schema. Needs an SP-API application with seller authorisation and
   a Secret Manager secret the owner creates; only `GET` calls, from a Cloud Run job gated like LIVE_SMOKE.
   https://developer-docs.amazon.com/sp-api/lang-US/docs/retrieve-a-product-type-definition
3. **Trendyol attribute list from its public API** (`trendyol_api`, `documented`): `getCategoryAttributes`
   and `getCategoryAttributeValues` per category used, refreshed weekly by a job, each refresh a new version
   with the 3.4 diff; `allowCustom` false means `list`, true means free text. Trendyol's file for upload is
   whatever its channel manager confirms (the panel Excel is unverified).
4. **Per-channel character limits and title formula** as data on the version: a title template over facts
   (for example "<brand> <audience> <colour> <pattern> <product type>") with the channel's limit, seeded from
   the India Cataloging Playbook rules (plan B1, PB:146-163, PB:228), shaded amber until approved per brand.
5. **Diff against the previous fill** of the same product and template: a "Changed since last file" column on
   the "Needs you" tab and a "Changed" filter, so the operator re-uploads only changed rows.
6. **Bilingual columns.** EN+AR templates keep Arabic columns blank with the note "Arabic text is not made by
   the module." on the "Needs you" tab (one line per column, not per cell).

## 8. Tests and evals

### 8.1 Tier 1 (`pnpm test`)

- Schema: zod accepts each parser fixture's spec; `blank` with `never_filled` cannot be rebound on a column
  tagged price, stock, offer, shipping or tax; approval refuses an unconfirmed binding, an unknown fact
  attribute and an overlapping match of equal specificity.
- Parsers on synthetic fixtures built in the test with ExcelJS: a NIS-like file (red, green, grey header
  fills, an instructions tab, list validations pointing at a hidden sheet, EN and AR headers, a size column);
  an Amazon-like flat file (labels row, attribute row, Valid Values tab, image locator columns, parent-child
  columns); a generic file (`*` and "mandatory" markers); a CSV. Each gives the expected spec exactly. A
  `.xls` or `.xlsm` upload is refused with its sentence.
- Round trip: load, fill and re-read keep every sheet, header, header fill and list validation of each fixture.
- Match: most specific template wins; no candidate gives `no_template`; a retired template is never used.
- Rows: `single`, `parent_child` and `size_rows` with 0, 1 and 4 `sku_map` sizes; `needs_sizes` on 0;
  parent-only and child-only columns land on the right rows.
- Values: every 4.4 binding; text cells for 13-digit identifiers; no placeholder text in any data cell; a
  too-long value written, never truncated, and shaded; an out-of-list brand left blank with its issue.
- Facts: unknown, brand sheet, operator and photo facts on both sides of `write_bar` and `check_bar`,
  `needsConfirmation`; with a V2 map row (documented and assumed) and without one; "half sleeve" never becomes
  "short sleeve" without a map row; `multi_enum` joining.
- Images: link order equals `SheetRow.links[channel]`; `image_list` joining and `max`; gaps; under the minimum;
  over the columns; `urlPattern`.
- Writing: shading colours on data cells only; the "Needs you" tab (or side file when `extraTabsAllowed` is
  false) lists exactly the collected issues; "Nothing needs you in this file." when none.
- Re-read: a planted mismatch (a cell changed after writing) gives `reread_mismatch` and a failed fill.
- Finalize: a throwing fill leaves the links sheet, the filled product list, the re-check and `status =
  'done'` unchanged; files land under the attempt path; `exports.templateFills` is written; the Details block
  is present; the CSV is unchanged and `compareXlsxCsv` still passes.
- Banned-names test (spec 07) over every new UI string, the "Needs you" tab and the Details block.
- No outbound HTTP: the fill module and the parsers make no network call (a fetch spy throws).

### 8.2 Tier 2 (PGlite, in-memory storage, facts stubbed through the 0.3 contract)

A batch of six products (two apparel with four sizes each, one apparel with no sizes, one shoe, one bag, one
product with no template) on noon and Namshi fixtures: finalize writes `links-v1`, two noon files (two
templates) and one Namshi file, with the expected rows, values, shading, issues and Details block; the admin
route flow (create, upload, edit draft, approve, retire) with role checks (operator and viewer get 403 on
writes; approved version `PUT` gives 409); "Make files again" writes `v2` fills after a fact changes; with a
later batch owning one product, the button is replaced by its sentence.

### 8.3 Evals (part of the scheduled eval job, no AI)

- **Golden fills:** each V1 channel's hand file and module fill from 6.2, stored as fixtures under
  `catalog-test/evals/templates/<channel>/` (product data only), re-run on every change to a parser, binding
  seed, fill rule, bar or vocabulary row; one wrong value blocks the change and alerts.
- **Template-parse regression set:** every approved template version's source (by `source_sha256`) and its
  approved column spec; the current parser must reproduce the approved spec except for admin-set fields, or
  the parser change is blocked. The set grows with every approval.

### 8.4 Tiers 3 and 5

Tier 3 (`REAL_DATA=1 pnpm test:real`): fills one recorded real batch against the real approved templates,
objects only under `catalog-test/`, deleted in `finally`. Tier 5: the deploy smoke opens `/catalog/templates`
as an admin and checks the Ops block renders; no fill is written by the smoke.

## 9. Acceptance checklist (the manager ticks each in the 00 section 10 report)

1. [ ] G0b approval typed by the owner and committed; migration applied by `catalog-migrate`; re-run is a
       no-op; `pnpm lint && pnpm typecheck && pnpm test` green.
2. [ ] SPEC.md carries the 0.4 amendments verbatim.
3. [ ] Spec 19 V1 contract used through its merged names (mapping recorded in the report if they differ).
4. [ ] `/catalog/templates` and its routes work for an admin; operators and viewers read only.
5. [ ] Each V1 template uploaded, parsed, bindings confirmed with Naaz, approved; evidence status recorded.
6. [ ] Every 8.1 and 8.2 case passes; the parse regression set holds every approved version.
7. [ ] Golden fill per V1 channel: zero wrong values; blank and extra counts per column in the report;
       `write_bar` and `check_bar` recorded.
8. [ ] One real batch per V1 channel fills on finalize, with the "Needs you" tab, shading, the Details block
       and `exports.templateFills`.
9. [ ] One real portal upload per V1 channel done by the operator from the filled file; the portal's answer
       recorded (accepted, or the exact rejection and the fix).
10. [ ] A forced fill failure leaves the batch Ready with its links sheet and re-check unchanged.
11. [ ] No marketplace write: a grep shows no Listings, Feeds or `createProducts` call and no marketplace
        host in worker or web code; the fill makes no network call.
12. [ ] Ops "Template fills" block shows per-channel numbers; the operator guide section exists.
13. [ ] No AI call added (no new ledger stage or kind; cost section 10 holds).
14. [ ] Report ends with "Ready for the next spec" or `Blocked: <exact thing needed>`.

**UX acceptance** (manager, from the operator's seat, on a real batch):
15. [ ] The download sits next to the links sheet and says how many cells need the operator.
16. [ ] Opening the file, the operator finds every cell to fill from the "Needs you" tab without reading
        anything else, and no cell holds placeholder text.
17. [ ] An admin adds a new template version without a deploy and sees what changed before approving.

## 10. Monitoring and cost

- Cost: V1 makes **no AI call** and no marketplace call: one ExcelJS load and write per fill inside finalize
  (seconds of worker CPU for a few hundred rows) and a few MB of private storage per batch. No new ledger
  stage, kind or spend engine. V2's Amazon and Trendyol reads are free API calls in a scheduled job.
- Logs: `template_fill` (batch, channel, template, version, rows, filled, shaded, issues by kind, ms) and
  `template_fill_failed` (alerted when the same template fails on two batches in a row);
  `docs/handover/monitoring-guide.md` gets the "fills with blockers per channel, last 7 days" query.
- Operator guide (`docs/handover/catalog-for-the-operator.md`), one section: what the listing file is, that
  the module never sends it, what red and amber mean, the "Needs you" tab, "Make files again", and that price,
  stock and Arabic text are always the operator's.

## 11. Settled and open questions

### 11.1 Settled

1. Fill, never submit; no marketplace write API in this spec (plan C decision 7, Sujan's brief 2026-10-28).
2. Templates, columns, bindings, bars and vocabulary are data, changeable by an admin without a deploy; every
   marketplace claim carries its evidence status (plan C decision 3).
3. Unknown stays blank; the module never guesses a value or a vocabulary mapping (plan C decision 2, B4).
4. The fill runs inside finalize and never fails it; the links sheet stays the primary deliverable.
5. Golden fill: zero wrong values, blanks allowed (Sujan's brief).
6. V1 has no AI cost; Arabic is never written.

### 11.2 Open (defaults apply; owner questions)

1. Q1. Which two channels are V1? Default: noon NIS and Namshi Excel; Amazon flat file third if provided.
2. Q2. Do portals accept a file with an extra "Needs you" tab and shaded cells? Default: assumed yes,
   checked on the first upload (6.3); `extraTabsAllowed` false moves the tab to a side file.
3. Q3. Amazon flat files come as `.xlsm` with macros; ExcelJS writes `.xlsx` only. Default: ask the Amazon
   channel manager for the `.xlsx` download or confirm Seller Central accepts `.xlsx`; else Amazon waits for
   V2's API-based spec.
4. Q4. noon's help page says image links "ending .JPEG"; module links end `.jpg` and are pasted into noon
   today. Default: write them as they are; confirm with the noon channel manager.
5. Q5. Size rows from `sku_map` (warehouse brands) versus a parent row only. Default: `sku_map` when present
   (an existing master, 4.3), `needs_sizes` otherwise. Confirm that noon partner SKU per size equals the
   Opptra SKU.
6. Q6. Which column is the seller SKU per channel (product code, style-colour id or Opptra SKU)? Default: the
   admin binds it per template on step 3 with Naaz; the golden fill proves it.
7. Q7. Who owns keeping templates current when a marketplace changes them? Default: the channel manager named
   as `owner`, with the admin uploading the new version.
8. Q8. Ashish's own templates (R11): are they marketplace files or an internal master sheet? Default: treated
   as `generic_xlsx` templates of their channel once he shares them.

## 12. Templates to obtain, and from whom (gate G10)

| Channel | What | From | Notes |
|---|---|---|---|
| noon | NIS "With Instructions" Excel per fashion family the brands sell (tops, bottoms, dresses, footwear, bags; EN+AR) | Opptra noon channel manager (Seller Central partners login) | documented layout; V1 candidate |
| namshi | the Excel catalog upload template and the "Namshi catalog sheet" mentioned on 21 Oct | Opptra Namshi channel or vendor manager; Naaz for the sheet already in use | V1 candidate |
| amazon AE, SA | flat file per product type (`SHIRT`, `PANTS`, `DRESS`, `SHOES`, `HANDBAG`), `.xlsx` if possible; written OK for read-only SP-API calls (V2) | Opptra Amazon channel manager | third V1 channel if it arrives |
| trendyol | confirmation of the upload path (panel Excel or API) and read-only API credentials (V2) | Trendyol channel manager | attributes public through the API |
| styli, centrepoint, sixthstreet | line sheet or content template used by the retailer's team | each key account manager | managed models; nothing public |
| shein, vogacloset | Seller Hub template; integrator channel sheet | each channel manager | V2 |
| all | agency-filled files from recent listings (21 Oct L20-21) and Ashish's templates (R11) | Naaz, Ashish | best references for bindings and the golden fill |

No template file is committed to the repo; sources live only in the private bucket (2.5). Templates hold no
customer data; filled files hold product data only.
