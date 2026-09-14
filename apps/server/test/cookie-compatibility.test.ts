import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { initializeDatabase } from "../src/modules/database/index.js";
import { sessionCookieNames } from "../src/modules/identity/index.js";

describe("cookie brand compatibility", () => {
  it("selects one complete cookie generation, including empty new cookies", () => {
    const config = loadConfig({});
    expect(sessionCookieNames(config)).toEqual({
      session: "lark_codex_session",
      csrf: "lark_codex_csrf",
    });
    expect(sessionCookieNames(config, { lark_taskboard_session: "old" }).session).toBe(
      "lark_taskboard_session",
    );
    for (const cookie of ["lark_codex_session", "lark_codex_csrf"])
      expect(
        sessionCookieNames(config, { [cookie]: "", lark_taskboard_session: "old" }).session,
      ).toBe("lark_codex_session");
    expect(
      sessionCookieNames({ ...config, LARK_CODEX_ORIGIN: "https://board.example" }, {}),
    ).toEqual({
      session: "__Host-lark_taskboard_session",
      csrf: "__Host-lark_taskboard_csrf",
    });
  });

  it("reads legacy login cookies and clears both names at logout without falling back from new", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lark-codex-cookie-compat-"));
    const app = createApp({
      config: loadConfig({ LARK_CODEX_ENV: "test", LARK_CODEX_DATA_DIR: directory }),
      database: initializeDatabase(":memory:"),
    });
    try {
      const headers = { host: "127.0.0.1:47823", origin: "http://localhost:5173" };
      const login = await app.inject({ method: "POST", url: "/api/v1/auth/development", headers });
      expect(login.statusCode).toBe(201);
      expect(login.cookies.map(({ name }) => name).sort()).toEqual([
        "lark_codex_csrf",
        "lark_codex_session",
      ]);
      const legacyCookie = login.cookies
        .map(({ name, value }) => `${name.replace("lark_codex_", "lark_taskboard_")}=${value}`)
        .join("; ");
      const read = await app.inject({
        method: "GET",
        url: "/api/v1/session",
        headers: { ...headers, cookie: legacyCookie },
      });
      expect(read.statusCode).toBe(200);
      const blocked = await app.inject({
        method: "GET",
        url: "/api/v1/session",
        headers: { ...headers, cookie: `${legacyCookie}; lark_codex_session=` },
      });
      expect(blocked.statusCode).toBe(401);
      const logout = await app.inject({
        method: "POST",
        url: "/api/v1/session/logout",
        headers: {
          ...headers,
          cookie: legacyCookie,
          "x-csrf-token": login.json().data.csrfToken,
        },
      });
      expect(logout.statusCode).toBe(204);
      expect(logout.cookies.map(({ name }) => name).sort()).toEqual([
        "lark_codex_csrf",
        "lark_codex_session",
        "lark_taskboard_csrf",
        "lark_taskboard_session",
      ]);
    } finally {
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
