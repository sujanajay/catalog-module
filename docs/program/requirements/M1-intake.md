# M1 Intake and auto-decide - requirements (2026-11-02)

Status: draft for Sujan's review. Planning only; no code changed. Follows `00-template.md`. Feature ids and
priorities come from `../module-map.md` section M1 and slices S2 and S3.

Words used here (defined once):
- **Batch**: one upload session that becomes one set of links (today a row in `catalog_batches`).
- **Wizard**: the "New batch" screens (`apps/web/components/catalog/CatalogWizard.tsx`, steps 1 to 4).
- **Held** (today): a product with `change = pending_attention`; its images wait for a person, even the good ones
  (spec 17 3.1.1, `isHeldSibling` in `pipeline/report.ts`).
- **Provisional link**: a working link given now to the best image we have, which may be improved later at the same
  URL.
- **Digest**: one summary for the whole batch (counts, reasons, an exceptions sheet), replacing per-product cards.
- **Exception**: a product or photo the system could not give a usable link for, listed in a sheet, never as a card
  that waits for a click.
- **Auto-decide**: the system picks what to deliver by written rules instead of asking a person.
- **Audit sample**: the permanent 2-5% random check by a person after links are out (M7), the only routine human
  look at outputs.

## 1. Purpose

- **Why:** today the operator babysits every batch: 82 of 200 products needed attention and 323 outputs were held in
  the speed test (batch 8628295f), one batch left 308 products to review, an xlsx upload crashed step 2 (batch
  574f2025, fixed in #101), 13 drafts were stranded in a week, and a 25,476-row sheet stalled twice (batch 7bdee361,
  fixed in #141 and #142). The goal is "upload and walk away".
- **Outcome metric:** real batches that reach "links ready" with zero operator actions after the upload, with links
  for 100% of products (baseline: 4 Continue or Start clicks plus channel ticks every batch; 82 of 200 products held).
- **Intents:** I008, I009, I014, I015, I017, I023, I029 (live-tool audit findings), I030, I031, I032, I033.

## 2. Scope

**In (first slice):** every input shape at once (several folders, several files, xlsx, csv, Google Sheet, Drive folder,
pasted links, Supabase folder links), automatic grouping per input, the sheet-sharing email shown first with a copy
button, a wizard that moves on by itself and starts the batch by itself, provisional links for every product, one
digest with an exceptions sheet, resumable drafts and safe re-runs.

**Out:** image making and checks (M3, M7), the audit sample itself (M7), channel rules (M5), cost (M6), the change log
(M0; M1 only writes through its contract).

**Later:** already-live products on request (P1), products from photos or a web page (P2), digest by email or Slack
(P1 inside F4), brand self-serve intake (M12).

## 3. Contracts

**Reads from M0:** `resolveOption` for each identifier (to find the option and listings), the brand's listing history
(which channels the brand's options are listed on, for the default channel set), `liveAt` for current versions per
slot (to know what a provisional link replaces), `isWritable` (frozen control listings are skipped with a reason).

**Writes to M0:** nothing directly. Its pipeline writes versions and `links_delivered` events through M0's contract;
M1 adds `reason_kind = auto_decide` and `reason_ref = <rule id>` for every provisional pick.

**Reads from M2:** the gap report per product x channel (missing roles, low resolution, no usable photo) to fill the
digest's reasons. Until M2 ships, M1 uses the flags the pipeline already sets (`OUTPUT_FLAGS` in `catalog/types.ts`).

**Reads from M3 and M7:** outputs with their flags and judge results (`catalog_outputs.qa_scores.autoAction`,
`holdCause`); the audit sample selection (M7 decides which links a person checks after delivery).

**Writes for M6:** batch timing and operator touches (every operator write after upload is counted; see M6-F3).

**API shapes (all under the existing `/api/catalog/batches/<id>` routes):**
- `POST /api/catalog/batches` gains optional `channels` and `autoStart` (default true). Existing callers are unchanged.
- `GET /api/catalog/batches/<id>/digest`: the digest JSON (section 4, F4). The xlsx and csv exports gain an
  "Exceptions" sheet.
- `POST /api/catalog/batches/<id>/extend`: adds inputs to a batch that already started by creating a linked follow-up
  batch (F5).
- `POST /api/catalog/batches/<id>/hold-start`: the operator's optional "wait, do not start yet" (F2).
- Worker task `catalog/improve` (new, on the existing chunk queue): re-tries a provisional slot later (F3).

**Contract needs from M0:** `resolveOption` by identifier, option id or SKU in one call for up to 2,000 identifiers;
the brand's channel set from listings; `isWritable` per listing in bulk; `recordChange` accepting `auto_decide`
reasons.

## 4. Features

### M1-F1 Any-shape upload (P0)

**User story.** As an operator with three folders from a brand, an xlsx of links and a Google Sheet, I want to drop
them all at once and have them grouped into products with no questions.

**What exists.** Drag and drop already walks several dropped folders (`Uploader.tsx` `walk`); "Choose a folder"
takes one folder per pick; the paste box takes Google Sheets, Drive folders and image links (`PasteBox.tsx`); sheets
are read by the worker; very large link sheets work since #141 and #142. Grouping is one mode per batch
(`filename`, `folder` or `sheet_column`), chosen in step 2.

**Functional requirements.**
- M1-F1-R1: The drop zone and the file picker accept any mix of files, folders and zips in one action, and further
  drops add to the same batch until it starts. "Choose folders" allows several folders in one pick where the browser
  supports it, and repeated picks add, never replace.
- M1-F1-R2: Grouping is decided per input root (each dropped folder, zip, sheet or link), not once per batch. For each
  root the detector picks `folder` when its sub-folders each hold 1-30 photos and no file name repeats a product
  stem across folders, else `filename` (stem before the last `_<n>`), else the sheet's identifier column. The chosen
  mode per root is shown as one sentence, not a question.
- M1-F1-R3: Products from different roots that resolve to the same option (through M0 `resolveOption` or the same
  identifier) are merged into one product; photos are de-duplicated by sha256 (existing same-photo logic).
- M1-F1-R4: Supabase folder links (the brand photo store) are a paste kind: a public or signed Supabase storage URL of
  a folder is listed and read like a Drive folder, read-only.
- M1-F1-R5: A sheet (xlsx, xlsm, csv, Google Sheet) never needs an answer: the identifier and image columns are
  detected; when two columns tie, the one whose values resolve most often through M0 wins. The step 2 "Change" control
  stays as an optional correction, never as a required step.
- M1-F1-R6: Unsupported files (PDF, video, under-1 KB placeholders) are skipped and counted in the digest; they never
  stop the batch.
- M1-F1-R7: Inputs up to 30,000 photos or 30,000 sheet rows per batch are accepted (the 25,476-row case is the
  reference); more than that is split into linked batches automatically (F5).

**Non-functional.** First photo visible in the input list within 3 s of the drop; collection at least 600 rows per
7 s for link sheets (measured on 7bdee361 after #141); grouping of 8,500 products finishes inside one Cloud Run request
limit or checkpoints (#142 behaviour kept). No cost per SKU beyond storage and worker seconds.

**Admin configuration.** Photos-per-folder range for folder detection; max inputs per batch before auto-split;
which paste kinds are enabled (Supabase on or off).

**Inputs and outputs.** In: files, folders, zips, sheets, links. Out: `catalog_uploads` rows, grouped products and
source photos, a per-root grouping sentence.

**Human in the loop.** None required. The operator may change a root's grouping before the batch starts (optional).

**Edge cases and failure modes.**
- Two roots name the same product differently (folder `ABC123` and file `abc-123_1.jpg`): merged through
  `normalizeKey` and M0 resolution; if they still differ they stay separate and the digest lists "possible duplicate
  products" (no question).
- A folder of mixed products named by file: per-root detection picks `filename` for it.
- A dropped folder the browser cannot read: "This folder could not be read. Drop it again." (existing copy), other
  inputs continue.
- One link used by many rows (7bdee361): read once (#141).
- A sheet whose identifiers resolve to two brands: the batch keeps the chosen brand; rows of the other brand go to the
  exceptions sheet with "belongs to <brand>".

**Buy or build.** Keep and build. Bulk import is table stakes; our grouping rules and M0 resolution are specific to our
data. No vendor.

**Acceptance tests.**
1. Drop three real brand folders (one folder-per-product, one flat `ABC123_1.jpg` style, one with sub-folders) plus one
   xlsx of image links in one drag. The batch reaches processing with every product grouped as a person would group
   it (checked against a hand count of 50 products), no question asked, no Next clicked.
2. Paste a Supabase folder link and a Google Sheet together; both are read; the sheet's columns are detected without
   opening step 2.

**Open questions.**
- Q: Allow mixing brands in one batch? Default: no; rows of another brand become exceptions (keeps links and costs per
  brand clean).

### M1-F2 Self-advancing wizard (P0)

**User story.** As an operator, after I give the files I want the batch to go by itself: no Next, no confirm, no
waiting on a step.

**What exists.** Four steps, each with Continue, then Start (`CatalogWizard.tsx`); step 3 has "Nothing is
pre-selected"; the Google sharing email appears only after a Google link is pasted (`PasteBox.tsx` shows `ShareBox`
when the text matches a Google URL) and again in step 2.

**Functional requirements.**
- M1-F2-R1: The screen shows, before any paste or drop, at the top of the input card: "To use a Google Sheet or Drive
  folder, share it with `<email>` as Viewer" with a Copy button (the existing `ShareBox`), always visible, not only
  after a Google link is pasted.
- M1-F2-R2: The wizard becomes one page with three parts that fill in as data arrives: inputs, "what we found", and
  "where it goes". There is no Continue button. The only required input is the files; the brand is required only when
  it cannot be inferred (R3).
- M1-F2-R3: Brand is inferred when at least 90% of resolved identifiers (through M0) belong to one brand; otherwise the
  brand list is the one question asked, shown above the drop zone.
- M1-F2-R4: Channels default, in order: the brand's channel setting (M12-F3-R8, once it exists), else the channels
  where the brand's options have listings in M0, else the five slice channels (Namshi, Noon, Trendyol, Styli,
  Centrepoint). Never the last batch someone else typed (UX 5.2: no surprises). The default is shown ticked and editable
  while collecting.
- M1-F2-R5: Product type stays "Detect automatically" (the existing default); the field is moved under "More options".
- M1-F2-R6: The batch starts by itself when collection and grouping are done and none of the start blockers in R7
  remain, after a visible 10-second countdown: "Starting in 10 s. Change anything above, or Wait." "Wait" calls
  `hold-start` and shows a Start button; that is the only button.
- M1-F2-R7: Today's start blockers become rules, not questions:
  - products locked by another running batch (`preview.busy`): start without them; they join a linked follow-up batch
    that starts when the lock frees (F5);
  - same-product pairs in the overwrite preview (`sameProductPairs`): keep the newest photos by upload time, list the
    pair in the digest;
  - another batch processing (`otherBatchProcessing`): start anyway (queues handle it);
  - links that failed to download: start with what was read, retry the failed links in the background (existing
    retry), list leftovers as exceptions.
- M1-F2-R8: Every state change shows within 2.5 s (the existing poll) without a page reload, and the operator can close
  the tab at any point: "You can close this page. We will keep going." (existing `LEAVING_LINE`).
- M1-F2-R9: Batches created by API or the load driver keep their current explicit Start (no auto-start unless
  `autoStart` is true).

**Non-functional.** Clicks from page open to "processing started": 0 when brand is inferred, 1 (brand) otherwise.
Time from last file uploaded to processing start: collection time plus 10 s.

**Admin configuration.** Countdown length (0-60 s, default 10); brand inference threshold (default 90%); default
channel order; whether auto-start is on (default on).

**Inputs and outputs.** In: the inputs from F1, M0 brand and channel history. Out: a started batch with channels and
options set.

**Human in the loop.** None required. The operator may change brand or channels before the countdown ends, or press
Wait. This replaces the four Continue clicks and Start.

**Edge cases and failure modes.**
- The operator drops more files during the countdown: the countdown restarts after the new files are collected.
- The operator changes channels after start: the change applies as a follow-up batch for the new channels (F5), never
  an error.
- Brand cannot be inferred and the operator walks away: the draft waits; it is listed under "Waiting for a brand" on
  the batches page and expires under the existing draft expiry (spec 14d F12).
- Inference picks the wrong brand: visible during the countdown; after start, cancel and re-run is safe (F5).

**Buy or build.** Build (UI work in the existing wizard).

**Acceptance tests.**
1. Open "New batch": the sharing email and Copy button are visible before anything is pasted; Copy puts the email on
   the clipboard.
2. Drop a Vero Moda folder (brand inferable from option ids): the batch starts with no click, with the channels where
   Vero Moda is listed ticked, and the batch page opens.
3. Drop a folder of unknown names: one question (brand) is asked; after choosing, no other click is needed.
4. During the countdown press Wait: the batch stays a draft with one Start button.

**Open questions.**
- Q: Countdown or immediate start? Default: 10 s countdown (a safety net that costs nothing); set to 0 after two weeks
  without a Wait press.

### M1-F3 Auto-decide with provisional links (P0)

**User story.** As an operator, I want every product to get links when the batch finishes, using the best image we
have now, with improvements arriving later on their own, so nothing is held back and I review nothing.

**What exists.** The automatic-resolution loop (`catalog/auto-resolve.ts`, spec 07 4.6a) re-makes our own defects.
Whatever it cannot fix is held: `qa/triage.ts` returns `hold` with a cause (`photo_one`, `not_publishable`,
`unusable`, `corrupt`, `code_fault`, `unchecked`), the product becomes `pending_attention`, its good outputs wait too,
and the operator decides per photo in `AttentionProductCard.tsx` (Use as is, Remove, Replace, Try again).

**Functional requirements.**
- M1-F3-R1: No output waits for a person. Each `hold` cause maps to an automatic action, held in a rule table
  (`catalog_auto_decide_rules`, admin-editable), with these defaults:

  | Hold cause today | Automatic action | Link given now |
  |---|---|---|
  | `not_publishable` (halo, leftover background, placement, a failed channel rule) after the repair loop | Deliver the best attempt that passes the channel's hard rules; else the cleaned photo on the channel canvas without the failing step (for example without shadow); flag `provisional` | yes |
  | `unusable` busy background | Deliver the brand photo resized to the channel canvas (pass-through render); flag `provisional` | yes |
  | `photo_one` (image 1 problem) | Promote the best-scoring other photo of the same product to image 1 when its role is front or packshot; else deliver image 1 provisional | yes |
  | `unchecked` (judge unavailable or capped) | Deliver; queue the judge check later; flag `provisional` | yes |
  | `code_fault` (encoder or transient) | Retry now (existing), then deliver the plain render; flag `provisional` | yes |
  | enlargement failed (spec 18) | Deliver the plain (not enlarged) render where the channel's hard minimum allows; else drop the slot | yes, or slot left empty with a reason |
  | `corrupt` source | Drop the photo; the rest of the set is delivered | no link for that photo |
  | judged `different_product` (wrong item) | Drop the photo (product truth); the rest is delivered | no link for that photo |

- M1-F3-R2: A product gets links for every channel where at least one photo is deliverable. A product with no
  deliverable photo at all is an exception (F4), not a held product.
- M1-F3-R3: Product truth (colour, logo, shape), modesty and likeness-rights checks stay with people (gate 1) but never
  as a queue: they run as M7's sampled audit after delivery, and as M7's blocking calls (P1) only for modesty, kids and
  likeness rights. Until M7 blocking calls ship, those three are not auto-detected and the audit sample covers them.
- M1-F3-R4: Each provisional slot gets an improvement task (`catalog/improve`) that re-tries the failed step later
  (for example the enlargement when the upscaler is back, the judge when it answers, a crop or generated shot from
  M3). If the improved image passes, it is published to the same public URL (the existing stable path per product,
  channel and position, with a new object generation), the `provisional` flag is cleared, and M0 records a new
  `links_delivered` event with reason `auto_decide`.
- M1-F3-R5: Improvement attempts are bounded (default 3 tries over 72 hours); after that the provisional image stays
  and is listed once in the next weekly digest, never re-raised.
- M1-F3-R6: The per-photo decision API (`/api/catalog/outputs/<id>/decision`) and Replace stay available as optional
  corrections from the exceptions sheet or the product page, never required, and every use counts as an operator
  touch (M6-F3).
- M1-F3-R7: `catalog_batch_products.change` never becomes `pending_attention` for a new batch; `releaseLocks` releases
  every product at finalize, so a provisional product never blocks the next batch.
- M1-F3-R8: Listings that M0 reports as frozen controls get no new content; the product's other listings proceed.

**Non-functional.** Time to links ready unchanged or faster (no wait on people). Cost per product: the fallback renders
are cheaper than a repair; the improvement task costs at most one extra attempt of the failed step per provisional
slot (budgeted in M6). Scale: 2,000 SKUs per batch.

**Admin configuration.** The rule table (cause to action), improvement tries and window, which causes may deliver
without a link (drop) per channel, the audit rate (M7).

**Inputs and outputs.** In: outputs with flags, judge results and hold causes. Out: delivered links for every
deliverable slot, `provisional` flags, improvement tasks, rule ids on each auto decision.

**Human in the loop.** Who: the catalog team, through the M7 audit sample (2-5%), after links are out. When: within
2 working days of the batch. How it goes away: a category goes automatic after clean audits and relapses on failure
(M7-F3); the sample rate never goes below 2%. Threshold changes in the rule table need an admin and are logged.

**Edge cases and failure modes.**
- The channel already ingested the provisional image when the improvement lands: the URL is the same, but channels
  copy images at upload, so the digest's "Improved since last upload" sheet lists products to re-upload (and M9 does it
  automatically later).
- An improvement fails the channel's hard rule where the provisional passed: the provisional stays.
- The judge is down for the whole batch: every output is delivered `unchecked`, the audit sample is doubled for that
  batch (rule in M7), the digest says so once.
- A Styli hard minimum (1,482 px) cannot be met by a plain render: the slot is left empty with a reason and the
  product's other slots are delivered.
- Operator explicitly removes a photo after delivery: honoured, counted as a touch.

**Buy or build.** Build. Nobody sells auto-decide; vendors ask for per-item acceptance (Amazon Enhance My Listing,
CommerceIQ, Botika).

**Acceptance tests.**
1. Re-run the 200-product speed-test input (batch 8628295f shape) on the preview stack: links for 100% of products with
   at least one deliverable photo, 0 products `pending_attention`, 0 outputs waiting, every provisional output carries
   a rule id.
2. Stop the GPU upscaler during a batch: the batch finishes with plain renders delivered as provisional; when the
   upscaler returns, improvements publish to the same URLs within the window and the flags clear.
3. A planted wrong-item photo is dropped and the other photos of that product get links.

**Open questions.**
- Q: Should a provisional image ever be withheld on Noon because of its "photographs only" stance? Default: no;
  provisional images are our renders of real photos, not generated.
- Q: Who re-uploads improved images to channels before M9? Default: the channel team from the weekly "Improved"
  sheet.

### M1-F4 One digest, not cards (P0)

**User story.** As an operator running 2,000 SKUs, I want one summary that says what happened, with counts, reasons
and one sheet of exceptions, so I never open product cards.

**What exists.** `buildReport` (`pipeline/report.ts`) already computes counts, held links, carried links, QA auto
actions, cost and a per-product report JSON; the batch page shows KPIs, a banner and the attention list
(`AttentionList.tsx`, `AttentionProductCard.tsx`).

**Functional requirements.**
- M1-F4-R1: Every finished batch has one digest, built in the finalize step from `buildReport`'s data plus M2's gap
  report, stored as `catalog_batches.digest` (jsonb, new column) and served by `GET .../digest`.
- M1-F4-R2: The digest holds: products in, products with links, links delivered per channel, provisional links by
  rule (top 5 reasons with counts), dropped photos by reason, exceptions count, skipped controls, time to first links,
  time to links ready, cost per product (from M6), and what is still improving.
- M1-F4-R3: Reasons are grouped and counted ("Noon image 4 missing: no back view in the brand photos - 312
  products"), never listed per product on the page. The page shows at most 10 reason lines; the rest are in the sheet.
- M1-F4-R4: The batch xlsx and csv get two new sheets: "Exceptions" (one row per product or photo with no link: id,
  channel, slot, reason, what would fix it) and "Provisional" (one row per provisional link with rule and expected
  improvement). The links sheet is unchanged, so channel teams' habits do not change.
- M1-F4-R5: The attention list and product cards are removed from the default batch view; old batches with held
  products keep their cards (no data migration of old decisions).
- M1-F4-R6: The digest page loads in under 2 s for a 2,000-SKU batch (reads `catalog_batches.digest`, not the outputs).
- M1-F4-R7: A weekly roll-up digest per brand lists improvements published, provisional images that stayed, and audit
  results (from M7), as one page.

**Non-functional.** Digest built in under 60 s for 25,000 products (the report already handles 25k products and 225k
outputs). Storage under 200 KB per digest.

**Admin configuration.** Number of reason lines shown; which sections appear; the weekly roll-up day.

**Inputs and outputs.** In: report data, gap report, cost line, audit status. Out: digest JSON, page section, two
sheets.

**Human in the loop.** None required. The exceptions sheet is information; fixing an exception (for example sending a
missing back view) is done by uploading the photo as a new batch, which re-runs only those products.

**Edge cases and failure modes.**
- A batch with zero exceptions: the sheet exists with a header and one line "No exceptions."
- Finalize retried (spec 18 H4 runs it once): the digest build is idempotent on the batch id.
- A batch cancelled part way: the digest covers what was delivered and says "cancelled at <time>".

**Buy or build.** Build. PIMs show approval queues; nobody gives a batch digest.

**Acceptance tests.**
1. A real 2,000-SKU batch finishes: the batch page shows one digest with counts and at most 10 reason lines, no product
   card, and the xlsx has Exceptions and Provisional sheets whose row counts equal the digest's numbers.
2. The digest page loads in under 2 s on the live site for that batch.

**Open questions.**
- Q: Send the digest by email? Default: P1, to the batch creator, once M12 settings exist.

### M1-F5 Resumable drafts and safe re-runs (P0)

**User story.** As an operator, I want any batch I left to carry on by itself or reopen where I was, and re-running
or adding to a batch never to duplicate anything.

**What exists.** `/catalog/new?batch=<id>` reopens a draft at the right step (spec 14a F4, #101), "Fix and continue"
reopens a failed intake (spec 14c F8), the sweep cancels drafts nobody wrote to after the expiry days (spec 14d F12),
grouping is resumable (#142), photos are matched by sha256 across batches (`same-photos.ts`), and "Once you start, you
cannot add more photos to this batch".

**Functional requirements.**
- M1-F5-R1: With auto-start (F2), a draft exists only while collecting or waiting for a brand. A draft whose inputs are
  collected and whose brand is known starts by itself, also when the tab was closed.
- M1-F5-R2: Adding inputs to a started batch creates a linked follow-up batch (`catalog_batches.parent_batch_id`, new
  nullable column) with the same brand and channels that starts by itself; the digest of the parent links to it.
- M1-F5-R3: Re-running a batch (same inputs again) re-uses every unchanged source and output by sha256 and render key;
  it creates no duplicate products, no duplicate outputs and no duplicate links, and the digest says "unchanged: N".
- M1-F5-R4: A batch stopped by a deploy, a quota error or a timeout resumes from its last checkpoint without operator
  action (M6-F2); an intake whose queue gave up (the 7bdee361 case) is re-sent by the sweep, not left "ingesting".
- M1-F5-R5: Orphaned drafts are counted daily (drafts older than 24 h with collected inputs and no start); the target is
  0, and any found is listed on the Ops page with its reason.
- M1-F5-R6: Splitting an oversized input (F1-R7) produces linked batches that each finish alone; one failing does not
  stop the others.

**Non-functional.** Resume within 5 minutes of the cause clearing (existing chunk lease recovery is minutes, spec 17
G4). Re-run of an unchanged 200-product batch costs under 5% of the first run.

**Admin configuration.** Draft expiry days (existing), follow-up batch auto-start on or off.

**Human in the loop.** None.

**Edge cases.** Two operators drop the same folder at once: product locks serialize them; the second becomes a
follow-up batch. A follow-up batch for products still locked waits for the lock, then starts.

**Buy or build.** Build (extends existing code).

**Acceptance tests.**
1. Drop a folder, close the tab before collection ends: the batch starts and finishes; the batches list never shows it
   as a draft after collection.
2. Re-upload the same folder the next day: the digest shows all products unchanged, no new outputs, no new public
   objects (generations unchanged).
3. Drop one more folder onto a running batch: a follow-up batch appears, linked, and starts by itself.

**Open questions.**
- Q: Should a re-run with changed channel rules re-render unchanged photos? Default: yes when M5 rule versions changed
  for that channel (render key includes the rule version); that is M9-F6 re-enrichment's job later.

### M1-F6 Already-live products on request (P1)

**Story.** As a catalog lead, I want to re-process any live product or list (by identifiers, a brand, or a filter
like "Noon apparel with fewer than 5 images") through the same path, without uploading photos again.
**Key requirements.** A "Re-run products" entry that takes a pasted list of identifiers or an M0 filter, uses current
source versions from M0, and creates a normal batch (auto-start, digest). Frozen controls are skipped.
**Acceptance test.** Paste 50 live identifiers; a batch runs on their current photos and the digest shows what changed.
**Buy or build.** Build (same pipeline, new entry).

### M1-F7 Product from photos or a web page (P2)

Starts a product when no sheet exists, from photos alone or a brand's product page, using a bought vision model (M2)
to propose identifier, type and colour, with the source recorded. Metric: products created without a sheet. Not
before M2's analyzer has measured accuracy.

## 5. Operator experience

Target: zero cognitive load and no babysitting.

**Screen 1: New batch (one page).**
- Top line, always visible: "To use a Google Sheet or Drive folder, share it with `catalog-reader@...` as Viewer.
  [Copy]" (the real email comes from the server, as today).
- Drop zone: "Drop folders, files, zips or sheets here. Several at once is fine."
- Below it, as data arrives: "Found 1,284 photos for 312 products. Folder `USPA_AW26` grouped by folder name, sheet
  `links.xlsx` by column E (Option Id)."
- "Going to: Namshi, Noon, Trendyol, Styli, Centrepoint (where this brand is listed). Change"
- Countdown: "Starting in 10 s. [Wait]"
- If the brand cannot be inferred, the only question, above the drop zone: "Which brand is this?"

**Screen 2: Batch page while running.** One progress line ("Making images: 9,120 of 13,104") and "You can close this
page. We will keep going." First links appear in the sheet as soon as the first products finish.

**Screen 3: Batch page when done (the digest).**
- "Links ready for 312 of 312 products."
- "41 links are provisional and will improve by themselves. Main reasons: no back view in the photos (22), not
  enlarged yet (12), checked later (7)."
- "3 photos left out: wrong product in the photo (2), file unreadable (1). See the Exceptions sheet."
- "12 products are controls in a running experiment; their Noon and Namshi images were left unchanged on purpose."
- "Cost: USD 0.11 per product. Time to first links 4 min, to all links 46 min."
- Buttons: "Download sheet" (links, Exceptions, Provisional), "Open batch details".

No screen asks the operator to decide per product.

## 6. Measurement

| Metric | Baseline | Target | Data source |
|---|---|---|---|
| Operator clicks after upload until links ready | 4 Continue/Start plus channel ticks every batch | 0 (1 when the brand cannot be inferred) | M6-F3 touch counter |
| Products with links at finish | 82 of 200 held; 323 held outputs per 200 products (8628295f) | 100% of products with any deliverable photo | digest |
| Per-product attention items shown | 82 per 200; 308 in one batch | 0 | `pending_attention` count |
| Real batches reaching processing with no operator answer | xlsx crashed step 2 (574f2025); 13 drafts stranded in 7 days | 100% of batches with an inferable brand | batch rows |
| Orphaned drafts | 13 in 7 days | 0 | daily count (F5-R5) |
| Provisional links improved within 72 h | n/a | at least 70% | improvement tasks |
| Audit fail rate on provisional links | n/a | under 2% (M7 sets the bar) | M7 audit |

## 7. Build slices

| # | Slice | Depends on | Acceptance test |
|---|---|---|---|
| M1-S1 | Email up front, multi-folder pick, per-root grouping, Supabase folder paste kind | none | F1 tests 1-2, F2 test 1 |
| M1-S2 | One-page wizard: brand inference, channel defaults, auto-start with countdown, start blockers as rules, `autoStart` API flag | M1-S1; M0-S2 for brand inference (falls back to brand list until then) | F2 tests 2-4 |
| M1-S3 | Auto-decide rule table, provisional delivery, no `pending_attention` for new batches, locks released at finalize | none (M0 reasons added when M0-S3 lands) | F3 tests 1 and 3 |
| M1-S4 | Improvement task and same-URL republish | M1-S3 | F3 test 2 |
| M1-S5 | Digest (column, builder, page, Exceptions and Provisional sheets), attention list off by default | M1-S3; M2 gap report for reasons (flags until then) | F4 tests 1-2 |
| M1-S6 | Follow-up batches, auto-start of collected drafts, orphan count, sweep re-send of a given-up intake | M1-S2 | F5 tests 1-3 |

Database changes (additive, one migration after M0's `0009`, for example `0010_intake_auto_decide.sql`):
`catalog_batches.digest jsonb` (nullable), `catalog_batches.parent_batch_id uuid` (nullable, `ON DELETE SET NULL`),
`catalog_batches.auto_start boolean NOT NULL DEFAULT false` (existing rows keep explicit start), and
`catalog_auto_decide_rules` (cause, channel or `*`, action, enabled, updated_by, updated_at; seeded with the table in
F3-R1). The output flag `provisional` is added to `OUTPUT_FLAGS` (flags are jsonb without a database CHECK, so no
migration is needed for it).

## 8. Risks and open questions

| Risk or question | Effect | Mitigation or default |
|---|---|---|
| Provisional images reach channels with a visible defect | Rejections or a worse listing | Hard channel rules still apply; drop on product truth; audit sample; improvements republish at the same URL |
| Channels copy images at upload, so improvements need a re-upload | Improvements do not reach shoppers | Weekly "Improved" sheet now; M9 pushes later |
| Wrong brand inferred | Links under the wrong brand path | 10 s countdown shows it; safe cancel and re-run |
| Per-root grouping guesses wrong on odd folders | Products merged or split wrongly | Grouping sentence shown during countdown; hand-count check in the acceptance test; optional Change |
| Removing cards removes the operator's sense of control | Trust | The digest states numbers and reasons plainly; corrections stay possible from the sheet and product page |
| Auto-start on a huge accidental drop | Cost | M6 per-batch cost estimate shown in the countdown line; admin cap on products per auto-start batch (default 30,000) |
| Open: email digest | | Default P1 |
| Open: Supabase links format (public vs signed) | | Default: accept both, read-only |

## 9. Integration decisions (2026-11-02)

| # | Decision | Why |
|---|---|---|
| D1 | Default channels come from the brand's setting, then M0 listings, then the five slice channels; not from the previous batch (F2-R4) | UX 5.2 and M1 disagreed; UX's "no surprises" rule wins |
| D2 | Admin settings named here (countdown, inference threshold, auto-decide rule table, improvement window) live in the M12 settings store, which moves into the first slice as M12-S1 | The P1 settings surface was a hidden dependency of P0 configuration |
| D3 | Migration number is assigned at merge time (next free number after rebase), not reserved; `0010` above is indicative | Several slices add migrations in parallel; see the roadmap's migration rule |
| D4 | Open questions answered: one brand per batch (default kept); 10 s countdown, set to 0 after two weeks without a Wait press; provisional images are not withheld on Noon (they are renders of real photos); digest email is P1; accept public and signed Supabase links | Technical or UX defaults, no owner input needed |
| D5 | Kept for the owner: who re-uploads improved images to channels before M9 (channel team task, see `../owner-questions.md`) | People decision |
| D6 | The Supabase folder paste (M1-F1-R4) switches on by itself when `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` are mounted on catalog-web from Secret Manager (`supabase-url`, `supabase-service-key`; `infra/deploy.sh` `WEB_SECRETS`, catalog-web only); `SUPABASE_FOLDER_PASTE=off` at deploy time is the admin switch that turns it off. The switch sticks: a later plain deploy reads it back from the live catalog-web env (`infra/lib/supabase-paste.sh`), a first deploy is on, and an unreadable service stops the deploy. Off neither mounts nor checks the two secrets. `infra/bootstrap.sh` grants catalog-web access to each of the two secrets only; a missing secret is skipped with a warning and a denied grant is left to a person, never a project-level grant (review of 2026-11-04) | M1-S1 shipped the paste off because the mounts were missing; no separate flag is needed, the code reads the env (`apps/web/lib/catalog/supabase.ts`) |
| D7 | M1-S3: the rule table is `catalog_auto_decide_rules` (migration 0014), one row per cause and channel or `*`, id `<cause>:<channel>`, seeded with the F3-R1 defaults. Start copies the enabled rules into the batch (`options.autoDecide`), so a change applies to the next batch only (the M12-S1 snapshot rule); a batch without that copy (started before M1-S3) keeps the holds. Actions are `deliver` and `drop` only, no `hold`, so nothing can wait for a person. Editing waits for the M12-S1 admin page | D2 puts admin settings in the M12-S1 store, which is not built yet; the table and the batch copy give the same behaviour now and move into the store later |
| D8 | M1-S3 delivers what the pipeline already made: `deliver` publishes the staged image (the bytes an operator's "Use as is" would publish), flagged `provisional`, when it exists and passes the channel's hard rules (no `failed_compliance`); otherwise the slot is dropped with its reason and the product's other photos are delivered. The re-renders F3-R1 names (pass-through render for a busy background, the cleaned photo without the failing step, the plain render after an encoder fault, promoting another photo to image 1) are new render work for the improvement task (M1-S4) and M2 shot roles; until then image 1 is delivered provisional (the table's "else" branch) and a busy background delivers its staged render. The rule table can switch any cause to `drop` per channel. Owner decision (Sujan, 2026-11-04): "Deliver as-is, flagged". A busy-background (`unusable`) image delivers the existing render marked provisional; the proper pass-through render comes with M1-S4 | Keeps S3 to the auto-decide and publish path; every slot still gets a link or a reason |
| D9 | `collage` (a hold cause not in the F3-R1 table) defaults to `drop`, like a different item | Several photos in one is not a product photo for a marketplace |
| D10 | In an auto-decide batch a product with nothing delivered on any channel, or one the intake could not process (two files with the same shot), ends `failed` with its reason (an exception for the digest, F3-R2), never `pending_attention`; while any chunk holding the product is open its publish waits; once none is open, an output still undecided or unjudged at publish is dropped with its reason, but a pipeline failure (`failed`) is not a rule decision and stays failed and counted; a hold with no cause is decided by the `not_publishable` rule; finalize releases every product's lock (F3-R7). The rule id is kept on each decided output (`compliance.auto_decide`, and `qa_scores.autoDecideRule` when judged); M0 `auto_decide` events follow when M0-S3 lands | F3-R2 and F3-R7; no new column needed |
| D11 | M1-S4 improves the cause `not_enlarged` only: a photo whose plain render was delivered `provisional` because the upscaler failed it for good. The sweep (every 10 minutes) sends `/tasks/catalog/improve` for each photo due a try; a try runs only while the upscaler is switched on and answers its health probe, so an outage never spends one. It reuses the spec 18 Try again reset (`resetPhotoEnlargement`): the photo is re-made and published at the same public path with a new object generation, and `provisional` clears. Defaults: 3 tries within 72 hours of the first delivery, the first after 30 minutes, then 12 hours apart, probed at most once an hour; held in `catalog_improvements` (migration 0015) with `improved_at` for the "improved within 72 h" measure; a photo with no `improved_at` and either 3 tries or `end_reason` `not_passed` is what the M1-S5 digest lists once (F3-R5). Review fixes (2026-11-04): a try runs only while the batch still owns the product's links (`last_batch_id` names it) and only on the batch's channels; a later batch that published the product retires the photo as `superseded`. One check (`laterPublisher`: the product's `last_batch_id` names a batch that started after this one; start order is lock order) also guards Use as is, Remove, Replace and Try again. Try again on an auto-decide batch's delivered slot keeps the slot as delivered too, so a re-made slot that a rule drops is put back. A product in a draft batch whose preview is ready is not improved, so a background try never makes the operator's Start refuse with the product's lock (a try already running when the draft becomes ready still holds the lock until its publish). Known limit: supersede is per product, so when a later batch publishes only some channels, the older batch's provisional slots on its other channels stay provisional (no improvement, Try again refused); the M1-S5 digest lists them. A re-made slot that does not pass (held and delivered or dropped by a rule, failed, never judged) is put back exactly as delivered from the copy kept in `catalog_improvements.previous`, so a failed try never downgrades a link; when the upscaler did enlarge the photo but the render still did not pass, the photo is retired as `not_passed`. The window and spacing are re-checked when the task runs; an upscaler whose probe failed is not probed again by the same instance for 10 minutes; a waiting photo is touched so the sweep's limit of 100 rotates. A partial index (`catalog_outputs_provisional_plain_idx`, 0015) serves the sweep's candidate query. Each try re-opens the batch's finalize, so a new links sheet is written even after a try that changed nothing. Finalize now waits for a re-made product's publish, and for an improvement until its publish has seen the re-made slots (this also closes the same race for Try again); that wait re-queues after 30 s, doubling up to 10 minutes, with one WARNING at the cap, and `done_batch_with_open_chunk` ignores chunks opened after the batch finished. Not in S4: the later judge check for `unchecked` (with M7), crops and generated shots (M3), and the M0 `links_delivered` event with reason `auto_decide` (M0-S3); those slots stay provisional | F3-R4 and F3-R5 for the cause the release depends on; the admin page for the defaults waits for M12-S1 (D2) |
| D12 | The pass-through render for a busy background (F3-R1 `unusable`) needs no new render work: since #63 a busy-background photo is kept whole (`wholePhotoMatte`, matte-guard.ts) and rendered onto the channel canvas, so the staged render M1-S3 delivers `provisional` is already the brand photo resized to the canvas | Checked in M1-S4 against D8 |
| D13 | Owner decision (Sujan, 2026-11-04, "Wait, then deliver flagged"): during a GPU upscaler outage an auto-decide batch's enlargements should wait up to a deadline (default 6 hours) and then be delivered as provisional plain renders, so the batch finishes, with M1-S4's improvement re-enlarging them at the same URL later. Deferred to its own slice (owner, 2026-11-04, "Split it out"), to be designed by the deep planner: two review rounds showed that telling a real outage from a saturated or backlogged but healthy upscaler needs its own design. M1-S4 ships without it, so outages behave as spec 18 says (photos wait). F3 test 2 as written ("stop the upscaler during a batch: the batch finishes with plain renders delivered as provisional") is pending that slice; M1-S4 covers its second half (a delivered provisional plain render is improved at the same URL) | F3 test 2 first half pending the D13 slice |
| D14 | M1-S2 (2026-11-04): the brand is inferred before the batch is made (the batch row and its storage paths need it). Each dropped path counts once per distinct identifier: the file-name identifier, then folder names, looked up in the SKU master (option id, EAN, Opptra SKU), M0 options and earlier non-test products; the top brand needs 90% of the resolved identifiers and must be in the brand list. A paste with no files asks the brand | Technical gap in F2-R3 (M0-S2 resolveOption is not merged yet; the same tables are read directly) |
| D15 | `autoStart` on `POST /api/catalog/batches` defaults to off, so API and load-driver batches keep their explicit Start (R9); the one-page New batch sends `autoStart: true` and the default channels. This overrides "default true" in section 3 | R9 is the specific rule; the two lines disagreed |
| D16 | The countdown runs on the server: the end of collection writes `counts.autoStartAt` and queues `/tasks/catalog/auto-start` with a 10 s delay; the task starts the draft only while it is still that countdown (a newer one makes it a no-op, so more files restart it). Wait (`hold-start`) sets `options.autoStart` false and clears the countdown. One shared Start (core `pipeline/start.ts`) serves the button and the task. The 10 s is a constant until the M12 settings store exists (D2). No migration (optional JSONB keys) | R8: the tab can be closed at any point, so the countdown cannot live in the browser |
| D17 | Start blockers in M1-S2 (R7): products locked by another batch make auto-start try again (60 s doubling to 15 min, D21) until the lock frees (the linked follow-up batch is F5, not built yet); same-product pairs no longer block Start: the batch starts without the pair, which grouping already leaves out with its sentence. Two spellings of one product from different uploads keep only the newest upload's photos: the other spelling is left out with "<older> is the same product as <newer>. Only the newest photos are used." (`options.newestSameProduct`, on unless the operator unticks "Use only the newest photo of each product" under "Change how products are grouped"; off leaves both out, as before). Spellings from one upload have no newest and are both left out, as before. Another batch processing and failed links start anyway, as before. The label is a manager default (UX D21) | Technical choice for the parts that need F5; copy per UX D21 |
| D18 | Channels stay editable while the files are collected: a change of channels alone is accepted for a collecting batch (F2-R4) | The worker never writes channels |
| D19 | The "Waiting for a brand" list (F2 edge case, section 4) is not in the M1-S2 or UX3 rows and is not built in M1-S2. In M1-S2 a brandless draft cannot exist: the New batch page asks the brand before the batch is made when it cannot be inferred (D14). The list belongs with M1-S6 (auto-start of collected drafts), which is where a draft can be collected without a brand and wait | Placement decision; no owner input needed |
| D20 | Known gap until M1-S6: the one page hands inputs to collecting about 0.8 s after the last add, and a collecting batch refuses input changes ("This batch is still collecting"), so a second drop or a paste correction made while the first input is collected is refused. The old four-step flow handed off only at Continue. Intake browser scenario 4 (correction while collecting) is fixme until M1-S6 decides what a change while collecting does (a follow-up batch, F5, or an edit of the draft) | Deferred to M1-S6; the disabled scenario is traceable here |
| D21 | Busy retries back off: a draft whose products another batch holds tries again after 60 s, doubling to at most 15 min (about 4 tasks an hour instead of 60), and a wait past one hour is logged as a WARNING on each retry. Wait is authoritative: the auto-start re-checks auto-start and its countdown under the batch row lock that Wait also takes, so a batch never starts after Wait answered | Cost at min-instances 0; R6 safety |
| D22 | Brand inference needs coverage: besides 90% of the resolved names, at least 50% of all distinct names must resolve (`BRAND_MIN_COVERAGE`); otherwise the brand is asked, so a drop is never auto-started on a guess from a few known names. The brand can be changed on a draft until Start ("Change brand" on the New batch page, `POST /batches/:id/brand`): the channels become the new brand's defaults, the countdown stops, and the files are collected and grouped again under the new brand (products the draft made under the old brand are removed by the regroup; files collected under the old brand's raw prefix stay there). Refused while collecting, and when it would turn a test batch into a real one or the other way round | Technical decision (review P1-2); the thresholds become M12 admin settings once that store exists |
