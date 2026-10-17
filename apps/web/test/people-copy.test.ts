import { describe, expect, it } from "vitest";
import {
  ADD_ROLE_ORDER,
  addedToast,
  backToRoleToast,
  canManagePeople,
  errorSentence,
  FALLBACK_ERROR,
  isLastAdmin,
  isRole,
  roleLabel,
  showPeopleMenuItem,
  sortPeople,
  upsertRow,
  userButtonLabel,
  type PersonRow,
} from "../lib/people-copy";

describe("people copy", () => {
  it("capitalises role labels", () => {
    expect(roleLabel("admin")).toBe("Admin");
    expect(roleLabel("operator")).toBe("Operator");
    expect(roleLabel("viewer")).toBe("Viewer");
  });

  it("builds the user button label with the middle dot, and the preview form", () => {
    expect(userButtonLabel("sujan@opptra.com", "admin", false)).toBe("sujan@opptra.com · Admin ▾");
    expect(userButtonLabel("sujan@opptra.com", "admin", true)).toBe("sujan@opptra.com · Viewer (preview) ▾");
    expect(userButtonLabel("naaz@opptra.com", "operator", false)).toBe("naaz@opptra.com · Operator ▾");
  });

  it("builds the toasts", () => {
    expect(addedToast("name@opptra.com", "operator")).toBe("name@opptra.com added as Operator.");
    expect(backToRoleToast("admin")).toBe("Back to Admin.");
    expect(backToRoleToast("operator")).toBe("Back to Operator.");
  });

  it("lists Viewer first in the add row", () => {
    expect(ADD_ROLE_ORDER[0]).toBe("viewer");
  });

  it("lets only a non-previewing admin manage people or see the People item", () => {
    expect(canManagePeople("admin", false)).toBe(true);
    expect(canManagePeople("admin", true)).toBe(false);
    expect(canManagePeople("operator", false)).toBe(false);
    expect(canManagePeople("viewer", false)).toBe(false);
    expect(showPeopleMenuItem("admin", false)).toBe(true);
    expect(showPeopleMenuItem("admin", true)).toBe(false);
    expect(showPeopleMenuItem("operator", false)).toBe(false);
  });

  it("detects the last admin", () => {
    const one: PersonRow[] = [
      { email: "sujan@opptra.com", role: "admin" },
      { email: "naaz@opptra.com", role: "operator" },
    ];
    expect(isLastAdmin(one, "sujan@opptra.com")).toBe(true);
    expect(isLastAdmin(one, "Sujan@Opptra.com")).toBe(true);
    expect(isLastAdmin(one, "naaz@opptra.com")).toBe(false);
    const two: PersonRow[] = [...one, { email: "ops@opptra.com", role: "admin" }];
    expect(isLastAdmin(two, "sujan@opptra.com")).toBe(false);
  });

  it("sorts by role then email and upserts by email", () => {
    const rows: PersonRow[] = [
      { email: "z@opptra.com", role: "viewer" },
      { email: "b@opptra.com", role: "admin" },
      { email: "a@opptra.com", role: "operator" },
      { email: "c@opptra.com", role: "admin" },
    ];
    expect(sortPeople(rows).map((r) => r.email)).toEqual([
      "b@opptra.com",
      "c@opptra.com",
      "a@opptra.com",
      "z@opptra.com",
    ]);
    const changed = upsertRow(rows, { email: "z@opptra.com", role: "admin" });
    expect(changed).toHaveLength(4);
    expect(changed.map((r) => r.email).slice(0, 3)).toEqual(["b@opptra.com", "c@opptra.com", "z@opptra.com"]);
  });

  it("shows the server's error sentence as returned, else a fallback", () => {
    expect(errorSentence({ error: "Only @opptra.com addresses can be added." })).toBe(
      "Only @opptra.com addresses can be added.",
    );
    expect(errorSentence({ error: "" })).toBe(FALLBACK_ERROR);
    expect(errorSentence(null)).toBe(FALLBACK_ERROR);
    expect(errorSentence("nope")).toBe(FALLBACK_ERROR);
  });

  it("recognises roles", () => {
    expect(isRole("admin")).toBe(true);
    expect(isRole("owner")).toBe(false);
  });
});
