export const TASK_CREATE_OPTIONS_SQL = `
ALTER TABLE tasks ADD COLUMN links_json TEXT NOT NULL DEFAULT '[]' CHECK (
  json_valid(links_json) AND json_type(links_json) = 'array'
);

CREATE UNIQUE INDEX task_relations_single_child_idx
  ON task_relations(source_task_id)
  WHERE type = 'parent';
`;
