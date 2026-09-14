import { identityKey } from "@lark-taskboard/contracts";
import { seedFeishuTestActor, TEST_FEISHU_IDENTITY } from "./helpers/identity.js";
import { describe, expect, it } from "vitest";

import { initializeDatabase } from "../src/modules/database/index.js";
import { OperationsHealthService, RequestMetrics } from "../src/modules/operations/index.js";

describe("operations health", () => {
  it("reports healthy local services without requiring a public tunnel probe", () => {
    const database = initializeDatabase(":memory:");
    try {
      const service = new OperationsHealthService({
        database,
        metrics: new RequestMetrics(),
        connectorHealth: () => ({ connected: true }),
        appServerHealth: () => ({ status: "ready", pid: 123, error: null }),
      });
      expect(service.snapshot().status).toBe("ok");
      expect(Object.keys(service.snapshot().checks)).toEqual([
        "http",
        "sqlite",
        "queue",
        "connector",
        "appServer",
      ]);
    } finally {
      database.close();
    }
  });

  it("reports queue degradation and every required runtime component", () => {
    const database = initializeDatabase(":memory:");
    try {
      seedFeishuTestActor(database);
      database
        .prepare(
          "INSERT INTO projects (id, project_key, name, created_by_identity_key) VALUES (?, ?, ?, ?)",
        )
        .run("project-1", "OPS", "运维项目", identityKey(TEST_FEISHU_IDENTITY));
      database
        .prepare(
          `INSERT INTO tasks (
            id, identifier, project_id, task_number, title, status, creator_identity_key
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "task-1",
          "OPS-1",
          "project-1",
          1,
          "恢复作业",
          "in_progress",
          identityKey(TEST_FEISHU_IDENTITY),
        );
      database
        .prepare(
          `INSERT INTO jobs (
            id, task_id, kind, status, execution_key, idempotency_key,
            requested_by_identity_key, error_code, error_summary
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "job-1",
          "task-1",
          "start",
          "failed_recoverable",
          "/workspace/ops",
          "ops-health-idempotency",
          identityKey(TEST_FEISHU_IDENTITY),
          "RESTART_UNCERTAIN",
          "需要人工重试",
        );
      const metrics = new RequestMetrics();
      metrics.begin();
      metrics.finish(503);
      const service = new OperationsHealthService({
        database,
        metrics,
        connectorHealth: () => ({ connected: false }),
        appServerHealth: () => ({ status: "ready", pid: 123, error: null }),
        now: () => new Date("2026-08-31T08:00:00.000Z"),
      });

      expect(service.snapshot()).toMatchObject({
        status: "degraded",
        timestamp: "2026-08-31T08:00:00.000Z",
        checks: {
          http: { status: "ok" },
          sqlite: { status: "ok" },
          queue: { status: "degraded" },
          connector: { status: "unavailable" },
          appServer: { status: "ok" },
        },
        metrics: {
          requests: { total: 1, inFlight: 0, errors: 1 },
          queue: { failedRecoverable: 1 },
        },
      });
    } finally {
      database.close();
    }
  });
});
