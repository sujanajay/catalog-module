import { eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { catalogBatches } from "../../db/schema";
import { checkCaps, type CapCheck } from "../../spend";
export async function checkCatalogCaps(db:Db,input:{batchId:string;env?:NodeJS.ProcessEnv;now?:Date}):Promise<CapCheck> {
 const [batch] = await db.select({brandSlug:catalogBatches.brandSlug}).from(catalogBatches).where(eq(catalogBatches.id,input.batchId));
 if (!batch) throw new Error("Batch not found.");
 return checkCaps(db,{...input,brandSlug:batch.brandSlug});
}
