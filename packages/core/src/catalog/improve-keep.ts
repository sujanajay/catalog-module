// M1-S4: the delivered outputs of a photo, kept on its catalog_improvements row (`previous`) while the photo is re-made
// (an improvement try, or Try again on an auto-decide batch's delivered slot). The publish puts back every re-made slot
// that did not pass (improve.ts restoreUnpassedImprovements), so a re-make never downgrades a delivered link. Its own
// module so decisions.ts and improve.ts both use it without importing each other.
import { inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { catalogImprovements } from "../db/schema";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Keeps `outputIds` (rows of catalog_outputs as JSON) on the photo's improvement row, made when none exists. */
export async function keepDeliveredOutputs(tx: Tx, key: { batchId: string; productId: string; sourceImageId: string }, outputIds: readonly string[], now: Date): Promise<void> {
  const [row] = await tx.insert(catalogImprovements).values(key)
    .onConflictDoUpdate({ target: [catalogImprovements.batchId, catalogImprovements.sourceImageId], set: { updatedAt: now } }).returning({ id: catalogImprovements.id });
  await tx.execute(sql`UPDATE catalog_improvements SET previous = (SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id) FROM catalog_outputs AS o WHERE ${inArray(sql`o.id`, [...outputIds])}) WHERE id = ${row!.id}`);
}
