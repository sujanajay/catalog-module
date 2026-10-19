import { z } from "zod";
import { replacementUpload } from "../../../../../../lib/catalog/decisions";
import { handle,readJson } from "../../../../../../lib/errors";
import { requireRole } from "../../../../../../lib/user";
export async function POST(req:Request,ctx:{params:Promise<{id:string}>}){return handle(async()=>{const user=await requireRole("operator",req);const body=z.object({name:z.string(),size:z.number(),mime:z.string()}).parse(await readJson(req));return Response.json(await replacementUpload((await ctx.params).id,body));});}
