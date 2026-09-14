import test from "node:test";
import assert from "node:assert/strict";
import { readFrpcOrigin } from "./frpc-config.mjs";
import { renderCaddyfile } from "./runtime.mjs";
const tcp =
  'serverAddr="8.8.8.8"\n[[proxies]]\nname="board"\ntype="tcp"\nlocalPort=8443\nremotePort=18443';
const vhost = (type) =>
  `[[proxies]]\nname="board"\ntype="${type}"\nlocalPort=8443\ncustomDomains=["board.example.com"]`;
test("only frpc determines origin; manual options cannot override it", () => {
  assert.equal(
    readFrpcOrigin(tcp, 8443, { publicDomain: "ignored.example.com", publicPort: "9999" }),
    "http://8.8.8.8:18443",
  );
  assert.equal(
    readFrpcOrigin(vhost("http"), 8443, { publicPort: "8080" }),
    "http://board.example.com",
  );
  assert.equal(
    readFrpcOrigin(vhost("https"), 8443, { publicPort: "8443" }),
    "https://board.example.com",
  );
});
test("type selects Caddy HTTP or automatic HTTPS service configuration", () => {
  const ports = { api: 58978, caddy: 8443 };
  for (const text of [tcp, vhost("http")]) {
    const config = renderCaddyfile(new URL(readFrpcOrigin(text)), ports);
    assert.match(config, /auto_https off/);
    assert.match(config, /X-Forwarded-Proto http/);
    assert.doesNotMatch(config, /issuer acme/);
  }
  const config = renderCaddyfile(new URL(readFrpcOrigin(vhost("https"))), ports);
  assert.match(config, /issuer acme/);
  assert.match(config, /X-Forwarded-Proto https/);
});
