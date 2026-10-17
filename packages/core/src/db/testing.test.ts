import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTestDb } from "./testing";

describe("createTestDb", () => {
  it("opens an in-memory PGlite database with migrations applied", async () => {
    const { db, close } = await createTestDb();
    try {
      // Db is driver-agnostic, so execute() results are typed unknown; narrow them in the caller.
      const res = (await db.execute(sql`select 1 as one`)) as unknown as { rows: { one: number }[] };
      expect(res.rows[0]).toEqual({ one: 1 });
    } finally {
      await close();
    }
  });
});
