import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeLarkCodexEnvironment } from "@lark-codex/contracts";
import { TaskctlAuthError } from "./auth.js";

function metadata(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function runtimeDataDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
  cwd = process.cwd(),
): string {
  const env = normalizeLarkCodexEnvironment(environment);
  const directory = env.LARK_CODEX_DATA_DIR ?? join(cwd, ".data");
  if (!directory.trim())
    throw new TaskctlAuthError("RUNTIME_PATH_INVALID", "LARK_CODEX_DATA_DIR 不能为空");
  const oldDefault = join(userHome, "Library/Application Support/Lark Codex Taskboard/data");
  // Frozen attachment commands used this exact legacy path. Only bridge a
  // completed default-directory move, never a new setting or a custom path.
  if (
    environment.LARK_CODEX_DATA_DIR === undefined &&
    environment.LARK_TASKBOARD_DATA_DIR === oldDefault &&
    !metadata(oldDefault)
  ) {
    const current = join(userHome, "Library/Application Support/Lark-Codex/data");
    const runtime = metadata(join(current, "run/runtime.json"));
    if (runtime?.isFile() && !runtime.isSymbolicLink()) return current;
  }
  return directory;
}
