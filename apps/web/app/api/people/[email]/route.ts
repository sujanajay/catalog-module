// One person in the People modal (spec 03). PATCH and DELETE: admin.
import { ROLES } from "@catalog/core/catalog/types";
import { removePerson, setRole } from "@catalog/core/people";
import { z } from "zod";
import { db } from "../../../../lib/db";
import { handle, notFound, readJson } from "../../../../lib/errors";
import { requireRole } from "../../../../lib/user";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ email: string }> };

const ChangeRole = z.object({ role: z.enum(ROLES) });

/** The [email] segment; tolerates an already-decoded value. */
async function emailParam(ctx: Context): Promise<string> {
  const raw = (await ctx.params).email;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * { role } -> 200 Person; 404 "Person not found" for an unknown email; 400 when it would demote the
 * last admin. added_by is kept (it records who added the person, not who last changed the role).
 */
export async function PATCH(req: Request, ctx: Context): Promise<Response> {
  return handle(async () => {
    await requireRole("admin", req);
    const email = await emailParam(ctx);
    const body = ChangeRole.parse(await readJson(req));
    const person = await setRole(db(), email, body.role);
    if (!person) throw notFound("Person");
    return Response.json(person);
  });
}

/** 204; the person is a viewer again on their next request. Unknown email: also 204 (no-op). */
export async function DELETE(req: Request, ctx: Context): Promise<Response> {
  return handle(async () => {
    await requireRole("admin", req);
    await removePerson(db(), await emailParam(ctx));
    return new Response(null, { status: 204 });
  });
}
