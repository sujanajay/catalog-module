import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// UX1 logical CSS pass (UX design system section 11): every layout is right-to-left ready, so the web app's styles use
// logical properties (margin-inline-start, not margin-left) and a dir="rtl" page mirrors by itself. Back arrows are
// mirrored; images, numbers and codes are not. The browser half is catalog-rtl.browser.spec.ts.

const WEB = path.resolve(__dirname, "..");
function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === "node_modules" || name.startsWith(".") ? [] : files(full, ext);
    return ext.test(name) ? [full] : [];
  });
}
const SOURCES = ["app", "components"].flatMap((d) => files(path.join(WEB, d), /\.(css|tsx)$/));

/** Physical left/right in CSS text or in a React style object. */
const PHYSICAL_CSS = /(?:^|[\s;{])(?:(?:margin|padding|border)-(?:left|right)[\w-]*|left|right|float|clear)\s*:|text-align\s*:\s*(?:left|right)\b|(?:float|clear)\s*:\s*(?:left|right)\b/;
const PHYSICAL_STYLE = /\b(?:margin|padding|border)(?:Left|Right)\w*\s*:|[{,]\s*(?:left|right)\s*:|textAlign\s*:\s*["'](?:left|right)["']|float\s*:\s*["'](?:left|right)["']/;

describe("UX1 logical CSS", () => {
  it("finds the style sources", () => {
    expect(SOURCES.some((f) => f.endsWith("globals.css"))).toBe(true);
    expect(SOURCES.some((f) => f.endsWith("pages.css"))).toBe(true);
  });
  for (const file of SOURCES) {
    const rel = path.relative(WEB, file).replaceAll("\\", "/");
    it(`${rel} uses logical properties only`, () => {
      const text = readFileSync(file, "utf8");
      const hits: string[] = [];
      if (file.endsWith(".css")) {
        // One declaration at a time, comments removed (the minified files hold many rules on one line).
        const bare = text.replace(/\/\*[\s\S]*?\*\//g, "");
        for (const decl of bare.split(/[;{}]/)) if (PHYSICAL_CSS.test(` ${decl.trim()}`)) hits.push(decl.trim());
      } else {
        for (const m of text.matchAll(/style=\{\{([^}]*)\}\}/g)) if (PHYSICAL_STYLE.test(`{${m[1]}`)) hits.push(m[0]);
      }
      expect(hits).toEqual([]);
    });
  }
  it("catches the physical forms it is meant to catch", () => {
    for (const decl of ["margin-left: 4px", "padding-right:0", "border-left-color: red", "left: 0", "text-align: left", "float: right"]) expect(PHYSICAL_CSS.test(` ${decl}`), decl).toBe(true);
    for (const decl of ["margin-inline-start: 4px", "inset-inline-end: 0", "text-align: start", "border-bottom: 1px", "safe-area-inset-left"]) expect(PHYSICAL_CSS.test(` ${decl}`), decl).toBe(false);
    expect(PHYSICAL_STYLE.test("{marginLeft: 8")).toBe(true);
    expect(PHYSICAL_STYLE.test("{display:\"flex\",justifyContent:\"space-between\"")).toBe(false);
  });
  it("mirrors back arrows: every arrow in the page copy sits in a mirrored span", () => {
    const tsx = SOURCES.filter((f) => f.endsWith(".tsx"));
    const bare = tsx.flatMap((f) => readFileSync(f, "utf8").split("\n").filter((l) => /[←→]/.test(l) && !/<BackArrow\b|className="mirror"/.test(l)).map((l) => `${path.basename(f)}: ${l.trim().slice(0, 80)}`));
    expect(bare).toEqual([]);
    expect(readFileSync(path.join(WEB, "app/globals.css"), "utf8")).toMatch(/:dir\(rtl\) \.mirror\s*\{[^}]*scaleX\(-1\)/);
  });
});
