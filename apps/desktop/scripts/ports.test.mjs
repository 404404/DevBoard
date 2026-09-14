import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PORTS, readLocalPorts, savePorts } from "./ports.mjs";
import { parse } from "smol-toml";
const frpc =
  'serverPort = 7000\nauth.token = "private-fixture"\n[[proxies]]\nname = "board"\ntype = "https"\nlocalIP = "127.0.0.1"\nlocalPort = 8443\ncustomDomains = ["tasks.example.com"]\n';
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "lark-ports-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "ports.json"),
    tunnel = join(dir, "frpc.toml");
  writeFileSync(tunnel, frpc);
  return { file, tunnel };
}
test("default ports are generated without extra user configuration", (t) => {
  const f = fixture(t);
  assert.deepEqual(readLocalPorts(f.file), {
    api: 58978,
    admin: 58979,
    bridge: 58980,
    caddy: 8443,
  });
});
test("port save updates frpc local port while preserving its server port and credentials", async (t) => {
  const f = fixture(t);
  writeFileSync(f.tunnel, frpc.replace("serverPort = 7000", "serverPort = 7100"));
  const changed = { api: 48023, admin: 48024, bridge: 48025, caddy: 9443 };
  const result = await savePorts(f.file, f.tunnel, changed, async () => {});
  assert.deepEqual(result, { ports: changed, changed: true });
  assert.deepEqual(readLocalPorts(f.file), changed);
  const config = parse(readFileSync(f.tunnel, "utf8"));
  assert.equal(config.auth.token, "private-fixture");
  assert.equal(config.proxies[0].localPort, 9443);
  assert.equal(config.serverPort, 7100);
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(f.file, "utf8")), "frpcServer"), false);
});
test("rejects duplicate local ports, nonintegers and invalid ranges without writing", async (t) => {
  for (const change of [
    { api: DEFAULT_PORTS.admin },
    { bridge: 0 },
    { caddy: 65536 },
    { admin: 2.5 },
  ]) {
    const f = fixture(t);
    await assert.rejects(
      savePorts(f.file, f.tunnel, { ...DEFAULT_PORTS, ...change }, async () => {}),
      /端口/,
    );
    assert.equal(readFileSync(f.tunnel, "utf8"), frpc);
  }
});
test("port settings reject changes to the frpc server port without writing files", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    savePorts(f.file, f.tunnel, { ...DEFAULT_PORTS, frpcServer: 7100 }, async () => {}),
    /端口/,
  );
  assert.equal(readFileSync(f.tunnel, "utf8"), frpc);
  assert.deepEqual(readLocalPorts(f.file), DEFAULT_PORTS);
});
test("saving local ports does not insert an omitted frpc server port", async (t) => {
  const f = fixture(t);
  writeFileSync(f.tunnel, frpc.replace("serverPort = 7000\n", ""));
  await savePorts(f.file, f.tunnel, { ...DEFAULT_PORTS, caddy: 9443 }, async () => {});
  assert.equal(Object.hasOwn(parse(readFileSync(f.tunnel, "utf8")), "serverPort"), false);
});
test("failed frpc verification preserves both configuration files", async (t) => {
  const f = fixture(t);
  writeFileSync(f.file, JSON.stringify({ api: 47823, admin: 47824, bridge: 47825, caddy: 8443 }));
  const before = readFileSync(f.file, "utf8");
  await assert.rejects(
    savePorts(f.file, f.tunnel, { ...DEFAULT_PORTS, caddy: 9443 }, async () => {
      throw new Error("private-fixture");
    }),
    /frpc/,
  );
  assert.equal(readFileSync(f.file, "utf8"), before);
  assert.equal(readFileSync(f.tunnel, "utf8"), frpc);
});
test("ports can be set before any tunnel has been configured", async (t) => {
  const f = fixture(t);
  writeFileSync(f.tunnel, "");
  await savePorts(f.file, f.tunnel, { ...DEFAULT_PORTS, caddy: 9443 }, async () => {});
  assert.equal(readLocalPorts(f.file).caddy, 9443);
});
test("rejects a JSON array instead of interpreting it as default port configuration", (t) => {
  const f = fixture(t);
  writeFileSync(f.file, "[]");
  assert.throws(() => readLocalPorts(f.file), /格式/);
});
test("a complete valid submission repairs damaged local ports using the unique tunnel target", async (t) => {
  const changed = { api: 48023, admin: 48024, bridge: 48025, caddy: 10443 };
  for (const damaged of [
    "{",
    "[]",
    JSON.stringify({ api: DEFAULT_PORTS.admin }),
    '{"caddy":"invalid"}',
  ]) {
    const f = fixture(t);
    writeFileSync(f.file, damaged);
    writeFileSync(f.tunnel, frpc.replace("localPort = 8443", "localPort = 9443"));
    await savePorts(f.file, f.tunnel, changed, async () => {});
    assert.deepEqual(readLocalPorts(f.file), changed);
    const config = parse(readFileSync(f.tunnel, "utf8"));
    assert.equal(config.proxies[0].localPort, 10443);
    assert.equal(config.auth.token, "private-fixture");
  }
});
test("repair refuses ambiguous active HTTPS proxies without modifying either file", async (t) => {
  const f = fixture(t);
  writeFileSync(f.file, "{");
  const multiple =
    frpc +
    frpc
      .slice(frpc.indexOf("[[proxies]]"))
      .replace('name = "board"', 'name = "other"')
      .replace("localPort = 8443", "localPort = 9443");
  writeFileSync(f.tunnel, multiple);
  await assert.rejects(
    savePorts(f.file, f.tunnel, { ...DEFAULT_PORTS, caddy: 10443 }, async () => {}),
    /多个|唯一/,
  );
  assert.equal(readFileSync(f.file, "utf8"), "{");
  assert.equal(readFileSync(f.tunnel, "utf8"), multiple);
});
test("damaged ports can be repaired before tunnel configuration", async (t) => {
  const f = fixture(t);
  writeFileSync(f.file, "{");
  writeFileSync(f.tunnel, "");
  await savePorts(f.file, f.tunnel, { ...DEFAULT_PORTS, caddy: 9443 }, async () => {});
  assert.equal(readLocalPorts(f.file).caddy, 9443);
});
test("repair never replaces a configuration symlink, including a dangling one", async (t) => {
  for (const entry of ["file", "tunnel"]) {
    const f = fixture(t);
    rmSync(f[entry], { force: true });
    symlinkSync(join(f[entry], "missing-target"), f[entry]);
    await assert.rejects(
      savePorts(f.file, f.tunnel, DEFAULT_PORTS, async () => {}),
      /普通文件/,
    );
    assert.equal(lstatSync(f[entry]).isSymbolicLink(), true);
  }
});

test("unchanged ports skip writes and validation; repeated changed saves become no-ops", async (t) => {
  const f = fixture(t);
  const before = readFileSync(f.tunnel);
  let verified = 0;
  const verify = async () => {
    verified++;
  };
  assert.deepEqual(await savePorts(f.file, f.tunnel, DEFAULT_PORTS, verify), {
    ports: DEFAULT_PORTS,
    changed: false,
  });
  assert.deepEqual(readFileSync(f.tunnel), before);
  assert.equal(verified, 0);
  const values = { ...DEFAULT_PORTS, caddy: 9443 };
  assert.equal((await savePorts(f.file, f.tunnel, values, verify)).changed, true);
  const saved = readFileSync(f.file);
  assert.equal((await savePorts(f.file, f.tunnel, values, verify)).changed, false);
  assert.deepEqual(readFileSync(f.file), saved);
  assert.equal(verified, 1);
});
