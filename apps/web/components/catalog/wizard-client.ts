"use client";
import { apiFetch } from "../../lib/fetch";
export async function wizardApi<T>(url: string, method = "GET", value?: unknown): Promise<T> {
  const response = await apiFetch(url, { method, ...(value !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) } : {}) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "This did not finish. Try again.");
  return body as T;
}
export const batchUrl = (id: string, path = "") => `/api/catalog/batches/${id}${path}`;
