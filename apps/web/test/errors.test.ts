import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { badRequest, errorResponse, handle, HttpError, notFound, readJson } from "../lib/errors";

describe("web errors", () => {
  it("turns HttpError into its status and message", async () => {
    const res = errorResponse(notFound("Batch"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Batch not found" });
    expect(badRequest("nope")).toBeInstanceOf(HttpError);
  });

  it("turns ZodError into a 400 naming the field", async () => {
    let err: unknown;
    try {
      z.object({ name: z.string() }).parse({ name: 1 });
    } catch (e) {
      err = e;
    }
    const res = errorResponse(err);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: unknown[] };
    expect(body.error).toMatch(/^name: /);
    expect(body.issues).toHaveLength(1);
  });

  it("turns anything else into a 500 and logs it", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await handle(async () => {
      throw new Error("boom");
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "boom" });
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it("readJson rejects an invalid body with 400", async () => {
    const req = new Request("http://x/", { method: "POST", body: "{not json" });
    await expect(readJson(req)).rejects.toMatchObject({ status: 400, message: "Invalid JSON body" });
    const ok = new Request("http://x/", { method: "POST", body: '{"a":1}' });
    expect(await readJson(ok)).toEqual({ a: 1 });
  });
});
