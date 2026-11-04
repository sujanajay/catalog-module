// M3-S1 (M3-F3-R3, M3 3.4 need 2): a listing held by a running experiment is never planned for a new render. The
// render planner asks this once per product before it plans any output; a channel returned here keeps whatever is live
// on it (nothing is cut out, rendered or published for it in this batch).
import { and, eq, inArray } from "drizzle-orm";
import { catalogChannelListings } from "../db/schema";
import { isWritable, type GraphDb } from "../graph";
import type { ChannelId } from "./types";

export interface FrozenChannel {
  channel: ChannelId;
  reason: "frozen_control" | "frozen_treatment";
  experimentId: string;
}

/**
 * The channels of `channels` on which the option has a listing M0's guard refuses (isWritable with no experiment id:
 * a frozen control, or a frozen treatment of an experiment this render is not part of). Any market of the channel
 * counts: one render feeds every market of a channel. An option with no key resolved yet (null) has no listing, so
 * nothing is frozen.
 */
export async function frozenChannels(db: GraphDb, optionId: string | null, channels: readonly ChannelId[]): Promise<FrozenChannel[]> {
  if (!optionId || !channels.length) return [];
  const listings = await db
    .select({ id: catalogChannelListings.id, channel: catalogChannelListings.channel })
    .from(catalogChannelListings)
    .where(and(eq(catalogChannelListings.optionId, optionId), inArray(catalogChannelListings.channel, [...channels])));
  const frozen = new Map<ChannelId, FrozenChannel>();
  for (const listing of listings) {
    if (frozen.has(listing.channel)) continue;
    const writable = await isWritable(db, listing.id);
    if (!writable.ok) frozen.set(listing.channel, { channel: listing.channel, reason: writable.reason, experimentId: writable.experimentId });
  }
  return channels.flatMap((c) => frozen.get(c) ?? []);
}
