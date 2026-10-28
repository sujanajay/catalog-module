import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, test } from "vitest";
import { gitBashPath } from "@catalog/core/git-bash";
import { parseArgs } from "./catalog-output-evals-args";

// infra/catalog-output-evals.sh run against a fake gcloud: no GCP call is made.
const execute = promisify(execFile);
const bash = gitBashPath();
const shellPath = (file: string) => process.platform === "win32" ? file.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_all, drive: string) => `/${drive.toLowerCase()}`) : file;

let dir: string, capture: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "catalog-output-evals-args-"));
  capture = path.join(dir, "args.txt");
  const fake = path.join(dir, "gcloud");
  await writeFile(fake, '#!/usr/bin/env bash\ncase "$1 $2 $3" in\n  "run jobs list") echo catalog-output-evals ;;\n  "run jobs execute") printf "%s\\n" "$@" > "$CAPTURE_ARGS" ;;\n  *) echo "unexpected gcloud $*" >&2; exit 9 ;;\nesac\n');
  await chmod(fake, 0o755);
});
afterEach(async () => {
  expect(path.dirname(path.resolve(dir))).toBe(path.resolve(os.tmpdir()));
  await rm(dir, { recursive: true, force: true });
});

const run = (cliArgs: string[]) =>
  execute(bash, ["-c", 'export PATH="$1:$PATH"; shift; exec bash "$@"', "output-evals-args", shellPath(dir), shellPath(path.resolve("infra/catalog-output-evals.sh")), "run", ...cliArgs], { env: { ...process.env, CAPTURE_ARGS: shellPath(capture) } });

/** The --args value split the way gcloud splits it ("^|^" = "|" separator). */
async function passedArgs(): Promise<{ lines: string[]; tokens: string[] }> {
  const lines = (await readFile(capture, "utf8")).trim().split("\n");
  const value = lines.find(l => l.startsWith("--args="))!.slice("--args=".length);
  expect(value.startsWith("^|^")).toBe(true);
  return { lines, tokens: value.slice(3).split("|") };
}

test("repeated values (--limit 3 --bakeoff-sample 3) reach the CLI as unique tokens", async () => {
  await run(["--limit", "3", "--bakeoff-sample", "3", "--brand", "anta", "--sets", "anta.footwear,anta.apparel_flat", "--skip-overwrite"]);
  const { lines, tokens } = await passedArgs();
  expect(lines.slice(0, 4)).toEqual(["run", "jobs", "execute", "catalog-output-evals"]);
  expect(tokens).toEqual(["run", "--limit=3", "--bakeoff-sample=3", "--brand=anta", "--sets=anta.footwear,anta.apparel_flat", "--skip-overwrite"]);
  // gcloud refuses a value that appears twice inside --args; every token is unique.
  expect(new Set(tokens).size).toBe(tokens.length);
  expect(parseArgs(tokens)).toEqual({ words: ["run"], flags: { limit: "3", "bakeoff-sample": "3", brand: "anta", sets: "anta.footwear,anta.apparel_flat", "skip-overwrite": true } });
}, 60_000);

test("--live sets LIVE_SMOKE for the execution only and is not passed to the CLI", async () => {
  await run(["--live", "--resume", "evals-20261020013422-a1b2c3", "--write-policy"]);
  const { lines, tokens } = await passedArgs();
  expect(tokens).toEqual(["run", "--resume=evals-20261020013422-a1b2c3", "--write-policy"]);
  expect(lines).toContain("--update-env-vars=LIVE_SMOKE=1");
}, 60_000);

test("a truly repeated argument is refused before gcloud is called", async () => {
  await expect(run(["--limit", "3", "--limit", "3"])).rejects.toMatchObject({ code: 2 });
  expect(existsSync(capture)).toBe(false);
}, 60_000);

test("parseArgs reads --name value and --name=value the same way and still collects repeated flags", () => {
  expect(parseArgs(["run", "--limit=3"])).toEqual(parseArgs(["run", "--limit", "3"]));
  expect(parseArgs(["build-golden", "--root=a=b", "--root", "c", "--x"]).flags).toEqual({ root: ["a=b", "c"], x: true });
});
