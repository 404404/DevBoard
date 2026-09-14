import { expect, it } from "vitest";
import { describeRemotePermissions, RemotePermissionProfileSchema } from "./remote-permissions.js";

it("describes modern path entries, globs and special roots without omitting access scope", () => {
  const detail = describeRemotePermissions({
    fileSystem: {
      entries: [
        { path: { type: "special", value: { kind: "root" } }, access: "read" },
        {
          path: { type: "special", value: { kind: "project_roots", subpath: "reports" } },
          access: "write",
        },
        { path: { type: "glob_pattern", pattern: "/tmp/**/*.json" }, access: "write" },
        { path: { type: "path", path: "/private" }, access: "deny" },
      ],
      globScanMaxDepth: 3,
    },
  });
  expect(detail).toBe(
    "读取：整个文件系统\n写入：项目目录/reports\n写入：匹配 /tmp/**/*.json\n禁止访问：/private\n路径匹配扫描深度：3",
  );
});

it("fails closed for unknown permissions rather than silently stripping fields", () => {
  for (const value of [
    { network: { enabled: true, future: true } },
    { fileSystem: { write: ["/tmp"], future: true } },
    {
      fileSystem: {
        entries: [
          { path: { type: "special", value: { kind: "unknown", path: "/" } }, access: "write" },
        ],
      },
    },
    { future: true },
  ]) {
    expect(RemotePermissionProfileSchema.safeParse(value).success).toBe(false);
    expect(describeRemotePermissions(value)).toBeNull();
  }
});

it("distinguishes an empty grant from network denial", () => {
  expect(describeRemotePermissions({})).toBe("未申请额外权限");
  expect(describeRemotePermissions({ network: { enabled: false }, fileSystem: null })).toBe(
    "不允许访问网络",
  );
});
