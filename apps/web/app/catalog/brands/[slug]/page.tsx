import "@/components/catalog/pages.css";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/user";
import { HttpError } from "@/lib/errors";
import { getBrand, searchBrandProducts } from "@/lib/catalog/brands";
import ProductSearch from "@/components/catalog/ProductSearch";
export default async function BrandPage({params}:{params:Promise<{slug:string}>}) {
 const user=await requireRole("viewer");const {slug}=await params;
 let brand;let products;try{[brand,products]=await Promise.all([getBrand(slug),searchBrandProducts(slug,"")]);}catch(err){if(err instanceof HttpError&&err.status===404)notFound();throw err;}
 return <main><a href="/catalog">← All batches</a><div className="hdr"><h1>{brand.name}</h1><span className="pill">{brand.line==="softline"?"Softline":"Hardline"}</span></div><ProductSearch slug={slug} brand={brand.name} initial={products} canAct={user.role!=="viewer"}/></main>;
}
