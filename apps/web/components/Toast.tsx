"use client";

// Toasts (spec 01 "Global frame"): navy, bottom-centre, about 2.6 seconds, one sentence, with an
// optional action button. One toast at a time; a new one replaces the current one.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export const TOAST_MS = 2600;

export interface ToastAction {
  label: string;
  onClick(): void;
}

export interface ToastOptions {
  action?: ToastAction;
  /** Keep the toast until it is replaced or its action is used (for example "Reload"). */
  sticky?: boolean;
}

/** The toast itself, without state. `ToastProvider` renders it; other code may reuse it directly. */
export function Toast({ message, action }: { message: string; action?: ToastAction }) {
  return (
    <div className="toast" role="status" aria-live="polite">
      <span>{message}</span>
      {action ? (
        <button type="button" onClick={action.onClick}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

type ShowToast = (message: string, options?: ToastOptions) => void;

const ToastContext = createContext<ShowToast | null>(null);

interface Current {
  id: number;
  message: string;
  options: ToastOptions;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<Current | null>(null);
  const nextId = useRef(0);

  const show = useCallback<ShowToast>((message, options = {}) => {
    nextId.current += 1;
    setCurrent({ id: nextId.current, message, options });
  }, []);

  useEffect(() => {
    if (!current || current.options.sticky) return;
    const id = current.id;
    const t = setTimeout(() => setCurrent((c) => (c?.id === id ? null : c)), TOAST_MS);
    return () => clearTimeout(t);
  }, [current]);

  const action = useMemo<ToastAction | undefined>(() => {
    const a = current?.options.action;
    if (!a) return undefined;
    return {
      label: a.label,
      onClick: () => {
        setCurrent(null);
        a.onClick();
      },
    };
  }, [current]);

  return (
    <ToastContext value={show}>
      {children}
      {current ? <Toast key={current.id} message={current.message} action={action} /> : null}
    </ToastContext>
  );
}

/** Returns `toast(message, options?)`. Must be used inside <ToastProvider>. */
export function useToast(): ShowToast {
  const show = useContext(ToastContext);
  if (!show) throw new Error("useToast must be used inside <ToastProvider>.");
  return show;
}
