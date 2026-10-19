import { batchAttention } from "../../../../../../lib/catalog/products";
import { evalOutputs } from "../../../../../../lib/catalog/eval";
import { handle } from "../../../../../../lib/errors";
import { requireRole } from "../../../../../../lib/user";
export async function GET(req:Request,ctx:{params:Promise<{id:string}>}){return handle(async()=>{await requireRole("viewer",req);const id=(await ctx.params).id,q=new URL(req.url).searchParams;return Response.json(q.get("eval")==="1"?await evalOutputs(id,{page:Number(q.get("page")??0)||0,channel:q.get("channel")??"",verdict:q.get("verdict")??""}):await batchAttention(id));});}
