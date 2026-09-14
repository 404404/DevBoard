import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createSkillManager } from "./skill-manager.mjs";

const NAME = "manage-lark-codex";
const digest = (value) => createHash("sha256").update(value).digest("hex");
function write(path, value, mode = 0o644) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
  chmodSync(path, mode);
}

function fixture(t, overrides = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "lark-skill-manager-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = join(directory, "home");
  mkdirSync(home);
  const runtimeRoot = join(directory, "runtime");
  const appData = join(home, "Library/Application Support/Lark-Codex");
  const target = join(home, ".agents/skills", NAME);
  const source = join(runtimeRoot, "skills", NAME);
  const stateFile = join(appData, "skill-install-state.json");
  const manifestFile = join(runtimeRoot, "skills/manifest.json");
  let commits = 0;
  function bundled(version = "0.1.1", body = "# Test Skill\n") {
    const files = [
      { path: "SKILL.md", mode: 0o644, body },
      { path: "scripts/taskctl.sh", mode: 0o755, body: "#!/bin/sh\nexit 0\n" },
    ];
    for (const file of files) write(join(source, file.path), file.body, file.mode);
    write(
      manifestFile,
      JSON.stringify({
        schemaVersion: 1,
        name: NAME,
        version,
        files: files.map(({ path, mode, body }) => ({ path, mode, sha256: digest(body) })),
      }),
    );
  }
  bundled();
  const identify = (path) => {
    const value = lstatSync(path, { bigint: true });
    return { dev: String(value.dev), ino: String(value.ino) };
  };
  // The native helper has separate real renameatx_np tests. This adapter models
  // its completed filesystem effect so Node fault tests need no app binary.
  const commitDirectories = ({ stagingName, expectedTarget }) => {
    commits++;
    const stage = join(dirname(target), stagingName);
    if (!expectedTarget) {
      assert.equal(existsSync(target), false);
      renameSync(stage, target);
    } else {
      assert.deepEqual(identify(target), expectedTarget);
      const swap = `${stage}.exchange`;
      renameSync(target, swap);
      renameSync(stage, target);
      renameSync(swap, stage);
    }
  };
  const rollbackNewInstall = ({ stagingName, expectedTarget }) => {
    assert.deepEqual(identify(target), expectedTarget);
    const stage = join(dirname(target), stagingName);
    assert.equal(existsSync(stage), false);
    renameSync(target, stage);
  };
  const options = {
    runtimeRoot,
    appData,
    home,
    commitDirectories,
    rollbackNewInstall,
    ...overrides,
  };
  return {
    directory,
    home,
    runtimeRoot,
    appData,
    target,
    source,
    stateFile,
    manifestFile,
    bundled,
    manager: createSkillManager(options),
    managerWith: (extra) => createSkillManager({ ...options, ...extra }),
    commitDirectories,
    commits: () => commits,
    staging: () =>
      existsSync(dirname(target))
        ? readdirSync(dirname(target)).filter((name) =>
            name.startsWith(".manage-lark-codex.install-"),
          )
        : [],
  };
}

test("status is read-only and explicit install writes verified files with required modes", async (t) => {
  const f = fixture(t);
  const initial = f.manager.status();
  assert.equal(initial.status, "notInstalled");
  assert.equal(initial.canInstall, true);
  assert.match(initial.fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(f.manager.status(), initial);
  assert.deepEqual(readdirSync(f.home), []);
  const installed = await f.manager.install({ expectedFingerprint: null });
  assert.equal(installed.status, "current");
  assert.equal(installed.installedVersion, "0.1.1");
  assert.equal(installed.canInstall, false);
  assert.match(installed.message, /Codex 技能列表/);
  assert.equal(readFileSync(join(f.target, "SKILL.md"), "utf8"), "# Test Skill\n");
  assert.equal(lstatSync(join(f.target, "scripts/taskctl.sh")).mode & 0o777, 0o755);
  assert.equal(lstatSync(join(f.target, "SKILL.md")).mode & 0o777, 0o644);
  assert.equal(lstatSync(f.stateFile).mode & 0o777, 0o600);
  assert.deepEqual(f.staging(), []);
});

test("dismiss persists only the offer preference and never creates the skill", async (t) => {
  const f = fixture(t);
  const result = await f.manager.dismiss();
  assert.equal(result.offerDismissed, true);
  assert.equal(result.status, "notInstalled");
  assert.equal(existsSync(f.target), false);
  assert.equal(existsSync(join(f.home, ".agents")), false);
  assert.equal(f.managerWith({}).status().offerDismissed, true);
});

test("corrupt manifests and modified bundled files never create user skill directories", async (t) => {
  for (const change of [
    (f) => write(f.manifestFile, "bad json"),
    (f) => write(join(f.source, "SKILL.md"), "changed bundle"),
    (f) => {
      const value = JSON.parse(readFileSync(f.manifestFile));
      value.files[0].path = "../outside";
      write(f.manifestFile, JSON.stringify(value));
    },
    (f) => {
      const value = JSON.parse(readFileSync(f.manifestFile));
      value.files.push(value.files[0]);
      write(f.manifestFile, JSON.stringify(value));
    },
    (f) => {
      const value = JSON.parse(readFileSync(f.manifestFile));
      value.files[0].mode = 0o777;
      write(f.manifestFile, JSON.stringify(value));
    },
  ]) {
    const f = fixture(t);
    change(f);
    assert.equal(f.manager.status().status, "unavailable");
    assert.equal((await f.manager.install()).status, "error");
    assert.deepEqual(readdirSync(f.home), []);
  }
});

test("unknown existing directories require explicit replacement and their fresh whole-tree fingerprint", async (t) => {
  const f = fixture(t);
  write(join(f.target, "SKILL.md"), "custom skill");
  write(join(f.target, "notes.txt"), "custom notes");
  const before = f.manager.status();
  assert.equal(before.status, "modified");
  assert.equal(before.canInstall, false);
  assert.equal(before.canReplace, true);
  assert.equal(
    (await f.manager.install({ expectedFingerprint: before.fingerprint })).status,
    "error",
  );
  assert.equal(
    (await f.manager.install({ replaceModified: true, expectedFingerprint: "0".repeat(64) }))
      .status,
    "error",
  );
  assert.equal(readFileSync(join(f.target, "notes.txt"), "utf8"), "custom notes");
  const result = await f.manager.install({
    replaceModified: true,
    expectedFingerprint: before.fingerprint,
  });
  assert.equal(result.status, "current");
  assert.equal(existsSync(join(f.target, "notes.txt")), false);
  assert.deepEqual(f.staging(), []);
});

test("actual content, modes, extra entries and a rewritten receipt each make owned skills modified", async (t) => {
  for (const mutate of [
    (f) => write(join(f.target, "SKILL.md"), "user edit"),
    (f) => chmodSync(join(f.target, "scripts/taskctl.sh"), 0o644),
    (f) => write(join(f.target, "extra.txt"), "extra"),
    (f) => mkdirSync(join(f.target, "extra-directory")),
    (f) => chmodSync(join(f.target, "scripts"), 0o755),
    (f) => write(join(f.target, ".lark-codex-skill.json"), "{}"),
    (f) => {
      write(join(f.target, "SKILL.md"), "user edit");
      const path = join(f.target, ".lark-codex-skill.json");
      const value = JSON.parse(readFileSync(path));
      value.files.find((file) => file.path === "SKILL.md").sha256 = digest("user edit");
      write(path, JSON.stringify(value));
    },
  ]) {
    const f = fixture(t);
    assert.equal((await f.manager.install()).status, "current");
    mutate(f);
    assert.equal(f.manager.status().status, "modified");
    assert.equal(f.manager.status().canReplace, true);
  }
});

test("new bundled versions are offered without writing and update only after a fresh request", async (t) => {
  const f = fixture(t);
  await f.manager.install();
  f.bundled("0.1.2", "new version\n");
  const status = f.manager.status();
  assert.equal(status.status, "updateAvailable");
  assert.equal(status.installedVersion, "0.1.1");
  assert.equal(status.bundledVersion, "0.1.2");
  assert.equal(readFileSync(join(f.target, "SKILL.md"), "utf8"), "# Test Skill\n");
  assert.equal((await f.manager.install()).status, "error");
  const result = await f.manager.install({ expectedFingerprint: status.fingerprint });
  assert.equal(result.status, "current");
  assert.equal(result.installedVersion, "0.1.2");
  f.bundled("0.1.1");
  assert.equal(f.manager.status().status, "current");
  assert.equal((await f.manager.install()).installedVersion, "0.1.2");
  assert.equal(readFileSync(join(f.target, "SKILL.md"), "utf8"), "new version\n");
});

test("links, special paths and manager markers cannot be replaced even with confirmation", async (t) => {
  for (const setup of [
    (f, outside) => symlinkSync(outside, join(f.home, ".agents")),
    (f, outside) => {
      mkdirSync(dirname(f.target), { recursive: true });
      symlinkSync(outside, f.target);
    },
    (f, outside) => {
      mkdirSync(f.target, { recursive: true });
      symlinkSync(join(outside, "keep.txt"), join(f.target, "SKILL.md"));
    },
    (f) => write(join(f.target, ".git"), "gitdir: elsewhere"),
  ]) {
    const f = fixture(t);
    const outside = join(f.directory, "outside");
    write(join(outside, "keep.txt"), "keep");
    setup(f, outside);
    const status = f.manager.status();
    assert.equal(status.status, "managed");
    assert.equal(status.canReplace, false);
    assert.equal(
      (await f.manager.install({ replaceModified: true, expectedFingerprint: status.fingerprint }))
        .status,
      "error",
    );
    assert.deepEqual(readdirSync(outside), ["keep.txt"]);
    assert.equal(readFileSync(join(outside, "keep.txt"), "utf8"), "keep");
  }
});

test("either default or configured legacy Codex skill location prevents duplicate installation", async (t) => {
  for (const custom of [false, true]) {
    const f = fixture(t);
    const root = custom ? join(f.directory, "custom-codex") : join(f.home, ".codex");
    const legacy = join(root, "skills", NAME);
    mkdirSync(dirname(legacy), { recursive: true });
    symlinkSync(join(f.directory, "missing-managed-skill"), legacy);
    const manager = f.managerWith({ codexHome: custom ? root : "relative-ignored" });
    assert.equal(manager.status().status, "managed");
    assert.match(manager.status().message, /旧技能目录/);
    assert.equal((await manager.install()).status, "error");
    assert.equal(existsSync(f.target), false);
  }
});

test("target changes immediately before commit reject the stale confirmation", async (t) => {
  const f = fixture(t);
  write(join(f.target, "SKILL.md"), "first edit");
  const before = f.manager.status();
  const manager = f.managerWith({
    beforeCommit: () => write(join(f.target, "SKILL.md"), "concurrent edit"),
  });
  const result = await manager.install({
    replaceModified: true,
    expectedFingerprint: before.fingerprint,
  });
  assert.equal(result.status, "error");
  assert.match(result.message, /已发生变化/);
  assert.equal(f.commits(), 0);
  assert.equal(readFileSync(join(f.target, "SKILL.md"), "utf8"), "concurrent edit");
  assert.deepEqual(f.staging(), []);
});

test("pre-rename Skill directories remain untouched and block duplicate installation", async (t) => {
  for (const location of ["agents", "codex", "custom"]) {
    const f = fixture(t);
    const root =
      location === "agents"
        ? join(f.home, ".agents")
        : location === "codex"
          ? join(f.home, ".codex")
          : join(f.directory, "custom-codex");
    const old = join(root, "skills/manage-lark-taskboard");
    write(join(old, "SKILL.md"), "personal pre-rename skill");
    const manager = f.managerWith({ codexHome: location === "custom" ? root : undefined });
    assert.equal(manager.status().status, "managed");
    assert.equal((await manager.install({ replaceModified: true })).status, "error");
    assert.equal(readFileSync(join(old, "SKILL.md"), "utf8"), "personal pre-rename skill");
    assert.equal(existsSync(f.target), false);
  }
});

test("a legacy receipt owner at the renamed target remains protected as modified", async (t) => {
  const f = fixture(t);
  await f.manager.install();
  const receiptFile = join(f.target, ".lark-codex-skill.json");
  const receipt = JSON.parse(readFileSync(receiptFile));
  receipt.owner = "cn.rocyan.taskboard.desktop";
  const bytes = JSON.stringify(receipt) + "\n";
  write(receiptFile, bytes);
  const state = JSON.parse(readFileSync(f.stateFile));
  state.installed.receiptSha256 = digest(bytes);
  write(f.stateFile, JSON.stringify(state), 0o600);
  const before = f.manager.status();
  assert.equal(before.status, "modified");
  assert.equal(
    (await f.manager.install({ expectedFingerprint: before.fingerprint })).status,
    "error",
  );
  assert.equal(readFileSync(receiptFile, "utf8"), bytes);
});

test("failed native commit preserves old content and removes only this operation staging", async (t) => {
  const f = fixture(t);
  write(join(f.target, "SKILL.md"), "original");
  const manager = f.managerWith({
    commitDirectories: () => {
      throw new Error("synthetic failure with private data");
    },
  });
  const result = await manager.install({
    replaceModified: true,
    expectedFingerprint: manager.status().fingerprint,
  });
  assert.equal(result.status, "error");
  assert.doesNotMatch(result.message, /private data/);
  assert.equal(readFileSync(join(f.target, "SKILL.md"), "utf8"), "original");
  assert.equal(existsSync(f.stateFile), false);
  assert.deepEqual(f.staging(), []);
});

test("metadata commit failure reverses both initial install and directory replacement", async (t) => {
  for (const existing of [false, true]) {
    const f = fixture(t);
    if (existing) await f.manager.install();
    const previousState = existing ? readFileSync(f.stateFile) : null;
    const previousTree = existing ? f.manager.status().fingerprint : null;
    f.bundled("0.1.2", "next version");
    const manager = f.managerWith({
      beforeStateCommit: () => {
        throw new Error("injected metadata failure");
      },
    });
    const result = await manager.install({ expectedFingerprint: manager.status().fingerprint });
    assert.equal(result.status, "error");
    if (existing) {
      assert.deepEqual(readFileSync(f.stateFile), previousState);
      assert.equal(f.manager.status().fingerprint, previousTree);
      assert.equal(f.manager.status().status, "updateAvailable");
    } else {
      assert.equal(existsSync(f.target), false);
      assert.equal(existsSync(f.stateFile), false);
    }
    assert.deepEqual(f.staging(), []);
  }
});

test("a lost acknowledgement after directory commit preserves original staging and reports uncertainty", async (t) => {
  for (const existing of [false, true]) {
    const f = fixture(t);
    if (existing) write(join(f.target, "personal.txt"), "synthetic original contents");
    const manager = f.managerWith({
      commitDirectories: (request) => {
        f.commitDirectories(request);
        throw new Error("synthetic lost success acknowledgement");
      },
    });
    const result = await manager.install({
      replaceModified: true,
      expectedFingerprint: manager.status().fingerprint,
    });
    assert.equal(result.status, "error");
    assert.match(result.message, /无法确认安装提交结果/);
    assert.doesNotMatch(result.message, /原有目录未被替换/);
    assert.equal(readFileSync(join(f.target, "SKILL.md"), "utf8"), "# Test Skill\n");
    assert.equal(existsSync(f.stateFile), false);
    if (existing) {
      assert.equal(f.staging().length, 1);
      assert.equal(
        readFileSync(join(dirname(f.target), f.staging()[0], "personal.txt"), "utf8"),
        "synthetic original contents",
      );
    } else assert.deepEqual(f.staging(), []);
  }
});

test("rollback never treats a concurrently substituted target as the newly installed directory", async (t) => {
  const f = fixture(t);
  write(join(f.target, "personal.txt"), "synthetic original contents");
  const installed = join(f.directory, "concurrently-moved-install");
  const manager = f.managerWith({
    commitDirectories: (request) => {
      f.commitDirectories(request);
      renameSync(f.target, installed);
      write(join(f.target, "external.txt"), "keep concurrent synthetic contents");
    },
  });
  const result = await manager.install({
    replaceModified: true,
    expectedFingerprint: manager.status().fingerprint,
  });
  assert.equal(result.status, "error");
  assert.match(result.message, /无法确认替换恢复结果/);
  assert.equal(
    readFileSync(join(f.target, "external.txt"), "utf8"),
    "keep concurrent synthetic contents",
  );
  assert.equal(f.staging().length, 1);
  assert.equal(
    readFileSync(join(dirname(f.target), f.staging()[0], "personal.txt"), "utf8"),
    "synthetic original contents",
  );
  assert.equal(readFileSync(join(installed, "SKILL.md"), "utf8"), "# Test Skill\n");
});

test("a substituted staging directory is never installed or removed", async (t) => {
  const f = fixture(t);
  const held = join(f.directory, "held-original-stage");
  const manager = f.managerWith({
    beforeCommit: () => {
      const path = join(dirname(f.target), f.staging()[0]);
      renameSync(path, held);
      write(join(path, "personal.txt"), "unrelated synthetic directory");
    },
  });
  const result = await manager.install();
  assert.equal(result.status, "error");
  assert.equal(existsSync(f.target), false);
  assert.equal(f.commits(), 0);
  assert.equal(f.staging().length, 1);
  assert.equal(
    readFileSync(join(dirname(f.target), f.staging()[0], "personal.txt"), "utf8"),
    "unrelated synthetic directory",
  );
});

test("concurrent install requests are serialized and do not replace a completed current version", async (t) => {
  const f = fixture(t);
  const fingerprint = f.manager.status().fingerprint;
  const results = await Promise.all([
    f.manager.install({ expectedFingerprint: fingerprint }),
    f.manager.install({ expectedFingerprint: fingerprint }),
  ]);
  assert.deepEqual(
    results.map((result) => result.status),
    ["current", "current"],
  );
  assert.equal(f.commits(), 1);
  assert.deepEqual(f.staging(), []);
});

test("missing or corrupt independent installation records cannot authorize automatic replacement", async (t) => {
  const f = fixture(t);
  await f.manager.install();
  write(f.stateFile, "not-json", 0o600);
  assert.equal(f.manager.status().status, "modified");
  const result = await f.manager.install({
    replaceModified: true,
    expectedFingerprint: f.manager.status().fingerprint,
  });
  assert.equal(result.status, "current");
  rmSync(f.stateFile);
  assert.equal(f.manager.status().status, "modified");
});

test("an installation-state symlink is never followed or overwritten", async (t) => {
  const f = fixture(t);
  const outside = join(f.directory, "outside.json");
  write(outside, "keep this file");
  mkdirSync(f.appData, { recursive: true });
  symlinkSync(outside, f.stateFile);
  assert.equal(f.manager.status().status, "managed");
  assert.equal((await f.manager.dismiss()).status, "error");
  assert.equal(readFileSync(outside, "utf8"), "keep this file");
  assert.equal(lstatSync(f.stateFile).isSymbolicLink(), true);
});

test(
  "unreadable target files return an actionable error without writing",
  { skip: process.getuid?.() === 0 },
  async (t) => {
    const f = fixture(t);
    write(join(f.target, "SKILL.md"), "private synthetic text", 0o000);
    const result = f.manager.status();
    assert.equal(result.status, "error");
    assert.match(result.message, /权限/);
    assert.equal((await f.manager.install()).status, "error");
    chmodSync(join(f.target, "SKILL.md"), 0o644);
    assert.equal(readFileSync(join(f.target, "SKILL.md"), "utf8"), "private synthetic text");
  },
);
