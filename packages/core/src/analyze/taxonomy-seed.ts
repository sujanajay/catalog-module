// M2-S1 seed of the taxonomy store (M2-F1-R1 to R3, M5-F1-R5). Written by the migrate job (apps/worker/src/migrate.ts)
// with "check then insert": a row already in the store is never overwritten, so an admin's edit or retirement
// survives every later deploy. Changing a seeded definition is a settings change (analyze/taxonomy.ts), not an edit
// here; this file only decides what an empty store starts with.
//
// Tree shape: vertical > department > group > type. Every node with children has an `unknown` child (one unknown per
// level). Fashion carries the six garment groups of M5 (apparel upper, full, lower, intimates and swim; footwear and
// bags, which are departments with no finer group) plus the plan nodes `kids` and `multipack` under apparel: the
// analyzer's strictest-plan step (M2-F1-R14) chooses them over the garment's own node. Audience is recorded apart, as
// the `audience` attribute. Aliases are the words of the channel rules dataset and brand sheets that mean the node.
// Non-fashion verticals are seeded `not_released`: they exist so gaps are visible, with no rules or labels yet.
import type { Db } from "../db/client";
import { catalogAttributeDefs, catalogShotRoles, catalogTaxonomyNodes } from "../db/schema";
import {
  logChange,
  normalizeAttribute,
  type AttributeInput,
  type ShotRoleInput,
  type TaxonomyLevel,
  type TaxonomyNodeInput,
  type TaxonomyNodeStatus,
} from "./taxonomy";

const SEED_BY = { by: "seed", note: "M2-S1 seed" };

type NodeSpec = { key: string; name: string; aliases?: string[]; status?: TaxonomyNodeStatus; children?: NodeSpec[] };

const LEVELS: TaxonomyLevel[] = ["vertical", "department", "group", "type"];

type SeedNode = TaxonomyNodeInput & { status: TaxonomyNodeStatus };

/** Builds the node list parent first, adding an `unknown` child to every node that has children. */
function flatten(specs: NodeSpec[], parentStatus: TaxonomyNodeStatus, parentId: string | null = null, depth = 0, out: SeedNode[] = []): SeedNode[] {
  const withUnknown: NodeSpec[] = specs.length ? [...specs, { key: "unknown", name: "Not known" }] : specs;
  withUnknown.forEach((spec, i) => {
    const id = parentId ? `${parentId}.${spec.key}` : spec.key;
    const status = spec.status ?? parentStatus;
    out.push({ id, parentId, level: LEVELS[depth]!, name: spec.name, aliases: spec.aliases ?? [], status, sortOrder: spec.key === "unknown" ? 999 : i });
    if (spec.children?.length) flatten(spec.children, status, id, depth + 1, out);
  });
  return out;
}

const FASHION: NodeSpec = {
  key: "fashion",
  name: "Fashion",
  status: "released",
  children: [
    {
      key: "apparel",
      name: "Apparel",
      aliases: ["adult_apparel"],
      children: [
        {
          key: "upper",
          name: "Apparel upper",
          aliases: ["tops"],
          children: [
            { key: "top", name: "Top", aliases: ["t_shirt", "shirt", "blouse", "polo"] },
            { key: "knitwear_sweatshirt", name: "Knitwear or sweatshirt", aliases: ["knitwear", "sweatshirt", "hoodie", "sweater"] },
            { key: "jacket_coat", name: "Jacket or coat", aliases: ["outerwear", "outerwear_jackets_coats", "jacket", "coat"] },
            { key: "sports_top", name: "Sports top or sports bra", aliases: ["sports_tops_incl_sports_bras", "sports_bra"] },
            { key: "nightwear_loungewear", name: "Nightwear or loungewear", aliases: ["nightwear", "loungewear"] },
          ],
        },
        { key: "full", name: "Apparel full", aliases: ["dresses_jumpsuits"], children: [{ key: "dress_jumpsuit", name: "Dress or jumpsuit", aliases: ["dress", "jumpsuit"] }] },
        {
          key: "lower",
          name: "Apparel lower",
          aliases: ["bottoms", "bottoms_sports_bottoms"],
          children: [
            { key: "bottom", name: "Trousers, jeans, shorts or skirt", aliases: ["trousers", "jeans", "denim", "shorts", "skirt"] },
            { key: "sports_bottom", name: "Leggings, sports shorts or joggers", aliases: ["leggings", "joggers"] },
          ],
        },
        {
          key: "intimates_swim",
          name: "Intimates and swim",
          aliases: ["innerwear"],
          children: [
            { key: "lingerie_underwear", name: "Lingerie or underwear", aliases: ["lingerie", "underwear", "bras"] },
            { key: "swimwear", name: "Swimwear", aliases: ["swim"] },
          ],
        },
        { key: "multipack", name: "Pack of several pieces", aliases: ["pack"] },
        { key: "kids", name: "Kids", aliases: ["kidswear"] },
      ],
    },
    {
      key: "footwear",
      name: "Footwear",
      children: [
        { key: "shoes", name: "Shoes", aliases: ["sneakers", "trainers"] },
        { key: "sandals_slides", name: "Sandals and slides", aliases: ["sandals", "slides", "flip_flops"] },
        { key: "boots", name: "Boots" },
        { key: "slippers", name: "Slippers" },
      ],
    },
    { key: "bags", name: "Bags", aliases: ["handbags"] },
    { key: "accessories", name: "Accessories" },
  ],
};

/** Not released: nodes only, no attributes, roles or rules until their turn (M2 scope "Later"). */
const OTHER_VERTICALS: NodeSpec[] = [
  {
    key: "home",
    name: "Home",
    status: "not_released",
    children: [
      { key: "textile", name: "Home textiles", children: [{ key: "curtains", name: "Curtains" }, { key: "bedsheets", name: "Bedsheets", aliases: ["bed_sheets", "bedding"] }] },
      { key: "fragrance", name: "Home fragrance", children: [{ key: "candles", name: "Candles" }, { key: "diffusers", name: "Diffusers" }] },
    ],
  },
  { key: "toys", name: "Toys", status: "not_released" },
  { key: "beauty", name: "Beauty", status: "not_released" },
  { key: "hardline", name: "Hardline", status: "not_released" },
];

/** Parent first, so every insert finds its parent. The root `unknown` vertical comes from flatten. */
export const SEED_NODES: SeedNode[] = flatten([FASHION, ...OTHER_VERTICALS], "released");

const values = (...pairs: [string, string, string?][]) => pairs.map(([key, label, definition]) => ({ key, label, ...(definition ? { definition } : {}) }));

/** Decision-tier attributes of ProductReading (M2-F1-R11, R7). Listing-tier attributes arrive with M2-F3. */
export const SEED_ATTRIBUTES: AttributeInput[] = [
  {
    id: "audience",
    name: "Audience",
    valueType: "enum",
    allowedValues: values(
      ["women", "Women"],
      ["men", "Men"],
      ["unisex", "Unisex"],
      ["baby", "Baby", "0 to 2 years"],
      ["kids", "Kids", "3 to 8 years"],
      ["teen", "Teen", "9 to 14 years"],
    ),
    nodeIds: ["fashion"],
    tier: "decision",
    sourcePrecedence: ["sheet", "image", "rule"],
  },
  {
    id: "garment_length",
    name: "Garment length",
    valueType: "enum",
    allowedValues: values(["short", "Short", "hem above the knee"], ["knee", "Knee", "hem at the knee"], ["long", "Long", "hem below the knee"]),
    nodeIds: ["fashion.apparel"],
    tier: "decision",
    sourcePrecedence: ["image", "sheet", "rule"],
  },
  {
    id: "pack",
    name: "Pack",
    valueType: "enum",
    allowedValues: values(["single", "Single piece"], ["multipack", "Pack of several pieces"]),
    nodeIds: ["fashion"],
    tier: "decision",
    sourcePrecedence: ["sheet", "image", "rule"],
  },
  {
    id: "primary_colours",
    name: "Primary colours",
    valueType: "colour",
    nodeIds: ["fashion"],
    tier: "decision",
    sourcePrecedence: ["image"],
  },
];

const roles = (nodeId: string, list: [string, string, string][]): ShotRoleInput[] =>
  list.map(([key, name, definition], i) => ({ nodeId, key, name, definition, sortOrder: i }));

/** M2-F1-R3. A photo that fits no role gets `other`, so every set has one. */
export const SEED_SHOT_ROLES: ShotRoleInput[] = [
  ...roles("fashion.apparel", [
    ["FM", "Front to mid-thigh", "Front on the body, framed to mid-thigh (to the knee for long garments)."],
    ["FL", "Front full length", "Front on the body, full length."],
    ["FC", "Fabric close-up", "Close-up of the fabric with no model."],
    ["BH", "Back to the hips", "Back on the body, framed to the hips."],
    ["HS", "Head and shoulders", "Head and shoulders on the body."],
    ["BL", "Back full length", "Back on the body, full length."],
    ["FW", "Front from the waist down", "Front on the body, from the waist down."],
    ["BW", "Back from the waist down", "Back on the body, from the waist down."],
    ["DT", "Detail on the body", "A detail of the garment while worn."],
    ["PK", "All pieces of a pack", "Every piece of a pack together."],
    ["flat", "Front flat", "Front flat lay, packshot or ghost mannequin."],
    ["FB", "Back flat lay", "Back flat lay."],
    ["chart", "Size chart", "A size chart."],
    ["lifestyle", "Lifestyle", "A styled scene, not a product shot."],
    ["other", "Other", "Fits no other role."],
  ]),
  ...roles("fashion.footwear", [
    ["side", "Side", "The shoe from the side."],
    ["pair", "Pair", "Both shoes together."],
    ["top", "Top", "The shoe from above."],
    ["sole", "Sole", "The sole."],
    ["back", "Back", "The shoe from behind."],
    ["detail", "Detail", "A close-up detail."],
    ["on_foot", "On foot", "Worn on a foot."],
    ["lifestyle", "Lifestyle", "A styled scene, not a product shot."],
    ["chart", "Size chart", "A size chart."],
    ["other", "Other", "Fits no other role."],
  ]),
  ...roles("fashion.bags", [
    ["front", "Front", "The bag from the front."],
    ["side", "Side", "The bag from the side."],
    ["back", "Back", "The bag from behind."],
    ["inside", "Inside", "The inside of the bag."],
    ["detail", "Detail", "A close-up detail."],
    ["carried", "Carried", "Carried by a person."],
    ["lifestyle", "Lifestyle", "A styled scene, not a product shot."],
    ["other", "Other", "Fits no other role."],
  ]),
];

export interface SeedTaxonomyResult {
  nodesAdded: number;
  attributesAdded: number;
  shotRolesAdded: number;
}

/** Check then insert: adds only the seed rows that are missing, and logs each added row as a `seed` change. */
export async function seedTaxonomy(db: Db): Promise<SeedTaxonomyResult> {
  return db.transaction(async (tx) => {
    const nodes = await tx.insert(catalogTaxonomyNodes).values(SEED_NODES).onConflictDoNothing().returning();
    for (const row of nodes) await logChange(tx, "node", row.id, row.version, "seed", row, SEED_BY);

    const attributes = await tx.insert(catalogAttributeDefs).values(SEED_ATTRIBUTES.map(normalizeAttribute)).onConflictDoNothing().returning();
    for (const row of attributes) await logChange(tx, "attribute", row.id, row.version, "seed", row, SEED_BY);

    const shotRoles = await tx.insert(catalogShotRoles).values(SEED_SHOT_ROLES).onConflictDoNothing().returning();
    for (const row of shotRoles) await logChange(tx, "shot_role", `${row.nodeId}/${row.key}`, row.version, "seed", row, SEED_BY);

    return { nodesAdded: nodes.length, attributesAdded: attributes.length, shotRolesAdded: shotRoles.length };
  });
}
