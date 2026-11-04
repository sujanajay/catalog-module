#!/usr/bin/env node
// M6-F8 T1 (M6-S7a): split the unit test files over the CI shards by how long each file takes, not by a hash of its
// path. vitest's own --shard gives every shard the same number of files, so two heavy files (the image checks, the
// T40 slices) could land together and make one shard the critical path of the whole run (3.9 to 7.5 min on
// 2026-11-03, .runs/2026-11-03-ci-t1-wall-time.md).
//
//   node .github/ci/shards.mjs <index> <count> < files.txt   prints the files of shard <index> (1-based), one per line
//   node .github/ci/shards.mjs --plan <count> < files.txt     prints every shard's files and its expected seconds
//
// files.txt is `vitest list --filesOnly` output (absolute or relative paths, one per line). Every listed file goes to
// exactly one shard, so the shards together always run every file, also a new one. Durations come from
// test-timings.json next to this script (seconds per file, measured on CI); a file it does not know counts as the
// median; a file recorded as 0 s (under 50 ms) counts as 0.05 s. Refresh the timings with `node .github/ci/timings.mjs <run-id>` when the shards drift apart.
import fs from "node:fs";
import path from "node:path";
import console from "node:console";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * Files a shard effectively runs at once: vitest runs 4 (vitest.config.ts maxWorkers) on a 4-vCPU runner, but the heavy
 * files are CPU-bound and slow each other down, so a shard lasted its summed file seconds over 2.4 to 3.0 (CI run
 * 41768179513, 2026-11-04).
 */
export const EFFECTIVE_PARALLEL = 2.5;

/** Repository-relative, forward-slash path of a listed file. */
export function normalise(file, root) {
  const f = file.trim().replace(/\\/g, "/");
  const r = root.replace(/\\/g, "/").replace(/\/$/, "");
  return f.toLowerCase().startsWith(r.toLowerCase() + "/") ? f.slice(r.length + 1) : f.replace(/^\.\//, "");
}

/**
 * Expected seconds of a shard: at least as long as its longest file, and at least its total over EFFECTIVE_PARALLEL.
 */
export const shardCost = (s) => Math.max(s.longest, s.total / EFFECTIVE_PARALLEL);

/**
 * Longest file first, each into the shard where the shard's expected time grows least (ties: the smaller total, then
 * the lower index). Deterministic: the same files and timings always give the same split on every shard.
 */
export function plan(files, timings, count) {
  if (!Number.isInteger(count) || count < 1) throw new Error(`shard count must be a positive integer, got ${count}`);
  const known = Object.values(timings).filter((v) => typeof v === "number" && v > 0).sort((a, b) => a - b);
  const median = known.length ? known[Math.floor(known.length / 2)] : 1;
  const unique = [...new Set(files)].sort();
  const weighted = unique.map((f) => ({ file: f, seconds: typeof timings[f] === "number" ? Math.max(timings[f], 0.05) : median }));
  weighted.sort((a, b) => b.seconds - a.seconds || a.file.localeCompare(b.file));
  const shards = Array.from({ length: count }, () => ({ files: [], total: 0, longest: 0 }));
  for (const w of weighted) {
    let best = 0, bestCost = Infinity;
    shards.forEach((s, i) => {
      const cost = shardCost({ total: s.total + w.seconds, longest: Math.max(s.longest, w.seconds) });
      if (cost < bestCost || (cost === bestCost && s.total < shards[best].total)) { best = i; bestCost = cost; }
    });
    const s = shards[best];
    s.files.push(w.file);
    s.total += w.seconds;
    s.longest = Math.max(s.longest, w.seconds);
  }
  return shards.map((s) => ({ ...s, files: s.files.sort(), seconds: Math.round(shardCost(s)) }));
}

export function readTimings(file = path.join(path.dirname(fileURLToPath(import.meta.url)), "test-timings.json")) {
  const t = JSON.parse(fs.readFileSync(file, "utf8"));
  return t.seconds ?? t;
}

function main(argv) {
  const root = process.cwd();
  const files = fs.readFileSync(0, "utf8").split(/\r?\n/).filter((l) => /\.test\.tsx?$/.test(l.trim())).map((l) => normalise(l, root));
  if (!files.length) { console.error("shards: no test files on stdin (pipe `vitest list --filesOnly` in)"); return 1; }
  const timings = readTimings();
  if (argv[0] === "--plan") {
    const shards = plan(files, timings, Number(argv[1]));
    shards.forEach((s, i) => console.log(`shard ${i + 1}/${shards.length}: ${s.files.length} files, about ${s.seconds} s (longest ${Math.round(s.longest)} s, total ${Math.round(s.total)} s)`));
    return 0;
  }
  const [index, count] = argv.map(Number);
  if (!(index >= 1 && index <= count)) { console.error("usage: shards.mjs <index> <count> < files.txt  |  shards.mjs --plan <count> < files.txt"); return 2; }
  const shard = plan(files, timings, count)[index - 1];
  console.error(`shard ${index}/${count}: ${shard.files.length} files, about ${shard.seconds} s expected`);
  console.log(shard.files.join("\n"));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
