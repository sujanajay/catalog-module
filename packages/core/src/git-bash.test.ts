import { describe, expect, test } from "vitest";
import { gitBashPath } from "./git-bash";

const env = {
  ProgramFiles: "C:\\Program Files",
  "ProgramFiles(x86)": "C:\\Program Files (x86)",
  LOCALAPPDATA: "C:\\Users\\op\\AppData\\Local",
};
const systemWide = "C:\\Program Files\\Git\\bin\\bash.exe";
const x86 = "C:\\Program Files (x86)\\Git\\bin\\bash.exe";
const perUser = "C:\\Users\\op\\AppData\\Local\\Programs\\Git\\bin\\bash.exe";
const only = (...files: string[]) => (file: string) => files.includes(file);

describe("gitBashPath", () => {
  test("uses bash from PATH on non-Windows platforms without probing the disk", () => {
    const exists = () => { throw new Error("must not probe"); };
    expect(gitBashPath("linux", { ...env, GIT_BASH: "/opt/bash" }, exists)).toBe("bash");
    expect(gitBashPath("darwin", env, exists)).toBe("bash");
  });

  test("prefers an existing GIT_BASH override on Windows", () => {
    expect(gitBashPath("win32", { ...env, GIT_BASH: "D:\\tools\\bash.exe" }, only("D:\\tools\\bash.exe", systemWide))).toBe("D:\\tools\\bash.exe");
  });

  test("falls through to the system-wide install when the override does not exist", () => {
    expect(gitBashPath("win32", { ...env, GIT_BASH: "D:\\missing\\bash.exe" }, only(systemWide, perUser))).toBe(systemWide);
  });

  test("checks Program Files, then Program Files (x86), then the per-user install", () => {
    expect(gitBashPath("win32", env, only(systemWide, x86, perUser))).toBe(systemWide);
    expect(gitBashPath("win32", env, only(x86, perUser))).toBe(x86);
    expect(gitBashPath("win32", env, only(perUser))).toBe(perUser);
  });

  test("falls back to bash on PATH when nothing is installed or the env is empty", () => {
    expect(gitBashPath("win32", env, only())).toBe("bash");
    expect(gitBashPath("win32", {}, () => true)).toBe("bash");
  });
});
