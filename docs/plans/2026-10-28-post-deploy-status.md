# Catalog status after the spec 17 deploy, extended for spec 18 (plain language)

For Sujan. Written 2026-10-29 (spec 17 section 3.5.4, extended for spec 18), results filled in 2026-10-31. It says what is live, what broke and
how it is now guarded, how fast the system is today, what changes for the operator, and which items are waiting
for you. Nothing in the "Waiting for you" list has been done.

A few words used below:
- **Photo**: one source photo a brand gives us. **Output**: one finished image of one photo for one marketplace
  (one photo on 9 marketplaces = 9 outputs).
- **Photos per minute**: source photos finished per minute. This is the unit of the speed bar of 150.
- **Cut-out**: removing the background. **GPU**: the graphics card machine that does cut-outs fast (an L4 on
  Google Cloud). **CPU**: an ordinary machine.
- **Enlargement**: making a small photo bigger to fill a marketplace's required size. **Upscaler**: the AI
  model that does that well. **Plain resize**: the old non-AI way, softer.
- **Held product**: a product that waits in "Needs attention" for the operator to decide. Its good images wait
  with it on purpose.
- **Silent output**: an image that was neither published nor held with a reason, so it would be lost without
  anyone knowing. There must never be one.
- **Deploy gate**: the step that tries each new version of a service on the side, with no real traffic, tests
  it, and only then switches traffic to it. **Rollback**: switching traffic back to the previous version.
- **Invariant**: a rule about the data that must always be true, checked every 10 minutes, with an email alert
  when it is broken.

## What is live

- **Spec 17 (reliable throughput)**: live since 2026-10-28 (main ea22854).
  - Every service is deployed through the deploy gate. A version that fails its test never gets traffic, and a
    rollback is one command that takes seconds.
  - Held products' good images are counted apart from lost work. The invariants run every 10 minutes and two
    new email alerts exist: "Some images were left half-finished (silent outputs)" and "One chunk is far slower
    than the rest". The admin Ops page shows four new numbers.
  - The GPU keeps one cut-out model loaded at a time. This was measured on the real card: one model needs 10.8
    to 13.7 GB of about 22.5 GB, so two do not fit safely.
  - A lost piece of work is now picked up in about 6 minutes instead of 30.
- **Spec 18 (reliable enlargement)**: live and done. Last release main a26ad15, deployed 2026-10-31 06:59 UTC.
  - Every photo that must be enlarged now goes through the AI upscaler, or its product is held with a reason.
    A plain resize is never published in its place without telling anyone.
  - **New batches now enlarge on a GPU** (a graphics card machine), not on CPU. The GPU service is
    `catalog-upscale-gpu`: NVIDIA RTX PRO 6000 cards in Delhi (Google region asia-south2), up to 3 machines
    today. The CPU service `catalog-upscale` (Mumbai, asia-south1, up to 50 machines) stays deployed as the
    fallback.
  - Each batch remembers where it started (GPU or CPU) and keeps that to the end, so the two kinds of image are
    never mixed in one batch.
  - Live test result (2026-10-30, CPU): **PASS on every reliability item**, on a 200-product test and on a
    5-product operator batch run at the same time. Details under "Spec 18 live results" below.
  - GPU check (2026-10-31): **PASS**. The same 5-product operator batch took **4 min 11 s on GPU against 75 min
    on CPU**.

## What was broken and how it is guarded now

| What went wrong | When | Guard now |
|---|---|---|
| The GPU setting was a guess: 3 models with a memory cap per model too small for one model. Every call of one model failed. | 2026-10-27 | A GPU setting is measured on the real card first; the deploy script refuses a setting the measurements do not fit. |
| The speed test reported "124 silent outputs". They were the good images of 8 held products, not lost work. | 2026-10-27 | Held images and silent outputs are separate numbers; only silent outputs fail a test or send an alert. |
| A deploy tested the old version and could not roll back by itself. | 2026-10-27 | The deploy gate tests the new version before it gets traffic; rollback is one command. |
| One piece of work waited 32 minutes because the task queue gave up on it while the workers were busy. | 2026-10-27 | The queue keeps trying for 30 minutes, and an unstarted piece is sent again after 6 minutes. |
| Every one of 935 enlargements fell back to a plain resize, with no flag and no hold. The upscaler was given 60 seconds; one photo takes about 2 minutes on CPU. | 2026-10-29 | Spec 18: enlargement is its own queued job with retries; a photo is enlarged by the upscaler or its product is held with a reason; never a silent plain resize. An alert-backed check looks for any enlarged image made without the upscaler. |
| The final step of a batch ran three times and overwrote the independent re-check number. | 2026-10-29 | It now runs once; it runs again only when something really changed (an operator decision, added SKU ids, a changed late photo). |
| The test cleanup took 13 minutes, deleting one file at a time. | 2026-10-29 | It deletes up to 32 at once, after checking every file is under the test folder. |
| A hidden second cap on machines: Google Cloud keeps a service-wide maximum, set once when the service was first made, next to the per-version maximum the repo sets. The upscaler was stuck at 4 machines although the repo said 16; the worker at 10 instead of 24. | 2026-10-30 | Every deploy now sets the service-wide maximum to the same number (#130). |
| Even with more machines, enlargement stayed at about 4 a minute: the task queue was only allowed to hand out about one enlargement every 13 seconds. | 2026-10-30 | The queue rates are now part of the measured shape and checked against the machines (#131), and the GPU lanes have their own rates (#135). |
| The deploy check compared one x4 call with one x2 call, and a single fast or slow call made it fail for no real reason. | 2026-10-31 | It now uses the middle value of several calls against the time limit (#134). |

## Speed measured so far

The 200-product test on 2026-10-29 (Test Brand, 935 photos, all 9 marketplaces, 46 minutes):

- **20.4 photos per minute** over the whole batch; 57.3 over the best 3 minutes.
- **The bar is 150 photos per minute. It was not reached.**
- The slow step was making the images, and inside it the CPU upscaler (the step that was failing silently).
- At these rates, 2,000 products take about 2 h 43 m (best rate) to 7 h 38 m (whole-batch rate); 7,000 products
  about 9 h 31 m to 26 h 42 m.
- Reliability held: no lost images, every product published or held with a reason.
- A 7-product operator batch started during the test finished in 11 minutes (limit 15). Its first image came
  after about 7.5 minutes (limit 5).

Measured time per photo for the CPU upscaler, per machine size (one photo at a time per machine, measured on
2026-10-29 and again in the deploy of 2026-10-31):

| Machine | 800x1200 photo | 1600x1600 photo |
|---|---|---|
| CPU, 4 vCPU (the live shape) | about 99 s (x2), about 130 s (x4) | about 210 to 220 s |
| CPU, 8 vCPU | about 77 s | about 160 s |
| CPU, 4 vCPU, two photos at once | about 126 s each, and the two answers were not identical, so this is not used | about 490 s |
| GPU, RTX PRO 6000, one photo at a time | about 1.1 to 1.4 s | about 2.1 to 2.6 s |
| GPU, RTX PRO 6000, four photos at once (the live shape) | about 2.0 to 3.3 s each | about 3.9 to 6.7 s each |

So one GPU call is about 30 to 100 times faster than one CPU call, and its answers are identical on every machine.

## Spec 18 live results

### The 200-product test on CPU (2026-10-30)

Test Brand, 200 products, 935 photos, all 9 marketplaces, 8,415 outputs, 1,869 enlargements. A 5-product operator
batch (60 outputs, 30 enlargements) was started 5 minutes in, as an operator would.

| Reliability item | Result |
|---|---|
| Every output that needs enlarging is enlarged by the AI upscaler, or held with a reason | PASS: 8,415 of 8,415 and 60 of 60 outputs are `upscaled`; 0 enlargements failed |
| No silent plain resizes | PASS: 0 |
| No plain fallbacks | PASS: 0 |
| No product held because a machine was busy or too slow | PASS: 0. The 82 held images are all cut-out or Styli layout problems, the same 9 products as before |
| Invariants show no ERROR on the test batches | PASS (the only ERROR is the old BHPC draft 09dd86f2, see "Waiting for you") |
| The operator batch finishes while the big test runs | PASS: 75 min, 60 of 60 live |

Speed on CPU:
- The 200-product test took **8 h 16 min**. Enlargement was the slow step.
- In the first 90 minutes a hidden cap held the upscaler at 4 machines (see "What was broken" below). After it was
  lifted it ran at about 4.4 enlargements a minute.
- At that rate 2,000 products would take about 71 hours and 7,000 products about 248 hours. That is why the GPU
  was added.

### The GPU check (2026-10-31)

The same kind of 5-product operator batch (Noon, Trendyol, Styli, Centrepoint), on GPU, with nothing else running:
- **4 min 11 s**, against 75 min on CPU. (The CPU batch shared the machines with the 200-product test, so the
  comparison is a little generous to the GPU, but the difference is still very large.)
- 60 of 60 outputs `upscaled`, all 30 enlargements on the GPU, 0 failed, 0 plain fallbacks, 0 silent outputs,
  0 held. Invariants: only the known 09dd86f2 ERROR.
- One GPU call took about 1.6 s (95 out of 100 calls under 2.1 s). The first call waited 74 s while a GPU machine
  started from zero ("cold start"). About 45 enlargements a minute once warm, on 1 of the 3 machines.
- A 200-product test has not yet been run on GPU. At 45 a minute per machine, the 1,869 enlargements of the
  200-product test would take well under an hour, but that is an estimate, not a measurement.

### Cost

These are Google list prices from the usage numbers, not the bill.
- The 200-product test on CPU: about **USD 56 to 58** in total. Most of it is machine time: the CPU upscaler about
  USD 36, the worker about USD 19. The judge (the AI quality check) and the cut-outs together were under USD 1.
- The 5-product GPU check: about **USD 0.81**, mostly the GPU machine staying on for a while after the work before
  it switched itself off.
- Every service still switches itself off when idle (minimum 0 machines), so nothing costs money while nobody
  runs a batch.

### How to go back to CPU (rollback)

If the GPU upscaler misbehaves, new batches can be sent back to the CPU upscaler with one deploy. From Git Bash, in
the main checkout on `main`:

```
UPSCALE_TARGET=cpu bash infra/deploy.sh
```

- This changes only where **new** batches enlarge. A batch that already started on GPU finishes on GPU; both
  services stay deployed.
- The CPU lanes come back exactly as they were before the switch (4 operator slots, 44 bulk slots).
- To go back to GPU later, run `bash infra/deploy.sh` again without the setting (GPU is the default).
- Turning AI enlargement off completely (`UPSCALE_MODEL=off`) is the older, last-resort switch: photos are then
  resized the plain way on purpose and the invariants report them.

## What spec 18 changes for the operator

- A photo that must be enlarged is enlarged by the upscaler every time. If that fails after several tries, the
  product waits in "Needs attention" with the sentence "This photo could not be enlarged to this marketplace's
  size. Try again, or ask the brand for a larger photo." A plain resize is never published in its place.
- The batch page shows one more step while this runs: "Enlarging photos x of y".
- Enlargement now runs on the GPU, about 1 to 3 seconds per photo. The first batch after a quiet period waits
  about a minute or two while a GPU machine starts. (On CPU it was about 2 minutes per photo.)
- The admin Ops page shows "Enlargements waiting" and "Enlargements failed".

## Waiting for you

1. **Three status messages** you asked about: "Added, not collected yet", "Please wait..." and "This did not
   finish. Try again." Not changed; they need your wording decision.
2. **Tell the operator before the two BHPC draft batches are cancelled** (574f2025 and 09dd86f2). The older one
   (09dd86f2) keeps the "silent outputs" alert firing (2,012 images in that draft). Cancelling is your call.
3. **The BHPC retry** after those two drafts are cancelled.
4. **A change to the storage bucket's clean-up rules at 13:52 UTC on 2026-10-28** of unknown origin. The deploy
   reset it to the repo's file. Please check whether someone changed it on purpose.
5. **More GPU machines for enlargement.** The request for 6 RTX PRO 6000 cards in asia-south2 (instead of 3)
   shows as granted (6) in Google Cloud on 2026-10-31. Using them needs one small change and a deploy
   (`UPSCALE_GPU_MAX_INSTANCES` from 3 to 6), which waits for your OK. It costs nothing while idle.

## Follow-ups (known, not fixed in spec 18)

None of these lost or hid an image in the tests. They are listed so they are not forgotten.

Testing and build:
- CI (the automatic checks on every pull request) takes about 35 minutes.
- One browser test of the intake screens fails now and then with a dropped connection (ECONNRESET), then passes
  on a re-run.
- The render test leaks temporary files.
- A "MaxListenersExceededWarning" still shows in some logs (a Node.js warning about too many listeners).

Cost numbers:
- The cost ledger prices a CPU enlargement at the CPU cut-out rate, not at the upscaler's own machine rate, so CPU
  enlargement cost is under-counted.

Test drivers and tools:
- The eval, qa-check and real-run test drivers do not fix (pin) the enlargement settings at the start, as the web
  and the load driver now do.
- The upscaler probe prints nothing until it ends, so a long probe looks stuck.

Enlargement details:
- Cached image bytes in the worker never expire.
- When less than 60 s is left before a call, the call is skipped but still counted as an attempt (it should be
  given back).
- Plan row F25b says a reset during an upscaler deploy is a delay; the code counts it (1 of 24 attempts per row in
  flight per deploy). The plan wording or the code should be aligned.
- F36 has a test coverage gap, and a QA re-queue (without parking) is not visible anywhere. Visibility only, no
  reliability impact.
- A race in `requeueOtherUpscaler`.

Reliability edges:
- A duplicate replacement upload answers with an error 500.
- The sweep's enqueue can throw.
- If a publish or finalize task is lost, the batch only fails after the 2-hour watchdog, instead of being picked
  up again sooner.
- The 503 ("try again later") retries, for example 8 on finalize just before the 200-product batch ended. They
  failed nothing.
- Spec 16 item 3 is still open.

Infra:
- The GPU quota for 6 machines is granted; raise `UPSCALE_GPU_MAX_INSTANCES` to 6 and deploy (see "Waiting for
  you" 5).
- Every deploy warns that the IAP sign-in role is granted at project level, not on the web service. This is known
  and documented in `docs/solutions/catalog-iap.md`.

Owner items (yours): the BHPC drafts 574f2025 and 09dd86f2, and the three status messages (items 1 to 3 above).
Also: the 7-product operator batch 616a7386 from the spec 17 test (2026-10-29) was started from the live site,
so its name does not start with "catalog-test" and the test cleanup refuses to touch it. Its images are still
online under the catalog-test/ folder. Deleting it is your call.

## Test clean-up done (2026-10-31)

All spec 18 test batches and the spec 17 speed test were removed from storage and the database with the test
cleanup script (about 19,800 files). The GPU check batch acc773a5 keeps one database row until tomorrow, because it
spent money today and the daily spend count needs it. After the cleanup the invariants check found no ERROR apart
from the known 09dd86f2.
