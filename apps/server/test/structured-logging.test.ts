import { Writable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { AppError } from "../src/app-error.js";
import { loadConfig } from "../src/config.js";
import { initializeDatabase } from "../src/modules/database/index.js";
import { createLoggerOptions } from "../src/modules/operations/index.js";

const apps: ReturnType<typeof createApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe("structured logging", () => {
  it("uses request correlation and redacts sensitive headers and fields", async () => {
    let output = "";
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const secret = "super-secret-value";
    const app = createApp({
      config: loadConfig({ LARK_CODEX_ENV: "test" }),
      database: initializeDatabase(":memory:"),
      logger: createLoggerOptions("info", "public-http", stream),
    });
    app.get("/explode", async () => {
      throw new Error(`upstream failed with token=${secret}`);
    });
    app.get("/app-error", async () => {
      throw new AppError("INTERNAL_ERROR", 500, `storage failed with token=${secret}`);
    });
    apps.push(app);
    app.log.info({ claimSecret: secret, token: secret }, "CLI authentication fields");

    const response = await app.inject({
      method: "GET",
      url: "/explode",
      headers: {
        host: "127.0.0.1:47823",
        authorization: `Bearer ${secret}`,
        cookie: `session=${secret}`,
        "x-request-id": "logging-request-0001",
      },
    });

    expect(response.headers["x-request-id"]).toBe("logging-request-0001");
    expect(response.json().error.requestId).toBe("logging-request-0001");
    expect(response.statusCode).toBe(500);
    expect(output).not.toContain(secret);
    expect(output).toContain("public-http");
    expect(output).toContain('"errorType":"Error"');

    const appErrorResponse = await app.inject({
      method: "GET",
      url: "/app-error",
      headers: { host: "127.0.0.1:47823", "x-request-id": "logging-request-0002" },
    });
    expect(appErrorResponse.statusCode).toBe(500);
    expect(JSON.stringify(appErrorResponse.json())).not.toContain(secret);
    expect(output).not.toContain(secret);
    expect(output).toContain('"appErrorCode":"INTERNAL_ERROR"');
    expect(output).toContain('"route":"/app-error"');
  });
});
