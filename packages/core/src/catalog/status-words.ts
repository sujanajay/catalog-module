// The status vocabulary (UX design system, section 4): one small set of words for a batch's state, the same in the
// UI, emails, sheets and exports. A batch never shows "failed" while it still produced links, and a product never
// shows "error"; it shows the plain reason instead. The web app shows these through StatusWord (components/ui.tsx).

export const STATUS_KEYS = ["receiving", "getting_ready", "working", "links_ready", "improving", "done", "needs_you", "paused"] as const;
export type StatusKey = (typeof STATUS_KEYS)[number];
/** The colour family of a status word: the CSS tokens --ok, --warn, --bad, --run, or plain text (neutral). */
export type StatusTone = "neutral" | "run" | "ok" | "warn" | "bad";
/** The icon beside the word. A progress bar, where section 4 names one, belongs to the progress line, not to the word. */
export type StatusIcon = "progress" | "tick" | "dot" | "alert" | "pause";

export interface StatusWordSpec {
  /** The word shown. */
  word: string;
  /** What it means, in the words of section 4; shown as the word's title. */
  meaning: string;
  tone: StatusTone;
  icon: StatusIcon;
}

export const STATUS_WORDS: Record<StatusKey, StatusWordSpec> = {
  receiving: { word: "Receiving files", meaning: "Files are arriving", tone: "neutral", icon: "progress" },
  getting_ready: { word: "Getting ready", meaning: "Files are read and grouped into products", tone: "run", icon: "progress" },
  working: { word: "Working", meaning: "Images and text are being made", tone: "run", icon: "progress" },
  links_ready: { word: "Links ready", meaning: "Every product has links; some may improve", tone: "ok", icon: "tick" },
  improving: { word: "Improving by itself", meaning: "Better versions are being made for some products; links stay the same", tone: "ok", icon: "dot" },
  done: { word: "Done", meaning: "Nothing left to do", tone: "ok", icon: "tick" },
  needs_you: { word: "Needs you", meaning: "A person has to decide something, or some files could not be read", tone: "warn", icon: "alert" },
  paused: { word: "Paused", meaning: "A person or a rule paused it", tone: "warn", icon: "pause" },
};

/**
 * The colour of a status word. "Needs you" is red only when it blocks; when the system already used a safe default
 * it is amber (section 4). `blocking` changes no other word.
 */
export function statusTone(key: StatusKey, options: { blocking?: boolean } = {}): StatusTone {
  return key === "needs_you" && options.blocking ? "bad" : STATUS_WORDS[key].tone;
}
