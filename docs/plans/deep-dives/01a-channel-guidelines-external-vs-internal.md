# DD1a. Channel image requirements, external vs internal (9 GCC channels, UAE and KSA)

Date: 2026-10-22. Documents only; no code, infra or data was changed.

## Summary

- Only 2 of 9 channels publish a reachable official image page: Noon (help centre, fetched in full) and Amazon (a Clothing style guide PDF hosted by Amazon; the Amazon.ae and Amazon.sa help pages did not render outside a browser). Namshi, Styli, Centrepoint, 6thStreet publish nothing public; Trendyol, VogaCloset and Shein are known only from integrator pages (secondary). Styli uses the owner's studio email.
- Sizes, DPI, colour space, file size and format: the repo meets or is stricter than every published rule. No channel publishes a rule our 2 MB sRGB JPEG breaks.
- Biggest gap 1 (official, Noon): the first image must be pure white for every category except fashion; we put light grey `#E0E0E0` on every Noon image, so a non-fashion (hardline) product's main image can be rejected ("Needs editing").
- Biggest gap 2: channels cap the image count (Amazon 9, Trendyol 8, Shein and VogaCloset 10) and some set a minimum (VogaCloset 4, Shein 2). We have no cap and no minimum. Extra links could be dropped without warning, or a listing could be refused.
- Biggest gap 3: a main image showing a cut product is a named rejection on Noon and can hide the product from search on Amazon, and Styli fails head cuts. We publish source-cut photos with a note on every channel, image 1 included.
- Shot roles and order (the Styli 5 roles; Noon's front, back, side, details order, where "Incorrect sequencing" is a named rejection reason) and on-model rules (Amazon, Noon) are not encoded anywhere. Amazon's style guide asks for a MAIN crop between nose and upper lip, which is the opposite of Styli's head rule.
- Unverified internal values that need the owner's source: Centrepoint 3000x3000 1:1, 6thStreet and VogaCloset 2000x2667, Trendyol "no spaces" and grey background, and Shein "image 1 white". VogaCloset's integrator lists 800x1200 (2:3), not 3:4.
- Some sheet text in the repo disagrees with its own code: Amazon "3:4 portrait" vs a 1:1 canvas, Trendyol "3:4" vs 1200x1800 (2:3), and Namshi "= Noon rules" without Noon's 5% side margin.

## Method

Internal values were read from worktree `01-intent-map` at commit `4f8c0be`. Short names used in the tables:
`ch` = `packages/core/src/catalog/channels.ts`, `co` = `packages/core/src/catalog/compliance.ts`,
`re` = `packages/core/src/catalog/render.ts`, `up` = `packages/core/src/catalog/upscale.ts`,
`na` = `packages/core/src/catalog/naming.ts`, `SPEC` = `docs/SPEC.md`, `s07` = `docs/specs/07-qa-attention-and-skus.md`,
`s10` = `docs/specs/10-output-quality-evals.md`, `IM` = `docs/plans/2026-10-21-catalog-connect-gcc-intent-map.md`.
"x:n" means file x, line n.

The rules below are the same for every channel. The channel tables cite them as "common":

| Field | Internal value (file and line) |
|---|---|
| File format | JPEG only, lowercase `.jpg`, 4:4:4 chroma, quality 90 stepping to 70 (re:610, ch:202-204, co:22, co:25, co:28) |
| Colour space | sRGB with an embedded ICC profile, no alpha (re:610, co:28) |
| Max file size | 2,000,000 bytes (ch:205, co:23) |
| Source floor | Under 500 px on the long side is flagged `small_source` (ch:208, re:46). Above 1.5x enlargement is flagged `low_resolution` (ch:206, re:466), and the x2 upscaler is used past 1.5x (up:14, up:16) |
| Shadow | Keep the original soft shadow, or add a soft contact shadow for footwear, bags and hardline. Never for apparel (re:599-603, SPEC:287-290) |
| Image count | No cap; the input decides (SPEC:64, SPEC:841) |
| Shot order or roles | File-name number order, renumbered 1..k. No roles (na:75) |
| On-model rule | None |
| Head cut rule | Never crop. A photo already cut in the source is published with a note on every channel (SPEC:277, s07:336, s10:234) |
| Text or logo overlay | Never added. The QA judge flags `text_or_watermark` and `collage` on the source (SPEC:297-299, s07:123) |
| Naming | `catalog/<brand>/<path_key>/<channel>/<path_key>_<n>.jpg`. Spaces become `_` and the compliance check fails a path with a space (na:153, na:89, co:24, SPEC:337) |

External sources, all fetched 2026-10-22:

| # | Source | Status |
|---|---|---|
| E1 | noon Seller Help Center, "Image requirements and rejection reasons for the seller SKU", https://helpcenter.noon.partners/en/category/product-listing/image-requirements-and-rejection-reasons-for-the-seller-sku (same text at https://supportagent.noon.partners/portal/en/kb/articles/image-requirements-and-rejection-reasons-for-the-seller-sku-12-3-2024) | Official, public, fetched in full. No date on the page. One help centre for every noon country; no UAE or KSA difference stated. The older page https://help.noon.partners/hc/en-us/articles/4409014578583 timed out. A search snippet of it still says "660x900 ... 0.73", which matches the repo's sheet text, so the rule has since been relaxed |
| E2 | Amazon "Selling Partner Style Guide: Clothing & Accessories", Mar 2022, https://m.media-amazon.com/images/G/65/SG3P/LISTING_GUIDES/Amazon_Fashion_Clothing_Image_Style_Guide.pdf | Official (Amazon-hosted). The marketplace is not named in the PDF |
| E3 | Amazon Seller Central help G1881, https://sellercentral.amazon.ae/help/hub/reference/external/G1881 and https://sellercentral.amazon.sa/help/hub/reference/external/G1881 | Not reachable: the page is a JavaScript app and returned only a shell to a plain fetch. Not verified. Effectively "login or browser required" |
| E4 | Jungle Scout, "Amazon image requirements" (article dated 2024-04-05), https://www.junglescout.com/resources/articles/amazon-image-requirements/ | Secondary. Quotes Amazon's US rules |
| E5 | ChannelEngine "Trendyol International: marketplace guide" (updated 2026-09-17), https://support.channelengine.com/hc/en-us/articles/24668731865117, and "Trendyol Turkey" (updated 2026-09-17), https://support.channelengine.com/hc/en-us/articles/9746557071005 | Secondary (integrator). Read through the Zendesk article API because the HTML page returned 403. The International guide lists the United Arab Emirates and Saudi Arabia as served |
| E6 | ChannelEngine "SHEIN: marketplace guide" (updated 2026-04-03), https://support.channelengine.com/hc/en-us/articles/21552893542941 | Secondary. Covers SHEIN's EU marketplace (Germany, France, Italy, Netherlands, Poland, Portugal, Spain, Sweden, UK), not GCC |
| E7 | Tradebyte "Channel sheet: VogaCloset", https://help.tradebyte.com/doc_cs_vogacloset.html; ChannelEngine "VogaCloset: marketplace guide" (updated 2026-09-17), https://support.channelengine.com/hc/en-us/articles/26031217406749 | Secondary. VogaCloset serves the UAE and Saudi Arabia among others |
| E8 | Streamoid "Namshi seller guide", https://streamoid.com/resources/guides/namshi-seller-guide | Secondary, no date, no numbers |
| E9 | Styli studio email from Raymond Lim, Imaging Executive - Studio, as given in the brief and in IM:25-29 | Treated as Styli's external source, as instructed. The email itself was not re-read |
| - | Namshi, Centrepoint, 6thStreet official pages; Trendyol partner centre; SHEIN seller centre | Searched (English and Turkish). No public page found. Seller or vendor portals need a login: not verified |

Context7 was not available in this session (no Context7 tool was offered), so no API documentation was used. Marketplace help pages are the primary sources. No paid API, GCP call or secret was used.

## Comparison tables

### Noon (UAE and KSA)

Internal: ch:53-67. External: E1 unless marked.

| Field | Internal value (file and line) | External value (quoted) | Verdict | Note |
|---|---|---|---|---|
| Width, height | Adaptive 660x904 up to 1080x1480 (ch:57-58, re:440-446) | "Image width should be >= 660pixels" | same | Meets the floor |
| Aspect ratio | 0.73 (1080:1480), enforced by co:30 | "maintain a width by height ratio (aspect ratio) >= 0.5" | same | The repo's sheet text "0.73 (3:4)" (ch:65) is the old rule; still compliant |
| Minimum source | Common floors; min canvas 660x900 (ch:57) | not stated | unknown | |
| File format | Common: JPEG | "Images must be submitted in JPEG or JPG format only." | same | |
| Colour space | Common: sRGB | "RGB/sRGB." | same | |
| Max file size | 2,000,000 bytes (ch:205); sheet text "<=2 MB" (ch:65) | "must not exceed 10 MB." | different (safe) | We are stricter |
| Background | `#E0E0E0` on every image (ch:48, ch:61) | "Pure white background for all categories except for the fashion; where the recommended background is light grey." / "Always use a white background for the first image except for the fashion category" | different | Correct for fashion. Wrong for non-fashion image 1. See Differences 1 |
| Margins or fill | Top and bottom 10%; 5% sides only when the product is wider than tall (ch:59, co:58) | "If the product is shot vertically then a 10% margin should be left on top and bottom, and if the product is shot horizontally then a 5% margin should be left on both sides." / "cover at least 70-80% of the image frame" | same | |
| DPI | 72 (ch:62, co:31) | "Resolution should be above or equal to ≥ 72 PPI" | same | |
| Shadow | Common | "Light shadows only are accepted but hard shadow or hard reflection shouldn't be used." | same | Soft shadows only |
| Image count | Common: no cap | "It is highly recommended to upload a minimum of 3 high-quality images" | different | A recommendation, not a rejection |
| Shot order or roles | Common: file order | "Incorrect sequencing ... Front view. Back view. Side view. Any other angles. Details. Usage." | different | "Incorrect sequencing" is a listed rejection reason |
| On-model (apparel) | None | "For the Adults apparel category, it is recommended to have pictures shot on models ... except for swimwear and underwear." / "For the Kids apparel category, it is recommended to have flat lay shots" | different | Recommendation |
| Head or product cut | Common: published with a note | "Image - Cropped/half image ... Any image which has a portion of the product cropped (missing) will be not allowed as a primary image." | different | Applies to the primary image only |
| Text or logo overlay | Common | "Images should not contain watermarks, seller names, or seller logos." / "Don't include borders around your product image." | same | |
| Naming | Common | "it might not be named properly, or the URL which is provided is not valid" (Broken images) | unknown | No naming rule given |
| Country difference | One rule set for both | None stated | same | |

### Namshi (UAE and KSA)

Internal: ch:68-81 (sheet text "= Noon rules"). External: no official page; E8 is secondary.

| Field | Internal value (file and line) | External value (quoted) | Verdict | Note |
|---|---|---|---|---|
| Width, height | 660x904 to 1080x1480 (ch:72-73) | not published | unknown | |
| Aspect ratio | 0.73 | not published | unknown | |
| Minimum source | Common | not published | unknown | |
| File format | Common | not published | unknown | |
| Colour space | Common | not published | unknown | |
| Max file size | 2 MB | not published | unknown | |
| Background | `#E0E0E0` (ch:76) | Secondary E8: "Clean white or neutral background" | unknown | |
| Margins or fill | Top and bottom 10%, sides 0 (ch:74) | not published | unknown | The repo's own "= Noon rules" leaves out Noon's 5% side margin for wide products. This is an internal inconsistency |
| DPI | 72 (ch:77) | not published | unknown | |
| Shadow | Common | not published | unknown | |
| Image count | No cap | not published | unknown | IM:30 says Namshi accepts 1 but 5 is "good catalog" (meeting, not a page) |
| Shot order or roles | File order | Secondary E8: fashion "Front, back, side views", "Detail shots", "Fabric texture visible" | unknown | |
| On-model (apparel) | None | Secondary E8: "Model images recommended"; rejection "No model images (when required)" | unknown | |
| Head cut | Common | not published | unknown | |
| Text or logo overlay | Common | Secondary E8: "No watermarks or text" | same (secondary) | |
| Naming | Common | Secondary E8: "Image URLs per angle" | unknown | |

### Trendyol (Trendyol International, UAE and KSA)

Internal: ch:82-96. External: E5 (secondary). The Trendyol partner centre needs a login: not verified.

| Field | Internal value (file and line) | External value (quoted) | Verdict | Note |
|---|---|---|---|---|
| Width, height | Exactly 1200x1800 (ch:87, ch:92, co:30) | "Minimum resolution - 600x800 px at 72 dpi. Desired resolution - 1200x1800 px at 96 dpi." Images 2-8 (International): "Maximum resolution - 2,000x2,000 px." | same (secondary) | |
| Aspect ratio | 2:3 (1200x1800); sheet text says "3:4" (ch:94) | 2:3 implied by 1200x1800 | same | The sheet text "3:4" is wrong for its own size. This is an internal inconsistency |
| Minimum source | Common; min canvas 600x800 (ch:86) | "600x800 px at 72 dpi" | same | |
| File format | JPEG | "File format - JPG, JPEG or PNG." | same | |
| Colour space | sRGB | not stated | unknown | |
| Max file size | 2 MB (sheet "<=2 MB", ch:94) | "Maximum file size - 10 MB." | different (safe) | |
| Background | `#E0E0E0` (ch:90) | not stated | unknown | Turkish third-party blogs claim a white main image, without a Trendyol source |
| Margins or fill | None (ch:88) | not stated | unknown | |
| DPI | 96 (ch:91) | "1200x1800 px at 96 dpi" | same | |
| Shadow | Common | not stated | unknown | |
| Image count | No cap | Fields "Product image URL 1" plus "Product image URL 2-8" (8 in total) | different | See Differences 2 |
| Shot order or roles | File order | not stated | unknown | |
| On-model | None | not stated | unknown | |
| Head cut | Common | not stated | unknown | |
| Text or logo overlay | Common | not stated | unknown | |
| Naming or URL | HTTPS public link; no spaces (co:24, SPEC:114) | "URL format - 'https'." | same in part | "No spaces in the filename" is not in E5: unknown |
| Country difference | One rule | International and Turkey guides give the same image rules, except the 2,000x2,000 maximum on International images 2-8 | same | |

### Styli (UAE and KSA)

Internal: ch:97-111, ch:209-220, co:57, re:550. External: E9 (owner's studio email).

| Field | Internal value (file and line) | External value (quoted) | Verdict | Note |
|---|---|---|---|---|
| Width, height | Exactly 2342x3123 (ch:101-102, co:30) | "size 2342x3123" | same | The repo's sheet text "1200x1600 -> 2000x2667" (ch:109) is stale; the code follows the email |
| Aspect ratio | 3:4 | 3:4 | same | |
| Minimum source | 1482 px high without the upscaler, 741 px with x2. Smaller photos are skipped (ch:210-220, re:550) | not in the relayed email | unknown | The skip is "by agreement with Styli" (SPEC:110); the agreement is not in the email text |
| File format | JPEG | not in the relayed text | unknown | |
| Colour space | sRGB | not in the relayed text | unknown | |
| Max file size | 2 MB | not in the relayed text | unknown | |
| Background | `#E0E0E0` (ch:105) | "white or light grey background" | same | |
| Margins or fill | Guides top 450, bottom 450, left 150, right 150 px, bottom-centre, uniform scale (ch:103-108, co:57) | not in the relayed text | unknown | The owner should confirm the guides come from the email or its attachment |
| DPI | 300 (ch:106) | not in the relayed text | unknown | |
| Shadow | Common | not in the relayed text | unknown | |
| Image count | No cap | 5 shots | different | |
| Shot order or roles | File order | "(1) front cropped mid-thigh, (2) full-length head to toe, (3) fabric texture close-up without the model, (4) back cropped at the hips, (5) head-and-shoulders close-up" (IM:27-29) | different | No role check anywhere in the repo |
| On-model (apparel) | None | "same model and lighting" | different | |
| Head cut | Common: published with a note | "Body crops are fine; only head cuts fail." (IM:29) | different | See Differences 3 |
| Text or logo overlay | Common | not in the relayed text | unknown | |
| Naming | Common | not in the relayed text | unknown | |

### Centrepoint (UAE and KSA)

Internal: ch:112-125. External: none public (Landmark supplier or vendor portal: login required, not verified).

| Field | Internal value (file and line) | External value (quoted) | Verdict | Note |
|---|---|---|---|---|
| Width, height | Exactly 3000x3000 (ch:116-117) | not published | unknown | Landmark's studio email for Styli uses 2342x3123 (3:4). If Centrepoint shares the Landmark studio spec, a square image is the wrong shape |
| Aspect ratio | 1:1 | not published | unknown | |
| Minimum source | Common | not published | unknown | |
| File format, colour, max size | Common | not published | unknown | |
| Background | `#E0E0E0` (ch:120) | not published | unknown | |
| Margins or fill | None (ch:118) | not published | unknown | |
| DPI | 300 (ch:121) | not published | unknown | |
| Shadow | Common | not published | unknown | |
| Image count | No cap | not published | unknown | IM:24 and DD0 say Centrepoint expects 5 model photos for apparel (meeting, not a page) |
| Shot order, on-model, head cut | Common | not published | unknown | The meeting's "head cut off" complaint was raised on Centrepoint output (IM:21) |
| Text or logo overlay | Common | not published | unknown | |
| Naming | Common | not published | unknown | |

### 6thStreet (UAE and KSA)

Internal: ch:126-139. External: none public (Apparel Group vendor portal: login required, not verified).

| Field | Internal value (file and line) | External value (quoted) | Verdict | Note |
|---|---|---|---|---|
| Width, height | Adaptive 1200x1600 to 2000x2667 (ch:130-131) | not published | unknown | |
| Aspect ratio | 3:4 | not published | unknown | |
| Minimum source | Common | not published | unknown | |
| File format, colour, max size | Common | not published | unknown | |
| Background | `#E0E0E0` (ch:134) | not published | unknown | |
| Margins or fill | None (ch:132) | not published | unknown | |
| DPI | 300 (ch:135) | not published | unknown | |
| Shadow, image count, order, on-model, head cut | Common | not published | unknown | |
| Text or logo overlay | Common | not published | unknown | |
| Naming | Common | not published | unknown | |

### VogaCloset (UAE and KSA)

Internal: ch:140-153 (sheet text "same as 6thStreet"). External: E7 (secondary).

| Field | Internal value (file and line) | External value (quoted) | Verdict | Note |
|---|---|---|---|---|
| Width, height | Adaptive 1200x1600 to 2000x2667 (ch:144-145) | Tradebyte: "Size: 800x1200 px" | different (secondary) | |
| Aspect ratio | 3:4 | 2:3 implied by 800x1200 | different (secondary) | A 3:4 image on a 2:3 slot may be padded or cropped on the site |
| Minimum source | Common | not stated | unknown | |
| File format | JPEG | "png or jpg" | same | |
| Colour space | sRGB | not stated | unknown | |
| Max file size | 2 MB | not stated | unknown | |
| Background | `#E0E0E0` (ch:148) | not stated | unknown | |
| Margins or fill | None (ch:146) | not stated | unknown | |
| DPI | 300 (ch:149) | "Resolution: No DPI requirement" | same | |
| Shadow | Common | not stated | unknown | |
| Image count | No cap, no minimum | Tradebyte: "Number: Min. 4 article images"; ChannelEngine fields "Image URL" plus "Extra image URL 1-9" (10 in total) | different | See Differences 2 |
| Order, on-model, head cut | Common | not stated | unknown | |
| Text or logo overlay | Common | not stated | unknown | |
| Naming | Common | "Image URL - the product's main image" | unknown | |

### Amazon.ae and Amazon.sa

Internal: ch:154-168, ch:197-200. External: E2 (official PDF), E3 (not reachable), E4 (secondary).

| Field | Internal value (file and line) | External value (quoted) | Verdict | Note |
|---|---|---|---|---|
| Width, height | Adaptive 1000x1000 to 2000x2000 (ch:158-159) | E2: "at least 1,000px on the longest side and no larger than 3,900px on the longest side, to enable zoom functionality." E4: "1600px or larger on the longest side" is optimal | same | |
| Aspect ratio | 1:1 (co:30). Sheet text says "3:4 portrait" (ch:167) | E2: "Image aspect ratio must be at least 190 x 246px, 10:13 aspect ratio" and "Choose the crop that will display the product bigger but respect the aspect ratio of the website. (10:13)"; "If the crop is square, all the others images should be cropped square." | different (allowed) | Square is accepted. 10:13 shows apparel bigger. The sheet text disagrees with the code (internal inconsistency) |
| Minimum source | Common; min canvas 1000 (ch:158) | E4: "the smallest your file can be for the site is 500px" | same | |
| File format | JPEG | E2: "Amazon accepts JPEG (.jpg) and TIFF (. tif ) JPEG is preferred" | same | |
| Colour space | sRGB | E2: "Color profile should be RGB or CMYK (RGB is preferred ...)" | same | |
| Max file size | 2 MB | not stated in E2 | unknown | |
| Background | Image 1 `#FFFFFF`, others `#E0E0E0` (ch:162-163, ch:197-200, co:51) | E2: "MAIN images must have a pure white background (RGB Value 255, ... HEX Value #FFFFFF." MAIN don'ts: "Image is on grey background" | same | Grey is listed as a don't only for MAIN; alternates have no background rule |
| Margins or fill | None: the product fits the full canvas on its limiting side (ch:160) | E4: "Product must fill at least 85% of the image." | same | Long side fills 100% |
| DPI | 300 (ch:164) | E2: "Resolution should be at least 72 dpi" | same | |
| Shadow | Common; no shadow in the shot 1 border band (co:51) | not stated in E2 | unknown | |
| Image count | No cap | E2: "You can supply up to eight alternate images"; "minimum of 4 and maximum 7 images per product" recommended | different | 9 in total (1 MAIN + 8). See Differences 2 |
| Shot order or roles | File order; shot 1 gets white | E2: "MANDATORY Front shot", "EXTREMELY IMPORTANT Back Shot", then styled and detail shots | different | |
| On-model (apparel) | None | E2: "Models MUST WEAR SHOES on the MAIN (except for swimwear and sleepwear)"; "models must be standing". E4 (US): "MAIN images for Women's and Men's clothing must show the product on a human model." / "All images of Kids & Baby clothing must be photographed flat" | different | E2 also has an off-figure MAIN crop guide, so the strict US rule in E4 may not apply in the GCC |
| Head cut | Common: published with a note | E2 MAIN full-length crop: "The top of the image must be cropped between nose and upper lip"; MAIN don'ts: "Avoid part of the product for sale cropped by a frame edge" | different | A face crop is the opposite of Styli's head rule. See Differences 5 |
| Text or logo overlay | Common | E2: "Borders, logos, watermarks, inset images, text, color blocks, or other decorations" are MAIN don'ts | same | |
| Naming | Common | E2: "Example of file name: B00SAMPLE.PT02.jpg"; MAIN, PT01 to PT08 | different | Matters only for bulk zip upload; URL-based flat files do not need it |
| Country difference | One rule | E3 not reachable, so the .ae and .sa pages are not verified | unknown | |

### Shein (GCC)

Internal: ch:169-183 (sheet text "exactly Amazon"). External: E6 (secondary, EU marketplace); no GCC source found. The SHEIN seller centre needs a login: not verified.

| Field | Internal value (file and line) | External value (quoted) | Verdict | Note |
|---|---|---|---|---|
| Width, height | Adaptive 1000x1000 to 2000x2000 (ch:173-174) | "Resolution - 900x2200 px. Square image resolution - 900x900 px or 2200x2200 px." | same (secondary) | Inside the range |
| Aspect ratio | 1:1 | "Width to height ratio - 1:1, 3:4 , 4:5, or 13:16." | same (secondary) | |
| Minimum source | Common | not stated | unknown | |
| File format | JPEG | "Formats - JPG, JPEG, PNG." | same | |
| Colour space | sRGB | not stated | unknown | |
| Max file size | 2 MB | "Maximum file size - 3MB." | same | |
| Background | Image 1 `#FFFFFF`, others `#E0E0E0` (ch:177-178) | not stated | unknown | "Image 1 pure white" has no published source |
| Margins or fill | None (ch:175) | not stated | unknown | |
| DPI | 300 (ch:179) | not stated | unknown | |
| Shadow | Common | not stated | unknown | |
| Image count | No cap, no minimum | Required "Image URL" and "Extra image URL 1"; optional "Extra image URL 2-9" (10 in total, at least 2) | different (secondary) | See Differences 2 |
| Order, on-model, head cut | Common | not stated | unknown | |
| Text or logo overlay | Common | not stated | unknown | |
| Naming | Common | "Square image - the URL of an image with square dimensions"; "Color thumbnail" | unknown | Our 1:1 output can fill the square field; we make no 80x80 colour swatch |

## Differences that matter (ranked by risk to publishing)

1. Noon (official): white main image for non-fashion products. E1 says "Always use a white background for the first image except for the fashion category". The repo puts `#E0E0E0` on every Noon image (ch:61). Any hardline, home or other non-fashion brand sent to Noon gets a grey main image, and noon lists "Needs editing - Unclear background" as a rejection reason. Namshi copies Noon's rules in the repo, so it may carry the same risk. Whether noon counts footwear and bags as "fashion" is not stated.
2. Image count caps and minimums (silent drop or listing refused). Amazon allows 9 (E2), Trendyol 8 (E5), and Shein and VogaCloset 10 (E6, E7, secondary). The repo has no cap (SPEC:64), so the links sheet can offer more images than a channel takes, and the extras are lost without a warning. VogaCloset wants at least 4 and Shein at least 2 (secondary). A product with fewer photos can be refused, and nothing in the repo warns about it.
3. Cut product on the main image (rejection or hidden listing). Noon rejects a cut primary image ("Cropped/half image"). Amazon's MAIN don'ts include "part of the product for sale cropped by a frame edge", and it warns of "suppression of your ASIN from search". Styli fails head cuts. The repo publishes photos already cut in the source, with a note, on every channel and in every position, image 1 included (s10:234). This is the "head cut off" complaint from the meeting.
4. Shot roles and order are not encoded. Styli wants 5 roles in a fixed order. Noon names "Incorrect sequencing" as a rejection reason (front, back, side, other angles, details, usage). Amazon marks front as mandatory and back as extremely important. The repo uses file-name order with no role check (na:75), so a set in the wrong order or missing a role goes out as is.
5. Apparel on-model and crop rules differ by channel and are not checked. Amazon's MAIN needs a standing model wearing shoes, a crop between nose and upper lip for full-length items, and flat lay for kids; the US rule also says adult clothing must be on a model (secondary). Noon recommends models for adults and flat lay for kids. Styli fails any head cut. One source photo cannot satisfy both Amazon's face crop and Styli's whole head, so a per-channel crop (spec 12 role derivation) would be needed to follow both.
6. Centrepoint 3000x3000 1:1 is unverified. Centrepoint is a Landmark brand like Styli, and Landmark's studio spec in the Styli email is 2342x3123 (3:4) with 5 model shots. If Centrepoint follows it, every Centrepoint image is the wrong shape.
7. VogaCloset may want 2:3. The integrator lists 800x1200 (secondary); the repo makes 3:4 at up to 2000x2667. The site may pad or crop it. Not a likely rejection.
8. Unverified internal values for which no published source was found: Trendyol "no spaces in filename" and its grey background; Shein's white first image; DPI and sizes for 6thStreet, VogaCloset and Centrepoint; and Styli's 450/150 px guides and low-resolution skip agreement (not in the relayed email text). None is known to be wrong, but none can be checked today.
9. The sheet text in the repo disagrees with its own code: Amazon "3:4 portrait" vs 1:1 (ch:167), Trendyol "3:4" vs 2:3 (ch:94), Styli "1200x1600 -> 2000x2667" vs 2342x3123 (ch:109), and Namshi "= Noon rules" without Noon's 5% wide-product side margin (ch:74, ch:80). No rejection risk, but the wizard and the sheet describe rules that do not match the code.
10. Safe differences: Noon and Trendyol allow 10 MB and Shein 3 MB, against our 2 MB. Noon now accepts any width-to-height ratio of at least 0.5 at 660 px wide, against our 0.73. Amazon allows 72 dpi and up to 3,900 px, against our 300 dpi and 2,000 px. No action is needed.

## Open items for the owner

1. Noon background: which product types count as "fashion" for noon (apparel only, or also footwear, bags and accessories)? Should non-fashion products get a pure white image 1 on Noon, and on Namshi?
2. Image caps: should the links sheet stop at each channel's maximum (Amazon 9, Trendyol 8, Shein 10, VogaCloset 10) and warn when a product is under a channel's minimum (VogaCloset 4, Shein 2)? This needs your yes before anything changes.
3. Please share the source for these internal values: Centrepoint 3000x3000 and 300 PPI; 6thStreet and VogaCloset 2000x2667; Trendyol "no spaces" and grey; Shein "image 1 white"; Styli guides 450/150 px and the low-resolution skip agreement. If these came from a guideline sheet or partner emails, can they be added to `docs/` so the next check can quote them?
4. Centrepoint: does it follow the Landmark studio spec in the Styli email (2342x3123, 5 model shots), or its own square 3000x3000?
5. Do you or Naz have seller-portal access for Amazon.ae and .sa, Namshi, Trendyol, Shein, 6thStreet and VogaCloset? An export or screenshot of each image-rules page would turn the "unknown" rows into "same" or "different".
6. Cut main image: should a photo cut in the source be kept out of position 1 on Noon and Amazon (it can still be an alternate), instead of being published with a note?

Status: done, awaiting owner answer
