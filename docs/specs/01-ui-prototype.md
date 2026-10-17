# 01 UI prototype and approval gate

## Status

The clickable prototype exists and is published as a private artifact:

- URL: https://claude.ai/artifact/HL7t82VTQ1bRchziPwLySr
- Version: 2
- Title: "Catalog Images"
- Local copy: `docs/prototype/catalog-prototype.html` (same file as the artifact, kept in the repo so
  builders never need to open the artifact).
- Form: a single HTML page with hash navigation (`#list`, `#new1`, `#new2`, `#new3`, `#new4`); the
  batch page is opened by clicking a row (`openBatch(<state>)`) and has no hash of its own. Realistic
  sample data: USPA kids footwear, French Connection apparel, Anta and Campus thumbnails, every
  operator-facing sentence written out in full.

Nothing after this spec starts until the human approves the prototype. This file records what
version 2 contains, in words, so that the later specs can be built against it, and adds in words the
screens the product-identity decision requires that version 2 does not yet show.

## Approval gate

1. The human opens the artifact and clicks through every screen listed below.
2. Changes are requested in plain words ("rename this", "move that", "add a column").
3. The requested changes are applied to the prototype (same artifact URL, new version), the local
   copy is replaced, and this file is updated: the version number and the screen or copy that changed.
4. The human says "approved". From that moment the prototype plus the additions in this file are the
   visual contract for:
   - 03 (sign-in page, People modal, user menu),
   - 06 (batch list, wizard, batch page, downloads, product page, brand page),
   - 07 (Needs attention tab, decisions, replacement, Add SKU ids).
   Builders copy its layout, labels, states and messages. Deviations need a note in the PR body.

The prototype shows no model names and no technical configuration anywhere. That stays true in the
real UI.

## Global frame

- Top bar (navy): logo "Opptra" (links to the batch list); navigation; a pill "Prototype for approval"
  that does not exist in the real UI; the user button on the right.
- Navigation in the prototype: "Catalog images" (active), "Photo shoots", "Spend". Only "Catalog
  images" is built. The "Photo shoots" and "Spend" entries, and their two placeholder screens, belong
  to the earlier app and are not part of this repository. Cost is shown on the batch page ("Cost so
  far") and on the brand page; there is no Spend page.
- User button: "<email> · <Role> ▾" (prototype: "sujan@opptra.com · Admin ▾"). Clicking it opens a
  small menu. In the prototype the menu has one item, "People". The real UI has two: "People" (admins
  only) and "Sign out" (added here; not in version 2). The menu closes on any click outside it.
- Visual tokens: navy `#131A48`, orange `#FF5800` (hover `#FF8C4F`), pale yellow `#FFFCE8` for
  notices and the share box, grey `#5A5A5A` for muted text, light grey `#CECECE` for borders and
  disabled outlines. `#CECECE` is a UI token only; the image background colour is always the channel's
  `#E0E0E0` (defined in 02). Status colours: ok green, warn amber, bad red, run blue (pill variants
  `ok`, `warn`, `run`, `bad`).
- Type: headings in Spectral (h1 light 30 px, h2 22 px, h3 17 px), body in Raleway 15 px.
- Light and dark themes; dark follows the system preference and can be forced with `data-theme`.
- One centred column, maximum width 1080 px, 16 px side gutters; cards only where an object needs
  separating; tables scroll sideways on narrow screens.
- Toasts: navy, bottom-centre, about 2.6 seconds, one sentence.
- Primary buttons are orange; secondary ("ghost") buttons are outlined; disabled buttons are faded and
  not clickable.

## Roles in the prototype

- The prototype is Admin by default. The People modal has a switch "Preview as viewer" that adds the
  class `viewer` to the body, which hides every element marked `.adm` and shows every `.vo` element
  (the plain-text role next to each People row). The user button then reads
  "sujan@opptra.com · Viewer (preview) ▾".
- Hidden for a viewer (`.adm`): the "New batch" button on the list; the three action buttons on every
  attention card ("Use as is", "Remove this photo", "Replace photo N"); the "Start again" button on a
  batch that could not start; the role selects in the People modal (replaced by plain text); the
  add-person row and the "Add person" button.
- Still visible for a viewer: the batch list and every batch page, all four tabs, the Links sheet
  preview, "Download links sheet (Excel)" and "Download CSV", the Details tab, the People modal in
  read-only form, the "Preview as viewer" switch itself.
- Real UI, per the permission matrix in CONTRACTS section 3: a viewer sees everything a reader needs
  (list, batch page, sheet preview, attention tab without buttons, product and brand pages,
  downloads) and no action controls; a viewer who reaches `/catalog/new` is redirected to `/catalog`.
  An operator sees everything except the People management controls (role selects, add person,
  remove person) and the "People" menu item. An admin sees everything. "Preview as viewer" is offered
  to every role (a no-op for a viewer). Role changes apply on the next request, with no re-login.

## Screens and states (transcribed from version 2)

### 1. Batch list (`#list`, route `/catalog`)

- Heading "Catalog images". Lead: "Turn a brand's product photos into marketplace-ready images and get
  a sheet of links. One brand per batch." Button "New batch" (primary, `.adm`) opens step 1.
- Table columns: Brand, Batch, Channels, Products, State, Created. The Brand cell shows the brand in
  bold plus a neutral pill "Softline" or "Hardline". Rows are clickable and open the batch page.
- Five sample rows (exact pills):

  | Brand | Batch | Channels | Products | State pill | Created |
  |---|---|---|---|---|---|
  | USPA (Softline) | USPA kids sneakers, Oct lot | Noon, Namshi, Trendyol, Styli | 412 | warn "Needs attention (3 products)" | Today 11:40 |
  | French Connection (Softline) | FC AW26 apparel | Noon, Namshi, Amazon | 607 | run "Processing 1,240 of 4,800" | Today 10:05 |
  | Anta (Softline) | Anta footwear and apparel | Noon, Namshi, Trendyol, Amazon | 126 | ok "Ready to download" | Yesterday |
  | Bergner (Hardline) | Cookware relist | Amazon, Noon | - | run "Collecting files 48 of 310" | Yesterday |
  | Campus (Softline) | Campus test lot | Noon | 0 | bad "Could not start" | 14 Oct |

  The "Today 11:40", "Yesterday", "14 Oct" strings are sample data; the real column shows a relative
  time for the current day and a short date otherwise. A batch with no product count yet shows "-".
- Footer in version 2: "Every batch keeps its links forever. Re-running a product makes a new batch;
  old links stay live." The real UI replaces this with the CONTRACTS section 12 footer, because the
  product-identity decision made the version 2 sentence untrue: "A product's links stay the same for
  life. Uploading a product again replaces the pictures behind its links. Marketplaces keep their own
  copy, so re-submit changed products there."

### 2. Wizard step 1 "Brand and files" (`#new1`, route `/catalog/new`)

Heading "New batch". Step indicator with four steps: "Brand and files" (on), "Check what we found",
"Where will these images go?", "Start". Completed steps show a navy tick; the current step is an
orange circle with its number.

Left card:
- "Which brand?" select, placeholder option "Choose a brand", two groups. Softline: USPA, French
  Connection, Campus, Penti, Vero Moda, Keds, Cardio Bunny, Puma, Nautica, Anta, BHPC, ONLY. Hardline:
  Bergner, Carote, Nutricook, NutriBullet, GTPlayer, Tower, Dowinx, Qubo, Nuwey, Samsco. In the real
  UI the groups and names come from `brand_master` (defined in 02).
- Help: "Brand not in the list? Email sujan@opptra.com." (the address is a mailto link). There is no
  add-brand form.
- "Batch name (optional)" text input, placeholder "USPA kids sneakers, Oct lot". When a brand is
  chosen the placeholder becomes "<brand> batch, <day> <short month>" (for example "Anta batch,
  17 Oct"). An empty field means the placeholder text becomes the batch name.
- "What kind of products?" select: "Detect automatically (recommended)", "Footwear", "Apparel on a
  model", "Apparel laid flat", "Bags and accessories", "Other". Help: "A folder can mix footwear,
  apparel and accessories; we detect each product separately." Maps to `catalog_batches.product_type`
  (`auto | footwear | apparel_model | apparel_flat | bag_accessory | other`, defined in 02); `auto`
  detects per product, a forced value applies to every product in the batch.

Right card:
- Label "What do you have?". Drop zone (dashed, hover turns the border orange): bold "Drop images,
  folders, zips or a links sheet here" then "Or click to choose. Photos should be named like
  `ABC123_1.jpg, ABC123_2.jpg` so we know which shots belong together."
- File list under the drop zone, one row per file: name in bold, a neutral kind pill, the size on the
  right, a full-width orange progress bar. When the bar reaches 100% the size text becomes
  "Uploaded", or for an unreadable file "iPhone format. Export as JPEG and use it in a new batch."
  Sample files, in the order the prototype adds them on each click: `uspa_kids_sneakers_oct.zip`
  412 MB (pill "zip"), `Styli - Kids 1 Option Sneaker.xlsx` 38 KB (pill "product list"),
  `IMG_2041.heic` 2.1 MB (pill "cannot read"). That third row is version 2 text only: the product
  owner decided that HEIC is supported, so in the real UI a HEIC file uploads like any other photo
  and is converted automatically (defined in 05). The pill "cannot read" is kept for BMP files and
  corrupt files, with the size text replaced by the reason ("<name> is a BMP file. Save it as JPEG or
  PNG and add it again." or "The file is corrupt and could not be decoded."). Real kinds come from
  `UPLOAD_KINDS` (02); the pill shows a plain word (zip, images, links sheet, product list, Google
  Sheet, Drive folder, cannot read).
- "Or paste a link" textarea, placeholder "A Google Sheet link, a Google Drive folder link, or image
  links one per line".
- Share box (pale yellow), shown only while the pasted text contains at least one Google Sheets or
  Google Drive link, hidden again when it does not: "Share it with" followed by the address in
  monospace and a small "Copy" button, then on its own line "Viewer is enough; we only read. We never
  change your files." "Copy" puts the address on the clipboard and reads "Copied" for 1.5 seconds. The
  prototype shows `ila-web@image-links-agent.iam.gserviceaccount.com`; the real UI shows
  `SHARE_SA_EMAIL`, which is `catalog-web@image-links-agent.iam.gserviceaccount.com` (CONTRACTS
  section 2). 01 records this swap so nobody copies the old address.
- Help under the paste box, which is replaced live as the operator types:
  - Empty: "We check access as soon as you paste."
  - A Google Sheet link with access: pill ok "Access confirmed" then `Google Sheet "Styli - Kids 1
    Option Sneaker", 5 rows, 6 image columns found.` (title and counts are live data).
  - A Drive folder link without access: pill warn "No access yet" then "Share the folder with the
    address above, then paste again."
  - Anything else (image links): pill ok "<n> image links" then "We will download them when you start.
    No sharing needed." (n = number of non-empty lines).
- Button row: "Continue" (primary, right-aligned). In the real UI "Continue" is disabled until a brand
  is chosen and at least one file or link is present.

### 3. Wizard step 2 "Check what we found" (`#new2`)

Lead: "We have looked at what you gave us. The usual answers are already selected; press Continue if
they look right." Five cards, two of them conditional, then "Back" and "Continue".

Card "How should we tell products apart?" (always shown), three radio options:
- "By file name before the last _number" (checked) with the small text "Recommended: ABC123_1.jpg,
  ABC123_2.jpg. This is what we detected."
- "By folder name" with "One folder per product."
- "By the identifier column in your sheet" (no small text).
Under the first option, three example rows whose label changes with the selected mode, each followed
by the product's thumbnails (one per photo, titled "photo 1", "photo 2", ...), then the note
"3 of 412 products, so you can check the grouping.":

| Mode | Row 1 | Row 2 | Row 3 |
|---|---|---|---|
| By file name | `6W_COSTER_JR_OD_WHITE` "from 6W_COSTER_JR_OD_WHITE_1.jpg … _5.jpg" | `6W_COSTER_JR_OD_BLACK` "from 6W_COSTER_JR_OD_BLACK_1.jpg … _3.jpg" | `6W_ACHILLE_MEN_OD_BLACK` "from 6W_ACHILLE_MEN_OD_BLACK_1.jpg … _3.jpg" |
| By folder name | `COSTER JR WHITE/` "5 files in the folder" | `COSTER JR BLACK/` "3 files in the folder" | `ACHILLE MEN BLACK/` "3 files in the folder" |
| By the identifier column | `6W_COSTER_JR_OD_WHITE` "column B, 5 photo links" | `6W_COSTER_JR_OD_BLACK` "column B, 3 photo links" | `6W_ACHILLE_MEN_OD_BLACK` "column B, 3 photo links" |

Maps to `options.identifierMode` (`filename | folder | sheet_column`, default `filename`, defined in
02). The real UI shows the three rows from the batch's own detected data.

Card "You gave us a folder and a sheet of links. Which wins when both have the same product?"
(conditional; note under the heading: "Shown because you added both."). Radios: "Use the uploaded
photos, fill gaps from the links" (checked, small text "Recommended."), "Use the links only", "Use the
uploaded photos only". Maps to `options.precedence` (`uploads_then_links | links_only |
uploads_only`, 02).

Card "Photo formats" (always shown): one summary line, sample "1,612 JPG, 34 PNG (transparent
backgrounds kept), 2 HEIC (iPhone format, cannot be read: export as JPEG)." then the help "No action
needed." The HEIC part is version 2 text; the real line reads "<n> HEIC (iPhone format, converted
automatically)" because HEIC is supported (05). BMP and corrupt files are counted as "<n> could not be
read" and named in the step 4 warning.

Card "Sheet columns" (conditional; note: "Shown because you added a sheet."): "We will use column B
(Vendor Style Number) as the identifier and columns H to M (Product Image 1 to 6) as photos." followed
by a text button "Change". "Change" hides itself and reveals two selects: "Identifier column" (sample
options "B · Vendor Style Number", "A · Barcode", "C · Product Name", "D · Colour") and "Photo
columns" (sample "H to M · Product Image 1 to 6", "H to K · Product Image 1 to 4", "N to S · Lifestyle
Image 1 to 6"). Maps to `options.sheetColumns` (02). Changing any card re-runs detection
(`POST .../ingest` again, CONTRACTS section 4) before step 4 is shown.

Card "Google access" (always shown in the prototype; in the real UI shown only when a Google link
was pasted): "For Google Sheets and Drive folders, share them with <address> as Viewer. Viewer is
enough; we only read. We never change your files." then one row per pasted Google link: a pill, the
link in monospace, a small kind label "Google Sheet" or "Drive folder". Sheet rows show pill ok
"Access confirmed". Drive rows without access show pill warn "No access yet" and a small button "Check
again", which re-runs the access check; on success the row flips to "Access confirmed" and the button
disappears. When nothing Google was pasted the prototype shows two example rows
(`https://docs.google.com/spreadsheets/d/1aB…/edit` and `https://drive.google.com/drive/folders/1xY…`)
each marked "(example, nothing pasted in step 1)"; the real UI shows nothing in that case. The address
is `SHARE_SA_EMAIL` as in step 1.

Buttons: "Back" (ghost) to step 1, "Continue" (primary) to step 3.

### 4. Wizard step 3 "Where will these images go?" (`#new3`)

Lead: "Tick every marketplace you want images for. Each one is made to that marketplace's own rules.
Nothing is pre-selected."

Group heading "Usually listed first" with the small text "Namshi, Noon, Trendyol, Amazon"; group
heading "Also available" with "Styli, 6thStreet, Centrepoint, VogaCloset, Shein". These are the P1
and P2 groups of CONTRACTS section 7, information only; nothing is pre-ticked and nothing is stored
between batches.

Nine channel cards (checkbox, bold name, one-line rule), in this order; a ticked card gets an orange
outline:

| Group | Card | Rule text |
|---|---|---|
| P1 | Namshi | 1080 × 1480, light grey background, 10% space above and below |
| P1 | Noon | 1080 × 1480, light grey background, 10% space above and below, 5% at the sides |
| P1 | Trendyol | 1200 × 1800, light grey background, no spaces in file names |
| P1 | Amazon | 2000 × 2000. First image on pure white, the rest light grey |
| P2 | Styli | 2342 × 3123, light grey, product at the bottom centre inside Styli's guides, same placement on every angle |
| P2 | 6thStreet | 2000 × 2667, light grey background |
| P2 | Centrepoint | 3000 × 3000 square, light grey background. Nothing is cropped; space is added at the sides |
| P2 | VogaCloset | 2000 × 2667, light grey background |
| P2 | Shein | 2000 × 2000. First image on pure white, the rest light grey |

Buttons: "Back", "Continue". "Continue" is disabled until at least one card is ticked. Ticking also
updates the "marketplaces" and "images will be made" KPIs on step 4. There is no advanced section and
no separator or low-resolution option (version 1 had an "Advanced" section; it is gone, see the end
of this file).

### 5. Wizard step 4 "Start" (`#new4`)

Four KPI tiles: "412 products found", "1,648 photos", "4 marketplaces" (orange; the number of ticked
channels), "6,592 images will be made" (orange; photos × marketplaces).

Warning list (pale yellow rows with a "!" badge; each row is one bold sentence plus one plain
sentence with the action):
- "3 products have no photos." They are in your product list but no files matched:
  6W_COSTER_JR_OD_NAVY, 6W_COSTER_JR_OD_RED, 6W_ACHILLE_MEN_OD_BLUE. They will appear in the sheet as
  "missing images".
- "2 files could not be read." IMG_2041.heic and IMG_2042.heic are an iPhone format. Export them as
  JPEG and use them in a new batch, or continue without them. This is version 2 text; HEIC files are
  converted automatically in the real UI and never appear here. The real warning reads "<k> files
  could not be read." followed by "<names>: <reason>. Fix them and use them in a new batch, or continue
  without them." (reasons: "is a BMP file", "is corrupt and could not be decoded").
- "5 photos are smaller than Styli needs" (under 1200 px). Styli will skip them and note it in the
  sheet, as agreed with Styli. The "1200" is sample data; the real sentence fills its number from
  `STYLI_MIN_SOURCE_HEIGHT_PX` (defined in 02). The warning is shown only when Styli is ticked.
There is no warning about missing Opptra SKU ids and no SKU id KPI.

Heading "How we grouped your photos". Table columns: Identifier, Opptra SKU ids, Photos, First photo
(thumbnail or "-"), Status (pill ok or warn). Six sample rows:

| Identifier | Opptra SKU ids | Photos | First photo | Status |
|---|---|---|---|---|
| 6W_COSTER_JR_OD_WHITE | …_31; …_32; …_33; …_34; …_35 | 5 | thumbnail | ok |
| 6W_COSTER_JR_OD_BLACK | …_31; …_32; …_33 | 4 | thumbnail | ok |
| 6W_ACHILLE_MEN_OD_BLACK | …_40; …_41; …_42 | 3 | thumbnail | ok |
| 6W_ACHILLE_MEN_OD_WHITE | (empty) | 3 | thumbnail | ok |
| 6W_COSTER_JR_OD_NAVY | …_31; …_32 | 0 | - | missing images (warn) |
| FC_749F9_SUMWHT | (empty) | 4 | thumbnail | ok |

Help: `Showing 6 of 412. If a grouping looks wrong, go back to "Check what we found" and change how
we tell products apart.`

Button row: "Back" on the left; on the right the note "Once you start, you cannot add more photos to
this batch. Make a new batch for anything else." and the primary button "Start processing". Starting
shows the toast "Batch started. We will show progress here." and opens the batch page in the
Processing state. The overwrite preview block added by the product-identity decision sits between the
warning list and the grouping table (see "Additions" below).

### 6. Batch page (route `/catalog/[id]`)

Header: small link "← All batches"; the batch name as h1; a sub-line "<brand> · <channels> · started
<when> by <email>" (the static markup shows "USPA · Noon, Namshi, Trendyol, Styli · started today
11:40 by sujan@opptra.com"; the per-state data drops the "by <email>" part, and a finished batch says
"finished <when>"). The real UI always shows "by <email>" (`created_by`). Action buttons sit on the
right of the header and depend on the state.

Below the header: a banner (soft grey box), a row of four KPI tiles, then the tabs. The third KPI tile
turns amber whenever its value is not "0" and not "-".

The five visible states, exactly as in the prototype's `STATES` data:

| Key | Title and sub-line | Banner | KPI tiles | Actions | "What happens next" sentence |
|---|---|---|---|---|---|
| `running` | "FC AW26 apparel" · "French Connection · Noon, Namshi, Amazon · started today 10:05" | pill run "Processing", navy progress bar (26%), "1,240 of 4,800 images made · about 55 minutes left" | 607 products · 1,240 images made · 0 need attention · 0 could not be made | none | "You can close this page; nothing stops." |
| `collect` | "Cookware relist" · "Bergner · Amazon, Noon · started yesterday" | pill run "Collecting files", navy bar (15%), "48 of 310 files copied from your Drive folder" | - products · 48 files collected · - need attention · - could not be made | none | "We copy your files first so the batch does not depend on the Drive folder later. Processing starts automatically." |
| `done` | "USPA kids sneakers, Oct lot" · "USPA · Noon, Namshi, Trendyol, Styli · started today 11:40" | pill warn "3 products need your attention", "Everything else is done and in the sheet. Decide now or download the sheet as it is; each decision updates the sheet." | 412 products · 6,569 images made and verified · 3 products need attention (amber) · 1 could not be made | "Download links sheet (Excel)" (primary), "Download CSV" (ghost) | `Open "Needs attention" for the 3 products with a problem.` |
| `ready` | "Anta footwear and apparel" · "Anta · Noon, Namshi, Trendyol, Amazon · finished yesterday" | pill ok "Ready", "All 2,016 images are live and passed every check. Nothing needs your attention." | 126 products · 2,016 images made and verified · 0 need attention · 0 could not be made | "Download links sheet (Excel)", "Download CSV" | "Download the sheet and paste the links into the marketplace templates." |
| `failed` | "Campus test lot" · "Campus · Noon · 14 Oct" | pill bad "Could not start", "No photos were found in what you uploaded. The zip only contained a folder of PDFs. Upload photos and start again." | 0 products · 0 images made · 0 need attention · 0 could not be made | "Start again" (primary, `.adm`; opens step 1) | "Nothing was processed and nothing was charged." |

The "about 55 minutes left" estimate is live data (remaining images at the batch's observed rate);
the real UI omits it until at least one chunk has finished. The Processing banner's number is images
made of images planned; the Collecting banner's number is files collected of `collectTotal`.

Tabs: "Overview" (default), "Needs attention (N products)" (hidden unless N > 0; the prototype shows
it only in the `done` state; N is `counts.attentionProducts`, 02), "Links sheet", "Details".

Overview tab, two cards:
- "How this works": "We check every image against the marketplace rules and our quality check. Images
  that pass go straight into the links sheet. Only products with a problem are listed under Needs
  attention." followed by the state's "What happens next" sentence.
- "Cost so far": "INR 3.80 per style so far · agency reference INR 60 per style" (the first figure is
  large Spectral type and is live data, `cost.inrPerIdentifier`; INR 60 is the plan's benchmark).

Links sheet tab: lead "One row per product. Each marketplace has its own set of links. Open the Excel
file to get clickable links; this is a preview." A table with a two-row header: `brand`,
`identifier`, `opptra_sku_ids`, then a merged header per channel ("Noon", "Styli") over "Image 1",
"Image 2", "Image 3", then `status`, `notes`. Four sample rows:

| brand | identifier | opptra_sku_ids | Noon 1..3 | Styli 1..3 | status | notes |
|---|---|---|---|---|---|---|
| USPA | 6W_COSTER_JR_OD_WHITE | …WHITE_31; …WHITE_32; …WHITE_33 | …/noon/6W_COSTER_JR_OD_WHITE_1.jpg, …_2.jpg, …_3.jpg | …/styli/6W_COSTER_JR_OD_WHITE_1.jpg, …_2.jpg, …_3.jpg | needs_attention | photo 4: too small for Styli; photo 5: could not be read |
| USPA | 6W_ACHILLE_MEN_OD_BLACK | …BLACK_40; …BLACK_41; …BLACK_42 | …_1.jpg, (empty), …_3.jpg | …_1.jpg, (empty), …_3.jpg | needs_attention | photo 2: hand may be cut at the edge |
| USPA | 6W_ACHILLE_MEN_OD_WHITE | (empty) | …_1.jpg, …_2.jpg, …_3.jpg | …_1.jpg, …_2.jpg, …_3.jpg | ok | (empty) |
| USPA | 6W_COSTER_JR_OD_NAVY | (empty) | (empty) | (empty) | missing_images | no photos matched |

Below the table: "Download links sheet (Excel)" (primary), "Download CSV" (ghost), then the help
"Opptra SKU ids are filled in automatically when they exist." The real sheet and the real preview add
`option_id_style_color` between `identifier` and `opptra_sku_ids`, show every ticked channel in the
order ticked, and add the tail columns `change` and `changed_at` after `notes` (CONTRACTS section 11).
A product still waiting for a decision shows its previous live links, if any, with status
`needs_attention`. The real UI also adds an operator-only button "Add SKU ids" here (see "Additions").

Details tab: card "For the technical team" with one monospace line: `batch 7f3a…c21 · raw files:
gs://image-links-agent-assets/catalog/uspa/7f3a…/raw/ · public links:
https://storage.googleapis.com/image-links-agent-public/catalog/uspa/7f3a…/<channel>/ · report.json`.
Correction for the real UI: public links carry no batch id. The real line reads
`public links: https://storage.googleapis.com/image-links-agent-public/catalog/<brand>/<pathKey>/<channel>/`
(CONTRACTS section 8); the raw path keeps the batch id because the private bucket is batch-scoped.
Error block (red left border): bold "1 image could not be made." then "6W_COSTER_JR_OD_WHITE_5.jpg for
Trendyol: the file is corrupt (cannot be decoded). Replace it from the Needs attention tab." The real
block lists every failed output the same way, one per line, pluralised "<n> images could not be made."

### 7. Needs attention tab

Lead: "Everything else is done and in the sheet. Only the products below have a problem, and only the
photos with a problem are shown. Your decision is applied to the links sheet straight away."

One product card per product with a problem. Card header: identifier in monospace (left), "<k> of
<total> photos need a decision" (right, muted). Under it the problem line in muted text. Then one
image row per photo with a problem: the original (caption "Photo <n> of <total>, original"), the made
image (caption "Photo <n> of <total>, made for <channel>"; when nothing could be made, a grey
placeholder reading "Could not be made" instead of the image), then a bold "why" sentence, a plain
"what to do" paragraph, and three buttons (`.adm`): "Use as is" (green), "Remove this photo" (ghost),
"Replace photo <n>" (ghost).

The three sample items (`ATT` data):

| Identifier | Header right | Problem line | Photo and channel | Why (bold) | What to do |
|---|---|---|---|---|---|
| 6W_ACHILLE_MEN_OD_BLACK | 1 of 5 photos need a decision | Photo 2: the model's hand looks cut at the frame edge. | 2, Noon | The hand looks cut at the frame edge in the original photo. | We never crop, so the made image shows the same thing. "Use as is" keeps it; "Replace" swaps the photo for all four marketplaces. |
| 6W_COSTER_JR_OD_WHITE | 2 of 5 photos need a decision | Photo 4 is too small for Styli; photo 5 could not be read. | 4, Styli | The original is 800 × 800. Styli wants at least 1200 px, so this one may look soft. | It will upload, but ask the brand for a larger photo if you can. The other marketplaces are fine with it. |
| (same card) | | | 5, Trendyol (Could not be made) | The file is corrupt and could not be decoded. | Nothing was made for any marketplace from this photo. Remove it or replace it. |
| 6W_COSTER_JR_OD_BLACK | 1 of 4 photos need a decision | Photo 3 looks like a different product from the others. | 3, Noon | This photo does not match photo 1 of the same identifier. | If the file was named wrongly, remove it; the rest of the product is unaffected. |

"1200 px" in the second item is sample data; the real sentence uses `STYLI_MIN_SOURCE_HEIGHT_PX`
(02). "all four marketplaces" is filled from the batch's channel count.

Behaviour:
- "Use as is": the row fades (opacity 0.55), its buttons disable, toast "Kept in the sheet".
- "Remove this photo": same fade, toast "Removed. The sheet cell is empty with a note."
- "Replace photo <n>": opens the Replace modal (section 8). After "Upload" the row is decided with the
  toast "Replacement queued. Usually done in a minute."
- A decided row cannot be decided again. When every row of a card is decided the card collapses to a
  one-line resolved card: pill ok "Resolved", the identifier in monospace, "Sheet updated." The tab
  label counts down: "Needs attention (N products)" or "Needs attention (1 product)". In the real UI
  the tab disappears when N reaches 0 and the banner changes to the Ready text.
- Decisions map to `POST /api/catalog/outputs/[id]/decision` with `use_as_is` or `remove`
  (CONTRACTS section 4); the replacement uses `.../replacement` and `.../replacement/complete`.

### 8. Replace modal

Dimmed navy overlay, one card (max 560 px). Heading "Replace photo <n> of <identifier>" (sample
"Replace photo 2 of 6W_ACHILLE_MEN_OD_BLACK"). Help: "Drop the new photo. We will make it for Noon,
Namshi, Trendyol and Styli again and update the sheet. Nothing else changes." (the channel list is
the batch's channels, joined with commas and "and"). Drop zone: bold "Drop one photo" with the target
file name under it (sample "6W_ACHILLE_MEN_OD_BLACK_2.jpg"). Buttons right-aligned: "Cancel" (ghost,
closes), "Upload" (primary, closes and decides the row as in section 7).

### 9. People modal

Opened from the user menu. Heading "People". Help: "Anyone with an @opptra.com Google account can sign
in and view. Admins decide who can create batches and resolve attention items."

Rows (email left, role right; the role is a select for admins and plain text for everyone else):
- sujan@opptra.com (you) · Admin
- catalog.ops@opptra.com · Operator
- brand.team@opptra.com · Operator
- leadership@opptra.com · Viewer
Role select options: Admin, Operator, Viewer. Changing a select saves at once in the real UI
(`PATCH /api/people/[email]`). The real UI adds a small "Remove" text button per row (admins only,
not for your own row); removing deletes the `users` row, and the person is a viewer again on their
next sign-in (CONTRACTS section 3).

Add row (`.adm`): text input with placeholder "name@opptra.com", a role select (Viewer, Operator,
Admin; Viewer first), then a small ghost button "Add person". Adding inserts the new row above the add
row, clears the input and shows the toast "<email> added as <Role>." (sample
"name@opptra.com added as Operator."). The real UI rejects an address that does not end in
`@opptra.com` with the sentence "Use an @opptra.com address."

Switch (below a divider): checkbox "Preview as viewer" with the help "Hides New batch and the action
buttons, as a viewer sees them." Turning it on shows the toast "Previewing as a viewer. Action buttons
are hidden."; turning it off shows "Back to Admin." (the real UI says "Back to <Role>.").

Button: "Close" (ghost, right-aligned).

## Mapping of visible states to `catalog_batches.status` (defined in 02)

| Prototype state | `status` | Condition |
|---|---|---|
| (the wizard, not a batch-page state) | `draft` | until "Start processing" |
| Collecting files | `ingesting` | |
| Processing | `matting`, `rendering`, `qa`, `publishing` | |
| Needs attention | `done` | `counts.attentionProducts > 0` |
| Ready to download | `done` | `counts.attentionProducts = 0`, every planned link verified (`verified = outputs - skipped`) and the independent re-check clean (`recheckOk = recheckTotal`, defined in 06) |
| Could not start | `failed` | `counts.failReason` is shown in the banner |

A batch that has started always ends as `done` or `failed`; outputs that could not be made never
fail the batch as a whole, they are listed on the Details tab and in the sheet notes. The sweeper
(02) can also move a stuck batch to `failed`; its banner then reads "No progress for 2 hours. Start the batch again." with "Start again".

## Additions required by the product-identity decision and the audit (not in version 2)

These screens and sentences are specified here in words with their exact copy, so that no new
prototype round is needed unless the human asks for one. Builders treat them as part of the contract.

### Step 2: sheet controls

The "Sheet columns" card becomes real controls, one block per uploaded sheet (`detected.sheets`,
defined in 04). Each block reads "Sheet `<name>`: identifier column `<header>`, <m> image columns,
read as <links sheet | product list>" followed by the text button "Change". "Change" reveals three
controls: "Identifier column" (select of the sheet's headers), "Photo columns" (multi-select of the
sheet's headers; empty for a product list) and "Read as" (radio "Links sheet" / "Product list").
Saving re-runs grouping from the files already collected; nothing is downloaded again.

When detection cannot find the identifier column the block shows pill warn "cannot read" and the
sentence "Could not tell which column holds the identifier." with the controls already open;
"Continue" is disabled until a column is chosen. Detection never guesses.

### Step 4: announcement, cost and expanded grouping rows

- Announcement line directly above "How we grouped your photos", from `detected.groupedBy` (04), one
  of: "Grouped by file name (`<identifier>_<n>`)", "Grouped by folder name", "Grouped by the sheet
  column `<header>`", "Grouped by style and colour code (`<style>` + `<colour>`)", "Matched by style
  and colour code found inside the file names".
- Each grouping row expands on click to list its source files in shot order: "<n> · <original file
  name> · <width> × <height>" (data `PreviewRow.files`, 04). The row for a product with a numbering
  gap shows the note "Shot numbers <list> are missing in the upload; images shifted left in this row."
- Estimated cost line under the KPI tiles: "Estimated cost: about INR <x> (<n> images, <m> quality
  checks)". When `INR_PER_USD` is unset it reads "Estimated cost: not available".
- Additional warning sentences (same format as the existing ones, shown only when they apply):
  - "<k> products have photos but are not in your product list: <ids>. They will appear in the sheet
    as not in sheet."
  - "<k> products have two files for the same shot number: <ids>. They are left out until one file is
    renamed; see the grouping table."
  - "Your upload has <k> top-level folders (<names>). Everything in them will be filed under <brand>.
    If these are different brands, make one batch per brand."
  - "<k> identifiers appear more than once in `<sheet>`; the first row of each is used."
  - "<k> size rows matched <m> products."
- "Start processing" answers "Files changed since the preview. Open step 4 again." when a file
  finished uploading after the preview was computed. No question is ever asked after Start.

### Batch page: third download and verification counts

- When a product list workbook was uploaded, a third download button "Download filled product list"
  (ghost) follows "Download CSV" in the header actions and on the Links sheet tab. It serves the
  supplied workbook with the link columns appended (defined in 06).
- Details tab, two lines above the monospace line: "Links verified: <verified> of <planned>" and
  "Independent re-check: <ok> of <total> OK" (`counts.recheckOk`, `counts.recheckTotal`; "not run yet"
  while the batch is unfinished). The Ready banner appears only when both pairs are equal.

### Step 4: overwrite preview

A block headed "What this upload changes", placed between the warning list and "How we grouped your
photos". It reads the step 4 data (`newProducts`, `existingProducts`, `shotsToRemove`, busy products;
CONTRACTS section 6). Sentences, each on its own line:
- "<n> products are new." (always shown; "1 product is new." when n = 1)
- "<m> products already exist and will be overwritten: <list>." (shown when m > 0; the list shows up to
  ten identifiers then "and <k> more")
- Per overwritten product that loses photos, one line: "ABC123: 5 photos live, 3 in this upload;
  photos 4 and 5 will be removed from <channels>." (channels are the batch's ticked channels)
- Rename hint, when a new identifier's photos are byte-identical to an existing product's current
  photos: "NEW-ID has the same photos as ABC123. If this is a rename, add an alias on the product page
  instead of uploading." (a hint, not a block)
- Busy block, when any product is locked by an unfinished batch: "ABC123 and 4 others are still being
  processed in batch <name>. Wait for it to finish or remove them from this upload." This disables
  "Start processing".
- Duplicate spelling, when two identifiers in the upload normalise to the same product: "ABC-123 and
  ABC123 are the same product. Keep one." This also disables "Start processing".
There is no separate confirmation dialog; the operator reads this block and presses "Start
processing".

### Batch page: not refreshed line

Under the banner, when the batch did not select a channel on which some of its products have live
images: "Not refreshed in this batch: <channels> (last delivered in batch <name>)". Channels use
their display names; the batch name links to that batch. The same sentence is in the report (06).

### Needs attention: "Remove this photo" on a live photo

When the photo being removed already has a live public image (from an earlier batch), the what-to-do
paragraph ends with the extra sentence "This removes the live image for this photo on <channels>."
before the buttons. The toast stays "Removed. The sheet cell is empty with a note."

### Links sheet tab: Add SKU ids

Operator-only ghost button "Add SKU ids" after "Download CSV". Modal: heading "Add Opptra SKU ids";
help "Upload a sheet with two columns: identifier and opptra_sku_id. We fill the gaps and make a new
links sheet. Nothing is re-processed."; drop zone "Drop the mapping sheet (xlsx or csv)"; buttons
"Cancel", "Apply"; toast "<n> ids added. New links sheet ready." Maps to
`POST /api/catalog/batches/[id]/sku-map` (owned by 07).

### Product page `/catalog/products/[brand]/[key]`

Reached from the identifier in the grouping table, the sheet preview and the brand page.
- Header: identifier as h1; sub-line "<brand> · path <pathKey>"; small link "← <brand>" to the brand
  page.
- Section "Live images": one row per channel that has live outputs, channel display name on the left,
  then thumbnails "Image 1" to "Image N", each linking to its public URL. Channels with no live images
  are not listed. Empty state: "No live images yet."
- Section "Identity": "Identifier <identifier>", "Path <pathKey>", "Opptra SKU ids <ids joined by ;>"
  (or "none yet"), "Aliases <list>" (the product key is always the first).
- Section "History": events newest first, one line each: "<when> · <actor> · <sentence>". Sentences:
  "Created in batch <name>." / "Overwritten in batch <name> on <channels>." / "Photos <n, n> removed
  in batch <name>." / "<channels> added in batch <name>." / "Unchanged in batch <name>." / "Photos
  reordered in batch <name>." / "Opptra SKU ids added: <ids>." / "Alias added: <alias>." / "Photo <n>
  removed." / "Photo <n> replaced." / "Restored by the technical team." / "Product removed."
- Buttons: "Download links" (everyone; the product's live links as xlsx), "Add alias" (operator),
  "Remove product" (operator, ghost, red text).
- Add alias modal: heading "Add alias"; help "Another name this product is uploaded under. Uploads
  with this name land on this product; its links do not change."; text input placeholder "ABC-123";
  buttons "Cancel", "Add alias"; toast "Alias added." Error when the alias belongs to another product:
  "<alias> already belongs to <identifier>."
- Remove product modal (typed confirmation): heading "Remove <identifier>"; text "This deletes every
  live image of this product on every marketplace, and its links stop working. Marketplaces keep
  their own copy until you remove the listing there. The previous pictures are kept for 30 days as a
  safety net." then "Type the identifier to confirm." and a text input; "Remove product" (primary,
  red) is disabled until the typed text equals the identifier exactly; "Cancel". Toast
  "<identifier> removed." The page then shows the "Product removed." event and no live images.
- Cost line (viewer): "INR <x> spent on this product across <k> batches."

### Brand page `/catalog/brands/[slug]`

Reached from the brand name on the batch list and batch page.
- Header: brand name as h1 with the Softline or Hardline pill; sub-line "<n> products with live
  images · <m> batches".
- Search input, placeholder "Search by identifier or Opptra SKU id"; results table with a checkbox
  per row, columns Identifier, Opptra SKU ids, Live channels, Last batch. Clicking an identifier opens
  the product page. Empty result: "No products match."
- Header row controls: "Select all shown", "Clear".
- Button "Download links for selected products" (operator; disabled until one row is ticked); on
  click a brand sheet is generated and the browser downloads it (CONTRACTS section 11, brand sheet);
  toast "Links sheet ready."
- Cost card "Cost so far": "INR <x> per style across all batches · agency reference INR 60 per style".
- A list "Batches" of this brand's batches with the same columns and pills as the batch list.

### Sign-in page `/signin` (superseded by IAP, not built)

The prototype shows a centred card: logo "Opptra", heading "Catalog images", one button "Sign in
with Google", and after a Google account outside opptra.com is used, the sentence "Use your
@opptra.com Google account." above the button. Spec 03 puts Google's own IAP sign-in page in front
of the app instead, so this card is not built; the sentence survives as the app's 403 text for a
non-Opptra identity. See 03 "UI".

### 403 for viewers

Any action a viewer triggers (direct URL or stale page) answers with the sentence from CONTRACTS
section 3, shown as a red error block in place of the control: "You can view this but not change it.
Ask an admin for the operator role."

## Copy rules carried into the real UI

- Every error state is one sentence that names the thing and one sentence that names the action.
- Counts are formatted with thousands separators ("1,240 of 4,800").
- Channel names are shown as Namshi, Noon, Trendyol, Amazon, Styli, 6thStreet, Centrepoint,
  VogaCloset, Shein; channel ids stay lowercase in data and paths.
- Identifiers and paths are shown in monospace and never shortened, except in the prototype's sample
  cells where "…" stands for a long prefix.
- No model names, thresholds, queue names or GCS paths outside the "Details" tab.
- The operator reads "photos" for inputs and "images" for outputs; "marketplaces" for channels;
  "products" for style+colour identifiers; "Opptra SKU ids" for warehouse codes.

## Changes requested by the human

None yet for version 2. Append as "version N: <change>".

## Version 2 changes versus version 1

- Four wizard steps instead of three; the new second step is "Check what we found" (identifier mode,
  precedence, photo formats, sheet columns, Google access).
- No "Add a brand" form or modal; brands come from the master and requests go by email.
- No "Advanced" section; the separator and the Styli low-resolution options are gone (defined as
  constants in 02).
- Product type is detected per product ("A folder can mix footwear, apparel and accessories").
- The share box appears only when a Google link is pasted, with the "Viewer is enough" sentence.
- "Needs review" became "Needs attention", grouped by product; the actions "Looks fine", "Exclude from
  sheet" and "Upload a replacement" became "Use as is", "Remove this photo" and "Replace photo N".
- People modal with roles (Admin, Operator, Viewer) and "Preview as viewer".
- No "matched to Opptra SKU ids" KPI and no missing-SKU warning on step 4.
- No adding photos after start ("Once you start, you cannot add more photos to this batch.").
