import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire("/app/package.json");
const Database = require("better-sqlite3");
const { WebAccountService } =
  await import("/app/apps/server/dist/modules/identity/web-account-service.js");
const origin = "https://devboard.example.test";
const proxyBase = process.env.DEVBOARD_SMOKE_PROXY_URL ?? "https://devboard.example.test";
const username = `ci${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const password = randomUUID() + randomUUID();
const requestHeaders = { origin };

const database = new Database(
  join(process.env.DEVBOARD_DATA_DIR ?? "/var/lib/devboard", "taskboard.sqlite"),
);
try {
  await new WebAccountService(database).create({
    username,
    name: "Disposable proxy test",
    password,
  });
} finally {
  database.close();
}

async function request(path, options = {}) {
  return fetch(new URL(path, proxyBase), {
    ...options,
    headers: { ...requestHeaders, ...(options.headers ?? {}) },
  });
}

const login = await request("/api/v1/auth/web/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username, password }),
});
if (login.status !== 201) throw new Error(`proxied Web login failed (HTTP ${login.status})`);
const cookies = login.headers.getSetCookie?.() ?? [login.headers.get("set-cookie") ?? ""];
const sessionCookie = cookies.find((value) => value.startsWith("__Host-codexboard_session="));
const csrfCookie = cookies.find((value) => value.startsWith("__Host-codexboard_csrf="));
if (
  !sessionCookie ||
  !csrfCookie ||
  !/;\s*Secure(?:;|$)/i.test(sessionCookie) ||
  !/;\s*Secure(?:;|$)/i.test(csrfCookie)
) {
  throw new Error("HTTPS-origin login did not set Secure __Host session and CSRF cookies");
}
const cookieHeader = `${sessionCookie.split(";", 1)[0]}; ${csrfCookie.split(";", 1)[0]}`;
const csrfToken = (await login.json()).data?.csrfToken;
if (typeof csrfToken !== "string" || !csrfToken) {
  throw new Error("login did not return a CSRF token");
}

const projectKey = `P${randomUUID().replaceAll("-", "").slice(0, 4).toUpperCase()}`;
const projectResponse = await request("/api/v1/projects", {
  method: "POST",
  headers: {
    cookie: cookieHeader,
    "x-csrf-token": csrfToken,
    "idempotency-key": randomUUID(),
    "content-type": "application/json",
  },
  body: JSON.stringify({ projectKey, name: "Proxy SSE fixture", description: "ephemeral CI data" }),
});
if (projectResponse.status !== 201) {
  throw new Error(`proxied Project API failed (HTTP ${projectResponse.status})`);
}
const projectId = (await projectResponse.json()).data?.id;
if (typeof projectId !== "string") throw new Error("Project API did not return an id");

const eventUrl = `/api/v1/events?projectId=${encodeURIComponent(projectId)}&afterRevision=0`;
async function openEvents(lastEventId) {
  const controller = new AbortController();
  const response = await request(eventUrl, {
    headers: {
      cookie: cookieHeader,
      accept: "text/event-stream",
      ...(lastEventId ? { "last-event-id": lastEventId } : {}),
    },
    signal: controller.signal,
  });
  if (
    response.status !== 200 ||
    !response.headers.get("content-type")?.startsWith("text/event-stream")
  ) {
    controller.abort();
    throw new Error(`proxied SSE endpoint returned HTTP ${response.status}`);
  }
  if (
    !response.headers.get("cache-control")?.includes("no-cache") ||
    response.headers.get("x-accel-buffering") !== "no"
  ) {
    controller.abort();
    throw new Error("SSE response is missing no-cache/no-buffering headers");
  }
  return { controller, reader: response.body.getReader() };
}

async function readUntil(reader, textToFind) {
  let accumulated = "";
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("SSE event timed out")), 8_000);
  });
  try {
    while (!accumulated.includes(textToFind) && accumulated.length < 128_000) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next.done) break;
      accumulated += Buffer.from(next.value).toString("utf8");
    }
    if (!accumulated.includes(textToFind)) {
      throw new Error(`SSE stream did not deliver ${textToFind}`);
    }
    return accumulated;
  } finally {
    clearTimeout(timer);
  }
}

const first = await openEvents();
try {
  const initial = await readUntil(first.reader, "event: project.created");
  if (!initial.includes("retry:")) {
    throw new Error("SSE retry directive was not delivered through the proxy");
  }
  const projectEventId = /^id: (\d+)$/m.exec(initial)?.[1];
  if (!projectEventId) throw new Error("SSE project event did not include a replay cursor");

  const taskResponse = await request("/api/v1/tasks", {
    method: "POST",
    headers: {
      cookie: cookieHeader,
      "x-csrf-token": csrfToken,
      "idempotency-key": randomUUID(),
      "content-type": "application/json",
    },
    body: JSON.stringify({ projectId, title: "Live proxied SSE event", status: "todo" }),
  });
  if (taskResponse.status !== 201) {
    throw new Error(`proxied Task API failed (HTTP ${taskResponse.status})`);
  }
  await readUntil(first.reader, "event: task.created");
  await first.reader.cancel();

  const reconnect = await openEvents(projectEventId);
  try {
    const replay = await readUntil(reconnect.reader, "event: task.created");
    if (!replay.includes("id:")) throw new Error("SSE replay did not include an event cursor");
    await readUntil(reconnect.reader, ": heartbeat ");
  } finally {
    reconnect.controller.abort();
    await reconnect.reader.cancel().catch(() => undefined);
  }
} finally {
  first.controller.abort();
  await first.reader.cancel().catch(() => undefined);
}

process.stdout.write(
  "TLS proxy, Secure cookies, authenticated Project/Task API, live SSE and replay verified\n",
);
