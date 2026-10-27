// Local browser harness for the intake scenarios (spec 14 section 8.3, created by release A).
// One Node process runs: the real Next.js app in dev mode (real pages, real route handlers, the real
// wizard bundle), an in-process PGlite database behind the app's own pg pool, in-memory storage behind
// the app's own Storage client, a fake queue that runs the real runIngest (as the worker would), and a
// fake image host for the example.com fixture links. Google is disabled (no credentials, no client).
// Nothing here can reach GCP: DATABASE_URL points at a closed port, storage never leaves the Map, and
// TASKS_INLINE sends tasks to this server. Nothing here reaches an image host either: the worker side
// gets the fake fetch and lookup as deps, and the web tier's POST /links (the paste readback) gets the
// same fake through next.config.ts's INTAKE_HARNESS alias of `undici` (catalog-intake.undici.ts) and
// a DNS lookup that answers example.com hosts itself.
//
// Started by test/catalog-intake.config.ts (Playwright webServer). By hand, from apps/web:
//   pnpm exec tsx test/catalog-intake.server.ts      (then open http://127.0.0.1:3417/catalog/new)
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import dnsPromises from "node:dns/promises";
import { fakeImageHost, fakeLookup, fakeStorage, pgliteBackedPool, type ObjectStore } from "./catalog-intake.fakes";

const WEB_DIR = path.resolve(__dirname, "..");
const ROOT = path.resolve(WEB_DIR, "../..");
export const HARNESS_PORT = Number(process.env.INTAKE_PORT || 3417);
const ORIGIN = `http://127.0.0.1:${HARNESS_PORT}`;
const FIXTURES = path.join(ROOT, "packages/core/test-fixtures/catalog/intake");
const OPERATOR = "operator@opptra.com";
const ADMIN = "admin@opptra.com";

// The app reads these at request time. Set before anything from the app is loaded.
Object.assign(process.env, {
  SKIP_IAP: "1", // honoured only outside production; this server always runs Next in dev mode
  DEV_USER_EMAIL: OPERATOR,
  BUCKET: "harness-private",
  PUBLIC_BUCKET: "harness-public",
  // Never connected: the pg Pool is replaced by the PGlite-backed pool below. If that ever failed,
  // the app would fail on a closed local port, never on a real database.
  DATABASE_URL: "postgres://harness:harness@127.0.0.1:1/harness",
  TASKS_INLINE: "1",
  WORKER_URL: `${ORIGIN}/harness/worker`,
  SHARE_SA_EMAIL: "catalog-reader@example.iam.gserviceaccount.com",
  NEXT_TELEMETRY_DISABLED: "1",
  INTAKE_HARNESS: "1", // next.config.ts: the server bundle's undici is catalog-intake.undici.ts
});
for (const key of ["GOOGLE_APPLICATION_CREDENTIALS", "DB_HOST", "TASKS_INGEST_QUEUE", "IAP_AUDIENCE"]) delete process.env[key];

/**
 * The fake queue and image host settings; the tests change them through POST /harness/queue, which
 * answers with them plus `pending` (held deliveries) and `running` (deliveries in progress).
 */
const queue = { delayMs: 1000, fetchDelayMs: 50, budgetItems: 40, paused: false, running: 0, pending: [] as Record<string, unknown>[] };
const workerLog: string[] = [];
/** A worker line: kept for GET /harness/log and printed with the server output. */
const note = (line: string) => {
  workerLog.push(line);
  console.log(`[harness] ${line}`);
};
const objects: ObjectStore = new Map();

async function main() {
  // 1. Database: PGlite with every migration, Test Brand and an operator.
  const { createTestDb } = await import("@catalog/core/db/testing");
  const { client: pglite, db: seedDb } = await createTestDb();
  const { brandMaster } = await import("@catalog/core/db/schema");
  const { seedAdmin, upsertPerson } = await import("@catalog/core/people");
  await seedAdmin(seedDb, ADMIN);
  await upsertPerson(seedDb, { email: OPERATOR, role: "operator", addedBy: ADMIN });
  await seedDb.insert(brandMaster).values({ slug: "test_brand", name: "Test Brand", line: "softline", source: "manual" });

  // 2. Swap the external pg Pool and the Storage client the app's server bundle loads (both are
  //    serverExternalPackages, so Next requires the same module instances as this process).
  const coreRequire = createRequire(path.join(ROOT, "packages/core/package.json"));
  const pg = coreRequire("pg");
  const { prepareValue } = coreRequire("pg/lib/utils");
  const HarnessPool = pgliteBackedPool(pglite, pg, prepareValue);
  pg.Pool = HarnessPool;
  const fake = fakeStorage(objects, ORIGIN);
  const cjsStorage = coreRequire.resolve("@google-cloud/storage");
  const esmStorage = cjsStorage.replace(/([\\/])build\1cjs\1/, "$1build$1esm$1");
  const builds = [coreRequire("@google-cloud/storage"), await import(pathToFileURL(esmStorage).href)] as { Storage: { prototype: { bucket: unknown } } }[];
  for (const build of builds) build.Storage.prototype.bucket = function bucket(name: string) { return fake.bucket(name); };

  // 3. The worker side: the real runIngest over the same pool and storage.
  const storage = await import("@catalog/core/storage");
  storage.setStorageClient(fake as never);
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const schema = await import("@catalog/core/db/schema");
  const workerDb = drizzle(new HarnessPool() as never, { schema }) as never;
  const { runIngest } = await import("@catalog/core/catalog/ingest/index");
  // The fixture links: every link of the large sheet (the xlsx links are its first 6 rows) and of the
  // two pasted fixtures.
  const fixture = (name: string) => readFileSync(path.join(FIXTURES, name), "utf8").trim().split(/\r?\n/);
  const links = [
    ...fixture("intake-large-sheet.csv").slice(1).flatMap((line) => line.split(",").slice(1).filter(Boolean)),
    ...["intake-pasted-grid.txt", "intake-pasted-variants.txt"].flatMap(fixture).flatMap((line) => line.split("\t")).flatMap((cell) => cell.split(/ (?=https?:\/\/)/)).filter((cell) => /^https?:\/\//.test(cell)),
  ];
  const imageFetch = fakeImageHost(links, () => queue.fetchDelayMs, workerLog);
  // The web tier (POST /links) reaches the same fake host: the aliased undici reads it from here, and
  // its DNS check gets fakeLookup's answer for example.com hosts (the only hosts the scenarios use).
  (globalThis as Record<symbol, unknown>)[Symbol.for("catalog.intakeHarness.imageHost")] = imageFetch;
  const systemLookup = dnsPromises.lookup;
  dnsPromises.lookup = (async (hostname: string, options?: { all?: boolean }) => {
    if (hostname === "localhost") return systemLookup(hostname, options as never);
    const [address] = await fakeLookup(hostname);
    return options?.all ? [{ address, family: 4 }] : { address, family: 4 };
  }) as typeof dnsPromises.lookup;
  const deliver = (body: Record<string, unknown>) => {
    if (queue.paused) return void queue.pending.push(body);
    // A delivery whose wait ends while the queue is held waits with the others.
    setTimeout(() => (queue.paused ? void queue.pending.push(body) : void runTask(body)), queue.delayMs);
  };
  async function runTask(body: Record<string, unknown>) {
    const t0 = Date.now();
    queue.running++;
    try {
      const enqueue = async (_route: string, next: Record<string, unknown>) => (deliver(next), "harness-task");
      const r = await runIngest(workerDb, { storage, fetch: imageFetch, lookup: fakeLookup, enqueue: enqueue as never, budgetItems: queue.budgetItems }, body as { batchId: string; uploadId: string; cursor?: string });
      note(`ingest ${String(body.uploadId).slice(0, 8)} ${Date.now() - t0} ms: ${r.outcome}`);
    } catch (err) {
      note(`ingest ERROR ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      queue.running--;
    }
  }

  // 4. Next.js in dev mode, in this process.
  const next = (await import("next")).default;
  const app = next({ dev: true, dir: WEB_DIR, hostname: "127.0.0.1", port: HARNESS_PORT });
  const handle = app.getRequestHandler();
  await app.prepare();

  let ready = false;
  const server = createServer((req, res) => void route(req, res));
  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", ORIGIN);
    try {
      if (!url.pathname.startsWith("/harness/")) return void (await handle(req, res));
      if (url.pathname === "/harness/health") return send(res, ready ? 200 : 503, { ready });
      if (url.pathname === "/harness/queue" && req.method === "POST") {
        const patch = JSON.parse((await bodyOf(req)).toString() || "{}") as Partial<typeof queue>;
        for (const key of ["delayMs", "fetchDelayMs", "budgetItems", "paused"] as const) if (patch[key] !== undefined) Object.assign(queue, { [key]: patch[key] });
        if (!queue.paused) queue.pending.splice(0).forEach(deliver);
        return send(res, 200, { ...queue, pending: queue.pending.length });
      }
      if (url.pathname === "/harness/log") return send(res, 200, { worker: workerLog });
      if (url.pathname.startsWith("/harness/worker/") && req.method === "POST") {
        const body = JSON.parse((await bodyOf(req)).toString() || "{}") as Record<string, unknown>;
        if (url.pathname === "/harness/worker/tasks/catalog/ingest") deliver(body);
        else note(`task ${url.pathname} ignored by the harness`);
        return send(res, 200, { ok: true });
      }
      const object = /^\/harness\/(put|obj)\/([^/]+)\/(.+)$/.exec(url.pathname);
      if (object) {
        const uri = `gs://${object[2]}/${object[3]!.split("/").map(decodeURIComponent).join("/")}`;
        if (object[1] === "put" && req.method === "PUT") {
          objects.set(uri, { buf: await bodyOf(req), mime: String(req.headers["content-type"] ?? "application/octet-stream") });
          return send(res, 200, {});
        }
        const o = objects.get(uri);
        if (!o) return send(res, 404, { error: "harness: no such object" });
        res.writeHead(200, { "content-type": o.mime, "content-length": o.buf.length });
        return void res.end(o.buf);
      }
      send(res, 404, { error: "harness: no such route" });
    } catch (err) {
      console.error("[harness]", err);
      if (!res.headersSent) send(res, 500, { error: String(err) });
    }
  }
  server.on("upgrade", app.getUpgradeHandler());
  await new Promise<void>((r) => server.listen(HARNESS_PORT, "127.0.0.1", r));
  console.log(`[harness] listening on ${ORIGIN}; compiling the pages and routes the scenarios use`);
  await warmUp(true);
  ready = true;
  console.log("[harness] ready");
  // next dev disposes a compiled entry after a minute without requests (onDemandEntries.maxInactiveAge); keep them all in use.
  setInterval(() => void warmUp(false), 30_000).unref();
}

/** next dev compiles each page and route on its first request; do it now so a scenario's 2 s bound measures the app, not the compiler. */
async function warmUp(verbose: boolean) {
  const none = "00000000-0000-4000-8000-000000000000";
  const api = `/api/catalog/batches/${none}`;
  const hits: [string, string][] = [
    ["GET", "/catalog"], ["GET", "/catalog/new"], ["GET", `/catalog/${none}`],
    ["POST", "/api/catalog/batches"], ["GET", api], ["PATCH", api], ["POST", `${api}/uploads`], ["POST", `${api}/uploads/${none}/complete`],
    ["POST", `${api}/links`], ["POST", `${api}/ingest`], ["GET", `${api}/detected`], ["PATCH", `${api}/detected`], ["GET", `${api}/preview`],
    ["PATCH", `${api}/links/${none}`], ["DELETE", `${api}/links/${none}`], ["DELETE", `${api}/uploads/${none}`], ["POST", `${api}/retry-links`],
  ];
  for (const [method, p] of hits) {
    const t0 = Date.now();
    const r = await fetch(ORIGIN + p, { method, headers: { "content-type": "application/json" }, body: method === "GET" ? undefined : "{}" }).catch((err: unknown) => ({ status: String(err) }));
    if (verbose) console.log(`[harness] warm ${method} ${p} -> ${r.status} (${Date.now() - t0} ms)`);
  }
}

function bodyOf(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

main().catch((err) => {
  console.error("[harness] failed to start", err);
  process.exit(1);
});
