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
/**
 * The reason a reopened batch could not start (spec 14c F8): "Fix and continue" keeps it for this tab, and
 * step 1 shows it above the inputs until the batch is handed to collecting again. Storage may be blocked
 * (a private window): the reason is then not shown, and nothing else changes.
 */
const fixReasonKey = (id: string) => `catalog-fix-reason:${id}`;
export function rememberFixReason(id: string, reason: string | null): void {
  try { if (reason) sessionStorage.setItem(fixReasonKey(id), reason); } catch { /* storage blocked */ }
}
export function readFixReason(id: string): string | null {
  try { return sessionStorage.getItem(fixReasonKey(id)); } catch { return null; }
}
export function forgetFixReason(id: string): void {
  try { sessionStorage.removeItem(fixReasonKey(id)); } catch { /* storage blocked */ }
}
