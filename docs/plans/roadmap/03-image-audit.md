# 03 - Raw and live image audit (GCC softlines)

Agent C of the GCC catalog roadmap proposal. Documents only; nothing was built or changed. All access was read only:
Supabase Storage list and public download (no uploads, moves or deletes), BigQuery `opptra-datawarehouse` SELECTs,
and public Trendyol CDN image downloads. Run 26 Oct 2026. Each number is marked **(exact)** when it is a direct count
on the sample or the bucket listing, and **(approx)** when it depends on a judgement rule or would be extrapolated
beyond the sample. All rates below are exact counts on the sample; reading them as rates for the whole catalogue is
approximate (random sample of about 15 to 20 products per brand, not sales-weighted).

Per-product data: `C:\Users\SUJANA~1\AppData\Local\Temp\claude\c--Users-Sujan-Ajay-Desktop-catalog-module\8948687b-c329-4062-a372-8e34a714b089\scratchpad\audit\audit_products.csv`
(one row per product, all rule results). Per-image measurements: `...\scratchpad\audit\images_auto.csv`. Visual
judgements: `...\scratchpad\audit\judg.csv`. Live comparison: `...\scratchpad\audit\live_judg.csv` and
`live_auto.csv`. Contact sheets: `...\scratchpad\audit\sheets\` and `...\scratchpad\audit\livesheets\`. Images:
`...\scratchpad\audit\raw\` and `...\scratchpad\audit\live\`. (`...` = the scratchpad folder in the first path.)

## Summary

1. Sample: 142 products, 744 images, 11 brand folders (exact). 141 are softline; 1 French Connection diffuser set was excluded.
2. The "1 in 3" guess holds only under a lenient rule. 45 of 141 products (32%) (exact) have a framing defect (head cut or product cut on the main image), apparel without a front + back + close-up, footwear without a side view plus one other view, or a single image.
3. Against the actual channel rules the share is far higher. 65 of 66 apparel products (98%) (exact) lack the Styli/Centrepoint 5-shot set, and 60 of 66 (91%) still fail it if the fabric close-up is not required. Head-and-shoulders (HS) is missing in 57 of 66.
4. White main image (Amazon main; Noon outside fashion; Shein): 39 of 141 fail (28%) (exact). That is 79% of French Connection, 60% of Vero Moda and 100% of the brand-sent Cardio Bunny photos, but 0% of US Polo, Campus, Penti, Anta and Keds.
5. Head cut on an on-model shot: 15 of 64 on-model products (23%) (exact). Product cut by the frame on the main image: 6 of 141 (4%) (exact).
6. Size: 92 of 141 products (65%) (exact) have at least one image below Styli's 1,482 px floor for a 2:3 photo, but only 1 (1%) is below the 741 px floor with the x2 upscaler. Anta's 800x800 set is under Amazon's 1,000 px zoom size on every product.
7. 51 of 141 sets (36%) (exact) mix pixel sizes, padding or backgrounds. 35 of 141 (25%) contain text images (20 size charts, 15 infographics with callouts).
8. Live vs raw (Trendyol UAE, 37 products): 24 (65%) (exact) show the same photos, only resized or padded to 1,200x1,800 and often reordered. 10 (27%) show the same shoot with a different background version. 2 show a different shoot and 1 shows the wrong product. None was re-shot or repaired: head cuts and lifestyle-first ordering are live.
9. The owner's belief is confirmed: images go up as received. The defects come with the brand files, and Trendyol's own 2:3 canvas is the only change.
10. The "raw" layer is not one place. The same products sit in 2 to 3 Supabase folders with different file sizes. The Cardio Bunny sets in `softlines/` are generated from one brand photo per colour.

## Method and sample

### Bucket inventory (exact, from Storage list calls)

| Bucket / folder | Product folders | Files | Images per folder (median, min-max) | Naming | Dates | What it is |
|---|---|---|---|---|---|---|
| `us-polo-sku-images` | 446 | 2,583 | 6 (3-7) | `<parentZSKU>/<parentZSKU>_n.jpg` | 24 Jul | US Polo footwear, 1600x1600 sets |
| `campus-sku-images` | 358 | 2,323 | 6 (4-8) | same | 22 Jul | Campus footwear, 1600x1600 |
| `penti-sku-images` | 557 | 2,590 | 5 (1-7) | same | 24 Jul | Penti, 800x1000 |
| `penti-225-sku-images` | 225 | 1,077 | 5 (1-7) | same, 224 folders overlap the above | 1 Aug | Penti, same products, about 4x the bytes per file (e.g. 137 KB vs 533 KB) |
| `cardio-bunny-sku-images` | 0 (flat) | 44 | 1 per colour | `CB_<style>-<colour>.jpeg` | 9 Oct | Brand-sent, 3000x4500, one photo per colour |
| `softlines/` (21 subfolders) | 3,545 | 18,094 | 5 (1-30) | mixed: parent ZSKU, EAN, style_colour, raw brand names | 3 Aug - 20 Oct | Working copies per brand (see below) |
| `product-images` | 3,156 | 16,571 | 2.5 (0-18) | `<epoch>-<India code>_n.jpg` | Mar - Jul | India catalogue; 1,986 files under 1 KB (empty placeholders). Skipped |
| `catalog-images` | 4 | about 40 | - | `infographic_amazon_*.png`, `hero_*` | - | Generated outputs, not raw. Skipped |

`softlines/` subfolders (folders / files, exact): french-connection 976/5,393 (369 raw brand-named folders such as
`529A710_BACK_copy.jpg`, 607 ZSKU folders), french-connection-final 607/3,280, french-connection-sku 501/2,292,
vero-moda 477/2,039, campus 248/1,607, us-polo 179/1,057, anta 126/630, penti 115/546, vero-moda-sc 91/110,
vm-ol 50/207 (files up to 20 MB), us-polo-assn 48/129, only 38/156, cardio-bunny 25/150, gtplayer (2 x 9/78,
hardline), keds 7/57, puma 2/2, lyle-scott 1 file. Hardline buckets (hamleys, bergner, shape, po-images) were skipped.

Folder names are the parent ZSKU (`child_zsku` in `raw_gcc_dimensions.master_sl` without the `-n` size suffix). This
joins them to EAN, and EAN joins to Trendyol `barcode`.

Duplication (exact): 179 US Polo folders exist in both `us-polo-sku-images` and `softlines/us-polo`, 247 Campus
folders in both Campus locations, 224 Penti folders in both Penti buckets, and all 607 `french-connection-final`
folders also in `softlines/french-connection` (216 of them also in `-sku`). File sizes differ between the copies, so they
are different renders of the same photos. Nothing records which copy is the brand original.

### Sample (exact)

Random (fixed seed) within each source folder, all images per product:

| Brand (source) | Products | Images | Category mix (visual) |
|---|---|---|---|
| US Polo (`us-polo-sku-images`) | 20 | 112 | footwear 20 |
| Campus (`campus-sku-images`) | 15 | 97 | footwear 15 |
| Penti (`penti-sku-images`) | 15 | 62 | lingerie 5, sleep/lounge 6, swim 2, top 1, dress 1 |
| French Connection (`softlines/french-connection`, 15 ZSKU + 5 raw brand folders) | 20 (19 softline) | 119 | dresses 7, tops 6, bottoms 3, bags 2, knit 1, home 1 (excluded) |
| Vero Moda (`softlines/vero-moda`) | 15 | 82 | bottoms 5, dresses 4, tops 2, other 4 |
| Only (`softlines/only`) | 10 | 35 | footwear 6, bottoms 3, top 1 |
| Cardio Bunny sets (`softlines/cardio-bunny`) | 15 | 90 | bottoms 9, tops 6 |
| Cardio Bunny brand-sent (`cardio-bunny-sku-images`) | 5 | 5 | tops, bottoms, knit, outerwear |
| Anta (`softlines/anta`) | 12 | 60 | footwear 9, apparel 3 |
| Keds (`softlines/keds`, all 7 folders) | 7 | 57 | footwear 7 |
| US Polo India codes (`softlines/us-polo-assn`) | 5 | 13 | footwear 5 |
| Vero Moda / Only EAN folders (`softlines/vm-ol`) | 3 | 12 | footwear, dress, top |
| **Total** | **142 (141 softline)** | **744** | apparel 66, footwear 64, other softline 11 |

Nautica and Puma have no usable Supabase folders (Puma has 2 single files), so they are not in the sample.

### Measurement

- Pixel size, aspect and bytes: script, every image (exact).
- Background: script reads a 2% border strip. "White" means a border median of 248 or more on all channels, "light grey" a neutral grey of 195 or more, "complex" means under 80% of border pixels near the median (lifestyle, close-ups that fill the frame). Each call was checked visually on the contact sheets.
- Shot roles, on-model vs flat vs packshot, head cut, product cut, text or logo overlay and set consistency: judged by viewing every product's contact sheet myself (about 250 px tiles, one reviewer). Head cut follows DD1: `cut` when the top edge crosses the face between hairline and chin. Role codes follow DD0/DD1: FM front mid-thigh, FL full length, FC close-up, BH back, HS head and shoulders, PK packshot. For footwear: SD side, PR pair, TP top, SO sole, BK back, DT detail, OF on-foot, LS lifestyle. Also SC size chart and INF infographic.
- Channel rules: as in DD1's rule table and the brief (Styli/Centrepoint 5 roles, white or light grey; Noon cut-main and sequencing rejections; Amazon white main, product not cut, at most 9; Trendyol at most 8; Shein and VogaCloset at most 10; VogaCloset at least 4; Shein at least 2).

## Raw image findings per brand

Rates are exact counts on the sample.

| Brand | n | Median images (range) | Main image background | Pixel sizes | Typical set | Main problems seen |
|---|---|---|---|---|---|---|
| US Polo (footwear) | 20 | 6 (3-7) | white 20/20 | 1600x1600; on-legs extras 600x800 | side (white), pair x2, top, back, sole (#F5F5F5), sometimes on-legs | 7/20 miss a core view (kids and slides have 3-4 images); 7/20 mix in a 600x800 portrait on-legs shot with a white padding border; 1 infographic with text |
| Campus (footwear) | 15 | 6 (5-8) | white 15/15 | 1600x1600; lifestyle extras 600x800 | side, pair, top+sole, detail, lifestyle, size chart | 10/15 have no back view; 11/15 mix a padded 600x800 lifestyle; 6/15 have a size chart image |
| Penti | 15 | 4 (2-6) | white 15/15 (others light grey) | 800x1000 (size charts 1100x1500) | front, back, close-up on model, full length | 0/8 apparel have HS; 4/15 have 3 or fewer images; 3 head cuts at nose or mouth; detail shots inset on a margin; 5/15 size charts |
| French Connection | 19 | 6 (4-8) | light grey 15/19 | 1095x1500 to 2250x3000; one product mixes 3 sizes | front, full length, side, back, HS, packshot | 15/19 main not white; 4/17 apparel head cuts; raw brand folders sort with close-up or packshot first (1 close-up first); bags open on a model, packshot last |
| Vero Moda | 15 | 5 (1-14) | white 6, light grey 6, complex 2, black 1 | 768x1024 to 5338x7116 within one brand | packshot, model shots on studio floor or wall | 1 set on a black background; 2 sets with duplicate images (one has 14 images); 1 single-image product; 3 head cuts; boots repeated twice in a 10-image set |
| Only | 10 | 5 (1-5) | light grey 5/10 | 800x1091 | footwear: side, pair, back, top, detail; apparel: one packshot | 3/4 apparel are a single flat packshot touching the frame edges (product cut); footwear main on light grey, no sole view |
| Cardio Bunny sets | 15 | 6 (6-6) | white 15/15, then blue-grey | 800x1200 | same template: crop, back, full length, close-up, infographic, gym lifestyle | Generated from one brand photo; 14/15 carry infographic text; 4/15 head cuts at nose (2 on the main image); white main then blue-grey set |
| Cardio Bunny brand-sent | 5 | 1 | light grey 5/5 | 3000x4500 | one full-length studio photo per colour | One image per colour: fails every minimum count and every role list |
| Anta | 12 | 5 | white 12/12 | 800x800 | footwear side, angle, top, back, sole; apparel flat front, back, 3 close-ups | Very consistent, but 800x800 is below Amazon's 1,000 px zoom size and Styli's floor; apparel has no model |
| Keds | 7 | 8 (8-9) | white 7/7 | 800x1200 | 7 shoe views + size chart | Shoe fills only about a third of the frame width on the main image; size chart on every product; 1 has 9 images (over Trendyol's 8) |
| US Polo India codes | 5 | 1 (1-5) | complex 3/5 | 6240x3512 landscape | single camera shot | 3/5 are one unedited landscape camera frame with shadow and vignette |
| VM/Only EAN | 3 | 5 | mixed | 1792x2400 vs about 5000x6700 in one set | packshot + model | Mixed sizes in a set; one shoe tiny in a 5312x7082 frame |

Across all 141 softline products (exact):

| Measure | Count | Share |
|---|---|---|
| Main image pure white | 102 | 72% |
| Main image light grey / complex / coloured or black | 31 / 7 / 1 | 22% / 5% / 1% |
| On-model products with a head cut | 15 of 64 | 23% |
| Product cut by the frame on the main image | 6 | 4% |
| Product cut by the frame on any image (mostly intentional detail close-ups) | 35 | 25% |
| Text or logo overlay (size chart 20, infographic 15); no watermarks found | 35 | 25% |
| Inconsistent set (mixed pixel sizes, padding or background style) | 51 | 36% |
| Apparel with no model shot at all | 11 of 66 | 17% |
| Single image only | 12 | 9% |

Missing roles in apparel (66 products, exact): HS missing 57, FC 31, FM 25, BH 19, FL 14. In footwear (64 products),
counting side, pair, top, sole and back: back missing 20, sole 14, top 14, pair 6.

## Live vs raw comparison

Trendyol UAE (`gcc_channel_reports.product_list_trendyol_3p_uae`, latest file 22 Oct), joined on
`barcode = master_sl.ean`. 82 of 104 sampled ZSKU products have a Trendyol listing (exact). 37 were picked for the
visual comparison, spread over French Connection 7, Penti 7, Campus 6, Cardio Bunny 6, US Polo 7 and Keds 4. Only,
Vero Moda and Anta sample folders had no Trendyol match.

Trendyol serves every image at 1200x1800, so pixel size cannot show whether we resized. Each pair was judged visually
from side-by-side sheets.

| Verdict | Count | Share (exact) |
|---|---|---|
| Same photos, only resized or padded to 2:3 (often reordered; size chart sometimes added or dropped) | 24 | 65% |
| Same shoot, different background version (Keds on pure white instead of grey; Campus on darker grey; Penti with original warm backgrounds) | 10 | 27% |
| Different shoot | 2 | 5% |
| Wrong product (FC `ZB8B3C9012AE815065B7BZ`: a long-sleeve olive shirt in Supabase, a short-sleeve camp-collar shirt live) | 1 | 3% |
| Re-shot or repaired to fix a defect | 0 | 0% |

Other live observations (exact on the 37):
- 22 of 37 are reordered against the Supabase order.
- 7 of 37 now open with a lifestyle image on Trendyol (5 Cardio Bunny gym shots, a Penti beach shot, and a new Campus lifestyle image). Noon's "front first" rule would reject that main image.
- Head cuts in the Cardio Bunny sets (e.g. `ZE28682BAD5330D6EAA88Z`, `Z93BE312129C2474B4AD7Z`) are live unchanged.
- Padding to 2:3 makes square footwear shots small in the frame (`Z19D634036F3BD9660AC9Z`, Campus `ZB9B35DA074F17DE9E63FZ`).
- The 10 "different background" cases look like brand-supplied alternates, not team edits. They are the same pose and crop with only the background changed, and the Supabase copy is the one with the cleaned or grey background. Who made each version is not recorded.

Conclusion (approx, 37 products on one channel): about 9 in 10 live listings carry the brand photos as received, at
most resized, padded and reordered. No sign of a correction step between raw and live.

## Defect rates per channel rule

These rates replace the unmeasured "1 in 3". n = 141 softline products (66 apparel, 64 footwear, 11 other).
All counts are exact on the sample.

| Channel rule | All softline | Apparel | Footwear | Worst brands |
|---|---|---|---|---|
| **Amazon** main: pure white, product not cut, no text, not a detail or lifestyle shot | 44/141 (31%) | 33/66 (50%) | 9/64 (14%) | Only 9/10, FC 15/19 (79%), Vero Moda 10/15, CB brand-sent 5/5, US Polo India 3/5; US Polo, Campus, Penti, Anta and Keds 0 |
| Amazon: main image longest side under 1,000 px (no zoom) | 14/141 (10%) | 5/66 | 9/64 | Anta 12/12 (800x800) |
| Amazon: more than 9 images | 2/141 (1%) | 1 | 1 | Vero Moda (14 and 10 images) |
| **Noon**: cut or half product on the main image (named rejection) | 6/141 (4%) | 6/66 (9%) | 0 | Only 4/10 (flat packshots touching the frame), FC raw folder 1, Vero Moda 1 |
| Noon: incorrect sequencing (image 1 not a front view) | 4/141 (3%) | 1/66 | 1/64 | FC raw brand folders (close-up first). Live on Trendyol: 7 of 37 open with lifestyle |
| Noon/Shein: white first image, if applied (Noon exempts fashion) | 39/141 (28%) | 28/66 (42%) | 9/64 (14%) | FC 15/19, Vero Moda 9/15, CB brand-sent 5/5, Only 5/10 |
| **Styli / Centrepoint**: full 5-shot set FM, FL, FC, BH, HS | apparel only | 65/66 (98%) | n/a | Every brand 100% except FC 16/17 |
| Styli / Centrepoint: 4 shots FM, FL, BH, HS (close-up not required) | apparel only | 60/66 (91%) | n/a | 6 products pass: FC 4, Vero Moda 1, CB 1 |
| Styli / Centrepoint: background white or light grey on every non-close-up image | apparel only | 28/66 (42%) | n/a | CB sets 15/15 (blue-grey and gym lifestyle), Vero Moda 8/12, FC 4/17 |
| Styli / Centrepoint: head cut on an on-model shot | apparel only | 13/66 (20%) | n/a | CB sets 4/15, FC 4/17, Vero Moda 3/12, Penti 2/8 |
| Styli: smallest image below 1,482 px tall (2:3 floor, no upscaler) | 92/141 (65%) | 40/66 | 43/64 | Penti, Only, Anta, Keds, CB sets 100%; Campus 11/15 |
| Styli: below 741 px (floor with the x2 upscaler) | 1/141 (1%) | 1 | 0 | Vero Moda single 768x1024 set |
| **Trendyol**: more than 8 images | 3/141 (2%) | 1 | 2 | Vero Moda 2, Keds 1 |
| **VogaCloset**: fewer than 4 images | 21/141 (15%) | 14/66 (21%) | 5/64 | CB brand-sent 5/5, Only 4/10, Penti 4/15, US Polo India 3/5 |
| **Shein**: fewer than 2 images | 12/141 (9%) | 9/66 | 3/64 | CB brand-sent 5/5, Only 3/10, US Polo India 3/5 |
| Footwear core 5 views (side, pair, top, sole, back; DD1 proposes PK only, so this is stricter) | n/a | n/a | 30/64 (47%) | Campus 10/15 (no back), Only 6/6 (no sole), US Polo 7/20 |

Composite measures (exact on the sample):
- **Lenient "framing, size or missing shot"**: head cut or product cut on the main image, apparel without front + back + close-up, footwear without side + one other view, or a single image. **45/141 (32%)**, which matches the "1 in 3" assumption. By brand: FC 13/19, Penti 6/15, CB sets 6/15, Vero Moda 6/15, CB brand-sent 5/5, Only 4/10, US Polo India 3/5, US Polo 1/20, Campus, Anta and Keds 0.
- **Strict, against the channel rules**: framing defect, or missing the Styli 5-shot set (apparel) or the 5 core footwear views. **97/141 (69%)**. Adding the size checks (below 741 px, or main under 1,000 px) gives 106/141 (75%).
- Framing alone (head cut or product cut on the main image): 21/141 (15%); apparel 19/66 (29%).

Reading for the revenue model (approx): "1 in 3" is right only for a minimum standard of a front, a back and a
close-up with no cut heads. For Styli and Centrepoint, almost every apparel product is short of the required set,
mainly the head-and-shoulders shot. For Amazon and Noon, the main-image defect sits in French Connection, Vero Moda,
Only and the brand-sent Cardio Bunny photos (about half of apparel). Footwear brands (US Polo, Campus, Anta, Keds)
mostly pass the main-image rules.

## Examples

All paths are under `...\scratchpad\audit\raw\<Brand>\<folder>\`. Supabase source in brackets.

| # | File(s) | Brand | What is wrong | Channel rule broken |
|---|---|---|---|---|
| 1 | `VeroModa\10352088_Chocolate-Torte\10352088_Chocolate-Torte_1.jpeg` to `_4` (`softlines/vero-moda/`) | Vero Moda | Flat trousers on a solid black background; images 3-4 duplicate 1-2; 900x1176; no model | Amazon white main; Styli/Centrepoint white or grey background and 5-shot set |
| 2 | `FrenchConnection\599A5\` (raw brand folder `softlines/french-connection/599A5`) | French Connection | First file is a fabric close-up that cuts the shorts; packshot and model come later | Noon "cut or half product on main image" and "incorrect sequencing" |
| 3 | `Only\ZF387E332E81ABFF06903Z\ZF387E332E81ABFF06903Z_1.jpeg` (`softlines/only/`) | Only | Single flat packshot whose trousers touch the top and bottom edges | Amazon main "not cut by the frame"; VogaCloset minimum 4; Shein minimum 2; Styli set |
| 4 | `CardioBunny\ZE28682BAD5330D6EAA88Z\..._1.jpeg` and `_5.jpeg` (`softlines/cardio-bunny/`) | Cardio Bunny | Main image cropped through the nose; image 5 is an infographic whose text is clipped at the edge ("MOVEMEI"); live on Trendyol with the gym lifestyle as image 1 | Styli/Centrepoint head cut; Noon front-first sequencing (live) |
| 5 | `FrenchConnection\Z43F210872B65F8B0443CZ\` (`softlines/french-connection/`) | French Connection | One set in three pixel sizes (1201x1637, 1101x1502, 1400x1909); image 3 cut at the nose; Trendyol shows a different shoot with only 3 images | Styli head cut; set consistency; Trendyol listing does not match the master |
| 6 | `VeroModa\10288257_Cloud-Dancer\` (`softlines/vero-moda/`) | Vero Moda | 14 images, several near-duplicates | Trendyol 8, Amazon 9, Shein and VogaCloset 10 maximum |
| 7 | `CardioBunnyFlat\CB_HCB-726-532-01_CREAM.jpeg` (`cardio-bunny-sku-images`) | Cardio Bunny | The brand sends one 3000x4500 full-length photo per colour, on light grey | Amazon white main; VogaCloset 4 and Shein 2 minimum; Styli 5-shot set |
| 8 | `USPoloAssnIN\102693414\102693414_1.jpg` (`softlines/us-polo-assn/`) | US Polo | One unedited 6240x3512 landscape camera frame with shadow and vignette | Amazon white main; every channel's portrait or square canvas |
| 9 | `USPolo\Z3FE9377898FABAEF0839Z\..._5.jpg`, `_6.jpg` (`us-polo-sku-images`) | US Polo | 600x800 padded infographic with callout text and a street lifestyle mixed into a 1600x1600 packshot set | Set consistency; text images (fine as secondary on Amazon, not as main) |
| 10 | Live: Trendyol barcode for `FrenchConnection\ZB8B3C9012AE815065B7BZ` vs `live\FrenchConnection\ZB8B3C9012AE815065B7BZ\` | French Connection | Live listing shows a different shirt from the Supabase and master images | Wrong product live (any channel) |

## Gaps

- Live comparison covers Trendyol UAE only. Scout (`opptra_core.listing_content_observation`, since 1 Jan 2026) has no GCC softline brands; it holds Hamleys, Garmin, Bergner and India brands. Noon and Namshi pages were not opened in a browser, so live Noon, Namshi and Amazon images are unmeasured.
- Only, Vero Moda, Anta, Nautica and Puma are not in the live comparison. Their sampled folders had no Trendyol match through `master_sl`, and Nautica/Puma have no Supabase folders.
- Visual judgements were made by one reviewer on about 250 px contact-sheet tiles. Head cuts and role calls near the borderline (forehead or hair crops, chin crops) could move a few products either way (approx plus or minus 3 products per measure). No second reviewer and no model-based check.
- "Fabric close-up without model" was not separated from close-ups on a model, so the Styli FC rate is lenient. HS was counted strictly (head and shoulders filling the frame).
- Which copy is the brand original is unclear. The audit used the earliest bucket per brand (the July `*-sku-images` buckets; `softlines/` for the rest), and those copies may already be resized or cleaned (Penti's 800x1000 vs the larger `penti-225` copies; French Connection in 3 folders).
- The Cardio Bunny sets in `softlines/cardio-bunny` look generated, not brand photos. They are scored as they are, since they are what goes live.
- The sample is random within folders, not weighted by revenue or by live listings. Brand rates rest on 5 to 20 products, so they are indicative (approx).
- Noon's public rule exempts fashion from the white first image. The 28% white-main rate applies fully to Amazon (main) and Shein, and to Noon only for non-fashion items.
- The `product-images` bucket (India catalogue, 16,571 files of which 1,986 are under 1 KB) and the hardline buckets were not audited.

Status: done
