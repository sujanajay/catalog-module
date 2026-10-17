// Tier 2: the People API routes on a PGlite database with a fake current user per role (spec 03).
// The current user comes from SKIP_IAP=1 + DEV_USER_EMAIL (honoured because NODE_ENV is "test"), and
// the role from the real users table through roleFor, so the routes run end to end.
import { users } from "@catalog/core/db/schema";
import { createTestDb } from "@catalog/core/db/testing";
import { roleFor, seedAdmin, upsertPerson } from "@catalog/core/people";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE, PATCH } from "../app/api/people/[email]/route";
import { GET, POST } from "../app/api/people/route";
import { setDbForTests, type Db } from "../lib/db";
import { resetUserDeps } from "../lib/user";

const ADMIN = "sujan@opptra.com";
const OPERATOR = "naaz@opptra.com";
const VIEWER = "someone@opptra.com";
const FORBIDDEN = "You can view this but not change it. Ask an admin for the operator role.";

let db: Db;
let close: () => Promise<void>;

// One PGlite database per file; every test starts from just the seeded admin.
beforeAll(async () => {
  ({ db, close } = await createTestDb());
  setDbForTests(db);
});

afterAll(async () => {
  setDbForTests(undefined);
  await close();
});

beforeEach(async () => {
  resetUserDeps();
  await db.delete(users);
  await seedAdmin(db, ADMIN);
  await upsertPerson(db, { email: OPERATOR, role: "operator", addedBy: ADMIN });
  vi.stubEnv("SKIP_IAP", "1");
  vi.stubEnv("ALLOWED_HOSTED_DOMAIN", "opptra.com");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function as(email: string): void {
  vi.stubEnv("DEV_USER_EMAIL", email);
}

const url = "http://localhost/api/people";

function json(method: string, body: unknown, path = url): Request {
  return new Request(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

const ctx = (email: string) => ({ params: Promise.resolve({ email: encodeURIComponent(email) }) });

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe("GET /api/people", () => {
  it("lets a viewer list people (admins first) and creates the viewer's own row", async () => {
    as(VIEWER);
    const res = await GET(new Request(url));
    expect(res.status).toBe(200);
    const { people } = (await res.json()) as { people: { email: string; role: string; addedBy: string }[] };
    expect(people.map((p) => [p.email, p.role])).toEqual([
      [ADMIN, "admin"],
      [OPERATOR, "operator"],
      [VIEWER, "viewer"],
    ]);
    expect(people[2]!.addedBy).toBe("sign-in");
  });
});

describe("POST /api/people", () => {
  it("refuses a viewer with 403 and the sentence", async () => {
    as(VIEWER);
    const res = await POST(json("POST", { email: "new@opptra.com", role: "viewer" }));
    expect(res.status).toBe(403);
    expect(await body(res)).toEqual({ error: FORBIDDEN });
  });

  it("refuses an operator with 403", async () => {
    as(OPERATOR);
    const res = await POST(json("POST", { email: "new@opptra.com", role: "viewer" }));
    expect(res.status).toBe(403);
    expect(await body(res)).toEqual({ error: FORBIDDEN });
  });

  it("refuses a @gmail.com address with 400 and the sentence", async () => {
    as(ADMIN);
    const res = await POST(json("POST", { email: "someone@gmail.com", role: "viewer" }));
    expect(res.status).toBe(400);
    expect(await body(res)).toEqual({ error: "Only @opptra.com addresses can be added." });
  });

  it("refuses an unknown role or a bad body with 400", async () => {
    as(ADMIN);
    const res = await POST(json("POST", { email: "new@opptra.com", role: "owner" }));
    expect(res.status).toBe(400);
    expect((await body(res)).error).toMatch(/^role: /);
    const bad = await POST(new Request(url, { method: "POST", body: "{nope" }));
    expect(bad.status).toBe(400);
    expect(await body(bad)).toEqual({ error: "Invalid JSON body" });
  });
});

describe("admin flow", () => {
  it("POST 201, PATCH to operator 200, DELETE 204, then the person is a viewer again", async () => {
    as(ADMIN);
    const created = await POST(json("POST", { email: "New.Person@Opptra.com", role: "viewer" }));
    expect(created.status).toBe(201);
    const person = await body(created);
    expect(person).toMatchObject({ email: "new.person@opptra.com", role: "viewer", addedBy: ADMIN });
    expect(typeof person.createdAt).toBe("string");

    const patched = await PATCH(json("PATCH", { role: "operator" }, `${url}/new.person%40opptra.com`), ctx("new.person@opptra.com"));
    expect(patched.status).toBe(200);
    expect(await body(patched)).toMatchObject({ email: "new.person@opptra.com", role: "operator", addedBy: ADMIN });
    expect(await roleFor(db, "new.person@opptra.com")).toBe("operator");

    const deleted = await DELETE(new Request(`${url}/new.person%40opptra.com`, { method: "DELETE" }), ctx("new.person@opptra.com"));
    expect(deleted.status).toBe(204);
    expect(await deleted.text()).toBe("");
    expect(await roleFor(db, "new.person@opptra.com")).toBe("viewer");
  });

  it("PATCH demoting the last admin is 400 with the sentence", async () => {
    as(ADMIN);
    const res = await PATCH(json("PATCH", { role: "operator" }), ctx(ADMIN));
    expect(res.status).toBe(400);
    expect(await body(res)).toEqual({ error: "You cannot remove the last admin." });
    expect(await roleFor(db, ADMIN)).toBe("admin");
  });

  it("DELETE of the last admin is 400 with the sentence", async () => {
    as(ADMIN);
    const res = await DELETE(new Request(url, { method: "DELETE" }), ctx(ADMIN));
    expect(res.status).toBe(400);
    expect(await body(res)).toEqual({ error: "You cannot remove the last admin." });
  });

  it("DELETE of an unknown email is 204 (no-op)", async () => {
    as(ADMIN);
    const res = await DELETE(new Request(url, { method: "DELETE" }), ctx("ghost@opptra.com"));
    expect(res.status).toBe(204);
    expect((await db.select().from(users)).map((u) => u.email).sort()).toEqual([OPERATOR, ADMIN].sort());
  });

  it("PATCH of an unknown email is 404 Person not found and creates nothing", async () => {
    as(ADMIN);
    const res = await PATCH(json("PATCH", { role: "operator" }), ctx("ghost@opptra.com"));
    expect(res.status).toBe(404);
    expect(await body(res)).toEqual({ error: "Person not found" });
    expect((await db.select().from(users)).map((u) => u.email)).not.toContain("ghost@opptra.com");
  });

  it("PATCH and DELETE refuse an operator with 403", async () => {
    as(OPERATOR);
    const patched = await PATCH(json("PATCH", { role: "admin" }), ctx(OPERATOR));
    expect(patched.status).toBe(403);
    expect(await body(patched)).toEqual({ error: FORBIDDEN });
    const deleted = await DELETE(new Request(url, { method: "DELETE" }), ctx(ADMIN));
    expect(deleted.status).toBe(403);
    expect(await roleFor(db, ADMIN)).toBe("admin");
  });
});
