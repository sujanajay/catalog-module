# catalog-module

## What this is

Opptra lists brand products on GCC marketplaces (Noon, Namshi, Trendyol, Styli, Centrepoint,
6thStreet, VogaCloset, Amazon, Shein), and each marketplace has its own image rules. This module
turns a brand's product photos into marketplace-ready images for the channels the operator picks:
the product is cut out, placed on the channel's canvas with the channel's margins and background,
encoded to its size and weight limits, checked, and published as public links. HEIC photos
(the iPhone format) are converted automatically. The operator gets back one sheet with a column of
links per channel, ready to paste into marketplace templates, and, when a product list workbook was
uploaded, a filled copy of that workbook with the links and a status added on the right. It works
for every Opptra brand, hardline and softline, one brand per batch.

A product (one brand plus one style+colour identifier) owns its images. Its links are fixed the
first time it is processed and stay the same for life. Uploading the product again replaces the
pictures behind those links in place and removes the photos the new upload no longer has; the
Opptra SKU ids are attached to the product whenever they arrive and never appear in a link.
Marketplaces keep their own copy of each picture, so after a re-upload the operator re-submits
the changed products there; the sheet says which ones.

## Status

Planning. The specs in `docs/specs/` and the prototype in `docs/prototype/` exist; nothing is
built yet. Spec 01 (the prototype) is the one approval gate; building starts with spec 02.

## How the specs are executed

Open `docs/specs/<nn>-<slug>.md` and say "execute". The main session acts as the manager and
follows `docs/specs/00-execution-protocol.md`: worktree and branch, builder subagents, tests by
tier, review, PR, merge, deploy when the spec says so, and one closing report that ends "Ready for
the next spec". Specs run strictly in order. The index with one line per spec is
`docs/specs/README.md`.

## The prototype

`docs/prototype/catalog-prototype.html` is a clickable single-file prototype of the operator
experience, published at https://claude.ai/artifact/HL7t82VTQ1bRchziPwLySr (version 2). It is the
UI contract: spec 01 transcribes every screen, state and sentence from it, and specs 06 and 07
build what 01 records. See `docs/prototype/README.md` for the known differences the real UI
applies.

## Assumptions

- Same GCP project `image-links-agent` and region `asia-south1` as the earlier `image-links-agent`
  app. This repository is a fresh codebase; the earlier one is not imported as a package.
- The earlier app's Cloud SQL instance `ila-pg`, VPC `ila-vpc` with subnet `ila-subnet`, private
  bucket `image-links-agent-assets` and Artifact Registry repo `apps` are reused. A new database
  `catalog` and user `catalog_app` are created on `ila-pg`; a new public bucket
  `image-links-agent-public` holds the links.
- The earlier `ila-web` and `ila-worker` Cloud Run services are not touched. The new services are
  `catalog-web`, `catalog-worker` and `catalog-matting`.
- Sign-in is Google sign-in through Cloud Run IAP (Google-managed OAuth client, every
  `@opptra.com` account admitted, no console step); the app verifies the IAP JWT and applies roles
  admin, operator and viewer from its own `users` table.
- The operator's gcloud default project is a different one; every script pins
  `CLOUDSDK_CORE_PROJECT=image-links-agent` and never changes global gcloud config.

## Running tests

Node 22 and pnpm 9. From the repository root:

```
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
```

`pnpm test` runs the unit and PGlite integration tests (no database server needed). Real-data
tests run only with the flag: `REAL_DATA=1 pnpm test:real` (PowerShell:
`$env:REAL_DATA = "1"; pnpm test:real`). One package only: `pnpm vitest run packages/core`.

## Repository layout

```
apps/web/           Next.js 15 app behind IAP: wizard, batch, product and brand pages, People modal
apps/worker/        Node 20 worker: ingest, matte, render, QA, publish, finalize, sync, sweep
packages/core/      shared code: channels, naming, storage, schema, tasks, sheet writers
services/matting/   Python matting service (catalog-matting)
infra/*.sh          bootstrap.sh and deploy.sh, idempotent, gcloud only
docs/               SPEC.md, specs/, plans/, solutions/, prototype/, handover/
```

## Working rules

See `CLAUDE.md`. The short version: `docs/SPEC.md` is the source of truth, every infra change is
an idempotent script, secrets stay in Secret Manager, Supabase is read only, tests clean up only
under `catalog-test/`, nothing in GCP is deleted without asking, and no em dashes.
