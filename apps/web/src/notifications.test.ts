import { afterEach, describe, expect, it, vi } from "vitest";
import { notifications, notify } from "./notifications";

afterEach(() => {
  for (const item of notifications.getSnapshot()) notifications.dismiss(item.id);
  vi.useRealTimers();
});

describe("operation notifications", () => {
  it("closes every tone after exactly one second", () => {
    vi.useFakeTimers();
    for (const tone of ["success", "error", "info"] as const) notify(tone, tone);
    expect(notifications.getSnapshot()).toHaveLength(3);
    vi.advanceTimersByTime(999);
    expect(notifications.getSnapshot()).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(notifications.getSnapshot()).toHaveLength(0);
  });

  it("gives repeated operations a fresh second without duplicate messages", () => {
    vi.useFakeTimers();
    notify("请求失败", "error", "restore");
    vi.advanceTimersByTime(800);
    notify("请求失败", "error", "restore");
    vi.advanceTimersByTime(200);
    expect(notifications.getSnapshot()).toHaveLength(1);
    vi.advanceTimersByTime(800);
    expect(notifications.getSnapshot()).toHaveLength(0);
  });
  it("keeps hovered notices visible and resumes their remaining time on leave", () => {
    vi.useFakeTimers();
    notify("请求失败", "error", "hover");
    vi.advanceTimersByTime(400);
    notifications.pause("hover");
    vi.advanceTimersByTime(5_000);
    expect(notifications.getSnapshot()).toHaveLength(1);
    notifications.resume("hover");
    vi.advanceTimersByTime(599);
    expect(notifications.getSnapshot()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(notifications.getSnapshot()).toHaveLength(0);
  });

  it("keeps a replacement paused until the pointer leaves", () => {
    vi.useFakeTimers();
    notify("第一次失败", "error", "hover");
    notifications.pause("hover");
    notify("再次失败", "error", "hover");
    vi.advanceTimersByTime(5_000);
    expect(notifications.getSnapshot()[0]?.message).toBe("再次失败");
    notifications.resume("hover");
    vi.advanceTimersByTime(1_000);
    expect(notifications.getSnapshot()).toHaveLength(0);
  });
});
