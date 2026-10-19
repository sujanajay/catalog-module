import { z } from "zod";
import { readEvalLabels, saveEvalLabel } from "../../../../../../lib/catalog/eval";
import { batchId, catalogRoute, type BatchContext } from "../../../../../../lib/catalog/api";
import { readJson } from "../../../../../../lib/errors";

const Body = z.object({ outputId: z.string().uuid(), label: z.enum(["pass", "flag"]), reasons: z.array(z.string()).default([]), note: z.string().optional() });

/** The batch's eval labels as JSON for 08's harness (spec 07 4.10). Operator. */
export function GET(req: Request, context: BatchContext) {
  return catalogRoute(req, "operator", async () => readEvalLabels(await batchId(context)));
}

/** One label for one output; never changes the output, the gate or the sheet. Operator. */
export function POST(req: Request, context: BatchContext) {
  return catalogRoute(req, "operator", async (user) => {
    const id = await batchId(context);
    return saveEvalLabel(id, Body.parse(await readJson(req)), user.email);
  });
}
