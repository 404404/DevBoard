import { mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { appControl, createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { identityKey } from "@codexboard/contracts";
import { seedFeishuTestActor, TEST_FEISHU_ACTOR } from "./helpers/identity.js";
import { initializeDatabase } from "../src/modules/database/index.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
it("allows verified Feishu members to manage Git while requiring authentication and CSRF", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "git-http-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "repo");
  mkdirSync(cwd);
  const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.test");
  writeFileSync(join(cwd, "README.md"), "test");
  git("add", ".");
  git("commit", "-m", "initial");
  const db = initializeDatabase(":memory:");
  const app = createApp({
    database: db,
    config: loadConfig({
      CODEXBOARD_ENV: "test",
      CODEXBOARD_DATA_DIR: root,
      CODEXBOARD_WORKSPACE_ROOTS: root,
    }),
  });
  cleanup.push(() => app.close());
  await app.ready();
  appControl(app).services.projectSync.reconcile({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    projects: [
      {
        codexProjectId: "11111111-1111-4111-8111-111111111111",
        name: "测试项目",
        rootPaths: [cwd],
        position: 0,
      },
    ],
  });
  const projectId = db
    .prepare("SELECT id FROM projects WHERE source_kind = 'codex'")
    .pluck()
    .get() as string;
  const url = `/api/v1/projects/${projectId}/git`;
  const trusted = { host: "127.0.0.1:47823", origin: "http://localhost:5173" };
  expect((await app.inject({ method: "GET", url, headers: trusted })).statusCode).toBe(401);
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/development",
    headers: trusted,
  });
  const member = { ...TEST_FEISHU_ACTOR, role: "member" as const };
  seedFeishuTestActor(db, member);
  db.prepare("UPDATE sessions SET identity_key = ?").run(identityKey(member.identity));
  const cookie = login.cookies.map((entry) => `${entry.name}=${entry.value}`).join("; ");
  const headers = { ...trusted, cookie, "x-csrf-token": login.json().data.csrfToken as string };
  const payload = {
    kind: "branch",
    branch: "feature/http",
    baseBranch: "main",
    codexThreadId: "11111111-1111-4111-8111-111111111111",
  };
  expect(
    (await app.inject({ method: "POST", url, headers: { ...trusted, cookie }, payload }))
      .statusCode,
  ).toBe(403);
  expect(
    (await app.inject({ method: "POST", url, headers, payload: { ...payload, branch: "--bad" } }))
      .statusCode,
  ).toBe(400);
  const create = await app.inject({ method: "POST", url, headers, payload });
  expect(create.statusCode, create.body).toBe(201);
  const view = await app.inject({ method: "GET", url, headers });
  const entry = view
    .json()
    .data.entries.find((item: { branch: string }) => item.branch === "feature/http");
  expect(entry).toMatchObject({ path: null, deleteReason: null });
  expect(entry.branchOrigin).toMatchObject({
    kind: "user",
    userName: member.name,
  });
  expect(entry.branchOrigin.threadId).toBeUndefined();
  const removed = await app.inject({
    method: "DELETE",
    url,
    headers,
    payload: { branch: entry.branch, path: null, expectedHead: entry.headSha },
  });
  expect(removed.statusCode, removed.body).toBe(200);
  const unverifiedKey = '["feishu","test-tenant","unverified"]';
  db.prepare(
    "INSERT INTO identities (identity_key,kind,tenant_key,user_id,name,role) VALUES (?, 'feishu', 'test-tenant', 'unverified', '自报管理员', 'admin')",
  ).run(unverifiedKey);
  db.prepare("UPDATE sessions SET identity_key = ?").run(unverifiedKey);
  expect((await app.inject({ method: "GET", url, headers })).statusCode).toBe(403);
});
