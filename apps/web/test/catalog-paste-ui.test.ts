// Spec 14b F2: the paste box waiting state and readback (PasteBox, paste-check). The Continue button
// staying enabled while a check runs is covered in the browser by catalog-wizard-ordering.browser.spec.ts.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PasteStatus } from "../components/catalog/PasteBox";
import { createPasteChecker, EMPTY_PASTE_VIEW, pasteEntries, readFoldersToEnd, type PasteResult, type PasteView } from "../components/catalog/paste-check";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function harness() {
  const sent: string[] = [];
  const answers = new Map<string, ReturnType<typeof deferred<PasteResult[]>>>();
  const views: PasteView[] = [];
  const busy: boolean[] = [];
  let saved = 0;
  const checker = createPasteChecker({
    save(value) {
      sent.push(value);
      const d = deferred<PasteResult[]>();
      answers.set(value, d);
      return d.promise;
    },
    onView: (v) => views.push(v),
    onBusy: (b) => busy.push(b),
    onSaved: () => { saved++; },
  });
  const answer = (value: string) => answers.get(value)!.resolve([{ kind: "url_list", access: "ok", summary: `readback of ${value}`, pill: "1 image link" }]);
  const tick = () => new Promise((done) => setTimeout(done, 0));
  return { checker, sent, views, busy, answer, tick, saved: () => saved };
}

const markup = (view: PasteView) => renderToStaticMarkup(createElement(PasteStatus, { view }));

describe("paste box waiting state (spec 14b F2)", () => {
  it("shows the waiting pill until the readback resolves", async () => {
    const h = harness();
    h.checker.check("https://example.com/test_brand/A_1.jpg");
    expect(h.checker.view().checking).toBe(true);
    expect(markup(h.checker.view())).toContain("Checking your links...");
    await h.tick();
    h.answer("https://example.com/test_brand/A_1.jpg");
    await h.checker.settled();
    expect(h.checker.view()).toEqual({ checking: false, error: "", progress: [], results: [{ kind: "url_list", access: "ok", summary: "readback of https://example.com/test_brand/A_1.jpg", pill: "1 image link" }] });
    expect(markup(h.checker.view())).not.toContain("Checking your links...");
    expect(markup(h.checker.view())).toContain("1 image link");
    expect(h.busy).toEqual([true, false]);
  });

  it("an edit during the check shows only the second answer, and writes stay in order", async () => {
    const h = harness();
    h.checker.check("first");
    await h.tick();
    h.checker.check("second");
    await h.tick();
    expect(h.sent).toEqual(["first"]); // the second waits for the first write, so it lands last
    h.answer("first");
    await h.tick();
    expect(h.checker.view().checking).toBe(true); // the first answer is never shown
    expect(h.sent).toEqual(["first", "second"]);
    h.answer("second");
    await h.checker.settled();
    expect(h.views.flatMap((v) => v.results.map((r) => r.summary))).not.toContain("readback of first");
    expect(h.checker.view().results.map((r) => r.summary)).toEqual(["readback of second"]);
    expect(h.busy).toEqual([true, true, false]);
  });

  it("does not send a text that a later edit replaced before its turn", async () => {
    const h = harness();
    h.checker.check("first");
    await h.tick();
    h.checker.check("second");
    h.checker.check("third");
    h.checker.check("third"); // the same text again (paste then blur) is not checked twice
    h.answer("first");
    await h.tick();
    await h.tick();
    h.answer("third");
    await h.checker.settled();
    expect(h.sent).toEqual(["first", "third"]);
    expect(h.checker.view().results.map((r) => r.summary)).toEqual(["readback of third"]);
  });

  it("renders the readback pill, line and notes, and keeps today's pills for Google links", () => {
    const html = markup({ ...EMPTY_PASTE_VIEW, results: [
      { kind: "url_list", access: "ok", summary: "1 to 2 links per row.", count: 12, pill: "7 rows, 12 links", notes: ["Rows 6 and 7 would get the same name, TB-F. Check those rows before you continue."] },
      { kind: "google_sheet", access: "no_access", summary: "Share the sheet with the address above, then paste again." },
    ] });
    expect(html).toContain("7 rows, 12 links");
    expect(html).toContain("1 to 2 links per row.");
    expect(html).toContain("Rows 6 and 7 would get the same name, TB-F.");
    expect(html).toContain("No access yet");
    expect(html).not.toContain("image links");
  });
});

describe("a large Supabase folder read over several requests (R1 exit finding 1)", () => {
  const FOLDER = "https://projref.supabase.co/storage/v1/object/public/softlines/vero-moda";
  const reading = (n: number): PasteResult => ({ kind: "supabase_folder", access: "reading", summary: `Reading Supabase folder softlines/vero-moda: ${n} photos in ${n / 2} folders so far.`, count: n, pill: "Reading folder", folder: FOLDER });

  it("sends a reading folder again until it is read, showing the answers so far, and keeps the answers beside it", async () => {
    const sent: string[] = [];
    const replies = [reading(1600), { kind: "supabase_folder", access: "ok", summary: "Supabase folder softlines/vero-moda: 2,039 photos in 477 folders, grouped by folder name.", pill: "2,039 photos" }];
    const progress: PasteResult[][] = [];
    const sheet: PasteResult = { kind: "google_sheet", access: "ok", summary: "Sheet" };
    const answers = await readFoldersToEnd({ ...reading(800), others: [sheet] }, async (text) => { sent.push(text); return replies.shift()!; }, (a) => progress.push(a));
    expect(sent).toEqual([FOLDER, FOLDER]);
    expect(progress.map((a) => a.map((r) => r.count ?? r.summary))).toEqual([[800, "Sheet"], [1600, "Sheet"]]);
    expect(answers.map((a) => [a.kind, a.access, a.pill])).toEqual([["supabase_folder", "ok", "2,039 photos"], ["google_sheet", "ok", undefined]]);
  });

  it("review P1-1: once the paste is removed (forget) the long read stops sending", async () => {
    const sent: string[] = [];
    let release!: () => void;
    const checker = createPasteChecker({
      async save(_value, progress, cancelled) {
        // The first answer of a long read; the paste box keeps sending while not cancelled.
        return readFoldersToEnd(reading(400), async (folder) => {
          sent.push(folder);
          if (sent.length === 1) await new Promise<void>((resolve) => { release = resolve; });
          return reading(800);
        }, progress, cancelled);
      },
      onView: () => undefined, onBusy: () => undefined, onSaved: () => undefined,
    });
    checker.check(FOLDER);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toEqual([FOLDER]);
    checker.forget(); // Remove in the input list
    release();
    await checker.settled();
    expect(sent).toEqual([FOLDER]); // nothing sent after Remove
    expect(checker.view()).toMatchObject({ checking: false, results: [] });
  });

  it("review 2 P2-1: after a pause, pasting the same link again sends it again (no reload needed), with a Paused pill", async () => {
    const sent: string[] = [];
    const paused: PasteResult = { kind: "supabase_folder", access: "paused", summary: "Supabase stopped answering while this folder was being read.", pill: "Paused", folder: FOLDER };
    const checker = createPasteChecker({
      async save(value) { sent.push(value); return [sent.length === 1 ? paused : { kind: "supabase_folder", access: "ok", summary: "done", pill: "2,039 photos" }]; },
      onView: () => undefined, onBusy: () => undefined, onSaved: () => undefined,
    });
    checker.check(FOLDER);
    await checker.settled();
    expect(markup(checker.view())).toContain(">Paused</span>");
    expect(markup(checker.view())).not.toContain("No access yet");
    checker.check(FOLDER);
    await checker.settled();
    expect(sent).toEqual([FOLDER, FOLDER]);
    expect(checker.view().results[0]).toMatchObject({ access: "ok" });
    // A text whose answers are fine is still not sent twice.
    checker.check(FOLDER);
    await checker.settled();
    expect(sent).toHaveLength(2);
  });

  it("a removed folder answers a Removed pill", () => {
    expect(markup({ ...EMPTY_PASTE_VIEW, results: [{ kind: "supabase_folder", access: "removed", summary: "This folder was removed from the batch." }] })).toContain(">Removed</span>");
  });

  it("an answer that is not reading, or reading without a link, is not sent again", async () => {
    const send = async () => { throw new Error("not sent"); };
    expect(await readFoldersToEnd({ kind: "url_list", access: "ok", summary: "x" }, send, () => undefined)).toHaveLength(1);
    expect(await readFoldersToEnd({ ...reading(2), folder: undefined }, send, () => undefined)).toHaveLength(1);
  });

  it("while reading, the paste box shows the waiting pill and the reading line; the checker passes the progress through", async () => {
    const html = markup({ ...EMPTY_PASTE_VIEW, checking: true, progress: [reading(1600)] });
    expect(html).toContain("Checking your links...");
    expect(html).toContain("Reading folder");
    expect(html).toContain("1600 photos in 800 folders so far.");
    expect(html).not.toContain("No access yet");
    const views: PasteView[] = [];
    const checker = createPasteChecker({
      async save(_value, progress) { progress([reading(400)]); return [{ kind: "supabase_folder", access: "ok", summary: "done", pill: "800 photos" }]; },
      onView: (v) => views.push(v), onBusy: () => undefined, onSaved: () => undefined,
    });
    checker.check(FOLDER);
    await checker.settled();
    expect(views.some((v) => v.checking && v.progress?.[0]?.access === "reading")).toBe(true);
    expect(checker.view()).toMatchObject({ checking: false, progress: [], results: [{ pill: "800 photos" }] });
  });
});

describe("paste removed from the input list (spec 14b F3)", () => {
  it("Remove followed by the same paste sends it again; without Remove the same text is not sent twice", async () => {
    const h = harness();
    const text = "https://example.com/test_brand/A_1.jpg";
    h.checker.check(text);
    await h.tick(); h.answer(text); await h.checker.settled();
    h.checker.check(text);
    expect(h.sent).toEqual([text]);
    h.checker.forget();
    expect(h.checker.view()).toEqual(EMPTY_PASTE_VIEW);
    h.checker.check(text);
    await h.tick(); h.answer(text); await h.checker.settled();
    expect(h.sent).toEqual([text, text]);
    expect(h.checker.view().results).toHaveLength(1);
  });

  it("a check already sent when the paste is removed does not count as saved and its answer is not shown", async () => {
    const h = harness();
    const text = "https://example.com/test_brand/B_1.jpg";
    h.checker.check(text);
    await h.tick();
    h.checker.forget();
    h.answer(text); await h.checker.settled();
    expect(h.checker.view()).toEqual(EMPTY_PASTE_VIEW);
    h.checker.check(text);
    await h.tick();
    expect(h.sent).toEqual([text, text]);
  });
});

describe("pasteEntries", () => {
  it("sends each Google link alone and the image links as pasted, keeping rows and empty cells", () => {
    const sheet = "https://docs.google.com/spreadsheets/d/abc/edit";
    expect(pasteEntries(`https://example.com/a_1.jpg\t\thttps://example.com/a_2.jpg\n${sheet}\nhttps://example.com/b_1.jpg`)).toEqual([
      sheet, "https://example.com/a_1.jpg\t\thttps://example.com/a_2.jpg\n\nhttps://example.com/b_1.jpg",
    ]);
    expect(pasteEntries(sheet)).toEqual([sheet]);
  });
  it("with Supabase folder pastes off, a Supabase folder link stays in the image links, as before (review #1)", () => {
    const folder = "https://ref.supabase.co/storage/v1/object/public/softlines/anta";
    expect(pasteEntries(`${folder}
https://example.com/a_1.jpg`)).toEqual([`${folder}
https://example.com/a_1.jpg`]);
  });
  it("sends a Supabase folder link alone (M1-F1-R4); a Supabase photo link stays an image link", () => {
    const folder = "https://ref.supabase.co/storage/v1/object/public/softlines/anta";
    const signed = "https://ref.supabase.co/storage/v1/object/sign/softlines/anta?token=abc";
    const photo = "https://ref.supabase.co/storage/v1/object/public/softlines/anta/A_1.jpg";
    expect(pasteEntries(`${folder}
${photo}
${signed}`, true)).toEqual([folder, signed, `
${photo}
`]);
  });
});
