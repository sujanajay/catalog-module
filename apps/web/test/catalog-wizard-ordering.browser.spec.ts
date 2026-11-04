import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";

// Exercise the real client components in Chromium, with a component-only HTTP server.
// No deployed application, sign-in state, database or storage is used.
const loadModule = createRequire(path.resolve("package.json"));
const { build, stop } = createRequire(loadModule.resolve("tsx"))("esbuild");
let server: Server, origin: string;
const detected = { identifierMode: { detected: "filename", options: ["filename"], examples: [] }, grouping: { perRoot: false, sentence: null }, precedence: { shown: false, default: "uploads_then_links" }, sheets: [], totalProducts: 1, formats: { sentence: "One JPEG" }, unreadable: [], googleAccess: [] };
const preview = { ready: true, previewAt: "2026-10-19T00:00:00Z", counts: { products: 1, sources: 1, channels: 1, outputs: 1 }, collected: 1, collectTotal: 1, warnings: [], groups: [], totalRows: 0, overwrite: { newProducts: 1, existingProducts: [], renameHints: [], sameProductPairs: [], sameBatches: [], duplicatePhotos: [] }, busy: [] };
/** GET /api/catalog/batches/<id>: a draft with one pasted input, collected (previewReady) or not, with no countdown. */
const polledBatch = (previewReady: boolean, startedAt: string | null = null) => ({ batch: { status: startedAt ? "matting" : "draft", startedAt, options: { autoStart: false } }, counts: { previewReady, failReason: null, collectTotal: 1, autoStartAt: null }, state: null, uploads: [{ id: "u1", kind: "url_list", name: "Pasted links", relativePath: null, sizeBytes: null, status: "collected", error: null }] });
const answer = (route: Route, json: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(json) });
const releases: (() => void)[] = [];
test.afterEach(() => { releases.splice(0).forEach(release => release()); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); releases.push(resolve); return { promise, resolve }; }

async function paste(page: Page, value: string) {
  const field = page.getByLabel("Or paste a link");
  await field.fill("");
  await field.evaluate((element, text) => {
    const clipboardData = new DataTransfer(); clipboardData.setData("text", text);
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true }));
  }, value);
  await field.fill(value);
  await field.blur();
}

/** The one-page New batch (UX3) with mocked routes; `brand` preselects it as /catalog/new?brand= does. */
async function setup(page: Page, { brand = "anta", previewReady = false, startedAt = null }: { brand?: string; previewReady?: boolean; startedAt?: string | null } = {}) {
  await page.route("**/api/catalog/**", route => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname.endsWith("/brands/infer")) return answer(route, { brandSlug: route.request().postDataJSON().brandSlug ?? null, brandName: null, channels: ["noon"], channelSource: "slice" });
    if (url.pathname.endsWith("/detected") && method === "GET") return answer(route, detected);
    if (url.pathname.endsWith("/preview")) return answer(route, preview);
    if (url.pathname.endsWith("/links")) return answer(route, { kind: "url_list", access: "ok", summary: "Added", count: 1 });
    if (url.pathname.endsWith("/ingest")) return answer(route, { ok: true });
    if (url.pathname === "/api/catalog/batches") return answer(route, { id: "batch" });
    if (url.pathname === "/api/catalog/batches/batch" && method === "GET") return answer(route, polledBatch(previewReady, startedAt));
    return answer(route, { ok: true });
  });
  await page.goto(brand ? `${origin}/?brand=${brand}` : origin);
}

test.beforeAll(async () => {
  const result = await build({
    stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import CatalogWizard from './components/catalog/CatalogWizard'; import {ToastProvider} from './components/Toast'; createRoot(document.getElementById('root')).render(<ToastProvider><CatalogWizard brands={[{slug:'anta',name:'Anta',line:'softline'},{slug:'uspa',name:'USPA',line:'softline'}]} shareEmail="viewer@example.test" initialBrand={new URLSearchParams(location.search).get('brand') ?? ''}/></ToastProvider>);`, resolveDir: process.cwd(), loader: "tsx" },
    bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", loader: { ".css": "empty" },
    plugins: [{ name: "router", setup(plugin: { onResolve(filter: { filter: RegExp }, callback: () => unknown): void; onLoad(filter: { filter: RegExp; namespace: string }, callback: () => unknown): void }) { plugin.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "router", namespace: "test" })); plugin.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: "export const useRouter=()=>({push:(url)=>{(window.__pushes??=[]).push(url)},replace:()=>{}})" })); } }],
  });
  const javascript = result.outputFiles[0].text;
  server = createServer((request, response) => {
    response.setHeader("Content-Type", request.url === "/bundle.js" ? "text/javascript" : "text/html");
    response.end(request.url === "/bundle.js" ? javascript : '<div id="root"></div><script src="/bundle.js"></script>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing component server port");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { if (!server) return; stop(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });

test("asks the brand for a paste with no files, locks product type while the batch is made, and unlocks on failure", async ({ page }) => {
  await setup(page, { brand: "" });
  const create = deferred();
  await page.route("**/api/catalog/batches", async route => { await create.promise; await answer(route, { error: "Try creation again" }, 500); });
  await page.getByText("More settings").click();
  await paste(page, "https://example.test/first.jpg");
  // A paste has no file names to read the brand from (M1-F2-R3), so the page asks; the paste goes on once chosen.
  await page.getByLabel("Which brand is this?").selectOption("anta");
  await expect(page.getByLabel("What kind of products?")).toBeDisabled();
  create.resolve();
  await expect(page.getByRole("alert")).toHaveText("Try creation again");
  await expect(page.getByLabel("What kind of products?")).toBeEnabled();
});

test("coalesces paste plus blur, and hands the inputs to collecting only after the queued text is saved", async ({ page }) => {
  await setup(page);
  const first = deferred(), second = deferred(); const writes: string[] = []; const order: string[] = [];
  await page.route("**/links", async route => {
    const value = route.request().postDataJSON().text as string; writes.push(value);
    await (value.includes("first") ? first.promise : second.promise);
    order.push(`saved ${value}`);
    await answer(route, { kind: "url_list", access: "ok", summary: value, count: 1, pill: "1 image link" });
  });
  await page.route("**/ingest", async route => { order.push("ingest"); await answer(route, { ok: true }); });
  await paste(page, "https://example.test/first.jpg");
  await expect.poll(() => writes.length).toBeGreaterThan(0);
  await expect(page.getByText("Checking your links...", { exact: true })).toBeVisible();
  await paste(page, "https://example.test/second.jpg");
  await page.waitForTimeout(100);
  expect(writes).toEqual(["https://example.test/first.jpg"]);
  // There is no Continue (M1-F2-R2): the page hands off by itself once nothing is being checked.
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toHaveCount(0);
  second.resolve(); // A later response cannot settle the paste while the first write is outstanding.
  await page.waitForTimeout(1_200); // longer than the 800 ms hand-off settle time
  expect(order).toEqual([]);
  first.resolve();
  await expect.poll(() => writes).toEqual(["https://example.test/first.jpg", "https://example.test/second.jpg"]);
  await expect.poll(() => order).toEqual(["saved https://example.test/first.jpg", "saved https://example.test/second.jpg", "ingest"]);
  // Only the answer to the latest text is shown.
  await expect(page.getByText("https://example.test/first.jpg", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "What we found" })).toBeVisible();
});

test("does not overlap slow polls, and shows what we found with Start once the slow one answers", async ({ page }) => {
  await setup(page, { previewReady: true });
  const slow = deferred(); let calls = 0;
  await page.route("**/preview", async route => { calls++; if (calls === 1) await slow.promise; await answer(route, preview); });
  await paste(page, "https://example.test/first.jpg");
  await expect.poll(() => calls).toBe(1);
  // Two poll ticks (every 2.5 s) pass while the first preview read is still out: no second read starts.
  await page.waitForTimeout(5_500);
  expect(calls).toBe(1);
  slow.resolve();
  await expect(page.getByRole("heading", { name: "What we found" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start", exact: true })).toBeEnabled();
});

test("ignores an older detection poll after the operator checks Google access again", async ({ page }) => {
  await setup(page, { previewReady: true });
  const slow = deferred(); let armed = false, slowStarted = false, slowDone = false, ingests = 0;
  const withAccess = { ...detected, googleAccess: [{ url: "https://docs.google.com/spreadsheets/d/example", kind: "google_sheet", status: "no_access" }] };
  await page.route("**/ingest", async route => { ingests++; await answer(route, { ok: true }); });
  await page.route("**/detected", async route => {
    if (route.request().method() !== "GET") return answer(route, { ok: true });
    let sentence = "First access result";
    if (armed && !slowStarted) { slowStarted = true; await slow.promise; slowDone = true; sentence = "Older access result"; }
    else if (slowStarted) sentence = "Latest access result";
    await answer(route, { ...withAccess, formats: { sentence } });
  });
  await paste(page, "https://example.test/first.jpg");
  // The hand-off to collecting re-reads what we found; wait for it, so the grouping stays on screen from here.
  await expect.poll(() => ingests, { timeout: 10_000 }).toBe(1);
  await page.locator("summary", { hasText: "Change how products are grouped" }).click({ timeout: 10_000 });
  await expect(page.getByText("First access result", { exact: true })).toBeVisible();
  // The next detection read hangs, then the operator checks access again.
  armed = true;
  await expect.poll(() => slowStarted, { timeout: 10_000 }).toBe(true);
  await page.getByRole("button", { name: "Check again" }).click();
  // The access check has finished (its hand-off to collecting answered) before the old read comes back.
  await expect.poll(() => ingests).toBe(2);
  await page.waitForTimeout(200);
  slow.resolve();
  await expect.poll(() => slowDone).toBe(true);
  // The read that was out when access was checked again is dropped, not shown.
  await page.waitForTimeout(500);
  expect(await page.getByText("Older access result", { exact: true }).count()).toBe(0);
  await expect(page.getByText("Latest access result", { exact: true })).toBeVisible({ timeout: 10_000 });
  expect(await page.getByText("Older access result", { exact: true }).count()).toBe(0);
});

test("a started batch opens its page once: the poll stops and does not push again while the page renders", async ({ page }) => {
  await setup(page, { previewReady: true, startedAt: "2026-11-04T09:00:00Z" });
  const pushes = () => page.evaluate(() => (window as unknown as { __pushes?: string[] }).__pushes ?? []);
  await paste(page, "https://example.test/first.jpg");
  await expect.poll(pushes).toEqual(["/catalog/batch"]);
  // Three poll ticks (every 2.5 s): a push each time restarts a navigation slower than one poll, so it never lands.
  await page.waitForTimeout(7_500);
  expect(await pushes()).toEqual(["/catalog/batch"]);
});
