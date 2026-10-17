"use client";

// People modal (spec 03 "UI", spec 01 section 9). Admins see a role select per person that saves at
// once, a "Remove" link (not on their own row) and the add row; everyone else sees roles as plain text.
// Below a divider: the "Preview as viewer" switch. Errors are the server's `{ error }` sentence, shown
// as a toast exactly as returned.

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  ADD_PLACEHOLDER,
  ADD_ROLE_ORDER,
  addedToast,
  canManagePeople,
  errorSentence,
  FALLBACK_ERROR,
  isLastAdmin,
  isRole,
  PEOPLE_HELP,
  PEOPLE_TITLE,
  PREVIEW_HELP,
  PREVIEW_LABEL,
  roleLabel,
  ROW_ROLE_ORDER,
  upsertRow,
  type PersonRow,
  type Role,
} from "@/lib/people-copy";
import { apiFetch, SessionEndedError } from "@/lib/fetch";
import { useToast } from "./Toast";
import { usePreviewToggle, useViewerPreview } from "./ViewerPreview";

/** `error: null`: the failure is already on screen (the session-ended toast), so show nothing more. */
type Result<T> = { ok: true; data: T } | { ok: false; error: string | null };

/** The single place this modal talks to the server (apiFetch adds X-Requested-With). */
async function send<T>(path: string, init: RequestInit = {}): Promise<Result<T>> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  let res: Response;
  try {
    res = await apiFetch(path, { ...init, headers, cache: "no-store" });
  } catch (err) {
    return { ok: false, error: err instanceof SessionEndedError ? null : FALLBACK_ERROR };
  }
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    return { ok: false, error: errorSentence(body) };
  }
  if (res.status === 204) return { ok: true, data: undefined as T };
  return { ok: true, data: (await res.json()) as T };
}

const personPath = (email: string) => `/api/people/${encodeURIComponent(email)}`;

export interface PeopleModalProps {
  /** The signed-in person's email (lowercase, as the server returns it). */
  currentEmail: string;
  /** The signed-in person's real role. */
  currentRole: Role;
  onClose(): void;
}

export default function PeopleModal({ currentEmail, currentRole, onClose }: PeopleModalProps) {
  const toast = useToast();
  const router = useRouter();
  const { previewing } = useViewerPreview();
  const togglePreview = usePreviewToggle(currentRole);
  const [people, setPeople] = useState<PersonRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [newEmail, setNewEmail] = useState("");
  const [newRole, setNewRole] = useState<Role>(ADD_ROLE_ORDER[0] ?? "viewer");
  const cardRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const switchId = useId();
  const switchHelpId = useId();
  const manage = canManagePeople(currentRole, previewing);
  const me = currentEmail.toLowerCase();

  useEffect(() => {
    let live = true;
    void send<{ people: PersonRow[] }>("/api/people").then((r) => {
      if (!live) return;
      if (r.ok) setPeople(r.data.people.map(({ email, role }) => ({ email, role })));
      else if (r.error) toast(r.error);
    });
    return () => {
      live = false;
    };
  }, [toast]);

  useEffect(() => {
    cardRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  /**
   * One change: marks `busyKey` busy while it runs (every control is disabled meanwhile) and toasts the
   * server's sentence on failure. Returns the response data on success, else undefined.
   */
  async function run<T>(busyKey: string, path: string, init: RequestInit): Promise<{ data: T } | undefined> {
    setBusy(busyKey);
    const r = await send<T>(path, init);
    setBusy(null);
    if (r.ok) return { data: r.data };
    if (r.error) toast(r.error);
    return undefined;
  }

  async function changeRole(email: string, role: Role) {
    // On failure the select, controlled by `people`, shows the saved role again.
    const r = await run<PersonRow>(email, personPath(email), { method: "PATCH", body: JSON.stringify({ role }) });
    if (!r) return;
    setPeople((list) => upsertRow(list ?? [], { email: r.data.email, role: r.data.role }));
    // Your own role changed: re-render the server layout so the user menu shows the new role.
    if (r.data.email === me) router.refresh();
  }

  async function remove(email: string) {
    const r = await run<void>(email, personPath(email), { method: "DELETE" });
    if (!r) return;
    setPeople((list) => (list ?? []).filter((p) => p.email !== email));
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    const email = newEmail.trim();
    if (!email) return;
    const r = await run<PersonRow>("add", "/api/people", { method: "POST", body: JSON.stringify({ email, role: newRole }) });
    if (!r) return;
    setPeople((list) => upsertRow(list ?? [], { email: r.data.email, role: r.data.role }));
    setNewEmail("");
    toast(addedToast(r.data.email, r.data.role));
  }

  return (
    <div className="modal">
      <div className="card" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={cardRef}>
        <h2 id={titleId}>{PEOPLE_TITLE}</h2>
        <p className="help">{PEOPLE_HELP}</p>

        <ul className="people" aria-label={PEOPLE_TITLE}>
          {(people ?? []).map((p) => {
            const own = p.email === me;
            return (
              <li className="pr" key={p.email}>
                <span className="pe">
                  {p.email}
                  {own ? <span className="note"> (you)</span> : null}
                </span>
                {manage ? (
                  <select
                    aria-label={`Role for ${p.email}`}
                    value={p.role}
                    disabled={busy !== null || (own && isLastAdmin(people ?? [], p.email))}
                    onChange={(e) => {
                      if (isRole(e.target.value)) void changeRole(p.email, e.target.value);
                    }}
                  >
                    {ROW_ROLE_ORDER.map((r) => (
                      <option key={r} value={r}>
                        {roleLabel(r)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="vo">{roleLabel(p.role)}</span>
                )}
                {manage && !own ? (
                  <button
                    type="button"
                    className="link"
                    aria-label={`Remove ${p.email}`}
                    disabled={busy !== null}
                    onClick={() => void remove(p.email)}
                  >
                    Remove
                  </button>
                ) : (
                  <span />
                )}
              </li>
            );
          })}
        </ul>

        {manage ? (
          <form className="people-add" onSubmit={add}>
            <input
              type="text"
              aria-label="Email address"
              placeholder={ADD_PLACEHOLDER}
              value={newEmail}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setNewEmail(e.target.value)}
            />
            <select
              aria-label="Role for the new person"
              value={newRole}
              onChange={(e) => {
                if (isRole(e.target.value)) setNewRole(e.target.value);
              }}
            >
              {ADD_ROLE_ORDER.map((r) => (
                <option key={r} value={r}>
                  {roleLabel(r)}
                </option>
              ))}
            </select>
            <button type="submit" className="btn ghost sm" disabled={busy !== null}>
              Add person
            </button>
          </form>
        ) : null}

        <div className="switch">
          <input
            type="checkbox"
            id={switchId}
            aria-describedby={switchHelpId}
            checked={previewing}
            onChange={(e) => togglePreview(e.target.checked)}
          />
          <label htmlFor={switchId}>
            <b>{PREVIEW_LABEL}</b>
          </label>
          <span className="help" id={switchHelpId}>
            {PREVIEW_HELP}
          </span>
        </div>

        <div className="acts modal-acts">
          <button type="button" className="btn ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
