"use client";
import { apiFetch } from "../../lib/fetch";
/** A refused API call: the server's plain-words sentence plus the HTTP status. */
export class WizardApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = "WizardApiError"; }
}
export async function wizardApi<T>(url: string, method = "GET", value?: unknown): Promise<T> {
  const response = await apiFetch(url, { method, ...(value !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) } : {}) });
  const body = await response.json();
  if (!response.ok) throw new WizardApiError(body.error || "This did not finish. Try again.", response.status);
  return body as T;
}
export const batchUrl = (id: string, path = "") => `/api/catalog/batches/${id}${path}`;
