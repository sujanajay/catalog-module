"use client";
// The page's fetch helper (spec 03, "Expired IAP session during fetch calls"). IAP answers 401 instead
// of a redirect to Google's sign-in page when a request carries X-Requested-With: XMLHttpRequest, so
// every call from the page sends that header. On a 401 the helper throws SessionEndedError and tells
// <SessionEndedToast /> (components/SessionEndedToast.tsx, rendered once in the layout) to show "Your
// session ended. Reload to sign in again." with a Reload button.
import { useSyncExternalStore } from "react";

export const SESSION_ENDED_MESSAGE = "Your session ended. Reload to sign in again.";

export class SessionEndedError extends Error {
  constructor() {
    super(SESSION_ENDED_MESSAGE);
    this.name = "SessionEndedError";
  }
}

let sessionEnded = false;
const listeners = new Set<() => void>();

function markSessionEnded(): void {
  if (sessionEnded) return;
  sessionEnded = true;
  for (const l of listeners) l();
}

/** fetch with X-Requested-With: XMLHttpRequest; throws SessionEndedError on 401. */
export async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("X-Requested-With", "XMLHttpRequest");
  const res = await fetch(input, { ...init, headers });
  if (res.status === 401) {
    markSessionEnded();
    throw new SessionEndedError();
  }
  return res;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True once any apiFetch got a 401 (the IAP session ended); stays true until the page reloads. */
export function useSessionEnded(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => sessionEnded,
    () => false,
  );
}
