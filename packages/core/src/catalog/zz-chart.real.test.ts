// TEMPORARY harness (not committed): OLD vs NEW detectTextImage over a file list.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { it } from "vitest";
import * as R from "./render";
import * as NEW from "./matte-guard";
import * as OLD from "./zz-guard-orig";
it("charts", async () => {
  const list = readFileSync(process.env.LIST!, "utf8").split(/\r?\n/).filter(Boolean), seen = new Set<string>(), out: string[] = [];
  for (const line of list) {
    const [group, f] = line.split("\t") as [string, string];
    const buf = readFileSync(f), md5 = group + createHash("md5").update(buf).digest("hex"); if (seen.has(md5)) continue; seen.add(md5);
    let p; try { p = await R.prepare(buf, f, async b => b); } catch { out.push(`${group}\t${f}\tERR`); continue; }
    const o = OLD.detectTextImage(p), n = NEW.detectTextImage(p);
    out.push(`${group}\t${f.split("/").pop()}\t${o.text ? "CHART" : "-"}\t${n.text ? "CHART" : "-"}\t${JSON.stringify(o)}\t${JSON.stringify(n)}`);
  }
  writeFileSync(process.env.OUT!, out.join("\n") + "\n");
}, 14_400_000);
