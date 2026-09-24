import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";
import type { IdentityRef, RuntimeDescriptor } from "@codexboard/contracts";
import {
  credentialPaths,
  defaultCredentialStore,
  readCredential,
  SessionCredentialSchema,
} from "../packages/taskctl/src/auth.js";
import {
  e2eOrigin,
  establishSyntheticFeishuSession,
  SYNTHETIC_FEISHU_IDENTITY,
  SYNTHETIC_FEISHU_NAME,
  syntheticAuthFile,
} from "./helpers/synthetic-identity.js";

test.beforeAll(async ({ playwright }) => {
  const request = await playwright.request.newContext();
  try {
    const csrfToken = await establishSyntheticFeishuSession(request);
    const pending = taskctl("auth", "login", "--label", "Isolated E2E synthetic user").data;
    const approval = await request.post(
      `${e2eOrigin()}/api/v1/auth/cli/requests/${String(pending.requestId)}/approve`,
      {
        headers: { Origin: e2eOrigin(), "X-CSRF-Token": csrfToken },
        data: {},
      },
    );
    expect(approval.status()).toBe(200);
    expect(taskctl("auth", "complete").data.identity).toEqual(SYNTHETIC_FEISHU_IDENTITY);
  } finally {
    await request.dispose();
  }
});

interface DevelopmentContextFixture {
  readonly id: string;
  readonly kind: "branch" | "worktree";
  readonly label: string;
}

interface TaskFixture {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly labels: readonly string[];
  readonly assigneeIdentity: IdentityRef | null;
  readonly developmentContextId: string | null;
  readonly links: readonly string[];
}

test("开发会话保留服务来源且不能冒充飞书用户创建任务", async ({ page }) => {
  const project = await registerProject("SERVICEIDENTITY");
  // Intentionally omit the synthetic-user fixture: this exercises actual automatic dev login.
  await page.goto("/");
  await expect(page.getByRole("button", { name: /切换项目，当前/ })).toBeVisible();
  const session = await readPublicData<{ actor: { identity: IdentityRef } }>(
    page,
    "/api/v1/session",
  );
  expect(session.actor.identity).toEqual({ kind: "service", serviceId: "local-admin" });
  const status = await page.evaluate(async (projectId) => {
    const { data: session } = await (await fetch("/api/v1/session")).json();
    return (
      await fetch("/api/v1/tasks", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": session.csrfToken,
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({ projectId, title: "服务不能创建这条任务" }),
      })
    ).status;
  }, project.id);
  expect(status).toBe(403);
  const board = await readPublicData<{ tasks: TaskFixture[] }>(
    page,
    `/api/v1/projects/${project.id}/board`,
  );
  expect(board.tasks).toEqual([]);
});

test("详情自动保存串行提交并在失败后保留草稿", async ({ page }) => {
  const project = await registerProject("AUTOSAVE");
  await openWorkspace(page);
  await selectProject(page, project);
  const detail = await createTaskAndOpenDetail(page, "自动保存验证");
  const original = (
    await readPublicData<{ tasks: TaskFixture[] }>(page, `/api/v1/projects/${project.id}/board`)
  ).tasks[0]!;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requests = 0;
  await page.route(`**/api/v1/tasks/${original.id}`, async (route) => {
    if (route.request().method() === "PATCH" && ++requests === 1) await gate;
    await route.continue();
  });
  await detail.getByLabel("标题", { exact: true }).fill("第一笔标题");
  await detail.getByLabel("标题", { exact: true }).blur();
  await detail.getByRole("button", { name: "优先级", exact: true }).click();
  await detail.getByRole("option", { name: "高", exact: true }).click();
  await detail.getByLabel("标题", { exact: true }).fill("保存期间继续输入");
  await expect(detail.getByText("正在保存…", { exact: true })).toBeVisible();
  release();
  await expect
    .poll(
      async () => (await readPublicData<TaskFixture>(page, `/api/v1/tasks/${original.id}`)).title,
    )
    .toBe("第一笔标题");
  await expect(detail.getByLabel("标题", { exact: true })).toHaveValue("保存期间继续输入");
  await detail.getByLabel("标题", { exact: true }).blur();
  await expect(detail.getByText("已自动保存", { exact: true })).toBeVisible();
  const updated = await readPublicData<TaskFixture & { priority: string; version: number }>(
    page,
    `/api/v1/tasks/${original.id}`,
  );
  expect(updated.title).toBe("保存期间继续输入");
  expect(updated.priority).toBe("high");
  expect(updated.version).toBe(4);
  await page.unroute(`**/api/v1/tasks/${original.id}`);
  await page.route(`**/api/v1/tasks/${original.id}`, async (route) => {
    if (route.request().method() === "PATCH") await route.abort();
    else await route.continue();
  });
  await detail.getByLabel("标题", { exact: true }).fill("失败后保留的标题");
  await detail.getByRole("button", { name: "返回看板" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(detail.getByLabel("标题", { exact: true })).toHaveValue("失败后保留的标题");
  await page.unroute(`**/api/v1/tasks/${original.id}`);
  await detail.getByRole("button", { name: "重试保存" }).click();
  await expect(detail.getByText("已自动保存", { exact: true })).toBeVisible();
  await detail.getByRole("button", { name: "编辑描述" }).click();
  await detail.getByLabel("描述", { exact: true }).fill("放弃这份描述");
  await detail.getByLabel("描述", { exact: true }).press("Escape");
  await expect(detail.locator(".detail-description-read")).not.toContainText("放弃这份描述");
  await detail.getByRole("button", { name: "返回看板" }).click();
  await page.getByTestId(`task-card-${original.identifier}`).getByRole("button").first().click();
  await expect(detail.getByLabel("标题", { exact: true })).toHaveValue("失败后保留的标题");
});

test("详情在桌面与手机宽度不溢出且长标题可完整编辑", async ({ page }, testInfo) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  const project = await registerProject("DETAILUI");
  await openWorkspace(page);
  await selectProject(page, project);
  await quickCreate(page, "用于验证手机关联选择器的长标题任务，较长的选项也不能撑出屏幕");
  const detail = await createTaskAndOpenDetail(
    page,
    "任务详情：优化自动保存与移动端阅读体验，让每一次修改都能完整保留",
    async (dialog) => {
      await dialog
        .getByLabel("任务描述")
        .fill(
          "## 实现目标\n\n对齐任务详情页的布局和交互，支持 **自动保存** 与手机操作。\n\n- 连续修改属性时按顺序保存\n- 网络异常时保留草稿\n- 手机上可以完整查看长标题",
        );
    },
  );
  for (const width of [1440, 768, 620, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await detail.locator(".task-detail-scroll").evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect
      .poll(() =>
        detail
          .getByLabel("标题", { exact: true })
          .evaluate((element) => element.scrollHeight - element.clientHeight),
      )
      .toBeLessThanOrEqual(1);
    const geometry = await detail.evaluate((element) => {
      const scroll = element.querySelector(".task-detail-scroll")!;
      const title = element.querySelector("textarea")!;
      const main = element.querySelector(".task-detail-main")!.getBoundingClientRect();
      const properties = element.querySelector(".task-detail-properties")!.getBoundingClientRect();
      return {
        documentHeight: document.documentElement.scrollHeight,
        viewportHeight: window.innerHeight,
        detailHeight: element.clientHeight,
        scrollHeight: scroll.clientHeight,
        overflow: scroll.scrollWidth - scroll.clientWidth,
        titleOverflow: title.scrollHeight - title.clientHeight,
        main: { x: main.x, y: main.y },
        properties: { x: properties.x, y: properties.y },
      };
    });
    writeFileSync(testInfo.outputPath(`geometry-${width}.json`), JSON.stringify(geometry));
    expect(geometry.overflow, `width ${width}`).toBeLessThanOrEqual(1);
    expect(geometry.documentHeight, `document height at ${width}`).toBeLessThanOrEqual(
      geometry.viewportHeight + 1,
    );
    expect(geometry.titleOverflow, `title width ${width}`).toBeLessThanOrEqual(1);
    if (width > 760) expect(geometry.properties.x).toBeGreaterThan(geometry.main.x);
    else expect(geometry.properties.y).toBeLessThan(geometry.main.y);
    await page.screenshot({
      path: testInfo.outputPath(`task-detail-${width}.png`),
      fullPage: true,
    });
    expect(browserErrors).toEqual([]);
    if (width <= 620) {
      await expect(detail.getByRole("button", { name: "状态", exact: true })).toBeVisible();
      const height = await detail
        .getByRole("button", { name: "状态", exact: true })
        .evaluate((element) => element.getBoundingClientRect().height);
      expect(height).toBeGreaterThanOrEqual(44);
      await detail.getByLabel("新评论").scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`task-detail-content-${width}.png`) });
    }
  }
});

test("离线返回保留标题草稿并在恢复连接后保存", async ({ page, context }) => {
  const project = await registerProject("LINKDRAFT");
  await openWorkspace(page);
  await selectProject(page, project);
  const detail = await createTaskAndOpenDetail(page, "标题草稿断线验证");
  await detail.getByLabel("标题", { exact: true }).fill("离线保留的标题草稿");
  await context.setOffline(true);
  await expect(detail.getByLabel("标题", { exact: true })).toBeDisabled();
  await detail.getByRole("button", { name: "返回看板" }).click();
  await expect(detail).toBeVisible();
  await expect(detail.getByLabel("标题", { exact: true })).toHaveValue("离线保留的标题草稿");
  await context.setOffline(false);
  await expect(detail.getByLabel("标题", { exact: true })).toBeEnabled();
  await detail.getByLabel("标题", { exact: true }).focus();
  await detail.getByLabel("标题", { exact: true }).blur();
  await expect(detail.getByText("已自动保存", { exact: true })).toBeVisible();
  const data = await readPublicData<{ tasks: TaskFixture[] }>(
    page,
    `/api/v1/projects/${project.id}/board`,
  );
  expect(data.tasks[0]!.title).toBe("离线保留的标题草稿");
});

test("详情地址可定位任务和项目且只读用户不能编辑", async ({ page }) => {
  const project = await registerProject("DETAILLINK");
  await openWorkspace(page);
  await selectProject(page, project);
  const detail = await createTaskAndOpenDetail(page, "详情链接与只读验证");
  await expect(detail.getByRole("button", { name: "复制链接", exact: true })).toHaveCount(0);
  const currentTask = (
    await readPublicData<{ tasks: TaskFixture[] }>(page, `/api/v1/projects/${project.id}/board`)
  ).tasks[0]!;
  const deepLink = new URL(page.url());
  deepLink.searchParams.set("project", project.id);
  deepLink.searchParams.set("task", currentTask.id);
  const url = deepLink.href;
  const taskId = currentTask.id;
  await detail.getByRole("button", { name: "返回看板" }).click();
  await selectProjectByName(page, "临时项目");
  let writes = 0;
  await page.route(`**/api/v1/tasks/${taskId}`, async (route) => {
    if (route.request().method() !== "GET") {
      writes++;
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const body = await response.json();
    body.data.permissions = {
      canRead: true,
      canWrite: false,
      canExecute: false,
      canReassign: false,
    };
    await route.fulfill({ response, json: body });
  });
  await page.goto(url);
  await expect(detail).toBeVisible();
  await expect(page.locator(".detail-project-context")).toHaveText(project.name);
  await expect(detail.getByLabel("标题", { exact: true })).toBeDisabled();
  await expect(detail.getByRole("button", { name: "状态", exact: true })).toBeDisabled();
  await expect(detail.getByRole("button", { name: "优先级", exact: true })).toBeDisabled();
  await expect(detail.getByRole("button", { name: /^标签：/ })).toBeDisabled();
  await expect(detail.getByRole("button", { name: "编辑描述" })).toHaveCount(0);
  await expect(detail.getByText("只读", { exact: true })).toBeVisible();
  await detail.getByRole("button", { name: "返回看板" }).click();
  await expect(
    page.getByRole("button", { name: new RegExp(`当前：${project.name}`) }),
  ).toBeVisible();
  expect(new URL(page.url()).searchParams.has("task")).toBe(false);
  expect(writes).toBe(0);
});

interface TaskWorkspaceFixture {
  readonly task: TaskFixture;
  readonly relations: readonly {
    readonly targetTaskId: string;
    readonly targetIdentifier: string;
    readonly relationType: "parent" | "child" | "blocks" | "blocked_by" | "related";
  }[];
}

interface RegisteredProject {
  readonly id: string;
  readonly projectKey: string;
  readonly name: string;
  readonly version: number;
  readonly codexProjectId: string;
  readonly rootPath: string;
}

interface SnapshotProject {
  readonly codexProjectId: string;
  readonly name: string;
  readonly rootPaths: readonly string[];
  readonly position: number;
}

interface ProjectSnapshot {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly projects: readonly SnapshotProject[];
}

function temporaryProjectRoot(): string {
  const root = process.env.CODEXBOARD_TEMPORARY_PROJECT_ROOT;
  if (!root) throw new Error("CODEXBOARD_TEMPORARY_PROJECT_ROOT is required for E2E tests");
  return root;
}

function taskctl(...args: string[]): { data: Record<string, unknown> } {
  const dataDirectory = process.env.CODEXBOARD_DATA_DIR;
  if (!dataDirectory) throw new Error("CODEXBOARD_DATA_DIR is required");
  const output = execFileSync(
    process.execPath,
    [resolve("node_modules/tsx/dist/cli.mjs"), resolve("packages/taskctl/src/cli.ts"), ...args],
    {
      env: {
        ...process.env,
        CODEXBOARD_DATA_DIR: dataDirectory,
        CODEXBOARD_AUTH_FILE: taskctlAuthFile(),
      },
      encoding: "utf8",
    },
  );
  return JSON.parse(output) as { data: Record<string, unknown> };
}

function taskctlAuthFile(): string {
  return `${syntheticAuthFile()}-${process.pid}`;
}

async function localUserHeaders(descriptor: RuntimeDescriptor): Promise<Record<string, string>> {
  // Only read the worker's disposable E2E credential; never fall back to a user's
  // installed CLI session. beforeAll issues this credential through real pairing.
  const paths = credentialPaths(descriptor, taskctlAuthFile());
  const credential = await readCredential(
    defaultCredentialStore,
    paths.session,
    SessionCredentialSchema,
    paths.scope,
    Date.now(),
  );
  if (!credential) throw new Error("The E2E worker has not completed CLI pairing");
  expect(credential.identity).toEqual(SYNTHETIC_FEISHU_IDENTITY);
  return {
    Authorization: `Bearer ${descriptor.capabilityToken}`,
    "X-Taskctl-Session": credential.token,
  };
}

function uniqueProjectKey(prefix: string): string {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  return `${prefix}${suffix}`.slice(0, 24);
}

function snapshotPath(): string {
  const dataDirectory = process.env.CODEXBOARD_DATA_DIR;
  if (!dataDirectory) {
    throw new Error("CODEXBOARD_DATA_DIR is required for isolated E2E tests");
  }
  return (
    process.env.CODEXBOARD_CODEX_PROJECT_SNAPSHOT_FILE ??
    resolve(dataDirectory, "run/codex-projects.json")
  );
}

function updateProjectSnapshot(
  mutate: (projects: readonly SnapshotProject[]) => readonly SnapshotProject[],
): ProjectSnapshot {
  const path = snapshotPath();
  const current = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as ProjectSnapshot)
    : ({ schemaVersion: 1, generatedAt: new Date(0).toISOString(), projects: [] } as const);
  const snapshot: ProjectSnapshot = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    projects: mutate(current.projects).map((project, position) => ({ ...project, position })),
  };
  const temporaryPath = `${path}.${process.pid}-${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(snapshot)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, path);
  return snapshot;
}

async function localProjects(): Promise<readonly RegisteredProject[]> {
  const dataDirectory = process.env.CODEXBOARD_DATA_DIR as string;
  const descriptorPath = resolve(dataDirectory, "run/runtime.json");
  await expect.poll(() => existsSync(descriptorPath)).toBe(true);
  const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8")) as RuntimeDescriptor;
  const response = await fetch(`${descriptor.localAdminBaseUrl}/api/v1/local/projects`, {
    headers: await localUserHeaders(descriptor),
  });
  expect(response.status).toBe(200);
  const payload = (await response.json()) as { data: readonly RegisteredProject[] };
  return payload.data;
}

async function localAdminRequest<Data>(path: string, init?: RequestInit): Promise<Data> {
  const dataDirectory = process.env.CODEXBOARD_DATA_DIR as string;
  const descriptorPath = resolve(dataDirectory, "run/runtime.json");
  await expect.poll(() => existsSync(descriptorPath)).toBe(true);
  const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8")) as RuntimeDescriptor;
  const response = await fetch(`${descriptor.localAdminBaseUrl}${path}`, {
    ...init,
    headers: {
      ...(await localUserHeaders(descriptor)),
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  expect(response.status).toBeGreaterThanOrEqual(200);
  expect(response.status).toBeLessThan(300);
  const payload = (await response.json()) as { data: Data };
  return payload.data;
}

async function readPublicData<Data>(page: Page, path: string): Promise<Data> {
  const result = await page.evaluate(async (requestPath) => {
    const response = await fetch(requestPath, { headers: { Accept: "application/json" } });
    return { status: response.status, payload: (await response.json()) as unknown };
  }, path);
  expect(result.status).toBe(200);
  return (result.payload as { data: Data }).data;
}

async function ensureGlobalLabel(page: Page, name: string): Promise<void> {
  const result = await page.evaluate(async (labelName) => {
    const sessionResponse = await fetch("/api/v1/session", {
      headers: { Accept: "application/json" },
    });
    const session = (await sessionResponse.json()) as { data: { csrfToken: string } };
    const createResponse = await fetch("/api/v1/labels", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
        "X-CSRF-Token": session.data.csrfToken,
      },
      body: JSON.stringify({ name: labelName }),
    });
    if (createResponse.status === 201) return { ok: true, status: 201 };
    if (createResponse.status !== 409) return { ok: false, status: createResponse.status };
    const listResponse = await fetch("/api/v1/labels", {
      headers: { Accept: "application/json" },
    });
    const list = (await listResponse.json()) as {
      data: { labels: readonly { name: string }[] };
    };
    return {
      ok: listResponse.ok && list.data.labels.some((label) => label.name === labelName),
      status: createResponse.status,
    };
  }, name);
  expect(result.ok, `创建全局标签失败，HTTP ${result.status}`).toBe(true);
}

async function mutateGlobalLabel(
  page: Page,
  currentName: string,
  mutation: { readonly kind: "rename"; readonly name: string } | { readonly kind: "delete" },
): Promise<void> {
  const result = await page.evaluate(
    async ({ labelName, operation }) => {
      const [sessionResponse, labelsResponse] = await Promise.all([
        fetch("/api/v1/session", { headers: { Accept: "application/json" } }),
        fetch("/api/v1/labels", { headers: { Accept: "application/json" } }),
      ]);
      const session = (await sessionResponse.json()) as { data: { csrfToken: string } };
      const catalog = (await labelsResponse.json()) as {
        data: { labels: readonly { id: string; name: string; version: number }[] };
      };
      const label = catalog.data.labels.find((candidate) => candidate.name === labelName);
      if (!label) return { ok: false, status: 404 };
      const response = await fetch(`/api/v1/labels/${label.id}`, {
        method: operation.kind === "rename" ? "PATCH" : "DELETE",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
          "X-CSRF-Token": session.data.csrfToken,
        },
        body: JSON.stringify(
          operation.kind === "rename"
            ? { expectedVersion: label.version, name: operation.name }
            : { expectedVersion: label.version },
        ),
      });
      return { ok: response.ok, status: response.status };
    },
    { labelName: currentName, operation: mutation },
  );
  expect(result.ok, `远端标签变更失败，HTTP ${result.status}`).toBe(true);
}

async function registerProject(prefix: string, displayName?: string): Promise<RegisteredProject> {
  const dataDirectory = process.env.CODEXBOARD_DATA_DIR as string;
  const codexProjectId = randomUUID();
  const name = displayName ?? `界面验收 ${uniqueProjectKey(prefix)}`;
  const rootPath = join(dataDirectory, `repository-${randomUUID()}`);
  mkdirSync(rootPath);
  updateProjectSnapshot((projects) => [
    ...projects,
    { codexProjectId, name, rootPaths: [rootPath], position: projects.length },
  ]);

  let registered: RegisteredProject | undefined;
  await expect
    .poll(async () => {
      const match = (await localProjects()).find((project) => project.name === name);
      if (!match) return false;
      registered = { ...match, codexProjectId, rootPath };
      return true;
    })
    .toBe(true);
  return registered as RegisteredProject;
}

async function registerExecutableProject(prefix: string): Promise<RegisteredProject> {
  const project = await registerProject(prefix);
  const repository = project.rootPath;
  execFileSync("git", ["-C", repository, "init", "-b", "main"]);
  execFileSync("git", ["-C", repository, "config", "user.name", "Taskboard E2E"]);
  execFileSync("git", ["-C", repository, "config", "user.email", "e2e@example.test"]);
  writeFileSync(join(repository, "README.md"), "# Codex E2E\n", "utf8");
  execFileSync("git", ["-C", repository, "add", "README.md"]);
  execFileSync("git", ["-C", repository, "commit", "-m", "initial"]);

  return project;
}

async function openWorkspace(page: Page): Promise<void> {
  await establishSyntheticFeishuSession(page.context().request);
  await page.goto("/");
  await expect(page.getByRole("button", { name: /切换项目，当前/ })).toBeVisible();
  await expect(page.locator(".project-list-rail")).toHaveCount(0);
}

async function selectProject(page: Page, project: RegisteredProject): Promise<void> {
  const menu = await openProjectMenu(page);
  await menu.getByRole("menuitem", { name: project.name, exact: true }).click();
  await expect(
    page.getByRole("button", { name: new RegExp(`当前：${project.name}`) }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "新增任务", exact: true })).toBeEnabled();
}

async function selectProjectByName(page: Page, name: string): Promise<void> {
  const menu = await openProjectMenu(page);
  await menu.getByRole("menuitem", { name, exact: true }).click();
  await expect(page.getByRole("button", { name: new RegExp(`当前：${name}`) })).toBeVisible();
  await expect(page.getByRole("region", { name: "任务状态看板" })).toBeVisible();
}

async function openProjectMenu(page: Page): Promise<Locator> {
  const menu = page.getByRole("menu", { name: "切换项目" });
  if (!(await menu.isVisible())) await page.getByRole("button", { name: /切换项目，当前/ }).click();
  await expect(menu).toBeVisible();
  return menu;
}

async function expectProjectMenuItemToReceivePointer(page: Page, name: string): Promise<void> {
  const option = (await openProjectMenu(page)).getByRole("menuitem", { name, exact: true });
  await expect(option).toBeVisible();
  const receivesPointerAtCenter = await option.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const topElement = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return topElement?.closest('[role="menuitem"]') === element;
  });
  expect(receivesPointerAtCenter).toBe(true);
}

async function openTaskCreateDialog(page: Page): Promise<Locator> {
  await expect(page.getByRole("dialog", { name: "新增任务" })).toHaveCount(0);
  await page.getByRole("button", { name: "新增任务", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新增任务" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("新增任务描述框聚焦时不显示绿色左侧竖条", async ({ page }) => {
  await openWorkspace(page);
  const dialog = await openTaskCreateDialog(page);
  const description = dialog.getByLabel("任务描述");
  await description.focus();
  const style = await description.evaluate((element) => {
    const computed = getComputedStyle(element);
    return { boxShadow: computed.boxShadow, borderLeftWidth: computed.borderLeftWidth };
  });
  expect(style.boxShadow).toBe("none");
  expect(Number.parseFloat(style.borderLeftWidth)).toBe(0);
});

async function capturePopoverControlsWhenFormDisables(
  dialog: Locator,
  panelLabel: string,
  captureAttribute: string,
): Promise<void> {
  await dialog.evaluate(
    (dialogElement, { panelLabel, captureAttribute }) => {
      const panel = Array.from(dialogElement.querySelectorAll<HTMLElement>("[aria-label]")).find(
        (candidate) => candidate.getAttribute("aria-label") === panelLabel,
      );
      const titleInput = dialogElement.querySelector<HTMLInputElement>("#task-create-title-input");
      if (!panel || !titleInput) throw new Error(`未找到弹层：${panelLabel}`);

      const recordDisabledState = () => {
        if (!titleInput.disabled || !panel.isConnected) return;
        const controls = Array.from(
          panel.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>(
            "input, button, select",
          ),
        );
        dialogElement.setAttribute(
          captureAttribute,
          String(controls.length > 0 && controls.every((control) => control.disabled)),
        );
      };
      new MutationObserver(recordDisabledState).observe(dialogElement, {
        attributes: true,
        attributeFilter: ["disabled"],
        subtree: true,
      });
      recordDisabledState();
    },
    { panelLabel, captureAttribute },
  );
}

async function expectPopoverFullyReachable(dialog: Locator, panel: Locator): Promise<void> {
  const dialogBox = await dialog.locator(".task-create-dialog").boundingBox();
  const panelBox = await panel.boundingBox();
  expect(dialogBox).not.toBeNull();
  expect(panelBox).not.toBeNull();
  expect(panelBox?.x ?? Number.NEGATIVE_INFINITY).toBeGreaterThanOrEqual(dialogBox?.x ?? 0);
  expect(panelBox?.y ?? Number.NEGATIVE_INFINITY).toBeGreaterThanOrEqual(dialogBox?.y ?? 0);
  expect((panelBox?.x ?? 0) + (panelBox?.width ?? 0)).toBeLessThanOrEqual(
    (dialogBox?.x ?? 0) + (dialogBox?.width ?? 0),
  );
  expect((panelBox?.y ?? 0) + (panelBox?.height ?? 0)).toBeLessThanOrEqual(
    (dialogBox?.y ?? 0) + (dialogBox?.height ?? 0),
  );

  const hitTest = await panel.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const points: ReadonlyArray<readonly [number, number]> = [
      [bounds.left + bounds.width / 2, bounds.top + 8],
      [bounds.right - 8, bounds.top + bounds.height / 2],
      [bounds.left + bounds.width / 2, bounds.bottom - 8],
      [bounds.left + 8, bounds.top + bounds.height / 2],
    ];
    return points.map(([x, y]) => {
      const hit = document.elementFromPoint(x, y);
      return hit === element || (hit !== null && element.contains(hit));
    });
  });
  expect(hitTest).toEqual([true, true, true, true]);
}

async function createTaskAndOpenDetail(
  page: Page,
  title: string,
  configure?: (dialog: Locator) => Promise<void>,
): Promise<Locator> {
  const createDialog = await openTaskCreateDialog(page);
  await configure?.(createDialog);
  await createDialog.getByLabel("任务标题").fill(title);
  await createDialog.getByRole("button", { name: "创建任务", exact: true }).click();
  await expect(createDialog).toHaveCount(0);
  const detail = page.getByRole("region", { name: "任务详情", exact: true });
  await expect(detail).toBeVisible();
  await expect(detail.getByRole("button", { name: "返回看板", exact: true })).toBeFocused();
  return detail;
}

async function quickCreate(
  page: Page,
  title: string,
  configure?: (dialog: Locator) => Promise<void>,
): Promise<string> {
  const dialog = await createTaskAndOpenDetail(page, title, configure);
  const identifier =
    (await dialog
      .getByText(/^[A-Z]{1,5}-\d{3,}$/)
      .first()
      .textContent()) ?? "";
  expect(identifier).toMatch(/^[A-Z]{1,5}-\d{3,}$/);
  await dialog.getByRole("button", { name: "返回看板" }).click();
  return identifier;
}

async function dragTaskCardToStatus(
  page: Page,
  identifier: string,
  targetStatus: "backlog" | "todo" | "in_progress" | "in_review",
): Promise<void> {
  await beginTaskCardDrag(page, identifier);
  await finishDragOverStatus(page, targetStatus);
}

async function beginTaskCardDrag(page: Page, identifier: string): Promise<void> {
  const card = page.getByTestId(`task-card-${identifier}`);
  // Full-suite fixtures accumulate tasks from earlier specs. A newly created task may therefore
  // sit below the viewport even though its locator resolves; move the real card into view before
  // deriving pointer coordinates.
  await card.scrollIntoViewIfNeeded();
  const cardBox = await card.boundingBox();
  expect(cardBox).not.toBeNull();
  await page.mouse.move(cardBox!.x + cardBox!.width / 2, cardBox!.y + cardBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(cardBox!.x + cardBox!.width / 2 + 12, cardBox!.y + cardBox!.height / 2, {
    steps: 3,
  });
}

async function finishDragOverStatus(
  page: Page,
  targetStatus: "backlog" | "todo" | "in_progress" | "in_review",
): Promise<void> {
  const targetColumn = page.getByTestId(`status-column-${targetStatus}`);
  const targetBox = await targetColumn.boundingBox();
  expect(targetBox).not.toBeNull();
  await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + 120, { steps: 12 });
  await page.mouse.up();
}

async function taskCardAppearance(card: Locator) {
  return card.evaluate((element) => {
    const open = element.querySelector<HTMLElement>(".task-open");
    const title = element.querySelector<HTMLElement>(".task-open > strong");
    const identifier = element.querySelector<HTMLElement>(".task-identifier");
    const actions = element.querySelector<HTMLElement>(".task-card-actions");
    if (!open || !title || !identifier) {
      throw new Error("任务卡片缺少统一结构");
    }
    const cardStyle = getComputedStyle(element);
    const actionStyle = actions ? getComputedStyle(actions) : null;
    return {
      display: cardStyle.display,
      borderRadius: cardStyle.borderRadius,
      openDisplay: getComputedStyle(open).display,
      titleFontSize: getComputedStyle(title).fontSize,
      identifierFontSize: getComputedStyle(identifier).fontSize,
      actionBorderTopWidth: actionStyle?.borderTopWidth ?? null,
      actionMinHeight: actionStyle?.minHeight ?? null,
    };
  });
}

async function expectWorkspaceToFitViewport(
  page: Page,
  viewport: { readonly width: number; readonly height: number },
): Promise<void> {
  await page.setViewportSize(viewport);
  const workspace = page.locator(".board-workspace");
  await expect(workspace).toBeVisible();
  const dimensions = await workspace.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return {
      height: box.height,
      horizontalOverflow:
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
      width: box.width,
    };
  });
  expect(dimensions.width).toBeGreaterThan(0);
  expect(dimensions.width).toBeLessThanOrEqual(viewport.width);
  expect(dimensions.height).toBeGreaterThan(0);
  expect(dimensions.height).toBeLessThanOrEqual(viewport.height);
  expect(dimensions.horizontalOverflow).toBe(0);
}

async function selectCreateRelation(
  dialog: Locator,
  kind: "父" | "子" | "关联",
  taskName: RegExp,
): Promise<void> {
  const moreMenu = dialog.getByRole("menu", { name: "更多任务选项菜单" });
  if (!(await moreMenu.isVisible())) {
    await dialog.getByRole("button", { name: "更多任务选项" }).click();
  }
  const relationMenu = dialog.getByRole("menu", { name: `${kind}任务候选` });
  if (!(await relationMenu.isVisible())) {
    await moreMenu.getByRole("button", { name: `添加${kind}任务` }).click();
  }
  await relationMenu.getByRole("button", { name: taskName }).click();
}

test("新增任务选择模型推理强度和速度并传递到创建请求", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openWorkspace(page);
  const dialog = await openTaskCreateDialog(page);
  await dialog.getByLabel("任务标题").fill("模型选择测试");
  const trigger = dialog.getByRole("button", { name: "模型与推理强度", exact: true });
  await trigger.click();
  const picker = dialog.getByRole("dialog", { name: "模型设置", exact: true });
  await picker.getByRole("button", { name: "GPT-6 Astra", exact: true }).click();
  const slider = picker.getByRole("slider", { name: "推理强度" });
  await slider.fill("1");
  await expect(slider).toHaveAttribute("aria-valuetext", "高");
  await picker.getByRole("button", { name: /点击开启/ }).click();
  await expect(picker.getByRole("button", { name: /已开启/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.screenshot({
    path: testInfo.outputPath("task-model-settings-desktop.png"),
    animations: "disabled",
  });
  await picker.getByRole("button", { name: "选择模型", exact: true }).click();
  await picker.getByRole("button", { name: "Test model", exact: true }).click();
  await expect(slider).toHaveValue("0");
  await expect(picker.getByRole("button", { name: /倍速不可用/ })).toBeDisabled();
  await picker.getByRole("button", { name: "使用 Codex 默认设置" }).click();
  await expect(trigger).toContainText("Codex 默认模型");
  await page.setViewportSize({ width: 390, height: 844 });
  await trigger.click();
  await picker.getByRole("button", { name: "GPT-6 Astra", exact: true }).click();
  await slider.fill("1");
  await picker.getByRole("button", { name: /点击开启/ }).click();
  await expect(slider).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath("task-model-settings-mobile.png"),
    animations: "disabled",
  });
  await dialog.getByRole("heading", { name: "新增任务" }).click();
  const submitted = page.waitForRequest(
    (request) => request.url().endsWith("/api/v1/tasks") && request.method() === "POST",
  );
  const response = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/tasks") && response.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "创建任务", exact: true }).click();
  expect((await submitted).postDataJSON().modelOptions).toEqual({
    model: "gpt-6-astra",
    effort: "high",
    serviceTier: "priority",
  });
  expect((await response).status()).toBe(201);
  await expect(dialog).toHaveCount(0);
});

test("新增任务按钮按需打开任务信息弹窗", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openWorkspace(page);

  const trigger = page.getByRole("button", { name: "新增任务", exact: true });
  await expect(trigger).toBeVisible();
  await expect(page.getByLabel("任务标题")).toHaveCount(0);

  let dialog = await openTaskCreateDialog(page);
  const viewport = page.viewportSize();
  const dialogBox = await dialog.locator(".task-create-dialog").boundingBox();
  expect(viewport).not.toBeNull();
  expect(dialogBox).not.toBeNull();
  const defaultAreaRatio =
    ((dialogBox?.width ?? 0) * (dialogBox?.height ?? 0)) /
    ((viewport?.width ?? 1) * (viewport?.height ?? 1));
  expect(defaultAreaRatio).toBeGreaterThanOrEqual(0.18);
  expect(defaultAreaRatio).toBeLessThanOrEqual(0.32);

  const titleInput = dialog.getByLabel("任务标题");
  await expect(titleInput).toBeFocused();
  await expect(dialog.getByRole("button", { name: "添加附件", exact: true })).toBeEnabled();
  const defaultFormScroll = await dialog.locator(".task-create-form").evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(defaultFormScroll.scrollHeight).toBeLessThanOrEqual(defaultFormScroll.clientHeight + 1);

  const expandButton = dialog.getByRole("button", { name: "放大新增任务" });
  await expect(expandButton.locator(".sf-symbol")).toHaveAttribute(
    "data-sf-symbol",
    "arrow.up.left.and.arrow.down.right",
  );
  const southeastResize = dialog.locator(".task-create-resize-zone--se");
  const resizeBox = await southeastResize.boundingBox();
  expect(resizeBox).not.toBeNull();
  await page.mouse.move((resizeBox?.x ?? 0) + 5, (resizeBox?.y ?? 0) + 5);
  await page.mouse.down();
  await page.mouse.move((resizeBox?.x ?? 0) + 85, (resizeBox?.y ?? 0) + 65, { steps: 8 });
  await page.mouse.up();
  const resizedBox = await dialog.locator(".task-create-dialog").boundingBox();
  expect(resizedBox?.width ?? 0).toBeGreaterThan((dialogBox?.width ?? 0) + 60);
  expect(resizedBox?.height ?? 0).toBeGreaterThan((dialogBox?.height ?? 0) + 40);

  await expandButton.click();
  const expandedBox = await dialog.locator(".task-create-dialog").boundingBox();
  expect(expandedBox?.width ?? 0).toBeGreaterThan((viewport?.width ?? 0) * 0.85);
  expect(expandedBox?.height ?? 0).toBeGreaterThan((viewport?.height ?? 0) * 0.85);
  const restoreButton = dialog.getByRole("button", { name: "还原新增任务大小" });
  await expect(restoreButton.locator(".sf-symbol")).toHaveAttribute(
    "data-sf-symbol",
    "arrow.up.left.and.arrow.down.right",
  );
  await restoreButton.click();
  const restoredBox = await dialog.locator(".task-create-dialog").boundingBox();
  expect(restoredBox?.width ?? 0).toBeCloseTo(resizedBox?.width ?? 0, 0);
  expect(restoredBox?.height ?? 0).toBeCloseTo(resizedBox?.height ?? 0, 0);

  await expect(titleInput).toHaveAttribute("placeholder", "任务标题");
  await expect(titleInput).toHaveAttribute("required", "");
  await expect(dialog).toHaveAttribute("aria-busy", "false");
  await expect(dialog.getByLabel("任务描述")).toBeVisible();
  await expect(dialog.getByRole("combobox", { name: "初始状态" })).toHaveValue("todo");
  await expect(dialog.getByRole("combobox", { name: "初始状态" }).getByRole("option")).toHaveCount(
    2,
  );
  const noPriorityButton = dialog.getByRole("button", { name: "优先级：无优先级" });
  await expect(noPriorityButton).toBeVisible();
  await expect(noPriorityButton.locator("..")).toHaveClass(/is-muted/);
  await expect(dialog.getByText("创建更多", { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "取消", exact: true })).toHaveCount(0);

  const titleVisuals = await titleInput.evaluate((element) => {
    const styles = getComputedStyle(element);
    return {
      borderTopWidth: styles.borderTopWidth,
      fontSize: Number.parseFloat(styles.fontSize),
    };
  });
  expect(titleVisuals.borderTopWidth).toBe("0px");
  expect(titleVisuals.fontSize).toBeGreaterThanOrEqual(28);

  const dialogTop = restoredBox?.y ?? 0;
  const actionsBox = await dialog.locator(".task-create-actions").boundingBox();
  expect(actionsBox).not.toBeNull();
  expect(actionsBox?.y ?? 0).toBeGreaterThan(dialogTop + (restoredBox?.height ?? 0) * 0.7);

  const closeButton = dialog.getByRole("button", { name: "关闭新增任务" });
  const createButton = dialog.getByRole("button", { name: "创建任务", exact: true });
  await titleInput.fill("键盘焦点圈验证");
  await closeButton.focus();
  await page.keyboard.press("Shift+Tab");
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await createButton.focus();
  await page.keyboard.press("Tab");
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);

  await closeButton.click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  dialog = await openTaskCreateDialog(page);
  const reopenedBox = await dialog.locator(".task-create-dialog").boundingBox();
  expect(reopenedBox?.width ?? 0).toBeCloseTo(dialogBox?.width ?? 0, 0);
  expect(reopenedBox?.height ?? 0).toBeCloseTo(dialogBox?.height ?? 0, 0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  dialog = await openTaskCreateDialog(page);
  await page.locator(".task-create-backdrop").click({ position: { x: 2, y: 2 } });
  await expect(dialog).toHaveCount(0);
});

test("新增任务弹窗打开后断线会禁用创建并关闭弹层", async ({ context, page }) => {
  await openWorkspace(page);
  await ensureGlobalLabel(page, `断线标签-${randomUUID().slice(0, 8)}`);
  const dialog = await openTaskCreateDialog(page);
  const titleInput = dialog.getByLabel("任务标题");
  const createButton = dialog.getByRole("button", { name: "创建任务", exact: true });
  await titleInput.fill("断线时不应创建");
  const labelsButton = dialog.getByRole("button", { name: /^标签：/ });
  await expect(labelsButton).toBeEnabled();
  await labelsButton.click();
  const labelsPanel = dialog.getByRole("group", { name: "选择标签" });
  await expect(labelsPanel).toBeVisible();
  await capturePopoverControlsWhenFormDisables(dialog, "选择标签", "data-disabled-label-controls");

  await page.route("**/api/v1/events?**", (route) => route.abort());
  await context.setOffline(true);
  await expect(page.getByText(/连接已断开/)).toBeVisible();
  await expect(titleInput).toBeDisabled();
  await expect(dialog.getByLabel("任务描述")).toBeDisabled();
  await expect(createButton).toBeDisabled();
  await expect(labelsButton).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "更多任务选项" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "添加附件" })).toBeDisabled();
  await expect(dialog).toHaveAttribute("data-disabled-label-controls", "true");
  await expect(labelsPanel).toHaveCount(0);

  await context.setOffline(false);
  await page.unroute("**/api/v1/events?**");
  await dialog.getByRole("button", { name: "关闭新增任务" }).click();
});

test("新增任务目标项目失效后立即禁用并提示", async ({ page }) => {
  await openWorkspace(page);
  await selectProjectByName(page, "全部项目");
  const dialog = await openTaskCreateDialog(page);
  const projectSelect = dialog.getByRole("combobox", { name: "任务归属项目" });
  const targetProjectId = await projectSelect.inputValue();
  await expect(dialog.getByLabel("任务标题")).toBeEnabled();
  await dialog.getByRole("button", { name: "更多任务选项" }).click();
  const morePanel = dialog.getByRole("menu", { name: "更多任务选项菜单" });
  await expect(morePanel).toBeVisible();

  await page.route("**/api/v1/projects", async (route) => {
    const response = await route.fetch();
    const payload = (await response.json()) as { data: { id: string }[] };
    await route.fulfill({
      response,
      json: { data: payload.data.filter((project) => project.id !== targetProjectId) },
    });
  });

  await expect(page.getByText("所选项目已不可用，请关闭弹窗后重新选择。")).toBeVisible({
    timeout: 5_000,
  });
  await expect(projectSelect).toBeDisabled();
  await expect(dialog.getByLabel("任务标题")).toBeDisabled();
  await expect(dialog.getByLabel("任务描述")).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "创建任务", exact: true })).toBeDisabled();
  await expect(morePanel).toHaveCount(0);
});

test("新增任务弹窗按需选择关系并累计添加附件", async ({ page }) => {
  const project = await registerProject("CREATEUI", `P-${randomUUID().slice(0, 4)}`);
  await openWorkspace(page);
  await selectProject(page, project);
  const labelName = `界面标签-${randomUUID().slice(0, 6)}`;
  await ensureGlobalLabel(page, labelName);

  const parentIdentifier = await quickCreate(page, "父候选任务");
  const childIdentifier = await quickCreate(page, "子候选任务");
  const relatedOneIdentifier = await quickCreate(page, "关联候选任务一");
  const relatedTwoIdentifier = await quickCreate(page, "关联候选任务二");

  const dialog = await openTaskCreateDialog(page);
  await expect(
    dialog.getByLabel(`负责人：${SYNTHETIC_FEISHU_NAME}`, { exact: true }),
  ).toBeVisible();
  const labelsButton = dialog.getByRole("button", { name: /^标签：/ });
  await expect(labelsButton).toBeVisible();
  await labelsButton.click();
  const labelsMenu = dialog.getByRole("group", { name: "选择标签" });
  await labelsMenu.getByRole("checkbox", { name: labelName }).check();
  await expect(labelsButton).toContainText(labelName);
  await dialog.getByRole("heading", { name: "新增任务" }).click();
  await expect(labelsMenu).toHaveCount(0);
  const contextSelect = dialog.getByRole("combobox", { name: "分支 / Worktree" });
  await expect(contextSelect).toHaveValue("");
  await expect(contextSelect.getByRole("option", { name: "无" })).toHaveCount(1);
  await expect(contextSelect.locator("..")).toHaveClass(/is-muted/);
  await expect(dialog.getByRole("button", { name: "更多任务选项" })).toBeVisible();
  await expect(dialog.locator('[data-sf-symbol="tag"]')).toBeVisible();
  await expect(dialog.locator('[data-icon="git-branch"]')).toBeVisible();
  await expect(dialog.locator('[data-sf-symbol="ellipsis"]')).toBeVisible();
  const moreButton = dialog.getByRole("button", { name: "更多任务选项" });
  const eastResize = dialog.locator(".task-create-resize-zone--e");
  const eastResizeBox = await eastResize.boundingBox();
  expect(eastResizeBox).not.toBeNull();
  await page.mouse.move(
    (eastResizeBox?.x ?? 0) + (eastResizeBox?.width ?? 0) / 2,
    (eastResizeBox?.y ?? 0) + (eastResizeBox?.height ?? 0) / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    (eastResizeBox?.x ?? 0) + (eastResizeBox?.width ?? 0) / 2 + 140,
    (eastResizeBox?.y ?? 0) + (eastResizeBox?.height ?? 0) / 2,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect
    .poll(() =>
      dialog
        .locator(".task-create-meta-strip")
        .evaluate(
          (element) =>
            new Set(
              Array.from(element.children, (child) =>
                Math.round(child.getBoundingClientRect().top),
              ),
            ).size,
        ),
    )
    .toBe(1);
  await expect(
    dialog.locator(".task-create-meta-strip").getByRole("button", {
      name: "更多任务选项",
    }),
  ).toBeVisible();
  await moreButton.click();
  const moreMenu = dialog.getByRole("menu", { name: "更多任务选项菜单" });
  await expect(
    moreMenu.getByRole("button", { name: "添加子任务" }).locator(".sf-symbol"),
  ).toHaveAttribute("data-sf-symbol", "list.bullet.indent");
  await expect(
    moreMenu.getByRole("button", { name: "添加父任务" }).locator(".sf-symbol"),
  ).toHaveAttribute("data-sf-symbol", "arrow.up.to.line");
  await expect(
    moreMenu.getByRole("button", { name: "添加关联任务" }).locator(".sf-symbol"),
  ).toHaveAttribute("data-sf-symbol", "link");

  const addParent = moreMenu.getByRole("button", { name: "添加父任务" });
  const addChild = moreMenu.getByRole("button", { name: "添加子任务" });
  const activeMenuBackground = "rgb(236, 238, 239)";
  const idleParentBackground = await addParent.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  const menuFontSize = await addParent.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).fontSize),
  );
  const pillFontSize = await moreButton.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).fontSize),
  );
  expect(menuFontSize).toBeCloseTo(pillFontSize, 2);
  const moreButtonBox = await moreButton.boundingBox();
  const closedSubmenuBox = await moreMenu.boundingBox();
  expect(moreButtonBox).not.toBeNull();
  expect(closedSubmenuBox).not.toBeNull();
  expect(
    Math.abs(
      (moreButtonBox?.x ?? 0) +
        (moreButtonBox?.width ?? 0) -
        ((closedSubmenuBox?.x ?? 0) + (closedSubmenuBox?.width ?? 0)),
    ),
  ).toBeLessThanOrEqual(2);
  await addParent.hover();
  const parentMenu = dialog.getByRole("menu", { name: "父任务候选" });
  await expect(parentMenu).toHaveCount(0);
  await addParent.click();
  await parentMenu.getByRole("searchbox", { name: "搜索任务" }).fill(parentIdentifier);
  await expect(addParent).toHaveAttribute("aria-current", "true");
  await expect(addParent).toHaveCSS("background-color", activeMenuBackground);
  expect(activeMenuBackground).not.toBe(idleParentBackground);
  await expect(parentMenu.getByRole("button")).toHaveCount(1);
  const moreMenuBox = await moreMenu.boundingBox();
  const parentMenuBox = await parentMenu.boundingBox();
  expect(parentMenuBox).not.toBeNull();
  expect(moreMenuBox).not.toBeNull();
  expect(
    parentMenuBox!.x >= moreMenuBox!.x + moreMenuBox!.width ||
      parentMenuBox!.x + parentMenuBox!.width <= moreMenuBox!.x,
  ).toBe(true);
  await expectPopoverFullyReachable(dialog, parentMenu);
  const submenuFontSize = await parentMenu
    .getByRole("button")
    .first()
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  expect(submenuFontSize).toBeCloseTo(pillFontSize, 2);
  const submenuLayer = await parentMenu.evaluate((element) => {
    const submenuRect = element.getBoundingClientRect();
    const dialogRect = element.closest(".task-create-dialog")?.getBoundingClientRect();
    if (!dialogRect) throw new Error("缺少新增任务弹窗");
    const probe = {
      x: Math.min(window.innerWidth - 2, submenuRect.right - 4),
      y: Math.min(window.innerHeight - 2, submenuRect.top + 44),
    };
    return {
      extendsPastDialog: submenuRect.right > dialogRect.right + 4,
      receivesPointer: element.contains(document.elementFromPoint(probe.x, probe.y)),
      dialogRight: dialogRect.right,
      submenuLeft: submenuRect.left,
      submenuRight: submenuRect.right,
    };
  });
  expect(submenuLayer.extendsPastDialog, JSON.stringify(submenuLayer)).toBe(false);
  expect(submenuLayer.receivesPointer).toBe(true);
  const parentCandidate = parentMenu.getByRole("button", { name: new RegExp(parentIdentifier) });
  await parentCandidate.click();
  const parentPill = dialog.locator(".task-create-relation-pill", { hasText: parentIdentifier });
  await expect(parentPill).toContainText("父任务");
  await expect(addParent).toHaveAttribute("aria-current", "true");
  await expect(addParent).toHaveCSS("background-color", activeMenuBackground);
  await expect
    .poll(async () => (await moreButton.boundingBox())?.x ?? moreButtonBox?.x ?? 0)
    .not.toBeCloseTo(moreButtonBox?.x ?? 0, 0);
  const anchoredMenuBox = await moreMenu.boundingBox();
  expect(anchoredMenuBox?.x ?? 0).toBeCloseTo(moreMenuBox?.x ?? 0, 0);
  expect(anchoredMenuBox?.y ?? 0).toBeCloseTo(moreMenuBox?.y ?? 0, 0);
  await expect(moreMenu).toBeVisible();
  await expect(parentMenu).toBeVisible();
  await expect(parentCandidate).toHaveAttribute("aria-pressed", "true");
  await expect(parentCandidate).toBeEnabled();
  await expect(addParent).toHaveCSS("color", "rgb(147, 147, 147)");
  await parentCandidate.click();
  await expect(parentPill).toHaveCount(0);
  await expect(parentCandidate).toHaveAttribute("aria-pressed", "false");
  await parentCandidate.click();
  await expect(parentPill).toContainText("父任务");

  await addChild.click();
  const childMenu = dialog.getByRole("menu", { name: "子任务候选" });
  await childMenu.getByRole("searchbox", { name: "搜索任务" }).hover();
  await expect(addParent).not.toHaveAttribute("aria-current", "true");
  await expect(addChild).toHaveAttribute("aria-current", "true");
  await expect(addChild).toHaveCSS("background-color", activeMenuBackground);
  await expect(addParent).not.toHaveCSS("background-color", activeMenuBackground);
  const parentInChildMenu = childMenu.getByRole("button", { name: new RegExp(parentIdentifier) });
  await expect(parentInChildMenu).toBeVisible();
  await expect(parentInChildMenu).toBeDisabled();
  await childMenu.getByRole("button", { name: new RegExp(childIdentifier) }).click();
  const childPill = dialog.locator(".task-create-relation-pill", { hasText: childIdentifier });
  await expect(childPill).toContainText("子任务");
  await expect(childMenu).toBeVisible();

  await moreMenu.getByRole("button", { name: "添加关联任务" }).click();
  const relatedMenu = dialog.getByRole("menu", { name: "关联任务候选" });
  for (const identifier of [relatedOneIdentifier, relatedTwoIdentifier]) {
    await relatedMenu.getByRole("searchbox", { name: "搜索任务" }).fill(identifier);
    const candidate = relatedMenu.getByRole("button", { name: new RegExp(identifier) });
    await candidate.click();
    await expect(relatedMenu).toBeVisible();
    await expect(candidate).toHaveAttribute("aria-pressed", "true");
  }
  await expect(dialog.locator(".task-create-relation-pill")).toHaveCount(4);
  await relatedMenu.getByRole("searchbox", { name: "搜索任务" }).fill(relatedOneIdentifier);
  const selectedRelated = relatedMenu.getByRole("button", {
    name: new RegExp(relatedOneIdentifier),
  });
  await selectedRelated.click();
  await expect(selectedRelated).toHaveAttribute("aria-pressed", "false");
  await expect(dialog.locator(".task-create-relation-pill")).toHaveCount(3);
  await selectedRelated.click();
  await expect(dialog.locator(".task-create-relation-pill")).toHaveCount(4);
  await dialog.getByRole("heading", { name: "新增任务" }).click();
  await expect(moreMenu).toHaveCount(0);
  const metaLayout = await dialog.locator(".task-create-meta-strip").evaluate((element) => {
    const itemRows = new Set(
      Array.from(element.children, (child) => Math.round(child.getBoundingClientRect().top)),
    );
    return {
      rowCount: itemRows.size,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    };
  });
  expect(metaLayout.rowCount).toBeGreaterThan(1);
  expect(metaLayout.scrollWidth).toBeLessThanOrEqual(metaLayout.clientWidth + 1);
  await parentPill.hover();
  const removeParent = parentPill.getByRole("button", {
    name: new RegExp(`删除父任务 ${parentIdentifier}`),
  });
  await expect(removeParent).toBeVisible();
  const pillBox = await parentPill.boundingBox();
  const removeBox = await removeParent.boundingBox();
  expect(removeBox).not.toBeNull();
  expect((removeBox?.y ?? 0) + (removeBox?.height ?? 0) / 2).toBeLessThan((pillBox?.y ?? 0) + 3);
  await removeParent.click();
  await expect(parentPill).toHaveCount(0);

  const addAttachment = dialog.getByRole("button", { name: /^添加附件/ });
  const create = dialog.getByRole("button", { name: "创建任务", exact: true });
  const footer = dialog.locator(".task-create-submit-row");
  await expect(addAttachment).toBeVisible();
  await expect(addAttachment.locator(".sf-symbol")).toHaveAttribute("data-sf-symbol", "paperclip");
  await expect(footer.getByRole("button", { name: /^添加附件/ })).toBeVisible();
  await expect(footer.getByRole("button", { name: "创建任务", exact: true })).toBeVisible();
  const addAttachmentBox = await addAttachment.boundingBox();
  const createBox = await create.boundingBox();
  expect(addAttachmentBox).not.toBeNull();
  expect(createBox).not.toBeNull();
  expect(Math.abs((addAttachmentBox?.y ?? 0) - (createBox?.y ?? 0))).toBeLessThan(12);
  expect(addAttachmentBox?.x ?? Number.POSITIVE_INFINITY).toBeLessThan(createBox?.x ?? 0);

  await dialog.locator('input[type="file"]').setInputFiles({
    name: "brief.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("brief", "utf8"),
  });
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "evidence.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("kind,result\ne2e,passed\n", "utf8"),
  });
  await expect(dialog.getByLabel("已添加附件")).toContainText("brief.txt");
  await expect(dialog.getByLabel("已添加附件")).toContainText("evidence.csv");
  await expect(dialog.locator(".task-create-file-extension")).toHaveText(["TXT", "CSV"]);
  await expect(dialog.getByRole("button", { name: "添加附件，已选择 2 个" })).toBeVisible();
  await dialog.getByLabel("任务标题").fill("胶囊换行附件测试");
  await create.click({ trial: true, timeout: 2_000 });
  await dialog.getByRole("button", { name: "删除附件 brief.txt" }).click();
  await expect(dialog.getByRole("button", { name: "添加附件，已选择 1 个" })).toBeVisible();
  await expect(dialog.getByText("创建更多", { exact: true })).toHaveCount(0);
});

test("取消附件选择保留新增任务弹窗", async ({ page }) => {
  await openWorkspace(page);
  const dialog = await openTaskCreateDialog(page);
  await dialog.getByLabel("任务标题").fill("保留中的任务");
  await dialog.getByLabel("任务描述").fill("保留中的描述");

  await dialog.locator('input[type="file"]').dispatchEvent("cancel");

  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("任务标题")).toHaveValue("保留中的任务");
  await expect(dialog.getByLabel("任务描述")).toHaveValue("保留中的描述");
});

test("三行胶囊自动增高并保留手动尺寸基准", async ({ page }) => {
  const project = await registerProject("AUTOGROW");
  await openWorkspace(page);
  await selectProject(page, project);
  const relationIdentifiers: string[] = [];
  for (let index = 0; index < 9; index += 1) {
    relationIdentifiers.push(await quickCreate(page, `自动增高候选任务 ${String(index + 1)}`));
  }

  const dialog = await openTaskCreateDialog(page);
  const panel = dialog.locator(".task-create-dialog");
  const defaultBox = await panel.boundingBox();
  expect(defaultBox).not.toBeNull();
  const moreButton = dialog.getByRole("button", { name: "更多任务选项" });
  const moreMenu = dialog.getByRole("menu", { name: "更多任务选项菜单" });
  const relatedMenu = dialog.getByRole("menu", { name: "关联任务候选" });

  const selectAllRelations = async () => {
    for (const identifier of relationIdentifiers) {
      if (!(await moreMenu.isVisible())) await moreButton.click();
      if (!(await relatedMenu.isVisible())) {
        await moreMenu.getByRole("button", { name: "添加关联任务" }).click();
      }
      await relatedMenu.getByRole("searchbox", { name: "搜索任务" }).fill(identifier);
      await relatedMenu.getByRole("button", { name: new RegExp(identifier) }).click();
    }
    if (await moreMenu.isVisible()) {
      await dialog.getByRole("heading", { name: "新增任务" }).click();
    }
  };

  const readLayout = () =>
    dialog.evaluate((element) => {
      const panel = element.querySelector<HTMLElement>(".task-create-dialog");
      const strip = element.querySelector<HTMLElement>(".task-create-meta-strip");
      const create = element.querySelector<HTMLElement>(".task-create-actions button");
      const south = element.querySelector<HTMLElement>(".task-create-resize-zone--s");
      if (!panel || !strip || !create || !south) throw new Error("缺少新增任务弹窗布局元素");
      const dialogRect = panel.getBoundingClientRect();
      const createRect = create.getBoundingClientRect();
      const southRect = south.getBoundingClientRect();
      return {
        rowCount: new Set(
          Array.from(strip.children, (child) => Math.round(child.getBoundingClientRect().top)),
        ).size,
        dialogHeight: dialogRect.height,
        dialogBottom: dialogRect.bottom,
        createBottom: createRect.bottom,
        southResizeTop: southRect.top,
      };
    });

  await selectAllRelations();
  const grown = await readLayout();
  expect(grown.rowCount).toBeGreaterThanOrEqual(3);
  expect(grown.dialogHeight).toBeGreaterThan(defaultBox?.height ?? 304);
  expect(grown.createBottom).toBeLessThanOrEqual(grown.dialogBottom - 10);
  expect(grown.createBottom).toBeLessThan(grown.southResizeTop);

  while ((await dialog.locator(".task-create-relation-pill").count()) > 0) {
    const pill = dialog.locator(".task-create-relation-pill").first();
    await pill.hover();
    await pill.getByRole("button").click();
  }
  await expect
    .poll(async () => (await panel.boundingBox())?.height ?? 0)
    .toBeCloseTo(defaultBox?.height ?? 304, 0);

  const south = dialog.locator(".task-create-resize-zone--s");
  const southBox = await south.boundingBox();
  expect(southBox).not.toBeNull();
  await page.mouse.move((southBox?.x ?? 0) + 30, (southBox?.y ?? 0) + 3);
  await page.mouse.down();
  await page.mouse.move((southBox?.x ?? 0) + 30, (southBox?.y ?? 0) + 73, { steps: 8 });
  await page.mouse.up();
  const manualHeight = (await panel.boundingBox())?.height ?? 0;
  expect(manualHeight).toBeGreaterThan((defaultBox?.height ?? 304) + 50);

  await selectAllRelations();
  expect((await panel.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(manualHeight);
  while ((await dialog.locator(".task-create-relation-pill").count()) > 0) {
    const pill = dialog.locator(".task-create-relation-pill").first();
    await pill.hover();
    await pill.getByRole("button").click();
  }
  await expect
    .poll(async () => (await panel.boundingBox())?.height ?? 0)
    .toBeCloseTo(manualHeight, 0);
});

test("全项目可点击对象提供保留语义颜色的悬停反馈", async ({ page }) => {
  await openWorkspace(page);

  const background = (locator: Locator) =>
    locator.evaluate((element) => getComputedStyle(element).backgroundColor);
  const expectHoverChange = async (locator: Locator) => {
    await page.mouse.move(1, 1);
    const before = await background(locator);
    await locator.hover();
    await page.waitForTimeout(180);
    const after = await background(locator);
    expect(after).not.toBe(before);
    return after;
  };

  await expectHoverChange(page.getByRole("button", { name: /切换项目，当前/ }));
  await expectHoverChange(page.locator(".workspace-tabs button").first());
  const primaryHover = await expectHoverChange(
    page.getByRole("button", { name: "新增任务", exact: true }),
  );
  expect(primaryHover).toMatch(/^rgb\((?:[0-9]+), (?:[0-9]+), (?:[0-9]+)\)$/);

  const dialog = await openTaskCreateDialog(page);
  await expectHoverChange(dialog.getByRole("button", { name: "优先级：无优先级" }));
  await dialog.getByRole("button", { name: "更多任务选项" }).click();
  await expectHoverChange(
    dialog
      .getByRole("menu", { name: "更多任务选项菜单" })
      .getByRole("button", { name: "添加关联任务" }),
  );
  await dialog.getByRole("heading", { name: "新增任务" }).click();
  const disabledCreate = dialog.getByRole("button", { name: "创建任务", exact: true });
  const disabledBefore = await background(disabledCreate);
  await disabledCreate.hover({ force: true });
  await page.waitForTimeout(180);
  expect(await background(disabledCreate)).toBe(disabledBefore);
  await dialog.getByRole("button", { name: "关闭新增任务" }).click();

  await page.getByRole("button", { name: "标签管理" }).click();
  const manager = page.getByRole("dialog", { name: "标签管理" });
  const labelName = `悬停标签-${randomUUID().slice(0, 6)}`;
  await manager.getByRole("textbox", { name: "新标签名称" }).fill(labelName);
  await manager.getByRole("button", { name: "新增", exact: true }).click();
  const row = manager.locator(".tag-manager-row", { hasText: labelName });
  await row.hover();
  await row.getByRole("button", { name: `删除标签 ${labelName}` }).click();
  const danger = page.getByRole("alertdialog").getByRole("button", { name: "删除标签" });
  const dangerHover = await expectHoverChange(danger);
  const dangerChannels = dangerHover.match(/\d+/g)?.map(Number) ?? [];
  expect(dangerChannels[0]).toBeGreaterThan(dangerChannels[1] ?? Number.POSITIVE_INFINITY);
  expect(dangerChannels[0]).toBeGreaterThan(dangerChannels[2] ?? Number.POSITIVE_INFINITY);
  await page.getByRole("alertdialog").getByRole("button", { name: "取消" }).click();
  await manager.getByRole("button", { name: "关闭标签管理" }).click();
});

test("导航与筛选保持紧凑悬停、左向子菜单和反向键盘焦点", async ({ page }) => {
  const project = await registerProject("TOOLBAR");
  await openWorkspace(page);
  await selectProject(page, project);
  await quickCreate(page, "筛选菜单键盘焦点任务");

  const toolbar = page.locator(".workspace-view-toolbar");
  const boardTab = page.getByRole("tab", { name: "看板" });
  expect((await boardTab.boundingBox())!.height).toBeLessThan(
    (await toolbar.boundingBox())!.height,
  );

  await page.getByRole("button", { name: "筛选任务" }).click();
  const statusRoot = page.getByRole("menuitem", { name: "状态" });
  await expect(statusRoot.locator('[data-sf-symbol="chevron.left"]')).toHaveCount(1);
  await statusRoot.hover();

  const rootBox = await page.getByRole("menu", { name: "筛选任务菜单" }).boundingBox();
  const submenu = page.getByRole("menu", { name: "按状态筛选" });
  const submenuBox = await submenu.boundingBox();
  expect(submenuBox!.x + submenuBox!.width).toBeLessThanOrEqual(rootBox!.x);

  await statusRoot.focus();
  await page.keyboard.press("ArrowLeft");
  const firstStatusOption = submenu.locator('[role="menuitemcheckbox"]:not([disabled])').first();
  await expect(firstStatusOption).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(statusRoot).toBeFocused();
  await page.keyboard.press("Escape");

  for (const viewportWidth of [320, 361, 375, 383, 384, 390]) {
    await page.setViewportSize({ width: viewportWidth, height: 900 });
    await page.getByRole("button", { name: "筛选任务" }).click();
    const rootMenu = page.getByRole("menu", { name: "筛选任务菜单" });

    for (const [category, submenuLabel] of [
      ["状态", "按状态筛选"],
      ["优先级", "按优先级筛选"],
      ["标签", "按标签筛选"],
    ] as const) {
      await page.getByRole("menuitem", { name: category, exact: true }).hover();
      const rootMenuBox = await rootMenu.boundingBox();
      const categorySubmenuBox = await page.getByRole("menu", { name: submenuLabel }).boundingBox();

      expect(rootMenuBox!.x).toBeGreaterThanOrEqual(0);
      expect(rootMenuBox!.x + rootMenuBox!.width).toBeLessThanOrEqual(viewportWidth);
      expect(categorySubmenuBox!.x).toBeGreaterThanOrEqual(0);
      expect(categorySubmenuBox!.x + categorySubmenuBox!.width).toBeLessThanOrEqual(rootMenuBox!.x);
      expect(categorySubmenuBox!.x + categorySubmenuBox!.width).toBeLessThanOrEqual(viewportWidth);
    }

    await page.keyboard.press("Escape");
  }
});

test("新增任务与标签管理的普通文字字号和看板控件保持一致", async ({ page }) => {
  await openWorkspace(page);

  const fontSize = (locator: Locator) =>
    locator.evaluate((element) => getComputedStyle(element).fontSize);
  const baseline = await fontSize(page.getByRole("button", { name: "新增任务", exact: true }));

  const dialog = await openTaskCreateDialog(page);
  await expect.poll(() => fontSize(dialog.getByLabel("任务描述"))).toBe(baseline);
  await expect
    .poll(() => fontSize(dialog.getByRole("button", { name: "优先级：无优先级" })))
    .toBe(baseline);
  await expect
    .poll(() => fontSize(dialog.getByRole("button", { name: "添加附件" })))
    .toBe(baseline);

  await dialog.getByRole("button", { name: "更多任务选项" }).click();
  await expect
    .poll(() =>
      fontSize(
        dialog
          .getByRole("menu", { name: "更多任务选项菜单" })
          .getByRole("button", { name: "添加关联任务" }),
      ),
    )
    .toBe(baseline);
  await dialog.getByRole("heading", { name: "新增任务" }).click();
  await dialog.getByRole("button", { name: "关闭新增任务" }).click();

  await page.getByRole("button", { name: "标签管理" }).click();
  const manager = page.getByRole("dialog", { name: "标签管理" });
  await expect
    .poll(() => fontSize(manager.getByRole("textbox", { name: "新标签名称" })))
    .toBe(baseline);
  await expect
    .poll(() => fontSize(manager.getByRole("button", { name: "新增", exact: true })))
    .toBe(baseline);
  await manager.getByRole("button", { name: "关闭标签管理" }).click();
});

test("新增任务分支选项与本地 Worktree 实时同步并按分支去重", async ({ page }) => {
  const project = await registerExecutableProject("BRANCHSYNC");
  const featureBranch = "feature/task-dialog-sync";
  const featureWorktree = join(
    process.env.CODEXBOARD_DATA_DIR as string,
    `worktree-${randomUUID()}`,
  );
  execFileSync("git", ["-C", project.rootPath, "branch", featureBranch]);
  execFileSync("git", ["-C", project.rootPath, "worktree", "add", featureWorktree, featureBranch]);

  await openWorkspace(page);
  await selectProject(page, project);
  const dialog = await openTaskCreateDialog(page);
  const contextSelect = dialog.getByRole("combobox", { name: "分支 / Worktree" });
  await expect(contextSelect.getByRole("option", { name: "main", exact: true })).toHaveCount(1);
  await expect(contextSelect.getByRole("option", { name: featureBranch, exact: true })).toHaveCount(
    1,
  );
  expect((await contextSelect.locator("option").allTextContents()).join(" ")).not.toContain("·");
  await contextSelect.selectOption({ label: featureBranch });

  const defaultLayout = await dialog.locator(".task-create-dialog").evaluate((element) => {
    const rect = (selector: string) => {
      const target = element.querySelector(selector);
      if (!target) throw new Error(`缺少布局元素：${selector}`);
      return target.getBoundingClientRect();
    };
    const dialogRect = element.getBoundingClientRect();
    const strip = element.querySelector(".task-create-meta-strip");
    const form = element.querySelector<HTMLElement>(".task-create-form");
    if (!strip || !form) throw new Error("缺少任务创建选项容器");
    return {
      dialogBottom: dialogRect.bottom,
      dialogHeight: dialogRect.height,
      rowCount: new Set(
        Array.from(strip.children, (child) => Math.round(child.getBoundingClientRect().top)),
      ).size,
      attachmentBottom: rect(".task-create-add-link").bottom,
      createBottom: rect(".task-create-actions .button").bottom,
      southResizeTop: rect(".task-create-resize-zone--s").top,
      formClientHeight: form.clientHeight,
      formScrollHeight: form.scrollHeight,
    };
  });
  expect(defaultLayout.dialogHeight).toBeCloseTo(304, 0);
  expect(defaultLayout.rowCount).toBeGreaterThan(1);
  expect(defaultLayout.attachmentBottom).toBeLessThanOrEqual(defaultLayout.dialogBottom - 10);
  expect(defaultLayout.createBottom).toBeLessThanOrEqual(defaultLayout.dialogBottom - 10);
  expect(defaultLayout.createBottom).toBeLessThan(defaultLayout.southResizeTop);
  expect(defaultLayout.formScrollHeight).toBeLessThanOrEqual(defaultLayout.formClientHeight + 1);

  execFileSync("git", ["-C", project.rootPath, "worktree", "remove", featureWorktree]);
  execFileSync("git", ["-C", project.rootPath, "branch", "-D", featureBranch]);

  await expect(contextSelect.getByRole("option", { name: featureBranch, exact: true })).toHaveCount(
    0,
    { timeout: 12_000 },
  );
  await expect(contextSelect).toHaveValue("");
  await dialog.getByRole("button", { name: "关闭新增任务" }).click();
});

test("手机新增任务会阻止超限附件并在一秒后自动关闭浮层提示", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/v1/projects/*/task-creation-options", async (route) => {
    const response = await route.fetch();
    const payload = (await response.json()) as { data: Record<string, unknown> };
    await route.fulfill({
      response,
      json: { data: { ...payload.data, attachmentMaxBytes: 4 } },
    });
  });
  await openWorkspace(page);
  const dialog = await openTaskCreateDialog(page);
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "too-large.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("12345", "utf8"),
  });
  const rejection = page.getByRole("alert").filter({ hasText: "too-large.txt" });
  await expect(rejection).toContainText("超过 4 B 上限");
  await page.screenshot({
    path: testInfo.outputPath("notification-mobile.png"),
    animations: "disabled",
  });
  await expect(dialog.getByLabel("已添加附件")).toHaveCount(0);
  await expect(page.locator(".notification-center")).toHaveJSProperty("popover", "manual");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(rejection).toHaveCount(0, { timeout: 2_500 });
});

test("新增任务会在项目附件限制加载完成前禁用附件入口", async ({ page }) => {
  let releaseOptions!: () => void;
  const optionsGate = new Promise<void>((resolve) => {
    releaseOptions = resolve;
  });
  await page.route("**/api/v1/projects/*/task-creation-options", async (route) => {
    await optionsGate;
    await route.continue();
  });
  await openWorkspace(page);
  const dialog = await openTaskCreateDialog(page);
  const attachmentButton = dialog.getByRole("button", { name: "添加附件", exact: true });
  await expect(attachmentButton).toBeDisabled();
  releaseOptions();
  await expect(attachmentButton).toBeEnabled();
});

test("附件上传失败后只重试附件且不会重复创建任务", async ({ page }) => {
  let taskCreates = 0;
  let attachmentUploads = 0;
  await page.route("**/api/v1/tasks", async (route) => {
    if (route.request().method() === "POST") taskCreates += 1;
    await route.continue();
  });
  await page.route("**/api/v1/tasks/*/attachments", async (route) => {
    attachmentUploads += 1;
    if (attachmentUploads === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "INTERNAL_ERROR", message: "模拟附件上传失败" },
        }),
      });
      return;
    }
    await route.continue();
  });

  await openWorkspace(page);
  const dialog = await openTaskCreateDialog(page);
  await dialog.getByLabel("任务标题").fill("附件重试任务");
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "retry.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("retry", "utf8"),
  });
  await dialog.getByRole("button", { name: "创建任务", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "部分附件上传失败" })).toBeVisible();
  await expect(
    page.locator(".notification").filter({ hasText: "retry.txt：服务暂时无法连接，请稍后重试。" }),
  ).toBeVisible();
  await expect(dialog.getByRole("button", { name: "重试附件" })).toBeVisible();
  expect(taskCreates).toBe(1);
  expect(attachmentUploads).toBe(1);

  await dialog.getByRole("button", { name: "重试附件" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("region", { name: "任务详情", exact: true })).toBeVisible();
  expect(taskCreates).toBe(1);
  expect(attachmentUploads).toBe(2);
});

test("全局标签可新增、改名、跨项目选择、拖动排序并确认删除", async ({ page }) => {
  const firstProject = await registerProject("TAGA");
  const secondProject = await registerProject("TAGB");
  await openWorkspace(page);
  await selectProject(page, firstProject);

  await page.getByRole("button", { name: "标签管理" }).click();
  const manager = page.getByRole("dialog", { name: "标签管理" });
  const prefix = randomUUID().slice(0, 6);
  const names = [`甲-${prefix}`, `乙-${prefix}`, `丙-${prefix}`, `丁-${prefix}`] as const;
  for (const name of names) {
    await manager.getByRole("textbox", { name: "新标签名称" }).fill(name);
    await manager.getByRole("button", { name: "新增", exact: true }).click();
    await expect(manager.getByRole("button", { name, exact: true })).toBeVisible();
  }

  const renamed = `甲改-${prefix}`;
  await manager.getByRole("button", { name: names[0], exact: true }).click();
  const renameInput = manager.getByRole("textbox", { name: `修改标签 ${names[0]}` });
  await renameInput.fill(renamed);
  await renameInput.press("Enter");
  await expect(manager.getByRole("button", { name: renamed, exact: true })).toBeVisible();

  const sourceHandle = manager.getByRole("button", { name: `拖动标签 ${renamed}` });
  const targetHandle = manager.getByRole("button", { name: `拖动标签 ${names[3]}` });
  const sourceBox = await sourceHandle.boundingBox();
  const targetBox = await targetHandle.boundingBox();
  expect(sourceBox).not.toBeNull();
  expect(targetBox).not.toBeNull();
  await page.mouse.move((sourceBox?.x ?? 0) + 6, (sourceBox?.y ?? 0) + 6);
  await page.mouse.down();
  await page.mouse.move((targetBox?.x ?? 0) + 6, (targetBox?.y ?? 0) + (targetBox?.height ?? 0), {
    steps: 14,
  });
  await expect(manager.locator('[data-drop-after="true"], [data-drop-before="true"]')).toHaveCount(
    1,
  );
  await page.mouse.up();
  await expect
    .poll(async () => {
      const targetNames = new Set([renamed, names[1], names[2], names[3]]);
      return (await manager.locator(".tag-manager-name").allTextContents()).filter((name) =>
        targetNames.has(name),
      );
    })
    .toEqual([names[1], names[2], names[3], renamed]);

  const deleteRow = manager.locator(".tag-manager-row", { hasText: names[1] });
  await deleteRow.hover();
  await deleteRow.getByRole("button", { name: `删除标签 ${names[1]}` }).click();
  const confirm = page.getByRole("alertdialog", { name: `删除“${names[1]}”？` });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "取消" }).click();
  await expect(manager.getByRole("button", { name: names[1], exact: true })).toBeVisible();
  await deleteRow.hover();
  await deleteRow.getByRole("button", { name: `删除标签 ${names[1]}` }).click();
  await confirm.getByRole("button", { name: "删除标签" }).click();
  await expect(manager.getByRole("button", { name: names[1], exact: true })).toHaveCount(0);
  await manager.getByRole("button", { name: "关闭标签管理" }).click();

  await selectProject(page, secondProject);
  const createDialog = await openTaskCreateDialog(page);
  await createDialog.getByRole("button", { name: /^标签：/ }).click();
  const selectedLabel = createDialog
    .getByRole("group", { name: "选择标签" })
    .getByRole("checkbox", { name: renamed });
  await expect(selectedLabel).toBeVisible();
  await selectedLabel.check();
  const remotelyRenamed = `远端改-${prefix}`;
  await mutateGlobalLabel(page, renamed, { kind: "rename", name: remotelyRenamed });
  await expect(
    createDialog.getByRole("button", { name: `标签：${remotelyRenamed}` }),
  ).toBeVisible();
  await mutateGlobalLabel(page, remotelyRenamed, { kind: "delete" });
  await expect(createDialog.getByRole("button", { name: "标签：未选择" })).toBeVisible();
});

test("短视口使用全屏新增任务弹窗且禁用边缘缩放", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 844, height: 390 } });
  const page = await context.newPage();

  try {
    await openWorkspace(page);
    const dialog = await openTaskCreateDialog(page);
    const dialogBox = await dialog.locator(".task-create-dialog").boundingBox();
    expect(dialogBox).toEqual({ x: 0, y: 0, width: 844, height: 390 });
    await expect(dialog.locator(".task-create-resize-zone")).toHaveCount(8);
    for (const zone of await dialog.locator(".task-create-resize-zone").all()) {
      await expect(zone).toHaveCSS("display", "none");
    }
    const buttonBox = await dialog
      .getByRole("button", { name: "创建任务", exact: true })
      .boundingBox();
    expect(buttonBox).not.toBeNull();
    expect((buttonBox?.y ?? 0) + (buttonBox?.height ?? 0)).toBeLessThanOrEqual(390);
    await expect(dialog.getByLabel("任务描述")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("触屏设备始终显示关系与标签删除入口", async ({ browser }) => {
  const project = await registerProject("TOUCHDELETE");
  const labelName = `触屏标签-${randomUUID().slice(0, 6)}`;
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  const page = await context.newPage();
  try {
    await openWorkspace(page);
    await selectProject(page, project);
    await ensureGlobalLabel(page, labelName);
    await quickCreate(page, "触屏关系候选");

    const dialog = await openTaskCreateDialog(page);
    await selectCreateRelation(dialog, "子", /触屏关系候选/);
    await expect(dialog.locator(".task-create-relation-pill > button")).toHaveCSS(
      "display",
      "grid",
    );
    await dialog.getByRole("button", { name: "关闭新增任务" }).click();

    await page.getByRole("button", { name: "标签管理" }).click();
    const labelRow = page
      .getByRole("dialog", { name: "标签管理" })
      .locator(".tag-manager-row", { hasText: labelName });
    await expect(labelRow.getByRole("button", { name: `删除标签 ${labelName}` })).toHaveCSS(
      "display",
      "grid",
    );
  } finally {
    await context.close();
  }
});

test("大屏新增任务弹窗保持紧凑默认尺寸并可放大", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  try {
    await openWorkspace(page);
    const dialog = await openTaskCreateDialog(page);
    const dialogBox = await dialog.locator(".task-create-dialog").boundingBox();
    expect(dialogBox).not.toBeNull();
    expect(dialogBox?.width ?? 0).toBeCloseTo(704, 0);
    expect(dialogBox?.height ?? 0).toBeCloseTo(304, 0);
    await dialog.getByRole("button", { name: "放大新增任务" }).click();
    const expandedBox = await dialog.locator(".task-create-dialog").boundingBox();
    expect(expandedBox?.width ?? 0).toBeGreaterThan(1920 * 0.85);
    expect(expandedBox?.height ?? 0).toBeGreaterThan(1080 * 0.85);
  } finally {
    await context.close();
  }
});

test("新增任务弹窗在不同桌面视口保持默认尺寸且不溢出", async ({ browser }) => {
  for (const viewport of [
    { width: 800, height: 600 },
    { width: 2560, height: 1440 },
  ]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    try {
      await openWorkspace(page);
      const dialog = await openTaskCreateDialog(page);
      const box = await dialog.locator(".task-create-dialog").boundingBox();
      expect(box).not.toBeNull();
      expect(box?.width ?? 0).toBeCloseTo(704, 0);
      expect(box?.height ?? 0).toBeCloseTo(304, 0);
      expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
    } finally {
      await context.close();
    }
  }
});

test("紧凑新增任务弹窗中的大量标签和关联候选均可滚动访问", async ({ browser }) => {
  test.setTimeout(90_000);
  const project = await registerProject("CREATEPOP");
  const candidates = Array.from({ length: 24 }, (_, index) => {
    const suffix = String(index + 1).padStart(2, "0");
    return {
      title: `弹层候选任务 ${suffix}`,
      label: `弹层标签 ${suffix}`,
    };
  });
  const seedContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const seedPage = await seedContext.newPage();
  try {
    await openWorkspace(seedPage);
    await selectProject(seedPage, project);
    for (const candidate of candidates) await ensureGlobalLabel(seedPage, candidate.label);
    const statuses = await seedPage.evaluate(
      async ({ projectId, taskCandidates }) => {
        const sessionResponse = await fetch("/api/v1/session", {
          headers: { Accept: "application/json" },
        });
        const session = (await sessionResponse.json()) as { data: { csrfToken: string } };
        const results: number[] = [];
        for (const candidate of taskCandidates) {
          const response = await fetch("/api/v1/tasks", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": crypto.randomUUID(),
              "X-CSRF-Token": session.data.csrfToken,
            },
            body: JSON.stringify({
              projectId,
              title: candidate.title,
              labels: [candidate.label],
            }),
          });
          results.push(response.status);
        }
        return results;
      },
      { projectId: project.id, taskCandidates: candidates },
    );
    expect(statuses).toEqual(Array.from({ length: candidates.length }, () => 201));
  } finally {
    await seedContext.close();
  }

  for (const viewport of [
    { width: 800, height: 600 },
    { width: 1280, height: 800 },
  ]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    try {
      await openWorkspace(page);
      await selectProject(page, project);
      const dialog = await openTaskCreateDialog(page);

      const labelsButton = dialog.getByRole("button", { name: /^标签：/ });
      await labelsButton.click();
      const labelsPanel = dialog.getByRole("group", { name: "选择标签" });
      await expectPopoverFullyReachable(dialog, labelsPanel);
      const firstLabel = labelsPanel.getByRole("checkbox", { name: candidates[0]!.label });
      const lastLabel = labelsPanel.getByRole("checkbox", { name: candidates.at(-1)!.label });
      await lastLabel.scrollIntoViewIfNeeded();
      expect(await labelsPanel.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      await lastLabel.check();
      await firstLabel.scrollIntoViewIfNeeded();
      await firstLabel.check();
      await expect(firstLabel).toBeChecked();
      await expect(lastLabel).toBeChecked();
      await expect(labelsButton).toContainText(
        `${candidates[0]!.label}；${candidates.at(-1)!.label}`,
      );

      await dialog.getByRole("heading", { name: "新增任务" }).click();
      await dialog.getByRole("button", { name: "更多任务选项" }).click();
      await dialog.getByRole("button", { name: "添加关联任务" }).click();
      const relatedPanel = dialog.getByRole("menu", { name: "关联任务候选" });
      await expectPopoverFullyReachable(dialog, relatedPanel);
      const firstRelated = relatedPanel.getByRole("button", {
        name: new RegExp(`${candidates[0]!.title}$`),
      });
      const lastRelated = relatedPanel.getByRole("button", {
        name: new RegExp(`${candidates.at(-1)!.title}$`),
      });
      await expect(firstRelated).toBeVisible();
      await lastRelated.scrollIntoViewIfNeeded();
      expect(await relatedPanel.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      await lastRelated.click();
      await expect(dialog.locator(".task-create-relation-pill")).toHaveAttribute(
        "title",
        new RegExp(candidates.at(-1)!.title),
      );
    } finally {
      await context.close();
    }
  }
});

test("新增任务时保存描述和优先级", async ({ page }) => {
  await openWorkspace(page);

  const detail = await createTaskAndOpenDetail(page, "带完整信息的新任务", async (dialog) => {
    await dialog.getByLabel("任务描述").fill("这是从新增任务弹窗直接填写的描述。");
    await dialog.getByRole("button", { name: "优先级：无优先级" }).click();
    const priorityMenu = dialog.getByRole("menu", { name: "选择优先级" });
    await expect(
      priorityMenu.getByRole("button", { name: "高", exact: true }).locator("i[data-active]"),
    ).toHaveCount(3);
    await expect(
      priorityMenu.getByRole("button", { name: "中", exact: true }).locator("i[data-active]"),
    ).toHaveCount(2);
    await expect(
      priorityMenu.getByRole("button", { name: "低", exact: true }).locator("i[data-active]"),
    ).toHaveCount(1);
    await priorityMenu.getByRole("button", { name: "高", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "优先级：高" })).toBeVisible();
  });

  await expect(detail.locator(".detail-description-read")).toContainText(
    "这是从新增任务弹窗直接填写的描述。",
  );
  await expect(detail.getByRole("button", { name: "优先级", exact: true })).toContainText("高");
  await detail.getByRole("button", { name: "返回看板" }).click();
});

test("新增任务完整选项真实持久化且双客户端关系同步", async ({ browser }) => {
  test.setTimeout(90_000);
  const project = await registerExecutableProject("CREATEFULL");
  const featureBranch = "feature/create-options";
  const featureWorktree = join(
    process.env.CODEXBOARD_DATA_DIR as string,
    `worktree-${randomUUID()}`,
  );
  execFileSync("git", ["-C", project.rootPath, "branch", featureBranch]);
  execFileSync("git", ["-C", project.rootPath, "worktree", "add", featureWorktree, featureBranch]);
  const contexts = await localAdminRequest<readonly DevelopmentContextFixture[]>(
    `/api/v1/local/projects/${project.id}/contexts/scan`,
    { method: "POST", body: "{}" },
  );
  const worktree = contexts.find(
    (context) => context.kind === "branch" && context.label === featureBranch,
  );
  expect(worktree).toBeDefined();

  const labelSeedContext = await browser.newContext();
  const labelSeedPage = await labelSeedContext.newPage();
  await openWorkspace(labelSeedPage);
  await ensureGlobalLabel(labelSeedPage, "持久化标签");
  await labelSeedContext.close();

  const createCandidate = (title: string, labels?: string): TaskFixture =>
    taskctl(
      "issue",
      "create",
      "--project",
      project.id,
      "--title",
      title,
      "--status",
      "todo",
      ...(labels ? ["--labels", labels] : []),
    ).data as unknown as TaskFixture;
  const parent = createCandidate("创建选项父任务", "持久化标签");
  const child = createCandidate("创建选项子任务");
  const secondChild = createCandidate("创建选项第二子任务");
  const thirdChild = createCandidate("详情添加第三子任务");
  const relatedOne = createCandidate("创建选项关联任务一");
  const relatedTwo = createCandidate("创建选项关联任务二");

  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  const first = await firstContext.newPage();
  const second = await secondContext.newPage();

  try {
    await Promise.all([openWorkspace(first), openWorkspace(second)]);
    await Promise.all([selectProject(first, project), selectProject(second, project)]);

    await second
      .getByTestId(`task-card-${relatedOne.identifier}`)
      .getByRole("button")
      .first()
      .click();
    const secondDetail = second.getByRole("region", { name: "任务详情", exact: true });
    await expect(secondDetail).toBeVisible();
    await expect(secondDetail.locator(".detail-relation-properties")).toBeVisible();
    await expect(secondDetail.locator(".detail-relation-item")).toHaveCount(0);

    const dialog = await openTaskCreateDialog(first);
    await dialog.getByLabel("任务标题").fill("完整创建选项任务");
    await expect(
      dialog.getByLabel(`负责人：${SYNTHETIC_FEISHU_NAME}`, { exact: true }),
    ).toBeVisible();
    await expect(dialog.getByRole("menu", { name: "选择负责人" })).toHaveCount(0);
    const options = await readPublicData<{ assignees: { identity: IdentityRef }[] }>(
      first,
      `/api/v1/projects/${project.id}/task-creation-options`,
    );
    expect(options.assignees.map((actor) => actor.identity)).toEqual([SYNTHETIC_FEISHU_IDENTITY]);
    await dialog.getByRole("combobox", { name: "分支 / Worktree" }).selectOption(worktree!.id);

    await dialog.getByRole("button", { name: /^标签：/ }).click();
    await dialog.getByRole("checkbox", { name: "持久化标签" }).check();
    await dialog.getByRole("heading", { name: "新增任务" }).click();

    await selectCreateRelation(dialog, "父", /创建选项父任务/);
    await selectCreateRelation(dialog, "子", /创建选项子任务/);
    await selectCreateRelation(dialog, "子", /创建选项第二子任务/);
    await selectCreateRelation(dialog, "关联", /创建选项关联任务一/);
    await selectCreateRelation(dialog, "关联", /创建选项关联任务二/);

    const fileInput = dialog.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: "spec.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# spec\n", "utf8"),
    });
    await fileInput.setInputFiles({
      name: "evidence.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("passed\n", "utf8"),
    });
    await expect(dialog.getByRole("button", { name: "添加附件，已选择 2 个" })).toBeVisible();

    const createResponse = first.waitForResponse(
      (response) =>
        response.request().method() === "POST" && response.url().endsWith("/api/v1/tasks"),
    );
    await dialog.getByRole("button", { name: "创建任务", exact: true }).click();
    const createPayload = (await (await createResponse).json()) as { data: TaskFixture };
    const created = createPayload.data;
    const detail = first.getByRole("region", { name: "任务详情", exact: true });
    await expect(detail).toBeVisible();

    const persisted = await readPublicData<TaskFixture>(first, `/api/v1/tasks/${created.id}`);
    expect(persisted).toMatchObject({
      id: created.id,
      labels: ["持久化标签"],
      assigneeIdentity: SYNTHETIC_FEISHU_IDENTITY,
      developmentContextId: worktree!.id,
      links: [],
    });

    const createdWorkspace = await readPublicData<TaskWorkspaceFixture>(
      first,
      `/api/v1/tasks/${created.id}/workspace`,
    );
    expect(
      createdWorkspace.relations.map(({ targetTaskId, relationType }) => ({
        targetTaskId,
        relationType,
      })),
    ).toEqual(
      expect.arrayContaining([
        { targetTaskId: parent.id, relationType: "parent" },
        { targetTaskId: child.id, relationType: "child" },
        { targetTaskId: secondChild.id, relationType: "child" },
        { targetTaskId: relatedOne.id, relationType: "related" },
        { targetTaskId: relatedTwo.id, relationType: "related" },
      ]),
    );
    expect(createdWorkspace.relations).toHaveLength(5);

    for (const [candidate, relationType] of [
      [parent, "child"],
      [child, "parent"],
      [secondChild, "parent"],
      [relatedOne, "related"],
      [relatedTwo, "related"],
    ] as const) {
      const workspace = await readPublicData<TaskWorkspaceFixture>(
        first,
        `/api/v1/tasks/${candidate.id}/workspace`,
      );
      expect(workspace.relations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ targetTaskId: created.id, relationType }),
        ]),
      );
    }

    await expect(secondDetail.locator(".detail-relation-properties")).toContainText(
      created.identifier,
      {
        timeout: 10_000,
      },
    );

    await detail.getByRole("button", { name: "添加子任务", exact: true }).click();
    await detail
      .getByRole("menuitem", { name: `${thirdChild.identifier} 详情添加第三子任务`, exact: true })
      .click();
    await expect(
      detail.getByRole("button", { name: `移除子任务 ${thirdChild.identifier}`, exact: true }),
    ).toBeVisible();
    const withThirdChild = await readPublicData<TaskWorkspaceFixture>(
      first,
      `/api/v1/tasks/${created.id}/workspace`,
    );
    expect(
      withThirdChild.relations.filter((relation) => relation.relationType === "child"),
    ).toHaveLength(3);

    await expect(detail.getByRole("link", { name: /spec\.md/ })).toBeVisible();
    await expect(detail.getByRole("link", { name: /evidence\.txt/ })).toBeVisible();

    await expect(detail.getByRole("button", { name: "添加链接" })).toHaveCount(0);
    await expect(detail.getByRole("button", { name: "复制链接" })).toHaveCount(0);
    await detail.getByRole("button", { name: "返回看板" }).click();
    const card = first.getByTestId(`task-card-${created.identifier}`);
    await expect(card.locator(".task-card-assignee")).toHaveAttribute(
      "title",
      SYNTHETIC_FEISHU_NAME,
    );
    await expect(card.locator(".task-card-assignee")).toHaveAttribute(
      "aria-label",
      `负责人：${SYNTHETIC_FEISHU_NAME}`,
    );
    await expect(card.locator(".priority")).toHaveCount(0);
  } finally {
    await Promise.all([firstContext.close(), secondContext.close()]);
  }
});

test("已认证合成用户打开工作台后只提供中文项目视图", async ({ page }) => {
  const project = await registerProject("AUTH");
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("401 (Unauthorized)")) {
      browserErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await page.addInitScript(() => {
    window.localStorage.setItem("codexboard:locale", "en");
  });
  await openWorkspace(page);
  await selectProject(page, project);
  await page.reload();

  await expect(
    page.getByRole("button", { name: new RegExp(`当前：${project.name}`) }),
  ).toBeVisible();
  await expect(page.locator(".project-key")).toHaveText(project.projectKey);
  await expect(page).toHaveURL("/");
  await expect(page.locator(".project-list-rail")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "连接本地工作台" })).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.getByRole("button", { name: "English", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "中文", exact: true })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "仪表盘" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Dashboard" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "新增任务", exact: true })).toBeEnabled();
  const detail = await createTaskAndOpenDetail(page, "中文工作流任务");
  await expect(detail.getByRole("textbox", { name: "标题" })).toHaveValue("中文工作流任务");
  await expect(detail.getByRole("button", { name: "状态", exact: true })).toBeVisible();
  await expect(detail.getByRole("button", { name: "优先级", exact: true })).toBeVisible();
  await expect(detail.getByRole("heading", { name: "Codex 执行" })).toBeVisible();
  await expect(detail.getByRole("heading", { name: "活动" })).toBeVisible();
  await expect(detail.getByRole("button", { name: "编辑描述", exact: true })).toBeVisible();
  await expect(
    detail
      .getByRole("complementary", { name: "任务属性" })
      .getByRole("button", { name: "添加关联任务", exact: true }),
  ).toBeVisible();
  await expect(detail.getByText("已自动保存", { exact: true })).toBeVisible();
  await detail.getByRole("button", { name: "返回看板" }).click();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(
    page.getByRole("button", { name: new RegExp(`当前：${project.name}`) }),
  ).toBeVisible();
  await expect(page.locator(".project-list-rail")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "English", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "中文", exact: true })).toHaveCount(0);
  await expect(
    page.evaluate(() => window.localStorage.getItem("codexboard:locale")),
  ).resolves.toBeNull();
  await expect(page.getByRole("button", { name: "退出" })).toHaveCount(0);
  await expect(page.getByText("PROJECTS", { exact: true })).toHaveCount(0);
  expect(browserErrors).toEqual([]);
});

test("全部项目可选归属项目，临时项目和 Codex 项目按当前看板创建待执行任务", async ({ page }) => {
  const project = await registerProject("CREATE");
  await openWorkspace(page);

  await selectProjectByName(page, "全部项目");
  await expect(page.locator(".project-key")).toHaveCount(0);
  const temporaryIdentifier = await quickCreate(page, "全部项目创建的临时任务", async (dialog) => {
    await expect(dialog.getByRole("combobox", { name: "任务归属项目" })).toHaveValue(
      "00000000-0000-4000-8000-0000000000a2",
    );
  });

  await selectProjectByName(page, "临时项目");
  await expect(page.locator(".project-key")).toHaveText("TEMP");
  await expect(page.locator(".project-roots")).toHaveText(temporaryProjectRoot());
  await expect(page.getByTestId(`task-card-${temporaryIdentifier}`)).toBeVisible();
  const directTemporaryIdentifier = await quickCreate(page, "临时项目直接创建", async (dialog) => {
    await expect(dialog.getByRole("combobox", { name: "任务归属项目" })).toHaveCount(0);
  });
  await page
    .getByTestId(`task-card-${directTemporaryIdentifier}`)
    .getByRole("button")
    .first()
    .click();
  const temporaryDetail = page.getByRole("region", { name: "任务详情", exact: true });
  const temporaryRun = temporaryDetail.getByRole("region", { name: "Run 控制台" });
  await expect(temporaryRun.getByRole("textbox", { name: "项目 Workspace Mapping" })).toHaveValue(
    "",
  );
  await expect(temporaryRun.getByRole("button", { name: "启动 Run" })).toBeDisabled();
  await expect(temporaryDetail.getByText(/\/tmp\/codexboard-e2e-/)).toHaveCount(0);
  await expect(temporaryDetail.getByText(resolve("apps/server"), { exact: true })).toHaveCount(0);
  await expect(temporaryDetail.getByRole("button", { name: "启动 Codex" })).toBeDisabled();
  await expect(temporaryDetail.getByText("先重新分配到 Codex 项目")).toBeVisible();
  await temporaryDetail.getByRole("button", { name: "返回看板" }).click();

  await selectProjectByName(page, "全部项目");
  const projectIdentifier = await quickCreate(page, "全部项目指定 Codex 项目", async (dialog) => {
    await dialog.getByRole("combobox", { name: "任务归属项目" }).selectOption(project.id);
  });

  await selectProject(page, project);
  await expect(page.getByTestId(`task-card-${projectIdentifier}`)).toBeVisible();
  const directProjectIdentifier = await quickCreate(page, "Codex 项目直接创建", async (dialog) => {
    await expect(dialog.getByRole("combobox", { name: "任务归属项目" })).toHaveCount(0);
  });
  await page
    .getByTestId(`task-card-${directProjectIdentifier}`)
    .getByRole("button")
    .first()
    .click();
  const projectDetail = page.getByRole("region", { name: "任务详情", exact: true });
  await expect(projectDetail.getByRole("button", { name: "启动 Codex" })).toBeEnabled();
  await expect(
    projectDetail.getByRole("region", { name: "执行摘要" }).getByText("暂无执行记录"),
  ).toBeVisible();
});

test("Codex 项目新增、改名、删除、恢复、新 ID 与临时任务重新分配实时同步", async ({ page }) => {
  test.setTimeout(90_000);
  const project = await registerProject("PSYNC");
  await openWorkspace(page);

  const initialMenu = await openProjectMenu(page);
  await expect(initialMenu.getByRole("menuitem", { name: "全部项目", exact: true })).toContainText(
    "全部项目",
  );
  await expect(initialMenu.getByRole("menuitem", { name: "临时项目", exact: true })).toContainText(
    "临时项目",
  );
  await expect(
    initialMenu
      .getByRole("menuitem", { name: "全部项目", exact: true })
      .locator('[data-sf-symbol="square.3.layers.3d"]'),
  ).toBeVisible();
  await expect(
    initialMenu
      .getByRole("menuitem", { name: "临时项目", exact: true })
      .locator('[data-sf-symbol="clock"]'),
  ).toBeVisible();
  await expect(
    initialMenu
      .getByRole("menuitem", { name: project.name, exact: true })
      .locator('[data-sf-symbol="folder"]'),
  ).toBeVisible();
  await selectProject(page, project);
  await expect(page.getByText("Codex Desktop 只读同步", { exact: true })).toHaveCount(0);
  await expect(page.locator(".project-roots")).toHaveText(project.rootPath);
  // Importing Codex Desktop metadata must not expose edit/delete controls for
  // the imported project; DevBoard's separate project-creation action remains available.
  await expect(page.getByRole("button", { name: "新建项目", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /编辑项目|删除项目/ })).toHaveCount(0);

  const identifier = await quickCreate(page, "项目同步历史任务");
  const renamedProject = `${project.name} 已改名`;
  let originalEntry: SnapshotProject | undefined;
  updateProjectSnapshot((projects) =>
    projects.map((entry) => {
      if (entry.codexProjectId !== project.codexProjectId) return entry;
      originalEntry = entry;
      return { ...entry, name: renamedProject };
    }),
  );
  await expect(
    page.getByRole("button", { name: new RegExp(`当前：${renamedProject}`) }),
  ).toBeVisible({ timeout: 8_000 });

  updateProjectSnapshot((projects) =>
    projects.filter((entry) => entry.codexProjectId !== project.codexProjectId),
  );
  await expect(
    (await openProjectMenu(page)).getByRole("menuitem", { name: renamedProject }),
  ).toHaveCount(0, {
    timeout: 8_000,
  });
  await selectProjectByName(page, "临时项目");
  await expect(page.getByTestId(`task-card-${identifier}`)).toBeVisible();
  await expect(page.getByText(`原项目：${renamedProject}`, { exact: true })).toBeVisible();

  const restoredEntry = {
    ...(originalEntry as SnapshotProject),
    name: renamedProject,
  };
  updateProjectSnapshot((projects) => [...projects, restoredEntry]);
  await expect(
    (await openProjectMenu(page)).getByRole("menuitem", { name: renamedProject }),
  ).toBeVisible({
    timeout: 8_000,
  });
  await selectProjectByName(page, renamedProject);
  await expect(page.getByTestId(`task-card-${identifier}`)).toBeVisible();

  updateProjectSnapshot((projects) =>
    projects.filter((entry) => entry.codexProjectId !== project.codexProjectId),
  );
  await expect(
    (await openProjectMenu(page)).getByRole("menuitem", { name: renamedProject }),
  ).toHaveCount(0, {
    timeout: 8_000,
  });
  const replacementCodexProjectId = randomUUID();
  const replacementName = `${project.name} 同目录新项目`;
  updateProjectSnapshot((projects) => [
    ...projects,
    {
      codexProjectId: replacementCodexProjectId,
      name: replacementName,
      rootPaths: [project.rootPath],
      position: projects.length,
    },
  ]);
  await expect(
    (await openProjectMenu(page)).getByRole("menuitem", { name: replacementName }),
  ).toBeVisible({
    timeout: 8_000,
  });
  await selectProjectByName(page, "临时项目");
  await expect(page.getByTestId(`task-card-${identifier}`)).toBeVisible();

  await page.getByTestId(`task-card-${identifier}`).getByRole("button").first().click();
  const detail = page.getByRole("region", { name: "任务详情", exact: true });
  await expect(detail.getByRole("heading", { name: "重新分配到 Codex 项目" })).toBeVisible();
  await detail.getByLabel("重新分配目标项目").selectOption({ label: replacementName });
  await detail.getByRole("button", { name: "确认分配" }).click();
  await expect(detail.getByRole("heading", { name: "重新分配到 Codex 项目" })).toHaveCount(0);
  await detail.getByRole("button", { name: "返回看板" }).click();

  const replacement = (await localProjects()).find((value) => value.name === replacementName);
  expect(replacement).toBeDefined();
  await selectProjectByName(page, replacementName);
  await expect(page.getByTestId(`task-card-${identifier}`)).toBeVisible();
});

test("顶部项目切换器筛选后可通过外部点击、Escape 与选择重置查询关闭", async ({ page }) => {
  const project = await registerProject("SWITCHER");
  await openWorkspace(page);

  const trigger = page.getByRole("button", { name: /切换项目，当前/ });
  const menu = page.getByRole("menu", { name: "切换项目" });
  const search = menu.getByRole("searchbox", { name: "筛选项目" });

  await trigger.click();
  await expectProjectMenuItemToReceivePointer(page, "临时项目");
  await expect(search).toBeFocused();
  await search.fill(project.name);
  await expect(menu.getByRole("menuitem", { name: project.name, exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "全部项目", exact: true })).toHaveCount(0);

  const workspaceBox = await page.locator(".board-workspace").boundingBox();
  const menuBox = await menu.boundingBox();
  expect(workspaceBox).not.toBeNull();
  expect(menuBox).not.toBeNull();
  const outsidePoint = {
    x: workspaceBox!.x + workspaceBox!.width - 16,
    y: workspaceBox!.y + workspaceBox!.height - 16,
  };
  expect(outsidePoint.x).toBeGreaterThan(menuBox!.x + menuBox!.width);
  expect(outsidePoint.y).toBeGreaterThan(menuBox!.y + menuBox!.height);
  await page.mouse.click(outsidePoint.x, outsidePoint.y);
  await expect(menu).toHaveCount(0);

  await trigger.click();
  await search.fill(project.name);
  await search.press("Tab");
  await expect(menu.getByRole("menuitem", { name: project.name, exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  await search.fill(project.name);
  await menu.getByRole("menuitem", { name: project.name, exact: true }).click();
  await expect(trigger).toHaveAccessibleName(new RegExp(`当前：${project.name}`));

  await trigger.click();
  await expect(search).toHaveValue("");
  await expect(menu.getByRole("menuitem", { name: "全部项目", exact: true })).toBeVisible();
});

test("项目菜单显示可见的切换项目标题", async ({ page }) => {
  await openWorkspace(page);

  const menu = await openProjectMenu(page);
  const heading = menu.getByRole("heading", { name: "切换项目", exact: true });
  const search = menu.getByRole("searchbox", { name: "筛选项目" });

  await expect(heading).toBeVisible();
  await expect(heading).toHaveCSS("color", "rgb(147, 147, 147)");
  const [headingBox, searchBox] = await Promise.all([heading.boundingBox(), search.boundingBox()]);
  expect(headingBox).not.toBeNull();
  expect(searchBox).not.toBeNull();
  expect(headingBox!.y + headingBox!.height).toBeLessThanOrEqual(searchBox!.y);
});

test("键盘筛选并选择临时项目后焦点返回项目触发器", async ({ page }) => {
  await openWorkspace(page);

  const trigger = page.getByRole("button", { name: /切换项目，当前/ });
  const menu = await openProjectMenu(page);
  const search = menu.getByRole("searchbox", { name: "筛选项目" });
  await search.fill("临时项目");
  await search.press("Tab");
  await expect(menu.getByRole("menuitem", { name: "临时项目", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(menu).toHaveCount(0);
  await expect(trigger).toHaveAccessibleName(/当前：临时项目/);
  await expect(trigger).toBeFocused();
});

test("长项目名在窄屏省略且右侧 Key 与目录保持两行可见", async ({ page }) => {
  const project = await registerProject("LONGPROJECT", "codexboard-responsive-interactions");
  await openWorkspace(page);
  await selectProject(page, project);

  const trigger = page.getByRole("button", { name: new RegExp(`当前：${project.name}`) });
  const triggerName = trigger.locator("span").first();
  const metadata = page.locator(".board-project-meta");
  const key = page.locator(".project-key");
  const roots = page.locator(".project-roots");

  await page.setViewportSize({ width: 1280, height: 900 });
  const desktop = await page.evaluate(() => {
    const triggerNode = document.querySelector<HTMLElement>(".project-switcher__trigger");
    const nameNode = triggerNode?.querySelector<HTMLElement>("span");
    const metadataNode = document.querySelector<HTMLElement>(".board-project-meta");
    if (!triggerNode || !nameNode || !metadataNode) return null;
    const triggerBox = triggerNode.getBoundingClientRect();
    const metadataBox = metadataNode.getBoundingClientRect();
    return {
      triggerRight: triggerBox.right,
      metadataLeft: metadataBox.left,
      metadataWidth: metadataBox.width,
      nameOverflows: nameNode.scrollWidth > nameNode.clientWidth,
      pageOverflows: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
  expect(desktop).not.toBeNull();
  expect(desktop!.triggerRight).toBeLessThanOrEqual(desktop!.metadataLeft + 1);
  expect(desktop!.metadataWidth).toBeGreaterThan(100);
  expect(desktop!.nameOverflows).toBe(false);
  expect(desktop!.pageOverflows).toBe(false);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(triggerName).toBeVisible();
  await expect(metadata).toBeVisible();
  await expect(key).toBeVisible();
  await expect(roots).toBeVisible();
  const narrow = await page.evaluate(() => {
    const triggerNode = document.querySelector<HTMLElement>(".project-switcher__trigger");
    const nameNode = triggerNode?.querySelector<HTMLElement>("span");
    const metadataNode = document.querySelector<HTMLElement>(".board-project-meta");
    const keyNode = document.querySelector<HTMLElement>(".project-key");
    const rootsNode = document.querySelector<HTMLElement>(".project-roots");
    if (!triggerNode || !nameNode || !metadataNode || !keyNode || !rootsNode) return null;
    const triggerBox = triggerNode.getBoundingClientRect();
    const metadataBox = metadataNode.getBoundingClientRect();
    const keyBox = keyNode.getBoundingClientRect();
    const rootsBox = rootsNode.getBoundingClientRect();
    return {
      triggerRight: triggerBox.right,
      metadataLeft: metadataBox.left,
      metadataWidth: metadataBox.width,
      keyWidth: keyBox.width,
      rootsWidth: rootsBox.width,
      keyBottom: keyBox.bottom,
      rootsTop: rootsBox.top,
      nameOverflows: nameNode.scrollWidth > nameNode.clientWidth,
      pageOverflows:
        document.documentElement.scrollWidth > window.innerWidth ||
        document.body.scrollWidth > window.innerWidth,
    };
  });
  expect(narrow).not.toBeNull();
  expect(narrow!.triggerRight).toBeLessThanOrEqual(narrow!.metadataLeft + 1);
  expect(narrow!.metadataWidth).toBeGreaterThan(40);
  expect(narrow!.keyWidth).toBeGreaterThan(0);
  expect(narrow!.rootsWidth).toBeGreaterThan(0);
  expect(narrow!.rootsTop).toBeGreaterThanOrEqual(narrow!.keyBottom);
  expect(narrow!.nameOverflows).toBe(true);
  expect(narrow!.pageOverflows).toBe(false);
  await expect(trigger).toHaveAccessibleName(`切换项目，当前：${project.name}`);
  await expect(trigger).toHaveAttribute("title", project.name);
});

test("桌面项目工作区保持满高", async ({ page }) => {
  const project = await registerProject("FULLHEIGHT");
  await openWorkspace(page);
  await selectProject(page, project);

  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  await expect(page.locator(".board-workspace")).toHaveJSProperty("clientHeight", viewport!.height);
});

test("三视图共享筛选并安全呈现评论、附件、关系与活动", async ({ page }) => {
  test.setTimeout(60_000);
  const project = await registerProject("VIEWS");
  await openWorkspace(page);
  await selectProject(page, project);

  for (const name of ["仪表盘", "看板", "列表"]) {
    await expect(page.getByRole("tab", { name })).toBeVisible();
  }
  await expect(page.getByRole("tab", { name: "项目文档" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "甘特图" })).toHaveCount(0);
  const first = await quickCreate(page, "工作区任务");
  const second = await quickCreate(page, "关联任务");
  await page.getByTestId(`task-card-${first}`).getByRole("button").first().click();
  const detail = page.getByRole("region", { name: "任务详情", exact: true });
  await detail.getByRole("button", { name: "编辑描述" }).click();
  await detail
    .getByLabel("描述", { exact: true })
    .fill(
      '## 安全描述\n\n<script>window.__workspaceXss = true</script>\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```mermaid\ngraph TD\nA --> B\nclick A "javascript:window.__mermaidXss=true"\n```',
    );
  await detail.getByLabel("描述", { exact: true }).blur();
  await expect(detail.getByRole("heading", { name: "安全描述" })).toBeVisible();
  await expect(detail.locator("script")).toHaveCount(0);
  await expect(detail.locator(".mermaid-diagram svg")).toBeVisible();
  await expect(detail.locator(".markdown-error")).toHaveCount(0);
  await expect(detail.locator('.mermaid-diagram [href^="javascript:"]')).toHaveCount(0);
  await expect(detail.locator(".mermaid-diagram [onload], .mermaid-diagram [onerror]")).toHaveCount(
    0,
  );
  expect(
    await page.evaluate(() => {
      const unsafeWindow = window as typeof window & {
        __workspaceXss?: boolean;
        __mermaidXss?: boolean;
      };
      return unsafeWindow.__workspaceXss || unsafeWindow.__mermaidXss;
    }),
  ).not.toBe(true);
  await detail.locator(".task-detail-topbar").click();
  await expect(detail.getByText("已自动保存", { exact: true })).toBeVisible();

  await detail.getByLabel("新评论").fill("**进度**：评论已写入");
  await expect(detail.getByRole("button", { name: "发表评论" })).toBeEnabled();
  await detail.getByRole("button", { name: "发表评论" }).click({ force: true });
  await expect(detail.getByText("评论已写入")).toBeVisible();
  await detail.getByRole("button", { name: "编辑描述" }).click();
  await detail.getByLabel("添加描述附件").setInputFiles({
    name: "evidence.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("workspace evidence", "utf8"),
  });
  await expect(detail.getByRole("link", { name: /evidence\.txt/ })).toBeVisible();
  const properties = detail.getByRole("complementary", { name: "任务属性" });
  await properties.getByRole("button", { name: "添加关联任务", exact: true }).click();
  await expect(properties.getByRole("searchbox", { name: "搜索任务" })).toBeFocused();
  await expect(properties.getByRole("searchbox", { name: "搜索任务" })).toHaveCSS(
    "outline-style",
    "none",
  );
  await properties.getByRole("searchbox", { name: "搜索任务" }).fill(second);
  await properties.getByRole("menuitem", { name: `${second} 关联任务`, exact: true }).click();
  await expect(properties.getByText(second, { exact: true })).toBeVisible();
  await expect(detail.getByRole("region", { name: "关系", exact: true })).toHaveCount(0);
  await properties.getByRole("button", { name: `移除关联任务 ${second}`, exact: true }).click();
  await expect(properties.getByText(second, { exact: true })).toHaveCount(0);
  for (const type of ["父任务", "子任务"]) {
    await properties.getByRole("button", { name: `添加${type}`, exact: true }).click();
    await properties.getByRole("searchbox", { name: "搜索任务" }).fill("不存在的候选任务");
    await expect(properties.getByText("暂无可绑定任务", { exact: true })).toBeVisible();
    await properties.getByRole("searchbox", { name: "搜索任务" }).fill("关联任务");
    await properties.getByRole("menuitem", { name: `${second} 关联任务`, exact: true }).click();
    await expect(
      properties.getByRole("button", { name: `移除${type} ${second}`, exact: true }),
    ).toBeVisible();
    await properties.getByRole("button", { name: `添加${type}`, exact: true }).click();
    await expect(
      properties.getByRole("menuitem", { name: `${second} 关联任务`, exact: true }),
    ).toBeDisabled();
    await properties.getByRole("searchbox", { name: "搜索任务" }).press("Escape");
    await properties.getByRole("button", { name: `移除${type} ${second}`, exact: true }).click();
    await expect(properties.getByText(second, { exact: true })).toHaveCount(0);
  }
  await expect(
    detail
      .locator("#conversation-title")
      .evaluate((element) =>
        Boolean(
          element.compareDocumentPosition(document.getElementById("activity-title")!) &
          Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      ),
  ).resolves.toBe(true);
  await expect(
    detail.getByRole("region", { name: "对话", exact: true }).getByText("评论已写入"),
  ).toBeVisible();
  await expect(detail.getByText("上传了附件", { exact: false })).toBeVisible();
  await detail.getByRole("button", { name: "返回看板" }).click();

  await page.getByRole("tab", { name: "列表" }).click();
  await page.keyboard.press("/");
  await expect(page.getByRole("searchbox", { name: "搜索任务" })).toBeFocused();
  await page.getByRole("searchbox", { name: "搜索任务" }).fill(first);
  await page.locator(".issue-list-group.status-backlog .issue-list-group-header").click();
  await expect(page.locator(".issue-list-row").filter({ hasText: first })).toBeVisible();
  await page.getByRole("tab", { name: "仪表盘" }).click();
  await expect(page.getByText("任务总数")).toBeVisible();
  const priorities = page.getByRole("region", { name: "优先级分布" });
  await expect(priorities.getByText("无优先级")).toBeVisible();
  await expect(priorities.getByText("2", { exact: true })).toBeVisible();
});

test("CLI 修改通过 HTTP 实时出现在 H5", async ({ page }) => {
  const project = await registerProject("CLI");
  await openWorkspace(page);
  await selectProject(page, project);
  const created = taskctl(
    "issue",
    "create",
    "--project",
    project.id,
    "--title",
    "taskctl 实时任务",
    "--status",
    "todo",
  ).data;
  expect(created.assigneeIdentity).toEqual(SYNTHETIC_FEISHU_IDENTITY);
  expect(created.creatorIdentity).toEqual(SYNTHETIC_FEISHU_IDENTITY);
  const identifier = String(created.identifier);
  const taskId = String(created.id);
  await expect(page.getByTestId(`task-card-${identifier}`)).toBeVisible();
  taskctl(
    "issue",
    "update",
    taskId,
    "--version",
    String(created.version),
    "--description",
    "CLI/H5 一致性证据",
  );
  await page.getByTestId(`task-card-${identifier}`).getByRole("button").first().click();
  await expect(
    page
      .getByRole("region", { name: "任务详情", exact: true })
      .getByRole("button", { name: "编辑描述" }),
  ).toContainText("CLI/H5 一致性证据");
});

test("七状态、筛选、其他任务和物理删除形成完整闭环", async ({ page }) => {
  const project = await registerProject("FLOW");
  await openWorkspace(page);
  await selectProject(page, project);

  const first = taskctl(
    "issue",
    "create",
    "--project",
    project.id,
    "--title",
    "搜索目标任务",
    "--status",
    "todo",
  ).data;
  const second = taskctl(
    "issue",
    "create",
    "--project",
    project.id,
    "--title",
    "其他活动任务",
    "--status",
    "backlog",
  ).data;
  const blocked = taskctl(
    "issue",
    "create",
    "--project",
    project.id,
    "--title",
    "等待外部依赖",
    "--status",
    "blocked",
  ).data;

  for (const status of ["backlog", "todo", "in_progress", "in_review"]) {
    await expect(page.getByTestId(`status-column-${status}`)).toBeVisible();
  }
  await expect(page.getByTestId(`task-card-${String(blocked.identifier)}`)).toContainText("已阻塞");
  await expect(
    page
      .getByTestId("status-column-in_progress")
      .getByTestId(`task-card-${String(blocked.identifier)}`),
  ).toBeVisible();

  const searchButton = page.getByRole("button", { name: "搜索任务", exact: true });
  await expect(searchButton.locator(".sf-symbol")).toHaveAttribute(
    "data-sf-symbol",
    "magnifyingglass",
  );
  await searchButton.click();
  const search = page.getByRole("searchbox", { name: "搜索任务" });
  await search.fill("搜索目标");
  await expect(page.getByTestId(`task-card-${String(first.identifier)}`)).toBeVisible();
  await expect(page.getByTestId(`task-card-${String(second.identifier)}`)).toHaveCount(0);
  await page.getByRole("button", { name: "清除并收起搜索" }).click();

  const absentLabel = `空标签-${randomUUID().slice(0, 6)}`;
  await ensureGlobalLabel(page, absentLabel);
  await page.getByRole("button", { name: "筛选任务" }).click();
  await page.getByRole("menuitem", { name: "状态" }).hover();
  const statusMenu = page.getByRole("menu", { name: "按状态筛选" });
  await expect(statusMenu).toBeVisible();
  await expect(statusMenu.getByRole("menuitemcheckbox", { name: "待验收" })).toBeVisible();
  await expect(statusMenu.getByRole("menuitemcheckbox", { name: "已完成" })).toBeVisible();
  await expect(statusMenu.getByRole("menuitemcheckbox", { name: "已取消" })).toBeVisible();
  await page.getByRole("menuitem", { name: "标签" }).hover();
  await expect(
    page.getByRole("menu", { name: "按标签筛选" }).getByRole("menuitemcheckbox", {
      name: absentLabel,
    }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");

  const reviewIcon = page
    .getByTestId("status-column-in_review")
    .locator(".status-header .sf-symbol")
    .first();
  await expect(reviewIcon).toHaveAttribute("data-sf-symbol", "eye");
  await expect(reviewIcon).toBeVisible();
  const reviewIconBox = await reviewIcon.boundingBox();
  expect(reviewIconBox).not.toBeNull();
  expect(reviewIconBox!.width).toBeGreaterThan(0);
  expect(reviewIconBox!.height).toBeGreaterThan(0);
  const reviewIconMasks = await reviewIcon.evaluate((element) => {
    const style = getComputedStyle(element);
    return [style.maskImage, style.getPropertyValue("-webkit-mask-image")];
  });
  expect(reviewIconMasks.some((mask) => /^url\(.+\)$/.test(mask))).toBe(true);

  const canceledIdentifier = await quickCreate(page, "归档后彻底删除");
  await page.getByTestId(`task-card-${canceledIdentifier}`).getByRole("button").first().click();
  const detail = page.getByRole("region", { name: "任务详情", exact: true });
  const canceledTask = (
    await readPublicData<{ tasks: (TaskFixture & { version: number })[] }>(
      page,
      `/api/v1/projects/${project.id}/board`,
    )
  ).tasks.find((task) => task.identifier === canceledIdentifier)!;
  taskctl(
    "issue",
    "move",
    canceledTask.id,
    "--version",
    String(canceledTask.version),
    "--status",
    "canceled",
  );
  await expect(detail.getByRole("button", { name: "状态", exact: true })).toContainText("已取消");
  await detail.locator(".task-detail-topbar").click();
  await expect(page.locator(".inline-alert")).toHaveCount(0);
  await detail.getByRole("button", { name: "返回看板" }).click();
  await expect(page.getByTestId(`task-card-${canceledIdentifier}`)).toHaveCount(0);

  await selectProjectByName(page, "全部项目");

  await page.setViewportSize({ width: 1600, height: 1000 });
  const archiveTrigger = page.getByRole("button", { name: "打开其他任务" });
  const archiveTriggerBox = await archiveTrigger.boundingBox();
  const archiveDrawer = page.locator(".archive-drawer");
  const closedDrawerMotion = await archiveDrawer.evaluate((element) => {
    const style = getComputedStyle(element);
    const matrix =
      style.transform === "none" ? new DOMMatrixReadOnly() : new DOMMatrixReadOnly(style.transform);
    return {
      scaleX: Math.hypot(matrix.a, matrix.b),
      scaleY: Math.hypot(matrix.c, matrix.d),
      transitionDuration: style.transitionDuration,
      transitionProperty: style.transitionProperty,
    };
  });
  await archiveTrigger.click();
  const drawer = page.getByRole("complementary", { name: "其他任务" });
  await expect(drawer).toBeVisible();
  await expect(drawer).toHaveCSS("position", "relative");
  await page.waitForTimeout(350);
  await expect(drawer.locator(".other-tasks-header")).toHaveCSS(
    "background-color",
    "rgb(225, 227, 230)",
  );

  const columnWidths = await page
    .locator(".status-column")
    .evaluateAll((columns) => columns.map((column) => column.getBoundingClientRect().width));
  const archiveLayout = await drawer.evaluate((element) => {
    const parent = element.parentElement;
    return {
      drawerWidth: element.getBoundingClientRect().width,
      parentColumns: parent ? getComputedStyle(parent).gridTemplateColumns : "",
      configuredWideColumnWidth: parent
        ? getComputedStyle(parent).getPropertyValue("--board-column-width")
        : "",
    };
  });
  expect(columnWidths).toHaveLength(5);
  expect(columnWidths.every((width) => width >= 300 && width <= 400)).toBe(true);
  expect(
    Math.max(...columnWidths) - Math.min(...columnWidths),
    `宽屏归档已打开时的五列像素宽度：${columnWidths.join(", ")}；` +
      `归档 ${archiveLayout.drawerWidth}px，父网格 ${archiveLayout.parentColumns}，` +
      `配置值 ${archiveLayout.configuredWideColumnWidth.trim()}`,
  ).toBeLessThan(2);

  const activeCardWidth = await page
    .getByTestId(`task-card-${String(first.identifier)}`)
    .evaluate((card) => {
      const stack = card.parentElement;
      if (!stack) return { card: card.getBoundingClientRect().width, content: undefined };
      const style = getComputedStyle(stack);
      return {
        card: card.getBoundingClientRect().width,
        content: stack.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      };
    });
  expect(activeCardWidth.content).toBeDefined();
  expect(Math.abs(activeCardWidth.card - activeCardWidth.content!)).toBeLessThan(1);

  const drawerMotion = await drawer.evaluate((element) => {
    const style = getComputedStyle(element);
    const matrix =
      style.transform === "none" ? new DOMMatrixReadOnly() : new DOMMatrixReadOnly(style.transform);
    return {
      scaleX: Math.hypot(matrix.a, matrix.b),
      scaleY: Math.hypot(matrix.c, matrix.d),
      transitionDuration: style.transitionDuration,
      transitionProperty: style.transitionProperty,
    };
  });
  const transitionProperties = drawerMotion.transitionProperty
    .split(",")
    .map((property) => property.trim());
  const transitionDurations = drawerMotion.transitionDuration
    .split(",")
    .map((duration) => duration.trim());
  const transformTransitionIndex = transitionProperties.lastIndexOf("transform");
  expect(archiveTriggerBox).not.toBeNull();
  expect(transformTransitionIndex).toBeGreaterThanOrEqual(0);
  expect(transitionDurations).not.toHaveLength(0);
  expect(transitionDurations[transformTransitionIndex % transitionDurations.length]).toBe("0.32s");
  expect(closedDrawerMotion.scaleX).toBeCloseTo(1, 6);
  expect(closedDrawerMotion.scaleY).toBeCloseTo(1, 6);
  expect(drawerMotion.scaleX).toBeCloseTo(1, 6);
  expect(drawerMotion.scaleY).toBeCloseTo(1, 6);
  await expect(drawer.getByRole("button", { name: "关闭其他任务" })).toHaveCount(0);
  await expect(page.locator(".archive-drawer-backdrop")).toHaveCount(0);

  await page.getByRole("button", { name: "关闭其他任务" }).click();
  await expect(archiveDrawer).toHaveAttribute("aria-hidden", "true");
  await page.waitForTimeout(350);

  await page.setViewportSize({ width: 1280, height: 1000 });
  const boardWidthBefore = await page.locator(".kanban").evaluate((element) => element.clientWidth);
  const narrowArchiveTrigger = page.getByRole("button", { name: "打开其他任务" });
  const narrowArchiveTriggerBox = await narrowArchiveTrigger.boundingBox();
  await narrowArchiveTrigger.click();
  await expect(drawer).toHaveCSS("position", "absolute");
  await expect(drawer.locator(".other-tasks-header")).toHaveCSS(
    "background-color",
    "rgb(225, 227, 230)",
  );
  const drawerBox = await drawer.boundingBox();
  const boardWidthAfter = await page.locator(".kanban").evaluate((element) => element.clientWidth);
  expect(narrowArchiveTriggerBox).not.toBeNull();
  expect(drawerBox).not.toBeNull();
  expect(drawerBox!.y).toBeGreaterThanOrEqual(narrowArchiveTriggerBox!.y);
  expect(boardWidthAfter).toBe(boardWidthBefore);
  await drawer.getByRole("tab", { name: /已取消/ }).click();
  await expect(drawer.getByText(canceledIdentifier)).toBeVisible();
  await drawer.getByRole("button", { name: `彻底删除任务 ${canceledIdentifier}` }).click();
  const confirmation = page.getByRole("alertdialog", {
    name: `彻底删除 ${canceledIdentifier}？`,
  });
  await expect(confirmation).toContainText("Codex 原始任务将先归档");
  const confirmationBox = await confirmation.boundingBox();
  const viewport = page.viewportSize();
  expect(confirmationBox).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(
    Math.abs(confirmationBox!.x + confirmationBox!.width / 2 - viewport!.width / 2),
  ).toBeLessThan(2);
  expect(
    Math.abs(confirmationBox!.y + confirmationBox!.height / 2 - viewport!.height / 2),
  ).toBeLessThan(2);
  await confirmation.getByRole("button", { name: "永久删除" }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(page.getByText(new RegExp(`已永久删除 ${canceledIdentifier}`))).toBeVisible();
  await expect(drawer.getByText(canceledIdentifier)).toHaveCount(0);

  await expect(page.locator("[data-lucide]")).toHaveCount(0);
  expect(await page.locator(".sf-symbol").count()).toBeGreaterThan(7);
});

test("详情改变状态立即同步全部项目并支持删除已完成卡片", async ({ page }) => {
  const renderErrors: string[] = [];
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /InvalidStateError|Taskboard render failure/.test(message.text())
    ) {
      renderErrors.push(message.text());
    }
  });
  const project = await registerProject("STATUSNOW");
  const created = taskctl(
    "issue",
    "create",
    "--project",
    project.id,
    "--title",
    "状态即时显示验收",
    "--status",
    "in_review",
  ).data;
  const identifier = String(created.identifier);
  await openWorkspace(page);
  await selectProjectByName(page, "全部项目");
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.getByRole("button", { name: "打开其他任务" }).click();
  await page.getByTestId(`task-card-${identifier}`).getByRole("button").first().click();
  const detail = page.getByRole("region", { name: "任务详情", exact: true });
  await expect(detail.getByRole("button", { name: "状态", exact: true })).toContainText("待验收");
  let releaseReads!: () => void;
  const readsGate = new Promise<void>((resolve) => {
    releaseReads = resolve;
  });
  await page.route(/\/api\/v1\/projects\/[^/]+\/board$/, async (route) => {
    if (route.request().method() === "GET") await readsGate;
    await route.continue();
  });
  const drawer = page.getByRole("complementary", { name: "其他任务" });
  try {
    await detail.getByRole("button", { name: "状态", exact: true }).click();
    await expect(detail.getByRole("option", { name: "已完成", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await detail.getByRole("button", { name: "状态", exact: true }).click();
    await detail.getByRole("option", { name: "处理中", exact: true }).click();
    await expect(detail.getByText("已自动保存", { exact: true })).toBeVisible();
    await detail.getByRole("button", { name: "返回看板", exact: true }).click();
    await expect(
      page.getByTestId("status-column-in_progress").getByTestId(`task-card-${identifier}`),
    ).toBeVisible();
    await expect(page.locator(".inline-alert")).toHaveCount(0);
  } finally {
    releaseReads();
    if (!page.isClosed()) await page.unrouteAll({ behavior: "ignoreErrors" });
  }
  const latest = await readPublicData<TaskFixture & { version: number }>(
    page,
    `/api/v1/tasks/${String(created.id)}`,
  );
  const readyToComplete = taskctl(
    "issue",
    "move",
    String(created.id),
    "--version",
    String(latest.version),
    "--status",
    "in_review",
  ).data;
  taskctl(
    "issue",
    "move",
    String(created.id),
    "--version",
    String(readyToComplete.version),
    "--status",
    "done",
  );
  await expect(drawer.getByText(identifier, { exact: true })).toBeVisible();
  await drawer.getByRole("button", { name: `彻底删除任务 ${identifier}` }).click();
  const confirmation = page.getByRole("alertdialog", { name: `彻底删除 ${identifier}？` });
  await confirmation.getByRole("button", { name: "永久删除", exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(drawer.getByText(identifier, { exact: true })).toHaveCount(0);
  expect(renderErrors).toEqual([]);
});

test("看板表面与四类活动状态表头使用截图同系配色", async ({ page }) => {
  const project = await registerProject("COLOR");
  await openWorkspace(page);
  await selectProject(page, project);

  await expect(page.locator(".project-list-rail")).toHaveCount(0);
  const expectedHeaders = {
    backlog: ["rgb(243, 237, 254)", "rgb(142, 74, 247)"],
    todo: ["rgb(255, 246, 222)", "rgb(199, 131, 24)"],
    in_progress: ["rgb(228, 241, 231)", "rgb(74, 164, 97)"],
    in_review: ["rgb(236, 241, 254)", "rgb(76, 125, 247)"],
  } as const;

  const activeColumns = page.locator(".status-column:not(.status-column--archive)");
  await expect(activeColumns).toHaveCount(Object.keys(expectedHeaders).length);

  for (const [status, expected] of Object.entries(expectedHeaders)) {
    const column = page.getByTestId(`status-column-${status}`);
    await expect(column).toHaveCount(1);
    await expect(column).toHaveCSS("background-color", "rgb(248, 248, 249)");
    const actual = await column.locator(".status-header").evaluate((element) => {
      const style = getComputedStyle(element);
      return [style.backgroundColor, style.color];
    });
    expect(actual).toEqual(expected);
  }

  await expect(page.getByTestId("status-column-blocked")).toHaveCount(0);
  await expect(page.getByTestId("status-column-done")).toHaveCount(0);
  await expect(page.getByTestId("status-column-canceled")).toHaveCount(0);

  const identifier = await quickCreate(page, "配色验收示例");
  await expect(page.getByTestId(`task-card-${identifier}`)).toHaveCSS(
    "background-color",
    "rgb(255, 255, 255)",
  );
});

test("响应式交互综合回归覆盖导航、其他任务与尺寸", async ({ page }) => {
  const project = await registerProject("RESPONSIVE");
  await openWorkspace(page);
  await selectProject(page, project);

  await expect(page.locator(".project-list-rail")).toHaveCount(0);
  const workspaceTabs = page.locator(".workspace-tabs").getByRole("tab");
  await expect(workspaceTabs).toHaveCount(3);
  await expect(workspaceTabs.locator(".sf-symbol")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "打开其他任务" })).toBeVisible();
  await expect(page.getByRole("button", { name: /进入下一列/ })).toHaveCount(0);

  for (const viewport of [
    { width: 1080, height: 900 },
    { width: 1280, height: 900 },
    { width: 1400, height: 900 },
    { width: 1600, height: 1000 },
  ]) {
    await expectWorkspaceToFitViewport(page, viewport);
  }
});

test("其他任务列沿用活动状态列的表头和任务卡片视觉", async ({ page }) => {
  const project = await registerProject("ARCHSTYLE");
  await openWorkspace(page);
  await selectProject(page, project);
  const active = taskctl(
    "issue",
    "create",
    "--project",
    project.id,
    "--title",
    "活动卡片基线",
    "--status",
    "todo",
  ).data;
  const canceled = taskctl(
    "issue",
    "create",
    "--project",
    project.id,
    "--title",
    "归档卡片对照",
    "--status",
    "canceled",
  ).data;
  const activeCard = page.getByTestId(`task-card-${String(active.identifier)}`);
  await expect(activeCard).toBeVisible();

  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.getByRole("button", { name: "打开其他任务" }).click();
  const drawer = page.getByRole("complementary", { name: "其他任务" });
  await drawer.getByRole("tab", { name: /已取消/ }).click();
  const archiveCard = drawer.locator(".archive-task-card").filter({
    hasText: String(canceled.identifier),
  });
  await expect(archiveCard).toBeVisible();

  await expect(drawer.locator(".archive-tabs")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  const completedTab = drawer.getByRole("tab", { name: /已完成/ });
  const canceledTab = drawer.getByRole("tab", { name: /已取消/ });
  await drawer.locator(".other-tasks-header").hover();
  await expect(completedTab).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(canceledTab).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(canceledTab).toHaveAttribute("aria-selected", "true");
  const selectedUnderline = await canceledTab.evaluate(
    (element) => getComputedStyle(element).boxShadow,
  );
  expect(selectedUnderline).not.toBe("none");
  await canceledTab.hover();
  await expect(canceledTab).toHaveCSS("background-color", "rgb(236, 238, 239)");
  expect(await canceledTab.evaluate((element) => getComputedStyle(element).boxShadow)).toBe(
    selectedUnderline,
  );
  await drawer.locator(".other-tasks-header").hover();
  await expect(canceledTab).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

  await completedTab.click();
  await expect(completedTab).toHaveAttribute("aria-selected", "true");
  await drawer.locator(".other-tasks-header").hover();
  await expect(completedTab).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  const completedUnderline = await completedTab.evaluate(
    (element) => getComputedStyle(element).boxShadow,
  );
  expect(completedUnderline).not.toBe("none");
  await completedTab.hover();
  await expect(completedTab).toHaveCSS("background-color", "rgb(236, 238, 239)");
  expect(await completedTab.evaluate((element) => getComputedStyle(element).boxShadow)).toBe(
    completedUnderline,
  );
  await drawer.locator(".other-tasks-header").hover();
  await expect(completedTab).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await canceledTab.click();
  await drawer.locator(".other-tasks-header").hover();
  await expect(canceledTab).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(archiveCard).toBeVisible();
  await expect(drawer).toHaveCSS("border-radius", "8px");
  await expect(drawer).toHaveCSS("box-shadow", "none");
  await expect(drawer).toHaveCSS(
    "background-color",
    await page
      .getByTestId("status-column-todo")
      .evaluate((element) => getComputedStyle(element).backgroundColor),
  );
  const activeHeader = await page
    .getByTestId("status-column-todo")
    .locator(".status-header")
    .boundingBox();
  const archiveHeader = await drawer.locator(".other-tasks-header").boundingBox();
  expect(activeHeader).not.toBeNull();
  expect(archiveHeader).not.toBeNull();
  expect(Math.abs(activeHeader!.height - archiveHeader!.height)).toBeLessThan(1);
  const archiveAppearance = await taskCardAppearance(archiveCard);
  const activeAppearance = await taskCardAppearance(activeCard);
  expect({ ...archiveAppearance, actionBorderTopWidth: null, actionMinHeight: null }).toEqual(
    activeAppearance,
  );
  expect(archiveAppearance.actionBorderTopWidth).toBe("1px");
  expect(archiveAppearance.actionMinHeight).toBe("34px");
});

test("并列其他任务缩放时逐帧保持状态列间距", async ({ page }) => {
  await openWorkspace(page);
  await page.setViewportSize({ width: 1700, height: 900 });
  await page.getByRole("button", { name: "打开其他任务" }).click();
  const drawer = page.locator(".archive-drawer");
  await expect(drawer).toHaveCSS("position", "relative");
  await expect(drawer).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");

  for (const width of [1720, 1600, 2200, 1800]) {
    const samples = page.evaluate(
      () =>
        new Promise<number[]>((resolve) => {
          const gaps: number[] = [];
          const started = performance.now();
          const sample = () => {
            const fourth = document.querySelector('[data-testid="status-column-in_review"]')!;
            const archive = document.querySelector(".archive-drawer")!;
            gaps.push(archive.getBoundingClientRect().left - fourth.getBoundingClientRect().right);
            if (performance.now() - started < 400) requestAnimationFrame(sample);
            else resolve(gaps);
          };
          requestAnimationFrame(sample);
        }),
    );
    await page.setViewportSize({ width, height: 900 });
    const gaps = await samples;
    expect(gaps.length).toBeGreaterThan(2);
    expect(Math.max(...gaps.map((gap) => Math.abs(gap - 10))), `${width}px 列间距`).toBeLessThan(1);
  }
});

test("并列其他任务关闭时先向右滑出再收起布局", async ({ page }) => {
  const project = await registerProject("ARCHCLOSE");
  await openWorkspace(page);
  await selectProject(page, project);
  await page.setViewportSize({ width: 1700, height: 900 });
  const drawer = page.locator(".archive-drawer");
  const content = page.locator(".workspace-view-content--board");
  await page.getByRole("button", { name: "打开其他任务" }).click();
  await expect(drawer).toHaveCSS("position", "relative");
  await expect(drawer).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
  const opened = await drawer.boundingBox();
  expect(opened).not.toBeNull();

  await page.getByRole("button", { name: "关闭其他任务" }).click();
  const sliding = await drawer.evaluate(
    (element) =>
      new Promise<{ x: number; width: number; visibility: string; layoutOpen: string | null }>(
        (resolve) => {
          const started = performance.now();
          const sample = () => {
            if (performance.now() - started < 80) {
              requestAnimationFrame(sample);
              return;
            }
            const box = element.getBoundingClientRect();
            resolve({
              x: box.x,
              width: box.width,
              visibility: getComputedStyle(element).visibility,
              layoutOpen: element.parentElement!.getAttribute("data-archive-open"),
            });
          };
          requestAnimationFrame(sample);
        },
      ),
  );
  expect(sliding.visibility).toBe("visible");
  expect(sliding.layoutOpen).toBe("true");
  expect(sliding.x).toBeGreaterThan(opened!.x + 1);
  expect(sliding.x).toBeLessThan(opened!.x + opened!.width + 18);
  expect(Math.abs(sliding.width - opened!.width)).toBeLessThan(1);
  await expect(drawer).toHaveCSS("visibility", "hidden");
  await expect(content).toHaveAttribute("data-archive-open", "false");

  await page.getByRole("button", { name: "打开其他任务" }).click();
  await expect(drawer).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
  await page.getByRole("button", { name: "关闭其他任务" }).click();
  await page.getByRole("button", { name: "打开其他任务" }).click();
  await expect(drawer).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
  await expect(content).toHaveAttribute("data-archive-open", "true");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "关闭其他任务" }).click();
  await expect(content).toHaveAttribute("data-archive-open", "false");
  await expect(drawer).toHaveCSS("visibility", "hidden");
});

test("并列其他任务在不同宽屏下完整滑出边界后才隐藏", async ({ page }) => {
  await openWorkspace(page);
  const drawer = page.locator(".archive-drawer");
  for (const width of [1440, 1700, 1920, 2560]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole("button", { name: "打开其他任务" }).click();
    await expect(drawer).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
    const framesPromise = drawer.evaluate(
      (element) =>
        new Promise<{ x: number; edge: number; layoutOpen: string | null }[]>((resolve) => {
          const frames: { x: number; edge: number; layoutOpen: string | null }[] = [];
          const sample = () => {
            const parent = element.parentElement!;
            if (getComputedStyle(element).visibility === "hidden") {
              resolve(frames);
              return;
            }
            frames.push({
              x: element.getBoundingClientRect().left,
              edge: parent.getBoundingClientRect().right,
              layoutOpen: parent.getAttribute("data-archive-open"),
            });
            requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        }),
    );
    await page.getByRole("button", { name: "关闭其他任务" }).click();
    const frames = await framesPromise;
    expect(frames.length).toBeGreaterThan(2);
    const last = frames.at(-1)!;
    expect(last.x, `${width}px 宽屏隐藏前必须完整移出边界`).toBeGreaterThanOrEqual(last.edge - 3);
    expect(frames.every((frame) => frame.layoutOpen === "true")).toBe(true);
    await expect(page.locator(".workspace-view-content--board")).toHaveAttribute(
      "data-archive-open",
      "false",
    );
  }
});

test("响应式列宽在五列临界值切换且覆盖层严格等高", async ({ page }) => {
  const project = await registerProject("ARCHBREAK");
  await openWorkspace(page);
  await selectProject(page, project);
  await page.setViewportSize({ width: 1600, height: 1000 });

  const workspace = page.locator(".board-workspace");
  const initialViewport = page.viewportSize();
  const initialWorkspaceWidth = await workspace.evaluate(
    (element) => element.getBoundingClientRect().width,
  );
  expect(initialViewport).not.toBeNull();
  const surroundingWidth = initialViewport!.width - initialWorkspaceWidth;
  const drawer = page.getByRole("complementary", { name: "其他任务" });

  await page.setViewportSize({ width: Math.round(surroundingWidth + 1563), height: 1000 });
  await expect.poll(() => workspace.evaluate((element) => element.clientWidth)).toBe(1563);
  await page.getByRole("button", { name: "打开其他任务" }).click();
  await expect(drawer).toHaveCSS("position", "absolute");
  await expect(drawer).not.toHaveCSS("box-shadow", "none");
  await page.getByRole("button", { name: "关闭其他任务" }).click();

  await page.setViewportSize({ width: Math.round(surroundingWidth + 1564), height: 1000 });
  await expect.poll(() => workspace.evaluate((element) => element.clientWidth)).toBe(1564);
  await page.getByRole("button", { name: "打开其他任务" }).click();
  await expect(drawer).toHaveCSS("position", "relative");
  await expect(drawer).toHaveCSS("box-shadow", "none");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const fourthColumn = document.querySelector('[data-testid="status-column-in_review"]');
        const otherColumn = document.querySelector(".archive-drawer");
        const workspaceContent = document.querySelector(".workspace-view-content--board");
        if (!fourthColumn || !otherColumn || !workspaceContent) {
          return Number.POSITIVE_INFINITY;
        }
        const fourthBox = fourthColumn.getBoundingClientRect();
        const otherBox = otherColumn.getBoundingClientRect();
        return Math.abs(otherBox.x - fourthBox.right - 10);
      }),
    )
    .toBeLessThan(1);

  for (const width of [1700, 2200]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect
      .poll(() => workspace.evaluate((element) => element.clientWidth))
      .toBe(Math.round(width - surroundingWidth));
    const widths = await page
      .locator(".status-column")
      .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().width));
    expect(widths).toHaveLength(5);
    expect(widths.every((columnWidth) => columnWidth >= 300 && columnWidth <= 400)).toBe(true);
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(2);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const columns = Array.from(document.querySelectorAll<HTMLElement>(".status-column"));
          if (columns.length !== 5) return Number.POSITIVE_INFINITY;
          const boxes = columns.map((column) => column.getBoundingClientRect());
          return Math.max(
            ...boxes.slice(1).map((box, index) => Math.abs(box.left - boxes[index]!.right - 10)),
          );
        }),
      )
      .toBeLessThan(1);
    const layout = await page.evaluate(() => {
      const columns = Array.from(document.querySelectorAll<HTMLElement>(".status-column"));
      const workspaceContent = document.querySelector<HTMLElement>(
        ".workspace-view-content--board",
      );
      if (!workspaceContent || columns.length !== 5) return null;
      const boxes = columns.map((column) => column.getBoundingClientRect());
      return {
        gaps: boxes.slice(1).map((box, index) => box.left - boxes[index]!.right),
        rightSlack: workspaceContent.getBoundingClientRect().right - boxes.at(-1)!.right,
      };
    });
    expect(layout).not.toBeNull();
    expect(layout!.gaps.every((gap) => Math.abs(gap - 10) < 1)).toBe(true);
    if (width === 2200) expect(layout!.rightSlack).toBeGreaterThan(12);
  }

  await page.getByRole("button", { name: "关闭其他任务" }).click();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect
    .poll(() => workspace.evaluate((element) => element.clientWidth))
    .toBe(Math.round(1280 - surroundingWidth));
  const kanban = page.locator(".kanban");
  const scrollLeftBefore = await kanban.evaluate((element) => element.scrollLeft);
  await page.getByRole("button", { name: "打开其他任务" }).click();
  await expect(drawer).toHaveCSS("position", "absolute");
  const active = page.getByTestId("status-column-todo");
  await expect
    .poll(async () => {
      const [activeBox, otherBox] = await Promise.all([active.boundingBox(), drawer.boundingBox()]);
      if (!activeBox || !otherBox) return Number.POSITIVE_INFINITY;
      return Math.max(
        Math.abs(otherBox.width - activeBox.width),
        Math.abs(otherBox.y - activeBox.y),
        Math.abs(otherBox.height - activeBox.height),
      );
    })
    .toBeLessThan(1);
  expect(await kanban.evaluate((element) => element.scrollLeft)).toBe(scrollLeftBefore);
  await page.getByRole("button", { name: "关闭其他任务" }).click();
  await expect(page.locator(".archive-drawer")).toHaveAttribute("aria-hidden", "true");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const activeColumn = document.querySelector('[data-testid="status-column-todo"]');
        const otherColumn = document.querySelector(".archive-drawer");
        if (!activeColumn || !otherColumn) return Number.POSITIVE_INFINITY;
        const activeBox = activeColumn.getBoundingClientRect();
        const otherBox = otherColumn.getBoundingClientRect();
        return Math.max(
          Math.abs(otherBox.width - activeBox.width),
          Math.abs(otherBox.y - activeBox.y),
          Math.abs(otherBox.height - activeBox.height),
        );
      }),
    )
    .toBeLessThan(1);
  expect(await kanban.evaluate((element) => element.scrollLeft)).toBe(scrollLeftBefore);

  await page.setViewportSize({ width: 1080, height: 900 });
  await expect
    .poll(() => workspace.evaluate((element) => element.clientWidth))
    .toBe(Math.round(1080 - surroundingWidth));
  const activeWidth = await active.evaluate((element) => element.getBoundingClientRect().width);
  expect(activeWidth).toBeGreaterThanOrEqual(300);
  const narrowOverflow = await kanban.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(narrowOverflow.scrollWidth).toBeGreaterThan(narrowOverflow.clientWidth);
  await kanban.evaluate((element) => {
    // Keep clear of the right clamp: Chrome rounds max scroll positions by a few pixels while
    // the drawer transition is running, which would not measure preservation of a real offset.
    element.scrollLeft = 4;
  });
  const narrowScrollLeft = await kanban.evaluate((element) => element.scrollLeft);
  expect(narrowScrollLeft).toBeGreaterThan(0);
  await page.getByRole("button", { name: "打开其他任务" }).click();
  await expect(drawer).toHaveCSS("position", "absolute");
  const openNarrowScrollLeft = await kanban.evaluate((element) => element.scrollLeft);
  expect(openNarrowScrollLeft).toBeGreaterThan(0);
  expect(Math.abs(openNarrowScrollLeft - narrowScrollLeft)).toBeLessThanOrEqual(2);
  await page.getByRole("button", { name: "关闭其他任务" }).click();
  await expect(page.locator(".archive-drawer")).toHaveAttribute("aria-hidden", "true");
  const closedNarrowScrollLeft = await kanban.evaluate((element) => element.scrollLeft);
  expect(closedNarrowScrollLeft).toBeGreaterThan(0);
  expect(Math.abs(closedNarrowScrollLeft - narrowScrollLeft)).toBeLessThanOrEqual(2);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => workspace.evaluate((element) => element.clientWidth))
    .toBe(Math.round(390 - surroundingWidth));
  await page.getByRole("button", { name: "打开其他任务" }).click();
  await expect(drawer).toHaveCSS("position", "absolute");
  await expect
    .poll(async () => {
      const [activeBox, otherBox] = await Promise.all([active.boundingBox(), drawer.boundingBox()]);
      if (!activeBox || !otherBox) return Number.POSITIVE_INFINITY;
      return Math.max(
        Math.abs(otherBox.width - activeBox.width),
        Math.abs(otherBox.y - activeBox.y),
        Math.abs(otherBox.height - activeBox.height),
      );
    })
    .toBeLessThan(1);
});

test("全部项目拖拽在无实时消息时立即呈现、回退并持久混排", async ({ page }, testInfo) => {
  const allProjectId = "00000000-0000-4000-8000-0000000000a1";
  await page.addInitScript(() => {
    class ReadyButSilentEventSource {
      onopen: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      readyState = 1;
      constructor(url: string) {
        void url;
        queueMicrotask(() => this.onopen?.(new Event("open")));
      }
      addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        void type;
        void listener;
      }
      close() {
        this.readyState = 2;
      }
    }
    window.EventSource = ReadyButSilentEventSource as unknown as typeof EventSource;
  });
  const projectA = await registerProject("E2EA");
  const projectB = await registerProject("E2EB");
  const marker = `排序验收-${randomUUID().slice(0, 8)}`;
  const create = (projectId: string, title: string) =>
    taskctl(
      "issue",
      "create",
      "--project",
      projectId,
      "--title",
      `${marker} ${title}`,
      "--status",
      "todo",
    ).data;
  const a1 = create(projectA.id, "A1");
  const a2 = create(projectA.id, "A2");
  const b1 = create(projectB.id, "B1");
  const b2 = create(projectB.id, "B2");
  const taskByIdentifier = new Map([a1, a2, b1, b2].map((task) => [String(task.identifier), task]));
  const ownerProjectIdByIdentifier = new Map([
    [String(a1.identifier), projectA.id],
    [String(a2.identifier), projectA.id],
    [String(b1.identifier), projectB.id],
    [String(b2.identifier), projectB.id],
  ]);
  const taskIds = new Set([a1, a2, b1, b2].map((task) => String(task.id)));
  const identifiers = [a1, a2, b1, b2].map((task) => String(task.identifier));
  const identifiersIn = async (status: "todo" | "in_progress") =>
    page
      .getByTestId(`status-column-${status}`)
      .locator(".task-card")
      .evaluateAll(
        (cards, expected) =>
          cards
            .map((card) => card.getAttribute("data-testid")?.replace("task-card-", "") ?? "")
            .filter((identifier) => expected.includes(identifier)),
        identifiers,
      );

  await openWorkspace(page);
  // Prime the owner-board cache before starting the move in ALL. A pending mutation must never
  // project its ALL optimistic state into this already cached, subsequently selected board.
  await selectProject(page, projectA);
  await expect(
    page.getByTestId("status-column-todo").getByTestId(`task-card-${String(a1.identifier)}`),
  ).toBeVisible();
  await selectProjectByName(page, "全部项目");
  await expect(page.getByTestId("status-column-todo")).toBeVisible();
  await page.getByRole("button", { name: "搜索任务", exact: true }).click();
  await page.getByRole("searchbox", { name: "搜索任务" }).fill(marker);
  await expect.poll(() => identifiersIn("todo")).toHaveLength(4);

  let releaseHeldMove: (() => void) | undefined;
  const heldMove = new Promise<void>((resolveHeldMove) => {
    releaseHeldMove = resolveHeldMove;
  });
  let heldRequestCount = 0;
  let heldCommand: Record<string, unknown> | undefined;
  await page.route("**/api/v1/tasks/*/move", async (route) => {
    heldRequestCount += 1;
    heldCommand = route.request().postDataJSON() as Record<string, unknown>;
    await heldMove;
    await route.continue();
  });

  await dragTaskCardToStatus(page, String(a1.identifier), "in_progress");
  await expect(
    page.getByTestId("status-column-in_progress").getByTestId(`task-card-${String(a1.identifier)}`),
  ).toBeVisible();
  expect(heldRequestCount).toBe(1);
  expect(heldCommand).toMatchObject({
    boardProjectId: allProjectId,
    targetStatus: "in_progress",
  });

  // dnd-kit removes its post-drag document click guard in its documented 50ms timer. Without
  // crossing that guard, the first real project-switcher activation is intentionally swallowed.
  await page.waitForTimeout(51);
  await selectProject(page, projectA);
  await expect(
    page.getByTestId("status-column-todo").getByTestId(`task-card-${String(a1.identifier)}`),
  ).toBeVisible();
  await expect(
    page.getByTestId("status-column-in_progress").getByTestId(`task-card-${String(a1.identifier)}`),
  ).toHaveCount(0);
  await selectProjectByName(page, "全部项目");
  await expect(
    page.getByTestId("status-column-in_progress").getByTestId(`task-card-${String(a1.identifier)}`),
  ).toBeVisible();

  await beginTaskCardDrag(page, String(a2.identifier));
  await page.keyboard.press("Escape");
  expect(heldRequestCount).toBe(1);
  const heldResponse = page.waitForResponse((response) =>
    response
      .request()
      .url()
      .endsWith(`/api/v1/tasks/${String(a1.id)}/move`),
  );
  releaseHeldMove?.();
  const settled = await heldResponse;
  expect(settled.status()).toBe(200);
  const settledPayload = (await settled.json()) as { meta?: { revision?: number } };
  expect(settledPayload.meta?.revision).toBeGreaterThan(0);
  await expect(page.locator(".inline-alert")).toHaveCount(0);
  await selectProject(page, projectA);
  await expect(
    page.getByTestId("status-column-in_progress").getByTestId(`task-card-${String(a1.identifier)}`),
  ).toBeVisible();
  await selectProjectByName(page, "全部项目");
  await page.unroute("**/api/v1/tasks/*/move");

  let rejectRouteSeen: (() => void) | undefined;
  const rejectedRoute = new Promise<void>((resolveRejectedRoute) => {
    rejectRouteSeen = resolveRejectedRoute;
  });
  await page.route("**/api/v1/tasks/*/move", async (route) => {
    rejectRouteSeen?.();
    await new Promise<void>((resolveRejectedMove) => {
      releaseHeldMove = resolveRejectedMove;
    });
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "VERSION_CONFLICT", message: "任务版本已变化，请重新加载" },
      }),
    });
  });
  const beforeRejectedMove = await identifiersIn("todo");
  await dragTaskCardToStatus(page, String(a2.identifier), "in_progress");
  await expect(
    page.getByTestId("status-column-in_progress").getByTestId(`task-card-${String(a2.identifier)}`),
  ).toBeVisible();
  await rejectedRoute;
  releaseHeldMove?.();
  await expect(
    page.getByRole("alert").filter({ hasText: "移动失败：任务版本已变化，已加载最新看板" }),
  ).toBeVisible();
  await expect.poll(() => identifiersIn("todo")).toEqual(beforeRejectedMove);
  await page.unroute("**/api/v1/tasks/*/move");

  const beforeSameColumnMove = await identifiersIn("todo");
  expect(beforeSameColumnMove).toHaveLength(3);
  const downSourceIdentifier = beforeSameColumnMove[0]!;
  const downTargetIdentifier = beforeSameColumnMove[1]!;
  const downSource = taskByIdentifier.get(downSourceIdentifier);
  expect(downSource).toBeDefined();
  const downTarget = page.getByTestId(`task-card-${downTargetIdentifier}`);
  await expect(downTarget).toBeVisible();
  await beginTaskCardDrag(page, downSourceIdentifier);
  const downTargetBox = await downTarget.boundingBox();
  expect(downTargetBox).not.toBeNull();
  const reorderedResponse = page.waitForResponse((response) =>
    response
      .request()
      .url()
      .endsWith(`/api/v1/tasks/${String(downSource!.id)}/move`),
  );
  await page.mouse.move(
    downTargetBox!.x + downTargetBox!.width / 2,
    downTargetBox!.y + downTargetBox!.height - 4,
    { steps: 8 },
  );
  await page.mouse.up();
  expect((await reorderedResponse).status()).toBe(200);
  const expectedTodo = [
    downTargetIdentifier,
    downSourceIdentifier,
    ...beforeSameColumnMove.slice(2),
  ];
  await expect.poll(() => identifiersIn("todo")).toEqual(expectedTodo);

  let invalidMoveRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/move")) invalidMoveRequests += 1;
  });
  await beginTaskCardDrag(page, String(a1.identifier));
  await finishDragOverStatus(page, "backlog");
  expect(invalidMoveRequests).toBe(0);
  await beginTaskCardDrag(page, String(a1.identifier));
  await page.keyboard.press("Escape");
  expect(invalidMoveRequests).toBe(0);

  await page.screenshot({
    path: testInfo.outputPath("all-project-move-persisted.png"),
    fullPage: true,
  });
  await page.reload();
  await expect(page.getByTestId("status-column-todo")).toBeVisible();
  await expect.poll(() => identifiersIn("todo")).toEqual(expectedTodo);
  const persisted = await readPublicData<{
    tasks: readonly { id: string; identifier: string; projectId: string; status: string }[];
  }>(page, `/api/v1/projects/${allProjectId}/board`);
  expect(
    persisted.tasks.filter((task) => taskIds.has(task.id)).map((task) => task.identifier),
  ).toEqual([...expectedTodo, String(a1.identifier)]);
  expect(persisted.tasks.find((task) => task.id === String(b1.id))?.projectId).toBe(projectB.id);

  await selectProject(page, projectA);
  await expect
    .poll(() => identifiersIn("todo"))
    .toEqual(
      expectedTodo.filter(
        (identifier) => ownerProjectIdByIdentifier.get(identifier) === projectA.id,
      ),
    );
  await selectProject(page, projectB);
  await expect
    .poll(() => identifiersIn("todo"))
    .toEqual(
      expectedTodo.filter(
        (identifier) => ownerProjectIdByIdentifier.get(identifier) === projectB.id,
      ),
    );
  await selectProjectByName(page, "全部项目");
  await expect.poll(() => identifiersIn("todo")).toEqual(expectedTodo);
});

test("标签悬浮副本越出列表不撑滚动范围并按纵向首尾排序", async ({ page }, testInfo) => {
  const project = await registerProject("E2ETAG");
  await openWorkspace(page);
  await selectProject(page, project);
  await page.getByRole("button", { name: "标签管理" }).click();
  const manager = page.getByRole("dialog", { name: "标签管理" });
  const unique = randomUUID().slice(0, 6);
  const shortNames = [`短甲-${unique}`, `短乙-${unique}`, `短丙-${unique}`];
  for (const name of shortNames) {
    await manager.getByRole("textbox", { name: "新标签名称" }).fill(name);
    await manager.getByRole("button", { name: "新增", exact: true }).click();
    await expect(manager.getByRole("button", { name, exact: true })).toBeVisible();
  }
  const list = manager.getByRole("list", { name: "全局标签排序" });
  const shortMetrics = await list.evaluate((element) => ({
    clientHeight: element.clientHeight,
    clientWidth: element.clientWidth,
    scrollHeight: element.scrollHeight,
    scrollWidth: element.scrollWidth,
  }));

  let reorderRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "PUT" && request.url().endsWith("/api/v1/labels/order")) {
      reorderRequests += 1;
    }
  });
  const firstHandle = manager.getByRole("button", { name: `拖动标签 ${shortNames[0]}` });
  await firstHandle.scrollIntoViewIfNeeded();
  const [firstBox, listBox] = await Promise.all([firstHandle.boundingBox(), list.boundingBox()]);
  expect(firstBox).not.toBeNull();
  expect(listBox).not.toBeNull();
  await page.mouse.move(firstBox!.x + 6, firstBox!.y + 6);
  await page.mouse.down();
  await page.mouse.move(listBox!.x + listBox!.width + 80, listBox!.y + listBox!.height + 70, {
    steps: 12,
  });
  const overlay = page.locator(".tag-manager-drag-overlay");
  await expect(overlay).toBeVisible();
  expect(
    await overlay.evaluate((node) => node.closest("dialog")?.getAttribute("aria-labelledby")),
  ).toBe("tag-manager-title");
  const draggingMetrics = await list.evaluate((element) => ({
    scrollHeight: element.scrollHeight,
    scrollWidth: element.scrollWidth,
  }));
  expect(draggingMetrics).toEqual({
    scrollHeight: shortMetrics.scrollHeight,
    scrollWidth: shortMetrics.scrollWidth,
  });
  const globalTailResponse = page.waitForResponse((response) =>
    response.request().url().endsWith("/api/v1/labels/order"),
  );
  await page.mouse.up();
  expect((await globalTailResponse).status()).toBe(200);
  await expect
    .poll(async () =>
      (await manager.locator(".tag-manager-name").allTextContents()).filter((name) =>
        shortNames.includes(name),
      ),
    )
    .toEqual([shortNames[1]!, shortNames[2]!, shortNames[0]!]);

  const longNames = Array.from({ length: 15 }, (_, index) => `长${index}-${unique}`);
  for (const name of longNames) {
    await manager.getByRole("textbox", { name: "新标签名称" }).fill(name);
    await manager.getByRole("button", { name: "新增", exact: true }).click();
    await expect(manager.getByRole("button", { name, exact: true })).toBeVisible();
  }
  const longMetrics = await list.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(longMetrics.scrollHeight).toBeGreaterThan(longMetrics.clientHeight);
  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const lastHandle = manager.getByRole("button", { name: `拖动标签 ${longNames.at(-1)!}` });
  const [lastBox, longListBox] = await Promise.all([lastHandle.boundingBox(), list.boundingBox()]);
  expect(lastBox).not.toBeNull();
  expect(longListBox).not.toBeNull();
  await page.mouse.move(lastBox!.x + 6, lastBox!.y + 6);
  await page.mouse.down();
  await page.mouse.move(10, 10, { steps: 12 });
  await expect(overlay).toBeVisible();
  const longOverlayBox = await overlay.boundingBox();
  expect(longOverlayBox).not.toBeNull();
  expect(longOverlayBox!.y + longOverlayBox!.height / 2).toBeLessThan(longListBox!.y);
  await page.screenshot({ path: testInfo.outputPath("tag-overlay-dragging.png"), fullPage: true });
  const longDraggingMetrics = await list.evaluate((element) => ({
    scrollHeight: element.scrollHeight,
    scrollWidth: element.scrollWidth,
  }));
  expect(longDraggingMetrics.scrollHeight).toBe(longMetrics.scrollHeight);
  expect(longDraggingMetrics.scrollWidth).toBeLessThanOrEqual(longListBox!.width + 1);
  const headResponse = page.waitForResponse((response) =>
    response.request().url().endsWith("/api/v1/labels/order"),
  );
  await page.mouse.up();
  expect((await headResponse).status()).toBe(200);
  await expect(manager.locator(".tag-manager-name").first()).toHaveText(longNames.at(-1)!);

  await list.evaluate((element) => {
    element.scrollTop = 0;
  });
  const headHandle = manager.getByRole("button", { name: `拖动标签 ${longNames.at(-1)!}` });
  await headHandle.scrollIntoViewIfNeeded();
  const [headBox, refreshedListBox, viewportHeight] = await Promise.all([
    headHandle.boundingBox(),
    list.boundingBox(),
    page.evaluate(() => window.innerHeight),
  ]);
  expect(headBox).not.toBeNull();
  expect(refreshedListBox).not.toBeNull();
  const belowListY = Math.min(
    refreshedListBox!.y + refreshedListBox!.height + 40,
    viewportHeight - 10,
  );
  expect(belowListY).toBeGreaterThan(refreshedListBox!.y + refreshedListBox!.height);
  await page.mouse.move(headBox!.x + 6, headBox!.y + 6);
  await page.mouse.down();
  await page.mouse.move(refreshedListBox!.x + refreshedListBox!.width / 2, belowListY, {
    steps: 12,
  });
  await expect(overlay).toBeVisible();
  const tailResponse = page.waitForResponse((response) =>
    response.request().url().endsWith("/api/v1/labels/order"),
  );
  await page.mouse.up();
  expect((await tailResponse).status()).toBe(200);
  await expect(manager.locator(".tag-manager-name").last()).toHaveText(longNames.at(-1)!);

  const requestCountBeforeEscape = reorderRequests;
  const escapeHandle = manager.getByRole("button", { name: `拖动标签 ${shortNames[1]}` });
  await escapeHandle.scrollIntoViewIfNeeded();
  const escapeBox = await escapeHandle.boundingBox();
  expect(escapeBox).not.toBeNull();
  await page.mouse.move(escapeBox!.x + 6, escapeBox!.y + 6);
  await page.mouse.down();
  await page.mouse.move(escapeBox!.x + 24, escapeBox!.y + 6, { steps: 4 });
  await expect(overlay).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(overlay).toHaveCount(0);
  expect(reorderRequests).toBe(requestCountBeforeEscape);
  await page.screenshot({ path: testInfo.outputPath("tag-overlay-long-list.png"), fullPage: true });
});

test("四个宽度下活动列与第五列保持十像素间距", async ({ page }, testInfo) => {
  const project = await registerProject("E2ELAYOUT");
  await openWorkspace(page);
  await selectProject(page, project);
  const drawer = page.getByRole("complementary", { name: "其他任务" });
  for (const width of [1563, 1564, 1800, 2200]) {
    await page.setViewportSize({ width, height: 900 });
    const activeBoxes = await page
      .locator(".status-column:not(.status-column--archive)")
      .evaluateAll((columns) => columns.map((column) => column.getBoundingClientRect().toJSON()));
    expect(activeBoxes).toHaveLength(4);
    expect(activeBoxes.every((box) => box.width >= 300 && box.width <= 400)).toBe(true);
    expect(
      activeBoxes
        .slice(1)
        .every((box, index) => Math.abs(box.x - activeBoxes[index]!.right - 10) < 1),
    ).toBe(true);
    await page.getByRole("button", { name: "打开其他任务" }).click();
    if (width < 1564) {
      await expect(drawer).toHaveCSS("position", "absolute");
      const [activeBox, drawerBox] = await Promise.all([
        page.getByTestId("status-column-todo").boundingBox(),
        drawer.boundingBox(),
      ]);
      expect(activeBox).not.toBeNull();
      expect(drawerBox).not.toBeNull();
      expect(Math.abs(drawerBox!.width - activeBox!.width)).toBeLessThan(1);
      expect(Math.abs(drawerBox!.height - activeBox!.height)).toBeLessThan(1);
    } else {
      await expect(drawer).toHaveCSS("position", "relative");
      await expect
        .poll(async () => {
          const [fourthBox, drawerBox] = await Promise.all([
            page.getByTestId("status-column-in_review").boundingBox(),
            drawer.boundingBox(),
          ]);
          if (!fourthBox || !drawerBox) return Number.POSITIVE_INFINITY;
          return Math.abs(drawerBox.x - fourthBox.x - fourthBox.width - 10);
        })
        .toBeLessThan(1);
      const drawerBox = await drawer.boundingBox();
      expect(drawerBox).not.toBeNull();
      expect(drawerBox!.width).toBeGreaterThanOrEqual(300);
      expect(drawerBox!.width).toBeLessThanOrEqual(400);
      if (width >= 2200) {
        const mainBox = await page.locator(".workspace-view-content--board").boundingBox();
        expect(mainBox).not.toBeNull();
        expect(mainBox!.x + mainBox!.width - drawerBox!.x - drawerBox!.width).toBeGreaterThan(12);
      }
    }
    await page.getByRole("button", { name: "关闭其他任务" }).click();
  }
  await page.screenshot({ path: testInfo.outputPath("fixed-gap-1920.png"), fullPage: true });
});

test("跨列拖拽显示悬浮反馈且仅在合法落点发起移动", async ({ page }) => {
  const project = await registerProject("DRAG");
  await openWorkspace(page);
  await selectProject(page, project);
  const created = taskctl(
    "issue",
    "create",
    "--project",
    project.id,
    "--title",
    "整卡拖拽任务",
    "--status",
    "backlog",
  ).data;
  const identifier = String(created.identifier);
  const card = page.getByTestId(`task-card-${identifier}`);
  await expect(card).toBeVisible();
  await expect(page.getByRole("button", { name: `拖动 ${identifier}` })).toHaveCount(0);
  await expect(card).toHaveAttribute("role", "group");
  await expect(card).toHaveCSS("cursor", "grab");
  await expect(card.getByRole("button", { name: `将 ${identifier} 移至下一状态` })).toHaveCount(0);
  await expect(card.locator(".task-card-actions")).toHaveCount(0);

  let moveRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/move")) {
      moveRequests += 1;
    }
  });

  const sourceCardBox = await card.boundingBox();
  const sourceColumnBox = await page.getByTestId("status-column-backlog").boundingBox();
  expect(sourceCardBox).not.toBeNull();
  expect(sourceColumnBox).not.toBeNull();

  await beginTaskCardDrag(page, identifier);
  const overlay = page.locator(".task-drag-overlay");
  await expect(overlay).toBeVisible();
  await expect(overlay).toHaveAttribute("aria-hidden", "true");
  await expect(overlay.getByRole("button")).toHaveCount(0);
  const overlayZ = await overlay.evaluate((node) =>
    Number.parseInt(getComputedStyle(node).zIndex, 10),
  );
  const columnZ = await page.getByTestId("status-column-in_progress").evaluate((node) => {
    const zIndex = getComputedStyle(node).zIndex;
    return zIndex === "auto" ? 0 : Number.parseInt(zIndex, 10);
  });
  expect(overlayZ).toBeGreaterThan(columnZ);
  const overlayBox = await overlay.boundingBox();
  expect(overlayBox).not.toBeNull();
  expect(Math.abs(overlayBox!.width - sourceCardBox!.width)).toBeLessThan(1);
  expect(await overlay.evaluate((node) => node.closest(".status-column"))).toBeNull();

  const invalidColumn = page.getByTestId("status-column-in_progress");
  const invalidBox = await invalidColumn.boundingBox();
  expect(invalidBox).not.toBeNull();
  await page.mouse.move(invalidBox!.x + invalidBox!.width / 2, invalidBox!.y + 120, { steps: 12 });
  await expect(invalidColumn).toHaveClass(/status-column--over-invalid/);
  const movedOverlayBox = await overlay.boundingBox();
  expect(movedOverlayBox).not.toBeNull();
  expect(movedOverlayBox!.x).toBeGreaterThan(sourceColumnBox!.x + sourceColumnBox!.width);
  await page.mouse.up();
  await expect(
    page.getByTestId("status-column-backlog").getByTestId(`task-card-${identifier}`),
  ).toBeVisible();
  expect(moveRequests).toBe(0);

  await beginTaskCardDrag(page, identifier);
  const adjacentColumn = page.getByTestId("status-column-todo");
  const adjacentBox = await adjacentColumn.boundingBox();
  expect(adjacentBox).not.toBeNull();
  await page.mouse.move(adjacentBox!.x + adjacentBox!.width / 2, adjacentBox!.y + 120, {
    steps: 12,
  });
  await expect(adjacentColumn).toHaveClass(/status-column--over/);
  await page.mouse.up();
  await expect(adjacentColumn.getByTestId(`task-card-${identifier}`)).toBeVisible();
  expect(moveRequests).toBe(1);
  await expect(page.locator(".inline-alert")).toHaveCount(0);

  const sibling = taskctl(
    "issue",
    "create",
    "--project",
    project.id,
    "--title",
    "同列排序目标",
    "--status",
    "todo",
  ).data;
  const siblingIdentifier = String(sibling.identifier);
  await expect(page.getByTestId(`task-card-${siblingIdentifier}`)).toBeVisible();
  const todoIdentifiers = await adjacentColumn
    .locator(".task-card")
    .evaluateAll((cards) =>
      cards.map((node) => node.getAttribute("data-testid")?.replace("task-card-", "") ?? ""),
    );
  const draggedIdentifier = todoIdentifiers.at(-1)!;
  const beforeIdentifier = todoIdentifiers[0]!;
  await beginTaskCardDrag(page, draggedIdentifier);
  const beforeBox = await page.getByTestId(`task-card-${beforeIdentifier}`).boundingBox();
  expect(beforeBox).not.toBeNull();
  await page.mouse.move(beforeBox!.x + beforeBox!.width / 2, beforeBox!.y + 20, { steps: 12 });
  await page.mouse.up();
  await expect
    .poll(() => adjacentColumn.locator(".task-card").first().getAttribute("data-testid"))
    .toBe(`task-card-${draggedIdentifier}`);
  expect(moveRequests).toBe(2);

  const requestsBeforeCancel = moveRequests;
  await beginTaskCardDrag(page, identifier);
  await page.keyboard.press("Escape");
  await expect(overlay).toHaveCount(0);
  expect(moveRequests).toBe(requestsBeforeCancel);

  await beginTaskCardDrag(page, identifier);
  await page.mouse.move(2, 2, { steps: 12 });
  await page.mouse.up();
  expect(moveRequests).toBe(requestsBeforeCancel);

  const covered = taskctl(
    "issue",
    "create",
    "--project",
    project.id,
    "--title",
    "抽屉遮挡相邻列",
    "--status",
    "in_progress",
  ).data;
  const coveredIdentifier = String(covered.identifier);
  await expect(page.getByTestId(`task-card-${coveredIdentifier}`)).toBeVisible();
  await page.getByRole("button", { name: "打开其他任务" }).click();
  const drawer = page.getByRole("complementary", { name: "其他任务" });
  await expect(drawer).toBeVisible();
  await expect(drawer).toHaveCSS("position", "absolute");
  await page.locator(".kanban").evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const drawerNode = document.querySelector<HTMLElement>(".archive-drawer--open");
        const reviewNode = document.querySelector<HTMLElement>(
          '[data-testid="status-column-in_review"]',
        );
        if (!drawerNode || !reviewNode) return 0;
        const drawerBox = drawerNode.getBoundingClientRect();
        const reviewBox = reviewNode.getBoundingClientRect();
        return Math.max(
          0,
          Math.min(drawerBox.right, reviewBox.right) - Math.max(drawerBox.left, reviewBox.left),
        );
      }),
    )
    .toBeGreaterThan(40);
  const overlap = await page.evaluate(() => {
    const drawerNode = document.querySelector<HTMLElement>(".archive-drawer--open");
    const reviewNode = document.querySelector<HTMLElement>(
      '[data-testid="status-column-in_review"]',
    );
    if (!drawerNode || !reviewNode) return null;
    const drawerBox = drawerNode.getBoundingClientRect();
    const reviewBox = reviewNode.getBoundingClientRect();
    const left = Math.max(drawerBox.left, reviewBox.left);
    const right = Math.min(drawerBox.right, reviewBox.right);
    const top = Math.max(drawerBox.top, reviewBox.top);
    const bottom = Math.min(drawerBox.bottom, reviewBox.bottom);
    return right > left && bottom > top ? { x: (left + right) / 2, y: top + 120 } : null;
  });
  expect(overlap).not.toBeNull();
  let coveredMoveRequests = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith(`/api/v1/tasks/${String(covered.id)}/move`)
    ) {
      coveredMoveRequests += 1;
    }
  });
  await beginTaskCardDrag(page, coveredIdentifier);
  await page.mouse.move(overlap!.x, overlap!.y, { steps: 12 });
  await page.mouse.up();
  await expect(
    page.getByTestId("status-column-in_progress").getByTestId(`task-card-${coveredIdentifier}`),
  ).toBeVisible();
  expect(coveredMoveRequests).toBe(0);
});

test("键盘拖拽可以把整张卡片移动到相邻状态", async ({ page }) => {
  const project = await registerProject("KEYDRAG");
  await openWorkspace(page);
  await selectProject(page, project);
  const created = taskctl(
    "issue",
    "create",
    "--project",
    project.id,
    "--title",
    "键盘拖拽任务",
    "--status",
    "todo",
  ).data;
  const identifier = String(created.identifier);
  const card = page.getByTestId(`task-card-${identifier}`);
  const targetColumn = page.getByTestId("status-column-in_progress");

  await expect(card).toBeVisible();
  await expect(targetColumn).toBeVisible();
  await card.focus();
  await expect(card).toBeFocused();
  await page.keyboard.press("Space");
  await expect(card).toHaveClass(/task-card--dragging/);
  await expect(card).toBeFocused();
  // dnd-kit defers KeyboardSensor's keydown listener with setTimeout(0); flush that timer turn.
  await page.evaluate(() => new Promise<void>((resolve) => window.setTimeout(resolve, 0)));
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() =>
      page
        .locator(".status-column--over, .status-column--over-invalid")
        .evaluateAll((columns) => columns.map((column) => column.getAttribute("data-testid"))),
    )
    .toEqual(["status-column-in_progress"]);
  await page.keyboard.press("Space");

  await expect(
    page.getByTestId("status-column-in_progress").getByTestId(`task-card-${identifier}`),
  ).toBeVisible();
});

test("双客户端完成实时创建、冲突恢复、拖动迁移与断线补偿", async ({ browser }) => {
  const project = await registerProject("SYNC");
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  const first = await firstContext.newPage();
  const second = await secondContext.newPage();

  try {
    await Promise.all([openWorkspace(first), openWorkspace(second)]);
    await Promise.all([selectProject(first, project), selectProject(second, project)]);

    const created = taskctl(
      "issue",
      "create",
      "--project",
      project.id,
      "--title",
      "双客户端实时任务",
      "--status",
      "todo",
    ).data;
    const identifier = String(created.identifier);
    const cardTestId = `task-card-${identifier}`;
    await expect(first.getByTestId(cardTestId)).toBeVisible();
    await expect(second.getByTestId(cardTestId)).toBeVisible();

    await second.getByRole("tab", { name: "仪表盘" }).click();
    const unreadMetric = second.locator(".metric-card").filter({ hasText: "阻塞或未读" });
    await expect(unreadMetric.locator("strong")).toHaveText("1");
    await first.getByTestId(cardTestId).getByRole("button").first().click();
    await expect(first.getByRole("region", { name: "任务详情", exact: true })).toBeVisible();
    await first.getByRole("button", { name: "返回看板" }).click();
    await expect(unreadMetric.locator("strong")).toHaveText("0");
    await first.getByTestId(cardTestId).getByRole("button").first().click();
    await second.getByRole("tab", { name: "看板" }).click();

    await second.getByTestId(cardTestId).getByRole("button").first().click();
    await Promise.all([
      expect(first.getByRole("region", { name: "任务详情", exact: true })).toBeVisible(),
      expect(second.getByRole("region", { name: "任务详情", exact: true })).toBeVisible(),
    ]);

    await secondContext.setOffline(true);
    await expect(second.getByText(/连接已断开/)).toBeVisible();
    await second.route("**/api/v1/events?**", (route) => route.abort());

    await first.getByRole("button", { name: "编辑描述" }).click();
    await first.getByLabel("描述", { exact: true }).fill("客户端 A 已更新");
    await first.getByLabel("描述", { exact: true }).blur();
    await expect(
      first
        .getByRole("region", { name: "任务详情", exact: true })
        .getByText("已自动保存", { exact: true }),
    ).toBeVisible();

    await second.route("**/api/v1/tasks/**", (route) => {
      if (route.request().method() === "GET") {
        void route.abort();
      } else {
        void route.continue();
      }
    });
    await secondContext.setOffline(false);
    await second.getByLabel("标题", { exact: true }).fill("客户端 B 的过期修改");
    await second.getByLabel("标题", { exact: true }).blur();
    await expect(second.getByRole("alert")).toContainText("其他人更新");
    await second.unroute("**/api/v1/tasks/**");
    await second.getByRole("button", { name: "放弃草稿并加载最新版本" }).click();
    await expect(second.locator(".detail-description-read")).toContainText("客户端 A 已更新");
    await second.getByLabel("标题", { exact: true }).fill("冲突恢复后的任务");
    await second.getByLabel("标题", { exact: true }).blur();
    await expect(
      second
        .getByRole("region", { name: "任务详情", exact: true })
        .getByText("已自动保存", { exact: true }),
    ).toBeVisible();

    await first.getByRole("button", { name: "返回看板", exact: true }).click();
    const targetColumn = first.getByTestId("status-column-in_progress");
    await expect(first.getByRole("button", { name: `拖动 ${identifier}` })).toHaveCount(0);
    await dragTaskCardToStatus(first, identifier, "in_progress");
    await expect(targetColumn.getByTestId(cardTestId)).toBeVisible();

    await second.getByRole("button", { name: "返回看板", exact: true }).click();
    await secondContext.setOffline(true);
    const compensatedIdentifier = await quickCreate(first, "断线期间创建的任务");
    await expect(second.getByTestId(`task-card-${compensatedIdentifier}`)).toHaveCount(0);
    await second.unroute("**/api/v1/events?**");
    await secondContext.setOffline(false);
    await expect(second.getByTestId(`task-card-${compensatedIdentifier}`)).toBeVisible();
  } finally {
    await Promise.all([firstContext.close(), secondContext.close()]);
  }
});

test("移动端使用项目选择器并以全屏详情编辑任务", async ({ browser }) => {
  const project = await registerProject("MOB");
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("401 (Unauthorized)")) {
      browserErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  try {
    await openWorkspace(page);
    await selectProject(page, project);
    await expectProjectMenuItemToReceivePointer(page, "临时项目");
    await page.getByRole("button", { name: /切换项目，当前/ }).click();
    const mobileLabel = `移动端-${randomUUID().slice(0, 6)}`;
    await ensureGlobalLabel(page, mobileLabel);
    await expect(page.locator(".project-key")).toHaveText(project.projectKey);
    const createDialog = await openTaskCreateDialog(page);
    const createDialogBox = await createDialog.locator(".task-create-dialog").boundingBox();
    expect(createDialogBox).not.toBeNull();
    expect(createDialogBox?.x ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(1);
    expect(createDialogBox?.y ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(1);
    expect(createDialogBox?.width ?? 0).toBeGreaterThanOrEqual(389);
    expect(createDialogBox?.height ?? 0).toBeGreaterThanOrEqual(843);
    await createDialog.getByRole("button", { name: "关闭新增任务" }).click();
    const identifier = await quickCreate(page, "移动端验收任务");
    const relatedIdentifier = await quickCreate(page, "移动端关联任务");
    await page.getByTestId(`task-card-${identifier}`).getByRole("button").first().click();
    const detail = page.getByRole("region", { name: "任务详情", exact: true });
    await expect
      .poll(async () => (await detail.boundingBox())?.x ?? Number.POSITIVE_INFINITY)
      .toBeLessThanOrEqual(1);
    const detailBox = await detail.boundingBox();
    expect(detailBox).not.toBeNull();
    expect(detailBox!.x).toBeLessThanOrEqual(1);
    expect(detailBox!.width).toBeGreaterThanOrEqual(389);
    for (const width of [700, 390]) {
      await page.setViewportSize({ width, height: 844 });
      for (const control of [
        detail.getByRole("button", { name: "状态", exact: true }),
        detail.getByRole("button", { name: "优先级", exact: true }),
        detail.getByRole("button", { name: /^标签：/ }),
      ]) {
        await expect(control).toHaveCSS("font-size", "12px");
        await expect(control).toHaveCSS("min-height", "44px");
      }
    }
    await detail.getByRole("button", { name: "状态", exact: true }).click();
    await expect(detail.getByRole("option", { name: "待处理", exact: true })).toHaveCSS(
      "font-size",
      "12px",
    );
    await detail.getByRole("option", { name: "待处理", exact: true }).press("Escape");
    await detail.getByRole("button", { name: "优先级", exact: true }).click();
    await expect(detail.getByRole("option", { name: "高", exact: true })).toHaveCSS(
      "font-size",
      "12px",
    );
    await detail.getByRole("option", { name: "高", exact: true }).click();
    await detail.getByRole("button", { name: /^标签：/ }).click();
    await detail
      .getByRole("group", { name: "选择标签" })
      .getByRole("checkbox", { name: mobileLabel })
      .check();
    await detail.locator(".task-detail-topbar").click();
    await detail.locator(".task-detail-topbar").click();
    await expect(detail.getByText("已自动保存", { exact: true })).toBeVisible();
    await detail.getByLabel("新评论").fill("移动端工作区评论");
    await detail.getByRole("button", { name: "发表评论" }).click();
    await expect(detail.getByText("移动端工作区评论")).toBeVisible();
    await detail.getByRole("button", { name: "编辑描述" }).click();
    await detail.getByLabel("添加描述附件").setInputFiles({
      name: "mobile.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("scope,result\nmobile,passed\n", "utf8"),
    });
    await expect(detail.getByRole("link", { name: /mobile\.csv/ })).toBeVisible();
    await detail.getByRole("button", { name: "添加关联任务", exact: true }).click();
    await detail.getByRole("searchbox", { name: "搜索任务" }).fill("移动端关联任务");
    await detail
      .getByRole("menuitem", { name: `${relatedIdentifier} 移动端关联任务`, exact: true })
      .click();
    await expect(detail.getByText(relatedIdentifier, { exact: true })).toBeVisible();
    await detail.getByRole("button", { name: "返回看板" }).click();
    await expect(page.getByRole("tab", { name: "项目文档" })).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "甘特图" })).toHaveCount(0);
    for (const view of ["仪表盘", "列表", "看板"]) {
      await page.getByRole("tab", { name: view }).click();
      await expect(page.getByRole("tab", { name: view })).toHaveAttribute("aria-selected", "true");
    }
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    expect(browserErrors).toEqual([]);
  } finally {
    await context.close();
  }
});

test("任务详情完成 Codex 启动、一次性审批、继续与取消闭环", async ({ page }, testInfo) => {
  const project = await registerExecutableProject("CODEX");
  await openWorkspace(page);
  await selectProject(page, project);
  const identifier = await quickCreate(page, "Codex 执行闭环");
  await page.getByTestId(`task-card-${identifier}`).getByRole("button").first().click();
  const detail = page.getByRole("region", { name: "任务详情", exact: true });
  await expect(detail.getByRole("heading", { name: "Codex 执行" })).toBeVisible();
  await expect(detail.getByRole("button", { name: "启动 Codex" })).toBeEnabled();

  const startBox = await detail.getByRole("button", { name: "启动 Codex" }).boundingBox();
  const cancelBox = await detail.getByRole("button", { name: "取消执行" }).boundingBox();
  expect(startBox!.y).toBe(cancelBox!.y);
  await expect(detail.locator(".detail-copy-actions")).toHaveCount(0);
  await expect(detail.getByRole("button", { name: `复制任务 ID ${identifier}` })).toBeVisible();
  const conversationBefore = detail.getByRole("region", { name: "对话", exact: true });
  await conversationBefore.getByRole("textbox").fill("请检查新增评论的执行锁定");
  await conversationBefore.getByRole("button", { name: "发表评论" }).click();
  await expect(
    conversationBefore.getByText("请检查新增评论的执行锁定", { exact: true }),
  ).toBeVisible();
  await detail.getByRole("button", { name: "启动 Codex" }).click();
  await expect(detail.getByText("等待审批", { exact: true })).toBeVisible();
  await expect(detail.getByText("命令执行审批")).toBeVisible();
  await expect(detail.getByRole("button", { name: "编辑描述" })).toHaveCount(0);
  await expect(detail.locator(".detail-description-hint")).toBeVisible();
  await expect(detail.getByLabel("添加描述附件")).toHaveCount(0);
  await expect(detail.locator(".detail-description-zone .attachment-input-help")).toHaveCount(0);
  await expect(detail.getByText("npm test", { exact: true })).toBeVisible();
  await detail.getByRole("button", { name: "允许一次" }).click();
  await expect(detail.locator(".job-status")).toHaveText("已完成");
  await expect(detail.getByRole("button", { name: "继续 Codex" })).toBeDisabled();
  await expect(detail.locator(".execution-timeline")).toHaveCount(0);
  await expect(detail.getByRole("button", { name: "编辑描述" })).toHaveCount(0);
  await expect(detail.locator(".execution-availability-hint")).toHaveCSS("font-size", "12px");
  const consumed = detail.locator(".comment", { hasText: "请检查新增评论的执行锁定" });
  await expect(consumed.getByText("已执行", { exact: true })).toBeVisible();
  await expect(consumed.getByRole("button", { name: "评论操作" })).toHaveCount(0);
  await expect(detail.getByRole("link", { name: "打开 Codex 对话" })).toHaveAttribute(
    "href",
    /^codex:\/\/threads\/.+/,
  );

  const conversation = detail.getByRole("region", { name: "对话", exact: true });
  await expect(
    conversation.getByText("Fake Codex 已完成浏览器验收执行", { exact: true }),
  ).toHaveCount(1);
  await expect(
    conversation.locator(".comment > header strong", { hasText: "Codex" }),
  ).toBeVisible();
  await expect(
    conversation
      .locator(".comment", { hasText: "Fake Codex 已完成浏览器验收执行" })
      .getByRole("button"),
  ).toHaveCount(0);
  await page.reload();
  await page.getByTestId(`task-card-${identifier}`).getByRole("button").first().click();
  await expect(
    page
      .getByRole("region", { name: "对话", exact: true })
      .getByText("Fake Codex 已完成浏览器验收执行", { exact: true }),
  ).toHaveCount(1);

  await conversation.getByRole("textbox").fill("请根据这条新评论继续执行");
  await conversation.getByRole("button", { name: "发表评论" }).click();
  await expect(detail.getByRole("button", { name: "状态", exact: true })).toContainText("待处理");
  await detail.getByRole("button", { name: "继续 Codex" }).click();
  await expect(detail.getByText("等待审批", { exact: true })).toBeVisible();
  await expect(
    conversation
      .locator(".comment", { hasText: "请根据这条新评论继续执行" })
      .getByText("已执行", { exact: true }),
  ).toHaveCount(0);
  const cancelResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/api/v1/jobs/") &&
      response.url().endsWith("/cancel"),
  );

  await expect(conversation.getByText("Fake Codex 执行前进度说明", { exact: true })).toHaveCount(0);
  await detail.getByRole("button", { name: "取消执行" }).click();
  expect((await cancelResponse).status()).toBe(202);
  await expect(detail.locator(".job-status")).toHaveText("取消中");
  await page.waitForTimeout(100);
  await expect(detail.getByRole("button", { name: "取消中…", exact: true })).toBeDisabled();
  await expect(detail.getByRole("button", { name: "继续 Codex" })).toBeDisabled();
  await expect(detail.locator(".job-status")).toHaveText("已取消");
  await expect(detail.getByText("命令执行审批")).toHaveCount(0);
  const pending = conversation.locator(".comment", { hasText: "请根据这条新评论继续执行" });
  await pending.hover();
  await pending.getByRole("button", { name: "评论操作", exact: true }).click();
  await pending.getByRole("menuitem", { name: "编辑评论" }).click();
  await pending.getByLabel("编辑评论").fill("取消后修订的指令");
  await conversation.getByRole("button", { name: "保存", exact: true }).click();
  await conversation.getByRole("textbox", { name: "新评论", exact: true }).fill("取消后增加的评论");
  await conversation.getByRole("button", { name: "发表评论" }).click();
  await detail.getByRole("button", { name: "继续 Codex" }).click();
  await expect(detail.getByText("等待审批", { exact: true })).toBeVisible();
  await expect(detail.getByText("该工作上下文已有活动执行", { exact: true })).toHaveCount(0);
  writeFileSync(join(project.rootPath, "feature-result.txt"), "finished\n");
  await detail.getByRole("button", { name: "允许一次" }).click();
  await expect(detail.locator(".job-status")).toHaveText("已完成");
  for (const body of ["取消后修订的指令", "取消后增加的评论"]) {
    await expect(
      conversation.locator(".comment", { hasText: body }).getByText("已执行", { exact: true }),
    ).toBeVisible();
  }
  await expect(detail.getByRole("button", { name: "继续 Codex" })).toBeDisabled();
  await conversation.getByRole("textbox", { name: "新评论", exact: true }).fill("未保存草稿");
  await expect(detail.getByRole("button", { name: "任务完成", exact: true })).toBeDisabled();
  await conversation.getByRole("textbox", { name: "新评论", exact: true }).fill("");
  // Completion checks Git; committing belongs to the external development workflow.
  execFileSync("git", ["-C", project.rootPath, "add", "feature-result.txt"]);
  execFileSync("git", ["-C", project.rootPath, "commit", "-m", "complete fixture implementation"]);
  await detail.getByRole("button", { name: "任务完成", exact: true }).click();
  await expect(detail).not.toBeVisible();
  await page.getByTestId(`task-card-${identifier}`).click();
  await expect(detail.getByRole("button", { name: "状态", exact: true })).toContainText("已完成");
  await expect(detail.locator(".task-completion-result")).toContainText("任务收尾已完成");
  expect(
    execFileSync("git", ["-C", project.rootPath, "status", "--porcelain"], {
      encoding: "utf8",
    }).trim(),
  ).toBe("");
  expect(
    execFileSync("git", ["-C", project.rootPath, "show", "HEAD:feature-result.txt"], {
      encoding: "utf8",
    }),
  ).toBe("finished\n");
  await page.screenshot({ path: testInfo.outputPath("codex-conversation.png"), fullPage: true });
});

test("删除失败后恢复任务，操作提示独立显示并自动关闭", async ({ page }, testInfo) => {
  const project = await registerProject("RESTORE");
  await openWorkspace(page);
  await selectProject(page, project);
  const identifier = await quickCreate(page, "[archive-conflict] 恢复删除失败任务");
  const task = (
    await readPublicData<{ tasks: (TaskFixture & { version: number })[] }>(
      page,
      `/api/v1/projects/${project.id}/board`,
    )
  ).tasks.find((item) => item.identifier === identifier)!;
  taskctl("issue", "move", task.id, "--version", String(task.version), "--status", "canceled");
  await page.getByRole("button", { name: "打开其他任务", exact: true }).click();
  const drawer = page.getByRole("complementary", { name: "其他任务" });
  await drawer.getByRole("tab", { name: /已取消/ }).click();
  await drawer.getByRole("button", { name: `彻底删除任务 ${identifier}` }).click();
  const dialog = page.getByRole("alertdialog", { name: `彻底删除 ${identifier}？` });
  const failedDeletion = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/v1/tasks/${task.id}`) &&
      response.request().method() === "DELETE",
  );
  await dialog.getByRole("button", { name: "永久删除", exact: true }).click();
  const failure = (await (await failedDeletion).json()) as {
    error: { details: { reason: string; threadId: string } };
  };
  expect(failure.error.details.reason).toBe("CODEX_DESKTOP_THREAD_BUSY");
  const error = page.locator(".notification--error");
  await expect(error).toContainText("数据已更新，请刷新后重试。");
  await expect(error).toBeVisible();
  await error.hover();
  await page.waitForTimeout(1_200);
  await expect(error).toBeVisible();
  await page.mouse.move(0, 0);
  await page.screenshot({
    path: testInfo.outputPath("restore-error-notice.png"),
    animations: "disabled",
  });
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(error).toHaveCount(0, { timeout: 2_500 });
  const archivePrompt = page.getByRole("alertdialog", { name: "Codex 对话仍被占用" });
  await expect(dialog).toHaveCount(0);
  await expect(archivePrompt.locator("dialog")).toHaveCount(0);
  await expect(archivePrompt).toContainText("是否打开对应对话进行归档？");
  await expect(archivePrompt.getByRole("link", { name: "打开 Codex 对话" })).toHaveAttribute(
    "href",
    `codex://threads/${encodeURIComponent(failure.error.details.threadId)}`,
  );
  await archivePrompt.getByRole("button", { name: "暂不跳转" }).click();
  await expect(archivePrompt).toHaveCount(0);
  // Retrying the same failure must announce it again for a fresh second.
  await dialog.getByRole("button", { name: "永久删除", exact: true }).click();
  await expect(error).toContainText("数据已更新，请刷新后重试。");
  await expect(archivePrompt).toBeVisible();
  await expect(error).toHaveCount(0, { timeout: 2_500 });
  await page.keyboard.press("Escape");
  await expect(archivePrompt).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog.getByRole("button", { name: "永久删除", exact: true }).click();
  await expect(error).toContainText("数据已更新，请刷新后重试。");
  await expect(archivePrompt).toHaveCount(0);
  await expect(error).toHaveCount(0, { timeout: 2_500 });
  await page.setViewportSize({ width: 1280, height: 900 });
  await dialog.getByRole("button", { name: "保留任务", exact: true }).click();
  await drawer.getByRole("button", { name: `恢复任务 ${identifier}`, exact: true }).click();
  await expect(page.getByTestId(`task-card-${identifier}`)).toBeVisible();
  const success = page.locator(".notification--success");
  await expect(success).toHaveText("任务已恢复");
  await expect(success).toHaveCount(0, { timeout: 2_500 });
});

test("任务详情取消任务等待 Codex 停止并保留工作区", async ({ page }) => {
  const project = await registerExecutableProject("CANCELTASK");
  await openWorkspace(page);
  await selectProject(page, project);
  const identifier = await quickCreate(page, "取消整个任务");
  await page.getByTestId(`task-card-${identifier}`).getByRole("button").first().click();
  const detail = page.getByRole("region", { name: "任务详情", exact: true });
  await detail.getByRole("button", { name: "启动 Codex" }).click();
  await expect(detail.getByText("等待审批", { exact: true })).toBeVisible();
  await detail.getByRole("button", { name: "取消任务", exact: true }).click();
  await expect(detail).toHaveCount(0);
  await expect(page.getByRole("region", { name: "看板命令", exact: true })).toBeVisible();
  expect(existsSync(project.rootPath)).toBe(true);
  await page.getByRole("button", { name: "打开其他任务", exact: true }).click();
  const drawer = page.getByRole("complementary", { name: "其他任务" });
  await drawer.getByRole("tab", { name: /已取消/ }).click();
  await drawer.getByRole("button", { name: `恢复任务 ${identifier}`, exact: true }).click();
  await expect(page.getByTestId(`task-card-${identifier}`)).toBeVisible();
  await page.getByTestId(`task-card-${identifier}`).getByRole("button").first().click();
  await expect(detail.getByRole("button", { name: "状态", exact: true })).toContainText("处理中");
});

test("参考列表按状态折叠并支持行内优先级和键盘打开", async ({ page }) => {
  const project = await registerProject("LIST");
  await openWorkspace(page);
  await selectProject(page, project);
  const identifier = await quickCreate(page, "列表布局与交互验证");
  await page.getByRole("tab", { name: "列表", exact: true }).click();
  const list = page.locator(".issue-list-view");
  await expect(list.locator(".issue-list-group")).toHaveCount(7);
  const header = list.locator(".status-backlog .issue-list-group-header");
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await header.click();
  const row = list.locator(".issue-list-row").filter({ hasText: identifier });
  await expect(row).toBeVisible();
  await expect(row.locator("time")).not.toBeEmpty();
  const priority = row.getByRole("button", { name: `${identifier} 优先级` });
  await priority.click();
  await page.getByRole("option", { name: "高", exact: true }).click();
  await expect(priority).toContainText("高");
  await expect(priority).toBeEnabled();
  await page.setViewportSize({ width: 700, height: 380 });
  await priority.click();
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.locator('.issue-list-view[aria-label="任务列表"]').evaluate((element) => {
    element.scrollTop = 100;
  });
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 720 });
  await priority.click();
  await page.keyboard.press("Escape");
  await expect(priority).toBeFocused();
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await page.route("**/api/v1/tasks/*", async (route) => {
    if (route.request().method() === "PATCH") await route.abort();
    else await route.continue();
  });
  await priority.click();
  await page.getByRole("option", { name: "中", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("网络连接中断，请检查网络后重试。");
  await expect(priority).toContainText("高");
  await page.unroute("**/api/v1/tasks/*");
  await expect(page.getByRole("region", { name: "任务详情", exact: true })).toHaveCount(0);
  await row.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "任务详情", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "返回看板", exact: true }).click();
  await page.setViewportSize({ width: 700, height: 800 });
  await expect(row).toBeVisible();
  expect(
    await row.evaluate((element) => element.getBoundingClientRect().height),
  ).toBeGreaterThanOrEqual(66);
  expect(await list.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test("七状态筛选图标与颜色完整且其他任务不遮挡菜单", async ({ page }) => {
  const project = await registerProject("FILTER");
  await openWorkspace(page);
  await selectProject(page, project);
  for (const status of ["todo", "done", "canceled"]) {
    taskctl(
      "issue",
      "create",
      "--project",
      project.id,
      "--title",
      `筛选验证 ${status}`,
      "--status",
      status,
    );
  }
  await page.getByRole("button", { name: "打开其他任务", exact: true }).click();
  const archive = page.getByRole("complementary", { name: "其他任务" });
  await expect(archive).toBeVisible();
  for (const width of [1440, 900]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole("button", { name: "筛选任务", exact: true }).click();
    await page.getByRole("menuitem", { name: "状态", exact: true }).hover();
    const statusMenu = page.getByRole("menu", { name: "按状态筛选" });
    await expect(statusMenu.getByRole("menuitemcheckbox")).toHaveCount(7);
    for (const [status, color] of Object.entries({
      backlog: "rgb(142, 74, 247)",
      todo: "rgb(199, 131, 24)",
      in_progress: "rgb(74, 164, 97)",
      in_review: "rgb(76, 125, 247)",
      blocked: "rgb(212, 88, 88)",
      done: "rgb(119, 123, 128)",
      canceled: "rgb(119, 123, 128)",
    })) {
      await expect(statusMenu.locator(`.task-filter-status-icon--${status}`)).toHaveCSS(
        "color",
        color,
      );
    }
    const done = statusMenu.getByRole("menuitemcheckbox", { name: "已完成", exact: true });
    await expect(done).toBeEnabled();
    expect(
      await done.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return element.contains(
          document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
        );
      }),
    ).toBe(true);
    await done.click();
    await expect(done).toHaveAttribute("aria-checked", "true");
    await expect(archive.getByText("筛选验证 done", { exact: true })).toBeVisible();
    await done.click();
    const canceled = statusMenu.getByRole("menuitemcheckbox", { name: "已取消", exact: true });
    await canceled.click();
    await expect(canceled).toHaveAttribute("aria-checked", "true");
    await canceled.click();
    await page.getByRole("menuitem", { name: "优先级", exact: true }).hover();
    const priorityMenu = page.getByRole("menu", { name: "按优先级筛选" });
    await expect(priorityMenu.locator(".task-filter-priority-icon")).toHaveCount(5);
    await expect(
      priorityMenu
        .getByRole("menuitemcheckbox", { name: "紧急", exact: true })
        .locator(".priority-urgent-icon"),
    ).toHaveText("!");
    await expect(
      priorityMenu
        .getByRole("menuitemcheckbox", { name: "无优先级", exact: true })
        .locator(".priority-none-icon"),
    ).toHaveText("---");
    for (const [name, count] of [
      ["高", 3],
      ["中", 2],
      ["低", 1],
    ] as const) {
      await expect(
        priorityMenu
          .getByRole("menuitemcheckbox", { name, exact: true })
          .locator(".priority-bars i[data-active]"),
      ).toHaveCount(count);
    }
    const rootPriority = page.getByRole("menuitem", { name: "优先级", exact: true });
    expect(
      await rootPriority.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return element.contains(
          document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
        );
      }),
    ).toBe(true);
    await page.keyboard.press("Escape");
  }
});

test("详情修复：相邻状态、活动实时更新、评论菜单和图片附件", async ({ page }) => {
  test.setTimeout(60_000);
  const project = await registerProject("DETAILFIX");
  await openWorkspace(page);
  await selectProject(page, project);
  const detail = await createTaskAndOpenDetail(page, "详情修复验收");
  await expect(detail.getByRole("button", { name: "刷新", exact: true })).toHaveCount(0);
  await expect(detail.getByRole("button", { name: "复制链接", exact: true })).toHaveCount(0);
  await detail.getByRole("button", { name: "添加父任务", exact: true }).click();
  await expect(detail.getByText("暂无可绑定任务", { exact: true })).toBeVisible();
  await detail.getByRole("searchbox", { name: "搜索任务" }).press("Escape");
  await detail.getByRole("button", { name: "状态", exact: true }).click();
  await expect(detail.getByRole("option", { name: "待验收", exact: true })).toBeDisabled();
  await expect(
    detail
      .getByRole("option", { name: "待处理", exact: true })
      .locator('[data-sf-symbol="circle"]'),
  ).toBeVisible();
  await detail.getByRole("option", { name: "待立项", exact: true }).click();
  await expect(
    detail.getByText("将状态从「待处理」改为「待立项」", { exact: false }),
  ).toBeVisible();
  await detail.getByRole("button", { name: "优先级", exact: true }).click();
  await expect(
    detail.getByRole("option", { name: "高", exact: true }).locator(".priority-bars"),
  ).toBeVisible();
  await detail.getByRole("option", { name: "高", exact: true }).click();
  await expect(
    detail.getByText("将优先级从「无优先级」改为「高」", { exact: false }),
  ).toBeVisible();
  await detail.getByLabel("新评论").fill("评论灰框验收");
  await detail.getByRole("button", { name: "发表评论" }).click();
  const comment = detail.locator(".comment").filter({ hasText: "评论灰框验收" });
  await expect(comment).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(comment.getByRole("button", { name: "评论操作", exact: true })).toHaveCSS(
    "opacity",
    "0",
  );
  await comment.hover();
  await comment.getByRole("button", { name: "评论操作", exact: true }).click();
  await comment.getByRole("menuitem", { name: "编辑评论" }).click();
  await comment.getByLabel("编辑评论").fill("已编辑评论");
  await detail.getByRole("button", { name: "保存", exact: true }).click();
  const edited = detail.locator(".comment").filter({ hasText: "已编辑评论" });
  await expect(edited).toBeVisible();
  const activity = detail.getByRole("region", { name: "活动", exact: true });
  const conversation = detail.getByRole("region", { name: "对话", exact: true });
  await expect(activity.locator(".comment")).toHaveCount(0);
  await expect(conversation.locator(".comment")).toHaveCount(1);
  await detail.getByRole("button", { name: "活动", exact: true }).click();
  await expect(detail.locator("#activity-content")).toBeHidden();
  await expect(edited).toBeVisible();
  await detail.getByLabel("新评论").fill("收起后保留草稿");
  await detail.getByRole("button", { name: "对话", exact: true }).click();
  await expect(edited).toBeHidden();
  await expect(detail.getByLabel("新评论")).toBeHidden();
  await detail.getByRole("button", { name: "活动", exact: true }).click();
  await expect(detail.locator("#activity-content")).toBeVisible();
  await expect(edited).toBeHidden();
  await detail.getByRole("button", { name: "对话", exact: true }).click();
  await expect(edited).toBeVisible();
  await expect(detail.getByLabel("新评论")).toHaveValue("收起后保留草稿");
  await edited.hover();
  await edited.getByRole("button", { name: "评论操作", exact: true }).click();
  await edited.getByRole("menuitem", { name: "删除评论" }).click();
  await expect(detail.getByText("删除了评论", { exact: false })).toBeVisible();
  await expect(edited).toHaveCount(0);
  await detail.getByRole("button", { name: "编辑描述" }).click();
  await detail.getByLabel("添加描述附件").setInputFiles({
    name: "preview.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6OmQAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await detail.getByRole("button", { name: "查看图片 preview.png" }).click();
  const preview = page.getByRole("dialog", { name: "预览图片 preview.png" });
  await expect(preview).toBeVisible();
  await expect
    .poll(() => preview.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBe(1);
  await preview.getByRole("button", { name: "关闭图片预览" }).click();
  await detail.getByRole("button", { name: "删除附件 preview.png" }).click();
  await expect(detail.getByRole("button", { name: "查看图片 preview.png" })).toHaveCount(0);
  await expect(detail.getByText("删除了附件", { exact: false })).toBeVisible();
  const currentTask = (
    await readPublicData<{ tasks: TaskFixture[] }>(page, `/api/v1/projects/${project.id}/board`)
  ).tasks[0]!;
  const response = await page.evaluate(async (taskId) => {
    const { data: session } = await (await fetch("/api/v1/session")).json();
    const result = await fetch(`/api/v1/tasks/${taskId}/comments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": session.csrfToken,
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({ body: "另一客户端的实时评论" }),
    });
    return result.status;
  }, currentTask.id);
  expect(response).toBe(201);
  await expect(detail.getByText("另一客户端的实时评论", { exact: true })).toBeVisible();
});

test("详情静态显示真实负责人且不提供用户创建入口", async ({ page }) => {
  const project = await registerProject("OWNER");
  const descriptor = JSON.parse(
    readFileSync(resolve(process.env.CODEXBOARD_DATA_DIR as string, "run/runtime.json"), "utf8"),
  ) as RuntimeDescriptor;
  const removedBootstrap = await fetch(
    `${descriptor.localAdminBaseUrl}/api/v1/local/projects/${project.id}/members/bootstrap`,
    {
      method: "PUT",
      headers: {
        ...(await localUserHeaders(descriptor)),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        tenantKey: "e2e-detail-owner",
        userId: `owner-${randomUUID()}`,
        name: "不应创建的用户",
        projectRole: "executor",
      }),
    },
  );
  expect(removedBootstrap.status).toBe(404);
  await openWorkspace(page);
  await selectProject(page, project);
  const identifier = await quickCreate(page, "负责人编辑验证");
  await page.getByTestId(`task-card-${identifier}`).getByRole("button").first().click();
  const detail = page.getByRole("region", { name: "任务详情", exact: true });
  await expect(detail.locator(".detail-assignee .detail-property-text")).toHaveText(
    SYNTHETIC_FEISHU_NAME,
  );
  await expect(detail.getByRole("button", { name: "负责人", exact: true })).toHaveCount(0);
  await expect(detail.getByRole("listbox", { name: "负责人", exact: true })).toHaveCount(0);
  await expect(detail.getByText("未分配负责人", { exact: true })).toHaveCount(0);
  const options = await readPublicData<{ assignees: { identity: IdentityRef }[] }>(
    page,
    `/api/v1/projects/${project.id}/task-creation-options`,
  );
  expect(options.assignees.map((actor) => actor.identity)).toEqual([SYNTHETIC_FEISHU_IDENTITY]);
  await page.reload();
  await page.getByTestId(`task-card-${identifier}`).getByRole("button").first().click();
  await expect(detail.locator(".detail-assignee .detail-property-text")).toHaveText(
    SYNTHETIC_FEISHU_NAME,
  );
});

test("描述内附件与评论附件独立展示、持久化和执行锁定", async ({ page }) => {
  const project = await registerExecutableProject("FILES");
  await openWorkspace(page);
  await selectProject(page, project);
  const identifier = await quickCreate(page, "描述与评论附件验证");
  await page.getByTestId(`task-card-${identifier}`).getByRole("button").first().click();
  const detail = page.getByRole("region", { name: "任务详情", exact: true });
  const content = detail.getByRole("article", { name: "任务内容" });
  await expect(detail.getByRole("heading", { name: "附件", exact: true })).toHaveCount(0);
  await expect(content.getByLabel("添加描述附件")).toHaveCount(0);
  await detail.getByRole("button", { name: "编辑描述" }).click();
  await expect(
    content.locator(".detail-description-editor").getByLabel("添加描述附件"),
  ).toBeVisible();
  await content.getByLabel("添加描述附件").focus();
  await expect(content.getByLabel("添加描述附件")).toBeVisible();
  await content.getByLabel("添加描述附件").setInputFiles({
    name: "需求说明.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("任务描述附件"),
  });
  await expect(content.getByRole("link", { name: /需求说明.txt/ })).toBeVisible();
  const conversation = detail.getByRole("region", { name: "对话", exact: true });
  await conversation.getByLabel("添加评论附件").setInputFiles([
    { name: "评论补充.txt", mimeType: "text/plain", buffer: Buffer.from("评论内容附件") },
    { name: "移除.txt", mimeType: "text/plain", buffer: Buffer.from("不发送") },
  ]);
  await conversation.getByRole("button", { name: "移除待发送附件 移除.txt" }).click();
  await conversation
    .getByLabel("添加评论附件")
    .setInputFiles({ name: "补充二.txt", mimeType: "text/plain", buffer: Buffer.from("补充二") });
  await expect(conversation.getByRole("list", { name: "待发送附件", exact: true })).toContainText(
    "评论补充.txt",
  );
  await expect(conversation.getByRole("list", { name: "待发送附件", exact: true })).toContainText(
    "补充二.txt",
  );
  let attempts = 0;
  let firstFileUploads = 0;
  await page.route("**/api/v1/tasks/*/attachments", async (route) => {
    const filename = decodeURIComponent(route.request().headers()["x-filename"] ?? "");
    if (filename === "评论补充.txt") firstFileUploads += 1;
    if (filename === "补充二.txt" && attempts++ === 0) {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "INTERNAL_ERROR", message: "模拟评论附件上传失败" },
        }),
      });
      return;
    }
    await route.continue();
  });
  await conversation.getByRole("button", { name: "发表评论" }).click();
  await expect(page.locator(".notification").filter({ hasText: "操作失败，请重试" })).toBeVisible();
  await expect(conversation.getByRole("list", { name: "待发送附件", exact: true })).toContainText(
    "评论补充.txt",
  );
  await expect(content).not.toContainText("评论补充.txt");
  await conversation.getByRole("button", { name: "发表评论" }).click();
  const comment = conversation.locator(".comment").filter({ hasText: "评论补充.txt" });
  await expect(comment.getByRole("link", { name: /评论补充.txt/ })).toBeVisible();
  await expect(comment.getByRole("link", { name: /补充二.txt/ })).toBeVisible();
  expect(firstFileUploads).toBe(1);
  await expect(content).not.toContainText("评论补充.txt");
  await expect(conversation.getByRole("list", { name: "待发送附件", exact: true })).toHaveCount(0);
  await page.reload();
  await page.getByTestId(`task-card-${identifier}`).getByRole("button").first().click();
  await expect(comment.getByRole("link", { name: /评论补充.txt/ })).toBeVisible();
  await detail.getByRole("button", { name: "启动 Codex" }).click();
  await detail.getByRole("button", { name: "允许一次" }).click();
  await expect(detail.locator(".job-status")).toHaveText("已完成");
  await expect(comment.getByText("已执行", { exact: true })).toBeVisible();
  await expect(comment.getByRole("button", { name: /删除附件/ })).toHaveCount(0);
  await expect(comment.getByRole("button", { name: "评论操作" })).toHaveCount(0);
});

test("描述与评论支持粘贴和拖拽附件并保留文字粘贴", async ({ page, context }) => {
  const project = await registerProject("TRANSFER");
  await openWorkspace(page);
  await selectProject(page, project);
  const identifier = await quickCreate(page, "粘贴拖拽附件验证");
  await page.getByTestId(`task-card-${identifier}`).getByRole("button").first().click();
  const detail = page.getByRole("region", { name: "任务详情", exact: true });
  const description = detail.getByRole("group", { name: "描述与附件", exact: true });
  const transfer = async (target: Locator, event: "paste" | "drop", names: string[]) => {
    await target.evaluate(
      (element, input) => {
        const data = new DataTransfer();
        for (const name of input.names)
          data.items.add(new File([`附件 ${name}`], name, { type: "text/plain" }));
        if (input.event === "drop") {
          element.dispatchEvent(
            new DragEvent("dragenter", { dataTransfer: data, bubbles: true, cancelable: true }),
          );
          element.dispatchEvent(
            new DragEvent("dragover", { dataTransfer: data, bubbles: true, cancelable: true }),
          );
        }
        const event =
          input.event === "paste"
            ? new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })
            : new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true });
        element.dispatchEvent(event);
        if (!event.defaultPrevented) throw new Error("附件传输未拦截浏览器默认行为");
      },
      { event, names },
    );
  };
  await detail.getByRole("button", { name: "编辑描述" }).click();
  await transfer(description, "drop", ["描述拖拽一.txt", "描述拖拽二.txt"]);
  await expect(description.getByRole("link", { name: /描述拖拽一.txt/ })).toBeVisible();
  await expect(description.getByRole("link", { name: /描述拖拽二.txt/ })).toBeVisible();
  await expect(description).not.toHaveClass(/is-dragging/);
  const editor = detail.getByRole("textbox", { name: "描述", exact: true });
  await editor.fill("保留描述正文");
  await transfer(editor, "paste", ["描述粘贴.txt"]);
  await expect(description.getByRole("link", { name: /描述粘贴.txt/ })).toBeVisible();
  await expect(editor).toHaveValue("保留描述正文");
  const conversation = detail.getByRole("region", { name: "对话", exact: true });
  const composer = conversation.getByRole("group", { name: "评论", exact: true });
  await transfer(composer.getByRole("textbox"), "paste", ["评论粘贴.txt"]);
  await transfer(composer, "drop", ["评论拖拽.txt"]);
  const pending = composer.getByRole("list", { name: "待发送附件", exact: true });
  await expect(pending).toContainText("评论粘贴.txt");
  await expect(pending).toContainText("评论拖拽.txt");
  await expect(description).not.toContainText("评论粘贴.txt");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(() => navigator.clipboard.writeText("普通文字正常粘贴"));
  await composer.getByRole("textbox").focus();
  await page.keyboard.press("ControlOrMeta+V");
  await expect(composer.getByRole("textbox")).toHaveValue("普通文字正常粘贴");
  await composer.getByRole("button", { name: "发表评论", exact: true }).click();
  const comment = conversation.locator(".comment", { hasText: "普通文字正常粘贴" });
  await expect(comment.getByRole("link", { name: /评论粘贴.txt/ })).toBeVisible();
  await expect(comment.getByRole("link", { name: /评论拖拽.txt/ })).toBeVisible();
  await expect(description.getByRole("button", { name: "编辑描述" })).toContainText("保留描述正文");
});

test("新增任务描述支持粘贴和拖拽附件", async ({ page, context }) => {
  const project = await registerProject("NEWFILES");
  await openWorkspace(page);
  await selectProject(page, project);
  const detail = await createTaskAndOpenDetail(page, "创建时添加附件", async (dialog) => {
    const description = dialog.locator(".task-create-description-input");
    await description.fill("保留新任务描述");
    for (const kind of ["paste", "drop"]) {
      await description.evaluate((element, kind) => {
        const data = new DataTransfer();
        data.items.add(new File(["attachment"], `${kind}.txt`, { type: "text/plain" }));
        const event =
          kind === "paste"
            ? new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })
            : new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true });
        element.dispatchEvent(event);
        if (!event.defaultPrevented) throw new Error("未拦截附件默认行为");
      }, kind);
      await expect(dialog.getByLabel("已添加附件")).toContainText(`${kind}.txt`);
    }
    await expect(description).toHaveValue("保留新任务描述");
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.evaluate(() => navigator.clipboard.writeText("普通文字粘贴"));
    await description.fill("");
    await description.focus();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");
    await expect(description).toHaveValue("普通文字粘贴");
  });
  await expect(detail.getByRole("link", { name: /paste.txt/ })).toBeVisible();
  await expect(detail.getByRole("link", { name: /drop.txt/ })).toBeVisible();
  await expect(detail.locator(".detail-description-read")).toContainText("普通文字粘贴");
  await expect(detail.getByRole("button", { name: "任务完成", exact: true })).toBeDisabled();
});

test("详情分支在项目前显示，执行前自动保存、执行后无下拉菜单", async ({ page }) => {
  const project = await registerExecutableProject("BRANCHPROP");
  const branch = "feature/detail-branch";
  execFileSync("git", ["-C", project.rootPath, "branch", branch]);
  execFileSync("git", [
    "-C",
    project.rootPath,
    "worktree",
    "add",
    join(process.env.CODEXBOARD_DATA_DIR as string, `branch-property-${randomUUID()}`),
    branch,
  ]);
  await localAdminRequest(`/api/v1/local/projects/${project.id}/contexts/scan`, {
    method: "POST",
    body: "{}",
  });
  await openWorkspace(page);
  await selectProject(page, project);
  const detail = await createTaskAndOpenDetail(page, "详情分支只读", async (dialog) => {
    await expect(dialog.locator('[data-icon="git-branch"]')).toBeVisible();
    await expect(dialog.locator('[data-icon="git-branch"] circle')).toHaveCount(3);
    const contextSelect = dialog.getByRole("combobox", { name: "分支 / Worktree" });
    await expect(contextSelect).toBeEnabled();
    await contextSelect.selectOption({ label: branch });
  });
  const properties = detail.getByRole("complementary", { name: "任务属性" });
  const rows = await properties
    .locator(".detail-property-row > span:first-child")
    .allTextContents();
  expect(rows[rows.indexOf("分支") + 1]).toBe("项目");
  const value = properties.getByLabel("分支", { exact: true });
  await expect(value).toContainText(branch);
  await expect(value.locator('[data-icon="git-branch"] circle')).toHaveCount(3);
  await properties.getByRole("button", { name: "分支", exact: true }).click();
  await properties.getByRole("option", { name: "main", exact: true }).click();
  await expect(detail.getByText("已自动保存", { exact: true })).toBeVisible();
  const created = (
    await readPublicData<{ tasks: TaskFixture[] }>(page, `/api/v1/projects/${project.id}/board`)
  ).tasks[0]!;
  expect(
    (
      await readPublicData<TaskFixture & { developmentContextId: string | null }>(
        page,
        `/api/v1/tasks/${created.id}`,
      )
    ).developmentContextId,
  ).toBeNull();
  await page.reload();
  await page.getByTestId(`task-card-${created.identifier}`).getByRole("button").first().click();
  await expect(page.getByRole("region", { name: "任务详情", exact: true })).toBeVisible();
  await expect(properties.getByLabel("分支", { exact: true })).toContainText("main");
  await properties.getByRole("button", { name: "分支", exact: true }).click();
  await properties.getByRole("option", { name: branch, exact: true }).click();
  await expect(detail.getByText("已自动保存", { exact: true })).toBeVisible();
  const startStatus = await page.evaluate(async (taskId) => {
    const session = await (await fetch("/api/v1/session")).json();
    return (
      await fetch(`/api/v1/tasks/${taskId}/jobs/continue`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": session.data.csrfToken,
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: "{}",
      })
    ).status;
  }, created.id);
  expect(startStatus).toBe(202);
  await page.reload();
  await page.getByTestId(`task-card-${created.identifier}`).getByRole("button").first().click();
  await expect(properties.getByRole("button", { name: "分支", exact: true })).toHaveCount(0);
  await expect(value).toContainText(branch);
  await value.click();
  await expect(properties.getByRole("listbox", { name: "分支选项" })).toHaveCount(0);
});

test("分支管理支持创建和删除工作树、保护主分支并适配手机", async ({ page }) => {
  const project = await registerExecutableProject("GITMANAGER");
  writeFileSync(join(project.rootPath, ".gitignore"), ".worktrees/\nignored.txt\n");
  execFileSync("git", ["-C", project.rootPath, "add", ".gitignore"]);
  execFileSync("git", ["-C", project.rootPath, "commit", "-m", "ignore worktrees"]);
  await openWorkspace(page);
  await selectProject(page, project);
  await page.getByRole("button", { name: "分支 / worktree 管理", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "分支 / worktree 管理" });
  await expect(dialog.getByLabel("项目", { exact: true })).toHaveValue(project.id);
  await expect(dialog.getByRole("button", { name: "删除 main", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "新建", exact: true }).click();
  await dialog.getByLabel("分支名称", { exact: true }).fill("feature/ui-test");
  await dialog.getByLabel("目录名称", { exact: true }).fill("ui-test");
  await dialog.getByRole("button", { name: "创建", exact: true }).click();
  await expect(dialog.getByText("已创建，可在任务中选择新的工作树", { exact: true })).toBeVisible();
  expect(existsSync(join(project.rootPath, ".worktrees/ui-test/.git"))).toBe(true);
  const createdRow = dialog.getByRole("listitem").filter({ hasText: "feature/ui-test" });
  await expect(createdRow.locator(".git-manager-origins")).toContainText("分支：");
  await expect(createdRow.locator(".git-manager-origins")).toContainText("worktree：");
  await expect(createdRow.locator(".git-manager-origins")).not.toContainText("来源未知");
  writeFileSync(join(project.rootPath, ".worktrees/ui-test/ignored.txt"), "generated cache");
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 800 });
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
  }
  await dialog.getByLabel("搜索分支或路径").fill("ui-test");
  await expect(dialog.getByRole("button", { name: "删除 main", exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "删除 feature/ui-test", exact: true }).click();
  await dialog.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(dialog.getByText("已删除", { exact: true })).toBeVisible();
  expect(existsSync(join(project.rootPath, ".worktrees/ui-test"))).toBe(false);
  await dialog.getByLabel("搜索分支或路径").fill("");
  await expect(dialog.getByRole("button", { name: "删除 main", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "关闭分支管理" }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "标签管理", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "标签管理", exact: true })).toBeVisible();
});

for (const status of ["done", "canceled"] as const) {
  test(`${status} 详情只允许返回，实时结束会关闭编辑控件`, async ({ page }) => {
    const project = await registerProject(status === "done" ? "READDONE" : "READCANCEL");
    await openWorkspace(page);
    await selectProject(page, project);
    const detail = await createTaskAndOpenDetail(page, "结束后只读", async (dialog) => {
      await dialog.getByLabel("任务描述").fill("[只读链接](https://example.com)");
    });
    const task = (
      await readPublicData<{ tasks: (TaskFixture & { version: number })[] }>(
        page,
        `/api/v1/projects/${project.id}/board`,
      )
    ).tasks[0]!;
    await detail.getByRole("textbox", { name: "新评论", exact: true }).fill("尚未提交的评论");
    await detail.getByRole("button", { name: "优先级", exact: true }).click();
    await expect(page.getByRole("option", { name: "高", exact: true })).toBeVisible();
    if (status === "done")
      taskctl("issue", "move", task.id, "--version", String(task.version), "--status", "in_review");
    const latest = await readPublicData<TaskFixture & { version: number }>(
      page,
      `/api/v1/tasks/${task.id}`,
    );
    taskctl("issue", "move", task.id, "--version", String(latest.version), "--status", status);
    await expect(detail.getByText("只读", { exact: true })).toBeVisible();
    await expect(page.getByRole("option", { name: "高", exact: true })).toHaveCount(0);
    await expect(detail.locator("button:not(:disabled)")).toHaveCount(1);
    await expect(detail.getByLabel("标题", { exact: true })).toBeDisabled();
    const link = detail.getByRole("link", { name: "只读链接" });
    const url = page.url();
    await link.click();
    expect(page.url()).toBe(url);
    await link.focus();
    await page.keyboard.press("Enter");
    expect(page.url()).toBe(url);
    await detail.getByRole("button", { name: "返回看板" }).click();
    await expect(detail).toHaveCount(0);
    if (status === "canceled") {
      await page.getByRole("button", { name: "打开其他任务", exact: true }).click();
      const drawer = page.getByRole("complementary", { name: "其他任务" });
      await drawer.getByRole("tab", { name: /已取消/ }).click();
      await drawer
        .getByRole("button", { name: `恢复任务 ${task.identifier}`, exact: true })
        .click();
      await page.getByTestId(`task-card-${task.identifier}`).getByRole("button").first().click();
      await expect(detail.getByLabel("标题", { exact: true })).toBeEnabled();
    }
  });
}

test("待立项详情只显示立项和取消并持久化状态", async ({ page }) => {
  const project = await registerProject("INITIATE");
  await openWorkspace(page);
  await selectProject(page, project);
  const identifier = await quickCreate(page, "待立项操作验证", async (dialog) => {
    await dialog.getByRole("combobox", { name: "初始状态" }).selectOption("backlog");
  });
  await page.getByTestId(`task-card-${identifier}`).getByRole("button").first().click();
  const detail = page.getByRole("region", { name: "任务详情", exact: true });
  const actions = detail.locator(".detail-execution-actions");
  await expect(actions.getByRole("button")).toHaveText(["立项", "取消"]);
  await expect(actions.getByText("仅待验收状态可完成任务")).toHaveCount(0);
  await actions.getByRole("button", { name: "立项", exact: true }).click();
  await expect(detail.getByRole("button", { name: "状态", exact: true })).toContainText("待处理");
  await expect(actions.getByRole("button", { name: "启动 Codex", exact: true })).toBeVisible();
  await page.reload();
  await page.getByTestId(`task-card-${identifier}`).getByRole("button").first().click();
  await expect(detail.getByRole("button", { name: "状态", exact: true })).toContainText("待处理");
  await expect(
    detail.getByRole("region", { name: "执行摘要" }).getByText("暂无执行记录"),
  ).toBeVisible();
  await detail.getByRole("button", { name: "返回看板" }).click();
  const canceled = await quickCreate(page, "待立项直接取消", async (dialog) => {
    await dialog.getByRole("combobox", { name: "初始状态" }).selectOption("backlog");
  });
  await page.getByTestId(`task-card-${canceled}`).getByRole("button").first().click();
  await actions.getByRole("button", { name: "取消", exact: true }).click();
  await expect(detail).toHaveCount(0);
  await page.getByRole("button", { name: "打开其他任务", exact: true }).click();
  const drawer = page.getByRole("complementary", { name: "其他任务" });
  await drawer.getByRole("tab", { name: /已取消/ }).click();
  await expect(
    drawer.getByRole("button", { name: `恢复任务 ${canceled}`, exact: true }),
  ).toBeVisible();
});

for (const width of [1280, 390]) {
  test(`五类任务关系卡片预览与跳转 ${width}`, async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width, height: 844 });
    const project = await registerProject("RELVIEW");
    await openWorkspace(page);
    await selectProject(page, project);
    const sourceIdentifier = await quickCreate(page, "关系卡片来源");
    const targets = [];
    for (const type of ["parent", "child", "related", "blocks", "blocked_by"]) {
      const identifier = await quickCreate(page, `关系卡片目标 ${type}`);
      targets.push({ type, identifier });
    }
    const board = await readPublicData<{ tasks: TaskFixture[] }>(
      page,
      `/api/v1/projects/${project.id}/board`,
    );
    const source = board.tasks.find((task) => task.identifier === sourceIdentifier)!;
    for (const target of targets) {
      const task = board.tasks.find((task) => task.identifier === target.identifier)!;
      taskctl("relation", "add", "--task", source.id, "--target", task.id, "--type", target.type);
    }
    for (const target of targets) {
      const boardCard = page.getByTestId(`task-card-${target.identifier}`);
      await expect(boardCard.getByLabel("分支", { exact: true })).not.toContainText("正在读取");
      const boardContent = await boardCard.innerText();
      const cardStyle = async (card: Locator) =>
        card.evaluate((element) => {
          const style = getComputedStyle(element);
          const content = getComputedStyle(element.querySelector(".task-open")!);
          return [
            style.backgroundColor,
            style.borderRadius,
            style.border,
            style.boxShadow,
            content.padding,
            content.gap,
            content.fontSize,
          ];
        });
      const boardStyle = await cardStyle(boardCard);
      await page.getByTestId(`task-card-${sourceIdentifier}`).getByRole("button").first().click();
      const detail = page.getByRole("region", { name: "任务详情", exact: true });
      const trigger = detail.getByRole("button", {
        name: `预览任务 ${target.identifier}`,
        exact: true,
      });
      await trigger.click();
      const card = detail.getByRole("dialog", {
        name: `任务卡片 ${target.identifier}`,
        exact: true,
      });
      await expect(card.locator(".task-open > strong")).toBeVisible();
      await expect(card.locator(".task-open")).toBeEnabled();
      await expect(card.locator(".task-card")).toHaveText(boardContent.replace(/\s+/g, " "), {
        useInnerText: true,
      });
      expect(await cardStyle(card.locator(".task-card"))).toEqual(boardStyle);
      if (target.type === "parent")
        await card.screenshot({ path: testInfo.outputPath(`relation-card-${width}.png`) });
      const box = await card.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      await trigger.press("Escape");
      await expect(card).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await trigger.click();
      await card.locator(".task-open").click();
      await expect(detail.getByLabel("标题", { exact: true })).toHaveValue(
        `关系卡片目标 ${target.type}`,
      );
      await detail.getByRole("button", { name: "返回看板" }).click();
    }
  });
}

test("手机新增任务附件按钮保留回形针图标", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWorkspace(page);
  const dialog = await openTaskCreateDialog(page);
  const attachment = dialog.getByRole("button", { name: "添加附件", exact: true });
  await expect(attachment.locator('[data-sf-symbol="paperclip"]')).toBeVisible();
  await expect(attachment.getByText("添加附件", { exact: true })).toBeHidden();
  const chooser = page.waitForEvent("filechooser");
  await attachment.click();
  expect(await chooser).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath("mobile-attachment-icon.png") });
});

test("LAUB-014 评论交互：未执行评论可编辑删除，图片可预览，草稿提示使用辅助字号", async ({
  page,
}) => {
  const project = await registerProject("COMMENTFIX");
  await openWorkspace(page);
  await selectProject(page, project);
  const detail = await createTaskAndOpenDetail(page, "评论交互验收");
  await detail.getByLabel("新评论").fill("图片评论验收");
  await detail.getByLabel("添加评论附件").setInputFiles({
    name: "comment-preview.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6OmQAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await detail.getByRole("button", { name: "发表评论" }).click();
  const comment = detail.locator(".comment").filter({ hasText: "图片评论验收" });
  await expect(comment).toBeVisible();
  await comment.getByRole("button", { name: "查看图片 comment-preview.png" }).click();
  const preview = page.getByRole("dialog", { name: "预览图片 comment-preview.png" });
  await expect(preview).toBeVisible();
  await expect
    .poll(() => preview.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBe(1);
  const download = preview.getByRole("link", { name: "下载原图" });
  await expect(download).toHaveClass("button");
  await expect(download).toHaveCSS(
    "font-size",
    await preview
      .getByRole("button", { name: "关闭图片预览" })
      .evaluate((button) => getComputedStyle(button).fontSize),
  );
  const originalViewport = page.viewportSize()!;
  for (const viewport of [originalViewport, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    const bounds = (await preview.boundingBox())!;
    expect(Math.abs(bounds.x + bounds.width / 2 - viewport.width / 2)).toBeLessThan(2);
    expect(Math.abs(bounds.y + bounds.height / 2 - viewport.height / 2)).toBeLessThan(2);
    await expect(download).toBeVisible();
  }
  await page.setViewportSize(originalViewport);
  const downloaded = page.waitForEvent("download");
  await download.click();
  expect((await downloaded).suggestedFilename()).toBe("comment-preview.png");
  await preview.getByRole("button", { name: "关闭图片预览" }).click();
  await expect(preview).toHaveCount(0);
  await comment.hover();
  await comment.getByRole("button", { name: "评论操作", exact: true }).click();
  await comment.getByRole("menuitem", { name: "编辑评论" }).click();
  await expect(comment.getByLabel("编辑评论")).toBeVisible();
  await comment.getByLabel("编辑评论").fill("修订图片评论");
  await expect(detail.getByText("请先保存或放弃评论草稿，再操作任务。", { exact: true })).toHaveCSS(
    "font-size",
    "12px",
  );
  await detail.getByRole("button", { name: "保存", exact: true }).click();
  const edited = detail.locator(".comment").filter({ hasText: "修订图片评论" });
  await expect(edited).toBeVisible();
  const current = (
    await readPublicData<{ tasks: TaskFixture[] }>(page, `/api/v1/projects/${project.id}/board`)
  ).tasks[0]!;
  const taskUrl = `**/api/v1/tasks/${current.id}`;
  // Exercise read-only display without completing or canceling a real job.
  for (const status of ["done", "canceled"]) {
    await page.route(taskUrl, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({ response, json: { ...body, data: { ...body.data, status } } });
    });
    await page.goto(`/?project=${project.id}&task=${current.id}`);
    await expect(detail.getByLabel("标题", { exact: true })).toBeDisabled();
    await expect(edited.getByRole("button", { name: "评论操作", exact: true })).toHaveCount(0);
    await edited.getByRole("button", { name: "查看图片 comment-preview.png" }).click();
    await expect(preview).toBeVisible();
    await expect
      .poll(() => preview.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBe(1);
    await preview.getByRole("button", { name: "关闭图片预览" }).click();
    await expect(preview).toHaveCount(0);
    await edited.getByRole("button", { name: "查看图片 comment-preview.png" }).press("Enter");
    await expect(preview).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(preview).toHaveCount(0);
    await page.unroute(taskUrl);
  }
  await page.reload();
  await edited.hover();
  await edited.getByRole("button", { name: "评论操作", exact: true }).click();
  await edited.getByRole("menuitem", { name: "删除评论" }).click();
  await expect(edited).toHaveCount(0);
  await expect(detail.getByRole("button", { name: "查看图片 comment-preview.png" })).toHaveCount(0);
});

test("LAUB-016 关闭保留新建草稿，图片附件统一缩略图与预览", async ({ page }, testInfo) => {
  const project = await registerProject("DRAFTFIX");
  await openWorkspace(page);
  await selectProject(page, project);
  const dialog = await openTaskCreateDialog(page);
  await dialog.getByLabel("任务标题", { exact: true }).fill("保留草稿验收");
  await dialog.getByLabel("任务描述", { exact: true }).fill("草稿描述");
  const file = {
    name: "draft.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6OmQAAAAASUVORK5CYII=",
      "base64",
    ),
  };
  await dialog.locator('input[type="file"]').setInputFiles(file);
  await dialog.getByRole("button", { name: "查看图片 draft.png" }).click();
  const preview = page.getByRole("dialog", { name: "预览图片 draft.png" });
  await expect(preview.locator("img")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(preview).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await openTaskCreateDialog(page);
  await expect(dialog.getByLabel("任务标题", { exact: true })).toHaveValue("保留草稿验收");
  await expect(dialog.getByLabel("任务描述", { exact: true })).toHaveValue("草稿描述");
  await expect
    .poll(() =>
      dialog.locator(".attachment-card img").evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBe(1);
  await page.screenshot({ path: testInfo.outputPath("draft-restored.png") });
  await dialog.getByRole("button", { name: "创建任务", exact: true }).click();
  const detail = page.getByRole("region", { name: "任务详情", exact: true });
  await expect(detail).toBeVisible();
  await expect
    .poll(() =>
      detail.locator(".attachment-card img").evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBe(1);
  await detail.getByRole("button", { name: "查看图片 draft.png" }).click();
  await expect(preview).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(detail).toBeVisible();
  await detail.getByLabel("添加评论附件").setInputFiles(file);
  const pending = detail.getByLabel("待发送附件");
  await expect
    .poll(() => pending.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBe(1);
  await pending.getByRole("button", { name: "查看图片 draft.png" }).click();
  await expect(preview).toBeVisible();
  await page.keyboard.press("Escape");
  await detail.getByRole("button", { name: "发表评论", exact: true }).click();
  await expect(pending).toHaveCount(0);
  await expect(detail.locator(".comment .attachment-card img")).toBeVisible();
  await expect(detail.getByText("可直接粘贴或拖入文件", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("unified-attachments.png") });
  const current = (
    await readPublicData<{ tasks: TaskFixture[] }>(page, `/api/v1/projects/${project.id}/board`)
  ).tasks[0]!;
  const workspaceUrl = `**/api/v1/tasks/${current.id}/workspace`;
  await page.route(workspaceUrl, async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.data.executionSummary.active = 1;
    await route.fulfill({ response, json: payload });
  });
  await page.goto(`/?project=${project.id}&task=${current.id}`);
  await expect(
    detail.locator(".comment").getByRole("button", { name: "评论操作", exact: true }),
  ).toHaveCount(0);
  await expect(
    detail.locator(".comment").getByRole("button", { name: "删除附件 draft.png" }),
  ).toHaveCount(0);
  await expect(detail.getByLabel("新评论")).toBeEnabled();
  await detail.locator(".comment").getByRole("button", { name: "查看图片 draft.png" }).click();
  await expect(preview).toBeVisible();
  await page.keyboard.press("Escape");
  await page.unroute(workspaceUrl);
  await page.goto(`/?project=${project.id}&task=${current.id}`);
  await expect(
    detail.locator(".comment").getByRole("button", { name: "评论操作", exact: true }),
  ).toHaveCount(1);
  await detail.getByRole("button", { name: "返回看板" }).click();
  await openTaskCreateDialog(page);
  await expect(dialog.getByLabel("任务标题", { exact: true })).toHaveValue("");
  await expect(dialog.getByLabel("已添加附件")).toHaveCount(0);
});

test("LAUB-016 Desktop 用户消息只读展示，收尾失败持续显示具体原因", async ({ page }, testInfo) => {
  const project = await registerProject("DESKTOPSYNC");
  await openWorkspace(page);
  await selectProject(page, project);
  await createTaskAndOpenDetail(page, "Desktop 对话同步验收");
  const current = (
    await readPublicData<{ tasks: TaskFixture[] }>(page, `/api/v1/projects/${project.id}/board`)
  ).tasks[0]!;
  await page.route(`**/api/v1/tasks/${current.id}`, async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.data.status = "in_review";
    await route.fulfill({ response, json: payload });
  });
  const timestamp = new Date().toISOString();
  await page.route(`**/api/v1/tasks/${current.id}/workspace`, async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.data.comments.push({
      id: randomUUID(),
      taskId: current.id,
      source: "desktop",
      author: null,
      body: "请同步这条 Desktop 用户消息",
      codexThreadId: randomUUID(),
      executedAt: null,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      deletedAt: null,
    });
    await route.fulfill({ response, json: payload });
  });
  await page.route(`**/api/v1/tasks/${current.id}/lifecycle`, async (route) => {
    await route.fulfill({
      json: {
        data: {
          id: randomUUID(),
          taskId: current.id,
          targetStatus: "done",
          status: "failed",
          phase: "cleaning",
          errorSummary: "任务未完成：工作树包含被 Git 忽略的本地文件，无法安全删除：.tmp/unowned",
          commitSha: null,
          archiveRef: null,
          notes: [],
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      },
    });
  });
  await page.goto(`/?project=${project.id}&task=${current.id}`);
  const detail = page.getByRole("region", { name: "任务详情", exact: true });
  const comment = detail.locator(".comment").filter({ hasText: "请同步这条 Desktop 用户消息" });
  await expect(comment.getByText("Desktop 用户", { exact: true })).toBeVisible();
  await expect(comment.getByRole("button", { name: "评论操作", exact: true })).toHaveCount(0);
  await expect(comment.getByRole("link", { name: "打开 Codex 对话" })).toBeVisible();
  await expect(detail.getByRole("button", { name: "重试任务收尾" })).toBeEnabled();
  const failure = detail.getByRole("alert").filter({ hasText: "任务未完成" });
  await expect(failure).toContainText(".tmp/unowned");
  // Keep the reason visible beyond the transient notification timeout.
  await expect
    .poll(async () => {
      const age = await failure.evaluate((element) => {
        const key = "data-observed-at";
        const start = Number(element.getAttribute(key) || Date.now());
        element.setAttribute(key, String(start));
        return Date.now() - start;
      });
      return age;
    })
    .toBeGreaterThan(1500);
  await expect(failure).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("desktop-message-cleanup-error.png") });
  await page.unrouteAll({ behavior: "wait" });
});

for (const order of ["task-first", "operation-first", "failure-retry"] as const) {
  test(`任务完成等待收尾成功和已完成状态后返回看板：${order}`, async ({ page }) => {
    const project = await registerProject("FINISHWAIT");
    await openWorkspace(page);
    await selectProject(page, project);
    await createTaskAndOpenDetail(page, "等待完成检查");
    const current = (
      await readPublicData<{ tasks: TaskFixture[] }>(page, `/api/v1/projects/${project.id}/board`)
    ).tasks[0]!;
    let taskDone = false;
    let taskReads = 0;
    let lifecycleReads = 0;
    let submissions = 0;
    const timestamp = new Date().toISOString();
    let operation: null | {
      id: string;
      taskId: string;
      targetStatus: "done";
      status: "pending" | "running" | "succeeded" | "failed";
      phase: "checking" | "cleaning" | "completed";
      errorSummary: string | null;
      commitSha: null;
      archiveRef: null;
      notes: string[];
      createdAt: string;
      updatedAt: string;
    } = null;
    await page.route(`**/api/v1/tasks/${current.id}`, async (route) => {
      const response = await route.fetch();
      const payload = await response.json();
      payload.data.status = taskDone ? "done" : "in_review";
      taskReads++;
      await route.fulfill({ response, json: payload });
    });
    await page.route(`**/api/v1/tasks/${current.id}/lifecycle`, async (route) => {
      if (route.request().method() === "POST") {
        submissions++;
        operation = {
          id: randomUUID(),
          taskId: current.id,
          targetStatus: "done",
          status: "pending",
          phase: "checking",
          errorSummary: null,
          commitSha: null,
          archiveRef: null,
          notes: [],
          createdAt: timestamp,
          updatedAt: timestamp,
        };
      } else lifecycleReads++;
      await route.fulfill({
        status: route.request().method() === "POST" ? 202 : 200,
        json: { data: operation },
      });
    });
    await page.goto(`/?project=${project.id}&task=${current.id}`);
    const detail = page.getByRole("region", { name: "任务详情", exact: true });
    await detail.getByRole("button", { name: "任务完成", exact: true }).click();
    await expect(detail.getByText("检查任务与工作区…", { exact: true })).toBeVisible();
    await expect(detail.getByRole("button", { name: "任务完成", exact: true })).toBeDisabled();
    expect(submissions).toBe(1);
    if (order === "failure-retry") {
      operation!.status = "failed";
      operation!.errorSummary = "任务未完成：缺少可核验的任务交付记录";
      await expect(detail.getByRole("alert")).toContainText("缺少可核验的任务交付记录");
      await detail.getByRole("button", { name: "重试任务收尾" }).click();
      await expect(detail.getByText("检查任务与工作区…", { exact: true })).toBeVisible();
      expect(submissions).toBe(2);
    }
    if (order === "task-first") {
      const before = taskReads;
      taskDone = true;
      await expect.poll(() => taskReads).toBeGreaterThan(before);
      await expect(detail.getByRole("button", { name: "状态", exact: true })).toContainText(
        "已完成",
      );
      await expect(detail).toBeVisible();
    } else {
      const before = lifecycleReads;
      operation!.status = "succeeded";
      operation!.phase = "completed";
      await expect.poll(() => lifecycleReads).toBeGreaterThan(before);
      await expect(detail.locator(".task-completion-result")).toBeVisible();
      await expect(detail).toBeVisible();
    }
    taskDone = true;
    operation!.status = "succeeded";
    operation!.phase = "completed";
    await expect(detail).not.toBeVisible();
    // Opening an already completed task is read-only inspection, not a fresh completion request.
    await page.goto(`/?project=${project.id}&task=${current.id}`);
    await expect(detail.getByRole("button", { name: "状态", exact: true })).toContainText("已完成");
    await expect(detail.locator(".task-completion-result")).toBeVisible();
    await expect(detail).toBeVisible();
    await page.unrouteAll({ behavior: "wait" });
  });
}

test("完成只检查 main 的 Git 状态：失败留在详情，手动提交后重试成功", async ({ page }) => {
  const project = await registerProject("CHECKONLY");
  await openWorkspace(page);
  await selectProject(page, project);
  const detail = await createTaskAndOpenDetail(page, "只读完成检查");
  const task = (
    await readPublicData<{ tasks: (TaskFixture & { version: number })[] }>(
      page,
      `/api/v1/projects/${project.id}/board`,
    )
  ).tasks[0]!;
  taskctl("issue", "move", task.id, "--version", String(task.version), "--status", "in_review");
  await expect(detail.getByRole("button", { name: "状态", exact: true })).toContainText("待验收");
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", project.rootPath, ...args], { encoding: "utf8" }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Completion Test");
  git("config", "user.email", "completion@example.test");
  writeFileSync(join(project.rootPath, "initial.txt"), "initial");
  git("add", "initial.txt");
  git("commit", "-m", "initial");
  const head = git("rev-parse", "HEAD");
  writeFileSync(join(project.rootPath, "pending.txt"), "not committed");
  await detail.getByRole("button", { name: "任务完成", exact: true }).click();
  await expect(detail.getByRole("alert")).toContainText("Git 不干净");
  await expect(detail).toBeVisible();
  expect(git("rev-parse", "HEAD")).toBe(head);
  expect(git("status", "--porcelain")).toContain("pending.txt");
  git("add", "pending.txt");
  git("commit", "-m", "user completes work");
  const delivered = git("rev-parse", "HEAD");
  await detail.getByRole("button", { name: "重试任务收尾" }).click();
  await expect(detail).not.toBeVisible();
  const completed = await readPublicData<{ status: string }>(page, `/api/v1/tasks/${task.id}`);
  expect(completed.status).toBe("done");
  expect(git("rev-parse", "HEAD")).toBe(delivered);
  expect(git("branch", "--show-current")).toBe("main");
  expect(git("for-each-ref", "--format=%(refname)", "refs/taskboard")).toBe("");
});

for (const width of [1280, 390]) {
  test(`LAUB-019 返回看板保留已取消页面并可恢复 ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const project = await registerProject("CANCELRETURN");
    await openWorkspace(page);
    await selectProject(page, project);
    const identifier = await quickCreate(page, "取消后返回与恢复");
    const task = (
      await readPublicData<{ tasks: (TaskFixture & { version: number })[] }>(
        page,
        `/api/v1/projects/${project.id}/board`,
      )
    ).tasks.find((task) => task.identifier === identifier)!;
    taskctl("issue", "move", task.id, "--version", String(task.version), "--status", "canceled");
    await page.getByRole("button", { name: "打开其他任务", exact: true }).click();
    const drawer = page.getByRole("complementary", { name: "其他任务" });
    await drawer.getByRole("tab", { name: /已取消/ }).click();
    await drawer.locator(".archive-task-open").filter({ hasText: identifier }).click();
    const detail = page.getByRole("region", { name: "任务详情", exact: true });
    await detail.getByRole("button", { name: "返回看板" }).click();
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("tab", { name: /已取消/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(
      drawer.locator(".archive-task-open").filter({ hasText: identifier }),
    ).toBeVisible();
    await drawer.getByRole("button", { name: `恢复任务 ${identifier}`, exact: true }).click();
    await expect(
      drawer.getByRole("button", { name: `恢复任务 ${identifier}`, exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "关闭其他任务", exact: true }).click();
    await expect(page.getByTestId(`task-card-${identifier}`)).toBeVisible();
  });
}
