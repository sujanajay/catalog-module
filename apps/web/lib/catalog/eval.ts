import { and,asc,eq } from "drizzle-orm";
import { catalogBatches,catalogEvalLabels,catalogOutputs,catalogProducts,catalogSourceImages } from "@catalog/core/db/schema";
import { signedUrl } from "@catalog/core/storage";
import { channel } from "@catalog/core/catalog/channels";
import type { ChannelId } from "@catalog/core/catalog/types";
import { flagDetails } from "@catalog/core/catalog/qa/reasons";
import { db,type Db } from "../db";
import { badRequest,HttpError } from "../errors";
export const EVAL_REASONS=["complete_product","different_product","halo","leftover_background","text_or_watermark","orientation","placement"] as const;
const dimensions=["complete_product","same_product","edge_quality","background_clean","no_text_or_watermark","orientation_ok","placement_ok","overall"];
function snapshot(raw:Record<string,unknown>|null){return Object.fromEntries(dimensions.flatMap(k=>typeof raw?.[k]==="number"?[[k,raw[k]]]:[]));}
async function evalBatch(id:string,conn:Db){const [batch]=await conn.select().from(catalogBatches).where(eq(catalogBatches.id,id));if(!batch)throw new HttpError(404,"This batch was not found. Return to All batches.");if(!batch.isTest||!batch.options.evalSet)throw badRequest("Labels are only available on evaluation test batches.");return batch;}
export async function saveEvalLabel(batchId:string,input:{outputId:string;label:"pass"|"flag";reasons:string[];note?:string},actor:string,conn:Db=db()){
 const batch=await evalBatch(batchId,conn);
 if(input.reasons.some(r=>!EVAL_REASONS.includes(r as typeof EVAL_REASONS[number])))throw badRequest("Choose the reasons shown on this page.");
 const [row]=await conn.select({output:catalogOutputs,identifier:catalogProducts.identifier}).from(catalogOutputs).innerJoin(catalogProducts,eq(catalogProducts.id,catalogOutputs.productId)).where(and(eq(catalogOutputs.batchId,batchId),eq(catalogOutputs.id,input.outputId)));
 if(!row)throw new HttpError(404,"This photo does not belong to this batch.");
 const o=row.output,verdict=o.qaScores?.verdict;
 const [label]=await conn.insert(catalogEvalLabels).values({batchId,outputId:o.id,sourceImageId:o.sourceImageId,setName:batch.options.evalSet!,identifier:row.identifier,channel:o.channel,labeler:actor,label:input.label,reasons:input.reasons,note:input.note??null,judgeVerdict:verdict==="pass"||verdict==="flag"?verdict:o.status==="verified"?"pass":"flag",judgeScores:snapshot(o.qaScores)}).returning();
 return {id:label!.id,label:label!.label};
}
export async function readEvalLabels(batchId:string,conn:Db=db()){await evalBatch(batchId,conn);const rows=await conn.select().from(catalogEvalLabels).where(eq(catalogEvalLabels.batchId,batchId)).orderBy(asc(catalogEvalLabels.createdAt));return rows.map(row=>({...row,judgeScores:snapshot(row.judgeScores)}));}
export async function evalOutputs(batchId:string,input:{page?:number;channel?:string;verdict?:string}={},conn:Db=db(),sign=signedUrl){
 await evalBatch(batchId,conn);
 const rows=await conn.select({output:catalogOutputs,source:catalogSourceImages,identifier:catalogProducts.identifier}).from(catalogOutputs).innerJoin(catalogProducts,eq(catalogProducts.id,catalogOutputs.productId)).innerJoin(catalogSourceImages,eq(catalogSourceImages.id,catalogOutputs.sourceImageId)).where(eq(catalogOutputs.batchId,batchId)).orderBy(asc(catalogProducts.identifier),asc(catalogOutputs.n),asc(catalogOutputs.channel));
 const filtered=rows.filter(({output:o})=>(!input.channel||o.channel===input.channel)&&(!input.verdict||(o.qaScores?.verdict??(o.status==="verified"?"pass":"flag"))===input.verdict));
 const page=Math.max(0,Math.floor(input.page??0));
 const items=await Promise.all(filtered.slice(page*50,(page+1)*50).map(async({output:o,source,identifier})=>({outputId:o.id,identifier,n:o.n,channel:o.channel as ChannelId,originalUrl:await sign(source.rawUri),outputUrl:o.stagingUri?await sign(o.stagingUri):o.isLive?o.publicUrl:null,verdict:o.qaScores?.verdict==="pass"?"pass":"flag",why:o.flags.map(f=>flagDetails(f,{n:o.n,channel:channel(o.channel).label}).why).join(" ")})));
 return {items,total:filtered.length,page};
}
export type EvalPage=Awaited<ReturnType<typeof evalOutputs>>;
