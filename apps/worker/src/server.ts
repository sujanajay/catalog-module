import http from "node:http";
import type { TaskRoute } from "@catalog/core/tasks";
import { authorize, type AuthConfig } from "./auth";

/** Options a handler receives with each delivery. */
export interface HandleOptions {
  /** From the x-cloudtasks-taskretrycount header (absent for Cloud Scheduler calls). */
  retryCount?: number;
}

/** 200 done, 503 retry, 500 unexpected. */
export interface HandleResult {
  httpStatus: number;
  outcome: string;
}

export type RouteHandler = (body: Record<string, unknown>, opts: HandleOptions) => Promise<HandleResult>;

export interface ServerDeps {
  auth: AuthConfig;
  /** K_REVISION or "dev". */
  version: string;
  routes: Partial<Record<TaskRoute, RouteHandler>>;
}

const MAX_BODY_BYTES = 64 * 1024;

class BodyTooLargeError extends Error {}

export function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

/** Read the request body as UTF-8, refusing more than 64 KB. */
export function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) tooLarge = true;
      if (!tooLarge) chunks.push(c);
    });
    req.on("end", () => (tooLarge ? reject(new BodyTooLargeError("body too large")) : resolve(Buffer.concat(chunks).toString("utf8"))));
    req.on("error", reject);
  });
}

export function retryCountHeader(req: http.IncomingMessage): number | undefined {
  const raw = req.headers["x-cloudtasks-taskretrycount"];
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function logError(message: string, fields: Record<string, unknown>): void {
  console.error(JSON.stringify({ severity: "ERROR", message, ...fields }));
}

export async function handleRequest(deps: ServerDeps, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  if (pathname === "/healthz" && (req.method === "GET" || req.method === "HEAD")) {
    return send(res, 200, { ok: true, version: deps.version, routes: Object.keys(deps.routes) });
  }
  if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });

  const auth = await authorize(req.headers.authorization, deps.auth);
  if (!auth.ok) return send(res, auth.status, { error: auth.message });

  const handler = Object.prototype.hasOwnProperty.call(deps.routes, pathname)
    ? deps.routes[pathname as TaskRoute]
    : undefined;
  if (!handler) return send(res, 404, { error: "not found" });

  let body: unknown;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    if (err instanceof BodyTooLargeError) return send(res, 413, { error: "body too large" });
    return send(res, 400, { error: "body must be a JSON object" });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return send(res, 400, { error: "body must be a JSON object" });
  }

  let result: HandleResult;
  try {
    result = await handler(body as Record<string, unknown>, { retryCount: retryCountHeader(req) });
  } catch (err) {
    logError("task handler failed", { route: pathname, error: err instanceof Error ? err.message : String(err) });
    return send(res, 500, { outcome: "error" });
  }
  return send(res, result.httpStatus, { outcome: result.outcome });
}

export function createServer(deps: ServerDeps): http.Server {
  return http.createServer((req, res) => {
    handleRequest(deps, req, res).catch((err: unknown) => {
      logError("request failed", { error: String(err) });
      if (!res.headersSent) send(res, 500, { error: "internal error" });
      else res.end();
    });
  });
}
