import ExcelJS from "exceljs";
export const RECHECK_CONCURRENCY = 16;
/** How long one link may take to answer and send its first bytes; past it the link fails with RECHECK_TIMEOUT_REASON. */
export const RECHECK_FETCH_TIMEOUT_MS = 30_000;
export const RECHECK_TIMEOUT_REASON = "The link did not answer within 30 seconds.";
export interface RecheckResult { ok: number; total: number; failures: { url: string; reason: string }[] }
/** A re-check stopped by its deadline: the links before `next` are counted in `result`; the rest are not read yet. */
export interface RecheckProgress { next: number; result: RecheckResult }
export interface RecheckOptions {
  fetch?: typeof fetch; concurrency?: number;
  /** Per-link time limit (default RECHECK_FETCH_TIMEOUT_MS). */
  timeoutMs?: number;
  /** No new link is started at or after this time (ms since epoch, read from `now`); links already started finish. */
  deadlineAt?: number; now?: () => number;
  /** Goes on from an earlier part of the same workbook. */
  resume?: RecheckProgress;
}
/** Reads the delivered file afresh. No database or authenticated storage reads are used. */
export async function recheckSheet(xlsx: Buffer, options: Omit<RecheckOptions, "deadlineAt" | "resume"> = {}): Promise<RecheckResult> {
  return (await recheckSheetPart(xlsx, options)).result;
}
/**
 * The re-check in parts (finalize runs it inside a request with a deadline): `done` false means the deadline came
 * first and `progress` goes into the next part's `resume`. The links are read in workbook order, so a part never
 * reads a link twice or skips one.
 */
export async function recheckSheetPart(xlsx: Buffer, options: RecheckOptions = {}): Promise<{ done: boolean; progress: RecheckProgress; result: RecheckResult }> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(xlsx as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const result: RecheckResult = { ok: 0, total: 0, failures: [] }, seen = new Set<string>(), identifiers = new Set<string>();
  const work: { url: string; problem: string | null }[] = [];
  const sheet = workbook.worksheets[0];
  if (!sheet) { const none = { ok: 0, total: 1, failures: [{ url: "", reason: "The workbook has no links sheet." }] }; return { done: true, progress: { next: 0, result: none }, result: none }; }
  sheet.eachRow((row, n) => {
    if (n < 3) return;
    const id = row.getCell(2).text;
    if (identifiers.has(id)) { result.total++; result.failures.push({ url: "", reason: `More than one row for ${id}.` }); }
    identifiers.add(id);
    row.eachCell((cell, col) => {
      if (!/^Image \d+$/.test(sheet.getCell(2, col).text)) return;
      if (!cell.value) return;
      const v = cell.value, url = typeof v === "object" && "hyperlink" in v ? v.hyperlink : cell.text;
      let problem: string | null = null;
      if (!(typeof v === "object" && "hyperlink" in v) || v.text !== url) problem = "Hyperlink must equal the cell text.";
      try { if (!new URL(url).pathname.endsWith(".jpg")) problem = "The URL must end in .jpg."; } catch { problem = "The URL is invalid."; }
      if (seen.has(url)) problem = "The URL appears more than once.";
      seen.add(url); work.push({ url, problem });
    });
  });
  result.total += work.length;
  // A resumed part keeps the earlier parts' counts (the sheet-level problems above are counted again, identically).
  if (options.resume) { result.ok = options.resume.result.ok; result.total = options.resume.result.total; result.failures = [...options.resume.result.failures]; }
  let cursor = options.resume?.next ?? 0;
  const now = options.now ?? Date.now, timeoutMs = options.timeoutMs ?? RECHECK_FETCH_TIMEOUT_MS;
  // Every part reads at least one link, so parts always move on even when the deadline is already past.
  const first = cursor;
  const open = () => cursor < work.length && (cursor === first || options.deadlineAt === undefined || now() < options.deadlineAt);
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? RECHECK_CONCURRENCY));
  await Promise.all(Array.from({ length: Math.min(concurrency, work.length - cursor) }, async () => {
    while (open()) {
      const item = work[cursor++]!;
      let reason = item.problem;
      // One timer per link covers the answer and the signature bytes, so a link that never answers ends the wait.
      const signal = AbortSignal.timeout(timeoutMs);
      if (!reason) try {
        const response = await (options.fetch ?? fetch)(item.url, { signal });
        const reader = response.body?.getReader();
        try {
          if (response.status !== 200) reason = `HTTP ${response.status}`;
          else if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "image/jpeg") reason = "The link is not image/jpeg.";
          else {
            const signature = new Uint8Array(3);
            let count = 0;
            while (reader && count < signature.length) {
              const { done, value } = await reader.read();
              if (done) break;
              const prefix = value.subarray(0, signature.length - count);
              signature.set(prefix, count);
              count += prefix.length;
            }
            if (count !== 3 || signature[0] !== 255 || signature[1] !== 216 || signature[2] !== 255) reason = "The link is not a JPEG.";
          }
        } finally {
          if (reader) try { await reader.cancel(); } finally { reader.releaseLock(); }
        }
      } catch (error) { reason = signal.aborted ? RECHECK_TIMEOUT_REASON : error instanceof Error ? error.message : String(error); }
      if (reason) result.failures.push({ url: item.url, reason }); else result.ok++;
    }
  }));
  return { done: cursor >= work.length, progress: { next: cursor, result }, result };
}
