# M0 Catalog graph and change log - requirements (2026-11-02)

Status: draft for Sujan's review. Planning only; no code changed. Follows `00-template.md`. Feature ids and
priorities come from `../module-map.md` section M0. Every other module depends on this one, so its contract (section
3) is written to be small and stable.

Words used here (defined once):
- **Option**: one style in one colour (for example a polo shirt in navy). Sales data counts at this level
  (`gcc_marketing.sku_option.option_id`). An option has several **SKUs** (one per size).
- **Channel listing**: one option on one marketplace in one country, such as "this navy polo on Noon UAE".
- **Content version**: one immutable piece of content (an image, a title, a bullet), stored once with where it came
  from and a fingerprint.
- **Slot**: a place on a listing that holds one content version at a time, such as "image 3" or "title".
- **Hash** (fingerprint): a short code computed from the exact bytes or text. Same content, same hash.
- **Perceptual hash**: a fingerprint of how an image looks, so a resized or re-compressed copy on a marketplace still
  matches the original.
- **Change event**: one row in an append-only log that says "slot X of listing Y changed from version A to B, at
  this time, because of Z, and here is the evidence".
- **Treatment assignment**: which experiment arm (treatment, control) a listing is in, from M4.
- **Outcome link**: the keys that join a listing to sales, ads, stock and price rows in BigQuery.
- **Idempotent**: doing the same write twice has the same effect as doing it once (safe to retry).

## 1. Purpose

- **Why:** no table records which content was live on which marketplace and when, so no content change can be tied
  to sales (outcome baseline, summary item 8). M0 is the one record of options, listings, content versions and the
  dated change log, joined to the sales keys.
- **Outcome metric:** share of published content with a verified live date and a resolved sales join key (baseline 0%
  outside Trendyol; target 95% of Namshi, Noon and Trendyol slice listings within 7 days of publish).
- **Intents:** I004, I010, I020, I024, I038 (also enables I014, I017, I025 through other modules).

## 2. Scope

**In (first slice):**
- Options, SKUs and channel listings for GCC softline, with every channel key the warehouse has (zsku, partner SKU,
  barcode, ASIN, child zsku).
- Content versions for images (brand photos, crops, cleaned and upscaled renders, generated images later) with role,
  position, source, hash and lineage (which version it was made from).
- The change log and the derived "what was live where and when" table, with live verification from Trendyol, Amazon
  and Noon ad data that already lands in BigQuery, plus an intake for M9's scrape of Namshi and Noon.
- Treatment assignments and the "do not touch" guard for control listings.
- Backfill of every existing tool output and source photo; Supabase history once access exists.
- A daily export to BigQuery (`catalog_os.*`) next to `fact_gcc`.

**Out:** being a PIM (no attribute editing screens, no workflow), storing sales numbers (they stay in BigQuery and are
M4's), scraping marketplaces (M9), deciding experiments (M4), channel rules (M5).

**Later:** change reasons as a required field (P1), variants and size runs (P1), brand master with channel overlays
(P1), hardline and India options (same tables, loaded when those lines start), multi-tenant isolation (M12, when a
second customer exists; the `org_id` column itself ships in P0 on every new table), the rich-media roles and sources
M11 needs (`infographic`, `scene`, `aplus_module`, `video`; `code_drawn`, `composite`; `renders_text_ids`), added by an
additive migration when M11 starts.

## 3. Contracts

### 3.1 Entities (the graph)

Reuse first. Five existing tables already hold part of the graph and stay the source of truth for what they hold:

| Entity | Table | New or reused | Key | What it holds |
|---|---|---|---|---|
| Brand | `brand_master` | reused | `slug` | Brand name, softline or hardline, warehouse or manual |
| SKU | `sku_map` | reused | `opptra_sku` | Size-level SKU, EAN, colour, size, option id, `channel_ids` (15 channel key columns), synced from `raw_gcc_dimensions.master_sl` by `master-sync.ts` |
| Tool product | `catalog_products` | reused, one new column | `id` | The image tool's product (one identifier per brand); links to an option through `option_id` (new, nullable) |
| Source photo | `catalog_source_images` | reused | `id`, `sha256` | Brand photos the tool received, per batch, with `is_current`, `replaces_id` |
| Rendered image | `catalog_outputs` | reused, one new column | `id` | One image per product x channel x position, with public URL, `is_live`, `published_at`, `superseded_at`; links to its content version through `content_version_id` (new, nullable) |
| **Option** | `catalog_options` | **new** | `id`; unique `(brand_slug, option_key)` | One row per style-colour. `option_key` = the warehouse option id (`sku_map.option_id_style_color`, else `gcc_marketing.sku_option.option_id` for the SKU, else `sku:<opptra_sku>` for the 935 SKUs with neither). Holds brand, line, product type, department, audience, `key_source` (master, sku_option, sku_fallback), and the style key: `style_key`, `style_key_source` (brand_style_code, name_colour_rule, own_cluster), `style_key_confidence` (0-1) (F1-R8) |
| **Channel listing** | `catalog_channel_listings` | **new** | `id`; unique `(option_id, channel, market)` | One row per option x channel x country. `channel` uses the existing `CHANNEL_IDS`; `market` is `ae` or `sa` (or `ae_sa` where a channel has one key for both, such as `styli_ae_ksa`). Holds `status` (unknown, live, not_live, not_listed), `first_seen_live_at`, `last_verified_at` |
| **Listing key** | `catalog_listing_keys` | **new** | unique `(channel, market, key_kind, key_value)` | Every key a listing is known by, at SKU level: `opptra_sku`, `key_kind` (zsku, child_zsku, partner_sku, barcode, asin, seller_sku, style_id), `key_value`, `source` (master, sales, scrape, manual), `first_seen_at` |
| **Asset** | `catalog_assets` | **new** | `sha256` (primary) | One row per distinct binary (image or later video): `uri` (gs://), `mime`, `width`, `height`, `bytes`, `phash` (64-bit perceptual hash), `first_seen_at` |
| **Content version** | `catalog_content_versions` | **new** | `id`; unique `(option_id, scope, component, content_hash, producer, producer_ref)` | Immutable. `component` (image, title, bullet, description, attribute, size_chart, keyword; video later). `scope` (master, or a channel id). `role` for images (front, back, side, detail, head_shoulders, full_length, flat, packshot, size_chart, unknown). `position` (1-based, the slot it was made for). `source` (brand, scraped_live, crop, cleanup, upscaled, generated, vendor, operator). `ai_generated` (bool, never null). `producer` (module id M1-M11 or `backfill`) and `producer_ref` (for example an output id). `asset_sha256` for binaries or `text_value` / `json_value` for text and attributes. `content_hash` = sha256 of bytes or of the normalized text. `parent_version_ids` (lineage). `public_url` (the tool link, if any). `language` (`en`, `ar` or null for images), `market` (null when the version serves every market of the channel), `route_id` (the M7 route that made it, null for brand photos and code-only renders; never shown to operators), `prompt_version` (null unless a model wrote it), `settings_snapshot_id` (the M12 settings version set the batch used), `org_id` (default `opptra`), `batch_id`, `is_test`, `created_by`, `created_at` |
| **Change event** | `catalog_change_events` | **new** | `seq` (bigserial, the read cursor); unique `idempotency_key` | Append-only. `listing_id`, `slot` (component + position, for example `image:3`, `title`), `from_version_id`, `to_version_id` (null = slot emptied), `kind` (see 3.2), `at` (when it happened, not when it was written), `recorded_at`, `evidence` (channel_field, scrape, tool_publish, channel_upload_record, operator, backfill), `evidence_ref` (table and row, scrape id, file), `actor`, `reason_kind` (rule, experiment, operator, learning, outside_change, backfill, auto_decide, rejection_fix, new_content; **required on every new event from P0**, see F3-R9), `reason_ref` (rule id, experiment id, winner or promotion id, rejection id), `change_type_id` (from the M10 change-type table v0; null only for `observed_other` and backfill rows the classifier has not reached), `change_set_id` (groups events across listings and slots that one decision made, for example one keyword winner or one treatment upload), `batch_id`, `experiment_id`, `org_id` |
| **Live interval** | `catalog_live_intervals` | **new, derived** | unique `(listing_id, slot, valid_from)` | Rebuilt from change events: which version held a slot from when to when, and whether that is `verified` (seen on the channel) or `assumed` (delivered but not yet seen). This is the table that answers "what was live where and when" |
| **Treatment assignment** | `catalog_treatment_assignments` | **new** | unique `(experiment_id, listing_id)` | Written by M4 only. `arm` (treatment, control, excluded), `pair_id`, `assigned_at`, `frozen_at`, `do_not_touch` (bool), `released_at` |
| **Outcome link** | view `catalog_outcome_keys` (and its BigQuery copy) | **new, derived** | `(listing_id, key_kind, key_value)` | The join from a listing to `fact_gcc.unified_sales_tertiary_v2` (mapped SKU, EAN, channel SKU, `style_id`), `gcc_marketing.ads_daily` (channel SKU), `catalog_live_noon_3p_*` (partner SKU), Trendyol (barcode), Amazon (seller SKU, ASIN) |

Ids are uuid like the existing tables. Every new table gets the repo's CHECK-constraint pattern for text enums
(`enumCheck` in `schema.ts`).

### 3.2 Change event kinds (the change log)

| Kind | Written by | Meaning |
|---|---|---|
| `planned` | the producing module | A version is intended for a slot (for example, a crop for Noon image 4) |
| `links_delivered` | publish (today `pipeline/publish.ts`) | The tool's public link now serves this version (the object at the stable URL changed) |
| `submitted` | channel team record, or M9 later | The listing file or bulk upload with this version was sent to the channel |
| `verified_live` | M0 verifier | The channel's own data or our scrape shows this version in this slot |
| `observed_other` | M0 verifier | The channel shows content in this slot that matches none of our versions (an outside change, or the channel's own crop) |
| `removed` | publish, or verifier | The slot is empty on the tool link or on the channel |
| `reverted` | any module | Back to an earlier version (for example, an experiment stopped) |

"Live on the channel" starts at `verified_live`, not at `links_delivered`. Until verified, the live interval is
`assumed` and starts at the `submitted` time (or the `links_delivered` time when no submit record exists).

### 3.3 What other modules read and write

The one small contract from the module map: **content version in, outcome join key out.**

| Module | Writes to M0 | Reads from M0 |
|---|---|---|
| M1 Intake | `planned` and `links_delivered` events (through publish), reason `auto_decide` for provisional picks | Option and listing resolution for an identifier; brand and channel history for defaults; last live versions per slot |
| M2 Analyze | Readings, taxonomy and gap reports in M2's own tables keyed by asset sha256, version id and option id; trusted listing attributes (P1) as attribute versions, scope master | Versions and assets to analyze |
| M3 Images | Image versions with role, source (crop, cleanup, upscaled, generated), lineage, `ai_generated` | Source versions; frozen flag before making anything |
| M4 Measurement | Treatment assignments, freezes, releases | Live intervals, outcome keys, change events per listing (BigQuery export) |
| M5 Rules | Rule results in M5's own `catalog_rule_results` table keyed by content version id; `reason_kind = rule` with rule id and ruleset version on changes a rule caused | Listing channel and market, slot roles (to check a set) |
| M6 Cost | nothing (cost rows carry `content_version_id` where known) | Version and batch ids to price cost per version and per option |
| M7 Quality | Audit results as version annotations (P1) | Versions and lineage (to compare a generated image with its source) |
| M8 Text | Text and attribute versions | Master versions, channel overlays (P1) |
| M9 Publish and monitor | `submitted` events; scrape observations through `recordObservation` (M0's verifier does the matching for every source, F3); gallery-level verification states (partial, reverted, not_found) in M9's own table | Live intervals, listing keys, change events by cursor |
| M10 Learning | `reason_kind = learning` with recommendation or promotion id on its changes; the change-type table v0 that every producer stamps on its events | Change events by cursor (it classifies from `from_version_id` and `to_version_id`; M0 stores no diff), live intervals, outcome keys |

### 3.4 API shape

All modules live in one repo and one database, so the contract is a TypeScript module, not a network service:
`packages/core/src/graph/` (new). Every write is idempotent and runs inside the caller's transaction when one is given.

```ts
// Resolution
resolveOption(input: { brandSlug: string; identifier?: string; opptraSku?: string; optionId?: string; ean?: string }): Promise<OptionRef | null>
resolveListing(input: { channel: ChannelId; market: Market; keyKind?: KeyKind; keyValue?: string; optionId?: string }): Promise<ListingRef | null>
resolveOptions(inputs: ResolveInput[]): Promise<(OptionRef | null)[]>   // bulk, up to 2,000 per call (M1 grouping)

// Versions (content in)
recordVersion(v: NewContentVersion): Promise<{ versionId: string; created: boolean }>   // dedupes on the unique key
recordAsset(a: NewAsset): Promise<{ sha256: string; created: boolean }>

// Change log
recordChange(e: NewChangeEvent): Promise<{ seq: bigint; created: boolean }>             // idempotency_key required
recordObservation(o: { listingId: string; slot: Slot; observedAt: Date; source: "scrape" | "channel_field"; assetUrl?: string; phash?: string; text?: string; ref: string }): Promise<ObservationResult>
readChanges(afterSeq: bigint, limit: number, filter?: { kinds?: ChangeKind[]; listingIds?: string[] }): Promise<ChangeEvent[]>
liveAt(listingId: string, at: Date): Promise<Record<SlotKey, { versionId: string; state: "verified" | "assumed" } | null>>

// Guards (experiments)
isWritable(listingId: string, ctx?: { experimentId?: string }): Promise<{ ok: true } | { ok: false; reason: "frozen_control" | "frozen_treatment"; experimentId: string }>
// frozen_treatment: a treated listing accepts only changes that carry its own experiment id (the registered treatment)
isWritableMany(listingIds: string[], ctx?: { experimentId?: string }): Promise<Map<string, WritableResult>>   // bulk
assign(a: NewAssignment): Promise<void>   // M4 only; refused for any other producer

// Outcome link (key out)
outcomeKeys(listingId: string): Promise<{ keyKind: KeyKind; keyValue: string }[]>
```

Read API for the web (batch and product pages, Ops): `GET /api/catalog/graph/listings/:id/history` (live intervals
and change events, newest first, 50 per page) and `GET /api/catalog/graph/options/:id` (listings, keys, current live
versions). Viewer role can read; no write endpoints are exposed to the browser in P0.

No queue is needed. Consumers read the change log by cursor (`seq`), which is simpler and survives deploys (a
consumer stores its last `seq`).

### 3.5 Contract needs from M0 (summary for the other module docs)

M0 provides: option and listing resolution from any key (single and bulk); a style key per option with its source and
confidence (the M4 randomization unit); immutable versions with hash, perceptual hash, lineage, language, market and the
route that made them; an idempotent change log with a cursor, a required reason, a change type and a change set id;
`liveAt`; `isWritable` (frozen controls, and treated listings open only to their registered treatment); outcome keys;
the one live-verification matcher for every evidence source; the daily BigQuery export.

M0 does not provide, and the owning module keeps in its own tables keyed by M0 ids: the taxonomy, attribute definitions,
readings and gap reports (M2); rules, rule results and image policies (M5); experiments, registry and readouts (M4);
audit items, golden cases, routes and `pulled` marks (M7); gallery verification states, rejections and listing files
(M9); change types and classifications (M10); settings versions (M12). M0 does not scrape, score or hold sales numbers.

Consumers read the change log by cursor (`readChanges`). No module calls another module's API from inside an M0 write
(for example M0 does not call M4 or M10 on publish); M4 and M10 read the log.

## 4. Features

### M0-F1 Product and listing graph (P0)

**User story.** As the measurement owner (M4) and as any module that publishes, I want one record per option and per
option x channel x country with every key the channels and the warehouse use, so I can join content to sales and know
which listing a product in a batch is.

**Functional requirements.**
- M0-F1-R1: A sync step builds `catalog_options` from `sku_map` (16,358 softline SKUs, about 4,075 options) after each
  master sync (`apps/worker/src/catalog/sync-master.ts`), with no deletes; a SKU that leaves the master keeps its
  option row with `in_master = false`.
- M0-F1-R2: `option_key` is resolved in this order: master option id, then `gcc_marketing.sku_option.option_id` for
  the SKU, then `sku:<opptra_sku>`. `key_source` records which one was used.
- M0-F1-R3: For each SKU, every non-empty `sku_map.channel_ids` value becomes a `catalog_listing_keys` row under the
  listing it belongs to, mapped as: `namshi_ae`/`namshi_sa` to namshi ae/sa, `noon_ae`/`noon_sa` to noon ae/sa,
  `trendyol` to trendyol (market from the sales rows, else `ae_sa`), `centerpoint_ae_ksa` to centrepoint `ae_sa`,
  `sixth_street_ae`/`_sa`, `styli_ae_ksa` and `styli_sku`, `amazon` and `amazon_uae_ksa_asin` to amazon, `voga_closet`,
  `shein`, `child_zsku` as a key on every listing of the SKU.
- M0-F1-R4: Keys seen in sales rows (`fact_gcc.unified_sales_tertiary_v2` channel SKU and `style_id`) and in channel
  reports (Noon partner SKU, Trendyol barcode, Amazon seller SKU) but missing in the master are added with
  `source = sales` or `channel_report`, so the join works even where the master is blank.
- M0-F1-R5: A key that points at two different listings is not written; it goes to a conflict list (shown on the Ops
  page and in the export as `catalog_os.key_conflicts`) with both candidates.
- M0-F1-R6: Every `catalog_products` row gets `option_id` set when its identifier, its `opptra_sku_ids` or its
  `option_id_style_color` resolve to exactly one option. Products that do not resolve stay null and are counted.
- M0-F1-R7: Listing `status` is updated from the liveness data the tool already reads (`catalog-liveness-job` output
  and channel live exports) at most daily; it never blocks a batch.
- M0-F1-R8 (style key, P0 because M4 randomizes by style): every option gets a `style_key` that groups the colour
  siblings of one design. Order: the brand sheet's style code where present; else a name-and-colour rule (the option
  name with the colour token removed, within one brand and department), with a confidence; an option the rule cannot
  place with confidence of at least 0.8 (admin setting) becomes its own cluster (`own_cluster`). The warehouse has no
  style id (`unified_sales_tertiary_v2.style_id` equals the option, checked 2026-11-02). M4 reads the key; the channel
  team may confirm sibling groups for the top 200 styles (M4 risk table), stored as `brand_style_code` rows. Parent-group
  keys per channel and size runs stay P1 (F7).

**Non-functional.** Full rebuild of options, listings and keys for 16,358 SKUs in under 5 minutes; incremental sync
under 1 minute. Uses at most 1 database connection (the job budget in `infra/deploy.sh`). Cost under USD 0.10 a day.

**Admin configuration (no deploy).** The key mapping table (which `channel_ids` column maps to which channel, market
and key kind) is a data row set, editable by an admin through M12 later; P0 keeps it as a seeded table
`catalog_key_mappings` so a new channel column needs no code change.

**Inputs and outputs.** In: `sku_map`, `brand_master`, BigQuery sales and channel report keys. Out: options, listings,
keys, key conflicts.

**Human in the loop.** None in the flow. The data team owns fixing key conflicts at the source (the master sheet);
the Ops page lists them. Goes away as the master is cleaned.

**Edge cases and failure modes.**
- 935 SKUs have no option id: they become one option each (`sku:` key), flagged `key_source = sku_fallback`, and are
  re-keyed automatically when the master gains an option id (the old key is kept as an alias row).
- FC UK and Vero Moda no-category rows (257 and 528) inflate the option count: they are counted separately in the
  metric.
- The literal value "0" and blank strings in key columns are ignored.
- BigQuery unavailable: the sync keeps the previous graph and retries next run; it never empties a table.

**Buy or build.** Build (thin). PIMs (Salsify, Akeneo, Pimcore) hold products but none hold GCC channel keys joined to
our sales; a PIM would add a second source of truth and a sync. Fallback: none needed.

**Acceptance tests.**
1. After one sync, a query of `catalog_os.outcome_keys` joined to `fact_gcc.unified_sales_tertiary_v2` for the last 12
   weeks matches at least 99% of softline Namshi and Noon sale rows to a listing (the rest listed by reason).
2. For a Vero Moda SKU with no option id, the option exists with `key_source = sku_fallback`; after the master gains an
   option id and the sync re-runs, the option carries the new key and the old key resolves to it.
3. A key planted on two listings appears in the conflict list and is not written.
4. Every softline option has a `style_key`; U.S. Polo options group into styles at about 1.9 options per style (the
   2026-11-02 heuristic), and every option under the confidence bar is its own cluster.

**Open questions.**
- Q: Should Trendyol be split by market when the master has one key? Default: yes, from the sales rows' country; else
  `ae_sa`.
- Q: Should the 935 fallback SKUs be grouped into options by name and colour? Default: no in P0 (wrong grouping would
  pollute experiments); revisit with M0-F7 variants.

### M0-F2 Content versions (P0)

**User story.** As any module that makes content, I want to store each image or text once, with what it is, where it
came from and what it was made from, so that every link we hand out and every experiment arm points at an exact,
unchangeable piece of content.

**Functional requirements.**
- M0-F2-R1: Every source photo accepted by ingest is recorded as an asset (by its existing `sha256`) and a version with
  `source = brand`, `scope = master`, `position = n`, and `role` (from M2 when known, else `unknown`).
- M0-F2-R2: Every output the pipeline renders is recorded as a version with `scope = <channel>`, `source` from its
  flags (`cleanup` for a cut-out render, `upscaled` when flagged `upscaled`, `crop` for M3 crops, `generated` for M3
  mode A), `parent_version_ids` = its source photo version (and the crop's parent), and `producer_ref` = the output
  id. `catalog_outputs.content_version_id` is set in the same transaction as the render row.
- M0-F2-R3: The output's `content_hash` is the sha256 of the bytes written to staging. The pipeline already has the
  bytes in memory when it stages; it hashes them there (no extra read).
- M0-F2-R4: `ai_generated` is true for `source = generated` or `vendor` with a generative capability, false otherwise,
  and is never null (this is the field M3's AI-image flag and Noon's "photographs only" rule need).
- M0-F2-R5: Versions are never updated or deleted, except test batches' versions (`is_test = true`), which test
  cleanup may delete with their batch. A correction is a new version.
- M0-F2-R6: Recording the same content twice from the same producer returns the existing version id (`created: false`).
- M0-F2-R7: Each asset stores a 64-bit perceptual hash (difference hash on a 9x8 grey thumbnail), computed once when
  the asset is first recorded, for live verification.
- M0-F2-R8: 100% of outputs written after M0 ships have a `content_version_id`; a nightly invariant (in the existing
  `catalog-invariants` job) reports any that do not.

**Non-functional.** Adds under 5 ms and one insert per output to the render path; the perceptual hash adds under 20 ms
per asset on the worker CPU. Storage: about 300 bytes per version row; 1 million versions is about 300 MB in `ila-pg`.
No new connections (runs in the existing worker transactions).

**Admin configuration.** The role list and source list are fixed enums in P0 (structure, not business settings, per
gate 1). The perceptual hash distance used for matching (F3) is a business setting.

**Inputs and outputs.** In: source images and outputs from the pipeline. Out: assets and versions.

**Human in the loop.** None.

**Edge cases and failure modes.**
- The same photo uploaded for two products: one asset, two versions (different options).
- A re-render with identical bytes: same `content_hash`, so the same version is reused.
- An output that fails before staging gets no version (nothing was made).
- A version insert fails: the render transaction fails and the existing chunk retry runs (no output without a version).

**Buy or build.** Build. PIMs keep versions (Pimcore is praised for it) but not joined to channel sales, and the tool
already writes the underlying rows.

**Acceptance tests.**
1. Run a real 20-product batch on the preview stack. Every output row has a `content_version_id`; every version's
   asset sha256 matches a fresh sha256 of the public object; every output version names its source photo version as
   parent.
2. Re-run the same batch unchanged: no new versions are created (counts identical).

**Open questions.**
- Q: Store text versions in Postgres or GCS? Default: Postgres `text_value` (titles and bullets are short); long
  descriptions over 16 KB go to GCS with the hash in the row.

### M0-F3 Treatment log and live verification (P0)

**User story.** As the measurement owner, I want to know the date each version actually appeared on each channel,
confirmed by the channel's own data or a scrape, so that an experiment's pre-period and post-period are correct.

**Functional requirements.**
- M0-F3-R1: Publish (`pipeline/publish.ts`, in the same transaction that sets `is_live`) writes one
  `links_delivered` change event per changed slot of each listing of the product's option on that channel (both
  markets when the channel uses one image set for AE and SA), with `idempotency_key = publish:<output_id>`.
- M0-F3-R2: A removal (`shots_removed`, a slot emptied) writes a `removed` event with `to_version_id = null`.
- M0-F3-R3: A `submitted` event is recorded when the channel team uploads a batch's sheet to a channel. P0 path: one
  "Uploaded to <channel> on <date>" action per batch and channel on the batch page (a single click, optional, never
  required). When nobody records it, `submitted` is not written and the verifier's first sighting is used.
- M0-F3-R4: A daily verifier job compares each listing's expected versions with channel evidence already in BigQuery:
  - Trendyol: `gcc_channel_reports.product_list_trendyol_3p_*` `image_1..8` per barcode per day (since 15 Oct).
  - Amazon: `active_listings_amazon_3p_*` main `image_url` per seller SKU per day (since 17 Oct).
  - Noon: `raw_noon_admanager.campaign_product` main `image_key` for advertised SKUs (since 2 Sep).
  - Namshi and Noon galleries: observations from M9's scrape through `recordObservation`.
  It downloads each changed channel image once (cached by URL), computes its perceptual hash and matches it to the
  listing's versions for that slot within the configured distance.
- M0-F3-R5: A match writes `verified_live` with `at` = the first channel day that showed it and
  `evidence_ref` = table, key and day. No match writes `observed_other` with the channel image recorded as an asset
  with `source = scraped_live` (so outside changes become versions too).
- M0-F3-R6: `catalog_live_intervals` is rebuilt for every listing touched by a new event, so the table is correct
  within one run of the verifier (daily).
- M0-F3-R7: `isWritable` returns `frozen_control` for any listing with a `do_not_touch` assignment; `recordChange`
  refuses `planned` and `links_delivered` events for such listings (the write fails with that reason), so a control
  option can never be published to. M3 and M1 check `isWritable` before making content, so no money is spent on it.
  A treated listing in a running experiment returns `frozen_treatment` for any change that does not carry that
  experiment's id, so the arm stays one nameable change (M4-F2-R5).
- M0-F3-R8: A `observed_other` on a listing in an active experiment raises a contamination incident (written to M6's
  incident table and shown to M4) the same day. M0 detects; M9 sends the alert (M9-F1-R7); M4 accounts for it.
- M0-F3-R9: Every new change event names `reason_kind` and `change_type_id` (M10's taxonomy v0 seeds the ids in the
  first slice); the write fails without them, except `observed_other` (no type yet) and backfill rows. Rule and
  experiment ids go in `reason_ref`. P1 (F6) adds not-live reasons and full `reason_ref` coverage, not the field itself.
- M0-F3-R10: The perceptual hash match distance is one setting used by every verifier path, including M9's scrape
  observations (default 6 of 64 bits; distances from 7 to 12 are "uncertain" and stay `assumed`).

**Non-functional.** Verifier runs in under 30 minutes a day for about 30,000 listings; downloads only images whose
channel URL changed since the last run (Trendyol showed 69 of 17,544 barcodes changing in two weeks). Cost under USD 1
a day. Verified-live lag: under 2 days after the channel shows the change, for channels with daily data.

**Admin configuration.** Perceptual hash match distance (default 6 of 64 bits); channels and evidence sources in
scope; the verifier schedule; whether `submitted` records are shown on the batch page.

**Inputs and outputs.** In: publish events, channel tables in BigQuery, scrape observations. Out: change events, live
intervals, contamination incidents.

**Human in the loop.** The channel team's optional "uploaded on" click (F3-R3) improves dating; it goes away when M9
pushes listing files itself or the verifier covers the channel daily. No one reviews matches; uncertain matches
(distance between the threshold and twice it) are counted in the export, not queued.

**Edge cases and failure modes.**
- Channels re-crop or pad images: perceptual hash on the padded image can drift. Mitigation: hash on the trimmed
  content box (pad colour cropped first); the threshold is a setting; uncertain matches are kept as `assumed`.
- The same image in two slots (a duplicate shot): match by slot order first, then any slot, with a note.
- A channel table stops updating (Noon traffic stopped 4 Feb; Centrepoint stops 17 Oct): the verifier marks the source
  stale after 3 missing days and lists it on the Ops page; intervals stay `assumed`.
- Image download blocked or slow: retried with `retryTransient`; after 3 days unresolved the slot stays `assumed`.
- Controls edited outside the tool by an ads or merchandising team: caught by `observed_other` (R8).

**Buy or build.** Build. Nobody verifies content live per marketplace for the GCC; digital shelf vendors (42Signals
for Noon, Profitero, DataWeave) sell scraped content data and are the fallback evidence source if our scrape is blocked
(M9 decides).

**Acceptance tests.**
1. Publish a changed render (for example the new 240 grey background; crops are not published on Trendyol, gate 1) to a
   Trendyol listing in a real batch; within 2 days of the channel showing it in
   `product_list_trendyol_3p`, `catalog_live_intervals` shows that version `verified` from that day, and the BigQuery
   export has the same row.
2. Assign a listing to control in a test experiment; a batch that includes its product completes, the product's other
   listings get links, and this listing gets no `links_delivered` event and no new output (the digest says why).
3. Change a test listing's image on Trendyol by hand; the next verifier run writes `observed_other` and an incident.

**Open questions.**
- Q: Who records "uploaded on"? Default: the channel team member who uploads, one click; skip if they do not.
- Q: Should Amazon AE main-image verification count, given the small volume? Default: yes, it is free data.

### M0-F4 Backfill of past outputs (P0)

**User story.** As the measurement owner, I want past tool outputs and brand photo history loaded as versions, so
pre-periods and "what was there before" are known for the first holdout.

**Functional requirements.**
- M0-F4-R1: A one-off, resumable job (`catalog-graph-backfill`, Cloud Run job on the worker image) loads every
  non-test `catalog_source_images` row and every `catalog_outputs` row ever published (`published_at` not null) as
  assets and versions, with `producer = backfill`.
- M0-F4-R2: Outputs have no stored sha256 (only `crc32c` and `generation`). For live outputs the job reads the public
  object once and hashes it. For superseded outputs whose object version is gone (7-day soft delete), it records the
  version with `content_hash = crc32c:<value>` and `hash_kind = crc32c`, and no asset.
- M0-F4-R3: For each output it writes `links_delivered` at `published_at` and, if `superseded_at` is set, the
  successor's event; reason `backfill`.
- M0-F4-R4: Trendyol `image_1..8` history since 15 Oct and Amazon main image since 17 Oct are loaded as observations
  (F3), which gives a channel-verified baseline for those listings.
- M0-F4-R5: Supabase brand folders (us-polo, campus, penti, `softlines/` 3,545 folders, `product-images` India) are
  loaded as `source = brand` assets and versions mapped to options through the folder name (parent zsku), once
  read-only Supabase access is granted (gate-1 decision 3). Placeholders under 1 KB (1,986 files) are skipped and
  counted.
- M0-F4-R6: The job checkpoints after every 500 rows (a cursor row in `catalog_backfill_runs`) and can be stopped and
  resumed; a re-run creates nothing new.
- M0-F4-R7: It runs only when no batch is processing and the connection budget allows (rule from the go-live
  retrospective), at a capped rate (default 20 rows per second).

**Key requirement for P0 acceptance.** Share of historical outputs loaded (target 100% of published non-test outputs;
Supabase share reported separately).

**Acceptance test.** After the run, every published non-test output has a version, the count report shows loaded,
hashed by sha256, hashed by crc32c only, and skipped with reasons, and a second run reports 0 new rows.

**Buy or build.** Build (internal data). **Open question:** Supabase access date. Default: run outputs and Trendyol now,
Supabase as a second pass when access lands.

(F4 is P0 in the map; it is written at medium depth because it is a one-off job with no operator surface.)

### M0-F5 Daily export to BigQuery (P0)

**User story.** As the measurement owner and the data team, I want the graph in BigQuery next to `fact_gcc` so
experiments and dashboards join content to sales without touching the live database.

**Functional requirements.**
- M0-F5-R1: A daily Cloud Run job (`catalog-graph-export`) writes `catalog_os.options`, `listings`, `listing_keys`,
  `key_conflicts`, `content_versions` (no binaries; URLs and hashes), `change_events`, `live_intervals`,
  `treatment_assignments` and `outcome_keys` to a BigQuery dataset in `asia-south1` (the same location as
  `opptra-datawarehouse`, so cross-project joins work).
- M0-F5-R2: Change events export incrementally by `seq`; other tables are full snapshots written to a staging table
  and swapped in one step, so readers never see a half-written table.
- M0-F5-R3: Test batches (`is_test = true`) are excluded.
- M0-F5-R4: Each run writes a row to `catalog_os.export_runs` (started, finished, rows per table, max `seq`), and the
  Ops page shows freshness. An export older than 24 hours raises an alert (existing `infra/monitoring.sh` pattern).
- M0-F5-R5: The export reads from the database with one connection and a read-only transaction, in pages of 5,000
  rows, and runs after 02:00 UTC when operator use is lowest.

**Non-functional.** Under 15 minutes per run at 1 million versions; BigQuery storage and load cost under USD 5 a month.

**Admin configuration.** Schedule; dataset name.

**Inputs and outputs.** In: M0 tables. Out: `catalog_os.*` tables.

**Human in the loop.** None.

**Edge cases.** BigQuery write fails: retried; the previous snapshot stays readable. Schema change: additive columns
only (same rule as migrations, M6).

**Buy or build.** Build (a small job; the BigQuery client is already used by `master-sync.ts`).

**Acceptance tests.**
1. The day after a real batch publishes, `catalog_os.change_events` holds its `links_delivered` rows and
   `catalog_os.live_intervals` joins to `fact_gcc.unified_sales_tertiary_v2` through `catalog_os.outcome_keys` in one
   query that the data team can run.
2. Kill the job half way; the next run completes and no reader saw a partial table.

**Open questions.**
- Q: Which project holds `catalog_os`? Default: `image-links-agent.catalog_os` (we own it, no warehouse write grant
  needed), with BigQuery Data Viewer for the data team; move to `opptra-datawarehouse` later if they prefer.

### M0-F6 Change reasons (P1)

**Story.** As a learner (M10) and an auditor, I want every change to say why it was made (rule id, experiment arm,
operator, learning engine, outside change), not only who made it.
**Key requirements.** `reason_kind` is already required from P0 (F3-R9, because M4 needs it on day one); P1 makes
`reason_ref` complete: M1, M3, M5 and M10 pass the rule id or experiment id on every event; not-live reasons from M9
are attached to listings. Metric: share of
changes with a reason (baseline for not-live reasons 38%).
**Acceptance test.** Every change event of a real batch has a non-null reason that names a rule, experiment, operator
or `auto_decide`.
**Buy or build.** Build (a column already added in P0).

### M0-F7 Variants and size runs (P1)

**Story.** As a publisher (M9), I want parent-child groups (style, colour, size) in each channel's form, such as
Noon's Parent Group Key, so listing files group correctly.
**Key requirements.** Builds on the P0 `style_key` (F1-R8): a `catalog_option_groups` table (style level) linking options; size runs from `sku_map.size`;
per-channel parent keys as listing keys of kind `parent_group`. Metric: listings with broken parent-child groups.
**Acceptance test.** A Noon listing file for one style with 3 colours and 6 sizes groups correctly on first upload.
**Buy or build.** Build inside the graph.

### M0-F8 Brand master and channel overlay (P1)

**Story.** As a distributor, I want one brand master record per option and per-channel overrides, with which fields
the brand owns and which Opptra owns.
**Key requirements.** Versions with `scope = master` are the master; a channel-scope version for the same slot is an
overlay; a field ownership table per brand (brand-owned fields cannot be overridden without a reason). Metric: channel
content that differs from master without a recorded reason.
**Acceptance test.** A title override on Noon only shows as an overlay with a reason; master stays unchanged.
**Buy or build.** Build (nobody models the distributor case).

## 5. Operator experience

M0 has almost no screen of its own; it shows up inside other screens.
- **Product page** (`/catalog/products/<id>`): a new "History" section per channel: "Noon UAE image 3: crop made
  2 Nov, links delivered 2 Nov, live on Noon since 5 Nov (seen on the channel)". An assumed interval reads "delivered,
  not yet seen on Noon".
- **Batch page**: one optional line per channel after links are ready: "Uploaded to Noon? Mark the date" (one click,
  defaults to today). Never blocks anything.
- **Control listings**: in the digest (M1), "12 products are in a running experiment as controls; we left their Noon
  and Namshi images unchanged on purpose." No error tone.
- **Ops page** (`/catalog/ops`): graph health card with export freshness, share of listings with a resolved key, key
  conflicts count, verified-live share per channel, stale evidence sources.

## 6. Measurement

| Metric | Baseline | Target | Data source |
|---|---|---|---|
| Live listings with a resolved sales join key | Keys for about 14,400 SKUs in the master; 935 SKUs with no option id; 0 joined today | 99% of 12-week Namshi and Noon softline sale rows join to a listing | `catalog_os.outcome_keys` x `fact_gcc` |
| Module outputs with a version | 0% | 100% of outputs after M0 ships (nightly invariant) | `catalog_outputs.content_version_id` |
| Published content verified live | 0% outside Trendyol | 95% of slice listings on Namshi, Noon, Trendyol within 7 days | `catalog_live_intervals.state` |
| Days from publish to verified | unknown | median under 3 days | change events |
| Historical outputs loaded | 0% | 100% of published non-test outputs | backfill run report |
| Export freshness | none | under 24 h, every day | `catalog_os.export_runs` |
| Controls published to | n/a | 0 | `recordChange` refusals and verifier |

## 7. Build slices

Each slice is one worker in one worktree. S1 in the module map is split into these.

| # | Slice | Depends on | Acceptance test |
|---|---|---|---|
| M0-S1 | Migration `0009_catalog_graph.sql` (all new tables, two new nullable columns) and `packages/core/src/graph/` with `recordVersion`, `recordAsset`, `recordChange`, `readChanges`, `liveAt`, `isWritable`, unit tests on a real Postgres | none | Migration applies on a copy of the live schema and re-runs harmlessly; contract tests pass, including idempotency and the control refusal |
| M0-S2 | Option, listing and key sync from `sku_map` plus sales and channel keys; key conflicts; style key (F1-R8) | S1 | Acceptance tests 1 and 4 of F1 on real BigQuery data (read-only) |
| M0-S3 | Write path: ingest records source versions, render records output versions with sha256 and perceptual hash, publish writes `links_delivered` and `removed`; nightly invariant | S1 (S2 for `option_id` on products) | F2 acceptance tests on the preview stack |
| M0-S4 | BigQuery export job and dataset (`infra/` script, idempotent), alert on freshness | S1 | F5 acceptance tests |
| M0-S5 | Backfill job (outputs, Trendyol and Amazon history; Supabase when access exists) | S1, S3 | F4 acceptance test |
| M0-S6 | Live verifier (Trendyol, Amazon, Noon ad key), `recordObservation` for M9, "Uploaded on" action, product history section | S1, S3, S4 | F3 acceptance tests 1 and 3 |
| M0-S7 | Treatment assignment write path for M4 and the guard wired into M1 and M3 | S1, S3 | F3 acceptance test 2 |

S1 must merge first. Build order (one writer per module at a time, see `../roadmap.md`): S1, S2, S7, S3, S6, S5; S4
only adds new files (a job and an `infra/` script) and may run beside S2 to S7 as the roadmap's named exception.

### 7.1 Database migrations (additive only)

One migration, `packages/core/drizzle/0009_catalog_graph.sql`, generated from `schema.ts` like the others, with the
`SET LOCAL lock_timeout = '10s'` and `IF NOT EXISTS` pattern of `0008_batch_indexes.sql`:

| Change | Kind | Notes |
|---|---|---|
| `CREATE TABLE catalog_options` | new | unique `(brand_slug, option_key)`; index on `option_key` |
| `CREATE TABLE catalog_channel_listings` | new | unique `(option_id, channel, market)`; CHECK on channel (`CHANNEL_IDS`) and market |
| `CREATE TABLE catalog_listing_keys` | new | unique `(channel, market, key_kind, key_value)`; index on `opptra_sku` |
| `CREATE TABLE catalog_key_mappings` | new, seeded | the `sku_map.channel_ids` column to channel, market and key kind mapping |
| `CREATE TABLE catalog_assets` | new | primary key `sha256`; `phash` bigint |
| `CREATE TABLE catalog_content_versions` | new | unique key in 3.1; indexes on `option_id`, `asset_sha256`, `batch_id` |
| `CREATE TABLE catalog_change_events` | new | `seq bigserial`; unique `idempotency_key`; indexes `(listing_id, slot, at)`, `(experiment_id)` |
| `CREATE TABLE catalog_live_intervals` | new | unique `(listing_id, slot, valid_from)` |
| `CREATE TABLE catalog_treatment_assignments` | new | unique `(experiment_id, listing_id)`; partial index on `do_not_touch` |
| `CREATE TABLE catalog_backfill_runs`, `catalog_graph_export_runs` | new | job checkpoints |
| `CREATE VIEW catalog_outcome_keys` | new | over listings and keys |
| `ALTER TABLE catalog_outputs ADD COLUMN content_version_id uuid` | additive, nullable | no default, no rewrite; index added in the same migration |
| `ALTER TABLE catalog_products ADD COLUMN option_id uuid` | additive, nullable | index |
| Columns named in 3.1 on the new tables: `style_key`, `style_key_source`, `style_key_confidence` (options); `language`, `market`, `route_id`, `prompt_version`, `settings_snapshot_id` (versions); `reason_kind` NOT NULL with a CHECK that allows null only for `observed_other` and backfill, `change_type_id`, `change_set_id` (events); `org_id text NOT NULL DEFAULT 'opptra'` on every new table | part of the new tables | new tables, so no rewrite; `org_id` is added now because it is cheap now and expensive later (M12 Q1) |

No existing column is renamed, dropped or retyped. Foreign keys from new tables to `catalog_batches` use
`ON DELETE SET NULL` (test cleanup deletes batches) except where a version belongs to a test batch, which cascades.
Old code ignores the new columns, so the migration is safe one release ahead of the code (M6 rule).

Reused without change: `brand_master`, `sku_map`, `catalog_source_images`, `catalog_product_events` (it stays the
tool's product audit trail; the change log is per listing slot and is not a copy of it), `catalog_cost_events`.

## 8. Risks and open questions

| Risk or question | Effect | Mitigation or default |
|---|---|---|
| Perceptual hash fails on channel re-crops | Listings stay `assumed`, pre-period dates fuzzy | Hash the trimmed content box; tune the threshold on the first 200 Trendyol listings; uncertain matches counted |
| Namshi and Noon galleries depend on M9's scrape | Verified share stays low on the two money channels | M9 live content watch is P0; fallback to the `submitted` date |
| `ila-pg` is shared and small | New writes compete with batches | Writes ride the existing transactions; jobs use 1 connection and run in quiet hours; counted in the budget |
| Supabase access not granted | Brand photo history missing | Load outputs and Trendyol first; Supabase second pass |
| Data team prefers the dataset in the warehouse project | Move later | Default `image-links-agent.catalog_os`, documented view names stay the same |
| One image set serves AE and SA on some channels | Double events | One event per listing by design; the export can group by channel |
| Graph grows into a PIM | Scope creep | Out of scope list above; attribute editing stays out until M8 needs it |
| Open: market for Trendyol keys | | Default: from sales rows, else `ae_sa` |
| Open: Supabase folder to option mapping where one product sits in 2-3 folders | | Default: all folders load as versions of one option; M2 picks the best set |

## 9. Integration decisions (2026-11-02)

Recorded by the integration pass (`../roadmap.md`, `../owner-questions.md`). They change the sections above where noted.

| # | Decision | Why |
|---|---|---|
| D1 | Style key moved into P0 (F1-R8, M0-S2) | M4's P0 holdout randomizes by style; the P1 variants feature was too late |
| D2 | `reason_kind` and `change_type_id` required on new events from P0 (F3-R9); `change_set_id` added | M4 and M10 need them on the first treatment; M8 and M11 need change sets |
| D3 | Versions carry `language`, `market`, `route_id`, `prompt_version`, `settings_snapshot_id`; every new table has `org_id` | Contract needs of M7, M8, M12; `org_id` is cheap now |
| D4 | Treated listings accept only their registered treatment (`frozen_treatment`) | M4-F2-R5 single nameable change per arm |
| D5 | M0 owns the one live-verification matcher and the pHash setting (default 6, uncertain 7-12); M9 collects observations and owns alerts and gallery states | M0-F3 and M9-F1 both specified matching with different thresholds (6 vs 10) |
| D6 | No outbound calls from M0 writes; M4 and M10 read the log by cursor | M4 (`POST /treatments`) and M10 (`POST /classify`) assumed M0 would call them, which M0's contract rules out |
| D7 | Trendyol acceptance test uses a changed render, not a crop | Gate 1: crops only on Namshi and Noon |
| D8 | Open questions answered: Trendyol market split from sales rows (default kept); fallback SKUs not grouped by name in P0; text in Postgres up to 16 KB; `catalog_os` in `image-links-agent` (default kept); Amazon AE main image verification counts; Supabase as a second backfill pass | Technical defaults, no owner input needed |
| D9 | `reason_kind` and `change_type_id` are nullable on `catalog_change_events`, with a CHECK that requires both unless the event is `observed_other` or a backfill row (evidence or reason `backfill`); this replaces the "`reason_kind` NOT NULL" wording in 7.1 (manager, M0-S1 build) | F3-R9 exempts observed_other events and backfill rows from both fields; a plain NOT NULL would break those exceptions |
| D10 | `catalog_key_mappings` ships empty in M0-S1; M0-S2 seeds it from the read-only BigQuery key-coverage check. `key_kind` stays the 3.1 list (zsku, child_zsku, partner_sku, barcode, asin, seller_sku, style_id), enforced by CHECK (manager, M0-S1 build) | F1-R3 names each column's channel and market but not its key kind; guessed rows would be wrong data in a migration |
| D11 | The real-Postgres contract tests (`TEST_PG_URL`; the in-flight cursor, cursor race and assignment-lock tests skip on PGlite) run in CI with the M6-S7a tiered tests; M0-S1 does not edit `ci.yml` (manager, M0-S1 review) | `ci.yml` is a hot file owned by M6-S4, UX2 and M6-S7a; until then the tests run on a throwaway Postgres 16 per PR and the output goes in the PR |
| D12 | `readChanges` is cursor-safe: writers hold a shared advisory lock at or below their first seq, and readers return only events at or below the sequence value read first and below the lowest lock still held in the database (manager, M0-S1 review) | With concurrent publish transactions a later seq can commit first; a consumer storing it would skip the earlier event forever |
| D13 | The guard holds under concurrency and the log is append-only: `recordChange` locks the listing `FOR SHARE`, a trigger on `catalog_treatment_assignments` locks it `FOR NO KEY UPDATE` on every insert or update, and the version foreign keys from change events and live intervals are `RESTRICT` (test cleanup deletes test events first) (manager, M0-S1 review) | F3-R7 says a control is never published to; a cascade from a version delete could silently erase history |
| D14 | 7.1 drift, accepted: the assignments partial index is `(listing_id) WHERE released_at IS NULL` (serves both guard reads); `catalog_listing_keys.source` adds `channel_report` (F1-R4); on `catalog_outputs` and `catalog_products` the new foreign keys are `NOT VALID` and the new indexes are partial (`IS NOT NULL`), so 0009 stays cheap on live (manager, M0-S1 review) | Matches the requirements' intent; measured 1.3 s for 0009 over 1 million output rows on Postgres 16 |
| D15 | Key conflicts live in a new table `catalog_key_conflicts` (migration `0013`, one row per channel, market, kind and value, with every candidate listing, `first_seen_at`, `last_seen_at`, `resolved_at`). The sync removes a key it wrote earlier once it points at two listings, never touches a `scrape` or `manual` key (one that disagrees becomes a conflict), and marks a conflict resolved when a run no longer sees it; nothing else in the graph is deleted. The Ops page list and the `catalog_os.key_conflicts` export (F1-R5) read this table and come with M0-S4 and the Ops work; M0-S2 only fills it (worker, M0-S2 build) | F1-R5 says a conflicting key "is not written" and is listed for the Ops page and the export; 0009 had no table for the list. A stale key left in place would join sales to the wrong listing |
| D16 | Key mapping seed and key kinds (from the 2026-11-04 read-only check of `master_sl` against sales and channel reports): `key_kind` names who issued the code. `zsku` and `child_zsku` are channel-issued ids at option and size level (Namshi and Noon Z-codes; also the Styli ids, the Centrepoint id and the Shein option id); `partner_sku` is our code on the channel (Noon, and the 6th Street columns, which hold an option-level code of ours); `barcode` the EAN (Trendyol); `asin` Amazon. Amazon, like Trendyol, takes its market from the sales rows of the key, else `ae_sa`. `voga_closet` gets no row (it holds the flag `PASS`, not a key). Sales `channel_sku` kinds per channel: Namshi, Noon, Styli, Centrepoint, Shein `child_zsku`; Trendyol and 6th Street `barcode`; Amazon `asin`; `style_id` on every channel. Channel-report keys come from `dimensions.sku_master_amazon_ae/sa` (seller SKU and ASIN, tied to a master SKU by its code or the master ASIN), `dimensions.sku_master_noon` (partner SKU and child Z-code, tied by the code, the master `noon_ae` or the master `child_zsku`; no market, so they go on the option's existing Noon listings) and `gcc_channel_reports.product_list_trendyol_3p_uae/ksa` (barcode, tied by the master barcode or EAN, or by `supplier_stock_code` equal to the code). A sales or report key on a channel whose mapped master keys are all `ae_sa` (Styli, Centrepoint, Shein) always goes on the `ae_sa` listing, even when the option has no master key on that channel (worker, M0-S2 build; tightened after review) | The 3.1 kind list has no kind for non-Noon channel ids; matching on the real data showed Namshi and Noon sales use the child Z-code, Trendyol and 6th Street sales the EAN, Styli sales a composite of its two ids |
| D17 | Style key: `master_sl.description_1` (the master sheet's style code, filled on every option-keyed softline row) is `brand_style_code`, confidence 1. An option takes the code from any of its SKUs that has one (all of them agree: 0 options with two codes on 2026-11-04); an option none of whose SKUs has one (in practice the `sku_option` and fallback options) uses the name-and-colour rule on the option id: trailing colour words (from the master's colour values) and the `OD` marker removed, confidence 0.9; no colour word found gives 0.5, so the option is its own cluster. Keys are `<brand>|<stem>` (brand only, no department: the rule's options have no category or gender in the master). The bar (0.8) reads `CATALOG_STYLE_KEY_MIN_CONFIDENCE` until M12 holds settings. The sync recomputes style keys each run, so the channel team's confirmed groups (M4) need their own protected store when M4 builds that step (worker, M0-S2 build) | F1-R8 says "the brand sheet's style code where present" and the 2026-11-02 check found no style id; `description_1` is that code (U.S. Polo 2.15 options per style over all options, 2.07 over options selling on Namshi and Noon, against the 1.89 heuristic) |
| D18 | Runtime path: the graph sync runs inside the nightly `sync-master` task, right after the master sync, and reads BigQuery through `BQ_PROJECT` like the master sync. While `BQ_PROJECT` is the `image-links-agent` mirror, `infra/bq-mirror.sh` also copies `gcc_marketing.sku_option` and key-only copies (distinct key columns, no order, customer or money column) of the sales table and the channel-report tables; `infra/bootstrap.sh` lists the three new datasets for the warehouse grant. A graph sync failure never fails the master sync (outcome `graph:bigquery_unavailable` or `graph:failed`, an ERROR log, the previous graph kept) (worker, M0-S2 build) | F1-R1 ("after each master sync"); the worker has no warehouse rights today, so the mirror is the only path that works without a new grant |
| D19 | Left for later slices, not in M0-S2's acceptance: re-keying a fallback SKU (F1 test 2) moves its keys to the new option and marks the old option out of the master, but no alias row exists yet (no alias table in 0009); listing `status` from liveness (F1-R7) is not written. `resolveOptions` resolves one input at a time (correct, not yet batched) (worker, M0-S2 build) | Kept the slice to its acceptance tests (F1 tests 1 and 4); each item names the requirement it still owes |
| D20 | The sync is deterministic and never keeps a moved key in conflict (review of M0-S2, P1-1 and P1-2). (1) One master row per code: about 257 softline codes appear twice in `master_sl`, one row with `description_1` and one blank; the row with a non-blank style code wins, then the highest `source_row_number` (the row the master sync keeps), and SKUs are planned in code order, so the style key, category and gender never change with the order BigQuery returns rows. (2) Only SKUs in the current master propose keys (master, child_zsku, sales and report keys). A SKU that left the master keeps its `sku_map` row and its option (`in_master = false`), and the keys written for it earlier stay as history until another listing claims them, when they move without a conflict. (3) Sales keys come from the last 182 days of sale rows (`SALES_KEY_WINDOW_DAYS`), which covers the 12-week join and M4's pre-period, so a key the channel reassigned stops being proposed for its old SKU within that window (worker, M0-S2 review fix) | A style key that flips between nights reassigns options between M4's randomization units; an ever-open conflict silently drops a correct key and its sales join |
| D21 | The graph export (M0-S4) writes to `image-links-agent.catalog_os` (the F5 open question's default) from the Cloud Run job `catalog-graph-export`, started at 02:30 UTC by Cloud Scheduler with catalog-worker@'s token; `infra/catalog-graph-export.sh` sets up the dataset, grants, job and schedule, and `deploy.sh` keeps the job on the current worker image once it exists. (1) Every table is loaded into `_staging_<table>` (an empty one is created from its schema, never loaded from an empty file); then ONE BigQuery multi-statement transaction empties and refills every snapshot table from its staging copy, merges the change events by `seq` (insert when not there) and appends the `export_runs` row, so readers see one night's whole set and a killed run changes nothing (review of M0-S4, P2-1). The change-event cursor is BigQuery's own `max(seq)` with the change log's safe bound (`changeLogBounds`, the D12 rule), so a killed run or a late commit never loses or doubles an event. Schema evolution: before the transaction every final table is created when missing and given each column it lacks (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`), and every INSERT and MERGE names its columns, so adding a column to `EXPORT_TABLES` needs no manual step, for `change_events` too; renaming or retyping a column is not supported (additive only, as for migrations) (review P2-4). (2) All reads use one read-only repeatable-read transaction in keyset pages of 5,000; `outcome_keys` is read from its two tables, not the view, so pages follow the keys' primary key. (3) Test content is left out: `is_test` versions, the events and live intervals that point at them, and events of test batches. (4) Freshness: the sweep's invariant `graph_export_stale` (WARNING) fires when no run finished cleanly in the last **26 hours** (a daily run is up to 24 hours old before the next one; 2 hours cover the run), once a run is older than that, and feeds alert policy 15 by email; a project where the export never ran is not reported, so `infra/catalog-graph-export.sh` setup ends by running the first export (until the job has one successful execution) and stops loudly when it fails: from the day of setup a run row exists, and a schedule that never fires is reported 26 hours later (review P2-3). The 26-hour threshold changes F5-R4's "older than 24 hours"; the owner sees it in the M0-S4 PR. The Ops page freshness card (F5-R4, section 5) and the data team's reader grant (`DATA_TEAM_MEMBER`, group not known yet) are not in this slice (worker, M0-S4 build) | A partial table would mislead M4's joins; a 24-hour threshold on a daily job would email every day the run takes a few minutes longer |
| D22 | M0-S3 write path, where each version is written: ingest records every accepted photo as an asset (its existing sha256, no perceptual hash: the photo's bytes are not read there) and a `brand` version (producer `M1`, `producer_ref` = `product:<product id>`, position n, role `unknown`), so a photo sent again for the same product reuses its version; the render records each staged image (producer `M3`, `producer_ref` = the output id, `source` `upscaled` when flagged, else `cleanup`, parent = the photo's version, recorded on the spot when ingest did not, for a replaced photo) in the transaction that writes the output's `staging_uri` and `content_version_id`, hashing the bytes it just staged (sha256 and the 9x8 difference hash) before that transaction; the asset `uri` is the staging object. A redelivered chunk that reuses an earlier delivery's staged object reads it back once to hash it, and a publish of an output staged by a worker from before M0-S3 hashes its staged bytes before its transaction opens (D26) (both rare, never the normal path). A "Try again" reset clears `content_version_id` with the staged image. Bytes the decoder cannot read keep a null perceptual hash (worker, M0-S3 build) | F2-R1 to R3 and R8; a re-sent photo is not new content; the hash must be of the bytes actually delivered |
| D23 | Publish writes the change log in its own transaction: one `links_delivered` event per delivered slot and one `removed` event per emptied slot, on every listing of the product's option on that channel (Noon AE and SA each get one). `idempotency_key`: see D27 (one output feeds two listings when a channel keeps one image set for both markets, so the key names the listing). `from_version_id`: see D27, `evidence` `tool_publish`, `evidence_ref` `catalog_outputs:<id>`, `actor` the batch's creator, `change_set_id` a stable uuid of the batch and product. A product with no option yet (not linked by M0-S2), or an option with no listing on that channel, gets versions and no event. Live intervals are not written here: M0-S6 builds them from these events (F3-R6) (worker, M0-S3 build) | F3-R1, R2; recordChange refuses the same key for a second listing |
| D24 | Reason and change type of a publish event (F3-R9, v0 types of M10-S1a): reason `auto_decide` for an output an auto-decide rule delivered (`provisional`), `operator` for "Use as is", `rule` (with `reason_ref` `channel-rules:<the channel's render key version>`) when the same photo is made again for the slot (a channel rule or pipeline change), else `new_content`. Type by the version's source first: `crop` is `img_shotset_crops`, `generated` `img_shotset_generated`; then a photo moved from another slot of the channel is `img_reordered`; a different photo in slot 1 `img_main_replaced`; an upscaled render `img_upscaled`; any other render (the photo on the channel's background) `img_background_fixed`. A removed slot has no v0 type, so it is `img_reordered` (no new content; negligible cost) with reason `new_content`, until M10-S1b adds a removal type. The pipeline makes no crops in R1, so the M10-S1a acceptance ("M0-S3's publish test writes `img_shotset_crops`") is met by a publish test whose output points at a crop version recorded as M3-F1 will record it (worker, M0-S3 build) | Every event must carry both fields; types describe what changed on the listing, and the source decides first because a crop or generated image is the change being measured |
| D25 | F2-R8 invariant `output_without_version` (ERROR, in the existing invariant table that the sweep and the `catalog-invariants` job run): a staged, held or verified output with a `staging_uri` and no `content_version_id`, counted only when the output row was made after its batch's first M3 version (so outputs of batches a pre-M0-S3 worker staged are not reported; bounds and grace in D27). The F2 acceptance tests run in `apps/worker/src/catalog/graph-write.test.ts` through the real chunk, publish and finalize handlers with real JPEGs and an in-memory bucket; the 20-product run on the preview stack is part of the R1 proof run after deploy (worker, M0-S3 build) | "100% of outputs written after M0 ships" needs a start point that needs no date setting |
| D26 | A version or change-log write never fails or rolls back a delivery (review P2-1 and P2-2 of M0-S3). At publish: outputs staged without a version (a pre-M0-S3 worker) are hashed and their versions written before the publish transaction opens, each in its own short transaction and only while the row still holds those staged bytes; a failure there is logged at ERROR and left to `output_without_version`. The change log is written inside a savepoint at the end of the publish transaction: if it fails (database error, or the M0 guard refusing a listing whose control assignment committed after the publish read the holds), the savepoint rolls back alone, the delivery commits, and the publish logs `change log not written` at ERROR with the batch and product. A delivered slot with no version gets no event and logs `content version missing at publish` at ERROR. The render path keeps F2-R2's rule (a version insert that fails fails the render write and the chunk retry runs: nothing was delivered yet) (worker, M0-S3 review) | The public link has already changed when the log is written; rolling back the publish there left the database describing an older object and every retry failing the same way. F3 does not say an event failure should stop a delivery; the ERROR log and the invariant make a gap visible |
| D27 | Change-log keys and history for re-made rows (review P1-1 of M0-S3): a `links_delivered` key is `publish:<output id>:<previous version or none>:<new version>:<listing id>`, and `from_version_id` is the slot's last event on that listing (else the version of the other output live in the slot, else null). An output row made again in place (an M1-S4 improvement or Try again, which re-make the same row at the same URL) gets a new event from its old version to its new one, with reason `auto_decide` for an improvement and `operator` for Try again (`reason_ref` = the `enlargement_retried` product event), and its type from its new version (for example `img_upscaled`). A retried publish finds the slot's last event already at the new version and writes nothing; a removal is written once per output and listing. The `output_without_version` invariant is bounded for the 10-minute sweep: batches created in the last 14 days, one `min(created_at)` of M3 versions per batch through the `batch_id` index, and outputs counted from 30 minutes after that first version (so a rolling deploy's old revision is not an ERROR) (worker, M0-S3 review) | The first key, `publish:<output id>:<listing id>`, repeated with a new version when a row was re-made, which the change log refuses (same key, different event) |
