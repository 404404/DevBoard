import type { CodexThreadProvisioner } from "../src/modules/execution/index.js";

export class FakeThreadProvisioner implements CodexThreadProvisioner {
  readonly created: Array<{ cwd: string | null; name: string }> = [];
  readonly archived: string[] = [];

  async createDraft(input: { readonly cwd: string | null; readonly name: string }) {
    this.created.push(input);
    const sequence = this.created.length;
    return {
      threadId: `thread-draft-${sequence}`,
      cwd: input.cwd ?? "/Users/test/Recent",
    };
  }

  async archiveThread(threadId: string): Promise<void> {
    this.archived.push(threadId);
  }
}
