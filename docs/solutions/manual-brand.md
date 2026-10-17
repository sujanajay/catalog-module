# Adding a brand that is not in the warehouse yet

The wizard's brand list comes from `brand_master` (`listBrandOptions` in
`packages/core/src/catalog/brands.ts`). It is filled every night by the `catalog-sync-master`
Cloud Scheduler job from the warehouse masters (`raw_gcc_dimensions.master_sl` and
`raw_gcc_dimensions.sku_master_sheet_hl` in BigQuery project `opptra-datawarehouse`). There is no
add-brand form; the wizard's help text says "Brand not in the list? Email sujan@opptra.com."

When a brand has no warehouse master yet (for example Anta or BHPC), the admin adds it by hand in
one of two ways. Both are safe to run twice.

## Option 1: SQL in Cloud SQL Studio

Open Cloud SQL Studio for instance `ila-pg` in project `image-links-agent`, database `catalog`,
and run (change the name, slug and line):

```sql
INSERT INTO brand_master (name, slug, line, source)
VALUES ('Anta', 'anta', 'softline', 'manual')
ON CONFLICT (slug) DO NOTHING;
```

- `slug` must be what the code would make from the name: lowercase, spaces turned into `_`, and
  only letters, digits, `.`, `_` and `-` kept (`brandSlug` in `packages/core/src/catalog/naming.ts`).
  "Vero Moda" becomes `vero_moda`. A wrong slug creates a second brand when the warehouse catches up.
- `line` is `softline` or `hardline`; anything else is rejected by the table's check constraint.

## Option 2: `addManualBrand` from a one-file script

`addManualBrand(db, { name, line, createdBy })` computes the slug itself and is idempotent on it.
Run a small script with the same connection settings as the `catalog-migrate` job (the
`DB_HOST`, `DB_NAME`, `DB_USER` env vars and the `DB_PASSWORD` mount of secret
`catalog-db-password`; never print the password):

```ts
import { addManualBrand } from "@catalog/core/catalog/brands";
import { closeDb, getDb } from "@catalog/core/db/client";

const brand = await addManualBrand(getDb(), { name: "Anta", line: "softline", createdBy: "sujan@opptra.com" });
console.log(brand);
await closeDb();
```

## What happens when the warehouse catches up

The nightly sync upserts `brand_master` by slug. A manual row whose slug now appears in the
warehouse is switched to `source = 'warehouse'`, takes the warehouse's name and line, and keeps
its id, so nothing that already points at the brand changes. Brands are never deleted by the sync.

## Warehouse mapping notes (master sync)

- `sku_map` holds one row per distinct, non-blank warehouse code (`product_code` for softline, `sku`
  for hardline). The raw masters have a few blank and repeated codes, so the row count is slightly
  below the raw 16,612 + 335 rows the spec quotes; the last row of a repeated code wins and the sync
  logs a warning with the count. The tier 3 test asserts every distinct code is present.
- Hardline marketplace ids are mapped onto the `channel_ids` keys (confirmed by the owner on
  2026-10-17): `noon_uae_ksa_marketplace_sku` -> `noon_ae`, `noon_uae_ksa_retail_sku` -> `noon_sa`,
  `trendyol_uae_ksa_id` -> `trendyol`, `styli_ksa_id` -> `styli_sku`.
