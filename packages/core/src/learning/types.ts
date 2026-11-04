// M10 value lists shared by the schema (CHECK constraints) and the change-type library. No imports, so db/schema.ts
// can use them without a cycle.

/** What a change does to its slot (M10 3 Writes `change_type.action`). */
export const CHANGE_ACTIONS = ["add", "replace", "reorder", "remove"] as const;
export type ChangeAction = (typeof CHANGE_ACTIONS)[number];

/**
 * The paid resource that applying the change mainly uses (integration decision D7). Resource use only: M6 prices the
 * classes, and what a class permits by default is an owner decision (M10-S2). `negligible`: no paid resource (a
 * re-order of images already made, a chart from data we hold). `compute`: our own GPU or CPU time to make a new
 * image (cut-out, render, upscale); every new image also passes the paid quality check. `model_call`: a paid text
 * or vision model call. `generation`: a paid image generation.
 */
export const COST_CLASSES = ["negligible", "compute", "model_call", "generation"] as const;
export type CostClass = (typeof COST_CLASSES)[number];

export const CHANGE_TYPE_STATUSES = ["active", "retired"] as const;
export type ChangeTypeStatus = (typeof CHANGE_TYPE_STATUSES)[number];
