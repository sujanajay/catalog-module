// M1-F1-R4: Supabase folder links as a paste kind. A fake Storage client stands in for Supabase; the
// real client is checked against a fake fetch (read-only calls, key sent only to the project origin).
import { describe, expect, it } from "vitest";
import { DEFAULT_BATCH_OPTIONS } from "../../db/schema";
import { detectPastedText } from "./detect";
import { groupItems } from "./group";
import {
  listSupabaseFolder, parseSupabaseFolderLink, readSupabaseFolder, SUPABASE_EMPTY, SUPABASE_OFF, SUPABASE_OTHER_PROJECT,
  SUPABASE_PRIVATE, SUPABASE_UNREADABLE, supabaseFolderLinks, supabaseFolderText, supabaseStorageClient, type SupabaseStorageLike,
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
    expect(detectPastedText(PUBLIC)).toEqual({ kind: "supabase_folder", ids: [PUBLIC] });
    expect(detectPastedText(`${PUBLIC}/ABC_1.jpg`)?.kind).toBe("url_list");
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
    expect(listed.files).toHaveLength(1008);
    expect(listed.skipped).toBe(1);
    expect(listed.truncated).toBe(false);
    expect(calls).toContain("list softlines anta/Many 1000");
    expect(calls.every((c) => c.startsWith("list") || c.startsWith("bucket"))).toBe(true);
  });

  it("a folder per product becomes `<folder>\\t<url>` lines that group by folder name", async () => {
    const { client } = fakeClient({ "anta/ZSKU1/front.jpg": undefined, "anta/ZSKU1/back.jpg": undefined, "anta/ZSKU2/front.jpg": undefined });
    const read = await readSupabaseFolder(client, SIGNED);
    expect(read).toMatchObject({ ok: true, mode: "folder", photos: 3, title: "Supabase folder softlines/anta", message: "Supabase folder softlines/anta: 3 photos in 2 folders, grouped by folder name." });
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
});
