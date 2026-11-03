# Catalog OS - UX and design system (draft for review, 2026-11-02)

Cross-cutting. Every module's "Operator experience" section follows this file. Plain words; jargon is defined the first
time it appears. Where this file and a module file disagree on a screen, this file wins on pattern and copy, the module
file wins on what data exists.

**Sujan's asks this file answers:** one of the most incredible-looking products, with zero cognitive load; never
babysat ("upload and walk away"); every setting configurable by a non-technical person; new brands, channels and
categories without code; later sold self-serve to brands and agencies worldwide and used to onboard brands to Opptra
distribution; a winning keyword shows up in the infographic; brand rights and likeness need a person.

**Intents:** I008, I009, I017, I021, I026, I027, I030, I031, I032, I033, I039, I040.

---

## 1. Who uses it

| Person | Today | Their one job in Catalog OS | What they must never have to do |
|---|---|---|---|
| Operator (Naaz, Taranum) | Babysits batches: 82 of 200 products needed attention; one batch left 308 to review | Drop the brand's files and walk away; collect links and listing files | Review products one by one; press Next; answer questions the system could answer |
| Catalog lead (Ashish) | Ranks priorities, checks quality by eye | Do the weekly sampled audit (2-5%); say what matters | Hunt for problems; read logs |
| Owner and admin (Sujan) | Decides rules in chats and specs | Approve risky settings, rights and likeness; read results | Ask an engineer to change a business rule |
| Viewer (channel managers, ads team) | Asks for links on chat | Find a product's live content and its results | Edit anything by accident |
| Later: brand manager, agency account manager | n/a | Upload a catalog, get it ready for every channel, see what sells | Learn our internal words |

## 2. Design principles

Each principle has a test, so it can be checked, not just agreed with.

1. **Walk away by default.** After files are dropped, the system finishes on its own. Test: zero required clicks
   between upload and "links ready" (I008, I009).
2. **One digest, never a queue.** A batch of 2,000 products produces one summary, grouped by reason, with counts. No
   per-product card ever asks for attention (I017, I032). Test: the number of per-product attention items is 0.
3. **Decide, then explain.** The system makes the safe choice, does it, and says what it did in one sentence. A person
   is asked only for product truth, modesty, likeness rights and threshold changes (settled HITL rule). Test: every
   "needs you" item belongs to one of those four kinds, or to "we cannot read your files".
4. **Outcomes, not machinery.** Screens show results ("All 2,000 products have links") and never the pipeline ("chunk
   14 of 52", "matting stage"). Technical detail sits behind "For the technical team". Test: no stage names, model ids,
   or vendor names on operator pages.
5. **One answer per screen.** Each page answers one question in its first line (see the page map). Test: the
   five-second test in section 13.
6. **Never lose work, never surprise.** Everything is saved as it happens; every change can be undone; risky changes
   preview their effect first. Test: undo or revert exists on every change; a setting change shows "what this changes"
   before it applies.
7. **Same words, same places.** One status vocabulary (section 4), one layout grammar, one component per job. Test: the
   copy lint and the component inventory.
8. **Images are the hero.** Product photos are shown large, on a neutral surround that does not tint their colour. The
   interface stays quiet around them. Test: no brand colour within 16 px of a product image.
9. **Calm by default, loud only when it matters.** Red only when a person must act now. No blinking, no badges for
   things that fix themselves. Test: the notification rules in section 6.
10. **Built for two languages and many brands.** Every layout works right to left; nothing hard-codes "Opptra", a
    channel, a currency or a brand. Test: the RTL screenshot test and the self-serve copy check.

## 3. Information architecture

**The object model in plain words.** A **brand** has **products**. A product is listed on many **channels**
(marketplaces); each product x channel is a **listing**. A listing holds **content** (images, text, attributes, extras).
A **batch** is one upload: an event that changes content, not a place where work waits.

**Top navigation (four items, plus one for admins):**

| Item | Page | The one question its first line answers | Main action | Route today -> proposed |
|---|---|---|---|---|
| Home | Home | "Is anything waiting for me, and how are my batches?" | New upload (drop zone on the page itself) | `/catalog` -> `/` |
| Products | Product list and product page | "What is live for this product on each channel, and is it complete?" | Copy links; download listing files | `/catalog/products/[brand]/[key]` -> `/products/[brand]/[key]` |
| Results | Results and learning | "What is working, on which channel?" | Open an experiment readout | new `/results` |
| Settings | Settings | "How does the system behave for this brand, channel or category?" | Change a setting with preview | `/catalog/brands/[slug]` and new -> `/settings/...` |
| Ops (admins) | Ops | "Is everything working?" | Open an incident | `/catalog/ops` -> `/ops` |

**Pages under them:**

- **Batch page** (`/batches/[id]`, today `/catalog/[id]`), reached from Home or a notification. Tabs: **Digest**
  (default), **Products**, **Downloads**, **Details** (technical). Today's tabs are Overview, Compare images, Links
  sheet, Details; "Compare images" moves to the product page, "Links sheet" becomes Downloads.
- **Digest** is the batch page's default tab and also the body of the batch email. It is the most important screen in
  the product (section 5.3).
- **Product page:** one gallery strip per channel with slot labels, text in English and Arabic side by side, extras,
  history ("what changed, when, why"), and results for that product when an experiment covers it.
- **Settings:** Brands (Brand DNA), Channels, Categories, Rules, Quality, Services, Experiments, Notifications, People.
- **Results:** per-channel outcome trends, experiment list, recommendations ("stop", "scale") with confidence.
- **Ops** (admins): health line, batches, cost, incidents, audits, services.

**Navigation rules.**
- A command search (Ctrl+K or the search box) finds any product, brand, batch, setting or experiment by name or code.
- Every page is reachable in at most two clicks from Home.
- Deep links from notifications land on the exact item, already scrolled and highlighted.
- Breadcrumbs only on Settings and Product pages (the only deep trees).

## 4. Status vocabulary (one set of words everywhere)

| State | Word shown | Meaning | Colour and icon |
|---|---|---|---|
| Uploading | "Receiving files" | Files are arriving | neutral, progress bar |
| Grouping | "Getting ready" | Files are read and grouped into products | run (navy), progress bar |
| Working | "Working" | Images and text are being made | run, progress bar |
| Links ready | "Links ready" | Every product has links; some may improve | ok (green), tick |
| Improving | "Improving by itself" | Better versions are being made for some products; links stay the same | ok, small spinner-free dot |
| Done | "Done" | Nothing left to do | ok, tick |
| Needs you | "Needs you" | One of the four person kinds, or unreadable files | bad (red) only if blocking; warn (amber) if the system already used a safe default |
| Paused | "Paused" | A person or a rule paused it (for example a channel refused) | warn |

Rules: never show "failed" for a batch that still produced links; a product never shows "error" (it shows the plain
reason). Words are the same in the UI, emails, sheets and exports.

## 5. Key flows, start to finish

Click counts count **required** actions only (a click, a drop or a keystroke that the flow cannot continue without).

### 5.1 First upload (a new person, maybe a new brand)

| Step | Person does | System does | Copy | Required actions |
|---|---|---|---|---|
| 1 | Opens Home | Shows the drop zone first, with the sheet-sharing email and a copy button already visible (I031) | "Drop photos, folders or a sheet here. Or paste links. To use a Google Sheet, share it with catalog-web@... (Copy)" | 0 |
| 2 | Drops three folders and one xlsx (I030) | Reads everything, detects the brand from file names, sheet columns and logos; groups photos by product | "Reading 3 folders and 1 sheet..." | 1 |
| 3 | (Only if the brand is new or unclear) picks or types the brand | Offers the best guess first: "Looks like Campus. Right?" with "Yes" preselected | "Which brand is this?" | 0 to 1 |
| 4 | Nothing | Picks channels from the brand's history (or the brand's settings for a new brand), starts processing automatically; no Next, no Start (I009) | "Working on 412 Campus products for Noon, Namshi, Trendyol, Styli and Centrepoint. You can close this page. We will email you when links are ready." | 0 |
| 5 | Walks away | Works; survives deploys; retries by itself | Progress line on Home | 0 |
| 6 | Gets one email: "Links ready" | Digest is ready | See 5.3 | 0 |

**Budget: at most 2 required actions for a known brand, at most 3 for a new brand, and 0 after the drop.** Time from
opening Home to walking away: under 60 seconds.

If grouping is ambiguous (for example a folder and a sheet disagree about the same product), the system picks the
safer rule (the newest file wins), proceeds, and lists it in the digest under "What we decided for you" with a one-click
"Use the other one" for that group. It never stops to ask.

A new brand gets a starter Brand DNA built from the first batch (look, colours from the logo). It is used only for
safe things (background, crops) until an admin approves it; rich media waits for approval (M12-F3).

### 5.2 Every-day upload (returning operator)

Open Home, drop files. **2 required actions**. The drop zone remembers nothing that could surprise: channels come from
brand settings, not from the last batch typed by someone else.

### 5.3 The batch digest

One screen (and the same content as one email). Structure, top to bottom:

1. **Headline sentence** (display size): "All 2,000 products have links." or "1,992 of 2,000 products have links. 8 need
   photos."
2. **Four numbers** (number tiles): "Products with links 2,000 of 2,000", "Complete for every channel 1,964",
   "Improving by itself 36", "Need you 0".
3. **Needs you** (only if not zero, rare): grouped cards, see 5.4.
4. **What we did by ourselves**, grouped by reason, each one line with a count and a "See which" link that opens a
   filtered product list:
   - "Filled 3,120 missing shots with crops of your own photos."
   - "Enlarged 410 small photos."
   - "Used the next best photo for 12 products whose first photo had a watermark."
   - "Wrote English and Arabic titles for 2,000 products."
5. **What we decided for you** (choices with a plausible alternative): "For 14 products, the folder and the sheet
   disagreed. We used the newest files. Use the other one."
6. **Downloads:** Links sheet, listing files per channel, exceptions sheet (every product with any note, one row each).
7. **Cost:** "Cost: INR 4,100 (about INR 2.05 per product)." With "How this is counted".
8. **Quality:** "60 products (3%) were picked at random for this week's quality check. You do not need to do anything."
9. **What changed since your last batch:** settings or rules now in effect ("Noon footwear titles are now up to 120
   characters, changed by Sujan on 4 Nov").

Rules: the digest never lists products one by one on screen (the exceptions sheet does); every group has a count and a
reason in plain words; the digest is complete even when parts are still improving (they update in place, and the
headline does not change back).

### 5.4 The exception path (rare)

Exceptions exist only for: product truth the system cannot settle (for example the photo's colour does not match the
sheet's colour), modesty, likeness rights, threshold changes, and files we cannot read.

| Step | Person does | System does | Copy | Required actions |
|---|---|---|---|---|
| 1 | Gets one notification per batch, not per product | Groups every exception of the batch by kind | "Campus Oct lot: links are ready. 1 thing needs you (3 products)." | 0 |
| 2 | Opens it (lands on the card) | Shows one card per group: the reason, the evidence (the photos side by side), what the system did meanwhile, and two choices with the safe one preselected | "The sheet says navy, the photos look black (3 products). We listed them as black for now." Buttons: "Black is right", "Navy is right" | 1 |
| 3 | Picks one | Applies it to the group; offers to make it a rule | "Done for 3 products. Always trust the photos for Campus colours? Yes / Not now" | 1 |
| 4 | (Optional) makes it a rule | Writes a setting change with preview (5.5) | "From the next batch, Campus colours follow the photos." | 0 to 1 |

**Budget: at most 3 required actions, under 60 seconds.** If nobody answers within the batch's deadline (default 48
hours), the safe default stays, and the digest says "We kept black for 3 products; you can change this on the product
page." The exception never blocks links (I033).

### 5.5 A settings change

| Step | Person does | System does | Copy | Required actions |
|---|---|---|---|---|
| 1 | Types "title" in search | Shows matching settings with their current values | "Title length, Noon, footwear: up to 150 characters (Noon's published rule)" | 1 |
| 2 | Opens it, changes 150 to 120 | Shows the preview right under the field | "42 of 1,240 Noon footwear products would get shorter titles. See 5 examples." | 1 to 2 |
| 3 | Presses "Apply from the next batch" | Saves a new version; running batches keep theirs | Toast: "Saved. From the next batch, Noon footwear titles are up to 120 characters. Undo" | 1 |

**Budget: at most 5 required actions, under 2 minutes, no help needed.** Risky settings (thresholds, audit rates,
rights, a service's primary, switching a category to automatic) show "Send to Sujan to approve" instead; Sujan gets one
notification and applies or declines from the same preview (M12-F1-R8). Revert is one click from History.

### 5.6 An experiment readout

| Step | Person does | System does | Copy |
|---|---|---|---|
| 1 | Gets one notification on the readout date (week 8 and 12) | Prepares the readout | "Week 8 readout: do complete shot sets sell more on Namshi and Noon?" |
| 2 | Opens it | Shows: the question; the answer sentence; an estimate bar with its range against zero; what to do next; the details for analysts behind a fold | "No clear effect yet. If there is one, it is likely smaller than 9%. Next: keep going to week 12 (17 Jan)." |
| 3 | Reads, optionally acts | Recommendation buttons only when the result is final: "Roll out to all", "Stop" | "Final: worked. Organic units rose about 6% (likely between 2% and 10%). Recommended: roll out to all apparel on Namshi and Noon." |

Answer words are fixed: **"Too early"** (before the first readout), **"No clear effect"** (range includes zero),
**"Worked"** (whole range above zero), **"Hurt"** (whole range below zero). The bar is always shown with its range;
there is no single number without a range. Budget: a person states the right conclusion and next step within 60
seconds, at least 9 out of 10 times.

### 5.7 Recording rights and likeness (the permanent person step)

Settings, Brands, the brand, Rights. A short form (who granted, document reference, scopes as yes/no switches, dates).
Only owners see "Save". Saving shows what it unlocks: "Saved. Vero Moda can now get still-life scenes from the next batch.
Faces stay off: likeness is not granted." This is per brand, not per product.

## 6. Notification rules

**Principle: notify only when something needs a person, or something they care about changed.** Everything else is
visible when they look, and silent when they do not.

| Event | Who | How | Copy |
|---|---|---|---|
| Batch links ready | The person who uploaded | One email + in-app | "Campus Oct lot: links are ready for all 412 products. Nothing needs you." |
| Batch has a "needs you" group | Uploader (product truth, files); owner (rights, likeness, thresholds) | One email + in-app, grouped per batch | "Campus Oct lot: links are ready. 1 thing needs you (3 products)." |
| Risky setting proposed | Owner | In-app + email | "Ashish asks to raise the Noon audit rate from 3% to 5%. See what it changes." |
| Rights end in 30 and 7 days | Owner | Email | "Vero Moda's image permission ends on 30 Nov." |
| Experiment readout ready | Owner, catalog lead, followers | Email | "Week 8 readout ready: no clear effect yet." |
| Channel refused content (3 or more in a week) and the system paused it | Owner, catalog lead | In-app + email | "Noon refused 3 infographics this week. Infographics on Noon are paused." |
| Incident that affects people (batches stalled, links not loading) | Owner, on-call engineer | In-app + chat channel | "Batches are delayed: the image service is slow. Nothing is lost; we will say when it is back." |
| Weekly audit sample ready | Catalog lead | One email on Monday | "This week's quality check: 60 products, about 15 minutes." |

**Never notify for:** a product that improved by itself; a retry that worked; a service that failed over and is fine;
progress milestones; cost under the cap; anything a person cannot act on.

**Limits.** At most one email per batch (the "needs you" line merges into the "links ready" email). At most one digest
email a day per person for everything else (a "Today" summary at their chosen hour). Quiet hours follow each person's
time zone and work week (UAE Saturday-Sunday, KSA Friday-Saturday, India Sunday); only incidents break quiet hours.
Every notification has "Stop these" which opens Settings, Notifications at that row.

**Channels.** In-app (a bell that shows only actionable items, never "for your information"), email, and optionally a
team chat channel for incidents. No SMS.

## 7. Copy principles

1. **Plain words.** Write as you would tell a colleague. Short sentences. One idea per sentence. Reading age about 12
   (Flesch-Kincaid grade 8 or lower), checked by the copy lint.
2. **No vendor or model names, ever, on operator pages, emails or sheets.** Say what it does: "image service", "the
   checker", "our system". Vendor names may appear only on Settings, Services and the Ops page, for admins. Model ids
   never appear anywhere.
3. **Say what happened, then what happens next.** "We used the next best photo. You can change it on the product page."
4. **Never blame the person.** "We could not read this file" not "Invalid file". If it is our fault, say "Our fault".
5. **Numbers carry meaning.** "1,964 of 2,000 complete" not "98.2%". Thousands separators. Money with currency and a
   per-product figure.
6. **Same word for the same thing.** Use the word list below; the status words of section 4.
7. **Buttons say the outcome.** "Apply from the next batch", "Black is right", not "OK", "Submit", "Confirm".
8. **No em dash, no exclamation marks, no "AI magic".** Generated content is called "generated", plainly.
9. **Arabic copy is written, not translated word for word**, by a native writer, in Modern Standard Arabic for the UI.

**Word list.**

| Use | Avoid | Why |
|---|---|---|
| product | SKU, option, style-colour (on operator pages) | Operators think in products; codes go in the technical columns |
| channel (in settings), the channel's name (everywhere else) | marketplace, platform, storefront | One word |
| photo (from the brand), image (what we send) | asset, output, render | Clear who made it |
| links | URLs, CDN | Plain |
| needs you | attention, review, action required | Warm and specific |
| improving by itself | provisional, pending regeneration | Says no action is needed |
| not made | failed, rejected, error | The product is fine; one extra was not made |
| quality check | audit, eval, QA | Plain |
| setting | config, parameter, flag | Plain |
| experiment | test arm, holdout, A/B | Plain; "holdout" only in the analyst details |

**Patterns.**
- Status: "<What is true>. <What happens next or what you can do>."
- Not made: "No <thing>: <reason in lower case>." ("No infographic: the highlights are too long for Noon's band.")
- Empty state: what this place is for, plus the one action. ("No batches yet. Drop a brand's photos here to start.")
- Confirm (destructive only): name the thing and the result. ("Delete Vero Moda's model data? Published images stay.
  Type DELETE VERO MODA to confirm.")
- Error: "<What did not work>. <Your work is safe>. <One thing to do>." (Today's `PLATFORM_TIMEOUT` in
  `apps/web/lib/catalog/copy.ts` already follows this.)

**Formats.** Dates "4 Nov 2026" (day month year, no ordinal); times in the person's time zone with "GST" or "IST";
money "INR 4,100" or "AED 120" (currency code, then amount); Arabic UI uses the same Western digits by default
(setting).

## 8. Visual language

**Direction: "a calm studio".** A quiet, warm frame (the existing navy and orange identity) around neutral image wells,
with generous space, large photography and very few colours on any screen. It should feel closer to a photo studio's
contact sheet than to an enterprise admin tool.

### 8.1 Colour tokens

Keep today's tokens in `apps/web/app/globals.css` (they come from the approved prototype) and add the missing roles.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--navy` | #131a48 | #131a48 | Top bar, primary identity |
| `--orange` | #ff5800 | #ff8c4f | One primary action per screen; links |
| `--bg`, `--card`, `--soft` | #ffffff, #ffffff, #f6f5f0 | #0f1330, #171c3f, #141839 | Surfaces |
| `--fg`, `--muted`, `--line` | #1b1b1f, #5a5a5a, #dedbd3 | #f1f1f4, #b9bcc9, #2b315c | Text and lines |
| `--ok`, `--warn`, `--bad`, `--run` | #1f7a3f, #b86e00, #b3261e, #1d2a7a | #6fd49a, #f0b35a, #ff8a80, #c9d0ff | Status (always with an icon and a word) |
| **new** `--well` | #f2f2f2 (neutral, no warm cast) | #1e1e20 (neutral) | Background behind every product image, so colours are judged truly |
| **new** `--focus` | #1d4ed8 | #93b4ff | Focus ring, 2 px, never removed |
| **new** `--selected` | #fff1e8 | #2a1c14 | Selected rows and chips |

Rules: one orange element per screen (the main action); status colours only for status; product images always sit on
`--well`; no gradients on images; dark mode follows the system and can be forced (already built).

### 8.2 Typography

- **Today:** Spectral (headings) and Raleway (body), self-hosted by `next/font` (`apps/web/app/fonts.ts`). Raleway shows
  old-style figures by default and has no Arabic.
- **Recommendation (open question U1):** keep Spectral for English display headings (identity), and move body and UI
  text to **IBM Plex Sans** with its designed sibling **IBM Plex Sans Arabic** (both under the SIL Open Font License), so
  English and Arabic look like one family. Use lining, tabular figures for every number (`font-variant-numeric:
  lining-nums tabular-nums`). Arabic headings use Plex Sans Arabic SemiBold, not Spectral.
- **Scale:** 13 caption, 15 body, 17 small heading, 22 section heading, 30 page title, 44 digest headline and number
  tiles. Line height 1.5 for Latin, 1.7 for Arabic; Arabic sizes one step larger at small sizes (13 becomes 14).
- No letter spacing on Arabic; no italics in Arabic; no all-caps anywhere except codes.

### 8.3 Space, shape, depth, motion

- Spacing on a 4 px grid: 4, 8, 12, 16, 24, 32, 48, 64. Page side gutter 16 px on phones, 24 px on desktop; content width
  1080 px (as today), 1280 px for product galleries.
- Corners: 8 px cards, 6 px inputs and buttons, full round for chips and pills. Product images are never rounded more than
  4 px (they are products, not avatars).
- Depth: flat cards with a 1 px line; shadows only for things that float (menus, toasts, dialogs).
- Motion: 150 ms ease-out for state changes, 250 ms for panels; progress is a calm continuous bar, never a spinner for
  anything longer than 2 seconds; one small tick animation when a batch reaches "Links ready". Everything respects
  "reduce motion".
- Icons: one outline icon set at 20 px with 1.5 px strokes (for example Lucide, ISC licence). An icon always has a word
  next to it, except universal ones (close, search, menu).

### 8.4 Charts and numbers

Number tiles show the number large and its meaning small ("2,000 of 2,000 / products with links"). Experiment results
are always an estimate bar with its range and a zero line; trends are simple lines with the change marked when content
changed (a dot on the line). Follow the dataviz guidance for colours (a validated palette, the same in light and dark).

## 9. Component inventory

**Existing components and what happens to them** (all in `apps/web/components` unless noted):

| Component today | Fate | Notes |
|---|---|---|
| Top bar and nav in `app/layout.tsx` | Keep, change items | Home, Products, Results, Settings; Ops for admins; product name "Catalog" (today "Catalog images") |
| `UserMenu.tsx`, `PeopleModal.tsx` | Move People into Settings | Menu keeps sign-out and theme |
| `Toast.tsx` | Keep, add Undo | 10-second undo for every reversible change |
| `AutoRefresh.tsx` | Keep for now | Later replace polling with live updates |
| `catalog/CatalogWizard.tsx`, `WizardStep1-4.tsx` | Replace with one DropZone page | Steps 2 to 4 appear only as digest notes or a single brand question (I009) |
| `catalog/Uploader.tsx`, `PasteBox.tsx`, `ShareBox.tsx`, `InputList.tsx` | Merge into DropZone | Share email visible first (I031) |
| `catalog/GroupingPreview.tsx`, `SheetPreview.tsx`, `OverwritePreview.tsx`, `SkuMapModal.tsx` | Keep as detail views | Opened from "What we decided for you", never as a required step |
| `catalog/ChannelPicker.tsx` | Keep as ChannelChips | Defaults from brand settings |
| `catalog/BatchBanner.tsx` | Becomes ProgressLine and OutcomeHeadline | One sentence plus a calm bar |
| `catalog/BatchKpis.tsx` | Becomes NumberTiles | Four tiles, meaning under each number |
| `catalog/BatchTabs.tsx` | Keep, rename tabs | Digest, Products, Downloads, Details |
| `catalog/AttentionList.tsx`, `AttentionProductCard.tsx` | Remove | Replaced by NeedsYouCard (grouped, rare) |
| `catalog/CompareGrid.tsx`, `CompareTab.tsx`, `CompareViewer.tsx` | Move to product page as ImageCompare | Before and after per channel |
| `catalog/CostLine.tsx` | Keep | Adds per-product figure |
| `catalog/DetailsTab.tsx` | Keep | "For the technical team" |
| `catalog/EvalLabelBar.tsx` | Becomes AuditCard | Weekly sampled quality check, keyboard-first |
| `catalog/LinkFailures.tsx`, `RetryCollectButton.tsx` | Keep, hidden unless needed | Retries happen by themselves first |
| `catalog/NotRefreshedLine.tsx`, `CatalogError.tsx` | Keep | Already plain |
| `catalog/ProductImages.tsx`, `ProductEvents.tsx`, `ProductBatches.tsx`, `ProductSearch.tsx`, `AddAliasForm.tsx`, `RemoveProductDialog.tsx`, `ReplaceModal.tsx` | Keep on product page | ProductImages becomes ChannelGallery |
| `catalog/UnfinishedBatches.tsx` | Becomes Home "In progress" | |
| `ViewerPreview.tsx` | Keep | "Preview as viewer" |
| `ui.tsx` (`Badge`, `usd`, `when`) | Replace `Badge` with StatusWord; `when` shows local time, not UTC "Z" | |

**New components:**

| Component | Purpose |
|---|---|
| DropZone | Folders, files, sheets, pasted links; share email with Copy; brand guess |
| CommandSearch | Ctrl+K search across products, brands, batches, settings, experiments |
| OutcomeHeadline | The digest's one-sentence headline at display size |
| NumberTile | A number with its meaning; optional "See which" link |
| ReasonGroup | One line of "what we did by ourselves" with count and filter link |
| DecisionNote | "What we decided for you" with a one-click alternative |
| NeedsYouCard | A grouped exception: reason, evidence, safe default, two choices, "make it a rule" |
| ChannelGallery | One strip per channel with slot labels ("1 Front", "2 Back", "Extra: infographic") on `--well` |
| BilingualText | English and Arabic side by side, Arabic right to left, with character counts against limits |
| ChannelPreview | How the listing looks on that channel, including Arabic RTL |
| SettingRow | Label, help, value, source, evidence grade, inheritance level, inline edit |
| ImpactPreview | "What this changes" from the 30-day replay, with examples |
| VersionHistory | Who, when, why, old value, Revert |
| ProposalCard | A risky change waiting for the owner, with the same preview |
| RightsBadge | "Valid until ..." or "Ends in 7 days" or "Not on record" |
| ExperimentCard | Question, answer word, EstimateBar, next step, date |
| EstimateBar | Estimate with range and zero line |
| TrendLine | Outcome over time with content-change dots |
| HealthLine | The Ops page's one-sentence status |
| StatusWord | Icon, colour and word from section 4 |
| EmptyState, Skeleton | What the place is for, plus one action; loading shapes, never spinners for page loads |
| ConfirmTyped | Typed confirmation for deletions |
| Stepper, ColourField (with contrast check), FileField | Typed inputs for settings |
| NotificationBell | Only actionable items |

Every component documents: when to use it, when not, its copy pattern, its RTL behaviour, its keyboard behaviour and its
states (empty, loading, normal, long text, error).

## 10. Accessibility

Target: WCAG 2.2 level AA (the web accessibility standard), checked automatically and by hand.

- Contrast at least 4.5 for text, 3 for large text and interface parts; status never by colour alone.
- Every action works by keyboard; visible 2 px focus ring; logical tab order; Escape closes dialogs; the audit card and
  the exception card have single-key shortcuts shown on screen.
- Screen readers: progress and "links ready" announced through a polite live region; images have alt text from M2's
  analysis ("Front, on model, navy polo"); tables have headers.
- Target size at least 24 px (WCAG 2.2), 44 px on touch screens.
- Text can grow to 200% without loss; no text in images in the interface; reduced motion respected.
- Forms: labels always visible (no placeholder-only labels); errors next to the field in words.
- Automated: axe checks in CI on every page; manual keyboard and screen-reader pass (NVDA on Windows) before each module's
  UI ships.

## 11. English and Arabic, right to left

**Scope now:** the interface is English, but every layout is built right-to-left ready, and every Arabic **content**
(titles, bullets, infographics, A+) is shown in true RTL previews. **Later (self-serve):** a full Arabic interface.

- Use CSS logical properties everywhere (`margin-inline-start`, not `margin-left`), so a `dir="rtl"` page mirrors by
  itself.
- Mirror: layout, navigation order, back and forward arrows, progress direction, chevrons. Do not mirror: product images,
  logos, media play controls, checkmarks, numbers, codes.
- Mixed text: product codes, SKUs, URLs and English brand names inside Arabic text are wrapped in bidirectional isolation
  (`<bdi>` or `unicode-bidi: isolate`), so "USPA-123" never flips.
- Arabic typography per section 8.2: its own font, larger line height, no letter spacing, no italics.
- Digits: Western digits by default in the interface and on images, Arabic-Indic digits as a per-channel content setting.
- Dates: Gregorian by default; the Hijri calendar shown alongside only where a channel or brand asks (for example Ramadan
  planning).
- Length: allow up to 30% growth between languages without breaking a layout; character limits are counted per language
  against M5 rules and shown under each field ("62 of 80").
- Testing: an RTL screenshot test for every page; one native Arabic reader reviews each new screen and every content
  template once.

## 12. Mobile

- **Phones are for checking, not for configuring.** On a phone a person can: read Home and the digest, act on a
  "needs you" card, copy links, read an experiment, approve a risky setting as owner. Uploading from a phone works for
  photos in the camera roll.
- Layout works from 360 px wide: single column, 16 px gutters, no horizontal scroll, number tiles in a 2 x 2 grid,
  galleries swipe sideways per channel.
- Touch targets 44 px; sticky one-action bar at the bottom for the main action.
- Emails are designed for phones first (the digest email is read there most).
- Settings editing works on a phone but is designed for a desktop; risky edits show "Better on a larger screen" without
  blocking.

## 13. How we test "zero cognitive load"

**Definition.** Cognitive load is zero when a person never has to remember, compute, search for, or decide something
the system could have done for them. We measure it with four signals: required actions, time to understand, errors, and
felt effort.

### 13.1 Task set and pass bars

| # | Task | Pass bar |
|---|---|---|
| T1 | First upload with a new brand, then walk away | At most 3 required actions; under 60 seconds to walk away; 0 actions after the drop |
| T2 | Every-day upload | 2 required actions; 0 after the drop (I008 test) |
| T3 | From the "links ready" email: "Is the batch done, and does anything need you?" | Correct answer within 5 seconds for at least 9 of 10 people (five-second test) |
| T4 | Resolve a grouped exception | At most 3 required actions; under 60 seconds; no wrong choice |
| T5 | Copy the Noon image links of one product | At most 3 clicks from Home |
| T6 | Change a setting (Noon footwear title length) and confirm it applies next batch | Under 2 minutes; at most 5 required actions; no help opened |
| T7 | Read an experiment readout and say the conclusion and next step | Correct for at least 9 of 10 people; under 60 seconds |
| T8 | Add a new brand and record its rights | Under 10 minutes |
| T9 | Find a product's Arabic title on Noon and see if it is within the limit | At most 3 clicks |
| T10 | Undo a setting change made by mistake | Under 20 seconds |

### 13.2 Methods

- **Moderated think-aloud sessions**, 5 people per round (five users find most usability problems): 2 operators, the
  catalog lead, 1 new hire who has never seen the product, and 1 outside brand person as a self-serve stand-in. At least
  one Arabic reader in every round that touches Arabic. Record time, required actions, errors, and every moment of
  hesitation over 3 seconds.
- **Five-second tests** on the digest and the Ops page: show for 5 seconds, then ask "Does anything need you?".
- **First-click tests** for T5 and T9.
- **Felt effort:** after each task the single ease question (1 to 7; pass at 6 or more on average); after the session the
  System Usability Scale (pass at 80 or more).
- **Cadence:** before each module's interface ships, and once a month on the live product.

### 13.3 Signals measured in the live product

| Signal | Target | Meaning when it misses |
|---|---|---|
| Required actions after upload, per batch | 0 | The system is asking something it should decide |
| Batches whose page was opened before "links ready" | Falling month on month | People do not yet trust "walk away" |
| "Needs you" items per 1,000 products | Under 2 | Rules are missing; turn decisions into rules |
| Notification open-to-action rate | Over 70% | Notifications are noisy |
| Settings reverted within 24 hours | Under 10% | The preview or the labels mislead |
| Help opens per session | Falling | Labels are unclear |
| Undo use | Low and stable | Frequent undo means surprising outcomes |

### 13.4 Automated guards in CI

- Playwright flows for T2, T4, T5 and T6 count required actions and fail the build when a flow goes over its budget.
- Copy lint: no em dash, no vendor or model names on operator pages, reading grade 8 or lower, words from the word list.
- Accessibility: axe on every page. RTL screenshot test for every page. Visual regression on the digest and Home.

## 14. Best-in-class products to learn from

| Product | What exactly to take | What not to take |
|---|---|---|
| Google Photos | Upload and walk away: backup runs in the background, groups by itself, and only tells you when something needs space or attention | Its endless feed; we need an end state ("Done") |
| Stripe Dashboard | Settings with clear sources and history; the Radar rules **backtest** ("how many past payments would this rule have affected") as our settings preview; test mode as a future "practice batch"; money shown with currency and fee breakdowns | Its density for developers |
| Linear | A small, fixed status vocabulary; instant interactions (the screen updates before the server answers); Ctrl+K command search; an inbox that only holds things you must act on | Issue-tracker jargon |
| Vercel | One status line per deployment with details folded; instant rollback as our one-click revert; preview before going live | Developer-only wording |
| Shopify admin and its Polaris design system | Merchant-friendly copy rules; empty states that say what to do; how the design system is documented (component, when to use, content guidelines) | Its many settings pages per feature |
| Wise and Monzo | Plain, honest money words; every cost explained ("How this is counted"); notifications only when money moves | Consumer playfulness |
| Things 3 | Calm visual design, generous space, one satisfying moment on completion | Hidden gestures |
| Airbnb | Photography as the hero; image-first cards; strong right-to-left support in its design language | Marketing-style layouts |
| Careem | Arabic and English done properly in the Gulf: bilingual typography, mirrored layouts, mixed-language text that never breaks | Its super-app navigation |
| Atlassian Statuspage | A one-sentence health line ("All systems operational") as the top of our Ops page | Many component rows |
| Gmail | Undo Send, as our 10-second undo on every change | Its settings sprawl |

## 15. UX build slices

| # | Slice (one worker, one worktree) | Depends on | Acceptance test |
|---|---|---|---|
| UX1 | Tokens and fonts: add `--well`, `--focus`, `--selected`; tabular figures; Arabic font; logical CSS properties pass | Decision U1 | RTL screenshot test passes on today's pages; contrast checks pass |
| UX2 | Status vocabulary and copy lint in CI; replace `Badge` with StatusWord; local times | none | Lint fails on a planted vendor name and an em dash |
| UX3 | DropZone page replacing the four-step wizard | M1 self-advancing wizard | T1 and T2 budgets met by the Playwright guard |
| UX4 | Digest tab and digest email | M1 one digest | T3 five-second test passes with 5 people |
| UX5 | NeedsYouCard and "make it a rule" | M1, M12-F1 | T4 passes |
| UX6 | Settings components (SettingRow, ImpactPreview, VersionHistory, ProposalCard) | M12-S1 to M12-S3 | T6 and T10 pass |
| UX7 | Product page: ChannelGallery, BilingualText, ChannelPreview, ImageCompare | M0, M8 | T5 and T9 pass |
| UX8 | Results page: ExperimentCard, EstimateBar, TrendLine | M4 | T7 passes |
| UX9 | Notification centre, email templates, quiet hours | M12 notifications settings | No notification sent for a self-fixed event in a test batch |
| UX10 | Accessibility pass and mobile pass | UX1 to UX9 | axe clean; NVDA pass; 360 px pass |

## 16. Open questions

| # | Question | Recommended default |
|---|---|---|
| U1 | Move body text from Raleway to IBM Plex Sans with IBM Plex Sans Arabic? | Yes; keep Spectral for English headings |
| U2 | Rename the product from "Catalog images" to "Catalog"? | Yes, because it now covers text, extras and results |
| U3 | Full Arabic interface now, or only Arabic content previews? | Content previews now; full Arabic interface with self-serve |
| U4 | Deadline before a "needs you" item keeps its safe default | 48 hours |
| U5 | Team chat channel for incidents: Slack or Google Chat? | Whichever the Opptra team uses daily; email until then |
| U6 | Who runs the monthly usability round? | The catalog lead with a written script from this file |
| U7 | Should the drop zone accept uploads straight from a brand's shared drive link? | Yes, as a pasted link (M1 any-shape upload) |

## Sources

- `module-map.md`, `brief-v1.md`, `intents.json`, `00-template.md` settled decisions.
- `C:\Users\Sujan Ajay\Desktop\catalog-module\.runs\2026-11-02-competitors-visual.md`, `-competitors-listing.md`,
  `-competitors-measurement.md` (what competitors make people do: accept every item, review layers).
- Old initiatives `04`, `05`, `07` in `C:\Users\Sujan Ajay\Desktop\catalog-module-wt\initiative-requirements\` (copy
  sentences, Brand DNA page, the "Needs me" pattern being cut).
- Current app: `apps/web/app/layout.tsx`, `app/globals.css`, `app/fonts.ts`, `components/` (inventory above),
  `lib/catalog/copy.ts`; prototype `docs/prototype/catalog-prototype.html` and `docs/prototype/README.md`.

## 17. Integration decisions (2026-11-02)

| # | Decision | Why |
|---|---|---|
| D1 | Default channels come from the brand's setting, then M0 listings (M1-F2-R4 changed to match 5.2) | M1 used "the brand's previous batch" |
| D2 | The four answer words in 5.6 are for one experiment's readout (M4-F8); M10's "What we know" grid keeps its five-word scale, always under its own heading | Two vocabularies for results |
| D3 | The 10-second start countdown (M1-F2-R6) is not a required action and fits the 0-actions-after-drop budget | Checked against 5.1 |
| D4 | Open questions answered: U1 move body text to IBM Plex Sans and Plex Sans Arabic (yes; Raleway has no Arabic); U2 rename "Catalog images" to "Catalog" (yes); U3 Arabic content previews now, full Arabic UI with self-serve; U4 48 hours before a "needs you" item keeps its safe default; U5 email until the team names its chat tool; U6 the catalog lead runs the monthly usability round; U7 brand drive links accepted as pasted links | Design and process defaults with no business, legal or money stake |
| D5 | UX2: the copy lint is a set of ESLint rules (`lint/copy-rules.mjs`, wired in `eslint.config.mjs`), so it runs in `pnpm lint`, which CI already runs; `ci.yml` is not changed | One lint command; no new CI step on a hot file |
| D6 | UX2: `copy/no-em-dash` covers every linted file; `copy/no-vendor-names`, `copy/word-list` and `copy/reading-grade` cover operator copy (`apps/web` app, components and lib, plus the core copy files `test/no-model-names.test.ts` reads). The admin Ops page may name vendors (rule 2). Copy is JSX text, the title, alt, placeholder and aria-label attributes, and string and template literals; imports, log calls, SQL, object keys, comparisons and other attributes are engineering text. Reading grade is measured only on copy of 10 words or more | Short labels give no stable grade; code values are not copy |
| D7 | UX2: copy written before the lint that breaks the word list (85 places) or reading grade (17) is listed per file in `eslint-suppressions.json` (ESLint bulk suppressions); new copy must pass. Fix it as each screen is rebuilt (UX3 onwards) and run `pnpm exec eslint . --prune-suppressions`. Em dashes and vendor names have no suppressions | Rewriting every screen's copy belongs to the slices that rebuild those screens |
| D8 | UX2: times show as "4 Nov 2026, 15:30 IST" in the browser's time zone (`LocalTime`); the server render and first paint show UTC, labelled "UTC", until the browser knows its zone. Asia/Kolkata reads IST, Asia/Dubai and Asia/Muscat read GST, any other zone its offset ("GMT+3") | The server cannot know the person's zone |
| D9 | UX2: StatusWord shows the section 4 words with an icon and colour; its title is the meaning in plain words ("A person has to decide something, or some files could not be read" for "Needs you"). `Badge` was unused and is removed | Section 4's meaning column uses internal words |
