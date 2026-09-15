import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SessionView } from "@codexboard/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CliAuthApproval } from "./cli-auth-approval";
import { approveCliRequest } from "./cli-auth-api";

const session: SessionView = {
  actor: {
    identity: { kind: "feishu", tenantKey: "tenant-a", userId: "user-1" },
    name: "Alice",
    avatarUrl: null,
    role: "member",
  },
  csrfToken: "csrf-secret",
  expiresAt: "2099-01-01T00:00:00Z",
};
function render(status: "pending" | "approved" | "expired", current = session) {
  const client = new QueryClient();
  client.setQueryData(["cli-auth-request", "r"], {
    requestId: "r",
    label: "My terminal",
    verificationCode: "A1B2C3D4",
    status,
    expiresAt: "2099-01-01T00:00:00Z",
  });
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <CliAuthApproval requestId="r" session={current} />
    </QueryClientProvider>,
  );
  client.clear();
  return html;
}
afterEach(() => vi.unstubAllGlobals());
describe("explicit CLI pairing approval", () => {
  it("displays the current natural-key identity, CLI label, verification code and a deliberate approve button", () => {
    const html = render("pending");
    expect(html).toContain("Alice");
    expect(html).toContain("tenant-a");
    expect(html).toContain("user-1");
    expect(html).toContain("My terminal");
    expect(html).toContain("A1B2C3D4");
    expect(html).toContain("确认授权此 CLI");
    expect(html).not.toContain("csrf-secret");
  });
  it("does not offer approval after success, expiration, or for service identities", () => {
    expect(render("approved")).toContain("taskctl auth complete");
    expect(render("approved")).not.toContain("确认授权此 CLI");
    expect(render("expired")).toContain("已过期");
    expect(render("expired")).not.toContain("确认授权此 CLI");
    const service = {
      ...session,
      actor: {
        ...session.actor,
        identity: { kind: "service" as const, serviceId: "local-admin" as const },
      },
    };
    expect(render("pending", service)).not.toContain("确认授权此 CLI");
  });
  it("only sends CSRF and an empty approval payload, never a claimed identity", async () => {
    let sent: RequestInit | undefined;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      sent = init;
      return Response.json({
        data: {
          requestId: "r",
          label: "My terminal",
          verificationCode: "A1B2C3D4",
          status: "approved",
          expiresAt: "2099-01-01T00:00:00Z",
        },
      });
    });
    expect((await approveCliRequest("r", "csrf-secret")).status).toBe("approved");
    expect(sent?.method).toBe("POST");
    expect(sent?.credentials).toBe("same-origin");
    expect(new Headers(sent?.headers).get("x-csrf-token")).toBe("csrf-secret");
    expect(JSON.parse(String(sent?.body))).toEqual({});
  });
});
