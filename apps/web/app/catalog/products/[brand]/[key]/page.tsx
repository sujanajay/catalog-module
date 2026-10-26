import "@/components/catalog/pages.css";
import { notFound } from "next/navigation";
import { productPrefix, publicUrl } from "@catalog/core/catalog/naming";
import { channel } from "@catalog/core/catalog/channels";
import { getPublicBucketName } from "@catalog/core/storage";
import { requireRole } from "@/lib/user";
import { HttpError } from "@/lib/errors";
import { getProduct } from "@/lib/catalog/products";
import { getBrand } from "@/lib/catalog/brands";
import { ActionOnly } from "@/components/ViewerPreview";
import ProductImages from "@/components/catalog/ProductImages";
import ProductEvents from "@/components/catalog/ProductEvents";
import ProductBatches from "@/components/catalog/ProductBatches";
import { productCompare } from "@/lib/catalog/compare";
import AddAliasForm from "@/components/catalog/AddAliasForm";
import RemoveProductDialog from "@/components/catalog/RemoveProductDialog";
import { ProductDownload } from "@/components/catalog/ProductSearch";
export default async function ProductPage({params,searchParams}:{params:Promise<{brand:string;key:string}>;searchParams:Promise<{test?:string}>}) {
 const user=await requireRole("viewer");const {brand,key}=await params;const isTest=(await searchParams).test==="1";
 let product;let brandRow;try{[product,brandRow]=await Promise.all([getProduct(brand,key,isTest),getBrand(brand)]);}catch(err){if(err instanceof HttpError&&err.status===404)notFound();throw err;}
 const p=product;const compare=await productCompare(p.id);const channels=[...new Set(p.images.map(i=>i.channel))].map(c=>channel(c).label).join(", ");
 return <main><a href={`/catalog/brands/${brand}`}>← {brandRow.name}</a><h1 className="mono">{p.identifier}</h1><p className="lead">{brandRow.name} · {p.pathKey}{p.isTest&&<> · <span className="pill">Test</span></>}</p><p className="mono">{publicUrl(getPublicBucketName(),productPrefix(brand,p.pathKey,p.isTest))}</p>{p.lockedBy ? <p>Being processed in batch <a href={`/catalog/${p.lockBatchId}`}>{p.lockedBy}</a></p> : user.role!=="viewer"&&<ActionOnly><div className="acts"><ProductDownload slug={brand} id={p.id}/><RemoveProductDialog id={p.id} identifier={p.identifier} brand={brand} channels={channels}/></div></ActionOnly>}<ProductImages images={p.images} compare={compare}/><ProductBatches batches={compare.batches} identifier={p.identifier}/><section><h2>Opptra SKU ids</h2><p>{p.opptraSkuIds.length?p.opptraSkuIds.join("; "):"None yet. They are filled in automatically when the warehouse knows this product, or from a mapping sheet on the batch page."}</p>{p.optionIdStyleColor&&<p>option_id_style_color: <span className="mono">{p.optionIdStyleColor}</span></p>}</section><section><h2>Also known as</h2><ul>{p.aliases.map(a=><li key={a.aliasKey}><span className="mono">{a.aliasKey}</span> · {a.kind.replace(/_/g," ")}</li>)}</ul>{user.role!=="viewer"&&<ActionOnly><AddAliasForm id={p.id} identifier={p.identifier}/></ActionOnly>}</section><ProductEvents events={p.events}/></main>;
}
