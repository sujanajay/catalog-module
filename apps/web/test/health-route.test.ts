import { describe, expect, it } from "vitest";
import { GET } from "../app/health/route";

describe("GET /health", () => {
  it("answers 200 with {ok: true} as JSON", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ ok: true });
  });
});
