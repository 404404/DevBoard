import { TEST_FEISHU_ACTOR, seedFeishuTestActor } from "./helpers/identity.js";
import { CreateTaskCommandSchema, type PrincipalView } from "@codexboard/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { initializeDatabase, type SqliteDatabase } from "../src/modules/database/index.js";
import { EventFeed } from "../src/modules/event-feed/index.js";
import {
  DevelopmentIdentityAdapter,
  DEVELOPMENT_IDENTITY,
  IdentityService,
} from "../src/modules/identity/index.js";
import { ProjectAdministration } from "../src/modules/project-registry/index.js";
import { Taskboard } from "../src/modules/taskboard/index.js";

const ADMIN_ACTOR: PrincipalView = TEST_FEISHU_ACTOR;

const openDatabases: SqliteDatabase[] = [];
const openFeeds: EventFeed[] = [];

afterEach(() => {
  for (const feed of openFeeds.splice(0)) {
    feed.close();
  }
  for (const database of openDatabases.splice(0)) {
    if (database.open) {
      database.close();
    }
  }
});

function setup(historyLimit = 100) {
  const database = initializeDatabase(":memory:");
  seedFeishuTestActor(database);
  openDatabases.push(database);
  const identityService = new IdentityService({
    database,
    provider: new DevelopmentIdentityAdapter(),
    sessionTtlSeconds: 300,
  });
  identityService.ensureDevelopmentActor(DEVELOPMENT_IDENTITY);
  const administration = new ProjectAdministration(database);
  const firstProject = administration.createProject({
    projectKey: "FEED",
    name: "事件项目",
    description: "",
  });
  const secondProject = administration.createProject({
    projectKey: "OTHER",
    name: "其他项目",
    description: "",
  });
  const eventFeed = new EventFeed({ database, historyLimit, subscriptionPageSize: 2 });
  openFeeds.push(eventFeed);
  const taskboard = new Taskboard({
    database,
    identityService,
    onRevisionCommitted: (revision) => eventFeed.notifyCommitted(revision),
  });
  return { database, eventFeed, firstProject, secondProject, taskboard };
}

function createTask(taskboard: Taskboard, projectId: string, title: string, key: string) {
  return taskboard.createTask(CreateTaskCommandSchema.parse({ projectId, title }), {
    actor: ADMIN_ACTOR,
    idempotencyKey: key,
  });
}

function nextWithTimeout<Output>(iterator: AsyncIterator<Output>): Promise<IteratorResult<Output>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("等待事件超时")), 1_000);
    void iterator.next().then(
      (result) => {
        clearTimeout(timeout);
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

describe("EventFeed module", () => {
  it("includes project aggregate changes in the matching project's history", () => {
    const { eventFeed, firstProject, secondProject } = setup();

    expect(
      eventFeed.readSince({ projectId: firstProject.id, afterRevision: 0, limit: 100 }).events,
    ).toContainEqual(
      expect.objectContaining({
        aggregateType: "project",
        aggregateId: firstProject.id,
        eventType: "project.created",
        safePayload: expect.objectContaining({ projectId: firstProject.id, projectKey: "FEED" }),
      }),
    );
    expect(
      eventFeed.readSince({ projectId: firstProject.id, afterRevision: 0, limit: 100 }).events,
    ).not.toContainEqual(expect.objectContaining({ aggregateId: secondProject.id }));
  });

  it("reads project-scoped pages without losing global revision gaps", () => {
    const { database, eventFeed, firstProject, secondProject, taskboard } = setup();
    const startingRevision = Number(
      database.prepare("SELECT coalesce(max(revision), 0) FROM change_events").pluck().get(),
    );
    const first = createTask(taskboard, firstProject.id, "事件一", "feed-page-0001");
    const other = createTask(taskboard, secondProject.id, "其他事件", "feed-page-0002");
    const second = createTask(taskboard, firstProject.id, "事件二", "feed-page-0003");

    const firstPage = eventFeed.readSince({
      projectId: firstProject.id,
      afterRevision: startingRevision,
      limit: 1,
    });
    const secondPage = eventFeed.readSince({
      projectId: firstProject.id,
      afterRevision: firstPage.cursorRevision,
      limit: 10,
    });
    const otherPage = eventFeed.readSince({
      projectId: secondProject.id,
      afterRevision: startingRevision,
      limit: 10,
    });

    expect(firstPage).toMatchObject({
      events: [{ revision: first.revision }],
      latestRevision: second.revision,
      cursorRevision: first.revision,
      hasMore: true,
    });
    expect(secondPage).toMatchObject({
      events: [{ revision: second.revision }],
      cursorRevision: second.revision,
      hasMore: false,
    });
    expect(otherPage.events.map((event) => event.revision)).toEqual([other.revision]);
  });

  it("broadcasts one committed revision to multiple clients and deduplicates wakeups", async () => {
    const { database, eventFeed, firstProject, taskboard } = setup();
    const cursor = Number(
      database.prepare("SELECT coalesce(max(revision), 0) FROM change_events").pluck().get(),
    );
    const firstController = new AbortController();
    const secondController = new AbortController();
    const firstIterator = eventFeed
      .subscribe({
        projectId: firstProject.id,
        afterRevision: cursor,
        signal: firstController.signal,
      })
      [Symbol.asyncIterator]();
    const secondIterator = eventFeed
      .subscribe({
        projectId: firstProject.id,
        afterRevision: cursor,
        signal: secondController.signal,
      })
      [Symbol.asyncIterator]();
    const firstWaiting = nextWithTimeout(firstIterator);
    const secondWaiting = nextWithTimeout(secondIterator);
    const created = createTask(taskboard, firstProject.id, "广播任务", "feed-live-0001");

    await expect(firstWaiting).resolves.toMatchObject({
      value: { kind: "change", revision: created.revision },
    });
    await expect(secondWaiting).resolves.toMatchObject({
      value: { kind: "change", revision: created.revision },
    });

    eventFeed.notifyCommitted(created.revision);
    eventFeed.notifyCommitted(created.revision);
    const nextWaiting = nextWithTimeout(firstIterator);
    const next = createTask(taskboard, firstProject.id, "下一修订", "feed-live-0002");
    await expect(nextWaiting).resolves.toMatchObject({
      value: { kind: "change", revision: next.revision },
    });

    firstController.abort();
    secondController.abort();
    await firstIterator.return?.();
    await secondIterator.return?.();
  });

  it("compensates disconnected clients and preserves cursors across service restarts", () => {
    const { database, eventFeed, firstProject, taskboard } = setup();
    const first = createTask(taskboard, firstProject.id, "断线前", "feed-restart-0001");
    const second = createTask(taskboard, firstProject.id, "断线期间", "feed-restart-0002");
    eventFeed.close();

    const restarted = new EventFeed({ database, historyLimit: 100 });
    openFeeds.push(restarted);
    const recovered = restarted.readSince({
      projectId: firstProject.id,
      afterRevision: first.revision,
      limit: 100,
    });
    const cursorAhead = restarted.readSince({
      projectId: firstProject.id,
      afterRevision: second.revision + 10,
      limit: 100,
    });

    expect(recovered).toMatchObject({
      events: [{ revision: second.revision }],
      cursorRevision: second.revision,
      historyTruncated: false,
      cursorAhead: false,
    });
    expect(cursorAhead).toMatchObject({
      events: [],
      latestRevision: second.revision,
      cursorAhead: true,
    });
  });

  it("requires a full refresh when a slow client falls outside the history window", async () => {
    const { eventFeed, firstProject, taskboard } = setup(2);
    createTask(taskboard, firstProject.id, "旧修订", "feed-window-0001");
    createTask(taskboard, firstProject.id, "中间修订", "feed-window-0002");
    const latest = createTask(taskboard, firstProject.id, "最新修订", "feed-window-0003");
    const iterator = eventFeed
      .subscribe({ projectId: firstProject.id, afterRevision: 0 })
      [Symbol.asyncIterator]();

    await expect(nextWithTimeout(iterator)).resolves.toMatchObject({
      value: {
        kind: "refresh_required",
        revision: latest.revision,
        reason: "history_truncated",
      },
    });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });
});
