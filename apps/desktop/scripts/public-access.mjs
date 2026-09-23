import { isIP } from "node:net";
import { isSupportedOrigin } from "./frpc-config.mjs";

export const PUBLIC_ACCESS_MODES = Object.freeze([
  "builtin-frp",
  "external-reverse-proxy",
  "local",
]);

const DEFAULT_LISTEN_ADDRESS = "127.0.0.1";

function normalizeListenAddress(value) {
  const address = typeof value === "string" && value.trim() ? value.trim() : DEFAULT_LISTEN_ADDRESS;
  if (
    address.length > 253 ||
    /[\r\n\0\s]/.test(address) ||
    (address !== "localhost" && isIP(address) === 0)
  ) {
    throw new Error("Caddy 监听地址必须是 localhost 或有效的 IP 地址");
  }
  return address;
}

export function normalizePublicAccessMode(value) {
  return PUBLIC_ACCESS_MODES.includes(value) ? value : "builtin-frp";
}

export function parsePublicAccessDocument(text) {
  if (typeof text !== "string" || !text.trim()) {
    return { mode: "builtin-frp", origin: "", listenAddress: DEFAULT_LISTEN_ADDRESS };
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("公共访问配置文件格式无效");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("公共访问配置文件格式无效");
  }
  const mode = normalizePublicAccessMode(value.mode);
  const origin = typeof value.origin === "string" ? value.origin.trim() : "";
  if (origin.length > 2048 || /[\r\n\0]/.test(origin)) {
    throw new Error("外部反向代理 Origin 无效");
  }
  return { mode, origin, listenAddress: normalizeListenAddress(value.listenAddress) };
}

export function serializePublicAccessDocument(value) {
  const mode = normalizePublicAccessMode(value?.mode);
  const origin = typeof value?.origin === "string" ? value.origin.trim() : "";
  if (origin.length > 2048 || /[\r\n\0]/.test(origin)) {
    throw new Error("外部反向代理 Origin 无效");
  }
  return (
    JSON.stringify(
      { mode, origin, listenAddress: normalizeListenAddress(value?.listenAddress) },
      null,
      2,
    ) + "\n"
  );
}

export function resolvePublicAccess({ mode, origin, frpcOrigin, listenAddress }) {
  const normalized = normalizePublicAccessMode(mode);
  const resolvedListenAddress = normalizeListenAddress(listenAddress);
  if (normalized === "local") {
    return {
      mode: normalized,
      origin: "",
      usesBuiltinProxy: false,
      usesCaddy: false,
      requiresPublicOrigin: false,
      listenAddress: resolvedListenAddress,
    };
  }
  if (normalized === "external-reverse-proxy") {
    let url;
    try {
      url = new URL(String(origin || ""));
    } catch {
      throw new Error("外部反向代理模式需要填写有效的 Origin");
    }
    if (!isSupportedOrigin(url)) {
      throw new Error("外部反向代理 Origin 必须是 HTTP/HTTPS 域名或 HTTP 公网 IPv4");
    }
    return {
      mode: normalized,
      origin: url.origin,
      usesBuiltinProxy: false,
      usesCaddy: true,
      requiresPublicOrigin: true,
      listenAddress: resolvedListenAddress,
    };
  }
  if (typeof frpcOrigin !== "string" || !frpcOrigin) {
    throw new Error("内置 frp 模式需要有效的 frpc 公网入口");
  }
  return {
    mode: normalized,
    origin: frpcOrigin,
    usesBuiltinProxy: true,
    usesCaddy: true,
    requiresPublicOrigin: true,
    listenAddress: resolvedListenAddress,
  };
}
