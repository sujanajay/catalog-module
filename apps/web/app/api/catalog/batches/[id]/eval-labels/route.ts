import { z } from "zod";
import { readEvalLabels,saveEvalLabel } from "../../../../../../lib/catalog/eval";
import { handle,readJson } from "../../../../../../lib/errors";
import { requireRole } from "../../../../../../lib/user";
export async function GET(req:Request,ctx:{params:Promise<{id:string}>}){return handle(async()=>{await requireRole("operator",req);return Response.json(await readEvalLabels((await ctx.params).id));});}
export async function POST(req:Request,ctx:{params:Promise<{id:string}>}){return handle(async()=>{const user=await requireRole("operator",req);const body=z.object({outputId:z.string().uuid(),label:z.enum(["pass","flag"]),reasons:z.array(z.string()).default([]),note:z.string().optional()}).parse(await readJson(req));return Response.json(await saveEvalLabel((await ctx.params).id,body,user.email));});}
