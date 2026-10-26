# GCC catalog roadmap - one page

For Nitin Kiran, Naz and the GCC business team. Detail and sources: `07-roadmap.md` and `06-metrics-and-impact.md`.

**The problem.** Our product pages on the nine GCC marketplaces (Amazon, Noon, Namshi, Styli, Centrepoint,
Trendyol, 6thStreet, VogaCloset, Shein) go live with the photos and facts exactly as the brands send them. Each
marketplace has its own photo and listing rules, and we cannot yet see which listings they reject, or whether a
better page sells more. (Softline = clothing, shoes and bags, the part of the catalog this covers.)

**What we found** (all measured from our data or a sample audit, some rounded; sources in 07):
1. **98% of apparel lacks the 5-photo set Styli and Centrepoint ask for** (65 of 66 sampled products).
2. **Nothing gets fixed before going live.** On Trendyol, none of 37 checked listings had been repaired; cut heads and
   wrong first photos are live.
3. **27% of softline ad money buys clicks that rarely turn into orders:** 30.5k USD in 90 days on 236 products that return
   1.75 USD of sales per ad dollar, against 4.25 for our other well-clicked products.
4. **71% of live, stocked listings sold nothing in 90 days**, and about half our stock sits on them.
5. **We are flying blind on rejections:** 62% of not-live listings have no reason, Noon's rejection report has been
   stale since 21 Aug, Noon traffic data stopped on 4 Feb, and Namshi has none.
6. **The money is in US Polo shoes** (about 5.9M of 9.2M USD softline revenue a year), and 19 of 20 sampled US Polo
   shoe pages have no lifestyle photo and no feature picture.

**What we propose, in order** (base = our best judged estimate of extra revenue a year, not a measurement; cost = year-one running cost, measured from list prices and our cost records):

| # | Initiative | What it does | Base | Cost |
|---|---|---|---|---|
| 1 | Measure and unblock | Restore rejection and traffic data, log every image change, run the proof test | 7k | about 0 |
| 2 | Channel-ready live catalog | Take over photo resizing from the agency; re-make every live product's photos to each marketplace's rules (our tool today turns white shoe photos grey on Noon; this fixes that if Noon wants white); get Noon rejections back live | 22k | 77 USD |
| 3 | Fix the pages we pay to advertise | Fix the weak-converting advertised products and high-traffic Amazon pages first | 13k, plus 5k less ad spend | 91 USD |
| 4 | Product facts, listings, customer voice | One fact record per product; fill marketplace sheets in English and Arabic; fix what reviews and size returns tell us | 61k | 804 USD |
| 5 | Complete apparel shot sets | Fill missing model photos so apparel can list on Styli and Centrepoint | 51k | 74 USD |
| 6 | Richer footwear pages | Add a lifestyle photo and a feature picture to shoe pages | 117k | 985 USD |

**Total (figures rounded): about 269k USD a year of extra revenue for about 2k USD a year of running cost** (low case about 1k, high case about 841k).
Agency fees saved (cash we pay today): about 2.1k USD a year (initiative 2 takes over photo resizing and links, 1.1k;
initiative 4 takes over listing-template filling, 1.0k), roughly the running cost. The agency's INR 60 per style
covers those two jobs (split between them unknown) and never image generation.

Generation avoided against agency prices (spend avoided, not cash we pay today): agencies charge INR 500 to 800 per
product for generated photos, so making them ourselves avoids about 11.5k to 18.3k USD once (initiatives 3, 5 and 6
backlogs) for about 409 USD of our running cost, and about 7.7k to 12.4k USD a year (new shoe and bag styles) for
about 260.

Steps 1 to 3 can start now (41k). The rest needs decisions from the business, listed below.

**Why build plus buy.** Our own platform already makes marketplace-ready photos for all nine channels for about
12 to 40 USD a year; buying the same from a ready-made tool such as Photoroom would cost about 1.6k to 14k a year
and none of them knows Noon, Namshi or Styli rules or writes Arabic from our facts. So we keep our platform and
buy only image generation (making new photos) as a swappable service, checked by our own quality gate (automatic checks that
the product, colour and logo were not changed, plus a person's review).

**What we need from the business.**
- **Brand permission** from US Polo first, then the other brands, to publish generated photos and feature pictures
  (this decides 117k, initiative 6).
- **Written yes from Noon and Namshi** that they accept a feature picture in the gallery.
- **Blank listing templates, a native Arabic reviewer, and the breakdown of the INR 60 per style between resizing with links and template filling.**
- **An owner** for GCC listing work (the India program also plans Amazon, Noon, Namshi), and for restoring the
  rejection and traffic data.
- **Agencies to hold bids and budgets steady** on test products while we measure.

**How we will prove it.** A holdout test: fix half of a matched set of products, leave the other half, and compare
conversion (share of clicks that become orders). On Namshi ads we can detect a 15% improvement per test; on Amazon
only 25% or more.

**How sure are we.** Measured: the defects, ad spend and returns, sales, liveness (share of stocked listings
that are live) and the costs. Judged: how much each fix lifts sales (0.5% to 10%) and how many blocked or missing listings come back or start selling (25% to 50%), so the
269k is an estimate, not a promise. Our own data shows more photos alone do not lift conversion; the right photos might, and the holdout test
will tell us which do.

Status: done
