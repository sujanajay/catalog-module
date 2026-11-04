// M10 value lists shared by the schema (CHECK constraints) and the change-type library. No imports, so db/schema.ts
// can use them without a cycle.

/** What a change does to its slot (M10 3 Writes `change_type.action`). */
export const CHANGE_ACTIONS = ["add", "replace", "reorder", "remove"] as const;
export type ChangeAction = (typeof CHANGE_ACTIONS)[number];

/**
 * What applying the change costs, by what pays for it (integration decision D7). M6 attaches prices per class; the
 * names carry no amounts. `negligible`: no paid call (our own render of photos we already have, a re-order, data we
 * already hold). `compute`: our own GPU or CPU time. `model_call`: a paid text or vision model call. `generation`: a
 * paid image generation.
 */
export const COST_CLASSES = ["negligible", "compute", "model_call", "generation"] as const;
export type CostClass = (typeof COST_CLASSES)[number];

export const CHANGE_TYPE_STATUSES = ["active", "retired"] as const;
export type ChangeTypeStatus = (typeof CHANGE_TYPE_STATUSES)[number];
