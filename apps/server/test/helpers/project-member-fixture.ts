import {
  identityKey,
  type ActorRole,
  type FeishuIdentityRef,
  type ProjectMemberRole,
} from "@codexboard/contracts";
import type { SqliteDatabase } from "../../src/modules/database/index.js";

interface ProjectMemberFixture {
  readonly tenantKey: string;
  readonly userId: string;
  readonly name: string;
  readonly avatarUrl: string | null;
  readonly actorRole: ActorRole;
  readonly projectRole: ProjectMemberRole;
}

/** Test-only legacy rows; this deliberately does not create Feishu login evidence. */
export function seedProjectMember(
  database: SqliteDatabase,
  projectId: string,
  command: ProjectMemberFixture,
) {
  const identity: FeishuIdentityRef = {
    kind: "feishu",
    tenantKey: command.tenantKey,
    userId: command.userId,
  };
  const key = identityKey(identity);
  database
    .prepare(
      `INSERT INTO identities (
      identity_key, kind, tenant_key, user_id, service_id, name, avatar_url, role, active
    ) VALUES (?, 'feishu', ?, ?, NULL, ?, ?, ?, 1)
    ON CONFLICT (identity_key) DO UPDATE SET
      name = excluded.name, avatar_url = excluded.avatar_url,
      role = excluded.role, active = 1`,
    )
    .run(
      key,
      command.tenantKey,
      command.userId,
      command.name,
      command.avatarUrl,
      command.actorRole,
    );
  database
    .prepare(
      `INSERT INTO project_members (project_id, identity_key, role) VALUES (?, ?, ?)
    ON CONFLICT (project_id, identity_key) DO UPDATE SET role = excluded.role`,
    )
    .run(projectId, key, command.projectRole);
  return {
    identity,
    name: command.name,
    actorRole: command.actorRole,
    projectRole: command.projectRole,
  };
}
