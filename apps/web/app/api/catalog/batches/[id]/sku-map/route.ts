import { addSkuMap } from "../../../../../../lib/catalog/sku-map";
import { handle,badRequest } from "../../../../../../lib/errors";
import { requireRole } from "../../../../../../lib/user";
export async function POST(req:Request,ctx:{params:Promise<{id:string}>}){return handle(async()=>{const user=await requireRole("operator",req);const form=await req.formData();const file=form.get("file");if(!(file instanceof File))throw badRequest("Choose an xlsx or csv mapping sheet.");return Response.json(await addSkuMap((await ctx.params).id,file,user.email));});}
