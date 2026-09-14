import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// v0.1.0 requires this regular executable archive entry and restarts its old
// executable path after replacement. Keep it only as a forwarding entry point.
export function writeLegacyUpdateLauncher(contents) {
  const launcher = join(contents, "MacOS/taskboard-desktop");
  try {
    lstatSync(launcher);
    throw new Error("旧版更新兼容入口已存在，未覆盖");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const source = fileURLToPath(new URL("../src-tauri/legacy-update-launcher.c", import.meta.url));
  const compiled = spawnSync(
    "/usr/bin/cc",
    ["-Os", "-mmacosx-version-min=13.0", "-Wall", "-Wextra", "-Werror", source, "-o", launcher],
    { encoding: "utf8" },
  );
  if (compiled.status !== 0) throw new Error("无法编译旧版更新兼容入口，请检查 Xcode 编译工具");
  chmodSync(launcher, 0o755);
  return launcher;
}
