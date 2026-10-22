# DD10: Boundary memo - B8 forecasting and product selection, B7b NPD insight

Date: 2026-10-22. Program: Catalog Connect GCC (docs/plans/2026-10-21-catalog-connect-gcc-intent-map.md).
This is a short boundary memo, not a design. Nothing here is implemented. Warehouse facts were read from
BigQuery project opptra-datawarehouse on 2026-10-22 (metadata and small aggregates only, no PII columns).

## Summary

- The owner's rule holds and the evidence backs it: forecasting and NPD insight have no dependency on
  image generation, rendering or publishing. They belong outside the catalog module.
- Opptra already runs a demand-driven planning product: Channel Replenishment v2 in the gcc-dashboard repo
  (job `channel-replen-v2-job`, 118 runs, last run today, writes `fact_gcc.channel_replen_by_sku`,
  935,855 rows). It is rate-of-sale replenishment, not a seasonal forecast. Business requirements come from
  Ashish and Mahesh; engineering is the gcc-dashboard team (Sujan, Vijay PK).
- No forecasting model, assortment, product-selection or NPD table exists anywhere in the warehouse.
  The public claims ("anticipate demand", "Revenue and volume forecasting", "85% AI-operated decisions",
  "competitive benchmarks") are not backed by a forecast table that this memo could find.
- History is short for seasonal forecasting: of 23 GCC brands in `fact_gcc.unified_sales_tertiary_v2`,
  only USPA (23 months) and Nautica (22) cover two Ramadan / White Friday cycles; Cardio Bunny starts
  2026-03-16 (8 months, about USD 72k trailing 12 months).
- The NPD benchmark (Cardio Bunny vs BlissClub and Lululemon) needs competitor review text, ratings and
  prices. Scout (opptra-scrapers) watches Opptra's own listings only, has no review text (the reviews
  entity is parked) and no brand-site adapters. No BlissClub or Lululemon rows exist today.
- The only overlap with the catalog module is the shared review ingestion layer (B7a, DD7). The line:
  ingestion is shared, analysis for NPD is not.
- Recommendation: B8 and B7b are OUT of this team. B8 extends Channel Replenishment (gcc-dashboard).
  B7b is a small separate product that reuses the B7a ingestion layer once it exists.

## 1. What Opptra already has

Public claims (opptra.com home page and the `?tab=ai` tab, read 2026-10-22):

- "AI-driven automation helps us anticipate demand, allocate inventory, and manage operations across
  channels at scale"; "inventory is managed automatically"; "Revenue and volume forecasting" (growth and
  channel strategy service).
- "Buying behavior is shaped by local search patterns, languages spoken, festive seasons, pay cycles, and
  cultural context." Festive seasons are named; climate and weather are not mentioned on either page.
- A headline stat "85%" labelled "AI-operated decisions".
- "pricing patterns, demand signals, and competitive benchmarks your competitors can't access".
- "Ratings, reviews & account health" (marketplace operations) and "Feedback loops into CRM".
- Nothing about assortment, product selection or new product development.

Warehouse evidence (table names, descriptions, labels, row counts):

| Area | Table | What it is |
|---|---|---|
| Replenishment (live) | fact_gcc.channel_replen_by_sku, channel_replen_run | Per SKU and location: rate of sale (`*_ros`), days of cover (`*_doc`), target DOC, shortfall, required units, stock moves between 10 lanes. 118 runs, scheduled 4 times a day |
| Replenishment (older) | fact_gcc.replenishment_plan (21,194 rows), replenishment_demand_daily (35,046), channel_replenishment (87,750) | Reorder point, safety stock, suggested qty, lead time, landed cost, supplier, brand_manager. Last modified 2026-09-03 / 09-23, so superseded by v2 |
| Lead time | brand_intelligence.brand_inbound_lead_time_sku / _stats | PO approval to GRN lead days per brand and SKU |
| Targets | brand_intelligence.aop_monthly_target; internal_brand_dashboard.aop_* | Annual operating plan (AOP) revenue targets per brand, month, channel. Labels `ibd_owned=true` (Internal Brand Dashboard) |
| Ageing | brand_intelligence.inventory_ageing | Stock age buckets and value |
| Sales history | fact_gcc.unified_sales_tertiary_v2 (402,386 rows) | Units and USD per day, channel, SKU since 2024-10-29; 23 brands, 14 channels, 12,569 SKUs |
| Listings | opptra_core.listing_observation (1,142,054 rows) | Scout: price, deal price, rating, review_count, best-seller rank, colours in and out of stock. GCC platforms Namshi, Noon, Amazon.ae/.sa since 2026-08. Own brands only |

Monthly GCC revenue grew from about USD 0.2M (2025) to USD 1.1M to 1.6M (2026-03 to 2026-09), so
any model trained on the history sees a growth curve, not a stable seasonal pattern. The replenishment
docs say the same thing: "The trailing 60-day window lags the season everywhere"
(gcc-dashboard docs/channel-replenishment/investigations/2026-10-05_replen_observations/02_proposal_exposure_window.md).

Not found: any table or dataset named or described as forecast, prediction, assortment, selection, NPD,
competitor or review text.

## 2. Who owns demand planning and NPD today

- Demand planning: Channel Replenishment v2 in C:\Users\Sujan Ajay\Desktop\gcc-dashboard (GitHub
  opptra/gcc-dashboard). Spec "Channel_Replenishment_v2_Requirements v1.3" with changes agreed with
  Ashish and Mahesh (backend/queries/channel_replen_how_to_read.md). Commits by Sujan, Sujan Ajay,
  Vijay PK, Rama Bhat. This is the natural home for any forecast that feeds stock decisions.
- AOP targets: Internal Brand Dashboard (`internal_brand_dashboard` dataset, labels `ibd_owned`,
  `ibd_owner=pipeline_job`) and Brand View (`brand_intelligence`, "facts, filters, AOP, Action Center").
- NPD: no owner found. No dataset, label, repo or table. Nitin Kiran raised it in the meeting; the
  catalog module, catalog-service and opptra-scrapers have no NPD code.
- Competitor data: opptra-scrapers (Scout) is the only scraper. MASTER_PLAN.md lists "P3 Reviews / VOC:
  full review corpus (session-gated)" and "Do not start ... reviews UI ... until Phase 1 exit criteria
  met"; high_level_product_plan.md says the reviews path is "currently parked". `engine/contracts.py`
  already names a `reviews` and a `search` entity. Adapters exist for Amazon (IN, AE, SA), Flipkart,
  Myntra, Namshi, Noon and quick-commerce; none for brand websites.

## 3. What a separate product needs from the catalog module

Identity and attributes only, read-only (the B6 attributes backbone, once built):

- Opptra SKU, EAN, option id (style-colour), brand, canonical category and subcategory (DD0), channel
  ids per channel (master_sl columns, DD1).
- Typed attributes from B6: material, fit, length, pattern, sleeve, use case, price band.
- Optionally the B7a per-product review themes, through the shared ingestion layer (section 4).

What it must NOT pull in: generation, matting, render, compliance, QA judge, publish, links sheet, the
locks and claims model, or the catalog database as a write target. The contract is a read-only export
(a BigQuery view or table of identity plus attributes), so the separate product never calls catalog
services and the catalog module never depends on forecasts. Model ids and per-brand model choices stay
inside the catalog module and are not exported.

## 4. The competitor benchmarking ask (B7b)

Data needed for "Cardio Bunny vs BlissClub and Lululemon":

| Data | Cardio Bunny | BlissClub | Lululemon |
|---|---|---|---|
| Ratings and review counts | Scout has 54 Namshi.ae and 37 Namshi.sa listings, rating empty today | Not in Scout | Not in Scout |
| Review text | None anywhere | None | None |
| Prices and discounts | Scout (Namshi), sales table | Not in Scout | Not in Scout |
| Attributes for like-for-like (fabric, fit, inseam, compression) | B6 (future) | Must be scraped | Must be scraped |

Where they likely sell (to confirm before any build): BlissClub mainly India (own site, Myntra,
Amazon.in), so Scout's Myntra and Amazon India adapters could reach it if listing ids are added;
Lululemon in GCC through its own regional site and stores, which needs a brand-site adapter Scout does
not have.

The line:

- Shared ingestion layer (owned by B7a / DD7): fetch reviews and ratings for a list of listing ids,
  store raw text with platform, listing id, date, rating, and run one theme tagger. Built once, fed by
  Scout's `reviews` entity or a bought scraper.
- Catalog side (B7a, inside the product): themes for Opptra's own products only, used to fix content
  (images, callouts, attributes).
- NPD side (B7b, outside): competitor listing ids, cross-brand comparison, gap analysis ("what
  customers praise in Lululemon leggings that Cardio Bunny lacks"), reports for merchandising.
  The catalog module never stores competitor reviews and never shows NPD output.

## 5. Ownership options

| Option | Fit | Cost | Trade-off |
|---|---|---|---|
| A. Catalog team builds B8 and B7b | Poor. No overlap with images or listings beyond identity | Highest: new data science and merchandising scope in the catalog team | Breaks the owner's boundary rule; risk to the core product |
| B. Another Opptra team: B8 to gcc-dashboard (Channel Replenishment), B7b to Scout plus a small report | Good. Replenishment already has sales, stock, lead time, ROS and DOC; Scout already has GCC listings and a reserved reviews entity | Low marginal: reuses running jobs and tables | B7b needs a named business owner (Nitin's NPD team); Scout reviews entity is parked and session-gated |
| C. A new separate product for forecasting and selection | Good fit later, when history is longer and NPD becomes a repeated process | Medium to high: new service, new owner | Duplicates replenishment inputs; premature with under 12 months of history for most brands |
| D. Buy a tool | Partial | See below | Most tools assume a single web store (Shopify) or a big enterprise budget |

Ready-made tools (public prices where cheap to find; indicative, from vendor or comparison pages):

- Review scraping: Apify Amazon review actors from USD 1.50 to 7.50 per 1,000 reviews (Good APIs
  USD 1.50, Junglee USD 3.00). Cheapest way to test the NPD ask on Amazon listings; does not cover brand
  sites or Namshi.
- Review analytics: Wonderflow, DataWeave, Revuze publish no prices (custom quotes; one Capterra listing
  shows USD 30,000 without a period). Enterprise fit, not a fit for one brand comparison.
- Demand forecasting: Prediko about USD 49 a month entry, Inventory Planner (Sage) from about USD 120,
  Cogsy from USD 199, Netstock custom. All are built around a Shopify or ERP store, not 9 marketplaces with
  cross-warehouse lanes, so they fit Opptra poorly compared with extending Channel Replenishment.

Sources: [Apify Good APIs](https://apify.com/good-apis/amazon-reviews/api),
[Apify Junglee](https://apify.com/junglee/amazon-reviews-scraper),
[Wonderflow on G2](https://www.g2.com/products/wonderflow-wonderflow/pricing),
[DataWeave on SaaSworthy](https://www.saasworthy.com/product/dataweave/pricing),
[Prediko on Shopify](https://apps.shopify.com/prediko),
[Prediko comparison](https://www.prediko.io/blog/demand-forecasting-software),
[Opptra](https://www.opptra.com).

## 6. Recommendation

- B8 forecasting and product selection: OUT of this team. Home is Channel Replenishment in
  gcc-dashboard (business owners Ashish and Mahesh). The first useful step there is a seasonal uplift on
  the existing rate of sale (Ramadan, White Friday, back to school), using the brands with two cycles
  of history, not a new forecasting product.
- B7b NPD insight: OUT of this team. A small separate product owned by the NPD requester (Nitin Kiran's
  team), reading competitor reviews from the shared ingestion layer that B7a builds. To answer the
  Cardio Bunny question before that layer exists, a one-off bought scrape (Apify, Amazon listings) is
  the cheapest test.
- Catalog module's only obligations: publish the read-only identity plus attributes export (B6) and
  make the B7a review ingestion layer reusable by listing id, not tied to Opptra's own products.

## Depends on earlier DD answers

- DD0 (taxonomy): canonical category and subcategory are the join key for like-for-like competitor
  comparison and for any forecast by category.
- DD1 / DD1a (channels): channel ids per product are what Scout and any review scraper are fed.
- DD8 (brand style profile): brand identity record; its brand list is the brand list exported.
- DD9 (business impact): revenue base and the short-history caveat reused here.
- DD7 (review ingestion, in parallel): owns the shared ingestion layer named in section 4; this memo
  assumes it stores reviews by platform and listing id so competitor listings can be added without
  catalog changes.

## Approval question for the owner

Do you approve that B8 (forecasting and product selection) and B7b (NPD competitor insight) are OUT of
the catalog team, with B8 going to Channel Replenishment in gcc-dashboard (Ashish and Mahesh as business
owners) and B7b to a separate product owned by Nitin Kiran's team, while the catalog team only provides
a read-only identity plus attributes export (B6) and a review ingestion layer (B7a / DD7) that accepts
competitor listing ids? If B7b needs a quick answer for Cardio Bunny first, do you approve a one-off
bought review scrape outside the catalog module (small, capped, your yes per spend)?

Status: written 2026-10-22, awaiting owner answer. Nothing implemented, no spend.
