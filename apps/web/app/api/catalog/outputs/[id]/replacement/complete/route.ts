import { z } from "zod";
import { finishReplacement } from "../../../../../../../lib/catalog/decisions";
import { handle,readJson } from "../../../../../../../lib/errors";
import { requireRole } from "../../../../../../../lib/user";
export async function POST(req:Request,ctx:{params:Promise<{id:string}>}){return handle(async()=>{const user=await requireRole("operator",req);const body=z.object({uploadId:z.string().uuid()}).parse(await readJson(req));return Response.json(await finishReplacement((await ctx.params).id,body.uploadId,user.email));});}
