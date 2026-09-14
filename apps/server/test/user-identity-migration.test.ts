import { afterEach, expect, it } from "vitest";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/modules/database/index.js";
import * as migrations from "../src/modules/database/migrations/index.js";

const databases: SqliteDatabase[] = [];
function legacyDatabase() {
  const db = openDatabase(":memory:");
  databases.push(db);
  runMigrations(
    db,
    migrations.CORE_MIGRATIONS.filter((migration) => migration.version <= 20),
  );
  return db;
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

it("installs the natural identity schema on an empty database", () => {
  const db = legacyDatabase();
  runMigrations(db, migrations.CORE_MIGRATIONS);
  expect(db.prepare("SELECT max(version) FROM schema_migrations").pluck().get()).toBe(22);
  expect(
    db
      .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='identities'")
      .pluck()
      .get(),
  ).toBe("identities");
});

it("refuses to silently invent a user ID when legacy identity mapping is absent", () => {
  const db = legacyDatabase();
  db.exec(
    "INSERT INTO actors(id,tenant_key,open_id,name,role) VALUES ('old-user','tenant','ou_old','User','member')",
  );
  expect(() => runMigrations(db, migrations.CORE_MIGRATIONS)).toThrow();
  expect(db.prepare("SELECT id FROM actors").pluck().get()).toBe("old-user");
  expect(db.prepare("SELECT max(version) FROM schema_migrations").pluck().get()).toBe(20);
  expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
});

const legacyUser = "10000000-0000-4000-8000-000000000001";
const legacyService = "00000000-0000-4000-8000-000000000001";
const userIdentity = { kind: "feishu", tenantKey: "tenant", userId: "u1" };
const userKey = '["feishu","tenant","u1"]';
const mapping = { legacyActorId: legacyUser, tenantKey: "tenant", openId: "ou_old", userId: "u1" };
function seedUser(db: SqliteDatabase, id = legacyUser, tenant = "tenant", open = "ou_old") {
  db.prepare(
    "INSERT INTO actors(id,tenant_key,open_id,name,role) VALUES (?,?,?,'User','member')",
  ).run(id, tenant, open);
}
function seedHistory(db: SqliteDatabase) {
  seedUser(db);
  db.exec(`
    INSERT INTO actors(id,tenant_key,open_id,name,role) VALUES ('${legacyService}','development-tenant','development-user','Local','admin');
    INSERT INTO projects(id,project_key,name,created_by) VALUES ('project','LEG','Project','${legacyUser}');
    INSERT INTO tasks(id,identifier,project_id,task_number,title,status,assignee_actor_id,creator_actor_id)
      VALUES ('task','LEG-1','project',1,'Title','todo','${legacyUser}','${legacyService}');
    INSERT INTO tasks(id,identifier,project_id,task_number,title,status) VALUES ('task2','LEG-2','project',2,'Title','todo');
    INSERT INTO sessions(id_hash,actor_id,csrf_hash,expires_at) VALUES ('session','${legacyUser}','csrf','2030-01-01');
    INSERT INTO project_members(project_id,actor_id,role) VALUES ('project','${legacyUser}','editor');
    INSERT INTO task_relations(id,project_id,type,source_task_id,target_task_id,created_by) VALUES ('relation','project','related','task','task2','${legacyUser}');
    INSERT INTO comments(id,task_id,author_id,body) VALUES ('comment','task','${legacyUser}','正文 ${legacyUser}');
    INSERT INTO attachments(id,task_id,uploader_id,filename,content_type,size_bytes,sha256,storage_key)
      VALUES ('attachment','task','${legacyUser}','a.txt','text/plain',1,'${"a".repeat(64)}','storage');
    INSERT INTO jobs(id,task_id,kind,status,execution_key,idempotency_key,requested_by) VALUES ('job','task','start','succeeded','exec','job-key','${legacyUser}');
    INSERT INTO job_events(id,job_id,seq,kind,summary) VALUES ('job-event','job',1,'done','done');
    INSERT INTO job_interactions(id,job_id,server_request_id,kind,safe_request_json,decided_by) VALUES ('interaction','job','request','user_input','{}','${legacyUser}');
    INSERT INTO task_reads(task_id,actor_id,last_read_version,read_at) VALUES ('task','${legacyUser}',1,'2026-09-01');
    INSERT INTO global_labels(id,name,sort_order,created_by) VALUES ('label','Label',0,'${legacyUser}');
    INSERT INTO task_delete_authorizations(task_id,resource_id,actor_id,created_at) VALUES ('task2','task2','${legacyUser}','2026-09-01');
    INSERT INTO task_delete_events(id,operation_id,task_id,actor_id,event_type,created_at) VALUES ('delete-event','delete-op','task','${legacyUser}','started','2026-09-01');
    INSERT INTO job_attachment_snapshots(id,job_id,task_id,original_attachment_id,uploader_id,filename,content_type,size_bytes,sha256,storage_key,created_at)
      VALUES ('snapshot','job','task','attachment','${legacyUser}','a.txt','text/plain',1,'${"a".repeat(64)}','storage','2026-09-01');
    INSERT INTO change_events(aggregate_type,aggregate_id,event_type,safe_payload_json) VALUES ('task','task','task.updated','{"taskId":"task"}');
  `);
  db.prepare(
    "INSERT INTO activities(id,task_id,actor_id,kind,changes_json,created_at) VALUES ('activity','task',?,'task.updated',?,'2026-09-01')",
  ).run(
    legacyUser,
    JSON.stringify({
      fields: ["assigneeActorId"],
      values: {
        assigneeActorId: {
          from: legacyUser,
          to: { id: legacyUser, name: "Original name", avatarUrl: null },
        },
      },
      description: legacyUser,
    }),
  );
  db.prepare(
    "INSERT INTO audit_events(id,actor_id,action,resource_type,outcome,safe_metadata_json) VALUES ('audit',?,'session.login','session','allowed',?)",
  ).run(legacyUser, JSON.stringify({ provider: "feishu", targetActorId: legacyUser }));
  const response = JSON.stringify({
    task: {
      id: "task",
      assigneeActorId: legacyUser,
      creatorActorId: legacyService,
      assignee: { id: legacyUser, name: "User", avatarUrl: null },
    },
    data: {
      id: legacyUser,
      author: { id: legacyUser, name: "User" },
      uploader: { id: legacyUser, name: "User" },
    },
    requestedBy: legacyUser,
    decidedBy: legacyUser,
  });
  db.prepare(
    "INSERT INTO request_idempotency(actor_id,scope,idempotency_key,request_hash,response_json,created_at) VALUES (?,'task.create','key','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',?,'2026-09-01')",
  ).run(legacyUser, response);
  db.prepare(
    "INSERT INTO task_lifecycle_operations(id,task_id,actor_id,idempotency_key,request_hash,target_status,status,phase,expected_version,result_json,created_at,updated_at) VALUES ('lifecycle','task',?,'life-key','life-hash','done','succeeded','completed',1,?,'2026-09-01','2026-09-01')",
  ).run(legacyUser, response);
  db.prepare(
    "INSERT INTO task_delete_leases(task_id,lease_token,actor_id,expected_version,snapshot_json,created_at,operation_id,phase,updated_at) VALUES ('task','lease',?,1,?,'2026-09-01','delete-op','archiving','2026-09-01')",
  ).run(
    legacyUser,
    JSON.stringify({
      resourceIds: ["task", `task-read:${legacyUser}`],
      threadIds: [],
      attachmentStorageKeys: [],
    }),
  );
}

it("retains every relational attribution, history sequence and append-only guard", () => {
  const db = legacyDatabase();
  seedHistory(db);
  const counts = db
    .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .pluck()
    .all()
    .map((name) => [
      String(name),
      db
        .prepare(`SELECT count(*) FROM "${String(name)}"`)
        .pluck()
        .get(),
    ]);
  runMigrations(db, migrations.identityMigrations([mapping]));
  for (const [name, count] of counts)
    if (name !== "schema_migrations")
      expect(
        db
          .prepare(`SELECT count(*) FROM "${name === "actors" ? "identities" : String(name)}"`)
          .pluck()
          .get(),
      ).toBe(count);
  const columns: Record<string, string[]> = {
    sessions: ["identity_key"],
    projects: ["created_by_identity_key"],
    project_members: ["identity_key"],
    tasks: ["assignee_identity_key"],
    task_relations: ["created_by_identity_key"],
    comments: ["author_identity_key"],
    attachments: ["uploader_identity_key"],
    activities: ["identity_key"],
    jobs: ["requested_by_identity_key"],
    job_interactions: ["decided_by_identity_key"],
    audit_events: ["identity_key"],
    request_idempotency: ["identity_key"],
    task_reads: ["identity_key"],
    global_labels: ["created_by_identity_key"],
    task_delete_authorizations: ["identity_key"],
    task_delete_leases: ["identity_key"],
    task_delete_events: ["identity_key"],
    task_lifecycle_operations: ["identity_key"],
    job_attachment_snapshots: ["uploader_identity_key"],
  };
  for (const [table, fields] of Object.entries(columns))
    for (const field of fields)
      expect(
        db.prepare(`SELECT ${field} FROM ${table} WHERE ${field} IS NOT NULL`).pluck().all(),
      ).toEqual([userKey]);
  expect(db.prepare("SELECT creator_identity_key FROM tasks WHERE id='task'").pluck().get()).toBe(
    '["service","local-admin"]',
  );
  expect(db.pragma("foreign_key_check")).toEqual([]);
  expect(db.prepare("SELECT id,created_at FROM activities").get()).toEqual({
    id: "activity",
    created_at: "2026-09-01",
  });
  expect(db.prepare("SELECT revision FROM change_events").pluck().get()).toBe(1);
  expect(db.prepare("SELECT seq FROM job_events").pluck().get()).toBe(1);
  for (const table of [
    "activities",
    "job_events",
    "change_events",
    "audit_events",
    "task_delete_events",
  ]) {
    expect(() => db.exec(`UPDATE ${table} SET created_at='changed'`)).toThrow(/append-only/);
    expect(() => db.exec(`DELETE FROM ${table}`)).toThrow(/append-only/);
  }
  expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='actors'").get()).toBeUndefined();
  expect(runMigrations(db, migrations.CORE_MIGRATIONS)).toEqual([]);
});

it("converts known JSON identities without touching user text, business IDs or request hashes", () => {
  const db = legacyDatabase();
  seedHistory(db);
  runMigrations(db, migrations.identityMigrations([mapping]));
  const json = (table: string, column: string) =>
    JSON.parse(db.prepare(`SELECT ${column} FROM ${table}`).pluck().get() as string);
  expect(json("activities", "changes_json")).toEqual({
    fields: ["assigneeIdentity"],
    values: {
      assigneeIdentity: {
        from: userIdentity,
        to: { identity: userIdentity, name: "Original name", avatarUrl: null },
      },
    },
    description: legacyUser,
  });
  expect(json("audit_events", "safe_metadata_json")).toEqual({
    provider: "feishu",
    targetIdentity: userIdentity,
  });
  const response = json("request_idempotency", "response_json");
  expect(response.task).toEqual({
    id: "task",
    assigneeIdentity: userIdentity,
    creatorIdentity: { kind: "service", serviceId: "local-admin" },
    assignee: { identity: userIdentity, name: "User", avatarUrl: null },
  });
  expect(response.data.id).toBe(legacyUser);
  expect(response.data.author.identity).toEqual(userIdentity);
  expect(response.data.uploader.identity).toEqual(userIdentity);
  expect(response.requestedBy).toEqual(userIdentity);
  expect(response.decidedBy).toEqual(userIdentity);
  expect(json("task_lifecycle_operations", "result_json")).toEqual(response);
  expect(json("task_delete_leases", "snapshot_json").resourceIds).toEqual([
    "task",
    `task-read:${userKey}`,
  ]);
  expect(db.prepare("SELECT body FROM comments").pluck().get()).toBe(`正文 ${legacyUser}`);
  expect(db.prepare("SELECT request_hash FROM request_idempotency").pluck().get()).toBe(
    "a".repeat(64),
  );
});

it("keeps the same user ID in different tenants distinct", () => {
  const db = legacyDatabase();
  seedUser(db);
  seedUser(db, "other", "other-tenant", "ou_other");
  runMigrations(
    db,
    migrations.identityMigrations([
      mapping,
      { legacyActorId: "other", tenantKey: "other-tenant", openId: "ou_other", userId: "u1" },
    ]),
  );
  expect(
    db.prepare("SELECT identity_key FROM identities ORDER BY identity_key").pluck().all(),
  ).toEqual(['["feishu","other-tenant","u1"]', userKey]);
});

it.each([
  "missing",
  "wrong-tenant",
  "wrong-open",
  "empty-user",
  "collision",
  "duplicate-mapping",
  "unknown-service",
])("rolls back a %s mapping without altering the old schema or evidence", (kind) => {
  const db = legacyDatabase();
  seedUser(db);
  let entries = [{ ...mapping }];
  if (kind === "missing") entries = [];
  if (kind === "wrong-tenant") entries[0]!.tenantKey = "wrong";
  if (kind === "wrong-open") entries[0]!.openId = "wrong";
  if (kind === "empty-user") entries[0]!.userId = "";
  if (kind === "collision") {
    seedUser(db, "other", "tenant", "ou_other");
    entries.push({ ...mapping, legacyActorId: "other", openId: "ou_other" });
  }
  if (kind === "duplicate-mapping") entries.push({ ...mapping });
  if (kind === "unknown-service") seedUser(db, "unknown-service", "development-tenant", "other");
  expect(() => runMigrations(db, migrations.identityMigrations(entries))).toThrow();
  expect(db.prepare("SELECT id FROM actors WHERE id=?").pluck().get(legacyUser)).toBe(legacyUser);
  expect(
    db.prepare("SELECT name FROM sqlite_schema WHERE name='identities'").get(),
  ).toBeUndefined();
  expect(db.prepare("SELECT max(version) FROM schema_migrations").pluck().get()).toBe(20);
  expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
});

it("rejects malformed or noncanonical natural keys and users masquerading as services", () => {
  const db = legacyDatabase();
  runMigrations(db, migrations.CORE_MIGRATIONS);
  const insert = db.prepare(
    "INSERT INTO identities(identity_key,kind,tenant_key,user_id,service_id,name,role) VALUES (?,?,?,?,?,'Name','member')",
  );
  expect(() =>
    insert.run('[ "feishu", "tenant", "u1" ]', "feishu", "tenant", "u1", null),
  ).toThrow();
  expect(() => insert.run('["feishu","tenant","wrong"]', "feishu", "tenant", "u1", null)).toThrow();
  expect(() => insert.run('["service","other"]', "service", null, null, "other")).toThrow();
  expect(() => insert.run('["service","codex"]', "service", "tenant", "fake", "codex")).toThrow();
  expect(() => insert.run('["feishu","tenant",""]', "feishu", "tenant", "", null)).toThrow();
  expect(() => insert.run('["service","codex"]', "service", null, null, "codex")).not.toThrow();
});

it("migrates only the explicit historical local service without a directory lookup", () => {
  const db = legacyDatabase();
  seedUser(db, legacyService, "development-tenant", "development-user");
  runMigrations(db, migrations.CORE_MIGRATIONS);
  expect(db.prepare("SELECT identity_key,kind,user_id,service_id FROM identities").get()).toEqual({
    identity_key: '["service","local-admin"]',
    kind: "service",
    user_id: null,
    service_id: "local-admin",
  });
});

it("converts relation authors but preserves opaque nested response metadata", () => {
  const db = legacyDatabase();
  seedHistory(db);
  db.prepare("UPDATE request_idempotency SET response_json = ?").run(
    JSON.stringify({
      data: {
        id: "relation",
        createdBy: { id: legacyUser, name: "Historical author" },
        metadata: { actorId: legacyUser, author: { id: legacyUser } },
      },
    }),
  );
  runMigrations(db, migrations.identityMigrations([mapping]));
  const response = JSON.parse(
    db.prepare("SELECT response_json FROM request_idempotency").pluck().get() as string,
  );
  expect(response.data.createdBy).toEqual({ identity: userIdentity, name: "Historical author" });
  expect(response.data.metadata).toEqual({ actorId: legacyUser, author: { id: legacyUser } });
});

it("rolls back all rebuilt tables and restores guards when a late historical reference cannot be resolved", () => {
  const db = legacyDatabase();
  seedHistory(db);
  db.prepare("UPDATE task_delete_leases SET snapshot_json = ?").run(
    JSON.stringify({ resourceIds: ["task-read:missing-legacy-user"] }),
  );
  expect(() => runMigrations(db, migrations.identityMigrations([mapping]))).toThrow();
  expect(db.prepare("SELECT actor_id FROM activities").pluck().get()).toBe(legacyUser);
  expect(db.prepare("SELECT count(*) FROM actors").pluck().get()).toBe(2);
  expect(
    db.prepare("SELECT name FROM sqlite_schema WHERE name='identities'").get(),
  ).toBeUndefined();
  expect(db.prepare("SELECT max(version) FROM schema_migrations").pluck().get()).toBe(20);
  expect(() => db.exec("UPDATE activities SET created_at='changed'")).toThrow(/append-only/);
  expect(db.pragma("foreign_key_check")).toEqual([]);
});

it.each([" u1", "u1 ", "\tu1", "u".repeat(256)])(
  "rejects identity parts that the public contract cannot read: %j",
  (userId) => {
    const db = legacyDatabase();
    seedUser(db);
    expect(() =>
      runMigrations(db, migrations.identityMigrations([{ ...mapping, userId }])),
    ).toThrow();
    expect(db.prepare("SELECT id FROM actors").pluck().get()).toBe(legacyUser);
  },
);

it("reorders migrated deletion resources to match recovery snapshots and preserves authorization targets", () => {
  const db = legacyDatabase();
  seedHistory(db);
  seedUser(db, "000-other", "tenant", "ou_other");
  db.prepare("UPDATE task_delete_leases SET snapshot_json = ?").run(
    JSON.stringify({
      resourceIds: ["task", "task-read:000-other", `task-read:${legacyUser}`],
      threadIds: [],
      attachmentStorageKeys: [],
    }),
  );
  db.prepare("UPDATE task_delete_authorizations SET resource_id = ?").run(
    `task-read:${legacyUser}`,
  );
  runMigrations(
    db,
    migrations.identityMigrations([
      mapping,
      { legacyActorId: "000-other", tenantKey: "tenant", openId: "ou_other", userId: "z9" },
    ]),
  );
  const snapshot = JSON.parse(
    db.prepare("SELECT snapshot_json FROM task_delete_leases").pluck().get() as string,
  );
  expect(snapshot.resourceIds).toEqual([
    "task",
    `task-read:${userKey}`,
    'task-read:["feishu","tenant","z9"]',
  ]);
  expect(db.prepare("SELECT resource_id FROM task_delete_authorizations").pluck().get()).toBe(
    `task-read:${userKey}`,
  );
});
