import { batchAttention } from "../../../../../../lib/catalog/products";
import { handle } from "../../../../../../lib/errors";
import { requireRole } from "../../../../../../lib/user";
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
 return handle(async () => { await requireRole("viewer", req); return Response.json(await batchAttention((await ctx.params).id)); });
}

