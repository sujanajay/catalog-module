import { describe, expect, it } from "vitest";
import { allowedEmail } from "../lib/auth-rules";

describe("allowedEmail", () => {
  it("rejects another domain", () => {
    expect(allowedEmail("someone@gmail.com", "opptra.com")).toBe(false);
  });

  it("rejects a domain that only starts with the allowed one", () => {
    expect(allowedEmail("someone@opptra.com.evil.com", "opptra.com")).toBe(false);
    expect(allowedEmail("someone@evil-opptra.com", "opptra.com")).toBe(false);
  });

  it("rejects an empty local part, a second @ and whitespace", () => {
    expect(allowedEmail("@opptra.com", "opptra.com")).toBe(false);
    expect(allowedEmail("a@b@opptra.com", "opptra.com")).toBe(false);
    expect(allowedEmail(" someone@opptra.com", "opptra.com")).toBe(false);
    expect(allowedEmail("someone@opptra.com", "")).toBe(false);
  });

  it("accepts the allowed domain in any case", () => {
    expect(allowedEmail("Someone@Opptra.com", "opptra.com")).toBe(true);
    expect(allowedEmail("someone@opptra.com", "OPPTRA.COM")).toBe(true);
  });
});
