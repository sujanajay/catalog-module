import { channel } from "@catalog/core/catalog/channels";
import { CHANNEL_IDS, type ChannelId } from "@catalog/core/catalog/types";
import type { ProductCompare } from "../../lib/catalog/compare";
import CompareGrid from "./CompareGrid";

/** Each current photo's original next to its live image per channel, then the live links to copy. */
export default function ProductImages({images,compare}:{images:{id:string;channel:ChannelId;n:number;publicUrl:string}[];compare:ProductCompare}) {
 return <section><h2>Live images</h2>{!images.length && <p>No live images yet.</p>}{compare.rows.length>0 && compare.channels.length>0 && <CompareGrid rows={compare.rows.map(r=>({key:String(r.n),n:r.n,originalUrl:r.originalUrl,cells:r.cells}))} channels={compare.channels} missing="No live image" badges={false}/>}{CHANNEL_IDS.filter(c=>images.some(i=>i.channel===c)).map(c=><div key={c}><h3>{channel(c).label}</h3><ul className="product-links">{images.filter(i=>i.channel===c).map(i=><li key={i.id}>Photo {i.n}: <a className="mono" href={i.publicUrl}>{i.publicUrl}</a></li>)}</ul></div>)}</section>;
}
