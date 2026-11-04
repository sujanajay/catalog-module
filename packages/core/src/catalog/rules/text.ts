// Text measures for rule checks (M5-F4-R7): lengths count Unicode grapheme clusters (what a person sees as one
// character, so an emoji with a skin tone or an Arabic letter with its marks counts once); bytes are UTF-8 bytes and
// are used only where a rule's field says bytes (Amazon backend keywords, 250 bytes, C21). Pure functions, no I/O.

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const encoder = new TextEncoder();

/** The number of user-perceived characters (grapheme clusters). */
export function charCount(text: string): number {
  let n = 0;
  for (const _ of graphemes.segment(text)) n++;
  return n;
}

/** UTF-8 bytes. */
export function byteCount(text: string): number {
  return encoder.encode(text).length;
}

/** Sentences: runs of text ending in ".", "!", "?" or the end, ignoring empty runs. */
export function sentenceCount(text: string): number {
  return text
    .split(/[.!?]+(?:\s+|$)/u)
    .map((s) => s.trim())
    .filter(Boolean).length;
}

/** Keyword terms: split on commas or semicolons when the text has any, else on whitespace. */
export function keywordTerms(text: string): string[] {
  const parts = /[,;]/u.test(text) ? text.split(/[,;]/u) : text.split(/\s+/u);
  return parts.map((p) => p.trim()).filter(Boolean);
}

const LETTER = /\p{L}/u;
const UPPER = /\p{Lu}/u;
const LOWER = /\p{Ll}/u;

/**
 * True when the text has at least four letters that have a case and none of them is lower case ("NEW COTTON TEE").
 * Scripts without case (Arabic) are never all capitals.
 */
export function isAllCaps(text: string): boolean {
  const cased = [...text].filter((c) => UPPER.test(c) || LOWER.test(c));
  return cased.length >= 4 && !cased.some((c) => LOWER.test(c));
}

/** Short words that title case leaves in lower case. */
const SMALL_WORDS = new Set(["a", "an", "and", "as", "at", "by", "for", "in", "of", "on", "or", "the", "to", "with"]);

/**
 * Title case and not all caps: every word that starts with a letter starts with a capital, except the small words
 * after the first word. Letters without case (Arabic) pass.
 */
export function isTitleCase(text: string): boolean {
  if (isAllCaps(text)) return false;
  const words = text.split(/\s+/u).filter(Boolean);
  return words.every((w, i) => {
    const first = [...w][0]!;
    // A word that does not start with a letter ("100%", "(new)") has no case to check.
    if (!LETTER.test(first)) return true;
    if (i > 0 && SMALL_WORDS.has(w.toLowerCase())) return true;
    return UPPER.test(first) || !LOWER.test(first);
  });
}

/**
 * Sentence case and not all caps: the text does not start with a lower case letter. A text that starts with a number
 * ("100% cotton") passes, as title case lets such words pass.
 */
export function isSentenceCase(text: string): boolean {
  if (isAllCaps(text)) return false;
  const first = [...text.trim()][0];
  return !first || !LOWER.test(first);
}

/** Lower case, trimmed, with runs of spaces, underscores and hyphens made one space: for comparing words. */
export function normalizeWord(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/gu, " ");
}
