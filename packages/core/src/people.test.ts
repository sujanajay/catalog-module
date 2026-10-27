// Tier 2 (PGlite): 0001_users.sql, the admin seed, the auto-viewer rule and the people rules (spec 03).
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db/client";
import { resolveMigrationsFolder, runMigrations } from "./db/migrate";
import { users } from "./db/schema";
import { createDbFromPglite } from "./db/testing";
import {
  LAST_ADMIN_MESSAGE,
  PeopleError,
  getPerson,
  listPeople,
  removePerson,
  requireAllowedEmail,
  roleFor,
  seedAdmin,
  setRole,
  upsertPerson,
} from "./people";

const ADMIN = "sujan@opptra.com";
const DOMAIN_MESSAGE = "Only @opptra.com addresses can be added.";

let db: Db;
let client: PGlite;
let tablesAfter0000: string[];

async function publicTables(): Promise<string[]> {
  return (await rows<{ table_name: string }>(sql`select table_name from information_schema.tables where table_schema = 'public'`)).map(
    (r) => r.table_name,
  );
}

// The file's database is migrated in two steps, so "0001 applies on top of 0000" is tested on the
// same single PGlite instance the other tests use: first a folder holding only 0000_init.sql, then
// the real folder (which applies 0001_users.sql only).
beforeAll(async () => {
  const real = resolveMigrationsFolder();
  const only0000 = await mkdtemp(path.join(tmpdir(), "catalog-0000-"));
  try {
    await mkdir(path.join(only0000, "meta"));
    await copyFile(path.join(real, "0000_init.sql"), path.join(only0000, "0000_init.sql"));
    const journal = JSON.parse(await readFile(path.join(real, "meta", "_journal.json"), "utf8")) as { entries: unknown[] };
    await writeFile(path.join(only0000, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, 1) }));
    ({ db, client } = createDbFromPglite());
    await runMigrations(db, only0000);
    tablesAfter0000 = await publicTables();
    await runMigrations(db, real);
  } finally {
    await rm(only0000, { recursive: true, force: true });
  }
});

afterAll(async () => {
  await client?.close();
});

// One database per file (PGlite starts slowly); every test starts with an empty users table.
beforeEach(async () => {
  await db.delete(users);
});

async function rows<T>(q: ReturnType<typeof sql>): Promise<T[]> {
  return ((await db.execute(q)) as unknown as { rows: T[] }).rows;
}

const userRows = () => db.select().from(users);

/** Resolves to the PeopleError a call throws (fails the test if it does not throw one). */
async function peopleError(p: Promise<unknown>): Promise<PeopleError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PeopleError);
  return err as PeopleError;
}

describe("0001_users.sql", () => {
  it("applies on top of 0000_init.sql", async () => {
    expect(tablesAfter0000).not.toContain("users");
    expect(tablesAfter0000).toContain("catalog_batches");
    expect(await publicTables()).toContain("users");
    const applied = await rows<{ n: number }>(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
    // Every migration in the journal is applied (0000_init and 0001_users among them).
    expect(applied[0]!.n).toBe(JSON.parse(await readFile(path.join(resolveMigrationsFolder(), "meta", "_journal.json"), "utf8")).entries.length);
    const cols = await rows<{ column_name: string; data_type: string; is_nullable: string }>(
      sql`select column_name, data_type, is_nullable from information_schema.columns where table_name = 'users' order by ordinal_position`,
    );
    expect(cols.map((c) => c.column_name)).toEqual(["email", "role", "added_by", "created_at", "updated_at"]);
    expect(cols.find((c) => c.column_name === "created_at")?.data_type).toBe("timestamp with time zone");
    const pk = await rows<{ column_name: string }>(sql`
      select kcu.column_name from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name
      where tc.table_name = 'users' and tc.constraint_type = 'PRIMARY KEY'`);
    expect(pk.map((r) => r.column_name)).toEqual(["email"]);
  });

  it("checks role against ROLES", async () => {
    await expect(db.execute(sql`insert into users (email, role, added_by) values ('a@opptra.com', 'owner', 't')`)).rejects.toThrow();
    await db.execute(sql`insert into users (email, role, added_by) values ('a@opptra.com', 'operator', 't')`);
    const [row] = await userRows();
    expect(row).toMatchObject({ email: "a@opptra.com", role: "operator", addedBy: "t" });
    expect(row!.createdAt).toBeInstanceOf(Date);
    expect(row!.updatedAt).toBeInstanceOf(Date);
  });
});

describe("seedAdmin", () => {
  it("is idempotent and never undoes a later role change", async () => {
    expect(await seedAdmin(db, ADMIN)).toBe(true);
    expect(await seedAdmin(db, ADMIN)).toBe(false);
    let all = await userRows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ email: ADMIN, role: "admin", addedBy: "seed" });

    // An admin changes the seeded row (another admin exists so the change is allowed).
    await upsertPerson(db, { email: "boss@opptra.com", role: "admin", addedBy: ADMIN });
    await upsertPerson(db, { email: ADMIN, role: "operator", addedBy: "boss@opptra.com" });
    expect(await seedAdmin(db, ADMIN)).toBe(false);
    all = await db.select().from(users).where(eq(users.email, ADMIN));
    expect(all).toHaveLength(1);
    expect(all[0]!.role).toBe("operator");
  });

  it("lowercases the email", async () => {
    await seedAdmin(db, "  Sujan@Opptra.com ");
    expect((await userRows()).map((r) => r.email)).toEqual([ADMIN]);
  });

  it("refuses an address outside the allowed domain and inserts nothing", async () => {
    await expect(seedAdmin(db, "sujan@gmail.com")).rejects.toThrow("Only @opptra.com addresses can be added.");
    await expect(seedAdmin(db, "not-an-email")).rejects.toBeInstanceOf(PeopleError);
    expect(await userRows()).toEqual([]);
  });
});

describe("roleFor", () => {
  it("returns admin for the seeded admin", async () => {
    await seedAdmin(db, ADMIN);
    expect(await roleFor(db, ADMIN)).toBe("admin");
    expect(await roleFor(db, "SUJAN@opptra.com")).toBe("admin");
    expect(await userRows()).toHaveLength(1);
  });

  it("inserts a viewer row with added_by sign-in once for an unknown address", async () => {
    expect(await roleFor(db, "New.Person@opptra.com")).toBe("viewer");
    let all = await userRows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ email: "new.person@opptra.com", role: "viewer", addedBy: "sign-in" });
    const first = all[0]!.createdAt;

    expect(await roleFor(db, "new.person@opptra.com")).toBe("viewer");
    all = await userRows();
    expect(all).toHaveLength(1);
    expect(all[0]!.createdAt).toEqual(first);
  });

  it("inserts once when two first requests race", async () => {
    const roles = await Promise.all([roleFor(db, "race@opptra.com"), roleFor(db, "race@opptra.com")]);
    expect(roles).toEqual(["viewer", "viewer"]);
    expect(await userRows()).toHaveLength(1);
  });
});

describe("people rules", () => {
  beforeEach(async () => {
    await seedAdmin(db, ADMIN);
  });

  it("lists admins first, then operators, then viewers, by email within a role", async () => {
    await upsertPerson(db, { email: "zed@opptra.com", role: "viewer", addedBy: ADMIN });
    await upsertPerson(db, { email: "amy@opptra.com", role: "viewer", addedBy: ADMIN });
    await upsertPerson(db, { email: "naaz@opptra.com", role: "operator", addedBy: ADMIN });
    await upsertPerson(db, { email: "bob@opptra.com", role: "operator", addedBy: ADMIN });
    await upsertPerson(db, { email: "zara@opptra.com", role: "admin", addedBy: ADMIN });
    await upsertPerson(db, { email: "abe@opptra.com", role: "admin", addedBy: ADMIN });
    const people = await listPeople(db);
    expect(people.map((p) => [p.role, p.email])).toEqual([
      ["admin", "abe@opptra.com"],
      ["admin", ADMIN],
      ["admin", "zara@opptra.com"],
      ["operator", "bob@opptra.com"],
      ["operator", "naaz@opptra.com"],
      ["viewer", "amy@opptra.com"],
      ["viewer", "zed@opptra.com"],
    ]);
    expect(people[0]).toEqual({
      email: "abe@opptra.com",
      role: "admin",
      addedBy: ADMIN,
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });
  });

  it("adds a person lowercased, then changes the role and moves updated_at", async () => {
    const added = await upsertPerson(db, { email: " Naaz@Opptra.COM", role: "viewer", addedBy: ADMIN });
    expect(added).toMatchObject({ email: "naaz@opptra.com", role: "viewer", addedBy: ADMIN });
    await new Promise((r) => setTimeout(r, 5));
    const changed = await upsertPerson(db, { email: "naaz@opptra.com", role: "operator", addedBy: ADMIN });
    expect(changed.role).toBe("operator");
    expect(changed.createdAt).toEqual(added.createdAt);
    expect(changed.updatedAt.getTime()).toBeGreaterThan(added.updatedAt.getTime());
    expect(await roleFor(db, "naaz@opptra.com")).toBe("operator");
    expect(await getPerson(db, "NAAZ@opptra.com")).toEqual(changed);
    expect(await getPerson(db, "nobody@opptra.com")).toBeNull();
  });

  it("rejects addresses outside the allowed domain with 400 and the sentence", async () => {
    for (const email of ["someone@gmail.com", "someone@opptra.com.evil.com", "@opptra.com", "a@b@opptra.com", "opptra.com"]) {
      const err = await peopleError(upsertPerson(db, { email, role: "viewer", addedBy: ADMIN }));
      expect(err.status).toBe(400);
      expect(err.message).toBe(DOMAIN_MESSAGE);
    }
    expect(await userRows()).toHaveLength(1);
  });

  it("uses the allowed domain argument or ALLOWED_HOSTED_DOMAIN", async () => {
    expect(requireAllowedEmail("A@Example.org", "example.org")).toBe("a@example.org");
    expect(() => requireAllowedEmail("a@opptra.com", "example.org")).toThrow("Only @example.org addresses can be added.");
    const prev = process.env.ALLOWED_HOSTED_DOMAIN;
    process.env.ALLOWED_HOSTED_DOMAIN = "example.org";
    try {
      const p = await upsertPerson(db, { email: "x@example.org", role: "viewer", addedBy: ADMIN });
      expect(p.email).toBe("x@example.org");
    } finally {
      if (prev === undefined) delete process.env.ALLOWED_HOSTED_DOMAIN;
      else process.env.ALLOWED_HOSTED_DOMAIN = prev;
    }
  });

  it("refuses to demote or remove the last admin with 400 and the sentence", async () => {
    for (const role of ["operator", "viewer"] as const) {
      const err = await peopleError(upsertPerson(db, { email: ADMIN, role, addedBy: ADMIN }));
      expect(err.status).toBe(400);
      expect(err.message).toBe(LAST_ADMIN_MESSAGE);
      expect(err.message).toBe("You cannot remove the last admin.");
    }
    const err = await peopleError(removePerson(db, "Sujan@opptra.com"));
    expect(err.status).toBe(400);
    expect(err.message).toBe("You cannot remove the last admin.");
    expect(await roleFor(db, ADMIN)).toBe("admin");

    // With a second admin both changes are allowed, and then the remaining one is the last again.
    await upsertPerson(db, { email: "boss@opptra.com", role: "admin", addedBy: ADMIN });
    await upsertPerson(db, { email: ADMIN, role: "operator", addedBy: "boss@opptra.com" });
    await expect(removePerson(db, "boss@opptra.com")).rejects.toThrow("You cannot remove the last admin.");
    await upsertPerson(db, { email: ADMIN, role: "admin", addedBy: "boss@opptra.com" });
    await removePerson(db, "boss@opptra.com");
    expect((await listPeople(db)).map((p) => p.email)).toEqual([ADMIN]);
  });

  it("re-saving the last admin as admin is allowed", async () => {
    const p = await upsertPerson(db, { email: ADMIN, role: "admin", addedBy: ADMIN });
    expect(p.role).toBe("admin");
  });

  it("removePerson of an unknown email is a no-op", async () => {
    await removePerson(db, "ghost@opptra.com");
    await removePerson(db, "ghost@gmail.com");
    expect((await listPeople(db)).map((p) => p.email)).toEqual([ADMIN]);
  });

  it("after removePerson the person falls back to viewer", async () => {
    await upsertPerson(db, { email: "naaz@opptra.com", role: "operator", addedBy: ADMIN });
    await removePerson(db, "NAAZ@opptra.com");
    expect(await getPerson(db, "naaz@opptra.com")).toBeNull();
    expect(await roleFor(db, "naaz@opptra.com")).toBe("viewer");
    expect(await getPerson(db, "naaz@opptra.com")).toMatchObject({ role: "viewer", addedBy: "sign-in" });
  });

  it("setRole changes the role of an existing person, keeps added_by and moves updated_at", async () => {
    const added = await upsertPerson(db, { email: "naaz@opptra.com", role: "viewer", addedBy: ADMIN });
    await new Promise((r) => setTimeout(r, 5));
    const changed = await setRole(db, "Naaz@opptra.com", "operator");
    expect(changed).toMatchObject({ email: "naaz@opptra.com", role: "operator", addedBy: ADMIN, createdAt: added.createdAt });
    expect(changed!.updatedAt.getTime()).toBeGreaterThan(added.updatedAt.getTime());
    expect(await setRole(db, "nobody@opptra.com", "operator")).toBeNull();
    expect(await getPerson(db, "nobody@opptra.com")).toBeNull();
  });

  it("setRole refuses to demote the last admin", async () => {
    const err = await peopleError(setRole(db, ADMIN, "viewer"));
    expect(err.status).toBe(400);
    expect(err.message).toBe("You cannot remove the last admin.");
    expect((await setRole(db, ADMIN, "admin"))?.role).toBe("admin");
  });
});
