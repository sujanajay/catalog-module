// People and their roles (spec 03, "People data functions" and "Users table and the auto-viewer rule").
//
// Every email is trimmed and lowercased before it touches the users table. Adding or changing a
// person requires an address of the allowed Workspace domain (ALLOWED_HOSTED_DOMAIN, default
// opptra.com). The last admin can be neither demoted nor removed; the check runs in a transaction
// that locks the admin rows, so two admins demoting each other at the same moment cannot both win.
import { asc, eq, sql } from "drizzle-orm";
import type { Role } from "./catalog/types";
import type { Db } from "./db/client";
import { users, type UserRow } from "./db/schema";

export interface Person { email: string; role: Role; addedBy: string; createdAt: Date; updatedAt: Date }

export const DEFAULT_ALLOWED_DOMAIN = "opptra.com";
export const LAST_ADMIN_MESSAGE = "You cannot remove the last admin.";
/** "Only @opptra.com addresses can be added." for the default domain. */
export const onlyDomainMessage = (domain: string) => `Only @${domain} addresses can be added.`;

/** added_by for the seeded admin and for rows created by the auto-viewer rule. */
export const SEED_ADDED_BY = "seed";
export const SIGN_IN_ADDED_BY = "sign-in";

/**
 * A user-facing rule violation (HTTP 400). packages/core does not import the web's HttpError, so the
 * web layer maps this by its `status` (apps/web/lib/errors.ts).
 */
export class PeopleError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "PeopleError";
  }
}

export function allowedDomainFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return (env.ALLOWED_HOSTED_DOMAIN?.trim() || DEFAULT_ALLOWED_DOMAIN).toLowerCase();
}

/** Trimmed and lowercased. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * True when the lowercase `email` has exactly one "@", a non-empty local part, and exactly the
 * lowercase `domain` after the "@" (so "x@opptra.com.evil.com" is refused). The one domain rule shared
 * by the People functions and the web's sign-in guard (apps/web/lib/auth-rules.ts).
 */
export function isEmailOfDomain(email: string, domain: string): boolean {
  const at = email.indexOf("@");
  return at > 0 && at === email.lastIndexOf("@") && email.slice(at + 1) === domain;
}

/** Normalised email of the allowed domain (one "@", non-empty local part), else PeopleError 400. */
export function requireAllowedEmail(email: string, allowedDomain: string = allowedDomainFromEnv()): string {
  const domain = allowedDomain.trim().toLowerCase();
  const e = normalizeEmail(email);
  if (!isEmailOfDomain(e, domain)) throw new PeopleError(onlyDomainMessage(domain));
  return e;
}

/** Drizzle transaction handle; it has the same query API as Db. */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

function toPerson(row: UserRow): Person {
  return { email: row.email, role: row.role, addedBy: row.addedBy, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

/**
 * Locks the admin rows until the transaction ends, then refuses (PeopleError 400) when `email` is the
 * only admin. The lock makes two admins demoting each other at the same moment wait for each other.
 */
async function assertNotLastAdmin(tx: Tx, email: string): Promise<void> {
  const admins = await tx.select({ email: users.email }).from(users).where(eq(users.role, "admin")).for("update");
  if (admins.length === 1 && admins[0]!.email === email) throw new PeopleError(LAST_ADMIN_MESSAGE);
}

const ROLE_RANK = sql`CASE ${users.role} WHEN 'admin' THEN 0 WHEN 'operator' THEN 1 ELSE 2 END`;

/** Everyone in the users table: admins first, then operators, then viewers; by email within a role. */
export async function listPeople(db: Db): Promise<Person[]> {
  const rows = await db.select().from(users).orderBy(ROLE_RANK, asc(users.email));
  return rows.map(toPerson);
}

/** One person, or null when the email has no row. */
export async function getPerson(db: Db, email: string): Promise<Person | null> {
  const [row] = await db.select().from(users).where(eq(users.email, normalizeEmail(email)));
  return row ? toPerson(row) : null;
}

/**
 * Add a person or change their role. added_by becomes `input.addedBy` (the acting admin) and
 * updated_at moves on every call. Refuses an address outside the allowed domain and the demotion of
 * the last admin (PeopleError 400).
 */
export async function upsertPerson(
  db: Db,
  input: { email: string; role: Role; addedBy: string },
  allowedDomain: string = allowedDomainFromEnv(),
): Promise<Person> {
  const email = requireAllowedEmail(input.email, allowedDomain);
  return db.transaction(async (tx) => {
    if (input.role !== "admin") await assertNotLastAdmin(tx, email);
    const [row] = await tx
      .insert(users)
      .values({ email, role: input.role, addedBy: input.addedBy })
      .onConflictDoUpdate({
        target: users.email,
        set: { role: input.role, addedBy: input.addedBy, updatedAt: sql`now()` },
      })
      .returning();
    return toPerson(row!);
  });
}

/**
 * Change the role of an existing person (PATCH in the People modal). added_by is kept, since it
 * records who added the person; updated_at moves. Returns null when the email has no row, so the
 * caller can answer 404 without a separate lookup racing a delete. Refuses the demotion of the last
 * admin (PeopleError 400).
 */
export async function setRole(db: Db, email: string, role: Role): Promise<Person | null> {
  const e = normalizeEmail(email);
  return db.transaction(async (tx) => {
    if (role !== "admin") await assertNotLastAdmin(tx, e);
    const [row] = await tx.update(users).set({ role, updatedAt: sql`now()` }).where(eq(users.email, e)).returning();
    return row ? toPerson(row) : null;
  });
}

/**
 * Delete a person's row; they are a viewer again on their next request (auto-viewer rule). An unknown
 * email is a no-op. Refuses to remove the last admin (PeopleError 400).
 */
export async function removePerson(db: Db, email: string): Promise<void> {
  const e = normalizeEmail(email);
  await db.transaction(async (tx) => {
    await assertNotLastAdmin(tx, e);
    await tx.delete(users).where(eq(users.email, e));
  });
}

/**
 * The role of a signed-in person, looked up on every call. A person without a row gets one with
 * role viewer and added_by "sign-in" (ON CONFLICT DO NOTHING, so two first requests racing each
 * other insert once). Callers verify the identity and its domain first (apps/web/lib/user.ts).
 */
export async function roleFor(db: Db, email: string): Promise<Role> {
  const e = normalizeEmail(email);
  const select = () => db.select({ role: users.role }).from(users).where(eq(users.email, e));
  const [found] = await select();
  if (found) return found.role;
  await db.insert(users).values({ email: e, role: "viewer", addedBy: SIGN_IN_ADDED_BY }).onConflictDoNothing({ target: users.email });
  const [row] = await select();
  // Only reachable if the row was deleted between the insert and the select; viewer is the fallback.
  return row?.role ?? "viewer";
}

/**
 * Seed the first admin (migrate job, after the migrations). Idempotent: an existing row is left as
 * it is, so a later role change by an admin survives a redeploy. A removed seed admin has no row, so
 * the next deploy seeds them again (spec 03 prescribes ON CONFLICT DO NOTHING). The address must be
 * of the allowed domain, so a typo cannot create an admin who can never sign in. Returns true when a
 * row was inserted.
 */
export async function seedAdmin(db: Db, email: string, allowedDomain: string = allowedDomainFromEnv()): Promise<boolean> {
  const e = requireAllowedEmail(email, allowedDomain);
  const rows = await db
    .insert(users)
    .values({ email: e, role: "admin", addedBy: SEED_ADDED_BY })
    .onConflictDoNothing({ target: users.email })
    .returning({ email: users.email });
  return rows.length > 0;
}
