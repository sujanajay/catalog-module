# Prototype

`catalog-prototype.html` is the clickable, single-file prototype of the operator experience,
version 2. It uses hash navigation (the part of the address after `#` picks the screen) and sample
data for USPA, French Connection, Anta and Campus; open it in any browser, no server needed. It is
the visual contract that `docs/specs/01-ui-prototype.md` transcribes screen by screen, and the
published copy is https://claude.ai/artifact/HL7t82VTQ1bRchziPwLySr. Known differences the real UI
applies, all recorded in spec 01: the Google share address shown in the wizard is
`catalog-web@image-links-agent.iam.gserviceaccount.com` (the prototype shows the earlier app's
address); the footer and Details tab wording follow the product-identity decision (a product's
links stay the same for life; uploading a product again replaces the pictures behind its links;
marketplaces keep their own copy, so changed products are re-submitted there); HEIC photos are
converted automatically rather than refused; "Check what we found" has real controls for the
identifier column, the image columns and the sheet kind; the Start step shows how identifiers were
read and an estimated cost; the batch page adds a "Download filled product list" button when a
product list workbook was uploaded and shows "Links verified: N of N" and "Independent re-check:
N of N OK" on the Details tab; and the prototype's "Photo shoots" and "Spend" navigation entries
belong to the earlier app and are not built.

## Shot set and scene image prototype

`shot-set-and-scene-prototype.html` is a clickable, single-file prototype of specs 12 (apparel shot
set) and 13 (footwear and bag scene image), built before deciding whether to build them. Nothing real
runs: it uses sample data (Vero Moda apparel, US Polo shoes and bags, a mixed US Polo batch, Campus
with no scene permission, and products already live) and a fake worker you move with "Advance time".
Open it by double-click; no server needed. Version 2 (2026-10-27) follows the owner's decisions of
that day: every photo is reviewed only in the internal test run; live batches publish automatically
after our checks, with spot checks of about 1 in 10 (1 in 4 for kids scenes) answered by the batch
operator, and a cell the test run did not cover stays "Checked by a person". The top bar has:

- **You are**: Operator or Admin (no second rater). The batch page has a Products tab ("Needs me /
  All", one status and one action per product) and a Needs me tab with only "Questions for you" and
  "Spot checks". "Something is wrong" opens "Fix and try again" (two rounds, refused notes explained).
  Step 4 is a two-line plan with "More options" and "Details".
- **Admin**: Brand DNA (logos, brand words, models for women, men and kids, look, scenes, kids look,
  delete) and Ops (pause automatic publishing per scope, test run labels per cell, and "What the
  system learned", marked "Later phase").
- **Test controls** (prototype only): how photos go live per scope, swimwear coverage, making on or
  off, approved brand model, scene permission, detection fails, batch limit events, fixes that fail,
  newer delivery, marketplace limits, 7 days of unanswered spot checks, learning mode, theme, Reset.
- **Test guide**: 38 scenarios and the feel questions, each with "Take me there" and a tick box
  (kept in the browser only).

Images are drawn stand-ins, not brand photos. No model, vendor or check name appears. Known
shortcuts: plan counts come from a simplified planner over hand-written sample data; which products
get a spot check is fixed per sample product, not sampled; Ops numbers are partly fixed sample
values; made-photo and scene outcomes are set per sample product.
