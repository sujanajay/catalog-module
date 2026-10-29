import { z } from "zod";
import { decidePhoto } from "../../../../../../lib/catalog/decisions";
import { outputId, type OutputContext } from "../../../../../../lib/catalog/api";
import { handle, readJson } from "../../../../../../lib/errors";
import { requireRole } from "../../../../../../lib/user";

const Body = z.object({ decision: z.enum(["use_as_is", "remove"]), acceptPlain: z.boolean().optional() });

/**
 * "Use as is" or "Remove this photo" (spec 07 4.7). Operator; the response lists the affected output ids. Spec 18
 * lifecycle 3.6: "Use as is" on a photo that could not be enlarged answers 409 `plain_warning` with the channels,
 * unless the body carries `acceptPlain: true` (the operator saw the warning).
 */
export function POST(req: Request, context: OutputContext) {
  return handle(async () => {
    const user = await requireRole("operator", req);
    const id = await outputId(context);
    const body = Body.parse(await readJson(req));
    const result = await decidePhoto(id, body.decision, user.email, body.acceptPlain === true);
    return "warning" in result ? Response.json(result.warning, { status: 409 }) : Response.json(result);
  });
}
