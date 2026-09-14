import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, parse, resolve, sep } from "node:path";

export function assertNoSymlinkComponents(path: string, label: string): string {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const segments = absolute.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    if (!existsSync(current)) break;
    const stat = lstatSync(current);
    let isDirectory = stat.isDirectory();
    if (stat.isSymbolicLink()) {
      const canonical = realpathSync.native(current);
      const isMacSystemAlias =
        (current === "/var" && canonical === "/private/var") ||
        (current === "/tmp" && canonical === "/private/tmp");
      if (!isMacSystemAlias) throw new Error(`${label}路径不能包含符号链接`);
      isDirectory = lstatSync(canonical).isDirectory();
    }
    if (index < segments.length - 1 && !isDirectory) {
      throw new Error(`${label}的祖先路径必须是目录`);
    }
  }
  const missing: string[] = [];
  let existing = absolute;
  while (!existsSync(existing)) {
    missing.unshift(basename(existing));
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  return resolve(realpathSync.native(existing), ...missing);
}
