// Pure copy and rules for the user menu and the People modal (spec 03 "UI").
// No React here, so vitest can cover it in the node environment.
import { ROLES, type Role } from "@catalog/core/catalog/types";

export { ROLES, type Role };

/** IAP's URL that clears its session cookie and shows Google's sign-in page again. */
export const SIGN_OUT_URL = "/?gcp-iap-mode=CLEAR_LOGIN_COOKIE";

export const PEOPLE_TITLE = "People";
export const PEOPLE_HELP =
  "Anyone with an @opptra.com Google account can sign in and view. Admins decide who can create batches and resolve attention items.";
export const ADD_PLACEHOLDER = "name@opptra.com";
export const PREVIEW_LABEL = "Preview as viewer";
export const PREVIEW_HELP = "Hides New batch and the action buttons, as a viewer sees them.";
export const PREVIEW_ON_TOAST = "Previewing as a viewer. Action buttons are hidden.";
/** Shown when an error response carries no `{ error }` sentence of its own. */
export const FALLBACK_ERROR = "Something went wrong. Try again.";

/** Role options in the add row: Viewer first (spec 01, section 9). */
export const ADD_ROLE_ORDER: readonly Role[] = ["viewer", "operator", "admin"];
/** Role options on a person's row. */
export const ROW_ROLE_ORDER: readonly Role[] = ["admin", "operator", "viewer"];

/** "admin" -> "Admin". */
export function roleLabel(role: Role): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

/** The user button: "<email> · <Role> ▾", or "<email> · Viewer (preview) ▾" while previewing. */
export function userButtonLabel(email: string, role: Role, previewing: boolean): string {
  const shown = previewing ? "Viewer (preview)" : roleLabel(role);
  return `${email} · ${shown} ▾`;
}

/** Toast after adding a person: "<email> added as <Role>." */
export function addedToast(email: string, role: Role): string {
  return `${email} added as ${roleLabel(role)}.`;
}

/** Toast after turning the preview off: "Back to <Role>." */
export function backToRoleToast(role: Role): string {
  return `Back to ${roleLabel(role)}.`;
}

/** Only admins manage people; previewing shows the read-only form an admin would not otherwise see. */
export function canManagePeople(role: Role, previewing: boolean): boolean {
  return role === "admin" && !previewing;
}

/** The "People" menu item: admins only, hidden while previewing. */
export function showPeopleMenuItem(role: Role, previewing: boolean): boolean {
  return canManagePeople(role, previewing);
}

/** The "Ops" menu item (the admin Ops page): gated like "People". */
export function showOpsMenuItem(role: Role, previewing: boolean): boolean {
  return canManagePeople(role, previewing);
}

export interface PersonRow {
  email: string;
  role: Role;
}

/** True when `email` is the only admin in the list (their role select is then disabled). */
export function isLastAdmin(people: readonly PersonRow[], email: string): boolean {
  const admins = people.filter((p) => p.role === "admin");
  return admins.length === 1 && admins[0]?.email === email.toLowerCase();
}

/** Same order as the server's listPeople: role (admin first), then email. */
export function sortPeople<T extends PersonRow>(people: readonly T[]): T[] {
  return [...people].sort(
    (a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role) || a.email.localeCompare(b.email),
  );
}

/** Insert or replace a person by email and keep the list sorted. */
export function upsertRow<T extends PersonRow>(people: readonly T[], person: T): T[] {
  return sortPeople([...people.filter((p) => p.email !== person.email), person]);
}

/** The sentence to show for a failed API call: the server's `{ error }` as returned, else a fallback. */
export function errorSentence(body: unknown): string {
  if (body && typeof body === "object" && "error" in body) {
    const error = (body as { error: unknown }).error;
    if (typeof error === "string" && error.trim()) return error;
  }
  return FALLBACK_ERROR;
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}
