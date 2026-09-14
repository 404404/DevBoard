import {
  LocalOperationsSnapshotSchema,
  QueueMetricsSchema,
  type ComponentCheck,
  type LocalOperationsSnapshot,
  type QueueMetrics,
} from "@lark-taskboard/contracts";

import type { CodexSupervisorHealth } from "../codex/index.js";
import { isDatabaseHealthy, type SqliteDatabase } from "../database/index.js";
import type { RequestMetrics } from "./metrics.js";

export interface ConnectorHealth {
  readonly connected: boolean;
}

export interface OperationsRuntimeHealth {
  readonly connectorHealth?: () => ConnectorHealth;
  readonly appServerHealth?: () => CodexSupervisorHealth;
}

interface OperationsHealthServiceOptions extends OperationsRuntimeHealth {
  readonly database: SqliteDatabase;
  readonly metrics: RequestMetrics;
  readonly now?: () => Date;
}

const EMPTY_QUEUE_METRICS: QueueMetrics = {
  queued: 0,
  running: 0,
  waitingApproval: 0,
  waitingInput: 0,
  canceling: 0,
  failedRecoverable: 0,
};

export class OperationsHealthService {
  readonly #database: SqliteDatabase;
  readonly #metrics: RequestMetrics;
  readonly #connectorHealth: () => ConnectorHealth;
  readonly #appServerHealth: () => CodexSupervisorHealth;
  readonly #now: () => Date;

  constructor(options: OperationsHealthServiceOptions) {
    this.#database = options.database;
    this.#metrics = options.metrics;
    this.#connectorHealth = options.connectorHealth ?? (() => ({ connected: false }));
    this.#appServerHealth =
      options.appServerHealth ?? (() => ({ status: "offline", pid: null, error: null }));
    this.#now = options.now ?? (() => new Date());
  }

  snapshot(): LocalOperationsSnapshot {
    const sqliteHealthy = isDatabaseHealthy(this.#database);
    const { metrics: queueMetrics, check: queueCheck } = this.#queueHealth(sqliteHealthy);
    const connector = this.#connectorHealth();
    const appServer = this.#appServerHealth();
    const checks = {
      http: { status: "ok" as const },
      sqlite: sqliteHealthy
        ? ({ status: "ok" } as const)
        : ({ status: "unavailable", reason: "SQLite 健康检查失败" } as const),
      queue: queueCheck,
      connector: connector.connected
        ? ({ status: "ok" } as const)
        : ({ status: "unavailable", reason: "Connector 未连接" } as const),
      appServer: this.#appServerCheck(appServer),
    };

    return LocalOperationsSnapshotSchema.parse({
      status: Object.values(checks).every((check) => check.status === "ok") ? "ok" : "degraded",
      timestamp: this.#now().toISOString(),
      checks,
      metrics: {
        requests: this.#metrics.snapshot(),
        queue: queueMetrics,
      },
    });
  }

  #queueHealth(sqliteHealthy: boolean): { metrics: QueueMetrics; check: ComponentCheck } {
    if (!sqliteHealthy) {
      return {
        metrics: EMPTY_QUEUE_METRICS,
        check: { status: "unavailable", reason: "SQLite 不可用，无法读取队列" },
      };
    }
    try {
      const rows = this.#database
        .prepare(
          `SELECT status, COUNT(*) AS count
          FROM jobs
          WHERE status IN (
            'queued', 'running', 'waiting_approval', 'waiting_input',
            'canceling', 'failed_recoverable'
          )
          GROUP BY status`,
        )
        .all() as Array<{ status: string; count: number }>;
      const byStatus = new Map(rows.map((row) => [row.status, row.count]));
      const metrics = QueueMetricsSchema.parse({
        queued: byStatus.get("queued") ?? 0,
        running: byStatus.get("running") ?? 0,
        waitingApproval: byStatus.get("waiting_approval") ?? 0,
        waitingInput: byStatus.get("waiting_input") ?? 0,
        canceling: byStatus.get("canceling") ?? 0,
        failedRecoverable: byStatus.get("failed_recoverable") ?? 0,
      });
      return {
        metrics,
        check:
          metrics.failedRecoverable > 0
            ? { status: "degraded", reason: "存在需要人工重试的作业" }
            : { status: "ok" },
      };
    } catch {
      return {
        metrics: EMPTY_QUEUE_METRICS,
        check: { status: "unavailable", reason: "队列健康检查失败" },
      };
    }
  }

  #appServerCheck(health: CodexSupervisorHealth): ComponentCheck {
    if (health.status === "ready") return { status: "ok" };
    if (health.status === "starting") return { status: "degraded", reason: "App Server 启动中" };
    return {
      status: "unavailable",
      reason: health.status === "error" ? "App Server 运行异常" : "App Server 未运行",
    };
  }
}
