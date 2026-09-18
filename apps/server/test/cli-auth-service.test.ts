import { describe, expect, it } from "vitest";
import { CliAuthService } from "../src/modules/identity/cli-auth-service.js";
import type { UserIdentityRef } from "@codexboard/contracts";

const identity = { kind: "feishu", tenantKey: "tenant-a", userId: "user-1" } as const;
const webIdentity = { kind: "web", accountId: "11111111-1111-4111-8111-111111111111" } as const;
function setup() {
  let now = Date.parse("2026-09-09T00:00:00Z");
  const service = new CliAuthService({ now: () => now });
  return {
    service,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
describe("CLI pairing", () => {
  it("requires browser approval and private claim secret, issues a one-use claim and revocable session", () => {
    const { service } = setup();
    const request = service.create("My CLI");
    expect(service.inspect(request.requestId)).toMatchObject({
      label: "My CLI",
      status: "pending",
      verificationCode: request.verificationCode,
    });
    expect(service.inspect(request.requestId)).not.toHaveProperty("claimSecret");
    expect(service.complete(request.requestId, request.claimSecret)).toEqual({ status: "pending" });
    expect(() => service.complete(request.requestId, "wrong")).toThrow();
    service.approve(request.requestId, identity);
    expect(() => service.approve(request.requestId, { ...identity, tenantKey: "other" })).toThrow();
    const session = service.complete(request.requestId, request.claimSecret);
    expect(session).toHaveProperty("token");
    if (!("token" in session)) throw new Error("missing token");
    expect(service.authenticate(session.token)).toEqual(identity);
    expect(() => service.complete(request.requestId, request.claimSecret)).toThrow();
    expect(() => new CliAuthService().authenticate(session.token)).toThrow();
    service.revoke(session.token);
    expect(() => service.authenticate(session.token)).toThrow();
  });
  it("expires pending and approved challenges at ten minutes", () => {
    const { service, advance } = setup();
    const pending = service.create("pending");
    const approved = service.create("approved");
    service.approve(approved.requestId, identity);
    advance(600_000);
    expect(service.inspect(pending.requestId).status).toBe("expired");
    expect(() => service.approve(pending.requestId, identity)).toThrow();
    expect(() => service.complete(approved.requestId, approved.claimSecret)).toThrow();
  });
  it("expires sessions at eight hours and retains tenant identity", () => {
    const { service, advance } = setup();
    const request = service.create("cli");
    service.approve(request.requestId, { ...identity, tenantKey: "tenant-b" });
    const session = service.complete(request.requestId, request.claimSecret);
    if (!("token" in session)) throw new Error("missing token");
    expect(service.authenticate(session.token)).toMatchObject({ tenantKey: "tenant-b" });
    advance(28_800_000);
    expect(() => service.authenticate(session.token)).toThrow();
  });
  it("rejects forged, missing, and service identities", () => {
    const { service } = setup();
    const request = service.create("cli");
    for (const value of [
      { kind: "service", serviceId: "local-admin" },
      { kind: "feishu", tenantKey: "t" },
      { ...identity, actorId: "forged" },
    ]) {
      expect(() => service.approve(request.requestId, value as typeof identity)).toThrow();
    }
    expect(service.inspect(request.requestId).status).toBe("pending");
    expect(() => service.authenticate("invented")).toThrow();
    expect(() => service.create(" ")).toThrow();
  });
  it("does not let callers mutate the approved or authenticated identity", () => {
    const { service } = setup();
    const request = service.create("cli");
    const user = { ...identity };
    service.approve(request.requestId, user);
    user.tenantKey = "mutated" as "tenant-a";
    const session = service.complete(request.requestId, request.claimSecret);
    if (!("token" in session)) throw new Error("missing token");
    if (session.identity.kind !== "feishu") throw new Error("wrong identity");
    session.identity.tenantKey = "mutated";
    const authenticated = service.authenticate(session.token);
    expect(authenticated).toEqual(identity);
    if (authenticated.kind !== "feishu") throw new Error("wrong identity");
    authenticated.tenantKey = "mutated";
    expect(service.authenticate(session.token)).toEqual(identity);
  });
  it("pairs a Web identity and prevents a second user from replacing its approval", () => {
    const { service } = setup();
    const request = service.create("Web CLI");
    service.approve(request.requestId, webIdentity);
    expect(() => service.approve(request.requestId, identity)).toThrow("此请求已处理");
    const session = service.complete(request.requestId, request.claimSecret);
    if (!("token" in session)) throw new Error("missing token");
    expect(session.identity).toEqual(webIdentity);
    expect(service.authenticate(session.token)).toEqual(webIdentity);
    session.identity = identity;
    expect(service.authenticate(session.token)).toEqual(webIdentity);
  });
  it("revalidates user credential generations before approval, claim and every request", () => {
    let version = "0";
    let active = true;
    const checked: UserIdentityRef[] = [];
    const service = new CliAuthService({
      identityVersion: (user) => {
        checked.push(user);
        if (!active) throw new Error("inactive user");
        return version;
      },
    });
    const approved = service.create("not yet claimed");
    const claimed = service.create("claimed");
    service.approve(approved.requestId, webIdentity);
    service.approve(claimed.requestId, webIdentity);
    const session = service.complete(claimed.requestId, claimed.claimSecret);
    if (!("token" in session)) throw new Error("missing token");
    expect(service.authenticate(session.token)).toEqual(webIdentity);
    version = "1";
    expect(() => service.complete(approved.requestId, approved.claimSecret)).toThrow("已撤销");
    expect(() => service.authenticate(session.token)).toThrow("已撤销");
    const latest = service.create("after reset");
    active = false;
    expect(() => service.approve(latest.requestId, webIdentity)).toThrow("inactive user");
    expect(service.inspect(latest.requestId).status).toBe("pending");
    expect(checked).toHaveLength(7);
  });
});
