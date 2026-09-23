import type { AppConfig } from "../../config.js";

export interface EmbeddedCodexBridge {
  close(): Promise<void>;
}

interface BridgeModule {
  startCodexBridge(options: {
    codexPath: string;
    tokenFile: string;
    endpoint: string;
    projectStateFile: string;
    projectSnapshotFile: string;
  }): Promise<EmbeddedCodexBridge>;
}

/** @deprecated Local Codex bridges are removed; use an SSH Host Connection. */
export async function startEmbeddedCodexBridge(_config: AppConfig): Promise<EmbeddedCodexBridge> {
  throw new Error("Embedded Codex bridge was removed; configure an SSH Host Connection");
}
