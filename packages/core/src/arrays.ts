// Array helpers for lists that grow with a batch. Spreading a list into a call (Math.min(...list), out.push(...list))
// passes each entry as an argument, and above about 125k entries Node throws "Maximum call stack size exceeded"
// (M1-S5 review P1). These loop instead, so any size works.

/** The smallest number in the list, or null for an empty list. */
export function minOf(values: Iterable<number>): number | null {
  let min: number | null = null;
  for (const v of values) if (min === null || v < min) min = v;
  return min;
}

/** The largest number in the list, or null for an empty list. */
export function maxOf(values: Iterable<number>): number | null {
  let max: number | null = null;
  for (const v of values) if (max === null || v > max) max = v;
  return max;
}

/** Appends every entry of `items` to `target` (out.push(...items) without the argument limit) and returns `target`. */
export function pushAll<T>(target: T[], items: Iterable<T>): T[] {
  for (const item of items) target.push(item);
  return target;
}
