# Intake resilience: proposal

> Note 2026-10-27: F14 (the finished-collection email) was dropped by the owner; operators return to
> the dashboard (Your unfinished batches). Spec 14d ships without it.

Date: 2026-10-27. Status: proposal; the owner's decisions were made on 2026-10-27 (section 7). Build: live 5c48d85 (origin/main).
Companion specs: the parent `docs/specs/14-intake-resilience.md` and one executable spec per release,
`docs/specs/14a-intake-release-a.md` to `docs/specs/14d-intake-release-d.md` (each run on its own per
`docs/specs/00-execution-protocol.md`).

Scope: everything from an operator pressing "New batch" until the batch is started, plus how they find,
understand and resume an unfinished batch. The processing pipeline after Start is out of scope and is
not changed. The core product stays the same: one brand per batch, drop photos or paste links, check
what we found, pick marketplaces, start.

Evidence (all in the main checkout's `.runs/` folder; short names used in citations below):

| Short name | File | What it is |
|---|---|---|
| b574 | `2026-10-27-batch-574f2025.md` | The operator's first attempt (uploaded xlsx) |
| baefb | `2026-10-27-batch-aefb3a0f.md` | Second attempt (pasted links from a spreadsheet) |
| b09dd | `2026-10-27-batch-09dd86f2.md` | Third attempt (Google Sheet) |
| db | `2026-10-27-intake-db-behaviour.md` | Read-only database facts about every batch ever made |
| paths | `2026-10-27-intake-paths.md` | Code walk of every intake route, 62 failure modes with file:line |
| ux | `2026-10-27-intake-ux.md` | Live screenshots, local reproduction of all five failures, copy audit |

File:line references are to the live build 5c48d85. `ingest/` means `packages/core/src/catalog/ingest/`,
`web/` means `apps/web/`.

---

## 1. Bottom line (one screen)

Plain words first. A "batch" is one delivery of photos for one brand. The "wizard" is the four-step
screen that builds a batch (files, check, marketplaces, start). A "draft" is a batch that exists but
has not been started. "Collection" is the system downloading or reading the photos; "grouping" is the
system sorting them into products.

**What is broken.** On 2026-10-26 the first real operator tried to deliver one set of 287 bags (1,400
photos) three times and never got to Start:

1. They uploaded an Excel sheet of photo links. The screen crashed to a blank "Application error" page
   the moment they pressed Continue. The system kept working behind the crash and had everything ready
   17 minutes later, but nothing on any screen lets anyone get back into that batch (b574).
2. They pasted the same links straight from the spreadsheet (one row per product, five links per row).
   The screen said "287 image links" and accepted it. The system glued each row's links into one broken
   address, every download failed, and the batch failed with "No photos were found in what you
   uploaded. 287 other files." Nothing was uploaded, the photos were real, and the true reason was saved
   but never shown. When they tried to paste again, the screen said the batch "has already started"
   (baefb).
3. They pasted a Google Sheet link. This route works, but for 17 minutes the screen showed one fixed
   sentence with no count, no progress and no time. They left about a minute after it quietly became
   ready. Again, no way back in (b09dd).

These are not three unrelated bugs. The database shows the same pattern for everyone who has ever used
intake: uploaded spreadsheets started 0 of 2 times, pasted links 0 of 1, while uploaded photos started
47 of 58 and Google Sheets 8 of 10. 14 batches sit as drafts; none was ever resumed, because none can
be. People abandon and redo within minutes (db, headline 2 and 3).

**What operators actually do.** They bring a spreadsheet of links in whatever shape they already have.
They retry instead of waiting. They leave and come back. They try several routes for the same list.
All of that is reasonable. The product treats each of those behaviours as an error.

**What we propose.** Eight principles (section 3) and fourteen fixes (section 5) that make intake
accommodate those behaviours instead of fighting them. The eight fixes marked "must fix" close the
gaps the operator hit: a sheet upload never crashes the screen; a pasted grid is understood (or
explained) before anything runs; a wrong paste or file can be corrected without duplicates; every
unfinished batch can be found and resumed from the list; a batch that failed before Start can be fixed
in place; every failed link says which row, why, and what to do; every wait shows a count and an honest
time; and no screen says something false (for example that a draft "started" or that processing
"starts by itself").

**What it changes for operators.** The same four steps. The batch is remembered by the server, not by
the browser tab, so closing the tab, a crash or a reload loses nothing: the batch can always be opened
again and continued at the right step, and the batch list shows "Your unfinished batches" with a
Continue button. Pasting a grid copied from a spreadsheet just works, and the screen says back what it
understood ("287 rows, 1,400 links, 4 to 5 per row; this paste has no product code column, so products
will be named from the photo file names") before anything runs. Failures are listed by row and link
with the reason and the next step. Long waits show "Downloading photos 612 of 1,400, about 7 min left"
and say plainly whether the operator may leave.

**What the owner decided.** The five decisions of section 7 were made on 2026-10-27: the small
database migration is allowed, drafts expire after 14 days, the BHPC key is asked of the operator
once, the must set and the order A, B, C, D are approved, and the creator gets an email when a long
collection finishes (F14, in PR D). One one-time Google Workspace step for F14 remains with the
owner. Until the first fix ships, section 7 also recommends one thing to tell the operator.

---

## 2. What operators actually do

Everything here comes from the database and the three attempts. One caveat applies to all of it: only
one real operator has ever used intake, on one evening, and most of the other patterns come from the
owner's own testing (db, section 5 item 7). The behaviours are nevertheless ordinary human behaviours,
and the fixes are worth making even if the next operator is different.

### 2.1 They bring a spreadsheet of links in whatever shape they have

- The operator's source of truth was an item master workbook: 326 rows, 31 columns, identifier in
  column E ("Option Id"), five photo-link columns Z to AD (db, section 1 uploads table). That is the
  shape a merchandiser has. They uploaded it as is (b574), then copied the link block out of it and
  pasted it (baefb: 271 rows with 5 cells, 16 with 4 cells, 19 cells holding a literal `0` where the
  spreadsheet was blank), then put it into a Google Sheet (b09dd).
- Some photo file names contain a space (`BHSS2620Z-WHITE NAVY_1.JPG`), so a link can contain a space
  and still be one link (baefb).
- Both people who ever uploaded an xlsx abandoned it and switched to a Google Sheet within minutes
  (db, Drafts: 7d72112c then b8a99c1b; 574f2025 then 09dd86f2).
- Uploaded photos arrive clean: every source image ever stored is a JPEG; HEIC, PNG, csv and xls have
  never been uploaded; the reject paths for bad files have never fired in production (db, section 4).
  The only 287 rejects ever were caused by our parser.

### 2.2 They retry instead of waiting

- After the paste failed, the operator pasted again into the same batch within two minutes and got
  409 "already started", twice (baefb timeline 18:57:44 and 18:57:55).
- All three pre-start failures ever were followed by a new batch within 10 minutes; 13 of 14 drafts
  have a later batch by the same person for the same brand, 10 of those within 10 minutes (db,
  headline 3). The median gap is about 3.5 minutes (db, Repeat attempts).
- No batch has ever been started more than 30 minutes after it was created. When people start, they do
  it within a minute or two; a batch not started by then is effectively never started (db,
  Created-to-started).

### 2.3 They leave and come back

- The operator opened the batch page of 09dd86f2 in a second tab while it was collecting, saw a count
  there ("N of M files copied from your links"), went back and forth between the list, the failed batch
  and the new wizard, and closed the wizard tab about a minute after it became ready (b09dd timeline
  19:08 to 19:18).
- Apart from the two 17-minute collections, a draft's last update came 0 to 8 minutes after it was
  created. People leave within minutes (db, Drafts).
- Drafts never expire and nothing can resume them: 14 drafts hold 601 product links and 2,925 source
  photos, including two copies of 8.4 GB of raw photos (db, section 5 item 3).

### 2.4 They try several routes for the same list

- Three routes in five minutes for one list: file upload at 18:54, paste at 18:55, Google Sheet at
  18:59 (b574, baefb, b09dd).
- The two drafts that resulted hold the same 1,400 photos (1,390 of 1,390 distinct hashes shared)
  under two different product keys, because the xlsx used "Option Id" and the Google Sheet used
  "Unicommerce Code" (284 of 287 identifiers differ only by an `_OD` suffix). If both had been started
  the catalog would hold 287 duplicate products. Nothing at intake warns about it (db, headline 5).

### 2.5 What this tells us

The operator did nothing wrong at any point. Every failure was ours: a crash, a parser, a hidden
reason, a missing way back, a silent wait. The product currently assumes an operator who prepares
input in our exact shape, waits patiently in one tab, never retries and never leaves. Real people do
the opposite, and the design has to start from that.

---

## 3. Principles

The brief proposed a starting set. Each was tested against the evidence; where the evidence asked for
more, the principle was refined. The result is seven principles plus one cross-cutting test (P8). They
are also, in most cases, promises
`docs/SPEC.md` and `docs/specs/04-ingestion.md` already make ("nothing is dropped silently",
"detection never guesses", "an item whose raw object already exists with the same sha256 is skipped",
"a URL that fails to fetch is reported by row and column"). The gap is between the promise and the
screen.

**P1. Any reasonable input shape is understood, or clearly refused, before work starts, and the system
says back what it understood.** Justification: the operator's three inputs were all the same list in
three ordinary shapes; one crashed, one was silently mangled, one worked. The addition ("says back what
it understood") comes from 00 section 12 item 8 (confirm the grouping on a sample before a large run)
and from baefb: the paste step said "287 image links", which was true of the line count and false of
the content. A readback such as "287 rows, 1,400 links, 4 to 5 per row, products named from the file
names" would have exposed the parser bug at paste time.

**P2. Nothing is silently lost and nothing is silently invented.** Lost: shot 1 of every pasted row
(baefb), Drive files over 40 MB (paths #52), later rows of a duplicate identifier (paths #43), a
product's failed links (paths #28). Invented: a product named after a full URL (ux, repro b2), a
"started" time on a batch that never started (ux, section 6), 287 "other files" that were links.
Refinement: this includes duplicates. The same photos under two keys in two drafts (db, headline 5)
is an invention the catalog would not survive.

**P3. The batch, not the browser tab, is the unit of work.** This principle is new; it underlies
resume. Today the batch id lives only in React state (`web/components/catalog/CatalogWizard.tsx:25`),
so every interruption (crash, reload, Back, session expiry, closing the tab) orphans the batch (paths
#53). The server already knows everything: every wizard API takes a batch id (paths, section 5, "Direct
API by id"). The tab must be a window onto the batch, never its owner.

**P4. Every wait shows real progress and an honest time, and says whether the operator may leave and
where to find the batch when they return.** The counts already exist and are already polled every
2.5 s by the wizard (b09dd, "Contributing product issues" 1; ux, repro c); the wizard throws them away on
steps 2 and 3. The second half is the refinement: "Processing starts by itself. You can close this
page." (`web/lib/catalog/copy.ts:65-67`) is false for a draft and is the single worst sentence in
intake, because it invites exactly the behaviour (leaving) that the product cannot survive.

**P5. Every failure says what failed, for which rows or files, why, and what to do next, and the
system retries transient failures itself before asking a person.** The reason for each of the 287
failed links was computed and stored ("<url> did not return an image (got 404)") and shown nowhere
(baefb, root cause 7). A 429 or 5xx is cached in the manifest and never retried, not even by "Try again"
(paths #29). The second half is the refinement: operators retry instead of waiting (2.2), so the
system should absorb ordinary transient failures itself and present only the ones that need a human.

**P6. Every unfinished batch can be found, understood and resumed from where it stopped.** Today a
draft is a grey pill in a flat table of 75 rows with no age, no readiness and no action; the batch page
says "Check what we found and start processing." with nothing to click (ux, sections 1 and 6). 14
drafts, 0 resumed (db).

**P7. A retry or correction never means starting from scratch and never creates duplicates.**
Editing a paste adds a second copy of every earlier link, which rejects the products as "two files
claim shot 1" (paths #23, ux step 1). "Start again" on a failed batch opens an empty wizard and throws
the collected bytes away (paths #61). Continue on step 2 re-copies every photo even when nothing
changed (paths #55). A grouping over 900 s strands the batch for ever (paths #58).

**P8 (cross-cutting). The screen never claims something false.** Listed separately because it is a
test, not a feature: every sentence in intake must be true in the state it is shown in. The copy audit
in ux rated 15 sentences; 13 fail it today (only "Upload failed. Try again." and the 10-minute stall
message pass).

---

## 4. Gap list: each principle against today

| Principle | Today | Evidence |
|---|---|---|
| P1 understood or refused, readback | Pasted text is split on the first tab only; multi-link rows are glued into one URL; a 2-column row makes a product named after a URL and drops shot 1; `0` and blank cells become part of file names; no shape check and no sample fetch at paste time, so a broken grid "looks fine" | baefb root cause 1 to 3; paths #20 to #22, #33, #34; ux repro b, b2; `ingest/url-list.ts:14-24`; `ingest/detect.ts:88-90` |
| | Sheet cells split only on `,` and `;`, so Alt+Enter or space-separated links are glued | paths #45; `ingest/links-sheet.ts:63-65` |
| | Any uploaded xlsx/xlsm/csv crashes step 2 (`sheets` state empty while the worker reads the file; `WizardStep2` reads `identifierColumn` of `undefined`); no `error.tsx`, so the page is a dead end | b574 root cause; paths #35, #36; ux repro a; `web/components/catalog/CatalogWizard.tsx:65-70`; `web/components/catalog/WizardStep2.tsx:15` |
| | Share-page links (Dropbox, OneDrive, Drive file links) are accepted as image links and fail later as "other files" | paths #25, route table "Not supported" |
| P2 nothing lost or invented | Shot 1 of every pasted multi-link row never fetched; failed links of a product leave shots missing with no step 4 warning; Drive rejects dropped when the worker rebuilds `detected`; duplicate photo across two products never reported (`duplicateFiles` stayed 0 while Tan variants carried the Black photos) | baefb; paths #28, #52; db section 1 "data problem we do not flag" |
| | A product named after a URL; "started <time>" on a draft; link 404s counted as `unsupportedFiles` | ux repro b2 and section 6; `web/app/catalog/[id]/page.tsx:93`; `ingest/index.ts:780` |
| | Same photos in two drafts under two keys; no warning | db headline 5 |
| P3 batch is the unit of work | Batch id only in React state; `/catalog/new` accepts only `?brand`; `?batch=` ignored; wizard steps are not in browser history; no `beforeunload`, no storage | paths #53, section 1.0 "Open"; ux repro d; `web/app/catalog/new/page.tsx:7-10`; `CatalogWizard.tsx:25` |
| P4 progress, time, may I leave | Steps 2 and 3 show a fixed sentence for the whole collection (17 min live) while the polled response carries "N of M"; step 4 is the only wizard place with a count; no ETA for collection anywhere; the grouping phase (5 min at 1,400 photos) is invisible: status is already `draft`, counts sit at 1400/1400, batch page shows "Draft" with 0 products, no auto-refresh and no stall check | b09dd; paths #48, #56, section 4; ux repro c; `CatalogWizard.tsx:146,148`; `pipeline/status.ts:67-70`; `ingest/index.ts:396-408` |
| | "Processing starts by itself. You can close this page." shown while collecting; false | paths #54; `web/lib/catalog/copy.ts:65-67` |
| | Step 2 while collecting shows "0 of 0 products", "0 JPG", "No action needed" as if results | ux section 4 |
| P5 failures named, transient retried | Per-link reasons stored but never shown; no "link" reject class, so links are "other files" / "unsupported files"; fail sentence says "uploaded" for a paste and "Upload photos" as the fix; step 2 lists the last cell of each row as a "file that cannot be read" | baefb root cause 7, "Is the message clear"; paths #27; ux copy audit |
| | Transient errors (429, 5xx, timeout) stored in the manifest and reused by every later run including Try again and regroup; no retry inside the run | paths #29, #30; `ingest/index.ts:345-349` |
| | Platform 502/504 HTML shown as a raw JSON parse error | paths #57; `web/components/catalog/wizard-client.ts:9-10` |
| | 409 "This batch has already started" for a failed batch and for a collecting one | baefb; paths #10, #31; `web/lib/catalog/batches.ts:16-19` |
| P6 find, understand, resume | List: flat table, no filter, "Draft" with no age, readiness or action; two batches named "BHPC bags"; State column off-screen on a phone; brand page shows no batches; batch page for a draft has an instruction and no button; failed batch page loses inputs | ux sections 1, 2, 6, 7; `web/app/catalog/[id]/page.tsx:97-100` |
| | Sweep never touches drafts; drafts never expire; 14 drafts, 12 untouched for over 4 days | paths #62; db Drafts; `apps/worker/src/catalog/sweep.ts:17` |
| P7 no restart, no duplicates | Editing or appending the paste adds a second `url_list` row keyed by the full text; the old one stays; clearing the box removes nothing; no Remove for files or pastes; an upload whose signed URL expired (900 s) can never be retried and blocks Continue | paths #2, #3, #23, #24; ux step 1; `web/lib/catalog/links.ts:27-29`; `web/components/catalog/Uploader.tsx:46-51`; `packages/core/src/storage.ts:53` |
| | Step 2 Continue always regroups and re-copies every photo to `raw/` (spec 04 promised a sha256 skip) | paths #55; `web/lib/catalog/preview.ts:25-53`; `ingest/index.ts:631-635,744` |
| | A grouping phase over 900 s is killed without giving the claim back: draft, never ready, never stalled, never swept | paths #58; `ingest/index.ts:396-415` |
| | "Start again" on a failed batch opens an empty wizard; collected bytes not reused; re-paste refused | paths #61; ux section 7 |
| | Over about 1,900 loose files the hand-off exceeds the 300 s web request limit | paths #8 |
| P8 never false | 13 of the 15 audited sentences fail: draft "started", "Processing starts by itself", "No photos in this batch yet" on a draft with 1,400 photos, Links sheet tab reading as a finished result, "already started", "287 other files", "0 JPG / No action needed", and others | ux copy audit |

---

## 5. Ranked fix list

Size is relative (S, M, L) and compares effort between the fixes only; no time or money estimates.
"Must" means: fix before the next operator uses intake. Dependencies name other fixes. Each fix is
specified in full in the release spec named (14a to 14d, one file per PR, section numbers given). The
PR each part ships in is named; the full
order is under "Must-fix set and order" below.

### F1. A sheet upload never crashes the screen (must, S, PR A) - spec 14a section 3.1

- Problem: any uploaded xlsx/xlsm/csv throws in step 2 and the whole page becomes "Application error"
  with no way back (b574; paths #35, #36).
- Fix: `loadDetected` fills the `sheets` state whatever `previewReady` is; `WizardStep2` never assumes
  a choice exists; a sheet that is not read yet is reported as "Reading your sheet" instead of "cannot
  read"; an `error.tsx` under `/catalog` gives any future crash a message and a way out; a browser test
  covers an xlsx upload through step 2.
- Operator sees: step 2 renders at once with "Reading your sheet. The columns will appear here when
  it has been read." and then the column sentence. A crash anywhere in `/catalog` shows "Something went
  wrong on our side." When the page knows which batch it was on, it adds "Your batch is safe; nothing
  was lost." with "Open this batch"; it always offers "All batches" and "Try this page again".
- Risk: low; it is a guard and a state fill. Dependencies: none.

### F2. A pasted grid is understood, and the screen says back what it understood (must, M, PR B) - spec 14b section 3.1

- Problem: multi-link rows glued into one URL; URL used as identifier; `0` cells; no shape check
  (baefb; paths #20 to #22, #34, #45; ux repro b, b2).
- Fix: one table parser for pasted text. A cell is a link when it starts with `http://` or `https://`;
  a link may contain spaces (they are encoded before download), and a cell is split only where another
  link starts, never inside a link. The first non-link cell of a row is its identifier; `0`, blank and
  other non-link cells are ignored. Each row is named on its own: a row with an identifier is named by
  it; a row with two or more links and no identifier is one product named from its first link's file
  name (for example BH-4610-NE-NERO from `BH-4610-NE-NERO_1.JPG`); single-link rows keep today's
  grouping by file name. Google Sheet cells use the same split rule, so the working Google Sheet route
  keeps working for names with spaces. At paste time the server returns a readback: rows, links, links
  per row, how products will be named, any rows that would get the same name (by row number), and the
  result of a small check of the first three links (the first 1 KB of each, through the same safe
  download path the worker uses). While the check runs, the box shows "Checking your links..." and
  Continue stays available. No list of refused websites: when a checked link turns out to be a web
  page, the readback says so.
- Operator sees: "287 rows, 1,400 links (4 to 5 per row). This paste has no product code column, so
  products will be named from the photo file names, for example BH-4610-NE-NERO. To name them
  yourself, copy the product code column in as the first column. We opened the first 3 links: all
  fine." If two rows would get the same name: "Rows 12 and 40 would get the same name, BH-4610-NE-NERO.
  Check those rows before you continue." If the links are share pages: "These look like share pages,
  not image links. Download the photos and drop them here, or paste direct image links."
- Risk: medium; the parser touches every paste and the Google Sheet route. Mitigated by replaying the
  real aefb3a0f shape, including file names with a space, as fixtures for paste, Google Sheet and xlsx
  (spec 14 section 8.1). Dependencies: none (F5 improves the failure path when links still fail).

### F3. A wrong paste or file can be corrected without duplicates (must, M, PR B) - spec 14b section 3.2

- Problem: edits and appends to the paste box add a second upload; clearing removes nothing; files
  cannot be removed; a failed upload after 15 minutes can never be retried and blocks Continue
  (paths #2, #3, #23, #24; ux step 1).
- Fix: the paste box is one input bound to one `url_list` upload row (keyed by upload id, not by text):
  editing replaces, clearing removes. Every file row and every pasted link row has Remove. Retry
  re-plans the upload (fresh signed URL) when the plan is older than its lifetime. The wizard shows
  every input the batch holds, including inputs added in an earlier session. A file whose upload was
  cut off (the tab was closed mid-upload) says so and can be removed.
- Operator sees: a list of what the batch holds, each with Remove; editing the paste changes the
  count in place; a file cut off by a closed tab reads "Upload did not finish. Add the file again or
  remove it."; Continue is never blocked by a row they cannot act on.
- Risk: low to medium. Removing an upload needs a delete route and a state for "removed" (section 7,
  decision 1, decided yes; the migration ships in PR B). Dependencies: F4 (way back, PR A) for inputs from an
  earlier session.

### F4. Every unfinished batch can be found and resumed (must, M, PR A and PR C) - spec 14a section 3.4 and 14c section 3.1

- Problem: batch id in browser memory only; `?batch=` ignored; drafts unreachable; no age, state or
  action in the list; no cancel (paths #53, #62; ux sections 1, 6; db Drafts).
- Fix, part 1, the way back (PR A): the wizard writes `?batch=<id>` into the address bar as soon as the
  batch exists (the first file or paste). `/catalog/new?batch=<id>` opens the wizard for a draft or a
  collecting batch at the step the batch is in: step 1 while inputs are pending or missing; step 2
  while collecting, placing, waiting for a column, or ready with no marketplaces; step 4 once
  marketplaces are chosen (step 3 is reached from step 2 by Continue). Any other batch (failed,
  cancelled, started) goes to its batch page instead. The batch page of a draft carries "Continue
  setting up". The batch list already links every row to its batch page, so a batch can always be
  found from the list.
- Fix, part 2, the unfinished list (PR C): the list gets a "Your unfinished batches" section at the top
  with state words ("Downloading photos 612 of 1,400", "Ready to check", "Needs your input: which
  column holds the identifier?", "3 files did not finish uploading", "Could not start: <reason>"), age,
  Continue and Cancel. A batch that failed before Start shows "Fix and continue" instead of Continue
  (F8). Viewers see the section without the buttons. Cancel marks the batch cancelled and hides it from
  the default list; the worker can never bring a cancelled batch back to life. Also in PR C, moved here
  from F7 because a returning operator must not wait for a full re-copy: placing a photo skips the copy
  when the same photo is already there, and Continue on step 2 with nothing changed returns at once.
- Operator sees: after a crash, reload or a day away, the address bar or the batch page brings them
  back to the right step (PR A); from PR C the list says "Your unfinished batches: BHPC bags, Test
  Brand, ready to check, created 2 hours ago [Continue] [Cancel]".
- Risk: medium; the wizard must initialise from server state instead of from its own memory, which is
  the biggest change to the wizard and is why it comes first. Dependencies: F1 (step 2 must render from
  server state).

### F5. Every failed link says which row, why, and what to do (must for the visible part, M, PR B; automatic retry should, PR D) - spec 14b section 3.3 and 14d section 3.2

- Problem: reasons hidden; links mislabelled as files; transient errors cached for ever; wrong fix
  suggested (baefb; paths #27 to #30).
- Fix, visible part (must, PR B): a `link` reject class with the row, column, status and the URL;
  `counts.linkFailures` separate from `unsupportedFiles`; step 2 and step 4 list link failures
  separately from unreadable files, with the first examples and a "show all" table; the no-photos
  sentence names links as links and gives the real next step. "Try the failed links again" re-fetches
  only the failed links, also on a batch that failed before Start, and is shown only when some of the
  failures may be temporary (a timeout, a busy server); when every failure is permanent (not found,
  refused, not an image) the sentence sends the operator to fix the links instead.
- Fix, automatic retry (should, PR D): temporary failures are retried inside the run with backoff;
  later deliveries of the same run never re-fetch them; only a new run tries them again; after a total
  number of attempts across runs a link is stored as failed with its reason. A time budget per delivery
  keeps a slow host from pushing a delivery past the 900 s limit.
- Operator sees: "No photos could be downloaded from the 287 links you pasted. 287 answered 'not found'
  (404), for example <url> (row 1, column 2). Check that the links open in a browser, then press Fix
  and continue and paste the corrected links." Or, for a partial failure with temporary causes: "12 of
  1,400 links could not be downloaded (3 products affected). [Try the failed links again] [Show all
  12]". After PR D the card adds how many times temporary problems were tried.
- Risk: medium; the retry must not turn a dead host into a very long run (bounded attempts, bounded
  time per item), which is why it is a separate, later part. Dependencies: F2 for row and column
  numbers on pastes; F8 for the "Fix and continue" button (until PR C ships, the all-permanent sentence
  says to make a new batch with the corrected links).

### F6. Every intake wait shows a count, a phase and an honest time; the copy tells the truth about leaving (must, M, PR A and PR C) - spec 14a section 3.3 and 14c section 3.2

- Problem: fixed sentence for 17 minutes; grouping invisible; false "you can close this page"; no
  ETA (b09dd; paths #48, #54, #56; ux repro c).
- Fix: PR A replaces the fixed sentences on steps 2 and 3 with the count the wizard already polls, hides
  the step 2 cards while collecting instead of showing zeros, and replaces the false leaving sentence
  with one that is true in PR A: "You can close this page. Open this batch again from the batch list and
  press Continue setting up when it is ready." PR C adds the worker side: the batch carries
  `counts.phase` (`uploading | downloading | reading | unpacking | checking | placing | ready |
  needs_input`) and `counts.placed / placeTotal` for the placing phase; every intake screen (wizard
  steps 2 to 4, batch page, list row) shows the phase, the count and an estimate from the measured rate
  of this batch in the current phase only (the samples restart when the phase changes); the batch stays
  "collecting" until the preview is ready, under a renewable claim so a crashed placing is picked up
  again and a stall is detected; and the leaving line becomes "You can close this page. Find this batch
  under Your unfinished batches and press Continue when it is ready."
- Operator sees: "Downloading photos 612 of 1,400, about 7 min left", then "Placing photos 300 of
  1,400, about 4 min left", then the grouping.
- Risk: low to medium; the `phase` lives in the existing `counts` jsonb column (no migration). The
  estimate is honest only if the rate is measured, never fitted. Dependencies: F4 for the leaving copy;
  F7 for `placed` to move during placing (until F7's second part ships, the placing count moves only at
  the end).

### F7. Placing is resumable and never re-copies (should; must for batches over about 4,000 photos, L, PR C and PR D) - spec 14c section 3.3 and 14d section 3.1

- Problem: Continue on step 2 regroups and re-copies every photo (5 min at 1,400); a grouping over
  900 s strands the batch for ever; spec 04 already promised the sha256 skip (paths #55, #58).
- Fix, part 1 (must, PR C, shipped with F4): placing skips a photo that is already in place with the
  same sha256; Continue on step 2 with nothing changed returns at once without regrouping.
- Fix, part 2 (should, PR D): the grouping runs first and saves the planned list of shots (which
  product, which shot number, which source photo); placing then copies that list in budgeted chunks
  with self-continuation like collection, writing `counts.placed` after each chunk; the last chunk
  writes the photo rows and the preview. A change of options only on step 2 reruns the grouping and
  then the (now free) placing. A killed request is retried from where it stopped, and a stall is
  detected.
- Operator sees: Continue on step 2 is instant when nothing changed (PR C); a 10,000-photo links batch
  finishes instead of hanging (PR D).
- Risk: medium to high; this is the deepest change and touches the idempotency of ingest. Covered by
  the existing tier 2 ingest tests plus new ones (spec 14 section 8 and the release specs). Unproven: the grouping step alone at about
  2,000 products has not been measured against the 900 s limit; the builder measures it and reports.
  Dependencies: F6 (phase and counters).

### F8. A batch that failed before Start can be fixed in place (must, S, PR C) - spec 14c section 3.4

- Problem: "Start again" opens an empty wizard; re-paste gets 409; collected bytes wasted (paths #31,
  #61; baefb 18:57).
- Fix: a batch that failed before `startedAt` can be reopened as a draft ("Fix and continue"), keeping
  its name, product type and inputs; the 409 sentence distinguishes failed ("could not start"),
  collecting ("still collecting; wait or press Try again") and started. The failure reason is carried
  into step 1 so the operator sees what to change. The wizard never opens on a failed batch: "Fix and
  continue" (on the batch page and in the unfinished list) reopens it first, then opens step 1.
- Operator sees: on the failed batch page or in "Your unfinished batches", "Fix and continue" opens
  step 1 with the inputs listed, the reason above them and Remove on each.
- Risk: low; no new status (failed to draft is an allowed transition for never-started batches).
  Dependencies: F3, F4.

### F9. Draft and failed screens tell the truth (must for the copy, S, PR A) - spec 14a section 3.2

- Problem: "started <time>" on a draft; draft banner with no button; "No photos in this batch yet" on
  a draft holding 1,400; Links sheet tab reads as a finished result; empty "How this works" paragraph;
  "Start again" above the reason on phones; failed reason missing from the list; broken "No products
  of Test Brand match ." sentence (ux sections 1, 2, 6, 7).
- Fix: "created" for unstarted batches; channels omitted when empty; the draft banner carries the
  "Continue setting up" button (F4 part 1); Compare and Links sheet tabs for drafts say "This batch has
  not started. 1,400 photos found for 287 products; nothing has been made yet."; the list shows the
  reason on failed rows and keeps State visible on phones; the brand page's empty-search sentence is
  fixed.
- Risk: low. Dependencies: F4 part 1 for the button (same PR).

### F10. The same photos in another batch are flagged (should, M, PR D) - spec 14d section 3.3

- Problem: two drafts, same 1,390 photo hashes, different keys; no warning (db headline 5). Within
  a batch, two products carrying the same photo are never reported (db section 1).
- Fix: at grouping, compare the batch's sha256 set with the brand's other unfinished and failed
  batches and with live products (the existing `renameHints` already covers the live case); warn with
  the batch name (a link to that batch), age and the two identifier spellings; within a batch, warn
  when the same photo sits under two identifiers.
- Operator sees: "These photos are already in BHPC bags (created 5 minutes ago, not started) under
  different identifiers (BH-4610-NE_Black there, BH-4610-NE_Black_OD here). Continue that batch, or
  cancel it, before starting this one." with "BHPC bags" linking to that batch, and "10 photos appear
  under two products: BHSS26M10_Tan and BHSS26M10-BLACK share BHSS26M10-BLACK_1.JPG. Check the sheet."
- Risk: low to medium (a hash comparison over the brand's unfinished batches). Dependencies: F4
  (cancel), F6.

### F11. Platform errors and large hand-offs do not break the wizard (should, S, PR C and PR D) - spec 14c section 3.5 and 14d section 3.4

- Problem: a 502/504 HTML page becomes a raw JSON parse error; over about 1,900 loose files the
  hand-off exceeds the 300 s web request (paths #8, #57).
- Fix: `wizardApi` checks the response before parsing and shows "The server did not answer in time.
  Your files are safe. Reload this page to continue." (PR C). The hand-off is paged (PR D): the web
  request hands over the first page of uploads and queues one follow-up task, which hands over the next
  page and queues itself again until none remain, so one Continue is enough for any count.
- Risk: low. Dependencies: F4 (reload lands back in the batch).

### F12. Draft housekeeping and a trace per ingest delivery (should, S, PR D) - spec 14d section 3.5

- Problem: drafts never expire; a successful ingest leaves no log line with the batch id, so the two
  batch investigations had to tie worker requests to batches by timing (b574, b09dd; paths #62).
- Fix: the sweep cancels drafts untouched for N days (14 days; section 7, decision 2) with the
  state word "Expired" and the age; their stored photos are left alone; one INFO log line per ingest
  delivery with batch id, upload id, phase, done and total.
- Risk: low. Dependencies: F4 (the cancelled state).

### F13. Google and Drive edge cases (later, S) - spec 14 section 9

- Problem: re-pasting the same Google link after sharing does nothing; a Drive folder over 1 GiB is
  called fine at paste and refused at Continue without the reason; Drive rejects are lost (paths #37,
  #49, #50, #52).
- Fix: "Check again" re-runs the access check on the same text; the size check runs at paste time;
  the worker keeps `detected.rejected` from the web tier.
- Risk: low. Dependencies: none. Deferred because no operator has used Drive folders yet (db, section 3:
  `drive_folder` never used).

### F14. The creator is told when a long collection finishes (should, M, PR D, after PR C) - spec 14d section 3.6

- Problem: no batch was ever started more than 30 minutes after it was created (2.2), and a
  collection can take 17 minutes (b09dd). An operator who leaves during a long collection is told
  where to find the batch, but nothing reminds them to come back. The product sends no mail today; the
  alert emails of `infra/monitoring.sh` go through a Cloud Monitoring email channel to a fixed address
  and are not meant for per-user mail.
- Fix: when a collection that ran longer than a threshold (5 minutes, worker env) reaches "ready to
  check", "needs your input" or "could not start", the worker sends one plain-text email to the
  batch's creator with a link to the batch, once per collection (an atomic claim in `counts`, so
  retries never send twice). It sends through the Gmail API from one company mailbox, using Google
  Workspace domain-wide delegation with keyless signing: the worker's own service account signs the
  token request through the IAM Service Account Credentials API, so there is no key and no secret
  anywhere. A new idempotent `infra/notify.sh` enables the two APIs and lets the worker sign for
  itself. A mail error is logged and never touches the batch. With no sender configured the feature
  is off, so PR D ships before the setup is done.
- Operator sees: an email such as "BHPC bags is ready to check" with "Your batch BHPC bags for Test
  Brand has finished collecting: 1,400 photos for 287 products. Nothing has been processed yet. Open it
  and press Continue setting up to check the grouping, choose marketplaces and start: <link>". No model
  names, no technical words.
- Owner prerequisite (one time): choose the sender mailbox (a licensed Workspace user, ideally a
  dedicated notifications mailbox), and have a Workspace super admin authorise the worker's client id
  (printed by `infra/notify.sh`) for the single scope `gmail.send` under domain-wide delegation in the
  Admin console. This is the single open item of PR D.
- Risk: low to medium. Domain-wide delegation could in principle act for any mailbox of the domain
  within the granted scope; mitigated by the single `gmail.send` scope, a code path that only ever
  uses the configured sender (unit-tested), and no key that could leak. Rejected routes: Cloud
  Monitoring channels (fixed recipients), the Workspace SMTP relay (static egress address or a
  password), a stored refresh token (a long-lived secret), third-party mail services (a new vendor and
  an API key). Dependencies: F6 worker side (the ready and needs-input phases), F8 ("Fix and
  continue"), F4 part 2 (cancelled batches never mail).

### Must-fix set and order

Before the next operator uses intake: F1, F2, F3, F4, F5 (visible part), F6, F8, F9. PR order A, B, C,
D (spec 14 section 7; approved, section 7 decision 4), one spec file per PR:

- PR A, truth and way back (`14a-intake-release-a.md`): F1, F9, the F6 copy and step 2 count, and F4 part 1 (the batch id in the
  address bar, `/catalog/new?batch=` for draft and collecting batches, "Continue setting up" on the
  batch page). Small, safe, deployable alone.
- PR B, inputs and failures (`14b-intake-release-b.md`): F2, F3, F5 visible part, and migration `0003_intake_states.sql` (decision
  1).
- PR C, resume and progress (`14c-intake-release-c.md`): F4 part 2 ("Your unfinished batches", Cancel), F6 worker side, F7 part 1
  (sha256 skip, instant Continue), F8, F11 response check.
- PR D (should, `14d-intake-release-d.md`): F7 part 2, F5 automatic retry, F10, F11 paged hand-off,
  F12, F14 (finished-collection email).
- Later: F13 (described in spec 14 section 9, deferred).

### How we will know

- The must set is done when the operator takes the real BHPC list (real brand, product key from
  decision 3) to Start on their own, without help.
- After the next two weeks of operator use, re-read the per-route start rates (uploaded sheets, pasted
  links, Google Sheets, photos) and the number of drafts resumed from the db report, and compare them
  with today's (sheets 0 of 2, pasted links 0 of 1, drafts resumed 0 of 14).

### What to do with the existing drafts (recommendation, not done)

- 574f2025 and 09dd86f2 (the operator's two BHPC drafts, Test Brand): they are technical tests on the
  test brand, and the real BHPC delivery will run on the real brand after the fixes. Recommended: cancel
  both through the Cancel action once PR C ships, after telling the operator, then clean their
  `catalog-test/` prefixes once with the existing test cleanup (`deleteTestObjects`). Do not start
  either: they carry different product keys (Option Id against Unicommerce Code) and the right key for
  BHPC is an operator decision that has to be made once, before the real batch (section 7, decision 3).
- aefb3a0f (failed): leave as is until F8 ships (PR C), then cancel. It is useful evidence until then.
- The 12 older drafts (owner's tests, 2026-10-19 to 10-21) and 47f98f2a (the only real draft, puma, 5
  photos, superseded 3 minutes later by a finished batch): cancel through the same action. No manual
  database writes; the action is the way, so the first use of Cancel is on batches nobody needs.
- Bytes: a cancelled draft keeps its objects (the existing 180-day raw lifecycle applies). The only
  exception is the one-off cleanup of the two BHPC test drafts above (2 x 8.4 GB under
  `catalog-test/`, where test cleanup is allowed by the repo rules).

---

## 6. Non-goals

- No change to processing after Start (matting, render, QA, publish, sheets, re-check).
- No change to the core flow: four steps, one brand per batch, no stored defaults, channels chosen
  fresh every batch (SPEC.md non-goals).
- No new input routes (Dropbox, OneDrive, WeTransfer APIs); a share page is explained with a clear
  sentence and the existing alternative (download and drop).
- No resumable or chunked browser uploads (paths #4); a big zip on a flaky line still restarts.
- No language model anywhere in intake (SPEC.md: grouping, counting and column detection are
  deterministic code).
- No model names or technical settings in any new sentence.
- No change to the identifier rules, precedence rules or sheet column detection of spec 04, except
  the cell split (F2) and the readback.
- No automatic merging of the two BHPC drafts; a person chooses the key.

---

## 7. Owner decisions (decided 2026-10-27)

The five questions this proposal put to the owner, with the owner's answers. All are recorded as
decided in spec 14 (parent, section 11).

1. **One small migration, yes or no?** Decided: **yes**. F3 (an upload removed from a batch) and F4 (a
   cancelled draft) use two new status values, `removed` on `catalog_uploads` and `cancelled` on
   `catalog_batches`. Both columns are text with a CHECK constraint
   (`packages/core/src/db/schema.ts:237,256,275,283`), so the new values come with migration
   `0003_intake_states.sql`, shipped in PR B (14b section 4.1), where `removed` is first used. 00
   section 11 says only specs 02 and 03 ship migrations; `0002_cost_events.sql` (PR #90) already
   shipped outside them with the owner's approval, and this one is approved the same way. The
   no-migration alternative (hard-deleting removed uploads, marking cancellation inside `options`) was
   rejected and is not built.
2. **Draft expiry: after how many days does the sweep cancel an untouched draft?** Decided: **14
   days**. Expired drafts keep their photos until the existing 180-day raw lifecycle.
3. **BHPC product key.** Decided: **as recommended**. Before any real BHPC batch, the operator is asked
   once whether the product identifier is "Option Id" (`BH-4610-NE_Black`) or "Unicommerce Code"
   (`BH-4610-NE_Black_OD`), and the answer is recorded in the brand's notes. Both test drafts are
   cancelled either way (14c section 9).
4. **Approve the must-fix set (F1, F2, F3, F4, F5 visible part, F6, F8, F9) and the PR order A, B, C,
   D (section 5)?** Decided: **approved**. Each release is built and shipped on its own from its spec
   file (14a to 14d).
5. **Should the system tell the operator when a long collection finishes?** Decided: **yes**, as a
   should-fix in PR D, after PR C: F14 (section 5). The product gains its first outgoing message: one
   email from a company mailbox to the person who created the batch. Its one-time Google Workspace step
   by the owner (14d section 3.6, "Prerequisite") is the single open item of PR D.

**Until PR A ships (interim, no build needed).** Recommended: tell the operator to use the Google Sheet
route (paste the Google Sheet link) and to keep the wizard tab open until step 2 shows the grouping.
That is the only route that works end to end today, and the open tab is today's only way back into
the batch.
