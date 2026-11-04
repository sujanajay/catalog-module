// M12-S1: POST /api/settings/versions/:id/revert { reason? } -> 200 { change_id, version, risk, effective }. Admin.
// Undoes that change by writing the value it replaced as a new version (M12-F1-R7); owner-only settings stay owner-only.
import { revertSetting } from "@catalog/core/settings/store";
import { z } from "zod";
import { db } from "../../../../../../lib/db";
import { badRequest, handle } from "../../../../../../lib/errors";
import { requireRole } from "../../../../../../lib/user";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const Body = z.object({ reason: z.string().max(500).nullish() });

export async function POST(req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    const admin = await requireRole("admin", req);
    const { id } = await context.params;
    if (!UUID.test(id)) throw badRequest("That change was not found.");
    const text = await req.text();
    let raw: unknown = {};
    try { if (text.trim()) raw = JSON.parse(text); } catch { throw badRequest("Invalid JSON body"); }
    const body = Body.parse(raw);
    const result = await revertSetting(db(), id, admin.email, body.reason ?? null);
    return Response.json({ change_id: result.version.id, version: result.version.version, risk: result.risk, effective: result.effective });
  });
}
