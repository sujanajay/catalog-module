import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Locates Git Bash for tests and helpers that run the repo's infra/*.sh scripts.
 * On Windows it returns the first existing of: $GIT_BASH, the system-wide install under
 * %ProgramFiles% or %ProgramFiles(x86)%, the per-user install under %LOCALAPPDATA%\Programs,
 * else plain "bash" from PATH. On every other platform it returns "bash".
 */
export function gitBashPath(
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (file: string) => boolean = existsSync,
): string {
  if (platform !== "win32") return "bash";
  const candidates = [
    env.GIT_BASH,
    env.ProgramFiles && path.win32.join(env.ProgramFiles, "Git", "bin", "bash.exe"),
    env["ProgramFiles(x86)"] && path.win32.join(env["ProgramFiles(x86)"], "Git", "bin", "bash.exe"),
    env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"),
  ];
  return candidates.find((file): file is string => !!file && exists(file)) ?? "bash";
}
