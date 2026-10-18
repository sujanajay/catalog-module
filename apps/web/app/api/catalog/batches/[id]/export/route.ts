import { batchExportUrl } from "../../../../../../lib/catalog/exports";
import { handle } from "../../../../../../lib/errors";
import { requireRole } from "../../../../../../lib/user";
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
 return handle(async () => { await requireRole("viewer", req); return Response.redirect(await batchExportUrl((await ctx.params).id, new URL(req.url).searchParams.get("format") ?? "xlsx"), 302); });
}

