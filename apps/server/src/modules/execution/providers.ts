import { AcpProvider, CURSOR_CAPABILITIES, GROK_CAPABILITIES, OPENCODE_CAPABILITIES } from "./acp-provider.js";

export class CursorProvider extends AcpProvider {
  constructor() {
    super({
      kind: "cursor",
      displayName: "Cursor",
      executable: "agent",
      args: ["acp"],
      capabilities: CURSOR_CAPABILITIES,
    });
  }
}
export class GrokBuildProvider extends AcpProvider {
  constructor() {
    super({
      kind: "grok",
      displayName: "Grok Build",
      executable: "grok",
      args: ["agent", "stdio"],
      capabilities: GROK_CAPABILITIES,
    });
  }
}

export class OpenCodeProvider extends AcpProvider {
  constructor() {
    super({
      kind: "opencode",
      displayName: "OpenCode",
      executable: "opencode",
      args: ["acp"],
      capabilities: OPENCODE_CAPABILITIES,
    });
  }
}
