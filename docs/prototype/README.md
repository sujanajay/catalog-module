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
Open it by double-click; no server needed. The top bar has:

- **You are**: Operator Naz, Second rater or Admin. The review rules follow spec 12 s7.2: one answer
  per person, the second rater does not see the first answer, a disagreement goes to an admin who did
  not rate, and photos under a hard block offer only "Remove this photo" and "Replace photo n".
- **Test controls** (prototype only): review phase per scope, making on or off, approved brand model,
  scene permission, detection fails, batch limit runs out, newer delivery, Trendyol at its cap, a
  marketplace that takes no scene images, exit numbers hold, Advance time, theme and Reset.
- **Test guide**: the 30 scenarios and the feel questions of the plan, each with "Take me there" and
  a tick box (kept in the browser only).

Images are drawn stand-ins, not brand photos. Copy follows the specs' sentences; no model, vendor or
check name appears. Known shortcuts: plan counts come from a simplified planner over hand-written
sample data (which shots can be cut from which photo is part of the data); Ops scorecard numbers are
partly fixed sample values; scene and made-photo outcomes (pass, held, hard block) are set per sample
product.
