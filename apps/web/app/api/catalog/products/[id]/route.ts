import { z } from "zod";
import { removeProduct } from "../../../../../lib/catalog/products";
import { handle, readJson } from "../../../../../lib/errors";
import { requireRole } from "../../../../../lib/user";
export async function DELETE(req:Request,ctx:{params:Promise<{id:string}>}) {
 return handle(async()=>{const user=await requireRole("operator",req);const body=z.object({confirm:z.string().min(1)}).parse(await readJson(req));await removeProduct((await ctx.params).id,body.confirm,user.email);return new Response(null,{status:204});});
}
