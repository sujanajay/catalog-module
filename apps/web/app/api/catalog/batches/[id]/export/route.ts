import { batchExportUrl, batchReport } from "../../../../../../lib/catalog/exports";
import { handle } from "../../../../../../lib/errors";
import { requireRole } from "../../../../../../lib/user";
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
 return handle(async () => {
  await requireRole("viewer", req);
  const id = (await ctx.params).id, format = new URL(req.url).searchParams.get("format") ?? "xlsx";
  // The report is served by the app so model ids are removed (spec 07); the sheets are signed links.
  if (format === "report") return Response.json(await batchReport(id), { headers: { "Content-Disposition": `inline; filename="report-${id}.json"`, "Cache-Control": "private, no-store" } });
  return Response.redirect(await batchExportUrl(id, format), 302);
 });
}
