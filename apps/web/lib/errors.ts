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

export const notFound = (what: string) => new HttpError(404, `${what} not found`);
export const badRequest = (msg: string) => new HttpError(400, msg);

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) return Response.json({ error: err.message }, { status: err.status });
  if (err instanceof ZodError) {
    const msg = err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
    return Response.json({ error: msg, issues: err.issues }, { status: 400 });
  }
  console.error("[web] unhandled error", err);
  return Response.json({ error: err instanceof Error ? err.message : "Internal error" }, { status: 500 });
}

/** Wrap a route handler body so thrown HttpError / ZodError become JSON responses. */
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
