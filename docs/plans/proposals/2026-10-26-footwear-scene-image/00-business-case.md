# One scene image per footwear and bag style-colour - business case

Date: 2026-10-26. Business-approval document for Nitin, leadership, and brand and channel managers. Documents only:
nothing was built, no paid call was made and no query was run for this file. It treats 6.1b (US Polo lifestyle), 6.1a
(other brands lifestyle) and 6.2 (composite still life) as **one initiative**: one build, one set of checks, one
rollout. Every number carries a pointer `[code Lnn]`; the codes are listed in section 13. Revenue figures are copied
from P08 only, except one labelled note in section 8. There are no time, duration or effort figures (owner rule,
[P08 L7-9]). The rules are set by the implementation spec `docs/specs/13-footwear-scene-image.md` (S13). Where this
document and S13 differ, S13 wins; its section 12.4 lists the values used here. S13 builds on spec 12, the apparel
shot set (`docs/specs/12-apparel-shot-set.md`), for the generator connection, the checks, the review card and the photo roles.

## 1. Bottom line

1. **What:** every adult footwear and bag style-colour without a real scene photo gets one scene image, always the last image, never image 1, with no face. Kids and thin photo sets get a still life of the brand's own pixels.
2. **Why:** US Polo, the brand that earns about 5.9M of 9.2M USD softline revenue, has no scene on 19 of 20 sampled shoe pages; 55,280 USD of its ads land on packshot-only pages [P08 L343]. Judged base 59.8k USD a year [P08 L333].
3. **Cost:** about 0.20 USD per accepted image. **161.40 USD once** for the 807 live and stocked style-colours that need one, against 4.8k to 7.7k USD at agency prices (section 6) [INV L17-18, L263-268; S13 12.4 item 7].
4. **Buy vs build:** we buy the image generator as a swappable engine and keep the checks, channel rules and records, which no vendor sells [BvB L18-21].
5. **How:** a sampled test run on every footwear and bag brand at once, under full review. The business reads one scorecard per brand and sets the publish order. US Polo is the technical test brand, not a gate.

**Words used here (defined once).**
- **Style-colour:** one design in one colour, for example one sneaker in navy. One scene image is made per style-colour, never per size [DD4 L18].
- **Packshot:** the brand's plain studio photo of the product on white or light grey.
- **Scene image:** the product shown in a real-looking place. Two kinds: a **worn shot** (legs only, or the bag carried, with no face) and a **still life** (the product alone in a scene, no person) [DD4 L15-17].
- **Full generation:** a paid image service (the **generator**) draws the whole picture, product included, from 3 to 4 of the brand's packshots [DD4 L20].
- **Composite:** the brand's own product, cut out of its packshot, placed into a scene the generator draws. **Paste-back** is the last step: code writes the real cut-out back over the drawn scene, so every product pixel is the brand's original [S13 0.2; DD4 L19].
- **Frame:** the one picture made per style-colour, 1792 x 2400 pixels (called "2K") in a 3:4 portrait shape. Code cuts it to each marketplace's shape [S13 0.2].
- **Batch:** one upload of a brand's photos that the module processes together, for the marketplaces the operator ticks [OPG L9-14].
- **Gate:** the automatic checks plus a person's review that a generated image did not change the product [P08 L27-28]. **Review-all:** a person sees every generated image before it publishes [P08 L28].
- **False pass:** the checks let an image through that a person rejects. **False hold:** the checks stop an image a person would publish. **Planted defect:** a known fault put into a test image on purpose, to prove the checks catch it [DD2 L155].
- **SPEC:** `docs/SPEC.md`, the rule book of what the catalog module may do. Only the owner can amend it [P08 L24-26].
- **Holdout:** treat half of a matched set of products, leave the other half, compare conversion [P08 L29].
- **Judged:** an assumption, not a measurement.

## 2. The problem, as a shopper and a marketplace see it

**What the shopper sees.** A US Polo shoe page shows the shoe on white from the side, then pair, top, back and sole.
Nothing shows how the shoe looks worn or where it belongs. 19 of 20 sampled US Polo shoe sets have no scene, Keds 0 of
7 have one, Campus 4 of 15 lack one [M06 L147, L189]. Across 48 sampled live Trendyol sets, only 1 shows a real-world
scene [DD4 L87-89].

**What brands send and do not send.**
- Footwear usually arrives with "five images, four images" [MT L117]. Measured averages per style-colour on Trendyol: US Polo 5.95, Campus 7.09, Keds 7.7, Puma 6.5, French Connection bags 7.51, Vero Moda bags 2.0 [INV L124-125].
- Real lifestyle photos are "Generally ... not there. 99%"; for kids and Campus they sometimes arrive later [MT L143].
- Some brands do send worn or carried studio photos: Puma 5 of 8 sampled sets (1 real scene, 4 worn), French Connection bags 7 of 8, Vero Moda bags 4 of 8. Every sampled Campus set has a styled studio set with props but no person [DD4 L79-87].
- Naz also mentioned 2,700 US Polo options with only three images [MT L117]. She said it while talking about apparel and five-image sets; our warehouse holds only US Polo footwear (529 style-colours) [DD8 L65], so the 2,700 is not part of this count.
- In the meeting, Naz asked for three extra images for footwear and bags: a model shot, a lifestyle shot and an infographic. She called the lifestyle shot "more catchy" [MT L121-133]. This document covers the scene image only. Infographics are a separate line (6.3 to 6.5) [P08 L339-341].

**What Naz makes by hand today.** She uses a chat image tool, one prompt per image, and is limited to 5 or 6 images a
day [MT L166]. There is no check on the product and no record of what was made or where it went [P08 L345; DD4 L209].
The 807 style-colours that need an image (section 6) are well over half of a year of that manual route (about 1,300
images a year [DD9 L192]).

**What a scene image does and does not do.**
- Adults: a worn shot (legs only) or a carried bag shot, in a scene chosen by the shoe or bag type. Example: a sneaker worn while seated on a concrete ledge in a plaza [DD4 L112].
- A still life of the real product, never a generated child, for: kids; products whose audience is unknown (treated as kids); bags with fewer than 3 views; embellished, transparent or mirror-like products [S13 2.3].
- Never a face. Never image 1. Always the last image [S13 0.1, 7.1].
- It does not replace any brand photo and does not change the order of the brand's photos.

**Which channels allow it.** Noon allows lifestyle only as an additional image: "Lifestyle images are not permitted for
the primary images" [DD4 L138]. Amazon allows it as an alternate, never as the main image [DD4 L142]. Namshi, Trendyol,
Shein and VogaCloset publish no rule, so we assume "additional only". 6thStreet, Styli and Centrepoint are unknown; the
image is sent unless the owner turns a channel off [S13 12.3 Q5]. Image caps: Trendyol 8, Amazon 9, Shein and
VogaCloset 10 [DD4 L266]. The scene image is sent when the module's own images for that page are below the cap. The
module already leaves size charts out of what it sends, so they never use a slot [S13 7.2-7.3].

**What the module does today.** It cannot publish any scene image, made or supplied. Its cut-out step treats a busy
background as a fault and stops the photo, and its checks expect a plain background, so a full scene fails them by
design [DD4 L131-132].

## 3. First principles: how we solve it

Sujan's framing: assume every approval is in place and ask, from first principles, how to solve the problem.

**The goal per style-colour:** one honest scene image, last in the gallery, where the product is exactly the product
we sell. Every rung below exists to protect that "exactly".

**The scene ladder (one pass per style-colour)** [S13 2.1, 2.3, 3.6]:

| Rung | When | What happens |
|---|---|---|
| 0. Skip | A real lifestyle, worn or carried photo already exists (studio on-legs shots count; Campus's styled studio sets with no person do not); type of shoe or bag unknown; the brand's profile or rights not on record; photos too small; every ticked channel already full | Nothing is made; the links sheet says why |
| 1. Full generation | Adult footwear; bags with 3 or more views | The generator draws one frame from 3 to 4 packshots (side first, then pair, top, heel; size charts left out) |
| 2. Second try | Rung 1 failed a check | The same request again, with one corrective sentence per failed check |
| 3. Stronger engine | Rung 2 failed, and a stronger engine has passed a size test | One try on that engine. This slot stays empty until the engine returns full size on 3 of 3 test requests |
| 4-5. Composite | Kids, unknown audience, thin or embellished items from the start; any adult product that failed rungs 1 to 3 | Our cut-out of the brand's photo is placed in a drawn scene and pasted back by code; one retry |
| Hold | The composite also fails | Held for a person, with a reason |

At most 5 generator calls per product, 4 while the stronger-engine slot is empty [S13 3.6]. A real lifestyle photo that
arrives later always wins: the generated one is removed at the next batch [S13 7.6].

**What the checks look at** [S13 5.1-5.6; DD2 L141-146]:
- **Product identity (G1):** the same shoe or bag as the brand's photo of the nearest view.
- **Logo and text (G2):** every logo and word on the product is read and must match; no invented letters.
- **Colour (G3)** and **texture or print (G4):** measured against the brand's photo.
- **Framing (S1), checked by code:** never a face, chin or neck. Legs-only shots: no hips, hands or shoulders in the frame. Sandals and slides: the frame starts at mid-calf. Carried bags: the frame starts at the shoulders. A clutch held at the waist: no shoulders in the frame.
- **Modesty (S2):** women's legs covered to the ankle; men's knees covered except in pool or beach scenes; long sleeves on any visible arm in bag scenes [S13 5.2].
- **Scene safety (S3):** no readable text, other brands, landmarks or skylines, alcohol, religious buildings or flags [DD4 L104].
- **Crop safety (S4):** the product sits inside a central box, so every marketplace's cut keeps it whole.
- **AI label:** the file carries its "AI-generated" tag [S13 6.4].
Any failed check holds the image. A check that cannot run counts as a fail, never a pass [S13 5].

**Why the composite is safe by construction.** In the trial, the generator was asked to "keep the product exactly" and
still changed 10% to 60% of product pixels before paste-back. After paste-back the difference was 0 on every product
pixel [DD4 L177-179]. So a composite skips the four product checks (code proves the pixels are equal) and keeps the
face, modesty, scene safety and crop checks, plus a realism question: does the product sit naturally in the scene?
[S13 5.6].

**Why the composite cannot do a worn shot.** A shoe photographed on a table cannot be pasted convincingly onto a drawn
foot: the angle of a worn shoe rarely matches a packshot [DD4 L193, L196]. So the composite gives a still life only. It is
the safe floor, not a replacement for the worn shot Naz asked for. Its realism is also weaker: in the trial, a pale edge
at the base from a crude cut-out and flatter light than the scene [DD4 L177].

**What the trial showed.** Full generation kept the shoe, its colour and its logo positions on 6 of 6 footwear outputs
[DD4 L29, L182]. It still framed the US Polo slides above the knee, framed both US Polo sneakers in a second trial too
high (one clearly, one borderline), and once drew a real-looking city skyline [DD4 L170-171; I06 L181]. A bag made from
1 photo changed shape [DD4 L172]. The checks and the ladder exist for exactly these cases: framing is checked by code,
never trusted to the instruction [DD4 L184].

**A real before and after.** US Polo `ZEB6895448883067F310CZ` (SMITH GLB 4PR, men's sneaker) today has 6 images: side on
white, then pair, pair, top, back, sole on light grey. All views are there, but there is no scene [I06 L55-56]. After:
the same 6 photos in the same order, plus a 7th, last: the sneaker worn, legs only, seated on a concrete ledge in a
plaza, men's chinos to the ankle, no face [DD4 L112]. If that image fails the checks, the 7th becomes a still life: the
brand's own pair on concrete steps [DD4 L112]. In a trial on two other US Polo sneakers, one passed on the product and
one was held for invented letters on the tongue label [I06 L174-183]. One held and one passed: that is why the checks
exist.

## 4. Why we build this instead of buying a ready tool

Nitin's question in the meeting: surely a tool already does this; if buying costs an extra 5,000 USD, "move on" and
"copy with pride" [MT L183-185, L198, L207]. This section answers it with figures.

**The tools we looked at** (list prices read on one day; only the two generators marked were trialled):

| Tool | What it does | Price per image (USD) | Why it fails us as the whole solution |
|---|---|---|---|
| Photoroom | Cut-out, AI backgrounds, Virtual Model | Basic 0.02, Plus 0.10 [BvB L74] | Virtual Model is 1K unless Enterprise (minimum 200,000 images a year); US-only servers; two conflicting statements on training; JPEG fixed at quality 80 [BvB L15-17, L82-86] |
| Bria Product Shot | Scene around a product | 0.032 [DD4 L206] | Still life only, no worn shot. Not trialled; the one to re-test if composite volume grows [DD4 L206; I06 L147] |
| Claid | AI fashion, AI Photoshoot | 0.118; Photoshoot about 0.24 [BvB L103; DD4 L206] | One view per call; costs more [BvB L103] |
| Stability | Replace background and relight | 0.08 [DD4 L206] | No worn shot from packshots [DD4 L206] |
| Vertex Imagen Product Recontext | Product in a new scene | 0.12, preview [DD4 L206] | 1024 square only; it redraws the product itself [DD4 L206] |
| Pebblely | Product scene backgrounds | Not published (0.05 to 0.20 from second-hand sources) [BvB L107] | No API documents found; still life only |
| FASHN | Flat lay to on-model (apparel) | 0.075 a credit; 2K 0.225 [BvB L108] | Apparel tool; one view per call; keeps outputs on its servers for 3 days [BvB L108] |
| Pixelcut, Picsart | Backgrounds, try-on | 0.05 to 0.10; credit packs [BvB L104-105] | Garment swap only, or not fashion-specific |
| Flair, Vue.ai, Lalaland, ZMO, Veesual, Huhu, Botika | On-model fashion | Not public; Botika about 0.92 [EV L30-31] | No public price or API; no GCC reference [BvB L109-110] |
| Listing Optimization AI | Listing images for Amazon | About 0.16 [MOS L30] | Amazon and US focused, single channel [MOS L7] |
| Open-weight models on our own servers | Scene backgrounds, relighting | Server time only [DD4 L207] | Weaker on keeping the product the same; licence limits on the stronger ones [DD4 L207] |
| Generator via OpenRouter: Nano Banana 2 (trialled) | Worn shot from 3 to 4 packshots | 0.1032 observed at 2K [DD4 L204] | Redraws the product, so it needs our checks. **Chosen as the engine** [DD4 L212] |
| GPT Image 2 (trialled) | Same | 0.080 to 0.117 [DD4 L208] | Redrew the US Polo monogram as different letters [DD4 L174] |

**What every tool lacks.** Each one redraws the product or makes a still life only. Most deliver 1K, or one view per
call. None knows the GCC modesty and scene rules, the kids rule, the marketplace slot and cap rules, or each
marketplace's shape. None keeps a record of which image went where. Several hold data in the US only [BvB L122-139;
DD4 L206]. A vendor that checks its own output is not an independent check [BvB L135].

**What we buy.** The generator, as one swappable engine behind our checks. It returns pixels only; placement, size,
background and file format stay ours, so changing vendor never changes marketplace compliance [BvB L168-175]. This is
Nitin's own idea: "tool number one, it can become tool number two and tool number three ... whoever gives you a better
rate, but you make another wrapper on top of it" [MT L200].

**What we own, which no vendor sells** (all live in the module today) [BvB L30-38; DD4 L217-221]:
- the cut-out, which separates the product from its background and recovers thin shoe soles that cut-outs often lose;
- the contact shadow, a soft shadow drawn under the product so it sits on the surface;
- the cuts and canvases for 9 marketplaces, and the compliance checks on each file;
- the judge: two AI models that each look at every image, so one model's mistake is caught by the other;
- the cost ledger, which records what every image cost on every marketplace;
- the links sheet with fixed public links, and the locks that stop the module touching any product it does not hold.

**Nitin's 5,000 USD test, with figures** (INR 84 per USD [DD9 L726]). The owner rule bars effort figures, so build and
engineering effort cannot be stated. The comparison is therefore per image, with the review work shown as a count
(section 5).
- **Buying the job from an agency** at INR 500 to 800 per style-colour (5.95 to 9.52 USD) [EV L73]: the 807 style-colours cost 4.8k to 7.7k USD once, and about 800 new style-colours a year cost 4.8k to 7.6k USD a year (sections 6 and 7). Our route: 161.40 USD once plus about 160 USD a year. The gap is 4.6k to 7.5k USD once and 4.6k to 7.5k USD a year, so 9.2k to 15.0k USD in the first year. The one-off gap alone straddles the 5,000 USD line; the first year is above it. On Nitin's test we do not buy the job. On the documented counts (1,222 and 1,300) the gap was 7.1k to 11.4k once and 7.4k to 12.1k a year [I06 L247-249].
- **Buying a ready tool per image** at 0.03 to 0.24 USD: even at the top price, 807 x 0.24 = 193.68 USD, about 32 USD more than our 161.40. On price alone a tool passes the test. We still do not buy one as the whole solution, because none makes the worn shot without redrawing the product, and none carries the checks and rules above. The cheaper scene tools would only replace our composite, which we already build from parts that are live.
- **The meeting's own estimate** was INR 200 to 300 per product to build [MT L195]. The documented figure is about 0.20 USD (about INR 17) per accepted image [DD4 L268]. Generation itself is a commodity, priced at about 0.16 USD per image in the India scan [MOS L5]. We buy that commodity; what we build is what makes it safe to publish.

**Honest gaps in this evaluation.** No volume quotes were asked of any vendor [BvB L194]. Bria, Photoroom, Claid, Stability
and Vertex were not trialled, and vendor sample galleries were not compared [EV L17; BvB L113]. No vendor has given a
written no-training position yet [EV L113]. The 0.20 USD per accepted image assumes about 2 attempts and is not measured
[EV L65].

## 5. Test on every brand, then fix in order

Sujan's framing: "There's nothing like a pilot brand ... test it out with all brands, and then we will pick which brands
need to be fixed ... we are solving for the entire use case."

**The test run** [S13 9.2]. One test batch per brand, all six at once: US Polo, Campus, Keds, Puma, French Connection
bags and Vero Moda bags, with every marketplace the brand sells on ticked. Test batches never reach a live marketplace.
- **Size:** 30 eligible products per brand, picked at random, plus up to 10 kids products or thin bags, so the composite route gets enough reviewed images. At most 199 products across the six brands (US Polo 40, Campus 36, Keds 30, Puma 40, French Connection bags up to 40, Vero Moda bags 13). That is about 39.80 USD at 0.20, and at most 109.45 USD at the spending limit.
- **Review-all:** Naz and a second rater each judge every image, without knowing which engine made it [S13 8.1]. Full-route questions: same product; logos and text intact; same colour; no face and framing within the rule; modest clothing; scene free of the forbidden list; looks like a real photo; publish yes or no. Composite questions: no face; scene free of the forbidden list; looks like a real photo; product sits naturally; publish yes or no [S13 8.2].
- **Spending limit:** each batch has a scene limit of 0.55 USD per eligible product. That covers the full ladder (4 calls, about 0.41 USD, or 5 calls with a stronger engine at up to 0.14 USD a call). It applies together with spec 12's generator limit, not the existing judge-spend limit [S13 3.6, 12.4 item 1].
- **Brand photos are never held back.** A scene image waiting for review, or held, never holds the brand's own photos: they publish as usual, and the scene image follows once approved [S13 5.7, 7.4].

**The per-brand scorecard** [S13 9.3]:

| Field | What it tells the business |
|---|---|
| Eligible; skipped because already worn or carried; skipped for each other reason | How big the gap is, and how much the brand already covers |
| Accepted by full generation, accepted by composite, held | How many pages get a worn shot vs a still life |
| Pass rate of the checks, and first-attempt pass rate | How reliably the engine works for this brand |
| Human publish-yes rate, false passes, false holds | Whether the checks agree with people |
| Cost per accepted image, by route | Against the 0.20 USD assumption |
| Not sent at a cap, per marketplace; re-submission pairs per marketplace | What reaches pages, and the upload work it creates |

Live pages per marketplace are not a module figure: test batches never go live, and the module has no stock or price
data. The business takes them from the inventory's live-and-stocked query, as a separate input (section 6)
[S13 9.3; INV L231-272].

**Stop rules** [S13 9.4]. After each batch of a brand, that brand pauses at the first of: any false pass on product
identity, logos or paste-back; any on face or modesty; any on scene safety; crop failures over 10% of attempts; realism
failures or false holds above 15%; cost per accepted image above 0.40 USD. A pause stops only that brand. The fix is
re-tested on the test image set before that brand's next batch.

**The business sets the publish order** [S13 9.5]. The module ranks nothing. Brand and channel managers read the six
scorecards and write the order into the plan file: which brands, which route first, and whether a brand waits for a
fix. A brand with no rights record or no approved style profile is simply not in the order.

**US Polo as the technical test brand.** US Polo is the largest (529 style-colours) [INV L17]. Its monogram is the hardest
case for the cut-out and the logo check [DD4 L162, L174]. It holds 49 of the 88 kids' composites [INV L17], and the
only lifestyle holdout runs on US Polo on Namshi and Noon [M06 L276]. Its batch runs first only to find faults in the
build early. It is a test, not a gate: the other brands do not wait for it [S13 9.2].

**From the test run to live pages (the backfill)** [S13 9.6]:
1. **Selection:** per brand, the products that are live and stocked, from the inventory query; studio on-legs products drop out at the skip rule.
2. **Batches:** normal batches per brand in the business's order, at most 200 products each, every marketplace the brand sells on ticked, with the same spending limit.
3. **Test images reused at no cost:** a live product whose photos, style profile and rights are unchanged since the test run reuses its test image if both raters said "publish yes". There is no new generator call and no second review, so the test-run spend is not paid twice.
4. **Review and publish:** until the exit below, every new scene image is reviewed; brand photos publish at once.
5. **Re-submission:** every product whose scene image went live is marked `scene_added` on the links sheet. The operator re-uploads that product's image columns on each marketplace [S13 7.5]. The module counts the product-marketplace pairs per batch. Upper bound: 3,667 pairs on the four marketplaces with a feed (953 + 955 + 918 + 841, before skips) [INV L263-268]. Who does the uploads is decision 11.

**Review load (counts only).** Two raters per image. Leaving review-all needs at least 100 labelled images, so at
least 200 ratings. If the exit is never reached, every image of the backfill is rated twice: about 2 x 807, about 1,600
ratings, plus the test run. Review capacity has never been measured [EV L72].

**Leaving review-all** [S13 8.2]. Each route exits on its own. Both need at least 100 labelled scene images across at
least 3 brands, at least 20 of them composites, with: 2% or fewer false passes and none on product identity or logos;
15% or fewer false holds; every planted defect caught; zero false passes on face, modesty and paste-back; and the two
raters agreeing well enough (a statistical agreement score of 0.67 or more on every question). The full route exits on
its labels within the 100; the composite route exits only when its own 20 or more labels meet the same bars.
Composites stay in review-all until then. After exit, 10% of each batch is still reviewed.

**Relapse, per route, for every brand at once** [S13 8.2]. A batch whose sampled images show over 2% false passes, or a
single false pass on product identity, logos, face, modesty or paste-back, sends that route back to review-all for
every brand. Leaving again needs 50 new labels of that route.

## 6. Existing inventory and the cost to fix it

**Measured counts by brand** (warehouse, 26 Oct 2026 [INV summary table, sections C and D]). One row per style-colour
(Campus with its size code stripped). "Live and stocked" means at least one size is live and in stock on that
marketplace, in the UAE or KSA.

| Brand | Style-colours | Kids | Already worn or carried (sample) | Live and stocked: Noon | Namshi | Trendyol | Amazon | Any | Need an image | At 0.20 USD |
|---|---|---|---|---|---|---|---|---|---|---|
| US Polo footwear | 529 | 49 | 0 of 8 live sets; 7 of 20 raw sets add a studio on-legs shot | 427 | 429 | 411 | 392 | 458 | 298 | 59.60 |
| Campus footwear | 406 | 6 | none worn; 8 of 8 styled studio sets (these do not count) | 358 | 358 | 321 | 343 | 381 | 381 | 76.20 |
| Keds footwear | 105 | 0 | 0 of 8 | 105 | 105 | 94 | 99 | 105 | 105 | 21.00 |
| Puma footwear | 106 | 33 | 5 of 8 | 0 | 0 | 31 | 0 | 31 | 12 | 2.40 |
| French Connection bags | 63 | 0 | 7 of 8 | 55 | 55 | 58 | 6 | 58 | 7 | 1.40 |
| Vero Moda bags | 13 | 0 | 4 of 8 | 8 | 8 | 3 | 1 | 8 | 4 | 0.80 |
| **Total** | **1,222** | **88** | | **953** | **955** | **918** | **841** | **1,041** | **807** | **161.40** |

Sources: style-colours and kids [INV L17-18]; live and stocked [INV L263-268]; worn samples [DD4 L79-87; A03 L93-94].
The worn or carried view **is a sample**, because no data source records what a photo shows (Trendyol gives image
counts, not what is in each image) [INV L228-229]. Amazon "live" uses a fallback that overstates it. Styli,
Centrepoint, 6thStreet, VogaCloset and Shein have no live-listing feed, so their pages cannot be counted [INV L270-272].

**How "need an image" is worked out** (sample shares on the live and stocked count) [S13 12.4 item 7]:
- Already worn or carried: Puma 31 x 5/8 = about 19; French Connection bags 58 x 7/8 = about 51; Vero Moda bags 8 x 4/8 = 4.
- Studio on-legs shots count as present (decision 5), so 458 x 7/20 = about 160 US Polo drop. The 7 of 20 comes from the brands' raw folders [A03 L93]. The live Trendyol sample found 0 of 8 [DD4 L84], so this drop may be smaller in practice.
- 1,041 - 19 - 51 - 4 - 160 = **807. Cost: 807 x 0.20 = 161.40 USD**; with every image passing at the first attempt, 807 x 0.1032 = 83.28 USD [DD4 L268]; pessimistic 807 x 0.30 = 242.10 USD; the spending-limit ceiling 807 x 0.55 = 443.85 USD.
- Campus counts in full: its styled studio sets have no person, so they do not count as present [S13 2.1, 12.3 Q1]. The revenue base in section 8 treated those sets as covered (only 4 of 15 Campus sets lacked a scene). So the cost includes Campus pages that the revenue line assumed already covered. This document does not re-estimate revenue for that.
- Ceiling: all 1,222 in the product list x 0.20 = 244.40 USD [DD4 L268]. The other 181 are not live and stocked on any marketplace with a feed; they get an image only if a marketplace without a feed (for example Puma on Centrepoint) is ticked.
- The image is made once per style-colour and cut for every marketplace, so marketplaces without a feed add no generator cost.

**Kids: 88 measured vs 85 documented.** DD4 counted US Polo by gender (kids, boy, girl) and Puma by name codes (Jr, Inf,
PS, AC) [DD4 L69]. The inventory uses gender Kids, BOY or GIRL, or a whole-word match on JR, PS, INF, INFANT, KID(S),
BOY(S), GIRL(S), YOUTH or "-K-" in the name or option id. S13 adopts the same rule [INV L215-220; S13 2.2]. Result: US
Polo 49 both ways, Puma 33 vs 31, Campus 6 vs 5. The rule may also catch an adult name with BOY or GIRL in it
[INV L225-226]. The note's total of 108 covers every segment, including 20 apparel kids [INV L218]; for footwear and
bags it is 88. **Used: 88**, all on the composite route. How many kids are live and stocked was not measured.

**Thin bag sets.** 7 of the 8 Vero Moda bags listed on Trendyol show only 1 or 2 images [INV L18], so they take the
composite route. The number of images is not the number of distinct views, so this is a floor, not a full count.

**Where the image is seen (settles evidence contradiction 8).** Puma footwear is live and stocked only on Trendyol
(31 of 106), with 0 on Noon, Namshi and Amazon; Puma appears in the live-listing feed only on Trendyol [INV L266,
L270]. Vero Moda bags are live and stocked on Noon and Namshi for 8 style-colours, not the 1 listed in DD9 [INV L268;
DD9 L426]. At the Trendyol cap of 8: DD9 counted about 470 pairs at the cap [DD9 L432]. That count includes brand
photos and size charts the module does not send, so it is likely too high for what the module sends. The real
number is reported per batch as "not sent at a cap" [S13 7.3, 9.3].

**Other costs.**
- **Check computing:** each check costs about 0.0004 USD of AI judge calls plus about 1 second of graphics-processor (GPU) time at 0.00034884 USD [DD2 L111]: about 0.00075 USD per attempt, so 807 x 2 x 0.00075 = about 1.21 USD.
- **Test run:** about 39.80 USD (section 5). Test images reused in the backfill are not paid twice [S13 9.6].
- **Pacing:** 161.40 USD is 16.1 times the documented 10 USD daily cap [DD4 L220]. On main the daily cap is off unless it is set [EV L69]. The per-batch scene limit paces each batch.
- **Agency comparison:** 807 x INR 500 to 800 = INR 403,500 to 645,600, which is 4.8k to 7.7k USD at INR 84 [EV L73; DD9 L726]. On the documented 1,222 it was 7.3k to 11.6k [I06 L247-248]. The agency's INR 60 per style covers resizing and template filling, never generation, so no cash is saved today; this is spend avoided [I06 L245-247]. India anchor: about 0.16 USD per generated image [MOS L5].

## 7. New products going forward

- **Measured inflow:** 398 new footwear and bag style-colours from May to 25 Oct 2026: May 28, Jun 223, Jul 4, Aug 0, Sep 124, Oct (to the 25th) 19 [INV L312-319]. They arrive in seasonal drops (Campus Jun 167, US Polo Sep 108). Caveats: May and June may include older stock, because the goods-received history starts on 6 Apr. 92 footwear and bag style-colours have no record and cannot be dated [INV L320-322].
- **Cost:** 398 x 0.20 = 79.60 USD for that period. Doubled for a year, that is about 800 style-colours and about 160 USD a year. This is a working figure, not a measured year, and it does not yet remove products that will arrive with a worn photo. The documented figure was about 1,300 a year and about 260 USD [I06 L232; DD9 L446], 39% of a 3,350 yearly inflow that may count option ids rather than style-colours [DD9 L724]. **Used: about 800**, with 1,300 as the documented upper case.
- **The "1,300" ambiguity (evidence contradiction 6):** the same number also means Naz's manual output a year (5 to 6 a day) [DD9 L192], and one document treats it as review capacity [EV L122]. Here only new style-colours are counted, and the measured figure replaces it.
- **How a new style flows:** the brand's photos come in through the normal batch. If none is a lifestyle, worn or carried photo, the ladder in section 3 runs and the image goes last on each ticked marketplace. An image already made carries into later batches at no cost [S13 2.4, 9.7].
- **A real photo always wins:** when a brand later sends a real lifestyle, worn or carried photo, the generated one is removed at the next batch [S13 7.6]. The operator re-submits the image columns, as for any changed product [OPG L153-157].
- **What to ask brands to send:** any real lifestyle or worn photo they already have (kids and Campus sometimes send these later [MT L143]); for footwear the side, pair, top and heel views; for bags front, side and back, because a bag drawn from 1 photo changes shape [DD4 L183]; packshots at least as large as the module accepts.

## 8. What we measure and report

| Measure | Read from | Target |
|---|---|---|
| Coverage per brand: eligible live pages carrying a scene image | The links sheet's `scene_added` rows and the scorecard [S13 7.5, 9.3], against the live-and-stocked query | From 1 of 20 (US Polo), 0 of 7 (Keds) [P08 L343, L345] towards every eligible page |
| Marketplace rejections caused by the added image | Noon and Namshi rejection-reason feeds [I06 L288-289] | Zero. Today the Noon feed has been stale since 21 Aug and the Namshi image reasons are not loaded [LS L112], so restoring them comes first |
| Cost per accepted image | Cost ledger | Near 0.20 USD [I06 L290]; a brand pauses above 0.40 [S13 9.4] |
| Exit from review-all, per route | Labelled set | Section 5 bars [S13 8.2] |
| Conversion lift | Holdout cell 3: US Polo footwear, scene image last, on Namshi and Noon [M06 L276] | A measured lift large enough to see |

**The treatment log is not built here.** The treatment log records which image went live where and when, so a change
can be tied to sales. It is built under P08 row 1.9 [P08 L177]. This initiative only records the `scene_added` events
it will read [S13 7.5, 12.4 item 6]. The holdout depends on it.

**What the holdout can and cannot see.** Namshi can detect about a 15% relative lift with about 42% of one 90-day window
of softline clicks. A 1% lift cannot be measured on any marketplace [M06 L287, L291]. The holdout needs a freeze on bids,
budgets and prices for the test products [M06 L271].

**The revenue base is judged.** 59.8k USD a year = 6.1b 52.2k + 6.1a 3.4k + 6.2 4.2k [P08 L343-345]. It is built as
revenue touched x share of pages without a scene x a judged 1% lift [M06 L190-191]. Our own data finds no sales gain from
image count alone [P08 L72-73]. If the holdout shows nothing, the row is cut [I06 L282].

> **Note, not a P08 figure.** I06 and M06 show B4 (the lifestyle row) falling from 59.8k to 41.9k USD if studio on-legs
> shots count as "scene present" [I06 L220; M06 L192]. This document assumes that decision (decision 5), so the
> 41.9k line is the one that matches its scope. P08 does not split that change across 6.1b, 6.1a and 6.2.

## 9. Risks and the rule that contains each

| Risk | Rule that contains it |
|---|---|
| Brand rights. No brand's written permission for generated images is on record yet. The owner states Opptra holds written rights [DD8 L70]; US Polo's scope is not confirmed [I06 L260]. US Polo also holds 49 of the 88 kids' composites [INV L17] | Nothing is made or published without a `brand_rights` record (the written grant and its scope) for that brand [S13 2.1 rule 3, 7.4]. One record covers both routes, so the US Polo ask covers the composites too [S13 12.1 item 8] |
| Redrawn logos and tongue text (trial: invented letters; a second engine redrew the monogram) [I06 L179; DD4 L174] | Logo and text check G2; review-all until exit; composite as fallback |
| Framing too high (US Polo slides; 2 of 2 US Polo sneakers) [DD4 L171; I06 L181] | S1 by code, with face and body-point detection; hold on fail |
| Modesty | S2 by the judge, from the style profile's rules [S13 5.2] |
| Labelling of AI images: Amazon may need a "synthetic performer" keyword for realistic AI people; Noon says "only photographs are permitted"; marketplaces may strip file metadata [DD4 L138, L142; S13 6.4] | Every image carries an embedded "AI-generated" tag, checked before publish; legs only, no face; the Amazon keyword only on the owner's yes [S13 12.3 Q4]; legal sign-off for the UAE and KSA (decision 12) |
| Image caps (Trendyol 8, Amazon 9) | Sent only while the module's own images are below the cap; otherwise not sent, with a reason on the sheet. No brand photo is ever dropped for it [S13 7.2-7.3] |
| Styli (x1.31) and Centrepoint (x1.67) need the image enlarged by the x2 upscaler [S13 6.2]. That upscaler failed its absolute quality bars and runs only by owner override [EV L123] | Decision 13: keep the override for scene images, or untick Styli and Centrepoint for them |
| Vendor or price change | Swappable engine; the composite is our own fallback [BvB L168-175, L188-189] |
| Brand photos leave our cloud for the generator | Written no-training position from the vendor before any live run [BvB L202-203] |
| Pages blocked by stock or price: 71.4% of live stocked options sold nothing in 90 days [I06 L271] | Backfill only live and stocked pages (section 5) |
| Composite realism (pale edge, flat light) [DD4 L177] | Production cut-out and contact shadow; realism question; composites stay in review-all until their own exit |
| A stronger engine returned a small image on a 2K request [DD4 L176] | That slot stays empty until the engine passes a size test; a small output fails that attempt and the next rung runs [S13 3.4, 3.6] |
| A review queue holds back brand photos | It never does: brand photos publish at once [S13 7.4] |

## 10. What this changes in the product, and what it becomes

**SPEC text replaced.** The main `docs/SPEC.md` "Non-goals" today reads [SPECm L857-861]:

> - No generative edits or paid image APIs; product pixels are never regenerated. ...
> - No lifestyle-background option and no "four options" variant; only what the sheet specifies.
> - No cropping of any kind; no cap on images per product or per channel.

These bullets are replaced by drafted wording with three effects. Generated images are allowed as a narrow exception
to "product pixels are never regenerated", only under the gated rules above [DD2 L161; S13 0.4]. One scene image is
allowed per footwear or bag style-colour, including the composite still life for kids and thin sets [DD4 L276]. And one
line allows a generated frame to be cut to each marketplace's shape around the product [DD4 L278].

**New in the product** [S13 1, 6, 7]:
- **A scene photo type (shown as "lifestyle", internal role LS),** always placed after every brand photo, never image 1.
- **A `generated` flag** on every made image, with a record of the engine version, instruction and reference photos [DD2 L148].
- **The brand style profile** gains a scene table per shoe or bag type and the modesty rules, versioned and owner-approved [DD4 L125; DD8 L196-207].
- **A `brand_rights` record** per written grant, with a scope for scene images [DD8 L177-179; S13 1.2].
- **An embedded "AI-generated" tag** in every scene image file [S13 6.4].
- **A full-frame mode:** brand photos are fitted onto a plain canvas with margins; a scene image is instead cut to each marketplace's shape around the product, because the scene itself is the background [S13 6.1-6.2].
- **Scorecard and `scene_added` events** for the business and for a later treatment log [S13 7.5, 9.3].

**End state.** Every footwear and bag page carries one scene image, last in the gallery. Over time, real photos from
the brands replace the generated ones, and the generated share falls as brands send more.

## 11. Decisions and asks, assumed granted

Listed so the approval is explicit; this document assumes each is a yes.

1. The generation and lifestyle SPEC amendments, as drafted [DD2 L161; DD4 L276-278; S13 0.4].
2. A written yes to the generator as a swappable engine [P08 L101].
3. The vendor's written no-training position before any live run [BvB L202-203].
4. Brand rights confirmed per brand, covering both routes: US Polo (incl. its 49 kids' composites), Campus, Keds, Puma, French Connection, Vero Moda [DD4 L305; DD8 L285; S13 1.2].
5. Studio worn or carried shots count as "scene present"; Campus's styled studio sets with no person do not [DD4 L302; S13 2.1, 12.3 Q1].
6. A named second rater beside Naz [P08 L101].
7. Size-chart swap at a cap: not needed today, because the module leaves charts out. Kept only for a future policy that publishes charts [S13 7.3].
8. Every generated image carries the "AI-generated" tag [DD4 L304; S13 6.4].
9. For women's styles with legs fully covered, a frame starting above the knee is acceptable [I06 L326-327].
10. A bid, budget and price freeze on the holdout products, agreed with the agencies [P08 L548].
11. A named person who re-submits changed images in each portal [P08 L540].
12. Legal acceptance of AI-generated product scenes for the UAE and KSA, with the file tag as the disclosure.
13. The x2 upscaler override is kept for Styli and Centrepoint scene images [EV L123].

## 12. Contradictions in the sources and how this document settles each

| # | Contradiction | Settled here |
|---|---|---|
| F00-2 | 6.1a base 3.4k [P08 L345] vs 3.7k [I06 L223] | Uses 3.4k from P08 |
| F00-6 | Lifestyle waits on Noon and Namshi acceptance [I06 L24] vs it does not [P08 L335] | Does not wait; that acceptance gates infographics only |
| F00-7 | Ask US Polo first, and lifestyle before callouts [R07 L580-581] vs all asks at once, callouts first [P08 L349] | All brands at once, in line with "test with all brands"; no ordering dependency on callouts 6.3 to 6.5 [S13 12.1] |
| F00-8 | 49 of the kids are US Polo (of 85 documented [DD4 L69]; of 88 measured [INV L17]), but P08's US Polo rights question omits 6.2 [P08 L530] | One rights record per brand covers both routes, so the US Polo ask covers the composites (decision 4) |
| F00-9 | Composites stay in review-all [DD4 L262] vs "could leave review on code checks alone" [DD4 L291] | Composites stay in review-all until their own 20-label exit [S13 8.2] |
| F00-14 | SPEC line numbers differ by branch | The lines read today on main are used; details in section 13 |
| E5 | The stronger engine returned 896x1200 on a 2K request [DD4 L176], yet it is the third rung [EV L121] | A small output fails that attempt and the next rung runs; the slot stays empty until 3 of 3 size tests pass [S13 3.4, 3.6] |
| E6 | "1,300" means new styles a year [DD9 L446] and manual images a year [DD9 L192] | Replaced by the measured 398 for May to 25 Oct (about 800 a year) [INV L319]; section 7 |
| E8 | Puma (104) and Vero Moda bags are counted, but have 0 and 1 Noon and Namshi listings [DD9 L424-426] | Measured: Puma is live and stocked on Trendyol only (31); Vero Moda bags 8 on Noon and Namshi [INV L266-268]. Live pages are a separate scorecard input; Puma is not in the holdout; no brand is a "pilot" |
| E9 | Already-worn products counted in the 1,222 and 244.40 [EV L125] | Recomputed on the 1,041 live and stocked, less the already-worn and studio on-legs skips: 807 x 0.20 = 161.40 USD; 244.40 is only the ceiling |

## 13. Sources

Paths are under the worktree `docs/` unless they start with `C:\`. SPEC lines: on main at commit d82cc36 the
Non-goals run L855-866 and the three quoted bullets are L857-861; in this worktree they are L835-841. An earlier note
gives L852-858 for main [EV L100]; the lines read today are used.

| Code | Path | Lines used |
|---|---|---|
| S13 | specs/13-footwear-scene-image.md | sections 0.1-0.4, 1.2, 2.1-2.4, 3.4, 3.6, 5-5.7, 6.1-6.4, 7.1-7.6, 8.1-8.2, 9.2-9.7, 12.1, 12.3, 12.4 |
| INV | plans/proposals/2026-10-26-apparel-shot-set/01-inventory-count.md (summary table; kids rule; sections C, D, E) | 17-18, 20, 124-125, 215-220, 225-229, 231-272, 312-322 |
| P08 | plans/roadmap/08-reprioritization-proposal.md | 7-9, 24-29, 72-73, 101, 177, 333, 335, 339-345, 349, 530, 540, 548 |
| I06 | plans/roadmap/initiatives/06-richer-footwear-pages.md | 24, 55-56, 147, 174-183, 220, 223, 232, 245-249, 260, 271, 282, 288-290, 326-327 |
| DD4 | plans/deep-dives/04-footwear-bags-lifestyle.md | 15-20, 29, 69, 79-89, 104, 112, 125, 131-142, 162, 170-196, 204-212, 217-221, 266, 268, 276-278, 291, 302-305, 426 |
| DD2 | plans/deep-dives/02-derived-shots-fidelity-gate.md | 111, 141-148, 155, 161 |
| DD8 | plans/deep-dives/08-brand-style-profile-model-registry.md | 65, 70, 177-179, 196-207, 285 |
| DD9 | plans/deep-dives/09-business-impact.md | 192, 424-432, 446, 724, 726 |
| BvB | plans/roadmap/05-build-vs-buy.md | 15-21, 30-38, 74, 82-86, 103-113, 122-139, 168-175, 188-189, 194, 202-203 |
| M06 | plans/roadmap/06-metrics-and-impact.md | 147, 189-192, 271, 276, 287, 291 |
| A03 | plans/roadmap/03-image-audit.md | 93-94 |
| R07 | plans/roadmap/07-roadmap.md (via focus/00 s6) | 580-581 |
| F00 | plans/roadmap/focus/00-overview.md | section 6 |
| SPECm | `git show main:docs/SPEC.md` at d82cc36 | 855-866 (quoted 857-861) |
| MT | C:\Users\Sujan Ajay\Desktop\catalog-module\meetings_folder\Catalog-Module-Connect-GCC-14e47c7c-2580.md | 117, 121-133, 143, 166, 183-185, 195-200, 207 |
| MOS | C:\Users\Sujan Ajay\Desktop\catalog-module\catalog_initiative_india\mosaic-competitive-landscape.md | 5, 7, 30 |
| OPG | C:\Users\Sujan Ajay\Desktop\catalog-module\docs\handover\catalog-for-the-operator.md | 9-14, 153-157 |
| EV | C:\Users\Sujan Ajay\Desktop\catalog-module\.runs\2026-10-26-explore-roadmap-evidence.md | 17, 30-31, 65, 69, 72-73, 100, 113, 121-123, 125 |
| LS | C:\Users\Sujan Ajay\Desktop\catalog-module\.runs\2026-10-26-explore-live-state.md | 112 |

Status: draft for business approval
