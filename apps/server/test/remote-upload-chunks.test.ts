import { expect, it } from "vitest";
import {
  RemoteUploadChunks,
  REMOTE_CHUNK_BYTES,
  RemoteChunkQuery,
} from "../src/modules/codex/remote-upload-chunks.js";

it("isolates uploads by owner, expires partials and does not count completed uploads forever", () => {
  const store = new RemoteUploadChunks();
  const chunk = { name: "clip.mp4", mimeType: "video/mp4", size: REMOTE_CHUNK_BYTES + 1, index: 0 };
  const first = Buffer.alloc(REMOTE_CHUNK_BYTES, 3);
  expect(store.add("alice", "same-id", chunk, first, 0)).toBeNull();
  expect(store.add("bob", "same-id", { ...chunk, index: 1 }, Buffer.from([4]), 0)).toBeNull();
  const result = store.add("alice", "same-id", { ...chunk, index: 1 }, Buffer.from([5]), 1);
  expect(Buffer.from(result!.base64, "base64").at(-1)).toBe(5);
  expect(store.add("alice", "same-id", chunk, first, 600_002)).toBeNull();
  for (let i = 0; i < 7; i++)
    expect(store.add("alice", String(i), chunk, first, 600_003)).toBeNull();
  expect(() => store.add("alice", "over-limit", chunk, first, 600_003)).toThrow("繁忙");
  store.add("alice", "same-id", { ...chunk, index: 1 }, Buffer.from([5]), 600_004);
  store.complete("alice", "same-id");
  expect(store.add("alice", "new-upload", chunk, first, 600_005)).toBeNull();
});

it("accepts recording chunks beyond the old 8 MiB cap while enforcing 64 MiB", () => {
  const chunk = {
    name: "Recording.MOV",
    mimeType: "video/quicktime",
    size: 13 * 1024 * 1024,
    index: 69,
  };
  expect(RemoteChunkQuery.parse(chunk)).toEqual(chunk);
  expect(RemoteChunkQuery.safeParse({ ...chunk, size: 64 * 1024 * 1024 + 1 }).success).toBe(false);
  expect(RemoteChunkQuery.safeParse({ ...chunk, index: 342 }).success).toBe(false);
});
