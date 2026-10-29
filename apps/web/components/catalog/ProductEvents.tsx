import { when } from "@/components/ui";
import { channel } from "@catalog/core/catalog/channels";
import { CHANNEL_IDS, type ChannelId, type EventKind } from "@catalog/core/catalog/types";
type Event = {id:string;kind:EventKind;actor:string;at:Date;details:Record<string,unknown>;batchId:string|null;batchName:string|null};
const names:Record<EventKind,string> = {created:"First delivered",overwritten:"Pictures replaced",shots_removed:"Photos removed",channel_added:"Marketplace added",unchanged:"Pictures unchanged",reordered:"Photos reordered",sku_ids_added:"Opptra SKU ids added",alias_added:"Alias added",removed_photo:"Photo removed",replacement_uploaded:"Replacement uploaded",restored:"Pictures restored",removed:"Product removed",enlargement_retried:"Enlargement tried again",plain_accepted:"Used as it is after the enlargement warning"};
export default function ProductEvents({events}:{events:Event[]}) {
 return <section><h2>History</h2><ol className="history">{events.map(e=><li key={e.id}>{when(e.at)} · {names[e.kind]} · {e.actor}{e.batchId && <> · {e.kind==="created" ? "First delivered in batch " : "batch "}<a href={`/catalog/${e.batchId}`}>{e.batchName ?? e.batchId}</a></>}{Array.isArray(e.details.channels) && <> · on {e.details.channels.filter((c):c is ChannelId=>CHANNEL_IDS.includes(c as ChannelId)).map(c=>channel(c).label).join(", ")}</>}{Array.isArray(e.details.shots) && <> · Photos {e.details.shots.filter(n=>typeof n==="number").join(", ")}</>}{typeof e.details.aliasKey==="string" && <> · {e.details.aliasKey}</>}</li>)}</ol></section>;
}
