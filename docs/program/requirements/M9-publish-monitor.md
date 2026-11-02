# M9 Publish and monitor - requirements (draft, 2026-11-02)

Planning only. Follows `00-template.md`. Feature ids follow the row order of the M9 table in `../module-map.md` (M9-F1 is
the first row). Words defined once: a **listing file** is a marketplace's own bulk spreadsheet for creating products (Noon
calls it the NIS sheet); a **template** is one such file for one channel and category, stored once; a **binding** says where
a column's value comes from; **live watch** is our own scheduled check of our own public listing pages; **drift** is live
content that differs from what we published; a **rejection** is a marketplace saying no to a listing, with or without a
reason. Settled at gate 1 and repeated here because they shape every feature: no marketplace write API without an owner
decision; Noon has no public catalog API, so files are the push; we learn from rejections.

## 1. Purpose

No PIM or feed tool pushes to Noon, Namshi, Styli or Centrepoint, nobody learns from marketplace rejections, and today the
warehouse cannot say which gallery was live on Noon or Namshi (62% of not-live listings have no recorded reason). M9 confirms
what is really live (P0), fills each channel's own listing file from the graph, and turns every rejection into a fix and a
rule so it does not repeat. Outcome metrics: share of published content verified live, reason coverage of not-live listings
(38% to 90%), repeat rejections. Intents: I004, I024, I037, I017, I038, I045.

## 2. Scope

**In:**
- P0: live watch of our own listings on Noon and Namshi (UAE and KSA) by our own scrape, plus Trendyol and Amazon.ae from
  feeds we already have; verification against the M0 treatment log; drift and contamination alerts for the holdout.
- P1: listing files per channel (the old initiative 9 design, simplified and now carrying M8 text and Arabic); liveness and
  rejection reasons connected; rejection learning.

**Out:**
- Sending files or calling any marketplace write API (needs its own owner decision; M9-F5 is P2 and starts read-only).
- Price, stock, offer, shipping and tax: never filled, never synced (M9-F7 Skip).
- Google and Meta feeds (M9-F8 Skip).
- Scraping other sellers' listings or market data (M4-F9 buys that later).
- Per-SKU review of files or rejections.

**Later:**
- India channels next (Amazon.in, Flipkart, Myntra): their templates use the generic parser; Myntra and Flipkart have
  downloadable error reports that plug into M9-F3.
- Marketplace APIs where allowed (Trendyol first), re-enrichment after go-live (both P2).

## 3. Contracts

### 3.1 What M9 reads and writes

| Direction | Entity or event | With whom | Notes |
|---|---|---|---|
| Reads | `Listing` with channel keys (Noon SKU, Namshi SKU, Trendyol barcode, ASIN) | M0 | Master holds Noon keys for 14,418 SKUs, Namshi 14,457 (census) |
| Reads | Published content versions and the treatment log (what was published where and when) | M0 | The thing live watch verifies |
| Reads | Control flag and experiment arm | M4 via M0 | Drift on these raises a contamination alert |
| Reads | Published image links in channel order (the links sheet) | M3, existing finalize | `packages/core/src/catalog/sheet.ts` |
| Reads | Text versions per channel and language | M8 | Arabic only when that channel passed calibration (M8-F2-R7) |
| Reads | Trusted facts and channel words (`readProductFacts`, `mapFactsToChannel`) | M2 | Only trusted facts; only `documented` or `confirmed` mappings |
| Reads | Channel registry (push method, file kind, owner), file rules, limits | M5 | The stricter of the template's limit and M5's rule wins |
| Writes | `ListingObservation` (one per listing per check) and verification state | M0, BigQuery | Extends `opptra_core.listing_content_observation` |
| Writes | `PublishEvent`: `file_made`, `file_uploaded` (operator's one click), `verified_live`, `rejected`, `drift` | M0 | Feeds the treatment log's "live from" time |
| Writes | `Rejection` {listingId, channel, market, rawText, source, causeCode, seenAt} | M0, BigQuery | Joined to `fact_gcc.catalog_liveness_daily` |
| Emits | `listing.verified_live`, `listing.drift_detected`, `listing.not_found` | M0, M4, M1 digest | |
| Emits | `content.fix_requested` {listingId, causeCode, rejectionId, targetModule} | M3, M8, M2 | Automatic fix, no person |
| Emits | `rules.rule_proposed` | M5 | From rejection learning; an admin publishes |
| Receives | `rules.ruleset_published`, `text.keyword_winner_applied` | M5, M8 | Starts re-enrichment (P2) |

### 3.2 Shapes

```ts
interface ListingObservation {
  listingId: string; channel: "noon" | "namshi" | "trendyol" | "amazon"; market: "AE" | "SA";
  observedAt: string; source: "scrape" | "trendyol_feed" | "amazon_active_listings";
  fetch: "ok" | "not_found" | "blocked" | "error";            // blocked or error never means "not live"
  titleEn: string | null; titleAr: string | null;
  images: { position: number; url: string; phash: string | null }[];
  contentHash: string;                                         // hash of title + image phashes, to spot change cheaply
}

type VerificationState = "verified_live" | "partial" | "not_yet_live" | "drift" | "reverted" | "not_found" | "unobserved";

interface Rejection {
  id: string; listingId: string; channel: string; market: string | null;
  source: "noon_imports_report" | "catalog_liveness" | "noon_policy_violation" | "namshi_portal" | "amazon_processing_report"
        | "trendyol_batch_result" | "operator_report";
  rawText: string; causeCode: string | null;                   // null = not yet mapped
  seenAt: string; batchId: string | null; fileId: string | null;
}
```

### 3.3 Existing code and data to reuse

- Finalize: `apps/worker/src/catalog/finalize.ts` (`handleFinalizeTask`) builds the report, writes `links-v<k>.xlsx` and
  `.csv` with `writeLinksXlsx` and `writeLinksCsv`, fills the brand's product list with `fillProductListWorkbook`, and
  re-reads links in parts with `recheckSheetPart` and a saved `finalize-state.json`. Listing files are filled once per
  attempt in that same snapshot, and the state file records that they were made, so a resumed part never fills twice.
- `fillProductListWorkbook` in `packages/core/src/catalog/sheet.ts` is the pattern for writing into a supplied workbook
  (ExcelJS); `recheck/index.ts` is the pattern for an independent re-read with no database.
- Data: `fact_gcc.catalog_liveness_daily` (EAN x channel-country x day: live, stocked, reason, from 17 Oct), the
  `catalog-liveness-job`, `opptra_core.listing_observation` (the scraper already visits Namshi.ae/.sa since 21 Aug and
  Noon.ae/.sa since 17 Aug for price and availability), `opptra_core.listing_content_observation` (image count and
  `content_hash`, only Amazon hardline and India today), `gcc_channel_reports.product_list_trendyol_3p_*` (`image_1..8`,
  title, description per barcode per day), `gcc_channel_reports.active_listings_amazon_3p_*` (main image and title),
  `raw_noon_admanager.campaign_product` (main `image_key`, `policy_violation`).

### 3.4 Contract needs from M0

1. The treatment log row per listing x content version with `publishedAt` (file made), `submittedAt` (operator's upload
   click) and `liveFrom` (first verified observation), so time to live can be split into our part and the marketplace's
   review (C28: the clock stops at "submitted").
2. A perceptual hash (pHash: a short fingerprint of how an image looks, which survives the marketplace re-compressing or
   renaming it) on every published image version, not only a byte hash.
3. Listing keys per channel and market, with a "no key" state that is explicit.
4. Change reason kinds `outside_change` (drift) and `rejection_fix`.
5. (Owned by M9, not M0.) The gallery verification state (verified_live, partial, not_yet_live, drift, reverted,
   not_found, unobserved) lives in M9's own `catalog_listing_verification` table keyed by M0 listing id; M0's listing
   `status` stays the liveness status from the liveness feed. `submitted` and `verified_live` are M0 change events.

## 4. Features

### M9-F1 Live content watch (P0)

**User story.** As the measurement owner, I know within a day which images and title are really live on Noon and Namshi for
every holdout listing, and I am told when anyone outside the system changes a treated or control listing.

**Functional requirements.**
- M9-F1-R1. Extend the existing scraper (the one that writes `opptra_core.listing_observation` and
  `opptra_core.listing_content_observation`) to record, for each of our Noon and Namshi listing pages in UAE and KSA: fetch
  result, English title, Arabic title (from the Arabic page), image URLs in gallery order, image count and a `contentHash`.
  Only our own listings, found by our channel keys.
- M9-F1-R2. Download each gallery image at thumbnail size once, compute its pHash and store it; an unchanged URL is not
  downloaded again.
- M9-F1-R3. Trendyol and Amazon.ae come from the feeds we already have (`product_list_trendyol_3p_*` daily `image_1..8` and
  title; `active_listings_amazon_3p_*` main image and title), mapped into the same `ListingObservation` shape with no scrape.
- M9-F1-R4. Schedule (admin settings): holdout listings (treated and control, about 1,400 options on Namshi and Noon, each in
  up to two markets) daily; every other live listing of the slice channels weekly (about 3,179 live options).
- M9-F1-R5. **Verification.** Every observation goes to M0 through `recordObservation`; M0's matcher (M0-F3) compares it
  with the published versions slot by slot, using M0's one pHash setting (default 6 of 64 bits, 7-12 uncertain;
  M0-F3-R10), and writes `verified_live` or `observed_other`. M9 then sets the gallery-level state in its own table from
  those events, comparing image order and the title by text:
  - `verified_live`: every published image is present in the published order (and the title matches when we published one);
  - `partial`: some published images are present, others missing or out of order;
  - `not_yet_live`: the page still shows the previous version;
  - `drift`: the page shows content that matches neither the latest nor an earlier published version of ours;
  - `reverted`: the page shows an earlier version of ours after a newer one was verified;
  - `not_found`: the page answers "not found" two checks in a row;
  - `unobserved`: the fetch was blocked or failed; never treated as not live.
- M9-F1-R6. The first `verified_live` observation sets `liveFrom` on the treatment log row (M0) and emits
  `listing.verified_live`. This is the treatment start date M4 uses.
- M9-F1-R7. Drift or reverted on a listing with a holdout arm or a control flag emits `listing.drift_detected` and an alert to
  the M4 owner the same day ("Contamination: <n> holdout listings changed outside the system on <Channel>"). M0 records an
  `outside_change` version built from the observation, so the estimate can include or exclude it.
- M9-F1-R8. Politeness and safety: at most one request every 2 seconds per host (admin setting), our own listings only, back
  off on HTTP 429 or 403 and on a challenge page, stop for the day after three blocks in a row on a host and alert. Saudi
  pages fetched through a Saudi network exit only if plain fetches are blocked (open question).
- M9-F1-R9. A daily coverage line: share of scheduled listings observed with `fetch = ok`. Below 90% for the holdout set
  raises an alert.
- M9-F1-R10. First-slice item S7 also needs the Noon and Namshi gallery count and roles per option before the holdout
  starts (to apply M4-F2-R2's eligibility rule: the gallery is below the channel's shot-set rule, so the crops-first
  treatment changes something; not the older "fewer than 5 images" filter, which would halve the pool); the first full run
  delivers it as a BigQuery table.

**Non-functional.** Freshness under 24 hours for holdout listings. Scale: about 6,000 page fetches a day at the start (holdout
across two channels and two markets, plus the weekly share of the rest), comfortably below one request per 2 seconds per
host. Cost: no model calls; network and storage only, under USD 100 a month including any proxy (judgement). Reliability: a
failed day leaves `unobserved` rows, never false "not live"; the job resumes from where it stopped.

**Admin configuration.** Schedules per listing group, pHash threshold, request rate per host, alert thresholds, which channels
and markets are watched.

**Inputs and outputs.** In: channel keys and published versions from M0, our public listing pages, the Trendyol and Amazon
feeds. Out: observations and verification states in M0 and BigQuery, alerts, the S7 gallery count table.

**Human in the loop.** None per listing. The M4 owner acts on contamination alerts (a deliberate check, not a queue). A legal
review of scraping our own listings is a one-time owner step before the job runs at full rate (gate-1 risk table).

**Edge cases.** The marketplace crops or pads our image (pHash still close; threshold tuned on the first 200 verified
pairs). A listing with several sellers where another seller's images show (state `drift`, flagged "other seller"). A page
that lazy-loads gallery images (the scraper must read the gallery data in the page, not only visible images). Arabic page
missing (title AR null, not an error). A size-level listing under a parent page (observe the parent once per option). Our
key missing in the master (state `unobserved`, counted as "no key").

**Buy or build.** Build: extend our own scraper, which already visits these sites; low volume, own listings only. Fallback:
buy Noon tracking from 42Signals or proxy capacity from Bright Data if blocks persist (both named in the competitor study).

**Acceptance tests (end-state, as the measurement owner would check).**
1. The day after the channel team uploads the treatment file for the holdout, the S7 table shows, per treated option on
   Namshi and Noon UAE, `verified_live` with `liveFrom` set, for at least 90% of options that are live within 3 business days.
2. On a test listing, someone replaces image 1 in the Noon portal by hand; within 24 hours the watch shows `drift`, M0 has an
   `outside_change` version, and the M4 owner gets the alert.
3. Block the scraper on Namshi for one day: those listings show `unobserved`, none shows "not live", and the coverage alert
   fires.
4. Before the holdout starts, a BigQuery table gives the Noon and Namshi gallery image count per option for the candidate
   pool.

**Open questions (with recommended default).**
- Do Saudi pages need a Saudi network exit? Default: try plain fetches first; buy a small Saudi proxy only if blocked.
- Legal review of scraping our own listings at low rate: default yes before full rate; the first run limited to the holdout.
- Where does the scraper code live and who owns it? Default: extend it where it lives today (data team), with M9 owning the
  new fields and the verification job in this repo.

### M9-F2 Listing files per channel (P1, after the Streamoid and Rubick demo)

**Story.** As Naaz, next to the links sheet I download each channel's own listing file already filled with identifiers,
image links, attributes, English and Arabic text, with only the cells the system truly cannot know shaded and listed, and I
upload it in the portal. The agency no longer fills templates.

**What is kept from `initiative-requirements/09-listing-files.md`** (the design is good; read it for detail):
- Templates as data: a registry of templates per channel and category, versions that are never edited after approval, an
  admin upload flow that shows "what we read" (columns, required, allowed values, limits) and asks the admin to confirm each
  binding once.
- Parsers: Noon NIS (header colours red required, green optional, grey not applicable; dropdowns; EN and AR columns; parent
  and size rows), generic Excel (Namshi and the rest), CSV and TSV; Amazon flat file only when an `.xlsx` is on record. The
  two Excel safety rules (dropdowns in a hidden extension; refusing whole-column dropdowns above 200,000 cells).
- The fill writes values only into data rows and keeps the marketplace's headers, tabs, dropdowns and colours; output is
  `.xlsx`.
- Shading: light red `FFFFC7CE` = must fix, amber `FFFFEB9C` = check; a fresh style copy per shaded cell.
- The "Needs you" tab (or side file when the portal refuses an extra tab), one row per problem with what to do.
- Rules for every cell: write only what is known; never placeholder text; never cut a value short (shade it); never write a
  value outside an allowed list; never fill price, stock, offer, shipping or tax.
- The independent re-read of the written file, failing the fill on any mismatch; a fill never fails finalize.
- The golden fill per channel: Naaz fills the same template by hand for at least 20 products; zero wrong values allowed;
  coverage reported per column; owner minimum (default 60%).
- Never submit. "Make files again" after facts, text or templates change.

**What changes now:**
- M9-F2-R1. Text columns (title, bullets, description, keywords) are filled from M8 versions for that channel and language.
  Arabic columns are filled from M8 Arabic when that channel passed Arabic calibration; otherwise blank and shaded amber
  ("Arabic for <Channel> is not live yet"). Initiative 9's "Arabic never written" is replaced by this rule.
- M9-F2-R2. Attribute columns use M2 trusted facts through `readProductFacts` and channel words through `mapFactsToChannel`
  (only `documented` or `confirmed` mappings); Arabic attribute values use M8's Arabic labels.
- M9-F2-R3. Limits: the stricter of the template's own maximum length and M5's rule for that channel; M5 results are written
  into "Needs you" in M5's plain sentence.
- M9-F2-R4. Simplified admin flow, three steps: upload (with marketplace, label, "used for", owner), check what we read and
  confirm bindings, approve. Templates can be added without a deploy.
- M9-F2-R5. No per-product attention: the product page line of initiative 9 is dropped; counts go into the M1 digest
  ("Noon listing file: 412 products, 9 cells need you").
- M9-F2-R6. One click per file, not per product: "I uploaded this file" records `submittedAt` on every row's treatment log
  entry. Live watch (M9-F1) confirms the rest.
- M9-F2-R7. Managed channels (Styli, Centrepoint, 6th Street) get files only when their account teams send a line sheet; until
  then the channel's push method in M5 is `managed_by_channel` and the batch page says so.
- M9-F2-R8. A "Fixes" file per channel holding only rows changed by rejection fixes or re-enrichment, so the operator
  re-uploads only those.

**Acceptance test.** Golden fill for Noon (English plus Arabic NIS, women's tops) and Namshi on one real batch of at least 20
products: zero wrong cells; coverage of non-commercial cells at or above the owner's minimum; the first real portal upload
of each is accepted, or its exact rejection is recorded and fixed; a forced fill failure leaves the batch done with its links
sheet unchanged.

**Buy or build.** Build after the demo, unless the demo shows a vendor already produces accepted Noon and Namshi files.
What the demo must answer for files and publishing:
1. Do you produce a filled Noon NIS file in English plus Arabic and a Namshi upload file today? Show one that a portal
   accepted, with the date.
2. Styli, Centrepoint, 6th Street: what do you deliver for managed channels?
3. Amazon.in, Flipkart, Myntra: which templates do you fill, and how do you keep them current when the channel changes them?
4. Do you push by API to any GCC channel? Through whose account and credentials?
5. Do you read rejection or error reports (Noon Imports, Myntra and Flipkart error reports) and fix them automatically? Do
   fixes become rules so the error does not repeat?
6. Do you check what is live after upload?
7. Can you fill from our data (we send products, facts, text and links; you return the file) without becoming our system of
   record?
8. Price per file or per product, and turnaround for 2,000 products.

**Decision rule.** Buy or partner for files only if on the 30-product pack: zero wrong cells against our golden fill;
coverage at or above ours; Noon and Namshi files accepted on a real upload; they take our data and return files with our ids
(we stay the system of record); and price within the owner's ceiling. A partner may be right for India channel files even if
we build GCC files.

### M9-F3 Liveness and rejection feedback (P1)

**Story.** As the catalog lead, every not-live or rejected listing has a reason in one table, so I fix causes, not symptoms.

**Key requirements.**
- M9-F3-R1. Keep `catalog-liveness-job` and `fact_gcc.catalog_liveness_daily` as they are; join their reason field into
  `Rejection` rows.
- M9-F3-R2. Connect the missing sources: Noon Imports content errors (no API: the operator or channel team drops the
  exported error file on the batch page or into one shared folder the job reads); Noon not-live reasons (stale since 21 Aug;
  ask the data team to restore the feed); Noon `campaign_product.policy_violation`; Namshi portal reasons (format unknown;
  ask the Namshi manager); the Amazon flat-file processing report the operator downloads; Trendyol batch request results
  through the public API, read only, once credentials exist (G11b in initiative 9).
- M9-F3-R3. A reason taxonomy as data (admin-editable): for example `image_background`, `image_size`, `image_count`,
  `image_text_overlay`, `title_length`, `banned_word`, `attribute_missing`, `attribute_value_invalid`, `category_wrong`,
  `gtin_invalid`, `duplicate_listing`, `brand_not_approved`, `commercial` (price or stock, routed to the channel team),
  `not_stocked`, `unknown`. Raw texts map to codes by patterns that an admin edits.
- M9-F3-R4. Rejections link to the file and batch that produced them, so a reason can be traced to the content version.

**Acceptance test.** For one week of Noon and Namshi data, 90% of not-live stocked listings have a cause code (baseline 38%),
and a dropped Noon Imports error file appears as `Rejection` rows linked to its batch within an hour.

**Buy or build.** Keep and build. Marketplaces only give error reports; nobody joins them.

### M9-F4 Rejection learning (P1)

**Story.** As Opptra, a rejection on one listing fixes that listing automatically and stops the same rejection on every
other listing, without anyone reviewing products.

**Key requirements.**
- M9-F4-R1. **Fix.** Each mapped rejection emits `content.fix_requested` to the owning module (M3 re-render, M8 rewrite, M2
  attribute), which makes a new version with change reason `rejection_fix`. The fixed rows go into the next "Fixes" file
  (M9-F2-R8). No automatic resubmission: the operator uploads the file.
- M9-F4-R2. **Prevent.** When no active rule would have caught the cause, propose a draft rule to M5 (`rules.rule_proposed`)
  with evidence `reported`, the rejection ids and the count. When a rule existed but only warned (a playbook rule not yet
  confirmed), propose confirming it so it blocks. An admin publishes; nothing publishes itself.
- M9-F4-R3. **Unmapped reasons.** Raw texts with no code are grouped weekly by similarity; a model suggests a code per group
  (one call per group, never per listing); the admin maps the group once, and the mapping becomes a pattern for next time.
- M9-F4-R4. **Proactive sweep.** When a rule is published from a rejection, every other live listing that fails it is found
  and queued for a fix (respecting control flags), so the error does not wait to be rejected.
- M9-F4-R5. Weekly digest to the admin: "41 rejections this week, 38 with a cause. 3 rules proposed. 112 other listings would
  have failed the same way and are being fixed."

**Acceptance test.** A planted batch of 20 Noon listings rejected for "image background not white" produces 20 fix requests,
one proposed rule (or a confirm proposal for the existing background rule), and after the admin publishes it, a sweep finds
the other listings that fail it; the next upload has no repeat of that rejection.

**Buy or build.** Build. Salsify's auto-heal (May 2026) works for US retailer schemas only; nobody does this for marketplaces.

### M9-F5 Marketplace APIs where allowed (P2)

Trendyol's public API first, read-only (category attributes, batch status) before any write; Amazon by feed files.
Every write API needs its own owner decision and spec (settled). Noon has no public catalog API; files stay the push. Build.

### M9-F6 Re-enrichment after go-live (P2)

When a rule is published, a keyword winner is applied or a better image exists, select affected live listings (never
controls), make new versions and a "Fixes" file. Uses `rules.ruleset_published` and `text.keyword_winner_applied`. Build.

### M9-F7 Price and stock sync (Skip)

Skipped: existing operations systems (Rithum, EasyEcom and the channel teams' tools) do this, and commercial data belongs
to the channel manager.

### M9-F8 Google and Meta feeds (Skip)

Skipped: not Opptra's channels.

## 5. Operator experience

**Batch page, downloads** (after the links sheet):
- "Download Noon listing file (Noon women's tops) - 9 cells need you" or "Ready to upload".
- "I uploaded this file" (one click; records the upload date for every product in the file). After the click: "Thanks.
  We will check Noon each day and tell you when these products are live."
- Live line, updated daily: "Live on Noon: 412 of 430 checked (3 days after upload). 18 not live yet."
- "Add a marketplace error report" (drop the Noon Imports export or any channel's error file). After the drop: "Read 37
  errors. 34 matched a known cause and are being fixed. They will be in the next Fixes file."

**Digest lines** (M1): "Noon listing file: 430 products, 9 cells need you." "Rejections this week: 41 (38 with a cause)."
Never per-product cards.

**Ops page, "Live check" block** (admins): coverage yesterday per channel and market, verified share, drift count,
contamination alerts, blocked hosts.

**Ops page, "Rejections" block:** reasons by code and channel, unmapped groups waiting for a code ("Map this group"),
proposed rules with a link to the M5 editor.

**Admin page "Marketplace listing files"** (`/catalog/templates`, from initiative 9): lead line "Marketplace listing files
the system can fill. Each comes from the marketplace through its channel manager. The system fills them; it never sends
them."

Key copy for failure moments:
- "Noon listing file could not be made. The links sheet is fine." (fill failed)
- "No Styli file: Styli lists products itself. Send the links sheet to the Styli account team." (managed channel)
- "We could not check Namshi today (the site blocked our check). Nothing is marked not live because of this." (blocked)
- "Contamination: 6 holdout listings on Noon changed outside the system yesterday." (to the M4 owner)

## 6. Measurement

| Metric | Baseline | Target | Data source |
|---|---|---|---|
| Share of published content verified live (Noon, Namshi) | 0% (no gallery data for Noon or Namshi) | 90% of live listings within 3 business days of upload | `ListingObservation` + treatment log |
| Days from upload to verified live | unknown (Noon review about 3 business days) | measured per channel; our part (made to submitted) under 1 day | treatment log |
| Live watch coverage per day (holdout) | none | 90% or more observed | scrape log |
| Drift on holdout listings | unknown | every case detected within 24 hours | planted test + alerts |
| Reason coverage of not-live listings | 38% | 90% | `Rejection` + `catalog_liveness_daily` |
| Cells needing the operator per listing file (as share of non-commercial cells) | 100% by hand today (agency) | at or below 40% at golden fill (coverage 60%), falling as facts and text improve | fill records |
| Repeat rejections of the same cause after its rule is active | not measured | down 80% within 4 weeks of the rule | `Rejection` by cause and date |

## 7. Build slices

| Slice | What | Depends on | Acceptance test |
|---|---|---|---|
| M9-S1 (P0, part of S7) | Scraper fields for Noon and Namshi galleries (UAE, KSA): image URLs, count, titles EN and AR, pHash; Trendyol and Amazon feeds mapped; BigQuery table; gallery count per option for the holdout pool | channel keys in M0 (M0-F1); legal OK for own-listing scrape | M9-F1 acceptance test 4, then 3 |
| M9-S2 (P0) | Gallery-level states from M0's `verified_live` and `observed_other` events, contamination alert (from M0's incident), coverage line, Ops "Live check" block | M9-S1, M0-S6 matcher | M9-F1 acceptance tests 1 and 2 |
| M9-S3 (P1, after demo) | Template registry, parsers (Noon NIS, generic Excel, CSV), bindings, three-step admin flow | M5 channel registry, demo decision | An admin adds a Noon and a Namshi template without a deploy and confirms every binding |
| M9-S4 (P1) | Fill inside finalize with links, facts, M8 text and Arabic; shading; "Needs you"; re-read; "I uploaded this file"; golden fill compare tool | M9-S3, M2 facts contract, M8-S1 (and M8-S2 for Arabic) | M9-F2 acceptance test |
| M9-S5 (P1) | Rejection sources connected (error file drop, liveness reasons, Noon policy violations), reason taxonomy, `Rejection` rows | M0 listing state; data team for the stale Noon feed | M9-F3 acceptance test |
| M9-S6 (P1) | Rejection learning: fix requests, rule proposals, unmapped grouping, proactive sweep, weekly digest | M9-S5, M5-S5 editor, M3 and M8 fix entry points | M9-F4 acceptance test |

## 8. Risks and open questions

| Risk or question | Effect | Mitigation or recommended default |
|---|---|---|
| Scraping blocked, or against a site's terms; Saudi pages may need a Saudi network exit | Live verification and the holdout start date break | Own listings only, low rate, legal review first; fallback Trendyol counts (3,628 options matched) and bought tracking (42Signals) |
| Marketplaces re-compress or crop our images | False drift | pHash with a tuned threshold; tune on the first 200 verified pairs |
| The holdout treatment is a bulk upload by the channel team in week one (no API) | `submittedAt` unknown | Channel team clicks "I uploaded this file" or tells the M4 owner the date; live watch gives `liveFrom` anyway |
| Noon not-live feed stale since 21 Aug | Reason coverage target missed | Ask the data team to restore it (owner: data team); error file drop as a bridge |
| Portals may refuse a file with an extra tab or shading | First upload rejected | Side file fallback; first upload per channel is a checked step (initiative 9) |
| Managed channels (Styli, Centrepoint, 6th Street) send no template | No files for them | Push method `managed_by_channel`; send the links sheet; ask the account teams through M5-F5 |
| Amazon flat files are `.xlsm` (macros) | ExcelJS cannot write them | Ask for `.xlsx`; else Amazon waits for M9-F5 |
| Rejection reasons are generic (reported for Flipkart) or missing | Learning has little to learn from | Group and map once; count `unknown` and push channels for better reasons |
| A vendor in the demo already does Noon files and Arabic well | Building M9-F2 is waste | The decision rule above is written before the demo |
| Who clicks "I uploaded this file" when the channel team uploads | Missing submit dates | Default: whoever uploads; the M4 owner checks it for the holdout |

## 9. Integration decisions (2026-11-02)

| # | Decision | Why |
|---|---|---|
| D1 | One matcher: M0-F3 matches every observation (scrape, Trendyol feed, Amazon feed) with one pHash setting (default 6, uncertain 7-12). M9 collects the scrape and owns gallery states, alerts and coverage | M0 and M9 both specified verification, with thresholds 6 and 10 |
| D2 | The pre-holdout gallery table applies M4's eligibility rule (below the channel shot-set rule), not "fewer than 5 images" | The module map's treatment definition keeps the whole apparel pool; the under-5 filter would halve it |
| D3 | Contamination: M0 detects and writes the incident, M9 sends the one alert, M4 accounts for it | Three modules each claimed the alarm |
| D4 | Holdout listings are scraped daily for the whole window | M4 had weekly after week 3 |
| D5 | Open questions answered: scraper fields are built where the scraper lives today, with M9 owning the new fields and the verification job in this repo (the data team owner is asked in `../owner-questions.md`); try plain fetches for Saudi pages first | Technical defaults |
| D6 | Kept for the owner: legal review of scraping our own listings, a small Saudi proxy budget if plain fetches are blocked, the data team's help (scraper, stale Noon not-live feed), who clicks "I uploaded this file", Trendyol API credentials (`../owner-questions.md`) | Legal, money, people, marketplace relationships |
