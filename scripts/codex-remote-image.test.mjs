import assert from "node:assert/strict";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readRemoteImage } from "./codex-remote-image.mjs";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
test("reads only referenced raster images and rejects arbitrary IDs, nonimages and symlinks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "remote-image-"));
  try {
    const path = join(dir, "test.png");
    await writeFile(path, png);
    const snapshot = { turns: [{ items: [{ id: "img", type: "imageView", path }] }] };
    assert.deepEqual(await readRemoteImage(snapshot, { itemId: "img", imageIndex: 0 }), {
      mimeType: "image/png",
      base64: png.toString("base64"),
    });
    await assert.rejects(readRemoteImage(snapshot, { itemId: path, imageIndex: 0 }));
    await assert.rejects(readRemoteImage(snapshot, { itemId: "img", imageIndex: 1 }));
    await writeFile(path, "not an image");
    await assert.rejects(readRemoteImage(snapshot, { itemId: "img", imageIndex: 0 }));
    await rm(path);
    await writeFile(join(dir, "real.png"), png);
    await symlink(join(dir, "real.png"), path);
    await assert.rejects(readRemoteImage(snapshot, { itemId: "img", imageIndex: 0 }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("supports canonical user images without fetching remote URLs", async () => {
  const item = {
    id: "user",
    type: "userMessage",
    content: [
      { type: "text", text: "hello" },
      { type: "image", url: `data:image/png;base64,${png.toString("base64")}` },
    ],
  };
  const snapshot = {
    turnHistory: { kind: "canonical", history: { entitiesByKey: { turn: { items: [item] } } } },
  };
  assert.equal(
    (await readRemoteImage(snapshot, { itemId: "user", imageIndex: 0 })).mimeType,
    "image/png",
  );
  item.content[1].url = "https://example.com/image.png";
  await assert.rejects(readRemoteImage(snapshot, { itemId: "user", imageIndex: 0 }));
});

test("previews an image from live opening input before its user item is hydrated", async () => {
  const dir = await mkdtemp(join(tmpdir(), "remote-input-image-"));
  try {
    const path = join(dir, "test.png");
    await writeFile(path, png);
    const snapshot = {
      turns: [{ turnId: "live", params: { input: [{ type: "localImage", path }] }, items: [] }],
    };
    assert.equal(
      (await readRemoteImage(snapshot, { itemId: "remote-input:live", imageIndex: 0 })).base64,
      png.toString("base64"),
    );
    snapshot.turns[0].items.push({
      type: "userMessage",
      id: "real",
      content: snapshot.turns[0].params.input,
    });
    assert.equal(
      (await readRemoteImage(snapshot, { itemId: "remote-input:live", imageIndex: 0 })).mimeType,
      "image/png",
    );
    await assert.rejects(
      readRemoteImage(snapshot, { itemId: "remote-input:other", imageIndex: 0 }),
    );
    await assert.rejects(readRemoteImage(snapshot, { itemId: path, imageIndex: 0 }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
