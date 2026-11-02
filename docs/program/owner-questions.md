# Owner questions

Date: 2026-11-02. For: Sujan. Every open question from `brief-v1.md`, `module-map.md`, the M0 to M12 requirements and
`UX-design-system.md`, with duplicates merged. Only questions that need you are here (business, legal, money, people,
brand rights, marketplace relationships). Technical and design questions were answered in the integration pass and
recorded in each module doc's "Integration decisions" section.

Each question has: the question, why it matters, the recommended default (what happens if you say nothing), and the
date it starts blocking work. Ordered by that date.

## A. Things you already agreed to do (no decision needed, just the action)

| Action | Blocks from | Why |
|---|---|---|
| Grant read access to the Supabase project with the brand photo folders | 4 Nov | Golden set photos (M7-S1) and the backfill (M0-S5) |
| Enable the GCP billing export to BigQuery | 9 Nov | Cost meter moves from an estimate (about +-30%) to billing within 10% (M6-S3) |
| Read-only user on `ila-pg` | 4 Nov | Cost and reliability numbers (M6-S1, M6-S6) |
| File the GPU quota request (`infra/request-gpu-upscale-quota.sh`) | 9 Nov | Throughput for catalog-wide waves (M6-S7) |
| Confirm the OpenRouter paid key has no daily cap | 4 Nov | Judge and vision calls stop mid-batch at a cap (M7-S2) |

## B. Questions

| # | Question | Why it matters | Recommended default | Blocks on |
|---|---|---|---|---|
| Q1 | Can the catalog team give 8-10 hours this week to label 100 golden products, and name one person to audit about 30 samples a day after that? | Without labels the quality gate cannot pass and the treatment batch slips; without an auditor the audit sampling has no reviewer | Yes: two catalog team members label 4-6 Nov; the catalog lead audits | Wed 4 Nov |
| Q2 | Does legal agree we may scrape our own Noon and Namshi listings (UAE and KSA) at a low rate? | Gallery counts for the holdout pool and live verification depend on it | Yes, own listings only, under 1 request a second, no market-wide scraping | Thu 5 Nov |
| Q3 | Will the data team own the scraper fields, fix the stale Noon "not live" feed, and share the Noon KSA ad feed? | M9 rejections and M10 leading indicators read these feeds | Yes, with a named data team contact | Thu 5 Nov |
| Q4 | May we book Streamoid and Rubick demos now and send them a 30-product pack under NDA? | The buy or build decision for text and listing files must be made by 16 Nov, before M8 starts | Yes; demos by 16 Nov; NDA first | Fri 6 Nov |
| Q5 | If Saudi sites block our scraper, may we pay for a Saudi proxy up to USD 100 a month without asking again? | KSA gallery counts and live checks | Yes, up to USD 100 a month | Fri 6 Nov |
| Q6 | Do you accept the recommended answers for the image-side high conflicts C06, C07, C11, C14, C16, C20 and C24 as one group? | M5-S3 makes every batch follow the rule versions; undecided rules stay as warnings | Accept all as recommended in `requirements/M5-channel-rules.md` | Mon 9 Nov |
| Q7 | May medium and low rule conflicts be accepted automatically with the recommended answer after 14 days with no decision? | Keeps the conflict list from growing without you; you can reopen any later | Yes | Mon 9 Nov |
| Q8 | Who owns measurement on the business side, and who holds the list of which options are treated and which are control? | The arm list must stay with someone who is not the ads or merchandising team, so they cannot change behaviour | You own it; the arm list stays in the system and with you only | Tue 10 Nov |
| Q9 | Can we get two native Arabic readers for a few hours a week from mid-November? | Arabic text and infographics need a human calibration set (M8-S2, M11-S3) | Yes, two readers from the catalog or channel team; agency if none | Thu 12 Nov |
| Q10 | Will the channel team bulk-upload the treatment on 17-19 Nov, click "Uploaded" in the tool, and re-upload weekly "Improved" items? And may we send the blind-arms letter to the ads and merchandising agencies? | Noon and Namshi have no API; the clock starts only when the treatment is live; outside edits would spoil the test | Yes to both; the letter says a test runs, not which options are in it | Fri 13 Nov |
| Q11 | Text conflicts C01 (title formula), C03 (bullet count) and C04 (bullet length): accept the recommendations? | M8 text generation cannot start for a channel while these are open | C01: Brand + Gender + Product Type + Key Feature or Material. C03: generate exactly 5, check 4-5, Trendyol 5-7. C04: per channel (Noon and Namshi 80, Myntra 100, Trendyol 160, Amazon 100-250) | Mon 16 Nov |
| Q12 | Is USD 0.25 per product an acceptable ceiling for AI text (all channels, English plus Arabic)? | Sets the vendor choice and the cost cap for M8 | Yes, USD 0.25 | Mon 16 Nov |
| Q13 | What budget may we spend on the vendor bake-off, and do you approve paid generation and overflow vendors once they pass, provided their terms say they do not train on our images? | Generated images (M3-S6 to S8) and overflow matting need paid contracts (gate G4) | Bake-off up to USD 500; paid use only after the bake-off and a no-training clause | Tue 24 Nov |
| Q14 | Will you ask the channel managers: crops allowed on Styli and Centrepoint; Noon and Namshi stance on AI-made images; text overlays (C19); Arabic text limits; Namshi image rules; video slots; Trendyol API credentials? | These rules are "assumed" today; a wrong guess means rejections | Yes; until answered, crops only, no generated images, no overlays on Noon and Namshi | Mon 30 Nov |
| Q15 | Do we hold rights to use brand models' likeness in generated images, per brand? | Mode A generated shots with people need a rights record with likeness (M3, M12-S6) | No generated people until a brand confirms in writing | Mon 7 Dec |
| Q16 | May we create a temporary Cloud SQL instance for load tests, deleted after each test? | Load tests must not run on the shared `ila-pg` while users are active | Yes, under USD 50 per test | Mon 7 Dec |
| Q17 | India pilot access: the Amazon.in SP-API token and the Cortina Myntra and Flipkart templates, from whom and when? | Stage 3 cannot start without them | Ask the India team for both by 5 Jan | about Tue 5 Jan 2027 |
| Q18 | Which legal route do we take for faces under Saudi PDPL (consent, licensed models, or none)? | Faces and kids (M11-S10) are blocked until this is settled | No faces until legal confirms a route | Before Stage 4 face work (about April 2027) |
| Q19 | For self-serve: what is the pricing unit (per product, per image, per month), and where must customer data live (UAE, KSA, India)? | Billing and data separation (M12-F5 to F7) are designed around both | Per product processed; data in the region of the customer's main market | Before the first outside customer (about June 2027) |

## C. Answered in this pass without you (recorded in the module docs)

So you can check them if you want; none needs a decision.
- Daily (not weekly) gallery scrape for treated listings (M4 D, M9).
- One image matcher threshold (6, uncertain 7 to 12) (M0 F3-R10).
- One audit rule for images and text (M7, M8).
- No output is ever held: missing checks mean provisional and flagged (M1, M3, M7).
- Default channels come from the brand's setting, then where the product is listed (M1, UX).
- `org_id` on every new table now; you are the only owner until roles exist (M12).
- UX: IBM Plex fonts, rename to "Catalog", 48 hours before a "needs you" item falls back to its safe default, email
  until a chat tool is chosen, the catalog lead runs usability rounds (UX section 17).
