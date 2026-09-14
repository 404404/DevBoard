import { expect, it } from "vitest";
import { ApiError } from "./api";
import { userErrorMessage } from "./user-error";

it("converts network failures without exposing browser errors", () => {
  expect(userErrorMessage(new TypeError("Load failed"))).toBe("网络连接中断，请检查网络后重试。");
});
it("never exposes arbitrary server or runtime messages", () => {
  for (const error of [
    new Error("secret /private/path"),
    new ApiError(500, "INTERNAL_ERROR", "数据库密码错误"),
    "raw failure",
  ]) {
    expect(userErrorMessage(error, "任务保存失败，请重试。")).toBe("任务保存失败，请重试。");
  }
});
it("explains actionable status codes using controlled copy", () => {
  expect(userErrorMessage(new ApiError(403, "FORBIDDEN", "raw"))).toBe(
    "当前操作未获允许，请刷新页面后重试。",
  );
  expect(userErrorMessage(new ApiError(409, "CONFLICT", "raw"))).toBe("数据已更新，请刷新后重试。");
});
