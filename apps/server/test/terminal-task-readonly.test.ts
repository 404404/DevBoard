import { seedFeishuTestActor, TEST_FEISHU_ACTOR } from "./helpers/identity.js";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CreateTaskCommandSchema, type PrincipalView } from "@lark-taskboard/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { AttachmentService, AttachmentVault } from "../src/modules/attachments/index.js";
import { initializeDatabase } from "../src/modules/database/index.js";
import { ExecutionQueue } from "../src/modules/execution/index.js";
import {
  DevelopmentIdentityAdapter,
  DEVELOPMENT_IDENTITY,
  IdentityService,
} from "../src/modules/identity/index.js";
import { ProjectAdministration } from "../src/modules/project-registry/index.js";
import { Taskboard, TaskWorkspace } from "../src/modules/taskboard/index.js";
import { TaskGitFinalizer } from "../src/modules/taskboard/task-git-finalizer.js";
import { TaskLifecycleService } from "../src/modules/taskboard/task-lifecycle-service.js";

const actor: PrincipalView = {
  identity: TEST_FEISHU_ACTOR.identity,
  name: "管理员",
  avatarUrl: null,
  role: "admin",
};
const context = () => ({ actor, idempotencyKey: randomUUID() });
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((dispose) => dispose()));

function setup(status: "done" | "canceled") {
  const database = initializeDatabase(":memory:");
  const root = mkdtempSync(join(tmpdir(), "terminal-readonly-"));
  cleanup.push(() => {
    database.close();
    rmSync(root, { recursive: true, force: true });
  });
  const identityService = new IdentityService({
    database,
    provider: new DevelopmentIdentityAdapter(),
    sessionTtlSeconds: 300,
  });
  identityService.ensureDevelopmentActor(DEVELOPMENT_IDENTITY);
  seedFeishuTestActor(database, actor);
  const project = new ProjectAdministration(database).createProject({
    projectKey: "READ",
    name: "只读任务",
    description: "",
  });
  const taskboard = new Taskboard({ database, identityService });
  const workspace = new TaskWorkspace({ database, identityService, taskboard });
  const attachments = new AttachmentService({
    database,
    identityService,
    taskboard,
    vault: new AttachmentVault({ rootDirectory: root }),
  });
  const lifecycle = new TaskLifecycleService({
    database,
    taskboard,
    queue: new ExecutionQueue({ database }),
    gitFinalizer: new TaskGitFinalizer([]),
    scheduleExecution: () => {},
  });
  const create = (title: string) =>
    taskboard.createTask(CreateTaskCommandSchema.parse({ projectId: project.id, title }), context())
      .task;
  const task = create("保留任务");
  const other = create("活动任务");
  const comment = workspace.createComment(task.id, { body: "保留评论" }, context()).data;
  const upload = { filename: "keep.txt", contentType: "text/plain", bytes: Buffer.from("keep") };
  const attachment = attachments.upload(task.id, upload, context()).data;
  const relation = workspace.createRelation(
    task.id,
    { relationType: "related", targetTaskId: other.id },
    context(),
  ).data;
  database.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, task.id);
  return {
    database,
    taskboard,
    workspace,
    attachments,
    lifecycle,
    task: taskboard.readTask(task.id, actor),
    other,
    comment,
    attachment,
    relation,
    upload,
    project,
  };
}

describe.each(["done", "canceled"] as const)("%s tasks are read-only", (status) => {
  it("rejects content, state, comment, attachment, and lifecycle mutations", () => {
    const s = setup(status);
    const attempts = [
      () =>
        s.taskboard.updateTask(
          s.task.id,
          { expectedVersion: s.task.version, title: "changed" },
          context(),
        ),
      () =>
        s.taskboard.moveTask(
          s.task.id,
          { expectedVersion: s.task.version, targetStatus: "todo" },
          context(),
        ),
      () => s.workspace.createComment(s.task.id, { body: "changed" }, context()),
      () =>
        s.workspace.updateComment(
          s.comment.id,
          { expectedVersion: s.comment.version, body: "changed" },
          context(),
        ),
      () =>
        s.workspace.deleteComment(s.comment.id, { expectedVersion: s.comment.version }, context()),
      () => s.attachments.authorizeUpload(s.task.id, actor),
      () => s.attachments.upload(s.task.id, s.upload, context()),
      () => s.attachments.delete(s.attachment.id, context()),
      () =>
        s.lifecycle.request(
          s.task.id,
          { expectedVersion: s.task.version, targetStatus: "canceled" },
          context(),
        ),
    ];
    for (const attempt of attempts) expect(attempt).toThrow(/只读/);
    expect(s.taskboard.readTask(s.task.id, actor)).toMatchObject({ title: "保留任务", status });
    expect(s.workspace.readTaskWorkspace(s.task.id, actor).comments[0]?.body).toBe("保留评论");
  });

  it("rejects relation changes from either task and from task creation", () => {
    const s = setup(status);
    for (const [source, target] of [
      [s.task, s.other],
      [s.other, s.task],
    ]) {
      expect(() =>
        s.workspace.createRelation(
          source!.id,
          { relationType: "related", targetTaskId: target!.id },
          context(),
        ),
      ).toThrow(/只读/);
      expect(() => s.workspace.deleteRelation(source!.id, s.relation.id, context())).toThrow(
        /只读/,
      );
    }
    expect(() =>
      s.taskboard.createTask(
        CreateTaskCommandSchema.parse({
          projectId: s.project.id,
          title: "不能修改已结束任务的关系",
          initialRelations: { relatedTaskIds: [s.task.id] },
        }),
        context(),
      ),
    ).toThrow(/只读/);
  });
});

it("allows the separate restore action to make a canceled task editable again", () => {
  const s = setup("canceled");
  const restored = s.taskboard.restoreTask(
    s.task.id,
    { expectedVersion: s.task.version },
    context(),
  ).task;
  expect(
    s.taskboard.updateTask(
      restored.id,
      { expectedVersion: restored.version, title: "恢复后可修改" },
      context(),
    ).task.title,
  ).toBe("恢复后可修改");
});
