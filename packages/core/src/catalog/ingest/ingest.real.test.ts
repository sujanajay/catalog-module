// Tier 3 (REAL_DATA=1 pnpm test:real): the ingest against the real private bucket with Application
// Default Credentials, an in-memory PGlite database and the real image sets on the tester's
// machine. Every object is written under a test batch's prefix `catalog-test/<brand>/<batchId>/`
// (runIngest derives the prefix from the batch) and that prefix is deleted in `finally` with
// deleteTestObjects; a final listObjects must be empty. Continuations run inline (no Cloud Tasks).
// Supabase links are only read (GET); nothing is written outside catalog-test/.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Db } from "../../db/client";
import { catalogBatches, catalogSourceImages, catalogUploads, type CatalogBatch, type CatalogUpload } from "../../db/schema";
import { createTestDb } from "../../db/testing";
import * as storage from "../../storage";
import { buildZip } from "../../../test-fixtures/catalog/ingest-a/builders";
import { batchPrefix, parseShotName } from "../naming";
import type { UploadKind } from "../types";
import { collectGoogleSheetOnWeb, googleClients, googleSheetAdapter, GOOGLE_SCOPES } from "./google-sheet";
import { buildPreview, runIngest } from "./index";
import { cellUrls, detectColumns, linksSheetAdapter, readSheetTable, urlFileName } from "./links-sheet";
import { uploadObjectPath } from "./local-files";
import type { CollectInput, IngestDeps, SheetsLike } from "./types";

const REAL = process.env.REAL_DATA === "1";
const DATA = process.env.REAL_DATA_DIR ?? "C:\\Users\\Sujan AH\\Desktop\\opptra-image-links";
const ANTA_DIR = path.join(DATA, "new_resources_4", "Images");
const FC_DIR = path.join(DATA, "new_resources_3", "French Connection Final");
const LINKS_DIR = path.join(DATA, "new_resources_3");
const CLI = fileURLToPath(new URL("../../../../../apps/worker/dist/catalog-local.js", import.meta.url));

let db: Db;
let close: () => Promise<void>;
const fetches: string[] = [];
const recordingFetch: typeof fetch = async (input, init) => {
  fetches.push(`${init?.method ?? "GET"} ${String(input).split("?")[0]}`);
  return fetch(input, init);
};
const deps: IngestDeps & { enqueue: never } = { storage, fetch: recordingFetch, enqueue: undefined as never };

async function newBatch(brandSlug: string, name: string): Promise<CatalogBatch> {
  const [b] = await db
    .insert(catalogBatches)
    .values({ brandSlug, brandName: brandSlug.toUpperCase(), name, isTest: true, createdBy: "tier3@opptra.com", channels: [] })
    .returning();
  return b!;
}
const prefixOf = (b: CatalogBatch) => batchPrefix(b.brandSlug, b.id, b.isTest);
const gs = (p: string) => storage.toGsUri(storage.getBucketName(), p);

async function newUpload(batch: CatalogBatch, kind: UploadKind, name: string, gcsUri: string): Promise<string> {
  const [u] = await db.insert(catalogUploads).values({ batchId: batch.id, kind, name, gcsUri, status: "uploaded" }).returning();
  return u!.id;
}

/** runIngest for every upload of the batch, its continuations run inline. */
async function ingest(batch: CatalogBatch): Promise<void> {
  const uploads = await db.select().from(catalogUploads).where(eq(catalogUploads.batchId, batch.id));
  for (const u of uploads) {
    const queue: { batchId: string; uploadId: string; cursor?: string }[] = [{ batchId: batch.id, uploadId: u.id }];
    while (queue.length) {
      const body = queue.shift()!;
      const enqueue = (async (_route: string, next: Record<string, unknown>) => {
        queue.push(next as { batchId: string; uploadId: string; cursor: string });
        return "inline";
      }) as unknown as typeof deps.enqueue;
      const r = await runIngest(db, { ...deps, enqueue }, body);
      console.log(`ingest ${u.name}: ${r.outcome}`);
    }
  }
}

/** Deletes the batch's prefix and checks nothing is left. */
async function cleanup(batch: CatalogBatch): Promise<void> {
  const prefix = `${prefixOf(batch)}/`;
  const deleted = await storage.deleteTestObjects(gs(prefix));
  console.log(`deleted ${deleted} objects under ${prefix}`);
  expect(await storage.listObjects(gs(prefix))).toEqual([]);
}

async function imageFiles(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await imageFiles(dir, r)));
    else if (/\.(jpe?g|png|heic|webp)$/i.test(e.name)) out.push(r);
  }
  return out.sort();
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (next < items.length) await fn(items[next++]!);
  }));
}

describe.skipIf(!REAL)("ingest against the real bucket and image sets", () => {
  beforeAll(async () => {
    process.env.BUCKET ??= "image-links-agent-assets";
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => {
    await close?.();
  });

  test.skipIf(!existsSync(ANTA_DIR))("Anta zip: 630 source images, no rejects", async () => {
    const batch = await newBatch("anta", "tier3 anta zip");
    try {
      const files = await imageFiles(ANTA_DIR);
      expect(files).toHaveLength(630);
      const zip = buildZip(await Promise.all(files.map(async (f) => ({ path: `Images/${f}`, data: await readFile(path.join(ANTA_DIR, f)) }))));
      const zipUri = await storage.uploadBuffer(`${prefixOf(batch)}/uploads/zip/Images.zip`, zip, "application/zip");
      const uploadId = await newUpload(batch, "zip", "Images.zip", zipUri);
      await ingest(batch);

      const [upload] = await db.select().from(catalogUploads).where(eq(catalogUploads.id, uploadId));
      expect(upload!.status).toBe("collected");
      expect((upload!.detected as { rejected: unknown[] }).rejected).toEqual([]);
      const rows = await db.select().from(catalogSourceImages).where(eq(catalogSourceImages.batchId, batch.id));
      expect(rows).toHaveLength(630);
      await mapLimit(rows, 16, async (r) => {
        expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
        const head = await storage.headObject(r.rawUri);
        expect(head).toMatchObject({ exists: true, contentType: "image/jpeg" });
      });
    } finally {
      await cleanup(batch);
    }
  });

  test.skipIf(!existsSync(FC_DIR))("French Connection folder: 3,280 sources, then the same set again matches every product as existing", async () => {
    const files = await imageFiles(FC_DIR);
    expect(files).toHaveLength(3280);
    const first = await newBatch("french-connection", "tier3 fc first");
    const second = await newBatch("french-connection", "tier3 fc second");
    try {
      for (const batch of [first, second]) {
        const [u] = await db.insert(catalogUploads).values({ batchId: batch.id, kind: "image", name: "French Connection Final", status: "uploaded" }).returning();
        // The browser PUT, replaced by uploadBuffer to the same object paths.
        await mapLimit(files, 16, async (f) => {
          await storage.uploadBuffer(uploadObjectPath(prefixOf(batch), u!.id, `French Connection Final/${f}`), await readFile(path.join(FC_DIR, f)), "image/jpeg");
        });
        await db.update(catalogUploads).set({ gcsUri: gs(`${prefixOf(batch)}/uploads/${u!.id}/`) }).where(eq(catalogUploads.id, u!.id));
        await ingest(batch);
      }
      const firstRows = await db.select().from(catalogSourceImages).where(eq(catalogSourceImages.batchId, first.id));
      expect(firstRows).toHaveLength(3280);
      const preview1 = await buildPreview(db, first.id, { storage });
      expect(preview1.rows.every((r) => r.status === "ok" && r.shots >= 1)).toBe(true);
      expect(preview1.warnings.map((w) => w.headline).some((h) => h.includes("two files for the same shot number"))).toBe(false);
      console.log(`French Connection: ${preview1.kpis.products} products, ${preview1.kpis.photos} photos`);

      const preview2 = await buildPreview(db, second.id, { storage });
      expect(preview2.overwrite.newProducts).toBe(0);
      expect(preview2.overwrite.existingProducts).toHaveLength(preview1.kpis.products);
      expect(preview2.overwrite.existingProducts.every((p) => p.shotsToRemove.length === 0)).toBe(true);
    } finally {
      await cleanup(first);
      await cleanup(second);
    }
  });

  test.skipIf(!existsSync(LINKS_DIR))("pasted Supabase links: the first 20 URLs of a delivery sheet, GET only", async () => {
    const sheets = (await readdir(LINKS_DIR)).filter((f) => /\.xlsx$/i.test(f)).sort();
    expect(sheets.length).toBeGreaterThan(0);
    const table = await readSheetTable(await readFile(path.join(LINKS_DIR, sheets[0]!)), sheets[0]!);
    const d = detectColumns(table);
    const seen = new Set<string>();
    const urls: string[] = [];
    for (const row of table.rows) {
      for (const c of d.urlColumns) {
        for (const url of cellUrls(row[c])) {
          const p = parseShotName(urlFileName(url));
          const key = `${p.identifier}#${p.n}`;
          if (urls.length < 20 && !seen.has(key)) {
            seen.add(key);
            urls.push(url);
          }
        }
      }
    }
    expect(urls).toHaveLength(20);
    const batch = await newBatch("uspa", "tier3 supabase links");
    try {
      const listUri = await storage.uploadBuffer(`${prefixOf(batch)}/uploads/links/urls.txt`, Buffer.from(urls.join("\n")), "text/plain");
      await newUpload(batch, "url_list", "urls.txt", listUri);
      fetches.length = 0;
      await ingest(batch);
      const rows = await db.select().from(catalogSourceImages).where(eq(catalogSourceImages.batchId, batch.id));
      expect(rows).toHaveLength(20);
      expect(new Set(rows.map((r) => r.originalName))).toEqual(new Set(urls.map(urlFileName)));
      expect(fetches.length).toBeGreaterThanOrEqual(20);
      expect(fetches.every((f) => f.startsWith("GET "))).toBe(true);
    } finally {
      await cleanup(batch);
    }
  });

  test("shared Google Sheet read as catalog-web@ equals the links-sheet adapter on the same xlsx", async (ctx) => {
    const url = process.env.REAL_GSHEET_URL;
    const xlsx = process.env.REAL_GSHEET_XLSX;
    if (!url || !xlsx) {
      console.log("skipped: set REAL_GSHEET_URL (a sheet shared with catalog-web@image-links-agent.iam.gserviceaccount.com as Viewer) and REAL_GSHEET_XLSX (the xlsx it was made from).");
      ctx.skip();
      return;
    }
    const batch = await newBatch("uspa", "tier3 google sheet");
    try {
      const { sheets } = await googleClients();
      const upload = { id: randomUUID(), batchId: batch.id, kind: "google_sheet", name: url, sourceUrl: url, gcsUri: null, detected: null } as unknown as CatalogUpload;
      const input: CollectInput = { batchId: batch.id, brandSlug: batch.brandSlug, prefix: prefixOf(batch), upload, options: batch.options, deps: { ...deps, sheets } };
      const detected = await collectGoogleSheetOnWeb(input);
      expect(detected).not.toHaveProperty("error");
      console.log(`Google Sheet read: ${(detected as { message: string }).message}`);
      const fromGoogle = await googleSheetAdapter.collect(input);

      const xlsxUri = await storage.uploadBuffer(`${prefixOf(batch)}/uploads/xlsx/${path.basename(xlsx)}`, await readFile(xlsx), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      const fromFile = await linksSheetAdapter.collect({ ...input, upload: { ...upload, kind: "sheet", name: path.basename(xlsx), gcsUri: xlsxUri } as CatalogUpload });
      const shape = (items: typeof fromFile) => items.map((i) => [i.identifier, i.n, i.bytes.kind === "url" ? i.bytes.url : null]);
      expect(shape(fromGoogle)).toEqual(shape(fromFile));

      // The open point: can catalog-worker@ read what was shared only with catalog-web@?
      const workerAdc = process.env.REAL_WORKER_ADC;
      if (!workerAdc) {
        console.log("worker read not tried: set REAL_WORKER_ADC to an ADC file made with `gcloud auth application-default login --impersonate-service-account=catalog-worker@image-links-agent.iam.gserviceaccount.com`.");
      } else {
        const { google } = await import("googleapis");
        const auth = new google.auth.GoogleAuth({ keyFile: workerAdc, scopes: GOOGLE_SCOPES });
        const workerSheets = google.sheets({ version: "v4", auth }) as unknown as SheetsLike;
        try {
          await collectGoogleSheetOnWeb({ ...input, upload: { ...upload, id: randomUUID() } as CatalogUpload, deps: { ...deps, sheets: workerSheets } }).then((r) =>
            console.log(`catalog-worker@ read: ${"error" in r ? `refused (${r.error})` : "allowed"}`),
          );
        } catch (err) {
          console.log(`catalog-worker@ read: failed (${(err as Error).message})`);
        }
      }
    } finally {
      await cleanup(batch);
    }
  });

  test.skipIf(!existsSync(ANTA_DIR))("CLI: catalog-local collect writes a manifest with 630 shots", async (ctx) => {
    if (!existsSync(CLI)) {
      console.log("skipped: build the worker first (pnpm --filter @catalog/worker build).");
      ctx.skip();
      return;
    }
    const out = await mkdtemp(path.join(os.tmpdir(), "catalog-local-anta-"));
    try {
      execFileSync(process.execPath, [CLI, "collect", "--brand", "anta", "--from", ANTA_DIR, "--out", out], { stdio: "inherit" });
      const manifest = JSON.parse(await readFile(path.join(out, "manifest.json"), "utf8")) as { identifierMode: string; products: { shots: unknown[] }[] };
      expect(manifest.identifierMode).toBe("filename");
      expect(manifest.products.reduce((s, p) => s + p.shots.length, 0)).toBe(630);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });
});
