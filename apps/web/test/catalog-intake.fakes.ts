// Fakes for the intake browser harness (catalog-intake.server.ts). Nothing here talks to GCP, Google or
// a real image host: storage is a Map, the database is in-process PGlite, the image host answers only
// the fixture links.
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { createTestDb } from "@catalog/core/db/testing";

type PGlite = Awaited<ReturnType<typeof createTestDb>>["client"];

// --- In-memory storage --------------------------------------------------------------------------

export type StoredObject = { buf: Buffer; mime: string };
export type ObjectStore = Map<string, StoredObject>;

const notFound = (uri: string) => Object.assign(new Error(`harness: no object ${uri}`), { code: 404 });

/**
 * A `Storage`-shaped fake covering what packages/core/src/storage.ts uses on the private bucket.
 * Signed URLs point at the harness server (`/harness/put/...` and `/harness/obj/...`), so the browser's
 * direct upload and the step 2 thumbnails work on one origin. Copies to the public bucket are refused.
 */
export function fakeStorage(objects: ObjectStore, origin: string) {
  const file = (bucket: string, name: string) => {
    const uri = `gs://${bucket}/${name}`;
    const get = () => {
      const o = objects.get(uri);
      if (!o) throw notFound(uri);
      return o;
    };
    const slice = (buf: Buffer, opts?: { start?: number; end?: number }) => (opts?.start === undefined ? buf : buf.subarray(opts.start, (opts.end ?? buf.length - 1) + 1));
    return {
      name,
      async save(buf: Buffer | Uint8Array | string, opts?: { contentType?: string }) {
        objects.set(uri, { buf: Buffer.from(buf), mime: opts?.contentType ?? "application/octet-stream" });
      },
      async download(opts?: { start?: number; end?: number }) {
        return [slice(get().buf, opts)] as [Buffer];
      },
      async getMetadata() {
        const o = get();
        return [{ name, bucket, size: String(o.buf.length), contentType: o.mime, generation: "1" }] as const;
      },
      async exists() {
        return [objects.has(uri)] as [boolean];
      },
      async getSignedUrl(opts: { action: string }) {
        return [`${origin}/harness/${opts.action === "write" ? "put" : "obj"}/${bucket}/${name.split("/").map(encodeURIComponent).join("/")}`] as [string];
      },
      createReadStream(opts?: { start?: number; end?: number }) {
        const o = objects.get(uri);
        if (!o) {
          const r = new Readable({ read() {} });
          process.nextTick(() => r.destroy(notFound(uri)));
          return r;
        }
        return Readable.from([slice(o.buf, opts)]);
      },
      async setMetadata() {
        return [{}];
      },
      async delete() {
        objects.delete(uri);
        return [{}];
      },
      async copy() {
        throw new Error("harness: copies to the public bucket are not available");
      },
    };
  };
  return {
    bucket(bucket: string) {
      return {
        name: bucket,
        file: (name: string) => file(bucket, name),
        async getFiles(opts?: { prefix?: string }) {
          const start = `gs://${bucket}/${opts?.prefix ?? ""}`;
          return [[...objects.keys()].filter((u) => u.startsWith(start)).map((u) => file(bucket, u.slice(`gs://${bucket}/`.length)))];
        },
      };
    },
  };
}

// --- A node-postgres Pool backed by PGlite --------------------------------------------------------

type PgTypes = { getTypeParser(oid: number, format?: string): (value: string) => unknown };
type QueryConfig = { text: string; values?: unknown[]; rowMode?: string; types?: PgTypes };

/**
 * A `pg.Pool` stand-in over one PGlite instance, so the web app's own `getDb()` (drizzle node-postgres
 * over `RetryingPool extends pg.Pool`) runs unchanged against PGlite. PGlite is a single session, so a
 * checked-out client holds a lock until release (a drizzle transaction never interleaves with other
 * queries) and a pool query waits for it. Values are prepared and parsed the way node-postgres does.
 */
export function pgliteBackedPool(pglite: PGlite, pg: { types: PgTypes }, prepareValue: (v: unknown) => unknown) {
  let chain: Promise<void> = Promise.resolve();
  const lock = async (): Promise<() => void> => {
    let open!: () => void;
    const held = new Promise<void>((r) => (open = r));
    const before = chain;
    chain = chain.then(() => held);
    await before;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      open();
    };
  };
  const toText = (v: unknown) => (v instanceof Uint8Array ? `\\x${Buffer.from(v).toString("hex")}` : String(v));
  const serializers = new Proxy({}, { get: (_t, key) => (typeof key === "string" && /^\d+$/.test(key) ? toText : undefined) });
  async function run(config: string | QueryConfig, values?: unknown[]) {
    const cfg: QueryConfig = typeof config === "string" ? { text: config } : config;
    const params = (values ?? cfg.values ?? []).map((v) => (v === null || v === undefined ? null : prepareValue(v)));
    const getParser = cfg.types?.getTypeParser ?? pg.types.getTypeParser;
    const parsers = new Proxy({}, { get: (_t, key) => (typeof key === "string" && /^\d+$/.test(key) ? (value: string) => getParser(Number(key), "text")(value) : undefined) });
    const result = await pglite.query(cfg.text, params, { rowMode: cfg.rowMode === "array" ? "array" : "object", parsers, serializers });
    return { rows: result.rows, fields: result.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })), rowCount: result.affectedRows ?? result.rows.length, command: "" };
  }
  const client = (release: () => void) => ({ query: run, release, on() {}, removeListener() {} });
  return class HarnessPool extends EventEmitter {
    totalCount = 0;
    idleCount = 0;
    waitingCount = 0;
    constructor(_config?: unknown) {
      super();
    }
    async query(config: string | QueryConfig, values?: unknown[]) {
      const release = await lock();
      try {
        return await run(config, values);
      } finally {
        release();
      }
    }
    connect(): Promise<ReturnType<typeof client>>;
    connect(cb: (err: Error | undefined, c: ReturnType<typeof client> | undefined, done: () => void) => void): void;
    connect(cb?: (err: Error | undefined, c: ReturnType<typeof client> | undefined, done: () => void) => void) {
      const p = lock().then((release) => client(release));
      if (!cb) return p;
      p.then((c) => cb(undefined, c, c.release), (err: Error) => cb(err, undefined, () => {}));
    }
    async end() {}
  };
}

// --- Fake image host -----------------------------------------------------------------------------

/** The address every example.com host "resolves" to. Public, so safeFetch's checks pass; never connected to. */
export const FAKE_HOST_ADDRESS = "93.184.215.14";
/** The share-page host of intake-pasted-variants.txt: answers a web page. */
export const SHARE_PAGE_HOST = "www.dropbox.example.com";
/** A host that answers 404 to everything (browser scenario 3). */
export const MISSING_HOST = "missing.example.com";

const isExampleHost = (host: string) => host === "example.com" || host.endsWith(".example.com");

/** A DNS stand-in: example.com hosts resolve to FAKE_HOST_ADDRESS, every other name is not found. */
export async function fakeLookup(hostname: string): Promise<string[]> {
  if (isExampleHost(hostname)) return [FAKE_HOST_ADDRESS];
  throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND", hostname });
}

/**
 * Answers the fixture links (exact match after decoding, so a link with a literal space works either
 * way) with a distinct JPEG per link, after `delayMs()`; SHARE_PAGE_HOST answers a web page, and every
 * other URL (all of MISSING_HOST included) answers 404. It never touches the network.
 */
export function fakeImageHost(links: string[], delayMs: () => number, log: string[]) {
  const known = new Set(links.map((u) => decodeURI(u)));
  const cache = new Map<string, Buffer>();
  let n = 0;
  async function jpeg(url: string): Promise<Buffer> {
    let buf = cache.get(url);
    if (!buf) {
      const sharp = (await import("sharp")).default;
      const k = ++n;
      buf = await sharp({ create: { width: 1000, height: 1250, channels: 3, background: { r: (k * 37) % 256, g: (k * 91) % 256, b: (k * 53) % 256 } } }).jpeg({ quality: 70 }).toBuffer();
      cache.set(url, buf);
    }
    return buf;
  }
  const fetchImpl: typeof fetch = async (input) => {
    const raw = String(input instanceof Request ? input.url : input);
    const url = decodeURI(raw);
    const wait = delayMs();
    if (wait) await new Promise((r) => setTimeout(r, wait));
    if (new URL(raw).hostname === SHARE_PAGE_HOST) {
      log.push(`fetch web page ${url}`);
      return new Response("<!doctype html><html><body>Shared file</body></html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (!known.has(url)) {
      log.push(`fetch 404 ${url}`);
      return new Response("<Error>Not found</Error>", { status: 404, headers: { "content-type": "application/xml" } });
    }
    const buf = await jpeg(url);
    return new Response(new Uint8Array(buf), { status: 200, headers: { "content-type": "image/jpeg", "content-length": String(buf.length) } });
  };
  return fetchImpl;
}
