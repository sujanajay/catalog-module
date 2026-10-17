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
  backToRoleToast,
  canManagePeople,
  errorSentence,
  FALLBACK_ERROR,
  isLastAdmin,
  isRole,
  PEOPLE_HELP,
  PEOPLE_TITLE,
  PREVIEW_HELP,
  PREVIEW_LABEL,
  PREVIEW_ON_TOAST,
  roleLabel,
  ROW_ROLE_ORDER,
  upsertRow,
  type PersonRow,
  type Role,
} from "@/lib/people-copy";
import { useToast } from "./Toast";
import { useViewerPreview } from "./ViewerPreview";

/**
 * The single place this modal talks to the server. Phase 2 of spec 03 swaps it for `apiFetch` from
 * `lib/fetch.ts` (same header, plus the "Your session ended" handling on a 401).
 */
function request(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("X-Requested-With", "XMLHttpRequest");
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  return fetch(path, { ...init, headers, cache: "no-store" });
}

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

async function send<T>(path: string, init?: RequestInit): Promise<Result<T>> {
  let res: Response;
  try {
    res = await request(path, init);
  } catch {
    return { ok: false, error: FALLBACK_ERROR };
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
  const { previewing, setPreviewing } = useViewerPreview();
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
      else toast(r.error);
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

  async function changeRole(email: string, role: Role) {
    setBusy(email);
    const r = await send<PersonRow>(personPath(email), { method: "PATCH", body: JSON.stringify({ role }) });
    setBusy(null);
    if (!r.ok) {
      // The select is controlled by `people`, so it shows the saved role again.
      toast(r.error);
      return;
    }
    setPeople((list) => upsertRow(list ?? [], { email: r.data.email, role: r.data.role }));
    // Your own role changed: re-render the server layout so the user menu shows the new role.
    if (r.data.email === me) router.refresh();
  }

  async function remove(email: string) {
    setBusy(email);
    const r = await send<void>(personPath(email), { method: "DELETE" });
    setBusy(null);
    if (!r.ok) {
      toast(r.error);
      return;
    }
    setPeople((list) => (list ?? []).filter((p) => p.email !== email));
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    const email = newEmail.trim();
    if (!email) return;
    setBusy("add");
    const r = await send<PersonRow>("/api/people", { method: "POST", body: JSON.stringify({ email, role: newRole }) });
    setBusy(null);
    if (!r.ok) {
      toast(r.error);
      return;
    }
    setPeople((list) => upsertRow(list ?? [], { email: r.data.email, role: r.data.role }));
    setNewEmail("");
    toast(addedToast(r.data.email, r.data.role));
  }

  function togglePreview(on: boolean) {
    setPreviewing(on);
    toast(on ? PREVIEW_ON_TOAST : backToRoleToast(currentRole));
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
