// Tier 2: the M12-S1 settings API and the plain Settings list page on PGlite, with a fake current user per role (the
// role comes from the real users table; SKIP_IAP=1 + DEV_USER_EMAIL, honoured because NODE_ENV is "test").
import { renderToStaticMarkup } from "react-dom/server";
import { catalogSettingVersions, users } from "@catalog/core/db/schema";
import { createTestDb } from "@catalog/core/db/testing";
import { seedAdmin, upsertPerson } from "@catalog/core/people";
import { DEFAULT_OWNERS, SETTING_DEFS, UPSCALE_MIN_SCALE_KEY } from "@catalog/core/settings/registry";
import { currentValue } from "@catalog/core/settings/store";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/api/settings/route";
import { POST as change } from "../app/api/settings/changes/route";
import { POST as revert } from "../app/api/settings/versions/[id]/revert/route";
import SettingsPage from "../app/catalog/settings/page";
import { setDbForTests, type Db } from "../lib/db";
import { ForbiddenError } from "../lib/errors";
import { resetUserDeps } from "../lib/user";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));

const OWNER = DEFAULT_OWNERS[0]!;
const ADMIN = "lead@opptra.com";
const OPERATOR = "naaz@opptra.com";
const MODEL_WORDS = /gemini|claude|qwen|birefnet|rmbg|bria|swinir|esrgan|google\/|anthropic\/|openai\//i;

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  setDbForTests(db);
}, 120_000);
afterAll(async () => {
  setDbForTests(undefined);
  await close();
});
beforeEach(async () => {
  resetUserDeps();
  await db.delete(catalogSettingVersions);
  await db.delete(users);
  await seedAdmin(db, OWNER);
  await upsertPerson(db, { email: ADMIN, role: "admin", addedBy: OWNER });
  await upsertPerson(db, { email: OPERATOR, role: "operator", addedBy: OWNER });
  vi.stubEnv("SKIP_IAP", "1");
  vi.stubEnv("ALLOWED_HOSTED_DOMAIN", "opptra.com");
});
afterEach(() => { vi.unstubAllEnvs(); });

const as = (email: string) => vi.stubEnv("DEV_USER_EMAIL", email);
const post = (url: string, body: unknown) => new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const changes = "http://localhost/api/settings/changes";
const revertCtx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("GET /api/settings", () => {
  it("lists every setting by area for an admin, and refuses an operator", async () => {
    as(ADMIN);
    const res = await GET(new Request("http://localhost/api/settings"));
    expect(res.status).toBe(200);
    const view = (await res.json()) as { owner: boolean; areas: { area: string; settings: { key: string }[] }[] };
    expect(view.owner).toBe(false);
    expect(view.areas.flatMap((a) => a.settings.map((s) => s.key)).sort()).toEqual(SETTING_DEFS.map((d) => d.key).sort());
    const people = (await (await GET(new Request("http://localhost/api/settings?area=people"))).json()) as typeof view;
    expect(people.areas.map((a) => a.area)).toEqual(["people"]);
    expect((await GET(new Request("http://localhost/api/settings?area=nope"))).status).toBe(400);
    as(OPERATOR);
    expect((await GET(new Request("http://localhost/api/settings"))).status).toBe(403);
  });
});

describe("POST /api/settings/changes and revert", () => {
  it("applies an admin's change from the next batch, and undoes it in one call", async () => {
    as(ADMIN);
    const res = await change(post(changes, { key: "intake.auto_decide.corrupt", scope: { channel: "noon" }, value: "deliver", reason: "Noon accepts it." }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { change_id: string; version: number; risk: string; effective: string };
    expect(body).toMatchObject({ version: 1, risk: "normal", effective: "next_batch" });
    expect(await currentValue(db, "intake.auto_decide.corrupt", { channel: "noon" })).toBe("deliver");
    const undo = await revert(post(`http://localhost/api/settings/versions/${body.change_id}/revert`, {}), revertCtx(body.change_id));
    expect(undo.status).toBe(200);
    expect(await currentValue(db, "intake.auto_decide.corrupt", { channel: "noon" })).toBe("drop");
    expect((await revert(post("http://localhost/x", {}), revertCtx("not-a-uuid"))).status).toBe(400);
  });

  it("refuses bad values with the plain sentence, an owner-only change from a non-owner, and an operator", async () => {
    as(ADMIN);
    const bad = await change(post(changes, { key: "intake.start_countdown_seconds", value: 99 }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "Countdown before a batch starts: enter a number from 0 to 60." });
    const owner = await change(post(changes, { key: UPSCALE_MIN_SCALE_KEY, value: 1.5 }));
    expect(owner.status).toBe(403);
    expect(((await owner.json()) as { error: string }).error).toContain(`Ask ${OWNER}.`);
    as(OWNER);
    expect((await change(post(changes, { key: UPSCALE_MIN_SCALE_KEY, value: 1.5 }))).status).toBe(200);
    as(OPERATOR);
    expect((await change(post(changes, { key: "intake.auto_start", value: false }))).status).toBe(403);
  });
});

describe("the Settings page", () => {
  it("shows each setting in plain words, marks owner-only and not-yet-used ones, and is admin only", async () => {
    as(OWNER);
    const html = renderToStaticMarkup(await SettingsPage());
    expect(html).toContain("Enlarge with the quality pass above");
    expect(html).toContain("Owner only");
    expect(html).toContain("Not in use yet.");
    expect(html).toContain("Apply from the next batch");
    expect(html).not.toMatch(MODEL_WORDS);
    as(OPERATOR);
    await expect(SettingsPage()).rejects.toBeInstanceOf(ForbiddenError);
  });
});
