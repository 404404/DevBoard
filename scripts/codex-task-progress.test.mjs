import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTaskProgress } from "./codex-task-progress.mjs";
const record = (payload) => JSON.stringify({ type: "response_item", payload });
const plan = (statuses) =>
  record({
    type: "function_call",
    name: "update_plan",
    arguments: JSON.stringify({ plan: statuses.map((status) => ({ step: "step", status })) }),
  });
test("counts the latest real plan and accepts zero completed steps", () => {
  assert.deepEqual(
    parseTaskProgress(
      [plan(["completed"]), plan(["completed", "in_progress", "pending"])].join("\n"),
    ),
    { completed: 1, total: 3 },
  );
  assert.deepEqual(parseTaskProgress(plan(["pending"])), { completed: 0, total: 1 });
});
test("ignores prose, malformed input, and unrelated tool calls", () => {
  assert.equal(
    parseTaskProgress(record({ type: "agentMessage", text: 'plan: [{status:"completed"}]' })),
    null,
  );
  assert.equal(
    parseTaskProgress(
      record({
        type: "function_call",
        name: "other",
        arguments: '{"plan":[{"status":"completed"}]}',
      }),
    ),
    null,
  );
  assert.equal(parseTaskProgress(plan(["unexpected"])), null);
  assert.equal(parseTaskProgress("partial{"), null);
});
test("reads custom tool and exec plan updates without evaluating code", () => {
  assert.deepEqual(
    parseTaskProgress(
      record({
        type: "custom_tool_call",
        name: "update_plan",
        input: '{"plan":[{"status":"completed"},{"status":"pending"}]}',
      }),
    ),
    { completed: 1, total: 2 },
  );
  assert.deepEqual(
    parseTaskProgress(
      record({
        type: "custom_tool_call",
        name: "exec",
        input:
          'text(await tools.update_plan({plan: [{step: "a", status: "completed"}, {step: "b", status: "pending"}]}));',
      }),
    ),
    { completed: 1, total: 2 },
  );
});

test("reads only the bound rollout, refreshes appended plans, and rejects outside paths", async () => {
  const { mkdtemp, mkdir, writeFile, appendFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { default: Database } = await import("better-sqlite3");
  const { readTaskProgress } = await import("./codex-task-progress.mjs");
  const home = await mkdtemp(join(tmpdir(), "task-progress-"));
  const id = "11111111-1111-4111-8111-111111111111";
  const db = new Database(join(home, "state_5.sqlite"));
  try {
    db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)");
    await mkdir(join(home, "sessions"));
    const path = join(home, "sessions", "rollout.jsonl");
    await writeFile(path, plan(["pending", "pending"]) + "\n");
    db.prepare("INSERT INTO threads VALUES (?,?)").run(id, path);
    assert.deepEqual(await readTaskProgress(home, { threadId: id }), { completed: 0, total: 2 });
    await appendFile(path, plan(["completed", "pending"]) + "\n");
    assert.deepEqual(await readTaskProgress(home, { threadId: id }), { completed: 1, total: 2 });
    const outside = join(home, "other.jsonl");
    await writeFile(outside, plan(["completed"]));
    db.prepare("UPDATE threads SET rollout_path = ?").run(outside);
    assert.equal(await readTaskProgress(home, { threadId: id }), null);
    await assert.rejects(readTaskProgress(home, { threadId: "../other" }));
  } finally {
    db.close();
    await rm(home, { recursive: true, force: true });
  }
});
