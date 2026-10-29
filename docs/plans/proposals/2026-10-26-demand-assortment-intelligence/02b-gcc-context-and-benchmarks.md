# 02b - GCC context and ROI benchmarks

Proposal: Demand, assortment and NPD intelligence for Opptra (about 23 fashion and home brands, softline sales about USD 9M trailing 12 months, sold mainly on Namshi and Noon).

Research date: 2026-10-26. Method: web search and direct page reads. Each number has a source URL and year. Where a number came from a search summary and the page itself was not opened or not readable, it is marked **[UNVERIFIED]**. Market-research firm sizes (IMARC, MarkNtel, Ken Research and similar) are paid-report summaries with unclear methods; treat them as directional.

Tags used in Part B:
- **INDEPENDENT** = consultancy, academic, industry-analyst or government source with no product to sell for that result.
- **VENDOR-CLAIMED** = published by the software seller about its own customer, usually with no control group or method shown.

---

## Short answer

- **Market:** GCC fashion is about USD 85B with about 18% online in 2024, heading to about 25% online by 2030 (Redseer, 2025). UAE e-commerce was AED 42.2B (USD 11.5B) in 2025, and apparel and footwear was the biggest category at USD 3.1B (EZDubai / Euromonitor, 2026). In Saudi Arabia, online card payments on the Mada network grew about 47% in Jan-Oct 2025 (Saudi Central Bank data via press, 2025). KSA has a higher online share for fashion than the UAE (Redseer, 2025).
- **Marketplaces:** No published, trustworthy GMV share table exists for Noon, Namshi, Amazon and Trendyol. Traffic data shows Amazon leading both countries, Noon second in the UAE, and Trendyol already third in KSA by visits (Semrush, 2025). Treat any "share" number as a proxy.
- **Seasonality:** The big published lifts are Ramadan (apparel card transactions +76% to +78%, Checkout.com, 2023 data), White Friday (e-commerce sales 44% above the monthly average, Google/Visa, 2025), Saudi Founding Day (+44% spend vs non-peak, Google/Visa, 2025) and back to school (UAE online GMV +22% YoY, 2025). Most of these are single-source numbers.
- **Activewear:** KSA sportswear is about USD 1.6-1.9B and growing about 5-9% a year by most estimates. Saudi women's weekly sport rose from under 16% (2018) to above 40% (2022), the strongest structural signal for Cardio Bunny.
- **Returns:** No credible GCC fashion return rate is published. Use 25-35% for apparel (global and US benchmarks) and run a sensitivity test.
- **ROI levers:** Independent sources support forecast error falling 20-50% (McKinsey, data-rich firms), lost sales falling up to 65% (McKinsey, upper bound), inventory falling 5-15% in fashion (McKinsey State of Fashion 2025, via secondary source), and a 3-4% sales lift from better stock allocation (Zara, academic field experiment). Vendor case studies cluster at 13-28% fewer stockouts and +1.6 to +9.6 sell-through points. For a small operator with short sales history that sells through other companies' marketplaces, I recommend a **base case of about 20% lower forecast error, 15-20% fewer lost sales, 10% less inventory, 10% lower markdown cost and +3 sell-through points**. The detail and the reasons are in Part B.

---

## Part A - GCC context

### A1. E-commerce and online fashion market size

| Metric | Value | Year of data | Source (published) |
|---|---|---|---|
| GCC fashion retail market (all channels) | USD 85B now, 7% CAGR to USD 127B by 2030 | 2024-2025 | [Redseer, "GCC Fashion Market Outlook", Apr 2025](https://redseer.com/?p=87393) |
| GCC online share of fashion spend | about 18% in 2024, about 25% by 2030 | 2024 | same Redseer, 2025 |
| Cross-border share of GCC online fashion | 25-30% | 2024-2025 | same Redseer, 2025 |
| UAE plus KSA share of GCC fashion | nearly 80% | 2024-2025 | same Redseer, 2025 |
| Online retail penetration, all categories | UAE 16%, KSA 15% | 2025 | [Redseer, "KSA is the online fashion and BPC leader in GCC", Jul 2025](https://redseer.com/articles/ksa-is-the-online-fashion-bpc-leader-in-gcc/) |
| Fashion plus beauty share of KSA online retail | about 50% | 2025 | same Redseer, Jul 2025 |
| KSA vs UAE online fashion penetration | KSA higher than UAE (chart only, no number in text) | 2025 | same Redseer, Jul 2025 |
| Tourist share of UAE offline fashion spend | 20-30% (helps explain lower UAE online share) | 2025 | same Redseer, Jul 2025 |
| UAE e-commerce market | AED 42.2B (USD 11.5B), forecast 9.9% CAGR 2026-2030, about USD 18.3B by 2030 | 2025 | [WAM / EZDubai with Euromonitor, 2026](https://www.wam.ae/en/article/c2h35yn-uae-e-commerce-market-size-reaches-aed422-billion) **[UNVERIFIED: page did not render; figures from search summary]** |
| UAE apparel and footwear online sales | AED 11.4B (USD 3.1B), the largest category | 2025 | same WAM / EZDubai, 2026 **[UNVERIFIED]** |
| UAE e-commerce prior year | AED 32.3B (USD 8.8B) | 2024 | [WAM (French), EZDubai / Euromonitor, 2025](https://www.wam.ae/fr/article/bjscu4r-marché-commerce-électronique-des-émirats-arabes) **[UNVERIFIED]** |
| KSA online payments on Mada debit cards | Q1 SAR 69.3B (+56% YoY); Q2 about SAR 76.6B; Q3 about SAR 88.3B; Oct record SAR 30.7B (+68% YoY); Jan-Oct +47.3% | 2025 | [WAM, May 2025](https://www.wam.ae/en/article/15ng8l2-e-commerce-sales-saudi-arabia-exceed-sar-billion); [Arabian Business, 2025](https://www.arabianbusiness.com/industries/retail/saudi-arabia-e-commerce-sales-via-mada-hit-record-8-2bn-in-october); [Okaz, 2025](https://www.okaz.com.sa/economy/na/2228181) |
| KSA Mada online payments, full year | about USD 53B | 2024 | [Arab News, 2025](https://www.arabnews.com/node/2589350/business-economy) **[UNVERIFIED: headline only]** |
| KSA e-commerce revenue (government projection) | SAR 260B (about USD 69B) | 2025 forecast | [Gulf News, 2024, quoting Commerce Minister](https://gulfnews.com/world/gulf/saudi/saudi-arabias-e-commerce-revenue-to-reach-260-billion-riyals-by-2025-1.1728382326528) |
| KSA fashion e-commerce (third-party model) | USD 1.55B, apparel 57% of it | 2025 | [ECDB, 2025](https://ecdb.com/resources/sample-data/market/sa/fashion) **[modelled estimate]** |

Notes for the model:
- Mada counts only debit-card online payments (not Visa/Mastercard credit, not cash on delivery) and includes services, travel and bills. Use it for **growth direction** (+45-55% a year in 2025), not market size.
- KSA size estimates range from about USD 16B (research firms) to about USD 69B (government). The gap comes from definitions. Do not quote a single number without saying which.
- For Opptra the useful takeaway: online fashion is the largest online category in both countries, it is growing much faster than offline fashion (7%), and KSA is the bigger and faster online fashion market.

### A2. Marketplace shares

No source publishes a reliable GMV share by marketplace for GCC fashion. Below are the best proxies.

| Item | Value | Year | Source |
|---|---|---|---|
| KSA retail website visits per month | amazon.sa 26.3M; aliexpress 12.7M; trendyol 10.9M; noon about 8.7M | Oct 2025 | [Semrush, 2025](https://www.semrush.com/website/top/saudi-arabia/e-commerce-and-retail/) |
| UAE retail website visits per month | amazon.ae 17.1M; noon 5.0M; namshi.com about 0.47M (rank 15) | Jul 2025 | [Semrush, 2025](https://tr.semrush.com/website/top/united-arab-emirates/e-commerce-and-retail) |
| Namshi GMV (modelled) | USD 546M, KSA 52% of revenue | 2025 | [ECDB, 2025](https://ecdb.com/resources/sample-data/retailer/namshi) **[modelled estimate]** |
| Namshi sales (last public figure) | AED 685M in H1 2021 | 2021 | [Gulf News, 2021](https://gulfnews.com/business/retail/dubais-emaar-malls-first-half-2021-revenues-go-past-dh2b-1.1628593646355) |
| Namshi owner | Sold by Emaar to Noon for AED 1.2B (USD 335M); deal announced 2022 | 2022-2023 | [AGBI, 2022](https://www.agbi.com/article/emmar-to-sell-fashion-retailer-namshi-to-noon-for-335m/) |
| Trendyol GCC | Launched 2023-24; over 3M customers and over 1M orders a month at peak in first year, 80% of orders from KSA; KSA became its second-largest market globally | 2024-2025 | [Arab News, Oct 2024](https://www.arabnews.pk/node/2576175/corporate-news); [Gulf Business, Mar 2025](https://gulfbusiness.com/en/2025/interviews/interview-with-trendyol-gulfs-mohamad-elansari/) **[company claims]** |
| Trendyol brand onboarding | Alshaya brands (H&M, American Eagle) on Trendyol GCC | 2025 | [Images RetailME, 2025](https://www.imagesretailme.com/alshaya-group-brands-join-trendyol-in-the-gcc/) |
| UAE top-5 online stores' share of top-100 sales | 56% (2021), about 49% (2022); Amazon.ae first | 2021-2022 | [ECDB country report](https://ecdb.com/reports/ecommerce-in-the-united-arab-emirates/584) **[UNVERIFIED]** |
| Noon plus Amazon share of regional e-commerce | about 30% | 2019 | [Wamda, 2019](https://www.wamda.com/2019/03/namshi-plans-expansion-egypt-e-commerce-competition-heats) (old) |

What this means: Amazon is the biggest general marketplace in both countries. Noon (with Namshi) is the main local rival. Trendyol has become a serious fashion player in KSA in two years. Styli and Centrepoint (Landmark Group) and 6thStreet (Apparel Group) are retailer-owned fashion sites; I found no traffic or share numbers for them. Cross-border sites (Shein, Temu, AliExpress) take about a quarter of online fashion spend (Redseer, 2025). For the ROI model, use Opptra's own channel mix, not market shares.

### A3. Seasonal demand patterns

The Islamic calendar moves about 11 days earlier each year, so Ramadan, Eid al-Fitr and Eid al-Adha shift across Gregorian months. A forecasting tool must model them as moving events, not fixed months. This is one of the strongest arguments for a purpose-built tool over spreadsheets.

| Event | Published uplift | Year of data | Source | Notes |
|---|---|---|---|---|
| Ramadan, apparel | Apparel transaction volume +78% (UAE) and +76% (KSA) | Ramadan 2023 (published Apr 2024) | [Checkout.com, 2024](https://www.checkout.com/blog/online-marketplace-spending-skyrockets-by-143-during-ramadan-in-the-uae); [Checkout.com KSA, 2024](https://checkout.com/blog/ramadan-online-spend-expected-to-raise-across-key-sectors) | Comparison base is unclear (likely the prior period); one payment processor's data. **VENDOR data** |
| Ramadan, online marketplaces | +143% transaction volume (UAE) | 2021-2023 | same Checkout.com, 2024 | The page uses 143% for two different things; low confidence |
| Ramadan, all e-commerce | KSA sales +30%, GMV +35%; UAE orders +20%, GMV +13% (vs prior year) | 2025 | [Flowwow/Admitad via MEA Tech Watch, Apr 2025](https://meatechwatch.com/2025/04/03/eid-al-fitr-and-ramadan-drive-mena-e-commerce-boom-150-increase-in-gift-demand-with-30-growth-expected-for-eid-2025/) | Gifting-platform data, not fashion-only |
| Ramadan, card spend KSA | Transactions +32% YoY in Ramadan; fashion and clothing +61% | Q1 2025 | [Visa Travel Pulse KSA Q1 2025](https://sa.review.visa.com/content/dam/VCOM/regional/cemea/saudiarabia/documents/visa-travel-pulse-q1-2025.pdf) **[UNVERIFIED segment]** | Includes tourists |
| End of Ramadan / Eid al-Fitr searches | Luxury apparel searches +21% (UAE), +45% (KSA) | 2024-2025 | [Google/Visa, Sep 2025](https://business.google.com/en-all/think/consumer-insights/google-visa-research-commerce-insights-in-uae-and-saudi/) | Search interest, not sales |
| Eid al-Fitr category mix | Fashion 17.8% of online orders (largest category) | 2025 | [Gulf News, 2025](https://gulfnews.com/business/retail/eid-al-fitr-shopping-spree-what-uae-residents-are-buying-and-big-trends-shaping-2025-1.500077043) | Share, not uplift |
| Eid al-Adha | Searches for luxury apparel and beauty +11% (UAE), +15% (KSA); online orders +5% and GMV +14% vs non-holiday days (MENA, 2024) | 2024-2025 | Google/Visa, 2025 (above); [Economy Middle East, 2025](https://economymiddleeast.com/news/eid-al-adha-2025-drives-45-percent-mobile-commerce-boom-in-mena-report) | Much smaller fashion peak than Eid al-Fitr |
| White Friday / Black Friday | E-commerce sales 44% above monthly average in November; peak-week spend +31% (UAE), +36% (KSA); deal searches +69% | 2024-2025 | Google/Visa, Sep 2025 (above) | Best single source for the November peak |
| White Friday season | Revenue +40%, purchases +19% vs 2023 (MENA) | 2024 | [Campaign ME, 2024](https://campaignme.com/creative-campaigns-targeted-marketing-fuel-skyrocketing-white-friday-sales/) | Year-on-year growth of the event, not lift over a normal week |
| 11.11 | Noon runs 11.11 sales (up to 90% off), Amazon.ae and others too; no published uplift found | 2024-2025 | [Khaleej Times](https://www.khaleejtimes.com/1111-sale-dh1-deals-90-discounts-gifts) | Gap: use Opptra's own Namshi/Noon history |
| Saudi Founding Day (22 Feb) | Spend +44% vs non-peak, apparel, beauty and home especially boosted | 2024 | Google/Visa, Sep 2025 (above) | Often overlooked; model it |
| Saudi National Day (23 Sep) | Visa card spend +21% in the week (+32% YoY 2023-24); 2025 POS spend week +3.0%; discount searches +70% | 2024-2025 | [Campaign ME, 2025](https://campaignme.com/winning-the-saudi-national-day-consumer/); [Qoyod / SAMA data, 2026](https://www.qoyod.com/en/reports/saudi-national-day-spending/) | Mostly in-store and dining; online lift modest |
| Back to school | UAE online orders +18%, GMV +22% YoY (10 Jul-17 Aug 2025); KSA online basket led by fashion (24%) | 2025 | [Campaign ME, 2025](https://campaignme.com/online-sales-surge-18-per-cent-during-back-to-school-2025-in-uae/) | KSA season starts earlier (late July) |
| Summer | Offline footfall falls as residents travel (Jun-Aug); online Dubai Summer Surprises orders +12%, revenue +15% YoY | 2018; 2024 | [The National, 2018](https://www.thenationalnews.com/uae/summer-slowdown-hits-small-firms-hard-1.508353); [Gulf News, 2025](https://gulfnews.com/business/retail/dubai-summer-sale-now-rivals-black-friday-with-big-boost-in-digital-spending-1.500216500) | Online dip is smaller than offline; no monthly online data found |
| Payday (KSA) | Government salaries paid on the 27th of each Gregorian month (royal order, Jan 2018); Google/Visa say Saudi spend surges after payday | 2018; 2025 | [Argaam, 2018](https://www.argaam.com/en/article/articledetail/id/523509?amp); Google/Visa, 2025 | No published day-level uplift. Opptra's own daily data will show it |

How to use this in the ROI model: the published multiples are mostly **year-on-year growth of the event** or **lift over the monthly average**, not "how many times a normal week". For forecasting, the safer inputs are: Ramadan / Eid al-Fitr window and White Friday as the two biggest fashion peaks (roughly 1.3x to 1.8x normal weekly demand, based on the +31% to +78% figures above), Founding Day and back to school as medium peaks, Eid al-Adha and National Day as small fashion peaks, and summer as a soft period for UAE. These are my reading of the sources, not a published multiple. Replace them with Opptra's own marketplace history as soon as the tool is live.

### A4. Activewear and athleisure (Cardio Bunny context)

| Metric | Value | Year | Source |
|---|---|---|---|
| KSA sportswear market | USD 1.57B (2025) to USD 2.87B (2032), about 9.3% CAGR; men about 52% of demand, women "faster-emerging" | 2025 | [MarkNtel press release, 2025](https://www.marknteladvisors.com/press-release/saudi-arabia-sportswear-market-growth) |
| KSA sportswear (other estimate) | USD 1.9B (2024) to USD 2.9B (2033), 4.7% CAGR | 2024 | [IMARC](https://imarcgroup.com/saudi-arabia-sportswear-market) |
| KSA activewear | USD 3.8B (2024) | 2024 | [IMARC](https://www.imarcgroup.com/saudi-arabia-activewear-market) **[UNVERIFIED, definitions differ]** |
| UAE sportswear | USD 955M (2024), 3.8% CAGR | 2024 | [IMARC](https://www.imarcgroup.com/uae-sportswear-market) |
| Saudi women weekly physical activity (30+ min) | above 40% in 2022, up from under 16% in 2018 | 2018-2022 | [Arab News, 2024, citing SFA / GASTAT](https://arab.news/mgcmv) |
| Saudi adults 30+ min weekly sport | 48.2% (2021), +3.2 pts vs 2019 | 2021 | [Arab News, 2022, GASTAT](https://www.arabnews.com/node/2128576) |
| Female sports participation | about +150% over five years (ministry statement) | 2023 | [ANBA](https://anba.com.br/en/female-participation-in-sports-up-150-in-saudi-arabia) **[government claim]** |
| Lululemon in GCC | Run by Majid Al Futtaim since 2015; 20th regional store opened Jan 2024; 9 stores in KSA by 2025 | 2015-2025 | [Images RetailME, 2015](https://www.imagesretailme.com/maf-fashion-signs-regional-deal-lululemon-athletica/); [The Brand Berries, 2024](https://thebrandberries.com/?p=18538); [Mubasher, 2025](https://sharikatmubasher.com/media-hub/news/21482066/Majid-Al-Futtaim-expands-lifestyle-retail-footprint-in-Saudi-Arabia?lang=ar) |
| BlissClub | India-only as far as found; FY25 revenue INR 131.6 Cr, +51% YoY; 40+ stores in India; no GCC launch found | 2025 | [Inc42, 2025](https://inc42.com/buzz/blissclub-raises-₹160-cr-to-fuel-offline-expansion-enter-new-categories/) |

Takeaway: published market sizes disagree by up to 4x, so do not anchor ROI on them. The reliable signal is behavioural: Saudi women's regular exercise more than doubled between 2018 and 2022 and is still rising toward 2030 targets. Lululemon is expanding stores in KSA at the premium end. BlissClub is a value-to-mid competitor in India, not yet in the GCC (as of this search). Cardio Bunny sits between them on price, so demand sensing for women's activewear in KSA (sizes, modest-fit cuts, colours) is a strong use case for the competitor-insight module.

### A5. Return rates in GCC fashion e-commerce

| Item | Value | Year | Source |
|---|---|---|---|
| GCC fashion return rate | **No credible published figure found** | - | - |
| UAE "26% apparel" figure seen online | The source page cites no study, and its 16.9% is a global figure | Jan 2026 | [Quiqup blog, 2026](https://www.quiqup.com/post/ecommerce-returns-uae-2025) - do not use |
| MENA e-commerce returns (Dubai Chamber) | 15-40% depending on category; about 30% of online retail items returned | 2022 | [Al Arabiya, Jul 2022](https://english.alarabiya.net/views/2022/07/28/Total-refund-requires-managing-the-growing-issue-of-e-commerce-returns-in-MENA-) |
| Namshi early-days return plus undelivered | about 40% without delivery controls; over 90% cash on delivery then | about 2014 | [Wamda, 2013-14](https://www.wamda.com/index.php/2013/08/rocket-internet-namshi-same-day-delivery) (old) |
| US online apparel returns | about 30%; 56% of apparel/footwear brands at or above 30% | 2025 | [Radial, State of Returns 2025](https://www.radial.com/wp-content/uploads/2025/10/State-of-Returns_Report_2025_Final.pdf) |
| US online apparel returns | 24.4% (12 months to Mar 2023) | 2023 | Coresight Research via search **[UNVERIFIED]** |

Recommendation: use Opptra's actual return and failed-delivery rates from Namshi and Noon settlement reports. If a placeholder is needed, use 25% (low), 30% (base), 35% (high) for apparel, and add cash-on-delivery refusals on top for KSA. Forecasts should be built on **net kept units**, not gross orders, or the tool will over-buy.

---

## Part B - ROI benchmarks

### B1. Evidence table

| Lever | Number | Context | Tag | Source and year |
|---|---|---|---|---|
| Forecast error | AI forecasting cuts errors 20-50% | Supply chain, general | INDEPENDENT | [McKinsey, "AI-driven operations forecasting in data-light environments", 2022](https://www.mckinsey.com/capabilities/operations/our-insights/ai-driven-operations-forecasting-in-data-light-environments) **[page timed out; numbers confirmed by multiple search extracts]** |
| Forecast error | New-product apparel forecasting with web data: MAPE down at least 26% | Academic, B2C apparel site | INDEPENDENT | [Tsao et al., Fibres and Textiles in Eastern Europe, 2023](https://open.icm.edu.pl/items/12ebd59b-489e-418d-abfd-fa98af690547) |
| Forecast error | New fast-fashion items: bias down over 19% for high-demand items vs expert baseline | Academic | INDEPENDENT | [ITU, ECML PKDD workshop, 2025](https://research.itu.edu.tr/en/publications/initial-demand-prediction-fornew-fashion-products-inthefast-fashi/) |
| Forecast error | Forecast accuracy +6.8 pts (Runsvengruppen); +10 pts (Transmeri) | Discount retail; consumer goods | VENDOR-CLAIMED | [RELEX, Runsvengruppen](https://www.relexsolutions.com/news/runsvengruppen-achieves-improved-forecast-accuracy-and-standardizes-planning-processes-with-relex/); [RELEX, Transmeri](https://www.relexsolutions.com/news/transmeri-forecasts-and-plans-production-with-relex-solutions/) (undated) |
| Forecast error | +40% forecast accuracy, end-of-season overstock -20% | Unnamed retailer | VENDOR-CLAIMED | [Blue Yonder / Supply Chain Dive, about 2020](https://media.blueyonder.com/supply-chain-dive-3-ways-to-fight-stockouts-in-the-pandemic) |
| Stockouts / lost sales | Lost sales and unavailability down up to 65% | General | INDEPENDENT | McKinsey 2022 (above) |
| Stockouts | AI forecasting: inventory -5-15%, stockouts improved 15-25% | Fashion | INDEPENDENT | McKinsey and BoF, State of Fashion 2025, via [DRESSX](https://dressx.com/news/why-fashion-brands-can-no-longer-afford-to-overproduce) and [invent.ai blog](https://www.invent.ai/blog/fast-fashion-stockouts-in-2026-a-complete-guide-to-maximizing-sales) **[UNVERIFIED against McKinsey original]** |
| Stockouts | Stockouts -24%, lost sales -28% | River Island (UK fashion) | VENDOR-CLAIMED | [Nextail / casestudies.com](https://www.casestudies.com/company/nextail-labs/case-study/river-island-cuts-stockouts-24-with-nextail) (undated) |
| Stockouts | Stockouts -13%, full-price sell-through +5 pts, store cover -7.5% | Guess (EMEA) | VENDOR-CLAIMED | [Nextail, about 2025](https://nextail.co/customer/guess-automated-inventory-replenishment) |
| Stockouts | Stockouts -13%, sell-through +9.6 | Gina Tricot | VENDOR-CLAIMED | [casestudies.com](https://www.casestudies.com/company/nextail-labs/case-study/gina-tricot-cuts-replenishment-time-by-50-with-nextail-labs) |
| Stockouts | Lost sales -25% | Hackett London | VENDOR-CLAIMED | [Nextail mini case](https://offers.nextail.co/hubfs/Mini%20case%20studies/Nextail%20Mini%20Case%20Study%20Hackett.pdf) |
| Stockouts | Up to 85% fewer stockouts; up to 30% less inventory | Marketing headline | VENDOR-CLAIMED | [RELEX](https://www.relexsolutions.com/solutions/demand-planning-software/) |
| Stockouts | 71% fewer stockouts, 33% less inventory, +15% sell-through, 60% faster turns | Platform average claim | VENDOR-CLAIMED | [Just Style on Onebeat, 2024](https://www.just-style.com/news/onebeat-funding-inventory-management/) |
| Cost of stockouts | Global inventory distortion USD 1.77T: out-of-stocks USD 1.2T, overstocks USD 572B | All retail, 2025 edition | INDEPENDENT (analyst) | [IHL Group, 2025](https://www.ihlservices.com/product/fixing-inventory-distortion-whos-winning-whos-failing-whats-working/) **[page blocked; figures from IHL listing snippet]** |
| Cost of stockouts | Out-of-stock rate 8.3% in stores; shoppers' reaction costs about 3.9% of sales | Grocery / FMCG | INDEPENDENT (academic) | Gruen, Corsten and Bharadwaj, 2002, via [Wikipedia summary](https://en.wikipedia.org/wiki/Stockout) and [Redalyc paper](https://www.redalyc.org/pdf/947/94756009002.pdf) |
| Cost of stockouts | Online OOS about 15% in US vs 8.3% in stores; online shoppers mostly switch brand on the same site | Online grocery / CPG | INDEPENDENT (academic) | [Corsten and Gruen for GMA, 2018, via UNH](https://www.unh.edu/unhtoday/node/13244) |
| Sales lift | Better stock allocation lifted sales 3-4% (controlled field experiment) | Zara | INDEPENDENT (academic) | [Caro and Gallien, Interfaces / Operations Research, 2010](https://www.london.edu/faculty-and-research/academic-research/z/zara-uses-operations-research-to-reengineer-its-global-distribution-system) |
| Sales lift | Demand forecast plus price optimisation for new, never-sold items: revenue about +10% | Rue La La (online flash fashion) | INDEPENDENT (academic) | [Ferreira, Lee, Simchi-Levi, M&SOM, 2016, via HBS](https://aiinstitute.hbs.edu/insights/analytics-online-retailer-demand-forecasting-price-optimization/) |
| Profit | Updating orders on early sales roughly increased profit 60% vs informal method | Sport Obermeyer (skiwear) | INDEPENDENT (academic) | [Fisher and Raman, Operations Research, 1996](https://pubsonline.informs.org/doi/10.1287/opre.44.1.87) |
| Margin / markdown | Merchandising analytics: margin up to +2 pts a year in first wave | Retail | INDEPENDENT | [BCG, "Rewiring Merchandising", Feb 2020](https://web-assets.bcg.com/img-src/BCG-Rewiring-Merchandising-to-Make-the-Most-of-Analytics-Feb-2020_tcm9-238910.pdf) |
| Margin / markdown | Promotion optimisation: +140 bps margin | Retail client | VENDOR-CLAIMED (BCG product page) | [BCG Retail AI](https://www.bcg.com/ja-jp/x/products/retail-ai) |
| Markdown | Markdown depth 52% to 45% (-7 pts), sell-through margin +8.6 pts; partly vs plan | Global sportswear outlet | VENDOR-CLAIMED | [Increff, Feb 2026](https://www.increff.com/case-studies/how-increff-helped-a-global-sportswear-brand-improve-sell-through-margin-by-8-6) |
| Markdown | Markdown loss -2%, revenue +2.4% | European apparel retailer | VENDOR-CLAIMED | [invent.ai](https://www.invent.ai/case-study/markdown-optimization-solutions-case-study) |
| Markdown | Profit margin +2% vs control group | Intertop (footwear) | VENDOR-CLAIMED (has control group) | [Competera](https://competera.ai/resources/articles/markdown-optimization) |
| Markdown | Margin up to about 7% in sale periods | Fashion | VENDOR-CLAIMED | [Just Style on Markmi, 2025](https://www.just-style.com/featured-company/just-style-excellence-awards-2025-markmi/) |
| Inventory | Inventory -5-15% (fashion, AI forecasting) | Fashion | INDEPENDENT [UNVERIFIED] | State of Fashion 2025 (above) |
| Inventory | Inventory value -EUR 740k; Vianor stock -30% in season | Retail | VENDOR-CLAIMED | RELEX (above) |
| Inventory turns | Turns +22%, sales +12%, inventory age 125 to 75 days | Tanishq (jewellery) | VENDOR-CLAIMED | [Onebeat / casestudies.com](https://www.casestudies.com/company/onebeat/case-study/tanishq-customer-case-study) |
| Inventory turns | Turns 2-3x (footwear); 2x (Hirawats) | India | VENDOR-CLAIMED (outlier) | [Increff case studies](https://increff.com/case-studies/industries-fashion-apparel-or-footwear-or-generic) |
| Inventory turns baseline | Public apparel median about 3.3x (about 110 days), FY2024 | US listed apparel | Blog synthesis of filings **[UNVERIFIED]** | [Branvas, 2025](https://branvas.com/blogs/news/inventory-turnover-benchmarks-retail-category) |
| Sell-through | Sales units +16.8%, sell-through 49.2% to 50.9% (+1.6 pts), AED 2.29M extra revenue | GCC fashion retail group (UAE, Oman, Bahrain), 2024 vs 2025 | VENDOR-CLAIMED | [Increff, Mar 2026](https://www.increff.com/case-studies/how-increff-helped-a-middle-east-retail-group-boost-sales-by-16-8) |
| Sell-through | Full-price sell-through +13% | Celebrity fashion brand | VENDOR-CLAIMED | [Increff](https://www.increff.com/case-studies) |
| Sell-through | Sell-through +10% in one year | Footwear and sports apparel | VENDOR-CLAIMED | [Antuit.ai](https://www.antuit.ai/global-footwear-sports-apparel-retailer-improves-sell-through-recaptures-lost-margins) |
| Sell-through | 60% sell-through using trend data (no baseline) | Chalhoub (GCC luxury) | VENDOR-CLAIMED | [Heuritech](https://heuritech.com/?p=27969) (undated) |
| Sell-through baseline | Full-price sell-through about 60% for US apparel retailers | US | INDEPENDENT (analyst) | [Coresight Research](https://coresight.com/research/us-retailer-survey-revealing-the-hidden-costs-of-poor-inventory-management-2/) (date not shown) |
| NPD hit rate baseline | About 3 in 4 FMCG launches fail in year one | Europe FMCG, 12,000 launches | INDEPENDENT | [Nielsen via Marketing Week, 2014](https://www.marketingweek.com/3-in-4-fmcg-launches-fail-within-a-year/) |
| NPD / unsold stock baseline | About 30% of garments produced go unsold (widely repeated, weak origin); Dutch study 6.5% left over | Global; Netherlands | INDEPENDENT but weak | [FashionUnited, 2018](https://au.fashionunited.com/news/fashion/infographic-the-extent-of-overproduction-in-the-fashion-industry/201812127021); [CLICKNL, 2016](https://www.clicknl.nl/news/nextfashion/2016/08/10/mapping-overstock-in-the-dutch-apparel-industry) |
| NPD time to market | Gen AI across product development: cycle times down "upward of 70%" in some cases | Physical products, not fashion-specific | INDEPENDENT | [McKinsey, 2024](https://www.mckinsey.com/capabilities/tech-and-ai/our-insights/generative-ai-fuels-creative-physical-product-design-but-is-no-magic-wand) |
| NPD value pool | Gen AI could add USD 150-275B to fashion operating profit in 3-5 years | Fashion, all functions | INDEPENDENT | [McKinsey, Mar 2023](https://www.mckinsey.com/industries/retail/our-insights/generative-ai-unlocking-the-future-of-fashion) |
| NPD test-and-repeat | Shein launches each new style in 100-200 units, reorders only winners; claims single-digit unsold stock vs 25-40% industry | Ultra-fast fashion | VENDOR-CLAIMED (company) | [Shein Group, 2023](https://www.sheingroup.com/wp-content/uploads/2023/10/On-Demand-Fashion.pdf); [Exciting Commerce, 2022](https://excitingcommerce.de/2022/11/30/shein-laesst-inzwischen-auch-in-der-tuerkei-produzieren/) |
| Reviews to returns | Unbiased reviews lower returns; fit comments in apparel reviews help size choice | Academic | INDEPENDENT | [Sahoo, Dellarocas, Srinivasan, ISR, 2018](https://pubsonline.informs.org/doi/10.1287/isre.2017.0736) |

Not found: any study measuring new-style hit rate improvement from review mining in fashion; any Gartner number on forecast accuracy gains (Gartner content is paywalled); any BCG fashion-specific inventory or markdown percentage; the McKinsey "logistics -15%, inventory -35%, service +65%" figure (often quoted from "Succeeding in the AI supply-chain revolution", Apr 2021, but the PDF did not load, so **[UNVERIFIED]**).

### B2. How to read these numbers

1. **Vendor numbers are best-case.** They are chosen customers, usually large store chains with years of clean data, and rarely have a control group. A fair haircut is 40-60%.
2. **Independent numbers are ranges for large firms.** McKinsey's 20-50% error reduction and "up to 65%" lost-sales cut are ceilings seen in data-rich companies. The academic field results (Zara +3-4% sales, Rue La La about +10% revenue) are the most trustworthy but come from big, sophisticated operators.
3. **Opptra is different in four ways that pull the numbers down:**
   - Short sales history per SKU, many new styles each season, so most forecasting is "new product" forecasting, which is harder.
   - Sells through marketplaces (Namshi, Noon, Amazon, Trendyol and others) that control part of pricing, placement and promotions. Opptra cannot move stock between stores the way Zara or River Island do, which is where much vendor value comes from.
   - Long, lumpy supply from international brand principals, so fixing a forecast does not always change what can be bought in time.
   - Small base (USD 9M), so fixed software and people costs weigh more.
4. **Two things pull the numbers up:**
   - The starting point is likely spreadsheets and gut feel, so the first improvement is often big.
   - The calendar is unusually hard (moving Ramadan and Eids, White Friday, Founding Day). A tool that handles moving events well gains more here than in Europe.
5. **Do not add all levers together.** Lower inventory and fewer stockouts trade off against each other. Pick one primary lever per brand (for most, "fewer lost sales at the same inventory" in growing brands, and "less inventory at the same availability" in mature ones).

### B3. Recommended ranges for Opptra's ROI model

Each value is a relative change versus today's process unless it says "points". "Points" means percentage points (for example, sell-through 50% to 53% is +3 points).

| Lever | Conservative | Base | High | Reasoning |
|---|---|---|---|---|
| Forecast error (WMAPE, relative reduction) | 10% | 20% | 30% | Bottom of McKinsey's 20-50%; matches academic new-product results (19-26%); vendor accuracy gains of 6.8-10 pts sit around here. Short history caps the high end. |
| Lost sales from stockouts (relative reduction) | 10% | 20% | 30% | McKinsey fashion 15-25% (unverified) and vendor 13-28% cluster here. McKinsey's "up to 65%" is a ceiling for data-rich firms, not a planning number. |
| Inventory held, at same availability (relative reduction) | 5% | 10% | 15% | McKinsey State of Fashion 5-15% for fashion. RELEX's "up to 30%" is a vendor headline. Marketplace consignment limits what Opptra controls. |
| Markdown cost (relative reduction in markdown spend) | 5% | 10% | 20% | BCG up to 2 pts margin a year; invent.ai -2% markdown loss; Increff -7 pts depth (vendor, partly vs plan). Marketplace-funded promotions are outside Opptra's control, so keep the base modest. |
| Inventory turns (relative increase) | 5% | 10% | 20% | Follows from the inventory and sales levers. Onebeat +22% is vendor-claimed; Increff 2-3x is an outlier. |
| Full-price sell-through (points) | +1 | +3 | +5 | GCC case +1.6 pts (Increff, closest match to Opptra's region); Guess +5 pts; Gina Tricot +9.6 (vendor high). |
| Total sales lift from better buying and allocation | 1% | 3% | 5% | Zara field experiment 3-4% (independent, store allocation); Rue La La about 10% includes pricing. GCC case +16.8% units is vendor and includes growth. |
| New-product hit rate (share of new styles reaching target sell-through, points) | 0 | +5 | +10 | No direct published evidence. Treat as option value. Base assumes review and competitor insight removes some obvious misses (wrong sizes, fits, colours). Validate with a 1-2 season A/B test on one brand. |
| Time to market for new products (weeks saved) | 0 | 2 | 4 | McKinsey's "upward of 70%" is gen AI across physical product design, not fashion buying. For a brand aggregator, the saving is in faster buy decisions and assortment picks, not design. |
| Return rate (relative reduction, from fit and review insight) | 0 | 3% | 7% | Academic work shows reviews and fit info lower returns, but effect sizes are small (for example, a 10% rise in helpful reviews linked to 0.44% lower return probability). |

How to turn this into money (illustrative only, using Opptra's USD 9M softline sales; replace the assumed inputs with real data):
- If 8-15% of demand is currently lost to stockouts (assumed; the store benchmark is 8.3% OOS and online about 15%), a 20% cut recovers about 1.6-3.0% of sales, roughly USD 145-270k a year at today's size.
- If average inventory is about 3-4 months of cost (assumed, close to the 3.3x turns median), a 10% cut releases about 2.5-3.5% of annual cost of goods as one-time cash.
- If markdowns cost 15-25% of gross sales (assumed), a 10% cut is worth 1.5-2.5% of sales in margin.
- Because sales are growing fast, the value grows with the business; model it as a percentage of sales, not a fixed amount.

### B4. Gaps and how to close them

- No GCC fashion return rate and no marketplace share data: use Opptra's own Namshi and Noon settlement and returns reports.
- No published 11.11 or payday uplift: measure from Opptra's daily marketplace data in the first month.
- No independent evidence for NPD hit-rate or review-mining gains: run a controlled pilot (one brand, half the new styles chosen with the tool, half without) before counting this in the base case.
- Several key McKinsey and IHL figures were confirmed only through search extracts because the pages blocked or timed out; open the originals before the proposal goes to leadership.
