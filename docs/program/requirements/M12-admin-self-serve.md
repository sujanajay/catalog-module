# M12 Admin, brands and self-serve - requirements (draft for review, 2026-11-02)

Follows `00-template.md`. Plain words; jargon is defined the first time it appears. The screens and copy follow
`UX-design-system.md`.

## 1. Purpose

- **Why it exists.** Every business setting (channels, brands, categories, rules, services, thresholds, audit rates,
  experiment flags) must be changeable by a non-technical person without an engineer or a deploy, and each brand's look,
  voice and rights must live in one place. Later the same product is sold self-serve to brands and agencies worldwide and
  becomes the front door to Opptra distribution.
- **Outcome metric.** Share of setting changes made without an engineer (target 100% of business settings); time for a
  non-technical admin to add a new brand, channel or category (targets in section 6); later, external organisations live
  and brands converted to Opptra distribution.
- **Intents served:** I021 (non-technical config), I026 and I040 (self-serve; onboarding hook), I014 (people only for
  rights, likeness, thresholds), I015 and I025 (ops and true cost), I012 and I003 (swap services without code), I008
  and I027 (no babysitting; ask only what needs a person).

## 2. Scope

**In:**
- One **Settings** area for all business settings, versioned, with a preview of what a change will do, history, and
  one-click revert.
- An **Ops** page for health, cost, throughput, incidents, audits and experiments (extends today's `/catalog/ops`).
- **Brand DNA**: per brand, the look, logos, voice, infographic look, scene profile, rights and models, filled by the
  system and confirmed by a person.
- Adding a new brand, channel or category with no code, by starting from a copy of an existing one.
- Roles: who may change what.

**Out:**
- Per-SKU approval workflows (ruled out by I017 and I032; approvals apply to setting and rule changes only).
- Enterprise master data, GS1 data pools (GDSN) and retailer EDI.
- Editing the **structure** (which fields exist) from the UI, until a second customer needs it (gate-1 decision).

**Later:** multi-tenant accounts, billing and self-serve sign-up; the onboarding hook to Opptra distribution; agent and
MCP access (MCP, the Model Context Protocol, lets AI assistants call a product's tools).

## 3. Contracts

### 3.1 Reads and writes

| Direction | Module | Entity or event |
|---|---|---|
| Writes | all | `setting_version` (area, key, value, schema version, who, why, effective from); event `setting.changed` |
| Writes | M5 | Rule edits go through M5's rule store; M12 is the screen, M5 owns the data and its checks |
| Writes | M3, M8, M11 | `brand_dna_version` (look, logos, voice, infographic look, scene profile); `rights_record`; `model_pack` |
| Writes | M7 | Audit rates and quality thresholds (risky settings, owner-confirmed) |
| Writes | M6 | Service ranking per capability (primary, second, fallback) and spend caps |
| Reads | M6 | Cost meter, idle share, throughput, batch success, incidents |
| Reads | M7 | Audit results per category, check failure rates, vendor bake-off scores |
| Reads | M4, M10 | Experiment registry and readouts; recommendations |
| Reads | M0 | Products, listings, change reasons, versions (for the preview replay) |
| Reads | M9 | Rejections and their causes |

### 3.2 API shapes

```
GET  /api/settings?area=channels|brands|categories|rules|services|quality|experiments|notifications|people
POST /api/settings/changes        { area, key, scope: { brand?, channel?, category? }, value, reason }
     -> 200 { change_id, risk: "normal" | "needs_owner", preview_id }
GET  /api/settings/preview/:id    -> { summary: "Based on the last 30 days, 42 of 1,240 products would change.",
                                       examples: [ { product_id, before, after } x up to 5 ], replayed_batches: 3 }
POST /api/settings/changes/:id/apply      # normal risk: applies now; needs_owner: only an owner may call it
POST /api/settings/versions/:id/revert    # restores the previous value as a new version
event setting.changed { area, key, scope, from, to, by, reason, version, effective: "next_batch" }
```

### 3.3 Rules every module follows

1. **Snapshot at batch start.** A batch reads all settings once, records the version set it used, and keeps it to the end.
   A change made mid-batch applies to the next batch. This keeps batches consistent and safe across changes (and across
   deploys, M6).
2. **Every output records why it looks the way it does:** the setting versions, rules version and Brand DNA version that
   made it.
3. **No setting lives in code or environment variables** if a business person could want to change it. Switches that
   exist today as environment variables (for example the old `SCENE_ENABLED` and `INFOGRAPHIC_ENABLED`) become settings.

### 3.4 Contract needs from M0

- A `setting_version_set` id stamped on every `content_version` and every `change_reason`.
- Read access to the last 30 days of decisions and inputs, so the preview can replay them under a proposed value.
- An `org_id` (organisation) column on every table from day one, set to "Opptra" for now (see M12-F5; open question Q1).

## 4. Features

### M12-F1 Settings surface (P1; I021)

**Story.** As an admin who is not technical, I want every business setting in one place, in plain words, so that I can
change how the system behaves for a brand, channel or category, see what the change will do before it happens, and undo
it in one click.

**Key requirements.**
- M12-F1-R1. One Settings area with these sections: Brands, Channels, Categories, Rules, Quality, Services,
  Experiments, Notifications, People. A search box finds any setting by its plain name ("title length", "Noon",
  "background").
- M12-F1-R2. Every setting has a schema (type, allowed range or list, default, scope, owner role, risk class) and shows a
  plain label, one help sentence, its current value, where the value comes from ("Noon's published rule", "Opptra
  playbook", "set by Sujan on 4 Nov"), and the evidence grade from M5.
- M12-F1-R3. Inputs match the type: switches for yes/no, a stepper with limits for numbers, pick lists for fixed values,
  colour pickers with a contrast check, file drops for logos and fonts. No raw JSON, code or regular expressions are
  ever shown to a non-technical admin.
- M12-F1-R4. **Inheritance.** Values cascade: programme default, then channel, then category, then brand. The screen
  shows which level a value comes from and lets the admin override at a lower level ("Only for Campus on Noon").
- M12-F1-R5. **Preview before apply.** Every change shows "What this changes": the system replays the last 30 days of
  decisions under the new value and states the count and up to five before/after examples. Changes that affect nothing
  say so.
- M12-F1-R6. **Effective at the next batch.** Running batches keep their snapshot. The confirmation says "From the next
  batch."
- M12-F1-R7. **History and revert.** Every setting shows who changed it, when, why (one optional sentence) and the old
  value. "Revert" restores the previous value as a new version. A changed value can be undone from the toast for 10
  seconds.
- M12-F1-R8. **Risky changes need the owner.** Quality thresholds, audit rates, rights records, turning a service's
  primary off, and switching a category to automatic are "needs owner": the change waits as a proposal until an owner
  applies it (settled decision: a person checks threshold changes). Everything else applies at once.
- M12-F1-R9. **Add without code.** New brand, channel or category starts from "Start from a copy of ..." (for example a
  new channel from Noon), then the admin edits the differences. A new channel needs: name, countries, languages, image
  rules, shot policy, text limits, add-on slots, listing-file template mapping (M9). A new category needs a parent and
  inherits its policy.
- M12-F1-R10. **Conflicts surface.** When two rules disagree (M5 conflict register), the setting shows both and asks for
  one choice; nothing is picked silently.
- M12-F1-R11. **Export and import.** Any section downloads as a sheet for review and can be uploaded back; the upload is
  shown as a set of proposed changes with the same preview, never applied blindly.
- M12-F1-R12. Structure (which fields exist) is not editable in the UI. A request for a new field shows "Ask the team to
  add a field" and creates a ticket.

**Acceptance test.** A non-technical admin, with no help, changes Noon's title length limit for footwear from 150 to 120
characters: finds it by search, sees "42 of 1,240 products would get shorter titles", applies it, starts a batch, and the
batch's titles respect 120. They revert it in one click. Total time under 2 minutes; no engineer involved.

**Buy or build.** Build. PIM settings (Salsify, Akeneo) are built for brand-to-retailer data models at USD 45,000 to
250,000 a year and do not know our rules; the preview-by-replay idea is taken from Stripe Radar's rule backtest.

### M12-F2 Ops page (P1; I015, I025)

**Story.** As the owner, I want one page that tells me in five seconds whether everything is fine, and if not, what is
wrong and whether it needs me.

**Key requirements.**
- M12-F2-R1. Keeps today's `/catalog/ops` (active batches, health, failures, cost by brand) and adds: batch success rate,
  incidents, idle share of GPU seconds, throughput per hour, audit results per category, experiment status, service
  status per capability (primary up or failed over).
- M12-F2-R2. The top line is one sentence: "Everything is working. 3 batches running, 0 incidents this week." or "One
  thing needs you: the image service failed over to the second option at 10:14. Batches continue."
- M12-F2-R3. Cost shows true cost per product (M6), with idle as its own line, and the gap to billing.
- M12-F2-R4. Incidents open automatically from rules (batch stalled for 15 minutes, failure rate above 5%, cost per
  product above twice the 7-day median, a service failing over) and close automatically when the cause clears.
- M12-F2-R5. Technical detail (logs, revision ids) sits behind "For the technical team", as today.
- M12-F2-R6. Vendor names may appear on this page and in Services only, never on operator pages. Model ids never appear.

**Acceptance test.** Kill the primary image service in staging: within 5 minutes the top line changes to the fail-over
sentence, an incident opens, batches continue, and the owner receives one notification. Restore it: the incident closes
by itself.

**Buy or build.** Build on today's page and BigQuery; use Cloud Monitoring alerts as the source for service health.

### M12-F3 Brand DNA (P1; I014, I026)

**Story.** As an admin, I want each brand's look, voice and permissions in one place that fills itself from the brand's
photos and website, so that I only confirm what is right and the brand looks and reads the same on every channel.

**Key requirements.**
- M12-F3-R1. One page per brand with sections: Look, Logos and marks, Voice, Infographic look, Scenes, Models (only when
  rights include likeness), Rights, Channels, Delete. A summary strip at the top: "Look: version 2 approved. Logos: 3
  approved. Rights: valid until 30 Jun 2027."
- M12-F3-R2. **Fills itself.** Background colour, crop lines and lighting are measured from the brand's photos; logos are
  suggested from photos and the brand's website (only with permission on record); colours are suggested from the logo;
  voice words from existing titles. Everything arrives as a suggestion. **Nothing is used until a person approves it.**
- M12-F3-R3. **Versions.** An approved version is never edited; a change makes a new version, used from the next batch.
  Nothing already made is re-made when a version is approved unless the admin chooses "Apply to live products", which
  goes through the normal change-set path.
- M12-F3-R4. **Voice.** Keyword family (up to 12 words), banned words, approved claims and disclaimers, tone (one of a
  short list: plain, sporty, premium, playful), formal or Gulf Arabic, and per-language examples. Used by M8 and M11.
- M12-F3-R5. **Rights record** (the person step Sujan asked for). Fields: who granted it, a document reference (never the
  document text), sites covered, "may use model photos as reference" yes or no, "may generate the model's likeness" yes
  or no, lifestyle scope (none, still life only, worn or carried), kids allowed yes or no, valid from and to, recorded by.
  Only an owner can save it. A record counts only between its dates.
- M12-F3-R6. **Expiry.** 30 days and 7 days before a rights record ends, the owner gets one notification. On expiry, new
  generated scenes, faces and on-model photos for the brand stop the same day; existing images stay unless the record
  says they must be removed, in which case M11 retires them on the next publish.
- M12-F3-R7. **Models and likeness.** Person groups and model packs as in `M11-rich-media.md` F3: confirmed and approved
  by a person, adults and kids apart, never compared across brands, face data never shown or exported.
- M12-F3-R8. **Channels.** Which channels the brand sells on, and the brand master versus channel overlay (which fields
  the brand owns, which Opptra may change per channel; M0 feature).
- M12-F3-R9. **Delete.** "Delete this brand's data" removes face data, person groups, model packs, model photos, logo
  crops and layout photos after a typed confirmation (`DELETE <BRAND>`); records counts only; published product images
  stay.
- M12-F3-R10. **New brand in under 10 minutes.** "Add a brand": name, drop a logo, pick channels; the system suggests
  colours, look and voice from the logo and the first batch; the admin approves; done.

**Acceptance test.** An admin adds a new brand: drops a logo, picks Noon and Namshi, approves the suggested colours and
look, and records rights as "still life only". The brand's first batch uses the approved look; a scene policy set to
"worn" is lowered to still life by the rights ceiling, and the digest says so in one sentence. Total admin time under 10
minutes.

**Buy or build.** Build. Photoroom brand kits and Jasper brand voice are single-brand and visual-only or text-only; no tool
holds rights and likeness per brand for a distributor.

### M12-F4 Roles and permissions (P2; I021)

Today there are three roles: viewer, operator and admin (`packages/core/src/people.ts`), and sign-in is limited to
opptra.com accounts by Google's Identity-Aware Proxy (IAP). Add an **owner** role (risky settings, rights, deletions) and
a per-brand scope for operators. Every change outside a role is refused with a sentence naming who can make it. Later,
brand and agency roles come with M12-F5.

### M12-F5 Multi-tenant and self-serve (Later; I026, I040)

Build when a second customer exists. An **organisation** (a brand or an agency) has its own brands, settings, people,
data and bill; an agency manages many brands. Sign-up, upload and a free gap report come first; paying is per listing
that passes our checks (taking Photoroom's pay-for-pass idea), in AED, SAR, INR or USD. **Build now so later is cheap:**
an `org_id` on every table, no Opptra-only constants in code, copy without internal names, sign-in behind one interface
(IAP today; a bought identity service later, such as Google Identity Platform), and cost per organisation in the meter.
Billing is bought (for example Stripe Billing); check its current docs before building.

### M12-F6 Onboarding hook (Later; I026, I040)

A brand's self-serve run ends with "Your catalog is ready for Noon, Namshi and Amazon.ae" and a readiness score per
channel. With the brand's consent, the run becomes a lead for Opptra's distribution team, carrying the gap report and the
fixed listings. Outcome metric: brands converted.

### M12-F7 Agent and MCP access (Later; I040)

Read tools (products, gaps, digest, results) and write tools that only open change sets, so an AI agent goes through the
same rules, checks, previews and owner approvals as a person. Tokens per organisation, every call logged with a reason.

### M12-F8 Per-SKU approval workflow (Skip)

Skipped: it is a per-SKU review queue (I017, I032). Approvals apply to rule and setting changes only.

### M12-F9 Master data and GDSN depth (Skip)

Skipped: US and EU retail features (Syndigo, Stibo, Salsify) that Opptra does not need.

## 5. Operator experience

Detailed screens, components and copy are in `UX-design-system.md`. The key moments for this module:

- **Settings home:** a search box and nine section tiles, each with one status line ("Channels: 9 live, 1 has open
  conflicts").
- **Changing a setting:** the row expands in place; the admin edits the value; the preview line appears under it ("42 of
  1,240 products would get shorter titles. See examples."); one button "Apply from the next batch". Toast: "Saved. Noon
  footwear titles are now up to 120 characters from the next batch. Undo".
- **A risky change:** the button reads "Send to Sujan to approve"; Sujan gets one notification; his view shows the same
  preview with "Apply" and "Decline".
- **Brand DNA:** suggestions show as soft cards with "Use this" and "Not right"; approved items show a quiet tick and
  version.
- **Rights:** a short form; the save button is only for owners; the page header shows "Valid until 30 Jun 2027" in green,
  or "Ends in 7 days" in amber.
- **Ops:** the one-sentence top line, then compact panels; nothing blinks; nothing is red unless it needs a person now.

## 6. Measurement

| Metric | Baseline | Target | Data source |
|---|---|---|---|
| Business setting changes made by a non-engineer | 0 (all in code or environment today) | 100% | `setting_version.by` |
| Time to change one setting (task test) | Not possible today | Under 2 minutes, no help | UX task tests |
| Time to add a brand | Engineering work today | Under 10 minutes | UX task tests, `brand_dna_version` timestamps |
| Time to add a channel from a copy | Engineering work today | Under 30 minutes | UX task tests |
| Settings reverted within 24 hours | n/a | Under 10% (higher means the preview misled) | `setting_version` |
| Time to detect an incident | Hours (found by people) | Under 5 minutes | Incident log |
| Brands with rights on file | 0 | Every brand that has generated images | `rights_record` |
| Changes made outside a role | n/a | 0 | Audit log |

## 7. Build slices

| # | Slice (one worker, one worktree) | Depends on | Acceptance test |
|---|---|---|---|
| S12.1 | Settings store: schema per setting, versions, snapshot at batch start, `setting.changed` event, environment switches moved to settings | M0 | A setting changed mid-batch does not affect that batch; the next batch uses it; every output records its version set |
| S12.2 | Settings UI: home, search, section pages, typed inputs, inheritance display, history, revert, undo toast | S12.1 | The section 4 F1 acceptance test |
| S12.3 | Preview by replay over the last 30 days | S12.1, M0 decision history | Preview count matches a hand count on 3 sample changes |
| S12.4 | Owner approvals for risky settings, with notifications | S12.2, owner role | A threshold change waits until the owner applies it |
| S12.5 | Brand DNA page: sections, suggestions, versions, add-a-brand flow | S12.1, M2 analysis | The section 4 F3 acceptance test |
| S12.6 | Rights record, expiry notifications, ceiling enforcement in M11 | S12.5 | An expired record stops new scenes the same day in staging |
| S12.7 | Ops page additions, incident rules, service status | M6 meter, M7 audits | The section 4 F2 acceptance test |
| S12.8 | Add channel and category from a copy | S12.2, M5 rules, M9 templates | A test channel copied from Noon receives a listing file without code |
| S12.9 | Owner role and per-brand operator scope | S12.2 | A scoped operator cannot change another brand's setting |

## 8. Risks and open questions

| # | Risk or question | Recommended default |
|---|---|---|
| R1 | Too many settings become their own cognitive load | Show only the settings that differ from the default first ("3 changes from the usual"); hide the rest under "All settings" |
| R2 | The preview replay is wrong and misleads | Label it "Estimate from the last 30 days"; track 24-hour reverts as the warning sign |
| R3 | Rights recorded wrongly (wrong dates, wrong scope) | Owner-only save; the document reference is required; expiry reminders |
| R4 | Self-serve later needs data residency in KSA or India | Keep storage region a per-organisation setting from the start; check KSA and India rules before the first outside customer |
| R5 | Vendor names leaking into operator copy | A copy check in CI that refuses vendor and model names outside the Services and Ops pages |
| Q1 | Add `org_id` to every table now, before a second customer? | Yes: cheap now, very expensive later |
| Q2 | Who is "owner" besides Sujan? | Sujan only at first; a second owner when the team grows |
| Q3 | Should risky changes need a second person, or the owner's confirmation alone? | Owner's confirmation alone while the team is small |
| Q4 | Self-serve pricing unit: per product, per listing that passes, or per brand per month? | Per listing that passes, with a monthly minimum; test with 5 brands first (`competitors-measurement` section 7) |
| Q5 | Sign-in for outside users | A bought identity service behind one interface; choose at M12-F5 time after checking current docs |

## Sources

- `module-map.md` (M12 rows), `brief-v1.md`, `00-template.md` settled decisions, `intents.json`.
- `C:\Users\Sujan Ajay\Desktop\catalog-module\.runs\2026-11-02-competitors-listing.md` (PIM pricing and roles),
  `-competitors-measurement.md` (go-to-market, price anchors), `-competitors-visual.md` (Photoroom pay-for-pass).
- `C:\Users\Sujan Ajay\Desktop\catalog-module-wt\initiative-requirements\05-brand-faces.md` (Brand DNA page, rights,
  deletion, biometric handling), `04-scene-images.md` (scene profile), `07-infographics.md` (brand voice).
- Current code: `apps/web/app/catalog/ops/page.tsx`, `apps/web/app/catalog/brands/[slug]/page.tsx`,
  `apps/web/components/PeopleModal.tsx`, `apps/web/lib/user.ts`, `packages/core/src/people.ts`.
