import { FeishuJsapiConfigSchema, REMOTE_UPLOAD_MAX_BYTES } from "@lark-taskboard/contracts";
import { z } from "zod";
import { apiRequest } from "./api";
import { loadFeishuH5Sdk } from "./feishu";

type Sdk = Awaited<ReturnType<typeof loadFeishuH5Sdk>>;
let configured: { sdk: Sdk["h5sdk"]; url: string; promise: Promise<Sdk> } | undefined;
const selectionSchema = z.object({
  tempFiles: z
    .array(
      z.object({
        tempFilePath: z.string().min(1),
        size: z.number().int().positive(),
        type: z.enum(["image", "video"]),
      }),
    )
    .max(8),
});
const maxBytes = REMOTE_UPLOAD_MAX_BYTES;
const nativeReadChunkBytes = 1024 * 1024;

// Only application-authored messages may be shown in the upload notice.
export class NativeMediaError extends Error {}
export function isFeishuClient() {
  return /\b(?:Lark|Feishu)\//i.test(navigator.userAgent);
}

async function configuredSdk(): Promise<Sdk> {
  const sdk = await loadFeishuH5Sdk();
  const url = window.location.href.split("#")[0]!;
  if (configured?.sdk === sdk.h5sdk && configured.url === url) return configured.promise;
  const promise = new Promise<Sdk>((resolve, reject) => {
    let expired = false;
    const timeout = setTimeout(() => {
      expired = true;
      reject(new NativeMediaError("飞书相册功能初始化超时，请重试"));
    }, 20_000);
    const fail = () => {
      clearTimeout(timeout);
      reject(new NativeMediaError("飞书相册功能授权失败，请重试"));
    };
    sdk.h5sdk.ready(() => {
      void apiRequest(
        `/api/v1/auth/feishu/jsapi-config?${new URLSearchParams({ url })}`,
        z.object({ data: FeishuJsapiConfigSchema }),
      )
        .then(({ data }) => {
          if (expired) return;
          if (!sdk.h5sdk.config || !sdk.client.chooseMedia || !sdk.client.getFileSystemManager) {
            clearTimeout(timeout);
            reject(new NativeMediaError("当前飞书版本不支持相册媒体选择，请更新飞书客户端"));
            return;
          }
          sdk.h5sdk.config({
            ...data,
            onSuccess: () => {
              clearTimeout(timeout);
              resolve(sdk);
            },
            onFail: fail,
          });
        })
        .catch(fail);
    });
  });
  configured = { sdk: sdk.h5sdk, url, promise };
  try {
    return await promise;
  } catch (error) {
    if (configured?.promise === promise) configured = undefined;
    throw error;
  }
}

function nativeResult<T>(
  run: (success: (result: T) => void, fail: (error: unknown) => void) => void,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const clean = () => signal?.removeEventListener("abort", abort);
    const success = (result: T) => {
      clean();
      resolve(result);
    };
    const fail = (error: unknown) => {
      clean();
      reject(error);
    };
    const abort = () => fail(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      run(success, fail);
    } catch (error) {
      fail(error);
    }
  });
}

export async function chooseFeishuMedia(count: number, signal?: AbortSignal): Promise<File[]> {
  if (count < 1) throw new NativeMediaError("最多添加 8 个附件");
  const sdk = await nativeResult<Sdk>((resolve, reject) => {
    void configuredSdk().then(resolve, reject);
  }, signal);
  let selected: z.infer<typeof selectionSchema>;
  try {
    const result = await nativeResult<unknown>(
      (success, fail) =>
        sdk.client.chooseMedia!({
          sourceType: ["album"],
          mediaType: ["image", "video"],
          count: Math.min(8, count),
          sizeType: ["original"],
          success,
          fail,
        }),
      signal,
    );
    selected = selectionSchema.parse(result);
  } catch (error) {
    signal?.throwIfAborted();
    const detail = error as { errMsg?: unknown; errno?: unknown };
    if (
      detail?.errno === 1300001 ||
      (typeof detail?.errMsg === "string" && /\bcancel(?:led|ed)?\b/i.test(detail.errMsg))
    )
      return [];
    throw new NativeMediaError("无法打开飞书相册，请重试", { cause: error });
  }
  if (selected.tempFiles.length > count) throw new NativeMediaError("最多添加 8 个附件");
  if (selected.tempFiles.some((file) => file.size > maxBytes))
    throw new NativeMediaError("单个文件须为 1 字节至 64 MiB");
  const files: File[] = [];
  const manager = sdk.client.getFileSystemManager!();
  for (const selectedFile of selected.tempFiles) {
    signal?.throwIfAborted();
    try {
      const parts: Uint8Array<ArrayBuffer>[] = [];
      for (let position = 0; position < selectedFile.size;) {
        signal?.throwIfAborted();
        // Feishu readFile has a 10 MiB per-call limit; its docs recommend 1 MiB slices.
        const length = Math.min(nativeReadChunkBytes, selectedFile.size - position);
        const { data } = await nativeResult<{ data: string }>(
          (success, fail) =>
            manager.readFile({
              filePath: selectedFile.tempFilePath,
              encoding: "base64",
              position,
              length,
              success,
              fail,
            }),
          signal,
        );
        signal?.throwIfAborted();
        if (typeof data !== "string" || data.length > Math.ceil(length / 3) * 4)
          throw new Error("Invalid native read size");
        const decoded = atob(data);
        if (decoded.length !== length) throw new Error("Incomplete native read");
        const bytes = new Uint8Array(length);
        for (let index = 0; index < length; index++) bytes[index] = decoded.charCodeAt(index);
        parts.push(bytes);
        position += length;
      }
      const name = selectedFile.tempFilePath.split("/").pop() || "photo.jpg";
      const extension = name.split(".").pop()?.toLowerCase();
      const type =
        (
          {
            jpg: "image/jpeg",
            jpeg: "image/jpeg",
            png: "image/png",
            gif: "image/gif",
            webp: "image/webp",
            heic: "image/heic",
            heif: "image/heif",
            mov: "video/quicktime",
            mp4: "video/mp4",
            m4v: "video/x-m4v",
            webm: "video/webm",
          } as Record<string, string>
        )[extension ?? ""] ?? "application/octet-stream";
      signal?.throwIfAborted();
      files.push(new File(parts, name, { type }));
    } catch {
      signal?.throwIfAborted();
      throw new NativeMediaError("无法读取选中的媒体文件，请重新选择");
    }
  }
  return files;
}
