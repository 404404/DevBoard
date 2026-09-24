import { afterEach, expect, it } from "vitest";

import { ExecutionPlatformService } from "../src/modules/execution/execution-platform-service.js";
import { ExecutionProviderRegistry } from "../src/modules/execution/provider-registry.js";
import { initializeDatabase } from "../src/modules/database/index.js";

const openDatabases: ReturnType<typeof initializeDatabase>[] = [];
afterEach(() => {
  for (const database of openDatabases.splice(0)) {
    if (database.open) database.close();
  }
});

it("marks uncertain Runs interrupted on restart without replaying their prompt", () => {
  const database = initializeDatabase(":memory:");
  openDatabases.push(database);
  database.pragma("foreign_keys = OFF");
  const runId = "11111111-1111-4111-8111-111111111111";
  const timestamp = "2026-09-23T00:00:00.000Z";
  database
    .prepare(
      `INSERT INTO runs (id, task_id, provider_kind, status, created_at, updated_at)
       VALUES (?, ?, 'codex', 'running', ?, ?)`,
    )
    .run(runId, "22222222-2222-4222-8222-222222222222", timestamp, timestamp);
  const revisions: number[] = [];

  const service = new ExecutionPlatformService({
    database,
    providers: new ExecutionProviderRegistry(),
    now: () => new Date(timestamp),
    onRevisionCommitted: (revision) => revisions.push(revision),
  });

  expect(service.readRun(runId)).toMatchObject({
    status: "interrupted",
    errorCode: "RUN_RECOVERY_REQUIRED",
    errorSummary: expect.stringContaining("没有自动重放 prompt"),
    events: [expect.objectContaining({ type: "run.interrupted" })],
  });
  expect(revisions).toHaveLength(1);
});

it("resolves new Run workspaces only through the selected SSH Connection mapping", () => {
  const database = initializeDatabase(":memory:");
  openDatabases.push(database);
  const projectId = "11111111-1111-4111-8111-111111111111";
  const connectionId = "22222222-2222-4222-8222-222222222222";
  const profileId = "33333333-3333-4333-8333-333333333333";
  const timestamp = "2026-09-23T00:00:00.000Z";
  database
    .prepare("INSERT INTO projects (id, project_key, name) VALUES (?, 'REMOTE', 'Remote')")
    .run(projectId);
  database
    .prepare(
      `INSERT INTO connections (
        id, name, type, host, port, username, auth_mode, known_host_reference,
        status, capabilities_json, enabled, version, created_at, updated_at
      ) VALUES (?, 'Remote Host', 'ssh_host', 'host.example.test', 22, 'dev', 'agent',
        'managed:known_hosts', 'unknown', '{"providerExecutables":[],"protocolModes":[]}', 1, 1, ?, ?)`,
    )
    .run(connectionId, timestamp, timestamp);
  database
    .prepare(
      `INSERT INTO execution_profiles (
        id, name, provider_kind, connection_id, capabilities_json,
        enabled, version, created_at, updated_at
      ) VALUES (?, 'Codex', 'codex', ?, ?, 1, 1, ?, ?)`,
    )
    .run(
      profileId,
      connectionId,
      JSON.stringify({
        streaming: true,
        approvals: true,
        userInput: true,
        cancel: true,
        resume: true,
        models: true,
        reasoningEffort: true,
        modes: true,
        permissionModes: true,
        workspace: true,
      }),
      timestamp,
      timestamp,
    );
  database
    .prepare(
      `INSERT INTO workspace_mappings (id, project_id, connection_id, path, is_default)
       VALUES (?, ?, ?, '/home/dev/projects/remote', 1)`,
    )
    .run("44444444-4444-4444-8444-444444444444", projectId, connectionId);

  const service = new ExecutionPlatformService({
    database,
    providers: new ExecutionProviderRegistry(),
  });

  expect(service.resolveWorkspace(projectId, profileId)).toBe("/home/dev/projects/remote");
  expect(() =>
    service.resolveWorkspace(projectId, profileId, "/container/not-the-project"),
  ).toThrow("Workspace Mapping");
});

it("does not resolve a Run workspace when a project has no SSH mapping", () => {
  const database = initializeDatabase(":memory:");
  openDatabases.push(database);
  const projectId = "11111111-1111-4111-8111-111111111111";
  const connectionId = "22222222-2222-4222-8222-222222222222";
  const profileId = "33333333-3333-4333-8333-333333333333";
  const timestamp = "2026-09-23T00:00:00.000Z";
  database
    .prepare("INSERT INTO projects (id, project_key, name) VALUES (?, 'REMOTE', 'Remote')")
    .run(projectId);
  database
    .prepare(
      `INSERT INTO connections (
        id, name, type, host, port, username, auth_mode, known_host_reference,
        status, capabilities_json, enabled, version, created_at, updated_at
      ) VALUES (?, 'Remote Host', 'ssh_host', 'host.example.test', 22, 'dev', 'agent',
        'managed:known_hosts', 'unknown', '{"providerExecutables":[],"protocolModes":[]}', 1, 1, ?, ?)`,
    )
    .run(connectionId, timestamp, timestamp);
  database
    .prepare(
      `INSERT INTO execution_profiles (
        id, name, provider_kind, connection_id, capabilities_json,
        enabled, version, created_at, updated_at
      ) VALUES (?, 'Codex', 'codex', ?, ?, 1, 1, ?, ?)`,
    )
    .run(
      profileId,
      connectionId,
      JSON.stringify({
        streaming: true,
        approvals: true,
        userInput: true,
        cancel: true,
        resume: true,
        models: true,
        reasoningEffort: true,
        modes: true,
        permissionModes: true,
        workspace: true,
      }),
      timestamp,
      timestamp,
    );

  const service = new ExecutionPlatformService({
    database,
    providers: new ExecutionProviderRegistry(),
  });

  expect(() => service.resolveWorkspace(projectId, profileId)).toThrow("Workspace Mapping");
});
