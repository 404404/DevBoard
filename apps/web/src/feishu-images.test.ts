import { afterEach, expect, it, vi } from "vitest";
import { chooseFeishuMedia, NativeMediaError } from "./feishu-images";

const auth = {
  appId: "cli_fixture",
  timestamp: 123456,
  nonceStr: "nonce",
  signature: "a".repeat(40),
  jsApiList: ["chooseMedia", "readFile"],
};
function fixture() {
  const readFile = vi.fn(
    (options: {
      position: number;
      length: number;
      success(result: { data: string }): void;
      fail(error: unknown): void;
    }) => options.success({ data: "iVBORw0KGgo=" }),
  );
  const chooseMedia = vi.fn((options: { success(result: unknown): void }) =>
    options.success({
      tempFiles: [{ tempFilePath: "ttfile://temp/photo.png", size: 8, type: "image" }],
    }),
  );
  const config = vi.fn((options: { onSuccess(): void }) => options.onSuccess());
  vi.stubGlobal("window", {
    location: { href: "https://tasks.example.test/?remote=1#test" },
    tt: { chooseMedia, getFileSystemManager: () => ({ readFile }) },
    h5sdk: { ready: (callback: () => void) => callback(), config },
  });
  const fetcher = vi.fn(async () => Response.json({ data: auth }));
  vi.stubGlobal("fetch", fetcher);
  return { readFile, chooseMedia, config, fetcher };
}
afterEach(() => {
  vi.unstubAllGlobals();
});
it("authenticates once, opens album only and converts the chosen image into an uploadable File", async () => {
  const f = fixture();
  const files = await chooseFeishuMedia(3);
  expect(f.fetcher).toHaveBeenCalledWith(
    expect.stringContaining("url=https%3A%2F%2Ftasks.example.test%2F%3Fremote%3D1"),
    expect.anything(),
  );
  expect(f.config).toHaveBeenCalledWith(expect.objectContaining(auth));
  expect(f.chooseMedia).toHaveBeenCalledWith(
    expect.objectContaining({
      sourceType: ["album"],
      mediaType: ["image", "video"],
      count: 3,
      sizeType: ["original"],
    }),
  );
  expect(f.readFile).toHaveBeenCalledWith(
    expect.objectContaining({ filePath: "ttfile://temp/photo.png", encoding: "base64" }),
  );
  expect(files[0]).toMatchObject({ name: "photo.png", type: "image/png", size: 8 });
  await chooseFeishuMedia(1);
  expect(f.config).toHaveBeenCalledTimes(1);
});
it("treats closing the native album as cancellation without reading or uploading anything", async () => {
  const f = fixture();
  f.chooseMedia.mockImplementationOnce((options) => {
    (options as unknown as { fail(error: unknown): void }).fail({
      errMsg: "chooseMedia:fail cancel",
    });
  });
  await expect(chooseFeishuMedia(1)).resolves.toEqual([]);
  expect(f.readFile).not.toHaveBeenCalled();
});
it("refuses oversized images before reading native file contents", async () => {
  const f = fixture();
  f.chooseMedia.mockImplementationOnce((options) =>
    options.success({
      tempFiles: [
        { tempFilePath: "ttfile://temp/large.jpg", size: 65 * 1024 * 1024, type: "image" },
      ],
    }),
  );
  await expect(chooseFeishuMedia(1)).rejects.toThrow("64 MiB");
  expect(f.readFile).not.toHaveBeenCalled();
});
it("does not attach files when canceled while the native read is pending", async () => {
  const f = fixture();
  let complete: ((result: { data: string }) => void) | undefined;
  f.readFile.mockImplementationOnce((options) => {
    complete = options.success;
  });
  const controller = new AbortController();
  const promise = chooseFeishuMedia(1, controller.signal);
  const check = expect(promise).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
  controller.abort();
  complete?.({ data: "iVBORw0KGgo=" });
  await check;
});

it("handles the documented image cancellation errno without showing an error", async () => {
  const f = fixture();
  f.chooseMedia.mockImplementationOnce((options) => {
    (options as unknown as { fail(error: unknown): void }).fail({
      errno: 1300001,
      errMsg: "chooseMedia:fail",
    });
  });
  await expect(chooseFeishuMedia(1)).resolves.toEqual([]);
  expect(f.readFile).not.toHaveBeenCalled();
});
it("allows another attempt after JSAPI authorization fails", async () => {
  const f = fixture();
  f.config.mockImplementationOnce((options) => {
    (options as unknown as { onFail(error: unknown): void }).onFail({ errCode: 333441 });
  });
  await expect(chooseFeishuMedia(1)).rejects.toThrow("授权失败");
  expect(f.chooseMedia).not.toHaveBeenCalled();
  await expect(chooseFeishuMedia(1)).resolves.toHaveLength(1);
  expect(f.config).toHaveBeenCalledTimes(2);
});

it("reads native videos using tempFilePath and preserves QuickTime MIME", async () => {
  const f = fixture();
  f.chooseMedia.mockImplementationOnce((options) =>
    options.success({
      tempFiles: [{ tempFilePath: "ttfile://temp/Recording.MOV", size: 8, type: "video" }],
    }),
  );
  await expect(chooseFeishuMedia(1)).resolves.toEqual([
    expect.objectContaining({ name: "Recording.MOV", type: "video/quicktime", size: 8 }),
  ]);
  expect(f.readFile).toHaveBeenCalledWith(
    expect.objectContaining({ filePath: "ttfile://temp/Recording.MOV" }),
  );
});
it("does not read anything when the native album returns an empty selection", async () => {
  const f = fixture();
  f.chooseMedia.mockImplementationOnce((options) => options.success({ tempFiles: [] }));
  await expect(chooseFeishuMedia(1)).resolves.toEqual([]);
  expect(f.readFile).not.toHaveBeenCalled();
});

it("reads recordings above Feishu's 10 MiB native limit in bounded slices without losing bytes", async () => {
  const f = fixture();
  const content = Buffer.alloc(10 * 1024 * 1024 + 800_123);
  for (let i = 0; i < content.length; i++) content[i] = i % 251;
  f.chooseMedia.mockImplementationOnce((options) =>
    options.success({
      tempFiles: [
        { tempFilePath: "ttfile://temp/Recording.MOV", size: content.length, type: "video" },
      ],
    }),
  );
  f.readFile.mockImplementation((options) => {
    if (!options.length || options.length > 10 * 1024 * 1024) {
      options.fail({ errMsg: "readFile:fail exceed max read size" });
      return;
    }
    options.success({
      data: content
        .subarray(options.position, options.position + options.length)
        .toString("base64"),
    });
  });
  const [file] = await chooseFeishuMedia(1);
  expect(Buffer.from(await file!.arrayBuffer()).equals(content)).toBe(true);
  expect(f.readFile).toHaveBeenCalledTimes(11);
  for (const [options] of f.readFile.mock.calls)
    expect(options.length).toBeLessThanOrEqual(1024 * 1024);
  expect(f.readFile.mock.calls.at(-1)![0]).toMatchObject({
    position: 10 * 1024 * 1024,
    length: 800_123,
  });
});

it("rejects a truncated native slice instead of uploading a damaged recording", async () => {
  const f = fixture();
  f.readFile.mockImplementationOnce((options) => options.success({ data: "AA==" }));
  await expect(chooseFeishuMedia(1)).rejects.toBeInstanceOf(NativeMediaError);
  expect(f.readFile).toHaveBeenCalledTimes(1);
});

it("stops reading further slices when canceled after a native callback", async () => {
  const f = fixture();
  const controller = new AbortController();
  f.chooseMedia.mockImplementationOnce((options) =>
    options.success({
      tempFiles: [
        { tempFilePath: "ttfile://temp/Recording.MOV", size: 3 * 1024 * 1024, type: "video" },
      ],
    }),
  );
  f.readFile.mockImplementationOnce((options) => {
    options.success({ data: Buffer.alloc(options.length).toString("base64") });
    controller.abort();
  });
  await expect(chooseFeishuMedia(1, controller.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(f.readFile).toHaveBeenCalledTimes(1);
});
