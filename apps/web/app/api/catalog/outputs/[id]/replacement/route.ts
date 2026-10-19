import { z } from "zod";
import { replacementUpload } from "../../../../../../lib/catalog/decisions";
import { catalogRoute, outputId, type OutputContext } from "../../../../../../lib/catalog/api";
import { readJson } from "../../../../../../lib/errors";

const Body = z.object({ name: z.string().trim().min(1), size: z.number().int().positive(), mime: z.string() });

/** One signed PUT URL for the replacement photo (spec 07 4.8). Operator. */
export function POST(req: Request, context: OutputContext) {
  return catalogRoute(req, "operator", async () => {
    const id = await outputId(context);
    return replacementUpload(id, Body.parse(await readJson(req)));
  });
}
