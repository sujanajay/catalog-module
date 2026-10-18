import { createBatch, listBatches } from "../../../../lib/catalog/batches";
import { catalogRoute } from "../../../../lib/catalog/api";
import { readJson } from "../../../../lib/errors";
export const dynamic = "force-dynamic";
export function GET(req: Request) { return catalogRoute(req, "viewer", () => listBatches()); }
export function POST(req: Request) { return catalogRoute(req, "operator", async (user) => createBatch(await readJson(req), user.email), 201); }
