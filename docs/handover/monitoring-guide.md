# Monitoring, alert emails and cost: an operating guide

For the owner and the operators of the catalog tool at Opptra. Went live on 2026-10-22 (deploy of
main `62c886c`). No technical background is needed to read it. Every technical word is explained
the first time it is used, and the glossary at the end repeats them.

Related documents, for more detail:

- Section 16 of `docs/handover/catalog-for-the-operator.md` (the alert emails, short version).
- "Monitoring and alert emails" in `docs/handover/go-live-runbook.md` (how Sujan sets it up).
- `docs/solutions/monitoring.md` (the technical design and why it was built this way).

---

## 1. What this is, in one paragraph

The catalog tool now watches itself. When something breaks, Google Cloud (the computers the tool
runs on) sends an email by itself. Every step that costs money is written down, so we can see what
each batch, brand, marketplace and image cost. Every step a batch takes is also written into a
log (a running diary the computers keep), labelled with the batch, so anyone can read a batch's
story in order. All of this lives in Google Cloud and in the tool's own database. Nothing new to
sign up for and no outside tools.

What it is **not**:

- **No spending alerts.** By the owner's decision (2026-10-21) nobody is emailed when a batch or a
  day costs more than usual, and there is no monthly budget alert. Cost is for looking at, not for
  alarms.
- **No outside tools.** No extra monitoring company, app or login. Only Google Cloud and the
  catalog tool itself.
- **The spending limits did not change.** The daily spending limit and the per-batch spending
  limit work exactly as before. The new cost tracking only records and shows money; it does not
  stop or slow any batch.
- **Problems that happen only in your web browser** (for example a button that does nothing on
  your laptop) are not captured. Tell Sujan about those yourself.

---

## 2. The big picture, end to end

What happens from upload to finished images, and where each step is now recorded:

```
 1. You upload photos and start a batch
        -> log: "batch started"
 2. The batch is split into chunks (small groups of products) and put in a queue (a waiting line)
        -> dashboard: queue depth          -> alert 7 if the line stops moving
 3. Cut-out: a service removes the photo background
        -> cost ledger: one row per cut-out call   -> alert 4 if the service keeps failing
 4. Image making: one picture per marketplace (Noon, Styli, Centrepoint ...); Styli photos are enlarged
        -> cost ledger: time of each image, cost of each enlargement
 5. Quality checks: an automatic checker looks at each image
        -> cost ledger: one row per check    -> alert 3 if checks cannot run, alert 5 if a limit paused them
 6. Each chunk finishes
        -> log: "chunk delivered"   -> cost ledger: worker time for the chunk
        -> if a chunk fails five times: log "chunk failed" and alert 1
 7. Each product's links are published to the sheet
        -> log: "product published"
 8. The batch is finished and checked again
        -> log: "batch finalized"
        -> if the batch stops for good or makes no progress for 2 hours: alert 2
 Any other error at any step -> alert 9.  Too many worker errors -> alert 6.  Database too busy -> alert 8.
```

Three places hold the records:

| Record | What it is | Where you see it |
|---|---|---|
| **Cost ledger** | A table in the tool's database. One row per step that costs money or time. | Ops page (`/catalog/ops`) and the batch page's cost lines |
| **Logs** | Google's diary of what the tool did, one line per event, each labelled with the batch id. | "Open logs" link on the batch page and the Ops page |
| **Alerts** | Nine rules in Google Cloud Monitoring that watch the logs and the services and send emails. | Emails to sujan@opptra.com; the "Catalog ops" dashboard |

---

## 3. What you can do with it

- **Get an email when something breaks.** Nine kinds of failure send an email to Sujan by
  themselves (section 4).
- **See what a batch cost**, in rupees, on its batch page (section 6) and in full detail on the
  Ops page (section 5).
- **See cost per brand** for the last 30 days or all time, with cost per product and per photo,
  next to the agency reference of INR 60 per style.
- **See cost per marketplace and per image** for any one batch, and which products and photos cost
  the most and why.
- **See cost per day** for the last 30 days, against the daily spending limit.
- **Follow a batch's story** in the logs, from "batch started" to "batch finalized" (section 7).
- **See live system health** on the "Catalog ops" dashboard in Google Cloud Monitoring (section 8).

---

## 4. The alert emails

### How the emails work

- **Who gets them:** sujan@opptra.com. Operators do not get them directly; Sujan forwards one if
  you need to act.
- **Subject line:** always starts with "Catalog:", for example "Catalog: a chunk gave up". The
  email body explains what happened and what to check first.
- **One email when it starts.** While that alert is still open, the same failure happening again
  sends no new email. So one email can stand for several failures of the same kind.
- **A "resolved" email** follows once things are fine again. In the test on 2026-10-22 it came
  about 5 minutes after the fault was fixed; at the latest it comes an hour after the last failure.
  An old alert email therefore does not mean the problem is still there. Look for the resolved email.
- **Test runs never email.** Test jobs (smoke tests, evals, load tests) do not send alerts.
- **There are no emails about money.** Alert 5 is about a limit pausing work, not about cost.

### The nine alerts

| # | Email subject | What it means in plain words | What the operator sees | What to do first | Call Sujan when |
|---|---|---|---|---|---|
| 1 | Catalog: a chunk gave up | One small group of products (a chunk) failed five times in a row and the tool stopped trying it. The rest of the batch carries on. | Details tab: "Chunk N (step) gave up after repeated errors: reason". Some photos show "Processing stopped after repeated errors". | Let the batch finish. Then upload the same products again in a new batch (a re-upload keeps the links). | The same products fail again. |
| 2 | Catalog: a batch failed or was swept | A batch stopped for good, or made no progress for two hours and the tool's own clean-up ("sweeper") stopped it. A batch with no usable photos does not send this email. | Batch page shows "Could not start" and a reason, for example "No progress for 2 hours. Start the batch again." | Read the reason. Start the batch again once. | It fails a second time. |
| 3 | Catalog: quality checks unavailable | The outside quality checker did not answer for 10 or more images within 10 minutes. | Photos wait in "Needs attention" with "The quality check could not read this image." | Look at each picture yourself. Use "Use as is" if it is fine. | A whole batch fills up with these cards. |
| 4 | Catalog: cut-out service breaker open | The background-removal service kept failing, so the tool stopped calling it for a short while to let it recover (like a fuse, called a "breaker"). | The batch stays on "Processing" longer. Some photos may wait in "Needs attention". | Wait 15 minutes. It usually recovers by itself. | The batch has not moved after 30 minutes. |
| 5 | Catalog: spending limit paused quality checks | The daily or the per-batch spending limit was reached, so quality checks stopped. A limit set on purpose, not a fault. | Unchecked photos wait in "Needs attention". | Do not start more batches today. | Always. Sujan decides whether to raise the limit or wait for the next day. |
| 6 | Catalog: worker errors | The part that makes the pictures (the "worker") gave more than 5 server errors a minute for 5 minutes in a row. | Batch pages move slowly or stop moving. | Do not start new batches. Wait 15 minutes. | It is still happening, or a batch stops moving. |
| 7 | Catalog: queue stuck | More than 50 pieces of work have been waiting in line for 30 minutes and not one was picked up. A large batch that is still moving does not trigger it. | "Processing" with a count that does not change. | Refresh the batch page after a few minutes to see if the count moves. | Nothing moves for another 30 minutes. |
| 8 | Catalog: database connections high | The database is close to its limit of open connections (more than 20 of 25 for 5 minutes). At the limit, every page and batch fails. | Pages load slowly or show an error. | Do not start new batches. Ask others not to use the site for a while. | Pages still fail after 15 minutes. |
| 9 | Catalog: error in the logs | Something went wrong that alerts 1 to 5 do not cover. | Often nothing on the batch page. | Carry on normally. Watch your batches for anything odd. | A batch looks wrong or stops. Sujan reads the details in the logs. |

When you call Sujan, send Sujan the batch name and the "Open logs" link from the batch's Details tab.

---

## 5. The Ops page (`/catalog/ops`)

### Who and how

- **Admins only.** The page is read only: it shows information and changes nothing.
- **To open it:** click your name or picture at the top right (the user menu) and choose **Ops**.
  Or type `/catalog/ops` after the site address.

### What refreshes and when

- The page **reloads itself every 30 seconds**. "Running now" and "Failures in the last 24 hours"
  are read fresh each time.
- The **cost tables are read at most every 5 minutes**, to keep the database calm. The page says
  when they were last read ("last at ...").
- If a cost table could not be read, it says: "Could not read the totals right now. Try again in a
  few minutes." That is not a fault in your batches.

### The sections, top to bottom

| Section | What it shows | How to read it |
|---|---|---|
| **Running now** | Every batch that is working right now: name (with a "Test" tag for test batches), brand, step, chunks, cost so far, start time, and a "Cost detail" link. | **Step** is in plain words: Collecting files, Cutting out, Making images, Quality check, Publishing. **Chunks** reads like "12 in total · cut-out: 2 waiting, 1 running · image making: 9 done". "gave up" in that column matches alert 1. "No batch is running now" is normal when nobody is working. |
| **Failures in the last 24 hours** | Batches that stopped or reported a problem, and chunks that gave up, each with the time, the reason in a sentence and an "Open logs" link. | "Nothing failed in the last 24 hours" is the good state. Shows at most 20 of each. |
| **Cost per brand, last 30 days** | Per brand: batches, products, photos, total cost, cost per product, cost per photo. | Test batches are left out. Compare "Per product" with the agency reference of INR 60 per style. |
| **Show all-time totals** (link) | The same brand table, for all time. | Read only when you click it. While it is open the page **stops refreshing by itself**. Click "Back to the live view" to return. |
| **Cost of one batch** | Pick a batch from the list (the 20 most recent) and click **Show**. Or click "Cost detail" in "Running now". | See the next table. |
| **Cost per day, last 30 days** | Cost and number of batches per day, and the share of the daily limit, for example "12% of the daily limit". | Days are in UTC (Indian time minus 5 hours 30 minutes). Test batches are left out. These totals include the cut-out service, which the daily limit does not count, so the percentage can look higher than the limit itself would show. |

### Inside "Cost of one batch"

| Part | What it shows |
|---|---|
| **Total** | The batch's full cost, with the time it was read and an "Open logs" link. |
| **By step** | cut-out, image making, enlarging, quality check, product type check, publishing, finishing. Cost, time in seconds and number of calls. |
| **By engine** | The same money grouped by what did the work: cut-out, image making, quality check, worker. The tool never shows which AI model was used. |
| **By marketplace** | Cost per marketplace, the number of images and the cost per image. |
| **Top 10 products** and **Top 10 photos** | The most expensive ones, with "What added up", for example "2 extra cut-out calls, 3 quality checks, 1 enlargement". This tells you why one photo cost more than the rest. |

If a line says "USD ... could not be given to an image", that money belonged to images that were
all skipped. It is counted in the total but not in any marketplace.

### How cost is split across marketplaces (the attribution rule)

One photo becomes one image per marketplace. Some costs belong to one image only; others are shared.
The rule, in plain words:

- **Making and enlarging an image** counts only for that marketplace's image.
- **A quality check** counts only for the image it checked.
- **Cutting out a photo** (and checking what product type it is) is shared equally between all the
  images made from that photo.
- **Worker time for a chunk** is shared equally between all the images in that chunk.
- **Publishing** costs only time (no money) and is shared equally between the product's images.
- Images that were skipped get no share.
- **Cost of one image** = its own costs + its shares.

So a marketplace that needs more work per image (for example Styli, whose photos are enlarged)
shows a higher cost per image than one that needs less.

---

## 6. The batch page

### Two cost lines, and why they differ

Under the heading **Cost so far** there are now two lines.

**Line 1, the cost line you already know.** It reads like this (the numbers are only an example): "USD 0.0185 (INR 1.55) per style so far ·
USD 0.0370 (INR 3.10) for this batch · agency reference INR 60 per style". It counts **quality checks
and worker time only**. These are the same costs the daily and per-batch spending limits count.
Products that did not change are not counted.

**Line 2, new: "Full cost including the cut-out service".** For example: "Full cost including the
cut-out service: INR 2.15 (cut-out INR 0.21, images INR 1.76, quality checks INR 0.19)". It adds the
cut-out (background removal) service, so it is the **complete** cost of the batch, split into three
steps that add up to the total:

| Step on the line | Includes |
|---|---|
| cut-out | Background removal calls |
| images | Image making, enlarging, publishing, finishing, and the worker time |
| quality checks | Quality checks and the product type check |

Why two lines: line 1 matches what the spending limits watch; line 2 is what the batch really cost.
Line 2 is usually the higher one. Batches from before 2026-10-22 have no line 2, because nothing was
recorded for them.

### The Details tab ("For the technical team")

New things on this tab:

- **Open logs** (Google's log page, filtered to this batch). See section 7.
- **Work groups (chunks)**: for example "Work groups (chunks): 3 in total · image making: 3 done".
  Each chunk is counted once, at the step it is at now.
- **Last problem recorded for this batch:** a sentence in red if the batch stopped or something went
  wrong at the end.
- **Chunk N (step) gave up after repeated errors: reason.** shown in red for the last chunk that gave
  up. This is the same event as alert 1.

---

## 7. Logs

### What "Open logs" shows

It opens Google's **Logs Explorer** (Google's page for reading logs) for the project
`image-links-agent`, already filtered to this one batch and looking back 7 days. You need to be
signed in to Google with an account that has access to the project. If you see "permission denied",
send the link to Sujan instead.

### The filter

The link fills in this filter for you. You can also type it yourself in Logs Explorer, replacing
`<id>` with the batch id (the long code in the batch page address, also shown on the Details tab):

```
labels.batchId="<id>"
```

### How to read the lines

Lines are in time order. Each line has a **severity** (how serious it is): INFO is normal, WARNING
is worth a look, ERROR is a failure. A healthy batch reads like this:

| Order | Line | Meaning |
|---|---|---|
| 1 | `batch started` | The batch began. |
| 2 | `chunk delivered` (one per chunk) | A chunk finished its images. |
| 3 | `product published` (one per product) | A product's links went into the sheet. |
| 4 | `batch finalized` | The batch finished and was checked again. |

Lines that mean trouble:

| Line | Severity | Meaning |
|---|---|---|
| `chunk failed` | WARNING while it will retry, ERROR on the fifth and last try | A chunk failed. The ERROR one sends alert 1. |
| `batch failed` | ERROR | The batch stopped for good. Sends alert 2. |
| `batch swept: no progress for 2 hours` | WARNING | The clean-up stopped a stuck batch. Sends alert 2. |
| `catalog_qa: quality check unavailable` | WARNING | A quality check could not run. Many of these send alert 3. |
| `spend cap hit` | WARNING | A spending limit was reached. Sends alert 5. |

The cut-out breaker line (`matting_breaker`) has no batch id, because the breaker is shared by all
batches, so it does not appear in a batch's filtered view.

---

## 8. The "Catalog ops" dashboard

**Where:** Google Cloud console, project `image-links-agent`, menu **Monitoring**, then
**Dashboards**, then **Catalog ops**. The list of alerts is under **Monitoring**, then **Alerting**;
it shows which alerts fired and when.

The dashboard has six charts:

| Chart | What it means | What normal looks like |
|---|---|---|
| Worker and cut-out instances | How many copies of the worker and the two cut-out services are running. | Zero when nobody works (to save money); goes up during a batch. |
| Requests per second by response class | How many requests the catalog services answer, split by result (success, client error, server error). | Mostly success. Some 503 answers are normal: the worker uses them to say "try again later". |
| Request latency p95 | How long the slowest 5% of requests take. | Rises during big batches; a sudden lasting jump is worth a look. |
| Cloud Tasks queue depth | How many pieces of work wait in line. | Rises when a batch starts and falls back to zero. Alert 7 watches this. |
| Database connections on ila-pg (limit 25) | Open connections to the database. | Well under 20. Alert 8 fires above 20 for 5 minutes. |
| Database CPU on ila-pg | How busy the database's processor is. | Low most of the time. |

---

## 9. Common situations

### A "Catalog: a chunk gave up" email arrives

1. Find the batch in "Failures in the last 24 hours" on the Ops page, or ask Sujan for the batch
   name.
2. Open the batch, go to the Details tab and read the red "Chunk N ... gave up" sentence.
3. Wait for the rest of the batch to finish.
4. Upload the same products again in a new batch. The re-upload keeps the links.
5. If they fail again, send Sujan the batch name and the "Open logs" link.

### The queue looks stuck ("Catalog: queue stuck", or a count that does not move)

1. Refresh the batch page after a few minutes. Check "Running now" on the Ops page: do the chunk
   counts change?
2. Do not start more batches.
3. If nothing moves for another 30 minutes, call Sujan, who checks the Cloud Tasks queue and the
   worker. Once the cause is fixed, the waiting work runs by itself; you do not need to upload
   again.

### "Catalog: quality checks unavailable"

1. Open the batch's "Needs attention" tab. Photos show "The quality check could not read this
   image."
2. Look at each picture. If it is fine, click "Use as is".
3. If a whole batch fills up with these, call Sujan, who checks that the outside checker is up and
   the account has credit.

### A batch looks expensive

1. On the batch page, read line 2, "Full cost including the cut-out service", and see which step is
   biggest.
2. On the Ops page, pick the batch under "Cost of one batch" and click **Show**.
3. Look at **By marketplace** and the **Top 10 photos**. "What added up" says why, for example
   extra cut-out calls (the background removal was retried) or enlargements (Styli).
4. Compare the cost per style with the agency reference of INR 60. Most batches are far below it.
5. There is no alarm for cost. If something looks wrong, tell Sujan.

### You want to know a brand's cost this month

1. Open the Ops page and look at **Cost per brand, last 30 days**. Find the brand's row.
2. Read "Cost", "Per product" and "Per photo". Test batches are not included.
3. For the brand's full history, click **Show all-time totals**.
4. "Last 30 days" is a rolling window, not a calendar month. For an exact calendar month, add up the
   days in **Cost per day** (remember they are UTC days), or ask Sujan.

---

## 10. Worked example: today's live check (2026-10-22)

Batch `e0067d90`, brand Test Brand, 2 products, 6 photos, three marketplaces: Noon, Styli and
Centrepoint.

**Full cost: INR 2.15 (USD 0.0256).** Split by step:

| Step | Cost |
|---|---|
| cut-out | INR 0.21 |
| images | INR 1.76 |
| quality checks | INR 0.19 |
| **Total** | **INR 2.15 (USD 0.0256)** |

Split by marketplace (rupees at the same rate, about INR 84 to the dollar):

| Marketplace | Cost |
|---|---|
| Styli | about INR 1.66 (USD 0.0198) |
| Noon | about INR 0.24 (USD 0.0029) |
| Centrepoint | about INR 0.24 (USD 0.0029) |

Styli costs most because its photos are enlarged before the image is made. Noon and Centrepoint
cost the same because they need the same work.

Per style: INR 2.15 for 2 products is about INR 1.08 per style, against the agency reference of
INR 60 per style.

**The logs**, filtered by this batch id, read in order: `batch started`, then `chunk delivered`
three times, then `product published` twice (once per product), then `batch finalized`. That is a
healthy batch from start to finish.

---

## 11. Glossary

| Word | Meaning |
|---|---|
| Alert | A rule in Google Cloud that watches for a failure and sends an email when it happens. |
| Attribution rule | The fixed rule for sharing a cost between marketplaces and images (section 5). |
| Batch | One upload of products and photos that the tool turns into marketplace images. |
| Breaker | A safety switch: after repeated failures the tool stops calling a service for a short time so it can recover, like a fuse. |
| Chunk | A small group of products the tool works on together. A batch is split into chunks. |
| Cloud Monitoring | Google's service that holds the alerts and the dashboard. |
| Cloud Tasks / queue | Google's waiting line of work for the worker. |
| Cost ledger | The table in the tool's database with one row per step that costs money or time. |
| Cut-out | Removing the background from a photo. Also called matting. |
| Dashboard | A page of live charts ("Catalog ops") in Cloud Monitoring. |
| Database connection | An open line between the tool and its database. The database allows 25 at once. |
| Enlarging | Making a small photo bigger before the image is made (Styli). Also called upscaling. |
| Incident | Google's name for an alert that has fired and not yet been resolved. |
| Log | A running diary the computers keep: one line per event, with time and severity. |
| Logs Explorer | Google's page for reading and filtering logs. |
| Ops page | The admin page `/catalog/ops` with running batches, failures and cost. |
| Quality check | An automatic check that looks at each finished image. |
| Severity | How serious a log line is: INFO (normal), WARNING (worth a look), ERROR (a failure). |
| Spending limit | The daily and per-batch money limits. When reached, quality checks pause. Unchanged by this work. |
| Sweeper | The tool's own clean-up that stops a batch with no progress for two hours. |
| UTC | World standard time. Indian time is UTC plus 5 hours 30 minutes. |
| Worker | The part of the tool that does the work: cut-out, image making, quality checks, publishing. |

---

## 12. Proof it works (2026-10-22)

On 2026-10-22 two failures were caused on purpose on the **preview** copy of the tool (a separate
worker and queue that operators never use), with Test Brand products only. The live tool was not
touched. Times are UTC (add 5 hours 30 minutes for Indian time).

| Failure caused | When | Email received at sujan@opptra.com | "Resolved" email |
|---|---|---|---|
| Cut-out service made unreachable for the preview worker | 08:59 to 09:02 | "Catalog: cut-out service breaker open" at 09:05:43 | 09:11:11 |
| (same failure) the chunk failed five times | 09:02 | "Catalog: a chunk gave up" at 09:06:09 | 09:11:11 |
| Quality checker pointed at a model that does not exist | from 09:11 | "Catalog: quality checks unavailable" at 09:28:40 | after the setting was restored |

Each email arrived about 3 to 4 minutes after its alert's condition was met, and the resolved
emails followed a few minutes after the fault was fixed.

The same day a live Test Brand batch (`e0067d90`, section 10) proved the cost ledger: the
quality-check rows added up exactly to the batch's existing quality-check total, the worker-time
rows to its worker total, and the only extra was the newly priced cut-out and enlarging time.

Evidence (screenshots, log extracts, query results) is kept in Google Cloud Storage under
`gs://image-links-agent-assets/catalog-test/handoff/2026-10-22/evidence/monitoring/`.
