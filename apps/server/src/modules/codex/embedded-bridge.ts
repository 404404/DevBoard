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

/** Load the shared bridge inside the backend; no independent Node service is spawned. */
export async function startEmbeddedCodexBridge(config: AppConfig): Promise<EmbeddedCodexBridge> {
  const url = new URL("../../../../../scripts/run-codex-app-server.mjs", import.meta.url);
  const bridge = (await import(url.href)) as BridgeModule;
  return bridge.startCodexBridge({
    codexPath: config.LARK_CODEX_CODEX_COMMAND,
    tokenFile: config.LARK_CODEX_CODEX_TOKEN_FILE as string,
    endpoint: config.LARK_CODEX_CODEX_ENDPOINT,
    projectStateFile: config.LARK_CODEX_CODEX_PROJECT_STATE_FILE as string,
    projectSnapshotFile: config.LARK_CODEX_CODEX_PROJECT_SNAPSHOT_FILE,
  });
}
