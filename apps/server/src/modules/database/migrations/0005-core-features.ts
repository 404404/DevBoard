export const CORE_FEATURES_SQL = `
CREATE UNIQUE INDEX task_relations_single_parent_idx
  ON task_relations(target_task_id)
  WHERE type = 'parent';

CREATE TABLE task_reads (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  last_read_version INTEGER NOT NULL CHECK (last_read_version > 0),
  read_at TEXT NOT NULL,
  PRIMARY KEY (task_id, actor_id)
) STRICT;

CREATE INDEX task_reads_actor_id_idx ON task_reads(actor_id, read_at);
`;
