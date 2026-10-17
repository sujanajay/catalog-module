import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Role } from "@catalog/core/catalog/types";
import { errorResponse, ForbiddenError, HttpError } from "../lib/errors";
import { IAP_JWT_HEADER, resetIapKeysCache } from "../lib/iap";
import { atLeast, currentUser, requireRole, resetUserDeps, setUserDeps } from "../lib/user";
import { fakeDeps, makeKey, signJwt, TEST_AUDIENCE } from "./helpers/iap-jwt";

const FORBIDDEN = "You can view this but not change it. Ask an admin for the operator role.";
const key = makeKey("kid-user");

function withJwt(claims: Record<string, unknown> = {}): Headers {
  return new Headers({ [IAP_JWT_HEADER]: signJwt(key, claims) });
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => undefined,
    (e: unknown) => e,
  );
}

const roles = new Map<string, Role>();

beforeEach(() => {
  vi.stubEnv("IAP_AUDIENCE", TEST_AUDIENCE);
  vi.stubEnv("ALLOWED_HOSTED_DOMAIN", "opptra.com");
  vi.stubEnv("SKIP_IAP", "");
  vi.stubEnv("DEV_USER_EMAIL", "");
  roles.clear();
  setUserDeps({
    iapDeps: fakeDeps([key]).deps,
    roleLookup: async (email) => roles.get(email) ?? "viewer",
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetUserDeps();
  resetIapKeysCache();
});

describe("atLeast", () => {
  it("orders admin > operator > viewer", () => {
    expect([atLeast("admin", "admin"), atLeast("admin", "operator"), atLeast("admin", "viewer")]).toEqual([true, true, true]);
    expect([atLeast("operator", "admin"), atLeast("operator", "operator"), atLeast("operator", "viewer")]).toEqual([false, true, true]);
    expect([atLeast("viewer", "admin"), atLeast("viewer", "operator"), atLeast("viewer", "viewer")]).toEqual([false, false, true]);
  });
});

describe("requireRole", () => {
  it("lets each role through exactly where atLeast says so, else ForbiddenError 403 with the sentence", async () => {
    const people: Record<Role, string> = { admin: "a@opptra.com", operator: "o@opptra.com", viewer: "v@opptra.com" };
    for (const [role, email] of Object.entries(people) as [Role, string][]) roles.set(email, role);

    for (const [role, email] of Object.entries(people) as [Role, string][]) {
      for (const min of ["admin", "operator", "viewer"] as Role[]) {
        const p = requireRole(min, withJwt({ email }));
        if (atLeast(role, min)) {
          expect(await p).toEqual({ email, role });
        } else {
          const err = await caught(p);
          expect(err).toBeInstanceOf(ForbiddenError);
          expect(err).toMatchObject({ status: 403, message: FORBIDDEN });
        }
      }
    }
  });

  it("turns into a 403 { error } JSON response", async () => {
    const err = await caught(requireRole("operator", withJwt({ email: "v@opptra.com" })));
    const res = errorResponse(err);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: FORBIDDEN });
  });
});

describe("currentUser", () => {
  it("returns the verified, lowercased email and its role; takes a Request as well as Headers", async () => {
    roles.set("boss@opptra.com", "admin");
    expect(await currentUser(withJwt({ email: "Boss@Opptra.com" }))).toEqual({ email: "boss@opptra.com", role: "admin" });
    const req = new Request("http://web/api/people", { headers: withJwt({ email: "boss@opptra.com" }) });
    expect(await currentUser(req)).toEqual({ email: "boss@opptra.com", role: "admin" });
  });

  it("no header -> 401 Sign in to continue.", async () => {
    const err = await caught(currentUser(new Headers()));
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 401, message: "Sign in to continue." });
  });

  it("ignores the plain x-goog-authenticated-user-email header", async () => {
    const h = new Headers({ "x-goog-authenticated-user-email": "accounts.google.com:boss@opptra.com" });
    expect(await caught(currentUser(h))).toMatchObject({ status: 401 });
  });

  it("a JWT for another audience -> 401", async () => {
    vi.stubEnv("IAP_AUDIENCE", "/projects/1/locations/asia-south1/services/other");
    expect(await caught(currentUser(withJwt()))).toMatchObject({ status: 401, message: "Sign in to continue." });
  });

  it("valid JWT with a verified @gmail.com email -> 403 Use your @opptra.com Google account.", async () => {
    const lookup = vi.fn(async () => "viewer" as Role);
    setUserDeps({ roleLookup: lookup });
    const err = await caught(currentUser(withJwt({ email: "someone@gmail.com" })));
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 403, message: "Use your @opptra.com Google account." });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("SKIP_IAP=1 outside production -> DEV_USER_EMAIL (default sujan@opptra.com)", async () => {
    vi.stubEnv("SKIP_IAP", "1");
    roles.set("sujan@opptra.com", "admin");
    expect(await currentUser(new Headers())).toEqual({ email: "sujan@opptra.com", role: "admin" });
    vi.stubEnv("DEV_USER_EMAIL", "Dev.Person@opptra.com");
    expect(await currentUser(new Headers())).toEqual({ email: "dev.person@opptra.com", role: "viewer" });
  });

  it("SKIP_IAP=1 with NODE_ENV=production is ignored (401 without a header) and warned about once", async () => {
    vi.stubEnv("SKIP_IAP", "1");
    vi.stubEnv("NODE_ENV", "production");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await caught(currentUser(new Headers()))).toMatchObject({ status: 401, message: "Sign in to continue." });
    expect(await caught(currentUser(new Headers()))).toMatchObject({ status: 401 });
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/SKIP_IAP/);
    // The real JWT path still works in production.
    expect(await currentUser(withJwt())).toEqual({ email: "someone@opptra.com", role: "viewer" });
  });
});
