export const JOB_ATTACHMENT_SNAPSHOTS_SQL = `
CREATE TABLE job_attachment_snapshots (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  original_attachment_id TEXT NOT NULL,
  comment_id TEXT,
  uploader_id TEXT REFERENCES actors(id) ON DELETE SET NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  sha256 TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX job_attachment_snapshots_task_idx ON job_attachment_snapshots(task_id);
CREATE INDEX job_attachment_snapshots_storage_idx ON job_attachment_snapshots(storage_key);
`;
