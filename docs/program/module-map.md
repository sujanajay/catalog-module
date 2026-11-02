# Catalog OS - module and feature tree (review version, 2026-11-02)

Appendix to `brief-v1.md`. Structure as Sujan asked: modules, then features inside each module. Requirements per feature come later, once this tree is approved, and are deliberately not written here.

Sources: the `.runs` reports of 2026-10-26 to 2026-11-02 for our own numbers ("exact" means counted, "judgement" means an assumption), and the three competitor reports of 2026-11-02 (`competitors-visual`, `competitors-listing`, `competitors-measurement`; about 70 tools, vendors and agencies) for the "Market today" column. Most competitor facts are vendor claims or secondhand; treat "nobody" as "nobody found in this study", not as proof.

Data limit for every module: no Amazon seller data API (SP-API) for GCC now. Outcomes come from our BigQuery sales, stock, price and ads tables plus public pages.

## How to read the tables

- **Market today**: who sells this feature now. "Nobody" means the study found no one doing it, or no one doing it for GCC or India marketplaces.
- **Buy / Build / Skip**: "Buy" = an outside model or vendor behind our own interface, with a fallback vendor. "Build" = we write it. "Keep" = it already exists in the live tool or in `gcc-dashboard` and is reused. "Skip" = not doing it, with the reason.
- **Priority**: P0 = in the first slice (about one week). P1 = next, within the 12-week measurement window. P2 = after the first readout. Later = after the GCC loop works, or when a second customer exists. "-" = skipped.
- **Intent ids**: rows in `intents.json` that the feature serves.

## What the competitor study changed

1. **Confirmed the split.** Generation, cleanup, try-on and generic copy are cheap and crowded (USD 0.02-0.15 per image; Amazon, Google and Shopify give tools away). Nobody does the five things we build: the content-to-sales loop, GCC/India marketplace rules, our own fidelity and quality checks, marketplace-native Arabic, and consistency across many brands.
2. **Analysis became its own module (M2 Analyze).** Every vendor that tags attributes (Vue.ai, Rubick, Streamoid) sells analysis separately from generation, and intent I022 asks for it. One measured analyzer now feeds images, text and quality.
3. **Added features the market treats as table stakes** that the draft lacked: variants and parent-child grouping, taxonomy mapping, a listing quality score, claims and banned-word rules, brand consistency rules, the brand-master-plus-channel-overlay model a distributor needs, and rejection learning.
4. **Added measurement designs and data** the study surfaced: country-split rollouts (change UAE, hold KSA), synthetic control as a cross-check, bought public market data as covariates (Actowiz, DataWeBot, Bright Data, 42Signals), and Amazon Manage Your Experiments as a calibration source.
5. **Named what we skip** and why: shopper try-on widgets, digital twins, 3D/CAD, ad-creative video, ad bid tools, price and stock sync, Google and Meta feeds, deep PIM features (master data, GDSN), and per-SKU approval workflows.
6. **Added a partner check.** Streamoid and Rubick are the nearest competitors (India plus some GCC). Demo them before we build text and listing files (M8, M9).
7. **Did not change the first slice.** Every P0 item is something nobody sells for GCC, except cleanup, which our own GPUs already do 5-25x cheaper.

## Modules ranked by business value

| Rank | Module | Why it is here | Depends on |
|---|---|---|---|
| 0 | M0 Catalog graph and change log | The only true foundation: nothing can be measured or learned without it; nothing exists today | none |
| 1 | M1 Intake and auto-decide | Removes the babysitting that blocks every batch today; immediate, exact value | M0 |
| 2 | M2 Analyze | One measured reading of each product and photo, shared by every acting module | M0 |
| 3 | M3 Images | The live tool's job, the eligibility blocker, and the first holdout's treatment | M0, M2 |
| 4 | M4 Measurement and experiments | Turns belief into evidence; readouts take 12 weeks, so it starts on day one | M0 |
| 5 | M5 Channel rules engine | 555 rules and 30 conflicts are silently picked in code; nobody sells GCC channel rules | none |
| 6 | M6 Cost, capacity and reliability | Cost ledger is about 60x low; deploys stop batches | none |
| 7 | M7 Quality gate and benchmark harness | Buying generation is unsafe without our own checks | M0 |
| 8 | M8 Text, attributes and Arabic | 97% of products have no usable text; cheapest content and closest to search | M0, M2, M5 |
| 9 | M9 Publish and monitor | Time to live and rejection reasons (38% covered today) | M0, M5 |
| 10 | M10 Learning engine | The product's core, but it needs one full wave of M4 data first | M4 |
| 11 | M11 Rich media | Gated by rights, channel acceptance and unproven lift | M3, M7 |
| 12 | M12 Admin, brands and self-serve | Business settings now; multi-tenant only when a second customer exists | all |

Independence rule: every module ships alone as long as it writes to and reads from M0 through one small contract (content version in, outcome join key out). No other dependency may block a module.

## The tree

### M0 Catalog graph and change log

**Why it exists.** No table today records which content was live on which channel and when, so no content change can ever be tied to sales. PIMs (product information managers: Salsify, Akeneo, Pimcore) keep versions, but none joins a version to marketplace sales. This module is that join.

| Feature | What it does (one line) | Market today | Buy / Build / Skip | Outcome metric | Priority | Intent ids |
|---|---|---|---|---|---|---|
| Product and listing graph | One record per SKU x channel with every channel key (zsku, partner SKU, barcode, ASIN) | All PIMs (Salsify, Akeneo, Pimcore, Plytix); none for GCC channel keys | Build (thin, not a PIM) | Share of live listings with a resolved key (baseline: keys for about 14,400 SKUs; 935 SKUs with no option id) | P0 | I004, I010, I024 |
| Content versions | Every image, title, bullet, attribute and chart stored as a version with role, source (brand, crop, upscaled, generated, vendor) and hash | Pimcore (praised), Salsify, Akeneo, Syndigo | Build | 100% of module outputs versioned | P0 | I004, I038 |
| Treatment log and live verification | Records what went live where and when, confirmed by channel fields and a public scrape | Nobody | Build | Share of published content verified live; days from publish to verified | P0 | I004, I024, I038 |
| Backfill of past outputs | Loads existing tool outputs and Supabase history as versions | n/a (internal) | Build | Share of historical outputs loaded | P0 | I020 |
| Daily export to BigQuery | `catalog_os.*` tables next to `fact_gcc` for joins | n/a (internal) | Build | Export freshness under 24 h | P0 | I004, I024 |
| Change reasons | Records why each change was made (rule, experiment arm, operator, learning engine) | PIM audit logs record who, not why | Build | Share of changes with a reason (baseline for not-live reasons: 38%) | P1 | I014, I038 |
| Variants and size runs | Parent-child grouping (style, colour, size) in each channel's form, such as Noon's Parent Group Key | All PIMs; Noon native | Build (inside the graph) | Listings with broken parent-child groups | P1 | I037 |
| Brand master and channel overlay | One brand master record, per-channel overrides, and which fields the brand owns versus Opptra | Nobody (PIMs assume the brand is the user, not a distributor) | Build | Channel content that differs from master without a recorded reason | P1 | I026, I037 |

### M1 Intake and auto-decide

**Why it exists.** Today the operator babysits every batch: 82 of 200 products needed attention, one batch left 308 to review, an xlsx upload crashed the wizard and 13 drafts were stranded in a week. The goal is "upload and walk away". Competitors that generate content still ask a person to accept each item (Amazon Enhance My Listing, CommerceIQ, Botika's review layer); nobody auto-decides.

| Feature | What it does (one line) | Market today | Buy / Build / Skip | Outcome metric | Priority | Intent ids |
|---|---|---|---|---|---|---|
| Any-shape upload | Folders, several folders, xlsx, csv, Google Sheet, pasted links or Supabase folders, grouped by product with no questions | Bulk import is table stakes (every PIM, feed tool and marketplace) | Keep and build | Real batches reaching processing with no operator answer (baseline: xlsx crashes step 2) | P0 | I008, I023, I030 |
| Self-advancing wizard | No Next or confirm; defaults from brand history; sheet-sharing email shown before paste | Table stakes UX; not a differentiator | Build | Clicks after upload (target 0) | P0 | I008, I009, I031 |
| Auto-decide with provisional links | Imperfect products get their best set now and an improved set later; nothing is held back | Nobody (all ask for per-item acceptance) | Build | Products with links at finish (target 100%; baseline 323 held outputs per 200 products) | P0 | I014, I017, I032, I033 |
| One digest, not cards | A batch of 2,000 SKUs gives one summary with counts, reasons and an exceptions sheet | Nobody; PIMs show approval queues | Build | Per-product attention items shown (target 0) | P0 | I017 |
| Resumable drafts and safe re-runs | A batch can be reopened, re-run or extended without duplicates | Table stakes | Build | Orphaned drafts (target 0) | P0 | I015, I023 |
| Already-live products on request | Any live product or list re-processed through the same path (old initiative 6) | n/a | Build | Same as above | P1 | I008, I037 |
| Product from photos or a web page | Starts a product from photos or a brand page when no sheet exists | Amazon native, Vue.ai, Rubick | Buy vision model, build | Products created without a sheet | P2 | I023, I037 |

### M2 Analyze (new: split out of Images)

**Why it exists.** Every acting module needs the same facts first: what the product is, what each photo shows, and what each channel still needs. Keeping analysis apart from acting (I022) means one analyzer, measured once per attribute, feeds images, text and the quality gate. Attribute tagging is sold by Vue.ai, Rubick, Streamoid and Amazon, but nobody publishes per-attribute accuracy, and vision models score about 64% on free-form attributes, so the scope stays narrow.

| Feature | What it does (one line) | Market today | Buy / Build / Skip | Outcome metric | Priority | Intent ids |
|---|---|---|---|---|---|---|
| Decision-grade image analyzer | Reads only what a decision needs: product type, shot role, framing, head cut, background, pixel size, text overlay, kids present | Vue.ai, Rubick, Streamoid tag attributes; Photoroom scores cut-out confidence; none measured per attribute in public | Buy vision model, build measurement | Per-attribute accuracy on the golden set | P0 | I018, I022 |
| Gap report per product x channel | Lists what each channel still needs (shots now; text and attributes later) and feeds the digest | Rubick CAST (60+ checks), Salsify and Syndigo for US retailers; nobody for GCC | Build | Gaps found versus a human check on the golden set | P0 | I017, I022 |
| Product facts from photos and sheets | Attributes with a source and a trust state (old initiative 8, narrowed to what listing files need) | Vue.ai, Rubick, Streamoid, Akeneo, Amazon | Buy vision model, build schema | Per-attribute accuracy on the golden set | P1 | I018, I037 |
| Category and taxonomy mapping | Maps each product to each channel's category tree, colour and pattern lists | Akeneo, Channable, Salsify, Amazon product types; nobody for Namshi, Noon, Styli | Buy classifier, build mapping tables | Share auto-mapped correctly | P1 | I021, I037 |
| Listing quality score per marketplace | One score per listing per channel from our rules, later weighted by measured lift | Rubick, Syndigo, Profitero, DataWeave (generic or US); none per GCC channel or tied to lift | Build | Score versus units; share of listings above threshold | P1 | I024, I028 |
| Web research for missing attributes | Looks up missing values on the live web and proposes them with a source | Akeneo (July 2026) | Buy | Attributes filled with a source | P2 | I037 |
| Market and category census | Brands, categories, product types and gallery norms on Namshi, Noon and Amazon.ae from public data | Actowiz, DataWeBot (data); 42Signals (Noon tracking) | Buy data | Taxonomy coverage | P2 | I019 |

### M3 Images

**Why it exists.** 98% of audited apparel lacks the five-shot set Styli and Centrepoint require and 28% of hero photos are under 1,000 px. Images are the first holdout's treatment. Generation is crowded and cheap, so we buy it; our own GPUs already do cleanup 5-25x below vendors; rule-bound crops for each channel's shot set are something nobody sells.

| Feature | What it does (one line) | Market today | Buy / Build / Skip | Outcome metric | Priority | Intent ids |
|---|---|---|---|---|---|---|
| Crops that complete the set | Rule-bound crops of the brand's own photos fill missing roles (head-and-shoulders is missing on 57 of 66 apparel products) | Nobody for channel shot sets; generic tools only resize | Keep (spec 12) | Apparel meeting the five-shot rule (baseline 2%, target above 80%) | P0 | I011 |
| Background removal and upscaling | Own GPU services (USD 0.0018 per matte, 0.0039 per enlargement) | Photoroom (USD 0.02), Claid, Pixelcut, Pixelbin | Keep own; vendors as overflow | Cost per image; defect rate on the regression set | P0 | I002, I003, I025 |
| Channel renders from rules | Canvas, margins, background and format per channel from M5, not code constants | Generic resize (Photoroom, Pixelcut); nobody for Noon or Namshi rules | Keep and build | Pass rate per channel rule (baseline: Amazon main image 69%) | P0 | I021 |
| Image set policy per channel x category | Which roles, in what order, how many; stored as data in M5 | Nobody | Build | Listings meeting the policy | P0 | I021, I037 |
| Generated missing shots (mode A) | A missing apparel shot made from the brand's own model photos, only where no crop can fill it | Photoroom, Claid, Botika, Caimera, Modelia; Google and Amazon free tools | Buy (two ranked vendors plus fallback; pay-per-pass where offered) | Fidelity pass rate; cost per generated image | P1 | I002, I003 |
| AI-image source flag | Marks generated images per channel so disclosure rules can be met and effects split | Google labels AI images; nobody per marketplace | Build (a field in M0) | Generated images without a flag (target 0) | P1 | I014 |
| Ghost mannequin and flat-lay to on-model | Turns mannequin or flat photos into on-model shots | Photoroom Plus, Claid, Botika, Streamoid, Caimera | Buy | Fidelity pass rate; acceptance | P2 | I002 |
| Try-on and model swap | Puts the garment on a licensed model | FASHN (no charge for failures), ZMO, Photoroom, Google | Buy, gated by rights | Fidelity pass rate; rights on file | P2 | I002 |
| Colour variants from one shot | Makes other colourways from one photo | Salsify, Photoroom colour replace | Buy | Colour match on the golden set | Later | I002 |
| Shopper try-on widget | Lets shoppers try clothes on themselves | Veesual, Revery, Google try-on | Skip: the channel owns the shopper page, not us | - | - | - |
| Digital twins and 3D/CAD | Brand model twins or images from garment CAD files | H&M (in-house), Lalaland/Browzwear | Skip: needs brand programmes and rights we do not have | - | - | - |

### M4 Measurement and experiments

**Why it exists.** Nobody in the market measures whether a content change caused sales on marketplaces without built-in testing. Only Amazon's Manage Your Experiments (MYE) randomizes, and only on Amazon with Brand Registry. Digital shelf tools (Profitero, CommerceIQ, Stackline) show correlation dashboards. Readouts take 12 weeks, so this starts on day one.

| Feature | What it does (one line) | Market today | Buy / Build / Skip | Outcome metric | Priority | Intent ids |
|---|---|---|---|---|---|---|
| Outcome data layer | Option x channel-country x week panel of units, revenue, ads, stock days, price, discount and promotions from BigQuery | Digital shelf tools use their own scraped data; none use the seller's own sales | Build on BigQuery (keep pipelines) | Panel freshness; covariate coverage | P0 | I004, I024, I045 |
| Randomized holdout | Picks eligible options, makes matched pairs, assigns half to treatment, freezes it, flags controls "do not touch" in M0 | Amazon MYE only; nobody on Noon or Namshi | Build | Pool size (about 1,400 apparel options on Namshi plus Noon) | P0 | I004 |
| Experiment registry and pre-registration | Every experiment registered with its smallest detectable lift (MDE) before launch; readouts at fixed dates | Nobody | Build | Experiments without pre-registration (target 0) | P0 | I004, I028 |
| Guardrails | Ads and merchandising teams blind to arms; event calendar (White Friday, 11.11, Ramadan) | Nobody | Process plus build | Contamination incidents | P0 | I004 |
| Estimators | Standard open-source models (ANCOVA, Poisson with fixed effects, staggered difference-in-differences) plus synthetic control as a cross-check; needed by week 8 | Nobody publishes a method; CausalImpact-style tools are open source | Build with open-source libraries | MDE about 18% at 12 weeks; placebo tests pass | P1 | I004, I013, I038 |
| Country-split and staggered designs | Change the UAE listing and hold KSA, or roll out in waves, when option-level pairs are too few | Nobody (suggested by the study) | Build | Extra experiments run per quarter | P1 | I004, I038 |
| Faster secondary signals | Ad click rate for main-image changes, ad conversion, returns share, Noon conversion once its traffic feed is restored | Ad tools (Pacvue, Perpetua, CommerceIQ) report ad metrics, not content effects | Build | MDE per signal (ad click rate 30-45%) | P1 | I004 |
| Outcome dashboard per channel | Organic units and conversion per channel over time, with experiment readouts | Digital shelf dashboards (correlation only) | Build | Dashboard live per channel | P1 | I024 |
| Public market covariates | Competitor price, our search rank and review growth as a traffic stand-in | 42Signals (Noon), Actowiz, DataWeBot, Bright Data (Amazon) | Buy data (about USD 1,200-1,500 a month for 5,000 SKUs, judgement) | Covariate coverage; MDE change | P2 | I004, I045 |
| Calibration against Amazon MYE | Where Brand Registry exists on Amazon.ae, run MYE as ground truth for our models | Amazon only | Use the free Amazon tool | Gap between our estimate and MYE | Later | I004 |

### M5 Channel rules engine

**Why it exists.** The playbook and channel specs hold 555 rules with 30 conflicts, silently picked in code, and no admin can change them. Feed tools have rules engines (Feedonomics, Channable, Rithum) and Amazon has product-type schemas, but nobody covers Noon, Namshi, Styli or Centrepoint, and Arabic has no rules anywhere. This is a differentiator.

| Feature | What it does (one line) | Market today | Buy / Build / Skip | Outcome metric | Priority | Intent ids |
|---|---|---|---|---|---|---|
| Rules as data | The 555 rules with channel, market, category, component, operator, severity, evidence grade and source | Feed tools for Western channels; Amazon product types; nobody for GCC fashion | Build | Rules loaded; share with documented evidence (baseline 35%) | P0 | I021, I041 |
| Conflict register | The 30 conflicts with options and an owner decision; C10 now, C02 and C27 before text | Nobody | Build | Open high-severity conflicts | P0 | I021, I041 |
| Admin rule editor | Non-technical editing of limits, shot lists, backgrounds and banned words, with history | Channable rules builder (EU channels) | Build | Next batch follows an admin edit; edits by non-engineers | P0 | I021 |
| Rule checks in pipelines | Every module checks the table; hard rules block or warn by evidence grade, judgement rules go to M7 | Rubick CAST, Salsify, Amazon pre-validation | Build | Rule violations reaching a channel | P0 | I021, I023 |
| Channel gaps workflow | Tracks asks to channel managers where rules are missing (six channels have none) | Nobody | Process plus build | Channels with zero content rules (baseline 6) | P1 | I041 |
| Claims and banned words | Approved claims, disclaimers and banned words per brand and channel | Jasper Product IQ, Rubick (partial) | Build | Banned words reaching a channel (target 0) | P1 | I021 |
| Brand consistency rules | One brand looks and reads the same on every channel (logo, tone, colour, framing) | Photoroom (visual only); nobody across many brands for a distributor | Build | Brand rule violations per 1,000 listings | P1 | I021, I026 |
| Arabic and right-to-left rules | Rules for Arabic text, mixed Arabic and English titles, and right-to-left layouts | Nobody | Build | Channels with Arabic rules | P1 | I037, I041 |

### M6 Cost, capacity and reliability

**Why it exists.** The cost ledger shows USD 0.004 per product against USD 0.08-0.15 measured (about 60x low), a deploy takes 2.5 hours and stops batches, and reliability is a top intent. This is internal; vendors only help by charging per success (FASHN, Photoroom's Guarantee).

| Feature | What it does (one line) | Market today | Buy / Build / Skip | Outcome metric | Priority | Intent ids |
|---|---|---|---|---|---|---|
| True cost meter | Every attempt logged, reconciled daily with billable time and the billing export, idle shown as its own line | Nobody gives one cost across vendors and own GPUs | Build | Gap to billing (baseline about 60x; target within 10%) | P0 | I025, I046 |
| Batches survive deploys | Revision-tagged gates, traffic shift, worker drain, connection budget in `deploy.sh` | n/a (internal) | Build | Batches failed by a deploy (target 0) | P0 | I015, I036 |
| Batch success tracking | Batch success rate and incident count recorded for every batch | n/a (internal) | Build | Batches reaching "links ready" without a person (target 99%) | P0 | I015 |
| Idle control | Batch bursts so one warm GPU window covers many products; no CPU upscaler fallback by default | n/a (internal) | Build | Idle share of GPU seconds (baseline about 60%) | P1 | I025 |
| Retry and checkpoint as a rule | Every network and database call retried; long jobs save progress | n/a (internal) | Build | Repeat incidents of the same kind | P1 | I015 |
| Quota and machine sizes | The quota asks in the cost report (memory, RTX and L4 GPUs, vCPU, instances) | n/a | Process | Throughput at 2,000 SKUs per hour | P1 | I034 |
| Separate load-test capacity | No load test on the shared stack while people use it | n/a | Process | Outages caused by tests (baseline 1) | P1 | I015 |
| Tiered tests | Fast checks first, full checks only when needed | n/a (internal) | Build | Typical change verified in under 15 minutes | P1 | I035 |

### M7 Quality gate and benchmark harness

**Why it exists.** Buying generation is only safe if we check what comes back. Photoroom's Fidelity Layer (August 2026) and Guarantee (pay only for images that pass, September 2026) are the only fidelity products, and they are enterprise-only and not per marketplace or brand. Our own checks also let us swap vendors when better models arrive (the Harvey Labs method: benchmark, route, then train).

| Feature | What it does (one line) | Market today | Buy / Build / Skip | Outcome metric | Priority | Intent ids |
|---|---|---|---|---|---|---|
| Golden sets | 300 products (240 GCC softline, 40 hardline, 20 India) labelled once by people; a real-photo regression set in CI | Nobody shares one for fashion marketplaces | Build (one-off labelling) | Label coverage; regression cases | P0 | I012, I018 |
| Vendor interface and fallbacks | One interface per capability, two ranked vendors plus a fallback, a kill-the-primary test | fal.ai-style model routers | Build | Batches completed with the primary killed | P0 | I002, I003 |
| Audit sampling | A 2-5% random audit after links are out; a category goes automatic after clean audits and relapses on failure | Nobody (vendors review every item or none) | Build | Audit fail rate per category | P0 | I014, I032 |
| Fidelity check | Checks generated images against the source for colour, logo, shape and print | Photoroom Fidelity Layer (enterprise); FASHN charges only for successes | Build our own; buy pay-per-pass contracts where offered | Product-truth defects reaching channels per 1,000 | P1 | I012, I014 |
| Planted-defect tests | Injects known defects (wrong colour, head cut, banned word, Arabic-English mismatch) and checks we catch them | Nobody | Build | Catch rate | P1 | I012 |
| Staged gate | Benchmark, then product tests, a sampled human check, then a live test through M4 | Nobody | Build | Time to promote a new vendor | P1 | I012, I016 |
| Vendor bake-offs | Each bought capability scored against two or more vendors before it serves | Nobody (vendors self-report) | Build | Capabilities with a scored buy decision | P1 | I002, I013 |
| Blocking human calls | Only modesty, kids and likeness-rights calls stop and go to a person | Botika (a person reviews every image) | Build | Blocking calls per 1,000 products | P1 | I014 |
| Bilingual consistency check | English and Arabic versions state the same facts | Nobody | Build | Mismatches reaching a channel | P1 | I037 |

### M8 Text, attributes and Arabic

**Why it exists.** 97% of products have no usable description and titles are often a few characters. Text is the cheapest content and closest to search. Generic English copy is free or cheap (Amazon gives it away; Describely about USD 0.75 a product), but nobody writes marketplace-native Arabic checked against channel rules; agencies (Proxima) do it by hand.

| Feature | What it does (one line) | Market today | Buy / Build / Skip | Outcome metric | Priority | Intent ids |
|---|---|---|---|---|---|---|
| Titles, bullets and descriptions per channel | Written to M5 limits from images, Trendyol text and brand sheets | Amazon (free, US first), Salsify, Akeneo, Jasper, Hypotenuse, Describely, Helium 10 | Buy language model, build rules and templates | Text completeness per channel (baseline about 3%) | P1 | I037 |
| Arabic and bilingual text | Arabic titles, bullets and descriptions with the right wording (formal versus Gulf), checked by rules | Nobody marketplace-native; translation in Akeneo, Channable, WISEPIM; Streamoid claims it; agencies by hand | Buy model, build rules and checks | Arabic completeness on Noon | P1 | I037 |
| Keywords from paid search terms | Titles and backend terms from Amazon Ads search terms and Noon product queries, the only keyword signal in the GCC | Helium 10, Jungle Scout (amazon.com data); nobody for Noon | Build | Top converting terms present in titles | P1 | I039 |
| Size charts | One stored unit (cm), shown per market, never mixed (C16) | Nobody across GCC and India channels | Build | Size charts rejected | P1 | I037 |
| Arabic keyword research | Arabic search terms from Noon queries and public search suggestions | Nobody | Build | Arabic terms tested | P2 | I039 |
| Hindi and regional text | Text for the India pilot channels | Nobody evidenced | Buy model, build rules | Completeness on India channels | Later | I042 |
| Answer-engine copy | Question-and-answer copy for AI shopping assistants | Salsify, Jasper | Buy | - | Later | I037 |
| Amazon keyword database | Large keyword volume database | Helium 10, Jungle Scout | Skip: Amazon GCC is about 140 softline units a week; buy access if needed | - | - | - |

### M9 Publish and monitor

**Why it exists.** No PIM or feed vendor pushes to Noon, Namshi, Styli or Centrepoint (Channable shows no Noon). Noon is sheet-based (up to 10,000 SKUs per sheet, about 3 business days of review) with no confirmed public catalog API. Rejections are handled by hand everywhere; only Salsify auto-fixes, and only for US retailer formats. 62% of not-live listings have no recorded reason.

| Feature | What it does (one line) | Market today | Buy / Build / Skip | Outcome metric | Priority | Intent ids |
|---|---|---|---|---|---|---|
| Live content watch | Scheduled public checks of our own galleries and titles on Namshi, Noon, Trendyol and Amazon; catches outside changes | 42Signals (Noon), Profitero, DataWeave for others | Build for our own listings (extends `listing_content_observation`) | Drift between graph and live page | P0 | I004 |
| Listing files per channel | Filled templates from the graph: Noon (English plus Arabic), Namshi, Styli, Centrepoint, later Myntra (old initiative 9) | EasyEcom (Myntra import), Streamoid (claims); nobody for Noon or Namshi | Build, after a Streamoid and Rubick demo | Files needing manual fixes | P1 | I037 |
| Liveness and rejection feedback | Keep `catalog-liveness-job`; connect Noon not-live (stale since 21 Aug), Namshi and Amazon reasons | Marketplace error reports only | Keep and build | Reason coverage of not-live listings (baseline 38%, target 90%) | P1 | I024 |
| Rejection learning | Maps each rejection to a cause, fixes it and adds a rule so it does not recur | Salsify auto-heal (US retailers, May 2026); nobody for marketplaces | Build | Repeat rejections | P1 | I017, I038 |
| Marketplace APIs where allowed | Trendyol public API first; Amazon by feed files | Rithum, Salsify, Feedonomics (Amazon); nobody for GCC | Build | Listings pushed without a portal session | P2 | I037, I045 |
| Re-enrichment after go-live | Live listings re-processed when a rule changes or a winner is found | Nobody (Vue.ai does not, per a competitor) | Build | Listings updated per rule change | P2 | I038 |
| Price and stock sync | Pushes price and stock to channels | Rithum, Linnworks, EasyEcom, Unicommerce | Skip: existing operations systems do this | - | - | - |
| Google and Meta feeds | Product feeds for ads and shopping | Feedonomics, Productsup, Channable | Skip: not Opptra's channels | - | - | - |

### M10 Learning engine

**Why it exists.** This is the product's core and the study's clearest gap: nobody learns per channel and category what content sells while controlling for price, ads, promotions, stock and season, and nobody carries a winner from one content type to another. CommerceIQ and Publicis claim parts of it without a published method. Opptra's many-brand sales data lets it learn what a single brand cannot.

| Feature | What it does (one line) | Market today | Buy / Build / Skip | Outcome metric | Priority | Intent ids |
|---|---|---|---|---|---|---|
| Change-type library | Every content change classified (role added, main image swapped, keyword added, Arabic added) so effects pool across SKUs | Nobody | Build | Share of changes classified | P1 | I038 |
| Budget and priority | Puts effort where revenue sits (top 10% of options earn 86%) and where measurement works (Namshi, Noon) | Nobody | Build | Revenue share covered by experiments | P1 | I028, I038 |
| Pooled estimates across brands | One model that shares strength across categories and brands; four waves take the MDE from about 14% to about 7% (judgement) | Nobody | Build | Standard error per change type | P2 | I038 |
| Cross-pollination | A winning search term updates the title, backend terms and infographic in one change set, logged as a new treatment | Nobody | Build | Winners propagated; lift of propagated changes | P2 | I039 |
| Recommendations to admins | What to stop and what to scale, with confidence bounds | CommerceIQ, Publicis (claims, unproven) | Build | Recommendations accepted | P2 | I028, I038 |

### M11 Rich media

**Why it exists.** Lifestyle scenes, faces, infographics, A+ and video are where vendors crowd, but for us they are gated: no brand rights are on file, Noon and Namshi acceptance of text overlays is unknown (C19), GCC Amazon is tiny, and lift is unproven. The one real gap is Arabic and right-to-left infographics and A+, which nobody offers.

| Feature | What it does (one line) | Market today | Buy / Build / Skip | Outcome metric | Priority | Intent ids |
|---|---|---|---|---|---|---|
| Infographics, Arabic and English | Photo plus text panel drawn by code, right-to-left for Arabic, where channels accept overlays | Rewarx, Phot.AI, Dresma, Helium 10 (English only); nobody in Arabic | Build | Acceptance rate; lift through M4 | P2 | I037, I039 |
| Lifestyle scenes for shoes and bags | Bought generation, no faces by default, brand rights on file | Photoroom, Claid, Pebblely, Booth, Flair | Buy | Pre-registered experiment per asset type | Later | I002, I037 |
| Brand faces and kids | Licensed face and body models, legal confirmation | Botika, Caimera, Modelia | Buy | Rights on file before any generation | Later | I014, I037 |
| A+ content | Amazon A+ modules (India first; GCC Amazon is small) | Amazon A+ AI drafting (free, US English); A+ generators | Buy | Pre-registered experiment | Later | I037 |
| Listing video | 15-30 second product video to channel spec | Photoroom, Caimera (image to video); nobody to marketplace spec | Buy | Pre-registered experiment | Later | I037 |
| Ad-creative and avatar video | UGC-style ad videos | Creatify, Arcads, Pencil | Skip: ad creative, not catalog | - | - | - |

### M12 Admin, brands and self-serve

**Why it exists.** Non-technical admins must run the business settings now (I021). Brands and agencies run themselves later (I026, I040). Enterprise PIMs (Salsify, Akeneo, Syndigo) offer deep governance at USD 45,000-250,000 a year, which is the wrong shape for us now.

| Feature | What it does (one line) | Market today | Buy / Build / Skip | Outcome metric | Priority | Intent ids |
|---|---|---|---|---|---|---|
| Settings surface | Channels, brands, vendors, thresholds, audit rates and experiment flags in one place | All PIMs | Build | Settings changed without engineers | P1 | I021 |
| Ops page | Cost, idle, throughput, incidents, audit results, experiment status | n/a (internal) | Build | Time to detect an incident | P1 | I015, I025 |
| Brand DNA | Logos, words, permissions, rights and approved models per brand | Photoroom brand kits; Jasper brand voice | Build | Brands with rights on file (baseline 0) | P1 | I014, I026 |
| Roles and permissions | Who may change what, per brand and channel | All enterprise PIMs | Build | Changes outside a role (target 0) | P2 | I021 |
| Multi-tenant and self-serve | Accounts, billing and isolation, built when a second customer exists | Photoroom, Pixelbin (self-serve); PIMs (sales-led) | Build later | External customers live | Later | I026, I040 |
| Onboarding hook | A brand's catalog run becomes the entry to Opptra distribution and marketing | Nobody | Build later | Brands converted | Later | I026, I040 |
| Agent and MCP access | Lets AI agents read and update the catalog | Salsify, Jasper, Akeneo | Build later | - | Later | I040 |
| Per-SKU approval workflow | A person approves each product before it goes live | Salsify, Akeneo, Rubick Flow, Amazon accept/reject | Skip: it is a per-SKU review queue, which I017 and I032 rule out; approvals apply to rule changes only | - | - | - |
| Master data and GDSN depth | Enterprise master data, GS1 data pools, retailer EDI | Syndigo, Stibo, Salsify | Skip: US and EU retail features we do not need | - | - | - |

## First slice (about one week, GCC fashion)

Scope is the thinnest end-to-end path an operator would feel, with measurement on from day one. All P0 features above are in it. Channel order: Namshi and Noon (money and measurement: 41,000 and 10,000 units per 12 weeks), Trendyol (the only channel where going live can be verified daily today), Styli and Centrepoint (eligibility rollout, measured on acceptance only), Amazon AE last (small, no seller API). The competitor study did not change this scope.

| # | Slice item (one worker, one worktree each) | Module | End-state acceptance test | Intents |
|---|---|---|---|---|
| S1 | Listing graph keys, content versions and treatment log (new tables, backfill of existing outputs, daily export to BigQuery) | M0 | Every link in a finished batch has a version row with role, source, hash, channel and publish time, visible in BigQuery the next day | I004, I020, I024, I038 |
| S2 | Provisional links and one digest, fed by the gap report | M1, M2 | A real batch finishes with links for 100% of products and one digest; zero required reviews outside the audit sample | I017, I032, I033 |
| S3 | Intake that never asks: xlsx crash fixed, drafts resume, multi-folder drop, email shown first, self-advancing steps | M1 | Drop three folders and one xlsx; the batch reaches processing with no Next or confirm and no stranded draft | I008, I009, I023, I030, I031 |
| S4 | Batches survive deploys (revision-tagged gates, traffic shift, drain, connection budget) and batch success tracking | M6 | A batch started during a deploy finishes cleanly; success rate recorded per batch | I015, I036 |
| S5 | True cost meter v1 (every attempt logged, daily reconciliation, idle line) | M6 | Cost per product within 10% of monitoring-derived spend; within 10% of billing once the export exists | I025, I046 |
| S6 | Rules as data for the five slice channels, conflict register, image set policy, admin edit of one rule | M5, M3 | An admin changes a channel image rule in the UI and the next batch follows it; C10 applied | I021, I041 |
| S7 | Holdout registration: candidate pool, matched pairs, frozen assignment, pre-period panel, control flag in M0, guardrails; Namshi and Noon gallery count by our own scrape | M4, M9 | Pre-registered experiment with its MDE in the registry; control options cannot be published to | I004, I045 |
| S8 | Golden set v1 labelled, analyzer scored per attribute, vendor interface with a second judge as fallback, audit sampling | M7, M2 | Per-attribute accuracy report on the 300-row set; killing the primary judge still completes a batch | I003, I012, I014, I018 |
| S9 | Operator proof run: a Vero Moda or French Connection apparel batch to links on the five channels, before and after numbers | all | Touches, time to first links, cost per product, five-shot compliance and batch success recorded before and after | I011, I015 |

Honesty notes: "about a week" means five to six workers in parallel on S1 to S8 and S9 at the end; measurement readouts come at 8 and 12 weeks. Publishing the treatment to Namshi and Noon is a bulk upload by the channel team in week one (no APIs exist for them); our scrape verifies it went live. Scraping stays in-house for our own roughly 1,400 options because buying a data feed would take longer than a week; bought market data waits for P2.

## What is cut from the old initiatives 01-09, and why

| Old initiative | Verdict | Why |
|---|---|---|
| 01 See the gaps | Keep the classifier as M2 Analyze; cut report mode, the "Needs me" tab and question cards | Per-product attention cards contradict "no babysitting" (I017); the study shows analysis is sold as its own product, which supports a separate module (I022) |
| 02 Crops | Keep as the core of M3; cut the per-product spot-check card and named reviewers | Replaced by sampled audit and automatic promotion per category (M7); nobody sells channel shot-set crops, so it stays ours |
| 03 Made photos mode A | Deferred to P1; buy, do not build the generator | The study confirms at least six vendors at cents per image; enters only where a crop cannot fill, after the fidelity check exists |
| 04 Scene images | Cut from the slice; M11 Later | No brand rights on file; value sits on footwear pages that already carry 7 images; five or more vendors sell scenes |
| 05 Brand faces | Cut from the slice; M11 Later | Licences, legal and kids risk; lowest evidence of value |
| 06 Already live on request | Folded into M1 as a path (P1) | Same pipeline, different entry |
| 07 Infographics | M11, P2, Arabic and English | Noon and Namshi overlay acceptance unknown (C19); needs M8 text first; Arabic infographics are a real gap nobody fills, so it moved from Later to P2 |
| 08 Product facts | M2 Analyze (P1), narrowed | Keep the source-and-trust schema; drop Confirm and Correct per product |
| 09 Listing files | M9 (P1), after a Streamoid and Rubick demo | Needs M8 text; nobody pushes to Noon or Namshi today, but the two nearest competitors should be checked before we build |
| All nine | Cut the shared "Needs me" and spot-check pattern | It is a per-SKU review queue by another name |

## Where I disagree with plan v3

1. **Channel order inside the slice.** Plan v3 lists Styli, Centrepoint, Noon, Namshi and Amazon AE together. The evidence says Namshi and Noon first (the money and the only pooled test possible), Trendyol for verification, Styli and Centrepoint as an eligibility rollout (under 100 units a week each), Amazon AE last (about 140 units a week, no seller API).
2. **Treatment definition.** Plan v3's outcome baseline suggests "generated 4th and 5th images". I recommend "complete the channel's shot set by crops first": the pool is the whole apparel set (98% lack the roles) instead of the under-5-image subset (which would halve the sample and push the MDE to 25-30%), with no rights, vendor or AI-disclosure risk. Source is logged per image so generated effects can be split later.
3. **Expectation.** Plan v3 says the first experiment "reports a lift, or no lift". The honest expectation is a bounded null (1-5% expected against an 18% MDE). Proof of return takes 12 weeks, not 4-10.
4. **Cross-pollination source.** Keyword winners cannot be found from organic sales at GCC volumes. The usable keyword signal is paid search-term data (Amazon Ads, Noon product queries). M8 and M10 are designed around that; the study found no keyword tool with Noon or Arabic data.
5. **Module two is text, not scenes or faces.** Plan v3's Phase 4 order (text, keywords, A+, video) is right; the old initiatives' order (scenes, made photos, faces) is wrong given 97% missing text, no rights on file, and a crowded vendor market for scenes and faces.
6. **Phase 0 asks.** Drop the Photoroom connector from the critical path: our own GPUs beat it for cutouts and upscaling. The study makes Photoroom a strong generation and fidelity vendor for P1 (its pay-for-pass Guarantee is worth negotiating), not a week-one dependency. Drop the GCC SP-API ask (not coming) and the Ads API ask (already live).
7. **"Zero-downtime deploys" in a week.** Scope it to "batches survive a deploy" (revision gate, traffic shift, drain). Full blue-green across GPU services is not a week-one item.
8. **Universal analyzer.** Plan v3 already narrows it; this map goes further: only attributes a decision needs, each with a measured accuracy, in its own module.
9. **Harvey item.** The video is Harvey Labs' talk, not SnapYT; the method is folded into M7's staged gate. Drop "find the real SnapYT video" from the critical path.
10. **Structure.** Plan v3 has eight modules. This map has thirteen (M0-M12) so that analysis (I022), cost and reliability, text, publish and monitor, rich media and admin each have their own owner contract and metric (I010, I028).

## Risks

| Risk | Effect | Mitigation |
|---|---|---|
| Namshi and Noon gallery counts and live state unknown without a scrape | Candidate selection and live verification fail | S7 includes our own scrape; fall back to Trendyol counts (3,628 options matched) |
| White Friday (late Nov) and Ramadan (about 8 Feb) inside the test window | Noisier readout | Start treatment 10-17 Nov with a concurrent control; readouts at 8 and 12 weeks, before Ramadan |
| Ads or merchandising teams change treated or control listings | Biased estimate | Blind arms or log every change; control flag in M0; live content watch catches outside edits |
| Noon "photographs only" rule and unknown AI-image stance | Rejections if generated images are used | Crops first; generated images only after a channel manager confirms |
| Shared `ila-pg` database with no connection budget | Outage during a batch or deploy | Budget enforced in `deploy.sh`; separate load-test capacity |
| Billing export and `ila-pg` read access not granted | Cost meter stays an estimate (about +-30%) | Monitoring-based reconciliation in the meantime |
| Golden set needs 300 human labels | M7 slips | One-off labelling task for the catalog team in week one; start with 100 |
| 65% of rules rest on the playbook alone; Namshi has no public rules | False blocks or rejections | Evidence grade on every rule; warn, not block, until a channel confirms |
| GPU quota (L4 at 3, RTX at 4 instances) | Throughput ceiling at scale | Quota asks filed; batch bursts to cut idle |
| 71% of options sell nothing; content cannot create demand | Disappointment if the readout is null | The brief sets the expectation; value also counted in touches, time and cost |
| Overfitting to our own benchmark | Offline wins that do not convert | Live readouts through M4 are the final gate |
| Streamoid or Rubick add Noon push and good Arabic | Our text and publish modules lose their edge | Demo both within two weeks; partner or buy where they are better |
| Scraping blocked or against terms; Saudi sites may need Saudi IP addresses | Live verification and covariates break | Scrape only our own listings at low rate now; legal review before market-scale scraping; bought data as fallback |
| Competitor facts are mostly vendor claims | Wrong buy or build calls | Bake-offs in M7 before any buy decision; verify vendor pages before contracts |

## Intents not yet covered

Every product intent now maps to at least one feature. These remain, with the reason:

- **Process and communication intents, not product features:** I005 (manager and delegator way of working), I006 (keep the intent ledger current), I007 (one-page briefs; met by `brief-v1.md` if Sujan approves it), I027 (ask only critical questions), I029 (live tool audit; first pass done, findings feed M1 and M6).
- **Planning intents met by this document once approved:** I043 (modules, then features, then requirements) and I044 (competitor study; three reports done, still open items listed in each report). I001 and I042 are already done.
- **Covered only in part, by choice:** I018 (a "universal" analyzer is narrowed to decision attributes in M2), I037 (A+ and video are Later in M11), I013 (open source is used for estimators and models, but no licence check of the chosen components exists yet; add it to the M7 bake-offs).
