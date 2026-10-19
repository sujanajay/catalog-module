import { z } from "zod";
import { finishReplacement } from "../../../../../../../lib/catalog/decisions";
import { catalogRoute, outputId, type OutputContext } from "../../../../../../../lib/catalog/api";
import { readJson } from "../../../../../../../lib/errors";

const Body = z.object({ uploadId: z.string().uuid() });

/** Confirms the uploaded replacement and queues its one-source chunk (spec 07 4.8). Operator. */
export function POST(req: Request, context: OutputContext) {
  return catalogRoute(req, "operator", async (user) => {
    const id = await outputId(context);
    return finishReplacement(id, Body.parse(await readJson(req)).uploadId, user.email);
  });
}
