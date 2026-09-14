import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { copyBundledSkill } from "./package-skills.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "lark-skill-package-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "skills/manage-lark-codex");
  mkdirSync(join(source, "scripts"), { recursive: true });
  writeFileSync(join(source, "SKILL.md"), "---\nname: manage-lark-codex\ndescription: test\n---\n");
  writeFileSync(join(source, "scripts/taskctl.sh"), "#!/bin/sh\nexit 0\n");
  writeFileSync(join(source, "README.md"), "Repository-only installation guide");
  return { root, source, runtime: join(root, "runtime") };
}

test("bundles only runnable Skill files with deterministic hashes and executable wrapper", (t) => {
  const { root, source, runtime } = fixture(t);
  const manifest = copyBundledSkill(root, runtime, "0.1.1");
  assert.equal(manifest.version, "0.1.1");
  assert.deepEqual(
    manifest.files.map((file) => file.path),
    ["SKILL.md", "scripts/taskctl.sh"],
  );
  for (const file of manifest.files) {
    const destination = join(runtime, "skills/manage-lark-codex", file.path);
    const bytes = readFileSync(destination);
    assert.deepEqual(bytes, readFileSync(join(source, file.path)));
    assert.equal(file.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(statSync(destination).mode & 0o777, file.mode);
  }
  assert.deepEqual(JSON.parse(readFileSync(join(runtime, "skills/manifest.json"))), manifest);
  assert.throws(() => statSync(join(runtime, "skills/manage-lark-codex/README.md")), {
    code: "ENOENT",
  });
});

test("missing or linked Skill content aborts packaging", (t) => {
  const { root, source, runtime } = fixture(t);
  const script = join(source, "scripts/taskctl.sh");
  rmSync(script);
  assert.throws(() => copyBundledSkill(root, runtime, "0.1.1"), { code: "ENOENT" });
  symlinkSync(join(source, "README.md"), script);
  assert.throws(() => copyBundledSkill(root, runtime, "0.1.1"), /文件无效/);
});

test("packaging fixes file permissions even with a restrictive release umask", (t) => {
  const { root, runtime } = fixture(t);
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { copyBundledSkill } from ${JSON.stringify(new URL("./package-skills.mjs", import.meta.url).href)};
    process.umask(0o077);
    copyBundledSkill(process.argv[1], process.argv[2], "0.1.1");
  `,
      root,
      runtime,
    ],
    { encoding: "utf8" },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(statSync(join(runtime, "skills/manage-lark-codex/SKILL.md")).mode & 0o777, 0o644);
  assert.equal(
    statSync(join(runtime, "skills/manage-lark-codex/scripts/taskctl.sh")).mode & 0o777,
    0o755,
  );
});

test("linked Skill source directories cannot bring outside files into the app", (t) => {
  const { root, source, runtime } = fixture(t);
  const outside = join(root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "taskctl.sh"), "outside content");
  rmSync(join(source, "scripts"), { recursive: true });
  symlinkSync(outside, join(source, "scripts"));
  assert.throws(() => copyBundledSkill(root, runtime, "0.1.1"), /源目录无效/);
});
