# 13 Footwear and bag scene image

Catalog module, spec 13. Execute with `docs/specs/00-execution-protocol.md`. Source of truth: `docs/SPEC.md`.
Depends on 05 (render, matting, shadow), 06 (chunks, publish, sheet), 07 (judge, triage, decisions), 10 (eval job),
11 (upscaler, sharpening) and **12** (`docs/specs/12-apparel-shot-set.md`, the foundations in 0.3). Branch
`feat/catalog-13-footwear-scene-image`. Deploys `catalog-worker`, `catalog-web`, `catalog-matting` and
`catalog-matting-gpu` through `infra/deploy.sh`. Roadmap items 6.1b (US Polo), 6.1a (other brands) and 6.2
(composite) as one build. Design sources (`docs/plans/` of the `02-shot-set-and-scene` worktree): DD4
`deep-dives/04-footwear-bags-lifestyle.md`, DD8 `deep-dives/08-...`, DD2 `deep-dives/02-...`, DD1 `deep-dives/01-...`,
I06 `roadmap/initiatives/06-richer-footwear-pages.md`, F00, F03, F04 `roadmap/focus/0{0,3,4}-*.md`. Code pointers are
`path:line` on `main` at `d82cc36`; paths without a prefix are under `packages/core/src/catalog/`.

Status: draft for owner approval.

## 0. Scope, words, dependency on spec 12, SPEC amendments

### 0.1 Purpose and non-goals

Footwear and bag pages carry packshots only (US Polo 19 of 20 and Keds 7 of 7 sampled sets have no scene, I06). This
spec adds **one scene image per footwear or bag style-colour**, after every brand photo and never image 1, by one of
two routes: **full generation** (a worn legs-only or carried scene drawn from 3 to 4 brand packshots) or
**composite** (the brand's real cut-out pasted back by code into a generated still life, product pixels identical).
One 2K 3:4 frame per style-colour is cropped by code to each channel. Every image is gated, flagged `generated`,
tagged AI-generated in its file metadata and reviewed by a person until the exit of section 8 holds.

Non-goals: no generated person for kids, no face in any frame, no "four options" variant; no scene image as image 1
and no change to the brand photos' order, pixels or links; no route for a brand-supplied lifestyle photo (it keeps
today's hold, `matte-guard.ts:1030`; 12.3 Q6); no face recognition and no stored face or body embeddings; no
scene-around-product API (composite built in house, F04 s5); no infographics, holdout cells or revenue figures; no
new operator control (eligibility is automatic; one estimate sentence, 11.3).

### 0.2 Words

**Scene image (role `ls`, LS in copy):** the image made here (role from spec 12 `SHOT_ROLES`; "lifestyle image" in
DD4). **Packshot:** a brand source with role `flat`; its judge `view` (`qa/judge.ts:181`) names the side shown.
**Style-colour:** one design in one colour; here one `catalog_products` row (`schema.ts:287`). **Route:** `full` or
`composite`. **Frame:** the one 1792x2400 (3:4) picture per style-colour, stored as PNG in the private bucket.
**Crop window:** the part of the frame that becomes a channel's image (6.2). **Core box:** where the product must stay
so every window keeps it whole (5.4). **Paste-back:** writing the real cut-out over the generated scene (4.5).
**S1 to S4:** framing, modesty, scene safety, crop safety (section 5); **G1 to G6:** spec 12 s6's checks. **Style
profile:** the versioned, owner-approved `brand_style_profile` row (DD8 R2) holding the scene table.

### 0.3 What this spec takes from spec 12 (not re-specified here)

| Spec 12 | Taken as is | Added by spec 13 |
|---|---|---|
| s1 data model | `kind` (`generated`), `role`, `derivation` (`GenKey`, `GEN_MODES` incl. `ls_full` / `ls_composite`, `attempt` a number) on sources; made `n` from `MADE_N_BASE` = 101; `catalog_outputs.position`; `derivedPath` files; tables `brand_rights` with its admin `PUT` route, `brand_style_profile` (s1.6), `catalog_channel_policy` (s1.4), `catalog_review_labels` with `answers`, `catalog_gate_state` with `scope` (s1.3); flag `generated`; `model_policy.generate_*`; spend engine `catalog_generate`; ledger stage `generate` / `gate`, kinds `generate_call` / `measure_call` | `scene` jsonb on sources, `body.scene` of the style profile, `lifestyle_scope` on `brand_rights` (and in its route body), three channel policy columns, `route` on the ledger, product columns, flags, events, `scene_added` (section 1) |
| s2 roles | Role per source (null when not sure or not seen: "not checked"); judge `view` incl. `pair`; operator override | Footwear and bag presence answer (2.2) for "already present" (2.1) |
| s3, s8 planner and publish | Carry-forward re-insert (s3.5); `madePending` with its `lsPending` clause, `pending_review` with the lock released at finalize and re-taken on decision (s6.3); order by `position` with `ls` last (s8.1); links by position (s8.4) | LS needs no slot (one per product, not per role and channel); `scene.state` that `lsPending` reads (1.3, 7.4) |
| s5 generator client | `generateImage` (`/images`); generate and escalation models with `generate_approval`; `checkGenerateCaps` with optional `capUsd` before every attempt; ledger rows; mocks; LIVE_SMOKE for jobs | Two request shapes built from the profile (3.3, 4.4); the output-size rule (3.4); the scene cap value (3.6) |
| s6 fidelity gate | G1 to G4 bars, hold flags and `/measure/*`; "every check passes or hold"; attempts in `compliance.auto_actions` | Product locator for an LS frame (3.5); S1 to S4 and realism (section 5); the scene ladder (3.6); where G5 and G6 do not apply (5.6) |
| s7 review | Card, `use_as_is` / `remove`, two blind raters plus an adjudicating admin, alpha 0.67, exit bars, 10% sampling, relapse | LS card and questions, the 100-image LS exit, the composite share (section 8) |

If one of these contracts is not on `main`, spec 13 stops and reports it (00 section 11); it never builds its own copy.

### 0.4 SPEC.md amendments (this spec's PR; lines on `main` at `d82cc36`)

The brief cited non-goals at L852-858; on `d82cc36` the heading is L855 and the bullets L857-861. Spec 12's 0.5
rewrites L857-859 (A5), L861 (A4), L74-75 (A1), the L456 models row and the L397-398, L401 re-submit list first; the
edits below apply to the text spec 12 leaves.

0. Non-goal L857-859 as spec 12's A5 leaves it: "Two exceptions" becomes "Three exceptions", and after (b) add "(c)
   one lifestyle image per footwear or bag style-colour under spec 13 (outputs flagged `generated`): full generation
   from the brand's own packshots, or a still life into which the brand's own cut-out pixels are pasted back
   unchanged; gated by the spec 13 scene checks, and on the full route by the spec 12 checks G1 to G4."
1. Non-goals, L860. Replace "- No lifestyle-background option and no "four options" variant; only what the sheet
   specifies." with (DD4 R7 verbatim, spec number filled in):
   > - No lifestyle-background option except one lifestyle image (role LS) per footwear or bag style-colour under
   > spec 13: made only when none of the brand's photos of that style-colour is a lifestyle, worn or carried photo;
   > only by a generator the owner has approved in writing; worn or carried scenes only for adults, with no face and
   > the modesty and scene rules of the brand's style profile; a still life of the brand's own cut-out pixels for
   > kids and for products with too few photos; always gated by the spec 12 checks plus the scene checks; flagged
   > `generated`; placed after every brand photo and never as image 1; held for a person until the spec 13 exit
   > numbers are met and recorded here. No "four options" variant.
2. Cropping bullet (L861 as spec 12's A4 leaves it): append "A generated lifestyle frame is cropped to each
   channel's aspect around the product, which stays whole; this is the only crop of a generated frame." and replace
   "no cap on images per product or per channel" with "image caps per channel are data in the channel policy table
   (`max_images`, spec 13); at a cap only the scene image yields".
3. L75: replace "No cap on images per product or per channel; the input decides." with "Image caps per channel are
   data (`max_images` in the channel policy table, spec 13); brand photos are never dropped for a cap; only the
   scene image yields."
4. Models table, after spec 12's "Generated on-model shots (spec 12)" row, new row (DD4 R7 verbatim, split across the
   columns): `| Lifestyle image (spec 13) | the generator of spec 12 (owner-approved), conditioned on the brand's
   packshots; composite fallback uses the module's own matte and contact shadow | catalog-worker | cost per accepted
   image recorded in the cost ledger |`
5. L397-398 and L401 as spec 12 leaves them: the re-submit list becomes "`updated`, `shots_removed`, `reordered`,
   `role_added`, `cut_replaced` or `scene_added`" and the `change` enum gains `scene_added`.
6. L805 (Data model heading): add "and the spec 12 and spec 13 migrations" to the specs that ship migrations.
7. Decisions log (after L54): "Spec 13 (owner, 2026-10-26): one scene image per footwear and bag style-colour; studio
   on-legs photos count as present; kids, bags under 3 views, embellished or transparent products get the composite
   only; women's covered legs may be framed above the knee; every generated image carries the IPTC digital-source-type
   tag; `CHANNEL_RULES_VERSION` bumped for caps and the full-frame mode."
8. `CHANNEL_RULES_VERSION` (`channels.ts:216`, `"10"` at `d82cc36`; spec 12 s8.1 makes it `"11"`): bump by one from
   what `main` holds at execution.

### 0.5 Workstreams and build order

| Workstream | Worktree suffix | Files owned | Depends on |
|---|---|---|---|
| A data and policy | `-a-data` | migration, `schema.ts`, `types.ts`, `scene/profile.ts`, `scene/roles.ts`, channel policy seed, `lifestyle_scope` in the rights route | spec 12 merged |
| B eligibility and routes | `-b-routes` | `scene/eligibility.ts`, `scene/full.ts`, `scene/composite.ts`, `scene/prompts.ts`, `qa/classify.ts`, `apps/worker/src/catalog/scene-stage.ts`, chunk dispatch | A |
| C checks | `-c-checks` | `scene/checks.ts`, `scene/locate.ts`, `services/matting` `/measure/people` | A (B fakes C's contract) |
| D render and publish | `-d-render` | `render.ts`, `compliance.ts`, `scene/metadata.ts`, `pipeline/publish.ts`, `pipeline/report.ts`, `sheet.ts`, `qa/triage.ts` | A |
| E evals and ops | `-e-evals` | `evals/scene.ts`, golden `scene` set, `catalog-output-evals.ts`, Ops block, handover notes | B, C, D |

Before using sharp's XMP output, the detectors, onnxruntime or OpenRouter's image-edit request, the builder fetches
current docs through Context7 (00 section 4).

## 1. Data model additions

One additive migration after spec 12's `0003_shot_set.sql` (`drizzle/0004_scene.sql`, drizzle-kit from `schema.ts`).

### 1.1 `brand_style_profile.body.scene` (table from spec 12 s1.6)

Spec 12 creates the table (versioned, zod `body`, at most one `approved` row per brand, never edited). Spec 13 adds the
optional `body.scene` key; a profile without it is treated as `scene.enabled = false`. An apparel-only profile and a
scene profile may be the same row; a change to either is a new version.

```ts
// packages/core/src/catalog/scene/profile.ts
export const SUBCATEGORIES = ["sneaker","running_sports","loafer_slip_on","football","boot","lace_up_comfort",
  "sandal","slide_flip_flop","slipper","handbag","shoulder","clutch"] as const;            // DD4 F1
export const FRAMINGS = ["legs_only","feet_only","shoulder_to_hip","waist_held"] as const;
export const SceneEntry = z.object({ worn: z.string().min(1).nullable(), framing: z.enum(FRAMINGS),
  stillLife: z.string().min(1), styling: z.object({ men: z.string(), women: z.string() }), bareFeet: z.boolean() });
export const SceneProfile = z.object({
  enabled: z.boolean(), routes: z.object({ full: z.boolean(), composite: z.boolean() }),
  unisexStyling: z.enum(["men","women"]), aboveKneeWhenCovered: z.boolean(),
  subcategories: z.record(z.enum(SUBCATEGORIES), SceneEntry), forbidden: z.array(z.string()).min(1),
  modesty: z.object({ womenLegs: z.literal("ankle"), menKnees: z.literal("covered_except_pool_beach"),
    bagArms: z.literal("long_sleeve"), noFace: z.literal(true) }) });
export const DEFAULT_SCENE_PROFILE: z.infer<typeof SceneProfile>;   // DD4 F4, enabled: false
```

`DEFAULT_SCENE_PROFILE` transcribes DD4 F4 row by row: sneaker (worn: legs only, seated on a concrete ledge or walking
in a modern plaza, late afternoon; still life: the pair on a concrete ledge or steps), running (waterfront path at
sunrise / track edge), loafer and lace-up comfort (cafe terrace or marble lobby / light stone paving), football
(floodlit artificial pitch / turf), boot (desert-toned stone steps / stone), sandal and slide (`feet_only`, `bareFeet`,
pool deck or boardwalk / wooden decking), slipper (bedroom rug / rug), handbag and shoulder (`shoulder_to_hip`, hotel
lobby or cafe / marble side table), clutch (`waist_held`, evening lobby / marble console), with DD4 F4's styling
column. `forbidden`: readable text or signs, other brands or logos, real landmarks or recognisable skylines, alcohol,
religious buildings, flags, faces. `aboveKneeWhenCovered: true` (owner decision). A brand gets a draft from the
default and is used only once approved (1.6).

### 1.2 Rights scope (on spec 12's `brand_rights`)

`lifestyle_scope text not null default 'none'`: `none | still_life | worn_or_carried`. Full route needs
`worn_or_carried`; composite needs either. A row counts only when today is within `[valid_from, valid_to]`. Checked at
plan time (2.1) and in `planPublish` (7.4). The row's `sites` does not apply to LS: it lists the brand websites spec 12
may harvest model references from, and LS uses no harvested reference, only the product's own delivered photos. The
grant covers every marketplace the module publishes to; a grant limited to some marketplaces is recorded as `none`
until a per-channel scope is needed (12.3 Q9).

### 1.3 Products, generated sources, outputs

- `catalog_products`: `subcategory text null` (a `SUBCATEGORIES` key or `unknown`), `subcategory_source ('judge'|
  'operator')`, `audience ('men'|'women'|'unisex'|'kids'|'unknown')`, `scene_traits jsonb` (`{ embellished,
  transparent, judgedAt }`).
- Generated LS source: spec 12 `kind = 'generated'`, `role = 'ls'`, `role_by = 'planner'`, `head = 'na'`, `n` per
  7.1, `raw_uri` = the frame PNG. `referenceShas` are the packshots used,
  `styleProfileId` / `Version` the profile. `derivation` is spec 12's `GenKey` (`mode` `ls_full` or `ls_composite`,
  `attempt` 1 to 5 = the 3.6 rung). New column `catalog_source_images.scene jsonb null` (`schema.ts:374`):
  `{ state, route, subcategory, audience, rightsId, productBox, attempts: [{ k, route, slot:
  'default'|'escalation', ms, usd, outcome, failed }], checks, skipped, reusedFrom }`. `state` is the LS life cycle
  that replaces spec 12's slot for LS: `checking` (made, checks running), `in_review` (checks passed, waiting for
  raters), `held` (ladder failed), `ready` (approved or passed after exit), `live`, `removed`. Engine ids live only in
  `derivation` and the ledger.
- Private files through spec 12's `derivedPath(prefix, pathKey, n, <suffix>)` (`naming.ts:133`): `scene` (accepted
  frame), `scene-a<k>` (every attempt), `scene-canvas` (composite input).
- LS outputs carry the route in `compliance.scene` and their order in spec 12's `position`; no new output column.
  Once the checks run, the scene stage writes `qa_scores = { kind: "scene", route, verdict, checks }` on each LS
  output (the scene checks stand in for the output judge, which LS skips), so no LS output is ever "unjudged" in the
  sense of `pipeline/publish.ts:107`.
- LS answers go in spec 12's `catalog_review_labels.answers` (keyed by the 8.2 question names; `q1` to `q6` null).
  LS exit state uses spec 12's `catalog_gate_state` rows with `scope` `scene_full` and `scene_composite` and
  `brand_slug = '*'`, because the LS exit (8.2) is program-wide.
- `catalog_batches.options.scene` (`{ capUsd: number; sample?: number }`, the slot spec 12 s1.2 reserves), written once by
  the first scene chunk (3.6) or at batch start for test runs (9.2); never in `counts`, which progress code
  rebuilds.

### 1.4 Role render data (the full-frame mode is data on the role, not a channel)

```ts
// packages/core/src/catalog/scene/roles.ts
export interface RoleRender { mode: "cutout" | "full_frame"; skipCompliance: readonly ComplianceCode[];
  matte: boolean; outputJudge: boolean; busyBackgroundExempt: boolean }
export const ROLE_RENDER: Partial<Record<ShotRole, RoleRender>> = { ls: { mode: "full_frame",
  skipCompliance: ["background","inside_safe_box","styli_anchor","noon_wide"], matte: false, outputJudge: false,
  busyBackgroundExempt: true } };
export const renderFor = (role: ShotRole | null): RoleRender;  // other roles: cutout, [], true, true, false
```

### 1.5 Channels, enums, ledger

- `catalog_channel_policy` (spec 12 s1.4, owner-changeable through its admin `PUT` route) gains `max_images int null`
  (seeded Trendyol 8, Amazon 9, Shein 10, VogaCloset 10, others null), `lifestyle text` (`published`, `assumed`,
  `off`; seeded Noon and Amazon `published`, DD4 F5, others `assumed`) and `scene_replaces_chart_at_cap boolean
  default false` (the owner flag of 7.3). `ensureChannelPolicies` fills these only where they are null, never
  overwriting an owner's value. `ChannelSpec` (`channels.ts:20`) is unchanged.
- `OUTPUT_FLAGS` (`types.ts:14`) add the holds `scene_framing`, `scene_modesty`, `scene_safety`, `scene_crop`,
  `scene_realism`, `paste_back_mismatch`, `ai_tag_missing`. `CHANGE_KINDS` (`types.ts:10`) add `scene_added`;
  `EVENT_KINDS` (`types.ts:28`) add `scene_added`, `scene_retired`.
- `CHUNK_STAGES` (`schema.ts:60`) adds `scene`. Ledger rows use existing stages: `classify` (`schema.ts:67`) for the
  2.2 call, spec 12's `generate` (kind `generate_call`) for generator calls and `gate` (kinds `llm_call`,
  `measure_call`) for checks. `catalog_cost_events` (`schema.ts:582`) adds `route text null` checked
  `('full','composite')`, set on every row the scene stage writes.
- `ComplianceCode` (`compliance.ts:80`) adds `scene_crop` and `ai_tag` (6.3, 6.4).
- `OUTPUT_FLAGS` also uses spec 12's `gate_unavailable` for a scene check that cannot run (section 5).

### 1.6 Writing profiles and rights

The scene part of a profile is edited and approved on spec 12's admin page (`/catalog/brands/[slug]/models`, s9.2),
which gains a "Scene images" section: "Start from the default" (copies `DEFAULT_SCENE_PROFILE` into a draft), the
fields, zod validation, "Approve" (new version, `approved_by` recorded). Rights rows are written through spec 12's
admin-only `PUT /api/catalog/brand-rights/[id]` (s1.6); spec 13 adds `lifestyle_scope` to its body and validation.

## 2. Eligibility and the ladder

### 2.1 Checks per product (first match stops; a stop is a note, never a hold)

`eligibility()` in `scene/eligibility.ts`. The rule order is code; every threshold and switch it reads is data (the
style profile, the channel policy, `model_policy`, `brand_rights`). The sentence goes to the product's sheet `notes`
and to `scene.skipped`. The full gate set for any scene generator call is: `SCENE_ENABLED=1`, rule 2's policy fields,
rule 3's rights row, and the caps of 3.6. Spec 12's shot-set switches (`options.shotSet.generate`,
`SHOT_SET_MODE`) do not apply to LS; the owner decided eligibility is automatic (0.1).

| # | Rule | Result and note |
|---|---|---|
| 1 | `SCENE_ENABLED` env not `1`, or product type not `footwear` / `bag_accessory` | no step, no note |
| 2 | No approved profile, `scene.enabled` false, or the brand and category's `model_policy` lacks `generate_enabled = true`, `generate_model` or `generate_approval` (spec 12 s1.5) | "No scene image: scene images are switched off for this brand." |
| 3 | No valid `brand_rights` row with `lifestyle_scope` other than `none` | "No scene image: the brand's written permission for generated images is not on record." |
| 4 | Any current brand source has role null (not sure or not checked, spec 12 s2.1) or presence `unknown` (2.2) | "No scene image: the shot types of this product's photos were not all checked." |
| 5 | Already present: a current brand source with role `ls`, or whose 2.2 `presence` is `worn`, `carried` or `scene` | "No scene image needed: the brand's photos already show it worn or in a scene." Retires a live LS (7.6) |
| 6 | `subcategory` null or `unknown` | "No scene image: the type of shoe or bag is not known yet." |
| 7 | No usable packshot (role `flat`, not held, no `small_source`, long side 500 px or more, `channels.ts:214`) | "No scene image: the product photos are too small or held." |
| 8 | Every ticked channel has `max_images` and is full with brand images (7.2), and none can swap (7.3) | "No scene image: every marketplace in this batch already has its maximum number of photos." |
| 9 | Route choice (2.3) | full or composite |

Rule 5 applies the owner decision that studio on-legs and studio carried photos count as present (DD4 Q2): they are
`worn` or `carried` in 2.2. A styled studio still life with props and no person is `still_life_props` and does not
count (12.3 Q1). Spec 12's apparel role bands are not used for shoes and bags. Rule 8 is re-checked in every later
batch.

### 2.2 Subcategory, audience, traits

`classifySubcategory` in `qa/classify.ts`: one judge call per product with every current brand photo (`qaImage`
size, labelled by `n`), the closed `SUBCATEGORIES` list of its department and four questions: the subcategory; who
it is made for (men, women, unisex, kids); is it embellished (crystals, sequins, beads), transparent or mirror-like;
and per photo `presence`: `worn` (on a foot or leg, any background), `carried` (held or on a body), `scene` (in a
real setting), `still_life_props` (styled studio set, no person), `packshot`, `other`. Presence is stored per photo
in `scene_traits.presence` (`{ <sha256>: value }`); golden expectations
cover a studio on-legs photo (`worn`) and a Campus styled set (`still_life_props`). Model from `resolvePolicy`
(`qa/policy.ts:41`); ledger `llm_call`, stage `classify`, spend engine `catalog_qa`. Below confidence 0.7 the second
judge model is asked once; still below, the answer is `unknown` (a photo's presence `unknown` stops at rule 4 with
its sentence). Code overrides towards safety, with the inventory's measured kids rule (proposal
`2026-10-26-apparel-shot-set/01-inventory-count.md` L41) exactly: gender `Kids`, `BOY` or `GIRL`, or the name or
option id matching, as a whole word, `JR`, `PS`, `INF`, `INFANT`, `KID`, `KIDS`, `BOY`, `BOYS`, `GIRL`, `GIRLS`,
`YOUTH`, or containing `-K-`, sets `audience = 'kids'`. It reads the identifier, and the gender and name when the
delivery carries them. `unknown` audience is treated as kids. Stored once per product; re-asked only when the product's source shas change;
an operator value (`subcategory_source = 'operator'`, through the admin path) always wins.

### 2.3 Route choice

- **Composite only** when: `audience` is `kids` or `unknown`; a bag with fewer than 3 distinct usable packshot views
  (front, side, back, top, `pair`; `detail`, `sole`, `inside` do not count); `embellished` or `transparent`, or a
  source flagged `transparent`; the entry's `worn` is null; `routes.full` false; or `lifestyle_scope = 'still_life'`.
- **Full first**, composite as fallback (3.6), otherwise.
- If only the composite is possible and `routes.composite` is false: "No scene image: this product can only get a
  still-life scene and those are switched off for this brand."

### 2.4 Carry-forward

Spec 12 s3.5's re-insert, for LS: a later batch for the product carries the current LS source in as a source row of
the new batch (same `n`, `sha256`, `raw_uri`, `kind`, `derivation`, `scene`) when rules 2 to 5 still pass, every
`referenceShas` entry is still a current brand source, and the profile version and rights row are still approved
and valid. The review decision carries with it. No generator call; an unchanged `render_key` keeps the
live outputs (`pipeline/publish.ts:67`). Otherwise the ladder runs again or the LS is retired (7.6). The row must exist in every
batch that touches the product: `planPublish` deletes live outputs whose `n` has no source in the batch
(`pipeline/publish.ts:63`) and `publishProduct` marks absent sources not current (`pipeline/publish.ts:170`).

## 3. Full generation route

### 3.1 Where it runs

New chunk stage `scene`, one chunk per eligible product, so the up to five generator calls of one product fit one
task deadline (`packages/core/src/tasks.ts:79`). The QA stage creates it after triage
(`apps/worker/src/catalog/qa-stage.ts:204`) once every brand source has a role; writes run under the chunk lease
(`underClaim`, `apps/worker/src/catalog/chunk.ts:48`). Ordering with the publish: a finished chunk enqueues the
publish of each of its products (`finish`, `apps/worker/src/catalog/chunk.ts:340`); for a product with a queued or
running `scene` chunk, `finish` of the QA chunk skips that enqueue, and the scene chunk's own `finish` enqueues it,
so the product publishes once with its LS row present. The batch's "all chunks done" test (`chunk.ts:342`) counts
scene chunks like any chunk. The stage writes the LS source (`scene.state = checking`), renders its outputs (section
6), runs the checks (section 5), writes `qa_scores` (1.3), then sets `in_review` with outputs `needs_attention`
(review-all), `ready` with outputs `staged` (after exit, 8.3), or `held`.

### 3.2 References

3 or 4 usable packshots, one per judge view in the order `side`, `pair`, `top`, `back` (heel), `front`. Excluded:
role `chart` (`qa/judge.ts:183`), photos flagged `text_or_watermark`, held photos, `small_source`. Sent as sRGB JPEG,
long side 1536 px, labelled by position and view. Footwear with fewer than 3 still runs full (DD4 F6 kept 6 of 6
shoes with 3 to 4); bags below 3 views went composite (2.3).

### 3.3 Prompt contract (`scene/prompts.ts`, compiled by code; hash in `derivation.promptHash`)

Fixed sentences in this order, never free text from a model:
1. Labels: "Images 1 to N are product photos of the same <item>: image 1 side view, ..."
2. Task: "Make one photorealistic photograph, portrait 3:4, of this exact product <worn | carried> in this scene:
   <entry.worn>."
3. Styling `entry.styling.men|women` (unisex: `unisexStyling`) and "No face, no head." Framing: `legs_only` "The frame
   starts at the knee or below."; `feet_only` "The frame starts at mid-calf."; `shoulder_to_hip` "The frame runs from
   the shoulder to the hip."; `waist_held` "The frame shows the hands and the bag at the waist." Women with
   `aboveKneeWhenCovered`: "The frame may start at mid-thigh only if the legs are covered to the ankle."
4. Truth (DD4 F6): "Keep the product exactly as in the photos: shape, proportions, colours, materials. Do not add,
   remove, move, mirror or restyle any logo, label, print or text."
5. "Show the whole product, both shoes when worn, in the middle of the picture, not touching any edge."
6. "The scene has none of: <forbidden>." Bare feet only when `entry.bareFeet`.
7. Rung 2 only: one corrective sentence per failed check (S1: "Start the frame at the knee or below.").

### 3.4 Request and output size

Spec 12 s5's `generateImage`, `resolution` 2K, `aspect_ratio` 3:4, references as `input_references`, the rung's
model (`generate_model` or `generate_model_escalation`, refused without `generate_approval`), `session_id`
`<batchId>:<productId>`. Output must be 3:4 within 0.5% and
at least 1792x2400 (larger is resized to 1792x2400 with Lanczos3); smaller fails the attempt as `undersize` (no checks,
cost recorded). Every attempt is stored (1.3) with a ledger row: stage `generate`, kind `generate_call`, spend engine
`catalog_generate`, `route = 'full'`, `attempt = k`, spec 12 s5's outcome.

### 3.5 Product locator (`scene/locate.ts`)

`locateProduct(frame, department)`: one judge call returns a box per visible product instance (each shoe, or the bag);
each box padded 10% is matted with the policy's model through `matteFor` (as `apps/worker/src/catalog/chunk.ts:187`),
footwear with sole-strip recovery (`matte-guard.ts:877`); the union of masks is the product mask and its box is
`productBox`. No box, or a mask under 2% of the frame, fails with `scene_crop`. The mask and every reference with its
view go to spec 12 s6 as the G1 to G4 region; s6 picks the comparison view.

### 3.6 Retry and escalation ladder

| Rung | Engine | When |
|---|---|---|
| 1 | generate slot | always |
| 2 | generate slot, corrective sentences | rung 1 failed a check |
| 3 | escalation slot | rung 2 failed and the slot is set |
| 4 | composite attempt 1 (section 4) | rungs 1 to 3 failed and the composite is allowed |
| 5 | composite attempt 2, corrective sentence | rung 4 failed S2, S3 or realism |
| - | hold (5.7) | rung 5 failed |

At most 5 calls per product (2 x 0.1032 + the escalation price + 2 x 0.1015 USD); with the escalation slot empty,
4 calls, about 0.41 USD. The scene cap is 0.55 USD per eligible product: it covers the 4-call ladder with the slot
empty and a 5-call ladder while the escalation engine costs at most 0.14 USD a call (12.4 item 1). Before every
attempt the stage calls spec 12's `checkGenerateCaps` with `capUsd` = the lower of the batch's
`shotSet.generateCapUsd` (when set) and the scene cap (eligible products in the batch x 0.55 USD, computed once at
the first scene chunk and stored in `options.scene.capUsd`, 1.3). Spend is shared with spec 12 under `catalog_generate`. A `cap` refusal stops the ladder with "No scene image: this batch reached its spending limit
for scene images." (no hold); `rate_limited` is retried by spec 12 s5 and uses no rung. The escalation slot ships empty
and is set only after the 10.3 probe shows its engine returns at least 1792x2400 on 3 of 3 requests (12.2, item 5).

## 4. Composite route

### 4.1 Source and matte

One packshot by view: `pair`, else `side`, else `front`. Its matte is the one the matte stage saved (`matte_uri`, written at
`derivedPath(..., "matte")`, `apps/worker/src/catalog/chunk.ts:169`, `naming.ts:133`) through `resolveMatte` with sole-strip recovery for footwear (`apps/worker/src/catalog/chunk.ts:202`,
`matte-guard.ts:994`). A `fallback_matte`, `passthrough`, busy-background (`matte-guard.ts:1021,1030`) or
`cut_in_source` result ends the route in the 5.7 hold ("the cut-out is not clean enough for a scene").

### 4.2 Placement

Canvas 1792x2400, `#E0E0E0`. The cut-out (source pixels with the saved alpha) is scaled to fill 0.8 of the core box
(5.4) on its binding side, never above `MAX_UPSCALE` 1.5 (`channels.ts:211`; the product is smaller instead). Its long
side must reach 600 px, else the 5.7 hold ("photo too small for a scene"). Centred horizontally in the core; bottom edge
at y = 1920, moved up only if the top would leave the core. The module's contact shadow is drawn as today: `shadowLayer`
(`shadow.ts:149`, synthesis allowed for footwear and bags, `qa/policy.ts:55`) multiplied on the canvas, then the
cut-out "over" (`render.ts:639`). That composition becomes `composeOnCanvas({ background, shadowLayer, cutout, at })`
in `render.ts`; the plain render keeps calling it with a colour (byte-identical, 10.1). The placed alpha and `at` are
kept for 4.5.

### 4.3 and 4.4 Background request and prompt

One request through spec 12 s5's `generateImage` with the canvas PNG as the only `input_references` entry. Fixed sentences: "Image 1 is a product
photo on a plain grey background. Replace only the grey background with this scene: <entry.stillLife>. Keep the
product exactly where it is, at the same size, and keep the soft shadow under it, adapting it to the surface. Do not
add any person, hand or other product. The scene has none of: <forbidden>." The output must be 3:4 within 0.5% and at
least 1344x1800 (only its background is used) and is resized to 1792x2400. Ledger as 3.4 with `route = 'composite'`.

### 4.5 Paste-back and pixel equality

1. `final = composeOnCanvas({ background: generated, shadowLayer: null, cutout, at })`: the real cut-out "over" the
   generated frame at the same offset; the generator's product pixels are discarded (it changed 10% to 60% of them,
   DD4 F6).
2. `pasteBackEqual(final, cutout, at)`: every pixel whose placed alpha is 255 has RGB exactly equal to the cut-out
   (difference 0); pixels with alpha 1 to 254 are blends and are not compared. Measured on raw buffers before any
   encode; the accepted frame is stored as PNG.
3. Any difference: `paste_back_mismatch`, a code fault, no retry, "Use as is" not offered (8.2).

Checks: S2, S3, S4 (exact from the placed alpha, no locator) and realism (5.5); S1's face part only. G1 to G4 are
skipped by construction (5.6).

## 5. Scene checks, realism, per-route table, hold flags

All on the 1792x2400 frame; every check gates. Results go to `scene.checks` and each LS output's `compliance.scene`
(numbers and words, never model ids). A check that cannot run (`/measure/people` down after 3 retries, a judge call
unavailable or capped) is spec 12's `gate_unavailable`: a hold, never a pass, and it uses no ladder rung.

### 5.1 S1 framing (code, plus a judge voice)

`POST /measure/people` on the matting service (CPU and GPU targets): multipart `file`; returns `{ faces: [{ box, score
}], keypoints: [{ name, x, y, score }] }` with the 17 COCO body keypoints per person; 400 `{ error }` on a bad image.
Detection only: no embeddings, no crops returned, nothing written to disk, no image bytes logged. Weights must carry a
commercial-use licence, a deliberate choice stricter than SPEC L44-47 because these run on every published scene
image (candidates: YuNet face detector, MIT; RTMPose or MoveNet keypoints, Apache-2.0); the builder
confirms licence and docs through Context7, bakes ONNX exports into both images as spec 11 did and pins
`PEOPLE_MODEL_VERSIONS` (first 8 hex of each sha256). S1 fails (`scene_framing`) when:
- a face scores 0.5 or more, or a `nose`, eye or ear keypoint scores 0.3 or more (every framing, both routes);
- `legs_only`: a hip, shoulder or wrist keypoint scores 0.3 or more inside the frame. Knee position is not measured,
  so seated poses (knees mid-frame, thighs towards the camera) stay in the profile; how much thigh shows is S2's
  question, with the `aboveKneeWhenCovered` exception applied there;
- `feet_only`: any knee keypoint scores 0.3 or more;
- `shoulder_to_hip`: fewer than two shoulder keypoints score 0.3 or more, or either lies less than 3% of the frame
  height below the top edge (the frame must start at the shoulders, not cut through them; the head is excluded by
  the face rule above);
- `waist_held`: any shoulder keypoint scores 0.3 or more (the frame starts below the shoulders).
The judge question "Is any part of a human face, chin or neck visible?" runs too; yes fails S1. Seated poses are
part of the golden set (10.3).

### 5.2 S2 modesty and 5.3 S3 scene safety (judge)

S2 asks yes or no with evidence: women's legs covered to the ankle; men's knees covered (except `sandal` and
`slide_flip_flop` pool or beach scenes, where the frame stops below the knee); long sleeves on any visible arm in bag
scenes; bare feet only when `bareFeet`; no underwear, swimwear or see-through clothing. S3 asks item by item "Does the
scene contain any of: <forbidden>?" and "Is there readable text, a logo or a brand name other than on the product?"
(text on the product is G2's). A failed answer holds (`scene_modesty`, `scene_safety`); a pass below confidence 0.7 is
asked of the second judge model and both must pass.

### 5.4 S4 crop safety (code)

`SCENE_CORE = { x: 112, y: 394, w: 1568, h: 1612 }`: the narrowest window (Trendyol 1600x2400) less 16 px each side
gives x 112 to 1680; the 1:1 window (1792x1792, y 304 to 2096) inset 5% of 1792 (90 px) gives y 394 to 2006. S4 passes
when `productBox` lies inside it, else `scene_crop`. With windows centred on the product and clamped (6.2), a product
in the core sits inside every window with at least 16 px clearance (tested over a grid, 10.1).

### 5.5 Realism (judge)

"Does the product sit naturally in the scene: plausible size, touching the surface, shadow under it, light consistent?"
Gates the composite (`scene_realism`); recorded only on the full route.

### 5.6 What applies per route (settles F04 Q4)

| Check | Full | Composite | Why |
|---|---|---|---|
| G1 to G4 (spec 12 s6) | yes, on the 3.5 mask | no | composite pixels proved identical by 4.5 |
| G5 model and scene consistency | no | no | written for the five on-model shots of one apparel product; an LS is one image with no person to match |
| G6 crop geometry | no | no | no head is allowed; S1 and S4 replace it |
| Paste-back equality | no | yes | |
| S1 | yes | face part | |
| S2, S3, S4, `ai_tag` (6.4) | yes | yes | |
| Realism | recorded | gates | |

### 5.7 Holds

A failed ladder leaves the LS outputs `needs_attention`, built from the attempt with the fewest failed checks
(composite on a tie), with every failed flag. Card sentences: `scene_framing` "The scene image shows more than the
shoes and lower legs, or part of a face."; `scene_modesty` "The clothing in the scene image does not meet the modesty
rules."; `scene_safety` "The scene image shows text, another brand, a landmark or another item that is not allowed.";
`scene_crop` "The product is too close to the edge; some marketplace crops would cut it."; `scene_realism` "The
product does not sit naturally in the scene (size, shadow or light)."; `paste_back_mismatch` "The product pixels in
the scene image differ from the brand's photo. Our fault; this image cannot be used."; `ai_tag_missing` "The image
file is missing its AI-generated label. Our fault; this image cannot be used." G1 to G4 sentences are spec 12's. A held
LS never holds the brand photos (7.4).

## 6. Full-frame render mode, crops, compliance, metadata

### 6.1 `renderFullFrame` (`render.ts`)

`renderSource` (`render.ts:545`) calls it when `renderFor(role).mode === "full_frame"`; the cut-out path from
`render.ts:568` is not entered, so LS uses no matte, `shotGeometry` (`render.ts:210`), `planCanvas` (`render.ts:466`),
shadow or canvas colour (`backgroundFor`, `channels.ts:197`). Input: frame RGB, `productBox`, channel. Output: the same
`RenderOutput`, with `plan` describing the window, flags `generated` (and `upscaled` when used) and compliance (6.3).

### 6.2 Crop windows

`cropWindow(productBox, channel)`: `a = targetCanvas.w / targetCanvas.h`. If `a <= 1792/2400` the window is full height
(`h = 2400`, `w = round(2400 a)`), else full width (`w = 1792`, `h = round(1792 / a)`); centred on the centre of
`productBox`, clamped inside the frame. With the channel table (`channels.ts:54-180`):

| Channel | Window | Output | Scale |
|---|---|---|---|
| Noon, Namshi | 1751x2400 | 1080x1480 | 0.62 |
| Trendyol | 1600x2400 | 1200x1800 | 0.75 |
| Styli | 1792x2390 | 2342x3123 | 1.31 |
| 6thStreet, VogaCloset | 1792x2390 | 2000x2667 | 1.12 |
| Amazon, Shein | 1792x1792 | 2000x2000 | 1.12 |
| Centrepoint | 1792x1792 | 3000x3000 | 1.67 (spec 11 x2 upscaler) |

Every LS output is the target canvas, so `dims` holds (`compliance.ts:97`). Resize with Lanczos3 plus spec 11's
sharpening above scale 1; past `UPSCALE_MIN_SCALE` the spec 11 upscaler runs once on the whole frame, shared by every
channel. Encode as `render.ts:645` (quality 90 down to 70, channel DPI, sRGB ICC, 4:4:4, at most 2,000,000 bytes)
plus 6.4. A window without `productBox` and 16 px clearance fails `scene_crop`.

### 6.3 Compliance exceptions (`compliance.ts`)

`checkOutput` (`compliance.ts:85`) gains `skip?: readonly ComplianceCode[]` and `scene?: { window, productBox }`. For LS
it skips `background`, `inside_safe_box` (`compliance.ts:126-127`), `styli_anchor` (`:142`) and `noon_wide` (`:144`):
all four compare pixels with a flat canvas colour or the cut-out safe box, which a full frame does not have. It keeps
`magic`, `bytes`, `trendyol_name`, `extension`, `format`, `dims`, `density` and adds `scene_crop` and `ai_tag`. Other
roles are unchanged (10.1 asserts identical failure lists).

### 6.4 AI-generated metadata tag

Every LS JPEG carries an XMP packet from the encoder (sharp's XMP output for `^0.35.5`, confirmed through Context7):
`Iptc4xmpExt:DigitalSourceType` = `http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia` (full) or
`http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia` (composite), `dc:description`
"AI-generated scene image", and `dc:subject` from `SCENE_XMP_KEYWORDS` (empty by default; Amazon's
`contains-synthetic-performer` only on an owner yes, 12.3 Q4). `ai_tag` reads `sharp(jpeg).metadata().xmp`, parses the
packet and fails unless the source type matches the route (`ai_tag_missing`, held, never published). No IPTC-IIM
block. Marketplaces may strip metadata; this spec does not control that.

### 6.5 The `leftover_background` exception

The flag reaches a hold two ways: the matte stage's busy-background result (`matte-guard.ts:1021,1030`, held through
`RENDER_HOLD_FLAGS`, `qa/triage.ts:23`, and `qa/triage.ts:78` with `busyBackgroundHold`, `auto-resolve.ts:193`) and the
output judge. LS sources skip the matte stage (`matte: false`) and LS outputs skip the output judge (`outputJudge:
false`; `runQaStage`, `apps/worker/src/catalog/qa-stage.ts:116`, filters them). As a guard, `triageProduct` (`qa/triage.ts:58`) strips
`leftover_background` from any output whose role is `busyBackgroundExempt` and logs `scene_flag_stripped`; a unit
test proves the flag never holds LS.

## 7. Placement, caps, publish, re-submission, sheet

### 7.1 Placement last

LS `n` is the next free made number from spec 12's `MADE_N_BASE` (101), kept for life, so its public path never
collides with a brand shot. Its `position` on every channel is last: spec 12 s8.1's order gains the rule "role `ls`
comes after every other source", so it is never image 1 (a product with no usable brand photo has no LS, rule 7). On
a channel where no brand photo of the product is published or kept live, the LS output is `skipped`: "Not added: a
scene image is never the first image, and no product photo is on this marketplace yet." When the brand adds a photo,
the next batch only changes positions (2.4); LS keeps its `n` and link.

### 7.2 Caps

At publish, per ticked channel with `max_images`: `count` = brand outputs that will be live there (copies plus kept,
`pipeline/publish.ts:55-67`, less deletes). LS is sent when `count + 1 <= max_images`. A channel whose `lifestyle` is
`off` never gets LS: `skipped`, "Not added: this marketplace does not take scene images."

### 7.3 At a cap: the size-chart swap

Charts are left out of the module's outputs today (`chart_image` in `LEFT_OUT_FLAGS`, `qa/triage.ts:29`), so the swap
never triggers today and nothing may count on it: in practice LS is sent whenever the module's own outputs (charts
excluded) are below the cap. The flag is a dormant hook for a later policy that publishes charts: where the
channel's `scene_replaces_chart_at_cap` is true and a published chart exists, the chart's output there becomes `skipped` ("Replaced by the scene image: this
marketplace allows <max_images> photos.") and LS is sent. Otherwise LS is `skipped`: "Not added: this marketplace already
has its maximum number of photos." Brand photos are never dropped for LS.

### 7.4 Publish (`pipeline/publish.ts`)

- `planPublish` (`pipeline/publish.ts:55`) gets the LS source like any source, so its live outputs are not deleted
  (`pipeline/publish.ts:63`); it applies 7.1 to 7.3 and a rights guard: without a valid `brand_rights` row of sufficient
  `lifestyle_scope` at publish time, LS is `skipped` ("Not added: the brand's written permission for generated images
  is not on record.").
- **The hold test.** On `main`, `publishProduct` holds the whole product as `pending_attention` when any output is
  `unjudged` (staged, no decision, `qa_scores` null, no `qa_sampled_out`, `pipeline/publish.ts:107`) or is neither
  staged, skipped nor verified without a decision (`:108`). Spec 12 s6.3 exempts made photos by their slot state, and
  LS has no slot. Spec 12 s6.3 defines the one predicate for both, `madePending(o) = slotPending(o) ||
  lsPending(o)`, with the slot-free clause
  `lsPending(o) = source(o).role === 'ls' && source(o).scene.state in ('checking','in_review','held') && o.decision === null`;
  spec 13 supplies `scene.state` (1.3). Outputs with `lsPending` are skipped by both clauses of `:108` and by
  `triageProduct` (`qa/triage.ts:58`), are not counted as good shots, and stay out of `copies`. After exit a `ready`
  LS output is `staged` with the scene `qa_scores` of 1.3, so `unjudged` is false and it publishes with the brand
  photos. With any `lsPending` output and nothing else holding, `change` is spec 12's `pending_review` with "Brand
  photos are live; the scene image waits for review." The lock is not kept (spec 12 s6.3 owns this rule):
  `releaseLocks` (`pipeline/publish.ts:71`) frees it at finalize like any published product, so a new delivery of
  the product is never refused while its scene image waits. `listAttention` (`catalog/attention.ts:15`) lists LS
  cards by `scene.state` in `in_review` or `held` (spec 12 s7.1).
- **How a reviewed LS publishes.** Both raters' "publish yes" (spec 12 s7.2 rule) goes through `applyDecision`
  (`decisions.ts:44`), which re-takes the lock for the LS's own batch with the existing rule (`decisions.ts:37-42,
  55`), sets `use_as_is` on every LS output of the source and `scene.state = ready`, and enqueues the publish
  (`apps/web/lib/catalog/decisions.ts:18`). That publish runs under the re-taken lock and inside the worker's
  scope rule: it writes only public objects under the product's own prefix (`assertWithinProduct`, `naming.ts:166`,
  called by the copy and delete helpers) and only on that batch's channels; it copies only the LS outputs (brand
  photos already live are kept as they are), sets `scene.state = live`, `change = scene_added`, and enqueues
  finalize (`apps/worker/src/catalog/publish.ts:15`), which writes a new sheet version and releases the lock again.
  Both "no": `remove`, `scene.state = removed`, `change` returns to what the brand photos gave, and finalize releases
  the lock.
- **A newer batch or a replacement while LS waits.** If a newer batch holds the product's lock, the decision is
  refused (409 at `decisions.ts:40`) and the older LS is superseded: `scene.state = removed`, note "Scene image not
  used: a newer delivery of this product replaced this one." The newer batch's scene stage plans the product again;
  when its packshot shas, profile version and rights row equal the superseded frame's, it reuses that frame (no
  generator call, the 9.6 item 3 copy within the same product) and carries the labels already given into the new
  `in_review`. A replacement upload in the same batch (`completeReplacement`, `decisions.ts:79`, which takes the lock
  the same way at `:81`) that replaces a packshot in the LS's `referenceShas` sets the pending LS to `removed` ("Scene image
  remade: a product photo was replaced.") and the scene chunk runs again after the replacement's chunks (3.1); a
  replacement of any other photo leaves the pending LS as it is.
- An LS output row exists for every ticked channel (staged, held or `skipped`), so `missingPairs` (`pipeline/publish.ts:91`)
  never fires for LS.

### 7.5 `change`, events, re-submission

`change` (`pipeline/publish.ts:151`) gains `scene_added` when the only copies are LS outputs and nothing was removed or
reordered; spec 12 s8.3's precedence becomes `failed` > `shots_removed` > `new` > `cut_replaced` > `role_added` >
`reordered` > `scene_added` > `updated` > `unchanged`, with `pending_review` while an LS waits.
Events: `scene_added` (channels, `n`, position, route, date) when an LS first goes live; `scene_retired` (removed
links) on 7.6. These events are the data a later treatment log reads; spec 13 builds no treatment log (P08 row 1.9).
Operators re-submit `scene_added` rows like `updated` (0.4 item 5): on each channel named in the row's notes, upload
the product's image columns again from the sheet, LS last. A product whose LS went live in a decision-triggered
second publish appears in the new sheet version with `scene_added`.

### 7.6 A real photo replaces the generated one

When rule 5 finds a brand worn, carried or lifestyle photo, or the profile is off, or the rights row lapsed, the LS
source is not carried: its live outputs are deleted by `planPublish` (no source at that `n`); event `scene_retired`, `change` `shots_removed`, note "Generated scene image removed: <reason>."
The frame stays in the private bucket.

### 7.7 Links sheet and report

The LS link sits at its `position` (spec 12 s8.4 replaces `links[n-1]`, `pipeline/report.ts:150`), the product's last
image column for that channel; no new column type (`sheet.ts:92`). Spec 12's "<Channel> shots" column names it
"<k> lifestyle (made)". `notes` (`sheet.ts:30`) per LS output: "<Channel> img <n>: Scene image made by AI from the
brand's photos." or, composite, "<Channel> img <n>: The brand's own product photo placed in an AI-made scene."; the
skip and not-sent sentences appear the same way. `report-v<k>.json` gains `scene: { eligible, skipped: {<reason>: n},
full: {accepted, held}, composite: {accepted, held}, reused, attempts, usd, usdPerAccepted, notSent: {<channel>: n},
resubmit: {<channel>: n} }`.

## 8. Review-all, labelled set, exit, sampled review

### 8.1 Taken from spec 12 s7

The card section in `listAttention`, `POST /api/catalog/review/[sourceId]`, `catalog_review_labels`, two blind raters
plus an adjudicating admin, the two-yes publish rule, alpha 0.67 per question, the exit bars of s7.4 (false passes 2%
or less with zero on G1 and G2, false holds 15% or less, planted defects caught 100%), the Ops exit button and 10%
sampled review (hash of source id). LS uses `catalog_gate_state` rows with the scopes of 1.3, not the per-brand
`shotset` row, so exit and relapse act per route for every brand at once.

### 8.2 What differs for LS

- **Card:** the frame with the core box and every channel window drawn, the crops, the references, the route, each
  check in words, and for the composite "Product pixels identical to the brand's photo (checked by code)". "Use as
  is" is not offered when S1 found a face, or on `paste_back_mismatch` or `ai_tag_missing`.
- **Questions** (stored in `answers`), **full route:** same product; logos and text intact; same colour; no face and
  framing within the rule; modest clothing; scene free of the forbidden list; looks like a real photo; then publish
  yes or no. **Composite:** no face; scene free of the forbidden list; looks like a real photo; product sits
  naturally; then publish yes or no.
- **Exit:** 100 labelled LS images across at least 3 brands, at least 20 of them composites, meeting the 8.1 bars,
  alpha 0.67 or more on every question, and zero false passes on S1 (face), S2 (modesty) and paste-back. Each route
  exits on its own: `scene_full` on the full-route labels within the 100, `scene_composite` only when its own 20 or
  more labels meet the same bars. Composites stay in review-all until then (settles F00 conflict 9; alternative
  12.3 Q3).
- **Relapse (per route, every brand):** a batch whose sampled LS shows over 2% false passes, or any single false
  pass on G1, G2, S1, S2 or paste-back, sets that route's row back to `review_all` at once (event
  `scene_relapse`, alert as spec 12 s12.2); exit again needs 50 new labels of that route meeting the bars.
- **Raters:** Naz and the second rater named under spec 12 s7; labels come from the 9.2 run and the 9.6 backfill.

### 8.3 Planted defects and 8.4 after exit

Planted (golden set, 10.3): a face; bare legs above the knee; a readable sign; a flag; alcohol; a recognisable
skyline; a re-drawn logo; product colour shifted dE 5 or more; product touching the frame edge; one altered product
pixel after paste-back; a missing XMP tag; each caught 100%. After exit, passing LS outputs are `staged` and publish
without review, 10% sampled per batch; the owner records the exit in the SPEC decisions log.

## 9. Rollout

### 9.1 Switches

Deployed with `SCENE_ENABLED` unset (off). Before the run: spec 12's generator yes recorded and the generate slot set;
per brand a `brand_rights` row with `lifestyle_scope` and an approved profile (1.6). On: `SCENE_ENABLED=1` in the deploy
env and `SKIP_BUILD=1 bash infra/deploy.sh`. Each test batch starts only when the owner says the module is free.

### 9.2 All-brand test run (not a pilot gate)

A paid production run on the production worker, on `isTest` batches under `catalog-test/` (no live channel sees
them), started under the owner's yes; it is not a test tier. One batch per brand with every channel it sells on
ticked, review-all, and the 3.6 scene cap. Size: per brand, 30 eligible products chosen by a hash of the product id
(all when fewer), plus every kids product and bag with fewer than 3 views up to 10 more, so the composite route
reaches its 20 labels; `options.scene.sample` records the rule. Order: US Polo (technical test brand), Campus,
Keds, Puma, French Connection bags, Vero Moda bags. Every brand with rights and an approved profile runs; none waits
for another except on a 9.4 stop.

### 9.3 Per-brand scorecard (from `report-v<k>.json` `scene`, the ledger and labels)

| Field | Source |
|---|---|
| Eligible; skipped already worn (rule 5); skipped by each other reason | `scene.eligible`, `scene.skipped` |
| Full accepted, composite accepted, held | `scene.full`, `scene.composite` |
| Gate pass rate (accepted / eligible), first-attempt pass rate | `scene.attempts` |
| Human publish-yes rate, false passes, false holds | `catalog_review_labels` |
| Cost per accepted, by route | ledger, `route` |
| Not sent at cap, per channel; re-submit pairs (LS outputs that went live, per channel) | `scene.notSent`, `scene.resubmit` |

Live pages per channel are not a module figure (test batches never go live, and the module has no stock or price
data); the business takes them from the inventory liveness query as a separate input. The manager writes the six
scorecards into the report and `docs/solutions/` (00 section 9 step 6).

### 9.4 Stop rules

After each test batch and each backfill batch of a brand, stopping at the first that applies: (1) any false pass on
G1, G2 or paste-back; (2) on S1 or S2; (3) on S3; (4) S4 or crop failures over 10% of attempts; (5) realism or
false holds above 15%; (6) cost per accepted above 0.40 USD. A stop pauses only that brand: fixes go to prompts,
profile versions or thresholds and are re-run on the golden set before that brand's next batch.

### 9.5 From scorecards to the publish order

The module ranks nothing. The business reads the six scorecards and writes the backfill order (which brands, which
route first, and whether a brand waits for a stop fix) into the plan file in `docs/plans/`; the manager runs 9.6 in
that order. A brand with no rights row or no approved profile is simply not in the order.

### 9.6 Backfill of the existing inventory

1. **Selection.** The manager runs the inventory's "live and stocked by channel" query (proposal
   `2026-10-26-apparel-shot-set/01-inventory-count.md`, section D) per brand, outside the module, and hands the
   operator the option list; the module has no stock data. Studio on-legs products drop out at rule 5.
2. **Batches.** Normal (not test) batches per brand in the 9.5 order, at most 200 products each, every channel the
   brand sells on ticked, started only when the owner says the module is free. Each batch's scene cap is 3.6's;
   `shotSet.generateCapUsd` applies too when the batch sets it. Brand photos already live stay `unchanged` apart from
   the one re-render of 0.4 item 8.
3. **Reuse of test frames.** A live product whose packshot shas, profile version and rights row equal those of a
   test-run LS with both raters' "publish yes" reuses that frame: the scene stage copies the private frame from the
   test prefix to the live product's `derivedPath(..., "scene")` (copy before any test cleanup), records
   `scene.reusedFrom` and the labels' ids, writes a ledger row with kind `compute` and usd 0, re-renders the channel
   outputs, re-runs the code checks (S4, `ai_tag`, paste-back) and sets `ready`. No generator or judge call; no
   second review. Any difference in shas or versions means a fresh ladder. So the test-run spend is not paid twice
   for the sampled products.
4. **Review and publish.** Until exit every new LS goes through 7.4's review path; brand photos publish at once.
   Labels count towards the exit (8.2).
5. **Re-submission.** Every product whose LS went live is a `scene_added` row (7.5); `scene.resubmit` counts the
   product-channel pairs per batch so the business sees the upload load.

### 9.7 Steady state

New footwear and bag products get the step in every batch; carried frames cost nothing (2.4); a real worn, carried
or lifestyle photo retires the generated one (7.6).

## 10. Tests and evals

### 10.1 Tier 1 (`pnpm test`)

- Crop geometry: `cropWindow` gives the 6.2 sizes on all nine channels; for every `productBox` inside `SCENE_CORE` on a
  16 px grid of positions and sizes, every window contains it with 16 px clearance; 1 px outside the core fails S4;
  clamping at each frame edge.
- Paste-back: a synthetic hard-edged cut-out on a noisy frame gives `pasteBackEqual` true; one opaque pixel changed by
  one level gives false and `paste_back_mismatch`; blended edge pixels are not compared.
- `composeOnCanvas` with a colour is byte-identical to today's render on the spec 10 synthetic products.
- `renderFullFrame`: target dims on all nine channels, under 2 MB, sRGB, 4:4:4, channel DPI; `checkOutput` skips
  exactly the four codes for LS and none for other roles (identical failure lists on existing fixtures); `ai_tag`
  passes with the route's source type, fails without it or with the other; the XMP survives the quality loop.
- Eligibility: one case per 2.1 row and 2.3 rule, including `unknown` audience, bags with 2 views, null roles,
  presence `worn` on a studio photo, `still_life_props`, `still_life` scope blocking the full route, rule 2 with
  `generate_enabled` false. Kids rule: on a recorded fixture of option id, name and gender rows (no customer data),
  the 2.2 rule counts the inventory's 88 kids products exactly.
- Ladder: a fake generator failing in order gives the 3.6 sequence and ledger rows (`route`, `attempt`); an empty
  escalation slot is skipped; `undersize` fails an attempt; `cap` stops with the note and no hold.
- S1 on canned `/measure/people` responses: face, hips, a seated pose with knees mid-frame (passes), `feet_only`
  knee, `shoulder_to_hip` shoulders at the top edge, `waist_held` shoulders; `/measure/people` down gives
  `gate_unavailable`, a hold.
- Triage: `leftover_background` never holds LS; `runQaStage` excludes LS outputs; `lsPending` outputs are not good
  shots and hold nothing.
- Publish: carry-forward keeps live LS; cap `skipped` with its sentence; chart swap only with the flag and a published
  chart; an LS in `checking`, `in_review` or `held` does not hold brand photos (`pending_review`) and the lock is
  released at finalize; a yes decision re-takes it and the LS publish touches only the product prefix and the
  batch's channels; a decision after a newer batch took the lock gets 409 and supersedes the LS; a replaced
  reference packshot removes the pending LS and re-runs the scene step, any other replacement leaves it;
  a `ready` LS with scene `qa_scores` is not `unjudged`; `scene_added` precedence; retirement deletes and records
  `scene_retired`; the rights guard; a QA chunk's `finish` skips the publish enqueue while a scene chunk is open.
- Backfill reuse: equal shas and versions copy the test frame with no generator call; any difference runs the ladder.
- The spec 07 banned-names test passes with every new sentence (no model or detector name in operator copy).
- pytest: `/measure/people` with a fake session returns the schema, 400 on a bad image, writes nothing to disk, and
  has no embedding field.

### 10.2 Tier 2 (PGlite, in-memory storage, mocked generator and judge)

An adult shoe, a kids shoe and a two-photo bag through matte, render, qa, scene and publish on all nine channels: the
adult gets a full-route LS (canned frame), the others a composite (canned background) with paste-back equal; outputs
`needs_attention` while brand photos go live in the same publish (`pending_review`, lock released at finalize); two
raters' yes re-takes the lock, publishes LS at `n` 101, last position, with its note and `scene_added`, and
finalize releases the lock; a newer batch started before the decision supersedes the waiting LS and reuses its
frame; a second batch with
the same photos carries the frame (zero generator calls, outputs unchanged); a third batch with a brand worn photo
retires LS. After-exit phase: with the `scene_full` row `sampled`, a passing LS (not sampled) is `staged` with scene
`qa_scores` and publishes with the brand photos in one publish, no hold. OpenRouter is mocked with `llm/mocks.ts` (`mockFetch`, unmatched calls throw).

### 10.3 Golden set and eval job

A `scene` set in the spec 10 manifest: 30 products across the six brands (packshots pinned by sha256) labelled with
subcategory, audience and expected route, plus the 8.3 planted frames. A `scene` check group in
`catalog-output-evals` runs eligibility, routes and checks on canned frames by default; with `LIVE_SMOKE=1` in the
Cloud Run job it calls the generator and the escalation probe (3 requests, sizes recorded). Objects under
`catalog-test/evals/<run>/scene/`, deleted at the end even on failure.

### 10.4 Tiers 3 and 5, live rules

Tier 3: `REAL_DATA=1 pnpm test:real` runs the scene stage on two golden products with the local matting container
a fake generator returning stored frames and the judge mocked (`llm/mocks.ts`); objects only under `catalog-test/`,
deleted in `finally`. Tier 5: the
deploy smoke runs with `SCENE_ENABLED` unset and asserts no LS output exists. No live generator or judge call happens
outside the `LIVE_SMOKE=1` job and the production worker with `SCENE_ENABLED=1`.

## 11. Acceptance, monitoring and cost hooks, operator guide, report

### 11.1 Acceptance checklist

- [ ] Spec 12 merged and the 0.3 contracts exist on `main` (else stop and report).
- [ ] Migration re-run is a no-op; `pnpm lint && pnpm typecheck && pnpm test` green.
- [ ] SPEC.md carries the 0.4 amendments verbatim; `CHANNEL_RULES_VERSION` bumped by one.
- [ ] Every 10.1 and 10.2 case passes; the golden `scene` set passes with planted defects caught 100%.
- [ ] `/measure/people` on both matting services; licences recorded in `services/matting/README.md`.
- [ ] Deployed with `SCENE_ENABLED` unset; tier 5 green with no LS output.
- [ ] The "Scene images" profile section and `lifestyle_scope` in the rights route work for an admin only (1.6).
- [ ] All-brand run done per 9.2, US Polo first, six scorecards written; every 9.4 stop and its fix recorded.
- [ ] Backfill order from the business in the plan file (9.5); backfill batches run per 9.6 with reuse counts.
- [ ] No live LS is image 1, lacks a `brand_rights` row or lacks the XMP tag (a query plus a fetch of every live LS;
      the report notes that marketplaces may strip metadata, 6.4).
- [ ] Every live composite has paste-back equality `true` recorded.
- [ ] Ops "Scene images" block, the log events and the monitoring-guide query exist (11.2).
- [ ] The step 4 estimate line and the operator guide section exist (11.3).
- [ ] Exit status recorded with its numbers; composites in review-all until their own exit.

### 11.2 Monitoring and cost hooks

Ledger rows with `route` for every generator, judge and measure call of the stage (`packages/core/src/cost-events.ts:75`).
The admin Ops page (`apps/web/app/catalog/ops/page.tsx`) gains a "Scene images" block per brand (7 and 30 days:
attempts, accepted, held, cost per accepted by route, not sent at cap), no model names. Per-batch cap through spec 12
s5 before every attempt; the daily cap (`qa/caps.ts:20`) applies when set. Log events `scene_skip`, `scene_attempt`
(route, rung, outcome, ms, usd), `scene_accepted`, `scene_held`, `scene_retired`, `scene_relapse` (alerted); `docs/handover/monitoring-guide.md`
gets the cost-per-accepted query.

### 11.3 Operator guide and UI copy

Step 4's estimate line adds, when the brand's profile is on: "Scene images: up to <N> products may get one, about USD
<x> at most." (N = footwear and bag products in the batch, x = N x 0.55). `docs/handover/catalog-for-the-operator.md`:
what a scene image is, that it is always last and AI-made, how to review its card, each note, and that `scene_added`
rows need re-submitting.

### 11.4 Report

The 00 section 10 report plus the SPEC.md diff, the migration name, the six scorecards, the exit status, the
escalation probe sizes, cost per accepted by route against 0.20 USD, and the 12.3 questions still open. Ends with
"Ready for the next spec" or `Blocked: <exact thing needed>`.

## 12. Settled contradictions and open questions

### 12.1 Focus 00 section 6

| # | Conflict | Settled as |
|---|---|---|
| 2 | 6.1a base 3.4k vs 3.7k | No revenue figure is used; the scorecard measures coverage and cost |
| 6 | Lifestyle waits on Noon / Namshi acceptance (I06 L24) vs not (08 L335) | Not waiting: Noon allows lifestyle as an additional image (DD4 F5); others are `assumed` and sent; that acceptance gates infographics only |
| 7 | US Polo first vs all asks at once; lifestyle before callouts vs callouts first | Every brand with rights runs (9.2); US Polo first only as the technical test brand; no ordering dependency on 6.3 to 6.5 |
| 8 | Most kids are US Polo, but the US Polo rights question omits 6.2 | One `lifestyle_scope` per brand covers both routes; US Polo kids need at least `still_life` |
| 9 | Composites in review-all vs leaving on code checks | Review-all until their own 20-label exit (8.2); alternative in Q3 |
| 14 | SPEC line drift | Lines verified at `d82cc36` (0.4) |

### 12.2 Evidence contradictions

| # | Contradiction | Settled as |
|---|---|---|
| 5 | The escalation engine returned 896x1200 on a 2K request | `undersize` fails the attempt (3.4); the slot stays empty until 3 of 3 probes return 2K (3.6) |
| 6 | "1,300" means two things | No capacity or inflow figure is assumed; caps and the scorecard measure what is made and reviewed |
| 8 | Puma and VM bags have few Noon / Namshi listings | The run covers every channel each brand sells on; live pages per channel is a scorecard field |
| 9 | Already-worn products counted in the 1,222 and 244.40 USD | Rule 5 skips them; the scorecard's measured eligible count replaces the backlog figure |

### 12.3 Open questions (defaults apply; none blocks the build)

1. Q1. Do Campus's styled studio still lifes (props, no person) count as present? Default: no (`still_life_props`,
   2.2), so Campus gets a worn scene although the audit counted those sets as covered.
2. Q2. The `CHANNEL_RULES_VERSION` bump changes every `render_key`, so each existing product's next batch re-renders
   its brand images and, under the reuse rule in `publishProduct`, likely copies them again and shows `updated` (tier 2
   confirms which). Default: bump as decided; alternative: an LS-only version inside LS render keys.
3. Q3. Should composites leave review-all on code checks alone (DD4 L291) instead of their own 20-label exit?
4. Q4. Add Amazon's `contains-synthetic-performer` keyword (unverified on an Amazon page, DD4 F5) to full-route images
   on Amazon? Default: off.
5. Q5. Lifestyle rules for 6thStreet, Styli, Centrepoint, Shein and VogaCloset are not public, and Noon says "only
   photographs are permitted" (DD4 F5, Q6). Default: send as `assumed`; the owner may set a channel's `lifestyle` to
   `off`.
6. Q6. A brand-supplied lifestyle photo is still held as `leftover_background`; give it the full-frame mode next?
7. Q7. `unisexStyling` per brand (Puma has 59 unisex style-colours, DD4 F1): confirm each profile's value.
8. Q8. Spec 12 interfaces: the earlier requests (`GEN_MODES`, numeric `attempt`, gate `scope`, label `answers`,
   `capUsd`, view `pair`, the rights route, `ls` last, the `lsPending` clause of `madePending` and the scene cards
   (s6.3, s7.1), the `BatchOptions.scene` slot (s1.2)) are all in spec 12 (its 13 item 11). Where spec 12 as merged
   differs, spec 13 adapts to spec 12.
9. Q9. A rights grant limited to some marketplaces: default recorded as `none` (1.2); a per-channel scope is added
   only if a brand asks.

### 12.4 Values settled for the business case (the business case follows these)

1. **Batch cap:** 0.55 USD per eligible product (3.6), a new scene cap passed to spec 12's `checkGenerateCaps` and
   applied with `shotSet.generateCapUsd`, not `options.qaCapUsd` (which caps judge spend only). 0.30 is too low:
   3 generator calls alone are 0.31.
2. **Review questions:** the 8.2 lists (full route 7 plus publish; composite 4 plus publish), not spec 12's six
   apparel questions.
3. **Exit:** 8.2: 100 labels across 3 or more brands, at least 20 composites, spec 12 bars, alpha 0.67, zero false
   passes on S1, S2 and paste-back; each route exits on its own.
4. **Relapse scope:** per route for every brand at once (program-wide rows), triggered by over 2% sampled false
   passes or one false pass on G1, G2, S1, S2 or paste-back; re-exit after 50 new labels of that route.
5. **Size-chart swap:** never triggers today (charts are left out); the business case counts no swap and treats every
   channel cap as "LS sent while module outputs are below the cap".
6. **Treatment log:** not built here (P08 row 1.9); spec 13 supplies the `scene_added` events it would read.
7. **Eligible base:** rule 5 removes studio on-legs products, so the cost headline uses the count after that rule
   (the business case's 161.40 USD basis, not 193.40), and Campus is counted as eligible under the Q1 default.
8. **Test run size and reuse:** 30 sampled products per brand plus up to 10 composite candidates (9.2); approved
   test frames are reused in the backfill (9.6 item 3), so the test-run spend is not counted twice.
9. **Undersize:** an output below 1792x2400 fails that attempt and the next rung runs; nothing is held for size.

### 12.5 Alignment with spec 12's lock rule

Spec 12 s6.3 owns the lock rule for `pending_review`: the lock is released at finalize and re-taken by the publish
decision (`decisions.ts:37-42,55`); a newer batch supersedes older waiting candidates. Spec 13 follows it (7.4): an
earlier draft kept the lock while an LS waited; that is withdrawn. Consequences written into 7.4 and 10: a new
delivery is never refused because of a waiting scene image; a late LS publish runs only under the re-taken lock,
inside `assertWithinProduct` and the batch's channels; a decision after a newer batch took the lock is refused and
the LS is superseded, with its frame reused when nothing changed.
