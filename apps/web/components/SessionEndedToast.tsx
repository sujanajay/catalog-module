"use client";

// "Your session ended. Reload to sign in again." with a Reload button (spec 03), shown after any
// apiFetch got a 401. Rendered once in the root layout; separate from the one-at-a-time toasts so a
// later toast can never hide it.

import { SESSION_ENDED_MESSAGE, useSessionEnded } from "@/lib/fetch";
import { Toast } from "./Toast";

export default function SessionEndedToast() {
  if (!useSessionEnded()) return null;
  return (
    <Toast role="alert" message={SESSION_ENDED_MESSAGE} action={{ label: "Reload", onClick: () => window.location.reload() }} />
  );
}
