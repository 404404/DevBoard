import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  credentialPaths,
  defaultCredentialStore,
  PendingCredentialSchema,
  readCredential,
  runtimeScope,
} from "./auth.js";
import type { RuntimeDescriptor } from "@lark-taskboard/contracts";

const runtime: RuntimeDescriptor = {
  descriptorVersion: 1,
  pid: 42,
  generatedAt: "2026-09-09T00:00:00Z",
  publicBaseUrl: "https://board.example",
  localAdminBaseUrl: "http://127.0.0.1:47824",
  capabilityToken: "x".repeat(43),
};
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function temporary() {
  const path = await mkdtemp(join(tmpdir(), "taskctl-auth-test-"));
  roots.push(path);
  return path;
}

describe("private CLI credential files", () => {
  it("creates and replaces credentials with mode 0600, reads them and removes them", async () => {
    const root = await temporary();
    const path = join(root, "config", "auth.json");
    await defaultCredentialStore.write(path, "private-one");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await defaultCredentialStore.read(path)).toBe("private-one");
    await chmod(path, 0o644);
    await expect(defaultCredentialStore.read(path)).rejects.toMatchObject({
      code: "CLI_AUTH_FILE_PERMISSIONS",
    });
    await defaultCredentialStore.write(path, "private-two");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await defaultCredentialStore.read(path)).toBe("private-two");
    await defaultCredentialStore.remove(path);
    expect(await defaultCredentialStore.read(path)).toBeNull();
  });
  it("refuses to read symlinks and replaces a symlink without touching its target", async () => {
    const root = await temporary();
    const target = join(root, "target");
    const link = join(root, "credential");
    await writeFile(target, "unrelated", { mode: 0o600 });
    await symlink(target, link);
    await expect(defaultCredentialStore.read(link)).rejects.toMatchObject({
      code: "CLI_AUTH_FILE_READ",
    });
    await defaultCredentialStore.write(link, "new-credential");
    expect(await readFile(target, "utf8")).toBe("unrelated");
    expect(await defaultCredentialStore.read(link)).toBe("new-credential");
  });
  it("isolates both runtime URLs even with an explicit credential base path", async () => {
    const base = "/tmp/auth-config";
    const original = credentialPaths(runtime, base);
    expect(
      credentialPaths({ ...runtime, publicBaseUrl: "https://other.example" }, base).session,
    ).not.toBe(original.session);
    expect(
      credentialPaths({ ...runtime, localAdminBaseUrl: "http://127.0.0.1:47825" }, base).session,
    ).not.toBe(original.session);
    expect(
      credentialPaths({ ...runtime, capabilityToken: "y".repeat(43), pid: 99 }, base).session,
    ).toBe(original.session);
    expect(original.pending).not.toBe(original.session);
  });
  it("rejects a copied credential that belongs to another runtime", async () => {
    const root = await temporary();
    const path = join(root, "auth");
    await defaultCredentialStore.write(
      path,
      JSON.stringify({
        scope: "wrong-runtime",
        requestId: "r",
        claimSecret: "s",
        expiresAt: "2099-01-01T00:00:00Z",
      }),
    );
    await expect(
      readCredential(
        defaultCredentialStore,
        path,
        PendingCredentialSchema,
        runtimeScope(runtime),
        Date.now(),
      ),
    ).rejects.toMatchObject({ code: "CLI_AUTH_RUNTIME_MISMATCH" });
  });
});
