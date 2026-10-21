// One call runs every image check on one output. The pipeline runner (apps/worker/src/catalog-output-evals.ts)
// and the folder mode feed it subjects; the unit tests feed it synthetic ones.
import { buildContext } from "./context";
import { checkCutEdge } from "./cut-edge";
import { checkCutout } from "./cutout";
import { checkGeometry } from "./geometry";
import { checkShadow } from "./shadow";
import { fail, notRun, type CheckResult, type OutputSubject } from "./types";

/**
 * Every image check on one output. A planted wrong item (`subject.planted`) is a photo of another product, often another
 * type, processed under this product's rules to test the judge (eval run 3: a French Connection model photo at the
 * footwear softness bar, an Anta shoe's cast shadow under apparel rules); its checks are measured and recorded as not run,
 * never failed: `attention.planted_caught` judges the photo on a live run.
 */
export async function runImageChecks(subject: OutputSubject): Promise<CheckResult[]> {
  const ctx = await buildContext(subject);
  const who = { identifier: subject.identifier, n: subject.n, channel: subject.channel };
  if (!ctx) return [fail("geometry.canvas", "geometry", who, "no product", "a product", "", "The matte holds no product pixels.")];
  const results = [...await checkGeometry(ctx), ...checkShadow(ctx), ...checkCutout(ctx), ...checkCutEdge(ctx)];
  if (!subject.planted) return results;
  return results.map(r => (r.status === "not_run" ? r : notRun(r.id, r.group, r.subject, `Planted wrong item (${r.status}: ${r.measured} against ${r.threshold} ${r.unit}): the photo is of another product and is judged by attention.planted_caught, not by the render checks. ${r.detail}`)));
}
export { checkUniformScale } from "./geometry";
export { CHART_SKIP_NOTE, checkCompleteness, expectedOutcome, STYLI_SKIP_NOTE } from "./completeness";
export { checkAttention, flagRows, outputKey, type AttentionShotRow } from "./attention";
export { assertLocked, checkIdentical, checkOverwrite, lockedProductsMessage, overwriteFailed, overwriteNotRun, planOverwrite } from "./overwrite";
export { buildReport, reportHtml, summaryLine } from "./report";
export * from "./types";
