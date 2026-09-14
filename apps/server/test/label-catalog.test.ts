import { seedFeishuTestActor } from "./helpers/identity.js";
import { describe, expect, it, vi } from "vitest";

import { identityKey, type PrincipalView } from "@lark-codex/contracts";

import { AppError } from "../src/app-error.js";
import { initializeDatabase } from "../src/modules/database/index.js";
import { LabelCatalog } from "../src/modules/labels/index.js";
import { ProjectAdministration } from "../src/modules/project-registry/index.js";

const admin: PrincipalView = {
  identity: { kind: "feishu", tenantKey: "tenant", userId: "admin" },
  name: "管理员",
  avatarUrl: null,
  role: "admin",
};
const member: PrincipalView = {
  identity: { kind: "feishu", tenantKey: "tenant", userId: "member" },
  name: "普通成员",
  avatarUrl: null,
  role: "member",
};

function setup() {
  const database = initializeDatabase(":memory:");
  seedFeishuTestActor(database, admin);
  seedFeishuTestActor(database, member);
  const project = new ProjectAdministration(database).createProject({
    projectKey: "LABL",
    name: "标签项目",
    description: "",
  });
  const onRevisionCommitted = vi.fn();
  const catalog = new LabelCatalog({
    database,
    now: () => new Date("2026-09-03T01:00:00.000Z"),
    onRevisionCommitted,
  });
  return { database, project, catalog, onRevisionCommitted };
}

function context(actor: PrincipalView, idempotencyKey: string) {
  return { actor, idempotencyKey, requestId: `request-${idempotencyKey}` };
}

describe("global label catalog", () => {
  it("allows verified Feishu members to create and list labels idempotently", () => {
    const { database, catalog, onRevisionCommitted } = setup();

    expect(catalog.list(member)).toEqual({ labels: [] });
    const created = catalog.create({ name: "前端" }, context(member, "label-member-create"));
    expect(created.label).toMatchObject({ name: "前端", sortOrder: 0, version: 1 });
    expect(catalog.list(member).labels).toEqual([created.label]);
    expect(onRevisionCommitted).toHaveBeenCalledWith(created.revision);

    const replayed = catalog.create({ name: "前端" }, context(member, "label-member-create"));
    expect(replayed).toEqual(created);
    expect(database.prepare("SELECT count(*) FROM global_labels").pluck().get()).toBe(1);
  });

  it("rejects label access without Feishu login evidence even when a supplied role is admin", () => {
    const { database, catalog } = setup();
    const unverified: PrincipalView = {
      ...admin,
      identity: { kind: "feishu", tenantKey: "tenant", userId: "unverified" },
    };
    database
      .prepare(
        "INSERT INTO identities (identity_key, kind, tenant_key, user_id, name, role) VALUES (?, 'feishu', 'tenant', 'unverified', '自报管理员', 'admin')",
      )
      .run(identityKey(unverified.identity));
    expect(() => catalog.list(unverified)).toThrow(AppError);
    expect(() => catalog.create({ name: "不允许" }, context(unverified, "unverified"))).toThrow(
      AppError,
    );
    expect(database.prepare("SELECT count(*) FROM global_labels").pluck().get()).toBe(0);
  });

  it("renames and deletes a label across all tasks in one versioned transaction", () => {
    const { database, project, catalog } = setup();
    const created = catalog.create({ name: "旧标签" }, context(member, "label-create-old"));
    const insertTask = database.prepare(
      `INSERT INTO tasks (
        id, identifier, project_id, task_number, title, status, labels_json
      ) VALUES (?, ?, ?, ?, ?, 'todo', ?)`,
    );
    insertTask.run(
      "20000000-0000-4000-8000-000000000001",
      "LABL-001",
      project.id,
      1,
      "第一个任务",
      JSON.stringify(["旧标签", "保留"]),
    );
    insertTask.run(
      "20000000-0000-4000-8000-000000000002",
      "TEMP-001",
      "00000000-0000-4000-8000-0000000000a2",
      1,
      "第二个任务",
      JSON.stringify(["旧标签"]),
    );
    database
      .prepare(
        "INSERT INTO global_labels (id, name, sort_order, created_by_identity_key) VALUES (?, ?, ?, ?)",
      )
      .run("30000000-0000-4000-8000-000000000002", "保留", 1, identityKey(admin.identity));

    const renamed = catalog.update(
      created.label.id,
      { expectedVersion: 1, name: "新标签" },
      context(member, "label-rename"),
    );
    expect(renamed.label).toMatchObject({ name: "新标签", version: 2 });
    expect(
      (database.prepare("SELECT labels_json FROM tasks ORDER BY id").pluck().all() as string[]).map(
        (value) => JSON.parse(value),
      ),
    ).toEqual([["新标签", "保留"], ["新标签"]]);
    expect(database.prepare("SELECT version FROM tasks ORDER BY id").pluck().all()).toEqual([2, 2]);

    expect(() =>
      catalog.update(
        created.label.id,
        { expectedVersion: 1, name: "过期更新" },
        context(member, "label-stale-update"),
      ),
    ).toThrow(/版本/);

    const removed = catalog.delete(
      created.label.id,
      { expectedVersion: 2 },
      context(member, "label-delete"),
    );
    expect(removed.labelId).toBe(created.label.id);
    expect(
      (database.prepare("SELECT labels_json FROM tasks ORDER BY id").pluck().all() as string[]).map(
        (value) => JSON.parse(value),
      ),
    ).toEqual([["保留"], []]);
    expect(database.prepare("SELECT version FROM tasks ORDER BY id").pluck().all()).toEqual([3, 3]);
    expect(
      database
        .prepare("SELECT count(*) FROM activities WHERE kind = 'task.labels.updated'")
        .pluck()
        .get(),
    ).toBe(4);
  });

  it("requires a complete unique label ordering and applies long-distance moves at once", () => {
    const { catalog } = setup();
    const first = catalog.create({ name: "一" }, context(member, "label-order-one")).label;
    const second = catalog.create({ name: "二" }, context(member, "label-order-two")).label;
    const third = catalog.create({ name: "三" }, context(member, "label-order-three")).label;

    expect(() =>
      catalog.reorder(
        { labelIds: [third.id, first.id] },
        context(member, "label-order-incomplete"),
      ),
    ).toThrow(/完整/);

    const reordered = catalog.reorder(
      { labelIds: [third.id, first.id, second.id] },
      context(member, "label-order-complete"),
    );
    expect(reordered.labels.map((label) => [label.name, label.sortOrder])).toEqual([
      ["三", 0],
      ["一", 1],
      ["二", 2],
    ]);
  });
});
