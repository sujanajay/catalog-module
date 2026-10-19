import { channel } from "@catalog/core/catalog/channels";
import { CHANNEL_IDS, type ChannelId } from "@catalog/core/catalog/types";
export default function ProductImages({images}:{images:{id:string;channel:ChannelId;n:number;publicUrl:string}[]}) {
 return <section><h2>Live images</h2>{!images.length && <p>No live images yet.</p>}{CHANNEL_IDS.filter(c=>images.some(i=>i.channel===c)).map(c=><div key={c}><h3>{channel(c).label}</h3><div className="product-images">{images.filter(i=>i.channel===c).map(i=><figure key={i.id}><a href={i.publicUrl}><img src={i.publicUrl} alt={`Photo ${i.n} for ${channel(c).label}`}/></a><figcaption>Photo {i.n}<br/><a href={i.publicUrl}>{i.publicUrl}</a></figcaption></figure>)}</div></div>)}</section>;
}
