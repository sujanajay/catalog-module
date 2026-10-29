# Catalog status after the spec 17 deploy, extended for spec 18 (plain language)

For Sujan. Written 2026-10-29 (spec 17 section 3.5.4, extended for spec 18). It says what is live, what broke and
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
- **Spec 18 (reliable enlargement on CPU)**: all code merged into main (b2a712b). It goes live through the deploy
  gate and is then tested with 200 products. Live test result: [to be filled after the live run]

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

Measured time per photo for the CPU upscaler, per machine size: [to be filled after the live run]

## What spec 18 changes for the operator

- A photo that must be enlarged is enlarged by the upscaler every time. If that fails after several tries, the
  product waits in "Needs attention" with the sentence "This photo could not be enlarged to this marketplace's
  size. Try again, or ask the brand for a larger photo." A plain resize is never published in its place.
- The batch page shows one more step while this runs: "Enlarging photos x of y".
- Big batches with many enlargements are slower on CPU (about 2 minutes per photo, many in parallel). Spec 18 is
  about reliability; speed comes later with more GPUs.
- The admin Ops page shows "Enlargements waiting" and "Enlargements failed".

## Waiting for you

1. **Three status messages** you asked about: "Added, not collected yet", "Please wait..." and "This did not
   finish. Try again." Not changed; they need your wording decision.
2. **Tell the operator before the two BHPC draft batches are cancelled** (574f2025 and 09dd86f2). The older one
   (09dd86f2) keeps the "silent outputs" alert firing (2,012 images in that draft). Cancelling is your call.
3. **The BHPC retry** after those two drafts are cancelled.
4. **A change to the storage bucket's clean-up rules at 13:52 UTC on 2026-10-28** of unknown origin. The deploy
   reset it to the repo's file. Please check whether someone changed it on purpose.
5. **GPU quota from 3 to 6 cards**, later. It is the biggest speed lever, costs nothing while idle, and needs a
   Google Cloud form, which you ruled out for now. It helps only after the enlargement step is fixed, because
   the GPU is not the slow step today.
