#!/usr/bin/env node
// M6-F8 (M6-S7a): which test tiers a change needs, from docs/specs/test-tiers.json.
//
//   node .github/ci/tiers.mjs <base-ref>     the files changed since <base-ref> (git diff <base-ref>...HEAD)
//   node .github/ci/tiers.mjs - < files.txt  the files listed on stdin
//
// Prints a Markdown summary (CI appends it to the run summary). T1 is always needed; T2 and T3 when a changed file
// starts with one of their paths. A tier that is not built yet is listed as needed, with the reason, never skipped.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function readTiers(file = path.join(root, "docs/specs/test-tiers.json")) {
  return JSON.parse(fs.readFileSync(file, "utf8")).tiers;
}

/** The tiers a change to `files` needs, each with the changed files that call for it (none for T1). */
export function neededTiers(files, tiers) {
  const out = [{ tier: "T1", because: [] }];
  for (const [tier, t] of Object.entries(tiers)) {
    if (!Array.isArray(t.paths)) continue;
    const because = files.filter((f) => t.paths.some((p) => f === p || f.startsWith(p)));
    if (because.length) out.push({ tier, because });
  }
  return out;
}

export function summary(files, tiers) {
  const lines = ["### Test tiers (M6-F8)", "", `${files.length} changed file(s).`, ""];
  for (const { tier, because } of neededTiers(files, tiers)) {
    const t = tiers[tier];
    const state = t.built === false ? `needed, not built yet: ${t.notBuiltBecause}` : `needed (budget ${t.budgetMinutes} min)`;
    const why = because.length ? ` Changed: ${because.slice(0, 5).map((f) => `\`${f}\``).join(", ")}${because.length > 5 ? ` and ${because.length - 5} more` : ""}.` : "";
    lines.push(`- **${tier}** ${t.what}: ${state}.${why}`);
  }
  return lines.join("\n") + "\n";
}

function main(argv) {
  const base = argv[0];
  if (!base) { console.error("usage: tiers.mjs <base-ref>  |  tiers.mjs - < files.txt"); return 2; }
  const text = base === "-" ? fs.readFileSync(0, "utf8") : execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], { cwd: root, encoding: "utf8" });
  const files = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  process.stdout.write(summary(files, readTiers()));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
