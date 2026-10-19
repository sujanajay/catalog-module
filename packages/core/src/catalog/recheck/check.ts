// Per-link and sheet-level checks of the independent re-check (spec 09 section 4.4). Each link is
// read with a plain GET from the caller's fetch (no storage library, no database). For `--batch`
// and `--brand` the caller passes the recorded live generation, which `x-goog-generation` must equal.
import sharp from "sharp";
import { buildCsv } from "../../csv";
import { channel as channelSpec, MAX_OUTPUT_BYTES } from "../channels";
import { effectiveMinimum } from "../render";
import type { ChannelId } from "../types";
import { mapLimit } from "../ingest/local-files";
import { RECHECK_CONCURRENCY } from "./index";

export interface LinkTarget {
  url: string;
  identifier: string;
  channel: ChannelId | null;
  n: number | null;
  /** The recorded `catalog_outputs.generation` of the live row (batch and brand modes). */
  expectedGeneration?: string | null;
  /** False for an xlsx text cell that is not a hyperlink equal to its text. */
  hyperlinkOk?: boolean;
}

export interface LinkResult extends LinkTarget {
  status: "ok" | "failed";
  http: number | null;
  bytes: number | null;
  width: number | null;
  height: number | null;
  generation: string | null;
  problem: string;
}

/** Problems readable from the URL alone. */
export function urlProblems(url: string): string[] {
  const problems: string[] = [];
  if (/\s/.test(url)) problems.push("has_space");
  let parsed: URL;
  try { parsed = new URL(url); } catch { return [...problems, "invalid_url"]; }
  if (parsed.protocol !== "https:") problems.push("not_https");
  if (!parsed.pathname.endsWith(".jpg")) problems.push("bad_suffix");
  return problems;
}

/** The channel's canvas rule (05): fixed canvases exactly, the others from the minimum to the target at the target's ratio. */
export function canvasOk(id: ChannelId, w: number, h: number): boolean {
  const spec = channelSpec(id), target = spec.targetCanvas;
  if (spec.fixedCanvas) return w === target.w && h === target.h;
  const min = effectiveMinimum(spec);
  return w >= min.w && h >= min.h && w <= target.w && h <= target.h && Math.abs(h - (w * target.h) / target.w) <= 1;
}

/** One link: plain GET, then status, type, signature, size, generation, canvas, density and sRGB profile. */
export async function checkLink(target: LinkTarget, fetchFn: typeof fetch = fetch): Promise<LinkResult> {
  const result: LinkResult = { ...target, status: "failed", http: null, bytes: null, width: null, height: null, generation: null, problem: "" };
  const problems = urlProblems(target.url);
  if (target.hyperlinkOk === false) problems.push("not_a_hyperlink");
  if (problems.includes("invalid_url")) { result.problem = problems.join("; "); return result; }
  try {
    const response = await fetchFn(target.url, { headers: { "Cache-Control": "no-cache" } });
    result.http = response.status;
    result.generation = response.headers.get("x-goog-generation");
    if (response.status !== 200) { await response.body?.cancel(); problems.push("http_status"); }
    else {
      if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "image/jpeg") problems.push("not_jpeg_type");
      const body = Buffer.from(await response.arrayBuffer());
      result.bytes = body.length;
      if (body.length > MAX_OUTPUT_BYTES) problems.push("too_large");
      if (!body.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) problems.push("not_jpeg_bytes");
      else {
        try {
          const meta = await sharp(body).metadata();
          result.width = meta.width ?? null; result.height = meta.height ?? null;
          if (target.channel) {
            if (!result.width || !result.height || !canvasOk(target.channel, result.width, result.height)) problems.push("wrong_dimensions");
            if (meta.density !== channelSpec(target.channel).dpi) problems.push("wrong_density");
          }
          if (!meta.hasProfile || meta.space !== "srgb") problems.push("no_srgb_profile");
        } catch { problems.push("not_decodable"); }
      }
    }
    if (target.expectedGeneration !== undefined && result.generation !== (target.expectedGeneration ?? null)) problems.push("wrong_generation");
  } catch (error) {
    problems.push(`fetch_error: ${error instanceof Error ? error.message : String(error)}`);
  }
  result.problem = problems.join("; ");
  result.status = problems.length ? "failed" : "ok";
  return result;
}

/** Checks every target with bounded concurrency; a URL seen before is `duplicate_url` and not fetched again. */
export async function recheckLinks(targets: readonly LinkTarget[], options: { fetch?: typeof fetch; concurrency?: number } = {}): Promise<LinkResult[]> {
  const seen = new Set<string>();
  const firsts = targets.map(t => { const dup = seen.has(t.url); seen.add(t.url); return dup; });
  return mapLimit(targets.map((t, i) => ({ t, dup: firsts[i]! })), Math.max(1, Math.floor(options.concurrency ?? RECHECK_CONCURRENCY)), async ({ t, dup }) => {
    if (!dup) return checkLink(t, options.fetch);
    return { ...t, status: "failed", http: null, bytes: null, width: null, height: null, generation: null, problem: "duplicate_url" } as LinkResult;
  });
}

export interface SheetProblem { problem: string; detail: string }

/** One row per product: duplicate identifiers, and the row count against the expected products. */
export function sheetProblems(identifiers: readonly string[], expectedRows?: number): SheetProblem[] {
  const problems: SheetProblem[] = [], seen = new Set<string>();
  for (const id of identifiers) {
    if (seen.has(id)) problems.push({ problem: "duplicate_row", detail: `More than one row for ${id || "an empty identifier"}.` });
    seen.add(id);
  }
  if (expectedRows !== undefined && identifiers.length !== expectedRows) problems.push({ problem: "row_count", detail: `The sheet has ${identifiers.length} product rows; ${expectedRows} were expected.` });
  return problems;
}

export interface RecheckSummary { ok: number; total: number; line: string; passed: boolean }

/** Each sheet-level problem counts as one failed item, so "N of N" is only complete when everything holds. */
export function summarize(results: readonly LinkResult[], problems: readonly SheetProblem[] = []): RecheckSummary {
  const ok = results.filter(r => r.status === "ok").length, total = results.length + problems.length;
  return { ok, total, line: `${ok} of ${total} links OK`, passed: ok === total };
}

export const RECHECK_CSV_COLUMNS = ["url", "identifier", "channel", "n", "status", "http", "bytes", "width", "height", "generation", "expected_generation", "problem"];

/** `recheck-<timestamp>.csv`: one row per link, then one row per sheet-level problem. */
export function recheckCsv(results: readonly LinkResult[], problems: readonly SheetProblem[] = []): string {
  const s = (v: unknown) => (v === null || v === undefined ? "" : String(v));
  return buildCsv(RECHECK_CSV_COLUMNS, [
    ...results.map(r => [r.url, r.identifier, s(r.channel), s(r.n), r.status, s(r.http), s(r.bytes), s(r.width), s(r.height), s(r.generation), s(r.expectedGeneration), r.problem]),
    ...problems.map(p => ["", "", "", "", "failed", "", "", "", "", "", "", `${p.problem}: ${p.detail}`]),
  ]);
}
