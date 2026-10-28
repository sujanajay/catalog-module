# Complete the apparel shot set: business case

Date: 2026-10-26, revised 2026-10-27 after the owner's review (new products first, every garment type in scope, a
bench of generators, a model registry with face data, an evaluation programme, every photo used as a reference, and
the operator's flow written out). Documents only: nothing was built, no code changed, no paid call was run. One
initiative made of 5.1a (crops for conversion), 5.1b (crops completing the Styli and Centrepoint set), 5.2 (generated
missing roles) and 5.3 (flat lay to on-model); it replaces the two earlier focus pages for crops and generation. The
build detail is spec 12 (`docs/specs/12-apparel-shot-set.md`; "spec 12, 3.3" means its section 3.3). Every approval is
assumed granted (section 11 lists them); the only question is how, from first principles, we solve the problem. No
time, duration or effort figures (owner rule, 08 L7-9); revenue is copied from 08, never re-estimated. Pointers in
brackets, such as "(03 L20)", name a source document and its line ("L"); the key to the short names is in section 13.

**Words used throughout.** An **option** is one product in one colour (also called a style-colour), the unit the
channels list. A **new product** is an option that reaches the module for the first time in a normal batch; the
stream of them is the **inflow**. A **master** is the largest original photo file the brand sends. A **made photo**
is a crop or a generated photo, never the brand's own.

## 1. Bottom line

1. **What:** every new apparel product that comes through the normal batch flow leaves with the photos its channels
   ask for. Cut or missing photos are filled in a fixed order: the brand's own photo, then a crop of a bigger brand
   photo, then a generated photo, else a plain "not made" reason. A cut image comes down only in the same publish that
   puts its checked replacement up. Every apparel department and audience is covered, kids, lingerie and swimwear
   included, each with its own rules (section 3).
2. **Why:** new apparel arrives at about 842 options every six months (INV E L323-327), and the brands' photos rarely
   hold the set: 65 of 66 sampled apparel products lack the five photos Styli and Centrepoint ask for (03 L20). Each
   seasonal drop therefore adds hundreds of listings with missing or cut photos on every channel. Of 1,813 apparel
   options already in the master, 966 have no Styli code and 692 no Centrepoint code (INV A4 L198). 08 values the four
   parts at 48.4k USD a year base (section 8).
3. **What it costs, per new product and per year** (section 6 has the table; the shares are sample figures):
   842 new options in six months x 2 = about 1,684 a year. Of those, 1,684 x 44/73 = about 1,015 miss a front, back
   or close-up (06 L178); they get about 1,520 crops at about no cost, and 1,015 x 5/24 = about 211 generated photos
   (DD2 F2 via 06 L182). Flat-lay-only products add 30 x 3/12 = 7.5 options x 4 = 30 generated photos (Vero Moda's
   inflow and sample share, I5 L46). So 241 generated photos a year x 0.20 USD = **about 48 USD a year**, about 82 USD
   in a pessimistic case with checks. That is **about 0.03 USD per new product on average** (48.20 / 1,684), 0.20 USD
   for a product that needs one generated photo and 0.80 USD for a flat-lay-only product. An agency would charge about
   1.3k to 2.1k USD a year for the generated part alone.
   Existing listings are an extra, done only on request: the ceiling for every live listing is about 67 to 107 USD
   (at most about 196 USD pessimistic) (section 7). The ceiling for new products, if every one were flat-lay-only,
   is 1,684 x 0.80 = about 1,350 USD a year (spec 12, 0.1 rounds it to about 1,400 on 1,700 options).
4. **What we ask:** approve it as one move with the rules in sections 3 and 5 and the decisions in section 11; run
   every softline brand through an internal test run at a spend the owner sets for that run; read the per-brand
   scorecard; then switch it on for new products in the normal batch flow (spec 12, 10.3). Live listings are fixed
   only when someone asks, through the same flow (spec 12, 10.4).
5. **How we know it worked:** new products published with every required role on every ticked channel, and apparel
   listings newly live on Styli and Centrepoint, counted one by one (section 8).

## 2. The problem, as a shopper and a marketplace see it

**New products arrive incomplete, and the module passes them on as they are.** From May to 25 October 2026, 842 new
apparel options arrived, in seasonal drops rather than an even stream: French Connection 227 in September, Penti 228
in June (INV E L310-327). Each one reaches the module with whatever the brand shot. The module cuts out, renders and
publishes those photos to every ticked channel; it never adds a missing photo, and a photo with the model's head or the
product cut at the frame edge goes out as it is, with the note "Photo N: already cut at the frame edge" and no hold
(OPG L90-93). Since PR #91 (a recent module change that lets cut photos through on every channel) a cut product is made
on every channel, image 1 included (LIVE L42). The operator's only advice today is "ask the brand for an uncut photo"
(OPG L93). So every drop puts hundreds of new listings live with missing roles or cut photos on every channel.

**The same gap is already on the live pages.** The brands' photos go to the marketplaces as received: on 37 Trendyol
UAE listings compared with the raw files, about 9 in 10 showed the brand photos at most resized, padded or reordered,
and none had been reshot or repaired (03 L25, L148). From the audit sample of 141 softline products:

| What a shopper sees | Count in the sample | Source |
|---|---|---|
| Model's head cut off on an on-model photo | 15 of 64 on-model products | 03 L22, L112 |
| Head cut on an on-model photo, against the Styli and Centrepoint rule | 13 of 66 apparel products | 03 L167 |
| Product cut by the frame on image 1 (Noon names this as a rejection reason) | 6 of 141 (6 of 66 apparel) | 03 L113, L161 |
| Framing problems alone (head cut or product cut on image 1) | 19 of 66 apparel | 03 L178 |

These are the brands' own cuts, not cuts the module made (LIVE L13). The counts come from one reviewer on a random
sample (03 L207). They stay sample figures: the measured inventory could not read cut flags or views, because the
catalog database was skipped (INV B L205-217).

**The five-role set.** A **role** is one required kind of photo. Styli and Centrepoint ask for five (I5 L14-15):

| Code | Role | Plain meaning |
|---|---|---|
| FM | Front, mid-thigh | Model from the head down to mid-thigh, facing the camera |
| FL | Full length | Model head to toe |
| FC | Fabric close-up | The fabric up close, without the model's face |
| BH | Back, at the hips | Model's back, from the head down to the hips |
| HS | Head and shoulders | Face and shoulders, cut below the bust |

These five fit tops, knitwear, outerwear and dresses. Garments they do not describe, such as trousers, skirts, a pack
of briefs or a kids set, get their own role lists (section 3). On Styli and Centrepoint garments always need a model
(MTG L65), image 1 must be the front (MTG L101-103), and a cut close-up is fine as long as it is "not cut like from the
head" (MTG L70-75). Namshi, Noon and Trendyol "don't really check", but "for a good catalog, at least five are
required" (MTG L45).

**Most of our apparel does not have the set.** 65 of 66 sampled apparel products lack it; 60 of 66 still fail if the
fabric close-up is not required (03 L20). Missing roles across the 66: HS 57, FC 31, FM 25, BH 19, FL 14 (03 L120).
11 of 66 have no model photo at all (03 L117). The effect on listings: of 1,813 apparel options, 966 have no Styli code
and 692 no Centrepoint code (measured, INV A4 L198; the documents said 893 and 663, DD9 L173-175). A blank code means
"not set up", which can also be a commercial choice (INV L201-203).

**Why removing alone is wrong.** If we simply pulled the cut photos, the listing would show fewer photos. On Styli
and Centrepoint a set below five cannot list at all: "I cannot list it without five images" (MTG L119). On the other
channels, two images make it "very hard to gain customers attention" (MTG L85). Already 14 of 66 sampled apparel
products have fewer than 4 images (03 L171). So removal and replacement are one move, never two.

## 3. First principles: how the problem is solved

**The replacement ladder.** For each product, each ticked channel and each role that channel needs, the planner
takes the first rung that works (I5 L113-123; spec 12, 0.1 and 3.4):

1. **Existing photo.** A brand photo already is that role and passes the channel's rules. Use it.
2. **Crop.** Cut the role out of a bigger photo of the same option. No pixel changes; only the frame moves. A
   **crop** (also called a derived shot) is a new image, not an edit (I5 L16).
3. **Generate the missing role (mode A).** An image generator (an AI model that draws images) makes the missing
   role from every usable photo the brand sent of the same option (I5 L18).
4. **Flat lay to on-model (mode B).** For a product photographed only lying flat, put the garment on one of the
   brand's own registered models: a full-length shot first, approved by a person as the **anchor**, then the other
   on-model roles made from it; the fabric close-up is a crop of the flat lay (I5 L156-160; spec 12, 9.3).
5. **Not made, with a plain reason** on the links sheet, for example "Not made: the photo is too small to cut a head
   and shoulders from it" or "No approved brand model for Vero Moda women yet" (I5 L122-123; spec 12, 3.7).

Crop rules (DD2 L131-135; spec 12, 4): cut only from a photo whose head is whole, with at least 5% margin above the
head; the cut sits in the role's band (FM mid-thigh, BH hips, HS below the bust, and a band for each role of the other
departments) and never through a logo, text or buckle; BH only from a real back photo, never a mirrored front; FC from
a flat lay or from a skin-free fabric area of an on-model photo; never a soft, enlarged crop. FL can never be cut from a
tighter shot (DD2 L8).

**Every garment type is covered** (spec 12, 3.6). No department, audience or product type is set aside: tops,
knitwear, outerwear, dresses and jumpsuits (maxi lengths included, with their own front crop band), bottoms,
activewear and sports bras, lingerie and underwear, sleep and lounge, swimwear, multipacks and sets, and kids. Each has
its own role list per channel, crop bands, modesty and styling rules, labelled examples in the golden set (the fixed
set of labelled images every check is tested against) and its own tests. The seven questions the taxonomy left open
(DD0 L276-282: bottoms, maxi dresses, lingerie, swimwear, multipacks, sports bras, kids) are answered in spec 12, 3.6
with role lists drawn from the channel guides; this page treats them as settled (decision 9). Modesty is a rule about
how a garment is shown, never a reason to drop it: each category and audience has its shooting rule, and a made photo
never shows more skin than the brand's own photos of the product, which the gate measures (the fidelity gate, below).
Kids clothes are in scope on every route but are shown off the body: flat lays, packshots or ghost-mannequin photos
and crops of them. No child is ever generated, and the registry holds no child models and no child face data (spec
12, 3.6 and 9.5). Printed garments are generated like any other; the logo and print checks hold any redrawn print. A composite (the
product cut out and placed on a plain scene, as spec 13 does) stays available as a route and as a fallback when a
generated photo is held, never as a forced substitute for a whole category.

**Every photo of the product is a reference.** A **reference** is an input photo the generator copies the garment
from. Every usable photo of the option goes in: all views, details, the inside, flat lays and on-model shots, at full
resolution or the largest size the generator takes, ordered by view, up to the generator's own limit (spec 12, 5.2).
The gate then compares the made photo with every one of those views, not only with the front. When the brand sent a
single photo, spec 12, 5.2 sets what can be made from it. From one on-model front: crops it can hold and generated
fronts or close-ups whose detail the photo shows. From one flat lay: the mode B on-model set of the side shown, and the
fabric close-up as a crop. A view the photo does not show (most often the back of a printed garment) is made only when
the gate can still judge it; otherwise the sheet says, for example, "Not made: the brand sent one photo, so a back view
cannot be checked against the real garment." Composites keep one cut-out to paste back but still pass the other photos
as context.

**The one rule that makes "remove and replace" safe** (spec 12, 0.1, 3.3 and 8.2). A cut photo leaves image 1, or
leaves a role slot, only in the same publish that makes its replacement live, and only after that replacement passed
every automatic check and every review it needs. A listing never loses a photo without gaining one. Who must say yes
depends on the brand's phase:

| Replacement | While the brand is in review-all | After the brand has exited |
|---|---|---|
| Crop that retires a cut photo | A **swap card**: one person sees the cut photo and the crop side by side and decides | Retires the cut photo automatically; a fixed 10% still goes to a swap card |
| Crop that fills an empty slot | Goes live once it passes the checks (nothing is retired) | Same |
| Generated photo | Two raters on the review card; their publish decision also decides the retirement | Goes live on the gate; a fixed 10% sample and every mode B anchor still go to two raters |

Crops and generated photos leave review-all separately, per brand (section 5). If no replacement can be made, the cut
image stays where it is with today's note, the product appears on the "not made" list with its reason, and the brand
is asked for an uncut photo. Moving a cut photo from image 1 to a later slot is allowed when another valid front takes
image 1, because the count does not drop. A cut photo in a position no required role covers (a side view, a second
full length) is never retired: it keeps its link, moves after the required roles and carries the note "Photo <n> is
still used: it is cut at the edge and no shot type the channel asks for replaces it." This also delivers the "cut
product never on image 1" rule proposed for Noon and Amazon (`roadmap/initiatives/02-channel-ready-live-catalog.md`
L251) without ever emptying a slot.

**Before and after, on real products** (I5 L74-80, L206-228; scratch trials, nothing published):

| Product | Before | Ladder rung | After |
|---|---|---|---|
| Vero Moda / Only `vm-ol/5715945917041`, 5018x6691 master | FM, FL, BH, FC; HS missing | 2, crop | HS crop 1561x2082 px, pixels unchanged, cost 0; 4 to 5 roles (I5 L208, L228) |
| Vero Moda `Z5C2F10C8828D6C235D33Z`, 800x1096 photos | HS missing; a crop would be about 400 px | 3, mode A | Generated HS, 0.104 USD; **held** by the checks: hair 2% from the top edge, bar 5% (I5 L209, L226) |
| Vero Moda / Only `vm-ol/5715946612846`, 2 flat lays | No model photo; every on-model role missing | 4, mode B | Generated full-length anchor, 0.103 USD; **held** for a colour shift of 7.68 against a bar of 5.0 (I5 L210, L223) |

Both generated shots "would pass a quick look, which is exactly the risk"; measured checks caught both (I5 L233-235).

**The brand model registry** (spec 12, 1.6, 6.2 and 9). Each brand keeps a registry of its own adult models (never a
child), built from the
brand's own photos and, under the grant this page assumes, the brand's website. Every registered model photo stores a
**face embedding** (a list of numbers that describes a face, so a computer can tell whether two photos show the same
person) and a person group, so all photos of one model sit together. Mode B picks the brand's registered model for the
product; the gate's check G5 compares the face in a made photo with that model's registry entry and holds the photo
below a set bar. The face library the registry research named (InsightFace) is published for non-commercial use only
(DD8 L155), so choosing a commercially licensed face-embedding model is a build task, with candidates evaluated against
our own photos. How this data is protected is a risk row in section 9.

**The fidelity gate.** A **fidelity gate** is a set of measured, automatic checks a generated image must pass before
a person sees it; if any check fails, the image is held, never published (I5 L166-177; DD2 L137-148; spec 12, 6).
There is no averaging: one failed check holds the image.

| Check | What it asks |
|---|---|
| G1 garment | Is it the same garment as every brand photo of it? Two AI judges must agree |
| G2 logo and text | Does every logo and word read the same, with nothing invented? |
| G3 colour | Are the main garment colours within the colour bar? |
| G4 texture and print | Do the fabric and print look the same up close, against every view? |
| G5 model identity and scene | Is it the brand's registered model (face compared with the registry, above the bar), with the same lighting and background across the set? |
| G6 framing | Head whole with margin, cut in the role's band, correct frame shape and full requested size |

Some checks are hard blocks that no reviewer can override: more skin than the brand's own photos (measured), a face
that does not match the registry, and a missing "made by AI" label where a channel requires one (spec 12, 6.2). A
generated image gets at most three attempts in all: the second with stronger wording, the third on the next model of
the brand's bench (section 4); then the hold stands (spec 12, 6.3). A held photo can only be published through the
two-rater review, never by one person, and never if it was held for a wrong garment or a changed logo or text (spec 12,
7.2). Every made photo is labelled as cut or generated, with a record of where it came from, and every generated file
carries a hidden "made by AI" marker (spec 12, 1.1 and 5.2). **Review-all** means a person also sees every generated
image before it publishes, until the gate has proven itself on labelled images (DD2 L150-155; spec 12, 7). Why every
image: in trials every generator redrew prints (7 of 7) and some moved a label (DD3 L17, L128-130). A gate that the
vendor does not run is what makes a bought generator safe to use.

**The gate is itself tested, all the time** (spec 12, 11.5). An evaluation job runs every night and on every change of
model, prompt or bar. It scores the gate against a regression set that grows with every image a person labels, and
against a planted-defect set: images with a known fault put in on purpose (a modesty breach, invented text, an extra
limb, a mirrored back, a moved logo, the wrong colourway, the wrong model, kids and lingerie cases, and text hidden in
a print that tries to instruct the generator). Two AI judges always rate each image. Every department and audience
must have labelled examples before a brand can leave review-all. Drift and false passes show on the Ops page. The
bench tests in section 4 reuse the same job.

**Why crops come before generation.** India had only one front image per product, so "the full image suite must be
generated from that one reference" (04 L194). GCC holds bigger photos and more views: crop first, generate second,
and when generating, give the generator every photo the brand sent (04 L194). A crop changes no pixel, costs nothing
and needs no generator, rights or vendor (08 L56-63).

## 3.1 How it works for the operator

The flow sits on the screens the operator already uses: the upload wizard, the "Needs attention" queue, the product
page and the links sheet (spec 12, 2.4).

1. **Upload.** As today, through the upload wizard. For one finished product, "Upload photos" on its product page
   fills in the brand and channels and opens a one-product batch.
2. **Detect.** For each product the module works out the product type, flat lay or on a model, which roles are
   already there, whether the head is whole or cut, the audience (adult or kids) and the channels ticked.
3. **Plan, shown before any spend.** The start screen shows what will be made and what it costs, for example "3
   products missing a back view: 2 crops, 1 generated photo, about 0.20 USD." Nothing is spent before the operator
   presses Start.
4. **Make and check.** Crops and generated photos are made and pass the gate (section 3).
5. **Review.** Anything that needs a person appears as a card in "Needs attention", with the brand's photo beside the
   made one and the same three buttons as today: "Use as is", "Remove this photo" and "Replace photo N" (upload a real
   photo). One decision per card. During review-all a generated photo also needs a second rater.
6. **Publish.** Approved photos go live in the same publish that retires any cut photo they replace. The links sheet
   marks each change, such as "role added", "cut replaced" or "pending review".
7. **Re-submit.** As today, the operator re-submits changed image columns in each marketplace portal (OPG L151-157).

When nothing is missing, a batch looks exactly as it does today: no new step, no new screen, nothing to learn. Model
and vendor names never appear on any screen, sheet or note. The checks the operator experience must pass (one decision
per card, defaults that need no reading, counts and cost on the start screen) are acceptance items in spec 12, 12.1.

## 4. Why we build the platform and buy only the engine

**The market, tool by tool** (05 L54-111; DD3 L19, L62-104). Prices are list prices read on one day, in USD. "2K"
means about 1,800 x 2,400 pixels; "1K" about half that on each side. The table is a view of the market, kept for
reference; it is not the list of what we use.

| Tool | What it does | Price | Why it fails us as the solution |
|---|---|---|---|
| Photoroom (Plus, Virtual Model) | Cut-out, AI shadows, virtual model, flat lay, ghost mannequin | 0.02 Basic, 0.10 Plus per image; Enterprise needs 200,000 images a year (05 L74-75) | Low resolution (1K) unless we commit to 200,000 images a year (05 L69); US-only servers; training statements conflict (05 L82-86); fixed image quality; no marketplace sizes (05 L72) |
| FASHN Product-to-Model | Flat lay or product onto a person | 0.225 per 2K image on demand (05 L108) | One view per call; outputs kept on its servers 3 days; no five-role set with one model |
| Claid AI fashion | On-model images, backgrounds, upscale | 0.118 per image (05 L103) | One view per call; dearer than the engines we chose |
| Pixelcut | Try-on, backgrounds, upscale | 0.05 to 0.10 (05 L104) | Garment swap only |
| Picsart | Background removal, expand, templates | credit packs; per call not readable (05 L105) | Not fashion-specific |
| remove.bg | Background removal | subscription (05 L106) | Standalone service closes 1 December 2026 |
| Botika | Synthetic models | about 0.92 a photo (05 L109) | No public API |
| Vue.ai, Lalaland, ZMO, Veesual, Huhu | On-model fashion | not public (05 L110) | No GCC marketplace reference found |
| Google Vertex Virtual Try-On | Garment swap on a person | not reachable on the pricing page (DD2 L112) | Garment swap only, 1024 px square |
| A free model run on our own servers | Try-on and view models | server time only (DD3 L163) | Small images (576x864) or a weaker likeness today; kept on the bench (below) |
| Listing Optimization AI | Amazon images and A+ | about 0.16 per image (04 L176) | Amazon only; a price anchor, not a fit |

What none of them does: keep the product's pixels unchanged (every model redrew prints, DD3 L17); make the five roles
with one consistent model (DD3 L19); know Styli guides, Centrepoint's canvas or Noon's margins (05 L127, L136); run
an independent check of its own output (05 L135); record what changed and why; follow our channel rules.

**What we buy: a bench of engines, ranked per brand and category** (spec 12, 1.5 and 5.4). The image generator itself,
as a swappable engine behind our own gate. The primary pair is Nano Banana 2, at 0.101 USD per 2K image (DD3 L31),
and Nano Banana Pro second, at 0.134 (DD3 L32), both reached through OpenRouter's image service. Behind them sits a
**bench**: other engines kept ready and tested all the time. It holds the GPT image models (GPT Image 2 at about 0.10,
DD3 L161), open-weight models run on our own GPU next to the existing cut-out service (FASHN VTON, FLUX.2 klein,
Qwen-Image-Edit; server time only, DD3 L163), and other frontier models as they appear. Each bench entry has its own
owner approval. A standing **bake-off** (a contest that runs every engine on the same test images) scores every bench
model on the golden set through the same gate and evaluation job (section 3). Moving a brand or category to another
engine is a change of data, not of code. The generator client does not depend on one provider: it calls OpenRouter's
image service, a vendor's own API or a model on our own GPU through one request shape (DD3 L165). Hosted services
(Photoroom, FASHN, Bria and the like) are a documented last resort behind a switch, never the default, because we do
not control their models, where they keep our photos, or their price (05 L82-86, L188-189). "The engine only returns
pixels" (05 L169): every size, margin, background and check is ours, so changing engine never changes channel
compliance (05 L168-175).

**What we already own that no vendor sells** (05 L28-39): cut-out with its guard rules; per-channel render for 9
channels; compliance checks; the two-model judge with automatic repair; output evals; publish to fixed links with
verification; the links sheet; the cost ledger per call, image and channel; review cards; product locks that stop a
batch from touching any other product. All of it costs about 0.004 to 0.012 USD per option (05 L44-45).

**Price.** Agencies charge about INR 500 to 800 per option for generated images, 5.95 to 9.52 USD (I5 L273). Our
engine costs about 0.20 USD per accepted image, assuming about two attempts (DD3 L174); a five-shot set about 1.00 USD
(INR 84), 6 to 10 times cheaper than one agency option (I5 L285-286). Generation itself is a commodity priced near
0.16 USD an image (MOS L5); what the market does not sell is the channel-specific quality around it. A bench engine
that wins the bake-off at a different price changes these unit costs; the cost tables then show the new arithmetic.

**Nitin's test, on a year of new products.** In the meeting Nitin said that if buying costs an extra "$5,000... screw
it, move on", and "copy with pride" (MTG L198, L207). The figures, for the 241 generated photos a year of section 6:
- A bought tool against ours: 241 x 0.225 = 54.23 USD a year on FASHN, or 241 x 0.10 = 24.10 USD on Photoroom Plus,
  against 241 x 0.20 = 48.20 USD ours. The money gap is tiny either way, so capability decides, not price.
- Against an agency: about 1.3k to 2.1k USD a year for the generated part against about 48 to 82 USD ours. The gap is
  under 5,000 USD, so on money alone his test says "buy".
- Every new option missing a role sent to an agency: about 1,015 options x 5.95 to 9.52 USD = 6.0k to 9.7k USD a
  year, where crops cost about 0. This gap is above 5,000 USD, every year.
- Extra, existing listings on request (section 7): the generated part costs 1.5k to 2.9k USD at an agency against 67
  to 107 USD ours; every live option missing a role, 6.5k to 10.4k USD at an agency.
- Above all, no tool on the market does the job: buying a tool still leaves the planner, crops, gate and channel
  rules to build. So we do what Nitin described: buy "tool number one" and make "another wrapper on top of it",
  swapping to tool two or three, "whoever gives you a better rate" (MTG L200). The bench is that wrapper.

**Gaps in this evaluation, said plainly.** No volume quotes were asked for (05 L194). Public vendor samples were not
compared (05 L113). Flat-lay specialists (Photoroom Flat Lay, Ghost Mannequin) were only listed, with no price or test
(05 L71). No crop vendor was looked at; cropping is "Build" (05 L129). The trials were 60 images across 8 models;
none ran at volume (DD3 L15, L151); the bake-off on our own golden set replaces them. India's negotiated vendor summary
was never seen (04 L59).

## 5. Test on every softline brand, then the scorecard

**There is no pilot brand** (spec 12, 10.1). The internal test run is one batch per apparel brand covering every
apparel product of that brand in the owner's folders, on every channel: French Connection, Penti, Vero Moda, Cardio
Bunny, Nautica and Puma apparel (INV summary L13-24). Vero Moda's batch is the technical test that runs first, because
one batch of it exercises crops, mode A and mode B; it is a test, not a gate, and the others follow. Only and Anta are
not in the product master (INV L45), so they are not in this page's counts; their photos are covered when they are in
the owner's folders. US Polo apparel joins the day its files arrive: its warehouse catalogue is footwear only today
(DD2 L9). Test batches go to a test area that no live channel or marketplace sees.

**How the test run works.**
- Any brand and any folder may be tested. The owner sets the spend for each test run, at any amount; the per-batch
  spend limit is a setting for live batches, not a ceiling on testing (spec 12, 10.1). A separate limit for the
  automatic checks exists today and has no default, so empty there means no limit (pointers in section 13).
- Review-all for everything: two raters see every generated image, and one person decides every swap card for a crop
  that retires a cut photo. A crop that fills an empty slot goes through on the automatic checks.
- The golden set must hold labelled examples of every department and audience (bottoms, lingerie, swimwear,
  multipacks, kids and maxi dresses included) before the run is read.
- Nothing is published that failed a check; nothing is removed that has no replacement (section 3).

**The per-brand scorecard it produces** (per batch and per brand, on the Ops page and as a file; spec 12, 10.2):

| Field | What it tells the business |
|---|---|
| Products, apparel products, per department and audience | Size of the batch and what it covered |
| Complete sets before and after, per channel | How far each brand moved toward its full role set |
| Roles filled by existing photo, crop, mode A, mode B | How much is fixed for free and how much needs the engine |
| Not made, per reason | What only the brand can fix (small photos, no whole head, no approved model, one photo too few to check a view) |
| Cut photos found, replaced, still live | The remove-and-replace measure itself |
| First-attempt gate pass rate; holds by check | How often generated images pass, and what fails |
| Review counts and agreement; false passes and false holds | Whether the gate can be trusted for this brand |
| Cost per accepted image, attempts per accepted image | From the cost ledger |
| Styli and Centrepoint eligible | Products with all required roles live on that channel |
| Coverage | Apparel products in the batch against the brand's options in the inventory count ("<a> of <b>") |
| Swaps | Swap cards decided yes and no; cut photos kept because no required role replaces them |

**After the scorecard, new products go live brand by brand** (spec 12, 10.3). The scorecard shows where each brand
stands; nothing in the module ranks brands. Every brand's new products then go through the normal batch flow with the
shot set switched on, under review-all until that brand meets the exit numbers below. Live listings are fixed only on
request (section 7; spec 12, 10.4).

**What Vero Moda shows, and what it does not.** Its EAN folder (the brand's photo folder, filed by product barcode)
holds masters of about 5000x6700 px (I5 L74, L142), 3 of 12 sampled apparel sets have no model photo (I5 L46), and it
ships a flat lay as the last image on 5 of 8 sampled options (DD2 L50). But Vero Moda is mostly set up on both
channels: of its 107 apparel options, only 12 lack a Styli code and 16 a Centrepoint code (INV A4 L194), and it sent
only 15 new apparel options in six months (INV E). The largest gaps and the largest inflow are French Connection (665
Styli, 366 Centrepoint; 379 new options) and Penti (324 new options). So Vero Moda tests the machinery; the gain will
show mainly on other brands.

**Leaving review-all, per brand, with two separate exits** (spec 12, 7.4):
- **Generated photos.** Overall, at least 300 labelled generated images over at least three brands, all roles, and
  every department and audience the brand sells; false passes (gate passed, person rejected) 2% or less, with none on
  garment or logo; false holds (gate held, person accepted) 15% or less; planted defects caught 100%; and the two
  reviewers agree well enough (a standard agreement score of 0.67 or more on every question). The brand itself also
  needs at least 50 labelled images with no false pass on garment or logo. Exit applies per department and audience:
  each needs at least 20 labelled generated images of its own (all of them, at least 5, where the brand has fewer
  products there), and one not yet covered stays in review-all on its own. After exit, a 10% sample still goes to two
  raters. A batch over 2% false passes, or any false pass on garment or logo, sends the brand back to review-all at
  once; exit then needs 50 new labelled images.
- **Crops.** 50 swap cards in a row approved for the brand, with no rejection and no reported head or logo cut. After
  exit, passing crops retire cut photos automatically and a 10% sample still goes to swap cards; any rejection sends
  the brand's crops back to swap cards. Crops usually exit first, so a brand that needs only crops reaches automatic swaps without
  generating anything.

## 6. New products: the main case

**Inflow, measured** (INV E L278-327). 842 new apparel options from May to 25 October 2026, arriving in seasonal
drops. Doubling the six months gives the yearly figure used for every cost on this page:

| Brand | New options, May to 25 Oct | A year (x 2) |
|---|---|---|
| French Connection apparel | 379 | 758 |
| Penti | 324 | 648 |
| Cardio Bunny | 83 | 166 |
| Nautica | 40 | 80 |
| Vero Moda apparel | 15 | 30 |
| Puma apparel | 1 | 2 |
| **All apparel** | **842** | **1,684** |

Two caveats pull in opposite directions: May and June may include older stock, because the goods-received history
starts on 6 April, and 246 apparel options have no date at all and are not counted (INV L323-327). The documents also
give "about 3,350 more soon" across all categories (SPEC L152, R15a; the unit is unclear, EVD L71) and about 196
apparel options a year needing generation (I5 L287).

**Cost per year of inflow, in USD** (count x unit price; role shares from the samples because roles could not be
measured; 0.20 assumes about two attempts per accepted image, DD3 L174, not yet measured):

| Line | Arithmetic | Count or cost |
|---|---|---|
| New options a year missing a front, back or close-up | 1,684 x 44/73 (06 L178) | about 1,015 |
| Crops | 1,015 x 1.5 (DD2 L44-48) | about 1,520 crops, about 0 USD (I5 L264) |
| Mode A, generated missing roles | 1,015 x 5/24 (DD2 F2 via 06 L182) | about 211 photos |
| Mode B, flat-lay-only products | 30 Vero Moda options a year x 3/12 (I5 L46) = 7.5 options x 4 | 30 photos |
| **Generated photos a year** | 211 + 30 | **241** |
| Generated, at 0.20 per accepted photo | 241 x 0.20 | **48.20** |
| Pessimistic: three attempts, the third on the second engine (0.101 + 0.101 + 0.137 = about 0.34, spec 12, 5.2) | 241 x 0.34 | 81.94 |
| Automatic checks, 3 attempts each (0.00075, DD2 L111) | 241 x 3 x 0.00075 | 0.54 |
| Render of each new product | already part of every batch | 0 extra |
| **Pessimistic total a year** | 81.94 + 0.54 | **about 82** |
| **Average per new product** | 48.20 / 1,684, or 82.48 / 1,684 | **about 0.03, at most about 0.05** |
| Ceiling, if every new option were flat-lay-only (mode B) | 1,684 x 0.80 | about 1,350 (spec 12, 0.1: about 1,400 on 1,700) |
| Per product that needs it | one generated role; two roles; a flat-lay-only set of four | 0.20; 0.40; 0.80 (DD3 L174) |
| Agency, generated part | 211 + 7.5 = about 219 options x 5.95 to 9.52 (I5 L273) | 1.3k to 2.1k a year |
| Agency, every option missing a role | 1,015 x 5.95 to 9.52 | 6.0k to 9.7k a year |

Mode B is counted on Vero Moda only, because the flat-lay-only share is measured there alone (3 of 12); other brands'
flat-lay-only products add 4 photos (0.80 USD) each. The agency figures are spend avoided, not cash saved: the agency
does not make these images for us today (I5 L275-276). If Styli wants larger images than the 2K output enlarged x2,
each attempt costs about 0.05 USD more (DD3 L174; I5 L309).

**Review load.** Until a brand exits, every generated photo of its new products goes to two raters: about 241 a year
across all brands, and the exit needs at least 300 labelled images overall (section 5), most of them from the test
run. Crops that retire a cut photo go to a one-person swap card until the brand's crop exit. Review capacity is not
measured anywhere (EVD L72).

**In the batch flow.** Section 3.1 is the operator's view. The wizard options, their defaults and the spend limit
per batch are in spec 12, 2.4 and 10.3; the limit is a parameter the batch carries, and empty means no generation.

**A real photo always wins.** Made photos are numbered from 101 up and have their own links. When a brand later
sends an uncut photo for a role we generated or cropped, the made photo is removed in the same publish that puts the
brand photo live; the brand photo gets a new link and the sheet says "Photo <n> was replaced by the brand's own photo
<m>." The operator re-submits the change in each portal (spec 12, 3.5; OPG L151-157).

**What to ask brands to send, so generation becomes the exception:** masters of 2,400 px or more on the long side
(DD2 L135); uncut photos with the head whole and space above it; every role the category's list asks for where a
shoot allows, with a real back photo; a flat lay as the last image (DD2 L50); every view they have, since every photo
becomes a reference. A 2,400 px master turns an HS crop from a full-length shot into about 900 px, which clears every
channel except Centrepoint without a flag (DD2 L81).

## 7. Existing listings: on request

There is no backfill programme, no order set by the business and no screen of its own (spec 12, 10.4). When someone
wants a live product fixed, a team member uploads it through the same flow as a new product: "Upload photos" on its
product page, or the wizard (section 3.1). The counts below are the ceiling: what it would cost if every live apparel
listing were sent through.

Counts come from the measured inventory of 26 Oct 2026 (INV). Two things could not be measured: which photos are cut
and which view each photo shows, because the catalog database was skipped (it needs a password from the secret store)
and the warehouse has image counts, not roles (INV B L205-217). Those rows keep the audit sample and say "sample".

**By brand** (INV summary L13-24, A4 L190-203, D L235-276). "Live and stocked" counts options that a daily marketplace
data file (a liveness feed) shows as live with stock:

| Brand | Options | Images per option on Trendyol 1 / 2 / 3 / 4 / 5+ (not on Trendyol) | No Styli / no Centrepoint code | Live and stocked, any channel | Head cut, sample (roles not readable) |
|---|---|---|---|---|---|
| French Connection apparel | 729 | 0 / 2 / 88 / 135 / 418 (86) | 665 / 366 | 624 | 4 of 17 (03 L167) |
| Penti | 615 | 2 / 8 / 35 / 126 / 441 (3) | 46 / 87 | 521 | 2 of 8 (03 L167) |
| Vero Moda apparel | 107 (308 on Trendyol) | 10 / 1 / 0 / 13 / 79 (4) | 12 / 16 | 97 | 3 of 12 (03 L167) |
| Cardio Bunny | 119 | 1 / 1 / 10 / 21 / 86 (0) | 0 / 27 | 117 | 4 of 15 (03 L167) |
| Nautica | 159 | 0 / 0 / 3 / 28 / 110 (18) | 159 / 159 | 45 | not sampled |
| Puma apparel | 84 | 0 / 25 / 2 / 5 / 51 (1) | 84 / 37 | 50 | not sampled |
| Only, Anta | not in master (Only: 28 options on Trendyol) | Only 0 / 0 / 1 / 1 / 26 | not measurable | not in liveness | flat packshots, sample |
| **All apparel** | **1,813** | **13 / 37 / 138 / 328 / 1,185 (112)** | **966 / 692** (573 neither) | **1,454** | **13 of 66, sample** |

- **Single-image options:** 13 by master option, or 70 by Trendyol option, 64 of them Vero Moda, mostly rows with a
  blank master option id (INV L166-168). 188 options show 3 images or fewer; they follow the one-image and few-image
  rules of section 3.
- **Styli and Centrepoint absence:** measured 966 and 692 (INV A4 L198), against the documented 893 and 663 (DD9
  L173-175), which did not count Puma apparel; without it today's figures are 882 and 655 (INV L201-203). A blank
  code means "not set up", not proven "not live".
- **Live and stocked apparel options by channel** (INV D): Noon 1,369, Namshi 1,369, Trendyol 1,195, Amazon 1,042
  (Amazon overstates). Styli, Centrepoint, 6thStreet, VogaCloset and Shein have no liveness feed (INV L274-276).
- **Every department counts.** The counts include the 20 apparel kids options (Penti 12, Puma apparel 8; INV
  L219-224), Penti's intimates and pyjamas, and any bottoms, swimwear or multipacks, all in scope. The role shares
  below come from samples made up mostly of tops and dresses, so they stay sample figures.

**Images by ladder rung, ceiling** (measured option base; role shares from the samples):

| Rung | Arithmetic | Count | Cost each (USD) |
|---|---|---|---|
| Options missing a front, back or close-up | 1,813 x 44/73 (06 L178) | about 1,093 | |
| Live options with a head-cut photo to replace | 1,454 live x 13/66 (03 L167) | about 286 options | |
| Crops | 1,093 x 1.5 (DD2 L44-48) | about 1,640, sample | about 0 (I5 L264) |
| Mode A, generated missing roles | 1,093 x 5/24 (DD2 F2 via 06 L182) | about 228 images | 0.20 per accepted image |
| Mode B, low | Vero Moda 107 master options x 3/12 (I5 L46) = 27 options x 4 | 108 images | 0.20 per image, 0.80 per set |
| Mode B, high | Vero Moda 308 Trendyol options x 3/12 = 77 options x 4 | 308 images | same |
| **Generated total** | 228 + 108, or 228 + 308 | **336 to 536** | |

**Ceiling cost in USD:**

| Line | Low (336 images) | High (536 images) |
|---|---|---|
| Generated, at 0.20 per accepted image | 336 x 0.20 = 67.20 | 536 x 0.20 = 107.20 |
| Pessimistic: three attempts, the third on the second engine (0.34) | 336 x 0.34 = 114.24 | 536 x 0.34 = 182.24 |
| Automatic checks, 3 attempts each | 336 x 3 x 0.00075 = 0.76 | 536 x 3 x 0.00075 = 1.21 |
| Re-render of every touched option on all channels (05 L45) | 1,093 x 0.0119 = 13.01 | 13.01 |
| **Pessimistic total** | **about 128** | **about 196** |

At agency prices (I5 L273) the generated part would be 255 to 305 options x 5.95 to 9.52 = 1.5k to 2.9k USD, and every
option missing a role 1,093 x 5.95 to 9.52 = 6.5k to 10.4k USD; spend avoided, not cash saved (I5 L275-276). Each
request runs under its own batch's spend limit and the same review rules as new products.

## 8. What we measure and report

**Value as 08 states it** (USD a year; judged, not measured, 08 L19-20):

| Part | Low | Base | High | Source |
|---|---|---|---|---|
| 5.1a crops for conversion | 0 | 17.8k | 59.5k | 08 L314 |
| 5.1b crops completing the Styli / Centrepoint set | 0 | 14.7k | 28.8k | 08 L315 |
| 5.2 generated missing roles | 0 | 8.6k | 23.2k | 08 L316 |
| 5.3 flat lay to on-model | 0.9k | 7.3k | 16.0k | 08 L317 |
| **Sum of the four rows** | **0.9k** | **48.4k** | **127.5k** | arithmetic; 5.0 (2.3k) is separate |

**What we report** (the scorecard of section 5, plus monitoring, evaluation and cost in spec 12, 11.5 and 12.2):

| Measure | How it is counted | Baseline | Source |
|---|---|---|---|
| New products complete on arrival | Share of new products published with every required role on each ticked channel, per brand and department | five-role set on 1 of 66 sampled | I5 L99; spec 12, 10.2 |
| Listings newly live on Styli and Centrepoint | Options with all required roles that were absent, then live; their sales against Centrepoint about 115 and Styli about 25 USD per listed option a year | 966 / 692 with no Styli / Centrepoint code, measured (documented 893 / 663) | INV A4; I5 L103, L320-322 |
| Role coverage per brand | Share of products with each role, split by brand photo, crop, generated, "not made" | five-role set on 1 of 66 sampled | I5 L99, L316-317 |
| Cut photos replaced | Found, replaced and still live, per brand and channel | 13 of 66 sampled apparel with a head cut | 03 L167; spec 12, 10.2 |
| False pass rate | Gate passed, person rejected, against people's labels; per check, brand and department | none yet; bar 2%, none on garment or logo | spec 12, 7.4 and 11.5 |
| False hold rate | Gate held, person accepted | none yet; bar 15% | spec 12, 7.4 and 11.5 |
| Drift | Change in pass rates and judge scores on the fixed regression and planted-defect sets, nightly and after every change of model, prompt or bar | first nightly run | spec 12, 11.5 |
| Coverage of the labelled set | Labelled images per department and audience; every one must be present before a brand exits | none yet | spec 12, 7.4 and 11.5 |
| Cost per accepted image | Cost ledger, per call, image and channel | 0.20 assumed | I5 L106; monitoring L82 |

**Conversion lift is judged, not measured, until a holdout measures it.** A **holdout** fixes half of a matched set of
products, leaves the other half, and compares how often each sells (08 L29). Our own data shows no gain from image
count alone: options with 7 to 8 images sell no better than those with fewer (I5 L56-58), and a holdout detects about
a 15% lift, not 3% (I5 L323-324). Today there is no holdout cell for shot-set work: the five cells cover B1, L1,
lifestyle, callouts and Amazon, and the apparel B1 cell tests re-render and reorder only (06 L274-278). So listings on
Styli and Centrepoint are the number to watch; conversion stays judged.

## 9. Risks and the rule that contains each

| Risk | Evidence | Rule that contains it |
|---|---|---|
| Using a model's likeness without rights | Only two brands have GCC sites; one brand's site bans AI bots (DD8 L17, L22) | Registry photos only from the brand's own photos and sites under a recorded grant (assumed granted), private, never published; synthetic model only as an approved fallback (DD8 L168-173, L281; spec 12, 9) |
| Face data is biometric data | A face embedding identifies a person; the library first named is non-commercial only (DD8 L155) | Stored only for registered adult brand models, never for a child, in the private store; seen only by admins, never on an operator screen, sheet or note; used only inside that brand's own registry; deleted when the brand leaves or its grant ends; a commercially licensed embedding model (spec 12, 1.6 and 9) |
| Modesty in GCC across every category and audience | Swimwear and lingerie never probed (DD3 L144); most Penti and Cardio Bunny photos ruled out as references (I5 L306) | Modesty and styling rules per category and audience (spec 12, 3.6); a measured hard block on more skin than the brand's own photos; kids, lingerie and swimwear cases in the planted-defect set; two judges and review-all; labelled examples of every department before exit |
| Redrawn logos and prints | Prints redrawn 7 of 7; labels moved (DD3 L17) | G2 and G4 hold them against every view; a photo held on logo or text can never be published; moved logos and text hidden in prints are in the planted-defect set (spec 12, 6.2 and 11.5) |
| A model or prompt change quietly lowers quality | Engines update without notice; trials were small (DD3 L15, L151) | The evaluation job runs nightly and on every change; drift and false-pass panels on the Ops page (spec 12, 11.5) |
| Channel refuses generated or upscaled images | Styli and Centrepoint acceptance unknown (I5 L309) | Written answers from both before the first publish there (decision 11); "made by AI" label as a hard block where a channel requires it; larger native images for Styli if required |
| A channel or brand objects to made photos | No pull-back path in the build yet | Decision 18: a way to remove every made photo of a brand or channel at once |
| Vendor changes price, model or terms, or closes | A background-removal service closes; another vendor cut its rate limit (05 L188-189) | The ranked bench: every entry tested by the standing bake-off, switching is a data change, open-weight models on our own GPU as a floor; hosted services only as a last resort (section 4; spec 12, 5.4) |
| Review capacity | Not measured anywhere (EVD L72) | Crops first; live listings only on request; spend limit per batch; exit only on the numbers in section 5 |
| Brand photos leaving our cloud | Engines run outside our cloud; abuse logs kept "for a limited period" (I5 L308) | Written no-training position from each bench vendor before any live run; open-weight models keep photos in our cloud |
| Pages that cannot sell (no stock, wrong price) | The 3A target queue exists to filter these (08 L126) | The scorecard shows coverage and live counts; images alone do not unlock them |
| Small masters or a single photo | 800x1200 inputs fail Styli's bar (DD2 L10); 13 single-image options (INV L166-168) | "Not made" reason, never a soft crop or an unchecked view; ask the brand for 2,400 px masters and every view |
| A cut image vanishes with no replacement | PR #91 sends cut products to image 1 (LIVE L42) | The swap rule in section 3: no removal without a checked, reviewed replacement in the same publish |

## 10. What this changes in the product, and what it becomes

**SPEC lines that change** (main at d82cc36; exact text in spec 12, 0.5). Cropping (A1 to A4) and generation (A5 to
A8) are approved as two separate decisions:
- A1, L74-75, the Styli line: "Never crop." becomes "Never crop at render time; role derivation only under spec 12."
- A2, L131, rule R11: a role crop is a new photo made by a rule-bound cut (head and every logo or text whole), not a
  render-time crop.
- A3, L296, "Fit, never crop": becomes "at render time"; a crop is cut before the render and then fitted as usual.
- A4, L861, non-goal "No cropping of any kind": replaced by role crops only, with each channel's minimum crop size as
  a value the owner sets.
- A5, L857-859, non-goal "No generative edits or paid image APIs": replaced by generated shots only for a missing
  role, only by an engine on the owner-approved bench, always gated, reviewed by two people until the brand's exit.
- A6: the earlier draft's new non-goal against face recognition and stored face data is reversed. The brand model
  registry stores a face embedding per registered model photo, private and admin-only, used for mode B and the G5
  identity check.
- A7, new non-goal: brand model photos only from the brand's own photos and sites under a written grant, kept
  private, never published.
- A8, L53-54: "No paid image API without a separate owner yes" gains the one approved exception, the engines on the
  approved generator bench, each with its own approval.
- Models table, L456: the generator bench, the gate's measuring tools and the licensed face-embedding model are listed.
- L397-401: the list of changes the operator re-submits gains "role added", "cut replaced" and "pending review".
- L805: the list of approved database changes gains spec 12's one (see decision 3).
- After L75: a product with more than 100 photos fails ingest, because numbers from 101 are kept for made photos.
- AGENTS.md (with A7): one job may write private model photos under its own folder.
- Decisions log: the contract exception (decision 3) and one line per brand exit.

**New in the product.** The operator's flow of section 3.1: detection of roles, head state and audience per product;
a plan with counts and cost before any spend; "Upload photos" on a finished product's page (spec 12, 2.4). Every made
photo is labelled as cut or generated, with a record of where it came from (spec 12, 1). Shot roles shown to the
operator per photo (08 L211; spec 12, 2). A review card for each generated photo: the product's brand photos beside the
made photo, six yes or no questions (same garment, logos and text, colour, print and fabric, model and scene, hands and
framing) and "Publish this photo?"; two raters, a third person on disagreement (spec 12, 7.1 and 7.2). A swap card for
each crop that retires a cut photo: the two side by side, three questions (whole head and product, whole logos and
text, same product and right shot type) and "Swap now?" (spec 12, 7.1). A made photo is a source of its own, so a
later batch carries it forward instead of deleting it (spec 12, 3.5). The model registry with face embeddings, rights
and anchor flow (spec 12, 1.6 and 9); the ranked generator bench and the bake-off (spec 12, 5.4); the evaluation job
with drift and false-pass panels on the Ops page (spec 12, 11.5). The operator's note "The tool never crops" (OPG L93)
is rewritten (spec 12, 12.3). No model or vendor name ever appears in operator copy (AGENTS.md; I5 L19-20). Tests and
evals: spec 12, 11.

**What it evolves into.** The treatment log records every published image with its role, label, position and upload
date, and ties it to sales; only 13% of content joins to sales today (08 L127, L177). The module then learns which
roles and treatments sell, per brand and channel. The end state: every new product arrives on every channel with every
required role, brand photos first, crops second and generation the exception, and any live listing can be brought up
to the same standard by uploading it again.

## 11. Decisions and asks, assumed granted (listed for the record)

| # | Decision or ask | Whose |
|---|---|---|
| 1 | Cropping SPEC amendments A1 to A4, with the three fixes of the crops focus page; approved on their own | Owner |
| 2 | Generation SPEC amendments A5 to A8 and the models table, with the mode B clause allowing one approved brand-model reference; approved on their own | Owner |
| 3 | The contract exception, typed by the owner and committed in its own docs change before any build work: the execution protocol (section 11, L260-263) lets only specs 02 and 03 ship a database migration; spec 12 needs its migration `0005_shot_set.sql` and additive changes to the 02 contracts. Without it the build is blocked | Owner |
| 4 | A ranked generator bench per brand and category: the primary pair of section 4 first, then the bench entries section 4 names (other vendors' image models, open-weight models on our own GPU, other frontier models), each with its own approval row; a standing bake-off on the golden set; hosted services only as a last resort behind a switch (spec 12, 1.5 and 5.4) | Owner |
| 5 | Written no-training position from each bench vendor before its first live run | Vendors; owner asks |
| 6 | Brand rights for model reference photos and their face embeddings, from the brand's own photos and website, per brand and per site | Owner, brands |
| 7 | Brand consent for generated photos of its own products (mode A), separate from model-photo rights | Brands; brand managers ask |
| 8 | The second rater named, plus a third person for disagreements; who reviews and how many cards each can take | Owner |
| 9 | Role lists, crop bands and modesty rules for every department and audience, which settle DD0 open items 1 to 7 (bottoms, maxi dresses, lingerie, swimwear, multipacks, sports bras, kids) and accessories the reference model wears: settled in spec 12, 3.6 | Owner (settled) |
| 10 | Who re-submits changed images in each marketplace portal, and does any channel take a listing offline for re-review | Owner (08 L540) |
| 11 | Styli and Centrepoint written image specs, incl. on-model fabric crops, generated and enlarged images, and any AI labelling rule | Channels; channel managers ask |
| 12 | Masters of 2,400 px or more and every view they hold, from every apparel brand | Brands; brand managers ask |
| 13 | Gate bars and the two exits (generated: section 5 numbers, with every department and audience labelled; crops: 50 approved swap cards in a row, no rejection); minimum crop size per channel | Owner |
| 14 | The spend limit for made photos, a parameter set on every live batch (empty means no generation); for the internal test run, any spend the owner sets for that run; the limit for automatic checks, which has no default | Owner |
| 15 | Role list and channel rule table, incl. "cut product never image 1" (08 L535) | Owner |
| 16 | A listing route for Styli and Centrepoint for newly eligible options | Brand and channel managers |
| 17 | An apparel holdout cell, if the business wants conversion measured | Owner, data team |
| 18 | A pull-back path: remove every made photo of a brand or a channel at once if either objects | Owner |
| 19 | The model registry stores a face embedding and a person group per registered model photo; G5 checks identity against it. This reverses the earlier draft's face-data non-goal (A6). A commercially licensed face-embedding model is chosen as a build task | Owner |
| 20 | Priority: new products through the normal batch flow are the main use; live listings are fixed only on request through the same flow, with no backfill programme and no order set by the business (spec 12, 10.3 and 10.4) | Owner (decided 27 Oct) |
| 21 | The evaluation programme: a nightly job and a run on every change of model, prompt or bar; a regression set from every reviewed label; the widened planted-defect set; drift and false-pass panels (spec 12, 11.5) | Owner |

## 12. Contradictions in the sources and how this document settles each

Spec 12, 13 item 16 leaves the business-only items (F00 rows 1, 3, 10, 11 and 15; EVD 9.2, 9.3, 9.4 and 9.6) to this
section; spec 12, 13 settles the build items.

**From F00 section 6 (F00 L131-149).** Rows 2, 6, 7, 8 and 9 concern lifestyle and composites only.

| # | Conflict | Settled here as |
|---|---|---|
| 1 | 5.3 base 7.3k (08 L317) vs B3 row 3.1k (06 L146); split files not in the repo | Use 08's 7.3k (owner rule); flagged |
| 3 | Mode B about 0.80 per product (DD3 L174) vs 1.00 per set (06 L146) | Show both; costs use 0.20 per generated image, 4 per set |
| 4 | DD2 R4 allows only "the brand's own photos of the same option"; mode B adds a model photo | The mode B clause in A5 (spec 12, 13 item 2) |
| 5 | Third try: stronger wording (DD2 L148) vs a stronger model (DD3 L171) | Both: wording on attempt 2, the next engine on the brand's bench on attempt 3 (spec 12, 5.2 and 5.4); priced at 0.137, the billed 2K price (DD3 L32; list 0.134) |
| 10 | Cropping in Phase 2 (I5 L344) vs 5.1a in Wave B (08 L140) | Moot: one initiative, all approvals assumed |
| 11 | 5.1b lists listing templates (08 L315), Wave C row C7 does not (08 L438) | Kept as decision 16 |
| 12 | DD2 R4 says "existing cap" and channel floors; main removed both (SPEC L55-59) | Dropped; crop size bars are owner policy values (A4) |
| 13 | DD2 R4 amends cropping and generation in one edit; 07 stages them | Two separate approvals (decisions 1 and 2) |
| 14 | SPEC line numbers differ between branches | Cite main at d82cc36 (section 10) |
| 15 | 08 was untracked | Settled: committed in 050e509 |

**From F01 (F01 L210-219).** C1 = row 10, C2 = row 12, C3 = row 13, C4 = row 11, C5 = row 14 above. C6, the "92 of
141 below 1,482 px" reason for 5.1b, is stale since the Styli floor was removed; this document argues 5.1b from
missing roles (65 of 66), not from size.

**From EVD section 9 (EVD L115-125).**
- 9.1, no apparel holdout cell (06 L261 vs L274-278; I5 L323 assumes one): value is reported by listings; conversion
  stays judged; decision 17.
- 9.2, "about 3,400 generated images once" (05 L148) includes crops and lifestyle: this document uses 241 generated
  images a year for new products (section 6) and 336 to 536 as the ceiling for live listings (section 7).
- 9.3, DD9's B2 backlog includes 77 US Polo footwear options (DD9 L144, L241-242): not counted here; US Polo apparel
  joins only when its files arrive.
- 9.4, the virtual-model tool of section 4 is 1K below its top plan (05 L69) vs "1K, 2K, 4K" (DD3 L80): this
  document follows 05 L69, which states the plan limit; it only weakens a tool we do not choose.
- 9.5, the stronger engine returned 896x1200 on a 2K request (DD4 L176), yet it is the third attempt: G6 holds any
  image whose long side is under 90% of the size asked for (spec 12, 13 item 8), so an undersized image is never
  published; it is still priced at 0.137 billed (0.134 list).
- 9.6, "1,300" is Naz's manual output a year (DD9 L192), not review capacity: review capacity is "not measured";
  decision 8 asks for names and load.
- 9.7, 2K outputs depend on the x2 enlarger for Styli, which runs by owner override (EVD L123): Styli publishes only
  after Styli's written answer (decision 11); larger native images are the fallback at about 0.05 USD more per attempt.

**Found while writing this page.**
- Apparel options: 1,746 documented (DD9 L90) vs 1,813 measured (INV summary L24); Styli / Centrepoint absence 893 /
  663 documented vs 966 / 692 measured (INV A4 L198). Most of the gap is Puma apparel, which DD9 did not count (DD9
  L173-175; INV L201-203). This page uses the measured figures; role shares stay samples.
- The brief calls Vero Moda absent from Styli and Centrepoint; the inventory shows only 12 and 16 of 107 options
  without a code (INV A4 L194). Vero Moda stays the technical test brand for its masters and flat lays (section 5).
- The brief cites SPEC non-goals at L852-858 and "Fit, never crop" at L293 (as LIVE L36-40 does); main at d82cc36
  puts them at L855-861 and L296 (spec 12, 0.5 agrees). This page uses the latter.
- The per-batch limit is described as existing (I5 L325). The existing limit covers only the automatic checks and has
  no default; spec 12 adds a separate limit for made photos, where empty means no generation (section 13 pointers).
- The earlier draft counted mode B as 5 generated images per option; the fabric close-up is a crop of the flat lay
  (spec 12, 9.3), so it is 4.
- Revision of 27 Oct. The owner set new products as the primary use (INV L7-9), so costs now lead on inflow (INV E)
  and the live-listing counts became a ceiling for work on request. The earlier draft treated the inventory counts as
  a maximum because some departments were set aside; every department is now in scope, so that caveat is gone. The
  new operator section is numbered 3.1, and sections 6 and 7 swapped content, so that section 12 keeps the number spec
  12 cites.

## 13. Sources

**Short names.** 08 = `roadmap/08-reprioritization-proposal.md`. I5 = `roadmap/initiatives/05-complete-apparel-shot-sets.md`.
03, 04, 05, 06 = `roadmap/03-image-audit.md`, `04-india-learnings.md`, `05-build-vs-buy.md`, `06-metrics-and-impact.md`.
F00, F01 = `roadmap/focus/00-overview.md`, `01-crops-5.1a-5.1b.md`. DD0, DD2, DD3, DD4, DD8, DD9 = `deep-dives/00-`,
`02-`, `03-`, `04-`, `08-`, `09-`. SPEC = `docs/SPEC.md` on main at d82cc36. MTG = the 21 Oct meeting transcript. OPG =
the operator guide. INV = `01-inventory-count.md` in this folder (measured 26 Oct). LIVE and EVD = the two explore
reports of 2026-10-26. MOS = the India competitive landscape note. Paths are under `docs/plans/` in this worktree
unless shown otherwise. Main checkout = `C:\Users\Sujan Ajay\Desktop\catalog-module`.

| Figure or claim | Path and line |
|---|---|
| Revenue rows (17.8k, 14.7k, 8.6k, 7.3k base; highs 59.5k, 28.8k, 23.2k, 16.0k); owner rule; judged lifts; holdout, treatment log, 13% join, 3A queue; re-submission and offline question | roadmap/08-reprioritization-proposal.md L7-9, L19-20, L29-32, L126-127, L177, L314-317, L540 |
| Five-role set missing 65 of 66; missing roles by code; no model 11 of 66; under 4 images 14 of 66 | roadmap/03-image-audit.md L20, L117, L120, L171 |
| Head cuts, cut products, framing; live as received; one reviewer | roadmap/03-image-audit.md L22, L25, L112-114, L148, L161, L167, L178, L207 |
| Roles defined; planner; crop rules; examples; costs; agency prices | roadmap/initiatives/05-complete-apparel-shot-sets.md L14-20, L74-80, L113-143, L206-240, L260-287 |
| Department handling matrix; the seven open questions (bottoms, maxi, lingerie, swimwear, multipacks, sports bras, kids) settled in spec 12, 3.6 | deep-dives/00-softline-taxonomy.md L262-272, L276-282 |
| Gate checks, ladder, review, exit numbers, SPEC wording | deep-dives/02-derived-shots-fidelity-gate.md L8-10, L44-50, L81-83, L111-112, L131-166 |
| Engine prices (Nano Banana 2 0.101 at 2K; Nano Banana Pro 0.134; GPT Image 2 about 0.10); 14 references per request; open-weight candidates FASHN VTON, FLUX.2 klein, Qwen-Image-Edit on our GPU; direct vendor APIs as a switch; 60 trial images over 8 models; ladder; 0.20 per accepted image; Photoroom "1K, 2K, 4K" | deep-dives/03-on-model-generation-bake-off.md L15, L17-19, L31-32, L80, L128-130, L144, L151, L161-165, L171-174 |
| Old daily cap default of 10 USD; Nano Banana Pro 896x1200 on a 2K request | deep-dives/04-footwear-bags-lifestyle.md L176, L220 |
| Model registry, rights rule, GCC sites; face embeddings as a new data class; InsightFace weights non-commercial | deep-dives/08-brand-style-profile-model-registry.md L17, L22, L64, L155, L168-173, L281 |
| Documented options per brand, absences 663 / 893 (without Puma apparel), 1,746 apparel, 1,300 | deep-dives/09-business-impact.md L68-76, L90, L144, L169-176, L192, L236-243, L724 |
| Vendor table and prices (Photoroom 1K below Enterprise, FASHN, Claid, Pixelcut, Picsart, remove.bg, Botika, OpenRouter); what we own; engine slot rules; vendor risk; gaps | roadmap/05-build-vs-buy.md L18-21, L28-45, L54-113, L127-136, L148, L158-194 |
| India lessons; Listing Optimization AI 0.16 per image | roadmap/04-india-learnings.md L59, L176, L194 |
| B2, B2e, B3 rows; 44/73 share; holdout cells | roadmap/06-metrics-and-impact.md L144-146, L178-182, L259-278 |
| Conflicts 1 to 15; F01 contradictions and three fixes | roadmap/focus/00-overview.md L131-149; roadmap/focus/01-crops-5.1a-5.1b.md L134-137, L210-219 |
| "Cut product never on image 1" | roadmap/initiatives/02-channel-ready-live-catalog.md L251 |
| SPEC lines quoted | docs/SPEC.md on main at d82cc36: L53-59, L74-75, L131, L152, L296, L397-401, L456, L805, L855-861 |
| Build rules: 0 scope, non-goals and SPEC amendments; 1.5 model policy and bench; 1.6 registry tables with face embeddings; 2.4 operator flow; 3 planner and remove-and-replace, 3.3 review rule, 3.5 carry-forward, 3.6 role lists and modesty rules per department; 4 crop engine; 5 generator client, 5.2 references and the one-image case, 5.4 model bench and bake-off; 6 gate, 6.2 G5 identity and hard blocks; 7 review, exits, relapse; 8 publish, 8.2 `cut_kept`; 9 mode B and registry; 10.1 internal test run, 10.2 scorecard, 10.3 live for new products, 10.4 on request; 11 tests, 11.5 evaluation programme; 12 acceptance (incl. operator experience) and monitoring; 13 settlements | docs/specs/12-apparel-shot-set.md |
| Spend limit for made photos (`shotSet.generateCapUsd`, empty = no generation) | docs/specs/12-apparel-shot-set.md section 1.2 |
| Spend limit for checks (`options.qaCapUsd`, empty = no limit) | main: packages/core/src/catalog/qa/caps.ts L8 |
| Contract exception: only 02 and 03 ship migrations | docs/specs/00-execution-protocol.md section 11, L260-263; spec 12, 0.4 |
| Priority note (new products primary); measured apparel options 1,813, images per option, single-image 13 / 70, no Styli / Centrepoint code 966 / 692 (882 / 655 without Puma apparel), Only and Anta, cuts and views not measurable, kids 20, live and stocked 1,454 and per channel, inflow 842 per brand and month, undated apparel 246 | proposals/2026-10-26-apparel-shot-set/01-inventory-count.md L7-9, summary L13-24, Only and Anta L45, A3 L166-168, A4 L190-203, B L205-217, kids L219-224, D L235-276, E L278-327 |
| Meeting quotes (model always, five images, image 1 front, two images, tool cost, Nitin's test) | main checkout: meetings_folder/Catalog-Module-Connect-GCC-14e47c7c-2580.md L45, L65, L70-75, L85, L101-103, L119, L195-200, L207 |
| Operator guide: never crops; re-submission | main checkout: docs/handover/catalog-for-the-operator.md L90-93, L151-157 |
| Operator flow today (wizard, attention card, product page, links sheet) | .runs/2026-10-26-map-operator-flow.md in this worktree |
| Cost ledger table | main checkout: docs/solutions/monitoring.md L82 |
| Live state; PR #91 effect; no full inventory | main checkout: .runs/2026-10-26-explore-live-state.md L13, L23, L36-42 |
| Evidence contradictions 9.1 to 9.7; review capacity not stated; "3,350" unit unclear | main checkout: .runs/2026-10-26-explore-roadmap-evidence.md L71-72, L115-125 |
| Generation commoditised at about 0.16 USD an image; model ids never in operator copy | main checkout: catalog_initiative_india/mosaic-competitive-landscape.md L5; AGENTS.md |

Status: draft for business approval (revised 2026-10-27)
