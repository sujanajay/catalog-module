import { MASTER_HL_SQL, MASTER_SL_SQL, type BigQueryLike } from "@catalog/core/catalog/master-sync";
import type { Db } from "@catalog/core/db/client";
import { createTestDb } from "@catalog/core/db/testing";
import { GRAPH_MASTER_ATTRS_SQL, GRAPH_SALES_KEYS_SQL } from "@catalog/core/graph/key-sync";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { handleSyncMaster } from "./sync-master";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterAll(async () => {
  vi.restoreAllMocks();
  await close();
});

describe("handleSyncMaster", () => {
  const SL = [
    { product_code: "X_RED_M", option_id_style_color: "X RED", brand: "USPA", line: "softline", namshi_ae: "ZX" },
    { product_code: "X_RED_L", option_id_style_color: "X RED", brand: "USPA", line: "softline", namshi_ae: "ZX" },
  ];
  const master = (query: string) => (query === MASTER_HL_SQL ? [{ sku: "BGIN-9235", brand: "Bergner", line: "hardline" }] : query === MASTER_SL_SQL ? SL : null);

  it("answers 200 with synced:<brands>/<skus> and the graph sync's options and listings", async () => {
    const bq: BigQueryLike = {
      query: async ({ query }) => [master(query) ?? (query === GRAPH_MASTER_ATTRS_SQL ? [{ product_code: "X_RED_M", description_1: "X" }] : []), {}],
    };
    expect(await handleSyncMaster({ db, bq, env: {} }, {})).toEqual({ httpStatus: 200, outcome: "synced:2/3;graph:1/1" });
  });

  it("keeps the master sync's 200 when only the graph sync's BigQuery read fails", async () => {
    const bq: BigQueryLike = {
      query: async ({ query }) => {
        if (query === GRAPH_SALES_KEYS_SQL) throw new Error("403 access denied");
        return [master(query) ?? [{ product_code: "X_RED_M" }], {}];
      },
    };
    expect(await handleSyncMaster({ db, bq, env: {} }, {})).toEqual({ httpStatus: 200, outcome: "synced:2/3;graph:bigquery_unavailable" });
  });

  it("answers 503 on a BigQuery error so Cloud Scheduler retries", async () => {
    const bq: BigQueryLike = { query: async () => { throw new Error("503 backend error"); } };
    expect(await handleSyncMaster({ db, bq, env: {} }, {})).toEqual({ httpStatus: 503, outcome: "bigquery_unavailable" });
  });
});
