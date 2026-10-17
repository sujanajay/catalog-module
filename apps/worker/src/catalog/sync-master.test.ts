import { MASTER_HL_SQL, type BigQueryLike } from "@catalog/core/catalog/master-sync";
import type { Db } from "@catalog/core/db/client";
import { createTestDb } from "@catalog/core/db/testing";
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
  it("answers 200 with synced:<brands>/<skus>", async () => {
    const bq: BigQueryLike = {
      query: async ({ query }) =>
        query === MASTER_HL_SQL
          ? [[{ sku: "BGIN-9235", brand: "Bergner", line: "hardline" }], {}]
          : [[{ product_code: "X_RED_M", option_id_style_color: "X RED", brand: "USPA", line: "softline" }, { product_code: "X_RED_L", option_id_style_color: "X RED", brand: "USPA", line: "softline" }], {}],
    };
    expect(await handleSyncMaster({ db, bq, env: {} }, {})).toEqual({ httpStatus: 200, outcome: "synced:2/3" });
  });

  it("answers 503 on a BigQuery error so Cloud Scheduler retries", async () => {
    const bq: BigQueryLike = { query: async () => { throw new Error("503 backend error"); } };
    expect(await handleSyncMaster({ db, bq, env: {} }, {})).toEqual({ httpStatus: 503, outcome: "bigquery_unavailable" });
  });
});
