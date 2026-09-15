import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeCodexBoardEnvironment } from "@codexboard/contracts";
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
  const env = normalizeCodexBoardEnvironment(environment);
  const directory = env.CODEXBOARD_DATA_DIR ?? join(cwd, ".data");
  if (!directory.trim())
    throw new TaskctlAuthError("RUNTIME_PATH_INVALID", "CODEXBOARD_DATA_DIR 不能为空");
  // Frozen attachment commands may contain either published default path.
  // Follow only a completed default migration; explicit current/custom paths win.
  const oldDefaults = ["Lark-Codex", "Lark Codex Taskboard"].map((name) =>
    join(userHome, "Library/Application Support", name, "data"),
  );
  if (
    environment.CODEXBOARD_DATA_DIR === undefined &&
    oldDefaults.includes(directory) &&
    !metadata(directory)
  ) {
    const current = join(userHome, "Library/Application Support/CodexBoard/data");
    const runtime = metadata(join(current, "run/runtime.json"));
    if (runtime?.isFile() && !runtime.isSymbolicLink()) return current;
  }
  return directory;
}
