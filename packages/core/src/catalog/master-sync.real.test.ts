// Tier 3 (REAL_DATA=1 pnpm test:real): syncMaster against the real warehouse with Application
// Default Credentials, into an in-memory PGlite database. Read only on BigQuery; writes nothing to
// GCS, Cloud SQL or Supabase.
import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Db } from "../db/client";
import { brandMaster, skuMap } from "../db/schema";
import { createTestDb } from "../db/testing";
import { MASTER_HL_SQL, MASTER_SL_SQL, createBigQuery, syncMaster, type BigQueryLike, type SyncResult } from "./master-sync";
import { brandSlug } from "./naming";
import { resolveSkus } from "./sku-mapping";

const REAL = process.env.REAL_DATA === "1";

const SOFTLINE = ["USPA", "French Connection", "Campus", "Penti", "Nautica", "Vero Moda", "Keds", "Cardio Bunny", "Puma"];
const HARDLINE = ["Bergner", "Carote", "Nutricook", "NutriBullet", "GTPlayer", "Tower", "Dowinx", "Qubo", "Nuwey"];

// Raw row counts of the two masters when the spec was written. sku_map is keyed by opptra_sku, so
// it holds the distinct non-blank codes; the warehouse has a few blank and repeated codes, which
// the test counts from the rows themselves.
const SL_RAW_ROWS = 16_612;
const HL_RAW_ROWS = 335;

const IAM_HELP =
  "The ADC account cannot read the warehouse. Grant it (as an opptra-datawarehouse admin):\n" +
  "  gcloud projects add-iam-policy-binding opptra-datawarehouse --member=user:<you> --role=roles/bigquery.jobUser\n" +
  "  bq add-iam-policy-binding --member=user:<you> --role=roles/bigquery.dataViewer opptra-datawarehouse:raw_gcc_dimensions\n" +
  "  bq add-iam-policy-binding --member=user:<you> --role=roles/bigquery.dataViewer opptra-datawarehouse:dimensions\n" +
  "  bq add-iam-policy-binding --member=user:<you> --role=roles/bigquery.dataViewer opptra-datawarehouse:fact_gcc\n" +
  "then re-run `gcloud auth application-default login`.";

describe.skipIf(!REAL)("master sync against the real warehouse", () => {
  let db: Db;
  let close: () => Promise<void>;
  let result: SyncResult;
  let slRows: Record<string, unknown>[] = [];
  let hlRows: Record<string, unknown>[] = [];

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    const real = await createBigQuery(process.env);
    // Record what BigQuery returns so the assertions can compare against the raw rows.
    const recording: BigQueryLike = {
      query: async (options) => {
        const res = await real.query(options);
        if (options.query === MASTER_SL_SQL) slRows = res[0];
        if (options.query === MASTER_HL_SQL) hlRows = res[0];
        return res;
      },
    };
    try {
      result = await syncMaster(db, recording, process.env);
    } catch (err) {
      throw new Error(`${err instanceof Error ? err.message : String(err)}\n${IAM_HELP}`, { cause: err });
    }
    console.log(JSON.stringify({ sync: result, slRows: slRows.length, hlRows: hlRows.length }));
  });

  afterAll(async () => {
    await close?.();
  });

  test("reads every warehouse row", () => {
    expect(slRows.length).toBeGreaterThanOrEqual(SL_RAW_ROWS);
    expect(hlRows.length).toBeGreaterThanOrEqual(HL_RAW_ROWS);
  });

  test("named softline and hardline brands are present with the right line", async () => {
    const brands = await db.select().from(brandMaster).orderBy(asc(brandMaster.slug));
    const bySlug = new Map(brands.map((b) => [b.slug, b]));
    for (const name of SOFTLINE) expect(bySlug.get(brandSlug(name))?.line, name).toBe("softline");
    for (const name of HARDLINE) expect(bySlug.get(brandSlug(name))?.line, name).toBe("hardline");
    for (const b of brands) expect(b.source).toBe("warehouse");
    console.log(JSON.stringify({ brands: brands.map((b) => `${b.name} (${b.line})`) }));
  });

  test("sku_map holds every distinct warehouse code", async () => {
    const codes = new Set<string>();
    for (const r of slRows) if (r.product_code && String(r.product_code).trim()) codes.add(String(r.product_code).trim());
    for (const r of hlRows) if (r.sku && String(r.sku).trim()) codes.add(String(r.sku).trim());
    const n = ((await db.execute(sql`select count(*)::int as n from sku_map`)) as unknown as { rows: { n: number }[] }).rows[0]!.n;
    console.log(JSON.stringify({ skuMapRows: n, distinctCodes: codes.size, rawRows: slRows.length + hlRows.length, warnings: result.warnings }));
    expect(n).toBe(codes.size);
    expect(n).toBe(result.skus);
    // Within the blank and repeated codes of the raw masters (16,612 + 335 raw rows).
    expect(n).toBeGreaterThan((SL_RAW_ROWS + HL_RAW_ROWS) * 0.97);
  });

  test("resolveSkus for the first USPA option returns several per-size SKUs by option_key", async () => {
    const [first] = await db
      .select({ option: skuMap.optionIdStyleColor })
      .from(skuMap)
      .where(sql`${skuMap.brandSlug} = 'uspa' AND ${skuMap.optionIdStyleColor} IS NOT NULL
        AND ${skuMap.optionKey} IN (SELECT option_key FROM sku_map WHERE brand_slug = 'uspa' GROUP BY option_key HAVING count(*) > 1)`)
      .orderBy(asc(skuMap.opptraSku))
      .limit(1);
    expect(first?.option).toBeTruthy();
    const r = await resolveSkus(db, { brandSlug: "uspa", identifier: first!.option! });
    console.log(JSON.stringify({ uspaOption: first!.option, resolved: r }));
    expect(r.method).toBe("option_key");
    expect(r.opptraSkuIds.length).toBeGreaterThan(1);
    const sizes = await db.select({ sku: skuMap.opptraSku }).from(skuMap).where(eq(skuMap.optionIdStyleColor, first!.option!));
    expect(r.opptraSkuIds).toEqual(sizes.map((s) => s.sku).sort());
  });
});

test.skipIf(REAL)("master sync real test (set REAL_DATA=1 to run)", () => {});
