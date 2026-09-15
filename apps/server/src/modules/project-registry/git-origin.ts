import { createHash, randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import {
  GitCreationOriginSchema,
  GitOriginLookupResultSchema,
  type GitCreationOrigin,
  type GitOriginLookup,
} from "@codexboard/contracts";
import type { SqliteDatabase } from "../database/index.js";

export type GitOriginReader = (
  query: GitOriginLookup,
) => Promise<Record<string, GitCreationOrigin>>;
type Resource = GitOriginLookup["resources"][number];
type Git = (cwd: string, ...args: string[]) => Promise<string>;

/** Reflog creation + file birth identify an incarnation, even after same-name recreation. */
export async function originResource(
  git: Git,
  cwd: string,
  kind: Resource["kind"],
  branch: string | null,
  path: string | null,
): Promise<Resource | null> {
  try {
    const ref = kind === "branch" ? `refs/heads/${branch}` : "HEAD";
    const directory = kind === "worktree" ? path! : cwd;
    const logPath = resolve(
      directory,
      (await git(directory, "rev-parse", "--git-path", `logs/${ref}`)).trim(),
    );
    const birth = lstatSync(logPath).birthtimeMs;
    const first = (
      await git(directory, "reflog", "show", "--format=%H%x00%gD%x00%gs", "--date=raw", ref)
    )
      .trimEnd()
      .split("\n")
      .at(-1)!;
    const seconds = first.match(/@\{(\d+) [+-]\d+\}/)?.[1];
    if (!seconds || (kind === "branch" && !first.includes("branch: Created from"))) return null;
    const key = createHash("sha256")
      .update(JSON.stringify([kind, kind === "branch" ? branch : null, path, first, birth]))
      .digest("hex");
    return { key, kind, branch, path, createdAt: new Date(Number(seconds) * 1000).toISOString() };
  } catch {
    return null;
  }
}

export class GitOrigins {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly reader?: GitOriginReader,
  ) {}
  record(projectId: string, resource: Resource, origin: GitCreationOrigin) {
    if (origin.kind === "unknown") return;
    this.db
      .prepare(
        "INSERT INTO audit_events (id, action, resource_type, resource_id, outcome, safe_metadata_json) VALUES (?, 'git.origin', 'project', ?, 'allowed', ?)",
      )
      .run(
        randomUUID(),
        projectId,
        JSON.stringify({ key: resource.key, origin: { ...origin, createdAt: resource.createdAt } }),
      );
  }
  async read(projectId: string, mainPath: string, resources: Resource[]) {
    const result: Record<string, GitCreationOrigin> = {};
    const wanted = new Set(resources.map((r) => r.key));
    const records = this.db
      .prepare(
        "SELECT safe_metadata_json FROM audit_events WHERE resource_type = 'project' AND resource_id = ? AND action = 'git.origin' ORDER BY created_at, rowid",
      )
      .all(projectId) as { safe_metadata_json: string }[];
    for (const row of records) {
      try {
        const value = JSON.parse(row.safe_metadata_json);
        if (wanted.has(value.key)) result[value.key] = GitCreationOriginSchema.parse(value.origin);
      } catch {
        /* Legacy or invalid metadata is not evidence of a creator. */
      }
    }
    const refresh = resources.filter((r) => !result[r.key] || result[r.key]?.kind === "codex");
    if (this.reader && refresh.length) {
      const queries = refresh.map((resource) => {
        const known = result[resource.key];
        if (known?.kind !== "codex") return resource;
        // Creation identity is durable; display names belong to Desktop and are read live.
        const identity = { ...known };
        delete identity.threadTitle;
        result[resource.key] = identity;
        return { ...resource, threadId: known.threadId };
      });
      try {
        const discovered = GitOriginLookupResultSchema.parse(
          await this.reader({ mainPath, resources: queries }),
        );
        for (const resource of refresh) {
          const origin = discovered[resource.key];
          if (origin && origin.kind !== "unknown") {
            if (!result[resource.key]) this.record(projectId, resource, origin);
            result[resource.key] = origin;
          }
        }
      } catch {
        /* Offline bridge never blocks Git management or invents Terminal provenance. */
      }
    }
    return result;
  }
}
