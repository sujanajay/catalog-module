# Marketplace rules research, 2026-10-28

Source notes for specs 18 (infographic images), 19 (product facts and channel vocabulary) and 20 (listing
template files). Collected on 2026-10-28 by a research agent from public pages; every claim is tagged [DOC]
(published by the marketplace), [3P] (seller blogs or integrators), [UNVERIFIED] or [NOT FOUND]. Cited in the
specs as "research 2026-10-28, section n". Nothing here is an owner decision; channel managers confirm the gaps
(gates G9 to G11).

All sources seen 2026-10-28 unless stated. Labels:
- **[DOC]** documented by the marketplace (or its official developer docs)
- **[3P]** reported by integrators, sellers, blogs or press (not the marketplace itself)
- **[NOT FOUND]** searched, nothing public found
- **[UNVERIFIED]** claim exists but could not be confirmed from the primary source

Note on location: the brief asked for the scratchpad path, but this session is in plan mode and only this plan file is writable. The content is the full report.

Caveat on Amazon: Seller Central help pages (G1881 image requirements, G200498950 clothing image guidelines) render via JavaScript and returned only navigation when fetched. Their content below comes from Amazon's own style-guide PDF (via search summary), Amazon developer docs, an Amazon forum notice, and secondary sources. Anyone with a Seller Central login (Opptra Amazon channel manager) should confirm wording.

---

## 1. Infographic, lifestyle and AI-image rules

### Amazon.ae / Amazon.sa
- Main image: pure white background (RGB 255,255,255); no text, logos, borders, colour blocks, watermarks, inset images or other graphics; single product, no multiple views. [DOC] Amazon Fashion Clothing Image Style Guide PDF (dated March 2022 per search summary; PDF itself could not be text-extracted here) https://m.media-amazon.com/images/G/65/SG3P/LISTING_GUIDES/Amazon_Fashion_Clothing_Image_Style_Guide.pdf . Same rules summarised in [3P] eComEngine (updated 2025-02-27) https://www.ecomengine.com/blog/amazon-image-requirements
- Additional ("other view") images: "Props, backgrounds, text, graphics, logos, and close-ups are all permitted"; lifestyle = "photographs that show the product in action"; infographics "combine text and images to give more information about the product". [3P] eComEngine (above). Feedvisor reports Amazon's standards permit "text or demonstrative graphics" in other-view images, but not offensive content. [3P] https://feedvisor.com/university/product-images
- Apparel specifics: adult men's/women's clothing on a human model (not mannequin); kids/baby clothing and multipacks photographed flat, off model; accessories show no mannequin parts. [3P] eComEngine; Amazon help page G200498950 points to the full style guide [DOC, not readable here] https://sellercentral.amazon.com/gp/help/external/G200498950
- Counts: up to 9 images depending on category, first 7 shown on the live listing. [3P] eComEngine. Exact count for AE/SA [UNVERIFIED].
- Text-coverage limits (e.g. "max X% of image"): [NOT FOUND] in any Amazon source.
- Banned words/claims in images: [3P only] consultant blogs list "eco-friendly", "biodegradable", "best seller", "top-rated", "antibacterial/antimicrobial" (pesticide-claim trigger, e.g. socks/shoes) as restricted, some saying the rule covers images too. https://sellersonar.com/blog/amazon-restricted-keywords-list/ , https://sellercentral.amazon.com/forums/t/reminder-action-required-for-listings-on-amazon-classified-as-pesticides/753908 (US forum). The pesticide rule is US EPA-driven; applicability to AE/SA [UNVERIFIED]. Amazon logos/badges ("Amazon's Choice", "Best Seller") not allowed in images [3P] https://myamazonguy.com/amazon-listing-images-guidelines/
- AI-generated images:
  - [DOC] Amazon seller forum notice by News_Amazon (posted ~3 months before 2026-10-28, i.e. ~late July 2026): "You must now tag product images that contain photorealistic AI-generated people with specific metadata"; use an IPTC-compatible editor to add keyword "contains-synthetic-performer"; "This requirement only applies if your image or video contains photorealistic AI-generated people." https://sellercentral.amazon.com/seller-forums/discussions/t/aa0aee06-aff4-497a-a4b6-9b2ebe06f715
  - [3P] Let's Data Science (2026-08-05): applies to "worldwide stores", covers images, video and A+; keyword goes in XMP dc:subject; excludes real people retouched with AI, no-people images and AI backgrounds without synthetic people; Amazon may show a customer-facing indicator. Linked to New York synthetic-performer law (effective June 2026). https://letsdatascience.com/news/amazon-requires-metadata-labels-for-ai-people-fa31a5e1 ; eWeek (blocked 403) https://www.eweek.com/news/amazon-ai-generated-product-images-labels-new-york-law/
  - Implication for Opptra: AI-generated models on a real garment (virtual try-on) = photorealistic synthetic person -> tag required on Amazon.ae/.sa if the "worldwide" scope is right. AI background on a real packshot without a person -> no tag per the notice wording.
  - Vendor blogs (Rewarx etc.) claiming an "August 2026 ban on AI faces", "Visual ID Standard 3.0" or per-image generation dropdown: [UNVERIFIED], conflicting, treat as noise.

### Noon (UAE/KSA)
All [DOC] from noon partners help: "Image Requirements and Rejection Reasons for the Seller SKU" https://supportagent.noon.partners/portal/en/kb/articles/image-requirements-and-rejection-reasons-for-the-seller-sku-12-3-2024 (also https://help.noon.partners/hc/en-us/articles/4409014578583 , timed out)
- "Pure white background for all categories except for the fashion; where the recommended background is light grey."
- "Lifestyle images are not permitted for the primary images" (so allowed in secondary slots by implication).
- Adult apparel: "recommended to have pictures shot on models"; kids apparel: "flat lay shots or products shot on hangers".
- "Only photographs are permitted, CAD drawings, thumbnails, or illustrations are not allowed." This is the key risk for fully generated infographic panels or illustrated callouts, and arguably for fully AI-generated images. Noon does not define whether an AI-generated photoreal image counts as a "photograph" [NOT FOUND].
- Text: "If you're adding text to the images, make sure the language is not offensive or in any way inappropriate." and "No logos, watermarks, unwanted text or objects are allowed." and "Images should not contain watermarks, seller names, or seller logos." So text is tolerated but "unwanted text" is a rejection reason; no coverage limit stated [NOT FOUND].
- Other: no borders; no manufacturing/expiry date; no packaging/swing tags in primary; no duplicates; JPEG only; width >= 660 px, aspect ratio >= 0.5, >= 72 PPI, <= 10 MB, sRGB; minimum 3 images recommended.
- Infographic slot rules, banned claims list, AI disclosure: [NOT FOUND].

### Namshi (owned by noon since Feb 2023)
- Ownership and portal: [3P] Gulf News https://gulfnews.com/business/retail/online-marketplace-noon-completes-buy-of-fashion-portal-namshi-1.93819176 ; Omniful integration doc (dated 2026-01-13) shows Namshi Partner Portal runs on noon partners projects (PRJ ids, noon API user roles) https://www.omniful.ai/docs/integration/namshi-integration-document
- Image rules, infographic or AI rules: [NOT FOUND] publicly. Streamoid guide says high-res product + model images, unique images per colour; rejections for missing model images [3P] https://streamoid.com/resources/guides/namshi-seller-guide . Likely aligned with noon rules but [UNVERIFIED].
- Who holds it: Opptra Namshi channel/vendor manager (Namshi Partner Portal login).

### Trendyol (GCC)
- [DOC] Product create v2: images must be https URLs, "A maximum of 8 images can be added to one barcode", "1200x1800 pixels and 96dpi". https://developers.trendyol.com/v3.0/docs/product-create-v2
- Text/watermark rules: [3P] Turkish seller guides say watermarks, text and others' images can cause rejection https://birfatura.com/trendyol-urun-yukleme-nasil-yapilir-sartlari/ ; 3-6 images, first is cover https://pixpretty.tenorshare.ai/tr/pazarlama/trendyol-fotograf-yukleme.html . Official image policy page [NOT FOUND].
- Infographics, lifestyle slot rules, AI disclosure: [NOT FOUND].

### SHEIN
- [3P] ChannelEngine: main image ratio 1:1, 3:4, 4:5 or 13:16, "900x2200 px" https://support.channelengine.com/hc/en-us/articles/21552893542941 ; API image types main=1, other=2 https://help.useresponse.com/hemi/knowledge-base/article/marketplaces-shein-shein-product-management-shein-create-products_1
- Text/infographic/AI rules: [NOT FOUND] officially. A vendor blog on a SHEIN "30% rule" for AI-model images exists, details [UNVERIFIED] https://www.rewarx.com/blogs/2026-shein-marketplace-seller-main-image-compliance-ai-model-30-rule

### VogaCloset
- [3P] Tradebyte channel sheet: min 4 images, 800x1200 px, png/jpg, no DPI requirement; cites EU AI Act Art. 50 and says correctly marked EXIF/XMP AI metadata is preserved. No text-on-image rules. https://help.tradebyte.com/doc_cs_vogacloset.html
- Official VogaCloset rules: [NOT FOUND].

### Styli, Centrepoint, 6th Street
- Styli: [DOC-ish, marketing] seller.stylishop.com describes a managed model: account manager, stock to local hub, "Styli lists, optimizes, and syncs your catalog". No image/text rules published. https://seller.stylishop.com/getting-started -> image rules [NOT FOUND].
- Centrepoint (Landmark Group): no seller programme docs; Landmark says its websites carry own and third-party products (Gulf Business, 2024) https://gulfbusiness.com/how-landmark-is-pioneering-retail-growth-in-gcc/ -> [NOT FOUND]; vendor-managed.
- 6th Street (Apparel Group): [NOT FOUND] any seller/brand content guide.
- Who holds it: the Opptra channel manager / key account manager for each (the retailer's buying or e-com content team sends the image spec and line sheet).

---

## 2. Listing templates and APIs

| Marketplace | Template | Category-specific? | Programmatic? | Image columns |
|---|---|---|---|---|
| Amazon.ae/.sa | Seller Central spreadsheet (flat file) per product type, with Valid Values tab [3P] https://support.storeautomator.com/hc/en-us/articles/4411195600146-Flat-File-Templates-for-Amazon | Yes, per product type | Yes: SP-API Product Type Definitions returns JSON Schema per product type and marketplace [DOC] https://developer-docs.amazon/sp-api/docs/product-type-definitions-api ; Listings Items API put/patch one item at a time; JSON_LISTINGS_FEED via Feeds API is the bulk equivalent [DOC] https://developer-docs.amazon/sp-api/docs/listings-items-api . AE = A2VIGQ35RCS4UG, SA = A17E79C6D8DWNP, both EU region [DOC] https://developer-docs.amazon/sp-api/docs/marketplace-ids | main_product_image_locator, other_product_image_locator_1..8 (attribute names per PTD schema; not named on the Listings page, [UNVERIFIED] here) |
| Noon | NIS sheet (CSV/TSV/XLS), EN or EN+AR, with instruction tab; red = mandatory, green = discovery, grey = n/a; up to 10,000 SKUs per sheet; variants only on Size axis [DOC] https://supportagent.noon.partners/portal/en/kb/articles/seller-sku-bulk-creation | Yes, generated after choosing category, product type, subtype | Template download is portal-only (Catalog > My Catalog > Add Products > Create Multiple Products) [DOC]. noon API Platform exists for "catalogs, orders, fulfillment, and event notifications" [DOC, page timed out; summary via search] https://support.noon.partners/portal/en/kb/articles/noon-api-platform ; content-creation endpoints [UNVERIFIED] | Image URLs on parent row; direct links ending .JPEG or Google Drive links, comma-separated [DOC] |
| Namshi | Excel catalog upload in Namshi Partner Portal [3P] Omniful, Streamoid | [UNVERIFIED] | Runs on noon partners infrastructure (projects, API users); product creation via API not documented [3P] Omniful | [NOT FOUND] |
| Trendyol (GCC) | Seller panel Excel exists [UNVERIFIED]; public REST API is the documented path | Yes: attributes per lowest-level category | Yes [DOC]: getBrands, getCategoryTree, getCategoryAttributes, getCategoryAttributeValues, createProducts v2 (max 1,000 items/request), update unapproved/approved content, getBatchRequestResult; storeFrontCode header required (storefronts mentioned: SA, AE, KW, RO, GR) https://developers.trendyol.com/ , https://developers.trendyol.com/v3.0/docs/product-create-v2 | images[] of https URLs, max 8 per barcode |
| SHEIN | Seller Hub | [UNVERIFIED] | Open Platform API requires approved account + seller authorisation [3P] https://apis.io/providers/shein/ ; flow: POST /open-api/goods/transform-pic then /open-api/goods/product/publishOrEdit [3P] useresponse | image_type 1 main, 2 other [3P] |
| VogaCloset | No seller template; via integrators (ChannelEngine Channel API, Tradebyte) [3P] https://support.channelengine.com/hc/en-us/articles/26031217406749 | Categories managed by channel [3P] Tradebyte | Integrator only; VogaCloset "verifies and enriches" products [3P] | Article images [3P] |
| Styli | Managed by Styli account team [DOC marketing] | [NOT FOUND] | [NOT FOUND] | [NOT FOUND] |
| Centrepoint | [NOT FOUND] - vendor/concession line sheet | | | |
| 6th Street | [NOT FOUND] - vendor/concession line sheet | | | |

---

## 3. Attribute vocabularies (apparel and footwear)

- **Amazon**: controlled values exist and are public to authorised SP-API apps: getDefinitionsProductType (e.g. productTypes/SHIRT, SHOES) with marketplaceIds returns a JSON Schema with enums; links valid 7 days; seller-specific config only if sellerId is passed [DOC] https://developer-docs.amazon.com/sp-api/lang-US/docs/retrieve-a-product-type-definition . Size attribute names vary by product type (e.g. "Shirt Size" for SHIRT) [DOC] https://developer-docs.amazon.com/sp-api/docs/listings-items-guidance-for-complex-attributes . Values are case-sensitive and must match exactly [3P]. Actual enum lists for sleeve_type / neck_style / closure on AE/SA: [NOT FOUND] publicly, need a live PTD call (Opptra has the Seller Central account; worth one read-only call per product type).
- **Noon**: per-category NIS template shows mandatory (red) and discovery (green) fields; "Noon size" dropdown [DOC]. Published value lists for sleeve length, neckline, fit, heel type, closure: [NOT FOUND] outside the downloaded template. Holder: Opptra noon channel manager (download "With Instructions" template for each fashion family).
- **Trendyol**: fully public and programmatic [DOC]. getCategoryAttributes returns per attribute `required`, `allowCustom` (free text allowed), `varianter`, `slicer`, `allowMultipleAttributeValues`; getCategoryAttributeValues returns id/name lists; Trendyol recommends refreshing weekly. https://developers.trendyol.com/v2.0/docs/category-attribute-list-v2 , https://developers.trendyol.com/v3.0/docs/7-trendyol-category-attribute-list
- **VogaCloset**: variants by size and colour; EAN-13, weight, country of origin required; product description mandatory; no value mapping, categories from channel [3P] Tradebyte.
- **Namshi, Styli, Centrepoint, 6th Street, SHEIN**: [NOT FOUND] public vocabularies. Streamoid reports Namshi rejections for "missing fashion attributes, incomplete material details" [3P].
- **Vocabulary differences (half sleeve vs short sleeve)**: no marketplace document found that lists both side by side [NOT FOUND]. Observation only: Centrepoint uses "Notch Neck" in a live product title https://www.centrepointstores.com/ae/en/buy-styli-women-green-notch-neck-buttoned-sleep-tshirt/p/7027464613Green . Recommendation: keep one internal canonical vocabulary (e.g. sleeve_length = short / half / three-quarter / long / sleeveless) and a per-channel mapping table filled from Amazon PTD enums, Trendyol attribute values and noon NIS dropdowns. Do not assume "half sleeve" maps to "short sleeve" until seen in the channel lists.

---

## 4. Definitions and generation approaches

**Main vs lifestyle vs infographic.** Amazon: the main image is the product alone on pure white with no text or graphics; additional images may carry props, backgrounds, text and graphics; lifestyle images are "photographs that show the product in action" and infographics "combine text and images to give more information about the product" (Amazon rules [DOC] style guide; definitions phrased by eComEngine [3P]). Noon: the primary image must be a clean photograph (light grey recommended for fashion), lifestyle is banned only from the primary slot, and all images must be photographs (no illustrations or CAD); noon publishes no "infographic" term [NOT FOUND], and text is allowed only if not inappropriate and not "unwanted".

**Generation approaches.** (a) Templated overlay: render callouts with HTML/Canvas (or SVG) on top of the real packshot, with copy pulled from verified attributes. Text is exact and bilingual (Arabic RTL) control is deterministic; risk is mainly layout/legibility. (b) Fully generated by an image model (GPT Image, Gemini 3 Pro Image / Nano Banana family, Ideogram). OpenAI's own docs state GPT Image "can still struggle with precise text placement and clarity" and "may have difficulty placing elements precisely in structured or layout-sensitive compositions" [DOC] https://developers.openai.com/api/docs/guides/image-generation ; Google markets Gemini as "capable of generating legible, stylized text for infographics" [DOC] https://ai.google.dev/gemini-api/docs/image-generation , but independent 2026 tests still report typographic errors in dense or long text, with accuracy claims like ~95% for strings under 10 words being unverified vendor numbers [3P] https://www.atlascloud.ai/blog/guides/2026-ai-image-api-benchmark-gpt-image-2-vs-nano-banana-2-pro-vs-seedream-5-0 , https://www.imagine.art/blogs/ideogram-4-0-vs-nano-banana-pro-vs-gpt-image-2 . Known failure modes: misspellings and garbled letters, invented or wrong facts (claims not in the attribute data, wrong fabric %), altered product details (logo, stitching, colour drift), weak Arabic rendering [Arabic-specific benchmarks NOT FOUND], and noon's "only photographs" rule. A hybrid (model for the background/scene, deterministic overlay for all text) avoids most text failures.

---

## Who to ask inside Opptra
- Amazon AE/SA channel manager: Seller Central image page G1881 for AE, clothing style guide, flat files; permission for read-only SP-API PTD calls.
- noon channel manager: NIS templates per fashion family ("With Instructions"), API Platform access.
- Namshi, Styli, Centrepoint, 6th Street, VogaCloset, SHEIN channel/vendor managers: current image spec, line-sheet/template, attribute value lists, stance on text overlays and AI images.
