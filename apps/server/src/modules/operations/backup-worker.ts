import { parentPort, workerData } from "node:worker_threads";
import { basename } from "node:path";

import { openDatabase } from "../database/index.js";
import { BackupService } from "./backup-service.js";

const input = workerData as { dataDirectory?: unknown };
if (!parentPort || typeof input.dataDirectory !== "string") {
  throw new Error("后台备份 Worker 缺少必要输入");
}

const database = openDatabase(`${input.dataDirectory}/taskboard.sqlite`);
try {
  const service = new BackupService({
    database,
    dataDirectory: input.dataDirectory,
  });
  const destination = service.automaticDestination();
  const manifest = await service.create(destination);
  parentPort.postMessage({ ok: true, backupId: basename(destination), manifest });
} catch {
  parentPort.postMessage({ ok: false });
  process.exitCode = 1;
} finally {
  database.close();
}
