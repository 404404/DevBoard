import {
  existsSync,
  readFileSync,
  writeFileSync,
  lstatSync,
  renameSync,
  rmSync,
  chmodSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { updateFrpcLocalPort } from "./frpc-config.mjs";
export const DEFAULT_PORTS = Object.freeze({
  api: 58978,
  admin: 58979,
  bridge: 58980,
  caddy: 8443,
});
const localKeys = ["api", "admin", "bridge", "caddy"];
function validate(ports) {
  if (
    !ports ||
    typeof ports !== "object" ||
    Array.isArray(ports) ||
    Object.keys(ports).some((key) => !localKeys.includes(key))
  )
    throw new Error("端口设置仅允许修改四个本机服务端口");
  for (const key of Object.keys(DEFAULT_PORTS))
    if (!Number.isInteger(ports[key]) || ports[key] < 1 || ports[key] > 65535)
      throw new Error("端口必须为 1–65535 的整数");
  if (new Set(localKeys.map((key) => ports[key])).size !== 4)
    throw new Error("四个本机服务端口不能重复");
  return Object.fromEntries(Object.keys(DEFAULT_PORTS).map((key) => [key, ports[key]]));
}
function regular(path) {
  try {
    if (!lstatSync(path).isFile()) throw new Error("端口与 frpc 配置必须为普通文件");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
export function readLocalPorts(file) {
  regular(file);
  let stored = {};
  if (existsSync(file)) {
    try {
      stored = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      throw new Error("端口配置文件格式无效，请重新保存端口配置");
    }
  }
  if (
    !stored ||
    typeof stored !== "object" ||
    Array.isArray(stored) ||
    Object.keys(stored).some((key) => !localKeys.includes(key))
  )
    throw new Error("端口配置文件格式无效");
  const values = validate({ ...DEFAULT_PORTS, ...stored });
  return Object.fromEntries(localKeys.map((key) => [key, values[key]]));
}
export async function savePorts(file, tunnel, values, verifyFrpc) {
  const ports = validate(values);
  regular(file);
  regular(tunnel);
  let previousCaddyPort;
  try {
    const previous = readLocalPorts(file);
    if (localKeys.every((key) => previous[key] === ports[key])) return { ports, changed: false };
    previousCaddyPort = previous.caddy;
  } catch {
    // A complete explicit save can repair invalid stored values. Without a
    // trusted old port, the tunnel selector must require a unique local proxy.
  }
  const frpc = existsSync(tunnel) ? readFileSync(tunnel, "utf8") : "";
  const updated = updateFrpcLocalPort(frpc, previousCaddyPort, ports.caddy);
  const changes = [
    {
      path: file,
      content:
        JSON.stringify(Object.fromEntries(localKeys.map((key) => [key, ports[key]])), null, 2) +
        "\n",
    },
    { path: tunnel, content: updated.content },
  ];
  const staged = [],
    written = [];
  try {
    for (const change of changes) {
      const temp = join(dirname(change.path), `.codexboard-ports-${randomUUID()}.toml`);
      const old = existsSync(change.path) ? readFileSync(change.path) : null;
      const mode = old === null ? 0o600 : lstatSync(change.path).mode & 0o777;
      writeFileSync(temp, change.content, { flag: "wx", mode: 0o600 });
      staged.push({ ...change, temp, old, mode });
    }
    if (updated.configured) {
      try {
        await verifyFrpc(staged[1].temp);
      } catch {
        throw new Error("frpc 端口配置验证失败，请检查隧道配置");
      }
    }
    for (const item of staged) {
      renameSync(item.temp, item.path);
      written.push(item);
    }
  } catch (error) {
    for (const item of written.reverse()) {
      if (item.old === null) rmSync(item.path, { force: true });
      else {
        writeFileSync(item.path, item.old);
        chmodSync(item.path, item.mode);
      }
    }
    throw error;
  } finally {
    for (const item of staged) rmSync(item.temp, { force: true });
  }
  return { ports, changed: true };
}
