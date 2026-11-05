import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// UX1 (UX design system section 15): the colour tokens of section 8.1 (with --well, --focus and --selected), the
// fonts of decision U1 (IBM Plex Sans with IBM Plex Sans Arabic, Spectral for English headings), lining tabular
// figures, and the contrast bars of section 10 (4.5 for text, 3 for interface parts), in light and dark.

const WEB = path.resolve(__dirname, "..");
const css = readFileSync(path.join(WEB, "app/globals.css"), "utf8");
const fonts = readFileSync(path.join(WEB, "app/fonts.ts"), "utf8");
const pagesCss = readFileSync(path.join(WEB, "components/catalog/pages.css"), "utf8");
const wizardCss = readFileSync(path.join(WEB, "components/catalog/wizard.css"), "utf8");

/** The body of the first rule whose selector is exactly `selector` (searched from `from`). */
function block(source: string, selector: string, from = 0): string {
  const start = source.indexOf(`${selector} {`, from);
  if (start < 0) throw new Error(`no rule ${selector}`);
  const open = source.indexOf("{", start);
  return source.slice(open + 1, source.indexOf("}", open));
}
function tokens(body: string): Record<string, string> {
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim().toLowerCase()]));
}
const light = tokens(block(css, ":root"));
const darkMedia = { ...light, ...tokens(block(css, ':root:not([data-theme="light"])')) };
const darkForced = { ...light, ...tokens(block(css, ':root[data-theme="dark"]')) };
const top = tokens(block(css, ".top"));

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c: number) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** Text or part on a surface, as the pages use them. A value starting with # is a fixed colour, not a token. */
const TEXT: [string, string][] = [
  ...["--bg", "--card", "--soft", "--well", "--selected"].flatMap((s) => [["--fg", s], ["--muted", s]] as [string, string][]),
  ...["--ok", "--warn", "--bad", "--run"].flatMap((s) => [[s, "--bg"], [s, "--card"], [s, "--soft"]] as [string, string][]),
  ["--orange-text", "--bg"], ["--orange-text", "--card"], ["--orange-text", "--soft"],
  // The primary button and the toast button: their label on the orange fill; the green "ok" button's label.
  ["--on-orange", "--orange"], ["--on-orange", "--orange-h"], ["--bg", "--ok"],
  ["--muted", "--yellow"], ["--fg", "--yellow"],
  ["#ffffff", "--navy"],
];
const PARTS: [string, string][] = [
  ["--focus", "--bg"], ["--focus", "--card"], ["--focus", "--soft"],
  ["--grey-l", "--bg"], ["--grey-l", "--card"],
  ["--orange", "--bg"], ["--orange", "--card"],
];

describe("UX1 colour tokens", () => {
  for (const [name, set] of [["light", light], ["dark (system)", darkMedia], ["dark (forced)", darkForced]] as const) {
    it(`defines --well, --focus and --selected in ${name}`, () => {
      for (const t of ["--well", "--focus", "--selected", "--orange-text", "--on-orange"]) expect(set[t], t).toMatch(/^#[0-9a-f]{6}$/);
    });
    const value = (t: string) => (t.startsWith("#") ? t : set[t]!);
    for (const [fg, bg] of TEXT) {
      it(`${name}: ${fg} on ${bg} reaches 4.5 for text`, () => {
        expect(value(fg), fg).toBeDefined();
        expect(value(bg), bg).toBeDefined();
        expect(contrast(value(fg), value(bg))).toBeGreaterThanOrEqual(4.5);
      });
    }
    for (const [fg, bg] of PARTS) {
      it(`${name}: ${fg} on ${bg} reaches 3 for interface parts`, () => {
        expect(contrast(value(fg), value(bg))).toBeGreaterThanOrEqual(3);
      });
    }
  }
  it("matches the section 8.1 values for the new roles", () => {
    expect([light["--well"], light["--focus"], light["--selected"]]).toEqual(["#f2f2f2", "#1d4ed8", "#fff1e8"]);
    expect([darkMedia["--well"], darkMedia["--focus"], darkMedia["--selected"]]).toEqual(["#1e1e20", "#93b4ff", "#2a1c14"]);
    expect(darkForced).toEqual(darkMedia);
  });
  it("gives the parts that sit on the navy top bar a focus ring that shows on navy", () => {
    const onNavy = tokens(block(css, ".top .logo,\n.top .nav a,\n.top .ub"));
    expect(contrast(onNavy["--focus"]!, light["--navy"]!)).toBeGreaterThanOrEqual(3);
  });
  // Review P2-1 (2026-11-05): the user menu opens inside the top bar on a --card surface, so it must keep the page's
  // ring, not the light ring meant for navy (#93b4ff on white is 2.1 to 1).
  for (const [name, set] of [["light", light], ["dark (system)", darkMedia], ["dark (forced)", darkForced]] as const) {
    it(`${name}: the user menu inside the top bar keeps a ring that shows on its card`, () => {
      const menu = { ...top, ...tokens(block(css, ".menu")) };
      const ring = menu["--focus"] ?? set["--focus"]!;
      expect(contrast(ring, set["--card"]!)).toBeGreaterThanOrEqual(3);
    });
  }
  it("draws every focus ring 2 px in --focus", () => {
    const outlines = [...`${css}\n${pagesCss}\n${wizardCss}`.matchAll(/outline:\s*([^;}]+)/g)].map((m) => m[1]!.trim());
    for (const o of outlines.filter((o) => o !== "none")) expect(o).toBe("2px solid var(--focus)");
    expect(css).toMatch(/:focus-visible\s*\{\s*outline:\s*2px solid var\(--focus\)/);
  });
  it("puts product images on --well, never a fixed grey", () => {
    expect(`${css}${pagesCss}${wizardCss}`).not.toMatch(/#e0e0e0/i);
    expect(pagesCss).toMatch(/\.product-images img\{[^}]*background:var\(--well\)/);
  });
  it("uses links and labels that pass: no white text on the orange fill, orange text through --orange-text", () => {
    for (const source of [css, pagesCss, wizardCss]) {
      expect(source).not.toMatch(/background:\s*var\(--orange(-h)?\);[^}]*color:\s*#fff/);
      expect(source).not.toMatch(/(^|[;{\s])color:\s*var\(--orange\)/);
    }
  });
});

describe("UX1 type", () => {
  it("loads IBM Plex Sans and IBM Plex Sans Arabic, keeps Spectral for headings, drops Raleway", () => {
    expect(fonts).toMatch(/IBM_Plex_Sans\b/);
    expect(fonts).toMatch(/IBM_Plex_Sans_Arabic\b/);
    expect(fonts).toMatch(/subsets:\s*\["arabic"\]/);
    expect(fonts).toMatch(/Spectral/);
    expect(fonts).not.toMatch(/Raleway/);
    expect(css).not.toMatch(/raleway/i);
    expect(light["--font-b"]).toMatch(/var\(--font-plex-sans\b.*var\(--font-plex-arabic\b/);
  });
  it("shows lining, tabular figures for every number", () => {
    expect(block(css, "body")).toMatch(/font-variant-numeric:\s*lining-nums tabular-nums/);
  });
  it("keeps times, codes and links in their own order inside a right-to-left page", () => {
    expect(block(css, "time,\ncode")).toMatch(/unicode-bidi:\s*plaintext/);
    expect(block(css, ":dir(rtl) .mono")).toMatch(/direction:\s*ltr;\s*text-align:\s*end/);
  });
  it("sets Arabic in its own font with a taller line, no letter spacing and no italics", () => {
    const ar = block(css, ':lang(ar)');
    expect(ar).toMatch(/line-height:\s*1\.7/);
    expect(ar).toMatch(/letter-spacing:\s*0/);
    expect(ar).toMatch(/font-style:\s*normal/);
    expect(block(css, ":lang(ar) h1,\n:lang(ar) h2,\n:lang(ar) h3")).toMatch(/font-family:\s*var\(--font-ar\)/);
  });
});
