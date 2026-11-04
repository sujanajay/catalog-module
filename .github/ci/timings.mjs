#!/usr/bin/env node
// M6-F8 (M6-S7a): refresh test-timings.json (seconds per unit test file) from a green CI run's unit test shard logs.
//
//   node .github/ci/timings.mjs <run-id>       needs the gh CLI, logged in; writes .github/ci/test-timings.json
//
// The reporter prints one line per file, "✓ <path> (<n> tests) <ms>ms"; this keeps the seconds of each file. A file
// that ran in a busy shard reads slower than it is, so refresh from a run whose shards were already balanced.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const FILE_LINE = /\s[✓❯×↓]\s+((?:apps|packages)\/\S+\.test\.tsx?)\s+\((\d+) tests?[^)]*\)\s*(?:(\d+)ms)?/;

/** Seconds per file from reporter output (ANSI colours stripped); the larger value wins when a file appears twice. */
export function parseLog(text, into = {}) {
  // eslint-disable-next-line no-control-regex
  const plain = text.replace(/\x1b\[[0-9;]*m/g, "");
  for (const line of plain.split("\n")) {
    const m = FILE_LINE.exec(line);
    if (!m) continue;
    const seconds = Math.round(Number(m[3] || 0) / 100) / 10;
    into[m[1]] = Math.max(into[m[1]] ?? 0, seconds);
  }
  return into;
}

function main(argv) {
  const run = argv[0];
  if (!/^\d+$/.test(run ?? "")) { console.error("usage: timings.mjs <run-id>"); return 2; }
  const jobs = JSON.parse(execFileSync("gh", ["run", "view", run, "--json", "jobs"], { encoding: "utf8" })).jobs
    .filter((j) => j.name.startsWith("unit tests"));
  if (!jobs.length) { console.error(`run ${run} has no unit test jobs`); return 1; }
  const seconds = {};
  for (const j of jobs) parseLog(execFileSync("gh", ["run", "view", run, "--log", "--job", String(j.databaseId)], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }), seconds);
  const sorted = Object.fromEntries(Object.entries(seconds).sort(([a], [b]) => a.localeCompare(b)));
  const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "test-timings.json");
  fs.writeFileSync(out, JSON.stringify({ source: `ci.yml run ${run}`, seconds: sorted }, null, 2) + "\n");
  console.log(`${Object.keys(sorted).length} files from ${jobs.length} shard logs -> ${path.relative(process.cwd(), out)}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
