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
