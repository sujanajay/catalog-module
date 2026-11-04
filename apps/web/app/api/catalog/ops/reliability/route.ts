import { reliability } from "../../../../../lib/catalog/ops";
import { REPORT_UNAVAILABLE } from "../../../../../lib/catalog/ops-copy";
import { catalogRoute } from "../../../../../lib/catalog/api";
import { badRequest, HttpError } from "../../../../../lib/errors";

export const dynamic = "force-dynamic";
const DAY_MS = 86_400_000;

/**
 * M6-S6 (M6-F3-R5): the Ops reliability numbers as JSON for an admin. `?from&to` are ISO dates or times (default: the 30
 * days to now); the success rates are the 7 and 30 days ending at `to`; the incidents and slowest batches are in
 * [from, to), at most 366 days.
 */
export function GET(req: Request) {
  return catalogRoute(req, "admin", async () => {
    const q = new URL(req.url).searchParams;
    const to = q.get("to") ? new Date(q.get("to")!) : new Date();
    const from = q.get("from") ? new Date(q.get("from")!) : new Date(+to - 30 * DAY_MS);
    if (Number.isNaN(+to) || Number.isNaN(+from)) throw badRequest("from and to must be dates, for example 2026-11-01.");
    if (+from >= +to || +to - +from > 366 * DAY_MS) throw badRequest("from must be before to, at most 366 days apart.");
    const read = await reliability(undefined, to, from);
    if (!read.ok) throw new HttpError(503, REPORT_UNAVAILABLE);
    return read.value;
  });
}
