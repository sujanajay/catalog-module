# M5 Channel rules engine - requirements (draft, 2026-11-02)

Planning only. Follows `00-template.md`. Feature ids follow the row order of the M5 table in `../module-map.md`
(M5-F1 is the first row). Words defined once: a **rule** is one checkable statement about one piece of content on one
channel ("Noon title: at most 150 characters"); a **ruleset** is the whole set of rules at one moment, with a version
number; a **snapshot** is a frozen copy of one ruleset version that a batch uses from start to end; a **conflict** is a set
of rules that cannot all hold at once; **evidence grade** is how much we trust the source (documented, reported, assumed,
playbook, defined in `.runs/2026-11-02-channel-rules.md`).

## 1. Purpose

Today 555 rules and 30 conflicts live in a playbook, specs and code constants, and code silently picks one answer. M5 turns
them into data a non-technical admin can read, edit and extend (new channel, category or brand), shows every conflict with
an owner decision, and gives every other module one way to check content. Outcome metric: rule violations that reach a
channel (measured through M9 rejections), plus "the next batch follows an admin edit". Intents: I021, I041, I023, I037, I026.

## 2. Scope

**In (first slice, P0):**
- The 555 rules and 30 conflicts loaded as data with evidence grade and source, as one versioned ruleset.
- A channel registry as data (replaces the constants in `packages/core/src/catalog/channels.ts`), a category tree as data,
  and brand scope on rules.
- A conflict register with options, a recommendation and a recorded owner decision.
- An admin editor: change a value, add a rule, add a channel, category or brand scope, see history, preview impact, publish.
- One pure check function every module calls; effective severity worked out from declared severity, evidence and conflicts.
- The image set policy per channel x category (M3-F4 is stored here) and channel render specs (canvas, margins, background).
- Settled decisions applied: background 240+ grey (C10), white for Amazon image 1; draft title lengths (C02);
  HSN format-only check (C27). (Shein image 1 white is kept as today's code does, as an `assumed` rule, not as a gate-1
  decision.)

**Out:**
- Generating or fixing content (M3, M8 do that); judging taste or truth (M7 does judgement rules); publishing (M9).
- Per-SKU approval of anything. Approvals apply to rule changes only.
- Editing the structure of the rule schema from the UI (settled: structure is not admin-editable until a second customer).

**Later:**
- India channels (Amazon.in, Flipkart, Myntra) as data rows once their asks come back (next after GCC; the registry must take
  them without code).
- Non-fashion categories (curtains, bedsheets, toys, cookware) with attribute schemas; the Cortina pilot needs curtains and
  bedsheets first.
- Reading Amazon product type definitions and the Trendyol attribute API into rules automatically (needs owner OK for API
  access; read-only).
- Roles beyond "admin" (M12-F4).

## 3. Contracts

### 3.1 What M5 reads and writes

| Direction | Entity or event | With whom | Notes |
|---|---|---|---|
| Reads | `Product` (brand, category path, garment group, audience), `Listing` (product x channel x market) | M0 | To scope rules |
| Reads | `Brand` (id, name, exact spelling) | M0 / M12 | Brand scope on rules; exact brand name for C23 |
| Writes | `RuleResult` rows attached to a `ContentVersion` | M0 | One row per failed or judged rule per version |
| Writes | `ChangeReason` of kind `rule` (rule id + ruleset version) | M0 | When content changes because a rule changed |
| Emits | `rules.ruleset_published` {rulesetId, version, changedRuleIds, publishedBy, reason} | all modules, M9-F6 | Starts re-enrichment later (P2) |
| Emits | `rules.conflict_decided` {conflictId, option, decidedBy, decidedAt} | M0 log, M12 | Decision log |
| Receives | `rules.rule_proposed` {fromModule, evidence, draftRule, supportingCount} | M9-F4 (rejection learning), M10 | Lands as a draft; an admin publishes |
| Receives | judgement results from M7 for `checkable: false` rules | M7 | M5 never calls a model |
| Serves | `getSnapshot(rulesetVersion)` and `evaluate(snapshot, subject)` | M1, M2, M3, M7, M8, M9 | Library call inside `packages/core`, no network |

### 3.2 Shapes

```ts
// One rule. Extends the record in .runs/2026-11-02-channel-rules.json with brand, language, status and decision fields.
interface Rule {
  id: string;                 // "R117"; stable across versions
  version: number;            // bumps on every edit
  channel: ChannelId | "all";
  market: "GCC" | "IN" | "AE" | "SA" | null;
  categoryScope: string;      // a category tree id, or "all"
  brandScope: string | "all"; // a brand id, or "all"
  language: "en" | "ar" | "any";
  component: "image" | "title" | "bullets" | "description" | "keywords" | "attributes" | "size_chart" | "a_plus" | "video" | "file";
  field: string; operator: Operator; value: unknown; text: string;   // text = the plain sentence an admin reads
  declaredSeverity: "block" | "warn";
  evidence: "documented" | "reported" | "assumed" | "playbook";
  confirmedBy: string | null; // an owner or channel manager decision id that confirms a playbook or assumed rule
  source: string;             // file:line or decision id
  conflictsWith: string[];
  checkable: boolean; judgeMethod: string | null;
  status: "draft" | "active" | "superseded" | "retired";
  reason: string;             // why this version exists, required on every edit
  createdBy: string; createdAt: string;
}

interface RulesetSnapshot {
  id: string; version: number; hash: string; publishedAt: string;
  rules: Rule[]; channels: ChannelRecord[]; categories: CategoryNode[]; imagePolicies: ImagePolicy[];
  conflicts: ConflictRecord[];
}

interface Subject {               // what is being checked
  channel: ChannelId; market: string | null; brandId: string; categoryPath: string[]; language: "en" | "ar";
  component: Rule["component"]; contentVersionId: string | null;
  value: unknown;                 // the title string, the bullet list, the measured image facts, the attribute map
}

interface RuleResult {
  ruleId: string; ruleVersion: number; outcome: "pass" | "fail" | "not_applicable" | "needs_judge";
  effectiveSeverity: "block" | "warn"; measured: unknown; message: string;  // message in plain words, with the numbers
}

declare function evaluate(snapshot: RulesetSnapshot, subject: Subject): RuleResult[]; // pure: no I/O, no clock, no model
```

`ChannelRecord` carries what `ChannelSpec` in `channels.ts` holds today (min and target canvas, margins, anchor,
background, first image background, dpi, fixed canvas, uniform scale) plus: markets, languages (for example Noon: en, ar),
status, push method (`portal_file`, `managed_by_channel`, `api_read_only`), file kind (for M9), and owner (the channel
manager). `ImagePolicy` is the ordered shot list per channel x category (two layers, as C20 recommends: Layer A photographs
from 01/02, Layer B add-on slots such as size chart and video).

### 3.3 Queue and storage

- Rules, versions, conflicts, decisions and snapshots live in Postgres (`catalog` database), new tables only.
- A published snapshot is also written once as JSON to private storage (`rules/snapshots/v<version>.json`). A batch stores
  its snapshot version at start; every retry, chunk and finalize of that batch uses the same snapshot, so a batch survives a
  deploy and a mid-batch edit (M6-F2).
- Daily export of `rules`, `conflicts` and `rule_results` to BigQuery `catalog_os.*` with the M0 export.

### 3.4 Contract needs from M0

1. A stable `categoryPath` and `garmentGroup` on every product: from M2's `ProductReading` taxonomy node (joined by
   option id; M0 does not copy it), else from the master. Unknown category must be an explicit value, not blank.
2. (Owned by M5, not M0.) A `catalog_rule_results` table in M5's own migration, keyed by M0 content version id, with
   ruleset version, so a later readout can say which rules a live listing passed.
3. A `ChangeReason` kind `rule` that carries rule id and ruleset version.
4. A brand record with the exact brand spelling (for the "&" exception in C23 and brand-scoped rules).
5. The control flag from M4 ("do not touch") readable by any module that acts on a rule change.

## 4. Features

### M5-F1 Rules as data (P0)

**User story.** As an admin, I open one page and see every rule for Noon tops in plain sentences, where each came from and
how sure we are, so I never have to read code or the playbook to know what the system enforces.

**Functional requirements.**
- M5-F1-R1. A seed job loads all 555 rules and 30 conflicts from `.runs/2026-11-02-channel-rules.json` as ruleset version 1.
  It is "check then insert": running it twice adds nothing and changes nothing.
- M5-F1-R2. Every rule keeps its id, channel, market, category scope, component, field, operator, value, text, declared
  severity, evidence grade, source, conflict links and checkable flag exactly as in the dataset. New fields get defaults:
  `brandScope = all`, `language = any` (or `en` for title, bullet, description and keyword rules), `status = active`,
  `confirmedBy = null`.
- M5-F1-R3. The channel registry is seeded from `channels.ts` for the nine current channels with the same numbers, and a
  parity test proves the seeded records equal today's constants before any decision is applied.
- M5-F1-R4. The settled decisions are applied as ruleset version 2, each with `confirmedBy` set to the gate-1 decision id:
  - C10: background grey at RGB 240 or more (default `#F0F0F0`) for every channel image; image 1 pure white `#FFFFFF` on
    Amazon. `channels.ts` `GREY = "#E0E0E0"` stops being the source. Shein image 1 white (today's code) is loaded as a
    separate rule with evidence `assumed` and `confirmedBy = null`, because gate 1 named only Amazon.
  - C02: Noon title 150 (block); Namshi 200 (block) and 150 (warn); Trendyol 100; Amazon 150 (the "1509" read as a typo);
    Myntra block above 90, warn above 60; the 60 minimum is a warn only where the channel maximum is 100 or more.
  - C27: HSN check is format only (digits, 4 to 8 long; chapter 61 or 62 for apparel, 64 for footwear). The playbook's HSN
    lists are stored as `retired` with reason "finance has not supplied a table".
- M5-F1-R5. Rules scope by the one taxonomy table that M2 owns (M2-F1-R1, created in M2-S1): department, garment group
  (the six groups of `08-product-facts.md` section 4.2) and garment type, plus `kids`, `multipack` and `unknown`, all seeded
  there. M5 keeps no second category tree; `categoryScope` is an M2 node id. Non-fashion nodes (home textile: curtains,
  bedsheets; toys; cookware; small appliances) exist as nodes with no rules, so the gap is visible.
- M5-F1-R6. Every rule shows a plain sentence generated from its fields, for example "Noon, all categories: title at most
  150 characters. Blocks. Source: playbook, confirmed by owner on 2 Nov 2026."
- M5-F1-R7. Each operator in the dataset (equals, in_set, between, lte, gte, lt, matches_regex, not_matches_regex, present,
  all_present, equals_ordered, per_channel, judge and the rest listed in the dataset summary) has a written meaning and a
  test. An operator with no implementation makes its rules `needs_judge`, never silently "pass".
- M5-F1-R8. A rule can be scoped to brand, channel, market, category and language at once; the most specific matching rule
  of the same field wins, and the screen shows which rule won and why.

**Non-functional.** Seed of 555 rules under 30 s. Snapshot build under 5 s for 5,000 rules. No model calls, so no per-SKU
cost. Scale target: 30 channels, 5,000 rules, 200 categories.

**Admin configuration without a deploy.** Every rule value, severity, scope and status; channel records; category nodes;
image policies.

**Inputs and outputs.** In: the dataset JSON, `channels.ts`, gate-1 decisions. Out: ruleset v1 and v2, snapshots, BigQuery
export.

**Human in the loop.** None per SKU. The owner made the three settled decisions; further confirmations come from channel
managers through M5-F5.

**Edge cases.** Duplicate rule ids in the source (fail the seed with the ids). A rule whose source line no longer exists
(keep it; the source is history). Two rules of equal specificity on the same field that disagree and are not in a conflict
(the publish step refuses and asks to add them to a conflict).

**Buy or build.** Build. Feed tools (Channable, Feedonomics) have rule builders for Western channels and Amazon has product
type schemas, but nobody covers Noon, Namshi, Styli or Centrepoint, and nobody stores evidence grade.

**Acceptance tests.**
1. Run the seed twice on an empty database: 555 rules and 30 conflicts, no duplicates, version 1 and version 2 present.
2. Open the rules page as an admin, filter Noon and title: see "title at most 150 characters", block, playbook, confirmed.
3. A test batch rendered with snapshot v2 shows a background of 240 or more on Noon, Namshi and Trendyol images and pure
   white on Amazon image 1 (measured on the output pixels).

**Open questions (with recommended default).**
- Exact grey value for C10: any value of 240 or more passes. Default `#F0F0F0` (240), so the change from today is smallest.
- Should `channels.ts` stay as a fallback? Default: no runtime fallback; it becomes the seed and a test fixture only, so
  there is one source of truth.

### M5-F2 Conflict register (P0)

**User story.** As the owner, I see each conflict as one card with the competing rules, the options and a recommendation,
press one button to decide, and the system stops silently picking.

**Functional requirements.**
- M5-F2-R1. All 30 conflicts are loaded with topic, severity (high, medium, low), rule ids, options, recommendation and
  reasoning from the dataset.
- M5-F2-R2. A rule that belongs to an open conflict has effective severity `warn` on every channel, whatever its declared
  severity, and its result message names the conflict ("Noon and Namshi disagree on bullet length; conflict C04 is open").
- M5-F2-R3. Deciding a conflict records option, decider, date and a reason; the chosen rules become active with
  `confirmedBy` set; the losing rules become `superseded` with the decision as reason. It publishes a new ruleset version.
- M5-F2-R4. C02, C10 and C27 are recorded as decided on 2 Nov 2026 (gate 1). C01, C03 and C04 are decided with the
  recommendation (owner Q11). Decided by the owner on 3 Nov 2026:
  - C06: keep the minimum image size already in code; no new intake bar.
  - C07: keep the aspect ratios and canvases already in code; do not change them.
  - C11, C20, C24: the recommendation.
  - C14: on-model required for all adult softline, including footwear, accessories, lingerie and swimwear. A missing
    on-model photo is a gap (shown in the digest and filled by M3 generation where allowed), not a reason to hold the
    product. Kids never need a person (flat lay).
  - C16: the recommendation for units (store cm, show per market, no mixed units), plus: never create a size chart
    without a brand size chart.
  The register shows 17 open, of which 1 is high (C19 Noon infographics; the owner says Arabic text is allowed, the
  limits wait for research).
- M5-F2-R5. Text work (M8) cannot start generating for a channel while a high conflict on a text component of that channel is
  open (C01 title formula, C03 bullet count, C04 bullet length). The register shows "Blocks M8 text" on those cards.
- M5-F2-R6. A conflict can be reopened only by the owner role with a reason; reopening returns its rules to `warn`.
- M5-F2-R7. When an admin edit would create a new conflict (two active rules on the same field and scope that cannot both
  hold), the publish step detects it, creates a draft conflict and refuses to publish until it is decided or the edit is
  changed.

**Non-functional.** Decide-and-publish under 10 s. Conflict detection on publish under 30 s for 5,000 rules.

**Admin configuration.** Options and recommendations are editable text; the decision is a button for the owner role.

**Inputs and outputs.** In: dataset conflicts, admin decisions. Out: decisions log, new ruleset versions,
`rules.conflict_decided` events.

**Human in the loop.** The owner (or a named delegate per channel) decides each high conflict. This is permanent: it is a
rule change, one of the human checks the gate-1 decisions keep. Medium and low conflicts take the recommendation by default
after 14 days unless someone objects; the card says so.

**Edge cases.** A conflict whose recommendation depends on a channel manager answer (C19 infographics on Noon): the card
shows "Waiting for the Noon channel manager" and links the M5-F5 ask. A decision that supersedes a rule another conflict also
holds: both cards update.

**Buy or build.** Build. Nobody sells this.

**Acceptance tests.**
1. Open the Conflicts tab: 27 open, 11 high; C02, C10, C27 shown as decided with date and decider.
2. Decide C03 with "generate exactly 5, check 4-5, Trendyol 5-7": a new version publishes, R030 to R035 change state, and
   the next batch's checks use the new version.
3. An admin sets Namshi title to 120 while a 150 rule is active on the same scope: publish is refused with the sentence in
   section 5.

**Open questions.**
- Should medium and low conflicts auto-accept the recommendation after 14 days? Default: yes, with a notice; the owner can
  reopen.
- Who may decide per channel? Default: the owner only, until M12-F4 roles exist.

### M5-F3 Admin rule editor (P0)

**User story.** As a non-technical admin, I change "Namshi image count at most 8" to 10, add a new channel by copying an
existing one, add a "curtains" category, or add a rule just for one brand, see what the change would do, and publish. The
next batch follows it.

**Functional requirements.**
- M5-F3-R1. Edit any rule's value, severity, scope, status or text through form fields that match the operator (a number box
  for `lte`, a list editor for `in_set`, an ordered list for shot lists, a colour picker with RGB number for backgrounds).
  No raw JSON or regex box for the admin role; regex rules are edited by a "contains / does not contain these words" list
  that is compiled to a pattern.
- M5-F3-R2. Every edit requires a reason (free text) and creates a draft. Publishing a draft creates a new ruleset version.
- M5-F3-R3. **Impact preview** before publish: the draft is evaluated against the stored content versions of the last 7 days
  (default) and shows counts in words: "This change would have changed the result for 46 of 2,113 Noon outputs: 46 pass
  that failed before." The preview never writes anything.
- M5-F3-R4. **Add a channel**: a three-step flow. (1) Name, markets, languages, push method, owner. (2) "Copy rules from"
  an existing channel (optional) or start empty. (3) Image render spec (canvas, margins, background, first image background,
  dpi) and an image policy. The channel starts as `draft`; an admin sets it `active`. An active channel with no title,
  bullet, description or attribute rules shows the badge "No content rules" and opens an ask in M5-F5.
- M5-F3-R5. **Add a category**: name, parent node, and optionally "copy rules from" a sibling. A category with no attribute
  list shows "No attribute list". This is how curtains and bedsheets enter for the Cortina pilot.
- M5-F3-R6. **Add a brand rule**: pick a brand from the brand list (or add a brand with name and exact spelling when it is
  missing, until M12 owns brands), then add or override rules for it.
- M5-F3-R7. History: every version of every rule with who, when, reason and the diff; "Restore this version" makes a new
  draft from it.
- M5-F3-R8. Changes that need a typed confirmation ("type PUBLISH"): turning a `warn` into a `block`, retiring a documented
  rule, and any change to a rule whose evidence is `documented`.
- M5-F3-R9. Every publish emits `rules.ruleset_published`. The next batch to start uses the new snapshot; running batches keep
  theirs.
- M5-F3-R10. Rule edits are refused for rules in an open conflict (decide the conflict first), with the sentence in section 5.

**Non-functional.** Page load under 2 s for 5,000 rules (server-side filter). Preview under 60 s for 7 days of outputs,
running as a background task with a progress line. Works on a laptop browser; read-only on phone width.

**Admin configuration.** This feature is the configuration surface.

**Inputs and outputs.** In: admin edits. Out: drafts, versions, events, preview counts.

**Human in the loop.** An admin publishes every rule change (permanent, by design: rule changes are a human check). No
per-SKU review.

**Edge cases.** Two admins edit the same rule (the second publish is refused: "This rule changed while you were editing.
Open the new version."). Preview on a channel with no stored outputs (says so, publish still allowed). A new channel id that
collides with an existing one (refused). A channel with a canvas smaller than its own documented minimum (refused with the
numbers).

**Buy or build.** Build. Channable's rules builder is the closest pattern (EU channels only); copy its plain "if, then"
editing style, not its product.

**Acceptance tests (run as an admin would).**
1. Change Namshi `image.count.max` from 8 to 10 with a reason, preview, publish; start a new batch with 9 crops available on
   Namshi; the batch publishes 9 images for Namshi. The previous batch, still running, keeps 8.
2. Add channel "Myntra" by copying Namshi, set canvas 1500x2000 and markets IN; it appears in the wizard as a draft channel
   for admins only, and "No content rules" shows until its rules are added.
3. Add category "Home textile > Curtains"; it appears in the category filter with "No attribute list".
4. A non-engineer admin does tests 1 to 3 without help and without a deploy.

**Open questions.**
- Does adding a channel need any code? Default: no, as long as the channel uses the standard renderer (canvas, margins,
  background, anchor); a channel needing a new kind of render (for example a new anchor rule like Styli's bottom guide) needs
  a code change, and the add flow says so.
- Preview window: default 7 days of outputs; admin can pick 30.

### M5-F4 Rule checks in pipelines (P0)

**User story.** As any module (images, text, files), I ask "does this content pass on Noon for this brand and category?" and
get a clear answer and a reason, so nothing reaches a channel that we already know it will reject.

**Functional requirements.**
- M5-F4-R1. One function `evaluate(snapshot, subject)` returns a `RuleResult` per applicable rule. It is pure: no database,
  network, clock or model. It lives in `packages/core/src/catalog/rules/`.
- M5-F4-R2. **Effective severity**, worked out in this order:
  1. A rule in an open conflict: `warn`.
  2. A `checkable: false` rule: outcome `needs_judge`; M5 sends it to M7 and never blocks on it itself.
  3. Declared `block` with evidence `documented` or `reported`, or with `confirmedBy` set: `block`.
  4. Declared `block` with evidence `playbook` or `assumed` and no confirmation: `warn` (the risk table's "warn, not block,
     until a channel confirms").
  5. Otherwise the declared severity.
- M5-F4-R3. What `block` means to the caller: that content version is not offered on that channel. The calling module must
  auto-fix (re-render, regenerate, shorten) or drop that one item and record why. A block never stops the batch and never
  creates a per-product card; it is counted in the M1 digest with the rule sentence.
- M5-F4-R4. The image compliance check in `packages/core/src/catalog/compliance.ts` (`checkOutput`, background tolerance
  `BG_TOLERANCE = 24`, safe box, Styli anchor, Noon wide rule) reads its numbers from the snapshot's channel record, not from
  constants. A parity test proves the same images get the same result before and after, apart from the C10 change.
- M5-F4-R5. Every result for a published content version is written to M0 as `RuleResult` with the ruleset version, so M9
  and M4 can later ask "which rule did this listing pass".
- M5-F4-R6. Messages are plain words with numbers: "Title has 163 characters; Noon allows 150." Arabic content gets the same
  message in English for the admin (Arabic display is optional, later).
- M5-F4-R7. Character counts use Unicode characters (grapheme clusters) for text, bytes only where the rule says bytes
  (Amazon backend keywords 250 bytes, C21).
- M5-F4-R8. A batch reads its snapshot once at start and stores the version; if the rules database is down at batch start,
  the batch uses the latest snapshot file in storage and logs "rules database unavailable; used snapshot v<k>".

**Non-functional.** Under 5 ms per product x channel for all deterministic rules (p95), so 2,000 SKUs x 5 channels costs
under one minute of worker time. Zero cost per SKU. The function has 100% branch tests on effective severity.

**Admin configuration.** Severity and evidence confirmation per rule (through M5-F3).

**Inputs and outputs.** In: snapshot, subject. Out: results, M0 rows, digest counts, judge requests to M7.

**Human in the loop.** None at check time. Judgement rules go to M7, which keeps only the human checks gate 1 allows
(product truth, modesty, likeness rights).

**Edge cases.** A subject with an unknown category (rules scoped `all` apply; category rules return `not_applicable` and the
digest counts "category unknown"). A channel added after the batch started (not in the snapshot; not checked; never
published in that batch). A value of the wrong type (fail with "value is not a number"; never crash the batch).

**Buy or build.** Build. Rubick CAST (60+ checks), Salsify and Amazon pre-validation do this for their channels; none takes
our rules or covers GCC channels.

**Acceptance tests.**
1. A real batch of 50 apparel products on Noon, Namshi, Trendyol, Styli and Centrepoint: every output has rule results in M0
   with the batch's snapshot version, and the digest shows counts per rule sentence, with zero per-product cards.
2. A planted title of 163 characters for Noon is not offered on Noon and is regenerated or dropped, with the reason in the
   digest; the same title passes on Namshi (200).
3. Kill the rules database before a batch starts: the batch runs on the stored snapshot and logs the line in R8.

**Open questions.**
- Should playbook-only block rules stay `warn` until confirmed? Default: yes, as gate 1's risk table says. The owner can
  confirm whole groups at once (for example "all Noon image rules").

### M5-F5 Channel gaps workflow (P1)

**Story.** As the catalog lead, I see which channels have no rules for a component and who has been asked, and I chase one
list instead of remembering.

**Key requirements.**
- M5-F5-R1. A gap is a channel x component (or category x component) with no active rule. Gaps are computed, not typed.
  Baseline: six channels without content rules (Styli, Centrepoint, 6th Street, Shein, VogaCloset with none; Namshi with
  playbook and code only). No Arabic rules anywhere. No non-fashion rules.
- M5-F5-R2. An ask is recorded per gap: who was asked (channel manager), date, what was asked, the answer file, status
  (open, answered, no answer after 14 days).
- M5-F5-R3. An answer becomes draft rules with evidence `reported` (or `documented` when the channel's own file or page is
  attached) and goes through the editor.
- M5-F5-R4. The first asks are already written in `.runs/2026-11-02-channel-rules.md` "Next steps" and `09-listing-files.md`
  section 8 "Who to ask"; they are seeded as open asks.

**Acceptance test.** The gaps page lists the six channels and "Arabic: all channels"; recording the Namshi manager's
answer turns Namshi's title gap into draft rules that publish through M5-F3.

**Buy or build.** Build (a small table and page) plus process (the asks).

### M5-F6 Claims and banned words (P1)

**Story.** As a brand manager, I know no listing on any channel says "Best", "#1", a competitor's name or a claim we cannot
prove, in English or Arabic.

**Key requirements.**
- M5-F6-R1. Word lists as data per scope (all, channel, brand, language): banned promotional words (C22 resolved: "Best",
  "#1", "Sale", "Guaranteed", "Amazing", "Cheap", "Top Rated", "Top Quality", "Top Selling", but not bare "Top"), banned
  characters (C23: block @ # * and URL characters; "&" allowed only inside the exact brand name), contact details (URL,
  phone, email), competitor brand names.
- M5-F6-R2. Approved claims and required disclaimers per brand (for example "organic cotton" only for brands with a
  certificate on file), checked on text from M8.
- M5-F6-R3. Arabic word lists are their own lists, written by a native speaker, never machine-translated from the English
  list.
- M5-F6-R4. Matching is whole word, case-insensitive, with Arabic normalisation (alef forms, taa marbuta and yaa variants,
  diacritics removed) so variants are caught.

**Acceptance test.** A planted title "Best Tank Top" fails on "Best" and passes "Tank Top"; "H&M Women Top" passes when H&M is
the exact brand name; an Arabic planted banned word with diacritics is caught.

**Buy or build.** Build. Jasper Product IQ and Rubick have partial claim governance; neither covers Arabic or our channels.

### M5-F7 Brand consistency rules (P1)

**Story.** As Opptra, a distributor of many brands, I want one brand to look and read the same on every channel: same brand
spelling, tone words, logo use, colour names and framing.

**Key requirements.**
- M5-F7-R1. Brand-scoped rules: exact brand spelling per script (Latin and Arabic), tone word lists (use, avoid), colour name
  policy (brand colour name shown, colour family for filters, as in `08-product-facts.md` section 4.4), framing preference per
  category (for example "on-model full length first").
- M5-F7-R2. A brand rule never overrides a channel `block` rule; when they disagree the channel wins and the conflict is
  logged for the brand owner.
- M5-F7-R3. Brand rules come from M12 Brand DNA when it exists; until then they are entered here.

**Acceptance test.** Set "U.S. Polo Assn." as the exact spelling; a generated title "US Polo" fails on every channel with the
expected spelling in the message.

**Buy or build.** Build. Photoroom brand kits cover visuals only, for one brand.

### M5-F8 Arabic and right-to-left rules (P1)

**Story.** As the Noon channel manager, I know Arabic titles, bullets and attribute values follow written rules that a
checker can enforce, not one writer's taste.

**Key requirements.**
- M5-F8-R1. A seed set of Arabic rules, evidence `assumed` until a Noon or Namshi manager confirms: Arabic title present when
  the channel's file has an Arabic title column; Arabic title length limit equal to the English one (warn) until the real
  limit is known; brand name written as the brand's approved Arabic spelling or in Latin script per brand rule; digits as
  Western digits (0-9) by default; no Latin-only text in an Arabic field except brand, model and size codes; no stray
  direction control characters at the start or end; Modern Standard Arabic register with Gulf-familiar words, no Egyptian or
  Levantine dialect words from a list.
- M5-F8-R2. Mixed-direction checks: a Latin token inside Arabic text (brand, size "XL", "100% cotton") renders in the right
  order; checked by a bidirectional text test, not by eye.
- M5-F8-R3. Arabic text checks for grammatical agreement (adjective gender and number) are judgement rules routed to M7.
- M5-F8-R4. RTL layout rules for infographics and size chart images are stored here for M11 and M8-F4.

**Acceptance test.** A planted Arabic title with Eastern Arabic digits fails the digit rule with the default; a title with a
mis-ordered "XL" fails the direction test; both are reported in plain words.

**Buy or build.** Build. Nobody has Arabic marketplace rules.

## 5. Operator experience

The operator (Naaz) never opens M5. She sees its effect only in the M1 digest: "12 images were re-rendered to meet Noon's
rules. 3 titles were shortened for Trendyol." Admins and the owner use three screens under Settings.

**Screen "Channel rules"** (`/catalog/rules`). Filters: channel, market, category, brand, component, evidence, severity,
"in a conflict". Each row is one plain sentence with badges (Blocks / Warns, evidence grade, "Confirmed by owner 2 Nov").
Lead line: "These are the rules the system checks before anything goes to a channel. Change a value and the next batch
follows it."

**Screen "Conflicts"** (`/catalog/rules/conflicts`). Lead line: "<n> places where our sources disagree. Until you decide, the
system only warns on these rules." One card per conflict: the competing sentences side by side, the options, "We recommend:
<text>", buttons "Decide" and "Ask the channel manager".

**Screen "Channels and categories"** (`/catalog/rules/channels`). Channel list with status and badges ("No content rules",
"No Arabic rules"), "Add a channel", "Add a category".

**Key copy.**
- Edit panel: "Why are you changing this?" (required). Preview: "This change would have changed <n> of <m> <Channel> outputs
  in the last 7 days." Publish button: "Publish for the next batch".
- After publish: "Published as version <k>. Batches that start from now use it. <r> running batches keep version <k-1>."
- Refused edit, open conflict: "This rule is part of conflict <id>, which is still open. Decide the conflict first."
- Refused publish, new conflict: "This would make Namshi's title rule disagree with another active rule (<sentence>). Change
  one of them, or record it as a conflict."
- Refused, someone else changed it: "This rule changed while you were editing. Open the new version."
- Typed confirmation: "This turns a warning into a block on <Channel>. Type PUBLISH to confirm."

No babysitting: nothing here waits on a person except conflict decisions and rule publishes, which are deliberate.

## 6. Measurement

| Metric | Baseline | Target | Data source |
|---|---|---|---|
| Rules loaded as data | 0 (in code and documents) | 555 at slice end; every new rule through the editor | `rules` table |
| Share of rules with evidence better than playbook (documented, reported or assumed with a confirmation) | 35% (195 of 555 not playbook-only) | 60% by week 12 | `rules` table |
| Open high-severity conflicts | 14 (11 after gate 1) | 0 for the five slice channels before M8 text starts | `conflicts` table |
| Batches that follow an admin edit on their first run after publish | not possible today | 100% | snapshot version on batch vs publish time |
| Rule edits published by non-engineers | 0 | at least 5 in the first month | `rules` history (`createdBy` role) |
| Rejections caused by a rule we already had (we checked it and it still got rejected, or we let it through as warn) | unknown | tracked weekly; falling | M9-F3 reasons joined to `rule_results` |
| Channels with zero content rules | 6 | 2 by week 12 | gaps view (M5-F5) |

## 7. Build slices

Each slice is one worker in one worktree. Together M5-S1 to M5-S3 plus M5-S5 test 1 are first-slice item S6 in
`module-map.md`.

| Slice | What | Depends on | Acceptance test |
|---|---|---|---|
| M5-S1 | Tables (rules, versions, conflicts, decisions, snapshots, channels, image policies, rule results; categories are M2's taxonomy), seed job, gate-1 decisions as v2, BigQuery export | M2-S1 taxonomy node ids (M0 export job for the daily copy) | Seed twice: 555 rules, 30 conflicts, v1 and v2; parity test with `channels.ts` passes for v1 |
| M5-S2 | `evaluate()` library with every operator, effective severity, Unicode counting, judge routing stub | M5-S1 | Unit tests per operator; planted cases (163-character Noon title, open-conflict rule warns, playbook block warns) pass |
| M5-S3 | Pipelines read the snapshot: batch pins version at start; `channels.ts` and `compliance.ts` numbers come from the snapshot; C10 applied | M5-S1, M5-S2; M6-F2 for deploy survival | Real test batch: Noon, Namshi, Trendyol backgrounds at 240+, Amazon image 1 white; a batch started before a publish keeps its version |
| M5-S4 | Conflicts screen, decide and reopen, conflict detection on publish, "Blocks M8 text" flag | M5-S1 | Acceptance tests of M5-F2 |
| M5-S5 | Rules screen and editor, add channel, category and brand scope, history, impact preview, typed confirmations | M5-S1 to M5-S3 | Acceptance tests of M5-F3 run by a non-engineer admin |
| M5-S6 (P1) | Gaps page and asks; claims and banned words lists; brand rules; Arabic seed rules | M5-S5 | Acceptance tests of M5-F5 to M5-F8 |

## 8. Risks and open questions

| Risk or question | Effect | Mitigation or recommended default |
|---|---|---|
| `ChannelId` is a fixed list in code (`CHANNEL_IDS` in `types.ts`, used across render, sheet and wizard) | "Add a channel without code" fails | Default: the channel id becomes a validated string from the registry; the nine current ids stay as seeds. This is the biggest code change in M5 and is sized in M5-S3; a worker should map every use of `ChannelId` first |
| 65% of rules rest on the playbook alone; Namshi has no public rules | False blocks or rejections | Playbook-only blocks act as warnings until confirmed (M5-F4-R2) |
| Admins publish a bad rule | A whole batch fails a channel | Impact preview, typed confirmation for blocks, one-click restore of the previous version |
| Rule edits mid-batch | Half a batch on old rules | Snapshot pinned per batch |
| Too many warnings become noise | People stop reading the digest | Digest groups by rule sentence with counts; warnings never create per-product items |
| India channels (Amazon.in, Flipkart, Myntra) come next with different units and limits | Rework if the schema is GCC-shaped | Market and language are fields from day one; Myntra rules (24, playbook) already in the dataset |
| Non-fashion (Cortina curtains) needs attribute schemas that do not exist | Pilot slips | Category nodes exist with "No attribute list"; the schema ask goes to the Cortina team through M5-F5 |
| Who decides conflicts per channel | Slow decisions | Default: the owner; medium and low auto-accept after 14 days |
| Arabic rules have no source anywhere | We write them ourselves | Evidence `assumed`, written by a native speaker, confirmed by the Noon manager through M5-F5 |

## 9. Integration decisions (2026-11-02)

| # | Decision | Why |
|---|---|---|
| D1 | No second category tree: M5 scopes rules by M2's taxonomy node ids (F1-R5, M5-S1 depends on M2-S1); "Add a category" (F3-R5) writes into M2's table | M2-F1-R1 and M5-F1-R5 both defined a tree |
| D2 | Shein image 1 white is an `assumed` rule, not confirmed by gate 1 | Gate 1 named only Amazon; marking Shein as confirmed overstated the decision |
| D3 | `catalog_rule_results` is M5's own table keyed by M0 version ids | M0 holds no module scores |
| D4 | Add channel and add category are M5's (M5-S5); M12-S8 only adds the listing-file template mapping and Brand DNA parts to the same flow | M5-F3-R4/R5 and M12-F1-R9 duplicated the flow |
| D5 | In the first slice, `needs_judge` results are recorded and counted in the digest only; no judge call runs for them until M7's judges cover the rule (P1) | M7 P0 has no generic judgement-rule runner |
| D6 | The owner role (conflict decisions, typed confirmations) is an allow-list setting in M12-S1 holding Sujan's account until M12-F4 roles exist | M12-F4 is P2; P0 needs an owner check |
| D7 | Open questions answered: grey `#F0F0F0`; no runtime fallback to `channels.ts` (seed and fixture only); playbook-only blocks warn until confirmed; adding a standard channel needs no code; preview window 7 days, 30 on request; `ChannelId` becomes a validated string from the registry, mapped by M5-S3's worker first | Technical defaults |
| D8 | Kept for the owner (`../owner-questions.md`): C01, C03, C04 (they block M8 text), the image-side high conflicts as a group, auto-accepting medium and low conflicts after 14 days, and the channel-manager asks | Marketplace-facing content decisions |
