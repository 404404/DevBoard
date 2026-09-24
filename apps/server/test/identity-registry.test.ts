import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../src/app-error.js";
import { initializeDatabase } from "../src/modules/database/index.js";
import { ExecutionPlatformService } from "../src/modules/execution/execution-platform-service.js";
import {
  DirectoryIdentityRegistry,
  isSshAgentAvailable,
} from "../src/modules/execution/identity-registry.js";
import { ExecutionProviderRegistry } from "../src/modules/execution/provider-registry.js";

const directories: string[] = [];
const databases: ReturnType<typeof initializeDatabase>[] = [];
const PUBLIC_METADATA = {
  algorithm: "ssh-ed25519",
  fingerprint: "SHA256:public-fingerprint-only",
  encrypted: false,
};

function createDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "devboard-ssh-identities-"));
  directories.push(directory);
  return directory;
}

function writeIdentity(directory: string, name = "host_ed25519", mode = 0o600): string {
  const path = join(directory, name);
  writeFileSync(path, "PRIVATE-KEY-CANARY-NEVER-RETURN", { mode });
  chmodSync(path, mode);
  return path;
}

function identityRegistry(directory: string) {
  return new DirectoryIdentityRegistry(directory, { inspect: async () => PUBLIC_METADATA });
}

function expectErrorCode(operation: () => unknown, code: string): void {
  let error: unknown;
  try {
    operation();
  } catch (caught: unknown) {
    error = caught;
  }
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const database of databases.splice(0)) {
    if (database.open) database.close();
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("DirectoryIdentityRegistry", () => {
  it("exposes only safe public metadata and resolves a catalog ref internally", async () => {
    const directory = createDirectory();
    const keyPath = writeIdentity(directory);
    const registry = identityRegistry(directory);
    const catalog = await registry.list();

    expect(catalog).toEqual([
      {
        id: "host_ed25519",
        name: "host_ed25519",
        ...PUBLIC_METADATA,
        usable: true,
        warning: null,
      },
    ]);
    expect(JSON.stringify(catalog)).not.toContain("PRIVATE-KEY-CANARY");
    expect(JSON.stringify(catalog)).not.toContain(directory);
    expect(registry.resolve("host_ed25519").path).toBe(keyPath);
  });

  it("rejects symlinks, traversal, and arbitrary absolute paths", async () => {
    const directory = createDirectory();
    const outside = writeIdentity(createDirectory(), "outside_ed25519");
    symlinkSync(outside, join(directory, "linked_key"));
    const registry = identityRegistry(directory);

    expect(await registry.list()).toEqual([
      expect.objectContaining({
        id: "linked_key",
        usable: false,
        warning: "不接受 symbolic link",
      }),
    ]);
    for (const reference of ["linked_key", "../outside_ed25519", outside]) {
      expect(() => registry.resolve(reference)).toThrow(AppError);
    }
    expectErrorCode(() => registry.resolve("../outside_ed25519"), "SSH_IDENTITY_INVALID");
  });

  it("rejects non-regular files, missing refs, and unsafe file permissions", async () => {
    const directory = createDirectory();
    mkdirSync(join(directory, "nested_identity"));
    writeIdentity(directory, "too_open", 0o644);
    const registry = identityRegistry(directory);
    const catalog = await registry.list();

    expect(catalog).toEqual([
      expect.objectContaining({
        id: "nested_identity",
        usable: false,
        warning: "Identity 必须是普通文件",
      }),
      expect.objectContaining({
        id: "too_open",
        usable: false,
        warning: expect.stringContaining("权限不安全"),
      }),
    ]);
    expectErrorCode(() => registry.resolve("nested_identity"), "SSH_IDENTITY_INVALID");
    expectErrorCode(() => registry.resolve("missing_key"), "SSH_IDENTITY_NOT_FOUND");
    expectErrorCode(() => registry.resolve("too_open"), "SSH_IDENTITY_PERMISSIONS");
  });

  it("does not wait on a passphrase prompt and marks encrypted files unusable", async () => {
    const directory = createDirectory();
    writeIdentity(directory);
    const promptProgram = join(createDirectory(), "fake-ssh-keygen");
    writeFileSync(
      promptProgram,
      [
        "#!/bin/sh",
        "printf 'Enter passphrase: PRIVATE-KEY-CANARY\\nIncorrect passphrase supplied' >&2",
        "IFS= read -r answer",
        "exit 4",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    chmodSync(promptProgram, 0o700);
    const registry = new DirectoryIdentityRegistry(directory, {
      sshKeygenExecutable: promptProgram,
    });

    const started = Date.now();
    const [identity] = await registry.list();
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(identity).toMatchObject({
      id: "host_ed25519",
      encrypted: true,
      usable: false,
      warning: expect.stringContaining("SSH Agent"),
    });
    expect(JSON.stringify(identity)).not.toContain("PRIVATE-KEY-CANARY");
  });

  it("reports an unavailable SSH Agent explicitly when its socket is missing", async () => {
    const missingSocket = join(tmpdir(), `missing-devboard-agent-${Date.now()}`);
    vi.stubEnv("SSH_AUTH_SOCK", missingSocket);
    await expect(isSshAgentAvailable()).resolves.toBe(false);

    const database = initializeDatabase(":memory:");
    databases.push(database);
    const service = new ExecutionPlatformService({
      database,
      providers: new ExecutionProviderRegistry(),
    });
    const { connection } = service.createConnection({
      name: "Agent Host",
      type: "ssh_host",
      host: "host.example.test",
      port: 22,
      username: "dev",
      authMode: "agent",
      identityRef: null,
      capabilities: { providerExecutables: [], protocolModes: [] },
      enabled: false,
    });
    const tested = await service.testConnection(connection.id);
    expect(tested.health).toMatchObject({
      status: "authentication_required",
      message: expect.stringContaining("SSH Agent 不可用"),
    });
  });

  it("treats a socket that does not implement SSH Agent as unavailable", async () => {
    const directory = createDirectory();
    const socketPath = join(directory, "agent.sock");
    const net = await import("node:net");
    const server = net.createServer((socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    vi.stubEnv("SSH_AUTH_SOCK", socketPath);
    try {
      const started = Date.now();
      await expect(isSshAgentAvailable()).resolves.toBe(false);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15_000);

  it("stores and returns only identityRef metadata through the Connection API", async () => {
    const directory = createDirectory();
    writeIdentity(directory);
    const database = initializeDatabase(":memory:");
    databases.push(database);
    const service = new ExecutionPlatformService({
      database,
      providers: new ExecutionProviderRegistry(),
      identityRegistry: identityRegistry(directory),
    });
    const created = service.createConnection({
      name: "Remote Host",
      type: "ssh_host",
      host: "host.example.test",
      port: 22,
      username: "dev",
      authMode: "identity_file",
      identityRef: "host_ed25519",
      capabilities: { providerExecutables: [], protocolModes: [] },
      enabled: false,
    });
    const storedRef = database
      .prepare("SELECT identity_ref FROM connections WHERE id = ?")
      .pluck()
      .get(created.connection.id);
    const settings = await service.readSettings();
    const serialized = JSON.stringify({ connection: created.connection, settings });

    expect(storedRef).toBe("host_ed25519");
    expect(created.connection).toMatchObject({ identityRef: "host_ed25519" });
    expect(created.connection).not.toHaveProperty("identity");
    expect(serialized).not.toContain("PRIVATE-KEY-CANARY");
    expect(serialized).not.toContain(directory);
    expect(serialized).not.toContain("identity_file path");
    expect(settings.sshIdentities).toEqual([
      expect.objectContaining({
        id: "host_ed25519",
        fingerprint: PUBLIC_METADATA.fingerprint,
        usable: true,
      }),
    ]);
  });
});
