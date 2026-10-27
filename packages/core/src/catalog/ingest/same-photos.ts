// The step 4 same-photos sentences (spec 14d F10). Kept apart from group.ts, which re-exports them, so
// the wizard's client bundle can import them without the image libraries group.ts needs.
import type { OverwritePreview } from "./types";

const fmt = (n: number) => n.toLocaleString("en-US");

/**
 * The step 4 pair for another unfinished batch holding the same photos. The headline is
 * `before + name + after`, so the page can make the batch name a link to that batch; `age` is its
 * ageText ("2 days ago"). Copy as in 14d section 3.3 (where the parent register differs, 14d wins).
 */
export function samePhotosPair(other: OverwritePreview["sameBatches"][number], photos: number, age: string): { before: string; name: string; after: string; detail: string } {
  const state = other.state ? `${other.state.charAt(0).toLowerCase()}${other.state.slice(1)}, ` : "";
  const spellings = other.example ? `, under different identifiers (${other.example.there} there, ${other.example.here} here)` : "";
  return {
    before: "These photos are already in ",
    name: other.name,
    after: ` (${state}created ${age}).`,
    detail: `${fmt(other.sharedPhotos)} of ${fmt(photos)} photos are the same${spellings}. Continue that batch or cancel it before starting this one, so the same product is not made twice.`,
  };
}

/** The step 4 pair for photos under two products of this batch, or null when there are none. */
export function duplicatePhotosPair(list: OverwritePreview["duplicatePhotos"]): { headline: string; detail: string } | null {
  const first = list[0];
  if (!first) return null;
  const more = list.length > 1 ? `; ${fmt(list.length - 1)} more` : "";
  return {
    headline: `${fmt(list.length)} ${list.length === 1 ? "photo appears" : "photos appear"} under two products.`,
    detail: `${first.name} is in ${first.identifiers[0]} and ${first.identifiers[1]}${more}. Check the sheet before starting.`,
  };
}
