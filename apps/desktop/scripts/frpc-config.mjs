import { parse, stringify } from "smol-toml";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";

export function isPublicIpv4(value) {
  if (typeof value !== "string" || isIP(value) !== 4) return false;
  const [a, b, c] = value.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}

export function isSupportedOrigin(url) {
  if (url.username || url.password || !["http:", "https:"].includes(url.protocol)) return false;
  if (isIP(url.hostname)) return url.protocol === "http:" && isPublicIpv4(url.hostname);
  try {
    readDomain(url.hostname);
    return true;
  } catch {
    return false;
  }
}

function readDomain(value) {
  const labels = typeof value === "string" ? value.split(".") : [];
  if (
    typeof value !== "string" ||
    value.length > 253 ||
    labels.length < 2 ||
    labels.some(
      (label) => label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
    ) ||
    !/[a-z]/i.test(labels.at(-1)) ||
    isIP(value) ||
    !domainToASCII(value)
  ) {
    throw new Error(
      "frpc.toml 的 customDomains 必须是一个完整有效的公网域名；请勿填写通配符、IP、协议、端口或路径。国际化域名请使用 Punycode 格式。",
    );
  }
  return value.toLowerCase();
}

/** Derive the app's single public HTTPS origin without reading files or starting frpc. */
function readFrpcProxy(text, localPort) {
  if (typeof text !== "string" || !text.trim()) {
    throw new Error(`请填写 frpc.toml，并配置指向本机 ${localPort} 端口的 HTTPS 代理。`);
  }
  let configuration;
  try {
    configuration = parse(text, { integersAsBigInt: "asNeeded" });
  } catch {
    // Parser errors can contain credentials from the source line.
    throw new Error("frpc.toml 的 TOML 格式无效，请检查引号、数组和配置节格式。");
  }
  if (
    configuration.includes !== undefined &&
    (!Array.isArray(configuration.includes) || configuration.includes.length)
  ) {
    throw new Error(
      "无法从 includes 引用文件推导域名，请将代理配置直接写入 frpc.toml 并移除 includes。",
    );
  }
  if (configuration.store?.path) {
    throw new Error(
      "无法从 store 外部配置推导域名，请将代理配置直接写入 frpc.toml 并移除 store.path。",
    );
  }
  const start = configuration.start ?? [];
  if (!Array.isArray(start) || start.some((name) => typeof name !== "string")) {
    throw new Error("frpc.toml 的 start 必须是代理名称数组，请检查启用代理的配置。");
  }
  const proxies = configuration.proxies ?? [];
  if (
    !Array.isArray(proxies) ||
    proxies.some((proxy) => !proxy || typeof proxy !== "object" || Array.isArray(proxy))
  ) {
    throw new Error("frpc.toml 的 proxies 格式无效，请使用 [[proxies]] 配置代理。");
  }
  if (proxies.some((proxy) => proxy.enabled !== undefined && typeof proxy.enabled !== "boolean")) {
    throw new Error("frpc.toml 代理的 enabled 必须是 true 或 false，请检查代理启用设置。");
  }
  const candidates = proxies.filter((proxy) => {
    const localIP = proxy.localIP === "" ? "127.0.0.1" : (proxy.localIP ?? "127.0.0.1");
    return (
      proxy.enabled !== false &&
      (!start.length || start.includes(proxy.name)) &&
      ["http", "https", "tcp"].includes(proxy.type) &&
      (localIP === "127.0.0.1" || localIP === "localhost") &&
      (localPort === undefined || proxy.localPort === localPort)
    );
  });
  if (!candidates.length) {
    throw new Error(
      `frpc.toml 中没有已启用且指向本机 127.0.0.1（或 localhost）${localPort === undefined ? "" : `:${localPort}`} 的 HTTP、HTTPS 或 TCP 代理；请检查 type、localIP、localPort、start 和 enabled。`,
    );
  }
  if (candidates.length !== 1) {
    throw new Error(
      `frpc.toml 中有多个指向本机${localPort === undefined ? "" : ` ${localPort}`} 的 HTTP/HTTPS/TCP 代理，请仅启用一个以确定唯一公网入口。`,
    );
  }
  const candidate = candidates[0];
  if (
    !Number.isInteger(candidate.localPort) ||
    candidate.localPort < 1 ||
    candidate.localPort > 65535
  ) {
    throw new Error("frpc.toml 本机代理的 localPort 必须是 1–65535 的整数");
  }
  if (candidate.plugin?.type) {
    throw new Error(
      `所选 HTTP/HTTPS 代理使用了 plugin 插件，请改为直接转发到本机 ${candidate.localPort} 端口。`,
    );
  }
  if (candidate.type === "tcp") {
    if (!isPublicIpv4(configuration.serverAddr)) {
      throw new Error(
        "frpc.toml 的 TCP 入口要求 serverAddr 为规范公网 IPv4 地址；此测试模式不推测域名对应的入口 IP。",
      );
    }
    if (
      !Number.isInteger(candidate.remotePort) ||
      candidate.remotePort < 1 ||
      candidate.remotePort > 65535
    ) {
      throw new Error("frpc.toml TCP 代理的 remotePort 必须为 1–65535 的整数");
    }
    if (candidate.customDomains !== undefined || candidate.subdomain !== undefined) {
      throw new Error("frpc.toml TCP 代理无需 customDomains 或 subdomain，请移除这些域名字段。");
    }
    const origin = new URL(`http://${configuration.serverAddr}:${candidate.remotePort}`).origin;
    return { configuration, candidate, origin };
  }
  if (candidate.subdomain) {
    throw new Error(
      "subdomain 依赖隧道服务器配置，无法确定完整域名；请移除 subdomain，并在 customDomains 中填写一个完整公网域名。",
    );
  }
  if (!Array.isArray(candidate.customDomains) || candidate.customDomains.length !== 1) {
    throw new Error("请在所选 HTTP/HTTPS 代理的 customDomains 中配置且仅配置一个完整公网域名。");
  }
  return {
    configuration,
    candidate,
    origin: `${candidate.type}://${readDomain(candidate.customDomains[0])}`,
  };
}

export function readFrpcOrigin(text, localPort = 8443) {
  return readFrpcProxy(text, localPort).origin;
}
function parsePortDocument(text) {
  try {
    return parse(text || "", { integersAsBigInt: "asNeeded" });
  } catch {
    throw new Error("frpc.toml 格式无效，请先修正隧道配置");
  }
}
export function updateFrpcLocalPort(text, previousLocalPort, localPort) {
  let configuration = parsePortDocument(text);
  if (configuration.proxies?.length) {
    const selected = readFrpcProxy(text, previousLocalPort);
    configuration = selected.configuration;
    selected.candidate.localPort = localPort;
  } else if (configuration.includes?.length || configuration.store?.path) {
    throw new Error("frpc 端口不能修改外部代理配置，请将代理放在当前 frpc.toml 中");
  }
  return { content: stringify(configuration), configured: Boolean(configuration.proxies?.length) };
}

/** Read the DNS target without exposing credentials or guessing a server IP. */
export function readFrpcDnsTarget(text) {
  try {
    const config = parse(text);
    const value = config.serverAddr;
    if (typeof value !== "string" || !value) return {};
    const version = isIP(value);
    if (version) return { dnsTarget: value, dnsRecordType: version === 4 ? "A" : "AAAA" };
    const domain = readDomain(value);
    if (
      Array.isArray(config.proxies) &&
      config.proxies.some(
        (proxy) =>
          Array.isArray(proxy?.customDomains) &&
          proxy.customDomains.some(
            (name) => typeof name === "string" && name.toLowerCase() === domain,
          ),
      )
    )
      return {};
    return { dnsTarget: domain, dnsRecordType: "CNAME" };
  } catch {
    return {};
  }
}
