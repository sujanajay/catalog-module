// The paste box's check queue (spec 14b F2, waiting state), kept free of React so it can be tested.
// From paste or blur until the readback returns, the view is "checking". A later edit replaces the
// pending check: its answer is never shown, and a text that is still waiting its turn is not sent at
// all. Writes stay one at a time, in order, so an older paste can never land after a newer one on
// the server (the browser cannot stop a request the server is already handling).

/** One answer of `POST /links` (apps/web/lib/catalog/links.ts addLinks). */
export interface PasteResult {
  kind: string; access: string; summary: string; count?: number;
  /** The readback pill and the notes under it, for a list of image links. */
  pill?: string; notes?: string[];
}

export interface PasteView { checking: boolean; results: PasteResult[]; error: string }

export const EMPTY_PASTE_VIEW: PasteView = { checking: false, results: [], error: "" };

export interface PasteCheckerOptions {
  /** Sends one text to the server and returns its answers. */
  save(value: string): Promise<PasteResult[]>;
  onView(view: PasteView): void;
  /** True while any write is outstanding (the wizard waits for it before Continue goes ahead). */
  onBusy(busy: boolean): void;
  /** A text was saved. */
  onSaved(): void;
}

export function createPasteChecker(opts: PasteCheckerOptions) {
  let latest = 0;
  let pending = 0;
  let savedText = "";
  let queuedText = "";
  let chain: Promise<void> = Promise.resolve();
  let view = EMPTY_PASTE_VIEW;
  const show = (patch: Partial<PasteView>) => {
    view = { ...view, ...patch };
    opts.onView(view);
  };

  function check(value: string): void {
    if (!value.trim() || value === (pending ? queuedText : savedText)) return;
    const turn = ++latest;
    queuedText = value;
    pending++;
    opts.onBusy(true);
    show({ checking: true, error: "" });
    chain = chain.then(async () => {
      try {
        if (turn !== latest) return; // replaced by a later edit before it was sent
        const results = await opts.save(value);
        // A later edit or a forget() decides what counts as saved; an answer it replaced does not.
        if (turn === latest) savedText = value;
        opts.onSaved();
        if (turn === latest) show({ checking: false, results });
      } catch (err) {
        if (turn === latest) show({ checking: false, error: err instanceof Error ? err.message : "Paste the link again." });
      } finally {
        if (--pending === 0) opts.onBusy(false);
      }
    });
  }

  /**
   * The paste was removed from the batch (the input list's Remove): nothing counts as saved any more,
   * so the same text pasted again is sent again, and the old readback is cleared. A check still
   * waiting its turn is dropped; one already sent finishes but its answer is not shown.
   */
  function forget(): void {
    latest++;
    savedText = "";
    queuedText = "";
    show({ checking: false, results: [], error: "" });
  }

  return { check, forget, settled: () => chain, view: () => view };
}

const GOOGLE = /https?:\/\/(docs\.google\.com\/spreadsheets|drive\.google\.com\/.*folders)/i;

/**
 * The texts one paste sends: each Google link on its own, and the image links as one text. The
 * image text keeps its lines and cells as pasted (a Google line becomes an empty line), so row
 * numbers and empty cells in the readback match what the operator pasted.
 */
export function pasteEntries(value: string): string[] {
  const lines = value.split(/\r?\n/);
  const google = lines.map((s) => s.trim()).filter((s) => GOOGLE.test(s));
  const images = lines.map((s) => (GOOGLE.test(s.trim()) ? "" : s)).join("\n");
  return [...google, ...(images.trim() ? [images] : [])];
}
