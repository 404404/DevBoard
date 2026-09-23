import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AppError } from "../src/app-error.js";
import { SSHHostKeyStore } from "../src/modules/execution/ssh-host-key-store.js";

const temporaryDirectories: string[] = [];
const target = { id: "7b3db75b-297f-4314-980a-61b139bf1020", host: "host.example.test", port: 2222 };

function makeKeyStore(keyData: string) {
  const directory = mkdtempSync(join(tmpdir(), "devboard-known-hosts-"));
  temporaryDirectories.push(directory);
  const knownHosts = join(directory, "known_hosts");
  const scanner = join(directory, "ssh-keyscan-fixture");
  writeFileSync(knownHosts, "", { mode: 0o600 });
  writeFileSync(scanner, `#!/bin/sh\nprintf '%s\\n' 'host ssh-ed25519 ${keyData}'\n`, { mode: 0o700 });
  chmodSync(scanner, 0o700);
  return { knownHosts, scanner, store: new SSHHostKeyStore(knownHosts, scanner) };
}

function fingerprint(keyData: string): string {
  return `SHA256:${createHash("sha256").update(Buffer.from(keyData, "base64")).digest("base64").replace(/=+$/, "")}`;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("SSHHostKeyStore", () => {
  it("does not trust scanned keys until the matching fingerprint is explicitly confirmed", async () => {
    const keyData = "ZmFrZS1ob3N0LWtleQ==";
    const { knownHosts, store } = makeKeyStore(keyData);

    await expect(store.scan(target)).resolves.toEqual([
      { algorithm: "ssh-ed25519", fingerprint: fingerprint(keyData), trusted: false },
    ]);
    expect(readFileSync(knownHosts, "utf8")).toBe("");

    expect(store.trust(target, fingerprint(keyData))).toEqual({
      algorithm: "ssh-ed25519",
      fingerprint: fingerprint(keyData),
      trusted: true,
    });
    expect(readFileSync(knownHosts, "utf8")).toBe(`[${target.host}]:${target.port} ssh-ed25519 ${keyData}\n`);
    expect(store.list(target)).toEqual([
      { algorithm: "ssh-ed25519", fingerprint: fingerprint(keyData), trusted: true },
    ]);
  });

  it("blocks changed keys and never silently replaces an existing trusted key", async () => {
    const first = "Zmlyc3QtaG9zdC1rZXk=";
    const second = "c2Vjb25kLWhvc3Qta2V5";
    const { knownHosts, scanner, store } = makeKeyStore(first);
    await store.scan(target);
    store.trust(target, fingerprint(first));
    const original = readFileSync(knownHosts, "utf8");

    writeFileSync(scanner, `#!/bin/sh\nprintf '%s\\n' 'host ssh-ed25519 ${second}'\n`, { mode: 0o700 });
    chmodSync(scanner, 0o700);
    await store.scan(target);
    let error: unknown;
    try {
      store.trust(target, fingerprint(second));
    } catch (caught: unknown) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("HOST_KEY_CHANGED");
    expect(readFileSync(knownHosts, "utf8")).toBe(original);
  });

  it("refuses a known_hosts symlink rather than following it during trust", async () => {
    const keyData = "ZmFrZS1ob3N0LWtleQ==";
    const { knownHosts, store } = makeKeyStore(keyData);
    const protectedFile = join(temporaryDirectories.at(-1) ?? "", "protected.txt");
    writeFileSync(protectedFile, "do not modify\n", { mode: 0o600 });
    await store.scan(target);

    unlinkSync(knownHosts);
    symlinkSync(protectedFile, knownHosts);

    let error: unknown;
    try {
      store.trust(target, fingerprint(keyData));
    } catch (caught: unknown) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("HOST_KEY_FAILED");
    expect(readFileSync(protectedFile, "utf8")).toBe("do not modify\n");
  });
});
