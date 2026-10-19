import { z } from "zod";
import { decidePhoto } from "../../../../../../lib/catalog/decisions";
import { handle,readJson } from "../../../../../../lib/errors";
import { requireRole } from "../../../../../../lib/user";
export async function POST(req:Request,ctx:{params:Promise<{id:string}>}){return handle(async()=>{const user=await requireRole("operator",req);const body=z.object({decision:z.enum(["use_as_is","remove"])}).parse(await readJson(req));return Response.json(await decidePhoto((await ctx.params).id,body.decision,user.email));});}
