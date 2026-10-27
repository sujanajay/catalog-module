import { redirect } from "next/navigation";
import { listBrandOptions } from "@catalog/core/catalog/brands";
import CatalogWizard, { type WizardInitialBatch } from "../../../components/catalog/CatalogWizard";
import { BATCH_NOT_FOUND, getBatch } from "../../../lib/catalog/batches";
import { canContinueSettingUp } from "../../../lib/catalog/copy";
import { isUuid } from "../../../lib/catalog/uuid";
import { db } from "../../../lib/db";
import { HttpError } from "../../../lib/errors";
import { requireRole } from "../../../lib/user";
export const dynamic = "force-dynamic";

/**
 * `?batch=<id>` reopens an existing batch (spec 14a F4 part 1). Only a draft or collecting batch that has
 * not started opens the wizard; any other batch (failed, cancelled, started) goes to its batch page.
 * Returns null when the batch does not exist.
 */
async function resumeBatch(id: string): Promise<WizardInitialBatch | null> {
  if (!isUuid(id)) return null;
  let found: Awaited<ReturnType<typeof getBatch>>;
  try { found = await getBatch(id); } catch (err) { if (err instanceof HttpError && err.status === 404) return null; throw err; }
  const { batch, state, uploads } = found;
  if (!canContinueSettingUp(batch)) redirect(`/catalog/${batch.id}`);
  return {
    id: batch.id, brandSlug: batch.brandSlug, name: batch.name, productType: batch.productType, channels: batch.channels,
    options: { identifierMode: batch.options.identifierMode, precedence: batch.options.precedence },
    uploads: uploads.map((u) => ({ status: u.status })), counts: batch.counts, status: batch.status, state,
  };
}

// Operator: a viewer cannot create a draft or upload files.
export default async function NewBatchPage({ searchParams }: { searchParams: Promise<{brand?: string; batch?: string}> }) {
  await requireRole("operator");
  const [brands, query] = await Promise.all([listBrandOptions(db()), searchParams]);
  const shareEmail = process.env.SHARE_SA_EMAIL ?? "";
  if (query.batch !== undefined) {
    const initialBatch = await resumeBatch(query.batch);
    if (!initialBatch) return <main><p role="alert">{BATCH_NOT_FOUND}</p><p><a className="btn ghost" href="/catalog">All batches</a></p></main>;
    return <main><CatalogWizard brands={brands} initialBatch={initialBatch} shareEmail={shareEmail}/></main>;
  }
  const initialBrand = brands.some((brand) => brand.slug === query.brand) ? query.brand : undefined;
  return <main><CatalogWizard brands={brands} initialBrand={initialBrand} shareEmail={shareEmail}/></main>;
}
