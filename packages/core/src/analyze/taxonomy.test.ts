// Tier 2 (PGlite): the M2-S1 taxonomy store. The first test is the slice's acceptance test (R1-build section 7,
// M2-F1-R2): a new taxonomy node and a new attribute are added through the settings store and read back by the
// analyzer's read path, with no code change.
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../db/client";
import { runMigrations } from "../db/migrate";
import { createDbFromPglite, createTestDb } from "../db/testing";
import {
  CHILD_LEVELS,
  garmentGroupOf,
  TAXONOMY_WRITE_LOCK,
  writeTransaction,
  addAttribute,
  addShotRole,
  addTaxonomyNode,
  attributesFor,
  childrenOf,
  findNodes,
  loadTaxonomy,
  nodePath,
  shotRolesFor,
  TaxonomyError,
  updateAttribute,
  updateShotRole,
  updateTaxonomyNode,
} from "./taxonomy";
import { SEED_ATTRIBUTES, SEED_NODES, SEED_SHOT_ROLES, seedTaxonomy } from "./taxonomy-seed";

let db: Db;
let close: () => Promise<void>;
const admin = { by: "admin@opptra.com" };

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await seedTaxonomy(db);
});

afterAll(async () => {
  await close();
});

async function rows<T>(q: ReturnType<typeof sql>): Promise<T[]> {
  return ((await db.execute(q)) as unknown as { rows: T[] }).rows;
}

describe("acceptance: settings add a node and an attribute, read without a code change", () => {
  it("adds a node and an attribute in settings and the read path returns them", async () => {
    const before = await loadTaxonomy(db);
    await addTaxonomyNode(db, { id: "home.textile.table_runners", parentId: "home.textile", level: "type", name: "Table runners", aliases: ["runner"] }, admin);
    await addAttribute(
      db,
      { id: "panel_width", name: "Panel width", valueType: "number", unit: "cm", nodeIds: ["home.textile.curtains", "home.textile.table_runners"], tier: "listing", sourcePrecedence: ["sheet", "image"] },
      admin,
    );

    const snap = await loadTaxonomy(db);
    expect(snap.revision).toBeGreaterThan(before.revision);
    expect(snap.nodes.get("home.textile.table_runners")?.status).toBe("not_released");
    expect(nodePath(snap, "home.textile.table_runners").map((n) => n.id)).toEqual(["home", "home.textile", "home.textile.table_runners"]);
    expect(childrenOf(snap, "home.textile").map((n) => n.id)).toContain("home.textile.table_runners");
    expect(findNodes(snap, "Runner").map((n) => n.id)).toEqual(["home.textile.table_runners"]);
    for (const node of ["home.textile.curtains", "home.textile.table_runners"]) {
      expect(attributesFor(snap, node).map((a) => [a.id, a.valueType, a.unit])).toEqual([["panel_width", "number", "cm"]]);
    }
    // Fashion products do not get it.
    expect(attributesFor(snap, "fashion.apparel.upper.top").map((a) => a.id)).not.toContain("panel_width");
  });
});

describe("seed", () => {
  it("seeds the fashion tree with M5's garment groups, kids, multipack and an unknown under every parent", async () => {
    const snap = await loadTaxonomy(db);
    for (const id of [
      "fashion.apparel.upper", "fashion.apparel.full", "fashion.apparel.lower", "fashion.apparel.intimates_swim",
      "fashion.footwear", "fashion.bags", "fashion.apparel.kids", "fashion.apparel.multipack", "fashion.accessories",
      "fashion.apparel.upper.top", "fashion.apparel.lower.sports_bottom", "fashion.footwear.boots",
    ]) expect(snap.nodes.get(id)?.status, id).toBe("released");
    const parents = new Set([...snap.nodes.values()].map((n) => n.parentId));
    for (const parent of parents) expect(snap.nodes.has(parent ? `${parent}.unknown` : "unknown"), `unknown under ${parent}`).toBe(true);
    // Rule dataset words map to exactly one node each.
    for (const [word, id] of [["tops", "fashion.apparel.upper"], ["bottoms", "fashion.apparel.lower"], ["innerwear", "fashion.apparel.intimates_swim"], ["footwear", "fashion.footwear"], ["kids", "fashion.apparel.kids"], ["multipack", "fashion.apparel.multipack"], ["curtains", "home.textile.curtains"], ["dresses_jumpsuits", "fashion.apparel.full"]] as const)
      expect(findNodes(snap, word).map((n) => n.id), word).toEqual([id]);
  });

  it("seeds the other verticals as not released, with curtains and bedsheets under home", async () => {
    const snap = await loadTaxonomy(db);
    for (const id of ["home", "home.textile.curtains", "home.textile.bedsheets", "toys", "beauty", "hardline"]) expect(snap.nodes.get(id)?.status, id).toBe("not_released");
    expect(shotRolesFor(snap, "home.textile.curtains")).toEqual([]);
    expect(attributesFor(snap, "toys")).toEqual([]);
  });

  it("gives every seeded node a level its parent allows: product types are always `type`", async () => {
    const snap = await loadTaxonomy(db);
    for (const n of SEED_NODES) {
      const parent = n.parentId ? snap.nodes.get(n.parentId)! : null;
      expect(CHILD_LEVELS[parent ? parent.level : "root"], n.id).toContain(n.level);
    }
    const level = (id: string) => snap.nodes.get(id)?.level;
    for (const id of ["fashion.footwear.shoes", "fashion.footwear.sandals_slides", "fashion.footwear.boots", "fashion.footwear.slippers", "fashion.footwear.unknown",
      "fashion.apparel.upper.top", "fashion.apparel.full.dress_jumpsuit", "fashion.apparel.lower.bottom", "fashion.apparel.intimates_swim.swimwear",
      "home.textile.curtains", "home.textile.bedsheets", "home.fragrance.candles", "home.fragrance.diffusers"]) expect(level(id), id).toBe("type");
    expect(SEED_NODES.filter((n) => n.level === "group").map((n) => n.id).sort()).toEqual([
      "fashion.apparel.full", "fashion.apparel.intimates_swim", "fashion.apparel.kids", "fashion.apparel.lower",
      "fashion.apparel.multipack", "fashion.apparel.unknown", "fashion.apparel.upper",
    ]);
    for (const id of ["fashion.apparel", "fashion.footwear", "fashion.bags", "fashion.accessories", "home.textile"]) expect(level(id), id).toBe("department");
  });

  it("maps every product type to one of M5's six garment groups", async () => {
    const snap = await loadTaxonomy(db);
    const group = (id: string) => garmentGroupOf(snap, id)?.id;
    expect(group("fashion.apparel.upper.sports_top")).toBe("fashion.apparel.upper");
    expect(group("fashion.apparel.full.dress_jumpsuit")).toBe("fashion.apparel.full");
    expect(group("fashion.apparel.lower.sports_bottom")).toBe("fashion.apparel.lower");
    expect(group("fashion.apparel.intimates_swim.lingerie_underwear")).toBe("fashion.apparel.intimates_swim");
    expect(group("fashion.footwear.boots")).toBe("fashion.footwear");
    expect(group("fashion.bags")).toBe("fashion.bags");
    expect(group("fashion")).toBeUndefined();
  });

  it("every seeded word (key, name, alias) of a known node finds that node only", async () => {
    const snap = await loadTaxonomy(db);
    for (const n of SEED_NODES.filter((s) => !s.id.endsWith("unknown"))) {
      for (const word of [n.id.split(".").pop()!, n.name, ...(n.aliases ?? [])]) expect(findNodes(snap, word).map((m) => m.id), word).toEqual([n.id]);
    }
  });

  it("gives apparel types the apparel roles through inheritance, and footwear and bags their own", async () => {
    const snap = await loadTaxonomy(db);
    expect(shotRolesFor(snap, "fashion.apparel.upper.top").map((r) => r.key)).toEqual(["FM", "FL", "FC", "BH", "HS", "BL", "FW", "BW", "DT", "PK", "flat", "FB", "chart", "lifestyle", "other"]);
    expect(shotRolesFor(snap, "fashion.footwear.shoes").map((r) => r.key)).toContain("on_foot");
    expect(shotRolesFor(snap, "fashion.bags").map((r) => r.key)).toEqual(["front", "side", "back", "inside", "detail", "carried", "lifestyle", "other"]);
    expect(attributesFor(snap, "fashion.apparel.kids", "decision").map((a) => a.id)).toEqual(["audience", "garment_length", "pack", "primary_colours"]);
    expect(attributesFor(snap, "fashion.footwear.boots").map((a) => a.id)).not.toContain("garment_length");
  });

  it("is check then insert: a second run adds nothing and keeps an admin's edit", async () => {
    await updateTaxonomyNode(db, "fashion.apparel.upper.top", { name: "Top or shirt" }, admin);
    expect(await seedTaxonomy(db)).toEqual({ nodesAdded: 0, attributesAdded: 0, shotRolesAdded: 0 });
    const snap = await loadTaxonomy(db);
    expect(snap.nodes.get("fashion.apparel.upper.top")?.name).toBe("Top or shirt");
    const [seeded] = await rows<{ n: number }>(sql`select count(*)::int as n from catalog_taxonomy_changes where action = 'seed'`);
    expect(seeded!.n).toBe(SEED_NODES.length + SEED_ATTRIBUTES.length + SEED_SHOT_ROLES.length);
  });
});

describe("versions and the change log", () => {
  it("bumps the version and logs the full row on every write", async () => {
    await addShotRole(db, { nodeId: "fashion.apparel.intimates_swim.swimwear", key: "BK", name: "Back flat", definition: "Swimwear back, flat." }, admin);
    const role = await updateShotRole(db, "fashion.apparel.intimates_swim.swimwear", "BK", { definition: "Swimwear from the back, laid flat." }, { by: "admin@opptra.com", note: "clearer" });
    expect(role.version).toBe(2);
    const log = await rows<{ version: number; action: string; changed_by: string; note: string | null; definition: string }>(
      sql`select version, action, changed_by, note, data->>'definition' as definition from catalog_taxonomy_changes where entity = 'shot_role' and entity_id = 'fashion.apparel.intimates_swim.swimwear/BK' order by id`,
    );
    expect(log).toEqual([
      { version: 1, action: "create", changed_by: "admin@opptra.com", note: null, definition: "Swimwear back, flat." },
      { version: 2, action: "update", changed_by: "admin@opptra.com", note: "clearer", definition: "Swimwear from the back, laid flat." },
    ]);
    // A node with its own roles stops inheriting the apparel set.
    expect(shotRolesFor(await loadTaxonomy(db), "fashion.apparel.intimates_swim.swimwear").map((r) => r.key)).toEqual(["BK"]);
  });

  it("retires instead of deleting: a retired attribute or role is kept but no longer applies", async () => {
    await addAttribute(db, { id: "lining", name: "Lining", valueType: "enum", allowedValues: [{ key: "lined", label: "Lined" }, { key: "unlined", label: "Unlined" }], nodeIds: ["fashion.apparel"], tier: "listing", sourcePrecedence: ["sheet"] }, admin);
    const extended = await updateAttribute(db, "lining", { allowedValues: [{ key: "lined", label: "Lined" }, { key: "unlined", label: "Unlined" }, { key: "part_lined", label: "Part lined" }] }, admin);
    expect(extended.allowedValues?.map((v) => v.key)).toEqual(["lined", "unlined", "part_lined"]);
    await updateAttribute(db, "lining", { status: "retired" }, admin);
    const snap = await loadTaxonomy(db);
    expect(snap.attributes.get("lining")?.version).toBe(3);
    expect(attributesFor(snap, "fashion.apparel.full.dress_jumpsuit").map((a) => a.id)).not.toContain("lining");
  });
});

describe("serialized writes (the revision follows commit order)", () => {
  it("every write takes the taxonomy write lock first and holds it to the commit", async () => {
    const queries: string[] = [];
    const { db: logged, client } = createDbFromPglite(new PGlite(), { logger: { logQuery: (q) => queries.push(q) } });
    try {
      await runMigrations(logged);
      const firstAfter = async (write: () => Promise<unknown>) => {
        const start = queries.length;
        await write();
        return queries.slice(start).find((q) => !/^(begin|commit)/i.test(q.trim()));
      };
      const lock = /pg_advisory_xact_lock/;
      expect(await firstAfter(() => seedTaxonomy(logged))).toMatch(lock);
      expect(await firstAfter(() => addTaxonomyNode(logged, { id: "toys.dolls", parentId: "toys", level: "department", name: "Dolls" }, admin))).toMatch(lock);
      expect(await firstAfter(() => updateTaxonomyNode(logged, "toys.dolls", { name: "Dolls and figures" }, admin))).toMatch(lock);
      expect(await firstAfter(() => addAttribute(logged, { id: "age_band", name: "Age band", valueType: "text", nodeIds: ["toys"], tier: "listing", sourcePrecedence: ["sheet"] }, admin))).toMatch(lock);
      expect(await firstAfter(() => updateAttribute(logged, "age_band", { name: "Age range" }, admin))).toMatch(lock);
      expect(await firstAfter(() => addShotRole(logged, { nodeId: "toys", key: "box", name: "Box", definition: "The box." }, admin))).toMatch(lock);
      expect(await firstAfter(() => updateShotRole(logged, "toys", "box", { name: "Boxed" }, admin))).toMatch(lock);

      // The lock is a real transaction-level advisory lock on the fixed key, released at commit.
      const held = async (q: Db) =>
        ((await q.execute(sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and objid = ${TAXONOMY_WRITE_LOCK}`)) as unknown as { rows: { n: number }[] }).rows[0]!.n;
      expect(await writeTransaction(logged, (tx) => held(tx as unknown as Db))).toBe(1);
      expect(await held(logged)).toBe(0);
    } finally {
      await client.close();
    }
  });
});

describe("refusals", () => {
  const refuse = (p: Promise<unknown>, msg: RegExp) => expect(p).rejects.toThrow(msg);

  it("keeps the tree consistent", async () => {
    await refuse(addTaxonomyNode(db, { id: "home.textile.curtains", parentId: "home.textile", level: "type", name: "Curtains" }, admin), /already exists/);
    await refuse(addTaxonomyNode(db, { id: "home.rugs", parentId: "home.textile", level: "type", name: "Rugs" }, admin), /parent's id plus one/);
    await refuse(addTaxonomyNode(db, { id: "home.textile.rugs", parentId: "home.textile", level: "department", name: "Rugs" }, admin), /cannot sit under/);
    await refuse(addTaxonomyNode(db, { id: "home.rugs", parentId: "home", level: "type", name: "Rugs" }, admin), /cannot sit under a vertical \(allowed: department\)/);
    await refuse(addTaxonomyNode(db, { id: "fashion.apparel.upper.extra", parentId: "fashion.apparel.upper", level: "group", name: "Extra" }, admin), /cannot sit under a group/);
    await refuse(addTaxonomyNode(db, { id: "fashion.footwear.boots.chelsea", parentId: "fashion.footwear.boots", level: "type", name: "Chelsea" }, admin), /cannot sit under a type\./);
    await refuse(addTaxonomyNode(db, { id: "pets", parentId: null, level: "department", name: "Pets" }, admin), /Only a vertical/);
    await refuse(addTaxonomyNode(db, { id: "home.rugs", parentId: "home", level: "aisle" as never, name: "Rugs" }, admin), /Unknown category level aisle/);
    // A type may sit directly under a department (no finer group), as footwear types do.
    expect((await addTaxonomyNode(db, { id: "fashion.footwear.clogs", parentId: "fashion.footwear", level: "type", name: "Clogs" }, admin)).level).toBe("type");
    await refuse(addTaxonomyNode(db, { id: "nope.rugs", parentId: "nope", level: "type", name: "Rugs" }, admin), /does not exist/);
    await refuse(addTaxonomyNode(db, { id: "Pets", parentId: null, level: "vertical", name: "Pets" }, admin), /lower-case/);
    await refuse(updateTaxonomyNode(db, "home.textile", { status: "retired" }, admin), /Retire the categories under/);
    await refuse(updateTaxonomyNode(db, "missing", { name: "x" }, admin), /Unknown taxonomy node/);
    await addTaxonomyNode(db, { id: "beauty.old", parentId: "beauty", level: "department", name: "Old" }, admin);
    await addTaxonomyNode(db, { id: "beauty.old.kit", parentId: "beauty.old", level: "group", name: "Kit" }, admin);
    await updateTaxonomyNode(db, "beauty.old.kit", { status: "retired" }, admin);
    await updateTaxonomyNode(db, "beauty.old", { status: "retired" }, admin);
    await refuse(updateTaxonomyNode(db, "beauty.old.kit", { status: "released" }, admin), /Bring back the category above/);
  });

  it("keeps attribute definitions valid", async () => {
    const base = { id: "fit", name: "Fit", nodeIds: ["fashion.apparel"], tier: "listing" as const, sourcePrecedence: ["sheet" as const] };
    await refuse(addAttribute(db, { ...base, valueType: "enum" }, admin), /at least one allowed value/);
    await refuse(addAttribute(db, { ...base, valueType: "text", unit: "cm" }, admin), /Only a number attribute has a unit/);
    await refuse(addAttribute(db, { ...base, valueType: "text", nodeIds: ["fashion.nowhere"] }, admin), /Unknown categories/);
    await refuse(addAttribute(db, { ...base, valueType: "text", sourcePrecedence: ["sheet", "sheet"] }, admin), /distinct/);
    await refuse(updateAttribute(db, "audience", { allowedValues: [{ key: "women", label: "Women" }] }, admin), /cannot be removed/);
    await refuse(addAttribute(db, { ...base, valueType: "text" }, { by: " " }), /who made it/);
    // Nothing above was written.
    expect((await loadTaxonomy(db)).attributes.has("fit")).toBe(false);
  });

  it("the database itself refuses values outside the lists", async () => {
    await expect(db.execute(sql`insert into catalog_taxonomy_nodes (id, parent_id, level, name, status) values ('x', null, 'aisle', 'X', 'released')`)).rejects.toThrow();
    await expect(db.execute(sql`insert into catalog_shot_roles (node_id, key, name, definition) values ('no_such_node', 'FM', 'x', 'x')`)).rejects.toThrow();
  });

  it("is a TaxonomyError the settings screen can show", async () => {
    await expect(addTaxonomyNode(db, { id: "toys", parentId: null, level: "vertical", name: "Toys" }, admin)).rejects.toBeInstanceOf(TaxonomyError);
  });
});
