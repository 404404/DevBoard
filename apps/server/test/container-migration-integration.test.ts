import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/modules/database/database.js";
import { CORE_MIGRATIONS } from "../src/modules/database/migrations/index.js";
import { runMigrations } from "../src/modules/database/migrator.js";

describe("container upgrade migration acceptance", () => {
  it("preserves legacy business history and fails closed on legacy SSH paths", () => {
    const database = openDatabase(":memory:");
    try {
      runMigrations(database, CORE_MIGRATIONS.filter(({ version }) => version <= 20));
      database.exec(`
        INSERT INTO actors (id, tenant_key, open_id, name, role)
          VALUES (
            '00000000-0000-4000-8000-000000000001', 'development-tenant',
            'development-user', 'Local admin', 'admin'
          );
        INSERT INTO projects (id, project_key, name, description)
          VALUES ('project-legacy', 'UPGRADE', 'Legacy project', 'Retained project description');
        INSERT INTO tasks (id, identifier, project_id, task_number, title, status)
          VALUES ('task-legacy', 'UPGRADE-1', 'project-legacy', 1, 'Retained task', 'todo');
        INSERT INTO comments (id, task_id, author_id, body, version, executed_at)
          VALUES (
            'comment-legacy', 'task-legacy', '00000000-0000-4000-8000-000000000001',
            'Retained comment', 4, '2026-09-01T00:00:00.000Z'
          );
        INSERT INTO attachments (
          id, task_id, comment_id, uploader_id, filename, content_type,
          size_bytes, sha256, storage_key
        ) VALUES (
          'attachment-legacy', 'task-legacy', 'comment-legacy',
          '00000000-0000-4000-8000-000000000001', 'evidence.txt', 'text/plain',
          8, '${"a".repeat(64)}', 'aa/evidence.txt'
        );
      `);

      database
        .prepare(`INSERT INTO task_threads (
          id, task_id, thread_id, cwd, codex_version, is_primary,
          last_turn_id, last_event_cursor, status
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 'completed')`)
        .run(
          "thread-row-legacy",
          "task-legacy",
          "codex-thread-legacy",
          "/legacy/workspace",
          "codex 0.1.11",
          "codex-turn-legacy",
          "codex-cursor-legacy",
        );
      database
        .prepare(`INSERT INTO jobs (
          id, task_id, task_thread_id, kind, status, execution_key,
          idempotency_key, requested_by, work_context_json,
          queued_at, started_at, completed_at, updated_at
        ) VALUES (?, ?, ?, 'start', 'succeeded', ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          "job-legacy",
          "task-legacy",
          "thread-row-legacy",
          "legacy-execution-key",
          "legacy-job-idempotency-key",
          "00000000-0000-4000-8000-000000000001",
          JSON.stringify({
            cwd: "/legacy/workspace",
            modelOptions: { model: "gpt-5", effort: "high" },
          }),
          "2026-09-01T00:00:00.000Z",
          "2026-09-01T00:01:00.000Z",
          "2026-09-01T00:02:00.000Z",
          "2026-09-01T00:02:00.000Z",
        );
      database
        .prepare(`INSERT INTO job_events (
          id, job_id, seq, kind, summary, safe_payload_json, created_at
        ) VALUES (?, ?, 1, 'agent_message', ?, ?, ?)`)
        .run(
          "job-event-legacy",
          "job-legacy",
          "Retained legacy run event",
          JSON.stringify({ text: "historical Codex output" }),
          "2026-09-01T00:01:30.000Z",
        );
      database
        .prepare(`INSERT INTO job_interactions (
          id, job_id, server_request_id, kind, status, safe_request_json,
          decision_json, decided_by, created_at, decided_at
        ) VALUES (?, ?, ?, 'command_approval', 'responded', ?, ?, ?, ?, ?)`)
        .run(
          "job-approval-legacy",
          "job-legacy",
          "codex-request-legacy",
          JSON.stringify({ command: ["git", "status", "--short"] }),
          JSON.stringify({ type: "accept" }),
          "00000000-0000-4000-8000-000000000001",
          "2026-09-01T00:01:10.000Z",
          "2026-09-01T00:01:15.000Z",
        );

      runMigrations(database, CORE_MIGRATIONS.filter(({ version }) => version <= 28));
      database
        .prepare(
          `INSERT INTO connections (
            id, name, type, host, port, username, auth_mode, identity,
            known_host_reference, status, enabled
          ) VALUES (?, ?, 'ssh_host', 'example.test', 22, 'devboard', 'identity_file', ?,
            'managed:known_hosts', 'online', 1)`,
        )
        .run(
          "00000000-0000-4000-8000-0000000000b1",
          "Legacy path connection",
          "/run/devboard/ssh/identities/old-private-key",
        );
      database
        .prepare(
          `INSERT INTO connections (
            id, name, type, host, port, username, auth_mode, identity,
            known_host_reference, status, enabled
          ) VALUES (?, 'Configured host', 'ssh_host', 'gk50.example.test', 22, 'devboard',
            'identity_file', '/legacy/path', 'managed:known_hosts', 'online', 1)`,
        )
        .run("00000000-0000-4000-8000-0000000000b2");
      // A draft pre-release schema may already have an identity_ref column.
      database.exec("ALTER TABLE connections ADD COLUMN identity_ref TEXT");
      database
        .prepare("UPDATE connections SET identity_ref = ? WHERE id = ?")
        .run("/arbitrary/private/key", "00000000-0000-4000-8000-0000000000b1");
      database
        .prepare("UPDATE connections SET identity_ref = ? WHERE id = ?")
        .run("gk50_ed25519", "00000000-0000-4000-8000-0000000000b2");

      expect(runMigrations(database, CORE_MIGRATIONS)).toEqual([29]);
      expect(runMigrations(database, CORE_MIGRATIONS)).toEqual([]);

      expect(
        database
          .prepare("SELECT project_key, description FROM projects WHERE id = 'project-legacy'")
          .get(),
      ).toEqual({
        project_key: "UPGRADE",
        description: "Retained project description",
      });
      expect(
        database.prepare("SELECT identifier, title FROM tasks WHERE id = 'task-legacy'").get(),
      ).toEqual({ identifier: "UPGRADE-1", title: "Retained task" });
      expect(
        database
          .prepare(
            "SELECT thread_id, cwd, last_turn_id, last_event_cursor FROM task_threads WHERE id = ?",
          )
          .get("thread-row-legacy"),
      ).toEqual({
        thread_id: "codex-thread-legacy",
        cwd: "/legacy/workspace",
        last_turn_id: "codex-turn-legacy",
        last_event_cursor: "codex-cursor-legacy",
      });
      const migratedRun = database
        .prepare(`SELECT id, provider_thread_id, provider_session_id, workspace, model,
          reasoning_effort, status, legacy_job_id FROM runs WHERE legacy_job_id = ?`)
        .get("job-legacy") as Record<string, unknown> | undefined;
      expect(migratedRun).toMatchObject({
        provider_thread_id: "codex-thread-legacy",
        provider_session_id: "codex-thread-legacy",
        workspace: "/legacy/workspace",
        model: "gpt-5",
        reasoning_effort: "high",
        status: "succeeded",
        legacy_job_id: "job-legacy",
      });
      expect(
        database.prepare("SELECT run_id FROM jobs WHERE id = 'job-legacy'").pluck().get(),
      ).toBe(migratedRun?.id);
      expect(
        database
          .prepare("SELECT event_type, summary, safe_payload_json FROM run_events WHERE run_id = ?")
          .get(migratedRun?.id),
      ).toEqual({
        event_type: "agent.message",
        summary: "Retained legacy run event",
        safe_payload_json: JSON.stringify({ text: "historical Codex output" }),
      });
      expect(
        database
          .prepare("SELECT approval_type, status FROM run_approvals WHERE run_id = ?")
          .get(migratedRun?.id),
      ).toEqual({ approval_type: "command_approval", status: "approved" });
      expect(
        database
          .prepare(
            "SELECT body, version, author_identity_key FROM comments WHERE id = 'comment-legacy'",
          )
          .get(),
      ).toEqual({
        body: "Retained comment",
        version: 4,
        author_identity_key: '["service","local-admin"]',
      });
      expect(
        database
          .prepare(`SELECT filename, size_bytes, sha256, storage_key, uploader_identity_key
            FROM attachments WHERE id = 'attachment-legacy'`)
          .get(),
      ).toEqual({
        filename: "evidence.txt",
        size_bytes: 8,
        sha256: "a".repeat(64),
        storage_key: "aa/evidence.txt",
        uploader_identity_key: '["service","local-admin"]',
      });
      expect(
        database
          .prepare("SELECT kind, service_id FROM identities WHERE identity_key = ?")
          .get('["service","local-admin"]'),
      ).toEqual({ kind: "service", service_id: "local-admin" });
      expect(
        database
          .prepare("SELECT identity_ref, status, enabled FROM connections WHERE id = ?")
          .get("00000000-0000-4000-8000-0000000000b1"),
      ).toEqual({
        identity_ref: null,
        status: "configuration_required",
        enabled: 0,
      });
      expect(
        database
          .prepare("SELECT identity_ref, status, enabled FROM connections WHERE id = ?")
          .get("00000000-0000-4000-8000-0000000000b2"),
      ).toEqual({ identity_ref: "gk50_ed25519", status: "online", enabled: 1 });
      const connectionColumns = (
        database.pragma("table_info(connections)") as Array<{ name: string }>
      ).map(({ name }) => name);
      expect(connectionColumns).toContain("identity_ref");
      expect(connectionColumns).not.toContain("identity");
      expect(database.pragma("foreign_key_check")).toEqual([]);
      expect(database.prepare("SELECT MAX(version) FROM schema_migrations").pluck().get()).toBe(29);
    } finally {
      database.close();
    }
  });

  it("initializes a fresh database through the current schema", () => {
    const database = new Database(":memory:");
    try {
      expect(runMigrations(database, CORE_MIGRATIONS)).toEqual(
        CORE_MIGRATIONS.map(({ version }) => version),
      );
      expect(runMigrations(database, CORE_MIGRATIONS)).toEqual([]);
      expect(database.prepare("SELECT MAX(version) FROM schema_migrations").pluck().get()).toBe(29);
    } finally {
      database.close();
    }
  });
});
