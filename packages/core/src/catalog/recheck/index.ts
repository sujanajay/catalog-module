import ExcelJS from "exceljs";
export const RECHECK_CONCURRENCY = 16;
export interface RecheckResult { ok: number; total: number; failures: { url: string; reason: string }[] }
/** Reads the delivered file afresh. No database or authenticated storage reads are used. */
export async function recheckSheet(xlsx: Buffer, options: { fetch?: typeof fetch; concurrency?: number } = {}): Promise<RecheckResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(xlsx as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const result: RecheckResult = { ok: 0, total: 0, failures: [] }, seen = new Set<string>(), identifiers = new Set<string>();
  const work: { url: string; problem: string | null }[] = [];
  const sheet = workbook.worksheets[0];
  if (!sheet) return { ok: 0, total: 1, failures: [{ url: "", reason: "The workbook has no links sheet." }] };
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
  let cursor = 0;
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? RECHECK_CONCURRENCY));
  await Promise.all(Array.from({ length: Math.min(concurrency, work.length) }, async () => {
    while (cursor < work.length) {
      const item = work[cursor++]!;
      let reason = item.problem;
      if (!reason) try {
        const response = await (options.fetch ?? fetch)(item.url);
        if (response.status !== 200) reason = `HTTP ${response.status}`;
        else if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "image/jpeg") reason = "The link is not image/jpeg.";
        else if (!Buffer.from(await response.arrayBuffer()).subarray(0,3).equals(Buffer.from([255,216,255]))) reason = "The link is not a JPEG.";
      } catch (error) { reason = error instanceof Error ? error.message : String(error); }
      if (reason) result.failures.push({ url: item.url, reason }); else result.ok++;
    }
  }));
  return result;
}
