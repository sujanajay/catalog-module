# M8 Text, attributes and Arabic - requirements (draft)

Planning only. Follows `00-template.md`. Feature ids follow the row order of the M8 table in `../module-map.md` (M8-F1 is
the first row). M8 has no P0 feature: nothing here is in the first slice; M8 ships in release R4 (`../roadmap.md`). Gate 1
said Streamoid and Rubick are checked **before** any text is built. Owner answer Q4 replaced the vendor demos with a
website teardown of both vendors (report: `C:\Users\Sujan Ajay\Desktop\catalog-module\.runs\2026-11-03-streamoid-rubick.md`) plus our own prototype (M8-S0), so every P1
feature below states what the teardown and prototype must answer and the buy or build rule. Words defined once: **text** means the title, bullets, description and backend keywords of one listing;
**grounded** means every claim in the text comes from a fact we hold; **machine-literal** Arabic is Arabic produced by
translating the English sentence word by word, which gate 1 rules out; **search term** is what a shopper typed (we only have
paid-ad search terms, see M8-F3).

## 1. Purpose

97% of products have no usable description (53% of master descriptions are just the SKU code; master titles have a median of
21 characters), and nobody sells marketplace-native Arabic checked against channel rules. M8 writes grounded English and
native Arabic titles, bullets, descriptions and keywords per channel, to M5's rules, and takes winning keywords from M10.
Outcome metric: text completeness per channel and language (baseline about 3%), then conversion through M4. Intents: I037,
I039, I042, I014, I017, I041.

## 2. Scope

**In (P1, after the buy or build decision):**
- Titles, bullets, descriptions and backend keywords per channel for Noon, Namshi, Trendyol and Amazon.ae, then Styli and
  Centrepoint once M5 has their content rules.
- Native Arabic for Noon and Namshi (and Amazon.ae where the file has Arabic fields), written from facts, not translated.
- Arabic labels for our attribute values (for Arabic columns of listing files).
- Keywords from paid search terms (Amazon Ads, Noon ads) and the receiving end of M10's keyword winners.
- Size chart data: one stored unit, shown per market.

**Out:**
- Reading attributes from photos or brand sheets: that is M2-F3 (product facts). M8 only uses facts M2 marks trusted.
- Mapping our attribute words to each channel's words: that is M2-F4 (taxonomy mapping).
- Checking rules: M5 holds them; M7 runs judgement checks (bilingual consistency M7-F9, planted defects M7-F5).
- Filling listing files and getting them live: M9.
- Per-SKU approval of text. Auto-decide plus a sampled audit (gate 1).

**Later:**
- Arabic keyword research from Noon queries and public search suggestions (M8-F5, P2).
- Hindi and regional text for India channels (M8-F6); answer-engine copy (M8-F7).
- A+ text blocks for Amazon.in (the Cortina pilot asks for titles, bullets and A+; A+ modules are M11, which will take its
  text from M8).
- India channels next (Amazon.in, Flipkart, Myntra) in English: same generator, new M5 rules; planned as M8-S6.
- India is out of scope for now (owner answer Q17): every India item in this file waits and is in no release
  (`../roadmap.md` section 15).

## 3. Contracts

### 3.1 What M8 reads and writes

| Direction | Entity or event | With whom | Notes |
|---|---|---|---|
| Reads | `Product`, `Listing`, brand master row, existing text versions | M0 | Never writes back to masters |
| Reads | Trusted facts per product (`readProductFacts`, contract version 1 of `08-product-facts.md` section 4.14) | M2 | Untrusted, conflict and unknown facts are never stated |
| Reads | Channel words for attributes (`mapFactsToChannel`) | M2-F4 | Only `documented` or `confirmed` mappings |
| Reads | Ruleset snapshot and `evaluate()` | M5 | Limits, formulas, banned words, Arabic rules |
| Reads | Control flag "do not touch" and experiment arm | M4 via M0 | Text of a control listing is never changed |
| Reads | Source text: Trendyol product name and description (`gcc_channel_reports.product_list_trendyol_3p_*`), brand sheets | BigQuery, M2 | Trendyol text is our own; it is source material, never copied unchecked |
| Reads | Search terms: `raw_amazon_adservice.search_term_daily` (AE and SA seller profiles), `raw_gcc_tables.campaign_noon_3p_*_product_queries` | BigQuery | Paid only; deduplicate by `tier` and fetch before summing |
| Writes | `ContentVersion` of role `title`, `bullets`, `description`, `backend_keywords`, `size_chart` per channel x market x language, with source `generated`, vendor, model, prompt version, input fact ids and hash | M0 | Every output versioned (M0-F2) |
| Writes | `ChangeReason`: `new_text`, `rule_change`, `keyword_winner` (with winner id), `rejection_fix` (with rejection id) | M0 | Lets M10 and M4 attribute effects |
| Emits | `text.generated` {batchId, productId, channel, language, versionIds, rulesetVersion, costUsd} | M7, M9, M6 | M7 samples audits from it |
| Receives | `learning.keyword_winner` (section 3.2) | M10 | The cross-pollination hook |
| Answers | `text.keyword_winner_applied` (section 3.2) | M10, M0 | One answer per winner per listing set |

### 3.2 The keyword winner interface (for M10 cross-pollination)

M10 will push winning keywords (I039: "a winning search term updates the title, backend terms and infographic in one change
set"). M8 owns the receiving end now so M10 can be built against it later.

```ts
// Event on queue topic "learning.keyword_winner" (Cloud Tasks or Pub/Sub, same pattern as other worker tasks).
interface KeywordWinner {
  winnerId: string;                       // stable; re-sending the same id is a no-op (idempotent)
  action: "add" | "promote" | "demote" | "remove";
  term: string; language: "en" | "ar";
  normalized: string;                     // lower case, Arabic normalised (alef, taa marbuta, yaa forms; no diacritics)
  scope: { channel: string; market: "AE" | "SA" | "IN" | null; categoryPath: string[]; brandId: string | "all" };
  targets: ("title" | "backend_keywords" | "bullets" | "description" | "infographic_text" | "qa")[];
  evidence: {
    source: "amazon_ads_search_term" | "noon_product_query" | "experiment" | "pooled_estimate";
    metric: string;                       // e.g. "ad conversion rate" or "ordered units"
    effect: number; ciLow: number; ciHigh: number; n: number;
    window: { from: string; to: string };
    experimentId: string | null;          // M4 registry id when it came from an experiment
  };
  validUntil: string | null;              // the winner expires and is re-tested after this date
  maxListings: number | null;             // M10 can cap the rollout (for a staggered design)
}

interface KeywordWinnerApplied {
  winnerId: string;
  changeSetId: string;                    // one M0 change set for every listing and target touched
  results: {
    listingId: string; target: KeywordWinner["targets"][number];
    outcome: "applied" | "skipped";
    reason: null | "control_arm" | "not_relevant_to_product" | "rule_limit" | "banned_word" | "brand_rule"
          | "already_present" | "language_mismatch" | "target_not_owned_by_m8";
    versionId: string | null;             // the new content version when applied
  }[];
}
```

Rules for the receiving end:
- M8-C-R1. A winner is applied only where it is relevant to the product: the term's product words must match the product's
  type and trusted facts (a "linen shirt" term never goes on a cotton shirt). Relevance is a deterministic check on facts
  first; a model call only when the term has words not in our vocabulary.
- M8-C-R2. Never on a listing in a control arm or frozen experiment (reason `control_arm`).
- M8-C-R3. Every changed text passes M5 again; a failure skips that target with the rule as reason. The title is rewritten
  as a whole (not appended) so it still follows the channel formula.
- M8-C-R4. `infographic_text` and `qa` are forwarded to M11 and M8-F7 when they exist; until then the result is `skipped` with
  `target_not_owned_by_m8`.
- M8-C-R5. All listings changed by one winner share one M0 change set with reason `keyword_winner`, so M10 can measure the
  propagated change as one treatment.
- M8-C-R6. `remove` and `demote` undo or lower a term the same way, with a new version (old versions are never edited).

### 3.3 Generation call shape

```ts
interface TextRequest {
  productId: string; channel: string; market: string | null; language: "en" | "ar";
  facts: TrustedFact[];                   // from M2, trusted only, each with an id
  sourceText: { kind: "trendyol" | "brand_sheet" | "master"; text: string }[];  // master text dropped when it is a SKU code
  rules: RuleSummary;                     // limits and formulas from the M5 snapshot, as plain numbers and lists
  keywords: string[];                     // from M8-F3 and active winners
  glossary: GlossaryEntry[];              // Arabic only: approved term per attribute value and channel
}
interface TextResult {
  title: string; bullets: string[]; description: string; backendKeywords: string[];
  claims: { span: string; factId: string }[];   // every factual phrase points at a fact id (grounding)
}
```

The call goes through the existing language model layer (`packages/core/src/llm/llm.ts`, OpenRouter chat completions, model
chosen by `model_policy`, cost read per call) behind the M7 vendor interface with a ranked fallback. No model name is
written in code.

### 3.4 Contract needs from M0

1. Content versions with M0 components `title`, `bullet` (one per position), `description`, `keyword` (backend terms),
   `size_chart`, keyed by option x channel scope x `market` x `language` (M0 3.1).
2. Change sets: M0's `change_set_id` on change events groups versions across listings and roles under one id with one
   reason (needed by C-R5). Reason kinds map to M0's list: `new_text` = `new_content`, `rule_change` = `rule`,
   `keyword_winner` = `learning` (winner id in `reason_ref`), `rejection_fix` = `rejection_fix`.
3. The control flag and experiment arm readable per listing.
4. Fact ids stable across versions so `claims` stay traceable.
5. `route_id` and `prompt_version` on each generated version (M0 3.1); cost joins from M6's ledger by version id.

## 4. Features

### M8-F1 Titles, bullets and descriptions per channel (P1)

**Story.** As an operator, when a batch finishes, every product has a title, bullets and a description for each ticked
channel, in that channel's limits, saying only what is true about the product, without my typing or reviewing anything.

**Key requirements.**
- M8-F1-R1. Text is written per channel from the same facts, to that channel's M5 rules: Noon title 150, Namshi 200 (warn
  above 150), Trendyol 100, Amazon 150, Myntra 90 (warn above 60); bullets exactly 5 (Trendyol 5 to 7) once C03 is decided;
  bullet length per channel once C04 is decided (Noon and Namshi 80, Myntra 100, Trendyol 160, Amazon 100 to 250);
  description under 1,000 characters (Trendyol up to 30,000). Generation for a channel waits while C01, C03 or C04 is open
  (M5-F2-R5).
- M8-F1-R2. Title formula from M5 (C01 recommendation: Brand + Gender + Product Type + Key Feature or Material; colour and
  size stay in variant attributes). Starts with the exact brand spelling (M5-F7).
- M8-F1-R3. **Grounded only.** Every factual phrase (material, fit, sleeve, neckline, care, origin) maps to a trusted fact id
  in `claims`. A phrase with no fact behind it fails M7's grounding check and is removed before publish. Material, care,
  country of origin and fit come only from brand data (as in `08-product-facts.md`); with no brand data the text does not
  mention them.
- M8-F1-R4. Master description text that is the SKU code, under 40 characters, or a code pattern is ignored as source (the
  census found 53% of rows are just the SKU code). Trendyol text is used as source material when present (77-100% coverage,
  median 226 to 667 characters by brand), re-written to the target channel's rules.
- M8-F1-R5. Bullets follow the playbook's five slots (material and quality, fit and comfort, key feature, use case, care)
  and never repeat what the product detail table already holds (playbook L725-733); no end punctuation as a warn.
- M8-F1-R6. Auto-decide: text that passes M5 and M7 is published as a provisional version at once; text that fails is
  regenerated up to 2 times (admin setting), then the product gets no text for that channel and the digest counts it with the
  reason. Never a per-product card.
- M8-F1-R7. A 2-5% random audit sample per batch (M7-F3) is read by a person after links are out; failures feed M7's
  automatic promotion and relapse per category.
- M8-F1-R8. Brand-written text (from a brand sheet) is kept as a separate source version; whether ours or the brand's goes
  live is a brand rule (M5-F7, default: brand text when it passes M5, ours otherwise).

**Non-functional.** Under USD 0.03 per product for all slice channels in English (judgement; set by owner after the
prototype); under 10 s per product at p95, 2,000 products in under 30 minutes with the batch's own concurrency; survives a
deploy (M6-F2) by resuming from the last saved product.

**Admin configuration.** Prompt templates and their version, regeneration count, audit rate, brand text preference, the
vendor ranking (M7), cost ceiling per product.

**Human in the loop.** None per product. The sampled audit is permanent (2-5%). A person checks any claim about product
truth only through the audit; a failing cell follows M7's one audit rule (back to 10% until 100 clean answers; two fails
of the same cause in 7 days pause text generation in that cell).

**Edge cases.** Product type unknown (no text; digest: "product type unknown"). No trusted facts at all (title from brand,
gender and product type only; no bullets; digest counts it). Multipacks and sets (title states pack count only when the pack
count fact is trusted). Kids products (no body or fit language; kids word list in M5). A channel limit shorter than the
brand name plus product type (keep brand and type, drop the rest, warn).

**Buy or build.** Buy the language model (two ranked vendors plus a fallback through M7). Build the rules, grounding,
templates and checks. Decision on buying a whole text product (Streamoid or Rubick) waits for the teardown and prototype
below.

**The Streamoid and Rubick teardown plus our prototype (decides M8 and M9; no vendor demos, owner answer Q4).** Inputs:
(1) the website teardown of Streamoid and Rubick (public product pages, documentation, case studies, pricing and terms;
report at `C:\Users\Sujan Ajay\Desktop\catalog-module\.runs\2026-11-03-streamoid-rubick.md`); (2) our own throwaway prototype (M8-S0) on a 30-product pack from the
golden set (20 GCC apparel across at least 6 brands, 4 footwear, 2 bags, 2 lingerie, 2 kids; the 2 Cortina curtains of
the earlier pack are dropped while India is out of scope) with photos, master rows and Trendyol text, producing Noon
English plus Arabic, Namshi and Amazon.ae text and a filled Noon file. Native Arabic speakers rate the prototype blind
against the existing live text. Anything the teardown cannot show from public sources counts as "not shown".

What the teardown and prototype must answer for text:
1. Does the vendor generate Arabic natively from attributes, or translate the English? (Prototype: show both for 5
   products.)
2. Which Arabic register (Modern Standard, Saudi, Emirati)? Can it be set per channel?
3. How are invented facts stopped? Can a claim be traced back to an input field?
4. Can our own rules (limits, formulas, banned words, brand spellings) be loaded as data and changed by a non-engineer?
5. Which GCC channels have per-channel limits built in today (Noon, Namshi, Styli, Centrepoint, Amazon.ae)? Is there a
   public example output for each?
6. Where does keyword data come from for Noon and Amazon.ae, and in Arabic? Can we push our own terms in?
7. Is per-attribute accuracy published, or measurable by us?
8. Can it run 2,000 products with no per-item accept step?
9. API and export: does every output come back with our ids, and can rejections be sent back in?
10. Price per product per channel and language; who owns outputs; is customer data used for training.

**Decision rule (buy or build).** Build on bought models (two ranked vendors plus a fallback through M7) unless the
teardown shows public evidence for all of: (a) native Arabic from attributes with a register that can be set per channel;
(b) claims traced to inputs; (c) our rules loadable as data; (d) an API that returns every text with our ids and accepts
our rules and keyword winners; (e) no per-item acceptance; (f) a price within the owner's ceiling (USD 0.25 per product
for all slice channels and both languages, owner answer Q12) and no training on our data. If all six are shown, Sujan may
approve a paid trial (gate G4) on the same 30-product pack, scored against our prototype with these bars: Arabic blind
rating mean of 4.0 or more out of 5 from at least two native raters and at least 0.3 above our prototype; at most 1
invented fact in all outputs; outputs pass our M5 checks for Noon and Namshi with no edits other than commercial fields.
Buy or partner only if the trial clears every bar. Consider a partner only for what they clearly do better.

**Acceptance test (as an operator).** Run a real 200-product Vero Moda and French Connection batch with Noon, Namshi,
Trendyol and Amazon ticked: every product with a known product type gets text per channel that passes M5; zero per-product
cards; a 5% audit by a person finds no invented fact; cost per product is shown in the cost meter.

### M8-F2 Arabic and bilingual text (P1)

**Story.** As a Saudi or Emirati shopper on Noon, the Arabic title and bullets read as if a Gulf copywriter wrote them, state
the same facts as the English, and fit the channel's rules.

**Key requirements.**
- M8-F2-R1. **Never machine-literal.** Arabic is generated from the same trusted facts and an Arabic glossary, with its own
  Arabic templates for title order and bullet slots. It is never produced by translating the English text. A test fails the
  build if the Arabic generator receives the English text as input.
- M8-F2-R2. Register: Modern Standard Arabic that reads naturally in the Gulf, no Egyptian or Levantine dialect words (M5-F8
  list). Per channel setting in case Noon KSA and Noon UAE differ (default: one register).
- M8-F2-R3. Glossary as data: one approved Arabic term per attribute value and product type per channel (for example the
  Arabic for "crew neck" Noon uses), written and approved by a native speaker. A missing glossary term means the attribute is
  left out of the Arabic text, never guessed.
- M8-F2-R4. Brand names: the brand's approved Arabic spelling if it has one, else Latin script (M5-F7). Model codes, sizes
  and "100%" stay as written. Digits Western by default (M5-F8).
- M8-F2-R5. Checks before publish: M5 Arabic rules (length in Unicode characters, banned words with normalisation, digits,
  direction); M7-F9 bilingual consistency (the facts stated in Arabic equal the facts stated in English); gender and number
  agreement as a judgement check.
- M8-F2-R6. Arabic attribute labels: every vocabulary value of M2 gets an Arabic label from the glossary, used in Arabic
  columns of listing files (M9-F2). A value with no Arabic label leaves that Arabic cell blank and shaded.
- M8-F2-R7. **Calibration, then sampling.** Before Arabic goes live on a channel, two native raters score a 100-product
  calibration set blind (fluency, accuracy, naturalness, 1 to 5). Live only when the mean is 4.2 or more and there are zero
  factual mismatches. After that, a native speaker reads a permanent 2-5% sample per batch.

**Acceptance test.** On a 100-product calibration set for Noon UAE and KSA, two native raters give a mean of 4.2 or more with
zero factual mismatches; a planted English-to-Arabic literal translation is rated lower than our output by both raters; M7's
consistency check catches a planted Arabic colour that differs from the English.

**Buy or build.** Buy the model, build the glossary, templates and checks. Candidates for the bake-off (M7-F7): the general
models already behind OpenRouter, plus Arabic-first models such as Jais and ALLaM (named from memory, not verified in this
study; verify availability and terms before the bake-off). The teardown and prototype questions 1, 2 and 7 decide whether
a vendor's Arabic beats ours. Agencies (Proxima) are the fallback for the calibration set only, not for production.

**Open questions.** Who are the native raters? Default: two Arabic-native Opptra staff from the Noon and Namshi teams for the
calibration set, one for the ongoing sample; agency only if staff are not available. Noon's real Arabic title limit is
unknown; default: same as English, as a warn.

### M8-F3 Keywords from paid search terms (P1)

**Story.** As the catalog lead, titles and backend keywords use the words shoppers actually type and buy with on Amazon.ae
and Noon, not guesses.

**Key requirements.**
- M8-F3-R1. A daily job reads Amazon Ads search terms (AE and SA seller profiles, Sponsored Products) and Noon product
  queries from BigQuery, deduplicates by `tier` and fetch, and keeps per category and language: impressions, clicks, orders
  and conversion over a rolling 60 days.
- M8-F3-R2. Terms are mapped to our categories through product types and trusted facts; a term is a candidate for a product
  only if it is relevant (M8-C-R1).
- M8-F3-R3. Titles include the top relevant converting term when it fits the channel limit; Amazon backend keywords get
  further terms up to 250 bytes, not repeating title words (C21); Noon, Namshi, Myntra 8 to 10 phrases as a warn; Trendyol has
  no backend field.
- M8-F3-R4. Every term carries its source and numbers into the content version, so M10 can later test it.
- M8-F3-R5. M8 accepts `learning.keyword_winner` (section 3.2) and answers with `text.keyword_winner_applied`.

**Acceptance test.** For one category (women's tops on Amazon.ae), the job lists the top 20 converting search terms with
numbers matching a hand query on `search_term_daily`; a generated title for a matching product includes the top relevant
term within 150 characters; a planted winner event updates titles and backend keywords on matching non-control listings in
one change set and skips a control listing with `control_arm`.

**Buy or build.** Build. Helium 10 and Jungle Scout use amazon.com data; nobody has Noon or Arabic data. The GCC Amazon
volume (about 140 softline units a week) does not justify a keyword database (M8-F8 Skip).

### M8-F4 Size charts (P1)

**Story.** As a shopper, the size chart is in the units my market uses and never mixes units; as the operator, I never type
a size chart into a listing file.

**Key requirements.**
- M8-F4-R1. One stored unit: centimetres for every length (C16). Display: cm for GCC channels, inches for India apparel, both
  on the chart image. Bra band and foot length always cm. A chart that mixes units fails.
- M8-F4-R2. Footwear: all four size systems captured (UK, US, EU, IN) with a conversion table; each channel shows its subset
  (Amazon UK, EU, IN; Myntra all four; GCC channels without IN) (C17).
- M8-F4-R3. Source: the brand's size chart (sheet or image). The census found no size chart data in any table, so this needs
  a brand input; a product without a brand chart gets no chart and the digest counts it per brand.
- M8-F4-R4. Output: the chart as data (for listing file columns) and as an image drawn by code (no model), English first;
  the Arabic and right-to-left chart image follows M5-F8 layout rules.

**Acceptance test.** Load a Vero Moda size chart in inches; the stored version is in cm; the Noon chart image shows cm, the
India chart shows inches, and a planted chart with one row in inches and one in cm is refused.

**Buy or build.** Build. Nobody covers GCC and India size systems together.

### M8-F5 Arabic keyword research (P2)

Arabic search terms from Noon product queries (paid) and public search suggestions on Noon and Amazon.ae, tested through
M10. Needs M8-F2 live first. Build.

### M8-F6 Hindi and regional text (Later)

Hindi and regional titles for Flipkart and Amazon.in after English India text works (M8-S6). Same grounding and glossary
pattern as Arabic. Buy model, build rules.

### M8-F7 Answer-engine copy (Later)

Question-and-answer copy for AI shopping assistants (Salsify and Jasper offer it). Receives `qa` keyword winners when built.
Buy.

### M8-F8 Amazon keyword database (Skip)

Skipped: Amazon GCC is about 140 softline units a week. Buy access to Helium 10 or Brand Analytics only if Amazon.in volume
needs it.

## 5. Operator experience

The operator does nothing for text. What she sees:

- **Batch digest** gains one block: "Text: 1,912 of 2,000 products have titles, bullets and descriptions for Noon, Namshi,
  Trendyol and Amazon. Arabic: 1,880 for Noon and Namshi. 88 have no text: product type unknown (52), no facts (36). See the
  exceptions sheet."
- **Downloads**: "Download text sheet" next to the links sheet: one row per product, columns per channel and language. The
  same text also goes into the listing files (M9-F2).
- **Product page**: a "Text" section shows the live version per channel and language, its source facts (hover a phrase to
  see the fact), and history. Read-only for operators; no Confirm button (no per-SKU review).
- **Admin, "Text settings"** (moves to M12 later): prompt templates with versions, glossary editor (Arabic terms per
  attribute value and channel, with an "approved by" field), audit rate, cost ceiling, brand text preference.
- **Auditor's view**: the 2-5% sample as a simple list with "Pass" or "Fail: <reason>" per product, English and Arabic side by
  side. This is the only human step, and it never blocks a batch.

Key copy:
- Waiting on rules: "Text for Noon waits until conflict C04 (bullet length) is decided. Ask the owner."
- Calibration not passed: "Arabic for Namshi is not live yet: the calibration set scored 3.9 of 5 (needs 4.2)."
- Cost guard: "Text stopped for this batch: cost reached the ceiling of USD <x> per product. Images and links are not
  affected."

## 6. Measurement

| Metric | Baseline | Target | Data source |
|---|---|---|---|
| Text completeness per channel and language (title, 5 bullets, description present and passing M5) | about 3% (census: 97% without a usable description) | 90% of products with a known product type, per slice channel, 4 weeks after M8 goes live | M0 content versions + M5 results |
| Arabic completeness on Noon and Namshi | 0% | 85% | same |
| Invented facts reaching a channel per 1,000 products | unknown | 0 in the audit sample; under 1 per 1,000 in planted-defect tests | M7 audit and grounding check |
| Arabic native rating (calibration and sample) | none | mean 4.2 or more | auditor scores |
| Cost per product (text, all channels and languages) | none | under owner ceiling; default USD 0.25 | M6 cost meter |
| Top converting search terms present in titles (Amazon.ae) | unmeasured | 70% of products in categories with search-term data | M8-F3 job + content versions |
| Lift on orders from text (pre-registered experiment through M4) | none | readout at the point M4 pre-registers; expected small, MDE about 18% | M4 |
| India (out of scope for now): IDQ on Amazon.in for Cortina | 64% (Catalog v2) | 90% (Catalog v2 target) | the Amazon.in report the Cortina team uses (IDQ has no published formula; open question) |

## 7. Build slices

All slices after the buy or build decision, except M8-S0. Release R4 (`../roadmap.md`).

| Slice | What | Depends on | Acceptance test |
|---|---|---|---|
| M8-S0 | Throwaway prototype on the 30-product pack (English plus Arabic, Noon, Namshi, Amazon.ae), the blind rating sheet and the buy or build memo that applies the M8-F1 decision rule to the teardown report and the prototype scores | golden set rows (M7-F1), the Streamoid and Rubick teardown report | Memo with the teardown evidence per question, our prototype scores and the decision rule outcome; owner decides |
| M8-S1 | English generator for Noon, Namshi, Trendyol, Amazon.ae: request shape, grounding, M5 checks, regeneration, versions in M0, cost logged | M0-F2, M2-F3 trusted facts, M5-S2, C01, C03, C04 decided, M7 vendor interface | M8-F1 acceptance test |
| M8-S2 | Arabic: glossary data and editor, Arabic templates, normalisation, direction tests, calibration run, sample audit view | M8-S1, M5-F8 seed rules, M7-F9 | M8-F2 acceptance test |
| M8-S3 | Search term job and keyword placement; `learning.keyword_winner` receiver and answer | M8-S1, M0 change sets, M4 control flags | M8-F3 acceptance test |
| M8-S4 | Size chart data, conversions and chart image | M5 size chart rules, a brand chart file | M8-F4 acceptance test |
| M8-S5 | Text sheet download, digest block, product page section, text settings screen | M8-S1 | An operator finds every text of a batch in one sheet without help |
| M8-S6 (out of scope for now: India) | India English text: Amazon.in, Flipkart, Myntra rules in M5; Cortina curtains (single front image, home textile facts) | M5 India rules, M5 curtain category, M2 non-fashion facts | Cortina 50-product run: titles and bullets pass Amazon.in and Myntra rules |

## 8. Risks and open questions

| Risk or question | Effect | Mitigation or recommended default |
|---|---|---|
| Few trusted facts (M2-F3 bars not yet met) | Thin text: brand, gender and type only | Text quality scales with trusted facts; digest shows "no facts" counts per brand; brand sheets fill material, care, fit |
| Text conflicts C01, C03, C04 undecided | M8 cannot start | They are on the M5 conflict register with "Blocks M8 text"; answered by the owner: the recommended answers apply (Q11) |
| Arabic quality judged by too few people | False confidence | Two blind raters plus a third to settle; planted literal translation as a control |
| Vendor Arabic beats ours | Building wasted | The teardown and prototype come first; the decision rule is written before the teardown report is read |
| Noon and Namshi Arabic limits and required fields unknown | Rejections | Warn-only rules until the Noon manager answers (M5-F5); M9 rejection learning adds rules |
| Search terms are paid only and small in volume | Weak keyword signal | Pool by category; keep source numbers on every term; M10 tests winners |
| A keyword winner changes a control listing | Biased experiment | Control flag check (M8-C-R2) with a test |
| IDQ formula is not published | India target cannot be checked by us | Default: use the IDQ number the Cortina team reads in Amazon.in; ask the Amazon India account team for the definition |
| Cost of two languages times many channels | Cost per product rises | Generate facts-to-text once per language and derive channel lengths from it where rules allow; cost ceiling setting |

## 9. Integration decisions

| # | Decision | Why |
|---|---|---|
| D1 | Audit relapse follows M7's single rule (10% until 100 clean answers), not "audit 20%" | M8 and M7 disagreed |
| D2 | M8's content roles and reason kinds map onto M0's enums (3.4 items 1-2); change sets are M0's `change_set_id` | Two vocabularies for the same fields |
| D3 | M8-S3 owns the one search-term job and writes `catalog_os.search_terms_daily`; M10 reads it | M8-F3 and M10 B.3 both read the paid search-term tables |
| D4 | The text audit view is a mode of M7's auditor screen | One auditor screen |
| D5 | The `learning.keyword_winner` topic stays a worker task queue between M10 and M8 (the existing Cloud Tasks pattern); it is not part of M0 | M0's no-queue rule covers the change log only |
| D6 | M8-S0 (the throwaway prototype on the 30-product pack) is allowed before the buy or build decision; it is a comparison, not the build that gate 1 deferred | Gate 1: check the vendors before building text |
| D7 | Open questions answered: Noon Arabic title limit = English limit as a warn until the channel answers; IDQ for Cortina = the number the Cortina team reads in Amazon.in | Defaults that need no owner input |
| D8 | Kept for the owner (`../owner-questions.md`): C01, C03 and C04; the text cost ceiling; native Arabic raters; how to check Streamoid and Rubick | Content rules, money, people, vendor relationship |
| D9 | Owner answers: no vendor demos, the website teardown plus M8-S0 decide (Q4); C01, C03, C04 recommended answers (Q11); USD 0.25 per product text ceiling (Q12); two native Arabic readers (Q9); India out of scope (Q17), so M8-S6, M8-F6 and the India metric row wait | Owner decisions recorded in `../owner-questions.md` |
