import { watch } from "node:fs";
import { basename, dirname } from "node:path";

import {
  ProjectSnapshotError,
  readCodexProjectSnapshot,
  type CodexProjectSnapshot,
} from "./codex-project-snapshot.js";
import type { ProjectSyncService } from "./project-sync-service.js";

interface WatchHandle {
  close(): void;
  on?(event: "error", listener: (error: Error) => void): unknown;
}

type WatchFactory = (
  directory: string,
  listener: (eventType: string, filename: string | Buffer | null) => void,
) => WatchHandle;

interface ProjectSnapshotWatcherOptions {
  readonly snapshotFile: string;
  readonly service: ProjectSyncService;
  readonly debounceMs?: number;
  readonly reconcileMs?: number;
  readonly watchFactory?: WatchFactory;
  readonly readSnapshot?: (snapshotFile: string) => CodexProjectSnapshot;
}

export class ProjectSnapshotWatcher {
  readonly #snapshotFile: string;
  readonly #service: ProjectSyncService;
  readonly #debounceMs: number;
  readonly #reconcileMs: number;
  readonly #watchFactory: WatchFactory;
  readonly #readSnapshot: (snapshotFile: string) => CodexProjectSnapshot;
  #watcher: WatchHandle | undefined;
  #debounceTimer: NodeJS.Timeout | undefined;
  #reconcileTimer: NodeJS.Timeout | undefined;
  #refreshPromise: Promise<void> | undefined;
  #started = false;
  #closed = false;

  constructor(options: ProjectSnapshotWatcherOptions) {
    this.#snapshotFile = options.snapshotFile;
    this.#service = options.service;
    this.#debounceMs = options.debounceMs ?? 250;
    this.#reconcileMs = options.reconcileMs ?? 30_000;
    this.#watchFactory =
      options.watchFactory ??
      ((directory, listener) =>
        watch(directory, (eventType, filename) => listener(eventType, filename)));
    this.#readSnapshot = options.readSnapshot ?? readCodexProjectSnapshot;
  }

  async start(): Promise<void> {
    if (this.#started || this.#closed) return;
    this.#started = true;
    try {
      this.#watcher = this.#watchFactory(dirname(this.#snapshotFile), (eventType, filename) => {
        if (!filename || filename.toString() === basename(this.#snapshotFile)) this.#schedule();
      });
      this.#watcher.on?.("error", () => {
        this.#service.recordFailure("PROJECT_SNAPSHOT_WATCH_FAILED");
      });
    } catch {
      this.#service.recordFailure("PROJECT_SNAPSHOT_WATCH_FAILED");
    }
    this.#reconcileTimer = setInterval(() => void this.refresh(), this.#reconcileMs);
    await this.refresh();
  }

  refresh(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#refreshPromise) return this.#refreshPromise;
    const refresh = Promise.resolve()
      .then(() => {
        const snapshot = this.#readSnapshot(this.#snapshotFile);
        this.#service.reconcile(snapshot);
      })
      .catch((error: unknown) => {
        this.#service.recordFailure(
          error instanceof ProjectSnapshotError ? error.code : "PROJECT_SYNC_FAILED",
        );
      })
      .finally(() => {
        if (this.#refreshPromise === refresh) this.#refreshPromise = undefined;
      });
    this.#refreshPromise = refresh;
    return refresh;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#debounceTimer);
    clearInterval(this.#reconcileTimer);
    this.#watcher?.close();
    await this.#refreshPromise;
  }

  #schedule(): void {
    if (this.#closed) return;
    clearTimeout(this.#debounceTimer);
    this.#debounceTimer = setTimeout(() => void this.refresh(), this.#debounceMs);
  }
}
