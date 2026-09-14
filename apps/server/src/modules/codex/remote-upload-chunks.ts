import { z } from "zod";
import { RemoteUploadSchema, REMOTE_UPLOAD_MAX_BYTES } from "@lark-taskboard/contracts";
import { AppError } from "../../app-error.js";

export const REMOTE_CHUNK_BYTES = 192 * 1024;
const maxBytes = REMOTE_UPLOAD_MAX_BYTES;
const ttl = 10 * 60_000;
export const RemoteChunkQuery = RemoteUploadSchema.omit({ base64: true }).extend({
  size: z.coerce.number().int().min(1).max(maxBytes),
  index: z.coerce
    .number()
    .int()
    .min(0)
    .max(Math.ceil(maxBytes / REMOTE_CHUNK_BYTES) - 1),
});
type Chunk = z.infer<typeof RemoteChunkQuery>;
type Entry = {
  metadata: string;
  owner: string;
  size: number;
  updated: number;
  parts: Map<number, Buffer>;
  completed?: boolean;
};

// Temporary, bounded staging only. Final attachment writes retain the existing
// durable idempotency receipt; chunks never execute a conversation action.
export class RemoteUploadChunks {
  private readonly uploads = new Map<string, Entry>();
  complete(owner: string, id: string) {
    const entry = this.uploads.get(`${owner}:${id}`);
    if (entry) entry.completed = true;
  }
  add(owner: string, id: string, chunk: Chunk, body: unknown, now = Date.now()) {
    for (const [key, entry] of this.uploads)
      if (now - entry.updated > ttl) this.uploads.delete(key);
    const expected = Math.min(REMOTE_CHUNK_BYTES, chunk.size - chunk.index * REMOTE_CHUNK_BYTES);
    if (!Buffer.isBuffer(body) || expected <= 0 || body.length !== expected)
      throw new AppError("INVALID_REQUEST", 400, "附件分段大小不正确，请重新选择文件");
    const key = `${owner}:${id}`;
    const metadata = JSON.stringify([chunk.name, chunk.mimeType, chunk.size]);
    let entry = this.uploads.get(key);
    if (!entry) {
      // Finished entries are only a short retry cache, not a quota on future uploads.
      for (const [oldKey, old] of this.uploads) {
        const entries = [...this.uploads.values()];
        if (
          entries.filter((item) => item.owner === owner).length < 8 &&
          entries.reduce((total, item) => total + item.size, 0) + chunk.size <= 2 * maxBytes
        )
          break;
        if (old.completed) this.uploads.delete(oldKey);
      }
      const entries = [...this.uploads.values()];
      if (
        entries.filter((item) => item.owner === owner).length >= 8 ||
        entries.reduce((total, item) => total + item.size, 0) + chunk.size > 2 * maxBytes
      )
        throw new AppError("INVALID_REQUEST", 429, "上传暂存空间繁忙，请稍后重试");
      entry = { metadata, owner, size: chunk.size, updated: now, parts: new Map() };
      this.uploads.set(key, entry);
    }
    if (
      entry.metadata !== metadata ||
      (entry.parts.has(chunk.index) && !entry.parts.get(chunk.index)!.equals(body))
    )
      throw new AppError("INVALID_REQUEST", 409, "同一上传编号的附件内容已改变，请重新选择文件");
    entry.updated = now;
    entry.parts.set(chunk.index, body);
    const count = Math.ceil(chunk.size / REMOTE_CHUNK_BYTES);
    if (entry.parts.size !== count) return null;
    const bytes = Buffer.concat(
      Array.from({ length: count }, (_, index) => entry.parts.get(index)!),
    );
    return { name: chunk.name, mimeType: chunk.mimeType, base64: bytes.toString("base64") };
  }
}
