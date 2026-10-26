# 02 - Market scan: demand, assortment and NPD intelligence tools

Date: 2026-10-26. All web sources were accessed on 2026-10-26 unless another date is given. Where a source has its own publication or capture date, it is shown next to the claim.

Purpose: give the proposal a sourced view of what exists, what it costs and how well it fits Opptra, so we can make a build-vs-buy call for the three modules:

1. Demand forecasting with seasonality and events (Ramadan, Eid, White Friday)
2. Assortment and buy planning (size curves, ageing, markdown risk)
3. NPD and competitor insight (competitor reviews, prices, ranks, attribute gaps)

How to read the labels:
- **Vendor-claimed**: a number the vendor publishes about itself. It has not been checked independently.
- **Third-party estimate**: a price from a review or comparison site, not from the vendor.
- **Unverified**: we could not find a primary source. Treat it as a lead, not a fact.
- **Fit**: our judgement for Opptra (about 23 brands, about 9 marketplaces, about 6 stock locations including Noon FBN, USD 9-15M sales, under 12 months of history for most brands). It is an opinion, not a sourced fact.

---

## 1. Summary table

| Vendor | Category | Public price or best indication | Fit for Opptra | One-line reason |
|---|---|---|---|---|
| RELEX | Enterprise planning | Quote only. Third-party estimates conflict (from USD 50/user/month to USD 3,000/year entry) | Poor | Enterprise grocery-first suite with GCC grocery clients, oversized for USD 9-15M |
| Blue Yonder | Enterprise planning | Quote only. Third-party estimate: around USD 100K/year per module | Poor | Enterprise cost and 12-24 month programmes |
| o9 Solutions | Enterprise planning | Quote only. Third-party: "six figures a year" | Poor | Enterprise platform, no GCC customer found |
| Toolio | Mid-market merchandise planning | Quote only, sold by module | Partial | Good planning and open-to-buy model, but no Noon/Namshi/Amazon connectors listed |
| Nextail | Fashion allocation and replenishment | Capterra: from EUR 60,000 | Poor to partial | Built for store networks, 12-16 week implementation |
| Increff | Fashion merchandising (India-built) | Quote only | Partial to good | Has a GCC fashion case study (2026) and GCC history, marketplace connectors unconfirmed |
| Onebeat | Store inventory AI | AWS Marketplace: USD 8,000 / 15,000 / 50,000 per month | Poor | Built for physical stores, high monthly fee |
| Syrup Tech (now Anaplan) | AI forecasting for fashion | Quote only | Poor | Acquired by Anaplan in Sept 2025, enterprise route |
| Inventory Planner (Sage) | SMB replenishment | Third-party: Essentials about USD 120/month, higher tiers quoted | Partial | Amazon, Shopify and multi-warehouse support, but no Noon/Namshi connectors |
| Prediko | Shopify replenishment | Official: from USD 49/month (under USD 100K revenue band). Our band not shown | Poor | Shopify-centric, marketplaces must be routed through Shopify |
| Cogsy | Shopify DTC planning | Discontinued | Not available | Vendor page says it is no longer available |
| Netstock | ERP-linked replenishment | Official: from USD 900/month | Partial (hardline only) | Needs a supported ERP, not built for fashion size curves |
| Lokad | Bespoke probabilistic optimisation | Quote only | Partial | Strong maths, but it is a consulting-style engagement |
| EDITED | Competitor assortment and pricing intelligence | Quote, contract-based | Partial | Strong on UK/US retail, GCC coverage not confirmed |
| Trendalytics | Trend intelligence (social, search) | Third-party: around USD 1,000-2,000/month (unverified) | Poor to partial | US-centric |
| Heuritech | Image-based trend forecasting | Quote only (Essential, Business, Enterprise) | Partial | Geozone add-ons listed do not include the Middle East |
| WGSN | Trend forecasting content | No current public price found | Partial | Macro trend content, not SKU-level data |
| Stylumia | Apparel demand sensing (India-built) | Quote only | Partial to good | India-built, UAE presence reported (2019), apparel focus |
| DataWeave | Digital shelf and price intelligence (India-built) | Quote only | Partial | Deep in India/APAC, GCC coverage unconfirmed |
| Revuze | Review analytics | PricingSaaS (captured 16 Jul 2026): USD 1,000 / 2,200 / 4,100 per month | Partial | Good review NLP, Noon/Namshi and Arabic coverage unconfirmed |
| Yogi | Review analytics | Quote only | Poor to partial | Focused on US retailers (Amazon, Walmart, Target) |
| Lily AI | Product attribute tagging and retail media | Quote only (Starter, Growth, Enterprise) | Poor | Solves catalogue tagging, not competitor insight |
| Helium 10 / Jungle Scout | Amazon research tools | Public plans (not captured here) | Partial | Amazon.ae supported; Amazon.sa limited |
| NoonSeller | Noon analytics | Official: Pro USD 39/month, Data API USD 199 per category per month | Good (narrow) | Cheap Noon UAE/KSA sales estimates and competitor tracking |
| NoonSpy | Noon analytics | Pricing not shown on homepage | Partial | Noon UAE/KSA research tool, unverified claims |
| Plott Data, Actowiz | Managed marketplace data | Quote only | Partial | Cover Noon (and Plott covers Namshi and Trendyol) as a managed feed |
| Apify actors | Scraping | Noon USD 0.80/1K, Namshi USD 1/1K, Amazon reviews USD 1.50-7.50/1K | Good (data layer) | Cheapest way to get GCC marketplace listings |
| Bright Data | Scraping API | USD 1.50/1K pay-as-you-go, USD 1.30/1K on USD 499/month plan | Good (data layer) | Has a ready Noon scraper |
| Oxylabs | Scraping API | Amazon USD 0.25-0.50/1K, other sites USD 0.75-1.50/1K | Good (data layer) | Cheapest per record at volume |

Bottom line in one paragraph: the planning suites that do size curves, open-to-buy and allocation well (RELEX, Blue Yonder, o9, Nextail, Onebeat, Syrup) are priced and designed for retailers with store networks and long histories. The cheap tools (Inventory Planner, Prediko, Netstock) assume Shopify, Amazon or an ERP as the single source of truth. No vendor we found publicly offers connectors for Noon, Namshi, 6thStreet, Styli, Centrepoint and Trendyol GCC together. Data collection (scraping) is cheap and commoditised. The Opptra-specific value sits in the joined-up data layer, the Hijri-calendar event model, cold-start forecasting with short history, and marketplace-level allocation.

---

## 2. What Opptra needs, and why it matters for fit

These facts come from the brief, not from external sources:

- **Short history.** Under 12 months for most brands. Most forecasting tools learn seasonality from at least one full year. Ramadan also moves about 10-11 days earlier each year because the Islamic calendar is lunar ([Gulf News](https://gulfnews.com/uae/ramadan/when-does-ramadan-2027-begin-everything-you-need-to-know-1.500630523); [Orphans in Need](https://orphansinneed.org.uk/news/why-does-ramadans-date-change-each-year)). So even one year of history does not show "Ramadan in the same weeks next year". Ramadan 1448 is expected to start on 8 Feb 2027 per the Umm al-Qura calendar ([Gulf News](https://gulfnews.com/uae/ramadan/when-does-ramadan-2027-begin-everything-you-need-to-know-1.500630523)).
- **Many sales channels, none of them a "store".** About 9 marketplaces plus brand sites. November sales are branded differently per marketplace: Amazon.ae "White Friday" (22-29 Nov in the 2025 listing) and noon "Yellow Friday", and the promotions run for about a week ([What's On](https://whatson.ae/?p=214814); [Gulf News](https://gulfnews.com/business/retail/retailers-ready-for-black-white-and-yellow-fridays-1.67987376)).
- **Stock in about 6 locations, including Noon FBN.** The planning question is "how much stock goes to which marketplace's warehouse", not "which store".
- **Two very different product types.** Softline (size curves, seasons, markdowns) and hardline (replenishment, lead times, fewer variants).
- **Budget.** At USD 9-15M sales, a USD 100K+ a year tool is about 1% of revenue before implementation.

---

## 3. Demand, merchandise and assortment planning

### RELEX Solutions
- **What it does:** AI supply chain and retail planning, founded 2005 in Helsinki ([Sharikat Mubasher, 17 Mar 2025](https://en.sharikatmubasher.com/media-hub/news/21474601/relex-forum-riyadh-showcases-ai-solutions-for-smarter-supply-chains?lang=en)). For fashion it partners with Sizeo for size and pack optimisation at style, colour, size and store level ([RELEX partner page](https://www.relexsolutions.com/partners/sizeo)).
- **Pricing:** Not published. Third-party estimates conflict: ITQlick says from USD 50 per user per month, with USD 16,500-74,400 for a 10-user first year including a USD 10,000-50,000 onboarding fee ([ITQlick](https://www.itqlick.com/relex-solutions/pricing)); GetApp shows a starting price of 3,000 per year ([GetApp](https://www.getapp.com/operations-management-software/a/relex)). Both are third-party estimates and should not be used for budgeting.
- **Deployment and data needs:** Enterprise SaaS, quoted by modules and data volume ([ERP Research](https://erpresearch.com/erp-add-ons/demand-planning/relex/pricing)). G2 shows 60% of reviews come from enterprise companies ([G2](https://www.g2.com/compare/manhattan-active-warehouse-management-vs-relex-solutions-relex)). Minimum history not published.
- **Multi-marketplace and multi-warehouse:** Strong on multi-location replenishment. No marketplace connectors for Noon or Namshi found.
- **GCC presence:** Held its first Middle East event in Riyadh on 24 Feb 2025. Named regional clients: Panda Retail, Getir, Binzagr and Majid Al Futtaim ([Sharikat Mubasher, 17 Mar 2025](https://en.sharikatmubasher.com/media-hub/news/21474601/relex-forum-riyadh-showcases-ai-solutions-for-smarter-supply-chains?lang=en)). MAF partnered with RELEX for Carrefour shelf inventory, starting in the UAE ([Hi Dubai, 2021](https://focus.hidubai.com/majid-al-futtaim-partners-with-relex-to-tailor-on-shelf-inventory-across-carrefour-stores/)).
- **Fit: Poor.** Real GCC presence, but its regional customers are grocery and large retail, and the cost and implementation weight do not suit a USD 9-15M operator.

### Blue Yonder
- **What it does:** Enterprise retail planning with merchandise financial planning, forecasting and allocation ([Blue Yonder](https://blueyonder.com/solutions/retail-planning)).
- **Pricing:** Quote only. Third-party estimate: standalone modules often start around USD 100,000 a year, with full programmes reaching mid-six figures or more. Implementation can match the licence in year one ([FarEye](https://fareye.com/resources/blogs/blue-yonder-pricing)). FarEye is a competitor, so treat this with caution.
- **Deployment and data needs:** Enterprise SaaS. Needs clean product, location and calendar master data ([Blue Yonder](https://blueyonder.com/solutions/retail-planning); [RFP.wiki](https://www.rfp.wiki/retail-ecommerce/retail-assortment-management-software/oracle-retail/blue-yonder)).
- **GCC presence:** Has a Dubai office, Blue Yonder Middle East FZ-LLC in Dubai Media City ([Blue Yonder locations](https://it.blueyonder.com/about/locations)). A Chalhoub Group merchandise planner job post asks for "hands-on expertise with planning tools, such as Blue Yonder, SAP, or similar" ([Chalhoub careers](https://careers.chalhoubgroup.com/jobs/8568819-associate-merchandise-planner), posting date not shown). This does not confirm a deployment.
- **Fit: Poor.** Cost and implementation length.

### o9 Solutions
- **What it does:** Enterprise integrated planning platform with retail softlines and apparel content ([o9 retail softlines](https://o9solutions.com/industries/retail-softlines/)).
- **Pricing:** Not published ([OMR](https://omr.com/en/reviews/product/o9-solutions/pricing)). ERP Research: "typically six figures a year", with implementation often more than the first-year subscription ([ERP Research](https://erpresearch.com/erp-add-ons/demand-planning/o9-solutions/pricing)). VendorBenchmark claims USD 600K-3.5M a year ([VendorBenchmark](https://vendorbenchmark.com/vendors/o9-solutions-pricing)), unverified.
- **GCC presence:** No GCC customer or office found in our searches. Unverified either way.
- **Fit: Poor.** Enterprise price and scope.

### Toolio
- **What it does:** AI merchandise planning, open-to-buy, assortment planning and allocation in one platform ([Toolio](https://toolio.com/)). Named customers include AKA Brands, Hunter Bell, Peloton, Bombas and Knix ([Toolio](https://toolio.com/)).
- **Pricing:** Not published, quote only ([Toolio pricing page](https://www.toolio.com/pricing)). A comparison site says buyers pay per module ([Fitgap](https://us.fitgap.com/products/toolio)).
- **Deployment and data needs:** SaaS. Named integrations: SAP, NetSuite, Snowflake, BigQuery ([Toolio](https://toolio.com/)). A Shopify integration exists and can be the source of truth if all commerce is on Shopify; otherwise an ERP feed is suggested. Product hierarchy usually has to be uploaded separately. A wholesale booking feed is optional ([Toolio help: Shopify integration](https://help.toolio.com/en/articles/4697543-shopify-integration)). Minimum history not published.
- **Multi-marketplace and multi-warehouse:** Supports multiple Shopify stores ([Toolio update, 2021](https://toolio.com/post/toolio-product-updates-april-26-2021)). No Amazon, Noon or Namshi connector listed.
- **GCC presence:** None found.
- **Fit: Partial.** The planning model (merchandise financial plan, open-to-buy, assortment) is the closest off-the-shelf match for Module 2 at mid-market scale. But Opptra would have to build a feed that combines all marketplace sales into one dataset first.

### Nextail
- **What it does:** AI allocation and replenishment for fashion. Customers include River Island, Pepe Jeans and Guess ([CB Insights](https://www.cbinsights.com/company/nextail/customers); [FashionUnited](https://fashionunited.com/companies/nextail-labs)).
- **Pricing:** Capterra lists a starting price of EUR 60,000, per user per year ([Capterra](https://www.capterra.com/p/170788/Nextail/)). Third-party listing.
- **Deployment and data needs:** Typical implementation is 12-16 weeks. Sales and stock files are refreshed overnight ([Nextail help: implementation](https://help.nextail.co/en/implementation-process); [Nextail help: data refresh](https://help.nextail.co/en/when-does-nextail-read-and-refresh-sales-and-stocks-data)). Minimum history not published.
- **GCC presence:** No GCC customer found.
- **Fit: Poor to partial.** Store-allocation logic does not map cleanly to marketplace warehouses, and the price is high for our size.

### Increff (India-built)
- **What it does:** Merchandising software for fashion: replenishment, inter-store transfers, seasonal planning and size optimisation, plus a demand planning module ([Increff GCC case study, 27 Mar 2026](https://www.increff.com/case-studies/how-increff-helped-a-middle-east-retail-group-boost-sales-by-16-8)).
- **Pricing:** Not published ([G2](https://www.g2.com/products/increff-merchandising-software/pricing)). Capterra shows "USD 1 per month", which looks like a placeholder ([Capterra](https://www.capterra.com/p/233454/Increff-Iris-X/)).
- **Deployment and data needs:** SaaS. History needs not published.
- **Multi-marketplace and multi-warehouse:** Increff also sells "Assure", a multichannel fulfilment platform ([Martechvibe, 7 Aug 2021](https://martechvibe.com/article/increff-partners-with-fashion-and-logistics-brands-namshi-and-aramex)). Noon or Amazon.ae connectors: not found, unverified.
- **GCC presence:** A Middle East fashion retail group across the UAE, Oman and Bahrain (a downloadable PDF is named "DHG") reported, vendor-claimed, +16.8% sales quantity, sell-through from 49.2% to 50.9% and AED 2.29M revenue uplift, 2024 vs 2025 ([Increff case study](https://www.increff.com/case-studies/how-increff-helped-a-middle-east-retail-group-boost-sales-by-16-8); [DHG PDF](https://www.increff.com/wp-content/uploads/2025/09/DHG-Case_Study.pdf)). In 2021 it signed Namshi and Aramex for Assure and said it already worked with Landmark Group ([Martechvibe, 7 Aug 2021](https://martechvibe.com/article/increff-partners-with-fashion-and-logistics-brands-namshi-and-aramex)).
- **Fit: Partial to good.** The strongest GCC fashion track record among the mid-market tools, and India-built pricing is likely lower. It needs a demo to confirm marketplace-warehouse logic and how it handles short history.

### Onebeat
- **What it does:** AI replenishment, allocation and liquidation at SKU-store level for physical retailers. Vendor-claimed: +15% sell-through, -71% stockouts, -33% inventory ([Just Style](https://www.just-style.com/news/onebeat-funding-inventory-management/)).
- **Pricing:** AWS Marketplace: Shirt USD 8,000/month, Suit USD 15,000/month (adds store transfers, advanced seasonality, initial allocation), Wardrobe USD 50,000/month. 12-month contracts save up to 38% ([AWS Marketplace](https://aws.amazon.com/marketplace/pp/prodview-ovaley47f36ry)).
- **Deployment:** SaaS. Listing title is "for Brick-and-Mortar Retailers" ([AWS Marketplace](https://aws.amazon.com/marketplace/pp/prodview-ovaley47f36ry)).
- **GCC presence:** Says it has a presence in the Middle East and Africa, no named clients ([Descubre](https://www.descubre.vc/onebeat)).
- **Fit: Poor.** Built for stores, and USD 96K+ a year at the lowest tier.

### Syrup Tech (now part of Anaplan)
- **What it does:** AI forecasting at style, colour, size and location level for fashion. Vendor-claimed: 20-30% lower inventory, 60-80% fewer avoidable stockouts ([Shoptalk Europe](https://shoptalkeurope.com/sponsors/syrup-tech)). Customers include Reformation, Desigual and Faherty ([CB Insights](https://www.cbinsights.com/company/syrup-tech/customers)).
- **Status:** Anaplan announced the acquisition on 9 Sept 2025 ([Anaplan](https://www.anaplan.com/news/anaplan-announces-acquisition-of-syrup-tech/)).
- **Pricing:** Not public.
- **Fit: Poor.** It is now part of an enterprise planning suite.

### Inventory Planner by Sage
- **What it does:** Forecasting, replenishment, open-to-buy, overstock alerts and warehouse transfer suggestions ([ERP Research](https://erpresearch.com/erp-add-ons/demand-planning/inventory-planner)). Includes size curve forecasting content ([Inventory Planner](https://www.inventory-planner.com/size-curve-forecasting/)). It became part of Sage when Sage bought Brightpearl, around January 2022 ([Inventory Planner help](https://help.inventory-planner.com/en/articles/6601207-understanding-the-relationship-between-inventory-planner-brightpearl-and-sage)).
- **Pricing:** The official page says pricing depends on inventory volume, with unlimited users ([Inventory Planner pricing](https://www.inventory-planner.com/pricing)). Third-party: Essentials about USD 119.99/month on Shopify (single warehouse); higher tiers estimated at USD 250-1,200+/month ([Eightx](https://eightx.co/blog/compare/how-much-does-inventory-planner-cost)). The Shopify listing says "contact us to get a quote" ([Shopify App Store](https://apps.shopify.com/inventory-planner)).
- **Data needs:** Connects to Shopify, Amazon, WooCommerce, eBay, BigCommerce, NetSuite, Cin7, Linnworks and others ([Inventory Planner pricing](https://www.inventory-planner.com/pricing)). Has a CSV connector ([Inventory Planner vs NetSuite](https://www.inventory-planner.com/info/netsuite-demand-planning-alternative)).
- **Multi-warehouse:** Supports Amazon FBA, 3PL and store locations ([ERP Research](https://erpresearch.com/erp-add-ons/demand-planning/inventory-planner)).
- **GCC presence:** None found.
- **Fit: Partial.** Low cost and workable for hardline replenishment. Noon, Namshi and other GCC channels would need CSV feeds built by Opptra, and it is not designed for event-heavy short-history forecasting.

### Prediko
- **What it does:** Shopify-based AI forecasting and purchase orders ([Prediko](https://prediko.io/)).
- **Pricing:** The official page shows USD 49/month for the under USD 100K revenue band, with bands up to USD 50M+ but no other prices shown ([Prediko pricing](https://prediko.io/pricing)). Other sources cite USD 119/month for an earlier USD 0-2M band ([SoftwareSuggest](https://www.softwaresuggest.com/prediko)).
- **Data needs:** Requires Shopify (Basic, Advanced or Plus); billing is through Shopify ([Prediko pricing](https://prediko.io/pricing)). Amazon is routed into Shopify via CED Commerce; a native Amazon integration is described as "soon to be launched" ([Prediko blog](https://www.prediko.io/blog/amazon-shopify-inventory-sync); [Prediko Amazon page](https://www.prediko.io/topics/amazon-inventory-management)).
- **Fit: Poor.** Shopify must be the hub. Opptra's sales mainly sit in marketplaces.

### Cogsy
- **Status:** Discontinued. The URL now points to a Mayple page saying Cogsy "is no longer available" ([Mayple](https://mayple.ai/cogsy)).
- **Fit: Not available.**

### Netstock
- **What it does:** Inventory planning and replenishment on top of an ERP.
- **Pricing:** Official: from USD 900/month on annual subscription ([Netstock pricing](https://www.netstock.com/pricing/)).
- **Data needs:** Integrates with 60+ ERPs including NetSuite, Sage, Acumatica, Microsoft Dynamics, SAP Business One, Unleashed and Cin7 Core ([Netstock pricing](https://www.netstock.com/pricing/)). History needs not published.
- **Fit: Partial, hardline only.** Useful if Opptra runs one of these ERPs. Not designed for fashion size curves or marketplace data.

### Lokad
- **What it does:** Probabilistic forecasting and decision optimisation, built in its own programming language ([Lokad](https://lokad.com); [SelectHub](https://www.selecthub.com/p/inventory-optimization-software/lokad/)). For fashion it models sizes, returns and price together ([Lokad fashion, Jul 2025](https://www.lokad.com/fashion-apparel-supply-chain-optimization/)).
- **Pricing:** Quote only, enterprise-focused ([Toolradar](https://toolradar.com/tools/lokad)).
- **Data needs:** Multi-channel sales, inventory, competitor prices and returns ([Lokad fashion](https://www.lokad.com/fashion-apparel-supply-chain-optimization/)).
- **GCC presence:** None found.
- **Fit: Partial.** Can model unusual setups like ours, but it is effectively a bespoke consulting build with lock-in to Lokad's language.

### GCC and India-built tools found
- **Increff** (India): see above. Strongest GCC fashion track record.
- **Stylumia** (India): see NPD section. Reported UAE presence ([YourStory, 2019](https://yourstory.com/2019/10/tech-30-myntra-stylumia-fashion-startup-ai-ml)).
- **DataWeave** (India): see NPD section.
- **Crest by Mate Labs** (Bangalore): AI replenishment for D2C sellers, launched 2021 ([PR Newswire, 2021](https://www.prnewswire.co.uk/news-releases/mate-labs-launches-crest-an-ai-powered-inventory-planning-amp-demand-forecasting-tool-for-e-comm-businesses-to-avoid-out-of-stock-fulfill-demand-amp-grow-revenue-898583868.html)). Current status unverified.
- **Unicommerce and Vinculum** (India): order and inventory management platforms that publish UAE-focused content ([Unicommerce UAE blog](https://unicommerce.com/blog/uae/retail-fashion-growth-solutions/); [Vinculum](https://www.vinculumgroup.com/retail-fashion-industry-in-uae-growth-challenges-solutions/)). They are order and stock systems, not forecasting tools. Whether they have GCC marketplace connectors is unverified.
- **GCC-built forecasting product:** none found. A search surfaced only a hackathon prototype ([LinkedIn post](https://ae.linkedin.com/in/hamdyhamde)) and consultancy blogs ([Intech Group](https://theintechgroup.com/blog/ai-demand-forecasting-for-retailers-in-middle-east/)).

---

## 4. NPD and trend intelligence

### EDITED
- **What it does:** Competitor assortment, pricing, site merchandising and customer data ([EDITED](https://edited.com/products/research)).
- **Pricing:** Contract-based, priced by duration and terms ([AWS Marketplace](https://aws.amazon.com/marketplace/pp/prodview-a26qg3h4ebtkq)). No public figure ([Fitgap](https://us.fitgap.com/products/edited)).
- **GCC presence:** Offices in London, Dallas and Sofia. No mention of Middle East retailers ([EDITED](https://edited.com/products/research)). Whether it tracks Namshi, noon or Ounass is unverified.
- **Fit: Partial.** It is the reference tool for competitor price and assortment tracking, but we must confirm it covers the GCC marketplaces we sell on.

### Trendalytics
- **What it does:** Trend forecasts from social (TikTok, Instagram, Pinterest), search and sales signals ([Trendalytics](https://trendalytics.co/fashion-trend-forecasting)). Acquired by Verishop in March 2024 ([CB Insights](https://www.cbinsights.com/company/trendalytics)).
- **Pricing:** A German review suggests around USD 1,000-2,000/month on annual contract for basic modules ([KI-Syndikat](https://www.ki-syndikat.de/tools/trendalytics/)). Unverified.
- **GCC presence:** Described as US-centric ([KI-Syndikat](https://www.ki-syndikat.de/tools/trendalytics/)).
- **Fit: Poor to partial.**

### Heuritech
- **What it does:** Image-based trend forecasting up to 24 months ahead across 2,000+ fashion attributes; SaaS and API ([Heuritech pricing](https://heuritech.com/pricing/)).
- **Pricing:** Three plans (Essential: 1 category, 1 geozone; Business; Enterprise), all "request pricing" ([Heuritech pricing](https://heuritech.com/pricing/)).
- **Data needs:** No client data history needed; it is an external dataset ([Heuritech pricing](https://heuritech.com/pricing/)).
- **GCC presence:** Geozone add-ons listed are Europe, US, China, Japan "and others"; the Middle East is not named ([Heuritech pricing](https://heuritech.com/pricing/)).
- **Fit: Partial.** Useful for attribute trends (for example activewear silhouettes for Cardio Bunny), but GCC trend data is unconfirmed.

### WGSN
- **What it does:** Trend forecasting reports and content.
- **Pricing:** No current public price found. Old or low-quality figures range from GBP 1,800/year (2000) to about USD 10K/year (forum, around 2007) ([Times Higher Education](https://www.timeshighereducation.com/node/25571); [Superfuture forum](https://supertalk.superfuture.com/topic/29420-wgsn-how-much/)). Not usable for budgeting.
- **GCC presence:** Not confirmed in our searches.
- **Fit: Partial.** Good for design direction, not for SKU-level decisions.

### Stylumia (India-built)
- **What it does:** Apparel consumer intelligence and demand sensing, plus "Orbix Price" pricing actions based on "True Demand" ([Stylumia Orbix](https://orbix.stylumia.ai/price)).
- **Pricing:** Subscription tiers by features, data access and users; custom pricing ([Gartner Peer Insights](https://www.gartner.com/reviews/product/stylumia-consumer-intelligence-tool)). Vendor-claimed: 30-50% profitability improvement in under 12 months, 10x ROI ([Stylumia](https://www.stylumia.ai/?p=31298)).
- **GCC presence:** Present in the UAE according to a 2019 article ([YourStory, 2019](https://yourstory.com/2019/10/tech-30-myntra-stylumia-fashion-startup-ai-ml)). No named GCC customers found.
- **Fit: Partial to good.** Founded by a former Myntra executive, apparel-first and built for marketplace-style fashion. Worth a demo.

### DataWeave (India-built)
- **What it does:** Digital shelf analytics and price intelligence: share of search, content audits, availability, pricing, promotions and reviews ([Presseportal](https://www.presseportal.de/pm/152041/5309191)).
- **Pricing:** Custom, contract-based ([Nova, Jul 2026](https://novadata.io/resources/blog/digital-shelf-analytics-tools-compared); [OMR](https://omr.com/en/reviews/product/dataweave/pricing)).
- **GCC presence:** Coverage is "global, deep in India and APAC" ([Nova, Jul 2026](https://novadata.io/resources/blog/digital-shelf-analytics-tools-compared)). Noon or Namshi coverage unverified.
- **Fit: Partial.** Good for price and rank tracking if GCC coverage is confirmed.

### Revuze
- **What it does:** AI review analytics and consumer research on products ([Capterra](https://www.capterra.com/p/179229/Revuze/)).
- **Pricing:** PricingSaaS (captured 16 Jul 2026): Bronze USD 1,000/month, Silver about USD 2,200/month, Gold about USD 4,100/month, Essentials USD 1.50 per response ([PricingSaaS](https://pricingsaas.com/companies/revuze)). Capterra shows a starting price of USD 30,000 ([Capterra](https://www.capterra.com/p/179229/Revuze/)).
- **GCC presence:** Not found. Arabic review support unverified.
- **Fit: Partial.**

### Yogi
- **What it does:** Review and feedback analytics focused on retail product reviews from Amazon, Walmart and Target ([The CX Lead](https://thecxlead.com/tools/yogi-review/)).
- **Pricing:** On request ([The CX Lead](https://thecxlead.com/tools/yogi-review/)).
- **Fit: Poor to partial.** US retailer focus.

### Lily AI
- **What it does:** AI product attribution and retail media optimisation ([Lily AI pricing](https://lily.ai/pricing)). Clients include Bloomingdale's, Gap and Macy's ([FashionUnited](https://fashionunited.com/tags/lily-ai)).
- **Pricing:** Starter, Growth and Enterprise tiers, all custom quote; pricing depends on catalogue size, channels and ad spend ([Lily AI pricing](https://lily.ai/pricing); [Lily AI FAQ](https://www.lily.ai/faqs/how-is-lily-priced)).
- **Fit: Poor.** Useful as an idea for a product attribute taxonomy, not for competitor gaps.

---

## 5. Marketplace analytics (Jungle Scout or Helium 10 style)

| Tool | Coverage | Price | Notes |
|---|---|---|---|
| Helium 10 | Amazon.ae supported (14th marketplace); Amazon.sa with a reduced tool set | Public plans, not captured here | Third-party tool-by-tool detail ([RevenueGeeks UAE](https://revenuegeeks.com/helium10-uae/); [RevenueGeeks KSA](https://revenuegeeks.com/helium10-saudi-arabia/)) |
| Jungle Scout | Amazon.ae and Amazon.sa in "limited support" tier | Public plans, not captured here | Official support list ([Jungle Scout](https://support.junglescout.com/hc/en-us/articles/360008768953)) |
| NoonSeller | Noon UAE and KSA | Free; Pro USD 39/month; Data API USD 199 per category per month (UAE and KSA) | Sales estimates are "model outputs, not confirmed sales", based on observed stock changes ([NoonSeller](https://noonseller.ae/)) |
| NoonSpy | Noon UAE and KSA | Free start; plans not on homepage | Price tracker, product hunter, Arabic listing generator; marketing claims unverified ([NoonSpy](https://noonspy.com/)) |
| Plott Data | Noon, Namshi, Trendyol (Amazon US/EU/India) | Quote | Managed feed: prices, stock, reviews, search rank, sellers ([Plott Data](https://plottdata.com/marketplaces/noon)) |
| Actowiz Metrics | Noon UAE and KSA, Carrefour | Quote | Price, buy box, share of search, reviews ([Actowiz](https://www.actowizmetrics.com/noon-data.php)) |
| DataWeave | Global, deep in India/APAC | Quote | See NPD section |
| Bright Data "Namshi Retail Media Analytics" | Namshi | Not captured | Ad volume, spend and search rankings ([Bright Data](https://brightdata.com/products/insights/retail-media-analytics/namshi)) |
| Noon Seller Lab | Opptra's own Noon data | Included for sellers | Sales and product performance analytics ([Brick2Bytes](https://brick2bytes.com/blogs/noon-seller-lab-guide)) |

Not found: a public Namshi brand-partner analytics portal ([search result summary](https://ecommercedb.com/store/namshi.com) shows only third-party estimates). Whether Amazon Brand Analytics (Search Query Performance) is available on Amazon.ae and Amazon.sa is unverified; the report is limited to Brand Registry sellers ([Influencer Marketing Hub](https://influencermarketinghub.com/amazon-search-query-performance-dashboard/)).

---

## 6. Review and listing scraping (prices per 1,000)

| Provider | Product | Price per 1,000 | Source |
|---|---|---|---|
| Apify | Noon.com Product Scraper (UAE listing pages, about 40 fields incl. best-seller rank and review count, not review text) | From USD 0.80/1K results, pay-per-event | [Apify](https://apify.com/shahidirfan/noon-com-scraper) |
| Apify | Noon Product Details Extractor | From USD 9/1K | [Apify](https://apify.com/getdataforme/noon-product-details-extractor) |
| Apify | Namshi Product Scraper (prices, discounts, ratings, stock signals) | From USD 1.00/1K | [Apify](https://apify.com/shahidirfan/namshi-product-scraper) |
| Apify | Trendyol Scraper All-In-One | USD 6/1K (third-party listing) | [DigitalBizTalk](https://digitalbiztalk.com/tools/apify-actors/fatihtahta/trendyol-scraper) |
| Apify | Amazon Reviews Scrapers | USD 1.50/1K (good-apis), USD 3/1K (Apify's junglee; max 100 reviews per star rating), USD 7.50/1K (seemuapps) | [good-apis](https://apify.com/good-apis/amazon-reviews/api); [junglee](https://apify.com/junglee/amazon-reviews-scraper); [seemuapps](https://apify.com/seemuapps/amazon-review-scraper?fpr=ewv9tm) |
| Apify | Platform plans | Free USD 0, Starter USD 19, Scale USD 199, Business USD 999 per month (included usage equals plan fee) | [Apify pricing](https://apify.com/pricing) |
| Bright Data | Web Scraper API | Free 5K records/month; USD 1.50/1K pay-as-you-go; Scale USD 499/month for 384K records then USD 1.30/1K | [Bright Data pricing](https://brightdata.com/pricing/web-scraper) |
| Bright Data | Noon scraper (name, price, brand, ratings, reviews, seller, stock) | Same Web Scraper API pricing | [Bright Data Noon](https://brightdata.com/products/web-scraper/noon) |
| Oxylabs | Web Scraper API | Amazon (non-JS) USD 0.50 to 0.25/1K by volume; other targets USD 1.00 to 0.75/1K; custom domain with JS USD 1.50 to 1.22/1K. Plans: Starter USD 30, Basic USD 100, Flexible USD 500/month | [Oxylabs pricing](https://oxylabs.io/products/web-api/scrape/targets/pricing) |

Rough cost illustration (our own estimate, not sourced): tracking 5,000 competitor SKUs once a day across 4 marketplaces is about 600,000 records a month. At USD 0.80-1.50 per 1,000 that is roughly USD 500-900 a month. Adding 100,000 reviews a month at USD 1.50-3 per 1,000 adds about USD 150-300. The data itself is cheap. The real cost is keeping scrapers working when sites change, and matching products across marketplaces.

Risk note (our judgement): Community-built Apify actors have small user bases (for example 26 monthly users on the Noon actor, per [Apify](https://apify.com/shahidirfan/noon-com-scraper)) and may break or be abandoned. Scraping marketplaces where Opptra is also a seller should be checked against each marketplace's seller terms by legal before go-live.

---

## 7. What GCC peers and global aggregators do

| Company | Public mention of forecasting or AI merchandising tools | Tool named | Source |
|---|---|---|---|
| Apparel Group (Dubai, about 1,530 stores) | Job post asks for ERP, merchandising, BI or planning systems experience | None named | [GulfTalent](https://www.gulftalent.com/uae/jobs/merchandise-planner-640950) |
| Landmark Group | Planning on IBM Planning Analytics, with plans to extend to sales forecasting using seasonality and weather (partner case study). Increff tie-up (2021). Max uses Google Cloud for virtual try-on (shopping, not planning) | IBM Planning Analytics; Increff | [IBM case study](https://www.ibm.com/case-studies/blog/revolutionizing-budgeting-and-planning-processes-for-a-retail-giant); [Martechvibe, 2021](https://martechvibe.com/article/increff-partners-with-fashion-and-logistics-brands-namshi-and-aramex); [Zawya](https://www.zawya.com/en/press-release/companies-news/max-and-google-cloud-ignite-a-new-era-of-ai-retail-giyumvqm) |
| Chalhoub Group | Hires demand and merchandise planners; planner job names "Blue Yonder, SAP, or similar" | Blue Yonder or SAP (as examples, not a confirmed deployment) | [Chalhoub careers](https://careers.chalhoubgroup.com/jobs/8568819-associate-merchandise-planner) |
| Majid Al Futtaim | RELEX for Carrefour (grocery); named RELEX client in 2025. MAF Lifestyle (fashion) planner and allocator jobs mention Excel, no tool named | RELEX (grocery side only) | [Hi Dubai](https://focus.hidubai.com/majid-al-futtaim-partners-with-relex-to-tailor-on-shelf-inventory-across-carrefour-stores/); [Sharikat Mubasher](https://en.sharikatmubasher.com/media-hub/news/21474601/relex-forum-riyadh-showcases-ai-solutions-for-smarter-supply-chains?lang=en); [Qureos](https://app.qureos.com/jobs/allocator-1764316870061) |
| Namshi (now part of noon) | Signed Increff Assure for fulfilment in 2021. No forecasting tool found | Increff Assure (fulfilment) | [Martechvibe, 2021](https://martechvibe.com/article/increff-partners-with-fashion-and-logistics-brands-namshi-and-aramex); [Gulf News](https://gulfnews.com/amp/business/retail/online-marketplace-noon-completes-buy-of-fashion-portal-namshi-1.93819176) |
| Binzagr (KSA distributor) | Named RELEX client | RELEX | [Sharikat Mubasher](https://en.sharikatmubasher.com/media-hub/news/21474601/relex-forum-riyadh-showcases-ai-solutions-for-smarter-supply-chains?lang=en) |
| Unnamed GCC fashion group (UAE, Oman, Bahrain; "DHG") | Replenishment, IST, size optimisation | Increff | [Increff, 27 Mar 2026](https://www.increff.com/case-studies/how-increff-helped-a-middle-east-retail-group-boost-sales-by-16-8) |
| GlobalBees (India aggregator) | Claims an in-house AI platform: demand prediction, replenishment across 2,400+ suppliers, SKU tracking across 15+ warehouses, dynamic pricing (vendor-claimed) | None named; appears in-house | [GlobalBees](https://globalbees.com/technology.html) |
| Mensa Brands (India aggregator) | Profiles say it uses big data and AI to forecast demand; jobs mention demand planning and SQL/Python | None named | [YourStory](https://yourstory.com/companies/mensa-brands); [Instahyre](https://www.instahyre.com/job-175868-data-analyst-at-mensa-brands-bangalore/) |
| Thrasio (US aggregator) | In-house demand forecasting team "at the center of inventory, promotions, pricing and marketing"; used Momentum Commerce for Amazon market intelligence | In-house; Momentum Commerce | [startup.jobs](https://startup.jobs/senior-data-scientist-economist-demand-forecasting-thrasio-3951425); [AdExchanger](https://adexchanger.com/ecommerce-2/why-amazon-aggregator-thrasio-is-sticking-with-ecommerce-native-experts-over-legacy-vendors) |

Pattern: large GCC retailers buy enterprise suites (RELEX, Blue Yonder, IBM) for store networks, and still rely on planners and Excel for fashion. Multi-brand aggregators (GlobalBees, Thrasio, Mensa) built forecasting in-house because their data lives in marketplaces, not stores. Opptra looks more like the aggregators than the mall retailers.

---

## 8. Synthesis: buy, build, and gaps

### Buy (commoditised)
- **Raw data collection.** Listing, price, rank and review scraping for Noon, Namshi, Amazon and Trendyol is available at about USD 0.25-1.50 per 1,000 records (Section 6). Building our own scrapers adds no value.
- **Noon sales estimates.** NoonSeller's Data API (USD 199 per category per month) already estimates competitor sales from stock movement ([NoonSeller](https://noonseller.ae/)). Cheaper than building it.
- **Amazon research.** Helium 10 or Jungle Scout for Amazon.ae; both are limited on Amazon.sa.
- **Macro trend input (optional).** Heuritech, WGSN or Stylumia as an input to NPD, if budget allows. Not essential for version 1.
- **Basic hardline replenishment maths.** Reorder points and lead-time logic are standard in Inventory Planner or Netstock. Worth buying only if their connectors cover our data; otherwise the same maths is easy to build once the data layer exists.
- **Review summarising.** Theme and sentiment extraction from review text is now a general AI capability (our judgement); paying USD 12K-49K a year for Revuze-style tools is hard to justify unless Arabic and GCC coverage is proven.

### Build (Opptra-specific)
- **One data layer across about 9 marketplaces and about 6 stock locations, including Noon FBN.** No vendor we found publicly lists connectors for Noon, Namshi, 6thStreet, Styli, Centrepoint and Trendyol GCC. Every tool reviewed assumes Shopify, Amazon, an ERP or POS as the source of truth. This layer is a prerequisite for both buying and building.
- **Event-aware forecasting with short history.** Hijri-calendar events (Ramadan, Eid) move about 11 days a year, and marketplace sale events have different names and dates per platform (Section 2). With under 12 months of history, Opptra needs to borrow signal from brand-level global history, similar products and marketplace category trends. We found no vendor that publicly documents how it handles this case.
- **Marketplace-level allocation and buy planning.** Deciding how much stock goes to Noon FBN versus our own warehouses versus each marketplace is different from store allocation, which is what Nextail, Onebeat and RELEX are built for.
- **Size curves by marketplace and country.** Curves differ by channel, and separate curves per channel are recommended practice ([Racklify](https://racklify.com/encyclopedia/what-is-a-size-curve-and-how-retailers-use-it/)). We would need them per marketplace and per UAE/KSA.
- **Competitor attribute-gap analysis for our own competitor sets.** For example Cardio Bunny vs BlissClub and Lululemon, on the marketplaces where they compete, including Arabic reviews. Tools like EDITED and DataWeave track competitors but are not confirmed for GCC marketplaces.

### Gaps no vendor fills (as far as public sources show)
1. Connectors for GCC fashion marketplaces (Namshi, 6thStreet, Styli, Centrepoint) in any planning tool.
2. Hijri-calendar event modelling designed for brands with under 12 months of history.
3. Allocation across marketplace fulfilment centres (FBN) and own warehouses as one optimisation problem.
4. Arabic-language review analytics on noon, Namshi and Amazon.ae/.sa.
5. A product that covers softline and hardline in one tool at mid-market price. The fashion tools (Nextail, Syrup, Toolio) and the replenishment tools (Netstock, Inventory Planner) are separate.

### Suggested shape for the proposal (our recommendation)
- Build the data layer and the forecasting and allocation logic in-house.
- Buy the data feeds (Apify, Bright Data or Oxylabs for scraping; NoonSeller API for Noon sales estimates; Helium 10 for Amazon).
- Take one or two demos before finalising: Increff (closest GCC fashion fit) and Toolio (closest planning model). Ask each about Noon and Namshi feeds, minimum history, and pricing at our size. This is the cheapest way to test the "buy" option seriously.

---

## 9. Open questions and unverified items
- Increff: noon, Namshi or Amazon.ae connectors; pricing; minimum history.
- Toolio, Nextail, Increff, RELEX: minimum history needed for a usable forecast. None publish it.
- EDITED, DataWeave, Revuze, Heuritech: whether they cover noon, Namshi, Amazon.ae/.sa and Arabic text.
- WGSN: current pricing.
- Amazon Brand Analytics availability on Amazon.ae and Amazon.sa.
- Whether Namshi, 6thStreet, Styli and Centrepoint give brand partners sell-through or search data through a portal.
- Seller terms for scraping marketplaces Opptra sells on (legal review).
- Helium 10 and Jungle Scout plan prices were not captured in this scan.
