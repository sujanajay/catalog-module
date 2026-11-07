# Initiative 05 - Complete apparel shot sets

Date: 2026-10-26. Part of the GCC catalog roadmap proposal (`docs/plans/roadmap/07-roadmap.md`, "Initiative 5").
Documents only: nothing was built or published. The only paid action was 2 illustrative image calls (0.2064 USD,
section "Example"). No time or effort estimates. Buckets inside: B2 (fill missing apparel shots), B2e (Styli and
Centrepoint eligibility) and B3 (flat lay to on-model with the brand's real models).

**Source codes** (same as 07). 01 marketing data, 02 liveness data, 03 image audit, 05 build vs buy, 06 metrics and
impact model v2 (all in `docs/plans/roadmap/`); DD0, DD1, DD1a, DD2, DD3, DD8, DD9 = `docs/plans/deep-dives/00-...`,
`01-...`, `01a-...`, `02-...`, `03-...`, `08-...`, `09-...`; IM = the program doc
`docs/plans/2026-10-21-catalog-connect-gcc-intent-map.md`. Every revenue number comes from 06 "Summary table" and
"Formulas, step by step", as used in 07. Measured = a count or sum from data; judged = an assumption.

**Words used.** Role = one required kind of photo. Styli and Centrepoint ask for five: FM front cropped mid-thigh,
FL full length head to toe, FC fabric close-up, BH back cropped at the hips, HS head and shoulders (DD0, DD1).
Derived shot = a new photo cut from a larger brand photo of the same product; no pixel changes. Generated shot = a
new photo made by an image generator from the brand's own photos. Gate = the six measured checks every generated
shot must pass (DD2 R2). Mode A = generate a missing role from the product's existing on-model photos; mode B =
put a flat-lay garment on one of the brand's real models (DD3). Engine and model ids appear in this document only
as technical facts; they never appear in operator copy.

## Summary

1. 65 of 66 sampled apparel products (98%) lack the five-photo set Styli and Centrepoint ask for; head and shoulders
   is missing on 57 of 66 (03). About 663 apparel options are absent from Centrepoint and 893 from Styli (DD9).
2. Fix in two stages: cut the missing role from a larger brand photo first (free, pixels unchanged); generate it only
   where no photo is big enough, then gate and review every generated shot (DD2 R1 to R3; DD3).
3. Buy only the generator (one image API through OpenRouter, swappable); build the planner, crop rules, gate, review.
4. Value (06, 07): low 0.9k, base 50.6k, high 132.0k USD a year. Half the base (25k) is B2e: options that can list.
5. Run cost about 74 USD one-off (153 at DD9 counts): about 680 USD of base revenue per USD. Buying the same generated shots from an agency (INR 500 to 800 per style-colour) would cost about 1.5k to 2.4k USD once (spend avoided, not cash paid today).
6. Example: 1 crop cleared every floor at no cost; 2 generated shots (0.2064 USD) looked right but the gate holds both.
7. Waits on: two SPEC amendments (cropping, generation), the gate's bars and exit numbers, brand rights for real-model
   references, the vendor data position, and Styli and Centrepoint confirming what they accept.

## Problem, with evidence and real examples

### What the evidence shows

- **Almost no apparel has the full set.** 65 of 66 sampled apparel products (98%) fail the Styli / Centrepoint
  five-shot rule; 60 of 66 (91%) still fail if the fabric close-up is not required; only 6 pass that softer rule
  (French Connection 4, Vero Moda 1, Cardio Bunny 1) (exact, 03 "Defect rates per channel rule").
- **The gap is mostly one role.** Missing roles across the 66: head and shoulders 57, fabric close-up 31, front
  mid-thigh 25, back 19, full length 14 (exact, 03 "Raw image findings per brand").
- **The listing effect is large.** About 663 apparel options are absent from Centrepoint and 893 from Styli,
  proxied by missing channel ids (DD9 sizing table, via 07).
- **Some apparel has no model photo at all.** 11 of 66 sampled apparel products (17%); 3 of 12 sampled Vero Moda
  apparel sets (25%) (03; 06 "B3"). Anta apparel is flat only, at 800x800 (03).
- **Most missing roles can be cut, if the photo is big enough.** On 24 sampled options, roles FM, BH and HS are
  present or crop-derivable on 23; full length is missing on 5 (all Penti) and cannot be cut; the back is almost
  never the gap (1 of 24) (DD2 F2).
- **Size decides whether a crop works.** A head-and-shoulders crop from a mid-thigh shot is about 825 px tall on a
  1200x1800 source (passes Styli's 741 px line with the x2 upscaler) but about 550 px on an 800x1200 original
  (fails) (DD2 F3). 92 of 141 sampled products have an image below Styli's 1,482 px floor (exact, 03).
- **Images go live as received.** None of 37 checked Trendyol listings had been re-shot or repaired (03 "Live vs
  raw"). Nobody adds the missing roles today.
- **Image count alone does not lift conversion.** Options with 7 to 8 images convert no better than those with fewer
  (CVR ratio 0.954, 9 of 18 cells each way) (01 s3). So the conversion lift for B2 is cut to 3% base (06), and the
  stronger case is eligibility (B2e), not more photos.

### Where the gap sits, by brand (03 per-brand table and csv; 06 "B2" shares)

| Brand | Apparel revenue a year (06) | Sampled apparel missing front, back or close-up (06 "B2") | Typical missing roles (03 csv) | Source height (03) |
|---|---|---|---|---|
| French Connection | 0.528M | 12 of 17 | HS, FC; raw brand folders at 2250x3000 | 1,500 to 3,000 px |
| Penti | 0.403M | 7 of 15 | HS on 8 of 8 apparel, FL, FM; tight crops by design | 1,000 px |
| Vero Moda | 0.125M | 7 of 12 | HS; packshot-only and black-background sets | 1,024 to 6,700 px in one brand |
| Cardio Bunny | 0.097M | 5 of 15 | HS on 15 of 15 template sets; brand sends 1 photo per colour | 1,200 px (sets), 4,500 (brand) |
| Only, Anta | in "others" (0.142M) | single flat packshots | every on-model role | 800 to 1,200 px |

### Real examples (audit files, under `...\scratchpad\audit\raw\`)

| # | Product (Supabase folder) | Roles present | Missing | What it means |
|---|---|---|---|---|
| 1 | Vero Moda / Only `vm-ol/5715945917041` | PK, FL, BH, FM, FC | HS | Masters are about 5000x6700: HS can be cut, no generation needed (example section) |
| 2 | Vero Moda `vero-moda/Z5C2F10C8828D6C235D33Z` | FM, FL, BH, FC, PK | HS | 800x1096 only: an HS crop is about 400 px, under every floor; generate (mode A) |
| 3 | Vero Moda / Only `vm-ol/5715946612846` | 2 flat packshots | FM, FL, BH, HS (FC is a crop of the flat lay) | No model at all: mode B |
| 4 | Penti `ZB5DD2DF3C4FE02A37B12Z` | FL, BH | FC, FM, HS | 2 images only, 1,000 px tall |
| 5 | French Connection `599A5` (raw brand folder) | FC, FC, PK, FM, FL, PK | BH, HS | 2250x3000 masters; HS likely croppable from FM, BH needs a back shot or generation |
| 6 | Only `only/ZF387E332E81ABFF06903Z` | PK | all five | Single packshot touching the frame edges (03 example 3) |
| 7 | Cardio Bunny brand-sent `CB_HCB-726-532-01_CREAM.jpeg` | FL | BH, FC, FM, HS | One 3000x4500 photo per colour (03 example 7) |

## Who it serves

- **Shoppers on Styli and Centrepoint**, who today cannot find most of our apparel there at all (663 and 893 options
  absent, DD9).
- **The GCC business team and channel managers** (Nitin Kiran, Naz), who want apparel listed on Styli and
  Centrepoint without a re-shoot or agency spend; manual capacity is about 1,300 images a year against a backlog of
  about 3,400 (07 "Total budget").
- **Apparel brands** French Connection, Penti, Vero Moda, Cardio Bunny (about 1.15M USD of apparel revenue a year,
  06), and later Only and Anta.
- **The catalog operator**, who reviews every generated shot until the gate's exit numbers hold; this initiative adds
  review work, so it is designed to generate as little as possible.
- Not US Polo: its warehouse catalog is footwear only, so it is not in this initiative (DD2 F1; DD8 Summary 8).

## Metrics it moves and today's baselines

| Metric | Baseline today (source) | Measurable today? |
|---|---|---|
| Styli / Centrepoint five-shot set present | 2% of sampled apparel (1 of 66) (03; 06 "Catalog health") | Sample only; per product once roles are recorded (initiative 2) |
| Apparel missing HS / FC / FM / BH / FL | 57 / 31 / 25 / 19 / 14 of 66 (03) | Sample only |
| Apparel with no model shot | 17% (11 of 66); Vero Moda 25% (3 of 12) (03, 06) | Sample only |
| Apparel options absent from Centrepoint / Styli | about 663 / 893 (DD9, proxy by missing channel ids) | Proxy only; Styli and Centrepoint are not in the liveness feed (06 "Liveness rate") |
| Revenue per listed option | about 115 USD a year on Centrepoint, about 25 on Styli (DD9 s4, via 06 "B2e") | Yes, from sales once listed |
| Ad CVR, apparel brands | French Connection 1.10%, Vero Moda 1.45%, Penti 2.59%, Cardio Bunny 2.57% (01 s2.4) | Yes, Amazon, Noon, Namshi |
| Gate false passes / false holds | none yet; exit bars 2% or less (zero on garment identity and logos) / 15% or less on 300 labelled shots (DD2 R3) | After the gate is built |
| Run cost per accepted generated image | 0.20 USD assumed (DD3 R4); trial 0.104 and 0.103 USD per 2K call (this document) | Yes, cost ledger per call |

Business outcomes (07 "How the initiatives connect"): conversion direct; liveness direct (Styli and Centrepoint
eligibility); sell-through and ROAS indirect. No sell-through number is claimed.

## Solution

### The planner: which role, from where

For each apparel product and each channel ticked, the planner reads the roles already present (initiative 2 records
a role per photo) and, for each missing role, takes the first path that works:

1. **Use an existing photo** that already is that role.
2. **Derive it by crop** from a larger photo of the same product (stage A).
3. **Generate it** from the brand's own photos (stage B, mode A), or for flat-only products put the garment on the
   brand's registered model (stage B, mode B).
4. **Not made**, with a plain sentence on the links sheet ("Not made: the photo is too small to cut a head and
   shoulders from it"; "No approved brand model for Vero Moda women yet") (DD2 R1.3; DD8 R1).

### Stage A: crop rules (DD2 R1; needs the cropping SPEC amendment)

- FM, BH and HS are cut only from a photo of the same product whose head is whole; HS from the mid-thigh or hips
  framing where one exists, from the full-length shot only when the crop still clears the channel's floor; BH only
  from a back photo, never a mirrored front.
- FC is a crop of a flat lay, or of a fabric area with no skin, hair or face; whether Styli accepts an on-model
  fabric crop is asked once in writing first.
- The cut line sits in the role's band (FM mid-thigh, BH hips, HS below the bust), measured on the cut-out
  silhouette, never through a logo, text or buckle; the head box stays whole with at least 5% margin above it.
- A crop is made only if its height clears the channel's floor: Styli 741 px with the x2 upscaler (1,482 without),
  Centrepoint 2,000 px flag-free, Noon and Namshi 482 px, Amazon 667 px (DD2 F3). Below that it is not made; no
  soft, enlarged crop. These floors are this initiative's quality bar for derived crops only: since PR #91 the
  module no longer skips small photos on Styli or any channel; it enlarges them and adds a soft-image note
  (initiative 2 "Findings now stale").
- Every derived output carries the `derived` flag, its parent photo and crop box, and passes every existing check
  (pixels copied, cut-out, compliance, the judge) like any other output.
- Ask every apparel brand for masters at 2,400 px or more on the long side. This is the cheapest lever: Penti's
  warehouse holds 1440x2160 copies of 800x1200 uploads (DD1 Summary 5), and the Vero Moda / Only EAN folder already
  holds 5000x6700 masters (03). A 2,400 px master makes an HS crop from the full-length shot about 900 px (DD2 F3).

### Stage B: generator choice (DD3; 05 Recommendation)

- **Engine:** Nano Banana 2 through OpenRouter's image API, 2K output (1792x2400) plus the existing x2 upscaler for
  Styli; 4K (3584x4800) where a brand's channel mix justifies about 0.05 USD more per image. Regeneration ladder:
  new attempt, then stronger reference wording, then Nano Banana Pro; then the hold stands (DD3 R1).
- **Why this one:** in the 60-image bake-off it kept the same person and garment on every attempt in both modes and
  followed the role bands; GPT Image 2 cut heads on 4 of 12 close framings, Seedream ignored crop bands, FLUX 3 klein
  changed hair colour, Qwen Image 3 is 1K with 3 references (DD3 "Results per model").
- **Mode A request:** references are every brand photo of the same product that shows the garment, named by ordinal
  in the prompt, with the missing role described in the role band's words; the prompt forbids adding, moving or
  restyling any logo, label, print or text, and forbids showing more skin than the references (DD3 R2).
- **Mode B request:** references are the flat lay(s) plus one approved photo of the brand's registered real model
  (DD8 registry: real brand models first, brand-supplied second, an approved synthetic model sheet only as a
  fallback). The planner generates full length first, a person approves it as the anchor, then FM, BH and HS are
  generated with the anchor as a third reference; FC is a crop of the flat lay (DD3 R3; DD8 R1, R4). Vero Moda first
  (07 Initiative 5).
- **Request shape:** one `POST /api/v1/images` per role: `model`, `prompt`, `aspect_ratio: "3:4"`, `resolution:
  "2K"`, `input_references` as data URLs in a fixed order (sources, model reference, anchor), `session_id` = batch
  and product for cost grouping; `usage.cost` and the output sha go into a `gen_key` record (generator id, prompt
  hash, reference shas). A fixed seed does not reproduce an image, so the output sha is the identity (DD3 R5).

### The gate (DD2 R2) and review (DD2 R3)

Every generated shot passes all six checks or is held; no averaging and no override by a high score elsewhere:

| Check | Measure | Initial bar | Hold flag |
|---|---|---|---|
| G1 garment identity | DINOv2 similarity on garment-mask crops vs the brand photo of the same view, plus two-model judge | 0.85 same view, 0.70 cross view and both judges agree | `wrong_garment` |
| G2 logo and text | OCR on every logo or text region of the sources; same string on the output; no invented text | every region passes; zero invented strings | `logo_changed`, `text_invented` |
| G3 colour | CIEDE2000 on the three dominant garment colours | mean 3.0 or less, each 5.0 or less | `colour_shift` |
| G4 texture and print | LPIPS on matched garment patches; texture energy ratio | 0.35 or less per patch; ratio 0.7 to 1.4 | `texture_changed` |
| G5 model and scene | same background, skin tone within 3.0, judge "same person, same lighting", anatomy check; no face embeddings stored | all pass | `model_mismatch`, `anatomy` |
| G6 crop geometry | head whole with 5% margin, cut line in the role band, 3:4 frame | pass | `crop_rule` |

Review: every generated shot is held for a person (decisions `use_as_is` or `remove`) until the exit numbers hold on
at least 300 labelled shots over three or more brands and all five roles: false passes 2% or less with zero on G1 and
G2, false holds 15% or less, planted defects caught 100%, rater agreement (Krippendorff's alpha) 0.67 or more. After
exit, 10% sampled review per batch; a batch over 2% false passes returns the brand to review-all (DD2 R3). At 06's
counts the first backlog is about 369 generated images (219 for B2, about 30 sets x 5 for B3), enough to reach the
300-shot exit inside this initiative.

### Build vs buy (05 Recommendation; 07 Initiative 5)

| Part | Decision | Why |
|---|---|---|
| Planner, crop rules, role records | Build | Channel rules and roles are ours; no vendor knows Styli guides or Centrepoint's canvas (05) |
| Gate, review, publish, cost ledger | Build on what exists (LPIPS, CIEDE2000, OCR, the two-model judge; add DINOv2 as one endpoint) | Our gate decides, never the vendor; photos stay in the project for the measures (DD2 O1) |
| Generator | Buy, swappable: Nano Banana 2 first; FASHN Product-to-Model second for flat lay to model; Photoroom Virtual Model third only if it beats both on our gate | Per-image price is small (0.10 USD at 2K); no vendor makes the five-role set with one model (05 Summary 2; DD3 Options) |
| Photoroom as a platform | No | Virtual Model is 1K below Enterprise (200,000 images a year minimum, about 60 times our need), US-only servers (05) |
| Self-hosted open weights | Not now | Commercially licensed options are 576x864 or weaker on identity (DD3 O3) |

## Example

**What was tried.** Three audited apparel products, each missing at least one role, run through the plan above.
Inputs, outputs, request log and comparison sheets are in
`C:\Users\SUJANA~1\AppData\Local\Temp\claude\c--Users-Sujan-Ajay-Desktop-catalog-module\8948687b-c329-4062-a372-8e34a714b089\scratchpad\examples\05\`
(`inputs\`, `outputs\`, `meta\runs.jsonl`, `meta\cmpA_face.jpg`, `meta\cmpB.jpg`, `meta\colour_*.txt`, `scripts\`).
Generator: Nano Banana 2, 2K, 3:4, one request each, the DD3 request shape and prompt wording. These are scratch
trials: nothing was published, and real-model references were used without written rights only because nothing
leaves the scratchpad (DD8 requires rights before any live use).

| # | Product | Missing | Path taken | Output | Cost (USD, `usage.cost`) |
|---|---|---|---|---|---|
| 1 | `vm-ol/5715945917041` (sheer white cape top, 5018x6691 full-length master) | HS | Stage A crop from the full-length photo | `crop_vmol917041_HS.jpg`, 1561x2082, pixels unchanged | 0 |
| 2 | `vero-moda/Z5C2F10C8828D6C235D33Z` (white crinkled halter mini dress, 800x1096 sources) | HS | Crop fails (about 400 px tall, under Styli 741, Amazon 667, Noon 482); mode A from all 5 brand photos | `nb2_A_vmZ5C2_HS.png`, 1792x2400 | 0.103773 |
| 3 | `vm-ol/5715946612846` (terracotta cape maxi dress, 2 flat lays) | every on-model role | Mode B anchor (full length): front and back flat lays plus the model from product 1 | `nb2_B_vmol612846_FL.png`, 1792x2400 | 0.102661 |

**Exact spend.** 0.206434 USD by the two responses' `usage.cost`; the key's usage counter moved from 40.54358258 to
40.74996458, a delta of 0.206382 USD. Reported spend: 0.2064 USD of the 3 USD cap. Latency 25 s and 22 s. No other
paid service was used. Per 2K image: 0.1008 USD output plus 0.002 to 0.003 USD input, matching DD3's 0.10.

**Result, judged honestly against the gate** (by eye on the comparison sheets, plus the crude patch colour measure
from DD3; the gate's mask-based G1, G3 and G4 measures do not exist yet):

| Check | 1 Crop (HS) | 2 Mode A (HS) | 3 Mode B (FL anchor) |
|---|---|---|---|
| G1 garment | identical pixels | pass by eye: same high ruched halter collar, crinkled texture, rosette at the hip | pass by eye: round neck, shoulder tuck lines, both cape panels; the back cape is not visible from the front, as expected |
| G2 logo, text | none | none on the garment | none on the garment |
| G3 colour | identical | patch dE2000 3.20 on white crinkled fabric (bar: mean 3.0): borderline | patch dE2000 7.68 against the flat lay (L 28.5 vs 36.5; hue 30 vs 34 degrees): **fails** the 5.0 bar; mostly on-body shading against a flat-lit flat lay, but the dress also reads browner by eye |
| G4 texture | identical | crinkle pattern is the same kind, redrawn, not the same pattern (needs LPIPS on matched patches) | plain matte weave, consistent |
| G5 model | brand photo | pass by eye: same woman, hair parting and gold huggie earrings | pass by eye: same woman as the reference; she keeps the reference's pearl studs (an accessory not in the garment references) |
| G6 crop | head whole, about 10% margin, band below the bust | **fails**: framed down to the dropped waist, not below the bust, and the hair sits about 2% from the top edge (bar 5%) | pass: head whole with about 8% margin, feet whole |
| Floors | 2,082 px tall: clears Styli 1,482 and Centrepoint 2,000 without the upscaler | 2,400 px: Styli via the x2 upscaler | as 2 |
| Verdict | **Publishable** after the normal checks; the product goes from 4 to 5 roles at no cost | **Held** `crop_rule`; next ladder step | **Held** `colour_shift` for a person to decide; if approved, it becomes the anchor for FM, BH, HS |

**What the example shows.**
- Crop first works when masters are large: product 1 needed no generator. Asking brands for masters is the cheapest
  fix in this initiative.
- The generator gets close: both generated shots would pass a quick look, which is exactly the risk. Two of two
  were caught by measured checks (framing, colour) that a glance misses. The gate and review-all are load-bearing,
  not optional.
- G3 needs a form that is fair to mode B: comparing an on-model shot with a flat-lit flat lay mixes shading with
  colour. The gate's labelled set must include mode B shots before the colour bar is fixed (DD2 R2 says final bars
  come from labels).
- Cost per accepted image cannot be read from two calls with zero accepted; the 0.20 USD assumption (two attempts
  per accepted image, DD3 R4) stands until the labelled run.

## Cost and ROI

### Revenue (USD a year; 06 rows B2, B2e, B3; 07 Initiative 5)

| Row | Formula | Low | Base | High |
|---|---|---|---|---|
| B2 fill missing shots (conversion) | revenue touched 0.528M x 12/17 + 0.403M x 7/15 + 0.125M x 7/12 + 0.097M x 5/15 + 0.142M x 44/73 = 0.752M; x lift 0 / 3% / 10% (judged, cut for 01 s3) | 0 | 22.5k | 75.2k |
| B2e Styli / Centrepoint eligibility (listing) | 663 x 115 x share + 893 x 25 x share; share of absent options that start selling 0 / 25% / 50% (judged) | 0 | 25k (19.1k + 5.6k) | 49k |
| B3 flat lay to on-model (Vero Moda) | 0.125M x 3/12 = 0.031M; x lift 3% / 10% / 25% (judged) | 0.9k | 3.1k | 7.8k |
| **Total** | sum | **0.9k** | **50.6k** | **132.0k** |

Ad money saved at the same ad sales (comparison only, counted once in initiative 3's L1, 06 "Overlaps"): B2 1.1k
(3.5k high) = 39.0k spend touched x 0.03 / 1.03; B3 0.3k (0.7k).

### Run cost (USD; 06 Summary table; 07 "Total budget")

| Item | Formula | One-off |
|---|---|---|
| B2 generated views | about 1,050 options (1,746 apparel options x 44/73) x 5/24 needing generation x 0.20 per accepted image = 219 images | 44 |
| B3 flat lay to on-model | about 30 options x 1.00 per five-shot set | 30 |
| **Total at 06 counts** | | **74** |
| At DD9's full counts | 32 (B2) + 121 (B3, 605 images x 0.20) | 153 |
| Derived crops (stage A) | inside the existing render cost, about 0.0119 per style on all channels (05) | about 0 |
| Gate compute | judge about 0.0004 per shot plus about 1 s of L4 GPU at 0.00035 per s (DD2 F5) | under 1 for 369 shots |
| Recurring for new styles | not sized in the evidence; small at 0.20 per accepted image | not sized |
| Vendor trials before buying | FASHN minimum pack 7.50; Photoroom sandbox free (05 Q3) | up to 7.50 |

People time (review of every generated shot until exit) and margin are excluded by rule (06 Assumptions row 11).

### Agency cost avoided (owner prices, 2026-10-26; not cash paid today)

Agencies charge about INR 500 to 800 per style-colour (5.95 to 9.52 USD) for generated images; one price covers the
generated images one style-colour needs. The agency's INR 60 per style is resizing with links plus template filling,
never generation, so it is not the comparator. The agency does not make these images for us today, so this is spend
avoided, not cash saved.

| Work | Style-colours | Agency | Ours (USD) | Net avoided (USD) |
|---|---|---|---|---|
| B2 generated head-to-toe | 219 (1,050 x 5/24) | INR 109,500 to 175,200 (1,304 to 2,086 USD) | 43.80 | 1,260 to 2,042 |
| B3 flat lay to model, 5-shot set | 30 | INR 15,000 to 24,000 (179 to 286 USD) | 30 | 149 to 256 |
| **Total at 06 counts** | **249** | **INR 124,500 to 199,200 (1.5k to 2.4k USD)** | **74** | **1.4k to 2.3k** |
| At DD9 counts (B2 160, B3 121) | 281 | INR 140,500 to 224,800 (1.7k to 2.7k USD) | 153 | 1.5k to 2.5k |

Per image we pay about 0.20 USD (INR 16.8), 30 to 48 times less than an agency style-colour; a 5-shot set costs
1.00 USD (INR 84), 6 to 10 times less. Derived crops are not generation and are not counted. Note only, not counted:
new apparel needing generated shots (about 196 style-colours a year, derived) would add about 1.2k to 1.9k a year.
If the agency prices per image, B3 is 5 times higher; if per size-level SKU, all rows are about 5 times higher.

### ROI

- Base: 50.6k / 74 = about 680 USD of base revenue per USD of run cost (07). At DD9 counts: 50.6k / 153 = about 330.
- Low: 0.9k / 74 = about 12. High: 132.0k / 74 = about 1,780.
- About half the base (25k of 50.6k) is B2e, a listing effect with no ad data and a judged 25% sell share; the
  conversion half (22.5k) rests on a judged 3% lift that our own data does not yet support (01 s3).
- Cash: none paid today. Spend avoided against agency generation prices: about 1.5k to 2.4k USD once (see "Agency
  cost avoided"); not in the ratios.
- These ratios show run cost does not limit the initiative; they are not profit figures.

## Risks

| # | Risk | Evidence | Effect | Mitigation |
|---|---|---|---|---|
| 1 | Garment fidelity: the generator changes the garment subtly (shape, colour, details) | Colour fail on the mode B example (dE2000 7.68); grey rib rendered darker in DD3 (dE2000 up to 5.4); a hem label moved to the back by 3 models (DD3) | A wrong product photo published; returns and rejections | Gate G1 and G3 with two-model agreement; review-all until exit; a generated shot is never the only reference (DD2 R2, F4) |
| 2 | Prints and logos redrawn | Prints re-drawn on 7 of 7 attempts; text kept on 7 of 7 but letter spacing changed (DD3) | Many `texture_changed` holds on printed garments; review load | G2 OCR string equality and no invented text; G4 patch measure; start with plain garments; printed items stay derived-only until bars come from labels |
| 3 | Modesty for GCC channels | No model refused or altered coverage on the camisole set or cover-up; true swimwear and lingerie not probed (DD3; DD0 items 3, 4); Penti and Cardio Bunny photos largely ruled out by GCC modesty (DD8 Summary 1) | A generated shot shows more skin than the brand photo or than the channel allows | Prompt forbids more skin than the references; review-all; Penti intimates, swim and lingerie excluded from generation until the owner sets a policy |
| 4 | Rights for real-model references | Only Puma and a USPA Kuwait store are GCC sites; others are global, US or India sites; Cardio Bunny's robots.txt bans AI bots (DD8) | Using a real person's likeness without permission | Written rights per brand and site before any mode B run (DD8 R1); synthetic model sheet only as a fallback, approved and versioned (DD8 R4) |
| 5 | Brand photos leave GCP | Generators are US or Google hosted; Gemini paid tier keeps abuse logs "for a limited period" (DD3; 05 Risks) | Data and contract exposure | Written vendor data position before any live run (05 Q2) |
| 6 | Channels may not accept derived or generated shots | Styli's acceptance of an on-model fabric crop and an upscaled 2K image is unknown; Centrepoint's spec is unconfirmed (DD2 R1; DD3 R6; DD1a Q4) | B2e value does not arrive | Ask both channels in writing first; generate at 4K for Styli if required (about 0.05 USD more per image) |
| 7 | Lifts are judged and B2's cannot be measured directly | No image-count effect (01 s3); a holdout detects about 15% on Namshi, not 3% (06) | The conversion half of the value may be near zero | Report B2e by listings and sales on new channels, which is directly countable; drop the B2 row if no cell shows an effect |
| 8 | Review capacity | Manual route about 1,300 images a year; backlog about 3,400 (07) | Generated shots wait in review | Crop first to keep generation small; generate per brand in batches; exit review-all only by the DD2 numbers |
| 9 | Small audit sample | 66 apparel products, one reviewer, plus or minus about 3 products (03 Gaps) | Brand shares move | Replace with role tags on every product (initiative 2) |

## How we measure success

- **Catalog health (per product, after initiative 2 records roles):** share of apparel with the five-shot set, from
  2% (1 of 66) on the sample; split into roles made by crop and by generation, and products "not made" with a reason.
- **Gate quality (before any exit from review-all):** on at least 300 labelled shots, false passes 2% or less with
  zero on G1 and G2, false holds 15% or less, planted defects 100% caught, rater alpha 0.67 or more (DD2 R3).
- **Eligibility (B2e, the largest and most countable row):** options newly live on Centrepoint and Styli out of about
  663 and 893, and their sales against the 115 and 25 USD per option a year assumptions (DD9 s4). Needs Styli and
  Centrepoint listing data, which the liveness feed does not have today (06).
- **Conversion (B2, B3):** a holdout cell on Namshi apparel, matched pairs, ad CVR (06 "Holdout test design"). It
  detects about a 15% relative lift; a 3% base lift stays judged unless a cell shows more.
- **Cost:** ledger cost per accepted generated image against 0.20 USD; spend per batch under the existing cap.
- **Treatment log:** every published image with role, `derived` or `generated` flag and position (initiative 1),
  so sales can be joined to content.

## Dependencies

| Dependency | Why | State |
|---|---|---|
| SPEC amendment for cropping (DD2 R4, second bullet; amend R11 and the Styli "Never crop" line) | SPEC non-goals forbid any cropping today (05 Risks) | Draft wording in DD2; owner decision (07 Decision 3, Phase 2) |
| SPEC amendment for generated shots (DD2 R4, first bullet) | SPEC non-goals forbid generative edits and paid image APIs | Draft wording in DD2; owner decision (Phase 3) |
| The fidelity gate built, calibrated and labelled (DD2 R2, R3) | Nothing generated is published without it | Not built; reuses LPIPS, CIEDE2000, OCR and the judge that exist (05 "What we have today") |
| Initiative 2: role per photo and required-role lists per channel | The planner needs to know which role is missing | Proposed (07 Initiative 2) |
| Initiative 1: treatment log | Measurement | Proposed |
| DD3 generator approved; `createImage` call on the images endpoint; LIVE_SMOKE gate for live calls | The current client is chat-completions only (DD3 R5) | Not built |
| DD8 brand style profile and model registry, with written rights | Mode B references | Not built; awaiting owner approval |
| x2 upscaler | 2K outputs to reach Styli | Built, live (05) |
| Brand masters at 2,400 px or more | Stage A crops clear the floors | To request from brands |
| Styli and Centrepoint written confirmation | What they accept | Not asked |

Phase (07 "Phased view"): stage A crops and the gate in Phase 2; stage B generation in Phase 3.

## Owner questions

1. Do you approve the cropping SPEC amendment (DD2 R4) for Phase 2, and the generation amendment for Phase 3?
2. Do you approve the gate's initial bars and exit numbers (DD2 R2, R3): review-all until 300 labelled shots show 2%
   or fewer false passes, none on garment identity or logos? Who is the second rater?
3. May we ask French Connection, Penti, Vero Moda, Cardio Bunny, Only and Anta for masters at 2,400 px or more? The
   example shows large masters remove the need to generate.
4. Who asks Styli whether it accepts an on-model fabric crop and an upscaled 2K image, and Centrepoint for its
   written spec (DD1a Q4)?
5. May brand photos go to Google through OpenRouter, and do you want a written no-training position first (05 Q2)?
6. Which brand sites do the written rights cover for real-model references, starting with Vero Moda (DD8)?
7. Modesty policy: should swimwear, lingerie and intimates (Penti) be excluded from generation entirely, and may a
   generated shot keep accessories the brand model wears in the reference (the pearl studs in the example)?
8. Do you accept that B2e (25k base) is reported by listings and sales on Styli and Centrepoint, and that the B2
   conversion row (22.5k base) is dropped if no holdout cell shows an effect?

Status: done
