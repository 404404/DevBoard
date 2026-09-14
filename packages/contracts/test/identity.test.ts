import { describe, expect, it } from "vitest";
import * as contracts from "../src/index.js";

const person = { kind: "feishu", tenantKey: "tenant-a", userId: "user-1" } as const;

describe("natural identity references", () => {
  it("requires structured Feishu identities in task commands", () => {
    const input = {
      projectId: "00000000-0000-4000-8000-000000000001",
      title: "task",
      assigneeIdentity: person,
    };
    expect(contracts.CreateTaskCommandSchema.parse(input)).toHaveProperty(
      "assigneeIdentity",
      person,
    );
    for (const invalid of [
      "00000000-0000-4000-8000-000000000002",
      '["feishu","tenant-a","user-1"]',
      { kind: "service", serviceId: "codex" },
      { kind: "feishu", tenantKey: "tenant-a" },
    ]) {
      expect(
        contracts.CreateTaskCommandSchema.safeParse({ ...input, assigneeIdentity: invalid })
          .success,
      ).toBe(false);
    }
    expect(
      contracts.CreateTaskCommandSchema.safeParse({
        ...input,
        assigneeActorId: "00000000-0000-4000-8000-000000000002",
      }).success,
    ).toBe(false);
  });

  it("round trips natural keys and distinguishes tenants and services", () => {
    expect(contracts.identityKey(person)).toBe('["feishu","tenant-a","user-1"]');
    expect(contracts.identityFromKey('["feishu","tenant-a","user-1"]')).toEqual(person);
    expect(contracts.identityFromKey('["service","codex"]')).toEqual({
      kind: "service",
      serviceId: "codex",
    });
    expect(contracts.sameIdentity(person, { ...person })).toBe(true);
    expect(contracts.sameIdentity(person, { ...person, tenantKey: "tenant-b" })).toBe(false);
    expect(
      contracts.sameIdentity(
        { kind: "service", serviceId: "codex" },
        { kind: "service", serviceId: "local-admin" },
      ),
    ).toBe(false);
  });

  it("rejects legacy, ambiguous and noncanonical identity representations", () => {
    for (const input of [
      "uuid",
      '["service","unknown"]',
      '[ "service", "codex" ]',
      '["service","codex",null]',
      '["feishu","","u"]',
      '{"kind":"service","serviceId":"codex"}',
    ]) {
      expect(() => contracts.identityFromKey(input)).toThrow();
      expect(contracts.IdentityKeySchema.safeParse(input).success).toBe(false);
    }
    for (const input of [
      "uuid",
      { ...person, openId: "ou_old" },
      { ...person, userId: "" },
      { kind: "service", serviceId: "unknown" },
    ]) {
      expect(contracts.IdentityRefSchema.safeParse(input).success).toBe(false);
    }
  });
});

it("keeps user and service references structured across public response fields", () => {
  const principal = { identity: person, name: "用户", avatarUrl: null, role: "member" };
  expect(contracts.PrincipalViewSchema.parse(principal).identity).toEqual(person);
  expect(
    contracts.PrincipalSummarySchema.parse({
      identity: { kind: "service", serviceId: "codex" },
      name: "Codex",
    }).identity.kind,
  ).toBe("service");
  for (const identity of [
    "00000000-0000-4000-8000-000000000001",
    '["feishu","tenant-a","user-1"]',
  ]) {
    expect(contracts.PrincipalViewSchema.safeParse({ ...principal, identity }).success).toBe(false);
    expect(
      contracts.TaskAssigneeCandidateSchema.safeParse({
        identity,
        name: "用户",
        avatarUrl: null,
        actorRole: "member",
        projectRole: "viewer",
      }).success,
    ).toBe(false);
    expect(contracts.JobViewSchema.shape.requestedBy.safeParse(identity).success).toBe(false);
    expect(contracts.InteractionViewSchema.shape.decidedBy.safeParse(identity).success).toBe(false);
    expect(
      contracts.ProjectTaskCreationOptionsViewSchema.shape.currentIdentity.safeParse(identity)
        .success,
    ).toBe(false);
  }
  expect(
    contracts.JobViewSchema.shape.requestedBy.parse({ kind: "service", serviceId: "codex" }),
  ).toEqual({ kind: "service", serviceId: "codex" });
});

it("rejects legacy assignee edits", () => {
  expect(
    contracts.UpdateTaskCommandSchema.parse({ expectedVersion: 1, assigneeIdentity: person }),
  ).toEqual({ expectedVersion: 1, assigneeIdentity: person });
  expect(
    contracts.UpdateTaskCommandSchema.safeParse({
      expectedVersion: 1,
      assigneeActorId: "00000000-0000-4000-8000-000000000001",
    }).success,
  ).toBe(false);
  expect(
    contracts.UpdateTaskCommandSchema.safeParse({
      expectedVersion: 1,
      assigneeIdentity: { kind: "service", serviceId: "codex" },
    }).success,
  ).toBe(false);
});

it("retains service assignees only in historical task reads", () => {
  const service = { kind: "service", serviceId: "local-admin" };
  expect(contracts.TaskViewBaseSchema.shape.assigneeIdentity.parse(service)).toEqual(service);
  expect(
    contracts.CreateTaskCommandSchema.safeParse({
      projectId: "00000000-0000-4000-8000-000000000001",
      title: "new",
      assigneeIdentity: service,
    }).success,
  ).toBe(false);
  expect(
    contracts.UpdateTaskCommandSchema.safeParse({ expectedVersion: 1, assigneeIdentity: service })
      .success,
  ).toBe(false);
});
