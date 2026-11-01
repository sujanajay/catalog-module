// loadSkuResolver against the per-query resolveSkus it replaces: the same result for every input, on rows
// that exercise every step, its normalisation and its tie order.
import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../db/client";
import { skuMap } from "../db/schema";
import { createDbFromPglite, createTestDb } from "../db/testing";
import { normalizeKey } from "./naming";
import { loadSkuResolver, parseManualMapping, RESOLVE_CHANNEL_KEYS, stripSizeSegment, type ResolveInput, type ResolveResult, type SkuMethod } from "./sku-mapping";

// --- The per-query version as it was on origin/main (8ba33d1), kept here as the reference --------------
const STRIP_RE = "[\\s_-]";
const SIZE_SEGMENT_RE = "_[^_]*$";
const normalizedSql = (expr: SQL): SQL => sql`upper(regexp_replace(${expr}, ${STRIP_RE}, '', 'g'))`;
const unique = (values: string[]) => [...new Set(values)];
const inValues = (values: string[]) => sql.join(values.map((v) => sql`${v}`), sql`, `);
async function firstOptionKey(db: Db, brandSlug: string, where: SQL): Promise<string | null> {
  const [row] = await db.select({ optionKey: skuMap.optionKey }).from(skuMap).where(and(eq(skuMap.brandSlug, brandSlug), where)).orderBy(asc(skuMap.opptraSku)).limit(1);
  return row?.optionKey ?? null;
}
async function optionResult(db: Db, brandSlug: string, optionKey: string, method: SkuMethod): Promise<ResolveResult> {
  const rows = await db.select({ opptraSku: skuMap.opptraSku, optionIdStyleColor: skuMap.optionIdStyleColor }).from(skuMap)
    .where(and(eq(skuMap.brandSlug, brandSlug), eq(skuMap.optionKey, optionKey))).orderBy(asc(skuMap.opptraSku));
  return { optionIdStyleColor: rows.find((r) => r.optionIdStyleColor)?.optionIdStyleColor ?? null, opptraSkuIds: rows.map((r) => r.opptraSku), method };
}
async function resolveSkusSql(db: Db, input: ResolveInput): Promise<ResolveResult> {
  const { brandSlug } = input;
  const idKey = normalizeKey(input.identifier.trim());
  const tryKey = async (where: SQL, method: SkuMethod) => {
    const key = await firstOptionKey(db, brandSlug, where);
    return key === null ? null : optionResult(db, brandSlug, key, method);
  };
  if (idKey) {
    const hit = await tryKey(eq(skuMap.optionKey, idKey), "option_key");
    if (hit) return hit;
  }
  const eans = unique([input.ean ? normalizeKey(input.ean.trim()) : "", idKey].filter(Boolean));
  if (eans.length) {
    const hit = await tryKey(sql`${skuMap.ean} IN (${inValues(eans)})`, "ean");
    if (hit) return hit;
  }
  const ids = unique([...(input.channelIds ?? []).map((c) => normalizeKey(c.trim())), idKey].filter(Boolean));
  if (ids.length) {
    const where = sql`EXISTS (SELECT 1 FROM jsonb_each_text(${skuMap.channelIds}) AS e(key, value)
      WHERE e.key IN (${inValues([...RESOLVE_CHANNEL_KEYS])})
      AND ${normalizedSql(sql`e.value`)} IN (${inValues(ids)}))`;
    const hit = await tryKey(where, "channel_id");
    if (hit) return hit;
  }
  if (idKey) {
    const strippedKey = normalizeKey(stripSizeSegment(input.identifier));
    const where = sql`(${normalizedSql(sql`regexp_replace(${skuMap.opptraSku}, ${SIZE_SEGMENT_RE}, '')`)} = ${strippedKey}
      OR ${normalizedSql(sql`${skuMap.opptraSku}`)} = ${idKey})`;
    const hit = await tryKey(where, "product_code");
    if (hit) return hit;
  }
  const manual = input.manual?.get(idKey);
  if (manual && manual.length) return { optionIdStyleColor: null, opptraSkuIds: unique(manual).sort(), method: "manual" };
  return { optionIdStyleColor: null, opptraSkuIds: [], method: "unresolved" };
}
// -----------------------------------------------------------------------------------------------------

let db: Db;
let close: () => Promise<void>;
const base = { brand: "USPA", brandSlug: "uspa", line: "softline" as const, source: "warehouse" as const };

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await db.insert(skuMap).values([
    // An option in three sizes, inserted out of order; only the middle size carries the option id.
    { ...base, opptraSku: "5F_NUPI_BLUE_OD_40", optionKey: "5FNUPIBLUEOD", optionIdStyleColor: null, ean: "8684626830440", channelIds: { child_zsku: "ZE7A-12" } },
    { ...base, opptraSku: "5F_NUPI_BLUE_OD_38", optionKey: "5FNUPIBLUEOD", optionIdStyleColor: null, ean: "8684626830429", channelIds: { child_zsku: "ZE7A-10", styli_ae_ksa: " 21 25_28-2903 " } },
    { ...base, opptraSku: "5F_NUPI_BLUE_OD_39", optionKey: "5FNUPIBLUEOD", optionIdStyleColor: "5F NUPI BLUE OD", ean: "8684626830436", channelIds: { child_zsku: "ZE7A-11" } },
    // Two options sharing an EAN, a channel id and a stripped code: the first by opptra_sku wins each tie.
    { ...base, opptraSku: "TIE_B_M", optionKey: "TIEB", optionIdStyleColor: "TIE B", ean: "4000000000001", channelIds: { amazon: "b0tie", noon_ae: "N-1" } },
    { ...base, opptraSku: "TIE_A_M", optionKey: "TIEA", optionIdStyleColor: "TIE A", ean: "4000000000001", channelIds: { amazon: "B0TIE", noon_sa: "n_1" } },
    { ...base, opptraSku: "TIE-A_L", optionKey: "TIEA2", optionIdStyleColor: "TIE A2", ean: null, channelIds: {} },
    // Not a resolution key: never matched by the channel step.
    { ...base, opptraSku: "NAMSHI_ONLY_S", optionKey: "NAMSHIONLY", optionIdStyleColor: "NAMSHI ONLY", ean: null, channelIds: { namshi_ae: "Z2798064B4D0C538FBD90Z" } },
    // Hardline codes without "_" (no size segment), with "-" and mixed case.
    { ...base, opptraSku: "BGIN-9235", optionKey: "BGIN9235OPT", optionIdStyleColor: "BGIN 9235", ean: "8690000000000", channelIds: { amazon_uae_ksa_asin: "B0DJF9L2JC" } },
    { ...base, opptraSku: "bgin 9236", optionKey: "BGIN9236OPT", optionIdStyleColor: null, ean: null, channelIds: { styli_sku: "sty 9236" } },
    // An option key that is itself an EAN of another row, and a size code with an empty last segment.
    { ...base, opptraSku: "EDGE_X_", optionKey: "8684626830429", optionIdStyleColor: "EDGE X", ean: null, channelIds: { amazon: "" } },
    { ...base, opptraSku: "_LEAD", optionKey: "LEADOPT", optionIdStyleColor: "LEAD", ean: null, channelIds: {} },
    // Another brand with colliding values: never returned for uspa.
    { brand: "Penti", brandSlug: "penti", line: "softline", source: "warehouse", opptraSku: "PENTI_X_OD_S", optionKey: "5FNUPIBLUEOD", optionIdStyleColor: "PENTI X OD", ean: "4000000000001", channelIds: { amazon: "B0TIE" } },
  ]);
});

afterAll(async () => {
  await close();
});

const manual = parseManualMapping([["identifier", "opptra_sku_id"], ["ABC-123", "M_2"], ["abc123", "M_1"], ["5F NUPI BLUE OD", "MANUAL_1"]]);
const inputs: Omit<ResolveInput, "brandSlug">[] = [
  // 1. option_key in every spelling: spaces, "_", "-", case, padding.
  { identifier: "5F NUPI BLUE OD" }, { identifier: "5f_nupi_blue_od" }, { identifier: " 5F-NUPI-BLUE-OD\t" }, { identifier: "5FNUPIBLUEOD", manual },
  // An option key that is also an EAN: step 1 wins.
  { identifier: "8684626830429" },
  // 2. ean, explicit or as the identifier; ties by opptra_sku; a padded explicit ean.
  { identifier: "IMG_1", ean: "8684626830436" }, { identifier: "IMG_1", ean: " 8684626830440 " }, { identifier: "4000000000001" },
  { identifier: "nothing", ean: "8690000000000" }, { identifier: "", ean: "8684626830436" },
  // 3. channel ids: normalised stored values, given ids plus the identifier, several keys, ties.
  { identifier: "2125282903" }, { identifier: "x", channelIds: ["ze7a_11"] }, { identifier: "x", channelIds: ["nope", " ZE7A-12 "] },
  { identifier: "B0TIE" }, { identifier: "b0-tie" }, { identifier: "x", channelIds: ["N 1"] }, { identifier: "N1" },
  { identifier: "B0DJF9L2JC" }, { identifier: "STY9236" }, { identifier: "Z2798064B4D0C538FBD90Z" },
  // 4. product codes: size stripped on both sides, the full code exactly, codes without "_", ties.
  { identifier: "5F_NUPI_BLUE_OD_42" }, { identifier: "5f nupi blue od_xl" }, { identifier: "TIE_A_XL" }, { identifier: "TIE-A_S" }, { identifier: "TIEA" },
  { identifier: "BGIN-9235" }, { identifier: "bgin9235" }, { identifier: "BGIN 9236" }, { identifier: "EDGE_X_ZZ" }, { identifier: "EDGE_X" },
  { identifier: "_LEAD" }, { identifier: "LEAD_9" }, { identifier: "_" }, { identifier: "a_" },
  // 5. manual, then unresolved; empty and blank identifiers.
  { identifier: "ABC_123", manual }, { identifier: "abc 123", manual }, { identifier: "NOPE999", manual }, { identifier: "NOPE999" },
  { identifier: "" }, { identifier: "   " }, { identifier: "-_-" },
];

describe("loadSkuResolver", () => {
  it("returns exactly what the per-query resolveSkus returned, for every step and edge case", async () => {
    const resolver = await loadSkuResolver(db, "uspa");
    expect(resolver.rows).toBe(11);
    const methods = new Set<string>();
    for (const input of inputs) {
      const want = await resolveSkusSql(db, { brandSlug: "uspa", ...input });
      methods.add(want.method);
      expect({ input, got: resolver.resolve(input) }).toEqual({ input, got: want });
    }
    // The inputs reach every step.
    expect([...methods].sort()).toEqual(["channel_id", "ean", "manual", "option_key", "product_code", "unresolved"]);
  });

  it("is restricted to its brand", async () => {
    const penti = await loadSkuResolver(db, "penti");
    for (const identifier of ["4000000000001", "B0TIE", "5FNUPIBLUEOD", "PENTI_X_OD_M"]) {
      expect(penti.resolve({ identifier })).toEqual(await resolveSkusSql(db, { brandSlug: "penti", identifier }));
    }
    expect(() => penti.resolve({ brandSlug: "uspa", identifier: "x" })).toThrow("holds penti");
  });

  it("resolves many products with one sku_map query", async () => {
    const queries: string[] = [];
    const { client } = await createTestDb();
    const logged = createDbFromPglite(client, { logger: { logQuery: (q) => queries.push(q) } }).db;
    await logged.insert(skuMap).values([{ ...base, opptraSku: "ONE_M", optionKey: "ONE", optionIdStyleColor: "ONE", ean: null, channelIds: {} }]);
    queries.length = 0;
    const resolver = await loadSkuResolver(logged, "uspa");
    for (let i = 0; i < 500; i++) resolver.resolve({ identifier: `MISS_${i}_M` });
    expect(resolver.resolve({ identifier: "ONE_XL" }).method).toBe("product_code");
    expect(queries.filter((q) => q.includes('"sku_map"'))).toHaveLength(1);
    await client.close();
  });
});
