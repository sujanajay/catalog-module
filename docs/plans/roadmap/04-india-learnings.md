# 04. India cataloging initiative: what GCC can borrow

Date: 2026-10-26. Program: Catalog Connect GCC roadmap proposal (agent D). Documents only; nothing is built.
Sources read in full: `catalog_initiative_india/Catalog v2.md`, `catalog_initiative_india/Opptra_Cataloging_Playbook.md`,
`catalog_initiative_india/mosaic-competitive-landscape.md` (all in the main checkout of catalog-module).
Context only: the GCC intent map (`docs/plans/2026-10-21-catalog-connect-gcc-intent-map.md`, sections 2 to 5),
DD9 business impact summary (`docs/plans/deep-dives/09-business-impact.md`), DD1a channel guidelines
(`docs/plans/deep-dives/01a-channel-guidelines-external-vs-internal.md`), and `C:\Users\Sujan Ajay\Desktop\catalog-service`
(the India listing studio, "Catalog OS V1") only where Catalog v2 names Cortina, which that repo uses as its sample brand.

Words used here:
- **IDQ**: Amazon's Item Data Quality score (0 to 100), a completeness score for a listing.
- **A+ content**: Amazon's extra brand content block below the bullets (banners, comparison charts).
- **TAT**: turnaround time, from brand submission to a listing ready to upload.
- **PIM**: product information management, a system of record for product facts.

## Summary

1. The three files are: an India program deck (Catalog v2, Cortina curtains on Amazon India as pilot), an internal 2025 catalog playbook that already covers Noon, Namshi, Trendyol and Amazon UAE, and a competitor study for "Mosaic", the India catalog product.
2. The playbook is the most useful file for GCC: it is Opptra's own internal source for channel limits, shot order, title and bullet formulas, attribute lists per category and QC checklists.
3. It also disagrees with GCC evidence in places (shot order vs Styli and Noon, Amazon image count, size units) and has no Arabic, modesty or GCC size rules, so it must be reconciled, not copied.
4. Catalog v2 gives a clean 5-stage operator workflow (intake, generate, format, QC, push, plus a monitor and feedback loop) and a KPI frame (discoverability, conversion, operator ease) that maps well onto B1 to B7a.
5. Catalog v2 also plans GCC channels (Amazon, Noon, Namshi) inside the India program. That overlaps the GCC catalog module and needs an ownership answer.
6. The India cost story (INR 1,000 per SKU in-house, target under INR 200) does not transfer: GCC already pays an agency INR 60 per style. GCC's lever is capacity and revenue (DD9), not unit cost.
7. Mosaic's positioning ("catalog intelligence, not an AI listing generator", closed-loop performance data as the moat) applies to GCC with the channel set swapped for Noon, Namshi, Styli and the Landmark channels, which global tools also ignore.
8. India pitfalls worth avoiding: no cost or volume baseline (asked for twice), build-vs-buy left "TBD" on every module, feedback loop scheduled last, and a "single front image" constraint that forced generation from one reference.
9. Borrow list: an IDQ-style per-channel completeness score, the intake schema with an escalation threshold, the image and content QA checklists as automated checks, the rejection-to-rule feedback loop, the competitor price anchors, and the playbook as a second internal spec source for DD1a gaps.
10. Questions for the owner are at the end; the most important are ownership of GCC channels in Catalog v2, which playbook values are authoritative, and whether GCC should adopt one completeness KPI.

## File by file

### Catalog v2.md (India program deck, 10 slides)

**Problem.** Cortina (curtains, Amazon India) has about 6,000 active SKUs, about 300 new SKUs a quarter, and the team makes 10 to 15 SKUs a day. IDQ is about 64% against a 90%+ benchmark. An urgent queue of 1,553 SKUs needs images and A+ (900 existing plus 653 incoming). The hard constraint: "For all 653 incoming SKUs, only a single front image exists per SKU - no lifestyle, infographic, or secondary angles. The full image suite must be generated from that one reference." (Catalog v2.md)

**Approach.** One operator workflow for the Opptra cataloguing team and, later, an external partner:
1. Intake: a schema of mandatory and optional attributes per category, collected through a one-to-one portal or a flat file.
2. Generation and enrichment: fill what is missing or weak, fed by brand memory, buying journey, competitor benchmarking, Q&A mining and review-failure mining.
3. Formatting: restructure to each marketplace's taxonomy, character limits and image specs.
4. QC: validate before upload, with brand-in-the-loop approval.
5. Push: upload to the marketplace.
Cross-cutting: "Marketplace rejections and IDQ drops feed back into intake and generation, so the same error is not repeated across SKUs." (Catalog v2.md)

**Metrics (slide 2 and 5).**

| Lens | Metric | Today | Target |
|---|---|---|---|
| Discoverability | IDQ | 64% | 90% |
| Conversion | Image + A+ coverage across the urgent queue | 50% | over 90% |
| Conversion | Conversion rate | 4.37% | not set |
| Operator ease | TAT per SKU | 40 to 60 min (brand team) | under 10 min, then under 2 min in the pilot slide |
| Operator ease | Cost per SKU | INR 1,000 | under INR 200 |
| Throughput | SKUs a day | 10 to 15 | 150+ |

**Problem list (slide 3).** Nine problems, each tagged with a stage and a lens: unstandardised intake (ad hoc Excel, missing mandatory fields), manual production, catalog debt on live SKUs, no structured keyword research, IDQ gap, no platform-specific adaptation, no automated upload, no status or SLA visibility, and "No feedback loop - errors repeat across SKUs". The deck stresses these were "Ground-truthed with the cataloguing team on Cortina - not a generic catalog problem list."

**Rollout.** Pilot builds: intake schema, AI image generation from a single reference, A+ generation, SEO copy (titles, bullets, keywords). Phase 2 adds Flipkart, Myntra and quick commerce, the feedback loop, and (slide 7 only) GCC channels Amazon, Noon and Namshi with dated targets. Slides 6 and 7 are near duplicates with different quick commerce dates. Brand by category grid: Cortina and BSB pilot on curtains and bedsheets; Bombay Dyeing P1; Miniso P1 all categories; Hamleys P2. Claimed onboarding: "New Brand addition: 1 day", "New Category addition: 2 day development + 2 days QC".

**Vendors and tools.** Slide 9 (build, buy or agency per module) is "TBD" in every cell; it says confirmed vendors and negotiated costs exist in a separate vendor summary that is not in the folder. "Build-vs-buy call still open on generation."

**Money.** Today INR 1,000 per SKU, 100 to 150 SKUs a month, INR 1.5 lakh a month, INR 18 lakh a year. Post-pilot figures are TBD: "Volume and total-spend data requested from the cataloguing team; not yet received. This is the second time it has been asked for." (Catalog v2.md)

**Org and roles.** Primary user is the Opptra cataloguing team; future user an external partner; the brand approves in QC. No named owners.

**Cross-reference with catalog-service.** catalog-service is the build behind this deck: its HLD ("Catalog OS V1") does Google sign-in per brand, flat file upload validated against category rules into a PIM, generation per SKU and marketplace with versioned outputs and regenerate, and listing template fill with AI for gaps. It has an inbound QC pipeline (`server/pipelines/inbound_qc/`) that cross-checks the flat file against photos, and hand-authored visual schemas for curtains and bedsheets built from Cortina sample data (`server/pipelines/generation/visual_schemas/curtains.json`). The intent map already rules that these are lifted as patterns, not imported as code.

### Opptra_Cataloging_Playbook.md (internal 2025 playbook)

**Problem and audience.** A shared standard so brand partners submit catalog-ready assets the first time, and catalog managers can validate and upload across 5 channels: Noon, Namshi, Trendyol, Amazon (India and UAE / Middle East) and Myntra.

**Process (8 steps).** Brand submission, asset validation, content review, spec mapping, platform mapping, QA check, upload and review, go live. SLAs: 48 hours standard apparel, 72 hours footwear and accessories, 24 hours priority, plus 24 hours per revision round and 48 hours for platform review. Escalate "if a brand submission is missing more than 30% of mandatory attributes." Submission is a zipped folder per SKU with images named by shot number (`01_HeroShot.jpg`), `content.xlsx` and `specs.xlsx`, through a shared drive with a submission form, cut-off 12:00 noon IST.

**Image standards.** An 8-slot shot sequence for tops, bottoms, footwear and activewear: Hero, Side, Infographic, Back, Full model (on-foot for footwear), Close-up, Size chart (always shot 7), optional video. Do and do not lists: white or light grey (RGB 240+), product fills 75 to 85%, minimum 1200x1800, on-model for adult apparel, distinct images per colour, no flat lay as hero, no promo text on image 1, no children modelling adult clothing.

**Content standards.** Title formula "[Brand] + [Gender] + [Key Feature / Material] + [Use Case / Occasion] + [Product Type]", 60 to 200 characters, main keyword in the first 60, no promotional words. "Always write to the shortest limit first, then expand for other platforms." 4 to 5 bullets in a fixed order (material, fit, feature, occasion, care), each one selling point, never repeating the product detail table. Description under 1,000 characters in five parts. Backend keywords: 8 to 10, not already in title or bullets, with synonyms and regional terms.

**Platform table (internal values).**

| | Noon | Namshi | Trendyol | Amazon | Myntra |
|---|---|---|---|---|---|
| Title | 150 | 200 | 100 | 150 | 90 (60 in the Myntra section) |
| Bullets | 5, 80 chars | 5, 80 chars | 5 to 7, 160 chars | 5, 100 to 250 chars | 5, 100 chars |
| Min / ideal res. | 1000x1000 / 2000x2000 | 1200x1500 / 2000x2500 | 600x800 / 1200x1800 | 1000x1000 / 2000x2000 | 1080x1440 / 1500x2000 |
| Ratio | 1:1 or 4:5 | 4:5 | 2:3 | 1:1 | 3:4 |
| Max images | 10 | 8 | 8 | 7 | 7 |
| Max file | 10 MB | 8 MB | 5 MB | 10 MB | 1 MB |

Noon and Namshi need a product detail table (composition %, fit, exact colour name, size range, care, country of origin, plus category extras). Trendyol "ranks keyword-dense descriptions higher". Amazon: pure white main image, product fills 85%, A+ for brand-registered sellers ("average conversion lift 5-10%"), search terms max 250 bytes.

**Category specs.** Attribute lists for footwear (29 fields), tops, bottoms, accessories, innerwear; size chart rules per category; a 14-row "common errors and fixes" table (mixed units, same measurements across sizes, wrong subcategory, unverified heel height, wrong material %).

**Vendors, competitors, metrics.** None named beyond the channels. No quality KPI is defined; SLAs are the only measure. Owner: "Opptra Catalog Management Team", catalog@opptra.com, "updated quarterly".

**Internal inconsistencies worth knowing.** The title formula in section 3 differs from takeaway 7 ("Brand + Gender + Product Type + Key Feature + Colour + Size"). Myntra title is 90 in the table and 60 in its section. Shot definitions say size charts in cm, while section 7 says "Apparel in inches only". "Minimum 1200x1800" (DOs) vs "1000x1000 px minimum" (takeaway 4).

### mosaic-competitive-landscape.md (competitor study for Mosaic)

**Problem.** Bad catalog data costs revenue, and Indian brands juggle 5 to 6 marketplaces with conflicting schemas and QC engines. Cited figures: Gartner "bad data may cost companies up to 25% of their potential revenue"; Amazon "on average, there is a 20% sales lift for Premium" A+ (standard up to 8%); Epinium "3-10% CVR lift for standard A+ content and 15-20% for A+ Premium on hero ASINs"; IDQ is "almost purely based on the quantity of your data" (leaf node, 5+ bullets, A+, 7+ images, reviews).

**Competitors and prices.**

| Bucket | Players | What they do / price | Gap for India |
|---|---|---|---|
| AI creative for Amazon | Listing Optimization AI | Main images, A+, infographics, A/B tests, direct Seller Central upload; about USD 0.16 per image | Amazon only, US-centric, no attribute data |
| Multichannel integration | ChannelEngine | 1,300+ channels, GMV-based pricing | Connectivity, not content |
| Global PIM / syndication | Akeneo, Salsify, Plytix, Syndigo, Feedonomics, Productsup, Linnworks | Product data and syndication | US/EU retailer networks, no India connectors |
| India inventory and order sync | Unicommerce, Vinculum, Browntape, Increff, EShopbox | Order, inventory, SKU mapping | Do not author content |
| India content and listing | UniSouk (INR 9,999 a year), PIMworks, Netcore Unbxd, QuickUp; DataWeave and CommerceIQ for content audits | Listing automation, AI PIM, content health scoring | Partial; audits diagnose but do not generate |
| Generic AI copy | Jasper (about USD 49 / 69 a seat), Copy.ai, Describely, Hypotenuse | Bulk descriptions with brand voice | Channel agnostic |
| Amazon's free tools | Brand Registry, A+ Manager, Brand Catalog Manager, Manage Your Experiments | Free | Amazon only; IDQ not exposed to most sellers |
| Agencies | Digital PR World, SyncVisory and others | INR 20 to 35 per SKU; retainers about INR 4,000 a month for 50 to 100 SKUs | Manual, inconsistent, no decay monitoring |

**Positioning and moat.** "In India, the scarce capability is not generation (commoditized) or sync (owned by Unicommerce/Increff) but marketplace-context quality optimization tied to performance." Moats: (1) data moat from Opptra's operations for 33+ brands, capturing which catalog changes moved conversion, ranking and QC pass rate; (2) workflow moat of encoded channel QC rules kept current; (3) network effects across brands.

**Recommendations.** Position as "catalog intelligence for India"; build the data moat first; prioritise marketplaces global tools ignore; sell with an audit or diagnostic wedge (content health score); price above agency per-SKU rates, consider outcome- or GMV-linked pricing; watch Salsify, Syndigo, Unicommerce, PIMworks and Netcore Unbxd quarterly.

**Caveats the file itself gives.** Many prices are quote-based; agency rates are self-reported; ListIQ is unverified; A+ lift figures are Amazon marketing benchmarks; Opptra's capabilities were inferred from public sources.

## Applies to GCC

### As is

- **The 5-stage workflow plus feedback loop** (Catalog v2). It matches the GCC module's existing path (identity, render, compliance, QA, publish) and the target shape in the intent map section 4. The intake stage is the piece GCC lacks today; B6 (fact sheet) is where it lands.
- **The problem list format**: each problem tagged with stage and lens, ground-truthed with the team. GCC's buckets B1 to B9 can carry the same two tags so the roadmap shows which lens each release moves.
- **"No feedback loop - errors repeat across SKUs"** as an explicit problem. GCC has the same risk with channel rejections (DD1a: Noon "Needs editing", "Incorrect sequencing").
- **Content QA checklist rules that are channel-neutral**: title starts with brand, no promotional words, 4 to 5 bullets each a unique point, bullets never repeat the detail table, backend keywords not repeated from the title, mandatory attributes filled, country of origin and care present.
- **Image QA checks that GCC already enforces or should**: no duplicate or near-identical images, distinct images per colour, no promo text on image 1, uniform background, product fill ratio.
- **Size chart error table** (mixed units, same values across sizes, wrong subcategory changes required fields, unverified heel height). This is directly useful for B7a, since DD9 finds size problems are 71% of Namshi returns with a reason.
- **Competitor map** for the global layer: Listing Optimization AI, ChannelEngine, Salsify, Akeneo, Jasper and Amazon's free tools have the same gaps in GCC as in India (no Noon, Namshi, Styli or Landmark depth).
- **"Generation is commoditized" framing**, which supports Nitin's "buy before build" line in the intent map.

### With changes

- **Channel limits and shot order.** The playbook is Opptra's own internal source for Noon, Namshi, Trendyol and Amazon UAE. It can partly answer DD1a owner question 3 (sources for internal values), but it conflicts with GCC evidence:
  - Shot order: playbook "Hero → Side → Infographic → Back → Full Model → Close-Up → Size Chart → Video" vs the Styli / Landmark studio email (front mid-thigh, full length, fabric close-up, back to hips, head and shoulders) and Noon's published "front, back, side, details" order where "Incorrect sequencing" is a named rejection (DD1a). GCC must keep a per-channel role order, not one universal order.
  - Amazon max images: playbook 7, DD1a 9. Namshi 4:5 at 1200x1500 in the playbook vs the repo's "Namshi = Noon rules". Noon "1:1 or 4:5" in the playbook vs Noon's own help page accepting any ratio of at least 0.5 (DD1a).
  - Infographic in slot 3 and size chart in slot 7: GCC channels have not confirmed they accept them (DD9: B5 value is "close to zero" unless Noon and Namshi confirm in writing).
  - Change: treat the playbook as a secondary internal source in DD1a, cite it per value, and let official channel pages and partner emails win.
- **Title and bullet formulas.** Usable, but GCC needs English and Arabic versions per channel (Noon, Namshi, Styli, Centrepoint templates take both). "Write to the shortest limit first" still holds; Arabic character counts and right-to-left rendering need their own check. The playbook has no Arabic rule at all.
- **Category attribute lists.** A good starting set for the B6 fact sheet, after removing India-only fields (MRP, HSN, BIS, INR size chart) and adding GCC fields (Arabic names, country of origin per GCC customs labelling, modest wear flags such as sleeve length and coverage where channels filter on them, GCC size systems).
- **Size charts.** India rules (apparel in inches, IN sizes) do not fit GCC listings, which mostly use EU / UK / US and cm. Keep the structure (garment plus body measurements, one row per size, verify against the physical sample), change the units and size systems per channel.
- **Model and modesty rules.** The playbook's "on-model images for all adult apparel" and "model fits brand-approved profile" apply, but GCC adds modesty expectations on some channels and categories (innerwear, swimwear, activewear), which the playbook does not mention. This matters for B3 (brand's real models) and the brand style profile in B9.
- **IDQ as a KPI.** IDQ exists for Amazon.ae and Amazon.sa, but Namshi and Noon carry about 95% of GCC softline revenue (DD9). Change: define a GCC per-channel completeness score with the same idea (required roles present, attributes filled, English and Arabic present, no open rejection) and track it per brand and channel.
- **Turnaround and SLA tracking.** The playbook's SLA table and Catalog v2's "no status visibility, no SLA tracking" problem apply; GCC should measure TAT from source photos available to channel-ready links, without adopting India's numbers.
- **Brand in the loop approval.** Applies, but GCC brands are mostly international brands distributed by Opptra (USPA, Vero Moda, Birkenstock); approvals may sit with Opptra's brand managers rather than the brand. Needs an owner decision.
- **Mosaic's moat.** Swap the India channel list for GCC: Namshi, Styli, Centrepoint, 6thStreet and VogaCloset publish no public image rules (DD1a), so encoded rule sets from partner emails and rejection history are an even stronger workflow moat in GCC. The data moat (before and after content change vs conversion and returns) matches DD9's recommendation of a controlled test per bucket.

## Borrow list

### Metrics and KPI definitions

| KPI | Definition to borrow | Source | GCC adaptation |
|---|---|---|---|
| Completeness score | Share of a listing's required elements present, per channel (IDQ idea: leaf node, 5+ bullets, A+, 7+ images) | Catalog v2, Mosaic | Per channel: required shot roles present (B1), mandatory attributes filled (B6), English and Arabic text present, no open rejection |
| Image + content coverage of a queue | Share of SKUs in a named priority queue that have the full image set and rich content | Catalog v2 | Share of style-colours with the channel's required role set, by brand and channel |
| Throughput | SKUs finished a day | Catalog v2 | Channel-ready images or style-colours a period, against DD9's manual baseline of about 1,300 images a year |
| TAT per SKU | Minutes from submission to ready | Catalog v2, playbook SLAs | From source photos received to links sheet ready, plus revision rounds |
| Cost per SKU and monthly total | Unit rate and total, today vs after, annualised delta | Catalog v2 slide 10 | Agency INR 60 per style vs module run cost (DD9 section 6); report totals, not just unit rates, as slide 10 insists |
| Rejection rate and repeat rate | Marketplace rejections that feed back; the same error repeating across SKUs | Catalog v2 | Per channel rejection reasons (Noon's named list) and how often a reason recurs after a fix |
| Escalation threshold | Escalate a submission missing more than 30% of mandatory attributes | Playbook | Same rule at intake for the B6 fact sheet |
| Content health | A score from audit, before and after (DataWeave "51% to 76%") | Mosaic | Use the completeness score as the before and after measure in DD9's controlled tests |

### Process steps

- **Intake**: a category schema of mandatory and optional attributes; one flat file template; a zipped folder per SKU with images named by shot slot; a submission form per batch; escalation above 30% missing (playbook, Catalog v2). For GCC this is the input side of B6.
- **Validation at intake**: catalog-service's inbound QC idea (cross-check flat file values against photos) as a pattern for B6, consistent with the intent map rule of lifting patterns, not code.
- **QC**: the playbook's image and content QA checklists, turned into automated checks where a rule is deterministic (counts, ratios, resolution, file size, title length, banned words, bullet count, duplicate text between bullets and the detail table) and into judge checks where it is not (colour matches description, details visible).
- **Approval**: brand-in-the-loop approval before push (Catalog v2), with revision rounds counted (playbook "+24 hours per round" as the unit, not the number).
- **Feedback**: rejections and score drops feed back into intake and generation rules so the same error is not repeated (Catalog v2). GCC equivalent: a rejection reason list per channel mapped to the check that should have caught it.
- **Onboarding**: Catalog v2's claim that a new brand or category is a configuration step matches B9 (brand style profile, no code per brand). Borrow the idea of a separate QC step for each new category.

### Vendor and tool choices and prices

| Item | Price or fact | Use for GCC |
|---|---|---|
| Listing Optimization AI | About USD 0.16 per image; Amazon only | Price floor for generated images; benchmark in B2 / B3 bake-offs |
| Jasper | About USD 49 / 69 a seat a month | Price anchor for generic copy; not a fit for channel templates |
| UniSouk | INR 9,999 a year | Low-end listing automation anchor |
| India agencies | INR 20 to 35 per SKU; INR 1,000 + GST per portal up to 50 SKUs then INR 20 | Compare with GCC's INR 60 per style; GCC's agency also covers Arabic and template fill |
| Amazon A+ Manager | Standard free; Premium after 5 approved standard A+ in 12 months | Applies to Amazon.ae / .sa only |
| Catalog v2 vendor summary | "Tools and agencies already confirmed, with negotiated costing per vendor" | Not in the folder; ask for it before any GCC buy decision |

### Competitor positioning

- Position the GCC module as channel-context catalog quality for Noon, Namshi, Styli and the Landmark channels, tied to performance, not as an image generator (Mosaic recommendation 1, translated).
- Use an audit as the wedge: a per-brand completeness report across the 9 channels before any generation (Mosaic recommendation 4; matches V1 = B1 "or a precise reason why not").
- Watch list: Listing Optimization AI (creative layer, already claims Amazon India), ChannelEngine (covers Middle East connectivity), Salsify / Syndigo, and any GCC-local listing service the agency uses.

### Pitfalls the India team hit

- **No baseline data.** Cost and volume totals were "requested ... not yet received. This is the second time." GCC has the same gap (the INR 60 split between images and templates is unknown, DD5 owner question 6). Get the agency invoice before claiming savings.
- **Build vs buy left open on every module.** GCC should record the decision per bucket with the named vendor and price, as slide 9 intended.
- **Feedback loop scheduled after channel expansion.** Catalog v2 puts feedback looping in Phase 2. GCC should log rejection reasons from the first release (B1), since they are cheap to capture and are the data moat.
- **Single front image constraint** forced "the full image suite must be generated from that one reference". GCC's B2 avoids this by deriving crops first and generating second; keep that order.
- **Duplicate and conflicting slides** (slides 6 and 7) and internal playbook contradictions (title formula, size units, Myntra title limit). GCC docs should keep one source of truth per rule, which SPEC.md already does.
- **Universal shot order** in the playbook would fail Noon's sequencing rule and Styli's role list. Per-channel role lists are required.

## Does not apply

- **Flipkart, Myntra and quick commerce rules** (Flipkart red / yellow / green QC, Myntra studio onboarding and commissions, Blinkit and Zepto pack-size economics and listing fees): not GCC channels.
- **India compliance fields**: MRP, HSN codes, BIS certificate for footwear, GST mismatch rules, FSSAI, INR-based size charts. GCC has its own customs, VAT and labelling rules, which are not in these files.
- **Cost per SKU as the headline lever.** India starts at INR 1,000 per SKU; GCC pays INR 60 per style, so DD9 finds cash savings of about USD 2k a year. The GCC case rests on capacity and revenue, not unit cost.
- **Cortina's categories** (curtains, bedsheets) and the Miniso / Hamleys / Hasbro rollout: home and toys, outside GCC softline scope.
- **A+ content as a main conversion lever.** Amazon-only; Namshi and Noon carry about 95% of GCC softline revenue (DD9).
- **Backend keyword rules as written** (Amazon 250 bytes, India regional terms): GCC needs Arabic and Gulf English synonyms, and whether Noon, Namshi and Styli expose backend keyword fields is not shown in these files.
- **Mosaic's SaaS pricing advice** (outcome- or GMV-linked pricing for a spin-off): GCC's module is an internal tool for Opptra's own brands; pricing is out of scope.
- **"Submit by 12:00 noon IST"** and similar India operating details.
- **The playbook's "Children modelling adult clothing" and video slot** apply in principle but are not current GCC gaps; no change suggested.

## Questions

1. **Ownership.** Catalog v2 slide 7 lists GCC channels (Amazon, Noon, Namshi) with dated targets inside the India program. Does the India team (catalog-service) plan to build GCC listing fill, and how does that relate to the intent map rule "One platform: the catalog module"? Who owns B6 for GCC?
2. **Authoritative channel values.** Where the playbook and GCC evidence disagree (Amazon 7 vs 9 images, Namshi 4:5 at 1200x1500 vs "= Noon rules", Noon 1:1 / 4:5 vs any ratio of at least 0.5, universal shot order vs Styli and Noon orders), which wins? Can the playbook's source for Namshi and Trendyol values be shared so DD1a can cite it?
3. **Infographics and size chart slots.** The playbook makes an infographic (slot 3) and a size chart (slot 7) mandatory. Do Noon, Namshi, Styli and Centrepoint accept them as gallery images? This decides B5's value (DD9).
4. **One completeness KPI.** Should GCC adopt one per-channel completeness score (roles, attributes, Arabic, rejections) as the roadmap's headline metric, in place of IDQ?
5. **Baselines.** Can the agency invoice or contract be shared to split INR 60 between images and templates, and to count throughput and TAT today? India stalled on exactly this.
6. **Vendor summary.** Catalog v2 says confirmed tools and negotiated vendor costs exist. Can GCC see that list before any buy decision in B2 to B5?
7. **Arabic and modesty.** The playbook has no Arabic or modesty rules. Is there an internal GCC equivalent of the playbook (Arabic title and bullet rules, modest wear rules per channel), or should one be written from DD1a and partner emails?
8. **Size systems.** Which size systems and units do the GCC templates require per channel (EU / UK / US, cm vs inches), given the playbook's India rules?
9. **Approval.** For distributed international brands, who is "the brand" in brand-in-the-loop approval: the brand owner or Opptra's brand manager?
10. **Shared rule sets.** Mosaic's network-effect moat assumes one rule and attribute library across brands and countries. Should India and GCC share an attribute and QC library (patterns only), or stay separate?
11. **Feedback capture.** Is there any record today of Noon, Namshi or Styli rejections (reasons, counts) that could seed the feedback loop from the first release?

Status: done
