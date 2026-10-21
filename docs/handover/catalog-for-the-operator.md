# Catalog images: a guide for the operator

This note is for you, the person who makes marketplace images with the catalog tool. Keep it open
the first few times you use it. When something here does not match what you see, call Sujan.

The live address and the test results in section 17 come from the end-to-end test on the live
site on 2026-10-20.

## 1. What the tool does

You upload a brand's product photos once. The tool makes the right size and background of every
photo for each marketplace you choose (Namshi, Noon, Trendyol, Amazon, Styli, Centrepoint,
6thStreet, VogaCloset, Shein), checks every picture, and gives you a sheet with one row per product
and one link per picture. You paste those links into the marketplace templates.

## 2. How to sign in

1. Open the link: https://catalog-web-847405579637.asia-south1.run.app (the live address of the
   tool).
2. Google asks you to sign in. Use your @opptra.com account.
3. You land on the catalog page.

If you see the batches but there is no "New batch" button and the page says "You can view this but
not change it. Ask an admin for the operator role.", ask Sujan to make you an operator. Nothing
else is needed.

## 3. Naming photos before uploading

- Name each photo with the product's identifier, an underscore and the photo's position:
  `ABC123_1.jpg`, `ABC123_2.jpg`, `ABC123_3.jpg`.
- The identifier is the style and colour code: one identifier per product. Never use a size code;
  all sizes of one colour share the same photos.
- The number is the photo's position: `_1` is the first image on every marketplace.
- iPhone photos (HEIC) are fine. They are converted automatically.

## 4. Sharing a Google Sheet or Drive folder

You can paste a link to a Google Sheet of photo links or to a Google Drive folder instead of
uploading files. After you paste it, share the sheet or folder with the address shown on the screen.
"Viewer" is enough: the tool only reads.

## 5. The four steps of a new batch

Press "New batch". The steps are:

1. "Brand and files": choose the brand, then upload photos or a zip, or paste links. The brand
   you choose here is the batch's brand. The tool does not prove that a folder belongs to that
   brand, even when the photos look alike, so check it yourself.
2. "Check what we found": see how many products and photos were found and how the products were
   told apart (for example "grouped by file name before the last _number").
3. "Where will these images go?": tick the marketplaces you need.
4. "Start": a last check of what will be made, then press "Start processing".

About brands:

- "Test Brand" is for testing only. Its pictures go to a test area, never into a real brand's
  reports or links. Do not use it for real work.
- Anta is not in the brand list yet. Before the first real Anta batch, ask Sujan to add Anta as a
  brand (the steps are in `docs/solutions/manual-brand.md`). Do not use "Test Brand" instead.

Step 4 is a check, not a result. Before a large run, show the grouping of one or two rows to
whoever asked for the images and confirm it is right. "Products found" counts identifiers, never
files: a product with five photos is one product.

## 6. What each state means and what to do

| What you see | What it means | What to do |
|---|---|---|
| "Collecting files N of N" | The tool is copying your files or links. | Wait. |
| "Processing N of N" | The pictures are being made and checked. | Wait. You can close the page; it keeps going. |
| "Needs attention (N products)" | Everything else is done and in the sheet; N products need a decision from you. | Open the batch and decide on each card (section 7). |
| "Ready to download" | Every picture is live and passed every check. | Download the sheet (section 9). |
| "Could not start" | The batch stopped before making anything. The page says why. | Fix what it says and start again. If it happens twice, call Sujan. |

## 7. Resolving attention items

A product waits for your decision only when:

- a photo shows a different item from the product's other photos (checked twice);
- a photo is a collage of several photos;
- the background could not be removed from a photo (a busy scene, such as models on a tennis
  court; the made picture shows the whole photo as it is, with its own background);
- photo 1 cannot be used;
- none of the photos can be used;
- a file cannot be opened, or the quality check could not run (the last rows of the table below).

Smaller problems are handled for you. A weaker photo that is not photo 1 is left out with a note
in the sheet, or kept with a note.

Photos that are already cut off at the frame edge (for example a model cropped at the thighs, or
a face cut at the top) are not held. The tool places the cut edge flush against the edge of the
picture, with no gap and no shadow under it, and adds a note in the sheet ("Photo N: already cut
at the frame edge"). The tool never crops; if the cut matters, ask the brand for an uncut photo.

Each card shows the original photo beside the made picture, and a sentence saying what looks
wrong. You have three buttons:

- "Use as is": the picture is fine. It stays in the sheet.
- "Remove this photo": the sheet cell is emptied with a note. If that picture was already live
  from an earlier batch, its link stops working.
- "Replace photo N": drop in a better photo. It is made again for the same marketplaces, behind
  the same link.

What the sentences on the card mean:

| The card says | Meaning |
|---|---|
| "Part of the product or model looks cut at the frame edge in the original photo." | The original is cropped. The tool never crops, so the made picture shows the same. Keep it or replace it. |
| "This photo does not match photo 1 of the same identifier." | The file may be named wrongly. Remove it if so. |
| "The edge of the product looks rough or shows a halo, often white on white." | Compare the two pictures. Keep it if it looks fine. |
| "Some of the original background is still visible around the product." | Compare the two pictures; keep or replace. |
| "The photo carries text, a watermark or a logo overlay. Marketplaces reject these." | Remove it, or replace it with a clean photo. |
| "This image combines several photos in one. Marketplaces reject these." | Remove it, or replace it with the single photos. |
| "The background could not be removed from this photo. Use it as is, replace it, or remove it." | A lifestyle photo on a busy background. "Use as is" publishes the whole photo with its own background; otherwise replace it with a studio photo or remove it. |
| "The product looks rotated or upside down." | Replace it with a corrected photo. |
| "The original photo is smaller than ... wants, so this one may look soft." | It will upload; ask the brand for a larger photo if you can. |
| "The original is only ... under 500 px on its long side." | Too small to look good anywhere. Remove or replace. |
| "The background was removed with the simple method because the cut-out service was unavailable." | Check the edges. Keep it if they look clean. |
| "The quality check could not read this image." | Look at it yourself; "Use as is" keeps it. |
| "Quality check paused: the spending limit was reached." | Look at it yourself, or ask Sujan to raise the limit and start a new batch. |
| "The image we made did not meet ...'s rules." | This should not happen. Remove or replace it and tell Sujan. |

## 8. Adding SKU ids

On the batch page, press "Add SKU ids" and upload the mapping sheet (identifier and Opptra SKU
ids). Only the SKU column of the sheet changes; the pictures and links stay the same.

## 9. The links sheet and the marketplace templates

On the batch page:

- "Download links sheet (Excel)" gives the sheet with clickable links.
- "Download CSV" gives the same sheet as plain text.
- "Download filled product list" appears when you uploaded a product list: it is your own list with
  the links added on the right.

Only download and share a sheet when the batch says "Ready to download" or "Needs attention".
Before sharing, open the Details tab and read two numbers: "Links verified N of N" and
"Independent re-check N of N OK". Both must be complete: the two numbers in each line are equal
and not 0. "0 of 0" means nothing was checked; do not share the sheet, call Sujan.

Only report numbers once the batch has finished. While it says "Collecting" or "Processing", the
counts are progress, not results.

When you hand a sheet to someone, also tell them:

- how the products were told apart (by file name, by folder, or by a sheet column);
- the products with gaps in their photo numbers, by identifier;
- the products flagged for text or watermarks, by identifier.

## 10. What a re-upload does

Uploading a product again replaces the pictures behind the same links. The links themselves stay
the same. Marketplaces keep their own copy of each picture, so after a re-upload re-submit the image
columns for every product whose `change` column says `updated`, `shots_removed` or `reordered`. If a
marketplace still shows the old picture after that, upload the picture by hand in the seller portal
for that marketplace.

Tell whoever holds an earlier sheet for that brand when a product was replaced, filed under another
identifier, or had photos removed.

Before a brand sends new photos for products it delivered before, download the current links from
the brand page ("Download links for selected products") and give them to whoever holds the earlier
sheet, so they can compare. Photos with the same file names are not always the same photos: the
tool compares the pictures themselves and marks a product `unchanged` only when they are identical.

## 11. Photo order matters

The photo numbered `_1` is image 1 on every marketplace, `_2` is image 2, and so on. Photos that
are not in a new upload of a product disappear from its links.

## 12. Renames and aliases

A renamed identifier is a new product with new links. If a product's identifier changed, first open
the product page and add the old name as an alias, then upload. The product then keeps its links.

## 13. Submit templates only from a finished batch

Submit marketplace templates only from a batch that says "Ready to download".

## 14. The cost line

The batch page shows a line such as "INR 3.80 per style so far · agency reference INR 60 per
style". It means: this batch has cost about INR 3.80 per product so far, against the INR 60 per
product the agency charged. Products that did not change are not counted.

## 15. When to call Sujan

- A batch shows "Processing" for longer than two hours.
- A batch shows "Could not start" twice.
- A link in the sheet does not open.
- A picture did not change after a re-upload.
- You had to name or group photos in a new way to make a batch work. Tell Sujan the rule you
  used, so it is written down for next time.

## 16. What the alert emails mean

When something goes wrong, the tool sends an email by itself. The emails go to sujan@opptra.com,
so Sujan often knows before you do. If he forwards one to you, or you see one, this section says
what it means. About an hour after things are fine again a second email says the problem is
resolved, so an old email does not mean the problem is still there. Each alert sends one email
when it starts; more of the same failure within the next hour sends no new email. Test runs that
Sujan starts himself (smoke, eval and load jobs) never send emails.

Two places help you look:

- The Ops page, `/catalog/ops`, which Sujan or another admin can open: the batches running now,
  failures in the last 24 hours in plain words, and what each batch and brand cost.
- The "Open logs" link on the batch's Details tab: it opens Google's log page already filtered to
  that one batch, so Sujan can see its story in order. Send him that link with the batch number
  when you call.

The nine emails:

1. **A chunk gave up.** The tool works on a batch in small groups of products, called chunks. One
   group failed five times in a row and the tool stopped trying it. On the batch's Details tab
   those photos are listed with "Processing stopped after repeated errors"; the rest of the batch
   carries on. First: wait for the batch to finish, then upload the same products again in a new
   batch (a re-upload keeps the links, section 10). Call Sujan if the same products fail again.
2. **A batch failed or was swept.** A batch stopped for good, or made no progress for two hours and
   was stopped by the tool's own clean-up. The batch page shows "Could not start" and the reason,
   for example "No progress for 2 hours. Start the batch again." First: read the reason and start the
   batch again once. Call Sujan if it fails a second time.
3. **Quality checks unavailable.** The outside quality checker did not answer for many photos in a
   few minutes. Those photos wait in "Needs attention" with "The quality check could not read this
   image." First: look at each picture yourself and use "Use as is" if it is fine (section 7). Call
   Sujan if a whole batch fills up with these cards.
4. **Cut-out service breaker open.** The service that removes backgrounds kept failing, so the tool
   stopped calling it for about a minute at a time to let it recover (like a fuse, called a
   "breaker"). The batch page stays on "Processing" longer than usual, and some photos may wait in
   "Needs attention" because the background could not be removed. First: wait 15 minutes; it
   usually recovers by itself. Call Sujan if the batch has not moved after 30 minutes.
5. **Spending limit paused quality checks.** The day's or the batch's spending limit was reached,
   so the tool stopped running quality checks. Photos that were not checked wait in "Needs
   attention". This is a limit that was set on purpose, not a fault. First: do not start more
   batches today. Call Sujan, who decides whether to raise the limit or wait for the next day.
6. **Worker errors.** The part of the tool that makes the pictures (the worker) returned many
   errors in a few minutes. The batch page may move slowly or stop moving. First: do not start new
   batches and wait 15 minutes. Call Sujan if it is still happening, or if a batch stops moving.
7. **Queue stuck.** More than 50 pieces of work are waiting in line and none has been picked up
   for half an hour. A large batch that is still moving does not send this email. The batch page
   shows "Processing" with no change in the count. First: refresh the batch page after a few
   minutes to see if the count moves. Call Sujan if nothing moves for another 30 minutes.
8. **Database connections high.** The database the tool uses is close to its limit of open
   connections. Pages may load slowly or show an error. First: do not start new batches, and ask
   others not to use the site for a while. Call Sujan if pages still fail after 15 minutes.
9. **Error in the logs.** Something went wrong that none of the first five emails covers. Often
   you see nothing on the batch page at all. First: carry on normally and look out for anything
   odd on your batches. Call Sujan if a batch looks wrong or stops; he reads the details in the
   logs.

There are no emails about money. The cost of a batch is shown on the batch page (section 14) and
on the Ops page, and nobody is emailed when a batch costs more than usual.

## 17. A recorded run

A recording of a full run, from "New batch" to the downloaded sheet, including the attention
buttons and a re-upload:

`docs/handover/catalog-e2e-2026-10-20.gif`

What the end-to-end test showed on the live site (2026-10-20): all six flows passed.

1. Sign-in: the @opptra.com account got in, and the People list shows each person's role.
2. A new batch: 2 products, 8 photos, Noon and Amazon, from "New batch" to "Ready to download"
   in about a minute.
3. Links: the links open for anyone, "Links verified 16 of 16" matched "Independent re-check 16
   of 16 OK", and the sheet downloaded with 16 links.
4. A re-upload: the same links show the new pictures, and a removed photo's link stops working.
5. Attention: "Use as is" kept the picture, "Remove this photo" emptied the cell with a note.
6. The cost line shows the cost per product and for the batch.

The test used Test Brand batches `8af822a4`, `706e67b4` and `e19b20f9`. One problem found during
the test was fixed: an upload could get stuck at "Collecting files 0 of ?". Now the tool tries
again by itself, and a batch stuck for 10 minutes shows a "Try again" button. Screenshots of each
flow are kept with the test records.

## 18. How long a large batch takes

Measured on the live site on 2026-10-21 with a test brand: 270 products with 1,258 photos on 4
marketplaces (Noon, Namshi, Trendyol, Amazon) took 43 minutes from Start to the end of the batch.
That is 5,032 pictures, about 110 finished pictures a minute, or about 6 products a minute.

- 255 products went straight into the sheet. 15 products waited in "Needs attention": 13 photos
  whose background could not be removed, and 9 photos the quality check could not run on.
- Every link was checked again afterwards by a separate check: 4,744 of 4,744 opened.
- More marketplaces mean more pictures. The same 270 products on all 9 marketplaces is about
  11,300 pictures; expect roughly 1 hour 45 minutes (an estimate, not measured).
- Cost: about INR 0.30 (USD 0.0036) per product for the quality check and the image work, so
  about INR 82 for the whole batch of 270, against the INR 60 per product the agency charged.

While a batch this size runs, do not start other batches and ask others not to use the site. The
tool shares its machines and its database between all batches, so a second batch waits behind the
first and pages can load slowly. Start large batches when nobody else needs the site.

The quality checker is an outside service and sometimes says "too busy, try later". In this run
that happened on about 1 check in 30. Most of those checks were simply tried again and passed; 4
photos ended up in "Needs attention" with "The quality check could not read this image." Since the
update of 2026-10-21 the tool waits and tries again, then asks a second checker, and only then
holds the photo for you. So expect fewer of these cards. When you see one, look at the picture
yourself; "Use as is" keeps it.

## 19. What changed on 2026-10-21

The live site was updated five times on 2026-10-21. What you may notice:

- Enlarged pictures are sharper. When a small photo has to be made bigger for a marketplace, the
  edges of the product are now sharpened as well, also on photos whose background was removed.
- Size charts with coloured tables are left out. A size chart printed on a tinted or coloured table
  is now recognised as a chart and is not used as a product picture, like plain size charts.
- Faint, see-through cut-outs are rejected. If removing the background leaves the product looking
  washed out or see-through, the tool tries another way. If the product would lose part of
  itself, the photo waits in "Needs attention" instead of being published torn.
- Sole edges on shoes are cleaner. A thin coloured strip that sometimes showed along the sole is
  now removed with a soft edge.
- When the quality checker is busy, the tool now waits and tries again, then asks a second
  checker, and only then holds the photo for you (see section 18). The note on the card now
  names the photo by the same number you see on the sheet.

Some photos are still held on purpose. For example, a product on a plain studio backdrop of almost
the same colour can lose part of itself when the background is removed; the tool holds it so a
broken picture is never published. Look at it and choose what to do as in section 7.

On a busy day the check that tells what kind of product a photo shows can fail quietly; the tool then
uses its general rules for that product, and a later update will show this as a note on the card.

## 20. Small photos and Styli

Since the update of 2026-10-21, when a photo has to be made more than 1.5 times bigger for a
marketplace, the tool enlarges it with a quality pass first. This works the same way on every
marketplace.

- Styli wants photos at least 1,482 px tall. The tool now judges the photo after the quality pass,
  which doubles its size, so Styli accepts photos that are at least 741 px tall.
- Photos under 741 px tall are still skipped for Styli, with the same note as before: "Skipped for
  Styli: the photo is smaller than Styli needs."
- In the links sheet, an image made this way carries the note "Enlarged with a quality pass to meet
  this marketplace's size." It uploads like any other image.
- In step 4, the Styli warning now uses 741 px. If it says some photos are smaller than Styli needs,
  those photos are under 741 px tall and will be skipped for Styli.
