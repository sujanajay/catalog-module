// M1 D39, D41: the live proof of matte_agreement, and the job that sends the re-cuts. Both are subcommands of the Cloud Run job
// catalog-output-evals (infra/catalog-output-evals.sh proof | recut). `proof` calls the live judge, so it refuses to run without
// LIVE_SMOKE=1; it reads production sources, never writes to the database, and writes only under catalog-test/evals/<run>/.
// Model ids appear in the JSON report and the console only, never in operator copy.
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@catalog/core/db/client";
import { catalogOutputs, catalogProducts, catalogSourceImages } from "@catalog/core/db/schema";
import { AGREED_VARIANT, agreedMatte } from "@catalog/core/catalog/auto-resolve";
import { GUARD_PAD_FRACTION, resolveMatte, thirdOpinionModel } from "@catalog/core/catalog/matte-guard";
import { assertTestPrefix } from "@catalog/core/catalog/naming";
import { defaultPolicyFor } from "@catalog/core/catalog/qa/policy";
import { renderSource } from "@catalog/core/catalog/render";
import type { ProductType } from "@catalog/core/catalog/types";
import { EVALS_PREFIX } from "@catalog/core/catalog/evals/progress";
import * as gcs from "@catalog/core/storage";
import { enqueueTask } from "@catalog/core/tasks";
import { workerCatalogDeps } from "./catalog/deps";
import { liveQaEnabled } from "./catalog/qa-mock";
import { RECUT_ROUTE } from "./catalog/recut";

/** The 19 false rejections of Vero Moda batch 84a5a30a and its neighbours (.runs/2026-11-06-r1-defect-diagnosis.md): identifier and photo number. */
export const PROOF_REAL: readonly (readonly [string, number])[] = [
  ["10350171_5096307", 3], ["10350171_5096307", 4], ["10352996_5120445", 5], ["5715733309164", 5], ["5715907782472", 1], ["5715909336543", 1],
  ["Z0CDF734E919A8B135B2DZ", 2], ["Z281ABDF56606CCDC8E91Z", 2], ["Z40E29CD878FAA726501DZ", 1], ["Z5C2F10C8828D6C235D33Z", 1], ["Z5C2F10C8828D6C235D33Z", 4],
  ["Z66750C7A5D4EDDB0A0B8Z", 1], ["Z66750C7A5D4EDDB0A0B8Z", 2], ["Z66750C7A5D4EDDB0A0B8Z", 3], ["Z7E6C418C142A8955844CZ", 1], ["Z83A7DA7F6815765CDF92Z", 4],
  ["Z949E9B11B389AAF9A48BZ", 4], ["ZB58D59DC3872166C12DCZ", 3], ["ZE9DADA2214F2EA582424Z", 1],
];
/** Photos the guard rightly caught, from the golden set, each run as apparel (the only products agreement applies to, so the worst case). `agrees` is what they must do. */
export const PROOF_CONTROLS: readonly { path: string; agrees: boolean; why: string }[] = [
  { path: "penti/Z91D419FC9238E844BF77Z_4.jpg", agrees: false, why: "cut through the skin" },
  { path: "penti/ZBE55F7B86F158FEA0EB9Z_5.jpg", agrees: false, why: "ghost" },
  { path: "french_connection/Z15276411CE85C2E728DEZ_4.jpg", agrees: false, why: "candle" },
  { path: "french_connection/Z02B2EE44E3A08044B816Z_1.jpg", agrees: false, why: "bag in a hand" },
  { path: "french_connection/Z02B2EE44E3A08044B816Z_3.jpg", agrees: false, why: "logo-only" },
  { path: "french_connection/Z02B2EE44E3A08044B816Z_6.jpg", agrees: false, why: "logo-only" },
  { path: "french_connection/Z011CB57531CA8FA0CBDDZ_1.jpg", agrees: false, why: "lifestyle candle" },
  { path: "french_connection/ZEE79259BBFD83FFA1DB0Z_5.webp", agrees: true, why: "tennis court, both families cut the two models out cleanly" },
];
const GOLDEN_SOURCES = "catalog-test/evals/golden/sources";

export interface ProofRow { photo: string; group: "real" | "control"; why?: string; steps: string[]; model: string; agreed: boolean; busy: boolean; passthrough: boolean; verdict?: string; flags?: string[]; scores?: unknown; image?: string; pass: boolean; note: string }

/** What counts as passing. A real photo must end with a cut-out the judge has no visible defect to report on; a control must do what PROOF_CONTROLS says. */
export function proofVerdict(row: Pick<ProofRow, "group" | "agreed" | "busy" | "passthrough" | "flags">, expectAgreed: boolean): { pass: boolean; note: string } {
  const defect = (row.flags ?? []).filter(f => f === "product_removed" || f === "halo" || f === "leftover_background" || f === "text_or_watermark");
  if (row.group === "control") return row.agreed === expectAgreed ? { pass: true, note: "" } : { pass: false, note: row.agreed ? "agreed on a photo the guard rightly caught" : "expected agreement did not happen" };
  if (row.busy || row.passthrough) return { pass: false, note: "held or passed through" };
  return defect.length ? { pass: false, note: `judge: ${defect.join(", ")}` } : { pass: true, note: "" };
}

/** proof [--limit n]: real ladder, real render, live judge; report under catalog-test/evals/<run>/matte-proof/. */
export async function matteProofCommand(db: Db, flags: Record<string, string | string[] | true>): Promise<void> {
  if (!liveQaEnabled()) { console.error("proof calls the live judge: run it through bash infra/catalog-output-evals.sh proof (LIVE_SMOKE=1)"); process.exitCode = 2; return; }
  const deps = workerCatalogDeps(db), run = `proof-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`, prefix = `${EVALS_PREFIX}/${run}/matte-proof`;
  console.info(`Run id: ${run}`);
  const health = await deps.matting.health(), served = health.models.map(m => m.id), rows: ProofRow[] = [];
  const one = async (photo: string, n: number, raw: Buffer, name: string, type: ProductType, group: ProofRow["group"], control?: (typeof PROOF_CONTROLS)[number]) => {
    const policy = defaultPolicyFor(type === "apparel_flat" ? "apparel_flat" : "apparel_model"), p = await deps.prepare(raw, name, b => deps.matting.convert(b));
    const first = await deps.matteFor(p, deps.matting, policy.matteModel);
    const second = policy.matteModelSecond;
    const resolved = await resolveMatte({ prepared: p, first, handRule: false, attempt: async variant => {
      const model = variant === "padded_first" ? first.model : variant === "third" ? thirdOpinionModel(served, [first.model, ...(second ? [second] : [])]) : second;
      if (!model) return null;
      const next = await deps.matteFor(p, deps.matting, model, variant === "padded_first" || variant === "padded_second" ? { padFraction: GUARD_PAD_FRACTION } : {});
      return next.source === "model" ? next : null;
    } });
    const compliance = { auto_actions: resolved.actions }, agreed = agreedMatte(compliance);
    const rendered = await renderSource({ prepared: p, matte: resolved.matte, channel: "noon", shotNumber: n, productType: type, ...(agreed ? { keepSourceShadow: AGREED_VARIANT.keepSourceShadow, synthesiseShadow: AGREED_VARIANT.synthesiseShadow } : {}) });
    const row: ProofRow = { photo, group, ...(control ? { why: control.why } : {}), steps: resolved.actions.map(a => `${a.step}:${a.result} ${a.detail}`), model: resolved.matte.model, agreed, busy: resolved.busyBackground, passthrough: resolved.passthrough, pass: false, note: "" };
    if (rendered.jpeg) {
      row.image = `${prefix}/${photo}.jpg`; assertTestPrefix(row.image);
      await gcs.uploadBuffer(row.image, rendered.jpeg, "image/jpeg");
      const verdict = await deps.judgeOutput({ output: rendered.jpeg, original: raw, channel: "noon", anchor: "centre", productType: type, identifier: photo, n, model: policy.qaModel, threshold: policy.threshold, floor: policy.floor, ...(policy.qaModelSecond ? { secondModel: policy.qaModelSecond } : {}) });
      row.verdict = verdict.verdict; row.flags = verdict.flags; row.scores = verdict.scores;
    }
    Object.assign(row, proofVerdict(row, control?.agrees ?? true));
    rows.push(row);
    console.info(JSON.stringify({ photo, group, agreed, busy: row.busy, passthrough: row.passthrough, verdict: row.verdict, flags: row.flags, pass: row.pass, note: row.note }));
  };
  const limit = typeof flags.limit === "string" ? Number(flags.limit) : Infinity;
  for (const [identifier, n] of PROOF_REAL.slice(0, limit)) {
    const [source] = await db.select({ rawUri: catalogSourceImages.rawUri, type: catalogProducts.productType }).from(catalogSourceImages).innerJoin(catalogProducts, eq(catalogProducts.id, catalogSourceImages.productId)).where(and(eq(catalogProducts.identifier, identifier), eq(catalogSourceImages.n, n))).orderBy(desc(catalogSourceImages.createdAt)).limit(1);
    if (!source) { rows.push({ photo: `${identifier}_${n}`, group: "real", steps: [], model: "", agreed: false, busy: false, passthrough: false, pass: false, note: "source not found" }); continue; }
    await one(`${identifier}_${n}`, n, (await gcs.downloadBuffer(source.rawUri)).buf, `${identifier}_${n}.jpg`, source.type ?? "apparel_model", "real");
  }
  for (const control of PROOF_CONTROLS.slice(0, limit)) {
    const name = control.path.split("/").pop()!, n = Number(name.match(/_(\d+)\./)![1]);
    await one(name.replace(/\.\w+$/, ""), n, (await gcs.downloadBuffer(gcs.toGsUri(gcs.getBucketName(), `${GOLDEN_SOURCES}/${control.path}`))).buf, name, "apparel_model", "control", control);
  }
  const failed = rows.filter(r => !r.pass), reportPath = `${prefix}/report.json`;
  assertTestPrefix(reportPath);
  await gcs.uploadBuffer(reportPath, Buffer.from(JSON.stringify({ run, rows }, null, 1)), "application/json");
  console.info(`Matte proof: ${rows.length - failed.length} of ${rows.length} passed. Report: gs://${gcs.getBucketName()}/${reportPath}`);
  for (const f of failed) console.info(`FAILED ${f.photo}: ${f.note}`);
  if (failed.length) process.exitCode = 1;
}

/** Parses "identifier_n,identifier_n" into pairs. */
export function parsePhotoList(value: string): { identifier: string; n: number }[] {
  return value.split(",").map(item => {
    const m = item.trim().match(/^(.+)_(\d+)$/);
    if (!m) throw new Error(`Not an identifier_number: ${item}`);
    return { identifier: m[1]!, n: Number(m[2]) };
  });
}

/** recut --batch <id> --photos <identifier_n,...>: one task per photo; the worker does the rest. Lists what it sent and what it could not find. */
export async function recutCommand(db: Db, flags: Record<string, string | string[] | true>): Promise<void> {
  const batchId = flags.batch, photos = flags.photos;
  if (typeof batchId !== "string" || typeof photos !== "string") { console.error("recut needs --batch <id> and --photos <identifier_n,...>"); process.exitCode = 2; return; }
  const wanted = parsePhotoList(photos), identifiers = [...new Set(wanted.map(w => w.identifier))];
  const sources = await db.selectDistinct({ id: catalogSourceImages.id, n: catalogSourceImages.n, identifier: catalogProducts.identifier }).from(catalogSourceImages).innerJoin(catalogProducts, eq(catalogProducts.id, catalogSourceImages.productId)).innerJoin(catalogOutputs, eq(catalogOutputs.sourceImageId, catalogSourceImages.id)).where(and(eq(catalogSourceImages.batchId, batchId), inArray(catalogProducts.identifier, identifiers)));
  for (const w of wanted) {
    const source = sources.find(s => s.identifier === w.identifier && s.n === w.n);
    if (!source) { console.info(`not in this batch: ${w.identifier}_${w.n}`); process.exitCode = 1; continue; }
    await enqueueTask(RECUT_ROUTE, { batchId, sourceImageId: source.id }, { taskId: `recut-${source.id}-${Date.now()}` });
    console.info(`sent: ${w.identifier}_${w.n}`);
  }
}
