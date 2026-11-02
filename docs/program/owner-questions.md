# Owner questions

For: Sujan. Every open question from `brief-v1.md`, `module-map.md`, the M0 to M12 requirements and
`UX-design-system.md`, with duplicates merged. Only questions that need you are here (business, legal, money, people,
brand rights, marketplace relationships). Technical and design questions were answered in the integration pass and
recorded in each module doc's "Integration decisions" section.

Each question has: the question, why it matters, the recommended default, its status, and the release that needs it
(see `roadmap.md`). Status words:
- **Answered**: you gave an answer; it is recorded here and in the module docs.
- **Default applies until the owner says otherwise**: being explained to you; work proceeds on the default.
- **Resolved by design**: the design changed so the question no longer needs an answer.

## A. Access and actions

| Action | Status | Needed by | Why |
|---|---|---|---|
| Grant read access to the Supabase project with the brand photo folders | Done: `supabase-url` and `supabase-service-key` in Secret Manager (`image-links-agent`); storage read verified 2026-11-03 (17 buckets) | R2 (`M7-S1`, `M0-S5`) | Golden set photos and the backfill |
| Enable the GCP billing export to BigQuery | Waiting: owner lacks billing permission and asked the billing admin | R2 (`M6-S3`, not blocking) | Cost meter moves from an estimate (about +-30%) to billing within 10% |
| Read-only user on `ila-pg` | Open | R1 (`M6-S1`, `M6-S6`) | Cost and reliability numbers |
| GPU quota | Done: 6 RTX PRO 6000 in asia-south2 and 3 L4 in asia-southeast1 granted. Use current capacity | - | Throughput for catalog-wide runs |
| Regional memory and vCPU quota (Cloud Run memory in asia-south2; CPU in asia-south1; instances per project; see `M6-F6`) | Later: owner requests it when R2 needs it | R2 (`M6-S7b`) | Lets all granted GPUs run at once and deploys stop being refused for CPU |
| Confirm the OpenRouter paid key has no daily cap | Done: no cap | R1 (`M7-S2`) | Judge and vision calls stop mid-batch at a cap |

## B. Questions

| # | Question | Why it matters | Recommended default | Status | Needed by |
|---|---|---|---|---|---|
| Q1 | Can the catalog team label 100 golden products, and name one person to audit about 30 samples a day after that? | Without labels the quality gate cannot pass; without an auditor the audit has no reviewer | Two catalog team members label; the catalog lead audits | **Answered: yes** | R2 |
| Q2 | Does legal agree we may scrape our own Noon and Namshi listings (UAE and KSA) at a low rate? | Gallery counts for the holdout pool and live verification depend on it | Own listings only, under 1 request a second, no market-wide scraping | **Answered: legal OK** | R2 |
| Q3 | Will the data team own the scraper fields, fix the stale Noon "not live" feed, and share the Noon KSA ad feed? | M9 rejections and M10 leading indicators read these feeds | Yes, with a named data team contact | Owner points to `github.com/opptra/gcc-dashboard` and `opptra-datawarehouse`; the gap list (`.runs/2026-11-03-data-inventory.md`) goes to the owner, who provides what is missing | R2, R4 |
| Q4 | How do we decide buy or build for text and listing files (M8, M9)? | Building M8 and M9 wastes effort if a vendor already does it well | Was: book Streamoid and Rubick demos | **Answered: no vendor demos.** A website teardown of Streamoid and Rubick (report: `C:\Users\Sujan Ajay\Desktop\catalog-module\.runs\2026-11-03-streamoid-rubick.md`) plus our own prototype (`M8-S0`) decide. M8 and M9 updated | R4 |
| Q5 | If Saudi sites block our scraper, may we pay for a Saudi proxy up to USD 100 a month without asking again? | KSA gallery counts and live checks | Yes, up to USD 100 a month | **Answered (2026-11-03):** Decodo residential (HTML only) primary, Zyte API backup; trial first to prove Saudi and UAE pages load | R2 |
| Q6 | Do you accept the recommended answers for the image-side high conflicts C06, C07, C11, C14, C16, C20 and C24 as one group? | M5-S3 makes every batch follow the rule versions; undecided rules stay as warnings | Accept all as recommended in `requirements/M5-channel-rules.md` | **Answered (2026-11-03):** C06 and C07 keep what is in code; C11, C20, C24 as recommended; C14 on-model required for all adult softline incl. footwear, accessories, lingerie, swimwear; kids need no person; C16 units as recommended and never create a size chart without brand data. See M5-F2-R4 | R1 |
| Q7 | May medium and low rule conflicts be accepted automatically with the recommended answer after 14 days with no decision? | Keeps the conflict list from growing without you; you can reopen any later | Yes | **Answered: yes,** and all 17 remaining conflicts are decided with the recommendation (C19 per M5-F2-R4) | R2 |
| Q8 | Who owns measurement on the business side, and who holds the list of which options are treated and which are control? | The arm list must stay away from the ads and merchandising teams | You own it; the arm list stays in the system and with you only | **Answered: yes, Sujan owns measurement** | R2 |
| Q9 | Can we get two native Arabic readers for a few hours a week? | Arabic text and infographics need a human calibration set (M8-S2, M11-S3) | Two readers from the catalog or channel team; agency if none | **Answered: yes** | R4, R6 |
| Q10 | Will the channel team bulk-upload the treatment, click "Uploaded" in the tool, and re-upload "Improved" items? May we send the blind-arms letter to the ads and merchandising agencies? | Noon and Namshi have no API; the clock starts only when the treatment is live; outside edits would spoil the test | Yes to both; the letter says a test runs, not which options are in it | **Answered: the default** | R2 |
| Q11 | Text conflicts C01 (title formula), C03 (bullet count) and C04 (bullet length): accept the recommendations? | M8 text generation cannot start for a channel while these are open | C01: Brand + Gender + Product Type + Key Feature or Material. C03: generate exactly 5, check 4-5, Trendyol 5-7. C04: per channel (Noon and Namshi 80, Myntra 100, Trendyol 160, Amazon 100-250) | **Answered: the default** | R4 |
| Q12 | Is USD 0.25 per product an acceptable ceiling for AI text (all channels, English plus Arabic)? | Sets the vendor choice and the cost cap for M8 | Yes, USD 0.25 | **Answered: the default** | R4 |
| Q13 | What budget may we spend on the vendor bake-off, and do you approve paid generation and overflow vendors once they pass, provided their terms say they do not train on our images? | Generated images and overflow matting need paid contracts (gate G4) | Bake-off up to USD 500; paid use only after the bake-off and a no-training clause | Default applies until the owner says otherwise | R3 |
| Q14 | Will you ask the channel managers: crops allowed on Styli and Centrepoint; Noon and Namshi stance on AI-made images; text overlays (C19); Arabic text limits; Namshi image rules; video slots; Trendyol API credentials? | These rules are "assumed" today; a wrong guess means rejections | Until answered: crops only, no generated images and no overlays on Noon and Namshi | **Answered (2026-11-03):** Styli and Centrepoint never take crops. Noon and Namshi accept AI-made images. Infographics assumed accepted in the Noon gallery, English only for now (Arabic on images later). Namshi rules are the ones live in the product. Video only where accepted (Noon, Amazon, Trendyol); later scope. Trendyol API: none today; later, not now (owner 2026-11-03) | R2, R3, R6 |
| Q15 | Do we hold rights to use brand models' likeness in generated images, per brand? | Generated shots with people need it (M3, M11, M12) | Was: no generated people until a brand confirms in writing | **Answered: yes.** Opptra has complete rights to brand models' likeness. Applies to brands Opptra holds distribution rights for. Generated images may use the brand's own models (reference photos taken from the brand's website), the exact model, or a lookalike. The owner sets a per-brand likeness flag; generated people are allowed when it is on. M3, M11 and M12 updated | R3, R6 |
| Q16 | May we create a temporary Cloud SQL instance for load tests, deleted after each test? | Load tests must not run on the shared `ila-pg` while users are active | Yes, under USD 50 per test | **Answered: yes,** in project `image-links-agent` | R2 |
| Q17 | India pilot access: the Amazon.in SP-API token and the Cortina Myntra and Flipkart templates | The India pilot cannot start without them | Ask the India team | **Answered: India is out of scope for now** (see `roadmap.md` section 15) | - |
| Q18 | Which legal route do we take for faces under UAE and KSA data protection law (consent, licensed models, or none)? | Face work needs a lawful basis for biometric data | No faces until legal confirms a route | **Resolved by design: no biometric data stored.** The owner says the law is not an issue for us (2026-11-03); the design is unchanged because it needs no biometric data anyway. No face embeddings or biometric templates are stored anywhere. Identity consistency comes from using the brand's own model reference photos as generation inputs, a visual similarity check computed in memory and discarded, and the sampled human audit. M11 and M12 updated | R6 |
| Q19 | For self-serve: what is the pricing unit, and where must customer data live? | Billing and data separation (M12-F5 to F7) are designed around both | Per product processed; data in the region of the customer's main market | **Answered: the default** | R7 |

## C. Answered without you in the integration pass (recorded in the module docs)

So you can check them if you want; none needs a decision.
- Daily (not weekly) gallery scrape for treated listings (M4 D, M9).
- One image matcher threshold (6, uncertain 7 to 12) (M0 F3-R10).
- One audit rule for images and text (M7, M8).
- No output is ever held: missing checks mean provisional and flagged (M1, M3, M7).
- Default channels come from the brand's setting, then where the product is listed (M1, UX).
- `org_id` on every new table now; you are the only owner until roles exist (M12).
- UX: IBM Plex fonts, rename to "Catalog", 48 hours before a "needs you" item falls back to its safe default, email
  until a chat tool is chosen, the catalog lead runs usability rounds (UX section 17).
