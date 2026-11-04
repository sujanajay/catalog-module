import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { PHOTOROOM_EDIT_URL, PHOTOROOM_SEGMENT_URL, photoroomMatte, photoroomUpscale } from "./photoroom";

const png = (width: number, height: number) => sharp({create: {width, height, channels: 3, background: "white"}}).png().toBuffer();
const answer = (bytes: Buffer, status = 200) => new Response(new Uint8Array(bytes), {status});

describe("M3-S5 Photoroom overflow adapter (recorded answers; no paid call)", () => {
  it("cut-out: sends the photo with the key and channels=alpha, returns the mask of the sent size", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => answer(await png(40, 30)));
    const result = await photoroomMatte(await png(40, 30), {width: 40, height: 30}, 0.02, {fetch, env: {PHOTOROOM_API_KEY: "k"}});
    expect(result).toMatchObject({failure: null, costUsd: 0.02, calls: 1, value: {width: 40, height: 30}});
    expect(result.value!.alpha).toHaveLength(40 * 30);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(PHOTOROOM_SEGMENT_URL);
    expect(new Headers(init!.headers).get("x-api-key")).toBe("k");
    expect((init!.body as FormData).get("channels")).toBe("alpha");
  });
  it("cut-out: no key means no call; an error status or a wrong-size mask is a failure (M7-F2-R3)", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => answer(await png(41, 30)));
    expect(await photoroomMatte(await png(40, 30), {width: 40, height: 30}, 0.02, {fetch, env: {}})).toMatchObject({value: null, failure: {kind: "no_key"}, calls: 0, costUsd: 0});
    expect(fetch).not.toHaveBeenCalled();
    expect(await photoroomMatte(await png(40, 30), {width: 40, height: 30}, 0.02, {fetch, env: {PHOTOROOM_API_KEY: "k"}})).toMatchObject({value: null, failure: {kind: "wrong_size"}});
    for (const [status, kind] of [[402, "payment_required"], [403, "auth"], [429, "rate_limit"], [503, "server"]] as const) {
      const failing = vi.fn<typeof globalThis.fetch>(async () => new Response("{}", {status}));
      expect(await photoroomMatte(await png(40, 30), {width: 40, height: 30}, 0.02, {fetch: failing, env: {PHOTOROOM_API_KEY: "k"}})).toMatchObject({value: null, failure: {kind, status}, costUsd: 0});
    }
    const offline = vi.fn<typeof globalThis.fetch>(async () => { throw new TypeError("fetch failed"); });
    expect(await photoroomMatte(await png(40, 30), {width: 40, height: 30}, 0.02, {fetch: offline, env: {PHOTOROOM_API_KEY: "k"}})).toMatchObject({failure: {kind: "no_response"}});
  });
  it("upscale: asks ai.fast on the original image, checks the 4x answer and brings a 2x request to exactly 2x", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => answer(await png(160, 120)));
    const x2 = await photoroomUpscale(await png(40, 30), 2, 0.05, {fetch, env: {PHOTOROOM_API_KEY: "k"}});
    expect(x2).toMatchObject({failure: null, costUsd: 0.05, value: {width: 80, height: 60}});
    expect((await sharp(x2.value!.image).metadata())).toMatchObject({width: 80, height: 60});
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(PHOTOROOM_EDIT_URL);
    expect((init!.body as FormData).get("upscale.mode")).toBe("ai.fast");
    expect((init!.body as FormData).get("removeBackground")).toBe("false");
    expect(await photoroomUpscale(await png(40, 30), 4, 0.05, {fetch, env: {PHOTOROOM_API_KEY: "k"}})).toMatchObject({value: {width: 160, height: 120}});
    const wrong = vi.fn<typeof globalThis.fetch>(async () => answer(await png(100, 120)));
    expect(await photoroomUpscale(await png(40, 30), 2, 0.05, {fetch: wrong, env: {PHOTOROOM_API_KEY: "k"}})).toMatchObject({value: null, failure: {kind: "wrong_size"}});
  });
});
