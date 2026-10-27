// Spec 14b F2: the paste box waiting state and readback (PasteBox, paste-check). The Continue button
// staying enabled while a check runs is covered in the browser by catalog-wizard-ordering.browser.spec.ts.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PasteStatus } from "../components/catalog/PasteBox";
import { createPasteChecker, EMPTY_PASTE_VIEW, pasteEntries, type PasteResult, type PasteView } from "../components/catalog/paste-check";

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
    expect(h.checker.view()).toEqual({ checking: false, error: "", results: [{ kind: "url_list", access: "ok", summary: "readback of https://example.com/test_brand/A_1.jpg", pill: "1 image link" }] });
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
});
