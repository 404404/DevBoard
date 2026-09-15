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
      session: "codexboard_session",
      csrf: "codexboard_csrf",
    });
    expect(sessionCookieNames(config, { lark_taskboard_session: "old" }).session).toBe(
      "lark_taskboard_session",
    );
    for (const cookie of ["codexboard_session", "codexboard_csrf"])
      expect(
        sessionCookieNames(config, { [cookie]: "", lark_taskboard_session: "old" }).session,
      ).toBe("codexboard_session");
    expect(
      sessionCookieNames({ ...config, CODEXBOARD_ORIGIN: "https://board.example" }, {}),
    ).toEqual({
      session: "__Host-codexboard_session",
      csrf: "__Host-codexboard_csrf",
    });
  });

  it.each(["lark_codex", "lark_taskboard"])(
    "reads %s cookies and clears all names without fallback from new",
    async (brand) => {
      const directory = mkdtempSync(join(tmpdir(), "codexboard-cookie-compat-"));
      const app = createApp({
        config: loadConfig({ CODEXBOARD_ENV: "test", CODEXBOARD_DATA_DIR: directory }),
        database: initializeDatabase(":memory:"),
      });
      try {
        const headers = { host: "127.0.0.1:47823", origin: "http://localhost:5173" };
        const login = await app.inject({
          method: "POST",
          url: "/api/v1/auth/development",
          headers,
        });
        expect(login.statusCode).toBe(201);
        expect(login.cookies.map(({ name }) => name).sort()).toEqual([
          "codexboard_csrf",
          "codexboard_session",
        ]);
        const legacyCookie = login.cookies
          .map(({ name, value }) => `${name.replace("codexboard_", `${brand}_`)}=${value}`)
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
          headers: { ...headers, cookie: `${legacyCookie}; codexboard_session=` },
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
          "codexboard_csrf",
          "codexboard_session",
          "lark_codex_csrf",
          "lark_codex_session",
          "lark_taskboard_csrf",
          "lark_taskboard_session",
        ]);
      } finally {
        await app.close();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
