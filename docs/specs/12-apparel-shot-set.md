# 12 Apparel shot set

Catalog module, spec 12. Execute with `docs/specs/00-execution-protocol.md`. Source of truth:
`docs/SPEC.md` (channel rules, image policy, models table, non-goals, publish and overwrite contract),
amended by this spec in the words of section 0.5. Depends on 05 (render, matting client), 06 (chunks,
publish, sheet, finalize), 07 (judge, attention, decisions, caps), 08 (policy writer), 10 (eval job,
golden set), 11 (upscaler, the `CheckGroup` pattern). Branch `feat/catalog-12-apparel-shot-set`.
Deploys `catalog-worker`, `catalog-web`, `catalog-matting` (both targets) and two jobs
(`catalog-harvest`, the `shotset` mode of `catalog-output-evals`). Spec 13 (lifestyle) builds on
sections 1 to 9 by number; interfaces it shares are defined here once (13, item 11).

Design sources (read for the why, never for contracts; contracts are here): the worktree
`catalog-module-wt/02-shot-set-and-scene/docs/plans/` files `deep-dives/00-softline-taxonomy.md` (DD0),
`01-shot-roles-channel-compliance.md` (DD1), `02-derived-shots-fidelity-gate.md` (DD2),
`03-on-model-generation-bake-off.md` (DD3), `08-brand-style-profile-model-registry.md` (DD8),
`roadmap/initiatives/05-complete-apparel-shot-sets.md` (I5), `roadmap/focus/01-crops-5.1a-5.1b.md` (F01),
`roadmap/focus/02-generated-apparel-5.2-5.3.md` (F02). Every `path:line` below is verified on `main` at
`d82cc36`; code paths are under `packages/core/src/` unless they start with `apps/`, `services/` or `infra/`.

## 0. Scope, non-goals, words, dependencies, SPEC amendments

### 0.1 Goal

Most apparel lacks the five photos Styli and Centrepoint ask for (65 of 66 sampled, I5), and many live
listings show a brand photo whose head or product is cut at the frame edge, today published on every
channel with the information flag `cut_in_source` (`catalog/render.ts:553`, sheet note
`catalog/pipeline/report.ts:43-48`, sentence `catalog/types.ts:140-141`). This spec completes the
apparel shot set per product and ticked channel, and replaces cut photos, by one rule:

**Remove and replace in one move.** A cut photo leaves image 1, or leaves the role slot a channel forbids
it in, only in the same publish that makes a replacement for that role live, and only after that
replacement passed every check and every review it needs. A listing never loses a photo without gaining one.

The replacement ladder, per product x ticked channel x missing role: (1) an existing photo that already is
the role; (2) a crop of a larger photo of the same option (derived source, 5.1a and 5.1b); (3) a generated
shot from the option's own photos (mode A, 5.2); (4) for a product with no on-model photo, the flat lay on
an approved brand model (mode B, 5.3); (5) "Not made" with a plain sentence in the links sheet.

### 0.2 Non-goals

- Lifestyle, legs-only and composites (spec 13; `LS` is only reserved in the role enum here).
- Footwear, bags, accessories, hardline: roles are recorded (section 2), nothing is planned for them.
- Bottoms, lingerie, swimwear, multipacks and kids: roles are reported, a role is never called missing and
  nothing is derived or generated until the owner answers DD0 open items 1 to 7 (section 3.6).
- No face recognition, no stored face embeddings, no cross-product person matching.
- No re-submission to marketplace portals by the module; the operator acts on `change` (section 8).
- No change to `MAX_UPSCALE`, `MIN_SOURCE_LONG_SIDE_PX` (`catalog/channels.ts:211,214`) or the matte ladder.
- No model id in any operator page, sheet, note, toast or API response (spec 07 banned-names test).

### 0.3 Words

- **Role**: what a photo shows, one of `fm` front to mid-thigh, `fl` full length, `fc` fabric close-up with
  no model, `bh` back to the hips, `hs` head and shoulders, `ls` lifestyle (spec 13), `flat` flat lay or
  packshot with no person, `chart`, `other` (side, three-quarter, detail on a body). Codes in copy:
  FM, FL, FC, BH, HS. The TypeScript name is `ShotRole` (`Role` is taken by user roles, `catalog/types.ts:51`).
- **Head state**: `full` (whole head and top of hair inside the frame), `none` (crop line at or below the
  chin), `cut` (the top edge crosses the face between hairline and chin), `na` (no person).
- **Cut photo**: a source with head state `cut`, or a source cut at a frame edge its role does not allow
  (section 3.2). **Slot**: one required role on one channel for one product.
- **Kind**: `brand`, `derived` (a crop, no new pixels) or `generated`; **made photo** = derived or generated.
- **Gate** G1 to G6 (6); **review-all** and **exit** (7); **crop size bar**, a per-channel policy value (1.4).

### 0.4 Dependencies and build order

Before execution (manager checks, 00 section 2; any missing item is `Blocked:` in the report):
- [ ] The owner has typed approval of the section 0.5 amendments into the session, split as two decisions:
      cropping (A1 to A4) and generation (A5 to A8). Cropping alone lets workstreams A to D, H, J ship with
      `generate` off; generation adds E, F, G, I.
- [ ] Channel rule table of section 1.4 approved (DD1 approval question (b)); "assumed" rows stay marked.
- [ ] For generation: the generator approved in writing (DD3 question) and a written vendor no-training
      position on file (I5 Q5); the second rater named (I5 Q2); the modesty exclusions answered (I5 Q7).
- [ ] For mode B: `brand_rights` rows the owner dictates (sites, both use flags) and one approved reference
      model per brand and gender to be run (DD8). Vero Moda women first.
- [ ] Contract exception approved and applied before any workstream starts. `00-execution-protocol.md`
      s11 L260-263 reads: "A spec contract cannot be met without changing a contract from 02 or 03 [...]
      A change to a contract defined in 02 or 03 is proposed in the report, never made silently, and no spec
      other than 02 and 03 ships a migration." This spec needs migration `0003_shot_set.sql` and additions to
      the 02 contracts `CHANGE_KINDS`, `OUTPUT_FLAGS`, `EVENT_KINDS`, `CHUNK_STAGES`, `COST_STAGES`,
      `COST_KINDS`, `SPEND_ENGINES` and the schema (section 1; additive only). The owner types approval of
      this amendment to L262-263, which the manager commits in its own docs PR before this spec runs:
      "A change to a contract defined in 02 or 03 is proposed in the report, never made silently. No spec
      other than 02 and 03 ships a migration, except a spec whose section 0 lists an additive migration and
      the 02 contracts it extends and whose owner approval is recorded in the decisions log (granted: 0002
      cost events, spec 12 `0003_shot_set.sql`, spec 13 its own)." Without it the spec is `Blocked:`.

| Workstream | Worktree suffix | Files (main ones) | Depends on |
|---|---|---|---|
| A data model | `-a-schema` | `db/schema.ts`, `drizzle/0003_shot_set.sql`, `catalog/types.ts`, `catalog/shotset/types.ts` | nothing |
| B roles | `-b-roles` | `qa/templates.ts`, `qa/judge.ts`, `apps/worker/src/catalog/qa-stage.ts`, `catalog/shotset/roles.ts`, evals `roles.ts` | A |
| C planner and state machine | `-c-planner` | `catalog/shotset/planner.ts`, `slots.ts`, `apps/worker/src/catalog/plan-stage.ts`, `chunk.ts` | A, B contracts |
| D crop engine | `-d-crop` | `catalog/shotset/crop.ts`, `naming.ts` | A |
| E generator client | `-e-generate` | `llm/openrouter.ts`, `llm/images.ts`, `catalog/shotset/generate.ts`, `prompts.ts`, `qa/caps.ts`, `spend.ts`, `cost-events.ts` | A |
| F gate | `-f-gate` (critical; Fable if the owner asks) | `catalog/shotset/gate/*.ts`, `services/matting/app.py` (`/measure/*`) | A, E contracts |
| G review UI and labels | `-g-review` | `catalog/shotset/review.ts`, `apps/web/components/catalog/ReviewCard.tsx`, attention routes | A, C |
| H publish, order, sheet | `-h-publish` | `pipeline/publish.ts`, `pipeline/report.ts`, `sheet.ts`, `channels.ts`, `render.ts` | A, C |
| I registry and harvester | `-i-registry` | `catalog/registry/*.ts`, `apps/worker/src/catalog-harvest.ts`, `infra/catalog-harvest.sh` | A |
| J scorecard, Ops, evals, rollout | `-j-rollout` | `catalog/shotset/scorecard.ts`, `apps/web/app/catalog/ops/page.tsx`, `evals/shotset.ts`, `infra/catalog-output-evals.sh`, docs | all |

Builders use the 00 section 4 brief. Before using sharp's `extract`, OpenRouter's image endpoint,
onnxruntime for DINOv2, LPIPS or a human-parsing model, tesseract.js, drizzle migrations or ExcelJS, the
builder fetches current docs through Context7 (the OpenRouter `/images` contract below was read through
Context7 on 2026-10-26 and must be re-read).

### 0.5 SPEC amendments (exact text; the manager applies them in this PR after the owner's typed yes)

Line numbers are `docs/SPEC.md` on `main` at `d82cc36`. Note: the evidence digests cite non-goals at
L852-858 and "Fit, never crop" at L293; the verified lines are L855-861 and L296.

- **A1, L74-75** (Styli line): replace "Never crop." with "Never crop at render time; role derivation only
  under spec 12."
- **A2, L131** (R11): "R11 Never cut any part of the product or model when rendering a photo; pad instead of
  crop. A spec 12 role derivation is a new source made by a rule-bound cut (head and every logo or text
  whole), not a render-time crop."
- **A3, L296**: "Fit, never crop:" becomes "Fit, never crop at render time (a spec 12 derived source is cut
  before the render and is then fitted like any photo):".
- **A4, L861** (non-goal), replaced by: "No cropping of a brand's photo except role derivation under spec 12:
  a role a ticked channel requires (front cropped at mid-thigh, back cropped at the hips, head and shoulders,
  fabric close-up) may be cut from a larger photo of the same option when the cut keeps the head and every
  logo or text whole, sits in the role's band, and the crop's height clears that channel's crop size bar, a
  policy value the owner sets per channel (defaults: Styli 741 px with the upscaler, Centrepoint 2,000 px,
  Amazon 667 px, Noon and Namshi 482 px). Derived outputs are flagged `derived` and pass every check a
  source output passes. Nothing else is cropped; no cap on images per product or per channel." (The three
  F01 section 6 fixes: no "existing cap", the bar written in as a policy value, cropping split from generation.)
- **A5, L857-859** (non-goal), replaced by: "Product pixels in the default path are never regenerated. Two
  exceptions, each behind its own flag and spec: (a) the deterministic x2 upscaler behind `UPSCALE_MODEL`
  that passed the spec 11 fidelity gate (outputs flagged `upscaled`, information); (b) generated on-model
  shots under spec 12 (outputs flagged `generated`), made only for a role a ticked channel requires and the
  brand's photos and crops do not provide, only by a generator the owner has approved in writing, only when
  the batch option and the brand's policy both allow it, always gated by the spec 12 checks G1 to G6 (any
  failed check holds the output), and held for two people until the spec 12 exit numbers are met for that
  brand and recorded here. Mode A conditions only on the brand's own photos of the same option. Mode B, for
  an option with no on-model photo, conditions on that option's flat lay photos plus the approved reference
  pack of a brand model from the spec 12 registry; its full-length anchor is always approved by a person
  before the other roles are made from it."
- **A6, new non-goal after A5**: "No face recognition and no stored face embeddings; model consistency is
  judged per product and never matched across products or brands."
- **A7, new non-goal after A6** (DD8 wording): "Reference images of brand models are harvested only from
  sites covered by a recorded written grant, stored only in the private bucket under models/, tagged and
  approved per brand before use, and never published. Generated on-model shots name the approved style
  profile and reference model version they used. A synthetic model is used only when no approved real
  reference model exists for that brand and gender."
- **A8, L53-54** (enhancement bullet): "No paid image API without a separate owner yes." becomes "No paid
  image API without a separate owner yes; the one approved exception is the spec 12 image generator,
  recorded per brand and category in `model_policy` with the owner's written approval."
- **Models table, L456**: the row "Generative edits, paid image APIs" becomes two rows: "| Generated on-model
  shots (spec 12) | `model_policy.generate_model` (owner-approved; the DD3 winner by default) and
  `generate_model_escalation` for the last attempt, through OpenRouter `POST /images` | `catalog-worker`
  behind the batch option and the policy flag; `catalog-output-evals shotset --live` | billed `usage.cost`
  per image in the cost ledger (stage `generate`); about USD 0.10 per 2K image, 0.20 per accepted image
  assumed |" and "| Other generative edits | not used; IC-Light only as a low-priority experiment on the
  shadow layer alone with a colour-delta guard | | |". Add one row "| Gate measures (spec 12) | DINOv2
  ViT-B/14 embeddings, LPIPS AlexNet-linear, a human-parsing segmenter, tesseract.js OCR | `catalog-matting`
  `/measure/*`; OCR in the worker | open weights, pinned by export sha |".
- **L397-398 and L401**: the re-submit list becomes "`updated`, `shots_removed`, `reordered`, `role_added` or
  `cut_replaced`"; the `change` enum gains `role_added | cut_replaced | pending_review` (section 8.3).
- **L805** (Data model heading): "the only specs that ship migrations" becomes "plus `0002_cost_events.sql`
  and spec 12's `0003_shot_set.sql`, the migrations approved under the 00 s11 exception" (spec 13 appends
  only its own).
- **Ingest limit** (after L75): "A product with more than 100 photos fails ingest with 'This product has more
  than 100 photos. Split it.' (numbers from 101 are reserved for made photos)."
- **AGENTS.md** (approved with A7), the worker line becomes: "... Never raw, never exports, never outside
  catalog/ and catalog-test/, except the `catalog-harvest` job, which writes only private objects under
  models/<brand_slug>/ (assertModelsPrefix)."
- **Decisions log**: the 00 s11 exception above, and one line per exit (section 7.4): "Spec 12 exit, <brand>, <date>: <n> labelled shots,
  false passes <x>% (G1 0, G2 0), false holds <y>%, alpha <a>; sampled review from now."

## 1. Data model and migrations

One migration `packages/core/drizzle/0003_shot_set.sql`, generated by drizzle-kit from `db/schema.ts`,
additive only (new columns nullable or defaulted; no rewrite of existing rows). 00 section 11 says only 02
and 03 ship migrations; `0002_cost_events.sql` set the precedent of an additive later migration. The PR
body lists it under "Contracts added or changed" (00 section 8).

### 1.1 Source kinds: columns on `catalog_source_images` (`db/schema.ts:374-410`)

Decision: columns plus one JSON, not a side table. Every reader that decides what is live reads this table
(`planPublish` sources `pipeline/publish.ts:55,63`, the stale-source filter `:85-87`, the report
`pipeline/report.ts:142`, the matte and render stages); a side table would need a join in each and a missed
join would let `planPublish` delete a made photo. The per-kind detail varies and is versioned, so it is JSON.

| Column | Type | Meaning |
|---|---|---|
| `kind` | text enum `brand,derived,generated`, default `brand` | |
| `parent_source_id` | uuid, FK self, null | derived: the brand source cut from |
| `derivation` | jsonb, null | `DerivedRecord` or `GenKey` below |
| `role` | text enum `SHOT_ROLES`, null | current role (operator override wins) |
| `head` | text enum `full,none,cut,na`, null | |
| `head_cut_at` | text enum `above_nose,nose_lip,below_lip`, null | set only when `head = cut` (2.1) |
| `role_confidence` | numeric, null | |
| `role_by` | text enum `judge,second_judge,operator,planner`, null | `planner` for made sources (role known by construction) |
| `cut_state` | text enum `ok,head_cut,product_cut`, null | section 3.2 |

```ts
// catalog/shotset/types.ts
export const SHOT_ROLES = ["fm","fl","fc","bh","hs","ls","flat","chart","other"] as const;
export const SOURCE_KINDS = ["brand","derived","generated"] as const;
export const HEAD_STATES = ["full","none","cut","na"] as const;
export interface DerivedRecord { type: "crop"; parentSha256: string; box: {x:number;y:number;w:number;h:number};
  role: ShotRole; ruleVersion: string; cropHeightPx: number }              // ruleVersion = CROP_RULE_VERSION
export const GEN_MODES = ["A","B","ls_full","ls_composite"] as const;   // ls_* used by spec 13 only
export interface GenKey { type: "generate"; mode: (typeof GEN_MODES)[number]; role: ShotRole; model: string; policyVersion: string;
  promptHash: string; referenceShas: string[]; referenceModelId?: string; referenceModelVersion?: number;
  styleProfileId?: string; styleProfileVersion?: number; anchorSha?: string; attempt: number; // 1-3 here, 1-5 spec 13
  outputSha256: string; costUsd: number; review?: { phase: "review_all" | "sampled" | "auto"; decidedAt: string } }
```

`gen_key` identity is the output sha, not a seed (DD3: a fixed seed does not reproduce an image). Model ids
live only in `derivation` and the ledger; the web never serialises `derivation.model`.

Numbering: brand shots keep `n` 1 to 100 from `renumberShots` (`catalog/naming.ts:75`); ingest fails a
product with more than 100 photos with "This product has more than 100 photos. Split it." Made sources take
`n` from `MADE_N_BASE` = 101 upward, the next free number per product, kept forever for that made photo, so
its public path `<pathKey>_<n>.jpg` (`naming.ts:153`) is stable and never collides with a brand shot.
Private files: crops at `derivedPath(prefix, pathKey, n, "crop")` (`naming.ts:133`, `.crop.png`, lossless),
generated images at `derivedPath(prefix, pathKey, n, "gen-a<attempt>")`.

### 1.2 Outputs and batch options

- `catalog_outputs` (`schema.ts:412-471`) gains `position integer null` (1-based order on its channel;
  null on rows written before this spec, read as `n`) and nothing else; the live index stays
  (product, channel, n) (`:466`).
- `BatchOptions` (`catalog/types.ts:60-68`) gains `shotSet?: { crops: boolean; generate: boolean;
  modeB: boolean; generateCapUsd: number | null; testRun?: boolean }`, and the slot `scene?: { capUsd:
  number; sample?: number }`, written and read by spec 13 only (its s1.3); absent means all off. Unlike
  `qaCapUsd` (`qa/caps.ts:8`, null = no cap), a null `generateCapUsd` means no generation: the start route
  refuses `generate: true` without it and `checkGenerateCaps` refuses (key `cap`).
- `CHANGE_KINDS` (`types.ts:10`) gains `role_added`, `cut_replaced`, `pending_review`. `OUTPUT_FLAGS`
  (`:14-22`) gains information flags `derived`, `generated`, `cut_retired`, and hold flags `wrong_garment`,
  `logo_changed`, `text_invented`, `colour_shift`, `texture_changed`, `model_mismatch`, `anatomy`,
  `crop_rule`, `gate_unavailable`, `references_changed`, `ai_tag_missing`. `EVENT_KINDS` (`:28-29`) gains `role_added`,
  `cut_replaced`, `made_photo_reviewed`, `made_photo_removed`, `cut_swap_decided`, `role_set`,
  `shotset_relapse`, `crops_exit`, `crops_relapse`; information flag `cut_kept` joins `OUTPUT_FLAGS` (8.2). `CHUNK_STAGES` (`schema.ts:60`) gains
  `plan`, `generate`, `gate`.

### 1.3 Slots and review labels (new tables)

`catalog_shot_slots`: the state machine of section 3. Columns `id`, `batch_id` FK, `product_id` FK,
`channel`, `role`, `state` (enum section 3.3), `path` (`existing,crop,mode_a,mode_b,none`), `occupant_source_id`
(the cut or missing-role occupant, null when missing), `candidate_source_id`, `attempts` int, `not_made`
(sentence key, null), `detail` jsonb (measures, ladder log), `updated_at`. Unique (batch, product, channel, role).

`catalog_review_labels`: `id`, `source_image_id` FK, `batch_id` FK, `rater` (email), `phase`
(`review_all,sampled,adjudication`), `q1_garment` .. `q6_anatomy_crop` booleans, `publish` boolean,
`answers` jsonb null (named answers for other card types; spec 13's LS questions, `q1`-`q6` null then),
`gate_verdict` jsonb (copied after both answers exist), `created_at`. Unique (source_image_id, rater).

`catalog_gate_state`: PK (`brand_slug`, `scope`); `scope` text default `shotset` (spec 13 adds
`scene_full`, `scene_composite`, with `brand_slug = '*'` for a program-wide exit); `phase`
(`review_all,sampled`), `since`, `evidence` jsonb (the section 7.4 numbers), `decided_by`. Absent row =
`review_all`. This spec reads and writes `scope = 'shotset'` (generated shots) and `scope = 'crops'` (crop
swaps, 7.4); `evidence` for `crops` holds the current run of consecutive approved swaps.

### 1.4 Channel policy (new table, owner-changeable data)

`catalog_channel_policy`: `channel` PK, `required_roles` jsonb (ordered; each entry a role or an array of
alternative roles, for example `[["fm","fl"],"bh","fc","hs"]`; the first entry is image 1), `recommended_count`,
`head_cut_rule` (`fail`: a `cut` head is cut on this channel; `amazon_nose_lip`: a `cut` head is cut unless
the judge's `head_cut_at` is `nose_lip`, DD1 L331), `crop_min_px` and `crop_min_px_no_upscaler` (crop size bar),
`status` (`confirmed,assumed`), `updated_by`, `updated_at`. Seeded check-then-insert by
`ensureChannelPolicies` (the `ensureDefaultPolicies` pattern, `qa/policy.ts:35`), never overwriting a row.
Admin-only `PUT /api/catalog/channel-policy/[channel]` edits a row; the Ops page shows the table read-only.

| Channel | Required roles in order | Head cut | Crop bar (with / without upscaler) | Status |
|---|---|---|---|---|
| styli | fm, fl, fc, bh, hs | fail | 741 / 1482 | confirmed (roles: owner's email) |
| centrepoint | fm, fl, fc, bh, hs | fail | 2000 / 2000 | assumed order |
| sixthstreet, vogacloset | fm, fl, fc, bh, hs | fail | 1067 / 1067 | assumed |
| noon | image 1 fm or fl; then bh, fc, hs | fail | 482 / 482 | count and order confirmed, head rule assumed |
| namshi, trendyol, shein | image 1 fm or fl; then Styli order | fail | 482 (namshi), 1200 / 600 (trendyol), 667 (shein) | assumed |
| amazon | image 1 fm or fl (on model); then fc, bh | amazon_nose_lip | 667 / 667 | confirmed on the global guide |

Values come from DD1 "Per-channel rule table" and DD2 F3; PR #91 removed every SPEC size floor except the
500 px one (SPEC L55-59), so these bars bind crops only and never skip a brand photo.

### 1.5 Model policy, spend, ledger

- `model_policy` (`schema.ts:198-228`) gains `generate_enabled boolean default false`, `generate_model`,
  `generate_model_escalation`, `generate_resolution` (`2K,4K`, default `2K`), `generate_approval`
  jsonb (`{approvedBy, approvedAt, ref}`; the worker refuses a model without it), `generate_printed boolean
  default false`, `style_profile_id`, `reference_model_id` (DD8 R2). `resolvePolicy` (`qa/policy.ts:41`)
  carries them through the same fallback order; `ResolvedPolicy` gains the camelCase twins.
- `SPEND_ENGINES` (`schema.ts:63`) gains `catalog_generate`.
- `COST_STAGES` (`schema.ts:67`) gains `derive`, `generate`, `gate`; `COST_KINDS` (`:69`) gains
  `generate_call`, `measure_call`. `ENGINE_LABELS` (`catalog/cost-report.ts:17-23`) maps `generate_call` to
  "photo making" and `measure_call` to "made-photo check".

### 1.6 Registry tables (mode B, DD8 R2, all new)

`brand_rights` (`id`, `brand_slug`, `grantor`, `document_ref` (a contract id or a private-bucket path, never
the text), `sites` jsonb, `allows_reference_use`, `allows_generated_likeness`, `valid_from`, `valid_to`,
`recorded_by`, `created_at`); `brand_source_site` (`id`, `brand_slug`, `base_url`, `locale`, `reader`
`shopify_feed,image_sitemap,brand_api,page_html`, `brand_filter`, `rights_id` FK, `enabled`, `last_probe`
jsonb, `last_harvest_at`); `model_asset` (DD8 R2 fields, `raw_uri` under `models/<brand_slug>/<sha256>.<ext>`
in the private bucket, unique (brand_slug, sha256), `gcc_suitability`, `usable`, `status`,
`reference_model_id`); `reference_model` (`label` such as "Vero Moda model A", never a name or a model id;
`kind real,synthetic`; `version`; `status candidate,approved,retired`; `pack` jsonb with asset ids per role
FL, HS, BH, FM; unique (brand_slug, label, version)); `brand_style_profile` (versioned, zod-validated `body`,
at most one `approved` per brand). An approved pack or profile is never edited; a change is a new version.
Rights rows are written only through admin-only `PUT /api/catalog/brand-rights/[id]` (the 1.4 route pattern:
creates or updates one row, actor recorded in `recorded_by`, `document_ref` never the text); spec 13 adds
its `lifestyle_scope` column to the same route.

## 2. Shot roles (2.6)

### 2.1 Classifier on the existing judge path

The judge already names a `view` per source photo (`qa/judge.ts:181 VIEWS`, asked at `qa/templates.ts:13`,
stored in `qa_scores.view` at `apps/worker/src/catalog/qa-stage.ts:194`). The template gains four fields
asked in the same call (and `VIEWS` gains `pair`, both shoes in one photo, for spec 13, with a golden
expectation): `role` (one of `SHOT_ROLES`), `head` (`HEAD_STATES`, with DD1's definitions and the
rule "a cut through the hair above the hairline is `full`"), `head_cut_at` (when `cut`: where the top
edge crosses the face), `role_confidence` (0 to 1). `judgeOutput`
(`qa/judge.ts:254`) validates them like `view` (`:218`). No new call per photo.

- Below 0.7 confidence the second judge model (`qaModelSecond`) is asked once; still below 0.7 sets role
  `null` with `role_by = null` and the note "Photo <n>: we could not tell which shot this is. Check it and
  set the shot type." A role that is not sure never fills a slot and never marks a photo cut.
- Roles are judged for every source photo even when `qaSampleRate` < 1 (`qa/policy.ts:67`): a sampled-out
  source gets a role-only call with the same template and `max_tokens` capped; spend under `catalog_qa`.
- A source the judge could not see (`qa_unavailable`, `qa_cap`) gets no role and the note "Shot types were
  not checked for photos <list> because the quality check was unavailable." The planner treats it as
  "not checked" and plans nothing that would retire it.
- `runQaStage` (`qa-stage.ts:116`) writes `role`, `head`, `role_confidence`, `role_by` to the source row
  once per source (the first channel's judging), then `cut_state` (section 3.2).
- The response sentence filter `MODEL_TEXT` (`qa-stage.ts:102`) applies to the new note.

### 2.2 Golden set and bars

- Ops labels role and head for every on-model and flat photo of the spec 10 golden set's apparel products
  (French Connection, Penti, Vero Moda; Anta flat) plus DD1's head fixtures (a full-length photo cut at the
  forehead: `cut`; the same at the shoulders: `none`; cut between nose and upper lip: `cut`). Labels go
  into `golden-manifest.json` as `shots.<n>.role` and `.head` with `labelledBy`; two labellers, a third
  settles disagreements; the manifest records both.
- New check group `roles.*` in the spec 10 job (`evals/roles.ts`): `roles.accuracy_<role>` at least 95%
  correct per required role (fm, fl, fc, bh, hs) on at least 20 labelled photos each; `roles.head_cut`
  100% of `cut` labels caught and no `full` or `none` photo called `cut` on the fixtures; `roles.not_sure`
  reported (information). Live judge only (`run --live`).
- Release switch: worker env `SHOT_SET_MODE` = `report` (default) or `act`. In `report` the planner computes
  and records slots and the sheet shows roles and missing roles, but nothing is reordered, derived,
  generated or retired. The manager sets `act` in the deploy env only after a live run passes `roles.*`.

### 2.3 UI

- Attention product card (`apps/web/components/catalog/AttentionProductCard.tsx`) and the product page
  (`ProductImages.tsx`): each photo shows its shot type in words ("front to mid-thigh", "full length",
  "fabric close-up", "back to the hips", "head and shoulders", "flat lay", "size chart", "other angle",
  "not sure") and, for a cut, "Face cut at the top edge" or "Product cut at the frame edge".
- A "Change shot type" select per photo (operator and admin) writes `role`, `head`, `role_by = operator`
  through `PATCH /api/catalog/sources/[id]/role`; it re-runs the product's plan stage (section 3) with the
  existing lock rule (`catalog/decisions.ts:37-42`). The override wins over every later judging of the
  same sha in the same product (stored by sha in `catalog_products` events as `role_set`; carried forward).

## 3. Planner and the remove-and-replace state machine

### 3.1 Where it runs

New chunk stage `plan`, one chunk per product, queued when the product's `qa` chunk finishes
(`apps/worker/src/catalog/chunk.ts`; the matte stage starts at `:155`). Applies to products whose
`product_type` is `apparel_model` or `apparel_flat`. Pure function plus writes:

```ts
// catalog/shotset/planner.ts
export function planShotSet(input: { channels: ChannelId[]; policies: ChannelPolicy[]; sources: PlanSource[];
  carried: PlanSource[]; options: ShotSetOptions; brand: BrandGenerationState }): ShotPlan;
// ShotPlan: slots[] (channel, role, state, path, occupant, sentence), crops[] (parent, role, box), gens[]
// (mode, role, references), positions: Record<ChannelId, {sourceN: number; position: number}[]>, retire[]
```

Order of work inside the stage: carry forward made sources (3.5), compute cut states (3.2), build slots
(3.3), assign positions (8.1), create crops (section 4: new source rows and a `render` chunk for them, matte
reused), plan generation (section 5: a `generate` chunk), write slots. The product's publish is enqueued
only after the crop chunk's `qa` finishes (crops that go `ready` land in that publish with their
retirements; a crop on a swap card publishes on its decision, 7.1); the
`generate` chunk runs on and never delays the brand photos.

### 3.2 Cut state per source (deterministic)

`cut_state` = `head_cut` when `head = cut` (whether that counts as cut on a channel is that channel's
`head_cut_rule`, 1.4); else `product_cut` when the render's cut sides
(`shotGeometry`, `catalog/render.ts:210`) include a side the role does not allow: `fl` and `flat` none;
`fm`, `bh` bottom; `hs` bottom, left, right; `fc` any; `other` bottom; else `ok`. A source with no role is
`ok` for planning (never retired) and keeps today's `cut_in_source` note.

### 3.3 Slot states

| State | Meaning | Next |
|---|---|---|
| `filled` | an uncut photo fills the role (ladder step 1) | terminal |
| `missing` | nothing fills it | `planned` or `not_made` |
| `occupied_cut` | only a cut photo fills it, or a cut photo is image 1 | `planned` or `not_made` (the cut photo stays) |
| `planned` | a path is chosen (`crop`, `mode_a`, `mode_b`) | `making` |
| `making` | crop written, or generation attempt running | `checking`, `not_made` (cap, error) |
| `checking` | made source in render, judge, compliance, gate (generated only) | `in_review` or `ready` by the review rule below, `making` (next attempt or next parent), `held` |
| `in_review` | every automatic check passed; a person must decide (7.1, 7.2) | `ready` (publish decision), `not_made` (`removed`) |
| `held` | generated: ladder exhausted on a failed check | `in_review` only through the 7.2 two-rater protocol (never alone; never for `wrong_garment`, `logo_changed`, `text_invented`), `not_made` |
| `ready` | approved, waiting for the publish move | `live`; a failed publish leaves it `ready` and the next publish retries |
| `live` | replacement live; cut occupant retired in the same publish | terminal for this batch |
| `not_made` | ladder exhausted, or `removed`, or `superseded` (6.3); occupant untouched | terminal for this batch |

Review rule at `checking` (the gate phase is `catalog_gate_state` scope `shotset` of the product's brand;
no row means `review_all`):

| Made source | Brand in `review_all` | Brand in `sampled` |
|---|---|---|
| crop, slot `occupied_cut` (it retires a cut photo); phase is scope `crops` | `in_review`, swap card, one person decides (7.1) | `ready` (automatic retirement), except a deterministic 10% sample, which goes to the swap card (7.4) |
| crop, slot `missing` (nothing retired) | `ready` | `ready` |
| generated (mode A or B), any slot; phase is scope `shotset` | `in_review`, two raters (7.2); their publish decision also decides the retirement | `ready` on the gate, except the 10% sample and mode B anchors, which go `in_review` (7.4) |

So while a brand is in review-all no cut photo leaves any listing without a person's publish decision on
its replacement, and after exit only automatic checks plus the 7.4 sample stand between a passed
replacement and the retirement. A crop that fails a check is never held: the slot tries the next parent,
then the next ladder step.

Invariants (unit-tested as properties on random plans):
1. An occupant is retired (8.2) only by the publish that copies its slot's replacement, and only after that
   copy is verified; `publishProduct` already runs deletes only when no copy failed
   (`pipeline/publish.ts:143`). A retire entry whose replacement is not in the same plan's copies or already
   live throws in `planPublish`.
2. A slot never moves from `occupied_cut` or `filled` to fewer live photos on its channel.
3. `not_made` never touches the occupant. 4. A retire whose slot reached `ready` without a recorded
   publish decision while the brand was in `review_all` throws in `planPublish`. 5. In `report` mode only `filled`, `missing`, `occupied_cut`,
   `not_made` (with reason "not yet active") are written.

### 3.4 The ladder per slot

1. **Existing photo**: an uncut brand source with that role. For image 1, any uncut `fm` or `fl` source is
   moved to position 1 at once (8.1); this is a reorder, no photo is lost.
2. **Crop** when `options.shotSet.crops`: section 4 picks parents; first crop that passes wins.
3. **Mode A** when `options.shotSet.generate`, the brand's `generate_enabled`, an approved generator, the
   product has at least one on-model brand photo, and the garment is not excluded (3.6).
4. **Mode B** when also `options.shotSet.modeB`, the product has no on-model brand photo but a `flat` source,
   and the brand has an approved reference model and style profile for the product's gender.
5. **Not made** with the sentence of 3.7.

One made photo may fill the same role on several channels: the planner makes a role once per product (the
largest crop bar among the channels that need it decides the parent), not once per channel.

### 3.5 Carry-forward across batches

`planPublish` deletes a live output whose `n` has no source row in this batch (`pipeline/publish.ts:63`).
So the plan stage of every later batch for the product re-inserts each current made source as a row of the
new batch (same `n`, `sha256`, `raw_uri`, `derivation`, `kind`) when it is still valid:
- derived: its parent's sha is among this batch's sources; the crop is recomputed and must give the same
  box and sha (else it is a new crop under the same `n`, re-checked).
- generated: every `referenceShas` entry is among this batch's sources (mode B: the flat lays, the pack
  version still approved); its review decision carries (`derivation.review`).
- otherwise derived is re-planned from scratch; generated is re-planned when generation is on, else carried
  with the hold flag `references_changed`, slot `held`, on the review card with "Photo <n> was made from
  earlier photos of this product. Keep it or remove it." (7.2 protocol). A made photo is never dropped silently.
- a made photo whose role is now filled by an uncut brand photo of this batch is not carried: its outputs
  are removed (event `made_photo_removed`, note "Photo <n> was replaced by the brand's own photo <m>.") in
  the same publish that makes the brand photo live (invariant 1 applies; the brand photo gets a new link).
The made photos' outputs are re-rendered only when `render_key` changes, as for any source.

### 3.6 Exclusions

The plan stage reads `garment_kind` from the product classification call (`qa/classify.ts:35` gains a
second field `garment` with DD0 department values `tops,knit_sweat,outerwear,dresses_jumpsuits,bottoms,
active,lingerie_underwear,sleep_lounge,swimwear,kids,unknown`). For `bottoms`, `lingerie_underwear`,
`swimwear`, `kids`, `unknown`: slots are reported and never `missing` (no "missing" column entry, no
generation, no retirement). For `dresses_jumpsuits`: `fm` is not derived from a maxi length (open item 2).
A printed garment (any `detailFeatures` region with text, `render.ts:308`, on a source) is crop-only unless
the brand's `generate_printed` is true (I5 risk 2).

### 3.7 "Not made" sentences (sheet notes, product page; no model names)

| Key | Sentence |
|---|---|
| `too_small` | "<Channel>: <role> not made: the photo is too small to cut a <role> from it." |
| `no_whole_head` | "<Channel>: <role> not made: no photo shows the whole head to cut it from." |
| `no_parent` | "<Channel>: <role> not made: no photo of this product contains a <role>." |
| `making_off` | "<Channel>: <role> not made: making new photos is off for this brand." |
| `no_brand_model` | "<Channel>: <role> not made: no approved brand model for <brand> <gender> yet." |
| `no_rights` | "<Channel>: <role> not made: no written permission is recorded for this brand's model photos." |
| `excluded` | "<Channel>: <role> not made: the tool does not make photos for this kind of product." |
| `printed` | "<Channel>: <role> not made: this product has print or text that made photos cannot copy exactly yet." |
| `failed_checks` | "<Channel>: <role> not made: the made photo did not match the product closely enough." |
| `removed` | "<Channel>: <role> not made: a reviewer chose not to use the made photo." |
| `cap` | "<Channel>: <role> not made: this batch's limit for made photos was reached. Raise it to make the rest." |
| `not_active` | "<Channel>: <role> is missing." (report mode) |

Where a cut photo stays because its slot is `not_made`, the sheet adds "Photo <n> is still used: no
replacement could be made." `<role>` is the plain role name of 2.3.

## 4. Crop engine (derived sources)

`catalog/shotset/crop.ts`, deterministic, no network:

```ts
export const CROP_RULE_VERSION = "1";
export function cropFor(input: { role: "fm"|"bh"|"hs"|"fc"; parent: { width: number; height: number;
  alpha: Buffer; rgb: Buffer; role: ShotRole; head: HeadState; headBox?: BBox }; barPx: number }):
  { ok: true; box: BBox; heightPx: number } | { ok: false; reason: "too_small"|"no_whole_head"|"band"|"logo"|"no_parent" };
```

Rules (DD2 R1, I5 stage A):
- Parents: `fm` from `fl`; `bh` only from a `bh` or full back (`other` with view back), never a mirrored
  front; `hs` from `fm` first, then `bh`-free fronts, then `fl`; `fc` from `flat`, or from an on-model region
  with no skin, hair or face (decided by the human-parsing mask of 6.2 when built; until then flat only, and
  Styli's acceptance of on-model fabric crops is an open question, 13). Parent head state `full` for fm, hs.
- Band, measured on the parent's matte silhouette (rows with alpha over 128): `fm` cut line at 62% to 72% of
  the silhouette height from the top of the head; `bh` 48% to 58%; `hs` 26% to 34% (below the bust);
  `fc` a square-ish region (aspect 3:4) at least 35% of the garment width, centred on the largest garment
  area with no `detailFeatures` region crossing its edge. The line is moved within the band to the nearest
  row where no `detailFeatures` region (`render.ts:308`) crosses it; none found is `logo`.
- Head box: the topmost connected silhouette part above the shoulder line (the narrowest row in the top
  third); the crop keeps at least 5% of the crop height above the head box top (G6's rule); a head box
  touching the parent's top edge is `no_whole_head`.
- Width: the silhouette's left and right extent plus 4% each side, clamped to the frame; the box is then
  padded (never cut further) to 3:4 when the frame allows, else kept as is and fitted by the render.
- Size: `heightPx` must be at least the channel's crop bar (`crop_min_px` when `UPSCALE_MODEL` is set,
  else `crop_min_px_no_upscaler`); below that `too_small`, never a soft enlarged crop.
- Output: the crop of the parent's raw pixels as lossless PNG, and the same box cut from the parent's matte
  (`matte_uri` of the derived row points to it; no matte call; `matte_model` copied). Status `matted`.
- A derived source then runs the normal render, compliance, judge and triage; spec 10 `geometry.pixels_copied`
  and `cutout.*` hold unchanged. It carries the information flag `derived` (note "Cut from photo <parent n>
  to complete the <role> shot."). It needs a person only when it retires a cut photo while the brand is in
  review-all (the swap card, 3.3 and 7.1). Cost row: stage `derive`, kind `compute`, usd 0.

## 5. Generator client, policy, caps, ledger, LIVE_SMOKE

### 5.1 Client

`callLlm` reads text only (`llm/llm.ts:64-74,77`) although the chat response type declares
`message.images` (`llm/openrouter.ts:201`). The generator uses OpenRouter's image endpoint through the same
private `post` (`openrouter.ts:117`, which `chatCompletion` uses at `:179`), so key handling and retry
budgets are shared:

```ts
// llm/openrouter.ts
export function createImage(body: ImageRequest, deps?: OpenRouterDeps): Promise<ImageResponse>; // POST /images
// llm/images.ts
export interface ImageRequest { model: string; prompt: string; aspect_ratio: "3:4"; resolution: "2K" | "4K";
  input_references: { type: "image_url"; image_url: { url: string } }[]; output_format: "png"; n: 1;
  session_id: string; user?: string; provider?: { allow_fallbacks?: boolean } }
export interface GeneratedImage { bytes: Buffer; mime: string; width: number; height: number; costUsd: number; model: string }
export async function generateImage(req: ImageRequest, deps?: OpenRouterDeps): Promise<GeneratedImage>;
```

`generateImage` throws `LlmResponseError` when `data[0].b64_json` is missing, decodes and size-checks the
bytes (max 40 MB), reads `usage.cost` (`llm/util.ts:28 readCost`; absent cost uses the policy's list price
and marks the ledger row `estimated`). `session_id` = `<batchId>:<productId>`. A model that is served only
on chat completions is out of scope for this spec (13).

### 5.2 Requests (prompt shapes from DD3; `catalog/shotset/prompts.ts`, versioned `PROMPT_VERSION`)

- Mode A: references are every brand source of the option that shows the garment (on-model and flat),
  ordered front, back, detail, flat, at most 10, each sent as the `qaImage`-sized JPEG; the prompt names
  them by ordinal ("Image 1 is the front to mid-thigh ..."), describes the missing role in the band words
  of section 4, asks for the same person, lighting and a plain background of the brand's measured colour,
  and forbids adding, moving or restyling any logo, label, print or text, and showing more skin than the
  references.
- Mode B: references are the flat lays of the option, then the approved pack's FL photo of the reference
  model (after the anchor, also the approved anchor); order and review per 9.3.
- Attempts: 1 primary model; 2 primary model with the stronger-reference wording block; 3
  `generate_model_escalation`. Then the slot is `held`. Each attempt is gated (section 6) before the next.
- Output: 3:4 at `generate_resolution`; stored as the generated source's raw; matted by the normal matte
  stage (apparel policy), then rendered and judged like any source; flag `generated` (information, note
  "Made from this product's own photos to complete the <role> shot." or, mode B, "Made by placing this
  product on the brand's model to complete the <role> shot.").
- AI marker: every rendered output of a generated source carries the XMP `Iptc4xmpExt:DigitalSourceType`
  `http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia` and `dc:description` "AI-generated
  product image", written by the encoder (`catalog/shotset/xmp.ts`, `aiXmp(sourceType, description)`; check
  sharp's XMP output through Context7). Compliance code `ai_tag` reads it back and holds with
  `ai_tag_missing` when absent. Spec 13 calls the same helper (its composite type and description).
  Derived crops carry no marker (no new pixels).

### 5.3 Gates on every call

`generateForSlot` refuses, before any network call, unless all hold: `options.shotSet.generate`; policy
`generateEnabled` and `generateApproval` present; `SHOT_SET_MODE=act`; for mode B a covering `brand_rights`
row with both use flags and an approved reference model; and the caps:

```ts
// qa/caps.ts
export async function checkGenerateCaps(db: Db, input: { batchId: string; capUsd?: number; env?: NodeJS.ProcessEnv; now?: Date }): Promise<CapCheck>;
```

It applies the daily cap over all engines (`checkCatalogCaps`, `qa/caps.ts:20-25`) and the batch cap
(`capUsd` when the caller passes one, spec 13's lower scene cap; else `shotSet.generateCapUsd`) against `sumSpendForBatch(db, batchId, "catalog_generate")` (`spend.ts:41`); it is
called before every attempt, as `checkCatalogCaps` is before every judge attempt (`qa-stage.ts:62`). A
refusal sets the slot `not_made` with key `cap`. Gate judge calls count as `catalog_qa` and use
`checkCatalogCaps`. Spend is written by `recordCost` (`spend.ts:53`) with engine `catalog_generate` and one
ledger row per attempt (`recordCostEvents`, `cost-events.ts:75`): stage `generate`, kind `generate_call`,
engine the model id, `usd`, `ms`, `attempt`, `outcome` (`ok,failed,rate_limited,cap`).

### 5.4 LIVE_SMOKE and tests

- Tests never call the generator: `deps.generateImage` is injected; `llm/mocks.ts mockFetch` gains a
  `/images` handler returning a fixture PNG as `b64_json` with `usage.cost`; unmatched calls throw as today.
- Jobs: the `shotset` mode of `catalog-output-evals` and `catalog-harvest` tagging call live models only
  with `LIVE_SMOKE=1` (`apps/worker/src/catalog/qa-mock.ts:12 liveQaEnabled`; the job script refuses
  LIVE_SMOKE in the job definition as `infra/catalog-eval.sh:42,102` does).
- Production worker: live only behind the batch option plus the policy flag plus `SHOT_SET_MODE=act`.

## 6. Fidelity gate G1 to G6, retry ladder, hold flags, triage

### 6.1 What exists and what is new

On `main` the matting service serves only `/health`, `/matte`, `/convert`, `/upscale`
(`services/matting/app.py:159,164,195,394`); there is no LPIPS endpoint and no OCR library (the spec 11 gate
was built with `ssim`, `gradientStructureDistance`, `deltaE2000`, `textureCells`, `textRegions` in
`catalog/evals/enhancement.ts:120,167,199,241,261`). DD2's "reuse the LPIPS endpoint and tesseract" is
therefore new work here. New endpoints on `catalog-matting` (CPU allowed; GPU preferred when listed in
`/health` `measure.models`), each pinned by export sha in `MEASURE_MODEL_VERSIONS` (the
`UPSCALE_MODEL_VERSIONS` pattern):
- `POST /measure/embed` (multipart `image`, `mask`): DINOv2 ViT-B/14 ONNX, returns `{ vector: number[] }`.
- `POST /measure/lpips` (multipart `a`, `b`): AlexNet-linear, returns `{ lpips }`.
- `POST /measure/parse` (multipart `image`): a human-parsing ONNX model returning label PNG for garment,
  skin, hair, face, background; the builder picks one through Context7 and records licence and sha
  (any open weight is allowed, SPEC L44-47).
OCR: tesseract.js in the worker (`catalog/shotset/gate/ocr.ts`). Cost rows: stage `gate`, kind
`measure_call` (GPU seconds priced as spec 11 section 7) and `llm_call` for judge questions.

### 6.2 Checks (initial bars from DD2 R2; final bars from the labelled set, as spec 10 section 15 did)

Measured on the generated source against the brand references, garment mask from `/measure/parse`
(garment label intersected with the matte):

| Check | Measure | Pass bar | Hold flag |
|---|---|---|---|
| G1 garment identity | DINOv2 cosine of garment-mask crops vs the reference of the same view; judge "same garment" from both judge models | same view >= 0.85; cross view >= 0.70 and both judges yes | `wrong_garment` |
| G2 logo and text | OCR on every source `detailFeatures` region with confidence >= 60, same string on the output (normalised, Levenshtein ratio >= 0.90); no output string absent from every source; text-free logos by normalised cross-correlation >= 0.70 after a scale search | every region; zero invented strings | `logo_changed`, `text_invented` |
| G3 colour | CIEDE2000 of the three dominant Lab colours of the garment mask, area-weighted, vs the same-view reference; mode B against the flat lay with a shading allowance `G3_FLAT_ALLOWANCE` (start 0, set from labels, 13) | mean <= 3.0, each <= 5.0 | `colour_shift` |
| G4 texture and print | LPIPS on three feature-matched 256 px garment patches (same view); texture energy ratio (`textureCells`); cross view by judge "pattern continues" | LPIPS <= 0.35 per patch; ratio median 0.7 to 1.4 | `texture_changed` |
| G5 model and scene | background within compliance tolerance (`BG_TOLERANCE`); skin CIEDE2000 on the parse `skin` label vs shot 1 or the anchor <= 3.0; judge pairwise "same person, same lighting" and "hands and limbs correct" | all pass; no face vector computed or stored | `model_mismatch`, `anatomy` |
| G6 crop geometry | head box whole with >= 5% margin, cut line in the role band of section 4, aspect 3:4 within 1%, long side >= 90% of the requested resolution tier | pass | `crop_rule` |

Verdict: every check passes or the source is held; no mean, no override. A check that cannot run (endpoint
down after 3 retries, judge unavailable) is `gate_unavailable`: a hold, never a pass. Results go to
`derivation.gate` (numbers, bars, measure versions) and to `qa_scores.gate` of each output; no judge or
generator model id is written to `qa_scores.gate`, which the web reads.

### 6.3 Retry ladder and holds

On a failed check the slot returns to `making` for the next attempt (5.2); `compliance.auto_actions`
records each attempt like the repair ladder. After attempt 3 the slot is `held`; the source's outputs are
`needs_attention` with the failing flags. New flags join triage (`qa/triage.ts`): all gate flags and
`references_changed` are added to a `GATE_HOLD_FLAGS` set that always holds (cause `made_photo`), never
drops and never notes; `derived`, `generated`, `cut_retired` join `INFORMATION_FLAGS` (`:11-15`). A held
or in-review made photo never holds its product's brand photos: `publishProduct`'s hold test
(`pipeline/publish.ts:107-108`, both the `unjudged` clause and the status clause) and `triageProduct`
(`qa/triage.ts:58`) ignore outputs for which `madePending(o)` holds; those outputs are neither copied nor
counted as good shots. One predicate in `pipeline/publish.ts`, used by the hold test, triage and the `change`
choice:
`madePending(o) = slotPending(o) || lsPending(o)`, where `slotPending(o)` = the output's source is made and
its slot is `checking`, `in_review` or `held`, and `lsPending(o) = source(o).role === 'ls' &&
source(o).scene.state in ('checking','in_review','held') && o.decision === null` (the slot-free clause for
spec 13's scene image, whose `scene` column and states spec 13 s1.3 and s7.4 define).
Product `change` is `pending_review` while any output is `madePending` and nothing else holds. The lock is
not kept for `pending_review`: `releaseLocks` (`publish.ts:71-74`) frees it at finalize like any published
product, so a re-delivery is never refused (no 409 from `decisions.ts:40`). A publish decision re-takes the
lock with the existing rule (`decisions.ts:37-42,55`) and enqueues the publish. If a newer batch already
holds the product, every `in_review` or `held` slot of the older batch becomes `not_made` (`superseded`,
sentence "<Channel>: <role> not made: a newer delivery of this product replaced this one.") and the newer
batch plans the product again.

## 7. Review-all card, raters, exit numbers, sampled review, relapse

### 7.1 Card

`listAttention` (`catalog/attention.ts:15`) adds a section "Made photos to review (N)" with one card per
generated source whose slot is `in_review` or `held`, plus spec 13's scene cards (source role `ls`,
`scene.state` `in_review` or `held`; its own questions in `answers`). A shot-set card shows: the product's brand photos, the made photo large, its role in
words, the six questions as yes or no, and "Publish this photo?" yes or no. The gate verdict, the failing
check's sentence and the attempt count are hidden until the rater saves, then shown. Mode B anchors show
"First full-length photo: the other shots will be made from it." No generator or model name anywhere.
When the slot retires a cut photo, the card also shows that photo with "Photo <n> will leave the listing
when this one is published."

A second section "Photo swaps to approve (N)" holds one swap card per crop in `in_review` (3.3 review rule):
the cut photo and the crop side by side, "Is the whole head and product in the new photo?", "Are every
logo and text whole?", "Is it the same product and the right shot type?", and "Swap now?" yes or no. A
"no" to either of the first two is a reported head or logo cut. One person (operator or admin) decides:
yes sets the slot `ready` and enqueues the publish; no sets it `not_made` (`removed`) and the cut photo
stays. Answers are stored in `catalog_review_labels.answers` (`card: "swap"`), event `cut_swap_decided`.

Questions (stored `q1` to `q6`): "Is it the same garment?"; "Are every logo and text unchanged, and nothing
added?"; "Is the colour the same?"; "Are the print and fabric texture the same?"; "Are the model, lighting
and background the same as the other photos?"; "Are the hands, body and framing correct?".

### 7.2 Raters and decision

- Rater 1 is any operator or admin; rater 2 must be a different person (the named second rater, I5 Q2).
  `POST /api/catalog/review/[sourceId]` stores one `catalog_review_labels` row per rater (unique), refuses a
  second answer from the same person (409 "You already answered for this photo."), and never returns the
  other rater's answers before both exist.
- Both "publish yes": decision `use_as_is` on every output of the source (`applyDecision` path,
  `catalog/decisions.ts:44`, which re-takes the lock with the existing rule `:37-42,55`), slot `ready`,
  publish enqueued; the publish is the remove-and-replace move (8.2).
- Both "no": decision `remove`, slot `not_made` (`removed`), event `made_photo_removed`.
- Disagreement: the card moves to "Needs a third opinion" for an admin who did not rate; the admin's row
  (`phase adjudication`) decides.
- `held` photos: the same protocol, two raters label and the decision follows it; one person alone can never
  publish a held photo, and a photo held for `wrong_garment`, `logo_changed` or `text_invented` has no
  "Publish" option at all (only "Remove"). The operator's "Use as is" (`decisions.ts:44`) is refused for any
  output of a made source with 409 "Made photos are published through the review card."
- Event `made_photo_reviewed` with the answers' summary (no model id).

### 7.3 Measures (computed by `catalog/shotset/review.ts`, per brand and overall)

False pass: gate passed, final decision publish no. False hold: gate held, final decision publish yes.
Per-question agreement: Krippendorff's alpha over the two raters (nominal). Planted defects: the eval job
(section 11) plants a wrong garment, a moved or altered logo and a colour shift of dE 5 or more.

### 7.4 Exit, sampled review, relapse

- Exit for a brand (`catalog_gate_state.phase` to `sampled`, set by an admin action on the Ops page that is
  enabled only when the numbers hold, and recorded in SPEC per 0.5): overall at least 300 labelled
  generated shots over at least 3 brands and all 5 roles; false passes <= 2% with zero on G1 and G2; false
  holds <= 15%; planted defects caught 100%; alpha >= 0.67 on every question; and the brand itself has at
  least 50 labelled shots with zero G1 and G2 false passes.
- The two exits are separate, per brand, in `catalog_gate_state`:

  | Scope | Exit to `sampled` | After exit | Back to review-all |
  |---|---|---|---|
  | `shotset` (generated) | the numbers above (300 shots over 3+ brands and 5 roles, then 50 for the brand) | gate plus 10% two-rater sample | relapse rule below |
  | `crops` (swaps) | 50 consecutive swap cards for the brand approved, with zero rejections and zero reported head or logo cuts; set automatically on the 50th, event `crops_exit` | passing crops retire cut photos automatically; a deterministic 10% (hash of source id) still goes to the swap card | any rejection or reported cut of a sampled crop: brand's `crops` back to `review_all` at once, counter reset to 0, event `crops_relapse` |

  A rejection or reported cut during review-all resets the run of 50 to 0.
- Sampled review: each batch sends a deterministic 10% of its gate-passed generated sources (hash of source
  id, the `sampledForQa` pattern, `qa/policy.ts:67`) to the two-rater card; the rest go `ready` on the gate
  alone (`derivation.review.phase = auto`). Mode B anchors and held photos are always reviewed.
- Relapse: a batch whose sampled shots show over 2% false passes, or any G1 or G2 false pass, sets the
  brand back to `review_all` at once (event `shotset_relapse` on the batch, alert in 12.2); exit again needs 50 new
  labelled shots of that brand meeting the bars.

## 8. Publish, ordering, re-submission, links sheet

### 8.1 Order per channel

`position` per output is written by the plan stage: the channel's required roles in its order, each filled
by the first live-able source of that role (brand before derived before generated, then lowest `n`), then
every other source by `n`, then role `ls` after all others (spec 13). Rules: position 1 is never a source with `cut_state` other than `ok`, when any
uncut `fm` or `fl` (or for flat-only products any uncut `flat`) exists; a size chart stays left out
(`chart_image`). In `report` mode positions equal today's `n` order. A change in order with no new image is
`reordered`.

Image 1 background: `backgroundFor` (`catalog/channels.ts:196-200`) is called with the position, not the
shot number (`render.ts:568`), so Amazon and Shein image 1 is the photo in position 1. `renderKey`
(`pipeline/publish.ts:21`) gains `first: boolean` for channels with `firstImageBackground`; when the plan
moves position 1, only those outputs re-render (scores kept, compliance re-run). `CHANNEL_RULES_VERSION`
(`channels.ts:216`) goes from `"10"` to `"11"` (order and image-1 rule); every live output re-renders once
on its next batch.

### 8.2 The publish move

`planPublish` (`pipeline/publish.ts:55-69`) gains `retire: { output, replacedBySourceN }[]`, built from slots
in `ready`: on a channel whose `head_cut_rule` fails the occupant's `head_cut`, or for any `product_cut`
role slot, the occupant's output on that channel gets decision `remove` with `decided_by = "system"`, flag
`cut_retired`, reason "Replaced by photo <m>, which shows the whole <head|product>."; where the occupant was
only image 1 and the channel allows it elsewhere, it moves to a later position instead (no delete). Copies
run first; retire deletes run only if every copy verified (`:143`) and each retire's replacement is in this
plan's copies or already live (invariant 1). Slots go `live` in the same transaction. Brand photos,
derived photos and approved generated photos of one product therefore land in one publish where possible;
a later approval runs a second publish of the same batch under the re-taken lock (6.3).

A cut photo whose role is not a required role on the channel (`other`, a second `fl`, a role the channel
does not ask for) has no slot and is never retired: it keeps its link, is placed after the required roles
(8.1), carries the information flag `cut_kept` and the note "Photo <n> is still used: it is cut at the
edge and no shot type the channel asks for replaces it."

### 8.3 Re-submission values

`change` (`publishProduct`, `:151`) precedence: `failed`, `shots_removed` (a brand shot gone from the
delivery), `new`, `cut_replaced` (any retire in this publish), `role_added` (a made photo newly live, no
retire), `reordered`, `updated`, `unchanged`; `pending_review` while 6.3 applies. `cut_replaced` and
`role_added` both mean "re-submit this product's image columns on that channel" (SPEC L397-398 as amended).
Events: `cut_replaced` (details: channel, retired n, replacement n, role), `role_added` (channel, n, role,
kind). The overwrite report lists retired links like removed links (`report.ts:170`).

### 8.4 Links sheet

- Links are placed by `position` (`pipeline/report.ts:150` today places at `n - 1`; with made `n` from 101
  that would leave 100 empty cells).
- Per ticked channel, after its "Image n" columns (`sheet.ts:45,92`), two columns: "<Channel> shots" (the
  role per image in order, for example "1 front to mid-thigh, 2 full length, 3 fabric close-up (cut from
  photo 1), 4 back to the hips, 5 head and shoulders (made)") and "<Channel> missing" (roles still missing,
  or empty). Footwear and other non-apparel rows show roles only.
- `notes` carry the 3.7 sentences, the made-photo notes of 4 and 5.2, "Photo <n> was replaced on <Channel>
  because <reason>." for each retire, and the 2.1 role notes. The cut note (`report.ts:43-48`) names only
  photos still live with a cut. The status column is unchanged; a missing role is never a status.
- The filled product list and the brand sheet carry the same columns. `pnpm catalog:recheck` and the
  independent re-check count the made links like any link.

## 9. Mode B: registry, harvester, rights, anchor flow

### 9.1 Harvester job

`apps/worker/src/catalog-harvest.ts`, deployed as Cloud Run job `catalog-harvest` by an idempotent
`infra/catalog-harvest.sh deploy | run --site <id> [--live]` in the `catalog-eval.sh` pattern (min 0, 1 vCPU,
1 GiB). One execution per `brand_source_site`:
1. Refuse unless the site's `rights_id` row is valid today, lists the site's host, and
   `allows_reference_use` is true (exit 1 with the reason).
2. Probe and read as DD8 R3 says (robots.txt and `Crawl-delay` respected, a disallow sets
   `last_probe.blocked`; the four readers; `brand_filter`), downloading each image once through `safeFetch`
   (`safe-url.ts`, GET only, 40 MB cap), concurrency 1 to 2.
3. Writes the bytes to the private bucket at `models/<brand_slug>/<sha256>.<ext>` only. New guard
   `assertModelsPrefix(objectPath, brandSlug)` in `naming.ts` (the `assertWithinProduct` shape,
   `naming.ts:166-180`) throws on any other path; the job never writes `catalog/` or `catalog-test/`.
4. Tags each new asset with the judge (DD8 R2 tag fields; live only with `LIVE_SMOKE=1`, else status
   `new`); `background_rgb` measured by code. Spend engine `catalog_qa` under a harvest batch row (`catalog_batches` with `options.evalSet =
   "harvest"`), so the caps and the ledger apply.

### 9.2 Grouping, packs, profile (admin pages under `/catalog/brands/[slug]/models`)

- Contact sheet of tagged usable assets; the judge's pairwise "same person?" suggestions within one brand
  (labels only, no embedding); the admin confirms groups into a `reference_model` candidate.
- Pack: FL front with face, HS, BH (FM if any), each at least 1,500 px long side, white or light-grey
  background, `gcc_suitability = ok`, rights-covered. "Approve" sets `approved` with `approved_by`; never edited.
- Style profile v1: code measures background colour and crop lines from evidence; the admin edits modesty
  and styling fields; zod validation must pass; "Approve" versions it. `model_policy.style_profile_id` and
  `reference_model_id` are set per (brand, category) through the policy writer.
- Synthetic fallback exactly as DD8 R4 (no approved real pack for the brand and gender; admin-started
  "Make a synthetic model sheet" under a harvest batch's caps; approved as `kind = synthetic`); real and
  synthetic models are never mixed within one product.

### 9.3 Anchor flow

Mode B slot planning for a product: `fl` first (slot `planned`, anchor). The anchor goes through the gate
and always to the two-rater card. On approval its sha becomes `anchorSha` for the product; `fm`, `bh`, `hs`
slots move from `missing` to `planned` in the next `generate` chunk (queued by the approval) with the
anchor as the last reference; `fc` is a crop of the flat lay. A removed anchor sets every mode B slot of the
product to `not_made` (`removed`). Generated outputs record profile and pack versions in `GenKey`.

## 10. Rollout: all-brand test run, scorecard, exit per brand, backfill order, steady state

### 10.1 All-brand test run (not a pilot gate)

Run by the manager after deploy, in `catalog-test/` (`isTest` batches), one batch per apparel brand with
every apparel product of that brand in the owner's folders (read only; no sampling, so the scorecard covers
the brand; the cap may stop generation early, which the scorecard shows as `cap`), every channel ticked, `shotSet = { crops: true, generate:
true, modeB: <brand has an approved model>, generateCapUsd: <set per batch, never null>, testRun: true }`,
review-all regardless of `catalog_gate_state`. Vero Moda goes first as the technical test brand (crop,
mode A and mode B in one batch); the others follow. No live channel or marketplace sees a test batch.

### 10.2 Scorecard

`catalog/shotset/scorecard.ts` computes, per batch and per brand, at finalize into `report.json`
`shotSet` and `exports/scorecard-v<k>.csv`, and the Ops page (`apps/web/app/catalog/ops/page.tsx`, a new
section "Shot sets per brand" after "Cost of one batch") reads the latest per brand:

| Field | Definition |
|---|---|
| products, apparel products | in the batch |
| complete sets before, after | per channel: products whose required roles are all filled before the plan, and after (live) |
| roles filled by | existing, crop, mode A, mode B, per role |
| not made | count per sentence key of 3.7 |
| cut photos | found (head, product), replaced, still live |
| first-attempt gate pass rate | passes on attempt 1 / attempts 1 |
| holds by check | G1 to G6 and `gate_unavailable` |
| review | reviewed, published, removed, disagreements, alpha per question |
| false passes, false holds | 7.3, with counts |
| cost | generate USD, gate USD, USD per accepted generated image, attempts per accepted image |
| Styli and Centrepoint eligible | products with all five roles live on that channel |
| coverage | apparel products in the batch; the manager's 10.1 report sets each brand's figure against its apparel options in the inventory count ("<a> of <b>") |
| swaps | swap cards decided yes and no; cut photos kept by `cut_kept` |

The business sets the fix order from the scorecards (which brand, which role, which not-made reason);
nothing in the module ranks brands.

### 10.3 Exit per brand, backfill, steady state

- Exit is per brand and per scope by 7.4: until the `shotset` exit every generated shot is reviewed; until
  the `crops` exit every crop that retires a cut photo waits for a swap card. The crop exit usually comes
  first (crops are backfilled first), so crop-only brands reach automatic swaps without generating.
- Backfill order on live (non-test) batches after the test run: crops first for every apparel brand
  (`generate` off), then mode A per brand in the order the business sets, then mode B where a model is
  approved. Each live batch has its own `generateCapUsd`.
- Steady state for new products: the wizard's step 3 shows "Complete shot sets" (crops) and "Make missing
  photos" (generation; shown only for brands with `generate_enabled`), both unticked by default (SPEC R10:
  nothing pre-ticked), plus "Limit for made photos (USD)" required when the second is ticked. Step 4's
  estimate line adds "Up to <k> photos may be made, at most USD <cap>."

## 11. Tests and evals

Tier 1 (`pnpm test`), per workstream:
- A: migration applies on PGlite (`db/testing.ts:16`), additive; `SHOT_ROLES` does not clash with `ROLES`.
- B: parse of `role`, `head`, `role_confidence`; second judge once below 0.7; role-only call for sampled-out
  sources; `qa_unavailable` leaves role null with the note; the operator override wins.
- C: `planShotSet` covers every ladder step, every 3.7 key, the exclusions, report mode, the review-rule table of 3.3; invariants 1 to 5
  as property tests; carry-forward keeps made `n` and sha and re-plans when a parent or reference is gone.
- D: `cropFor` bands, head margin, logo avoidance, `too_small` per channel bar with and without
  `UPSCALE_MODEL`, 3:4 padding, derived matte equals the parent matte cut; spec 10 `geometry.pixels_copied`
  and `cutout.*` pass on a derived output.
- E: `/images` request shape, base64 decode, missing image throws, `estimated` cost; `checkGenerateCaps`
  refuses at both caps and on a null `generateCapUsd` with no fetch; the XMP marker is written and read back; one ledger row per attempt; spec 07 banned-names test passes.
- F: each G check passes an identity fake and fails its planted defect (shifted garment, replaced logo
  string, invented text, dE 6 colour shift, flattened texture, second person, head at the top edge, an
  896x1200 answer to a 2K request); an
  unavailable measure holds; at most 3 calls, escalation model on the third.
- G: two different raters, blind until both, adjudication, held photos only through the protocol, G1 and
  G2 holds unpublishable, "Use as is" on a made output refused; swap card yes and no; supersede by a newer
  batch; alpha on fixtures; exit and relapse transitions.
- H: positions and the image-1 rule, `first` in `renderKey`, links by position, sheet columns, `change`
  precedence; `planPublish` throws on a retire without its replacement or without a review-all decision; a
  copy failure leaves the occupant; `amazon_nose_lip` keeps a nose-lip cut on Amazon; `cut_kept` photos.
- I: readers on recorded fixtures, robots refusal, rights refusal, `assertModelsPrefix`, pack validation.

Tier 2 (PGlite, in-memory storage fake, mocked judge and `/images`; `pipeline.test.ts` pattern): a product
with a head-cut photo 1 and no HS, brand in review-all: HS and FM crops are made, the swap card appears,
nothing is retired until "Swap now? yes", then the cut photo leaves position 1 and is removed on Styli in
the same publish, `change = cut_replaced`; the same product with the brand in `sampled` swaps with no card; a product with tiny sources gets `too_small` and
keeps its cut photo; a mode A candidate does not hold the brand photos, is approved by two raters and
publishes as `role_added`; a forced copy failure on a replacement leaves the cut photo live; a re-delivery
with the same photos is `unchanged` with made photos carried; dropping the parent re-plans.

Tier 3 (`REAL_DATA=1 pnpm test:real`): render of derived crops from the golden Vero Moda masters with the
local CPU matting container, under `catalog-test/` only, deleted in `finally`.

Eval job: `bash infra/catalog-output-evals.sh shotset [--live]` (worker entry `catalog-output-evals.js
shotset`) runs `roles.*`, the crop rules on every golden apparel product, and with `--live` (`LIVE_SMOKE=1`,
under `EVAL_BUDGET_USD`) generation for a fixed golden list with the gate and the three planted defect
kinds. It writes `catalog-test/evals/<run>/shotset/report.json` and `report.html` and prints `Shot set eval:
roles <a>% (head cut <b> of <c>), crops <d> made, gate <e> of <f> planted caught`; exit 1 on a failed bar.
Review labels from test batches feed 7.3. Cleanup only under `catalog-test/` (`assertTestPrefix`,
`naming.ts:183`); harvested references are never test data.

## 12. Acceptance checklist, monitoring and cost hooks, operator guide

### 12.1 Acceptance (the manager ticks each in the 00 section 10 report)

- [ ] The 00 s11 exception (0.4) was approved and committed before work began; the decisions log has the line.
- [ ] `pnpm lint && pnpm typecheck && pnpm test` green; `0003_shot_set.sql` applied by `catalog-migrate`.
- [ ] SPEC.md and AGENTS.md carry the exact 0.5 text for the parts the owner approved, and nothing else changed.
- [ ] `catalog-matting` serves `/measure/embed`, `/measure/lpips`, `/measure/parse` with versions pinned in
      `MEASURE_MODEL_VERSIONS` and listed in `/health` (6.1).
- [ ] `catalog-harvest` deployed; a run against a site without a valid rights row exits 1 with the reason (9.1).
- [ ] Ops page shows the scorecard, channel policy table, gate state and exit button (10.2, 12.2); monitoring
      metrics and alerts applied by `infra/monitoring.sh` (12.2).
- [ ] Review card and swap card work end to end in the test run; "Use as is" on a made output returns 409 (7.2).
- [ ] Sheet shows "<Channel> shots" and "<Channel> missing" and links by position (8.4); the
      `CHANNEL_RULES_VERSION` re-render count is reported (8.1).
- [ ] Wizard step 3 and 4 copy as in 10.3; operator guide rewritten (12.3).
- [ ] `shotset --live` passes `roles.*`; only then is `SHOT_SET_MODE=act` set and printed by `deploy.sh`.
- [ ] Tier 2 scenarios pass; spec 10 `run` stays green apart from the expected re-render (counts reported).
- [ ] All-brand test run done, Vero Moda first, every made photo rated by two people, scorecards attached.
- [ ] No model id in any page, sheet, note or API response (banned-names test plus a grep of the run's files).
- [ ] Ledger rows for every generate and gate call; a batch cap stopped a call in tier 2; USD per accepted
      image reported per brand.
- [ ] Crop exit tested: 50 approved swaps set `crops` to `sampled`; a reset on a rejection; a rejected
      sampled crop sends the brand back (tier 1 G and tier 2); the Ops gate-state view shows both scopes.
- [ ] Exit numbers not yet met is not a failure: the report states the counts and that brands stay in review-all.

### 12.2 Monitoring and cost hooks

- Ops page: "Shot sets per brand" (10.2), the channel policy table (1.4), gate state per brand with the exit
  button (7.4); the new stages show in "Cost of one batch" (`batchCostByStage`, `cost-report.ts:52`).
- `infra/monitoring/` (applied by `infra/monitoring.sh`): log metrics `catalog/generate_failed`,
  `catalog/gate_unavailable`, `catalog/shotset_relapse`; alert on generate failures over 20% of calls per
  one-hour window and on every relapse. No alert on caps.

### 12.3 Operator guide (`docs/handover/catalog-for-the-operator.md`)

Replace "The tool never crops" with plain sections: shot types and "Change shot type"; how missing shots are
completed (cut from a bigger photo first, made only where the brand allows); the review card and why two
people answer; what each "Not made" sentence means and what to ask the brand; `cut_replaced` and
`role_added` mean "re-upload this product's images in the portal"; the limit for made photos.

## 13. Open design questions and contradictions this spec settles

Settled (focus/00 section 6 conflict or evidence digest section 9 item in brackets):
1. Third attempt [conflict 5]: attempt 2 stronger wording, attempt 3 the escalation model, at most 3 calls.
2. Own-photos rule versus mode B [conflict 4]: the mode B clause in A5.
3. Stale crop wording and the Styli floor [conflict 12, F01 C2 and C6]: A4 with the crop bar as policy.
4. Cropping and generation in one edit [conflict 13]: A1 to A4 and A5 to A8 are approved separately.
5. SPEC line drift [conflict 14]: non-goals are L855-861 and "Fit, never crop" L296 on `d82cc36`.
6. Request shape: `/images` through the shared `post`, not chat `message.images`; chat-only models out.
7. Reuse claims: no LPIPS endpoint or OCR exists on `main` (6.1); built here.
8. Undersized escalation output [digest 9.5]: G6 also holds a long side under 90% of the requested tier.
9. Upscaler dependency [digest 9.7]: every crop bar has a no-upscaler value; generated 2K shots on Styli
   carry `upscaled` like any photo.
10. Review blocking a product: made photos in review never hold brand photos (6.3).
11. Spec 13 Q8 interface requests, all adopted and defined here once (spec 13 consumes them): `GenKey.mode`
    widened to `GEN_MODES` and `attempt` to a number (1.1); `scope` on `catalog_gate_state` and `answers` on
    `catalog_review_labels` (1.3); optional `capUsd` on `checkGenerateCaps` (5.3); judge view `pair` (2.1);
    the `brand_rights` write route (1.6); `ls` last in the order (8.1); the `lsPending` clause of
    `madePending` and the scene cards in the review list (6.3, 7.1); the `BatchOptions.scene` slot (1.2).
    None changes spec 12 behaviour. The lock rule for `pending_review` is spec 12's (6.3: released at
    finalize, re-taken on decision, older candidates superseded); spec 13's "the lock stays" follows it.
12. Shared AI marker: the XMP helper and `ai_tag` / `ai_tag_missing` are defined here (5.2); spec 13's 6.4
    uses them with its composite source type instead of defining its own.
13. Remove and replace trigger (review A blocker; owner decision 2026-10-26): during review-all every
    retirement waits for a person's publish decision (swap card for crops, two raters for generated); after
    exit, passing crops retire automatically and generated shots follow the gate plus the 10% sample (3.3).
14. Held photos (review A blocker): only through the two-rater protocol; "Use as is" is refused (7.2).
15. Migration contract (review A blocker): an explicit 00 s11 exception the owner approves first (0.4).
16. Business-only items (focus/00 s6 conflicts 1, 3, 10, 11, 15; digest 9.2, 9.3, 9.4, 9.6): settled in the
    business case s12, not in this spec.

Open (defaults apply; none blocks the cropping half):
1. Styli on on-model fabric crops and upscaled 2K images (I5 Q4). Default: `fc` from flat lays; 2K.
2. Role lists for bottoms, maxi dresses, lingerie, swimwear, kids (DD0 items 1 to 7): reported only.
3. G3 for mode B against a flat-lit flat lay (I5 example 3, dE 7.68): `G3_FLAT_ALLOWANCE` from labels.
4. Accessories the reference model wears (I5 Q7): raters judge under Q5 until the owner rules.
5. Human-parsing model and licence record (6.1).
6. No apparel conversion holdout [digest 9.1]: the scorecard measures sets and eligibility, not lift.
7. Migration 0003 outside specs 02 and 03 (00 section 11): flagged in the PR body as a contract change.
8. Review capacity [digest 9.6]: bounded by per-batch caps and one batch per brand.
9. Settled (owner decision 2026-10-26): crops have their own per-brand exit (scope `crops`, 7.4): 50
   consecutive approved swaps with no rejection or reported cut, then automatic swaps with a 10% sample;
   any sampled rejection sends the brand's crops back to swap cards.
