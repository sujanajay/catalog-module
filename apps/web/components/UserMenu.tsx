"use client";

// User button in the top bar (spec 03 "UI"): "<email> · <Role> ▾", or "<email> · Viewer (preview) ▾"
// while previewing. Menu: "People" and "Ops" (admins only, hidden while previewing); "Preview as viewer", a
// checkable item offered to every role per the permission matrix (the People modal keeps its own
// switch); "Sign out", which goes to IAP's URL that clears its session cookie. The menu closes on any
// click outside it.

import { useEffect, useId, useRef, useState } from "react";
import { PREVIEW_LABEL, showOpsMenuItem, showPeopleMenuItem, SIGN_OUT_URL, userButtonLabel, type Role } from "@/lib/people-copy";
import { OPS_HREF, OPS_TITLE } from "@/lib/catalog/ops-copy";
import PeopleModal from "./PeopleModal";
import { usePreviewToggle, useViewerPreview } from "./ViewerPreview";

export interface UserMenuProps {
  email: string;
  role: Role;
}

export default function UserMenu({ email, role }: UserMenuProps) {
  const [open, setOpen] = useState(false);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const { previewing } = useViewerPreview();
  const togglePreview = usePreviewToggle(role);
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
  const showOps = showOpsMenuItem(role, previewing);

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
          {showOps ? (
            <a role="menuitem" href={OPS_HREF} onClick={() => setOpen(false)}>
              {OPS_TITLE}
            </a>
          ) : null}
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={previewing}
            onClick={() => {
              setOpen(false);
              togglePreview(!previewing);
            }}
          >
            {PREVIEW_LABEL}
          </button>
          <a role="menuitem" href={SIGN_OUT_URL}>
            Sign out
          </a>
        </div>
      ) : null}
      {peopleOpen ? <PeopleModal currentEmail={email} currentRole={role} onClose={() => setPeopleOpen(false)} /> : null}
    </div>
  );
}
