import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { SqliteDatabase } from "../database/index.js";

const execute = promisify(execFile);
export interface WorkspaceFingerprint {
  readonly cwd: string;
  readonly fingerprint: string;
  readonly head: string;
  readonly dirty: boolean;
}

/** Persist hashes only, never repository contents or credentials. */
export async function fingerprintWorkspace(
  directory: string,
  taskId?: string,
): Promise<WorkspaceFingerprint | null> {
  try {
    return await inspectFingerprint(directory, taskId);
  } catch {
    return null;
  }
}

async function inspectFingerprint(
  directory: string,
  taskId?: string,
): Promise<WorkspaceFingerprint | null> {
  let cwd: string;
  try {
    cwd = await realpath((await git(directory, "rev-parse", "--show-toplevel")).trim());
  } catch {
    return null;
  }
  const head = (await git(cwd, "rev-parse", "--verify", "HEAD")).trim();
  const hash = createHash("sha256");
  hash
    .update(head)
    .update("\0")
    .update(await git(cwd, "diff", "--binary", "--no-ext-diff", "HEAD", "--"));
  const paths = (await git(cwd, "ls-files", "--others", "--exclude-standard", "-z"))
    .split("\0")
    .filter((path) => path && !(taskId && path.startsWith(`.tmp/taskboard/${taskId}/`)))
    .sort();
  for (const path of paths) {
    const absolute = join(cwd, path);
    const stat = await lstat(absolute);
    hash.update("\0").update(path).update("\0");
    if (stat.isSymbolicLink()) hash.update("symlink:").update(await readlink(absolute));
    else if (stat.isFile())
      hash.update(`file:${stat.mode & 0o777}:`).update(await readFile(absolute));
    else hash.update("unsupported-file-type");
  }
  return {
    cwd,
    head,
    fingerprint: hash.digest("hex"),
    dirty: Boolean((await git(cwd, "status", "--porcelain", "--untracked-files=all")).trim()),
  };
}

export async function recordJobWorkspaceStart(
  database: SqliteDatabase,
  jobId: string,
  cwd: string,
): Promise<void> {
  if (database.prepare("SELECT 1 FROM job_workspace_evidence WHERE job_id = ?").get(jobId)) return;
  const task = database.prepare("SELECT task_id AS taskId FROM jobs WHERE id = ?").get(jobId) as {
    taskId: string;
  };
  const current = await fingerprintWorkspace(cwd, task.taskId);
  if (!current || !database.open) return;
  const previous = database
    .prepare(
      `SELECT evidence.trusted, evidence.after_fingerprint AS fingerprint, evidence.after_head AS head FROM job_workspace_evidence evidence JOIN jobs ON jobs.id = evidence.job_id WHERE jobs.task_id = (SELECT task_id FROM jobs WHERE id = ?) AND evidence.cwd = ? AND jobs.id <> ? AND evidence.after_fingerprint IS NOT NULL ORDER BY jobs.queued_at DESC, jobs.rowid DESC LIMIT 1`,
    )
    .get(jobId, current.cwd, jobId) as
    { trusted: number; fingerprint: string; head: string } | undefined;
  const trusted =
    !current.dirty ||
    Boolean(
      previous?.trusted &&
      previous.fingerprint === current.fingerprint &&
      previous.head === current.head,
    );
  database
    .prepare(
      "INSERT OR IGNORE INTO job_workspace_evidence (job_id, cwd, trusted, before_fingerprint, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(jobId, current.cwd, trusted ? 1 : 0, current.fingerprint, new Date().toISOString());
}

export async function recordJobWorkspaceStop(
  database: SqliteDatabase,
  jobId: string,
): Promise<void> {
  const evidence = database
    .prepare(
      "SELECT cwd, after_fingerprint AS afterFingerprint FROM job_workspace_evidence WHERE job_id = ?",
    )
    .get(jobId) as { cwd: string; afterFingerprint: string | null } | undefined;
  if (!evidence || evidence.afterFingerprint) return;
  const task = database.prepare("SELECT task_id AS taskId FROM jobs WHERE id = ?").get(jobId) as {
    taskId: string;
  };
  const current = await fingerprintWorkspace(evidence.cwd, task.taskId);
  if (!current || !database.open) return;
  database
    .prepare(
      "UPDATE job_workspace_evidence SET after_fingerprint = ?, after_head = ?, updated_at = ? WHERE job_id = ? AND after_fingerprint IS NULL",
    )
    .run(current.fingerprint, current.head, new Date().toISOString(), jobId);
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (
    await execute("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 32 * 1024 * 1024,
    })
  ).stdout;
}
