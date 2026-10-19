import { z } from "zod";
import { decidePhoto } from "../../../../../../lib/catalog/decisions";
import { catalogRoute, outputId, type OutputContext } from "../../../../../../lib/catalog/api";
import { readJson } from "../../../../../../lib/errors";

const Body = z.object({ decision: z.enum(["use_as_is", "remove"]) });

/** "Use as is" or "Remove this photo" (spec 07 4.7). Operator; the response lists the affected output ids. */
export function POST(req: Request, context: OutputContext) {
  return catalogRoute(req, "operator", async (user) => {
    const id = await outputId(context);
    const body = Body.parse(await readJson(req));
    return decidePhoto(id, body.decision, user.email);
  });
}
