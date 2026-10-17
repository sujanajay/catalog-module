import { PeopleError } from "@catalog/core/people";
import { ZodError } from "zod";

/** A user-facing error with an HTTP status. Business logic throws these; routes turn them into JSON. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const SIGN_IN_MESSAGE = "Sign in to continue.";
export const FORBIDDEN_MESSAGE = "You can view this but not change it. Ask an admin for the operator role.";

/** HTTP 403: the signed-in person's role is below what the action needs (spec 03, requireRole). */
export class ForbiddenError extends HttpError {
  constructor(message: string = FORBIDDEN_MESSAGE) {
    super(403, message);
    this.name = "ForbiddenError";
  }
}

export const notFound = (what: string) => new HttpError(404, `${what} not found`);
export const badRequest = (msg: string) => new HttpError(400, msg);
/** HTTP 401: no valid IAP identity on the request (missing, invalid or expired JWT). */
export const unauthorized = () => new HttpError(401, SIGN_IN_MESSAGE);

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) return Response.json({ error: err.message }, { status: err.status });
  // packages/core cannot import HttpError; its people rules throw PeopleError (status 400) instead.
  if (err instanceof PeopleError) return Response.json({ error: err.message }, { status: err.status });
  if (err instanceof ZodError) {
    const msg = err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
    return Response.json({ error: msg, issues: err.issues }, { status: 400 });
  }
  console.error("[web] unhandled error", err);
  return Response.json({ error: err instanceof Error ? err.message : "Internal error" }, { status: 500 });
}

/** Wrap a route handler body so thrown HttpError / PeopleError / ZodError become JSON responses. */
export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    return errorResponse(err);
  }
}

export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw badRequest("Invalid JSON body");
  }
}
