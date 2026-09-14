import { Worker } from "node:worker_threads";

import { BackupManifestSchema, type BackupManifest } from "@lark-codex/contracts";
import { z } from "zod";

const BackupIdentifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/);

export interface BackupRunResult {
  readonly backupId: string;
  readonly manifest: BackupManifest;
}

export interface BackupRunner {
  create(): Promise<BackupRunResult>;
}

export class BackgroundBackupRunner implements BackupRunner {
  readonly #dataDirectory: string;
  #running: Promise<BackupRunResult> | undefined;

  constructor(dataDirectory: string) {
    this.#dataDirectory = dataDirectory;
  }

  async create(): Promise<BackupRunResult> {
    if (this.#running) throw new Error("已有后台备份正在运行");
    const running = this.#run();
    this.#running = running;
    try {
      return await running;
    } finally {
      if (this.#running === running) this.#running = undefined;
    }
  }

  #run(): Promise<BackupRunResult> {
    return new Promise((resolve, reject) => {
      const workerModule = import.meta.url.endsWith(".ts")
        ? new URL("./backup-worker.ts", import.meta.url)
        : new URL("./backup-worker.js", import.meta.url);
      const worker = new Worker(workerModule, {
        workerData: { dataDirectory: this.#dataDirectory },
      });
      let settled = false;
      const fail = () => {
        if (settled) return;
        settled = true;
        reject(new Error("后台备份失败"));
      };
      worker.once("message", (message: unknown) => {
        if (settled) return;
        const value =
          message && typeof message === "object" ? (message as Record<string, unknown>) : {};
        const manifest = value.ok === true ? BackupManifestSchema.safeParse(value.manifest) : null;
        const backupId =
          value.ok === true ? BackupIdentifierSchema.safeParse(value.backupId) : null;
        if (!manifest?.success || !backupId?.success) {
          fail();
          return;
        }
        settled = true;
        resolve({ backupId: backupId.data, manifest: manifest.data });
      });
      worker.once("error", fail);
      worker.once("exit", (code) => {
        if (!settled || code !== 0) fail();
      });
    });
  }
}
