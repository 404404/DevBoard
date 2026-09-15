import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RuntimeDescriptor } from "@codexboard/contracts";
import { describe, expect, it } from "vitest";

import { defaultTaskctlDependencies, runTaskctl, type TaskctlDependencies } from "./index";
import { runtimeScope } from "./auth.js";

const descriptor: RuntimeDescriptor = {
  descriptorVersion: 1,
  pid: 42,
  generatedAt: "2026-08-31T00:00:00.000Z",
  publicBaseUrl: "http://127.0.0.1:47823",
  localAdminBaseUrl: "http://127.0.0.1:47824",
  capabilityToken: "x".repeat(43),
};

function harness(response: Response = Response.json({ data: { ok: true } })) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const dependencies: TaskctlDependencies = {
    readRuntimeDescriptor: async () => descriptor,
    credentials: {
      read: async () => null,
      write: async () => undefined,
      remove: async () => undefined,
    },
    authFile: () => "/tmp/taskctl-test-auth",
    now: () => Date.parse("2026-09-09T00:00:00Z"),
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return response;
    },
    readFile: async () => new Uint8Array([1, 2, 3]),
    writeFile: async () => undefined,
    cwd: () => "/workspace/caller",
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
  };
  return { calls, stdout, stderr, dependencies };
}

describe("runTaskctl", () => {
  it.each([
    [
      ["comment", "add", "--task", "task-id", "--body", "进度"],
      "POST",
      "/tasks/task-id/comments",
      { body: "进度" },
    ],
    [
      ["comment", "update", "comment-id", "--version", "1", "--body", "修改"],
      "PATCH",
      "/comments/comment-id",
      { expectedVersion: 1, body: "修改" },
    ],
    [
      ["comment", "delete", "comment-id", "--version", "1"],
      "DELETE",
      "/comments/comment-id",
      { expectedVersion: 1 },
    ],
  ])(
    "attributes requested comment operations to the paired session: %j",
    async (args, method, path, body) => {
      const test = harness();
      expect(await runTaskctl(args, test.dependencies)).toBe(1);
      expect(test.calls).toHaveLength(0);
      test.dependencies.credentials.read = async () =>
        JSON.stringify({
          scope: runtimeScope(descriptor),
          token: "paired-session",
          identity: { kind: "feishu", tenantKey: "tenant", userId: "user" },
          expiresAt: "2099-01-01T00:00:00Z",
        });
      expect(await runTaskctl(args, test.dependencies)).toBe(0);
      expect(test.calls[0]?.url).toBe(`${descriptor.localAdminBaseUrl}/api/v1/local${path}`);
      expect(test.calls[0]?.init?.method).toBe(method);
      expect(JSON.parse(String(test.calls[0]?.init?.body))).toEqual(body);
      expect(new Headers(test.calls[0]?.init?.headers).get("X-Taskctl-Session")).toBe(
        "paired-session",
      );
    },
  );

  it("rejects user bootstrap without contacting the service", async () => {
    const test = harness();
    expect(
      await runTaskctl(
        [
          "member",
          "bootstrap",
          "--project",
          "p",
          "--tenant",
          "tenant",
          "--user-id",
          "fake",
          "--name",
          "Fake",
          "--role",
          "owner",
        ],
        test.dependencies,
      ),
    ).toBe(2);
    expect(test.calls).toHaveLength(0);
  });

  it.each(["author", "author-id", "source"])(
    "rejects caller-selected comment attribution: %s",
    async (field) => {
      const test = harness();
      expect(
        await runTaskctl(
          ["comment", "add", "--task", "t", "--body", "评论", `--${field}`, "codex"],
          test.dependencies,
        ),
      ).toBe(2);
      expect(test.calls).toHaveLength(0);
    },
  );

  it.each([
    [["context"], "GET", "/api/v1/local/context"],
    [["project", "list"], "GET", "/api/v1/local/projects"],
    [["member", "audit"], "GET", "/api/v1/local/members/audit"],
    [
      ["issue", "list", "--project", "project-id"],
      "GET",
      "/api/v1/local/projects/project-id/board",
    ],
    [["issue", "get", "task-id"], "GET", "/api/v1/local/tasks/task-id/workspace"],
    [["job", "list", "--task", "task-id"], "GET", "/api/v1/local/tasks/task-id/jobs"],
    [["interaction", "list", "--job", "job-id"], "GET", "/api/v1/local/jobs/job-id/interactions"],
  ])("routes %j through the local HTTP adapter", async (argv, method, path) => {
    const test = harness();
    expect(await runTaskctl(argv, test.dependencies)).toBe(0);
    expect(test.calls).toHaveLength(1);
    expect(test.calls[0]).toMatchObject({ url: `${descriptor.localAdminBaseUrl}${path}` });
    expect(test.calls[0]?.init?.method ?? "GET").toBe(method);
    expect(new Headers(test.calls[0]?.init?.headers).get("authorization")).toBe(
      `Bearer ${descriptor.capabilityToken}`,
    );
    if (argv[0] === "context") {
      expect(new Headers(test.calls[0]?.init?.headers).get("x-taskctl-cwd")).toBe(
        encodeURIComponent("/workspace/caller"),
      );
    }
    expect(JSON.parse(test.stdout.join(""))).toEqual({ data: { ok: true } });
  });

  it("shows help without a running service", async () => {
    const test = harness();
    expect(
      await runTaskctl(["--help"], {
        ...test.dependencies,
        readRuntimeDescriptor: async () => {
          throw new Error("offline");
        },
      }),
    ).toBe(0);
    expect(test.stdout.join("")).toContain("issue archive");
    expect(test.calls).toHaveLength(0);
  });

  it.each([
    [["health"], "GET", "/health", undefined],
    [["backup", "create"], "POST", "/backups", {}],
    [["project", "dashboard", "p"], "GET", "/projects/p/dashboard", undefined],
    [["project", "options", "p"], "GET", "/projects/p/task-creation-options", undefined],
    [
      ["issue", "archive", "t", "--version", "2"],
      "POST",
      "/tasks/t/archive",
      { expectedVersion: 2 },
    ],
    [
      ["issue", "restore", "t", "--version", "3"],
      "POST",
      "/tasks/t/restore",
      { expectedVersion: 3 },
    ],
    [["issue", "read", "t"], "POST", "/tasks/t/read", {}],
    [["lifecycle", "get", "t"], "GET", "/tasks/t/lifecycle", undefined],
    [
      ["lifecycle", "request", "t", "--version", "4", "--status", "canceled"],
      "POST",
      "/tasks/t/lifecycle",
      { expectedVersion: 4, targetStatus: "canceled" },
    ],
    [
      ["relation", "add", "--task", "t", "--target", "u", "--type", "blocks"],
      "POST",
      "/tasks/t/relations",
      { targetTaskId: "u", relationType: "blocks" },
    ],
    [["relation", "delete", "r", "--task", "t"], "DELETE", "/tasks/t/relations/r", {}],
    [["attachment", "delete", "a"], "DELETE", "/attachments/a", {}],
    [["job", "get", "j"], "GET", "/jobs/j", undefined],
    [["label", "list"], "GET", "/labels", undefined],
    [["label", "create", "--name", "Bug"], "POST", "/labels", { name: "Bug" }],
    [
      ["label", "update", "l", "--name", "Fix", "--version", "2"],
      "PATCH",
      "/labels/l",
      { name: "Fix", expectedVersion: 2 },
    ],
    [["label", "delete", "l", "--version", "3"], "DELETE", "/labels/l", { expectedVersion: 3 }],
    [["label", "order", "--ids", "b,a"], "PUT", "/labels/order", { labelIds: ["b", "a"] }],
    [["git", "list", "--project", "p"], "GET", "/projects/p/git", undefined],
    [
      [
        "git",
        "create",
        "--project",
        "p",
        "--kind",
        "branch",
        "--branch",
        "feature/a",
        "--base",
        "main",
      ],
      "POST",
      "/projects/p/git",
      { kind: "branch", branch: "feature/a", baseBranch: "main" },
    ],
  ])("supports existing feature %j", async (argv, method, path, body) => {
    const test = harness();
    expect(await runTaskctl(argv as string[], test.dependencies)).toBe(0);
    expect(test.calls[0]?.url).toBe(`${descriptor.localAdminBaseUrl}/api/v1/local${path}`);
    expect(test.calls[0]?.init?.method).toBe(method);
    expect(
      test.calls[0]?.init?.body === undefined
        ? undefined
        : JSON.parse(String(test.calls[0]?.init?.body)),
    ).toEqual(body);
  });

  it("passes comment upload metadata and validates booleans", async () => {
    const upload = harness();
    expect(
      await runTaskctl(
        [
          "attachment",
          "upload",
          "--task",
          "t",
          "--file",
          "file.txt",
          "--comment",
          "c",
          "--pending",
          "true",
        ],
        upload.dependencies,
      ),
    ).toBe(0);
    const headers = new Headers(upload.calls[0]?.init?.headers);
    expect(headers.get("x-comment-id")).toBe("c");
    expect(headers.get("x-pending-comment")).toBe("1");
    const invalid = harness();
    expect(
      await runTaskctl(
        ["attachment", "upload", "--task", "t", "--file", "file.txt", "--pending", "maybe"],
        invalid.dependencies,
      ),
    ).toBe(2);
    expect(invalid.calls).toHaveLength(0);
  });

  it("encodes event cursors and preserves Git deletion guards", async () => {
    const events = harness();
    expect(
      await runTaskctl(
        ["events", "list", "--project", "p", "--after", "0", "--limit", "2"],
        events.dependencies,
      ),
    ).toBe(0);
    expect(events.calls[0]?.url).toContain("/events?projectId=p&afterRevision=0&limit=2");
    const git = harness();
    expect(
      await runTaskctl(
        ["git", "delete", "--project", "p", "--branch", "feature/a", "--head", "a".repeat(40)],
        git.dependencies,
      ),
    ).toBe(0);
    expect(JSON.parse(String(git.calls[0]?.init?.body))).toEqual({
      branch: "feature/a",
      path: null,
      expectedHead: "a".repeat(40),
    });
  });

  it("rejects clearing the current user's task ownership", async () => {
    const test = harness();
    expect(
      await runTaskctl(
        ["issue", "update", "t", "--version", "1", "--assignee", "null"],
        test.dependencies,
      ),
    ).toBe(2);
    expect(test.calls).toHaveLength(0);
  });

  it("clears optional task fields and rejects attachment-only comments", async () => {
    const test = harness();
    expect(
      await runTaskctl(
        [
          "issue",
          "update",
          "t",
          "--version",
          "2",
          "--due",
          "null",
          "--labels",
          "",
          "--description",
          "",
        ],
        test.dependencies,
      ),
    ).toBe(0);
    expect(JSON.parse(String(test.calls[0]?.init?.body))).toEqual({
      expectedVersion: 2,
      dueAt: null,
      labels: [],
      description: "",
    });
    const comment = harness();
    expect(
      await runTaskctl(
        ["comment", "add", "--task", "t", "--attachments", "a,b"],
        comment.dependencies,
      ),
    ).toBe(2);
    expect(comment.calls).toHaveLength(0);
  });

  it("deletes a task with an explicit current version and idempotency key", async () => {
    const test = harness();
    expect(
      await runTaskctl(["issue", "delete", "task-id", "--version", "3"], test.dependencies),
    ).toBe(0);
    expect(test.calls[0]?.init?.method).toBe("DELETE");
    expect(test.calls[0]?.url).toBe(`${descriptor.localAdminBaseUrl}/api/v1/local/tasks/task-id`);
    expect(JSON.parse(String(test.calls[0]?.init?.body))).toEqual({ expectedVersion: 3 });
    expect(new Headers(test.calls[0]?.init?.headers).get("idempotency-key")).toMatch(
      /^[0-9a-f-]{36}$/,
    );
    const missing = harness();
    expect(await runTaskctl(["issue", "delete", "task-id"], missing.dependencies)).toBe(2);
    expect(missing.calls).toHaveLength(0);
  });

  it("sends optimistic versions, idempotency keys and JSON bodies", async () => {
    const test = harness();
    const code = await runTaskctl(
      ["issue", "move", "task-id", "--version", "3", "--status", "in_review"],
      test.dependencies,
    );
    expect(code).toBe(0);
    const request = test.calls[0];
    expect(request).toMatchObject({
      url: `${descriptor.localAdminBaseUrl}/api/v1/local/tasks/task-id/move`,
      init: { method: "POST" },
    });
    expect(JSON.parse(String(request?.init?.body))).toEqual({
      expectedVersion: 3,
      targetStatus: "in_review",
    });
    expect(new Headers(request?.init?.headers).get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it.each(["create", "update", "archive", "register"])(
    "rejects removed project %s commands before making a request",
    async (action) => {
      const test = harness();
      expect(await runTaskctl(["project", action, "project-id"], test.dependencies)).toBe(2);
      expect(test.calls).toHaveLength(0);
      expect(test.stderr.join("")).toMatch(/未知命令/);
    },
  );

  it("supports attachments and interaction responses", async () => {
    const attachment = harness();
    await runTaskctl(
      ["attachment", "upload", "--task", "task-id", "--file", "/tmp/evidence.txt"],
      attachment.dependencies,
    );
    expect(attachment.calls[0]?.init?.body).toBeInstanceOf(Uint8Array);
    expect(new Headers(attachment.calls[0]?.init?.headers).get("x-filename")).toBe("evidence.txt");
    expect(new Headers(attachment.calls[0]?.init?.headers).get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(new Headers(attachment.calls[0]?.init?.headers).get("x-content-type")).toBe(
      "text/plain",
    );
    for (const [path, expectedType] of [
      ["/tmp/evidence.json", "application/json"],
      ["/tmp/evidence.csv", "text/csv"],
    ] as const) {
      const typedAttachment = harness();
      await runTaskctl(
        ["attachment", "upload", "--task", "task-id", "--file", path],
        typedAttachment.dependencies,
      );
      expect(new Headers(typedAttachment.calls[0]?.init?.headers).get("x-content-type")).toBe(
        expectedType,
      );
    }

    const interaction = harness();
    await runTaskctl(
      ["interaction", "respond", "interaction-id", "--decision", "accept"],
      interaction.dependencies,
    );
    expect(JSON.parse(String(interaction.calls[0]?.init?.body))).toEqual({ type: "accept" });
  });

  it("returns deterministic error and usage exit codes", async () => {
    const apiError = harness(
      Response.json({ error: { code: "VERSION_CONFLICT", message: "版本冲突" } }, { status: 409 }),
    );
    expect(await runTaskctl(["context"], apiError.dependencies)).toBe(1);
    expect(JSON.parse(apiError.stderr.join(""))).toMatchObject({
      error: { code: "VERSION_CONFLICT", message: "版本冲突", status: 409 },
    });

    const usage = harness();
    expect(await runTaskctl(["unknown"], usage.dependencies)).toBe(2);
    expect(JSON.parse(usage.stderr.join(""))).toMatchObject({ error: { code: "USAGE_ERROR" } });
  });

  it("encodes non-ASCII caller working directories for HTTP headers", async () => {
    const test = harness();
    const cwd = "/工作区/飞书任务看板";
    const code = await runTaskctl(["context"], { ...test.dependencies, cwd: () => cwd });
    expect(code).toBe(0);
    expect(new Headers(test.calls[0]?.init?.headers).get("x-taskctl-cwd")).toBe(
      encodeURIComponent(cwd),
    );
  });
});

it("creates the task-owned download directory before writing attachment bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "taskctl-download-"));
  try {
    const output = join(root, ".tmp", "taskboard", "task-id", "attachment.txt");
    await defaultTaskctlDependencies().writeFile(output, new Uint8Array([65, 66]));
    expect(await readFile(output, "utf8")).toBe("AB");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

describe("CLI user authentication", () => {
  const identity = { kind: "feishu", tenantKey: "tenant", userId: "user" };
  const expiresAt = "2026-09-09T08:00:00Z";
  function authHarness() {
    const test = harness();
    const files = new Map<string, string>();
    const responses: Response[] = [];
    test.dependencies = {
      ...test.dependencies,
      credentials: {
        read: async (path) => files.get(path) ?? null,
        write: async (path, value) => {
          files.set(path, value);
        },
        remove: async (path) => {
          files.delete(path);
        },
      },
      fetch: async (url, init) => {
        test.calls.push({ url: String(url), init });
        return responses.shift() ?? Response.json({ data: { identity } });
      },
    };
    return { ...test, files, responses };
  }
  it("pairs, saves secrets privately, authenticates ordinary requests and revokes on logout", async () => {
    const test = authHarness();
    const verificationUrl = "http://127.0.0.1:47823/?taskctlLogin=request";
    test.responses.push(
      Response.json({
        data: {
          requestId: "request",
          claimSecret: "private-claim",
          verificationCode: "1234ABCD",
          verificationUrl,
          expiresAt,
        },
      }),
    );
    expect(await runTaskctl(["auth", "login", "--label", "My terminal"], test.dependencies)).toBe(
      0,
    );
    expect(JSON.parse(String(test.calls[0]?.init?.body))).toEqual({ label: "My terminal" });
    expect(test.stdout.join("")).not.toContain("private-claim");
    expect(test.files.size).toBe(1);
    expect([...test.files.values()][0]).toContain("private-claim");
    test.responses.push(Response.json({ data: { token: "private-session", identity, expiresAt } }));
    expect(await runTaskctl(["auth", "complete"], test.dependencies)).toBe(0);
    expect(JSON.parse(String(test.calls[1]?.init?.body))).toEqual({
      requestId: "request",
      claimSecret: "private-claim",
    });
    expect(test.files.size).toBe(1);
    expect([...test.files.values()][0]).toContain("private-session");
    expect(test.stdout.join("")).not.toContain("private-session");
    expect(await runTaskctl(["context"], test.dependencies)).toBe(0);
    expect(new Headers(test.calls[2]?.init?.headers).get("x-taskctl-session")).toBe(
      "private-session",
    );
    expect(test.calls[2]?.init?.redirect).toBe("error");
    expect(await runTaskctl(["auth", "status"], test.dependencies)).toBe(0);
    expect(JSON.parse(test.stdout.at(-1)!)).toEqual({ data: { identity } });
    expect(await runTaskctl(["auth", "logout"], test.dependencies)).toBe(0);
    expect(new Headers(test.calls[4]?.init?.headers).get("x-taskctl-session")).toBe(
      "private-session",
    );
    expect(test.files.size).toBe(0);
  });
  it("keeps a session when server revocation fails and refuses silent fallback on server expiry", async () => {
    const test = authHarness();
    test.responses.push(
      Response.json({
        data: {
          requestId: "r",
          claimSecret: "private-claim",
          verificationCode: "1234ABCD",
          verificationUrl: "http://127.0.0.1:47823/?taskctlLogin=r",
          expiresAt,
        },
      }),
    );
    await runTaskctl(["auth", "login", "--label", "terminal"], test.dependencies);
    test.responses.push(Response.json({ data: { token: "private-session", identity, expiresAt } }));
    await runTaskctl(["auth", "complete"], test.dependencies);
    test.responses.push(
      Response.json(
        { error: { code: "CLI_AUTH_SESSION_INVALID", message: "echo private-session" } },
        { status: 401 },
      ),
    );
    expect(await runTaskctl(["context"], test.dependencies)).toBe(1);
    expect(test.stderr.join("")).not.toContain("private-session");
    test.responses.push(
      Response.json(
        { error: { code: "CLI_AUTH_SESSION_INVALID", message: "echo private-session" } },
        { status: 500 },
      ),
    );
    expect(await runTaskctl(["auth", "logout"], test.dependencies)).toBe(1);
    expect(test.files.size).toBe(1);
  });
  it("does not display claim secrets smuggled into a verification URL", async () => {
    const test = authHarness();
    test.responses.push(
      Response.json({
        data: {
          requestId: "r",
          claimSecret: "private-claim",
          verificationCode: "1234ABCD",
          verificationUrl: "http://127.0.0.1:47823/?taskctlLogin=r&claimSecret=private-claim",
          expiresAt,
        },
      }),
    );
    expect(await runTaskctl(["auth", "login", "--label", "terminal"], test.dependencies)).toBe(1);
    expect(test.stdout.join("")).not.toContain("private-claim");
    expect(test.files.size).toBe(0);
  });
  it("clears expired or restart-invalidated sessions on explicit logout", async () => {
    for (const expired of [true, false]) {
      const test = authHarness();
      test.responses.push(
        Response.json({
          data: {
            requestId: "r",
            claimSecret: "private-claim",
            verificationCode: "1234ABCD",
            verificationUrl: "http://127.0.0.1:47823/?taskctlLogin=r",
            expiresAt,
          },
        }),
      );
      await runTaskctl(["auth", "login", "--label", "terminal"], test.dependencies);
      test.responses.push(
        Response.json({ data: { token: "private-session", identity, expiresAt } }),
      );
      await runTaskctl(["auth", "complete"], test.dependencies);
      test.responses.push(Response.json({ error: { code: "UNAUTHENTICATED" } }, { status: 401 }));
      expect(
        await runTaskctl(["auth", "logout"], {
          ...test.dependencies,
          ...(expired ? { now: () => Date.parse(expiresAt) } : {}),
        }),
      ).toBe(0);
      expect(new Headers(test.calls.at(-1)?.init?.headers).get("x-taskctl-session")).toBe(
        "private-session",
      );
      expect(test.files.size).toBe(0);
    }
  });
  it("cancels pending-only login and succeeds when already logged out", async () => {
    const test = authHarness();
    test.responses.push(
      Response.json({
        data: {
          requestId: "r",
          claimSecret: "private-claim",
          verificationCode: "1234ABCD",
          verificationUrl: "http://127.0.0.1:47823/?taskctlLogin=r",
          expiresAt,
        },
      }),
    );
    await runTaskctl(["auth", "login", "--label", "terminal"], test.dependencies);
    expect(test.files.size).toBe(1);
    const calls = test.calls.length;
    expect(await runTaskctl(["auth", "logout"], test.dependencies)).toBe(0);
    expect(test.files.size).toBe(0);
    expect(await runTaskctl(["auth", "logout"], test.dependencies)).toBe(0);
    expect(test.calls.length).toBe(calls);
  });
  it("keeps a pending request for later completion", async () => {
    const test = authHarness();
    test.responses.push(
      Response.json({
        data: {
          requestId: "r",
          claimSecret: "secret",
          verificationCode: "1234ABCD",
          verificationUrl: "http://127.0.0.1:47823/?taskctlLogin=r",
          expiresAt,
        },
      }),
    );
    await runTaskctl(["auth", "login", "--label", "terminal"], test.dependencies);
    test.responses.push(Response.json({ data: { status: "pending" } }));
    expect(await runTaskctl(["auth", "complete"], test.dependencies)).toBe(1);
    expect(test.files.size).toBe(1);
    expect(test.stderr.join("")).toContain("CLI_AUTH_PENDING");
  });
  it("rejects corrupt or expired credentials without a service fallback", async () => {
    const test = authHarness();
    test.responses.push(
      Response.json({
        data: {
          requestId: "r",
          claimSecret: "secret",
          verificationCode: "1234ABCD",
          verificationUrl: "http://127.0.0.1:47823/?taskctlLogin=r",
          expiresAt,
        },
      }),
    );
    await runTaskctl(["auth", "login", "--label", "terminal"], test.dependencies);
    test.responses.push(Response.json({ data: { token: "private-session", identity, expiresAt } }));
    await runTaskctl(["auth", "complete"], test.dependencies);
    const before = test.calls.length;
    expect(
      await runTaskctl(["context"], { ...test.dependencies, now: () => Date.parse(expiresAt) }),
    ).toBe(1);
    expect(test.calls.length).toBe(before);
    const file = [...test.files.keys()][0]!;
    test.files.set(file, "{bad secret}");
    expect(await runTaskctl(["context"], test.dependencies)).toBe(1);
    expect(test.calls.length).toBe(before);
    expect(test.stderr.join("")).not.toContain("bad secret");
  });
  it.each([
    "https://evil.example",
    "http://127.0.0.1@evil.example",
    "http://user:password@127.0.0.1",
    "http://127.0.0.1/#fragment",
    "http://127.0.0.1/path",
    "ftp://127.0.0.1",
  ])(
    "rejects unsafe local endpoint %s before reading credentials or fetching",
    async (localAdminBaseUrl) => {
      const test = authHarness();
      let read = false;
      expect(
        await runTaskctl(["context"], {
          ...test.dependencies,
          readRuntimeDescriptor: async () => ({ ...descriptor, localAdminBaseUrl }),
          credentials: {
            ...test.dependencies.credentials,
            read: async () => {
              read = true;
              return null;
            },
          },
        }),
      ).toBe(1);
      expect(read).toBe(false);
      expect(test.calls).toHaveLength(0);
    },
  );
  it("sends natural-key assignees, requires tenant and omits unset creation assignee", async () => {
    const test = authHarness();
    expect(
      await runTaskctl(
        [
          "issue",
          "create",
          "--project",
          "p",
          "--title",
          "Task",
          "--assignee",
          "user",
          "--tenant",
          "tenant",
        ],
        test.dependencies,
      ),
    ).toBe(0);
    expect(JSON.parse(String(test.calls[0]?.init?.body)).assigneeIdentity).toEqual(identity);
    expect(
      await runTaskctl(["issue", "create", "--project", "p", "--title", "Task"], test.dependencies),
    ).toBe(0);
    expect(JSON.parse(String(test.calls[1]?.init?.body))).not.toHaveProperty("assigneeIdentity");
    expect(
      await runTaskctl(
        ["issue", "update", "t", "--version", "1", "--assignee", "user"],
        test.dependencies,
      ),
    ).toBe(2);
    expect(test.calls).toHaveLength(2);
  });
});

it("attaches the calling Codex thread to Git creation from its environment", async () => {
  const test = harness();
  const threadId = "11111111-1111-4111-8111-111111111111";
  expect(
    await runTaskctl(
      [
        "git",
        "create",
        "--project",
        "p",
        "--kind",
        "branch",
        "--branch",
        "feature/codex",
        "--base",
        "main",
      ],
      { ...test.dependencies, codexThreadId: () => threadId },
    ),
  ).toBe(0);
  expect(JSON.parse(String(test.calls[0]?.init?.body)).codexThreadId).toBe(threadId);
});
