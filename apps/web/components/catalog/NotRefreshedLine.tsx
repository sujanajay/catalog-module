import { channel } from "@catalog/core/catalog/channels";
import type { ChannelId } from "@catalog/core/catalog/types";
export default function NotRefreshedLine({items}:{items:{channel:ChannelId;lastBatchId:string;lastBatchName:string}[]}) {
  const groups = new Map<string,typeof items>();
  for (const item of items) groups.set(item.lastBatchId,[...(groups.get(item.lastBatchId)??[]),item]);
  return <>{[...groups].map(([id,rows])=><p className="help" key={id}>Not refreshed in this batch: {rows.map(r=>channel(r.channel).label).join(", ")} (last delivered in batch <a href={`/catalog/${id}`}>{rows[0]!.lastBatchName}</a>)</p>)}</>;
}
