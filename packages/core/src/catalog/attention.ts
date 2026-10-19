import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { catalogBatches,catalogOutputs,catalogProducts,catalogSourceImages } from "../db/schema";
import { channel } from "./channels";
import type { ChannelId,OutputFlag } from "./types";
import { strictestChannel } from "./qa/policy";
import { MAX_REASONS_PER_PHOTO,bySeverity,flagDetails,problemLine,severityRank } from "./qa/reasons";
import { INFORMATION_FLAGS } from "./qa/triage";
export interface AttentionPhoto { n:number;channel:ChannelId;outputId:string;outputIds:string[];originalUrl:string;outputUrl:string|null;why:string;whatToDo:string;liveObjectExists:boolean;liveChannels:ChannelId[];failed:boolean;flags:OutputFlag[] }
export interface AttentionProduct { productId:string;identifier:string;totalShots:number;problemLine:string;photos:AttentionPhoto[] }
const information = INFORMATION_FLAGS;
const local = (flag:OutputFlag)=>flag==="placement" || flag==="failed_compliance" || flag==="low_resolution";
export async function listAttention(db:Db,batchId:string,sign:(uri:string)=>Promise<string>):Promise<AttentionProduct[]> {
 const [batch]=await db.select().from(catalogBatches).where(eq(catalogBatches.id,batchId));
 if(!batch) return [];
 const rows=await db.select({output:catalogOutputs,source:catalogSourceImages,identifier:catalogProducts.identifier}).from(catalogOutputs).innerJoin(catalogSourceImages,eq(catalogOutputs.sourceImageId,catalogSourceImages.id)).innerJoin(catalogProducts,eq(catalogOutputs.productId,catalogProducts.id)).where(and(eq(catalogOutputs.batchId,batchId),isNull(catalogOutputs.decision),inArray(catalogOutputs.status,["needs_attention","failed"]))).orderBy(asc(catalogProducts.identifier),asc(catalogOutputs.n),asc(catalogOutputs.channel));
 if(!rows.length)return [];
 const ids=[...new Set(rows.map(r=>r.output.productId))];
 const [live,sources]=await Promise.all([
 db.select({productId:catalogOutputs.productId,n:catalogOutputs.n,channel:catalogOutputs.channel}).from(catalogOutputs).where(and(inArray(catalogOutputs.productId,ids),eq(catalogOutputs.isLive,true),inArray(catalogOutputs.channel,batch.channels))),
 db.select({productId:catalogSourceImages.productId,n:catalogSourceImages.n}).from(catalogSourceImages).where(and(eq(catalogSourceImages.batchId,batchId),inArray(catalogSourceImages.productId,ids)))
 ]);
 const groups=new Map<string,typeof rows>();
 for(const row of rows){
  // Every held output stays listed, even one carrying only information flags (a row held before a
  // flag became note-only), so no product can be held without a way to resolve it (R20).
  const shared=row.output.status==="failed"||!row.output.flags.length||row.output.flags.some(f=>!local(f)&&!information.has(f));
  const key=row.output.productId+":"+row.output.sourceImageId+(shared?"":":"+row.output.channel);
  groups.set(key,[...(groups.get(key)??[]),row]);
 }
 const products=new Map<string,AttentionProduct>();
 for(const siblings of groups.values()){
  const preferred=batch.channels.length?strictestChannel(batch.channels):siblings[0]!.output.channel;
  const row=siblings.find(r=>r.output.channel===preferred)??siblings[0]!,o=row.output;
  // Worst first (FLAG_SEVERITY), so the photo's lead sentence is its main problem.
  const flags=bySeverity(siblings.flatMap(r=>r.output.flags)),problemFlags=flags.filter(f=>!information.has(f));
  const flag=o.status==="failed"?"failed":problemFlags[0]??flags[0]??"qa_unavailable";
  const spec=channel(o.channel);
  const context={n:o.n,k:batch.channels.length,channel:spec.label,...(row.source.width!==null&&row.source.height!==null?{w:row.source.width,h:row.source.height}:{}),min:Math.max(spec.minCanvas.w,spec.minCanvas.h),failures:o.reason??"",...(o.status==="failed"&&o.error?{error:o.error}:{})};
  // Why: the main problem first, then any other problem, then information notes on the same photo (4.6).
  // What to do: one instruction, the main problem's; information flags never add guidance of their own.
  // At most MAX_REASONS_PER_PHOTO problem sentences; the report keeps every flag.
  const main=flagDetails(flag,context),others=[...problemFlags.filter(f=>f!==flag).slice(0,MAX_REASONS_PER_PHOTO-1),...flags.filter(f=>information.has(f))].map(f=>flagDetails(f,context));
  const liveChannels=[...new Set(live.filter(l=>l.productId===o.productId&&l.n===o.n&&(siblings.length>1||!flags.every(local)||l.channel===o.channel)).map(l=>l.channel))];
  const photo:AttentionPhoto={n:o.n,channel:o.channel,outputId:o.id,outputIds:siblings.map(r=>r.output.id),originalUrl:await sign(row.source.rawUri),outputUrl:o.stagingUri?await sign(o.stagingUri):null,why:[main,...others].map(d=>d.why).join(" "),whatToDo:main.whatToDo,liveObjectExists:liveChannels.length>0,liveChannels,failed:siblings.some(r=>r.output.status==="failed"),flags};
  const product=products.get(o.productId)??{productId:o.productId,identifier:row.identifier,totalShots:new Set(sources.filter(s=>s.productId===o.productId).map(s=>s.n)).size,problemLine:"",photos:[]};
  product.photos.push(photo);products.set(o.productId,product);
 }
 // The worst photo first, then by photo number, so the card's line opens with the main problem.
 const rank=(p:AttentionPhoto)=>severityRank(p.failed?"failed":p.flags.find(f=>!information.has(f))??p.flags[0]??"qa_unavailable");
 for(const p of products.values()) p.photos.sort((a,b)=>rank(a)-rank(b)||a.n-b.n);
 for(const p of products.values()) p.problemLine=problemLine(p.photos.map(p=>({n:p.n,flag:p.failed?"failed":p.flags.find(f=>!information.has(f))??p.flags[0],channel:channel(p.channel).label})));
 return [...products.values()].sort((a,b)=>a.identifier.localeCompare(b.identifier));
}
