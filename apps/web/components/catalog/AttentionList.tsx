import type { AttentionProduct } from "@/lib/catalog/products";
import AttentionProductCard from "./AttentionProductCard";
export default function AttentionList({items,canAct}:{items:AttentionProduct[];canAct:boolean}) {
 return <><p className="lead">Everything else is done and in the sheet. Only the products below have a problem, and only the photos with a problem are shown. Your decision is applied to the links sheet straight away.</p><div className="att">{items.map(item=><AttentionProductCard key={item.productId} item={item} canAct={canAct}/>)}</div></>;
}
