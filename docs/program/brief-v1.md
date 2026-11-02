**Catalog OS - one-page brief (2026-11-02).** Detail: `module-map.md`.

## Problem

Opptra sells 4,075 GCC fashion options on nine marketplaces; the catalog is built by hand and never measured. 71% of live, stocked options sold nothing in 90 days. 98% of audited apparel lacks the five-shot set Styli and Centrepoint require; 97% of products have no usable description. Nothing records what content was live where, so no change can be tied to sales. The image tool needs babysitting (308 products to review in one batch) and under-reports cost about 60x.

## Why this decision

A study of about 70 competitors found image generation cheap and crowded (cents per image; Amazon and Google give it away). Nobody links content to sales on marketplaces without built-in testing, pushes to Noon or Namshi, writes native Arabic, or learns from rejections. So we buy generation and build the content-to-sales loop, GCC and India channel rules, our own quality checks, Arabic content, and consistency across brands. Our edge: multi-brand sales, ads, price and stock data.

## Tech approach

One foundation, a catalog graph storing every content version and when it went live; thirteen modules each ship alone on it. Our GPUs keep doing cleanup, 5-25x cheaper than vendors; generation, vision and text models are bought, each with a backup vendor. Outcomes come from BigQuery and public pages; no Amazon seller API.

First slice, one week: an operator uploads an apparel batch and walks away. Crops fill each channel's shot set, every product gets links, one summary replaces per-product cards, and batches survive deploys. A holdout starts that week: half of about 1,400 Namshi and Noon options get new images, half do not. It can detect a lift of about 18% at 12 weeks; we expect 1-5%, so the likely answer is "below X%", which still redirects spend to text.

## Product vision

A brand uploads once and walks away. Catalog OS builds every channel's listing (images, English and Arabic text, attributes, later video), publishes it, and learns per channel and category what sells. North star: organic conversion; also cost per SKU and time to live. India Cortina follows on the same core, then self-serve for other brands.

**Decisions for you** (default in brackets)

1. Background grey to 240+, white for Amazon image 1? [Yes, now.]
2. Start the holdout 10-17 Nov, before White Friday? [Yes.]
3. Grant Supabase, read-only `ila-pg` and billing export access? [Yes.]
4. Accept draft title lengths and HSN format check? [Yes.]
5. Crops only on Namshi and Noon until their AI-image stance is known? [Yes.]
6. Demo Streamoid and Rubick before building text and listing files? [Yes, within two weeks.]
7. Scrape own listings now, buy market data later? [Yes.]
