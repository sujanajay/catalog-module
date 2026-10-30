import { retryPhotoEnlargement } from "../../../../../../lib/catalog/decisions";
import { catalogRoute, outputId, type OutputContext } from "../../../../../../lib/catalog/api";

/**
 * "Try again" on a photo that could not be enlarged (spec 18 lifecycle 3.6). Operator, the same rule as a decision;
 * 409 "Nothing to try again." when the photo has no failed enlargement a call can make.
 */
export function POST(req: Request, context: OutputContext) {
  return catalogRoute(req, "operator", async (user) => retryPhotoEnlargement(await outputId(context), user.email));
}
