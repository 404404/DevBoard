import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function manageWebAccounts(dataDirectory, operation, input = {}, fetcher = fetch) {
  const routes = {
    list: { method: "GET", path: "/api/v1/local/web-accounts" },
    create: { method: "POST", path: "/api/v1/local/web-accounts" },
    update: {
      method: "PATCH",
      path: `/api/v1/local/web-accounts/${encodeURIComponent(input.id || "")}`,
    },
  };
  const route = routes[operation];
  if (!route || (operation === "update" && !/^[0-9a-f-]{36}$/i.test(input.id || "")))
    throw new Error("无效账号操作");
  let descriptor;
  try {
    descriptor = JSON.parse(await readFile(join(dataDirectory, "run/runtime.json"), "utf8"));
  } catch {
    throw new Error("请先启动本机服务，再管理 Web 账号。");
  }
  const base = new URL(descriptor.localAdminBaseUrl);
  if (
    base.protocol !== "http:" ||
    base.hostname !== "127.0.0.1" ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash ||
    typeof descriptor.capabilityToken !== "string"
  )
    throw new Error("本机服务地址无效");
  const body = { ...input };
  delete body.id;
  let response;
  try {
    response = await fetcher(new URL(route.path, base), {
      method: route.method,
      headers: {
        Authorization: `Bearer ${descriptor.capabilityToken}`,
        "Content-Type": "application/json",
      },
      ...(operation === "list" ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error(
      "无法联系本机服务，请确认服务正在运行。操作结果不确定时，请刷新账号列表后再判断。",
    );
  }
  if (!response.ok) {
    if (response.status === 409) throw new Error("账号名称已存在");
    if (response.status === 400) throw new Error("请检查账号格式、显示名称及密码（至少 8 位）。");
    throw new Error("账号操作失败，请刷新列表并检查本机服务。");
  }
  return (await response.json()).data;
}
