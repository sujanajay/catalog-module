import { searchBrandProducts } from "../../../../../../lib/catalog/brands";
import { handle } from "../../../../../../lib/errors";
import { requireRole } from "../../../../../../lib/user";
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
 return handle(async () => { await requireRole("viewer", req); return Response.json(await searchBrandProducts((await ctx.params).slug, new URL(req.url).searchParams.get("q") ?? "")); });
}

