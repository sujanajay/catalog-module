# Intake resilience: proposal

Date: 2026-10-27. Status: proposal for the owner's decision. Build: live 5c48d85 (origin/main).
Companion spec: `docs/specs/14-intake-resilience.md` (executable, per `docs/specs/00-execution-protocol.md`).

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

1. She uploaded an Excel sheet of photo links. The screen crashed to a blank "Application error" page
   the moment she pressed Continue. The system kept working behind the crash and had everything ready
   17 minutes later, but nothing on any screen lets anyone get back into that batch (b574).
2. She pasted the same links straight from the spreadsheet (one row per product, five links per row).
   The screen said "287 image links" and accepted it. The system glued each row's links into one broken
   address, every download failed, and the batch failed with "No photos were found in what you
   uploaded. 287 other files." Nothing was uploaded, the photos were real, and the true reason was saved
   but never shown. When she tried to paste again, the screen said the batch "has already started"
   (baefb).
3. She pasted a Google Sheet link. This route works, but for 17 minutes the screen showed one fixed
   sentence with no count, no progress and no time. She left about a minute after it quietly became
   ready. Again, no way back in (b09dd).

These are not three unrelated bugs. The database shows the same pattern for everyone who has ever used
intake: uploaded spreadsheets started 0 of 2 times, pasted links 0 of 1, while uploaded photos started
47 of 58 and Google Sheets 8 of 10. 14 batches sit as drafts; none was ever resumed, because none can
be. People abandon and redo within minutes (db, headline 2 and 3).

**What operators actually do.** They bring a spreadsheet of links in whatever shape they already have.
They retry instead of waiting. They leave and come back. They try several routes for the same list.
All of that is reasonable. The product treats each of those behaviours as an error.

**What we propose.** Eight principles (section 3) and thirteen fixes (section 5) that make intake
accommodate those behaviours instead of fighting them. The seven fixes marked "must fix" close the
gaps the operator hit: a sheet upload never crashes the screen; a pasted grid is understood (or refused with a
reason) before anything runs; a wrong paste or file can be corrected without duplicates; every unfinished
batch can be found and resumed from the list; every failed link says which row, why, and what to do;
every wait shows a count and an honest time; and no screen says something false (for example that a
draft "started" or that processing "starts by itself").

**What it changes for operators.** The same four steps. The batch is remembered by the server, not by
the browser tab, so closing the tab, a crash or a reload loses nothing: the batch list shows "Your
unfinished batches" with a Continue button that opens the wizard at the right step. Pasting a grid
copied from a spreadsheet just works, and the screen says back what it understood ("287 rows, 1,400
links, 4 to 5 per row; products named from the file names") before anything runs. Failures are listed
by row and link with the reason and the next step. Long waits show "Downloading photos 612 of 1,400,
about 7 minutes left" and say plainly whether the operator may leave.

**What we need from the owner.** Four decisions in section 7 (one of them is whether a small database
migration is allowed; the protocol reserves migrations for specs 02 and 03, so it needs an explicit
yes).

---

## 2. What operators actually do

Everything here comes from the database and the three attempts. One caveat applies to all of it: only
one real operator has ever used intake, on one evening, and most of the other patterns come from the
owner's own testing (db, section 5 item 7). The behaviours are nevertheless ordinary human behaviours,
and the fixes are worth making even if the next operator is different.

### 2.1 They bring a spreadsheet of links in whatever shape they have

- The operator's source of truth was an item master workbook: 326 rows, 31 columns, identifier in
  column E ("Option Id"), five photo-link columns Z to AD (db, section 1 uploads table). That is the
  shape a merchandiser has. She uploaded it as is (b574), then copied the link block out of it and
  pasted it (baefb: 271 rows with 5 cells, 16 with 4 cells, 19 cells holding a literal `0` where the
  spreadsheet was blank), then put it into a Google Sheet (b09dd).
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
specified in full in spec 14 (section numbers given).

### F1. A sheet upload never crashes the screen (must, S) - spec 4.1

- Problem: any uploaded xlsx/xlsm/csv throws in step 2 and the whole page becomes "Application error"
  with no way back (b574; paths #35, #36).
- Fix: `loadDetected` fills the `sheets` state whatever `previewReady` is; `WizardStep2` never assumes
  a choice exists; a sheet that is not read yet is reported as "Reading your sheet" instead of "cannot
  read"; an `error.tsx` under `/catalog` gives any future crash a message and two links (this batch,
  all batches); a browser test covers an xlsx upload through step 2.
- Operator sees: step 2 renders at once with "Reading your sheet. The columns will appear here when
  it has been read." and then the column sentence; a crash anywhere in `/catalog` shows "Something went
  wrong on our side. Your batch is safe." with "Open this batch" and "All batches".
- Risk: low; it is a guard and a state fill. Dependencies: none.

### F2. A pasted grid is understood, and the screen says back what it understood (must, M) - spec 4.2

- Problem: multi-link rows glued into one URL; URL used as identifier; `0` cells; no shape check
  (baefb; paths #20 to #22, #34, #45; ux repro b, b2).
- Fix: one table parser for pasted text (split on tabs; also on commas, semicolons and whitespace
  between links); every http(s) token in a row is a link; the first non-link cell is the identifier;
  a link is never an identifier; `0`, blank and non-link cells are ignored; rows with several links are
  one product each with column order as shot order; single-link lines keep today's file-name grouping.
  `cellUrls` in sheets splits on newlines and whitespace too. At paste time the server returns a
  readback: rows, links, links per row (min to max), how products will be named, and the result of a
  cheap check of the first three links (a range GET through `safeFetch`). Share-page links (Dropbox,
  OneDrive, WeTransfer, Drive file links) are refused at paste with the reason and the alternative.
- Operator sees: "287 rows, 1,400 links (4 to 5 per row). Products will be named from the file names,
  for example BH-4610-NE. We opened the first 3 links: all fine." Or, for a refused shape: "These are
  Dropbox share pages, not image links. Download the photos and drop them here, or paste direct image
  links."
- Risk: medium; the parser touches every paste. Mitigated by replaying the real aefb3a0f shape as a
  fixture (spec 6). Dependencies: none (F5 improves the failure path when links still fail).

### F3. A wrong paste or file can be corrected without duplicates (must, M) - spec 4.3

- Problem: edits and appends to the paste box add a second upload; clearing removes nothing; files
  cannot be removed; a failed upload after 15 minutes can never be retried and blocks Continue
  (paths #2, #3, #23, #24; ux step 1).
- Fix: the paste box is one input bound to one `url_list` upload row (keyed by upload id, not by text):
  editing replaces, clearing removes. Every file row and every pasted link row has Remove. Retry
  re-plans the upload (fresh signed URL) when the plan is older than its TTL. The wizard shows every
  input the batch holds, including inputs added in an earlier session (F4).
- Operator sees: a list of what the batch holds, each with Remove; editing the paste changes the
  count in place; Continue is never blocked by a row they cannot act on.
- Risk: low to medium. Removing an upload needs a delete route and a state for "removed" (see
  section 7, decision 1). Dependencies: F4 for the "inputs from an earlier session" part.

### F4. Every unfinished batch can be found and resumed (must, M) - spec 4.4

- Problem: batch id in browser memory only; `?batch=` ignored; drafts unreachable; no age, state or
  action in the list; no cancel (paths #53, #62; ux sections 1, 6; db Drafts).
- Fix: the wizard writes `?batch=<id>` into the URL as soon as the batch exists and reads it on load;
  `/catalog/new?batch=<id>` opens the wizard at the step the batch is in (step 1 while inputs are
  pending or missing; step 2 while collecting or ready; step 3 once ready with no marketplaces; step 4
  once marketplaces are chosen). The batch page for a draft gets "Continue setting up"; the list gets a
  "Your unfinished batches" section at the top with state words ("Collecting 612 of 1,400",
  "Ready to check", "Needs your input: which column holds the identifier?", "Could not start: <reason>"),
  age, Continue and Cancel; the brand page lists the brand's unfinished batches. Cancel marks the
  draft cancelled and hides it from the default list.
- Operator sees: after a crash, reload or a day away, the list says "Your unfinished batches: BHPC
  bags, Test Brand, ready to check, created 2 hours ago [Continue] [Cancel]".
- Risk: medium; the wizard must initialise from server state instead of from its own memory, which is
  the biggest change to the wizard. Dependencies: F1 (step 2 must render from server state).

### F5. Every failed link says which row, why, and what to do; transient failures are retried (must, M) - spec 4.5

- Problem: reasons hidden; links mislabelled as files; transient errors cached for ever; wrong fix
  suggested (baefb; paths #27 to #30).
- Fix: a `link` reject class with the row, column, status and the URL; transient failures (429, 5xx,
  network, timeout) retried inside the run with backoff and never stored as final in the manifest;
  permanent failures (404, 403, not an image, http only) stored with their reason. Step 2 and step 4
  list link failures separately from unreadable files, with the first examples and a "show all" table;
  a "Try the failed links again" action re-fetches only the failed ones. The no-photos sentence names
  links as links and gives the real next step. `counts.linkFailures` is separate from
  `unsupportedFiles`.
- Operator sees: "287 links could not be downloaded. All 287 answered 'not found' (404). First: <url>
  (row 1, column 2). Check that the links open in a browser, fix the sheet, and paste again." Or, for
  a partial failure: "12 of 1,400 links could not be downloaded (3 products affected). 9 timed out and
  were tried 3 times. [Try the failed links again] [Show all 12]".
- Risk: medium; the retry must not turn a dead host into a very long run (bounded attempts, bounded
  time per item). Dependencies: F2 for row and column numbers on pastes.

### F6. Every intake wait shows a count, a phase and an honest time; the copy tells the truth about leaving (must, M) - spec 4.6

- Problem: fixed sentence for 17 minutes; grouping invisible; false "you can close this page"; no
  ETA (b09dd; paths #48, #54, #56; ux repro c).
- Fix: the batch carries `counts.phase` (`uploading | downloading | reading | placing | ready |
  needs_input`) and `counts.placed / placeTotal` for the grouping phase; every intake screen (wizard
  steps 2 to 4, batch page, list row) shows the phase, the count and an estimate from the measured rate
  of this batch (same rolling-sample method the processing ETA uses, `pipeline/status.ts`); the batch
  stays "collecting" until the preview is ready; stall detection covers the placing phase; the copy
  says "You can close this page. Find this batch under Your unfinished batches and press Continue when
  it is ready." (true once F4 ships). The step 2 cards are hidden while collecting instead of showing
  zeros.
- Operator sees: "Downloading photos 612 of 1,400, about 7 minutes left", then "Placing photos 300
  of 1,400, about 4 minutes left", then the grouping.
- Risk: low to medium; the `phase` lives in the existing `counts` jsonb column (no migration). The
  estimate is honest only if the rate is measured, never fitted. Dependencies: F4 for the leaving copy;
  F7 for `placed` to move during grouping (without F7 the placing phase shows a count that moves only
  at the end, so F6 ships the phase word first and the moving count with F7).

### F7. Grouping is resumable and never re-copies (should; must for batches over about 4,000 photos, L) - spec 4.7

- Problem: Continue on step 2 regroups and re-copies every photo (5 min at 1,400); a grouping over
  900 s strands the batch for ever; spec 04 already promised the sha256 skip (paths #55, #58).
- Fix: raw placement skips an object that exists with the same sha256; the placing phase runs in
  budgeted chunks with self-continuation like collection, writing `counts.placed` after each chunk;
  the database step runs once at the end; the claim stays in status `ingesting` (an atomic marker
  inside `counts`), so a killed request is retried and a stall is detected. Step 2 Continue with no
  change skips the regroup entirely.
- Operator sees: Continue on step 2 is instant when nothing changed; a 10,000-photo links batch
  finishes instead of hanging.
- Risk: medium to high; this is the deepest change and touches the idempotency of ingest. Covered by
  the existing tier 2 ingest tests plus new ones (spec 6). Dependencies: F6 (phase and counters).

### F8. A batch that failed before Start can be fixed in place (should, S) - spec 4.8

- Problem: "Start again" opens an empty wizard; re-paste gets 409; collected bytes wasted (paths #31,
  #61; baefb 18:57).
- Fix: a batch that failed before `startedAt` can be reopened as a draft ("Fix and continue"), keeping
  its name, product type and inputs; the 409 sentence distinguishes failed ("could not start"),
  collecting ("still collecting; wait or press Try again") and started. The failure reason is carried
  into step 1 so the operator sees what to change.
- Operator sees: on the failed batch page, "Fix and continue" opens step 1 with the inputs listed, the
  reason above them and Remove on each.
- Risk: low; no new status (failed to draft is an allowed transition for never-started batches).
  Dependencies: F3, F4.

### F9. Draft and failed screens tell the truth (must for the copy, S) - spec 4.9

- Problem: "started <time>" on a draft; draft banner with no button; "No photos in this batch yet" on
  a draft holding 1,400; Links sheet tab reads as a finished result; empty "How this works" paragraph;
  "Start again" above the reason on phones; failed reason missing from the list; broken "No products
  of Test Brand match ." sentence (ux sections 1, 2, 6, 7).
- Fix: "created" for unstarted batches; channels omitted when empty; the draft banner carries the
  Continue button (F4); Compare and Links sheet tabs for drafts say "This batch has not started. 1,400
  photos found for 287 products; nothing has been made yet."; the list shows the reason on failed rows
  and keeps State visible on phones; the empty-search sentence is fixed.
- Risk: low. Dependencies: F4 for the button.

### F10. The same photos in another batch are flagged (should, M) - spec 4.10

- Problem: two drafts, same 1,390 photo hashes, different keys; no warning (db headline 5). Within
  a batch, two products carrying the same photo are never reported (db section 1).
- Fix: at grouping, compare the batch's sha256 set with the brand's other unfinished and failed
  batches and with live products (the existing `renameHints` already covers the live case); warn with
  the batch name, age and the two identifier spellings; within a batch, warn when the same photo sits
  under two identifiers.
- Operator sees: "These photos are already in BHPC bags (created 5 minutes ago, not started) under
  different identifiers (BH-4610-NE_Black there, BH-4610-NE_Black_OD here). Continue that batch, or
  cancel it, before starting this one." and "10 photos appear under two products: BHSS26M10_Tan and
  BHSS26M10-BLACK share BHSS26M10-BLACK_1.JPG. Check the sheet."
- Risk: low to medium (a hash comparison over the brand's unfinished batches). Dependencies: F4
  (cancel), F6.

### F11. Platform errors and large hand-offs do not break the wizard (should, S) - spec 4.11

- Problem: a 502/504 HTML page becomes a raw JSON parse error; over about 1,900 loose files the
  hand-off exceeds the 300 s web request (paths #8, #57).
- Fix: `wizardApi` checks the response before parsing and shows "The server did not answer in time.
  Your files are safe. Reload this page to continue."; the hand-off enqueues in pages and returns
  early with the batch collecting (Try again hands over the rest, as it does today).
- Risk: low. Dependencies: F4 (reload lands back in the batch).

### F12. Draft housekeeping and a trace per ingest delivery (should, S) - spec 4.12

- Problem: drafts never expire; a successful ingest leaves no log line with the batch id, so the two
  batch investigations had to tie worker requests to batches by timing (b574, b09dd; paths #62).
- Fix: the sweep cancels drafts untouched for N days (owner sets N; proposal 14) with the state word
  "Expired" and the age; one INFO log line per ingest delivery with batch id, upload id, phase, done
  and total.
- Risk: low. Dependencies: F4 (the cancelled state).

### F13. Google and Drive edge cases (later, S) - spec 4.13

- Problem: re-pasting the same Google link after sharing does nothing; a Drive folder over 1 GiB is
  called fine at paste and refused at Continue without the reason; Drive rejects are lost (paths #37,
  #49, #50, #52).
- Fix: "Check again" re-runs the access check on the same text; the size check runs at paste time;
  the worker keeps `detected.rejected` from the web tier.
- Risk: low. Dependencies: none. Deferred because no operator has used Drive folders yet (db, section 3:
  `drive_folder` never used).

### Must-fix set and order

Before the next operator uses intake: F1, F2, F3, F4, F5, F6, F9. Proposed as three PRs in this order
(spec 7): PR A = F1 + F9 + the F6 copy and step 2 count (small, safe, deployable within a day of
approval); PR B = F2 + F3 + F5 (the input and failure layer); PR C = F4 + F6 (resume and progress).
Then F7, F8, F10, F11, F12 as a fourth PR, F13 later.

### What to do with the existing drafts (recommendation, not done)

- 574f2025 and 09dd86f2 (the operator's two BHPC drafts, Test Brand): they are technical tests on the
  test brand, and the real BHPC delivery will run on the real brand after the fixes. Recommended: cancel
  both through the Cancel action once F4 ships, after telling the operator. Do not start either: they
  carry different product keys (Option Id against Unicommerce Code) and the right key for BHPC is an
  operator decision that has to be made once, before the real batch (section 7, decision 3).
- aefb3a0f (failed): leave as is until F8 ships, then cancel. It is useful evidence until then.
- The 12 older drafts (owner's tests, 2026-10-19 to 10-21) and 47f98f2a (the only real draft, puma, 5
  photos, superseded 3 minutes later by a finished batch): cancel through the same action. No manual
  database writes; the action is the way, so the first use of Cancel is on batches nobody needs.
- Bytes: a cancelled draft keeps its objects by default. The two BHPC drafts hold 2 x 8.4 GB under
  `catalog-test/`, where test cleanup is allowed by the repo rules; whether cancelled test drafts are
  cleaned after N days is decision 2.

---

## 6. Non-goals

- No change to processing after Start (matting, render, QA, publish, sheets, re-check).
- No change to the core flow: four steps, one brand per batch, no stored defaults, channels chosen
  fresh every batch (SPEC.md non-goals).
- No new input routes (Dropbox, OneDrive, WeTransfer APIs); they are refused with a clear sentence
  and the existing alternative (download and drop).
- No resumable or chunked browser uploads (paths #4); a big zip on a flaky line still restarts.
- No language model anywhere in intake (SPEC.md: grouping, counting and column detection are
  deterministic code).
- No model names or technical settings in any new sentence.
- No change to the identifier rules, precedence rules or sheet column detection of spec 04, except
  the cell split (F2) and the readback.
- No automatic merging of the two BHPC drafts; a person chooses the key.

---

## 7. Open questions for the owner

Each is a yes/no or a pick, with the recommended answer first.

1. **One small migration, yes or no?** Recommended: yes. F3 (an upload removed from a batch) and F4
   (a cancelled draft) are cleanest as two new status values, `removed` on `catalog_uploads` and
   `cancelled` on `catalog_batches`. Both columns are text with a CHECK constraint
   (`packages/core/src/db/schema.ts:237,256,275,283`), so new values need a migration
   (`0003_intake_states.sql`). 00 section 11 says only specs 02 and 03 ship migrations, but
   `0002_cost_events.sql` (PR #90) already shipped outside them with the owner's approval. If no: F3
   hard-deletes the upload row and its uploaded object, and F4 marks cancellation inside the `options`
   jsonb; both work, both are less clean (a cancelled draft then still has status `draft` in the
   database and every query has to remember the flag). The spec describes both paths.
2. **Draft expiry: after how many days does the sweep cancel an untouched draft, and may the bytes of
   cancelled test-brand drafts be cleaned up?** Recommended: 14 days, and yes for `catalog-test/`
   only (the repo rule already allows test cleanup there); real-brand drafts keep their bytes until
   the existing 180-day raw lifecycle.
3. **BHPC product key.** Before any real BHPC batch: is the product identifier "Option Id"
   (`BH-4610-NE_Black`) or "Unicommerce Code" (`BH-4610-NE_Black_OD`)? Recommended: ask the operator
   once and record it in the brand's notes; cancel both test drafts either way.
4. **Approve the must-fix set and the three-PR order (section 5)?** If the set should be smaller,
   the smallest useful cut is PR A alone (no crash, truthful copy, a count on step 2), which fixes
   attempts 1 and 3 partly but leaves attempt 2 (pasted grid) broken.
