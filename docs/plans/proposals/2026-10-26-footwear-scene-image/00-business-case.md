# One scene image per footwear and bag style-colour - business case

Date: 2026-10-26, revised 2026-10-27. Business-approval document for Nitin, leadership, and brand and channel managers.
Documents only: nothing was built, no paid call was made and no query was run for this file. It treats 6.1b (US Polo
lifestyle), 6.1a (other brands lifestyle) and 6.2 (composite still life) as **one initiative**: one build, one set of
checks, one rollout. Every number carries a pointer `[code Lnn]`; the codes are listed in section 13. Revenue figures
are copied from P08 only, except one labelled note in section 8. There are no time, duration or effort figures (owner
rule, [P08 L7-9]). The rules are set by the implementation spec `docs/specs/13-footwear-scene-image.md` (S13). Where
this document and S13 differ, S13 wins; its section 12.4 lists the values used here. S13 builds on spec 12, the apparel
shot set (`docs/specs/12-apparel-shot-set.md`, S12), for the generator connection and its bench, the checks and
evaluations, the review card, the photo roles and the brand model registry.

## 1. Bottom line

1. **What:** every footwear and bag style-colour, adults and kids alike, that arrives without a real scene photo gets one scene image, always the last image, never image 1. By default the shot shows the product worn (legs only) or carried; a registered model of the brand, face included, appears only when that brand's profile allows it. Nothing is excluded by product type or audience: the module first draws the whole scene from every usable photo of the product, and places the brand's own cut-out in a drawn scene as the fallback [S13 2.3].
2. **Why:** US Polo, the brand that earns about 5.9M of 9.2M USD softline revenue, has no scene on 19 of 20 sampled shoe pages; 55,280 USD of its ads land on packshot-only pages [P08 L343]. Judged base 59.8k USD a year [P08 L333].
3. **Cost, for new products (the main use):** 398 new footwear and bag style-colours arrived from May to 25 Oct 2026, about six months [INV L21-24, L323]. Doubled, that is about 800 a year. At about 0.20 USD per accepted image: **800 x 0.20 = about 160 USD a year**; pessimistic, at 3 attempts per accepted image (0.30 USD), 800 x 0.30 = about 240 USD a year. An agency would charge 4.8k to 7.6k USD a year for the same 800 (section 4).
4. **Existing pages, on request only:** a team member can send any live product through the same flow. The ceiling is the 807 live and stocked style-colours that lack a scene: 161.40 USD if every one of them were asked for (section 7). There is no backfill programme.
5. **Buy vs build:** we buy the image generator, from a ranked list of approved engines that we test against each other on our own products, and keep the checks, channel rules and records, which no vendor sells [BvB L18-21]. Ready-made hosted services are a last resort only (section 4).
6. **How:** an internal test run on every footwear and bag brand at once, under full review, with whatever spend the owner sets for that run. Each brand gets a scorecard, then goes live for its new style-colours on its own once it passes (section 5). US Polo is the technical test brand, not a gate.
7. **The ask:** approve the decisions in section 11 (each is assumed granted in this document).

**Words used here (defined once).**
- **Style-colour:** one design in one colour, for example one sneaker in navy. One scene image is made per style-colour, never per size [DD4 L18].
- **Packshot:** the brand's plain studio photo of the product on white or light grey.
- **Scene image:** the product shown in a real-looking place. Two kinds: a **worn shot** (legs only by default, or the bag carried; a brand model's face only where the brand profile allows) and a **still life** (the product alone in a scene, no person) [DD4 L15-17].
- **Full generation:** a paid image service (the **generator**) draws the whole picture, product included, from every usable photo of the product: all views, detail, sole and inside, flat or worn, at full size [S13 3.2].
- **Composite:** the brand's own product, cut out of its packshot, placed into a scene the generator draws; the other photos of the product go along as context for the scene. **Paste-back** is the last step: code writes the real cut-out back over the drawn scene, so every product pixel is the brand's original [S13 0.2, 4.1; DD4 L19].
- **Bench:** the ranked list of approved generators per brand and category. **Bake-off:** a standing test that scores every bench engine on the same test products through the same checks, so switching engine is a data change, not a rebuild [S12 5.4].
- **Brand model registry:** the list of real models a brand has used, kept per brand and shared with the apparel initiative. Each entry holds a **face embedding**, a set of numbers computed from the model's face that lets code check "is this the same person?" [S12 9].
- **Frame:** the one picture made per style-colour, 1792 x 2400 pixels (called "2K") in a 3:4 portrait shape. Code cuts it to each marketplace's shape [S13 0.2].
- **Batch:** one upload of a brand's photos that the module processes together, for the marketplaces the operator ticks [OPG L9-14].
- **Gate:** the automatic checks plus a person's review that a generated image did not change the product [P08 L27-28]. **Review-all:** a person sees every generated image before it publishes [P08 L28]. **Judge:** an AI model asked to look at an image and answer set questions; two judges answer every question here.
- **False pass:** the checks let an image through that a person rejects. **False hold:** the checks stop an image a person would publish. **Planted defect:** a known fault put into a test image on purpose, to prove the checks catch it [DD2 L155]. **Eval:** a scheduled run of the checks over a fixed set of labelled images, to measure how often they are right [S12 11.5].
- **SPEC:** `docs/SPEC.md`, the rule book of what the catalog module may do. Only the owner can amend it [P08 L24-26].
- **Holdout:** treat half of a matched set of products, leave the other half, compare conversion [P08 L29].
- **Judged:** an assumption, not a measurement.

## 2. The problem, as a shopper and a marketplace see it

**What arrives every month.** New footwear and bag style-colours come in seasonal drops: 398 from May to 25 Oct 2026
(May 28, Jun 223, Jul 4, Aug 0, Sep 124, Oct to the 25th 19), led by Campus in June (167) and US Polo in September
(108) [INV L316-323]. What brands send with them:
- Footwear usually arrives with "five images, four images" [MT L117]. Measured averages per style-colour on Trendyol: US Polo 5.95, Campus 7.09, Keds 7.7, Puma 6.5, French Connection bags 7.51, Vero Moda bags 2.0 [INV L129].
- Real lifestyle photos are "Generally ... not there. 99%"; for kids and Campus they sometimes arrive later [MT L143].
- Some brands do send worn or carried studio photos: Puma 5 of 8 sampled sets (1 real scene, 4 worn), French Connection bags 7 of 8, Vero Moda bags 4 of 8. Every sampled Campus set has a styled studio set with props but no person [DD4 L79-87].
- Naz also mentioned 2,700 US Polo options with only three images [MT L117]. She said it while talking about apparel and five-image sets; our warehouse holds only US Polo footwear (529 style-colours) [DD8 L65], so the 2,700 is not part of this count.
- In the meeting, Naz asked for three extra images for footwear and bags: a model shot, a lifestyle shot and an infographic. She called the lifestyle shot "more catchy" [MT L121-133]. This document covers the scene image only. Infographics are a separate line (6.3 to 6.5) [P08 L339-341].

**What Naz makes by hand today.** She uses a chat image tool, one prompt per image, and is limited to 5 or 6 images a
day [MT L166]. There is no check on the product and no record of what was made or where it went [P08 L345; DD4 L209].
The yearly inflow alone, about 800 style-colours, is well over half of what that manual route makes in a year (about
1,300 images [DD9 L192]).

**What the shopper sees on live pages.** A US Polo shoe page shows the shoe on white from the side, then pair, top,
back and sole. Nothing shows how the shoe looks worn or where it belongs. 19 of 20 sampled US Polo shoe sets have no
scene, Keds 0 of 7 have one, Campus 4 of 15 lack one [M06 L147, L189]. Across 48 sampled live Trendyol sets, only 1
shows a real-world scene [DD4 L87-89]. New products arrive with the same photo sets, so without a change every new page
repeats the gap.

**What a scene image does and does not do.**
- Every product, adult or kids, footwear or bag: a worn shot (legs only) or a carried bag shot, in a scene chosen by the shoe or bag type. Example: a sneaker worn while seated on a concrete ledge in a plaza [DD4 L112]. Kids products follow the kids rules of the brand's profile (scene list, styling and modesty for children) [S13 1.1, 2.2]. No child is ever drawn as a person: a kids frame is a still life or a legs-only scene with no face, no body above the knee and no adult in it, and the registry holds no child models and no child face data [S13 0.1, 1.1].
- Embellished, transparent or mirror-like products and bags with few photos are tried by full generation like any other product; the still life of the brand's own pixels is the fallback when the checks fail, or the choice when the brand's profile or rights allow only a still life [S13 2.3].
- A brand model's face appears only when the brand profile says so, only an adult model from the brand's registry, and never in a kids frame; otherwise the frame stays legs only. Never image 1. Always the last image [S13 0.1, 7.1].
- It does not replace any brand photo and does not change the order of the brand's photos.

**Which channels allow it.** Noon allows lifestyle only as an additional image: "Lifestyle images are not permitted for
the primary images" [DD4 L138]. Amazon allows it as an alternate, never as the main image [DD4 L142]. Namshi, Trendyol,
Shein and VogaCloset publish no rule, so we assume "additional only". 6thStreet, Styli and Centrepoint are unknown; the
image is sent unless the owner turns a channel off [S13 12.3 Q5]. Image caps: Trendyol 8, Amazon 9, Shein and
VogaCloset 10 [DD4 L266]. The scene image is sent when the module's own images for that page are below the cap. The
module does not send size charts, so they never use a slot [S13 7.2-7.3].

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
| 1. Full generation | Every product, adults and kids, footwear and bags | The generator draws one frame from every usable photo of the product, ordered by view (size charts are not sent). Up to four attempts: the first engine of the approved pair, the same engine again with one corrective sentence per failed check, the second engine of the pair, then the next approved engine on the bench if there is one |
| 2. Composite | As the fallback when rung 1 fails, or first by choice when the brand's profile or rights allow only a still life | Our cut-out of the brand's photo is placed in a drawn scene, with the other photos as context, and pasted back by code; one retry, then a hosted service for the background only if the owner switched it on |
| Hold | The composite also fails | Held for a person, with the reason in plain words |

At most 7 generator calls per product, 6 without a hosted service [S13 3.1, 3.6]. If the bake-off ranks a bench
engine above the pair for a category, that engine takes the slot; a ready-made hosted service runs only behind a switch
the owner sets, never by default, and only for the composite background, whose product pixels are replaced by the
brand's own (section 4). A product with a single usable photo is still tried; when the checks cannot judge the sides
that photo does not show, the full route is not used, the composite runs, and the links sheet says why [S13 3.2]. A real lifestyle
photo that arrives later always wins: the generated one is removed at the next batch [S13 7.6].

**What the checks look at** [S13 5.1-5.6; DD2 L141-146]. Every check compares the scene against every photo of the
product that went in, not one view:
- **Product identity (G1):** the same shoe or bag as the brand's photos.
- **Logo and text (G2):** every logo and word on the product is read and must match; no invented letters.
- **Colour (G3)** and **texture or print (G4):** measured against the brand's photos.
- **Model identity (G5), only when a face is allowed:** the person must be the registered brand model, checked by code against the registry with a set bar [S12 9].
- **Framing (S1), checked by code:** in the default legs-only frame, never a face, chin or neck; no hips, hands or shoulders in the frame. Sandals and slides: the frame starts at mid-calf. Carried bags: the frame starts at the shoulders. A clutch held at the waist: no shoulders in the frame.
- **Modesty (S2):** women's legs covered to the ankle; men's knees covered except in pool or beach scenes; long sleeves on any visible arm in bag scenes; children's rules from the kids profile [S13 5.2]. Visible skin is also measured by code against the profile's limit, as a hard block.
- **Scene safety (S3):** no readable text, other brands, landmarks or skylines, alcohol, religious buildings or flags [DD4 L104].
- **Crop safety (S4):** the product sits inside a central box, so every marketplace's cut keeps it whole.
- **AI label:** the file carries its "AI-generated" tag, checked per marketplace before publish [S13 6.4].

Two judges answer every judged question on every image, not only when the first is unsure. Any failed check holds the
image. A check that cannot run counts as a fail, never a pass [S13 5].

**How the checks themselves are tested** [S12 11.5; S13 10.3]. A scheduled eval runs every night and on every change of
engine, instruction or bar. Its test set grows from every image a person labels, and its planted defects cover modesty
breaches, invented text, extra legs or feet, a mirrored shoe, a moved logo, the wrong colourway, the wrong model, kids
cases, and text on a product that reads like an instruction to the generator. The bake-off of section 4 reuses the
same set.

**Why the composite is safe by construction.** In the trial, the generator was asked to "keep the product exactly" and
still changed 10% to 60% of product pixels before paste-back. After paste-back the difference was 0 on every product
pixel [DD4 L177-179]. So a composite skips the four product checks (code proves the pixels are equal) and keeps the
framing, modesty, scene safety and crop checks, plus a realism question: does the product sit naturally in the scene?
[S13 5.6].

**Why the composite is the fallback, not the first choice.** A shoe photographed on a table cannot be pasted
convincingly onto a drawn foot: the angle of a worn shoe rarely matches a packshot [DD4 L193, L196]. So the composite
gives a still life only. It is the safe floor, not a replacement for the worn shot Naz asked for. Its realism is also
weaker: in the trial, a pale edge at the base from a crude cut-out and flatter light than the scene [DD4 L177].

**What the trial showed.** Full generation kept the shoe, its colour and its logo positions on 6 of 6 footwear outputs
[DD4 L29, L182]. It still framed the US Polo slides above the knee, framed both US Polo sneakers in a second trial too
high (one clearly, one borderline), and once drew a real-looking city skyline [DD4 L170-171; I06 L181]. A bag made from
1 photo changed shape [DD4 L172]. The checks and the ladder exist for exactly these cases: framing is checked by code,
never trusted to the instruction [DD4 L184]; and a bag now goes in with every photo the brand sent.

**A real before and after.** US Polo `ZEB6895448883067F310CZ` (SMITH GLB 4PR, men's sneaker) today has 6 images: side on
white, then pair, pair, top, back, sole on light grey. All views are there, but there is no scene [I06 L55-56]. After:
the same 6 photos in the same order, plus a 7th, last: the sneaker worn, legs only, seated on a concrete ledge in a
plaza, men's chinos to the ankle [DD4 L112]. If that image fails the checks, the 7th becomes a still life: the brand's
own pair on concrete steps [DD4 L112]. In a trial on two other US Polo sneakers, one passed on the product and one was
held for invented letters on the tongue label [I06 L174-183]. One held and one passed: that is why the checks exist.

## 3A. How it works for the operator

The scene image needs no new page and nothing new to learn; it rides on the existing batch wizard, attention queue,
product page and links sheet [S13 2.5; OPF s1-s7].
1. **Upload.** As today, through the "New batch" wizard. For one product that is already live, "Upload photos" on that product's page opens a one-product batch with the brand and marketplaces filled in [OPF s7].
2. **Detect.** The module reads each product: shoe or bag type, who it is for (kids included), which photos already show it worn, carried or in a scene, and which marketplaces are ticked [S13 2.2].
3. **Plan, shown before any spend.** The start screen adds one line with counts and cost, for example "Scene images: 12 of 14 shoes get one (2 already have a worn photo). Made by AI, always shown last. About 2.40 USD, never more than 9.12 USD." Next to it is one choice, "Make them" (the default, so nothing needs to be done), "Still life only" or "Not this time". No engine names [S13 2.5].
4. **Make.** The batch runs as usual. Brand photos publish as usual and are never held back by a scene image [S13 5.7, 7.4].
5. **Review.** Each scene image appears on the existing attention card beside the brand photo it was made from, with the same three buttons: "Use as is", "Remove this photo", "Replace" (upload a real photo instead). One decision per card [OPF s3].
6. **Publish.** The scene image goes last on each ticked marketplace. The links sheet marks the product `scene_added` [S13 7.5].
7. **Re-submit.** The operator re-uploads the image columns of each `scene_added` product, as for any changed product today [OPG L153-157].

A batch with nothing to make looks exactly as it does today. These points are acceptance criteria in S13: one decision
per card, defaults that need no reading, no model names on any screen, counts and cost on the start screen.

## 4. Why we build this instead of buying a ready tool

Nitin's question in the meeting: surely a tool already does this; if buying costs an extra 5,000 USD, "move on" and
"copy with pride" [MT L183-185, L198, L207]. This section answers it with figures.

**The tools we looked at** (list prices read on one day; only the three generators marked were trialled):

| Tool | What it does | Price per image (USD) | Role here |
|---|---|---|---|
| Nano Banana (version 2 trialled), via OpenRouter | Worn shot from the brand's packshots | 0.1032 observed at 2K [DD4 L204] | **First engine of the primary pair.** Redraws the product, so it needs our checks [DD4 L212] |
| Nano Banana Pro (trialled) | Same, stronger model | 0.139 billed in the trial [DD4 L176] | **Second engine of the primary pair.** Returned 896x1200 on a 2K request, so a small output fails that attempt; size is a bake-off criterion [DD4 L176; S13 3.4] |
| GPT Image 2 (trialled) | Same | 0.080 to 0.117 [DD4 L208] | **Bench.** Redrew the US Polo monogram as different letters [DD4 L174]; stays in the bake-off |
| Open-weight models on our own GPU service | Scene backgrounds, relighting | Server time only [DD4 L207] | **Bench.** Weaker on keeping the product the same; licence limits on the stronger ones [DD4 L207]; scored in the bake-off |
| Bria Product Shot | Scene around a product | 0.032 [DD4 L206] | **Hosted, last resort.** Still life only, no worn shot. Not trialled [DD4 L206; I06 L147] |
| Photoroom | Cut-out, AI backgrounds, Virtual Model | Basic 0.02, Plus 0.10 [BvB L74] | **Hosted, last resort.** Virtual Model is 1K unless Enterprise (minimum 200,000 images a year); US-only servers; two conflicting statements on training; JPEG fixed at quality 80 [BvB L15-17, L82-86] |
| FASHN | Flat lay to on-model (apparel) | 0.075 a credit; 2K 0.225 [BvB L108] | **Hosted, last resort.** Apparel tool; one view per call; keeps outputs on its servers for 3 days [BvB L108] |
| Claid | AI fashion, AI Photoshoot | 0.118; Photoshoot about 0.24 [BvB L103; DD4 L206] | Not used. One view per call; costs more [BvB L103] |
| Stability | Replace background and relight | 0.08 [DD4 L206] | Not used. No worn shot from packshots [DD4 L206] |
| Vertex Imagen Product Recontext | Product in a new scene | 0.12, preview [DD4 L206] | Not used. 1024 square only; it redraws the product itself [DD4 L206] |
| Pebblely | Product scene backgrounds | Not published (0.05 to 0.20 from second-hand sources) [BvB L107] | Not used. No API documents found; still life only |
| Pixelcut, Picsart | Backgrounds, try-on | 0.05 to 0.10; credit packs [BvB L104-105] | Not used. Garment swap only, or not fashion-specific |
| Flair, Vue.ai, Lalaland, ZMO, Veesual, Huhu, Botika | On-model fashion | Not public; Botika about 0.92 [EV L30-31] | Not used. No public price or API; no GCC reference [BvB L109-110] |
| Listing Optimization AI | Listing images for Amazon | About 0.16 [MOS L30] | Not used. Amazon and US focused, single channel [MOS L7] |

**What every tool lacks.** Each one redraws the product or makes a still life only. Most deliver 1K, or one view per
call. None knows the GCC modesty and scene rules, the kids rules, the marketplace slot and cap rules, or each
marketplace's shape. None keeps a record of which image went where. Several hold data in the US only [BvB L122-139;
DD4 L206]. A vendor that checks its own output is not an independent check [BvB L135].

**What we buy.** Generators, as interchangeable engines behind our checks. The primary pair is Nano Banana first and
Nano Banana Pro second. Behind them sits a bench of other engines (GPT image models, open-weight models run on our own
GPU service, other leading models), each with its own written approval. The standing bake-off scores every bench engine
on the same test products through the same checks, and the ranking per brand and category is data, so a better or
cheaper engine takes over without a rebuild [S12 5.4]. The connection to the engines is neutral: the same request can go
through OpenRouter, a vendor's own API or our own servers. Every engine returns pixels only; placement, size,
background and file format stay ours, so changing vendor never changes marketplace compliance [BvB L168-175]. Hosted
services that run their own pipeline (Photoroom, FASHN, Bria and the like) are a documented last resort behind an owner
switch, never the default, because we do not control what they change or keep. This is Nitin's own idea: "tool number
one, it can become tool number two and tool number three ... whoever gives you a better rate, but you make another
wrapper on top of it" [MT L200].

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
- **Buying the job from an agency, on yearly inflow** at INR 500 to 800 per style-colour (5.95 to 9.52 USD) [EV L73]: about 800 new style-colours a year cost 4.8k to 7.6k USD a year (section 6). Our route: about 160 USD a year (240 pessimistic). The gap is **4.6k to 7.5k USD every year**: above the 5,000 USD line in the first year at the upper price, and above it in total by the second year at the lower. On Nitin's test we do not buy the job. On the documented 1,300 a year the gap was 7.4k to 12.1k a year [I06 L247-249].
- **Extra line, existing pages on request:** if every one of the 807 live and stocked style-colours were asked for, the agency would charge 4.8k to 7.7k USD once against our 161.40 USD (section 7).
- **Buying a ready tool per image** at 0.03 to 0.24 USD: even at the top price, 800 x 0.24 = 192 USD a year, about 32 USD more than our 160. On price alone a tool passes the test. We still do not buy one as the whole solution, because none makes the worn shot without redrawing the product, and none carries the checks and rules above. The cheaper scene tools would only replace our composite, which we already build from parts that are live.
- **The meeting's own estimate** was INR 200 to 300 per product to build [MT L195]. The documented figure is about 0.20 USD (about INR 17) per accepted image [DD4 L268]. Generation itself is a commodity, priced at about 0.16 USD per image in the India scan [MOS L5]. We buy that commodity; what we build is what makes it safe to publish.

**Honest gaps in this evaluation.** No volume quotes were asked of any vendor [BvB L194]. Bria, Photoroom, Claid, Stability
and Vertex were not trialled, and vendor sample galleries were not compared [EV L17; BvB L113]. No vendor has given a
written no-training position yet [EV L113]. The 0.20 USD per accepted image assumes about 2 attempts and is not measured
[EV L65]. The bake-off closes most of these: its first run scores the pair and the bench on the same test products,
including output size and cost per accepted image, before the test run of section 5.

## 5. Test on every footwear and bag brand, then go live brand by brand

Sujan's framing: "There's nothing like a pilot brand ... test it out with all brands, and then we will pick which brands
need to be fixed ... we are solving for the entire use case."

**The internal test run** [S13 9.1]. One test batch per brand, all six at once: US Polo, Campus, Keds, Puma, French
Connection bags and Vero Moda bags, with every marketplace the brand sells on ticked. Test batches never reach a live
marketplace.
- **Size:** per brand, enough products to cover every shoe or bag type and every audience the brand sells, kids included. The default is 30 eligible products picked at random plus up to 10 more to fill kids, thin bags and the composite route, at most 199 products across the six brands, about 39.80 USD at 0.20. The owner may widen any brand, add any folder, and set any spend for the run: the per-batch spending limit below is a setting for normal batches, not a ceiling for testing.
- **Review-all:** Naz and a second rater each judge every image, without knowing which engine made it [S13 8.1]. Full-route questions: same product; logos and text intact; same colour; framing within the rule (and, where a face is allowed, the right model); modest clothing; scene free of the forbidden list; looks like a real photo; publish yes or no. Composite questions: framing within the rule; scene free of the forbidden list; looks like a real photo; product sits naturally; publish yes or no [S13 8.2].
- **Spending limit for normal batches:** 0.76 USD per eligible product. That covers the whole ladder with every photo sent: 2 attempts on the first engine (2 x 0.1066 = about 0.21 USD), 1 on the second (0.139 USD), 1 on a further bench engine (at most 0.19 USD) and 2 composite attempts (about 0.21 USD), 0.2132 + 0.139 + 0.19 + 0.2132 = 0.7554 USD in all. With no further bench engine approved the worst case is about 0.57 USD. A hosted service runs only if the product's remaining limit covers its price. The limit applies together with spec 12's generator limit, not the existing judge-spend limit [S13 3.6, 12.4 item 1].
- **Brand photos are never held back.** A scene image waiting for review, or held, never holds the brand's own photos: they publish as usual, and the scene image follows once approved [S13 5.7, 7.4].

**The per-brand scorecard** [S13 9.2]:

| Field | What it tells the business |
|---|---|
| Eligible; skipped because already worn or carried; skipped for each other reason | How big the gap is, and how much the brand already covers |
| Accepted by full generation, accepted by composite, held; each by shoe or bag type and by audience | How many pages get a worn shot vs a still life, and whether kids and every type work |
| Pass rate of the checks, and first-attempt pass rate | How reliably the engines work for this brand |
| Human publish-yes rate, false passes, false holds | Whether the checks agree with people |
| Cost per accepted image, by route | Against the 0.20 USD assumption |
| Not sent at a cap, per marketplace; re-submission pairs per marketplace | What reaches pages, and the upload work it creates |

**Stop rules** [S13 9.5]. After each batch of a brand, that brand pauses at the first of: any false pass on product
identity, logos, model identity or paste-back; any on framing or modesty, or on a kids frame's modesty; any on scene
safety; crop failures over 10% of attempts; realism failures or false holds above 15%; cost per accepted image above
0.40 USD. A pause stops only that brand, or only the part where it happened when that is a whole audience or shoe or
bag type (for example kids for that brand). The fix is re-tested by the eval before that brand's next batch.

**Exit per brand: live for new style-colours** [S13 9.3]. The module ranks nothing and the business sets no fix order.
A brand goes live for its new style-colours on its own when it has a rights record, an approved profile and approved
engines, and its test batch ended without a stop (or the fix passed the eval). Shoe or bag types and audiences its
labels do not yet cover stay under full review. From then on every batch of that brand makes scene images in the
normal flow (section 6).

**US Polo as the technical test brand.** US Polo is the largest (529 style-colours) [INV L21]. Its monogram is the
hardest case for the cut-out and the logo check [DD4 L162, L174]. It holds 49 of the 88 kids style-colours [INV L21],
so it also tests the kids rules, and the only lifestyle holdout runs on US Polo on Namshi and Noon [M06 L276]. Its batch
runs first only to find faults in the build early. It is a test, not a gate: the other brands do not wait for it.

**Review load (counts only).** Two raters per image. Leaving review-all needs at least 150 labelled images, so at least
300 ratings. If the exit is never reached, every new style-colour is rated twice: about 2 x 800, about 1,600 ratings a
year, plus about 400 for the test run. Review capacity has never been measured [EV L72].

**Leaving review-all** [S13 8.2]. Each route exits on its own, for every brand at once. The full route needs at least
150 labelled scene images across at least 3 brands; the composite route needs at least 20 labelled composites of its
own. Both need: 2% or fewer false passes and none on product identity or logos; 15% or fewer false holds; every
planted defect caught; zero false passes on framing, modesty, model identity and paste-back; and the two raters
agreeing well enough (a statistical agreement score of 0.67 or more on every question). The labelled set must also
hold at least 10 labels in every cell the new products contain (each audience, kids included; each shoe or bag type
sold; bags with one or two photos; one-photo products; embellished or transparent products; frames with a registered
model), with no false pass on framing, modesty or model identity in the cell; a cell not yet filled stays in
review-all on its own while the rest exit [S13 8.2; S12 11.5]. After exit, 10% of each batch is still reviewed.

**Relapse, per route, for every brand at once** [S13 8.2]. A batch whose sampled images show over 2% false passes, or a
single false pass on product identity, logos, framing, modesty, model identity or paste-back, sends that route back to
review-all for every brand. Leaving again needs 50 new labels of that route.

## 6. New products: the main use

- **Measured inflow:** 398 new footwear and bag style-colours from May to 25 Oct 2026: May 28, Jun 223, Jul 4, Aug 0, Sep 124, Oct (to the 25th) 19. By brand: US Polo 182, Campus 177, Keds 20, Vero Moda bags 8, Puma 7, French Connection bags 4 [INV L316-323]. They arrive in seasonal drops (Campus Jun 167, US Polo Sep 108). Caveats: May and June may include older stock, because the goods-received history starts on 6 Apr. 92 footwear and bag style-colours have no record and cannot be dated [INV L323-326].
- **Cost, shown once:** 398 in about six months, doubled, is about 800 a year. 800 x 0.20 USD per accepted image = **about 160 USD a year**; pessimistic, at 3 attempts per accepted image, 800 x 0.30 = about 240 USD a year; the spending-limit ceiling 800 x 0.76 = 608 USD a year. Per new style-colour: about 0.20 USD, at most 0.76. This is a working figure, not a measured year, and it does not yet remove products that will arrive with a worn photo. The documented figure was about 1,300 a year and about 260 USD [I06 L232; DD9 L446], 39% of a 3,350 yearly inflow that may count option ids rather than style-colours [DD9 L724]. **Used: about 800**, with 1,300 as the documented upper case.
- **The "1,300" ambiguity (evidence contradiction 6):** the same number also means Naz's manual output a year (5 to 6 a day) [DD9 L192], and one document treats it as review capacity [EV L122]. Here only new style-colours are counted, and the measured figure replaces it.
- **How a new style flows:** the brand's photos come in through the normal batch (section 3A). If none is a lifestyle, worn or carried photo, the ladder in section 3 runs and the image goes last on each ticked marketplace. An image already made carries into later batches at no cost [S13 2.4, 9.3].
- **Kids:** kids style-colours go through the same ladder under the kids rules of the brand profile. The inventory finds 88 kids footwear and bag style-colours in the product list (US Polo 49, Puma 33, Campus 6) against 85 documented (US Polo 49, Puma 31, Campus 5) [INV L219-224; DD4 L69]; S13 uses the inventory's counting rule (gender Kids, BOY or GIRL, or a whole-word match on JR, PS, INF, INFANT, KID(S), BOY(S), GIRL(S), YOUTH or "-K-" in the name or option id) [S13 2.2]. The rule may also catch an adult name with BOY or GIRL in it [INV L229-230].
- **Thin bag sets:** 7 of the 8 Vero Moda bags listed on Trendyol show only 1 or 2 images [INV L22]. They go to full generation with every photo first; where a single photo cannot show enough of the bag for the checks to judge, the composite runs instead [S13 2.3].
- **A real photo always wins:** when a brand later sends a real lifestyle, worn or carried photo, the generated one is removed at the next batch [S13 7.6]. The operator re-submits the image columns, as for any changed product [OPG L153-157].
- **What to ask brands to send:** any real lifestyle or worn photo they already have (kids and Campus sometimes send these later [MT L143]); every view they shoot, plus detail, sole and inside shots, because every usable photo goes in; for bags front, side and back at least, because a bag drawn from 1 photo changes shape [DD4 L183]; photos at full size.

## 7. Existing pages: on request

There is no backfill programme and no order set by the business [S13 9.4]. When a brand or channel manager wants a
scene image on a product that is already live, a team member uploads that product through the same flow ("Upload
photos" on its product page, section 3A); it is made, checked and reviewed exactly like a new product. Internal test
runs may use any live brand or folder the owner chooses.

**The ceiling** (warehouse, 26 Oct 2026 [INV sections C and D]). One row per style-colour (Campus with its size code
stripped). "Live and stocked" means at least one size is live and in stock on that marketplace, in the UAE or KSA.

| Brand | Style-colours | Already worn or carried (sample) | Live and stocked, any marketplace | Would need an image | At 0.20 USD |
|---|---|---|---|---|---|
| US Polo footwear | 529 | 0 of 8 live sets; 7 of 20 raw sets add a studio on-legs shot | 458 | 298 | 59.60 |
| Campus footwear | 406 | none worn; 8 of 8 styled studio sets (these do not count) | 381 | 381 | 76.20 |
| Keds footwear | 105 | 0 of 8 | 105 | 105 | 21.00 |
| Puma footwear | 106 | 5 of 8 | 31 | 12 | 2.40 |
| French Connection bags | 63 | 7 of 8 | 58 | 7 | 1.40 |
| Vero Moda bags | 13 | 4 of 8 | 8 | 4 | 0.80 |
| **Total** | **1,222** | | **1,041** | **807** | **161.40** |

Sources: style-colours [INV L21-22]; live and stocked [INV L267-272]; worn samples [DD4 L79-87; A03 L93-94]. The worn
or carried view **is a sample**, because no data source records what a photo shows [INV L232-233]. "Would need an
image" takes the sample shares off the live and stocked count: Puma 31 x 5/8, French Connection bags 58 x 7/8, Vero Moda
bags 8 x 4/8, and 458 x 7/20 for US Polo's studio on-legs shots, so 1,041 - 19 - 51 - 4 - 160 = 807 [S13 12.4 item 7].
Campus counts in full: its styled studio sets have no person, so they do not count as present [S13 2.1, 12.3 Q1].
Amazon "live" uses a fallback that overstates it; Styli, Centrepoint, 6thStreet, VogaCloset and Shein have no
live-listing feed [INV L274-276].

**Cost if every one were asked for:** 807 x 0.20 = 161.40 USD; pessimistic 807 x 0.30 = 242.10 USD; the
spending-limit ceiling 807 x 0.76 = 613.32 USD. All 1,222 in the product list x 0.20 = 244.40 USD is the outer bound
[DD4 L268]. Each requested product is re-submitted on its marketplaces like any changed product; the upper bound is
3,667 product-marketplace pairs on the four marketplaces with a feed [INV L267-272].

**Where the image is seen (settles evidence contradiction 8).** Puma footwear is live and stocked only on Trendyol
(31 of 106), with 0 on Noon, Namshi and Amazon [INV L270, L274]. Vero Moda bags are live and stocked on Noon and Namshi
for 8 style-colours, not the 1 listed in DD9 [INV L272; DD9 L426]. At the Trendyol cap of 8: DD9 counted about 470
pairs at the cap [DD9 L432]. That count includes brand photos and size charts the module does not send, so it is likely
too high. The real number is reported per batch as "not sent at a cap" [S13 7.3, 9.2].

**Other costs.**
- **Check computing:** each check costs about 0.0004 USD of AI judge calls plus about 1 second of graphics-processor (GPU) time at 0.00034884 USD [DD2 L111]. With two judges on every question the judge part at most doubles: about 0.0012 USD per attempt (judged), so 800 x 2 x 0.0012 = about 1.92 USD a year.
- **Test run:** about 39.80 USD at the default sample, or whatever the owner sets (section 5).
- **Pacing:** the largest measured monthly drop (June, 223 style-colours) is about 45 USD at 0.20, 4.5 times the documented 10 USD daily cap [DD4 L220]. On main the daily cap is off unless it is set [EV L69]. The per-batch scene limit paces each batch.
- **Agency comparison:** about 800 a year x INR 500 to 800 = INR 400,000 to 640,000 a year, which is 4.8k to 7.6k USD at INR 84 [EV L73; DD9 L726]. On request, the 807 would be 4.8k to 7.7k USD once. The agency's INR 60 per style covers resizing and template filling, never generation, so no cash is saved today; this is spend avoided [I06 L245-247]. India anchor: about 0.16 USD per generated image [MOS L5].

## 8. What we measure and report

| Measure | Read from | Target |
|---|---|---|
| Share of new style-colours that publish with a scene image, per brand | The links sheet's `scene_added` rows and the scorecard [S13 7.5, 9.2] | Every eligible new style-colour |
| Coverage of live pages | `scene_added` rows against the live-and-stocked query | From 1 of 20 (US Polo), 0 of 7 (Keds) [P08 L343, L345] upwards as new styles replace old and requests come in |
| Marketplace rejections caused by the added image | Noon and Namshi rejection-reason feeds [I06 L288-289] | Zero. Today the Noon feed has been stale since 21 Aug and the Namshi image reasons are not loaded [LS L112], so restoring them comes first |
| Cost per accepted image | Cost ledger | Near 0.20 USD [I06 L290]; a brand pauses above 0.40 [S13 9.5] |
| Exit from review-all, per route and per brand | Labelled set | Section 5 bars [S13 8.2] |
| False-pass and false-hold rate per check, from the nightly eval | Eval job; drift and false-pass panels on the Ops page [S12 11.5; S13 11.2] | Within the section 5 bars; no drift between runs |
| Planted defects caught | Eval job | Every one, every run |
| Agreement between the two judges, and between judges and people | Eval job and labels | Agreement score 0.67 or more on every question |
| Label coverage per shoe or bag type and per audience | Labelled set | The minimum in every cell before any exit |
| Bake-off ranking per brand and category | Bake-off job on the same test set | Re-run on every engine, instruction or bar change |
| Conversion lift | Holdout cell 3: US Polo footwear, scene image last, on Namshi and Noon [M06 L276] | A measured lift large enough to see |

**The treatment log is not built here.** The treatment log records which image went live where and when, so a change
can be tied to sales. It is built under P08 row 1.9 [P08 L177]. This initiative only records the `scene_added` events
it will read [S13 7.5, 12.4 item 6]. The holdout depends on it.

**What the holdout can and cannot see.** Namshi can detect about a 15% relative lift with about 42% of one 90-day window
of softline clicks. A 1% lift cannot be measured on any marketplace [M06 L287, L291]. The holdout needs a freeze on bids,
budgets and prices for the test products [M06 L271]. The holdout products are live pages, so they are made on request
(section 7).

**The revenue base is judged.** 59.8k USD a year = 6.1b 52.2k + 6.1a 3.4k + 6.2 4.2k [P08 L343-345]. It is built as
revenue touched x share of pages without a scene x a judged 1% lift [M06 L190-191]. Our own data finds no sales gain from
image count alone [P08 L72-73]. If the holdout shows nothing, the row is cut [I06 L282]. Campus counts as needing an
image here (its styled sets have no person), while the revenue base treated those sets as covered; this document does
not re-estimate revenue for that.

> **Note, not a P08 figure.** I06 and M06 show B4 (the lifestyle row) falling from 59.8k to 41.9k USD if studio on-legs
> shots count as "scene present" [I06 L220; M06 L192]. This document assumes that decision (decision 5), so the
> 41.9k line is the one that matches its scope. P08 does not split that change across 6.1b, 6.1a and 6.2.

## 9. Risks and the rule that contains each

| Risk | Rule that contains it |
|---|---|
| Brand rights. No brand's written permission for generated images is on record yet. The owner states Opptra holds written rights [DD8 L70]; US Polo's scope is not confirmed [I06 L260]. US Polo also holds 49 of the 88 kids style-colours [INV L21] | Nothing is made or published without a `brand_rights` record (the written grant and its scope) for that brand [S13 2.1 rule 3, 7.4]. One record covers both routes and every audience, so the US Polo ask covers its kids products too [S13 12.1 item 8] |
| Biometric data. The registry holds face embeddings of real brand models, which is biometric data. The face library named earlier (InsightFace) is published for non-commercial use only [DD8 L155] | Embeddings come only from adult models in the brand's own photos and website, with permission assumed granted; no child model and no child face data is ever stored; only admins can see them; they are deleted when a model is removed or the brand leaves; a commercially licensed face-embedding model is chosen at build from evaluated candidates [S12 9] |
| A generated person looks like a real model of the brand who is not in the registry, or like the wrong registered model | Legs only by default; a face only where the brand profile allows; model identity (G5) checked against the registry with a bar; wrong-model cases among the planted defects |
| Redrawn logos and tongue text (trial: invented letters; a second engine redrew the monogram) [I06 L179; DD4 L174] | Logo and text check G2 against every input photo; two judges; review-all until exit; composite as fallback |
| Framing too high (US Polo slides; 2 of 2 US Polo sneakers) [DD4 L171; I06 L181] | S1 by code, with face and body-point detection; hold on fail |
| Modesty, including kids | S2 by two judges from the profile's rules (kids rules for kids products), plus visible skin measured by code as a hard block [S13 5.2] |
| Labelling of AI images: Amazon may need a "synthetic performer" keyword for realistic AI people; Noon says "only photographs are permitted"; marketplaces may strip file metadata [DD4 L138, L142; S13 6.4] | Every image carries an embedded "AI-generated" tag, checked per marketplace before publish; legs only unless the profile allows a registered face; the Amazon keyword only on the owner's yes [S13 12.3 Q4]; legal sign-off for the UAE and KSA (decision 12) |
| Image caps (Trendyol 8, Amazon 9) | Sent only while the module's own images are below the cap; otherwise not sent, with a reason on the sheet. No brand photo is ever dropped for it [S13 7.2-7.3] |
| Styli (x1.31) and Centrepoint (x1.67) need the image enlarged by the x2 upscaler [S13 6.2]. That upscaler failed its absolute quality bars and runs only by owner override [EV L123] | Decision 13: keep the override for scene images, or untick Styli and Centrepoint for them |
| Vendor or price change, or an engine gets worse | The bench: every approved engine is scored by the standing bake-off, and the ranking is data, so the next engine takes over without a rebuild; the composite is our own fallback; hosted services only behind an owner switch [S12 5.4; BvB L168-175] |
| The checks drift or start passing faults | Nightly eval and eval on every change; planted defects; drift and false-pass panels on the Ops page; relapse to review-all [S12 11.5; S13 11.2] |
| Brand photos leave our cloud for the generator | Written no-training position from each vendor on the bench before its first live run [BvB L202-203] |
| Spend on pages that sell nothing: 71.4% of live stocked options sold nothing in 90 days [I06 L271] | Existing pages are made only on request (section 7); the spend follows new products |
| Composite realism (pale edge, flat light) [DD4 L177] | Production cut-out and contact shadow; other photos as scene context; realism question; composites stay in review-all until their own exit |
| An engine returns a small image on a 2K request [DD4 L176] | A small output fails that attempt and the next attempt runs; output size is a bake-off criterion [S13 3.4, 3.6] |
| A review queue holds back brand photos | It never does: brand photos publish at once [S13 7.4] |

## 10. What this changes in the product, and what it becomes

**SPEC text replaced.** The main `docs/SPEC.md` "Non-goals" today reads [SPECm L857-861]:

> - No generative edits or paid image APIs; product pixels are never regenerated. ...
> - No lifestyle-background option and no "four options" variant; only what the sheet specifies.
> - No cropping of any kind; no cap on images per product or per channel.

These bullets are replaced by drafted wording with three effects. Generated images are allowed as a narrow exception
to "product pixels are never regenerated", only under the gated rules above [DD2 L161; S13 0.4]. One scene image is
allowed per footwear or bag style-colour, for adults and kids, by full generation or by the composite still life
[DD4 L276; S13 0.4]. And one line allows a generated frame to be cut to each marketplace's shape around the product
[DD4 L278].

**New in the product** [S13 1, 2.5, 6, 7]:
- **A scene photo type (shown as "lifestyle", internal role LS),** always placed after every brand photo, never image 1.
- **A `generated` flag** on every made image, with a record of the engine version, instruction and every reference photo used [DD2 L148].
- **The brand style profile** gains a scene table per shoe or bag type, the modesty rules, the kids rules and whether a registered face may appear, versioned and owner-approved [DD4 L125; DD8 L196-207].
- **The brand model registry, shared with the apparel initiative,** with a face embedding per registered model [S12 9].
- **A ranked bench of approved engines per brand and category,** with the standing bake-off [S12 5.4].
- **The eval job and two new Ops panels** (drift and false passes) [S12 11.5; S13 11.2].
- **A `brand_rights` record** per written grant, with a scope for scene images [DD8 L177-179; S13 1.2].
- **An embedded "AI-generated" tag** in every scene image file [S13 6.4].
- **A full-frame mode:** brand photos are fitted onto a plain canvas with margins; a scene image is instead cut to each marketplace's shape around the product, because the scene itself is the background [S13 6.1-6.2].
- **For the operator:** one plan line with counts and cost on the start screen, the scene image on the existing attention card, and "Upload photos" on a product's page [S13 2.5].
- **Scorecard and `scene_added` events** for the business and for a later treatment log [S13 7.5, 9.2].

**End state.** Every new footwear and bag page publishes with one scene image, last in the gallery, and any live page
gets one when someone asks. Over time, real photos from the brands replace the generated ones, and the generated share
falls as brands send more.

## 11. Decisions and asks, assumed granted

Listed so the approval is explicit; this document assumes each is a yes.

1. The generation and lifestyle SPEC amendments, as drafted [DD2 L161; DD4 L276-278; S13 0.4].
2. A written yes to the primary pair of generators and to each bench engine, each with its own approval; hosted services only behind an owner switch [P08 L101; S12 5.4].
3. Each vendor's written no-training position before its first live run [BvB L202-203].
4. Brand rights confirmed per brand, covering both routes and every audience: US Polo (incl. its 49 kids style-colours), Campus, Keds, Puma, French Connection, Vero Moda [DD4 L305; DD8 L285; S13 1.2].
5. Studio worn or carried shots count as "scene present"; Campus's styled studio sets with no person do not [DD4 L302; S13 2.1, 12.3 Q1].
6. A named second rater beside Naz [P08 L101].
7. Size-chart swap at a cap: not needed today, because the module does not send charts. Kept only for a future policy that publishes charts [S13 7.3].
8. Every generated image carries the "AI-generated" tag [DD4 L304; S13 6.4].
9. For women's styles with legs fully covered, a frame starting above the knee is acceptable [I06 L326-327].
10. A bid, budget and price freeze on the holdout products, agreed with the agencies [P08 L548].
11. A named person who re-submits changed images in each portal [P08 L540].
12. Legal acceptance of AI-generated product scenes for the UAE and KSA, with the file tag as the disclosure.
13. The x2 upscaler override is kept for Styli and Centrepoint scene images [EV L123].
14. The brand model registry with face embeddings, built from each brand's own photos and website (permission assumed granted), with a commercially licensed face-embedding model chosen at build; a face in a scene only where the brand profile allows it, never in a kids frame, and no child in the registry [S12 9; S13 1.1].
15. New products are the main use; existing pages are made only on request, with no backfill programme [S13 9.3-9.4].
16. The owner sets the spend of each internal test run; the per-batch limit is a setting for normal batches [S13 9.1].

## 12. Contradictions in the sources and how this document settles each

| # | Contradiction | Settled here |
|---|---|---|
| F00-2 | 6.1a base 3.4k [P08 L345] vs 3.7k [I06 L223] | Uses 3.4k from P08 |
| F00-6 | Lifestyle waits on Noon and Namshi acceptance [I06 L24] vs it does not [P08 L335] | Does not wait; that acceptance gates infographics only |
| F00-7 | Ask US Polo first, and lifestyle before callouts [R07 L580-581] vs all asks at once, callouts first [P08 L349] | All brands at once, in line with "test with all brands"; no ordering dependency on callouts 6.3 to 6.5 [S13 12.1] |
| F00-8 | 49 of the kids are US Polo (of 85 documented [DD4 L69]; of 88 measured [INV L21]), but P08's US Polo rights question omits 6.2 [P08 L530] | One rights record per brand covers both routes and every audience, so the US Polo ask covers its kids products (decision 4) |
| F00-9 | Composites stay in review-all [DD4 L262] vs "could leave review on code checks alone" [DD4 L291] | Composites stay in review-all until their own 20-label exit [S13 8.2] |
| F00-14 | SPEC line numbers differ by branch | The lines read today on main are used; details in section 13 |
| E5 | The second engine of the primary pair returned 896x1200 on a 2K request [DD4 L176], yet it was planned as a fixed later step [EV L121] | It is the second engine of the pair; a small output fails that attempt and the next one runs; output size is a bake-off criterion, so an engine that keeps returning small images drops in the ranking [S13 3.4, 3.6; S12 5.4] |
| E6 | "1,300" means new styles a year [DD9 L446] and manual images a year [DD9 L192] | Replaced by the measured 398 for May to 25 Oct (about 800 a year) [INV L323]; section 6 |
| E8 | Puma (104) and Vero Moda bags are counted, but have 0 and 1 Noon and Namshi listings [DD9 L424-426] | Measured: Puma is live and stocked on Trendyol only (31); Vero Moda bags 8 on Noon and Namshi [INV L270-272]. Live pages matter only for requests and the holdout; Puma is not in the holdout; no brand is a "pilot" |
| E9 | Already-worn products counted in the 1,222 and 244.40 [EV L125] | The headline is now the yearly inflow, about 800 x 0.20 = about 160 USD a year. For existing pages, recomputed on the 1,041 live and stocked less the already-worn and studio on-legs skips: 807 x 0.20 = 161.40 USD is the on-request ceiling; 244.40 is the outer bound |
| R1 | Kids, thin bags and embellished products get a still life and nothing else [DD4 L276; earlier S13 2.3] vs no product type or audience is excluded (owner, 2026-10-27) | Every product goes to full generation first, under the kids rules for kids; the composite is the fallback or a brand's choice [S13 2.3] |
| R2 | Face data is never stored [DD8 L154-155; earlier S13 0.1] vs a brand model registry with face embeddings (owner, 2026-10-27) | Registry with embeddings, shared with spec 12, a licensed face model, biometric handling as in section 9 [S12 9] |
| R3 | A drawing from a handful of packshots [DD4 L204] vs every usable photo as a reference (owner, 2026-10-27) | Every usable photo, ordered by view, at full size; the checks compare against all of them [S13 3.2] |
| R4 | The live inventory first, in an order set by the business [earlier S13 9.5-9.6] vs new products first (owner, 2026-10-27) | New products are the main use; existing pages on request only [S13 9.3-9.4] |

## 13. Sources

Paths are under the worktree `docs/` unless they start with `C:\` or `.runs`. SPEC lines: on main at commit d82cc36
the Non-goals run L855-866 and the three quoted bullets are L857-861; in this worktree they are L835-841. An earlier
note gives L852-858 for main [EV L100]; the lines read today are used. S13 and S12 section numbers are those of the
2026-10-27 revisions written in parallel with this one.

| Code | Path | Lines used |
|---|---|---|
| S13 | specs/13-footwear-scene-image.md | sections 0.1-0.4, 1.1-1.2, 2.1-2.5, 3.1-3.2, 3.4, 3.6, 4.1, 5-5.7, 6.1-6.4, 7.1-7.6, 8.1-8.2, 9.1-9.5, 10.3, 11.2, 12.1, 12.3, 12.4 |
| S12 | specs/12-apparel-shot-set.md | sections 5.4 (generator bench and bake-off), 9 (brand model registry), 11.5 (evaluations) |
| INV | plans/proposals/2026-10-26-apparel-shot-set/01-inventory-count.md (summary table; kids rule; sections C, D, E) | 21-24, 129, 219-224, 229-233, 267-276, 316-326 |
| P08 | plans/roadmap/08-reprioritization-proposal.md | 7-9, 24-29, 72-73, 101, 177, 333, 335, 339-345, 349, 530, 540, 548 |
| I06 | plans/roadmap/initiatives/06-richer-footwear-pages.md | 24, 55-56, 147, 174-183, 220, 223, 232, 245-249, 260, 271, 282, 288-290, 326-327 |
| DD4 | plans/deep-dives/04-footwear-bags-lifestyle.md (trial table L176 is the Nano Banana Pro run; L204 Nano Banana 2; L208 GPT Image 2) | 15-20, 29, 69, 79-89, 104, 112, 125, 131-142, 162, 170-196, 204-212, 217-221, 262, 266, 268, 276-278, 291, 302-305 |
| DD2 | plans/deep-dives/02-derived-shots-fidelity-gate.md | 111, 141-148, 155, 161 |
| DD8 | plans/deep-dives/08-brand-style-profile-model-registry.md (L155: face embeddings; InsightFace non-commercial) | 65, 70, 154-155, 177-179, 196-207, 285 |
| DD9 | plans/deep-dives/09-business-impact.md | 192, 424-432, 446, 724, 726 |
| BvB | plans/roadmap/05-build-vs-buy.md | 15-21, 30-38, 74, 82-86, 103-113, 122-139, 168-175, 188-189, 194, 202-203 |
| M06 | plans/roadmap/06-metrics-and-impact.md | 147, 189-192, 271, 276, 287, 291 |
| A03 | plans/roadmap/03-image-audit.md | 93-94 |
| R07 | plans/roadmap/07-roadmap.md (via focus/00 s6) | 580-581 |
| F00 | plans/roadmap/focus/00-overview.md | section 6 |
| SPECm | `git show main:docs/SPEC.md` at d82cc36 | 855-866 (quoted 857-861) |
| OPF | .runs/2026-10-26-map-operator-flow.md (operator flow of the module today, with code pointers) | sections 1, 3, 4, 6, 7 |
| MT | C:\Users\Sujan Ajay\Desktop\catalog-module\meetings_folder\Catalog-Module-Connect-GCC-14e47c7c-2580.md | 117, 121-133, 143, 166, 183-185, 195-200, 207 |
| MOS | C:\Users\Sujan Ajay\Desktop\catalog-module\catalog_initiative_india\mosaic-competitive-landscape.md | 5, 7, 30 |
| OPG | C:\Users\Sujan Ajay\Desktop\catalog-module\docs\handover\catalog-for-the-operator.md | 9-14, 153-157 |
| EV | C:\Users\Sujan Ajay\Desktop\catalog-module\.runs\2026-10-26-explore-roadmap-evidence.md | 17, 30-31, 65, 69, 72-73, 100, 113, 121-123, 125 |
| LS | C:\Users\Sujan Ajay\Desktop\catalog-module\.runs\2026-10-26-explore-live-state.md | 112 |

Status: draft for business approval
