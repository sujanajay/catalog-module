// One call runs every image check on one output. The pipeline runner (apps/worker/src/catalog-output-evals.ts)
// and the folder mode feed it subjects; the unit tests feed it synthetic ones.
import { buildContext } from "./context";
import { checkCutEdge } from "./cut-edge";
import { checkCutout } from "./cutout";
import { checkGeometry } from "./geometry";
import { checkShadow } from "./shadow";
import { fail, type CheckResult, type OutputSubject } from "./types";

export async function runImageChecks(subject: OutputSubject): Promise<CheckResult[]> {
  const ctx = await buildContext(subject);
  const who = { identifier: subject.identifier, n: subject.n, channel: subject.channel };
  if (!ctx) return [fail("geometry.canvas", "geometry", who, "no product", "a product", "", "The matte holds no product pixels.")];
  return [...await checkGeometry(ctx), ...checkShadow(ctx), ...checkCutout(ctx), ...checkCutEdge(ctx)];
}
export { checkUniformScale } from "./geometry";
export { checkCompleteness, expectedOutcome, STYLI_SKIP_NOTE } from "./completeness";
export { checkAttention, flagRows, outputKey } from "./attention";
export { checkIdentical, checkOverwrite } from "./overwrite";
export { buildReport, reportHtml, summaryLine } from "./report";
export * from "./types";
