export const JOB_WORKSPACE_EVIDENCE_SQL = `
CREATE TABLE job_workspace_evidence (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  cwd TEXT NOT NULL,
  trusted INTEGER NOT NULL CHECK (trusted IN (0, 1)),
  before_fingerprint TEXT NOT NULL,
  after_fingerprint TEXT,
  after_head TEXT,
  updated_at TEXT NOT NULL
);
`;
