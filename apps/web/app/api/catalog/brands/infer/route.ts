import { inferIntake } from "../../../../../lib/catalog/intake-defaults";
import { catalogRoute } from "../../../../../lib/catalog/api";
import { readJson } from "../../../../../lib/errors";
/** M1-F2-R3 and R4: the brand of dropped names and its default channels (the one-page New batch). */
export function POST(req: Request) { return catalogRoute(req, "operator", async () => inferIntake(await readJson(req))); }
