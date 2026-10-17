// Who is calling, and what may they do (spec 03, "The IAP identity in the app").
// currentUser(): IAP JWT -> allowedEmail -> role lookup, on every call (nothing about the role is
// cached across requests, so a change in the People modal applies at once). requireRole():
// ForbiddenError below min.
import { headers } from "next/headers";
import { cache } from "react";
import { ROLES, type Role } from "@catalog/core/catalog/types";
import { allowedDomainFromEnv, roleFor } from "@catalog/core/people";
import { allowedEmail } from "./auth-rules";
import { db } from "./db";
import { ForbiddenError, HttpError, unauthorized } from "./errors";
import { IAP_JWT_HEADER, verifyIapJwt, type IapDeps } from "./iap";

export type CurrentUser = { email: string; role: Role };

/** Looks up (and, per the auto-viewer rule, creates) the role of a verified email. */
export type RoleLookup = (email: string) => Promise<Role>;

const DEFAULT_DEV_EMAIL = "sujan@opptra.com";

/** Production lookup: the users table, with the auto-viewer rule (packages/core/src/people.ts). */
const defaultRoleLookup: RoleLookup = (email) => roleFor(db(), email);

let roleLookup: RoleLookup = defaultRoleLookup;
let iapDeps: IapDeps | undefined;
const warned = new Set<string>();

/**
 * Tests only: replace the role lookup and/or the IAP key source. Call resetUserDeps() afterwards.
 * Omitted fields keep their current value.
 */
export function setUserDeps(deps: { roleLookup?: RoleLookup; iapDeps?: IapDeps }): void {
  if (deps.roleLookup) roleLookup = deps.roleLookup;
  if (deps.iapDeps) iapDeps = deps.iapDeps;
}

/** Tests only: back to the production role lookup and IAP keys; one-time warnings may print again. */
export function resetUserDeps(): void {
  roleLookup = defaultRoleLookup;
  iapDeps = undefined;
  warned.clear();
}

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[web] ${message}`);
}

/** SKIP_IAP=1 is honoured only outside production; in production it is ignored with one warning. */
function skipIap(): boolean {
  if (process.env.SKIP_IAP !== "1") return false;
  if (process.env.NODE_ENV === "production") {
    warnOnce("skip-iap", "SKIP_IAP=1 is ignored in production; the IAP JWT is always verified.");
    return false;
  }
  return true;
}

type HeaderSource = Pick<Headers, "get">;

async function readHeaders(source?: Headers | Request): Promise<HeaderSource> {
  if (source instanceof Request) return source.headers;
  return source ?? (await headers());
}

async function verifiedEmail(source?: Headers | Request): Promise<string> {
  if (skipIap()) return (process.env.DEV_USER_EMAIL || DEFAULT_DEV_EMAIL).toLowerCase();
  const token = (await readHeaders(source)).get(IAP_JWT_HEADER);
  if (!token) throw unauthorized();
  const audience = process.env.IAP_AUDIENCE ?? "";
  if (!audience) warnOnce("no-audience", "IAP_AUDIENCE is not set; every request is refused with 401.");
  return (await verifyIapJwt(token, audience, iapDeps)).email;
}

async function resolveUser(source?: Headers | Request): Promise<CurrentUser> {
  const email = await verifiedEmail(source);
  const domain = allowedDomainFromEnv();
  if (!allowedEmail(email, domain)) throw new HttpError(403, `Use your @${domain} Google account.`);
  return { email, role: await roleLookup(email) };
}

// One check per server render: the root layout and the page both call currentUser() for the same
// request. React's cache() is scoped to a single request, so a role change still applies on the next.
const currentUserOfRender = cache(() => resolveUser());

/**
 * The signed-in person. Reads the IAP JWT from `source` (request.headers or the Request in route
 * handlers) or, when omitted, from `await headers()` (server components and server actions).
 * Throws HttpError 401 "Sign in to continue." without a valid JWT, and HttpError 403 when the verified
 * email is outside ALLOWED_HOSTED_DOMAIN (default opptra.com).
 */
export function currentUser(source?: Headers | Request): Promise<CurrentUser> {
  return source ? resolveUser(source) : currentUserOfRender();
}

/** admin > operator > viewer (ROLES lists them highest first); true when `role` is `min` or higher. */
export function atLeast(role: Role, min: Role): boolean {
  return ROLES.indexOf(role) <= ROLES.indexOf(min);
}

/** currentUser(), then ForbiddenError (HTTP 403) when the role is below `min`. */
export async function requireRole(min: Role, source?: Headers | Request): Promise<CurrentUser> {
  const user = await currentUser(source);
  if (!atLeast(user.role, min)) throw new ForbiddenError();
  return user;
}
