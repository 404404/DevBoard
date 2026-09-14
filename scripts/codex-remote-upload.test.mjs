import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  storeRemoteUpload,
  resolveRemoteUploads,
  readRemoteUploadImage,
} from "./codex-remote-upload.mjs";

test("uploaded files are durable, owner-bound and cannot supply arbitrary paths", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "remote-upload-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const ownerKey = "a".repeat(64);
  const id = "11111111-1111-4111-8111-111111111111";
  const upload = {
    id,
    ownerKey,
    name: "notes.txt",
    mimeType: "text/plain",
    base64: Buffer.from("hello").toString("base64"),
  };
  assert.deepEqual(await storeRemoteUpload(home, upload), {
    id,
    name: "notes.txt",
    mimeType: "text/plain",
    size: 5,
  });
  const [file] = await resolveRemoteUploads(home, { ownerKey, attachments: [id] });
  assert.equal(await readFile(file.path, "utf8"), "hello");
  await assert.rejects(resolveRemoteUploads(home, { ownerKey: "b".repeat(64), attachments: [id] }));
  await assert.rejects(resolveRemoteUploads(home, { ownerKey, attachments: ["/etc/passwd"] }));
  await assert.rejects(storeRemoteUpload(home, { ...upload, name: "../bad" }));
  await assert.rejects(storeRemoteUpload(home, { ...upload, base64: "bad?" }));
  assert.deepEqual(await storeRemoteUpload(home, upload), {
    id,
    name: "notes.txt",
    mimeType: "text/plain",
    size: 5,
  });
  await assert.rejects(
    storeRemoteUpload(home, { ...upload, base64: Buffer.from("changed").toString("base64") }),
  );
});

test("accepts the full 64 MiB upload limit with a long Unicode display name", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "remote-upload-limit-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const upload = {
    ownerKey: "a".repeat(64),
    id: "22222222-2222-4222-8222-222222222222",
    name: "图".repeat(170) + ".png",
    mimeType: "application/octet-stream",
    base64: Buffer.alloc(64 * 1024 * 1024, 1).toString("base64"),
  };
  assert.equal((await storeRemoteUpload(home, upload)).size, 64 * 1024 * 1024);
});

test("previews uploaded images only for their owner and rejects non-images", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "remote-preview-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const ownerKey = "a".repeat(64),
    id = "11111111-1111-4111-8111-111111111111";
  const base64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=";
  await storeRemoteUpload(home, { ownerKey, id, name: "image.png", base64 });
  assert.deepEqual(await readRemoteUploadImage(home, { ownerKey, id }), {
    mimeType: "image/png",
    base64,
  });
  await assert.rejects(readRemoteUploadImage(home, { ownerKey: "b".repeat(64), id }));
  const textId = "22222222-2222-4222-8222-222222222222";
  await storeRemoteUpload(home, {
    ownerKey,
    id: textId,
    name: "fake.png",
    mimeType: "image/png",
    base64: "aGVsbG8=",
  });
  await assert.rejects(readRemoteUploadImage(home, { ownerKey, id: textId }));
});
