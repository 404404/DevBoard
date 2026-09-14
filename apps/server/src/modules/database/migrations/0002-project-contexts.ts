export const PROJECT_CONTEXTS_SQL = `
CREATE TABLE project_development_contexts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  context_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('branch', 'worktree')),
  label TEXT NOT NULL,
  branch TEXT,
  git_ref TEXT,
  head_sha TEXT CHECK (
    head_sha IS NULL OR (
      length(head_sha) BETWEEN 40 AND 64
      AND head_sha NOT GLOB '*[^0-9a-f]*'
    )
  ),
  worktree_realpath TEXT,
  executable INTEGER NOT NULL DEFAULT 0 CHECK (executable IN (0, 1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  scanned_at TEXT NOT NULL,
  UNIQUE (project_id, context_key),
  CHECK (kind <> 'worktree' OR worktree_realpath IS NOT NULL)
) STRICT;

CREATE INDEX project_development_contexts_project_active_idx
  ON project_development_contexts(project_id, active, kind, label);
`;
