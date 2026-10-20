import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, test } from "vitest";
import { gitBashPath } from "@catalog/core/git-bash";
import { parseArgs } from "./catalog-eval-cli";

// infra/catalog-eval.sh exec against a fake gcloud: no GCP call is made.
const execute = promisify(execFile);
const bash = gitBashPath();
const shellPath = (file: string) => process.platform === "win32" ? file.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_all, drive: string) => `/${drive.toLowerCase()}`) : file;

let dir: string, capture: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "catalog-eval-args-"));
  capture = path.join(dir, "args.txt");
  const fake = path.join(dir, "gcloud");
  await writeFile(fake, '#!/usr/bin/env bash\ncase "$1 $2 $3" in\n  "run jobs list") echo catalog-eval ;;\n  "run jobs execute") printf "%s\\n" "$@" > "$CAPTURE_ARGS" ;;\n  *) echo "unexpected gcloud $*" >&2; exit 9 ;;\nesac\n');
  await chmod(fake, 0o755);
});
afterEach(async () => {
  expect(path.dirname(path.resolve(dir))).toBe(path.resolve(os.tmpdir()));
  await rm(dir, { recursive: true, force: true });
});

const run = (cliArgs: string[], extraEnv: Record<string, string> = {}) =>
  execute(bash, ["-c", 'export PATH="$1:$PATH"; shift; exec bash "$@"', "eval-args", shellPath(dir), shellPath(path.resolve("infra/catalog-eval.sh")), "exec", ...cliArgs], { env: { ...process.env, CAPTURE_ARGS: shellPath(capture), ...extraEnv } });

/** The --args value split the way gcloud splits it ("^|^" = "|" separator). */
async function passedArgs(): Promise<{ lines: string[]; tokens: string[] }> {
  const lines = (await readFile(capture, "utf8")).trim().split("\n");
  const value = lines.find(l => l.startsWith("--args="))!.slice("--args=".length);
  expect(value.startsWith("^|^")).toBe(true);
  return { lines, tokens: value.slice(3).split("|") };
}

test("repeated values (--sample 1 --seed 1, --set anta --brand anta) reach the CLI as unique tokens", async () => {
  await run(["assemble", "--set", "anta", "--brand", "anta", "--sample", "1", "--seed", "1"]);
  const { lines, tokens } = await passedArgs();
  expect(lines.slice(0, 4)).toEqual(["run", "jobs", "execute", "catalog-eval"]);
  expect(tokens).toEqual(["assemble", "--set=anta", "--brand=anta", "--sample=1", "--seed=1"]);
  // gcloud refuses a value that appears twice inside --args; every token is unique.
  expect(new Set(tokens).size).toBe(tokens.length);
  expect(parseArgs(tokens)).toEqual({ words: ["assemble"], flags: { set: "anta", brand: "anta", sample: "1", seed: "1" } });
}, 60_000);

test("boolean flags, comma lists and the --live switch keep their meaning", async () => {
  await run(["--live", "judges", "--batch", "b1", "--models", "a/x,b/y"], { EVAL_BUDGET_USD: "2" });
  const { lines, tokens } = await passedArgs();
  expect(tokens).toEqual(["judges", "--batch=b1", "--models=a/x,b/y"]);
  expect(lines).toContain("--update-env-vars=LIVE_SMOKE=1,EVAL_BUDGET_USD=2");
  await run(["policy", "write", "--set", "anta", "--dry-run", "--batches", "x,y"]);
  const second = await passedArgs();
  expect(second.tokens).toEqual(["policy", "write", "--set=anta", "--dry-run", "--batches=x,y"]);
  expect(parseArgs(second.tokens)).toEqual({ words: ["policy", "write"], flags: { set: "anta", "dry-run": true, batches: "x,y" } });
}, 60_000);

test("a truly repeated argument is refused before gcloud is called", async () => {
  await expect(run(["score", "--set", "anta", "--set", "anta"])).rejects.toMatchObject({ code: 2 });
  expect(existsSync(capture)).toBe(false);
}, 60_000);

test("parseArgs reads --name value and --name=value the same way", () => {
  expect(parseArgs(["cleanup", "--set=anta-1"])).toEqual(parseArgs(["cleanup", "--set", "anta-1"]));
  expect(parseArgs(["run", "--folder=a=b", "--live"]).flags).toEqual({ folder: "a=b", live: true });
});
