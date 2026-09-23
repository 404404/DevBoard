import test from "node:test";
import assert from "node:assert/strict";
import {
  parsePublicAccessDocument,
  resolvePublicAccess,
  serializePublicAccessDocument,
} from "./public-access.mjs";

test("keeps built-in frp as the backwards-compatible default", () => {
  const resolved = resolvePublicAccess({
    mode: "builtin-frp",
    frpcOrigin: "https://devboard.example.com",
  });
  assert.equal(resolved.origin, "https://devboard.example.com");
  assert.equal(resolved.usesBuiltinProxy, true);
  assert.equal(resolved.usesCaddy, true);
  assert.equal(resolved.listenAddress, "127.0.0.1");
});

test("external reverse proxy accepts an explicit public origin without frpc", () => {
  const document = parsePublicAccessDocument(
    serializePublicAccessDocument({
      mode: "external-reverse-proxy",
      origin: "https://devboard.example.com/",
      listenAddress: "192.168.1.20",
    }),
  );
  const resolved = resolvePublicAccess(document);
  assert.equal(resolved.origin, "https://devboard.example.com");
  assert.equal(resolved.usesBuiltinProxy, false);
  assert.equal(resolved.usesCaddy, true);
  assert.equal(resolved.listenAddress, "192.168.1.20");
});

test("local mode has no public origin and does not start a proxy", () => {
  const resolved = resolvePublicAccess({ mode: "local", origin: "ignored" });
  assert.equal(resolved.origin, "");
  assert.equal(resolved.usesBuiltinProxy, false);
  assert.equal(resolved.usesCaddy, false);
  assert.equal(resolved.requiresPublicOrigin, false);
});

test("rejects unsafe external origins and listener addresses", () => {
  assert.throws(
    () => resolvePublicAccess({ mode: "external-reverse-proxy", origin: "http://127.0.0.1:8080" }),
    /HTTP\/HTTPS/,
  );
  assert.throws(
    () =>
      resolvePublicAccess({
        mode: "external-reverse-proxy",
        origin: "https://devboard.example.com",
        listenAddress: "127.0.0.1; rm -rf /",
      }),
    /监听地址/,
  );
});
