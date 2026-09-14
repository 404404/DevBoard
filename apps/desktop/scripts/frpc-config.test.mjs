import test from "node:test";
import assert from "node:assert/strict";
import { readFrpcOrigin } from "./frpc-config.mjs";

const proxy = (extra = "", name = "taskboard") => `
[[proxies]]
name = "${name}"
type = "https"
localIP = "127.0.0.1"
localPort = 8443
customDomains = ["tasks.example.com"]
${extra}
`;

test("reads an HTTPS origin from full TOML with quoted keys and multiline arrays", () => {
  assert.equal(
    readFrpcOrigin(`
serverAddr = 'gateway.example.com'
auth.token = 'fixture-token # not a comment'
# customDomains = ["wrong.example.com"]
[["proxies"]]
'name' = 'taskboard'
type = 'https'
localIP = 'localhost'
localPort = 8_443
"customDomains" = [
  "Tasks.Example.com", # real domain
]
`),
    "https://tasks.example.com",
  );
});

test("ignores unrelated forwarding rules and uses the frpc loopback default", () => {
  const otherProxy = proxy("", "other").replace("localPort = 8443", "localPort = 9443");
  assert.equal(
    readFrpcOrigin(otherProxy + proxy().replace('localIP = "127.0.0.1"\n', "")),
    "https://tasks.example.com",
  );
});

test("respects start and enabled filtering without treating empty start as disabled", () => {
  const otherProxy = proxy("", "other").replace("tasks.example.com", "other.example.com");
  assert.equal(
    readFrpcOrigin('start = ["taskboard"]\n' + otherProxy + proxy()),
    "https://tasks.example.com",
  );
  assert.equal(readFrpcOrigin("start = []\n" + proxy()), "https://tasks.example.com");
  assert.equal(
    readFrpcOrigin(proxy("enabled = false", "disabled") + proxy("enabled = true")),
    "https://tasks.example.com",
  );
  assert.throws(() => readFrpcOrigin('start = ["unselected"]\n' + proxy()), /启用|start/);
  assert.throws(() => readFrpcOrigin(proxy("enabled = false")), /启用/);
});

test("rejects ambiguous proxies and multiple domains even when repeated", () => {
  assert.throws(() => readFrpcOrigin(proxy() + proxy("", "other")), /多个|唯一/);
  for (const domains of [
    '["tasks.example.com", "other.example.com"]',
    '["tasks.example.com", "tasks.example.com"]',
  ]) {
    assert.throws(
      () => readFrpcOrigin(proxy().replace('["tasks.example.com"]', domains)),
      /一个|唯一/,
    );
  }
});

test("does not infer a public HTTPS origin from missing, HTTP, TCP or wrong targets", () => {
  for (const content of [
    "",
    "serverPort = 7000",
    proxy().replace('type = "https"', 'type = "udp"'),
    proxy().replace('type = "https"', 'type = "tcp"'),
    proxy().replace("localPort = 8443", "localPort = 47823"),
    proxy().replace('localIP = "127.0.0.1"', 'localIP = "192.168.1.4"'),
    proxy().replace('localIP = "127.0.0.1"', 'localIP = "0.0.0.0"'),
  ]) {
    assert.throws(() => readFrpcOrigin(content), /frpc|HTTPS|8443/);
  }
});

test("requires one explicit custom domain instead of a server-dependent subdomain", () => {
  for (const fields of ["", "customDomains = []", 'subdomain = "tasks"']) {
    assert.throws(
      () => readFrpcOrigin(proxy().replace('customDomains = ["tasks.example.com"]', fields)),
      /customDomains|域名/,
    );
  }
  assert.throws(() => readFrpcOrigin(proxy('subdomain = "additional"')), /subdomain|域名/);
});

test("rejects wildcard, URL, IP and malformed domain values without echoing them", () => {
  for (const domain of [
    "*.example.com",
    "https://tasks.example.com",
    "tasks.example.com/path",
    "user@tasks.example.com",
    "tasks.example.com:443",
    "tasks.example.com?query=1",
    "tasks.example.com#fragment",
    "tasks.example.com\\evil",
    "tasks.example.com\n",
    "127.0.0.1",
    "[::1]",
    "localhost",
    "tasks..example.com",
    "-tasks.example.com",
    "tasks-.example.com",
    "tasks_example.com",
    "tasks.example.com.",
    " tasks.example.com",
    "任务.example.com",
    "xn--badpunycode.example.com",
    "x".repeat(64) + ".example.com",
    "a.".repeat(125) + "example.com",
  ]) {
    assert.throws(
      () => readFrpcOrigin(proxy().replace('["tasks.example.com"]', JSON.stringify([domain]))),
      (error) => {
        assert.match(error.message, /域名|customDomains/);
        assert.equal(error.message.includes(domain), false);
        return true;
      },
    );
  }
  assert.equal(
    readFrpcOrigin(proxy().replace("tasks.example.com", "xn--fiqs8s.example.com")),
    "https://xn--fiqs8s.example.com",
  );
});

test("rejects externally sourced proxies or plugin forwarding that cannot be resolved from the text", () => {
  for (const content of [
    'includes = ["other.toml"]\n' + proxy(),
    'store.path = "external.json"\n' + proxy(),
    proxy('plugin.type = "https2http"'),
  ]) {
    assert.throws(() => readFrpcOrigin(content), /includes|store|plugin|插件/);
  }
  assert.equal(readFrpcOrigin("includes = []\n" + proxy()), "https://tasks.example.com");
});

test("redacts TOML parser errors and rejects malformed selection fields", () => {
  assert.throws(
    () => readFrpcOrigin('auth.token = "fixture-private-secret\n'),
    (error) => {
      assert.match(error.message, /TOML|格式/);
      assert.equal(error.message.includes("fixture-private-secret"), false);
      assert.equal(error.cause, undefined);
      return true;
    },
  );
  for (const content of [
    'start = "taskboard"\n' + proxy(),
    "start = [1]\n" + proxy(),
    "proxies = [1]",
    "proxies = {}",
    proxy('enabled = "false"'),
    proxy().replace("localPort = 8443", 'localPort = "8443"'),
    proxy().replace('localIP = "127.0.0.1"', "localIP = false"),
    proxy().replace('["tasks.example.com"]', '"tasks.example.com"'),
  ]) {
    assert.throws(() => readFrpcOrigin(content), /frpc|start|proxies|enabled|8443|customDomains/);
  }
});

const tcp = (server = "8.8.8.8", remote = "52480") => `serverAddr = "${server}"
[[proxies]]
name = "http-test"
type = "tcp"
localIP = "127.0.0.1"
localPort = 8443
remotePort = ${remote}
`;
test("derives HTTP origin from a unique TCP proxy without a separate public URL", () => {
  assert.equal(readFrpcOrigin(tcp()), "http://8.8.8.8:52480");
  assert.equal(
    readFrpcOrigin(tcp().replace('localIP = "127.0.0.1"', 'localIP = "localhost"')),
    "http://8.8.8.8:52480",
  );
});
test("TCP requires public literal IPv4 and a valid remote port", () => {
  for (const ip of [
    "gateway.example.com",
    "127.0.0.1",
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "169.254.1.1",
    "172.16.1.1",
    "192.168.1.2",
    "192.0.2.1",
    "198.18.0.1",
    "203.0.113.1",
    "224.1.1.1",
    "8.8.8.8\n",
    "::1",
  ]) {
    assert.throws(() => readFrpcOrigin(tcp(ip)), /IPv4|TOML/);
  }
  for (const port of ["0", "65536", '"52480"', "1.5"])
    assert.throws(() => readFrpcOrigin(tcp(undefined, port)), /remotePort/);
});
test("rejects mixed proxy ambiguity and TCP domain/plugin fields", () => {
  assert.throws(() => readFrpcOrigin(tcp() + proxy()), /多个|唯一/);
  assert.throws(
    () => readFrpcOrigin(tcp() + 'customDomains = ["tasks.example.com"]'),
    /customDomains/,
  );
  assert.throws(() => readFrpcOrigin(tcp() + 'plugin.type = "http_proxy"'), /plugin|插件/);
});
test("TCP local-port edits keep its public remote port and origin", async () => {
  const { updateFrpcLocalPort } = await import("./frpc-config.mjs");
  const updated = updateFrpcLocalPort(tcp(), 8443, 58981);
  assert.equal(readFrpcOrigin(updated.content, 58981), "http://8.8.8.8:52480");
  assert.throws(() => readFrpcOrigin(updated.content, 8443));
});
