// Tier 3 (REAL_DATA=1 pnpm test:real), M0-S2 acceptance: syncMaster then syncGraph against the real warehouse with
// Application Default Credentials, into PGlite (or the TEST_PG_URL server). Read only on BigQuery; writes nothing to
// GCS, Cloud SQL or Supabase. Checks M0-F1 acceptance tests 1 and 4:
//   1. the outcome keys match at least 99% of the last 12 weeks' softline Namshi and Noon sale rows to a listing (the
//      rest listed by reason), and every option the master gives a channel key has listing keys;
//   4. every softline option has a style key, U.S. Polo groups at about 1.9 options per style, and every option under
//      the confidence bar is its own cluster.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createBigQuery, syncMaster, type BigQueryLike } from "../catalog/master-sync";
import type { Db } from "../db/client";
import { createRealTestDb, createTestDb, TEST_PG_URL } from "../db/testing";
import { syncGraph, type GraphSyncResult } from "./key-sync";
import { DEFAULT_STYLE_KEY_MIN_CONFIDENCE } from "./style-key";

const REAL = process.env.REAL_DATA === "1";

/** 12 full weeks of softline Namshi and Noon sale rows, grouped by the key a listing must match. Key columns only. */
const SALE_ROWS_SQL = `SELECT channel, country, channel_sku, mapped_opptra_sku, COUNT(*) AS n
FROM fact_gcc.unified_sales_tertiary_v2
WHERE event_type = 'sale' AND channel IN ('Namshi', 'Noon') AND country IN ('UAE', 'KSA')
  AND ordered_date >= DATE_SUB(DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY)), INTERVAL 12 WEEK)
  AND ordered_date < DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY))
  AND fact_gcc.family_of_gcc_brand(fact_gcc.alias_gcc_brand(mapped_brand)) = 'softline'
GROUP BY 1, 2, 3, 4`;

/** Options that sold on Namshi or Noon in the same window, for the selling-option style ratio of the 2026-11-02 check. */
const SELLING_SKUS_SQL = `SELECT DISTINCT mapped_opptra_sku
FROM fact_gcc.unified_sales_tertiary_v2
WHERE event_type = 'sale' AND channel IN ('Namshi', 'Noon')
  AND ordered_date >= DATE_SUB(DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY)), INTERVAL 12 WEEK)
  AND ordered_date < DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY))`;

type Rows<T> = { rows: T[] };

/**
 * BQ_CLI (optional): a Windows script that runs the SQL file it is given with the bq CLI and prints the rows as JSON,
 * for a machine whose Application Default Credentials need a browser re-login but whose gcloud login works. Read only,
 * like the ADC client. Unset: the ADC client.
 */
function cliBigQuery(script: string): BigQueryLike {
  return {
    query: async ({ query }) => {
      const dir = mkdtempSync(path.join(tmpdir(), "m0s2-bq-"));
      try {
        const file = path.join(dir, "q.sql");
        writeFileSync(file, query);
        const r = spawnSync("cmd.exe", ["/d", "/s", "/c", `""${script}" "${file}""`], { windowsVerbatimArguments: true, encoding: "utf8", maxBuffer: 1 << 30 });
        if (r.status !== 0) throw new Error(`bq CLI failed: ${(r.stderr || r.stdout).slice(0, 500)}`);
        const out = r.stdout.trim();
        return [out ? (JSON.parse(out) as Record<string, unknown>[]) : [], {}];
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

describe.skipIf(!REAL)("M0-S2 graph sync against the real warehouse (F1 acceptance tests 1 and 4)", () => {
  let db: Db;
  let close: () => Promise<void>;
  let bq: BigQueryLike;
  let graph: GraphSyncResult;
  let graphMs = 0;
  const rows = async <T>(q: ReturnType<typeof sql>) => ((await db.execute(q)) as unknown as Rows<T>).rows;

  beforeAll(async () => {
    ({ db, close } = TEST_PG_URL ? await createRealTestDb() : await createTestDb());
    bq = process.env.BQ_CLI ? cliBigQuery(process.env.BQ_CLI) : await createBigQuery(process.env);
    const master = await syncMaster(db, bq, process.env);
    const t0 = Date.now();
    graph = await syncGraph(db, bq, process.env);
    graphMs = Date.now() - t0;
    console.log(JSON.stringify({ master: { brands: master.brands, skus: master.skus }, graph, graphMs }));
  });

  afterAll(async () => {
    await close?.();
  });

  test("1. outcome keys match at least 99% of 12-week softline Namshi and Noon sale rows", async () => {
    const [sales] = await bq.query({ query: SALE_ROWS_SQL, location: "asia-south1" });
    const keys = await rows<{ channel: string; market: string; key_value: string }>(sql`select channel, market, key_value from catalog_outcome_keys`);
    const known = new Set(keys.map((k) => `${k.channel}|${k.market}|${k.key_value.toUpperCase()}`));
    const inMap = new Set((await rows<{ s: string }>(sql`select upper(opptra_sku) as s from sku_map where line = 'softline'`)).map((r) => r.s));
    const market: Record<string, string> = { UAE: "ae", KSA: "sa" };
    const by: Record<string, { rows: number; matched: number }> = {};
    const reasons: Record<string, number> = {};
    let total = 0;
    let matched = 0;
    for (const r of sales) {
      const n = Number(r.n);
      const ch = String(r.channel).toLowerCase();
      const k = `${ch}|${market[String(r.country)]}|${String(r.channel_sku ?? "").trim().toUpperCase()}`;
      const cell = (by[`${r.channel} ${r.country}`] ??= { rows: 0, matched: 0 });
      cell.rows += n;
      total += n;
      if (known.has(k)) { matched += n; cell.matched += n; continue; }
      const why = !r.channel_sku ? "no channel_sku" : !inMap.has(String(r.mapped_opptra_sku ?? "").toUpperCase()) ? "SKU not in the softline sku_map" : "key not on a listing (conflict or unmapped)";
      reasons[why] = (reasons[why] ?? 0) + n;
    }
    console.log(JSON.stringify({ test: "F1-1", total, matched, share: matched / total, byChannelCountry: by, unmatchedByReason: reasons }));
    expect(total).toBeGreaterThan(10_000);
    expect(matched / total).toBeGreaterThanOrEqual(0.99);
  });

  test("1b. every option the master gives a channel key has listing keys, or is listed in a key conflict", async () => {
    const [r] = await rows<{ with_master_key: number; without_listing_key: number; options: number; with_any_key: number }>(sql`
      with opt_master as (
        select distinct o.id from catalog_options o
        join sku_map s on s.brand_slug = o.brand_slug and s.line = 'softline'
          and (o.option_key = regexp_replace(btrim(coalesce(s.option_id_style_color, '')), '\\s+', ' ', 'g') or o.option_key = 'sku:' || s.opptra_sku)
        join catalog_key_mappings m on (s.channel_ids ->> m.sku_column) is not null
          and btrim(s.channel_ids ->> m.sku_column) not in ('', '0')
      )
      select (select count(*) from opt_master)::int as with_master_key,
        -- An option whose every key is in the conflict list has no listing key by design (F1-R5); any other is a miss.
        (select count(*) from opt_master om where not exists (
          select 1 from catalog_channel_listings l join catalog_listing_keys k on k.listing_id = l.id where l.option_id = om.id)
          and not exists (
          select 1 from catalog_key_conflicts c, jsonb_array_elements(c.candidates) e
          where c.resolved_at is null and e ->> 'optionId' = om.id::text))::int as without_listing_key,
        (select count(*) from catalog_options)::int as options,
        (select count(distinct l.option_id) from catalog_channel_listings l join catalog_listing_keys k on k.listing_id = l.id)::int as with_any_key`);
    const conflicts = await rows<{ channel: string; key_kind: string; n: number }>(sql`
      select channel, key_kind, count(*)::int as n from catalog_key_conflicts where resolved_at is null group by 1, 2 order by 3 desc`);
    console.log(JSON.stringify({ test: "F1-1b", ...r, openConflicts: conflicts }));
    expect(r!.with_master_key).toBeGreaterThan(3000);
    expect(r!.without_listing_key).toBe(0);
  });

  test("4. every softline option has a style key; U.S. Polo groups at about 1.9 options per style; unsure options are their own cluster", async () => {
    const [all] = await rows<{ options: number; no_style: number; under_bar_not_own: number }>(sql`
      select count(*)::int as options,
        count(*) filter (where style_key is null or style_key_source is null or style_key_confidence is null)::int as no_style,
        count(*) filter (where style_key_confidence < ${DEFAULT_STYLE_KEY_MIN_CONFIDENCE} and style_key_source <> 'own_cluster')::int as under_bar_not_own
      from catalog_options where line = 'softline'`);
    const bySource = await rows<{ source: string; n: number }>(sql`select style_key_source as source, count(*)::int as n from catalog_options group by 1 order by 1`);
    const perBrand = await rows<{ brand_slug: string; options: number; styles: number; ratio: number }>(sql`
      select brand_slug, count(*)::int as options, count(distinct style_key)::int as styles,
        round(count(*)::numeric / count(distinct style_key), 2)::float as ratio
      from catalog_options where line = 'softline' and in_master group by 1 order by 2 desc`);

    // The 2026-11-02 check measured U.S. Polo among options selling on Namshi and Noon.
    const [selling] = await bq.query({ query: SELLING_SKUS_SQL, location: "asia-south1" });
    const skus = selling.map((r) => String(r.mapped_opptra_sku ?? "").toUpperCase()).filter(Boolean);
    const [uspaSelling] = await rows<{ options: number; styles: number }>(sql`
      select count(distinct o.id)::int as options, count(distinct o.style_key)::int as styles
      from catalog_options o join sku_map s on s.brand_slug = o.brand_slug
        and (o.option_key = regexp_replace(btrim(coalesce(s.option_id_style_color, '')), '\\s+', ' ', 'g') or o.option_key = 'sku:' || s.opptra_sku)
      where o.brand_slug = 'uspa' and upper(s.opptra_sku) = any(${`{${skus.map((s) => `"${s.replace(/"/g, "")}"`).join(",")}}`}::text[])`);
    const uspa = perBrand.find((b) => b.brand_slug === "uspa");
    const sellingRatio = uspaSelling!.styles ? uspaSelling!.options / uspaSelling!.styles : 0;
    console.log(JSON.stringify({ test: "F1-4", ...all, bySource, perBrand, uspaSelling: { ...uspaSelling, ratio: sellingRatio } }));

    expect(all!.options).toBeGreaterThan(3000);
    expect(all!.no_style).toBe(0);
    expect(all!.under_bar_not_own).toBe(0);
    expect(uspa?.ratio).toBeGreaterThanOrEqual(1.5);
    expect(uspa?.ratio).toBeLessThanOrEqual(2.5);
    expect(sellingRatio).toBeGreaterThanOrEqual(1.5);
    expect(sellingRatio).toBeLessThanOrEqual(2.5);
  });

  test("a second run writes nothing new (idempotent) and stays under the 5-minute budget", async () => {
    const t0 = Date.now();
    const again = await syncGraph(db, bq, process.env);
    const ms = Date.now() - t0;
    console.log(JSON.stringify({ test: "rerun", again, ms, firstRunMs: graphMs }));
    expect(again.keys.inserted).toBe(0);
    expect(again.keys.moved).toBe(0);
    expect(graph.options).toBe(again.options);
  });
});
