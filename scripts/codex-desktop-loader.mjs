import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { connectDesktopSession } from "./codex-desktop-session.mjs";

function unavailable(message) {
  return Object.assign(new Error(message), { rpcError: { code: -32001, message } });
}

export async function openDesktopThread(threadId, { signal, timeoutMs = 2000 } = {}) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(threadId))
    throw unavailable("Codex 对话编号无效");
  if (process.platform !== "darwin") throw unavailable("自动加载 Codex 桌面对话需要 macOS");
  await new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/open",
      [`codex://threads/${threadId}`],
      { signal, timeout: timeoutMs },
      (error) => {
        if (error) reject(unavailable("无法打开 Codex 桌面对话"));
        else resolve();
      },
    );
  });
}

// Retry discovery/subscription only. No turn is ever submitted by this loader.
export async function loadDesktopSession({
  connector = connectDesktopSession,
  opener = openDesktopThread,
  timeoutMs = 20_000,
  retryMs = 250,
  signal,
  ...options
}) {
  const deadline = performance.now() + timeoutMs;
  const lifetime = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
  let opened = false;
  while (!lifetime.aborted) {
    try {
      return await connector({
        ...options,
        signal: lifetime,
        // Initialization, discovery, and snapshot each have a separate deadline.
        connectTimeoutMs: Math.max(
          1,
          Math.min(5000, Math.floor((deadline - performance.now()) / 3)),
        ),
      });
    } catch {
      if (lifetime.aborted) break;
      if (!opened) {
        try {
          await opener(options.threadId, {
            signal: lifetime,
            timeoutMs: Math.min(2000, Math.max(1, deadline - performance.now())),
          });
        } catch {
          throw unavailable("无法加载 Codex 桌面对话，请检查桌面应用");
        }
        opened = true;
      }
      try {
        await delay(retryMs, undefined, { signal: lifetime });
      } catch {
        break;
      }
    }
  }
  throw unavailable("Codex 桌面对话未能在限定时间内就绪，请检查桌面应用后重试");
}
