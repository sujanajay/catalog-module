// People modal API (spec 03, "Route table with required roles"). GET: viewer; POST: admin.
import { ROLES } from "@catalog/core/catalog/types";
import { listPeople, upsertPerson } from "@catalog/core/people";
import { z } from "zod";
import { db } from "../../../lib/db";
import { handle, readJson } from "../../../lib/errors";
import { requireRole } from "../../../lib/user";

// Every response depends on the caller and the users table; never prerendered or cached.
export const dynamic = "force-dynamic";

const AddPerson = z.object({ email: z.string(), role: z.enum(ROLES) });

/** 200 { people: Person[] }: admins first, then operators, then viewers. */
export async function GET(req: Request): Promise<Response> {
  return handle(async () => {
    await requireRole("viewer", req);
    return Response.json({ people: await listPeople(db()) });
  });
}

/** { email, role } -> 201 Person. added_by is the acting admin. 400 for another domain. */
export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const admin = await requireRole("admin", req);
    const body = AddPerson.parse(await readJson(req));
    const person = await upsertPerson(db(), { email: body.email, role: body.role, addedBy: admin.email });
    return Response.json(person, { status: 201 });
  });
}
