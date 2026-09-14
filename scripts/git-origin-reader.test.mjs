import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { readGitOrigins } from "./git-origin-reader.mjs";

test("attributes only successful creation commands in the right repository and creation interval", async () => {
  const home = mkdtempSync(join(tmpdir(), "git-origin-"));
  try {
    mkdirSync(join(home, "sessions"));
    const id = "11111111-1111-4111-8111-111111111111";
    const event = (command, cwd = "/repo", code = 0, seconds = 100) => ({
      type: "event_msg",
      payload: {
        type: "item_completed",
        thread_id: id,
        started_at_ms: seconds * 1000,
        completed_at_ms: seconds * 1000 + 500,
        item: {
          type: "CommandExecution",
          command: ["zsh", "-lc", command],
          cwd: `file://${cwd}`,
          exit_code: code,
        },
      },
    });
    const records = [
      event("git worktree add .worktrees/test -b feature/test"),
      event("git branch feature/elsewhere", "/another"),
      event("git branch feature/failed", "/repo", 1),
      event("git branch feature/recreated", "/repo", 0, 50),
      event('echo "git branch feature/quoted"'),
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ text: "git branch feature/quoted" }],
        },
      },
    ];
    writeFileSync(
      join(home, "sessions", "rollout.jsonl"),
      records.map(JSON.stringify).join("\n") + "\n",
    );
    const query = {
      mainPath: "/repo",
      resources: [
        ...["test", "elsewhere", "failed", "recreated", "quoted"].map((name) => ({
          key: name,
          kind: "branch",
          branch: `feature/${name}`,
          path: null,
          createdAt: new Date(100000).toISOString(),
        })),
        {
          key: "worktree",
          kind: "worktree",
          branch: "feature/test",
          path: "/repo/.worktrees/test",
          createdAt: new Date(100000).toISOString(),
        },
      ],
    };
    const result = await readGitOrigins(home, query);
    assert.equal(result.test.threadId, id);
    assert.equal(result.worktree.kind, "codex");
    for (const key of ["elsewhere", "failed", "recreated", "quoted"])
      assert.equal(result[key], undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("uses the current Desktop name, refreshes renames, and never displays the initial prompt", async () => {
  const home = mkdtempSync(join(tmpdir(), "git-title-"));
  const db = new Database(join(home, "state_5.sqlite"));
  try {
    db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, name TEXT)");
    const id = "11111111-1111-4111-8111-111111111111";
    db.prepare("INSERT INTO threads VALUES (?, ?, ?)").run(
      id,
      "[$skill](/private/path) long original prompt",
      "实现 iPhone Codex 功能",
    );
    const query = {
      mainPath: "/repo",
      resources: [
        {
          key: "known",
          kind: "branch",
          branch: "feature/test",
          path: null,
          createdAt: new Date(100000).toISOString(),
          threadId: id,
        },
      ],
    };
    assert.equal((await readGitOrigins(home, query)).known?.threadTitle, "实现 iPhone Codex 功能");
    db.prepare("UPDATE threads SET name = ?").run("新标题");
    assert.equal((await readGitOrigins(home, query)).known.threadTitle, "新标题");
    db.prepare("UPDATE threads SET name = NULL").run();
    assert.equal((await readGitOrigins(home, query)).known.threadTitle, undefined);
  } finally {
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});
