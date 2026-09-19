import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readCodexThreadTitle, readCodexThreadTitles } from "./codex-thread-title.mjs";

test("reads the latest persisted title without accepting another thread or a partial append", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "codex-title-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.equal(await readCodexThreadTitle(home, "one"), null);
  await writeFile(
    join(home, "session_index.jsonl"),
    [
      JSON.stringify({ id: "one", thread_name: "原名称" }),
      JSON.stringify({ id: "one", thread_name: "新名称" }),
      JSON.stringify({ id: "two", thread_name: "其他对话" }),
      '{"id":"one",',
    ].join("\n"),
  );
  assert.equal(await readCodexThreadTitle(home, "one"), "新名称");
  assert.equal(await readCodexThreadTitle(home, "missing"), null);
  assert.deepEqual(
    [...(await readCodexThreadTitles(home, ["one", "missing"]))],
    [["one", "新名称"]],
  );
});
