import { reliability, reliabilityWindow } from "../../../../../lib/catalog/ops";
import { REPORT_UNAVAILABLE } from "../../../../../lib/catalog/ops-copy";
import { badRequest, handle, HttpError } from "../../../../../lib/errors";
import { requireRole } from "../../../../../lib/user";

export const dynamic = "force-dynamic";
const DAY_MS = 86_400_000;

/**
 * M6-S6 (M6-F3-R5): the Ops reliability numbers as JSON for an admin, never cached by a browser or proxy (no-store).
 * Without `from` and `to` it serves the Ops page's 30-day read (kept a few minutes per web instance). `?from&to` are
 * ISO dates or times (either may be left out: `to` defaults to now, `from` to 30 days before `to`), at most 366 days
 * apart, read fresh every time. The success rates are the 7 and 30 days ending at `to`.
 */
export function GET(req: Request) {
  return handle(async () => {
    await requireRole("admin", req);
    const q = new URL(req.url).searchParams;
    let read;
    if (!q.get("from") && !q.get("to")) read = await reliability();
    else {
      const to = q.get("to") ? new Date(q.get("to")!) : new Date();
      const from = q.get("from") ? new Date(q.get("from")!) : new Date(+to - 30 * DAY_MS);
      if (Number.isNaN(+to) || Number.isNaN(+from)) throw badRequest("from and to must be dates, for example 2026-11-01.");
      if (+from >= +to || +to - +from > 366 * DAY_MS) throw badRequest("from must be before to, at most 366 days apart.");
      read = await reliabilityWindow(from, to);
    }
    if (!read.ok) throw new HttpError(503, REPORT_UNAVAILABLE);
    return Response.json(read.value, { headers: { "Cache-Control": "no-store" } });
  });
}
