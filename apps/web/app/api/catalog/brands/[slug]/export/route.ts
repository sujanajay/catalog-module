import { z } from "zod";
import { exportBrand } from "../../../../../../lib/catalog/exports";
import { handle, readJson } from "../../../../../../lib/errors";
import { requireRole } from "../../../../../../lib/user";
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
 return handle(async () => { await requireRole("operator", req); const body = z.object({productIds:z.array(z.uuid()).min(1)}).parse(await readJson(req)); return Response.json(await exportBrand((await ctx.params).slug, body.productIds)); });
}

