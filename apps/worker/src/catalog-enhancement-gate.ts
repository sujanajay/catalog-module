// Spec 11 workstream D: the enhancement fidelity gate runner. Takes the golden photos whose long side is
// at least 1,600 px (1,400 px when fewer than 20 qualify), shrinks each 2x, restores it with the baseline
// (lanczos3 plus an unsharp mask) and with every candidate upscaler on the GPU service's POST /upscale,
// measures every restoration against the original on the product area, and writes report.json and
// report.md to --out (or under catalog-test/evals/enhancement/<run-id>/ with --upload). The verdict line
// names the winner or "none passes". Model ids appear in the report and the console only.
// Needs: MATTING_GPU_URL (or --endpoint), Google application default credentials for the id token
// (the same auth as /matte), and BUCKET for the golden set (or --manifest for the owner's local roots).
// Nothing here needs the endpoint to print usage or the enlargement count (--count-only).
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertTestPrefix } from "@catalog/core/catalog/naming";
import * as storage from "@catalog/core/storage";
import { decodeRaster } from "@catalog/core/catalog/evals/image";
import { GOLDEN_MANIFEST_PATH, goldenSourcePath, parseGolden, readGoldenBytes, type GoldenEntry, type GoldenManifest } from "@catalog/core/catalog/evals/golden";
import { EVALS_PREFIX, withEvalRetry } from "@catalog/core/catalog/evals/progress";
import { BASELINE_METHOD, baselineUpscale, countNeedsEnlargement, decodeRestoration, ENHANCEMENT_CANDIDATES, evenCrop, GATE_BARS, measureRestoration, METRIC_NOTES, methodMeans, photoGeometry, reportMarkdown, selectQualifying, shrinkForGate, summariseCandidate, UPSCALE_SCALE, UpscaleClient, UpscaleError, verdictOf, type CallRecord, type CandidateRecord, type EnhancementReport, type MethodMetrics, type PhotoRecord } from "@catalog/core/catalog/evals/enhancement";

const USAGE = `Usage: node apps/worker/dist/catalog-enhancement-gate.js [flags]
  --candidates <ids>       comma-separated upscaler ids (default ${ENHANCEMENT_CANDIDATES.join(",")})
  --endpoint <url>         the GPU matting service (default MATTING_GPU_URL); POST /upscale?model=<id>&scale=2
  --min-long-side <px>     override the 1,600 px (fallback 1,400 px) qualifying rule, for example 1200
  --limit <n>              measure at most n qualifying photos (in manifest order)
  --manifest <file>        read the golden manifest and photos from the owner's local roots instead of gs://$BUCKET/${GOLDEN_MANIFEST_PATH}
  --out <dir>              where report.json and report.md go (default <tmp>/catalog-enhancement-gate/<run-id>)
  --upload                 also write them under gs://$BUCKET/${EVALS_PREFIX}/enhancement/<run-id>/
  --count-only             only list the qualifying photos and the share that need enlargement; no endpoint
  --help                   this text
Bars per candidate: SSIM and LPIPS stand-in better than the baseline on at least ${GATE_BARS.betterShareMin * 100}% of photos and on the mean; CIEDE2000 mean under ${GATE_BARS.deMeanMax} on every photo;
no text/logo region worse than the baseline by more than ${GATE_BARS.textSsimDropMax} SSIM; texture flags on at most ${GATE_BARS.textureFlagShareMax * 100}% of photos; halo not worse than baseline + ${GATE_BARS.haloExtraMax} level;
determinism 100%; error rate under ${GATE_BARS.errorRateMax * 100}%; wall p95 under ${GATE_BARS.p95MsMax / 1000} s.`;

const gcs = withEvalRetry(storage);
type Flags = Record<string, string | true>;
function parseArgs(argv: string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) throw new Error(`Unexpected argument ${a}.\n${USAGE}`);
    const key = a.slice(2), next = argv[i + 1];
    flags[key] = next === undefined || next.startsWith("--") ? true : (i++, next);
  }
  return flags;
}
const str = (v: string | true | undefined) => (typeof v === "string" ? v : undefined);
const log = (value: unknown) => console.info(typeof value === "string" ? value : JSON.stringify(value, null, 2));
const runId = () => `enh-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${randomUUID().slice(0, 6)}`;

async function loadManifest(flags: Flags): Promise<{ manifest: GoldenManifest; read: (e: GoldenEntry) => Promise<Buffer>; source: string }> {
  const local = str(flags.manifest);
  if (local) {
    const manifest = parseGolden(await readFile(local, "utf8"));
    return { manifest, read: e => readGoldenBytes(manifest, e), source: local };
  }
  const uri = storage.toGsUri(storage.getBucketName(), GOLDEN_MANIFEST_PATH);
  const manifest = parseGolden((await gcs.downloadBuffer(uri)).buf.toString("utf8"));
  return { manifest, read: async e => (await gcs.downloadBuffer(storage.toGsUri(storage.getBucketName(), goldenSourcePath(e)))).buf, source: uri };
}

async function callTwice(client: UpscaleClient, upload: Buffer, model: string): Promise<{ calls: CallRecord[]; bytes: Buffer | null; deterministic: boolean | null; expected: { w: number; h: number } }> {
  const calls: CallRecord[] = [], results: Buffer[] = [];
  const expected = { w: 0, h: 0 };
  for (let attempt = 0; attempt < 2; attempt++) {
    const started = performance.now();
    try {
      const r = await client.upscale(upload, model, UPSCALE_SCALE, "image/jpeg");
      if (!expected.w) { expected.w = r.width; expected.h = r.height; }
      calls.push({ ok: true, wallMs: r.wallMs, serviceMs: r.serviceMs });
      results.push(r.jpeg);
    } catch (err) {
      calls.push({ ok: false, wallMs: performance.now() - started, serviceMs: null, error: err instanceof UpscaleError ? `${err.message}${err.status === 503 ? " (unavailable)" : ""}` : err instanceof Error ? err.message : String(err) });
    }
  }
  return { calls, bytes: results[0] ?? null, deterministic: results.length === 2 ? results[0]!.equals(results[1]!) : null, expected };
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) { log(USAGE); return; }
  const startedAt = new Date(), run = runId();
  const candidates = (str(flags.candidates) ?? ENHANCEMENT_CANDIDATES.join(",")).split(",").map(s => s.trim()).filter(Boolean);
  const explicitMin = str(flags["min-long-side"]) === undefined ? undefined : Number(str(flags["min-long-side"]));
  if (explicitMin !== undefined && !(explicitMin > 0)) throw new Error("--min-long-side needs a positive number of pixels.");
  const limit = str(flags.limit) === undefined ? Infinity : Number(str(flags.limit));
  const countOnly = flags["count-only"] === true;
  const endpoint = str(flags.endpoint) ?? process.env.MATTING_GPU_URL ?? null;
  if (!countOnly && !endpoint) throw new Error("Set MATTING_GPU_URL or pass --endpoint (or --count-only).");
  const out = str(flags.out) ?? path.join(os.tmpdir(), "catalog-enhancement-gate", run);
  log(`Run id: ${run}`);

  const { manifest, read, source } = await loadManifest(flags);
  // Planted copies share bytes with their host product; measure each photo once.
  const photos = manifest.entries.filter(e => !e.planted);
  const need = countNeedsEnlargement(photos.map(e => ({ w: e.width, h: e.height })));
  const { chosen, selection } = selectQualifying(photos.map(e => ({ w: e.width, h: e.height, entry: e })), explicitMin);
  log({ manifest: source, photos: photos.length, selection, needsEnlargement: need });
  log(`Qualifying photos (${chosen.length}): ${chosen.map(c => `${c.entry.identifier}_${c.entry.n} ${c.w}x${c.h}`).join(", ") || "none"}`);
  if (chosen.length < 1) throw new Error(`No golden photo reaches ${selection.minLongSide} px; pass --min-long-side (the set has ${selection.counts.at1600} at 1,600 px and ${selection.counts.at1400} at 1,400 px) or add larger photos to the golden set.`);
  if (countOnly) return;

  const client = new UpscaleClient({ baseUrl: endpoint! });
  const notes: string[] = [];
  try {
    const health = await client.health();
    log({ health });
    for (const c of candidates) if (!health.models.includes(c)) notes.push(`Candidate ${c} is not in the service's upscale.models (${health.models.join(", ") || "none"}); its calls are expected to fail.`);
  } catch (err) { notes.push(`GET /health failed: ${err instanceof Error ? err.message : String(err)}.`); }

  const records: PhotoRecord[] = [];
  for (const item of chosen.slice(0, Number.isFinite(limit) ? limit : undefined)) {
    const e = item.entry;
    const original = evenCrop(await decodeRaster(await read(e)));
    const geometry = photoGeometry(original);
    const { raster: input, upload } = await shrinkForGate(original);
    const baseline: MethodMetrics = measureRestoration(original, geometry, await baselineUpscale(input));
    const record: PhotoRecord = { identifier: e.identifier, n: e.n, brand: e.brand, width: original.w, height: original.h, productShare: geometry.area.share, productMethod: geometry.area.method, baseline, candidates: {} };
    for (const model of candidates) {
      const { calls, bytes, deterministic, expected } = await callTwice(client, upload, model);
      let metrics: MethodMetrics | null = null;
      if (bytes) {
        if (expected.w !== original.w || expected.h !== original.h) { calls.forEach(c => { if (c.ok) { c.ok = false; c.error = `Response is ${expected.w}x${expected.h}, expected exactly ${original.w}x${original.h}.`; } }); }
        else metrics = measureRestoration(original, geometry, await decodeRestoration(bytes));
      }
      const candidate: CandidateRecord = { metrics, calls, deterministic };
      record.candidates[model] = candidate;
      log(`${e.identifier}_${e.n} ${model}: ${metrics ? `ssim ${metrics.ssim.toFixed(4)} (baseline ${baseline.ssim.toFixed(4)}), dE ${metrics.deMean.toFixed(2)}, halo ${metrics.halo.toFixed(2)}` : "failed"}; ${calls.map(c => (c.ok ? `${Math.round(c.wallMs)} ms` : c.error)).join(" / ")}; deterministic ${deterministic ?? "n/a"}`);
    }
    records.push(record);
  }

  const summaries = candidates.map(m => summariseCandidate(m, records));
  const verdict = verdictOf(summaries);
  const report: EnhancementReport = {
    run, startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), endpoint, scale: UPSCALE_SCALE,
    selection, qualifying: records.map(r => ({ identifier: r.identifier, n: r.n, brand: r.brand, width: r.width, height: r.height })),
    needsEnlargement: need,
    productArea: "colour estimate of the golden source (pixels further than 12 levels from the border median, specks dropped, grown 2 px); the whole frame when the estimate covers under 2% or over 98%. Independent of the matting models; no service call.",
    metrics: METRIC_NOTES,
    baseline: { method: BASELINE_METHOD, means: methodMeans(records.map(r => r.baseline)) },
    candidates: summaries, photos: records, verdict, notes,
  };
  await mkdir(out, { recursive: true });
  const json = JSON.stringify(report, null, 2), md = reportMarkdown(report);
  await writeFile(path.join(out, "report.json"), json);
  await writeFile(path.join(out, "report.md"), md);
  if (flags.upload) {
    for (const [name, body, mime] of [["report.json", json, "application/json"], ["report.md", md, "text/markdown"]] as const) {
      const objectPath = `${EVALS_PREFIX}/enhancement/${run}/${name}`;
      assertTestPrefix(objectPath);
      await gcs.uploadBuffer(objectPath, Buffer.from(body), mime);
    }
    log(`Uploaded: gs://${storage.getBucketName()}/${EVALS_PREFIX}/enhancement/${run}/`);
  }
  for (const s of summaries) log(`${s.method}: ${s.pass ? "PASS" : "FAIL"} (${s.bars.filter(b => !b.ok).map(b => b.id).join(", ") || "every bar"})`);
  log(verdict.line);
  log(`Report: ${path.join(out, "report.md")}`);
  if (!verdict.winner) process.exitCode = 1;
}
main().catch(error => { console.error(error instanceof Error ? error.stack ?? error.message : String(error)); process.exitCode = 1; });
