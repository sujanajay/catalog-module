# DD7: Review ingestion and review-driven content fixes (B7a), with the shared layer B7b reuses

Date: 2026-10-22. Deep dive for bucket B7a of the Catalog Connect GCC program
(docs/plans/2026-10-21-catalog-connect-gcc-intent-map.md). B7b NPD insight is a separate product (DD10);
this document covers only what B7b consumes from the shared ingestion layer. This is an investigation
only. Nothing here is built, no GCP resource was changed, no paid scraper or model was used, and no
token or secret was read or written. Warehouse facts were read from BigQuery project
opptra-datawarehouse on 2026-10-22 (metadata and small aggregates only, no PII columns). The sample
pulls were a handful of public, logged-out page and JSON requests from one machine, with pauses between
them; reviewer names and order numbers were never printed or kept.

Words used in this document:
- **Rating**: a star score (1 to 5) with no text. **Review**: a rating with a title or comment text.
  Channels count these differently (Namshi showed 27 ratings but 11 reviews on one listing).
- **Theme**: a short, typed reason customers give, for example "runs small", "colour differs from photo",
  "sole feels hard". Each theme has a polarity (praise or complaint) and a count.
- **Content fix**: a change the catalog module can make or propose: a missing shot role (DD1), a fact
  sheet value to check (DD5), or an infographic callout (B5, DD6).
- **Delta**: the change in a listing's rating count between two Scout observations. A delta above zero
  means new feedback exists and the listing's text is worth fetching again.
- **Scout**: the opptra-scrapers marketplace scraper. **Managed actor**: a ready-made scraper run on
  Apify's cloud and paid per result.
- **Shared ingestion layer**: fetch and store reviews by platform and listing id, for any listing id
  (ours or a competitor's). It is shared with B7b. Theme analysis for content fixes is not shared.

## Summary

1. Review text is reachable without a login on 3 of the 9 GCC channels, proved by a tiny pull:
   **Namshi** (a public JSON list of every review, 11 of 11 with text, 2 in Arabic, for our USPA
   sneaker; 4 of 4 for a Skechers competitor, 1 in Arabic), **Trendyol** (review text and rating in the
   product page's structured data; a Q&A area exists) and **Amazon.ae** (the top 6 reviews on the guest
   product page, plus Amazon's AI "Customers say" summary and aspect chips on a competitor listing with
   7,510 ratings; our listing with 21 ratings had no summary). Amazon's full review list now redirects to
   sign-in.
2. **Noon** exposes only rating count and average in the catalog JSON Scout already reads; its review
   list endpoint returned "Access Denied" (HTTP 508, Akamai) twice from this machine. Managed actors for
   Noon reviews exist (USD 10.00 per 1,000 results; another at USD 19.49 a month) and show Noon stores a
   language and an English translation per review. Reaching it through Scout's proxy pool is untested.
3. **Styli** and **6thStreet** show star ratings collected after an order (their web code has
   `pdpRatings` and `/product-rating` calls) and no public review text was found. **Centrepoint** product
   pages carry no rating or review at all. `en-ae.6thstreet.com` now redirects to `en-ae.aivi.com`.
4. Volume is small. Scout sees our softline options on 6 GCC platforms with about 46,900 ratings in
   total (option level, latest observation), dominated by Noon (about 38,600 across UAE and KSA, very
   likely the same pooled reviews counted twice). Options with 10 or more ratings: 420 on Noon.ae, 444 on
   Noon.sa, 31 on Amazon.ae, 13 on Namshi.ae. Namshi is wide but shallow (463 options rated in UAE, a
   maximum of 27 ratings). Text reviews are a fraction of ratings, so the corpus to analyse is roughly
   ten thousand reviews, not hundreds of thousands.
5. The hypothesis holds in part. Scout's rating-count deltas are the right trigger for "which listings
   need a pull" (Noon: 189 UAE and 245 KSA listings gained ratings in the last 30 days). A
   `review_observation` table built on Scout's MERGE pattern is the right store. Managed actors are
   needed only for Noon (if Scout's proxies cannot reach the endpoint) and for Amazon depth beyond the
   top reviews; Namshi and Trendyol text is simpler to fetch in Scout than to buy.
6. Theme extraction costs about USD 0.02 per 1,000 reviews on a low tier and about USD 0.40 on a mid
   tier at OpenRouter list prices. The whole own-listing corpus costs well under USD 5 to tag once. Model
   cost is not the decision; data access and fix quality are.
7. Recommendation: build the shared ingestion layer as a Scout `reviews` entity (Namshi, Trendyol,
   Amazon top reviews and summary, Noon if reachable) writing `opptra_core.review_observation`, with one
   capped managed actor as the Noon fallback. The catalog module reads only its own products' reviews,
   tags themes on a low tier, maps each theme to a typed fix proposal, and shows Naz a "What customers
   say" list per brand. A review never becomes a product fact; it can only ask for a fact to be checked.
8. Approval asked: the channel scope (Namshi, Trendyol, Amazon.ae/.sa, Noon), Scout as the owner of
   ingestion with a capped Noon actor fallback, and the guard-railed theme to fix flow inside the module.

## Findings

### F1. What each channel exposes (sample pull, 2026-10-22, logged out)

Our listing ids came from `opptra_core.listing_observation` and `raw_gcc_dimensions.master_sl`. One
request per page unless stated; client: plain curl for Amazon, curl_cffi with a Chrome profile (the
client Scout uses, `requirements.txt` line 1) for the rest.

| Channel | Our listing tried | Competitor tried | Ratings and counts | Review text | "Customers say" or summary | Q&A | Arabic in sample | Result |
|---|---|---|---|---|---|---|---|---|
| Amazon.ae | USPA sneaker B0DZQ95D8L (21 ratings) | Skechers B07S7MTB5G (7,510 ratings) | Yes, on the guest page | Top 6 reviews on the guest page (title, stars, date, size, colour, verified flag, body). `/product-reviews/` redirects to `/ax/claim` (sign-in) | Yes on the competitor ("Customers find these sneakers lightweight and good-looking ... criticize the sole quality"), labelled "AI Generated from the text of customer reviews", with aspect chips such as "Lightweight (10)". Not shown on our 21-rating listing | Not checked | 0 of 6 | Reachable (top reviews and summary only) |
| Amazon.sa | Not pulled (same Amazon page template and Scout adapter family) | - | Scout has counts | Same as .ae expected | Same as .ae expected | - | - | Assumed same as .ae; check before build |
| Namshi.ae | USPA ZCC1ADD956C84DCA20CD2Z (27 ratings) | Skechers Z46262E41A8930D97DA5FZ (8 ratings) | `reviewSummary` in the page: average, count, 1 to 5 distribution | Public POST `/_svc/review/product-review/list` with `{"parentSku": ...}` returned all reviews: title, comment, rating, date, review code. 11 reviews of 27 ratings (ours), 4 of 8 (competitor). The response also carries `orderNr`, which must never be stored | No summary; the distribution is there | None seen | 2 of 11 ours, 1 of 4 competitor | Reachable, full text |
| Noon.ae / .sa | Campus Z2BC73B8EB6058D4C6B26Z (62 ratings) | - | `product_rating {count, value}` in the catalog JSON Scout already reads (HTTP 200) | `/_svc/reviews/fetch/v1/product-reviews/list` and `/_svc/review/product-review/list` both returned "Access Denied" (HTTP 508, Akamai). Scout's own notes say Akamai denies noon.com per exit range (`adapters/noon_ae.py` lines 33 to 37) | None | None seen | Not seen; actor schema shows `language`, `titleTranslation`, `commentTranslation` | Blocked from this machine; stopped after 2 tries |
| Trendyol (AE storefront) | USPA content id 883500380 (barcode 8684365472010) | Not pulled | JSON-LD `aggregateRating`: 4.9 from 10 ratings, `reviewCount` 2, `ratingScore`, `commentCount` | 2 `reviewBody` entries inline in the page (English). Full list API hosts `apigw.trendyol.ae` and `apigw.trendyol.com` referenced, not called | None | Yes: `merchant-questions` and `ask-question` routes in the page | 0 of 2 | Reachable (inline text) |
| Styli | 7046934603 | - | Star ratings: web code calls `/v1/ratings/pdpRatings` with a sku and a header token; ratings are submitted with an order | None found in the page or the 8 MB app bundle | None | None seen | - | Ratings only, token-gated, no text found |
| 6thStreet (now AIVI) | Search for "4W ALEXANDER MEN" | - | `/product-rating` and `/product-rating/save` in the app code (order-linked) | None found | None | None seen | - | Ratings only, no text found. `en-ae.6thstreet.com` redirected to `en-ae.aivi.com` |
| Centrepoint | 167613192 | - | No rating or review markup in a 1.26 MB product page | None | None | None | - | Nothing to ingest |
| Amazon.com | Not in scope for our GCC listings | - | - | - | - | - | - | Only relevant to B7b competitors; see F4 |

Arabic share: 3 of 23 sampled reviews (13%) were Arabic, all on Namshi; one was a size complaint ("I
asked for size 41, size 43 came"). The sample is tiny; the real share must come from the first full
Namshi and Noon pull. Every theme step must read Arabic and English.

Not done: no Apify run was made. Every relevant actor needs an Apify account token and either a paid
per-result price or the free plan's USD 5 monthly credit on the owner's account; that is an owner
question (see "Questions only the owner can answer"), not a spend this deep dive may make.

### F2. Data volume from Scout (exact, `opptra-datawarehouse.opptra_core.listing_observation`)

Table: 1,142,054 rows; columns include `platform`, `marketplace_listing_id`, `brand`, `rating`,
`review_count`, `scrape_date`. Query shape: latest observation per platform and listing since
2026-01-01, then joined to `raw_gcc_dimensions.master_sl` on the channel id (Amazon on `amazon` ASIN;
Namshi and Noon on `namshi_ae`, `namshi_sa` or the parent of `child_zsku`; Noon and Namshi share the
same Z ids), then the largest count per softline option.

All GCC rows Scout holds (any brand, latest per listing):

| Platform | Listings | With a rating | Sum of rating counts | Largest |
|---|---|---|---|---|
| Amazon.ae | 2,946 | 977 | 284,657 | 16,760 |
| Amazon.sa | 1,208 | 1,050 | 1,641,718 | 71,083 |
| Namshi.ae | 4,902 | 1,648 | 5,147 | 27 |
| Namshi.sa | 4,916 | 1,812 | 5,462 | 27 |
| Noon.ae | 1,243 | 711 | 42,579 | 1,411 |
| Noon.sa | 1,198 | 772 | 49,351 | 1,511 |

The Amazon totals are mostly not our softline (Garmin and other non-softline rows; `brand` is empty on
all Noon rows and most Amazon rows, so Scout rows must be joined to master_sl to know what is ours).

Our softline options only (option level):

| Platform | Options Scout sees | Options with a rating | Options with 10 or more | Options rated under 4.0 | Sum of rating counts |
|---|---|---|---|---|---|
| Amazon.ae | 456 | 142 | 31 | 40 | 838 |
| Amazon.sa | 20 | 12 | 8 | 4 | 5,565 |
| Namshi.ae | 2,255 | 463 | 13 | 7 | 1,042 |
| Namshi.sa | 1,287 | 351 | 12 | 7 | 906 |
| Noon.ae | 896 | 714 | 420 | 93 | 19,021 |
| Noon.sa | 868 | 747 | 444 | 94 | 19,553 |
| Total | | | | | 46,925 |

By brand, USPA carries most of it (Noon.ae 15,419 ratings over 528 options, Noon.sa 15,445), then Campus
(Noon.ae 3,488, Noon.sa 3,964; Amazon.sa 5,335 over 10 options, which looks like a pooled parent count).
Cardio Bunny, Keds and Vero Moda have almost nothing (Cardio Bunny: 0 on Namshi, 3 and 8 on Noon).

Coverage gaps: Scout watches 896 of the 3,540 options listed on Noon in master_sl, 2,255 of 3,541 on
Namshi, 456 of 2,437 on Amazon (DD9 F1 for the master counts). Trendyol, Styli, Centrepoint and
6thStreet have no Scout adapter (`adapters/__init__.py` CAPABILITIES lists only Amazon, Amazon.ae,
Amazon.sa, Flipkart, Myntra, Blinkit, Zepto, Instamart, Noon.ae/.sa, Namshi.ae/.sa).

Approximate text corpus: Noon UAE and KSA counts are nearly equal option by option, which points to one
pooled review set; counting it once gives about 27,000 unique ratings across channels. Namshi showed 11
reviews for 27 ratings (41%). At a 40% text share, the own-listing corpus is roughly 11,000 reviews.
This is approximate and is replaced by the exact count after the first pull.

Rate of new feedback (rating count change over the 30 days to 2026-10-22, any brand):

| Platform | Listings with counts | Listings that gained ratings | Ratings added | Median days observed |
|---|---|---|---|---|
| Amazon.ae | 945 | 222 | 6,408 | 1 |
| Amazon.sa | 1,022 | 205 | 3,271 | 1 |
| Namshi.ae | 1,648 | 7 | 7 | 1 |
| Namshi.sa | 1,589 | 4 | 4 | 1 |
| Noon.ae | 708 | 189 | 776 | 10 |
| Noon.sa | 772 | 245 | 1,201 | 10 |

Most listings are observed on only one day in the window, so deltas are reliable only where Scout runs
on a schedule (Noon has a median of 10 observed days). The delta trigger needs the review-bearing listings
on a regular Scout schedule.

### F3. Scout today (repo evidence, read only, `C:\Users\Sujan Ajay\Desktop\opptra-scrapers`, commit bb45bfb)

- `engine/contracts.py` line 17: `ENTITIES = ("product", "reviews", "offers", "category", "media", "search")`.
  The `reviews` entity is declared but has no handler in `adapters/__init__.py` `ENTITY_DISPATCH`.
- `MASTER_PLAN.md` line 58 "P3 Reviews / VOC: Full review corpus (session-gated)"; line 587 "Reviews
  entity (Amazon): Paginated, session-gated"; line 686 "Do not start MCP, reviews UI, or multi-VM until
  Phase 1 exit criteria met". `high_level_product_plan.md` line 106: the reviews path is parked and the
  12 to 13 account session pool "carries ban/ToS exposure".
- Rating and count are already parsed: `adapters/amazon_ae.py` line 652 (`_acr_fields`), `adapters/noon_ae.py`
  lines 221 to 222 (`product_rating`), `adapters/namshi_common.py` lines 469 to 483 and 1737 to 1739
  (JSON-LD `aggregateRating`, then an HTML fallback).
- Amazon content capture already isolates a "customer reviews" block so it is not mistaken for A+
  content: `adapters/amazon_content.py` lines 80 and 124.
- MERGE pattern: `engine/bqstore.py` `merge_rows` (line 879) stages rows to a temporary table and
  MERGEs by `observation_id` with a `scrape_date` partition filter; never truncates; refuses empty or
  mismatched days (lines 893 to 910). Regional platforms are forced through MERGE (lines 35 to 47).
- Sibling table pattern: `sql/create_listing_content_observation.sql` (partitioned by `scrape_date`,
  clustered by `platform, marketplace_listing_id`, `require_partition_filter = TRUE`, joined to
  listing_observation on `scraping_id`). `review_observation` would follow the same shape.
- Scheduling: `engine/schedulestore_pg.py` (Postgres schedules, per-user caps) and `engine/schedule_*.py`.
- Noon access: `adapters/noon_ae.py` lines 28 to 52 (catalog JSON URL, pinned chrome136 profile,
  homepage referer, sticky exit per session).
- Config: `config.py` lines 155 to 189 (dataset `opptra_core`, default project `opptra-o2c-staging`,
  production `opptra-datawarehouse`).

### F4. Options for getting review text (prices read 2026-10-22)

| Source | Channels | What you get | Exact public price | Fit and risks |
|---|---|---|---|---|
| Scout `reviews` entity (build) | Namshi (proved open), Trendyol (inline proved; list API untested), Amazon.ae/.sa top reviews and summary (proved), Noon (untested through Scout proxies) | Raw JSON or HTML in GCS plus typed rows in BigQuery, by platform and listing id, any brand | No licence cost; uses Scout's existing proxies and Cloud Run jobs | Reuses scheduling, MERGE, raw store, drift alerts. Needs a new Trendyol adapter. Must not un-park the logged-in Amazon session farm |
| Apify managed actors (buy per result) | Noon: getdataforme Noon Reviews Scraper USD 10.00 per 1,000 results (no platform fee; residential proxy in the example; 6 users) or scrapestorm "Noon Reviews Scraper - Cheap" USD 19.49 a month plus usage (23 users). Amazon: junglee Amazon Reviews Scraper from USD 3.00 per 1,000 reviews, at most 100 per star per product (500 best case); amazon.ae/.sa support not stated. Trendyol: shahidirfan Trendyol Reviews Scraper from USD 1.00 per 1,000 results plus platform usage; solidcode Trendyol Scraper USD 0.80 per 1,000 reviews; both show trendyol.com (Turkey) only | Review JSON per run | Apify plans: Free USD 0 with USD 5 monthly usage; Starter USD 19; Scale USD 199; Business USD 999 a month (usage equal to the fee; compute unit USD 0.20, 0.20, 0.16, 0.13) | Fast to try. Small, single-author actors with few users; GCC storefront support is unproven for Amazon and Trendyol; output schemas differ per actor; a token must live in Secret Manager |
| Marketplace seller APIs | Amazon SP-API Customer Feedback API | Review topics and month-on-month trends per ASIN, "customer snippets" per browse node; English only; weekly refresh | No API fee stated | Marketplaces are US, UK, FR, IT, DE, ES, JP only. Not UAE or KSA, so it does not cover our GCC listings. Needs the Brand Analytics or Selling Partner Insights role. Noon, Namshi, Trendyol, Styli, Centrepoint: no review API found in public seller docs (DD5 F3 found their template and listing docs are mostly behind seller logins) |
| Review-analytics vendors | Wonderflow, DataWeave, Revuze (DD10) | Dashboards, themes, benchmarks | No public prices (custom quotes; one listing shows USD 30,000 with no period, DD10) | Enterprise fit; GCC marketplace coverage and Arabic not confirmed; themes would sit outside the catalog module and could not drive shot roles or fact sheet checks without an integration |

Sources: [Apify pricing](https://apify.com/pricing),
[Noon Reviews Scraper (getdataforme)](https://apify.com/getdataforme/noon-reviews-scraper),
[Noon Reviews Scraper - Cheap (scrapestorm)](https://apify.com/scrapestorm/noon-reviews-scraper---cheap),
[Amazon Reviews Scraper (junglee)](https://apify.com/junglee/amazon-reviews-scraper),
[Trendyol Reviews Scraper (shahidirfan)](https://apify.com/shahidirfan/trendyol-reviews-scraper),
[Trendyol Scraper (solidcode)](https://apify.com/solidcode/trendyol-scraper),
[SP-API Customer Feedback API](https://developer-docs.amazon/sp-api/docs/customer-feedback-api).

### F5. Theme extraction cost (OpenRouter public models endpoint, read 2026-10-22, USD per million tokens)

Assumptions (approximate): reviews are short (the sample averaged a sentence or two, about 60 tokens with
metadata); 50 reviews per call; an 800-token instruction with the theme list; about 25 output tokens per
review (theme keys, polarity, quote span). Per 1,000 reviews: 20 calls, about 76,000 input and 25,000
output tokens.

| Tier | Model (doc only, never shown to the operator) | Input | Output | Cost per 1,000 reviews | Own corpus once (about 11,000 reviews) |
|---|---|---|---|---|---|
| Low, closed | google/gemini-2.5-flash-lite | 0.10 | 0.40 | USD 0.018 | USD 0.19 |
| Low, closed | anthropic/claude-haiku-5.5 | 0.10 | 0.50 | USD 0.020 | USD 0.22 |
| Low, open weights | qwen/qwen3-235b-a22b-2507 | 0.09 | 0.55 | USD 0.021 | USD 0.23 |
| Low, open weights | mistralai/mistral-small-3.2-24b-instruct | 0.094 | 0.25 | USD 0.013 | USD 0.14 |
| Mid, closed | google/gemini-3.7-flash | 0.75 | 3.75 | USD 0.151 | USD 1.66 |
| Mid, closed | anthropic/claude-sonnet-5.5 | 2.00 | 10.00 | USD 0.402 | USD 4.42 |
| High, closed | anthropic/claude-opus-5.5 | 4.00 | 20.00 | USD 0.804 | USD 8.84 |

A second step turns one product's themes into fix proposals (about 3,000 input and 500 output tokens per
product): USD 0.011 per product on claude-sonnet-5.5 list price, about USD 10 for every one of the roughly
750 options that have Noon ratings today, and nothing for products with no new reviews.

Open vs closed: at this volume open-weights models on OpenRouter cost the same as closed low tiers,
so the choice is quality on Arabic and on the fixed theme list, measured on a labelled golden set.
Self-hosting an open model is not worth it: the whole yearly tagging bill is a few dollars.

### F6. catalog-module today (repo evidence, worktree `01-intent-map`, commit 224613e)

- Needs-attention pattern: `apps/web/components/catalog/AttentionList.tsx` (cards per product, decided
  photos shown as "Resolved", 120-second polling), `apps/web/components/catalog/AttentionProductCard.tsx`,
  `apps/web/app/api/catalog/batches/[id]/attention/route.ts`, tests in
  `apps/web/test/catalog-attention-ui.test.ts` and `catalog-attention-routes.test.ts`; spec
  `docs/specs/07-qa-attention-and-skus.md`. Attention is batch-scoped today; review feedback is
  product-scoped and arrives between batches.
- Brand and product pages exist: `apps/web/app/catalog/brands/[slug]/page.tsx`,
  `apps/web/app/catalog/products/[brand]/[key]/page.tsx`.
- Model choice: `packages/core/src/llm/llm.ts` line 3 and line 79 ("a model is required (it comes from
  model_policy)"); `model_policy` table in `packages/core/src/db/schema.ts` line 190.
- Spend ledger: `spend_days` with `SPEND_ENGINES = ["catalog_qa", "catalog_compute"]`
  (`packages/core/src/db/schema.ts` lines 63 and 546); cost recording in `packages/core/src/catalog/cost.ts`.
- Channel ids per SKU: `SKU_CHANNEL_KEYS` (`schema.ts` line 75) already holds `namshi_ae`, `namshi_sa`,
  `child_zsku`, `noon_ae`, `noon_sa`, `trendyol`, `amazon`, `amazon_uae_ksa_asin`, so the module can list
  its own listing ids per product without new mapping.
- BigQuery read path: `packages/core/src/catalog/master-sync.ts` (injected `BigQueryLike`, read only).
- Scheduled jobs: `infra/bootstrap.sh` `ensure_scheduler_job` (line 492).
- No review, rating, theme or voice-of-customer code exists in the module. The fact sheet reserves
  `voiceOfCustomer: list of { theme, polarity, count, sourceRef }` (DD5, proposed schema).

## How review themes become content fixes

### Theme list (closed list, versioned, English keys; reviews in Arabic or English map to the same keys)

| Theme key | Example review words | Fix type | Target |
|---|---|---|---|
| `fit_runs_small` / `fit_runs_large` | "order one size up", "طالب مقاس 41 جاي 43" (size sent wrong, see guard rail 5) | Fact check + callout | DD5 `variants[].sizeIntl` and size chart check; B5 "Fits small, choose one size up" callout only after the brand or operator confirms |
| `colour_differs_from_photo` | "not like picture", "colour doesn't match the images" | Image check | DD1 shot set re-checked; QA judge colour-fidelity re-run on the published shots; DD5 `colourName` / `colourFamily` check |
| `material_quality_doubt` | "poor quality", "cheap material" | Shot + fact check | Add FC fabric close-up if missing (DD1 role FC; PK detail for footwear); DD5 `composition[]` must be `confirmed` |
| `authenticity_doubt` | "not sure original or not" | Shot | PK detail of logo, label or box (DD1 PK sub-views) |
| `sole_or_comfort` (praise or complaint) | "sole very hard", "lightweight", "memory foam comfortable" | Callout | B5 callout from DD5 `features[]` only (for example "memory foam insole"); praise raises the callout's order, complaint never becomes a callout |
| `wanted_view_missing` | "wish I could see the back / the sole / on a model" | Shot | Missing DD1 role (BH, FL, PK sole, LO for footwear) flagged for B2 or B3 fill |
| `size_chart_confusion` | "size chart wrong", "EU vs UK" | Fact check | DD5 `variants[].sizeSystem` and the channel's size mapping |
| `durability_defect` | "broken after a week" | Route out | Not a content fix. Shown to Naz as "share with the brand team"; never a callout or fact |
| `delivery_or_service` | "late", "wrong item sent" | Ignore | Not content; counted, not shown as a fix |
| `other` | anything else | None | Kept for the B7b owner and for list revisions |

### Flow

1. Ingestion (shared layer, F4 option chosen below) writes raw reviews per platform and listing id.
2. The catalog module selects reviews for its own products only, by joining its `sku_map` channel ids to
   `review_observation` (read only).
3. A low-tier text model tags each review with theme keys, polarity and the quoted span that supports it.
   The model comes from a policy row like `model_policy`, chosen automatically and never shown.
   The span must be found verbatim in the review text or the tag is dropped (a code check).
4. Per product and channel, counts are kept as DD5 `voiceOfCustomer` entries
   `{ theme, polarity, count, sourceRef }` where `sourceRef` names the platform, listing id and review
   codes. A theme counts only with at least 3 reviews and at least 10% of the listing's text reviews
   (thresholds to tune on the golden set).
5. A code table (the table above) maps each theme to a fix type. A model may write the one plain
   sentence Naz reads; it may not choose the fix type.
6. Hand-off to B5 / DD6 (infographics, in parallel): the module passes a list of
   `{ productId, featureKey, reason: "customers praise", evidenceCount }` that may only reorder or select
   among existing DD5 `features[]` with status `confirmed`. DD6 decides layout and rendering.

### Guard rails

1. A review claim never becomes a product fact. It can only create a "check this" on an existing fact
   sheet field, which a fact sheet source (brand sheet, sku_master_p2p, operator) must answer.
2. A callout's text always comes from DD5 `features[]` or confirmed facts, never from review words.
   "Customers love..." style copy and any rating or review count are never rendered on images.
3. Complaints never become callouts. They become shot or fact checks, or "share with the brand team".
4. Competitor reviews are never stored or shown in the catalog module (DD10 line). They may inform B7b
   only.
5. Fulfilment complaints (wrong size sent, late) are separated from product complaints so a "size sent
   wrong" review does not count as `fit_runs_small`; the golden set includes Arabic examples of both.
6. Reviewer names, order numbers (Namshi `orderNr`) and any reviewer profile data are dropped at
   ingestion and never written to any table.
7. The theme step's accuracy is measured on a labelled golden set (English and Arabic, at least 200
   reviews across Noon, Namshi, Trendyol and Amazon) before any proposal is shown; until it passes,
   themes are logged, not shown.

## Options

| Option | What it is | Cost | Trade-offs |
|---|---|---|---|
| A. Scout for counts, managed actors for all text, review_observation via MERGE (the brief's hypothesis) | Scout deltas pick listings; Apify actors fetch text on every channel | Actors: Noon USD 10.00, Amazon from USD 3.00, Trendyol from USD 0.80 to 1.00 per 1,000 reviews, plus an Apify plan (USD 19 Starter is enough) | Simple to start; but three single-author actors with different schemas, GCC storefront support unproven for Amazon and Trendyol, and Namshi has no actor while its open endpoint is the easiest of all |
| B. Scout for counts and text where open, one capped actor for Noon only (recommended) | Scout `reviews` entity for Namshi, Trendyol, Amazon guest-page reviews and summary, and Noon through its proxy pool; Apify Noon actor only if Scout's Noon calls stay blocked | Noon actor at USD 10.00 per 1,000 results: about USD 190 for a first pull of about 19,000 pooled Noon ratings' worth of reviews (upper bound, fewer if text share is lower), then about USD 8 to 12 a month at the observed 776 to 1,201 new Noon ratings a month. Other channels: no licence cost | One owner, one schema, one MERGE path, reusable by listing id for B7b. Needs a Trendyol adapter. Amazon depth stays at the top reviews plus summary |
| C. Scout only, including the logged-in Amazon session farm | Un-park Scout's P3 plan | No licence cost | Full Amazon depth, but Scout's own docs flag ban and terms exposure on personal accounts and a session refresh burden. Not worth it for 31 Amazon.ae options with 10 or more ratings |
| D. Buy a review-analytics vendor | Wonderflow, DataWeave, Revuze | Quote only | Themes outside the module; no route to shot roles or fact checks without an integration; coverage of Noon, Namshi and Arabic unconfirmed |
| E. Amazon SP-API Customer Feedback API | Seller API topics | No fee stated | Not available for UAE or KSA; English only. No fit for our listings |

Who owns ingestion:

| Placement | Fit |
|---|---|
| In opptra-scrapers (Scout) | Best. Scout already schedules, fetches GCC pages through proxies, keeps raw copies and MERGEs to `opptra_core`; it already serves any listing id, so B7b can add competitor ids without catalog changes |
| In catalog-module | Poor. Would duplicate proxies and scheduling, and would pull competitor data into the catalog product against DD10's line |

## Recommendation

### R1. Channels in scope

Namshi (UAE, KSA), Noon (UAE, KSA), Trendyol (AE storefront), Amazon.ae and Amazon.sa. Out of scope until
the owner shows seller-portal data: Styli and 6thStreet / AIVI (ratings only, no public text found) and
Centrepoint (no ratings or reviews on the page). VogaCloset and Shein were not examined; they hold 387
and 1,197 options (DD9) and can be added later through the same entity.

### R2. Shared ingestion layer (Scout, opptra-scrapers)

- Register `("Namshi.ae" | "Namshi.sa" | "Noon.ae" | "Noon.sa" | "Amazon.ae" | "Amazon.sa" | "Trendyol.ae", "reviews")`
  in `ENTITY_DISPATCH`, logged out only. Amazon: top reviews and the "Customers say" summary and aspect
  chips from the guest product page, no session farm.
- New table `opptra_core.review_observation`, same shape rules as `listing_content_observation`
  (partition by `scrape_date`, cluster by `platform, marketplace_listing_id`, partition filter required),
  written by `merge_rows`. Key: `platform + marketplace_listing_id + review_code` (or a hash of date,
  rating and text where a channel has no code). Columns: platform, listing id, parent id, review code,
  rating, title, comment, review date, language, translated text when the channel provides it, verified
  flag, size and colour bought when shown, `kind` (`review` or `summary` or `aspect`), raw URI, run id,
  loaded_at. No name, no order number, no profile fields.
- Trigger: Scout's existing rating-count delta. A listing is re-pulled when its `review_count` rose since
  its last `review_observation` pull; every review-bearing listing gets a full re-pull once a month to
  catch edits and deletions. Our review-bearing Noon and Namshi listings go on a regular Scout schedule so
  the delta is measurable (today the median listing is seen on 1 day in 30).
- Noon fallback: if Scout's proxy pool also gets "Access Denied" on the review endpoint, Noon text comes
  from one Apify actor, chosen after a free-credit trial on the owner's account, with a monthly cap set in
  the Apify console and the token in Secret Manager.
- Input is any listing id list. B7b supplies competitor ids to the same entity; the catalog module never
  reads those rows.

### R3. Inside catalog-module (B7a)

- A Cloud Run job, scheduled through `infra/bootstrap.sh`'s scheduler pattern (min instances 0), reads
  `review_observation` for its own products' channel ids, tags new reviews, updates DD5 `voiceOfCustomer`
  in a new fact sheet version and writes fix proposals to a new `catalog_review_fixes` table
  (product_id, channel, theme, polarity, count, fix_type, target, status open/accepted/dismissed,
  evidence review codes, fact_sheet_version).
- Spend is recorded in `spend_days` under a new engine value (for example `catalog_reviews`) with its own
  daily cap. Model choice comes from a policy row; no model id reaches the UI.
- Tests mock OpenRouter (AGENTS.md); a live smoke run happens only in a Cloud Run job gated by
  `LIVE_SMOKE=1`.

### R4. What Naz sees

- A "What customers say" tab on the brand page (`apps/web/app/catalog/brands/[slug]/page.tsx`) and a
  short panel on the product page, built from the `AttentionProductCard` pattern but product-scoped, not
  batch-scoped.
- One card per product with an open fix, in plain words, for example: "Noon: 12 of 40 reviews say these
  run small. Check the size chart, or add 'choose one size up' once the brand confirms." or "Namshi: 5
  reviews say the colour looks different from the photos. Re-check the photos for this colour." Each card
  shows the channel, the count and two short quotes (Arabic shown with its translation when the channel
  gives one). No model names, no confidence numbers, no reviewer names.
- Buttons: "Add to next batch" (shot fixes go to the batch wizard as missing roles), "Check fact"
  (opens the DD5 product details view on that field), "Send to brand team" (durability), "Dismiss" with a
  short reason. Accepted and dismissed cards show as "Resolved", as attention cards do today.
- A count badge on the brand page ("7 products with customer feedback to review"). Refresh: deltas checked
  on Scout's schedule; texts pulled when counts rise; themes recomputed when a product gains new reviews;
  a full refresh once a month.

### R5. Context7 and libraries

Context7 was not available in this session. No new library is recommended for the catalog side (the
module already has its BigQuery client pattern, drizzle and the OpenRouter layer). Before any build,
check with Context7: `@google-cloud/bigquery` (read path used by the job), Apify's API client if the
Noon fallback is chosen, and curl_cffi (Scout's pinned version) for the new reviews handlers.

### R6. Draft SPEC.md amendment (for the owner at Gate C)

"The module reads customer reviews of its own listings from Opptra's shared review store, read only. A
text model groups reviews into a fixed list of themes; code maps each theme to a proposed fix (a missing
shot, a fact to check, or the order of an existing callout). Review text never becomes a product fact or
callout text, competitor reviews are never stored or shown, and reviewer names and order numbers are
never kept. No model names appear in the operator UI."

## B7b: what NPD consumes from the shared layer (short)

- The same `opptra_core.review_observation` table, filled for competitor listing ids the NPD owner
  registers in Scout (for example BlissClub on Myntra or Amazon.in, Lululemon where a channel lists it;
  brand-site reviews need adapters Scout does not have, DD10).
- The theme list (keys and definitions) as a shared, versioned document, so NPD can compare like with
  like. NPD runs its own tagging and cross-brand analysis outside the catalog module and pays its own
  model and actor costs.
- Not shared: `catalog_review_fixes`, fact sheets, shot roles, and the module's model policy.

## Exact costs

| Item | Cost | Basis |
|---|---|---|
| Scout reviews entity (Namshi, Trendyol, Amazon guest pages, Noon via proxies) | No licence cost; runs on Scout's existing jobs and proxy plan | F3, F4 |
| Noon fallback, getdataforme actor | USD 10.00 per 1,000 results; first pull upper bound about USD 190 (about 19,000 pooled Noon ratings, fewer reviews with text); then about USD 7.80 to 12.00 a month at 776 to 1,201 new Noon ratings a month | F2, F4. Approximate |
| Noon fallback, scrapestorm actor | USD 19.49 a month plus usage | F4 |
| Apify plan if needed | Free USD 0 (USD 5 usage); Starter USD 19 a month | F4 |
| Amazon depth via junglee actor (not recommended now) | From USD 3.00 per 1,000 reviews; at most 500 per product | F4 |
| Trendyol via actor (not recommended now) | USD 0.80 (solidcode) or from USD 1.00 (shahidirfan) per 1,000 reviews; AE storefront unproven | F4 |
| Theme tagging, low tier | About USD 0.013 to 0.021 per 1,000 reviews; about USD 0.14 to 0.23 for the whole own corpus once | F5. Approximate |
| Fix proposals, mid tier | About USD 0.011 per product with new reviews; about USD 8 for the roughly 750 options with Noon ratings | F5. Approximate |
| Golden set labelling | Owner's reviewer (Arabic reader); no vendor cost | 200 reviews |
| Review-analytics vendors | Quote only | DD10 |

## Repo evidence

catalog-module (worktree `C:\Users\Sujan Ajay\Desktop\catalog-module-wt\01-intent-map`):
- `apps/web/components/catalog/AttentionList.tsx`, `apps/web/components/catalog/AttentionProductCard.tsx`
- `apps/web/app/api/catalog/batches/[id]/attention/route.ts`
- `apps/web/test/catalog-attention-ui.test.ts`, `apps/web/test/catalog-attention-routes.test.ts`
- `apps/web/app/catalog/brands/[slug]/page.tsx`, `apps/web/app/catalog/products/[brand]/[key]/page.tsx`
- `packages/core/src/llm/llm.ts`, `packages/core/src/llm/openrouter.ts`, `packages/core/src/catalog/cost.ts`
- `packages/core/src/db/schema.ts` (`SPEND_ENGINES`, `spend_days`, `model_policy`, `SKU_CHANNEL_KEYS`)
- `packages/core/src/catalog/master-sync.ts` (BigQuery read pattern)
- `infra/bootstrap.sh` (`ensure_scheduler_job`)
- `docs/specs/07-qa-attention-and-skus.md`
- `docs/plans/deep-dives/05-attributes-listing-fill.md` (fact sheet, `voiceOfCustomer`, `features[]`),
  `01-shot-roles-channel-compliance.md` (roles FM, FL, FC, BH, HS, PK, LO, LS), `10-boundary-forecasting-npd.md`

opptra-scrapers (`C:\Users\Sujan Ajay\Desktop\opptra-scrapers`, read only, commit bb45bfb):
- `engine/contracts.py` (line 17), `adapters/__init__.py` (`ENTITY_DISPATCH`, `CAPABILITIES`)
- `adapters/amazon_ae.py`, `adapters/amazon_content.py`, `adapters/noon_ae.py`, `adapters/noon_common.py`,
  `adapters/namshi_common.py`
- `engine/bqstore.py` (`merge_rows`, `MERGE_ONLY_PLATFORMS`), `sql/create_listing_content_observation.sql`,
  `sql/create_listing_observation.sql`, `engine/schedulestore_pg.py`, `config.py`
- `MASTER_PLAN.md` (lines 58, 263 to 270, 587, 686), `high_level_product_plan.md` (lines 48, 106),
  `requirements.txt`

Warehouse (opptra-datawarehouse, read only): `opptra_core.listing_observation`,
`raw_gcc_dimensions.master_sl`, `gcc_channel_reports.product_list_trendyol_3p_uae` (Trendyol link only).

## Depends on earlier DD answers

Gate B is assumed open with every earlier recommendation approved. If the owner answers differently:

- **DD0 taxonomy.** Themes are reported per category (a "sole" theme only for footwear). A different
  taxonomy changes which themes apply to which products, not the ingestion.
- **DD1 / DD1a shot roles.** Shot fixes name DD1 roles. If roles are not approved, shot fixes become
  free-text notes ("customers want to see the back") with no link to the batch wizard's missing roles.
- **DD2 / DD3 / DD8 generation.** If generated shots are approved, a "missing view" fix can be filled by
  B2 or B3; if not, it can only ask for a new photo from the brand.
- **DD5 fact sheet.** This design writes `voiceOfCustomer` and raises checks on DD5 fields. If DD5 is not
  approved, themes are stored in `catalog_review_fixes` only, fact checks become notes, and there is no
  `features[]` list for callouts, so the B5 hand-off is empty.
- **DD6 infographics (in parallel).** Only the hand-off record is defined here. If DD6 drops callouts,
  callout fixes are not produced; shot and fact fixes are unaffected.
- **DD9 business impact.** Not used for a money case; review volume here comes from Scout directly.
- **DD10 boundary.** This design follows DD10: shared ingestion by listing id, competitor reviews never in
  the catalog module. One difference: DD10 placed "one theme tagger" in the shared layer; this document
  keeps tagging in the catalog module for own products and shares only the theme list, so NPD's model
  spend and analysis stay outside. If the owner wants one shared tagger, it moves to a Scout-side job
  writing a `review_theme` table, and the catalog job reads it instead of tagging.

## Questions only the owner can answer

1. Who builds the Scout `reviews` entity and `review_observation` table: the catalog team inside
   opptra-scrapers, or Scout's maintainers? (Scout's plan parks reviews until its Phase 1 exit.)
2. May one Apify account be opened (or an existing one used) for the Noon fallback, with a free-credit
   trial first and then a monthly cap you set? Which cap? No pull was made here because it needs your
   token and possibly paid usage.
3. Do Styli, 6thStreet / AIVI or Centrepoint give sellers review or rating exports in their portals?
   If yes, they can be added as a file source.
4. Is the `en-ae.6thstreet.com` to `en-ae.aivi.com` redirect a known rebrand, and do our 6thStreet listing
   ids carry over?
5. Who can label the 200-review golden set in Arabic and English?
6. Should "durability" complaints go to a named brand team contact, and who?
7. May Scout add all review-bearing Noon and Namshi listings of our softline brands to a regular schedule
   (proxy usage rises with it)?

## Approval question

Do you approve (1) the channel scope Namshi, Noon, Trendyol and Amazon.ae/.sa, with Styli, 6thStreet /
AIVI and Centrepoint out until seller data is shown; (2) the shared ingestion layer as a Scout `reviews`
entity writing `opptra_core.review_observation` by MERGE, triggered by Scout's rating-count deltas,
logged out only (no Amazon session farm), with a single capped Apify Noon actor as the fallback if Scout
cannot reach Noon reviews; and (3) the in-module flow: low-tier theme tagging of our own reviews only,
code-mapped fix proposals (shot roles, fact sheet checks, callout order) shown to Naz in a "What customers
say" tab, under the guard rails above (no review claim becomes a fact or callout text, no competitor
reviews, no reviewer data kept)?

Status: written 2026-10-22, awaiting owner answer. Nothing implemented, no spend.
