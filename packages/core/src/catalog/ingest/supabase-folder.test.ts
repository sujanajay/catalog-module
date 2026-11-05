// M1-F1-R4: Supabase folder links as a paste kind. A fake Storage client stands in for Supabase; the
// real client is checked against a fake fetch (read-only calls, key sent only to the project origin).
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BATCH_OPTIONS } from "../../db/schema";
import { detectPastedText } from "./detect";
import { groupItems } from "./group";
import {
  isReadCall, listSupabaseFolder, parseSupabaseFolderLink, readSupabaseFolder, SUPABASE_EMPTY, SUPABASE_LIST_CONCURRENCY, SUPABASE_MAX_FOLDERS, SUPABASE_SLICE_MS,
  SUPABASE_OFF, SUPABASE_OTHER_PROJECT, SUPABASE_PRIVATE, SUPABASE_TOO_LARGE, SUPABASE_UNREADABLE, supabaseFolderLinks, supabaseFolderText,
  supabaseStorageClient, type SupabaseListState, type SupabaseStorageLike,
} from "./supabase-folder";
import { parsePastedLinks, urlListItems } from "./url-list";

const ORIGIN = "https://projref.supabase.co";
const PUBLIC = `${ORIGIN}/storage/v1/object/public/softlines/anta`;
const SIGNED = `${ORIGIN}/storage/v1/object/sign/softlines/anta?token=eyJhbGciOi.test`;

/** A fake Storage client over a list of object paths in one bucket (sizes default to 50 KB). */
function fakeClient(paths: Record<string, number | undefined>, opts: { isPublic?: boolean; origin?: string; failList?: boolean } = {}) {
  const calls: string[] = [];
  const client: SupabaseStorageLike = {
    origin: opts.origin ?? ORIGIN,
    async isPublic(bucket) { calls.push(`bucket ${bucket}`); return opts.isPublic ?? true; },
    async list(bucket, prefix, offset, limit) {
      calls.push(`list ${bucket} ${prefix} ${offset}`);
      if (opts.failList) throw new Error("Supabase list answered 500");
      const under = Object.keys(paths).filter((p) => p.startsWith(`${prefix}/`)).map((p) => p.slice(prefix.length + 1));
      const names = [...new Set(under.map((p) => p.split("/")[0]!))].sort();
      return names.slice(offset, offset + limit).map((name) => {
        const full = `${prefix}/${name}`;
        return full in paths ? { name, id: `id-${full}`, metadata: { size: paths[full] ?? 50_000 } } : { name, id: null, metadata: null };
      });
    },
  };
  return { client, calls };
}

describe("Supabase folder links (M1-F1-R4)", () => {
  it("parses public and signed folder links, and leaves object links to the image-links paste", () => {
    expect(parseSupabaseFolderLink(PUBLIC)).toEqual({ origin: ORIGIN, host: "projref.supabase.co", bucket: "softlines", prefix: "anta" });
    expect(parseSupabaseFolderLink(`${PUBLIC}/`)).toMatchObject({ prefix: "anta" });
    expect(parseSupabaseFolderLink(SIGNED)).toMatchObject({ bucket: "softlines", prefix: "anta" });
    expect(parseSupabaseFolderLink(`${ORIGIN}/storage/v1/object/public/softlines/My%20Brand/AW26`)).toMatchObject({ prefix: "My Brand/AW26" });
    expect(parseSupabaseFolderLink(`${PUBLIC}/ABC_1.jpg`)).toBeNull();
    expect(parseSupabaseFolderLink("https://evil.example.com/storage/v1/object/public/a/b")).toBeNull();
    expect(detectPastedText(PUBLIC, { supabaseFolders: true })).toEqual({ kind: "supabase_folder", ids: [PUBLIC] });
    expect(detectPastedText(`${PUBLIC}/ABC_1.jpg`, { supabaseFolders: true })?.kind).toBe("url_list");
    expect(supabaseFolderLinks(`${PUBLIC}\n${PUBLIC}/ABC_1.jpg`)).toEqual([PUBLIC]);
  });

  it("lists sub-folders, skips placeholders and dotfiles, and pages through long folders", async () => {
    const paths: Record<string, number | undefined> = {
      "anta/ZSKU1/1.jpg": undefined, "anta/ZSKU1/2.jpg": undefined, "anta/ZSKU2/1.jpg": undefined,
      "anta/ZSKU2/.emptyFolderPlaceholder": 0, "anta/ZSKU3/tiny.jpg": 300,
    };
    for (let i = 0; i < 1005; i++) paths[`anta/Many/P${String(i).padStart(4, "0")}_1.jpg`] = undefined;
    const { client, calls } = fakeClient(paths);
    const listed = await listSupabaseFolder(client, parseSupabaseFolderLink(PUBLIC)!);
    if (!listed.done) throw new Error("not listed in one request");
    expect(listed.files).toHaveLength(1008);
    expect(listed.skipped).toBe(1);
    expect(listed.truncated).toBe(false);
    expect(calls).toContain("list softlines anta/Many 1000");
    expect(calls.every((c) => c.startsWith("list") || c.startsWith("bucket"))).toBe(true);
  });

  it("a folder per product becomes `<folder>\\t<url>` lines that group by folder name", async () => {
    const { client } = fakeClient({ "anta/ZSKU1/front.jpg": undefined, "anta/ZSKU1/back.jpg": undefined, "anta/ZSKU2/front.jpg": undefined });
    const read = await readSupabaseFolder(client, SIGNED);
    expect(read).toMatchObject({ ok: true, url: PUBLIC, mode: "folder", photos: 3, title: "Supabase folder softlines/anta", message: "Supabase folder softlines/anta: 3 photos in 2 folders, grouped by folder name." });
    if (!read.ok) throw new Error("not read");
    expect(read.text.split("\n")[0]).toBe(`ZSKU1\t${ORIGIN}/storage/v1/object/public/softlines/anta/ZSKU1/back.jpg`);
    const g = groupItems(urlListItems(parsePastedLinks(read.text), "u1"), { ...DEFAULT_BATCH_OPTIONS, perRoot: true });
    expect([...g.products].map(([id, items]) => [id, items.length])).toEqual([["ZSKU1", 2], ["ZSKU2", 1]]);
  });

  it("a flat folder keeps bare links named by file, and numbered shots take their folder's name", () => {
    const link = parseSupabaseFolderLink(PUBLIC)!;
    const flat = supabaseFolderText(link, [{ path: "ABC1_1.jpg", size: 9e4 }, { path: "ABC1_2.jpg", size: 9e4 }, { path: "Mixed/1.jpg", size: 9e4 }]);
    expect(flat.mode).toBe("filename");
    expect(flat.text).toBe([`${PUBLIC}/ABC1_1.jpg`, `${PUBLIC}/ABC1_2.jpg`, `Mixed\t${PUBLIC}/Mixed/1.jpg`].join("\n"));
  });

  it("a folder that is itself one product (view-named photos directly inside) is named by that folder", () => {
    const link = parseSupabaseFolderLink(`${PUBLIC}/ZSKU100`)!;
    const one = supabaseFolderText(link, [{ path: "back.jpg", size: 9e4 }, { path: "front.jpg", size: 9e4 }]);
    expect(one.mode).toBe("folder");
    expect(one.text).toBe([`ZSKU100\t${PUBLIC}/ZSKU100/back.jpg`, `ZSKU100\t${PUBLIC}/ZSKU100/front.jpg`].join("\n"));
    const g = groupItems(urlListItems(parsePastedLinks(one.text), "u1"), { ...DEFAULT_BATCH_OPTIONS, perRoot: true });
    expect([...g.products].map(([id, items]) => [id, items.length])).toEqual([["ZSKU100", 2]]);
  });

  it("a folder with more sub-folders than the cap answers a sentence instead of reading without end", async () => {
    // The folder holds as many sub-folders as the cap, plus itself: one folder more than the cap.
    const folders = Array.from({ length: SUPABASE_MAX_FOLDERS }, (_, i) => ({ name: `F${String(i).padStart(5, "0")}`, id: null, metadata: null }));
    const wide: SupabaseStorageLike = {
      origin: ORIGIN,
      async isPublic() { return true; },
      async list(_bucket, prefix, offset, limit) {
        return prefix === "anta" ? folders.slice(offset, offset + limit) : [{ name: "A_1.jpg", id: "x", metadata: { size: 9e4 } }];
      },
    };
    // One request with all the time it needs, then the same folder carried on over short requests (a clock that ticks per look).
    expect(await readSupabaseFolder(wide, PUBLIC, { sliceMs: 1e9 })).toEqual({ ok: false, error: SUPABASE_TOO_LARGE });
    let state: SupabaseListState | undefined;
    let tick = 0;
    let requests = 0;
    for (;;) {
      requests++;
      const read = await readSupabaseFolder(wide, PUBLIC, { state, sliceMs: 2000, now: () => tick++ });
      if (!read.ok && read.reading) { state = read.state; continue; }
      expect(read).toEqual({ ok: false, error: SUPABASE_TOO_LARGE });
      expect(requests).toBeGreaterThan(1);
      break;
    }
  });

  it("answers a plain sentence instead of reading when it cannot or must not", async () => {
    expect(await readSupabaseFolder(null, PUBLIC)).toEqual({ ok: false, error: SUPABASE_OFF });
    expect(await readSupabaseFolder(fakeClient({}, { origin: "https://other.supabase.co" }).client, PUBLIC)).toEqual({ ok: false, error: SUPABASE_OTHER_PROJECT });
    expect(await readSupabaseFolder(fakeClient({ "anta/A_1.jpg": undefined }, { isPublic: false }).client, PUBLIC)).toEqual({ ok: false, error: SUPABASE_PRIVATE });
    expect(await readSupabaseFolder(fakeClient({}).client, PUBLIC)).toEqual({ ok: false, error: SUPABASE_EMPTY });
    expect(await readSupabaseFolder(fakeClient({}, { failList: true }).client, PUBLIC)).toEqual({ ok: false, error: SUPABASE_UNREADABLE });
  });

  it("the real client sends only list and bucket reads, with the key, to the project origin", async () => {
    const seen: { url: string; method: string; key: string | null; body: string | null }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      seen.push({ url, method: init.method ?? "GET", key: headers.get("apikey"), body: (init.body as string | undefined) ?? null });
      if (url.endsWith("/bucket/softlines")) return Response.json({ id: "softlines", public: true });
      return Response.json([{ name: "A_1.jpg", id: "x", metadata: { size: 5000 } }]);
    }) as unknown as typeof fetch;
    const client = supabaseStorageClient(`${ORIGIN}/`, "test-key", fakeFetch);
    expect(await readSupabaseFolder(client, PUBLIC)).toMatchObject({ ok: true, photos: 1 });
    expect(seen.map((s) => [s.method, s.url])).toEqual([["GET", `${ORIGIN}/storage/v1/bucket/softlines`], ["POST", `${ORIGIN}/storage/v1/object/list/softlines`]]);
    expect(seen.every((s) => s.key === "test-key")).toBe(true);
    expect(JSON.parse(seen[1]!.body!)).toMatchObject({ prefix: "anta", offset: 0, limit: 1000 });
  });

  it("the real client is read only: no write, upload, move or delete call can be reached (Supabase is never written)", async () => {
    const seen: string[] = [];
    const fakeFetch = (async (url: string, init: RequestInit = {}) => { seen.push(`${init.method ?? "GET"} ${url}`); return Response.json([]); }) as unknown as typeof fetch;
    const client = supabaseStorageClient(ORIGIN, "test-key", fakeFetch);
    // Only the two reads exist on the client, and it cannot be extended.
    expect(Object.keys(client).sort()).toEqual(["isPublic", "list", "origin"]);
    expect(Object.isFrozen(client)).toBe(true);
    expect(() => { (client as unknown as Record<string, unknown>).remove = () => undefined; }).toThrow();
    for (const name of ["upload", "update", "remove", "move", "copy", "createSignedUrl", "from", "delete"]) expect(name in client).toBe(false);
    // The request guard allows the two read paths and nothing else.
    expect(isReadCall("POST", "/storage/v1/object/list/softlines")).toBe(true);
    expect(isReadCall("GET", "/storage/v1/bucket/softlines")).toBe(true);
    for (const [method, path] of [
      ["POST", "/storage/v1/object/softlines/anta/A_1.jpg"], ["PUT", "/storage/v1/object/softlines/anta/A_1.jpg"],
      ["DELETE", "/storage/v1/object/softlines"], ["DELETE", "/storage/v1/object/softlines/anta/A_1.jpg"],
      ["POST", "/storage/v1/object/move"], ["POST", "/storage/v1/object/copy"], ["POST", "/storage/v1/object/sign/softlines/anta"],
      ["POST", "/storage/v1/bucket"], ["PUT", "/storage/v1/bucket/softlines"], ["DELETE", "/storage/v1/bucket/softlines"],
      ["POST", "/storage/v1/object/list/softlines/../x"], ["GET", "/storage/v1/object/list/softlines"],
      ["POST", "/storage/v1/object/list/.."], ["POST", "/storage/v1/object/list/."], ["GET", "/storage/v1/bucket/%2E%2e"],
    ]) expect(isReadCall(method!, path!), `${method} ${path}`).toBe(false);
    // A bucket name cannot smuggle another path in: it is encoded into one segment.
    await client.list("softlines/../../bucket", "", 0, 1);
    expect(seen).toEqual([`POST ${ORIGIN}/storage/v1/object/list/softlines%2F..%2F..%2Fbucket`]);
  });
});

// R1 exit finding 1: a whole brand folder (softlines/vero-moda, 477 product folders) did not fit the old serial
// 45 s listing. A fake Storage client with a fixed delay per list call (about 200 ms was measured against the
// brand photo store) and fake timers stand in for Supabase, so a minute of listing runs in well under a second.
describe("large Supabase folders (R1 exit finding 1)", () => {
  afterEach(() => { vi.useRealTimers(); });
  const LATENCY_MS = 200;

  /** A brand folder of `count` product folders with two photos each, answering every list call after LATENCY_MS. */
  function brandFolder(count: number) {
    const products = Array.from({ length: count }, (_, i) => `P${String(i).padStart(5, "0")}`);
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    const client: SupabaseStorageLike = {
      origin: ORIGIN,
      async isPublic() { return true; },
      async list(_bucket, prefix, offset, limit) {
        calls++;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, LATENCY_MS));
        inFlight--;
        if (prefix === "brand") return products.slice(offset, offset + limit).map((name) => ({ name, id: null, metadata: null }));
        return offset ? [] : [{ name: "back.jpg", id: `${prefix}/b`, metadata: { size: 9e4 } }, { name: "front.jpg", id: `${prefix}/f`, metadata: { size: 9e4 } }];
      },
    };
    return { client, products, stats: () => ({ maxInFlight, calls }) };
  }

  /** Runs one request under fake timers and gives its answer and how long it took in fake time. */
  async function timed<T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> {
    const started = Date.now();
    let value: { v: T } | null = null;
    let error: unknown = null;
    work().then((v) => { value = { v }; }, (err: unknown) => { error = err; });
    while (!value && !error) await vi.advanceTimersByTimeAsync(20);
    if (error) throw error;
    return { value: (value as unknown as { v: T }).v, ms: Date.now() - started };
  }

  const LINK = `${ORIGIN}/storage/v1/object/public/softlines/brand`;

  it("500 product folders are listed in parallel and read in one short request", async () => {
    vi.useFakeTimers();
    const { client, stats } = brandFolder(500);
    const { value: read, ms } = await timed(() => readSupabaseFolder(client, LINK));
    expect(read).toMatchObject({ ok: true, mode: "folder", photos: 1000 });
    // Serially, 501 calls of 200 ms take 100 s (the old 45 s deadline failed); 16 at a time take about 7 s.
    expect(stats()).toEqual({ maxInFlight: SUPABASE_LIST_CONCURRENCY, calls: 501 });
    expect(ms).toBeLessThan(10_000);
  });

  it("5,000 product folders are read over several requests, each inside the slice, and every photo comes back once", async () => {
    vi.useFakeTimers();
    const { client, products, stats } = brandFolder(5000);
    let state: SupabaseListState | undefined;
    const requests: number[] = [];
    let done: Awaited<ReturnType<typeof readSupabaseFolder>> | null = null;
    while (!done) {
      const { value: read, ms } = await timed(() => readSupabaseFolder(client, LINK, { state }));
      requests.push(ms);
      expect(read.ok || read.reading, JSON.stringify(read).slice(0, 200)).toBe(true);
      if (!read.ok && read.reading) {
        expect(read.message).toMatch(/^Reading Supabase folder softlines\/brand: [\d,]+ photos in [\d,]+ folders so far\.$/);
        // The state is stored as jsonb between requests.
        state = JSON.parse(JSON.stringify(read.state)) as SupabaseListState;
      } else done = read;
    }
    // About 63 s of listing at 16 at a time: three requests, none longer than the slice and one call in flight.
    expect(requests.length).toBeGreaterThanOrEqual(3);
    for (const ms of requests) expect(ms).toBeLessThanOrEqual(SUPABASE_SLICE_MS + LATENCY_MS * 5);
    expect(stats().maxInFlight).toBe(SUPABASE_LIST_CONCURRENCY);
    // One call per product folder, and six root pages (the fifth is full, so a sixth comes back empty).
    expect(stats().calls).toBe(5000 + 6);
    if (!done.ok) throw new Error("not read");
    expect(done.photos).toBe(10_000);
    const lines = done.text.split("\n");
    expect(new Set(lines).size).toBe(10_000);
    expect(new Set(lines.map((line) => line.split("\t")[0]))).toEqual(new Set(products));
    expect(done.message).toBe("Supabase folder softlines/brand: 10,000 photos in 5,000 folders, grouped by folder name.");
  });

  it("each request starts at least one folder, so a listing always moves forward", async () => {
    const { client } = fakeClient({ "anta/A/1.jpg": undefined, "anta/B/1.jpg": undefined });
    const link = parseSupabaseFolderLink(PUBLIC)!;
    let listed = await listSupabaseFolder(client, link, { sliceMs: -1 });
    let requests = 1;
    while (!listed.done) {
      listed = await listSupabaseFolder(client, link, { state: listed.state, sliceMs: -1 });
      requests++;
    }
    expect(requests).toBe(3);
    expect(listed.files.map((f) => f.path)).toEqual(["A/1.jpg", "B/1.jpg"]);
  });
});
