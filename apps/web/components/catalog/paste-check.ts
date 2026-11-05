// The paste box's check queue (spec 14b F2, waiting state), kept free of React so it can be tested.
// From paste or blur until the readback returns, the view is "checking". A later edit replaces the
// pending check: its answer is never shown, and a text that is still waiting its turn is not sent at
// all. Writes stay one at a time, in order, so an older paste can never land after a newer one on
// the server (the browser cannot stop a request the server is already handling).
import { isSupabaseFolderCell } from "@catalog/core/catalog/ingest/supabase-link";

/** One answer of `POST /links` (apps/web/lib/catalog/links.ts addLinks). */
export interface PasteResult {
  kind: string; access: string; summary: string; count?: number;
  /** The readback pill and the notes under it, for a list of image links. */
  pill?: string; notes?: string[];
  /** The other inputs one text added (several Supabase folder links, then the image links beside them). */
  others?: PasteResult[];
  /** A Supabase folder still being read (`access: "reading"`): its link, sent again to carry on. */
  folder?: string;
}

/** `progress` holds the answers so far while a large Supabase folder is still being read. */
export interface PasteView { checking: boolean; results: PasteResult[]; error: string; progress?: PasteResult[] }

export const EMPTY_PASTE_VIEW: PasteView = { checking: false, results: [], error: "", progress: [] };

export interface PasteCheckerOptions {
  /**
   * Sends one text to the server and returns its answers; `progress` shows the answers so far of a long read, and
   * `cancelled` turns true once a later edit or a Remove replaced this text (a long read then stops sending).
   */
  save(value: string, progress: (answers: PasteResult[]) => void, cancelled: () => boolean): Promise<PasteResult[]>;
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
    show({ checking: true, error: "", progress: [] });
    chain = chain.then(async () => {
      try {
        if (turn !== latest) return; // replaced by a later edit before it was sent
        const results = await opts.save(value, (progress) => { if (turn === latest) show({ progress }); }, () => turn !== latest);
        // A later edit or a forget() decides what counts as saved; an answer it replaced does not.
        if (turn === latest) savedText = value;
        opts.onSaved();
        if (turn === latest) show({ checking: false, results, progress: [] });
      } catch (err) {
        if (turn === latest) show({ checking: false, error: err instanceof Error ? err.message : "Paste the link again.", progress: [] });
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
    show({ checking: false, results: [], error: "", progress: [] });
  }

  return { check, forget, settled: () => chain, view: () => view };
}

/**
 * The answers of one pasted text (the first answer and its `others`), with every Supabase folder that is still
 * being read (`access: "reading"`) sent again by its link until it is read, failed or answered without a link.
 * The server lists a large folder a slice per request and carries on where the last one stopped, so the
 * folder is read over several short requests. `progress` gets the answers so far before each request. `resend`
 * asks the server to carry on (it never brings back a folder removed meanwhile). Once `cancelled` is true (the
 * paste was removed or replaced) nothing more is sent.
 */
export async function readFoldersToEnd(first: PasteResult, resend: (folder: string) => Promise<PasteResult>, progress: (answers: PasteResult[]) => void, cancelled: () => boolean = () => false): Promise<PasteResult[]> {
  const answers = [first, ...(first.others ?? [])];
  for (let i = 0; i < answers.length; i++) {
    while (answers[i]!.access === "reading" && answers[i]!.folder && !cancelled()) {
      progress([...answers]);
      answers[i] = await resend(answers[i]!.folder!);
    }
  }
  return answers;
}

const GOOGLE = /https?:\/\/(docs\.google\.com\/spreadsheets|drive\.google\.com\/.*folders)/i;
/**
 * The texts one paste sends: each Google link (and, while Supabase folder pastes are on, each line that
 * is a whole Supabase folder link) on its own, and the image links as one text. The image text keeps
 * its lines and cells as pasted (a Google line becomes an empty line), so row numbers and empty cells
 * in the readback match what the operator pasted.
 */
export function pasteEntries(value: string, supabaseFolders = false): string[] {
  const alone = (line: string) => GOOGLE.test(line) || (supabaseFolders && isSupabaseFolderCell(line));
  const lines = value.split(/\r?\n/);
  const google = lines.map((s) => s.trim()).filter(alone);
  const images = lines.map((s) => (alone(s.trim()) ? "" : s)).join("\n");
  return [...google, ...(images.trim() ? [images] : [])];
}
