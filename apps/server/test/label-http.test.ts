import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { initializeDatabase } from "../src/modules/database/index.js";

const apps: FastifyInstance[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function cookies(response: Awaited<ReturnType<FastifyInstance["inject"]>>): string {
  return response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

describe("global label HTTP routes", () => {
  it("supports authenticated reads and CSRF/idempotency-protected admin CRUD", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "lark-codex-label-http-"));
    directories.push(dataDirectory);
    const config = loadConfig({
      LARK_CODEX_ENV: "test",
      LARK_CODEX_DATA_DIR: dataDirectory,
    });
    const app = createApp({ config, database: initializeDatabase(":memory:") });
    apps.push(app);
    const trusted = { host: "127.0.0.1:47823", origin: "http://localhost:5173" };
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/development",
      headers: trusted,
    });
    const cookie = cookies(login);
    const csrf = login.json().data.csrfToken as string;

    const initial = await app.inject({
      method: "GET",
      url: "/api/v1/labels",
      headers: { host: trusted.host, cookie },
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().data).toEqual({ labels: [] });

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/labels",
      headers: {
        ...trusted,
        cookie,
        "x-csrf-token": csrf,
        "idempotency-key": "label-http-create",
      },
      payload: { name: "前端" },
    });
    expect(created.statusCode, JSON.stringify(created.json())).toBe(201);
    expect(created.json().data).toMatchObject({ name: "前端", version: 1, sortOrder: 0 });
    const labelId = created.json().data.id as string;

    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/v1/labels/${labelId}`,
      headers: {
        ...trusted,
        cookie,
        "x-csrf-token": csrf,
        "idempotency-key": "label-http-update",
      },
      payload: { expectedVersion: 1, name: "界面" },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().data).toMatchObject({ name: "界面", version: 2 });

    const reordered = await app.inject({
      method: "PUT",
      url: "/api/v1/labels/order",
      headers: {
        ...trusted,
        cookie,
        "x-csrf-token": csrf,
        "idempotency-key": "label-http-reorder",
      },
      payload: { labelIds: [labelId] },
    });
    expect(reordered.statusCode).toBe(200);
    expect(reordered.json().data.labels).toHaveLength(1);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/labels/${labelId}`,
      headers: {
        ...trusted,
        cookie,
        "x-csrf-token": csrf,
        "idempotency-key": "label-http-delete",
      },
      payload: { expectedVersion: 2 },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().data).toEqual({ labelId });
  });
});
