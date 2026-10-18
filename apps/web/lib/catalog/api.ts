import { handle, badRequest } from "../errors";
import { requireRole, type CurrentUser } from "../user";
import type { Role } from "@catalog/core/catalog/types";

export type BatchContext = { params: Promise<{ id: string; uploadId?: string }> };
export function catalogRoute(req: Request, role: Role, run: (user: CurrentUser) => Promise<unknown>, status = 200) {
  return handle(async () => {
    const user = await requireRole(role, req);
    return Response.json(await run(user), { status });
  });
}
export async function batchId(context: BatchContext) {
  const params = await context.params;
  if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(params.id)) throw badRequest("This batch link is incomplete. Open the batch list and choose the batch again.");
  return params.id;
}
