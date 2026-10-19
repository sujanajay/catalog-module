import { listBrandOptions } from "@catalog/core/catalog/brands";
import CatalogWizard from "../../../components/catalog/CatalogWizard";
import { db } from "../../../lib/db";
import { requireRole } from "../../../lib/user";
export const dynamic = "force-dynamic";
// Operator: a viewer cannot create a draft or upload files.
export default async function NewBatchPage({ searchParams }: { searchParams: Promise<{brand?: string}> }) {
  await requireRole("operator");
  const [brands, query] = await Promise.all([listBrandOptions(db()), searchParams]);
  const initialBrand = brands.some((brand) => brand.slug === query.brand) ? query.brand : undefined;
  return <main><CatalogWizard brands={brands} initialBrand={initialBrand} shareEmail={process.env.SHARE_SA_EMAIL ?? ""}/></main>;
}
