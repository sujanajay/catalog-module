import { z } from "zod";
import { addProductAlias } from "../../../../../../lib/catalog/products";
import { handle, readJson } from "../../../../../../lib/errors";
import { requireRole } from "../../../../../../lib/user";
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
 return handle(async () => { const user = await requireRole("operator", req); const body = z.object({alias:z.string().trim().min(1)}).parse(await readJson(req)); return Response.json(await addProductAlias((await ctx.params).id, body.alias, user.email)); });
}

