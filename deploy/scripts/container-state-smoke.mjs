import { randomUUID, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const require = createRequire("/app/package.json");
const Database = require("better-sqlite3");
const dataDirectory = process.env.DEVBOARD_DATA_DIR ?? "/var/lib/devboard";
const database = new Database(join(dataDirectory, "taskboard.sqlite"), { timeout: 5_000 });
database.pragma("foreign_keys = ON");
const statePath = join(dataDirectory, "run", "container-smoke-state.json");
const mode = process.argv[2];

function insertBusinessData(projectKey, options = {}) {
  const projectId = randomUUID();
  const taskId = randomUUID();
  const commentId = randomUUID();
  const attachmentId = randomUUID();
  const storageKey = `${attachmentId.slice(0, 2)}/${attachmentId}`;
  const contents = Buffer.from(`container persistence fixture ${projectKey}\n`);
  const now = new Date().toISOString();
  const taskNumber = options.taskNumber ?? 1;
  const projectName = `Container smoke ${projectKey}`;
  const taskTitle = `Persistent task ${projectKey}`;
  const commentBody = `Persistent comment ${projectKey}`;
  const tx = database.transaction(() => {
    database
      .prepare("INSERT INTO projects (id, project_key, name, description) VALUES (?, ?, ?, ?)")
      .run(projectId, projectKey, projectName, "CI data-volume and backup acceptance");
    database
      .prepare(`INSERT INTO tasks (
        id, identifier, project_id, task_number, title, status
      ) VALUES (?, ?, ?, ?, ?, 'todo')`)
      .run(taskId, `${projectKey}-1`, projectId, taskNumber, taskTitle);
    database
      .prepare(`INSERT INTO comments (
        id, task_id, body, version, created_at, updated_at
      ) VALUES (?, ?, ?, 1, ?, ?)`)
      .run(commentId, taskId, commentBody, now, now);
    database
      .prepare(`INSERT INTO attachments (
        id, task_id, comment_id, filename, content_type, size_bytes, sha256, storage_key, created_at
      ) VALUES (?, ?, ?, ?, 'text/plain', ?, ?, ?, ?)`)
      .run(attachmentId, taskId, commentId, "smoke.txt", contents.length,
        createHash("sha256").update(contents).digest("hex"), storageKey, now);
  });
  tx();
  const attachmentPath = join(dataDirectory, "attachments", storageKey);
  mkdirSync(dirname(attachmentPath), { recursive: true, mode: 0o700 });
  writeFileSync(attachmentPath, contents, { mode: 0o600 });
  return {
    projectId,
    projectKey,
    projectName,
    taskId,
    taskTitle,
    commentId,
    commentBody,
    attachmentId,
    storageKey,
    attachmentText: contents.toString(),
  };
}

try {
  if (mode === "seed") {
    const fixture = insertBusinessData(
      `CI${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`,
    );
    mkdirSync(join(dataDirectory, "run"), { recursive: true, mode: 0o700 });
    writeFileSync(statePath, `${JSON.stringify({ fixture }, null, 2)}\n`, { mode: 0o600 });
    const identityCount = database.prepare("SELECT COUNT(*) FROM identities").pluck().get();
    const webAccountCount = database.prepare("SELECT COUNT(*) FROM web_accounts").pluck().get();
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    state.identityCount = identityCount;
    state.webAccountCount = webAccountCount;
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    mkdirSync(join(dataDirectory, "ssh"), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(dataDirectory, "ssh", "known_hosts"),
      "devboard-smoke.invalid ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFdldmJvYXJkU21va2VIb3N0S2V5VGVzdDAx\n",
      { mode: 0o600 },
    );
    process.stdout.write("seeded project/task/comment/attachment and managed host-key state\n");
  } else if (mode === "mutate") {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const fixture = insertBusinessData(
      `CI${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`,
    );
    state.mutatedProjectKey = fixture.projectKey;
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write("mutated disposable data after online backup\n");
  } else if (mode === "verify") {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const fixture = state.fixture;
    const project = database
      .prepare("SELECT name FROM projects WHERE id = ? AND project_key = ?")
      .get(fixture.projectId, fixture.projectKey);
    const task = database
      .prepare("SELECT title FROM tasks WHERE id = ? AND project_id = ?")
      .get(fixture.taskId, fixture.projectId);
    const comment = database
      .prepare("SELECT body FROM comments WHERE id = ? AND task_id = ?")
      .get(fixture.commentId, fixture.taskId);
    const attachment = database
      .prepare(`SELECT filename, size_bytes, sha256, storage_key FROM attachments
        WHERE id = ? AND task_id = ?`)
      .get(fixture.attachmentId, fixture.taskId);
    const digest = createHash("sha256").update(fixture.attachmentText).digest("hex");
    if (
      project?.name !== fixture.projectName ||
      task?.title !== fixture.taskTitle ||
      comment?.body !== fixture.commentBody
    ) {
      throw new Error("business records were not restored from the backup");
    }
    if (
      attachment?.filename !== "smoke.txt" ||
      attachment.sha256 !== digest ||
      attachment.storage_key !== fixture.storageKey
    ) {
      throw new Error("attachment metadata was not restored from the backup");
    }
    if (
      readFileSync(join(dataDirectory, "attachments", fixture.storageKey), "utf8") !==
      fixture.attachmentText
    ) {
      throw new Error("attachment payload was not restored from the backup");
    }
    if (
      state.mutatedProjectKey &&
      database
        .prepare("SELECT 1 FROM projects WHERE project_key = ?")
        .get(state.mutatedProjectKey)
    ) {
      throw new Error("post-backup mutation unexpectedly survived restore");
    }
    const identity = database
      .prepare("SELECT 1 FROM identities WHERE identity_key = ?")
      .get('["service","local-admin"]');
    if (!identity) throw new Error("identity data is missing after restore");
    if (database.prepare("SELECT COUNT(*) FROM identities").pluck().get() !== state.identityCount) {
      throw new Error("identity records changed across restart/backup/restore");
    }
    if (
      database.prepare("SELECT COUNT(*) FROM web_accounts").pluck().get() !== state.webAccountCount
    ) {
      throw new Error("Web account data changed across restart/backup/restore");
    }
    const knownHosts = readFileSync(join(dataDirectory, "ssh", "known_hosts"), "utf8");
    if (!knownHosts.includes("devboard-smoke.invalid")) {
      throw new Error("managed known_hosts state was not persisted");
    }
    process.stdout.write(
      "business records, identity, attachment payload, backup restore and known_hosts persistence verified\n",
    );
  } else {
    throw new Error("usage: container-state-smoke.mjs seed|mutate|verify");
  }
} finally {
  database.close();
}
