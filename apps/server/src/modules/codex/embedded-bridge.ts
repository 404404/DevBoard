import type { AppConfig } from "../../config.js";

export interface EmbeddedCodexBridge {
  close(): Promise<void>;
}

/** @deprecated Local Codex bridges are removed; use an SSH Host Connection. */
export async function startEmbeddedCodexBridge(config: AppConfig): Promise<EmbeddedCodexBridge> {
  void config;
  throw new Error("Embedded Codex bridge was removed; configure an SSH Host Connection");
}
