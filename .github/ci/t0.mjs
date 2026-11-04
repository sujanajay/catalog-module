#!/usr/bin/env node
// M6-F8 T0 (M6-S7a): the check before a commit, on the builder's machine, for the files changed since the base branch
// (committed on this branch, staged, unstaged and new): eslint on them, the typecheck, and the unit tests related to
// them (`vitest related`: the test files that import a changed file, directly or not). Budget: under 3 minutes.
//
//   pnpm t0               against origin/main
//   pnpm t0 <base-ref>    against another base
//
// T1 (CI) still runs everything on the PR; T0 is the fast first answer.
import path from "node:path";
import console from "node:console";
import process from "node:process";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

/** The files a T0 run covers: changed since the merge base with `base`, plus the working tree, existing files only. */
export function changedFiles(base) {
  const files = new Set([
    ...git("diff", "--name-only", "--diff-filter=d", `${base}...HEAD`),
    ...git("diff", "--name-only", "--diff-filter=d", "HEAD"),
    ...git("ls-files", "--others", "--exclude-standard"),
  ]);
  return [...files].sort();
}

/** What each T0 step gets: lintable files for eslint, and source or test files under apps/ and packages/ for vitest. */
export function selectFiles(files) {
  return {
    lint: files.filter((f) => /\.(ts|tsx|mjs|js)$/.test(f)),
    related: files.filter((f) => /^(apps|packages)\/.+\.(ts|tsx)$/.test(f)),
  };
}

function step(name, cmd, args) {
  const started = Date.now();
  console.log(`\n==> ${name}`);
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
  console.log(`<== ${name}: ${r.status === 0 ? "ok" : "FAILED"} in ${Math.round((Date.now() - started) / 1000)} s`);
  return r.status === 0;
}

function main(argv) {
  const base = argv[0] ?? "origin/main";
  const started = Date.now();
  const { lint, related } = selectFiles(changedFiles(base));
  console.log(`T0 against ${base}: ${lint.length} file(s) to lint, ${related.length} for related tests`);
  const results = [
    lint.length ? step("eslint (changed files)", "pnpm", ["exec", "eslint", "--pass-on-unpruned-suppressions", ...lint]) : true,
    step("typecheck", "pnpm", ["typecheck"]),
    related.length ? step("unit tests related to the changed files", "pnpm", ["exec", "vitest", "related", "--run", "--passWithNoTests", ...related]) : true,
  ];
  const seconds = Math.round((Date.now() - started) / 1000);
  const ok = results.every(Boolean);
  console.log(`\nT0 ${ok ? "passed" : "FAILED"} in ${seconds} s (budget 180 s)${seconds > 180 ? ": over budget, say so in the PR" : ""}`);
  return ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
