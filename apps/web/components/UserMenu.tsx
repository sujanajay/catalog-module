"use client";

// User button in the top bar (spec 03 "UI"): "<email> · <Role> ▾", or "<email> · Viewer (preview) ▾"
// while previewing. Menu: "People" (admins only, hidden while previewing) and "Sign out", which goes to
// IAP's URL that clears its session cookie. The menu closes on any click outside it.
//
// While previewing, the People item (where the switch lives) is hidden, so the menu also offers the
// checked "Preview as viewer" item to turn the preview off again.

import { useEffect, useId, useRef, useState } from "react";
import {
  backToRoleToast,
  PREVIEW_LABEL,
  showPeopleMenuItem,
  SIGN_OUT_URL,
  userButtonLabel,
  type Role,
} from "@/lib/people-copy";
import PeopleModal from "./PeopleModal";
import { useToast } from "./Toast";
import { useViewerPreview } from "./ViewerPreview";

export interface UserMenuProps {
  email: string;
  role: Role;
}

export default function UserMenu({ email, role }: UserMenuProps) {
  const [open, setOpen] = useState(false);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const { previewing, setPreviewing } = useViewerPreview();
  const toast = useToast();
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const showPeople = showPeopleMenuItem(role, previewing);

  return (
    <div className="user" ref={wrapRef}>
      <button
        type="button"
        className="ub"
        data-testid="user-menu-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((o) => !o)}
      >
        {userButtonLabel(email, role, previewing)}
      </button>
      {open ? (
        <div className="menu" id={menuId} role="menu">
          {showPeople ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                setPeopleOpen(true);
              }}
            >
              People
            </button>
          ) : null}
          {previewing ? (
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked="true"
              onClick={() => {
                setOpen(false);
                setPreviewing(false);
                toast(backToRoleToast(role));
              }}
            >
              {PREVIEW_LABEL}
            </button>
          ) : null}
          <a role="menuitem" href={SIGN_OUT_URL}>
            Sign out
          </a>
        </div>
      ) : null}
      {peopleOpen ? <PeopleModal currentEmail={email} currentRole={role} onClose={() => setPeopleOpen(false)} /> : null}
    </div>
  );
}
