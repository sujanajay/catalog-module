// M12-S1: POST /api/settings/changes { key, scope?, value, reason? } -> 200 { change_id, version, risk, effective }.
// Admin. Applies at once, from the next batch (M12-F1-R6). An owner-only setting is refused (403) for anyone not on the
// owner list until owner approvals arrive with M12-S4; the preview by replay (preview_id) arrives with M12-S3.
import { CHANNEL_IDS } from "@catalog/core/catalog/types";
import { changeSetting } from "@catalog/core/settings/store";
import { z } from "zod";
import { db } from "../../../../lib/db";
import { handle, readJson } from "../../../../lib/errors";
import { requireRole } from "../../../../lib/user";

export const dynamic = "force-dynamic";

const Change = z.object({
  key: z.string().min(1),
  scope: z.object({ channel: z.enum(CHANNEL_IDS).optional(), category: z.string().min(1).optional(), brand: z.string().min(1).optional() }).strict().optional(),
  value: z.unknown(),
  reason: z.string().max(500).nullish(),
});

export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const admin = await requireRole("admin", req);
    const body = Change.parse(await readJson(req));
    const result = await changeSetting(db(), { key: body.key, scope: body.scope, value: body.value, reason: body.reason ?? null }, admin.email);
    return Response.json({ change_id: result.version.id, version: result.version.version, risk: result.risk, effective: result.effective });
  });
}
