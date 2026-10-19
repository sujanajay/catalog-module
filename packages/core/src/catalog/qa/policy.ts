import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/client";
import { modelPolicy } from "../../db/schema";
import { CHANNELS, CHANNEL_ORDER } from "../channels";
import type { ChannelId, OutputFlag, ProductType, ResolvedPolicy } from "../types";
import { QA_DEFAULT_FLOOR, QA_DEFAULT_THRESHOLD } from "./judge";
import { CATALOG_QA_DEFAULT_MODEL } from "./classify";
type Category = Exclude<ProductType,"auto">;
const common = {qaModel:CATALOG_QA_DEFAULT_MODEL,qaModelSecond:"anthropic/claude-haiku-5.5",threshold:QA_DEFAULT_THRESHOLD,floor:QA_DEFAULT_FLOOR,qaMode:"per_source",qaSampleRate:1,source:"default"} as const;
export const DEFAULT_POLICIES: Record<Category,ResolvedPolicy> = {
 footwear:{...common,matteModel:"birefnet-general",matteModelSecond:"bria-rmbg",shadowMode:"preserve_else_synthesise"},
 apparel_model:{...common,matteModel:"birefnet-hr-matting",matteModelSecond:"birefnet-dynamic-matting",shadowMode:"preserve_only"},
 apparel_flat:{...common,matteModel:"bria-rmbg",matteModelSecond:"birefnet-general",shadowMode:"preserve_only"},
 bag_accessory:{...common,matteModel:"birefnet-general",matteModelSecond:"birefnet-hr-matting",shadowMode:"preserve_else_synthesise"},
 other:{...common,matteModel:"bria-rmbg",matteModelSecond:"birefnet-dynamic-matting",shadowMode:"preserve_else_synthesise"},
};
export interface PolicyHealth {models: readonly {id:string;target?:"cpu"|"gpu";inputSize?:number|"native"}[]; default:string}
/**
 * The built-in row as the matting services can serve it: the first matte model when `/health` lists
 * it, else the second, else the service default. Without a health listing the table is kept as is.
 */
export function defaultPolicyFor(category: Category, health?: PolicyHealth): ResolvedPolicy {
 const policy = {...DEFAULT_POLICIES[category]};
 if (!health?.models.length) return policy;
 const listed = (id?: string) => !!id && health.models.some(m => m.id === id);
 const matteModel = [policy.matteModel,policy.matteModelSecond].find(listed) ?? (health.default || policy.matteModel);
 return {...policy,matteModel};
}
/** Check-then-insert one `source = "default"` row per category; never overwrites an existing row. */
export async function ensureDefaultPolicies(db: Db, health?: PolicyHealth): Promise<void> {
 for (const category of Object.keys(DEFAULT_POLICIES) as Category[]) {
  const [existing] = await db.select({id:modelPolicy.id}).from(modelPolicy).where(and(eq(modelPolicy.brandSlug,"*"),eq(modelPolicy.category,category))).limit(1);
  if (!existing) await db.insert(modelPolicy).values({brandSlug:"*",category,...defaultPolicyFor(category,health)}).onConflictDoNothing({target:[modelPolicy.brandSlug,modelPolicy.category]});
 }
}
export async function resolvePolicy(db: Db, brandSlug: string, category: ProductType | "*"): Promise<ResolvedPolicy> {
 const rows = await db.select().from(modelPolicy).where(and(inArray(modelPolicy.brandSlug,[brandSlug,"*"]),inArray(modelPolicy.category,[category,"*"])));
 const row = [[brandSlug,category],[brandSlug,"*"],["*",category],["*","*"]].map(([brand,cat]) => rows.find(r => r.brandSlug === brand && r.category === cat)).find(Boolean);
 if (!row) return {...DEFAULT_POLICIES[category === "*" || category === "auto" ? "other" : category]};
 return {matteModel:row.matteModel,qaModel:row.qaModel,threshold:row.threshold,floor:row.floor,qaMode:row.qaMode,qaSampleRate:row.qaSampleRate,source:row.source,...(row.matteTarget ? {matteTarget:row.matteTarget} : {}),...(row.matteModelSecond ? {matteModelSecond:row.matteModelSecond} : {}),...(row.shadowMode ? {shadowMode:row.shadowMode} : {}),...(row.qaModelSecond ? {qaModelSecond:row.qaModelSecond} : {})};
}
/**
 * 05 rule 3 as the worker applies it: a synthesised shadow is allowed only for a product whose own
 * classification (07 4.3, or the type the operator chose for the batch) is footwear, bag_accessory
 * or other. Apparel on a model or laid flat never gets one. A product without a real classification
 * (no type, the "auto" placeholder, or `type_unknown` after a failed, capped or mocked classifier)
 * gets none either: a missing shadow is a smaller defect than a fake one. Brand line and SKU rows
 * are not inputs.
 */
export function shadowSynthesisAllowed(productType: ProductType | null | undefined, flags: readonly OutputFlag[]): boolean {
 if (!productType || productType === "auto" || flags.includes("type_unknown")) return false;
 return productType === "footwear" || productType === "bag_accessory" || productType === "other";
}
export function strictestChannel(channels: readonly ChannelId[]): ChannelId {
 if (channels.includes("styli")) return "styli";
 const result = CHANNEL_ORDER.filter(id => channels.includes(id)).sort((a,b) => CHANNELS[b].targetCanvas.w*CHANNELS[b].targetCanvas.h - CHANNELS[a].targetCanvas.w*CHANNELS[a].targetCanvas.h)[0];
 if (!result) throw new Error("Choose at least one marketplace before checking image quality.");
 return result;
}
export function sampledForQa(identifier: string, rate: number): boolean {
 if (rate >= 1) return true;
 if (rate <= 0) return false;
 return createHash("sha256").update(identifier).digest().readUInt32BE(0) / 0x1_0000_0000 < rate;
}
