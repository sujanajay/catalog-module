// M12-S1 settings API (docs/program/requirements/M12-admin-self-serve.md 3.2). GET: admin. Every registered setting
// with its values per level and recent history; `?area=` narrows to one section.
import { SETTING_AREAS } from "@catalog/core/settings/registry";
import { z } from "zod";
import { db } from "../../../lib/db";
import { handle } from "../../../lib/errors";
import { settingsView } from "../../../lib/settings";
import { requireRole } from "../../../lib/user";

export const dynamic = "force-dynamic";

const Area = z.enum(SETTING_AREAS).optional();

export async function GET(req: Request): Promise<Response> {
  return handle(async () => {
    const admin = await requireRole("admin", req);
    const area = Area.parse(new URL(req.url).searchParams.get("area") ?? undefined);
    return Response.json(await settingsView(db(), admin.email, area));
  });
}
