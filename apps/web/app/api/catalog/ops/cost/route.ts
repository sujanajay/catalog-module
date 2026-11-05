import { costReconciled, costReconciledWindow } from "../../../../../lib/catalog/ops";
import { REPORT_UNAVAILABLE } from "../../../../../lib/catalog/ops-copy";
import { badRequest, handle, HttpError } from "../../../../../lib/errors";
import { requireRole } from "../../../../../lib/user";

export const dynamic = "force-dynamic";
const DAY_MS = 86_400_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * M6-S2 (M6 section 3, `GET /api/catalog/ops/cost?from&to`): the Ops cost card as JSON for an admin, never cached by a
 * browser or proxy (no-store). Without `from` and `to` it serves the page's read (the last 30 UTC days and today, kept
 * a few minutes per web instance). `?from&to` are UTC days (YYYY-MM-DD, `to` not included; either may be left out:
 * `to` defaults to tomorrow, `from` to 30 days before `to`), at most 366 days apart, read fresh every time.
 */
export function GET(req: Request) {
  return handle(async () => {
    await requireRole("admin", req);
    const q = new URL(req.url).searchParams;
    let read;
    if (!q.get("from") && !q.get("to")) read = await costReconciled();
    else {
      const toText = q.get("to") ?? new Date(Date.now() + DAY_MS).toISOString().slice(0, 10);
      const to = new Date(`${toText}T00:00:00Z`);
      const fromText = q.get("from") ?? new Date(+to - 30 * DAY_MS).toISOString().slice(0, 10);
      const from = new Date(`${fromText}T00:00:00Z`);
      if (!DAY.test(fromText) || !DAY.test(toText) || Number.isNaN(+from) || Number.isNaN(+to)) throw badRequest("from and to must be days, for example 2026-11-01.");
      if (+from >= +to || +to - +from > 366 * DAY_MS) throw badRequest("from must be before to, at most 366 days apart.");
      read = await costReconciledWindow(fromText, toText);
    }
    if (!read.ok) throw new HttpError(503, REPORT_UNAVAILABLE);
    return Response.json(read.value, { headers: { "Cache-Control": "no-store" } });
  });
}
