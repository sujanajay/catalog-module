import { describe, expect, it } from "vitest";
import { buildCsv, csvField, csvLine, parseCsv } from "./csv";

describe("csv", () => {
  it("quotes only when needed and doubles inner quotes", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("two\nlines")).toBe('"two\nlines"');
    expect(csvField(" padded")).toBe('" padded"');
    expect(csvField(null)).toBe("");
    expect(csvField(undefined)).toBe("");
    expect(csvField(8905701361431)).toBe("8905701361431");
    expect(csvField(new Date("2026-10-17T10:00:00Z"))).toBe("2026-10-17T10:00:00.000Z");
    expect(csvLine(["a", 1, null, "b,c"])).toBe('a,1,,"b,c"');
  });

  it("writes a BOM and CRLF line ends", () => {
    const csv = buildCsv(["h1", "h2"], [["a", "b"]]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toBe("﻿h1,h2\r\na,b\r\n");
  });

  it("round-trips through parseCsv", () => {
    const header = ["identifier", "Noon Image 1", "notes"];
    const rows = [
      ["8905701361431", "https://storage.googleapis.com/b/catalog/x/noon/x_1.jpg", 'He said "ok", then left'],
      ["ABC 123", "", "line one\r\nline two"],
      ["", "", ""],
    ];
    expect(parseCsv(buildCsv(header, rows))).toEqual([header, ...rows]);
  });

  it("parses LF, CRLF, quoted fields and a missing final newline", () => {
    expect(parseCsv("a,b\nc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(parseCsv('"x,1","y""z"\r\n')).toEqual([["x,1", 'y"z']]);
    expect(parseCsv("a,\n")).toEqual([["a", ""]]);
    expect(parseCsv("")).toEqual([]);
  });
});
