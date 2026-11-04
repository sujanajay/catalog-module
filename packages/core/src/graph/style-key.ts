// Style key (docs/program/requirements/M0-catalog-graph.md F1-R8, decision D17): the key that groups the colour siblings
// of one design, the unit M4 randomizes by. Pure functions; the graph sync (key-sync.ts) calls them per option.
//
// Order: the master sheet's style code (`master_sl.description_1`, filled on every option-keyed softline row) is the
// brand style code, confidence 1. Else the name-and-colour rule: the option's text (its warehouse option id, or the
// SKU code for a fallback option) with the trailing colour words and the `OD` marker removed. The rule is sure (0.9)
// only when it removed at least one known colour word; otherwise (0.5) the option is its own cluster. An option under
// the confidence bar (default 0.8, an admin setting once M12 ships) is always its own cluster.
import type { StyleKeySource } from "./types";

export const DEFAULT_STYLE_KEY_MIN_CONFIDENCE = 0.8;
/** Confidence of a name-and-colour match that removed at least one known colour word. */
export const RULE_CONFIDENCE = 0.9;
/** Confidence when the rule found no colour word to remove: too unsure to group. */
export const NO_COLOUR_CONFIDENCE = 0.5;

export type StyleKey = { styleKey: string; source: StyleKeySource; confidence: number };

/** The bar from CATALOG_STYLE_KEY_MIN_CONFIDENCE (0 to 1), else the default. */
export function styleKeyMinConfidence(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.CATALOG_STYLE_KEY_MIN_CONFIDENCE);
  return env.CATALOG_STYLE_KEY_MIN_CONFIDENCE && Number.isFinite(v) && v >= 0 && v <= 1 ? v : DEFAULT_STYLE_KEY_MIN_CONFIDENCE;
}

/** Upper case, runs of spaces and underscores as one space. Hyphens and dots stay: they are part of style codes. */
export function normalizeStyleText(s: string): string {
  return s.toUpperCase().replace(/[\s_]+/g, " ").trim();
}

const PART_SPLIT = /[\s/.,_-]+/;

/** The colour words of a set of colour values ("D.GRY/L.GRY" gives GRY), upper case, two letters or more, not numbers. */
export function colourVocabulary(colours: Iterable<string | null | undefined>): Set<string> {
  const words = new Set<string>();
  for (const c of colours) {
    if (!c) continue;
    for (const part of c.toUpperCase().split(PART_SPLIT)) if (part.length >= 2 && !/^\d+$/.test(part)) words.add(part);
  }
  return words;
}

/** A token is a colour token when every part of it ("BLK/GOLDEN") is a colour word or a single letter. */
function isColourToken(token: string, vocab: Set<string>): boolean {
  const parts = token.split(PART_SPLIT).filter(Boolean);
  return parts.length > 0 && parts.some((p) => vocab.has(p)) && parts.every((p) => p.length === 1 || vocab.has(p));
}

export type StyleKeyInput = {
  brandSlug: string;
  optionKey: string;
  /** master_sl.description_1 of the option's SKUs, when the sheet has one. */
  styleCode?: string | null;
  /** The text the rule strips: the warehouse option id, or the SKU code minus its size for a fallback option. */
  text: string;
};

/** The style key of one option. */
export function styleKeyFor(input: StyleKeyInput, vocab: Set<string>, minConfidence = DEFAULT_STYLE_KEY_MIN_CONFIDENCE): StyleKey {
  const code = input.styleCode ? normalizeStyleText(input.styleCode) : "";
  if (code) return { styleKey: `${input.brandSlug}|${code}`, source: "brand_style_code", confidence: 1 };

  const tokens = normalizeStyleText(input.text).split(" ").filter(Boolean);
  let removedColour = 0;
  while (tokens.length > 1) {
    const last = tokens[tokens.length - 1]!;
    if (last === "OD") tokens.pop();
    else if (isColourToken(last, vocab)) {
      tokens.pop();
      removedColour++;
    } else break;
  }
  const stem = tokens.join(" ");
  const confidence = removedColour > 0 && stem ? RULE_CONFIDENCE : NO_COLOUR_CONFIDENCE;
  if (confidence >= minConfidence) return { styleKey: `${input.brandSlug}|${stem}`, source: "name_colour_rule", confidence };
  return { styleKey: `${input.brandSlug}|own:${input.optionKey}`, source: "own_cluster", confidence };
}
