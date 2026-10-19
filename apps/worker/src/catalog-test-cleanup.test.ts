import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execute=promisify(execFile);
const bash=process.platform==="win32"?path.join(process.env.LOCALAPPDATA!,"Programs/Git/bin/bash.exe"):"bash";
const shellPath=(file:string)=>process.platform==="win32"?file.replace(/\\/g,"/").replace(/^([A-Za-z]):/,(_all,drive:string)=>`/${drive.toLowerCase()}`):file;

test("browser cleanup executes only the fixed job with exact JSON args, propagates failure and removes its own flags file",async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"catalog-cleanup-proof-"));
  try {
    const capture=path.join(dir,"args.txt"),flags=path.join(dir,"flags.json"),temp=path.join(dir,"temp.txt");
    const fake=path.join(dir,"gcloud");
    await writeFile(fake,'#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$CAPTURE_ARGS"\nfor arg in "$@"; do case "$arg" in --flags-file=*) cat "${arg#--flags-file=}" > "$CAPTURE_FLAGS"; printf "%s" "${arg#--flags-file=}" > "$CAPTURE_TEMP";; esac; done\nexit "${FAKE_EXIT:-0}"\n');
    await chmod(fake,0o755);
    const env={...process.env,CAPTURE_ARGS:shellPath(capture),CAPTURE_FLAGS:shellPath(flags),CAPTURE_TEMP:shellPath(temp)};
    const ids=["12345678-1234-1234-1234-123456789abc","abcdef12-abcd-abcd-abcd-abcdef123456"];
    const script=shellPath(path.resolve("infra/catalog-test-cleanup.sh"));
    const args=["-c",'export PATH="$1:$PATH"; shift; exec bash "$@"',"cleanup-proof",shellPath(dir),script,...ids];
    await execute(bash,args,{env});
    const command=(await readFile(capture,"utf8")).trim().split("\n");
    expect(command.slice(0,4)).toEqual(["run","jobs","execute","catalog-test-cleanup"]);
    expect(command).toEqual(expect.arrayContaining(["--region=asia-south1","--project=image-links-agent","--quiet","--wait"]));
    expect(JSON.parse(await readFile(flags,"utf8"))).toEqual({"--args":["dist/catalog-smoke.js","--cleanup-batches",ids.join(",")]});
    await execute(bash,["-c",'test ! -e "$1"',"cleanup-proof",await readFile(temp,"utf8")]);
    const before=await readFile(capture,"utf8");
    await expect(execute(bash,[...args.slice(0,-2),"not-a-uuid"],{env})).rejects.toMatchObject({code:2});
    expect(await readFile(capture,"utf8")).toBe(before);
    await expect(execute(bash,args,{env:{...env,FAKE_EXIT:"7"}})).rejects.toMatchObject({code:7});
    await execute(bash,["-c",'test ! -e "$1"',"cleanup-proof",await readFile(temp,"utf8")]);
    expect(existsSync(flags)).toBe(true);
  } finally {
    expect(path.dirname(path.resolve(dir))).toBe(path.resolve(os.tmpdir()));
    await rm(dir,{recursive:true,force:true});
  }
},60_000);
