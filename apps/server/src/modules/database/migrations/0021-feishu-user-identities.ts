import type Database from "better-sqlite3";
import type { Migration } from "../migrator.js";

/** Supplied only by the trusted, same-application Feishu migration resolver. */
export interface LegacyIdentityMapping {
  readonly legacyActorId: string;
  readonly tenantKey: string;
  readonly openId: string;
  readonly userId: string;
}

type Identity =
  | { kind: "feishu"; tenantKey: string; userId: string }
  | { kind: "service"; serviceId: "local-admin" | "codex" };
type Row = Record<string, string | number | null>;
interface SchemaObject {
  type: string;
  name: string;
  tbl_name: string;
  sql: string;
}

const LOCAL_ACTOR = "00000000-0000-4000-8000-000000000001";
const COLUMNS: Readonly<Record<string, string>> = {
  actor_id: "identity_key",
  assignee_actor_id: "assignee_identity_key",
  creator_actor_id: "creator_identity_key",
  created_by: "created_by_identity_key",
  author_id: "author_identity_key",
  uploader_id: "uploader_identity_key",
  requested_by: "requested_by_identity_key",
  decided_by: "decided_by_identity_key",
};

const IDENTITY_SCHEMA = `CREATE TABLE identities (
  identity_key TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('feishu', 'service')),
  tenant_key TEXT,
  user_id TEXT,
  service_id TEXT,
  name TEXT NOT NULL,
  avatar_url TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (
    (kind = 'feishu' AND tenant_key IS NOT NULL AND length(tenant_key) BETWEEN 1 AND 255 AND trim(tenant_key) = tenant_key
      AND user_id IS NOT NULL AND length(user_id) BETWEEN 1 AND 255 AND trim(user_id) = user_id AND service_id IS NULL
      AND identity_key = json_array('feishu', tenant_key, user_id))
    OR
    (kind = 'service' AND tenant_key IS NULL AND user_id IS NULL
      AND service_id IS NOT NULL AND service_id IN ('local-admin', 'codex')
      AND identity_key = json_array('service', service_id))
  ),
  UNIQUE (tenant_key, user_id),
  UNIQUE (service_id)
) STRICT`;

function key(identity: Identity): string {
  return JSON.stringify(
    identity.kind === "feishu"
      ? ["feishu", identity.tenantKey, identity.userId]
      : ["service", identity.serviceId],
  );
}

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function identitiesFor(actors: readonly Row[], mappings: readonly LegacyIdentityMapping[]) {
  const supplied = new Map<string, LegacyIdentityMapping>();
  for (const mapping of mappings) {
    for (const value of [
      mapping.legacyActorId,
      mapping.tenantKey,
      mapping.openId,
      mapping.userId,
    ]) {
      if (typeof value !== "string" || !value.trim()) throw new Error("旧身份映射包含空身份字段");
    }
    for (const value of [mapping.tenantKey, mapping.userId]) {
      if (value.trim() !== value || value.length > 255)
        throw new Error("飞书自然身份字段不符合公共契约");
    }
    if (supplied.has(mapping.legacyActorId)) throw new Error("旧身份映射重复，拒绝合并账号");
    supplied.set(mapping.legacyActorId, mapping);
  }
  const identities = new Map<string, Identity>();
  const occupied = new Set<string>();
  for (const actor of actors) {
    const id = String(actor.id);
    const mapping = supplied.get(id);
    let identity: Identity;
    if (
      id === LOCAL_ACTOR &&
      actor.tenant_key === "development-tenant" &&
      actor.open_id === "development-user"
    ) {
      if (mapping) throw new Error("本机服务身份不能映射为飞书用户");
      identity = { kind: "service", serviceId: "local-admin" };
    } else {
      if (id === LOCAL_ACTOR || actor.tenant_key === "development-tenant") {
        throw new Error("发现无法确认来源的旧服务身份，拒绝猜测 user_id");
      }
      if (!mapping) throw new Error(`旧用户 ${id} 缺少已验证的飞书 user_id 映射`);
      if (mapping.tenantKey !== actor.tenant_key || mapping.openId !== actor.open_id) {
        throw new Error("飞书映射的企业或 open_id 与旧账号不一致");
      }
      identity = { kind: "feishu", tenantKey: mapping.tenantKey, userId: mapping.userId };
      supplied.delete(id);
    }
    if (occupied.has(key(identity)))
      throw new Error("多个旧账号对应同一自然身份，拒绝自动合并权限");
    occupied.add(key(identity));
    identities.set(id, identity);
  }
  if (supplied.size) throw new Error("身份映射包含旧数据库不存在的用户");
  return identities;
}

function reference(value: unknown, identities: ReadonlyMap<string, Identity>): Identity | null {
  if (value === null) return null;
  if (typeof value !== "string" || !identities.has(value)) {
    throw new Error("历史记录包含无法解析的旧用户引用");
  }
  return identities.get(value) as Identity;
}

function deletionResource(value: string, identities: ReadonlyMap<string, Identity>): string {
  if (!value.startsWith("task-read:")) return value;
  const identity = reference(value.slice("task-read:".length), identities);
  if (!identity) throw new Error("删除租约中的用户引用为空");
  return `task-read:${key(identity)}`;
}

const PUBLIC_FIELDS: Readonly<Record<string, string>> = {
  actorId: "identity",
  assigneeActorId: "assigneeIdentity",
  creatorActorId: "creatorIdentity",
  currentActorId: "currentIdentity",
  targetActorId: "targetIdentity",
};
const SUMMARIES = new Set(["actor", "assignee", "author", "uploader", "createdBy"]);
const RESPONSE_CONTAINERS = new Set([
  "task",
  "tasks",
  "data",
  "session",
  "comments",
  "attachments",
  "relations",
  "activities",
  "assignees",
  "members",
  "jobs",
  "interactions",
  "actors",
  "latest",
]);

/** Called only on our persisted API responses, never arbitrary prompts or user JSON. */
function responseIdentities(
  value: unknown,
  identities: ReadonlyMap<string, Identity>,
  summary = false,
): unknown {
  if (Array.isArray(value)) return value.map((item) => responseIdentities(item, identities));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([field, entry]) => {
      if (PUBLIC_FIELDS[field]) return [PUBLIC_FIELDS[field], reference(entry, identities)];
      if ((summary && field === "id") || field === "requestedBy" || field === "decidedBy") {
        return [field === "id" ? "identity" : field, reference(entry, identities)];
      }
      return [
        field,
        SUMMARIES.has(field) || RESPONSE_CONTAINERS.has(field)
          ? responseIdentities(entry, identities, SUMMARIES.has(field))
          : entry,
      ];
    }),
  );
}

function migrateJson(
  table: string,
  column: string,
  value: string,
  identities: ReadonlyMap<string, Identity>,
): string {
  if (
    (table === "request_idempotency" && column === "response_json") ||
    (table === "task_lifecycle_operations" && column === "result_json")
  ) {
    return JSON.stringify(responseIdentities(JSON.parse(value), identities));
  }
  if (table === "audit_events" && column === "safe_metadata_json") {
    const metadata = JSON.parse(value) as Record<string, unknown>;
    for (const [field, replacement] of Object.entries(PUBLIC_FIELDS)) {
      if (Object.hasOwn(metadata, field)) {
        metadata[replacement] = reference(metadata[field], identities);
        delete metadata[field];
      }
    }
    return JSON.stringify(metadata);
  }
  if (table === "activities" && column === "changes_json") {
    const changes = JSON.parse(value) as Record<string, unknown>;
    if (Array.isArray(changes.fields))
      changes.fields = changes.fields.map((field) =>
        typeof field === "string" ? (PUBLIC_FIELDS[field] ?? field) : field,
      );
    if (changes.values && typeof changes.values === "object" && !Array.isArray(changes.values)) {
      const values = changes.values as Record<string, unknown>;
      for (const [field, replacement] of Object.entries(PUBLIC_FIELDS)) {
        if (!Object.hasOwn(values, field)) continue;
        const delta = values[field] as Record<string, unknown>;
        values[replacement] = Object.fromEntries(
          Object.entries(delta).map(([direction, entry]) => [
            direction,
            typeof entry === "object" && entry !== null
              ? responseIdentities(entry, identities, true)
              : reference(entry, identities),
          ]),
        );
        delete values[field];
      }
    }
    return JSON.stringify(changes);
  }
  if (table === "task_delete_leases" && column === "snapshot_json") {
    const snapshot = JSON.parse(value) as Record<string, unknown>;
    if (Array.isArray(snapshot.resourceIds))
      snapshot.resourceIds = snapshot.resourceIds
        .map((resource) => {
          if (typeof resource !== "string") throw new Error("删除租约包含非字符串资源标识符");
          return deletionResource(resource, identities);
        })
        .sort();
    return JSON.stringify(snapshot);
  }
  return value;
}

function rewriteSql(sql: string): string {
  return sql
    .replace(/\bREFERENCES\s+actors\s*\(\s*id\s*\)/gi, "REFERENCES identities(identity_key)")
    .replace(
      /\b(actor_id|assignee_actor_id|creator_actor_id|created_by|author_id|uploader_id|requested_by|decided_by)\b/g,
      (column) => COLUMNS[column] as string,
    );
}

function transform(database: Database.Database, mappings: readonly LegacyIdentityMapping[]) {
  const actors = database.prepare("SELECT * FROM actors ORDER BY id").all() as Row[];
  const identities = identitiesFor(actors, mappings);
  const historyQueries = [
    "SELECT id, task_id, kind, created_at FROM activities ORDER BY created_at, id",
    "SELECT id, job_id, seq, kind, summary, created_at FROM job_events ORDER BY job_id, seq",
    "SELECT revision, aggregate_type, aggregate_id, event_type, created_at FROM change_events ORDER BY revision",
    "SELECT id, action, resource_type, resource_id, outcome, request_id, created_at FROM audit_events ORDER BY created_at, id",
    "SELECT id, operation_id, task_id, event_type, created_at FROM task_delete_events ORDER BY created_at, id",
  ];
  const historyBefore = historyQueries.map((sql) => JSON.stringify(database.prepare(sql).all()));
  const schema = database
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY rowid",
    )
    .all() as SchemaObject[];
  const tables = schema.filter(
    (object) =>
      object.type === "table" && object.name !== "actors" && rewriteSql(object.sql) !== object.sql,
  );
  const snapshots = tables.map((table) => ({
    table,
    rows: database.prepare(`SELECT * FROM ${quote(table.name)}`).all() as Row[],
    columns: (database.pragma(`table_info(${quote(table.name)})`) as { name: string }[]).map(
      (column) => column.name,
    ),
  }));
  // No application writes can run inside this synchronous migration transaction.
  // Drop/rebuild guards only here so the original append-only history remains rollback-safe.
  const triggers = schema.filter((object) => object.type === "trigger");
  for (const trigger of triggers) database.exec(`DROP TRIGGER ${quote(trigger.name)}`);
  database.exec(IDENTITY_SCHEMA);
  const insertIdentity = database.prepare(`INSERT INTO identities (
    identity_key,kind,tenant_key,user_id,service_id,name,avatar_url,role,active,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  for (const actor of actors) {
    const identity = identities.get(String(actor.id)) as Identity;
    insertIdentity.run(
      key(identity),
      identity.kind,
      identity.kind === "feishu" ? identity.tenantKey : null,
      identity.kind === "feishu" ? identity.userId : null,
      identity.kind === "service" ? identity.serviceId : null,
      actor.name,
      actor.avatar_url,
      actor.role,
      actor.active,
      actor.created_at,
      actor.updated_at,
    );
  }
  for (const { table, rows, columns } of snapshots) {
    const temporary = `identity_v21_${table.name}`;
    const sql = rewriteSql(table.sql).replace(
      /^CREATE TABLE\s+(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|\w+)/i,
      `CREATE TABLE ${quote(temporary)}`,
    );
    database.exec(sql);
    const insert = database.prepare(
      `INSERT INTO ${quote(temporary)} (${columns.map((column) => quote(COLUMNS[column] ?? column)).join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
    );
    for (const row of rows) {
      insert.run(
        ...columns.map((column) => {
          const value = row[column];
          if (COLUMNS[column]) {
            const identity = reference(value, identities);
            return identity ? key(identity) : null;
          }
          if (
            table.name === "task_delete_authorizations" &&
            column === "resource_id" &&
            typeof value === "string"
          ) {
            return deletionResource(value, identities);
          }
          return typeof value === "string" && column.endsWith("_json")
            ? migrateJson(table.name, column, value, identities)
            : value;
        }),
      );
    }
    database.exec(`DROP TABLE ${quote(table.name)}`);
    database.exec(`ALTER TABLE ${quote(temporary)} RENAME TO ${quote(table.name)}`);
    const count = database
      .prepare(`SELECT count(*) FROM ${quote(table.name)}`)
      .pluck()
      .get();
    if (count !== rows.length) throw new Error(`迁移后的 ${table.name} 行数不匹配`);
  }
  database.exec("DROP TABLE actors");
  const affected = new Set(tables.map((table) => table.name));
  for (const index of schema.filter(
    (object) => object.type === "index" && affected.has(object.tbl_name),
  )) {
    database.exec(rewriteSql(index.sql));
  }
  for (const trigger of triggers) database.exec(rewriteSql(trigger.sql));
  if (database.prepare("SELECT count(*) FROM identities").pluck().get() !== actors.length)
    throw new Error("迁移后的身份行数不匹配");
  if ((database.pragma("foreign_key_check") as unknown[]).length)
    throw new Error("迁移产生无效身份或业务外键");
  historyQueries.forEach((sql, index) => {
    if (JSON.stringify(database.prepare(sql).all()) !== historyBefore[index]) {
      throw new Error("迁移改变了历史事件的标识、顺序或时间");
    }
  });
}

export function feishuUserIdentitiesMigration(
  mappings: readonly LegacyIdentityMapping[],
): Migration {
  // Copy the trusted preflight result; later caller mutation cannot change a pending migration.
  const snapshot = mappings.map((mapping) => ({ ...mapping }));
  return {
    version: 21,
    name: "feishu_user_identities",
    sql: "SELECT 1; -- Identity schema and historical references are rebuilt in the checked transform.",
    transformChecksum: "feishu-user-identities-v1",
    foreignKeysDisabled: true,
    transform: (database) => transform(database, snapshot),
  };
}
