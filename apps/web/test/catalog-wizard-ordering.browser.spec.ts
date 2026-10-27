import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";

// Exercise the real client components in Chromium, with a component-only HTTP server.
// No deployed application, sign-in state, database or storage is used.
const loadModule = createRequire(path.resolve("package.json"));
const { build, stop } = createRequire(loadModule.resolve("tsx"))("esbuild");
let server: Server, origin: string;
const detected = { identifierMode: { detected: "filename", options: ["filename"], examples: [] }, precedence: { shown: false, default: "uploads_then_links" }, sheets: [], totalProducts: 1, formats: { sentence: "One JPEG" }, unreadable: [], googleAccess: [] };
const preview = { ready: true, previewAt: "2026-10-19T00:00:00Z", counts: { products: 1, sources: 1, channels: 1, outputs: 1 }, collected: 1, collectTotal: 1, warnings: [], groups: [], totalRows: 0, overwrite: { newProducts: 1, existingProducts: [], renameHints: [], sameProductPairs: [] }, busy: [] };
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

async function setup(page: Page) {
  await page.route("**/api/catalog/**", route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/detected") && route.request().method() === "GET") return answer(route, detected);
    if (url.pathname.endsWith("/links")) return answer(route, { kind: "url_list", access: "ok", summary: "Added", count: 1 });
    if (url.pathname === "/api/catalog/batches") return answer(route, { id: "batch" });
    return answer(route, { counts: { previewReady: true, failReason: null } });
  });
  await page.goto(origin);
  await page.getByLabel("Which brand?").selectOption("anta");
}

test.beforeAll(async () => {
  const result = await build({
    stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import CatalogWizard from './components/catalog/CatalogWizard'; import {ToastProvider} from './components/Toast'; createRoot(document.getElementById('root')).render(<ToastProvider><CatalogWizard brands={[{slug:'anta',name:'Anta',line:'softline'},{slug:'uspa',name:'USPA',line:'softline'}]} shareEmail="viewer@example.test"/></ToastProvider>);`, resolveDir: process.cwd(), loader: "tsx" },
    bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", loader: { ".css": "empty" },
    plugins: [{ name: "router", setup(plugin: { onResolve(filter: { filter: RegExp }, callback: () => unknown): void; onLoad(filter: { filter: RegExp; namespace: string }, callback: () => unknown): void }) { plugin.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "router", namespace: "test" })); plugin.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: "export const useRouter=()=>({push:()=>{},replace:()=>{}})" })); } }],
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

test("locks brand and product type while batch creation is pending, and unlocks on failure", async ({ page }) => {
  await setup(page);
  const create = deferred();
  await page.route("**/api/catalog/batches", async route => { await create.promise; await answer(route, { error: "Try creation again" }, 500); });
  await paste(page, "https://example.test/first.jpg");
  await expect(page.getByLabel("Which brand?")).toBeDisabled();
  await expect(page.getByLabel("What kind of products?")).toBeDisabled();
  create.resolve();
  await expect(page.getByRole("alert")).toHaveText("Try creation again");
  await expect(page.getByLabel("Which brand?")).toBeEnabled();
  await expect(page.getByLabel("What kind of products?")).toBeEnabled();
});

test("coalesces paste plus blur; Continue stays enabled while links are checked and waits for the queued text to be saved", async ({ page }) => {
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
  const next = page.getByRole("button", { name: "Continue", exact: true });
  await expect(next).toBeEnabled(); // the check never blocks Continue (spec 14b F2)
  await next.click();
  second.resolve(); // A later response cannot settle the paste while the first write is outstanding.
  await page.waitForTimeout(100);
  expect(order).toEqual([]);
  first.resolve();
  await expect.poll(() => writes).toEqual(["https://example.test/first.jpg", "https://example.test/second.jpg"]);
  await expect.poll(() => order).toEqual(["saved https://example.test/first.jpg", "saved https://example.test/second.jpg", "ingest"]);
  // Only the answer to the latest text is shown.
  await expect(page.getByText("https://example.test/first.jpg", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Check what we found" })).toBeVisible();
});

test("does not overlap slow preview polls or restore older collecting state", async ({ page }) => {
  await setup(page);
  await paste(page, "https://example.test/first.jpg");
  const next = page.getByRole("button", { name: "Continue", exact: true });
  await expect(next).toBeEnabled(); await next.click();
  await expect(page.getByRole("heading", { name: "Check what we found" })).toBeVisible();
  await next.click();
  await page.getByLabel("Noon", { exact: false }).check();
  const slow = deferred(); let calls = 0;
  await page.route("**/preview", async route => { calls++; if (calls === 1) await slow.promise; await answer(route, calls === 1 ? { ...preview, ready: false } : preview); });
  await next.click();
  await expect.poll(() => calls).toBe(1);
  await page.waitForTimeout(2800);
  expect(calls).toBe(1);
  slow.resolve();
  await expect(page.getByRole("button", { name: "Start processing" })).toBeEnabled();
});

test("ignores an older detection poll after the operator refreshes access", async ({ page }) => {
  await setup(page);
  const slow = deferred(); let reads = 0;
  const withAccess = { ...detected, googleAccess: [{ url: "https://docs.google.com/spreadsheets/d/example", kind: "google_sheet", status: "no_access" }] };
  await page.route("**/detected", async route => {
    reads++;
    const read = reads;
    if (read === 2) await slow.promise;
    await answer(route, { ...withAccess, formats: { sentence: read >= 3 ? "Latest access result" : "Older access result" } });
  });
  await paste(page, "https://example.test/first.jpg");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect.poll(() => reads).toBe(2);
  await page.getByRole("button", { name: "Check again" }).click();
  await expect(page.getByText("Latest access result", { exact: true })).toBeVisible();
  slow.resolve();
  await page.waitForTimeout(100);
  expect(await page.getByText("Latest access result", { exact: true }).count()).toBe(1);
  expect(await page.getByText("Older access result", { exact: true }).count()).toBe(0);
});
