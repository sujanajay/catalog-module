// M1 D40, D42: the live proof of matte_agreement, and the job that sends the re-cuts. Both are subcommands of the Cloud Run job
// catalog-output-evals (infra/catalog-output-evals.sh proof | recut). `proof` calls the live judge, so it refuses to run without
// LIVE_SMOKE=1; it first runs the judge exam (M1 D43); it reads production sources, writes images and its report only under catalog-test/evals/<run>/, and in the
// database only one cost ledger row per judging, with no batch. It ends with a verdict a person can read: PROOF PASS or PROOF
// FAIL in the job's log, and verdict.txt and report.html (every image, its result and why) beside the images.
// Model ids appear in the JSON report and the console only, never in operator copy.
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import sharp from "sharp";
import type { Db } from "@catalog/core/db/client";
import { catalogOutputs, catalogProducts, catalogSourceImages } from "@catalog/core/db/schema";
import { AGREED_VARIANT, agreedMatte } from "@catalog/core/catalog/auto-resolve";
import { backgroundRegion, GUARD_PAD_FRACTION, matteAgreement, resolveMatte, thirdOpinionModel } from "@catalog/core/catalog/matte-guard";
import { assertTestPrefix } from "@catalog/core/catalog/naming";
import { renderSource, type Matte } from "@catalog/core/catalog/render";
import type { ChannelId, ProductType } from "@catalog/core/catalog/types";
import { EVALS_PREFIX } from "@catalog/core/catalog/evals/progress";
import { recordCostEvent } from "@catalog/core/cost-events";
import * as gcs from "@catalog/core/storage";
import { runJudgeExam } from "./catalog-judge-exam";
import { workerCatalogDeps } from "./catalog/deps";
import { liveQaEnabled } from "./catalog/qa-mock";
import { recutProductPhotos } from "./catalog/recut";

/** The 19 false rejections of Vero Moda batch 84a5a30a and its neighbours (.runs/2026-11-06-r1-defect-diagnosis.md): identifier and photo number. */
export const PROOF_REAL: readonly (readonly [string, number])[] = [
  ["10350171_5096307", 3], ["10350171_5096307", 4], ["10352996_5120445", 5], ["5715733309164", 5], ["5715907782472", 1], ["5715909336543", 1],
  ["Z0CDF734E919A8B135B2DZ", 2], ["Z281ABDF56606CCDC8E91Z", 2], ["Z40E29CD878FAA726501DZ", 1], ["Z5C2F10C8828D6C235D33Z", 1], ["Z5C2F10C8828D6C235D33Z", 4],
  ["Z66750C7A5D4EDDB0A0B8Z", 1], ["Z66750C7A5D4EDDB0A0B8Z", 2], ["Z66750C7A5D4EDDB0A0B8Z", 3], ["Z7E6C418C142A8955844CZ", 1], ["Z83A7DA7F6815765CDF92Z", 4],
  ["Z949E9B11B389AAF9A48BZ", 4], ["ZB58D59DC3872166C12DCZ", 3], ["ZE9DADA2214F2EA582424Z", 1],
];
/** The one real photo with a mark on the garment (diagnosis S2): the mark stays on a good cut, so the judge must name it and the photo is left out or held. */
export const PROOF_MARKED = "Z281ABDF56606CCDC8E91Z_2";
/** Photos the guard rightly caught, from the golden set, each run as apparel (the only products agreement applies to, so the worst case). None of them may agree. */
export const PROOF_CONTROLS: readonly { path: string; why: string }[] = [
  { path: "penti/Z91D419FC9238E844BF77Z_4.jpg", why: "cut through the skin" },
  { path: "penti/ZBE55F7B86F158FEA0EB9Z_5.jpg", why: "ghost" },
  { path: "french_connection/Z15276411CE85C2E728DEZ_4.jpg", why: "candle" },
  { path: "french_connection/Z02B2EE44E3A08044B816Z_1.jpg", why: "bag in a hand" },
  { path: "french_connection/Z02B2EE44E3A08044B816Z_3.jpg", why: "logo-only" },
  { path: "french_connection/Z02B2EE44E3A08044B816Z_6.jpg", why: "logo-only" },
  { path: "french_connection/Z011CB57531CA8FA0CBDDZ_1.jpg", why: "lifestyle candle" },
  { path: "french_connection/ZEE79259BBFD83FFA1DB0Z_5.webp", why: "tennis court, the families agree on a cut with court inside the rackets" },
];
/**
 * Does the judge catch a wrong cut two families agree on? Only the judge keeps this cut from production, so the judge is asked
 * about it on purpose: it is the only check behind a shared wrong cut on a plain backdrop, which no pixel measure stops.
 */
export const PROOF_BACKSTOP = "french_connection/ZEE79259BBFD83FFA1DB0Z_5.webp";
/** The most the judge may cost in one proof. Far above the expected cost; a stop here is a failed proof, never a silent one. */
export const PROOF_MAX_JUDGE_USD = 10;
const GOLDEN_SOURCES = "catalog-test/evals/golden/sources";
const VISIBLE_DEFECTS: readonly string[] = ["product_removed", "halo", "leftover_background", "text_or_watermark"];
/** Each photo at its own number on Noon, and as Amazon's white first image. */
const PROOF_CHANNELS: readonly { channel: ChannelId; first: boolean }[] = [{ channel: "noon", first: false }, { channel: "amazon", first: true }];

export type ProofGroup = "real" | "marked" | "control" | "backstop";
export type ProofResult = "pass" | "fail" | "look";
/** `judgeModel` is the model that gave this verdict and `calls` its model calls: a result that names no judge proves nothing (M1 D43). */
export interface ProofImage { channel: string; path: string; thumb: string; verdict: string; flags: string[]; scores: unknown; judgeModel: string; calls: number }
export interface ProofRow { photo: string; group: ProofGroup; why?: string; steps: string[]; model: string; agreed: boolean; busy: boolean; passthrough: boolean; images: ProofImage[]; result: ProofResult; note: string }

/**
 * What counts as passing. A real photo must end as a cut-out the judge has no visible defect to report on. The marked photo must have
 * its mark named. A control must not agree; it then passes held or with the judge naming a defect, and is left for a person to look at
 * when no check objected. The backstop passes only when the judge names a defect on the cut it was shown. A judge that says nothing
 * proves nothing by itself (M1 D43): a real photo passes on its silence only when that judge passed its exam in this run.
 */
export function proofVerdict(row: Pick<ProofRow, "group" | "agreed" | "busy" | "passthrough"> & { flags: readonly string[]; judged: boolean; judgeProven: boolean }): { result: ProofResult; note: string } {
  const defects = row.flags.filter(f => VISIBLE_DEFECTS.includes(f));
  if (row.flags.includes("qa_unavailable")) return { result: "fail", note: "the judge gave no answer" };
  if (row.group === "control" && row.agreed) return { result: "fail", note: "agreed on a photo the guard rightly caught" };
  if (row.group === "control") return row.busy ? { result: "pass", note: "held: nobody is shown this cut" } : defects.length ? { result: "pass", note: `the judge named ${defects.join(", ")}` } : { result: "look", note: "no check objected: look at this image" };
  if (row.group === "backstop") return defects.length ? { result: "pass", note: `the judge named ${defects.join(", ")}` } : { result: "fail", note: row.judged ? "the judge passed a wrong cut two families agreed on" : "the families did not agree here, so this was not tested" };
  if (row.group === "marked") return row.busy || defects.includes("text_or_watermark") ? { result: "pass", note: "the mark stays on the garment and is named, so this photo is left out or held" } : { result: "fail", note: "the mark was not named" };
  if (row.busy || row.passthrough) return { result: "fail", note: "held or passed through" };
  if (!row.judged) return { result: "fail", note: "no image was made" };
  if (defects.length) return { result: "fail", note: `judge: ${defects.join(", ")}` };
  return row.judgeProven ? { result: "pass", note: "" } : { result: "fail", note: "the judge said nothing and has not passed its exam in this run" };
}

/** Which models gave the proof's verdicts, and on how many images (M1 D43). */
export function proofJudges(rows: readonly Pick<ProofRow, "images">[]): string {
  const count = new Map<string, number>();
  for (const image of rows.flatMap(r => r.images)) count.set(image.judgeModel, (count.get(image.judgeModel) ?? 0) + 1);
  return `JUDGED BY: ${[...count].map(([model, images]) => `${model} on ${images} images`).join(", ") || "no judge"}.`;
}

/** The verdict in plain lines: the overall result first, then each photo that did not simply pass. Any failure fails the proof. */
export function proofSummary(rows: readonly Pick<ProofRow, "photo" | "result" | "note">[], stopped?: string): { pass: boolean; lines: string[] } {
  const count = (r: ProofResult) => rows.filter(x => x.result === r).length, pass = !count("fail") && !stopped && rows.length > 0;
  return { pass, lines: [
    `PROOF ${pass ? "PASS" : "FAIL"}: ${count("pass")} passed, ${count("fail")} failed, ${count("look")} to look at, of ${rows.length}.${stopped ? ` Stopped early: ${stopped}` : ""}`,
    ...rows.filter(x => x.result === "fail").map(x => `FAIL ${x.photo}: ${x.note}`),
    ...rows.filter(x => x.result === "look").map(x => `LOOK ${x.photo}: ${x.note}`),
  ] };
}

/**
 * M1 D40: how many of the proof's photos would not simply be delivered: scenery the matte stage refuses, or a defect the judge names.
 * Each is left out when its product keeps two good photos, else held; the proof has no sibling photos, so this is the most that could
 * hold. Real photos and controls apart, because the controls are chosen to fail. It is these photos only, not a brand's rate.
 */
export function proofHolds(rows: readonly Pick<ProofRow, "group" | "busy" | "images">[]): { real: { held: number; of: number }; controls: { held: number; of: number }; line: string } {
  const tally = (groups: readonly ProofGroup[]) => {
    const mine = rows.filter(r => groups.includes(r.group));
    return { held: mine.filter(r => r.busy || r.images.some(i => i.flags.some(f => VISIBLE_DEFECTS.includes(f)))).length, of: mine.length };
  };
  const real = tally(["real", "marked"]), controls = tally(["control"]);
  const part = (t: { held: number; of: number }) => `${t.held} of ${t.of} (${t.of ? ((100 * t.held) / t.of).toFixed(1) : "0.0"}%)`;
  return { real, controls, line: `HOLDS at most: real photos ${part(real)}, controls ${part(controls)}. These photos only, not a brand's rate.` };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const RESULT_COLOUR: Record<ProofResult, string> = { pass: "#0a7d38", fail: "#b3261e", look: "#8a5a00" };
/** One self-contained page: the images are inside it, so it opens from a downloaded file. */
export function proofHtml(run: string, rows: readonly ProofRow[], lines: readonly string[]): string {
  const order: ProofResult[] = ["fail", "look", "pass"], sorted = [...rows].sort((a, b) => order.indexOf(a.result) - order.indexOf(b.result));
  const card = (r: ProofRow) => `<section><h2 style="color:${RESULT_COLOUR[r.result]}">${r.result.toUpperCase()} ${esc(r.photo)}</h2><p>${esc(r.group)}${r.why ? ` - ${esc(r.why)}` : ""}${r.note ? `: ${esc(r.note)}` : ""}</p>${r.images.map(i => `<figure><img alt="${esc(`${r.photo} on ${i.channel}`)}" src="data:image/jpeg;base64,${i.thumb}"><figcaption>${esc(i.channel)}: ${esc(i.verdict)}${i.flags.length ? ` (${esc(i.flags.join(", "))})` : ""}</figcaption></figure>`).join("")}</section>`;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Matte proof ${esc(run)}</title><style>body{font:16px system-ui;margin:16px;max-width:1100px}section{border-top:1px solid #ccc;padding:8px 0}figure{display:inline-block;margin:0 12px 12px 0;vertical-align:top}img{max-width:100%;width:420px;border:1px solid #ddd;background:#fff}h1{font-size:22px}h2{font-size:18px;margin:4px 0}</style><h1>${lines.map(esc).join("<br>")}</h1><p>Run ${esc(run)}. Look at every image, not only the verdict.</p>${sorted.map(card).join("")}</html>`;
}

/** proof [--limit n]: real ladder, real render, live judge; verdict and report under catalog-test/evals/<run>/matte-proof/. */
export async function matteProofCommand(db: Db, flags: Record<string, string | string[] | true>): Promise<void> {
  if (!liveQaEnabled()) { console.error("proof calls the live judge: run it through bash infra/catalog-output-evals.sh proof (LIVE_SMOKE=1)"); process.exitCode = 2; return; }
  const deps = workerCatalogDeps(db), run = `proof-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`, prefix = `${EVALS_PREFIX}/${run}/matte-proof`;
  console.info(`Run id: ${run}`);
  // M1 D43: the judge sits its exam first, in this run. A failed exam fails the proof, whatever the photos then show.
  const exam = await runJudgeExam(db, deps, { run });
  const health = await deps.matting.health(), served = health.models.map(m => m.id), rows: ProofRow[] = [];
  // The route switches apply, as in a batch: a switched-off route is not asked.
  const router = deps.routes ? await deps.routes() : undefined;
  let judgeUsd = 0;
  const judgeAndKeep = async (photo: string, source: { raw: Buffer; n: number; type: ProductType; brand: string }, prepared: Parameters<typeof renderSource>[0]["prepared"], matte: Matte, agreed: boolean) => {
    const policy = await deps.resolvePolicy(source.brand, source.type), images: ProofImage[] = [], seen = new Set<string>();
    for (const { channel, first } of PROOF_CHANNELS) {
      const n = first ? 1 : source.n;
      const rendered = await renderSource({ prepared, matte, channel, shotNumber: n, productType: source.type, ...(agreed ? { keepSourceShadow: AGREED_VARIANT.keepSourceShadow, synthesiseShadow: AGREED_VARIANT.synthesiseShadow } : {}) });
      if (!rendered.jpeg) continue;
      if (judgeUsd >= PROOF_MAX_JUDGE_USD) throw new Error(`the judge reached $${PROOF_MAX_JUDGE_USD}`);
      const path = `${prefix}/${photo}.${channel}.jpg`; assertTestPrefix(path);
      await gcs.uploadBuffer(path, rendered.jpeg, "image/jpeg");
      const verdict = await deps.judgeOutput({ output: rendered.jpeg, original: source.raw, channel, anchor: "centre", productType: source.type, identifier: photo, n, model: policy.qaModel, threshold: policy.threshold, floor: policy.floor, ...(policy.qaModelSecond ? { secondModel: policy.qaModelSecond } : {}) }, router ? { router } : {});
      judgeUsd += verdict.costUsd;
      await recordCostEvent(db, { batchId: null, brandSlug: null, isTest: true, stage: "qa", kind: "llm_call", engine: verdict.model, usd: verdict.costUsd, channel, outcome: "ok" }, deps.log);
      for (const flag of verdict.flags) seen.add(flag);
      const thumb = (await sharp(rendered.jpeg).resize({ width: 420, withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer()).toString("base64");
      images.push({ channel, path, thumb, verdict: verdict.verdict, flags: verdict.flags, scores: verdict.scores, judgeModel: verdict.model, calls: verdict.calls });
    }
    return { images, flags: [...seen] };
  };
  const one = async (photo: string, source: { raw: Buffer; name: string; n: number; type: ProductType; brand: string }, group: ProofGroup, why?: string) => {
    const policy = await deps.resolvePolicy(source.brand, source.type), p = await deps.prepare(source.raw, source.name, b => deps.matting.convert(b));
    const first = await deps.matteFor(p, deps.matting, policy.matteModel);
    const second = policy.matteModelSecond;
    const resolved = await resolveMatte({ prepared: p, first, handRule: false, attempt: async variant => {
      const model = variant === "padded_first" ? first.model : variant === "third" ? thirdOpinionModel(served, [first.model, ...(second ? [second] : [])]) : second;
      if (!model) return null;
      const next = await deps.matteFor(p, deps.matting, model, variant === "padded_first" || variant === "padded_second" ? { padFraction: GUARD_PAD_FRACTION } : {});
      return next.source === "model" ? next : null;
    } });
    const agreed = agreedMatte({ auto_actions: resolved.actions });
    const { images, flags } = await judgeAndKeep(photo, source, p, resolved.matte, agreed);
    const row: ProofRow = { photo, group, ...(why ? { why } : {}), steps: resolved.actions.map(a => `${a.step}:${a.result} ${a.detail}`), model: resolved.matte.model, agreed, busy: resolved.busyBackground, passthrough: resolved.passthrough, images, result: "fail", note: "" };
    Object.assign(row, proofVerdict({ group, agreed, busy: row.busy, passthrough: row.passthrough, flags, judged: images.length > 0 && images.every(i => i.calls > 0), judgeProven: exam.pass }));
    rows.push(row);
    console.info(JSON.stringify({ photo, group, agreed, busy: row.busy, passthrough: row.passthrough, flags, result: row.result, note: row.note }));
    if (source.name !== PROOF_BACKSTOP.split("/").pop()) return;
    // The cut two families agree on, shown to the judge although the scene vetoes it in production.
    const other = thirdOpinionModel(served, [first.model]);
    const asked: Matte[] = [first, ...(other ? [await deps.matteFor(p, deps.matting, other)] : [])];
    const cut = matteAgreement(p, asked, backgroundRegion(p));
    const shown = cut.matte ? await judgeAndKeep(`${photo}.agreed-cut`, source, p, cut.matte, true) : { images: [], flags: [] as string[] };
    const check: ProofRow = { photo: `${photo}.agreed-cut`, group: "backstop", why: "the judge on a wrong cut two families agree on", steps: [cut.detail], model: cut.matte?.model ?? "", agreed: !!cut.matte, busy: false, passthrough: false, images: shown.images, result: "fail", note: "" };
    Object.assign(check, proofVerdict({ group: "backstop", agreed: check.agreed, busy: false, passthrough: false, flags: shown.flags, judged: shown.images.length > 0, judgeProven: exam.pass }));
    rows.push(check);
    console.info(JSON.stringify({ photo: check.photo, group: check.group, flags: shown.flags, result: check.result, note: check.note }));
  };
  const limit = typeof flags.limit === "string" ? Number(flags.limit) : Infinity;
  let stopped: string | undefined;
  try {
    for (const [identifier, n] of PROOF_REAL.slice(0, limit)) {
      const photo = `${identifier}_${n}`, group: ProofGroup = photo === PROOF_MARKED ? "marked" : "real";
      const [source] = await db.select({ rawUri: catalogSourceImages.rawUri, type: catalogProducts.productType, brand: catalogProducts.brandSlug }).from(catalogSourceImages).innerJoin(catalogProducts, eq(catalogProducts.id, catalogSourceImages.productId)).where(and(eq(catalogProducts.identifier, identifier), eq(catalogSourceImages.n, n))).orderBy(desc(catalogSourceImages.createdAt)).limit(1);
      if (!source) { rows.push({ photo, group, steps: [], model: "", agreed: false, busy: false, passthrough: false, images: [], result: "fail", note: "source not found" }); continue; }
      await one(photo, { raw: (await gcs.downloadBuffer(source.rawUri)).buf, name: `${photo}.jpg`, n, type: source.type ?? "apparel_model", brand: source.brand }, group);
    }
    for (const control of PROOF_CONTROLS.slice(0, limit)) {
      const name = control.path.split("/").pop()!, n = Number(name.match(/_(\d+)\./)![1]);
      await one(name.replace(/\.\w+$/, ""), { raw: (await gcs.downloadBuffer(gcs.toGsUri(gcs.getBucketName(), `${GOLDEN_SOURCES}/${control.path}`))).buf, name, n, type: "apparel_model", brand: control.path.split("/")[0]! }, "control", control.why);
    }
  } catch (error) {
    stopped = error instanceof Error ? error.message : String(error);
  }
  const summary = proofSummary(rows, stopped), pass = summary.pass && exam.pass, holds = proofHolds(rows), bucket = gcs.getBucketName();
  const lines = [`PROOF ${pass ? "PASS" : "FAIL"}: ${summary.lines[0]!.replace(/^PROOF \w+: /, "")}`, proofJudges(rows), ...exam.lines, holds.line, ...summary.lines.slice(1)];
  const write = async (name: string, body: string, mime: string) => { const path = `${prefix}/${name}`; assertTestPrefix(path); await gcs.uploadBuffer(path, Buffer.from(body), mime); return `gs://${bucket}/${path}`; };
  await write("report.json", JSON.stringify({ run, pass, judgeUsd, exam: { pass: exam.pass, reportUri: exam.reportUri, lines: exam.lines }, holds: { real: holds.real, controls: holds.controls }, rows: rows.map(r => ({ ...r, images: r.images.map(({ thumb: _thumb, ...image }) => image) })) }, null, 1), "application/json");
  await write("verdict.txt", `${lines.join("\n")}\n`, "text/plain");
  const page = await write("report.html", proofHtml(run, rows, lines), "text/html");
  for (const line of lines) console.info(line);
  console.info(`Judge cost: $${judgeUsd.toFixed(2)}. Read the report: gcloud storage cp ${page} .`);
  if (!pass) process.exitCode = 1;
}

/** Parses "identifier_n,identifier_n" into pairs. */
export function parsePhotoList(value: string): { identifier: string; n: number }[] {
  return value.split(",").map(item => {
    const m = item.trim().match(/^(.+)_(\d+)$/);
    if (!m) throw new Error(`Not an identifier_number: ${item}`);
    return { identifier: m[1]!, n: Number(m[2]) };
  });
}

/** recut --batch <id> --photos <identifier_n,...>: one chunk per product; prints what happened to each photo. Anything but `recutting` exits 1. */
export async function recutCommand(db: Db, flags: Record<string, string | string[] | true>): Promise<void> {
  const batchId = flags.batch, photos = flags.photos;
  if (typeof batchId !== "string" || typeof photos !== "string") { console.error("recut needs --batch <id> and --photos <identifier_n,...>"); process.exitCode = 2; return; }
  const wanted = parsePhotoList(photos), identifiers = [...new Set(wanted.map(w => w.identifier))], deps = workerCatalogDeps(db);
  const sources = await db.selectDistinct({ id: catalogSourceImages.id, n: catalogSourceImages.n, identifier: catalogProducts.identifier, productId: catalogSourceImages.productId }).from(catalogSourceImages).innerJoin(catalogProducts, eq(catalogProducts.id, catalogSourceImages.productId)).innerJoin(catalogOutputs, eq(catalogOutputs.sourceImageId, catalogSourceImages.id)).where(and(eq(catalogSourceImages.batchId, batchId), inArray(catalogProducts.identifier, identifiers)));
  const byProduct = new Map<string, { label: string; id: string }[]>();
  for (const w of wanted) {
    const label = `${w.identifier}_${w.n}`, source = sources.find(s => s.identifier === w.identifier && s.n === w.n);
    if (!source) { console.info(`${label}: not in this batch`); process.exitCode = 1; continue; }
    byProduct.set(source.productId, [...(byProduct.get(source.productId) ?? []), { label, id: source.id }]);
  }
  for (const list of byProduct.values()) {
    const result = await recutProductPhotos(deps, { batchId, sourceImageIds: list.map(x => x.id) });
    for (const { label, id } of list) {
      const outcome = result.photos?.[id] ?? result.outcome;
      console.info(`${label}: ${outcome === "superseded" ? "superseded: a later batch published this product, so nothing was changed" : outcome}`);
      if (outcome !== "recutting") process.exitCode = 1;
    }
  }
}
