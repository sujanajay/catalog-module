// Completeness (spec 10 section 2): for every golden source and ticked channel exactly the expected
// output exists, live and verified, with its public object, its staged file and its sheet cell; a
// skip only where the spec allows (Styli under styliMinSourceHeightPx, or a size chart left out with its note) and with the exact note.
// Pure over plain rows so it is unit tested without a database.
import { channel, styliMinSourceHeightPx } from "../channels";
import { flagReason, type ChannelId } from "../types";
import { upscaleFactorFromEnv } from "../upscale";
import { judge, type CheckResult, type CheckSubject } from "./types";

export const STYLI_SKIP_NOTE = "Skipped for Styli: the photo is smaller than Styli needs.";
/** A size chart or text-only photo is left out on every channel with this note (07 4.0a, flag `chart_image`). */
export const CHART_SKIP_NOTE = flagReason("chart_image");

export interface SourceRow { identifier: string; n: number; width: number | null; height: number | null }
export interface OutputRow {
  identifier: string; n: number; channel: ChannelId; status: string; isLive: boolean; reason: string | null;
  generation: number | null; bytes: number | null; crc32c: string | null; publicUrl: string; stagingUri: string | null;
}
export interface ObjectHead { exists: boolean; size: number | null; generation: string | null; contentType: string | null }
export interface SheetCell { identifier: string; channel: ChannelId; n: number; url: string | null }
export interface CompletenessInput {
  channels: ChannelId[];
  sources: SourceRow[];
  outputs: OutputRow[];
  /** Public HEAD per output public URL (missing = not fetched). */
  publicHeads: Map<string, ObjectHead>;
  /** Private HEAD per staging URI. */
  stagingHeads: Map<string, ObjectHead>;
  /** Link cells read back from the batch's links sheet. */
  sheet: SheetCell[];
  /** `notes` cell per identifier from the sheet. */
  sheetNotes: Map<string, string>;
  counts: { outputs: number; verified: number; skipped: number; recheckOk: number | null; recheckTotal: number | null };
  /**
   * Keys `identifier|n` of the sources the manifest expects the pipeline to hold (a 450 px copy, a planted photo on a live
   * run). A hold is per product (SPEC.md: `pending_attention` stages every shot of the product), so every shot of a
   * product that holds an expected-hold shot is expected staged with no link, and left out of the verified counts.
   */
  heldExpected?: Set<string>;
  /**
   * Keys `identifier|n` of the sources the manifest expects left out as a size chart (`chart_image`). A chart leave-out of
   * any other shot fails `skip_allowed` (live run D2, section 15e: a false chart detection would drop a product photo from
   * every channel in silence). Absent: every chart leave-out is accepted, as before.
   */
  chartExpected?: Set<string>;
}
export const sourceKey = (identifier: string, n: number) => `${identifier}|${n}`;

/** The spec's expectation for one (source, channel): "output" or "skip" (Styli low resolution, judged after the upscaler when UPSCALE_MODEL is set). */
export function expectedOutcome(source: SourceRow, ch: ChannelId, upscaleFactor: number = upscaleFactorFromEnv()): "output" | "skip" {
  return ch === "styli" && (source.height ?? Infinity) < styliMinSourceHeightPx(upscaleFactor) ? "skip" : "output";
}

export function checkCompleteness(input: CompletenessInput): CheckResult[] {
  const K = "completeness" as const, out: CheckResult[] = [];
  const key = (identifier: string, ch: ChannelId, n: number) => `${identifier}|${ch}|${n}`;
  const byKey = new Map<string, OutputRow[]>();
  for (const o of input.outputs) { const k = key(o.identifier, o.channel, o.n); byKey.set(k, [...byKey.get(k) ?? [], o]); }
  const seen = new Set<string>(), heldExpected = input.heldExpected ?? new Set<string>();
  const heldProducts = new Map<string, number[]>();
  for (const k of heldExpected) { const [identifier, n] = k.split("|"); heldProducts.set(identifier!, [...heldProducts.get(identifier!) ?? [], Number(n)]); }
  // A hold is per product. When a product the manifest does not expect held ends with every made output held or staged
  // and nothing live, its completeness is one product-level row (`completeness.product_held`) instead of a live,
  // public-object, sheet-cell and Amazon or Shein row per output (eval run 3: the FC bag's three false holds produced
  // 210 completeness rows for one defect), and its outputs leave the verified counts as an expected hold's do, so the
  // count of fails tracks defects. Whether the hold was right is attention.not_held's call.
  const byProduct = new Map<string, OutputRow[]>();
  for (const o of input.outputs) byProduct.set(o.identifier, [...byProduct.get(o.identifier) ?? [], o]);
  const productHeld = new Map<string, { held: OutputRow[]; made: number }>();
  for (const [identifier, rows] of byProduct) {
    if (heldProducts.has(identifier)) continue;
    const made = rows.filter(r => r.status !== "skipped"), held = made.filter(r => r.status === "needs_attention" || r.status === "failed");
    if (held.length && !made.some(r => r.isLive)) productHeld.set(identifier, { held, made: made.length });
  }
  let expectedOutputs = 0, expectedSkips = 0, expectedHeld = 0;
  for (const source of input.sources) for (const ch of input.channels) {
    const who: CheckSubject = { identifier: source.identifier, n: source.n, channel: ch }, k = key(source.identifier, ch, source.n);
    seen.add(k);
    const rows = byKey.get(k) ?? [], chart = rows.length === 1 && rows[0]!.status === "skipped" && rows[0]!.reason === CHART_SKIP_NOTE;
    const heldShots = heldProducts.get(source.identifier), held = !!heldShots;
    const sibling = held && !heldExpected.has(sourceKey(source.identifier, source.n));
    // A Styli skip under the minimum stays a skip on a held product: the pipeline counts it as skipped and the sheet row
    // carries the note (eval run 3: the held ZEE79259BBFD83FFA1DB0Z and the 450 px copies, 144 skipped against the 142 expected).
    const want = chart ? "chart" : expectedOutcome(source, ch) === "skip" ? "skip" : held ? "held" : productHeld.has(source.identifier) ? "product_held" : "output";
    if (want === "output") expectedOutputs++; else if (want === "held" || want === "product_held") expectedHeld++; else expectedSkips++;
    out.push(judge(rows.length === 1, "completeness.one_output", K, who, rows.length, 1, "rows", rows.length === 1 ? `One output row for ${channel(ch).label} image ${source.n}.` : `${rows.length} output rows for ${channel(ch).label} image ${source.n} (expected exactly 1).`));
    const row = rows[0];
    if (!row) continue;
    // Judged once for the product below (completeness.product_held), not once per output.
    if (want === "product_held") continue;
    const cell = input.sheet.find(c => c.identifier === source.identifier && c.channel === ch && c.n === source.n);
    if (want === "held") {
      // The manifest expects this photo to be held for a person: nothing goes live and the sheet carries no link.
      // Whether it was held with the right flags is attention.expected's call.
      const why = sibling ? `a sibling of the expected hold on image ${heldShots!.sort((a, b) => a - b).join(", ")}: the product is held as a whole` : "expected hold";
      out.push(judge(!row.isLive && !cell?.url, "completeness.held_unpublished", K, who, `${row.status}${row.isLive ? ", live" : ""}${cell?.url ? ", linked" : ""}`, "not live, no link", "status", !row.isLive && !cell?.url ? `Expected hold (${why}): nothing published, no link in the sheet.` : `Expected the pipeline to hold this photo (${why}) but it is ${row.isLive ? "live" : row.status}${cell?.url ? " with a link in the sheet" : ""}.`));
      continue;
    }
    if (want === "chart") {
      // The pipeline found a size chart: left out on every channel, with its note, never a link.
      const note = input.sheetNotes.get(source.identifier) ?? "", expectedChart = !input.chartExpected || input.chartExpected.has(sourceKey(source.identifier, source.n));
      out.push(judge(!rows[0]!.isLive && expectedChart, "completeness.skip_allowed", K, who, `skipped: ${CHART_SKIP_NOTE}`, expectedChart ? `skipped: ${CHART_SKIP_NOTE}` : "an output (the manifest expects no chart here)", "status", expectedChart ? "A size chart or text-only photo, left out with its note." : `Left out as a size chart without an expectation: the manifest does not expect image ${source.n} to be a chart, so a product photo was dropped from ${channel(ch).label} by the chart detector.`));
      out.push(judge(!cell?.url && note.includes(CHART_SKIP_NOTE), "completeness.sheet_cell", K, who, cell?.url ? "link" : note.includes(CHART_SKIP_NOTE) ? "empty with note" : "empty without note", "empty with note", "cell", cell?.url ? "A left-out chart still has a link in the sheet." : note.includes(CHART_SKIP_NOTE) ? "The sheet cell is empty and the note says why." : "The sheet cell is empty but the chart note is missing from the row's notes."));
      continue;
    }
    if (want === "skip") {
      out.push(judge(row.status === "skipped" && row.reason === STYLI_SKIP_NOTE && !row.isLive, "completeness.skip_allowed", K, who, `${row.status}: ${row.reason ?? ""}`, `skipped: ${STYLI_SKIP_NOTE}`, "status", row.status === "skipped" ? "Styli skip with the agreed note." : `Styli should skip this ${source.height} px source but the output is ${row.status}.`));
      const note = input.sheetNotes.get(source.identifier) ?? "";
      out.push(judge(!cell?.url && note.includes(STYLI_SKIP_NOTE), "completeness.sheet_cell", K, who, cell?.url ? "link" : note.includes(STYLI_SKIP_NOTE) ? "empty with note" : "empty without note", "empty with note", "cell", cell?.url ? "A skipped Styli image still has a link in the sheet." : note.includes(STYLI_SKIP_NOTE) ? "The sheet cell is empty and the note says why." : "The sheet cell is empty but the Styli note is missing from the row's notes."));
      continue;
    }
    out.push(judge(row.status !== "skipped", "completeness.skip_allowed", K, who, row.status, "not skipped", "status", row.status === "skipped" ? `Skipped although the spec allows no skip here: ${row.reason ?? ""}` : "Not skipped."));
    const live = row.status === "verified" && row.isLive && !!row.generation && !!row.bytes && !!row.crc32c;
    out.push(judge(live, "completeness.live", K, who, `${row.status}${row.isLive ? ", live" : ""}`, "verified, live, with generation, bytes and crc32c", "status", live ? "Verified and live." : `Expected a verified live output, found ${row.status}${row.reason ? ` (${row.reason})` : ""}.`));
    const head = input.publicHeads.get(row.publicUrl);
    const publicOk = !!head?.exists && head.size === row.bytes && head.generation === String(row.generation) && (head.contentType ?? "").split(";")[0]!.trim() === "image/jpeg";
    out.push(judge(publicOk, "completeness.public_object", K, who, head ? `${head.exists ? `${head.size} bytes, gen ${head.generation}, ${head.contentType}` : "missing"}` : "not fetched", `${row.bytes} bytes, gen ${row.generation}, image/jpeg`, "HEAD", publicOk ? "The public object matches the recorded generation and size." : "The public object is missing or differs from the record."));
    const staged = row.stagingUri ? input.stagingHeads.get(row.stagingUri) : undefined;
    const stagedOk = !!staged?.exists && staged.size === row.bytes;
    out.push(judge(stagedOk, "completeness.staged_file", K, who, staged ? (staged.exists ? `${staged.size} bytes` : "missing") : "no staging uri", `${row.bytes} bytes`, "HEAD", stagedOk ? "The staged file is present with the output's size." : "The staged file is missing or has a different size."));
    out.push(judge(cell?.url === row.publicUrl, "completeness.sheet_cell", K, who, cell?.url ?? "empty", row.publicUrl, "cell", cell?.url === row.publicUrl ? "The sheet cell carries the live link." : "The sheet cell does not carry the live link."));
    if (ch === "amazon" || ch === "shein") out.push(judge(live, `completeness.${ch}_shot`, K, who, live ? "present" : row.status, "present", "output", `${channel(ch).label} image ${source.n} of this product: ${live ? "present and live" : row.status} (every shot of a product gets its own ${channel(ch).label} image; image 1 is white, the rest grey).`));
  }
  for (const [identifier, p] of productHeld) {
    const shots = [...new Set(p.held.map(r => r.n))].sort((a, b) => a - b), links = input.sheet.filter(c => c.identifier === identifier && c.url).length;
    out.push(judge(false, "completeness.product_held", K, { identifier, n: null, channel: null }, `0 of ${p.made} live: product held`, `${p.made} of ${p.made} live`, "outputs", `The product is held as a whole (${p.held.length} of its ${p.made} outputs ${p.held.length === 1 ? "is" : "are"} needs attention or failed: image ${shots.join(", ")}; the rest staged) and nothing of it went live${links ? `, yet ${links} links are in the sheet` : ""}; the manifest expects it on the sheet. One row for the product: its outputs are left out of the per-output rows and of the verified counts, and attention.not_held names the hold.`));
  }
  const extra = input.outputs.filter(o => !seen.has(key(o.identifier, o.channel, o.n)));
  out.push(judge(extra.length === 0, "completeness.no_extra_outputs", K, { identifier: "*", n: null, channel: null }, extra.length, 0, "rows", extra.length ? `${extra.length} output rows belong to no golden source: ${extra.slice(0, 5).map(o => `${o.identifier} ${o.channel} ${o.n}`).join("; ")}.` : "No stray output rows."));
  const extraCells = input.sheet.filter(c => c.url && !seen.has(key(c.identifier, c.channel, c.n)));
  out.push(judge(extraCells.length === 0, "completeness.no_extra_cells", K, { identifier: "*", n: null, channel: null }, extraCells.length, 0, "cells", extraCells.length ? `${extraCells.length} sheet links belong to no golden source.` : "No stray sheet links."));
  const all: CheckSubject = { identifier: "*", n: null, channel: null };
  const planned = expectedOutputs + expectedSkips + expectedHeld;
  out.push(judge(input.counts.outputs === planned, "completeness.counts_planned", K, all, input.counts.outputs, planned, "outputs", `Batch counts ${input.counts.outputs} planned outputs; the golden set implies ${planned} (${expectedSkips} Styli skips and left-out charts, ${expectedHeld} outputs of expected or product-level holds).`));
  out.push(judge(input.counts.verified === expectedOutputs && input.counts.skipped === expectedSkips, "completeness.counts_verified", K, all, `${input.counts.verified} verified, ${input.counts.skipped} skipped`, `${expectedOutputs} verified, ${expectedSkips} skipped`, "outputs", `Links verified must equal planned minus skipped minus the ${expectedHeld} outputs of held products (every shot of an expected hold, and of a product held as a whole, which completeness.product_held names).`));
  const links = input.sheet.filter(c => c.url).length;
  out.push(judge(input.counts.recheckOk === input.counts.recheckTotal && input.counts.recheckTotal === links && links === expectedOutputs, "completeness.recheck_equals_verified", K, all, `recheck ${input.counts.recheckOk} of ${input.counts.recheckTotal}, ${links} links in the sheet`, `${expectedOutputs} of ${expectedOutputs}`, "links", "\"Independent re-check\" must equal \"Links verified\" and the number of links in the sheet (expected holds carry no link)."));
  return out;
}
