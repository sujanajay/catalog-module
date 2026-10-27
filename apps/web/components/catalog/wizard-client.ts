"use client";
import { apiFetch } from "../../lib/fetch";
import { platformErrorText } from "../../lib/catalog/copy";
/** A refused API call: the server's plain-words sentence plus the HTTP status. */
export class WizardApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = "WizardApiError"; }
}
/** Reads a JSON body; a non-JSON answer (a platform timeout page, an empty body) gives { ok: false }. */
async function readJsonBody(response: Response): Promise<{ ok: true; body: unknown } | { ok: false }> {
  if (!/\bjson\b/i.test(response.headers.get("content-type") ?? "")) return { ok: false };
  try { return { ok: true, body: await response.json() }; } catch { return { ok: false }; }
}
export async function wizardApi<T>(url: string, method = "GET", value?: unknown): Promise<T> {
  const response = await apiFetch(url, { method, ...(value !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) } : {}) });
  const read = await readJsonBody(response);
  if (!read.ok) throw new WizardApiError(platformErrorText(response.status), response.status);
  const body = read.body as { error?: string } | null;
  if (!response.ok) throw new WizardApiError(body?.error || "This did not finish. Try again.", response.status);
  return body as T;
}
export const batchUrl = (id: string, path = "") => `/api/catalog/batches/${id}${path}`;
