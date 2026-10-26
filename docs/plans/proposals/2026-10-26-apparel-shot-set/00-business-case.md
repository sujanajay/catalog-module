# Complete the apparel shot set: business case

Date: 2026-10-26. Documents only: nothing was built, no code changed, no paid call was run. One initiative made of
5.1a (crops for conversion), 5.1b (crops completing the Styli and Centrepoint set), 5.2 (generated missing roles) and
5.3 (flat lay to on-model); it replaces the two earlier focus pages for crops and generation. The build detail is
spec 12 (`docs/specs/12-apparel-shot-set.md`; "spec 12, 3.3" means its section 3.3). Every approval is assumed granted
(section 11 lists them); the only question is how, from first principles, we solve the problem. No time, duration or
effort figures (owner rule, 08 L7-9); revenue is copied from 08, never re-estimated. Pointers in brackets, such as
"(03 L20)", name a source document and its line ("L"); the key to the short names is in section 13.

**Words used throughout.** An **option** is one product in one colour (also called a style-colour), the unit the
channels list. A **master** is the largest original photo file the brand sends. A **made photo** is a crop or a
generated photo, never the brand's own.

## 1. Bottom line

1. **What:** give every apparel product the five photos the channels ask for, by filling cut or missing photos in a
   fixed order: the brand's own photo, then a crop of a bigger brand photo, then a generated photo, else a plain "not
   made" reason. A cut image comes down only in the same publish that puts its checked replacement up.
2. **Why:** 65 of 66 sampled apparel products lack the five-photo set (03 L20); of 1,813 apparel options, 966 have no
   Styli code and 692 no Centrepoint code (INV A4, measured). 08 values the four parts at 48.4k USD a year base (section 8).
3. **What it costs:** crops about nothing; generated images about 0.20 USD each once accepted (DD3 L174). The known
   backlog costs about 67 to 107 USD to generate, at most about 193 USD in a pessimistic case with checks and re-renders,
   against 1.5k to 2.9k USD at agency prices (section 6).
4. **What we ask:** approve it as one move with the rules in sections 3 and 5 and the decisions in section 11; run
   every softline brand in one test run, Vero Moda's batch first; let the per-brand scorecard pick the fix order.
5. **How we know it worked:** apparel listings newly live on Styli and Centrepoint, counted one by one (section 8).

## 2. The problem, as a shopper and a marketplace see it

**Cut heads and cut products are live today.** The brands' photos go to the marketplaces as received: on 37 Trendyol
UAE listings compared with the raw files, about 9 in 10 showed the brand photos at most resized, padded or
reordered, and none had been reshot or repaired (03 L25, L148). From the audit sample of 141 softline products:

| What a shopper sees | Count in the sample | Source |
|---|---|---|
| Model's head cut off on an on-model photo | 15 of 64 on-model products | 03 L22, L112 |
| Head cut on an on-model photo, against the Styli and Centrepoint rule | 13 of 66 apparel products | 03 L167 |
| Product cut by the frame on image 1 (Noon names this as a rejection reason) | 6 of 141 (6 of 66 apparel) | 03 L113, L161 |
| Framing problems alone (head cut or product cut on image 1) | 19 of 66 apparel | 03 L178 |

These are the brands' own cuts, not cuts the module made (LIVE L13). Today the module passes such a photo through:
it places the cut edge flush against the edge of the picture, adds the note "Photo N: already cut at the frame
edge" and never holds it (OPG L90-93). Since PR #91 (a recent module change that lets cut photos through on every
channel) a cut product is made on every channel, image 1 included, so the gap is wider than before (LIVE L42). The
operator's only advice today is "ask the brand for an uncut photo" (OPG L93). These counts come from one reviewer on a
random sample (03 L207). They stay sample figures: the measured inventory could not read cut flags or views, because
the catalog database was skipped (INV B L201-213).

**The five-role set.** A **role** is one required kind of photo. Styli and Centrepoint ask for five (I5 L14-15):

| Code | Role | Plain meaning |
|---|---|---|
| FM | Front, mid-thigh | Model from the head down to mid-thigh, facing the camera |
| FL | Full length | Model head to toe |
| FC | Fabric close-up | The fabric up close, without the model's face |
| BH | Back, at the hips | Model's back, from the head down to the hips |
| HS | Head and shoulders | Face and shoulders, cut below the bust |

On Styli and Centrepoint garments always need a model (MTG L65), image 1 must be the front (MTG L101-103), and a
cut close-up is fine as long as it is "not cut like from the head" (MTG L70-75). Namshi, Noon and Trendyol "don't
really check", but "for a good catalog, at least five are required" (MTG L45).

**Most of our apparel does not have the set.** 65 of 66 sampled apparel products lack it; 60 of 66 still fail if the
fabric close-up is not required (03 L20). Missing roles across the 66: HS 57, FC 31, FM 25, BH 19, FL 14 (03 L120).
11 of 66 have no model photo at all (03 L117). The effect on listings: of 1,813 apparel options, 966 have no Styli code
and 692 no Centrepoint code (measured, INV A4 L194; the documents said 893 and 663, DD9 L173-175). A blank code means
"not set up", which can also be a commercial choice (INV L197-198).

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
   role from the brand's own photos of the same option (I5 L18).
4. **Flat lay to on-model (mode B).** For a product photographed only lying flat, put the garment on one of the
   brand's own models: a full-length shot first, approved by a person as the **anchor**, then the other on-model
   roles made from it; the fabric close-up is a crop of the flat lay (I5 L156-160; spec 12, 9.3).
5. **Not made, with a plain reason** on the links sheet, for example "Not made: the photo is too small to cut a head
   and shoulders from it" or "No approved brand model for Vero Moda women yet" (I5 L122-123; spec 12, 3.7).

Crop rules (DD2 L131-135; spec 12, 4): cut only from a photo whose head is whole, with at least 5% margin above the
head; the cut sits in the role's band (FM mid-thigh, BH hips, HS below the bust) and never through a logo, text or
buckle; BH only from a real back photo, never a mirrored front; FC from a flat lay for now, from a skin-free fabric
area of an on-model photo later; never a soft, enlarged crop. FL can never be cut from a tighter shot (DD2 L8).

**What is left out for now** (spec 12, 0.2 and 3.6). Bottoms, lingerie, swimwear, multipacks and kids: their roles are
reported, a role is never called missing and nothing is cropped or generated until the owner answers the open
questions on role lists for these garments (DD0 open items 1 to 7). Maxi dresses get no FM crop. A printed garment is
crop-only unless the brand allows generation for prints.

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

**The fidelity gate.** A **fidelity gate** is a set of measured, automatic checks a generated image must pass before
a person sees it; if any check fails, the image is held, never published (I5 L166-177; DD2 L137-148; spec 12, 6).
There is no averaging: one failed check holds the image.

| Check | What it asks |
|---|---|
| G1 garment | Is it the same garment as the brand's photo? Two AI judges must agree |
| G2 logo and text | Does every logo and word read the same, with nothing invented? |
| G3 colour | Are the main garment colours within the colour bar? |
| G4 texture and print | Do the fabric and print look the same up close? |
| G5 model and scene | Same person, lighting and background across the set; no face data stored |
| G6 framing | Head whole with margin, cut in the role's band, correct frame shape and full requested size |

A generated image gets at most three attempts in all: the second with stronger wording, the third with a stronger
model; then the hold stands (spec 12, 6.3 and 13 item 1). A held photo can only be published through the two-rater
review, never by one person, and never if it was held for a wrong garment or a changed logo or text (spec 12, 7.2).
Every made photo is labelled as cut or generated, with a record of where it came from, and every generated file
carries a hidden "made by AI" marker (spec 12, 1.1 and 5.2). **Review-all** means a person also sees every generated
image before it publishes, until the gate has proven itself on labelled images (DD2 L150-155; spec 12, 7). Why every
image: in trials every generator redrew prints (7 of 7) and some moved a label (DD3 L17, L128-130). A gate that the
vendor does not run is what makes a bought generator safe to use.

**Why crops come before generation.** India had only one front image per product, so "the full image suite must be
generated from that one reference" (04 L194). GCC holds bigger photos: crop first, generate second, and keep that
order (04 L194). A crop changes no pixel, costs nothing and needs no generator, rights or vendor (08 L56-63).

## 4. Why we build the platform and buy only the engine

**The market, tool by tool** (05 L54-111; DD3 L19, L62-104). Prices are list prices read on one day, in USD. "2K"
means about 1,800 x 2,400 pixels; "1K" about half that on each side.

| Tool | What it does | Price | Why it fails us as the solution |
|---|---|---|---|
| Photoroom (Plus, Virtual Model) | Cut-out, AI shadows, virtual model, flat lay, ghost mannequin | 0.02 Basic, 0.10 Plus per image; Enterprise needs 200,000 images a year (05 L74-75) | Low resolution (1K) unless we commit to 200,000 images a year (05 L69); US-only servers; training statements conflict (05 L82-86); fixed image quality; no marketplace sizes (05 L72) |
| FASHN Product-to-Model | Flat lay or product onto a person | 0.225 per 2K image on demand (05 L108) | One view per call; outputs kept on its servers 3 days; no five-role set with one model |
| Claid AI fashion | On-model images, backgrounds, upscale | 0.118 per image (05 L103) | One view per call; dearer than the engine we chose |
| Pixelcut | Try-on, backgrounds, upscale | 0.05 to 0.10 (05 L104) | Garment swap only |
| Picsart | Background removal, expand, templates | credit packs; per call not readable (05 L105) | Not fashion-specific |
| remove.bg | Background removal | subscription (05 L106) | Standalone service closes 1 December 2026 |
| Botika | Synthetic models | about 0.92 a photo (05 L109) | No public API |
| Vue.ai, Lalaland, ZMO, Veesual, Huhu | On-model fashion | not public (05 L110) | No GCC marketplace reference found |
| Google Vertex Virtual Try-On | Garment swap on a person | not reachable on the pricing page (DD2 L112) | Garment swap only, 1024 px square |
| A free model run on our own servers | Try-on and view models | server time only (DD3 L163) | Small images (576x864) or a weaker likeness |
| Listing Optimization AI | Amazon images and A+ | about 0.16 per image (04 L176) | Amazon only; a price anchor, not a fit |

What none of them does: keep the product's pixels unchanged (every model redrew prints, DD3 L17); make the five roles
with one consistent model (DD3 L19); know Styli guides, Centrepoint's canvas or Noon's margins (05 L127, L136); run
an independent check of its own output (05 L135); record what changed and why; follow our channel rules.

**What we buy.** The image generator itself, as a swappable engine behind our own gate: Nano Banana 2 through
OpenRouter's image service first, at 0.101 USD per 2K image (DD3 L31), with Nano Banana Pro (0.134 at 2K, DD3 L32) as
the third attempt, FASHN Product-to-Model as the second engine to trial for mode B, and Photoroom Virtual Model third
only if it beats both on our gate (05 L18-21, L158-160; DD3 L171). "The engine only returns pixels" (05 L169): every
size, margin, background and check is ours, so changing vendor never changes channel compliance (05 L168-175). The
generator client, its policy and its spend limits are in spec 12, 5.

**What we already own that no vendor sells** (05 L28-39): cut-out with its guard rules; per-channel render for 9
channels; compliance checks; the two-model judge with automatic repair; output evals; publish to fixed links with
verification; the links sheet; the cost ledger per call, image and channel; review cards; product locks that stop a
batch from touching any other product. All of it costs about 0.004 to 0.012 USD per option (05 L44-45).

**Price.** Agencies charge about INR 500 to 800 per option for generated images, 5.95 to 9.52 USD (I5 L273). Our
engine costs about 0.20 USD per accepted image, assuming about two attempts (DD3 L174); a five-shot set about 1.00 USD
(INR 84), 6 to 10 times cheaper than one agency option (I5 L285-286). Generation itself is a commodity priced near
0.16 USD an image (MOS L5); what the market does not sell is the channel-specific quality around it.

**Nitin's test.** In the meeting Nitin said that if buying costs an extra "$5,000... screw it, move on", and "copy
with pride" (MTG L198, L207). The figures:
- A bought tool against ours, for the generated backlog of up to 536 images (section 6): 536 x 0.225 = 120.60 USD on
  FASHN, or 536 x 0.10 = 53.60 USD on Photoroom Plus, against 536 x 0.20 = 107.20 USD ours. The money gap is tiny
  either way, so capability decides, not price.
- Against an agency: 1.5k to 2.9k USD for the generated part against about 67 to 107 USD ours (section 6). The gap is
  under 5,000 USD, so on money alone his test says "buy".
- Every option missing a role sent to an agency: about 1,093 options x 5.95 to 9.52 USD = 6.5k to 10.4k USD, where
  crops would cost about 0 (section 6). This gap is above 5,000 USD.
- Above all, no tool on the market does the job: buying a tool still leaves the planner, crops, gate and channel
  rules to build. So we do what Nitin described: buy "tool number one" and make "another wrapper on top of it",
  swapping to tool two or three, "whoever gives you a better rate" (MTG L200).

**Gaps in this evaluation, said plainly.** No volume quotes were asked for (05 L194). Public vendor samples were not
compared (05 L113). Flat-lay specialists (Photoroom Flat Lay, Ghost Mannequin) were only listed, with no price or test
(05 L71). No crop vendor was looked at; cropping is "Build" (05 L129). The trials were 60 images across 8 models;
none ran at volume (DD3 L15, L151). India's negotiated vendor summary was never seen (04 L59).

## 5. Test on every softline brand, then fix in order

**There is no pilot brand** (spec 12, 10.1). The test run is one batch per apparel brand covering every apparel
product of that brand in the owner's folders, on every channel: French Connection, Penti, Vero Moda, Cardio Bunny,
Nautica and Puma apparel (INV summary L11-16). Vero Moda's batch runs first; the others follow. Only and Anta are not
in the product master (INV L41), so they are not in this page's counts; their photos are covered when they are in the
owner's folders. US Polo apparel joins the day its files arrive: its warehouse catalogue is footwear only today (DD2 L9).
Test batches go to a test area that no live channel or marketplace sees.

**How the test run works.**
- Review-all for everything: two raters see every generated image, and one person decides every swap card for a crop
  that retires a cut photo. A crop that fills an empty slot goes through on the automatic checks.
- Every batch has a spend limit for made photos, set per batch and never left empty in the test run; empty means no
  generation at all. A separate limit for the automatic checks exists today and has no default, so empty there means
  no limit (pointers in section 13). The values are decision 14.
- Nothing is published that failed a check; nothing is removed that has no replacement (section 3).

**The per-brand scorecard it produces** (per batch and per brand, on the Ops page and as a file; spec 12, 10.2):

| Field | What it tells the business |
|---|---|
| Products, apparel products | Size of the batch |
| Complete sets before and after, per channel | How far each brand moved toward the five-role set |
| Roles filled by existing photo, crop, mode A, mode B | How much is fixed for free and how much needs the engine |
| Not made, per reason | What only the brand can fix (small photos, no whole head, no approved model, left out) |
| Cut photos found, replaced, still live | The remove-and-replace measure itself |
| First-attempt gate pass rate; holds by check | How often generated images pass, and what fails |
| Review counts and agreement; false passes and false holds | Whether the gate can be trusted for this brand |
| Cost per accepted image, attempts per accepted image | From the cost ledger |
| Styli and Centrepoint eligible | Products with all five roles live on that channel |
| Coverage | Apparel products in the batch against the brand's options in the inventory count ("<a> of <b>") |
| Swaps | Swap cards decided yes and no; cut photos kept because no required role replaces them |

**The business picks the fix order from the scorecard**, not from a guess; nothing in the module ranks brands. A
technical test on one brand before the full run is fine, but it is a test, not a gate.

**Why Vero Moda goes first.** Its EAN folder (the brand's photo folder, filed by product barcode) holds masters of
about 5000x6700 px (I5 L74, L142), 3 of 12 sampled apparel sets have no model photo (I5 L46), and it ships a flat lay
as the last image on 5 of 8 sampled options (DD2 L50), so one batch exercises crops, mode A and mode B. One
correction: Vero Moda is mostly set up on both channels: of its 107 apparel options, only 12 lack a Styli code and 16
a Centrepoint code (INV A4 L190). The largest gaps are French Connection (665 Styli, 366 Centrepoint) and Nautica (159
and 159). So Vero Moda tests the machinery; the eligibility gain will show mainly on other brands.

**Leaving review-all, per brand, with two separate exits** (spec 12, 7.4):
- **Generated photos.** Overall, at least 300 labelled generated images over at least three brands and all five
  roles; false passes (gate passed, person rejected) 2% or less, with none on garment or logo; false holds (gate held,
  person accepted) 15% or less; planted defects caught 100%; and the two reviewers agree well enough (a standard
  agreement score of 0.67 or more on every question). The brand itself also needs at least 50 labelled images with no
  false pass on garment or logo. After exit, a 10% sample still goes to two raters. A batch over 2% false passes, or
  any false pass on garment or logo, sends the brand back to review-all at once; exit then needs 50 new labelled images.
- **Crops.** 50 swap cards in a row approved for the brand, with no rejection and no reported head or logo cut. After
  exit, passing crops retire cut photos automatically and a 10% sample still goes to swap cards; any rejection sends
  the brand's crops back to swap cards. Crops usually exit first, so a crop-only brand reaches automatic swaps without
  generating anything.

## 6. Existing inventory and what fixing it costs

Counts come from the measured inventory of 26 Oct 2026 (INV). Two things could not be measured: which photos are cut
and which view each photo shows, because the catalog database was skipped (it needs a password from the secret store)
and the warehouse has image counts, not roles (INV B L201-213). Those rows keep the audit sample and say "sample".

**By brand** (INV summary L9-20, A4 L186-198, D L231-272). "Live and stocked" counts options that a daily marketplace
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
  blank master option id (INV L163). 188 options show 3 images or fewer, so they cannot hold five roles as they stand.
- **Styli and Centrepoint absence:** measured 966 options with no Styli code and 692 with no Centrepoint code (INV A4
  L194), against the documented 893 and 663 (DD9 L173-175), which left out Puma apparel; without it today's figures
  are 882 and 655 (INV L197-198). This document uses the measured figures. A blank code means "not set up", not
  proven "not live".
- **Live and stocked apparel options by channel** (INV D): Noon 1,369, Namshi 1,369, Trendyol 1,195, Amazon 1,042
  (Amazon overstates). Styli, Centrepoint, 6thStreet, VogaCloset and Shein have no liveness feed, so their pages
  cannot be counted (INV L270-272).
- **Upper bound.** These counts include garments the build leaves out for now (section 3): 20 apparel kids options
  (Penti 12, Puma apparel 8; INV L215-220), Penti's intimates and pyjamas (DD2 L50), and any bottoms, swimwear or
  multipacks. Their share was not measured, so every count below is an upper bound.

**Images by ladder rung** (measured option base; role shares from the samples because view roles could not be read):

| Rung | Arithmetic | Count | Cost each (USD) |
|---|---|---|---|
| Options missing a front, back or close-up | 1,813 x 44/73 (sample share, 06 L178) | about 1,093 | |
| Live options with a head-cut photo to replace | 1,454 live x 13/66 (sample share, 03 L167) | about 286 options | |
| Crops | about 1.5 per option needing a role, sample ratio 36 on 24 options (DD2 L44-48): 1,093 x 1.5 | about 1,640, sample | about 0, inside the render (I5 L264) |
| Mode A, generated missing roles | 1,093 x 5/24 (sample share, DD2 F2 via 06 L182) | about 228 images | 0.20 per accepted image |
| Mode B, flat lay to on-model, low | Vero Moda 107 master options x 3/12 (sample share, I5 L46) = 27 options x 4 generated (FC is a crop) | 108 images | 0.20 per image, or 0.80 per set |
| Mode B, flat lay to on-model, high | Vero Moda 308 Trendyol options x 3/12 = 77 options x 4 | 308 images | same |
| **Generated total** | 228 + 108, or 228 + 308 | **336 to 536** | |

The documented totals were 369 (06 counts) and 765 (DD9 counts) (I5 L183, L263); the measured base replaces them.
Only and Anta are not in the master, so their flat packshots are not in these counts (INV L41).

**Backlog cost in USD** (count x unit price; 0.20 assumes about two attempts per accepted image, DD3 L174, not yet
measured):

| Line | Low (336 images) | High (536 images) |
|---|---|---|
| Generated, at 0.20 per accepted image | 336 x 0.20 = 67.20 | 536 x 0.20 = 107.20 |
| Pessimistic: 3 attempts at 0.10 = 0.30 per accepted image | 336 x 0.30 = 100.80 | 536 x 0.30 = 160.80 |
| Same, with the stronger model as the third attempt (0.10 + 0.10 + 0.134 = 0.334) | 336 x 0.334 = 112.22 | 536 x 0.334 = 179.02 |
| Automatic checks: under a tenth of a cent per attempt (0.00075, DD2 L111), 3 attempts each | 336 x 3 x 0.00075 = 0.76 | 536 x 3 x 0.00075 = 1.21 |
| Re-render of every touched option on all channels (05 L45) | 1,093 x 0.0119 = 13.01 | 13.01 |
| **Pessimistic total** (0.334 line + checks + re-render) | **about 126** | **about 193** |
| If Styli wants larger images than the 2K output enlarged x2 (DD3 L174; I5 L309) | about 0.05 USD more per attempt | same |

**Agency comparison** (INR 500 to 800 = 5.95 to 9.52 USD per option, I5 L273). Generated part: 228 + 27 = 255
options x 5.95 to 9.52 = 1.5k to 2.4k USD (low), or 228 + 77 = 305 x 5.95 to 9.52 = 1.8k to 2.9k USD (high). Every
option missing a role: 1,093 x 5.95 to 9.52 = 6.5k to 10.4k USD. This is spend avoided, not cash saved: the agency
does not make these images for us today (I5 L275-276).

**Review load.** Every generated image is reviewed by two raters until the brand exits: 336 to 536 images, at least
300 of them labelled for the exit (spec 12, 7.4). Crops that retire a cut photo go to a one-person swap card until the
brand's crop exit: at most about 286 live options (sample share), and at least 50 swap cards per brand before automatic
swaps. Crops that fill an empty slot need no card. Review capacity is not measured anywhere (EVD L72).

**Pacing under the spend limit.** Spend per batch never exceeds the limit set for that batch (decision 14; backfill
order in spec 12, 10.3: crops first for every brand, then mode A in the order the business sets, then mode B). Example
only: at 10 USD per batch (the old daily default, DD4 L220), one batch accepts about 50 images at 0.20 or 33 at 0.30,
so the 536-image high case fits in about 11 to 17 limited batches. Pacing is set by review, not by money.

## 7. New products going forward

The steady state is specified in spec 12, 10.3.

- **Inflow, measured:** 842 new apparel options from May to 25 Oct 2026, about 140 a month, arriving in seasonal drops
  (French Connection 227 in September, Penti 228 in June) (INV E L274-323). May and June may include older stock, and
  246 apparel options have no date (INV L319-323). The documents also give "about 3,350 more soon" across all
  categories (SPEC L152, R15a; the unit is unclear, EVD L71) and about 196 apparel options a year needing generation
  (I5 L287).
- **Cost per new apparel option:** crops about 0; mode A 0.20 to 0.40 USD (one or two roles); mode B about 0.80 to
  1.00 USD (DD3 L174; 06 L146). Applied to the measured inflow with the sample shares of section 6: 842 x 44/73 x
  5/24 = about 106 generated images, so 106 x 0.20 to 0.30 = 21 to 32 USD, against 106 x 5.95 to 9.52 = 0.6k to 1.0k
  USD at agency prices.
- **In the upload wizard:** "Complete shot sets" (crops) and "Make missing photos" (generation, shown only for brands
  allowed to generate) are both unticked by default, and a "Limit for made photos (USD)" is required when generation
  is ticked (spec 12, 10.3).
- **Review:** generated images and cut-photo swaps as in section 3, per the brand's phase.
- **A real photo always wins.** Made photos are numbered from 101 up and have their own links. When a brand later
  sends an uncut photo for a role we generated or cropped, the made photo is removed in the same publish that puts the
  brand photo live; the brand photo gets a new link and the sheet says "Photo <n> was replaced by the brand's own photo
  <m>." The operator re-submits the change in each portal (spec 12, 3.5; OPG L151-157).
- **What to ask brands to send, so generation becomes the exception:** masters of 2,400 px or more on the long side
  (DD2 L135); uncut photos with the head whole and space above it; all five roles where a shoot allows, with a real
  back photo; a flat lay as the last image (DD2 L50). A 2,400 px master turns an HS crop from a full-length shot into
  about 900 px, which clears every channel except Centrepoint without a flag (DD2 L81).

## 8. What we measure and report

**Value as 08 states it** (USD a year; judged, not measured, 08 L19-20):

| Part | Low | Base | High | Source |
|---|---|---|---|---|
| 5.1a crops for conversion | 0 | 17.8k | 59.5k | 08 L314 |
| 5.1b crops completing the Styli / Centrepoint set | 0 | 14.7k | 28.8k | 08 L315 |
| 5.2 generated missing roles | 0 | 8.6k | 23.2k | 08 L316 |
| 5.3 flat lay to on-model | 0.9k | 7.3k | 16.0k | 08 L317 |
| **Sum of the four rows** | **0.9k** | **48.4k** | **127.5k** | arithmetic; 5.0 (2.3k) is separate |

**What we report** (the scorecard of section 5, plus monitoring and cost alerts in spec 12, 12.2):

| Measure | How it is counted | Baseline | Source |
|---|---|---|---|
| Listings newly live on Styli and Centrepoint | Options with all five roles that were absent, then live; their sales against Centrepoint about 115 and Styli about 25 USD per listed option a year | 966 / 692 with no Styli / Centrepoint code, measured (documented 893 / 663) | INV A4; I5 L103, L320-322 |
| Role coverage per brand | Share of products with each role, split by brand photo, crop, generated, "not made" | five-role set on 1 of 66 sampled | I5 L99, L316-317 |
| Cut photos replaced | Found, replaced and still live, per brand and channel | 13 of 66 sampled apparel with a head cut | 03 L167; spec 12, 10.2 |
| Gate quality | False passes and false holds against people's labels | none yet; bars 2% and 15% | spec 12, 7.4 |
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
| Using a model's likeness without rights | Only two brands have GCC sites; one brand's site bans AI bots (DD8 L17, L22) | Model photos only from sites under a recorded written grant, private, never published; synthetic model only as an approved fallback (DD8 L168-173, L281; spec 12, 9) |
| Modesty in GCC | Swimwear and lingerie never probed (DD3 L144); most Penti and Cardio Bunny photos ruled out (I5 L306) | Never more skin than the references; review-all; bottoms, lingerie, swimwear, multipacks and kids left out until the owner answers DD0 open items 1 to 7 (spec 12, 0.2) |
| Redrawn logos and prints | Prints redrawn 7 of 7; labels moved (DD3 L17) | G2 and G4 hold them; a photo held on logo or text can never be published; printed items stay crop-only unless the brand allows it (I5 L305; spec 12, 3.6) |
| Channel refuses generated or upscaled images | Styli and Centrepoint acceptance unknown (I5 L309) | Written answers from both before the first publish there (decision 11); larger native images for Styli if required |
| A channel or brand objects to made photos | No pull-back path in the build yet | Decision 18: a way to remove every made photo of a brand or channel at once |
| Vendor changes price or closes | A background-removal service closes; another vendor cut its rate limit (05 L188-189) | Engine slot swappable; our gate picks the engine per brand and category (05 L171-172) |
| Review capacity | Not measured anywhere (EVD L72) | Crops first; one batch per brand; spend limit per batch; exit only on the numbers in section 5 |
| Brand photos leaving our cloud | Engines run outside our cloud; abuse logs kept "for a limited period" (I5 L308) | Written no-training position from the vendor before any live run |
| Pages that cannot sell (no stock, wrong price) | The 3A target queue exists to filter these (08 L126) | The scorecard shows coverage and live counts; images alone do not unlock them |
| Small masters | 800x1200 inputs fail Styli's bar (DD2 L10) | "Not made" reason, never a soft crop; ask the brand for 2,400 px masters |
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
- A5, L857-859, non-goal "No generative edits or paid image APIs": replaced by generated on-model shots only for a
  missing role, only by an owner-approved generator, always gated, reviewed by two people until the brand's exit.
- A6, new non-goal: no face recognition and no stored face data.
- A7, new non-goal: brand model photos only from sites under a written grant, kept private, never published.
- A8, L53-54: "No paid image API without a separate owner yes" gains the one approved exception, the image generator.
- Models table, L456: the generator and the gate's measuring tools are listed.
- L397-401: the list of changes the operator re-submits gains "role added", "cut replaced" and "pending review".
- L805: the list of approved database changes gains spec 12's one (see decision 3).
- After L75: a product with more than 100 photos fails ingest, because numbers from 101 are kept for made photos.
- AGENTS.md (with A7): one job may write private model photos under its own folder.
- Decisions log: the contract exception (decision 3) and one line per brand exit.

**New in the product.** Every made photo is labelled as cut or generated, with a record of where it came from
(spec 12, 1). Shot roles shown to the operator per photo (08 L211; spec 12, 2). A review card for each generated photo:
the product's brand photos beside the made photo, six yes or no questions (same garment, logos and text, colour, print
and fabric, model and scene, hands and framing) and "Publish this photo?"; two raters, a third person on disagreement
(spec 12, 7.1 and 7.2). A swap card for each crop that retires a cut photo: the two side by side, three questions
(whole head and product, whole logos and text, same product and right shot type) and "Swap now?" (spec 12, 7.1). A
made photo is a source of its own, so a later batch carries it forward instead of deleting it (spec 12, 3.5). Mode B's
model registry, rights and anchor flow are spec 12, 9. The operator's note "The tool never crops" (OPG L93) is
rewritten (spec 12, 12.3). No model or vendor name ever appears in operator copy (AGENTS.md; I5 L19-20). Tests and
evals: spec 12, 11.

**What it evolves into.** The treatment log records every published image with its role, label, position and upload
date, and ties it to sales; only 13% of content joins to sales today (08 L127, L177). The module then learns which
roles and treatments sell, per brand and channel. The end state: every required role on every product on every
channel, with brand photos first, crops second and generation the exception.

## 11. Decisions and asks, assumed granted (listed for the record)

| # | Decision or ask | Whose |
|---|---|---|
| 1 | Cropping SPEC amendments A1 to A4, with the three fixes of the crops focus page; approved on their own | Owner |
| 2 | Generation SPEC amendments A5 to A8 and the models table, with the mode B clause allowing one approved brand-model reference; approved on their own | Owner |
| 3 | The contract exception, typed by the owner and committed in its own docs change before any build work: the execution protocol (section 11, L260-263) lets only specs 02 and 03 ship a database migration; spec 12 needs its migration `0003_shot_set.sql` and additive changes to the 02 contracts. Without it the build is blocked | Owner |
| 4 | One approved generator, swappable, with a stronger model as the third attempt | Owner |
| 5 | Written no-training position from the generator vendor | Vendor; owner asks |
| 6 | Brand rights for model reference photos, per brand and per site | Owner, brands |
| 7 | Brand consent for generated photos of its own products (mode A), separate from model-photo rights | Brands; brand managers ask |
| 8 | The second rater named, plus a third person for disagreements; who reviews and how many cards each can take | Owner |
| 9 | Role lists for bottoms, maxi dresses, lingerie, swimwear, multipacks and kids (DD0 open items 1 to 7); whether accessories the reference model wears may stay | Owner |
| 10 | Who re-submits changed images in each marketplace portal, and does any channel take a listing offline for re-review | Owner (08 L540) |
| 11 | Styli and Centrepoint written image specs, incl. on-model fabric crops, generated and enlarged images, and any AI labelling rule | Channels; channel managers ask |
| 12 | Masters of 2,400 px or more from every apparel brand | Brands; brand managers ask |
| 13 | Gate bars and the two exits (generated: section 5 numbers; crops: 50 approved swap cards in a row, no rejection); minimum crop size per channel | Owner |
| 14 | The spend limit for made photos, set on every batch (empty means no generation); the limit for automatic checks, which has no default | Owner |
| 15 | Role list and channel rule table, incl. "cut product never image 1" (08 L535) | Owner |
| 16 | A listing route for Styli and Centrepoint for newly eligible options | Brand and channel managers |
| 17 | An apparel holdout cell, if the business wants conversion measured | Owner, data team |
| 18 | A pull-back path: remove every made photo of a brand or a channel at once if either objects | Owner |

## 12. Contradictions in the sources and how this document settles each

Spec 12, 13 item 16 leaves the business-only items (F00 rows 1, 3, 10, 11 and 15; EVD 9.2, 9.3, 9.4 and 9.6) to this
section; spec 12, 13 settles the build items.

**From F00 section 6 (F00 L131-149).** Rows 2, 6, 7, 8 and 9 concern lifestyle and composites only.

| # | Conflict | Settled here as |
|---|---|---|
| 1 | 5.3 base 7.3k (08 L317) vs B3 row 3.1k (06 L146); split files not in the repo | Use 08's 7.3k (owner rule); flagged |
| 3 | Mode B about 0.80 per product (DD3 L174) vs 1.00 per set (06 L146) | Show both; costs use 0.20 per generated image, 4 per set |
| 4 | DD2 R4 allows only "the brand's own photos of the same option"; mode B adds a model photo | The mode B clause in A5 (spec 12, 13 item 2) |
| 5 | Third try: stronger wording (DD2 L148) vs a stronger model (DD3 L171) | Both: wording on attempt 2, the stronger model on attempt 3 (spec 12, 13 item 1); priced at 0.134 |
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
- 9.2, "about 3,400 generated images once" (05 L148) includes crops and lifestyle: this document uses 336 to 536
  generated images (section 6).
- 9.3, DD9's B2 backlog includes 77 US Polo footwear options (DD9 L144, L241-242): excluded here; US Polo apparel
  joins only when its files arrive.
- 9.4, the virtual-model tool of section 4 is 1K below its top plan (05 L69) vs "1K, 2K, 4K" (DD3 L80): this
  document follows 05 L69, which states the plan limit; it only weakens a tool we do not choose.
- 9.5, the stronger model returned 896x1200 on a 2K request (DD4 L176), yet it is the third attempt: G6 holds any
  image whose long side is under 90% of the size asked for (spec 12, 13 item 8), so an undersized image is never
  published; it is still priced at 0.134.
- 9.6, "1,300" is Naz's manual output a year (DD9 L192), not review capacity: review capacity is "not measured";
  decision 8 asks for names and load.
- 9.7, 2K outputs depend on the x2 enlarger for Styli, which runs by owner override (EVD L123): Styli publishes only
  after Styli's written answer (decision 11); larger native images are the fallback at about 0.05 USD more per attempt.

**Found while writing this page.**
- Apparel options: 1,746 documented (DD9 L90) vs 1,813 measured (INV summary L20); Styli / Centrepoint absence 893 /
  663 documented vs 966 / 692 measured (INV A4 L194). Most of the gap is Puma apparel, which DD9 left out (DD9
  L173-175; INV L197-198). This page uses the measured figures; role shares stay samples.
- The brief calls Vero Moda absent from Styli and Centrepoint; the inventory shows only 12 and 16 of 107 options
  without a code (INV A4 L190). Vero Moda still goes first for its masters and flat lays (section 5).
- The brief cites SPEC non-goals at L852-858 and "Fit, never crop" at L293 (as LIVE L36-40 does); main at d82cc36
  puts them at L855-861 and L296 (spec 12, 0.5 agrees). This page uses the latter.
- The per-batch limit is described as existing (I5 L325). The existing limit covers only the automatic checks and has
  no default; spec 12 adds a separate limit for made photos, where empty means no generation (section 13 pointers).
- The earlier draft counted mode B as 5 generated images per option; the fabric close-up is a crop of the flat lay
  (spec 12, 9.3), so it is 4.

## 13. Sources

**Short names.** 08 = `roadmap/08-reprioritization-proposal.md`. I5 = `roadmap/initiatives/05-complete-apparel-shot-sets.md`.
03, 04, 05, 06 = `roadmap/03-image-audit.md`, `04-india-learnings.md`, `05-build-vs-buy.md`, `06-metrics-and-impact.md`.
F00, F01 = `roadmap/focus/00-overview.md`, `01-crops-5.1a-5.1b.md`. DD2, DD3, DD4, DD8, DD9 = `deep-dives/02-`, `03-`,
`04-`, `08-`, `09-`. SPEC = `docs/SPEC.md` on main at d82cc36. MTG = the 21 Oct meeting transcript. OPG = the operator
guide. INV = `01-inventory-count.md` in this folder (measured 26 Oct). LIVE and EVD = the two explore reports of
2026-10-26. MOS = the India competitive landscape note. Paths are under `docs/plans/` in this worktree unless shown
otherwise. Main checkout = `C:\Users\Sujan Ajay\Desktop\catalog-module`.

| Figure or claim | Path and line |
|---|---|
| Revenue rows (17.8k, 14.7k, 8.6k, 7.3k base; highs 59.5k, 28.8k, 23.2k, 16.0k); owner rule; judged lifts; holdout, treatment log, 13% join, 3A queue; re-submission and offline question | roadmap/08-reprioritization-proposal.md L7-9, L19-20, L29-32, L126-127, L177, L314-317, L540 |
| Five-role set missing 65 of 66; missing roles by code; no model 11 of 66; under 4 images 14 of 66 | roadmap/03-image-audit.md L20, L117, L120, L171 |
| Head cuts, cut products, framing; live as received; one reviewer | roadmap/03-image-audit.md L22, L25, L112-114, L148, L161, L167, L178, L207 |
| Roles defined; planner; crop rules; examples; costs; agency prices | roadmap/initiatives/05-complete-apparel-shot-sets.md L14-20, L74-80, L113-143, L206-240, L260-287 |
| Gate checks, ladder, review, exit numbers, SPEC wording | deep-dives/02-derived-shots-fidelity-gate.md L8-10, L44-50, L81-83, L111-112, L131-166 |
| Engine prices (Nano Banana 2 0.101 at 2K; Nano Banana Pro 0.134); 60 trial images over 8 models; ladder; 0.20 per accepted image; Photoroom "1K, 2K, 4K" | deep-dives/03-on-model-generation-bake-off.md L15, L17-19, L31-32, L80, L128-130, L144, L151, L162-163, L171-174 |
| Old daily cap default of 10 USD; Nano Banana Pro 896x1200 on a 2K request | deep-dives/04-footwear-bags-lifestyle.md L176, L220 |
| Model registry, rights rule, GCC sites | deep-dives/08-brand-style-profile-model-registry.md L17, L22, L64, L168-173, L281 |
| Documented options per brand, absences 663 / 893 (without Puma apparel), 1,746 apparel, 1,300 | deep-dives/09-business-impact.md L68-76, L90, L144, L169-176, L192, L236-243, L724 |
| Vendor table and prices (Photoroom 1K below Enterprise, FASHN, Claid, Pixelcut, Picsart, remove.bg, Botika, OpenRouter); what we own; engine slot rules; gaps | roadmap/05-build-vs-buy.md L18-21, L28-45, L54-113, L127-136, L148, L158-194 |
| India lessons; Listing Optimization AI 0.16 per image | roadmap/04-india-learnings.md L59, L176, L194 |
| B2, B2e, B3 rows; 44/73 share; holdout cells | roadmap/06-metrics-and-impact.md L144-146, L178-182, L259-278 |
| Conflicts 1 to 15; F01 contradictions and three fixes | roadmap/focus/00-overview.md L131-149; roadmap/focus/01-crops-5.1a-5.1b.md L134-137, L210-219 |
| "Cut product never on image 1" | roadmap/initiatives/02-channel-ready-live-catalog.md L251 |
| SPEC lines quoted | docs/SPEC.md on main at d82cc36: L53-59, L74-75, L131, L152, L296, L397-401, L456, L805, L855-861 |
| Build rules: section headings 0 scope, non-goals and SPEC amendments (L20); 1 data model (L167); 3 planner and remove-and-replace (L353), 3.3 review rule, 3.5 carry-forward, 3.6 exclusions; 4 crop engine (L485); 5 generator and spend limits (L520); 6 gate (L596); 7 review, exits, relapse (L658); 8 publish (L728), 8.2 `cut_kept`; 9 mode B (L786); 10 rollout and scorecard (L826); 12 acceptance and monitoring (L919); 13 settlements (L960) | docs/specs/12-apparel-shot-set.md |
| Spend limit for made photos (`shotSet.generateCapUsd`, empty = no generation) | docs/specs/12-apparel-shot-set.md L223-225 (section 1.2) |
| Spend limit for checks (`options.qaCapUsd`, empty = no limit) | main: packages/core/src/catalog/qa/caps.ts L8 |
| Contract exception: only 02 and 03 ship migrations | docs/specs/00-execution-protocol.md section 11, L260-263; spec 12, 0.4 |
| Measured apparel options 1,813, images per option, single-image 13 / 70, no Styli / Centrepoint code 966 / 692 (882 / 655 without Puma apparel), live and stocked 1,454 and per channel, kids 20, inflow 842, undated apparel 246, cuts and views not measurable | proposals/2026-10-26-apparel-shot-set/01-inventory-count.md summary L9-20, Only and Anta L41, A3 L153-163, A4 L186-198, B L201-213, kids L215-220, D L231-272, E L274-323 |
| Meeting quotes (model always, five images, image 1 front, two images, tool cost, Nitin's test) | main checkout: meetings_folder/Catalog-Module-Connect-GCC-14e47c7c-2580.md L45, L65, L70-75, L85, L101-103, L119, L195-200, L207 |
| Operator guide: never crops; re-submission | main checkout: docs/handover/catalog-for-the-operator.md L90-93, L151-157 |
| Cost ledger table | main checkout: docs/solutions/monitoring.md L82 |
| Live state; PR #91 effect; no full inventory | main checkout: .runs/2026-10-26-explore-live-state.md L13, L23, L36-42 |
| Evidence contradictions 9.1 to 9.7; review capacity not stated; "3,350" unit unclear | main checkout: .runs/2026-10-26-explore-roadmap-evidence.md L71-72, L115-125 |
| Generation commoditised at about 0.16 USD an image; model ids never in operator copy | main checkout: catalog_initiative_india/mosaic-competitive-landscape.md L5; AGENTS.md |

Status: draft for business approval
