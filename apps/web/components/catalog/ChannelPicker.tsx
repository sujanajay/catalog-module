"use client";
import type { ChannelId } from "@catalog/core/catalog/types";
export const CHANNEL_CHOICES: {id:ChannelId;label:string;rule:string;group:1|2}[] = [
{id:"namshi",label:"Namshi",group:1,rule:"1080 x 1480, light grey background, 10% space above and below"},
{id:"noon",label:"Noon",group:1,rule:"1080 x 1480, light grey background, 10% space above and below, 5% at the sides"},
{id:"trendyol",label:"Trendyol",group:1,rule:"1200 x 1800, light grey background, no spaces in file names"},
{id:"amazon",label:"Amazon",group:1,rule:"2000 x 2000. First image on pure white, the rest light grey"},
{id:"styli",label:"Styli",group:2,rule:"2342 x 3123, light grey, product at the bottom centre inside Styli's guides, same placement on every angle"},
{id:"sixthstreet",label:"6thStreet",group:2,rule:"2000 x 2667, light grey background"},
{id:"centrepoint",label:"Centrepoint",group:2,rule:"3000 x 3000 square, light grey background. Nothing is cropped; space is added at the sides"},
{id:"vogacloset",label:"VogaCloset",group:2,rule:"2000 x 2667, light grey background"},
{id:"shein",label:"Shein",group:2,rule:"2000 x 2000. First image on pure white, the rest light grey"}
];
export default function ChannelPicker({channels,onChange}:{channels:ChannelId[];onChange(value:ChannelId[]):void}){
 return <>{([1,2] as const).map((group)=><section key={group}><h3 style={{margin:"20px 0 8px"}}>{group===1?"Usually listed first":"Also available"}</h3><div className="chan">{CHANNEL_CHOICES.filter((c)=>c.group===group).map((c)=><label key={c.id} className="opt"><input type="checkbox" checked={channels.includes(c.id)} onChange={(e)=>onChange(e.target.checked?[...channels,c.id]:channels.filter((id)=>id!==c.id))}/><span><b>{c.label}</b><small>{c.rule}</small></span></label>)}</div></section>)}</>;
}
