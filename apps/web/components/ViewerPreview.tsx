"use client";

// "Preview as viewer" (spec 03 "UI"): a client-side switch that hides every action control so an admin
// or operator can see the app as a viewer does. It is remembered for the browser tab in sessionStorage.
// It never changes server permissions: an API call made while previewing is still judged by the
// caller's real role on the server.

import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { backToRoleToast, PREVIEW_ON_TOAST, type Role } from "@/lib/people-copy";
import { useToast } from "./Toast";

const STORAGE_KEY = "catalog.viewerPreview";
const listeners = new Set<() => void>();

function readStored(): boolean {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    // Storage can be blocked (private mode, site data off); the preview then simply starts off.
    return false;
  }
}

// The in-memory value wins once set, so the switch still works when storage is unavailable.
let memory: boolean | null = null;

function getSnapshot(): boolean {
  if (memory === null) memory = readStored();
  return memory;
}

function getServerSnapshot(): boolean {
  return false;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function writePreview(on: boolean): void {
  memory = on;
  try {
    if (on) window.sessionStorage.setItem(STORAGE_KEY, "1");
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Not remembered across reloads when storage is blocked; the in-memory value still applies.
  }
  for (const l of listeners) l();
}

export interface ViewerPreviewValue {
  previewing: boolean;
  setPreviewing(v: boolean): void;
}

const ViewerPreviewContext = createContext<ViewerPreviewValue | null>(null);

export function ViewerPreviewProvider({ children }: { children: ReactNode }) {
  const previewing = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const value = useMemo(() => ({ previewing, setPreviewing: writePreview }), [previewing]);
  return <ViewerPreviewContext value={value}>{children}</ViewerPreviewContext>;
}

export function useViewerPreview(): ViewerPreviewValue {
  const value = useContext(ViewerPreviewContext);
  if (!value) throw new Error("useViewerPreview must be used inside <ViewerPreviewProvider>.");
  return value;
}

/**
 * Turns the preview on or off with its toast ("Previewing as a viewer. ..." or "Back to <Role>."), the
 * same from the user menu and the People modal. `role` is the person's real role.
 */
export function usePreviewToggle(role: Role): (on: boolean) => void {
  const { setPreviewing } = useViewerPreview();
  const toast = useToast();
  return (on) => {
    setPreviewing(on);
    toast(on ? PREVIEW_ON_TOAST : backToRoleToast(role));
  };
}

/** Wrap an action control so it renders nothing while "Preview as viewer" is on. */
export function ActionOnly({ children }: { children: ReactNode }) {
  const { previewing } = useViewerPreview();
  return previewing ? null : <>{children}</>;
}
